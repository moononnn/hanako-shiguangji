// 拾光记 · DeepSeek 峰谷时段
// 只负责模型识别、北京时间峰谷计算和会话级触发判定；不负责生成用户可见文案。

export const DEEPSEEK_TIME_ZONE = "Asia/Shanghai";
export const DEEPSEEK_PREVIEW_MINUTES = 5;

const WEEKDAY_NAMES = Object.freeze({
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
});

const WORKDAY_BOUNDARIES = Object.freeze([
  { minute: 9 * 60, period: "peak" },
  { minute: 12 * 60, period: "valley" },
  { minute: 14 * 60, period: "peak" },
  { minute: 18 * 60, period: "valley" },
]);

function pad2(value) {
  return String(value).padStart(2, "0");
}

function formatTime(minute) {
  return `${pad2(Math.floor(minute / 60))}:${pad2(minute % 60)}`;
}

function formatParts(now, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const weekday = WEEKDAY_NAMES[values.weekday];
  if (weekday === undefined) throw new Error(`无法解析时区日期：${values.weekday}`);
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    weekday,
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

function dateKeyFromParts(parts) {
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

function shiftDateKey(dayKey, deltaDays) {
  const base = new Date(`${dayKey}T12:00:00Z`);
  base.setUTCDate(base.getUTCDate() + deltaDays);
  return `${base.getUTCFullYear()}-${pad2(base.getUTCMonth() + 1)}-${pad2(base.getUTCDate())}`;
}

function weekdayForDateKey(dayKey) {
  const base = new Date(`${dayKey}T12:00:00Z`);
  return base.getUTCDay();
}

function boundariesForWeekday(weekday) {
  return weekday === 0 || weekday === 6 ? [] : WORKDAY_BOUNDARIES;
}

function periodFor(weekday, minuteOfDay) {
  if (weekday === 0 || weekday === 6) return "valley";
  const morningPeak = minuteOfDay >= 9 * 60 && minuteOfDay < 12 * 60;
  const afternoonPeak = minuteOfDay >= 14 * 60 && minuteOfDay < 18 * 60;
  return morningPeak || afternoonPeak ? "peak" : "valley";
}

function periodLabel(period) {
  return period === "peak" ? "高峰时段" : "谷时段";
}

function boundaryInfo(dayKey, boundary) {
  return {
    key: `${dayKey}@${formatTime(boundary.minute)}`,
    dayKey,
    at: formatTime(boundary.minute),
    period: boundary.period,
    periodLabel: periodLabel(boundary.period),
  };
}

function findPreviousBoundary(dayKey, minuteOfDay) {
  // 最多向前找一周，足以跨过周末和工作日夜间的连续谷时段。
  for (let offset = 0; offset <= 7; offset += 1) {
    const candidateDay = shiftDateKey(dayKey, -offset);
    const weekday = weekdayForDateKey(candidateDay);
    const boundaries = boundariesForWeekday(weekday);
    const limit = offset === 0 ? minuteOfDay : Number.POSITIVE_INFINITY;
    const candidates = boundaries.filter((boundary) => boundary.minute <= limit);
    if (candidates.length) {
      return boundaryInfo(candidateDay, candidates[candidates.length - 1]);
    }
  }
  return null;
}

function boundariesBetween(lastSeenAt, now, timeZone) {
  if (!Number.isFinite(Number(lastSeenAt))) return [];
  const start = formatParts(new Date(Number(lastSeenAt)), timeZone);
  const end = formatParts(now, timeZone);
  const startDay = dateKeyFromParts(start);
  const endDay = dateKeyFromParts(end);
  if (startDay > endDay) return [];
  const startMinute = start.hour * 60 + start.minute;
  const endMinute = end.hour * 60 + end.minute;
  const result = [];
  let dayKey = startDay;
  for (let guard = 0; guard <= 370 && dayKey <= endDay; guard += 1) {
    const weekday = weekdayForDateKey(dayKey);
    const lower = dayKey === startDay ? startMinute : -1;
    const upper = dayKey === endDay ? endMinute : 24 * 60;
    for (const boundary of boundariesForWeekday(weekday)) {
      if (boundary.minute > lower && boundary.minute <= upper) {
        result.push(boundaryInfo(dayKey, boundary));
      }
    }
    if (dayKey === endDay) break;
    dayKey = shiftDateKey(dayKey, 1);
  }
  return result;
}

// 预告状态按边界 key 保留最近一小段，兼容旧版只有 dsPreviewKey 的会话状态。
function previewKeysFromState(lastState) {
  const values = Array.isArray(lastState?.dsPreviewKeys) ? [...lastState.dsPreviewKeys] : [];
  if (lastState?.dsPreviewKey) values.push(lastState.dsPreviewKey);
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))].slice(-16);
}

function appendPreviewKey(keys, key) {
  if (!key) return keys;
  return [...new Set([...keys, key])].slice(-16);
}

function collectModelStrings(model, depth = 0, seen = new Set()) {
  if (model === null || model === undefined || depth > 2) return [];
  if (typeof model === "string" || typeof model === "number") return [String(model)];
  if (typeof model !== "object" || seen.has(model)) return [];
  seen.add(model);
  const values = [];
  const fields = [
    "provider",
    "providerId",
    "id",
    "modelId",
    "name",
    "label",
    "modelName",
    "baseUrl",
  ];
  for (const field of fields) {
    const value = model[field];
    if (typeof value === "string" || typeof value === "number") values.push(String(value));
  }
  for (const field of ["model", "providerInfo", "providerConfig"]) {
    values.push(...collectModelStrings(model[field], depth + 1, seen));
  }
  return values;
}

export function modelFingerprint(model) {
  return [...new Set(collectModelStrings(model).map((value) => value.trim()).filter(Boolean))]
    .join("/")
    .toLowerCase()
    .slice(0, 600);
}

export function isDeepSeekModel(model) {
  return collectModelStrings(model).some((value) => /deepseek/i.test(value));
}

export function getDeepSeekTimeInfo(now = new Date(), options = {}) {
  const timeZone = options.timeZone || DEEPSEEK_TIME_ZONE;
  const previewMinutes = Number.isFinite(Number(options.previewMinutes))
    ? Math.max(1, Number(options.previewMinutes))
    : DEEPSEEK_PREVIEW_MINUTES;
  const parts = formatParts(now, timeZone);
  const dayKey = dateKeyFromParts(parts);
  const minuteOfDay = parts.hour * 60 + parts.minute + parts.second / 60;
  const period = periodFor(parts.weekday, minuteOfDay);
  const boundaries = boundariesForWeekday(parts.weekday);
  const nextBoundaryRaw = boundaries.find((boundary) => boundary.minute > minuteOfDay);
  const nextBoundary = nextBoundaryRaw ? boundaryInfo(dayKey, nextBoundaryRaw) : null;
  const minutesUntilNext = nextBoundaryRaw ? nextBoundaryRaw.minute - minuteOfDay : null;
  const previousBoundary = findPreviousBoundary(dayKey, Math.floor(minuteOfDay));
  const isWeekend = parts.weekday === 0 || parts.weekday === 6;

  return {
    dayKey,
    weekday: parts.weekday,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
    currentTime: `${pad2(parts.hour)}:${pad2(parts.minute)}`,
    minuteOfDay,
    period,
    periodLabel: periodLabel(period),
    isWeekend,
    nextBoundary,
    previousBoundary,
    minutesUntilNext,
    preview: Boolean(nextBoundary && minutesUntilNext > 0 && minutesUntilNext <= previewMinutes),
    previewMinutes: nextBoundary && minutesUntilNext > 0 ? Math.ceil(minutesUntilNext) : null,
    timeZone,
  };
}

/**
 * 按单个聊天框决定是否需要把 DeepSeek 峰谷关照硬带进本轮上下文。
 * `lastState` 由 InjectionTracker 挂在当前 sessionId 下，重启后丢失是可接受的。
 */
export function decideDeepSeekNotice({
  model,
  now = new Date(),
  lastState = null,
  previewMinutes = DEEPSEEK_PREVIEW_MINUTES,
  timeZone = DEEPSEEK_TIME_ZONE,
} = {}) {
  const active = isDeepSeekModel(model);
  const fingerprint = modelFingerprint(model);
  if (!active) {
    return {
      should: false,
      reason: "not-deepseek",
      notice: null,
      state: {
        dsActive: false,
        dsModelKey: fingerprint,
        dsPeriod: null,
        dsLastSeenAt: now.getTime(),
      },
    };
  }

  const info = getDeepSeekTimeInfo(now, { previewMinutes, timeZone });
  const wasActive = lastState?.dsActive === true;
  const previewedKeys = previewKeysFromState(lastState);
  const periodChanged = wasActive && lastState?.dsPeriod && lastState.dsPeriod !== info.period;
  const previewKey = info.nextBoundary?.key || "";
  const previewDue = info.preview && !previewedKeys.includes(previewKey);
  const crossedBoundaries = wasActive
    ? boundariesBetween(lastState?.dsLastSeenAt, now, timeZone)
    : [];
  const missedBoundary = crossedBoundaries.some((boundary) => !previewedKeys.includes(boundary.key));
  const alreadyPreviewedPreviousTransition = periodChanged &&
    info.previousBoundary?.key &&
    previewedKeys.includes(info.previousBoundary.key);
  const transitionNeedsReport = missedBoundary || (periodChanged && !alreadyPreviewedPreviousTransition);

  let should = false;
  let reason = "same-period";
  let kind = "same-period";
  if (!wasActive) {
    should = true;
    reason = info.preview ? "detected-preview" : "detected";
    kind = info.preview ? "detected-preview" : "detected";
  } else if (previewDue) {
    should = true;
    reason = transitionNeedsReport ? "transition-preview" : "preview";
    kind = transitionNeedsReport ? "transition-preview" : "preview";
  } else if (transitionNeedsReport) {
    // 没赶上提前 5 分钟的聊天回合时，下一次回复补报当前已经进入的新时段。
    should = true;
    reason = "period-entered";
    kind = "entered";
  }

  const nextPreviewKeys = previewDue
    ? appendPreviewKey(previewedKeys, previewKey)
    : previewedKeys;
  return {
    should,
    reason,
    notice: should
      ? {
          kind,
          ...info,
          modelKey: fingerprint,
        }
      : null,
    state: {
      dsActive: true,
      dsModelKey: fingerprint,
      dsPeriod: info.period,
      dsPreviewKey: previewDue ? previewKey : (lastState?.dsPreviewKey || ""),
      dsPreviewKeys: nextPreviewKeys,
      dsLastSeenAt: now.getTime(),
    },
  };
}
