/** 并发与人工优先单测：人类插话 → 转等待人工 + 留证；裁决需显式动作。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Coordinator } from '../src/core/coordinator.mjs';
import { SessionRegistry } from '../src/core/registry.mjs';
import { DeliveryChannel, ResultTracker } from '../src/core/delivery.mjs';

function setup() {
    const registry = new SessionRegistry({
        lead: 'session-lead',
        members: [{ sessionId: 'session-member-a', label: '执行助手', roleClass: 'assistant' }]
    });
    const channel = new DeliveryChannel({ prompt: async () => ({ accepted: true }) });
    const tracker = new ResultTracker();
    return new Coordinator({ registry, channel, tracker });
}

test('人类插话：工单转 needs_human 并留证，后续 turn/end 不再算作工单结果', async () => {
    const coordinator = setup();
    const task = await coordinator.dispatch('session-member-a', '整理邮件', { requestId: 'r-1' });
    coordinator.observe('session-member-a', { type: 'turn/start', data: { turn: 3 } });
    coordinator.observe('session-member-a', { type: 'user/message', data: { turn: 3, source: { kind: 'user', rpcId: 'r-1' } } });

    // 人类在这轮里插了一句
    coordinator.observe('session-member-a', { type: 'user/message', data: { turn: 3, source: { kind: 'user', rpcId: 'human-7' } } });
    const [afterInterrupt] = coordinator.tasks();
    assert.equal(afterInterrupt.state, 'needs_human');
    assert.equal(afterInterrupt.reason, 'human_interrupt');
    assert.equal(afterInterrupt.humanInterventions.length, 1);
    assert.equal(afterInterrupt.humanInterventions[0].rpcId, 'human-7');
    assert.equal(afterInterrupt.humanInterventions[0].turn, 3);

    // 即使它跑完了，也不自动把结果算成工单结果
    coordinator.observe('session-member-a', { type: 'assistant/message', data: { turn: 3, message: { content: [{ type: 'text', text: '混着人和系统的回答' }] } } });
    coordinator.observe('session-member-a', { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } });
    const [final] = coordinator.tasks();
    assert.equal(final.state, 'needs_human');
    assert.equal(final.result, '');
    assert.equal(coordinator.outstanding().length, 0, 'needs_human 不再算未结算');
});

test('不误判：自己那条消息与无 source 的注入消息都不算人类插话', async () => {
    const coordinator = setup();
    await coordinator.dispatch('session-member-a', '工单', { requestId: 'r-2' });
    coordinator.observe('session-member-a', { type: 'user/message', data: { source: { kind: 'user', rpcId: 'r-2' } } });
    // 运行时注入（没有 source）不能被当成人类消息
    coordinator.observe('session-member-a', { type: 'user/message', data: { content: [{ type: 'text', text: 'memory-context' }] } });
    const [task] = coordinator.tasks();
    assert.equal(task.state, 'delivered');
    assert.equal(task.humanInterventions, undefined);
});

test('裁决：只有 needs_human 能裁决，accept/fail 各自落状态并留痕', async () => {
    const coordinator = setup();
    await coordinator.dispatch('session-member-a', '工单', { requestId: 'r-3' });
    assert.throws(() => coordinator.resolveHuman('r-3', 'accept'), /NOT_NEEDS_HUMAN/);
    assert.throws(() => coordinator.resolveHuman('r-ghost', 'accept'), /UNKNOWN_TASK/);

    coordinator.observe('session-member-a', { type: 'user/message', data: { source: { kind: 'user', rpcId: 'r-3' } } });
    coordinator.observe('session-member-a', { type: 'user/message', data: { source: { kind: 'user', rpcId: 'human-9' } } });
    const accepted = coordinator.resolveHuman('r-3', 'accept');
    assert.equal(accepted.state, 'completed');
    assert.equal(accepted.reason, 'human_accepted');
    assert.equal(accepted.resolvedBy, 'human');
    assert.ok(accepted.resolvedAt);

    const task2 = await coordinator.dispatch('session-member-a', '第二个工单', { requestId: 'r-4' });
    assert.equal(task2.state, 'delivered');
    coordinator.observe('session-member-a', { type: 'user/message', data: { source: { kind: 'user', rpcId: 'r-4' } } });
    coordinator.observe('session-member-a', { type: 'user/message', data: { source: { kind: 'user', rpcId: 'human-10' } } });
    const failed = coordinator.resolveHuman('r-4', 'fail');
    assert.equal(failed.state, 'failed');
    assert.equal(failed.reason, 'human_failed');
});

test('并发：同一成员可同时挂两个工单；人类插入会让该会话的在跑工单都转人工', async () => {
    const coordinator = setup();
    await coordinator.dispatch('session-member-a', 'A', { requestId: 'r-a' });
    await coordinator.dispatch('session-member-a', 'B', { requestId: 'r-b' });
    assert.equal(coordinator.outstanding().length, 2);

    coordinator.observe('session-member-a', { type: 'user/message', data: { source: { kind: 'user', rpcId: 'r-a' } } });
    coordinator.observe('session-member-a', { type: 'user/message', data: { source: { kind: 'user', rpcId: 'human-x' } } });
    const states = coordinator.tasks().map(task => [task.requestId, task.state]);
    // 两个都在跑：人类的插入会让两单都转人工（同一会话的结果已不可归因）
    assert.deepEqual(states, [['r-a', 'needs_human'], ['r-b', 'needs_human']]);
});

test('收件箱阶段就能认出人类插话：agent/inbox/spliced 的 inserted 里带别人的 rpcId', async () => {
    const coordinator = setup();
    await coordinator.dispatch('session-member-a', '整理邮件', { requestId: 'r-i1' });
    // 真人消息在会话正忙时先进收件箱，此时还没有 user/message
    coordinator.observe('session-member-a', {
        type: 'agent/inbox/spliced',
        data: { removedCount: 0, outcome: 'inserted', inserted: [{ source: { kind: 'user', rpcId: 'human-inbox' } }] }
    });
    const [task] = coordinator.tasks();
    assert.equal(task.state, 'needs_human');
    assert.equal(task.reason, 'human_interrupt');
    assert.equal(task.humanInterventions[0].rpcId, 'human-inbox');
    assert.match(task.humanInterventions[0].evidence, /agent\/inbox\/spliced/);
});

test('收件箱阶段的自身投递与无 source 消息都不算插话', async () => {
    const coordinator = setup();
    await coordinator.dispatch('session-member-a', '工单', { requestId: 'r-i2' });
    coordinator.observe('session-member-a', {
        type: 'agent/inbox/spliced',
        data: { removedCount: 0, inserted: [{ source: { kind: 'user', rpcId: 'r-i2' } }, { content: [{ type: 'text', text: 'memory-context' }] }] }
    });
    assert.equal(coordinator.tasks()[0].state, 'delivered');
});

test('并发派工：兄弟工单的消息不会被误判成人类插话', async () => {
    const coordinator = setup();
    await coordinator.dispatch('session-member-a', 'A', { requestId: 'r-a' });
    await coordinator.dispatch('session-member-a', 'B', { requestId: 'r-b' });
    coordinator.observe('session-member-a', { type: 'user/message', data: { source: { kind: 'user', rpcId: 'r-a' } } });
    coordinator.observe('session-member-a', { type: 'user/message', data: { source: { kind: 'user', rpcId: 'r-b' } } });
    assert.deepEqual(coordinator.tasks().map(task => task.state), ['delivered', 'delivered']);
    assert.equal(coordinator.outstanding().length, 2);
});
