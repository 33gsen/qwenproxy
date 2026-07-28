/*
 * engine.ts — Agent State Machine
 * Loop: LLM call → parse tools → execute → feed results → repeat
 * Designed for autonomous agents like Hermes.
 */

import { v4 as uuidv4 } from 'uuid';
import { StreamingToolParser } from '../tools/parser.ts';
import { registry } from '../tools/registry.ts';
import { SchemaValidationError } from '../tools/schema.ts';
import type {
  AgentState, AgentPhase, AgentConfig, AgentEvent, AgentEventListener,
  LLMAdapter, LLMResponse, LLMStreamChunk,
} from './types.ts';
import type {
  Message, ParsedToolCall, ToolCallResult, FunctionToolDefinition,
} from '../types/openai.ts';

// ─── State factory ──────────────────────────────────────────────────

function createInitialState(model: string, stream: boolean, messages: Message[], tools: FunctionToolDefinition[], config: AgentConfig): AgentState {
  const now = Date.now();
  const flatTools = tools.map(t => t.type === 'function' ? t : null).filter(Boolean) as FunctionToolDefinition[];
  return {
    phase: 'idle', runId: uuidv4(), model, stream,
    messages: [...messages], tools: flatTools,
    turn: 0, maxTurns: config.maxTurns ?? 10,
    pendingToolCalls: [], toolResults: [],
    finalContent: null, finishReason: null,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 },
    error: null,
    timestamps: { created: now },
    state: config.initialState ? { ...config.initialState } : {},
  };
}

// ─── Tool execution helpers ─────────────────────────────────────────

function buildToolPrompt(tools: FunctionToolDefinition[]): string {
  if (!tools.length) return '';
  const formatted = tools.map(t => ({
    name: t.function.name,
    description: t.function.description || '',
    parameters: t.function.parameters,
  }));
  const json = JSON.stringify(formatted, null, 2);
  return `\n\n# TOOLS AVAILABLE\n${json}\n\n# TOOL CALL FORMAT\nUse <tool_call>{"name":"tool_name","arguments":{...}}</tool_call> to call a tool.\nCall multiple tools with multiple blocks. Wait for results after calling.\n`;
}

function buildMessagesWithContext(state: AgentState): Message[] {
  const msgs: Message[] = [];
  // Inject system prompt with tools
  const toolPrompt = buildToolPrompt(state.tools);
  if (toolPrompt) {
    msgs.push({ role: 'system', content: `You are an autonomous AI agent. You can call tools. Be concise and direct.${toolPrompt}` });
  }
  // Add conversation history
  for (const msg of state.messages) {
    msgs.push(msg);
  }
  // Add tool results from last turn
  for (const tr of state.toolResults) {
    msgs.push({ role: 'tool', content: tr.result, tool_call_id: tr.toolCallId, name: tr.name });
  }
  return msgs;
}

async function executeToolCalls(state: AgentState): Promise<ToolCallResult[]> {
  const results: ToolCallResult[] = [];
  for (const tc of state.pendingToolCalls) {
    const start = Date.now();
    try {
      const tool = registry.get(tc.name);
      if (!tool) {
        results.push({ toolCallId: tc.id, name: tc.name, result: `Error: Unknown tool "${tc.name}"`, isError: true });
        continue;
      }
      // Validate args
      if (tool.parameters) {
        const { validateParams } = await import('../tools/schema.ts');
        const validation = validateParams(tc.arguments, tool.parameters);
        if (!validation.valid) {
          results.push({ toolCallId: tc.id, name: tc.name, result: `Error: ${validation.errors?.join('; ')}`, isError: true });
          continue;
        }
      }
      // Execute
      const rawResult = await tool.handler(tc.arguments, {
        messages: state.messages,
        turn: state.turn,
        model: state.model,
        state: state.state,
      });
      const resultStr = typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult);
      results.push({ toolCallId: tc.id, name: tc.name, result: resultStr, isError: false });
    } catch (e: any) {
      results.push({ toolCallId: tc.id, name: tc.name, result: `Error: ${e.message}`, isError: true });
    }
  }
  return results;
}

// ─── Engine ──────────────────────────────────────────────────────────

export async function runAgent(
  adapter: LLMAdapter,
  messages: Message[],
  tools: FunctionToolDefinition[],
  model: string,
  config: AgentConfig = {},
  listener?: AgentEventListener,
): Promise<AgentState> {
  const state = createInitialState(model, false, messages, tools, config);
  const emit = (ev: AgentEvent) => { listener?.(ev); if (config.debug) console.log('[Agent]', JSON.stringify(ev)); };

  state.phase = 'planning';
  state.timestamps.started = Date.now();
  emit({ type: 'phase_change', from: 'idle', to: 'planning', timestamp: Date.now() });

  try {
    while (state.turn < state.maxTurns) {
      state.timestamps.lastTurnAt = Date.now();
      state.pendingToolCalls = [];
      state.toolResults = [];

      // Build messages + call LLM
      state.phase = 'calling_llm';
      emit({ type: 'llm_request', turn: state.turn, messageCount: state.messages.length, timestamp: Date.now() });

      const llmMessages = buildMessagesWithContext(state);
      const response: LLMResponse = await adapter.complete(llmMessages, tools.length ? tools : undefined, model);

      emit({ type: 'llm_response', turn: state.turn, contentLength: response.content?.length || 0, toolCallCount: response.toolCalls.length, timestamp: Date.now() });

      // Update usage
      if (response.usage) {
        state.usage.promptTokens += response.usage.promptTokens || 0;
        state.usage.completionTokens += response.usage.completionTokens || 0;
        state.usage.totalTokens = state.usage.promptTokens + state.usage.completionTokens;
      }

      // Parse tool calls from content
      state.phase = 'parsing';
      if (response.content) {
        const toolParser = new StreamingToolParser(tools);
        const { text, toolCalls } = toolParser.feed(response.content);
        const flushed = toolParser.flush();
        const allCalls = [...toolCalls, ...flushed.toolCalls];
        const allText = text + (flushed.text || '');

        if (allCalls.length > 0) {
          state.pendingToolCalls = allCalls.map(tc => ({
            id: tc.id,
            name: tc.name,
            arguments: tc.arguments,
          }));
        }

        if (allText) {
          state.finalContent = (state.finalContent || '') + allText;
        }
      }

      // If no tool calls, we're done
      if (state.pendingToolCalls.length === 0) {
        state.phase = 'completed';
        state.finishReason = 'stop';
        state.timestamps.completed = Date.now();
        emit({ type: 'completed', turn: state.turn, totalTokens: state.usage.totalTokens, duration: state.timestamps.completed - state.timestamps.created, timestamp: Date.now() });
        return state;
      }

      // Execute tools
      state.phase = 'executing';
      for (const tc of state.pendingToolCalls) {
        emit({ type: 'tool_start', turn: state.turn, toolName: tc.name, toolCallId: tc.id, timestamp: Date.now() });
      }

      state.toolResults = await executeToolCalls(state);

      for (const tr of state.toolResults) {
        emit({ type: 'tool_end', turn: state.turn, toolName: tr.name, toolCallId: tr.toolCallId, isError: tr.isError, duration: 0, timestamp: Date.now() });
      }

      state.turn++;
    }

    // Max turns reached
    state.phase = 'completed';
    state.finishReason = 'stop';
    state.timestamps.completed = Date.now();
    emit({ type: 'completed', turn: state.turn, totalTokens: state.usage.totalTokens, duration: state.timestamps.completed - state.timestamps.created, timestamp: Date.now() });

  } catch (e: any) {
    state.phase = 'error';
    state.error = { code: 'ENGINE_ERROR', message: e.message, phase: state.phase, recoverable: false, cause: e };
    state.timestamps.erroredAt = Date.now();
    emit({ type: 'error', phase: state.phase, code: 'ENGINE_ERROR', message: e.message, timestamp: Date.now() });
  }

  return state;
}

// ─── Streaming agent ─────────────────────────────────────────────────

export async function* streamAgent(
  adapter: LLMAdapter,
  messages: Message[],
  tools: FunctionToolDefinition[],
  model: string,
  config: AgentConfig = {},
): AsyncGenerator<AgentState> {
  // For now, run non-streaming under the hood
  const state = await runAgent(adapter, messages, tools, model, config);
  yield state;
}
