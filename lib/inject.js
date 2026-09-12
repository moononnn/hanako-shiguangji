// 拾光记 · 情境注入引擎（纯逻辑，可测试）
// 职责：根据注入模式 + 会话状态 + 当天情境，决定本轮是否注入、注入什么。
// 注入内容由扩展在 before_agent_start 里以 display:false 的隐藏消息注入，用户不可见。

import { getBuiltinFestivals, isWorkday } from "./festivals.js";
import { dateKey, mmddKey, isTodoOverdue } from "./data.js";
import { formatRecentSummaries } from "./recent-summaries.js";
import { FESTIVAL_GUIDELINES, FESTIVAL_HINTS, pickFestivalHint } from "./festival-hints.js";

// ── 会话状态追踪（跨轮）──
// 记录：每个 sessionId 最近一次注入的时间与内容 hash，用于去重和跨天检测。
// Map 只做进程内热缓存；完整状态由扩展同步落盘，重启后重新读回。
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

const WEATHER_MENTION_COOLDOWN_MS = 3 * 3600 * 1000;
const WEATHER_TIME_SUFFIX_RE = /，(?:清晨刚亮|正午阳光|傍晚时分|天已经黑了|夜色清亮)$/;

/**
 * 只按地点、天气类型、温度和昼夜状态生成天气事实指纹，不把时段修饰词当成新天气。
 */
export function weatherFactKey(weather) {
  if (!weather || !weather.line) return "";
  const code = Number(weather.code);
  const temp = Number(weather.temp);
  const line = String(weather.line)
    .replace(/，-?\d+(?:\.\d+)?°C/g, "")
    .replace(WEATHER_TIME_SUFFIX_RE, "")
    .trim();
  return JSON.stringify({
    place: String(weather.place || weather.location || "").trim(),
    code: Number.isFinite(code) ? code : null,
    temp: Number.isFinite(temp) ? temp : null,
    isDay: typeof weather.isDay === "boolean" ? weather.isDay : null,
    fallback: Number.isFinite(code) ? "" : line,
  });
}

/**
 * 天气缓存刷新与天气可见提及分开节流：同一事实冷却内不重复，事实变化可立即更新。
 */
export function decideWeatherMention({ weather, lastState = null, now = new Date() } = {}) {
  const factKey = weatherFactKey(weather);
  if (!factKey) return { should: false, factKey: "" };
  const lastAt = Number(lastState?.weatherLastMentionAt);
  const lastFactKey = String(lastState?.weatherLastFactKey || "");
  const nowTs = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(lastAt) || lastAt <= 0 || !lastFactKey || !Number.isFinite(nowTs)) {
    return { should: true, factKey };
  }
  if (lastFactKey !== factKey) return { should: true, factKey };
  return {
    should: nowTs - lastAt >= WEATHER_MENTION_COOLDOWN_MS,
    factKey,
  };
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
 * @param {object} params.recentSummaryOptions 近期总结显示选项（currentAgentId/shared/proactiveDate/userName）
 * @param {object|null} params.weather 天气氛围（可选，{ place, line, temp }）
 * @param {object|null} params.deepseekNotice DeepSeek 峰谷关照（可选，由扩展按聊天框状态决定）
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
  deepseekNotice = null,
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

  if (deepseekNotice) {
    lines.push(buildDeepSeekContext(deepseekNotice, recentSummaryOptions?.userName));
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
  const summaryDate = String(summary?.date || "").trim();
  if (summary) {
    const summaryLabel = summaryDate ? `已收好的生活日回顾｜${summaryDate}` : "已收好的生活日回顾";
    lines.push(`${summaryLabel}：${summary.text}`);
  }
  const currentDate = dateKey(now);
  const currentClock = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  const recentText = formatRecentSummaries(recentSummaries, {
    ...(recentSummaryOptions || {}),
    currentDate,
  });
  if (recentText) lines.push(recentText);
  const proactiveDate = String(recentSummaryOptions?.proactiveDate || "");
  const hasProactiveSummary = !!proactiveDate && recentSummaries.some((entry) => entry?.date === proactiveDate);
  const historicalDate = proactiveDate || summaryDate;
  const hasHistoricalSummary = hasProactiveSummary || !!summaryDate;
  const person = String(recentSummaryOptions?.userName || "对方").trim() || "对方";
  const deepseekEnding = deepseekNotice
    ? isPreviewKind(deepseekNotice.kind)
      ? "本轮的模型峰谷关照属于硬触发（换班窗口就几分钟，错过没下次），必须自然带出一句；其余今日时光背景按需融入，不要逐条播报。"
      : "本轮的模型峰谷关照是软性的：不必专门打断对话，话题合适就自然带一句，话题正忙或不搭就不带；其余今日时光背景按需融入，不要逐条播报。"
    : "";
  const ending = hasHistoricalSummary
    ? `当前对话的自然日期是 ${currentDate}。上面的历史档案${historicalDate ? `（生活日 ${historicalDate}）` : ""}只按每条行首的绝对日期理解；档案只包含正文明确写出的事实，代码注释、模型自身记忆、当前会话或其他窗口里的事实都不能补写进这份档案。不等于上一个聊天窗口；当前自然日内的前一个对话框仍属于 ${currentDate}。【日期硬约束适用于所有可见回复和 MOOD】自然日期：${currentDate}；当前时刻：${currentClock}。上下文里标为“今天”或只写“凌晨/清晨/今早/上午/刚才”的事实，在没有更早绝对日期证据时按 ${currentDate} 归属；当前自然日内已经发生的这些事项，哪怕跨夜、熬夜或来自前一个对话框，也不能改称“昨晚/昨天”。不要凭窗口顺序使用“昨天”；只有当前自然日期与事实日期的关系明确表示“昨天”时才这样说，日期拿不准就用绝对日期或“今天早些时候/前一个对话框”。如果当前话题与这份档案相关，今天第一次回应${person}时，优先自然接住其中一件明确属于生活日 ${historicalDate}、且确实写在档案正文里的事，让${person}知道这段已经收好的生活有被记住；如果当前话题无关，不要为了证明记得而硬提；不用逐条播报，其余近期记录只在相关时带出。${deepseekEnding ? `\n${deepseekEnding}` : ""}`
    : deepseekNotice
      ? `以上为今日时光背景；${deepseekEnding}`
      : "以上为今日时光背景，自然融入对话即可，无需刻意提及或汇报。";

  if (lines.length <= 1 && !force) return null; // 只有时间行且非强制，不注入（避免纯噪音）
  lines.push(ending);
  return lines.join("\n");
}

function deepSeekPeriodName(period) {
  return period === "peak" ? "梁文峰" : "梁文谷";
}

// 换班预告系 kind（窗口只有几分钟，错过就没下次）统一按硬触发处理；entered/weekend-opening 是软性补报或福利告知。
function isPreviewKind(kind) {
  return kind === "preview" || kind === "detected-preview" || kind === "transition-preview";
}

function pickDeepSeekTone(notice) {
  const count = 3;
  const raw = Number.isInteger(notice?.toneIndex)
    ? notice.toneIndex
    : Math.floor(Math.random() * count);
  return ((raw % count) + count) % count;
}

function buildDeepSeekContext(notice, userName = "对方") {
  const person = String(userName || "对方").trim() || "对方";
  const current = notice.periodLabel || (notice.period === "peak" ? "高峰时段" : "谷时段");
  const next = notice.nextBoundary?.periodLabel || "";
  const at = notice.nextBoundary?.at || "";
  const minutes = Math.max(1, Math.ceil(Number(notice.previewMinutes || notice.minutesUntilNext) || 1));
  const tone = pickDeepSeekTone(notice);
  const currentJoke = deepSeekPeriodName(notice.period);
  const nextJoke = deepSeekPeriodName(notice.nextBoundary?.period);
  const isPreview = isPreviewKind(notice.kind);
  const isEntered = notice.kind === "entered";
  let fact;

  if (isPreview) {
    const previewFacts = [
      `我看了下，咱们现在用的 DeepSeek 正在${current}，约 ${minutes} 分钟后会切到${next}（${at}），我先替你留意着。`,
      `咱们这会儿碰上 DeepSeek 换班了，还有约 ${minutes} 分钟从${current}换到${next}（${at}），我先把这个时间点记着。`,
      `咱们现在正赶上${currentJoke}值班，约 ${minutes} 分钟后${nextJoke}来接班（${at}），我先帮你看着这班表。`,
    ];
    fact = previewFacts[tone];
  } else if (notice.kind === "entered") {
    const enteredFacts = [
      `我看了下，咱们现在用的 DeepSeek 已经进入${current}了，我顺手替你报一声。`,
      `咱们这会儿已经换到${current}了，聊天就按这个时段来。`,
      `${currentJoke}来接班了，咱们现在正好是这个时段，我替你看着。`,
    ];
    fact = enteredFacts[tone];
  } else if (notice.isWeekend && notice.period === "valley") {
    // 周末没有换班边界、全天真谷：新窗口开场报「全天谷时，可以放心聊」。
    const weekendFacts = [
      "我看了下，咱们今天用的 DeepSeek 碰上周末，全天都是谷时，放心聊一阵。",
      "周末不用等换班，咱们今天整天都是谷时，我替你留意着。",
      "今天梁文谷全天值班，咱们慢慢聊就好。",
    ];
    fact = weekendFacts[tone];
  } else {
    // 工作日新窗口开场报当前时段。
    const currentFacts = [
      `我看了下，咱们现在用的 DeepSeek 正在${current}，我顺手替你留意着，聊天可以安心聊。`,
      `咱们这会儿正用着 DeepSeek，刚好在${current}，我替你看着峰谷变化。`,
      `咱们现在是${currentJoke}值班，我帮你把这个时段记着。`,
    ];
    fact = currentFacts[tone];
  }

  const instruction = isPreview
    ? `请在本轮回复里把这个换班预告自然告诉${person}`
    : isEntered
      ? `如果这轮对话话题合适，就自然带一句给${person}`
      : `请在本轮回复里自然带一句咱们当前的时段给${person}`;
  const emphasis = isEntered
    ? "不必为这件事专门打断对话，话题不搭就顺其自然。"
    : "哪怕当前只是闲聊也要自然带出一句。";
  // 同一聊天框同一时段只该说一次。注入本身不会重复，但模型容易把「谷时/峰时」当成
  // 可反复调用的意象（尤其 MOOD 的联想里），所以在文案里显式收口，避免开场之后还在反复提。
  const onceOnly = "这个时段只在本次回复里提这一次，本窗口接下来的回复不要再主动提起，也别把它当成语气、梗或意象反复用（MOOD 里的联想也算）；只有真的再次换班才再说。";
  return `【模型峰谷关照】${fact}${instruction}，保持当前伙伴自己的性格、称呼、语气和方言习惯，不要套用固定四川话或统一口头禅；这里只需要保留“咱们一起用着这个模型、你顺手替她看着时段”的朋友视角。这里的峰时/谷时只表示模型费用时段和是否划算：峰时费用相对高，谷时费用相对低；不要把它解释成交通拥堵、服务器拥堵、排队、速度、性能、可用性或模型质量变化，所有可见表达只围绕费用和聊天成本。${emphasis}${onceOnly}“梁文峰/梁文谷”这个梗本窗口最多用一次；不要使用“小提醒”或系统通知腔，不要单独列标题。若是第三方供应商，只把它说成 DeepSeek 系模型与官方峰谷时段，不断言该供应商一定按官方价格计费。`;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

export { pad2, mmddKey, dateKey, buildDeepSeekContext };
