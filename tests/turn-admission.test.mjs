/**
 * 进程内回合准入回归测试；创建者：DeepSeek Harness，2026-11-02。
 * 仅导入 Node 内建测试、断言和待测模块；无文件写入、子进程、网络或 DSH 执行。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { TurnAdmission } from '../src/core/turn-admission.mjs';

/** 创建精确注册表、可切换任务状态及不可变原生消息。 */
function fixture() {
    const agent = { id: 'member', session: {} };
    const registry = new Map([[agent.id, agent], ['other', { id: 'other', session: {} }]]);
    const envelope = { id: 'task', attempt: 1, token: 'credential', prefix: 'Team 原生前缀', text: '精确任务正文' };
    let live = true;
    const options = {
        leadId: 'lead', memberIds: ['member', 'other'], getAgent: id => registry.get(id),
        isLiveTask: (id, attempt, token, memberId) => live && memberId === 'member'
            && id === envelope.id && attempt === envelope.attempt && token === envelope.token,
    };
    const admission = new TurnAdmission(options);
    const controller = new AbortController();
    const message = Object.freeze({
        role: 'user', id: 'native-message',
        source: Object.freeze({ kind: 'agent-message', form: 'relay', senderSessionId: 'lead' }),
        content: Object.freeze([
            Object.freeze({ type: 'text', text: envelope.prefix }),
            Object.freeze({ type: 'text', text: envelope.text }),
        ]),
    });
    const payload = { agent, signal: controller.signal, turn: 7, step: 1, messages: Object.freeze([message]) };
    return { admission, options, agent, registry, envelope, controller, message, payload,
        setLive(value) { live = value; } };
}

/** 断言稳定错误码，避免其它异常错误通过。 */
function rejects(code, action) {
    assert.throws(action, error => error.code === code && error.message === code);
}

/** 用微任务观察闩锁是否已解决，不使用计时器或提前结束待测回合。 */
async function pending(promise) {
    let resolved = false;
    promise.then(() => { resolved = true; });
    await Promise.resolve();
    assert.equal(resolved, false);
}

/** 准备期待并验证首步准入，供生命周期用例复用。 */
function admitted() {
    const value = fixture();
    value.admission.expect('member', value.envelope);
    assert.equal(value.admission.admit(value.payload), true);
    return value;
}

test('回执前首步领取，绑定精确身份并允许回执晚于报告', () => {
    const value = admitted();
    const { admission, agent, envelope, payload, message } = value;
    assert.equal(admission.allowed({ agent, signal: payload.signal }), true);
    assert.equal(admission.allowed({ agent, signal: payload.signal, turn: payload.turn }), true);
    assert.equal(admission.matchesReport(agent, envelope), true);
    value.setLive(false);
    assert.equal(admission.matchesReport(agent, envelope), false);
    assert.equal(admission.allowed({ agent, signal: payload.signal }), false);
    assert.equal(admission.correlate('member', message.id), true);
    assert.equal(admission.observe(agent.session, { type: 'turn/end', data: { turn: payload.turn } }), true);
    assert.equal(admission.correlate('member', message.id), true);
});

test('回执先到仍要求精确正文；等待信封不接受报告或工具调用', () => {
    const { admission, envelope, payload, agent, message } = fixture();
    admission.expect('member', envelope);
    assert.equal(admission.matchesReport(agent, envelope), false);
    assert.equal(admission.allowed({ agent, signal: payload.signal }), false);
    assert.equal(admission.correlate('member', message.id), true);
    assert.equal(admission.admit(payload), true);
    assert.equal(admission.correlate('member', message.id), true);
});

test('绑定后回执不匹配撤销但闩锁保持待定', async () => {
    const { admission, agent, payload } = admitted();
    const end = admission.settlement('member');
    rejects('TURN_MESSAGE_MISMATCH', () => admission.correlate('member', 'wrong'));
    assert.equal(admission.allowed({ agent, signal: payload.signal }), false);
    assert.equal(admission.admit({ ...payload, step: 2, messages: [] }), false);
    assert.equal(admission.settlement('member'), end);
    rejects('TURN_PENDING', () => admission.clear('member'));
    await pending(end);
    admission.observe(agent.session, { type: 'turn/end', data: { turn: payload.turn } });
    await end;
    admission.clear('member');
});

test('先到回执不匹配拒绝领取；重复回执冲突撤销期待', () => {
    const { admission, envelope, payload } = fixture();
    admission.expect('member', envelope);
    admission.correlate('member', 'different-message');
    assert.equal(admission.admit(payload), false);
    rejects('TURN_MESSAGE_MISMATCH', () => admission.correlate('member', 'native-message'));
    assert.equal(admission.admit({ ...payload, messages: [{ ...payload.messages[0], id: 'different-message' }] }), false);
    admission.clear('member');
    rejects('TURN_UNEXPECTED_RECEIPT', () => admission.correlate('member', 'native-message'));
});

test('撤销不是结束；仅精确会话加精确回合事件解决稳定承诺', async () => {
    const { admission, agent, payload, envelope } = admitted();
    const session = agent.session;
    const end = admission.settlement('member');
    admission.revoke('member');
    rejects('TURN_PENDING', () => admission.expect('member', envelope));
    rejects('TURN_PENDING', () => admission.clear('member'));
    for (const [observedSession, event] of [
        [{}, { type: 'turn/end', data: { turn: 7 } }],
        [session, { type: 'turn/end', data: { turn: 8 } }],
        [session, { type: 'turn/end', data: { turn: '7' } }],
        [session, { type: 'turn/start', data: { turn: 7 } }],
        [session, { type: 'turn/end', turn: 7 }],
        [session, null],
    ]) assert.equal(admission.observe(observedSession, event), false);
    await pending(end);
    assert.equal(admission.observe(session, { type: 'turn/end', data: { turn: payload.turn } }), true);
    await end;
    assert.equal(admission.observe(session, { type: 'turn/end', data: { turn: payload.turn } }), false);
    admission.clear('member');
    admission.expect('member', envelope);
    assert.equal(admission.admit({ ...payload, turn: 8, signal: new AbortController().signal }), true);
});

test('续步只能领取空消息，拒绝不同信号、回合、首步重放及混合消息', () => {
    const { admission, payload, message, agent } = admitted();
    assert.equal(admission.admit({ ...payload, step: 2, messages: [] }), true);
    assert.equal(admission.admit({ ...payload, step: 99, messages: Object.freeze([]) }), true);
    for (const update of [
        { step: 1, messages: [] }, { step: 2, messages: [message] },
        { step: 2, messages: [message, { role: 'user', id: 'unrelated' }] },
        { step: 2, messages: undefined }, { step: 2, messages: [], turn: 8 },
        { step: 2, messages: [], signal: new AbortController().signal },
        { step: 0, messages: [] }, { step: 1.5, messages: [] },
    ]) assert.equal(admission.admit({ ...payload, ...update }), false);
    assert.equal(admission.allowed({ agent, signal: new AbortController().signal }), false);
    assert.equal(admission.allowed({ agent, signal: payload.signal, turn: 8 }), false);
    assert.equal(admission.allowed({ agent, signal: payload.signal, turn: undefined }), false);
});

test('所有首步信封字段严格验证；无期待、重复、混合、旧正文全部拒绝', () => {
    const { admission, payload, envelope, message } = fixture();
    assert.equal(admission.admit(payload), false);
    admission.expect('member', envelope);
    const invalidMessages = [
        [], [message, message], [message, { role: 'user', id: 'other' }], [null],
        [{ ...message, id: '' }], [{ ...message, id: 1 }], [{ ...message, role: 'assistant' }],
        [{ ...message, source: { ...message.source, kind: 'user' } }],
        [{ ...message, source: { ...message.source, form: 'direct' } }],
        [{ ...message, source: { ...message.source, senderSessionId: 'other-lead' } }],
        [{ ...message, content: '正文' }],
        [{ ...message, content: [{ type: 'text', text: envelope.text }] }],
        [{ ...message, content: [...message.content, { type: 'text', text: '附加' }] }],
        [{ ...message, content: [{ type: 'text', text: '旧前缀' }, message.content[1]] }],
        [{ ...message, content: [message.content[0], { type: 'text', text: '旧正文' }] }],
        [{ ...message, content: [message.content[0], { type: 'image', text: envelope.text }] }],
        [{ ...message, content: [message.content[1], message.content[0]] }],
    ];
    for (const messages of invalidMessages) assert.equal(admission.admit({ ...payload, messages }), false);
    assert.equal(admission.admit(payload), true);
    assert.equal(admission.admit(payload), false);
});

test('畸形输入、访问器和回调异常只拒绝，不从准入抛出异常', () => {
    const { admission, envelope, payload, message } = fixture();
    admission.expect('member', envelope);
    for (const value of [null, undefined, {}, [], 1, 'payload',
        { ...payload, turn: NaN }, { ...payload, turn: Number.MAX_SAFE_INTEGER + 1 },
        { ...payload, turn: 0 }, { ...payload, turn: '7' },
        { ...payload, signal: {} }, { ...payload, signal: null },
        { ...payload, messages: [{ ...message, get source() { throw new Error('访问器'); } }] },
        { get agent() { throw new Error('访问器'); } },
        new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('代理'); } }),
    ]) assert.equal(admission.admit(value), false);
    const broken = new TurnAdmission({ leadId: 'lead', memberIds: ['member'],
        getAgent() { throw new Error('注册表故障'); }, isLiveTask() { throw new Error('任务故障'); } });
    assert.equal(broken.admit(payload), false);
    assert.equal(broken.allowed(payload), false);
    assert.equal(broken.matchesReport(payload.agent, envelope), false);
    assert.equal(admission.admit(payload), true);
});

test('旧任务、已替换 Agent 或 session 不再准入，旧精确 session 仍可结束', async () => {
    const value = admitted();
    const { admission, payload, agent, envelope, registry } = value;
    const oldSession = agent.session;
    value.setLive(false);
    assert.equal(admission.admit({ ...payload, step: 2, messages: [] }), false);
    value.setLive(true);
    registry.set('member', { id: agent.id, session: oldSession });
    assert.equal(admission.allowed(payload), false);
    assert.equal(admission.matchesReport(agent, envelope), false);
    assert.equal(admission.admit({ ...payload, agent: registry.get('member'), step: 2, messages: [] }), false);
    registry.set('member', agent);
    agent.session = {};
    assert.equal(admission.allowed(payload), false);
    assert.equal(admission.matchesReport(agent, envelope), false);
    assert.equal(admission.observe(agent.session, { type: 'turn/end', data: { turn: 7 } }), false);
    admission.observe(oldSession, { type: 'turn/end', data: { turn: 7 } });
    await admission.settlement('member');
});

test('过期任务或已中止信号不能开始；报告匹配与融合信号独立', () => {
    const value = fixture();
    const { admission, agent, payload, envelope, controller } = value;
    admission.expect('member', envelope);
    value.setLive(false);
    assert.equal(admission.admit(payload), false);
    value.setLive(true);
    assert.equal(admission.admit(payload), true);
    assert.equal(admission.matchesReport(agent, { ...envelope, signal: new AbortController().signal }), true);
    for (const update of [{ id: 'old-task' }, { attempt: 2 }, { token: 'old-token' }, { attempt: '1' }]) {
        assert.equal(admission.matchesReport(agent, { ...envelope, ...update }), false);
    }
    controller.abort();
    assert.equal(admission.allowed(payload), false);
    assert.equal(admission.admit({ ...payload, step: 2, messages: [] }), false);
    assert.equal(admission.matchesReport(agent, envelope), true);
    const fresh = fixture();
    fresh.controller.abort();
    fresh.admission.expect('member', fresh.envelope);
    assert.equal(fresh.admission.admit(fresh.payload), false);
});

test('期待标量复制且不允许覆盖未结算状态，清理无绑定可重新期待', async () => {
    const { admission, envelope, payload } = fixture();
    admission.expect('member', envelope);
    rejects('TURN_PENDING', () => admission.expect('member', envelope));
    envelope.text = '调用者随后篡改';
    envelope.token = '随后凭证';
    // 测试回调也依赖原对象，先恢复任务凭证，仅正文保持篡改验证快照。
    envelope.token = 'credential';
    assert.equal(admission.admit(payload), true);
    rejects('TURN_PENDING', () => admission.expect('member', envelope));
    rejects('TURN_PENDING', () => admission.clear('member'));
    await admission.settlement('other');
    admission.clear('other');
});

test('成员隔离、构造参数验证及重建实例无历史授权', async () => {
    const { admission, options, payload, envelope, agent } = admitted();
    assert.equal(admission.allowed({ ...payload, agent: options.getAgent('other') }), false);
    rejects('TURN_UNKNOWN_MEMBER', () => admission.expect('stranger', envelope));
    rejects('TURN_INVALID_ARGUMENT', () => new TurnAdmission());
    rejects('TURN_INVALID_ARGUMENT', () => new TurnAdmission({ ...options, memberIds: ['member', 'member'] }));
    rejects('TURN_INVALID_ARGUMENT', () => new TurnAdmission({ ...options, memberIds: ['lead'] }));
    const restarted = new TurnAdmission(options);
    assert.equal(restarted.admit(payload), false);
    assert.equal(restarted.allowed(payload), false);
    assert.equal(restarted.matchesReport(agent, envelope), false);
    await restarted.settlement('member');
    assert.equal(admission.allowed(payload), true);
});
