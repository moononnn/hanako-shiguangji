// feedback · 入口
// 专职反馈小助手积木：聊天式收集问题 → 自动带环境信息 → 生成规范 issue → 预览确认 → GitHub 预填页收尾
//
// ⚠️ 接入前先看 plugin-kit/README.md（拷贝说明 / manifest 能力片段 / 前端凭证）
//
// 用法（Hana 插件是 ESM，用 import 带 /index.js 的路径，不要用 require；
//       ctx 只在路由注册函数里有，初始化必须在函数内做）：
//   import { Feedback } from "./lib/feedback/index.js";
//   import path from "node:path";
//
//   export default function registerRoutes(app, ctx) {
//     const fb = new Feedback({
//       ctx,
//       config: {
//         pluginName: "我的插件",
//         manifestPath: path.join(ctx.pluginDir, "manifest.json"),
//         repo: "moononnn/xxx",        // 预填页要提交到的仓库
//         hanaVersion: ctx.hanaVersion || "",   // 可选，拿不到写"未知"
//       },
//     });
//     fb.setModelProvider(fn);             // 可选：注入模型调用（如 model-config 的 sample 包装）
//     fb.setModelConfigInfo(mc.sanitize()); // 可选：引了 model-config 时注入脱敏档位（配置变化后记得重新注入）
//     app.post("/api/feedback/chat", async (c) => c.json(await fb.handleChat(await c.req.json().catch(() => ({})))));
//     app.post("/api/feedback/chat/close", async (c) => c.json(await fb.handleClose(await c.req.json().catch(() => ({})))));
//   }
//
// manifest 能力片段（合并进现有 manifest）：
//   {
//     "trust": "full-access",
//     "capabilities": ["model"]           // 默认档走总线调模型（跟随助手）
//   }
//   若注入的 model provider 是自定义 API 直连，再加 "network.fetch" + network.allowedHosts。
//   前端路由注意：后端注册 "/api/feedback/chat"（带斜杠），前端 apiFetch 传 "api/feedback/chat"（不带）；
//   凭证方式见对应 ui 文件头部注释（自动用 window.__TOKEN 拼 token，不依赖 hana.api.fetch）。

import { Feedback, extractText } from "./core/client.js";
import { collectEnv, renderEnvText } from "./core/env.js";
import { buildSystemPrompt } from "./core/prompt.js";
import { parseIssue, stripIssueTag, renderIssueText, buildPrefillUrl, sanitizeIssue } from "./core/issue.js";
import { ChatSession } from "./core/session.js";

export {
  Feedback, extractText,
  collectEnv, renderEnvText,
  buildSystemPrompt,
  parseIssue, stripIssueTag, renderIssueText, buildPrefillUrl, sanitizeIssue,
  ChatSession,
};

