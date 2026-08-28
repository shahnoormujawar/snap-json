import { test } from 'node:test';
import assert from 'node:assert';
import { SnapJson, SnapJsonError } from '../dist/index.js';

const jsonResponse = (obj) =>
  new Response(JSON.stringify(obj), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const sseResponse = (events, { done = false } = {}) =>
  new Response(
    new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(': keep-alive\n\n'));
        for (const event of events) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }
        if (done) controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    }),
    { status: 200 },
  );

test('openai extract: strict json_schema request, truncated output fixed by free local repair', async () => {
  const calls = [];
  const client = new SnapJson({
    apiKeys: { openai: 'sk-test' },
    fetch: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return jsonResponse({ choices: [{ message: { content: '{"name": "Ada", "age": 36' } }] });
    },
  });
  const value = await client.extract('Extract the person', {
    provider: 'openai',
    model: 'gpt-4o',
    schema: { name: 'string', age: 'number' },
  });
  assert.deepStrictEqual(value, { name: 'Ada', age: 36 });
  assert.strictEqual(calls.length, 1, 'local repair must not trigger a healing call');
  assert.strictEqual(calls[0].url, 'https://api.openai.com/v1/chat/completions');
  assert.strictEqual(calls[0].body.response_format.type, 'json_schema');
  assert.strictEqual(calls[0].body.response_format.json_schema.strict, true);
});

test('openai extract: syntax error healed via one cheap-model round-trip', async () => {
  const calls = [];
  const client = new SnapJson({
    apiKeys: { openai: 'sk-test' },
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ url, body });
      if (calls.length === 1) {
        // Missing comma: root closes, so local repair cannot fix it.
        return jsonResponse({ choices: [{ message: { content: '{"name": "Ada" "age": 36}' } }] });
      }
      return jsonResponse({ choices: [{ message: { content: '{"name": "Ada", "age": 36}' } }] });
    },
  });
  const value = await client.extract('Extract the person', {
    provider: 'openai',
    model: 'gpt-4o',
    schema: { name: 'string', age: 'number' },
  });
  assert.deepStrictEqual(value, { name: 'Ada', age: 36 });
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[1].body.model, 'gpt-4o-mini');
  assert.strictEqual(calls[1].body.temperature, 0);
  assert.ok(calls[1].body.messages[0].content.includes('Snippet:'));
});

test('anthropic extract: forced tool_use input is returned directly', async () => {
  const client = new SnapJson({
    apiKeys: { anthropic: 'key' },
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      assert.strictEqual(url, 'https://api.anthropic.com/v1/messages');
      assert.strictEqual(body.tool_choice.type, 'tool');
      assert.strictEqual(typeof body.max_tokens, 'number');
      return jsonResponse({
        content: [{ type: 'tool_use', name: 'emit_json', input: { ok: true } }],
        stop_reason: 'tool_use',
      });
    },
  });
  const value = await client.extract('x', {
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    schema: { ok: 'boolean' },
  });
  assert.deepStrictEqual(value, { ok: true });
});

test('anthropic streamObject: input_json_delta events fold into progressive partials', async () => {
  const partials = [];
  const client = new SnapJson({
    apiKeys: { anthropic: 'key' },
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      assert.strictEqual(body.stream, true);
      return sseResponse([
        { type: 'message_start' },
        { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"title": "Re' } },
        { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: 'port", "count":' } },
        { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: ' 2}' } },
        { type: 'message_stop' },
      ]);
    },
  });
  const final = await client.streamObject(
    'Summarize',
    { provider: 'anthropic', model: 'claude-sonnet-5', schema: { title: 'string', count: 'number' } },
    (partial) => partials.push(structuredClone(partial)),
  );
  assert.deepStrictEqual(final, { title: 'Report', count: 2 });
  assert.deepStrictEqual(partials[0], { title: 'Re' });
  assert.deepStrictEqual(partials.at(-1), { title: 'Report', count: 2 });
  assert.ok(partials.length >= 2);
});

test('openai streamObject: delta.content SSE with [DONE] terminator', async () => {
  const partials = [];
  const client = new SnapJson({
    apiKeys: { openai: 'sk' },
    fetch: async () =>
      sseResponse(
        [
          { choices: [{ delta: { content: '{"tags": ["a"' } }] },
          { choices: [{ delta: { content: ', "b"], "n": 5}' } }] },
        ],
        { done: true },
      ),
  });
  const final = await client.streamObject(
    'x',
    { provider: 'openai', model: 'gpt-4o', schema: { tags: ['string'], n: 'number' } },
    (partial) => partials.push(structuredClone(partial)),
  );
  assert.deepStrictEqual(final, { tags: ['a', 'b'], n: 5 });
  assert.deepStrictEqual(partials[0], { tags: ['a'] });
});

test('gemini extract: responseSchema request, unknown key pruned, wrong type healed', async () => {
  const calls = [];
  const client = new SnapJson({
    apiKeys: { gemini: 'key' },
    defaultProvider: 'gemini',
    fetch: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      if (calls.length === 1) {
        return jsonResponse({
          candidates: [{ content: { parts: [{ text: '{"ok": "yes", "extra": 1}' }] } }],
        });
      }
      return jsonResponse({ candidates: [{ content: { parts: [{ text: 'true' }] } }] });
    },
  });
  const value = await client.extract('Check', { model: 'gemini-2.5-pro', schema: { ok: 'boolean' } });
  assert.deepStrictEqual(value, { ok: true });
  assert.ok(calls[0].url.endsWith('models/gemini-2.5-pro:generateContent'));
  assert.strictEqual(calls[0].body.generationConfig.responseMimeType, 'application/json');
  assert.strictEqual(calls[0].body.generationConfig.responseSchema.type, 'OBJECT');
  assert.ok(calls[1].url.includes('gemini-2.0-flash'), 'validation healing uses the cheap model');
});

test('gemini streamObject uses the alt=sse streaming route', async () => {
  let seenUrl = '';
  const client = new SnapJson({
    apiKeys: { gemini: 'key' },
    fetch: async (url) => {
      seenUrl = url;
      return sseResponse([
        { candidates: [{ content: { parts: [{ text: '{"ok": ' }] } }] },
        { candidates: [{ content: { parts: [{ text: 'true}' }] } }] },
      ]);
    },
  });
  const value = await client.streamObject(
    'x',
    { provider: 'gemini', model: 'gemini-2.5-flash', schema: { ok: 'boolean' } },
    () => {},
  );
  assert.deepStrictEqual(value, { ok: true });
  assert.ok(seenUrl.endsWith(':streamGenerateContent?alt=sse'));
});

test('system prompts map to each provider native field', async () => {
  const bodies = {};
  const respond = {
    openai: jsonResponse({ choices: [{ message: { content: '{"ok": true}' } }] }),
    anthropic: jsonResponse({ content: [{ type: 'tool_use', input: { ok: true } }] }),
    gemini: jsonResponse({ candidates: [{ content: { parts: [{ text: '{"ok": true}' }] } }] }),
  };
  const client = new SnapJson({
    apiKeys: { openai: 'a', anthropic: 'b', gemini: 'c' },
    fetch: async (url, init) => {
      const provider = url.includes('openai') ? 'openai' : url.includes('anthropic') ? 'anthropic' : 'gemini';
      bodies[provider] = JSON.parse(init.body);
      return respond[provider];
    },
  });
  for (const provider of ['openai', 'anthropic', 'gemini']) {
    await client.extract('x', { provider, model: 'm', system: 'Be terse.', schema: { ok: 'boolean' } });
  }
  assert.deepStrictEqual(bodies.openai.messages[0], { role: 'system', content: 'Be terse.' });
  assert.strictEqual(bodies.anthropic.system, 'Be terse.');
  assert.strictEqual(bodies.gemini.systemInstruction.parts[0].text, 'Be terse.');
});

test('errors: missing provider, missing key, HTTP failure, refusal', async () => {
  const client = new SnapJson({ apiKeys: {}, fetch: async () => jsonResponse({}) });
  await assert.rejects(
    client.extract('x', { model: 'm', schema: { ok: 'boolean' } }),
    /No provider specified/,
  );
  await assert.rejects(
    client.extract('x', { provider: 'openai', model: 'm', schema: { ok: 'boolean' } }),
    /Missing API key/,
  );

  const failing = new SnapJson({
    apiKeys: { openai: 'k' },
    fetch: async () => new Response('rate limited', { status: 429 }),
  });
  await assert.rejects(
    failing.extract('x', { provider: 'openai', model: 'm', schema: { ok: 'boolean' } }),
    (error) => error instanceof SnapJsonError && error.status === 429,
  );

  const refusing = new SnapJson({
    apiKeys: { openai: 'k' },
    fetch: async () => jsonResponse({ choices: [{ message: { refusal: 'no', content: null } }] }),
  });
  await assert.rejects(
    refusing.extract('x', { provider: 'openai', model: 'm', schema: { ok: 'boolean' } }),
    /refused/,
  );
});

test('healing disabled: unparsable output raises instead of spending tokens', async () => {
  let calls = 0;
  const client = new SnapJson({
    apiKeys: { openai: 'k' },
    healing: { enabled: false },
    fetch: async () => {
      calls++;
      return jsonResponse({ choices: [{ message: { content: '{"a": 1} {"b": 2} nonsense}' } }] });
    },
  });
  await assert.rejects(
    client.extract('x', { provider: 'openai', model: 'm', schema: { name: 'string' } }),
    (error) => error instanceof SnapJsonError && /not valid JSON|validation/.test(error.message),
  );
  assert.strictEqual(calls, 1, 'no healing calls when disabled');
});

test('healing disabled: validation failure raises SnapJsonError with structured issues', async () => {
  const client = new SnapJson({
    apiKeys: { openai: 'k' },
    fetch: async () => jsonResponse({ choices: [{ message: { content: '{"age": "old"}' } }] }),
  });
  await assert.rejects(
    client.extract('x', {
      provider: 'openai',
      model: 'm',
      schema: { age: 'number' },
      healing: { enabled: false },
    }),
    (error) =>
      error instanceof SnapJsonError &&
      Array.isArray(error.issues) &&
      error.issues.some((issue) => issue.path === '$.age'),
  );
});

test('custom baseUrls route requests through a proxy', async () => {
  let seenUrl = '';
  const client = new SnapJson({
    apiKeys: { openai: 'k' },
    baseUrls: { openai: 'https://gateway.internal/v1' },
    fetch: async (url) => {
      seenUrl = url;
      return jsonResponse({ choices: [{ message: { content: '{"ok": true}' } }] });
    },
  });
  await client.extract('x', { provider: 'openai', model: 'm', schema: { ok: 'boolean' } });
  assert.strictEqual(seenUrl, 'https://gateway.internal/v1/chat/completions');
});
