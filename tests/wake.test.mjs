/** v3.2 唤醒：成员上报后只叫醒 lead，且不拖慢/不污染上报。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../src/plugin2.mjs';
import { SessionRegistry } from '../src/core/registry.mjs';
import { createWaker } from '../src/core/wake.mjs';

const LEAD = 'session-lead';
const MEMBER = 'session-member-a';

/** 最小假宿主：只做本文件需要的工具/命令/会话控制器。 */
async function makeHost({ prompt } = {}) {
    const directory = await mkdtemp(join(tmpdir(), 'ms2-wake-'));
    const file = join(directory, 'registry.json');
    const registry = new SessionRegistry(
        { lead: LEAD, members: [{ sessionId: MEMBER, roleClass: 'assistant' }] },
        { file }
    );
    await registry.save();

    const calls = [];
    const handlers = new Map();
    const commandDefs = new Map();
    const listeners = new Map();
    const commands = {
        register(definition) {
            commandDefs.set(definition.name, definition);
        }
    };
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
        eventsLogFile: join(directory, 'session-events.log')
    });

    const call = async (toolName, args, callerId) => {
        const handler = handlers.get(toolName);
        assert.ok(handler, `工具未注册 ${toolName}`);
        return handler(args, { agent: { id: callerId }, name: toolName });
    };

    return {
        calls,
        call,
        directory,
        async cleanup() {
            await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
        }
    };
}

async function dispatchOne(host, text = '做一件事') {
    const dispatched = await host.call('ms2_dispatch', {
        request: JSON.stringify({ memberId: MEMBER, text })
    }, LEAD);
    assert.equal(dispatched.status, 'ok', dispatched.summary);
    const match = /requestId=(ms-[^\s]+)/.exec(dispatched.summary);
    assert.ok(match, `派工结果里应有 requestId：${dispatched.summary}`);
    return match[1];
}

test('a) completed 上报后只向 lead 投一次固定格式唤醒', async () => {
    const host = await makeHost();
    try {
        const taskRequestId = await dispatchOne(host);
        const reported = await host.call('ms2_report', {
            request: JSON.stringify({ status: 'completed', summary: '整理完了' })
        }, MEMBER);
        assert.equal(reported.status, 'ok', reported.summary);

        const wakes = host.calls.filter(item => item.request.requestId.startsWith('ms-wake-'));
        assert.equal(wakes.length, 1);
        assert.equal(wakes[0].request.sessionId, LEAD);
        assert.equal(wakes[0].request.requestId, `ms-wake-${taskRequestId}-completed`);
        assert.equal(wakes[0].request.mode, 'followup');
        const text = wakes[0].request.content[0].text;
        assert.match(text, /^\[成员上报\] /);
        assert.match(text, new RegExp(MEMBER));
        assert.match(text, new RegExp(taskRequestId));
        assert.match(text, /· completed：整理完了（详情：调用 ms2_status）$/);
        assert.doesNotMatch(text, /[\u0000-\u001f\u007f]/);
    } finally {
        await host.cleanup();
    }
});

test('b) 同一单重复上报不再唤醒第二次', async () => {
    const host = await makeHost();
    try {
        await dispatchOne(host);
        const request = JSON.stringify({ status: 'completed', summary: '同一份结论' });
        const first = await host.call('ms2_report', { request }, MEMBER);
        assert.equal(first.status, 'ok', first.summary);
        const second = await host.call('ms2_report', { request }, MEMBER);
        assert.equal(second.status, 'ok', second.summary);

        const wakes = host.calls.filter(item => item.request.requestId.startsWith('ms-wake-'));
        assert.equal(wakes.length, 1);
    } finally {
        await host.cleanup();
    }
});

test('c) 上报者就是 lead 时跳过，不调用 prompt', () => {
    let controllerCalls = 0;
    const waker = createWaker({
        getController() {
            controllerCalls += 1;
            return { prompt() { throw new Error('不应该被调用'); } };
        }
    });
    const result = waker.wake({
        leadSessionId: 'session-same',
        reporterSessionId: 'session-same',
        taskRequestId: 'ms-same',
        status: 'completed',
        state: 'completed',
        label: '主会话自己',
        summary: '自己报给自己'
    });
    assert.deepEqual(result, { status: 'skipped-self' });
    assert.equal(controllerCalls, 0);
});

test('d) prompt 抛错时上报仍成功，wakeErrors 记录失败', async () => {
    const host = await makeHost({
        prompt(request) {
            if (request.requestId.startsWith('ms-wake-')) throw new Error('lead 会话唤不醒');
            return { accepted: true };
        }
    });
    try {
        await dispatchOne(host);
        const reported = await host.call('ms2_report', {
            request: JSON.stringify({ status: 'blocked', summary: '需要主会话决定' })
        }, MEMBER);
        assert.equal(reported.status, 'ok', reported.summary);

        const status = await host.call('ms2_status', { request: '' }, LEAD);
        assert.equal(status.status, 'ok', status.summary);
        const data = JSON.parse(status.data);
        assert.ok(Array.isArray(data.wakeErrors));
        assert.equal(data.wakeErrors.length, 1);
        assert.match(data.wakeErrors[0].message, /唤不醒/);
        assert.match(data.wakeErrors[0].requestId, /^ms-wake-/);
    } finally {
        await host.cleanup();
    }
});

test('e) 超长/控制字符 summary 被截到 200 字且清洗', () => {
    let captured = null;
    const waker = createWaker({
        getController() {
            return {
                prompt(request) {
                    captured = request;
                    return { accepted: true };
                }
            };
        }
    });
    const long = `${'a'.repeat(260)}\n\t尾巴`;
    const result = waker.wake({
        leadSessionId: LEAD,
        reporterSessionId: MEMBER,
        taskRequestId: 'ms-long',
        status: 'failed',
        state: 'failed',
        label: '执行助手',
        summary: long
    });
    assert.equal(result.status, 'sent');
    const text = captured.content[0].text;
    assert.doesNotMatch(text, /[\u0000-\u001f\u007f]/);
    assert.match(text, new RegExp(`${'a'.repeat(200)}（详情`));
    assert.doesNotMatch(text, new RegExp(`${'a'.repeat(201)}`));
});
