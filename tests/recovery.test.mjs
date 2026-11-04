/** 重启恢复单测：账本重放、uncertain 判定、绝不自动重发。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Coordinator } from '../src/core/coordinator.mjs';
import { SessionRegistry } from '../src/core/registry.mjs';
import { DeliveryChannel, ResultTracker } from '../src/core/delivery.mjs';
import { TaskLedger, rebuildTasks } from '../src/core/ledger.mjs';

const MEMBER = 'session-member-a';

function make(ledgerFile, calls = []) {
    const registry = new SessionRegistry({ lead: 'session-lead', members: [{ sessionId: MEMBER, label: '执行助手', roleClass: 'assistant' }] });
    const channel = new DeliveryChannel({
        prompt: async (request) => {
            calls.push(request.requestId);
            return { accepted: true };
        }
    });
    const ledger = new TaskLedger({ file: ledgerFile });
    return { coordinator: new Coordinator({ registry, channel, tracker: new ResultTracker(), ledger }), calls };
}

test('重启后：已结算的工单保持完成，不会被重放成未完成', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ms-recovery-'));
    try {
        const file = join(directory, 'tasks.jsonl');
        const first = make(file);
        await first.coordinator.dispatch(MEMBER, '工单一', { requestId: 'r-1' });
        first.coordinator.observe(MEMBER, { type: 'turn/start', data: { turn: 1 } });
        first.coordinator.observe(MEMBER, { type: 'user/message', data: { source: { kind: 'user', rpcId: 'r-1' } } });
        first.coordinator.observe(MEMBER, { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '做完了' }] } } });
        first.coordinator.observe(MEMBER, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });

        // 等账本落盘（append 是异步的）
        await first.coordinator.flush();

        const second = make(file);
        const plan = await second.coordinator.recover();
        assert.deepEqual(plan, [], '已结算的工单不该进恢复清单');
        const [task] = second.coordinator.tasks();
        assert.equal(task.state, 'completed');
        assert.equal(task.result, '做完了');
        assert.equal(second.calls.length, 0, '恢复过程不得自动重发');
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('重启后：退出时仍未结算 → uncertain，需人工；幂等任务只给 retry 建议', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ms-recovery2-'));
    try {
        const file = join(directory, 'tasks.jsonl');
        const first = make(file);
        await first.coordinator.dispatch(MEMBER, '普通工单', { requestId: 'r-normal' });
        await first.coordinator.dispatch(MEMBER, '幂等工单', { requestId: 'r-idem', idempotent: true });
        await first.coordinator.flush();

        const second = make(file);
        const plan = await second.coordinator.recover();
        const byId = new Map(plan.map(item => [item.requestId, item]));
        assert.equal(byId.get('r-normal').state, 'uncertain');
        assert.equal(byId.get('r-normal').decision, 'needs_human');
        assert.equal(byId.get('r-idem').decision, 'retry');
        assert.equal(second.calls.length, 0, '即使幂等也不得自动重发，只给建议');

        // 恢复后的任务表里状态一律 uncertain，绝不冒充 completed
        for (const task of second.coordinator.tasks()) assert.equal(task.state, 'uncertain');
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('人类插话会被记进账本，重启后仍是 needs_human', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ms-recovery3-'));
    try {
        const file = join(directory, 'tasks.jsonl');
        const first = make(file);
        await first.coordinator.dispatch(MEMBER, '工单', { requestId: 'r-h' });
        first.coordinator.observe(MEMBER, { type: 'user/message', data: { source: { kind: 'user', rpcId: 'r-h' } } });
        first.coordinator.observe(MEMBER, { type: 'user/message', data: { source: { kind: 'user', rpcId: 'human-1' } } });
        await first.coordinator.flush();

        const second = make(file);
        await second.coordinator.recover();
        const [task] = second.coordinator.tasks();
        assert.equal(task.state, 'needs_human');
        assert.equal(task.reason, 'human_interrupt');
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('旧账本没有 groupId：只有迁移整体认领，另一个整体不会复制这批工单', async () => {
    const ledger = new TaskLedger();
    await ledger.append({ kind: 'dispatch', requestId: 'r-old', sessionId: MEMBER, text: '历史工单' });
    const registry = new SessionRegistry({ lead: 'session-lead', members: [{ sessionId: MEMBER }] });
    const channel = new DeliveryChannel({ prompt: async () => ({ accepted: true }) });

    const migrated = new Coordinator({ registry, channel, tracker: new ResultTracker(), ledger, groupId: 'g-old' });
    const plan = await migrated.recover({ adoptNullGroup: true });
    assert.equal(plan.length, 1);
    assert.equal(migrated.tasks()[0].groupId, 'g-old');
    await migrated.flush();

    const other = new Coordinator({ registry, channel, tracker: new ResultTracker(), ledger, groupId: 'g-new' });
    const otherPlan = await other.recover({ adoptNullGroup: true });
    assert.deepEqual(otherPlan, [], '已经归属 g-old 的工单不能被 g-new 再认领');
    assert.equal(other.tasks().length, 0);
});

test('账本容错：半截行（上次崩溃）不影响其它记录', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ms-recovery4-'));
    try {
        const file = join(directory, 'tasks.jsonl');
        const ledger = new TaskLedger({ file });
        await ledger.append({ kind: 'dispatch', requestId: 'r-x', sessionId: MEMBER, text: 't' });
        await appendFile(file, '{"kind":"settled","requestId":"r-x"', 'utf8');
        const events = await ledger.load();
        assert.equal(events.length, 1);
        const tasks = rebuildTasks(events);
        assert.equal(tasks.get('r-x').state, 'delivered');
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
