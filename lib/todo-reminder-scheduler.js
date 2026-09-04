// 拾光记 · 待办到点调度器
// 优先使用 Hana TaskRegistry 的持久化 runAt 调度；旧宿主或调度能力不可用时，
// 自动退回 30 秒扫描。两条路径共用同一份加密送达状态，避免重启/重复触发。
// 文件预算豁免：TaskRegistry、旧宿主退回扫描和送达状态必须共用同一调度边界。

import {
  TODO_REMINDER_TASK_TYPE,
  TODO_REMINDER_POLL_INTERVAL_MS,
  TODO_REMINDER_RETRY_DELAY_MS,
  buildTodoReminderPayload,
  isReminderDelivered,
  reminderStateForKey,
  todoReminderKey,
  todoReminderRunAt,
  todoReminderScheduleId,
} from "./todo-reminder.js";
import { readHanaUserName } from "./user-name.js";

const PLUGIN_ID = "shiguangji";
const BUS_REQUEST_TIMEOUT_MS = 8 * 1000;
const SESSION_CREATE_TIMEOUT_MS = 15 * 1000;
const NOTIFICATION_TIMEOUT_MS = 3 * 1000;

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}超时（${ms}ms）`)), ms);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function sessionFromResult(result) {
  const value = result?.session && typeof result.session === "object" ? result.session : result;
  if (!value || typeof value !== "object") return null;
  const sessionId = text(value.sessionId || value.id || value.sessionRef?.sessionId);
  const sessionPath = text(value.sessionPath || value.path || value.sessionRef?.sessionPath || value.sessionRef?.path);
  const agentId = text(value.agentId || value.session?.agentId);
  if (!sessionId && !sessionPath) return null;
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(sessionPath ? { sessionPath } : {}),
    ...(agentId ? { agentId } : {}),
  };
}

function safeAgentList(result) {
  return Array.isArray(result?.agents) ? result.agents.filter((item) => item && typeof item === "object") : [];
}

function isPublicAgent(agent) {
  const visibility = text(agent?.visibility).toLowerCase();
  return visibility !== "private" && visibility !== "plugin_private";
}

function shortTitle(value) {
  return text(value).replace(/\s+/g, " ").slice(0, 64) || "一件待办";
}

function samePlan(a, b) {
  return !!a && !!b && a.key === b.key && a.runAt === b.runAt && a.scheduleId === b.scheduleId;
}

export class TodoReminderScheduler {
  constructor({ ctx, data, now = () => Date.now(), log = ctx?.log } = {}) {
    this.ctx = ctx || {};
    this.data = data;
    this.now = now;
    this.log = log || {};
    this.mode = "idle"; // idle | task | poll | disabled
    this.ready = null;
    this.pollTimer = null;
    this.retryTimers = new Map();
    this.inFlight = new Set();
    this.knownPlans = new Map();
    this.refreshQueue = Promise.resolve();
    this.agentIdPromise = null;
  }

  start() {
    if (this.ready) return this.ready;
    this.ready = this.startInternal().catch((error) => {
      this.log?.warn?.("[拾光记] 待办提醒调度器启动失败：", error?.message || error);
      this.mode = "disabled";
    });
    return this.ready;
  }

  async startInternal() {
    // 送达需要“新会话 + 可定位的系统弹窗通知”两个能力；路由单元测试和旧的极简宿主
    // 只有 request 时，不把普通模型调用误当成调度能力。
    if (!this.data || typeof this.ctx?.bus?.request !== "function" || typeof this.ctx?.bus?.emit !== "function") {
      this.mode = "disabled";
      return;
    }

    try {
      const result = await this.requestBus("task:register-handler", {
        type: TODO_REMINDER_TASK_TYPE,
        abort: (schedule) => this.abortSchedule(schedule),
        run: (schedule) => this.runScheduled(schedule),
      }, BUS_REQUEST_TIMEOUT_MS);
      if (result?.ok !== true) throw new Error("宿主没有确认待办调度处理器");
      this.mode = "task";
      await this.refreshNow();
    } catch (error) {
      // TaskRegistry 是较新的宿主能力；不能让它的缺失挡住旧 Hana 的待办功能。
      this.log?.warn?.("[拾光记] 宿主调度不可用，改用 30 秒补扫：", error?.message || error);
      this.mode = "poll";
      this.startPoller();
      await this.refreshNow();
    }
  }

  startPoller() {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      this.refreshAll().catch((error) => {
        this.log?.warn?.("[拾光记] 待办提醒补扫失败：", error?.message || error);
      });
    }, TODO_REMINDER_POLL_INTERVAL_MS);
    this.pollTimer.unref?.();
  }

  eventChanged(event, removedId = "") {
    const id = text(event?.id || removedId);
    void this.start()
      .then(() => this.refreshAll(id ? { onlyId: id } : {}))
      .catch((error) => this.log?.warn?.("[拾光记] 待办调度更新失败：", error?.message || error));
  }

  refreshAll(options = {}) {
    const next = this.refreshQueue
      .catch(() => {})
      .then(() => this.refreshNow(options));
    this.refreshQueue = next.catch(() => {});
    return next;
  }

  async refreshNow({ onlyId = "" } = {}) {
    if (this.mode === "idle") return;
    const events = onlyId
      ? [this.data.getEvent(onlyId)].filter(Boolean)
      : this.data.listEvents();
    for (const event of events) await this.syncEvent(event);
    if (onlyId && !this.data.getEvent(onlyId)) await this.syncRemovedEvent(onlyId);
  }

  async syncEvent(event) {
    const id = text(event?.id);
    if (!id) return;
    const key = todoReminderKey(event);
    const scheduleId = todoReminderScheduleId(id);
    const previous = this.data.getTodoReminder(id);

    // 只有「未完成、一次性、已填具体时间」的待办会进入主动提醒。
    // 无时间的旧待办仍保留在日历里，等用户编辑补齐时间。
    if (!key || event.done || event.repeatYearly) {
      if (this.mode === "task" && previous?.scheduleId) {
        await this.unschedule(previous.scheduleId);
      }
      this.knownPlans.delete(id);
      this.clearRetryTimer(id);
      if (event.type !== "todo" && previous) await this.data.removeTodoReminder(id);
      return;
    }

    const scheduleState = reminderStateForKey(previous, key, scheduleId);
    const keyChanged = !!previous && previous.key !== key;
    const state = await this.persistNormalizedState(id, previous, scheduleState);
    if (isReminderDelivered(state, key)) {
      if (this.mode === "task") await this.unschedule(state.scheduleId || scheduleId);
      this.knownPlans.delete(id);
      this.clearRetryTimer(id);
      return;
    }

    const retryAt = Number(state.nextRetryAt) || 0;
    const now = this.now();
    const runAt = retryAt > now ? retryAt : todoReminderRunAt(event, now);
    if (runAt === null) return;

    if (this.mode === "poll") {
      if (runAt <= now + 20 && (!retryAt || retryAt <= now)) {
        await this.deliverEvent(event, state);
      } else if (retryAt > now) {
        this.armRetryTimer(id, retryAt);
      }
      return;
    }
    if (this.mode !== "task") return;

    const plan = { key, runAt, scheduleId };
    const known = this.knownPlans.get(id);
    // 首次接管、时间被编辑、或 key 变化时先撤掉旧的一次性计划；否则宿主会保留旧 nextRunAt。
    if (keyChanged || !known) await this.unschedule(scheduleId);
    if (samePlan(known, plan)) return;

    const result = await this.requestBus("task:schedule", {
      scheduleId,
      type: TODO_REMINDER_TASK_TYPE,
      pluginId: this.pluginId,
      payload: { eventId: id, key },
      meta: { source: "shiguangji", kind: "todo-reminder" },
      runAt,
      enabled: true,
    }, BUS_REQUEST_TIMEOUT_MS);
    if (result?.ok !== true) throw new Error("宿主没有确认待办提醒计划");
    this.knownPlans.set(id, plan);
  }

  async syncRemovedEvent(id) {
    const key = text(id);
    if (!key) return;
    const state = this.data.getTodoReminder(key);
    if (this.mode === "task") await this.unschedule(state?.scheduleId || todoReminderScheduleId(key));
    this.knownPlans.delete(key);
    this.clearRetryTimer(key);
    if (state) await this.data.removeTodoReminder(key);
  }

  async persistNormalizedState(id, previous, normalized) {
    const current = previous && typeof previous === "object" ? previous : null;
    const inFlight = this.inFlight.has(id);
    let next = normalized;
    if (inFlight && current?.status === "sending" && current.key === normalized.key) {
      next = { ...normalized, status: "sending" };
    }
    const currentJson = current ? JSON.stringify(current) : "";
    if (!current || currentJson !== JSON.stringify(next)) {
      return this.data.saveTodoReminder(id, next);
    }
    return current;
  }

  async runScheduled(schedule) {
    const eventId = text(schedule?.payload?.eventId);
    const scheduledKey = text(schedule?.payload?.key);
    if (!eventId) return { skipped: true, reason: "missing-event" };
    const nextRunAt = Number(schedule?.nextRunAt);
    if (Number.isFinite(nextRunAt) && nextRunAt > this.now() + 20) {
      return { skipped: true, reason: "early-plan" };
    }
    this.knownPlans.delete(eventId);
    const event = this.data.getEvent(eventId);
    if (!event || todoReminderKey(event) !== scheduledKey || event.done || event.repeatYearly) {
      return { skipped: true, reason: "stale-plan" };
    }
    const state = this.data.getTodoReminder(eventId);
    if (isReminderDelivered(state, scheduledKey)) return { skipped: true, reason: "already-delivered" };
    if (Number(state?.nextRetryAt) > this.now()) return { skipped: true, reason: "retry-backoff" };
    await this.deliverEvent(event, state);
    return { delivered: isReminderDelivered(this.data.getTodoReminder(eventId), scheduledKey) };
  }

  abortSchedule(schedule) {
    const eventId = text(schedule?.payload?.eventId);
    if (!eventId) return;
    this.clearRetryTimer(eventId);
    this.knownPlans.delete(eventId);
  }

  async deliverEvent(event, state) {
    const id = text(event?.id);
    const key = todoReminderKey(event);
    if (!id || !key || this.inFlight.has(id)) return false;
    if (isReminderDelivered(state, key)) return true;
    this.inFlight.add(id);
    let target = null;
    try {
      const liveEvent = this.data.getEvent(id);
      if (!liveEvent || todoReminderKey(liveEvent) !== key || liveEvent.done || liveEvent.repeatYearly) return false;
      const liveState = this.data.getTodoReminder(id);
      if (liveState?.key && liveState.key !== key) return false;
      const base = reminderStateForKey(liveState || state, key, todoReminderScheduleId(id));
      target = await this.ensureSession(liveEvent, base);
      // 用户可能在建会话期间编辑/删除了待办；旧请求不能覆盖新 key 的状态。
      const beforeSendEvent = this.data.getEvent(id);
      const beforeSendState = this.data.getTodoReminder(id);
      if (!beforeSendEvent || todoReminderKey(beforeSendEvent) !== key || beforeSendEvent.done || beforeSendEvent.repeatYearly) return false;
      if (beforeSendState?.key && beforeSendState.key !== key) return false;
      const attempts = (Number(base.attempts) || 0) + 1;
      const attemptTime = this.now();
      const sending = {
        ...base,
        ...target,
        status: "sending",
        attempts,
        lastAttemptAt: new Date(attemptTime).toISOString(),
        nextRetryAt: 0,
        lastError: "",
      };
      await this.data.saveTodoReminder(id, sending);

      const reminderName = readHanaUserName();
      const payload = buildTodoReminderPayload(beforeSendEvent, {
        userName: reminderName,
        now: new Date(attemptTime),
      });
      const sent = await this.requestBus("session:send", {
        text: payload.text,
        ...(target.sessionId ? { sessionId: target.sessionId } : {}),
        ...(target.sessionPath ? { sessionPath: target.sessionPath } : {}),
        context: {
          // 具体待办走 Hana 的隐藏回合上下文，前端只会看到 payload.text。
          beforeUser: payload.beforeUser,
          metadata: {
            pluginId: this.pluginId,
            reminderId: id,
            kind: "todo-reminder",
          },
        },
      }, BUS_REQUEST_TIMEOUT_MS);
      if (sent?.ok === false || sent?.accepted === false) {
        throw new Error(sent.error || "宿主没有接受待办提醒消息");
      }

      const deliveredAt = new Date(this.now()).toISOString();
      const afterSendEvent = this.data.getEvent(id);
      const afterSendState = this.data.getTodoReminder(id);
      if (!afterSendEvent || todoReminderKey(afterSendEvent) !== key || (afterSendState?.key && afterSendState.key !== key)) {
        if (afterSendState?.key === key) await this.data.removeTodoReminder(id);
        return true;
      }
      await this.data.saveTodoReminder(id, {
        ...sending,
        status: "delivered",
        sentAt: deliveredAt,
        deliveredAt,
        nextRetryAt: 0,
        lastError: "",
      });
      this.clearRetryTimer(id);
      await this.emitNotification(payload, target);
      this.log?.info?.(`[拾光记] 待办已提醒：${event.title}`);
      return true;
    } catch (error) {
      const current = this.data.getTodoReminder(id);
      // 编辑时间时旧请求可能还在路上，不能让旧失败回写覆盖新时间的状态。
      if (current?.key === key) {
        const nextRetryAt = this.now() + TODO_REMINDER_RETRY_DELAY_MS;
        await this.data.saveTodoReminder(id, {
          ...current,
          status: "pending",
          nextRetryAt,
          lastError: String(error?.message || error).slice(0, 300),
          ...(target || {}),
        });
        this.armRetryTimer(id, nextRetryAt);
      }
      this.log?.warn?.(`[拾光记] 待办提醒失败，将在稍后重试：${event.title}`, error?.message || error);
      return false;
    } finally {
      this.inFlight.delete(id);
    }
  }

  async ensureSession(event, state) {
    let target = {
      ...(text(state?.sessionId) ? { sessionId: text(state.sessionId) } : {}),
      ...(text(state?.sessionPath) ? { sessionPath: text(state.sessionPath) } : {}),
      ...(text(state?.agentId) ? { agentId: text(state.agentId) } : {}),
    };

    if ((!target.sessionId || !target.sessionPath) && (target.sessionId || target.sessionPath)) {
      try {
        const result = await this.requestBus("session:get", {
          ...(target.sessionId ? { sessionId: target.sessionId } : {}),
          ...(target.sessionPath ? { sessionPath: target.sessionPath } : {}),
        }, BUS_REQUEST_TIMEOUT_MS);
        target = { ...target, ...(sessionFromResult(result) || {}) };
      } catch {
        // 只缺一个定位字段时，继续用已有字段发送；宿主会给出最终裁决。
      }
    }
    // 当前宿主的 session:send 会用双定位校验；只剩一个字段时宁可新建，
    // 不把一条“请求成功但消息没落到会话里”的假送达写进状态。
    if (!(target.sessionId && target.sessionPath)) {
      target = target.agentId ? { agentId: target.agentId } : {};
    } else {
      return target;
    }

    const agentId = target.agentId || await this.resolveAgentId();
    if (!agentId) throw new Error("没有找到可接收提醒的助手");
    const created = await this.requestBus("session:create", {
      agentId,
      ownerPluginId: this.pluginId,
      visibility: "public",
      kind: "chat",
      memoryEnabled: true,
    }, SESSION_CREATE_TIMEOUT_MS);
    const createdTarget = sessionFromResult(created);
    if (!createdTarget) throw new Error("新对话没有返回有效的 sessionId/sessionPath");
    const finalTarget = { ...createdTarget, agentId: createdTarget.agentId || agentId };

    // 宿主目前对 session:create 的 title 兼容并不一致，创建后单独改名。
    try {
      await this.requestBus("session:update", {
        ...(finalTarget.sessionId ? { sessionId: finalTarget.sessionId } : {}),
        ...(finalTarget.sessionPath ? { sessionPath: finalTarget.sessionPath } : {}),
        title: `拾光记 · 待办提醒 · ${shortTitle(event.title)}`,
      }, BUS_REQUEST_TIMEOUT_MS);
    } catch (error) {
      this.log?.debug?.("[拾光记] 待办提醒会话改名失败：", error?.message || error);
    }
    return finalTarget;
  }

  async resolveAgentId() {
    if (this.agentIdPromise) return this.agentIdPromise;
    this.agentIdPromise = (async () => {
      const direct = text(this.ctx?.agentId || this.ctx?.agent?.id);
      if (direct && direct !== this.pluginId) return direct;
      try {
        const result = await this.requestBus("agent:list", { includePluginPrivate: false }, BUS_REQUEST_TIMEOUT_MS);
        const agents = safeAgentList(result).filter(isPublicAgent);
        const current = agents.find((agent) => agent.isCurrent === true);
        const primary = agents.find((agent) => agent.isPrimary === true);
        const hanako = agents.find((agent) => text(agent.id) === "hanako");
        const first = agents.find((agent) => text(agent.id));
        return text((current || primary || hanako || first)?.id);
      } catch (error) {
        this.log?.warn?.("[拾光记] 获取当前助手失败，回退 hanako：", error?.message || error);
        return "hanako";
      }
    })();
    try {
      return await this.agentIdPromise;
    } finally {
      this.agentIdPromise = null;
    }
  }

  async emitNotification(payload, target) {
    const emit = this.ctx?.bus?.emit;
    if (typeof emit !== "function") return;
    const sessionPath = text(target?.sessionPath);
    const event = {
      type: "notification",
      title: payload.notificationTitle,
      body: payload.notificationBody,
      agentId: text(target?.agentId) || null,
      desktopFocusPolicy: "always",
      openKind: "session",
      ...(sessionPath ? { sessionPath } : {}),
    };
    try {
      await withTimeout(Promise.resolve(emit.call(this.ctx.bus, event, sessionPath || null)), NOTIFICATION_TIMEOUT_MS, "系统弹窗通知");
    } catch (error) {
      // 系统弹窗通知失败不能把已经送进新对话的待办重新判成失败，否则会重复发消息。
      this.log?.warn?.("[拾光记] 系统弹窗通知没有显示：", error?.message || error);
    }
  }

  async unschedule(scheduleId) {
    const id = text(scheduleId);
    if (!id || typeof this.ctx?.bus?.request !== "function") return;
    try {
      await this.requestBus("task:unschedule", { scheduleId: id }, BUS_REQUEST_TIMEOUT_MS);
    } catch (error) {
      // 旧宿主没有 task:* 时由外层启动流程切到轮询；这里不阻塞事件保存。
      if (this.mode === "task") throw error;
    }
  }

  requestBus(typeName, payload, timeoutMs) {
    if (typeof this.ctx?.bus?.request !== "function") throw new Error("Hana 会话总线不可用");
    const request = this.ctx.bus.request(typeName, payload, { timeoutMs });
    return withTimeout(request, timeoutMs, typeName);
  }

  armRetryTimer(eventId, retryAt) {
    const id = text(eventId);
    if (!id) return;
    this.clearRetryTimer(id);
    const delay = Math.max(100, Number(retryAt) - this.now());
    const timer = setTimeout(() => {
      this.retryTimers.delete(id);
      const event = this.data.getEvent(id);
      if (event) this.refreshAll({ onlyId: id }).catch(() => {});
    }, delay);
    timer.unref?.();
    this.retryTimers.set(id, timer);
  }

  clearRetryTimer(eventId) {
    const id = text(eventId);
    const timer = this.retryTimers.get(id);
    if (timer) clearTimeout(timer);
    this.retryTimers.delete(id);
  }

  get pluginId() {
    return text(this.ctx?.pluginId) || PLUGIN_ID;
  }
}

export function __resetTodoReminderSchedulerForTest(scheduler) {
  if (!scheduler) return;
  if (scheduler.pollTimer) clearInterval(scheduler.pollTimer);
  for (const timer of scheduler.retryTimers.values()) clearTimeout(timer);
  scheduler.pollTimer = null;
  scheduler.retryTimers.clear();
  scheduler.knownPlans.clear();
  scheduler.inFlight.clear();
}
