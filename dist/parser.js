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
export function repairJson(raw) {
    let startIndex = -1;
    for (let i = 0; i < raw.length; i++) {
        const c = raw[i];
        if (c === '{' || c === '[') {
            startIndex = i;
            break;
        }
    }
    if (startIndex === -1)
        return '';
    const text = raw.slice(startIndex);
    const stack = [];
    let inString = false;
    let stringIsKey = false;
    let stringStart = -1;
    let escape = 'none';
    let escapeStart = -1;
    let unicodeDigits = 0;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inString) {
            if (escape === 'char') {
                if (c === 'u') {
                    escape = 'unicode';
                    unicodeDigits = 0;
                }
                else {
                    escape = 'none';
                }
                continue;
            }
            if (escape === 'unicode') {
                unicodeDigits++;
                if (unicodeDigits === 4)
                    escape = 'none';
                continue;
            }
            if (c === '\\') {
                escape = 'char';
                escapeStart = i;
                continue;
            }
            if (c === '"')
                inString = false;
            continue;
        }
        switch (c) {
            case '"': {
                inString = true;
                stringStart = i;
                escape = 'none';
                const top = stack[stack.length - 1];
                stringIsKey = stack.length > 0 && top.closer === '}' && top.expectKey;
                continue;
            }
            case '{':
                stack.push({ closer: '}', cut: i + 1, expectKey: true });
                continue;
            case '[':
                stack.push({ closer: ']', cut: i + 1, expectKey: false });
                continue;
            case '}':
            case ']': {
                stack.pop();
                // Root closed: everything after it is trailing junk (prose, fences).
                if (stack.length === 0)
                    return text.slice(0, i + 1);
                const parent = stack[stack.length - 1];
                parent.cut = i + 1;
                parent.expectKey = false;
                continue;
            }
            case ',': {
                if (stack.length > 0) {
                    const top = stack[stack.length - 1];
                    top.cut = i; // truncating here removes the comma along with the broken tail
                    top.expectKey = top.closer === '}';
                }
                continue;
            }
            case ':': {
                if (stack.length > 0)
                    stack[stack.length - 1].expectKey = false;
                continue;
            }
            default:
                continue;
        }
    }
    let out;
    if (inString) {
        if (stringIsKey) {
            const top = stack[stack.length - 1];
            out = text.slice(0, top ? top.cut : stringStart);
        }
        else {
            // Close the partial string value; back out of a half-finished escape
            // first, since '"\u12"' would itself be invalid JSON.
            const cutAt = escape === 'none' ? text.length : escapeStart;
            out = `${text.slice(0, cutAt)}"`;
        }
    }
    else {
        out = text.trimEnd();
        const literalMatch = /[a-zA-Z]+$/.exec(out);
        if (literalMatch &&
            literalMatch[0] !== 'true' &&
            literalMatch[0] !== 'false' &&
            literalMatch[0] !== 'null') {
            out = out.slice(0, out.length - literalMatch[0].length);
        }
        while (/[.eE+\-]$/.test(out))
            out = out.slice(0, -1);
        out = out.trimEnd();
        const top = stack.length > 0 ? stack[stack.length - 1] : undefined;
        const last = out.length > 0 ? out[out.length - 1] : '';
        if (last === ':') {
            out = text.slice(0, top ? top.cut : 0);
        }
        else if (last === '"' && top !== undefined && top.closer === '}' && top.expectKey) {
            // A key string closed but never received its ':' — drop the dangling key.
            out = text.slice(0, top.cut);
        }
    }
    out = out.trimEnd();
    if (out.endsWith(','))
        out = out.slice(0, -1).trimEnd();
    for (let i = stack.length - 1; i >= 0; i--)
        out += stack[i].closer;
    return out;
}
export class StreamingJsonParser {
    buffer = '';
    lastGood = {};
    lastGoodKey = '';
    /**
     * Append a raw text delta and return the freshest structurally-complete
     * partial object. If the repaired buffer does not parse yet, the previous
     * good snapshot is returned unchanged.
     */
    parseStreamChunk(rawTextChunk) {
        this.buffer += rawTextChunk;
        const repaired = repairJson(this.buffer);
        if (repaired.length > 0) {
            try {
                const value = JSON.parse(repaired);
                if (value !== null && typeof value === 'object') {
                    this.lastGood = value;
                    this.lastGoodKey = JSON.stringify(value);
                }
            }
            catch {
                // Keep the previous snapshot; more text may complete the structure.
            }
        }
        return this.lastGood;
    }
    /** Full raw text accumulated so far (used for final parsing and healing). */
    get raw() {
        return this.buffer;
    }
    /** Serialized form of the last good partial — cheap change detection for emit gating. */
    get snapshotKey() {
        return this.lastGoodKey;
    }
    reset() {
        this.buffer = '';
        this.lastGood = {};
        this.lastGoodKey = '';
    }
}
const defaultParser = new StreamingJsonParser();
/** Stateful module-level convenience wrapper around a shared StreamingJsonParser. */
export function parseStreamChunk(rawTextChunk) {
    return defaultParser.parseStreamChunk(rawTextChunk);
}
/** Reset the shared parser used by the module-level parseStreamChunk. */
export function resetStreamParser() {
    defaultParser.reset();
}
//# sourceMappingURL=parser.js.map