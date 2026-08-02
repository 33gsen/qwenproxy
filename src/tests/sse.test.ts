import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSSEStream } from '../utils/sse.ts';

function streamFrom(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

test('parseSSEStream joins fragmented data events and normalizes CRLF', async () => {
  const events: Array<{ data: string }> = [];
  for await (const event of parseSSEStream(streamFrom(['data: {"a":', '1}\r\n\r\n', ': heartbeat\r\n\r\n', 'data: [DONE]\r\n\r\n']))) {
    events.push(event);
  }

  assert.deepEqual(events, [{ data: '{"a":1}' }, { data: '[DONE]' }]);
});

test('parseSSEStream flushes a final event without a trailing blank line', async () => {
  const events: Array<{ data: string }> = [];
  for await (const event of parseSSEStream(streamFrom(['data: final\n']))) events.push(event);

  assert.deepEqual(events, [{ data: 'final' }]);
});

test('parseSSEStream combines multiple data lines in one SSE event', async () => {
  const events: Array<{ data: string }> = [];
  for await (const event of parseSSEStream(streamFrom(['event: message\ndata: first\ndata: second\n\n']))) events.push(event);

  assert.deepEqual(events, [{ data: 'first\nsecond', event: 'message' }]);
});

test('parseSSEStream cancels a pending read when the signal aborts', async () => {
  const controller = new AbortController();
  const stream = new ReadableStream<Uint8Array>({ start() {} });
  const iterator = parseSSEStream(stream, controller.signal);
  const pending = iterator.next();
  controller.abort();
  await assert.rejects(pending, /aborted/i);
});

test('parseSSEStream cancels an open body when the consumer stops after DONE', async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
    },
    cancel() {
      cancelled = true;
    },
  });

  for await (const event of parseSSEStream(stream)) {
    assert.equal(event.data, '[DONE]');
    break;
  }

  assert.equal(cancelled, true);
});

test('parseSSEStream rejects an oversized unterminated line', async () => {
  const oversized = `data: ${'x'.repeat(8_000_017)}`;
  await assert.rejects(
    (async () => {
      for await (const _event of parseSSEStream(streamFrom([oversized]))) {
        // The parser must reject before dispatching an oversized event.
      }
    })(),
    /maximum size/,
  );
});
