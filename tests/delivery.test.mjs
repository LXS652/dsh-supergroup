/** 投递与归集单测：请求形状、幂等、错误映射、按 rpcId 找回结果。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeliveryChannel, REPORT_HINT, buildPromptRequest, locateResult, ResultTracker, visibleText } from '../src/core/delivery.mjs';

/** 造一条最简 session/event。 */
function event(type, data) {
    return { type, data };
}

test('请求形状：排队不带 mode，steer 才带，空文本拒绝', () => {
    const queued = buildPromptRequest({ sessionId: 's1', requestId: 'r1', text: 'hi' });
    assert.deepEqual(queued, { sessionId: 's1', requestId: 'r1', content: [{ type: 'text', text: `hi\n\n${REPORT_HINT}` }] });
    const steered = buildPromptRequest({ sessionId: 's1', requestId: 'r2', text: 'ho', mode: 'steer' });
    assert.equal(steered.mode, 'steer');
    assert.throws(() => buildPromptRequest({ sessionId: 's1', requestId: 'r3', text: '   ' }), /EMPTY_TEXT/);
    assert.throws(() => buildPromptRequest({ sessionId: 's1', requestId: 'r4', text: 'x', mode: 'later' }), /INVALID_MODE/);
});

test('投递：不传 signal 也要给出真实 AbortSignal（宿主首行就会 throwIfAborted）', async () => {
    let seen = null;
    const channel = new DeliveryChannel({
        prompt: async (request, signal) => {
            seen = signal;
            signal.throwIfAborted();
            return { accepted: true };
        }
    });
    const result = await channel.deliver({ sessionId: 's1' }, 'hi', { requestId: 'r-signal' });
    assert.equal(result.ok, true);
    assert.ok(seen instanceof AbortSignal, '必须传 AbortSignal，而不是 undefined');
});

test('投递：同一 requestId 只发一次，失败不登记可重试', async () => {
    const calls = [];
    let fail = true;
    const channel = new DeliveryChannel({
        prompt: async (request) => {
            calls.push(request);
            if (fail) {
                fail = false;
                const error = new Error('session "s1" not found');
                error.code = 'session/not-found';
                throw error;
            }
            return { accepted: true };
        }
    });
    const member = { sessionId: 's1' };
    const first = await channel.deliver(member, 'hello', { requestId: 'r-1' });
    assert.equal(first.ok, false);
    assert.equal(first.code, 'session/not-found');
    assert.equal(channel.known('r-1'), false);

    const second = await channel.deliver(member, 'hello', { requestId: 'r-1' });
    assert.equal(second.ok, true);
    assert.equal(second.accepted, true);
    assert.equal(calls.length, 2);

    const third = await channel.deliver(member, 'hello', { requestId: 'r-1' });
    assert.equal(third.duplicate, true);
    assert.equal(calls.length, 2, '重复投递不应再次调用宿主');
});

test('归集：按 source.rpcId 定位回合，取该回合最后一条可见文本', () => {
    const events = [
        event('turn/start', { turn: 1 }),
        event('user/message', { source: { kind: 'user', rpcId: 'other' }, content: [{ type: 'text', text: '无关' }] }),
        event('assistant/message', { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: '旧回合' }] } }),
        event('turn/end', { turn: 1, reason: 'completed' }),
        event('user/message', { source: { kind: 'user', rpcId: 'r-9' }, content: [{ type: 'text', text: '工单' }] }),
        event('turn/start', { turn: 2 }),
        event('assistant/message', { turn: 2, message: { role: 'assistant', content: [{ type: 'reasoning', text: '想一想' }, { type: 'text', text: '收到，已完成' }] } }),
        event('turn/end', { turn: 2, reason: 'completed' })
    ];
    assert.deepEqual(locateResult(events, 'r-9'), { state: 'completed', turn: 2, text: '收到，已完成', reason: 'completed' });
    assert.equal(locateResult(events, 'r-none').state, 'missing');

    const pending = events.slice(0, 7);
    assert.equal(locateResult(pending, 'r-9').state, 'pending');

    const failed = events.map(item => (item.type === 'turn/end' ? event('turn/end', { turn: 2, reason: 'error' }) : item));
    assert.equal(locateResult(failed, 'r-9').state, 'failed');
});

test('可见文本：排除 reasoning，保留全部 text 块', () => {
    assert.equal(visibleText({ content: [{ type: 'reasoning', text: 'x' }, { type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'a\nb');
    assert.equal(visibleText({ content: 'nope' }), '');
});

test('增量归集：先认领自己那条消息，再见 turn/end 才结算', () => {
    const tracker = new ResultTracker();
    tracker.track('r-9', 's1');
    assert.equal(tracker.observe('s1', event('turn/start', { turn: 4 })).length, 0);
    assert.equal(tracker.observe('s2', event('turn/end', { turn: 4, reason: 'completed' })).length, 0);
    assert.equal(tracker.observe('s1', event('user/message', { turn: 4, source: { kind: 'user', rpcId: 'r-9' } })).length, 0);
    assert.equal(tracker.observe('s1', event('assistant/message', { turn: 4, message: { content: [{ type: 'text', text: '结果 A' }] } })).length, 0);
    assert.equal(tracker.outstanding().length, 1);
    const settled = tracker.observe('s1', event('turn/end', { turn: 4, reason: 'completed' }));
    assert.equal(settled.length, 1);
    assert.equal(settled[0].text, '结果 A');
    assert.equal(settled[0].state, 'completed');
    assert.equal(tracker.outstanding().length, 0);
});

test('并发安全：子会话当时正在跑别的回合，不会把别人的输出算成本次投递', () => {
    const tracker = new ResultTracker();
    tracker.track('r-7', 's1');
    // 会话本来就有一轮在跑（人类先说话了）
    tracker.observe('s1', event('turn/start', { turn: 10 }));
    tracker.observe('s1', event('assistant/message', { turn: 10, message: { content: [{ type: 'text', text: '别人的回答' }] } }));
    tracker.observe('s1', event('turn/end', { turn: 10, reason: 'completed' }));
    assert.equal(tracker.outstanding().length, 1, '别人的回合结束后，我们的投递仍未结算');
    // 我们的消息被排队，稍后自己开了一轮
    tracker.observe('s1', event('user/message', { turn: 11, source: { kind: 'user', rpcId: 'r-7' } }));
    tracker.observe('s1', event('turn/start', { turn: 11 }));
    tracker.observe('s1', event('assistant/message', { turn: 11, message: { content: [{ type: 'text', text: '我们的结果' }] } }));
    const settled = tracker.observe('s1', event('turn/end', { turn: 11, reason: 'completed' }));
    assert.equal(settled.length, 1);
    assert.equal(settled[0].text, '我们的结果');
    assert.equal(settled[0].turn, 11);
});

test('真实事件顺序：turn/start 早于 user/message，reason 是 { kind } 对象', async () => {
    // 取自真机日志：inbox 入队 → turn/start → user/message(带 rpcId，无 turn 字段) → assistant → turn/end
    const trace = [
        { type: 'turn/start', data: { turn: 3 } },
        { type: 'user/message', data: { source: { kind: 'user', rpcId: 'r-real' }, content: [{ type: 'text', text: '工单' }] } },
        { type: 'assistant/message', data: { turn: 3, message: { content: [{ type: 'text', text: 'CH-OK' }] } } },
        { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } }
    ];
    assert.deepEqual(locateResult(trace, 'r-real'), { state: 'completed', turn: 3, text: 'CH-OK', reason: 'completed' });

    const tracker = new ResultTracker();
    tracker.track('r-real', 's1');
    let settled = [];
    for (const item of trace) settled = settled.concat(tracker.observe('s1', item));
    assert.equal(settled.length, 1);
    assert.equal(settled[0].text, 'CH-OK');
    assert.equal(settled[0].state, 'completed');
    assert.equal(settled[0].turn, 3);
});

test('end-to-end：模拟宿主 prompt + 事件流，accepted 不等于完成', async () => {
    const events = [];
    const prompt = async (request) => {
        // 宿主行为：用户消息带 source.rpcId 入队，随后开始自己的回合
        events.push({ type: 'user/message', data: { turn: 3, source: { kind: 'user', rpcId: request.requestId }, content: request.content } });
        events.push({ type: 'turn/start', data: { turn: 3 } });
        return { accepted: true };
    };
    const channel = new DeliveryChannel({ prompt });
    const tracker = new ResultTracker();
    const delivered = await channel.deliver({ sessionId: 's1' }, '工单正文', { requestId: 'r-e2e' });
    assert.equal(delivered.accepted, true);
    tracker.track(delivered.requestId, 's1');
    let settled = [];
    for (const item of events) settled = settled.concat(tracker.observe('s1', item));
    assert.equal(settled.length, 0, '只被接受、还没跑完时不得结算');
    events.push({ type: 'assistant/message', data: { turn: 3, message: { content: [{ type: 'text', text: '完成' }] } } });
    events.push({ type: 'turn/end', data: { turn: 3, reason: 'completed' } });
    for (const item of events.slice(-2)) settled = settled.concat(tracker.observe('s1', item));
    assert.equal(settled.length, 1);
    assert.equal(settled[0].text, '完成');
});
