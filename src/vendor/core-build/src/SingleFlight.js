/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/** Coalesces concurrent starts while allowing a failed start to be retried. */
export class SingleFlight {
    #promise;
    run(start) {
        if (this.#promise) {
            return this.#promise;
        }
        const promise = start();
        this.#promise = promise;
        const clear = () => {
            if (this.#promise === promise) {
                this.#promise = undefined;
            }
        };
        void promise.then(clear, clear);
        return promise;
    }
    get pending() {
        return this.#promise;
    }
}
