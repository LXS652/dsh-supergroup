/**
 * 整体（group）：一个主会话 + 若干执行会话，组成一个可派工的协作单元。
 *
 * 与旧 registry 的区别只在形状：旧版全局只有一个主会话，新版是“多个整体”，
 * 每个整体各自有自己的主会话与成员；同一个人可以同时属于多个整体。
 * 成员合法性仍然复用 SessionRegistry 的校验，不另写一套。
 */
import { readFile, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { SessionRegistry, plainRecord } from './registry.mjs';

const VERSION = 2;
const NAME_PATTERN = /^[\p{L}\p{N}_.\- ·]{1,40}$/u;
const MAX_GROUPS = 50;
/** 一个整体的执行会话上限；创建与后续改成员共用同一口径。 */
const MAX_GROUP_MEMBERS = 8;

/** 校验整体名：允许中英文、数字与少量分隔符，拒绝换行与控制字符。 */
export function normalizeGroupName(raw) {
    if (typeof raw !== 'string') throw new Error('GROUP_INVALID_NAME');
    const name = raw.trim();
    if (!NAME_PATTERN.test(name)) throw new Error('GROUP_INVALID_NAME');
    return name;
}

/** 一个整体 = id + 名字 + 一份成员名单（名单里已经有主会话与执行会话）。 */
export class Group {
    #registry;

    constructor({ id, name, registry, migrated = false }) {
        if (typeof id !== 'string' || id.length === 0) throw new Error('GROUP_INVALID_ID');
        this.id = id;
        this.name = normalizeGroupName(name);
        this.#registry = registry;
        // 只有从旧版 registry.json 迁来的整体才认领“还没有 groupId”的历史工单。
        // 该标记必须落盘，否则重启后 id 会变、标记会丢，恢复链就断了。
        this.migrated = migrated === true;
    }

    get registry() {
        return this.#registry;
    }

    toJSON() {
        const snapshot = this.#registry.snapshot();
        return {
            id: this.id,
            name: this.name,
            lead: snapshot.lead,
            migrated: this.migrated,
            members: snapshot.members.map(member => ({
                sessionId: member.sessionId,
                label: member.label,
                roleClass: member.roleClass,
                tools: [...member.tools]
            }))
        };
    }
}

/**
 * 整体仓库：内存态 + 可选落盘（原子替换）。
 * 落盘格式 {version, groups:[...]}；读入时逐个重建 SessionRegistry，非法数据直接报错而不是默默修。
 */
export class GroupsStore {
    #file;
    #groups = new Map();

    constructor({ file = null } = {}) {
        this.#file = file;
    }

    get persistent() {
        return this.#file !== null;
    }

    list() {
        return [...this.#groups.values()];
    }

    get(groupId) {
        return this.#groups.get(groupId);
    }

    /** 按名字找；重名在建的时候就被拒绝，所以这里取到的就是唯一一条。 */
    findByName(name) {
        const target = normalizeGroupName(name);
        return this.list().find(group => group.name === target);
    }

    /** 这个会话在哪些整体里当主会话。 */
    groupsLedBy(sessionId) {
        return this.list().filter(group => group.registry.isLead(sessionId));
    }

    /** 这个会话在哪些整体里当执行会话。 */
    groupsWithMember(sessionId) {
        return this.list().filter(group => group.registry.get(sessionId) !== undefined);
    }

    /**
     * 建一个整体。规则（用户 2026-11-04 定的）：
     * - 同一整体内，被选为主会话的会话不能再作为执行会话；
     * - 跨整体不受限，同一个会话可以在别的整体里当主会话或执行会话。
     */
    create({ name, lead, members = [] }) {
        const normalizedName = normalizeGroupName(name);
        if (this.#groups.size >= MAX_GROUPS) throw new Error('GROUP_TOO_MANY');
        if (this.findByName(normalizedName)) throw new Error('GROUP_NAME_TAKEN');
        if (typeof lead !== 'string' || lead.length === 0) throw new Error('GROUP_MISSING_LEAD');
        const list = Array.isArray(members) ? members : [];
        if (list.length === 0) throw new Error('GROUP_MISSING_MEMBERS');
        if (list.length > MAX_GROUP_MEMBERS) throw new Error('GROUP_TOO_MANY_MEMBERS');
        if (list.includes(lead)) throw new Error('GROUP_LEAD_CANNOT_BE_MEMBER');
        // SessionRegistry 会再校验一遍主会话/成员/重复 id，这里不重复实现。
        const registry = new SessionRegistry({
            lead,
            members: list.map(sessionId => (typeof sessionId === 'string' ? { sessionId } : sessionId))
        });
        const group = new Group({ id: `g-${randomUUID().slice(0, 8)}`, name: normalizedName, registry });
        this.#groups.set(group.id, group);
        return group;
    }

    /**
     * 改名：只改整体登记里的名字并落盘。
     * 重名检查与创建共用同一条规则；写盘失败把内存名字恢复，避免界面和磁盘各说各话。
     */
    async rename(groupId, rawName) {
        if (typeof groupId !== 'string' || groupId.length === 0) throw new Error('GROUP_INVALID_ID');
        const group = this.#groups.get(groupId);
        if (group === undefined) throw new Error('GROUP_NOT_FOUND');
        const name = normalizeGroupName(rawName);
        const existing = this.findByName(name);
        if (existing !== undefined && existing.id !== groupId) throw new Error('GROUP_NAME_TAKEN');
        const previous = group.name;
        group.name = name;
        try {
            if (this.persistent) await this.save();
        } catch (error) {
            group.name = previous;
            throw error;
        }
        return group;
    }

    /**
     * 全量替换成员：只动名单，不碰会话、历史或账本。
     * - members 是 sessionId 数组（也接受 {sessionId,...} 对象）；
     * - 旧成员的 label/roleClass/tools 原样保留，新成员按 registry 的默认值补齐；
     * - 先在旧的 SessionRegistry 上校验，全部通过后才替换，写盘失败则回滚。
     */
    async updateMembers(groupId, members) {
        if (typeof groupId !== 'string' || groupId.length === 0) throw new Error('GROUP_INVALID_ID');
        const group = this.#groups.get(groupId);
        if (group === undefined) throw new Error('GROUP_NOT_FOUND');
        if (!Array.isArray(members) || members.length === 0) throw new Error('GROUP_MISSING_MEMBERS');
        if (members.length > MAX_GROUP_MEMBERS) throw new Error('GROUP_TOO_MANY_MEMBERS');
        const previous = group.registry.list().map(member => ({
            sessionId: member.sessionId,
            label: member.label,
            roleClass: member.roleClass,
            tools: [...member.tools]
        }));
        const byId = new Map(previous.map(member => [member.sessionId, member]));
        const next = members.map((raw) => {
            const sessionId = typeof raw === 'string' ? raw : (raw && raw.sessionId);
            if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('GROUP_INVALID_MEMBER');
            const base = byId.get(sessionId) ?? { sessionId };
            if (raw === null || typeof raw !== 'object') return base;
            // 对象入参带 label 就落盘；缺失或空串时退回 sessionId，保持旧行为兼容。
            const label = typeof raw.label === 'string' && raw.label.trim() !== '' ? raw.label : sessionId;
            return { ...base, ...raw, sessionId, label };
        });
        const lead = group.registry.lead();
        if (next.some(member => member.sessionId === lead)) throw new Error('GROUP_LEAD_CANNOT_BE_MEMBER');
        const seen = new Set();
        for (const member of next) {
            if (seen.has(member.sessionId)) throw new Error('REGISTRY_DUPLICATE_SESSION_ID');
            seen.add(member.sessionId);
        }
        // replaceMembers 会先完整校验再一次性替换，失败时旧名单保持不动。
        group.registry.replaceMembers(next);
        try {
            if (this.persistent) await this.save();
        } catch (error) {
            group.registry.replaceMembers(previous);
            throw error;
        }
        return group;
    }

    /**
     * 解散：只把整体从登记表里删掉并落盘，不碰任何会话、历史或账本。
     * 先改内存再写盘；写盘失败必须把内存恢复，避免“界面没了、文件里还在”。
     */
    async remove(groupId) {
        if (typeof groupId !== 'string' || groupId.length === 0) throw new Error('GROUP_INVALID_ID');
        const group = this.#groups.get(groupId);
        if (group === undefined) throw new Error('GROUP_NOT_FOUND');
        this.#groups.delete(groupId);
        try {
            if (this.persistent) await this.save();
        } catch (error) {
            this.#groups.set(groupId, group);
            throw error;
        }
        return group;
    }

    /** 原子落盘：先写临时文件再改名，避免半个 JSON 留在盘上。 */
    async save() {
        if (this.#file === null) throw new Error('GROUP_NO_FILE');
        const payload = { version: VERSION, groups: this.list().map(group => group.toJSON()) };
        const text = `${JSON.stringify(payload, null, 2)}\n`;
        const temporary = `${this.#file}.${process.pid}.tmp`;
        await writeFile(temporary, text, 'utf8');
        await rename(temporary, this.#file);
        return payload.groups.length;
    }

    /**
     * 读盘。文件不存在不算错误：
     * - 有旧版 registry.json 就迁成一个整体（默认名「迁移整体」），保留原来的主/成员；
     * - 两个都没有，就是空仓库，等用户在面板里创建。
     */
    static async load(file, { legacyFile = null, migrationName = '迁移整体' } = {}) {
        const store = new GroupsStore({ file });
        let text = null;
        try {
            text = await readFile(file, 'utf8');
        } catch (error) {
            if (!error || error.code !== 'ENOENT') throw error;
        }
        if (text !== null) {
            let parsed;
            try {
                parsed = JSON.parse(text);
            } catch {
                throw new Error('GROUP_FILE_CORRUPT');
            }
            const value = plainRecord(parsed, 'GROUPS');
            if (!Array.isArray(value.groups)) throw new Error('GROUP_FILE_CORRUPT');
            for (const raw of value.groups) {
                const item = plainRecord(raw, 'GROUP');
                const registry = new SessionRegistry({ lead: item.lead, members: item.members }, { savedFromDisk: true });
                const group = new Group({ id: item.id, name: item.name, registry, migrated: item.migrated === true });
                store.#groups.set(group.id, group);
            }
            // 旧版 groups.json 没有 migrated 字段：用旧 registry 的指纹认出迁移组，
            // 补上标记并落盘，避免它和新整体抢同一批 groupId=null 的历史工单。
            if (legacyFile !== null && !store.list().some(group => group.migrated)) {
                try {
                    const legacy = await SessionRegistry.load(legacyFile);
                    const legacyFingerprint = legacy.snapshot().fingerprint;
                    const migrated = store.list().find(group => group.registry.snapshot().fingerprint === legacyFingerprint);
                    if (migrated !== undefined) {
                        migrated.migrated = true;
                        if (store.persistent) await store.save();
                    }
                } catch (error) {
                    if (!(error && error.message === 'REGISTRY_FILE_MISSING')) throw error;
                }
            }
            return store;
        }
        if (legacyFile !== null) {
            try {
                const legacy = await SessionRegistry.load(legacyFile);
                const group = new Group({
                    id: `g-${randomUUID().slice(0, 8)}`,
                    name: migrationName,
                    registry: legacy,
                    migrated: true
                });
                store.#groups.set(group.id, group);
                // 迁移结果必须立刻落盘：否则下次启动会重新生成一个 id，
                // 旧账本里记着的 groupId 就对不上了。
                if (store.persistent) await store.save();
                return store;
            } catch (error) {
                // 旧文件坏了不能假装没看见：报出来，让用户决定怎么处理。
                if (error && error.message === 'REGISTRY_FILE_MISSING') return store;
                throw error;
            }
        }
        return store;
    }
}
