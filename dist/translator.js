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
const TYPE_NAMES = new Set([
    'object',
    'array',
    'string',
    'number',
    'integer',
    'boolean',
    'null',
]);
const PRIMITIVE_HINTS = new Set(['string', 'number', 'integer', 'boolean']);
export class SchemaTranslator {
    translate(template, provider, name = 'emit_json') {
        const schema = this.normalize(template);
        switch (provider) {
            case 'openai':
                return {
                    provider,
                    schema,
                    requestFragment: {
                        response_format: {
                            type: 'json_schema',
                            json_schema: { name, strict: true, schema: this.emitStandard(schema, true) },
                        },
                    },
                };
            case 'anthropic':
                return {
                    provider,
                    schema,
                    requestFragment: {
                        tools: [
                            {
                                name,
                                description: 'Emit the final structured result as JSON matching the input schema exactly.',
                                input_schema: this.emitStandard(schema, false),
                            },
                        ],
                        tool_choice: { type: 'tool', name },
                    },
                };
            case 'gemini':
                return {
                    provider,
                    schema,
                    requestFragment: {
                        generationConfig: {
                            responseMimeType: 'application/json',
                            responseSchema: this.emitGemini(schema),
                        },
                    },
                };
        }
    }
    /**
     * Resolve a caller-supplied template to the canonical schema. An object is
     * treated as an explicit schema when its `type` field is a JSON Schema type
     * name (with `properties`/`items` present for object/array); anything else
     * is inferred by example. A template that needs a literal field named
     * `type` holding a type-name hint must be written as an explicit schema.
     */
    normalize(template) {
        if (this.isExplicitSchema(template))
            return this.sanitize(template);
        return this.infer(template);
    }
    isExplicitSchema(template) {
        if (typeof template !== 'object' || template === null || Array.isArray(template))
            return false;
        const type = template.type;
        if (typeof type !== 'string' || !TYPE_NAMES.has(type))
            return false;
        if (type === 'object')
            return 'properties' in template;
        if (type === 'array')
            return 'items' in template;
        return true;
    }
    /** Deep-copy an explicit schema, keeping only supported fields and filling defaults. */
    sanitize(schema) {
        const out = { type: schema.type };
        if (schema.description !== undefined)
            out.description = schema.description;
        if (schema.nullable !== undefined)
            out.nullable = schema.nullable;
        if (schema.enum !== undefined)
            out.enum = [...schema.enum];
        if (schema.type === 'object') {
            const properties = {};
            for (const [key, value] of Object.entries(schema.properties ?? {})) {
                properties[key] = this.sanitize(value);
            }
            out.properties = properties;
            out.required = schema.required ? [...schema.required] : Object.keys(properties);
            out.additionalProperties = schema.additionalProperties ?? false;
        }
        if (schema.type === 'array') {
            out.items = this.sanitize(schema.items ?? { type: 'string' });
        }
        return out;
    }
    infer(value) {
        if (typeof value === 'string')
            return this.hintToSchema(value);
        if (typeof value === 'number')
            return { type: 'number' };
        if (typeof value === 'boolean')
            return { type: 'boolean' };
        if (value === null || value === undefined)
            return { type: 'string', nullable: true };
        if (Array.isArray(value)) {
            return {
                type: 'array',
                items: value.length > 0 ? this.infer(value[0]) : { type: 'string' },
            };
        }
        if (typeof value === 'object') {
            const properties = {};
            for (const [key, member] of Object.entries(value)) {
                properties[key] = this.infer(member);
            }
            return {
                type: 'object',
                properties,
                required: Object.keys(properties),
                additionalProperties: false,
            };
        }
        return { type: 'string' };
    }
    hintToSchema(hint) {
        const trimmed = hint.trim();
        const nullable = trimmed.endsWith('?');
        const base = (nullable ? trimmed.slice(0, -1) : trimmed).trim();
        if (PRIMITIVE_HINTS.has(base)) {
            const schema = { type: base };
            if (nullable)
                schema.nullable = true;
            return schema;
        }
        if (base.startsWith('enum:')) {
            const values = base
                .slice('enum:'.length)
                .split('|')
                .map((v) => v.trim())
                .filter((v) => v.length > 0);
            const schema = { type: 'string' };
            if (values.length > 0)
                schema.enum = values;
            if (nullable)
                schema.nullable = true;
            return schema;
        }
        // Any other string is a natural-language description of a string field.
        const schema = { type: 'string' };
        if (trimmed.length > 0)
            schema.description = trimmed;
        return schema;
    }
    /**
     * Standard JSON Schema emitter (OpenAI, Anthropic). With `strict` true the
     * output satisfies OpenAI structured-outputs constraints: every property
     * required and `additionalProperties: false` on every object.
     */
    emitStandard(schema, strict) {
        const out = {
            type: schema.nullable && schema.type !== 'null' ? [schema.type, 'null'] : schema.type,
        };
        if (schema.description)
            out.description = schema.description;
        if (schema.enum)
            out.enum = schema.enum;
        if (schema.type === 'object') {
            const source = schema.properties ?? {};
            const keys = Object.keys(source);
            const properties = {};
            for (const key of keys)
                properties[key] = this.emitStandard(source[key], strict);
            out.properties = properties;
            out.required = strict ? keys : schema.required ?? keys;
            out.additionalProperties = false;
        }
        if (schema.type === 'array') {
            out.items = this.emitStandard(schema.items ?? { type: 'string' }, strict);
        }
        return out;
    }
    /** Gemini responseSchema emitter: uppercase Type enum, nullable, propertyOrdering. */
    emitGemini(schema) {
        const out = {
            type: schema.type === 'null' ? 'STRING' : schema.type.toUpperCase(),
        };
        if (schema.description)
            out.description = schema.description;
        if (schema.nullable || schema.type === 'null')
            out.nullable = true;
        if (schema.enum && schema.type === 'string')
            out.enum = schema.enum;
        if (schema.type === 'object') {
            const source = schema.properties ?? {};
            const keys = Object.keys(source);
            const properties = {};
            for (const key of keys)
                properties[key] = this.emitGemini(source[key]);
            out.properties = properties;
            if (keys.length > 0) {
                out.required = schema.required ?? keys;
                out.propertyOrdering = keys;
            }
        }
        if (schema.type === 'array') {
            out.items = this.emitGemini(schema.items ?? { type: 'string' });
        }
        return out;
    }
}
//# sourceMappingURL=translator.js.map