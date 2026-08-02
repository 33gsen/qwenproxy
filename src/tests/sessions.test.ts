import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSessionRequest, validateSessionId } from '../routes/chat.ts';
import { acquireAccountStateLock, getActiveChatId, listSessions, Mutex } from '../services/playwright.ts';


test('resolveSessionRequest preserves an explicit session id when starting a fresh chat', () => {
  assert.deepEqual(
    resolveSessionRequest('fork-1234', true),
    { sessionId: 'fork-1234', newSession: true },
  );
});

test('resolveSessionRequest defaults to main without a new-session header', () => {
  assert.deepEqual(
    resolveSessionRequest(undefined, false),
    { sessionId: 'main', newSession: false },
  );
});

test('resolveSessionRequest creates an isolated id only when no id was supplied', () => {
  const result = resolveSessionRequest(undefined, true);
  assert.equal(result.newSession, true);
  assert.match(result.sessionId, /^subagent-[a-f0-9]{8}$/);
});

test('session ids accept Hermes-safe identifiers and trim surrounding whitespace', () => {
  assert.equal(validateSessionId('agent/qwen:7_abc-123'), 'agent/qwen:7_abc-123');
  assert.equal(resolveSessionRequest('  agent/qwen:7_abc-123  ', false).sessionId, 'agent/qwen:7_abc-123');
});

test('session ids reject empty, oversized, and unsafe values', () => {
  assert.throws(() => validateSessionId(''), /session_id must be/);
  assert.throws(() => validateSessionId('a'.repeat(129)), /session_id must be/);
  assert.throws(() => validateSessionId('../escape'), /session_id must be/);
  assert.throws(() => resolveSessionRequest('session id', false), /session_id must be/);
});

test('session store remains bounded when many isolated ids are requested', () => {
  getActiveChatId('main');
  for (let i = 0; i < 300; i++) getActiveChatId(`bounded-${i}`);
  const stored = listSessions();
  assert.ok(Object.keys(stored).length <= 256);
  assert.ok(stored.main);
});

test('Mutex queues callers, reports idle state, and ignores duplicate release', async () => {
  const mutex = new Mutex();
  const releaseFirst = await mutex.acquire();
  assert.equal(mutex.isIdle, false);

  let secondAcquired = false;
  const second = mutex.acquire().then(releaseSecond => {
    secondAcquired = true;
    releaseSecond();
    releaseSecond();
  });

  await Promise.resolve();
  assert.equal(secondAcquired, false);
  releaseFirst();
  releaseFirst();
  await second;
  assert.equal(secondAcquired, true);
  assert.equal(mutex.isIdle, true);
});

test('Mutex removes an aborted queued waiter without blocking the next caller', async () => {
  const mutex = new Mutex();
  const releaseFirst = await mutex.acquire();
  const controller = new AbortController();
  const aborted = mutex.acquire(controller.signal);
  controller.abort();

  await assert.rejects(aborted, /abort/i);
  releaseFirst();
  assert.equal(mutex.isIdle, true);

  const releaseNext = await mutex.acquire();
  releaseNext();
  assert.equal(mutex.isIdle, true);
});

test('account state lock serializes account lifecycle operations', async () => {
  const releaseFirst = await acquireAccountStateLock();
  let secondAcquired = false;
  const second = acquireAccountStateLock().then(releaseSecond => {
    secondAcquired = true;
    releaseSecond();
  });

  await Promise.resolve();
  assert.equal(secondAcquired, false);
  releaseFirst();
  await second;
  assert.equal(secondAcquired, true);
});
