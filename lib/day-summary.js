// 拾光记 · 生活日与每日总结纯逻辑
// 一天可在午夜后延迟翻篇，避免晚睡对话被错误算进第二天。
// 文件预算豁免：会话筛选、伙伴分组与生活日边界需要共享同一套保守过滤规则。

import fs from "node:fs";
import path from "node:path";
import { dateKey } from "./data.js";

const HIDDEN_TAGS = ["think", "analysis", "reasoning", "mood", "pulse"];
const TECHNICAL_AGENT_RE = /(?:^|[-_])(probe|test)(?:[-_]|$)/i;
const HANABREW_VISITOR_RE = /^hanabrew-visitor-/i;

// 会话元数据读取：
// session-meta.json 是宿主对“特殊会话”（插件私有/带快照等）的稀疏登记，普通会话不在其中、无条目即视为普通对话放行。
// - 文件不存在：返回空对象（可信：没有登记 = 没有特殊会话，普通对话照常放行）。
// - 文件存在且可解析：返回 文件名 -> 元数据 映射。
// - 文件存在但损坏/解析失败：返回 null。此时已有登记可能丢失，无法区分普通会话与插件私有会话，
//   调用方必须 fail-closed（跳过该目录），避免把插件私有内容误当普通对话收进生活日。
function readSessionMeta(sessionsDir) {
  try {
    const file = path.join(sessionsDir, "session-meta.json");
    if (!fs.existsSync(file)) return {};
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

// meta 文件损坏/解析失败时整目录保守跳过（fail-closed）；正常目录（含稀疏登记与缺失）放行。
function isSessionMetaUsable(sessionMeta) {
  return sessionMeta !== null && typeof sessionMeta === "object";
}

function isPluginOwnedSession(meta) {
  const plugin = meta?.plugin;
  // 插件私有会话是后台工作或插件内部流程，默认不进入生活日总结；以后可由通用来源设置显式纳入。
  return plugin?.visibility === "plugin_private" || typeof plugin?.ownerPluginId === "string";
}

export function normalizeBoundaryHour(value) {
  const n = Number(value);
  return [0, 2, 4].includes(n) ? n : 4;
}

export function shiftDateKey(key, days) {
  const d = new Date(`${key}T12:00:00`);
  if (Number.isNaN(d.getTime())) return "";
  d.setDate(d.getDate() + days);
  return dateKey(d);
}

export function lifeDayKey(now = new Date(), boundaryHour = 4) {
  const hour = normalizeBoundaryHour(boundaryHour);
  const d = new Date(now);
  if (d.getHours() < hour) d.setDate(d.getDate() - 1);
  return dateKey(d);
}

export function finishedLifeDayKey(now = new Date(), boundaryHour = 4) {
  return shiftDateKey(lifeDayKey(now, boundaryHour), -1);
}

export function lifeDayRange(key, boundaryHour = 4) {
  const hour = normalizeBoundaryHour(boundaryHour);
  const start = new Date(`${key}T00:00:00`);
  if (Number.isNaN(start.getTime())) return null;
  start.setHours(hour, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

export function sanitizeVisibleText(value) {
  let text = String(value || "");
  for (const tag of HIDDEN_TAGS) {
    text = text.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi"), " ");
    text = text.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*$`, "gi"), " ");
  }
  text = text.replace(/```(?:analysis|reasoning|think)[\s\S]*?```/gi, " ");
  text = text.replace(/<(UpdateVariable|JSONPatch)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  text = text.replace(/<StatusPlaceHolderImpl\s*\/?>/gi, " ");
  text = text.trim();
  if (/^【(?:今日时光|任务续接)】/.test(text)) return "";
  return text.replace(/\s+/g, " ").trim();
}

export function isSyntheticSummaryText(text) {
  const value = String(text || "").trim();
  return /^\[SessionFile\]/i.test(value) || /^\[来自\s*(?:Agent|助手)[^\]]*(?:非用户本人|非本人)[^\]]*\]/i.test(value) || /测试消息|验证(?:其|这条消息)?是否能显示在.+会话|收到续接摘要/.test(value);
}

export function extractMessageText(content) {
  if (typeof content === "string") return sanitizeVisibleText(content);
  if (!Array.isArray(content)) return "";
  return sanitizeVisibleText(
    content
      .filter((part) => part?.type === "text" && part.text)
      .map((part) => part.text)
      .join(" ")
  );
}

export function isUserFacingAgentId(agentId) {
  const id = String(agentId || "");
  return !!id && !["archived", "session-meta-payloads"].includes(id) && !TECHNICAL_AGENT_RE.test(id);
}

export function collectDayMessages({
  agentsDir,
  targetDate,
  boundaryHour = 4,
  maxMessages = 120,
  maxMessagesPerAgent = 0,
  includePluginPrivate = false,
}) {
  const limit = Math.max(2, Number(maxMessages) || 120);
  const perAgentLimit = Math.max(0, Number(maxMessagesPerAgent) || 0);
  const range = lifeDayRange(targetDate, boundaryHour);
  if (!range) throw new Error("总结日期格式不对");
  const rows = [];
  let agentIds = [];
  try {
    agentIds = fs.readdirSync(agentsDir).filter(isUserFacingAgentId);
  } catch {
    return { messages: [], range };
  }

  for (const agentId of agentIds) {
    const sessionsDir = path.join(agentsDir, agentId, "sessions");
    const sessionMeta = readSessionMeta(sessionsDir);
    // meta 文件缺失或损坏：无法区分普通会话与插件私有会话，整目录保守跳过（fail-closed），
    // 宁可少收一天，不可把插件后台内容误当用户对话收进生活日。
    if (!includePluginPrivate && !isSessionMetaUsable(sessionMeta)) continue;
    let files = [];
    try {
      files = fs.readdirSync(sessionsDir).filter((name) => name.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const file of files) {
      if (!includePluginPrivate && isPluginOwnedSession(sessionMeta[file])) continue;
      let raw = "";
      try {
        raw = fs.readFileSync(path.join(sessionsDir, file), "utf-8");
      } catch {
        continue;
      }
      for (const line of raw.split("\n")) {
        if (!line) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.type !== "message" || !entry.message || !entry.timestamp) continue;
          if (entry.message.display === false) continue;
          const ts = new Date(entry.timestamp);
          if (Number.isNaN(ts.getTime()) || ts < range.start || ts >= range.end) continue;
          const role = entry.message.role;
          if (role !== "user" && role !== "assistant") continue;
          const text = extractMessageText(entry.message.content);
          if (!text || isSyntheticSummaryText(text)) continue;
          rows.push({
            ts: ts.getTime(),
            role,
            agentId,
            text: text.slice(0, 500),
            opening: typeof entry.id === "string" && entry.id.startsWith("visitor-opening-"),
          });
        } catch {
          // 单行损坏不影响其他会话。
        }
      }
    }
  }

  rows.sort((a, b) => a.ts - b.ts);
  let balancedRows = rows;
  if (perAgentLimit > 0) {
    balancedRows = Object.values(groupMessagesByAgent(rows)).flatMap((group) => {
      if (group.length <= perAgentLimit) return group;
      if (perAgentLimit === 1) return [group[group.length - 1]];
      return Array.from({ length: perAgentLimit }, (_, i) => group[Math.round(i * (group.length - 1) / (perAgentLimit - 1))]);
    }).sort((a, b) => a.ts - b.ts);
  }
  const trimmed = balancedRows.length > limit
    ? Array.from({ length: limit }, (_, i) => balancedRows[Math.round(i * (balancedRows.length - 1) / (limit - 1))])
    : balancedRows;
  return { messages: trimmed, range };
}

export function groupMessagesByAgent(messages) {
  const groups = {};
  for (const row of Array.isArray(messages) ? messages : []) {
    const agentId = String(row?.agentId || "").trim();
    if (!agentId || !isUserFacingAgentId(agentId)) continue;
    if (!groups[agentId]) groups[agentId] = [];
    groups[agentId].push(row);
  }
  return groups;
}

export function formatMessagesForPrompt(messages, { agentName = "" } = {}) {
  return (Array.isArray(messages) ? messages : [])
    .map((row) => `${row.role === "user" ? "我" : (agentName || row.agentId)}：${row.text}`)
    .join("\n");
}

// 只读公开显示名，不读取 identity/ishiki 等性格文件；找不到时由调用方回退到 agentId。
export function parseAgentDisplayName(yaml) {
  if (typeof yaml !== "string" || !yaml.trim()) return "";
  const block = yaml.match(/^agent:\s*\r?\n([\s\S]*?)(?=^\S|\s*$)/m);
  const scope = block ? block[1] : yaml;
  const match = scope.match(/^\s*name:\s*(.+)$/m);
  return match ? match[1].trim().replace(/^['"]|['"]$/g, "").trim() : "";
}

export function readAgentDisplayName(agentsDir, agentId) {
  const id = String(agentId || "").trim();
  if (!id || !isUserFacingAgentId(id)) return "";
  try {
    const yaml = fs.readFileSync(path.join(agentsDir, id, "config.yaml"), "utf-8");
    return parseAgentDisplayName(yaml);
  } catch {
    return "";
  }
}

export function isHanabrewInstalled(agentsDir) {
  try {
    const hanaHome = path.dirname(path.resolve(agentsDir));
    return fs.existsSync(path.join(hanaHome, "plugins", "hanabrew", "manifest.json"));
  } catch {
    return false;
  }
}

export function readHanabrewVisitorAliases(agentsDir) {
  const aliases = new Map();
  if (!isHanabrewInstalled(agentsDir)) return aliases;
  try {
    const appData = process.env.APPDATA;
    if (!appData) return aliases;
    const statePath = path.join(appData, "hanabrew", "state.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    const visitors = [
      ...(Array.isArray(state?.visitors) ? state.visitors : []),
      ...(state?.visitor && typeof state.visitor === "object" ? [state.visitor] : []),
    ];
    for (const visitor of visitors) {
      const id = String(visitor?.agentId || "").trim();
      const name = String(visitor?.characterName || "").trim();
      if (HANABREW_VISITOR_RE.test(id) && name) aliases.set(id, name.slice(0, 80));
    }
    // 旧版花酿只留下 pending visitor id 时，lastVisitorDeparture 是最后一条可靠角色名线索。
    const lastName = String(state?.lastVisitorDeparture?.characterName || "").trim().slice(0, 80);
    if (lastName && Array.isArray(state?.pendingVisitorCleanup)) {
      for (const value of state.pendingVisitorCleanup) {
        const id = String(value || "").trim();
        if (HANABREW_VISITOR_RE.test(id) && !aliases.has(id)) aliases.set(id, lastName);
      }
    }
  } catch {
    // 花酿未运行、状态文件不存在或格式异常时，交给目录人格/配置回退。
  }
  return aliases;
}

function readActiveHanabrewVisitorIds(agentsDir) {
  const ids = new Set();
  if (!isHanabrewInstalled(agentsDir)) return ids;
  try {
    const appData = process.env.APPDATA;
    if (!appData) return ids;
    const state = JSON.parse(fs.readFileSync(path.join(appData, "hanabrew", "state.json"), "utf-8"));
    const visitors = [
      ...(Array.isArray(state?.visitors) ? state.visitors : []),
      ...(state?.visitor && typeof state.visitor === "object" ? [state.visitor] : []),
    ];
    for (const visitor of visitors) {
      const id = String(visitor?.agentId || "").trim();
      if (HANABREW_VISITOR_RE.test(id) && visitor?.status !== "departed") ids.add(id);
    }
  } catch {
    // 花酿状态不可读时不把历史临时目录冒充成当前可选伙伴。
  }
  return ids;
}

export function parseHanabrewVisitorName(text) {
  const match = String(text || "").slice(0, 8000).match(/^\s*你是\s*([^，。,：:!?！?\n]+?)(?:[，。,：:!?！?]|$)/m);
  return match ? match[1].trim().replace(/^['"「『]|['"」』]$/g, "").slice(0, 80) : "";
}

export function readHanabrewVisitorName(agentsDir, agentId) {
  const id = String(agentId || "").trim();
  if (!HANABREW_VISITOR_RE.test(id)) return "";
  const stateName = readHanabrewVisitorAliases(agentsDir).get(id);
  if (stateName) return stateName;
  const configuredName = readAgentDisplayName(agentsDir, id);
  if (configuredName) return configuredName;
  try {
    return parseHanabrewVisitorName(fs.readFileSync(path.join(agentsDir, id, "AGENTS.md"), "utf-8"));
  } catch {
    return "";
  }
}

function visitorSummaryId(name) {
  return `hanabrew-character-${encodeURIComponent(name)}`;
}

export function resolveSummaryPartner(agentsDir, agentId) {
  const id = String(agentId || "").trim();
  const configuredName = readAgentDisplayName(agentsDir, id);
  if (HANABREW_VISITOR_RE.test(id) && isHanabrewInstalled(agentsDir)) {
    const visitorName = readHanabrewVisitorName(agentsDir, id);
    if (visitorName) {
      return { agentId: visitorSummaryId(visitorName), agentName: visitorName, sourceAgentIds: [id], enhanced: true };
    }
  }
  return { agentId: id, agentName: configuredName || id, sourceAgentIds: [id], enhanced: false };
}

export function resolveSummaryAgentId(agentsDir, agentId) {
  return resolveSummaryPartner(agentsDir, agentId).agentId;
}

export function isSummaryAgent(agentsDir, agentId) {
  const id = String(agentId || "").trim();
  if (!isUserFacingAgentId(id)) return false;
  // Hana 删除助手后会保留历史目录并写入删除标记；这些目录只用于续接旧会话，不再算当前伙伴。
  if (fs.existsSync(path.join(agentsDir, id, ".deleted-agent.json"))) return false;
  // 酒馆访客的临时目录可能只剩会话文件；没有配置和人格文件的孤儿目录不进入总结范围。
  if (HANABREW_VISITOR_RE.test(id)) {
    return fs.existsSync(path.join(agentsDir, id, "config.yaml")) || fs.existsSync(path.join(agentsDir, id, "AGENTS.md"));
  }
  return true;
}

export function listSummaryAgents(agentsDir) {
  let ids = [];
  const activeVisitorIds = readActiveHanabrewVisitorIds(agentsDir);
  try {
    ids = fs.readdirSync(agentsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isSummaryAgent(agentsDir, entry.name))
      // 花酿来访目录会在角色离开后保留一阵；选择列表只显示当前仍在 Hana 的来访者。
      .filter((entry) => !HANABREW_VISITOR_RE.test(entry.name) || activeVisitorIds.has(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const partners = new Map();
  for (const agentId of ids) {
    const partner = resolveSummaryPartner(agentsDir, agentId);
    if (!partners.has(partner.agentId)) partners.set(partner.agentId, { agentId: partner.agentId, agentName: partner.agentName });
  }
  return [...partners.values()]
    .sort((a, b) => a.agentName.localeCompare(b.agentName, "zh-CN") || a.agentId.localeCompare(b.agentId));
}

function dedupeRepeatedSummaryMessages(messages) {
  const seen = new Set();
  return messages.filter((row) => {
    const text = String(row?.text || "");
    if (text.length < 80 && !row?.opening) return true;
    const key = `${row.role}\u0000${text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function groupSummaryMessages(messages, { agentsDir = "" } = {}) {
  const groups = new Map();
  const partnerCache = new Map();
  const selectableCache = new Map();
  const displayNameCache = new Map();
  const getDisplayName = (agentId) => {
    if (!agentsDir) return "";
    if (!displayNameCache.has(agentId)) displayNameCache.set(agentId, readAgentDisplayName(agentsDir, agentId));
    return displayNameCache.get(agentId);
  };
  for (const row of Array.isArray(messages) ? messages : []) {
    const rawAgentId = String(row?.agentId || "").trim();
    if (!rawAgentId || !isUserFacingAgentId(rawAgentId)) continue;
    if (agentsDir) {
      if (!selectableCache.has(rawAgentId)) selectableCache.set(rawAgentId, isSummaryAgent(agentsDir, rawAgentId));
      if (!selectableCache.get(rawAgentId)) continue;
    }
    if (isSyntheticSummaryText(row?.text)) continue;
    const displayName = getDisplayName(rawAgentId);
    let partner;
    if (agentsDir) {
      if (!partnerCache.has(rawAgentId)) partnerCache.set(rawAgentId, resolveSummaryPartner(agentsDir, rawAgentId));
      partner = partnerCache.get(rawAgentId);
    } else {
      partner = { agentId: rawAgentId, agentName: row?.agentName || rawAgentId, sourceAgentIds: [rawAgentId], enhanced: false };
    }
    let group = groups.get(partner.agentId);
    if (!group) {
      group = {
        agentId: partner.agentId,
        agentName: partner.agentName,
        modelAgentId: partner.enhanced
          ? (displayName ? rawAgentId : "")
          : rawAgentId,
        messages: [],
        sourceAgentIds: new Set(),
        enhanced: partner.enhanced,
      };
      groups.set(partner.agentId, group);
    }
    // 跟随助手模型时必须传真实 Agent 编号；逻辑角色 key 只用于归档与匹配。
    if (agentsDir && displayName) group.modelAgentId = rawAgentId;
    group.sourceAgentIds.add(rawAgentId);
    group.messages.push({ ...row, agentId: partner.agentId, agentName: partner.agentName, sourceAgentId: rawAgentId });
  }
  return [...groups.values()].map((group) => ({
    ...group,
    messages: group.enhanced ? dedupeRepeatedSummaryMessages(group.messages) : group.messages,
    sourceAgentIds: [...group.sourceAgentIds],
  }));
}

export function groupHistoricalSummaryEntries(entries, { agentsDir = "" } = {}) {
  if (!agentsDir || !isHanabrewInstalled(agentsDir)) return [];
  const candidates = (Array.isArray(entries) ? entries : []).filter((entry) => HANABREW_VISITOR_RE.test(String(entry?.agentId || "")));
  if (!candidates.length) return [];
  const nameCache = new Map();
  const getVisitorName = (agentId) => {
    if (!nameCache.has(agentId)) nameCache.set(agentId, readHanabrewVisitorName(agentsDir, agentId));
    return nameCache.get(agentId);
  };
  const knownNames = new Set();
  for (const entry of candidates) {
    const rawId = String(entry.agentId || "");
    const name = getVisitorName(rawId);
    if (name) knownNames.add(name);
    const storedName = String(entry.agentName || "").trim();
    if (storedName && storedName !== rawId && !HANABREW_VISITOR_RE.test(storedName)) knownNames.add(storedName);
  }
  const groups = new Map();
  for (const entry of candidates) {
    const rawId = String(entry.agentId || "").trim();
    const text = sanitizeVisibleText(entry.text);
    if (!rawId || !text) continue;
    const synthetic = isSyntheticSummaryText(text);
    const storedName = String(entry.agentName || "").trim();
    const name = getVisitorName(rawId) ||
      (storedName && !HANABREW_VISITOR_RE.test(storedName) ? storedName : "") ||
      [...knownNames].find((candidate) => text.includes(candidate)) || "";
    const logicalId = name ? visitorSummaryId(name) : rawId;
    let group = groups.get(logicalId);
    if (!group) {
      group = {
        agentId: logicalId,
        agentName: name || storedName || rawId,
        modelAgentId: readAgentDisplayName(agentsDir, rawId) ? rawId : "",
        messages: [],
        sourceAgentIds: new Set(),
        enhanced: !!name,
      };
      groups.set(logicalId, group);
    }
    if (!group.modelAgentId && readAgentDisplayName(agentsDir, rawId)) group.modelAgentId = rawId;
    group.sourceAgentIds.add(rawId);
    if (synthetic) continue;
    group.messages.push({
      ts: Date.parse(entry.updatedAt || "") || 0,
      role: "assistant",
      agentId: logicalId,
      agentName: group.agentName,
      sourceAgentId: rawId,
      historical: true,
      text,
    });
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      messages: group.enhanced ? dedupeRepeatedSummaryMessages(group.messages) : group.messages,
      sourceAgentIds: [...group.sourceAgentIds],
    }))
    .filter((group) => group.messages.length > 0);
}

export function mergeSummaryGroups(primary, secondary) {
  const merged = (Array.isArray(primary) ? primary : []).map((group) => ({
    ...group,
    messages: [...(group.messages || [])],
    sourceAgentIds: [...(group.sourceAgentIds || [])],
  }));
  const byId = new Map(merged.map((group) => [group.agentId, group]));
  for (const extra of Array.isArray(secondary) ? secondary : []) {
    const current = byId.get(extra.agentId);
    if (!current) {
      const copy = { ...extra, messages: [...(extra.messages || [])], sourceAgentIds: [...(extra.sourceAgentIds || [])] };
      merged.push(copy);
      byId.set(copy.agentId, copy);
      continue;
    }
    const sourceIds = new Set(current.sourceAgentIds);
    for (const sourceAgentId of extra.sourceAgentIds || []) sourceIds.add(sourceAgentId);
    const existingSourceIds = new Set(current.messages.map((message) => message.sourceAgentId || message.agentId));
    for (const message of extra.messages || []) {
      const sourceAgentId = message.sourceAgentId || message.agentId;
      if (!existingSourceIds.has(sourceAgentId)) current.messages.push(message);
    }
    current.sourceAgentIds = [...sourceIds];
    current.modelAgentId = current.modelAgentId || extra.modelAgentId || "";
    current.enhanced = current.enhanced || extra.enhanced;
    if (current.enhanced) current.messages = dedupeRepeatedSummaryMessages(current.messages).sort((a, b) => (a.ts || 0) - (b.ts || 0));
  }
  return merged;
}
