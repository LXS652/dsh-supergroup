/**
 * 工单账本：append-only 的 JSONL，用来跨重启回答一件事——
 * “上次退出时，哪些工单已经派出去、但还没结算”。
 * 只记录我们自己的动作与观察到的事实，不复制会话内容。
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const KINDS = new Set(['dispatch', 'settled', 'report', 'human', 'resolve', 'uncertain', 'adopt']);

/** 极简账本：内存里也留一份，便于没有文件时做测试。 */
export class TaskLedger {
    #file;
    #memory = [];
    #queue = Promise.resolve();

    constructor({ file = null } = {}) {
        this.#file = file;
    }

    get persistent() {
        return this.#file !== null;
    }

    /** 读回全部记录；文件不存在视为空账本。 */
    async load() {
        if (this.#file === null) return [...this.#memory];
        let text;
        try {
            text = await readFile(this.#file, 'utf8');
        } catch (error) {
            if (error && error.code === 'ENOENT') return [];
            throw error;
        }
        const events = [];
        for (const line of text.split('\n')) {
            if (line.trim().length === 0) continue;
            try {
                const record = JSON.parse(line);
                if (record && typeof record.kind === 'string' && KINDS.has(record.kind)) events.push(record);
            } catch {
                // 半截行（上次崩溃）直接跳过，不让它污染恢复。
            }
        }
        return events;
    }

    /** 追加一条记录；写盘失败不阻塞主流程，但会被调用方看到。 */
    async append(event) {
        if (!event || !KINDS.has(event.kind)) throw new Error('LEDGER_INVALID_KIND');
        const record = { at: new Date().toISOString(), ...event };
        this.#memory.push(record);
        // 串行化写盘：appendFile 并发时行序可能与动作顺序不一致，重放就会把
        // “结算”排在“派工”前面而被丢掉，所以这里必须排队。
        const task = this.#queue.then(async () => {
            if (this.#file === null) return record;
            await mkdir(dirname(this.#file), { recursive: true });
            await appendFile(this.#file, `${JSON.stringify(record)}\n`, 'utf8');
            return record;
        });
        this.#queue = task.catch(() => {});
        return task;
    }
}

/**
 * 把账本重放成工单表。
 * 关键点：退出时仍是 delivered 的工单不会凭空变成完成，
 * 也不会被当成“可以安全重发”——恢复阶段统一按 uncertain 处理。
 */
export function rebuildTasks(events) {
    const tasks = new Map();
    for (const event of events) {
        if (event.kind === 'dispatch') {
            tasks.set(event.requestId, {
                requestId: event.requestId,
                // 多整体之后，每个工单必须记住自己属于哪个整体，
                // 否则重启恢复时会把 A 整体的单算到 B 整体头上。
                groupId: event.groupId === undefined ? null : event.groupId,
                sessionId: event.sessionId,
                label: event.label === undefined ? event.sessionId : event.label,
                roleClass: event.roleClass === undefined ? 'assistant' : event.roleClass,
                text: typeof event.text === 'string' ? event.text : '',
                state: 'delivered',
                reason: null,
                turn: null,
                result: '',
                source: null,
                provisional: false,
                verified: false,
                reportKey: null,
                idempotent: event.idempotent === true
            });
            continue;
        }
        const task = tasks.get(event.requestId);
        if (!task) continue;
        if (event.kind === 'adopt') {
            // 旧工单第一次被某个整体认领时写一条，之后重启都能直接归位。
            if (typeof event.groupId === 'string') task.groupId = event.groupId;
            continue;
        }
        if (event.kind === 'uncertain') {
            // 恢复阶段把 delivered 降级成 uncertain，必须落账，否则重启后
            // 状态和恢复清单都会丢，人工也没法裁决。
            task.state = 'uncertain';
            task.reason = event.reason === undefined ? 'restart' : event.reason;
            if (typeof event.groupId === 'string') task.groupId = event.groupId;
            continue;
        }
        if (event.kind === 'report') {
            // 已核实结论不能被旧上报覆盖；正常顺序里 report 先于 settled，
            // 重放时会自然被后面的 settled 盖掉。
            if (task.verified === true) continue;
            const status = event.status === 'blocked' ? 'needs_human' : (event.status === 'failed' ? 'failed' : 'completed');
            task.state = status;
            task.provisional = status === 'completed';
            task.verified = false;
            task.source = typeof event.source === 'string' ? event.source : 'member-report';
            task.result = typeof event.summary === 'string' ? event.summary : '';
            if (Number.isSafeInteger(event.turn)) task.turn = event.turn;
            task.reportKey = typeof event.reportKey === 'string' ? event.reportKey : null;
            task.reportDetail = event.detail === undefined ? null : event.detail;
            if (status === 'needs_human') task.reason = 'member_blocked';
            else if (status === 'failed') task.reason = 'member_failed';
            continue;
        }
        if (event.kind === 'settled') {
            task.state = event.state === undefined ? 'completed' : event.state;
            task.turn = event.turn === undefined ? null : event.turn;
            task.result = typeof event.result === 'string' ? event.result : '';
            task.reason = event.reason === undefined ? null : event.reason;
            task.source = typeof event.source === 'string' ? event.source : null;
            task.provisional = false;
            task.verified = true;
            if (typeof event.priorReason === 'string') task.priorReason = event.priorReason;
            if (typeof event.settlementReason === 'string') task.settlementReason = event.settlementReason;
            if (typeof event.supersededBy === 'string') task.supersededBy = event.supersededBy;
            continue;
        }
        if (event.kind === 'human') {
            task.state = 'needs_human';
            task.reason = 'human_interrupt';
            task.provisional = false;
            task.humanInterventions = task.humanInterventions === undefined ? [] : task.humanInterventions;
            if (event.evidence !== undefined) task.humanInterventions.push(event.evidence);
            continue;
        }
        if (event.kind === 'resolve') {
            task.state = event.state;
            task.reason = event.reason === undefined ? 'human' : event.reason;
            task.provisional = false;
            task.resolvedBy = 'human';
            task.resolvedAt = event.at;
        }
    }
    return tasks;
}
