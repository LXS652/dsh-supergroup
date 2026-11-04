/**
 * 账本时间线只读接口测试；创建者：DeepSeek Harness，2026-11-02。
 * 只验证增量读取、事件类型与时间戳，不改变调度语义。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableScheduler } from '../src/core/scheduler.mjs';

/** 建一个隔离账本目录，测试结束不删除（与既有约定一致）。 */
function scheduler() {
    const directory = mkdtempSync(join(tmpdir(), 'timeline-'));
    return new DurableScheduler({ directory, leadId: 'lead', memberIds: ['member-a'], maxConcurrent: 1, maxCalls: 10 });
}

test('timeline: 事件带类型、时间戳和任务状态', () => {
    const s = scheduler();
    try {
        s.enqueue('lead', { id: 't1', memberId: 'member-a', payload: 'x' });
        const reserved = s.reserve('lead', 't1');
        s.report('member-a', { id: 't1', attempt: reserved.attempt, token: reserved.token, result: 'ok' });
        const events = s.eventsSince(0);
        assert.deepEqual(events.map(event => event.kind), ['init', 'enqueue', 'dispatch', 'report']);
        assert.ok(events.every(event => typeof event.at === 'number' && event.at > 0));
        assert.deepEqual(events.map(event => event.seq), [1, 2, 3, 4]);
        assert.equal(events[1].tasks[0].state, 'queued');
        assert.equal(events[2].tasks[0].state, 'running');
        assert.equal(events[3].tasks[0].state, 'completed');
    } finally { s.close(); }
});

test('timeline: 增量读取只返回新事件', () => {
    const s = scheduler();
    try {
        s.enqueue('lead', { id: 't1', memberId: 'member-a', payload: 'x' });
        const first = s.eventsSince(1);
        assert.equal(first.length, 1);
        s.pause('lead', true);
        const next = s.eventsSince(first[0].seq);
        assert.equal(next.length, 1);
        assert.equal(next[0].kind, 'pause');
        assert.equal(next[0].paused, true);
        assert.deepEqual(s.eventsSince(next[0].seq), []);
    } finally { s.close(); }
});

test('timeline: 超时写出的类型可区分', () => {
    const s = scheduler();
    try {
        s.enqueue('lead', { id: 't1', memberId: 'member-a', payload: 'x', timeoutMs: 1 });
        s.reserve('lead', 't1');
        const expired = s.expire('lead');
        assert.deepEqual(expired, ['t1']);
        const timeoutEvent = s.eventsSince(0).at(-1);
        assert.equal(timeoutEvent.kind, 'timeout');
        assert.equal(timeoutEvent.tasks[0].state, 'uncertain');
        assert.equal(timeoutEvent.tasks[0].reason, 'timeout');
    } finally { s.close(); }
});
