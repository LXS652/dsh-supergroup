/**
 * 投递与结果归集：把一条消息送进任意既有会话，并按 rpcId 精确找回它引发的那一轮。
 * 依据宿主 sessionController.prompt(request, signal) 的真实行为：
 *   resolveAgent(sessionId) → createUserMessage({content, source}) → steer/followup → {accepted:true}
 * 其中 source.rpcId 就是我们传入的 requestId，因此归集不靠“猜测下一个回复”。
 */

/** 派工正文末尾的固定提示；不是自由文本通道，只提醒成员有这个上报入口。 */
export const REPORT_HINT = '（完成后调用 ms2_report 上报；status 与 summary 必填）';

/** 一条投递请求；mode='steer' 打断当前轮，缺省则排队等待。 */
export function buildPromptRequest({ sessionId, requestId, text, mode }) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('DELIVERY_INVALID_SESSION');
    if (typeof requestId !== 'string' || requestId.length === 0) throw new Error('DELIVERY_INVALID_REQUEST_ID');
    if (typeof text !== 'string' || text.trim().length === 0) throw new Error('DELIVERY_EMPTY_TEXT');
    const body = text.includes('ms2_report') ? text : `${text}\n\n${REPORT_HINT}`;
    const request = { sessionId, requestId, content: [{ type: 'text', text: body }] };
    if (mode === 'steer') request.mode = 'steer';
    else if (mode !== undefined && mode !== 'queue') throw new Error('DELIVERY_INVALID_MODE');
    return request;
}

/** 把宿主抛出的错误压成可判定结构；区分“没这个会话”“忙”“参数错”。 */
export function describeDeliveryError(error) {
    const code = error && (error.code || (error.data && error.data.code));
    const message = error instanceof Error ? error.message : String(error);
    const known = new Set([
        'session/not-found',
        'session/agent-busy',
        'session/attachment-invalid',
        'gateway/bad-request',
        'gateway/internal'
    ]);
    return {
        ok: false,
        code: known.has(code) ? code : 'delivery/unknown',
        message: message.slice(0, 400)
    };
}

/**
 * 投递通道：只依赖注入进来的 prompt 函数，便于脱离宿主做单测。
 * accepted 只表示宿主收下了消息，不表示子会话已完成——这一点必须由结果归集判定。
 */
export class DeliveryChannel {
    #prompt;
    #idFactory;
    #issued = new Set();
    // 已生成、正在 prompt 往返中的 id。必须在调用 prompt 之前登记：
    // 宿主可能先推 user/message / agent/inbox/spliced，后返回 receipt；这段窗口里
    // 同会话的其它整体若只看 #issued，就会把兄弟派工误判成人类插话。
    #inflight = new Set();

    constructor({ prompt, idFactory } = {}) {
        if (typeof prompt !== 'function') throw new Error('DELIVERY_PROMPT_REQUIRED');
        this.#prompt = prompt;
        this.#idFactory = typeof idFactory === 'function' ? idFactory : defaultIdFactory;
    }

    /** 生成一个新 requestId；投递方需要在调用 prompt 之前先登记归集时用。 */
    newRequestId() {
        return this.#idFactory();
    }

    /** 投递一条消息；同一 requestId 只发一次，重复调用返回 duplicate。 */
    async deliver(member, text, { mode, requestId, signal } = {}) {
        if (!member || typeof member.sessionId !== 'string') throw new Error('DELIVERY_INVALID_MEMBER');
        const id = requestId === undefined ? this.newRequestId() : requestId;
        if (this.#issued.has(id)) return { ok: true, duplicate: true, requestId: id };
        const request = buildPromptRequest({ sessionId: member.sessionId, requestId: id, text, mode });
        // 宿主 prompt(request, signal) 第一行就是 signal.throwIfAborted()，
        // 传 undefined 会直接 TypeError；这里必须给一个真实的 AbortSignal。
        const effectiveSignal = signal === undefined ? new AbortController().signal : signal;
        try {
            const receipt = await this.#prompt(request, effectiveSignal);
            this.#issued.add(id);
            return { ok: true, duplicate: false, requestId: id, accepted: receipt && receipt.accepted === true };
        } catch (error) {
            // 失败不登记，允许用同一个 id 重试（宿主侧按 requestId 去重）。
            return { ...describeDeliveryError(error), duplicate: false, requestId: id };
        }
    }

    /** 供恢复流程使用：把已确认投递过的 id 重新登记，避免重启后重发。 */
    remember(requestId) {
        if (typeof requestId !== 'string' || requestId.length === 0) throw new Error('DELIVERY_INVALID_REQUEST_ID');
        this.#issued.add(requestId);
    }

    /** 标记一个 id 已开始投递（prompt 尚未返回），用于同会话并发工单的插话判定。 */
    markDispatching(requestId) {
        if (typeof requestId !== 'string' || requestId.length === 0) throw new Error('DELIVERY_INVALID_REQUEST_ID');
        this.#inflight.add(requestId);
    }

    /** 投递成功或失败后都要撤销在途标记；成功后 id 已在 #issued 里。 */
    unmarkDispatching(requestId) {
        this.#inflight.delete(requestId);
    }

    known(requestId) {
        return this.#issued.has(requestId) || this.#inflight.has(requestId);
    }
}

function defaultIdFactory() {
    return `ms-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** turn/end 的 reason 可能是字符串，也可能是 { kind } 对象；统一成字符串。 */
export function normalizeReason(reason) {
    if (typeof reason === 'string') return reason;
    if (reason && typeof reason === 'object' && typeof reason.kind === 'string') return reason.kind;
    return 'unknown';
}

/** 从 assistant/message 的内容块里取可见文本（排除 reasoning）。 */
export function visibleText(message) {
    const content = message && message.content;
    if (!Array.isArray(content)) return '';
    return content
        .filter(block => block && block.type === 'text' && typeof block.text === 'string')
        .map(block => block.text)
        .join('\n')
        .trim();
}

/**
 * 在事件序列中定位某次投递引发的那一轮：
 * 先找 source.rpcId 匹配的用户消息，再取它之后（或所在）的回合，再取该回合最后一条助手消息。
 * 找不到就返回 missing，绝不把“没有文字”当成完成。
 */
export function locateResult(events, requestId) {
    if (!Array.isArray(events)) throw new Error('RESULT_INVALID_EVENTS');
    let anchor = -1;
    for (let index = 0; index < events.length; index += 1) {
        const event = events[index];
        if (event && event.type === 'user/message' && event.data && event.data.source && event.data.source.rpcId === requestId) {
            anchor = index;
            break;
        }
    }
    if (anchor === -1) return { state: 'missing', turn: null, text: '' };

    let turn = null;
    // 真实顺序：turn/start 可能早于 user/message（消息先入 inbox 再开轮）。
    for (let index = anchor; index < events.length; index += 1) {
        const event = events[index];
        if (!event || !event.data) continue;
        if (Number.isSafeInteger(event.data.turn)) {
            turn = event.data.turn;
            break;
        }
    }
    if (turn === null) return { state: 'pending', turn: null, text: '' };

    let text = '';
    let ended = null;
    for (let index = anchor; index < events.length; index += 1) {
        const event = events[index];
        if (!event || !event.data || event.data.turn !== turn) continue;
        if (event.type === 'assistant/message') text = visibleText(event.data.message) || text;
        if (event.type === 'turn/end') {
            ended = normalizeReason(event.data.reason);
            break;
        }
    }
    if (ended === null) return { state: 'pending', turn, text };
    return { state: ended === 'completed' || ended === 'blocked' ? 'completed' : 'failed', turn, text, reason: ended };
}

/** 增量归集器：宿主每推一个 session/event 就喂一次，避免反复扫全量历史。 */
export class ResultTracker {
    #pending = new Map();

    /** 登记一个已投递、尚未结算的 requestId。 */
    track(requestId, sessionId) {
        if (typeof requestId !== 'string' || requestId.length === 0) throw new Error('RESULT_INVALID_REQUEST_ID');
        if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('RESULT_INVALID_SESSION');
        // anchored=false：还没在事件里看到我们自己那条消息，此时任何 turn/start 都不能认领。
        this.#pending.set(requestId, { sessionId, turn: null, anchored: false, text: '', settled: false });
    }

    /** 放弃跟踪某个 requestId（例如人类插话导致本轮结果不再属于工单）。 */
    forget(requestId) {
        return this.#pending.delete(requestId);
    }

    /**
     * 消费一个事件；返回本次被结算的结果列表（可能为空）。
     *
     * `owns(requestId)` 是可选的归属判定：多个 Coordinator 共享同一个 tracker 时，
     * 非属主必须“跳过”而不是消费。否则先遍历到的整体会删掉 pending 条目，
     * 真正的属主再也拿不到结算（见 docs/RPCID-ANCHOR-BUG.md）。
     * 不传 `owns` 时保持旧行为。
     */
    observe(sessionId, event, { owns } = {}) {
        const settled = [];
        if (!event || typeof event !== 'object' || !event.data) return settled;
        const owner = typeof owns === 'function' ? owns : null;
        const turn = Number.isSafeInteger(event.data.turn) ? event.data.turn : null;
        for (const [requestId, entry] of this.#pending) {
            if (entry.settled || entry.sessionId !== sessionId) continue;
            // 非属主整体只读经过，不能锚定、不能删除、不能把结果塞进自己的兜底队列。
            if (owner !== null && !owner(requestId)) continue;
            // 先认领“由本次投递产生的那条用户消息”，再绑定它的回合；
            // 这样即使子会话当时正在跑别的回合，也不会把别人的输出当成我们的结果。
            if (event.type === 'user/message' && event.data.source && event.data.source.rpcId === requestId) {
                entry.anchored = true;
                if (turn !== null) entry.turn = turn;
                continue;
            }
            if (!entry.anchored) continue;
            // 真实事件顺序是 turn/start 先于 user/message（消息先入 inbox，再开轮），
            // 所以绑定回合必须允许“锚定之后见到的第一个 turn 号”生效。
            if (entry.turn === null && turn !== null) entry.turn = turn;
            if (turn !== null && entry.turn !== null && turn !== entry.turn) continue;
            if (event.type === 'assistant/message' && event.data.message) {
                const text = visibleText(event.data.message);
                if (text.length > 0) entry.text = text;
            }
            if (event.type === 'turn/end' && turn !== null && turn === entry.turn) {
                entry.settled = true;
                const reason = normalizeReason(event.data.reason);
                settled.push({
                    requestId,
                    sessionId,
                    turn: entry.turn,
                    text: entry.text,
                    state: reason === 'completed' || reason === 'blocked' ? 'completed' : 'failed',
                    reason
                });
                this.#pending.delete(requestId);
            }
        }
        return settled;
    }

    /** 尚未结算的 requestId；用于重启后判定 uncertain。 */
    outstanding() {
        return [...this.#pending.entries()].map(([requestId, entry]) => ({ requestId, ...entry }));
    }
}
