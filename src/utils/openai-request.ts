import type {
  FunctionToolDefinition,
  Message,
  OpenAIRequest,
  ToolChoice,
} from '../types/openai.ts';

const MAX_MODEL_LENGTH = 200;
const MAX_MESSAGES = 10_000;
const MAX_TOOLS = 128;
const MAX_TOOL_NAME_LENGTH = 64;
const MAX_JSON_CHARS = 2_000_000;

export class RequestValidationError extends Error {
  readonly status = 400;
  readonly code = 'invalid_request_error';
  readonly param?: string;

  constructor(message: string, param?: string) {
    super(message);
    this.name = 'RequestValidationError';
    this.param = param;
  }
}

function invalid(message: string, param?: string): never {
  throw new RequestValidationError(message, param);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const MAX_SCHEMA_DEPTH = 64;
const MAX_SCHEMA_NODES = 10_000;
const MAX_SAFE_PATTERN_LENGTH = 256;

type SchemaValidationState = { nodes: number };

function validateSafeRegexPattern(pattern: string, param: string): void {
  if (pattern.length > MAX_SAFE_PATTERN_LENGTH) invalid(`JSON Schema pattern must be at most ${MAX_SAFE_PATTERN_LENGTH} characters`, param);
  let inCharacterClass = false;
  let escaped = false;
  let quantifiers = 0;
  for (const character of pattern) {
    if (escaped) {
      if (/[0-9kKPp]/.test(character)) invalid('JSON Schema pattern contains an unsupported backreference or property escape', param);
      escaped = false;
      continue;
    }
    if (character === '\\') { escaped = true; continue; }
    if (inCharacterClass) {
      if (character === '[') invalid('JSON Schema pattern contains nested character classes', param);
      if (character === ']') inCharacterClass = false;
      continue;
    }
    if (character === '[') { inCharacterClass = true; continue; }
    if (character === '(' || character === ')' || character === '|') {
      invalid('JSON Schema pattern may not use groups or alternation', param);
    }
    if (character === '{' || character === '}') invalid('JSON Schema pattern may not use bounded quantifiers', param);
    if (character === '*' || character === '+' || character === '?') {
      quantifiers++;
      if (quantifiers > 1) invalid('JSON Schema pattern may use at most one quantifier', param);
    }
  }
  try { new RegExp(pattern); } catch { invalid('JSON Schema pattern must be a valid regular expression', param); }
}

function validateJsonSchema(schema: unknown, param: string, depth = 0, state: SchemaValidationState = { nodes: 0 }): void {
  if (!isRecord(schema)) invalid('JSON Schema subschemas must be objects', param);
  state.nodes++;
  if (depth > MAX_SCHEMA_DEPTH || state.nodes > MAX_SCHEMA_NODES) invalid('JSON Schema is too deeply nested or contains too many subschemas', param);
  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== 'string') invalid('JSON Schema pattern must be a string', `${param}.pattern`);
    validateSafeRegexPattern(schema.pattern, `${param}.pattern`);
  }
  if (schema.patternProperties !== undefined) {
    if (!isRecord(schema.patternProperties)) invalid('JSON Schema patternProperties must be an object', `${param}.patternProperties`);
    for (const [pattern, nested] of Object.entries(schema.patternProperties)) {
      validateSafeRegexPattern(pattern, `${param}.patternProperties`);
      validateJsonSchema(nested, `${param}.patternProperties.${pattern}`, depth + 1, state);
    }
  }
  if (schema.properties !== undefined) {
    if (!isRecord(schema.properties)) invalid('JSON Schema properties must be an object', `${param}.properties`);
    for (const [name, nested] of Object.entries(schema.properties)) validateJsonSchema(nested, `${param}.properties.${name}`, depth + 1, state);
  }
  if (schema.prefixItems !== undefined) invalid('JSON Schema prefixItems is not supported', `${param}.prefixItems`);
  if (schema.additionalItems !== undefined) invalid('JSON Schema additionalItems is not supported', `${param}.additionalItems`);
  if (Array.isArray(schema.items)) invalid('Tuple-form JSON Schema items are not supported', `${param}.items`);
  for (const key of ['items', 'additionalProperties', 'contains', 'not', 'if', 'then', 'else', 'propertyNames', 'unevaluatedItems', 'unevaluatedProperties'] as const) {
    if (isRecord(schema[key])) validateJsonSchema(schema[key], `${param}.${key}`, depth + 1, state);
  }
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    if (schema[key] !== undefined) {
      if (!Array.isArray(schema[key])) invalid(`JSON Schema ${key} must be an array`, `${param}.${key}`);
      schema[key].forEach((nested, index) => validateJsonSchema(nested, `${param}.${key}[${index}]`, depth + 1, state));
    }
  }
  if (isRecord(schema.dependentSchemas)) {
    for (const [name, nested] of Object.entries(schema.dependentSchemas)) validateJsonSchema(nested, `${param}.dependentSchemas.${name}`, depth + 1, state);
  }
}

function validateFiniteNumber(value: unknown, param: string, min?: number, max?: number): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    invalid(`${param} must be a finite number`, param);
  }
  if (min !== undefined && value < min) invalid(`${param} must be >= ${min}`, param);
  if (max !== undefined && value > max) invalid(`${param} must be <= ${max}`, param);
}

function validateInteger(value: unknown, param: string, min?: number, max?: number): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || !Number.isFinite(value)) {
    invalid(`${param} must be a finite integer`, param);
  }
  if (min !== undefined && value < min) invalid(`${param} must be >= ${min}`, param);
  if (max !== undefined && value > max) invalid(`${param} must be <= ${max}`, param);
}

function validateMessage(value: unknown, index: number): asserts value is Message {
  const prefix = `messages[${index}]`;
  if (!isRecord(value)) invalid(`${prefix} must be an object`, prefix);

  const role = value.role;
  if (role !== 'system' && role !== 'developer' && role !== 'user' && role !== 'assistant' && role !== 'tool' && role !== 'function') {
    invalid(`${prefix}.role is not supported`, `${prefix}.role`);
  }

  const hasContent = Object.prototype.hasOwnProperty.call(value, 'content');
  const hasToolCalls = Array.isArray(value.tool_calls);
  if (!hasContent && !(role === 'assistant' && hasToolCalls)) {
    invalid(`${prefix}.content is required`, `${prefix}.content`);
  }
  if (hasContent) {
    const content = value.content;
    if (content !== null && typeof content !== 'string' && !Array.isArray(content) && !isRecord(content)) {
      invalid(`${prefix}.content must be a string, object, array, or null`, `${prefix}.content`);
    }
    if (Array.isArray(content)) {
      for (const [partIndex, part] of content.entries()) {
        if (!isRecord(part) || typeof part.type !== 'string' || !part.type) {
          invalid(`${prefix}.content[${partIndex}] must be a typed content part`, `${prefix}.content[${partIndex}]`);
        }
        if (part.type === 'text' && typeof part.text !== 'string') {
          invalid(`${prefix}.content[${partIndex}].text must be a string`, `${prefix}.content[${partIndex}].text`);
        }
      }
    }
  }

  if (value.tool_calls !== undefined) {
    if (!Array.isArray(value.tool_calls)) invalid(`${prefix}.tool_calls must be an array`, `${prefix}.tool_calls`);
    for (const [callIndex, call] of value.tool_calls.entries()) {
      if (!isRecord(call)) invalid(`${prefix}.tool_calls[${callIndex}] must be an object`, `${prefix}.tool_calls[${callIndex}]`);
      if (typeof call.id !== 'string' || !call.id) invalid(`${prefix}.tool_calls[${callIndex}].id is required`, `${prefix}.tool_calls[${callIndex}].id`);
      if (call.type !== 'function') invalid(`${prefix}.tool_calls[${callIndex}].type must be function`, `${prefix}.tool_calls[${callIndex}].type`);
      if (!isRecord(call.function)) invalid(`${prefix}.tool_calls[${callIndex}].function must be an object`, `${prefix}.tool_calls[${callIndex}].function`);
      if (typeof call.function.name !== 'string' || !call.function.name) invalid(`${prefix}.tool_calls[${callIndex}].function.name is required`, `${prefix}.tool_calls[${callIndex}].function.name`);
      if (typeof call.function.arguments !== 'string') invalid(`${prefix}.tool_calls[${callIndex}].function.arguments must be a JSON string`, `${prefix}.tool_calls[${callIndex}].function.arguments`);
      try {
        if (!isRecord(JSON.parse(call.function.arguments))) invalid(`${prefix}.tool_calls[${callIndex}].function.arguments must be a JSON object`, `${prefix}.tool_calls[${callIndex}].function.arguments`);
      } catch {
        invalid(`${prefix}.tool_calls[${callIndex}].function.arguments must be valid JSON`, `${prefix}.tool_calls[${callIndex}].function.arguments`);
      }
    }
  }

  if (value.tool_call_id !== undefined && typeof value.tool_call_id !== 'string') {
    invalid(`${prefix}.tool_call_id must be a string`, `${prefix}.tool_call_id`);
  }
}

function validateTool(value: unknown, index: number): asserts value is FunctionToolDefinition {
  const prefix = `tools[${index}]`;
  if (!isRecord(value)) invalid(`${prefix} must be an object`, prefix);
  if (value.type !== 'function') invalid(`${prefix}.type must be function`, `${prefix}.type`);
  if (!isRecord(value.function)) invalid(`${prefix}.function must be an object`, `${prefix}.function`);

  const name = value.function.name;
  if (typeof name !== 'string' || !name || name.length > MAX_TOOL_NAME_LENGTH) {
    invalid(`${prefix}.function.name must be 1-${MAX_TOOL_NAME_LENGTH} characters`, `${prefix}.function.name`);
  }
  if (value.function.description !== undefined && typeof value.function.description !== 'string') {
    invalid(`${prefix}.function.description must be a string`, `${prefix}.function.description`);
  }
  if (value.function.parameters !== undefined && !isRecord(value.function.parameters)) {
    invalid(`${prefix}.function.parameters must be a JSON Schema object`, `${prefix}.function.parameters`);
  }
  if (isRecord(value.function.parameters)) validateJsonSchema(value.function.parameters, `${prefix}.function.parameters`);
  if (value.function.strict !== undefined && typeof value.function.strict !== 'boolean') {
    invalid(`${prefix}.function.strict must be a boolean`, `${prefix}.function.strict`);
  }
}

function validateToolChoice(value: unknown): asserts value is ToolChoice {
  if (value === 'auto' || value === 'none' || value === 'required') return;
  if (!isRecord(value) || value.type !== 'function' || !isRecord(value.function) || typeof value.function.name !== 'string' || !value.function.name) {
    invalid('tool_choice must be auto, none, required, or a function choice', 'tool_choice');
  }
}

function validateStreamOptions(value: unknown): void {
  if (!isRecord(value)) invalid('stream_options must be an object', 'stream_options');
  if (value.include_usage !== undefined && typeof value.include_usage !== 'boolean') {
    invalid('stream_options.include_usage must be a boolean', 'stream_options.include_usage');
  }
}

export function parseOpenAIRequest(input: unknown): OpenAIRequest {
  if (!isRecord(input)) invalid('Request body must be a JSON object');
  let serializedLength = 0;
  try {
    serializedLength = JSON.stringify(input).length;
  } catch {
    invalid('Request body must be JSON-serializable');
  }
  if (serializedLength > MAX_JSON_CHARS) invalid(`Request body is too large (maximum ${MAX_JSON_CHARS} characters)`);

  if (typeof input.model !== 'string' || !input.model.trim() || input.model.length > MAX_MODEL_LENGTH) {
    invalid(`model must be a non-empty string of at most ${MAX_MODEL_LENGTH} characters`, 'model');
  }
  if (!Array.isArray(input.messages) || input.messages.length === 0 || input.messages.length > MAX_MESSAGES) {
    invalid(`messages must contain between 1 and ${MAX_MESSAGES} items`, 'messages');
  }
  input.messages.forEach((message, index) => validateMessage(message, index));

  if (input.stream !== undefined && typeof input.stream !== 'boolean') invalid('stream must be a boolean', 'stream');
  if (input.tools !== undefined) {
    if (!Array.isArray(input.tools) || input.tools.length > MAX_TOOLS) invalid(`tools must contain at most ${MAX_TOOLS} items`, 'tools');
    const toolNames = new Set<string>();
    input.tools.forEach((tool, index) => {
      validateTool(tool, index);
      if (toolNames.has(tool.function.name)) invalid(`Duplicate tool name: ${tool.function.name}`, `tools[${index}].function.name`);
      toolNames.add(tool.function.name);
    });
  }
  if (input.tool_choice !== undefined) validateToolChoice(input.tool_choice);
  if (typeof input.tool_choice === 'object') {
    const toolNames = new Set((input.tools || []).map(tool => tool.function.name));
    if (!toolNames.has(input.tool_choice.function.name)) {
      invalid(`tool_choice references an unknown tool: ${input.tool_choice.function.name}`, 'tool_choice.function.name');
    }
  }
  if ((input.tool_choice === 'required' || typeof input.tool_choice === 'object') && (!input.tools || input.tools.length === 0)) {
    invalid('tool_choice requires at least one tool definition', 'tool_choice');
  }
  if (input.stream_options !== undefined) validateStreamOptions(input.stream_options);

  if (input.max_tokens !== undefined) validateInteger(input.max_tokens, 'max_tokens', 1, 1_000_000);
  if (input.max_completion_tokens !== undefined) validateInteger(input.max_completion_tokens, 'max_completion_tokens', 1, 1_000_000);
  if (input.max_tokens !== undefined && input.max_completion_tokens !== undefined) {
    invalid('Specify only one of max_tokens or max_completion_tokens', 'max_tokens');
  }
  if (input.temperature !== undefined) validateFiniteNumber(input.temperature, 'temperature', 0, 2);
  if (input.top_p !== undefined) validateFiniteNumber(input.top_p, 'top_p', 0, 1);
  if (input.n !== undefined) {
    validateFiniteNumber(input.n, 'n', 1, 1);
    if (input.n !== 1) invalid('Only n=1 is supported', 'n');
  }
  if (input.presence_penalty !== undefined) validateFiniteNumber(input.presence_penalty, 'presence_penalty', -2, 2);
  if (input.frequency_penalty !== undefined) validateFiniteNumber(input.frequency_penalty, 'frequency_penalty', -2, 2);
  if (input.stop !== undefined && input.stop !== null) {
    if (typeof input.stop !== 'string' && !Array.isArray(input.stop)) invalid('stop must be a string, array, or null', 'stop');
    if (Array.isArray(input.stop)) {
      if (input.stop.length > 4) invalid('stop supports at most four strings', 'stop');
      if (input.stop.some((value: unknown) => typeof value !== 'string')) invalid('stop array elements must be strings', 'stop');
    }
  }
  if (input.user !== undefined && typeof input.user !== 'string') invalid('user must be a string', 'user');
  if (input.response_format !== undefined) {
    if (!isRecord(input.response_format) || typeof input.response_format.type !== 'string') {
      invalid('response_format.type is required', 'response_format.type');
    }
    const formatType = input.response_format.type;
    if (formatType !== 'text' && formatType !== 'json_object' && formatType !== 'json_schema') {
      invalid('response_format.type must be text, json_object, or json_schema', 'response_format.type');
    }
    if (formatType === 'json_schema') {
      const envelope = input.response_format.json_schema;
      if (!isRecord(envelope) || !isRecord(envelope.schema)) {
        invalid('response_format.json_schema must be an object', 'response_format.json_schema');
      }
      validateJsonSchema(envelope.schema, 'response_format.json_schema.schema');
    }
  }
  if (input.seed !== undefined) validateInteger(input.seed, 'seed');

  return input as OpenAIRequest;
}
