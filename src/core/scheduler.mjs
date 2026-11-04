/**
 * 持久调度核心；创建者：DeepSeek Harness，2026-11-02。
 * 仅使用 Node 24 内置模块。SQLite FULL 同步事务是追加日志的持久化替代，
 * PERSIST 回滚日志避免主动删除文件；不使用 WAL（关闭时可能删除辅助文件）。
 * 独立锁库的 EXCLUSIVE 事务由操作系统持有：关闭/崩溃自动释放，不猜测 PID，
 * 不破坏“陈旧锁”。恢复流程：先确认旧进程已退出，再重新构造；禁止删除锁库。
 * 运行/超时状态只转 uncertain，不自动重放。取消不是子进程停止或外部效果撤销；
 * 适配器必须停止其拥有的子进程并由 Lead reconcile，不能承诺 exactly-once。
 * directory 必须是可信本地目录；身份认证及路径授权由调用适配器负责。
 */
import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const MAX_TASKS = 1000;
const MAX_JSON_BYTES = 16384;
const MAX_JOURNAL_ROWS = 20000;
const MAX_JOURNAL_BYTES = 64 * 1024 * 1024;
const MAX_EVENT_BYTES = 512 * 1024;
const JOURNAL_RESERVED_ROWS = 2000;
const JOURNAL_RESERVED_BYTES = 16 * 1024 * 1024;
// 入队、派发、重试和恢复调度不能占用善后余量；余量不是任意次数善后的保证。
// 达到硬上限时所有新事件以 JOURNAL_LIMIT 拒绝；不得删除、压缩或自动重放日志。

/** 校验条件；不满足时抛出带稳定错误码的异常。 */
function requireCondition(condition, code) {
    if (!condition) throw Object.assign(new Error(code), { code });
}

/** 校验标识符，返回原字符串；禁止控制字符和超长值。 */
function identifier(value) {
    requireCondition(typeof value === 'string' && /^[A-Za-z0-9_.:@-]{1,128}$/.test(value), 'INVALID_ID');
    return value;
}

/** 校验有限安全整数及闭区间。 */
function integer(value, minimum, maximum) {
    requireCondition(Number.isSafeInteger(value) && value >= minimum && value <= maximum, 'INVALID_NUMBER');
    return value;
}

/** 校验普通参数对象及字段白名单，拒绝未定义字段。 */
function fields(value, names) {
    requireCondition(value !== null && typeof value === 'object' && !Array.isArray(value)
        && Object.getPrototypeOf(value) === Object.prototype, 'INVALID_OBJECT');
    requireCondition(Object.getOwnPropertySymbols(value).length === 0, 'UNKNOWN_FIELD');
    requireCondition(Object.getOwnPropertyNames(value).every(key => names.includes(key)), 'UNKNOWN_FIELD');
    requireCondition(Object.getOwnPropertyNames(value).every(key =>
        'value' in Object.getOwnPropertyDescriptor(value, key)), 'INVALID_OBJECT');
}

/** 规范化纯 JSON 数据；拒绝循环、访问器、稀疏数组、非有限数、过深数据。 */
function canonical(value, depth = 0, seen = new Set(), budget = { nodes: 0 }) {
    requireCondition(depth <= 32, 'JSON_TOO_DEEP');
    requireCondition(++budget.nodes <= MAX_JSON_BYTES, 'JSON_TOO_LARGE');
    if (typeof value === 'string') requireCondition(Buffer.byteLength(value) <= MAX_JSON_BYTES, 'JSON_TOO_LARGE');
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
    if (typeof value === 'number') {
        requireCondition(Number.isFinite(value), 'INVALID_JSON');
        return value;
    }
    requireCondition(typeof value === 'object' && !seen.has(value), 'INVALID_JSON');
    const array = Array.isArray(value);
    requireCondition(array || Object.getPrototypeOf(value) === Object.prototype, 'INVALID_JSON');
    requireCondition(Object.getOwnPropertySymbols(value).length === 0, 'INVALID_JSON');
    seen.add(value);
    const output = array ? [] : Object.create(null);
    const keys = Object.getOwnPropertyNames(value).filter(key => !(array && key === 'length')).sort();
    requireCondition(keys.length <= MAX_JSON_BYTES, 'JSON_TOO_LARGE');
    if (array) requireCondition(keys.length === value.length
        && keys.every(key => /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < value.length), 'INVALID_JSON');
    for (const key of keys) {
        requireCondition(Buffer.byteLength(key) <= MAX_JSON_BYTES, 'JSON_TOO_LARGE');
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        requireCondition('value' in descriptor && descriptor.enumerable, 'INVALID_JSON');
        output[key] = canonical(descriptor.value, depth + 1, seen, budget);
    }
    seen.delete(value);
    return output;
}

/** 返回有大小上限、键顺序稳定且与调用者隔离的 JSON 副本。 */
function jsonValue(value) {
    const text = JSON.stringify(canonical(value));
    requireCondition(Buffer.byteLength(text) <= MAX_JSON_BYTES, 'JSON_TOO_LARGE');
    return JSON.parse(text);
}

/** 深拷贝内部状态，避免调用者修改任务或令牌。 */
function copy(value) {
    return JSON.parse(JSON.stringify(value));
}

/** 有界、同步、单写入者持久调度器；所有变更必须先提交再返回。 */
export class DurableScheduler {
    #database;
    #lock;
    #clock;
    #config;
    #tasks = new Map();
    #paused = false;
    #calls = 0;
    #closed = false;
    #poisoned = false;
    #sequence = 0;
    #journalBytes = 0;

    /** 从可信目录恢复日志并取得独占锁；配置必须与已有日志完全一致。 */
    constructor(options) {
        fields(options, ['directory', 'leadId', 'memberIds', 'maxConcurrent', 'maxCalls', 'clock']);
        const { directory, leadId, memberIds, maxConcurrent = 2, maxCalls = 50, clock = Date.now } = options;
        requireCondition(typeof directory === 'string' && directory.length > 0 && directory.length <= 4096
            && !directory.includes('\0'), 'INVALID_DIRECTORY');
        identifier(leadId);
        requireCondition(Array.isArray(memberIds) && memberIds.length > 0 && memberIds.length <= 128, 'INVALID_MEMBERS');
        [...memberIds].forEach(identifier);
        requireCondition(new Set(memberIds).size === memberIds.length && !memberIds.includes(leadId), 'INVALID_MEMBERS');
        integer(maxConcurrent, 1, 128);
        integer(maxCalls, 0, 1000000);
        requireCondition(typeof clock === 'function', 'INVALID_CLOCK');
        this.#clock = clock;
        this.#now();
        this.#config = { version: 1, leadId, memberIds: [...memberIds].sort(), maxConcurrent, maxCalls };
        mkdirSync(resolve(directory), { recursive: true });
        try {
            this.#lock = new DatabaseSync(join(resolve(directory), 'writer.sqlite'));
            this.#lock.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=PERSIST; BEGIN EXCLUSIVE;');
        } catch (error) {
            this.#lock?.close();
            throw Object.assign(new Error('WRITER_LOCKED'), { code: 'WRITER_LOCKED', cause: error });
        }
        try {
            this.#database = new DatabaseSync(join(resolve(directory), 'events.sqlite'));
            // 先只读聚合：超限库不读取 body、不创建触发器，也不追加恢复事件。
            const exists = this.#database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='events'").get();
            const totals = exists ? this.#database.prepare(`SELECT COUNT(*) AS rows,
                COALESCE(SUM(length(CAST(body AS BLOB))),0) AS bytes,
                COALESCE(MAX(length(CAST(body AS BLOB))),0) AS largest FROM events`).get()
                : { rows: 0, bytes: 0, largest: 0 };
            requireCondition(Number.isSafeInteger(totals.rows) && totals.rows <= MAX_JOURNAL_ROWS
                && Number.isSafeInteger(totals.bytes) && totals.bytes <= MAX_JOURNAL_BYTES
                && totals.largest <= MAX_EVENT_BYTES, 'JOURNAL_LIMIT');
            this.#database.exec(`PRAGMA journal_mode=PERSIST; PRAGMA synchronous=FULL;
                CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, body TEXT NOT NULL);
                CREATE TRIGGER IF NOT EXISTS no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'APPEND_ONLY'); END;
                CREATE TRIGGER IF NOT EXISTS no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'APPEND_ONLY'); END;`);
            // SQL LIMIT 与逐行字节检查构成双重界限；禁止用 all() 装载整个历史。
            for (const row of this.#database.prepare('SELECT seq,body FROM events ORDER BY seq LIMIT ?')
                .iterate(MAX_JOURNAL_ROWS)) {
                requireCondition(row.seq === this.#sequence + 1, 'JOURNAL_CORRUPT');
                requireCondition(typeof row.body === 'string', 'JOURNAL_CORRUPT');
                const bytes = Buffer.byteLength(row.body);
                requireCondition(bytes <= MAX_EVENT_BYTES && this.#journalBytes + bytes <= MAX_JOURNAL_BYTES, 'JOURNAL_LIMIT');
                const event = JSON.parse(row.body);
                if (this.#sequence === 0) requireCondition(JSON.stringify(event.config) === JSON.stringify(this.#config), 'CONFIG_CONFLICT');
                this.#apply(event);
                this.#sequence = row.seq;
                this.#journalBytes += bytes;
            }
            requireCondition(this.#sequence === totals.rows && this.#journalBytes === totals.bytes, 'JOURNAL_CORRUPT');
            if (totals.rows === 0) this.#commit({ kind: 'init', config: this.#config, tasks: [] });
            const recovered = [...this.#tasks.values()].filter(task => task.state === 'running')
                .map(task => ({ ...task, state: 'uncertain', token: null, reason: 'restart' }));
            if (recovered.length) this.#commitEvents(recovered.map(task => ({ kind: 'restart', tasks: [task] })));
        } catch (error) {
            this.#database?.close();
            this.#lock.close();
            throw error;
        }
    }

    /** 取得有效逻辑时间；时钟由适配器提供，超时使用非负整数毫秒。 */
    #now() {
        return integer(this.#clock(), 0, Number.MAX_SAFE_INTEGER);
    }

    /** 检查实例仍可使用；提交失败后必须关闭并重新恢复。 */
    #open() {
        requireCondition(!this.#closed && !this.#poisoned, 'SCHEDULER_CLOSED');
    }

    /** 校验 Lead 身份；这里的 actor 是上游已认证的精确 ID。 */
    #lead(actor) {
        this.#open();
        requireCondition(actor === this.#config.leadId, 'LEAD_REQUIRED');
    }

    /** 查找任务；任务 ID 不作为任何文件名使用。 */
    #task(id) {
        identifier(id);
        const task = this.#tasks.get(id);
        requireCondition(task, 'TASK_NOT_FOUND');
        return task;
    }

    /** 应用已经持久提交的增量事件。 */
    #apply(event) {
        for (const task of event.tasks ?? []) this.#tasks.set(task.id, task);
        if ('paused' in event) this.#paused = event.paused;
        if ('calls' in event) this.#calls = event.calls;
    }

    /** 追加单事件；admission 为真时必须保留善后余量。 */
    #commit(event, admission = false) {
        this.#commitEvents([event], admission);
    }

    /** 预检整个有界批次后原子追加；资源拒绝不改变数据库、内存或实例可用性。 */
    #commitEvents(events, admission = false) {
        requireCondition(events.length > 0 && events.length <= MAX_TASKS, 'JOURNAL_LIMIT');
        const bodies = [];
        let totalBytes = 0;
        const rowLimit = MAX_JOURNAL_ROWS - (admission ? JOURNAL_RESERVED_ROWS : 0);
        const byteLimit = MAX_JOURNAL_BYTES - (admission ? JOURNAL_RESERVED_BYTES : 0);
        requireCondition(this.#sequence + events.length <= rowLimit, 'JOURNAL_LIMIT');
        for (const event of events) {
            // 事件落盘时补一个时间戳，供界面时间线使用；调用方已带 at 时保持不变。
            const stamped = event.at === undefined ? { ...event, at: this.#now() } : event;
            const body = JSON.stringify(stamped);
            const bytes = Buffer.byteLength(body);
            requireCondition(bytes <= MAX_EVENT_BYTES && this.#journalBytes + totalBytes + bytes <= byteLimit, 'JOURNAL_LIMIT');
            totalBytes += bytes;
            bodies.push(body);
        }
        try {
            this.#database.exec('BEGIN IMMEDIATE');
            const insert = this.#database.prepare('INSERT INTO events(seq,body) VALUES (?,?)');
            for (let index = 0; index < bodies.length; index += 1) insert.run(this.#sequence + index + 1, bodies[index]);
            this.#database.exec('COMMIT');
        } catch (error) {
            this.#poisoned = true;
            try { this.#database.exec('ROLLBACK'); } catch { /* 保留原始提交异常。 */ }
            throw error;
        }
        this.#sequence += bodies.length;
        this.#journalBytes += totalBytes;
        for (const body of bodies) this.#apply(JSON.parse(body));
    }

    /** 预留隐式超时后的后续事件；保守大小预检避免资源拒绝前已追加超时。 */
    #followupRoom(event, admission = false) {
        const now = this.#now();
        const expired = [...this.#tasks.values()].filter(task => task.state === 'running' && now >= task.deadline)
            .map(task => ({ tasks: [{ ...task, state: 'uncertain', token: null, reason: 'timeout' }] }));
        const rowLimit = MAX_JOURNAL_ROWS - (admission ? JOURNAL_RESERVED_ROWS : 0);
        const byteLimit = MAX_JOURNAL_BYTES - (admission ? JOURNAL_RESERVED_BYTES : 0);
        requireCondition(this.#sequence + expired.length + 1 <= rowLimit, 'JOURNAL_LIMIT');
        let bytes = this.#journalBytes;
        for (const item of [...expired, event]) {
            const length = Buffer.byteLength(JSON.stringify(item));
            requireCondition(length <= MAX_EVENT_BYTES && (bytes += length) <= byteLimit, 'JOURNAL_LIMIT');
        }
        return now;
    }

    /** 超时持久转为 uncertain；保持外部效果占位直到 Lead 明确核对。 */
    #expire(taskId = null, now = this.#now()) {
        const expired = [...this.#tasks.values()].filter(task => (taskId === null || task.id === taskId)
            && task.state === 'running' && now >= task.deadline)
            .map(task => ({ ...task, state: 'uncertain', token: null, reason: 'timeout' }));
        // 单任务事件避免 1000 个大任务拼成超大 body；整个批次仍只有一个 FULL 事务。
        if (expired.length) this.#commitEvents(expired.map(task => ({ kind: 'timeout', tasks: [task] })));
        return expired.map(task => task.id);
    }

    /** Lead 入队；相同 ID 只允许规范化后的原始定义完全相同。 */
    enqueue(actor, input) {
        this.#lead(actor);
        fields(input, ['id', 'memberId', 'payload', 'dependencies', 'timeoutMs', 'maxAttempts']);
        const { id, memberId, payload, dependencies = [], timeoutMs = 60000, maxAttempts = 3 } = input;
        identifier(id);
        identifier(memberId);
        requireCondition(this.#config.memberIds.includes(memberId), 'UNKNOWN_MEMBER');
        integer(timeoutMs, 1, 86400000);
        integer(maxAttempts, 1, 100);
        requireCondition(Array.isArray(dependencies) && dependencies.length <= 128, 'INVALID_DEPENDENCIES');
        [...dependencies].forEach(identifier);
        requireCondition(new Set(dependencies).size === dependencies.length && !dependencies.includes(id), 'INVALID_DEPENDENCIES');
        const definition = { id, memberId, payload: jsonValue(payload), dependencies: [...dependencies].sort(), timeoutMs, maxAttempts };
        const existing = this.#tasks.get(id);
        if (existing) {
            requireCondition(JSON.stringify(existing.definition) === JSON.stringify(definition), 'ID_CONFLICT');
            return copy(existing);
        }
        requireCondition(this.#tasks.size < MAX_TASKS, 'TASK_LIMIT');
        // 只引用已存在任务，使依赖图按入队顺序天然无环。
        definition.dependencies.forEach(dependency => this.#task(dependency));
        const task = { ...definition, definition, state: 'queued', attempt: 0, token: null,
            deadline: null, effectPending: false, receipt: null, result: null, reason: null };
        this.#commit({ kind: 'enqueue', tasks: [task] }, true);
        return copy(task);
    }

    /** Lead 显式派发一个任务；派发计数和新随机围栏令牌原子提交。 */
    reserve(actor, id) {
        this.#lead(actor);
        const initial = this.#task(id);
        const now = this.#followupRoom({ tasks: [{ ...initial, state: 'running', attempt: 100,
            token: 'f'.repeat(64), deadline: Number.MAX_SAFE_INTEGER, effectPending: true, reason: null }],
        calls: this.#calls + 1 }, true);
        this.#expire(null, now);
        const task = this.#task(id);
        requireCondition(!this.#paused, 'PAUSED');
        requireCondition(task.state === 'queued', 'NOT_QUEUED');
        requireCondition(task.dependencies.every(dependency => this.#task(dependency).state === 'completed'), 'DEPENDENCIES_PENDING');
        const occupied = [...this.#tasks.values()].filter(item => item.effectPending);
        requireCondition(occupied.length < this.#config.maxConcurrent, 'CONCURRENCY_LIMIT');
        requireCondition(!occupied.some(item => item.memberId === task.memberId), 'MEMBER_BUSY');
        requireCondition(this.#calls < this.#config.maxCalls, 'CALL_BUDGET');
        requireCondition(task.attempt < task.maxAttempts, 'ATTEMPT_LIMIT');
        const deadline = this.#now() + task.timeoutMs;
        integer(deadline, 0, Number.MAX_SAFE_INTEGER);
        const reserved = { ...task, state: 'running', attempt: task.attempt + 1,
            token: randomBytes(32).toString('hex'), deadline, effectPending: true, reason: null };
        this.#commit({ kind: 'dispatch', tasks: [reserved], calls: this.#calls + 1 }, true);
        return copy(reserved);
    }

    /** 精确成员或 Lead 报告结果；仅当前围栏有效，成功报告的完全重复幂等。 */
    report(actor, input) {
        this.#open();
        fields(input, ['id', 'attempt', 'token', 'result']);
        const task = this.#task(input.id);
        requireCondition(actor === this.#config.leadId || actor === task.memberId, 'REPORT_FORBIDDEN');
        integer(input.attempt, 1, 100);
        requireCondition(typeof input.token === 'string' && /^[a-f0-9]{64}$/.test(input.token), 'INVALID_TOKEN');
        const receipt = { attempt: input.attempt, token: input.token, result: jsonValue(input.result) };
        // 成员报告只可推进自己的目标任务；不能借报告改变其他成员的超时状态。
        this.#expire(input.id);
        const current = this.#task(input.id);
        if (current.receipt && current.state === 'completed') {
            requireCondition(JSON.stringify(current.receipt) === JSON.stringify(receipt), 'OBSOLETE_RESULT');
            return copy(current);
        }
        requireCondition(current.state === 'running' && current.attempt === input.attempt
            && current.token === input.token, 'OBSOLETE_RESULT');
        const completed = { ...current, state: 'completed', token: null, effectPending: false,
            receipt, result: receipt.result, reason: null };
        this.#commit({ kind: 'report', tasks: [completed] });
        return copy(completed);
    }

    /** Lead 核对 uncertain 外部效果；retry 表示上游已确认旧执行停止且接受重试风险。 */
    reconcile(actor, input) {
        this.#lead(actor);
        fields(input, ['id', 'action', 'result']);
        requireCondition(['retry', 'complete', 'fail'].includes(input.action), 'INVALID_ACTION');
        const result = 'result' in input ? jsonValue(input.result) : null;
        const initial = this.#task(input.id);
        const now = this.#followupRoom({ tasks: [{ ...initial, state: 'completed', token: null, deadline: null,
            effectPending: false, result, receipt: null, reason: `reconcile:${input.action}` }] }, input.action === 'retry');
        this.#expire(null, now);
        const task = this.#task(input.id);
        requireCondition(task.state === 'uncertain' || (task.state === 'canceled' && task.effectPending), 'NOT_UNCERTAIN');
        if (input.action === 'retry') {
            requireCondition(task.state !== 'canceled', 'CANCELED');
            requireCondition(task.attempt < task.maxAttempts, 'ATTEMPT_LIMIT');
        }
        const state = task.state === 'canceled' ? 'canceled'
            : { retry: 'queued', complete: 'completed', fail: 'failed' }[input.action];
        const reconciled = { ...task, state, token: null, deadline: null,
            effectPending: false, result, receipt: null, reason: `reconcile:${input.action}` };
        this.#commit({ kind: `reconcile:${input.action}`, tasks: [reconciled] }, input.action === 'retry');
        return copy(reconciled);
    }

    /** Lead 持久暂停或恢复；暂停不停止已派发任务。 */
    pause(actor, paused) {
        this.#lead(actor);
        requireCondition(typeof paused === 'boolean', 'INVALID_PAUSED');
        if (paused !== this.#paused) this.#commit({ kind: paused ? 'pause' : 'resume', paused }, !paused);
        return this.snapshot();
    }

    /** Lead 立即逻辑取消并废止令牌；运行中的外部效果仍占位等待适配器核对。 */
    cancel(actor, id) {
        this.#lead(actor);
        const task = this.#task(id);
        if (task.state === 'canceled') return copy(task);
        requireCondition(!['completed', 'failed'].includes(task.state), 'TERMINAL_TASK');
        const canceled = { ...task, state: 'canceled', token: null, reason: 'cancel' };
        this.#commit({ kind: 'cancel', tasks: [canceled] });
        return copy(canceled);
    }

    /** Lead 显式处理超时；返回本次过期任务 ID 列表。 */
    expire(actor) {
        this.#lead(actor);
        return this.#expire();
    }

    /** 供界面时间线增量拉取；只读、有界，不改变任何状态。 */
    eventsSince(afterSeq = 0, limit = 200) {
        this.#open();
        integer(afterSeq, 0, Number.MAX_SAFE_INTEGER);
        integer(limit, 1, MAX_JOURNAL_ROWS);
        const rows = this.#database
            .prepare('SELECT seq,body FROM events WHERE seq > ? ORDER BY seq LIMIT ?')
            .all(afterSeq, limit);
        return rows.map(row => {
            const body = JSON.parse(row.body);
            return {
                seq: row.seq,
                at: body.at ?? null,
                kind: body.kind ?? 'event',
                paused: 'paused' in body ? body.paused : undefined,
                tasks: Array.isArray(body.tasks)
                    ? body.tasks.map(task => ({ id: task.id, state: task.state, attempt: task.attempt, reason: task.reason ?? null }))
                    : [],
            };
        });
    }

    /** 返回脱离内部引用的持久状态；读取不会隐式推进超时或派发。 */
    snapshot() {
        this.#open();
        return copy({ ...this.#config, paused: this.#paused, calls: this.#calls,
            sequence: this.#sequence, tasks: [...this.#tasks.values()] });
    }

    /** 生命周期扩展：释放数据库句柄和进程锁，不删除任何文件，可重复调用。 */
    close() {
        if (this.#closed) return;
        this.#closed = true;
        try { this.#database?.close(); } finally { this.#lock?.close(); }
    }
}
