// feedback · core/env.js — 环境信息收集
// 用户不用填任何版本号，这里自动收集（尽力而为，拿不到写"未知"，不阻塞）

import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// 收集环境信息
// opts: { manifestPath, pluginName, hanaVersion, modelConfigInfo }
//   manifestPath    — 插件 manifest.json 路径（可选，用于读版本）
//   pluginName      — 插件名（可选，兜底用目录名）
//   hanaVersion     — 由接入方传入 Hana 版本（可选，拿不到写"未知"）
//   modelConfigInfo — 脱敏模型档位（可选，插件引了 model-config 时传入）
//                     { source, agentFollow, hanaModel: { providerId, modelId }, customModel: { api } }
export function collectEnv(opts = {}) {
  const out = {
    pluginName: opts.pluginName || "",
    pluginVersion: "未知",
    hanaVersion: String(opts.hanaVersion || "未知"),
    os: describeOs(),
    modelSource: "",
  };

  // 读 manifest 拿插件名/版本
  if (opts.manifestPath) {
    try {
      const manifest = JSON.parse(fs.readFileSync(opts.manifestPath, "utf-8"));
      out.pluginName = out.pluginName || String(manifest.name || "");
      out.pluginVersion = String(manifest.version || "未知");
    } catch {
      // 读不到就保持默认
    }
  }
  if (!out.pluginName) out.pluginName = path.basename(path.dirname(opts.manifestPath || "")) || "未知";

  // 模型档位描述（不含任何 Key）
  const mc = opts.modelConfigInfo;
  if (mc) {
    if (mc.source === "custom") {
      out.modelSource = `自定义 API（${(mc.customModel?.api || "openai-completions").replace("openai-", "").replace("-messages", "")}）`;
    } else if (mc.source === "hana" && mc.hanaModel?.providerId && mc.hanaModel?.modelId) {
      out.modelSource = `Hana 指定（${mc.hanaModel.providerId} / ${mc.hanaModel.modelId}）`;
    } else {
      out.modelSource = "跟随助手当前模型";
    }
  }

  return out;
}

function describeOs() {
  try {
    return `${os.platform()} ${os.release()} ${os.arch()}`;
  } catch {
    return "未知";
  }
}

// 渲染成给模型看的文本块
export function renderEnvText(env) {
  const lines = ["【环境信息】（自动收集，反馈时原样带上）"];
  lines.push(`- 插件：${env.pluginName || "未知"} v${env.pluginVersion || "未知"}`);
  lines.push(`- Hana 版本：${env.hanaVersion || "未知"}`);
  lines.push(`- 系统：${env.os || "未知"}`);
  if (env.modelSource) lines.push(`- 模型档位：${env.modelSource}`);
  return lines.join("\n");
}
