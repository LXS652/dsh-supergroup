/**
 * dsh-supergroup · 多整体协作（v1.0.0）
 *
 * 一个「整体」= 一个主会话 + 若干执行会话，持久落盘、可增删会话、可跨重启。
 * 与上一版的区别：上一版全局只有一个主会话，这一版是多个整体并存，
 * 同一个会话可以在不同整体里担任不同角色。
 *
 * 协调方式仍是“按 sessionId 寻址”——不依赖原生 Team，也不要求执行会话装本插件。
 */
import { fileURLToPath } from 'node:url';
import { appendFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { Coordinator } from './core/coordinator.mjs';
import { GroupsStore } from './core/groups.mjs';
import { TaskLedger } from './core/ledger.mjs';
import { DeliveryChannel, ResultTracker } from './core/delivery.mjs';
import { checkToolAllowed, policiesFor } from './core/roles.mjs';
import { runCommand } from './core/commands.mjs';

export const name = 'dsh-supergroup';
export const inject = ['tools', 'commands'];

const DEFAULT_GROUPS = fileURLToPath(new URL('../data/groups.json', import.meta.url));
const DEFAULT_REGISTRY = fileURLToPath(new URL('../data/registry.json', import.meta.url));
const DEFAULT_LEDGER = fileURLToPath(new URL('../data/tasks.jsonl', import.meta.url));
const DEFAULT_REPORT_DIR = fileURLToPath(new URL('../probe2/', import.meta.url));

/** 写一份人能读的 JSON 报告；失败不抛，报告不是主流程。 */
async function writeReport(directory, payload) {
    try {
        await mkdir(directory, { recursive: true });
        const file = join(directory, 'latest.json');
        await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
        return file;
    } catch {
        // 报告失败不影响协调
        return null;
    }
}

/** 统一的工具返回形状：status 给策略层看，summary 给模型看，data 给复核用。 */
function reply(status, summary, data) {
    return { status, summary, data: data === null ? '' : JSON.stringify(data) };
}

function toolDefinition(toolName, description, hint) {
    return {
        name: toolName,
        description,
        parameters: {
            type: 'object',
            properties: { request: { type: 'string', description: hint } },
            required: ['request'],
            additionalProperties: false
        },
        output: {
            schema: {
                type: 'object',
                properties: { status: { type: 'string' }, summary: { type: 'string' }, data: { type: 'string' } },
                required: ['status', 'summary', 'data'],
                additionalProperties: false
            },
            render: (_args, value) => {
                const data = typeof value.data === 'string' ? value.data : '';
                const body = data === '' ? '' : `\n${data.length > 4000 ? `${data.slice(0, 4000)}…（已截断）` : data}`;
                return [{ type: 'text', text: `${value.status}: ${value.summary}${body}` }];
            }
        }
    };
}

/** 从 JSON 文本解析参数；空串直接报错，避免“缺参数”变成“没反应”。 */
function parseJson(raw, hint) {
    let payload;
    try {
        payload = JSON.parse(typeof raw === 'string' ? raw : '');
    } catch {
        throw new Error(`参数必须是 JSON：${hint}`);
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error(`参数必须是 JSON 对象：${hint}`);
    return payload;
}

export function apply(ctx, config) {
    // 整体名单与旧名单放同一目录：显式给了 groupsFile 就用它，否则跟着 registryFile 走，
    // 这样测试与真实数据各自隔离，不会互相写到对方文件里。
    const groupsFile = config && typeof config.groupsFile === 'string'
        ? config.groupsFile
        : (config && typeof config.registryFile === 'string'
            ? join(dirname(config.registryFile), 'groups.json')
            : DEFAULT_GROUPS);
    const legacyFile = config && typeof config.registryFile === 'string' ? config.registryFile : DEFAULT_REGISTRY;
    const ledgerFile = config && typeof config.ledgerFile === 'string' ? config.ledgerFile : DEFAULT_LEDGER;
    // 事件观测日志和账本放同一目录；测试显式传 eventsLogFile 隔离。
    const eventLogFile = config && typeof config.eventsLogFile === 'string'
        ? config.eventsLogFile
        : join(dirname(ledgerFile), 'session-events.log');
    const EVENT_LOG_LIMIT = 256 * 1024;
    // 启动期 sessionController 可能晚于插件装载；最多等 50×200ms（约 10s），
    // 测试可缩小次数/间隔，但上限仍被夹在 50 次、200ms，避免启动被无限拖住。
    const STARTUP_RECONCILE_ATTEMPTS = config && Number.isSafeInteger(config.startupReconcileAttempts)
        ? Math.min(Math.max(config.startupReconcileAttempts, 1), 50)
        : 50;
    const STARTUP_RECONCILE_INTERVAL_MS = config && Number.isSafeInteger(config.startupReconcileIntervalMs)
        ? Math.min(Math.max(config.startupReconcileIntervalMs, 1), 200)
        : 200;
    const eventLog = {
        file: eventLogFile,
        bytes: 0,
        truncated: false,
        error: null
    };
    try {
        if (existsSync(eventLogFile)) eventLog.bytes = statSync(eventLogFile).size;
        if (eventLog.bytes >= EVENT_LOG_LIMIT) eventLog.truncated = true;
    } catch (error) {
        eventLog.error = error instanceof Error ? error.message : String(error);
    }

    /** 只追加紧凑的观测字段，永远不写消息正文；到上限就停止，不删旧行。 */
    function appendEventLog(entry) {
        if (eventLog.truncated) return;
        const line = `${JSON.stringify(entry)}\n`;
        try {
            mkdirSync(dirname(eventLog.file), { recursive: true });
            appendFileSync(eventLog.file, line, 'utf8');
            eventLog.bytes += Buffer.byteLength(line);
            if (eventLog.bytes >= EVENT_LOG_LIMIT) eventLog.truncated = true;
        } catch (error) {
            // 日志写不进去不能拖垮归集；状态里留一次错误，避免每个事件都重试刷屏。
            eventLog.error = error instanceof Error ? error.message : String(error);
            eventLog.truncated = true;
        }
    }

    const safety = ctx.root === undefined ? ctx : ctx.root;
    const safetyTools = typeof safety.get === 'function' ? safety.get('tools') : undefined;

    const state = {
        groups: null,
        coordinators: new Map(),
        channel: null,
        error: null,
        recovery: [],
        observeStats: {
            eventsSeen: 0,
            lastAt: null,
            lastSessionId: null,
            lastType: null,
            lastReconcileError: null,
            lastReconcileReason: null,
            startupReconcile: {
                attempts: 0,
                waitedMs: 0,
                outcome: 'pending',
                settled: [],
                error: null
            }
        },
        eventLog
    };
    const tracker = new ResultTracker();

    /** 延迟初始化：读盘、建协调器、跑一次恢复。工具执行时等它就绪。 */
    const ready = (async () => {
        try {
            state.groups = await GroupsStore.load(groupsFile, { legacyFile, migrationName: '迁移整体' });
            const channel = new DeliveryChannel({
                prompt: async (request, signal) => {
                    // 宿主启动早期 sessionController 可能还没注册好；等一会儿再判失败，
                    // 否则重启后立刻派工会误报 NO_SESSION_CONTROLLER。
                    let controller = ctx.get('sessionController');
                    for (let attempt = 0; attempt < 50; attempt += 1) {
                        if (controller && typeof controller.prompt === 'function') break;
                        await new Promise(resolve => setTimeout(resolve, 200));
                        if (signal !== undefined && signal !== null && signal.aborted) throw new Error('DELIVERY_ABORTED');
                        controller = ctx.get('sessionController');
                    }
                    if (!controller || typeof controller.prompt !== 'function') throw new Error('NO_SESSION_CONTROLLER');
                    return controller.prompt(request, signal);
                }
            });
            const ledger = new TaskLedger({ file: ledgerFile });
            state.channel = channel;
            // 配置里可以预置整体：只在同名整体不存在时创建，重启不会重复建。
            const bootstrapNotes = [];
            if (config && Array.isArray(config.bootstrapGroups)) {
                let created = 0;
                for (const seed of config.bootstrapGroups) {
                    if (seed === null || typeof seed !== 'object' || typeof seed.name !== 'string') continue;
                    if (state.groups.findByName(seed.name) !== undefined) continue;
                    try {
                        state.groups.create({ name: seed.name, lead: seed.lead, members: Array.isArray(seed.members) ? seed.members : [] });
                        created += 1;
                    } catch (error) {
                        // 预置失败不该拖垮插件：记在启动状态里，面板照样能打开。
                        bootstrapNotes.push({ phase: 'bootstrap-group', name: seed.name, error: error instanceof Error ? error.message : String(error) });
                    }
                }
                if (created > 0) await state.groups.save();
            }
            const recovered = [];
            for (const group of state.groups.list()) {
                const coordinator = new Coordinator({
                    registry: group.registry,
                    channel,
                    tracker,
                    ledger,
                    groupId: group.id
                });
                state.coordinators.set(group.id, coordinator);
                // 只有从旧 registry 迁来的整体认领旧账本里没有 groupId 的工单；其它整体不抢。
                const plan = await coordinator.recover({ adoptNullGroup: group.migrated === true });
                for (const item of plan) recovered.push({ groupId: group.id, group: group.name, ...item });
            }
            state.recovery = [...bootstrapNotes, ...recovered];
            // 重启恢复完成后立刻对账一次：delivered 已被 recover 降级成 uncertain，
            // 若历史里已有完整 completed 证据，不必等外部调用 ms2_status 才收敛。
            await reconcileTasks(state.groups.list(), { startup: true });
            if (config && config.startupReport === true) {
                await writeReport(DEFAULT_REPORT_DIR, { phase: 'startup', startupRecovery: recovered, groups: groupsSnapshot() });
            }
        } catch (error) {
            state.error = error instanceof Error ? error.message : String(error);
        }
    })();

    /** 面板/工具共用的整体快照：带上成员可读的标签与任务计数。 */
    function groupsSnapshot(groups = state.groups === null ? [] : state.groups.list()) {
        return groups.map(group => {
            const snapshot = group.registry.snapshot();
            const coordinator = state.coordinators.get(group.id);
            const tasks = coordinator === undefined ? [] : coordinator.tasks();
            return {
                id: group.id,
                name: group.name,
                lead: snapshot.lead,
                members: snapshot.members.map(member => ({ sessionId: member.sessionId, label: member.label, roleClass: member.roleClass })),
                tasks: tasks.length,
                inFlight: tasks.filter(task => task.state === 'delivered' || task.state === 'uncertain').length
            };
        });
    }

    /** 调用者能看到的整体：自己当主会话的，或自己当成员的。 */
    function groupsFor(caller) {
        if (state.groups === null || typeof caller !== 'string') return [];
        return state.groups.list().filter(group => group.registry.isLead(caller) || group.registry.get(caller) !== undefined);
    }

    /**
     * 解散一个整体：只删登记并落盘，绝不碰会话、历史或任务账本。
     * 有在途工单（delivered/uncertain）时拒绝，让主会话先裁决或等对账收敛。
     */
    async function dissolveGroup(caller, groupId) {
        if (state.groups === null) throw new Error('整体尚未加载');
        if (typeof caller !== 'string' || caller === '') throw new Error('无法识别调用会话，不能解散整体');
        if (typeof groupId !== 'string' || groupId === '') throw new Error('用法：/ms2 dissolve <groupId>');
        const group = state.groups.get(groupId);
        if (group === undefined) throw new Error('GROUP_NOT_FOUND: 找不到这个整体');
        if (!group.registry.isLead(caller)) throw new Error('只有该整体主会话能解散自己的整体');
        const coordinator = state.coordinators.get(group.id);
        const pending = coordinator === undefined
            ? []
            : coordinator.tasks().filter(task => task.state === 'delivered' || task.state === 'uncertain');
        const dispatching = coordinator === undefined || typeof coordinator.pendingDispatchIds !== 'function'
            ? []
            : coordinator.pendingDispatchIds();
        if (pending.length > 0 || dispatching.length > 0) {
            const ids = pending.map(task => task.requestId).concat(dispatching).join(', ');
            throw new Error(`GROUP_IN_FLIGHT: 还有在途工单（${ids}）；先用 ms2_resolve 或等对账收敛再解散`);
        }
        const removed = await state.groups.remove(group.id);
        state.coordinators.delete(group.id);
        return removed;
    }

    /**
     * 改名只改登记，不动会话；权限与创建一致，只有该整体 lead 能改。
     * 具体校验（长度/字符集/重名）复用 GroupsStore.rename。
     */
    async function renameGroup(caller, groupId, name) {
        if (state.groups === null) throw new Error('整体尚未加载');
        if (typeof caller !== 'string' || caller === '') throw new Error('无法识别调用会话，不能改名');
        if (typeof groupId !== 'string' || groupId === '') throw new Error('缺少 group');
        const group = state.groups.get(groupId);
        if (group === undefined) throw new Error('GROUP_NOT_FOUND: 找不到这个整体');
        if (!group.registry.isLead(caller)) throw new Error('只有该整体主会话能改名');
        return state.groups.rename(group.id, name);
    }

    /**
     * 全量替换成员。先挡住“移除的成员还有在途工单”，
     * 再交给 GroupsStore 校验/落盘；注册表对象不变，guard 会立即按新名单生效。
     */
    async function updateGroupMembers(caller, groupId, members) {
        if (state.groups === null) throw new Error('整体尚未加载');
        if (typeof caller !== 'string' || caller === '') throw new Error('无法识别调用会话，不能改成员');
        if (typeof groupId !== 'string' || groupId === '') throw new Error('缺少 group');
        const group = state.groups.get(groupId);
        if (group === undefined) throw new Error('GROUP_NOT_FOUND: 找不到这个整体');
        if (!group.registry.isLead(caller)) throw new Error('只有该整体主会话能改成员');
        if (!Array.isArray(members) || members.length === 0) throw new Error('GROUP_MISSING_MEMBERS: members 不能为空');
        if (members.length > 8) throw new Error('GROUP_TOO_MANY_MEMBERS: 一个整体最多 8 个执行会话');
        const nextIds = new Set(members.map((item) => (typeof item === 'string' ? item : item && item.sessionId)));
        if ([...nextIds].some(id => typeof id !== 'string' || id.length === 0)) throw new Error('GROUP_INVALID_MEMBER');
        if ([...nextIds].includes(group.registry.lead())) throw new Error('GROUP_LEAD_CANNOT_BE_MEMBER');
        const removed = group.registry.list()
            .map(member => member.sessionId)
            .filter(sessionId => !nextIds.has(sessionId));
        const coordinator = state.coordinators.get(group.id);
        const blocked = coordinator === undefined
            ? []
            : coordinator.tasks().filter(task =>
                removed.includes(task.sessionId)
                && (task.state === 'delivered' || task.state === 'uncertain'));
        if (blocked.length > 0) {
            const ids = blocked.map(task => task.requestId).join(', ');
            throw new Error(`GROUP_MEMBER_IN_FLIGHT: 被移除成员还有在途工单（${ids}）；先用 ms2_resolve 或等对账收敛再改成员`);
        }
        return state.groups.updateMembers(group.id, members);
    }

    /**
     * 同一会话可能在多个整体里当成员。策略按“更严”合并：
     * allow 取交集（一方不限制就听另一方的），deny 取并集；主会话策略优先。
     * 每次按当前名单现算，不缓存，避免成员被移除后旧策略还在拒人。
     */
    function mergePolicies(first, second) {
        const allow = first.allow === null
            ? second.allow
            : (second.allow === null ? first.allow : first.allow.filter(name => second.allow.includes(name)));
        return Object.freeze({
            sessionId: first.sessionId,
            role: `${first.role}+${second.role}`,
            allow: allow === null ? null : Object.freeze([...allow]),
            deny: Object.freeze([...new Set([...first.deny, ...second.deny])])
        });
    }

    /** 汇总可见整体的策略表；同会话跨整体时取严。 */
    function policiesTable(groups = state.groups === null ? [] : state.groups.list()) {
        const table = new Map();
        for (const group of groups) {
            for (const [sessionId, policy] of policiesFor(group.registry)) {
                const previous = table.get(sessionId);
                if (previous === undefined || policy.role === 'lead') table.set(sessionId, policy);
                else if (previous.role !== 'lead') table.set(sessionId, mergePolicies(previous, policy));
            }
        }
        return table;
    }

    const HISTORY_PAGE_SIZE = 200;
    const HISTORY_MAX_PAGES = 5;

    /** page/follow 的 records 可能已经是事件本身，也可能还包着 {type:'event', event}。 */
    function historyEvents(records) {
        if (!Array.isArray(records)) return [];
        const events = [];
        for (const record of records) {
            const event = record && record.type === 'event' && record.event !== undefined ? record.event : record;
            if (event && typeof event.type === 'string') events.push(event);
        }
        return events;
    }

    /** 只认 rpcId 精确相等；任何“猜下一个回合”的锚定都不做。 */
    function anchorIndex(events, requestId) {
        for (let index = 0; index < events.length; index += 1) {
            const event = events[index];
            if (event !== null && event.type === 'user/message' && event.data && event.data.source && event.data.source.rpcId === requestId) return index;
        }
        return -1;
    }

    /** 真实顺序里 turn/start 可能早于 user/message，也可能在锚点之后。 */
    function turnAt(events, anchor) {
        for (let index = anchor; index < events.length; index += 1) {
            const event = events[index];
            if (event !== null && event.data !== undefined && Number.isSafeInteger(event.data.turn)) return event.data.turn;
        }
        return null;
    }

    /** 冷会话没有 liveProjections 时，用 follow 的首个 snapshot 拿 cursor 和尾部记录。 */
    async function firstSnapshot(controller, sessionId) {
        if (typeof controller.follow !== 'function') return null;
        const abort = new AbortController();
        try {
            for await (const frame of controller.follow({ address: { kind: 'session', sessionId }, maxMessages: HISTORY_PAGE_SIZE }, abort.signal)) {
                if (frame === null || frame === undefined) continue;
                if (frame.type === 'snapshot') return frame;
                if (frame.type === 'event') return { type: 'snapshot', cursor: frame.event && frame.event.seq, records: [frame] };
            }
        } finally {
            abort.abort();
        }
        return null;
    }

    /**
     * 读取一个工单所在会话的历史窗口，从最新向旧翻。
     * 只在“锚点还没找到”或“锚点后连 turn 号都还没出现”时继续翻页；
     * 锚点已找到但没有 turn/end，是回合还没结束，继续往旧翻没有意义。
     */
    async function readTaskHistory(controller, task) {
        let cursor = null;
        let events = [];
        let pages = 0;
        let hasMore = false;
        const live = typeof controller.liveProjections === 'function' ? controller.liveProjections(task.sessionId) : undefined;
        if (live !== null && live !== undefined && Number.isSafeInteger(live.asOfSeq) && live.asOfSeq >= 0) {
            cursor = live.asOfSeq;
        } else {
            const snapshot = await firstSnapshot(controller, task.sessionId);
            if (snapshot === null) throw new Error('NO_SESSION_SNAPSHOT');
            cursor = snapshot.cursor;
            events = historyEvents(snapshot.records);
            pages = 1;
            hasMore = events.length > 0;
        }

        while (pages < HISTORY_MAX_PAGES) {
            const anchor = anchorIndex(events, task.requestId);
            if (anchor >= 0 && turnAt(events, anchor) !== null) break;
            if (pages > 0 && !hasMore) break;
            if (!Number.isSafeInteger(cursor)) break;
            if (typeof controller.page !== 'function') throw new Error('NO_SESSION_HISTORY_PAGE');
            const request = {
                address: { kind: 'session', sessionId: task.sessionId },
                throughSeq: cursor,
                maxMessages: HISTORY_PAGE_SIZE
            };
            if (events.length > 0 && Number.isSafeInteger(events[0].seq)) request.beforeSeq = events[0].seq;
            const page = await controller.page(request, new AbortController().signal);
            pages += 1;
            const older = historyEvents(page && page.records);
            if (older.length === 0) {
                hasMore = false;
                break;
            }
            events = [...older, ...events];
            hasMore = page.hasMore === true;
        }

        const anchor = anchorIndex(events, task.requestId);
        return { events, pages, hasMore, exhausted: anchor < 0 && hasMore === true };
    }

    /**
     * 启动期有界等待历史接口：sessionController 晚注册时轮询，最多 attempts 次。
     * 不无限重试，也不把插件装载拖过约 10 秒。
     */
    async function waitForHistoryController(attempts, intervalMs) {
        const started = Date.now();
        let checks = 0;
        for (let index = 0; index < attempts; index += 1) {
            checks += 1;
            const controller = ctx.get('sessionController');
            if (controller && typeof controller.page === 'function') {
                return { controller, attempts: checks, waitedMs: Date.now() - started };
            }
            if (index < attempts - 1) await new Promise(resolve => setTimeout(resolve, intervalMs));
        }
        return { controller: null, attempts: checks, waitedMs: Date.now() - started };
    }

    /**
     * 历史对账主路径：事件监听收不到别的会话时，把 delivered / uncertain 工单读历史补回来。
     * 只读、不投递；已经结算的工单在协调器里会直接跳过，事件快路径和这里不会重复写账。
     * startup=true 时先有界等待 sessionController，并把这次启动对账的观测写进 startupReconcile。
     */
    async function reconcileTasks(visible, { startup = false } = {}) {
        const stats = state.observeStats;
        let controller;
        if (startup) {
            const waited = await waitForHistoryController(STARTUP_RECONCILE_ATTEMPTS, STARTUP_RECONCILE_INTERVAL_MS);
            controller = waited.controller;
            stats.startupReconcile.attempts = waited.attempts;
            stats.startupReconcile.waitedMs = waited.waitedMs;
            if (controller === null) {
                stats.startupReconcile.outcome = 'no-controller';
                stats.startupReconcile.error = 'NO_SESSION_HISTORY_API';
                stats.lastReconcileError = 'NO_SESSION_HISTORY_API';
                return;
            }
        } else {
            controller = ctx.get('sessionController');
        }
        stats.lastReconcileError = null;
        stats.lastReconcileReason = null;
        if (!controller || typeof controller.page !== 'function') {
            stats.lastReconcileError = 'NO_SESSION_HISTORY_API';
            if (startup) {
                stats.startupReconcile.outcome = 'no-controller';
                stats.startupReconcile.error = 'NO_SESSION_HISTORY_API';
            }
            return;
        }
        const settled = [];
        let lastError = null;
        for (const group of visible) {
            const coordinator = state.coordinators.get(group.id);
            if (coordinator === undefined) continue;
            for (const task of coordinator.tasks()) {
                if (task.state !== 'delivered' && task.state !== 'uncertain') continue;
                try {
                    const window = await readTaskHistory(controller, task);
                    const outcome = await coordinator.reconcileFromHistory(task.requestId, window.events);
                    if (outcome.state === 'settled') {
                        settled.push(task.requestId);
                        stats.lastReconcileReason = `settled:${task.requestId}`;
                    } else if (outcome.state === 'missing') {
                        stats.lastReconcileReason = `${window.exhausted ? 'page-limit' : 'rpc-not-found'}:${task.requestId}`;
                    } else if (outcome.state === 'pending') {
                        stats.lastReconcileReason = `${outcome.turn === null ? 'anchor-without-turn' : 'no-turn-end'}:${task.requestId}`;
                    } else if (outcome.state === 'unconfirmed') {
                        stats.lastReconcileReason = `unconfirmed-${outcome.reason}:${task.requestId}`;
                    }
                } catch (error) {
                    // 历史读取失败不能拖垮 ms2_status；原文留在状态里供重启后排查。
                    lastError = `${task.requestId}: ${error instanceof Error ? error.message : String(error)}`;
                    stats.lastReconcileError = lastError;
                }
            }
        }
        if (startup) {
            stats.startupReconcile.settled = settled;
            stats.startupReconcile.error = lastError;
            stats.startupReconcile.outcome = lastError !== null ? 'error' : settled.length > 0 ? 'settled' : 'idle';
        }
    }

    /** 解析目标整体：显式 id/名字优先；没给时，调用者只领导一个整体就用它。 */
    function resolveGroup(caller, hint) {
        const led = state.groups.list().filter(group => group.registry.isLead(caller));
        if (typeof hint === 'string' && hint.length > 0) {
            const found = state.groups.get(hint) ?? state.groups.findByName(hint);
            if (found === undefined) throw new Error('找不到这个整体');
            if (!found.registry.isLead(caller)) throw new Error('仅主会话可执行该操作');
            return found;
        }
        if (led.length === 1) return led[0];
        if (led.length === 0) throw new Error('仅主会话可执行该操作');
        throw new Error('你领导多个整体，请用 group 指定');
    }

    async function readyError() {
        await ready;
        return state.error === null ? null : reply('error', `协调体不可用：${state.error}`, null);
    }

    /** 只读检查：调用者至少属于一个整体，才能看状态。 */
    async function readable(exec) {
        const failed = await readyError();
        if (failed !== null) return { failed };
        const caller = exec && exec.agent && exec.agent.id;
        if (groupsFor(caller).length === 0) return { failed: reply('denied', '不在任何整体内', null) };
        return { caller };
    }

    const tools = [
        {
            definition: toolDefinition('ms2_status', '查看所有整体：主会话、成员、在途工单与重启恢复项。', '留空或填 list 即可'),
            async execute(_args, exec) {
                const gate = await readable(exec);
                if (gate.failed !== undefined) return gate.failed;
                const visible = groupsFor(gate.caller);
                const visibleIds = new Set(visible.map(group => group.id));
                // 事件快路径收不到别的会话时，这里用历史窗口把 delivered/uncertain 工单捞回来。
                await reconcileTasks(visible);
                const lines = visible.map(group => {
                    const coordinator = state.coordinators.get(group.id);
                    const tasks = coordinator === undefined ? [] : coordinator.tasks();
                    const inFlight = tasks.filter(task => task.state === 'delivered' || task.state === 'uncertain').length;
                    return `${group.name}(${group.id}) 主=${group.registry.lead()} 成员=${group.registry.list().length} 在途 ${inFlight}/${tasks.length}`;
                });
                // 兼容旧形状：data 顶层仍给出“第一个可见整体”的 lead/members/policies，
                // 面板与工具复用同一份数据，老调用方不用改。
                const primary = visible.length > 0 ? visible[0] : null;
                const primarySnapshot = primary === null ? { lead: null, members: [] } : primary.registry.snapshot();
                const primaryCoordinator = primary === null ? undefined : state.coordinators.get(primary.id);
                return reply('ok', lines.length === 0 ? '还没有整体' : lines.join('；'), {
                    // 兼容旧形状：顶层仍给出“第一个可见整体”的名单与工单。
                    lead: primarySnapshot.lead,
                    members: primarySnapshot.members,
                    tasks: primaryCoordinator === undefined ? [] : primaryCoordinator.tasks(),
                    recovery: primaryCoordinator === undefined ? [] : primaryCoordinator.recoveryPlan(),
                    policies: [...policiesTable(visible).values()].map(policy => ({
                        sessionId: policy.sessionId,
                        role: policy.role,
                        allow: policy.allow,
                        denyCount: policy.deny.length
                    })),
                    groups: visible.map(group => {
                        const coordinator = state.coordinators.get(group.id);
                        return { ...group.registry.snapshot(), id: group.id, name: group.name, tasks: coordinator === undefined ? [] : coordinator.tasks() };
                    }),
                    startupRecovery: state.recovery.filter(item => item.groupId === undefined || visibleIds.has(item.groupId)),
                    observeStats: {
                        eventsSeen: state.observeStats.eventsSeen,
                        lastAt: state.observeStats.lastAt,
                        lastSessionId: state.observeStats.lastSessionId,
                        lastType: state.observeStats.lastType,
                        lastReconcileError: state.observeStats.lastReconcileError,
                        lastReconcileReason: state.observeStats.lastReconcileReason,
                        startupReconcile: {
                            attempts: state.observeStats.startupReconcile.attempts,
                            waitedMs: state.observeStats.startupReconcile.waitedMs,
                            outcome: state.observeStats.startupReconcile.outcome,
                            settled: [...state.observeStats.startupReconcile.settled],
                            error: state.observeStats.startupReconcile.error
                        },
                        coordinators: state.coordinators.size
                    },
                    logTruncated: state.eventLog.truncated === true
                });
            }
        },
        {
            definition: toolDefinition('ms2_group', '创建或列出整体。创建参数：{"action":"create","name":"团队 A","lead":"session-...","members":["session-..."]}。', '{"action":"create","name":"...","lead":"session-...","members":["session-..."]}'),
            async execute(args, exec) {
                const failed = await readyError();
                if (failed !== null) return failed;
                const payload = parseJson(args && args.request, '{"action":"create","name":"...","lead":"session-...","members":["session-..."]}');
                const caller = exec && exec.agent && exec.agent.id;
                if (payload.action === 'list' || payload.action === undefined) {
                    const visible = groupsFor(caller);
                    return reply('ok', `${visible.length} 个整体`, groupsSnapshot(visible));
                }
                if (payload.action !== 'create') return reply('error', 'action 只能是 create 或 list', null);
                // 工具通道只允许“以自己为主会话”创建：否则任何会话都能把自己塞进别人领导的整体。
                // 面板是人工操作，走命令通道，不受这条限制。
                if (typeof caller !== 'string') {
                    return reply('error', '无法识别调用会话，不能在工具通道创建整体', null);
                }
                if (payload.lead !== caller) {
                    return reply('error', '工具通道只能以自己为主会话创建整体；要指定别的主会话请用面板', null);
                }
                try {
                    const group = state.groups.create({ name: payload.name, lead: payload.lead, members: payload.members });
                    const coordinator = new Coordinator({
                        registry: group.registry,
                        channel: state.channel,
                        tracker,
                        ledger: new TaskLedger({ file: ledgerFile }),
                        groupId: group.id
                    });
                    state.coordinators.set(group.id, coordinator);
                    await state.groups.save();
                    return reply('ok', `已创建整体「${group.name}」（主会话 ${group.registry.lead()}）`, group.toJSON());
                } catch (error) {
                    return reply('error', error instanceof Error ? error.message : String(error), null);
                }
            }
        },
        {
            definition: toolDefinition('ms2_members', '查看/增删某个整体的成员：{"group":"整体名","request":"list|add <id>|remove <id>|lead <id>"}。', '{"group":"迁移整体","request":"list"}'),
            async execute(args, exec) {
                const failed = await readyError();
                if (failed !== null) return failed;
                const raw = args && typeof args.request === 'string' ? args.request.trim() : '';
                // 旧调用方式直接写命令串，新调用方式用 JSON 指定整体；两种都认。
                const payload = raw.startsWith('{') ? parseJson(raw, '{"group":"整体名","request":"list"}') : { request: raw };
                const caller = exec && exec.agent && exec.agent.id;
                let group;
                try {
                    group = resolveGroup(caller, payload.group);
                } catch (error) {
                    return reply('denied', error instanceof Error ? error.message : String(error), null);
                }
                const request = typeof payload.request === 'string' && payload.request.trim() !== '' ? payload.request.trim() : 'list';
                try {
                    const audit = await runCommand(group.registry, request);
                    if (!audit.ok) return reply('error', String(audit.reason), audit);
                    if (!request.startsWith('list') && !request.startsWith('show')) await state.groups.save();
                    return reply('ok', `${group.name}: ${request}`, { ...audit, group: group.toJSON() });
                } catch (error) {
                    return reply('error', error instanceof Error ? error.message : String(error), null);
                }
            }
        },
        {
            definition: toolDefinition('ms2_dispatch', '主会话把一张工单投给成员。参数：{"group":"整体名","memberId":"session-...","text":"..."}。', '{"group":"团队 A","memberId":"session-...","text":"..."}'),
            async execute(args, exec) {
                const failed = await readyError();
                if (failed !== null) return failed;
                const payload = parseJson(args && args.request, '{"group":"整体名","memberId":"session-...","text":"..."}');
                if (typeof payload.memberId !== 'string' || typeof payload.text !== 'string') {
                    return reply('error', '缺少 memberId 或 text', null);
                }
                const caller = exec && exec.agent && exec.agent.id;
                let group;
                try {
                    group = resolveGroup(caller, payload.group);
                } catch (error) {
                    return reply('denied', error instanceof Error ? error.message : String(error), null);
                }
                const coordinator = state.coordinators.get(group.id);
                try {
                    const task = await coordinator.dispatch(payload.memberId, payload.text, {
                        mode: payload.mode,
                        idempotent: payload.idempotent === true
                    });
                    return reply(task.state === 'failed' ? 'error' : 'ok', `${task.state} requestId=${task.requestId} → ${task.label}`, { ...task, group: group.name });
                } catch (error) {
                    return reply('error', error instanceof Error ? error.message : String(error), null);
                }
            }
        },
        {
            definition: toolDefinition('ms2_resolve', '主会话裁决一条“等待人工”的工单：{"requestId":"...","action":"accept|fail"}。', '{"requestId":"...","action":"accept|fail"}'),
            async execute(args, exec) {
                const failed = await readyError();
                if (failed !== null) return failed;
                const payload = parseJson(args && args.request, '{"requestId":"...","action":"accept|fail"}');
                if (typeof payload.requestId !== 'string' || typeof payload.action !== 'string') {
                    return reply('error', '缺少 requestId 或 action', null);
                }
                const caller = exec && exec.agent && exec.agent.id;
                for (const group of state.groups.list()) {
                    if (!group.registry.isLead(caller)) continue;
                    const coordinator = state.coordinators.get(group.id);
                    if (coordinator === undefined) continue;
                    const task = coordinator.tasks().find(item => item.requestId === payload.requestId);
                    if (task === undefined) continue;
                    try {
                        const resolved = coordinator.resolveHuman(payload.requestId, payload.action);
                        return reply('ok', `${payload.action} → ${resolved.state}（${group.name}）`, resolved);
                    } catch (error) {
                        return reply('error', error instanceof Error ? error.message : String(error), null);
                    }
                }
                return reply('error', '找不到这条工单（可能不属于你领导的整体）', null);
            }
        }
    ];

    // 宿主的 register 只收“一个完整的工具定义”，执行体必须在定义里的 execute 上。
    for (const tool of tools) {
        ctx.tools.register({
            ...tool.definition,
            async execute(args, exec) {
                try {
                    return await tool.execute(args, exec);
                } catch (error) {
                    return reply('error', error instanceof Error ? error.message : String(error), null);
                }
            }
        });
    }

    // 宿主命令：面板读数据、创建整体都走这里，避免往主会话日志里塞自定义事件。
    const commands = typeof ctx.get === 'function' ? ctx.get('commands') : undefined;
    if (commands && typeof commands.register === 'function') {
        commands.register({
            name: 'ms2',
            description: '超级代理部署：panel 读面板数据，create 建整体，dissolve 解散整体，group rename/members 改整体',
            input: { hint: 'panel / create {"name":"...","lead":"session-...","members":[...]} / dissolve <groupId> / group rename {"group":"g-...","name":"..."} / group members {"group":"g-...","members":["session-..."]}' },
            // 宿主传的是 invocation { commandId, agent, rawInput, attachments, signal }，
            // 不是 { input }；rawInput 是命令名之后的全部内容（含分隔空格）。
            async handler(invocation) {
                const text = invocation && typeof invocation.rawInput === 'string' ? invocation.rawInput.trim() : '';
                if (text === '' || text === 'panel') {
                    const failed = await readyError();
                    if (failed !== null) return { kind: 'error', text: failed.summary };
                    // 面板轮询是用户最常走的路径：顺带做一次幂等对账，失败也不能让面板打不开。
                    try {
                        await reconcileTasks(state.groups.list());
                    } catch (error) {
                        state.observeStats.lastReconcileError = error instanceof Error ? error.message : String(error);
                    }
                    return { kind: 'success', text: JSON.stringify({ groups: groupsSnapshot() }) };
                }
                if (text === 'create' || text.startsWith('create ')) {
                    await ready;
                    const raw = text.slice('create'.length).trim();
                    let payload;
                    try {
                        payload = parseJson(raw, '{"name":"...","lead":"session-...","members":["session-..."]}');
                    } catch (error) {
                        return { kind: 'error', text: error instanceof Error ? error.message : String(error) };
                    }
                    try {
                        const group = state.groups.create({ name: payload.name, lead: payload.lead, members: payload.members });
                        state.coordinators.set(group.id, new Coordinator({
                            registry: group.registry,
                            channel: state.channel,
                            tracker,
                            ledger: new TaskLedger({ file: ledgerFile }),
                            groupId: group.id
                        }));
                        await state.groups.save();
                        return { kind: 'success', text: JSON.stringify({ group: group.toJSON() }) };
                    } catch (error) {
                        return { kind: 'error', text: error instanceof Error ? error.message : String(error) };
                    }
                }
                if (text === 'dissolve' || text.startsWith('dissolve ')) {
                    const failed = await readyError();
                    if (failed !== null) return { kind: 'error', text: failed.summary };
                    const groupId = text.slice('dissolve'.length).trim();
                    const caller = invocation && invocation.agent && invocation.agent.id;
                    try {
                        const group = await dissolveGroup(caller, groupId);
                        return { kind: 'success', text: JSON.stringify({ dissolved: group.toJSON() }) };
                    } catch (error) {
                        return { kind: 'error', text: error instanceof Error ? error.message : String(error) };
                    }
                }
                if (text === 'group rename' || text.startsWith('group rename ')) {
                    const failed = await readyError();
                    if (failed !== null) return { kind: 'error', text: failed.summary };
                    let payload;
                    try {
                        payload = parseJson(text.slice('group rename'.length).trim(), '{"group":"g-...","name":"..."}');
                    } catch (error) {
                        return { kind: 'error', text: error instanceof Error ? error.message : String(error) };
                    }
                    const caller = invocation && invocation.agent && invocation.agent.id;
                    try {
                        const group = await renameGroup(caller, payload.group, payload.name);
                        return { kind: 'success', text: JSON.stringify({ group: group.toJSON() }) };
                    } catch (error) {
                        return { kind: 'error', text: error instanceof Error ? error.message : String(error) };
                    }
                }
                if (text === 'group members' || text.startsWith('group members ')) {
                    const failed = await readyError();
                    if (failed !== null) return { kind: 'error', text: failed.summary };
                    let payload;
                    try {
                        payload = parseJson(text.slice('group members'.length).trim(), '{"group":"g-...","members":["session-..."]}');
                    } catch (error) {
                        return { kind: 'error', text: error instanceof Error ? error.message : String(error) };
                    }
                    const caller = invocation && invocation.agent && invocation.agent.id;
                    try {
                        const group = await updateGroupMembers(caller, payload.group, payload.members);
                        return { kind: 'success', text: JSON.stringify({ group: group.toJSON() }) };
                    } catch (error) {
                        return { kind: 'error', text: error instanceof Error ? error.message : String(error) };
                    }
                }
                return { kind: 'error', text: '只支持 panel、create、dissolve、group rename 或 group members' };
            }
        });
    }

    // 会话事件 → 归集；每个协调器只认自己成员的会话。
    // 注册在插件自己的 ctx 上（宿主 dsh-tools/lib/index.js:899-902 就是这么做的），
    // 同时保留 root 上的注册作兼容；两处可能收到同一条事件，必须去重，绝不能结算两次。
    const seenEventSeqs = new Set();
    const seenEventObjects = new WeakSet();

    /** 首参可能是 Session 实例、字符串或包装对象；取不到时返回可读的兜底串，别抛异常。 */
    function resolveSession(session) {
        try {
            if (typeof session === 'string' && session.length > 0) return { id: session, usable: true };
            const id = session && (session.id ?? session.sessionId);
            if (typeof id === 'string' && id.length > 0) return { id, usable: true };
            return { id: String(session && (session.id ?? session.sessionId ?? typeof session)), usable: false };
        } catch {
            return { id: 'unreadable', usable: false };
        }
    }

    function eventTurn(event) {
        if (event && event.data && Number.isSafeInteger(event.data.turn)) return event.data.turn;
        if (event && Number.isSafeInteger(event.turn)) return event.turn;
        return null;
    }

    /** 收到事件却没结算时，给出一个可判读的原因；正常锚定/无关事件返回 undefined。 */
    function missReason(sessionId, event, settled) {
        if (settled.length > 0) return undefined;
        if (!event || typeof event !== 'object') return undefined;
        if (event.type !== 'user/message' && event.type !== 'turn/start' && event.type !== 'turn/end') return undefined;
        const pending = tracker.outstanding();
        if (pending.length === 0) return undefined;
        const own = pending.filter(item => item.sessionId === sessionId);
        if (own.length === 0) return 'session-mismatch';
        if (event.type === 'user/message') {
            const rpcId = event.data && event.data.source && event.data.source.rpcId;
            if (typeof rpcId === 'string' && own.some(item => item.requestId === rpcId)) return undefined;
            return 'anchor-miss';
        }
        if (own.some(item => item.anchored !== true)) return 'anchor-miss';
        const turn = eventTurn(event);
        if (turn !== null && own.every(item => item.turn !== null && item.turn !== turn)) return 'turn-mismatch';
        return 'awaiting-turn-end';
    }

    function handleSessionEvent(session, event) {
        const resolved = resolveSession(session);
        const sessionId = resolved.id;
        if (event && typeof event === 'object') {
            if (seenEventObjects.has(event)) return;
            if (event.seq !== undefined) {
                const key = `${sessionId}\u0000${String(event.seq)}`;
                if (seenEventSeqs.has(key)) return;
                seenEventSeqs.add(key);
                if (seenEventSeqs.size > 4096) seenEventSeqs.clear();
            }
            seenEventObjects.add(event);
        }
        const type = event && typeof event.type === 'string' ? event.type : 'unknown';
        const turn = eventTurn(event);
        const at = new Date().toISOString();
        state.observeStats.eventsSeen += 1;
        state.observeStats.lastAt = at;
        state.observeStats.lastSessionId = sessionId;
        state.observeStats.lastType = type;

        let settled = [];
        if (resolved.usable) {
            for (const coordinator of state.coordinators.values()) {
                try {
                    settled = settled.concat(coordinator.observe(sessionId, event));
                } catch {
                    // 单个整体归集失败不影响其它整体与宿主事件分发。
                }
            }
        }
        const reason = missReason(sessionId, event, settled);
        appendEventLog(reason === undefined
            ? { at, sessionId, type, turn }
            : { at, sessionId, type, turn, reason });
    }

    const eventTargets = [];
    for (const target of [ctx, ctx.root]) {
        if (!target || typeof target.on !== 'function' || eventTargets.includes(target)) continue;
        eventTargets.push(target);
        try {
            // global：宿主用 carrier 的 Context.filter 过滤监听器（cordis events.ts:171-173）。
            target.on('session/event', handleSessionEvent, { global: true });
        } catch {
            // 注册失败留给观测日志与 ms2_status 暴露，不阻断插件加载。
        }
    }

    // 权限面：跨会话通道只归各自整体的主会话；成员按角色策略执行。
    if (safetyTools && typeof safetyTools.guard === 'function') {
        safetyTools.guard((exec) => {
            const caller = exec && exec.agent && exec.agent.id;
            if (typeof caller !== 'string' || state.groups === null) return;
            const groups = state.groups.list();
            if (groups.some(group => group.registry.isLead(caller))) return;
            // 按当前名单现算，不查可能过期的缓存：成员被移除后必须立刻恢复普通权限。
            const memberships = groups.filter(group => group.registry.get(caller) !== undefined);
            if (memberships.length === 0) return;
            if (typeof exec.name === 'string' && exec.name.startsWith('ms2_')) {
                return 'MS2_MEMBER_DENIED: 成员不能直接使用协调体工具，请经主会话';
            }
            for (const group of memberships) {
                const policy = policiesFor(group.registry).get(caller);
                if (policy === undefined) continue;
                const verdict = checkToolAllowed(policy, exec.name);
                if (!verdict.allowed) return `MS2_DENIED: ${verdict.reason}`;
            }
        });
    }

    // 可选自检：配置里给了 selfTest，就在加载后走一次真实派工并写报告。
    // 只用于“重启后能不能真机跑通”的可判读结论，不是功能入口。
    const selfTest = config && config.selfTest;
    if (selfTest && typeof selfTest === 'object' && typeof selfTest.memberId === 'string' && typeof selfTest.text === 'string') {
        const directory = typeof selfTest.reportDir === 'string' ? selfTest.reportDir : DEFAULT_REPORT_DIR;
        const timeoutMs = Number.isFinite(selfTest.timeoutMs) ? selfTest.timeoutMs : 120000;
        void (async () => {
            await ready;
            if (state.error !== null) {
                await writeReport(directory, { phase: 'registry-error', message: state.error });
                return;
            }
            const group = state.groups.list()[0];
            if (group === undefined) {
                await writeReport(directory, { phase: 'no-group' });
                return;
            }
            const coordinator = state.coordinators.get(group.id);
            let task;
            try {
                task = await coordinator.dispatch(selfTest.memberId, selfTest.text);
            } catch (error) {
                await writeReport(directory, { phase: 'dispatch-threw', message: String(error).slice(0, 400) });
                return;
            }
            await writeReport(directory, { phase: 'dispatched', task });
            const startedAt = Date.now();
            while (Date.now() - startedAt < timeoutMs) {
                const current = coordinator.tasks().find(item => item.requestId === task.requestId);
                if (current && current.state !== 'delivered') {
                    await writeReport(directory, { phase: 'settled', task: current, elapsedMs: Date.now() - startedAt });
                    return;
                }
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
            await writeReport(directory, {
                phase: 'timeout',
                task: coordinator.tasks().find(item => item.requestId === task.requestId) ?? null,
                outstanding: coordinator.outstanding()
            });
        })().catch(error => {
            void writeReport(directory, { phase: 'crashed', message: String(error).slice(0, 400) });
        });
    }

    void ready;
}
