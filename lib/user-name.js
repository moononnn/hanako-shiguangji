// 拾光记 · Hana 用户称呼读取
// 每次读取 users.json，不缓存，让 Hana 配置里的显示名修改后能自然生效。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HANA_HOME = process.env.HANA_HOME || path.join(os.homedir(), ".hanako");

export function parseUserNames(json) {
  try {
    const data = JSON.parse(json);
    if (!data || typeof data !== "object") return { displayName: "", username: "" };
    const profile = Array.isArray(data.users)
      ? (data.users.find((user) => user?.userId === data.defaultUserId) || data.users[0] || {})
      : data;
    return {
      displayName: typeof profile.displayName === "string" ? profile.displayName.trim() : "",
      username: typeof profile.username === "string" ? profile.username.trim() : "",
    };
  } catch {
    return { displayName: "", username: "" };
  }
}

export function readHanaUserName(hanaHome = HANA_HOME) {
  try {
    const usersPath = path.join(hanaHome, "users.json");
    if (!fs.existsSync(usersPath)) return "";
    const { displayName, username } = parseUserNames(fs.readFileSync(usersPath, "utf-8"));
    return (displayName || username || "").replace(/\s+/g, " ").slice(0, 80);
  } catch {
    return "";
  }
}
