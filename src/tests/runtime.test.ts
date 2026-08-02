import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '../runtime/engine.ts';
import { registry } from '../tools/registry.ts';
import type { FunctionToolDefinition, Message } from '../types/openai.ts';
import type { LLMAdapter, LLMResponse } from '../runtime/types.ts';

const toolName = 'runtime_echo_test';
const tool: FunctionToolDefinition = {
  type: 'function',
  function: {
    name: toolName,
    description: 'Echo a value',
    parameters: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    },
  },
};

test('runAgent feeds assistant tool calls and tool results into the next LLM turn', async () => {
  const seenMessages: Message[][] = [];
  registry.register(toolName, 'Echo a value', tool.function.parameters!, async (args: any) => `echo:${args.value}`);

  const adapter: LLMAdapter = {
    async complete(messages): Promise<LLMResponse> {
      seenMessages.push(messages);
      if (seenMessages.length === 1) {
        return {
          content: `<tool_call>{"name":"${toolName}","arguments":{"value":"hello"}}</tool_call>`,
          toolCalls: [],
          finishReason: 'tool_calls',
        };
      }
      return { content: 'done', toolCalls: [], finishReason: 'stop' };
    },
    async *stream() {
      yield { done: true, toolCalls: [], finishReason: 'stop' };
    },
  };

  try {
    const state = await runAgent(
      adapter,
      [{ role: 'user', content: 'echo hello' }],
      [tool],
      'qwen-test',
      { maxTurns: 3 },
    );

    assert.equal(seenMessages.length, 2);
    assert.equal(seenMessages[1].some(message => message.role === 'assistant' && message.tool_calls?.[0]?.function.name === toolName), true);
    assert.equal(seenMessages[1].some(message => message.role === 'tool' && message.content === 'echo:hello'), true);
    assert.equal(state.phase, 'completed');
    assert.equal(state.finishReason, 'stop');
    assert.equal(state.finalContent, 'done');
  } finally {
    registry.unregister(toolName);
  }
});

test('runAgent does not execute structured calls outside the exposed tool allowlist', async () => {
  const hiddenName = 'runtime_hidden_test';
  let invoked = 0;
  registry.register(hiddenName, 'Hidden tool', tool.function.parameters!, async () => {
    invoked++;
    return 'should-not-run';
  });

  const adapter: LLMAdapter = {
    async complete(): Promise<LLMResponse> {
      return {
        content: null,
        toolCalls: [{ id: 'hidden-call', name: hiddenName, arguments: { value: 'secret' } }],
        finishReason: 'tool_calls',
      };
    },
    async *stream() {
      yield { done: true, toolCalls: [], finishReason: 'stop' };
    },
  };

  try {
    const state = await runAgent(
      adapter,
      [{ role: 'user', content: 'do not execute hidden tools' }],
      [tool],
      'qwen-test',
      { maxTurns: 1 },
    );

    assert.equal(invoked, 0);
    assert.equal(state.phase, 'completed');
    assert.equal(state.pendingToolCalls.length, 0);
  } finally {
    registry.unregister(hiddenName);
  }
});

test('runAgent passes schema defaults to the tool handler', async () => {
  const defaultName = 'runtime_default_test';
  const defaultTool: FunctionToolDefinition = {
    type: 'function',
    function: {
      name: defaultName,
      description: 'Tool with a default',
      parameters: {
        type: 'object',
        properties: { value: { type: 'string', default: 'from-schema' } },
        additionalProperties: false,
      },
    },
  };
  let received: Record<string, unknown> | undefined;
  registry.register(defaultName, 'Tool with a default', defaultTool.function.parameters!, async args => {
    received = args;
    return 'ok';
  });

  let calls = 0;
  const adapter: LLMAdapter = {
    async complete(): Promise<LLMResponse> {
      calls++;
      return calls === 1
        ? { content: null, toolCalls: [{ id: 'default-call', name: defaultName, arguments: {} }], finishReason: 'tool_calls' }
        : { content: 'done', toolCalls: [], finishReason: 'stop' };
    },
    async *stream() {
      yield { done: true, toolCalls: [], finishReason: 'stop' };
    },
  };

  try {
    const state = await runAgent(adapter, [{ role: 'user', content: 'use the default' }], [defaultTool], 'qwen-test', { maxTurns: 2 });
    assert.deepEqual(received, { value: 'from-schema' });
    assert.equal(state.finalContent, 'done');
  } finally {
    registry.unregister(defaultName);
  }
});
test('runAgent does not execute content calls when no tools are exposed', async () => {
  const hiddenName = 'runtime_content_hidden_test';
  let invoked = 0;
  registry.register(hiddenName, 'Hidden content tool', tool.function.parameters!, async () => {
    invoked++;
    return 'should-not-run';
  });

  const adapter: LLMAdapter = {
    async complete(): Promise<LLMResponse> {
      return {
        content: `<tool_call>{"name":"${hiddenName}","arguments":{"value":"secret"}}</tool_call>`,
        toolCalls: [],
        finishReason: 'tool_calls',
      };
    },
    async *stream() {
      yield { done: true, toolCalls: [], finishReason: 'stop' };
    },
  };

  try {
    const state = await runAgent(adapter, [{ role: 'user', content: 'do not execute tools' }], [], 'qwen-test', { maxTurns: 1 });
    assert.equal(invoked, 0);
    assert.equal(state.phase, 'completed');
    assert.equal(state.pendingToolCalls.length, 0);
  } finally {
    registry.unregister(hiddenName);
  }
});

test('runAgent deduplicates equivalent structured and content calls even with different ids', async () => {
  const duplicateName = 'runtime_duplicate_source_test';
  let invoked = 0;
  const duplicateTool: FunctionToolDefinition = {
    type: 'function',
    function: {
      name: duplicateName,
      description: 'Duplicate source test',
      parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
    },
  };
  registry.register(duplicateName, 'Duplicate source test', duplicateTool.function.parameters!, async () => {
    invoked++;
    return 'ok';
  });
  const adapter: LLMAdapter = {
    async complete(messages): Promise<LLMResponse> {
      if (messages.some(message => message.role === 'tool')) return { content: 'done', toolCalls: [], finishReason: 'stop' };
      return {
        content: `<tool_call>{"name":"${duplicateName}","arguments":{"value":"same"}}</tool_call>`,
        toolCalls: [{ id: 'native-id', name: duplicateName, arguments: { value: 'same' } }],
        finishReason: 'tool_calls',
      };
    },
    async *stream() { yield { done: true, toolCalls: [], finishReason: 'stop' }; },
  };
  try {
    const state = await runAgent(adapter, [{ role: 'user', content: 'deduplicate' }], [duplicateTool], 'qwen-test', { maxTurns: 3 });
    assert.equal(invoked, 1);
    assert.equal(state.phase, 'completed');
  } finally {
    registry.unregister(duplicateName);
  }
});

test('runAgent does not execute malformed string arguments as an empty object', async () => {
  const malformedName = 'runtime_malformed_arguments_test';
  let invoked = 0;
  const malformedTool: FunctionToolDefinition = {
    type: 'function',
    function: {
      name: malformedName,
      description: 'Malformed arguments test',
      parameters: { type: 'object', properties: {}, additionalProperties: true },
    },
  };
  registry.register(malformedName, 'Malformed arguments test', malformedTool.function.parameters!, async () => {
    invoked++;
    return 'must-not-run';
  });
  const adapter: LLMAdapter = {
    async complete(): Promise<LLMResponse> {
      return { content: `<tool_call>{"name":"${malformedName}","arguments":"not-json"}</tool_call>`, toolCalls: [], finishReason: 'tool_calls' };
    },
    async *stream() { yield { done: true, toolCalls: [], finishReason: 'stop' }; },
  };
  try {
    const state = await runAgent(adapter, [{ role: 'user', content: 'reject malformed arguments' }], [malformedTool], 'qwen-test', { maxTurns: 1 });
    assert.equal(invoked, 0);
    assert.equal(state.pendingToolCalls.length, 0);
  } finally {
    registry.unregister(malformedName);
  }
});

test('runAgent preserves a non-stop upstream finish reason', async () => {
  const adapter: LLMAdapter = {
    async complete(): Promise<LLMResponse> {
      return { content: 'truncated', toolCalls: [], finishReason: 'length' };
    },
    async *stream() { yield { done: true, toolCalls: [], finishReason: 'stop' }; },
  };
  const state = await runAgent(adapter, [{ role: 'user', content: 'finish reason' }], [], 'qwen-test', { maxTurns: 1 });
  assert.equal(state.phase, 'completed');
  assert.equal(state.finishReason, 'length');
});