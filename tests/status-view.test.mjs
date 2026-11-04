/**
 * 状态视图纯函数测试；创建者：DeepSeek Harness，2026-11-02。
 * 重点守住一条：任何"没有回执/没有收敛"的情况都不能显示成完成。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    UI_STATES,
    deriveTaskView,
    deriveSessionView,
    groupByMember,
    buildPanelView,
} from '../src/core/status-view.mjs';

/** 构造合法任务，字段与账本一致。 */
function task(overrides = {}) {
    return {
        id: 't1',
        memberId: 'member-a',
        state: 'queued',
        attempt: 0,
        receipt: null,
        effectPending: false,
        reason: null,
        deadline: null,
        ...overrides,
    };
}

test('status: 完成必须有匹配当前 attempt 的回执', () => {
    const ok = deriveTaskView(task({ state: 'completed', attempt: 2, receipt: { attempt: 2, token: 'abc', result: 'x' } }));
    assert.equal(ok.state, UI_STATES.completed);
    assert.equal(ok.needsHuman, false);

    const noReceipt = deriveTaskView(task({ state: 'completed', attempt: 2, receipt: null }));
    assert.equal(noReceipt.state, UI_STATES.needsHuman);
    assert.equal(noReceipt.reason, 'completed_without_matching_receipt');

    const staleReceipt = deriveTaskView(task({ state: 'completed', attempt: 2, receipt: { attempt: 1, token: 'abc' } }));
    assert.equal(staleReceipt.state, UI_STATES.needsHuman);
});

test('status: 已预留未拿回执是"消息待投递"，不是执行中也不是完成', () => {
    const pending = deriveTaskView(task({ state: 'running', attempt: 1, effectPending: true, receipt: null }));
    assert.equal(pending.state, UI_STATES.deliveryPending);
    assert.equal(pending.needsHuman, true);

    const delivered = deriveTaskView(task({
        state: 'running', attempt: 1, effectPending: true, receipt: { messageId: 'm-1' },
    }));
    assert.equal(delivered.state, UI_STATES.running);
    assert.equal(delivered.needsHuman, false);
});

test('status: uncertain 一律进等待人工，并保留原因', () => {
    assert.equal(deriveTaskView(task({ state: 'uncertain', reason: 'restart' })).state, UI_STATES.needsHuman);
    assert.equal(deriveTaskView(task({ state: 'uncertain', reason: 'restart' })).reason, 'restart');
    assert.equal(deriveTaskView(task({ state: 'uncertain', reason: null })).reason, 'uncertain');
});

test('status: 暂停时排队单独标注，不混进完成', () => {
    assert.equal(deriveTaskView(task({ state: 'queued' }), { paused: true }).state, UI_STATES.queuedPaused);
    assert.equal(deriveTaskView(task({ state: 'queued' }), { paused: false }).state, UI_STATES.queued);
});

test('status: 会话空闲只在完全没有活跃任务时成立', () => {
    const idle = deriveSessionView([]);
    assert.equal(idle.state, 'idle');
    assert.equal(idle.label, '会话空闲');

    const active = deriveSessionView([task({ state: 'running', effectPending: true, receipt: { messageId: 'm' } })]);
    assert.equal(active.state, UI_STATES.running);

    const waiting = deriveSessionView([task({ state: 'uncertain' })]);
    assert.equal(waiting.state, UI_STATES.needsHuman);

    const done = deriveSessionView([task({ state: 'completed', attempt: 1, receipt: { attempt: 1, token: 't' } })]);
    assert.equal(done.state, UI_STATES.completed);
    assert.equal(done.counts.completed, 1);
});

test('status: 超时不改变账本状态，只作为明细提示', () => {
    const view = deriveTaskView(
        task({ state: 'running', effectPending: true, receipt: { messageId: 'm' }, deadline: 1000 }),
        { now: 2000 },
    );
    assert.equal(view.state, UI_STATES.running);
    assert.equal(view.reason, 'deadline_passed');
});

test('status: 畸形任务降级为失败卡片，不阻断整棵界面', () => {
    const view = deriveSessionView([{ id: '', state: 'running' }, { id: 'ok', state: 'running' }]);
    assert.equal(view.counts.total, 1);
    assert.equal(view.counts.active, 1);
});

test('status: 按成员分组保留配置顺序并单列未知成员', () => {
    const groups = groupByMember(
        [task({ id: 'a1', memberId: 'member-a' }), task({ id: 'c1', memberId: 'member-c' })],
        ['member-a', 'member-b'],
    );
    assert.deepEqual(groups.map(group => group.memberId), ['member-a', 'member-b', 'member-c']);
    assert.equal(groups[1].tasks.length, 0);
    assert.equal(groups[2].tasks.length, 1);
});

test('status: 面板视图给出金额不可用的明确说明', () => {
    const view = buildPanelView(
        { tasks: [task({ state: 'running', effectPending: true, receipt: { messageId: 'm' } })], memberIds: ['member-a'], sequence: 7, calls: 3, maxCalls: 50 },
        { budget: { tools: 4, streams: 5, maxTools: 100, maxStreams: 50 }, now: 100 },
    );
    assert.equal(view.sequence, 7);
    assert.equal(view.members[0].memberId, 'member-a');
    assert.equal(view.usage.tools, 4);
    assert.equal(view.usage.amount, null);
    assert.match(view.usage.amountNote, /金额不可用/);
    assert.equal(view.waiting.length, 0);
});
