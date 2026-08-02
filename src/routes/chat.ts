/*
 * chat.ts — OpenAI-compatible chat completions
 * Multi-session: main agent + isolated subagent sessions.
 * 
 * Headers:
 *   X-Session-Id: <id>     → use specific session (default: "main")
 *   X-New-Session: true    → create fresh session for this request
 */

import { Context } from 'hono';
import { stream as honoStream } from 'hono/streaming';
import { v4 as uuidv4 } from 'uuid';
import { createQwenStream, updateSessionParent, RetryableQwenStreamError, QwenUpstreamError } from '../services/qwen.ts';
import { getActiveChatId, setActiveChatId, invalidateSessionChat, listSessions, deleteSession, Mutex } from '../services/playwright.ts';
import { StreamingToolParser } from '../tools/parser.ts';
import { parseOpenAIRequest, RequestValidationError } from '../utils/openai-request.ts';
import { parseSSEStream } from '../utils/sse.ts';
import { validateParams } from '../tools/schema.ts';
import type { FunctionToolDefinition, OpenAIRequest } from '../types/openai.ts';
import type { JsonSchema } from '../tools/types.ts';

// Per-session mutexes to prevent concurrent generations on same session
const sessionMutexes = new Map<string, Mutex>();

function getSessionMutex(sid: string): Mutex {
  if (!sessionMutexes.has(sid)) sessionMutexes.set(sid, new Mutex());
  return sessionMutexes.get(sid)!;
}

async function acquireSessionMutex(sessionId: string, signal?: AbortSignal): Promise<{ mutex: Mutex; release: () => void }> {
  const mutex = getSessionMutex(sessionId);
  try {
    return { mutex, release: await mutex.acquire(signal) };
  } catch (error: unknown) {
    if (sessionId !== 'main' && mutex.isIdle) sessionMutexes.delete(sessionId);
    throw error;
  }
}

async function withSessionLock<T>(sessionId: string, work: () => Promise<T> | T, signal?: AbortSignal): Promise<T> {
  const { mutex, release } = await acquireSessionMutex(sessionId, signal);
  try {
    return await work();
  } finally {
    release();
    if (sessionId !== 'main' && mutex.isIdle) sessionMutexes.delete(sessionId);
  }
}

const TOOL_PROMPT_PRIORITY = [
  'read_file', 'write_file', 'patch', 'search_files', 'terminal', 'execute_code',
  'process', 'delegate_task', 'todo', 'skill_view', 'skill_manage', 'memory',
  'browser_navigate', 'browser_snapshot', 'browser_click',
];

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const MAX_REQUEST_BODY_BYTES = 8_000_000;
const REQUEST_BODY_IDLE_TIMEOUT_MS = 30000;

class RequestBodyTooLargeError extends Error {
  readonly status = 413;

  constructor() {
    super(`Request body exceeds the ${MAX_REQUEST_BODY_BYTES}-byte limit`);
    this.name = 'RequestBodyTooLargeError';
  }
}

class RequestBodyTimeoutError extends Error {
  readonly status = 408;

  constructor() {
    super('Request body read timed out');
    this.name = 'RequestBodyTimeoutError';
  }
}

export interface PreparedQwenTools {
  selected: FunctionToolDefinition[];
  omittedNames: string[];
  formatted: Array<{ name: string; description: string; parameters: unknown; strict?: boolean }>;
}

export function prepareToolsForQwen(tools: FunctionToolDefinition[], maxTools = 64, preferredName?: string): PreparedQwenTools {
  const limit = Math.max(0, Math.floor(maxTools));
  const preferred = preferredName ? tools.filter(tool => tool.function.name === preferredName) : [];
  const priority = tools.filter(tool => TOOL_PROMPT_PRIORITY.includes(tool.function.name) && tool.function.name !== preferredName);
  const rest = tools.filter(tool => !TOOL_PROMPT_PRIORITY.includes(tool.function.name) && tool.function.name !== preferredName);
  const selected = [...preferred, ...priority, ...rest].slice(0, limit);
  const selectedNames = new Set(selected.map(tool => tool.function.name));
  const omittedNames = tools.map(tool => tool.function.name).filter(name => !selectedNames.has(name));
  const formatted = selected.map(tool => ({
    name: tool.function.name,
    description: tool.function.description || '',
    parameters: tool.function.parameters || { type: 'object', properties: {} },
    ...(tool.function.strict === undefined ? {} : { strict: tool.function.strict }),
  }));
  return { selected, omittedNames, formatted };
}

function getQwenToolLimit(): number {
  const configured = Number.parseInt(process.env.QWEN_MAX_TOOLS || '64', 10);
  return Number.isFinite(configured) && configured >= 0 ? configured : 64;
}

export function resolveSessionRequest(sessionHeader?: string, newSessionHeader = false): { sessionId: string; newSession: boolean } {
  const requestedSessionId = sessionHeader?.trim();
  const sessionId = requestedSessionId
    ? validateSessionId(requestedSessionId)
    : (newSessionHeader ? `subagent-${uuidv4().substring(0, 8)}` : 'main');
  return { sessionId, newSession: newSessionHeader };
}

export function validateSessionId(sessionId: string, param = 'session_id'): string {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new RequestValidationError('session_id must be 1-128 characters using letters, numbers, ., _, :, /, or -', param);
  }
  return sessionId;
}

function getEndpointSessionId(c: Context, raw: string | undefined, fallback?: string): string | Response {
  try {
    if (!raw && fallback !== undefined) return fallback;
    if (!raw) throw new RequestValidationError('session_id is required', 'session_id');
    return validateSessionId(raw.trim());
  } catch (error: unknown) {
    if (error instanceof RequestValidationError) return errorResponse(c, error.status, error.message, error.code, error.param);
    throw error;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

export function getIncrementalDelta(oldStr: string, newStr: string): { delta: string; matchedContent: string } {
  if (!oldStr) return { delta: newStr, matchedContent: newStr };
  if (newStr === oldStr) return { delta: '', matchedContent: oldStr };
  const scan = Math.min(2000, oldStr.length);
  let common = 0;
  const max = Math.min(scan, newStr.length);
  while (common < max && oldStr[common] === newStr[common]) common++;
  if (common >= Math.min(scan, 4)) return { delta: newStr.substring(common), matchedContent: newStr };
  return { delta: newStr, matchedContent: oldStr + newStr };
}

function parseQwenErrorPayload(raw: string): { message: string; status: number } | null {
  const text = raw.trim();
  if (!text || text.startsWith('data: ')) return null;
  try {
    const p = JSON.parse(text);
    if (p?.success === false) {
      const code = p.data?.code || 'UpstreamError';
      return { message: `Qwen upstream error: ${code}: ${p.data?.details || p.message}`, status: code === 'RateLimited' ? 429 : 502 };
    }
  } catch {}
  return null;
}

type StructuredToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

type RouteToolCall = { call: StructuredToolCall; source: 'content' | 'structured' };

function isAllowedRequestTool(name: string, tools: FunctionToolDefinition[], toolChoice?: OpenAIRequest['tool_choice']): boolean {
  if (toolChoice === 'none') return false;
  if (typeof toolChoice === 'object' && toolChoice.function?.name !== name) return false;
  return Boolean(name) && tools.some(tool => tool.function.name === name);
}


function sanitizeRouteToolCall(
  call: StructuredToolCall,
  tools: FunctionToolDefinition[],
  toolChoice?: OpenAIRequest['tool_choice'],
): StructuredToolCall | null {
  if (!isAllowedRequestTool(call.function.name, tools, toolChoice)) return null;
  const definition = tools.find(tool => tool.function.name === call.function.name);
  if (!definition) return null;
  let parsed: unknown;
  try {
    parsed = typeof call.function.arguments === 'string'
      ? JSON.parse(call.function.arguments)
      : call.function.arguments;
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (definition.function.parameters) {
    try {
      const validation = validateParams(parsed, definition.function.parameters as JsonSchema);
      if (!validation.valid) return null;
      parsed = validation.value;
    } catch {
      return null;
    }
  }
  return { ...call, function: { ...call.function, arguments: JSON.stringify(parsed) } };
}

function pushSanitizedRouteToolCall(
  target: RouteToolCall[],
  source: RouteToolCall['source'],
  call: StructuredToolCall,
  tools: FunctionToolDefinition[],
  toolChoice?: OpenAIRequest['tool_choice'],
): void {
  const sanitized = sanitizeRouteToolCall(call, tools, toolChoice);
  if (sanitized) target.push({ source, call: sanitized });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}

function removeCompleteToolMarkup(content: string): string {
  return content.replace(/<tool_call\b[^>]*>[\s\S]*?(?:<\/tool_call>|$)/gi, '');
}

function routeToolCallKey(call: StructuredToolCall): string {
  let parsedArguments: unknown = call.function.arguments;
  try { parsedArguments = JSON.parse(call.function.arguments); } catch {}
  return `${call.function.name}:${stableSerialize(parsedArguments)}`;
}

function dedupeRouteToolCallEntries(calls: RouteToolCall[]): RouteToolCall[] {
  const result: RouteToolCall[] = [];
  const firstByKey = new Map<string, { index: number; source: RouteToolCall['source'] }>();
  for (const item of calls) {
    const key = routeToolCallKey(item.call);
    const previous = firstByKey.get(key);
    if (previous && previous.source !== item.source) {
      if (item.source === 'structured' && previous.source === 'content') result[previous.index] = item;
      continue;
    }
    if (!previous) firstByKey.set(key, { index: result.length, source: item.source });
    result.push(item);
  }
  return result;
}

function dedupeRouteToolCalls(calls: RouteToolCall[]): StructuredToolCall[] {
  return dedupeRouteToolCallEntries(calls).map(item => item.call);
}

function requiresToolCall(toolChoice?: OpenAIRequest['tool_choice']): boolean {
  return toolChoice === 'required' || typeof toolChoice === 'object';
}

function validateResponseFormat(content: string, responseFormat?: OpenAIRequest['response_format']): string | null {
  if (!responseFormat || responseFormat.type === 'text') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return 'Qwen returned content that is not valid JSON for the requested response_format';
  }
  if (responseFormat.type === 'json_object') {
    if (!isRecord(parsed)) return 'Qwen returned JSON that is not an object for response_format=json_object';
    return null;
  }
  const envelope = responseFormat.json_schema;
  const schema = isRecord(envelope) && isRecord(envelope.schema) ? envelope.schema : envelope;
  if (!isRecord(schema)) return 'response_format.json_schema.schema is missing';
  try {
    const validation = validateParams(parsed, schema as JsonSchema);
    return validation.valid ? null : `Qwen returned content that does not match the requested JSON Schema: ${validation.errors?.join('; ')}`;
  } catch {
    return 'The requested JSON Schema could not be applied to the Qwen response';
  }
}

function mergeStructuredToolCall(
  calls: Map<number, StructuredToolCall>,
  delta: any,
  fallbackIndex: number,
): { sourceIndex: number; call: StructuredToolCall } {
  const sourceIndex = Number.isInteger(delta?.index) ? delta.index : fallbackIndex;
  const current = calls.get(sourceIndex) || {
    id: delta?.id || `call-${sourceIndex}`,
    type: 'function' as const,
    function: { name: '', arguments: '' },
  };
  if (delta?.id) current.id = delta.id;
  if (delta?.function?.name !== undefined) current.function.name += delta.function.name;
  if (delta?.function?.arguments !== undefined) current.function.arguments += delta.function.arguments;
  calls.set(sourceIndex, current);
  return { sourceIndex, call: current };
}

function responseIdMatches(chunk: any, targetResponseId: string | null): boolean {
  return targetResponseId === null || chunk.response_id === undefined || chunk.response_id === targetResponseId;
}

function errorResponse(c: Context, status: number, message: string, code: string, param?: string) {
  return c.json({
    error: {
      message,
      type: code === 'invalid_request_error' ? 'invalid_request_error' : 'server_error',
      code,
      ...(param ? { param } : {}),
    },
  }, status as any);
}

function waitWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason || new DOMException('The operation was aborted.', 'AbortError'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(signal?.reason || new DOMException('The operation was aborted.', 'AbortError'));
    };
    function done() {
      signal?.removeEventListener('abort', abort);
      resolve();
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

async function readRequestBody(c: Context): Promise<string> {
  const declaredLength = Number(c.req.header('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BODY_BYTES) {
    try { await c.req.raw.body?.cancel(); } catch {}
    throw new RequestBodyTooLargeError();
  }

  const body = c.req.raw.body;
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const signal = c.req.raw.signal;
  const cancelReader = (reason?: unknown) => { void reader.cancel(reason).catch(() => undefined); };
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      cancelReader(signal.reason);
      reject(signal.reason || new DOMException('The operation was aborted.', 'AbortError'));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    while (true) {
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const idleTimeout = new Promise<never>((_, reject) => {
        idleTimer = setTimeout(() => {
          cancelReader();
          reject(new RequestBodyTimeoutError());
        }, REQUEST_BODY_IDLE_TIMEOUT_MS);
      });
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await Promise.race([reader.read(), aborted, idleTimeout]);
      } finally {
        if (idleTimer) clearTimeout(idleTimer);
      }
      const { done, value } = result;
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REQUEST_BODY_BYTES) {
        cancelReader();
        throw new RequestBodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
    try { reader.releaseLock(); } catch {}
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

// ─── Main handler ────────────────────────────────────────────────────

export interface ChatOverrides {
  sessionId?: string;
  newSession?: boolean;
}

export async function chatCompletions(c: Context, overrides: ChatOverrides = {}) {
  let releaseSessionLock: (() => void) | null = null;
  let streamOwnsLock = false;
  try {
    let body: OpenAIRequest;
    try {
      body = parseOpenAIRequest(JSON.parse(await readRequestBody(c)));
    } catch (error: unknown) {
      if (error instanceof RequestBodyTooLargeError) {
        return errorResponse(c, error.status, error.message, 'invalid_request_error');
      }
      if (error instanceof RequestBodyTimeoutError) {
        return errorResponse(c, error.status, error.message, 'invalid_request_error');
      }
      if (error instanceof RequestValidationError) {
        return errorResponse(c, error.status, error.message, error.code, error.param);
      }
      return errorResponse(c, 400, 'Request body must be valid JSON', 'invalid_request_error');
    }
    const isStream = body.stream ?? false;
    console.log('[Chat] Tools in request:', (body as any).tools?.length || 0, '| Model:', body.model, '| Messages:', body.messages?.length);

    const resolvedSession = resolveSessionRequest(
      overrides.sessionId ?? c.req.header('X-Session-Id'),
      overrides.newSession ?? (c.req.header('X-New-Session') === 'true'),
    );
    const sessionId = resolvedSession.sessionId;
    const newSession = resolvedSession.newSession;

    // ── Build prompt ──────────────────────────────────────────────
    let prompt = '';
    let systemPrompt = '';
    const messages = body.messages || [];

    for (const msg of messages) {
      let contentStr = '';
      if (Array.isArray(msg.content)) {
        contentStr = msg.content.map((c: any) => c.text || JSON.stringify(c)).join('\n');
      } else if (typeof msg.content === 'object' && msg.content !== null) {
        contentStr = JSON.stringify(msg.content);
      } else {
        contentStr = msg.content || '';
      }

      if (msg.role === 'system' || msg.role === 'developer') systemPrompt += (contentStr || '') + '\n\n';
      else if (msg.role === 'user') prompt += `User: ${contentStr || ''}\n\n`;
      else if (msg.role === 'assistant') {
        let ac = contentStr || '';
        const reasoning = (msg as any).reasoning_content;
        if (reasoning) ac = `<think>\n${reasoning}\n</think>\n${ac}`;
        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            let args: any = {};
            if (typeof tc.function?.arguments === 'string') { try { args = JSON.parse(tc.function.arguments); } catch {} }
            else if (tc.function?.arguments) args = tc.function.arguments;
            ac += `\n<tool_call>\n${JSON.stringify({ name: tc.function?.name, arguments: args })}\n</tool_call>`;
          }
        }
        prompt += `Assistant: ${ac.trim()}\n\n`;
      } else if (msg.role === 'tool' || msg.role === 'function') {
        let tn = msg.name;
        if (!tn && msg.tool_call_id) {
          for (const pm of messages) {
            if (pm.role === 'assistant' && pm.tool_calls) {
              const call = pm.tool_calls.find((tc: any) => tc.id === msg.tool_call_id);
              if (call) { tn = call.function?.name; break; }
            }
          }
        }
        prompt += `Tool Response (${tn || 'tool'}): ${contentStr || ''}\n\n`;
      }
    }

    // ── Inject tools ──────────────────────────────────────────────
    const requestTools = body.tools || [];
    let exposedTools = requestTools;
    if (requestTools.length > 0) {
      const preferredToolName = typeof body.tool_choice === 'object' ? body.tool_choice.function.name : undefined;
      const prepared = prepareToolsForQwen(requestTools, getQwenToolLimit(), preferredToolName);
      exposedTools = prepared.selected;
      console.log('[Chat] Tools in request:', requestTools.length, '| shown to Qwen:', prepared.selected.length);
      console.log('[Chat] Tool names:', prepared.selected.map(tool => tool.function.name).join(', '));
      if (prepared.omittedNames.length > 0) {
        console.warn('[Chat] Omitted tools due to QWEN_MAX_TOOLS:', prepared.omittedNames.join(', '));
      }
      systemPrompt += `\n\n# TOOLS (${requestTools.length} available, showing ${prepared.selected.length})\n${JSON.stringify(prepared.formatted)}\n\n# FORMAT\nUse <tool_call>{"name":"x","arguments":{...}}</tool_call> to call tools. Call multiple with multiple blocks. Wait for results.\n\n`;
      if (prepared.omittedNames.length > 0) {
        systemPrompt += `Available tool names omitted from the prompt due to the configured limit: ${prepared.omittedNames.join(', ')}. Do not call an omitted tool.\n\n`;
      }
      if (body.tool_choice === 'none') systemPrompt += 'CRITICAL: Do not call tools for this request.\n\n';
      else if (body.tool_choice === 'required') systemPrompt += 'CRITICAL: Call at least one tool for this request.\n\n';
      else if (typeof body.tool_choice === 'object' && body.tool_choice.function?.name) systemPrompt += `CRITICAL: Call "${body.tool_choice.function.name}" now.\n\n`;
    }

    if (body.response_format?.type === 'json_object') {
      systemPrompt += '\n\nCRITICAL: Return a valid JSON object only. Do not wrap it in markdown fences or add commentary.\n\n';
    } else if (body.response_format?.type === 'json_schema') {
      const schemaEnvelope = body.response_format.json_schema;
      const schema = isRecord(schemaEnvelope) && isRecord(schemaEnvelope.schema) ? schemaEnvelope.schema : schemaEnvelope;
      systemPrompt += `\n\nCRITICAL: Return JSON only and conform to this JSON Schema:\n${JSON.stringify(schema)}\n\n`;
    }

    const isThinkingModel = !body.model.includes('no-thinking');
    const isNewSession = newSession;
    const maxTokens = body.max_completion_tokens ?? body.max_tokens ?? 16384;
    const qwenOptions = {
      ...(body.temperature === undefined ? {} : { temperature: body.temperature }),
      ...(body.top_p === undefined ? {} : { top_p: body.top_p }),
      ...(body.stop === undefined ? {} : { stop: body.stop }),
      ...(body.presence_penalty === undefined ? {} : { presence_penalty: body.presence_penalty }),
      ...(body.frequency_penalty === undefined ? {} : { frequency_penalty: body.frequency_penalty }),
      ...(body.seed === undefined ? {} : { seed: body.seed }),
      ...(body.user === undefined ? {} : { user: body.user }),
    };
    const includeUsage = body.stream_options?.include_usage === true;
    const requiresStructuredOutputValidation = body.response_format?.type === 'json_object' || body.response_format?.type === 'json_schema';
    const finalPrompt = systemPrompt ? `${systemPrompt}\n${prompt}` : prompt;

    // ── Retry loop ────────────────────────────────────────────────
    const { mutex: sessionMutex, release } = await acquireSessionMutex(sessionId, c.req.raw.signal);
    let released = false;
    releaseSessionLock = () => {
      if (!released) {
        released = true;
        release();
        if (sessionId !== 'main' && sessionMutex.isIdle) sessionMutexes.delete(sessionId);
      }
    };
    await waitWithAbort(1000, c.req.raw.signal);

    let stream: ReadableStream;
    let uiSessionId = '';
    let retries = 5;
    let delay = 2000;
    let rotated = false;

    while (retries > 0) {
      try {
        const result = await createQwenStream(finalPrompt, isThinkingModel, body.model, isNewSession ? null : undefined, sessionId, maxTokens, c.req.raw.signal, qwenOptions);
        stream = result.stream;
        uiSessionId = result.uiSessionId;
        break;
      } catch (err: any) {
        retries--;
        const chatNotFound = err instanceof QwenUpstreamError
          && ['CHAT_NOT_FOUND', 'ChatNotFound', 'CHAT_NOT_EXIST'].includes(err.upstreamCode);
        if (chatNotFound) {
          invalidateSessionChat(sessionId);
        }
        if (retries === 0) { releaseSessionLock?.(); throw err; }
        let d = delay;
        if (err instanceof RetryableQwenStreamError && err.retryAfterMs) d = err.retryAfterMs;
        if (err instanceof QwenUpstreamError && err.upstreamCode === 'RateLimited') {
          rotated = true;
          invalidateSessionChat(sessionId);
          d = 5000;
        }
        const retryable = err instanceof RetryableQwenStreamError
          || chatNotFound
          || err.message?.includes('in progress')
          || (err instanceof QwenUpstreamError && err.upstreamCode === 'Bad_Request');
        if (!retryable) { releaseSessionLock?.(); throw err; }
        console.warn(`[Chat:${sessionId}] Retry in ${d}ms (${retries} left)`);
        await waitWithAbort(d, c.req.raw.signal);
        delay = Math.min(delay * 2, 30000);
      }
    }

    const completionId = 'chatcmpl-' + uuidv4();

    // ── Non-streaming ─────────────────────────────────────────────
    if (!isStream) {
      let reasoningBuffer = '', lastFullContent = '', targetResponseId: string | null = null, currentThoughtIndex = 0;
      const toolParser = new StreamingToolParser(body.tool_choice === 'none' ? [] : exposedTools);
      const toolCallsOut: RouteToolCall[] = [];
      const structuredToolCalls = new Map<number, StructuredToolCall>();
      let completionTokens = 0, promptTokens = Math.ceil(finalPrompt.length / 3.5);
      let upstreamFinishReason: string | null = null;
      let upstreamError: { message: string; status: number } | null = null;

      for await (const event of parseSSEStream(stream!, c.req.raw.signal)) {
        const dataStr = event.data.trim();
        if (!dataStr) continue;
        if (dataStr === '[DONE]') break;
        const parsedUpstreamError = parseQwenErrorPayload(dataStr);
        if (parsedUpstreamError) {
          upstreamError = parsedUpstreamError;
          continue;
        }
        try {
          const chunk = JSON.parse(dataStr);
          if (chunk['response.created']?.response_id) {
            if (!targetResponseId) targetResponseId = chunk['response.created'].response_id;
            updateSessionParent(uiSessionId, chunk['response.created'].response_id, sessionId);
          }
          if (chunk.usage) {
            if (chunk.usage.output_tokens) completionTokens = chunk.usage.output_tokens;
            if (chunk.usage.input_tokens) promptTokens = chunk.usage.input_tokens;
          }
          const choice = chunk.choices?.[0];
          if (typeof choice?.finish_reason === 'string' && choice.finish_reason) upstreamFinishReason = choice.finish_reason;
          const delta = choice?.delta;
          if (delta && responseIdMatches(chunk, targetResponseId)) {
            if (Array.isArray(delta.tool_calls)) {
              delta.tool_calls.forEach((toolDelta: any, index: number) => {
                mergeStructuredToolCall(structuredToolCalls, toolDelta, index);
              });
            }
            if (delta.phase === 'thinking_summary') {
              const thoughts = delta.extra?.summary_thought?.content;
              if (thoughts?.length > currentThoughtIndex) {
                reasoningBuffer += thoughts.slice(currentThoughtIndex).join('\n');
                currentThoughtIndex = thoughts.length;
              }
            } else if (delta.phase === 'think') {
              if (delta.content !== undefined) {
                const result = getIncrementalDelta(reasoningBuffer, delta.content || '');
                if (result.delta) reasoningBuffer = result.matchedContent;
              }
            } else if (delta.content !== undefined) {
              const result = getIncrementalDelta(lastFullContent, delta.content || '');
              if (result.delta) {
                lastFullContent = result.matchedContent;
                const { toolCalls } = toolParser.feed(result.delta);
                for (const tc of toolCalls) {
                  pushSanitizedRouteToolCall(toolCallsOut, 'content', { id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } }, exposedTools, body.tool_choice);
                }
              }
            }
          }
        } catch {}
      }

      if (upstreamError) { releaseSessionLock?.(); return errorResponse(c, upstreamError.status, upstreamError.message, 'qwen_upstream_error'); }

      const flushed = toolParser.flush();
      if (flushed.text) lastFullContent += flushed.text;
      for (const tc of flushed.toolCalls) {
        pushSanitizedRouteToolCall(toolCallsOut, 'content', { id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } }, exposedTools, body.tool_choice);
      }
      for (const call of structuredToolCalls.values()) {
        pushSanitizedRouteToolCall(toolCallsOut, 'structured', call, exposedTools, body.tool_choice);
      }

      if (body.tool_choice === 'none') lastFullContent = removeCompleteToolMarkup(lastFullContent);

      const dedupedToolCalls = dedupeRouteToolCalls(toolCallsOut);
      if (requiresToolCall(body.tool_choice) && dedupedToolCalls.length === 0) {
        releaseSessionLock?.();
        return errorResponse(c, 502, 'Qwen did not return a required tool call', 'required_tool_call_missing');
      }

      const responseFormatError = dedupedToolCalls.length ? null : validateResponseFormat(lastFullContent, body.response_format);
      if (responseFormatError) {
        releaseSessionLock?.();
        return errorResponse(c, 502, responseFormatError, 'invalid_response_format');
      }

      const message: any = { role: 'assistant', content: dedupedToolCalls.length ? null : lastFullContent };
      if (reasoningBuffer) message.reasoning_content = reasoningBuffer;
      if (dedupedToolCalls.length) { dedupedToolCalls.forEach((tc: any, i: number) => tc.index = i); message.tool_calls = dedupedToolCalls; }

      releaseSessionLock?.();
      c.header('X-Session-Id', sessionId);
      if (rotated) c.header('X-Account-Rotated', 'true');
      const effectiveFinishReason = dedupedToolCalls.length
        ? 'tool_calls'
        : (upstreamFinishReason === 'tool_calls' ? 'stop' : (upstreamFinishReason || 'stop'));
      return c.json({
        id: completionId, object: 'chat.completion', created: Math.floor(Date.now() / 1000),
        model: body.model, choices: [{ index: 0, message, logprobs: null, finish_reason: effectiveFinishReason }],
        usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens, prompt_tokens_details: { cached_tokens: 0 } },
      });
    }

    // ── Streaming ─────────────────────────────────────────────────
    c.header('Content-Type', 'text/event-stream');
    c.header('Cache-Control', 'no-cache');
    c.header('Connection', 'keep-alive');
    c.header('X-Session-Id', sessionId);
    if (rotated) c.header('X-Account-Rotated', 'true');

    const response = honoStream(c, async (writer: any) => {
      let heartbeat: any;
      try {
        await writer.write(': heartbeat\n\n');
        heartbeat = setInterval(async () => { try { await writer.write(': keep-alive\n\n'); } catch { clearInterval(heartbeat); } }, 15000);

        const writeEvent = async (data: any) => { await writer.write(`data: ${JSON.stringify(data)}\n\n`); };
        const makeChoice = (delta: any, finish: string | null = null) => ({ index: 0, delta, logprobs: null, finish_reason: finish });

        await writeEvent({ id: completionId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model, choices: [makeChoice({ role: 'assistant', content: '' })] });

        let reasoningBuffer = '', lastFullContent = '', targetResponseId: string | null = null, currentThoughtIndex = 0;
        const toolParser = new StreamingToolParser(body.tool_choice === 'none' ? [] : exposedTools);
        const structuredToolCalls = new Map<number, StructuredToolCall>();
        const pendingContentToolCalls: StructuredToolCall[] = [];
        let completionTokens = 0, promptTokens = Math.ceil(finalPrompt.length / 3.5);
        let upstreamFinishReason: string | null = null;
        let toolCallIndex = 0;
        let upstreamError: { message: string; status: number } | null = null;

        for await (const event of parseSSEStream(stream, c.req.raw.signal)) {
          const dataStr = event.data.trim();
          if (!dataStr) continue;
          if (dataStr === '[DONE]') break;
          const parsedUpstreamError = parseQwenErrorPayload(dataStr);
          if (parsedUpstreamError) {
            upstreamError = parsedUpstreamError;
            continue;
          }
          try {
            const chunk = JSON.parse(dataStr);
            if (chunk['response.created']?.response_id) {
              if (!targetResponseId) targetResponseId = chunk['response.created'].response_id;
              updateSessionParent(uiSessionId, chunk['response.created'].response_id, sessionId);
            }
            if (chunk.usage) {
              if (chunk.usage.output_tokens) completionTokens = chunk.usage.output_tokens;
              if (chunk.usage.input_tokens) promptTokens = chunk.usage.input_tokens;
            }
            const choice = chunk.choices?.[0];
          if (typeof choice?.finish_reason === 'string' && choice.finish_reason) upstreamFinishReason = choice.finish_reason;
          const delta = choice?.delta;
          if (delta && responseIdMatches(chunk, targetResponseId)) {
            if (Array.isArray(delta.tool_calls)) {
              for (const [index, toolDelta] of delta.tool_calls.entries()) {
                mergeStructuredToolCall(structuredToolCalls, toolDelta, index);
              }
            }
              if (delta.phase === 'thinking_summary') {
                const thoughts = delta.extra?.summary_thought?.content;
                if (thoughts?.length > currentThoughtIndex) {
                  const t = thoughts.slice(currentThoughtIndex).join('\n');
                  currentThoughtIndex = thoughts.length;
                  reasoningBuffer += t;
                  await writeEvent({ id: completionId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model, choices: [makeChoice({ reasoning_content: t })] });
                }
              } else if (delta.phase === 'think') {
                if (delta.content !== undefined) {
                  const result = getIncrementalDelta(reasoningBuffer, delta.content || '');
                  if (result.delta) {
                    reasoningBuffer = result.matchedContent;
                    await writeEvent({ id: completionId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model, choices: [makeChoice({ reasoning_content: result.delta })] });
                  }
                }
              } else if (delta.content !== undefined) {
                const result = getIncrementalDelta(lastFullContent, delta.content || '');
                if (result.delta) {
                  lastFullContent = result.matchedContent;
                  const { text, toolCalls } = toolParser.feed(result.delta);
                  if (text && !requiresStructuredOutputValidation && body.tool_choice !== 'none') await writeEvent({ id: completionId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model, choices: [makeChoice({ content: text })] });
                  for (const tc of toolCalls) {
                    const sanitized = sanitizeRouteToolCall({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } }, exposedTools, body.tool_choice);
                    if (sanitized) pendingContentToolCalls.push(sanitized);
                  }
                }
              }
            }
          } catch {}
        }

        if (upstreamError) {
          await writeEvent({ error: { message: upstreamError.message, type: 'server_error', code: 'qwen_upstream_error' } });
          await writer.write('data: [DONE]\n\n');
          return;
        }

        const flushed = toolParser.flush();
        if (flushed.text) lastFullContent += flushed.text;
        if (flushed.text && !requiresStructuredOutputValidation && body.tool_choice !== 'none') {
          await writeEvent({ id: completionId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model, choices: [makeChoice({ content: flushed.text })] });
        }
        for (const tc of flushed.toolCalls) {
          const sanitized = sanitizeRouteToolCall({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } }, exposedTools, body.tool_choice);
          if (sanitized) pendingContentToolCalls.push(sanitized);
        }

        const structuredCalls = [...structuredToolCalls.values()]
          .map(call => sanitizeRouteToolCall(call, exposedTools, body.tool_choice))
          .filter((call): call is StructuredToolCall => call !== null);
        const mixedToolCalls = dedupeRouteToolCallEntries([
          ...structuredCalls.map(call => ({ source: 'structured' as const, call })),
          ...pendingContentToolCalls.map(call => ({ source: 'content' as const, call })),
        ]);
        for (const item of mixedToolCalls) {
          await writeEvent({ id: completionId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model, choices: [makeChoice({ tool_calls: [{ index: toolCallIndex++, id: item.call.id, type: item.call.type, function: item.call.function }] })] });
        }

        const hasToolCalls = toolCallIndex > 0;
        if (requiresToolCall(body.tool_choice) && toolCallIndex === 0) {
          await writeEvent({ error: { message: 'Qwen did not return a required tool call', type: 'server_error', code: 'required_tool_call_missing' } });
          await writer.write('data: [DONE]\n\n');
          return;
        }
        
        if (body.tool_choice === 'none') lastFullContent = removeCompleteToolMarkup(lastFullContent);
        if (!hasToolCalls && body.tool_choice === 'none' && !requiresStructuredOutputValidation && lastFullContent) {
          await writeEvent({ id: completionId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model, choices: [makeChoice({ content: lastFullContent })] });
        }
        if (!hasToolCalls && requiresStructuredOutputValidation) {
          const responseFormatError = validateResponseFormat(lastFullContent, body.response_format);
          if (responseFormatError) {
            await writeEvent({ error: { message: responseFormatError, type: 'server_error', code: 'invalid_response_format' } });
            await writer.write('data: [DONE]\n\n');
            return;
          }
          if (lastFullContent) {
            await writeEvent({ id: completionId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model, choices: [makeChoice({ content: lastFullContent })] });
          }
        }

        // Emit final chunk with finish_reason so Hermes knows stream completed cleanly
        const effectiveStreamFinishReason = hasToolCalls
          ? 'tool_calls'
          : (upstreamFinishReason === 'tool_calls' ? 'stop' : (upstreamFinishReason || 'stop'));
        const finalChunk: Record<string, unknown> = {
          id: completionId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [makeChoice({}, effectiveStreamFinishReason)],
        };
        if (includeUsage) {
          finalChunk.usage = { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens, prompt_tokens_details: { cached_tokens: 0 } };
        }
        await writeEvent(finalChunk);
        await writer.write('data: [DONE]\n\n');
      } catch (error: any) {
        if (!c.req.raw.signal.aborted) {
          try {
            await writer.write(`data: ${JSON.stringify({ error: { message: error?.message || 'Qwen upstream stream failed', type: 'server_error', code: 'qwen_upstream_stream_error' } })}\n\n`);
            await writer.write('data: [DONE]\n\n');
          } catch {}
        }
      } finally {
        clearInterval(heartbeat);
        releaseSessionLock?.();
      }
    });
    streamOwnsLock = true;
    return response;
  } catch (e: any) {
    if (e instanceof RequestValidationError) {
      return errorResponse(c, e.status, e.message, e.code, e.param);
    }
    if (e instanceof QwenUpstreamError) {
      return errorResponse(c, e.upstreamStatus, e.message, e.upstreamCode);
    }
    if (e instanceof RetryableQwenStreamError) {
      return errorResponse(c, 503, e.message, 'upstream_retryable_error');
    }
    return errorResponse(c, 500, e?.message || 'Internal server error', 'internal_server_error');
  } finally {
    if (!streamOwnsLock) releaseSessionLock?.();
  }
}

// ── Session endpoints ───────────────────────────────────────────────

export async function sessionInfo(c: Context) {
  const sid = getEndpointSessionId(c, c.req.query('id'), 'main');
  if (sid instanceof Response) return sid;
  return c.json({
    sessionId: sid,
    chatId: getActiveChatId(sid),
    hasSession: !!getActiveChatId(sid),
  });
}

export async function sessionList(c: Context) {
  return c.json({ sessions: listSessions() });
}

export async function sessionReset(c: Context) {
  const sid = getEndpointSessionId(c, c.req.query('id'), 'main');
  if (sid instanceof Response) return sid;
  return withSessionLock(sid, () => {
    setActiveChatId(null, sid);
    return c.json({ ok: true, sessionId: sid });
  }, c.req.raw.signal);
}

export async function sessionDelete(c: Context) {
  const sid = getEndpointSessionId(c, c.req.query('id'));
  if (sid instanceof Response) return sid;
  if (sid === 'main') return c.json({ ok: false, error: 'Cannot delete main session. Use reset instead.' }, 400);
  return withSessionLock(sid, () => {
    const ok = deleteSession(sid);
    return c.json({ ok, sessionId: sid });
  }, c.req.raw.signal);
}

export async function sessionFork(c: Context) {
  // Forks use a stable explicit ID so the response header and session registry
  // refer to the same isolated conversation.
  const sid = `subagent-${uuidv4().substring(0, 8)}`;
  return chatCompletions(c, { sessionId: sid, newSession: true });
}
