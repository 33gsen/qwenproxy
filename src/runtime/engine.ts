/*
 * engine.ts — Agent State Machine
 * Loop: LLM call → parse tools → execute → feed results → repeat
 * Designed for autonomous agents like Hermes.
 */

import { v4 as uuidv4 } from 'uuid';
import { StreamingToolParser } from '../tools/parser.ts';
import { registry } from '../tools/registry.ts';
import { SchemaValidationError } from '../tools/schema.ts';
import type {
  AgentState, AgentPhase, AgentConfig, AgentEvent, AgentEventListener,
  LLMAdapter, LLMResponse, LLMStreamChunk,
} from './types.ts';
import type {
  Message, ParsedToolCall, ToolCallResult, FunctionToolDefinition,
} from '../types/openai.ts';

// ─── State factory ──────────────────────────────────────────────────

function createInitialState(model: string, stream: boolean, messages: Message[], tools: FunctionToolDefinition[], config: AgentConfig): AgentState {
  const now = Date.now();
  const flatTools = tools.map(t => t.type === 'function' ? t : null).filter(Boolean) as FunctionToolDefinition[];
  return {
    phase: 'idle', runId: uuidv4(), model, stream,
    messages: [...messages], tools: flatTools,
    turn: 0, maxTurns: config.maxTurns ?? 10,
    pendingToolCalls: [], toolResults: [],
    finalContent: null, finishReason: null,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 },
    error: null,
    timestamps: { created: now },
    state: config.initialState ? { ...config.initialState } : {},
  };
}

// ─── Tool execution helpers ─────────────────────────────────────────

function buildToolPrompt(tools: FunctionToolDefinition[]): string {
  if (!tools.length) return '';
  const formatted = tools.map(t => ({
    name: t.function.name,
    description: t.function.description || '',
    parameters: t.function.parameters,
  }));
  const json = JSON.stringify(formatted, null, 2);
  return `\n\n# TOOLS AVAILABLE\n${json}\n\n# TOOL CALL FORMAT\nUse <tool_call>{"name":"tool_name","arguments":{...}}</tool_call> to call a tool.\nCall multiple tools with multiple blocks. Wait for results after calling.\n`;
}

function buildMessagesWithContext(state: AgentState): Message[] {
  const msgs: Message[] = [];
  // Inject system prompt with tools
  const toolPrompt = buildToolPrompt(state.tools);
  if (toolPrompt) {
    msgs.push({ role: 'system', content: `You are an autonomous AI agent. You can call tools. Be concise and direct.${toolPrompt}` });
  }
  // Add conversation history. Tool results are appended to state.messages after
  // execution, so they are not injected a second time here.
  for (const msg of state.messages) {
    msgs.push(msg);
  }
  return msgs;
}

class RuntimeTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeTimeoutError';
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number | undefined,
  onTimeout: () => void,
  message: string,
): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new RuntimeTimeoutError(message));
    }, timeoutMs);
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}

function isAllowedToolCall(toolCall: ParsedToolCall, tools: FunctionToolDefinition[]): boolean {
  return tools.some(tool => tool.function.name === toolCall.name);
}

type StreamToolCall = ParsedToolCall & { source: 'structured' | 'content' };
const inFlightTools = new Map<string, Promise<unknown>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function defineOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function mergeToolArguments(left: Record<string, unknown>, right: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(left)) defineOwn(merged, key, value);
  for (const [key, value] of Object.entries(right)) {
    const previous = merged[key];
    defineOwn(merged, key, isRecord(previous) && isRecord(value)
      ? mergeToolArguments(previous, value)
      : value);
  }
  return merged;
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}

function dedupeCrossSourceToolCalls(calls: StreamToolCall[]): StreamToolCall[] {
  const result: StreamToolCall[] = [];
  const firstBySemantic = new Map<string, { index: number; source: StreamToolCall['source'] }>();
  for (const call of calls) {
    const semanticKey = `${call.name}:${stableSerialize(call.arguments)}`;
    const previous = firstBySemantic.get(semanticKey);
    if (previous && previous.source !== call.source) {
      if (call.source === 'structured' && previous.source === 'content') result[previous.index] = call;
      continue;
    }
    if (!previous) firstBySemantic.set(semanticKey, { index: result.length, source: call.source });
    result.push(call);
  }
  return result;
}

function mergeStreamToolCallDeltas(calls: StreamToolCall[]): StreamToolCall[] {
  const withIds = new Map<string, StreamToolCall>();
  const withoutIds: StreamToolCall[] = [];
  for (const call of calls) {
    if (!call.id) {
      withoutIds.push(call);
      continue;
    }
    const previous = withIds.get(call.id);
    if (!previous) {
      withIds.set(call.id, {
        ...call,
        arguments: mergeToolArguments({}, call.arguments || {}),
      });
      continue;
    }
    withIds.set(call.id, {
      id: previous.id,
      name: previous.name || call.name,
      arguments: mergeToolArguments(previous.arguments || {}, call.arguments || {}),
      source: previous.source === 'structured' || call.source === 'structured' ? 'structured' : 'content',
    });
  }
  return [...withIds.values(), ...withoutIds];
}

async function executeToolCalls(state: AgentState, config: AgentConfig): Promise<ToolCallResult[]> {
  const results: ToolCallResult[] = [];
  for (const tc of state.pendingToolCalls) {
    try {
      if (!isAllowedToolCall(tc, state.tools)) {
        results.push({
          toolCallId: tc.id,
          name: tc.name,
          result: `Error: Tool '${tc.name}' is not enabled for this run`,
          isError: true,
        });
        continue;
      }
      const tool = registry.get(tc.name);
      if (!tool) {
        results.push({ toolCallId: tc.id, name: tc.name, result: `Error: Unknown tool "${tc.name}"`, isError: true });
        continue;
      }
      // Validate args
      let toolArgs = tc.arguments;
      if (tool.parameters) {
        const { validateParams } = await import('../tools/schema.ts');
        const validation = validateParams(tc.arguments, tool.parameters);
        if (!validation.valid) {
          results.push({ toolCallId: tc.id, name: tc.name, result: `Error: ${validation.errors?.join('; ')}`, isError: true });
          continue;
        }
        toolArgs = validation.value as Record<string, unknown>;
      }
      if (inFlightTools.has(tc.name)) {
        throw new RuntimeTimeoutError(`Tool '${tc.name}' is still settling after a previous timeout`);
      }
      const toolController = new AbortController();
      const execution = Promise.resolve().then(() => tool.handler(toolArgs, {
        messages: state.messages,
        turn: state.turn,
        model: state.model,
        state: state.state,
        signal: toolController.signal,
      }));
      inFlightTools.set(tc.name, execution);
      execution.then(
        () => { if (inFlightTools.get(tc.name) === execution) inFlightTools.delete(tc.name); },
        () => { if (inFlightTools.get(tc.name) === execution) inFlightTools.delete(tc.name); },
      );
      const rawResult = await withTimeout(
        execution,
        config.toolTimeout,
        () => toolController.abort(new Error(`Tool '${tc.name}' timed out`)),
        `Tool '${tc.name}' timed out after ${config.toolTimeout}ms`,
      );
      const resultStr = typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult) ?? 'undefined';
      results.push({ toolCallId: tc.id, name: tc.name, result: resultStr, isError: false });
    } catch (e: any) {
      if (e instanceof RuntimeTimeoutError) throw e;
      results.push({ toolCallId: tc.id, name: tc.name, result: `Error: ${e.message}`, isError: true });
    }
  }
  return results;
}

// ─── Engine ──────────────────────────────────────────────────────────

export async function runAgent(
  adapter: LLMAdapter,
  messages: Message[],
  tools: FunctionToolDefinition[],
  model: string,
  config: AgentConfig = {},
  listener?: AgentEventListener,
): Promise<AgentState> {
  const state = createInitialState(model, false, messages, tools, config);
  const emit = (ev: AgentEvent) => { listener?.(ev); if (config.debug) console.log('[Agent]', JSON.stringify(ev)); };

  state.phase = 'planning';
  state.timestamps.started = Date.now();
  emit({ type: 'phase_change', from: 'idle', to: 'planning', timestamp: Date.now() });

  try {
    while (state.turn < state.maxTurns) {
      state.timestamps.lastTurnAt = Date.now();
      state.pendingToolCalls = [];

      // Build messages + call LLM
      state.phase = 'calling_llm';
      emit({ type: 'llm_request', turn: state.turn, messageCount: state.messages.length, timestamp: Date.now() });

      const llmMessages = buildMessagesWithContext(state);
      const llmController = new AbortController();
      const response: LLMResponse = await withTimeout(
        Promise.resolve().then(() => adapter.complete(llmMessages, tools.length ? tools : undefined, model, llmController.signal)),
        config.llmTimeout,
        () => llmController.abort(),
        `LLM call timed out after ${config.llmTimeout}ms`,
      );

      emit({ type: 'llm_response', turn: state.turn, contentLength: response.content?.length || 0, toolCallCount: response.toolCalls.length, timestamp: Date.now() });

      // Update usage
      if (response.usage) {
        state.usage.promptTokens += response.usage.promptTokens || 0;
        state.usage.completionTokens += response.usage.completionTokens || 0;
        state.usage.totalTokens = state.usage.promptTokens + state.usage.completionTokens;
      }

      // Parse tool calls from content and preserve adapter-provided calls.
      state.phase = 'parsing';
      const parsedToolCalls: ParsedToolCall[] = [];
      let allText = '';
      if (response.content) {
        const toolParser = new StreamingToolParser(tools);
        const { text, toolCalls } = toolParser.feed(response.content);
        const flushed = toolParser.flush();
        parsedToolCalls.push(...toolCalls, ...flushed.toolCalls);
        allText = text + (flushed.text || '');
      }

      const allCalls = dedupeCrossSourceToolCalls([
        ...(response.toolCalls || []).filter(call => isAllowedToolCall(call, tools)).map(call => ({ ...call, source: 'structured' as const })),
        ...parsedToolCalls.filter(call => isAllowedToolCall(call, tools)).map(call => ({ ...call, source: 'content' as const })),
      ]);

      const assistantMessage: Message = { role: 'assistant', content: allText || null };
      if (allCalls.length > 0) {
        state.pendingToolCalls = allCalls.map(tc => ({
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
        }));
        assistantMessage.tool_calls = allCalls.map(tc => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.name,
            arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments ?? {}),
          },
        }));
      }

      if (allText || allCalls.length > 0) {
        state.messages.push(assistantMessage);
        if (allText) state.finalContent = (state.finalContent || '') + allText;
      }

      // If no tool calls, we're done
      if (state.pendingToolCalls.length === 0) {
        state.phase = 'completed';
        state.finishReason = response.finishReason === 'tool_calls' ? 'stop' : (response.finishReason || 'stop');
        state.timestamps.completed = Date.now();
        emit({ type: 'completed', turn: state.turn, totalTokens: state.usage.totalTokens, duration: state.timestamps.completed - state.timestamps.created, timestamp: Date.now() });
        return state;
      }

      // Execute tools
      state.phase = 'executing';
      const toolStartedAt = new Map<string, number>();
      for (const tc of state.pendingToolCalls) {
        toolStartedAt.set(tc.id, Date.now());
        emit({ type: 'tool_start', turn: state.turn, toolName: tc.name, toolCallId: tc.id, timestamp: Date.now() });
      }

      state.toolResults = await executeToolCalls(state, config);
      for (const tr of state.toolResults) {
        state.messages.push({ role: 'tool', content: tr.result, tool_call_id: tr.toolCallId, name: tr.name });
      }

      for (const tr of state.toolResults) {
        emit({
          type: 'tool_end',
          turn: state.turn,
          toolName: tr.name,
          toolCallId: tr.toolCallId,
          isError: tr.isError,
          duration: Date.now() - (toolStartedAt.get(tr.toolCallId) || Date.now()),
          timestamp: Date.now(),
        });
      }

      state.turn++;
    }

    // Max turns reached
    state.phase = 'completed';
    state.finishReason = 'length';
    state.timestamps.completed = Date.now();
    emit({ type: 'completed', turn: state.turn, totalTokens: state.usage.totalTokens, duration: state.timestamps.completed - state.timestamps.created, timestamp: Date.now() });

  } catch (e: any) {
    const failedPhase = state.phase;
    state.phase = 'error';
    state.error = { code: 'ENGINE_ERROR', message: e.message, phase: failedPhase, recoverable: false, cause: e };
    state.timestamps.erroredAt = Date.now();
    emit({ type: 'error', phase: failedPhase, code: 'ENGINE_ERROR', message: e.message, timestamp: Date.now() });
  }

  return state;
}

// ─── Streaming agent ─────────────────────────────────────────────────

function cloneAgentState(state: AgentState): AgentState {
  return {
    ...state,
    messages: [...state.messages],
    tools: [...state.tools],
    pendingToolCalls: state.pendingToolCalls.map(call => ({ ...call, arguments: { ...call.arguments } })),
    toolResults: state.toolResults.map(result => ({ ...result })),
    usage: { ...state.usage },
    timestamps: { ...state.timestamps },
    state: { ...state.state },
    error: state.error ? { ...state.error } : null,
  };
}

export async function* streamAgent(
  adapter: LLMAdapter,
  messages: Message[],
  tools: FunctionToolDefinition[],
  model: string,
  config: AgentConfig = {},
): AsyncGenerator<AgentState> {
  const state = createInitialState(model, true, messages, tools, config);
  state.phase = 'planning';
  state.timestamps.started = Date.now();

  try {
    while (state.turn < state.maxTurns) {
      state.pendingToolCalls = [];
      state.phase = 'calling_llm';
      const llmController = new AbortController();
      const iterator = adapter.stream(
        buildMessagesWithContext(state),
        tools.length ? tools : undefined,
        model,
        llmController.signal,
      )[Symbol.asyncIterator]();
      const parser = new StreamingToolParser(tools);
      const streamedToolCalls: StreamToolCall[] = [];
      let turnContent = '';
      let reasoning = '';
      let usage: Partial<AgentState['usage']> = {};
      let streamFinishReason: string | undefined;
      let streamTimedOut = false;

      try {
        while (true) {
          const step = await withTimeout(
            iterator.next(),
            config.llmTimeout,
            () => { streamTimedOut = true; llmController.abort(); },
            `LLM stream timed out after ${config.llmTimeout}ms`,
          );
          if (step.done) break;
          const chunk = step.value;
          if (chunk.content) {
            const parsed = parser.feed(chunk.content);
            turnContent += parsed.text;
            streamedToolCalls.push(...parsed.toolCalls.map(call => ({ ...call, source: 'content' as const })));
          }
          if (chunk.toolCalls?.length) {
            streamedToolCalls.push(...chunk.toolCalls
              .filter(call => isAllowedToolCall(call, tools))
              .map(call => ({ ...call, source: 'structured' as const })));
          }
          if (chunk.reasoning) reasoning += chunk.reasoning;
          if (chunk.usage) usage = chunk.usage;
          if (chunk.finishReason) streamFinishReason = chunk.finishReason;
          if (chunk.done) break;

          state.phase = 'streaming';
          state.finalContent = turnContent || state.finalContent;
          yield cloneAgentState(state);
        }
      } finally {
        try {
          const cleanup = iterator.return?.(undefined);
          if (cleanup) {
            if (streamTimedOut) void Promise.resolve(cleanup).catch(() => undefined);
            else await cleanup;
          }
        } catch (cleanupError) {
          if (!streamTimedOut) throw cleanupError;
        }
      }

      const flushed = parser.flush();
      turnContent += flushed.text || '';
      streamedToolCalls.push(...flushed.toolCalls.map(call => ({ ...call, source: 'content' as const })));
      const allCalls = dedupeCrossSourceToolCalls(
        mergeStreamToolCallDeltas(streamedToolCalls).filter(call => isAllowedToolCall(call, tools)),
      );
      state.finalContent = turnContent || state.finalContent;
      state.usage = {
        promptTokens: state.usage.promptTokens + (usage.promptTokens || 0),
        completionTokens: state.usage.completionTokens + (usage.completionTokens || 0),
        totalTokens: state.usage.promptTokens + (usage.promptTokens || 0) + state.usage.completionTokens + (usage.completionTokens || 0),
        cachedTokens: state.usage.cachedTokens + (usage.cachedTokens || 0),
      };

      const assistantMessage: Message = {
        role: 'assistant',
        content: turnContent || null,
        ...(reasoning ? { reasoning_content: reasoning } : {}),
      };
      if (allCalls.length) {
        state.pendingToolCalls = allCalls.map(({ source: _source, ...call }) => call);
        assistantMessage.tool_calls = allCalls.map(call => ({
          id: call.id,
          type: 'function' as const,
          function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
        }));
      }
      if (turnContent || reasoning || allCalls.length) state.messages.push(assistantMessage);

      if (!allCalls.length) {
        state.phase = 'completed';
        state.finishReason = streamFinishReason === 'tool_calls' ? 'stop' : (streamFinishReason || 'stop');
        state.timestamps.completed = Date.now();
        yield cloneAgentState(state);
        return;
      }

      state.phase = 'executing';
      state.toolResults = await executeToolCalls(state, config);
      for (const result of state.toolResults) {
        state.messages.push({ role: 'tool', content: result.result, tool_call_id: result.toolCallId, name: result.name });
      }
      yield cloneAgentState(state);
      state.turn++;
    }

    state.phase = 'completed';
    state.finishReason = 'length';
    state.timestamps.completed = Date.now();
    yield cloneAgentState(state);
  } catch (error: any) {
    const failedPhase = state.phase;
    state.phase = 'error';
    state.error = { code: 'ENGINE_ERROR', message: error?.message || String(error), phase: failedPhase, recoverable: false, cause: error };
    state.timestamps.erroredAt = Date.now();
    yield cloneAgentState(state);
  }
}
