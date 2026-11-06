import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { apply } from '../src/plugin2.mjs';

/** 最小宿主：只关心启动期路径、锁与注册面，不启动任何会话。 */
async function startAt(dataDir) {
    const registered = { tools: [], commands: [], guards: [] };
    const disposers = [];
    const ctx = {
        tools: {
            register(definition) { registered.tools.push(definition.name); },
            guard(fn) { registered.guards.push(fn); }
        },
        get(name) {
            if (name !== 'commands') return undefined;
            return { register(definition) { registered.commands.push(definition.name); } };
        },
        on() {},
        effect(fn) {
            const disposer = fn();
            disposers.push(disposer);
            return disposer;
        }
    };
    apply(ctx, {
        dataDir,
        startupReconcileAttempts: 1,
        startupReconcileIntervalMs: 1
    });
    return {
        registered,
        async stop() {
            for (const disposer of disposers) await disposer();
            await rm(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
        }
    };
}

test('数据根：config.dataDir 被创建，plugin.log 首行记录解析后的路径', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sg-data-'));
    const host = await startAt(directory);
    try {
        assert.ok(existsSync(join(directory, 'plugin.log')));
        const first = JSON.parse((await readFile(join(directory, 'plugin.log'), 'utf8')).split('\n')[0]);
        assert.equal(first.event, 'startup');
        assert.equal(first.dataDir, directory);
        assert.equal(first.pid, process.pid);
    } finally {
        await host.stop();
    }
});

test('单实例锁：活 pid 持锁时第二实例不注册任何工具', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sg-lock-busy-'));
    await writeFile(join(directory, '.instance.lock'), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), 'utf8');
    const host = await startAt(directory);
    try {
        assert.equal(host.registered.tools.length, 0);
        assert.equal(host.registered.commands.length, 0);
        const log = await readFile(join(directory, 'plugin.log'), 'utf8');
        assert.match(log, /"event":"lock-busy"/);
        assert.match(log, new RegExp(`"pid":${process.pid}`));
    } finally {
        await host.stop();
    }
});

test('单实例锁：死 pid 残留锁会被回收，退出时清理自己的锁', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sg-lock-stale-'));
    const lockPath = join(directory, '.instance.lock');
    await writeFile(lockPath, JSON.stringify({ pid: 999999, at: new Date().toISOString() }), 'utf8');
    const host = await startAt(directory);
    try {
        assert.ok(host.registered.tools.length > 0);
        const log = await readFile(join(directory, 'plugin.log'), 'utf8');
        assert.match(log, /"event":"lock-reclaimed","stalePid":999999/);
        const held = JSON.parse(await readFile(lockPath, 'utf8'));
        assert.equal(held.pid, process.pid);
    } finally {
        await host.stop();
    }
    assert.equal(existsSync(lockPath), false);
});
