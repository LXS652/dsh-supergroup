/**
 * 进程内原生回合准入；创建者：DeepSeek Harness，2026-11-02。
 * 只绑定本次期待、精确原生身份和结束事件，不持久化、不扫描历史、不清理收件箱。
 */

/** 创建不泄露任务凭证的稳定异常。 */
function failure(code) {
    return Object.assign(new Error(code), { code });
}

/** 只读取自有数据字段，拒绝通过访问器伪装的消息或信封。 */
function field(value, key) {
    if (value === null || typeof value !== 'object') return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}

/** 验证非空原生标识；不修剪后比较，保留精确传输值。 */
function nonempty(value) {
    return typeof value === 'string' && value.trim().length > 0;
}

/** 验证正安全整数，拒绝字符串、浮点数及溢出回合号。 */
function positive(value) {
    return Number.isSafeInteger(value) && value > 0;
}

/** 检查任务三元组结构；外部调用者不能修改保存的标量快照。 */
function tuple(value) {
    const id = field(value, 'id');
    const attempt = field(value, 'attempt');
    const token = field(value, 'token');
    return nonempty(id) && positive(attempt) && nonempty(token) ? { id, attempt, token } : undefined;
}

/** 期待与绑定均为实例私有；重新构造实例不会继承任何准入。 */
export class TurnAdmission {
    #leadId;
    #members;
    #getAgent;
    #isLiveTask;
    #expected = new Map();
    #bindings = new Map();

    /** 输入 Lead、唯一成员及同步注册表/任务校验函数；无外部副作用。 */
    constructor({ leadId, memberIds, getAgent, isLiveTask } = {}) {
        if (!nonempty(leadId) || !Array.isArray(memberIds) || memberIds.length === 0
            || memberIds.some(id => !nonempty(id) || id === leadId)
            || new Set(memberIds).size !== memberIds.length
            || typeof getAgent !== 'function' || typeof isLiveTask !== 'function') {
            throw failure('TURN_INVALID_ARGUMENT');
        }
        this.#leadId = leadId;
        this.#members = new Set(memberIds);
        this.#getAgent = getAgent;
        this.#isLiveTask = isLiveTask;
    }

    /** 发送前保存单个新信封；已有期待或未结束绑定时拒绝覆盖。 */
    expect(memberId, envelope) {
        if (!this.#members.has(memberId)) throw failure('TURN_UNKNOWN_MEMBER');
        const binding = this.#bindings.get(memberId);
        if ((binding && !binding.ended) || this.#expected.has(memberId)) throw failure('TURN_PENDING');
        const task = tuple(envelope);
        const text = field(envelope, 'text');
        const prefix = field(envelope, 'prefix');
        if (!task || !nonempty(text) || !nonempty(prefix)) throw failure('TURN_INVALID_ARGUMENT');
        this.#bindings.delete(memberId);
        this.#expected.set(memberId, { ...task, text, prefix, revoked: false, receiptId: undefined });
    }

    /** 验证当前注册表中的精确 Agent 与会话，不接受同标识替身。 */
    #current(agent, binding) {
        return agent !== null && typeof agent === 'object' && this.#members.has(agent.id)
            && this.#getAgent(agent.id) === agent && agent.session !== null
            && typeof agent.session === 'object'
            && (!binding || (binding.agent === agent && binding.session === agent.session));
    }

    /** 同步检查本次任务三元组，异常由准入查询封闭为拒绝。 */
    #live(memberId, task) {
        return this.#isLiveTask(task.id, task.attempt, task.token, memberId) === true;
    }

    /** 检查唯一原生用户消息及两个文本块，返回精确原生消息标识。 */
    #message(messages, expected) {
        if (!Array.isArray(messages) || messages.length !== 1) return undefined;
        const message = field(messages, '0');
        const id = field(message, 'id');
        const source = field(message, 'source');
        const content = field(message, 'content');
        if (!nonempty(id) || field(message, 'role') !== 'user'
            || field(source, 'kind') !== 'agent-message' || field(source, 'form') !== 'relay'
            || field(source, 'senderSessionId') !== this.#leadId
            || !Array.isArray(content) || content.length !== 2) return undefined;
        const first = field(content, '0');
        const second = field(content, '1');
        if (field(first, 'type') !== 'text' || field(first, 'text') !== expected.prefix
            || field(second, 'type') !== 'text' || field(second, 'text') !== expected.text) return undefined;
        return id;
    }

    /** 首步消耗期待并绑定原生回合；续步只接受同身份和空的新领取消息。 */
    admit(payload) {
        try {
            const agent = field(payload, 'agent');
            const messages = field(payload, 'messages');
            const turn = field(payload, 'turn');
            const step = field(payload, 'step');
            const signal = field(payload, 'signal');
            if (!this.#current(agent) || !positive(turn) || !positive(step)
                || !signal || typeof signal !== 'object' || signal.aborted !== false) return false;
            const memberId = agent.id;
            const binding = this.#bindings.get(memberId);
            if (binding) {
                return !binding.ended && !binding.revoked && this.#current(agent, binding)
                    && turn === binding.turn && signal === binding.signal && step > 1
                    && Array.isArray(messages) && messages.length === 0 && this.#live(memberId, binding);
            }
            const expected = this.#expected.get(memberId);
            if (step !== 1 || !expected || expected.revoked || !this.#live(memberId, expected)) return false;
            const messageId = this.#message(messages, expected);
            if (!messageId || (expected.receiptId !== undefined && expected.receiptId !== messageId)) return false;
            let resolveEnd;
            const end = new Promise(resolve => { resolveEnd = resolve; });
            this.#bindings.set(memberId, {
                id: expected.id, attempt: expected.attempt, token: expected.token,
                agent, session: agent.session, turn, signal, messageId,
                receiptId: expected.receiptId, end, resolveEnd, ended: false, revoked: false,
            });
            this.#expected.delete(memberId);
            return true;
        } catch {
            // 畸形访问器、代理及主机回调故障均不能变成宽松准入。
            return false;
        }
    }

    /** 模型/工具查询要求同一个未中止信号，可选回合号也必须精确一致。 */
    allowed(payload) {
        try {
            const agent = field(payload, 'agent');
            const signal = field(payload, 'signal');
            const binding = this.#bindings.get(agent?.id);
            const turn = field(payload, 'turn');
            return Boolean(binding && !binding.ended && !binding.revoked
                && this.#current(agent, binding) && signal === binding.signal && signal.aborted === false
                && (!Object.hasOwn(payload, 'turn') || turn === binding.turn)
                && this.#live(agent.id, binding));
        } catch {
            return false;
        }
    }

    /** 回执只核对传输标识；报告后任务不再存活也仍允许迟到的精确回执。 */
    correlate(memberId, messageId) {
        const state = this.#bindings.get(memberId) ?? this.#expected.get(memberId);
        if (!state) throw failure('TURN_UNEXPECTED_RECEIPT');
        if (!nonempty(messageId) || (state.messageId !== undefined && state.messageId !== messageId)
            || (state.receiptId !== undefined && state.receiptId !== messageId)) {
            this.revoke(memberId);
            throw failure('TURN_MESSAGE_MISMATCH');
        }
        state.receiptId = messageId;
        return true;
    }

    /** 回报检查活动三元组及精确身份；不比较工具体融合后的信号。 */
    matchesReport(agent, report) {
        try {
            const binding = this.#bindings.get(agent?.id);
            const task = tuple(report);
            return Boolean(binding && task && !binding.ended && !binding.revoked
                && this.#current(agent, binding) && binding.id === task.id
                && binding.attempt === task.attempt && binding.token === task.token
                && this.#live(agent.id, binding));
        } catch {
            return false;
        }
    }

    /** 仅精确会话的精确回合结束事件能打开结束闩锁；撤销不影响此观察。 */
    observe(session, event) {
        try {
            if (field(event, 'type') !== 'turn/end') return false;
            const turn = field(field(event, 'data'), 'turn');
            if (!positive(turn)) return false;
            let observed = false;
            for (const binding of this.#bindings.values()) {
                if (!binding.ended && binding.session === session && binding.turn === turn) {
                    binding.ended = true;
                    binding.resolveEnd();
                    observed = true;
                }
            }
            return observed;
        } catch {
            return false;
        }
    }

    /** 撤销未来准入，不伪造驱动器已结束，也不提前解决结束承诺。 */
    revoke(memberId) {
        const binding = this.#bindings.get(memberId);
        const expected = this.#expected.get(memberId);
        if (binding) binding.revoked = true;
        if (expected) expected.revoked = true;
    }

    /** 返回绑定的稳定结束承诺；无绑定时无需等待原生回合。 */
    settlement(memberId) {
        return this.#bindings.get(memberId)?.end ?? Promise.resolve();
    }

    /** 调用者连接发送及驱动器后清理；未结束绑定即使撤销也禁止丢弃。 */
    clear(memberId) {
        const binding = this.#bindings.get(memberId);
        if (binding && !binding.ended) throw failure('TURN_PENDING');
        this.#expected.delete(memberId);
        this.#bindings.delete(memberId);
    }
}
