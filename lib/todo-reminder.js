// 拾光记 · 待办到点提醒
// 只负责把已经校验过的待办时间转换成调度信息与送达文案；
// 会话总线、状态持久化和重试由 routes/ui.js 的调度器负责。

import { formatTodoReminderWindow, normalizeReminderTime } from "./todo-time.js";

export const TODO_REMINDER_TASK_TYPE = "shiguangji-todo-reminder";
export const TODO_REMINDER_LEAD_MS = 1 * 60 * 1000;
export const TODO_REMINDER_RETRY_DELAY_MS = 60 * 1000;
export const TODO_REMINDER_POLL_INTERVAL_MS = 30 * 1000;

export function todoReminderKey(event) {
  if (!event || event.type !== "todo") return "";
  const date = String(event.date || "").trim();
  const start = normalizeReminderTime(event.reminderStart);
  const end = normalizeReminderTime(event.reminderEnd);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !start || !end) return "";
  return `${date}|${start}|${end}`;
}

export function todoReminderScheduleId(eventId) {
  const id = String(eventId || "").trim();
  return id ? `shiguangji-todo-${id}` : "";
}

export function todoReminderAt(event) {
  const key = todoReminderKey(event);
  if (!key || event.done || event.repeatYearly) return null;
  const [, start] = key.split("|");
  const value = new Date(`${event.date}T${start}:00`);
  const [year, month, day] = event.date.split("-").map(Number);
  if (
    value.getFullYear() !== year
    || value.getMonth() + 1 !== month
    || value.getDate() !== day
  ) return null;
  const timestamp = value.getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function todoReminderRunAt(event, nowMs = Date.now()) {
  const target = todoReminderAt(event);
  if (target === null) return null;
  // 提前一分钟启动新会话和模型生成；已经进入提前窗口或逾期时立即补送。
  const triggerAt = target - TODO_REMINDER_LEAD_MS;
  // 给 setTimeout 留一个异步 tick，避免在刚写完调度记录的同一调用栈里重入送达。
  return triggerAt > nowMs ? triggerAt : nowMs + 10;
}

export function formatReminderWindow(event) {
  return formatTodoReminderWindow(event?.reminderStart, event?.reminderEnd) || "已到时间";
}

export function buildTodoReminderPayload(event, { userName = "", now = new Date() } = {}) {
  const title = String(event?.title || "这件待办").trim() || "这件待办";
  const window = formatReminderWindow(event);
  const target = todoReminderAt(event);
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const overdue = target !== null && Number.isFinite(nowMs) && target < nowMs - 60 * 1000;
  const lead = overdue ? `原定 ${window}，刚刚已经到时间了` : `${window} 到时间啦`;
  const name = String(userName || "").trim() || "对方";
  return {
    // session:send 的 text 会进入可见会话流，改成拾光记自己的提醒口吻；具体待办仍留在隐藏上下文。
    text: `拾光记提醒：${lead}。`,
    // 具体待办只放进 context.beforeUser：它只给本轮模型请求看，不改可见用户消息。
    beforeUser: [
      "这是拾光记触发的待办提醒。",
      `触发情况：${lead}。`,
      `请直接、自然地提醒${name}去做「${title}」。`,
      "不要提及技术实现，不要说事情已经完成，也不要复述这段隐藏提示。",
    ].join("\n"),
    notificationTitle: "拾光记 · 待办提醒",
    notificationBody: `${lead}：${title}`,
    window,
    overdue,
  };
}

export function reminderStateForKey(state, key, scheduleId) {
  const current = state && typeof state === "object" ? state : {};
  if (current.key === key) {
    return {
      ...current,
      scheduleId: current.scheduleId || scheduleId,
      status: current.status === "sending" || current.status === "failed" ? "pending" : (current.status || "pending"),
      attempts: Number.isFinite(Number(current.attempts)) ? Number(current.attempts) : 0,
    };
  }
  return {
    key,
    scheduleId,
    status: "pending",
    attempts: 0,
    lastError: "",
    nextRetryAt: 0,
    sessionId: "",
    sessionPath: "",
    agentId: "",
    sentAt: "",
    deliveredAt: "",
  };
}

export function isReminderDelivered(state, key) {
  return state?.key === key && state?.status === "delivered" && !!state?.deliveredAt;
}
