// 拾光记 · 心情线「连续 N 天」窗口回归
// 目的：连续视图的右端永远锚在「今天」，点过日历某天、点过心情点、往后翻页都不能把它带偏，
//       也不允许把未来的日期铺进轴里（未来的日子没有记录，铺进去只会空出一段）。
// 做法：从渲染出的页面 HTML 里取出前端脚本，抽出真实函数在沙箱里执行，
//       断言的是行为本身，不是字符串长相。
process.env.TZ = "Asia/Shanghai";

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

function extractFn(src, name) {
  const idx = src.indexOf("function " + name + "(");
  if (idx < 0) throw new Error("页面脚本里没找到函数 " + name + "（改名后请同步本测试）");
  let depth = 0;
  let started = false;
  let i = idx;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") { depth++; started = true; }
    else if (ch === "}") { depth--; if (started && depth === 0) { i++; break; } }
  }
  return src.slice(idx, i);
}

function pad2(n) { return String(n).padStart(2, "0"); }
function shiftDate(date, delta) {
  const d = new Date(date + "T00:00:00");
  d.setDate(d.getDate() + delta);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 把页面里真实拼出来的心情线窗口逻辑放进沙箱跑。 */
async function loadMoodLineWindow() {
  const { renderPage } = await import(pathToFileURL(path.resolve("lib/page-template.js")).href);
  const html = renderPage("test-token");
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const js = scripts.find((s) => s.includes("function moodLineRangeDates"));
  assert.ok(js, "页面脚本里应该有 moodLineRangeDates");

  const names = [
    "pad", "dk", "todayMoodLineDate", "moodLineDateShift", "moodLineRangeDates", "moodLineRangeEndDate",
    "moodLineMonths", "loadMoodLine", "switchMoodLineMode", "switchMoodLineRange", "shiftMoodLine", "openMoodLine",
  ];
  const extracted = names.map((n) => extractFn(js, n)).join("\n\n");

  const body = `
var moodLineMode = "day";
var moodLineDays = 7;
var moodLineAnchorDate = null;
var moodLineRangeEnd = null;
var selectedDate = null;
var moodLineRequestSeq = 0;
var __els = {};
var __last = null;
var document = {
  getElementById: function (id) { return __els[id] || (__els[id] = { innerHTML: "", textContent: "" }); },
  querySelectorAll: function () { return []; },
};
function syncMoodLineToolbar() {}
function updateMoodLineToolbarLabel() {}
function switchTab() { loadMoodLine(); }
function api() { return Promise.resolve({ ok: true, days: {} }); }
function buildPartnerSeriesFromDay() { return []; }
function renderMoodLineRange(dates) { __last = { kind: "range", dates: dates.slice() }; }
function renderMoodLineDay(date) { __last = { kind: "day", dates: [date] }; }

${extracted}

return {
  today: todayMoodLineDate,
  mode: function () { return moodLineMode; },
  // 对应源码 selectDay() 开头的 selectedDate = date; moodLineAnchorDate = date;
  tapCalendarDay: function (date) { selectedDate = date; moodLineAnchorDate = date; },
  switchMoodLineMode: switchMoodLineMode,
  switchMoodLineRange: switchMoodLineRange,
  shiftMoodLine: shiftMoodLine,
  openMoodLine: openMoodLine,
  last: function () { return __last; },
};
`;
  const api = new Function(body)();
  const flush = () => new Promise((r) => setTimeout(r, 10));
  return { ...api, flush };
}

function futureCount(dates, today) {
  return dates.filter((d) => d > today).length;
}

test("心情线连续窗口：右端锚在今天，不越过今天", async () => {
  const ui = await loadMoodLineWindow();
  const today = ui.today();

  ui.switchMoodLineRange(30);
  await ui.flush();
  const base = ui.last();
  assert.equal(base.kind, "range");
  assert.equal(base.dates.length, 30);
  assert.equal(base.dates[29], today, "最长的一天应该是今天");
  assert.equal(base.dates[0], shiftDate(today, -29));
  assert.equal(futureCount(base.dates, today), 0);
});

test("心情线连续窗口：点过日历某天之后，再点连续 N 天仍从今天往前数", async () => {
  const ui = await loadMoodLineWindow();
  const today = ui.today();

  // 点过去的一天
  ui.tapCalendarDay(shiftDate(today, -21));
  ui.switchMoodLineRange(30);
  await ui.flush();
  let last = ui.last();
  assert.equal(last.dates[29], today, "点过过去的日子，也不该把窗口整体挪到过去");

  // 点未来的一天（日历整月渲染，未来格子本来就点得动）
  ui.tapCalendarDay(shiftDate(today, 15));
  ui.switchMoodLineRange(30);
  await ui.flush();
  last = ui.last();
  assert.equal(last.dates[29], today);
  assert.equal(futureCount(last.dates, today), 0, "未来的日期不该被铺进心情线");

  ui.switchMoodLineRange(30);
  await ui.flush();
  assert.equal(futureCount(ui.last().dates, today), 0);
});

test("心情线连续窗口：点过心情点跳单日，回连续不会把窗口带偏", async () => {
  const ui = await loadMoodLineWindow();
  const today = ui.today();

  ui.switchMoodLineRange(30);
  await ui.flush();
  ui.openMoodLine(shiftDate(today, -35));
  await ui.flush();
  assert.equal(ui.last().kind, "day");
  assert.equal(ui.last().dates[0], shiftDate(today, -35), "单日视图还是看用户点的那天");

  ui.switchMoodLineRange(30);
  await ui.flush();
  assert.equal(ui.last().dates[29], today, "连续视图该回到今天往前数");
  assert.equal(futureCount(ui.last().dates, today), 0);
});

test("心情线连续窗口：往后翻不会翻进未来，往前翻仍能回看更早", async () => {
  const ui = await loadMoodLineWindow();
  const today = ui.today();

  ui.switchMoodLineRange(30);
  await ui.flush();
  ui.shiftMoodLine(1);
  await ui.flush();
  ui.shiftMoodLine(1);
  await ui.flush();
  assert.equal(ui.last().dates[29], today, "已经在最近一段时，往后翻不该走进未来");
  assert.equal(futureCount(ui.last().dates, today), 0);

  ui.shiftMoodLine(-1);
  await ui.flush();
  ui.shiftMoodLine(-1);
  await ui.flush();
  const past = ui.last().dates;
  assert.equal(past[29], shiftDate(today, -60), "往前翻应该整段退回更早的 30 天");
  assert.equal(past[0], shiftDate(today, -89));
  assert.equal(futureCount(past, today), 0);
});

test("心情线单日视图：翻页仍按一天走", async () => {
  const ui = await loadMoodLineWindow();
  const today = ui.today();

  ui.openMoodLine(shiftDate(today, -10));
  await ui.flush();
  ui.shiftMoodLine(1);
  await ui.flush();
  assert.equal(ui.last().kind, "day");
  assert.equal(ui.last().dates[0], shiftDate(today, -9));

  ui.shiftMoodLine(-1);
  await ui.flush();
  assert.equal(ui.last().dates[0], shiftDate(today, -10));
});
