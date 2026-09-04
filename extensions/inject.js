// 拾光记 · 情境注入扩展（before_agent_start）
// 每个模型请求前触发；按注入模式决定是否注入「今日时光」隐藏消息。
// display:false，用户不可见，不进历史，回合结束即消失。注入失败不影响对话。

import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { filterDueTodos } from "../lib/data.js";
import { configureSharedUserData, getSharedUserData } from "../lib/shared-data.js";
import { InjectionTracker, shouldInject, buildInjectionText } from "../lib/inject.js";
import { selectRecentSummaries } from "../lib/recent-summaries.js";
import { getBuiltinFestivals, isWorkday } from "../lib/festivals.js";
import { FESTIVAL_HINTS, pickFestivalHint } from "../lib/festival-hints.js";
import { finishedLifeDayKey, resolveSummaryAgentId } from "../lib/day-summary.js";
import { readHanaUserName } from "../lib/user-name.js";
import {
  getConfiguredWeatherFetcher,
  getWeatherForInject,
  normalizeWeatherResult,
  resolveWeatherLocation,
  weatherCacheIsFresh,
  weatherCacheMatches,
} from "../lib/weather.js";
import { configureDebugLog, logInfo } from "../lib/debug-log.js";

const tracker = new InjectionTracker();
let weatherTimer = null; // 天气惰性刷新定时器

export function __resetLazySummaryForTest() {
  // 兼容旧测试入口；总结已统一由路由层可靠定时器负责。
}

function contextDataDir(context) {
  return context?.dataDir || context?.pluginContext?.dataDir || context?.ctx?.dataDir || null;
}

function getData(context = null) {
  const dataDir = contextDataDir(context);
  if (dataDir) {
    configureSharedUserData(dataDir);
    configureDebugLog(dataDir);
  }
  return getSharedUserData();
}

export default function registerShiguangjiInject(pi) {
  const dataDir = contextDataDir(pi);
  if (dataDir) {
    configureSharedUserData(dataDir);
    configureDebugLog(dataDir);
  }
  // 天气惰性刷新：每 15 分钟检查一次缓存是否过期，过期就后台查（不阻塞注入）
  startWeatherRefresher();

  pi.on("before_agent_start", (event, ctx) => {
    try {
      const sessionId = ctx?.sessionManager?.getSessionId?.() || null;
      if (!sessionId) return undefined;

      const data = getData(ctx);
      const settings = data.getSettings();
      const now = new Date();
      const injectionEnabled = settings.injectionEnabled !== false;
      const lastState = tracker.get(sessionId);
      const dataRev = data.getDataRev();
      const contextKey = JSON.stringify({
        mode: settings.injectMode || "balanced",
        intervalHours: settings.injectIntervalHours || 4,
        boundaryHour: settings.dayBoundaryHour,
        showPeriod: settings.showPeriod !== false,
        summaryShared: settings.summaryShared === true,
        weatherEnabled: settings.weatherEnabled !== false,
        weatherLocation: settings.weatherLocation || "",
      });

      // 关闭只阻断助手情境，不读取日子/总结，也不影响日历与时光册。
      if (!injectionEnabled) {
        const disabledDecision = shouldInject({
          sessionId,
          now,
          mode: settings.injectMode,
          intervalHours: settings.injectIntervalHours,
          lastState,
          hasSpecialDay: false,
          dayBoundaryHour: settings.dayBoundaryHour,
          contextKey,
          injectionEnabled: false,
        });
        tracker.set(sessionId, {
          ...disabledDecision.newState,
          contextKey,
          lastDataRev: dataRev,
          injectionEnabled: false,
        });
        return undefined;
      }

      // 收集当天情境。预计中的生理期不作为确定事实注入。
      const builtin = getBuiltinFestivals(now);
      const userEvents = data.eventsOnDate(now).filter((e) => e.type !== "period");
      const periods = settings.showPeriod !== false
        ? data.periodsWithDayOn(now).filter((p) => !p.predicted).map((p) => p.event)
        : [];
      // 生理期结束后的第一天：今天不在周期内，但昨天在（且已确认结束）→ 注入好闺蜜式的高兴
      let periodEndedYesterday = false;
      if (settings.showPeriod !== false && periods.length === 0) {
        const prev = new Date(now);
        prev.setDate(prev.getDate() - 1);
        const prevPeriods = data.periodsWithDayOn(prev).filter((p) => !p.predicted);
        if (prevPeriods.length) {
          const yesterdayConfirmed = prevPeriods.some((p) => {
            const ct = p.event.confirmedThrough;
            return !ct || ct <= dateKeyOf(prev);
          });
          periodEndedYesterday = yesterdayConfirmed;
        }
      }
      const workday = isWorkday(now);
      // 待办：只带今天和逾期的一次性待办；日期先统一归一化，避免旧 MM-DD 被字符串比较误判。
      const todos = filterDueTodos(data.listEvents(), now);

      // 节日引导变体：读已用索引，预先 pick 一个未用过的（随机不重复）；注入成功后才回写
      let festivalHint = null;
      for (const f of builtin) {
        if (!festivalHint && FESTIVAL_HINTS[f.name]) {
          const used = data.getUsedFestivalHintIndexes(f.name);
          const picked = pickFestivalHint(f.name, used);
          if (picked) festivalHint = { name: f.name, text: picked.text, index: picked.index, nextUsed: picked.nextUsed };
          break;
        }
      }

      const hasSpecialDay =
        builtin.length > 0 ||
        userEvents.length > 0 ||
        periods.length > 0 ||
        workday ||
        todos.length > 0;

      // 判定是否注入
      let decision = shouldInject({
        sessionId,
        now,
        mode: settings.injectMode,
        intervalHours: settings.injectIntervalHours,
        lastState,
        hasSpecialDay,
        dayBoundaryHour: settings.dayBoundaryHour,
        contextKey,
        injectionEnabled: true,
      });
      // 数据版本号变化（用户新增/改日子、确认生理期、生成/修改总结）→ 打破间隔，立即刷新一次。
      // 这样刚做的动作，下一条消息就能看到新情境，不用等间隔到期。
      if (!decision.should && lastState && lastState.lastDataRev !== undefined && lastState.lastDataRev !== dataRev) {
        decision = {
          should: true,
          reason: "data-changed",
          newState: { ...lastState, lastInjectAt: now.getTime(), lastDateKey: (decision.newState && decision.newState.lastDateKey) || lastState.lastDateKey },
        };
      }
      const decisionState = { ...decision.newState, contextKey, lastDataRev: dataRev, injectionEnabled: true };

      if (!decision.should) {
        tracker.set(sessionId, decisionState);
        return undefined;
      }

      // 近期总结：先按当前伙伴身份做权限过滤，再取最近 3 个已结束生活日；
      // 更老档案只在当前话题有词汇关联时渐进式展开。没有可靠身份时默认不带任何总结。
      const currentAgentId = resolveSummaryAgentId(getAgentsDir(), resolveAgentId(event, ctx));
      const userName = readHanaUserName() || "对方";
      const recent = selectRecentSummaries(data.listSummaryEntries(), {
        now,
        boundaryHour: settings.dayBoundaryHour,
        currentAgentId,
        shared: settings.summaryShared === true,
        prompt: extractPrompt(event),
      });

      // 天气：同步读缓存（刷新由定时器后台做，不阻塞注入）；没配置/没缓存就 null
      let weather = null;
      try {
        const wc = data.getWeatherCache();
        if (
          settings.weatherEnabled !== false &&
          weatherCacheMatches(wc, settings) &&
          weatherCacheIsFresh(wc, settings, now)
        ) {
          weather = normalizeWeatherResult(wc.result);
        }
      } catch {
        weather = null;
      }

      const text = buildInjectionText({
        now,
        builtinFestivals: builtin,
        userEvents,
        periods,
        isWorkday: workday,
        todosDue: todos,
        summary: null,
        recentSummaries: recent.entries,
        recentSummaryOptions: {
          currentAgentId,
          shared: settings.summaryShared === true,
          proactiveDate: finishedLifeDayKey(now, settings.dayBoundaryHour),
          userName,
        },
        weather,
        includeTime: settings.injectMode !== "economical",
        force: decision.reason === "new-session" || decision.reason === "day-changed" || decision.reason === "injection-enabled",
        periodEndedYesterday,
        festivalHint,
      });

      if (!text) {
        tracker.set(sessionId, decisionState);
        return undefined;
      }

      // 回写已用节日引导变体索引（随机不重复；只有确实注入且带了节日引导才回写）
      // 宿主 before_agent_start 是同步回调，这里 fire-and-forget：EncryptedStore 内部有写队列，异步落盘不阻塞主流程
      if (festivalHint) {
        try {
          const merged = [...new Set([...data.getUsedFestivalHintIndexes(festivalHint.name), festivalHint.index])];
          data.setUsedFestivalHintIndexes(festivalHint.name, merged).catch(() => {});
        } catch {
          // 回写失败不影响主流程
        }
      }

      // 内容 hash 去重：同一会话同一内容不重复注入
      const hash = crypto.createHash("sha1").update(text).digest("hex");
      if (lastState && lastState.lastHash === hash && decision.reason !== "day-changed" && decision.reason !== "settings-changed" && decision.reason !== "injection-enabled") {
        tracker.set(sessionId, { ...decisionState, lastHash });
        return undefined;
      }

      tracker.set(sessionId, { ...decisionState, lastHash: hash });

      return {
        message: {
          customType: "shiguangji-today-context",
          content: text,
          display: false,
          details: {
          injector: "shiguangji",
          reason: decision.reason,
          summaryCount: recent.entries.length,
          summaryExpanded: recent.expanded,
        },
        },
      };
    } catch {
      // 注入失败绝不能影响主对话
      return undefined;
    }
  });
}

function getAgentsDir() {
  const hanaHome = process.env.HANA_HOME || path.join(os.homedir(), ".hanako");
  return path.join(hanaHome, "agents");
}

function dateKeyOf(d) {
  const pad2 = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function extractPrompt(event) {
  const value = event?.prompt ?? event?.message?.content ?? event?.text ?? "";
  if (typeof value === "string") return value.slice(0, 2000);
  if (Array.isArray(value)) {
    return value.map((part) => typeof part === "string" ? part : part?.text || "").join(" ").slice(0, 2000);
  }
  return "";
}

export function resolveAgentId(event, ctx) {
  const direct = [
    ctx?.agentId,
    ctx?.agent?.id,
    ctx?.agent?.agentId,
    ctx?.sessionManager?.getAgentId?.(),
    event?.agentId,
    event?.agent?.id,
  ];
  for (const value of direct) {
    const id = String(value || "").trim();
    if (id) return id;
  }
  // 当前宿主仍可能只给 session 文件路径；路径回退只取 agents/<id>/sessions 这一段。
  const sessionPath = ctx?.sessionManager?.getSessionFile?.() || ctx?.sessionPath || "";
  const match = String(sessionPath).match(/[\\/]agents[\\/]([^\\/]+)[\\/]sessions[\\/]/i);
  return match ? match[1] : "";
}

// ── 天气惰性刷新 ──
// 每 15 分钟检查一次：配置了居住地 + 缓存过期 → 后台查一次天气写缓存。
// 注入只同步读缓存，刷新永不阻塞对话。
function startWeatherRefresher() {
  if (weatherTimer) return; // 防重复
  const check = () => {
    try {
      const data = getData();
      const settings = data.getSettings();
      if (settings.weatherEnabled === false) return; // 用户主动关闭天气时不查询
      const weatherConfig = resolveWeatherLocation(settings);
      const loc = weatherConfig.location;
      if (!loc) return; // 没配置就不查
      const cache = data.getWeatherCache();
      const now = new Date();
      // 缓存有效（同地点 + 未过期）→ 不用查；旧地点文字也能命中
      if (weatherCacheMatches(cache, settings) && weatherCacheIsFresh(cache, settings, now)) return;
      // 过期/没有 → 后台查（失败静默，下次再试）。没有宿主网络能力时不出网。
      const fetcher = getConfiguredWeatherFetcher();
      if (typeof fetcher !== "function") return;
      getWeatherForInject({
        data,
        location: loc,
        coordinates: weatherConfig.coordinates,
        now: new Date(now),
        fetcher,
      })
        .then((r) => {
          if (r) {
            logInfo(`天气已刷新：${r.place} · ${r.line}`);
          }
        })
        .catch(() => {});
    } catch {
      // 刷新失败静默
    }
  };
  check(); // 启动即检查一次
  weatherTimer = setInterval(check, 15 * 60 * 1000);
  weatherTimer.unref?.();
}
