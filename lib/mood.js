// 拾光记 · 情绪记录纯逻辑
// 「记一笔当下的心情」：当天随手记 + 翻篇做册后的合稿。
// 设计约定：
// - 手动标记是用户的亲笔，永不被自动流程改动；模型只能补旁白或提出带证据的候选。
// - 情绪词收进统一集合，展示/自动发现都走同一份常量，避免时间线变成自由词典。
// - 自动发现的条目与手动条目靠 source 区分（manual / auto），UI 一眼能分清“我写的”和“它猜的”。
// 文件预算豁免：集合常量、分段、emoji、合稿解析/合并需要共享同一套情绪语义，拆分会放大不一致。

// ── 情绪集合（用户拍板定稿，2026-09-05）──
export const MOODS = [
  { id: "happy", emoji: "😊", label: "开心" },
  { id: "calm", emoji: "😌", label: "平静" },
  { id: "excited", emoji: "🤩", label: "兴奋" },
  { id: "hurt", emoji: "🥺", label: "委屈" },
  { id: "sad", emoji: "😢", label: "难过" },
  { id: "angry", emoji: "😠", label: "生气" },
  { id: "annoyed", emoji: "😤", label: "烦躁" },
  { id: "anxious", emoji: "😰", label: "焦虑" },
  { id: "tired", emoji: "🥱", label: "累" },
  { id: "moved", emoji: "🥹", label: "感动" },
  { id: "bored", emoji: "😑", label: "无聊" },
  { id: "bliss", emoji: "🥰", label: "幸福" },
  { id: "missing", emoji: "💭", label: "想念" },
];

const MOOD_BY_ID = new Map(MOODS.map((m) => [m.id, m]));
const MOOD_BY_LABEL = new Map(MOODS.map((m) => [m.label, m]));

// 本地预筛只看用户自己写的可见文字；不读伙伴回复，也不依赖表情包插件。
// 这些词是“可能值得交给日终模型看一眼”的信号，不等于已经判定了情绪。
const MOOD_SIGNAL_RE = /开心|高兴|快乐|幸福|兴奋|激动|期待|惊喜|感动|治愈|温柔|暖|想念|想你|好想|难过|伤心|委屈|心酸|失落|低落|压抑|崩溃|哭|眼泪|生气|气死|火大|恼火|不爽|烦躁|烦死|焦虑|担心|害怕|紧张|慌|累|疲惫|困|无聊|空虚|发空|没劲|哈哈|嘿嘿|呜呜/u;
const MOOD_SEGMENT_ALIASES = Object.freeze({
  morning: "morning", "上午": "morning", "早上": "morning", "清晨": "morning",
  afternoon: "afternoon", "下午": "afternoon", "中午": "afternoon",
  evening: "evening", "晚上": "evening", "傍晚": "evening", "夜里": "evening",
  day: "day", "白天": "day", "全天": "day",
});
const MOOD_CERTAINTY_ALIASES = Object.freeze({
  clear: "clear", direct: "clear", explicit: "clear", certain: "clear", "明确": "clear", "直接": "clear",
  possible: "possible", likely: "possible", probable: "possible", "可能": "possible", "大概": "possible", "较像": "possible",
  uncertain: "uncertain", guess: "uncertain", weak: "uncertain", "不确定": "uncertain", "猜测": "uncertain", "存疑": "uncertain",
});
const MOOD_EVIDENCE_ALIASES = Object.freeze({
  explicit: "explicit", direct: "explicit", quote: "explicit", "原话": "explicit", "直说": "explicit",
  context: "context", inferred: "context", indirect: "context", "上下文": "context", "推测": "context",
});

export function isValidMoodId(id) {
  return MOOD_BY_ID.has(String(id || ""));
}

export function isValidMoodLabel(label) {
  return MOOD_BY_LABEL.has(String(label || "").trim());
}

export function moodById(id) {
  return MOOD_BY_ID.get(String(id || "")) || null;
}

export function moodByLabel(label) {
  return MOOD_BY_LABEL.get(String(label || "").trim()) || null;
}

/** 情绪词 → 在合稿提示里的白名单（拼提示用，防自由文本污染） */
export function moodLabelWhitelist() {
  return MOODS.map((m) => m.label).join("、");
}

/** 本地零 Token 预筛：只从用户消息里找情绪线索，伙伴回复不能单独触发自动发现。 */
export function findExplicitMoodSignals(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter((row) => row?.role === "user")
    .map((row) => ({ ts: row.ts ?? null, text: String(row.text || "").trim() }))
    .filter((row) => row.text && MOOD_SIGNAL_RE.test(row.text))
    .map((row) => ({ ...row, text: row.text.slice(0, 180) }));
}

export function hasExplicitMoodSignal(messages) {
  return findExplicitMoodSignals(messages).length > 0;
}

export function normalizeMoodSegment(value) {
  const raw = String(value || "").trim().toLowerCase();
  return MOOD_SEGMENT_ALIASES[raw] || "day";
}

export function normalizeMoodCertainty(value) {
  const raw = String(value || "").trim().toLowerCase();
  return MOOD_CERTAINTY_ALIASES[raw] || "uncertain";
}

export function normalizeMoodEvidenceType(value) {
  const raw = String(value || "").trim().toLowerCase();
  return MOOD_EVIDENCE_ALIASES[raw] || "context";
}

/**
 * 把自由文本里的情绪标签（中文词/emoji/id）归一成集合内的 mood id。
 * 匹配不上返回 ""，调用方按“没认出来”处理（不硬造新情绪词）。
 */
export function normalizeMoodId(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  // 直接命中集合 id
  if (MOOD_BY_ID.has(raw)) return raw;
  // 命中 emoji
  const byEmoji = MOODS.find((m) => m.emoji === raw);
  if (byEmoji) return byEmoji.id;
  // 命中标签（做册模型可能给中文词）
  const byLabel = MOOD_BY_LABEL.get(raw);
  if (byLabel) return byLabel.id;
  // 去掉常见包裹（「开心」/“开心”/【开心】等）再试
  const unwrapped = raw.replace(/^[「『【(\[{“"]+|[」』】)\]}”"]+$/g, "").trim();
  const inner = MOOD_BY_LABEL.get(unwrapped);
  return inner ? inner.id : "";
}

// ── 时段（上午/下午/晚上），手动标记按当前时刻自动归位 ──

export function segmentOfHour(hour) {
  const h = Number(hour);
  if (!Number.isFinite(h)) return "day";
  if (h < 12) return "morning"; // 上午（翻篇边界 4 点后到 12 点前）
  if (h < 18) return "afternoon"; // 下午
  return "evening"; // 晚上
}

export function segmentLabel(segment) {
  return ({ morning: "上午", afternoon: "下午", evening: "晚上", day: "白天" })[segment] || "白天";
}

export function segmentOfTimestamp(iso) {
  const ts = new Date(iso);
  return Number.isNaN(ts.getTime()) ? "day" : segmentOfHour(ts.getHours());
}

export function moodSegmentOrder(a, b) {
  const rank = { morning: 0, afternoon: 1, evening: 2, day: -1 };
  return (rank[a] ?? 0) - (rank[b] ?? 0);
}

/** 手动标记要写进日历的时段锚（不显示原始时分，避免记心情还惦记几点） */
export function moodSegKey(dateKeyValue, segment) {
  return `${dateKeyValue}|${segment}`;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

// 只接受模型从提示里抄回来的“已存在消息分钟”；匹配不上就退回宽时段。
function parseObservationParts(value, fallbackDay = "") {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return {
      date: `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`,
      time: `${pad2(value.getHours())}:${pad2(value.getMinutes())}`,
    };
  }
  if (typeof value === "number" || (typeof value === "string" && /^\d{10,13}$/.test(value.trim()))) {
    const timestamp = new Date(Number(value));
    return parseObservationParts(timestamp, fallbackDay);
  }
  const raw = String(value || "").trim().replace(/[\[\]【】「」]/g, "");
  if (!raw) return null;
  const full = raw.match(/(\d{4})-(\d{1,2})-(\d{1,2})[T\s]+(\d{1,2}):(\d{2})/);
  let year;
  let month;
  let day;
  let hour;
  let minute;
  if (full) {
    [, year, month, day, hour, minute] = full;
  } else {
    const time = raw.match(/\b(\d{1,2}):(\d{2})\b/);
    const date = String(fallbackDay || "").match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (!time || !date) return null;
    [, year, month, day] = date;
    [, hour, minute] = time;
  }
  const y = Number(year);
  const mo = Number(month);
  const d = Number(day);
  const h = Number(hour);
  const min = Number(minute);
  if (![y, mo, d, h, min].every(Number.isFinite) || mo < 1 || mo > 12 || d < 1 || d > 31 || h < 0 || h > 23 || min < 0 || min > 59) return null;
  const dateValue = `${String(y).padStart(4, "0")}-${pad2(mo)}-${pad2(d)}`;
  const timeValue = `${pad2(h)}:${pad2(min)}`;
  const local = new Date(`${dateValue}T${timeValue}:00`);
  if (Number.isNaN(local.getTime()) || local.getFullYear() !== y || local.getMonth() + 1 !== mo || local.getDate() !== d || local.getHours() !== h || local.getMinutes() !== min) return null;
  return { date: dateValue, time: timeValue };
}

function observationMinuteKey(value, fallbackDay = "") {
  const parts = parseObservationParts(value, fallbackDay);
  return parts ? `${parts.date} ${parts.time}` : "";
}

function resolveObservedAt(value, { day = "", allowedObservedAt = [] } = {}) {
  const candidate = parseObservationParts(value, day);
  const allowed = new Set((allowedObservedAt instanceof Set ? [...allowedObservedAt] : (Array.isArray(allowedObservedAt) ? allowedObservedAt : []))
    .map((item) => observationMinuteKey(item, day))
    .filter(Boolean));
  if (!candidate || !allowed.size || !allowed.has(`${candidate.date} ${candidate.time}`)) {
    return { observedAt: "", timePrecision: "segment" };
  }
  const local = new Date(`${candidate.date}T${candidate.time}:00`);
  return { observedAt: local.toISOString(), timePrecision: "turn" };
}

function exactMoodTime(entry) {
  if (!entry || typeof entry !== "object") return "";
  if (entry.source === "auto") {
    return entry.timePrecision === "turn" && entry.observedAt && !Number.isNaN(new Date(entry.observedAt).getTime())
      ? entry.observedAt
      : "";
  }
  return entry.recordedAt && !Number.isNaN(new Date(entry.recordedAt).getTime()) ? entry.recordedAt : "";
}

function isExactAutoMood(entry) {
  return entry?.source === "auto" && !!exactMoodTime(entry);
}

function sameMoodMinute(a, b) {
  const first = exactMoodTime(a);
  const second = exactMoodTime(b);
  if (!first || !second) return false;
  return Math.floor(new Date(first).getTime() / 60000) === Math.floor(new Date(second).getTime() / 60000);
}

function certaintyRank(value) {
  return ({ uncertain: 0, possible: 1, clear: 2 })[normalizeMoodCertainty(value)] ?? 0;
}

// ── 条目形状 ──
// {
//   id, mood: "angry", label: "生气", emoji: "😠",
//   source: "manual" | "auto",
//   segment: "morning"|"afternoon"|"evening",
//   reason: "（可不填）", note: "模型旁白/合稿补全说明",
//   recordedAt: ISO（手动=点选时刻；自动=合稿时刻）,
//   observedAt: ISO（自动候选从可见消息抄回的观察时刻；没有就为空）,
//   timePrecision: "turn" | "segment", certainty: "clear" | "possible" | "uncertain",
//   evidenceType: "explicit" | "context", evidence: "可回溯的短原话"
// }

export function makeManualMood({ mood, segment, reason = "", now = new Date() }) {
  const id = normalizeMoodId(mood);
  if (!id) throw new Error("这个心情不在可选里，换一个吧");
  const seg = ["morning", "afternoon", "evening"].includes(segment) ? segment : segmentOfHour(now.getHours());
  const meta = MOOD_BY_ID.get(id);
  return {
    id: `mood-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    mood: id,
    label: meta.label,
    emoji: meta.emoji,
    source: "manual",
    segment: seg,
    reason: String(reason || "").trim().slice(0, 200),
    note: "",
    recordedAt: now.toISOString(),
  };
}

export function makeAutoMood({
  mood,
  segment,
  note = "",
  now = new Date(),
  observedAt = "",
  timePrecision = "",
  certainty = "uncertain",
  evidenceType = "context",
  evidence = "",
} = {}) {
  const id = normalizeMoodId(mood);
  if (!id) return null;
  const seg = normalizeMoodSegment(segment);
  const precise = String(observedAt || "").trim() && timePrecision === "turn" && !Number.isNaN(new Date(observedAt).getTime());
  const meta = MOOD_BY_ID.get(id);
  return {
    id: `mood-auto-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    mood: id,
    label: meta.label,
    emoji: meta.emoji,
    source: "auto",
    segment: seg,
    reason: "",
    note: String(note || "").trim().slice(0, 300),
    certainty: normalizeMoodCertainty(certainty),
    evidenceType: normalizeMoodEvidenceType(evidenceType),
    evidence: String(evidence || "").trim().slice(0, 120),
    observedAt: precise ? String(observedAt).trim() : "",
    timePrecision: precise ? "turn" : "segment",
    recordedAt: now.toISOString(),
  };
}

// ── 合稿：把模型输出的 JSON 转成「要合并进档案的条目」 ──
// 模型输出统一为一个 JSON 数组（可被 ```json 围栏包着）：
// [ { "mood": "生气", "segment": "afternoon", "observedAt": "2026-09-05 16:14", "certainty": "possible", "evidence": "原话短句", "why": "可能是插件反复出 bug？" }, ... ]
// 时间必须能和可见用户消息分钟对上，否则退回宽时段；why/evidence 允许为空，绝不硬安原因。

export function parseMoodOutput(raw, {
  now = new Date(),
  day = "",
  allowedObservedAt = [],
  evidenceSourceText = "",
} = {}) {
  let text = String(raw || "").trim();
  if (!text) return [];
  // 去掉 ```json 围栏
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced) text = fenced[1].trim();
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const items = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const mood = normalizeMoodId(item.mood || item.label || item.emoji || "");
    if (!mood) continue;
    const observed = resolveObservedAt(
      item.observedAt || item.time || item.timestamp || "",
      { day, allowedObservedAt },
    );
    const requestedSegment = normalizeMoodSegment(item.segment);
    const segment = observed.observedAt ? segmentOfTimestamp(observed.observedAt) : requestedSegment;
    const note = String(item.why || item.note || item.reason || "").trim().slice(0, 300);
    const rawEvidence = String(item.evidence || item.quote || "").trim().slice(0, 120);
    const evidence = evidenceSourceText
      ? (rawEvidence && String(evidenceSourceText).includes(rawEvidence) ? rawEvidence : "")
      : rawEvidence;
    const auto = makeAutoMood({
      mood,
      segment,
      note,
      now,
      observedAt: observed.observedAt,
      timePrecision: observed.timePrecision,
      certainty: item.certainty || item.confidence || item.clarity,
      evidenceType: item.evidenceType || item.evidenceKind || item.evidence_type,
      evidence,
    });
    if (auto) items.push(auto);
  }
  return items;
}

/** 解析细致模式的二次裁决；只接受明确的保留/丢弃，不用数字置信度冒充心理事实。 */
export function parseMoodReviewOutput(raw, { allowedIndexes = null } = {}) {
  let text = String(raw || "").trim();
  if (!text) return [];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced) text = fenced[1].trim();
  let parsed;
  try {
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start >= 0 && end > start) parsed = JSON.parse(text.slice(start, end + 1));
    else parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : parsed?.decisions;
  if (!Array.isArray(list)) return [];
  const allowed = allowedIndexes == null ? null : new Set(allowedIndexes);
  const result = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const index = Number(item.index);
    if (!Number.isInteger(index) || index < 0 || (allowed && !allowed.has(index))) continue;
    let keep = null;
    if (typeof item.keep === "boolean") keep = item.keep;
    const decision = String(item.decision || item.result || "").trim().toLowerCase();
    if (keep === null && ["keep", "accept", "retain", "保留", "留下"].includes(decision)) keep = true;
    if (keep === null && ["drop", "discard", "reject", "remove", "丢弃", "删除", "不要"].includes(decision)) keep = false;
    if (keep === null) continue;
    result.push({ index, keep, reason: String(item.reason || item.why || "").trim().slice(0, 200) });
  }
  return result;
}

/** 手动条目与自动候选合并。
 *
 * 规则：
 * - 手动条目原样保留（mood/label/reason/recordedAt 不改，note 只可能补旁白）。
 * - 只有宽时段的自动候选仍然只补没有手动记录的时段；同段同情绪可把 why 挂到手动 note，其他冲突丢弃。
 * - 带有“从真实消息分钟抄回”的自动候选可以在同一宽时段内独立保留；
 *   但若与手动记录落在同一分钟，手动优先，自动不另起一笔。
 * - 自动候选彼此同一分钟或同一宽时段只留一笔，避免模型重复输出把时间线刷满。
 */
export function mergeMoodEntries(manualEntries, autoEntries, { lenient = false } = {}) {
  const manual = Array.isArray(manualEntries) ? manualEntries.filter((m) => m && m.source === "manual") : [];
  const auto = Array.isArray(autoEntries) ? autoEntries.filter((m) => m && m.source === "auto") : [];
  const manualBySeg = new Map();
  for (const entry of manual) {
    if (!manualBySeg.has(entry.segment)) manualBySeg.set(entry.segment, []);
    manualBySeg.get(entry.segment).push(entry);
  }
  // 手动条目拷贝；note 可能被旁白补上，mood/label/reason/recordedAt 不动。
  const result = manual.map((e) => ({ ...e, note: String(e.note || "") }));
  const byId = new Map(result.map((e) => [e.id, e]));
  const accepted = [];
  const attachNote = (target, item) => {
    if (!target || String(target.note || "").trim() || !String(item.note || "").trim()) return;
    const copy = byId.get(target.id);
    if (copy) copy.note = String(item.note || "").trim();
  };

  for (const item of auto) {
    const exact = isExactAutoMood(item);
    const sameSegment = manualBySeg.get(item.segment) || [];
    const sameMinuteManual = exact
      ? manual.find((entry) => sameMoodMinute(entry, item))
      : null;
    if (sameMinuteManual) {
      if (sameMinuteManual.mood === item.mood) attachNote(sameMinuteManual, item);
      continue;
    }

    if (!exact) {
      if (sameSegment.length) {
        const sameMood = sameSegment.find((entry) => entry.mood === item.mood);
        if (sameMood) attachNote(sameMood, item);
        continue;
      }
      // 已有同段精确候选时，宽候选没有新增信息。
      if (accepted.some((entry) => isExactAutoMood(entry) && entry.segment === item.segment)) continue;
      // 严格模式（当天自动）：同段宽候选只留一笔，避免情绪线被自由输出刷满；
      // 宽松模式（历史补档）：同段不同情绪的宽候选允许共存，保留一天内的情绪起伏。
      if (!lenient && accepted.some((entry) => entry.segment === item.segment)) continue;
      // 宽松下同段同情绪仍只留一笔（旁白合并到更早那条），避免同情绪刷屏。
      if (lenient && accepted.some((entry) => entry.segment === item.segment && entry.mood === item.mood)) continue;
      accepted.push({ ...item });
      continue;
    }

    // 同一分钟的自动冲突只留证据更清楚的一笔；同情绪重复则合并旁白。
    const sameMinuteAutoIndex = accepted.findIndex((entry) => isExactAutoMood(entry) && sameMoodMinute(entry, item));
    if (sameMinuteAutoIndex >= 0) {
      const current = accepted[sameMinuteAutoIndex];
      if (current.mood === item.mood) {
        if (!String(current.note || "").trim() && String(item.note || "").trim()) current.note = item.note;
      } else if (certaintyRank(item.certainty) > certaintyRank(current.certainty)) {
        accepted[sameMinuteAutoIndex] = { ...item };
      }
      continue;
    }
    // 真实时刻候选比同段宽候选更有信息，替换掉后者。
    for (let i = accepted.length - 1; i >= 0; i--) {
      if (!isExactAutoMood(accepted[i]) && accepted[i].segment === item.segment) accepted.splice(i, 1);
    }
    accepted.push({ ...item });
  }

  const preciseTime = (entry) => {
    const value = exactMoodTime(entry);
    return value ? new Date(value).getTime() : NaN;
  };
  const sorted = (list) => [...list].sort((a, b) => {
    const segmentDelta = moodSegmentOrder(a.segment, b.segment);
    if (segmentDelta) return segmentDelta;
    const aTime = preciseTime(a);
    const bTime = preciseTime(b);
    if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) return aTime - bTime;
    if (Number.isFinite(aTime) !== Number.isFinite(bTime)) return Number.isFinite(aTime) ? -1 : 1;
    return String(a.recordedAt || "").localeCompare(String(b.recordedAt || ""));
  });
  return sorted([...result, ...accepted]);
}

/** 给某天档案里一条手动条目的 note 字段做幂等清空（改写了原文？不，note 从来不是原文） */
export function stripManualNote(entry) {
  if (!entry || entry.source !== "manual") return entry;
  return { ...entry, note: "" };
}

export function moodEntryText(entry) {
  if (!entry) return "";
  const seg = segmentLabel(entry.segment);
  const base = `${seg} ${entry.emoji || ""} ${entry.label || entry.mood || ""}`.replace(/\s+/g, " ").trim();
  const note = String(entry.note || "").trim();
  return note ? `${base}（${note}）` : base;
}

// ── 展示辅助 ──

/** 一串条目 → 时间线文案：上午 😊 开心（和慧慧逛街）→ 下午 😠 生气（可能是…？） */
export function formatMoodTimeline(entries) {
  const list = (Array.isArray(entries) ? entries : []).filter(Boolean)
    .sort((a, b) => moodSegmentOrder(a.segment, b.segment));
  if (!list.length) return "";
  return list.map((entry) => {
    const seg = segmentLabel(entry.segment);
    const head = `${seg} ${entry.emoji || ""} ${entry.label || entry.mood || ""}`.replace(/\s+/g, " ").trim();
    const note = String(entry.note || "").trim();
    const marker = entry.source === "auto" ? "" : ""; // 视觉区分交给 UI（数据层带 source 字段即可）
    return note ? `${head}（${note}）` : head;
  }).join("　→　");
}

/** 日历角标：取当天最有代表性的一条（手动优先，其次最新） */
export function pickDayMood(entries) {
  const list = (Array.isArray(entries) ? entries : []).filter(Boolean);
  if (!list.length) return null;
  const manual = list.find((e) => e.source === "manual") || null;
  const best = manual || list[list.length - 1];
  return best || null;
}

// ── 证据窗口：保证带情绪线索的消息一定在模型可见范围内 ──
// 问题背景：一天几百条消息拼成几万字，若证据从头截断到 8000，
// 发生在下午/晚上的情绪原话会被系统性裁掉，模型“看不到情绪”只能返回 0 候选。
// 策略：以本地预筛命中的信号消息为锚，每条信号连同前后文一起优先纳入窗口，
// 剩余字符预算再按时间顺序补非信号背景；同一条消息不重复计入。
// rows: collectDayMessages 的原始消息（含 ts/role/text）
// signals: findExplicitMoodSignals 的结果（含 ts/text）
// fmt: (row) => string 单条消息的文本（如带时间戳前缀）
// budget: 最大字符数

export function buildSignalAwareEvidence(rows, signals, fmt, budget = 8000) {
  const list = (Array.isArray(rows) ? rows : []).filter((row) => row && String(row.text || "").trim());
  if (!list.length) return "";
  const limit = Math.max(200, Number(budget) || 8000);
  const signalKeys = new Set();
  for (const s of Array.isArray(signals) ? signals : []) {
    const ts = Number(s?.ts);
    if (Number.isFinite(ts)) signalKeys.add(ts);
  }
  // 定位每条信号消息在列表里的下标（按 ts 匹配，同分钟多条取最近一条）
  const signalIndexes = new Set();
  for (const key of signalKeys) {
    let best = -1;
    let bestDist = Infinity;
    list.forEach((row, i) => {
      const rowTs = Number(row.ts);
      if (!Number.isFinite(rowTs)) return;
      const dist = Math.abs(rowTs - key);
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    });
    if (best >= 0) signalIndexes.add(best);
  }
  const lines = list.map((row) => fmt(row));
  const lineLen = lines.map((t) => String(t || "").length);
  // 先确定要纳入的窗口行：信号行 + 前后邻居（邻居宽度按预算比例自适应，保底 1 条）
  const contextHalf = Math.max(1, Math.min(8, Math.floor(limit / 4000)));
  const wanted = new Set();
  for (const idx of signalIndexes) {
    for (let i = Math.max(0, idx - contextHalf); i <= Math.min(list.length - 1, idx + contextHalf); i++) wanted.add(i);
  }
  // 按时间顺序排放：先放窗口内行（保留相对顺序），再从头补窗口外行直到预算满。
  const selected = new Set();
  const orderedIndexes = [...list.keys()];
  const priorityOrder = orderedIndexes.filter((i) => wanted.has(i));
  const backgroundOrder = orderedIndexes.filter((i) => !wanted.has(i));
  let used = 0;
  const push = (i) => {
    const len = lineLen[i] + (selected.size ? 1 : 0); // 行间换行符
    if (used + len > limit) return false;
    selected.add(i);
    used += len;
    return true;
  };
  for (const i of priorityOrder) push(i);
  for (const i of backgroundOrder) {
    if (!push(i)) break;
  }
  return [...selected]
    .sort((a, b) => a - b)
    .map((i) => lines[i])
    .join("\n");
}
