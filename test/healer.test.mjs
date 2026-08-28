import { test } from 'node:test';
import assert from 'node:assert';
import {
  PayloadHealer,
  HealingError,
  healPayload,
  validatePayload,
  pruneUnknownKeys,
} from '../dist/index.js';

const personSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    age: { type: 'integer' },
    role: { type: 'string', enum: ['admin', 'user'] },
    tags: { type: 'array', items: { type: 'string' } },
  },
  required: ['name', 'age'],
  additionalProperties: false,
};

test('validatePayload accepts a conforming value', () => {
  const issues = validatePayload(
    { name: 'Ada', age: 36, role: 'admin', tags: ['a'] },
    personSchema,
  );
  assert.deepStrictEqual(issues, []);
});

test('validatePayload reports typed issues with paths and segments', () => {
  const issues = validatePayload({ name: 42, tags: ['a', 7], extra: true }, personSchema);
  const byPath = Object.fromEntries(issues.map((issue) => [issue.path, issue]));
  assert.match(byPath['$.name'].message, /expected string/);
  assert.match(byPath['$.tags[1]'].message, /expected string/);
  assert.deepStrictEqual(byPath['$.tags[1]'].segments, ['tags', 1]);
  assert.ok(issues.some((issue) => issue.message.includes('missing required property "age"')));
  assert.ok(issues.some((issue) => issue.message.includes('unexpected property "extra"')));
});

test('validatePayload handles nullable, enum, and integer rules', () => {
  const schema = {
    type: 'object',
    properties: {
      maybe: { type: 'string', nullable: true },
      role: { type: 'string', enum: ['a', 'b'] },
      count: { type: 'integer' },
    },
    required: [],
    additionalProperties: false,
  };
  assert.deepStrictEqual(validatePayload({ maybe: null }, schema), []);
  assert.match(validatePayload({ role: 'z' }, schema)[0].message, /enum/);
  assert.match(validatePayload({ count: 1.5 }, schema)[0].message, /expected integer/);
});

test('pruneUnknownKeys strips forbidden keys recursively without touching allowed ones', () => {
  const value = {
    name: 'Ada',
    age: 36,
    junk: 1,
    tags: ['x'],
  };
  pruneUnknownKeys(value, personSchema);
  assert.deepStrictEqual(value, { name: 'Ada', age: 36, tags: ['x'] });
});

test('pruneUnknownKeys leaves objects alone when additionalProperties is not false', () => {
  const open = { type: 'object', properties: { a: { type: 'number' } } };
  const value = { a: 1, b: 2 };
  pruneUnknownKeys(value, open);
  assert.deepStrictEqual(value, { a: 1, b: 2 });
});

test('healPayload splices a corrected snippet back into the document', async () => {
  const broken = '{"name": "Ada" "age": 36}';
  let receivedPrompt = '';
  const fallback = async (prompt) => {
    receivedPrompt = prompt;
    return '{"name": "Ada", "age": 36}';
  };
  let errorMsg = '';
  try {
    JSON.parse(broken);
  } catch (error) {
    errorMsg = error.message;
  }
  const healed = await healPayload(broken, errorMsg, fallback);
  assert.deepStrictEqual(healed, { name: 'Ada', age: 36 });
  assert.ok(receivedPrompt.includes('Snippet:'), 'prompt must be snippet-based');
  assert.ok(receivedPrompt.includes(errorMsg), 'prompt must carry the error rule');
  assert.ok(!receivedPrompt.includes('Extract'), 'original prompt context is never re-sent');
});

test('healPayload tolerates fenced replies from the fallback model', async () => {
  const broken = '{"a": tru}';
  const fallback = async () => '```json\n{"a": true}\n```';
  const healed = await healPayload(broken, 'Unexpected token', fallback);
  assert.deepStrictEqual(healed, { a: true });
});

test('healPayload throws HealingError when the fallback cannot fix it', async () => {
  const healer = new PayloadHealer({ maxAttempts: 2 });
  const fallback = async () => 'still not json {{{';
  await assert.rejects(
    healer.healPayload('{"a": ', 'Unexpected end of JSON input', fallback),
    HealingError,
  );
});

test('healValidation repairs invalid fields via path-scoped prompts', async () => {
  const healer = new PayloadHealer();
  const prompts = [];
  const fallback = async (prompt) => {
    prompts.push(prompt);
    if (prompt.includes('$.age')) return '36';
    if (prompt.includes('$.role')) return '"admin"';
    return 'null';
  };
  const healed = await healer.healValidation(
    { name: 'Ada', age: 'thirty-six', role: 'boss', tags: [] },
    personSchema,
    fallback,
  );
  assert.deepStrictEqual(healed, { name: 'Ada', age: 36, role: 'admin', tags: [] });
  assert.ok(prompts.every((prompt) => prompt.includes('Path: $.')));
  assert.ok(prompts.every((prompt) => prompt.includes('Expected schema:')));
});

test('healValidation returns the value untouched when it already validates', async () => {
  const healer = new PayloadHealer();
  const fallback = async () => {
    throw new Error('must not be called');
  };
  const value = { name: 'Ada', age: 36 };
  assert.strictEqual(await healer.healValidation(value, personSchema, fallback), value);
});
