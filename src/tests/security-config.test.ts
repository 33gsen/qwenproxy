import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSafeServerBinding, getServerHost } from '../index.ts';

test('getServerHost defaults to loopback and preserves explicit bindings', () => {
  assert.equal(getServerHost(undefined), '127.0.0.1');
  assert.equal(getServerHost(''), '127.0.0.1');
  assert.equal(getServerHost('  '), '127.0.0.1');
  assert.equal(getServerHost('0.0.0.0'), '0.0.0.0');
});

test('non-loopback bindings require an API key', () => {
  assert.doesNotThrow(() => assertSafeServerBinding('127.0.0.1', ''));
  assert.doesNotThrow(() => assertSafeServerBinding('0.0.0.0', 'local-test-key'));
  assert.throws(
    () => assertSafeServerBinding('0.0.0.0', ''),
    /Refusing non-loopback HOST without API_KEY/,
  );
});