/**
 * 主机调用预算；创建者：DeepSeek Harness，2026-11-02。
 * 仅限制两个托管成员的主机工具派发和流调用次数，不代表费用或提供商重试次数。
 * take 必须在实际调用体之前执行；事务提交才返回，调用失败也不退还额度。
 * 可信本地 directory 内使用独立配额库及独立锁库，不接触调度器日志。
 * FULL + PERSIST 保留回滚日志；锁由 SQLite/操作系统释放，禁止删除锁文件恢复。
 */
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const CONFIG_KEYS = ['directory', 'memberIds', 'maxTools', 'maxStreams'];
const ID_PATTERN = /^[A-Za-z0-9_.:@-]{1,128}$/;

/** 创建稳定异常；code 与 message 相同，不公开底层路径及 SQL。 */
function failure(code) {
    return Object.assign(new Error(code), { code });
}

/** 验证构造参数并复制、排序成员；配置顺序不影响重启兼容性。 */
function configuration(options) {
    if (options === null || typeof options !== 'object'
        || Object.getPrototypeOf(options) !== Object.prototype
        || Reflect.ownKeys(options).some(key => !CONFIG_KEYS.includes(key)
            || !('value' in Object.getOwnPropertyDescriptor(options, key)))) {
        throw failure('BUDGET_INVALID_ARGUMENT');
    }
    const { directory, memberIds, maxTools = 100, maxStreams = 50 } = options;
    if (typeof directory !== 'string' || directory.trim().length === 0 || directory.includes('\0')
        || !Array.isArray(memberIds) || memberIds.length !== 2
        || ![0, 1].every(index => Object.hasOwn(memberIds, index)
            && 'value' in Object.getOwnPropertyDescriptor(memberIds, String(index))
            && typeof memberIds[index] === 'string' && ID_PATTERN.test(memberIds[index]))
        || memberIds[0] === memberIds[1]
        || ![maxTools, maxStreams].every(value => Number.isSafeInteger(value) && value >= 0)) {
        throw failure('BUDGET_INVALID_ARGUMENT');
    }
    return { directory: resolve(directory), memberIds: [memberIds[0], memberIds[1]].sort(), maxTools, maxStreams };
}

/** 配置同步耐久性和保留回滚日志；零等待使重复所有者立即失败。 */
function configureDatabase(database) {
    database.exec('PRAGMA busy_timeout = 0; PRAGMA journal_mode = PERSIST; PRAGMA synchronous = FULL;');
}

/** 两个成员共享一个跨重启累计预算；所有可变状态保存在私有句柄内。 */
export class InvocationBudget {
    #database;
    #writerLock;
    #config;

    /** 输入可信目录、两个唯一成员及非负安全整数上限；创建或核对持久配置。 */
    constructor(options) {
        this.#config = configuration(options);
        try {
            mkdirSync(this.#config.directory, { recursive: true });
            this.#writerLock = new DatabaseSync(join(this.#config.directory, 'invocation-budget.writer-lock.sqlite'));
            try {
                configureDatabase(this.#writerLock);
                // 独立库持有整个实例生命周期的锁；崩溃后内核释放，无陈旧锁猜测。
                this.#writerLock.exec('BEGIN EXCLUSIVE');
            } catch (error) {
                if (error.errcode === 5 || error.errcode === 6) throw failure('BUDGET_WRITER_LOCKED');
                throw error;
            }
            this.#database = new DatabaseSync(join(this.#config.directory, 'invocation-budget.sqlite'));
            configureDatabase(this.#database);
            this.#transaction(() => {
                this.#database.exec(`
                    CREATE TABLE IF NOT EXISTS budget (
                        id INTEGER PRIMARY KEY CHECK (id = 1),
                        version INTEGER NOT NULL CHECK (version = 1),
                        max_tools INTEGER NOT NULL CHECK (max_tools >= 0),
                        max_streams INTEGER NOT NULL CHECK (max_streams >= 0),
                        tools INTEGER NOT NULL CHECK (tools >= 0 AND tools <= max_tools),
                        streams INTEGER NOT NULL CHECK (streams >= 0 AND streams <= max_streams)
                    );
                    CREATE TABLE IF NOT EXISTS members (
                        slot INTEGER PRIMARY KEY CHECK (slot IN (0, 1)),
                        member_id TEXT NOT NULL UNIQUE,
                        tools INTEGER NOT NULL CHECK (tools >= 0),
                        streams INTEGER NOT NULL CHECK (streams >= 0)
                    );
                `);
                const stored = this.#database.prepare('SELECT * FROM budget WHERE id = 1').get();
                if (!stored) {
                    if (this.#database.prepare('SELECT COUNT(*) AS count FROM members').get().count !== 0) {
                        throw failure('BUDGET_STORAGE');
                    }
                    this.#database.prepare('INSERT INTO budget VALUES (1, 1, ?, ?, 0, 0)')
                        .run(this.#config.maxTools, this.#config.maxStreams);
                    const insert = this.#database.prepare('INSERT INTO members VALUES (?, ?, 0, 0)');
                    this.#config.memberIds.forEach((id, slot) => insert.run(slot, id));
                } else {
                    const members = this.#database.prepare('SELECT member_id FROM members ORDER BY slot').all();
                    if (stored.version !== 1 || stored.max_tools !== this.#config.maxTools
                        || stored.max_streams !== this.#config.maxStreams || members.length !== 2
                        || members.some((row, index) => row.member_id !== this.#config.memberIds[index])) {
                        throw failure('BUDGET_CONFIG_CONFLICT');
                    }
                }
                this.#readSnapshot();
            });
        } catch (error) {
            this.close();
            throw error.code?.startsWith('BUDGET_') ? error : failure('BUDGET_STORAGE');
        }
    }

    /** 执行原子配额事务；失败回滚，回滚失败则关闭实例并拒绝继续调用。 */
    #transaction(action) {
        let begun = false;
        try {
            this.#database.exec('BEGIN IMMEDIATE');
            begun = true;
            const result = action();
            this.#database.exec('COMMIT');
            return result;
        } catch (error) {
            if (begun) {
                try {
                    this.#database.exec('ROLLBACK');
                } catch {
                    this.close();
                    throw failure('BUDGET_STORAGE');
                }
            }
            throw ['TOOL_BUDGET', 'STREAM_BUDGET'].includes(error.code)
                || error.code?.startsWith('BUDGET_') ? error : failure('BUDGET_STORAGE');
        }
    }

    /** 检查实例状态；已关闭实例不再查询或预留。 */
    #requireOpen() {
        if (!this.#database) throw failure('BUDGET_CLOSED');
    }

    /** 读取固定三行并检查总计一致性；返回不可变、无共享可变引用的快照。 */
    #readSnapshot() {
        const total = this.#database.prepare('SELECT * FROM budget WHERE id = 1').get();
        const rows = this.#database.prepare('SELECT * FROM members ORDER BY slot').all();
        if (!total || rows.length !== 2 || rows.some((row, index) => row.slot !== index
            || row.member_id !== this.#config.memberIds[index]
            || !Number.isSafeInteger(row.tools) || !Number.isSafeInteger(row.streams)
            || row.tools < 0 || row.streams < 0)
            || !Number.isSafeInteger(total.tools) || !Number.isSafeInteger(total.streams)
            || total.tools !== rows[0].tools + rows[1].tools
            || total.streams !== rows[0].streams + rows[1].streams
            || total.tools > this.#config.maxTools || total.streams > this.#config.maxStreams) {
            throw failure('BUDGET_STORAGE');
        }
        return Object.freeze({
            tools: total.tools,
            streams: total.streams,
            maxTools: this.#config.maxTools,
            maxStreams: this.#config.maxStreams,
            members: Object.freeze(rows.map(row => Object.freeze({
                memberId: row.member_id, tools: row.tools, streams: row.streams,
            }))),
        });
    }

    /** 同步耐久预留一次工具或流调用；成功返回提交后的快照，失败绝不增加计数。 */
    take(memberId, kind) {
        this.#requireOpen();
        if (!this.#config.memberIds.includes(memberId)) throw failure('BUDGET_UNKNOWN_MEMBER');
        if (kind !== 'tool' && kind !== 'stream') throw failure('BUDGET_INVALID_KIND');
        return this.#transaction(() => {
            // 字段名只由已验证的二选一决定；成员值始终使用 SQL 参数绑定。
            const counter = kind === 'tool' ? 'tools' : 'streams';
            const maximum = kind === 'tool' ? 'max_tools' : 'max_streams';
            const updated = this.#database.prepare(`UPDATE budget SET ${counter} = ${counter} + 1
                WHERE id = 1 AND ${counter} < ${maximum}`).run();
            if (updated.changes !== 1) throw failure(kind === 'tool' ? 'TOOL_BUDGET' : 'STREAM_BUDGET');
            const member = this.#database.prepare(`UPDATE members SET ${counter} = ${counter} + 1
                WHERE member_id = ?`).run(memberId);
            if (member.changes !== 1) throw failure('BUDGET_STORAGE');
            return this.#readSnapshot();
        });
    }

    /** 返回全局上限、累计计数及两个成员累计计数；不修改持久状态。 */
    snapshot() {
        this.#requireOpen();
        return this.#transaction(() => this.#readSnapshot());
    }

    /** 幂等关闭配额句柄及独立写锁；不删除库、日志或锁文件，不退还额度。 */
    close() {
        const database = this.#database;
        const writerLock = this.#writerLock;
        this.#database = undefined;
        this.#writerLock = undefined;
        try {
            database?.close();
        } finally {
            writerLock?.close();
        }
    }
}
