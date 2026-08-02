/*
 * qwen.ts — API calls diretas com cookie de sessão
 * Suporte a múltiplas sessões isoladas (main agent + subagents).
 */

import { acquireAccountStateLock, getCookies, getUserAgent, getActiveChatId, setActiveChatId, getActiveParentId, setActiveParentId, rotateAccount, clearAllSessionChats, getActiveAccountEmail, activePage } from './playwright.ts';
import { v4 as uuidv4 } from 'uuid';

export class RetryableQwenStreamError extends Error {
  readonly retryAfterMs: number;
  constructor(message: string, retryAfterMs: number) {
    super(message); this.name = 'RetryableQwenStreamError'; this.retryAfterMs = retryAfterMs;
  }
}

export class QwenUpstreamError extends Error {
  readonly upstreamCode: string; readonly upstreamStatus: number;
  constructor(message: string, upstreamCode: string, upstreamStatus: number) {
    super(message); this.name = 'QwenUpstreamError'; this.upstreamCode = upstreamCode; this.upstreamStatus = upstreamStatus;
  }
}

const QWEN_SETUP_TIMEOUT_MS = 30000;

function abortReason(signal?: AbortSignal): unknown {
  return signal?.reason || new DOMException('The operation was aborted.', 'AbortError');
}

function withAbortDeadline<T>(operation: Promise<T>, signal: AbortSignal | undefined, timeoutMs: number, onAbort: () => void): Promise<T> {
  if (signal?.aborted) {
    onAbort();
    return Promise.reject(abortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    };
    const finish = (success: boolean, value: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (success) resolve(value as T);
      else reject(value);
    };
    const abort = () => {
      onAbort();
      finish(false, abortReason(signal));
    };
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => {
      onAbort();
      finish(false, new Error(`Qwen setup operation timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    operation.then(value => finish(true, value), error => finish(false, error));
  });
}

interface FetchHandle { response: Response; abort: () => void; }

async function fetchWithDeadline(input: string, init: RequestInit, signal: AbortSignal | undefined, timeoutMs: number): Promise<FetchHandle> {
  const controller = new AbortController();
  const response = await withAbortDeadline(
    fetch(input, { ...init, signal: controller.signal }),
    signal,
    timeoutMs,
    () => controller.abort(abortReason(signal)),
  );
  return { response, abort: () => controller.abort(abortReason(signal)) };
}

function cancelResponseBody(response: Response): void {
  try { void response.body?.cancel().catch(() => undefined); } catch {}
}

async function readResponseText(
  response: Response,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  abort: () => void,
): Promise<string> {
  if (signal?.aborted) {
    abort();
    cancelResponseBody(response);
    throw abortReason(signal);
  }
  return withAbortDeadline(response.text(), signal, timeoutMs, () => {
    abort();
    cancelResponseBody(response);
  });
}

function interruptPage(page: { close: () => Promise<unknown> } | null | undefined): void {
  try { void page?.close().catch(() => undefined); } catch {}
}

// ─── Session tracking ───────────────────────────────────────────────

export function updateSessionParent(sessionId: string | undefined, parentId: string | null, sid?: string) {
  if (parentId) setActiveParentId(parentId, sid);
  if (sessionId && !getActiveChatId(sid)) setActiveChatId(sessionId, sid);
}

// ─── Models ─────────────────────────────────────────────────────────

export function normalizeQwenModelId(modelId: string): string {
  const normalized = modelId.replace(/-(?:no-thinking|thinking)$/g, '').trim();
  return normalized || 'qwen3.8-max-preview';
}

let cachedModels: any[] | null = null;
let lastModelsFetch = 0;

export async function fetchQwenModels(signal?: AbortSignal): Promise<any[]> {
  const now = Date.now();
  if (cachedModels && (now - lastModelsFetch < 3600000)) return cachedModels;
  const release = await acquireAccountStateLock(signal);
  try {
    const cookie = await withAbortDeadline(getCookies(), signal, QWEN_SETUP_TIMEOUT_MS, () => interruptPage(activePage));
    const ua = await withAbortDeadline(getUserAgent(), signal, QWEN_SETUP_TIMEOUT_MS, () => interruptPage(activePage));
    const tz = new Date().toString().split(' (')[0];
    const fetched = await fetchWithDeadline('https://chat.qwen.ai/api/models', {
      headers: { 'accept': 'application/json', 'cookie': cookie, 'user-agent': ua, 'x-request-id': uuidv4(), 'timezone': tz, 'source': 'web' },
    }, signal, QWEN_SETUP_TIMEOUT_MS);
    const res = fetched.response;
    if (!res.ok) throw new Error(`Models fetch failed: ${res.status}`);
    const json = JSON.parse(await readResponseText(res, signal, QWEN_SETUP_TIMEOUT_MS, fetched.abort));
    if (json.data) {
      const models = json.data.map((m: any) => ({ id: m.id, object: 'model', created: m.info?.created_at || Math.floor(Date.now()/1000), owned_by: m.owned_by || 'qwen' }));
      const ext = [...models];
      for (const m of models) ext.push({ ...m, id: `${m.id}-no-thinking` });
      cachedModels = ext; lastModelsFetch = now;
      return ext;
    }
    return [];
  } finally {
    release();
  }
}

// ─── Chat creation ──────────────────────────────────────────────────

async function createChat(sessionId?: string, modelId = 'qwen3.8-max-preview', signal?: AbortSignal): Promise<string> {
  const model = normalizeQwenModelId(modelId);
  if (process.env.TEST_MOCK_PLAYWRIGHT === 'true') {
    const id = `mock-chat-${sessionId || 'main'}`;
    setActiveChatId(id, sessionId);
    return id;
  }

  const { activePage } = await import('./playwright.ts');
  if (activePage && !activePage.isClosed()) {
    const title = sessionId && sessionId !== 'main' ? `Subagent ${sessionId}` : 'Agent Chat';
    const result = await withAbortDeadline(activePage.evaluate(async (params: any) => {
      const { title, model, timeoutMs } = params;
      const requestController = new AbortController();
      const timer = setTimeout(() => requestController.abort(), timeoutMs);
      try {
        const r = await fetch('https://chat.qwen.ai/api/v2/chats/new', {
          method: 'POST',
          headers: { 'accept': 'application/json', 'content-type': 'application/json', 'source': 'web', 'timezone': new Date().toString().split(' (')[0], 'x-request-id': window.crypto.randomUUID() },
          body: JSON.stringify({ title, models: [model], chat_mode: 'normal', chat_type: 't2t', timestamp: Date.now(), project_id: '' }),
          signal: requestController.signal,
        });
        const t = await r.text();
        try { const d = JSON.parse(t); return { ok: r.ok, id: d.data?.id || d.id || d.chat_id, body: t.substring(0, 200) }; }
        catch { return { ok: false, body: t.substring(0, 200) }; }
      } finally {
        clearTimeout(timer);
      }
    }, { title, model, timeoutMs: QWEN_SETUP_TIMEOUT_MS }), signal, QWEN_SETUP_TIMEOUT_MS, () => interruptPage(activePage));
    if (result.ok && result.id) { setActiveChatId(result.id, sessionId); return result.id; }
    console.log('[Qwen] Chat creation browser result:', JSON.stringify({ ok: result.ok, hasId: !!result.id, body: result.body?.substring(0, 150) }));
    if (result.body && (result.body.toLowerCase().includes('ratelimit') || result.body.toLowerCase().includes('rate limit') || result.body.toLowerCase().includes('upper limit'))) {
      console.log('[Qwen] Rate limited on chat creation (browser). Rotating...');
      if (await rotateAccount(true, signal)) {
        clearAllSessionChats();
        throw new RetryableQwenStreamError('Rate limited on chat creation — account rotated. Retry.', 1000);
      }
    }
    throw new Error(`Chat creation failed: ${result.body || 'unknown'}`);
  }

  // Fallback HTTP
  const cookie = await withAbortDeadline(getCookies(), signal, QWEN_SETUP_TIMEOUT_MS, () => interruptPage(activePage));
  const ua = await withAbortDeadline(getUserAgent(), signal, QWEN_SETUP_TIMEOUT_MS, () => interruptPage(activePage)); const tz = new Date().toString().split(' (')[0];
  const fetched = await fetchWithDeadline('https://chat.qwen.ai/api/v2/chats/new', {
    method: 'POST',
    headers: { 'accept': 'application/json', 'content-type': 'application/json', 'cookie': cookie, 'origin': 'https://chat.qwen.ai', 'referer': 'https://chat.qwen.ai/', 'user-agent': ua, 'x-request-id': uuidv4(), 'source': 'web', 'timezone': tz },
    body: JSON.stringify({ title: 'Agent Chat', models: [model], chat_mode: 'normal', chat_type: 't2t', timestamp: Date.now(), project_id: '' }),
  }, signal, QWEN_SETUP_TIMEOUT_MS);
  const r = fetched.response;
  if (!r.ok) { const e = await readResponseText(r, signal, QWEN_SETUP_TIMEOUT_MS, fetched.abort).catch(() => '');
    // Rate limit on chat creation — rotate account
    if (e.toLowerCase().includes('ratelimit') || e.toLowerCase().includes('rate limit') || e.toLowerCase().includes('upper limit')) {
      console.warn('[Qwen] Rate limited on chat creation. Rotating...');
      if (await rotateAccount(true, signal)) {
        clearAllSessionChats();
        throw new RetryableQwenStreamError('Rate limited on chat creation — account rotated. Retry.', 1000);
      }
    }
    throw new Error(`Chat creation failed: ${r.status} ${e.substring(0, 200)}`);
  }
  const d = JSON.parse(await readResponseText(r, signal, QWEN_SETUP_TIMEOUT_MS, fetched.abort));
  const id = d.data?.id || d.id || d.chat_id;
  if (!id) throw new Error('No chat_id');
  setActiveChatId(id, sessionId);
  return id;
}

// ─── Completions ────────────────────────────────────────────────────

const QWEN_STREAM_TIMEOUT_MS = 600000;

export interface QwenRequestOptions {
  temperature?: number;
  top_p?: number;
  stop?: string | string[] | null;
  presence_penalty?: number;
  frequency_penalty?: number;
  seed?: number;
  user?: string;
}

export function wrapQwenResponseStream(
  body: ReadableStream<Uint8Array>,
  controller: AbortController,
  clientSignal?: AbortSignal,
  timeoutMs = QWEN_STREAM_TIMEOUT_MS,
  onSettled?: () => void,
): ReadableStream<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener = () => {};
  let settledCallbackCalled = false;

  const settleCallback = () => {
    if (settledCallbackCalled) return;
    settledCallbackCalled = true;
    onSettled?.();
  };

  const releaseReader = () => {
    try { reader?.releaseLock(); } catch {}
  };

  return new ReadableStream<Uint8Array>({
    start(target) {
      reader = body.getReader();
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        removeAbortListener();
      };
      const fail = (reason: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        target.error(reason);
        const cancellation = reader?.cancel(reason);
        if (cancellation) {
          void cancellation.catch(() => undefined).finally(() => {
            releaseReader();
            settleCallback();
          });
        } else {
          releaseReader();
          settleCallback();
        }
      };
      const finish = () => {
        if (settled) return;
        settled = true;
        cleanup();
        releaseReader();
        settleCallback();
        target.close();
      };
      const abort = () => {
        const reason = clientSignal?.reason || new DOMException('The operation was aborted.', 'AbortError');
        try { controller.abort(reason); } catch {}
        fail(reason);
      };

      removeAbortListener = () => clientSignal?.removeEventListener('abort', abort) || undefined;
      if (clientSignal?.aborted) {
        abort();
        return;
      }
      clientSignal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => {
        const reason = new Error(`Qwen upstream stream timed out after ${timeoutMs}ms`);
        try { controller.abort(reason); } catch {}
        fail(reason);
      }, timeoutMs);

      const pump = async () => {
        try {
          while (true) {
            const { done, value } = await reader!.read();
            if (done) return finish();
            if (value) target.enqueue(value);
          }
        } catch (error) {
          fail(error);
        }
      };
      void pump();
    },
    cancel(reason) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      removeAbortListener();
      try { controller.abort(reason); } catch {}
      const cancellation = reader?.cancel(reason);
      if (cancellation) return cancellation.catch(() => undefined).finally(() => {
        releaseReader();
        settleCallback();
      });
      releaseReader();
      settleCallback();
    },
  });
}

async function createQwenStreamUnlocked(
  prompt: string,
  enableThinking: boolean,
  modelId: string,
  forcedParentId?: string | null,
  sessionId?: string,
  maxTokens?: number,
  signal?: AbortSignal,
  options?: QwenRequestOptions,
  releaseAccountLock?: () => void,
): Promise<{ stream: ReadableStream; headers: Record<string, string>; uiSessionId: string }> {
  const cookie = await withAbortDeadline(getCookies(), signal, QWEN_SETUP_TIMEOUT_MS, () => interruptPage(activePage));
  const ua = await withAbortDeadline(getUserAgent(), signal, QWEN_SETUP_TIMEOUT_MS, () => interruptPage(activePage));
  const model = normalizeQwenModelId(modelId);

  let chatId = getActiveChatId(sessionId);
  if (!chatId || forcedParentId === null) {
    chatId = await createChat(sessionId, model, signal);
  }

  let actualParentId = getActiveParentId(sessionId);
  if (forcedParentId !== undefined) actualParentId = forcedParentId;

  const ts = Math.floor(Date.now() / 1000);
  const fid = uuidv4();

  const payload: any = {
    stream: true, version: '2.1', incremental_output: true,
    chat_id: chatId, chat_mode: 'normal', model, parent_id: actualParentId,
    messages: [{
      fid, parentId: actualParentId, childrenIds: [], role: 'user', content: prompt,
      user_action: 'chat', files: [], timestamp: ts, models: [model], chat_type: 't2t',
      feature_config: { thinking_enabled: enableThinking, output_schema: 'phase', research_mode: 'normal', auto_thinking: false, thinking_mode: 'Thinking', thinking_format: enableThinking ? 'full' : 'summary', auto_search: false },
      extra: { meta: { subChatType: 't2t' } }, sub_chat_type: 't2t', parent_id: actualParentId,
    }],
    timestamp: ts + 1,
  };
  if (maxTokens) payload.max_tokens = maxTokens;
  if (options) Object.assign(payload, options);
  console.log('[Qwen] Payload max_tokens:', payload.max_tokens, '| prompt_len:', prompt.length);

  const tz = new Date().toString().split(' (')[0];
  const controller = new AbortController();

  let response: Response;
  response = await withAbortDeadline(fetch(`https://chat.qwen.ai/api/v2/chat/completions?chat_id=${chatId}`, {
    method: 'POST',
    headers: { 'accept': 'application/json', 'content-type': 'application/json', 'cookie': cookie, 'origin': 'https://chat.qwen.ai', 'referer': `https://chat.qwen.ai/c/${chatId}`, 'user-agent': ua, 'x-accel-buffering': 'no', 'x-request-id': uuidv4(), 'source': 'web', 'timezone': tz, 'version': '0.2.80' },
    body: JSON.stringify(payload),
    signal: controller.signal,
  }), signal, QWEN_STREAM_TIMEOUT_MS, () => {
    try { controller.abort(abortReason(signal)); } catch {}
  });

  const contentType = response.headers.get('content-type') || '';
  if (response.ok && contentType.includes('application/json')) {
    const errText = await readResponseText(response, signal, QWEN_STREAM_TIMEOUT_MS, () => controller.abort(abortReason(signal))).catch(() => '');
    let payload: any;
    try { payload = JSON.parse(errText); } catch { payload = null; }
    if (payload?.success === false) {
      const code = payload.data?.code || 'UpstreamError';
      const details = payload.data?.details || payload.message || '';
      if (code === 'RateLimited' && await rotateAccount(true, signal)) {
        clearAllSessionChats();
        throw new RetryableQwenStreamError('Rate limited — account rotated. Retry.', 1000);
      }
      throw new QwenUpstreamError(`Qwen upstream error: ${code}: ${details}`, code, code === 'RateLimited' ? 429 : 502);
    }
    throw new QwenUpstreamError('Qwen upstream error: InvalidResponse: expected an SSE stream', 'InvalidResponse', 502);
  }

  if (response.ok && !contentType.includes('text/event-stream')) {
    await readResponseText(response, signal, QWEN_STREAM_TIMEOUT_MS, () => controller.abort(abortReason(signal))).catch(() => '');
    throw new QwenUpstreamError('Qwen upstream error: InvalidResponse: expected an SSE stream', 'InvalidResponse', 502);
  }

  if (!response.ok || !response.body) {
    const errText = await readResponseText(response, signal, QWEN_STREAM_TIMEOUT_MS, () => controller.abort(abortReason(signal))).catch(() => '');
    // Detect rate limit in any response (JSON or not)
    if (errText.toLowerCase().includes('ratelimit') || errText.toLowerCase().includes('rate limit') || errText.toLowerCase().includes('upper limit')) {
      console.warn('[Qwen] Rate limited! Rotating account...');
      if (await rotateAccount(true, signal)) {
        // Clear all session chat_ids — they belong to the old account
        clearAllSessionChats();
        throw new RetryableQwenStreamError('Rate limited — account rotated. Retry.', 1000);
      }
    }
    const ct = response.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      try {
        const err = JSON.parse(errText);
        const details = err.data?.details || '';
        if (details.includes('chat is in progress') || details.includes('in progress'))
          throw new RetryableQwenStreamError(`Qwen: ${details}`, 2000 + Math.floor(Math.random() * 2000));
        if (err.success === false) {
          const code = err.data?.code || 'UpstreamError';
          if (code === 'RateLimited') {
            console.warn('[Qwen] Rate limited! Rotating account...');
            if (await rotateAccount(true, signal)) {
              clearAllSessionChats();
              throw new RetryableQwenStreamError('Rate limited — account rotated. Retry.', 1000);
            }
          }
          throw new QwenUpstreamError(`Qwen upstream error: ${code}: ${details}`, code, code === 'RateLimited' ? 429 : 502);
        }
      } catch (e) { if (e instanceof RetryableQwenStreamError || e instanceof QwenUpstreamError) throw e; }
    }
    throw new Error(`Qwen API error: ${response.status} ${errText.substring(0, 200)}`);
  }

  return { stream: wrapQwenResponseStream(response.body, controller, signal, QWEN_STREAM_TIMEOUT_MS, releaseAccountLock), headers: { cookie, 'user-agent': ua }, uiSessionId: chatId };
}

export async function createQwenStream(
  prompt: string,
  enableThinking: boolean,
  modelId: string,
  forcedParentId?: string | null,
  sessionId?: string,
  maxTokens?: number,
  signal?: AbortSignal,
  options?: QwenRequestOptions,
): Promise<{ stream: ReadableStream; headers: Record<string, string>; uiSessionId: string }> {
  const release = await acquireAccountStateLock(signal);
  try {
    return await createQwenStreamUnlocked(prompt, enableThinking, modelId, forcedParentId, sessionId, maxTokens, signal, options, release);
  } catch (error) {
    release();
    throw error;
  }
}
