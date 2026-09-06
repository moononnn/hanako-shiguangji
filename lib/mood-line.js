// 拾光记 · 心情线纯逻辑
// 这条线是回看心情变化的阅读线，不是心理分数；高低只服务于形成节奏。
import { normalizeMoodId } from "./mood.js";

// 13 个心情拆成更细的视觉层级，真正的语义仍由情绪词、时段和旁注承担。
// level 只用于排版位置，不是心理分数，也不对外显示数字。
// 纵轴刻度（2026-09-06 版本2，用户拍板）：很低落→想哭→委屈巴巴→有点烦→心里悬→乏了→安安稳稳→挺高兴→幸福满满
// 每个刻度词都是情绪本身，一眼能对上号；无聊/想念归“安安稳稳”，生气/烦躁归“有点烦”。
export const MOOD_LINE_META = Object.freeze({
  happy: Object.freeze({ band: "light", bandLabel: "挺高兴", level: 7 }),
  calm: Object.freeze({ band: "steady", bandLabel: "安安稳稳", level: 6 }),
  excited: Object.freeze({ band: "light", bandLabel: "挺高兴", level: 7 }),
  hurt: Object.freeze({ band: "heavy", bandLabel: "委屈巴巴", level: 2 }),
  sad: Object.freeze({ band: "heavy", bandLabel: "想哭", level: 1 }),
  angry: Object.freeze({ band: "heavy", bandLabel: "有点烦", level: 3 }),
  annoyed: Object.freeze({ band: "heavy", bandLabel: "有点烦", level: 3 }),
  anxious: Object.freeze({ band: "heavy", bandLabel: "心里悬", level: 4 }),
  tired: Object.freeze({ band: "steady", bandLabel: "乏了", level: 5 }),
  moved: Object.freeze({ band: "light", bandLabel: "挺高兴", level: 7 }),
  bored: Object.freeze({ band: "steady", bandLabel: "安安稳稳", level: 6 }),
  bliss: Object.freeze({ band: "light", bandLabel: "幸福满满", level: 8 }),
  missing: Object.freeze({ band: "steady", bandLabel: "安安稳稳", level: 6 }),
});

// 生活日从 04:00 起算；心情线只把精确记录落入细时段，旧/模糊的宽时段继续兼容。
export const MOOD_LINE_SEGMENTS = Object.freeze([
  Object.freeze({ id: "dawn", label: "清晨", rank: 0, startHour: 4, endHour: 8 }),
  Object.freeze({ id: "morning", label: "上午", rank: 1, startHour: 8, endHour: 12 }),
  Object.freeze({ id: "noon", label: "中午", rank: 2, startHour: 12, endHour: 14 }),
  Object.freeze({ id: "afternoon", label: "下午", rank: 3, startHour: 14, endHour: 18 }),
  Object.freeze({ id: "dusk", label: "傍晚", rank: 4, startHour: 18, endHour: 20 }),
  Object.freeze({ id: "evening", label: "晚上", rank: 5, startHour: 20, endHour: 24 }),
  Object.freeze({ id: "night", label: "深夜", rank: 6, startHour: 0, endHour: 4 }),
]);

const SEGMENT_RANK = new Map(MOOD_LINE_SEGMENTS.map((item) => [item.id, item.rank]));
const LEGACY_SEGMENT_TO_VISUAL = Object.freeze({ morning: "morning", afternoon: "afternoon", evening: "evening", day: "noon" });
const FALLBACK_SEGMENT = "noon";
const FALLBACK_META = Object.freeze({ band: "steady", bandLabel: "安安稳稳", level: 6 });

export function moodLineMeta(value) {
  const id = normalizeMoodId(value) || String(value || "").trim();
  return MOOD_LINE_META[id] || FALLBACK_META;
}

export function moodLineLevel(value) {
  return moodLineMeta(value).level;
}

export function moodLineSegmentRank(segment) {
  return SEGMENT_RANK.has(segment) ? SEGMENT_RANK.get(segment) : SEGMENT_RANK.get(FALLBACK_SEGMENT);
}

export function moodLineSegmentForHour(hour) {
  const h = Number(hour);
  if (!Number.isFinite(h)) return FALLBACK_SEGMENT;
  if (h >= 4 && h < 8) return "dawn";
  if (h >= 8 && h < 12) return "morning";
  if (h >= 12 && h < 14) return "noon";
  if (h >= 14 && h < 18) return "afternoon";
  if (h >= 18 && h < 20) return "dusk";
  if (h >= 20 && h < 24) return "evening";
  return "night";
}

/** 手动记录有精确时刻；自动发现只有抄回真实消息分钟时才允许展开，避免伪造精度。 */
function moodLineExactTimestamp(entry) {
  if (!entry || typeof entry !== "object") return "";
  if (entry.source === "auto") {
    return entry.timePrecision === "turn" && entry.observedAt && !Number.isNaN(new Date(entry.observedAt).getTime())
      ? entry.observedAt
      : "";
  }
  return entry.recordedAt && !Number.isNaN(new Date(entry.recordedAt).getTime()) ? entry.recordedAt : "";
}

export function moodLineHasExactTime(entry) {
  return !!moodLineExactTimestamp(entry);
}

/** 把本地时刻换成以生活日 04:00 为起点的分钟位置，供同一时段内展开精确记录。 */
export function moodLineLifeMinute(entry) {
  const value = moodLineExactTimestamp(entry);
  if (!value) return null;
  const timestamp = new Date(value);
  const minutes = timestamp.getHours() * 60 + timestamp.getMinutes() + timestamp.getSeconds() / 60;
  return (minutes - 4 * 60 + 24 * 60) % (24 * 60);
}

function moodLineSegmentWindow(segment) {
  const item = MOOD_LINE_SEGMENTS.find((candidate) => candidate.id === segment) || MOOD_LINE_SEGMENTS.find((candidate) => candidate.id === FALLBACK_SEGMENT);
  const start = ((item.startHour - 4 + 24) % 24) * 60;
  let end = item.endHour === 24 ? 24 * 60 : ((item.endHour - 4 + 24) % 24) * 60;
  if (end <= start) end += 24 * 60;
  return { start, end };
}

export function moodLineSegmentCenterMinute(segment) {
  const window = moodLineSegmentWindow(segment);
  return (window.start + window.end) / 2;
}

/** 同一段里，精确记录按真实时刻拆开；自动/旧条目仍按宽时段合并。 */
export function moodLineSegmentForEntry(entry) {
  const item = entry && typeof entry === "object" ? entry : { segment: entry };
  const exact = moodLineExactTimestamp(item);
  if (exact) {
    const timestamp = new Date(exact);
    if (!Number.isNaN(timestamp.getTime())) return moodLineSegmentForHour(timestamp.getHours());
  }
  if (SEGMENT_RANK.has(item.segment)) return item.segment;
  return LEGACY_SEGMENT_TO_VISUAL[item.segment] || FALLBACK_SEGMENT;
}

export function moodLineSegmentLabel(segment) {
  return MOOD_LINE_SEGMENTS.find((item) => item.id === segment)?.label || "中午";
}

export function moodLineSegmentLabelForEntry(entry) {
  if (entry?.source === "auto" && entry.segment === "day" && !moodLineHasExactTime(entry)) return "白天";
  return moodLineSegmentLabel(moodLineSegmentForEntry(entry));
}

export function sortMoodLineEntries(entries) {
  const exactTime = (entry) => {
    if (entry?.source === "auto") {
      return entry.timePrecision === "turn" && entry.observedAt ? new Date(entry.observedAt).getTime() : NaN;
    }
    return entry?.recordedAt ? new Date(entry.recordedAt).getTime() : NaN;
  };
  return (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry && typeof entry === "object")
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const segmentDelta = moodLineSegmentRank(moodLineSegmentForEntry(a.entry)) - moodLineSegmentRank(moodLineSegmentForEntry(b.entry));
      if (segmentDelta) return segmentDelta;
      const at = exactTime(a.entry);
      const bt = exactTime(b.entry);
      if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return at - bt;
      if (Number.isFinite(at) !== Number.isFinite(bt)) return Number.isFinite(at) ? -1 : 1;
      const timeDelta = String(a.entry.recordedAt || "").localeCompare(String(b.entry.recordedAt || ""));
      return timeDelta || a.index - b.index;
    })
    .map(({ entry }) => entry);
}

function pickPrimary(entries) {
  const list = Array.isArray(entries) ? entries : [];
  return list.find((entry) => entry.source === "manual") || list[list.length - 1] || null;
}

/** 把一天拆成可画的时段簇；精确手动记录各自成点，自动/旧条目仍按宽时段合并。 */
export function buildMoodLineDay(entries) {
  const sorted = sortMoodLineEntries(entries);
  const groups = [];
  for (const segment of MOOD_LINE_SEGMENTS) {
    const items = sorted.filter((entry) => moodLineSegmentForEntry(entry) === segment.id);
    if (!items.length) continue;
    const exact = items.filter((entry) => moodLineHasExactTime(entry));
    const broad = items.filter((entry) => !moodLineHasExactTime(entry));
    exact.forEach((entry, index) => {
      groups.push({
        ...segment,
        id: `${segment.id}:${entry.id || entry.recordedAt || index}`,
        segmentId: segment.id,
        exactTime: true,
        entries: [entry],
        primary: entry,
      });
    });
    if (broad.length) {
      groups.push({ ...segment, segmentId: segment.id, entries: broad, primary: pickPrimary(broad) });
    }
  }
  groups.sort((a, b) => {
    const aMinute = a.exactTime ? moodLineLifeMinute(a.primary) : moodLineSegmentCenterMinute(a.segmentId);
    const bMinute = b.exactTime ? moodLineLifeMinute(b.primary) : moodLineSegmentCenterMinute(b.segmentId);
    return aMinute - bMinute;
  });
  return {
    entries: sorted,
    groups,
    primary: pickPrimary(sorted),
  };
}

/** 把日期范围补齐；没有记录的日期保留为空，交给 UI 留白而不补点。 */
export function buildMoodLineRange(dayMap, dates) {
  const map = dayMap && typeof dayMap === "object" ? dayMap : {};
  return (Array.isArray(dates) ? dates : []).map((date) => {
    const key = String(date || "");
    return { date: key, ...buildMoodLineDay(map[key]) };
  });
}
