/**
 * 受管任务的状态视图；创建者：DeepSeek Harness，2026-11-02。
 * 只做纯函数推导：输入账本快照与投递信息，输出界面状态。
 * 关键约束：绝不把"当前没有文字流"当作完成；完成必须有匹配当前 attempt 的回执。
 */

/** 界面状态枚举；顺序即严重度，用于会话汇总。 */
export const UI_STATES = Object.freeze({
    queued: 'queued',
    queuedPaused: 'queued_paused',
    deliveryPending: 'delivery_pending',
    running: 'running',
    needsHuman: 'needs_human',
    completed: 'completed',
    failed: 'failed',
    canceled: 'canceled',
});

/** 状态到中文标签；界面文案与判定分离，避免文案反过来决定状态。 */
export const UI_LABELS = Object.freeze({
    queued: '排队中',
    queued_paused: '排队中（队列已暂停）',
    delivery_pending: '消息待投递',
    running: '执行中',
    needs_human: '等待人工决定',
    completed: '任务完成',
    failed: '执行失败',
    canceled: '已取消',
});

/** 需要人工处理的状态；面板"等待人工"列表只收这些。 */
const HUMAN_STATES = new Set([UI_STATES.needsHuman, UI_STATES.deliveryPending]);

/** 视为"仍在占用成员"的状态；决定会话能否显示空闲。 */
const ACTIVE_STATES = new Set([UI_STATES.running, UI_STATES.deliveryPending]);

/** 只读自有字段，避免访问器或代理在渲染路径上执行副作用。 */
function field(value, key) {
    if (value === null || typeof value !== 'object') return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}

/** 校验任务对象外形；畸形输入降级为失败卡片而不是抛错阻断整棵界面。 */
function isTask(value) {
    const id = field(value, 'id');
    const state = field(value, 'state');
    return typeof id === 'string' && id.length > 0 && typeof state === 'string';
}

/**
 * 推导单个任务的界面状态。
 * @param {object} task 账本任务
 * @param {{paused?: boolean, now?: number}} context 队列暂停与当前时间
 * @returns {{id: string, state: string, label: string, reason: string|null, attempt: number, needsHuman: boolean}}
 */
export function deriveTaskView(task, context = {}) {
    const id = field(task, 'id') ?? '';
    const state = field(task, 'state') ?? 'failed';
    const attempt = field(task, 'attempt') ?? 0;
    const receipt = field(task, 'receipt');
    const effectPending = field(task, 'effectPending') === true;
    const reason = field(task, 'reason');
    const paused = context.paused === true;
    const deadline = field(task, 'deadline');
    const now = typeof context.now === 'number' ? context.now : Date.now();
    const timedOut = typeof deadline === 'number' && deadline > 0 && now >= deadline;

    let uiState;
    let detail = reason ?? null;
    if (state === 'completed') {
        // 完成必须由回执支撑；缺回执的 completed 只能是"执行失败/需人工"，防止把无文字流当完成。
        const receiptToken = field(receipt, 'token');
        const receiptAttempt = field(receipt, 'attempt');
        if (typeof receiptToken === 'string' && receiptToken.length > 0 && receiptAttempt === attempt) {
            uiState = UI_STATES.completed;
        } else {
            uiState = UI_STATES.needsHuman;
            detail = 'completed_without_matching_receipt';
        }
    } else if (state === 'failed') {
        uiState = UI_STATES.failed;
    } else if (state === 'canceled') {
        uiState = UI_STATES.canceled;
    } else if (state === 'uncertain') {
        // 超时、重启、停止未收敛都落在这里，一律交人工，不自动当作失败或完成。
        uiState = UI_STATES.needsHuman;
        detail = reason ?? (timedOut ? 'timeout' : 'uncertain');
    } else if (state === 'running') {
        const receiptMessageId = field(receipt, 'messageId');
        // 已预留但还没拿到投递回执 = 消息待投递；拿到回执才是真的在执行。
        uiState = effectPending && (typeof receiptMessageId !== 'string' || receiptMessageId.length === 0)
            ? UI_STATES.deliveryPending
            : UI_STATES.running;
        if (timedOut) detail = 'deadline_passed';
    } else if (state === 'queued') {
        uiState = paused ? UI_STATES.queuedPaused : UI_STATES.queued;
    } else {
        uiState = UI_STATES.failed;
        detail = reason ?? 'unknown_state';
    }

    return {
        id,
        state: uiState,
        label: UI_LABELS[uiState],
        reason: detail,
        attempt,
        needsHuman: HUMAN_STATES.has(uiState),
    };
}

/** 推导成员/主会话的汇总状态；空闲只在完全没有活跃任务时成立。 */
export function deriveSessionView(tasks, context = {}) {
    const list = Array.isArray(tasks) ? tasks.filter(isTask) : [];
    const views = list.map(task => deriveTaskView(task, context));
    const active = views.filter(view => ACTIVE_STATES.has(view.state)).length;
    const waiting = views.filter(view => view.state === UI_STATES.needsHuman).length;
    const completed = views.filter(view => view.state === UI_STATES.completed).length;
    const failed = views.filter(view => view.state === UI_STATES.failed).length;
    const queued = views.filter(view => view.state === UI_STATES.queued || view.state === UI_STATES.queuedPaused).length;

    let state;
    if (active > 0) state = UI_STATES.running;
    else if (waiting > 0) state = UI_STATES.needsHuman;
    else if (queued > 0) state = context.paused === true ? UI_STATES.queuedPaused : UI_STATES.queued;
    else if (failed > 0) state = UI_STATES.failed;
    else if (completed > 0) state = UI_STATES.completed;
    else state = 'idle';

    return {
        state,
        label: state === 'idle' ? '会话空闲' : UI_LABELS[state],
        counts: { active, waiting, completed, failed, queued, total: views.length },
        tasks: views,
    };
}

/** 按成员拆分任务板；成员顺序沿用配置顺序，未知成员单列。 */
export function groupByMember(tasks, memberIds = []) {
    const list = Array.isArray(tasks) ? tasks.filter(isTask) : [];
    const known = Array.isArray(memberIds) ? memberIds.filter(id => typeof id === 'string') : [];
    const buckets = new Map(known.map(id => [id, []]));
    for (const task of list) {
        const memberId = field(task, 'memberId');
        const key = typeof memberId === 'string' && memberId.length > 0 ? memberId : 'unassigned';
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(task);
    }
    return [...buckets.entries()].map(([memberId, items]) => ({ memberId, tasks: items }));
}

/** 由账本快照推导面板所需的完整视图；不可变输出，便于客户端直接渲染。 */
export function buildPanelView(snapshot, options = {}) {
    const tasks = field(snapshot, 'tasks');
    const paused = field(snapshot, 'paused') === true;
    const now = typeof options.now === 'number' ? options.now : Date.now();
    const context = { paused, now };
    const session = deriveSessionView(tasks, context);
    const members = groupByMember(tasks, field(snapshot, 'memberIds') ?? [])
        .map(group => ({ memberId: group.memberId, ...deriveSessionView(group.tasks, context) }));
    const budget = field(options, 'budget');
    return {
        generatedAt: now,
        paused,
        sequence: field(snapshot, 'sequence') ?? 0,
        calls: field(snapshot, 'calls') ?? 0,
        maxCalls: field(snapshot, 'maxCalls') ?? 0,
        lead: session,
        members,
        waiting: session.tasks.filter(view => view.needsHuman),
        usage: budget
            ? {
                tools: field(budget, 'tools') ?? 0,
                streams: field(budget, 'streams') ?? 0,
                maxTools: field(budget, 'maxTools') ?? 0,
                maxStreams: field(budget, 'maxStreams') ?? 0,
                amount: null,
                amountNote: '金额不可用：会话事件只有 token 计数，没有费用字段',
            }
            : null,
    };
}
