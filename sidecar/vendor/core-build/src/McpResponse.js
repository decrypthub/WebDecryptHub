/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { formatConsoleArgValue, formatConsoleEventShort, formatConsoleEventVerbose, } from './formatters/consoleFormatter.js';
import { getFormattedHeaderEntries, getFormattedResponseBody, getFormattedRequestBody, getFormattedRequestTiming, getFormattedSetCookieEntries, getHeadersExcludingSetCookie, getNetworkRequestExportHints, getPendingRequestStatus, getRequestHeadersArray, getResponseIfCompleted, getResponseHeadersArray, getShortDescriptionForRequestAsync, getSetCookieHeaders, getSetCookieFlowRequestLine, getSetCookieFlowValues, getStatusFromRequestAsync, isRequestPending, } from './formatters/networkFormatter.js';
import { formatWebSocketConnectionShort, formatWebSocketConnectionVerbose, } from './formatters/websocketFormatter.js';
import { formatBrowserUrlForOutput } from './LocalFileAccess.js';
import { ToolError } from './ToolError.js';
import { paginate } from './utils/pagination.js';
export class McpResponse {
    #includePages = false;
    #pagesPagination;
    #attachedNetworkRequestId;
    #attachedConsoleMessageId;
    #textResponseLines = [];
    #images = [];
    #networkRequestsOptions;
    #consoleDataOptions;
    #webSocketOptions;
    #attachedWebSocketId;
    #structuredData = {};
    setStructuredContent(value) {
        this.#structuredData = { ...this.#structuredData, ...value };
    }
    createStructuredContent(toolName) {
        return {
            ok: true,
            tool: toolName,
            summary: this.#textResponseLines.find(line => line.trim().length > 0) ??
                `${toolName} completed`,
            data: this.#structuredData,
        };
    }
    setIncludePages(value, options) {
        this.#includePages = value;
        this.#pagesPagination = value ? options : undefined;
    }
    setIncludeNetworkRequests(value, options) {
        if (!value) {
            this.#networkRequestsOptions = undefined;
            return;
        }
        this.#networkRequestsOptions = {
            include: value,
            pagination: options?.pageSize || options?.pageIdx
                ? {
                    pageSize: options.pageSize,
                    pageIdx: options.pageIdx,
                }
                : undefined,
            methods: options?.methods,
            resourceTypes: options?.resourceTypes,
            urlFilter: options?.urlFilter,
            cookieName: options?.cookieName,
            networkRequestIdInDevToolsUI: options?.networkRequestIdInDevToolsUI,
        };
    }
    setIncludeConsoleData(value, options) {
        if (!value) {
            this.#consoleDataOptions = undefined;
            return;
        }
        this.#consoleDataOptions = {
            include: value,
            pagination: options?.pageSize || options?.pageIdx
                ? {
                    pageSize: options.pageSize,
                    pageIdx: options.pageIdx,
                }
                : undefined,
            types: options?.types,
            includePreservedMessages: options?.includePreservedMessages,
        };
    }
    attachNetworkRequest(reqid) {
        this.#attachedNetworkRequestId = reqid;
    }
    attachConsoleMessage(msgid) {
        this.#attachedConsoleMessageId = msgid;
    }
    setIncludeWebSocketConnections(value, options) {
        if (!value) {
            this.#webSocketOptions = undefined;
            return;
        }
        this.#webSocketOptions = {
            include: value,
            pagination: options?.pageSize || options?.pageIdx
                ? {
                    pageSize: options.pageSize,
                    pageIdx: options.pageIdx,
                }
                : undefined,
            urlFilter: options?.urlFilter,
            includePreservedConnections: options?.includePreservedConnections,
        };
    }
    attachWebSocket(wsid) {
        this.#attachedWebSocketId = wsid;
    }
    get includePages() {
        return this.#includePages;
    }
    get includeNetworkRequests() {
        return this.#networkRequestsOptions?.include ?? false;
    }
    get includeConsoleData() {
        return this.#consoleDataOptions?.include ?? false;
    }
    get includeWebSocketConnections() {
        return this.#webSocketOptions?.include ?? false;
    }
    get attachedNetworkRequestId() {
        return this.#attachedNetworkRequestId;
    }
    get attachedWebSocketId() {
        return this.#attachedWebSocketId;
    }
    get networkRequestsPageIdx() {
        return this.#networkRequestsOptions?.pagination?.pageIdx;
    }
    get consoleMessagesPageIdx() {
        return this.#consoleDataOptions?.pagination?.pageIdx;
    }
    get consoleMessagesTypes() {
        return this.#consoleDataOptions?.types;
    }
    appendResponseLine(value) {
        this.#textResponseLines.push(value);
    }
    attachImage(value) {
        this.#images.push(value);
    }
    get responseLines() {
        return this.#textResponseLines;
    }
    get images() {
        return this.#images;
    }
    async handle(toolName, context) {
        if (this.#includePages) {
            await context.createPagesSnapshot();
        }
        const bodies = {};
        if (this.#attachedNetworkRequestId) {
            const request = context.getNetworkRequestById(this.#attachedNetworkRequestId);
            bodies.requestBody = await getFormattedRequestBody(request);
            const response = await getResponseIfCompleted(request);
            if (response) {
                bodies.responseBody = await getFormattedResponseBody(response);
            }
        }
        let consoleData;
        if (this.#attachedConsoleMessageId) {
            const message = context.getConsoleMessageById(this.#attachedConsoleMessageId);
            const consoleMessageStableId = this.#attachedConsoleMessageId;
            if ('args' in message) {
                const consoleMessage = message;
                consoleData = {
                    consoleMessageStableId,
                    type: consoleMessage.type(),
                    message: consoleMessage.text(),
                    args: await Promise.all(consoleMessage.args().map(async (arg) => {
                        const stringArg = await arg.jsonValue().catch(() => {
                            // Ignore errors.
                        });
                        return formatConsoleArgValue(stringArg);
                    })),
                };
            }
            else {
                consoleData = {
                    consoleMessageStableId,
                    type: 'error',
                    message: message.message,
                    args: [],
                };
            }
            this.setStructuredContent({ message: consoleData });
        }
        let consoleListData;
        if (this.#consoleDataOptions?.include) {
            let messages = context.getConsoleData(this.#consoleDataOptions.includePreservedMessages);
            if (this.#consoleDataOptions.types?.length) {
                const normalizedTypes = new Set(this.#consoleDataOptions.types);
                messages = messages.filter(message => {
                    if ('type' in message) {
                        return normalizedTypes.has(message.type());
                    }
                    return normalizedTypes.has('error');
                });
            }
            consoleListData = (await Promise.all(messages.map(async (item) => {
                const consoleMessageStableId = context.getConsoleMessageStableId(item);
                if ('args' in item) {
                    const consoleMessage = item;
                    return {
                        consoleMessageStableId,
                        type: consoleMessage.type(),
                        message: consoleMessage.text(),
                        argCount: consoleMessage.args().length,
                    };
                }
                return {
                    consoleMessageStableId,
                    type: 'error',
                    message: item.message,
                    args: [],
                };
            }))).filter(item => item !== null);
        }
        return this.format(toolName, context, {
            bodies,
            consoleData,
            consoleListData,
        });
    }
    async format(toolName, context, data) {
        const response = [`# ${toolName} response`];
        for (const line of this.#textResponseLines) {
            response.push(line);
        }
        if (this.#includePages) {
            const parts = [`## Pages`];
            const pages = context.getPages();
            const pageData = this.#dataWithPagination(pages, this.#pagesPagination);
            parts.push(...pageData.info);
            for (let offset = 0; offset < pageData.items.length; offset++) {
                const page = pageData.items[offset];
                const idx = pageData.startIndex + offset;
                parts.push(`${idx}: ${formatBrowserUrlForOutput(page.url())}${context.isPageSelected(page) ? ' [selected]' : ''}`);
            }
            response.push(...parts);
            this.setStructuredContent({
                pages: pageData.items.map((page, offset) => ({
                    pageIdx: pageData.startIndex + offset,
                    url: formatBrowserUrlForOutput(page.url()),
                    selected: context.isPageSelected(page),
                })),
                pagination: pageData.pagination,
            });
            // Show selected frame if not main frame
            const selectedFrame = context.getSelectedFrame();
            const mainFrame = context.getSelectedPage().mainFrame();
            if (selectedFrame !== mainFrame) {
                const name = selectedFrame.name()
                    ? ` name="${selectedFrame.name()}"`
                    : '';
                response.push(`## Selected Frame`);
                response.push(`${selectedFrame.url()}${name}`);
            }
        }
        response.push(...(await this.#formatNetworkRequestData(context, data.bodies)));
        response.push(...this.#formatConsoleData(data.consoleData));
        if (this.#networkRequestsOptions?.include) {
            let requests = context.getNetworkRequests();
            // Apply HTTP method filtering if specified (case-insensitive)
            if (this.#networkRequestsOptions.methods?.length) {
                const normalizedMethods = new Set(this.#networkRequestsOptions.methods.map(method => method.toUpperCase()));
                requests = requests.filter(request => normalizedMethods.has(request.method().toUpperCase()));
            }
            // Apply resource type filtering if specified
            if (this.#networkRequestsOptions.resourceTypes?.length) {
                const normalizedTypes = new Set(this.#networkRequestsOptions.resourceTypes);
                requests = requests.filter(request => {
                    const type = request.resourceType();
                    return normalizedTypes.has(type);
                });
            }
            // Apply URL filter if specified
            if (this.#networkRequestsOptions.urlFilter) {
                const filterPattern = this.#networkRequestsOptions.urlFilter.toLowerCase();
                requests = requests.filter(r => r.url().toLowerCase().includes(filterPattern));
            }
            const cookieName = this.#networkRequestsOptions.cookieName;
            if (cookieName) {
                const flowEntries = (await Promise.all(requests.map(async (request) => ({
                    request,
                    setCookieValues: await getSetCookieFlowValues(request, cookieName),
                })))).filter(({ setCookieValues }) => setCookieValues.length);
                response.push(`## Set-Cookie flow for ${cookieName}`);
                response.push('Matched response Set-Cookie updates, oldest first.');
                response.push('Coverage: current captured network queue only; earlier updates may be missing if capture started late or the FIFO queue rolled over.');
                const flowData = this.#dataWithPagination(flowEntries, this.#networkRequestsOptions.pagination);
                if (flowEntries.length) {
                    const updateLabel = flowEntries.length === 1 ? 'request update' : 'request updates';
                    response.push(`${flowEntries.length} ${updateLabel}`);
                    response.push(...flowData.info);
                    for (const { request, setCookieValues } of flowData.items) {
                        response.push(await getSetCookieFlowRequestLine(request, context.getNetworkRequestStableId(request), context.getNetworkRequestStableId(request) ===
                            this.#networkRequestsOptions?.networkRequestIdInDevToolsUI));
                        for (const setCookieValue of setCookieValues) {
                            response.push(`set-cookie: ${setCookieValue}`);
                        }
                    }
                }
                else {
                    response.push('No Set-Cookie updates found for this cookie in the current captured network queue.');
                }
                this.setStructuredContent({
                    cookieFlow: flowData.items.map(({ request, setCookieValues }) => ({
                        reqid: context.getNetworkRequestStableId(request),
                        url: request.url(),
                        method: request.method(),
                        setCookieValues,
                    })),
                    pagination: flowData.pagination,
                });
            }
            else {
                // Show newest requests first
                requests = [...requests].reverse();
                response.push('## Network requests');
                const data = this.#dataWithPagination(requests, this.#networkRequestsOptions.pagination ?? {
                    pageSize: 20,
                    pageIdx: 0,
                });
                if (requests.length) {
                    response.push(...data.info);
                    for (const request of data.items) {
                        response.push(await getShortDescriptionForRequestAsync(request, context.getNetworkRequestStableId(request), context.getNetworkRequestStableId(request) ===
                            this.#networkRequestsOptions?.networkRequestIdInDevToolsUI, true));
                    }
                }
                else {
                    response.push('No requests found.');
                }
                this.setStructuredContent({
                    requests: await Promise.all(data.items.map(async (request) => ({
                        reqid: context.getNetworkRequestStableId(request),
                        url: request.url(),
                        method: request.method(),
                        resourceType: request.resourceType(),
                        status: await getStatusFromRequestAsync(request),
                        pending: isRequestPending(request),
                    }))),
                    pagination: data.pagination,
                });
            }
        }
        if (this.#consoleDataOptions?.include) {
            const messages = data.consoleListData ?? [];
            response.push('## Console messages');
            const consoleData = this.#dataWithPagination(messages, this.#consoleDataOptions.pagination);
            if (messages.length) {
                response.push(...consoleData.info);
                response.push(...consoleData.items.map(message => formatConsoleEventShort(message)));
            }
            else {
                response.push('<no console messages found>');
            }
            this.setStructuredContent({
                messages: consoleData.items,
                pagination: consoleData.pagination,
            });
        }
        // WebSocket connections list
        if (this.#webSocketOptions?.include) {
            let connections = context.getWebSocketConnections(this.#webSocketOptions.includePreservedConnections);
            // Apply URL filter if specified
            if (this.#webSocketOptions.urlFilter) {
                const filterPattern = this.#webSocketOptions.urlFilter.toLowerCase();
                connections = connections.filter(ws => ws.connection.url.toLowerCase().includes(filterPattern));
            }
            response.push('## WebSocket connections');
            const paginatedData = this.#dataWithPagination(connections, this.#webSocketOptions.pagination);
            if (connections.length) {
                response.push(...paginatedData.info);
                for (const ws of paginatedData.items) {
                    response.push(formatWebSocketConnectionShort(ws, context.getWebSocketStableId(ws)));
                }
                // Hint for the same public tool and parameters exposed to the model.
                response.push(``);
                response.push(`> Tip: use \`get_websocket_messages(wsid=N, analyze=true)\` to group message patterns before opening specific frames.`);
            }
            else {
                response.push('<no WebSocket connections found>');
            }
            this.setStructuredContent({
                connections: paginatedData.items.map(ws => ({
                    wsid: context.getWebSocketStableId(ws),
                    url: ws.connection.url,
                    status: ws.connection.status,
                    frameCount: ws.frames.length,
                    version: ws.version,
                })),
                pagination: paginatedData.pagination,
            });
        }
        // Single WebSocket connection details
        if (this.#attachedWebSocketId !== undefined) {
            const ws = context.getWebSocketById(this.#attachedWebSocketId);
            response.push(...formatWebSocketConnectionVerbose(ws, this.#attachedWebSocketId));
        }
        const text = {
            type: 'text',
            text: response.join('\n'),
        };
        const images = this.#images.map(imageData => {
            return {
                type: 'image',
                ...imageData,
            };
        });
        return [text, ...images];
    }
    #dataWithPagination(data, pagination) {
        const response = [];
        const paginationResult = paginate(data, pagination);
        if (paginationResult.invalidPage) {
            throw new ToolError('INVALID_ARGUMENT', `pageIdx ${pagination?.pageIdx} is outside the available page range 0-${paginationResult.totalPages - 1}.`);
        }
        const { startIndex, endIndex, currentPage, totalPages } = paginationResult;
        response.push(data.length === 0
            ? `Showing 0 of 0 (Page ${currentPage + 1} of ${totalPages}).`
            : `Showing ${startIndex + 1}-${endIndex} of ${data.length} (Page ${currentPage + 1} of ${totalPages}).`);
        if (paginationResult.hasNextPage) {
            response.push(`Next page: ${currentPage + 1}`);
        }
        if (paginationResult.hasPreviousPage) {
            response.push(`Previous page: ${currentPage - 1}`);
        }
        return {
            info: response,
            items: paginationResult.items,
            startIndex,
            pagination: {
                pageIdx: currentPage,
                pageSize: pagination?.pageSize ?? 20,
                totalItems: data.length,
                totalPages,
                hasNextPage: paginationResult.hasNextPage,
                hasPreviousPage: paginationResult.hasPreviousPage,
            },
        };
    }
    #formatConsoleData(data) {
        const response = [];
        if (!data) {
            return response;
        }
        response.push(formatConsoleEventVerbose(data));
        return response;
    }
    async #formatNetworkRequestData(context, data) {
        const response = [];
        const id = this.#attachedNetworkRequestId;
        if (!id) {
            return response;
        }
        const httpRequest = context.getNetworkRequestById(id);
        this.setStructuredContent({
            request: {
                reqid: id,
                url: httpRequest.url(),
                method: httpRequest.method(),
                resourceType: httpRequest.resourceType(),
                status: await getStatusFromRequestAsync(httpRequest),
                pending: isRequestPending(httpRequest),
            },
        });
        response.push(`## Request ${httpRequest.url()}`);
        response.push(`Status:  ${await getStatusFromRequestAsync(httpRequest)}`);
        response.push(`### Timing`);
        response.push(...getFormattedRequestTiming(httpRequest));
        response.push(`### Request Headers`);
        for (const line of getFormattedHeaderEntries(await getRequestHeadersArray(httpRequest))) {
            response.push(line);
        }
        if (data.requestBody) {
            response.push(`### Request Body`);
            response.push(data.requestBody);
        }
        const httpResponse = await getResponseIfCompleted(httpRequest);
        if (httpResponse) {
            const responseHeaders = await getResponseHeadersArray(httpResponse);
            const responseHeadersWithoutSetCookie = getHeadersExcludingSetCookie(responseHeaders);
            if (responseHeadersWithoutSetCookie.length) {
                response.push(`### Response Headers`);
                for (const line of getFormattedHeaderEntries(responseHeadersWithoutSetCookie)) {
                    response.push(line);
                }
            }
            const setCookieHeaders = getSetCookieHeaders(responseHeaders);
            if (setCookieHeaders.length) {
                response.push(`### Set-Cookie`);
                response.push(...getFormattedSetCookieEntries(setCookieHeaders));
            }
        }
        if (isRequestPending(httpRequest)) {
            response.push(`### Pending Request`);
            response.push(`${getPendingRequestStatus()} Resume execution with pause_or_resume(action="resume"), then retry if you need response data.`);
        }
        if (data.responseBody) {
            response.push(`### Response Body`);
            response.push(data.responseBody);
        }
        const failure = httpRequest.failure();
        if (failure) {
            response.push(`### Request failed with`);
            response.push(failure.errorText);
        }
        const exportHints = await getNetworkRequestExportHints(httpRequest, id);
        if (exportHints.length) {
            response.push(`### Export hints`);
            for (const hint of exportHints) {
                response.push(`- ${hint}`);
            }
        }
        // In Playwright, there's no redirectChain() - use redirectedFrom() instead
        const redirectChain = [];
        let current = httpRequest.redirectedFrom();
        while (current) {
            redirectChain.push(current);
            current = current.redirectedFrom();
        }
        if (redirectChain.length) {
            response.push(`### Redirect chain`);
            let indent = 0;
            for (const request of redirectChain.reverse()) {
                response.push(`${'  '.repeat(indent)}${await getShortDescriptionForRequestAsync(request, context.getNetworkRequestStableId(request))}`);
                indent++;
            }
        }
        return response;
    }
    resetResponseLineForTesting() {
        this.#textResponseLines = [];
    }
}
