/**
 * snap-json — guaranteed, safe, streaming structured JSON from LLMs with
 * zero runtime schema boilerplate.
 *
 * The orchestrator wires the schema translator, the streaming partial parser,
 * and the micro-healing loop over plain `fetch` against the official provider
 * routes, so it runs identically on Node (≥18), Bun, and browsers.
 */
import { SchemaTranslator } from './translator.js';
import { StreamingJsonParser, repairJson } from './parser.js';
import { PayloadHealer, validatePayload, pruneUnknownKeys } from './healer.js';
const DEFAULT_BASE_URLS = {
    openai: 'https://api.openai.com/v1',
    anthropic: 'https://api.anthropic.com/v1',
    gemini: 'https://generativelanguage.googleapis.com/v1beta',
};
const DEFAULT_HEALING_MODELS = {
    openai: 'gpt-4o-mini',
    anthropic: 'claude-haiku-4-5-20251001',
    gemini: 'gemini-2.0-flash',
};
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_SCHEMA_NAME = 'emit_json';
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
const HEALING_MAX_OUTPUT_TOKENS = 2048;
export class SnapJsonError extends Error {
    provider;
    status;
    issues;
    rawOutput;
    constructor(message, provider, status, issues, rawOutput) {
        super(message);
        this.provider = provider;
        this.status = status;
        this.issues = issues;
        this.rawOutput = rawOutput;
        this.name = 'SnapJsonError';
    }
}
export class SnapJson {
    config;
    translator = new SchemaTranslator();
    fetchImpl;
    constructor(config) {
        this.config = config;
        const fetchFn = config.fetch ?? (typeof fetch !== 'undefined' ? fetch : undefined);
        if (!fetchFn) {
            throw new SnapJsonError('No fetch implementation available: pass one via config.fetch or run on a platform with global fetch.');
        }
        // Arrow wrapper keeps the global fetch bound to its own realm ("Illegal invocation" guard).
        this.fetchImpl = (input, init) => fetchFn(input, init);
    }
    /** One-shot structured extraction: request → parse → (repair | heal) → validate. */
    async extract(prompt, options) {
        const provider = this.resolveProvider(options);
        const translated = this.translator.translate(options.schema, provider, options.schemaName ?? DEFAULT_SCHEMA_NAME);
        const request = this.buildRequest(provider, prompt, options, translated.requestFragment, false);
        const response = await this.send(provider, request, options.signal);
        const rawText = this.extractText(provider, response);
        return this.finalize(rawText, translated.schema, provider, options);
    }
    /**
     * Token-level partial streaming: every provider delta is folded into a
     * balanced partial object and emitted via the callback; the resolved value
     * is the fully parsed, healed, validated final object.
     */
    async streamObject(prompt, options, onChunk) {
        const provider = this.resolveProvider(options);
        const translated = this.translator.translate(options.schema, provider, options.schemaName ?? DEFAULT_SCHEMA_NAME);
        const request = this.buildRequest(provider, prompt, options, translated.requestFragment, true);
        const response = await this.fetchImpl(request.url, {
            method: 'POST',
            headers: request.headers,
            body: JSON.stringify(request.body),
            signal: options.signal,
        });
        if (!response.ok) {
            const detail = (await response.text().catch(() => '')).slice(0, 600);
            throw new SnapJsonError(`${provider} stream request failed (HTTP ${response.status}): ${detail}`, provider, response.status);
        }
        if (!response.body) {
            throw new SnapJsonError(`${provider} stream response had no body`, provider);
        }
        const parser = new StreamingJsonParser();
        const emitEveryDelta = options.emitOnlyOnChange === false;
        let lastSnapshot = '';
        for await (const event of sseEvents(response.body)) {
            if (provider === 'anthropic' && event?.type === 'error') {
                throw new SnapJsonError(`anthropic stream error: ${event?.error?.message ?? 'unknown'}`, provider);
            }
            const delta = this.extractDelta(provider, event);
            if (!delta)
                continue;
            const partial = parser.parseStreamChunk(delta);
            if (emitEveryDelta || parser.snapshotKey !== lastSnapshot) {
                lastSnapshot = parser.snapshotKey;
                onChunk(partial);
            }
        }
        return this.finalize(parser.raw, translated.schema, provider, options);
    }
    // ── pipeline ────────────────────────────────────────────────────────────
    async finalize(rawText, schema, provider, options) {
        const healing = this.resolveHealing(options);
        const cleaned = stripFences(rawText);
        let value;
        try {
            value = JSON.parse(cleaned);
        }
        catch (parseError) {
            // Free local repair first; paid healing only when that fails too.
            let repaired = false;
            try {
                value = JSON.parse(repairJson(cleaned));
                repaired = true;
            }
            catch {
                // fall through to healing
            }
            if (!repaired) {
                if (!healing.enabled) {
                    throw new SnapJsonError(`output is not valid JSON: ${errorText(parseError)}`, provider, undefined, undefined, rawText);
                }
                const healer = new PayloadHealer({
                    maxAttempts: healing.maxAttempts,
                    snippetRadius: healing.snippetRadius,
                });
                try {
                    value = await healer.healPayload(cleaned, errorText(parseError), this.makeFallbackClient(provider, healing, options.signal));
                }
                catch (healError) {
                    throw new SnapJsonError(`output is not valid JSON and healing failed: ${errorText(healError)}`, provider, undefined, undefined, rawText);
                }
            }
        }
        value = pruneUnknownKeys(value, schema);
        let issues = validatePayload(value, schema);
        if (issues.length > 0 && healing.enabled) {
            const healer = new PayloadHealer({
                maxAttempts: healing.maxAttempts,
                snippetRadius: healing.snippetRadius,
            });
            value = await healer.healValidation(value, schema, this.makeFallbackClient(provider, healing, options.signal));
            value = pruneUnknownKeys(value, schema);
            issues = validatePayload(value, schema);
        }
        if (issues.length > 0) {
            throw new SnapJsonError(`output failed schema validation: ${issues.map((i) => `${i.path} — ${i.message}`).join('; ')}`, provider, undefined, issues, rawText);
        }
        return value;
    }
    makeFallbackClient(primary, healing, signal) {
        let provider = healing.provider ?? primary;
        if (!this.config.apiKeys[provider])
            provider = primary;
        const model = healing.model ?? DEFAULT_HEALING_MODELS[provider];
        return async (prompt) => {
            const request = this.buildRequest(provider, prompt, { model, temperature: 0, maxOutputTokens: HEALING_MAX_OUTPUT_TOKENS }, {}, false);
            const response = await this.send(provider, request, signal);
            return this.extractText(provider, response);
        };
    }
    // ── transport ───────────────────────────────────────────────────────────
    buildRequest(provider, prompt, params, fragment, stream) {
        const key = this.apiKey(provider);
        const base = this.config.baseUrls?.[provider] ?? DEFAULT_BASE_URLS[provider];
        const maxTokens = params.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
        switch (provider) {
            case 'openai': {
                const messages = [];
                if (params.system)
                    messages.push({ role: 'system', content: params.system });
                messages.push({ role: 'user', content: prompt });
                return {
                    url: `${base}/chat/completions`,
                    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
                    body: {
                        model: params.model,
                        messages,
                        max_tokens: maxTokens,
                        ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
                        ...(stream ? { stream: true } : {}),
                        ...fragment,
                    },
                };
            }
            case 'anthropic': {
                return {
                    url: `${base}/messages`,
                    headers: {
                        'content-type': 'application/json',
                        'x-api-key': key,
                        'anthropic-version': ANTHROPIC_VERSION,
                        // Opt-in that lets the same client run in browsers (CORS).
                        'anthropic-dangerous-direct-browser-access': 'true',
                    },
                    body: {
                        model: params.model,
                        max_tokens: maxTokens,
                        messages: [{ role: 'user', content: prompt }],
                        ...(params.system ? { system: params.system } : {}),
                        ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
                        ...(stream ? { stream: true } : {}),
                        ...fragment,
                    },
                };
            }
            case 'gemini': {
                const fragmentGeneration = (fragment.generationConfig ?? {});
                const generationConfig = {
                    ...fragmentGeneration,
                    maxOutputTokens: maxTokens,
                };
                if (params.temperature !== undefined)
                    generationConfig.temperature = params.temperature;
                const action = stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
                return {
                    url: `${base}/models/${params.model}:${action}`,
                    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
                    body: {
                        contents: [{ role: 'user', parts: [{ text: prompt }] }],
                        ...(params.system
                            ? { systemInstruction: { parts: [{ text: params.system }] } }
                            : {}),
                        generationConfig,
                    },
                };
            }
        }
    }
    async send(provider, request, signal) {
        const response = await this.fetchImpl(request.url, {
            method: 'POST',
            headers: request.headers,
            body: JSON.stringify(request.body),
            signal,
        });
        if (!response.ok) {
            const detail = (await response.text().catch(() => '')).slice(0, 600);
            throw new SnapJsonError(`${provider} request failed (HTTP ${response.status}): ${detail}`, provider, response.status);
        }
        return response.json();
    }
    extractText(provider, response) {
        switch (provider) {
            case 'openai': {
                const message = response?.choices?.[0]?.message;
                if (typeof message?.refusal === 'string' && message.refusal) {
                    throw new SnapJsonError(`openai refused the request: ${message.refusal}`, provider);
                }
                const content = message?.content;
                if (typeof content !== 'string' || content.length === 0) {
                    throw new SnapJsonError('openai response contained no text content', provider);
                }
                return content;
            }
            case 'anthropic': {
                const blocks = Array.isArray(response?.content) ? response.content : [];
                const toolUse = blocks.find((block) => block?.type === 'tool_use');
                if (toolUse && toolUse.input !== undefined)
                    return JSON.stringify(toolUse.input);
                const text = blocks
                    .filter((block) => block?.type === 'text')
                    .map((block) => block.text ?? '')
                    .join('');
                if (text)
                    return text;
                throw new SnapJsonError(`anthropic response contained no tool_use or text content (stop_reason: ${response?.stop_reason ?? 'unknown'})`, provider);
            }
            case 'gemini': {
                const parts = response?.candidates?.[0]?.content?.parts ?? [];
                const text = parts.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('');
                if (text)
                    return text;
                const blockReason = response?.promptFeedback?.blockReason;
                throw new SnapJsonError(`gemini response contained no text${blockReason ? ` (blocked: ${blockReason})` : ''}`, provider);
            }
        }
    }
    extractDelta(provider, event) {
        switch (provider) {
            case 'openai': {
                const content = event?.choices?.[0]?.delta?.content;
                return typeof content === 'string' ? content : '';
            }
            case 'anthropic': {
                if (event?.type !== 'content_block_delta')
                    return '';
                const delta = event.delta;
                if (typeof delta?.partial_json === 'string')
                    return delta.partial_json;
                if (typeof delta?.text === 'string')
                    return delta.text;
                return '';
            }
            case 'gemini': {
                const parts = event?.candidates?.[0]?.content?.parts ?? [];
                return parts.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('');
            }
        }
    }
    // ── config resolution ───────────────────────────────────────────────────
    resolveProvider(options) {
        const provider = options.provider ?? this.config.defaultProvider;
        if (!provider) {
            throw new SnapJsonError('No provider specified: set options.provider or config.defaultProvider.');
        }
        return provider;
    }
    apiKey(provider) {
        const key = this.config.apiKeys[provider];
        if (!key)
            throw new SnapJsonError(`Missing API key for provider "${provider}"`, provider);
        return key;
    }
    resolveHealing(options) {
        const merged = { ...this.config.healing, ...options.healing };
        return {
            enabled: merged.enabled ?? true,
            maxAttempts: merged.maxAttempts ?? 2,
            snippetRadius: merged.snippetRadius ?? 160,
            provider: merged.provider,
            model: merged.model,
        };
    }
}
// ── helpers ───────────────────────────────────────────────────────────────
function stripFences(text) {
    const trimmed = text.trim();
    const fence = /^```(?:[a-zA-Z]*)\s*\n?([\s\S]*?)\n?\s*```$/.exec(trimmed);
    return fence ? fence[1].trim() : trimmed;
}
function errorText(error) {
    return error instanceof Error ? error.message : String(error);
}
/**
 * Minimal SSE reader over a fetch body. Uses the explicit reader API rather
 * than async iteration so it works on every runtime (Safari included).
 */
async function* sseEvents(stream) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done)
                break;
            if (value)
                buffer += decoder.decode(value, { stream: true });
            let newline;
            while ((newline = buffer.indexOf('\n')) !== -1) {
                const line = buffer.slice(0, newline).replace(/\r$/, '');
                buffer = buffer.slice(newline + 1);
                if (!line.startsWith('data:'))
                    continue;
                const payload = line.slice('data:'.length).trim();
                if (!payload || payload === '[DONE]')
                    continue;
                try {
                    yield JSON.parse(payload);
                }
                catch {
                    // Ignore keep-alives and non-JSON data lines.
                }
            }
        }
    }
    finally {
        reader.releaseLock();
    }
}
// ── public API surface ────────────────────────────────────────────────────
export { SchemaTranslator } from './translator.js';
export { StreamingJsonParser, parseStreamChunk, resetStreamParser, repairJson } from './parser.js';
export { PayloadHealer, HealingError, healPayload, validatePayload, pruneUnknownKeys, } from './healer.js';
export * from './types.js';
//# sourceMappingURL=index.js.map