/** 协调器单测：派工、未知成员、失败落账、事件结算、重启恢复清单。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Coordinator } from '../src/core/coordinator.mjs';
import { SessionRegistry } from '../src/core/registry.mjs';
import { DeliveryChannel, ResultTracker } from '../src/core/delivery.mjs';
import { TaskLedger } from '../src/core/ledger.mjs';

/** 造一套“主会话 + 两个成员”的最小环境。 */
function setup({ prompt } = {}) {
    const registry = new SessionRegistry({
        lead: 'session-lead-a',
        members: [
            { sessionId: 'session-member-a', label: '执行助手', roleClass: 'assistant' },
            { sessionId: 'persona-mailbox', label: '人设邮箱', roleClass: 'persona' }
        ]
    });
    const channel = new DeliveryChannel({ prompt: prompt ?? (async () => ({ accepted: true })) });
    const tracker = new ResultTracker();
    return { registry, channel, tracker, coordinator: new Coordinator({ registry, channel, tracker }) };
}

test('派工：只登记为已投递，不得算完成；主会话与未知成员都被拒绝', async () => {
    const { coordinator } = setup();
    const task = await coordinator.dispatch('session-member-a', '请整理今天的邮件摘要', { requestId: 'r-1' });
    assert.equal(task.state, 'delivered');
    assert.equal(task.label, '执行助手');
    assert.equal(coordinator.outstanding().length, 1);
    await assert.rejects(coordinator.dispatch('session-lead-a', 'x'), /LEAD_NOT_DISPATCHABLE/);
    await assert.rejects(coordinator.dispatch('session-ghost', 'x'), /UNKNOWN_MEMBER/);
});

test('投递失败：记成 failed 并带错误码，不进入未结算', async () => {
    const { coordinator } = setup({
        prompt: async () => {
            const error = new Error('session "x" not found');
            error.code = 'session/not-found';
            throw error;
        }
    });
    const task = await coordinator.dispatch('session-member-a', 'x', { requestId: 'r-bad' });
    assert.equal(task.state, 'failed');
    assert.equal(task.error, 'session/not-found');
    assert.equal(coordinator.outstanding().length, 0);
});

test('结算：只有看到自己那条消息的回合结束后才更新结果', async () => {
    const { coordinator } = setup();
    await coordinator.dispatch('persona-mailbox', '写一封回信', { requestId: 'r-2' });
    coordinator.observe('persona-mailbox', { type: 'turn/start', data: { turn: 7 } });
    coordinator.observe('persona-mailbox', { type: 'assistant/message', data: { turn: 7, message: { content: [{ type: 'text', text: '别人的' }] } } });
    coordinator.observe('persona-mailbox', { type: 'turn/end', data: { turn: 7, reason: 'completed' } });
    assert.equal(coordinator.outstanding().length, 1, '别人的回合不能结算我们的工单');

    coordinator.observe('persona-mailbox', { type: 'user/message', data: { turn: 8, source: { kind: 'user', rpcId: 'r-2' } } });
    coordinator.observe('persona-mailbox', { type: 'turn/start', data: { turn: 8 } });
    coordinator.observe('persona-mailbox', { type: 'assistant/message', data: { turn: 8, message: { content: [{ type: 'text', text: '信已写好' }] } } });
    coordinator.observe('persona-mailbox', { type: 'turn/end', data: { turn: 8, reason: 'completed' } });

    const [task] = coordinator.tasks();
    assert.equal(task.state, 'completed');
    assert.equal(task.result, '信已写好');
    assert.equal(task.turn, 8);
    assert.equal(coordinator.outstanding().length, 0);
});

test('重启恢复：已投递未结算一律 uncertain、需人工，不自动重发', async () => {
    const { coordinator } = setup();
    await coordinator.dispatch('session-member-a', '长任务', { requestId: 'r-3' });
    const plan = coordinator.recoveryPlan();
    assert.equal(plan.length, 1);
    assert.equal(plan[0].state, 'uncertain');
    assert.equal(plan[0].decision, 'needs_human');
    assert.equal(plan[0].requestId, 'r-3');
});

test('重复投递同一 requestId 返回同一条工单，不重复登记', async () => {
    const { coordinator } = setup();
    await coordinator.dispatch('session-member-a', '一', { requestId: 'r-4' });
    const second = await coordinator.dispatch('session-member-a', '一', { requestId: 'r-4' });
    assert.equal(second.duplicate, true);
    assert.equal(coordinator.tasks().length, 1);
});

test('recover 后的 uncertain 可人工裁决，且 recoveryPlan 不再恒为空', async () => {
    const ledger = new TaskLedger();
    const { registry, channel } = setup();
    const first = new Coordinator({
        registry,
        channel,
        tracker: new ResultTracker(),
        ledger,
        groupId: 'g-a'
    });
    await first.dispatch('session-member-a', '长任务', { requestId: 'r-9' });
    await first.flush();

    const second = new Coordinator({
        registry,
        channel,
        tracker: new ResultTracker(),
        ledger,
        groupId: 'g-a'
    });
    const plan = await second.recover();
    assert.equal(plan.length, 1);
    assert.equal(plan[0].state, 'uncertain');
    assert.equal(second.recoveryPlan().length, 1, '恢复后仍应列出待裁决工单');

    const resolved = second.resolveHuman('r-9', 'accept');
    assert.equal(resolved.state, 'completed');
    await second.flush();

    const third = new Coordinator({
        registry,
        channel,
        tracker: new ResultTracker(),
        ledger,
        groupId: 'g-a'
    });
    const planAfter = await third.recover();
    assert.deepEqual(planAfter, [], '已裁决的工单不应再进恢复清单');
    assert.equal(third.tasks()[0].state, 'completed');
});

test('跨整体：A 整体的工单 rpcId 不会被 B 整体误判成人类插话', async () => {
    const channel = new DeliveryChannel({ prompt: async () => ({ accepted: true }) });
    const member = 'session-member-a';
    const registryA = new SessionRegistry({ lead: 'session-lead-a', members: [{ sessionId: member }] });
    const registryB = new SessionRegistry({ lead: 'session-lead-b', members: [{ sessionId: member }] });
    const coordinatorA = new Coordinator({
        registry: registryA,
        channel,
        tracker: new ResultTracker(),
        ledger: new TaskLedger(),
        groupId: 'g-a'
    });
    const coordinatorB = new Coordinator({
        registry: registryB,
        channel,
        tracker: new ResultTracker(),
        ledger: new TaskLedger(),
        groupId: 'g-b'
    });

    await coordinatorA.dispatch(member, 'A 的工单', { requestId: 'r-a' });
    await coordinatorB.dispatch(member, 'B 的工单', { requestId: 'r-b' });

    // 这条消息是 A 整体派出去的，B 整体不认识这个 requestId，但全局通道认识。
    coordinatorB.observe(member, { type: 'user/message', data: { source: { kind: 'user', rpcId: 'r-a' } } });
    assert.equal(coordinatorB.tasks()[0].state, 'delivered', '兄弟整体派工消息不能被当成人插话');

    coordinatorB.observe(member, { type: 'user/message', data: { source: { kind: 'user', rpcId: 'human-1' } } });
    assert.equal(coordinatorB.tasks()[0].state, 'needs_human');
    assert.equal(coordinatorB.tasks()[0].reason, 'human_interrupt');
});

test('跨整体并发：A 还在 prompt 往返时，B 也不能把 A 的消息当人类插话', async () => {
    const member = 'session-member-a';
    let coordinatorB;
    const channel = new DeliveryChannel({
        prompt: async () => {
            // 模拟宿主在 receipt 返回前同步推收件箱事件：此时 A 的 id 还未进 #issued，
            // B 只能靠 channel 的在途标记认出它是兄弟派工，而不是人类插话。
            coordinatorB.observe(member, {
                type: 'agent/inbox/spliced',
                data: { inserted: [{ source: { kind: 'user', rpcId: 'r-a-live' } }] }
            });
            return { accepted: true };
        }
    });
    const registryA = new SessionRegistry({ lead: 'session-lead-a', members: [{ sessionId: member }] });
    const registryB = new SessionRegistry({ lead: 'session-lead-b', members: [{ sessionId: member }] });
    const coordinatorA = new Coordinator({
        registry: registryA,
        channel,
        tracker: new ResultTracker(),
        ledger: new TaskLedger(),
        groupId: 'g-a'
    });
    coordinatorB = new Coordinator({
        registry: registryB,
        channel,
        tracker: new ResultTracker(),
        ledger: new TaskLedger(),
        groupId: 'g-b'
    });

    await coordinatorB.dispatch(member, 'B 的工单', { requestId: 'r-b' });
    await coordinatorA.dispatch(member, 'A 的工单', { requestId: 'r-a-live' });

    assert.equal(coordinatorB.tasks()[0].state, 'delivered', '在途兄弟工单不能被当成人插话');
    assert.equal(channel.known('r-a-live'), true, '投递完成后 id 应进入已发集合');
});
