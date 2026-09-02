// update-checker · 入口
// 检查更新模块：读 manifest 当前版本 → 查 GitHub releases/latest → 对比 → 返回结果
//
// ⚠️ 接入前先看 plugin-kit/README.md（拷贝说明 / manifest 能力片段 / 前端凭证）
//
// 用法（Hana 插件是 ESM，用 import 带 /index.js 的路径，不要用 require；
//       ctx 只在路由注册函数里有，初始化必须在函数内做）：
//   import { UpdateChecker } from "./lib/update-checker/index.js";
//   import path from "node:path";
//
//   export default function registerRoutes(app, ctx) {
//     const uc = new UpdateChecker({
//       ctx,
//       manifestPath: path.join(ctx.pluginDir, "manifest.json"),  // 推荐用 ctx.pluginDir
//     });
//     app.get("/api/check-update", async (c) => c.json(await uc.check({ repo: "moononnn/xxx" })));
//   }
//
// manifest 能力片段（合并进现有 manifest）：
//   {
//     "trust": "full-access",
//     "capabilities": ["network.fetch"],                       // 查 GitHub releases 需要
//     "network": { "allowedHosts": ["api.github.com"], "methods": ["GET"], "defaultTimeoutMs": 10000 }
//   }
//   前端路由注意：后端注册 "/api/check-update"（带斜杠），前端 apiFetch 传 "api/check-update"（不带）；
//   凭证方式见对应 ui 文件头部注释（自动用 window.__TOKEN 拼 token，不依赖 hana.api.fetch）。

import { compareVersions } from "./core/compare.js";
import { UpdateChecker } from "./core/checker.js";

export { compareVersions, UpdateChecker };

