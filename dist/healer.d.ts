/**
 * Micro-healing agent loop.
 *
 * When a final payload fails parsing or schema validation, the healer sends a
 * minimal corrective prompt — only the broken snippet and the error rule — to
 * a cheap fallback model, then splices the repaired snippet back into the
 * original output. The initial full prompt context is never re-run.
 */
import type { FallbackClient, JsonSchema, ValidationIssue } from './types.js';
export declare class HealingError extends Error {
    readonly lastParseError?: string | undefined;
    constructor(message: string, lastParseError?: string | undefined);
}
export interface PayloadHealerOptions {
    maxAttempts?: number;
    snippetRadius?: number;
}
export declare class PayloadHealer {
    private readonly maxAttempts;
    private readonly snippetRadius;
    constructor(options?: PayloadHealerOptions);
    /**
     * Repair a syntactically broken JSON string. Each attempt extracts the
     * snippet around the reported error position, asks the fallback model for
     * the corrected snippet only, splices it back, and re-parses. The window
     * doubles on every failed attempt; as a last resort a payload under
     * 12k characters is sent whole.
     */
    healPayload(brokenJson: string, errorMsg: string, fallbackClient: FallbackClient): Promise<any>;
    /**
     * Repair schema-validation failures field by field. Only the invalid
     * sub-value, its path, and its expected schema fragment are sent — never
     * the whole document or the original prompt.
     */
    healValidation(value: unknown, schema: JsonSchema, fallbackClient: FallbackClient): Promise<unknown>;
}
/** Convenience wrapper matching the documented utility signature. */
export declare function healPayload(brokenJson: string, errorMsg: string, fallbackClient: FallbackClient): Promise<any>;
/** Structural validation of a parsed value against the canonical schema. */
export declare function validatePayload(value: unknown, schema: JsonSchema, path?: string, segments?: ReadonlyArray<string | number>): ValidationIssue[];
/**
 * Free local structural healing: strip keys the schema forbids
 * (additionalProperties: false) before spending tokens on model calls.
 */
export declare function pruneUnknownKeys(value: unknown, schema: JsonSchema): unknown;
//# sourceMappingURL=healer.d.ts.map