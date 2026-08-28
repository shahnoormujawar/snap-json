/**
 * snap-json — guaranteed, safe, streaming structured JSON from LLMs with
 * zero runtime schema boilerplate.
 *
 * The orchestrator wires the schema translator, the streaming partial parser,
 * and the micro-healing loop over plain `fetch` against the official provider
 * routes, so it runs identically on Node (≥18), Bun, and browsers.
 */
import type { ExtractionOptions, SnapJsonConfig, Provider, StreamChunkCallback, StreamOptions, ValidationIssue } from './types.js';
export declare class SnapJsonError extends Error {
    readonly provider?: Provider | undefined;
    readonly status?: number | undefined;
    readonly issues?: ValidationIssue[] | undefined;
    readonly rawOutput?: string | undefined;
    constructor(message: string, provider?: Provider | undefined, status?: number | undefined, issues?: ValidationIssue[] | undefined, rawOutput?: string | undefined);
}
export declare class SnapJson {
    private readonly config;
    private readonly translator;
    private readonly fetchImpl;
    constructor(config: SnapJsonConfig);
    /** One-shot structured extraction: request → parse → (repair | heal) → validate. */
    extract<T>(prompt: string, options: ExtractionOptions): Promise<T>;
    /**
     * Token-level partial streaming: every provider delta is folded into a
     * balanced partial object and emitted via the callback; the resolved value
     * is the fully parsed, healed, validated final object.
     */
    streamObject<T>(prompt: string, options: StreamOptions, onChunk: StreamChunkCallback<T>): Promise<T>;
    private finalize;
    private makeFallbackClient;
    private buildRequest;
    private send;
    private extractText;
    private extractDelta;
    private resolveProvider;
    private apiKey;
    private resolveHealing;
}
export { SchemaTranslator } from './translator.js';
export { StreamingJsonParser, parseStreamChunk, resetStreamParser, repairJson } from './parser.js';
export { PayloadHealer, HealingError, healPayload, validatePayload, pruneUnknownKeys, } from './healer.js';
export * from './types.js';
//# sourceMappingURL=index.d.ts.map