/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
export function addCdpEventListener(session, eventName, listener) {
    const onCdpEvent = session.on.bind(session);
    onCdpEvent(eventName, listener);
}
export function removeCdpEventListener(session, eventName, listener) {
    const offCdpEvent = session.off.bind(session);
    offCdpEvent(eventName, listener);
}
