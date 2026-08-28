/**
 * Streaming partial-JSON utility.
 *
 * `repairJson` is a single-pass balancing routine: it walks the text once
 * with a string/escape-aware scanner, tracking a stack of open containers and
 * a per-container "safe cut" (the last point at which the container held only
 * complete members). The tail is then closed or trimmed so `JSON.parse` can
 * run on whatever prefix has arrived:
 *
 * - dangling string VALUES are closed (partial text is surfaced live),
 * - dangling KEYS, lone colons, and half-typed literals are dropped back to
 *   the safe cut (never invent members),
 * - trailing commas and incomplete number tails ('.', '-', 'e') are trimmed,
 * - open brackets/braces are balanced from the stack,
 * - prose or markdown fences before the first bracket and any trailing junk
 *   after the root closes are discarded.
 */
export declare function repairJson(raw: string): string;
export declare class StreamingJsonParser {
    private buffer;
    private lastGood;
    private lastGoodKey;
    /**
     * Append a raw text delta and return the freshest structurally-complete
     * partial object. If the repaired buffer does not parse yet, the previous
     * good snapshot is returned unchanged.
     */
    parseStreamChunk(rawTextChunk: string): Record<string, any>;
    /** Full raw text accumulated so far (used for final parsing and healing). */
    get raw(): string;
    /** Serialized form of the last good partial — cheap change detection for emit gating. */
    get snapshotKey(): string;
    reset(): void;
}
/** Stateful module-level convenience wrapper around a shared StreamingJsonParser. */
export declare function parseStreamChunk(rawTextChunk: string): Record<string, any>;
/** Reset the shared parser used by the module-level parseStreamChunk. */
export declare function resetStreamParser(): void;
//# sourceMappingURL=parser.d.ts.map