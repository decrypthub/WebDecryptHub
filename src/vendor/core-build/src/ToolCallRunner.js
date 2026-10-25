/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
function abortError(signal) {
    if (signal.reason instanceof Error) {
        return signal.reason;
    }
    return new Error(signal.reason === undefined
        ? 'Tool call was cancelled'
        : String(signal.reason));
}
/**
 * Runs a tool operation with a linked cancellation signal.
 *
 * Cancellation is observable immediately by the operation, but this function
 * does not settle until the underlying promise has settled. Callers can
 * therefore release exclusivity locks in a finally block without allowing a
 * timed-out operation to continue concurrently with the next tool call.
 */
export async function runAbortableOperation(operation, options) {
    const controller = new AbortController();
    const externalSignal = options.signal;
    const abortFromExternalSignal = () => {
        controller.abort(abortError(externalSignal));
    };
    if (externalSignal?.aborted) {
        abortFromExternalSignal();
    }
    else {
        externalSignal?.addEventListener('abort', abortFromExternalSignal, {
            once: true,
        });
    }
    const timeoutId = setTimeout(() => {
        controller.abort(new Error(options.timeoutMessage));
    }, options.timeoutMs);
    const settled = Promise.resolve()
        .then(() => {
        controller.signal.throwIfAborted();
        return operation(controller.signal);
    })
        .then(value => ({ status: 'fulfilled', value }), reason => ({ status: 'rejected', reason }));
    const aborted = new Promise(resolve => {
        if (controller.signal.aborted) {
            resolve('aborted');
            return;
        }
        controller.signal.addEventListener('abort', () => resolve('aborted'), {
            once: true,
        });
    });
    try {
        const first = await Promise.race([settled, aborted]);
        if (first === 'aborted' || controller.signal.aborted) {
            // Drain the operation before returning so the caller can safely release
            // its mutex. Cancellable operations should react to the linked signal.
            if (first === 'aborted') {
                // WebDecryptHub 修复：原实现无限期等待被中止的操作结束才释放工具锁；
                // 若底层 CDP 调用永不返回（如在多 iframe 页面上启用调试器），整个内核会永久卡死，
                // 后续所有工具都报 "Timed out waiting for another tool call"。这里改为有限等待后强制释放。
                let drainTimer;
                await Promise.race([
                    settled,
                    new Promise(resolve => { drainTimer = setTimeout(resolve, options.drainTimeoutMs ?? 8000); }),
                ]);
                clearTimeout(drainTimer);
            }
            throw abortError(controller.signal);
        }
        if (first.status === 'rejected') {
            throw first.reason;
        }
        return first.value;
    }
    finally {
        clearTimeout(timeoutId);
        externalSignal?.removeEventListener('abort', abortFromExternalSignal);
    }
}
