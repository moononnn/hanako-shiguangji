import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  TODO_REMINDER_TASK_TYPE,
  TODO_REMINDER_LEAD_MS,
  TODO_REMINDER_RETRY_DELAY_MS,
  buildTodoReminderPayload,
  isReminderDelivered,
  reminderStateForKey,
  todoReminderAt,
  todoReminderKey,
  todoReminderRunAt,
  todoReminderScheduleId,
} from "../lib/todo-reminder.js";
import {
  TodoReminderScheduler,
  __resetTodoReminderSchedulerForTest,
} from "../lib/todo-reminder-scheduler.js";
import { UserData } from "../lib/data.js";

function localDate(year, month, day, hour, minute) {
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

test("宿主契约：manifest 声明提醒所需的 session/task/agent 总线能力", () => {
  const manifest = JSON.parse(fs.readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
  for (const capability of ["session", "task", "agent"]) {
    assert.ok(manifest.capabilities.includes(capability), `manifest 缺少 ${capability} capability`);
  }
});

function todo(id, start = "10:00", end = start) {
  return {
    id,
    title: "带圆宝出去玩",
    type: "todo",
    date: "2026-09-01",
    reminderStart: start,
    reminderEnd: end,
    done: false,
    repeatYearly: false,
  };
}

function makeMemoryData(events = []) {
  const eventMap = new Map(events.map((event) => [event.id, structuredClone(event)]));
  const reminderMap = new Map();
  return {
    listEvents() { return [...eventMap.values()]; },
    getEvent(id) { return eventMap.get(id) || null; },
    setEvent(event) { eventMap.set(event.id, structuredClone(event)); },
    deleteEvent(id) { eventMap.delete(id); },
    getTodoReminder(id) { return reminderMap.get(id) || null; },
    async saveTodoReminder(id, value) {
      reminderMap.set(id, structuredClone(value));
      return structuredClone(value);
    },
    async removeTodoReminder(id) { return reminderMap.delete(id); },
    reminderMap,
  };
}

function makeBus({ register = true, send = null } = {}) {
  const requests = [];
  const notifications = [];
  let sequence = 0;
  let handler = null;
  const bus = {
    requests,
    notifications,
    get handler() { return handler; },
    async request(type, payload) {
      requests.push({ type, payload });
      if (type === "task:register-handler") {
        handler = payload;
        return register ? { ok: true } : { ok: false, error: "unsupported" };
      }
      if (type === "task:schedule" || type === "task:unschedule" || type === "session:update") return { ok: true };
      if (type === "agent:list") {
        return { ok: true, agents: [{ id: "hanako", isPrimary: true, visibility: "public" }] };
      }
      if (type === "session:create") {
        sequence += 1;
        return { ok: true, sessionId: `session-${sequence}`, sessionPath: `path-${sequence}`, agentId: payload.agentId };
      }
      if (type === "session:get") {
        return { ok: true, sessionId: payload.sessionId, sessionPath: payload.sessionPath || "recovered-path" };
      }
      if (type === "session:send") {
        if (send) return send(payload, requests);
        return { ok: true };
      }
      throw new Error(`unexpected bus request: ${type}`);
    },
    emit(event, sessionPath) {
      notifications.push({ event, sessionPath });
    },
  };
  return bus;
}

function makeScheduler(data, bus, now) {
  return new TodoReminderScheduler({
    ctx: { pluginId: "shiguangji", bus, log: { info() {}, warn() {}, debug() {} } },
    data,
    now,
  });
}

test("待办提醒纯函数：提前一分钟调度、准点/时间段与旧状态规范化", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), "manifest.json"), "utf8"));
  assert.ok(manifest.capabilities.includes("session"), "公开新会话送达需要 session 能力声明");
  assert.ok(manifest.capabilities.includes("task"), "持久提醒计划需要 task 能力声明");
  assert.ok(manifest.capabilities.includes("agent"), "选择目标助手需要 agent 能力声明");
  assert.equal(TODO_REMINDER_LEAD_MS, 60 * 1000);

  const event = todo("todo-1", "18:00", "18:30");
  const target = localDate(2026, 9, 1, 18, 0).getTime();
  assert.equal(todoReminderKey(event), "2026-09-01|18:00|18:30");
  assert.equal(todoReminderScheduleId(event.id), "shiguangji-todo-todo-1");
  assert.equal(todoReminderAt(event), target);
  const triggerAt = target - TODO_REMINDER_LEAD_MS;
  assert.equal(todoReminderRunAt(event, triggerAt - 1), triggerAt);
  assert.equal(todoReminderRunAt(event, triggerAt), triggerAt + 10);
  assert.equal(todoReminderRunAt(event, target - 30 * 1000), target - 30 * 1000 + 10);
  assert.equal(todoReminderRunAt({ ...event, done: true }, target), null);
  assert.equal(todoReminderRunAt({ ...event, repeatYearly: true }, target), null);

  const state = reminderStateForKey({ key: todoReminderKey(event), status: "sending", attempts: "2" }, todoReminderKey(event), todoReminderScheduleId(event.id));
  assert.equal(state.status, "pending");
  assert.equal(state.attempts, 2);
  assert.equal(isReminderDelivered({ key: state.key, status: "delivered", deliveredAt: "now" }, state.key), true);

  const payload = buildTodoReminderPayload(event, { userName: "小测试", now: new Date(target + 90 * 1000) });
  assert.equal(payload.text, "拾光记提醒：原定 18:00–18:30，刚刚已经到时间了。");
  assert.doesNotMatch(payload.text, /小测试|带圆宝出去玩/);
  assert.match(payload.beforeUser, /拾光记触发的待办提醒/);
  assert.match(payload.beforeUser, /提醒小测试/);
  assert.match(payload.beforeUser, /18:00–18:30/);
  assert.match(payload.beforeUser, /带圆宝出去玩/);
  assert.match(payload.beforeUser, /不要说事情已经完成/);
  assert.equal(payload.overdue, true);

  const fallback = buildTodoReminderPayload(event, { userName: "", now: new Date(target - 30 * 1000) });
  assert.match(fallback.beforeUser, /提醒对方/);
});

test("TaskRegistry：启动注册、提前一分钟计划送入新公开会话，并且重复执行幂等", async () => {
  const target = localDate(2026, 9, 1, 10, 0).getTime();
  const data = makeMemoryData([todo("todo-task")]);
  const bus = makeBus();
  const scheduler = makeScheduler(data, bus, () => target - 60 * 60 * 1000);

  await scheduler.start();
  assert.equal(scheduler.mode, "task");
  assert.equal(bus.handler?.type, TODO_REMINDER_TASK_TYPE);
  const scheduled = bus.requests.find((item) => item.type === "task:schedule");
  assert.ok(scheduled, "启动时应写入 TaskRegistry 计划");
  assert.equal(scheduled.payload.runAt, target - TODO_REMINDER_LEAD_MS);
  assert.equal(scheduled.payload.payload.eventId, "todo-task");

  const result = await scheduler.runScheduled({ payload: scheduled.payload.payload });
  assert.deepEqual(result, { delivered: true });
  const created = bus.requests.find((item) => item.type === "session:create");
  assert.equal(created?.payload.visibility, "public");
  assert.equal(created?.payload.kind, "chat");
  assert.equal(created?.payload.ownerPluginId, "shiguangji");
  const firstSend = bus.requests.filter((item) => item.type === "session:send");
  assert.equal(firstSend.length, 1);
  assert.equal(firstSend[0].payload.sessionId, "session-1");
  assert.equal(firstSend[0].payload.sessionPath, "path-1");
  assert.equal(firstSend[0].payload.text, "拾光记提醒：10:00 准点 到时间啦。");
  assert.doesNotMatch(firstSend[0].payload.text, /带圆宝出去玩/);
  assert.match(firstSend[0].payload.context.beforeUser, /拾光记触发的待办提醒/);
  assert.match(firstSend[0].payload.context.beforeUser, /带圆宝出去玩/);
  assert.match(firstSend[0].payload.context.beforeUser, /不要说事情已经完成/);
  assert.equal(data.getTodoReminder("todo-task").status, "delivered");
  assert.equal(bus.notifications.length, 1);
  assert.equal(bus.notifications[0].event.openKind, "session");
  assert.equal(bus.notifications[0].event.sessionPath, "path-1");

  const duplicate = await scheduler.runScheduled({ payload: scheduled.payload.payload });
  assert.deepEqual(duplicate, { skipped: true, reason: "already-delivered" });
  assert.equal(bus.requests.filter((item) => item.type === "session:send").length, 1);
  __resetTodoReminderSchedulerForTest(scheduler);
});

test("TaskRegistry：宿主提前触发时会跳过未到计划时刻的回调", async () => {
  const target = localDate(2026, 9, 1, 10, 0).getTime();
  const triggerAt = target - TODO_REMINDER_LEAD_MS;
  const data = makeMemoryData([todo("todo-early-guard")]);
  const bus = makeBus();
  const scheduler = makeScheduler(data, bus, () => target - 5 * 60 * 1000);
  await scheduler.start();
  const scheduled = bus.requests.find((item) => item.type === "task:schedule");
  assert.ok(scheduled);

  const early = await scheduler.runScheduled({
    nextRunAt: triggerAt + 60 * 1000,
    payload: scheduled.payload.payload,
  });
  assert.deepEqual(early, { skipped: true, reason: "early-plan" });
  assert.equal(bus.requests.filter((item) => item.type === "session:send").length, 0);

  scheduler.now = () => triggerAt;
  const onTime = await scheduler.runScheduled({
    nextRunAt: triggerAt,
    payload: scheduled.payload.payload,
  });
  assert.deepEqual(onTime, { delivered: true });
  __resetTodoReminderSchedulerForTest(scheduler);
});

test("重启恢复：未送达状态重开调度器后会接管过期计划并补送一次", async () => {
  const target = localDate(2026, 9, 1, 16, 0).getTime();
  const data = makeMemoryData([todo("todo-restart", "16:00")]);
  const firstBus = makeBus();
  const first = makeScheduler(data, firstBus, () => target - 60 * 60 * 1000);
  await first.start();
  assert.equal(data.getTodoReminder("todo-restart").status, "pending");
  __resetTodoReminderSchedulerForTest(first);

  const secondBus = makeBus();
  const second = makeScheduler(data, secondBus, () => target + 60 * 60 * 1000);
  await second.start();
  const recoveredPlan = secondBus.requests.find((item) => item.type === "task:schedule");
  assert.ok(recoveredPlan, "重启后应重新接管计划");
  assert.equal(recoveredPlan.payload.runAt, target + 60 * 60 * 1000 + 10);
  await second.runScheduled({ payload: recoveredPlan.payload.payload });
  assert.equal(data.getTodoReminder("todo-restart").status, "delivered");
  assert.equal(secondBus.requests.filter((item) => item.type === "session:send").length, 1);
  __resetTodoReminderSchedulerForTest(second);
});

test("TaskRegistry：修改提醒时间会撤掉旧计划再写入新计划", async () => {
  const oldTarget = localDate(2026, 9, 1, 11, 0).getTime();
  const newTarget = localDate(2026, 9, 1, 12, 0).getTime();
  const data = makeMemoryData([todo("todo-edit", "11:00")]);
  const bus = makeBus();
  const scheduler = makeScheduler(data, bus, () => oldTarget - 60 * 60 * 1000);
  await scheduler.start();
  assert.equal(bus.requests.filter((item) => item.type === "task:schedule").length, 1);

  const updated = todo("todo-edit", "12:00");
  data.setEvent(updated);
  scheduler.now = () => newTarget - 60 * 60 * 1000;
  await scheduler.refreshAll({ onlyId: updated.id });
  const schedules = bus.requests.filter((item) => item.type === "task:schedule");
  const unschedules = bus.requests.filter((item) => item.type === "task:unschedule");
  assert.equal(unschedules.length >= 2, true, "编辑前后都应撤掉旧的一次性计划");
  assert.equal(schedules.length, 2);
  assert.equal(schedules[1].payload.runAt, newTarget - TODO_REMINDER_LEAD_MS);
  assert.equal(data.getTodoReminder(updated.id).key, "2026-09-01|12:00|12:00");
  __resetTodoReminderSchedulerForTest(scheduler);
});

test("完成/删除：勾选完成或删掉待办会撤掉计划并清理提醒状态", async () => {
  const target = localDate(2026, 9, 1, 17, 0).getTime();
  const data = makeMemoryData([todo("todo-stop", "17:00")]);
  const bus = makeBus();
  const scheduler = makeScheduler(data, bus, () => target - 60 * 60 * 1000);
  await scheduler.start();
  assert.ok(bus.requests.some((item) => item.type === "task:schedule"));

  data.setEvent({ ...todo("todo-stop", "17:00"), done: true });
  await scheduler.refreshAll({ onlyId: "todo-stop" });
  assert.equal(data.getTodoReminder("todo-stop").status, "pending", "完成前未送达状态可保留作审计");
  assert.equal(bus.requests.filter((item) => item.type === "task:unschedule").length >= 2, true);

  data.deleteEvent("todo-stop");
  await scheduler.refreshAll({ onlyId: "todo-stop" });
  assert.equal(data.getTodoReminder("todo-stop"), null);
  assert.equal(bus.requests.filter((item) => item.type === "task:unschedule").length >= 3, true);
  __resetTodoReminderSchedulerForTest(scheduler);
});

test("失败重试：session:send 失败时不标已送达，下一轮可继续且只发一次成功消息", async () => {
  const target = localDate(2026, 9, 1, 13, 0).getTime();
  let now = target;
  let shouldFail = true;
  const data = makeMemoryData([todo("todo-retry", "13:00")]);
  const bus = makeBus({
    send() {
      if (shouldFail) throw new Error("模拟会话发送失败");
      return { ok: true };
    },
  });
  const scheduler = makeScheduler(data, bus, () => now);
  await scheduler.start();
  const plan = bus.requests.find((item) => item.type === "task:schedule");
  assert.ok(plan);

  const failed = await scheduler.runScheduled({ payload: plan.payload.payload });
  assert.deepEqual(failed, { delivered: false });
  const failedState = data.getTodoReminder("todo-retry");
  assert.equal(failedState.status, "pending");
  assert.equal(failedState.attempts, 1);
  assert.equal(failedState.nextRetryAt, target + TODO_REMINDER_RETRY_DELAY_MS);

  shouldFail = false;
  now = failedState.nextRetryAt + 1;
  await scheduler.refreshAll({ onlyId: "todo-retry" });
  const retryPlan = bus.requests.filter((item) => item.type === "task:schedule").at(-1);
  assert.ok(retryPlan);
  const succeeded = await scheduler.runScheduled({ payload: retryPlan.payload.payload });
  assert.deepEqual(succeeded, { delivered: true });
  assert.equal(data.getTodoReminder("todo-retry").status, "delivered");
  assert.equal(bus.requests.filter((item) => item.type === "session:send").length, 2);
  __resetTodoReminderSchedulerForTest(scheduler);
});

test("旧宿主退回补扫：进入提前窗口后立即送达，不依赖 task:*", async () => {
  const target = localDate(2026, 9, 1, 14, 0).getTime();
  const data = makeMemoryData([todo("todo-poll", "14:00")]);
  const bus = makeBus({ register: false });
  const scheduler = makeScheduler(data, bus, () => target + 1);

  await scheduler.start();
  assert.equal(scheduler.mode, "poll");
  assert.equal(data.getTodoReminder("todo-poll").status, "delivered");
  assert.equal(bus.requests.filter((item) => item.type === "task:schedule").length, 0);
  assert.equal(bus.requests.filter((item) => item.type === "session:send").length, 1);
  __resetTodoReminderSchedulerForTest(scheduler);
});

test("UserData 集成：提醒状态单独加密，重开实例后仍能识别已送达且删除事件会清理状态", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sgj-reminder-data-"));
  const target = localDate(2026, 9, 1, 15, 0).getTime();
  const data = new UserData(dataDir);
  const event = await data.addEvent({
    title: "带圆宝出去玩",
    type: "todo",
    date: "2026-09-01",
    reminderStart: "15:00",
    reminderEnd: "15:30",
  });
  await data.saveTodoReminder(event.id, {
    key: todoReminderKey(event),
    scheduleId: todoReminderScheduleId(event.id),
    status: "delivered",
    deliveredAt: new Date(target).toISOString(),
  });
  const reopened = new UserData(dataDir);
  assert.equal(reopened.getTodoReminder(event.id).status, "delivered");
  assert.equal(reopened.getEvent(event.id).title, "带圆宝出去玩");
  const cipher = fs.readFileSync(path.join(dataDir, "todo-reminders.dat"), "utf8");
  assert.equal(cipher.includes("带圆宝出去玩"), false);
  await reopened.removeEvent(event.id);
  const afterDelete = new UserData(dataDir);
  assert.equal(afterDelete.getEvent(event.id), null);
  assert.equal(afterDelete.getTodoReminder(event.id), null);
});
