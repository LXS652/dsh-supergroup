/**
 * 协调器：把注册表、投递通道、结果归集拼成一个可用整体。
 * 只做“按会话寻址”的协调——不依赖原生 Team，也不要求子会话装本插件。
 * 可选的账本让它能跨重启回答“上次退出时哪些工单还没结算”。
 */
import { createHash } from 'node:crypto';

import { locateResult } from './delivery.mjs';
import { rebuildTasks } from './ledger.mjs';

const REPORT_STATUSES = new Set(['completed', 'blocked', 'failed']);

function reportFailure(code, message, data = {}) {
    const error = new Error(`${code}: ${message}`);
    error.code = code;
    error.data = data;
    return error;
}

function reportKeyOf(caller, requestId, turn, status, summary, detailJson) {
    return createHash('sha256')
        .update([caller, requestId, String(turn), status, summary, detailJson].join('|'), 'utf8')
        .digest('hex');
}

export class Coordinator {
    #registry;
    #channel;
    #tracker;
    #ledger;
    #writes = new Set();
    #tasks = new Map();
    // 归集登记早于投递，宿主可能在 dispatch 返回前就把整轮事件推完；
    // 这时任务行还没建好，先把结算结果暂存，等 dispatch 落账后再补写。
    // 这是兜底，不是主路径：正常路径应由属主整体在 tracker 里消费并立刻 #settleTask。
    #earlySettled = new Map();
    // 本协调器已经发出 prompt、但 dispatch 还没返回的 id。解散整体时用它
    // 挡住“消息可能已发出、任务行还没落”的窗口。
    #dispatching = new Set();
    // 上报按到达顺序串行处理：同一条单的重复/冲突判断不能并发穿透。
    #reportQueue = Promise.resolve();
    // 正在 prompt 往返中的 requestId 由 DeliveryChannel 统一登记（#inflight）。
    // 这里不能只记在本协调器上：同一会话可能同时属于 A、B 两个整体，
    // B 的协调器必须也能认出 A 正在投递的 id。

    constructor({ registry, channel, tracker, ledger, groupId = null } = {}) {
        if (!registry || typeof registry.get !== 'function') throw new Error('COORDINATOR_REGISTRY_REQUIRED');
        if (!channel || typeof channel.deliver !== 'function') throw new Error('COORDINATOR_CHANNEL_REQUIRED');
        if (!tracker || typeof tracker.observe !== 'function') throw new Error('COORDINATOR_TRACKER_REQUIRED');
        this.#registry = registry;
        this.#channel = channel;
        this.#tracker = tracker;
        this.#ledger = ledger === undefined ? null : ledger;
        // 每个整体一个协调器；账本共用一份，用 groupId 区分归属。
        // 单机/旧测试可以不给 groupId，此时按“只有一个整体”的语义处理。
        this.groupId = typeof groupId === 'string' ? groupId : null;
    }

    // 记账失败不影响主流程，但绝不静默吞掉业务结果。
    #writeErrors = [];
    #record(event) {
        if (this.#ledger === null) return;
        const write = this.#ledger.append({ groupId: this.groupId, ...event }).catch(error => {
            // 只保留最近 20 条，避免长期写失败把内存撑大。
            this.#writeErrors.push({
                at: new Date().toISOString(),
                kind: event.kind,
                requestId: event.requestId === undefined ? null : event.requestId,
                code: error && typeof error.code === 'string' ? error.code : null,
                message: error instanceof Error ? error.message : String(error)
            });
            if (this.#writeErrors.length > 20) {
                this.#writeErrors.splice(0, this.#writeErrors.length - 20);
            }
        });
        this.#writes.add(write);
        void write.finally(() => this.#writes.delete(write));
    }

    /** 把一次已确认的结算写进任务行并记 settled（调用方保证任务已存在）。 */
    #settleTask(task, item) {
        task.state = item.state;
        task.turn = item.turn;
        task.result = item.text;
        task.provisional = false;
        task.verified = true;
        if (item.reason !== undefined) task.reason = item.reason;
        if (item.source !== undefined) task.source = item.source;
        if (item.priorReason !== undefined) task.priorReason = item.priorReason;
        if (item.settlementReason !== undefined) task.settlementReason = item.settlementReason;
        if (item.supersededBy !== undefined) task.supersededBy = item.supersededBy;
        this.#record({
            kind: 'settled',
            requestId: item.requestId,
            state: item.state,
            turn: item.turn,
            result: item.text,
            reason: item.reason,
            ...item.source === undefined ? {} : { source: item.source },
            ...item.priorReason === undefined ? {} : { priorReason: item.priorReason },
            ...item.settlementReason === undefined ? {} : { settlementReason: item.settlementReason },
            ...item.supersededBy === undefined ? {} : { supersededBy: item.supersededBy }
        });
    }

    /**
     * 重启恢复：从账本重建工单表，并把“退出时还没结算”的工单一律标成 uncertain。
     * 不自动重发；幂等任务也只是给出 retry 建议，由主会话决定。
     */
    /** 等待账本写完；测试与关停时用，避免“以为记了其实没落盘”。 */
    async flush() {
        await Promise.allSettled([...this.#writes]);
    }

    async recover({ adoptNullGroup = false } = {}) {
        if (this.#ledger === null) return [];
        const events = await this.#ledger.load();
        const rebuilt = rebuildTasks(events);
        this.#tasks = new Map();
        for (const [requestId, task] of rebuilt) {
            // 旧账本没有 groupId：只有迁移来的那个整体负责认领，其它整体不去抢。
            if (task.groupId !== null && task.groupId !== this.groupId) continue;
            if (task.groupId === null && !adoptNullGroup && this.groupId !== null) continue;
            const adopted = task.groupId === null;
            task.groupId = this.groupId;
            this.#tasks.set(requestId, task);
            if (adopted) this.#record({ kind: 'adopt', requestId });
        }
        const plan = [];
        for (const task of this.#tasks.values()) {
            if (task.state !== 'delivered') continue;
            task.state = 'uncertain';
            task.reason = 'restart';
            // 必须落账：否则重启后状态丢失，人工也无法裁决。
            this.#record({ kind: 'uncertain', requestId: task.requestId, reason: 'restart' });
            // 登记到共享通道，跨整体看到这条 rpcId 时不会误判成人类插话。
            if (typeof this.#channel.remember === 'function') this.#channel.remember(task.requestId);
            plan.push({
                requestId: task.requestId,
                sessionId: task.sessionId,
                label: task.label,
                state: 'uncertain',
                decision: task.idempotent === true ? 'retry' : 'needs_human'
            });
        }
        await this.flush();
        return plan;
    }


    /** 投递一张工单给某个成员；只登记，不等于完成。 */
    async dispatch(memberId, text, { mode, requestId, idempotent } = {}) {
        if (typeof memberId !== 'string' || memberId.length === 0) throw new Error('COORDINATOR_INVALID_MEMBER');
        if (this.#registry.isLead(memberId)) throw new Error('COORDINATOR_LEAD_NOT_DISPATCHABLE');
        const member = this.#registry.get(memberId);
        if (!member) throw new Error('COORDINATOR_UNKNOWN_MEMBER');
        // 归集必须先于投递登记：宿主收到 prompt 后可能立刻把 user/message 和
        // turn/start 分发出来（followup 内同步排队/开轮），若等到 deliver 返回再
        // track，锚点已经错过，turn/end 永远不会结算，工单就停在 delivered。
        const id = requestId === undefined ? this.#channel.newRequestId() : requestId;
        const alreadyKnown = this.#tasks.has(id);
        const markDispatching = typeof this.#channel.markDispatching === 'function'
            ? () => this.#channel.markDispatching(id)
            : () => {};
        const unmarkDispatching = typeof this.#channel.unmarkDispatching === 'function'
            ? () => this.#channel.unmarkDispatching(id)
            : () => {};
        if (!alreadyKnown) {
            this.#tracker.track(id, member.sessionId);
            markDispatching();
            this.#dispatching.add(id);
        }
        let delivery;
        try {
            delivery = await this.#channel.deliver(member, text, { mode, requestId: id });
        } catch (error) {
            if (!alreadyKnown) {
                this.#tracker.forget(id);
                unmarkDispatching();
                this.#dispatching.delete(id);
            }
            throw error;
        }
        if (!alreadyKnown) {
            unmarkDispatching();
            this.#dispatching.delete(id);
        }
        if (!delivery.ok) {
            if (!alreadyKnown) this.#tracker.forget(id);
            const task = {
                requestId: id,
                groupId: this.groupId,
                sessionId: member.sessionId,
                label: member.label,
                roleClass: member.roleClass,
                state: 'failed',
                error: delivery.code,
                errorMessage: delivery.message === undefined ? null : delivery.message,
                text: '',
                turn: null
            };
            this.#tasks.set(id, task);
            return { ...task, duplicate: Boolean(delivery.duplicate) };
        }
        if (delivery.duplicate) {
            const existing = this.#tasks.get(id);
            if (existing) return { ...existing, duplicate: true };
        }
        const task = {
            requestId: id,
            groupId: this.groupId,
            sessionId: member.sessionId,
            label: member.label,
            roleClass: member.roleClass,
            state: 'delivered',
            error: null,
            text,
            turn: null,
            result: '',
            idempotent: idempotent === true
        };
        this.#tasks.set(id, task);
        this.#record({
            kind: 'dispatch',
            requestId: id,
            sessionId: member.sessionId,
            label: member.label,
            roleClass: member.roleClass,
            text,
            idempotent: idempotent === true
        });
        // 投递期间已经结算的事件：任务行与 dispatch 账已落，按原顺序补 settled。
        const early = this.#earlySettled.get(id);
        if (early !== undefined) {
            this.#earlySettled.delete(id);
            for (const item of early) this.#settleTask(task, item);
        }
        return { ...task, duplicate: false };
    }

    /**
     * 成员自报：只处理 caller 自己名下的单。
     * - requestId 只是把歧义收敛到“自己的单”，过滤条件里恒有 sessionId === caller；
     * - completed 先标 provisional，等事件/对账复核；blocked/failed 直接进人工态/失败态；
     * - 同一 reportKey 幂等，不同 key 的二次上报冲突，不覆盖已核实结论。
     */
    report(caller, input = {}) {
        const run = this.#reportQueue.then(() => this.#reportNow(caller, input));
        this.#reportQueue = run.catch(() => {});
        return run;
    }

    async #reportNow(caller, input) {
        if (typeof caller !== 'string' || caller.length === 0) {
            throw reportFailure('REPORT_BAD_ARGUMENT', '无法识别调用会话');
        }
        const status = input && input.status;
        if (!REPORT_STATUSES.has(status)) {
            throw reportFailure('REPORT_BAD_ARGUMENT', 'status 只能是 completed / blocked / failed');
        }
        const rawSummary = typeof input.summary === 'string' ? input.summary : '';
        const summary = rawSummary.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
        const summaryLength = [...summary].length;
        if (summaryLength === 0 || summaryLength > 2000) {
            throw reportFailure('REPORT_BAD_ARGUMENT', 'summary 必须是 1–2000 个字符');
        }
        const detail = input.detail === undefined ? null : input.detail;
        let detailJson;
        try {
            detailJson = JSON.stringify(detail);
        } catch {
            throw reportFailure('REPORT_BAD_ARGUMENT', 'detail 必须是可序列化的 JSON 值');
        }
        if (typeof detailJson !== 'string' || Buffer.byteLength(detailJson, 'utf8') > 8 * 1024) {
            throw reportFailure('REPORT_BAD_ARGUMENT', 'detail 序列化后不能超过 8KB');
        }
        let requestId = null;
        if (input.requestId !== undefined) {
            if (typeof input.requestId !== 'string' || input.requestId.length === 0) {
                throw reportFailure('REPORT_BAD_ARGUMENT', 'requestId 必须是非空字符串');
            }
            requestId = input.requestId;
        }

        // 身份过滤恒在：不管模型传什么 requestId，都只能落到自己会话名下的单。
        const own = [...this.#tasks.values()].filter(task => task.sessionId === caller);
        let target;
        if (requestId !== null) {
            target = own.find(task => task.requestId === requestId);
            if (target === undefined) throw reportFailure('REPORT_NO_TASK', '你名下没有这张工单');
        } else {
            const candidates = own.filter(task =>
                task.state === 'delivered'
                || task.state === 'uncertain'
                || (task.state === 'completed' && task.provisional === true));
            if (candidates.length === 0) throw reportFailure('REPORT_NO_TASK', '你名下没有在途工单');
            if (candidates.length > 1) {
                throw reportFailure('REPORT_AMBIGUOUS', `你有 ${candidates.length} 条在途工单，请带 requestId`, {
                    requestIds: candidates.map(task => task.requestId)
                });
            }
            target = candidates[0];
        }

        const turn = Number.isSafeInteger(target.turn) ? target.turn : null;
        const key = reportKeyOf(caller, target.requestId, turn, status, summary, detailJson);
        if (target.verified === true) {
            throw reportFailure('REPORT_CONFLICT', '这张工单已经有已核实的结论，不能再用上报覆盖');
        }
        if (target.reportKey === key) {
            return {
                requestId: target.requestId,
                taskState: target.state,
                source: target.source,
                provisional: target.provisional === true,
                turn,
                duplicate: true
            };
        }
        if (target.state !== 'delivered' && target.state !== 'uncertain') {
            if (target.state === 'needs_human') {
                throw reportFailure('REPORT_TASK_STATE', '这张工单在等待人工裁决，请先让主会话 ms2_resolve');
            }
            throw reportFailure('REPORT_CONFLICT', '这张工单已经处于终态，不能重复上报');
        }

        const source = target.state === 'uncertain' ? 'member-report-after-restart' : 'member-report';
        const event = {
            kind: 'report',
            requestId: target.requestId,
            sessionId: caller,
            status,
            summary,
            detail,
            turn,
            source,
            reportKey: key
        };
        if (this.#ledger !== null) {
            try {
                await this.#ledger.append({ groupId: this.groupId, ...event });
            } catch {
                throw reportFailure('REPORT_LEDGER_FAILED', '上报写入账本失败，内存状态未改，可重试');
            }
        }
        target.state = status === 'completed' ? 'completed' : (status === 'blocked' ? 'needs_human' : 'failed');
        target.provisional = status === 'completed';
        target.verified = false;
        target.source = source;
        target.result = summary;
        target.turn = turn;
        target.reportKey = key;
        target.reportDetail = detail;
        if (status === 'blocked') target.reason = 'member_blocked';
        else if (status === 'failed') target.reason = 'member_failed';
        return {
            requestId: target.requestId,
            taskState: target.state,
            source,
            provisional: target.provisional,
            turn,
            duplicate: false
        };
    }

    /** 消费一条会话事件；返回本次结算到的工单。 */
    observe(sessionId, event) {
        if (!event || typeof event !== 'object' || !event.data) return [];
        // 人类优先：派工之后、结算之前，若这个会话里出现了“不是我们投递的”用户消息，
        // 说明人插进来了。此时不能再把这一轮的结果算作工单结果，改为等待人工并留证。
        // 消息在“进收件箱”（agent/inbox/spliced.inserted[]）和“被认领”（user/message）
        // 两处都会露头；只看 user/message 会等到下一轮，工单那时往往已经结算，插话就漏了。
        const candidates = [];
        if (event.type === 'user/message') candidates.push(event.data.message === undefined ? event.data : event.data.message);
        if (event.type === 'agent/inbox/spliced' && Array.isArray(event.data.inserted)) {
            for (const message of event.data.inserted) candidates.push(message);
        }
        for (const candidate of candidates) {
            const source = candidate && candidate.source;
            if (!source || source.kind !== 'user' || typeof source.rpcId !== 'string') continue;
            // 先排除“我们自己另一个工单”的消息：并发派工时兄弟工单的 rpcId
            // 同样不等于本工单，不能被误判成人类插话。全局通道也认这些 id，
            // 因为同一个会话可能同时是 A、B 两个整体的成员。
            const sibling = (typeof this.#channel.known === 'function' && this.#channel.known(source.rpcId))
                || [...this.#tasks.values()].some(task => task.requestId === source.rpcId);
            if (sibling) continue;
            for (const task of this.#tasks.values()) {
                if (task.sessionId !== sessionId || task.state !== 'delivered') continue;
                task.state = 'needs_human';
                task.reason = 'human_interrupt';
                task.humanInterventions = task.humanInterventions === undefined ? [] : task.humanInterventions;
                task.humanInterventions.push({
                    at: new Date().toISOString(),
                    sessionId,
                    turn: Number.isSafeInteger(event.data.turn) ? event.data.turn : null,
                    rpcId: source.rpcId,
                    evidence: `${event.type} 且 rpcId 不等于本次投递`
                });
                this.#tracker.forget(task.requestId);
                this.#record({
                    kind: 'human',
                    requestId: task.requestId,
                    sessionId,
                    evidence: task.humanInterventions[task.humanInterventions.length - 1]
                });
            }
        }
        const settled = this.#tracker.observe(sessionId, event, {
            // 只有本协调器名下的单才允许消费；#dispatching 覆盖“已发出 prompt、
            // 任务行还没建”的窗口。非属主整体跳过，不删除共享 tracker 的条目。
            owns: requestId => this.#tasks.has(requestId) || this.#dispatching.has(requestId)
        });
        for (const item of settled) {
            const task = this.#tasks.get(item.requestId);
            if (!task) {
                const early = this.#earlySettled.get(item.requestId) ?? [];
                early.push(item);
                this.#earlySettled.set(item.requestId, early);
                continue;
            }
            this.#settleTask(task, item);
        }
        return settled;
    }

    /**
     * 拉取对账：事件监听可能收不到别的会话时，用历史窗口补一次。
     * delivered 和重启后降级的 uncertain 都覆盖；仍只认 rpcId 精确命中，
     * 并且只接受同一回合的 turn/end。对 uncertain 只接受 completed 证据，
     * 不把失败或没结束的回合“猜”成完成。对账只读历史，不投递任何消息。
     */
    async reconcileFromHistory(requestId, events) {
        const task = this.#tasks.get(requestId);
        if (task === undefined) return { state: 'unknown', requestId };
        const uncertain = task.state === 'uncertain';
        const provisional = task.state === 'completed' && task.provisional === true;
        if (task.state !== 'delivered' && !uncertain && !provisional) return { state: 'skipped', requestId, taskState: task.state };
        const located = locateResult(events, requestId);
        if (located.state === 'pending') return { ...located, requestId, taskState: task.state };
        if (located.state === 'missing') return { state: 'missing', requestId, taskState: task.state };
        if (uncertain && located.state !== 'completed') {
            // uncertain 只在历史能证明“该回合确实 completed”时自动收敛；
            // failed 或其它形状留给人裁决。
            return { state: 'unconfirmed', requestId, taskState: task.state, turn: located.turn, reason: located.state };
        }
        // 历史读取是异步的；读回来时事件快路径可能已经结算完了，必须再判一次。
        if (task.state !== 'delivered' && task.state !== 'uncertain'
            && !(task.state === 'completed' && task.provisional === true)) {
            return { state: 'skipped', requestId, taskState: task.state };
        }
        if (uncertain) {
            const priorReason = task.reason;
            this.#settleTask(task, {
                requestId,
                state: 'completed',
                turn: located.turn,
                text: located.text,
                // 保留重启时的 reason:'restart' 作为证据，完成原因单独记。
                reason: priorReason,
                priorReason,
                settlementReason: located.reason,
                source: 'history-reconcile-after-restart'
            });
        } else {
            this.#settleTask(task, {
                requestId,
                state: located.state,
                turn: located.turn,
                text: located.text,
                reason: located.reason,
                source: 'history-reconcile',
                // 上报说 completed、历史证明 failed：对账赢，并保留被推翻的来源。
                ...(provisional && located.state === 'failed' ? { supersededBy: 'history-reconcile' } : {})
            });
        }
        this.#tracker.forget(requestId);
        await this.flush();
        return { state: 'settled', requestId, taskState: task.state, turn: located.turn, result: located.text };
    }

    /**
     * 人工裁决：needs_human 的工单只能由主会话/人明确处理，不自动猜。
     * accept → 采用已记录的结果文本（可能为空）；fail → 判失败；retry 由主会话重新派工完成。
     */
    resolveHuman(requestId, action, { at = () => new Date().toISOString() } = {}) {
        const task = this.#tasks.get(requestId);
        if (!task) throw new Error('COORDINATOR_UNKNOWN_TASK');
        if (task.state !== 'needs_human' && task.state !== 'uncertain') throw new Error('COORDINATOR_NOT_NEEDS_HUMAN');
        if (action === 'accept') {
            task.state = 'completed';
            task.reason = 'human_accepted';
        } else if (action === 'fail') {
            task.state = 'failed';
            task.reason = 'human_failed';
        } else {
            throw new Error('COORDINATOR_INVALID_ACTION');
        }
        task.resolvedAt = at();
        task.resolvedBy = 'human';
        this.#record({ kind: 'resolve', requestId, state: task.state, reason: task.reason, at: task.resolvedAt });
        return { ...task };
    }

    /** 全部工单快照，按投递顺序。 */
    tasks() {
        return [...this.#tasks.values()].map(task => ({ ...task }));
    }

    /** 当前正处于 prompt 往返中的 requestId：还没落成任务，但消息可能已经发出。 */
    pendingDispatchIds() {
        return [...this.#dispatching];
    }

    /** 账本写失败记录：最近 20 条，供 ms2_status 暴露，避免失败永远不可见。 */
    writeErrors() {
        return this.#writeErrors.map(item => ({ ...item }));
    }

    /** 尚未结算的工单。 */
    outstanding() {
        return this.tasks().filter(task => task.state === 'delivered' || task.state === 'uncertain');
    }

    /**
     * 重启后的恢复清单：已投递但未结算的一律列为 uncertain，等人工或主会话裁决；
     * 绝不自动重发（外部效果可能已经发生）。
     */
    recoveryPlan() {
        return this.outstanding().map(task => ({
            requestId: task.requestId,
            sessionId: task.sessionId,
            label: task.label,
            state: 'uncertain',
            decision: task.idempotent === true ? 'retry' : 'needs_human'
        }));
    }
}
