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
export function defineTool(definition) {
    return {
        ...definition,
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
