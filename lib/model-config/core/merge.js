// model-config · core/merge.js — 配置合并 / 脱敏 / 校验
// 合并规则：空值、"********" 占位符不覆盖已存 Key；显式 clearApiKey 才删除

import { maskKey, getStorageMode } from "./crypto.js";

// 合并配置（prev 旧配置，next 前端传来的 patch）
// Key 处理：非空且非占位符 → 加密存；clearApiKey: true → 清空
// crypto 可选：传了则 Key 走 await crypto.protectKey() 加密落盘；
// 不传（临时配置/测试路径）则明文暂存，不落盘，无所谓
// （暂存明文会被 unprotectKey 原样读回，见 core/client.js _sampleCustom）
export async function mergeModelConfig(prev, next, crypto = null) {
  const out = { ...(prev || {}) };
  if (!next) return out;
  // 统一存 modelSource（兼容 patch 里传 source 的旧写法）
  const src = next.modelSource || next.source;
  if (src) out.modelSource = src;
  if (next.agentFollow !== undefined) out.agentFollow = next.agentFollow;
  if (next.hanaModel) {
    out.hanaModel = { ...(out.hanaModel || {}) };
    if (next.hanaModel.providerId) out.hanaModel.providerId = next.hanaModel.providerId;
    if (next.hanaModel.modelId) out.hanaModel.modelId = next.hanaModel.modelId;
  }
  if (next.customModel) {
    out.customModel = { ...(out.customModel || {}) }; // 浅拷，不 mutate prev 引用
    if (next.customModel.baseUrl) out.customModel.baseUrl = next.customModel.baseUrl;
    if (next.customModel.model) out.customModel.model = next.customModel.model;
    if (next.customModel.api) out.customModel.api = next.customModel.api;
    const key = next.customModel.apiKey;
    if (key && key !== "********") {
      out.customModel.apiKey = crypto ? await crypto.protectKey(key) : key;
    }
    if (next.customModel.clearApiKey) {
      out.customModel.apiKey = "";
      delete out.customModel.clearApiKey;
    }
  }
  return out;
}

// 脱敏配置（返回给前端，永不含明文 Key）
// v2（2026-08-16）：同时返回 source 和 modelSource 两个字段名，统一存取契约，兼容新旧接入方。
export function sanitizeModelConfig(config) {
  const c = config || {};
  const source = c.modelSource || c.source || "agent";
  return {
    source,
    modelSource: source,
    agentFollow: c.agentFollow || "",
    hanaModel: {
      providerId: c.hanaModel?.providerId || "",
      modelId: c.hanaModel?.modelId || "",
    },
    customModel: {
      baseUrl: c.customModel?.baseUrl || "",
      apiKeyMask: maskKey(c.customModel?.apiKey || ""),
      storageMode: getStorageMode(c.customModel?.apiKey || ""),
      model: c.customModel?.model || "",
      api: c.customModel?.api || "openai-completions",
    },
  };
}

// 校验配置是否可调用
export function validateModelConfig(config) {
  const c = config || {};
  const source = c.modelSource || c.source || "agent";
  if (source === "hana") {
    if (!c.hanaModel?.providerId || !c.hanaModel?.modelId) {
      return { ok: false, error: "请选择供应商和模型。" };
    }
    return { ok: true };
  }
  if (source === "custom") {
    if (!c.customModel?.baseUrl || !c.customModel?.apiKey || !c.customModel?.model) {
      return { ok: false, error: "自定义模型需要填写完整的地址、Key 和模型名。" };
    }
    if (!/^https?:\/\//i.test(String(c.customModel.baseUrl))) {
      return { ok: false, error: "API 地址需要以 http:// 或 https:// 开头。" };
    }
    return { ok: true };
  }
  // agent 档永远可用（跟随助手，Hana 兜底）
  return { ok: true };
}

// 归一化 api 档位（兼容 "openai" / "openai-completions" / "chat" 等旧写法）
export function normalizeApi(api) {
  const a = String(api || "openai-completions").toLowerCase();
  if (a.includes("responses")) return "openai-responses";
  if (a.includes("anthropic") || a.includes("claude")) return "anthropic-messages";
  return "openai-completions";
}
