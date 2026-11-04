/** 角色与工具策略单测：成员同级、跨会话通道只归主会话、白名单不静默放行。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CROSS_SESSION_TOOLS, policyFor, checkToolAllowed, policiesFor } from '../src/core/roles.mjs';
import { SessionRegistry } from '../src/core/registry.mjs';

test('主会话可用跨会话通道，成员一律不可用', () => {
    const lead = policyFor({ sessionId: 'session-lead' }, { isLead: true });
    assert.equal(lead.allow, null);
    assert.equal(checkToolAllowed(lead, 'send_message').allowed, true);

    for (const roleClass of ['assistant', 'persona', 'reviewer', 'custom']) {
        const member = policyFor({ sessionId: 's', roleClass, tools: [] });
        for (const toolName of CROSS_SESSION_TOOLS) {
            const verdict = checkToolAllowed(member, toolName);
            assert.equal(verdict.allowed, false, `${roleClass} 不应能用 ${toolName}`);
            assert.match(verdict.reason, /coordinator-only/);
        }
    }
});

test('同级：不同角色之间没有等级差，业务工具默认照旧', () => {
    const assistant = policyFor({ sessionId: 'a', roleClass: 'assistant', tools: [] });
    const persona = policyFor({ sessionId: 'b', roleClass: 'persona', tools: [] });
    assert.equal(assistant.allow, null);
    assert.equal(persona.allow, null);
    assert.deepEqual([...assistant.deny], [...persona.deny], '两种角色的禁用集应当相同（只有分工不同）');
    assert.equal(checkToolAllowed(assistant, 'read_file').allowed, true);
    assert.equal(checkToolAllowed(persona, 'send_mail').allowed, true);
});

test('白名单模式：名单外的工具被拒，并给出可读理由', () => {
    const strict = policyFor({ sessionId: 'c', roleClass: 'reviewer', tools: ['read_file', 'grep'] });
    assert.deepEqual([...strict.allow], ['read_file', 'grep']);
    assert.equal(checkToolAllowed(strict, 'read_file').allowed, true);
    const denied = checkToolAllowed(strict, 'write_file');
    assert.equal(denied.allowed, false);
    assert.match(denied.reason, /allow-list/);
});

test('策略表覆盖主会话与全部成员，未知角色当场报错', () => {
    const registry = new SessionRegistry({
        lead: 'session-lead',
        members: [
            { sessionId: 'session-a', roleClass: 'assistant' },
            { sessionId: 'persona-mailbox', label: '人设邮箱', roleClass: 'persona' }
        ]
    });
    const table = policiesFor(registry);
    assert.equal(table.size, 3);
    assert.equal(table.get('session-lead').role, 'lead');
    assert.equal(table.get('persona-mailbox').role, 'persona');
    assert.throws(() => policyFor({ sessionId: 'x', roleClass: 'root' }), /UNKNOWN_ROLE/);
});
