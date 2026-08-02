import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOpenAIRequest, RequestValidationError } from '../utils/openai-request.ts';
import { app } from '../index.ts';
import { validateParams } from '../tools/schema.ts';

test('parseOpenAIRequest accepts developer messages and structured response formats', () => {
  const request = parseOpenAIRequest({
    model: 'qwen3.8-max-preview',
    messages: [
      { role: 'developer', content: 'Be precise.' },
      { role: 'user', content: 'hello' },
    ],
    response_format: { type: 'json_object' },
  });

  assert.equal(request.messages[0].role, 'developer');
  assert.deepEqual(request.response_format, { type: 'json_object' });
});

test('parseOpenAIRequest accepts assistant tool calls without content', () => {
  const request = parseOpenAIRequest({
    model: 'qwen3.8-max-preview',
    messages: [{
      role: 'assistant',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"package.json"}' } }],
    }],
  });

  assert.equal(request.messages[0].role, 'assistant');
});

test('parseOpenAIRequest rejects null or untyped multimodal content parts', () => {
  assert.throws(
    () => parseOpenAIRequest({ model: 'qwen3.8-max-preview', messages: [{ role: 'user', content: [null] }] }),
    (error: unknown) => error instanceof RequestValidationError && /content\[0\]/.test(error.param || ''),
  );
  assert.throws(
    () => parseOpenAIRequest({ model: 'qwen3.8-max-preview', messages: [{ role: 'user', content: [{ type: 'text' }] }] }),
    (error: unknown) => error instanceof RequestValidationError && /text/.test(error.param || ''),
  );
});

test('parseOpenAIRequest rejects unsupported response formats and fractional token limits', () => {
  assert.throws(
    () => parseOpenAIRequest({
      model: 'qwen3.8-max-preview',
      messages: [{ role: 'user', content: 'hello' }],
      response_format: { type: 'yaml' },
    }),
    (error: unknown) => error instanceof RequestValidationError && error.param === 'response_format.type',
  );
  assert.throws(
    () => parseOpenAIRequest({
      model: 'qwen3.8-max-preview',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 1.5,
    }),
    (error: unknown) => error instanceof RequestValidationError && error.param === 'max_tokens',
  );
});

test('parseOpenAIRequest rejects an oversized JSON payload', () => {
  assert.throws(
    () => parseOpenAIRequest({
      model: 'qwen3.8-max-preview',
      messages: [{ role: 'user', content: 'x'.repeat(2_100_000) }],
    }),
    (error: unknown) => error instanceof RequestValidationError && /too large/i.test(error.message),
  );
});
test('parseOpenAIRequest accepts a minimal OpenAI chat request', () => {
  const request = parseOpenAIRequest({
    model: 'qwen3.8-max-preview',
    messages: [{ role: 'user', content: 'hello' }],
  });

  assert.equal(request.model, 'qwen3.8-max-preview');
  assert.equal(request.messages.length, 1);
  assert.equal(request.max_tokens, undefined);
});

test('parseOpenAIRequest normalizes max_completion_tokens for the upstream', () => {
  const request = parseOpenAIRequest({
    model: 'qwen3.8-max-preview',
    messages: [{ role: 'user', content: 'hello' }],
    max_completion_tokens: 2048,
  });

  assert.equal(request.max_completion_tokens, 2048);
  assert.equal(request.max_tokens, undefined);
});

test('parseOpenAIRequest rejects malformed JSON values with an OpenAI-shaped error', () => {
  assert.throws(
    () => parseOpenAIRequest(null),
    (error: unknown) => {
      assert.ok(error instanceof RequestValidationError);
      assert.equal(error.status, 400);
      assert.equal(error.code, 'invalid_request_error');
      return true;
    },
  );
});

test('parseOpenAIRequest rejects an empty model and empty messages', () => {
  assert.throws(
    () => parseOpenAIRequest({ model: '', messages: [] }),
    (error: unknown) => error instanceof RequestValidationError && /model/i.test(error.message),
  );
});

test('parseOpenAIRequest rejects unsupported multi-choice requests', () => {
  assert.throws(
    () => parseOpenAIRequest({
      model: 'qwen3.8-max-preview',
      messages: [{ role: 'user', content: 'hello' }],
      n: 2,
    }),
    (error: unknown) => error instanceof RequestValidationError && error.param === 'n',
  );
});

test('parseOpenAIRequest validates tool definitions and preserves full schemas', () => {
  const parameters = {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
    additionalProperties: false,
  };
  const request = parseOpenAIRequest({
    model: 'qwen3.8-max-preview',
    messages: [{ role: 'user', content: 'read it' }],
    tools: [{
      type: 'function',
      function: { name: 'read_file', description: 'Read a file', parameters },
    }],
  });

  assert.deepEqual(request.tools?.[0].function.parameters, parameters);
});

test('parseOpenAIRequest rejects both max_tokens and max_completion_tokens', () => {
  assert.throws(
    () => parseOpenAIRequest({
      model: 'qwen3.8-max-preview',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 100,
      max_completion_tokens: 100,
    }),
    (error: unknown) => error instanceof RequestValidationError && error.param === 'max_tokens',
  );
});

test('chat endpoint returns 400 for malformed JSON instead of 500', async () => {
  const response = await app.fetch(new Request('http://localhost/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not-json',
  }));
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.error.type, 'invalid_request_error');
});

test('chat endpoint returns 400 for an invalid request shape', async () => {
  const response = await app.fetch(new Request('http://localhost/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: '', messages: [] }),
  }));
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.error.code, 'invalid_request_error');
  assert.match(body.error.message, /model|messages/i);
});

test('parseOpenAIRequest rejects invalid response schema patterns and required tools without definitions', () => {
  assert.throws(
    () => parseOpenAIRequest({
      model: 'qwen3.8-max-preview',
      messages: [{ role: 'user', content: 'json' }],
      response_format: { type: 'json_schema', json_schema: { name: 'payload', schema: { type: 'string', pattern: '^(a+)+$' } } },
    }),
    (error: unknown) => error instanceof RequestValidationError && error.param === 'response_format.json_schema.schema.pattern',
  );
  assert.throws(
    () => parseOpenAIRequest({
      model: 'qwen3.8-max-preview',
      messages: [{ role: 'user', content: 'json' }],
      response_format: { type: 'json_schema', json_schema: { name: 'payload', schema: { type: 'string', pattern: '[' } } },
    }),
    (error: unknown) => error instanceof RequestValidationError && error.param === 'response_format.json_schema.schema.pattern',
  );
  assert.throws(
    () => parseOpenAIRequest({
      model: 'qwen3.8-max-preview',
      messages: [{ role: 'user', content: 'tool' }],
      tool_choice: 'required',
    }),
    (error: unknown) => error instanceof RequestValidationError && error.param === 'tool_choice',
  );
});

test('parseOpenAIRequest rejects unsupported tuple-form array schemas', () => {
  for (const schema of [
    { type: 'array', items: [{ type: 'string' }] },
    { type: 'array', prefixItems: [{ type: 'string' }] },
    { type: 'array', items: { type: 'string' }, additionalItems: false },
  ]) {
    assert.throws(
      () => parseOpenAIRequest({
        model: 'qwen3.8-max-preview',
        messages: [{ role: 'user', content: 'json' }],
        response_format: { type: 'json_schema', json_schema: { name: 'payload', schema } },
      }),
      (error: unknown) => error instanceof RequestValidationError,
    );
  }
});

test('schema validator applies patternProperties to matching keys', () => {
  const schema = {
    type: 'object',
    patternProperties: { '^x-': { type: 'string' } },
    additionalProperties: false,
  } as any;
  assert.equal(validateParams({ 'x-name': 'ok' }, schema).valid, true);
  assert.equal(validateParams({ 'x-name': 42 }, schema).valid, false);
  assert.equal(validateParams({ other: 'ok' }, schema).valid, false);
});

test('chat cancels a pending request body when the client aborts', async () => {
  const controller = new AbortController();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    cancel() { cancelled = true; },
  });
  const request = new Request('http://localhost/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    signal: controller.signal,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
  const pending = app.fetch(request);
  await new Promise(resolve => setTimeout(resolve, 5));
  controller.abort(new Error('client disconnected'));
  const response = await Promise.race([
    pending,
    new Promise<Response>((_, reject) => setTimeout(() => reject(new Error('request remained pending')), 250)),
  ]);
  assert.equal(response.status, 400);
  assert.equal(cancelled, true);
});
