import test from 'node:test';
import assert from 'node:assert/strict';

process.env.TEST_MOCK_PLAYWRIGHT = 'true';
process.env.API_KEY = '';

import { app } from '../index.ts';

function qwenStream(lines: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const line of lines) controller.enqueue(encoder.encode(line));
      controller.close();
    },
  });
}

function sseResponse(stream: ReadableStream<Uint8Array>, init: ResponseInit = {}): Response {
  return new Response(stream, { ...init, headers: { 'content-type': 'text/event-stream', ...(init.headers || {}) } });
}

async function readSSE(response: Response): Promise<any[]> {
  const text = await response.text();
  return text
    .split(/\r?\n\r?\n/)
    .map(block => block.trim())
    .filter(Boolean)
    .map(block => {
      const data = block.split(/\r?\n/).find(line => line.startsWith('data: '))?.slice(6);
      if (!data) return null;
      return data === '[DONE]' ? '[DONE]' : JSON.parse(data);
    })
    .filter(Boolean);
}

test('streaming emits unique tool indices, one DONE, finish reason, and usage', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/api/v2/chat/completions')) {
      return sseResponse(qwenStream([
        'data: {"choices":[{"delta":{"phase":"answer","content":"<tool_call>{\\"name\\":\\"first\\",\\"arguments\\":{}}</tool_call><tool_call>{\\"name\\":\\"second\\",\\"arguments\\":{}}</tool_call>"}}]}\n\n',
        'data: {"usage":{"input_tokens":12,"output_tokens":8}}\n\n',
        'data: [DONE]\n\n',
      ]), { status: 200 });
    }
    return originalFetch(input, init);
  };

  try {
    const response = await app.fetch(new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Session-Id': 'stream-index-test' },
      body: JSON.stringify({
        model: 'qwen3.8-max-preview',
        messages: [{ role: 'user', content: 'call both' }],
        stream: true,
        stream_options: { include_usage: true },
        tools: [
          { type: 'function', function: { name: 'first', parameters: { type: 'object', properties: {} } } },
          { type: 'function', function: { name: 'second', parameters: { type: 'object', properties: {} } } },
        ],
      }),
    }));

    assert.equal(response.status, 200);
    const events = await readSSE(response);
    const toolDeltas = events.flatMap(event => event?.choices?.[0]?.delta?.tool_calls || []);
    const doneEvents = events.filter(event => event === '[DONE]');
    const finish = events.find(event => event?.choices?.[0]?.finish_reason)?.choices?.[0];
    const usage = events.find(event => event?.usage)?.usage;

    assert.deepEqual(toolDeltas.map(call => call.index), [0, 1]);
    assert.equal(doneEvents.length, 1);
    assert.equal(finish.finish_reason, 'tool_calls');
    assert.equal(usage.prompt_tokens, 12);
    assert.equal(usage.completion_tokens, 8);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('chat drops parsed tool calls when the request exposes no tools', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/api/v2/chat/completions')) {
      return sseResponse(qwenStream([
        'data: {"choices":[{"delta":{"phase":"answer","content":"<tool_call>{\\"name\\":\\"ghost\\",\\"arguments\\":{}}</tool_call>"}}]}\n\n',
        'data: [DONE]\n\n',
      ]), { status: 200 });
    }
    return originalFetch(input, init);
  };

  try {
    const response = await app.fetch(new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Session-Id': 'no-tools-filter-test' },
      body: JSON.stringify({ model: 'qwen3.8-max-preview', messages: [{ role: 'user', content: 'do not use tools' }] }),
    }));

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.choices[0].message.tool_calls, undefined);
    assert.equal(body.choices[0].finish_reason, 'stop');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('chat enforces tool_choice none even when Qwen emits a tool call', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/api/v2/chat/completions')) {
      return sseResponse(qwenStream([
        'data: {"choices":[{"delta":{"phase":"answer","content":"<tool_call>{\\"name\\":\\"ghost\\",\\"arguments\\":{}}</tool_call>"}}]}\n\n',
        'data: [DONE]\n\n',
      ]), { status: 200 });
    }
    return originalFetch(input, init);
  };

  try {
    const response = await app.fetch(new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Session-Id': 'tool-choice-none-test' },
      body: JSON.stringify({
        model: 'qwen3.8-max-preview',
        messages: [{ role: 'user', content: 'do not use tools' }],
        tools: [{ type: 'function', function: { name: 'ghost', parameters: { type: 'object', properties: {} } } }],
        tool_choice: 'none',
      }),
    }));

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.choices[0].message.tool_calls, undefined);
    assert.equal(body.choices[0].finish_reason, 'stop');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('chat validates json_schema response output before returning it', async () => {
  const originalFetch = globalThis.fetch;
  let completionCalls = 0;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/api/v2/chat/completions')) {
      completionCalls++;
      const content = completionCalls === 1 ? '{"answer":"ok"}' : '{"unexpected":true}';
      return sseResponse(qwenStream([
        `data: ${JSON.stringify({ choices: [{ delta: { phase: 'answer', content } }] })}\n\n`,
        'data: [DONE]\n\n',
      ]), { status: 200 });
    }
    return originalFetch(input, init);
  };

  const responseFormat = {
    type: 'json_schema',
    json_schema: {
      name: 'answer',
      schema: {
        type: 'object',
        properties: { answer: { type: 'string' } },
        required: ['answer'],
        additionalProperties: false,
      },
    },
  };

  try {
    const request = (sessionId: string) => new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Session-Id': sessionId },
      body: JSON.stringify({ model: 'qwen3.8-max-preview', messages: [{ role: 'user', content: 'return answer json' }], response_format: responseFormat }),
    });
    const valid = await app.fetch(request('json-schema-valid-test'));
    assert.equal(valid.status, 200);
    assert.equal((await valid.json()).choices[0].message.content, '{"answer":"ok"}');

    const invalid = await app.fetch(request('json-schema-invalid-test'));
    assert.equal(invalid.status, 502);
    assert.equal((await invalid.json()).error.code, 'invalid_response_format');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('non-streaming preserves fragmented structured tool calls and accepts response chunks without an id', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/api/v2/chat/completions')) {
      const event = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
      return sseResponse(qwenStream([
        event({ 'response.created': { response_id: 'response-1' } }),
        event({ response_id: 'response-1', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"' } }] } }] }),
        event({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'package.json"}' } }] } }] }),
        event({ response_id: 'other-response', choices: [{ delta: { tool_calls: [{ index: 1, id: 'ignored', type: 'function', function: { name: 'ignored', arguments: '{}' } }] } }] }),
        'data: [DONE]\n\n',
      ]), { status: 200 });
    }
    return originalFetch(input, init);
  };

  try {
    const response = await app.fetch(new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Session-Id': 'structured-non-stream-test' },
      body: JSON.stringify({
        model: 'qwen3.8-max-preview',
        messages: [{ role: 'user', content: 'read package.json' }],
        tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }],
      }),
    }));

    assert.equal(response.status, 200);
    const body = await response.json();
    const toolCall = body.choices[0].message.tool_calls[0];
    assert.equal(toolCall.id, 'call-1');
    assert.equal(toolCall.function.name, 'read_file');
    assert.equal(toolCall.function.arguments, '{"path":"package.json"}');
    assert.equal(body.choices[0].message.tool_calls.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('streaming buffers structured tool-call fragments until the call is complete', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/api/v2/chat/completions')) {
      const event = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
      return sseResponse(qwenStream([
        event({ 'response.created': { response_id: 'response-2' } }),
        event({ response_id: 'response-2', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-2', type: 'function', function: { name: 'read_file', arguments: '{"path":"' } }] } }] }),
        event({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'package.json"}' } }] } }] }),
        'data: [DONE]\n\n',
      ]), { status: 200 });
    }
    return originalFetch(input, init);
  };

  try {
    const response = await app.fetch(new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Session-Id': 'structured-stream-test' },
      body: JSON.stringify({
        model: 'qwen3.8-max-preview',
        messages: [{ role: 'user', content: 'read package.json' }],
        stream: true,
        tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }],
      }),
    }));

    assert.equal(response.status, 200);
    const events = await readSSE(response);
    const toolDeltas = events.flatMap(event => event?.choices?.[0]?.delta?.tool_calls || []);
    assert.deepEqual(toolDeltas.map(call => call.index), [0]);
    assert.equal(toolDeltas[0].function.name, 'read_file');
    assert.equal(toolDeltas[0].function.arguments, '{"path":"package.json"}');
    assert.equal(events.filter(event => event === '[DONE]').length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('streaming emits an error event and DONE when upstream reading fails', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/api/v2/chat/completions')) {
      const encoder = new TextEncoder();
      const event = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
      const failing = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(event({ choices: [{ delta: { content: 'partial' } }] })));
          controller.error(new Error('upstream disconnected'));
        },
      });
      return sseResponse(failing, { status: 200 });
    }
    return originalFetch(input, init);
  };

  try {
    const response = await app.fetch(new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Session-Id': 'stream-error-test' },
      body: JSON.stringify({ model: 'qwen3.8-max-preview', messages: [{ role: 'user', content: 'fail' }], stream: true }),
    }));

    assert.equal(response.status, 200);
    const events = await readSSE(response);
    const error = events.find(event => event?.error?.code === 'qwen_upstream_stream_error');
    assert.match(error?.error?.message || '', /upstream disconnected/i);
    assert.equal(events.filter(event => event === '[DONE]').length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('non-streaming completes after DONE even when the upstream body stays open', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/api/v2/chat/completions')) {
      const encoder = new TextEncoder();
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          // Deliberately leave the body open; the proxy must cancel it after DONE.
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return originalFetch(input, init);
  };

  try {
    const response = await Promise.race([
      app.fetch(new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Session-Id': 'non-stream-done-open-test' },
        body: JSON.stringify({ model: 'qwen3.8-max-preview', messages: [{ role: 'user', content: 'finish' }] }),
      })),
      new Promise<Response>((_, reject) => setTimeout(() => reject(new Error('non-streaming DONE did not complete')), 4000)),
    ]);

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.choices[0].finish_reason, 'stop');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('non-streaming deduplicates the same XML and structured tool call', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/api/v2/chat/completions')) {
      const event = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
      return sseResponse(qwenStream([
        event({ choices: [{ delta: { content: '<tool_call>{"name":"read_file","arguments":{"path":"package.json"}}</tool_call>' } }] }),
        event({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'native-read-file', type: 'function', function: { name: 'read_file', arguments: '{"path":"package.json"}' } }] } }] }),
        'data: [DONE]\n\n',
      ]), { status: 200 });
    }
    return originalFetch(input, init);
  };

  try {
    const response = await app.fetch(new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Session-Id': 'route-dedup-test' },
      body: JSON.stringify({
        model: 'qwen3.8-max-preview',
        messages: [{ role: 'user', content: 'read package.json' }],
        tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }],
      }),
    }));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.choices[0].message.tool_calls.length, 1);
    assert.equal(body.choices[0].message.tool_calls[0].function.name, 'read_file');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('streaming deduplicates the same XML and structured tool call', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/api/v2/chat/completions')) {
      const event = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
      return sseResponse(qwenStream([
        event({ choices: [{ delta: { content: '<tool_call>{"name":"read_file","arguments":{"path":"package.json"}}</tool_call>' } }] }),
        event({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'native-stream-read-file', type: 'function', function: { name: 'read_file', arguments: '{"path":"package.json"}' } }] } }] }),
        'data: [DONE]\n\n',
      ]), { status: 200 });
    }
    return originalFetch(input, init);
  };

  try {
    const response = await app.fetch(new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Session-Id': 'route-stream-dedup-test' },
      body: JSON.stringify({
        model: 'qwen3.8-max-preview',
        messages: [{ role: 'user', content: 'read package.json' }],
        stream: true,
        tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }],
      }),
    }));
    assert.equal(response.status, 200);
    const events = await readSSE(response);
    const toolDeltas = events.flatMap(event => event?.choices?.[0]?.delta?.tool_calls || []);
    assert.equal(toolDeltas.length, 1);
    assert.equal(events.filter(event => event === '[DONE]').length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('chat rejects tool_choice required when Qwen returns no tool call', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/api/v2/chat/completions')) {
      return sseResponse(qwenStream([
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'plain text' } }] })}\n\n`,
        'data: [DONE]\n\n',
      ]), { status: 200 });
    }
    return originalFetch(input, init);
  };

  try {
    const response = await app.fetch(new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Session-Id': 'required-tool-missing-test' },
      body: JSON.stringify({
        model: 'qwen3.8-max-preview',
        messages: [{ role: 'user', content: 'use a tool' }],
        tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }],
        tool_choice: 'required',
      }),
    }));
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error.code, 'required_tool_call_missing');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('chat propagates upstream finish_reason in non-streaming and streaming responses', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/api/v2/chat/completions')) {
      return sseResponse(qwenStream([
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' }, finish_reason: 'length' }] })}\n\n`,
        'data: [DONE]\n\n',
      ]), { status: 200 });
    }
    return originalFetch(input, init);
  };

  try {
    const requestBody = { model: 'qwen3.8-max-preview', messages: [{ role: 'user', content: 'truncate' }] };
    const nonStreaming = await app.fetch(new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Session-Id': 'finish-reason-non-stream-test' },
      body: JSON.stringify(requestBody),
    }));
    assert.equal((await nonStreaming.json()).choices[0].finish_reason, 'length');

    const streaming = await app.fetch(new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Session-Id': 'finish-reason-stream-test' },
      body: JSON.stringify({ ...requestBody, stream: true }),
    }));
    const events = await readSSE(streaming);
    assert.equal(events.find(event => event?.choices?.[0]?.finish_reason)?.choices?.[0]?.finish_reason, 'length');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('streaming buffers fragmented native tool names until the allowlisted name is complete', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/api/v2/chat/completions')) {
      const event = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
      return sseResponse(qwenStream([
        event({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'fragmented-call', type: 'function', function: { name: 'read_', arguments: '{"path":"package.json"}' } }] } }] }),
        event({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'file', arguments: '' } }] } }] }),
        'data: [DONE]\n\n',
      ]), { status: 200 });
    }
    return originalFetch(input, init);
  };

  try {
    const response = await app.fetch(new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Session-Id': 'fragmented-native-name-test' },
      body: JSON.stringify({
        model: 'qwen3.8-max-preview',
        messages: [{ role: 'user', content: 'read package.json' }],
        stream: true,
        tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }],
      }),
    }));
    const events = await readSSE(response);
    const toolDeltas = events.flatMap(event => event?.choices?.[0]?.delta?.tool_calls || []);
    assert.equal(toolDeltas.length, 1);
    assert.equal(toolDeltas[0].function.name, 'read_file');
    assert.equal(toolDeltas[0].function.arguments, '{"path":"package.json"}');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('chat rejects a successful non-SSE HTML upstream response', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/api/v2/chat/completions')) return new Response('<html>login</html>', { status: 200, headers: { 'content-type': 'text/html' } });
    return originalFetch(input, init);
  };
  try {
    const response = await app.fetch(new Request('http://localhost/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3.8-max-preview', messages: [{ role: 'user', content: 'hello' }] }),
    }));
    const body = await response.json();
    assert.equal(response.status, 502);
    assert.equal(body.error.code, 'InvalidResponse');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('chat accepts a tool call with json_object response format and no text content', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/api/v2/chat/completions')) {
      return sseResponse(qwenStream([
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'format-tool', type: 'function', function: { name: 'read_file', arguments: '{"path":"package.json"}' } }] } }] })}\n\n`,
        'data: [DONE]\n\n',
      ]), { status: 200 });
    }
    return originalFetch(input, init);
  };
  try {
    const response = await app.fetch(new Request('http://localhost/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.8-max-preview', messages: [{ role: 'user', content: 'read package.json' }],
        response_format: { type: 'json_object' },
        tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }],
      }),
    }));
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.choices[0].finish_reason, 'tool_calls');
    assert.equal(body.choices[0].message.content, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('tool_choice none removes provider tool markup from non-streaming content', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/api/v2/chat/completions')) {
      return sseResponse(qwenStream([
        `data: ${JSON.stringify({ choices: [{ delta: { content: '<tool_call>{"name":"read_file","arguments":{"path":"package.json"}}</tool_call>' } }] })}\n\n`,
        'data: [DONE]\n\n',
      ]), { status: 200 });
    }
    return originalFetch(input, init);
  };
  try {
    const response = await app.fetch(new Request('http://localhost/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.8-max-preview', messages: [{ role: 'user', content: 'do not call tools' }],
        tool_choice: 'none',
        tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }],
      }),
    }));
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.choices[0].message.content, '');
    assert.doesNotMatch(JSON.stringify(body), /<tool_call>/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('streaming tool_choice none never leaks provider tool markup', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/api/v2/chat/completions')) {
      return sseResponse(qwenStream([
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'before<tool_call>{"name":"ghost","arguments":{}}</tool_call>after' } }] })}\n\n`,
        'data: [DONE]\n\n',
      ]), { status: 200 });
    }
    return originalFetch(input, init);
  };
  try {
    const response = await app.fetch(new Request('http://localhost/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3.8-max-preview', messages: [{ role: 'user', content: 'no tools' }], stream: true, tool_choice: 'none', tools: [{ type: 'function', function: { name: 'ghost', parameters: { type: 'object', properties: {} } } }] }),
    }));
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.doesNotMatch(text, /<tool_call>/);
    assert.match(text, /beforeafter/);
    assert.equal((text.match(/data: \[DONE\]/g) || []).length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('native tool calls with malformed arguments are dropped', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/api/v2/chat/completions')) {
      return sseResponse(qwenStream([`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'bad-args', type: 'function', function: { name: 'read_file', arguments: 'NOT_JSON' } }] } }] })}\n\n`, 'data: [DONE]\n\n']), { status: 200 });
    }
    return originalFetch(input, init);
  };
  try {
    const response = await app.fetch(new Request('http://localhost/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3.8-max-preview', messages: [{ role: 'user', content: 'read' }], tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }] }),
    }));
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.choices[0].message.tool_calls, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('QWEN_MAX_TOOLS also constrains returned tool calls', async () => {
  const originalLimit = process.env.QWEN_MAX_TOOLS;
  process.env.QWEN_MAX_TOOLS = '1';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/api/v2/chat/completions')) {
      return sseResponse(qwenStream([`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'omitted', type: 'function', function: { name: 'second', arguments: '{}' } }] } }] })}\n\n`, 'data: [DONE]\n\n']), { status: 200 });
    }
    return originalFetch(input, init);
  };
  try {
    const response = await app.fetch(new Request('http://localhost/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3.8-max-preview', messages: [{ role: 'user', content: 'choose' }], tools: [
        { type: 'function', function: { name: 'first', parameters: { type: 'object', properties: {} } } },
        { type: 'function', function: { name: 'second', parameters: { type: 'object', properties: {} } } },
      ] }),
    }));
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.choices[0].message.tool_calls, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalLimit === undefined) delete process.env.QWEN_MAX_TOOLS;
    else process.env.QWEN_MAX_TOOLS = originalLimit;
  }
});