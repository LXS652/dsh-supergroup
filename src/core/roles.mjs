/**
 * 角色与工具策略：角色只表达“分工不同”，不表达等级高低。
 * 所有成员同级；差别只在“它需要哪些工具”，以及“哪些跨会话通道必须收掉”。
 *
 * 关键约束（用户决策 3）：子会话只能经主会话交换请求与结果。
 * 因此成员一律禁用“跨会话直发/派工/委派”类工具；它自己的业务工具照常保留。
 */

/** 跨会话通道：只有主会话（协调者）可以使用，成员一律禁用。 */
export const CROSS_SESSION_TOOLS = Object.freeze([
    'send_message',
    'spawn_teammate',
    'subagent',
    'subagent_fork',
    'ms_dispatch',
    'ms_enqueue',
    'ms_control',
    'ms_spawn',
    'ms_retire'
]);

/** 角色预设：只放“这类工作额外需要收掉的工具”，默认不限制业务工具。 */
export const ROLE_PRESETS = Object.freeze({
    assistant: Object.freeze({ deny: Object.freeze([]) }),
    persona: Object.freeze({ deny: Object.freeze([]) }),
    reviewer: Object.freeze({ deny: Object.freeze([]) }),
    custom: Object.freeze({ deny: Object.freeze([]) })
});

/**
 * 为一个成员算出工具策略：
 * - allow 为 null 表示“不动它原有的业务工具”；
 * - allow 为数组表示“白名单模式”，只允许这些（工具名写错就会当场拒绝，而不是静默放行）；
 * - deny 恒含跨会话通道，成员之间因此没有直连路径。
 */
export function policyFor(member, { isLead = false } = {}) {
    if (!member || typeof member !== 'object') throw new Error('POLICY_INVALID_MEMBER');
    if (isLead) {
        return Object.freeze({ sessionId: member.sessionId, role: 'lead', allow: null, deny: Object.freeze([]) });
    }
    const preset = ROLE_PRESETS[member.roleClass];
    if (!preset) throw new Error('POLICY_UNKNOWN_ROLE');
    const deny = new Set(CROSS_SESSION_TOOLS);
    for (const name of preset.deny) deny.add(name);
    const allow = Array.isArray(member.tools) && member.tools.length > 0 ? [...member.tools] : null;
    return Object.freeze({
        sessionId: member.sessionId,
        role: member.roleClass,
        allow: allow === null ? null : Object.freeze(allow),
        deny: Object.freeze([...deny])
    });
}

/** 判定某个工具在该策略下是否可用；返回 {allowed, reason}，便于把拒绝理由写进证据。 */
export function checkToolAllowed(policy, toolName) {
    if (!policy || typeof policy !== 'object') throw new Error('POLICY_INVALID_POLICY');
    if (typeof toolName !== 'string' || toolName.length === 0) throw new Error('POLICY_INVALID_TOOL');
    if (policy.deny.includes(toolName)) return { allowed: false, reason: 'cross-session channel is coordinator-only' };
    if (policy.allow !== null && !policy.allow.includes(toolName)) {
        return { allowed: false, reason: 'not in this member allow-list' };
    }
    return { allowed: true, reason: null };
}

/** 一次性算出整份名单的策略表，便于 guard 按 sessionId 查表。 */
export function policiesFor(registry) {
    const table = new Map();
    const leadId = registry.lead();
    table.set(leadId, policyFor({ sessionId: leadId }, { isLead: true }));
    for (const member of registry.list()) table.set(member.sessionId, policyFor(member));
    return table;
}
