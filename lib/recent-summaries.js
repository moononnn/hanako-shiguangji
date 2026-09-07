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
  currentDate = "",
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
  const current = String(currentDate || "当前日期未提供").trim() || "当前日期未提供";
  const lines = [];
  if (proactive.length) {
    lines.push(`【历史档案｜生活日 ${proactiveDate}】`);
    lines.push(...proactive.map(formatEntry));
    const person = String(userName || "对方").trim() || "对方";
    lines.push(`上面这段只记录生活日 ${proactiveDate}；每条事实的日期以行首的绝对日期为准，档案正文里的“今天/昨天”等原话不能改写当前对话的日期。档案只包含正文明确写出的事实；代码注释、模型自身记忆、当前会话或其他窗口里的事实，都不能补写或归入生活日 ${proactiveDate}。当前对话的自然日期是 ${current}，当前会话与同一自然日内的前一个对话框都属于 ${current}，窗口先后不等于日期变化。【日期硬约束适用于所有可见回复和 MOOD】上下文里标为“今天”或只写“凌晨/清晨/今早/上午/刚才”的事实，在没有更早绝对日期证据时按 ${current} 归属；当前自然日内已经发生的这些事项，哪怕跨夜、熬夜或来自前一个对话框，也不能改称“昨晚/昨天”。不要凭窗口顺序使用“昨天”；只有当前自然日期与事实日期的关系明确表示“昨天”时才这样说，日期拿不准就用绝对日期或“今天早些时候/前一个对话框”，不要猜。如果当前话题与这份档案相关，今天第一次回应${person}时，优先自然接住其中一件明确属于生活日 ${proactiveDate}、且确实写在档案正文里的事，让${person}知道这段已经收好的生活有被记住；如果当前话题无关，不要为了证明记得而硬提；不用逐条播报。`);
  }
  if (background.length) {
    lines.push("【近期回忆】");
    lines.push(...background.map(formatEntry));
    lines.push("这些是按每行开头绝对日期归档的近期生活记录；只有和当前话题自然相关时才带出来，不要主动逐条汇报。");
  }
  return lines.join("\n");
}
