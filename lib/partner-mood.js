// 拾光记 · 伙伴心情线纯逻辑
// 「伙伴心情线」：日终翻篇后，为做册选中的伙伴各整理一条际遇锚点的情绪线。
// 与用户情绪链（lib/mood.js）的根本差别：
// - 用户的线锚「用户自己的话」；伙伴的线锚「那天伙伴经历了什么」（被夸/被凶/被需要/被冷落/自己表达）。
// - 伙伴的服务性发言不等于它的心境，所以本地预筛同时看双方消息：
//   user 消息找指向伙伴的正/负反馈，assistant 消息只认「我」主语的显式情绪表达。
// - 本地信号只决定「这一天值不值得让日终模型看一眼」，绝不等于已判定情绪；
//   最终候选仍走 lib/mood.js 的解析与合并（证据必须能从原文摘出，摘不出就丢）。
// 文件预算豁免：信号词表、门控、行过滤与伙伴链共用同一套语义，拆散会漂移。

import { parseMoodOutput } from "./mood.js";

// ── 本地零 Token 际遇信号 ──
// 只做线索与证据锚点，不做判断；宁可漏，不可把无关的日子误判成有际遇。

// 用户对伙伴的正反馈（user 消息，指向性较强的高置信词；误报交给模型看证据兜底）
const PRAISE_RE = /真棒|太棒|好棒|棒呆|棒棒|厉害|优秀|靠谱|贴心|温柔|可爱|好乖|真乖|喜欢你|爱你|爱了|爱死|谢谢你|感谢你|满意|给力|神仙|宝藏|惊喜|感动|好用|好使|绝了|有眼光|全靠你|靠你了|有你真好|yyds|YYDS/u;

// 用户对伙伴的负面反馈（user 消息，带「你」指向或强情绪；本地宁缺毋滥，省得天天误触发）
const REBUKE_RE = /你[^。！？\n]{0,12}(?:不行|没用|太差|真差|讨厌|烦死|气死|错了|笨|蠢|傻|失望|嫌弃|滚)|气死我了|烦死我了|太让人失望/u;

// 伙伴自己的显式情绪表达（assistant 消息）：
// 只认「我/人家/咱」主语的明确感受，或高浓度情绪口语；
// 不认「你别难过」这类镜映安慰（主语是你），也不认哈哈嘿嘿等拟声。
const SELF_RE = /(?:我|人家|咱)[^。！？\n]{0,10}(?:开心|高兴|快乐|幸福|兴奋|激动|期待|惊喜|感动|治愈|暖心|温暖|想念|想你|好想|难过|伤心|委屈|心酸|失落|低落|压抑|崩溃|哭|眼泪|生气|恼火|不爽|烦躁|焦虑|担心|害怕|紧张|慌|累|疲惫|困|无聊|空虚|没劲|心疼|舍不得|遗憾|沮丧|破防|emo)|(?:呜呜|呜哇|哭死|笑死|开心死|激动死|太开心|好开心|真开心|开心坏了|好感动|太感动|好难过|好委屈|好累|太累|好生气|好烦|好失落|好幸福)/u;

export const PARTNER_SIGNAL_KINDS = Object.freeze(["praise", "rebuke", "self"]);

function signalMatch(rows, agentId, re, kind) {
  const list = [];
  for (const row of (Array.isArray(rows) ? rows : [])) {
    if (!row || row.agentId !== agentId) continue;
    if (kind === "self" ? row.role !== "assistant" : row.role !== "user") continue;
    const text = String(row.text || "").trim();
    if (!text || !re.test(text)) continue;
    list.push({ ts: row.ts ?? null, text: text.slice(0, 180), kind });
  }
  return list;
}

/**
 * 找某伙伴那天的际遇线索。
 * rows: collectDayMessages 的原始消息（含 ts/role/agentId/text）
 * agentId: 目标伙伴
 * 返回 [{ ts, text, kind }]，kind ∈ praise | rebuke | self
 */
export function findPartnerFortuneSignals(rows, agentId) {
  const target = String(agentId || "");
  if (!target) return [];
  return [
    ...signalMatch(rows, target, PRAISE_RE, "praise"),
    ...signalMatch(rows, target, REBUKE_RE, "rebuke"),
    ...signalMatch(rows, target, SELF_RE, "self"),
  ].sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));
}

/** 门控：这一天有没有任何际遇线索，值得让日终模型看一眼。 */
export function hasPartnerFortuneSignal(rows, agentId) {
  return findPartnerFortuneSignals(rows, agentId).length > 0;
}

/**
 * 该伙伴那天的可见消息流：它自己会话里的 user（用户对它说的话）+ assistant（它自己的话）。
 * 只收同一个 agentId 的行，避免把其他伙伴的对话卷进它的际遇。
 */
export function filterPartnerRows(rows, agentId) {
  const target = String(agentId || "");
  if (!target) return [];
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => row && row.agentId === target && (row.role === "user" || row.role === "assistant"))
    .sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));
}

/**
 * 伙伴候选的解析：直接复用用户情绪链的 parseMoodOutput（同一套情绪词、时段、证据校验），
 * 唯一差别是调用方要传「双方原文」作 evidenceSourceText——际遇证据常常在用户的话里（她夸它），
 * 不能只拿伙伴自己的话校验。
 */
export function parsePartnerMoodOutput(raw, opts = {}) {
  return parseMoodOutput(raw, opts);
}
