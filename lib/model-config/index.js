// model-config · 入口
// 三档模型配置模块：agent（跟随助手）/ hana（Hana 模型列表选）/ custom（自定义 API）
//
// ⚠️ 接入前先看 plugin-kit/README.md（拷贝说明 / manifest 能力片段 / store 示例 / 前端凭证）
//
// 用法（Hana 插件是 ESM，用 import 带 /index.js 的路径，不要用 require；
//       ctx 只在路由注册函数里有，初始化必须在函数内做）：
//   import { ModelConfig } from "./lib/model-config/index.js";
//
//   export default function registerRoutes(app, ctx) {
//     const mc = new ModelConfig({ ctx, store: makeStore(ctx) });   // store 见 README「契约示意」
//     mc.setHanaModelsProvider(async () => [...]);                  // 可选：注入拉取 Hana 模型列表的实现
//     app.get("/api/model-config", async (c) => c.json(await mc.handleGet()));
//     app.post("/api/model-config", async (c) => c.json(await mc.handleSave(await c.req.json().catch(() => ({})))));
//     app.post("/api/model-config/test", async (c) => c.json(await mc.handleTest(await c.req.json().catch(() => ({})))));
//     app.get("/api/model-config/hana-models", async (c) => c.json(await mc.handleHanaModels()));
//   }
//
// manifest 能力片段（合并进现有 manifest；同时引多块积木时取并集）：
//   {
//     "trust": "full-access",
//     "capabilities": ["model", "network.fetch"],   // model=总线调模型；network.fetch=custom 档直连
//     "network": { "allowedHosts": ["*"], "methods": ["POST"], "defaultTimeoutMs": 30000 }
//   }
//   自定义 API 允许任意供应商所以要通配 host；只允许指定供应商时可收窄 allowedHosts。
//   前端路由注意：后端注册 "/api/model-config"（带斜杠），前端 apiFetch 传 "api/model-config"（不带）；
//   凭证方式见 ui/model-config-panel.js 头部注释（自动用 window.__TOKEN 拼 token，不依赖 hana.api.fetch）。

import { createCrypto, encryptKey, decryptKey, maskKey, protectKey, unprotectKey, getStorageMode } from "./core/crypto.js";
import { mergeModelConfig, sanitizeModelConfig, validateModelConfig, normalizeApi } from "./core/merge.js";
import { ModelConfig, extractModelText, extractModelResponse, parseModelJson } from "./core/client.js";

export {
  createCrypto, encryptKey, decryptKey, maskKey, protectKey, unprotectKey, getStorageMode,
  mergeModelConfig, sanitizeModelConfig, validateModelConfig, normalizeApi,
  ModelConfig, extractModelText, extractModelResponse, parseModelJson,
};
