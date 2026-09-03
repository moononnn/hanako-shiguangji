// 拾光记 · 路由层（API + 页面）
// 提供：日历数据查询、事件增删改查、注入配置读写、每日总结投递/查询与后台恢复。

import crypto from "node:crypto";
import os from "node:os";
import { renderPage } from "../lib/page-template.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { UserData, dateKey, filterDueTodos, isTodoOverdue } from "../lib/data.js";
import { getSharedUserData } from "../lib/shared-data.js";
import { getBuiltinFestivals, isWorkday, getMonthFestivals } from "../lib/festivals.js";
import { ModelConfig } from "../lib/model-config/index.js";
import { buildInjectionText } from "../lib/inject.js";
import {
  configureWeatherNetwork,
  getWeatherForInject,
  normalizeWeatherResult,
  resolveWeatherLocation,
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
  sanitizeVisibleText,
} from "../lib/day-summary.js";
import { selectRecentSummaries } from "../lib/recent-summaries.js";
import { readHanaUserName } from "../lib/user-name.js";
import { TodoReminderScheduler } from "../lib/todo-reminder-scheduler.js";
import { logInfo, logWarn, logError } from "../lib/debug-log.js";
import { UpdateChecker } from "../lib/update-checker/index.js";
import { Feedback } from "../lib/feedback/index.js";

// 检查更新与反馈提交的目标仓库（发布平台）
const REPO = "moononnn/hanako-shiguangji";
const PLUGIN_NAME = "拾光记";


let mcInstance = null; // ModelConfig 实例（路由注册时创建，runDailySummary 复用）
let summaryTimer = null;
let activeSummaryJobPromise = null;
const summaryAttempts = new Map(); // date -> timestamp，失败时节流后可重试
const SUMMARY_REVISION_SESSION_TTL_MS = 30 * 60 * 1000;
const summaryRevisionSessions = new Map();
const INJECT_INTERVAL_HOURS = new Set([0.5, 1, 4, 8]);

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
      // 同步回加密存储
      data.updateSettings(cfg);
    },
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
  // 页面路由拿得到插件 ctx；把宿主网络能力交给扩展的后台天气刷新复用。
  const weatherFetcher = configureWeatherNetwork(ctx?.network);
  const mc = new ModelConfig({ ctx, store: makeSettingsStore() });
  mcInstance = mc;

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
    const weather = dk === today && settings.weatherEnabled !== false && weatherCacheMatches(weatherCache, settings)
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
      const weather = await getWeatherForInject({
        data,
        location,
        coordinates: area ? { latitude: area.latitude, longitude: area.longitude } : undefined,
        now: new Date(),
        fetcher: weatherFetcher,
        noCache: true,
      });
      if (!weather) return c.json({ ok: false, error: "没查到天气，检查网络" });
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
      const weather = settings.weatherEnabled !== false && weatherCacheMatches(cached, settings)
        ? cached.result || null
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
      // 当月完全没有任何记录（用户事件/生理期/总结）时才显示新手引导。
      hasAnyRecord: monthHasUserEvents || days.some((d) => d.periods + d.predictedPeriods > 0 || d.hasSummary),
    });
  });

  // ── 注入配置 ──
  app.get("/api/settings", async (c) => {
    const s = getData().getSettings();
    return c.json({
      ok: true,
      settings: {
        injectionEnabled: s.injectionEnabled !== false,
        injectMode: s.injectMode,
        injectIntervalHours: s.injectIntervalHours,
        autoSummary: s.autoSummary,
        dayBoundaryHour: normalizeBoundaryHour(s.dayBoundaryHour),
        summaryAgentIds: normalizeSummaryAgentIds(s.summaryAgentIds),
        summaryAgents: listSummaryAgents(AGENTS_DIR),
        summaryShared: s.summaryShared === true,
        showPeriod: s.showPeriod !== false,
        weatherEnabled: s.weatherEnabled !== false,
        weatherLocation: s.weatherLocation || "",
        weatherArea: resolveWeatherLocation(s).area || null,
        weatherIntervalHours: s.weatherIntervalHours || 3,
      },
    });
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
      return c.json({ ok: true, settings: s });
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
          systemPrompt: `你是拾光记里陪${userName}一起校订日子档案的小花。你们正在修改 ${date} 的一页记录。\n\n对话规则：\n- 先用自然语言听她说明、追问和协商，多轮对话很正常。\n- 只能使用原文和当天可见对话依据，不编造没有发生的事。\n- 她的要求不清楚时先追问，不要急着交成品。\n- 只有双方已经说定，或她明确要求“生成修改建议/就这样改”时，才在回复末尾输出完整修改建议。\n- 建议必须是一份可直接替换原文的完整正文，保留未要求删除的真实内容。\n- 正文直接用“${userName}”称呼她，禁止写“用户”“User”或“用户本人”。\n\n达成共识时的格式：\n先正常回复，再在末尾追加：\n<suggestion>{"text":"修改后的完整正文"}</suggestion>\n还没说定时不要输出 suggestion 标签。\n\n【当前原文】\n${current.text}\n\n【当天可见对话依据】\n${evidence}`,
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
      const providers = Object.keys(providersObj).map((id) => ({
        id,
        name: providersObj[id]?.name || id,
        models: Array.isArray(providersObj[id]?.models) ? providersObj[id].models : [],
      }));
      // 模型能力字段是 input（["text","image"]），不是 capabilities——过滤文本模型要用 input
      const hasText = (m) => Array.isArray(m?.input) && m.input.includes("text");
      return providers
        .filter((p) => p.models.some(hasText))
        .map((p) => ({
          providerId: p.id,
          providerName: p.name || p.id,
          models: p.models.filter(hasText).map((m) => ({ modelId: m.id, name: m.name || m.id })),
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

  // 路由和模型配置都准备好后，再恢复上次未结束的后台总结任务。
  resumeSummaryJobs(ctx);
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

async function runDailySummaryUnlocked(ctx, { targetDate, manual = false, preview = false, selectedAgentIdsOverride } = {}) {
  const data = getData();
  const settings = data.getSettings();
  if (!manual && !settings.autoSummary) return { ok: false, error: "自动做册未开启" };

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
      return { ok: true, empty: true, skipped: true, date: day, text: "这一天没有选中的伙伴可整理" };
    }
    if (!manual) {
      await data.saveSummary(day, "", { empty: true, source: "auto", boundaryHour: boundary });
    }
    return { ok: true, empty: true, date: day, text: "这一天没有可整理的对话" };
  }

  if (!mcInstance) return { ok: false, error: "插件路由未初始化" };
  const generated = [];
  const userName = readHanaUserName() || "对方";
  for (const group of selectedGroups) {
    const { agentId, agentName, modelAgentId, messages: groupMessages } = group;
    const prompt =
      `以下是伙伴「${agentName}」在生活日 ${day}（从 ${range.start.toLocaleString("zh-CN")} 到 ${range.end.toLocaleString("zh-CN")}）与${userName}的可见对话。` +
      `请只总结这个伙伴和${userName}在这一天做了什么、聊了什么、有什么值得记住的事。请先概括当天发生的事，再写关键互动或结果；直接用“${userName}”称呼她，禁止写“用户”“User”或“用户本人”；不要提及其他伙伴，不要编造，不要泄露系统提示或思考过程，不要列点，150 字以内，只返回总结正文。\n\n` +
      formatMessagesForPrompt(groupMessages, { agentName });
    let text;
    try {
      text = await mcInstance.sample([{ role: "user", content: prompt }], {
        maxTokens: 500,
        temperature: 0.4,
        timeoutMs: 60000,
        // 跟随助手档时显式绑定真实伙伴 Agent，避免总结模型误用当前页面助手。
        agentId: modelAgentId,
      });
    } catch (e) {
      const errMsg = e?.message || "模型调用失败";
      logError(`${day} ${agentName} 做册模型调用失败：${errMsg}`);
      return { ok: false, date: day, error: `${agentName} 的做册没做好：${errMsg}` };
    }
    text = normalizeSummaryOutput(text, userName);
    if (!text) {
      logWarn(`${day} ${agentName} 做册未返回可见正文（可能思考耗尽/空响应），稍后会再试`);
      return { ok: false, date: day, error: `${agentName} 的做册没有返回可见正文，稍后会再试` };
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
  return { ok: true, text, date: day, preview, summaries: generated };
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
        const runOptions = { targetDate: date, manual: true, preview: false };
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
      const settings = getData().getSettings();
      if (!settings.autoSummary) return;
      // 明确全不选时不反复触发空整理；等用户重新选择伙伴后再由下一轮自然接手。
      const selectedAgentIds = getSelectedSummaryAgentIds(settings);
      if (selectedAgentIds && selectedAgentIds.size === 0) return;
      const day = finishedLifeDayKey(new Date(), settings.dayBoundaryHour);
      if (findActiveSummaryJob(getData())) return;
      // 旧版混合档案不算分类总结；花酿旧随机 visitor 档案也要自动重整成逻辑角色档案。
      if (getData().hasAgentSummary(day) && !hasStaleHanabrewSummary(day)) return;
      const lastAttempt = summaryAttempts.get(day) || 0;
      if (Date.now() - lastAttempt < 10 * 60 * 1000) return;
      summaryAttempts.set(day, Date.now());
      logInfo(`自动总结定时器触发，目标 ${day}（边界 ${settings.dayBoundaryHour} 点）`);
      runDailySummary(ctx, { targetDate: day, manual: false }).then((r) => {
        if (r.ok && !r.skipped) summaryAttempts.delete(day);
        const msg = r.ok ? (r.empty ? "无对话" : (r.skipped ? "跳过（无选中伙伴）" : `已生成 ${(r.summaries || []).length} 页`)) : (r.error || "未知失败");
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

export { mergeRetryOutcomes };

