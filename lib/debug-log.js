// 拾光记 · 文件日志工具
// 把 [拾光记] 前缀的运行日志写到插件数据目录 debug.log，
// 便于排查自动总结/待办提醒/模型配置等问题。
// ctx.log 的路在本宿主下不落盘（排查发现主日志搜不到插件自定义日志），
// 所以关键节点统一走这里，保证「写进文件、查得到」。
//
// 轮转：超过 500KB 截断保留后半段，防止无限膨胀（表情包/解语花同款思路）。

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DATA_DIR = process.env.HANA_HOME
  ? path.join(process.env.HANA_HOME, "plugin-data", "shiguangji")
  : path.join(os.homedir(), ".hanako", "plugin-data", "shiguangji");
const LOG_FILE = path.join(DATA_DIR, "debug.log");
const MAX_LOG_SIZE = 500 * 1024;

function appendLog(level, args) {
  try {
    // 懒创建目录（插件数据目录通常已存在，避免启动期建目录副作用）
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    try {
      const stat = fs.statSync(LOG_FILE);
      if (stat.size > MAX_LOG_SIZE) {
        const content = fs.readFileSync(LOG_FILE, "utf-8");
        fs.writeFileSync(LOG_FILE, content.slice(Math.floor(content.length / 2)), "utf-8");
      }
    } catch {
      // 文件不存在或读取失败，跳过轮转直接追加
    }
    const text = args
      .map((v) => (typeof v === "string" ? v : safeStringify(v)))
      .join(" ");
    const line = `[${new Date().toISOString()}] [${level}] ${text}\n`;
    fs.appendFileSync(LOG_FILE, line, "utf-8");
  } catch {
    // 日志失败绝不影响主流程
  }
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function logInfo(...args) {
  appendLog("INFO", args);
}

export function logWarn(...args) {
  appendLog("WARN", args);
}

export function logError(...args) {
  appendLog("ERROR", args);
}
