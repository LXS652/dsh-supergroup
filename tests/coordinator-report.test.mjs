/** 成员上报：状态机、幂等、身份边界、账本失败与对账复核。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Coordinator } from '../src/core/coordinator.mjs';
import { SessionRegistry } from '../src/core/registry.mjs';
import { DeliveryChannel, ResultTracker } from '../src/core/delivery.mjs';
import { TaskLedger } from '../src/core/ledger.mjs';

function setup({ prompt, ledger } = {}) {
    const registry = new SessionRegistry({
        lead: 'session-lead-a',
        members: [
            { sessionId: 'session-member-a', label: '执行助手', roleClass: 'assistant' },
            { sessionId: 'persona-mailbox', label: '人设邮箱', roleClass: 'persona' }
        ]
    });
    const channel = new DeliveryChannel({ prompt: prompt ?? (async () => ({ accepted: true })) });
    const tracker = new ResultTracker();
    return new Coordinator({ registry, channel, tracker, ledger, groupId: 'g-test' });
}

async function deliver(coordinator, member = 'session-member-a', requestId = 'r-1') {
    return coordinator.dispatch(member, '做一件事', { requestId });
}

function report(coordinator, patch = {}) {
    return coordinator.report('session-member-a', {
        status: 'completed',
        summary: '已完成，证据见 detail',
        detail: { ok: true },
        ...patch
    });
}

function taskOf(coordinator, requestId) {
    return coordinator.tasks().find(task => task.requestId === requestId);
}

test('completed 上报：终态但标未核实，账本记 report 而不是 settled', async () => {
    const ledger = new TaskLedger();
    const coordinator = setup({ ledger });
    await deliver(coordinator, 'session-member-a', 'r-c1');
    const outcome = await report(coordinator, { summary: '做完了' });
    assert.equal(outcome.taskState, 'completed');
    assert.equal(outcome.provisional, true);
    assert.equal(outcome.duplicate, false);
    const task = taskOf(coordinator, 'r-c1');
    assert.equal(task.state, 'completed');
    assert.equal(task.provisional, true);
    assert.equal(task.verified, false);
    assert.equal(task.source, 'member-report');
    assert.equal(task.result, '做完了');
    const records = await ledger.load();
    assert.equal(records.filter(record => record.kind === 'report').length, 1);
    assert.equal(records.filter(record => record.kind === 'settled').length, 0);
});

test('blocked 上报：进入 needs_human，reason 标记 member_blocked', async () => {
    const coordinator = setup();
    await deliver(coordinator, 'session-member-a', 'r-c2');
    await report(coordinator, { status: 'blocked', summary: '缺少权限' });
    const task = taskOf(coordinator, 'r-c2');
    assert.equal(task.state, 'needs_human');
    assert.equal(task.reason, 'member_blocked');
    assert.equal(task.provisional, false);
});

test('failed 上报：直接失败，provisional 为 false', async () => {
    const coordinator = setup();
    await deliver(coordinator, 'session-member-a', 'r-c3');
    await report(coordinator, { status: 'failed', summary: '命令报错' });
    const task = taskOf(coordinator, 'r-c3');
    assert.equal(task.state, 'failed');
    assert.equal(task.reason, 'member_failed');
    assert.equal(task.provisional, false);
});

test('幂等：同一 reportKey 重复上报返回 duplicate，不追加第二条 report', async () => {
    const ledger = new TaskLedger();
    const coordinator = setup({ ledger });
    await deliver(coordinator, 'session-member-a', 'r-c4');
    await report(coordinator, { summary: '同样内容' });
    const again = await report(coordinator, { summary: '同样内容' });
    assert.equal(again.duplicate, true);
    const records = await ledger.load();
    assert.equal(records.filter(record => record.kind === 'report').length, 1);
});

test('冲突：不同 reportKey 的二次上报被拒绝，不覆盖已有终态', async () => {
    const coordinator = setup();
    await deliver(coordinator, 'session-member-a', 'r-c5');
    await report(coordinator, { summary: '第一次' });
    await assert.rejects(
        report(coordinator, { summary: '第二次' }),
        error => error.code === 'REPORT_CONFLICT'
    );
    assert.equal(taskOf(coordinator, 'r-c5').result, '第一次');
});

test('无在途：名下没有工单时直接报 REPORT_NO_TASK，账本不新增', async () => {
    const ledger = new TaskLedger();
    const coordinator = setup({ ledger });
    await assert.rejects(
        report(coordinator, { summary: '空报' }),
        error => error.code === 'REPORT_NO_TASK'
    );
    assert.equal((await ledger.load()).filter(record => record.kind === 'report').length, 0);
});

test('消歧：两条在途时带自己的 requestId 只结算指定那一条', async () => {
    const coordinator = setup();
    await deliver(coordinator, 'session-member-a', 'r-pick-1');
    await deliver(coordinator, 'session-member-a', 'r-pick-2');
    const outcome = await report(coordinator, { requestId: 'r-pick-2', summary: '只报第二单' });
    assert.equal(outcome.requestId, 'r-pick-2');
    assert.equal(taskOf(coordinator, 'r-pick-1').state, 'delivered');
    assert.equal(taskOf(coordinator, 'r-pick-2').state, 'completed');
});

test('身份边界：requestId 只能在自己的单里查，查别人的单报 REPORT_NO_TASK', async () => {
    const coordinator = setup();
    await deliver(coordinator, 'persona-mailbox', 'r-other');
    await assert.rejects(
        coordinator.report('session-member-a', {
            status: 'completed',
            summary: '冒领',
            requestId: 'r-other'
        }),
        error => error.code === 'REPORT_NO_TASK'
    );
});

test('歧义：不带 requestId 且名下多条在途时返回候选 requestId', async () => {
    const coordinator = setup();
    await deliver(coordinator, 'session-member-a', 'r-m1');
    await deliver(coordinator, 'session-member-a', 'r-m2');
    await assert.rejects(
        report(coordinator),
        error => error.code === 'REPORT_AMBIGUOUS'
            && error.data.requestIds.slice().sort().join(',') === 'r-m1,r-m2'
    );
});

test('账本失败：返回 REPORT_LEDGER_FAILED，内存状态保持 delivered', async () => {
    const brokenLedger = { append: async () => { throw new Error('disk full'); } };
    const coordinator = setup({ ledger: brokenLedger });
    await deliver(coordinator, 'session-member-a', 'r-c8');
    await assert.rejects(
        report(coordinator, { summary: '写不进去' }),
        error => error.code === 'REPORT_LEDGER_FAILED'
    );
    const task = taskOf(coordinator, 'r-c8');
    assert.equal(task.state, 'delivered');
    assert.equal(task.result, '');
});

test('重启后的 uncertain 上报：source 标 member-report-after-restart', async () => {
    const ledger = new TaskLedger();
    const first = setup({ ledger });
    await deliver(first, 'session-member-a', 'r-c9');
    await first.flush();
    const restarted = setup({ ledger });
    await restarted.recover();
    assert.equal(taskOf(restarted, 'r-c9').state, 'uncertain');
    const outcome = await report(restarted, { summary: '重启后补报' });
    assert.equal(outcome.source, 'member-report-after-restart');
    assert.equal(taskOf(restarted, 'r-c9').state, 'completed');
});

test('对账复核：provisional completed 被 turn/end 证据升级为 verified', async () => {
    const coordinator = setup();
    await deliver(coordinator, 'session-member-a', 'r-c10');
    await report(coordinator, { summary: '我先说完成了' });
    assert.equal(taskOf(coordinator, 'r-c10').verified, false);
    const events = [
        { type: 'user/message', data: { source: { kind: 'user', rpcId: 'r-c10' } } },
        { type: 'turn/start', data: { turn: 12 } },
        { type: 'assistant/message', data: { turn: 12, message: { content: [{ type: 'text', text: '实际完成文本' }] } } },
        { type: 'turn/end', data: { turn: 12, reason: 'completed' } }
    ];
    const outcome = await coordinator.reconcileFromHistory('r-c10', events);
    assert.equal(outcome.state, 'settled');
    const task = taskOf(coordinator, 'r-c10');
    assert.equal(task.state, 'completed');
    assert.equal(task.provisional, false);
    assert.equal(task.verified, true);
    assert.equal(task.result, '实际完成文本');
});
