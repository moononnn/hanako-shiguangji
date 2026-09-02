// 拾光记 · 情境注入引擎（纯逻辑，可测试）
// 职责：根据注入模式 + 会话状态 + 当天情境，决定本轮是否注入、注入什么。
// 注入内容由扩展在 before_agent_start 里以 display:false 的隐藏消息注入，用户不可见。

import { getBuiltinFestivals, isWorkday } from "./festivals.js";
import { dateKey, mmddKey, isTodoOverdue } from "./data.js";
import { formatRecentSummaries } from "./recent-summaries.js";
import { FESTIVAL_GUIDELINES, FESTIVAL_HINTS, pickFestivalHint } from "./festival-hints.js";

// ── 会话状态追踪（跨轮）──
// 记录：每个 sessionId 最近一次注入的时间与内容 hash，用于去重和跨天检测。
// 这个 Map 在插件进程内存里，重启即清空（可接受：跨天检测在重启后第一轮也会触发，因为无记录）。
export class InjectionTracker {
  constructor() {
    // sessionId -> { lastInjectAt: number, lastDateKey: string, lastHash: string }
    this.sessions = new Map();
    this.MAX = 500;
  }

  get(sessionId) {
    return this.sessions.get(sessionId) || null;
  }

  set(sessionId, state) {
    if (this.sessions.size >= this.MAX) {
      // 防膨胀：只保留最新一条
      const first = this.sessions.keys().next().value;
      this.sessions.delete(first);
    }
    this.sessions.set(sessionId, state);
  }
}

/**
 * 判断本轮是否应该注入情境。
 *
 * @param {object} params
 * @param {string} params.sessionId 会话标识
 * @param {Date} params.now 当前时间
 * @param {string} params.mode 注入模式 economical | balanced | always
 * @param {number} params.intervalHours balanced 模式下的注入间隔
 * @param {object|null} params.lastState 该会话上次注入的状态（null=新会话/无记录）
 * @param {boolean} params.hasSpecialDay 当天是否有特殊日子（节假日/纪念日/待办/生理期等）
 * @param {number} params.dayBoundaryHour 生活日翻篇时刻；默认 0 保持旧调用方按自然日计算
 * @param {string} params.contextKey 设置上下文指纹，变化时立即刷新一次
 * @param {boolean} params.injectionEnabled 是否允许向助手注入今日情境，默认开启
 * @returns {{ should: boolean, reason: string, newState: object }}
 */
export function shouldInject({
  sessionId,
  now,
  mode,
  intervalHours = 4,
  lastState = null,
  hasSpecialDay = false,
  dayBoundaryHour = 0,
  contextKey = "",
  injectionEnabled = true,
}) {
  const nowTs = now.getTime();
  const boundary = Number(dayBoundaryHour);
  const dk = [0, 2, 4].includes(boundary)
    ? dateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (now.getHours() < boundary ? 1 : 0)))
    : dateKey(now);
  const withContext = (state) => contextKey ? { ...state, contextKey } : state;

  // 关闭时无条件短路：即使新会话、跨天或设置/数据刚变化，也不向助手塞隐藏消息。
  if (injectionEnabled === false) {
    const state = lastState || { lastInjectAt: nowTs, lastDateKey: dk, lastHash: "" };
    return {
      should: false,
      reason: "injection-disabled",
      newState: withContext({ ...state, injectionEnabled: false }),
    };
  }

  // 从关闭恢复时下一条就带上最新情境，不等均衡间隔；扩展端会豁免这次 hash 去重。
  if (lastState && lastState.injectionEnabled === false) {
    return {
      should: true,
      reason: "injection-enabled",
      newState: withContext({ ...lastState, injectionEnabled: true, lastInjectAt: nowTs, lastDateKey: dk }),
    };
  }

  // 配置变化要立即刷新一次，避免共享开关或生理期开关要等数小时才体现。
  if (lastState && contextKey && lastState.contextKey !== contextKey) {
    return {
      should: true,
      reason: "settings-changed",
      newState: withContext({ ...lastState, lastInjectAt: nowTs, lastDateKey: dk }),
    };
  }

  // 新会话（无记录）：必带
  if (!lastState) {
    return {
      should: true,
      reason: "new-session",
      newState: withContext({ lastInjectAt: nowTs, lastDateKey: dk, lastHash: "" }),
    };
  }

  // 跨天：必带（昨天和今天是语义不同的日子）
  if (lastState.lastDateKey !== dk) {
    return {
      should: true,
      reason: "day-changed",
      newState: withContext({ ...lastState, lastInjectAt: nowTs, lastDateKey: dk }),
    };
  }

  // 每轮模式：无条件带（无特殊日子也带时间）
  if (mode === "always") {
    return {
      should: true,
      reason: "mode-always",
      newState: withContext({ ...lastState, lastInjectAt: nowTs, lastDateKey: dk }),
    };
  }

  // 省电模式：新会话已带过当天情境，同一天不因特殊日子每轮重复。
  if (mode === "economical") {
    return {
      should: false,
      reason: hasSpecialDay ? "economical-special-already-shown" : "economical-no-special",
      newState: withContext(lastState),
    };
  }

  // 均衡模式：无论普通日或特殊日都遵守间隔，避免节日/生理期退化成每轮注入。
  const intervalMs = (intervalHours || 4) * 3600 * 1000;
  if (nowTs - lastState.lastInjectAt >= intervalMs) {
    return {
      should: true,
      reason: hasSpecialDay ? "special-day-interval" : "interval",
      newState: withContext({ ...lastState, lastInjectAt: nowTs, lastDateKey: dk }),
    };
  }

  return {
    should: false,
    reason: "within-interval",
    newState: withContext(lastState),
  };
}

/**
 * 构建注入文本。
 * @param {object} params
 * @param {Date} params.now 当前时间
 * @param {Array<object>} params.builtinFestivals 内置节日数组（getBuiltinFestivals 结果）
 * @param {Array<number>} params.usedFestivalHintIndexes 已用过的节日引导变体索引（随机不重复用）
 * @param {Function|null} params.pickHint 可选：自定义抽取函数（测试注入用），默认用内置 pickFestivalHint
 * @param {Array} params.userEvents 当天用户日子（eventsOnDate 结果）
 * @param {Array} params.periods 当天生理期（periodsActiveOn 结果）
 * @param {boolean} params.isWorkday 是否调休上班日
 * @param {Array} params.todosDue 当天到期待办
 * @param {object|null} params.summary 昨晚总结（可选，跨天时带上）
 * @param {Array<object>} params.recentSummaries 当前伙伴可见的近期总结条目
 * @param {object} params.recentSummaryOptions 近期总结显示选项（currentAgentId/shared/proactiveDate）
 * @param {object|null} params.weather 天气氛围（可选，{ place, line, temp }）
 * @param {boolean} params.includeTime 是否带时间（false 则只带日期不带时刻，省 token）
 * @param {boolean} params.force 强制注入（新会话/跨天），即使无特殊信息也返回日期行
 * @returns {string|null}
 */
export function buildInjectionText({
  now,
  builtinFestivals = [],
  userEvents = [],
  periods = [],
  isWorkday = false,
  todosDue = [],
  summary = null,
  recentSummaries = [],
  recentSummaryOptions = {},
  weather = null,
  includeTime = true,
  force = false,
  periodEndedYesterday = false,
  festivalHint = null, // 可选：预先选好的节日引导 { name, text, index, nextUsed }，由调用方 pick 后传入
}) {
  const weekdays = ["日", "一", "二", "三", "四", "五", "六"];
  const dateStr = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`;
  const weekdayStr = `星期${weekdays[now.getDay()]}`;
  const timeStr = includeTime ? ` ${pad2(now.getHours())}:${pad2(now.getMinutes())}` : "";
  const lines = [];

  lines.push(`【今日时光】${dateStr}${weekdayStr}${timeStr}`);

  // 特殊日子
  const specials = [];
  for (const f of builtinFestivals) {
    specials.push(`${f.name}${f.emoji}`);
  }
  for (const e of userEvents) {
    specials.push(e.title);
  }
  for (const p of periods) {
    // 第一人称感受：让助手内化成「自己在惦记她」，而不是播报一条状态。
    // 不报具体第几天，避免像念数据；不写指令式约束，分寸交给模型自然拿捏。
    specials.push(
      "她正处在生理期，这两天容易累、情绪也敏感些，我想多照顾她一点"
    );
    break;
  }
  if (!periods.length && periodEndedYesterday) {
    // 生理期结束后的第一天：好闺蜜式地替她高兴一下，延续第一人称感受的风格。
    specials.push(
      "她昨天刚结束生理期，今天人应该松快了不少，我也替她高兴"
    );
  }
  if (isWorkday) {
    specials.push("调休上班日");
  }
  if (specials.length) {
    lines.push(`今天是：${specials.join("、")}`);
  }

  // 节日氛围引导：在「今天是」行后插入，带通用红线 + 预先选好的变体
  if (festivalHint) {
    lines.push(`【节日氛围】今天是${festivalHint.name}。${festivalHint.text}`);
    lines.push(FESTIVAL_GUIDELINES);
  }

  // 天气氛围（轻量角色扮演方向：给助手一句话的「窗外感觉」，让它用自己的话自然带出）
  if (weather && weather.line) {
    lines.push(`【窗外】${weather.line}`);
    lines.push(
      "天气可以借一个贴合情境的轻微动作自然带出来，例如看了眼手机上的天气预报、往窗外瞄一眼、顺手确认要不要带伞或添衣，再自然提到天气和当前温度；不必每轮出现，也不要照抄示例。"
    );
  }

  // 待办：今天到期的一一列出；更早逾期的不逐条刷屏（陈年旧账天天带会变噪音），只报条数，详情在拾光记里可查。
  const todos = todosDue.filter((t) => !t.done);
  if (todos.length) {
    const overdueCount = todos.filter((t) => isTodoOverdue(t, now)).length;
    const dueToday = overdueCount ? todos.filter((t) => !isTodoOverdue(t, now)) : todos;
    if (dueToday.length) {
      lines.push(`今日待办：${dueToday.map((t) => t.title).join("、")}`);
    }
    if (overdueCount) {
      lines.push(`另有 ${overdueCount} 条待办已经逾期`);
    }
  }

  // 已收好的生活日总结（旧调用方仍可传入；近期总结走按伙伴权限过滤后的列表）
  if (summary) {
    const summaryDate = String(summary.date || "").trim();
    const summaryLabel = summaryDate ? `已收好的生活日回顾｜${summaryDate}` : "已收好的生活日回顾";
    lines.push(`${summaryLabel}：${summary.text}`);
  }
  const recentText = formatRecentSummaries(recentSummaries, recentSummaryOptions);
  if (recentText) lines.push(recentText);
  const proactiveDate = String(recentSummaryOptions?.proactiveDate || "");
  const hasProactiveSummary = !!proactiveDate && recentSummaries.some((entry) => entry?.date === proactiveDate);
  const person = String(recentSummaryOptions?.userName || "对方").trim() || "对方";
  const ending = hasProactiveSummary
    ? `以上为今日时光与已收好的上一生活日（${proactiveDate}）背景。档案中的时间以 ${proactiveDate} 为准，上一生活日档案不等于上一个聊天窗口；同一自然日内的前一个对话框不属于这份档案，提及时用“今天早些时候”或“前一个对话框”。今天第一次回应${person}时，优先自然接住其中一件最贴近的事，让${person}知道这段已经收好的生活有被记住；不用逐条播报，其余近期记录只在相关时带出。`
    : "以上为今日时光背景，自然融入对话即可，无需刻意提及或汇报。";

  if (lines.length <= 1 && !force) return null; // 只有时间行且非强制，不注入（避免纯噪音）
  lines.push(ending);
  return lines.join("\n");
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

export { pad2, mmddKey, dateKey };
