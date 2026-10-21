/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { addCdpEventListener, removeCdpEventListener } from './CdpEvents.js';
/**
 * DebuggerContext manages the Chrome DevTools Protocol Debugger domain.
 * It tracks loaded scripts, manages breakpoints, and provides search functionality.
 */
export class DebuggerContext {
    #client = null;
    #scripts = new Map(); // scriptId -> info
    #urlToScripts = new Map(); // url -> scriptId[]
    #breakpoints = new Map(); // breakpointId -> info
    #xhrBreakpoints = new Set(); // tracked XHR breakpoint URL patterns
    #enabled = false;
    #pausedState = { isPaused: false, callFrames: [] };
    /**
     * Enable the debugger and start tracking scripts.
     */
    async enable(client) {
        if (this.#enabled && this.#client === client) {
            return;
        }
        if (this.#client) {
            await this.disable({ preserveBreakpoints: true });
        }
        this.#client = client;
        this.#scripts.clear();
        this.#urlToScripts.clear();
        // Listen for script parsed events
        addCdpEventListener(client, 'Debugger.scriptParsed', this.#onScriptParsed);
        // Listen for paused/resumed events
        addCdpEventListener(client, 'Debugger.paused', this.#onPaused);
        addCdpEventListener(client, 'Debugger.resumed', this.#onResumed);
        try {
            // Enable after listeners are attached because Chrome emits the existing
            // scripts as part of Debugger.enable.
            await client.send('Debugger.enable');
            this.#enabled = true;
            // Set async call stack depth for better stack traces.
            try {
                await client.send('Debugger.setAsyncCallStackDepth', { maxDepth: 32 });
            }
            catch {
                // Ignore errors - some older versions may not support this.
            }
        }
        catch (error) {
            // A failed enable must be indistinguishable from one that never started:
            // leave no listeners/client behind so the next capability request can
            // retry safely.
            removeCdpEventListener(client, 'Debugger.scriptParsed', this.#onScriptParsed);
            removeCdpEventListener(client, 'Debugger.paused', this.#onPaused);
            removeCdpEventListener(client, 'Debugger.resumed', this.#onResumed);
            try {
                await client.send('Debugger.disable');
            }
            catch {
                // Best-effort rollback for a partially enabled CDP domain.
            }
            this.#scripts.clear();
            this.#urlToScripts.clear();
            this.#pausedState = { isPaused: false, callFrames: [] };
            this.#enabled = false;
            this.#client = null;
            throw error;
        }
    }
    /**
     * Disable the debugger.
     */
    async disable(options = {}) {
        const client = this.#client;
        if (client) {
            removeCdpEventListener(client, 'Debugger.scriptParsed', this.#onScriptParsed);
            removeCdpEventListener(client, 'Debugger.paused', this.#onPaused);
            removeCdpEventListener(client, 'Debugger.resumed', this.#onResumed);
            try {
                await client.send('Debugger.disable');
            }
            catch {
                // Ignore errors during cleanup.
            }
        }
        this.#scripts.clear();
        this.#urlToScripts.clear();
        if (!options.preserveBreakpoints) {
            this.#breakpoints.clear();
            this.#xhrBreakpoints.clear();
        }
        this.#pausedState = { isPaused: false, callFrames: [] };
        this.#enabled = false;
        this.#client = null;
    }
    /**
     * Check if debugger is enabled.
     */
    isEnabled() {
        return this.#enabled;
    }
    /**
     * Get the CDP client.
     */
    getClient() {
        return this.#client;
    }
    #onScriptParsed = (event) => {
        const scriptInfo = {
            scriptId: event.scriptId,
            url: event.url || '',
            startLine: event.startLine,
            startColumn: event.startColumn,
            endLine: event.endLine,
            endColumn: event.endColumn,
            hash: event.hash,
            sourceMapURL: event.sourceMapURL,
        };
        this.#scripts.set(event.scriptId, scriptInfo);
        // Index by URL for quick lookup
        if (event.url) {
            const scriptIds = this.#urlToScripts.get(event.url) || [];
            if (!scriptIds.includes(event.scriptId)) {
                scriptIds.push(event.scriptId);
                this.#urlToScripts.set(event.url, scriptIds);
            }
        }
    };
    #onPaused = (event) => {
        const callFrames = event.callFrames.map(frame => ({
            callFrameId: frame.callFrameId,
            functionName: frame.functionName || '<anonymous>',
            location: {
                scriptId: frame.location.scriptId,
                lineNumber: frame.location.lineNumber,
                columnNumber: frame.location.columnNumber ?? 0,
            },
            url: frame.url || '',
            scopeChain: frame.scopeChain.map(scope => ({
                type: scope.type,
                object: {
                    type: scope.object.type,
                    subtype: scope.object.subtype,
                    className: scope.object.className,
                    value: scope.object.value,
                    description: scope.object.description,
                    objectId: scope.object.objectId,
                },
                name: scope.name,
                startLocation: scope.startLocation
                    ? {
                        scriptId: scope.startLocation.scriptId,
                        lineNumber: scope.startLocation.lineNumber,
                        columnNumber: scope.startLocation.columnNumber ?? 0,
                    }
                    : undefined,
                endLocation: scope.endLocation
                    ? {
                        scriptId: scope.endLocation.scriptId,
                        lineNumber: scope.endLocation.lineNumber,
                        columnNumber: scope.endLocation.columnNumber ?? 0,
                    }
                    : undefined,
            })),
            this: {
                type: frame.this.type,
                subtype: frame.this.subtype,
                className: frame.this.className,
                value: frame.this.value,
                description: frame.this.description,
                objectId: frame.this.objectId,
            },
        }));
        this.#pausedState = {
            isPaused: true,
            reason: event.reason,
            callFrames,
            data: event.data,
            hitBreakpoints: event.hitBreakpoints,
        };
    };
    #onResumed = () => {
        this.#pausedState = { isPaused: false, callFrames: [] };
    };
    // ==================== Paused State Management ====================
    /**
     * Check if execution is paused.
     */
    isPaused() {
        return this.#pausedState.isPaused;
    }
    /**
     * Get the current paused state.
     */
    getPausedState() {
        return this.#pausedState;
    }
    /**
     * Resume execution.
     */
    async resume() {
        if (!this.#client) {
            throw new Error('Debugger not enabled');
        }
        if (!this.#pausedState.isPaused) {
            throw new Error('Execution is not paused');
        }
        await this.#client.send('Debugger.resume');
    }
    /**
     * Pause execution.
     */
    async pause() {
        if (!this.#client) {
            throw new Error('Debugger not enabled');
        }
        await this.#client.send('Debugger.pause');
    }
    /**
     * Wait for the next Debugger.paused event after a step command.
     * Returns the top call frame from the new paused state.
     */
    #waitForPaused(timeoutMs = 10000) {
        return new Promise((resolve, reject) => {
            const client = this.#client;
            if (!client) {
                reject(new Error('Debugger not enabled'));
                return;
            }
            const timer = setTimeout(() => {
                removeCdpEventListener(client, 'Debugger.paused', onPaused);
                reject(new Error('Timed out waiting for debugger to pause after step'));
            }, timeoutMs);
            const onPaused = (event) => {
                clearTimeout(timer);
                removeCdpEventListener(client, 'Debugger.paused', onPaused);
                // The #onPaused handler will also fire and update #pausedState.
                // We resolve with the top frame from the event directly.
                const topFrame = event.callFrames[0];
                if (topFrame) {
                    resolve({
                        callFrameId: topFrame.callFrameId,
                        functionName: topFrame.functionName || '<anonymous>',
                        location: {
                            scriptId: topFrame.location.scriptId,
                            lineNumber: topFrame.location.lineNumber,
                            columnNumber: topFrame.location.columnNumber ?? 0,
                        },
                        url: topFrame.url || '',
                        scopeChain: [],
                        this: { type: topFrame.this.type },
                    });
                }
                else {
                    reject(new Error('Paused with no call frames'));
                }
            };
            addCdpEventListener(client, 'Debugger.paused', onPaused);
        });
    }
    /**
     * Step over the next statement.
     * Returns the top call frame after pausing.
     */
    async stepOver() {
        if (!this.#client) {
            throw new Error('Debugger not enabled');
        }
        if (!this.#pausedState.isPaused) {
            throw new Error('Execution is not paused');
        }
        const pausedPromise = this.#waitForPaused();
        await this.#client.send('Debugger.stepOver');
        return pausedPromise;
    }
    /**
     * Step into the next function call.
     * Returns the top call frame after pausing.
     */
    async stepInto() {
        if (!this.#client) {
            throw new Error('Debugger not enabled');
        }
        if (!this.#pausedState.isPaused) {
            throw new Error('Execution is not paused');
        }
        const pausedPromise = this.#waitForPaused();
        await this.#client.send('Debugger.stepInto');
        return pausedPromise;
    }
    /**
     * Step out of the current function.
     * Returns the top call frame after pausing.
     */
    async stepOut() {
        if (!this.#client) {
            throw new Error('Debugger not enabled');
        }
        if (!this.#pausedState.isPaused) {
            throw new Error('Execution is not paused');
        }
        const pausedPromise = this.#waitForPaused();
        await this.#client.send('Debugger.stepOut');
        return pausedPromise;
    }
    /**
     * Get variables from a scope.
     */
    async getScopeVariables(objectId) {
        if (!this.#client) {
            throw new Error('Debugger not enabled');
        }
        const result = await this.#client.send('Runtime.getProperties', {
            objectId,
            ownProperties: true,
            accessorPropertiesOnly: false,
            generatePreview: true,
        });
        const variables = [];
        for (const prop of result.result) {
            // Skip internal properties
            if (prop.name.startsWith('__') || prop.name === 'this') {
                continue;
            }
            const value = prop.value;
            if (!value) {
                continue;
            }
            variables.push({
                name: prop.name,
                type: value.type,
                value: value.value ?? value.description ?? `[${value.type}]`,
                description: value.description,
            });
        }
        return variables;
    }
    /**
     * Evaluate expression on a specific call frame.
     */
    async evaluateOnCallFrame(callFrameId, expression, options = {}) {
        if (!this.#client) {
            throw new Error('Debugger not enabled');
        }
        if (!this.#pausedState.isPaused) {
            throw new Error('Execution is not paused');
        }
        const result = await this.#client.send('Debugger.evaluateOnCallFrame', {
            callFrameId,
            expression,
            returnByValue: options.returnByValue ?? false,
            generatePreview: options.generatePreview ?? true,
        });
        return this.#toEvaluateResult(result);
    }
    /**
     * Evaluate an async expression while paused without waiting on page progress.
     * A fulfilled/rejected Promise can be inspected immediately; a pending
     * Promise cannot settle while the JavaScript thread remains paused.
     */
    async evaluateSettledPromiseOnCallFrame(callFrameId, expression) {
        const evaluated = await this.evaluateOnCallFrame(callFrameId, expression, {
            returnByValue: false,
            generatePreview: false,
        });
        if (evaluated.exceptionDetails) {
            return { ...evaluated, settledPromise: false };
        }
        const objectId = evaluated.result.objectId;
        if (!objectId || evaluated.result.subtype !== 'promise') {
            return { ...evaluated, settledPromise: false };
        }
        if (!this.#client) {
            throw new Error('Debugger not enabled');
        }
        const properties = await this.#client.send('Runtime.getProperties', {
            objectId,
            ownProperties: true,
        });
        const internalProperties = properties.internalProperties ?? [];
        const promiseState = internalProperties.find(property => property.name === '[[PromiseState]]')?.value?.value;
        if (promiseState !== 'fulfilled' && promiseState !== 'rejected') {
            throw new Error('Paused async evaluation returned a pending Promise. It cannot settle while execution remains paused. Use a synchronous expression that reads the current call frame, or resume execution before evaluating async work.');
        }
        // Runtime.awaitPromise waits for the page's JavaScript thread and therefore
        // deadlocks while Debugger is paused, even when the Promise is already
        // settled. V8 exposes the settled value as an internal property, which can
        // be inspected without resuming execution.
        const promiseResult = internalProperties.find(property => property.name === '[[PromiseResult]]')?.value;
        const remoteResult = promiseResult
            ? this.#fromProtocolRemoteObject(promiseResult)
            : { type: 'undefined' };
        if (promiseState === 'rejected') {
            return {
                result: remoteResult,
                settledPromise: true,
                exceptionDetails: {
                    text: 'Uncaught (in promise)',
                    exception: remoteResult,
                },
            };
        }
        return { result: remoteResult, settledPromise: true };
    }
    /**
     * Convert a settled remote value to ordinary JSON-compatible data without
     * executing JavaScript in the paused page.
     */
    async materializeRemoteObject(remote) {
        if (!this.#client) {
            throw new Error('Debugger not enabled');
        }
        return await this.#materializeRemoteObject(remote, new Set(), {
            left: 10_000,
        });
    }
    async #materializeRemoteObject(remote, ancestors, budget) {
        if (remote.value !== undefined) {
            return remote.value;
        }
        if (remote.type === 'undefined' || remote.type === 'function') {
            return undefined;
        }
        if (remote.subtype === 'null') {
            return null;
        }
        if (remote.unserializableValue) {
            if (remote.unserializableValue === 'NaN') {
                return Number.NaN;
            }
            if (remote.unserializableValue === 'Infinity') {
                return Number.POSITIVE_INFINITY;
            }
            if (remote.unserializableValue === '-Infinity') {
                return Number.NEGATIVE_INFINITY;
            }
            throw new Error(`Paused result ${remote.unserializableValue} is not JSON-serializable.`);
        }
        const objectId = remote.objectId;
        if (!objectId) {
            return remote.description;
        }
        if (ancestors.has(objectId)) {
            throw new Error('Paused result contains a circular reference.');
        }
        if (budget.left <= 0) {
            throw new Error('Paused result contains more than 10000 properties.');
        }
        ancestors.add(objectId);
        try {
            const properties = await this.#client.send('Runtime.getProperties', {
                objectId,
                ownProperties: true,
                accessorPropertiesOnly: false,
                generatePreview: false,
            });
            const output = remote.subtype === 'array' ? [] : {};
            for (const property of properties.result) {
                if (!property.enumerable || !property.value) {
                    continue;
                }
                budget.left--;
                const value = await this.#materializeRemoteObject(this.#fromProtocolRemoteObject(property.value), ancestors, budget);
                if (Array.isArray(output) && /^(0|[1-9]\d*)$/.test(property.name)) {
                    const index = Number(property.name);
                    if (index >= 10_000) {
                        throw new Error('Paused result contains an array index beyond the 10000-item serialization limit.');
                    }
                    output[index] = value;
                }
                else {
                    Object.defineProperty(output, property.name, {
                        value,
                        enumerable: true,
                        configurable: true,
                        writable: true,
                    });
                }
            }
            return output;
        }
        finally {
            ancestors.delete(objectId);
        }
    }
    /** Interrupt the currently running Runtime evaluation, if any. */
    async terminateExecution() {
        await this.#client?.send('Runtime.terminateExecution');
    }
    #toEvaluateResult(result) {
        return {
            result: this.#fromProtocolRemoteObject(result.result),
            exceptionDetails: result.exceptionDetails
                ? {
                    text: result.exceptionDetails.text,
                    exception: result.exceptionDetails.exception
                        ? {
                            type: result.exceptionDetails.exception.type,
                            value: result.exceptionDetails.exception.value,
                            description: result.exceptionDetails.exception.description,
                        }
                        : undefined,
                }
                : undefined,
        };
    }
    #fromProtocolRemoteObject(remote) {
        return {
            type: remote.type,
            subtype: remote.subtype,
            className: remote.className,
            value: remote.value,
            unserializableValue: remote.unserializableValue,
            description: remote.description,
            objectId: remote.objectId,
        };
    }
    // ==================== Script Management ====================
    /**
     * Get all loaded scripts.
     */
    getScripts() {
        return Array.from(this.#scripts.values());
    }
    /**
     * Get scripts by URL (exact match).
     */
    getScriptsByUrl(url) {
        const scriptIds = this.#urlToScripts.get(url) || [];
        return scriptIds
            .map(id => this.#scripts.get(id))
            .filter((s) => s !== undefined);
    }
    /**
     * Get scripts by URL pattern (partial match).
     */
    getScriptsByUrlPattern(pattern) {
        const results = [];
        const lowerPattern = pattern.toLowerCase();
        for (const script of this.#scripts.values()) {
            if (script.url.toLowerCase().includes(lowerPattern)) {
                results.push(script);
            }
        }
        return results;
    }
    /**
     * Get script info by ID.
     */
    getScriptById(scriptId) {
        return this.#scripts.get(scriptId);
    }
    /**
     * Get the source code of a script by URL.
     * Resolves URL to the most recent scriptId and returns both source and script info.
     */
    async getScriptSourceByUrl(url) {
        if (!this.#client) {
            throw new Error('Debugger not enabled');
        }
        // Try exact match first
        let scripts = this.getScriptsByUrl(url);
        // Fall back to substring match
        if (scripts.length === 0) {
            scripts = this.getScriptsByUrlPattern(url);
        }
        if (scripts.length === 0) {
            throw new Error(`No script found matching URL "${url}". Use list_scripts to see available scripts.`);
        }
        // Pick the last script (most recent parse)
        const script = scripts[scripts.length - 1];
        const result = await this.getScriptSource(script.scriptId);
        return { source: result.scriptSource, bytecode: result.bytecode, script };
    }
    /**
     * Get the source code of a script.
     */
    async getScriptSource(scriptId) {
        if (!this.#client) {
            throw new Error('Debugger not enabled');
        }
        const script = this.#scripts.get(scriptId);
        try {
            const result = await this.#client.send('Debugger.getScriptSource', {
                scriptId,
            });
            return {
                scriptSource: result.scriptSource || '',
                bytecode: result.bytecode,
            };
        }
        catch (error) {
            if (script?.url.startsWith('data:')) {
                const parts = script.url.split(',');
                if (parts.length > 1) {
                    const isBase64 = parts[0].endsWith(';base64');
                    const data = parts.slice(1).join(',');
                    if (isBase64) {
                        if (script.url.includes('wasm')) {
                            return { scriptSource: '', bytecode: data };
                        }
                        return {
                            scriptSource: Buffer.from(data, 'base64').toString('utf-8'),
                        };
                    }
                    else {
                        return { scriptSource: decodeURIComponent(data) };
                    }
                }
            }
            throw error;
        }
    }
    /**
     * Search for a string in all scripts.
     */
    async searchInScripts(query, options = {}) {
        if (!this.#client) {
            throw new Error('Debugger not enabled');
        }
        const { caseSensitive = false, isRegex = false } = options;
        const matches = [];
        // Search in each script
        for (const script of this.#scripts.values()) {
            try {
                const result = await this.#client.send('Debugger.searchInContent', {
                    scriptId: script.scriptId,
                    query,
                    caseSensitive,
                    isRegex,
                });
                for (const match of result.result) {
                    matches.push({
                        scriptId: script.scriptId,
                        url: script.url,
                        lineNumber: match.lineNumber,
                        lineContent: match.lineContent,
                    });
                }
            }
            catch {
                // Skip scripts that can't be searched (e.g., wasm)
            }
        }
        return { query, matches };
    }
    /**
     * Clear cached scripts without disabling the debugger.
     * Use during same-page navigation where the CDP session stays
     * the same but old script IDs become invalid.
     */
    clearScripts() {
        this.#scripts.clear();
        this.#urlToScripts.clear();
    }
    /**
     * Re-set all breakpoints from the stored definitions via CDP.
     * Called after debugger re-enable to restore breakpoints that
     * were wiped by Debugger.disable.
     */
    async restoreBreakpoints(breakpoints) {
        if (!this.#client) {
            return;
        }
        // The IDs belong to the previous Debugger session. Replace them with the
        // IDs returned by the new session instead of retaining stale entries.
        this.#breakpoints.clear();
        for (const bp of breakpoints) {
            try {
                const params = {
                    lineNumber: bp.lineNumber,
                    columnNumber: bp.columnNumber,
                };
                if (bp.isRegex) {
                    params.urlRegex = bp.url;
                }
                else {
                    params.url = bp.url;
                }
                if (bp.condition) {
                    params.condition = bp.condition;
                }
                const result = await this.#client.send('Debugger.setBreakpointByUrl', params);
                const restoredInfo = {
                    breakpointId: result.breakpointId,
                    url: bp.url,
                    lineNumber: bp.lineNumber,
                    columnNumber: bp.columnNumber,
                    condition: bp.condition,
                    isRegex: bp.isRegex,
                    locations: result.locations.map((loc) => ({
                        scriptId: loc.scriptId,
                        lineNumber: loc.lineNumber,
                        columnNumber: loc.columnNumber ?? 0,
                    })),
                };
                this.#breakpoints.set(result.breakpointId, restoredInfo);
            }
            catch {
                // Skip breakpoints that fail to restore
            }
        }
    }
    // ==================== XHR Breakpoint Management ====================
    /**
     * Set an XHR/Fetch breakpoint and track it for restoration after navigation.
     */
    async setXHRBreakpoint(url) {
        if (!this.#client) {
            throw new Error('Debugger not enabled');
        }
        await this.#client.send('DOMDebugger.setXHRBreakpoint', { url });
        this.#xhrBreakpoints.add(url);
    }
    /**
     * Remove an XHR/Fetch breakpoint.
     */
    async removeXHRBreakpoint(url) {
        if (!this.#client) {
            throw new Error('Debugger not enabled');
        }
        await this.#client.send('DOMDebugger.removeXHRBreakpoint', { url });
        this.#xhrBreakpoints.delete(url);
    }
    /**
     * Get all tracked XHR breakpoint URL patterns.
     */
    getXHRBreakpoints() {
        return Array.from(this.#xhrBreakpoints);
    }
    /**
     * Re-set all XHR breakpoints via CDP.
     * Called after navigation since Chrome resets DOMDebugger state.
     */
    async restoreXHRBreakpoints() {
        if (!this.#client) {
            return;
        }
        for (const url of this.#xhrBreakpoints) {
            try {
                await this.#client.send('DOMDebugger.setXHRBreakpoint', { url });
            }
            catch {
                // Skip breakpoints that fail to restore
            }
        }
    }
    // ==================== Breakpoint Management ====================
    /**
     * Set a breakpoint by URL.
     */
    async setBreakpoint(url, lineNumber, columnNumber = 0, condition) {
        if (!this.#client) {
            throw new Error('Debugger not enabled');
        }
        const params = {
            url,
            lineNumber,
            columnNumber,
        };
        if (condition) {
            params.condition = condition;
        }
        const result = await this.#client.send('Debugger.setBreakpointByUrl', params);
        const breakpointInfo = {
            breakpointId: result.breakpointId,
            url,
            lineNumber,
            columnNumber,
            condition,
            locations: result.locations.map((loc) => ({
                scriptId: loc.scriptId,
                lineNumber: loc.lineNumber,
                columnNumber: loc.columnNumber ?? 0,
            })),
        };
        this.#breakpoints.set(result.breakpointId, breakpointInfo);
        return breakpointInfo;
    }
    /**
     * Set a breakpoint by URL regex pattern.
     */
    async setBreakpointByUrlRegex(urlRegex, lineNumber, columnNumber = 0, condition) {
        if (!this.#client) {
            throw new Error('Debugger not enabled');
        }
        const params = {
            urlRegex,
            lineNumber,
            columnNumber,
        };
        if (condition) {
            params.condition = condition;
        }
        const result = await this.#client.send('Debugger.setBreakpointByUrl', params);
        const breakpointInfo = {
            breakpointId: result.breakpointId,
            url: urlRegex, // Store the regex as the URL
            lineNumber,
            columnNumber,
            condition,
            isRegex: true,
            locations: result.locations.map((loc) => ({
                scriptId: loc.scriptId,
                lineNumber: loc.lineNumber,
                columnNumber: loc.columnNumber ?? 0,
            })),
        };
        this.#breakpoints.set(result.breakpointId, breakpointInfo);
        return breakpointInfo;
    }
    /**
     * Remove a breakpoint.
     */
    async removeBreakpoint(breakpointId) {
        if (!this.#client) {
            throw new Error('Debugger not enabled');
        }
        await this.#client.send('Debugger.removeBreakpoint', { breakpointId });
        this.#breakpoints.delete(breakpointId);
    }
    /**
     * Remove all breakpoints (code breakpoints + XHR breakpoints).
     */
    async removeAllBreakpoints() {
        if (!this.#client) {
            throw new Error('Debugger not enabled');
        }
        const breakpointIds = Array.from(this.#breakpoints.keys());
        let removedCode = 0;
        const failedCode = [];
        for (const breakpointId of breakpointIds) {
            try {
                await this.removeBreakpoint(breakpointId);
                removedCode++;
            }
            catch {
                failedCode.push(breakpointId);
            }
        }
        const xhrUrls = Array.from(this.#xhrBreakpoints);
        let removedXHR = 0;
        const failedXHR = [];
        for (const url of xhrUrls) {
            try {
                await this.removeXHRBreakpoint(url);
                removedXHR++;
            }
            catch {
                failedXHR.push(url);
            }
        }
        return { removedCode, removedXHR, failedCode, failedXHR };
    }
    /**
     * Get all active breakpoints.
     */
    getBreakpoints() {
        return Array.from(this.#breakpoints.values());
    }
    /**
     * Get breakpoint by ID.
     */
    getBreakpointById(breakpointId) {
        return this.#breakpoints.get(breakpointId);
    }
}
