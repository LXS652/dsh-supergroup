/** 插件接线单测：用假宿主验证工具面、权限面与事件归集，不启动真DSH'*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../src/plugin2.mjs';
import { SessionRegistry } from '../src/core/registry.mjs';

const LEAD = 'session-lead';
const MEMBER = 'session-member-a';
const OUTSIDER = 'session-outsider';

/** 额外建一个整体，返回 groupId；解散测试需要和迁移出来的默认组区分'*/
async function createExtraGroup(host, name) {
    const created = await host.call('ms2_group', { request: JSON.stringify({ action: 'create', name, lead: LEAD, members: [MEMBER] }) }, LEAD);
    assert.equal(created.status, 'ok', created.summary);
    return JSON.parse(created.data).id;
}

/** 等异步启动流程（ready recover 对账）走到断言点；不依ms2_status'*/
async function waitFor(predicate, timeoutMs = 3000) {
    const started = Date.now();
    for (;;) {
        if (await predicate()) return;
        if (Date.now() - started > timeoutMs) throw new Error('WAIT_TIMEOUT');
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}

/** 造一份落盘名'+ 假宿主；返回注册表、宿主句柄与已注册工具'*/
async function makeHost({ prompt, selfTest, historyPages, ledgerRecords, controllerDelay = 0, startupReconcileAttempts, startupReconcileIntervalMs } = {}) {
    const directory = await mkdtemp(join(tmpdir(), 'ms2-host-'));
    const file = join(directory, 'registry.json');
    const ledgerFile = join(directory, 'tasks.jsonl');
    const registry = new SessionRegistry({ lead: LEAD, members: [{ sessionId: MEMBER, roleClass: 'assistant' }] }, { file });
    await registry.save();
    if (Array.isArray(ledgerRecords) && ledgerRecords.length > 0) {
        await writeFile(ledgerFile, `${ledgerRecords.map(record => JSON.stringify(record)).join('\n')}\n`, 'utf8');
    }

    const calls = [];
    const pageCalls = [];
    let pageIndex = 0;
    let controllerPolls = 0;
    const handlers = new Map();
    const definitions = new Map();
    const guards = [];
    const listeners = new Map();
    const commandDefs = new Map();
    const commands = {
        register(definition) {
            assert.equal(typeof definition.handler, 'function', `命令 ${definition.name} 缺少 handler`);
            commandDefs.set(definition.name, definition);
        }
    };
    const tools = {
        layers: {},
        register(definition) {
            // 宿主只收一个完整定义，执行体在 definition.execute 上；mock 也按同一契约存，
            // 这样“注册签名写错”会在单测里就暴露，而不是等真机派工才报错
            assert.equal(typeof definition.execute, 'function', `工具 ${definition.name} 缺少 execute`);
            handlers.set(definition.name, definition.execute);
            definitions.set(definition.name, definition);
        },
        guard(fn) {
            guards.push(fn);
        }
    };
    const on = (event, listener, options) => {
        const entries = listeners.get(event) ?? [];
        entries.push({ listener, global: options && options.global === true });
        listeners.set(event, entries);
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
            if (name !== 'sessionController') return undefined;
            controllerPolls += 1;
            if (controllerDelay > 0 && controllerPolls <= controllerDelay) return undefined;
            return {
                prompt: async (request, signal) => {
                    calls.push({ request, signal });
                    if (prompt) return prompt(request, signal);
                    return { accepted: true };
                },
                // 真机 sessionController 的公开读接口是 page/follow；liveProjections 给出现成游标
                liveProjections(sessionId) {
                    return { kind: 'sequenced', asOfSeq: 100, values: {}, sessionId };
                },
                async page(request, signal) {
                    pageCalls.push({ request, signal });
                    if (!Array.isArray(historyPages) || pageIndex >= historyPages.length) return { records: [], hasMore: false };
                    const page = historyPages[pageIndex];
                    pageIndex += 1;
                    return page;
                }
            };
        }
    };

    apply(ctx, {
        registryFile: file,
        ledgerFile,
        eventsLogFile: join(directory, 'session-events.log'),
        startupReconcileAttempts,
        startupReconcileIntervalMs,
        selfTest
    });

    const call = async (toolName, args, callerId) => {
        const handler = handlers.get(toolName);
        assert.ok(handler, `工具未注' ${toolName}`);
        const parsed = handler ? await handler(args, { agent: { id: callerId }, name: toolName }) : null;
        return parsed;
    };
    // 宿主用会话作用域Context.filter 过滤监听器；本插件的监听器只有声global
    // 才能收到别的会话的事件（cordis events.ts:171-173）。mock 直接按这个契约丢弃，
    // 于是漏写 { global: true } 时任务会停在 delivered，测试立刻失败
    const emit = (sessionId, event) => {
        for (const entry of listeners.get('session/event') ?? []) {
            if (entry.global) entry.listener({ id: sessionId }, event);
        }
    };
    // 兼容回调首参为字符串 id 的宿主包装：直接原样传给插件
    const emitRaw = (session, event) => {
        for (const entry of listeners.get('session/event') ?? []) {
            if (entry.global) entry.listener(session, event);
        }
    };
    // 模型只看得到 render 出来的文本；单测必须走这一步，否则“data 里有关键字段但没渲染”查不出来
    const render = (toolName, value) => {
        const definition = definitions.get(toolName);
        assert.ok(definition, `工具未注' ${toolName}`);
        return definition.output.render({}, value).map(block => block.text).join('\n');
    };
    const cleanup = () => rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    const runCommand = async (rawInput, agent = { id: LEAD }) => {
        const definition = commandDefs.get('ms2');
        assert.ok(definition, '命令 ms2 未注');
        return definition.handler({ commandId: 'cmd-1', agent, rawInput, attachments: [], signal: undefined });
    };
    return { ctx, tools, calls, pageCalls, guards, handlers, commands: commandDefs, runCommand, registry, file, directory, ledgerFile, eventLog: join(directory, 'session-events.log'), call, render, emit, emitRaw, cleanup, listeners, toolsRegistry: tools };
}

test('主会话能派工，成员不能；参数校验与拒绝都可读', async () => {
    const host = await makeHost();
    try {
        const badArgs = await host.call('ms2_dispatch', { request: 'not-json' }, LEAD);
        assert.equal(badArgs.status, 'error');

        const denied = await host.call('ms2_dispatch', { request: JSON.stringify({ memberId: MEMBER, text: 'x' }) }, MEMBER);
        assert.equal(denied.status, 'denied');
        assert.match(denied.summary, /仅主会话/);

        const ok = await host.call('ms2_dispatch', { request: JSON.stringify({ memberId: MEMBER, text: '整理今天的邮' }) }, LEAD);
        assert.equal(ok.status, 'ok');
        assert.equal(host.calls.length, 1);
        assert.equal(host.calls[0].request.sessionId, MEMBER);
        assert.match(host.calls[0].request.requestId, /^ms-/);
        assert.deepEqual(host.calls[0].request.content, [{ type: 'text', text: '整理今天的邮' }]);
        // 主会话必须直接从返回文本里拿requestId：它是后ms2_status/ms2_resolve 的唯一钥匙
        assert.match(ok.summary, /requestId=ms-/);
        assert.match(host.render('ms2_dispatch', ok), /requestId=ms-/);
    } finally {
        await host.cleanup();
    }
});

test('成员增删走命令层：加人后策略表更新，陌生人被拒', async () => {
    const host = await makeHost();
    try {
        const added = await host.call('ms2_members', { request: 'add persona-mailbox persona 人设邮箱' }, LEAD);
        assert.equal(added.status, 'ok');

        const status = await host.call('ms2_status', { request: '' }, LEAD);
        assert.equal(status.status, 'ok');
        const payload = JSON.parse(status.data);
        assert.equal(payload.members.length, 2);
        assert.ok(payload.policies.some(policy => policy.sessionId === 'persona-mailbox' && policy.role === 'persona'));
        // 状态摘要必须能读出工单requestId，而不是只报人数
        assert.match(status.summary, /在途 \d+\/\d+/);

        const outsider = await host.call('ms2_status', { request: '' }, OUTSIDER);
        assert.equal(outsider.status, 'denied');

        const memberRemove = await host.call('ms2_members', { request: 'remove persona-mailbox' }, MEMBER);
        assert.equal(memberRemove.status, 'denied');
    } finally {
        await host.cleanup();
    }
});

test('权限面：跨会话通道只归主会话，名单外会话不受影响', async () => {
    const host = await makeHost();
    try {
        // 触发一次初始化，让 guard 能读到注册表与策略表
        await host.call('ms2_status', { request: '' }, LEAD);
        assert.equal(host.guards.length, 1, '应当向宿主注册且仅注册一guard');
        const [guard] = host.guards;
        const ask = (name, caller) => guard({ name, agent: { id: caller } });

        // 主会话不受限
        assert.equal(ask('send_message', LEAD), undefined);
        // 成员不能直发/派工
        assert.match(String(ask('send_message', MEMBER)), /coordinator-only/);
        assert.match(String(ask('ms2_dispatch', MEMBER)), /MS2_MEMBER_DENIED/);
        // 成员的普通业务工具照
        assert.equal(ask('read_file', MEMBER), undefined);
        // 不在名单里的会话完全不受影响
        assert.equal(ask('send_message', OUTSIDER), undefined);
        assert.equal(ask('ms2_dispatch', OUTSIDER), undefined);
    } finally {
        await host.cleanup();
    }
});

test('事件归集：成员回合结束后，状态里出现完成结果', async () => {
    const host = await makeHost();
    try {
        const ok = await host.call('ms2_dispatch', { request: JSON.stringify({ memberId: MEMBER, text: '跑一' }) }, LEAD);
        assert.equal(ok.status, 'ok');
        const requestId = host.calls[0].request.requestId;

        host.emit(MEMBER, { type: 'turn/start', data: { turn: 2 } });
        host.emit(MEMBER, { type: 'user/message', data: { source: { kind: 'user', rpcId: requestId } } });
        host.emit(MEMBER, { type: 'assistant/message', data: { turn: 2, message: { content: [{ type: 'text', text: '已完' }] } } });
        host.emit(MEMBER, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } });

        const status = await host.call('ms2_status', { request: '' }, LEAD);
        const payload = JSON.parse(status.data);
        assert.equal(payload.tasks.length, 1);
        assert.equal(payload.tasks[0].state, 'completed');
        assert.equal(payload.tasks[0].result, '已完');
        assert.equal(payload.recovery.length, 0);
    } finally {
        await host.cleanup();
    }
});

test('事件观测：双处监听同一条事件只结算一次，日志只记紧凑字段', async () => {
    const host = await makeHost();
    try {
        const ok = await host.call('ms2_dispatch', { request: JSON.stringify({ memberId: MEMBER, text: '双监' }) }, LEAD);
        assert.equal(ok.status, 'ok');
        const requestId = host.calls[0].request.requestId;
        assert.equal(host.listeners.get('session/event').length, 2, '插件 ctx root 各注册一次，必须去重');

        const events = [
            { type: 'turn/start', data: { turn: 5 } },
            { type: 'user/message', data: { source: { kind: 'user', rpcId: requestId } } },
            { type: 'assistant/message', data: { turn: 5, message: { content: [{ type: 'text', text: '只回一' }] } } },
            { type: 'turn/end', data: { turn: 5, reason: { kind: 'completed' } } }
        ];
        for (const event of events) host.emit(MEMBER, event);

        const payload = JSON.parse((await host.call('ms2_status', { request: '' }, LEAD)).data);
        assert.equal(payload.tasks[0].state, 'completed');
        assert.equal(payload.tasks[0].result, '只回一');
        assert.equal(payload.observeStats.eventsSeen, 4);
        assert.equal(payload.observeStats.coordinators, 1);
        assert.equal(payload.logTruncated, false);

        const lines = (await readFile(host.eventLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
        assert.equal(lines.length, 4);
        assert.deepEqual(lines.map(line => line.type), ['turn/start', 'user/message', 'assistant/message', 'turn/end']);
        assert.ok(lines.every(line => line.sessionId === MEMBER && typeof line.at === 'string'));
        assert.ok(lines.every(line => !('text' in line) && !('message' in line)), '日志不能写消息正');
    } finally {
        await host.cleanup();
    }
});

test('事件归集：宿主回调首参是字符串 id 时也能结算', async () => {
    const host = await makeHost();
    try {
        const ok = await host.call('ms2_dispatch', { request: JSON.stringify({ memberId: MEMBER, text: '跑一' }) }, LEAD);
        assert.equal(ok.status, 'ok');
        const requestId = host.calls[0].request.requestId;

        // 防御性兼容：某些包装层可能把 session.id 直接当首参，而不是传会话对象
        host.emitRaw(MEMBER, { type: 'turn/start', data: { turn: 3 } });
        host.emitRaw(MEMBER, { type: 'user/message', data: { source: { kind: 'user', rpcId: requestId } } });
        host.emitRaw(MEMBER, { type: 'assistant/message', data: { turn: 3, message: { content: [{ type: 'text', text: '字符id 也能' }] } } });
        host.emitRaw(MEMBER, { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } });

        const payload = JSON.parse((await host.call('ms2_status', { request: '' }, LEAD)).data);
        assert.equal(payload.tasks[0].state, 'completed');
        assert.equal(payload.tasks[0].result, '字符id 也能');
    } finally {
        await host.cleanup();
    }
});

test('历史对账：rpcId 命中且同回合 turn/end 时补结算', async () => {
    const pages = [];
    const host = await makeHost({ historyPages: pages });
    try {
        const ok = await host.call('ms2_dispatch', { request: JSON.stringify({ memberId: MEMBER, text: '历史回传' }) }, LEAD);
        assert.equal(ok.status, 'ok');
        const requestId = host.calls[0].request.requestId;
        pages.push({
            records: [
                { type: 'event', event: { seq: 11, type: 'turn/start', data: { turn: 7 } } },
                { type: 'event', event: { seq: 12, type: 'user/message', data: { source: { kind: 'user', rpcId: requestId } } } },
                { type: 'event', event: { seq: 13, type: 'assistant/message', data: { turn: 7, message: { content: [{ type: 'text', text: '历史里取回的结果' }] } } } },
                { type: 'event', event: { seq: 14, type: 'turn/end', data: { turn: 7, reason: { kind: 'completed' } } } }
            ],
            hasMore: false
        });

        const payload = JSON.parse((await host.call('ms2_status', { request: '' }, LEAD)).data);
        assert.equal(payload.tasks[0].state, 'completed');
        assert.equal(payload.tasks[0].result, '历史里取回的结果');
        assert.equal(payload.tasks[0].source, 'history-reconcile');
        assert.match(payload.observeStats.lastReconcileReason, /^settled:/);
        assert.equal(host.pageCalls.length, 1);
        assert.equal(host.pageCalls[0].request.address.sessionId, MEMBER);
        const ledger = (await readFile(join(host.directory, 'tasks.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
        assert.ok(ledger.some(item => item.kind === 'settled' && item.source === 'history-reconcile' && item.requestId === requestId));
    } finally {
        await host.cleanup();
    }
});

test('/ms2 panel 触发历史对账，重复调用不重复 settled', async () => {
    const pages = [];
    const host = await makeHost({ historyPages: pages });
    try {
        const ok = await host.call('ms2_dispatch', { request: JSON.stringify({ memberId: MEMBER, text: '面板顺带对账' }) }, LEAD);
        assert.equal(ok.status, 'ok');
        const requestId = host.calls[0].request.requestId;
        pages.push({
            records: [
                { type: 'event', event: { seq: 31, type: 'turn/start', data: { turn: 9 } } },
                { type: 'event', event: { seq: 32, type: 'user/message', data: { source: { kind: 'user', rpcId: requestId } } } },
                { type: 'event', event: { seq: 33, type: 'assistant/message', data: { turn: 9, message: { content: [{ type: 'text', text: '面板里也能取回' }] } } } },
                { type: 'event', event: { seq: 34, type: 'turn/end', data: { turn: 9, reason: { kind: 'completed' } } } }
            ],
            hasMore: false
        });

        const first = JSON.parse((await host.runCommand('panel', { id: LEAD })).text);
        assert.equal(first.groups[0].inFlight, 0);
        await host.runCommand('panel', { id: LEAD });

        const ledger = (await readFile(join(host.directory, 'tasks.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
        assert.equal(ledger.filter(item => item.kind === 'settled' && item.requestId === requestId).length, 1);
        assert.equal(host.pageCalls.length, 1, '第二次面板不能重复读历史');
    } finally {
        await host.cleanup();
    }
});

test('历史对账：rpcId 命中但窗口内没有 turn/end 时保持 delivered 并记录原因', async () => {
    const pages = [];
    const host = await makeHost({ historyPages: pages });
    try {
        const ok = await host.call('ms2_dispatch', { request: JSON.stringify({ memberId: MEMBER, text: '还没结束' }) }, LEAD);
        assert.equal(ok.status, 'ok');
        const requestId = host.calls[0].request.requestId;
        pages.push({
            records: [
                { type: 'event', event: { seq: 21, type: 'turn/start', data: { turn: 8 } } },
                { type: 'event', event: { seq: 22, type: 'user/message', data: { source: { kind: 'user', rpcId: requestId } } } },
                { type: 'event', event: { seq: 23, type: 'assistant/message', data: { turn: 8, message: { content: [{ type: 'text', text: '中间结果' }] } } } }
            ],
            hasMore: true
        });

        const payload = JSON.parse((await host.call('ms2_status', { request: '' }, LEAD)).data);
        assert.equal(payload.tasks[0].state, 'delivered');
        assert.match(payload.observeStats.lastReconcileReason, /^no-turn-end:/);
    } finally {
        await host.cleanup();
    }
});

test('历史对账：rpcId 完全不出现时保持 delivered 并记录原因', async () => {
    const pages = [];
    const host = await makeHost({ historyPages: pages });
    try {
        const ok = await host.call('ms2_dispatch', { request: JSON.stringify({ memberId: MEMBER, text: '找不到锚' }) }, LEAD);
        assert.equal(ok.status, 'ok');
        pages.push({
            records: [
                { type: 'event', event: { seq: 31, type: 'turn/start', data: { turn: 9 } } },
                { type: 'event', event: { seq: 32, type: 'user/message', data: { source: { kind: 'user', rpcId: 'ms-other' } } } },
                { type: 'event', event: { seq: 33, type: 'turn/end', data: { turn: 9, reason: { kind: 'completed' } } } }
            ],
            hasMore: false
        });

        const payload = JSON.parse((await host.call('ms2_status', { request: '' }, LEAD)).data);
        assert.equal(payload.tasks[0].state, 'delivered');
        assert.match(payload.observeStats.lastReconcileReason, /^rpc-not-found:/);
    } finally {
        await host.cleanup();
    }
});

test('历史对账：锚点不在最新一页时继续向前翻页', async () => {
    const pages = [];
    const host = await makeHost({ historyPages: pages });
    try {
        const ok = await host.call('ms2_dispatch', { request: JSON.stringify({ memberId: MEMBER, text: '翻页' }) }, LEAD);
        assert.equal(ok.status, 'ok');
        const requestId = host.calls[0].request.requestId;
        pages.push(
            {
                records: [
                    { type: 'event', event: { seq: 45, type: 'assistant/message', data: { turn: 12, message: { content: [{ type: 'text', text: '更晚的回' }] } } } }
                ],
                hasMore: true
            },
            {
                records: [
                    { type: 'event', event: { seq: 41, type: 'turn/start', data: { turn: 11 } } },
                    { type: 'event', event: { seq: 42, type: 'user/message', data: { source: { kind: 'user', rpcId: requestId } } } },
                    { type: 'event', event: { seq: 43, type: 'assistant/message', data: { turn: 11, message: { content: [{ type: 'text', text: '翻页取回' }] } } } },
                    { type: 'event', event: { seq: 44, type: 'turn/end', data: { turn: 11, reason: { kind: 'completed' } } } }
                ],
                hasMore: false
            }
        );

        const payload = JSON.parse((await host.call('ms2_status', { request: '' }, LEAD)).data);
        assert.equal(payload.tasks[0].state, 'completed');
        assert.equal(payload.tasks[0].result, '翻页取回');
        assert.equal(host.pageCalls.length, 2);
        assert.equal(host.pageCalls[1].request.beforeSeq, 45);
    } finally {
        await host.cleanup();
    }
});

test('事件归集：宿主在 prompt 返回前推完整轮事件也不丢结算', async () => {
    let host;
    host = await makeHost({
        prompt: async (request) => {
            // 模拟宿主 followup 同步开轮：prompt 还没返回，user/message、turn/end 已经分发
            host.emit(MEMBER, { type: 'user/message', data: { turn: 4, source: { kind: 'user', rpcId: request.requestId } } });
            host.emit(MEMBER, { type: 'turn/start', data: { turn: 4 } });
            host.emit(MEMBER, { type: 'assistant/message', data: { turn: 4, message: { content: [{ type: 'text', text: '抢先结算' }] } } });
            host.emit(MEMBER, { type: 'turn/end', data: { turn: 4, reason: { kind: 'completed' } } });
            return { accepted: true };
        }
    });
    try {
        const ok = await host.call('ms2_dispatch', { request: JSON.stringify({ memberId: MEMBER, text: '抢跑' }) }, LEAD);
        assert.equal(ok.status, 'ok');
        const payload = JSON.parse((await host.call('ms2_status', { request: '' }, LEAD)).data);
        assert.equal(payload.tasks[0].state, 'completed');
        assert.equal(payload.tasks[0].result, '抢先结算');
    } finally {
        await host.cleanup();
    }
});

test('事件归集：监听器必须按宿主契约声明 { global: true }', async () => {
    const host = await makeHost();
    try {
        const entries = host.listeners.get('session/event');
        assert.ok(entries && entries.length > 0, '必须注册 session/event 监听');
        assert.ok(entries.every(entry => entry.global === true), '缺少 { global: true } 时收不到其它会话事件');
    } finally {
        await host.cleanup();
    }
});

test('命令通道按宿主 invocation.rawInput 读取：create 真能建组，panel 能读回', async () => {
    const host = await makeHost();
    try {
        const panel = await host.runCommand(' panel');
        assert.equal(panel.kind, 'success');
        assert.equal(JSON.parse(panel.text).groups.length, 1);

        // `create` 后面没有 JSON 必须报错，而不是被当成 panel 静默成功
        const missing = await host.runCommand('create');
        assert.equal(missing.kind, 'error');

        const created = await host.runCommand(' create {"name":"第二组","lead":"session-lead-2","members":["session-m2"]}');
        assert.equal(created.kind, 'success');
        assert.equal(JSON.parse(created.text).group.name, '第二组');

        const after = JSON.parse((await host.runCommand('panel')).text).groups;
        assert.equal(after.length, 2);
        assert.ok(after.some(group => group.name === '第二组'));
    } finally {
        await host.cleanup();
    }
});

test('整体隔离：list 与 status 的 policies/恢复项只含调用者可见整体', async () => {
    const host = await makeHost();
    try {
        await host.runCommand('create {"name":"第二组","lead":"session-lead-2","members":["session-m2"]}');

        const first = await host.call('ms2_group', { request: JSON.stringify({ action: 'list' }) }, LEAD);
        assert.equal(first.status, 'ok');
        const firstGroups = JSON.parse(first.data);
        assert.equal(firstGroups.length, 1);
        assert.equal(firstGroups[0].name, '迁移整体');

        const second = await host.call('ms2_group', { request: JSON.stringify({ action: 'list' }) }, 'session-lead-2');
        assert.equal(second.status, 'ok');
        assert.deepEqual(JSON.parse(second.data).map(group => group.name), ['第二组']);

        const status = await host.call('ms2_status', { request: '' }, LEAD);
        const payload = JSON.parse(status.data);
        assert.equal(payload.groups.length, 1);
        assert.ok(payload.policies.every(policy => policy.sessionId === LEAD || policy.sessionId === MEMBER));
        assert.ok(payload.startupRecovery.every(item => item.groupId === undefined || item.groupId === payload.groups[0].id));
    } finally {
        await host.cleanup();
    }
});

test('工具通道创建整体必须能识别调用会话，不能靠缺 caller 绕过主会话校验', async () => {
    const host = await makeHost();
    try {
        const created = await host.call('ms2_group', {
            request: JSON.stringify({ action: 'create', name: '匿名组', lead: 'session-x', members: ['session-y'] })
        }, undefined);
        assert.equal(created.status, 'error');
        assert.match(created.summary, /无法识别调用会话/);

        const status = await host.call('ms2_status', { request: '' }, LEAD);
        assert.equal(JSON.parse(status.data).groups.length, 1, '失败创建不能留下整体');
    } finally {
        await host.cleanup();
    }
});

test('成员被移除后 guard 立刻恢复普通权限，不残留旧策略', async () => {
    const host = await makeHost();
    try {
        await host.call('ms2_status', { request: '' }, LEAD);
        const [guard] = host.guards;
        assert.equal(host.guards.length, 1);

        const added = await host.call('ms2_members', { request: 'add session-temp' }, LEAD);
        assert.equal(added.status, 'ok');
        assert.match(String(guard({ name: 'send_message', agent: { id: 'session-temp' } })), /coordinator-only/);

        const removed = await host.call('ms2_members', { request: 'remove session-temp' }, LEAD);
        assert.equal(removed.status, 'ok');
        assert.equal(guard({ name: 'send_message', agent: { id: 'session-temp' } }), undefined);
    } finally {
        await host.cleanup();
    }
});

test('启动后自动对账：uncertain 工单拿到历史完成证据就结算，并保留 restart 证据', async () => {
    const requestId = 'ms-w7-restart-done';
    const historyPages = [{
        records: [
            { type: 'event', event: { type: 'user/message', data: { source: { kind: 'user', rpcId: requestId } } } },
            { type: 'event', event: { type: 'turn/start', data: { turn: 5 } } },
            { type: 'event', event: { type: 'assistant/message', data: { turn: 5, message: { content: [{ type: 'text', text: '重启前的活干完了' }] } } } },
            { type: 'event', event: { type: 'turn/end', data: { turn: 5, reason: { kind: 'completed' } } } }
        ],
        hasMore: false
    }];
    const host = await makeHost({
        historyPages,
        ledgerRecords: [{ kind: 'dispatch', requestId, sessionId: MEMBER, label: '打工', text: '重启前派出的工单' }]
    });
    try {
        // 不调ms2_status：ready recover 之后应当自己触发一次对账
        await waitFor(async () => {
            const text = await readFile(host.ledgerFile, 'utf8');
            return text.includes('history-reconcile-after-restart');
        });
        assert.equal(host.pageCalls.length, 1, '启动对账只读一次历');

        const status = await host.call('ms2_status', { request: '' }, LEAD);
        const payload = JSON.parse(status.data);
        const task = payload.tasks.find(item => item.requestId === requestId);
        assert.ok(task, '状态里应包含该工单');
        assert.equal(task.state, 'completed');
        assert.equal(task.result, '重启前的活干完了');
        assert.equal(task.turn, 5);
        assert.equal(task.reason, 'restart', '保留重启时的 reason 证据');
        assert.equal(task.priorReason, 'restart');
        assert.equal(task.settlementReason, 'completed');
        assert.equal(task.source, 'history-reconcile-after-restart');
    } finally {
        await host.cleanup();
    }
});

test('启动后自动对账：uncertain 没有完成证据时保持 uncertain，不结算也不重发', async () => {
    const requestId = 'ms-w7-restart-no-proof';
    const host = await makeHost({
        ledgerRecords: [{ kind: 'dispatch', requestId, sessionId: MEMBER, label: '打工', text: '没有回音' }]
    });
    try {
        await waitFor(() => host.pageCalls.length >= 1);
        const before = await readFile(host.ledgerFile, 'utf8');
        assert.ok(before.includes('"kind":"uncertain"'), '重启恢复应先uncertain');
        assert.ok(!before.includes('"kind":"settled"'), '没有证据时不能写 settled');
        assert.equal(host.calls.length, 0, '对账不能投递消');

        const status = await host.call('ms2_status', { request: '' }, LEAD);
        const payload = JSON.parse(status.data);
        const task = payload.tasks.find(item => item.requestId === requestId);
        assert.equal(task.state, 'uncertain');
        assert.equal(task.reason, 'restart');
        assert.equal(host.calls.length, 0, 'ms2_status 对账也不能重');
        assert.match(payload.observeStats.lastReconcileReason ?? '', /rpc-not-found|no-turn-end/);
    } finally {
        await host.cleanup();
    }
});

test('启动后自动对账不依赖 ms2_status（不调用状态工具也会读历史）', async () => {
    const requestId = 'ms-w7-auto-startup';
    const host = await makeHost({
        ledgerRecords: [{ kind: 'dispatch', requestId, sessionId: MEMBER, label: '打工', text: '等对' }]
    });
    try {
        await waitFor(() => host.pageCalls.length === 1);
        assert.equal(host.calls.length, 0, '启动自愈不能触发派工');
        assert.equal(host.pageCalls[0].request.address.sessionId, MEMBER);
        assert.ok(host.pageCalls[0].signal, '历史读取必须AbortSignal');
    } finally {
        await host.cleanup();
    }
});

test('启动对账：sessionController 延迟注册时有界等待并最终结算', async () => {
    const requestId = 'ms-w8-late-controller';
    const host = await makeHost({
        controllerDelay: 3,
        startupReconcileAttempts: 10,
        startupReconcileIntervalMs: 5,
        historyPages: [{
            records: [
                { type: 'event', event: { type: 'user/message', data: { source: { kind: 'user', rpcId: requestId } } } },
                { type: 'event', event: { type: 'turn/start', data: { turn: 4 } } },
                { type: 'event', event: { type: 'assistant/message', data: { turn: 4, message: { content: [{ type: 'text', text: '控制器来晚了也结' }] } } } },
                { type: 'event', event: { type: 'turn/end', data: { turn: 4, reason: { kind: 'completed' } } } }
            ],
            hasMore: false
        }],
        ledgerRecords: [{ kind: 'dispatch', requestId, sessionId: MEMBER, label: '打工人', text: '等 controller' }]
    });
    try {
        await waitFor(async () => {
            const text = await readFile(host.ledgerFile, 'utf8');
            return text.includes('history-reconcile-after-restart');
        });
        const status = await host.call('ms2_status', { request: '' }, LEAD);
        const payload = JSON.parse(status.data);
        const startup = payload.observeStats.startupReconcile;
        assert.equal(startup.outcome, 'settled');
        assert.deepEqual(startup.settled, [requestId]);
        assert.ok(startup.attempts >= 4, `应当等到第 4 次才拿到 controller，实际 ${startup.attempts}`);
        assert.equal(startup.error, null);
        assert.ok(startup.waitedMs >= 0);
    } finally {
        await host.cleanup();
    }
});

test('启动对账：sessionController 始终不出现时在有限次数后放弃并写 error', async () => {
    const requestId = 'ms-w8-no-controller';
    const host = await makeHost({
        controllerDelay: 999999,
        startupReconcileAttempts: 2,
        startupReconcileIntervalMs: 5,
        ledgerRecords: [{ kind: 'dispatch', requestId, sessionId: MEMBER, label: '打工', text: '没有历史接口' }]
    });
    try {
        // 等启动对账的有限等待结束 × 5ms，留足调度余量
        await new Promise(resolve => setTimeout(resolve, 100));
        const status = await host.call('ms2_status', { request: '' }, LEAD);
        const payload = JSON.parse(status.data);
        const startup = payload.observeStats.startupReconcile;
        assert.equal(startup.outcome, 'no-controller');
        assert.equal(startup.attempts, 2);
        assert.equal(startup.error, 'NO_SESSION_HISTORY_API');
        assert.deepEqual(startup.settled, []);
        assert.ok(startup.waitedMs < 1000, '有界等待不能拖过上限');
        const text = await readFile(host.ledgerFile, 'utf8');
        assert.ok(!text.includes('"kind":"settled"'), '拿不controller 不能settled');
    } finally {
        await host.cleanup();
    }
});

test('启动对账幂等：重复调用不会重复写 settled', async () => {
    const requestId = 'ms-w8-idempotent';
    const host = await makeHost({
        historyPages: [{
            records: [
                { type: 'event', event: { type: 'user/message', data: { source: { kind: 'user', rpcId: requestId } } } },
                { type: 'event', event: { type: 'turn/start', data: { turn: 3 } } },
                { type: 'event', event: { type: 'assistant/message', data: { turn: 3, message: { content: [{ type: 'text', text: '只记一' }] } } } },
                { type: 'event', event: { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } } }
            ],
            hasMore: false
        }],
        ledgerRecords: [{ kind: 'dispatch', requestId, sessionId: MEMBER, label: '打工', text: '幂等对账' }]
    });
    try {
        await waitFor(async () => {
            const text = await readFile(host.ledgerFile, 'utf8');
            return text.includes('history-reconcile-after-restart');
        });
        await host.call('ms2_status', { request: '' }, LEAD);
        await host.call('ms2_status', { request: '' }, LEAD);
        const records = (await readFile(host.ledgerFile, 'utf8'))
            .trim()
            .split('\n')
            .map(line => JSON.parse(line))
            .filter(item => item.kind === 'settled' && item.requestId === requestId);
        assert.equal(records.length, 1, '重复对账不能重复settled');
        assert.equal(records[0].source, 'history-reconcile-after-restart');
    } finally {
        await host.cleanup();
    }
});

test('解散整体：只删登记并落盘，内存快照同步，不碰其它整体', async () => {
    const host = await makeHost();
    try {
        const groupId = await createExtraGroup(host, '待解散');
        const before = JSON.parse(await readFile(join(host.directory, 'groups.json'), 'utf8'));
        assert.ok(before.groups.some(group => group.id === groupId));

        const result = await host.runCommand(`dissolve ${groupId}`, { id: LEAD });
        assert.equal(result.kind, 'success');
        const dissolved = JSON.parse(result.text).dissolved;
        assert.equal(dissolved.id, groupId);

        const after = JSON.parse(await readFile(join(host.directory, 'groups.json'), 'utf8'));
        assert.ok(!after.groups.some(group => group.id === groupId), 'groups.json 里必须真的少一');
        assert.ok(after.groups.length >= 1, '不能误删其它整体');

        const panel = JSON.parse((await host.runCommand('panel', { id: LEAD })).text);
        assert.ok(!panel.groups.some(group => group.id === groupId), '内存快照里不能留下幽灵整');
    } finally {
        await host.cleanup();
    }
});

test('解散整体：有在途工单时拒绝并报 requestId', async () => {
    const host = await makeHost();
    try {
        const groupId = await createExtraGroup(host, '在途组');
        const dispatched = await host.call('ms2_dispatch', {
            request: JSON.stringify({ group: '在途组', memberId: MEMBER, text: '先别解散' })
        }, LEAD);
        assert.equal(dispatched.status, 'ok');
        const requestId = host.calls[0].request.requestId;

        const result = await host.runCommand(`dissolve ${groupId}`, { id: LEAD });
        assert.equal(result.kind, 'error');
        assert.match(result.text, /GROUP_IN_FLIGHT/);
        assert.match(result.text, new RegExp(requestId));

        const after = JSON.parse(await readFile(join(host.directory, 'groups.json'), 'utf8'));
        assert.ok(after.groups.some(group => group.id === groupId), '拒绝时不能删登记');
    } finally {
        await host.cleanup();
    }
});

test('解散整体：非 lead 被明确拒绝，未知 groupId 报错', async () => {
    const host = await makeHost();
    try {
        const groupId = await createExtraGroup(host, '别人的整体');

        const denied = await host.runCommand(`dissolve ${groupId}`, { id: MEMBER });
        assert.equal(denied.kind, 'error');
        assert.match(denied.text, /只有该整体主会话/);
        const afterDenied = JSON.parse(await readFile(join(host.directory, 'groups.json'), 'utf8'));
        assert.ok(afterDenied.groups.some(group => group.id === groupId), 'lead 不能删登');

        const missing = await host.runCommand('dissolve g-not-exist', { id: LEAD });
        assert.equal(missing.kind, 'error');
        assert.match(missing.text, /GROUP_NOT_FOUND/);
    } finally {
        await host.cleanup();
    }
});

test('自检：加载后自动派工一次，结算后写报告（无需真人调用工具）', async () => {
    const outer = await mkdtemp(join(tmpdir(), 'ms2-selftest-'));
    const reportDir = join(outer, 'reports');
    const host = await makeHost({ selfTest: { memberId: MEMBER, text: '自检工单', timeoutMs: 5000, reportDir } });
    try {
        for (let i = 0; i < 100 && host.calls.length === 0; i += 1) await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(host.calls.length, 1, '自检应当只派工一');
        const requestId = host.calls[0].request.requestId;

        host.emit(MEMBER, { type: 'turn/start', data: { turn: 1 } });
        host.emit(MEMBER, { type: 'user/message', data: { source: { kind: 'user', rpcId: requestId } } });
        host.emit(MEMBER, { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '自检完成' }] } } });
        host.emit(MEMBER, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });

        let payload = null;
        for (let i = 0; i < 150; i += 1) {
            await new Promise(resolve => setTimeout(resolve, 20));
            try {
                payload = JSON.parse(await readFile(join(reportDir, 'latest.json'), 'utf8'));
            } catch {
                continue;
            }
            if (payload.phase === 'settled') break;
        }
        assert.ok(payload, '应当写出报告');
        assert.equal(payload.phase, 'settled');
        assert.equal(payload.task.state, 'completed');
        assert.equal(payload.task.result, '自检完成');
    } finally {
        await host.cleanup();
        await rm(outer, { recursive: true, force: true });
    }
});


test('整体改名：lead 改名后立即落盘并反映到面板；重名与非 lead 被拒绝', async () => {
    const host = await makeHost();
    try {
        const groupId = await createExtraGroup(host, '旧的整体名');
        const renamed = await host.runCommand(`group rename ${JSON.stringify({ group: groupId, name: '新的整体名' })}`, { id: LEAD });
        assert.equal(renamed.kind, 'success', renamed.text);
        const saved = JSON.parse(await readFile(join(host.directory, 'groups.json'), 'utf8'));
        assert.equal(saved.groups.find(group => group.id === groupId).name, '新的整体名');
        const panel = JSON.parse((await host.runCommand('panel', { id: LEAD })).text);
        assert.equal(panel.groups.find(group => group.id === groupId).name, '新的整体名');

        const otherId = await createExtraGroup(host, '另一个整体');
        const duplicate = await host.runCommand(`group rename ${JSON.stringify({ group: otherId, name: '新的整体名' })}`, { id: LEAD });
        assert.equal(duplicate.kind, 'error');
        assert.match(duplicate.text, /GROUP_NAME_TAKEN/);

        const denied = await host.runCommand(`group rename ${JSON.stringify({ group: groupId, name: '成员不能改' })}`, { id: MEMBER });
        assert.equal(denied.kind, 'error');
        assert.match(denied.text, /只有该整体主会话/);
        const afterDenied = JSON.parse(await readFile(join(host.directory, 'groups.json'), 'utf8'));
        assert.equal(afterDenied.groups.find(group => group.id === groupId).name, '新的整体名');
    } finally {
        await host.cleanup();
    }
});

test('整体改成员：全量覆盖、lead 不能入列、移除成员后 guard 立即失效', async () => {
    const host = await makeHost();
    try {
        const groupId = await createExtraGroup(host, '改成员组');
        await host.call('ms2_status', { request: '' }, LEAD);
        const [guard] = host.guards;
        assert.ok(guard, '应当注册 guard');

        const grown = await host.runCommand(`group members ${JSON.stringify({ group: groupId, members: [MEMBER, 'session-temp', 'session-guest'] })}`, { id: LEAD });
        assert.equal(grown.kind, 'success', grown.text);
        assert.match(String(guard({ name: 'send_message', agent: { id: 'session-temp' } })), /coordinator-only/);
        assert.match(String(guard({ name: 'send_message', agent: { id: 'session-guest' } })), /coordinator-only/);

        const shrunk = await host.runCommand(`group members ${JSON.stringify({ group: groupId, members: ['session-temp'] })}`, { id: LEAD });
        assert.equal(shrunk.kind, 'success', shrunk.text);
        assert.equal(guard({ name: 'send_message', agent: { id: 'session-guest' } }), undefined, '移除后普通权限立刻恢复');
        assert.match(String(guard({ name: 'send_message', agent: { id: 'session-temp' } })), /coordinator-only/);

        const withLead = await host.runCommand(`group members ${JSON.stringify({ group: groupId, members: [LEAD, 'session-temp'] })}`, { id: LEAD });
        assert.equal(withLead.kind, 'error');
        assert.match(withLead.text, /GROUP_LEAD_CANNOT_BE_MEMBER/);
        const saved = JSON.parse(await readFile(join(host.directory, 'groups.json'), 'utf8'));
        assert.deepEqual(saved.groups.find(group => group.id === groupId).members.map(member => member.sessionId), ['session-temp']);
    } finally {
        await host.cleanup();
    }
});

test('整体改成员：对象数组把 label 落盘，空 label 退回 sessionId', async () => {
    const host = await makeHost();
    try {
        const groupId = await createExtraGroup(host, '带名字成员组');
        const labelled = await host.runCommand(`group members ${JSON.stringify({
            group: groupId,
            members: [
                { sessionId: MEMBER, label: '打工人' },
                { sessionId: 'session-guest', label: '' }
            ]
        })}`, { id: LEAD });
        assert.equal(labelled.kind, 'success', labelled.text);
        const saved = JSON.parse(await readFile(join(host.directory, 'groups.json'), 'utf8'));
        const savedMembers = saved.groups.find(group => group.id === groupId).members;
        assert.equal(savedMembers.find(member => member.sessionId === MEMBER).label, '打工人');
        assert.equal(savedMembers.find(member => member.sessionId === 'session-guest').label, 'session-guest', '空 label 退回 sessionId');
    } finally {
        await host.cleanup();
    }
});

test('整体改成员：字符串数组入参仍可用，并保留旧 label', async () => {
    const host = await makeHost();
    try {
        const groupId = await createExtraGroup(host, '字符串入参组');
        const labelled = await host.runCommand(`group members ${JSON.stringify({
            group: groupId,
            members: [{ sessionId: MEMBER, label: '打工人' }]
        })}`, { id: LEAD });
        assert.equal(labelled.kind, 'success', labelled.text);

        const strings = await host.runCommand(`group members ${JSON.stringify({
            group: groupId,
            members: [MEMBER, 'session-temp']
        })}`, { id: LEAD });
        assert.equal(strings.kind, 'success', strings.text);
        const afterStrings = JSON.parse(await readFile(join(host.directory, 'groups.json'), 'utf8'));
        const afterMembers = afterStrings.groups.find(group => group.id === groupId).members;
        assert.equal(afterMembers.find(member => member.sessionId === MEMBER).label, '打工人', '字符串入参保留旧 label');
        assert.equal(afterMembers.find(member => member.sessionId === 'session-temp').label, 'session-temp');
    } finally {
        await host.cleanup();
    }
});

test('整体改成员：对象数组入参下 lead、超 8、空数组仍然被拒绝', async () => {
    const host = await makeHost();
    try {
        const groupId = await createExtraGroup(host, '对象入参校验组');
        const before = await readFile(join(host.directory, 'groups.json'), 'utf8');

        const withLead = await host.runCommand(`group members ${JSON.stringify({
            group: groupId,
            members: [{ sessionId: LEAD, label: '主会话' }, { sessionId: MEMBER, label: '成员' }]
        })}`, { id: LEAD });
        assert.equal(withLead.kind, 'error');
        assert.match(withLead.text, /GROUP_LEAD_CANNOT_BE_MEMBER/);

        const tooMany = await host.runCommand(`group members ${JSON.stringify({
            group: groupId,
            members: Array.from({ length: 9 }, (_, index) => ({ sessionId: `session-many-${index}`, label: `成员${index}` }))
        })}`, { id: LEAD });
        assert.equal(tooMany.kind, 'error');
        assert.match(tooMany.text, /GROUP_TOO_MANY_MEMBERS/);

        const empty = await host.runCommand(`group members ${JSON.stringify({ group: groupId, members: [] })}`, { id: LEAD });
        assert.equal(empty.kind, 'error');
        assert.match(empty.text, /GROUP_MISSING_MEMBERS/);

        assert.equal(await readFile(join(host.directory, 'groups.json'), 'utf8'), before, '拒绝时不能改落盘名单');
    } finally {
        await host.cleanup();
    }
});

test('整体改成员：被移除成员还有在途工单时拒绝并报 requestId', async () => {
    const host = await makeHost();
    try {
        const groupId = await createExtraGroup(host, '在途成员组');
        const dispatched = await host.call('ms2_dispatch', {
            request: JSON.stringify({ group: '在途成员组', memberId: MEMBER, text: '先别改成员' })
        }, LEAD);
        assert.equal(dispatched.status, 'ok');
        const requestId = host.calls[0].request.requestId;

        const rejected = await host.runCommand(`group members ${JSON.stringify({ group: groupId, members: ['session-other'] })}`, { id: LEAD });
        assert.equal(rejected.kind, 'error');
        assert.match(rejected.text, /GROUP_MEMBER_IN_FLIGHT/);
        assert.match(rejected.text, new RegExp(requestId));
        const saved = JSON.parse(await readFile(join(host.directory, 'groups.json'), 'utf8'));
        assert.ok(saved.groups.find(group => group.id === groupId).members.some(member => member.sessionId === MEMBER), '拒绝时名单不能变');
    } finally {
        await host.cleanup();
    }
});
