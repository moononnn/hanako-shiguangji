// 拾光记 · 路由层（API + 页面）
// 提供：日历数据查询、事件增删改查、注入配置读写、每日总结投递/查询与后台恢复。
// 文件预算豁免：该文件集中注册同一页面的 API 与页面入口，拆分会增加路由状态交叉成本。

import crypto from "node:crypto";
import os from "node:os";
import { renderPage } from "../lib/page-template.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { UserData, dateKey, filterDueTodos, isTodoOverdue, normalizeMoodDiscoveryMode } from "../lib/data.js";
import { configureSharedUserData, getSharedUserData } from "../lib/shared-data.js";
import { getBuiltinFestivals, isWorkday, getMonthFestivals } from "../lib/festivals.js";
import { ModelConfig } from "../lib/model-config/index.js";
import { buildInjectionText } from "../lib/inject.js";
import {
  configureWeatherNetwork,
  getWeatherForInject,
  normalizeWeatherResult,
  resolveWeatherLocation,
  weatherCacheIsFresh,
  weatherCacheMatches,
} from "../lib/weather.js";
import {
  ADMIN_REGION_DATA_VERSION,
  formatAdministrativeRegion,
  getAdministrativeRegion,
  listAdministrativeRegions,
} from "../lib/administrative-divisions.js";
import {
  collectDayMessages,
  finishedLifeDayKey,
  formatMessagesForPrompt,
  groupHistoricalSummaryEntries,
  groupSummaryMessages,
  isHanabrewInstalled,
  isUserFacingAgentId,
  lifeDayKey,
  listSummaryAgents,
  resolveSummaryAgentId,
  mergeSummaryGroups,
  normalizeBoundaryHour,
  readAgentDisplayName,
  isSyntheticSummaryText,
  sanitizeVisibleText,
} from "../lib/day-summary.js";
import { selectRecentSummaries } from "../lib/recent-summaries.js";
import {
  MOODS,
  buildSignalAwareEvidence,
  findExplicitMoodSignals,
  makeManualMood,
  mergeMoodEntries,
  moodById,
  normalizeMoodId,
  parseMoodOutput,
  parseMoodReviewOutput,
  pickDayMood,
  segmentLabel,
  segmentOfHour,
} from "../lib/mood.js";
import { readHanaUserName } from "../lib/user-name.js";
import { findPartnerFortuneSignals, filterPartnerRows } from "../lib/partner-mood.js";
import { moodLineSegmentForEntry, moodLineSegmentLabelForEntry } from "../lib/mood-line.js";
import { TodoReminderScheduler } from "../lib/todo-reminder-scheduler.js";
import { configureDebugLog, logInfo, logWarn, logError } from "../lib/debug-log.js";
import { UpdateChecker } from "../lib/update-checker/index.js";
import { Feedback } from "../lib/feedback/index.js";

// 检查更新与反馈提交的目标仓库（发布平台）
const REPO = "moononnn/hanako-shiguangji";
const PLUGIN_NAME = "拾光记";


let mcInstance = null; // ModelConfig 实例（路由注册时创建，runDailySummary 复用）
let summaryTimer = null;
let activeSummaryJobPromise = null;
const summaryAttempts = new Map(); // date -> timestamp，失败时节流后可重试
let activePartnerMoodJobPromise = null; // 伙伴心情历史补档单飞锁
let partnerMoodSubmitQueue = Promise.resolve(); // 补档投递串行，防并发建任务
const PARTNER_MOOD_JOB_ACTIVE_STATUSES = new Set(["queued", "running"]);
const PARTNER_MOOD_BACKFILL_MAX_DATES = 31; // 与批量做册一致：一次最多 31 天
const SUMMARY_REVISION_SESSION_TTL_MS = 30 * 60 * 1000;
const SUMMARY_EVIDENCE_PRIMARY_CHARS = 8000;
const SUMMARY_EVIDENCE_FALLBACK_CHARS = 4000;
const summaryRevisionSessions = new Map();
const INJECT_INTERVAL_HOURS = new Set([0.5, 1, 4, 8]);
const MOOD_HARVEST_TERMINAL_STATUSES = new Set(["skipped", "completed"]);
// failed 不算终态：模型被劫持/审核拒/瞬时失败后，定时器要能再试。

// 天气失败原因 -> 页面可读的短提示。宿主白名单拦截是最常见的一种（manifest 只放行已知域名）。
function weatherErrorHint(e) {
  const raw = String(e?.message || e || "").trim();
  if (!raw) return "";
  const blocked = raw.match(/host "([^"]+)" is not declared in manifest network\.allowedHosts/i);
  if (blocked) return `：天气域名 ${blocked[1]} 不在插件网络放行名单，请更新拾光记或检查 manifest`;
  return `：${raw.slice(0, 200)}`;
}

export function modelChannelErrorHint(error, source = "agent") {
  const raw = String(error?.message || error || "模型调用失败").trim();
  const knownFailure = /(模型未回复正文|未返回可见正文|空响应|no handler|timed?\s*out|timeout|超时)/i.test(raw)
    || isSummaryPromptSizeError(error);
  if (source !== "agent" || !knownFailure) {
    return raw;
  }
  const guide = "这通常是 Hana 的工具模型通道没有扛住这次长文本。可以去 Hana「设置 → 模型」把「工具模型」留空，让它回落到伙伴主对话模型；也可以在拾光记「设置 → 做册用的模型 → 从 Hana 模型列表选择」里改用已配置的模型，或切到「自定义 API」。";
  return raw.includes("工具模型通道") ? raw : `${raw}。${guide}`;
}

export function isSummaryPromptSizeError(error) {
  const raw = [error?.code, error?.message, error]
    .filter((value) => value !== undefined && value !== null)
    .map((value) => String(value))
    .join(" ");
  return /\b413\b|payload\s+too\s+large|request\s+entity\s+too\s+large|context.{0,24}(?:length|window|limit|exceed|too)|(?:too|exceed|maximum).{0,24}(?:tokens?|input|prompt)|prompt.{0,24}(?:too\s+long|length|limit)|输入.{0,10}(?:过长|超限)|上下文.{0,10}(?:过长|超限|限制)|请求体.{0,10}(?:过大|超限)/i.test(raw);
}

function isMoodHarvestTerminal(state) {
  return !!state && MOOD_HARVEST_TERMINAL_STATUSES.has(String(state.status || ""));
}

function cleanupSummaryRevisionSessions(now = Date.now()) {
  for (const [id, session] of summaryRevisionSessions.entries()) {
    if (!session || now - Number(session.lastActive || 0) > SUMMARY_REVISION_SESSION_TTL_MS) {
      summaryRevisionSessions.delete(id);
    }
  }
}

function getData() {
  return getSharedUserData();
}

const HANA_HOME = process.env.HANA_HOME || path.join(os.homedir(), ".hanako");
const AGENTS_DIR = path.join(HANA_HOME, "agents");

function requestAgentId(c) {
  const requestContext = c?.get?.("pluginRequestContext");
  const value = requestContext?.agentId || c?.req?.agentId || "";
  return String(value || "").trim();
}

function decorateSummaryEntries(entries) {
  return (Array.isArray(entries) ? entries : []).map((entry) => ({
    ...entry,
    agentName: entry.agentName || (entry.agentId ? readAgentDisplayName(AGENTS_DIR, entry.agentId) : "") || (entry.agentId || "未分类的一页"),
  }));
}

function summaryEntriesForDate(date) {
  return decorateSummaryEntries(getData().listSummaryEntries(date));
}

function normalizeSummaryAgentIds(value) {
  if (!Array.isArray(value)) return null;
  return [...new Set(value
    .map((id) => resolveSummaryAgentId(AGENTS_DIR, id))
    .filter(isUserFacingAgentId))];
}

function getSelectedSummaryAgentIds(settings) {
  const ids = normalizeSummaryAgentIds(settings?.summaryAgentIds);
  return ids ? new Set(ids) : null;
}

function getSummaryForAgentOrLegacy(date, agentId = "") {
  const entries = summaryEntriesForDate(date);
  const id = String(agentId || "").trim();
  if (id) return entries.find((entry) => entry.agentId === id) || null;
  return entries.find((entry) => entry.unclassified) || null;
}

// 注入配置的 store（给 model-config 用的最小契约）
function makeSettingsStore() {
  return {
    getConfig() {
      return getData().getSettings();
    },
    saveConfig(mutator) {
      const data = getData();
      const cfg = data.getSettings();
      mutator(cfg);
      // 返回持久化 Promise，模型配置保存接口要等密文真正落盘后再回成功。
      return data.updateSettings(cfg);
    },
  };
}

// 设置接口只返回页面需要的白名单字段；尤其不能把 custom/Hana 存量 Key 原样带回浏览器。
function publicSettings(s) {
  return {
    injectionEnabled: s.injectionEnabled !== false,
    injectMode: s.injectMode,
    injectIntervalHours: s.injectIntervalHours,
    autoSummary: s.autoSummary,
    moodDiscoveryMode: normalizeMoodDiscoveryMode(s.moodDiscoveryMode),
    partnerMoodEnabled: s.partnerMoodEnabled === true,
    dayBoundaryHour: normalizeBoundaryHour(s.dayBoundaryHour),
    summaryAgentIds: normalizeSummaryAgentIds(s.summaryAgentIds),
    summaryAgents: listSummaryAgents(AGENTS_DIR),
    summaryShared: s.summaryShared === true,
    showPeriod: s.showPeriod !== false,
    weatherEnabled: s.weatherEnabled !== false,
    weatherLocation: s.weatherLocation || "",
    weatherArea: resolveWeatherLocation(s).area || null,
    weatherIntervalHours: s.weatherIntervalHours || 3,
    // 当前模型档关不掉思考时，页面要提醒用户「消耗明显更多，建议换一个能关思考的档」。
    thinkingUnstoppable: isThinkingUnstoppable(s),
    thinkingModelKey: currentModelKey(s),
  };
}

const SUMMARY_JOB_MAX_DATES = 31;
const SUMMARY_JOB_ACTIVE_STATUSES = new Set(["queued", "running"]);
let summaryJobSubmitQueue = Promise.resolve();

function normalizeSummaryDates(value, boundaryHour) {
  const list = Array.isArray(value) ? value : [value];
  const latestFinished = finishedLifeDayKey(new Date(), boundaryHour);
  const dates = [...new Set(list.map((item) => String(item || "").trim()).filter(Boolean))].sort();
  if (!dates.length) return { error: "至少选一天" };
  if (dates.length > SUMMARY_JOB_MAX_DATES) return { error: `一次最多做 ${SUMMARY_JOB_MAX_DATES} 页` };
  for (const date of dates) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: `日期格式不对：${date}` };
    const parsed = new Date(`${date}T00:00:00`);
    if (Number.isNaN(parsed.getTime()) || dateKey(parsed) !== date) return { error: `日期无效：${date}` };
    if (date > latestFinished) return { error: `${date} 还没有结束，先选已经过去的日子` };
  }
  return { dates };
}

function decorateSummaryJob(job) {
  if (!job) return null;
  const dates = Array.isArray(job.dates) ? job.dates : [];
  const outcomes = Array.isArray(job.outcomes) ? job.outcomes : [];
  return {
    ...job,
    // done 只数真正做好的页（failed 不算），进度条和文案才能自洽。
    progress: { done: outcomes.filter((item) => item.status !== "failed").length, total: dates.length },
    failed: outcomes.filter((item) => item.status === "failed").length,
  };
}

function findActiveSummaryJob(data) {
  return data.listSummaryJobs(50).find((job) => SUMMARY_JOB_ACTIVE_STATUSES.has(job.status)) || null;
}

async function mergeRetryOutcomes(data, retryJobId) {
  const retryJob = data.getSummaryJob(retryJobId);
  if (!retryJob) return;
  const retryOf = String(retryJob.retryOf || "").trim();
  if (!retryOf) return;
  const parent = data.getSummaryJob(retryOf);
  if (!parent || !parent.id) return;
  const retried = new Map((Array.isArray(retryJob.outcomes) ? retryJob.outcomes : []).map((item) => [item.date, item]));
  const mergedOutcomes = (Array.isArray(parent.outcomes) ? parent.outcomes : []).map((item) => {
    return retried.has(item.date) ? { ...retried.get(item.date), retriedAt: new Date().toISOString() } : item;
  });
  const parentFailed = mergedOutcomes.filter((item) => item.status === "failed").length;
  await data.updateSummaryJob(retryOf, {
    outcomes: mergedOutcomes,
    status: parentFailed ? "completed_with_errors" : "completed",
    error: parentFailed ? `${parentFailed} 页没有做好，可以重新发起` : "",
    retryCount: Number(parent.retryCount || 0) + 1,
  });
  // 重试任务本身合并完就收尾：标记 merged，不再出现在进度卡列表里。
  await data.updateSummaryJob(retryJobId, { status: "merged", currentDate: "", error: "" });
}

function submitSummaryJob(ctx, dates, force, overrides = {}) {
  const task = summaryJobSubmitQueue.catch(() => {}).then(async () => {
    const data = getData();
    const active = findActiveSummaryJob(data);
    if (active) return { ok: false, error: "已经有一项后台做册在运行", job: decorateSummaryJob(active) };
    const now = new Date().toISOString();
    const settings = data.getSettings();
    const job = {
      id: `summary-job-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
      dates,
      outcomes: [],
      status: "queued",
      currentDate: "",
      force: overrides.force !== undefined ? overrides.force : (force !== false),
      // 任务创建时固定总结范围，重启/等待期间修改设置不会改变这批日期的目标伙伴。
      summaryAgentIds: overrides.summaryAgentIds !== undefined
        ? overrides.summaryAgentIds
        : normalizeSummaryAgentIds(settings.summaryAgentIds),
      // 重试任务标记来源任务，完成后把新结果合回原任务。
      retryOf: overrides.retryOf || "",
      createdAt: now,
      updatedAt: now,
    };
    await data.createSummaryJob(job);
    startSummaryJob(ctx, job.id);
    return { ok: true, job: decorateSummaryJob(job) };
  });
  summaryJobSubmitQueue = task.catch(() => {});
  return task;
}

function normalizeSummaryOutput(value, userName) {
  const text = sanitizeVisibleText(value);
  const name = String(userName || "").trim();
  if (!text || !name || name === "用户") return text;
  return text.replace(/用户/g, () => name).replace(/\buser\b/gi, () => name);
}

export default function registerRoutes(app, ctx) {
  configureSharedUserData(ctx?.dataDir);
  configureDebugLog(ctx?.dataDir);
  // 页面路由拿得到插件 ctx；把宿主网络能力交给扩展的后台天气刷新复用。
  const weatherFetcher = configureWeatherNetwork(ctx?.network);
  // 把 model-config 的日志接到插件自己的日志文件。
  // 它内部那条「模型未交付可见正文，准备同模型重试（hadThinking=…, finishReason=…）」走的
  // 是 ctx.log，默认只进宿主进程日志，出问题时查不到——而这条恰恰是判断「思考耗尽」还是
  // 「服务端真空」的唯一证据。诊断必须有落点。
  const summarizeErrorPart = (v) => (v?.message || (typeof v === "string" ? v : JSON.stringify(v)));
  const mcLogger = {
    info: (msg, ...rest) => logInfo(`[model] ${msg}${rest.length ? " " + rest.map(summarizeErrorPart).join(" ") : ""}`),
    warn: (msg, ...rest) => logWarn(`[model] ${msg}${rest.length ? " " + rest.map(summarizeErrorPart).join(" ") : ""}`),
    error: (msg, ...rest) => logError(`[model] ${msg}${rest.length ? " " + rest.map(summarizeErrorPart).join(" ") : ""}`),
  };
  const mc = new ModelConfig({ ctx: { ...ctx, log: mcLogger }, store: makeSettingsStore() });
  mcInstance = mc;
  // 这版直接回到三档模型契约：旧测试版可能留下的 Hana 地址/Key 只清理一次，
  // 以后 Hana 档永远只保存 provider/model，凭据从 Hana 运行时读取。
  mc.cleanupLegacyHanaCredentials().catch((error) => {
    ctx?.log?.warn?.("[拾光记] 清理旧 Hana 模型凭据失败：", error?.message || error);
  });

  // 轻量定时器：每分钟检查一次是否到点该做每日总结（惰性，不依赖宿主调度器）
  startSummaryTimer(ctx);

  // 待办提醒优先接入 Hana 持久化 TaskRegistry；旧宿主自动退回 30 秒补扫。
  // 调度器只负责有明确时间的未完成待办，不改助手身份文件，也不影响普通日历记录。
  const todoReminderScheduler = new TodoReminderScheduler({ ctx, data: getData() });
  todoReminderScheduler.start().catch((error) => {
    const msg = error?.message || error;
    ctx?.log?.warn?.("[拾光记] 待办提醒调度器未能启动：", msg);
    logWarn("待办提醒调度器未能启动：", msg);
  });

  // 旧数据迁移（幂等）：启动时跑一次，把手写「生理期第N天」规范成周期记录
  // 不阻塞启动，失败也不影响主流程
  Promise.resolve()
    .then(() => getData().migrateLegacyPeriods())
    .then((r) => {
      if (r.migrated > 0 || r.uncertain > 0) {
        const msg = `${r.migrated} 条已修复，${r.uncertain} 条待确认`;
        ctx?.log?.info?.(`[拾光记] 旧数据迁移：${msg}`);
        logInfo("旧数据迁移：", msg);
      }
    })
    .catch((e) => {
      const msg = e?.message || e;
      ctx?.log?.warn?.("[拾光记] 旧数据迁移失败（不影响使用）:", msg);
      logWarn("旧数据迁移失败（不影响使用）:", msg);
    });

  // ── 事件 API ──
  app.get("/api/events", async (c) => {
    const data = getData();
    return c.json({ ok: true, events: data.listEvents() });
  });

  app.get("/api/events/:date", async (c) => {
    const data = getData();
    const date = c.req.param("date");
    const d = new Date(date + "T00:00:00");
    if (isNaN(d.getTime())) return c.json({ ok: false, error: "日期格式不对" });
    const dk = dateKey(d);
    const builtin = getBuiltinFestivals(d);
    // period 单独走 periods，避免开始日同时出现在 userEvents 和 periods 里。
    const userEvents = data.eventsOnDate(d).filter((e) => e.type !== "period");
    const periods = data.periodsWithDayOn(d);
    // 前一天是否在生理期内（已确认）：用于详情面板显示「今天也是生理期」延续按钮
    const prevD = new Date(d);
    prevD.setDate(prevD.getDate() - 1);
    const prevPeriods = data.periodsWithDayOn(prevD);
    // 档案：按伙伴展开；旧版混合总结作为未分类档案保留。
    const summaries = summaryEntriesForDate(dk);
    const summary = summaries.length === 1 ? summaries[0] : null;
    const settings = data.getSettings();
    const boundary = normalizeBoundaryHour(settings.dayBoundaryHour);
    const now = new Date();
    const currentLifeDay = lifeDayKey(now, boundary);
    const finishedLimit = finishedLifeDayKey(now, boundary);
    const hasSummary = summaries.some((entry) => UserData.isUsableSummary(entry));
    const canSummary = dk <= finishedLimit && !hasSummary;
    const isPastLifeDay = dk < currentLifeDay;
    const workday = isWorkday(d);
    const todayDate = new Date();
    const today = dateKey(todayDate);
    const overdueTodos = dk === today
      ? data.listEvents().filter((e) => isTodoOverdue(e, todayDate))
      : [];
    const weatherCache = dk === today ? data.getWeatherCache() : null;
    const weather = dk === today && settings.weatherEnabled !== false &&
      weatherCacheMatches(weatherCache, settings) && weatherCacheIsFresh(weatherCache, settings, todayDate)
      ? normalizeWeatherResult(weatherCache.result)
      : null;
    return c.json({
      ok: true,
      day: {
        builtin,
        userEvents,
        periods: periods.map((p) => ({ ...p.event, day: p.day, predicted: p.predicted })),
        prevPeriods: prevPeriods.map((p) => ({ ...p.event, day: p.day, predicted: p.predicted })),
        summary: summary && UserData.isUsableSummary(summary) ? summary : null,
        summaries,
        canSummary,
        isPastLifeDay,
        canAddTodo: !isPastLifeDay,
        overdueTodos,
        weather,
        workday,
        // 这一天的心情记录（时间线回看；今日卡随手记也走这里刷新）
        moods: moodEntriesForDate(dk),
        moodMeta: MOODS,
      },
    });
  });

  app.post("/api/events", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try {
      const ev = await getData().addEvent(body);
      todoReminderScheduler.eventChanged(ev);
      return c.json({ ok: true, event: ev });
    } catch (e) {
      return c.json({ ok: false, error: e.message });
    }
  });

  app.put("/api/events/:id", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try {
      const ev = await getData().updateEvent(c.req.param("id"), body);
      todoReminderScheduler.eventChanged(ev);
      return c.json({ ok: true, event: ev });
    } catch (e) {
      return c.json({ ok: false, error: e.message });
    }
  });

  app.delete("/api/events/:id", async (c) => {
    const id = c.req.param("id");
    try {
      await getData().removeEvent(id);
      todoReminderScheduler.eventChanged(null, id);
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ ok: false, error: e.message });
    }
  });

  // 待办勾选完成
  app.post("/api/events/:id/toggle", async (c) => {
    try {
      const ev = await getData().toggleTodo(c.req.param("id"));
      if (!ev) return c.json({ ok: false, error: "找不到这条待办" });
      todoReminderScheduler.eventChanged(ev);
      return c.json({ ok: true, event: ev });
    } catch (e) {
      return c.json({ ok: false, error: e.message });
    }
  });

  // 生理期快捷记录：以某天为开始日标记（POST），或移除某天标记（DELETE）
  app.post("/api/periods", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try {
      const date = body.date; // YYYY-MM-DD，开始日
      const d = new Date(date + "T00:00:00");
      if (isNaN(d.getTime())) return c.json({ ok: false, error: "日期格式不对" });
      const duration = Math.max(1, parseInt(body.duration, 10) || 5);
      const r = await getData().markPeriod(d, duration);
      return c.json({ ok: true, ...r });
    } catch (e) {
      return c.json({ ok: false, error: e.message });
    }
  });

  app.delete("/api/periods", async (c) => {
    try {
      const url = new URL(c.req.url, "http://localhost");
      const date = url.searchParams.get("date");
      const d = new Date(date + "T00:00:00");
      if (isNaN(d.getTime())) return c.json({ ok: false, error: "日期格式不对" });
      const changed = await getData().unmarkPeriodDay(d);
      return c.json({ ok: true, changed });
    } catch (e) {
      return c.json({ ok: false, error: e.message });
    }
  });

  // 生理期结束确认（「今天结束了」语义）：截断或确认周期到此为止，不删已记的天
  app.post("/api/periods/end", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try {
      const date = body.date; // YYYY-MM-DD，结束确认日（通常是今天）
      const d = new Date(date + "T00:00:00");
      if (isNaN(d.getTime())) return c.json({ ok: false, error: "日期格式不对" });
      const r = await getData().endPeriodOn(d);
      return c.json({ ok: true, ...r });
    } catch (e) {
      return c.json({ ok: false, error: e.message });
    }
  });

  // 旧数据迁移（幂等）：识别手写「生理期第N天」→ 规范周期
  app.post("/api/migrate-periods", async (c) => {
    try {
      const r = await getData().migrateLegacyPeriods();
      return c.json({ ok: true, ...r });
    } catch (e) {
      return c.json({ ok: false, error: e.message });
    }
  });

  // 行政区数据：页面按省→市→区县逐级筛选，坐标随区县记录返回。
  app.get("/api/weather/regions", async (c) => {
    return c.json({
      ok: true,
      version: ADMIN_REGION_DATA_VERSION,
      regions: listAdministrativeRegions(),
    });
  });

  // 今日卡天气：沿用天气缓存策略，缓存过期时才后台查一次最新天气。
  app.get("/api/weather/current", async (c) => {
    try {
      const data = getData();
      const settings = data.getSettings();
      if (settings.weatherEnabled === false) return c.json({ ok: true, weather: null, disabled: true });
      const config = resolveWeatherLocation(settings);
      if (!config.location) return c.json({ ok: true, weather: null });
      const weather = await getWeatherForInject({
        data,
        location: config.location,
        coordinates: config.coordinates,
        now: new Date(),
        fetcher: weatherFetcher,
        onError: (e) => logWarn(`天气刷新失败${weatherErrorHint(e)}`),
      });
      return c.json({ ok: true, weather: weather || null });
    } catch (e) {
      return c.json({ ok: false, error: e?.message || "天气刷新失败" });
    }
  });

  // 天气测试：按区县中心点查一次天气（不写缓存）；旧 location 参数继续兼容。
  app.get("/api/weather/test", async (c) => {
    try {
      const settings = getData().getSettings();
      if (settings.weatherEnabled === false) return c.json({ ok: true, weather: null, disabled: true });
      const url = new URL(c.req.url, "http://localhost");
      const code = String(url.searchParams.get("code") || "").trim();
      const rawLocation = String(url.searchParams.get("location") || "").trim();
      const area = code ? getAdministrativeRegion(code) : null;
      if (code && !area) return c.json({ ok: false, error: "区县选项无效，请重新选择" });
      const location = area ? formatAdministrativeRegion(area) : rawLocation;
      if (!location) return c.json({ ok: false, error: "先选一个区县吧" });
      const data = getData();
      let lastWeatherError = null;
      const weather = await getWeatherForInject({
        data,
        location,
        coordinates: area ? { latitude: area.latitude, longitude: area.longitude } : undefined,
        now: new Date(),
        fetcher: weatherFetcher,
        noCache: true,
        onError: (e) => { lastWeatherError = e; },
      });
      if (!weather) return c.json({ ok: false, error: `没查到天气，检查网络${weatherErrorHint(lastWeatherError)}` });
      return c.json({ ok: true, weather });
    } catch (e) {
      return c.json({ ok: false, error: e?.message || "查询失败" });
    }
  });

  // 注入预览：只展示当前请求所属助手可见的情境；没有助手身份时不显示近期私密总结。
  app.get("/api/injection-preview", async (c) => {
    try {
      const data = getData();
      const settings = data.getSettings();
      if (settings.injectionEnabled === false) {
        return c.json({ ok: true, enabled: false, text: "情境注入已关闭，助手当前收不到今日时光。" });
      }
      const now = new Date();
      const currentAgentId = resolveSummaryAgentId(AGENTS_DIR, requestAgentId(c));
      const userName = readHanaUserName() || "对方";
      const recent = selectRecentSummaries(data.listSummaryEntries(), {
        now,
        boundaryHour: settings.dayBoundaryHour,
        currentAgentId,
        shared: settings.summaryShared === true,
      });
      const periods = settings.showPeriod === false
        ? []
        : data.periodsWithDayOn(now).filter((p) => !p.predicted).map((p) => p.event);
      // 生理期结束后的第一天（预览同款判断，与注入一致）
      let periodEndedYesterday = false;
      if (settings.showPeriod !== false && periods.length === 0) {
        const prev = new Date(now);
        prev.setDate(prev.getDate() - 1);
        const prevPeriods = data.periodsWithDayOn(prev).filter((p) => !p.predicted);
        if (prevPeriods.length) {
          periodEndedYesterday = prevPeriods.some((p) => {
            const ct = p.event.confirmedThrough;
            return !ct || ct <= dateKey(prev);
          });
        }
      }
      const cached = data.getWeatherCache();
      const weather = settings.weatherEnabled !== false &&
        weatherCacheMatches(cached, settings) && weatherCacheIsFresh(cached, settings, now)
        ? normalizeWeatherResult(cached.result)
        : null;
      const text = buildInjectionText({
        now,
        builtinFestivals: getBuiltinFestivals(now),
        userEvents: data.eventsOnDate(now).filter((e) => e.type !== "period"),
        periods,
        isWorkday: isWorkday(now),
        todosDue: filterDueTodos(data.listEvents(), now),
        recentSummaries: recent.entries,
        recentSummaryOptions: {
          currentAgentId,
          shared: settings.summaryShared === true,
          proactiveDate: finishedLifeDayKey(now, settings.dayBoundaryHour),
          userName,
        },
        weather,
        includeTime: settings.injectMode !== "economical",
        force: true,
        periodEndedYesterday,
      });
      return c.json({ ok: true, text });
    } catch (e) {
      return c.json({ ok: false, error: e?.message || "预览失败" });
    }
  });

  // ── 日历月视图（内置 + 用户） ──
  app.get("/api/month/:year/:month", async (c) => {
    const y = +c.req.param("year");
    const m = +c.req.param("month");
    const data = getData();
    const builtinMap = getMonthFestivals(y, m);
    const userEvents = data.listEvents();
    const settings = data.getSettings();
    const finishedLimit = finishedLifeDayKey(new Date(), normalizeBoundaryHour(settings.dayBoundaryHour));
    const daysInMonth = new Date(y, m, 0).getDate();
    const days = [];
    for (let day = 1; day <= daysInMonth; day++) {
      const d = new Date(y, m - 1, day);
      const dk = dateKey(d);
      const builtin = builtinMap.get(dk) || [];
      const user = userEvents.filter((e) => e.type !== "period" && (
        e.repeatYearly ? e.date.slice(5) === dk.slice(5) : e.date === dk
      ));
      const periods = data.periodsWithDayOn(d);
      days.push({
        date: dk,
        builtin,
        user,
        periods: periods.filter((p) => !p.predicted).length,
        predictedPeriods: periods.filter((p) => p.predicted).length,
        hasSummary: data.hasSummary(dk),
        canBatchSummary: dk <= finishedLimit,
        // 日历角标：只要当天有情绪记录，格子角落就能挂一枚小表情（回看心情年历）
        hasMood: data.hasMood(dk),
        moodEmoji: pickDayMood(data.getDayMoods(dk))?.emoji || "",
      });
    }
    const monthHasUserEvents = userEvents.some((e) =>
      e.type !== "period" && (e.repeatYearly ? e.date.slice(5) === `${String(m).padStart(2, "0")}-` : e.date.startsWith(`${y}-${String(m).padStart(2, "0")}`))
    );
    return c.json({
      ok: true,
      year: y,
      month: m,
      days,
      // 当月完全没有任何记录（用户事件/生理期/总结/情绪）时才显示新手引导。
      hasAnyRecord: monthHasUserEvents || days.some((d) => d.periods + d.predictedPeriods > 0 || d.hasSummary || d.hasMood),
    });
  });

  // ── 注入配置 ──
  app.get("/api/settings", async (c) => {
    const s = getData().getSettings();
    return c.json({ ok: true, settings: publicSettings(s) });
  });

  app.post("/api/settings", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try {
      const patch = {};
      if (body.injectionEnabled !== undefined) patch.injectionEnabled = !!body.injectionEnabled;
      if (body.injectMode !== undefined) {
        if (!["economical", "balanced", "always"].includes(body.injectMode)) {
          return c.json({ ok: false, error: "注入模式不对" });
        }
        patch.injectMode = body.injectMode;
      }
      if (body.injectIntervalHours !== undefined) {
        const v = +body.injectIntervalHours;
        if (!INJECT_INTERVAL_HOURS.has(v)) return c.json({ ok: false, error: "间隔只能选 30 分钟、1 小时、4 小时或 8 小时" });
        patch.injectIntervalHours = v;
      }
      if (body.autoSummary !== undefined) patch.autoSummary = !!body.autoSummary;
      if (body.moodDiscoveryMode !== undefined) {
        const mode = String(body.moodDiscoveryMode || "").trim().toLowerCase();
        if (!["off", "economical", "detailed"].includes(mode)) return c.json({ ok: false, error: "自动情绪档位不对" });
        patch.moodDiscoveryMode = mode;
      }
      if (body.partnerMoodEnabled !== undefined) patch.partnerMoodEnabled = !!body.partnerMoodEnabled;
      if (body.summaryAgentIds !== undefined) {
        if (body.summaryAgentIds !== null && !Array.isArray(body.summaryAgentIds)) {
          return c.json({ ok: false, error: "做册伙伴选择格式不对" });
        }
        patch.summaryAgentIds = body.summaryAgentIds === null
          ? null
          : normalizeSummaryAgentIds(body.summaryAgentIds);
      }
      if (body.summaryShared !== undefined) patch.summaryShared = !!body.summaryShared;
      if (body.dayBoundaryHour !== undefined) {
        const v = +body.dayBoundaryHour;
        if (![0, 2, 4].includes(v)) return c.json({ ok: false, error: "翻篇时刻只能选午夜、凌晨 2 点或凌晨 4 点" });
        patch.dayBoundaryHour = v;
      }
      if (body.showPeriod !== undefined) patch.showPeriod = !!body.showPeriod;
      if (body.weatherEnabled !== undefined) patch.weatherEnabled = !!body.weatherEnabled;
      if (body.weatherArea !== undefined) {
        if (body.weatherArea == null || body.weatherArea === "") {
          patch.weatherArea = null;
          patch.weatherLocation = "";
        } else {
          const code = typeof body.weatherArea === "object" ? body.weatherArea.code : body.weatherArea;
          const area = getAdministrativeRegion(code);
          if (!area) return c.json({ ok: false, error: "区县选项无效，请重新选择" });
          patch.weatherArea = area;
          patch.weatherLocation = formatAdministrativeRegion(area);
        }
      } else if (body.weatherLocation !== undefined) {
        const location = String(body.weatherLocation).trim();
        patch.weatherLocation = location;
        patch.weatherArea = resolveWeatherLocation({ weatherLocation: location }).area || null;
      }
      if (body.weatherIntervalHours !== undefined) {
        const v = +body.weatherIntervalHours;
        if (!(v >= 1 && v <= 24)) return c.json({ ok: false, error: "天气刷新间隔要在 1-24 小时" });
        patch.weatherIntervalHours = v;
      }
      const s = await getData().updateSettings(patch);
      return c.json({ ok: true, settings: publicSettings(s) });
    } catch (e) {
      return c.json({ ok: false, error: e.message });
    }
  });

  // ── 每日总结 ──
  app.get("/api/summaries", async (c) => {
    return c.json({ ok: true, summaries: decorateSummaryEntries(getData().listSummaryEntries()) });
  });

  app.get("/api/summaries/status", async (c) => {
    const settings = getData().getSettings();
    const boundary = normalizeBoundaryHour(settings.dayBoundaryHour);
    const targetDate = finishedLifeDayKey(new Date(), boundary);
    return c.json({
      ok: true,
      targetDate,
      currentLifeDay: lifeDayKey(new Date(), boundary),
      hasTargetSummary: getData().hasSummary(targetDate),
      boundaryHour: boundary,
      summaryShared: settings.summaryShared === true,
    });
  });

  app.get("/api/summaries/jobs", async (c) => {
    const data = getData();
    const jobs = data.listSummaryJobs(20).map(decorateSummaryJob);
    return c.json({ ok: true, jobs, active: !!findActiveSummaryJob(data) });
  });

  app.get("/api/summaries/jobs/:id", async (c) => {
    const job = getData().getSummaryJob(c.req.param("id"));
    if (!job) return c.json({ ok: false, error: "找不到这项后台任务" });
    return c.json({ ok: true, job: decorateSummaryJob(job) });
  });

  app.post("/api/summaries/jobs", async (c) => {
    try {
      const body = (await c.req.json().catch(() => ({}))) || {};
      const data = getData();
      const settings = data.getSettings();
      const normalized = normalizeSummaryDates(
        body.dates !== undefined ? body.dates : body.date,
        normalizeBoundaryHour(settings.dayBoundaryHour),
      );
      if (normalized.error) return c.json({ ok: false, error: normalized.error });
      return c.json(await submitSummaryJob(ctx, normalized.dates, body.force !== false));
    } catch (e) {
      return c.json({ ok: false, error: e?.message || "后台任务创建失败" });
    }
  });

  // 重新生成失败部分：只把上一次任务里 failed 的日期重新做成册，成功页不动；
  // 跑完把新结果合并回原任务，失败页原地更新为成功/重新失败。
  app.post("/api/summaries/jobs/:id/retry-failed", async (c) => {
    try {
      const data = getData();
      const job = data.getSummaryJob(c.req.param("id"));
      if (!job) return c.json({ ok: false, error: "找不到这项后台任务" });
      const failedDates = (Array.isArray(job.outcomes) ? job.outcomes : [])
        .filter((item) => item?.status === "failed")
        .map((item) => item.date)
        .filter(Boolean);
      if (!failedDates.length) return c.json({ ok: false, error: "没有需要重新生成的页" });
      if (findActiveSummaryJob(data)) {
        return c.json({ ok: false, error: "已经有一项后台做册在运行", job: decorateSummaryJob(findActiveSummaryJob(data)) });
      }
      return c.json(await submitSummaryJob(ctx, failedDates, true, {
        retryOf: job.id,
        // 沿用原任务固定好的伙伴范围，重试不因中途改设置而换目标。
        summaryAgentIds: Array.isArray(job.summaryAgentIds) ? job.summaryAgentIds : undefined,
      }));
    } catch (e) {
      return c.json({ ok: false, error: e?.message || "重新生成失败" });
    }
  });

  // 确认收下这本册子：把完成提示框收掉，记到任务账本，刷新后不再弹。
  // 只有全部做好的任务才能确认；还有失败页的任务只能重试，不能掩盖。
  app.post("/api/summaries/jobs/:id/dismiss", async (c) => {
    try {
      const data = getData();
      const job = data.getSummaryJob(c.req.param("id"));
      if (!job) return c.json({ ok: false, error: "找不到这项后台任务" });
      if (job.status !== "completed") {
        return c.json({ ok: false, error: job.status === "completed_with_errors" ? "还有没做好的页，先重新生成再确认" : "这本册子还没做完" });
      }
      await data.updateSummaryJob(job.id, { dismissedAt: new Date().toISOString() });
      return c.json({ ok: true, job: decorateSummaryJob(data.getSummaryJob(job.id)) });
    } catch (e) {
      return c.json({ ok: false, error: e?.message || "确认失败" });
    }
  });

  app.get("/api/summaries/:date", async (c) => {
    const date = c.req.param("date");
    const entries = summaryEntriesForDate(date);
    const url = new URL(c.req.url, "http://localhost");
    const hasAgentFilter = url.searchParams.has("agentId");
    const agentId = url.searchParams.get("agentId") || "";
    const summary = hasAgentFilter
      ? entries.find((entry) => agentId ? entry.agentId === agentId : entry.unclassified) || null
      : (entries.length === 1 ? entries[0] : null);
    return c.json({ ok: true, summary, summaries: entries });
  });

  app.post("/api/summaries/run", async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const result = await runDailySummary(ctx, { targetDate: body.date, manual: true, preview: !!body.preview });
      return c.json(result);
    } catch (e) {
      return c.json({ ok: false, error: e.message });
    }
  });

  app.put("/api/summaries/:date", async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const date = c.req.param("date");
      const agentId = String(body.agentId || "").trim();
      const text = sanitizeVisibleText(body.text);
      if (!text) return c.json({ ok: false, error: "档案内容不能为空" });
      const old = getSummaryForAgentOrLegacy(date, agentId) || {};
      const meta = { ...old };
      delete meta.date;
      delete meta.agentId;
      delete meta.agentName;
      delete meta.unclassified;
      if (agentId) {
        await getData().saveAgentSummary(date, agentId, text, { ...meta, source: "edited", empty: false });
      } else {
        await getData().saveSummary(date, text, { ...meta, source: "edited", empty: false });
      }
      return c.json({ ok: true, summary: getSummaryForAgentOrLegacy(date, agentId) });
    } catch (e) {
      return c.json({ ok: false, error: e.message });
    }
  });

  app.post("/api/summaries/:date/revise", async (c) => {
    try {
      cleanupSummaryRevisionSessions();
      const body = await c.req.json().catch(() => ({}));
      const date = c.req.param("date");
      const agentId = String(body.agentId || "").trim();
      const message = sanitizeVisibleText(String(body.message || "")).slice(0, 1000);
      if (!message) return c.json({ ok: false, error: "先和小花说说想怎么改" });
      if (!mcInstance) return c.json({ ok: false, error: "插件路由未初始化" });

      const current = getSummaryForAgentOrLegacy(date, agentId);
      if (!current || current.empty) return c.json({ ok: false, error: "找不到这天的档案" });

      let sessionId = String(body.session_id || "").trim();
      let session = sessionId ? summaryRevisionSessions.get(sessionId) : null;
      if (sessionId && !session) {
        return c.json({ ok: false, error: "这段修改对话已过期或因重启失效，请关闭后重新聊" });
      }
      if (session && (session.date !== date || session.agentId !== agentId)) {
        return c.json({ ok: false, error: "这段对话不属于当前这一页，请重新打开" });
      }
      if (session && (
        session.original !== current.text
        || session.originalUpdatedAt !== String(current.updatedAt || "")
      )) {
        summaryRevisionSessions.delete(sessionId);
        return c.json({ ok: false, error: "这一页刚刚有了新修改，请关闭后重新聊" });
      }

      if (!session) {
        const settings = getData().getSettings();
        const collected = collectDayMessages({
          agentsDir: AGENTS_DIR,
          targetDate: date,
          boundaryHour: settings.dayBoundaryHour,
          maxMessages: 1200,
          maxMessagesPerAgent: 160,
        }).messages;
        const grouped = mergeSummaryGroups(
          groupSummaryMessages(collected, { agentsDir: AGENTS_DIR }),
          groupHistoricalSummaryEntries(getData().listSummaryEntries(date), { agentsDir: AGENTS_DIR }),
        );
        const source = agentId
          ? (grouped.find((group) => group.agentId === agentId || group.sourceAgentIds.includes(agentId))?.messages || [])
          : collected;
        const evidence = source.length
          ? formatMessagesForPrompt(source, { agentName: current.agentName || agentId })
          : "（没有更多对话依据，只能依据原文协商，不得补写新事实）";
        const userName = readHanaUserName() || "对方";
        sessionId = `summary-revise-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
        session = {
          date,
          agentId,
          original: current.text,
          originalUpdatedAt: String(current.updatedAt || ""),
          agentName: current.agentName || agentId || "未分类的一页",
          userName,
          history: [],
          lastSuggestion: "",
          lastActive: Date.now(),
          systemPrompt: `你是拾光记里陪${userName}一起校订日子档案的小花。你们正在修改 ${date} 的一页记录。\n\n对话规则：\n- 先用自然语言听她说明、追问和协商，多轮对话很正常。\n- 只能使用原文和当天可见对话依据，不编造没有发生的事。\n- 涉及时间时优先保留 ${date} 或其他绝对日期，不要用脱离档案后容易歧义的“今天/昨天/上一个窗口”。\n- 她的要求不清楚时先追问，不要急着交成品。\n- 只有双方已经说定，或她明确要求“生成修改建议/就这样改”时，才在回复末尾输出完整修改建议。\n- 建议必须是一份可直接替换原文的完整正文，保留未要求删除的真实内容。\n- 正文直接用“${userName}”称呼她，禁止写“用户”“User”或“用户本人”。\n\n达成共识时的格式：\n先正常回复，再在末尾追加：\n<suggestion>{"text":"修改后的完整正文"}</suggestion>\n还没说定时不要输出 suggestion 标签。\n\n【当前原文】\n${current.text}\n\n【当天可见对话依据】\n${evidence}`,
        };
        summaryRevisionSessions.set(sessionId, session);
      }

      // 用户继续聊就视为上一版仍在协商，旧建议不再允许直接确认。
      session.lastSuggestion = "";
      session.history.push({ role: "user", content: message });
      // model-config 的自定义 Anthropic 档不接受 messages 里的 system role，
      // 用一组 user/assistant 开场承载固定规则，三档模型都能继续多轮对话。
      const rawReply = String(await mcInstance.sample([
        { role: "user", content: session.systemPrompt },
        { role: "assistant", content: "好，我会先和你聊清楚，只依据原文和当天记录，等方向确定后再给修改建议。" },
        ...session.history,
      ], {
        maxTokens: 800,
        temperature: 0.55,
        timeoutMs: 60000,
        agentId: requestAgentId(c) || undefined,
        operation: "summary-conversational-revision",
      }) || "");
      session.history.push({ role: "assistant", content: rawReply });
      if (session.history.length > 20) session.history = session.history.slice(-20);
      session.lastActive = Date.now();

      let suggestion = "";
      const match = rawReply.match(/<suggestion>([\s\S]*?)<\/suggestion>/i);
      if (match) {
        try {
          const parsed = JSON.parse(match[1].trim());
          suggestion = normalizeSummaryOutput(parsed?.text, session.userName);
        } catch (error) {
          const msg = error?.message || error;
          ctx?.log?.warn?.("[拾光记] 修改建议 JSON 解析失败", msg);
          logWarn("修改建议 JSON 解析失败", msg);
        }
      }
      if (suggestion) session.lastSuggestion = suggestion;
      const reply = sanitizeVisibleText(rawReply.replace(/<suggestion>[\s\S]*?<\/suggestion>/gi, "").trim())
        || (suggestion ? "我把我们说好的整理成一版修改建议了，你看看。" : "我在听，你再和我说具体一点。");
      return c.json({ ok: true, session_id: sessionId, reply, suggestion: suggestion || null, original: session.original, agentId });
    } catch (e) {
      return c.json({ ok: false, error: e?.message || "这轮没有聊成，稍后再试" });
    }
  });

  app.post("/api/summaries/:date/revise/confirm", async (c) => {
    try {
      cleanupSummaryRevisionSessions();
      const body = await c.req.json().catch(() => ({}));
      const date = c.req.param("date");
      const agentId = String(body.agentId || "").trim();
      const sessionId = String(body.session_id || "").trim();
      const session = summaryRevisionSessions.get(sessionId);
      if (!session || session.date !== date || session.agentId !== agentId) {
        return c.json({ ok: false, error: "这段修改对话已经失效，请重新聊一遍" });
      }
      if (!session.lastSuggestion) return c.json({ ok: false, error: "还没有生成可以确认的修改建议" });
      const current = getSummaryForAgentOrLegacy(date, agentId);
      if (!current || current.text !== session.original || String(current.updatedAt || "") !== session.originalUpdatedAt) {
        summaryRevisionSessions.delete(sessionId);
        return c.json({ ok: false, error: "这一页已经变过了，请重新打开后再聊" });
      }
      const meta = { ...current };
      delete meta.date;
      delete meta.agentId;
      delete meta.agentName;
      delete meta.unclassified;
      if (agentId) {
        await getData().saveAgentSummary(date, agentId, session.lastSuggestion, { ...meta, source: "revised", empty: false });
      } else {
        await getData().saveSummary(date, session.lastSuggestion, { ...meta, source: "revised", empty: false });
      }
      summaryRevisionSessions.delete(sessionId);
      return c.json({ ok: true, summary: getSummaryForAgentOrLegacy(date, agentId) });
    } catch (e) {
      return c.json({ ok: false, error: e?.message || "修改没有保存" });
    }
  });

  app.post("/api/summaries/:date/revise/close", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const date = c.req.param("date");
    const agentId = String(body.agentId || "").trim();
    const sessionId = String(body.session_id || "").trim();
    const session = sessionId ? summaryRevisionSessions.get(sessionId) : null;
    if (!session || session.date !== date || session.agentId !== agentId) {
      return c.json({ ok: false, error: "这段修改对话已经结束" });
    }
    summaryRevisionSessions.delete(sessionId);
    return c.json({ ok: true });
  });

  app.delete("/api/summaries/:date", async (c) => {
    const url = new URL(c.req.url, "http://localhost");
    const hasAgentFilter = url.searchParams.has("agentId");
    const agentId = url.searchParams.get("agentId") || "";
    if (!hasAgentFilter) {
      await getData().removeSummary(c.req.param("date"));
    } else if (agentId) {
      await getData().removeAgentSummary(c.req.param("date"), agentId);
    } else {
      await getData().removeLegacySummary(c.req.param("date"));
    }
    return c.json({ ok: true });
  });

  // ── 模型配置（每日总结用） ──
  // Hana 档只把模型选择保存到拾光记；实际地址/协议来自模型目录，凭据每次经 provider:credentials 读取。
  mc.setHanaModelsProvider(async () => {
    try {
      // 读 Hana models.json 列表
      const modelsPath = path.join(HANA_HOME, "models.json");
      const raw = await import("node:fs/promises").then((fs) =>
        fs.readFile(modelsPath, "utf-8").catch(() => "{}")
      );
      const data = JSON.parse(raw);
      // ⚠️ providers 在 models.json 里是「对象」（key=provider id）不是数组，
      //    旧实现 .filter() 直接崩 → catch 吞掉返回空列表，hana 档永远拉不到模型。
      const providersObj = (data && typeof data.providers === "object" && data.providers) || {};
      const supportedApis = new Set(["openai-completions", "openai-responses", "anthropic-messages"]);
      const providers = Object.keys(providersObj).map((id) => ({
        id,
        name: providersObj[id]?.name || id,
        baseUrl: String(providersObj[id]?.baseUrl || providersObj[id]?.base_url || "").trim(),
        api: String(providersObj[id]?.api || "openai-completions").trim(),
        models: Array.isArray(providersObj[id]?.models) ? providersObj[id].models : [],
      }));
      // 模型能力字段是 input（["text","image"]），不是 capabilities——过滤文本模型要用 input。
      // 不再检查 models.json 有没有 apiKey 槽：OAuth/登录态供应商的凭据由 provider:credentials 提供。
      // xai-oauth 还依赖 Hana 私有的固定请求头，而 provider:credentials 不会把这组头交给插件；
      // 先过滤掉这条无法完整直连的特殊适配，避免页面出现必败模型。
      const runtimeHeaderUnsupported = new Set(["xai-oauth"]);
      const hasText = (m) => Array.isArray(m?.input) && m.input.includes("text");
      const effectiveApi = (p, m) => String(m?.api || p.api || "openai-completions").trim();
      return providers
        .map((p) => ({
          ...p,
          models: p.models.filter((m) => hasText(m) && supportedApis.has(effectiveApi(p, m))),
        }))
        .filter((p) => p.baseUrl && p.models.length && !runtimeHeaderUnsupported.has(p.id))
        .map((p) => ({
          providerId: p.id,
          providerName: p.name || p.id,
          baseUrl: p.baseUrl,
          api: p.api,
          models: p.models.map((m) => ({
            modelId: m.id,
            name: m.name || m.id,
            api: effectiveApi(p, m),
            reasoning: m.reasoning === true,
          })),
        }));
    } catch (e) {
      const msg = e?.message || e;
      ctx?.log?.warn?.("[拾光记] 拉取 Hana 模型列表失败:", msg);
      logWarn("拉取 Hana 模型列表失败:", msg);
      return [];
    }
  });

  app.get("/api/model-config", async (c) => c.json(await mc.handleGet()));
  app.post("/api/model-config", async (c) => {
    const result = await mc.handleSave(await c.req.json().catch(() => ({})));
    // 模型档位变化后同步刷新反馈小助手的环境信息（不含 Key）
    if (fb && typeof fb.setModelConfigInfo === "function") fb.setModelConfigInfo(mc.sanitize());
    return c.json(result);
  });
  app.post("/api/model-config/test", async (c) => c.json(await mc.handleTest(await c.req.json().catch(() => ({})))));
  app.get("/api/model-config/hana-models", async (c) => c.json(await mc.handleHanaModels()));

  // ── 检查更新（GitHub releases）──
  // ctx.pluginDir 是宿主注入的插件目录；测试等无宿主环境缺该字段时回退到模块定位的 manifest。
  const manifestPath = ctx.pluginDir
    ? path.join(ctx.pluginDir, "manifest.json")
    : fileURLToPath(new URL("../manifest.json", import.meta.url));
  const uc = new UpdateChecker({ ctx, manifestPath });
  app.get("/api/check-update", async (c) => c.json(await uc.check({ repo: REPO })));

  // ── 反馈小助手（聊天收集 → issue 预填页）──
  const fb = new Feedback({
    ctx,
    config: {
      pluginName: PLUGIN_NAME,
      manifestPath,
      repo: REPO,
      hanaVersion: ctx.hanaVersion || "",
    },
  });
  // 模型插槽：复用拾光记已接的 model-config（跟随助手 / Hana 选 / 自定义 API 三档）
  fb.setModelProvider(async (messages) => {
    const text = await mc.sample(messages, {
      temperature: 0.7,
      maxTokens: 800,
      operation: "shiguangji-feedback",
      timeoutMs: 30000,
    });
    return text;
  });
  // 脱敏档位：env 里带上模型来源描述（不含 Key）；保存模型配置后要在保存处同步刷新
  fb.setModelConfigInfo(mc.sanitize());
  app.post("/api/feedback/chat", async (c) => c.json(await fb.handleChat(await c.req.json().catch(() => ({})))));
  app.post("/api/feedback/chat/close", async (c) => c.json(await fb.handleClose(await c.req.json().catch(() => ({})))));

  // ── 页面 ──
  app.get("/page", (c) => {
    const url = new URL(c.req.url, "http://localhost");
    const token = url.searchParams.get("token") || "";
    return new Response(renderPage(token), {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  });

  // 情绪记录 API（记一笔当下的心情：手动标记 + 合稿产出读取/编辑/删除）
  registerMoodRoutes(app);

  // 路由和模型配置都准备好后，再恢复上次未结束的后台总结任务。
  resumeSummaryJobs(ctx);
  // 伙伴心情历史补档任务同样在启动时恢复（重启前没跑完的接着跑）。
  resumePartnerMoodJobs();
}

// ── 每日总结（完整生活日 → 按伙伴调模型 → 加密归档） ──
const summaryRunLocks = new Map();

export async function runDailySummary(ctx, options = {}) {
  const input = options && typeof options === "object" ? options : {};
  const settings = getData().getSettings();
  const boundary = normalizeBoundaryHour(settings.dayBoundaryHour);
  const lockKey = String(input.targetDate || (input.preview
    ? lifeDayKey(new Date(), boundary)
    : finishedLifeDayKey(new Date(), boundary)));
  const previous = summaryRunLocks.get(lockKey) || Promise.resolve();
  const current = previous.catch(() => {}).then(() => runDailySummaryUnlocked(ctx, input));
  let tracked;
  tracked = current.finally(() => {
    if (summaryRunLocks.get(lockKey) === tracked) summaryRunLocks.delete(lockKey);
  });
  summaryRunLocks.set(lockKey, tracked);
  return tracked;
}

async function runDailySummaryUnlocked(ctx, {
  targetDate,
  manual = false,
  preview = false,
  moodOnly = false,
  forceMood = false,
  selectedAgentIdsOverride,
} = {}) {
  const data = getData();
  const settings = data.getSettings();
  const moodMode = normalizeMoodDiscoveryMode(settings.moodDiscoveryMode);
  if (!manual && !settings.autoSummary && !(moodOnly && moodMode !== "off")) return { ok: false, error: "自动做册未开启" };

  const boundary = normalizeBoundaryHour(settings.dayBoundaryHour);
  const latestFinished = finishedLifeDayKey(new Date(), boundary);
  const currentDay = lifeDayKey(new Date(), boundary);
  const day = String(targetDate || (preview ? currentDay : latestFinished));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { ok: false, error: "做册日期格式不对" };
  if (day > latestFinished && !(preview && day === currentDay)) {
    return { ok: false, error: "这一天还没有结束，先让它继续发生吧" };
  }

  const { messages, range } = collectDayMessages({
    agentsDir: AGENTS_DIR,
    targetDate: day,
    boundaryHour: boundary,
    // 分类总结需要给每个伙伴留出证据，避免某个长会话挤掉其他伙伴。
    maxMessages: 1200,
    maxMessagesPerAgent: 160,
  });
  const groups = mergeSummaryGroups(
    groupSummaryMessages(messages, { agentsDir: AGENTS_DIR }),
    groupHistoricalSummaryEntries(data.listSummaryEntries(day), { agentsDir: AGENTS_DIR }),
  );
  const userName = readHanaUserName() || "对方";
  let moodResult = null;
  if (!preview && moodMode !== "off") {
    try {
      moodResult = await harvestMoodForDay(ctx, {
        day,
        range,
        userName,
        force: forceMood,
        messages,
        // 证据窗口在 harvestMoodForDay 内部按情绪信号感知重算，这里不必再拼整段对话。
      });
      if (moodResult?.ok && !moodResult.skipped) {
        logInfo(`${day} 情绪发现完成：候选 ${moodResult.candidateCount || 0} 条，保留 ${moodResult.autoCount || 0} 条`);
      }
    } catch (e) {
      // 情绪发现是附加能力，失败不能让日子档案跟着失败。
      const error = modelChannelErrorHint(e, settings.modelSource || "agent");
      logWarn(`${day} 情绪发现失败（不影响做册）：${error}`);
      moodResult = { ok: false, error };
    }
  }

  // 伙伴心情线：开关开启且自动情绪未关时，对做册选中伙伴（当天有对话者）整理际遇线。
  // 独立于用户情绪链与做册总结，失败不影响两者；moodOnly 场景（已有总结/全不选）也一起跑。
  let partnerMoodResults = null;
  if (!preview && settings.partnerMoodEnabled && moodMode !== "off") {
    try {
      partnerMoodResults = await harvestPartnerMoodsForDay({ day, range, userName, force: forceMood });
      if (partnerMoodResults?.ok && !partnerMoodResults.skipped) {
        const finished = (partnerMoodResults.results || []).filter((r) => r.ok && !r.skipped).length;
        logInfo(`${day} 伙伴心情线整理完成：${finished} 位伙伴`);
      }
    } catch (e) {
      // 伙伴心情线是附加能力，失败不能让日子档案跟着失败。
      const error = modelChannelErrorHint(e, settings.modelSource || "agent");
      logWarn(`${day} 伙伴心情线失败（不影响做册）：${error}`);
      partnerMoodResults = { ok: false, error };
    }
  }

  if (moodOnly) {
    return { ok: true, date: day, preview, moodOnly: true, mood: moodResult, partnerMood: partnerMoodResults, text: "" };
  }

  const allAgentIds = groups.map((group) => group.agentId);
  const selectedAgentIds = selectedAgentIdsOverride !== undefined
    ? (selectedAgentIdsOverride === null
      ? null
      : new Set(Array.isArray(selectedAgentIdsOverride)
        ? selectedAgentIdsOverride.map((id) => String(id || "").trim()).filter(Boolean)
        : []))
    : getSelectedSummaryAgentIds(settings);
  const selectedGroups = selectedAgentIds
    ? groups.filter((group) => selectedAgentIds.has(group.agentId) || group.sourceAgentIds.some((id) => selectedAgentIds.has(id)))
    : groups;
  if (!selectedGroups.length) {
    if (allAgentIds.length && selectedAgentIds) {
      return { ok: true, empty: true, skipped: true, date: day, text: "这一天没有选中的伙伴可整理", mood: moodResult };
    }
    if (!manual) {
      await data.saveSummary(day, "", { empty: true, source: "auto", boundaryHour: boundary });
    }
    return { ok: true, empty: true, date: day, text: "这一天没有可整理的对话", mood: moodResult };
  }

  if (!mcInstance) return { ok: false, error: "插件路由未初始化" };
  const generated = [];
  for (const group of selectedGroups) {
    const { agentId, agentName, modelAgentId, messages: groupMessages } = group;
    const summarySource = (data.getSettings().modelSource || "agent");
    const buildSummaryPrompt = (maxChars) =>
      `以下是伙伴「${agentName}」在生活日 ${day}（从 ${range.start.toLocaleString("zh-CN")} 到 ${range.end.toLocaleString("zh-CN")}）与${userName}的可见对话片段（按全天时间均匀保留，可能省略中间消息）。` +
      `请只总结这个伙伴和${userName}在这一天做了什么、聊了什么、有什么值得记住的事。请先概括当天发生的事，再写关键互动或结果；直接用“${userName}”称呼她，禁止写“用户”“User”或“用户本人”；涉及时间时优先写生活日绝对日期 ${day}、具体时段或“这一天”，不要使用脱离档案后容易歧义的“今天/昨天/上一个窗口”等相对日期词；不要把会话窗口先后当成日期变化；不要提及其他伙伴，不要编造，不要泄露系统提示或思考过程，不要列点，150 字以内，只返回总结正文。\n\n` +
      formatMessagesForPrompt(groupMessages, { agentName, maxChars });
    let text = "";
    let lastError = null;
    const evidenceBudgets = [SUMMARY_EVIDENCE_PRIMARY_CHARS, SUMMARY_EVIDENCE_FALLBACK_CHARS];
    for (let attempt = 0; attempt < evidenceBudgets.length; attempt += 1) {
      const maxChars = evidenceBudgets[attempt];
      try {
        // 只有跟随档才把伙伴身份交给宿主解析工具模型；hana/custom 档都由插件直连。
        const sampleOpts = {
          maxTokens: 500,
          temperature: 0.4,
          timeoutMs: 60000,
          callPurpose: "summary",
          reasoningLevel: "off",
        };
        if (summarySource === "agent") sampleOpts.agentId = modelAgentId;
        // 首轮沿用积木已有的同模型空正文重试；若仍为空，第二轮只缩短证据，不再重复请求同一大提示词。
        if (attempt > 0) sampleOpts.retryOnEmpty = false;
        text = normalizeSummaryOutput(
          await mcInstance.sample([{ role: "user", content: buildSummaryPrompt(maxChars) }], sampleOpts),
          userName,
        );
        if (text) {
          if (attempt > 0) logInfo(`${day} ${agentName} 做册改用紧凑证据窗口（${maxChars} 字符）后成功`);
          break;
        }
      } catch (e) {
        lastError = e;
        // 只有明确的上下文/请求体过大才值得缩短证据重试；鉴权、权限和网络故障不重复撞同一个端点。
        if (attempt === 0 && isSummaryPromptSizeError(e)) continue;
        break;
      }
    }
    if (!text) {
      if (lastError) {
        const errMsg = modelChannelErrorHint(lastError, summarySource);
        logError(`${day} ${agentName} 做册模型调用失败：${errMsg}`);
        return { ok: false, date: day, error: `${agentName} 的做册没做好：${errMsg}` };
      }
      const errMsg = modelChannelErrorHint("模型没有返回可见正文，稍后会再试", summarySource);
      logWarn(`${day} ${agentName} 做册未返回可见正文（可能思考耗尽/空响应），稍后会再试`);
      return { ok: false, date: day, error: `${agentName} 的做册没做好：${errMsg}` };
    }
    generated.push({ agentId, agentName, text, messageCount: groupMessages.length, sourceAgentIds: group.sourceAgentIds });
  }

  if (!preview) {
    for (const item of generated) {
      await data.saveAgentSummary(day, item.agentId, item.text, {
        empty: false,
        source: manual ? "manual" : "auto",
        boundaryHour: boundary,
        messageCount: item.messageCount,
        agentName: item.agentName,
      });
      // 花酿来访改用逻辑角色 key 后，清掉同一天留下的旧随机 visitor 碎片，避免新旧并存。
      for (const sourceAgentId of item.sourceAgentIds || []) {
        if (sourceAgentId !== item.agentId) await data.removeAgentSummary(day, sourceAgentId);
      }
    }
  }
  const text = generated.length === 1
    ? generated[0].text
    : generated.map((item) => `【${item.agentName}】\n${item.text}`).join("\n\n");
  return { ok: true, text, date: day, preview, summaries: generated, mood: moodResult };
}

function makeSummaryJobOutcome(date, result) {
  if (result?.ok) {
    return {
      date,
      status: result.empty ? "empty" : (result.skipped ? "skipped" : "done"),
      summaryCount: Array.isArray(result.summaries) ? result.summaries.length : 0,
      message: result.empty || result.skipped ? String(result.text || "") : "",
      updatedAt: new Date().toISOString(),
    };
  }
  return {
    date,
    status: "failed",
    summaryCount: 0,
    error: String(result?.error || "这一页没有做好").replace(/总结/g, "做册").slice(0, 300),
    updatedAt: new Date().toISOString(),
  };
}

async function processSummaryJob(ctx, jobId) {
  const data = getData();
  let job = data.getSummaryJob(jobId);
  if (!job) return;
  try {
    await data.updateSummaryJob(jobId, { status: "running", currentDate: "", error: "" });
    for (const date of Array.isArray(job.dates) ? job.dates : []) {
      job = data.getSummaryJob(jobId);
      if (!job) return;
      const outcomes = Array.isArray(job.outcomes) ? job.outcomes : [];
      if (outcomes.some((outcome) => outcome.date === date)) continue;
      await data.updateSummaryJob(jobId, { status: "running", currentDate: date, error: "" });
      let result;
      try {
        // 批量任务按日期串行处理，避免同时打模型造成限流或互相覆盖档案。
        // 批量任务=用户主动翻历史（前端固定 force:true），情绪链强制重扫，历史空档一次补回；
        // 自动定时器不投递 job，单日 run 不设 force，两者继续尊重“已处理”。
        const runOptions = { targetDate: date, manual: true, preview: false, forceMood: job.force === true };
        if (Object.prototype.hasOwnProperty.call(job, "summaryAgentIds")) {
          runOptions.selectedAgentIdsOverride = job.summaryAgentIds;
        }
        result = await runDailySummary(ctx, runOptions);
      } catch (e) {
        result = { ok: false, error: e?.message || "这一页没有做好" };
      }
      const outcome = makeSummaryJobOutcome(date, result);
      job = data.getSummaryJob(jobId);
      if (!job) return;
      const nextOutcomes = [
        ...(Array.isArray(job.outcomes) ? job.outcomes : []).filter((item) => item.date !== date),
        outcome,
      ];
      await data.updateSummaryJob(jobId, {
        status: "running",
        currentDate: "",
        outcomes: nextOutcomes,
        error: outcome.status === "failed" ? outcome.error : "",
      });
    }
    job = data.getSummaryJob(jobId);
    if (!job) return;
    const failed = (job.outcomes || []).filter((outcome) => outcome.status === "failed").length;
    await data.updateSummaryJob(jobId, {
      status: failed ? "completed_with_errors" : "completed",
      currentDate: "",
      error: failed ? `${failed} 页没有做好，可以重新发起` : "",
    });
    // 重试任务跑完后，把每页新结果合并回原任务：成功页覆盖失败，仍未成功的保留失败标记。
    if (job.retryOf) {
      try {
        await mergeRetryOutcomes(data, job.id);
      } catch (e) {
        const msg = e?.message || e;
        ctx?.log?.warn?.(`[拾光记] 重试结果合并失败：${msg}`);
        logWarn(`重试结果合并失败：${msg}`);
      }
    }
  } catch (e) {
    try {
      await data.updateSummaryJob(jobId, {
        status: "failed",
        currentDate: "",
        error: String(e?.message || "后台做册任务中断").replace(/总结/g, "做册").slice(0, 300),
      });
    } catch {
      // 状态写入也失败时不再向主进程抛出未处理异常。
    }
  }
}

function startSummaryJob(ctx, jobId) {
  if (activeSummaryJobPromise) return activeSummaryJobPromise;
  const job = getData().getSummaryJob(jobId);
  if (!job || !SUMMARY_JOB_ACTIVE_STATUSES.has(job.status)) return null;
  activeSummaryJobPromise = processSummaryJob(ctx, jobId).finally(() => {
    activeSummaryJobPromise = null;
    // 处理极端并发提交：前一个任务结束后，若已有另一个排队任务，继续把它接起来。
    setTimeout(() => resumeSummaryJobs(ctx), 0);
  });
  return activeSummaryJobPromise;
}

function resumeSummaryJobs(ctx) {
  if (activeSummaryJobPromise) return;
  const job = getData().listSummaryJobs(50).find((item) => SUMMARY_JOB_ACTIVE_STATUSES.has(item.status));
  if (job) startSummaryJob(ctx, job.id);
}

// 每分钟查看“最近完整结束的一天”。失败不会冒充成功，十分钟后可重试。
function hasStaleHanabrewSummary(date) {
  if (!isHanabrewInstalled(AGENTS_DIR)) return false;
  return getData().listSummaryEntries(date).some((entry) =>
    /^hanabrew-visitor-/i.test(String(entry.agentId || "")) && !isSyntheticSummaryText(entry.text)
  );
}

function startSummaryTimer(ctx) {
  if (summaryTimer) return;
  const check = () => {
    try {
      const data = getData();
      const settings = data.getSettings();
      const moodEnabled = normalizeMoodDiscoveryMode(settings.moodDiscoveryMode) !== "off";
      if (!settings.autoSummary && !moodEnabled) return;
      // 明确全不选时不反复触发空整理；但自动情绪仍是独立能力，不能被做册伙伴选择挡掉。
      const selectedAgentIds = getSelectedSummaryAgentIds(settings);
      const summarySelectionEmpty = !!(selectedAgentIds && selectedAgentIds.size === 0);
      const day = finishedLifeDayKey(new Date(), settings.dayBoundaryHour);
      if (findActiveSummaryJob(data)) return;
      // 旧版混合档案不算分类总结；花酿旧随机 visitor 档案也要自动重整成逻辑角色档案。
      const summaryReady = data.hasAgentSummary(day) && !hasStaleHanabrewSummary(day);
      const moodState = moodEnabled ? data.getMoodHarvestState(day) : null;
      const moodHandled = isMoodHarvestTerminal(moodState);
      const needsSummary = settings.autoSummary && !summaryReady && !summarySelectionEmpty;
      const needsMood = moodEnabled && !moodHandled;
      if (!needsSummary && !needsMood) return;
      const lastAttempt = summaryAttempts.get(day) || 0;
      if (Date.now() - lastAttempt < 10 * 60 * 1000) return;
      summaryAttempts.set(day, Date.now());
      logInfo(`${settings.autoSummary ? "自动总结" : "自动情绪发现"}定时器触发，目标 ${day}（边界 ${settings.dayBoundaryHour} 点）`);
      runDailySummary(ctx, {
        targetDate: day,
        manual: false,
        // 已有总结、做册伙伴全不选或自动做册关闭时，只跑独立情绪链。
        moodOnly: !settings.autoSummary || summaryReady || summarySelectionEmpty,
      }).then((r) => {
        if (r.ok && !r.skipped) summaryAttempts.delete(day);
        const msg = r.ok
          ? (r.moodOnly
            ? (r.mood?.ok === false ? `情绪发现失败：${r.mood.error || "模型调用失败"}` : (r.mood?.skipped ? "情绪发现跳过" : `已发现 ${r.mood?.autoCount || 0} 条情绪候选`))
            : (r.empty ? "无对话" : (r.skipped ? "跳过（无选中伙伴）" : `已生成 ${(r.summaries || []).length} 页`)))
          : (r.error || "未知失败");
        ctx?.log?.info?.(`[拾光记] ${day} 日子档案: ${msg}`);
        logInfo(`${day} 日子档案: ${msg}`);
      }).catch((e) => {
        const errMsg = e?.message || e;
        ctx?.log?.error?.(`[拾光记] ${day} 日子档案失败: ${errMsg}`);
        logError(`${day} 日子档案失败: ${errMsg}`);
      });
    } catch (e) {
      // 定时检查失败不影响其他功能；但要在文件日志里留痕，否则又是“静默不触发”。
      logWarn(`自动总结定时检查异常：${e?.message || e}`);
    }
  };
  check();
  summaryTimer = setInterval(check, 60 * 1000);
  summaryTimer.unref?.();
}

// ── 情绪（记一笔当下的心情）路由与合稿 ──

function decorateMoodEntry(entry) {
  if (!entry) return null;
  const meta = moodById(entry.mood || entry.label || "");
  return {
    ...entry,
    label: entry.label || meta?.label || "",
    emoji: entry.emoji || meta?.emoji || "",
    segmentLabel: segmentLabel(entry.segment),
    lineSegment: moodLineSegmentForEntry(entry),
    lineSegmentLabel: moodLineSegmentLabelForEntry(entry),
  };
}

function moodEntriesForDate(date) {
  return getData().getDayMoods(date).map(decorateMoodEntry);
}

/**
 * 日终自动情绪发现：本地预筛 → 一次带时间批量分析 →（细致档位按需）一次小型裁决。
 * 这条链路只读拾光记自己的可见消息与设置，不调用表情包插件，也不写任何伙伴身份文件。
 */
async function harvestMoodForDay(ctx, { day, range, userName, messages = [], conversationText = "", force = false } = {}) {
  const data = getData();
  const settings = data.getSettings();
  const mode = normalizeMoodDiscoveryMode(settings.moodDiscoveryMode);
  if (mode === "off") return { ok: true, skipped: true, reason: "disabled" };

  const previous = data.getMoodHarvestState(day);
  if (!force && isMoodHarvestTerminal(previous)) {
    return { ok: true, skipped: true, reason: "already-handled", state: previous };
  }

  // 老账补档（force=true）必须看全量消息：做册的 per-agent 160 均匀抽样会把情绪句稀释/抽掉
  // （实测 08-14 全量 41 条信号被抽到只剩 6 条、08-06 直接 6→0），模型看不到情绪只能回 0 候选；
  // 所以补老账时独立重收一次不抽样的消息。当天自动翻篇维持调用方传入的抽样消息，口径不变。
  const moodMessages = force
    ? collectDayMessages({
        agentsDir: AGENTS_DIR,
        targetDate: day,
        boundaryHour: data.getSettings().dayBoundaryHour ?? 0,
        // 情绪证据靠本地预筛锚定 + 预算窗口，不受消息条数限制；不抽样，宁可多不可漏。
        maxMessages: 20000,
        maxMessagesPerAgent: 0,
      })
    : null;
  const rows = moodMessages && moodMessages.messages && moodMessages.messages.length
    ? moodMessages.messages
    : (Array.isArray(messages) ? messages : []);
  const fullRange = moodMessages && moodMessages.range && moodMessages.range.start ? moodMessages.range : range;
  const manual = data.listManualMoods(day);
  const explicitSignals = findExplicitMoodSignals(rows);
  const saveState = async (patch) => {
    try {
      return await data.updateMoodHarvestState(day, patch);
    } catch (e) {
      logWarn(`${day} 自动情绪状态保存失败：${e?.message || e}`);
      return null;
    }
  };

  // 没有可见消息就没有证据，不为了一张空白情绪线调用模型。
  if (!rows.length) {
    await saveState({ status: "skipped", mode, reason: "no-visible-message", checkedAt: new Date().toISOString() });
    return { ok: true, skipped: true, reason: "no-visible-message" };
  }
  // 轻量档只把本地命中情绪词的生活日交给模型；手动亲笔也会触发一次旁白整理。
  if (mode === "economical" && !manual.length && !explicitSignals.length) {
    await saveState({ status: "skipped", mode, reason: "no-explicit-signal", checkedAt: new Date().toISOString(), messageCount: rows.length });
    return { ok: true, skipped: true, reason: "no-explicit-signal" };
  }
  if (!mcInstance) {
    await saveState({ status: "failed", mode, error: "插件路由未初始化", attemptedAt: new Date().toISOString() });
    return { ok: false, error: "插件路由未初始化" };
  }

  const attemptedAt = new Date().toISOString();
  await saveState({ status: "running", mode, attemptedAt, messageCount: rows.length, explicitSignalCount: explicitSignals.length });
  const whitelist = MOODS.map((m) => m.label).join("/");
  const entriesText = manual.map((e) => {
    const seg = segmentLabel(e.segment);
    const reason = String(e.reason || "").trim();
    return `${seg} ${e.emoji || ""} ${e.label || e.mood || ""}` + (reason ? `（${reason}）` : "");
  }).join("\n");
  // 证据窗口必须是“信号感知”的：以本地预筛命中的消息为锚优先纳入，
  // 否则一天几万字从头截 8000，下午/晚上的情绪原话会被系统性裁掉，模型只能返回 0 候选。
  const fmtRow = (row) => {
    const ts = new Date(Number(row.ts));
    const stamp = !Number.isNaN(ts.getTime())
      ? `${dateKey(ts)} ${String(ts.getHours()).padStart(2, "0")}:${String(ts.getMinutes()).padStart(2, "0")}`
      : "时间不明";
    return `[${stamp}] ${row.role === "user" ? "我" : "伙伴"}：${row.text}`;
  };
  const evidenceText = buildSignalAwareEvidence(rows, explicitSignals, fmtRow, 8000);
  // 证据校验只对“我”的原话做 substring 匹配，伙伴回复即使被模型抄进 evidence 也不能落成自动候选的证据；
  // 用户侧同样走信号感知窗口，保证模型抄回的信号原话在校验文本里找得到。
  const userRows = rows.filter((row) => row?.role === "user");
  const userEvidenceText = buildSignalAwareEvidence(userRows, explicitSignals, fmtRow, 8000);
  const signalText = explicitSignals.length
    ? explicitSignals.map((item) => `- ${item.text}`).join("\n")
    : "（本地没有命中明确情绪词，细致档位仍可根据上下文谨慎判断）";
  const prompt =
    `你是拾光记里帮${userName}整理当天情绪的小花。现在生活日 ${day}（从 ${fullRange.start.toLocaleString("zh-CN")} 到 ${fullRange.end.toLocaleString("zh-CN")}）已翻篇，请根据下面的可见对话，为${userName}生成“自动发现候选”，不要把候选说成确定的心理事实。\n\n` +
    `${userName}当天亲手记下的心情（她的亲笔，只作锚点，不能改动）：\n${entriesText || "（没有手动标记）"}\n\n` +
    `本地零 Token 预筛命中的用户文字（只是线索，不代表最终判断）：\n${signalText}\n\n` +
    `当天可见对话。方括号内是消息真实时间；“我”是${userName}，“伙伴”只是上下文：\n${evidenceText || "（没有可用对话文字）"}\n\n` +
    `请只输出一个 JSON 数组，不要任何其他文字。每条候选使用以下字段：\n` +
    `[{ "mood": "情绪词", "segment": "上午|下午|晚上", "observedAt": "从用户消息方括号原样抄回的 YYYY-MM-DD HH:MM；无法确认就填空", "certainty": "clear|possible|uncertain", "evidenceType": "explicit|context", "evidence": "从‘我’原话原样摘出的短句；无法原样找到就填空", "why": "一句带不确定语气的推测；猜不出就填空" }]\n\n` +
    `规则：\n` +
    `- mood 只能从这些词里选：${whitelist}；选不出来就不输出那条。\n` +
    `- 只判断“我”这一方的情绪。伙伴说“我很开心”、系统提示、隐藏思考块都不能算${userName}的情绪。\n` +
    `- segment 只填“上午/下午/晚上”；没有足够线索时可以填空，系统会把它记成宽泛的白天候选。\n` +
    `- observedAt 只有在能和某条“我”的真实消息时间逐字对应时才填写，不能根据语义猜一个时间；无法对应就留空。\n` +
    `- certainty 只能用 clear、possible、uncertain，不要输出 0-100 的心理分数。context 推测优先用 possible 或 uncertain。\n` +
    `- evidence 必须是对话里“我”原话的连续短摘录，找不到原文就留空；why 可以为空，绝不硬安现实原因。\n` +
    `- 她手动记过的时段不要重复输出；若同一情绪确实有旁白依据，可以输出同段同情绪来补不确定 why。没有可辨认情绪就输出 []。`;

  let raw;
  try {
    raw = await mcInstance.sample([{ role: "user", content: prompt }], {
      maxTokens: 700,
      temperature: 0.3,
      timeoutMs: 45000,
      callPurpose: "mood-discovery",
      reasoningLevel: "off",
      // 自动发现每天最多一次模型批量调用；空正文不再由积木自动重试。
      retryOnEmpty: false,
    });
  } catch (e) {
    const error = modelChannelErrorHint(e, settings.modelSource || "agent");
    await saveState({ status: "failed", mode, attemptedAt, finishedAt: new Date().toISOString(), error: String(error).slice(0, 300) });
    logWarn(`${day} 自动情绪发现模型调用失败：${error}`);
    return { ok: false, error };
  }
  if (!String(raw || "").trim()) {
    const error = modelChannelErrorHint("模型未回复正文", settings.modelSource || "agent");
    await saveState({ status: "failed", mode, attemptedAt, finishedAt: new Date().toISOString(), error: String(error).slice(0, 300) });
    logWarn(`${day} 自动情绪发现模型未回复正文：${error}`);
    return { ok: false, error };
  }

  const allowedObservedAt = rows
    .filter((row) => row?.role === "user" && Number.isFinite(Number(row.ts)))
    .map((row) => row.ts);
  const candidates = parseMoodOutput(raw, {
    day,
    now: new Date(),
    allowedObservedAt,
    evidenceSourceText: userEvidenceText,
  });
  let finalCandidates = candidates;
  let reviewedCandidateCount = 0;
  let reviewedCount = 0;

  if (mode === "detailed" && candidates.length) {
    const sameMinute = (a, b) => {
      const at = a ? Date.parse(a) : NaN;
      const bt = b ? Date.parse(b) : NaN;
      return Number.isFinite(at) && Number.isFinite(bt) && Math.floor(at / 60000) === Math.floor(bt / 60000);
    };
    const conflictsWithManual = (candidate) => manual.some((entry) => {
      if (entry.mood === candidate.mood) return false;
      if (candidate.timePrecision === "turn" && candidate.observedAt && entry.recordedAt) return sameMinute(candidate.observedAt, entry.recordedAt);
      return entry.segment === candidate.segment;
    });
    const conflictsWithCandidate = (candidate, index) => candidates.some((other, otherIndex) => {
      if (index === otherIndex || other.mood === candidate.mood) return false;
      if (candidate.timePrecision === "turn" && other.timePrecision === "turn") return sameMinute(candidate.observedAt, other.observedAt);
      return candidate.segment === other.segment && candidate.timePrecision !== "turn" && other.timePrecision !== "turn";
    });
    // force=true（用户主动翻历史补档）走宽松复核：同段不同情绪允许共存，
    // 不再因为候选互相冲突就送复核砍掉，让老账心情线丰富起来；
    // 当天自动翻篇（force=false）保持严格，冲突仍进复核。
    const shouldReview = (entry, index) =>
      entry.certainty !== "clear"
      || entry.evidenceType !== "explicit"
      || !String(entry.evidence || "").trim()
      || conflictsWithManual(entry)
      || (!force && conflictsWithCandidate(entry, index));
    const reviewItems = candidates.map((entry, index) => ({ entry, index })).filter(({ entry, index }) => shouldReview(entry, index));
    reviewedCandidateCount = reviewItems.length;
    if (reviewItems.length) {
      // 老账补档时裁决倾向保留：有“我”的原话、语义清楚就信任模型的发现，只有完全无依据才丢；
      // 当天自动仍维持严格口径（不臆造）。
      const reviewGuide = force
        ? `你是拾光记的复核者。下面是从${userName}可见对话中提取出的自动情绪候选（补档宽松模式）。只复核这些候选，不新增情绪，不改手动记录。只要候选有“我”的原话依据或上下文支持就倾向保留（同一时段出现不同情绪是正常的，一天本来就可能又烦又开心）；只有完全没有任何依据、或明显是伙伴的情绪/系统内容时才丢弃。`
        : `你是拾光记的谨慎复核者。下面是从${userName}可见对话中提取出的自动情绪候选。只复核这些候选，不新增情绪，不改手动记录。若证据只是伙伴说话、没有“我”的原话、时间对不上、或同一时刻出现互相冲突的候选，就丢弃；证据足够时才保留。`;
      const reviewPrompt =
        `${reviewGuide}\n` +
        `只输出 JSON 数组：[ { "index": 0, "decision": "keep|drop", "reason": "一句话" } ]\n` +
        JSON.stringify(reviewItems.map(({ entry, index }) => ({
          index,
          mood: entry.label,
          segment: entry.segment,
          observedAt: entry.observedAt || "",
          certainty: entry.certainty,
          evidenceType: entry.evidenceType,
          evidence: entry.evidence || "",
          why: entry.note || "",
        })), null, 2);
      try {
        const reviewRaw = await mcInstance.sample([{ role: "user", content: reviewPrompt }], {
          maxTokens: 320,
          temperature: 0.15,
          timeoutMs: 30000,
          callPurpose: "mood-discovery-review",
          reasoningLevel: "off",
          retryOnEmpty: false,
        });
        const decisions = parseMoodReviewOutput(reviewRaw, { allowedIndexes: reviewItems.map(({ index }) => index) });
        const byIndex = new Map(decisions.map((item) => [item.index, item.keep]));
        reviewedCount = decisions.filter((item) => byIndex.has(item.index)).length;
        if (decisions.length) {
          finalCandidates = candidates.filter((entry, index) => !byIndex.has(index) || byIndex.get(index));
        }
      } catch (e) {
        // 复核失败时保留首轮候选，并把“未复核”留在状态里；不能因为附加调用失败误删自动发现。
        logWarn(`${day} 自动情绪细致复核失败，保留首轮候选：${e?.message || e}`);
      }
    }
  }

  // force=true（历史补档）宽松合并：同段不同情绪共存；当天自动严格，保持原口径。
  const merged = mergeMoodEntries(manual, finalCandidates, { lenient: force });
  if (JSON.stringify(merged) !== JSON.stringify(manual)) await data.replaceDayMoods(day, merged);
  const retainedAutoCount = merged.filter((entry) => entry.source === "auto").length;
  await saveState({
    status: "completed",
    mode,
    attemptedAt,
    finishedAt: new Date().toISOString(),
    candidateCount: candidates.length,
    retainedAutoCount,
    reviewedCandidateCount,
    reviewedCount,
    messageCount: rows.length,
    explicitSignalCount: explicitSignals.length,
  });
  return {
    ok: true,
    candidateCount: candidates.length,
    autoCount: retainedAutoCount,
    mergedCount: merged.length,
    reviewedCandidateCount,
    reviewedCount,
  };
}

/**
 * 日终伙伴心情线：为做册选中的伙伴各整理一条「际遇锚点」的情绪线。
 * 只读拾光记自身可见消息；候选证据必须能锚当天原文，不外推心理事实。
 * 幂等：按 date|agentId 记录状态，重启不会重复调用；失败可随定时器在十分钟后重试。
 */
async function harvestPartnerMoodsForDay({ day, range, userName, force = false } = {}) {
  const data = getData();
  const settings = data.getSettings();
  if (!settings.partnerMoodEnabled) return { ok: true, skipped: true, reason: "disabled" };
  const moodMode = normalizeMoodDiscoveryMode(settings.moodDiscoveryMode);
  if (moodMode === "off") return { ok: true, skipped: true, reason: "mood-disabled" };
  if (!mcInstance) return { ok: false, error: "插件路由未初始化" };

  // 伙伴链的证据靠际遇信号锚定，不能被做册的 per-agent 抽样稀释：重收全量，宁可多不可漏。
  const collected = collectDayMessages({
    agentsDir: AGENTS_DIR,
    targetDate: day,
    boundaryHour: settings.dayBoundaryHour ?? 4,
    maxMessages: 20000,
    maxMessagesPerAgent: 0,
  });
  const rows = Array.isArray(collected.messages) ? collected.messages : [];
  const fullRange = collected.range && collected.range.start ? collected.range : range;
  const selected = getSelectedSummaryAgentIds(settings);
  const agentIdSet = new Set();
  if (selected && selected.size > 0) {
    for (const id of selected) {
      const trimmed = String(id || "").trim();
      if (trimmed) agentIdSet.add(trimmed);
    }
  } else if (selected === null) {
    // null=全部伙伴：只处理当天确实有可见消息的伙伴，不给空白日硬造线。
    for (const row of rows) {
      const id = String(row.agentId || "").trim();
      if (id) agentIdSet.add(id);
    }
  }
  if (!agentIdSet.size) return { ok: true, skipped: true, reason: "no-selected" };

  const results = [];
  for (const agentId of agentIdSet) {
    const previous = data.getPartnerMoodHarvestState(day, agentId);
    if (!force && isMoodHarvestTerminal(previous)) {
      results.push({ agentId, ok: true, skipped: true, reason: "already-handled" });
      continue;
    }
    try {
      results.push(await harvestPartnerMoodForAgent({
        day,
        range: fullRange,
        userName,
        rows,
        agentId,
        moodMode,
        force,
        whitelist: MOODS.map((m) => m.label).join("/"),
      }));
    } catch (e) {
      const error = modelChannelErrorHint(e, settings.modelSource || "agent");
      logWarn(`${day} 伙伴心情线 ${agentId} 失败（不影响做册）：${error}`);
      results.push({ agentId, ok: false, error: String(error).slice(0, 300) });
    }
  }
  return { ok: true, results };
}

async function harvestPartnerMoodForAgent({ day, range, userName, rows, agentId, moodMode, force = false, whitelist }) {
  const data = getData();
  const partnerRows = filterPartnerRows(rows, agentId);
  const saveState = async (patch) => {
    try {
      return await data.updatePartnerMoodHarvestState(day, agentId, patch);
    } catch (e) {
      logWarn(`${day} 伙伴心情线状态保存失败：${e?.message || e}`);
      return null;
    }
  };
  // 没有可见消息就没有证据，不为了一张空白情绪线调用模型。
  if (!partnerRows.length) {
    await saveState({ status: "skipped", reason: "no-visible-message", checkedAt: new Date().toISOString() });
    return { ok: true, skipped: true, reason: "no-visible-message", agentId };
  }
  const signals = findPartnerFortuneSignals(rows, agentId);
  // 轻量档只把命中际遇线索的生活日交给模型；细致档没线索也谨慎看上下文。
  if (moodMode === "economical" && !signals.length) {
    await saveState({
      status: "skipped",
      moodMode,
      reason: "no-fortune-signal",
      checkedAt: new Date().toISOString(),
      messageCount: partnerRows.length,
    });
    return { ok: true, skipped: true, reason: "no-fortune-signal", agentId };
  }
  const agentName = readAgentDisplayName(AGENTS_DIR, agentId) || agentId;
  const attemptedAt = new Date().toISOString();
  await saveState({
    status: "running",
    moodMode,
    attemptedAt,
    messageCount: partnerRows.length,
    explicitSignalCount: signals.length,
  });
  const fmtRow = (row) => {
    const ts = new Date(Number(row.ts));
    const stamp = !Number.isNaN(ts.getTime())
      ? `${dateKey(ts)} ${String(ts.getHours()).padStart(2, "0")}:${String(ts.getMinutes()).padStart(2, "0")}`
      : "时间不明";
    return `[${stamp}] ${row.role === "user" ? userName : agentName}：${row.text}`;
  };
  const evidenceText = buildSignalAwareEvidence(partnerRows, signals, fmtRow, 8000);
  const signalText = signals.length
    ? signals.map((item) => `- ${item.kind}：${item.text}`).join("\n")
    : "（本地没有命中明确际遇线索，细致档位仍可根据上下文谨慎判断）";
  const prompt =
    `你是拾光记的日子整理员。现在生活日 ${day}（从 ${range.start.toLocaleString("zh-CN")} 到 ${range.end.toLocaleString("zh-CN")}）已翻篇，请根据下面的可见对话，为「伙伴：${agentName}」整理当天的际遇，生成“自动发现候选”，不要把候选说成确定的心理事实。\n\n` +
    `本地零 Token 预筛命中的际遇线索（praise=被夸被谢、rebuke=被凶被嫌、self=它自己表达了感受；只是线索，不代表最终判断）：\n${signalText}\n\n` +
    `当天可见对话（只含 ${agentName} 与 ${userName} 的往来；方括号内是消息真实时间；“我”是 ${userName}）：\n${evidenceText || "（没有可用对话文字）"}\n\n` +
    `请只输出一个 JSON 数组，不要任何其他文字。每条候选使用以下字段：\n` +
    `[{ "mood": "情绪词", "segment": "上午|下午|晚上", "observedAt": "从消息方括号原样抄回的 YYYY-MM-DD HH:MM；无法确认就填空", "certainty": "clear|possible|uncertain", "evidenceType": "explicit|context", "evidence": "从对话原样摘出的短句；无法原样找到就填空", "why": "一句带不确定语气的推测，写清是哪种际遇（被夸/被谢/被凶/被晾/被需要/它自己表达了感受）；猜不出就填空" }]\n\n` +
    `规则：\n` +
    `- mood 只能从这些词里选：${whitelist}；选不出来就不输出那条。\n` +
    `- 只判断“${agentName}”这一方的感受，且依据只能是它那天的际遇：被夸、被谢、被凶、被晾、被需要，或它自己明确说出的感受。\n` +
    `- 它的服务性回应不算情绪：它安抚${userName}、说“我理解你”“别担心”这类共情话，不能推出它自己难过或担心。\n` +
    `- segment 只填“上午/下午/晚上”；没有足够线索时可以填空，系统会把它记成宽泛的白天候选。\n` +
    `- observedAt 只有在能和某条真实消息时间逐字对应时才填写，不能根据语义猜一个时间；无法对应就留空。\n` +
    `- certainty 只能用 clear、possible、uncertain，不要输出 0-100 的心理分数。context 推测优先用 possible 或 uncertain。\n` +
    `- evidence 必须是对话里的连续短摘录（“我”夸它/凶它的话，或它自己的原话都行），找不到原文就留空；why 可以为空，绝不硬安现实原因。\n` +
    `- 没有可辨认际遇就输出 []，宁可少不要硬凑。`;
  let raw;
  try {
    raw = await mcInstance.sample([{ role: "user", content: prompt }], {
      maxTokens: 700,
      temperature: 0.3,
      timeoutMs: 45000,
      callPurpose: "partner-mood-discovery",
      reasoningLevel: "off",
      retryOnEmpty: false,
    });
  } catch (e) {
    const error = modelChannelErrorHint(e, data.getSettings().modelSource || "agent");
    await saveState({ status: "failed", moodMode, attemptedAt, finishedAt: new Date().toISOString(), error: String(error).slice(0, 300) });
    return { ok: false, error, agentId };
  }
  if (!String(raw || "").trim()) {
    const error = modelChannelErrorHint("模型未回复正文", data.getSettings().modelSource || "agent");
    await saveState({ status: "failed", moodMode, attemptedAt, finishedAt: new Date().toISOString(), error: String(error).slice(0, 300) });
    return { ok: false, error, agentId };
  }
  const allowedObservedAt = partnerRows.filter((row) => Number.isFinite(Number(row.ts))).map((row) => row.ts);
  const candidates = parseMoodOutput(raw, {
    day,
    now: new Date(),
    allowedObservedAt,
    evidenceSourceText: evidenceText,
  });
  // 伙伴链没有手动亲笔；当天自动走严格口径（同段同情绪去重，只留能站住的候选）；
  // 历史补档（force=true）走宽松口径：同段不同情绪允许共存，一天的情绪起伏不被砍平。
  const merged = mergeMoodEntries([], candidates, { lenient: !!force });
  if (merged.length) await data.replacePartnerDayMoods(day, agentId, merged);
  await saveState({
    status: "completed",
    moodMode,
    attemptedAt,
    finishedAt: new Date().toISOString(),
    candidateCount: candidates.length,
    retainedAutoCount: merged.length,
    messageCount: partnerRows.length,
    explicitSignalCount: signals.length,
  });
  return { ok: true, agentId, agentName, candidateCount: candidates.length, autoCount: merged.length };
}

// ── 伙伴心情历史补档（后台任务：只补际遇线，不碰做册总结）──

function normalizePartnerMoodDates(value, boundaryHour) {
  const list = Array.isArray(value) ? value : [value];
  const latestFinished = finishedLifeDayKey(new Date(), boundaryHour);
  const dates = [...new Set(list.map((item) => String(item || "").trim()).filter(Boolean))].sort();
  if (!dates.length) return { error: "至少选一天" };
  if (dates.length > PARTNER_MOOD_BACKFILL_MAX_DATES) return { error: `一次最多补 ${PARTNER_MOOD_BACKFILL_MAX_DATES} 天` };
  for (const date of dates) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: `日期格式不对：${date}` };
    const parsed = new Date(`${date}T00:00:00`);
    if (Number.isNaN(parsed.getTime()) || dateKey(parsed) !== date) return { error: `日期无效：${date}` };
    if (date > latestFinished) return { error: `${date} 还没有结束，先选已经过去的日子` };
  }
  return { dates };
}

function decoratePartnerMoodJob(job) {
  if (!job) return null;
  const dates = Array.isArray(job.dates) ? job.dates : [];
  const outcomes = Array.isArray(job.outcomes) ? job.outcomes : [];
  return {
    ...job,
    progress: { done: outcomes.filter((item) => item.status !== "failed").length, total: dates.length },
    failed: outcomes.filter((item) => item.status === "failed").length,
  };
}

function findActivePartnerMoodJob(data) {
  return data.listPartnerMoodJobs(true)[0] || null;
}

function makePartnerMoodJobOutcome(date, result) {
  if (result && result.ok) {
    return { date, status: "completed", count: Number(result.count) || 0, updatedAt: new Date().toISOString() };
  }
  return { date, status: "failed", error: String(result?.error || "这一天没补上").slice(0, 300), updatedAt: new Date().toISOString() };
}

function submitPartnerMoodBackfill(dates) {
  return (partnerMoodSubmitQueue = partnerMoodSubmitQueue.catch(() => {}).then(async () => {
    const data = getData();
    const active = findActivePartnerMoodJob(data);
    if (active) return { ok: false, error: "已经有一项伙伴心情补档在运行", job: decoratePartnerMoodJob(active) };
    const job = await data.createPartnerMoodJob({ dates });
    startPartnerMoodJob(job.id);
    return { ok: true, job: decoratePartnerMoodJob(job) };
  }));
}

function startPartnerMoodJob(jobId) {
  if (activePartnerMoodJobPromise) return activePartnerMoodJobPromise;
  const job = getData().getPartnerMoodJob(jobId);
  if (!job || !PARTNER_MOOD_JOB_ACTIVE_STATUSES.has(job.status)) return null;
  activePartnerMoodJobPromise = processPartnerMoodJob(jobId).finally(() => {
    activePartnerMoodJobPromise = null;
    // 前一个任务结束后，若已有排队任务则继续接起来。
    setTimeout(() => resumePartnerMoodJobs(), 0);
  });
  return activePartnerMoodJobPromise;
}

function resumePartnerMoodJobs() {
  if (activePartnerMoodJobPromise) return;
  const job = getData().listPartnerMoodJobs(true)[0];
  if (job) startPartnerMoodJob(job.id);
}

async function processPartnerMoodJob(jobId) {
  const data = getData();
  let job = data.getPartnerMoodJob(jobId);
  if (!job) return;
  try {
    await data.updatePartnerMoodJob(jobId, { status: "running", currentDate: "", error: "" });
    const settings = data.getSettings();
    const boundary = normalizeBoundaryHour(settings.dayBoundaryHour);
    const userName = readHanaUserName() || "对方";
    for (const date of Array.isArray(job.dates) ? job.dates : []) {
      job = data.getPartnerMoodJob(jobId);
      if (!job) return;
      const outcomes = Array.isArray(job.outcomes) ? job.outcomes : [];
      if (outcomes.some((outcome) => outcome.date === date)) continue;
      await data.updatePartnerMoodJob(jobId, { status: "running", currentDate: date, error: "" });
      let result;
      try {
        // 补档=用户主动翻历史：force=true 强制重扫（忽略幂等），宽松口径保留一天的情绪起伏；
        // 只跑伙伴际遇链，不经过做册流程，已定稿的总结页一个字都不会动。
        const harvest = await harvestPartnerMoodsForDay({ day: date, userName, force: true });
        if (!harvest.ok) {
          result = { ok: false, error: harvest.error || "这一天没补上" };
        } else {
          const finished = (harvest.results || []).filter((r) => r.ok && !r.skipped);
          const counts = finished.map((r) => Number(r.autoCount) || 0);
          result = { ok: true, count: counts.reduce((sum, n) => sum + n, 0), partnerCount: finished.length };
        }
      } catch (e) {
        result = { ok: false, error: e?.message || "这一天没补上" };
      }
      const outcome = makePartnerMoodJobOutcome(date, result);
      job = data.getPartnerMoodJob(jobId);
      if (!job) return;
      const nextOutcomes = [
        ...(Array.isArray(job.outcomes) ? job.outcomes : []).filter((item) => item.date !== date),
        outcome,
      ];
      await data.updatePartnerMoodJob(jobId, {
        status: "running",
        currentDate: "",
        outcomes: nextOutcomes,
        error: outcome.status === "failed" ? outcome.error : "",
      });
    }
    job = data.getPartnerMoodJob(jobId);
    if (!job) return;
    const failed = (job.outcomes || []).filter((outcome) => outcome.status === "failed").length;
    await data.updatePartnerMoodJob(jobId, {
      status: failed ? "completed_with_errors" : "completed",
      currentDate: "",
      error: failed ? `${failed} 天没补上，可以重新发起` : "",
    });
  } catch (e) {
    try {
      await data.updatePartnerMoodJob(jobId, {
        status: "failed",
        currentDate: "",
        error: String(e?.message || "伙伴心情补档任务中断").slice(0, 300),
      });
    } catch {
      // 状态写入也失败时不再抛未处理异常。
    }
  }
}

function registerMoodRoutes(app) {
  // 情绪集合（页面渲染用）
  app.get("/api/moods/meta", async (c) => {
    return c.json({ ok: true, moods: MOODS });
  });

  // 某月的情绪速览（时光册分月回看用：date → 当天 emoji 序列）
  app.get("/api/moods", async (c) => {
    try {
      const url = new URL(c.req.url, "http://localhost");
      const ym = String(url.searchParams.get("month") || "");
      if (!/^\d{4}-\d{2}$/.test(ym)) return c.json({ ok: false, error: "月份格式不对" });
      const data = getData();
      const map = {};
      for (const row of data.listMoods()) {
        if (!String(row.date || "").startsWith(ym)) continue;
        if (!map[row.date]) map[row.date] = [];
        map[row.date].push(decorateMoodEntry(row));
      }
      return c.json({ ok: true, month: ym, days: map });
    } catch (e) {
      return c.json({ ok: false, error: e?.message || "读取失败" });
    }
  });

  // 某天的情绪记录
  app.get("/api/moods/:date", async (c) => {
    const date = c.req.param("date");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ ok: false, error: "日期格式不对" });
    return c.json({ ok: true, date, moods: moodEntriesForDate(date), meta: MOODS });
  });

  // 记一笔当下的心情：手动标记，自动落当前时刻分段；date 默认今天
  app.post("/api/moods", async (c) => {
    try {
      const body = (await c.req.json().catch(() => ({}))) || {};
      const date = String(body.date || "").trim() || dateKey(new Date());
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ ok: false, error: "日期格式不对" });
      const mood = normalizeMoodId(body.mood);
      if (!mood) return c.json({ ok: false, error: "这个心情不在可选里，换一个吧" });
      const now = new Date();
      const entry = makeManualMood({ mood, segment: segmentOfHour(now.getHours()), reason: body.reason });
      const moods = await getData().addMood(date, entry);
      return c.json({ ok: true, date, moods: moods.map(decorateMoodEntry) });
    } catch (e) {
      return c.json({ ok: false, error: e?.message || "这条心情没记上" });
    }
  });

  // 删除一条（手动可删，手滑不赖账）
  app.delete("/api/moods/:date/:id", async (c) => {
    try {
      const date = c.req.param("date");
      const id = c.req.param("id");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ ok: false, error: "日期格式不对" });
      await getData().removeMood(date, id);
      return c.json({ ok: true, date, moods: moodEntriesForDate(date) });
    } catch (e) {
      return c.json({ ok: false, error: e?.message || "没删掉" });
    }
  });

  // 编辑：给手动条目补/改 reason，给自动条目改 note（时间线可编辑）
  app.put("/api/moods/:date/:id", async (c) => {
    try {
      const body = (await c.req.json().catch(() => ({}))) || {};
      const date = c.req.param("date");
      const id = c.req.param("id");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ ok: false, error: "日期格式不对" });
      const patch = {};
      if (body.reason !== undefined) patch.reason = String(body.reason || "").trim().slice(0, 200);
      if (body.note !== undefined) patch.note = String(body.note || "").trim().slice(0, 300);
      const updated = await getData().updateMood(date, id, patch);
      if (!updated) return c.json({ ok: false, error: "找不到这条心情" });
      return c.json({ ok: true, mood: decorateMoodEntry(updated), moods: moodEntriesForDate(date) });
    } catch (e) {
      return c.json({ ok: false, error: e?.message || "没改上" });
    }
  });

  // ── 伙伴心情线（独立于用户的 moods，按 agentId 分组）──

  // 某月伙伴心情速览：{ date: { agentId: [decorated entries] } }，附 agents 名映射
  app.get("/api/partner-moods", async (c) => {
    try {
      const url = new URL(c.req.url, "http://localhost");
      const ym = String(url.searchParams.get("month") || "");
      if (!/^\d{4}-\d{2}$/.test(ym)) return c.json({ ok: false, error: "月份格式不对" });
      const data = getData();
      const days = {};
      const agentIds = new Set();
      for (const row of data.listPartnerMoods()) {
        if (!String(row.date || "").startsWith(ym)) continue;
        if (!days[row.date]) days[row.date] = {};
        if (!days[row.date][row.agentId]) days[row.date][row.agentId] = [];
        days[row.date][row.agentId].push(decorateMoodEntry(row));
        agentIds.add(row.agentId);
      }
      const agents = {};
      for (const agentId of agentIds) agents[agentId] = readAgentDisplayName(AGENTS_DIR, agentId) || agentId;
      return c.json({ ok: true, month: ym, days, agents });
    } catch (e) {
      return c.json({ ok: false, error: e?.message || "读取失败" });
    }
  });

  // 某天伙伴心情：{ agentId: [decorated] }（心情线页"看这天"与并行曲线用）
  app.get("/api/partner-moods/:date", async (c) => {
    try {
      const date = c.req.param("date");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ ok: false, error: "日期格式不对" });
      const data = getData();
      const byAgent = data.getPartnerDayMoods(date);
      const partners = {};
      const agents = {};
      for (const agentId of Object.keys(byAgent)) {
        partners[agentId] = byAgent[agentId].map(decorateMoodEntry);
        agents[agentId] = readAgentDisplayName(AGENTS_DIR, agentId) || agentId;
      }
      return c.json({ ok: true, date, partners, agents, meta: MOODS });
    } catch (e) {
      return c.json({ ok: false, error: e?.message || "读取失败" });
    }
  });

  // 历史补档：对选中的过去生活日批量跑伙伴际遇链（force 宽松），不碰做册总结
  app.post("/api/partner-moods/backfill", async (c) => {
    try {
      const body = (await c.req.json().catch(() => ({}))) || {};
      const data = getData();
      const settings = data.getSettings();
      if (!settings.partnerMoodEnabled) return c.json({ ok: false, error: "先在设置里打开伙伴心情线" });
      if (normalizeMoodDiscoveryMode(settings.moodDiscoveryMode) === "off") {
        return c.json({ ok: false, error: "自动情绪发现关着，伙伴心情线不会跑" });
      }
      const normalized = normalizePartnerMoodDates(body.dates, normalizeBoundaryHour(settings.dayBoundaryHour));
      if (normalized.error) return c.json({ ok: false, error: normalized.error });
      return c.json(await submitPartnerMoodBackfill(normalized.dates));
    } catch (e) {
      return c.json({ ok: false, error: e?.message || "补档任务创建失败" });
    }
  });

  // 补档任务进度（独立路径，避免与 /api/partner-moods/:date 撞车）
  app.get("/api/partner-moods-jobs", async (c) => {
    try {
      const data = getData();
      const jobs = data.listPartnerMoodJobs().slice(0, 5).map(decoratePartnerMoodJob);
      return c.json({ ok: true, jobs, active: !!findActivePartnerMoodJob(data) });
    } catch (e) {
      return c.json({ ok: false, error: e?.message || "读取失败" });
    }
  });

  // 确认收下：跑完的补档卡退场，刷新后不再弹（有失败天数的也允许收下）
  app.post("/api/partner-moods-jobs/:id/dismiss", async (c) => {
    try {
      const data = getData();
      const job = data.getPartnerMoodJob(c.req.param("id"));
      if (!job) return c.json({ ok: false, error: "找不到这项补档任务" });
      if (job.status !== "completed" && job.status !== "completed_with_errors") {
        return c.json({ ok: false, error: "补档还没跑完，先等它一会儿" });
      }
      await data.updatePartnerMoodJob(job.id, { dismissedAt: new Date().toISOString() });
      return c.json({ ok: true, job: decoratePartnerMoodJob(data.getPartnerMoodJob(job.id)) });
    } catch (e) {
      return c.json({ ok: false, error: e?.message || "确认失败" });
    }
  });
}

export { mergeRetryOutcomes };

