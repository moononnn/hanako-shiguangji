// 拾光记 · 待办标题时间识别（浏览器端）
// 与 lib/todo-time.js 保持同一套语义：明确的上午/下午等时段、裸写“9点”、当天白天语境下的“两点”，或 24 小时制时间。

var TODO_TIME_CN_DIGITS = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
var TODO_TIME_PERIOD_TEXT = '(?:凌晨|早上|上午|中午|下午|傍晚|晚上|夜里|夜间)';
var TODO_TIME_CLOCK_TOKEN = '(?:\\d{1,2}|[零〇一二两三四五六七八九十]{1,3})';
var TODO_TIME_MINUTE_TOKEN = '(?:半|\\d{1,2}|[零〇一二两三四五六七八九十]{1,3})';
var TODO_TIME_MERIDIEM_COLON_RE = new RegExp('(' + TODO_TIME_PERIOD_TEXT + ')\\s*(\\d{1,2}):([0-5]\\d)', 'i');
var TODO_TIME_MERIDIEM_RE = new RegExp(
  '(' + TODO_TIME_PERIOD_TEXT + ')\\s*(' + TODO_TIME_CLOCK_TOKEN + ')\\s*(?:点|點)(?:钟|鐘)?(?:\\s*(' + TODO_TIME_MINUTE_TOKEN + ')\\s*(?:分|分钟)?)?',
  'i'
);
var TODO_TIME_RANGE_COLON_RE = new RegExp(
  '^\\s*(?:到|至|[-~～—])\\s*(?:(' + TODO_TIME_PERIOD_TEXT + ')\\s*)?(\\d{1,2}):([0-5]\\d)',
  'i'
);
var TODO_TIME_RANGE_RE = new RegExp(
  '^\\s*(?:到|至|[-~～—])\\s*(?:(' + TODO_TIME_PERIOD_TEXT + ')\\s*)?(' + TODO_TIME_CLOCK_TOKEN + ')\\s*(?:点|點)(?:钟|鐘)?(?:\\s*(' + TODO_TIME_MINUTE_TOKEN + ')\\s*(?:分|分钟)?)?',
  'i'
);
var TODO_TIME_COLON_RE = /(?:^|[^0-9])((?:[01]?\d|2[0-3])):([0-5]\d)(?![0-9])/g;
var TODO_TIME_PLAIN_24H_RE = new RegExp(
  '(?:^|[^0-9])((?:1[3-9]|2[0-3]))\\s*(?:点|點)(?:钟|鐘)?(?:\\s*(' + TODO_TIME_MINUTE_TOKEN + ')\\s*(?:分|分钟)?)?',
  'i'
);
// 没写上午/下午的“9点”也属于明确准点；当天白天语境下 1～6 点按下午时刻；前后/左右等模糊表达仍拒绝。
var TODO_TIME_BARE_TIME_RE = new RegExp(
  '(?:^|[^0-9])(' + TODO_TIME_CLOCK_TOKEN + ')\\s*(?:点|點)(?:钟|鐘)?(?:\\s*(' + TODO_TIME_MINUTE_TOKEN + ')\\s*(?:分|分钟)?)?',
  'i'
);
var TODO_TIME_AMBIGUOUS_TAIL_RE = /^\s*(?:后|以后|之前|前|左右|前后|一刻(?:钟)?|刻|多(?:一点|钟)?|过)/;
var TODO_TIME_RANGE_PREFIX_RE = /^\s*(?:到|至|[-~～—])/;
// 同一句里同时写了事情时间和提醒时间时，优先取“提醒”前紧挨着的时刻。
var TODO_TIME_CLOCK_EXPRESSION = '(?:\\d{1,2}:[0-5]\\d|' + TODO_TIME_CLOCK_TOKEN + '\\s*(?:点|點)(?:钟|鐘)?(?:\\s*' + TODO_TIME_MINUTE_TOKEN + '\\s*(?:分|分钟)?)?)';
var TODO_TIME_REMINDER_CLOCK_EXPRESSION = '(?:(?:' + TODO_TIME_PERIOD_TEXT + ')\\s*)?' + TODO_TIME_CLOCK_EXPRESSION;
var TODO_TIME_TRAILING_REMINDER_RE = new RegExp(
  '(' + TODO_TIME_REMINDER_CLOCK_EXPRESSION + '(?:\\s*(?:到|至|[-~～—])\\s*' + TODO_TIME_REMINDER_CLOCK_EXPRESSION + ')?)\\s*[，,、。；;：:]?$',
  'i'
);

function todoTimeParseNumber(value) {
  var text = String(value || '').trim();
  if (/^\d+$/.test(text)) return Number(text);
  if (!/^[零〇一二两三四五六七八九十]+$/.test(text)) return NaN;
  if (text.length === 1) return TODO_TIME_CN_DIGITS[text] == null ? NaN : TODO_TIME_CN_DIGITS[text];
  if (text === '十') return 10;
  if (text.indexOf('十') === 0) return 10 + (TODO_TIME_CN_DIGITS[text.slice(1)] == null ? NaN : TODO_TIME_CN_DIGITS[text.slice(1)]);
  if (text.lastIndexOf('十') === text.length - 1) return (TODO_TIME_CN_DIGITS[text.slice(0, -1)] == null ? NaN : TODO_TIME_CN_DIGITS[text.slice(0, -1)]) * 10;
  if (text.length === 3 && text[1] === '十') {
    return (TODO_TIME_CN_DIGITS[text[0]] == null ? NaN : TODO_TIME_CN_DIGITS[text[0]]) * 10 + (TODO_TIME_CN_DIGITS[text[2]] == null ? NaN : TODO_TIME_CN_DIGITS[text[2]]);
  }
  return NaN;
}

function todoTimeFormatClock(hour, minute) {
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return '';
  return String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0');
}

function todoTimeLocalDateKey(date) {
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
}

// 裸写“两点”在当天白天通常指下午两点；凌晨/下午等明确时段仍由显式解析优先。
// 只对当天启用这个语境判断，避免替用户猜未来日期的上午/下午。
function todoTimeShouldPreferAfternoonBareTime(targetDate, now) {
  if (!(now instanceof Date) || isNaN(now.getTime()) || now.getHours() < 6) return false;
  var raw = String(targetDate || '').trim();
  var key = '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) key = raw;
  else if (/^\d{2}-\d{2}$/.test(raw)) key = now.getFullYear() + '-' + raw;
  return Boolean(key && key === todoTimeLocalDateKey(now));
}

function todoTimeParseBareNaturalClock(hourToken, minuteToken, options) {
  var opts = options || {};
  var hour = todoTimeParseNumber(hourToken);
  var minute = minuteToken === '半' ? 30 : minuteToken ? todoTimeParseNumber(minuteToken) : 0;
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute < 0 || minute > 59) return '';
  if (todoTimeShouldPreferAfternoonBareTime(opts.targetDate, opts.now) && hour >= 1 && hour <= 6) hour += 12;
  return todoTimeFormatClock(hour, minute);
}

function todoTimeParseNaturalClock(period, hourToken, minuteToken) {
  var hour = todoTimeParseNumber(hourToken);
  var minute = minuteToken === '半' ? 30 : minuteToken ? todoTimeParseNumber(minuteToken) : 0;
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute < 0 || minute > 59) return '';
  if (period) {
    if (hour < 1 || hour > 12) return '';
    if (['下午', '傍晚', '晚上', '夜里', '夜间'].indexOf(period) >= 0) {
      if (hour === 12 && period !== '下午' && period !== '傍晚') hour = 0;
      else if (hour < 12) hour += 12;
    }
    else if (period === '中午' && hour >= 1 && hour <= 6) hour += 12;
    else if (period === '凌晨' && hour === 12) hour = 0;
  }
  return todoTimeFormatClock(hour, minute);
}

function todoTimeRangeResult(start, end) {
  if (!start || !end) return null;
  var startParts = start.split(':').map(Number);
  var endParts = end.split(':').map(Number);
  if (startParts[0] * 60 + startParts[1] > endParts[0] * 60 + endParts[1]) return null;
  return { reminderStart: start, reminderEnd: end };
}

function todoTimeHasAmbiguousTail(value) {
  return TODO_TIME_AMBIGUOUS_TAIL_RE.test(String(value || ''));
}

function todoTimeHasRangePrefix(value) {
  return TODO_TIME_RANGE_PREFIX_RE.test(String(value || ''));
}

function todoTimeParseMeridiemColon(text) {
  var match = text.match(TODO_TIME_MERIDIEM_COLON_RE);
  if (!match) return null;
  var start = todoTimeParseNaturalClock(match[1], match[2], match[3]);
  if (!start) return null;
  var tail = text.slice((match.index || 0) + match[0].length);
  var endMatch = tail.match(TODO_TIME_RANGE_COLON_RE);
  if (!endMatch && (todoTimeHasAmbiguousTail(tail) || todoTimeHasRangePrefix(tail))) return null;
  var remaining = endMatch ? tail.slice(endMatch[0].length) : '';
  if (todoTimeHasAmbiguousTail(remaining) || todoTimeHasRangePrefix(remaining)) return null;
  var end = endMatch ? todoTimeParseNaturalClock(endMatch[1] || match[1], endMatch[2], endMatch[3]) : start;
  return todoTimeRangeResult(start, end);
}

function todoTimeParseMeridiem(text) {
  var match = text.match(TODO_TIME_MERIDIEM_RE);
  if (!match) return null;
  var start = todoTimeParseNaturalClock(match[1], match[2], match[3]);
  if (!start) return null;
  var tail = text.slice((match.index || 0) + match[0].length);
  var endMatch = tail.match(TODO_TIME_RANGE_RE);
  if (!endMatch && (todoTimeHasAmbiguousTail(tail) || todoTimeHasRangePrefix(tail))) return null;
  var remaining = endMatch ? tail.slice(endMatch[0].length) : '';
  if (todoTimeHasAmbiguousTail(remaining) || todoTimeHasRangePrefix(remaining)) return null;
  var end = endMatch ? todoTimeParseNaturalClock(endMatch[1] || match[1], endMatch[2], endMatch[3]) : start;
  return todoTimeRangeResult(start, end);
}

function parseTodoReminderText(value, options) {
  var opts = options || {};
  var text = String(value || '').trim();
  if (!text) return null;

  var reminderIndex = text.indexOf('提醒');
  if (reminderIndex > 0) {
    var beforeReminder = text.slice(0, reminderIndex).trim();
    var reminderMatch = beforeReminder.match(TODO_TIME_TRAILING_REMINDER_RE);
    if (reminderMatch) {
      var reminderTime = parseTodoReminderText(reminderMatch[1], opts);
      if (reminderTime) return reminderTime;
    }
  }

  var meridiemColon = todoTimeParseMeridiemColon(text);
  if (meridiemColon) return meridiemColon;
  var meridiem = todoTimeParseMeridiem(text);
  if (meridiem) return meridiem;
  var colonMatches = Array.from(text.matchAll(TODO_TIME_COLON_RE));
  if (colonMatches.length) {
    var last = colonMatches[colonMatches.length - 1];
    var colonTail = text.slice((last.index || 0) + last[0].length);
    if (todoTimeHasAmbiguousTail(colonTail) || todoTimeHasRangePrefix(colonTail)) return null;
    var start = todoTimeFormatClock(Number(colonMatches[0][1]), Number(colonMatches[0][2]));
    var end = colonMatches[1] ? todoTimeFormatClock(Number(colonMatches[1][1]), Number(colonMatches[1][2])) : start;
    return todoTimeRangeResult(start, end);
  }
  var plain = text.match(TODO_TIME_PLAIN_24H_RE);
  if (plain) {
    var plainTail = text.slice((plain.index || 0) + plain[0].length);
    if (todoTimeHasAmbiguousTail(plainTail) || todoTimeHasRangePrefix(plainTail)) return null;
    var plainTime = todoTimeParseNaturalClock('', plain[1], plain[2]);
    return plainTime ? { reminderStart: plainTime, reminderEnd: plainTime } : null;
  }

  var bare = text.match(TODO_TIME_BARE_TIME_RE);
  if (bare) {
    var bareTail = text.slice((bare.index || 0) + bare[0].length);
    if (todoTimeHasAmbiguousTail(bareTail) || todoTimeHasRangePrefix(bareTail)) return null;
    var bareStart = todoTimeParseBareNaturalClock(bare[1], bare[2], opts);
    return bareStart ? { reminderStart: bareStart, reminderEnd: bareStart } : null;
  }
  return null;
}
