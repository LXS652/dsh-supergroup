/** v4 无工单通知：归属反查、频控、去重、失败可见。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../src/plugin2.mjs';
import { SessionRegistry } from '../src/core/registry.mjs';
import { TaskLedger } from '../src/core/ledger.mjs';
import { createWaker } from '../src/core/wake.mjs';

const LEAD = 'session-lead';
const MEMBER = 'session-member-a';
const OUTSIDER = 'session-outsider';

async function makeHost({ prompt, bootstrapGroups } = {}) {
    const directory = await mkdtemp(join(tmpdir(), 'ms2-notify-'));
    const file = join(directory, 'registry.json');
    const registry = new SessionRegistry(
        { lead: LEAD, members: [{ sessionId: MEMBER, roleClass: 'assistant' }] },
        { file }
    );
    await registry.save();

    const calls = [];
    const handlers = new Map();
    const listeners = new Map();
    const commands = { register() {} };
    const tools = {
        layers: {},
        register(definition) {
            assert.equal(typeof definition.execute, 'function');
            handlers.set(definition.name, definition.execute);
        },
        guard() {}
    };
    const on = (event, listener, options) => {
        const entries = listeners.get(event) ?? [];
        entries.push({ listener, global: options && options.global === true });
        listeners.set(event, entries);
    };
    const controller = {
        async prompt(request, signal) {
            calls.push({ request, signal });
            if (typeof prompt === 'function') return prompt(request, signal);
            return { accepted: true };
        },
        liveProjections(sessionId) {
            return { kind: 'sequenced', asOfSeq: 100, values: {}, sessionId };
        },
        async page() {
            return { records: [], hasMore: false };
        }
    };
    const ctx = {
        tools,
        on,
        root: {
            get(name) { return name === 'tools' ? tools : undefined; },
            on
        },
        get(name) {
            if (name === 'commands') return commands;
            if (name === 'sessionController') return controller;
            return undefined;
        }
    };

    apply(ctx, {
        registryFile: file,
        ledgerFile: join(directory, 'tasks.jsonl'),
        eventsLogFile: join(directory, 'session-events.log'),
        bootstrapGroups
    });

    const call = async (toolName, args, callerId) => {
        const handler = handlers.get(toolName);
        assert.ok(handler, `工具未注册 ${toolName}`);
        return handler(args, { agent: { id: callerId }, name: toolName });
    };
    const notify = (summary, caller = MEMBER, detail = undefined) => call('ms2_notify', {
        request: JSON.stringify(detail === undefined ? { summary } : { summary, detail })
    }, caller);

    return {
        calls,
        call,
        notify,
        directory,
        async status() {
            return JSON.parse((await call('ms2_status', { request: '' }, LEAD)).data);
        },
        async cleanup() {
            await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
        }
    };
}

async function waitFor(predicate, timeoutMs = 3000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        const value = await predicate();
        if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('WAIT_TIMEOUT');
}

test('1) 正常通知：唯一整体，投给 lead，固定模板', async () => {
    const host = await makeHost();
    try {
        const result = await host.notify('A1 ping');
        assert.equal(result.status, 'ok', result.summary);
        const data = JSON.parse(result.data);
        assert.equal(data.wake, 'sent');
        assert.equal(data.leadSessionId, LEAD);
        const wakes = host.calls.filter(item => item.request.requestId.startsWith('ms-wake-notify-'));
        assert.equal(wakes.length, 1);
        assert.equal(wakes[0].request.sessionId, LEAD);
        assert.equal(wakes[0].request.mode, 'followup');
        assert.match(wakes[0].request.requestId, /^ms-wake-notify-[0-9a-f]{8}-[0-9a-f]{8}-\d+$/);
        assert.match(wakes[0].request.content[0].text, /^\[成员通知\] session-member-a · 迁移整体：A1 ping（详情：调用 ms2_status）$/);
    } finally {
        await host.cleanup();
    }
});

test('2) 不在任何整体：NOTIFY_NO_GROUP，零投递', async () => {
    const host = await makeHost();
    try {
        const result = await host.notify('outsider 的通知', OUTSIDER);
        assert.equal(result.status, 'error');
        assert.match(result.summary, /NOTIFY_NO_GROUP/);
        assert.equal(host.calls.filter(item => item.request.requestId.startsWith('ms-wake-notify-')).length, 0);
    } finally {
        await host.cleanup();
    }
});

test('3) 属于两个整体：NOTIFY_AMBIGUOUS，返回候选且零投递', async () => {
    const host = await makeHost({
        bootstrapGroups: [{ name: '第二整体', lead: LEAD, members: [MEMBER] }]
    });
    try {
        const result = await host.notify('不知道该发给谁');
        assert.equal(result.status, 'error');
        assert.match(result.summary, /NOTIFY_AMBIGUOUS/);
        const data = JSON.parse(result.data);
        assert.equal(data.code, 'NOTIFY_AMBIGUOUS');
        assert.equal(data.candidates.length, 2);
        assert.equal(host.calls.filter(item => item.request.requestId.startsWith('ms-wake-notify-')).length, 0);
    } finally {
        await host.cleanup();
    }
});

test('4) 每分钟 6 条：第 7 条限流，账本一行 wake-failed', async () => {
    const host = await makeHost();
    try {
        const outcomes = [];
        for (let index = 1; index <= 7; index += 1) {
            outcomes.push(JSON.parse((await host.notify(`限流-${index}`)).data).wake);
        }
        assert.deepEqual(outcomes, ['sent', 'sent', 'sent', 'sent', 'sent', 'sent', 'rate-limited']);
        const data = await waitFor(async () => {
            const snapshot = await host.status();
            return snapshot.wakeEvents.some(item => item.code === 'WAKE_RATE_LIMITED') ? snapshot : null;
        });
        assert.equal(data.wakeEvents.filter(item => item.code === 'WAKE_RATE_LIMITED').length, 1);
    } finally {
        await host.cleanup();
    }
});

test('5) 同摘要 60 秒：只投一次，重复不计数', async () => {
    const host = await makeHost();
    try {
        const statuses = [];
        for (let index = 0; index < 10; index += 1) {
            statuses.push(JSON.parse((await host.notify('同一句话')).data).wake);
        }
        assert.equal(statuses[0], 'sent');
        assert.deepEqual(statuses.slice(1), Array(9).fill('duplicate'));
        assert.equal(host.calls.filter(item => item.request.requestId.startsWith('ms-wake-notify-')).length, 1);
    } finally {
        await host.cleanup();
    }
});

test('6) 不同摘要、同分钟：都投递（受频控）', async () => {
    const host = await makeHost();
    try {
        const first = JSON.parse((await host.notify('第一句')).data);
        const second = JSON.parse((await host.notify('第二句')).data);
        assert.equal(first.wake, 'sent');
        assert.equal(second.wake, 'sent');
        assert.notEqual(first.requestId, second.requestId);
        assert.equal(host.calls.filter(item => item.request.requestId.startsWith('ms-wake-notify-')).length, 2);
    } finally {
        await host.cleanup();
    }
});

test('7) prompt 抛 session/agent-busy：返回 error，账本记录原错误码', async () => {
    const host = await makeHost({
        prompt(request) {
            if (request.requestId.startsWith('ms-wake-notify-')) {
                const error = new Error('prompt rejected');
                error.code = 'session/agent-busy';
                throw error;
            }
            return { accepted: true };
        }
    });
    try {
        const result = await host.notify('主会话忙');
        const data = JSON.parse(result.data);
        assert.equal(result.status, 'ok');
        assert.equal(data.wake, 'error');
        assert.equal(data.wakeCode, 'session/agent-busy');
        const snapshot = await waitFor(async () => {
            const current = await host.status();
            return current.wakeEvents.some(item => item.code === 'session/agent-busy') ? current : null;
        });
        assert.equal(snapshot.wakeEvents[0].code, 'session/agent-busy');
        assert.match(snapshot.wakeEvents[0].message, /prompt rejected/);
    } finally {
        await host.cleanup();
    }
});

test('8) prompt 永不 settle：5 秒看门狗超时，maybeQueued 落账', async () => {
    const failures = [];
    let fire;
    const waker = createWaker({
        getController() {
            return { prompt: () => new Promise(() => {}) };
        },
        timeoutMs: 5_000,
        timers: {
            setTimeout(callback) {
                fire = callback;
                return 1;
            },
            clearTimeout() {}
        },
        onFailure(entry) {
            failures.push(entry);
        }
    });
    const pending = waker.wakeNotify({
        groupId: 'g-test',
        groupName: '测试整体',
        leadSessionId: LEAD,
        reporterSessionId: MEMBER,
        label: '执行助手',
        summary: '会超时的通知'
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(typeof fire, 'function');
    fire();
    const result = await pending;
    assert.equal(result.status, 'error');
    assert.equal(result.wakeCode, 'WAKE_TIMEOUT');
    assert.equal(failures.length, 1);
    assert.equal(failures[0].code, 'WAKE_TIMEOUT');
    assert.equal(failures[0].maybeQueued, true);
    assert.equal(failures[0].outcome, 'timeout');
});

test('9) lead 忙但 prompt 接受：返回 sent，不重试', async () => {
    const host = await makeHost({
        prompt(request) {
            if (request.requestId.startsWith('ms-wake-notify-')) return { accepted: true, queued: true };
            return { accepted: true };
        }
    });
    try {
        const result = await host.notify('排队即可');
        assert.equal(JSON.parse(result.data).wake, 'sent');
        assert.equal(host.calls.filter(item => item.request.requestId.startsWith('ms-wake-notify-')).length, 1);
    } finally {
        await host.cleanup();
    }
});

test('10) lead 为空：skipped-no-lead，记 WAKE_NO_LEAD', async () => {
    const failures = [];
    const waker = createWaker({
        getController() {
            return { prompt() { throw new Error('不应调用'); } };
        },
        onFailure(entry) {
            failures.push(entry);
        }
    });
    const result = await waker.wakeNotify({
        groupId: 'g-test',
        groupName: '测试整体',
        leadSessionId: '',
        reporterSessionId: MEMBER,
        label: '执行助手',
        summary: '没有主会话'
    });
    assert.equal(result.status, 'skipped-no-lead');
    assert.equal(result.wakeCode, 'WAKE_NO_LEAD');
    assert.equal(failures.length, 1);
    assert.equal(failures[0].code, 'WAKE_NO_LEAD');
});

test('11) 账本重开后仍能读到 wake-failed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ms2-wake-ledger-'));
    try {
        const file = join(directory, 'tasks.jsonl');
        const ledger = new TaskLedger({ file });
        await ledger.append({ kind: 'wake-failed', groupId: 'g-a', requestId: 'ms-wake-notify-a', outcome: 'failed', code: 'session/agent-busy' });
        const reopened = new TaskLedger({ file });
        const rows = await reopened.recentKind('wake-failed', 20);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].code, 'session/agent-busy');
    } finally {
        await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
});

test('12) 超长摘要按码点截 200，不切坏代理对', async () => {
    const host = await makeHost();
    try {
        const long = '🙂'.repeat(260);
        const result = await host.notify(long);
        assert.equal(JSON.parse(result.data).wake, 'sent');
        const text = host.calls.find(item => item.request.requestId.startsWith('ms-wake-notify-')).request.content[0].text;
        assert.equal(text.isWellFormed(), true);
        const body = text.slice(text.indexOf('：') + 1, text.indexOf('（详情'));
        assert.equal([...body].length, 200);
    } finally {
        await host.cleanup();
    }
});
