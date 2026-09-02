// feedback · core/client.js — Feedback 主类
// 专职反馈小助手：多轮聊天收集问题 → 自动带环境信息 → 达成共识输出 <issue> → 预填页收尾
//
// 模型调用（插槽）：
//   默认走 Hana utility:call-text（跟随助手当前模型），任何插件直接能用
//   插件引了 model-config 时可 setModelProvider(fn) 注入（fn 接收 messages 数组，返回文本或 { text } 对象）
// 渠道（插槽）：
//   本期默认 GitHub 预填页（repo 由接入方配置）；预留其他渠道位
//
// 路由挂载（2 行，真实写法见 index.js 注释）：
//   app.post("/api/feedback/chat", async (c) => c.json(await fb.handleChat(await c.req.json().catch(() => ({})))));
//   app.post("/api/feedback/chat/close", async (c) => c.json(await fb.handleClose(await c.req.json().catch(() => ({})))));

// 注意：本文件的 extractText 与 model-config 积木的 extractModelText 是同一逻辑的两份拷贝
//       （零依赖的代价），改动需两边同步。

import { ChatSession } from "./session.js";
import { collectEnv, renderEnvText } from "./env.js";
import { buildSystemPrompt } from "./prompt.js";
import { parseIssue, stripIssueTag, buildPrefillUrl } from "./issue.js";

const MAX_MESSAGE_CHARS = 4000;

export function extractText(result) {
  if (typeof result === "string") return result;
  const value = result?.text ?? result?.content ?? result?.output ?? "";
  if (Array.isArray(value)) {
    return value.map((part) => (typeof part === "string" ? part : part?.text || part?.content || "")).join("");
  }
  return String(value || "");
}

export class Feedback {
  constructor({ ctx, config = {} }) {
    if (!ctx) throw new Error("feedback: ctx 必填");
    this.ctx = ctx;
    this.pluginName = config.pluginName || "";
    this.manifestPath = config.manifestPath || null;
    this.repo = config.repo || "";
    this.hanaVersion = config.hanaVersion || "";
    this.modelConfigInfo = config.modelConfigInfo || null;
    this.sessions = new ChatSession();
    this.modelProvider = null;
  }

  // 插槽：注入模型调用函数（如 model-config 的 sample 包装）
  // 函数签名：(messages) => string | Promise<string> 或 { text } 对象（会自动提取文本）
  setModelProvider(fn) {
    this.modelProvider = typeof fn === "function" ? fn : null;
  }

  // 数据插槽（注意与函数插槽区别）：注入脱敏模型档位，env 里会带上档位描述（不含 Key）
  // 引了 model-config 的插件：fb.setModelConfigInfo(mc.sanitize())
  // ⚠️ 模型配置每次变化后都要重新调用，否则 env 里带的是旧档位（建议在保存配置的 handler 里同步刷新）
  setModelConfigInfo(info) {
    this.modelConfigInfo = info || null;
  }

  getEnv() {
    return collectEnv({
      manifestPath: this.manifestPath,
      pluginName: this.pluginName,
      hanaVersion: this.hanaVersion,
      modelConfigInfo: this.modelConfigInfo,
    });
  }

  _callModel(messages) {
    if (this.modelProvider) {
      // 注入的 provider 可能返回字符串也可能返回 { text } 对象，统一走 extractText
      return Promise.resolve(this.modelProvider(messages)).then(extractText);
    }
    const result = this.ctx.bus.request("utility:call-text", {
      messages,
      temperature: 0.7,
      maxTokens: 800,
      operation: "feedback-agent",
    }, { timeoutMs: 30000 });
    return Promise.resolve(result).then(extractText);
  }

  // 一轮对话：message 用户大白话；session_id 续会话
  async chat({ message, session_id } = {}) {
    const text = String(message || "").trim();
    if (!text) return { ok: false, error: "说点什么吧" };
    if (text.length > MAX_MESSAGE_CHARS) return { ok: false, error: `反馈内容不要超过 ${MAX_MESSAGE_CHARS} 字` };

    const env = this.getEnv();
    const envText = renderEnvText(env);
    const systemPrompt = buildSystemPrompt({ pluginName: env.pluginName || this.pluginName || "这个插件", envText });

    const sid = this.sessions.push(session_id, "user", text);
    const history = this.sessions.history(sid);
    const messages = [{ role: "system", content: systemPrompt }, ...history];

    let rawReply;
    try {
      rawReply = await this._callModel(messages);
    } catch (e) {
      this.ctx?.log?.warn?.("[feedback] 模型调用失败:", e.message);
      return { ok: false, session_id: sid, error: `模型调用失败：${e.message || "未知错误"}` };
    }

    this.sessions.push(sid, "assistant", rawReply);
    const issue = parseIssue(rawReply);
    const reply = stripIssueTag(rawReply);
    const prefillUrl = this.repo ? buildPrefillUrl({ repo: this.repo, issue, envText }) : "";

    return { ok: true, session_id: sid, reply, issue, env, prefillUrl };
  }

  handleChat = async (body) => {
    try {
      return await this.chat(body || {});
    } catch (e) {
      this.ctx?.log?.error?.("[feedback] chat error:", e.message);
      return { ok: false, error: e.message || "未知错误" };
    }
  };

  handleClose = async (body) => {
    const sid = body?.session_id;
    if (sid) this.sessions.close(sid);
    return { ok: true };
  };
}
