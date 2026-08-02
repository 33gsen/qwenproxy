/*
 * File: schema.ts
 * Project: qwenproxy
 * Strict JSON Schema validator for tool calling
 */

import type { JsonSchema } from './types.ts';

/**
 * Error thrown when schema validation fails.
 */
export class SchemaValidationError extends Error {
  public readonly path: string;
  public readonly value: unknown;

  constructor(message: string, path: string, value?: unknown) {
    super(message);
    this.name = 'SchemaValidationError';
    this.path = path;
    this.value = value;
  }
}

/** Backwards-compatible entry point used by the runtime tool executor. */
export function validateParams(value: unknown, schema: JsonSchema): { valid: boolean; value?: unknown; errors?: string[] } {
  try {
    return { valid: true, value: validateAgainstSchema(value, schema) };
  } catch (error: unknown) {
    if (error instanceof SchemaValidationError) {
      return { valid: false, errors: [`${error.message} (${error.path})`] };
    }
    throw error;
  }
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => deepEqual(value, right[index]));
  }
  if (typeof left === 'object' && typeof right === 'object') {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord);
    const rightKeys = Object.keys(rightRecord);
    return leftKeys.length === rightKeys.length
      && leftKeys.every(key => Object.prototype.hasOwnProperty.call(rightRecord, key) && deepEqual(leftRecord[key], rightRecord[key]));
  }
  return false;
}

function schemaMismatch(message: string, path: string, value: unknown): SchemaValidationError {
  return new SchemaValidationError(`${message} at ${path}`, path, value);
}

function defineOwnProperty(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

/**
 * Validates a value against a JSON Schema with strict type checking.
 * Throws SchemaValidationError on failure.
 * Returns the validated (possibly coerced) value on success.
 */
export function validateAgainstSchema(
  value: unknown,
  schema: JsonSchema,
  path: string = '$'
): unknown {
  if (schema.nullable && (value === null || value === undefined)) return value;

  if (schema.const !== undefined && !deepEqual(value, schema.const)) {
    throw schemaMismatch(`Value does not match const ${JSON.stringify(schema.const)}`, path, value);
  }
  if (schema.enum && !schema.enum.some(option => deepEqual(value, option))) {
    throw schemaMismatch(`Value is not one of ${JSON.stringify(schema.enum)}`, path, value);
  }

  if (schema.allOf) {
    for (const branch of schema.allOf) validateAgainstSchema(value, branch, path);
  }
  if (schema.anyOf) {
    const errors: string[] = [];
    let matched = false;
    for (const branch of schema.anyOf) {
      try {
        validateAgainstSchema(value, branch, path);
        matched = true;
        break;
      } catch (error: unknown) {
        if (error instanceof SchemaValidationError) errors.push(error.message);
      }
    }
    if (!matched) throw schemaMismatch(`Value does not match anyOf (${errors.join(' | ')})`, path, value);
  }
  if (schema.oneOf) {
    let matches = 0;
    for (const branch of schema.oneOf) {
      try {
        validateAgainstSchema(value, branch, path);
        matches++;
      } catch {}
    }
    if (matches !== 1) throw schemaMismatch(`Value matches ${matches} branches of oneOf; exactly one is required`, path, value);
  }
  if (schema.not) {
    let matchesNotSchema = true;
    try {
      validateAgainstSchema(value, schema.not, path);
    } catch (error: unknown) {
      if (!(error instanceof SchemaValidationError)) throw error;
      matchesNotSchema = false;
    }
    if (matchesNotSchema) {
      throw schemaMismatch('Value matches a forbidden not schema', path, value);
    }
  }
  if (schema.if) {
    let conditionMatches = true;
    try {
      validateAgainstSchema(value, schema.if, path);
    } catch (error: unknown) {
      if (!(error instanceof SchemaValidationError)) throw error;
      conditionMatches = false;
    }
    const branch = conditionMatches ? schema.then : schema.else;
    if (branch) validateAgainstSchema(value, branch, path);
  }

  switch (schema.type) {
    case 'object':
      return validateObject(value, schema, path);
    case 'array':
      return validateArray(value, schema, path);
    case 'string':
      return validateString(value, schema, path);
    case 'number':
    case 'integer':
      return validateNumber(value, schema, path);
    case 'boolean':
      return validateBoolean(value, schema, path);
    case 'null':
      if (value !== null) {
        throw new SchemaValidationError(
          `Expected null at ${path}, got ${typeof value}`,
          path,
          value
        );
      }
      return null;
    default:
      return value;
  }
}

function validateObject(
  value: unknown,
  schema: JsonSchema,
  path: string
): Record<string, unknown> {
  if (value === null || value === undefined) {
    throw new SchemaValidationError(
      `Expected object at ${path}, got ${value === null ? 'null' : 'undefined'}`,
      path,
      value
    );
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new SchemaValidationError(
      `Expected object at ${path}, got ${typeof value}`,
      path,
      value
    );
  }

  const obj = value as Record<string, unknown>;
  const validated: Record<string, unknown> = {};

  // Check required properties
  if (schema.required) {
    for (const req of schema.required) {
      if (!Object.prototype.hasOwnProperty.call(obj, req) || obj[req] === undefined) {
        throw new SchemaValidationError(
          `Missing required property '${req}' at ${path}`,
          `${path}.${req}`,
          undefined
        );
      }
    }
  }

  // Validate and collect properties
  const properties = schema.properties || {};
  const patternProperties = schema.patternProperties || {};
  const seenKeys = new Set<string>();

  for (const [key, val] of Object.entries(obj)) {
    seenKeys.add(key);
    const hasExplicitProperty = Object.prototype.hasOwnProperty.call(properties, key);
    let validatedValue: unknown = hasExplicitProperty
      ? validateAgainstSchema(val, properties[key], `${path}.${key}`)
      : val;
    let matchedPattern = false;
    for (const [pattern, patternSchema] of Object.entries(patternProperties)) {
      let matches = false;
      try { matches = new RegExp(pattern).test(key); } catch {
        throw new SchemaValidationError(`Invalid patternProperties expression '${pattern}' at ${path}`, `${path}.patternProperties`, key);
      }
      if (matches) {
        matchedPattern = true;
        validatedValue = validateAgainstSchema(validatedValue, patternSchema, `${path}.${key}`);
      }
    }
    if (hasExplicitProperty || matchedPattern) {
      defineOwnProperty(validated, key, validatedValue);
    } else if (schema.additionalProperties === false) {
      throw new SchemaValidationError(
        `Unexpected property '${key}' at ${path} (additionalProperties is false)`,
        `${path}.${key}`,
        val
      );
    } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      defineOwnProperty(validated, key, validateAgainstSchema(
        val,
        schema.additionalProperties as JsonSchema,
        `${path}.${key}`
      ));
    } else {
      defineOwnProperty(validated, key, val);
    }
  }

  // Apply defaults for missing properties
  for (const [key, propSchema] of Object.entries(properties)) {
    if (!seenKeys.has(key) && propSchema.default !== undefined) {
      defineOwnProperty(validated, key, propSchema.default);
    }
  }

  return validated;
}

function validateArray(
  value: unknown,
  schema: JsonSchema,
  path: string
): unknown[] {
  if (!Array.isArray(value)) {
    throw new SchemaValidationError(
      `Expected array at ${path}, got ${typeof value}`,
      path,
      value
    );
  }

  if (schema.minItems !== undefined && value.length < schema.minItems) {
    throw new SchemaValidationError(
      `Array at ${path} has ${value.length} items, minimum is ${schema.minItems}`,
      path,
      value
    );
  }

  if (schema.maxItems !== undefined && value.length > schema.maxItems) {
    throw new SchemaValidationError(
      `Array at ${path} has ${value.length} items, maximum is ${schema.maxItems}`,
      path,
      value
    );
  }

  if (schema.uniqueItems) {
    for (let i = 0; i < value.length; i++) {
      for (let j = i + 1; j < value.length; j++) {
        if (deepEqual(value[i], value[j])) {
          throw new SchemaValidationError(`Array at ${path} contains duplicate items`, path, value);
        }
      }
    }
  }

  if (Array.isArray(schema.items)) {
    throw new SchemaValidationError(`Tuple-form JSON Schema items are not supported at ${path}`, `${path}.items`, value);
  }
  if (schema.items) {
    return value.map((item, i) =>
      validateAgainstSchema(item, schema.items!, `${path}[${i}]`)
    );
  }

  return value;
}

function validateString(
  value: unknown,
  schema: JsonSchema,
  path: string
): string {
  if (typeof value !== 'string') {
    // Strict: no coercion from numbers/booleans
    throw new SchemaValidationError(
      `Expected string at ${path}, got ${typeof value}`,
      path,
      value
    );
  }

  if (schema.minLength !== undefined && value.length < schema.minLength) {
    throw new SchemaValidationError(
      `String at ${path} is ${value.length} chars, minimum is ${schema.minLength}`,
      path,
      value
    );
  }

  if (schema.maxLength !== undefined && value.length > schema.maxLength) {
    throw new SchemaValidationError(
      `String at ${path} is ${value.length} chars, maximum is ${schema.maxLength}`,
      path,
      value
    );
  }

  if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
    throw new SchemaValidationError(
      `String at ${path} does not match pattern '${schema.pattern}'`,
      path,
      value
    );
  }

  if (schema.enum && !schema.enum.includes(value)) {
    throw new SchemaValidationError(
      `Value '${value}' at ${path} is not one of [${schema.enum.map(e => `'${e}'`).join(', ')}]`,
      path,
      value
    );
  }

  return value;
}

function validateNumber(
  value: unknown,
  schema: JsonSchema,
  path: string
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new SchemaValidationError(
      `Expected number at ${path}, got ${typeof value}`,
      path,
      value
    );
  }

  if (schema.type === 'integer' && !Number.isInteger(value)) {
    throw new SchemaValidationError(
      `Expected integer at ${path}, got float ${value}`,
      path,
      value
    );
  }

  if (schema.minimum !== undefined && value < schema.minimum) {
    throw new SchemaValidationError(
      `Number ${value} at ${path} is below minimum ${schema.minimum}`,
      path,
      value
    );
  }

  if (schema.maximum !== undefined && value > schema.maximum) {
    throw new SchemaValidationError(
      `Number ${value} at ${path} is above maximum ${schema.maximum}`,
      path,
      value
    );
  }

  if (schema.enum && !schema.enum.includes(value)) {
    throw new SchemaValidationError(
      `Value ${value} at ${path} is not one of [${schema.enum.join(', ')}]`,
      path,
      value
    );
  }

  return value;
}

function validateBoolean(
  value: unknown,
  schema: JsonSchema,
  path: string
): boolean {
  if (typeof value !== 'boolean') {
    throw new SchemaValidationError(
      `Expected boolean at ${path}, got ${typeof value}`,
      path,
      value
    );
  }
  return value;
}
