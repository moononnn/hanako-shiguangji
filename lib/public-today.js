// 拾光记 · 对外快照（public-today.json）
//
// 给别的消费方（聊天类 App 等）读的只读快照：今天是什么日子、窗外什么样、
// 以及每位伙伴自己那段已收好的生活日。
//
// 【隐式约定，改路径必须两边同步】快照位置（<数据目录>/public-today.json）是契约定死的：
// 消费方（如茶话会）从自己的 dataDir 往上退两层再拼 plugin-data/shiguangji/。
// 谁挪了目录而另一边没跟着改，对面就会静默读不到，排查时先对这里。
//
// 三条纪律，跟表情包那份对外索引同源：
//   1. **不做选择、不做裁剪之外的加工**。快照只摊平事实；谁看得到哪一段由消费方按契约取。
//   2. **不改动任何现有注入逻辑**。这是纯新增的一条出口，坏了也只坏这一条。
//   3. 格式冻结在 schemaVersion 上，内部账本怎么改都不影响这份门面。
//      契约文档见仓库根目录 PUBLIC-TODAY.md。
//
// 隐私边界（要紧的一条）：做册是「谁的归谁」。快照里按 agentId 分组各存一份，
// 消费方只许取自己那一份，不许把别人的档案当自己的记忆用。

import fs from "node:fs";
import path from "node:path";
import { getBuiltinFestivals, isWorkday } from "./festivals.js";
import { dateKey, filterDueTodos } from "./data.js";
import { selectRecentSummaries } from "./recent-summaries.js";
import { weatherCacheIsFresh, weatherCacheMatches, normalizeWeatherResult } from "./weather.js";

export const PUBLIC_TODAY_FILE_NAME = "public-today.json";
export const PUBLIC_TODAY_SCHEMA_VERSION = 1;
/** 每位伙伴最多带几段生活日回顾（按结束的生活日，一般 3 段就够）。 */
export const SUMMARY_MAX_ENTRIES = 6;
/** 每位伙伴的回顾总字数上限，跟主对话注入同一档。 */
export const SUMMARY_CHAR_BUDGET = 1800;
/** 单条标题/地名的截断长度，防脏数据把快照撑爆。 */
const TEXT_LIMIT = 60;
/** 今天到期待办最多列几条。 */
const TODO_LIMIT = 20;
/** 去抖窗口：短时间内的多次刷新请求合成一次写盘。 */
const SCHEDULE_DEBOUNCE_MS = 2000;

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

function cleanText(value, maxLength = TEXT_LIMIT) {
  return String(value ?? "").replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, maxLength);
}

function cleanList(values, limit = 20) {
  return (Array.isArray(values) ? values : [])
    .map((item) => cleanText(item))
    .filter(Boolean)
    .slice(0, limit);
}

export function publicTodayPath(dataDir) {
  return path.join(String(dataDir || "."), PUBLIC_TODAY_FILE_NAME);
}

/** 读一份天气缓存；没开天气、地点不符或缓存过期都当没有。 */
export function readSnapshotWeather(data, settings = {}, now = new Date()) {
  if (settings.weatherEnabled === false) return null;
  try {
    const cache = data.getWeatherCache();
    if (!weatherCacheMatches(cache, settings)) return null;
    if (!weatherCacheIsFresh(cache, settings, now)) return null;
    const normalized = normalizeWeatherResult(cache.result);
    if (!normalized || !String(normalized.line || "").trim()) return null;
    const temp = Number(normalized.temp);
    return {
      place: cleanText(normalized.place || cache.location || "", 40),
      line: cleanText(normalized.line, 120),
      temp: Number.isFinite(temp) ? temp : null,
    };
  } catch {
    return null;
  }
}

/**
 * 按伙伴分组收集已收好的生活日。
 *
 * 每位伙伴单独跑一次选择器（currentAgentId 固定成 ta 自己、shared=false），
 * 这样每个人拿到的都是「自己的近 3 个结束生活日 + 自己的字符预算」，
 * 不会因为别人档案多就把自己的挤掉。
 *
 * @returns {Record<string, Array<{date: string, text: string}>>}
 */
export function collectSnapshotSummaries(data, { now = new Date(), boundaryHour = 4 } = {}) {
  let entries = [];
  try {
    entries = data.listSummaryEntries();
  } catch {
    return {};
  }
  const agentIds = [...new Set(
    (Array.isArray(entries) ? entries : [])
      .map((entry) => String(entry?.agentId || "").trim())
      .filter(Boolean)
  )];
  const out = {};
  for (const agentId of agentIds) {
    const picked = selectRecentSummaries(entries, {
      now,
      boundaryHour,
      currentAgentId: agentId,
      shared: false,
      maxEntries: SUMMARY_MAX_ENTRIES,
      maxChars: SUMMARY_CHAR_BUDGET,
    });
    const rows = (picked.entries || [])
      .map((entry) => ({ date: cleanText(entry.date, 10), text: cleanText(entry.text, SUMMARY_CHAR_BUDGET) }))
      .filter((row) => row.date && row.text);
    if (rows.length) out[agentId] = rows;
  }
  return out;
}

/**
 * 组一份快照。纯组装，数据从传进来的 data 上读（测试传假对象即可）。
 * @returns {object} 快照对象
 */
export function buildPublicToday({ now = new Date(), data, settings = null } = {}) {
  const resolved = settings || (data && typeof data.getSettings === "function" ? data.getSettings() : {});
  const builtin = getBuiltinFestivals(now);
  const userEvents = data.eventsOnDate(now).filter((e) => e.type !== "period");
  const showPeriod = resolved.showPeriod !== false;
  const period = showPeriod && data.periodsWithDayOn(now).some((p) => !p.predicted);
  const todos = filterDueTodos(data.listEvents(), now).filter((t) => !t.done);

  let dataRev = 0;
  try {
    dataRev = Number(data.getDataRev?.()) || 0;
  } catch {
    dataRev = 0;
  }

  return {
    schemaVersion: PUBLIC_TODAY_SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    dataRev,
    today: {
      date: dateKey(now),
      weekday: WEEKDAYS[now.getDay()],
      festivals: cleanList(builtin.map((f) => f && f.name), 10),
      events: cleanList(userEvents.map((e) => e && e.title), 10),
      workday: !!isWorkday(now),
      todos: cleanList(todos.map((t) => t && t.title), TODO_LIMIT),
      period: !!period,
    },
    weather: readSnapshotWeather(data, resolved, now),
    summaries: collectSnapshotSummaries(data, { now, boundaryHour: resolved.dayBoundaryHour }),
  };
}

function atomicWriteJson(file, value) {
  const tmp = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf-8");
  fs.renameSync(tmp, file);
}

/** 上次真正写下那份快照的内容指纹（去掉时间戳后比对），内容没变就不重写。 */
let lastWrittenKey = "";

/** 仅供测试：清掉「上次写过什么」的记忆，让下一次写入一定落盘。 */
export function __resetPublicTodayCache() {
  lastWrittenKey = "";
}

/**
 * 写一份快照。任何一步失败都安静收场——这是对外出口，绝不能反噬拾光记自己的主流程。
 * @returns {object|null} 真正构建出的快照（跳过写入时也返回内容）
 */
export function writePublicToday({ dataDir, data, settings = null, now = new Date(), force = false } = {}) {
  if (!dataDir || !data) return null;
  const snapshot = buildPublicToday({ now, data, settings });
  const file = publicTodayPath(dataDir);
  const key = JSON.stringify({ ...snapshot, generatedAt: "" });
  if (!force && key === lastWrittenKey && fs.existsSync(file)) return snapshot;
  try {
    atomicWriteJson(file, snapshot);
    lastWrittenKey = key;
  } catch {
    lastWrittenKey = "";
  }
  return snapshot;
}

let debounceTimer = null;
let pendingJob = null;

/** 去抖刷新：短时间内的多次请求合成一次写盘；失败静默。 */
export function schedulePublicToday(job) {
  pendingJob = job;
  if (debounceTimer) return;
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    const current = pendingJob;
    pendingJob = null;
    try {
      writePublicToday(current);
    } catch {
      // 对外快照刷新失败不反噬主流程
    }
  }, SCHEDULE_DEBOUNCE_MS);
  debounceTimer.unref?.();
}

/** 仅供测试：清掉挂着的去抖任务。 */
export function __clearPublicTodayTimer() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = null;
  pendingJob = null;
}
