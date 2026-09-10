// 拾光记 · 停摆提醒（自动整理连续三次失败后，借提个醒的弹窗把话说给用户）
// 覆盖：日期文案、停摆跃迁判定、提醒身份（固定小花）、请求目标与各种降级路径。

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildAutoSummaryPausedCopy,
  formatDayLabel,
  notifyAutoSummaryPaused,
  resolveNotifyAgentId,
} from "../lib/external-notify.js";
import { isPausedState, isPausedTransition } from "../routes/ui.js";

const NOTIFY_PATH = "/api/plugins/tigexing/api/external/notify";

/** 造一个假的 HANA_HOME（含 server-info.json），返回插件目录 */
function makeFakePluginDir({ withServerInfo = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sgj-notify-"));
  const pluginDir = path.join(home, "plugins", "shiguangji");
  fs.mkdirSync(pluginDir, { recursive: true });
  if (withServerInfo) {
    fs.writeFileSync(
      path.join(home, "server-info.json"),
      JSON.stringify({ port: 14500, token: "test-token", version: "0.0.0" }),
    );
  }
  return pluginDir;
}

// ── 文案 ──

test("停摆提醒：日期翻成中文，正文说清哪天的、失败几次、去手动做", () => {
  assert.equal(formatDayLabel("2026-09-09"), "9 月 9 日");
  assert.equal(formatDayLabel("2026-10-01"), "10 月 1 日");
  assert.equal(formatDayLabel("随便写的"), "随便写的");
  assert.equal(formatDayLabel(""), "");

  const copy = buildAutoSummaryPausedCopy("2026-09-09", {
    autoRetryCount: 3,
    autoLastError: "模型未回复正文",
  });
  assert.equal(copy.title, "拾光记 · 自动整理停摆了");
  assert.match(copy.message, /9 月 9 日/);
  assert.match(copy.message, /连续失败 3 次/);
  assert.match(copy.message, /暂停自动重试/);
  assert.match(copy.message, /去时光册手动做一次/);
  assert.match(copy.message, /模型未回复正文/);
});

test("停摆提醒：没有失败原因时不留原因尾巴，也没日期时不说错话", () => {
  const copy = buildAutoSummaryPausedCopy("2026-09-09", { autoRetryCount: 3 });
  assert.doesNotMatch(copy.message, /原因/);

  const noDay = buildAutoSummaryPausedCopy("", { autoRetryCount: 3 });
  assert.match(noDay.message, /^上一次的自动整理/);
});

test("停摆提醒：原因过长会被截断，不把整段报错塞进通知", () => {
  const copy = buildAutoSummaryPausedCopy("2026-09-09", {
    autoRetryCount: 3,
    autoLastError: "错".repeat(500),
  });
  assert.ok(copy.message.length < 300, `正文应被截断，实际 ${copy.message.length} 字`);
});

// ── 头像伙伴 ──

test("停摆提醒：提醒固定以小花的身份发出（不再跟着做册伙伴第一位走）", () => {
  assert.equal(resolveNotifyAgentId(), "hanako");
  // 做册伙伴顺序不再影响头像
  assert.equal(resolveNotifyAgentId({ summaryAgentIds: ["partner-a", "hanako"] }), "hanako");
  assert.equal(resolveNotifyAgentId({ summaryAgents: [{ agentId: "partner-a" }] }), "hanako");
  // 留给将来的设置项：显式指定时优先
  assert.equal(resolveNotifyAgentId({ notifyAgentId: "partner-b" }), "partner-b");
  assert.equal(resolveNotifyAgentId({ notifyAgentId: "   " }), "hanako");
});

// ── 停摆跃迁（决定弹几次） ──

test("停摆判定：次数到阈值或显式标记都算停摆", () => {
  assert.equal(isPausedState({ autoRetryCount: 2 }), false);
  assert.equal(isPausedState({ autoRetryCount: 3 }), true);
  assert.equal(isPausedState({ autoRetryCount: 1, autoRetryPaused: true }), true);
  assert.equal(isPausedState({ status: "completed" }), false);
  assert.equal(isPausedState(null), false);
  assert.equal(isPausedState(undefined), false);
});

test("停摆跃迁：只认「刚被推到停摆」那一次，之后不再重复打扰", () => {
  // 第 2 次 → 第 3 次：跃迁，该提醒
  assert.equal(isPausedTransition({ autoRetryCount: 2 }, { autoRetryCount: 3, autoRetryPaused: true }), true);
  // 已经在停摆里又失败：不提醒
  assert.equal(
    isPausedTransition({ autoRetryCount: 3, autoRetryPaused: true }, { autoRetryCount: 4, autoRetryPaused: true }),
    false,
  );
  // 还没到阈值：不提醒
  assert.equal(isPausedTransition({}, { autoRetryCount: 1 }), false);
  assert.equal(isPausedTransition({ autoRetryCount: 1 }, { autoRetryCount: 2 }), false);
  assert.equal(isPausedTransition(null, null), false);
});

// ── 调用与降级 ──

test("停摆提醒：请求打到提个醒的对外接口，POST 且以小花的身份", async () => {
  const calls = [];
  const res = await notifyAutoSummaryPaused({
    ctx: { pluginDir: makeFakePluginDir() },
    settings: { summaryAgentIds: ["partner-b", "hanako"] },
    day: "2026-09-09",
    state: { autoRetryCount: 3, autoLastError: "空正文" },
    fetchImpl: async (server, pathname, init) => {
      calls.push({ server, pathname, init });
      return { status: 200, ok: true, body: { ok: true, sent: true } };
    },
  });

  assert.deepEqual(res, { ok: true, reason: "sent" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].pathname, NOTIFY_PATH);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].server.token, "test-token");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.agentId, "hanako");
  assert.equal(body.title, "拾光记 · 自动整理停摆了");
  assert.match(body.message, /9 月 9 日/);
});

test("停摆提醒：没装提个醒（404）安静收场，不当成错误", async () => {
  const res = await notifyAutoSummaryPaused({
    ctx: { pluginDir: makeFakePluginDir() },
    settings: {},
    day: "2026-09-09",
    state: { autoRetryCount: 3 },
    fetchImpl: async () => ({ status: 404, ok: false, body: { error: "not found" } }),
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "no-plugin");
});

test("停摆提醒：被提个醒静默（总开关关闭或静默时段）原样带回原因", async () => {
  const res = await notifyAutoSummaryPaused({
    ctx: { pluginDir: makeFakePluginDir() },
    settings: {},
    day: "2026-09-09",
    state: { autoRetryCount: 3 },
    fetchImpl: async () => ({ status: 200, ok: true, body: { ok: false, suppressed: true, reason: "quiet" } }),
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "quiet");
});

test("停摆提醒：读不到 server-info.json 时降级，不抛错", async () => {
  const res = await notifyAutoSummaryPaused({
    ctx: { pluginDir: makeFakePluginDir({ withServerInfo: false }) },
    settings: {},
    day: "2026-09-09",
    state: { autoRetryCount: 3 },
    fetchImpl: async () => {
      throw new Error("不该走到这里");
    },
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "no-server");
});

test("停摆提醒：拿不到插件目录时降级", async () => {
  const res = await notifyAutoSummaryPaused({
    ctx: {},
    settings: {},
    day: "2026-09-09",
    state: { autoRetryCount: 3 },
    fetchImpl: async () => {
      throw new Error("不该走到这里");
    },
  });
  assert.equal(res.reason, "no-home");
});

test("停摆提醒：网络异常被吞掉，不冒泡到整理主流程", async () => {
  const res = await notifyAutoSummaryPaused({
    ctx: { pluginDir: makeFakePluginDir() },
    settings: {},
    day: "2026-09-09",
    state: { autoRetryCount: 3 },
    fetchImpl: async () => {
      throw new Error("boom");
    },
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "error");
  assert.match(res.error, /boom/);
});

test("停摆提醒：提个醒返回 500 时不重试、只报原因", async () => {
  let calls = 0;
  const res = await notifyAutoSummaryPaused({
    ctx: { pluginDir: makeFakePluginDir() },
    settings: {},
    day: "2026-09-09",
    state: { autoRetryCount: 3 },
    fetchImpl: async () => {
      calls += 1;
      return { status: 500, ok: false, body: { error: "internal" } };
    },
  });
  assert.equal(res.reason, "http-500");
  assert.equal(calls, 1);
});
