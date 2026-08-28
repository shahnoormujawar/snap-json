import { test } from 'node:test';
import assert from 'node:assert';
import {
  StreamingJsonParser,
  parseStreamChunk,
  resetStreamParser,
  repairJson,
} from '../dist/index.js';

test('repairJson balances broken partial JSON', () => {
  const cases = [
    // [input, expected parse of repaired output]
    ['{"name": "Al', { name: 'Al' }],
    ['{"a": 1, "b": [true, fals', { a: 1, b: [true] }],
    ['{"a": {"b": "c', { a: { b: 'c' } }],
    ['{"a": 12.', { a: 12 }],
    ['{"a": 1e', { a: 1 }],
    ['{"a": 1e+', { a: 1 }],
    ['{"key"', {}],
    ['{"a": "x", "b":', { a: 'x' }],
    ['{"a": "x", "b"', { a: 'x' }],
    ['[{"id": 1}, {"id"', [{ id: 1 }, {}]],
    ['{"s": "a\\', { s: 'a' }],
    ['{"u": "\\u26', { u: '' }],
    ['{"u": "ok\\u2603"', { u: 'ok☃' }],
    ['{"n": -', {}],
    ['{"list": [1, 2,', { list: [1, 2] }],
    ['{"nested": {"deep": [{"x": tru', { nested: { deep: [{}] } }],
    ['{', {}],
    ['[', []],
    ['{"done": true}', { done: true }],
  ];
  for (const [input, expected] of cases) {
    const repaired = repairJson(input);
    let parsed;
    assert.doesNotThrow(
      () => (parsed = JSON.parse(repaired)),
      `unparsable repair for ${JSON.stringify(input)} -> ${JSON.stringify(repaired)}`,
    );
    assert.deepStrictEqual(
      parsed,
      expected,
      `mismatch for ${JSON.stringify(input)} -> ${JSON.stringify(repaired)}`,
    );
  }
});

test('repairJson strips prose and markdown fences around the JSON', () => {
  assert.deepStrictEqual(JSON.parse(repairJson('```json\n{"ok": true}\n```')), { ok: true });
  assert.deepStrictEqual(JSON.parse(repairJson('Sure, here it is:\n{"ok": true}\nHope that helps!')), {
    ok: true,
  });
});

test('repairJson returns empty string when no JSON has started', () => {
  assert.strictEqual(repairJson(''), '');
  assert.strictEqual(repairJson('Thinking about it...'), '');
});

test('StreamingJsonParser folds deltas into progressive partials', () => {
  const doc =
    '{"title": "Report", "items": [{"id": 1, "label": "alpha"}, {"id": 2, "label": "beta"}], "done": true}';
  for (const step of [1, 2, 3, 5, 7, 11, 13]) {
    const parser = new StreamingJsonParser();
    let last;
    for (let i = 0; i < doc.length; i += step) {
      last = parser.parseStreamChunk(doc.slice(i, i + step));
      assert.strictEqual(typeof last, 'object');
    }
    assert.deepStrictEqual(last, JSON.parse(doc), `failed at chunk size ${step}`);
    assert.strictEqual(parser.raw, doc);
  }
});

test('StreamingJsonParser keeps the previous snapshot when a chunk cannot parse yet', () => {
  const parser = new StreamingJsonParser();
  const first = parser.parseStreamChunk('{"a": 1');
  assert.deepStrictEqual(first, { a: 1 });
  // A lone escape inside a key position produces no better parse.
  const second = parser.parseStreamChunk(', "');
  assert.deepStrictEqual(second, { a: 1 });
});

test('StreamingJsonParser.reset clears buffer and snapshot', () => {
  const parser = new StreamingJsonParser();
  parser.parseStreamChunk('{"a": 1}');
  parser.reset();
  assert.strictEqual(parser.raw, '');
  assert.deepStrictEqual(parser.parseStreamChunk('{"b": 2}'), { b: 2 });
});

test('module-level parseStreamChunk keeps shared state until reset', () => {
  resetStreamParser();
  parseStreamChunk('{"x": ');
  const result = parseStreamChunk('42}');
  assert.deepStrictEqual(result, { x: 42 });
  resetStreamParser();
  assert.deepStrictEqual(parseStreamChunk('{"y": 1}'), { y: 1 });
});
