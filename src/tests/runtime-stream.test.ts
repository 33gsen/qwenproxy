import test from 'node:test';
import assert from 'node:assert/strict';
import { streamAgent } from '../runtime/engine.ts';
import { registry } from '../tools/registry.ts';
import type { FunctionToolDefinition, Message } from '../types/openai.ts';
import type { LLMAdapter, LLMResponse } from '../runtime/types.ts';

const toolName = 'runtime_stream_test';
const tool: FunctionToolDefinition = {
  type: 'function',
  function: {
    name: toolName,
    description: 'Echo a value',
    parameters: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
    },
  },
};

test('streamAgent consumes streamed chunks and continues after tool results', async () => {
  const seenMessages: Message[][] = [];
  let call = 0;
  registry.register(toolName, 'Echo a value', tool.function.parameters!, async (args: any) => `stream:${args.value}`);

  const adapter: LLMAdapter = {
    async complete(): Promise<LLMResponse> {
      throw new Error('streamAgent must use adapter.stream');
    },
    async *stream(messages) {
      seenMessages.push(messages);
      call++;
      if (call === 1) {
        yield { content: `<tool_call>{"name":"${toolName}",`, done: false };
        yield { content: '"arguments":{"value":"hello"}}</tool_call>', done: false };
        yield { done: true, finishReason: 'tool_calls' };
      } else {
        yield { content: 'streamed done', done: false };
        yield { done: true, finishReason: 'stop' };
      }
    },
  };

  try {
    const states = [];
    for await (const state of streamAgent(adapter, [{ role: 'user', content: 'echo' }], [tool], 'qwen-test', { maxTurns: 3 })) {
      states.push(state);
    }

    assert.ok(states.some(state => state.phase === 'streaming'));
    const final = states.at(-1)!;
    assert.equal(final.phase, 'completed');
    assert.equal(final.finishReason, 'stop');
    assert.equal(final.finalContent, 'streamed done');
    assert.equal(seenMessages.length, 2);
    assert.ok(seenMessages[1].some(message => message.role === 'tool' && message.content === 'stream:hello'));
  } finally {
    registry.unregister(toolName);
  }
});

test('streamAgent does not execute structured calls outside the exposed tool allowlist', async () => {
  const hiddenName = 'runtime_stream_hidden_test';
  let invoked = 0;
  registry.register(hiddenName, 'Hidden stream tool', tool.function.parameters!, async () => {
    invoked++;
    return 'should-not-run';
  });

  const adapter: LLMAdapter = {
    async complete(): Promise<LLMResponse> {
      throw new Error('streamAgent must use adapter.stream');
    },
    async *stream() {
      yield {
        toolCalls: [{ id: 'hidden-stream-call', name: hiddenName, arguments: { value: 'secret' } }],
        done: false,
      };
      yield { done: true, finishReason: 'tool_calls' };
    },
  };

  try {
    const states = [];
    for await (const state of streamAgent(adapter, [{ role: 'user', content: 'do not execute hidden tools' }], [tool], 'qwen-test', { maxTurns: 1 })) {
      states.push(state);
    }

    assert.equal(invoked, 0);
    assert.equal(states.at(-1)?.phase, 'completed');
    assert.equal(states.at(-1)?.pendingToolCalls.length, 0);
  } finally {
    registry.unregister(hiddenName);
  }
});

test('streamAgent merges native tool-call argument fragments by call id', async () => {
  const fragmentToolName = 'runtime_stream_fragments_test';
  const fragmentTool: FunctionToolDefinition = {
    type: 'function',
    function: {
      name: fragmentToolName,
      description: 'Accept fragmented arguments',
      parameters: {
        type: 'object',
        properties: { first: { type: 'string' }, second: { type: 'string' } },
        required: ['first', 'second'],
      },
    },
  };
  let received: Record<string, unknown> | undefined;
  registry.register(fragmentToolName, 'Accept fragmented arguments', fragmentTool.function.parameters!, async args => {
    received = args;
    return 'merged';
  });

  const adapter: LLMAdapter = {
    async complete(): Promise<LLMResponse> {
      throw new Error('streamAgent must use adapter.stream');
    },
    async *stream() {
      yield { toolCalls: [{ id: 'fragment-call', name: fragmentToolName, arguments: { first: 'a' } }], done: false };
      yield { toolCalls: [{ id: 'fragment-call', name: fragmentToolName, arguments: { second: 'b' } }], done: false };
      yield { done: true, finishReason: 'tool_calls' };
    },
  };

  try {
    const states = [];
    for await (const state of streamAgent(adapter, [{ role: 'user', content: 'merge fragments' }], [fragmentTool], 'qwen-test', { maxTurns: 1 })) {
      states.push(state);
    }

    assert.deepEqual(received, { first: 'a', second: 'b' });
    assert.equal(states.at(-1)?.phase, 'completed');
    assert.equal(states.at(-1)?.toolResults[0]?.result, 'merged');
  } finally {
    registry.unregister(fragmentToolName);
  }
});

test('streamAgent executes a structured/content duplicate only once', async () => {
  const duplicateToolName = 'runtime_stream_duplicate_test';
  let invocations = 0;
  const duplicateTool: FunctionToolDefinition = {
    type: 'function',
    function: {
      name: duplicateToolName,
      description: 'Count duplicate calls',
      parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
    },
  };
  registry.register(duplicateToolName, 'Count duplicate calls', duplicateTool.function.parameters!, async () => {
    invocations++;
    return 'once';
  });

  const adapter: LLMAdapter = {
    async complete(): Promise<LLMResponse> {
      throw new Error('streamAgent must use adapter.stream');
    },
    async *stream() {
      yield {
        content: `<tool_call>{"name":"${duplicateToolName}","arguments":{"value":"same"}}</tool_call>`,
        toolCalls: [{ id: 'native-duplicate-call', name: duplicateToolName, arguments: { value: 'same' } }],
        done: false,
      };
      yield { done: true, finishReason: 'tool_calls' };
    },
  };

  try {
    for await (const _state of streamAgent(adapter, [{ role: 'user', content: 'call once' }], [duplicateTool], 'qwen-test', { maxTurns: 1 })) {
      // Consume the state stream.
    }
    assert.equal(invocations, 1);
  } finally {
    registry.unregister(duplicateToolName);
  }
});

test('streamAgent does not execute content calls when no tools are exposed', async () => {
  const hiddenName = 'runtime_stream_content_hidden_test';
  let invoked = 0;
  registry.register(hiddenName, 'Hidden content stream tool', tool.function.parameters!, async () => {
    invoked++;
    return 'should-not-run';
  });

  const adapter: LLMAdapter = {
    async complete(): Promise<LLMResponse> {
      throw new Error('streamAgent must use adapter.stream');
    },
    async *stream() {
      yield { content: `<tool_call>{"name":"${hiddenName}","arguments":{"value":"secret"}}</tool_call>`, done: false };
      yield { done: true, finishReason: 'tool_calls' };
    },
  };

  try {
    const states = [];
    for await (const state of streamAgent(adapter, [{ role: 'user', content: 'do not execute tools' }], [], 'qwen-test', { maxTurns: 1 })) {
      states.push(state);
    }

    assert.equal(invoked, 0);
    assert.equal(states.at(-1)?.phase, 'completed');
    assert.equal(states.at(-1)?.pendingToolCalls.length, 0);
  } finally {
    registry.unregister(hiddenName);
  }
});