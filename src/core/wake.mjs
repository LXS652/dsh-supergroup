/**
 * 成员 → 主会话的唤醒出口。
 *
 * 两条链路共用这里：
 * - report：成员上报后唤醒 lead，requestId 由工单决定；
 * - notify：成员无工单时主动通知，按「成员 + 整体 + 摘要」去重。
 *
 * 约束：
 * - 直接走 sessionController.prompt，不经过工具 guard；
 * - report 路径不 await，失败只记下来，绝不能让上报失败或变慢；
 * - notify 路径 await 一次有界 ack（默认 5 秒），超时只 abort 准入，不 steer；
 * - 每成员 60 秒 6 条，report 与 notify 共用同一个计数器。
 */
import { createHash } from 'node:crypto';

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
const MAX_SUMMARY_CHARS = 200;
const MAX_DETAIL_CHARS = 2000;
const REPORT_DEDUPE_WINDOW_MS = 60_000;

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

/** notify 的固定模板；摘要永远是清洗后按码点截断的纯文本。 */
export function buildNotifyText({ label, groupName, summary }) {
    const who = typeof label === 'string' && label.length > 0 ? label : '未命名成员';
    const where = typeof groupName === 'string' && groupName.length > 0 ? groupName : '整体';
    return `[成员通知] ${who} · ${where}：${truncateWakeSummary(summary)}（详情：调用 ms2_status）`;
}

/**
 * 每成员 60 秒滑动窗口。内存态，重启归零（设计 §4.3）。
 * reserve 返回 {ok, retryAfterMs, remaining}。
 */
function createLimiter({ perMinute = 6, windowMs = 60_000, now = () => Date.now() } = {}) {
    const hits = new Map();
    return {
        reserve(sessionId) {
            const at = now();
            const list = (hits.get(sessionId) ?? []).filter(timestamp => at - timestamp < windowMs);
            if (list.length >= perMinute) {
                const retryAfterMs = Math.max(1, windowMs - (at - list[0]));
                hits.set(sessionId, list);
                return { ok: false, retryAfterMs };
            }
            list.push(at);
            hits.set(sessionId, list);
            return { ok: true, remaining: perMinute - list.length };
        }
    };
}

/** 去掉 g- 前缀后取 8 位；短 id 原样，避免生成空段。 */
function groupPart(groupId) {
    const text = typeof groupId === 'string' ? groupId.replace(/^g-/, '') : '';
    return text.slice(0, 8) || 'unknown';
}

function notifyDedupeKey(caller, groupId, summary) {
    return createHash('sha256')
        .update(`${caller}\n${groupId}\n${summary}`, 'utf8')
        .digest('hex')
        .slice(0, 16);
}

/**
 * @param {object} options
 * @param {() => object | undefined | null} options.getController 每次唤醒时取 sessionController
 * @param {number} [options.maxErrors] 最多保留多少条唤醒错误
 * @param {(entry: object) => void | Promise<void>} [options.onFailure] 失败回调（写账本 / 内存 ring）
 * @param {{perMinute?: number, windowMs?: number, now?: () => number}} [options.limit] 频控注入
 * @param {number} [options.timeoutMs] 单次 ack 看门狗，默认 5000
 * @param {{setTimeout: Function, clearTimeout: Function}} [options.timers] 测试注入
 */
export function createWaker({
    getController,
    maxErrors = 20,
    onFailure = null,
    limit = {},
    timeoutMs = 5_000,
    timers = {}
} = {}) {
    if (typeof getController !== 'function') throw new Error('WAKER_GET_CONTROLLER_REQUIRED');
    const clock = typeof limit.now === 'function' ? limit.now : () => Date.now();
    const limiter = createLimiter({
        perMinute: Number.isSafeInteger(limit.perMinute) ? limit.perMinute : 6,
        windowMs: Number.isSafeInteger(limit.windowMs) ? limit.windowMs : 60_000,
        now: clock
    });
    const timerSet = typeof timers.setTimeout === 'function' ? timers.setTimeout : setTimeout;
    const timerClear = typeof timers.clearTimeout === 'function' ? timers.clearTimeout : clearTimeout;
    const sent = new Set();
    const notifySeen = new Map();
    const errors = [];

    function recordFailure(entry) {
        errors.push(entry);
        if (errors.length > maxErrors) errors.splice(0, errors.length - maxErrors);
        if (typeof onFailure === 'function') {
            try {
                const pending = onFailure(entry);
                if (pending && typeof pending.catch === 'function') pending.catch(() => {});
            } catch {
                // 失败回调本身不能把调用方拖下水。
            }
        }
    }

    function failureOf(error) {
        const code = error && typeof error.code === 'string' && error.code.length > 0 ? error.code : 'WAKE_FAILED';
        return {
            code,
            message: truncateWakeSummary(error instanceof Error ? error.message : String(error), 300),
            maybeQueued: error && error.maybeQueued === true
        };
    }

    function emitFailure(meta, error, outcome, extra = {}) {
        const info = failureOf(error);
        recordFailure({
            at: new Date(clock()).toISOString(),
            groupId: typeof meta.groupId === 'string' ? meta.groupId : null,
            taskRequestId: typeof meta.taskRequestId === 'string' ? meta.taskRequestId : null,
            requestId: typeof meta.requestId === 'string' ? meta.requestId : null,
            memberSessionId: typeof meta.memberSessionId === 'string' ? meta.memberSessionId : null,
            outcome,
            code: info.code,
            message: info.message,
            summary: truncateWakeSummary(meta.summary),
            detail: meta.detail === undefined ? null : truncateWakeSummary(meta.detail, MAX_DETAIL_CHARS),
            maybeQueued: info.maybeQueued,
            ...extra
        });
    }

    function timeoutRace(abortController) {
        let timer = null;
        const promise = new Promise((resolve, reject) => {
            timer = timerSet(() => {
                try {
                    abortController.abort();
                } catch {
                    // abort 只影响准入，失败照常落账。
                }
                const error = new Error('WAKE_TIMEOUT');
                error.code = 'WAKE_TIMEOUT';
                error.maybeQueued = true;
                reject(error);
            }, timeoutMs);
            if (timer && typeof timer.unref === 'function') timer.unref();
            // 让 Promise.race 拿到同一个计时器；resolve 只用于清理。
            void resolve;
        });
        return {
            promise,
            clear() {
                if (timer !== null) timerClear(timer);
            }
        };
    }

    function promptOnce({ request, meta, shouldAwait }) {
        const controller = getController();
        if (!controller || typeof controller.prompt !== 'function') {
            const error = new Error('NO_SESSION_CONTROLLER');
            error.code = 'NO_SESSION_CONTROLLER';
            emitFailure(meta, error, 'failed');
            return { ok: false, error };
        }
        const abortController = new AbortController();
        const race = timeoutRace(abortController);
        let pending;
        try {
            pending = controller.prompt(request, abortController.signal);
        } catch (error) {
            race.clear();
            emitFailure(meta, error, 'failed');
            return { ok: false, error };
        }
        const settled = Promise.resolve(pending);
        const guarded = Promise.race([settled, race.promise]).then(
            value => {
                race.clear();
                return value;
            },
            error => {
                race.clear();
                throw error;
            }
        );
        if (!shouldAwait) {
            guarded.catch(error => emitFailure(meta, error, error && error.code === 'WAKE_TIMEOUT' ? 'timeout' : 'failed'));
            return { ok: true };
        }
        return { ok: true, promise: guarded };
    }

    /**
     * report 唤醒：保持同步返回，prompt 的失败/超时只落失败记录，不影响上报。
     * status: sent | skipped-self | duplicate | rate-limited | error
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

        const reservation = limiter.reserve(reporterSessionId);
        if (!reservation.ok) {
            emitFailure({
                groupId: payload.groupId,
                taskRequestId: payload.taskRequestId,
                requestId: wakeRequestId,
                memberSessionId: reporterSessionId,
                summary: payload.summary
            }, Object.assign(new Error('WAKE_RATE_LIMITED'), { code: 'WAKE_RATE_LIMITED' }), 'rate-limited', {
                retryAfterMs: reservation.retryAfterMs
            });
            return {
                status: 'rate-limited',
                requestId: wakeRequestId,
                wakeCode: 'WAKE_RATE_LIMITED',
                retryAfterMs: reservation.retryAfterMs
            };
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
        const result = promptOnce({
            request,
            shouldAwait: false,
            meta: {
                groupId: payload.groupId,
                taskRequestId: payload.taskRequestId,
                requestId: wakeRequestId,
                memberSessionId: reporterSessionId,
                summary: payload.summary
            }
        });
        if (!result.ok) return { status: 'error', requestId: wakeRequestId, wakeCode: result.error.code || 'WAKE_FAILED' };
        return { status: 'sent', requestId: wakeRequestId };
    }

    /**
     * notify：无工单通知。返回 wake: sent | duplicate | rate-limited | skipped-no-lead | error。
     * 失败不会抛给工具调用方，只写失败记录并回状态。
     */
    async function wakeNotify(payload) {
        const leadSessionId = payload && payload.leadSessionId;
        const reporterSessionId = payload && payload.reporterSessionId;
        const groupId = payload && payload.groupId;
        const summary = cleanWakeSummary(payload && payload.summary);
        const detail = payload && payload.detail !== undefined && payload.detail !== null
            ? truncateWakeSummary(payload.detail, MAX_DETAIL_CHARS)
            : null;
        const baseMeta = {
            groupId,
            taskRequestId: null,
            memberSessionId: reporterSessionId,
            summary,
            detail
        };
        if (leadSessionId === reporterSessionId) return { status: 'skipped-self' };
        if (typeof leadSessionId !== 'string' || leadSessionId.length === 0) {
            const requestId = null;
            emitFailure({ ...baseMeta, requestId }, Object.assign(new Error('WAKE_NO_LEAD'), { code: 'WAKE_NO_LEAD' }), 'no-lead');
            return { status: 'skipped-no-lead', wakeCode: 'WAKE_NO_LEAD', requestId };
        }

        const dedupeKey = notifyDedupeKey(reporterSessionId, groupId, summary);
        const now = clock();
        const seen = notifySeen.get(dedupeKey);
        if (seen !== undefined && now - seen.at < REPORT_DEDUPE_WINDOW_MS) {
            return { status: 'duplicate', requestId: seen.requestId, dedupeKey };
        }

        const requestId = `ms-wake-notify-${groupPart(groupId)}-${dedupeKey.slice(0, 8)}-${Math.floor(now / 60_000)}`;
        const reservation = limiter.reserve(reporterSessionId);
        if (!reservation.ok) {
            emitFailure({ ...baseMeta, requestId }, Object.assign(new Error('WAKE_RATE_LIMITED'), { code: 'WAKE_RATE_LIMITED' }), 'rate-limited', {
                retryAfterMs: reservation.retryAfterMs
            });
            return {
                status: 'rate-limited',
                requestId,
                dedupeKey,
                wakeCode: 'WAKE_RATE_LIMITED',
                retryAfterMs: reservation.retryAfterMs
            };
        }

        const text = buildNotifyText({
            label: payload.label,
            groupName: payload.groupName,
            summary
        });
        const request = {
            sessionId: leadSessionId,
            requestId,
            content: [{ type: 'text', text }],
            mode: 'followup'
        };
        const result = promptOnce({
            request,
            shouldAwait: true,
            meta: { ...baseMeta, requestId }
        });
        if (!result.ok) {
            return { status: 'error', requestId, dedupeKey, wakeCode: result.error.code || 'WAKE_FAILED' };
        }
        // 投递真正开始后才占住去重窗口；被限流/无 controller 的调用不占用，
        // 避免一次临时故障把同一摘要在 60 秒内永久判成 duplicate。
        notifySeen.set(dedupeKey, { at: now, requestId });
        for (const [key, value] of notifySeen) {
            if (now - value.at >= REPORT_DEDUPE_WINDOW_MS) notifySeen.delete(key);
        }
        try {
            await result.promise;
            return { status: 'sent', requestId, dedupeKey };
        } catch (error) {
            const info = failureOf(error);
            emitFailure({ ...baseMeta, requestId }, error, info.code === 'WAKE_TIMEOUT' ? 'timeout' : 'failed');
            return { status: 'error', requestId, dedupeKey, wakeCode: info.code };
        }
    }

    return {
        wake,
        wakeNotify,
        errors() {
            return errors.slice();
        }
    };
}
