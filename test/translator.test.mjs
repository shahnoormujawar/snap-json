import { test } from 'node:test';
import assert from 'node:assert';
import { SchemaTranslator } from '../dist/index.js';

const translator = new SchemaTranslator();

test('normalize infers schemas from plain templates', () => {
  const schema = translator.normalize({
    name: "the person's full name",
    age: 'number',
    score: 'integer?',
    active: 'boolean',
    role: 'enum:admin|user',
    tags: ['string'],
    address: { city: 'string', zip: 'string' },
    exampleNumber: 42,
    exampleBool: true,
    maybe: null,
  });
  assert.strictEqual(schema.type, 'object');
  assert.deepStrictEqual(schema.properties.name, {
    type: 'string',
    description: "the person's full name",
  });
  assert.deepStrictEqual(schema.properties.age, { type: 'number' });
  assert.deepStrictEqual(schema.properties.score, { type: 'integer', nullable: true });
  assert.deepStrictEqual(schema.properties.role, { type: 'string', enum: ['admin', 'user'] });
  assert.deepStrictEqual(schema.properties.tags, { type: 'array', items: { type: 'string' } });
  assert.strictEqual(schema.properties.address.type, 'object');
  assert.deepStrictEqual(schema.properties.exampleNumber, { type: 'number' });
  assert.deepStrictEqual(schema.properties.exampleBool, { type: 'boolean' });
  assert.deepStrictEqual(schema.properties.maybe, { type: 'string', nullable: true });
  assert.deepStrictEqual(schema.required, Object.keys(schema.properties));
  assert.strictEqual(schema.additionalProperties, false);
});

test('normalize passes explicit JSON Schemas through with defaults filled', () => {
  const schema = translator.normalize({
    type: 'object',
    properties: { id: { type: 'integer' } },
  });
  assert.deepStrictEqual(schema.required, ['id']);
  assert.strictEqual(schema.additionalProperties, false);
});

test('openai fragment uses strict json_schema with all-required and null unions', () => {
  const { requestFragment } = translator.translate(
    { name: 'string', nickname: 'string?' },
    'openai',
    'person',
  );
  const rf = requestFragment.response_format;
  assert.strictEqual(rf.type, 'json_schema');
  assert.strictEqual(rf.json_schema.name, 'person');
  assert.strictEqual(rf.json_schema.strict, true);
  const emitted = rf.json_schema.schema;
  assert.deepStrictEqual(emitted.required, ['name', 'nickname']);
  assert.strictEqual(emitted.additionalProperties, false);
  assert.deepStrictEqual(emitted.properties.nickname.type, ['string', 'null']);
});

test('anthropic fragment forces a tool call with the schema as input_schema', () => {
  const { requestFragment } = translator.translate({ ok: 'boolean' }, 'anthropic');
  assert.strictEqual(requestFragment.tools.length, 1);
  assert.strictEqual(requestFragment.tools[0].name, 'emit_json');
  assert.strictEqual(requestFragment.tools[0].input_schema.type, 'object');
  assert.deepStrictEqual(requestFragment.tool_choice, { type: 'tool', name: 'emit_json' });
});

test('gemini fragment emits responseSchema with uppercase types and propertyOrdering', () => {
  const { requestFragment } = translator.translate(
    { title: 'string', items: [{ id: 'integer' }] },
    'gemini',
  );
  const generation = requestFragment.generationConfig;
  assert.strictEqual(generation.responseMimeType, 'application/json');
  const schema = generation.responseSchema;
  assert.strictEqual(schema.type, 'OBJECT');
  assert.deepStrictEqual(schema.propertyOrdering, ['title', 'items']);
  assert.strictEqual(schema.properties.items.type, 'ARRAY');
  assert.strictEqual(schema.properties.items.items.properties.id.type, 'INTEGER');
});
