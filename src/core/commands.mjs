/**
 * 成员增删的命令层：把“加人/减人/看名单/换主会话”收敛成一条窄命令，
 * 每次动作都落一条审计记录（谁、何时、对哪个 sessionId、结果如何）。
 * 这里不碰宿主：由插件把工具/斜杠命令转成 runCommand 调用。
 */
const VERBS = Object.freeze(['add', 'remove', 'list', 'show', 'lead']);

/** 解析一条命令：只接受 “动词 + 可选 sessionId + 可选角色”，多余参数一律拒绝。 */
export function parseCommand(input) {
    if (typeof input !== 'string' || input.trim().length === 0) throw new Error('COMMAND_EMPTY');
    const parts = input.trim().split(/\s+/);
    const verb = parts[0];
    if (!VERBS.includes(verb)) throw new Error('COMMAND_UNKNOWN_VERB');
    const args = { sessionId: null, roleClass: null, label: null };
    if (verb === 'add' || verb === 'remove' || verb === 'lead') {
        if (parts.length < 2) throw new Error('COMMAND_MISSING_SESSION');
        args.sessionId = parts[1];
    }
    if (verb === 'add') {
        if (parts[2] !== undefined) args.roleClass = parts[2];
        if (parts[3] !== undefined) args.label = parts.slice(3).join(' ');
    }
    if (verb === 'show') {
        if (parts.length >= 2) args.sessionId = parts[1];
    }
    const maxParts = verb === 'add' ? Number.POSITIVE_INFINITY : verb === 'list' ? 1 : 2;
    if (parts.length > maxParts) throw new Error('COMMAND_TOO_MANY_ARGUMENTS');
    return { verb, args };
}

/** 执行命令并返回结构化结果；失败也返回 ok:false，不把异常抛给调用方。 */
export async function runCommand(registry, input, { at = () => new Date().toISOString() } = {}) {
    const audit = { at: at(), input, ok: false, reason: null, data: null };
    let parsed;
    try {
        parsed = parseCommand(input);
    } catch (error) {
        audit.reason = error.message;
        return audit;
    }
    try {
        if (parsed.verb === 'list') {
            audit.data = {
                lead: registry.lead(),
                members: registry.list().map(member => ({
                    sessionId: member.sessionId,
                    label: member.label,
                    roleClass: member.roleClass,
                    tools: [...member.tools]
                }))
            };
            audit.ok = true;
            return audit;
        }
        if (parsed.verb === 'show') {
            const sessionId = parsed.args.sessionId;
            if (sessionId === null) {
                audit.data = registry.snapshot();
            } else if (registry.isLead(sessionId)) {
                audit.data = { sessionId, role: 'lead' };
            } else {
                const member = registry.get(sessionId);
                if (!member) throw new Error('COMMAND_UNKNOWN_MEMBER');
                audit.data = { ...member, tools: [...member.tools] };
            }
            audit.ok = true;
            return audit;
        }
        if (parsed.verb === 'add') {
            const member = registry.add({
                sessionId: parsed.args.sessionId,
                roleClass: parsed.args.roleClass === null ? 'assistant' : parsed.args.roleClass,
                label: parsed.args.label === null ? parsed.args.sessionId : parsed.args.label
            });
            audit.data = { ...member, tools: [...member.tools] };
            audit.ok = true;
            return audit;
        }
        if (parsed.verb === 'remove') {
            registry.remove(parsed.args.sessionId);
            audit.data = { sessionId: parsed.args.sessionId };
            audit.ok = true;
            return audit;
        }
        // lead：换主会话；原主会话若仍是成员会被移出（注册表已保证主会话不在成员表里）。
        const lead = registry.setLead(parsed.args.sessionId);
        audit.data = { lead };
        audit.ok = true;
        return audit;
    } catch (error) {
        audit.reason = error instanceof Error ? error.message : String(error);
        return audit;
    } finally {
        // 只有真正改变了名单、且注册表配置了文件时才写盘；读写命令不产生副作用。
        const mutating = parsed.verb === 'add' || parsed.verb === 'remove' || parsed.verb === 'lead';
        if (audit.ok && mutating && registry.persistent()) {
            try {
                await registry.save();
            } catch (error) {
                audit.ok = false;
                audit.reason = `COMMAND_PERSIST_FAILED: ${error instanceof Error ? error.message : String(error)}`;
            }
        }
    }
}
