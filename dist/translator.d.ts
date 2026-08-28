/**
 * SchemaTranslator — turns a plain template (or explicit minimal JSON Schema)
 * into the provider-native structured-output payload:
 *
 * - OpenAI: `response_format: { type: "json_schema", json_schema: { strict: true, ... } }`
 *   (the strict structured-outputs mode; every property required, no
 *   additional properties, nullability expressed as `["T", "null"]`).
 * - Anthropic: a forced tool call (`tools` + `tool_choice: { type: "tool" }`)
 *   whose `input_schema` is the target shape.
 * - Gemini: `generationConfig.responseSchema` with uppercase type enums,
 *   `nullable` flags, and `propertyOrdering` for stable key order.
 */
import type { JsonSchema, Provider, SchemaTemplate, TranslatedSchema } from './types.js';
export declare class SchemaTranslator {
    translate(template: SchemaTemplate, provider: Provider, name?: string): TranslatedSchema;
    /**
     * Resolve a caller-supplied template to the canonical schema. An object is
     * treated as an explicit schema when its `type` field is a JSON Schema type
     * name (with `properties`/`items` present for object/array); anything else
     * is inferred by example. A template that needs a literal field named
     * `type` holding a type-name hint must be written as an explicit schema.
     */
    normalize(template: SchemaTemplate): JsonSchema;
    private isExplicitSchema;
    /** Deep-copy an explicit schema, keeping only supported fields and filling defaults. */
    private sanitize;
    private infer;
    private hintToSchema;
    /**
     * Standard JSON Schema emitter (OpenAI, Anthropic). With `strict` true the
     * output satisfies OpenAI structured-outputs constraints: every property
     * required and `additionalProperties: false` on every object.
     */
    private emitStandard;
    /** Gemini responseSchema emitter: uppercase Type enum, nullable, propertyOrdering. */
    private emitGemini;
}
//# sourceMappingURL=translator.d.ts.map