/**
 * Paused 状态与 CDP 真实状态对账。
 *
 * 背景：DebuggerContext 的 #pausedState 是事件镜像。切换页面/帧或宿主重新绑定 target
 * 会 disable()+enable()，期间 Debugger.resumed 监听被摘掉，镜像就永久停在错误值上。
 * 结果是快照说"暂停"、恢复说"未暂停"、求值报 not paused，三条路互斥。
 * 这组测试用真实的 CDP 事件与假 client 锁住对账行为。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DebuggerContext } from '../src/DebuggerContext.js';
import { pauseOrResume, getPausedInfo } from '../src/tools/debugger.js';

/** 最小 CDP client：可以派发事件，并记录 send 调用。 */
function fakeClient(overrides = {}) {
    const listeners = new Map();
    return {
        sends: [],
        on(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
        off(name, fn) { listeners.get(name)?.delete(fn); },
        emit(name, payload) { for (const fn of [...(listeners.get(name) || [])]) fn(payload); },
        listenerCount(name) { return (listeners.get(name) || new Set()).size; },
        async send(method, params) {
            this.sends.push(method);
            if (overrides.send) return overrides.send(method, params);
            return {};
        },
    };
}

const PAUSED_EVENT = {
    reason: 'other',
    callFrames: [{
        callFrameId: 'cf0',
        functionName: 'fixtureRun',
        url: 'https://example.test/a.js',
        location: { scriptId: 's1', lineNumber: 4, columnNumber: 0 },
        scopeChain: [{ type: 'local', object: { objectId: 'obj1', type: 'object' } }],
        this: { type: 'undefined' },
    }],
};

function fakeResponse() {
    const lines = [];
    let structured = null;
    return {
        lines,
        get structured() { return structured; },
        appendResponseLine: (line) => lines.push(line),
        setStructuredContent: (value) => { structured = value; },
    };
}

async function pausedContext() {
    const dbg = new DebuggerContext();
    const client = fakeClient();
    await dbg.enable(client);
    client.emit('Debugger.paused', PAUSED_EVENT);
    assert.equal(dbg.isPaused(), true, '断言前置：已进入暂停');
    return { dbg, client };
}

test('disable() keeps a paused mirror instead of falsely reporting running', async () => {
    const { dbg } = await pausedContext();
    await dbg.disable({ preserveBreakpoints: true });
    assert.equal(dbg.isPaused(), true, '页面可能仍暂停，不能谎报已恢复');
    assert.equal(dbg.getPausedState().stale, true, '必须标记为陈旧');
    assert.equal(dbg.getPausedState().callFrames.length, 1, '保留现场，便于用户判断');
});

test('disable() on a running page stays running and is not marked stale', async () => {
    const dbg = new DebuggerContext();
    const client = fakeClient();
    await dbg.enable(client);
    await dbg.disable();
    assert.equal(dbg.isPaused(), false);
    assert.equal(dbg.getPausedState().stale, undefined);
});

test('resume() on a stale mirror is idempotent, not a hard failure', async () => {
    const { dbg } = await pausedContext();
    await dbg.disable({ preserveBreakpoints: true });
    // 真实的漂移场景：disable 之后又 enable 了（换页/换帧/宿主重绑），
    // 但新的 Debugger.paused 事件没到，镜像仍停在旧的暂停态。
    await dbg.enable(fakeClient());
    assert.equal(dbg.isPaused(), true);
    const response = fakeResponse();
    await pauseOrResume.handler({ params: { action: 'resume' } }, response, { debuggerContext: dbg });
    assert.equal(dbg.isPaused(), false, '按 CDP 实际情况修正本地状态');
    assert.equal(response.structured.state, 'running');
    assert.equal(response.structured.reconciled, true);
});

test('resume() when already running without a stale mirror still conflicts', async () => {
    const dbg = new DebuggerContext();
    await dbg.enable(fakeClient());
    await assert.rejects(
        () => pauseOrResume.handler({ params: { action: 'resume' } }, fakeResponse(), { debuggerContext: dbg }),
        (error) => error.code === 'CONFLICT',
        '正常的「本来就运行中」仍应是稳定错误，不能被自愈逻辑吞掉',
    );
});

test('resume() tolerates CDP reporting the page is not paused', async () => {
    const dbg = new DebuggerContext();
    const client = fakeClient({
        send: async (method) => {
            if (method === 'Debugger.resume') throw new Error('Can only perform operation while paused.');
            return {};
        },
    });
    await dbg.enable(client);
    client.emit('Debugger.paused', PAUSED_EVENT);
    const result = await dbg.resume();
    assert.equal(result.alreadyRunning, true, 'CDP 说已不在暂停 → 幂等成功');
    assert.equal(dbg.isPaused(), false, '以 CDP 为准修正镜像');
});

test('get_paused_info warns when the paused state may be stale', async () => {
    const { dbg } = await pausedContext();
    await dbg.disable({ preserveBreakpoints: true });
    // 重新 enable 后没有新的 paused 事件：镜像仍是旧的
    await dbg.enable(fakeClient());
    const response = fakeResponse();
    await getPausedInfo.handler(
        { params: { includeScopes: false, maxScopeDepth: 2, frameIndex: 0 } },
        response,
        { debuggerContext: dbg },
    );
    assert.match(response.lines.join('\n'), /may be stale/);
});

test('markRunning() clears a drifted mirror', async () => {
    const { dbg } = await pausedContext();
    dbg.markRunning();
    assert.equal(dbg.isPaused(), false);
    assert.deepEqual(dbg.getPausedState().callFrames, []);
});

test('a fresh paused event clears the stale flag', async () => {
    const { dbg, client } = await pausedContext();
    await dbg.disable({ preserveBreakpoints: true });
    const next = fakeClient();
    await dbg.enable(next);
    next.emit('Debugger.paused', PAUSED_EVENT);
    assert.equal(dbg.isPaused(), true);
    assert.equal(dbg.getPausedState().stale, undefined, '真实事件到了就不再是陈旧镜像');
    assert.equal(client.listenerCount('Debugger.paused'), 0, 'disable 必须摘掉旧监听，避免双写');
});
