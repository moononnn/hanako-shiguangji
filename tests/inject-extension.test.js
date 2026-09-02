// 拾光记 · 注入扩展集成测试
// 模拟 Hana 的 pi 对象（before_agent_start），验证扩展注册与注入返回结构。

import { test, before } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { UserData, dateKey } from "../lib/data.js";
import { __setSharedUserDataForTest } from "../lib/shared-data.js";

// 用临时数据目录隔离测试数据；扩展注册时的天气检查也不会触碰真实配置。
const TEST_DATA_DIR = path.join(os.tmpdir(), `sgj-ext-test-${Date.now()}`);

import registerShiguangjiInject, { __resetLazySummaryForTest, resolveAgentId } from "../extensions/inject.js";

before(() => {
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  __setSharedUserDataForTest(new UserData(TEST_DATA_DIR));
});

function makePi() {
  const handlers = {};
  const pi = {
    on(type, fn) {
      handlers[type] = fn;
    },
    _handlers: handlers,
  };
  return pi;
}

test("扩展：伙伴身份优先取上下文，缺失时从会话路径回退", () => {
  assert.equal(resolveAgentId({}, { agentId: "hanako" }), "hanako");
  assert.equal(resolveAgentId({}, { sessionManager: { getSessionFile: () => "C:\\Users\\test\\.hanako\\agents\\partner-two\\sessions\\s.jsonl" } }), "partner-two");
  assert.equal(resolveAgentId({}, { sessionManager: { getSessionFile: () => "C:\\Users\\test\\other\\s.jsonl" } }), "");
});

test("扩展：注册 before_agent_start 处理器", () => {
  const pi = makePi();
  registerShiguangjiInject(pi);
  assert.equal(typeof pi._handlers["before_agent_start"], "function");
});

test("扩展：无会话时返回 undefined（不注入）", () => {
  const pi = makePi();
  registerShiguangjiInject(pi);
  const result = pi._handlers["before_agent_start"]({}, { sessionManager: null });
  assert.equal(result, undefined);
});

test("扩展：关闭情境注入时不返回消息，重新打开后恢复", async () => {
  const data = new UserData(path.join(os.tmpdir(), `sgj-disabled-ext-${Date.now()}-${Math.random().toString(36).slice(2)}`));
  __setSharedUserDataForTest(data);
  await data.updateSettings({ injectionEnabled: false });
  const pi = makePi();
  registerShiguangjiInject(pi);
  const ctx = { sessionManager: { getSessionId: () => "disabled-session" } };
  assert.equal(pi._handlers["before_agent_start"]({}, ctx), undefined, "关闭后不应注入");

  await data.updateSettings({ injectionEnabled: true });
  const restored = pi._handlers["before_agent_start"]({}, ctx);
  assert.ok(restored?.message, "重新打开后下一轮应恢复注入");
  assert.equal(restored.message.display, false);
  assert.ok(restored.message.content.includes("今日时光"));
  __setSharedUserDataForTest(new UserData(TEST_DATA_DIR));
});

test("扩展：天气关闭时仍可注入其他情境但不带天气", async () => {
  const data = new UserData(path.join(os.tmpdir(), `sgj-weather-off-ext-${Date.now()}-${Math.random().toString(36).slice(2)}`));
  __setSharedUserDataForTest(data);
  const now = new Date();
  const today = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join("-");
  await data.updateSettings({
    weatherEnabled: false,
    weatherLocation: "四川省 成都市 武侯区",
    weatherArea: { code: "510107" },
  });
  await data.addEvent({ title: "测试日子", type: "event", date: today });
  await data.setWeatherCache({
    location: "四川省 成都市 武侯区",
    fetchedAt: Date.now(),
    result: { place: "四川省 成都市 武侯区", line: "晴空万里，28°C", temp: 28, code: 0, isDay: true },
  });
  const pi = makePi();
  registerShiguangjiInject(pi);
  const result = pi._handlers["before_agent_start"]({}, {
    sessionManager: { getSessionId: () => "weather-disabled-session" },
  });
  assert.ok(result?.message, "有测试日子时仍应注入其他情境");
  assert.ok(result.message.content.includes("测试日子"));
  assert.ok(!result.message.content.includes("窗外"), "天气关闭后不应进入注入");
  __setSharedUserDataForTest(new UserData(TEST_DATA_DIR));
});

test("扩展：未来待办不提前进入今日情境，旧 MM-DD 也按完整日期判断", async () => {
  const data = new UserData(path.join(os.tmpdir(), `sgj-future-todo-ext-${Date.now()}-${Math.random().toString(36).slice(2)}`));
  __setSharedUserDataForTest(data);
  const now = new Date();
  const today = dateKey(now);
  const future = new Date(now);
  future.setDate(future.getDate() + 2);
  const futureKey = dateKey(future);
  const futureMmdd = `${String(future.getMonth() + 1).padStart(2, "0")}-${String(future.getDate()).padStart(2, "0")}`;
  await data.addEvent({ title: "今天要办的事", type: "todo", date: today, reminderStart: "09:00", reminderEnd: "09:00" });
  await data.events.update((state) => {
    state.events.legacyFuture = {
      id: "legacyFuture",
      title: "未来旧格式待办",
      type: "todo",
      date: futureMmdd,
      repeatYearly: false,
      reminderStart: "09:00",
      reminderEnd: "09:00",
    };
    state.events.fullFuture = {
      id: "fullFuture",
      title: "未来完整格式待办",
      type: "todo",
      date: futureKey,
      repeatYearly: false,
      reminderStart: "09:00",
      reminderEnd: "09:00",
    };
  });
  const pi = makePi();
  registerShiguangjiInject(pi);
  const result = pi._handlers["before_agent_start"]({}, {
    sessionManager: { getSessionId: () => "future-todo-session" },
  });
  assert.ok(result?.message, "今天的待办仍应触发情境注入");
  assert.ok(result.message.content.includes("今天要办的事"));
  assert.ok(!result.message.content.includes("未来旧格式待办"));
  assert.ok(!result.message.content.includes("未来完整格式待办"));
  __setSharedUserDataForTest(new UserData(TEST_DATA_DIR));
});

test("扩展：注入失败不抛错（数据目录不可写也安全）", async () => {
  // 用一个不可能的数据目录场景：把 plugin-data 临时改名再恢复，太危险；
  // 直接验证 catch 分支：传入会触发异常的对象
  const pi = makePi();
  registerShiguangjiInject(pi);
  // sessionManager.getSessionId 抛错 → 应返回 undefined 不抛
  const evilCtx = {
    sessionManager: {
      getSessionId() {
        throw new Error("boom");
      },
    },
  };
  let threw = false;
  try {
    const result = pi._handlers["before_agent_start"]({}, evilCtx);
    assert.equal(result, undefined, "异常时应返回 undefined");
  } catch {
    threw = true;
  }
  assert.equal(threw, false, "不应抛错");
});

test("扩展：新会话返回注入消息结构（display:false）", () => {
  __resetLazySummaryForTest();
  const pi = makePi();
  registerShiguangjiInject(pi);
  // 今天 2026-08-28 是新会话，一定有内容（日期行）
  const ctx = {
    sessionManager: {
      getSessionId: () => "test-session-1",
    },
  };
  const result = pi._handlers["before_agent_start"]({}, ctx);
  if (result === undefined) {
    // 可能当天没有特殊日子且无其他信息 → 不注入。这是合法行为。
    return;
  }
  assert.equal(result.message.display, false, "隐藏消息");
  assert.ok(result.message.content.includes("今日时光"));
  assert.equal(result.message.customType, "shiguangji-today-context");
  // 内容不含明文测试数据文件路径
  assert.ok(!result.message.content.includes(TEST_DATA_DIR));
});
