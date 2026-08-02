import test from 'node:test';
import assert from 'node:assert/strict';
import { createQwenStream, wrapQwenResponseStream } from '../services/qwen.ts';
import { acquireAccountStateLock } from '../services/playwright.ts';

process.env.TEST_MOCK_PLAYWRIGHT = 'true';

test('wrapQwenResponseStream aborts the upstream reader when the client aborts', async () => {
  let cancelled = false;
  let settled = false;
  const upstream = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  const client = new AbortController();
  const upstreamController = new AbortController();
  const wrapped = wrapQwenResponseStream(upstream, upstreamController, client.signal, 1_000, () => { settled = true; });
  const pending = wrapped.getReader().read();

  client.abort();

  await assert.rejects(pending, /aborted/i);
  assert.equal(cancelled, true);
  assert.equal(upstreamController.signal.aborted, true);
  assert.equal(settled, true);
});

test('wrapQwenResponseStream fails a stalled body after its timeout', async () => {
  let cancelled = false;
  let settled = false;
  const upstream = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  const upstreamController = new AbortController();
  const wrapped = wrapQwenResponseStream(upstream, upstreamController, undefined, 5, () => { settled = true; });
  const pending = wrapped.getReader().read();

  await assert.rejects(pending, /timed out/i);
  assert.equal(cancelled, true);
  assert.equal(upstreamController.signal.aborted, true);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(settled, true);
});

test('createQwenStream releases the account lock when fetch ignores abort', async () => {
  const originalFetch = globalThis.fetch;
  let startedResolve: (() => void) | undefined;
  const started = new Promise<void>(resolve => { startedResolve = resolve; });
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/api/v2/chat/completions')) {
      startedResolve?.();
      return await new Promise<Response>(() => {});
    }
    return originalFetch(input);
  };
  const client = new AbortController();
  try {
    const pending = createQwenStream('hello', false, 'qwen3.8-max-preview', undefined, 'abort-lock-test', undefined, client.signal);
    await started;
    client.abort();
    await assert.rejects(pending);

    const release = await Promise.race([
      acquireAccountStateLock(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('account lock remained held')), 100)),
    ]);
    release();
  } finally {
    globalThis.fetch = originalFetch;
  }
});
