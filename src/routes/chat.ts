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
import { getActiveChatId, setActiveChatId, listSessions, deleteSession, resetSession as resetPlaywrightSession, Mutex } from '../services/playwright.ts';
import { StreamingToolParser } from '../tools/parser.ts';
import type { OpenAIRequest } from '../types/openai.ts';

// Per-session mutexes to prevent concurrent generations on same session
const sessionMutexes = new Map<string, Mutex>();

function getSessionMutex(sid: string): Mutex {
  if (!sessionMutexes.has(sid)) sessionMutexes.set(sid, new Mutex());
  return sessionMutexes.get(sid)!;
}

// ─── Helpers ─────────────────────────────────────────────────────────

function getIncrementalDelta(oldStr: string, newStr: string): { delta: string; matchedContent: string } {
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
      return { message: `Qwen: ${code}: ${p.data?.details || p.message}`, status: code === 'RateLimited' ? 429 : 502 };
    }
  } catch {}
  return null;
}

// ─── Main handler ────────────────────────────────────────────────────

export async function chatCompletions(c: Context) {
  try {
    const body: OpenAIRequest = await c.req.json();
    const isStream = body.stream ?? false;
    console.log('[Chat] Tools in request:', (body as any).tools?.length || 0, '| Model:', body.model, '| Messages:', body.messages?.length);

    // Session management via headers
    let sessionId = c.req.header('X-Session-Id') || 'main';
    const newSession = c.req.header('X-New-Session') === 'true';

    if (newSession) {
      sessionId = `subagent-${uuidv4().substring(0, 8)}`;
    }

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

      if (msg.role === 'system') systemPrompt += (contentStr || '') + '\n\n';
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
    const bodyAny = body as any;
    if (bodyAny.tools?.length > 0) {
      const MAX_TOOLS = 15;
      // Log all tool names to debug
      const allNames = bodyAny.tools.map((t: any) => t.function?.name).filter(Boolean);
      console.log('[Chat] Tool names (first 15):', allNames.slice(0, 15).join(', '));
      console.log('[Chat] Tool names (last 5):', allNames.slice(-5).join(', '));
      const PRIORITY = ['read_file', 'write_file', 'patch', 'search_files', 'terminal', 'execute_code', 'process', 'delegate_task', 'todo', 'skill_view', 'skill_manage', 'memory', 'browser_navigate', 'browser_snapshot', 'browser_click'];
      const priorityTools = bodyAny.tools.filter((t: any) => PRIORITY.includes(t.function?.name));
      const otherTools = bodyAny.tools.filter((t: any) => !PRIORITY.includes(t.function?.name));
      const toolsToShow = [...priorityTools, ...otherTools].slice(0, MAX_TOOLS);
      const showNames = toolsToShow.map((t: any) => t.function?.name || t.name).filter(Boolean);
      console.log('[Chat] Tools shown to Qwen (15):', showNames.join(', '));
      const formatted = toolsToShow.map((t: any) => t.type === 'function' ? { name: t.function.name, description: (t.function.description || '').substring(0, 100) } : t);
      systemPrompt += `\n\n# TOOLS (${bodyAny.tools.length} available, showing ${MAX_TOOLS})\n${JSON.stringify(formatted, null, 2)}\n\n# FORMAT\nUse <tool_call>{"name":"x","arguments":{...}}</tool_call> to call tools. Call multiple with multiple blocks. Wait for results.\n\n`;
      if (bodyAny.tool_choice?.function?.name) systemPrompt += `CRITICAL: Call "${bodyAny.tool_choice.function.name}" now.\n\n`;
    }

    const isThinkingModel = !body.model.includes('no-thinking');
    const isNewSession = newSession || !messages.some((m: any) => m.role === 'assistant');
    const maxTokens = (body as any).max_tokens || 16384;

    // ── Build final prompt ─────────────────────────────────────────
    // Se já existe chat (não é newSession), Qwen mantém histórico.
    // Enviar só a última mensagem evita re-trigger do thinking completo.
    let finalPrompt: string;
    if (!isNewSession && messages.length >= 2) {
      const lastMsg = messages[messages.length - 1];
      let lastContent = '';
      if (typeof lastMsg.content === 'string') lastContent = lastMsg.content;
      else if (Array.isArray(lastMsg.content)) lastContent = lastMsg.content.map((c: any) => c.text || JSON.stringify(c)).join('\\n');
      finalPrompt = lastMsg.role === 'tool' || lastMsg.role === 'function'
        ? `Tool result: ${lastContent}`
        : `User: ${lastContent}`;
    } else {
      finalPrompt = systemPrompt ? `${systemPrompt}\n${prompt}` : prompt;
    }

    // ── Retry loop ────────────────────────────────────────────────
    const releaseLock = await getSessionMutex(sessionId).acquire();
    await new Promise(r => setTimeout(r, 1000));

    let stream: ReadableStream;
    let uiSessionId = '';
    let retries = 5;
    let delay = 2000;
    let rotated = false;

    while (retries > 0) {
      try {
        const result = await createQwenStream(finalPrompt, isThinkingModel, body.model, isNewSession ? null : undefined, sessionId, maxTokens);
        stream = result.stream;
        uiSessionId = result.uiSessionId;
        break;
      } catch (err: any) {
        retries--;
        if (retries === 0) { releaseLock(); throw err; }
        let d = delay;
        if (err instanceof RetryableQwenStreamError && err.retryAfterMs) d = err.retryAfterMs;
        if (err instanceof QwenUpstreamError && err.upstreamCode === 'RateLimited') {
          rotated = true;
          await resetPlaywrightSession(sessionId).catch(() => {});
          d = 5000;
        }
        const retryable = err instanceof RetryableQwenStreamError || err instanceof QwenUpstreamError
          || err.message?.includes('in progress') || err.message?.includes('Bad_Request') || err.message?.includes('RateLimited');
        if (!retryable) { releaseLock(); throw err; }
        console.warn(`[Chat:${sessionId}] Retry in ${d}ms (${retries} left)`);
        await new Promise(r => setTimeout(r, d));
        delay = Math.min(delay * 2, 30000);
      }
    }

    const completionId = 'chatcmpl-' + uuidv4();

    // ── Non-streaming ─────────────────────────────────────────────
    if (!isStream) {
      const reader = stream!.getReader();
      const decoder = new TextDecoder();
      let reasoningBuffer = '', lastFullContent = '', targetResponseId: string | null = null, currentThoughtIndex = 0;
      const toolParser = new StreamingToolParser(bodyAny.tools || []);
      const toolCallsOut: any[] = [];
      let buffer = '', completionTokens = 0, promptTokens = Math.ceil(finalPrompt.length / 3.5);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed?.startsWith('data: ')) continue;
          const dataStr = trimmed.slice(6);
          if (dataStr === '[DONE]') continue;
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
            const delta = chunk.choices?.[0]?.delta;
            if (delta && (targetResponseId === null || chunk.response_id === targetResponseId)) {
              if (delta.phase === 'thinking_summary') {
                const thoughts = delta.extra?.summary_thought?.content;
                if (thoughts?.length > currentThoughtIndex) {
                  reasoningBuffer += thoughts.slice(currentThoughtIndex).join('\\n');
                  currentThoughtIndex = thoughts.length;
                }
              } else if (delta.content !== undefined) {
                // Process ALL non-thinking content (includes 'answer' phase and no-phase chunks)
                const result = getIncrementalDelta(lastFullContent, delta.content || '');
                if (result.delta) {
                  lastFullContent = result.matchedContent;
                  const { text, toolCalls } = toolParser.feed(result.delta);
                  for (const tc of toolCalls) {
                    toolCallsOut.push({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } });
                  }
                }
              }
            }
          } catch {}
        }
      }

      const upstreamErr = parseQwenErrorPayload(buffer);
      if (upstreamErr) { releaseLock(); return c.json({ error: { message: upstreamErr.message } }, upstreamErr.status as any); }

      const flushed = toolParser.flush();
      if (flushed.text) lastFullContent += flushed.text;
      for (const tc of flushed.toolCalls) {
        toolCallsOut.push({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } });
      }

      const message: any = { role: 'assistant', content: toolCallsOut.length ? null : lastFullContent };
      if (reasoningBuffer) message.reasoning_content = reasoningBuffer;
      if (toolCallsOut.length) { toolCallsOut.forEach((tc: any, i: number) => tc.index = i); message.tool_calls = toolCallsOut; }

      releaseLock();
      c.header('X-Session-Id', sessionId);
      if (rotated) c.header('X-Account-Rotated', 'true');
      return c.json({
        id: completionId, object: 'chat.completion', created: Math.floor(Date.now() / 1000),
        model: body.model, choices: [{ index: 0, message, logprobs: null, finish_reason: toolCallsOut.length ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens, prompt_tokens_details: { cached_tokens: 0 } },
      });
    }

    // ── Streaming ─────────────────────────────────────────────────
    c.header('Content-Type', 'text/event-stream');
    c.header('Cache-Control', 'no-cache');
    c.header('Connection', 'keep-alive');
    c.header('X-Session-Id', sessionId);
    if (rotated) c.header('X-Account-Rotated', 'true');

    return honoStream(c, async (writer: any) => {
      let heartbeat: any;
      try {
        await writer.write(': heartbeat\n\n');
        heartbeat = setInterval(async () => { try { await writer.write(': keep-alive\n\n'); } catch { clearInterval(heartbeat); } }, 15000);

        const writeEvent = async (data: any) => { await writer.write(`data: ${JSON.stringify(data)}\n\n`); };
        const makeChoice = (delta: any, finish: string | null = null) => ({ index: 0, delta, logprobs: null, finish_reason: finish });

        await writeEvent({ id: completionId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model, choices: [makeChoice({ role: 'assistant', content: '' })] });

        const reader = stream.getReader();
        const decoder = new TextDecoder();
        let reasoningBuffer = '', lastFullContent = '', targetResponseId: string | null = null, currentThoughtIndex = 0;
        const toolParser = new StreamingToolParser(bodyAny.tools || []);
        let buffer = '', completionTokens = 0, promptTokens = Math.ceil(finalPrompt.length / 3.5);

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed?.startsWith('data: ')) continue;
            const dataStr = trimmed.slice(6);
            if (dataStr === '[DONE]') { await writer.write('data: [DONE]\n\n'); continue; }
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
              const delta = chunk.choices?.[0]?.delta;
              if (delta && (targetResponseId === null || chunk.response_id === targetResponseId)) {
                if (delta.phase === 'thinking_summary') {
                  const thoughts = delta.extra?.summary_thought?.content;
                  if (thoughts?.length > currentThoughtIndex) {
                    const t = thoughts.slice(currentThoughtIndex).join('\n');
                    currentThoughtIndex = thoughts.length;
                    reasoningBuffer += t;
                    await writeEvent({ id: completionId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model, choices: [makeChoice({ reasoning_content: t })] });
                  }
                } else if (delta.content !== undefined) {
                  const result = getIncrementalDelta(lastFullContent, delta.content || '');
                  if (result.delta) {
                    lastFullContent = result.matchedContent;
                    const { text, toolCalls } = toolParser.feed(result.delta);
                    if (text) await writeEvent({ id: completionId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model, choices: [makeChoice({ content: text })] });
                    for (const tc of toolCalls) {
                      await writeEvent({ id: completionId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model, choices: [makeChoice({ tool_calls: [{ index: 0, id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } }] })] });
                    }
                  }
                }
              }
            } catch {}
          }
        }
      } finally {
        clearInterval(heartbeat);
        releaseLock();
      }
    });
  } catch (e: any) {
    return c.json({ error: { message: e.message } }, 500);
  }
}

// ── Session endpoints ───────────────────────────────────────────────

export async function sessionInfo(c: Context) {
  const sid = c.req.query('id') || 'main';
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
  const sid = c.req.query('id') || 'main';
  setActiveChatId(null, sid);
  return c.json({ ok: true, sessionId: sid });
}

export async function sessionDelete(c: Context) {
  const sid = c.req.query('id') || '';
  if (!sid || sid === 'main') return c.json({ ok: false, error: 'Cannot delete main session. Use reset instead.' }, 400);
  const ok = deleteSession(sid);
  return c.json({ ok, sessionId: sid });
}

export async function sessionFork(c: Context) {
  // Fork: create a new session, run completion, return result, then delete the session
  const sid = `subagent-${uuidv4().substring(0, 8)}`;
  
  // Set header internally and delegate to chatCompletions
  c.req.raw.headers.set('X-Session-Id', sid);
  c.req.raw.headers.set('X-New-Session', 'true');
  
  return chatCompletions(c);
}
