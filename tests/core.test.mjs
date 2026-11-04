/**
 * 持久调度器回归测试；创建者：DeepSeek Harness，2026-11-02。
 * 仅执行本项目核心和 Node 内置模块。测试库暂存在系统临时目录，不写源码树。
 * 崩溃子进程仅为本测试创建的 Node 子进程，不加载 DSH。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { DurableScheduler } from '../src/core/scheduler.mjs';

const runtimeRoot = mkdtempSync(join(tmpdir(), 'dsh-supergroup-core-'));
const moduleUrl = new URL('../src/core/scheduler.mjs', import.meta.url).href;

/** 为每个测试分配独立且保留的项目内目录；返回调度器及可控时钟。 */
function fixture(overrides = {}) {
    const directory = mkdtempSync(join(runtimeRoot, 'case-'));
    let now = 1000;
    const options = { directory, leadId: 'lead', memberIds: ['m1', 'm2', 'm3'], clock: () => now, ...overrides };
    return { directory, options, scheduler: new DurableScheduler(options), setTime: value => { now = value; } };
}

/** 建立简洁任务定义，允许测试覆盖指定参数。 */
function task(id, memberId = 'm1', extra = {}) {
    return { id, memberId, payload: { prompt: id }, ...extra };
}

/** 根据派发结果建立严格围栏报告。 */
function report(reserved, result = { ok: true }) {
    return { id: reserved.id, attempt: reserved.attempt, token: reserved.token, result };
}

/** 检查稳定错误码，避免测试仅判断任意异常。 */
function rejects(code, action) {
    assert.throws(action, error => error.code === code);
}

/** 读取唯一任务的状态；返回任务对象。 */
function state(scheduler, id) {
    return scheduler.snapshot().tasks.find(item => item.id === id);
}

/** 创建独立 Node 进程，继承输出且禁止执行项目之外的代码。 */
function child(code) {
    return spawnSync(process.execPath, ['--input-type=module', '--eval', code], { stdio: 'inherit', timeout: 10000 });
}

/** 仅在关闭调度器的假库内追加无状态事件，精确构造行数/UTF-8 字节边界。 */
function fillJournal(directory, { rows, bytes } = {}) {
    const database = new DatabaseSync(join(directory, 'events.sqlite'));
    try {
        const totals = database.prepare('SELECT COUNT(*) AS rows, SUM(length(CAST(body AS BLOB))) AS bytes FROM events').get();
        let count = totals.rows;
        let size = totals.bytes;
        const insert = database.prepare('INSERT INTO events(seq,body) VALUES (?,?)');
        database.exec('BEGIN IMMEDIATE');
        while ((rows !== undefined && count < rows) || (bytes !== undefined && size < bytes)) {
            const length = bytes === undefined ? 2 : Math.min(512 * 1024, bytes - size);
            assert.ok(length >= 2);
            insert.run(++count, '{}' + ' '.repeat(length - 2));
            size += length;
        }
        database.exec('COMMIT');
        return { rows: count, bytes: size };
    } finally { database.close(); }
}

/** 取得日志文件的字节摘要，验证资源拒绝未改写库内容。 */
function journalHash(directory) {
    return createHash('sha256').update(readFileSync(join(directory, 'events.sqlite'))).digest('hex');
}

// 每个测试包含自己的完整行为断言，退出时只关闭句柄，不删除库文件。
test('重新打开保留任务、配置、暂停、调用预算与幂等报告', () => {
    const context = fixture();
    let scheduler = context.scheduler;
    const original = task('a');
    scheduler.enqueue('lead', original);
    const reserved = scheduler.reserve('lead', 'a');
    scheduler.report('m1', report(reserved));
    scheduler.pause('lead', true);
    const before = scheduler.snapshot();
    scheduler.close();
    scheduler = new DurableScheduler(context.options);
    assert.deepEqual(scheduler.snapshot(), before);
    assert.equal(scheduler.enqueue('lead', original).state, 'completed');
    assert.equal(scheduler.report('m1', report(reserved)).state, 'completed');
    rejects('OBSOLETE_RESULT', () => scheduler.report('m1', report(reserved, { ok: false })));
    scheduler.close();
    rejects('CONFIG_CONFLICT', () => new DurableScheduler({ ...context.options, maxCalls: 51 }));
    const reopened = new DurableScheduler(context.options);
    reopened.close();
    assert.ok(readdirSync(context.directory).includes('writer.sqlite'));
});

test('真实子进程崩溃释放进程锁，running 恢复为 uncertain 且不重放', () => {
    const directory = mkdtempSync(join(runtimeRoot, 'crash-'));
    const options = { directory, leadId: 'lead', memberIds: ['m1', 'm2', 'm3'] };
    const outcome = child(`import { DurableScheduler } from ${JSON.stringify(moduleUrl)};
        const scheduler = new DurableScheduler(${JSON.stringify(options)});
        scheduler.enqueue('lead',{id:'a',memberId:'m1',payload:null});
        scheduler.reserve('lead','a');
        process.kill(process.pid,'SIGKILL');`);
    assert.ok(outcome.status !== 0 || outcome.signal);
    assert.equal(outcome.error, undefined);
    const scheduler = new DurableScheduler(options);
    const recovered = state(scheduler, 'a');
    assert.equal(recovered.state, 'uncertain');
    assert.equal(recovered.token, null);
    assert.equal(recovered.effectPending, true);
    assert.equal(scheduler.snapshot().calls, 1);
    rejects('NOT_QUEUED', () => scheduler.reserve('lead', 'a'));
    scheduler.reconcile('lead', { id: 'a', action: 'retry' });
    assert.equal(scheduler.reserve('lead', 'a').attempt, 2);
    scheduler.close();
});

test('同进程及跨进程独占；关闭后允许重新打开且不破坏锁文件', () => {
    const context = fixture();
    const scheduler = context.scheduler;
    rejects('WRITER_LOCKED', () => new DurableScheduler(context.options));
    const { clock, ...options } = context.options;
    const outcome = child(`import { DurableScheduler } from ${JSON.stringify(moduleUrl)};
        try { new DurableScheduler(${JSON.stringify(options)}); process.exit(2); }
        catch(error) { process.exit(error.code === 'WRITER_LOCKED' ? 0 : 3); }`);
    assert.equal(outcome.status, 0);
    scheduler.close();
    scheduler.close();
    rejects('SCHEDULER_CLOSED', () => scheduler.snapshot());
    const reopened = new DurableScheduler(context.options);
    reopened.close();
});

test('依赖必须已存在且完成，失败与取消不会满足依赖', () => {
    const { scheduler } = fixture();
    rejects('TASK_NOT_FOUND', () => scheduler.enqueue('lead', task('bad', 'm1', { dependencies: ['missing'] })));
    rejects('INVALID_DEPENDENCIES', () => scheduler.enqueue('lead', task('self', 'm1', { dependencies: ['self'] })));
    scheduler.enqueue('lead', task('a'));
    scheduler.enqueue('lead', task('b', 'm2', { dependencies: ['a'] }));
    rejects('DEPENDENCIES_PENDING', () => scheduler.reserve('lead', 'b'));
    const first = scheduler.reserve('lead', 'a');
    scheduler.report('m1', report(first));
    assert.equal(scheduler.reserve('lead', 'b').state, 'running');
    scheduler.enqueue('lead', task('c', 'm3'));
    scheduler.enqueue('lead', task('d', 'm3', { dependencies: ['c'] }));
    scheduler.cancel('lead', 'c');
    rejects('DEPENDENCIES_PENDING', () => scheduler.reserve('lead', 'd'));
    scheduler.close();
});

test('全局并发和每成员互斥，uncertain 外部效果仍占位', () => {
    const { scheduler, setTime } = fixture();
    scheduler.enqueue('lead', task('a', 'm1', { timeoutMs: 5 }));
    scheduler.enqueue('lead', task('b', 'm1'));
    scheduler.enqueue('lead', task('c', 'm2'));
    scheduler.enqueue('lead', task('d', 'm3'));
    scheduler.reserve('lead', 'a');
    rejects('MEMBER_BUSY', () => scheduler.reserve('lead', 'b'));
    const second = scheduler.reserve('lead', 'c');
    rejects('CONCURRENCY_LIMIT', () => scheduler.reserve('lead', 'd'));
    setTime(1005);
    assert.deepEqual(scheduler.expire('lead'), ['a']);
    rejects('CONCURRENCY_LIMIT', () => scheduler.reserve('lead', 'd'));
    scheduler.report('m2', report(second));
    rejects('MEMBER_BUSY', () => scheduler.reserve('lead', 'b'));
    scheduler.reconcile('lead', { id: 'a', action: 'fail', result: 'stopped' });
    assert.equal(scheduler.reserve('lead', 'b').state, 'running');
    scheduler.close();
});

test('暂停和取消立即生效，取消不能重试且须核对外部效果', () => {
    const { scheduler } = fixture({ maxConcurrent: 1 });
    scheduler.enqueue('lead', task('a'));
    scheduler.enqueue('lead', task('b'));
    scheduler.pause('lead', true);
    rejects('PAUSED', () => scheduler.reserve('lead', 'a'));
    scheduler.pause('lead', false);
    const running = scheduler.reserve('lead', 'a');
    scheduler.cancel('lead', 'a');
    assert.equal(state(scheduler, 'a').state, 'canceled');
    rejects('OBSOLETE_RESULT', () => scheduler.report('m1', report(running)));
    rejects('NOT_QUEUED', () => scheduler.reserve('lead', 'a'));
    rejects('CONCURRENCY_LIMIT', () => scheduler.reserve('lead', 'b'));
    rejects('CANCELED', () => scheduler.reconcile('lead', { id: 'a', action: 'retry' }));
    scheduler.reconcile('lead', { id: 'a', action: 'complete', result: 'adapter stopped' });
    assert.equal(state(scheduler, 'a').state, 'canceled');
    assert.equal(state(scheduler, 'a').effectPending, false);
    assert.equal(scheduler.reserve('lead', 'b').state, 'running');
    scheduler.enqueue('lead', task('queued', 'm3'));
    assert.equal(scheduler.cancel('lead', 'queued').effectPending, false);
    assert.equal(scheduler.cancel('lead', 'queued').state, 'canceled');
    scheduler.close();
});

test('超时边界拒绝报告，重试令牌隔离旧结果且次数有界', () => {
    const { scheduler, setTime } = fixture();
    scheduler.enqueue('lead', task('a', 'm1', { timeoutMs: 10, maxAttempts: 2 }));
    const first = scheduler.reserve('lead', 'a');
    setTime(1010);
    rejects('OBSOLETE_RESULT', () => scheduler.report('m1', report(first)));
    assert.equal(state(scheduler, 'a').reason, 'timeout');
    scheduler.reconcile('lead', { id: 'a', action: 'retry' });
    const second = scheduler.reserve('lead', 'a');
    assert.notEqual(second.token, first.token);
    rejects('OBSOLETE_RESULT', () => scheduler.report('m1', report(first)));
    rejects('OBSOLETE_RESULT', () => scheduler.report('m1', { ...report(second), attempt: 1 }));
    setTime(1020);
    scheduler.expire('lead');
    rejects('ATTEMPT_LIMIT', () => scheduler.reconcile('lead', { id: 'a', action: 'retry' }));
    assert.equal(state(scheduler, 'a').state, 'uncertain');
    scheduler.reconcile('lead', { id: 'a', action: 'complete', result: 'verified externally' });
    rejects('OBSOLETE_RESULT', () => scheduler.report('m1', report(second)));
    assert.equal(state(scheduler, 'a').state, 'completed');
    scheduler.close();
});

test('原始定义幂等、冲突拒绝、结果键顺序规范化及快照引用隔离', () => {
    const { scheduler } = fixture();
    const original = task('a', 'm1', { payload: { z: 1, a: 2 } });
    scheduler.enqueue('lead', original);
    const sequence = scheduler.snapshot().sequence;
    original.payload.z = 99;
    assert.equal(state(scheduler, 'a').payload.z, 1);
    scheduler.enqueue('lead', task('a', 'm1', { payload: { a: 2, z: 1 } }));
    assert.equal(scheduler.snapshot().sequence, sequence);
    rejects('ID_CONFLICT', () => scheduler.enqueue('lead', original));
    const reserved = scheduler.reserve('lead', 'a');
    const input = report(reserved, { z: 1, a: 2 });
    scheduler.report('lead', input);
    assert.equal(scheduler.report('m1', report(reserved, { a: 2, z: 1 })).state, 'completed');
    input.result.z = 999;
    const snapshot = scheduler.snapshot();
    snapshot.tasks[0].payload.z = 999;
    assert.equal(state(scheduler, 'a').payload.z, 1);
    assert.equal(state(scheduler, 'a').result.z, 1);
    scheduler.close();
});

test('派发预算持久且不会因重试、角色失败、重复调用而增加额度', () => {
    const { scheduler, options, setTime } = fixture({ maxCalls: 1 });
    scheduler.enqueue('lead', task('a', 'm1', { timeoutMs: 1 }));
    scheduler.enqueue('lead', task('b', 'm2'));
    scheduler.reserve('lead', 'a');
    rejects('CALL_BUDGET', () => scheduler.reserve('lead', 'b'));
    setTime(1001);
    scheduler.expire('lead');
    scheduler.reconcile('lead', { id: 'a', action: 'retry' });
    rejects('CALL_BUDGET', () => scheduler.reserve('lead', 'a'));
    scheduler.close();
    const reopened = new DurableScheduler(options);
    assert.equal(reopened.snapshot().calls, 1);
    rejects('CALL_BUDGET', () => reopened.reserve('lead', 'b'));
    reopened.close();
    const zero = fixture({ maxCalls: 0 }).scheduler;
    zero.enqueue('lead', task('a'));
    rejects('CALL_BUDGET', () => zero.reserve('lead', 'a'));
    zero.close();
});

test('Lead 独占变更；成员只能报告分配给自己的任务', () => {
    const { scheduler } = fixture();
    scheduler.enqueue('lead', task('a'));
    const sequence = scheduler.snapshot().sequence;
    for (const action of [
        () => scheduler.enqueue('m1', task('b')),
        () => scheduler.reserve('m1', 'a'),
        () => scheduler.pause('m1', true),
        () => scheduler.cancel('m1', 'a'),
        () => scheduler.expire('m1'),
        () => scheduler.reconcile('m1', { id: 'a', action: 'retry' }),
    ]) rejects('LEAD_REQUIRED', action);
    assert.equal(scheduler.snapshot().sequence, sequence);
    const reserved = scheduler.reserve('lead', 'a');
    rejects('REPORT_FORBIDDEN', () => scheduler.report('m2', report(reserved)));
    rejects('REPORT_FORBIDDEN', () => scheduler.report({ id: 'm1' }, report(reserved)));
    assert.equal(scheduler.report('m1', report(reserved)).state, 'completed');
    rejects('TERMINAL_TASK', () => scheduler.cancel('lead', 'a'));
    rejects('NOT_UNCERTAIN', () => scheduler.reconcile('lead', { id: 'a', action: 'fail' }));
    scheduler.close();
});

test('畸形输入、未声明字段、循环数据和大小上限在持久化前拒绝', () => {
    const { scheduler, options } = fixture();
    const cycle = {}; cycle.self = cycle;
    const accessor = {}; Object.defineProperty(accessor, 'bad', { enumerable: true, get() { throw new Error('must not execute'); } });
    const hidden = {}; Object.defineProperty(hidden, 'hidden', { value: 1 });
    const sparse = new Array(1);
    const deep = {}; let cursor = deep;
    for (let index = 0; index < 34; index += 1) { cursor.next = {}; cursor = cursor.next; }
    const invalid = [
        ['INVALID_ID', task('../escape')],
        ['INVALID_JSON', task('a', 'm1', { payload: hidden })],
        ['INVALID_JSON', task('a', 'm1', { payload: sparse })],
        ['JSON_TOO_DEEP', task('a', 'm1', { payload: deep })],
        ['JSON_TOO_LARGE', task('a', 'm1', { payload: new Array(20000).fill(null) })],
        ['INVALID_ID', task('a', 'm1', { dependencies: sparse })],
        ['UNKNOWN_MEMBER', task('a', 'other')],
        ['INVALID_NUMBER', task('a', 'm1', { timeoutMs: 0 })],
        ['INVALID_NUMBER', task('a', 'm1', { maxAttempts: 101 })],
        ['INVALID_DEPENDENCIES', task('a', 'm1', { dependencies: ['b', 'b'] })],
        ['INVALID_JSON', task('a', 'm1', { payload: cycle })],
        ['INVALID_JSON', task('a', 'm1', { payload: accessor })],
        ['INVALID_JSON', task('a', 'm1', { payload: [undefined] })],
        ['INVALID_JSON', task('a', 'm1', { payload: new Date() })],
        ['INVALID_JSON', task('a', 'm1', { payload: NaN })],
        ['JSON_TOO_LARGE', task('a', 'm1', { payload: 'x'.repeat(16385) })],
        ['UNKNOWN_FIELD', { ...task('a'), surprise: true }],
    ];
    const sequence = scheduler.snapshot().sequence;
    for (const [code, input] of invalid) rejects(code, () => scheduler.enqueue('lead', input));
    assert.equal(scheduler.snapshot().sequence, sequence);
    rejects('INVALID_OBJECT', () => scheduler.enqueue('lead', null));
    const accessorInput = task('accessor');
    Object.defineProperty(accessorInput, 'payload', { enumerable: true, get() { throw new Error('must not execute'); } });
    rejects('INVALID_OBJECT', () => scheduler.enqueue('lead', accessorInput));
    rejects('INVALID_PAUSED', () => scheduler.pause('lead', 1));
    rejects('INVALID_ACTION', () => scheduler.reconcile('lead', { id: 'a', action: 'other' }));
    scheduler.enqueue('lead', task('a'));
    scheduler.reserve('lead', 'a');
    rejects('INVALID_TOKEN', () => scheduler.report('m1', { id: 'a', attempt: 1, token: 'bad', result: null }));
    rejects('INVALID_NUMBER', () => scheduler.report('m1', { id: 'a', attempt: 0, token: 'f'.repeat(64), result: null }));
    scheduler.close();
    rejects('INVALID_MEMBERS', () => new DurableScheduler({ ...options, memberIds: ['lead'] }));
    rejects('INVALID_MEMBERS', () => new DurableScheduler({ ...options, memberIds: ['m1', 'm1'] }));
    rejects('INVALID_ID', () => new DurableScheduler({ ...options, memberIds: new Array(1) }));
    rejects('INVALID_NUMBER', () => new DurableScheduler({ ...options, maxConcurrent: 0 }));
    rejects('INVALID_NUMBER', () => new DurableScheduler({ ...options, clock: () => -1 }));
});

/** 成员报告不能间接推进另一成员的任务状态。 */
test('成员报告仅推进自己的超时状态，不越权改变其他任务', () => {
    const { scheduler, setTime } = fixture();
    scheduler.enqueue('lead', task('a', 'm1', { timeoutMs: 10 }));
    scheduler.enqueue('lead', task('b', 'm2', { timeoutMs: 1 }));
    const first = scheduler.reserve('lead', 'a');
    scheduler.reserve('lead', 'b');
    setTime(1001);
    scheduler.report('m1', report(first));
    assert.equal(state(scheduler, 'b').state, 'running');
    assert.deepEqual(scheduler.expire('lead'), ['b']);
    scheduler.close();
});

test('日志只追加且 FULL 持久化，任务数有界', () => {
    const { scheduler, directory } = fixture();
    scheduler.enqueue('lead', task('a'));
    const database = new DatabaseSync(join(directory, 'events.sqlite'));
    assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.throws(() => database.exec("UPDATE events SET body='{}'"), /APPEND_ONLY/);
    assert.throws(() => database.exec('DELETE FROM events'), /APPEND_ONLY/);
    database.close();
    // 该测试只添加本项目测试数据，不清理或删除任何数据库文件。
    for (let index = 1; index < 1000; index += 1) scheduler.enqueue('lead', task(`bounded-${index}`));
    rejects('TASK_LIMIT', () => scheduler.enqueue('lead', task('over-limit')));
    assert.equal(scheduler.snapshot().tasks.length, 1000);
    scheduler.close();
});

/** 超限库只允许聚合检查，任何读取 body 或执行 all 都会让测试失败。 */
test('恢复先聚合拒绝行数、累计字节和单 body 超限，日志字节不变', () => {
    for (const kind of ['rows', 'bytes', 'body']) {
        const context = fixture();
        context.scheduler.close();
        if (kind === 'rows') fillJournal(context.directory, { rows: 20001 });
        if (kind === 'bytes') fillJournal(context.directory, { bytes: 64 * 1024 * 1024 + 2 });
        if (kind === 'body') {
            const database = new DatabaseSync(join(context.directory, 'events.sqlite'));
            // 无效 JSON 同时超出 body 界限，必须在 JSON.parse 之前以稳定资源码拒绝。
            database.prepare('INSERT INTO events(seq,body) VALUES (?,?)').run(2, '界'.repeat(174763));
            database.close();
        }
        const before = journalHash(context.directory);
        const original = DatabaseSync.prototype.prepare;
        let aggregate = false;
        DatabaseSync.prototype.prepare = function (sql) {
            if (sql.includes('COUNT(*)')) aggregate = true;
            assert.ok(!/SELECT seq,body/i.test(sql), 'oversized recovery must not select bodies');
            return original.call(this, sql);
        };
        try { rejects('JOURNAL_LIMIT', () => new DurableScheduler(context.options)); }
        finally { DatabaseSync.prototype.prepare = original; }
        assert.equal(aggregate, true);
        assert.equal(journalHash(context.directory), before);
        // 失败构造必须释放单写入者锁。
        const lock = new DatabaseSync(join(context.directory, 'writer.sqlite'));
        lock.exec('BEGIN EXCLUSIVE');
        lock.close();
    }
});

/** 正常历史采用带 SQL LIMIT 的惰性迭代，而不是装载 all()。 */
test('有界恢复使用迭代和固定 LIMIT，精确硬边界仍可只读恢复', () => {
    for (const limit of [{ rows: 20000 }, { bytes: 64 * 1024 * 1024 }]) {
        const context = fixture();
        context.scheduler.close();
        const totals = fillJournal(context.directory, limit);
        const original = DatabaseSync.prototype.prepare;
        let iterated = false;
        DatabaseSync.prototype.prepare = function (sql) {
            const statement = original.call(this, sql);
            if (!/SELECT seq,body/i.test(sql)) return statement;
            assert.match(sql, /LIMIT \?/);
            return {
                all() { assert.fail('unbounded all() is forbidden'); },
                iterate(bound) {
                    assert.equal(bound, 20000);
                    iterated = true;
                    return statement.iterate(bound);
                },
            };
        };
        let scheduler;
        try { scheduler = new DurableScheduler(context.options); }
        finally { DatabaseSync.prototype.prepare = original; }
        try {
            assert.equal(iterated, true);
            assert.equal(scheduler.snapshot().sequence, totals.rows);
            const before = scheduler.snapshot();
            const hash = journalHash(context.directory);
            rejects('JOURNAL_LIMIT', () => scheduler.enqueue('lead', task('blocked')));
            rejects('JOURNAL_LIMIT', () => scheduler.pause('lead', true));
            assert.deepEqual(scheduler.snapshot(), before);
            assert.equal(journalHash(context.directory), hash);
        } finally { scheduler.close(); }
    }
});

/** 入队、派发与恢复调度保留余量，已有执行仍可恢复、完成、取消和暂停。 */
test('行数和字节准入余量保护善后，资源拒绝不毒化实例或破坏幂等', () => {
    for (const limit of [{ rows: 18000 }, { bytes: 48 * 1024 * 1024 }]) {
        const context = fixture();
        const original = task('a');
        context.scheduler.enqueue('lead', original);
        context.scheduler.enqueue('lead', task('b', 'm2'));
        context.scheduler.reserve('lead', 'a');
        context.scheduler.close();
        fillJournal(context.directory, limit);
        const scheduler = new DurableScheduler(context.options);
        try {
            assert.equal(state(scheduler, 'a').reason, 'restart');
            const before = scheduler.snapshot();
            const hash = journalHash(context.directory);
            rejects('JOURNAL_LIMIT', () => scheduler.enqueue('lead', task('blocked')));
            rejects('JOURNAL_LIMIT', () => scheduler.reserve('lead', 'b'));
            rejects('JOURNAL_LIMIT', () => scheduler.reconcile('lead', { id: 'a', action: 'retry' }));
            assert.deepEqual(scheduler.snapshot(), before);
            assert.equal(journalHash(context.directory), hash);
            assert.equal(scheduler.enqueue('lead', original).state, 'uncertain');
            scheduler.reconcile('lead', { id: 'a', action: 'complete', result: 'verified' });
            scheduler.cancel('lead', 'b');
            scheduler.pause('lead', true);
            rejects('JOURNAL_LIMIT', () => scheduler.pause('lead', false));
            assert.equal(scheduler.snapshot().paused, true);
        } finally { scheduler.close(); }
    }
});

/** 准入拒绝不能先通过隐式超时修改其它任务；现有报告仍可用善后容量。 */
test('隐式超时与后续准入一起预检，拒绝时不追加超时或改变内存', () => {
    const context = fixture();
    context.scheduler.enqueue('lead', task('a', 'm1', { timeoutMs: 1 }));
    context.scheduler.enqueue('lead', task('b', 'm2'));
    context.scheduler.close();
    fillJournal(context.directory, { rows: 17998 });
    const scheduler = new DurableScheduler(context.options);
    try {
        scheduler.reserve('lead', 'a');
        context.setTime(1001);
        const before = scheduler.snapshot();
        const hash = journalHash(context.directory);
        rejects('JOURNAL_LIMIT', () => scheduler.reserve('lead', 'b'));
        rejects('JOURNAL_LIMIT', () => scheduler.reconcile('lead', { id: 'a', action: 'retry' }));
        assert.deepEqual(scheduler.snapshot(), before);
        assert.equal(journalHash(context.directory), hash);
        scheduler.expire('lead');
        scheduler.reconcile('lead', { id: 'a', action: 'fail' });
        assert.equal(state(scheduler, 'a').state, 'failed');
    } finally { scheduler.close(); }

    const reporting = fixture();
    reporting.scheduler.enqueue('lead', task('a'));
    reporting.scheduler.close();
    fillJournal(reporting.directory, { rows: 17999 });
    const active = new DurableScheduler(reporting.options);
    try {
        const reserved = active.reserve('lead', 'a');
        assert.equal(active.snapshot().sequence, 18000);
        assert.equal(active.report('m1', report(reserved)).state, 'completed');
        const sequence = active.snapshot().sequence;
        assert.equal(active.report('m1', report(reserved)).state, 'completed');
        assert.equal(active.snapshot().sequence, sequence);
    } finally { active.close(); }
});

/** 大任务的超时和重启按单任务事件批量提交，不能因一个超大 body 失去恢复能力。 */
test('多大任务 timeout/restart 拆分 body，整批资源不足时不部分追加', () => {
    const members = Array.from({ length: 128 }, (_, index) => `m${index}`);
    const context = fixture({ memberIds: members, maxConcurrent: 128, maxCalls: 128 });
    for (let index = 0; index < members.length; index += 1) {
        context.scheduler.enqueue('lead', task(`large-${index}`, members[index], { payload: 'x'.repeat(16000), timeoutMs: 1 }));
        context.scheduler.reserve('lead', `large-${index}`);
    }
    const sequence = context.scheduler.snapshot().sequence;
    context.setTime(1001);
    assert.equal(context.scheduler.expire('lead').length, members.length);
    assert.equal(context.scheduler.snapshot().sequence, sequence + members.length);
    context.scheduler.close();
    const database = new DatabaseSync(join(context.directory, 'events.sqlite'));
    assert.ok(database.prepare('SELECT MAX(length(CAST(body AS BLOB))) AS largest FROM events').get().largest <= 512 * 1024);
    database.close();
    const recovered = new DurableScheduler(context.options);
    assert.equal(recovered.snapshot().tasks.filter(item => item.reason === 'timeout').length, members.length);
    recovered.close();

    const blocked = fixture();
    blocked.scheduler.enqueue('lead', task('a'));
    blocked.scheduler.enqueue('lead', task('b', 'm2'));
    blocked.scheduler.reserve('lead', 'a');
    blocked.scheduler.reserve('lead', 'b');
    blocked.scheduler.close();
    fillJournal(blocked.directory, { rows: 19999 });
    const hash = journalHash(blocked.directory);
    rejects('JOURNAL_LIMIT', () => new DurableScheduler(blocked.options));
    assert.equal(journalHash(blocked.directory), hash);
});
