# snap-json

> **Force any LLM to return strictly valid JSON.** One tiny API for OpenAI (GPT-4o), Anthropic Claude, and Google Gemini structured outputs — with streaming partial objects, automatic JSON repair, and self-healing retries. Zero dependencies. No Zod required.

```bash
npm install snap-json
```

**The problem:** LLMs wrap JSON in markdown fences, cut it off mid-string, miss commas, invent keys, and return `"36"` when you asked for a number.

**The fix:** snap-json constrains the generation *and* guarantees the result — you get a typed object matching your schema, or a typed error. Never malformed output.

```ts
import { SnapJson } from 'snap-json';

const client = new SnapJson({ apiKeys: { openai: process.env.OPENAI_API_KEY } });

const person = await client.extract<{ name: string; age: number }>(
  'Ada Lovelace was 36 when she died.',
  { provider: 'openai', model: 'gpt-4o', schema: { name: 'string', age: 'number' } },
);
// ✅ { name: 'Ada Lovelace', age: 36 }  — always. Or a SnapJsonError. Never garbage.
```

---

## Why snap-json?

| | snap-json | Zod + Instructor-style | Raw SDK calls |
|---|---|---|---|
| Runtime dependencies | **0** | Zod + provider SDKs | provider SDK each |
| Schema definition | Plain object template | Zod chains | Hand-written JSON Schema |
| OpenAI + Claude + Gemini | ✅ one API | varies | 3 different APIs |
| Streaming **partial objects** | ✅ | varies | ❌ raw text deltas |
| Broken-output recovery | Free local repair → snippet-only healing | Full prompt retry 💸 | ❌ |
| Runs on | Node ≥18 · Bun · Deno · browsers · edge | Node mostly | varies |

---

## Table of contents

- [Quick start](#quick-start)
- [Schemas with zero boilerplate](#schemas-with-zero-boilerplate)
- [Streaming partial objects](#streaming-partial-objects)
- [The JSON guarantee pipeline](#the-json-guarantee-pipeline)
- [Configuration](#configuration)
- [Error handling](#error-handling)
- [Low-level utilities](#low-level-utilities)
- [Provider details](#provider-details)
- [FAQ](#faq)

---

## Quick start

```ts
import { SnapJson } from 'snap-json';

const client = new SnapJson({
  apiKeys: {
    openai: process.env.OPENAI_API_KEY,       // only the providers you use
    anthropic: process.env.ANTHROPIC_API_KEY,
    gemini: process.env.GEMINI_API_KEY,
  },
  defaultProvider: 'openai',                  // optional
});

interface Invoice {
  vendor: string;
  total: number;
  currency: 'USD' | 'EUR' | 'GBP';
  lineItems: { description: string; amount: number }[];
}

const invoice = await client.extract<Invoice>(emailBody, {
  model: 'gpt-4o',
  schema: {
    vendor: 'the company that issued the invoice',
    total: 'number',
    currency: 'enum:USD|EUR|GBP',
    lineItems: [{ description: 'string', amount: 'number' }],
  },
});
```

Switching providers is one word — the schema, the call, and the result shape stay identical:

```ts
await client.extract<Invoice>(emailBody, { provider: 'anthropic', model: 'claude-sonnet-5', schema });
await client.extract<Invoice>(emailBody, { provider: 'gemini', model: 'gemini-2.5-flash', schema });
```

---

## Schemas with zero boilerplate

Describe the shape you want as a plain object. Values are hints:

| You write | You get |
|---|---|
| `'string'` `'number'` `'integer'` `'boolean'` | that exact type |
| `'number?'` (any hint + `?`) | nullable field |
| `'enum:red\|green\|blue'` | string restricted to those values |
| `'the customer's full name'` | a **string** with that description (guides the model!) |
| `42`, `true` | type inferred from the example |
| `['string']` / `[{ id: 'integer' }]` | array of that item shape |
| `{ nested: { ... } }` | nested object, all fields required |

```ts
schema: {
  title: 'string',
  sentiment: 'enum:positive|neutral|negative',
  confidence: 'number',
  summary: 'a one-sentence summary in plain English',
  mentions: [{ name: 'string', role: 'string?' }],
}
```

<details>
<summary><b>Need full control? Pass an explicit JSON Schema</b></summary>

A minimal JSON Schema subset is accepted anywhere a template is:

```ts
schema: {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['open', 'closed'] },
    count: { type: 'integer' },
    note: { type: 'string', nullable: true },
  },
  required: ['status', 'count'],
  additionalProperties: false,
}
```

Supported keywords: `type`, `properties`, `required`, `items`, `enum`, `description`, `nullable`, `additionalProperties`.
</details>

---

## Streaming partial objects

`streamObject` gives you **valid, parseable partial objects** on every change while the model is still generating — not raw text deltas. Perfect for streaming UIs.

```ts
const article = await client.streamObject<Article>(
  'Write a product announcement…',
  { provider: 'anthropic', model: 'claude-sonnet-5', schema: { headline: 'string', paragraphs: ['string'] } },
  (partial) => {
    // Fires as the JSON grows. Every partial is real data:
    // { headline: 'Introd' }
    // { headline: 'Introducing snap-json' }
    // { headline: 'Introducing snap-json', paragraphs: ['LLMs are...'] }
    render(partial);
  },
);
// resolves with the complete, validated object
```

How it stays valid mid-stream: a single-pass balancer closes dangling strings, drops half-typed keys (never inventing data), trims incomplete numbers/literals, and balances brackets — so `JSON.parse` succeeds on every snapshot.

Options: pass `emitOnlyOnChange: false` to receive a callback on every token delta instead of only when the object changes.

---

## The JSON guarantee pipeline

Every response passes through four stages, ordered cheapest-first:

```
1. CONSTRAIN   the request itself forces JSON output
               (OpenAI strict json_schema · Claude forced tool call · Gemini responseSchema)
        │
2. REPAIR      free, local, instant — fixes truncation, markdown fences,
               trailing prose, unbalanced brackets
        │
3. HEAL        only if still broken: the invalid SNIPPET + the exact error
               go to a cheap model (gpt-4o-mini / Claude Haiku / Gemini Flash).
               Your original prompt is NEVER re-run. 💰
        │
4. VALIDATE    types, required keys, enums checked; unknown keys pruned free;
               per-field healing for mismatches; then → your typed object
               or a SnapJsonError with structured issues
```

---

## Configuration

### Client

```ts
const client = new SnapJson({
  apiKeys: { openai: '...', anthropic: '...', gemini: '...' },
  defaultProvider: 'openai',                       // used when a call omits `provider`
  baseUrls: { openai: 'https://my-gateway/v1' },   // proxies & gateways
  fetch: myCustomFetch,                            // testing, middleware, retries
  healing: { model: 'gpt-4o-mini', maxAttempts: 2 },
});
```

### Per-request options (`extract` and `streamObject`)

| Option | Type | Default | What it does |
|---|---|---|---|
| `provider` | `'openai' \| 'anthropic' \| 'gemini'` | client default | which API to call |
| `model` | `string` | — (required) | model id |
| `schema` | template or JSON Schema | — (required) | target shape |
| `system` | `string` | — | system prompt (mapped to each provider's native field) |
| `temperature` | `number` | provider default | sampling temperature |
| `maxOutputTokens` | `number` | `4096` | output cap |
| `schemaName` | `string` | `'emit_json'` | tool / json_schema envelope name |
| `signal` | `AbortSignal` | — | cancellation |
| `healing` | object | see below | per-request healing override |
| `emitOnlyOnChange` | `boolean` | `true` | *(streaming only)* callback gating |

### Healing options

```ts
healing: {
  enabled: true,          // false = throw instead of spending tokens
  maxAttempts: 2,         // snippet-repair round-trips
  provider: 'openai',     // where corrective calls go (default: same as request)
  model: 'gpt-4o-mini',   // default per provider: gpt-4o-mini / claude-haiku / gemini-flash
  snippetRadius: 160,     // context chars sent around the error position
}
```

---

## Error handling

Everything throws `SnapJsonError` — one type to catch, with structured fields:

```ts
import { SnapJson, SnapJsonError } from 'snap-json';

try {
  const data = await client.extract<Order>(text, options);
} catch (error) {
  if (error instanceof SnapJsonError) {
    error.provider;   // 'openai' | 'anthropic' | 'gemini'
    error.status;     // HTTP status when the API call itself failed (e.g. 429)
    error.issues;     // ValidationIssue[] — [{ path: '$.total', message: 'expected number, got string' }]
    error.rawOutput;  // the model's original text, for logging
  }
}
```

You'll get an error (not silent bad data) when: the API call fails, the model refuses, or output can't be made schema-valid within the healing budget.

---

## Low-level utilities

Every pipeline stage is exported for building your own flows:

```ts
import {
  repairJson,           // (text) => balanced, parseable JSON string — pure, instant
  parseStreamChunk,     // stateful: feed deltas, get the latest partial object
  StreamingJsonParser,  // class version with .raw, .reset(), isolated state
  SchemaTranslator,     // template → provider-native payload fragments
  validatePayload,      // (value, schema) => ValidationIssue[]
  healPayload,          // (brokenJson, errorMsg, fallbackClient) => fixed value
  pruneUnknownKeys,     // free local cleanup of forbidden keys
} from 'snap-json';

repairJson('{"items": [1, 2');          // → '{"items": [1, 2]}'
repairJson('```json\n{"a": 1}\n```');   // → '{"a": 1}'
```

---

## Provider details

| | OpenAI | Anthropic Claude | Google Gemini |
|---|---|---|---|
| Mechanism | `response_format: json_schema` (strict mode) | forced tool call (`tool_choice: {type: 'tool'}`) | `responseMimeType` + `responseSchema` |
| Streaming | `delta.content` SSE | `input_json_delta` SSE | `alt=sse` chunks |
| Endpoint | `/v1/chat/completions` | `/v1/messages` | `models/{model}:generateContent` |
| Auth header | `Authorization: Bearer` | `x-api-key` | `x-goog-api-key` |

Transport is plain `fetch` — no provider SDKs — so the same bundle runs on Node ≥18, Bun, Deno, browsers (Anthropic's CORS opt-in header included), and edge runtimes. Point `baseUrls` at any OpenAI-compatible gateway.

---

## FAQ

<details>
<summary><b>How do I make GPT-4o / ChatGPT always return JSON?</b></summary>

Use `extract` with `provider: 'openai'`. snap-json enables OpenAI's strict structured-outputs mode (`response_format: { type: 'json_schema', strict: true }`) and repairs/heals anything that still slips through — truncation at the token limit being the common one.
</details>

<details>
<summary><b>Does Claude have a JSON mode?</b></summary>

Not natively. snap-json uses Anthropic's recommended pattern — a forced tool call whose `input_schema` is your shape — and normalizes the tool input back to a plain object, so Claude behaves exactly like the other providers.
</details>

<details>
<summary><b>Can I parse incomplete or streaming JSON on its own?</b></summary>

Yes — `repairJson` (pure function) and `parseStreamChunk` / `StreamingJsonParser` (stateful) work standalone on any partial JSON text, no API keys involved.
</details>

<details>
<summary><b>What does healing cost?</b></summary>

Usually nothing: constrained generation plus free local repair handles the typical failures. When a paid heal does trigger, it sends ~a few hundred tokens (the broken snippet + error rule) to a budget model — not your full prompt re-run. Set `healing: { enabled: false }` for a strict throw-on-invalid mode with zero extra calls.
</details>

<details>
<summary><b>Is it type-safe?</b></summary>

Built in strict TypeScript. `extract<T>` / `streamObject<T>` return your interface directly, `Partial<T>` flows through streaming callbacks, and the whole package ships `.d.ts` declarations.
</details>

<details>
<summary><b>Bundle size?</b></summary>

~28 kB packed, zero dependencies, tree-shakeable ESM (`sideEffects: false`). Import just `repairJson` and bundlers drop the rest.
</details>

---

## License

MIT
