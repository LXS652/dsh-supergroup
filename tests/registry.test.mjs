/** 注册表单元测试：校验、增删、换主会话、原子落盘与指纹。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionRegistry, normalizeConfig, fingerprint } from '../src/core/registry.mjs';

const base = { lead: 'session-lead', members: [{ sessionId: 'session-a', roleClass: 'assistant' }] };

test('配置校验：重复主会话、非法角色类别、非法 id 都被拒绝', () => {
    assert.throws(() => normalizeConfig({ lead: 'session-a', members: [{ sessionId: 'session-a' }] }), /DUPLICATE_SESSION_ID/);
    assert.throws(() => normalizeConfig({ lead: 'bad id!', members: [] }), /INVALID_SESSION_ID/);
    assert.throws(() => normalizeConfig({ lead: 'session-a', members: [{ sessionId: 'session-b', roleClass: 'root' }] }), /INVALID_ROLE_CLASS/);
    assert.throws(() => normalizeConfig({ lead: 'session-a', members: [{ sessionId: 'session-b', tools: ['a', 'a'] }] }), /DUPLICATE_TOOL/);
});

test('成员增删与换主会话：不允许把主会话加为成员，未知成员删除报错', () => {
    const registry = new SessionRegistry(base);
    assert.equal(registry.isLead('session-lead'), true);
    assert.throws(() => registry.add({ sessionId: 'session-lead' }), /LEAD_CANNOT_BE_MEMBER/);
    registry.add({ sessionId: 'session-b', label: '修里', roleClass: 'reviewer', tools: ['read', 'grep'] });
    assert.equal(registry.list().length, 2);
    assert.throws(() => registry.remove('session-ghost'), /UNKNOWN_MEMBER/);
    assert.deepEqual(registry.get('session-b').tools, ['read', 'grep']);
    registry.setLead('session-b');
    assert.equal(registry.lead(), 'session-b');
    assert.equal(registry.get('session-b'), undefined);
});

test('落盘与回读：指纹稳定，保存前 saved=false，保存后 true', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ms-registry-'));
    try {
        const file = join(directory, 'registry.json');
        const registry = new SessionRegistry(base, { file });
        assert.equal(registry.snapshot().saved, false);
        const savedFingerprint = await registry.save();
        assert.equal(registry.snapshot().saved, true);
        const text = await readFile(file, 'utf8');
        const parsed = JSON.parse(text);
        assert.equal(parsed.version, 1);
        assert.equal(parsed.lead, 'session-lead');
        assert.equal(savedFingerprint, fingerprint(parsed));

        const reloaded = await SessionRegistry.load(file);
        assert.deepEqual(reloaded.snapshot(), registry.snapshot());
        assert.equal(reloaded.snapshot().saved, true);

        await assert.rejects(SessionRegistry.load(join(directory, 'missing.json')), /FILE_MISSING/);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('损坏文件不会被当成合法名单', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ms-registry-bad-'));
    try {
        const file = join(directory, 'registry.json');
        await (await import('node:fs/promises')).writeFile(file, '{oops', 'utf8');
        await assert.rejects(SessionRegistry.load(file), /FILE_CORRUPT/);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
