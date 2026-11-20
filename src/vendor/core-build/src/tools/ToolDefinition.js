/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { zod } from '../third_party/index.js';
import { TOOL_ERROR_CODES } from '../ToolError.js';
export const TOOL_CAPABILITIES = [
    'debugger',
    'network',
    'websocket',
    'devtools-ui',
];
export const TOOL_OUTPUT_SCHEMA = {
    ok: zod.boolean().describe('Whether the tool completed successfully.'),
    tool: zod.string().describe('Stable MCP tool name.'),
    summary: zod.string().describe('Concise human-readable outcome.'),
    data: zod
        .record(zod.string(), zod.unknown())
        .optional()
        .describe('Machine-readable result payload.'),
    error: zod
        .object({
        code: zod.enum(TOOL_ERROR_CODES).describe('Stable error code.'),
        message: zod.string(),
        retryable: zod.boolean(),
    })
        .optional(),
};
export const PAGINATION_OUTPUT_SCHEMA = zod.object({
    pageIdx: zod.number().int(),
    pageSize: zod.number().int(),
    totalItems: zod.number().int(),
    totalPages: zod.number().int(),
    hasNextPage: zod.boolean(),
    hasPreviousPage: zod.boolean().optional(),
});
export function createToolOutputSchema(dataSchema) {
    return {
        ...TOOL_OUTPUT_SCHEMA,
        data: zod.object(dataSchema).optional(),
    };
}
/**
 * Local change: make a tool's input schema reject unknown arguments.
 *
 * Zod objects default to "strip": `{ url: 'x' }` against a schema that only knows
 * `urlFilter` parses successfully and yields `{}`. For an evidence tool that is
 * worse than an error, because the tool then answers a question nobody asked and
 * the caller cannot tell the filter was ignored.
 *
 * Applied centrally in defineTool so no individual tool can forget it. Non-object
 * schemas (raw shapes are already plain objects of schemas, unions, etc.) pass
 * through untouched.
 */
export function strictToolSchema(schema) {
    if (!schema || typeof schema !== 'object')
        return schema;
    // Zod schema instance: prefer the built-in strict() which also preserves
    // .describe()/defaults and emits additionalProperties:false when introspected.
    if (typeof schema.strict === 'function' && typeof schema.safeParse === 'function') {
        return schema.strict();
    }
    // Raw shape ({ key: zodType }) — wrap it, which is what the MCP SDK does anyway.
    if (Object.values(schema).every((value) => value && typeof value.safeParse === 'function')) {
        return zod.object(schema).strict();
    }
    return schema;
}

/**
 * Local change: turn a strict-schema rejection into an actionable message.
 *
 * "Unrecognized keys: url, limit" tells the caller what is wrong but not what to
 * do. When a near-miss exists (`url` vs `urlFilter`, `limit` vs `pageSize`) the
 * useful answer is the accepted name. A plain error still leaves the caller
 * guessing, and guessing is what produced the bad call in the first place.
 *
 * Returns null when the issue is not about unknown keys, so ordinary validation
 * errors keep the SDK's own message.
 */
export function describeUnknownKeys(issue, acceptedNames) {
    if (!issue || issue.code !== 'unrecognized_keys')
        return null;
    const unknown = issue.keys ?? [];
    if (unknown.length === 0)
        return null;
    const hints = unknown.map((key) => {
        const suggestion = closestName(key, acceptedNames);
        return suggestion ? `"${key}" is not a parameter of this tool; did you mean "${suggestion}"?` : `"${key}" is not a parameter of this tool.`;
    });
    const accepted = acceptedNames.length ? ` Accepted parameters: ${acceptedNames.join(', ')}.` : '';
    return `${hints.join(' ')}${accepted}`;
}

/** Cheap edit-distance suggestion. Exact case-insensitive match wins outright. */
function closestName(input, candidates) {
    if (!candidates.length)
        return null;
    const lower = String(input).toLowerCase();
    let best = null;
    let bestScore = Infinity;
    for (const candidate of candidates) {
        const c = candidate.toLowerCase();
        if (c === lower)
            return candidate;
        // Substring containment catches url -> urlFilter and limit -> pageSize's
        // sibling `pageIdx`-style near misses that edit distance alone ranks oddly.
        const contains = c.includes(lower) || lower.includes(c);
        const distance = editDistance(lower, c);
        const score = contains ? distance - 10 : distance;
        if (score < bestScore) {
            bestScore = score;
            best = candidate;
        }
    }
    // Only suggest when plausibly related; otherwise a wrong guess is worse than none.
    const threshold = Math.max(3, Math.ceil(String(input).length / 2));
    return bestScore <= threshold ? best : null;
}

function editDistance(a, b) {
    if (a === b)
        return 0;
    const prev = new Array(b.length + 1);
    const cur = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++)
        prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
        cur[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        }
        for (let j = 0; j <= b.length; j++)
            prev[j] = cur[j];
    }
    return prev[b.length];
}

/** Accepted parameter names of a tool schema, for suggestions and error text. */
export function acceptedParameterNames(schema) {
    if (!schema || typeof schema !== 'object')
        return [];
    const shape = schema.shape ?? schema._def?.shape?.();
    if (!shape || typeof shape !== 'object')
        return [];
    return Object.keys(shape);
}

export function defineTool(definition) {
    return {
        ...definition,
        // Local change: reject unknown arguments instead of silently dropping them.
        //
        // Zod object schemas strip unrecognized keys by default, so a caller that
        // guesses a plausible-but-wrong parameter name (e.g. `url` instead of
        // `urlFilter`, or `limit` instead of `pageSize`) got a successful response
        // computed from *no filter at all*. That reads as "this tool has no such
        // filter" rather than "you passed the wrong name", which sends the caller
        // down a wrong path. `.strict()` turns it into an InvalidParams error naming
        // the offending keys, and also emits `additionalProperties: false` into the
        // advertised JSON Schema so the constraint is visible before the call.
        schema: strictToolSchema(definition.schema),
        annotations: {
            // MCP defaults destructiveHint to true when omitted. Make the ordinary
            // debugging/navigation tools explicitly non-destructive; tools that can
            // delete data or perform arbitrary page actions opt back into true and
            // require their own confirmation parameter.
            destructiveHint: false,
            ...definition.annotations,
        },
        outputSchema: definition.outputSchema ?? TOOL_OUTPUT_SCHEMA,
    };
}
export const CLOSE_PAGE_ERROR = 'The last open page cannot be closed. It is fine to keep it open.';
export const timeoutSchema = {
    timeout: zod
        .number()
        .int()
        .optional()
        .describe(`Maximum wait time in milliseconds. If set to 0, the default timeout will be used.`)
        .transform(value => {
        return value !== undefined && value <= 0 ? undefined : value;
    }),
};
export const paginationSchema = {
    pageSize: zod
        .number()
        .int()
        .positive()
        .optional()
        .describe('Maximum items per page. Defaults to 20.'),
    pageIdx: zod
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Page number (0-based). Defaults to 0.'),
};
