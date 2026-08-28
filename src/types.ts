/**
 * snap-json — core type definitions.
 *
 * The library is schema-library-free by design: schemas are either plain
 * example-shaped templates (inferred at runtime) or a minimal inline JSON
 * Schema subset. No Zod, no ArkType, no codegen.
 */

export type Provider = 'openai' | 'anthropic' | 'gemini';

export type JsonType =
  | 'object'
  | 'array'
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'null';

/** Minimal JSON Schema subset shared across all three providers. */
export interface JsonSchema {
  type: JsonType;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: ReadonlyArray<string | number | boolean | null>;
  additionalProperties?: boolean;
  nullable?: boolean;
}

/**
 * What callers pass as a schema: either an explicit {@link JsonSchema}, or a
 * zero-boilerplate template whose shape is inferred, e.g.
 * `{ name: "the person's name", age: "number", tags: ["string"] }`.
 *
 * Template string values are type hints ("string", "number", "integer",
 * "boolean", each optionally suffixed with "?" for nullable, or
 * "enum:a|b|c"); any other string becomes a described string field.
 */
export type SchemaTemplate = JsonSchema | Record<string, unknown> | readonly unknown[];

export interface HealingOptions {
  /** Master switch for the healing loop. Default: true. */
  enabled?: boolean;
  /** Maximum snippet-repair round-trips before giving up. Default: 2. */
  maxAttempts?: number;
  /** Provider used for corrective calls. Default: the primary request's provider. */
  provider?: Provider;
  /** Cheap fallback model id. Defaults per provider (gpt-4o-mini, claude-haiku-4-5, gemini-2.0-flash). */
  model?: string;
  /** Characters of context captured around a syntax error position. Default: 160. */
  snippetRadius?: number;
}

export interface SnapJsonConfig {
  /** API keys per provider; only the providers you call need a key. */
  apiKeys: Partial<Record<Provider, string>>;
  /** Base URL overrides (proxies, gateways). Defaults to the official routes. */
  baseUrls?: Partial<Record<Provider, string>>;
  /** Custom fetch implementation. Defaults to globalThis.fetch (Node ≥18, Bun, browsers). */
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Provider used when a request does not specify one. */
  defaultProvider?: Provider;
  /** Client-wide healing defaults; per-request options override these. */
  healing?: HealingOptions;
}

export interface RequestOptions {
  provider?: Provider;
  model: string;
  schema: SchemaTemplate;
  /** Name used for the emitted tool / json_schema envelope. Default: "emit_json". */
  schemaName?: string;
  /** System prompt, mapped to the provider's native system field. */
  system?: string;
  temperature?: number;
  /** Max output tokens. Default: 4096. Anthropic requires this field, so it is always sent. */
  maxOutputTokens?: number;
  /** Per-request healing overrides. */
  healing?: HealingOptions;
  signal?: AbortSignal;
}

export type ExtractionOptions = RequestOptions;

export interface StreamOptions extends RequestOptions {
  /**
   * When false, the chunk callback fires on every delta even if the parsed
   * partial object did not change. Default: true (emit only on change).
   */
  emitOnlyOnChange?: boolean;
}

/** Callback invoked with each new structurally-complete partial object. */
export type StreamChunkCallback<T> = (partial: Partial<T>) => void;

/** Provider-specific payload fragments produced by SchemaTranslator. */
export interface TranslatedSchema {
  provider: Provider;
  /** Canonical normalized schema, used for local validation. */
  schema: JsonSchema;
  /** Body fields to merge into the provider request payload. */
  requestFragment: Record<string, unknown>;
}

/** Minimal completion function the healer uses for corrective calls. */
export type FallbackClient = (prompt: string) => Promise<string>;

export interface ValidationIssue {
  /** Human-readable JSONPath-style location, e.g. "$.items[2].name". */
  path: string;
  /** Machine-usable path segments for get/set operations. */
  segments: Array<string | number>;
  message: string;
}
