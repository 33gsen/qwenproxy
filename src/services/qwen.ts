/*
 * qwen.ts — API calls diretas com cookie de sessão
 * Suporte a múltiplas sessões isoladas (main agent + subagents).
 */

import { getCookies, getUserAgent, getActiveChatId, setActiveChatId, getActiveParentId, setActiveParentId, rotateAccount, getActiveAccountEmail } from './playwright.ts';
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

// ─── Session tracking ───────────────────────────────────────────────

export function updateSessionParent(sessionId: string | undefined, parentId: string | null, sid?: string) {
  if (parentId) setActiveParentId(parentId, sid);
  if (sessionId && !getActiveChatId(sid)) setActiveChatId(sessionId, sid);
}

// ─── Models ─────────────────────────────────────────────────────────

let cachedModels: any[] | null = null;
let lastModelsFetch = 0;

export async function fetchQwenModels(): Promise<any[]> {
  const now = Date.now();
  if (cachedModels && (now - lastModelsFetch < 3600000)) return cachedModels;
  const cookie = await getCookies();
  const ua = await getUserAgent();
  const tz = new Date().toString().split(' (')[0];
  const res = await fetch('https://chat.qwen.ai/api/models', {
    headers: { 'accept': 'application/json', 'cookie': cookie, 'user-agent': ua, 'x-request-id': uuidv4(), 'timezone': tz, 'source': 'web' },
  });
  if (!res.ok) throw new Error(`Models fetch failed: ${res.status}`);
  const json = await res.json();
  if (json.data) {
    const models = json.data.map((m: any) => ({ id: m.id, object: 'model', created: m.info?.created_at || Math.floor(Date.now()/1000), owned_by: m.owned_by || 'qwen' }));
    const ext = [...models];
    for (const m of models) ext.push({ ...m, id: `${m.id}-no-thinking` });
    cachedModels = ext; lastModelsFetch = now;
    return ext;
  }
  return [];
}

// ─── Chat creation ──────────────────────────────────────────────────

async function createChat(sessionId?: string): Promise<string> {
  const { activePage } = await import('./playwright.ts');
  if (activePage && !activePage.isClosed()) {
    const title = sessionId && sessionId !== 'main' ? `Subagent ${sessionId}` : 'Agent Chat';
    const result = await activePage.evaluate(async (title: string) => {
      const r = await fetch('https://chat.qwen.ai/api/v2/chats/new', {
        method: 'POST',
        headers: { 'accept': 'application/json', 'content-type': 'application/json', 'source': 'web', 'timezone': new Date().toString().split(' (')[0], 'x-request-id': window.crypto.randomUUID() },
        body: JSON.stringify({ title, models: ['qwen3.7-plus'], chat_mode: 'normal', chat_type: 't2t', timestamp: Date.now(), project_id: '' }),
      });
      const t = await r.text();
      try { const d = JSON.parse(t); return { ok: r.ok, id: d.data?.id || d.id || d.chat_id, body: t.substring(0, 200) }; }
      catch { return { ok: false, body: t.substring(0, 200) }; }
    });
    if (result.ok && result.id) { setActiveChatId(result.id, sessionId); return result.id; }
    throw new Error(`Chat creation failed: ${result.body || 'unknown'}`);
  }

  // Fallback HTTP
  const cookie = await getCookies(); const ua = await getUserAgent(); const tz = new Date().toString().split(' (')[0];
  const r = await fetch('https://chat.qwen.ai/api/v2/chats/new', {
    method: 'POST',
    headers: { 'accept': 'application/json', 'content-type': 'application/json', 'cookie': cookie, 'origin': 'https://chat.qwen.ai', 'referer': 'https://chat.qwen.ai/', 'user-agent': ua, 'x-request-id': uuidv4(), 'source': 'web', 'timezone': tz },
    body: JSON.stringify({ title: 'Agent Chat', models: ['qwen3.7-plus'], chat_mode: 'normal', chat_type: 't2t', timestamp: Date.now(), project_id: '' }),
  });
  if (!r.ok) { const e = await r.text().catch(() => '');
    // Rate limit on chat creation — rotate account
    if (e.toLowerCase().includes('ratelimit') || e.toLowerCase().includes('rate limit') || e.toLowerCase().includes('upper limit')) {
      console.warn('[Qwen] Rate limited on chat creation. Rotating...');
      if (await rotateAccount()) {
        setActiveChatId(null, sessionId);
        throw new RetryableQwenStreamError('Rate limited on chat creation — account rotated. Retry.', 1000);
      }
    }
    throw new Error(`Chat creation failed: ${r.status} ${e.substring(0, 200)}`);
  }
  const d = await r.json();
  const id = d.data?.id || d.id || d.chat_id;
  if (!id) throw new Error('No chat_id');
  setActiveChatId(id, sessionId);
  return id;
}

// ─── Completions ────────────────────────────────────────────────────

export async function createQwenStream(
  prompt: string,
  enableThinking: boolean,
  modelId: string,
  forcedParentId?: string | null,
  sessionId?: string,
): Promise<{ stream: ReadableStream; headers: Record<string, string>; uiSessionId: string }> {
  const cookie = await getCookies();
  const ua = await getUserAgent();

  let chatId = getActiveChatId(sessionId);
  if (!chatId || forcedParentId === null) {
    chatId = await createChat(sessionId);
  }

  let actualParentId = getActiveParentId(sessionId);
  if (forcedParentId !== undefined) actualParentId = forcedParentId;

  const model = modelId.replace('-no-thinking', '').replace('-thinking', '');
  const ts = Math.floor(Date.now() / 1000);
  const fid = uuidv4();

  const payload = {
    stream: true, version: '2.1', incremental_output: true,
    chat_id: chatId, chat_mode: 'normal', model, parent_id: actualParentId,
    messages: [{
      fid, parentId: actualParentId, childrenIds: [], role: 'user', content: prompt,
      user_action: 'chat', files: [], timestamp: ts, models: [model], chat_type: 't2t',
      feature_config: { thinking_enabled: enableThinking, output_schema: 'phase', research_mode: 'normal', auto_thinking: false, thinking_mode: 'Thinking', thinking_format: 'summary', auto_search: false },
      extra: { meta: { subChatType: 't2t' } }, sub_chat_type: 't2t', parent_id: actualParentId,
    }],
    timestamp: ts + 1,
  };

  const tz = new Date().toString().split(' (')[0];
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), 120000);

  const response = await fetch(`https://chat.qwen.ai/api/v2/chat/completions?chat_id=${chatId}`, {
    method: 'POST',
    headers: { 'accept': 'application/json', 'content-type': 'application/json', 'cookie': cookie, 'origin': 'https://chat.qwen.ai', 'referer': `https://chat.qwen.ai/c/${chatId}`, 'user-agent': ua, 'x-accel-buffering': 'no', 'x-request-id': uuidv4(), 'source': 'web', 'timezone': tz, 'version': '0.2.80' },
    body: JSON.stringify(payload),
    signal: controller.signal,
  });
  clearTimeout(tid);

  if (!response.ok || !response.body) {
    const errText = await response.text().catch(() => '');
    // Detect rate limit in any response (JSON or not)
    if (errText.toLowerCase().includes('ratelimit') || errText.toLowerCase().includes('rate limit') || errText.toLowerCase().includes('upper limit')) {
      console.warn('[Qwen] Rate limited! Rotating account...');
      if (await rotateAccount()) {
        // Clear all session chat_ids — they belong to the old account
        setActiveChatId(null, sessionId);
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
            if (await rotateAccount()) {
              setActiveChatId(null, sessionId);
              throw new RetryableQwenStreamError('Rate limited — account rotated. Retry.', 1000);
            }
          }
          throw new QwenUpstreamError(`Qwen: ${code}: ${details}`, code, code === 'RateLimited' ? 429 : 502);
        }
      } catch (e) { if (e instanceof RetryableQwenStreamError || e instanceof QwenUpstreamError) throw e; }
    }
    throw new Error(`Qwen API error: ${response.status} ${errText.substring(0, 200)}`);
  }

  return { stream: response.body, headers: { cookie, 'user-agent': ua }, uiSessionId: chatId };
}
