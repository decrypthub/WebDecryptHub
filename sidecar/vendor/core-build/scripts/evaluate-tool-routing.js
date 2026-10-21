/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const MCP_SERVER_PATH = 'build/src/index.js';
const CORPUS_PATH = 'evals/tool-routing.json';
const EXPECTED_TOOL_COUNT = 24;
const MIN_CASES = 20;
const MAX_CASES = 30;
const REQUIRED_CATEGORIES = [
    'cookie_network',
    'initiator_breakpoint',
    'scripts',
    'websocket',
    'page_frame',
    'destructive_actions',
];
const ENDPOINT_ENV = 'MCP_ROUTING_EVAL_ENDPOINT';
const MODEL_ENV = 'MCP_ROUTING_EVAL_MODEL';
const API_KEY_ENV = 'MCP_ROUTING_EVAL_API_KEY';
const TIMEOUT_ENV = 'MCP_ROUTING_EVAL_TIMEOUT_MS';
const MIN_PASS_RATE_ENV = 'MCP_ROUTING_EVAL_MIN_PASS_RATE';
function isObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
}
function normalizeText(value) {
    return value.trim().replace(/\s+/g, ' ').toLowerCase();
}
function describeValue(value) {
    if (Array.isArray(value)) {
        return 'array';
    }
    if (value === null) {
        return 'null';
    }
    return typeof value;
}
function deepEqual(left, right) {
    if (Object.is(left, right)) {
        return true;
    }
    if (Array.isArray(left) && Array.isArray(right)) {
        return (left.length === right.length &&
            left.every((value, index) => deepEqual(value, right[index])));
    }
    if (isObject(left) && isObject(right)) {
        const leftKeys = Object.keys(left);
        const rightKeys = Object.keys(right);
        return (leftKeys.length === rightKeys.length &&
            leftKeys.every(key => key in right && deepEqual(left[key], right[key])));
    }
    return false;
}
function readStringField(value, field, context, errors) {
    const result = value[field];
    if (!isNonEmptyString(result)) {
        errors.push(`${context}.${field} must be a non-empty string.`);
        return '';
    }
    return result;
}
async function readCorpus() {
    const content = await fs.readFile(path.resolve(CORPUS_PATH), 'utf8');
    const parsed = JSON.parse(content);
    if (!isObject(parsed)) {
        throw new Error(`${CORPUS_PATH} must contain a JSON object.`);
    }
    const errors = [];
    if (parsed.version !== 1) {
        errors.push('version must be 1.');
    }
    if (!Number.isInteger(parsed.expectedToolCount)) {
        errors.push('expectedToolCount must be an integer.');
    }
    const rawCases = parsed.cases;
    if (!Array.isArray(rawCases)) {
        throw new Error(`${CORPUS_PATH}.cases must be an array.`);
    }
    const cases = rawCases.flatMap((value, index) => {
        const context = `cases[${index}]`;
        if (!isObject(value)) {
            errors.push(`${context} must be an object.`);
            return [];
        }
        const expectedArgs = value.expectedArgs;
        if (!isObject(expectedArgs)) {
            errors.push(`${context}.expectedArgs must be an object.`);
        }
        return [
            {
                id: readStringField(value, 'id', context, errors),
                category: readStringField(value, 'category', context, errors),
                prompt: readStringField(value, 'prompt', context, errors),
                expectedTool: readStringField(value, 'expectedTool', context, errors),
                expectedArgs: isObject(expectedArgs) ? expectedArgs : {},
            },
        ];
    });
    if (errors.length > 0) {
        throw new Error(`Invalid routing corpus:\n- ${errors.join('\n- ')}`);
    }
    return {
        version: parsed.version,
        expectedToolCount: parsed.expectedToolCount,
        cases,
    };
}
async function loadMcpMetadata() {
    const serverPath = path.resolve(MCP_SERVER_PATH);
    try {
        await fs.access(serverPath);
    }
    catch {
        throw new Error(`${MCP_SERVER_PATH} was not found. Run npm run build before this script.`);
    }
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [serverPath],
        // The transport's default allowlist already prevents eval credentials from
        // reaching the child. Consume stderr without echoing local paths or logs.
        stderr: 'pipe',
    });
    transport.stderr?.on('data', () => undefined);
    const client = new Client({ name: 'tool-routing-evaluator', version: '1.0.0' }, { capabilities: {} });
    try {
        await client.connect(transport);
        const tools = [];
        let cursor;
        do {
            const result = await client.listTools(cursor ? { cursor } : undefined);
            tools.push(...result.tools);
            cursor = result.nextCursor;
        } while (cursor);
        return {
            tools,
            instructions: client.getInstructions()?.trim() ?? '',
        };
    }
    finally {
        await client.close().catch(() => undefined);
    }
}
function schemaFor(tool) {
    return tool.inputSchema;
}
function validateSchemaValue(value, schema, location) {
    if (schema.const !== undefined && !deepEqual(value, schema.const)) {
        return [`${location} must equal ${JSON.stringify(schema.const)}.`];
    }
    if (schema.enum &&
        !schema.enum.some(candidate => deepEqual(value, candidate))) {
        return [`${location} is not one of the schema enum values.`];
    }
    if (schema.anyOf) {
        const matches = schema.anyOf.some(candidate => validateSchemaValue(value, candidate, location).length === 0);
        return matches ? [] : [`${location} does not match any schema branch.`];
    }
    if (schema.oneOf) {
        const matches = schema.oneOf.filter(candidate => validateSchemaValue(value, candidate, location).length === 0).length;
        return matches === 1
            ? []
            : [
                `${location} must match exactly one schema branch; matched ${matches}.`,
            ];
    }
    const allowedTypes = Array.isArray(schema.type)
        ? schema.type
        : schema.type
            ? [schema.type]
            : [];
    if (allowedTypes.length > 0) {
        const actualType = describeValue(value);
        const typeMatches = allowedTypes.some(type => {
            if (type === 'integer') {
                return typeof value === 'number' && Number.isInteger(value);
            }
            if (type === 'number') {
                return typeof value === 'number' && Number.isFinite(value);
            }
            return type === actualType;
        });
        if (!typeMatches) {
            return [
                `${location} has type ${actualType}; expected ${allowedTypes.join(' or ')}.`,
            ];
        }
    }
    const errors = [];
    if (typeof value === 'number') {
        if (schema.minimum !== undefined && value < schema.minimum) {
            errors.push(`${location} must be at least ${schema.minimum}.`);
        }
        if (schema.maximum !== undefined && value > schema.maximum) {
            errors.push(`${location} must be at most ${schema.maximum}.`);
        }
        if (schema.exclusiveMinimum !== undefined &&
            value <= schema.exclusiveMinimum) {
            errors.push(`${location} must be greater than ${schema.exclusiveMinimum}.`);
        }
        if (schema.exclusiveMaximum !== undefined &&
            value >= schema.exclusiveMaximum) {
            errors.push(`${location} must be less than ${schema.exclusiveMaximum}.`);
        }
    }
    if (typeof value === 'string') {
        if (schema.minLength !== undefined && value.length < schema.minLength) {
            errors.push(`${location} must contain at least ${schema.minLength} chars.`);
        }
        if (schema.maxLength !== undefined && value.length > schema.maxLength) {
            errors.push(`${location} must contain at most ${schema.maxLength} chars.`);
        }
        if (schema.pattern !== undefined &&
            !new RegExp(schema.pattern).test(value)) {
            errors.push(`${location} does not match the schema pattern.`);
        }
    }
    if (Array.isArray(value)) {
        if (schema.minItems !== undefined && value.length < schema.minItems) {
            errors.push(`${location} must contain at least ${schema.minItems} items.`);
        }
        if (schema.maxItems !== undefined && value.length > schema.maxItems) {
            errors.push(`${location} must contain at most ${schema.maxItems} items.`);
        }
        if (schema.items) {
            errors.push(...value.flatMap((item, index) => validateSchemaValue(item, schema.items, `${location}[${index}]`)));
        }
    }
    if (isObject(value)) {
        for (const required of schema.required ?? []) {
            if (!(required in value)) {
                errors.push(`${location}.${required} is required.`);
            }
        }
        for (const [key, child] of Object.entries(value)) {
            const childSchema = schema.properties?.[key];
            if (childSchema) {
                errors.push(...validateSchemaValue(child, childSchema, `${location}.${key}`));
            }
            else if (schema.additionalProperties === false) {
                errors.push(`${location}.${key} is not defined by the schema.`);
            }
            else if (isObject(schema.additionalProperties)) {
                errors.push(...validateSchemaValue(child, schema.additionalProperties, `${location}.${key}`));
            }
        }
    }
    return errors;
}
function validateArguments(tool, args, location) {
    const schema = schemaFor(tool);
    const properties = schema.properties ?? {};
    const errors = [];
    for (const required of schema.required ?? []) {
        if (!(required in args)) {
            errors.push(`${location}.${required} is required by ${tool.name}.`);
        }
    }
    for (const [key, value] of Object.entries(args)) {
        const propertySchema = properties[key];
        if (!propertySchema) {
            errors.push(`${location}.${key} is not an argument of ${tool.name}.`);
            continue;
        }
        errors.push(...validateSchemaValue(value, propertySchema, `${location}.${key}`));
    }
    return errors;
}
function effectiveTitle(tool) {
    return tool.title?.trim() || tool.annotations?.title?.trim() || '';
}
function addDuplicateErrors(values, label, errors) {
    const ownersByValue = new Map();
    for (const { owner, value } of values) {
        const normalized = normalizeText(value);
        const previous = ownersByValue.get(normalized);
        if (previous) {
            errors.push(`${label} is duplicated by ${previous} and ${owner}.`);
        }
        else {
            ownersByValue.set(normalized, owner);
        }
    }
}
function validateContract(corpus, metadata) {
    const errors = [];
    if (corpus.expectedToolCount !== EXPECTED_TOOL_COUNT) {
        errors.push(`Corpus expectedToolCount must remain ${EXPECTED_TOOL_COUNT}, got ${corpus.expectedToolCount}.`);
    }
    if (metadata.tools.length !== EXPECTED_TOOL_COUNT) {
        errors.push(`MCP must expose exactly ${EXPECTED_TOOL_COUNT} tools, got ${metadata.tools.length}.`);
    }
    if (!metadata.instructions) {
        errors.push('MCP server instructions must be non-empty.');
    }
    if (corpus.cases.length < MIN_CASES || corpus.cases.length > MAX_CASES) {
        errors.push(`Routing corpus must contain ${MIN_CASES}-${MAX_CASES} cases, got ${corpus.cases.length}.`);
    }
    const toolByName = new Map();
    const descriptions = [];
    const titles = [];
    for (const tool of metadata.tools) {
        if (toolByName.has(tool.name)) {
            errors.push(`Tool name ${tool.name} is exposed more than once.`);
        }
        toolByName.set(tool.name, tool);
        if (!isNonEmptyString(tool.description)) {
            errors.push(`${tool.name} must have a non-empty description.`);
        }
        else {
            descriptions.push({ owner: tool.name, value: tool.description });
        }
        const title = effectiveTitle(tool);
        if (!title) {
            errors.push(`${tool.name} must have a non-empty title.`);
        }
        else {
            titles.push({ owner: tool.name, value: title });
        }
        if (tool.inputSchema.type !== 'object') {
            errors.push(`${tool.name} inputSchema must have type=object.`);
        }
    }
    addDuplicateErrors(descriptions, 'Tool description', errors);
    addDuplicateErrors(titles, 'Tool title', errors);
    const ids = new Set();
    const prompts = new Set();
    const categories = new Set();
    const coveredTools = new Set();
    for (const testCase of corpus.cases) {
        if (ids.has(testCase.id)) {
            errors.push(`Routing case ID ${testCase.id} is duplicated.`);
        }
        ids.add(testCase.id);
        const normalizedPrompt = normalizeText(testCase.prompt);
        if (prompts.has(normalizedPrompt)) {
            errors.push(`Routing case prompt ${testCase.id} is duplicated.`);
        }
        prompts.add(normalizedPrompt);
        categories.add(testCase.category);
        const tool = toolByName.get(testCase.expectedTool);
        if (!tool) {
            errors.push(`${testCase.id} references unknown tool ${testCase.expectedTool}.`);
            continue;
        }
        coveredTools.add(tool.name);
        errors.push(...validateArguments(tool, testCase.expectedArgs, `${testCase.id}.expectedArgs`));
    }
    for (const category of REQUIRED_CATEGORIES) {
        if (!categories.has(category)) {
            errors.push(`Routing corpus is missing category ${category}.`);
        }
    }
    for (const tool of metadata.tools) {
        if (!coveredTools.has(tool.name)) {
            errors.push(`Routing corpus has no case for ${tool.name}.`);
        }
    }
    if (errors.length > 0) {
        throw new Error(`Routing contract validation failed:\n- ${errors.join('\n- ')}`);
    }
}
function compareExpectedArgs(expected, actual, location = 'arguments') {
    if (isObject(expected)) {
        if (!isObject(actual)) {
            return [`${location} must be an object.`];
        }
        return Object.entries(expected).flatMap(([key, value]) => key in actual
            ? compareExpectedArgs(value, actual[key], `${location}.${key}`)
            : [`${location}.${key} is missing.`]);
    }
    if (Array.isArray(expected)) {
        if (!Array.isArray(actual)) {
            return [`${location} must be an array.`];
        }
        const remaining = [...actual];
        const sameMembers = expected.every(item => {
            const index = remaining.findIndex(candidate => deepEqual(item, candidate));
            if (index === -1) {
                return false;
            }
            remaining.splice(index, 1);
            return true;
        });
        return sameMembers && remaining.length === 0
            ? []
            : [`${location} does not contain the expected array members.`];
    }
    return deepEqual(expected, actual)
        ? []
        : [`${location} does not match the expected value.`];
}
function parseToolCall(payload) {
    if (!isObject(payload) || !Array.isArray(payload.choices)) {
        throw new Error('Chat Completions response has no choices array.');
    }
    const choice = payload.choices[0];
    if (!isObject(choice) || !isObject(choice.message)) {
        throw new Error('Chat Completions response has no first message.');
    }
    const toolCalls = choice.message.tool_calls;
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
        throw new Error('Model returned no tool call.');
    }
    const firstCall = toolCalls[0];
    if (!isObject(firstCall) || !isObject(firstCall.function)) {
        throw new Error('First tool call has no function object.');
    }
    const name = firstCall.function.name;
    if (!isNonEmptyString(name)) {
        throw new Error('First tool call has no function name.');
    }
    const rawArguments = firstCall.function.arguments;
    let args;
    if (typeof rawArguments === 'string') {
        try {
            args = JSON.parse(rawArguments);
        }
        catch {
            throw new Error('First tool call arguments are not valid JSON.');
        }
    }
    else {
        args = rawArguments;
    }
    if (!isObject(args)) {
        throw new Error('First tool call arguments must be a JSON object.');
    }
    return { name, arguments: args };
}
function readTimeout() {
    const value = process.env[TIMEOUT_ENV];
    if (!value) {
        return 60_000;
    }
    const timeout = Number(value);
    if (!Number.isInteger(timeout) || timeout < 1_000) {
        throw new Error(`${TIMEOUT_ENV} must be an integer of at least 1000.`);
    }
    return timeout;
}
function readMinPassRate() {
    const value = process.env[MIN_PASS_RATE_ENV];
    if (!value) {
        return 1;
    }
    const rate = Number(value);
    if (!Number.isFinite(rate) || rate <= 0 || rate > 1) {
        throw new Error(`${MIN_PASS_RATE_ENV} must be greater than 0 and at most 1.`);
    }
    return rate;
}
function isLoopbackHostname(hostname) {
    const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return (normalized === 'localhost' ||
        normalized === '::1' ||
        /^127(?:\.\d{1,3}){3}$/.test(normalized));
}
async function requestToolCall(testCase, metadata, endpoint, model, apiKey, timeoutMs) {
    const headers = { 'content-type': 'application/json' };
    if (apiKey) {
        headers.authorization = `Bearer ${apiKey}`;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers,
            signal: controller.signal,
            body: JSON.stringify({
                model,
                temperature: 0,
                tool_choice: 'auto',
                messages: [
                    {
                        role: 'system',
                        content: `${metadata.instructions}\n\nFollow the server instructions. When a request needs browser state, evidence, or an action whose result is not already present in the prompt, take the best first action with an available tool. Do not invent browser observations.`,
                    },
                    { role: 'user', content: testCase.prompt },
                ],
                tools: metadata.tools.map(tool => ({
                    type: 'function',
                    function: {
                        name: tool.name,
                        description: tool.description,
                        parameters: tool.inputSchema,
                    },
                })),
            }),
        });
        if (!response.ok) {
            // Do not print a response body: compatible gateways may echo credentials
            // or internal request metadata in error payloads.
            throw new Error(`Routing endpoint returned HTTP ${response.status}.`);
        }
        let payload;
        try {
            payload = await response.json();
        }
        catch {
            throw new Error('Routing endpoint returned a non-JSON response.');
        }
        return parseToolCall(payload);
    }
    finally {
        clearTimeout(timeout);
    }
}
function redact(message) {
    const secrets = [
        process.env[API_KEY_ENV],
        // Endpoint URLs sometimes contain gateway credentials in their query.
        process.env[ENDPOINT_ENV],
    ].filter(isNonEmptyString);
    return secrets.reduce((result, secret) => result.split(secret).join('[REDACTED]'), message);
}
async function runLive(corpus, metadata) {
    const endpoint = process.env[ENDPOINT_ENV];
    const model = process.env[MODEL_ENV];
    const apiKey = process.env[API_KEY_ENV];
    if (!isNonEmptyString(endpoint)) {
        throw new Error(`${ENDPOINT_ENV} is required for --live.`);
    }
    if (!isNonEmptyString(model)) {
        throw new Error(`${MODEL_ENV} is required for --live.`);
    }
    const parsedEndpoint = new URL(endpoint);
    if (parsedEndpoint.protocol !== 'http:' &&
        parsedEndpoint.protocol !== 'https:') {
        throw new Error(`${ENDPOINT_ENV} must use http or https.`);
    }
    const endpointHasCredentials = isNonEmptyString(apiKey) ||
        parsedEndpoint.username.length > 0 ||
        parsedEndpoint.password.length > 0;
    if (parsedEndpoint.protocol === 'http:' &&
        endpointHasCredentials &&
        !isLoopbackHostname(parsedEndpoint.hostname)) {
        throw new Error('Credentialed routing endpoints must use HTTPS unless the endpoint is loopback.');
    }
    const timeoutMs = readTimeout();
    const minPassRate = readMinPassRate();
    const toolByName = new Map(metadata.tools.map(tool => [tool.name, tool]));
    let passed = 0;
    for (const testCase of corpus.cases) {
        try {
            const actual = await requestToolCall(testCase, metadata, endpoint, model, apiKey, timeoutMs);
            const errors = [];
            if (actual.name !== testCase.expectedTool) {
                errors.push(`expected ${testCase.expectedTool}, received ${actual.name}.`);
            }
            else {
                const tool = toolByName.get(actual.name);
                errors.push(...validateArguments(tool, actual.arguments, 'arguments'), ...compareExpectedArgs(testCase.expectedArgs, actual.arguments));
            }
            if (errors.length === 0) {
                passed++;
                console.log(`PASS ${testCase.id}: ${actual.name}`);
            }
            else {
                console.error(`FAIL ${testCase.id}: ${errors.join(' ')}`);
            }
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`FAIL ${testCase.id}: ${redact(message)}`);
        }
    }
    console.log(`Routing eval result: ${passed}/${corpus.cases.length} passed.`);
    const requiredPasses = Math.ceil(corpus.cases.length * minPassRate);
    if (passed < requiredPasses) {
        throw new Error(`Routing evaluation requires ${requiredPasses}/${corpus.cases.length} passes (${minPassRate * 100}%).`);
    }
}
async function main() {
    const validateOnly = process.argv.includes('--validate-only');
    const live = process.argv.includes('--live');
    if (validateOnly === live) {
        throw new Error('Pass exactly one of --validate-only or --live.');
    }
    const [corpus, metadata] = await Promise.all([
        readCorpus(),
        loadMcpMetadata(),
    ]);
    validateContract(corpus, metadata);
    console.log(`Validated ${metadata.tools.length} MCP tools and ${corpus.cases.length} routing cases.`);
    if (validateOnly) {
        console.log('Validation-only mode: no model endpoint was called.');
        return;
    }
    await runLive(corpus, metadata);
}
main().catch(error => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(redact(message));
    process.exitCode = 1;
});
