import test from 'node:test';
import assert from 'node:assert/strict';

process.env.TEST_MOCK_PLAYWRIGHT = 'true';
process.env.API_KEY = '';

import { app } from '../index.ts';

function sse(body: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { phase: 'answer', content: body } }] })}\n\n`));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

test('chat recovery invalidates a stale upstream chat and retries with a new chat', async () => {
  const originalFetch = globalThis.fetch;
  let completionCalls = 0;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/api/v2/chat/completions')) {
      completionCalls++;
      if (completionCalls === 1) {
        return new Response(JSON.stringify({ success: false, data: { code: 'CHAT_NOT_FOUND', details: 'stale chat' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return sse('recovered');
    }
    return originalFetch(input, init);
  };

  try {
    const response = await app.fetch(new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Session-Id': 'session-recovery-test' },
      body: JSON.stringify({
        model: 'qwen3.8-max-preview',
        messages: [{ role: 'user', content: 'recover this session' }],
        stream: false,
      }),
    }));

    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.equal(body.choices[0].message.content, 'recovered');
    assert.equal(completionCalls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
