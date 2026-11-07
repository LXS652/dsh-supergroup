/**
 * 超级代理部署 · 侧栏面板（客户端半）
 *
 * 面板只做三件事：看现有整体、看会话、创建新整体。
 * 数据走宿主命令 /ms2：面板不直接读账本，也不往会话日志里写自定义事件。
 *
 * 宿主用 window.__ModuleLoader__.load 加载这个经典脚本，只能 require 平台种子模块。
 * 会话/工作区数据来自槽位提供的 hooks：props.useSessions / props.useWorkspaces。
 */
window.__ModuleLoader__.load({
    id: 'dsh-supergroup',
    factory: (require) => {
        const React = require('react');
        const h = React.createElement;

        const PANEL_ID = 'dsh-supergroup';

        const S = {
            root: { display: 'flex', flexDirection: 'column', gap: 12, padding: 16, height: '100%', overflow: 'auto', font: '13px/1.55 ui-sans-serif, system-ui, "Segoe UI", sans-serif' },
            bar: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
            columns: { display: 'grid', gridTemplateColumns: 'minmax(240px, 1fr) minmax(280px, 1.2fr)', gap: 16, alignItems: 'start' },
            card: { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 10, padding: '10px 12px', background: 'var(--dsw-alias-bg-layer-1)' },
            sectionTitle: { fontSize: 13, fontWeight: 600, margin: '0 0 8px' },
            wsTitle: { fontSize: 12, fontWeight: 600, opacity: 0.8, margin: '10px 0 4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
            dim: { fontSize: 12, opacity: 0.62 },
            row: { display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', borderBottom: '1px dashed var(--dsw-alias-border-l1)' },
            button: { cursor: 'pointer', borderRadius: 8, padding: '4px 10px', fontSize: 12, background: 'transparent', color: 'inherit', border: '1px solid var(--dsw-alias-border-l2)' },
            primary: { cursor: 'pointer', borderRadius: 8, padding: '4px 10px', fontSize: 12, background: 'var(--dsw-alias-bg-layer-2)', color: 'inherit', border: '1px solid var(--dsw-alias-border-l2)' },
            input: { width: '100%', fontSize: 12, padding: '6px 8px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent', color: 'inherit' },
            error: { color: 'var(--dsw-alias-color-danger, #d33)', fontSize: 12 },
            wizard: { marginTop: 10, padding: 12, borderRadius: 10, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)' },
            list: { maxHeight: 300, overflow: 'auto' }
        };

        /** 节点图图标：一个主节点 + 三个执行节点。侧栏条目与标题共用。 */
        function NodeIcon({ size = 16 }) {
            return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' },
                h('circle', { cx: 12, cy: 12, r: 3.2 }),
                h('circle', { cx: 12, cy: 3.8, r: 2 }),
                h('circle', { cx: 4.8, cy: 18, r: 2 }),
                h('circle', { cx: 19.2, cy: 18, r: 2 }),
                h('path', { d: 'M12 7.9v0.9M9.7 14l-2.5 2.2M14.3 14l2.5 2.2' })
            );
        }

        /** 会话 ID 只留尾巴，避免整行被长 ID 撑爆；完整 ID 仍放在 title 属性里。 */
        function shortId(sessionId) {
            if (typeof sessionId !== 'string') return '';
            const tail = sessionId.replace(/^session-/, '');
            return tail.length > 10 ? `${tail.slice(0, 8)}…` : tail;
        }

        /** 面板内统一的会话名：空白会话给专门文案，其次 displayTitle/title，都空才兜底。 */
        function sessionTitle(sessionId, byId) {
            const summary = byId && typeof byId === 'object' ? byId[sessionId] : undefined;
            if (summary && summary.blank === true) return '空白会话';
            const display = summary && typeof summary.displayTitle === 'string' ? summary.displayTitle.trim() : '';
            const title = summary && typeof summary.title === 'string' ? summary.title.trim() : '';
            if (display !== '') return display;
            if (title !== '') return title;
            return '未命名会话';
        }

        /** 整体卡片里的成员：会话表里查不到时退回宿主给的 label，但绝不把裸 sessionId 当名字。 */
        function memberTitle(member, byId) {
            const name = sessionTitle(member && member.sessionId, byId);
            if (name !== '未命名会话') return name;
            const label = member && typeof member.label === 'string' ? member.label.trim() : '';
            if (label !== '' && label !== member.sessionId) return label;
            return '未命名会话';
        }

        /**
         * 创建整体时落盘的 label：宿主只接受字母/数字/下划线/点/连字符/空格，最长 64。
         * 展示仍优先用 sessions store 的原始标题，label 只是旧数据/冷会话的兜底。
         */
        function labelFor(sessionId, byId) {
            const raw = sessionTitle(sessionId, byId);
            const cleaned = raw.replace(/[^\p{L}\p{N}_.\- ]/gu, ' ').replace(/\s+/g, ' ').trim();
            const bounded = Array.from(cleaned).slice(0, 64).join('');
            return bounded !== '' ? bounded : '未命名会话';
        }

        /** 工作区标题：优先用宿主给的名字，否则取路径最后一段。 */
        function workspaceLabel(workspace) {
            const title = typeof workspace.title === 'string' ? workspace.title.trim() : '';
            if (title !== '') return title;
            const path = typeof workspace.path === 'string' ? workspace.path : '';
            const parts = path.split(/[\\/]/).filter((part) => part !== '');
            return parts.length === 0 ? '未知工作区' : parts[parts.length - 1];
        }

        /**
         * 把客户端会话行整理成面板要的形状。
         * 行字段：id / displayTitle / title / origin / parentId / blank / updatedAt / running。
         */
        function toRow(summary) {
            if (summary === null || typeof summary !== 'object' || typeof summary.id !== 'string') return null;
            const display = typeof summary.displayTitle === 'string' ? summary.displayTitle.trim() : '';
            const title = typeof summary.title === 'string' ? summary.title.trim() : '';
            const isBlank = summary.blank === true;
            return {
                sessionId: summary.id,
                title: isBlank ? '空白会话' : (display !== '' ? display : (title !== '' ? title : '未命名会话')),
                isChild: summary.origin === 'subagent' || summary.parentId !== undefined,
                isBlank,
                running: summary.running === true,
                at: typeof summary.updatedAt === 'number' ? summary.updatedAt : 0
            };
        }

        /** 按工作区分组；没有工作区数据时退化成一组“全部会话”。 */
        function groupSessions(byId, workspaces, currentSessionId, hideChildren, includeBlank = false) {
            if (!byId || typeof byId !== 'object') return [];
            const visible = (sessionId) => {
                const summary = byId[sessionId];
                const row = toRow(summary);
                if (row === null) return null;
                // 空白会话也显示、也可点击；当前会话本来就在列表里，规则不变。
                if (row.isBlank && !includeBlank && row.sessionId !== currentSessionId) return null;
                if (hideChildren && row.isChild) return null;
                return row;
            };
            const buckets = [];
            const covered = new Set();
            const items = workspaces && Array.isArray(workspaces.items) ? workspaces.items : [];
            for (const workspace of items) {
                const ids = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : [];
                const rows = ids.map(visible).filter((row) => row !== null);
                if (rows.length === 0) continue;
                for (const row of rows) covered.add(row.sessionId);
                buckets.push({ key: workspace.workspaceId, label: workspaceLabel(workspace), path: workspace.path, rows });
            }
            const rest = Object.keys(byId).map(visible).filter((row) => row !== null && !covered.has(row.sessionId));
            if (rest.length > 0) buckets.push({ key: '__rest__', label: '其它会话', path: '', rows: rest });
            for (const bucket of buckets) bucket.rows.sort((a, b) => b.at - a.at);
            return buckets;
        }

        /** 宿主命令：返回 {ok, value:{result:{kind,text}}}；错误一律转成可读文本。 */
        async function runCommand(ctx, sessionId, line, asJson) {
            if (!ctx || !sessionId) throw new Error('没有可用的会话上下文');
            const result = await ctx.remote.commands.execute(sessionId, line, []);
            if (!result || result.ok !== true) {
                throw new Error(`${(result && result.error && result.error.code) || 'ERROR'}: ${(result && result.error && result.error.message) || '命令执行失败'}`);
            }
            const settled = result.value && result.value.result ? result.value.result : result.value;
            if (settled === undefined) throw new Error(`未知命令：${line}`);
            if (settled.kind === 'error') throw new Error(String(settled.text || '命令返回错误'));
            const text = String(settled.text === undefined ? '' : settled.text);
            if (!asJson) return text;
            try {
                return JSON.parse(text);
            } catch {
                throw new Error('返回解析失败：不是 JSON');
            }
        }

        function GroupCard({ group, byId, sessions, onOpen, onDissolve, onRename, onUpdateMembers }) {
            const members = Array.isArray(group.members) ? group.members : [];
            const sessionRows = Array.isArray(sessions) ? sessions : [];
            const [confirming, setConfirming] = React.useState(false);
            const [busy, setBusy] = React.useState(false);
            const [failure, setFailure] = React.useState('');
            const [editing, setEditing] = React.useState(false);
            const [draftName, setDraftName] = React.useState(group.name);
            const [draftMembers, setDraftMembers] = React.useState(members.map((member) => member.sessionId));
            const [editBusy, setEditBusy] = React.useState(false);
            const [editError, setEditError] = React.useState('');

            const beginEdit = () => {
                setConfirming(false);
                setDraftName(group.name);
                setDraftMembers(members.map((member) => member.sessionId));
                setEditError('');
                setEditing(true);
            };

            const cancelEdit = () => {
                setEditing(false);
                setEditError('');
            };

            const toggleDraftMember = (sessionId) => {
                setDraftMembers((current) => (current.includes(sessionId)
                    ? current.filter((item) => item !== sessionId)
                    : [...current, sessionId]));
            };

            const saveName = async () => {
                if (typeof onRename !== 'function') { setEditError('当前面板不支持改名'); return; }
                setEditBusy(true);
                setEditError('');
                try {
                    await onRename(group, draftName.trim());
                    setEditing(false);
                } catch (error) {
                    setEditError(String((error && error.message) || error));
                } finally {
                    setEditBusy(false);
                }
            };

            const saveMembers = async () => {
                if (typeof onUpdateMembers !== 'function') { setEditError('当前面板不支持改成员'); return; }
                setEditBusy(true);
                setEditError('');
                try {
                    // 落盘时把 label 一起带上，避免新成员在 groups.json 里只剩裸 sessionId。
                    const labelled = draftMembers.map((sessionId) => ({
                        sessionId,
                        label: labelFor(sessionId, byId)
                    }));
                    await onUpdateMembers(group, labelled);
                    setEditing(false);
                } catch (error) {
                    setEditError(String((error && error.message) || error));
                } finally {
                    setEditBusy(false);
                }
            };

            const requestDissolve = async () => {
                if (!confirming) { setConfirming(true); return; }
                if (typeof onDissolve !== 'function') { setFailure('当前面板不支持解散'); return; }
                setBusy(true);
                setFailure('');
                try {
                    await onDissolve(group);
                } catch (error) {
                    setFailure(String((error && error.message) || error));
                    setConfirming(false);
                } finally {
                    setBusy(false);
                }
            };

            const dissolveStyle = confirming
                ? { ...S.button, color: 'var(--dsw-alias-color-danger, #d33)', borderColor: 'currentColor' }
                : S.button;

            const selectable = sessionRows.filter((item) => item.sessionId !== group.lead);

            return h('div', { style: { ...S.card, marginBottom: 8 } },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                    h(NodeIcon, { size: 14 }),
                    h('strong', { style: { fontSize: 13 } }, group.name),
                    h('span', { style: S.dim }, `${members.length + 1} 个会话`),
                    typeof group.inFlight === 'number' && group.inFlight > 0
                        ? h('span', { style: { ...S.dim, color: 'var(--dsw-alias-color-warning, #c90)' } }, `在途 ${group.inFlight}`)
                        : null,
                    typeof group.provisional === 'number' && group.provisional > 0
                        ? h('span', {
                            style: { ...S.dim, color: 'var(--dsw-alias-color-warning, #c90)' },
                            title: '成员已上报完成，等对账或 turn/end 复核'
                        }, `未核实 ${group.provisional}`)
                        : null,
                    h('span', { style: { flex: 1 } }),
                    h('button', {
                        type: 'button',
                        style: S.button,
                        disabled: busy || editBusy,
                        title: '改名或调整执行会话，不影响任何会话本身',
                        onClick: beginEdit
                    }, editing ? '编辑中…' : '编辑'),
                    h('button', {
                        type: 'button',
                        style: dissolveStyle,
                        disabled: busy || editBusy,
                        title: '只删除整体登记，不删除任何会话',
                        onClick: () => void requestDissolve()
                    }, busy ? '解散中…' : (confirming ? `再次点击确认解散「${group.name}」（${members.length + 1} 个会话）` : '解散'))
                ),
                failure === '' ? null : h('div', { style: { ...S.error, marginTop: 6 } }, failure),
                editing ? h('div', { style: { ...S.card, marginTop: 8, background: 'transparent' } },
                    h('div', { style: { ...S.bar, marginBottom: 6 } },
                        h('span', { style: { fontSize: 12, fontWeight: 600 } }, '整体名'),
                        h('input', {
                            style: { ...S.input, flex: 1, minWidth: 160 },
                            value: draftName,
                            disabled: editBusy,
                            maxLength: 40,
                            onChange: (event) => setDraftName(event.target.value)
                        }),
                        h('button', { type: 'button', style: S.primary, disabled: editBusy || draftName.trim() === '', onClick: () => void saveName() }, '保存名称')
                    ),
                    h('div', { style: { ...S.dim, margin: '8px 0 4px' } }, `执行会话（${draftMembers.length}/8，空白会话也可选）`),
                    h('div', { style: { ...S.list, maxHeight: 180, overflow: 'auto' } },
                        selectable.map((item) => h('label', { key: item.sessionId, style: S.row, title: item.sessionId },
                            h('input', {
                                type: 'checkbox',
                                checked: draftMembers.includes(item.sessionId),
                                disabled: editBusy,
                                onChange: () => toggleDraftMember(item.sessionId)
                            }),
                            h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.title),
                            item.isBlank ? h('span', { style: { ...S.dim, fontSize: 11 } }, '空白会话') : null,
                            h('span', { style: S.dim }, shortId(item.sessionId))
                        ))
                    ),
                    h('div', { style: { ...S.bar, marginTop: 8 } },
                        h('button', { type: 'button', style: S.primary, disabled: editBusy || draftMembers.length === 0, onClick: () => void saveMembers() }, editBusy ? '保存中…' : '保存成员'),
                        h('button', { type: 'button', style: S.button, disabled: editBusy, onClick: cancelEdit }, '取消')
                    ),
                    editError === '' ? null : h('div', { style: { ...S.error, marginTop: 6 } }, editError)
                ) : null,
                h('div', { style: { ...S.dim, marginTop: 6 } },
                    '主会话：',
                    h('a', {
                        href: '#',
                        title: group.lead,
                        style: { color: 'inherit' },
                        onClick: (e) => { e.preventDefault(); onOpen(group.lead); }
                    }, sessionTitle(group.lead, byId)),
                    h('span', { style: S.dim }, ` · ${shortId(group.lead)}`)
                ),
                members.length === 0 ? null : h('div', { style: { ...S.dim, marginTop: 4 } },
                    '执行：',
                    members.map((member, index) => h('span', { key: member.sessionId, title: member.sessionId },
                        index > 0 ? '、' : '',
                        h('a', {
                            href: '#',
                            style: { color: 'inherit' },
                            onClick: (e) => { e.preventDefault(); onOpen(member.sessionId); }
                        }, memberTitle(member, byId)),
                        h('span', { style: S.dim }, ` · ${shortId(member.sessionId)}`)
                    ))
                )
            );
        }

        function Panel(props) {
            const ctx = props.__ctx;
            const byId = typeof props.useSessions === 'function'
                ? props.useSessions((state) => state.byId)
                : undefined;
            const workspaces = typeof props.useWorkspaces === 'function'
                ? props.useWorkspaces((state) => state)
                : undefined;
            const currentSessionId = props.currentSessionId || props.sessionId || '';

            const [groups, setGroups] = React.useState([]);
            const [error, setError] = React.useState('');
            const [busy, setBusy] = React.useState(false);
            const [foldBatch, setFoldBatch] = React.useState(true);
            // 空白会话折叠只影响左栏；展开状态不落盘，只存在这个组件里。
            const [foldBlank, setFoldBlank] = React.useState(true);
            const [expandedBlankKeys, setExpandedBlankKeys] = React.useState({});
            const [wizard, setWizard] = React.useState(false);
            const [step, setStep] = React.useState(1);
            const [lead, setLead] = React.useState('');
            const [members, setMembers] = React.useState([]);
            const [name, setName] = React.useState('');

            const buckets = React.useMemo(
                () => groupSessions(byId, workspaces, currentSessionId, foldBatch, true),
                [byId, workspaces, currentSessionId, foldBatch]
            );
            const flatSessions = React.useMemo(
                () => buckets.reduce((all, bucket) => all.concat(bucket.rows), []),
                [buckets]
            );
            // 创建向导不受左栏两个折叠勾选影响：子会话与空白会话都列出来供主动挑选。
            const wizardSessions = React.useMemo(
                () => groupSessions(byId, workspaces, currentSessionId, false, true)
                    .reduce((all, bucket) => all.concat(bucket.rows), []),
                [byId, workspaces, currentSessionId]
            );

            /** 面板要有一个会话当“命令入口”：当前会话优先，否则用列表第一个。 */
            const targetId = React.useMemo(
                () => currentSessionId || (flatSessions[0] ? flatSessions[0].sessionId : ''),
                [currentSessionId, flatSessions]
            );

            const refresh = React.useCallback(async () => {
                if (!ctx || !targetId) { setError('还没有可用的会话上下文'); return; }
                setBusy(true);
                try {
                    const value = await runCommand(ctx, targetId, '/ms2 panel', true);
                    setGroups(Array.isArray(value.groups) ? value.groups : []);
                    setError('');
                } catch (failure) {
                    setError(String((failure && failure.message) || failure));
                } finally {
                    setBusy(false);
                }
            }, [ctx, targetId]);

            React.useEffect(() => { void refresh(); }, [refresh]);

            const open = (sessionId) => {
                try { ctx.uiWorkspace.openSession(sessionId); } catch { /* 打不开就留在面板 */ }
            };

            const toggleMember = (sessionId) => {
                setMembers((current) => (current.includes(sessionId) ? current.filter((item) => item !== sessionId) : [...current, sessionId]));
            };

            const submit = async () => {
                setBusy(true);
                try {
                    const memberPayload = members.map((sessionId) => ({
                        sessionId,
                        label: labelFor(sessionId, byId)
                    }));
                    await runCommand(ctx, targetId, `/ms2 create ${JSON.stringify({ name: name.trim(), lead, members: memberPayload })}`, false);
                    setWizard(false);
                    setStep(1);
                    setLead('');
                    setMembers([]);
                    setName('');
                    setError('');
                    await refresh();
                } catch (failure) {
                    setError(`创建失败：${String((failure && failure.message) || failure)}`);
                } finally {
                    setBusy(false);
                }
            };

            const canNext = step === 1 ? lead !== '' : step === 2 ? members.length > 0 : name.trim() !== '';

            /**
             * 解散必须由该整体主会话执行命令：面板可能从任意会话打开，
             * 所以把命令投到 group.lead 的会话上下文里，权限仍由宿主命令侧兜底。
             */
            const dissolve = async (group) => {
                const leadId = group && typeof group.lead === 'string' && group.lead !== '' ? group.lead : targetId;
                if (!leadId) throw new Error('没有可用的主会话上下文');
                await runCommand(ctx, leadId, `/ms2 dissolve ${group.id}`, false);
                await refresh();
            };

            /** 改名与改成员同样投到该整体主会话上下文，权限由宿主命令侧最终裁决。 */
            const rename = async (group, name) => {
                const leadId = group && group.lead ? group.lead : targetId;
                if (!leadId) throw new Error('没有可用的主会话上下文');
                await runCommand(ctx, leadId, `/ms2 group rename ${JSON.stringify({ group: group.id, name })}`, false);
                await refresh();
            };

            const updateMembers = async (group, members) => {
                const leadId = group && group.lead ? group.lead : targetId;
                if (!leadId) throw new Error('没有可用的主会话上下文');
                await runCommand(ctx, leadId, `/ms2 group members ${JSON.stringify({ group: group.id, members })}`, false);
                await refresh();
            };

            const sessionRows = (rows, onPick) => rows.map((item) => h('div', { key: item.sessionId, style: S.row, title: item.sessionId },
                onPick(item),
                h('span', { title: item.sessionId, style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.title),
                item.running ? h('span', { style: { ...S.dim, color: 'var(--dsw-alias-color-success, #2a2)' } }, '运行中') : null,
                item.isChild ? h('span', { style: S.dim }, '子会话') : null,
                item.isBlank ? h('span', { style: { ...S.dim, fontSize: 11 } }, '新会话，尚未开始对话') : null,
                h('span', { style: S.dim }, '·'),
                h('span', { style: S.dim, title: item.sessionId }, shortId(item.sessionId))
            ));

            return h('div', { style: S.root },
                h('div', { style: S.bar },
                    h(NodeIcon, { size: 18 }),
                    h('strong', { style: { fontSize: 15 } }, '超级代理部署'),
                    h('span', { style: S.dim }, '一个主会话 + 若干执行会话 = 一个整体'),
                    h('span', { style: { flex: 1 } }),
                    h('label', { style: { ...S.dim, display: 'flex', gap: 4, alignItems: 'center' } },
                        h('input', { type: 'checkbox', checked: foldBatch, onChange: () => setFoldBatch(!foldBatch) }),
                        '折叠批量会话'
                    ),
                    h('label', { style: { ...S.dim, display: 'flex', gap: 4, alignItems: 'center' } },
                        h('input', { type: 'checkbox', checked: foldBlank, onChange: () => setFoldBlank(!foldBlank) }),
                        '折叠空白会话'
                    ),
                    h('button', { type: 'button', style: S.button, disabled: busy, onClick: () => void refresh() }, busy ? '读取中…' : '刷新')
                ),
                error === '' ? null : h('div', { style: S.error }, error),
                h('div', { style: S.columns },
                    h('section', null,
                        h('h3', { style: S.sectionTitle }, '会话'),
                        h('div', { style: S.list },
                            buckets.length === 0
                                ? h('div', { style: S.dim }, '读不到会话列表')
                                : buckets.map((bucket) => {
                                    const blanks = bucket.rows.filter((item) => item.isBlank);
                                    const expanded = expandedBlankKeys[bucket.key] === true;
                                    const visibleRows = foldBlank && !expanded
                                        ? bucket.rows.filter((item) => !item.isBlank)
                                        : bucket.rows;
                                    const shownCount = visibleRows.length + (foldBlank && blanks.length > 0 ? 1 : 0);
                                    return h('div', { key: bucket.key },
                                        h('div', { style: S.wsTitle, title: bucket.path }, `${bucket.label}（${shownCount}）`),
                                        sessionRows(visibleRows, (item) => h('button', { type: 'button', style: S.button, onClick: () => open(item.sessionId) }, '打开')),
                                        foldBlank && blanks.length > 0
                                            ? h('button', {
                                                type: 'button',
                                                title: expanded ? '收起空白会话' : '展开空白会话',
                                                style: {
                                                    ...S.row, cursor: 'pointer', width: '100%', background: 'transparent',
                                                    color: 'inherit', font: 'inherit', textAlign: 'left',
                                                    border: 'none', borderBottom: '1px dashed var(--dsw-alias-border-l1)'
                                                },
                                                onClick: () => setExpandedBlankKeys((current) => ({
                                                    ...current,
                                                    [bucket.key]: current[bucket.key] !== true
                                                }))
                                            }, h('span', { style: { flex: 1 } },
                                                `空白会话 × ${blanks.length}（${expanded ? '点击收起' : '点击展开'}）`))
                                            : null
                                    );
                                })
                        )
                    ),
                    h('section', null,
                        h('div', { style: { ...S.bar, marginBottom: 8 } },
                            h('h3', { style: { ...S.sectionTitle, margin: 0 } }, '已有整体'),
                            h('span', { style: { flex: 1 } }),
                            h('button', { type: 'button', style: S.primary, onClick: () => { setWizard(true); setStep(1); setLead(''); setMembers([]); setName(''); setError(''); } }, '创建一个整体')
                        ),
                        groups.length === 0
                            ? h('div', { style: S.dim }, '还没有整体。点「创建一个整体」。')
                            : groups.map((group) => h(GroupCard, {
                                key: group.id,
                                group,
                                byId,
                                sessions: wizardSessions,
                                onOpen: open,
                                onDissolve: dissolve,
                                onRename: rename,
                                onUpdateMembers: updateMembers
                            })),
                        wizard ? h('div', { style: S.wizard },
                            h('div', { style: { fontWeight: 600, marginBottom: 8 } },
                                step === 1 ? '第 1 步：选主会话' : step === 2 ? '第 2 步：选执行会话' : '第 3 步：给整体命名'),
                            step === 1
                                ? h('div', { style: S.list }, wizardSessions.length === 0
                                    ? h('div', { style: S.dim }, '没有可选会话')
                                    : wizardSessions.map((item) => h('label', { key: item.sessionId, style: S.row, title: item.sessionId },
                                        h('input', { type: 'radio', name: 'ms2-lead', checked: lead === item.sessionId, onChange: () => { setLead(item.sessionId); setMembers((current) => current.filter((id) => id !== item.sessionId)); } }),
                                        h('span', { title: item.sessionId, style: { flex: 1 } }, item.title),
                                        item.isBlank ? h('span', { style: { ...S.dim, fontSize: 11 } }, '新会话，尚未开始对话') : null,
                                        h('span', { style: S.dim }, '·'),
                                        h('span', { style: S.dim, title: item.sessionId }, shortId(item.sessionId))
                                    )))
                                : null,
                            step === 2
                                ? h('div', { style: S.list }, wizardSessions.filter((item) => item.sessionId !== lead).map((item) => h('label', { key: item.sessionId, style: S.row, title: item.sessionId },
                                    h('input', { type: 'checkbox', checked: members.includes(item.sessionId), onChange: () => toggleMember(item.sessionId) }),
                                    h('span', { title: item.sessionId, style: { flex: 1 } }, item.title),
                                    item.isBlank ? h('span', { style: { ...S.dim, fontSize: 11 } }, '新会话，尚未开始对话') : null,
                                    h('span', { style: S.dim }, '·'),
                                    h('span', { style: S.dim, title: item.sessionId }, shortId(item.sessionId))
                                )))
                                : null,
                            step === 3
                                ? h('input', { style: S.input, value: name, placeholder: '整体名，例如 团队 A', onChange: (e) => setName(e.target.value) })
                                : null,
                            h('div', { style: { ...S.bar, marginTop: 10 } },
                                h('button', { type: 'button', style: S.button, disabled: step === 1, onClick: () => setStep(step - 1) }, '上一步'),
                                h('button', {
                                    type: 'button', style: S.primary, disabled: !canNext || busy,
                                    onClick: () => { if (step === 3) void submit(); else setStep(step + 1); }
                                }, step === 3 ? '创建' : '下一步'),
                                h('button', { type: 'button', style: S.button, onClick: () => { setWizard(false); setError(''); } }, '取消')
                            )
                        ) : null
                    )
                )
            );
        }

        return {
            name: 'dsh-supergroup-client',
            inject: ['slots', 'remote', 'remote.commands', 'uiWorkspace'],
            apply(ctx) {
                const withCtx = (props) => h(Panel, Object.assign({}, props, { __ctx: ctx }));
                // 侧栏入口与主面板用同一 id/key 成对注册：点侧栏直接落到本面板。
                ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
                    { name: 'sidebar.panellist', id: PANEL_ID, order: 12, label: '超级代理部署' },
                    // 侧栏自己会渲染 label，这里只交图标，避免文字重复与收起态溢出。
                    function SidebarEntry({ size = 16, active = false }) {
                        return h('span', {
                            style: { display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: active ? 1 : 0.75 }
                        }, h(NodeIcon, { size }));
                    }
                ));
                ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, withCtx));
            }
        };
    }
});
