/**
 * 会话注册表：以 sessionId 寻址的“协调体”成员名单。
 * 与原生 Team 无关——成员可以是任意既有会话，不要求存在父子血缘。
 */
import { readFile, writeFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';

/** 成员角色类别；能力档按类别判定，具体工具白名单由调用方给出。 */
export const ROLE_CLASSES = Object.freeze(['assistant', 'persona', 'reviewer', 'custom']);
const ID_PATTERN = /^[A-Za-z0-9_.:@-]{1,128}$/;
const LABEL_PATTERN = /^[\p{L}\p{N}_.\- ]{1,64}$/u;
const TOOL_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;
const VERSION = 1;

/** 只接受普通对象的字段读取，拒绝原型污染键。 */
export function plainRecord(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`REGISTRY_INVALID_${label}`);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error(`REGISTRY_INVALID_${label}`);
    if (Object.keys(value).some(key => key === '__proto__' || key === 'constructor' || key === 'prototype')) {
        throw new Error(`REGISTRY_INVALID_${label}`);
    }
    return value;
}

/** 规范化一个成员条目：只保留已知字段，逐项校验。 */
export function normalizeMember(raw) {
    const value = plainRecord(raw, 'MEMBER');
    const sessionId = value.sessionId;
    if (typeof sessionId !== 'string' || !ID_PATTERN.test(sessionId)) throw new Error('REGISTRY_INVALID_SESSION_ID');
    const label = value.label === undefined ? sessionId : value.label;
    if (typeof label !== 'string' || !LABEL_PATTERN.test(label)) throw new Error('REGISTRY_INVALID_LABEL');
    const roleClass = value.roleClass === undefined ? 'assistant' : value.roleClass;
    if (!ROLE_CLASSES.includes(roleClass)) throw new Error('REGISTRY_INVALID_ROLE_CLASS');
    const tools = value.tools === undefined ? [] : value.tools;
    if (!Array.isArray(tools) || tools.length > 64) throw new Error('REGISTRY_INVALID_TOOLS');
    const seen = new Set();
    for (const tool of tools) {
        if (typeof tool !== 'string' || !TOOL_PATTERN.test(tool)) throw new Error('REGISTRY_INVALID_TOOLS');
        if (seen.has(tool)) throw new Error('REGISTRY_DUPLICATE_TOOL');
        seen.add(tool);
    }
    return Object.freeze({ sessionId, label, roleClass, tools: Object.freeze([...seen]) });
}

/** 规范化整份配置：恰好一个主会话，成员 id 唯一。 */
export function normalizeConfig(raw) {
    const value = plainRecord(raw, 'CONFIG');
    if (value.lead === undefined) throw new Error('REGISTRY_MISSING_LEAD');
    if (typeof value.lead !== 'string' || !ID_PATTERN.test(value.lead)) throw new Error('REGISTRY_INVALID_SESSION_ID');
    const members = value.members === undefined ? [] : value.members;
    if (!Array.isArray(members) || members.length > 32) throw new Error('REGISTRY_INVALID_MEMBERS');
    const normalized = members.map(normalizeMember);
    const ids = new Set([value.lead]);
    for (const member of normalized) {
        if (ids.has(member.sessionId)) throw new Error('REGISTRY_DUPLICATE_SESSION_ID');
        ids.add(member.sessionId);
    }
    return Object.freeze({ version: VERSION, lead: value.lead, members: Object.freeze(normalized) });
}

/** 由配置派生出的稳定摘要，用于确认“同一份名单”而不是同一文件。 */
export function fingerprint(config) {
    const text = JSON.stringify({
        lead: config.lead,
        members: config.members.map(member => [member.sessionId, member.roleClass, member.tools.join(',')])
    });
    return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/**
 * 注册表：内存态 + 可选磁盘持久化（原子替换）。
 * 写盘失败不会改变内存态，避免“以为加上了其实没存”。
 */
export class SessionRegistry {
    #file;
    #lead;
    #members = new Map();
    #savedFingerprint = null;

    constructor(config, { file, savedFromDisk = false } = {}) {
        const normalized = normalizeConfig(config);
        this.#file = file === undefined ? null : file;
        this.#lead = normalized.lead;
        for (const member of normalized.members) this.#members.set(member.sessionId, member);
        // 新建的内存名单不算已落盘；只有 load() 读进来的才是。
        this.#savedFingerprint = savedFromDisk ? fingerprint(this.#config()) : null;
    }

    /** 从磁盘读取；文件缺失视为空名单而不是错误。 */
    static async load(file) {
        let text;
        try {
            text = await readFile(file, 'utf8');
        } catch (error) {
            if (error && error.code === 'ENOENT') throw new Error('REGISTRY_FILE_MISSING');
            throw error;
        }
        let parsed;
        try {
            parsed = JSON.parse(text);
        } catch {
            throw new Error('REGISTRY_FILE_CORRUPT');
        }
        return new SessionRegistry(parsed, { file, savedFromDisk: true });
    }

    #config() {
        return { version: VERSION, lead: this.#lead, members: [...this.#members.values()] };
    }

    snapshot() {
        const config = this.#config();
        return Object.freeze({
            lead: config.lead,
            members: Object.freeze(config.members.map(member => ({ ...member }))),
            fingerprint: fingerprint(config),
            saved: this.#savedFingerprint === fingerprint(config)
        });
    }

    lead() {
        return this.#lead;
    }

    /** 是否配置了落盘文件；没有文件时调用方不应期待持久化。 */
    persistent() {
        return this.#file !== null;
    }

    isLead(sessionId) {
        return sessionId === this.#lead;
    }

    get(sessionId) {
        return this.#members.get(sessionId);
    }

    list() {
        return [...this.#members.values()];
    }

    /** 新增成员；已存在则报错而不是静默覆盖。 */
    add(raw) {
        const member = normalizeMember(raw);
        if (member.sessionId === this.#lead) throw new Error('REGISTRY_LEAD_CANNOT_BE_MEMBER');
        if (this.#members.has(member.sessionId)) throw new Error('REGISTRY_DUPLICATE_SESSION_ID');
        if (this.#members.size >= 32) throw new Error('REGISTRY_TOO_MANY_MEMBERS');
        this.#members.set(member.sessionId, member);
        return member;
    }

    /** 移除成员；不存在则报错，避免掩盖写错 id。 */
    remove(sessionId) {
        if (!this.#members.has(sessionId)) throw new Error('REGISTRY_UNKNOWN_MEMBER');
        this.#members.delete(sessionId);
        return true;
    }

    /**
     * 全量替换成员，保持注册表对象本身不变——协调器持有的是同一个引用，
     * 这样才能让“移除成员后 guard 立刻失效”不依赖重新构造协调器。
     * 先完整校验再替换：任何一条非法都不会留下半份名单。
     */
    replaceMembers(rawMembers) {
        if (!Array.isArray(rawMembers)) throw new Error('REGISTRY_INVALID_MEMBERS');
        const normalized = rawMembers.map(normalizeMember);
        const ids = new Set([this.#lead]);
        for (const member of normalized) {
            if (ids.has(member.sessionId)) throw new Error('REGISTRY_DUPLICATE_SESSION_ID');
            ids.add(member.sessionId);
        }
        this.#members = new Map(normalized.map(member => [member.sessionId, member]));
        return this.list();
    }

    /** 换主会话；原主会话默认降级为移除（不自动变成成员）。 */
    setLead(sessionId) {
        if (typeof sessionId !== 'string' || !ID_PATTERN.test(sessionId)) throw new Error('REGISTRY_INVALID_SESSION_ID');
        this.#members.delete(sessionId);
        this.#lead = sessionId;
        return this.#lead;
    }

    /** 原子落盘：先写临时文件再改名，避免半截 JSON。 */
    async save() {
        if (this.#file === null) throw new Error('REGISTRY_NO_FILE');
        const config = this.#config();
        const text = `${JSON.stringify(config, null, 2)}\n`;
        const temporary = `${this.#file}.${process.pid}.tmp`;
        await writeFile(temporary, text, 'utf8');
        await rename(temporary, this.#file);
        this.#savedFingerprint = fingerprint(config);
        return this.#savedFingerprint;
    }
}
