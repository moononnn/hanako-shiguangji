// 拾光记 —— 主 API 访问层（精简版）
//
// 用途：插件后端要调「另一个插件」的 HTTP 路由时，走 Hana 的本机主 API 代理。
//
// 原理：Hana 把本机最高权限的 loopback token 明文写在 <HANA_HOME>/server-info.json，
//   带着它访问 127.0.0.1 的主 API 时，请求被判为 local 连接（principal 是
//   local_user / loopback_token，拥有全部 scope），因此能穿过插件路由的 surface 鉴权。
//   插件自身的 principal scopes 为空，直接拼 localhost 是进不去的，这是唯一正路。
//
// 参考实现：模型匣 lib/host-api.js（同源思路，这边只保留要用的部分）。

import fs from "node:fs";
import path from "node:path";

const SERVER_INFO_FILE = "server-info.json";
const REQUEST_TIMEOUT_MS = 8000;

/** HANA_HOME = 插件目录的上级上级（.../.hanako/plugins/shiguangji → .../.hanako） */
export function resolveHanakoHome(ctx) {
  if (!ctx?.pluginDir) return null;
  return path.resolve(ctx.pluginDir, "..", "..");
}

/** 读 server-info.json 拿 port / token；读不到或字段不合法返回 null */
export function discoverServer(hanakoHome) {
  try {
    const raw = fs.readFileSync(path.join(hanakoHome, SERVER_INFO_FILE), "utf-8");
    const info = JSON.parse(raw);
    if (!info || typeof info.token !== "string" || !info.token) return null;
    if (!Number.isInteger(info.port) || info.port <= 0) return null;
    return { port: info.port, token: info.token, host: "127.0.0.1", version: info.version || null };
  } catch {
    return null;
  }
}

export function serverBaseUrl(server) {
  return `http://${server.host}:${server.port}`;
}

/** 带 Bearer 的主 API 请求；返回 { status, ok, body }，网络异常时抛错 */
export async function apiFetch(server, pathname, init = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init.timeoutMs || REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(serverBaseUrl(server) + pathname, {
      ...init,
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${server.token}`,
        "Content-Type": "application/json",
        ...(init.headers || {}),
      },
    });
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { status: res.status, ok: res.ok, body };
  } catch (err) {
    if (err?.name === "AbortError") throw new Error("连接 Hana 超时（8 秒）");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
