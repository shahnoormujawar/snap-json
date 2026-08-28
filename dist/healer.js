/**
 * Micro-healing agent loop.
 *
 * When a final payload fails parsing or schema validation, the healer sends a
 * minimal corrective prompt — only the broken snippet and the error rule — to
 * a cheap fallback model, then splices the repaired snippet back into the
 * original output. The initial full prompt context is never re-run.
 */
const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_SNIPPET_RADIUS = 160;
const WHOLE_DOCUMENT_LIMIT = 12_000;
const MAX_ISSUES_PER_PASS = 5;
export class HealingError extends Error {
    lastParseError;
    constructor(message, lastParseError) {
        super(message);
        this.lastParseError = lastParseError;
        this.name = 'HealingError';
    }
}
export class PayloadHealer {
    maxAttempts;
    snippetRadius;
    constructor(options = {}) {
        this.maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
        this.snippetRadius = Math.max(32, options.snippetRadius ?? DEFAULT_SNIPPET_RADIUS);
    }
    /**
     * Repair a syntactically broken JSON string. Each attempt extracts the
     * snippet around the reported error position, asks the fallback model for
     * the corrected snippet only, splices it back, and re-parses. The window
     * doubles on every failed attempt; as a last resort a payload under
     * 12k characters is sent whole.
     */
    async healPayload(brokenJson, errorMsg, fallbackClient) {
        let radius = this.snippetRadius;
        let lastError = errorMsg;
        for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
            const position = extractErrorPosition(lastError, brokenJson);
            const start = Math.max(0, position - radius);
            const end = Math.min(brokenJson.length, position + radius);
            const snippet = brokenJson.slice(start, end);
            let reply;
            try {
                reply = cleanModelReply(await fallbackClient(snippetPrompt(snippet, lastError)));
            }
            catch (error) {
                throw new HealingError(`fallback model call failed: ${errorMessage(error)}`, lastError);
            }
            const candidate = brokenJson.slice(0, start) + reply + brokenJson.slice(end);
            try {
                return JSON.parse(candidate);
            }
            catch (error) {
                lastError = errorMessage(error);
                radius *= 2;
            }
        }
        if (brokenJson.length <= WHOLE_DOCUMENT_LIMIT) {
            const reply = cleanModelReply(await fallbackClient(wholeDocumentPrompt(brokenJson, lastError)));
            try {
                return JSON.parse(reply);
            }
            catch (error) {
                lastError = errorMessage(error);
            }
        }
        throw new HealingError(`healing failed after ${this.maxAttempts} snippet attempt(s)`, lastError);
    }
    /**
     * Repair schema-validation failures field by field. Only the invalid
     * sub-value, its path, and its expected schema fragment are sent — never
     * the whole document or the original prompt.
     */
    async healValidation(value, schema, fallbackClient) {
        let current = value;
        for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
            const issues = validatePayload(current, schema);
            if (issues.length === 0)
                return current;
            for (const issue of issues.slice(0, MAX_ISSUES_PER_PASS)) {
                const subValue = getAtPath(current, issue.segments);
                const expected = schemaAtPath(schema, issue.segments);
                const prompt = [
                    'A JSON field failed validation.',
                    `Path: ${issue.path}`,
                    `Problem: ${issue.message}`,
                    expected ? `Expected schema: ${JSON.stringify(expected)}` : '',
                    `Current value: ${JSON.stringify(subValue)}`,
                    'Reply with ONLY the corrected JSON value for this path. No markdown fences, no commentary.',
                ]
                    .filter((line) => line.length > 0)
                    .join('\n');
                let reply;
                try {
                    reply = cleanModelReply(await fallbackClient(prompt));
                }
                catch (error) {
                    throw new HealingError(`fallback model call failed: ${errorMessage(error)}`);
                }
                try {
                    current = setAtPath(current, issue.segments, JSON.parse(reply));
                }
                catch {
                    // Unparsable correction — leave the field for the next pass.
                }
            }
        }
        return current;
    }
}
/** Convenience wrapper matching the documented utility signature. */
export async function healPayload(brokenJson, errorMsg, fallbackClient) {
    return new PayloadHealer().healPayload(brokenJson, errorMsg, fallbackClient);
}
/** Structural validation of a parsed value against the canonical schema. */
export function validatePayload(value, schema, path = '$', segments = []) {
    const issues = [];
    const fail = (message) => {
        issues.push({ path, segments: [...segments], message });
    };
    if (value === null) {
        if (schema.nullable || schema.type === 'null')
            return issues;
        fail(`expected ${schema.type}, got null`);
        return issues;
    }
    switch (schema.type) {
        case 'null':
            fail('expected null');
            return issues;
        case 'string':
            if (typeof value !== 'string') {
                fail(`expected string, got ${describe(value)}`);
                return issues;
            }
            break;
        case 'boolean':
            if (typeof value !== 'boolean') {
                fail(`expected boolean, got ${describe(value)}`);
                return issues;
            }
            break;
        case 'number':
            if (typeof value !== 'number' || !Number.isFinite(value)) {
                fail(`expected number, got ${describe(value)}`);
                return issues;
            }
            break;
        case 'integer':
            if (typeof value !== 'number' || !Number.isInteger(value)) {
                fail(`expected integer, got ${describe(value)}`);
                return issues;
            }
            break;
        case 'object': {
            if (typeof value !== 'object' || Array.isArray(value)) {
                fail(`expected object, got ${describe(value)}`);
                return issues;
            }
            const record = value;
            const properties = schema.properties ?? {};
            for (const key of schema.required ?? Object.keys(properties)) {
                if (!(key in record))
                    fail(`missing required property "${key}"`);
            }
            for (const [key, member] of Object.entries(record)) {
                const memberSchema = properties[key];
                if (memberSchema) {
                    issues.push(...validatePayload(member, memberSchema, `${path}.${key}`, [...segments, key]));
                }
                else if (schema.additionalProperties === false) {
                    fail(`unexpected property "${key}"`);
                }
            }
            break;
        }
        case 'array': {
            if (!Array.isArray(value)) {
                fail(`expected array, got ${describe(value)}`);
                return issues;
            }
            if (schema.items) {
                for (let i = 0; i < value.length; i++) {
                    issues.push(...validatePayload(value[i], schema.items, `${path}[${i}]`, [...segments, i]));
                }
            }
            break;
        }
    }
    if (schema.enum && !schema.enum.some((candidate) => candidate === value)) {
        fail(`value ${JSON.stringify(value)} is not in the allowed enum`);
    }
    return issues;
}
/**
 * Free local structural healing: strip keys the schema forbids
 * (additionalProperties: false) before spending tokens on model calls.
 */
export function pruneUnknownKeys(value, schema) {
    if (value === null || typeof value !== 'object')
        return value;
    if (schema.type === 'array' && Array.isArray(value)) {
        const items = schema.items;
        if (items) {
            for (let i = 0; i < value.length; i++)
                value[i] = pruneUnknownKeys(value[i], items);
        }
        return value;
    }
    if (schema.type === 'object' && !Array.isArray(value)) {
        const record = value;
        const properties = schema.properties ?? {};
        for (const key of Object.keys(record)) {
            const memberSchema = properties[key];
            if (memberSchema) {
                record[key] = pruneUnknownKeys(record[key], memberSchema);
            }
            else if (schema.additionalProperties === false) {
                delete record[key];
            }
        }
    }
    return value;
}
function describe(value) {
    if (Array.isArray(value))
        return 'array';
    return typeof value;
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function cleanModelReply(reply) {
    let out = reply.trim();
    const fence = /^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?\s*```$/.exec(out);
    if (fence)
        out = fence[1].trim();
    return out;
}
function snippetPrompt(snippet, errorMsg) {
    return [
        'Fix the JSON syntax error described below.',
        'Output ONLY the corrected snippet text, preserving all data. No markdown fences, no commentary, no extra wrapping.',
        'The snippet may begin or end mid-document; keep its boundaries exactly as given.',
        `Error: ${errorMsg}`,
        'Snippet:',
        snippet,
    ].join('\n');
}
function wholeDocumentPrompt(document, errorMsg) {
    return [
        'The following JSON document is invalid.',
        `Error: ${errorMsg}`,
        'Reply with ONLY the corrected, complete JSON document. No markdown fences, no commentary.',
        'Document:',
        document,
    ].join('\n');
}
/** Best-effort extraction of the error offset from a JSON.parse message (V8 and Firefox formats). */
function extractErrorPosition(errorMsg, text) {
    const positionMatch = /position (\d+)/i.exec(errorMsg);
    if (positionMatch)
        return Math.min(Number(positionMatch[1]), text.length);
    const lineColumnMatch = /line (\d+) column (\d+)/i.exec(errorMsg);
    if (lineColumnMatch) {
        return positionFromLineColumn(text, Number(lineColumnMatch[1]), Number(lineColumnMatch[2]));
    }
    return text.length; // truncation errors ("unexpected end") report no position
}
function positionFromLineColumn(text, line, column) {
    let index = 0;
    for (let currentLine = 1; currentLine < line; currentLine++) {
        const newline = text.indexOf('\n', index);
        if (newline === -1)
            break;
        index = newline + 1;
    }
    return Math.min(text.length, index + column - 1);
}
function getAtPath(root, segments) {
    let current = root;
    for (const segment of segments) {
        if (current === null || typeof current !== 'object')
            return undefined;
        current = current[String(segment)];
    }
    return current;
}
function setAtPath(root, segments, next) {
    if (segments.length === 0)
        return next;
    let current = root;
    for (let i = 0; i < segments.length - 1; i++) {
        if (current === null || typeof current !== 'object')
            return root;
        current = current[String(segments[i])];
    }
    if (current !== null && typeof current === 'object') {
        current[String(segments[segments.length - 1])] = next;
    }
    return root;
}
function schemaAtPath(schema, segments) {
    let current = schema;
    for (const segment of segments) {
        if (!current)
            return undefined;
        current = typeof segment === 'number' ? current.items : current.properties?.[String(segment)];
    }
    return current;
}
//# sourceMappingURL=healer.js.map