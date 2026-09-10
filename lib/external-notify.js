// 拾光记 —— 对外提醒（自动整理停摆时，借提个醒的弹窗把话说给用户）
//
// 只做三件事：把状态翻成人话、认准说话的身份、把请求交给提个醒。
// 弹不弹由提个醒自己决定（总开关、静默时段都在它那边），这边拿到 suppressed
// 就安静收场；404（没装提个醒）也当无事发生——提醒失败绝不能反噬整理主流程。

import { apiFetch, discoverServer, resolveHanakoHome } from "./host-api.js";

const NOTIFY_PATH = "/api/plugins/tigexing/api/external/notify";
const NOTIFY_TITLE = "拾光记 · 自动整理停摆了";

/** "2026-09-09" → "9 月 9 日"；格式不对时原样返回 */
export function formatDayLabel(day) {
  const text = String(day || "").trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return text;
  return `${Number(m[2])} 月 ${Number(m[3])} 日`;
}

/** 停摆提醒的标题与正文（纯函数，供测试） */
export function buildAutoSummaryPausedCopy(day, state = {}) {
  const label = formatDayLabel(day);
  const rawCount = Number(state?.autoRetryCount);
  const count = Number.isFinite(rawCount) ? Math.max(1, Math.floor(rawCount)) : 3;
  const reason = String(state?.autoLastError || "").trim().slice(0, 120);
  const tail = reason ? `最近一次的原因：${reason}。` : "";
  return {
    title: NOTIFY_TITLE,
    message: `${label || "上一次"}的自动整理连续失败 ${count} 次，已经暂停自动重试。方便的时候去时光册手动做一次吧。${tail}`,
  };
}

/**
 * 停摆提醒以谁的身份发出：固定小花。
 * 拾光记本来就是小花在帮着记日子，停摆是整个自动整理的事、不归某个伙伴，
 * 所以不用「做册伙伴第一位」那套（那会让排在首位的伙伴替它挨骂）。
 * 将来若加设置项，以 settings.notifyAgentId 优先；分享版里装的人若没有这个伙伴，
 * 提个醒会自己回退成插件图标，不会坏。
 */
const DEFAULT_NOTIFY_AGENT_ID = "hanako";

export function resolveNotifyAgentId(settings = {}) {
  const configured = String(settings?.notifyAgentId || "").trim();
  return configured || DEFAULT_NOTIFY_AGENT_ID;
}

/**
 * 借提个醒弹一条停摆提醒。
 * 返回 { ok, reason }；reason 取值：
 *   sent        已交给提个醒弹
 *   no-home     拿不到插件安装位置（不该发生）
 *   no-server   读不到 server-info.json
 *   no-plugin   没装提个醒（404）
 *   suppressed  提个醒拦下了（总开关关闭 / 静默时段）
 *   http-N      提个醒返回了错误
 *   error       网络等异常
 */
export async function notifyAutoSummaryPaused({ ctx, settings, day, state, fetchImpl = apiFetch } = {}) {
  try {
    const home = resolveHanakoHome(ctx);
    if (!home) return { ok: false, reason: "no-home" };
    const server = discoverServer(home);
    if (!server) return { ok: false, reason: "no-server" };

    const { title, message } = buildAutoSummaryPausedCopy(day, state);
    const agentId = resolveNotifyAgentId(settings);
    const res = await fetchImpl(server, NOTIFY_PATH, {
      method: "POST",
      body: JSON.stringify(agentId ? { title, message, agentId } : { title, message }),
    });

    if (res?.status === 404) return { ok: false, reason: "no-plugin" };
    if (!res?.ok) return { ok: false, reason: `http-${res?.status || "?"}` };
    if (res?.body?.ok === false) return { ok: false, reason: res?.body?.reason || "suppressed" };
    return { ok: true, reason: "sent" };
  } catch (e) {
    return { ok: false, reason: "error", error: e?.message || String(e) };
  }
}
