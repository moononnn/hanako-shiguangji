// 拾光记 · 心情线伙伴图例（配色 + 收起开关）回归
// 目的：
//   ① 伙伴线的颜色只跟「是谁」有关，不跟「这屏有几位伙伴」有关，也不再和主线撞色；
//   ② 图例上每位伙伴都是一个开关，点一下把它的际遇线（曲线、圆点、下面的条目）收起来，再点展开；
//   ③ 收起状态在「一天 / 连续」两个视图之间保持，被收起的伙伴仍然留在图例里（否则没法再打开）。
// 做法：从渲染出的页面 HTML 里取出前端脚本，抽出真实函数在沙箱里执行，断言的是行为本身。
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

function extractVar(src, name) {
  const m = src.match(new RegExp("var " + name + " = [^\\n]*;"));
  if (!m) throw new Error("页面脚本里没找到变量 " + name + "（改名后请同步本测试）");
  return m[0];
}

const FN_NAMES = [
  "esc", "moodLineClamp", "moodLineHasSegment", "moodLineSegmentForHour", "moodLineExactTimestamp",
  "moodLineSegmentForEntry", "moodLineHasExactTime", "moodLineLifeMinute", "moodLineSegmentCenterMinute",
  "moodLineSegmentLabelForEntry", "moodLineEntryTimeLabel", "moodLineDateText", "moodLineSegmentRank",
  "moodLineSegmentLabel", "moodLineSort", "moodLinePrimary", "moodLineMetaFor", "moodLineY",
  "moodLineBuildGroups", "moodLinePointX", "moodLinePoint", "moodLinePairPath", "moodLineSmoothPath",
  "renderMoodLineSvg", "moodLinePartnerPointsHtml", "moodLinePartnerLabelsHtml", "partnerMoodPointTitle", "moodLineEntryTitle",
  "partnerMoodLineEntryTitle", "renderMoodLineEntries", "moodLineBuildDayPoints",
  "partnerMoodHash", "moodLinePartnerColorAssign", "moodLinePartnerColors",
  "moodLineSeriesHidden", "moodLineVisibleSeries", "moodLineLegendHtml", "toggleMoodLineSeries",
  "renderMoodLineDay", "renderMoodLineRange",
];

const VAR_NAMES = [
  "PARTNER_MOOD_COLORS", "MOOD_LINE_SEGMENTS", "MOOD_LINE_META",
  "MOOD_LINE_SEGMENT_X", "MOOD_LINE_SEGMENT_SLOT_SPAN", "WEEK",
];

/** 把页面里真实的心情线渲染链放进沙箱跑（只有一个 card 元素需要假装有）。 */
async function loadMoodLineLegend() {
  const { renderPage } = await import(pathToFileURL(path.resolve("lib/page-template.js")).href);
  const html = renderPage("test-token");
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const js = scripts.find((s) => s.includes("function toggleMoodLineSeries"));
  assert.ok(js, "页面脚本里应该有 toggleMoodLineSeries");

  const fnSrc = FN_NAMES.map((n) => extractFn(js, n)).join("\n\n");
  const varSrc = VAR_NAMES.map((n) => extractVar(js, n)).join("\n");

  const body = `
${varSrc}
var moodLineHiddenAgents = {};
var moodLinePartnerColorMap = {};
var moodLineLastRender = null;
var moodLineDays = 7;
var __cards = {};
var document = { getElementById: function (id) { return __cards[id] || (__cards[id] = { innerHTML: "" }); } };

${fnSrc}

return {
  hash: partnerMoodHash,
  colors: moodLinePartnerColors,
  legend: moodLineLegendHtml,
  visible: moodLineVisibleSeries,
  toggle: toggleMoodLineSeries,
  day: renderMoodLineDay,
  range: renderMoodLineRange,
  card: function () { return __cards["moodline-card"] ? __cards["moodline-card"].innerHTML : ""; },
  hiddenIds: function () { return Object.keys(moodLineHiddenAgents); },
};
`;
  return new Function(body)();
}

function countDots(html) {
  return (html.match(/class="moodline-point partner"/g) || []).length;
}
function countToggles(html) {
  return (html.match(/class="moodline-legend-item moodline-legend-toggle/g) || []).length;
}
function countOffToggles(html) {
  return (html.match(/moodline-legend-toggle off/g) || []).length;
}

function manualEntry(mood, hour, id) {
  return {
    id: "m" + (id || mood + hour),
    mood,
    source: "manual",
    label: mood + "的当下",
    emoji: "",
    recordedAt: "2026-09-10T" + String(hour).padStart(2, "0") + ":20:00+08:00",
  };
}
function partnerEntry(mood, hour, id) {
  return {
    id: "p" + (id || mood + hour),
    mood,
    source: "auto",
    label: mood + "的际遇",
    emoji: "",
    certainty: "clear",
    evidenceType: "explicit",
    evidence: "原话",
    recordedAt: "2026-09-10T" + String(hour).padStart(2, "0") + ":40:00+08:00",
  };
}

const TWO_PARTNERS = () => [
  { agentId: "hanako", agentName: "小花", entries: [partnerEntry("moved", 16)] },
  { agentId: "partner-b", agentName: "伙伴B", entries: [partnerEntry("calm", 10)] },
];

test("伙伴线配色：先到的先挑，后来的人不会把别人挤成另一个颜色", async () => {
  const ui = await loadMoodLineLegend();
  // 用户先打开的那一屏只有一位伙伴，之后才切到有多位伙伴的视图
  const first = ui.colors(["hanako"]);
  const later = ui.colors(["hanako", "partner-c", "partner-b", "partner-d", "partner-e"]);
  assert.equal(later.hanako, first.hanako, "后来加入的伙伴不该让小花换颜色（否则一天/连续两个视图会各说各话）");
  assert.equal(new Set(Object.values(later)).size, 5, "同一屏的伙伴不该有两条同色的线");
  assert.deepEqual(ui.colors(["hanako", "partner-c", "partner-b", "partner-d", "partner-e"]), later, "重复取颜色要保持一致");

  // 「一天」视图里单独出现的那位，颜色也得跟「连续」视图里一样
  assert.equal(ui.colors(["partner-b"])["partner-b"], later["partner-b"]);
});

test("伙伴线配色：不再跟主线撞色", async () => {
  const ui = await loadMoodLineLegend();
  const colors = ui.colors(["hanako", "partner-c", "partner-b", "partner-d", "partner-e", "partner-e2", "extra1"]);
  const mainLine = ["#7fb8a0", "#b9d6c8", "#dd9f6f", "#e89bb0"]; // 主线的薄荷绿/浅绿/暖橙/粉
  for (const [id, color] of Object.entries(colors)) {
    assert.ok(!mainLine.includes(color), id + " 的线色 " + color + " 跟主线撞了");
  }
});

test("伙伴线配色：伙伴比色板还多时也要给得出颜色，不卡死", async () => {
  const ui = await loadMoodLineLegend();
  // 色板 7 色，这里给 12 位：曾经这一路是个死循环（撞位往后找空位没有出口），浏览器会直接卡住。
  const ids = Array.from({ length: 12 }, (_, i) => "agent" + i);
  const colors = ui.colors(ids);
  for (const id of ids) {
    assert.ok(colors[id], id + " 该分到一个颜色");
  }
  assert.deepEqual(ui.colors(ids), colors, "同一组人重复分色要保持一致");
});

test("图例：每位伙伴都是一个可点的开关，收起后标出来但仍在图例里", async () => {
  const ui = await loadMoodLineLegend();
  const series = [
    { agentId: "hanako", name: "小花", color: "#5b84c4", points: [{ x: 10, y: 10, date: "2026-09-10", entry: {} }] },
    { agentId: "partner-b", name: "伙伴B", color: "#9b7abf", points: [{ x: 20, y: 20, date: "2026-09-10", entry: {} }] },
  ];

  let html = ui.legend(series);
  assert.equal(countToggles(html), 2, "两位伙伴该有两个开关");
  assert.equal(countOffToggles(html), 0);
  assert.match(html, /aria-pressed="true"/);
  assert.match(html, /onclick="toggleMoodLineSeries\(&quot;hanako&quot;\)"/);

  ui.toggle("hanako");
  html = ui.legend(series);
  assert.deepEqual(ui.hiddenIds(), ["hanako"]);
  assert.equal(countToggles(html), 2, "被收起的伙伴仍要在图例里，否则没法再打开");
  assert.equal(countOffToggles(html), 1, "收起的开关要标出关闭状态");
  assert.match(html, /aria-pressed="false"/);

  ui.toggle("hanako");
  assert.deepEqual(ui.hiddenIds(), [], "再点一下应该展开");
  assert.equal(countOffToggles(ui.legend(series)), 0);
});

test("收起一位伙伴：曲线、圆点和下面的际遇条目一起收起来（一天视图）", async () => {
  const ui = await loadMoodLineLegend();
  const moods = [manualEntry("happy", 15), manualEntry("tired", 9)];

  ui.day("2026-09-10", moods, TWO_PARTNERS());
  let html = ui.card();
  assert.equal(countDots(html), 2, "两位伙伴各有一个际遇点");
  assert.equal((html.match(/点名字可以收起某位伙伴/g) || []).length, 1, "底部该告诉用户可以点名字收起");

  ui.toggle("hanako");
  html = ui.card();
  assert.equal(countDots(html), 1, "收起后小花的点不该再画出来");
  assert.equal(countToggles(html), 2, "图例还在");
  assert.equal(countOffToggles(html), 1);
  assert.match(html, /小花的际遇/, "图例上仍要认得出是哪位伙伴");
  assert.match(html, /伙伴B的际遇/, "没收起的伙伴照常显示");

  ui.toggle("hanako");
  html = ui.card();
  assert.equal(countDots(html), 2, "再点一下应该回来");
});

test("收起状态跨视图保持：切到连续视图还是收着的（连续视图）", async () => {
  const ui = await loadMoodLineLegend();
  const dates = ["2026-09-09", "2026-09-10"];
  const dayMap = {
    "2026-09-09": [manualEntry("calm", 10)],
    "2026-09-10": [manualEntry("happy", 15)],
  };
  const partnerSeries = [
    { agentId: "hanako", agentName: "小花", dayMap: { "2026-09-09": [partnerEntry("moved", 16)], "2026-09-10": [partnerEntry("calm", 11)] } },
    { agentId: "partner-b", agentName: "伙伴B", dayMap: { "2026-09-10": [partnerEntry("tired", 20)] } },
  ];

  ui.toggle("hanako");
  ui.range(dates, dayMap, partnerSeries);
  const html = ui.card();
  assert.equal(ui.hiddenIds().join(","), "hanako");
  assert.equal(countDots(html), 1, "连续视图里只剩没收起的那位伙伴的点");
  assert.equal(countToggles(html), 2);
  assert.equal(countOffToggles(html), 1);
});

test("伙伴线末端标名字：不用点开关也能一眼认出谁是谁", async () => {
  const ui = await loadMoodLineLegend();
  ui.day("2026-09-10", [manualEntry("happy", 15)], TWO_PARTNERS());
  let html = ui.card();

  assert.equal((html.match(/moodline-partner-label/g) || []).length, 2, "两位伙伴各有一个末端名字");
  assert.match(html, />小花<\/text>/);
  assert.match(html, />伙伴B<\/text>/);

  const colors = ui.colors(["hanako", "partner-b"]);
  assert.ok(html.includes('fill="' + colors.hanako + '"'), "名字颜色该跟着这位伙伴的线色");
  assert.ok(html.includes('fill="' + colors["partner-b"] + '"'));

  ui.toggle("hanako");
  html = ui.card();
  assert.equal((html.match(/moodline-partner-label/g) || []).length, 1, "收起的伙伴名字也该一起收起来");
  assert.doesNotMatch(html, />小花<\/text>/);
});

test("伙伴线末端标名字：末端挨在一起时竖向错开，不叠成一块", async () => {
  const ui = await loadMoodLineLegend();
  // 两位伙伴同一天同一时段，末端点完全重合
  const partners = [
    { agentId: "hanako", agentName: "小花", entries: [partnerEntry("calm", 10)] },
    { agentId: "partner-b", agentName: "伙伴B", entries: [partnerEntry("calm", 10)] },
  ];
  ui.day("2026-09-10", [manualEntry("happy", 15)], partners);
  const ys = [...ui.card().matchAll(/moodline-partner-label" x="([\d.]+)" y="([\d.]+)"/g)].map((m) => Number(m[2]));
  assert.equal(ys.length, 2);
  assert.ok(Math.abs(ys[0] - ys[1]) >= 13, "两个名字该错开至少一行，实际：" + JSON.stringify(ys));
});

test("页面：心情线图例的开关入口已挂上", async () => {
  const { renderPage } = await import(pathToFileURL(path.resolve("lib/page-template.js")).href);
  const html = renderPage("test-token");
  assert.match(html, /function toggleMoodLineSeries/);
  assert.match(html, /function moodLineVisibleSeries/);
  assert.match(html, /class="moodline-legend-item moodline-legend-toggle/);
});
