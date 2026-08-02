import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareToolsForQwen } from '../routes/chat.ts';
import type { FunctionToolDefinition } from '../types/openai.ts';

const tools: FunctionToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'A'.repeat(500),
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'custom_tool',
      description: 'Custom tool',
      parameters: { type: 'object', properties: { mode: { type: 'string', enum: ['safe', 'fast'] } } },
    },
  },
];

test('prepareToolsForQwen keeps complete schemas and descriptions under the default limit', () => {
  const result = prepareToolsForQwen(tools);
  assert.equal(result.selected.length, 2);
  assert.equal(result.omittedNames.length, 0);
  assert.equal(result.formatted[0].description.length, 500);
  assert.deepEqual(result.formatted[0].parameters, tools[0].function.parameters);
});

test('prepareToolsForQwen prioritizes core tools only when a limit requires omission', () => {
  const result = prepareToolsForQwen(tools, 1);
  assert.deepEqual(result.selected.map(tool => tool.function.name), ['read_file']);
  assert.deepEqual(result.omittedNames, ['custom_tool']);
});

test('prepareToolsForQwen keeps an explicitly selected tool inside the prompt budget', () => {
  const result = prepareToolsForQwen(tools, 1, 'custom_tool');
  assert.deepEqual(result.selected.map(tool => tool.function.name), ['custom_tool']);
  assert.deepEqual(result.omittedNames, ['read_file']);
});
