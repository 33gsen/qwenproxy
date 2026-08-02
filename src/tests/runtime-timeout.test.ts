import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent, streamAgent } from '../runtime/engine.ts';
import { registry } from '../tools/registry.ts';
import type { FunctionToolDefinition, Message } from '../types/openai.ts';
import type { LLMAdapter, LLMResponse } from '../runtime/types.ts';

const toolName = 'runtime_timeout_test';
const tool: FunctionToolDefinition = {
  type: 'function',
  function: {
    name: toolName,
    description: 'Slow tool',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
};

function adapterReturningTool(): LLMAdapter {
  let calls = 0;
  return {
    async complete(): Promise<LLMResponse> {
      calls++;
      if (calls === 1) {
        return {
          content: null,
          toolCalls: [{ id: 'slow-call', name: toolName, arguments: {} }],
          finishReason: 'tool_calls',
        };
      }
      return { content: 'finished', toolCalls: [], finishReason: 'stop' };
    },
    async *stream() {
      yield { done: true, toolCalls: [], finishReason: 'stop' };
    },
  };
}

test('runAgent enforces toolTimeout and stops without a follow-up turn', async () => {
  let aborted = false;
  registry.register(toolName, 'Slow tool', tool.function.parameters!, async (_args, context) => {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 60);
      context.signal?.addEventListener('abort', () => {
        aborted = true;
        clearTimeout(timer);
        reject(new Error('aborted'));
      }, { once: true });
    });
    return 'too late';
  });

  try {
    const seen: Message[][] = [];
    const adapter = adapterReturningTool();
    const originalComplete = adapter.complete;
    adapter.complete = async (messages, tools, model, signal) => {
      seen.push(messages);
      return originalComplete(messages, tools, model, signal);
    };
    const state = await runAgent(adapter, [{ role: 'user', content: 'run slow' }], [tool], 'qwen-test', { maxTurns: 2, toolTimeout: 10 });

    assert.equal(seen.length, 1);
    assert.equal(state.phase, 'error');
    assert.equal(state.error?.phase, 'executing');
    assert.match(String(state.error?.message), /timed out/i);
    assert.equal(aborted, true);
  } finally {
    registry.unregister(toolName);
  }
});

test('runAgent blocks a retry while a timed-out tool is still settling', async () => {
  const nonCooperativeName = 'runtime_non_cooperative_timeout_test';
  let invoked = 0;
  const nonCooperativeTool: FunctionToolDefinition = {
    type: 'function',
    function: { name: nonCooperativeName, description: 'Non-cooperative tool', parameters: { type: 'object', properties: {} } },
  };
  registry.register(nonCooperativeName, 'Non-cooperative tool', nonCooperativeTool.function.parameters!, async () => {
    invoked++;
    await new Promise(resolve => setTimeout(resolve, 50));
    return 'late';
  });
  const adapter: LLMAdapter = {
    async complete(): Promise<LLMResponse> {
      return { content: null, toolCalls: [{ id: 'non-cooperative', name: nonCooperativeName, arguments: {} }], finishReason: 'tool_calls' };
    },
    async *stream() { yield { done: true, toolCalls: [], finishReason: 'stop' }; },
  };
  try {
    const first = await runAgent(adapter, [{ role: 'user', content: 'first' }], [nonCooperativeTool], 'qwen-test', { toolTimeout: 5 });
    const second = await runAgent(adapter, [{ role: 'user', content: 'retry' }], [nonCooperativeTool], 'qwen-test', { toolTimeout: 5 });
    assert.equal(first.phase, 'error');
    assert.equal(second.phase, 'error');
    assert.match(String(second.error?.message), /still settling/i);
    assert.equal(invoked, 1);
    await new Promise(resolve => setTimeout(resolve, 60));
  } finally {
    registry.unregister(nonCooperativeName);
  }
});

test('runAgent reports the phase where an LLM timeout occurs', async () => {
  let aborted = false;
  const adapter: LLMAdapter = {
    async complete(_messages, _tools, _model, signal): Promise<LLMResponse> {
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true });
      });
      throw new Error('unreachable');
    },
    async *stream() {
      yield { done: true, toolCalls: [], finishReason: 'stop' };
    },
  };

  const state = await runAgent(adapter, [{ role: 'user', content: 'hang' }], [], 'qwen-test', { llmTimeout: 10 });
  assert.equal(state.phase, 'error');
  assert.equal(state.error?.phase, 'calling_llm');
  assert.equal(aborted, true);
});

test('streamAgent returns on an LLM timeout even when iterator cleanup hangs', async () => {
  const adapter: LLMAdapter = {
    async complete() {
      return { content: 'unused', toolCalls: [], finishReason: 'stop' };
    },
    async *stream() {
      await new Promise<void>(() => undefined);
      yield { done: true, toolCalls: [], finishReason: 'stop' };
    },
  };

  const states: Message[] = [];
  const completion = (async () => {
    for await (const state of streamAgent(adapter, [{ role: 'user', content: 'hang' }], [], 'qwen-test', { llmTimeout: 10 })) {
      states.push({ role: 'assistant', content: state.error?.message || state.phase });
    }
  })();
  const finished = await Promise.race([
    completion.then(() => true),
    new Promise<boolean>(resolve => setTimeout(() => resolve(false), 150)),
  ]);

  assert.equal(finished, true);
  assert.match(String(states.at(-1)?.content), /timed out/i);
});
