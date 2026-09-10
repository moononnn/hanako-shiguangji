// 拾光记 · 自动做册/情绪失败门控测试
process.env.TZ = "Asia/Shanghai";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { UserData } from "../lib/data.js";
import {
  automaticRetryDelayMs,
  canClearAutomaticSummaryAttempt,
  clearedAutomaticRetryPatch,
  describeAutomaticRetry,
  getAutomaticRetryGate,
  makeAutomaticRetryPatch,
} from "../routes/ui.js";

function tmpDir(name) {
  return path.join(os.tmpdir(), `sgj-auto-retry-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

test("自动重试：10 分钟/30 分钟后退避，第三次失败暂停当天任务", () => {
  const base = Date.parse("2026-09-10T10:00:00.000Z");
  assert.equal(automaticRetryDelayMs(1), 10 * 60 * 1000);
  assert.equal(automaticRetryDelayMs(2), 30 * 60 * 1000);
  // 第 3 次就是暂停阈值：不再有更长的冷却档，返回 0 表示「不安排下一次」。
  assert.equal(automaticRetryDelayMs(3), 0);

  const first = makeAutomaticRetryPatch({}, { now: new Date(base), error: "空正文" });
  assert.equal(first.autoRetryCount, 1);
  assert.equal(first.autoRetryPaused, false);
  assert.equal(first.autoNextRetryAt, new Date(base + 10 * 60 * 1000).toISOString());
  assert.equal(getAutomaticRetryGate(first, base + 9 * 60 * 1000).reason, "cooldown");
  assert.equal(getAutomaticRetryGate(first, base + 10 * 60 * 1000).blocked, false);

  const second = makeAutomaticRetryPatch(first, { now: new Date(base + 10 * 60 * 1000), error: "仍为空" });
  assert.equal(second.autoRetryCount, 2);
  assert.equal(second.autoNextRetryAt, new Date(base + 40 * 60 * 1000).toISOString());
  const third = makeAutomaticRetryPatch(second, { now: new Date(base + 40 * 60 * 1000), error: "连续失败" });
  assert.equal(third.autoRetryCount, 3);
  assert.equal(third.autoRetryPaused, true);
  assert.equal(third.autoNextRetryAt, "");
  assert.equal(getAutomaticRetryGate(third, base + 24 * 60 * 60 * 1000).reason, "paused");
});

test("自动重试：只有整条链真正落定才允许清除节流标记", () => {
  assert.equal(canClearAutomaticSummaryAttempt({ ok: true, mood: { ok: true }, partnerMood: { ok: true, results: [{ ok: true }] } }), true);
  assert.equal(canClearAutomaticSummaryAttempt({ ok: true, mood: { ok: false, error: "空正文" } }), false);
  assert.equal(canClearAutomaticSummaryAttempt({ ok: true, mood: { ok: true }, partnerMood: { ok: true, results: [{ ok: false }] } }), false);
  assert.equal(canClearAutomaticSummaryAttempt({ ok: false, error: "做册失败" }), false);
});

test("数据层：伙伴链状态可按生活日列出，供重启后的失败恢复使用", async () => {
  const data = new UserData(tmpDir("partner-state-list"));
  await data.updatePartnerMoodHarvestState("2026-09-09", "partner-a", { status: "failed" });
  await data.updatePartnerMoodHarvestState("2026-09-09", "partner-b", { status: "completed" });
  await data.updatePartnerMoodHarvestState("2026-09-08", "partner-a", { status: "running" });

  assert.deepEqual(
    data.listPartnerMoodHarvestStates("2026-09-09").map(({ date, agentId, status }) => ({ date, agentId, status })),
    [
      { date: "2026-09-09", agentId: "partner-a", status: "failed" },
      { date: "2026-09-09", agentId: "partner-b", status: "completed" },
    ],
  );
  assert.equal(data.listPartnerMoodHarvestStates().length, 3);
});

test("路由：自动失败重试先做廉价预检，空正文只在原模型上重试一次", () => {
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "sgj-auto-retry-route-"));
  const routeUrl = pathToFileURL(path.resolve("routes/ui.js")).href;
  const dataUrl = pathToFileURL(path.resolve("lib/data.js")).href;
  const childCode = `
    import fs from "node:fs";
    import path from "node:path";
    import { UserData } from ${JSON.stringify(dataUrl)};
    import registerRoutes from ${JSON.stringify(routeUrl)};

    const home = path.join(os.homedir(), ".hanako");
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, "users.json"), JSON.stringify({ displayName: "小测试" }));
    const now = new Date();
    const dayDate = new Date(now);
    dayDate.setDate(dayDate.getDate() - (dayDate.getHours() < 4 ? 2 : 1));
    const day = [dayDate.getFullYear(), String(dayDate.getMonth() + 1).padStart(2, "0"), String(dayDate.getDate()).padStart(2, "0")].join("-");
    const agentDir = path.join(home, "agents", "hanako");
    fs.mkdirSync(path.join(agentDir, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(agentDir, "config.yaml"), "agent:\\n  name: 小花\\n");
    fs.writeFileSync(path.join(agentDir, "sessions", "one.jsonl"), JSON.stringify({
      type: "message",
      timestamp: day + "T10:00:00",
      message: { role: "user", content: "今天有点焦虑，但我还在整理文件" },
    }) + "\\n");

    const data = new UserData(path.join(home, "plugin-data", "shiguangji"));
    await data.updateSettings({
      autoSummary: true,
      moodDiscoveryMode: "detailed",
      partnerMoodEnabled: false,
      summaryAgentIds: ["hanako"],
      dayBoundaryHour: 4,
      modelSource: "agent",
    });
    await data.updateMoodHarvestState(day, {
      status: "failed",
      mode: "detailed",
      attemptedAt: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
      autoRetryCount: 1,
      autoRetryPaused: false,
      autoNextRetryAt: new Date(now.getTime() - 1000).toISOString(),
    });

    const routes = [];
    const app = {
      get(p, h) { routes.push({ method: "GET", path: p, handler: h }); },
      post(p, h) { routes.push({ method: "POST", path: p, handler: h }); },
      put(p, h) { routes.push({ method: "PUT", path: p, handler: h }); },
      delete(p, h) { routes.push({ method: "DELETE", path: p, handler: h }); },
    };
    const calls = [];
    const ctx = {
      dataDir: path.join(home, "plugin-data", "shiguangji"),
      bus: { async request(topic, input) {
        calls.push({ topic, input });
        if (input.callPurpose === "summary-preflight") return { text: "OK" };
        if (input.callPurpose === "mood-discovery") return { text: "" };
        if (input.callPurpose === "summary") return { text: "" };
        throw new Error("意外的模型调用：" + input.callPurpose);
      } },
      log: { info() {}, warn() {}, error() {} },
    };
    registerRoutes(app, ctx);
    for (let i = 0; i < 20; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const state = new UserData(path.join(home, "plugin-data", "shiguangji")).getMoodHarvestState(day);
      if (state?.autoRetryCount === 2) break;
    }
    const purposes = calls.map((call) => call.input.callPurpose);
    const state = new UserData(path.join(home, "plugin-data", "shiguangji")).getMoodHarvestState(day);
    if (purposes.filter((purpose) => purpose === "summary-preflight").length !== 1) throw new Error("失败重试没有只做一次预检：" + JSON.stringify(purposes));
    // 空正文允许在原模型上重试一次（收紧指令），但只此一次，之后交给日级退避；
    // 所以每条长链恰好两次、总共 1 次预检 + 2 条长链×2。
    if (purposes.filter((purpose) => purpose === "mood-discovery").length !== 2) throw new Error("情绪链空正文没有恰好重试一次：" + JSON.stringify(purposes));
    if (purposes.filter((purpose) => purpose === "summary").length !== 2) throw new Error("做册空正文没有恰好重试一次：" + JSON.stringify(purposes));
    if (new Set(calls.map((call) => call.topic)).size !== 1) throw new Error("重试换到了别的模型通道：" + JSON.stringify(calls.map((call) => call.topic)));
    if (calls.length !== 5) throw new Error("自动失败链路出现额外调用：" + JSON.stringify(purposes));
    if (state?.autoRetryCount !== 2 || !state.autoNextRetryAt || state.autoRetryPaused) throw new Error("失败退避没有持久化：" + JSON.stringify(state));
    console.log(JSON.stringify({ day, calls: calls.length, purposes, retryCount: state.autoRetryCount }));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", childCode], {
    encoding: "utf8",
    cwd: path.resolve("."),
    env: { ...process.env, USERPROFILE: isolatedHome, HOME: isolatedHome, HANA_HOME: path.join(isolatedHome, ".hanako") },
  });
  assert.equal(result.status, 0, result.stdout + "\n" + result.stderr);
  assert.match(result.stdout, /"calls":5/);
  assert.match(result.stdout, /summary-preflight/);
  assert.match(result.stdout, /"retryCount":2/);
});

test("路由：自动失败预检失败时不发完整长提示，并累计退避次数", () => {
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "sgj-auto-preflight-fail-route-"));
  const routeUrl = pathToFileURL(path.resolve("routes/ui.js")).href;
  const dataUrl = pathToFileURL(path.resolve("lib/data.js")).href;
  const childCode = `
    import fs from "node:fs";
    import path from "node:path";
    import { UserData } from ${JSON.stringify(dataUrl)};
    import registerRoutes from ${JSON.stringify(routeUrl)};

    const home = path.join(os.homedir(), ".hanako");
    const dataDir = path.join(home, "plugin-data", "shiguangji");
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, "users.json"), JSON.stringify({ displayName: "小测试" }));
    const now = new Date();
    const dayDate = new Date(now);
    dayDate.setDate(dayDate.getDate() - (dayDate.getHours() < 4 ? 2 : 1));
    const day = [dayDate.getFullYear(), String(dayDate.getMonth() + 1).padStart(2, "0"), String(dayDate.getDate()).padStart(2, "0")].join("-");
    const data = new UserData(dataDir);
    await data.updateSettings({ autoSummary: false, moodDiscoveryMode: "detailed", partnerMoodEnabled: false, dayBoundaryHour: 4, modelSource: "agent" });
    await data.updateMoodHarvestState(day, {
      status: "failed",
      mode: "detailed",
      attemptedAt: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
      autoRetryCount: 1,
      autoRetryPaused: false,
      autoNextRetryAt: new Date(now.getTime() - 1000).toISOString(),
    });

    const routes = [];
    const app = {
      get(p, h) { routes.push({ method: "GET", path: p, handler: h }); },
      post(p, h) { routes.push({ method: "POST", path: p, handler: h }); },
      put(p, h) { routes.push({ method: "PUT", path: p, handler: h }); },
      delete(p, h) { routes.push({ method: "DELETE", path: p, handler: h }); },
    };
    const calls = [];
    registerRoutes(app, {
      dataDir,
      bus: { async request(topic, input) { calls.push({ topic, input }); return { text: "" }; } },
      log: { info() {}, warn() {}, error() {} },
    });
    for (let i = 0; i < 20; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (new UserData(dataDir).getMoodHarvestState(day)?.autoRetryCount === 2) break;
    }
    const state = new UserData(dataDir).getMoodHarvestState(day);
    if (calls.length !== 1 || calls[0].input.callPurpose !== "summary-preflight") throw new Error("预检失败后仍发了完整请求：" + JSON.stringify(calls));
    if (state?.autoRetryCount !== 2 || !state.autoNextRetryAt || state.autoRetryPaused) throw new Error("预检失败没有进入下一档退避：" + JSON.stringify(state));
    console.log(JSON.stringify({ calls: calls.length, purpose: calls[0].input.callPurpose, retryCount: state.autoRetryCount }));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", childCode], {
    encoding: "utf8",
    cwd: path.resolve("."),
    env: { ...process.env, USERPROFILE: isolatedHome, HOME: isolatedHome, HANA_HOME: path.join(isolatedHome, ".hanako") },
  });
  assert.equal(result.status, 0, result.stdout + "\n" + result.stderr);
  assert.match(result.stdout, /"calls":1/);
  assert.match(result.stdout, /summary-preflight/);
  assert.match(result.stdout, /"retryCount":2/);
});

test("路由：自动做册开启但情绪线关闭时仍尊重持久化冷却", () => {
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "sgj-auto-summary-cooldown-route-"));
  const routeUrl = pathToFileURL(path.resolve("routes/ui.js")).href;
  const dataUrl = pathToFileURL(path.resolve("lib/data.js")).href;
  const childCode = `
    import fs from "node:fs";
    import path from "node:path";
    import { UserData } from ${JSON.stringify(dataUrl)};
    import registerRoutes from ${JSON.stringify(routeUrl)};

    const home = path.join(os.homedir(), ".hanako");
    const dataDir = path.join(home, "plugin-data", "shiguangji");
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, "users.json"), JSON.stringify({ displayName: "小测试" }));
    const now = new Date();
    const dayDate = new Date(now);
    dayDate.setDate(dayDate.getDate() - (dayDate.getHours() < 4 ? 2 : 1));
    const day = [dayDate.getFullYear(), String(dayDate.getMonth() + 1).padStart(2, "0"), String(dayDate.getDate()).padStart(2, "0")].join("-");
    const data = new UserData(dataDir);
    await data.updateSettings({ autoSummary: true, moodDiscoveryMode: "off", partnerMoodEnabled: false, dayBoundaryHour: 4, modelSource: "agent" });
    await data.updateMoodHarvestState(day, {
      status: "completed",
      autoRetryCount: 1,
      autoRetryPaused: false,
      autoNextRetryAt: new Date(now.getTime() + 30 * 60 * 1000).toISOString(),
    });
    const routes = [];
    const app = {
      get(p, h) { routes.push({ method: "GET", path: p, handler: h }); },
      post(p, h) { routes.push({ method: "POST", path: p, handler: h }); },
      put(p, h) { routes.push({ method: "PUT", path: p, handler: h }); },
      delete(p, h) { routes.push({ method: "DELETE", path: p, handler: h }); },
    };
    const calls = [];
    registerRoutes(app, {
      dataDir,
      bus: { async request(topic, input) { calls.push({ topic, input }); return { text: "OK" }; } },
      log: { info() {}, warn() {}, error() {} },
    });
    await new Promise((resolve) => setTimeout(resolve, 180));
    if (calls.length) throw new Error("情绪线关闭时绕过了自动做册冷却：" + JSON.stringify(calls));
    console.log(JSON.stringify({ calls: calls.length, day }));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", childCode], {
    encoding: "utf8",
    cwd: path.resolve("."),
    env: { ...process.env, USERPROFILE: isolatedHome, HOME: isolatedHome, HANA_HOME: path.join(isolatedHome, ".hanako") },
  });
  assert.equal(result.status, 0, result.stdout + "\n" + result.stderr);
  assert.match(result.stdout, /"calls":0/);
});

test("路由：安静日的空整理视为已结算，不占用失败上限", () => {
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "sgj-auto-empty-day-route-"));
  const routeUrl = pathToFileURL(path.resolve("routes/ui.js")).href;
  const dataUrl = pathToFileURL(path.resolve("lib/data.js")).href;
  const childCode = `
    import path from "node:path";
    import fs from "node:fs";
    import { UserData } from ${JSON.stringify(dataUrl)};
    import registerRoutes from ${JSON.stringify(routeUrl)};

    const home = path.join(os.homedir(), ".hanako");
    const dataDir = path.join(home, "plugin-data", "shiguangji");
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, "users.json"), JSON.stringify({ displayName: "小测试" }));
    const data = new UserData(dataDir);
    await data.updateSettings({ autoSummary: true, moodDiscoveryMode: "detailed", partnerMoodEnabled: false, dayBoundaryHour: 4, modelSource: "agent" });
    const now = new Date();
    const dayDate = new Date(now);
    dayDate.setDate(dayDate.getDate() - (dayDate.getHours() < 4 ? 2 : 1));
    const day = [dayDate.getFullYear(), String(dayDate.getMonth() + 1).padStart(2, "0"), String(dayDate.getDate()).padStart(2, "0")].join("-");
    const routes = [];
    const app = {
      get(p, h) { routes.push({ method: "GET", path: p, handler: h }); },
      post(p, h) { routes.push({ method: "POST", path: p, handler: h }); },
      put(p, h) { routes.push({ method: "PUT", path: p, handler: h }); },
      delete(p, h) { routes.push({ method: "DELETE", path: p, handler: h }); },
    };
    const calls = [];
    registerRoutes(app, {
      dataDir,
      bus: { async request(topic, input) { calls.push({ topic, input }); return { text: "OK" }; } },
      log: { info() {}, warn() {}, error() {} },
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const state = new UserData(dataDir).getMoodHarvestState(day);
    // 没有失败退避时不再显式写 autoRetryCount: 0，字段可能不存在，所以按“不高于 0”判定。
    const retryCount = Number(state?.autoRetryCount) || 0;
    if (calls.length || state?.status !== "skipped" || retryCount !== 0 || state.autoRetryPaused) {
      throw new Error("安静日被误判为失败：" + JSON.stringify({ calls, state }));
    }
    console.log(JSON.stringify({ calls: calls.length, status: state.status, retryCount }));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", childCode], {
    encoding: "utf8",
    cwd: path.resolve("."),
    env: { ...process.env, USERPROFILE: isolatedHome, HOME: isolatedHome, HANA_HOME: path.join(isolatedHome, ".hanako") },
  });
  assert.equal(result.status, 0, result.stdout + "\n" + result.stderr);
  assert.match(result.stdout, /"calls":0/);
  assert.match(result.stdout, /"status":"skipped"/);
});

test("自动重试：第 3 次到暂停阈值后不再有更长的冷却档", () => {
  assert.equal(automaticRetryDelayMs(1), 10 * 60 * 1000);
  assert.equal(automaticRetryDelayMs(2), 30 * 60 * 1000);
  assert.equal(automaticRetryDelayMs(3), 0);
  assert.equal(automaticRetryDelayMs(99), 0);
});

test("自动整理状态文案：停摆/等重试/待补完/无异常 四态", () => {
  const base = Date.parse("2026-09-10T04:00:00.000Z");
  const day = "2026-09-09";

  const idle = describeAutomaticRetry({ status: "completed" }, { day, now: base });
  assert.equal(idle.active, false);
  assert.equal(idle.message, "");

  const paused = describeAutomaticRetry(
    { autoRetryCount: 3, autoRetryPaused: true, autoLastError: "模型未回复正文" },
    { day, now: base },
  );
  assert.equal(paused.level, "paused");
  assert.match(paused.message, /9 月 9 日/);
  assert.match(paused.message, /今天不再自动重试/);
  assert.match(paused.message, /模型未回复正文/);

  const cooling = describeAutomaticRetry({
    autoRetryCount: 1,
    autoNextRetryAt: new Date(base + 7 * 60 * 1000).toISOString(),
    autoLastError: "空正文",
  }, { day, now: base });
  assert.equal(cooling.level, "cooldown");
  assert.equal(cooling.waitMinutes, 7);
  assert.match(cooling.message, /约 7 分钟后自动再试/);

  // 冷却时间已经过了但这一轮还没落定：只说“待补完”，不再报还剩几分钟。
  const overdue = describeAutomaticRetry({
    autoRetryCount: 1,
    autoNextRetryAt: new Date(base - 60 * 1000).toISOString(),
  }, { day, now: base });
  assert.equal(overdue.level, "pending");

  const pendingOnly = describeAutomaticRetry(null, { day, partnerPending: true, now: base });
  assert.equal(pendingOnly.level, "pending");
  assert.match(pendingOnly.message, /伙伴的际遇线/);
});

test("清退避残留：不动伙伴链待办标记和当天状态", async () => {
  const data = new UserData(tmpDir("clear-auto-retry"));
  const day = "2026-09-09";
  assert.equal(clearedAutomaticRetryPatch(null), null);
  assert.equal(clearedAutomaticRetryPatch({ status: "completed" }), null);

  await data.updateMoodHarvestState(day, {
    status: "failed",
    mode: "detailed",
    partnerPending: true,
    autoRetryCount: 2,
    autoRetryPaused: false,
    autoNextRetryAt: new Date(Date.now() + 60000).toISOString(),
    autoLastError: "模型未回复正文",
  });
  const patch = clearedAutomaticRetryPatch(data.getMoodHarvestState(day));
  assert.ok(patch, "有残留时应该给出清理补丁");
  await data.updateMoodHarvestState(day, patch);
  const after = data.getMoodHarvestState(day);
  assert.equal(after.autoRetryCount, 0);
  assert.equal(after.autoRetryPaused, false);
  assert.equal(after.autoNextRetryAt, "");
  assert.equal(after.partnerPending, true, "清退避不能顺手把伙伴链待办抹掉");
  assert.equal(after.status, "failed");
});

test("路由：做册状态接口把自动退避翻成页面能读的一条", () => {
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "sgj-auto-retry-api-"));
  const routeUrl = pathToFileURL(path.resolve("routes/ui.js")).href;
  const dataUrl = pathToFileURL(path.resolve("lib/data.js")).href;
  const childCode = `
    import fs from "node:fs";
    import path from "node:path";
    import { UserData } from ${JSON.stringify(dataUrl)};
    import registerRoutes from ${JSON.stringify(routeUrl)};

    const home = path.join(os.homedir(), ".hanako");
    const dataDir = path.join(home, "plugin-data", "shiguangji");
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, "users.json"), JSON.stringify({ displayName: "小测试" }));
    const now = new Date();
    const dayDate = new Date(now);
    dayDate.setDate(dayDate.getDate() - (dayDate.getHours() < 4 ? 2 : 1));
    const day = [dayDate.getFullYear(), String(dayDate.getMonth() + 1).padStart(2, "0"), String(dayDate.getDate()).padStart(2, "0")].join("-");
    const data = new UserData(dataDir);
    await data.updateSettings({ autoSummary: false, moodDiscoveryMode: "off", partnerMoodEnabled: false, dayBoundaryHour: 4, modelSource: "agent" });
    await data.updateMoodHarvestState(day, {
      status: "failed",
      autoRetryCount: 3,
      autoRetryPaused: true,
      autoNextRetryAt: "",
      autoLastError: "模型未回复正文",
    });

    const routes = [];
    const app = {
      get(p, h) { routes.push({ method: "GET", path: p, handler: h }); },
      post(p, h) { routes.push({ method: "POST", path: p, handler: h }); },
      put(p, h) { routes.push({ method: "PUT", path: p, handler: h }); },
      delete(p, h) { routes.push({ method: "DELETE", path: p, handler: h }); },
    };
    registerRoutes(app, {
      dataDir,
      bus: { async request() { return { text: "OK" }; } },
      log: { info() {}, warn() {}, error() {} },
    });
    const route = routes.find((item) => item.method === "GET" && item.path === "/api/summaries/jobs");
    if (!route) throw new Error("找不到做册状态接口");
    const res = await route.handler({ json: (payload) => payload });
    if (!res.autoRetry || res.autoRetry.level !== "paused") throw new Error("做册状态没带出自动退避：" + JSON.stringify(res.autoRetry));
    if (!/今天不再自动重试/.test(res.autoRetry.message)) throw new Error("停摆文案不对：" + res.autoRetry.message);
    if (res.autoRetry.day !== day) throw new Error("自动退避没有指向目标生活日：" + res.autoRetry.day);
    console.log(JSON.stringify({ level: res.autoRetry.level, day: res.autoRetry.day, message: res.autoRetry.message }));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", childCode], {
    encoding: "utf8",
    cwd: path.resolve("."),
    env: { ...process.env, USERPROFILE: isolatedHome, HOME: isolatedHome, HANA_HOME: path.join(isolatedHome, ".hanako") },
  });
  assert.equal(result.status, 0, result.stdout + "\n" + result.stderr);
  assert.match(result.stdout, /"level":"paused"/);
});

test("路由：做册已完成但情绪链没做完时，状态条不能被藏掉", () => {
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "sgj-auto-retry-visible-"));
  const routeUrl = pathToFileURL(path.resolve("routes/ui.js")).href;
  const dataUrl = pathToFileURL(path.resolve("lib/data.js")).href;
  const childCode = `
    import fs from "node:fs";
    import path from "node:path";
    import { UserData } from ${JSON.stringify(dataUrl)};
    import registerRoutes from ${JSON.stringify(routeUrl)};

    const home = path.join(os.homedir(), ".hanako");
    const dataDir = path.join(home, "plugin-data", "shiguangji");
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, "users.json"), JSON.stringify({ displayName: "小测试" }));
    const now = new Date();
    const dayDate = new Date(now);
    dayDate.setDate(dayDate.getDate() - (dayDate.getHours() < 4 ? 2 : 1));
    const day = [dayDate.getFullYear(), String(dayDate.getMonth() + 1).padStart(2, "0"), String(dayDate.getDate()).padStart(2, "0")].join("-");

    const data = new UserData(dataDir);
    await data.updateSettings({ autoSummary: true, moodDiscoveryMode: "detailed", partnerMoodEnabled: false, dayBoundaryHour: 4, modelSource: "agent" });
    // 做册这一页早就做好了
    await data.saveSummary(day, "这一天做了点事", { source: "auto", boundaryHour: 4 });
    // 但情绪链没落定，而且已经失败过一次、正在冷却
    await data.updateMoodHarvestState(day, {
      status: "running",
      mode: "detailed",
      attemptedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      autoRetryCount: 1,
      autoRetryPaused: false,
      autoNextRetryAt: new Date(Date.now() + 7 * 60 * 1000).toISOString(),
      autoLastError: "模型未回复正文",
    });

    const routes = [];
    const app = {
      get(p, h) { routes.push({ method: "GET", path: p, handler: h }); },
      post(p, h) { routes.push({ method: "POST", path: p, handler: h }); },
      put(p, h) { routes.push({ method: "PUT", path: p, handler: h }); },
      delete(p, h) { routes.push({ method: "DELETE", path: p, handler: h }); },
    };
    registerRoutes(app, {
      dataDir,
      bus: { async request() { return { text: "OK" }; } },
      log: { info() {}, warn() {}, error() {} },
    });
    const route = routes.find((item) => item.method === "GET" && item.path === "/api/summaries/jobs");
    if (!route) throw new Error("找不到做册状态接口");
    const res = await route.handler({ json: (payload) => payload });
    if (!res.autoRetry || res.autoRetry.level !== "cooldown") {
      throw new Error("做册完成但情绪链没做完时状态条被藏了：" + JSON.stringify(res.autoRetry));
    }
    console.log(JSON.stringify({ level: res.autoRetry.level, day: res.autoRetry.day }));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", childCode], {
    encoding: "utf8",
    cwd: path.resolve("."),
    env: { ...process.env, USERPROFILE: isolatedHome, HOME: isolatedHome, HANA_HOME: path.join(isolatedHome, ".hanako") },
  });
  assert.equal(result.status, 0, result.stdout + "\n" + result.stderr);
  assert.match(result.stdout, /"level":"cooldown"/);
});

test("启动顺序：模型列表 provider 必须先注入再启动定时器", () => {
  // 定时器启动时会立刻检查一轮；若那时 provider 还没注入，Hana 档会拿到空列表，
  // 启动首轮必然报“模型列表里找不到”，而且不报错、日志无痕迹。
  const src = fs.readFileSync(path.resolve("routes/ui.js"), "utf8");
  const providerAt = src.indexOf("mc.setHanaModelsProvider(");
  const timerAt = src.indexOf("startSummaryTimer(ctx);");
  assert.ok(providerAt > 0, "找不到 mc.setHanaModelsProvider 调用");
  assert.ok(timerAt > 0, "找不到 startSummaryTimer(ctx) 调用");
  assert.ok(
    providerAt < timerAt,
    "mc.setHanaModelsProvider 必须先于 startSummaryTimer，否则启动首轮 Hana 档会拿到空列表",
  );
});

test("路由：Hana 模型列表能从 models.json 拉到带 input 的文本模型", () => {
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "sgj-hana-models-"));
  const routeUrl = pathToFileURL(path.resolve("routes/ui.js")).href;
  const dataUrl = pathToFileURL(path.resolve("lib/data.js")).href;
  const childCode = `
    import fs from "node:fs";
    import path from "node:path";
    import { UserData } from ${JSON.stringify(dataUrl)};
    import registerRoutes from ${JSON.stringify(routeUrl)};

    const home = path.join(os.homedir(), ".hanako");
    const dataDir = path.join(home, "plugin-data", "shiguangji");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(home, "users.json"), JSON.stringify({ displayName: "小测试" }));
    // HANA_HOME 已由外部环境指向这个临时目录；写一份最小 models.json
    fs.writeFileSync(path.join(home, "models.json"), JSON.stringify({
      providers: {
        minimax: {
          baseUrl: "https://api.minimaxi.com/v1",
          api: "openai-completions",
          models: [
            { id: "MiniMax-M3", name: "MiniMax M3", input: ["text", "image"] },
            { id: "image-only", name: "只有图片", input: ["image"] },
          ],
        },
        broken: { baseUrl: "", api: "openai-completions", models: [{ id: "x", input: ["text"] }] },
      },
    }));

    const data = new UserData(dataDir);
    await data.updateSettings({ autoSummary: false, moodDiscoveryMode: "off", partnerMoodEnabled: false, dayBoundaryHour: 4, modelSource: "agent" });

    const routes = [];
    const app = {
      get(p, h) { routes.push({ method: "GET", path: p, handler: h }); },
      post(p, h) { routes.push({ method: "POST", path: p, handler: h }); },
      put(p, h) { routes.push({ method: "PUT", path: p, handler: h }); },
      delete(p, h) { routes.push({ method: "DELETE", path: p, handler: h }); },
    };
    registerRoutes(app, {
      dataDir,
      bus: { async request() { return { text: "OK" }; } },
      log: { info() {}, warn() {}, error() {} },
    });
    const route = routes.find((item) => item.method === "GET" && item.path === "/api/model-config/hana-models");
    if (!route) throw new Error("找不到 Hana 模型列表接口");
    const res = await route.handler({ json: (payload) => payload });
    const list = res.models || [];
    const minimax = list.find((p) => p.providerId === "minimax");
    if (!minimax) throw new Error("没拉到 minimax：" + JSON.stringify(list));
    const ids = minimax.models.map((m) => m.modelId);
    if (!ids.includes("MiniMax-M3")) throw new Error("没拉到 MiniMax-M3：" + JSON.stringify(ids));
    if (ids.includes("image-only")) throw new Error("只有图片的模型不该出现在列表里：" + JSON.stringify(ids));
    if (list.some((p) => p.providerId === "broken")) throw new Error("没有 baseUrl 的供应商不该出现");
    console.log(JSON.stringify({ providers: list.map((p) => p.providerId), minimaxModels: ids }));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", childCode], {
    encoding: "utf8",
    cwd: path.resolve("."),
    env: {
      ...process.env,
      USERPROFILE: isolatedHome,
      HOME: isolatedHome,
      HANA_HOME: path.join(isolatedHome, ".hanako"),
    },
  });
  assert.equal(result.status, 0, result.stdout + "\n" + result.stderr);
  assert.match(result.stdout, /"providerId":"minimax"|"minimax"/);
});
