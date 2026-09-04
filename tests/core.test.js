// 拾光记 · 核心测试
// 覆盖：加密存储、注入判定、节假日、数据层（事件/生理期/待办）
//
// 生活日边界（凌晨翻篇）按用户本机日期语义工作。测试用固定 +08:00 时刻表达
// “东八区用户的一天”，因此在任何 runner（含 UTC 的 CI）上都固定东八区，避免
// 无时区日期字符串被按 runner 时区解析而错位。
process.env.TZ = "Asia/Shanghai";

import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import { encryptJson, decryptJson, EncryptedStore, loadOrCreateKey } from "../lib/crypto-store.js";
import { shouldInject, buildInjectionText, InjectionTracker } from "../lib/inject.js";
import { getBuiltinFestivals, isWorkday, getMonthFestivals } from "../lib/festivals.js";
import {
  UserData,
  dateKey,
  normalizeDateKey,
  filterDueTodos,
  isTodoOverdue,
} from "../lib/data.js";
import { normalizeReminderTime, normalizeTodoReminderWindow, formatTodoReminderWindow, parseTodoReminderText } from "../lib/todo-time.js";
import { parseUserNames, readHanaUserName } from "../lib/user-name.js";
import {
  formatRecentSummaries,
  recentLifeDayKeys,
  selectRecentSummaries,
} from "../lib/recent-summaries.js";
import {
  ADMIN_REGIONS,
  findAdministrativeRegion,
  formatAdministrativeRegion,
  getAdministrativeRegion,
} from "../lib/administrative-divisions.js";
import {
  extractCity,
  getWeatherForInject,
  normalizeWeatherResult,
  translateWeatherToMood,
  weatherCacheIsFresh,
  weatherCacheMatches,
} from "../lib/weather.js";
import {
  collectDayMessages,
  finishedLifeDayKey,
  groupHistoricalSummaryEntries,
  formatMessagesForPrompt,
  groupMessagesByAgent,
  groupSummaryMessages,
  isHanabrewInstalled,
  isSummaryAgent,
  lifeDayKey,
  lifeDayRange,
  listSummaryAgents,
  parseAgentDisplayName,
  parseHanabrewVisitorName,
  resolveSummaryAgentId,
  resolveSummaryPartner,
  isSyntheticSummaryText,
  sanitizeVisibleText,
} from "../lib/day-summary.js";

// ── 临时目录工具 ──
function tmpDir(name) {
  const d = path.join(os.tmpdir(), `sgj-test-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// ── Hana 称呼 ──
test("称呼：动态读取 displayName，修改配置后立即跟随", () => {
  assert.deepEqual(parseUserNames('{"displayName":"测试用户","username":"fallback"}'), { displayName: "测试用户", username: "fallback" });
  assert.deepEqual(parseUserNames('{"defaultUserId":"u2","users":[{"userId":"u1","displayName":"旧名字"},{"userId":"u2","displayName":"当前名字","username":"current"}]}'), { displayName: "当前名字", username: "current" });
  const d = tmpDir("user-name");
  fs.writeFileSync(path.join(d, "users.json"), JSON.stringify({ displayName: "小测试", username: "备用名" }));
  assert.equal(readHanaUserName(d), "小测试");
  fs.writeFileSync(path.join(d, "users.json"), JSON.stringify({ username: "备用名" }));
  assert.equal(readHanaUserName(d), "备用名");
  fs.writeFileSync(path.join(d, "users.json"), JSON.stringify({ defaultUserId: "u2", users: [{ userId: "u1", displayName: "旧名字" }, { userId: "u2", displayName: "当前名字" }] }));
  assert.equal(readHanaUserName(d), "当前名字");
  fs.writeFileSync(path.join(d, "users.json"), "bad json");
  assert.equal(readHanaUserName(d), "");
});

// ── 加密存储 ──
test("加密：roundtrip 可解回原值", () => {
  const key = loadOrCreateKey(tmpDir("k1"));
  const obj = { a: 1, b: "生理期", c: [1, 2, 3] };
  const cipher = encryptJson(key, obj);
  assert.ok(!cipher.includes("生理期"), "密文不应含明文");
  const back = decryptJson(key, cipher);
  assert.deepEqual(back, obj);
});

test("加密：密钥不同则解不开", () => {
  const d1 = tmpDir("k2a");
  const d2 = tmpDir("k2b");
  const k1 = loadOrCreateKey(d1);
  const k2 = loadOrCreateKey(d2);
  const cipher = encryptJson(k1, { secret: "hello" });
  assert.equal(decryptJson(k2, cipher), null, "错误密钥应解不开");
});

test("加密：密文损坏返回 null 不抛错", () => {
  const key = loadOrCreateKey(tmpDir("k3"));
  assert.equal(decryptJson(key, "garbage"), null);
  assert.equal(decryptJson(key, "a:b"), null);
  assert.equal(decryptJson(key, ""), null);
});

test("加密存储：写入后能读回，损坏回退默认值", async () => {
  const d = tmpDir("s1");
  const store = new EncryptedStore({ dataDir: d, fileName: "t.dat", defaults: { x: 1 } });
  assert.equal(store.read().x, 1);
  await store.update((data) => { data.y = 2; });
  const store2 = new EncryptedStore({ dataDir: d, fileName: "t.dat", defaults: { x: 1 } });
  assert.equal(store2.read().y, 2);
  // 损坏
  fs.writeFileSync(path.join(d, "t.dat"), "corrupted!!!");
  const store3 = new EncryptedStore({ dataDir: d, fileName: "t.dat", defaults: { x: 1 } });
  assert.deepEqual(store3.read(), { x: 1 }, "损坏后回退默认值");
});

test("加密存储：密文文件不含明文关键词", async () => {
  const d = tmpDir("s2");
  const store = new EncryptedStore({ dataDir: d, fileName: "user.dat", defaults: {} });
  await store.update((data) => { data.period = "生理期第3天"; });
  const raw = fs.readFileSync(path.join(d, "user.dat"), "utf-8");
  assert.ok(!raw.includes("生理期"), "密文文件不应有明文");
});

// ── 注入判定 ──
const D1 = new Date(2026, 7, 28, 10, 0, 0); // 2026-08-28 10:00

test("注入：新会话必带", () => {
  const r = shouldInject({ sessionId: "s1", now: D1, mode: "balanced", lastState: null });
  assert.equal(r.should, true);
  assert.equal(r.reason, "new-session");
});

test("注入：总开关关闭时不带，重新打开立即恢复", () => {
  const off = shouldInject({
    sessionId: "off-session",
    now: D1,
    mode: "balanced",
    injectionEnabled: false,
    hasSpecialDay: true,
    lastState: null,
  });
  assert.equal(off.should, false);
  assert.equal(off.reason, "injection-disabled");
  assert.equal(off.newState.injectionEnabled, false);

  const on = shouldInject({
    sessionId: "off-session",
    now: new Date(D1.getTime() + 1000),
    mode: "balanced",
    injectionEnabled: true,
    lastState: off.newState,
  });
  assert.equal(on.should, true);
  assert.equal(on.reason, "injection-enabled");
  assert.equal(on.newState.injectionEnabled, true);
});

test("注入：跨天必带", () => {
  const last = { lastInjectAt: D1.getTime(), lastDateKey: "2026-08-27", lastHash: "" };
  const r = shouldInject({ sessionId: "s1", now: D1, mode: "balanced", lastState: last });
  assert.equal(r.should, true);
  assert.equal(r.reason, "day-changed");
});

test("注入：特殊日子遵守档位节奏，不退化成每轮注入", () => {
  const last = { lastInjectAt: D1.getTime(), lastDateKey: "2026-08-28", lastHash: "" };
  const economical = shouldInject({ sessionId: "s1", now: new Date(D1.getTime() + 1000), mode: "economical", lastState: last, hasSpecialDay: true });
  assert.equal(economical.should, false);
  const balanced = shouldInject({ sessionId: "s1", now: new Date(D1.getTime() + 1000), mode: "balanced", intervalHours: 4, lastState: last, hasSpecialDay: true });
  assert.equal(balanced.should, false);
  const always = shouldInject({ sessionId: "s1", now: new Date(D1.getTime() + 1000), mode: "always", lastState: last, hasSpecialDay: true });
  assert.equal(always.should, true);
});

test("注入：省电模式无特殊日子不带", () => {
  const last = { lastInjectAt: D1.getTime(), lastDateKey: "2026-08-28", lastHash: "" };
  const r = shouldInject({ sessionId: "s1", now: D1, mode: "economical", lastState: last, hasSpecialDay: false });
  assert.equal(r.should, false);
  assert.equal(r.reason, "economical-no-special");
});

test("注入：均衡模式间隔内不带，超间隔带", () => {
  const last = { lastInjectAt: D1.getTime(), lastDateKey: "2026-08-28", lastHash: "" };
  // 2 小时后（间隔 4 小时）：不带
  const soon = new Date(D1.getTime() + 2 * 3600 * 1000);
  const r1 = shouldInject({ sessionId: "s1", now: soon, mode: "balanced", intervalHours: 4, lastState: last });
  assert.equal(r1.should, false);
  assert.equal(r1.reason, "within-interval");
  // 5 小时后：带
  const later = new Date(D1.getTime() + 5 * 3600 * 1000);
  const r2 = shouldInject({ sessionId: "s1", now: later, mode: "balanced", intervalHours: 4, lastState: last });
  assert.equal(r2.should, true);
  assert.equal(r2.reason, "interval");
});

test("注入：每轮模式无特殊日子也带", () => {
  const last = { lastInjectAt: D1.getTime(), lastDateKey: "2026-08-28", lastHash: "" };
  const soon = new Date(D1.getTime() + 1000);
  const r = shouldInject({ sessionId: "s1", now: soon, mode: "always", lastState: last, hasSpecialDay: false });
  assert.equal(r.should, true);
  assert.equal(r.reason, "mode-always");
});

test("注入：设置上下文变化立即刷新，不等间隔", () => {
  const last = { lastInjectAt: D1.getTime(), lastDateKey: "2026-08-28", lastHash: "same", contextKey: "old" };
  const r = shouldInject({
    sessionId: "s1", now: new Date(D1.getTime() + 1000), mode: "balanced", lastState: last, contextKey: "new",
  });
  assert.equal(r.should, true);
  assert.equal(r.reason, "settings-changed");
  assert.equal(r.newState.contextKey, "new");
});

test("注入：相伴的30分钟和常在的每轮行为不同", () => {
  const last = { lastInjectAt: D1.getTime(), lastDateKey: "2026-08-28", lastHash: "", injectionEnabled: true };
  const within = shouldInject({
    sessionId: "rhythm", now: new Date(D1.getTime() + 29 * 60 * 1000), mode: "balanced", intervalHours: 0.5, lastState: last,
  });
  assert.equal(within.should, false, "30分钟内不应每轮注入");
  const afterGap = shouldInject({
    sessionId: "rhythm", now: new Date(D1.getTime() + 30 * 60 * 1000), mode: "balanced", intervalHours: 0.5, lastState: last,
  });
  assert.equal(afterGap.should, true, "空档达到30分钟后才注入");
  const everyTurn = shouldInject({
    sessionId: "rhythm", now: new Date(D1.getTime() + 1000), mode: "always", lastState: last,
  });
  assert.equal(everyTurn.should, true, "常在模式每轮都应注入");
});

test("注入：Tracker 防膨胀", () => {
  const t = new InjectionTracker();
  for (let i = 0; i < 600; i++) t.set("s" + i, { x: i });
  assert.ok(t.sessions.size <= 500, "不应超过 500");
});

// ── 注入文本 ──
test("注入文本：含特殊日子和待办", () => {
  const text = buildInjectionText({
    now: D1,
    builtinFestivals: [{ name: "七夕", emoji: "💞", source: "农历" }],
    userEvents: [{ title: "测试用户的生日", type: "anniversary" }],
    todosDue: [{ title: "交稿", done: false }],
    periods: [],
  });
  assert.ok(text.includes("今日时光"));
  assert.ok(text.includes("2026年8月28日"));
  assert.ok(text.includes("七夕"));
  assert.ok(text.includes("测试用户的生日"));
  assert.ok(text.includes("交稿"));
});

test("注入文本：逾期待办只报条数，不逐条刷屏；今天到期照常列出", () => {
  // D1=2026-08-28：到期日为 08-27 是逾期，08-28 是今天；未来待办由调用方过滤，不在本函数职责内。
  const text = buildInjectionText({
    now: D1,
    todosDue: [
      { id: "overdue-a", title: "陈年旧账一", type: "todo", date: "2026-08-27", done: false },
      { id: "overdue-b", title: "陈年旧账二", type: "todo", date: "2026-08-26", done: false },
      { id: "today", title: "今天要做", type: "todo", date: "2026-08-28", done: false },
    ],
    force: true,
  });
  assert.ok(text.includes("今日待办：今天要做"), text);
  assert.ok(!text.includes("陈年旧账一"), "逾期标题不应逐条出现: " + text);
  assert.ok(!text.includes("陈年旧账二"), "逾期标题不应逐条出现: " + text);
  assert.ok(text.includes("另有 2 条待办已经逾期"), text);
});

test("注入文本：只有逾期待办时不再列空今日待办", () => {
  const text = buildInjectionText({
    now: D1,
    todosDue: [
      { id: "overdue-only", title: "只剩旧账", type: "todo", date: "2026-08-25", done: false },
    ],
    force: true,
  });
  assert.ok(!text.includes("今日待办"), text);
  assert.ok(text.includes("另有 1 条待办已经逾期"), text);
});

test("注入文本：逾期带完成态时不再计入条数", () => {
  const text = buildInjectionText({
    now: D1,
    todosDue: [
      { id: "overdue-done", title: "做完的旧账", type: "todo", date: "2026-08-27", done: true },
      { id: "today-done", title: "做完的今天", type: "todo", date: "2026-08-28", done: true },
    ],
    force: true,
  });
  assert.ok(!text.includes("今日待办"), text);
  assert.ok(!text.includes("逾期"), text);
});

test("注入文本：无特殊信息且非强制返回 null（避免噪音）", () => {
  const text = buildInjectionText({ now: D1 });
  assert.equal(text, null);
});

test("注入文本：强制时即使无特殊信息也返回日期行", () => {
  const text = buildInjectionText({ now: D1, force: true });
  assert.ok(text.includes("2026年8月28日"), text);
  assert.ok(!text.includes("今天是："), "无特殊日子不应有今天是行");
});

test("注入文本：生理期用关怀文案而非天数", () => {
  const p = { date: "2026-08-26" };
  const text = buildInjectionText({ now: D1, periods: [p] });
  assert.ok(text.includes("生理期"), text);
  assert.ok(text.includes("容易累"), text);
  assert.ok(text.includes("多照顾她一点"), text);
  assert.ok(!/生理期第\d+天/.test(text), "不应复述具体第几天: " + text);
});

test("注入文本：生理期结束后第一天替她高兴", () => {
  const text = buildInjectionText({
    now: new Date(2026, 7, 31, 8, 0, 0),
    periods: [],
    periodEndedYesterday: true,
    force: true,
  });
  assert.ok(text.includes("替她高兴"), text);
  assert.ok(text.includes("昨天刚结束生理期"), text);
});

test("注入文本：非结束后第一天不生成高兴文案", () => {
  const text = buildInjectionText({
    now: new Date(2026, 7, 31, 8, 0, 0),
    periods: [],
    periodEndedYesterday: false,
    force: true,
  });
  assert.ok(!text.includes("替她高兴"), text);
});

test("注入文本：不带时间时省略时刻", () => {
  const text = buildInjectionText({ now: D1, includeTime: false, builtinFestivals: [{ name: "七夕", emoji: "💞" }] });
  assert.ok(!text.includes("10:00"), text);
  assert.ok(text.includes("2026年8月28日"));
});

test("生活日总结：按伙伴分组且近期默认不跨伙伴", async () => {
  const d = tmpDir("summary-by-agent");
  const ud = new UserData(d);
  await ud.saveAgentSummary("2026-08-29", "hanako", "和用户聊了插件", { agentName: "小花", messageCount: 4 });
  await ud.saveAgentSummary("2026-08-29", "partner-two", "和用户聊了天气", { agentName: "另一位伙伴", messageCount: 2 });
  await ud.saveAgentSummary("2026-08-20", "hanako", "以前一起做过一个插件", { agentName: "小花", importance: 8 });
  await ud.saveSummary("2026-08-28", "混合旧档案", { source: "auto" });
  const encrypted = fs.readFileSync(path.join(d, "daily-summaries.dat"), "utf-8");
  assert.ok(!encrypted.includes("和用户聊了插件"), "分类总结也必须保持加密");
  const entries = ud.listSummaryEntries();
  assert.equal(entries.length, 4);
  assert.equal(ud.getAgentSummary("2026-08-29", "hanako").text, "和用户聊了插件");
  assert.equal(ud.hasAgentSummary("2026-08-29"), true);
  assert.equal(ud.hasAgentSummary("2026-08-28"), false, "只有旧混合档案不算分类总结");
  assert.equal(entries.find((entry) => entry.unclassified).agentName, undefined);

  const now = new Date(2026, 7, 30, 10, 0, 0);
  const privateView = selectRecentSummaries(entries, { now, boundaryHour: 4, currentAgentId: "hanako" });
  assert.ok(privateView.entries.length >= 1);
  assert.ok(privateView.entries.every((entry) => entry.agentId === "hanako"));
  assert.ok(privateView.entries.some((entry) => entry.date === "2026-08-29"));
  assert.ok(!privateView.entries.some((entry) => entry.text === "混合旧档案"));

  const sharedView = selectRecentSummaries(entries, {
    now, boundaryHour: 4, currentAgentId: "hanako", shared: true, prompt: "以前做过的插件",
  });
  assert.ok(sharedView.entries.some((entry) => entry.agentId === "partner-two"), "共享模式应包含其他伙伴近期动态");
  assert.ok(sharedView.entries.some((entry) => entry.expanded && entry.date === "2026-08-20"), "相关旧档案应按需展开");
  const text = formatRecentSummaries(sharedView.entries, { currentAgentId: "hanako", shared: true });
  assert.ok(text.includes("另一位伙伴"));
  assert.ok(text.includes("近期回忆"));
});

test("生活日总结：没有可靠伙伴身份时默认不注入", () => {
  const entries = [{ date: "2026-08-29", agentId: "hanako", text: "私密内容" }];
  const result = selectRecentSummaries(entries, { now: new Date(2026, 7, 30, 10), boundaryHour: 4 });
  assert.deepEqual(result.entries, []);
  assert.deepEqual(recentLifeDayKeys(new Date(2026, 7, 30, 10), 4), ["2026-08-29", "2026-08-28", "2026-08-27"]);
});

test("生活日总结：同日跨窗口时明确区分上一生活日与前一个对话框", () => {
  const text = buildInjectionText({
    now: new Date(2026, 7, 31, 23, 27),
    recentSummaries: [
      { date: "2026-08-30", agentId: "hanako", agentName: "小花", text: "一起把日历整理好了" },
      { date: "2026-08-29", agentId: "hanako", agentName: "小花", text: "之前一起做过一个插件" },
    ],
    recentSummaryOptions: { currentAgentId: "hanako", shared: false, proactiveDate: "2026-08-30" },
  });
  assert.ok(text.includes("【已收好的上一生活日｜2026-08-30】"));
  assert.ok(text.includes("一起把日历整理好了"));
  assert.ok(text.includes("【近期回忆】"));
  assert.ok(text.includes("属于已经结束的生活日 2026-08-30"));
  assert.ok(text.includes("档案正文中的“昨天/今天”等相对日期词，也以这个生活日日期为准"));
  assert.ok(text.includes("档案中的时间以 2026-08-30 为准"));
  assert.ok(text.includes("不等于上一个聊天窗口"));
  assert.ok(text.includes("同一自然日内的前一个对话框不属于这份档案"));
  assert.ok(text.includes("今天早些时候"));
  assert.ok(text.includes("这段已经收好的生活有被记住"));
  assert.ok(!text.includes("【昨日回望】"));
  assert.ok(!text.includes("昨天的时光有被收好"));
});

test("注入文本：旧总结调用方也使用带日期的生活日标签", () => {
  const text = buildInjectionText({
    now: new Date(2026, 7, 31, 23, 27),
    summary: { date: "2026-08-30", text: "旧调用方的总结" },
    force: true,
  });
  assert.ok(text.includes("已收好的生活日回顾｜2026-08-30：旧调用方的总结"));
  assert.ok(!text.includes("昨日回顾："));
});

test("后台总结任务：加密持久化、状态更新和重启读取", async () => {
  const d = tmpDir("summary-jobs");
  const ud = new UserData(d);
  await ud.createSummaryJob({
    id: "job-one",
    dates: ["2026-08-28", "2026-08-29"],
    status: "queued",
    outcomes: [],
  });
  await ud.updateSummaryJob("job-one", {
    status: "running",
    currentDate: "2026-08-28",
    outcomes: [{ date: "2026-08-28", status: "done", summaryCount: 2 }],
  });
  const restored = new UserData(d).getSummaryJob("job-one");
  assert.equal(restored.status, "running");
  assert.equal(restored.currentDate, "2026-08-28");
  assert.deepEqual(restored.outcomes.map((item) => item.date), ["2026-08-28"]);
  assert.equal(new UserData(d).listSummaryJobs(1)[0].id, "job-one");
  const raw = fs.readFileSync(path.join(d, "summary-jobs.dat"), "utf8");
  assert.ok(!raw.includes("2026-08-28"), "后台任务状态文件不应暴露明文日期");
});

test("注入文本：天气带当前温度与轻动作融入方向", () => {
  const text = buildInjectionText({
    now: D1,
    weather: { line: "多云，26°C", temp: 26 },
    force: true,
  });
  assert.ok(text.includes("多云，26°C"), text);
  assert.ok(text.includes("看了眼手机上的天气预报"), text);
  assert.ok(text.includes("天气和当前温度"), text);
});

// ── 行政区与天气坐标 ──
test("行政区：内置有效区县和 WGS84 中心点", () => {
  assert.ok(ADMIN_REGIONS.length > 2800, "应覆盖大多数有坐标的区县");
  assert.ok(ADMIN_REGIONS.every((region) => Number.isFinite(region.latitude) && Number.isFinite(region.longitude)));
  const wuhou = getAdministrativeRegion("510107");
  assert.deepEqual(
    { code: wuhou.code, province: wuhou.province, city: wuhou.city, district: wuhou.district },
    { code: "510107", province: "四川省", city: "成都市", district: "武侯区" },
  );
  assert.ok(Math.abs(wuhou.longitude - 104.040793) < 0.000001, "应已从 GCJ-02 转为 WGS84");
  assert.equal(formatAdministrativeRegion(wuhou), "四川省 成都市 武侯区");
});

test("行政区：旧版地点文字能回填唯一区县", () => {
  assert.equal(findAdministrativeRegion("成都 武侯区").code, "510107");
  assert.equal(findAdministrativeRegion("四川省 成都市 武侯区").code, "510107");
  assert.equal(extractCity("四川省 成都市 武侯区"), "成都市");
  assert.equal(extractCity("成都 武侯区"), "成都");
});

test("天气：旧缓存补出状态并修复晴天夜间文案", () => {
  const legacy = normalizeWeatherResult({
    place: "成都 武侯区",
    line: "晴空万里，阳光正好，26°C，天已经黑了",
    temp: 26,
  });
  assert.equal(legacy.line, "晴朗，26°C，夜色清亮");
  assert.equal(legacy.code, 0);
  assert.equal(legacy.isDay, false);

  const legacyPartly = normalizeWeatherResult({
    line: "大晴天，就是云不多，26°C，天已经黑了",
  });
  assert.equal(legacyPartly.code, 1);
  assert.equal(legacyPartly.line, "晴朗，云不多，26°C，夜色清亮");
});

test("天气：晴天文案遵守昼夜语义", () => {
  const day = translateWeatherToMood({
    current: { temperature_2m: 26.4, weather_code: 0, is_day: 1, time: "2026-08-30T12:00:00+08:00" },
  });
  const night = translateWeatherToMood({
    current: { temperature_2m: 26.4, weather_code: 0, is_day: 0, time: "2026-08-30T20:00:00+08:00" },
  });
  assert.match(day.line, /阳光正好/);
  assert.doesNotMatch(night.line, /阳光正好/);
  assert.match(night.line, /夜色清亮/);
  assert.equal(night.code, 0);
  assert.equal(night.isDay, false);
});

test("天气：选中区县后直接用坐标，不再调用城市搜索", async () => {
  const calls = [];
  let saved = null;
  const data = {
    getSettings() { return { weatherIntervalHours: 3 }; },
    getWeatherCache() { return null; },
    async setWeatherCache(value) { saved = value; },
  };
  const weather = await getWeatherForInject({
    data,
    location: "四川省 成都市 武侯区",
    coordinates: { latitude: 30.64432, longitude: 104.040793 },
    now: new Date("2026-08-30T02:00:00.000Z"),
    fetcher: async (url) => {
      calls.push(url);
      return { current: { temperature_2m: 26.4, weather_code: 2, is_day: 1, time: "2026-08-30T10:00:00+08:00" } };
    },
  });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].startsWith("https://api.open-meteo.com/v1/forecast?"));
  assert.match(calls[0], /latitude=30\.64432/);
  assert.match(calls[0], /longitude=104\.040793/);
  assert.equal(weather.place, "四川省 成都市 武侯区");
  assert.equal(weather.temp, 26);
  assert.equal(weather.code, 2);
  assert.equal(weather.isDay, true);
  assert.deepEqual(saved.coordinates, { lat: 30.64432, lon: 104.040793 });
});

test("天气：旧版成都+区配置自动使用匹配区县坐标，旧缓存仍可命中", async () => {
  const region = getAdministrativeRegion("510107");
  let calls = 0;
  const data = {
    getSettings() { return { weatherLocation: "成都 武侯区", weatherIntervalHours: 3 }; },
    getWeatherCache() { return { location: "成都 武侯区", fetchedAt: Date.now() - 1000, result: { place: "成都 武侯区", line: "旧缓存", temp: 25 } }; },
    async setWeatherCache() { throw new Error("不应写入有效缓存"); },
  };
  assert.equal(weatherCacheMatches(data.getWeatherCache(), data.getSettings()), true);
  const cached = await getWeatherForInject({
    data,
    location: "成都 武侯区",
    fetcher: async () => { calls++; return null; },
  });
  assert.equal(cached.line, "旧缓存");
  assert.equal(calls, 0);

  const urls = [];
  const expiredData = {
    getSettings() { return { weatherLocation: "成都 武侯区", weatherIntervalHours: 3 }; },
    getWeatherCache() { return { location: "成都 武侯区", fetchedAt: 0, result: null }; },
    async setWeatherCache() {},
  };
  const refreshed = await getWeatherForInject({
    data: expiredData,
    location: "成都 武侯区",
    fetcher: async (url) => {
      urls.push(url);
      return { current: { temperature_2m: 25.2, weather_code: 1, is_day: 1, time: "2026-08-30T10:00:00+08:00" } };
    },
  });
  assert.equal(refreshed.place, "成都 武侯区");
  assert.equal(urls.length, 1);
  assert.match(urls[0], new RegExp("latitude=" + region.latitude));
  assert.match(urls[0], new RegExp("longitude=" + region.longitude));
});

test("天气：过期或未来时间的缓存都不能当作当前天气", () => {
  const now = new Date("2026-09-04T20:00:00+08:00");
  const fresh = { fetchedAt: now.getTime() - 2 * 3600 * 1000, result: { line: "晴朗" } };
  const expired = { fetchedAt: now.getTime() - 4 * 3600 * 1000, result: { line: "晴空万里，阳光正好" } };
  const future = { fetchedAt: now.getTime() + 60 * 1000, result: { line: "晴空万里，阳光正好" } };
  assert.equal(weatherCacheIsFresh(fresh, { weatherIntervalHours: 3 }, now), true);
  assert.equal(weatherCacheIsFresh(expired, { weatherIntervalHours: 3 }, now), false);
  assert.equal(weatherCacheIsFresh(future, { weatherIntervalHours: 3 }, now), false);
  assert.equal(weatherCacheIsFresh({ fetchedAt: now.getTime(), result: null }, { weatherIntervalHours: 3 }, now), false);
});

// ── 节假日 ──
test("节假日：国庆节 10-01", () => {
  const f = getBuiltinFestivals(new Date(2026, 9, 1));
  assert.ok(f.some((x) => x.name === "国庆节"));
});

test("节假日：春节 2026-02-17（农历映射）", () => {
  const f = getBuiltinFestivals(new Date(2026, 1, 17));
  assert.ok(f.some((x) => x.name === "春节"));
});

test("节假日：普通日子无节日", () => {
  const f = getBuiltinFestivals(new Date(2026, 6, 15));
  assert.equal(f.length, 0);
});

test("节假日：调休上班日判定", () => {
  assert.equal(isWorkday(new Date(2026, 1, 14)), true); // 2026-02-14 调休上班
  assert.equal(isWorkday(new Date(2026, 1, 15)), false); // 2026-02-15 春节假
});

test("节假日：月视图", () => {
  const map = getMonthFestivals(2026, 10); // 10 月
  assert.ok(map.has("2026-10-01"), "10月1日应有国庆");
});

test("节假日：同名节日不重复（法定+农历双源去重）", () => {
  // 中秋/春节/端午/国庆在法定和农历/公历表里都有，只应报一次
  for (const [dk, name] of [
    ["2026-09-25", "中秋节"],
    ["2026-02-17", "春节"],
    ["2026-06-19", "端午节"],
    ["2026-10-01", "国庆节"],
    ["2026-01-01", "元旦"],
  ]) {
    const [y, m, d] = dk.split("-").map(Number);
    const f = getBuiltinFestivals(new Date(y, m - 1, d));
    const count = f.filter((x) => x.name === name).length;
    assert.equal(count, 1, `${name}（${dk}）应只出现一次，实际 ${count} 次：${JSON.stringify(f)}`);
  }
});

// ── 数据层 ──
test("数据层：添加/查询/删除事件", async () => {
  const d = tmpDir("u1");
  const ud = new UserData(d);
  const ev = await ud.addEvent({ title: "我的生日", type: "anniversary", date: "08-08", repeatYearly: true });
  assert.ok(ev.id);
  // 每年重复：任意 8 月 8 日都应命中
  const hit = ud.eventsOnDate(new Date(2030, 7, 8));
  assert.equal(hit.length, 1);
  assert.equal(hit[0].title, "我的生日");
  // 其他日期不命中
  assert.equal(ud.eventsOnDate(new Date(2030, 7, 9)).length, 0);
  // 删除
  await ud.removeEvent(ev.id);
  assert.equal(ud.eventsOnDate(new Date(2030, 7, 8)).length, 0);
});

test("数据版本号：用户数据写操作递增 rev（供注入即时刷新）", async () => {
  const d = tmpDir("datarev");
  const ud = new UserData(d);
  assert.equal(ud.getDataRev(), 0);
  // 新增日子 → +1
  const ev = await ud.addEvent({ title: "纪念日", type: "anniversary", date: "08-08" });
  const rev1 = ud.getDataRev();
  assert.ok(rev1 >= 1);
  // 待办切换 → +1
  const todo = await ud.addEvent({ title: "交稿", type: "todo", date: "2026-08-28", reminderStart: "15:00", reminderEnd: "15:00" });
  const rev2 = ud.getDataRev();
  assert.ok(rev2 > rev1);
  await ud.toggleTodo(todo.id);
  const rev3 = ud.getDataRev();
  assert.ok(rev3 > rev2);
  // 总结写入 → +1
  await ud.saveSummary("2026-08-28", "今天聊了插件");
  const rev4 = ud.getDataRev();
  assert.ok(rev4 > rev3);
  // 重启后 rev 保留
  assert.equal(new UserData(d).getDataRev(), rev4);
  // 数据版本号文件也应加密（不暴露明文数字语义无妨，但不应有泄漏内容）
  const raw = fs.readFileSync(path.join(d, "data-rev.dat"), "utf8");
  assert.ok(!raw.includes("rev"), "版本号文件不暴露字段名明文");
});

test("数据层：生理期按周期命中", async () => {
  const d = tmpDir("u2");
  const ud = new UserData(d);
  // 08-26 开始，持续 5 天
  await ud.addEvent({ title: "生理期", type: "period", date: "2026-08-26", note: "5" });
  assert.equal(ud.periodsActiveOn(new Date(2026, 7, 26)).length, 1);
  assert.equal(ud.periodsActiveOn(new Date(2026, 7, 30)).length, 1, "第5天还在");
  assert.equal(ud.periodsActiveOn(new Date(2026, 7, 31)).length, 0, "第6天结束");
});

test("数据层：endPeriodOn 周期内截断到今天", async () => {
  const d = tmpDir("u2b");
  const ud = new UserData(d);
  await ud.addEvent({ title: "生理期", type: "period", date: "2026-08-26", note: "5" });
  // 8/30（第 5 天）确认结束 → 周期截断到 8/30，8/31 起不算
  const r = await ud.endPeriodOn(new Date(2026, 7, 30));
  assert.equal(r.changed, true);
  const p = ud.events.read().events[Object.keys(ud.events.read().events)[0]];
  assert.equal(p.note, "5", "在最后一天结束不应缩短天数");
  assert.equal(ud.periodsActiveOn(new Date(2026, 7, 30)).length, 1);
  assert.equal(ud.periodsActiveOn(new Date(2026, 7, 31)).length, 0);
});

test("数据层：endPeriodOn 结束后第一天只确认不删昨天", async () => {
  const d = tmpDir("u2c");
  const ud = new UserData(d);
  await ud.addEvent({ title: "生理期", type: "period", date: "2026-08-26", note: "5" });
  // 8/31 已不在周期内（周期到 8/30），但昨天 8/30 在 → 确认结束，不删 8/30
  const r = await ud.endPeriodOn(new Date(2026, 7, 31));
  assert.equal(r.changed, true);
  assert.equal(ud.periodsActiveOn(new Date(2026, 7, 30)).length, 1, "8/30 应保留");
  assert.equal(ud.periodsActiveOn(new Date(2026, 7, 31)).length, 0);
  const p = ud.events.read().events[Object.keys(ud.events.read().events)[0]];
  assert.equal(p.note, "5", "天数不应变化");
});

test("数据层：endPeriodOn 无周期时无操作", async () => {
  const d = tmpDir("u2d");
  const ud = new UserData(d);
  const r = await ud.endPeriodOn(new Date(2026, 7, 31));
  assert.equal(r.changed, false);
  assert.equal(r.period, null);
});

test("数据层：待办到期命中", async () => {
  const d = tmpDir("u3");
  const ud = new UserData(d);
  await ud.addEvent({ title: "交稿", type: "todo", date: "2026-08-28", reminderStart: "15:00", reminderEnd: "15:00" });
  const todos = ud.listEvents().filter((e) => e.type === "todo" && e.date === "2026-08-28");
  assert.equal(todos.length, 1);
});

test("待办：提醒时间支持准点与时间段，缺失或倒置时拒绝保存", async () => {
  assert.equal(normalizeReminderTime("15:00"), "15:00");
  assert.equal(normalizeReminderTime("25:00"), "");
  assert.deepEqual(normalizeTodoReminderWindow("15:00", "15:00"), {
    reminderStart: "15:00",
    reminderEnd: "15:00",
  });
  assert.deepEqual(normalizeTodoReminderWindow("15:00", "17:30"), {
    reminderStart: "15:00",
    reminderEnd: "17:30",
  });
  assert.equal(formatTodoReminderWindow("15:00", "15:00"), "15:00 准点");
  assert.equal(formatTodoReminderWindow("15:00", "17:30"), "15:00–17:30");
  assert.throws(() => normalizeTodoReminderWindow("", ""), /待办需要选择提醒时间/);
  assert.throws(() => normalizeTodoReminderWindow("15:00"), /待办需要选择提醒时间/);
  assert.throws(() => normalizeTodoReminderWindow("17:30", "15:00"), /开始不能晚于结束/);
  assert.deepEqual(parseTodoReminderText("下午三点带圆宝出去玩"), {
    reminderStart: "15:00",
    reminderEnd: "15:00",
  });
  assert.deepEqual(parseTodoReminderText("下午三点半带圆宝出去玩"), {
    reminderStart: "15:30",
    reminderEnd: "15:30",
  });
  assert.deepEqual(parseTodoReminderText("下午三点到五点买纸"), {
    reminderStart: "15:00",
    reminderEnd: "17:00",
  });
  assert.deepEqual(parseTodoReminderText("15:00-17:00买纸"), {
    reminderStart: "15:00",
    reminderEnd: "17:00",
  });
  assert.deepEqual(parseTodoReminderText("晚上十二点回家"), {
    reminderStart: "00:00",
    reminderEnd: "00:00",
  });
  assert.deepEqual(parseTodoReminderText("中午要和慧慧逛街，9点提醒我准备化妆"), {
    reminderStart: "09:00",
    reminderEnd: "09:00",
  });
  const daytimeNow = new Date(2026, 8, 2, 14, 7, 0);
  assert.deepEqual(parseTodoReminderText("两点 15分要去买椰子水", {
    now: daytimeNow,
    targetDate: "2026-09-02",
  }), {
    reminderStart: "14:15",
    reminderEnd: "14:15",
  });
  assert.deepEqual(parseTodoReminderText("两点十五分要去买椰子水", {
    now: new Date(2026, 8, 2, 5, 30, 0),
    targetDate: "2026-09-02",
  }), {
    reminderStart: "02:15",
    reminderEnd: "02:15",
  });
  assert.deepEqual(parseTodoReminderText("下午两点15分要去买椰子水", {
    now: daytimeNow,
    targetDate: "2026-09-02",
  }), {
    reminderStart: "14:15",
    reminderEnd: "14:15",
  });
  assert.deepEqual(parseTodoReminderText("两点十五分要去买椰子水", {
    now: daytimeNow,
    targetDate: "2026-09-03",
  }), {
    reminderStart: "02:15",
    reminderEnd: "02:15",
  });
  assert.deepEqual(parseTodoReminderText("九点提醒我准备化妆"), {
    reminderStart: "09:00",
    reminderEnd: "09:00",
  });
  assert.deepEqual(parseTodoReminderText("中午12点要和慧慧逛街，9点提醒我准备化妆"), {
    reminderStart: "09:00",
    reminderEnd: "09:00",
  });
  assert.deepEqual(parseTodoReminderText("上午九点到十点提醒我准备化妆"), {
    reminderStart: "09:00",
    reminderEnd: "10:00",
  });
  assert.deepEqual(parseTodoReminderText("下午3:30-5:30提醒我开会"), {
    reminderStart: "15:30",
    reminderEnd: "17:30",
  });
  assert.equal(parseTodoReminderText("下午三点后带圆宝出去玩"), null);
  assert.equal(parseTodoReminderText("下午三点左右带圆宝出去玩"), null);
  assert.equal(parseTodoReminderText("下午三点一刻带圆宝出去玩"), null);
  assert.equal(parseTodoReminderText("下午三点到五点后带圆宝出去玩"), null);
  assert.equal(parseTodoReminderText("下午五点到三点带圆宝出去玩"), null);
  assert.equal(parseTodoReminderText("带圆宝出去玩"), null);

  const d = tmpDir("todo-time-required");
  const ud = new UserData(d);
  await assert.rejects(
    ud.addEvent({ title: "没有时间", type: "todo", date: "2026-09-01" }),
    /待办需要选择提醒时间/,
  );
  assert.equal(ud.listEvents().length, 0, "校验失败不应留下半条待办");
  const exact = await ud.addEvent({
    title: "准点待办", type: "todo", date: "2026-09-01", reminderStart: "15:00", reminderEnd: "15:00",
  });
  assert.equal(exact.reminderStart, "15:00");
  assert.equal(exact.reminderEnd, "15:00");
  const range = await ud.addEvent({
    title: "时段待办", type: "todo", date: "2026-09-01", reminderStart: "15:00", reminderEnd: "17:30",
  });
  assert.equal(range.reminderStart, "15:00");
  assert.equal(range.reminderEnd, "17:30");
  await assert.rejects(
    ud.updateEvent(range.id, { reminderStart: "18:00", reminderEnd: "17:00" }),
    /开始不能晚于结束/,
  );
  assert.equal(ud.getEvent(range.id).reminderStart, "15:00", "更新失败不应污染原时间");
});

test("待办标题时间：中文数字“十”可识别", () => {
  assert.deepEqual(parseTodoReminderText("上午十点带圆宝去打针"), {
    reminderStart: "10:00",
    reminderEnd: "10:00",
  });
  assert.deepEqual(parseTodoReminderText("上午十点半带圆宝去打针"), {
    reminderStart: "10:30",
    reminderEnd: "10:30",
  });
  assert.deepEqual(parseTodoReminderText("上午十点到十一点带圆宝去打针"), {
    reminderStart: "10:00",
    reminderEnd: "11:00",
  });
  assert.deepEqual(parseTodoReminderText("上午十点到下午两点开会"), {
    reminderStart: "10:00",
    reminderEnd: "14:00",
  });
});

test("数据层：旧待办编辑时必须补上提醒时间", async () => {
  const d = tmpDir("legacy-todo-time");
  const ud = new UserData(d);
  await ud.events.update((data) => {
    data.events.legacy = {
      id: "legacy", title: "旧待办", type: "todo", date: "2026-09-01", note: "", createdAt: new Date().toISOString(),
    };
  });
  await assert.rejects(ud.updateEvent("legacy", { title: "改过的旧待办" }), /待办需要选择提醒时间/);
  const updated = await ud.updateEvent("legacy", {
    title: "改过的旧待办", reminderStart: "15:00", reminderEnd: "15:00",
  });
  assert.equal(updated.reminderStart, "15:00");
  assert.equal(updated.reminderEnd, "15:00");
});

test("数据层：MM-DD 输入默认每年重复", async () => {
  const ud = new UserData(tmpDir("u-mmdd"));
  const ev = await ud.addEvent({ title: "纪念日", type: "anniversary", date: "05-20" });
  assert.equal(ev.repeatYearly, true);
  assert.equal(ud.eventsOnDate(new Date(2032, 4, 20)).length, 1);
});

test("数据层：重复年份日期不互相污染", async () => {
  const d = tmpDir("u4");
  const ud = new UserData(d);
  await ud.addEvent({ title: "纪念日", type: "anniversary", date: "2026-05-20" });
  await ud.addEvent({ title: "每年520", type: "anniversary", date: "05-20", repeatYearly: true });
  // 2026-05-20：两个都命中
  assert.equal(ud.eventsOnDate(new Date(2026, 4, 20)).length, 2);
  // 2027-05-20：只有每年重复的命中
  const next = ud.eventsOnDate(new Date(2027, 4, 20));
  assert.equal(next.length, 1);
  assert.equal(next[0].title, "每年520");
});

test("待办到期判断：保留今天和逾期，排除未来及混用/非法日期", () => {
  const now = new Date(2026, 8, 2, 8, 0, 0);
  const todos = [
    { id: "today", type: "todo", title: "今天", date: "2026-09-02" },
    { id: "overdue", type: "todo", title: "逾期", date: "2026-09-01" },
    { id: "future", type: "todo", title: "未来", date: "2026-09-03" },
    { id: "legacy-today", type: "todo", title: "旧格式今天", date: "09-02" },
    { id: "legacy-overdue", type: "todo", title: "旧格式逾期", date: "09-01" },
    { id: "legacy-future", type: "todo", title: "旧格式未来", date: "09-03" },
    { id: "invalid", type: "todo", title: "非法日期", date: "2026-02-30" },
    { id: "bad-shape", type: "todo", title: "非规范日期", date: "2026-9-2" },
    { id: "done", type: "todo", title: "已完成", date: "2026-09-01", done: true },
    { id: "yearly", type: "todo", title: "每年待办", date: "2026-09-01", repeatYearly: true },
  ];

  assert.equal(normalizeDateKey("09-02", now), "2026-09-02");
  assert.equal(normalizeDateKey("2026-09-03", now), "2026-09-03");
  assert.equal(normalizeDateKey("2026-02-30", now), "");
  assert.equal(normalizeDateKey("2026-9-2", now), "");
  assert.deepEqual(filterDueTodos(todos, now).map((todo) => todo.id), [
    "today", "overdue", "legacy-today", "legacy-overdue",
  ]);
  assert.equal(isTodoOverdue(todos[1], now), true);
  assert.equal(isTodoOverdue(todos[0], now), false);
  assert.equal(isTodoOverdue(todos[5], now), false, "旧格式未来日期不能被当成逾期");
});

test("数据层：加密文件里没有明文事件", async () => {
  const d = tmpDir("u5");
  const ud = new UserData(d);
  await ud.addEvent({ title: "秘密纪念日", type: "anniversary", date: "08-08" });
  const raw = fs.readFileSync(path.join(d, "user-events.dat"), "utf-8");
  assert.ok(!raw.includes("秘密纪念日"), "用户数据文件不应有明文");
});

// ── 生理期开关（设置层） ──
test("设置：默认生理期开启且近期总结默认不共享", () => {
  const ud = new UserData(tmpDir("set1"));
  const s = ud.getSettings();
  assert.equal(s.showPeriod, true, "默认应开启生理期记录");
  assert.equal(s.summaryShared, false, "近期总结默认不应跨伙伴共享");
  assert.equal(s.summaryAgentIds, null, "默认应总结所有伙伴");
  assert.equal(s.injectionEnabled, true, "默认应开启情境注入");
  assert.equal(s.weatherEnabled, true, "默认应保留天气能力");
});

test("设置：情境和天气开关跨实例保存且不覆盖原有节奏", async () => {
  const d = tmpDir("set-context-switches");
  const ud = new UserData(d);
  await ud.updateSettings({
    injectionEnabled: false,
    weatherEnabled: false,
    injectMode: "always",
    injectIntervalHours: 0.5,
  });
  const reopened = new UserData(d).getSettings();
  assert.equal(reopened.injectionEnabled, false);
  assert.equal(reopened.weatherEnabled, false);
  assert.equal(reopened.injectMode, "always");
  assert.equal(reopened.injectIntervalHours, 0.5);
  await new UserData(d).updateSettings({ injectionEnabled: true, weatherEnabled: true });
  const restored = new UserData(d).getSettings();
  assert.equal(restored.injectionEnabled, true);
  assert.equal(restored.weatherEnabled, true);
  assert.equal(restored.injectMode, "always");
  assert.equal(restored.injectIntervalHours, 0.5);
});

test("设置：旧版已移除的2小时档读取时回退到默认4小时", async () => {
  const d = tmpDir("set-legacy-interval");
  const ud = new UserData(d);
  // 模拟升级前 settings.dat 里仍残留的旧 2 小时档。
  await ud.settings.update((value) => {
    value.injectIntervalHours = 2;
  });
  assert.equal(new UserData(d).getSettings().injectIntervalHours, 4);
  await new UserData(d).updateSettings({ summaryShared: true });
  assert.equal(new UserData(d).getSettings().injectIntervalHours, 4, "保存其他设置后也不能把旧档位带回来");
});

test("设置：天气重新开启时让旧缓存失效，下一次主页查询拿最新天气", async () => {
  const d = tmpDir("set-weather-reenable");
  const ud = new UserData(d);
  await ud.setWeatherCache({
    location: "四川省 成都市 武侯区",
    fetchedAt: Date.now(),
    result: { line: "旧天气", temp: 20, code: 0, isDay: true },
  });
  await ud.updateSettings({ weatherEnabled: false });
  await ud.updateSettings({ weatherEnabled: true });
  const cache = ud.getWeatherCache();
  assert.equal(cache.fetchedAt, 0, "天气重新开启后不应继续把旧缓存当作新鲜天气");
  assert.equal(cache.result.line, "旧天气", "失效只清时间，不破坏缓存回退内容");
});

test("设置：近期总结共享开关能跨实例持久化", async () => {
  const d = tmpDir("set-summary-shared");
  const ud = new UserData(d);
  await ud.updateSettings({ summaryShared: true });
  const ud2 = new UserData(d);
  assert.equal(ud2.getSettings().summaryShared, true);
  await ud2.updateSettings({ summaryShared: false });
  assert.equal(new UserData(d).getSettings().summaryShared, false);
});

test("设置：updateSettings 能保存生理期开关状态", async () => {
  const d = tmpDir("set2");
  const ud = new UserData(d);
  await ud.updateSettings({ showPeriod: false });
  assert.equal(ud.getSettings().showPeriod, false);
  // 重开一个实例读回（持久化验证）
  const ud2 = new UserData(d);
  assert.equal(ud2.getSettings().showPeriod, false);
  // 再开回来
  await ud2.updateSettings({ showPeriod: true });
  assert.equal(ud2.getSettings().showPeriod, true);
});

test("设置：关闭生理期不影响其他设置项", async () => {
  const ud = new UserData(tmpDir("set3"));
  await ud.updateSettings({ showPeriod: false, injectMode: "economical" });
  const s = ud.getSettings();
  assert.equal(s.showPeriod, false);
  assert.equal(s.injectMode, "economical");
  assert.equal(s.injectIntervalHours, 4, "未动的字段保持默认");
});

test("设置：天气区县和坐标跨实例持久化", async () => {
  const d = tmpDir("set-weather");
  const region = getAdministrativeRegion("510107");
  const ud = new UserData(d);
  await ud.updateSettings({ weatherLocation: formatAdministrativeRegion(region), weatherArea: region });
  const ud2 = new UserData(d);
  assert.equal(ud2.getSettings().weatherArea.code, "510107");
  assert.equal(ud2.getSettings().weatherArea.latitude, region.latitude);
  assert.equal(ud2.getSettings().weatherLocation, "四川省 成都市 武侯区");
});

// ── 旧数据迁移（手写「生理期第N天」→ 规范周期） ──
test("迁移：手写生理期第N天反推开始日", async () => {
  const d = tmpDir("mig1");
  const ud = new UserData(d);
  // 用户手写：标题=生理期第三天，日期=2026-08-29（当天）
  await ud.addEvent({ title: "生理期第三天", type: "event", date: "2026-08-29" });
  const r = await ud.migrateLegacyPeriods();
  assert.equal(r.migrated, 1);
  const evs = ud.listEvents();
  assert.equal(evs.length, 1);
  assert.equal(evs[0].type, "period");
  assert.equal(evs[0].title, "生理期");
  // 反推开始日 = 8-29 - 2 = 8-27
  assert.equal(evs[0].date, "2026-08-27");
  assert.equal(evs[0].note, "3");
  // 今天（8-29）应是第 3 天
  assert.equal(ud.periodDayOn(evs[0], new Date(2026, 7, 29)), 3);
});

test("迁移：幂等，跑两次不重复", async () => {
  const d = tmpDir("mig2");
  const ud = new UserData(d);
  await ud.addEvent({ title: "生理期第2天", type: "event", date: "2026-08-28" });
  const r1 = await ud.migrateLegacyPeriods();
  assert.equal(r1.migrated, 1);
  const r2 = await ud.migrateLegacyPeriods();
  assert.equal(r2.migrated, 0, "已规范的记录不再动");
  assert.equal(r2.uncertain, 0);
  const evs = ud.listEvents();
  assert.equal(evs.length, 1, "不新增记录");
  assert.equal(evs[0].type, "period");
  assert.equal(evs[0].date, "2026-08-27", "反推开始日");
});

test("迁移：type 已是 period 但标题手写的，归一并反推", async () => {
  const d = tmpDir("mig3");
  const ud = new UserData(d);
  // 模拟老数据：type=period 但 title 手写第N天、date 是当天
  await ud.addEvent({ title: "生理期第4天", type: "period", date: "2026-08-30", note: "4" });
  const r = await ud.migrateLegacyPeriods();
  assert.equal(r.migrated, 1);
  const ev = ud.listEvents()[0];
  assert.equal(ev.title, "生理期");
  assert.equal(ev.date, "2026-08-27", "8-30 第4天 → 开始日 8-27");
});

test("迁移：普通日子不含生理期不受影响", async () => {
  const d = tmpDir("mig4");
  const ud = new UserData(d);
  await ud.addEvent({ title: "妈妈生日", type: "anniversary", date: "09-12", repeatYearly: true });
  await ud.addEvent({ title: "交稿", type: "todo", date: "2026-08-30", reminderStart: "15:00", reminderEnd: "15:00" });
  const r = await ud.migrateLegacyPeriods();
  assert.equal(r.migrated, 0);
  assert.equal(ud.listEvents().length, 2, "不动其他类型");
});

// ── 生理期快捷记录 ──
test("生理期：markPeriod 全新开始", async () => {
  const d = tmpDir("p1");
  const ud = new UserData(d);
  const r = await ud.markPeriod(new Date(2026, 7, 27), 5);
  assert.equal(r.created, true);
  const evs = ud.listEvents();
  assert.equal(evs.length, 1);
  assert.equal(evs[0].type, "period");
  assert.equal(evs[0].title, "生理期");
  assert.equal(evs[0].date, "2026-08-27");
  assert.equal(evs[0].note, "5");
});

test("生理期：markPeriod 同开始日更新天数", async () => {
  const d = tmpDir("p2");
  const ud = new UserData(d);
  await ud.markPeriod(new Date(2026, 7, 27), 5);
  // 再点同一天：无变化（不重复建）
  const r = await ud.markPeriod(new Date(2026, 7, 27), 3);
  assert.equal(r.created, false);
  assert.equal(ud.listEvents()[0].note, "5", "已在周期内不改变");
});

test("生理期：markPeriod 逐天点选延伸", async () => {
  const d = tmpDir("p3");
  const ud = new UserData(d);
  await ud.markPeriod(new Date(2026, 7, 27), 1); // 只 27 号
  assert.equal(ud.listEvents()[0].note, "1");
  // 点 28 号（前一天在周期内）→ 延伸
  const r1 = await ud.markPeriod(new Date(2026, 7, 28));
  assert.equal(r1.created, false);
  assert.equal(r1.extended, true, "延伸返回 extended 标记");
  assert.equal(ud.listEvents()[0].note, "2", "延伸一天");
  // 点 26 号（后一天在周期内）→ 提前开始日
  const r2 = await ud.markPeriod(new Date(2026, 7, 26));
  assert.equal(r2.created, false);
  const p = ud.listEvents()[0];
  assert.equal(p.date, "2026-08-26", "开始日提前");
  assert.equal(p.note, "3", "26~28 共 3 天");
});

test("生理期：periodDayOn 第几天计算", async () => {
  const d = tmpDir("p4");
  const ud = new UserData(d);
  await ud.markPeriod(new Date(2026, 7, 27), 5);
  const p = ud.listEvents()[0];
  assert.equal(ud.periodDayOn(p, new Date(2026, 7, 27)), 1);
  assert.equal(ud.periodDayOn(p, new Date(2026, 7, 29)), 3);
  assert.equal(ud.periodDayOn(p, new Date(2026, 7, 31)), 5, "第5天（持续5天最后一天）");
  assert.equal(ud.periodDayOn(p, new Date(2026, 8, 1)), 0, "第6天结束");
  assert.equal(ud.periodDayOn(p, new Date(2026, 7, 26)), 0, "开始前不是");
});

test("生理期：periodDayOn 下午时刻不 round 错位", async () => {
  const d = tmpDir("p4b");
  const ud = new UserData(d);
  await ud.markPeriod(new Date(2026, 7, 27), 3); // 27,28,29
  const p = ud.listEvents()[0];
  // 8-29 下午 17 点，距开始日 2.7 天，不应 round 成第 4 天或第 0 天
  assert.equal(ud.periodDayOn(p, new Date(2026, 7, 29, 17, 3)), 3, "下午仍是第3天");
  assert.equal(ud.periodDayOn(p, new Date(2026, 7, 29, 23, 59)), 3, "深夜仍是第3天");
  assert.equal(ud.periodDayOn(p, new Date(2026, 7, 30, 0, 1)), 0, "第4天凌晨已结束");
});

test("生理期：unmarkPeriodDay 移除标记", async () => {
  const d = tmpDir("p5");
  const ud = new UserData(d);
  await ud.markPeriod(new Date(2026, 7, 27), 3); // 27,28,29
  // 移除末尾 29 → 剩 2 天
  let changed = await ud.unmarkPeriodDay(new Date(2026, 7, 29));
  assert.equal(changed, true);
  let p = ud.listEvents()[0];
  assert.equal(p.note, "2", "缩到 28");
  // 移除开始日 27 → 开始日变 28，剩 1 天
  changed = await ud.unmarkPeriodDay(new Date(2026, 7, 27));
  assert.equal(changed, true);
  p = ud.listEvents()[0];
  assert.equal(p.date, "2026-08-28");
  assert.equal(p.note, "1");
  // 只剩 28 → 移除 → 整条删
  changed = await ud.unmarkPeriodDay(new Date(2026, 7, 28));
  assert.equal(changed, true);
  assert.equal(ud.listEvents().length, 0, "整条删除");
});

test("生理期：periodsWithDayOn 带第几天", async () => {
  const d = tmpDir("p6");
  const ud = new UserData(d);
  await ud.markPeriod(new Date(2026, 7, 27), 3);
  const list = ud.periodsWithDayOn(new Date(2026, 7, 29));
  assert.equal(list.length, 1);
  assert.equal(list[0].day, 3);
});

// ── 待办完成状态 ──
test("待办：toggleTodo 切换完成状态", async () => {
  const d = tmpDir("t1");
  const ud = new UserData(d);
  await ud.addEvent({ title: "交稿", type: "todo", date: "2026-08-28", reminderStart: "15:00", reminderEnd: "15:00" });
  const todo = ud.listEvents().find((e) => e.type === "todo");
  assert.equal(todo.done, undefined, "新建默认未完成");
  const r1 = await ud.toggleTodo(todo.id);
  assert.equal(r1.done, true);
  const r2 = await ud.toggleTodo(todo.id);
  assert.equal(r2.done, false, "再点取消");
});

test("待办：toggleTodo 非待办返回 null", async () => {
  const d = tmpDir("t2");
  const ud = new UserData(d);
  await ud.addEvent({ title: "我的生日", type: "anniversary", date: "08-08" });
  const ev = ud.listEvents()[0];
  assert.equal(await ud.toggleTodo(ev.id), null);
});

// ── 生活日与档案 ──
test("生活日：凌晨 4 点前仍属于前一天", () => {
  assert.equal(lifeDayKey(new Date(2026, 7, 30, 2, 0), 4), "2026-08-29");
  assert.equal(lifeDayKey(new Date(2026, 7, 30, 5, 0), 4), "2026-08-30");
  assert.equal(finishedLifeDayKey(new Date(2026, 7, 30, 2, 0), 4), "2026-08-28");
  assert.equal(finishedLifeDayKey(new Date(2026, 7, 30, 5, 0), 4), "2026-08-29");
});

test("生活日：范围严格是边界到次日边界", () => {
  const range = lifeDayRange("2026-08-29", 4);
  assert.equal(range.start.getHours(), 4);
  assert.equal(dateKey(range.start), "2026-08-29");
  assert.equal(range.end.getHours(), 4);
  assert.equal(dateKey(range.end), "2026-08-30");
});

test("总结清洗：剥离隐藏块与拾光记注入", () => {
  assert.equal(sanitizeVisibleText("正文<mood>秘密</mood>尾巴"), "正文 尾巴");
  assert.equal(sanitizeVisibleText("<think>没闭合"), "");
  assert.equal(sanitizeVisibleText("【今日时光】2026年8月29日"), "");
  assert.equal(sanitizeVisibleText("【任务续接】当前有未完成任务"), "");
  assert.equal(sanitizeVisibleText("<StatusPlaceHolderImpl/>正文"), "正文");
  assert.equal(sanitizeVisibleText("正文<UpdateVariable><JSONPatch>[]</JSONPatch></UpdateVariable>尾巴"), "正文 尾巴");
  assert.equal(isSyntheticSummaryText("[来自 Agent「小花」的消息，非用户本人] 测试"), true);
  assert.equal(isSyntheticSummaryText("[SessionFile] {fileId: 'x'}"), true);
  assert.equal(isSyntheticSummaryText("用户发送‘小花’测试消息，验证其是否能显示在沈叙会话中。"), true);
});

test("总结采集：按生活日范围、过滤技术助手和隐藏注入", () => {
  const root = tmpDir("summary-collect");
  const agentsDir = path.join(root, "agents");
  const normalDir = path.join(agentsDir, "hanako", "sessions");
  const probeDir = path.join(agentsDir, "demo-probe-agent", "sessions");
  fs.mkdirSync(normalDir, { recursive: true });
  fs.mkdirSync(probeDir, { recursive: true });
  const rows = [
    { type: "message", timestamp: "2026-08-29T03:59:00+08:00", message: { role: "user", content: "前一天" } },
    { type: "message", timestamp: "2026-08-29T04:01:00+08:00", message: { role: "user", content: "今天开始" } },
    { type: "message", timestamp: "2026-08-30T01:00:00+08:00", message: { role: "assistant", content: [{ type: "text", text: "可见回复<mood>隐藏</mood>" }] } },
    { type: "message", timestamp: "2026-08-30T02:00:00+08:00", message: { role: "user", content: "【今日时光】注入" } },
    { type: "message", timestamp: "2026-08-30T03:00:00+08:00", message: { role: "user", content: "其他隐藏注入", display: false } },
    { type: "message", timestamp: "2026-08-30T04:00:00+08:00", message: { role: "user", content: "下一天" } },
  ];
  fs.writeFileSync(path.join(normalDir, "a.jsonl"), rows.map(JSON.stringify).join("\n"));
  fs.writeFileSync(path.join(probeDir, "p.jsonl"), JSON.stringify(rows[1]));
  const privateFile = "drift-private.jsonl";
  fs.writeFileSync(path.join(normalDir, privateFile), JSON.stringify({
    type: "message",
    timestamp: "2026-08-29T05:00:00+08:00",
    message: { role: "user", content: "漂流瓶后台提示，不应进入总结" },
  }));
  fs.writeFileSync(path.join(normalDir, "session-meta.json"), JSON.stringify({
    [privateFile]: { plugin: { ownerPluginId: "drift-bottle", visibility: "plugin_private" } },
  }));
  const result = collectDayMessages({ agentsDir, targetDate: "2026-08-29", boundaryHour: 4 });
  assert.deepEqual(result.messages.map((m) => m.text), ["今天开始", "可见回复"]);
  assert.equal(result.messages.some((m) => m.text.includes("漂流瓶后台提示")), false);
  const optedIn = collectDayMessages({
    agentsDir,
    targetDate: "2026-08-29",
    boundaryHour: 4,
    includePluginPrivate: true,
  });
  assert.equal(optedIn.messages.some((m) => m.text.includes("漂流瓶后台提示")), true);
  const grouped = groupMessagesByAgent(result.messages);
  assert.equal(grouped.hanako.length, 2);
  assert.equal(formatMessagesForPrompt(grouped.hanako, { agentName: "小花" }), "我：今天开始\n小花：可见回复");
  assert.equal(parseAgentDisplayName("agent:\n  name: 小花\nmodel:\n  name: 误读"), "小花");
});

test("总结采集：session-meta 损坏时整目录保守跳过（fail-closed），不误收插件私有会话", () => {
  const root = tmpDir("summary-meta-corrupt");
  const agentsDir = path.join(root, "agents");
  const normalDir = path.join(agentsDir, "hanako", "sessions");
  fs.mkdirSync(normalDir, { recursive: true });
  fs.writeFileSync(path.join(normalDir, "a.jsonl"), JSON.stringify({
    type: "message",
    timestamp: "2026-08-29T10:00:00",
    message: { role: "user", content: "看似普通对话，但 meta 坏了" },
  }));
  // meta 文件损坏（JSON 截断）：旧行为会整目录放行，这里应整目录跳过。
  fs.writeFileSync(path.join(normalDir, "session-meta.json"), "{ \"truncated\": ");
  const corrupt = collectDayMessages({ agentsDir, targetDate: "2026-08-29", boundaryHour: 4 });
  assert.equal(corrupt.messages.length, 0, "meta 损坏时不应采集任何会话: " + JSON.stringify(corrupt.messages));
  // 显式 includePluginPrivate 时仍可采集（把判断权交给调用方）。
  const optedIn = collectDayMessages({ agentsDir, targetDate: "2026-08-29", boundaryHour: 4, includePluginPrivate: true });
  assert.equal(optedIn.messages.length, 1, "includePluginPrivate 时应采集: " + JSON.stringify(optedIn.messages));
  // meta 文件缺失视为可信空登记（普通会话目录常态），照常采集。
  fs.rmSync(path.join(normalDir, "session-meta.json"));
  const missing = collectDayMessages({ agentsDir, targetDate: "2026-08-29", boundaryHour: 4 });
  assert.equal(missing.messages.length, 1, "meta 缺失（无登记）时应正常采集: " + JSON.stringify(missing.messages));
});

test("总结伙伴列表：忽略孤儿访客和 Hana 已删除助手", () => {
  const root = tmpDir("summary-agents");
  fs.mkdirSync(path.join(root, "hanako", "sessions"), { recursive: true });
  fs.mkdirSync(path.join(root, "xiaohua", "sessions"), { recursive: true });
  fs.writeFileSync(path.join(root, "xiaohua", "config.yaml"), "agent:\n  name: 小花2\n");
  fs.writeFileSync(path.join(root, "xiaohua", ".deleted-agent.json"), JSON.stringify({ agentId: "xiaohua", deletedAt: new Date().toISOString() }));
  fs.mkdirSync(path.join(root, "hanabrew-visitor-orphan", "sessions"), { recursive: true });
  fs.mkdirSync(path.join(root, "hanabrew-visitor-named", "sessions"), { recursive: true });
  fs.writeFileSync(path.join(root, "hanabrew-visitor-named", "config.yaml"), "agent:\n  name: 访客伙伴\n");
  assert.equal(isSummaryAgent(root, "hanako"), true);
  assert.equal(isSummaryAgent(root, "xiaohua"), false);
  assert.equal(isSummaryAgent(root, "hanabrew-visitor-orphan"), false);
  assert.equal(isSummaryAgent(root, "hanabrew-visitor-named"), true);
  assert.deepEqual(listSummaryAgents(root).map((agent) => agent.agentId), ["hanako"]);
});

test("总结分组：仅在花酿已安装且有来访身份时合并逻辑伙伴", (t) => {
  const hanaHome = tmpDir("hanabrew-summary");
  const root = path.join(hanaHome, "agents");
  const previousAppData = process.env.APPDATA;
  const appData = path.join(hanaHome, "appdata");
  process.env.APPDATA = appData;
  t.after(() => {
    if (previousAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = previousAppData;
  });
  const visitorA = path.join(root, "hanabrew-visitor-a");
  const visitorB = path.join(root, "hanabrew-visitor-b");
  fs.mkdirSync(visitorA, { recursive: true });
  fs.mkdirSync(visitorB, { recursive: true });
  const identity = "# 角色身份\n\n你是沈叙，这次从花酿酒馆临时来到 Hana。\n";
  fs.writeFileSync(path.join(visitorA, "AGENTS.md"), identity);
  fs.writeFileSync(path.join(visitorB, "AGENTS.md"), identity);
  assert.equal(parseHanabrewVisitorName(identity), "沈叙");
  assert.equal(isHanabrewInstalled(root), false);
  assert.equal(resolveSummaryPartner(root, "hanabrew-visitor-a").agentId, "hanabrew-visitor-a");
  assert.equal(groupSummaryMessages([
    { agentId: "hanabrew-visitor-a", role: "assistant", text: "甲" },
    { agentId: "hanabrew-visitor-b", role: "assistant", text: "乙" },
  ], { agentsDir: root }).length, 2);

  fs.mkdirSync(path.join(hanaHome, "plugins", "hanabrew"), { recursive: true });
  fs.writeFileSync(path.join(hanaHome, "plugins", "hanabrew", "manifest.json"), "{}");
  fs.mkdirSync(path.join(appData, "hanabrew"), { recursive: true });
  fs.writeFileSync(path.join(appData, "hanabrew", "state.json"), JSON.stringify({
    visitors: [{ agentId: "hanabrew-visitor-a", characterName: "沈叙", status: "active" }],
    pendingVisitorCleanup: ["hanabrew-visitor-b"],
    lastVisitorDeparture: { characterName: "沈叙" },
  }));
  assert.equal(isHanabrewInstalled(root), true);
  const repeatedOpening = "这是一段超过八十字的角色开场情境，用来验证多个临时来访身份合并后，相同的长开场不会在总结证据里重复堆叠，避免模型把同一件事误判成发生了很多次，也让最终档案更清楚。";
  const groups = groupSummaryMessages([
    { agentId: "hanabrew-visitor-a", role: "assistant", text: repeatedOpening },
    { agentId: "hanabrew-visitor-b", role: "assistant", text: repeatedOpening },
    { agentId: "hanabrew-visitor-b", role: "user", text: "[来自 Agent「小花」的消息，非用户本人] 测试消息" },
    { agentId: "hanako", role: "assistant", text: "普通伙伴仍按自身身份分组" },
  ], { agentsDir: root });
  const shenxu = groups.find((group) => group.agentName === "沈叙");
  assert.ok(shenxu);
  assert.equal(shenxu.messages.length, 1);
  assert.equal(groups.find((group) => group.agentId === "hanako").messages.length, 1);
  assert.equal(resolveSummaryAgentId(root, "hanabrew-visitor-a"), shenxu.agentId);
  assert.equal(listSummaryAgents(root).filter((agent) => agent.agentName === "沈叙").length, 1);
  fs.writeFileSync(path.join(appData, "hanabrew", "state.json"), JSON.stringify({
    visitors: [],
    pendingVisitorCleanup: ["hanabrew-visitor-a", "hanabrew-visitor-b"],
    lastVisitorDeparture: { characterName: "沈叙" },
  }));
  assert.equal(listSummaryAgents(root).some((agent) => agent.agentName === "沈叙"), false);

  fs.rmSync(visitorA, { recursive: true, force: true });
  fs.rmSync(visitorB, { recursive: true, force: true });
  const historical = groupHistoricalSummaryEntries([
    { agentId: "hanabrew-visitor-a", agentName: "hanabrew-visitor-a", text: "沈叙在晚上送来热可可。" },
    { agentId: "hanabrew-visitor-b", agentName: "沈叙", text: "沈叙提醒做完最后一页就回家。" },
  ], { agentsDir: root });
  assert.equal(historical.length, 1);
  assert.equal(historical[0].agentName, "沈叙");
  assert.equal(historical[0].messages.length, 2);
});

test("总结采集：按伙伴均衡取样不会丢掉较短对话", () => {
  const root = tmpDir("summary-balanced");
  const agentsDir = path.join(root, "agents");
  for (const [agentId, texts] of [["hanako", ["长对话1", "长对话2", "长对话3"]], ["partner-two", ["另一位对话"]]]) {
    const dir = path.join(agentsDir, agentId, "sessions");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "a.jsonl"), texts.map((text, index) => JSON.stringify({
      type: "message", timestamp: `2026-08-29T0${5 + index}:00:00`, message: { role: "user", content: text },
    })).join("\n"));
  }
  const result = collectDayMessages({ agentsDir, targetDate: "2026-08-29", boundaryHour: 4, maxMessages: 2, maxMessagesPerAgent: 1 });
  assert.equal(result.messages.length, 2);
  assert.deepEqual(result.messages.map((row) => row.agentId).sort(), ["hanako", "partner-two"]);
});

test("档案：可保存元数据、编辑和删除", async () => {
  const ud = new UserData(tmpDir("summary-store"));
  await ud.saveSummary("2026-08-28", "第一版", { source: "auto", messageCount: 3 });
  assert.equal(ud.getSummary("2026-08-28").messageCount, 3);
  await ud.saveSummary("2026-08-28", "改过的", { source: "edited" });
  assert.equal(ud.getSummary("2026-08-28").text, "改过的");
  await ud.removeSummary("2026-08-28");
  assert.equal(ud.getSummary("2026-08-28"), null);
});

test("档案：空总结与有内容档案区分（日历标记用）", async () => {
  const ud = new UserData(tmpDir("summary-empty"));
  // 空日（无对话可整理）存 empty 标记，不应视为“有档案”
  await ud.saveSummary("2026-08-27", "", { empty: true, source: "auto" });
  assert.equal(ud.getSummary("2026-08-27").empty, true);
  // 有内容档案
  await ud.saveSummary("2026-08-28", "和伙伴们聊了插件", { source: "auto" });
  assert.equal(ud.getSummary("2026-08-28").empty, undefined);
  // listSummaries 过滤空档案
  const list = ud.listSummaries();
  assert.equal(list.length, 1);
  assert.equal(list[0].date, "2026-08-28");
  assert.equal(list[0].text, "和伙伴们聊了插件");
});

test("生理期：预计日期与确认日期分开", async () => {
  const ud = new UserData(tmpDir("period-predicted"));
  await ud.markPeriod(new Date(2026, 7, 27), 3);
  assert.equal(ud.periodsWithDayOn(new Date(2026, 7, 28))[0].predicted, true);
  const confirmed = await ud.markPeriod(new Date(2026, 7, 28));
  assert.equal(confirmed.confirmed, true);
  assert.equal(ud.periodsWithDayOn(new Date(2026, 7, 28))[0].predicted, false);
  assert.equal(ud.periodsWithDayOn(new Date(2026, 7, 29))[0].predicted, true);
});
