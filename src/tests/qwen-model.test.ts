import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeQwenModelId } from '../services/qwen.ts';

test('normalizeQwenModelId removes only proxy thinking suffixes', () => {
  assert.equal(normalizeQwenModelId('qwen3.8-max-preview-no-thinking'), 'qwen3.8-max-preview');
  assert.equal(normalizeQwenModelId('qwen3.8-max-preview-thinking'), 'qwen3.8-max-preview');
  assert.equal(normalizeQwenModelId('qwen3.8-max-preview'), 'qwen3.8-max-preview');
});

test('normalizeQwenModelId falls back for an empty model id', () => {
  assert.equal(normalizeQwenModelId(''), 'qwen3.8-max-preview');
});
