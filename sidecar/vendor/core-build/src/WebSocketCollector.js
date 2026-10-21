/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { Buffer } from 'node:buffer';
import { addCdpEventListener, removeCdpEventListener } from './CdpEvents.js';
import { logger } from './logger.js';
export const MAX_RETAINED_WEBSOCKET_FRAMES = 10_000;
export const MAX_RETAINED_WEBSOCKET_BYTES = 16 * 1024 * 1024;
export const MAX_WEBSOCKET_CONNECTIONS_PER_NAVIGATION = 500;
const stableIdSymbol = Symbol('wsStableIdSymbol');
function createIdGenerator() {
    let i = 1;
    return () => {
        if (i === Number.MAX_SAFE_INTEGER) {
            i = 0;
        }
        return i++;
    };
}
/**
 * Collector for WebSocket connections and messages.
 * Listens to CDP Network events for WebSocket activity.
 */
export class WebSocketCollector {
    #context;
    #sessionProvider;
    /**
     * Storage: Page -> Array of navigations -> Array of WebSocket connections.
     * Newer navigations come first.
     */
    #storage = new WeakMap();
    /**
     * Quick lookup: Page -> requestId -> WebSocketData
     */
    #connectionMap = new WeakMap();
    /**
     * ID generator per page for stable IDs.
     */
    #idGenerators = new WeakMap();
    /**
     * CDP cleanup per page.
     */
    #cdpCleanup = new WeakMap();
    #pageCloseListeners = new WeakMap();
    #pageInitializations = new WeakMap();
    #pendingInitializations = new Set();
    #initialization;
    #listeningForPages = false;
    #disposed = false;
    #frameStates = new WeakMap();
    #pageFrameBudgets = new WeakMap();
    #maxNavigationSaved = 3;
    #limits;
    constructor(context, sessionProvider, limits = {}) {
        this.#context = context;
        this.#sessionProvider = sessionProvider;
        this.#limits = {
            maxFrames: limits.maxFrames ?? MAX_RETAINED_WEBSOCKET_FRAMES,
            maxBytes: limits.maxBytes ?? MAX_RETAINED_WEBSOCKET_BYTES,
            maxConnectionsPerNavigation: limits.maxConnectionsPerNavigation ??
                MAX_WEBSOCKET_CONNECTIONS_PER_NAVIGATION,
        };
    }
    async init() {
        if (this.#disposed) {
            throw new Error('WebSocket collector has been disposed');
        }
        if (this.#initialization) {
            await this.#initialization;
            return;
        }
        const initialization = this.#initialize();
        this.#initialization = initialization;
        try {
            await initialization;
        }
        finally {
            if (this.#initialization === initialization) {
                this.#initialization = undefined;
            }
        }
    }
    async #initialize() {
        if (!this.#listeningForPages) {
            this.#context.on('page', this.#onPageCreated);
            this.#listeningForPages = true;
        }
        for (const page of this.#context.pages()) {
            void this.addPage(page).catch(() => undefined);
        }
        await this.#drainInitializations();
    }
    async #drainInitializations() {
        let firstError;
        let failed = false;
        while (this.#pendingInitializations.size > 0) {
            const pending = [...this.#pendingInitializations];
            const results = await Promise.allSettled(pending);
            const rejection = results.find(result => result.status === 'rejected');
            if (!failed && rejection?.status === 'rejected') {
                failed = true;
                firstError = rejection.reason;
            }
        }
        if (failed) {
            throw firstError;
        }
    }
    dispose() {
        this.#disposed = true;
        if (this.#listeningForPages) {
            this.#context.off('page', this.#onPageCreated);
            this.#listeningForPages = false;
        }
        for (const page of this.#context.pages()) {
            this.#cleanupPage(page);
        }
    }
    #onPageCreated = (page) => {
        void this.addPage(page).catch(error => {
            logger('Failed to initialize WebSocket collection for a new page', error);
        });
    };
    addPage(page) {
        if (this.#disposed) {
            return Promise.reject(new Error('WebSocket collector has been disposed'));
        }
        if (this.#cdpCleanup.has(page)) {
            return Promise.resolve();
        }
        const pending = this.#pageInitializations.get(page);
        if (pending) {
            return pending;
        }
        const operation = this.#initializePage(page);
        const initialization = operation.finally(() => {
            if (this.#pageInitializations.get(page) === initialization) {
                this.#pageInitializations.delete(page);
            }
            this.#pendingInitializations.delete(initialization);
        });
        this.#pageInitializations.set(page, initialization);
        this.#pendingInitializations.add(initialization);
        return initialization;
    }
    async #initializePage(page) {
        const idGenerator = createIdGenerator();
        this.#idGenerators.set(page, idGenerator);
        const storedLists = [[]];
        this.#storage.set(page, storedLists);
        this.#connectionMap.set(page, new Map());
        this.#pageFrameBudgets.set(page, { bytes: 0, queue: [] });
        const onClose = () => this.#cleanupPage(page);
        this.#pageCloseListeners.set(page, onClose);
        page.on('close', onClose);
        try {
            await this.#setupCdpListeners(page);
        }
        catch (error) {
            this.#cleanupPage(page);
            throw error;
        }
    }
    async #setupCdpListeners(page) {
        const client = await this.#sessionProvider.getSession(page);
        const connectionMap = this.#connectionMap.get(page);
        const idGenerator = this.#idGenerators.get(page);
        if (!connectionMap || !idGenerator || !this.#storage.has(page)) {
            return;
        }
        const onCreated = (event) => {
            const wsData = {
                connection: {
                    requestId: event.requestId,
                    url: event.url,
                    initiator: event.initiator,
                    status: 'connecting',
                    createdAt: Date.now(),
                },
                frames: [],
                version: 0,
            };
            this.#frameStates.set(wsData, { nextIndex: 0 });
            wsData[stableIdSymbol] = idGenerator();
            connectionMap.set(event.requestId, wsData);
            const navigations = this.#storage.get(page);
            if (navigations) {
                navigations[0].push(wsData);
                while (navigations[0].length > this.#limits.maxConnectionsPerNavigation) {
                    const removed = navigations[0].shift();
                    if (removed) {
                        this.#removeConnection(page, removed);
                    }
                }
            }
            // Mark as open once created (CDP doesn't have a separate open event for ws)
            wsData.connection.status = 'open';
        };
        const onFrameSent = (event) => {
            const wsData = connectionMap.get(event.requestId);
            if (!wsData) {
                return;
            }
            this.#addFrame(page, wsData, {
                requestId: event.requestId,
                direction: 'sent',
                timestamp: event.timestamp * 1000, // Convert to ms
                opcode: event.response.opcode,
                payloadData: event.response.payloadData,
                index: 0,
                payloadBytes: 0,
            });
        };
        const onFrameReceived = (event) => {
            const wsData = connectionMap.get(event.requestId);
            if (!wsData) {
                return;
            }
            this.#addFrame(page, wsData, {
                requestId: event.requestId,
                direction: 'received',
                timestamp: event.timestamp * 1000, // Convert to ms
                opcode: event.response.opcode,
                payloadData: event.response.payloadData,
                index: 0,
                payloadBytes: 0,
            });
        };
        const onClosed = (event) => {
            const wsData = connectionMap.get(event.requestId);
            if (!wsData) {
                return;
            }
            wsData.connection.status = 'closed';
            wsData.connection.closedAt = event.timestamp * 1000;
        };
        const onFrameNavigated = (frame) => {
            if (frame === page.mainFrame()) {
                this.#splitAfterNavigation(page);
            }
        };
        const cleanup = () => {
            removeCdpEventListener(client, 'Network.webSocketCreated', onCreated);
            removeCdpEventListener(client, 'Network.webSocketFrameSent', onFrameSent);
            removeCdpEventListener(client, 'Network.webSocketFrameReceived', onFrameReceived);
            removeCdpEventListener(client, 'Network.webSocketClosed', onClosed);
            page.off('framenavigated', onFrameNavigated);
        };
        let listenersAttached = false;
        try {
            // Attach before Network.enable so no early frame event is missed.
            addCdpEventListener(client, 'Network.webSocketCreated', onCreated);
            addCdpEventListener(client, 'Network.webSocketFrameSent', onFrameSent);
            addCdpEventListener(client, 'Network.webSocketFrameReceived', onFrameReceived);
            addCdpEventListener(client, 'Network.webSocketClosed', onClosed);
            page.on('framenavigated', onFrameNavigated);
            listenersAttached = true;
            await client.send('Network.enable');
            if (!this.#storage.has(page)) {
                cleanup();
                return;
            }
            this.#cdpCleanup.set(page, cleanup);
        }
        catch (error) {
            if (listenersAttached) {
                cleanup();
            }
            throw error;
        }
    }
    #splitAfterNavigation(page) {
        const navigations = this.#storage.get(page);
        if (!navigations) {
            return;
        }
        // Add a new navigation
        navigations.unshift([]);
        const removedNavigations = navigations.splice(this.#maxNavigationSaved);
        for (const navigation of removedNavigations) {
            for (const ws of navigation) {
                this.#removeConnection(page, ws);
            }
        }
        // Event handlers close over this map, so clear it in place.
        this.#connectionMap.get(page)?.clear();
    }
    #addFrame(page, owner, frame) {
        const state = this.#frameStates.get(owner);
        const budget = this.#pageFrameBudgets.get(page);
        if (!state || !budget) {
            return;
        }
        frame.index = state.nextIndex++;
        frame.payloadBytes =
            frame.opcode === 2
                ? Buffer.from(frame.payloadData, 'base64').length
                : Buffer.byteLength(frame.payloadData, 'utf8');
        owner.frames.push(frame);
        owner.version++;
        budget.queue.push({ owner, frame });
        budget.bytes += frame.payloadBytes;
        while (budget.queue.length > this.#limits.maxFrames ||
            budget.bytes > this.#limits.maxBytes) {
            const evicted = budget.queue.shift();
            if (!evicted) {
                break;
            }
            budget.bytes -= evicted.frame.payloadBytes;
            const index = evicted.owner.frames.indexOf(evicted.frame);
            if (index !== -1) {
                evicted.owner.frames.splice(index, 1);
                evicted.owner.version++;
            }
        }
    }
    #removeConnection(page, owner) {
        const connectionMap = this.#connectionMap.get(page);
        if (connectionMap?.get(owner.connection.requestId) === owner) {
            connectionMap.delete(owner.connection.requestId);
        }
        const budget = this.#pageFrameBudgets.get(page);
        if (budget) {
            const removedFrames = new Set(owner.frames);
            budget.queue = budget.queue.filter(entry => {
                if (!removedFrames.has(entry.frame)) {
                    return true;
                }
                budget.bytes -= entry.frame.payloadBytes;
                return false;
            });
        }
        owner.frames.length = 0;
        owner.version++;
    }
    #cleanupPage(page) {
        const onClose = this.#pageCloseListeners.get(page);
        if (onClose) {
            page.off('close', onClose);
            this.#pageCloseListeners.delete(page);
        }
        const cleanup = this.#cdpCleanup.get(page);
        if (cleanup) {
            try {
                cleanup();
            }
            catch {
                // Page might already be closed
            }
        }
        this.#cdpCleanup.delete(page);
        this.#storage.delete(page);
        this.#connectionMap.delete(page);
        this.#idGenerators.delete(page);
        this.#pageFrameBudgets.delete(page);
    }
    /**
     * Get all WebSocket connections for a page.
     */
    getData(page, includePreservedData) {
        const navigations = this.#storage.get(page);
        if (!navigations) {
            return [];
        }
        if (!includePreservedData) {
            return navigations[0] ?? [];
        }
        const data = [];
        for (let index = this.#maxNavigationSaved; index >= 0; index--) {
            if (navigations[index]) {
                data.push(...navigations[index]);
            }
        }
        return data;
    }
    /**
     * Get stable ID for a WebSocket connection.
     */
    getIdForResource(resource) {
        return resource[stableIdSymbol] ?? -1;
    }
    /**
     * Get WebSocket connection by stable ID.
     */
    getById(page, stableId) {
        const navigations = this.#storage.get(page);
        if (!navigations) {
            throw new Error('No WebSocket connections found for selected page');
        }
        for (const navigation of navigations) {
            const item = navigation.find(ws => ws[stableIdSymbol] === stableId);
            if (item) {
                return item;
            }
        }
        throw new Error('WebSocket connection not found for selected page');
    }
    /**
     * Find a WebSocket connection matching the filter.
     */
    find(page, filter) {
        const navigations = this.#storage.get(page);
        if (!navigations) {
            return undefined;
        }
        for (const navigation of navigations) {
            const item = navigation.find(filter);
            if (item) {
                return item;
            }
        }
        return undefined;
    }
}
