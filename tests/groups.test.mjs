/** 整体仓库单测：创建规则、跨整体复用、迁移与落盘往返。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GroupsStore, normalizeGroupName } from '../src/core/groups.mjs';
import { SessionRegistry } from '../src/core/registry.mjs';

const LEAD = 'session-lead';
const MEMBER = 'session-member-a';
const OTHER = 'session-member-b';

async function scratch() {
    return mkdtemp(join(tmpdir(), 'groups-'));
}

test('整体名：允许中英文与空格，拒绝换行与控制字符', () => {
    assert.equal(normalizeGroupName('  团队 A  '), '团队 A');
    assert.equal(normalizeGroupName('迁移整体'), '迁移整体');
    assert.throws(() => normalizeGroupName('a\nb'), /GROUP_INVALID_NAME/);
    assert.throws(() => normalizeGroupName(''), /GROUP_INVALID_NAME/);
    assert.throws(() => normalizeGroupName('x'.repeat(41)), /GROUP_INVALID_NAME/);
});

test('创建规则：重名、缺主会话、主会话兼任成员都被拒', async () => {
    const directory = await scratch();
    try {
        const store = await GroupsStore.load(join(directory, 'groups.json'));
        const group = store.create({ name: '团队 A', lead: LEAD, members: [MEMBER] });
        assert.equal(group.registry.lead(), LEAD);
        assert.equal(group.registry.get(MEMBER).sessionId, MEMBER);

        assert.throws(() => store.create({ name: '团队 A', lead: OTHER, members: [MEMBER] }), /GROUP_NAME_TAKEN/);
        assert.throws(() => store.create({ name: '另一个', lead: '', members: [MEMBER] }), /GROUP_MISSING_LEAD/);
        assert.throws(() => store.create({ name: '另一个', lead: LEAD, members: [] }), /GROUP_MISSING_MEMBERS/);
        assert.throws(() => store.create({ name: '另一个', lead: LEAD, members: [LEAD] }), /GROUP_LEAD_CANNOT_BE_MEMBER/);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('同一个会话可以同时在多个整体里担任不同角色', async () => {
    const directory = await scratch();
    try {
        const store = await GroupsStore.load(join(directory, 'groups.json'));
        store.create({ name: '甲', lead: LEAD, members: [MEMBER] });
        store.create({ name: '乙', lead: MEMBER, members: [OTHER] });

        assert.equal(store.groupsWithMember(MEMBER).length, 1);
        assert.equal(store.groupsLedBy(MEMBER).length, 1);
        assert.equal(store.groupsWithMember(LEAD).length, 0);
        assert.equal(store.list().length, 2);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('落盘往返：重建后主会话与成员、标签都还在', async () => {
    const directory = await scratch();
    try {
        const file = join(directory, 'groups.json');
        const store = await GroupsStore.load(file);
        const created = store.create({
            name: '团队 A',
            lead: LEAD,
            members: [{ sessionId: MEMBER, label: '打工人', roleClass: 'assistant' }]
        });
        await store.save();

        const reloaded = await GroupsStore.load(file);
        const group = reloaded.get(created.id);
        assert.ok(group, '整体应当还在');
        assert.equal(group.name, '团队 A');
        assert.equal(group.registry.lead(), LEAD);
        assert.equal(group.registry.get(MEMBER).label, '打工人');
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('迁移：没有 groups.json 时，旧 registry.json 变成「迁移整体」', async () => {
    const directory = await scratch();
    try {
        const legacy = join(directory, 'registry.json');
        const registry = new SessionRegistry({ lead: LEAD, members: [{ sessionId: MEMBER }] }, { file: legacy });
        await registry.save();

        const store = await GroupsStore.load(join(directory, 'groups.json'), { legacyFile: legacy });
        assert.equal(store.list().length, 1);
        const [group] = store.list();
        assert.equal(group.name, '迁移整体');
        assert.equal(group.registry.lead(), LEAD);
        assert.ok(group.registry.get(MEMBER));
        assert.equal(group.migrated, true, '迁移组必须带标记，重启后才不会和新整体抢旧工单');

        // 迁移结果必须立刻落盘：同一个 id 在下次加载时原样回来。
        const saved = JSON.parse(await readFile(join(directory, 'groups.json'), 'utf8'));
        assert.equal(saved.groups[0].id, group.id);
        const reloaded = await GroupsStore.load(join(directory, 'groups.json'), { legacyFile: legacy });
        assert.equal(reloaded.list()[0].id, group.id);
        assert.equal(reloaded.list()[0].migrated, true);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('旧 groups.json 没有 migrated 字段：按旧名单指纹补标记并落盘', async () => {
    const directory = await scratch();
    try {
        const legacy = join(directory, 'registry.json');
        const registry = new SessionRegistry({ lead: LEAD, members: [{ sessionId: MEMBER }] }, { file: legacy });
        await registry.save();

        const file = join(directory, 'groups.json');
        const member = sessionId => ({ sessionId, label: sessionId, roleClass: 'assistant', tools: [] });
        await writeFile(file, JSON.stringify({
            version: 2,
            groups: [
                { id: 'g-new', name: '团队 A', lead: 'session-other', members: [member('session-x')] },
                { id: 'g-old', name: '迁移整体', lead: LEAD, members: [member(MEMBER)] }
            ]
        }), 'utf8');

        const store = await GroupsStore.load(file, { legacyFile: legacy });
        assert.equal(store.get('g-old').migrated, true);
        assert.equal(store.get('g-new').migrated, false);

        const persisted = JSON.parse(await readFile(file, 'utf8'));
        assert.equal(persisted.groups.find(group => group.id === 'g-old').migrated, true);
        assert.equal(persisted.groups.find(group => group.id === 'g-new').migrated, false);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('损坏的整体文件宁可报错，也不静默清空名单', async () => {
    const directory = await scratch();
    try {
        await mkdir(directory, { recursive: true });
        const file = join(directory, 'groups.json');
        await writeFile(file, '{ 这不是 json', 'utf8');
        await assert.rejects(() => GroupsStore.load(file), /GROUP_FILE_CORRUPT/);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
