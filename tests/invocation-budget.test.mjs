/**
 * 主机调用预算回归测试；创建者：DeepSeek Harness，2026-11-02。
 * 只运行 Node 内置模块及本配额模块；测试数据库保留在 tests/budget-runtime。
 * 子进程仅执行本模块，不启动 DSH、不访问网络、不删除测试数据。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { InvocationBudget } from '../src/core/invocation-budget.mjs';

const runtimeRoot = join(dirname(fileURLToPath(import.meta.url)), 'budget-runtime');
const moduleUrl = new URL('../src/core/invocation-budget.mjs', import.meta.url).href;
mkdirSync(runtimeRoot, { recursive: true });

/** 为测试创建独立目录及默认配置；测试结束仅关闭句柄。 */
function fixture(overrides = {}) {
    const directory = mkdtempSync(join(runtimeRoot, 'case-'));
    const options = { directory, memberIds: ['m1', 'm2'], ...overrides };
    return { directory, options };
}

/** 验证稳定异常码及消息，避免任意异常让测试误通过。 */
function rejects(code, action) {
    assert.throws(action, error => error.code === code && error.message === code);
}

/** 运行真实 bundled Node 子进程，继承输出并限制测试时间。 */
function child(code) {
    return spawnSync(process.execPath, ['--input-type=module', '--eval', code], {
        stdio: 'inherit', timeout: 10000,
    });
}

// 测试覆盖共享全局预算，而不是两个成员各自拥有一份预算。
test('默认上限、同步快照及成员计数不可变', t => {
    const { options } = fixture();
    const budget = new InvocationBudget(options);
    t.after(() => budget.close());
    assert.deepEqual(budget.snapshot(), {
        tools: 0, streams: 0, maxTools: 100, maxStreams: 50,
        members: [{ memberId: 'm1', tools: 0, streams: 0 }, { memberId: 'm2', tools: 0, streams: 0 }],
    });
    const snapshot = budget.take('m2', 'tool');
    assert.equal(snapshot instanceof Promise, false);
    assert.equal(snapshot.tools, 1);
    assert.equal(snapshot.members[1].tools, 1);
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(snapshot.members), true);
    assert.equal(Object.isFrozen(snapshot.members[1]), true);
    assert.throws(() => { snapshot.members[1].tools = 0; }, TypeError);
});

test('两个成员共享工具与流上限，失败预留完全不增加计数', t => {
    const { options } = fixture({ maxTools: 3, maxStreams: 2 });
    const budget = new InvocationBudget(options);
    t.after(() => budget.close());
    budget.take('m1', 'tool');
    budget.take('m2', 'tool');
    budget.take('m1', 'tool');
    const toolLimit = budget.snapshot();
    rejects('TOOL_BUDGET', () => budget.take('m2', 'tool'));
    assert.deepEqual(budget.snapshot(), toolLimit);
    budget.take('m2', 'stream');
    budget.take('m1', 'stream');
    const bothLimits = budget.snapshot();
    for (const memberId of options.memberIds) {
        rejects('TOOL_BUDGET', () => budget.take(memberId, 'tool'));
        rejects('STREAM_BUDGET', () => budget.take(memberId, 'stream'));
    }
    assert.deepEqual(budget.snapshot(), bothLimits);
});

test('实际调用体失败不退还已持久预留的额度，重启保留计数', () => {
    const { options } = fixture({ maxTools: 1, maxStreams: 1 });
    let budget = new InvocationBudget(options);
    try {
        assert.throws(() => {
            budget.take('m1', 'tool');
            throw new Error('模拟调用体失败');
        }, /模拟调用体失败/);
        budget.take('m2', 'stream');
    } finally {
        budget.close();
    }
    budget = new InvocationBudget({ ...options, memberIds: ['m2', 'm1'] });
    try {
        assert.equal(budget.snapshot().tools, 1);
        assert.equal(budget.snapshot().streams, 1);
        rejects('TOOL_BUDGET', () => budget.take('m2', 'tool'));
        rejects('STREAM_BUDGET', () => budget.take('m1', 'stream'));
    } finally {
        budget.close();
    }
});

test('零上限立即拒绝且另一类型仍可预留', t => {
    const { options } = fixture({ maxTools: 0, maxStreams: 1 });
    const budget = new InvocationBudget(options);
    t.after(() => budget.close());
    rejects('TOOL_BUDGET', () => budget.take('m1', 'tool'));
    assert.equal(budget.take('m2', 'stream').streams, 1);
    assert.equal(budget.snapshot().tools, 0);
});

test('构造参数严格校验且成员与种类错误不消耗预算', t => {
    const { options } = fixture();
    for (const invalid of [undefined, null, [], {}, { ...options, extra: true },
        { ...options, directory: '' }, { ...options, directory: 'a\0b' },
        { ...options, memberIds: ['m1'] }, { ...options, memberIds: ['m1', 'm1'] },
        { ...options, memberIds: ['m1', 'm2', 'm3'] }, { ...options, memberIds: ['m1', 2] },
        { ...options, memberIds: ['m1', 'bad\n'] }, { ...options, memberIds: new Array(2) },
        ...[-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '2', null]
            .flatMap(value => [{ ...options, maxTools: value }, { ...options, maxStreams: value }])]) {
        rejects('BUDGET_INVALID_ARGUMENT', () => new InvocationBudget(invalid));
    }
    const accessor = { ...options };
    Object.defineProperty(accessor, 'maxTools', { get() { throw new Error('不应访问'); } });
    rejects('BUDGET_INVALID_ARGUMENT', () => new InvocationBudget(accessor));
    const budget = new InvocationBudget(options);
    t.after(() => budget.close());
    const before = budget.snapshot();
    for (const memberId of ['unknown', '', undefined, {}, "m1' OR 1=1 --"]) {
        rejects('BUDGET_UNKNOWN_MEMBER', () => budget.take(memberId, 'tool'));
    }
    for (const kind of ['tools', 'STREAM', '', undefined, {}, null]) {
        rejects('BUDGET_INVALID_KIND', () => budget.take('m1', kind));
    }
    assert.deepEqual(budget.snapshot(), before);
});

test('配置冲突拒绝且释放锁，不覆盖旧上限及成员', () => {
    const { options } = fixture();
    const first = new InvocationBudget(options);
    first.take('m1', 'tool');
    first.close();
    for (const conflict of [{ maxTools: 99 }, { maxStreams: 49 }, { memberIds: ['m1', 'm3'] }]) {
        rejects('BUDGET_CONFIG_CONFLICT', () => new InvocationBudget({ ...options, ...conflict }));
    }
    const reopened = new InvocationBudget(options);
    try {
        assert.equal(reopened.snapshot().tools, 1);
        assert.equal(reopened.snapshot().maxTools, 100);
    } finally {
        reopened.close();
    }
});

test('同进程与跨进程第二写者均拒绝，关闭后可重新接管', () => {
    const { options } = fixture();
    const first = new InvocationBudget(options);
    try {
        rejects('BUDGET_WRITER_LOCKED', () => new InvocationBudget(options));
        const result = child(`
            import assert from 'node:assert/strict';
            import { InvocationBudget } from ${JSON.stringify(moduleUrl)};
            assert.throws(() => new InvocationBudget(${JSON.stringify(options)}),
                error => error.code === 'BUDGET_WRITER_LOCKED');
        `);
        assert.ifError(result.error);
        assert.equal(result.status, 0);
        assert.equal(first.take('m1', 'tool').tools, 1);
    } finally {
        first.close();
    }
    const next = new InvocationBudget(options);
    assert.equal(next.snapshot().tools, 1);
    next.close();
});

test('实际子进程突退出释放写锁且已提交预留跨进程持久化', () => {
    const { options } = fixture({ maxTools: 1, maxStreams: 1 });
    const result = child(`
        import { InvocationBudget } from ${JSON.stringify(moduleUrl)};
        const budget = new InvocationBudget(${JSON.stringify(options)});
        budget.take('m1', 'tool');
        budget.take('m2', 'stream');
        process.kill(process.pid, 'SIGKILL');
    `);
    assert.ifError(result.error);
    assert.ok(result.signal !== null || result.status !== 0);
    const budget = new InvocationBudget(options);
    try {
        assert.equal(budget.snapshot().tools, 1);
        assert.equal(budget.snapshot().streams, 1);
        rejects('TOOL_BUDGET', () => budget.take('m2', 'tool'));
    } finally {
        budget.close();
    }
});

test('成员写入故障回滚总计，存储异常使用稳定错误码', t => {
    const { options, directory } = fixture();
    const budget = new InvocationBudget(options);
    t.after(() => budget.close());
    const database = new DatabaseSync(join(directory, 'invocation-budget.sqlite'));
    // 注入故障的连接也保留日志，避免默认 DELETE 模式与现有 PERSIST 句柄冲突。
    database.exec('PRAGMA journal_mode = PERSIST; PRAGMA synchronous = FULL;');
    database.exec(`CREATE TRIGGER reject_member BEFORE UPDATE ON members
        BEGIN SELECT RAISE(ABORT, '测试成员写入故障'); END;`);
    database.close();
    const before = budget.snapshot();
    rejects('BUDGET_STORAGE', () => budget.take('m1', 'tool'));
    assert.deepEqual(budget.snapshot(), before);
});

test('提交被读锁阻塞时回滚，不留下未提交或部分计数', t => {
    const { options, directory } = fixture();
    const budget = new InvocationBudget(options);
    t.after(() => budget.close());
    const reader = new DatabaseSync(join(directory, 'invocation-budget.sqlite'));
    try {
        reader.exec('BEGIN');
        reader.prepare('SELECT * FROM budget').all();
        rejects('BUDGET_STORAGE', () => budget.take('m1', 'stream'));
    } finally {
        reader.close();
    }
    assert.equal(budget.snapshot().streams, 0);
    assert.equal(budget.take('m2', 'stream').streams, 1);
});

test('固定三行配额、持久日志配置与调度器文件隔离', () => {
    const { options, directory } = fixture({ maxTools: 200 });
    for (const name of ['writer.sqlite', 'events.sqlite']) {
        writeFileSync(join(directory, name), `调度器独占:${name}`);
    }
    const budget = new InvocationBudget(options);
    for (let index = 0; index < 200; index += 1) budget.take(index % 2 ? 'm1' : 'm2', 'tool');
    budget.close();
    const database = new DatabaseSync(join(directory, 'invocation-budget.sqlite'));
    try {
        assert.equal(database.prepare('SELECT COUNT(*) AS count FROM budget').get().count, 1);
        assert.equal(database.prepare('SELECT COUNT(*) AS count FROM members').get().count, 2);
        assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    } finally {
        database.close();
    }
    assert.ok(readdirSync(directory).includes('invocation-budget.writer-lock.sqlite'));
    assert.ok(readdirSync(directory).includes('invocation-budget.sqlite-journal'));
    assert.equal(readdirSync(directory).some(name => name.endsWith('-wal') || name.endsWith('-shm')), false);
    for (const name of ['writer.sqlite', 'events.sqlite']) {
        assert.equal(readFileSync(join(directory, name), 'utf8'), `调度器独占:${name}`);
    }
});

test('关闭幂等且关闭后拒绝查询与预留', () => {
    const { options } = fixture();
    const budget = new InvocationBudget(options);
    budget.close();
    budget.close();
    rejects('BUDGET_CLOSED', () => budget.snapshot());
    rejects('BUDGET_CLOSED', () => budget.take('m1', 'tool'));
});
