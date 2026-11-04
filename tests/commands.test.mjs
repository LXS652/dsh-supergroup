/** 成员增删命令层单测：解析、增删、换主、审计与落盘。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCommand, runCommand } from '../src/core/commands.mjs';
import { SessionRegistry } from '../src/core/registry.mjs';

function makeRegistry(file) {
    return new SessionRegistry({ lead: 'session-lead', members: [{ sessionId: 'session-a', roleClass: 'assistant' }] }, { file });
}

test('解析：未知动词、缺 session、多余参数都被拒绝', () => {
    assert.deepEqual(parseCommand('list'), { verb: 'list', args: { sessionId: null, roleClass: null, label: null } });
    assert.equal(parseCommand('add session-x persona 人设邮箱').args.label, '人设邮箱');
    assert.throws(() => parseCommand('destroy'), /UNKNOWN_VERB/);
    assert.throws(() => parseCommand('add'), /MISSING_SESSION/);
    assert.throws(() => parseCommand('list now'), /TOO_MANY_ARGUMENTS/);
    assert.throws(() => parseCommand('   '), /COMMAND_EMPTY/);
});

test('增删与查看：结果结构化，失败返回 ok:false 而不是抛出', async () => {
    const registry = makeRegistry(undefined);
    const added = await runCommand(registry, 'add persona-mailbox persona 人设邮箱');
    assert.equal(added.ok, true);
    assert.equal(added.data.roleClass, 'persona');

    const listed = await runCommand(registry, 'list');
    assert.equal(listed.ok, true);
    assert.equal(listed.data.members.length, 2);

    const dup = await runCommand(registry, 'add persona-mailbox persona');
    assert.equal(dup.ok, false);
    assert.match(dup.reason, /DUPLICATE_SESSION_ID/);

    const removed = await runCommand(registry, 'remove persona-mailbox');
    assert.equal(removed.ok, true);
    assert.equal(registry.list().length, 1);

    const ghost = await runCommand(registry, 'remove session-ghost');
    assert.equal(ghost.ok, false);
    assert.match(ghost.reason, /UNKNOWN_MEMBER/);
});

test('换主会话：原主会话退出名单，新主会话不再作为成员', async () => {
    const registry = makeRegistry(undefined);
    const result = await runCommand(registry, 'lead session-a');
    assert.equal(result.ok, true);
    assert.equal(registry.lead(), 'session-a');
    assert.equal(registry.list().length, 0);
});

test('落盘：改名单后写盘成功，只读命令不产生副作用', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ms-commands-'));
    try {
        const file = join(directory, 'registry.json');
        const registry = makeRegistry(file);
        const listed = await runCommand(registry, 'list');
        assert.equal(listed.ok, true);
        assert.equal(registry.snapshot().saved, false, 'list 不应写盘');

        const added = await runCommand(registry, 'add queue-session reviewer 修里');
        assert.equal(added.ok, true);
        assert.equal(registry.snapshot().saved, true);

        const reloaded = await SessionRegistry.load(file);
        assert.equal(reloaded.list().length, 2);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
