# snap-json

**Force any LLM to return strictly valid JSON.** Structured outputs for **OpenAI (GPT-4o)**, **Anthropic Claude**, and **Google Gemini** with guaranteed schema-conformant results — a zero-dependency, TypeScript-first **Instructor alternative** with no Zod required.

```bash
npm install snap-json
```

- ✅ **Guaranteed valid JSON** — parse → repair → heal → validate pipeline; you get a typed object or a typed error, never malformed output
- 🪶 **Zero dependencies, zero schema boilerplate** — describe your shape as a plain object template; no Zod, ArkType, or JSON Schema hand-writing needed (explicit JSON Schema also supported)
- 🔀 **One API, three providers** — automatically translated to OpenAI strict `json_schema` mode, Anthropic forced tool calling, and Gemini `responseSchema`
- 🌊 **Streaming partial JSON** — token-level incremental parsing emits structurally complete partial objects while the model is still generating
- 🩹 **Self-healing retries at minimum cost** — free local JSON repair first; if that fails, only the broken snippet (not your prompt) is sent to a cheap model (gpt-4o-mini / Claude Haiku / Gemini Flash)
- 🌍 **Runs everywhere** — plain `fetch` transport: Node ≥18, Bun, Deno, browsers, edge runtimes

## Quick start: extract structured data from an LLM

```ts
import { SnapJson } from 'snap-json';

const client = new SnapJson({
  apiKeys: {
    openai: process.env.OPENAI_API_KEY,
    anthropic: process.env.ANTHROPIC_API_KEY,
    gemini: process.env.GEMINI_API_KEY,
  },
});

interface Person {
  name: string;
  age: number;
  email: string;
}

const person = await client.extract<Person>(
  'Extract the person from: "Ada Lovelace, 36, reachable at ada@analytical.dev"',
  {
    provider: 'openai',            // or 'anthropic' | 'gemini'
    model: 'gpt-4o',
    schema: {
      name: "the person's full name",
      age: 'number',
      email: 'string',
    },
  },
);
// -> { name: 'Ada Lovelace', age: 36, email: 'ada@analytical.dev' }
```

The schema is a plain template. String values are type hints (`"string"`, `"number"`, `"integer"`, `"boolean"`, add `?` for nullable, `"enum:a|b|c"` for enums); any other string becomes the field's description. Nested objects and arrays just nest. You can also pass a real (minimal) JSON Schema when you need full control.

## Streaming JSON objects (partial results while generating)

```ts
const report = await client.streamObject<Report>(
  'Summarize this quarter…',
  { provider: 'anthropic', model: 'claude-sonnet-5', schema: { title: 'string', bullets: ['string'] } },
  (partial) => render(partial),   // fires with valid, parseable partial objects on every change
);
```

Each token delta is folded into a balanced JSON snapshot — dangling strings are closed, half-typed keys dropped, brackets balanced — so every emitted partial is real, `JSON.parse`-clean data. Perfect for streaming UIs.

## How the JSON guarantee works

1. **Constrained generation** — the request itself forces JSON: OpenAI strict structured outputs (`response_format: json_schema`), Anthropic forced tool call (`tool_choice: {type: "tool"}`), Gemini `responseMimeType: application/json` + `responseSchema`.
2. **Local repair (free)** — truncated or fence-wrapped output is fixed by a single-pass balancing parser before any extra API call.
3. **Micro-healing (cheap)** — if the payload is still broken, only the invalid snippet plus the exact parse/validation error is sent to a low-cost fallback model and spliced back. Your original prompt is never re-run.
4. **Schema validation** — types, required keys, enums, and unknown-key pruning; per-field healing for anything that still mismatches. If it can't be made valid, you get a `SnapJsonError` with structured `issues` — never silent garbage.

## Why not Zod + Instructor / Vercel AI SDK `generateObject`?

| | snap-json | Instructor-style + Zod |
|---|---|---|
| Runtime dependencies | **0** | Zod + provider SDKs |
| Schema definition | Plain object template | Zod chains |
| Providers | OpenAI, Claude, Gemini — one API | Varies |
| Broken-output recovery | Local repair + snippet-only healing | Full prompt retry (expensive) |
| Streaming partial objects | ✅ built in | Varies |

Use snap-json when you want structured extraction, JSON mode, or function-calling-grade reliability without pulling a schema library into your bundle.

## API surface

- `new SnapJson(config)` — API keys, optional base URLs (proxies/gateways), custom `fetch`, default provider, healing defaults
- `client.extract<T>(prompt, options)` — one-shot structured extraction
- `client.streamObject<T>(prompt, options, onChunk)` — streaming with typed partials
- Lower-level exports for building your own pipeline: `SchemaTranslator`, `StreamingJsonParser` / `parseStreamChunk`, `repairJson`, `PayloadHealer` / `healPayload`, `validatePayload`

Healing is configurable per client or per request:

```ts
new SnapJson({
  apiKeys: { ... },
  healing: { model: 'gpt-4o-mini', maxAttempts: 2 }, // or { enabled: false }
});
```

## FAQ

**How do I make ChatGPT / GPT-4o always return JSON?** Use `extract` with `provider: 'openai'` — snap-json enables strict structured outputs and repairs anything that still slips through.

**Does Claude support JSON mode?** Not natively — snap-json emulates it with forced tool calling, which is Anthropic's recommended approach, and normalizes the result to a plain object.

**Can I parse incomplete / streaming JSON?** Yes — `streamObject`, or use `parseStreamChunk` / `repairJson` standalone on any partial JSON string.

**TypeScript?** Strict-mode types throughout; `extract<T>` and `streamObject<T>` return your interface directly.

## License

MIT
