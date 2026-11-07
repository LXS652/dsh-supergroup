/**
 * 成员上报后的主会话唤醒。
 *
 * 这里只做一件事：把一条固定格式的 followup 消息投给整体 lead。
 * - 直接走 sessionController.prompt，不经过工具 guard；唤醒是插件内部动作，
 *   不是成员获得的新工具，也不改变任何权限。
 * - 不 await：prompt 失败只记 wakeErrors，不能让 ms2_report 失败或变慢。
 * - 幂等键是 ms-wake-<taskRequestId>-<status>；同一单同一状态只投一次。
 */

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
const MAX_SUMMARY_CHARS = 200;

/** 与上报路径相同的去控制字符处理，再折叠空白，避免换行/制表符破坏固定格式。 */
export function cleanWakeSummary(value) {
    return String(value === undefined || value === null ? '' : value)
        .replace(CONTROL_CHARS, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** 按 Unicode 码点截断，避免把代理对切成半个字符。 */
export function truncateWakeSummary(value, limit = MAX_SUMMARY_CHARS) {
    const text = cleanWakeSummary(value);
    const chars = [...text];
    return chars.length <= limit ? text : chars.slice(0, limit).join('');
}

export function buildWakeText({ label, taskRequestId, state, summary }) {
    const who = typeof label === 'string' && label.length > 0 ? label : '未命名成员';
    return `[成员上报] ${who} · ${taskRequestId} · ${state}：${truncateWakeSummary(summary)}（详情：调用 ms2_status）`;
}

/**
 * @param {object} options
 * @param {() => object | undefined | null} options.getController 每次唤醒时取 sessionController
 * @param {number} [options.maxErrors] 最多保留多少条唤醒错误
 */
export function createWaker({ getController, maxErrors = 20 } = {}) {
    if (typeof getController !== 'function') throw new Error('WAKER_GET_CONTROLLER_REQUIRED');
    const sent = new Set();
    const errors = [];

    function recordError(error, payload) {
        errors.push({
            at: new Date().toISOString(),
            groupId: payload && typeof payload.groupId === 'string' ? payload.groupId : null,
            taskRequestId: payload && typeof payload.taskRequestId === 'string' ? payload.taskRequestId : null,
            requestId: payload && typeof payload.wakeRequestId === 'string' ? payload.wakeRequestId : null,
            code: error && typeof error.code === 'string' ? error.code : null,
            message: error instanceof Error ? error.message : String(error)
        });
        if (errors.length > maxErrors) errors.splice(0, errors.length - maxErrors);
    }

    /**
     * 立即触发一次唤醒；返回 {status, requestId}。
     * status: sent | skipped-self | duplicate | error。
     * 这个函数本身不抛异常，调用方（Coordinator）不需要 try/catch 也能保证上报成功。
     */
    function wake(payload) {
        if (payload === null || typeof payload !== 'object') return { status: 'error' };
        const leadSessionId = payload.leadSessionId;
        const reporterSessionId = payload.reporterSessionId;
        if (typeof leadSessionId !== 'string' || leadSessionId.length === 0) return { status: 'error' };
        if (leadSessionId === reporterSessionId) return { status: 'skipped-self' };
        if (typeof payload.taskRequestId !== 'string' || payload.taskRequestId.length === 0) return { status: 'error' };
        if (typeof payload.status !== 'string' || payload.status.length === 0) return { status: 'error' };

        const wakeRequestId = `ms-wake-${payload.taskRequestId}-${payload.status}`;
        if (sent.has(wakeRequestId)) return { status: 'duplicate', requestId: wakeRequestId };

        const enriched = { ...payload, wakeRequestId };
        let controller;
        try {
            controller = getController();
        } catch (error) {
            sent.add(wakeRequestId);
            recordError(error, enriched);
            return { status: 'error', requestId: wakeRequestId };
        }
        if (!controller || typeof controller.prompt !== 'function') {
            sent.add(wakeRequestId);
            recordError(new Error('NO_SESSION_CONTROLLER'), enriched);
            return { status: 'error', requestId: wakeRequestId };
        }

        // 先登记再投递：同步重入（同一事件被两处监听）也不能重复 prompt。
        sent.add(wakeRequestId);
        const text = buildWakeText({
            label: payload.label,
            taskRequestId: payload.taskRequestId,
            state: payload.state,
            summary: payload.summary
        });
        const request = {
            sessionId: leadSessionId,
            requestId: wakeRequestId,
            content: [{ type: 'text', text }],
            mode: 'followup'
        };
        try {
            // controller.prompt 的第一个宿主实现会调用 signal.throwIfAborted()，必须给真实 signal。
            const pending = controller.prompt(request, new AbortController().signal);
            if (pending && typeof pending.then === 'function') {
                pending.catch(error => recordError(error, enriched));
            }
            return { status: 'sent', requestId: wakeRequestId };
        } catch (error) {
            recordError(error, enriched);
            return { status: 'error', requestId: wakeRequestId };
        }
    }

    return {
        wake,
        errors() {
            return errors.slice();
        }
    };
}
