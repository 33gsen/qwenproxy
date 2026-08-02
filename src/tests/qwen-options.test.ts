import test from 'node:test';
import assert from 'node:assert/strict';

process.env.TEST_MOCK_PLAYWRIGHT = 'true';
process.env.API_KEY = '';

import { app } from '../index.ts';

function qwenDoneStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'));
      controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
}

test('chat forwards supported OpenAI sampling controls to Qwen', async () => {
  const originalFetch = globalThis.fetch;
  let capturedPayload: Record<string, unknown> | undefined;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/api/v2/chat/completions')) {
      capturedPayload = JSON.parse(String(init?.body));
      return new Response(qwenDoneStream(), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return originalFetch(input, init);
  };

  try {
    const response = await app.fetch(new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Session-Id': 'qwen-options-test' },
      body: JSON.stringify({
        model: 'qwen3.8-max-preview',
        messages: [{ role: 'user', content: 'test' }],
        stream: true,
        stream_options: { include_usage: false },
        temperature: 0.4,
        top_p: 0.8,
        stop: ['END'],
        presence_penalty: 0.2,
        frequency_penalty: 0.3,
        seed: 7,
        user: 'options-test',
      }),
    }));

    assert.equal(response.status, 200);
    const responseText = await response.text();
    assert.equal(responseText.includes('"usage"'), false);
    assert.deepEqual(
      Object.fromEntries(Object.entries(capturedPayload || {}).filter(([key]) => [
        'temperature', 'top_p', 'stop', 'presence_penalty', 'frequency_penalty', 'seed', 'user',
      ].includes(key))),
      {
        temperature: 0.4,
        top_p: 0.8,
        stop: ['END'],
        presence_penalty: 0.2,
        frequency_penalty: 0.3,
        seed: 7,
        user: 'options-test',
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('chat rejects an oversized declared body before JSON parsing', async () => {
  const response = await app.fetch(new Request('http://localhost/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': '8000001' },
    body: '{not-json',
  }));

  assert.equal(response.status, 413);
  const payload = await response.json();
  assert.equal(payload.error.code, 'invalid_request_error');
});
