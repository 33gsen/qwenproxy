import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAgainstSchema, validateParams, SchemaValidationError } from '../tools/schema.ts';

test('schema validator enforces const and enum for all primitive values', () => {
  assert.equal(validateAgainstSchema('read', { type: 'string', const: 'read' }), 'read');
  assert.throws(() => validateAgainstSchema('write', { type: 'string', const: 'read' }), SchemaValidationError);
  assert.throws(() => validateAgainstSchema('other', { type: 'string', enum: ['read', 'write'] }), SchemaValidationError);
});

test('schema validator supports anyOf, oneOf, and allOf', () => {
  const union = { type: 'string', anyOf: [{ type: 'string', const: 'a' }, { type: 'string', const: 'b' }] };
  assert.equal(validateAgainstSchema('b', union), 'b');
  assert.throws(() => validateAgainstSchema('c', union), SchemaValidationError);

  const exclusive = { type: 'number', oneOf: [{ type: 'number' }, { type: 'number', minimum: 0 }] };
  assert.throws(() => validateAgainstSchema(1, exclusive), SchemaValidationError);

  const composed = { type: 'number', allOf: [{ type: 'number', minimum: 1 }, { type: 'number', maximum: 3 }] };
  assert.equal(validateAgainstSchema(2, composed), 2);
  assert.throws(() => validateAgainstSchema(4, composed), SchemaValidationError);
});

test('schema validator supports nested not and conditional branches', () => {
  const nestedNot = { type: 'string', not: { not: { type: 'string' } } };
  assert.equal(validateAgainstSchema('value', nestedNot), 'value');
  assert.throws(() => validateAgainstSchema('value', { type: 'string', not: { type: 'string' } }), SchemaValidationError);

  const conditional = {
    type: 'object',
    properties: { kind: { type: 'string' }, value: { type: 'string' }, fallback: { type: 'string' } },
    if: { type: 'object', properties: { kind: { const: 'primary' } }, required: ['kind'] },
    then: { type: 'object', required: ['value'] },
    else: { type: 'object', required: ['fallback'] },
  };
  assert.deepEqual(validateAgainstSchema({ kind: 'primary', value: 'ok' }, conditional), { kind: 'primary', value: 'ok' });
  assert.deepEqual(validateAgainstSchema({ kind: 'secondary', fallback: 'ok' }, conditional), { kind: 'secondary', fallback: 'ok' });
  assert.throws(() => validateAgainstSchema({ kind: 'primary', fallback: 'wrong' }, conditional), SchemaValidationError);
});

test('schema validator enforces uniqueItems', () => {
  assert.deepEqual(validateAgainstSchema([1, 2], { type: 'array', uniqueItems: true }), [1, 2]);
  assert.throws(() => validateAgainstSchema([1, 1], { type: 'array', uniqueItems: true }), SchemaValidationError);
});

test('validateParams returns structured success and failure results', () => {
  assert.deepEqual(validateParams({ value: 'ok' }, {
    type: 'object',
    properties: { value: { type: 'string' } },
    required: ['value'],
  }), { valid: true, value: { value: 'ok' } });
  const failure = validateParams({}, { type: 'object', required: ['value'] });
  assert.equal(failure.valid, false);
  assert.ok(failure.errors?.length);
});

test('schema validator rejects inherited required fields and safely copies special keys', () => {
  const inherited = Object.create({ value: 'inherited' }) as Record<string, unknown>;
  const required = validateParams(inherited, { type: 'object', required: ['value'] });
  assert.equal(required.valid, false);

  const input = JSON.parse('{"safe":"ok","__proto__":{"admin":"bypassed"}}') as Record<string, unknown>;
  const validated = validateAgainstSchema(input, {
    type: 'object',
    properties: { safe: { type: 'string' } },
    additionalProperties: true,
  }) as Record<string, unknown>;

  assert.equal(Object.getPrototypeOf(validated), Object.prototype);
  assert.equal(Object.prototype.hasOwnProperty.call(validated, '__proto__'), true);
  assert.equal((validated as { admin?: string }).admin, undefined);

  const rejected = validateParams(input, {
    type: 'object',
    properties: { safe: { type: 'string' } },
    additionalProperties: false,
  });
  assert.equal(rejected.valid, false);
});
