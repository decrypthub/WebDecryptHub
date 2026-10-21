/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * CDP Session cache layer for Playwright/Patchright.
 *
 * In Puppeteer, `page._client()` is synchronous and returns the same session.
 * In Playwright, `page.context().newCDPSession(page)` is async and creates
 * a new session each time. This provider caches sessions per Page/Frame.
 */
export class CdpSessionProvider {
    #pageSessions = new WeakMap();
    #frameSessions = new WeakMap();
    #pendingPageSessions = new WeakMap();
    #pendingFrameSessions = new WeakMap();
    #context;
    constructor(context) {
        this.#context = context;
    }
    getSession(pageOrFrame) {
        // Check if it's a Page (has context() method that returns BrowserContext)
        if ('context' in pageOrFrame && typeof pageOrFrame.context === 'function') {
            // It could be either Page or Frame - check for mainFrame to distinguish
            if ('mainFrame' in pageOrFrame) {
                return this.#getPageSession(pageOrFrame);
            }
        }
        return this.#getFrameSession(pageOrFrame);
    }
    #getPageSession(page) {
        const cached = this.#pageSessions.get(page);
        if (cached) {
            return Promise.resolve(cached);
        }
        const existing = this.#pendingPageSessions.get(page);
        if (existing) {
            return existing.promise;
        }
        const operation = this.#context.newCDPSession(page);
        const pending = { invalidated: false, promise: operation };
        const promise = operation
            .then(async (session) => {
            if (pending.invalidated ||
                this.#pendingPageSessions.get(page) !== pending) {
                await session.detach().catch(() => undefined);
                throw new Error('CDP page session creation was invalidated');
            }
            this.#pageSessions.set(page, session);
            return session;
        })
            .finally(() => {
            if (this.#pendingPageSessions.get(page) === pending) {
                this.#pendingPageSessions.delete(page);
            }
        });
        pending.promise = promise;
        this.#pendingPageSessions.set(page, pending);
        return promise;
    }
    #getFrameSession(frame) {
        const cached = this.#frameSessions.get(frame);
        if (cached) {
            return Promise.resolve(cached);
        }
        const existing = this.#pendingFrameSessions.get(frame);
        if (existing) {
            return existing.promise;
        }
        // Playwright's newCDPSession accepts Frame directly for OOPIFs.
        const operation = this.#context.newCDPSession(frame);
        const pending = { invalidated: false, promise: operation };
        const promise = operation
            .then(async (session) => {
            if (pending.invalidated ||
                this.#pendingFrameSessions.get(frame) !== pending) {
                await session.detach().catch(() => undefined);
                throw new Error('CDP frame session creation was invalidated');
            }
            this.#frameSessions.set(frame, session);
            return session;
        })
            .finally(() => {
            if (this.#pendingFrameSessions.get(frame) === pending) {
                this.#pendingFrameSessions.delete(frame);
            }
        });
        pending.promise = promise;
        this.#pendingFrameSessions.set(frame, pending);
        return promise;
    }
    /**
     * Invalidate cached session for a page or frame.
     * Call this when the page/frame is closed or navigated.
     */
    invalidate(pageOrFrame) {
        if ('mainFrame' in pageOrFrame) {
            const pending = this.#pendingPageSessions.get(pageOrFrame);
            if (pending) {
                pending.invalidated = true;
                this.#pendingPageSessions.delete(pageOrFrame);
            }
            const session = this.#pageSessions.get(pageOrFrame);
            if (session) {
                void session.detach().catch(() => undefined);
                this.#pageSessions.delete(pageOrFrame);
            }
        }
        else {
            const pending = this.#pendingFrameSessions.get(pageOrFrame);
            if (pending) {
                pending.invalidated = true;
                this.#pendingFrameSessions.delete(pageOrFrame);
            }
            const session = this.#frameSessions.get(pageOrFrame);
            if (session) {
                void session.detach().catch(() => undefined);
                this.#frameSessions.delete(pageOrFrame);
            }
        }
    }
}
