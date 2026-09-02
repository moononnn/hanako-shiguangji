// 拾光记 · 待办提醒时间
// 待办必须带一个具体时间点或时间段；起止相同表示准点提醒。

const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const CN_DIGITS = Object.freeze({ 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 });
const PERIOD_TEXT = "(?:凌晨|早上|上午|中午|下午|傍晚|晚上|夜里|夜间)";
const CLOCK_TOKEN = "(?:\\d{1,2}|[零〇一二两三四五六七八九十]{1,3})";
const MINUTE_TOKEN = "(?:半|\\d{1,2}|[零〇一二两三四五六七八九十]{1,3})";
const MERIDIEM_COLON_RE = new RegExp("(" + PERIOD_TEXT + ")\\s*(\\d{1,2}):([0-5]\\d)", "i");
const MERIDIEM_TIME_RE = new RegExp(
  "(" + PERIOD_TEXT + ")\\s*(" + CLOCK_TOKEN + ")\\s*(?:点|點)(?:钟|鐘)?(?:\\s*(" + MINUTE_TOKEN + ")\\s*(?:分|分钟)?)?",
  "i",
);
const RANGE_COLON_TAIL_RE = new RegExp(
  "^\\s*(?:到|至|[-~～—])\\s*(?:" + "(" + PERIOD_TEXT + ")\\s*)?(\\d{1,2}):([0-5]\\d)",
  "i",
);
const RANGE_TIME_TAIL_RE = new RegExp(
  "^\\s*(?:到|至|[-~～—])\\s*(?:" + "(" + PERIOD_TEXT + ")\\s*)?(" + CLOCK_TOKEN + ")\\s*(?:点|點)(?:钟|鐘)?(?:\\s*(" + MINUTE_TOKEN + ")\\s*(?:分|分钟)?)?",
  "i",
);
const COLON_TIME_RE = /(?:^|[^0-9])((?:[01]?\d|2[0-3])):([0-5]\d)(?![0-9])/g;
const PLAIN_24H_RE = new RegExp(
  "(?:^|[^0-9])((?:1[3-9]|2[0-3]))\\s*(?:点|點)(?:钟|鐘)?(?:\\s*(" + MINUTE_TOKEN + ")\\s*(?:分|分钟)?)?",
  "i",
);
// 没写上午/下午的“9点”也属于明确准点；当天白天语境下 1～6 点按下午时刻；前后/左右等模糊表达仍拒绝。
const BARE_TIME_RE = new RegExp(
  "(?:^|[^0-9])(" + CLOCK_TOKEN + ")\\s*(?:点|點)(?:钟|鐘)?(?:\\s*(" + MINUTE_TOKEN + ")\\s*(?:分|分钟)?)?",
  "i",
);
const AMBIGUOUS_TAIL_RE = /^\s*(?:后|以后|之前|前|左右|前后|一刻(?:钟)?|刻|多(?:一点|钟)?|过)/;
const RANGE_PREFIX_RE = /^\s*(?:到|至|[-~～—])/;
// 同一句里同时写了事情时间和提醒时间时，优先取“提醒”前紧挨着的时刻。
const CLOCK_EXPRESSION = "(?:\\d{1,2}:[0-5]\\d|" + CLOCK_TOKEN + "\\s*(?:点|點)(?:钟|鐘)?(?:\\s*" + MINUTE_TOKEN + "\\s*(?:分|分钟)?)?)";
const REMINDER_CLOCK_EXPRESSION = "(?:(?:" + PERIOD_TEXT + ")\\s*)?" + CLOCK_EXPRESSION;
const TRAILING_REMINDER_TIME_RE = new RegExp(
  "(" + REMINDER_CLOCK_EXPRESSION + "(?:\\s*(?:到|至|[-~～—])\\s*" + REMINDER_CLOCK_EXPRESSION + ")?)\\s*[，,、。；;：:]?$",
  "i",
);

export function normalizeReminderTime(value) {
  const text = String(value ?? "").trim();
  return TIME_RE.test(text) ? text : "";
}

function toMinutes(value) {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function parseNumberToken(value) {
  const text = String(value ?? "").trim();
  if (/^\d+$/.test(text)) return Number(text);
  if (!/^[零〇一二两三四五六七八九十]+$/.test(text)) return NaN;
  if (text.length === 1) return CN_DIGITS[text] ?? NaN;
  if (text === "十") return 10;
  if (text.startsWith("十")) return 10 + (CN_DIGITS[text.slice(1)] ?? NaN);
  if (text.endsWith("十")) return (CN_DIGITS[text.slice(0, -1)] ?? NaN) * 10;
  if (text.length === 3 && text[1] === "十") {
    return (CN_DIGITS[text[0]] ?? NaN) * 10 + (CN_DIGITS[text[2]] ?? NaN);
  }
  return NaN;
}

function formatClock(hour, minute) {
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return "";
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function localDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

// 裸写“两点”在当天白天通常指下午两点；凌晨/下午等明确时段仍由显式解析优先。
// 只对当天启用这个语境判断，避免替用户猜未来日期的上午/下午。
function shouldPreferAfternoonBareTime(targetDate, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime()) || now.getHours() < 6) return false;
  const raw = String(targetDate ?? "").trim();
  let key = "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) key = raw;
  else if (/^\d{2}-\d{2}$/.test(raw)) key = `${now.getFullYear()}-${raw}`;
  return !!key && key === localDateKey(now);
}

function parseBareNaturalClock(hourToken, minuteToken, options = {}) {
  let hour = parseNumberToken(hourToken);
  const minute = minuteToken === "半" ? 30 : minuteToken ? parseNumberToken(minuteToken) : 0;
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute < 0 || minute > 59) return "";
  if (shouldPreferAfternoonBareTime(options.targetDate, options.now) && hour >= 1 && hour <= 6) hour += 12;
  return formatClock(hour, minute);
}

function parseNaturalClock(period, hourToken, minuteToken) {
  let hour = parseNumberToken(hourToken);
  const minute = minuteToken === "半" ? 30 : minuteToken ? parseNumberToken(minuteToken) : 0;
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute < 0 || minute > 59) return "";
  if (period) {
    if (hour < 1 || hour > 12) return "";
    if (["下午", "傍晚", "晚上", "夜里", "夜间"].includes(period)) {
      if (hour === 12 && period !== "下午" && period !== "傍晚") hour = 0;
      else if (hour < 12) hour += 12;
    }
    else if (period === "中午" && hour >= 1 && hour <= 6) hour += 12;
    else if (period === "凌晨" && hour === 12) hour = 0;
  }
  return formatClock(hour, minute);
}

function rangeResult(start, end) {
  if (!start || !end || toMinutes(start) > toMinutes(end)) return null;
  return { reminderStart: start, reminderEnd: end };
}

function hasAmbiguousTail(value) {
  return AMBIGUOUS_TAIL_RE.test(String(value ?? ""));
}

function hasRangePrefix(value) {
  return RANGE_PREFIX_RE.test(String(value ?? ""));
}

function parseMeridiemColon(text) {
  const match = text.match(MERIDIEM_COLON_RE);
  if (!match) return null;
  const start = parseNaturalClock(match[1], match[2], match[3]);
  if (!start) return null;
  const tail = text.slice((match.index ?? 0) + match[0].length);
  const endMatch = tail.match(RANGE_COLON_TAIL_RE);
  if (!endMatch && (hasAmbiguousTail(tail) || hasRangePrefix(tail))) return null;
  const remaining = endMatch ? tail.slice(endMatch[0].length) : "";
  if (hasAmbiguousTail(remaining) || hasRangePrefix(remaining)) return null;
  const end = endMatch
    ? parseNaturalClock(endMatch[1] || match[1], endMatch[2], endMatch[3])
    : start;
  return rangeResult(start, end);
}

function parseMeridiemText(text) {
  const match = text.match(MERIDIEM_TIME_RE);
  if (!match) return null;
  const start = parseNaturalClock(match[1], match[2], match[3]);
  if (!start) return null;
  const tail = text.slice((match.index ?? 0) + match[0].length);
  const endMatch = tail.match(RANGE_TIME_TAIL_RE);
  if (!endMatch && (hasAmbiguousTail(tail) || hasRangePrefix(tail))) return null;
  const remaining = endMatch ? tail.slice(endMatch[0].length) : "";
  if (hasAmbiguousTail(remaining) || hasRangePrefix(remaining)) return null;
  const end = endMatch
    ? parseNaturalClock(endMatch[1] || match[1], endMatch[2], endMatch[3])
    : start;
  return rangeResult(start, end);
}

export function parseTodoReminderText(value, options = {}) {
  const text = String(value ?? "").trim();
  if (!text) return null;

  const reminderIndex = text.indexOf("提醒");
  if (reminderIndex > 0) {
    const beforeReminder = text.slice(0, reminderIndex).trim();
    const reminderMatch = beforeReminder.match(TRAILING_REMINDER_TIME_RE);
    if (reminderMatch) {
      const reminderTime = parseTodoReminderText(reminderMatch[1], options);
      if (reminderTime) return reminderTime;
    }
  }

  const meridiemColon = parseMeridiemColon(text);
  if (meridiemColon) return meridiemColon;
  const meridiem = parseMeridiemText(text);
  if (meridiem) return meridiem;

  const colonMatches = Array.from(text.matchAll(COLON_TIME_RE));
  if (colonMatches.length) {
    const last = colonMatches[colonMatches.length - 1];
    const tail = text.slice((last.index ?? 0) + last[0].length);
    if (hasAmbiguousTail(tail) || hasRangePrefix(tail)) return null;
    const start = formatClock(Number(colonMatches[0][1]), Number(colonMatches[0][2]));
    const end = colonMatches[1]
      ? formatClock(Number(colonMatches[1][1]), Number(colonMatches[1][2]))
      : start;
    return rangeResult(start, end);
  }

  const plain = text.match(PLAIN_24H_RE);
  if (plain) {
    const tail = text.slice((plain.index ?? 0) + plain[0].length);
    if (hasAmbiguousTail(tail) || hasRangePrefix(tail)) return null;
    const start = parseNaturalClock("", plain[1], plain[2]);
    return start ? { reminderStart: start, reminderEnd: start } : null;
  }

  const bare = text.match(BARE_TIME_RE);
  if (bare) {
    const tail = text.slice((bare.index ?? 0) + bare[0].length);
    if (hasAmbiguousTail(tail) || hasRangePrefix(tail)) return null;
    const start = parseBareNaturalClock(bare[1], bare[2], options);
    return start ? { reminderStart: start, reminderEnd: start } : null;
  }
  return null;
}

export function normalizeTodoReminderWindow(start, end) {
  const reminderStart = normalizeReminderTime(start);
  const reminderEnd = normalizeReminderTime(end);
  if (!reminderStart || !reminderEnd) {
    throw new Error("待办需要选择提醒时间（具体时间或时间段）");
  }
  if (toMinutes(reminderStart) > toMinutes(reminderEnd)) {
    throw new Error("提醒时间段的开始不能晚于结束");
  }
  return { reminderStart, reminderEnd };
}

export function formatTodoReminderWindow(start, end) {
  const reminderStart = normalizeReminderTime(start);
  const reminderEnd = normalizeReminderTime(end);
  if (!reminderStart || !reminderEnd) return "";
  return reminderStart === reminderEnd
    ? `${reminderStart} 准点`
    : `${reminderStart}–${reminderEnd}`;
}
