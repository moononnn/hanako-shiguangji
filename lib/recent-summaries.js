// 拾光记 · 近期总结选择器
// 先给当前伙伴一个固定的近期底座；更老的档案只有在当前话题有词汇关联时才渐进式带入。
// 这里做纯函数筛选，不让主模型每轮自由决定是否翻阅，避免隐私边界和 token 预算失控。

import { finishedLifeDayKey, shiftDateKey } from "./day-summary.js";

export const RECENT_BASE_DAYS = 3;
export const RECENT_LOOKBACK_DAYS = 30;
export const RECENT_CHAR_BUDGET = 1800;
const TECHNICAL_AGENT_RE = /(?:^|[-_])(probe|test)(?:[-_]|$)/i;

function usableAgentId(agentId) {
  const id = String(agentId || "").trim();
  return !!id && !TECHNICAL_AGENT_RE.test(id);
}

function usable(entry) {
  return !!entry && !entry.empty && !!String(entry.text || "").trim();
}

function cjkBigrams(text) {
  const terms = [];
  for (const run of String(text || "").toLowerCase().match(/[\u4e00-\u9fff]+/g) || []) {
    if (run.length === 1) terms.push(run);
    for (let i = 0; i < run.length - 1; i++) terms.push(run.slice(i, i + 2));
  }
  return terms;
}

export function promptTerms(text) {
  const value = String(text || "").toLowerCase();
  const terms = new Set([
    ...(value.match(/[a-z0-9][a-z0-9_]{1,}/g) || []),
    ...cjkBigrams(value),
  ]);
  return [...terms].filter((term) => term.length >= 2);
}

export function recentLifeDayKeys(now = new Date(), boundaryHour = 4, count = RECENT_BASE_DAYS) {
  const n = Math.max(0, Number(count) || 0);
  const first = finishedLifeDayKey(now, boundaryHour);
  return Array.from({ length: n }, (_, index) => shiftDateKey(first, -index)).filter(Boolean);
}

export function scoreSummaryEntry(entry, { baseDates = new Set(), prompt = "", now = new Date(), boundaryHour = 4 } = {}) {
  if (!usable(entry)) return -Infinity;
  const date = String(entry.date || "");
  const base = baseDates.has(date);
  let score = base ? 1000 : 0;
  const terms = promptTerms(prompt);
  const text = String(entry.text || "").toLowerCase();
  let overlap = 0;
  for (const term of terms) {
    if (text.includes(term)) overlap++;
  }
  // 近期底座不依赖话题命中；更老内容至少命中一个两字词，才值得展开。
  score += overlap * 45;
  if (Number(entry.importance) >= 7) score += 25;
  if (entry.source === "edited") score += 4;
  if (!base && !overlap && Number(entry.importance) < 7) return -Infinity;

  const first = finishedLifeDayKey(now, boundaryHour);
  const age = Math.max(0, Math.round((new Date(`${first}T12:00:00`).getTime() - new Date(`${date}T12:00:00`).getTime()) / 86400000));
  score += Math.max(0, 30 - age);
  return score;
}

function dateOrder(a, b) {
  if (a.date !== b.date) return a.date < b.date ? 1 : -1;
  if (a.agentId !== b.agentId) return String(a.agentId).localeCompare(String(b.agentId));
  return String(a.text).localeCompare(String(b.text));
}

export function selectRecentSummaries(entries, {
  now = new Date(),
  boundaryHour = 4,
  currentAgentId = "",
  shared = false,
  prompt = "",
  baseDays = RECENT_BASE_DAYS,
  lookbackDays = RECENT_LOOKBACK_DAYS,
  maxEntries = 10,
  maxChars = RECENT_CHAR_BUDGET,
} = {}) {
  const baseDates = new Set(recentLifeDayKeys(now, boundaryHour, baseDays));
  const first = [...baseDates][0] || finishedLifeDayKey(now, boundaryHour);
  const last = shiftDateKey(first, -(Math.max(1, Number(lookbackDays) || RECENT_LOOKBACK_DAYS) - 1));
  // 没有可靠的当前伙伴身份时，默认模式宁可不注入，也不把别人的档案当成自己的。
  if (!shared && !String(currentAgentId || "").trim()) {
    return { entries: [], baseDates: [...baseDates], expanded: false };
  }

  const candidates = (Array.isArray(entries) ? entries : [])
    .filter((entry) => usable(entry) && usableAgentId(entry.agentId) && (shared || entry.agentId === currentAgentId))
    .filter((entry) => entry.date >= last && entry.date <= first)
    .map((entry) => ({ ...entry, score: scoreSummaryEntry(entry, { baseDates, prompt, now, boundaryHour }) }))
    .filter((entry) => Number.isFinite(entry.score));

  const base = candidates.filter((entry) => baseDates.has(entry.date)).sort((a, b) => {
    const aCurrent = a.agentId === currentAgentId ? 1 : 0;
    const bCurrent = b.agentId === currentAgentId ? 1 : 0;
    return bCurrent - aCurrent || dateOrder(a, b);
  });
  const expanded = candidates
    .filter((entry) => !baseDates.has(entry.date))
    .sort((a, b) => b.score - a.score || dateOrder(a, b))
    .filter((entry) => promptTerms(prompt).length > 0 || Number(entry.importance) >= 7);

  const selected = [];
  const used = new Set();
  let chars = 0;
  for (const entry of [...base, ...expanded]) {
    const key = `${entry.date}\u0000${entry.agentId}`;
    if (used.has(key) || selected.length >= Math.max(1, Number(maxEntries) || 10)) continue;
    const text = String(entry.text || "").trim();
    const remaining = Math.max(0, Number(maxChars) || RECENT_CHAR_BUDGET) - chars;
    if (!remaining) break;
    const clipped = text.slice(0, remaining);
    if (!clipped) break;
    selected.push({ ...entry, text: clipped, expanded: !baseDates.has(entry.date) });
    used.add(key);
    chars += clipped.length;
  }

  return {
    entries: selected,
    baseDates: [...baseDates],
    expanded: selected.some((entry) => entry.expanded),
  };
}

export function formatRecentSummaries(entries, {
  currentAgentId = "",
  shared = false,
  proactiveDate = "",
  userName = "",
} = {}) {
  const list = (Array.isArray(entries) ? entries : []).filter((entry) => usable(entry) && usableAgentId(entry.agentId));
  if (!list.length) return "";
  const formatEntry = (entry) => {
    const isOther = shared && entry.agentId !== currentAgentId;
    const who = isOther ? `· ${entry.agentName || entry.agentId}` : "";
    return `${entry.date}${who}：${entry.text}`;
  };
  const proactive = proactiveDate ? list.filter((entry) => entry.date === proactiveDate) : [];
  const background = proactiveDate ? list.filter((entry) => entry.date !== proactiveDate) : list;
  const lines = [];
  if (proactive.length) {
    lines.push(`【已收好的上一生活日｜${proactiveDate}】`);
    lines.push(...proactive.map(formatEntry));
    const person = String(userName || "对方").trim() || "对方";
    lines.push(`以下内容属于已经结束的生活日 ${proactiveDate}；档案正文中的“昨天/今天”等相对日期词，也以这个生活日日期为准。不等于上一个聊天窗口；同一自然日内的前一个对话框不属于这份档案，提及时用“今天早些时候”或“前一个对话框”。今天第一次回应${person}时，优先自然接住其中一件最贴近的事，让${person}知道这段已经收好的生活有被记住；不用逐条播报。`);
  }
  if (background.length) {
    lines.push("【近期回忆】");
    lines.push(...background.map(formatEntry));
    lines.push("这些是已经发生过的近期生活记录；只有和当前话题自然相关时才带出来，不要主动逐条汇报。");
  }
  return lines.join("\n");
}
