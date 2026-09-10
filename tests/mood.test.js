// 拾光记 · 「记一笔当下的心情」测试
// 覆盖：情绪集合归一、分段、合稿 JSON 解析、合并规则（手动永为锚、自动补空档）、
//       数据层 CRUD/加密持久化、月速览、路由 smoke。
process.env.TZ = "Asia/Shanghai";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { UserData, dateKey } from "../lib/data.js";
import {
  MOODS,
  buildSignalAwareEvidence,
  findExplicitMoodSignals,
  normalizeMoodCertainty,
  normalizeMoodEvidenceType,
  normalizeMoodId,
  normalizeMoodSegment,
  parseMoodReviewOutput,
  segmentOfHour,
  segmentLabel,
  segmentOfTimestamp,
  makeManualMood,
  makeAutoMood,
  parseMoodOutput,
  mergeMoodEntries,
  moodEntryText,
  formatMoodTimeline,
  pickDayMood,
} from "../lib/mood.js";
import {
  MOOD_LINE_META,
  MOOD_LINE_SEGMENTS,
  moodLineMeta,
  moodLineLevel,
  moodLineSegmentForHour,
  moodLineSegmentForEntry,
  moodLineSegmentLabelForEntry,
  moodLineHasExactTime,
  moodLineLifeMinute,
  moodLineSegmentCenterMinute,
  buildMoodLineDay,
  buildMoodLineRange,
} from "../lib/mood-line.js";

function tmpDir(name) {
  return path.join(os.tmpdir(), `sgj-mood-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

test("情绪集合：13 个词、id 唯一、emoji 唯一", () => {
  assert.equal(MOODS.length, 13);
  assert.equal(new Set(MOODS.map((m) => m.id)).size, MOODS.length);
  assert.equal(new Set(MOODS.map((m) => m.emoji)).size, MOODS.length);
  assert.equal(new Set(MOODS.map((m) => m.label)).size, MOODS.length);
  for (const label of ["开心", "平静", "兴奋", "委屈", "难过", "生气", "烦躁", "焦虑", "累", "感动", "无聊", "幸福", "想念"]) {
    assert.ok(MOODS.some((m) => m.label === label), `缺少情绪词：${label}`);
  }
});

test("情绪词归一：中文标签 / emoji / id / 包裹符都能落到集合内", () => {
  assert.equal(normalizeMoodId("生气"), "angry");
  assert.equal(normalizeMoodId("😠"), "angry");
  assert.equal(normalizeMoodId("angry"), "angry");
  assert.equal(normalizeMoodId("「开心」"), "happy");
  assert.equal(normalizeMoodId("不开心"), ""); // 不在集合内不硬造
  assert.equal(normalizeMoodId(""), "");
  assert.equal(normalizeMoodId("爽死了"), "");
});

test("自动发现本地预筛：只看用户消息，不让伙伴回复单独触发", () => {
  const signals = findExplicitMoodSignals([
    { role: "assistant", ts: 1, text: "我今天很开心" },
    { role: "user", ts: 2, text: "伙伴说得很好，我有点焦虑，脑壳也累" },
    { role: "user", ts: 3, text: "今天把文件放好了" },
  ]);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].ts, 2);
  assert.match(signals[0].text, /焦虑/);
});

test("自动发现字段归一：宽时段、无数字置信度", () => {
  assert.equal(normalizeMoodSegment("下午"), "afternoon");
  assert.equal(normalizeMoodSegment("白天"), "day");
  assert.equal(normalizeMoodCertainty("可能"), "possible");
  assert.equal(normalizeMoodCertainty(0.92), "uncertain");
  assert.equal(normalizeMoodEvidenceType("原话"), "explicit");
  assert.equal(normalizeMoodEvidenceType("上下文"), "context");
});

test("时段：按小时归上午/下午/晚上", () => {
  assert.equal(segmentOfHour(3), "morning");
  assert.equal(segmentOfHour(9), "morning");
  assert.equal(segmentOfHour(11), "morning");
  assert.equal(segmentOfHour(12), "afternoon");
  assert.equal(segmentOfHour(17), "afternoon");
  assert.equal(segmentOfHour(18), "evening");
  assert.equal(segmentOfHour(23), "evening");
  assert.equal(segmentLabel("morning"), "上午");
  assert.equal(segmentLabel("evening"), "晚上");
  assert.equal(segmentOfTimestamp("2026-09-05T15:30:00+08:00"), "afternoon");
});

test("makeManualMood：自动带当前时段、reason 可空、有稳定 id", () => {
  const at = new Date(2026, 8, 5, 14, 30); // 下午
  const entry = makeManualMood({ mood: "生气", reason: " ", now: at });
  assert.equal(entry.mood, "angry");
  assert.equal(entry.label, "生气");
  assert.equal(entry.segment, "afternoon");
  assert.equal(entry.reason, "");
  assert.equal(entry.source, "manual");
  assert.match(entry.id, /^mood-/);
  assert.equal(entry.recordedAt, at.toISOString());
});

test("makeManualMood：不在集合内的词直接拒绝", () => {
  assert.throws(() => makeManualMood({ mood: "炸毛", now: new Date() }), /不在可选/);
});

test("makeAutoMood：模型给的词认出来就建、认不出返回 null", () => {
  const auto = makeAutoMood({ mood: "难过", segment: "evening", note: "可能是想到什么事了", now: new Date() });
  assert.ok(auto);
  assert.equal(auto.source, "auto");
  assert.equal(auto.mood, "sad");
  assert.equal(auto.note, "可能是想到什么事了");
  assert.equal(makeAutoMood({ mood: "无语子", segment: "morning" }), null);
});

test("parseMoodOutput：普通数组 / json 围栏 / 带废话都能解析", () => {
  const plain = parseMoodOutput('[{"mood":"生气","segment":"afternoon","why":"可能是插件反复出 bug？"}]');
  assert.equal(plain.length, 1);
  assert.equal(plain[0].mood, "angry");
  assert.equal(plain[0].segment, "afternoon");
  assert.equal(plain[0].source, "auto");
  assert.match(plain[0].note, /可能是/);

  const fenced = parseMoodOutput('```json\n[{"mood":"开心","segment":"morning"}]\n```');
  assert.equal(fenced.length, 1);
  assert.equal(fenced[0].mood, "happy");

  const messy = parseMoodOutput('这是当天的情绪：\n[{ "mood": "累", "segment": "晚上", "why": "" }, {"mood":"不在集合","segment":"下午"}]');
  assert.equal(messy.length, 1);
  assert.equal(messy[0].mood, "tired");
  assert.equal(messy[0].note, "");

  assert.deepEqual(parseMoodOutput(""), []);
  assert.deepEqual(parseMoodOutput("模型没说人话"), []);
  assert.deepEqual(parseMoodOutput('[{"mood":"随便","segment":"x"}]'), []);
});

test("parseMoodOutput：只接受真实消息分钟，并保留证据与不确定性", () => {
  const at = new Date("2026-09-05T16:14:00+08:00");
  const source = "[2026-09-05 16:14] 我：我有点焦虑，脑壳有点累";
  const parsed = parseMoodOutput(JSON.stringify([
    { mood: "焦虑", segment: "下午", observedAt: "2026-09-05 16:14", certainty: "possible", evidenceType: "explicit", evidence: "我有点焦虑", why: "可能在担心事情" },
    { mood: "累", segment: "下午", observedAt: "2026-09-05 16:15", certainty: "clear", evidenceType: "explicit", evidence: "脑壳有点累" },
    { mood: "开心", segment: "下午", observedAt: "2026-09-05 16:14", certainty: "clear", evidenceType: "explicit", evidence: "伙伴很开心" },
  ]), {
    day: "2026-09-05",
    allowedObservedAt: [at.getTime()],
    evidenceSourceText: source,
  });
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0].mood, "anxious");
  assert.equal(parsed[0].timePrecision, "turn");
  assert.equal(parsed[0].observedAt, at.toISOString());
  assert.equal(parsed[0].certainty, "possible");
  assert.equal(parsed[0].evidenceType, "explicit");
  assert.equal(parsed[0].evidence, "我有点焦虑");
  assert.equal(parsed[1].timePrecision, "segment", "对不上的模型时刻不能伪装成精确时间");
  assert.equal(parsed[1].observedAt, "");
  assert.equal(parsed[2].evidence, "", "不在原对话里的证据要丢掉");
});

test("parseMoodReviewOutput：只接受候选编号的明确裁决", () => {
  const decisions = parseMoodReviewOutput('```json\n[{"index":0,"decision":"keep"},{"index":2,"keep":false},{"index":9,"decision":"keep"}]\n```', { allowedIndexes: [0, 2] });
  assert.deepEqual(decisions.map((item) => [item.index, item.keep]), [[0, true], [2, false]]);
  assert.deepEqual(parseMoodReviewOutput("模型没给裁决"), []);
});

test("mergeMoodEntries：手动永远保留，自动补空档、同段同情绪挂旁白", () => {
  const manual = [
    { id: "m1", mood: "angry", label: "生气", emoji: "😠", source: "manual", segment: "afternoon", reason: "就是烦", recordedAt: "2026-09-04T14:00:00" },
  ];
  const auto = [
    { id: "a1", mood: "happy", label: "开心", emoji: "😊", source: "auto", segment: "morning", note: "早上出门心情不错" },
    { id: "a2", mood: "tired", label: "累", emoji: "🥱", source: "auto", segment: "evening", note: "晚上可能累了" },
    { id: "a3", mood: "angry", label: "生气", emoji: "😠", source: "auto", segment: "afternoon", note: "可能是插件反复出 bug？" }, // 同段同情绪：不新增，旁白挂到手动
    { id: "a4", mood: "sad", label: "难过", emoji: "😢", source: "auto", segment: "afternoon", note: "乱猜的难过" }, // 同段不同情绪：丢弃
  ];
  const merged = mergeMoodEntries(manual, auto);
  assert.equal(merged.length, 3); // manual 1 + 空档 2（同段不新增）
  assert.ok(!merged.some((e) => e.id === "a3"), "同段自动不新增");
  assert.ok(!merged.some((e) => e.id === "a4"), "同段不同情绪不臆造");
  const afternoon = merged.find((e) => e.segment === "afternoon");
  assert.equal(afternoon.id, "m1");
  assert.equal(afternoon.reason, "就是烦"); // 亲笔不动
  assert.equal(afternoon.mood, "angry");
  assert.equal(afternoon.note, "可能是插件反复出 bug？"); // 旁白挂在 note，不算原文
  // 同段不同情绪但手动还没有旁白：自动的不同情绪不覆盖
  const merged2 = mergeMoodEntries([{ id: "m1", mood: "angry", source: "manual", segment: "afternoon" }], [{ id: "a5", mood: "sad", source: "auto", segment: "afternoon", note: "x" }]);
  assert.equal(merged2.length, 1);
  assert.equal(merged2[0].mood, "angry");
  assert.equal(merged2[0].note, "");
});

test("mergeMoodEntries：手动已有旁白时同段自动不再覆盖", () => {
  const manual = [{ id: "m1", mood: "angry", label: "生气", source: "manual", segment: "afternoon", reason: "", note: "上次补过的旁白", recordedAt: "" }];
  const auto = [{ id: "a1", mood: "angry", label: "生气", source: "auto", segment: "afternoon", note: "新推测" }];
  const merged = mergeMoodEntries(manual, auto);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].note, "上次补过的旁白", "已有旁白不被覆盖");
});

test("mergeMoodEntries：真实消息时刻允许同段独立候选，同一分钟仍手动优先", () => {
  const manual = [{ id: "m1", mood: "calm", label: "平静", source: "manual", segment: "afternoon", recordedAt: "2026-09-05T06:46:00.000Z", reason: "我亲手记的" }];
  const auto = [
    { id: "a1", mood: "焦虑", source: "auto", segment: "afternoon", observedAt: "2026-09-05T08:14:00.000Z", timePrecision: "turn", certainty: "possible", note: "可能在担心" },
    { id: "a2", mood: "生气", source: "auto", segment: "afternoon", observedAt: "2026-09-05T06:46:00.000Z", timePrecision: "turn", certainty: "clear", note: "与手动同一分钟" },
    { id: "a3", mood: "累", source: "auto", segment: "afternoon", note: "没有真实时刻" },
  ];
  const merged = mergeMoodEntries(manual, auto);
  assert.deepEqual(merged.map((entry) => entry.id), ["m1", "a1"]);
  assert.equal(merged.find((entry) => entry.id === "m1").mood, "calm");
});

test("mergeMoodEntries：无自动时原样返回手动、无手动时返回空", () => {
  const manual = [{ id: "m1", mood: "happy", source: "manual", segment: "morning", recordedAt: "" }];
  const merged = mergeMoodEntries(manual, []);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, "m1");
  assert.deepEqual(mergeMoodEntries([], []), []);
});

test("mergeMoodEntries：宽松模式同段不同情绪共存，严格模式仍只留一笔", () => {
  const auto = [
    { id: "a1", mood: "annoyed", label: "烦躁", emoji: "😤", source: "auto", segment: "afternoon", observedAt: "", timePrecision: "segment", certainty: "possible", evidenceType: "explicit", evidence: "又崩溃了", note: "", recordedAt: "2026-09-06T08:00:00.000Z" },
    { id: "a2", mood: "happy", label: "开心", emoji: "😊", source: "auto", segment: "afternoon", observedAt: "", timePrecision: "segment", certainty: "clear", evidenceType: "explicit", evidence: "我发现了", note: "", recordedAt: "2026-09-06T08:00:00.000Z" },
  ];
  // 严格模式（当天自动）：同段宽候选只留一笔
  const strict = mergeMoodEntries([], auto, { lenient: false });
  assert.equal(strict.length, 1, "严格模式同段只留一笔");
  // 宽松模式（历史补档）：同段不同情绪共存
  const lenient = mergeMoodEntries([], auto, { lenient: true });
  assert.equal(lenient.length, 2, "宽松模式同段不同情绪应共存");
  assert.deepEqual(lenient.map((entry) => entry.mood).sort(), ["annoyed", "happy"]);
});

test("mergeMoodEntries：宽松模式同段同情绪仍只留一笔", () => {
  const auto = [
    { id: "a1", mood: "happy", source: "auto", segment: "afternoon", observedAt: "", timePrecision: "segment", note: "第一次开心" },
    { id: "a2", mood: "happy", source: "auto", segment: "afternoon", observedAt: "", timePrecision: "segment", note: "第二次开心" },
  ];
  const merged = mergeMoodEntries([], auto, { lenient: true });
  assert.equal(merged.length, 1, "宽松也不能让同情绪刷屏");
});

test("mergeMoodEntries：宽松模式仍不覆盖手动亲笔、不往有手动时段硬塞", () => {
  const manual = [{ id: "m1", mood: "calm", label: "平静", source: "manual", segment: "afternoon", recordedAt: "2026-09-05T06:00:00.000Z", reason: "我亲手记的" }];
  const auto = [
    { id: "a1", mood: "annoyed", label: "烦躁", source: "auto", segment: "afternoon", observedAt: "", timePrecision: "segment", note: "想插进手动时段" },
    { id: "a2", mood: "calm", label: "平静", source: "auto", segment: "afternoon", observedAt: "", timePrecision: "segment", note: "同段同情绪旁白" },
  ];
  const merged = mergeMoodEntries(manual, auto, { lenient: true });
  // 手动时段同段已有记录：烦躁不新增、平静只挂旁白，手动仍是唯一锚点
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, "m1");
  assert.equal(merged[0].mood, "calm");
});

test("展示辅助：时间线文案带旁白、日历角标手动优先", () => {
  const entries = [
    { id: "a", mood: "happy", label: "开心", emoji: "😊", source: "auto", segment: "morning", note: "", reason: "" },
    { id: "m", mood: "angry", label: "生气", emoji: "😠", source: "manual", segment: "afternoon", reason: "", note: "可能是插件反复出 bug？" },
  ];
  const text = formatMoodTimeline(entries);
  assert.match(text, /上午 😊 开心/);
  assert.match(text, /下午 😠 生气/);
  assert.match(text, /可能是插件反复出 bug/);
  assert.match(text, /→/);
  const picked = pickDayMood([entries[0], entries[1]]);
  assert.equal(picked.id, "m"); // 手动优先
  assert.equal(moodEntryText({ segment: "evening", emoji: "🥱", label: "累", note: "今天确实累" }), "晚上 🥱 累（今天确实累）");
});

test("心情线视觉映射：13 个情绪都有稳定层级，不输出数值分数", () => {
  assert.equal(Object.keys(MOOD_LINE_META).length, MOODS.length);
  for (const mood of MOODS) {
    const meta = moodLineMeta(mood.id);
    assert.ok(["light", "steady", "heavy"].includes(meta.band));
    assert.ok(Number.isInteger(meta.level) && meta.level >= 0 && meta.level <= 8);
    assert.equal(moodLineLevel(mood.label), meta.level);
  }
  assert.equal(moodLineMeta("生气").band, "heavy");
  assert.equal(moodLineMeta("幸福").band, "light");
  // 2026-09-06 纵轴改版（版本2·情绪直白刻度）：
  // 很低落0→想哭1→委屈巴巴2→有点烦3→心里悬4→乏了5→安安稳稳6→挺高兴7→幸福满满8
  assert.equal(moodLineMeta("平静").level, 6);
  assert.equal(moodLineMeta("难过").level, 1);
  assert.equal(moodLineMeta("委屈").level, 2);
  assert.equal(moodLineMeta("烦躁").level, 3);
  assert.equal(moodLineMeta("焦虑").level, 4);
  assert.equal(moodLineMeta("累").level, 5);
  assert.equal(moodLineMeta("无聊").level, 6, "无聊归安安稳稳");
  assert.equal(moodLineMeta("想念").level, 6, "想念归安安稳稳");
  assert.equal(moodLineMeta("开心").level, 7);
  assert.equal(moodLineMeta("兴奋").level, 7);
  assert.equal(moodLineMeta("幸福").level, 8);
  assert.equal(MOOD_LINE_SEGMENTS.map((item) => item.id).join(","), "dawn,morning,noon,afternoon,dusk,evening,night");
});

test("心情线细分：精确记录按七个生活时段，自动发现不伪造时刻", () => {
  assert.equal(moodLineSegmentForHour(4), "dawn");
  assert.equal(moodLineSegmentForHour(7), "dawn");
  assert.equal(moodLineSegmentForHour(8), "morning");
  assert.equal(moodLineSegmentForHour(12), "noon");
  assert.equal(moodLineSegmentForHour(14), "afternoon");
  assert.equal(moodLineSegmentForHour(18), "dusk");
  assert.equal(moodLineSegmentForHour(20), "evening");
  assert.equal(moodLineSegmentForHour(23), "evening");
  assert.equal(moodLineSegmentForHour(2), "night");
  assert.equal(moodLineSegmentForEntry({ source: "manual", recordedAt: "2026-09-05T07:30:00+08:00", segment: "morning" }), "dawn");
  assert.equal(moodLineSegmentForEntry({ source: "auto", recordedAt: "2026-09-05T23:00:00+08:00", segment: "morning" }), "morning");
  assert.equal(moodLineSegmentForEntry({ source: "auto", segment: "day" }), "noon");
  assert.equal(moodLineSegmentLabelForEntry({ source: "auto", segment: "day" }), "白天");
  assert.equal(moodLineSegmentLabelForEntry({ source: "manual", recordedAt: "2026-09-05T07:30:00+08:00", segment: "morning" }), "清晨");
  assert.equal(moodLineHasExactTime({ source: "manual", recordedAt: "2026-09-05T16:14:00+08:00" }), true);
  assert.equal(moodLineHasExactTime({ source: "auto", recordedAt: "2026-09-05T16:14:00+08:00" }), false);
  assert.equal(moodLineHasExactTime({ source: "auto", observedAt: "2026-09-05T16:14:00+08:00", timePrecision: "turn" }), true);
  assert.equal(moodLineSegmentForEntry({ source: "auto", segment: "afternoon", observedAt: "2026-09-05T16:14:00+08:00", timePrecision: "turn" }), "afternoon");
  assert.equal(moodLineSegmentLabelForEntry({ source: "auto", segment: "day", observedAt: "2026-09-05T16:14:00+08:00", timePrecision: "turn" }), "下午");
  assert.equal(moodLineLifeMinute({ source: "manual", recordedAt: "2026-09-05T16:14:00+08:00" }), 734);
  assert.equal(moodLineSegmentCenterMinute("afternoon"), 720);
});

test("心情线日模型：精确手动按时刻展开，模糊自动按时段聚合", () => {
  const model = buildMoodLineDay([
    { id: "a2", mood: "兴奋", source: "auto", segment: "evening", recordedAt: "2026-09-05T23:00:00" },
    { id: "m1", mood: "生气", source: "manual", segment: "afternoon", recordedAt: "2026-09-05T14:00:00" },
    { id: "m2", mood: "平静", source: "manual", segment: "afternoon", recordedAt: "2026-09-05T15:00:00" },
    { id: "a1", mood: "开心", source: "auto", segment: "morning", recordedAt: "2026-09-05T09:00:00" },
  ]);
  assert.deepEqual(model.groups.map((group) => group.primary.id), ["a1", "m1", "m2", "a2"]);
  assert.equal(model.groups[1].segmentId, "afternoon");
  assert.equal(model.groups[1].entries.length, 1);
  assert.equal(model.groups[1].primary.id, "m1");
  assert.equal(model.groups[2].primary.id, "m2");
  assert.equal(model.primary.id, "m1");
  const autoOnly = buildMoodLineDay([
    { id: "morning", mood: "开心", source: "auto", segment: "morning", recordedAt: "2026-09-05T09:00:00" },
    { id: "evening", mood: "兴奋", source: "auto", segment: "evening", recordedAt: "2026-09-05T20:00:00" },
  ]);
  assert.equal(autoOnly.primary.id, "evening", "没有手动锚点时取当天较晚的自动记录");
});

test("心情线连续日期：补齐空白日，代表点手动优先", () => {
  const range = buildMoodLineRange({
    "2026-09-03": [{ id: "a", mood: "开心", source: "auto", segment: "evening", recordedAt: "2026-09-03T20:00:00" }],
    "2026-09-05": [
      { id: "auto", mood: "难过", source: "auto", segment: "evening", recordedAt: "2026-09-05T20:00:00" },
      { id: "manual", mood: "平静", source: "manual", segment: "afternoon", recordedAt: "2026-09-05T15:00:00" },
    ],
  }, ["2026-09-03", "2026-09-04", "2026-09-05"]);
  assert.equal(range.length, 3);
  assert.equal(range[1].entries.length, 0);
  assert.equal(range[0].primary.id, "a");
  assert.equal(range[2].primary.id, "manual");
});

test("数据层：增删改查与加密持久化", async () => {
  const dir = tmpDir("crud");
  const data = new UserData(dir);
  const day = "2026-09-04";
  assert.equal(data.hasMood(day), false);
  const at = new Date(2026, 8, 4, 9, 0);
  const entry = makeManualMood({ mood: "开心", reason: "逛街", now: at });
  const list = await data.addMood(day, entry);
  assert.equal(list.length, 1);
  assert.equal(data.hasMood(day), true);
  assert.equal(data.listManualMoods(day).length, 1);
  // 加密持久化：重开实例仍在
  const restored = new UserData(dir);
  assert.equal(restored.getDayMoods(day).length, 1);
  assert.equal(restored.getDayMoods(day)[0].reason, "逛街");
  // 编辑 reason
  const updated = await restored.updateMood(day, entry.id, { reason: "和慧慧逛街" });
  assert.equal(updated.reason, "和慧慧逛街");
  // 合稿落库：replaceDayMoods 手动保留（先手动后自动）
  const auto = makeAutoMood({ mood: "兴奋", segment: "evening", note: "可能因为买了新东西", now: new Date() });
  await restored.replaceDayMoods(day, mergeMoodEntries(restored.listManualMoods(day), [auto]));
  assert.equal(restored.getDayMoods(day).length, 2);
  // 删除手动：只删那一条
  await restored.removeMood(day, entry.id);
  assert.equal(restored.getDayMoods(day).length, 1);
  assert.equal(restored.getDayMoods(day)[0].source, "auto");
  // 删空后整日消失
  await restored.removeMood(day, restored.getDayMoods(day)[0].id);
  assert.equal(restored.hasMood(day), false);
});

test("数据层：listMoods 按日期与时间排序、支持按月速览", async () => {
  const dir = tmpDir("list");
  const data = new UserData(dir);
  await data.addMood("2026-09-04", makeManualMood({ mood: "难过", now: new Date(2026, 8, 4, 20, 0) }));
  await data.addMood("2026-09-05", makeManualMood({ mood: "平静", now: new Date(2026, 8, 5, 8, 0) }));
  const all = data.listMoods();
  assert.equal(all.length, 2);
  assert.equal(all[0].date, "2026-09-04");
  assert.equal(all[1].date, "2026-09-05");
  const sep = data.listMoods("2026-09-04");
  assert.equal(sep.length, 1);
});

test("路由：情绪集合 / 当天记录 / 删除 / 月速览 smoke", () => {
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "sgj-mood-route-"));
  const routeUrl = pathToFileURL(path.resolve("routes/ui.js")).href;
  const dataUrl = pathToFileURL(path.resolve("lib/data.js")).href;
  const sharedUrl = pathToFileURL(path.resolve("lib/shared-data.js")).href;
  const childCode = `
    import path from "node:path";
    import { UserData, dateKey } from ${JSON.stringify(dataUrl)};
    import { __setSharedUserDataForTest } from ${JSON.stringify(sharedUrl)};
    import registerRoutes from ${JSON.stringify(routeUrl)};
    const data = new UserData(path.join(process.env.HANA_HOME, "plugin-data", "shiguangji"));
    __setSharedUserDataForTest(data);
    const routes = [];
    const app = {
      get(route, handler) { routes.push({ method: "GET", route, handler }); },
      post(route, handler) { routes.push({ method: "POST", route, handler }); },
      put(route, handler) { routes.push({ method: "PUT", route, handler }); },
      delete(route, handler) { routes.push({ method: "DELETE", route, handler }); },
    };
    registerRoutes(app, { log: { info() {}, warn() {}, error() {} } });
    const now = new Date();
    const today = dateKey(now);
    const metaRoute = routes.find((item) => item.method === "GET" && item.route === "/api/moods/meta");
    if (!metaRoute) throw new Error("情绪集合路由未注册");
    const meta = await metaRoute.handler({ json(value) { return value; } });
    if (!meta?.ok || meta.moods.length !== 13) throw new Error("情绪集合不正确");
    const postRoute = routes.find((item) => item.method === "POST" && item.route === "/api/moods");
    const post = await postRoute.handler({ req: { json: async () => ({ mood: "开心", reason: "随手一记" }) }, json(value) { return value; } });
    if (!post?.ok || !post.date || post.moods.length !== 1) throw new Error("手动记录失败：" + JSON.stringify(post));
    if (post.moods[0].segmentLabel !== "上午" && post.moods[0].segmentLabel !== "下午" && post.moods[0].segmentLabel !== "晚上") {
      throw new Error("没有自动落时段：" + JSON.stringify(post.moods[0]));
    }
    if (!post.moods[0].lineSegment) throw new Error("没有生成心情线细分时段：" + JSON.stringify(post.moods[0]));
    if (!post.moods[0].lineSegmentLabel) throw new Error("没有生成心情线细分时段文案：" + JSON.stringify(post.moods[0]));
    const postBad = await postRoute.handler({ req: { json: async () => ({ mood: "炸毛" }) }, json(value) { return value; } });
    if (postBad.ok) throw new Error("非法情绪词不应记录成功");
    const monthRoute = routes.find((item) => item.method === "GET" && item.route === "/api/moods");
    const month = await monthRoute.handler({
      req: { url: "http://localhost/api/moods?month=" + today.slice(0, 7) },
      json(value) { return value; },
    });
    if (!month?.ok || !month.days[today] || month.days[today].length !== 1) throw new Error("月速览未包含当天记录");
    const delRoute = routes.find((item) => item.method === "DELETE" && item.route === "/api/moods/:date/:id");
    const del = await delRoute.handler({
      req: { param(name) { return name === "date" ? today : post.moods[0].id; } },
      json(value) { return value; },
    });
    if (!del?.ok || del.moods.length !== 0) throw new Error("删除失败：" + JSON.stringify(del));
    const dayRoute = routes.find((item) => item.method === "GET" && item.route === "/api/events/:date");
    const dayDetail = await dayRoute.handler({ req: { param() { return today; } }, json(value) { return value; } });
    if (!dayDetail?.ok) throw new Error("日期详情失败");
    console.log(JSON.stringify({ ok: true, moodCount: meta.moods.length, today: post.date, hasMoodField: Array.isArray(dayDetail.day.moods), moodMetaLen: (dayDetail.day.moodMeta || []).length }));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", childCode], {
    encoding: "utf8",
    cwd: path.resolve("."),
    env: { ...process.env, USERPROFILE: isolatedHome, HOME: isolatedHome, HANA_HOME: path.join(isolatedHome, ".hanako") },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /"ok":true/);
  assert.match(result.stdout, /"moodCount":13/);
  assert.match(result.stdout, /"hasMoodField":true/);
  assert.match(result.stdout, /"moodMetaLen":13/);
});

test("路由：自动情绪日终批量分析保留真实时刻且每天只调用一次", () => {
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "sgj-mood-auto-route-"));
  const routeUrl = pathToFileURL(path.resolve("routes/ui.js")).href;
  const dataUrl = pathToFileURL(path.resolve("lib/data.js")).href;
  const moodUrl = pathToFileURL(path.resolve("lib/mood.js")).href;
  const childCode = `
    import fs from "node:fs";
    import path from "node:path";
    import os from "node:os";
    import { UserData } from ${JSON.stringify(dataUrl)};
    import { makeManualMood } from ${JSON.stringify(moodUrl)};
    import registerRoutes from ${JSON.stringify(routeUrl)};
    const home = path.join(os.homedir(), ".hanako");
    const agents = path.join(home, "agents", "hanako");
    const sessions = path.join(agents, "sessions");
    const dataDir = path.join(home, "plugin-data", "shiguangji");
    fs.mkdirSync(sessions, { recursive: true });
    fs.mkdirSync(path.join(home, "agents"), { recursive: true });
    fs.writeFileSync(path.join(home, "users.json"), JSON.stringify({ displayName: "小测试" }));
    fs.writeFileSync(path.join(agents, "config.yaml"), "agent:\\n  name: 小花\\n");
    const userTs = "2026-09-05T16:14:00+08:00";
    fs.writeFileSync(path.join(sessions, "one.jsonl"), JSON.stringify({ type: "message", timestamp: userTs, message: { role: "user", content: "我有点焦虑，脑壳有点累" } }) + "\\n");
    const data = new UserData(dataDir);
    // 先关掉自动入口再注册路由，避免测试进程启动时的首轮定时检查抢先处理同一天。
    await data.updateSettings({ autoSummary: false, moodDiscoveryMode: "off" });
    await data.addMood("2026-09-05", makeManualMood({ mood: "平静", now: new Date("2026-09-05T14:46:00+08:00") }));
    const calls = [];
    const ctx = {
      dataDir,
      bus: { async request(topic, input) {
        calls.push({ topic, input });
        if (input.callPurpose === "mood-discovery") return { text: JSON.stringify([{ mood: "焦虑", segment: "下午", observedAt: "2026-09-05 16:14", certainty: "possible", evidenceType: "explicit", evidence: "我有点焦虑", why: "可能在担心事情" }]) };
        return { text: "小测试今天和小花聊了几句" };
      } },
      log: { info() {}, warn() {}, error() {} },
    };
    const routes = [];
    const app = {
      get(path, handler) { routes.push({ method: "GET", path, handler }); },
      post(path, handler) { routes.push({ method: "POST", path, handler }); },
      put(path, handler) { routes.push({ method: "PUT", path, handler }); },
      delete(path, handler) { routes.push({ method: "DELETE", path, handler }); },
    };
    registerRoutes(app, ctx);
    const settingsPost = routes.find((item) => item.method === "POST" && item.path === "/api/settings");
    const settingsRoute = routes.find((item) => item.method === "GET" && item.path === "/api/settings");
    const savedSettings = await settingsPost.handler({ req: { async json() { return { moodDiscoveryMode: "economical" }; } }, json(value) { return value; } });
    const settings = await settingsRoute.handler({ json(value) { return value; } });
    if (!savedSettings.ok || settings.settings.moodDiscoveryMode !== "economical") throw new Error("自动情绪档位没有回显");
    const run = routes.find((item) => item.method === "POST" && item.path === "/api/summaries/run");
    const request = { req: { async json() { return { date: "2026-09-05" }; } }, json(value) { return value; } };
    const first = await run.handler(request);
    if (!first.ok || !first.mood || first.mood.autoCount !== 1) throw new Error("首轮自动情绪没有完成：" + JSON.stringify(first));
    const moods = new UserData(dataDir).getDayMoods("2026-09-05");
    const auto = moods.find((item) => item.source === "auto");
    if (!auto || auto.timePrecision !== "turn" || auto.observedAt !== "2026-09-05T08:14:00.000Z") throw new Error("自动候选没有保留真实消息时刻：" + JSON.stringify(moods));
    if (!moods.some((item) => item.source === "manual" && item.mood === "calm")) throw new Error("手动锚点被自动流程覆盖");
    const second = await run.handler(request);
    if (!second.ok || calls.filter((call) => call.input.callPurpose === "mood-discovery").length !== 1) throw new Error("同一天重复调用了自动情绪模型：" + JSON.stringify(calls));
    const state = new UserData(dataDir).getMoodHarvestState("2026-09-05");
    if (!state || state.status !== "completed" || state.candidateCount !== 1) throw new Error("自动情绪日级状态不对：" + JSON.stringify(state));
    console.log(JSON.stringify({ moodCalls: calls.filter((call) => call.input.callPurpose === "mood-discovery").length, moods: moods.map((item) => ({ source: item.source, mood: item.mood, precision: item.timePrecision })) }));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", childCode], {
    encoding: "utf8",
    cwd: path.resolve("."),
    env: { ...process.env, USERPROFILE: isolatedHome, HOME: isolatedHome, HANA_HOME: path.join(isolatedHome, ".hanako") },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /"moodCalls":1/);
  assert.match(result.stdout, /"precision":"turn"/);
});

test("路由：自动情绪空正文记为失败并给出工具模型自救路径", () => {
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "sgj-mood-empty-route-"));
  const routeUrl = pathToFileURL(path.resolve("routes/ui.js")).href;
  const dataUrl = pathToFileURL(path.resolve("lib/data.js")).href;
  const childCode = `
    import fs from "node:fs";
    import path from "node:path";
    import os from "node:os";
    import { UserData } from ${JSON.stringify(dataUrl)};
    import registerRoutes from ${JSON.stringify(routeUrl)};
    const home = path.join(os.homedir(), ".hanako");
    const agents = path.join(home, "agents", "hanako");
    const sessions = path.join(agents, "sessions");
    const dataDir = path.join(home, "plugin-data", "shiguangji");
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(path.join(home, "users.json"), JSON.stringify({ displayName: "小测试" }));
    fs.writeFileSync(path.join(agents, "config.yaml"), "agent:\\n  name: 小花\\n");
    fs.writeFileSync(path.join(sessions, "one.jsonl"), JSON.stringify({ type: "message", timestamp: "2026-09-05T10:00:00+08:00", message: { role: "user", content: "今天有点焦虑" } }) + "\\n");
    const data = new UserData(dataDir);
    await data.updateSettings({ autoSummary: false, moodDiscoveryMode: "economical", modelSource: "agent" });
    const routes = [];
    const app = {
      get(path, handler) { routes.push({ method: "GET", path, handler }); },
      post(path, handler) { routes.push({ method: "POST", path, handler }); },
      put(path, handler) { routes.push({ method: "PUT", path, handler }); },
      delete(path, handler) { routes.push({ method: "DELETE", path, handler }); },
    };
    registerRoutes(app, {
      dataDir,
      bus: { async request(topic, input) {
        if (input.callPurpose === "mood-discovery") return { text: "" };
        return { text: "小测试今天和小花聊了几句" };
      } },
      log: { info() {}, warn() {}, error() {} },
    });
    const run = routes.find((item) => item.method === "POST" && item.path === "/api/summaries/run");
    const result = await run.handler({ req: { async json() { return { date: "2026-09-05" }; } }, json(value) { return value; } });
    const state = new UserData(dataDir).getMoodHarvestState("2026-09-05");
    if (!result.ok || result.mood?.ok !== false) throw new Error("空正文没有单独标成情绪失败：" + JSON.stringify(result));
    if (!/工具模型通道/.test(result.mood.error || "")) throw new Error("缺少自救引导：" + JSON.stringify(result.mood));
    if (!state || state.status !== "failed") throw new Error("空正文被误记为完成：" + JSON.stringify(state));
    console.log(JSON.stringify({ mood: result.mood, state: state.status }));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", childCode], {
    encoding: "utf8",
    cwd: path.resolve("."),
    env: { ...process.env, USERPROFILE: isolatedHome, HOME: isolatedHome, HANA_HOME: path.join(isolatedHome, ".hanako") },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /"state":"failed"/);
  assert.match(result.stdout, /工具模型通道/);
});

test("路由：细致档位只对存疑候选追加一次裁决", () => {
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "sgj-mood-detailed-route-"));
  const routeUrl = pathToFileURL(path.resolve("routes/ui.js")).href;
  const dataUrl = pathToFileURL(path.resolve("lib/data.js")).href;
  const childCode = `
    import fs from "node:fs";
    import path from "node:path";
    import os from "node:os";
    import { UserData } from ${JSON.stringify(dataUrl)};
    import registerRoutes from ${JSON.stringify(routeUrl)};
    const home = path.join(os.homedir(), ".hanako");
    const agents = path.join(home, "agents", "hanako");
    const sessions = path.join(agents, "sessions");
    const dataDir = path.join(home, "plugin-data", "shiguangji");
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(path.join(home, "users.json"), JSON.stringify({ displayName: "小测试" }));
    fs.writeFileSync(path.join(agents, "config.yaml"), "agent:\\n  name: 小花\\n");
    fs.writeFileSync(path.join(sessions, "one.jsonl"), JSON.stringify({ type: "message", timestamp: "2026-09-05T10:00:00+08:00", message: { role: "user", content: "今天有点说不清楚，只是觉得乱" } }) + "\\n");
    const data = new UserData(dataDir);
    // 先关掉自动入口再注册路由，避免测试进程启动时的首轮定时检查抢先处理同一天。
    await data.updateSettings({ autoSummary: false, moodDiscoveryMode: "off" });
    const calls = [];
    const ctx = {
      dataDir,
      bus: { async request(topic, input) {
        calls.push({ topic, input });
        if (input.callPurpose === "mood-discovery") return { text: JSON.stringify([{ mood: "焦虑", segment: "上午", observedAt: "2026-09-05 10:00", certainty: "uncertain", evidenceType: "context", evidence: "", why: "可能有点乱" }]) };
        if (input.callPurpose === "mood-discovery-review") return { text: JSON.stringify([{ index: 0, decision: "drop", reason: "没有足够的用户原话依据" }]) };
        return { text: "小测试今天和小花聊了几句" };
      } },
      log: { info() {}, warn() {}, error() {} },
    };
    const routes = [];
    const app = {
      get(path, handler) { routes.push({ method: "GET", path, handler }); },
      post(path, handler) { routes.push({ method: "POST", path, handler }); },
      put(path, handler) { routes.push({ method: "PUT", path, handler }); },
      delete(path, handler) { routes.push({ method: "DELETE", path, handler }); },
    };
    registerRoutes(app, ctx);
    const settingsPost = routes.find((item) => item.method === "POST" && item.path === "/api/settings");
    await settingsPost.handler({ req: { async json() { return { moodDiscoveryMode: "detailed" }; } }, json(value) { return value; } });
    // 模拟 Hana 在首轮调用中断后留下 running：重启/下一轮应能继续，而不是被 attemptedAt 永久卡住。
    await data.updateMoodHarvestState("2026-09-05", { status: "running", attemptedAt: "2026-09-06T00:00:00.000Z" });
    const run = routes.find((item) => item.method === "POST" && item.path === "/api/summaries/run");
    const result = await run.handler({ req: { async json() { return { date: "2026-09-05" }; } }, json(value) { return value; } });
    const moods = new UserData(dataDir).getDayMoods("2026-09-05");
    const state = new UserData(dataDir).getMoodHarvestState("2026-09-05");
    if (!result.ok || moods.length !== 0) throw new Error("细致复核没有丢掉存疑候选：" + JSON.stringify({ result, moods }));
    if (!state || state.reviewedCandidateCount !== 1 || state.reviewedCount !== 1) throw new Error("细致复核状态没有记录：" + JSON.stringify(state));
    if (calls.filter((call) => call.input.callPurpose === "mood-discovery").length !== 1 || calls.filter((call) => call.input.callPurpose === "mood-discovery-review").length !== 1) throw new Error("细致档位调用次数不对：" + JSON.stringify(calls));
    console.log(JSON.stringify({ discovery: calls.filter((call) => call.input.callPurpose === "mood-discovery").length, review: calls.filter((call) => call.input.callPurpose === "mood-discovery-review").length, moods: moods.length }));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", childCode], {
    encoding: "utf8",
    cwd: path.resolve("."),
    env: { ...process.env, USERPROFILE: isolatedHome, HOME: isolatedHome, HANA_HOME: path.join(isolatedHome, ".hanako") },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /"discovery":1/);
  assert.match(result.stdout, /"review":1/);
});

test("页面：模板包含情绪面板、心情时间线与心情线页面", async () => {
  const { renderPage } = await import(pathToFileURL(path.resolve("lib/page-template.js")).href);
  const html = renderPage("test-token");
  assert.match(html, /记一笔当下的心情/);
  assert.match(html, /renderMoodPanel/);
  assert.match(html, /mood-grid|mood-open/);
  assert.match(html, /自动发现情绪/);
  assert.match(html, /data-val="economical">轻量/);
  assert.doesNotMatch(html, /省钱/, "设置页不应再使用“省钱”这个档位名称");
  assert.match(html, /mood-discovery-tip/, "自动情绪设置应有随选项切换的单独说明");
  assert.match(html, /不再自动发现情绪，手动记下的心情照常保留/);
  assert.match(html, /明显情绪字眼的日子/);
  assert.match(html, /完整可见对话，发现更全面/);
  assert.match(html, /mood-discovery-seg/);
  assert.match(html, /mood-timeline/);
  assert.match(html, /tab-moodline/);
  assert.match(html, /panel-moodline/);
  assert.match(html, /一天.*连续/s);
  assert.match(html, /moodLineSmoothPath/);
  assert.match(html, /moodLineSmoothPath\(points\)/, "单日和连续视图共用一条连续曲线");
  assert.match(html, /清晨/);
  assert.match(html, /深夜/);
  assert.match(html, /moodLineSegmentForEntry/);
  assert.match(html, /moodLinePointX/, "精确手动记录应在宽时段内部展开");
  assert.match(html, /moodLineEntryTimeLabel/, "手动记录应显示真实时刻");
  assert.match(html, /moodline-hover-tip|showMoodLineTooltip/, "心情点应使用亮色自绘提示，不走浏览器原生黑框");
  assert.match(html, /\.moodline-plot \{[^}]*position:\s*relative/s, "提示气泡应以心情图为定位参照，不能漂到页面顶部");
  assert.match(html, /max-width:\s*min\(360px, calc\(100% - 16px\)\)/, "提示气泡应限制宽度");
  assert.match(html, /white-space:\s*normal[^}]*overflow-wrap:\s*anywhere/s, "长提示应在气泡内换行");
  assert.match(html, /data-tooltip/, "心情点应带可访问的提示文本");
  assert.match(html, /小花发现的候选/, "自动记录应明确是候选而不是确定事实");
  assert.match(html, /entry-source|pill-source|tl-source/, "自动记录在页面表层应有候选标记");
  assert.match(html, /依据：“/, "自动记录提示应保留证据入口");
  assert.match(html, /return 192 - n \* \(134 \/ 8\)/, "9 档视觉层级应映射到不同高度");
  assert.match(html, /空白日期不补点，曲线轻轻跨过去/);
  assert.doesNotMatch(html, /moodline-path gap|moodline-legend-gap/, "心情线不再用断线样式");
  assert.match(html, /api\/moods/);
  assert.match(html, /看这天的心情线/);
  // 页面脚本能通过 new Function 解析（防模板拼接括号失衡）
  const scriptMatch = html.match(/<script>\n([\s\S]*?)\n<\/script>/);
  if (scriptMatch) {
    assert.doesNotThrow(() => new Function(scriptMatch[1]), "页面脚本语法应合法");
  }
});

test("证据窗口：情绪信号在长对话尾部时不会被截断", () => {
  // 模拟一天几百条消息拼成几万字，情绪原话发生在末尾：旧实现从头截 8000 会丢掉它。
  const rows = [];
  const pad = "这是一段非常长的上下文消息内容，用来把整天的文本撑到远远超过八千字符的预算上限，确保情绪信号发生在截断线之后，从而证明旧实现会把尾部情绪原话裁掉。";
  // 造 150 条无信号背景消息（总长远超 8000）
  for (let i = 0; i < 150; i++) {
    rows.push({ ts: 1700000000000 + i * 60000, role: i % 3 === 0 ? "user" : "assistant", text: pad });
  }
  // 末尾加一条情绪信号
  rows.push({ ts: 1700000000000 + 150 * 60000, role: "user", text: "小花，今天有一点点累。。" });
  const signals = findExplicitMoodSignals(rows);
  assert.equal(signals.length, 1, "本地预筛应命中末尾的“累”");
  const fmt = (row) => (row.role === "user" ? "我：" : "伙伴：") + row.text;
  const oldWay = rows.map(fmt).join("\n").slice(0, 8000);
  assert.ok(!oldWay.includes("累"), "旧实现从头截断会丢掉尾部情绪信号（前置条件，证明 bug 存在）");
  const evidence = buildSignalAwareEvidence(rows, signals, fmt, 8000);
  assert.ok(evidence.includes("小花，今天有一点点累"), "信号感知窗口必须保住尾部情绪原话");
  assert.ok(evidence.length <= 8000, "窗口不能超预算");
});

test("证据窗口：多条信号分散时都能纳入且不重复、不超预算", () => {
  const rows = [];
  const pad = "普通上下文内容，用来撑大体量。";
  for (let i = 0; i < 200; i++) {
    rows.push({ ts: 1700000000000 + i * 60000, role: i % 2 === 0 ? "user" : "assistant", text: pad });
  }
  // 早、中、晚三条信号
  rows[10] = { ...rows[10], role: "user", text: "早上有点烦躁，不想起床" };
  rows[100] = { ...rows[100], role: "user", text: "下午工作好累啊" };
  rows[190] = { ...rows[190], role: "user", text: "晚上和慧慧逛街好开心嘿嘿" };
  const signals = findExplicitMoodSignals(rows);
  assert.equal(signals.length, 3);
  const fmt = (row) => (row.role === "user" ? "我：" : "伙伴：") + row.text;
  const evidence = buildSignalAwareEvidence(rows, signals, fmt, 8000);
  assert.ok(evidence.includes("烦躁"), "早上的信号应可见");
  assert.ok(evidence.includes("好累"), "下午的信号应可见");
  assert.ok(evidence.includes("逛街好开心"), "晚上的信号应可见");
  assert.ok(evidence.length <= 8000, "不能超预算");
  // 同一条消息不能因为同时命中多条信号而重复计入
  assert.equal(evidence.split("烦躁").length - 1, 1);
  // 行间顺序应保持时间先后
  assert.ok(evidence.indexOf("烦躁") < evidence.indexOf("好累"), "窗口内消息应保持时间顺序");
  assert.ok(evidence.indexOf("好累") < evidence.indexOf("逛街好开心"));
});

test("证据窗口：无信号或空输入时优雅降级", () => {
  const fmt = (row) => row.text;
  assert.equal(buildSignalAwareEvidence([], [], fmt, 8000), "");
  const rows = [
    { ts: 1, role: "user", text: "平平无奇的一天" },
    { ts: 2, role: "assistant", text: "嗯嗯" },
  ];
  const noSignal = buildSignalAwareEvidence(rows, [], fmt, 8000);
  assert.ok(noSignal.includes("平平无奇"));
  assert.ok(noSignal.includes("嗯嗯"));
  assert.ok(noSignal.length <= 8000);
  // 极小预算也应至少输出一条，不返回空
  const tiny = buildSignalAwareEvidence(rows, [], fmt, 1);
  assert.ok(tiny.length > 0, "预算过小时应保住至少一条消息");
});
