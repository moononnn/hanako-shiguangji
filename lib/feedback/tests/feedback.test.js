// feedback 测试 — node:test 零依赖
// 运行：node --test tests/feedback.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import {
  Feedback, collectEnv, renderEnvText, buildSystemPrompt,
  parseIssue, stripIssueTag, renderIssueText, buildPrefillUrl, sanitizeIssue,
  ChatSession,
} from "../index.js";

const MANIFEST = fileURLToPath(new URL("./fixtures/manifest.json", import.meta.url));

function makeCtx(overrides = {}) {
  return {
    bus: {
      request: async (topic, payload, opts) => ({ text: "ok" }),
    },
    log: { warn: () => {}, error: () => {}, info: () => {} },
    ...overrides,
  };
}

// ═══════ env 收集 ═══════

test("env：有 manifest 时拿到插件名和版本", () => {
  const env = collectEnv({ manifestPath: MANIFEST, hanaVersion: "v0.9.0" });
  assert.equal(env.pluginName, "demo-plugin");
  assert.equal(env.pluginVersion, "2.3.1");
  assert.equal(env.hanaVersion, "v0.9.0");
  assert.ok(env.os.length > 0);
});

test("env：无 manifest 也不抛错，版本写未知", () => {
  const env = collectEnv({});
  assert.equal(env.pluginVersion, "未知");
  assert.equal(env.hanaVersion, "未知");
});

test("env：manifest 损坏不抛错", () => {
  const env = collectEnv({ manifestPath: fileURLToPath(new URL("./fixtures/not-exist.json", import.meta.url)) });
  assert.equal(env.pluginVersion, "未知");
});

test("env：modelConfigInfo 渲染成档位文字（不含 Key）", () => {
  const env = collectEnv({
    manifestPath: MANIFEST,
    modelConfigInfo: { source: "custom", customModel: { api: "openai-completions" } },
  });
  assert.equal(env.modelSource, "自定义 API（completions）");
  const env2 = collectEnv({ modelConfigInfo: { source: "hana", hanaModel: { providerId: "p", modelId: "m" } } });
  assert.equal(env2.modelSource, "Hana 指定（p / m）");
  const env3 = collectEnv({ modelConfigInfo: { source: "agent" } });
  assert.equal(env3.modelSource, "跟随助手当前模型");
});

test("env：renderEnvText 包含关键信息", () => {
  const text = renderEnvText({ pluginName: "demo-plugin", pluginVersion: "2.3.1", hanaVersion: "v0.9.0", os: "win32 x64", modelSource: "跟随助手当前模型" });
  assert.match(text, /demo-plugin/);
  assert.match(text, /2\.3\.1/);
  assert.match(text, /v0\.9\.0/);
  assert.match(text, /跟随助手当前模型/);
});

// ═══════ prompt ═══════

test("prompt：插件名和环境信息正确注入", () => {
  const p = buildSystemPrompt({ pluginName: "小花插件", envText: "【环境信息】\n- 插件：demo" });
  assert.match(p, /小花插件/);
  assert.match(p, /【环境信息】/);
  assert.match(p, /<issue>/);
  assert.match(p, /达成共识/);
});

// ═══════ issue 解析 / 渲染 / 预填 ═══════

test("issue：合法 JSON 提取并收紧字段", () => {
  const raw = '好的，我理解了。\n<issue>\n{"title":"设置打不开","description":"点设置没反应","steps":["打开插件","点设置"],"expected":"打开设置页","actual":"没反应"}\n</issue>';
  const issue = parseIssue(raw);
  assert.ok(issue);
  assert.equal(issue.title, "设置打不开");
  assert.deepEqual(issue.steps, ["打开插件", "点设置"]);
});

test("issue：无标签时返回 null", () => {
  assert.equal(parseIssue("好的，请问什么时候发生的？"), null);
  assert.equal(parseIssue(""), null);
  assert.equal(parseIssue(null), null);
});

test("issue：JSON 解析失败返回 null，不抛错", () => {
  const raw = '<issue>{"title": 坏的 JSON</issue>';
  assert.equal(parseIssue(raw), null);
});

test("issue：字段缺省容错（steps 缺省变空数组、空对象返回 null）", () => {
  const issue = parseIssue('<issue>{"title":"x"}</issue>');
  assert.deepEqual(issue.steps, []);
  assert.equal(issue.description, "");
  assert.equal(parseIssue("<issue>{}</issue>"), null);
});

test("issue：取最后一个标签", () => {
  const raw = '<issue>{"title":"旧"}</issue> 再想想 <issue>{"title":"新","description":"d"}</issue>';
  const issue = parseIssue(raw);
  assert.equal(issue.title, "新");
});

test("issue：stripIssueTag 清理干净", () => {
  const cleaned = stripIssueTag('好的。<issue>{"title":"x"}</issue>');
  assert.equal(cleaned, "好的。");
});

test("issue：sanitizeIssue 类型收紧（title 超长截断、steps 过滤空）", () => {
  const issue = sanitizeIssue({ title: "t".repeat(200), steps: ["a", "", "  ", "b"], description: 123 });
  assert.equal(issue.title.length, 80);
  assert.deepEqual(issue.steps, ["a", "b"]);
  assert.equal(issue.description, "123");
});

test("issue：renderIssueText 渲染 Markdown", () => {
  const text = renderIssueText({ title: "t", description: "描述", steps: ["一", "二"], expected: "期望", actual: "实际" }, "【环境信息】\n- x");
  assert.match(text, /## 描述/);
  assert.match(text, /1\. 一/);
  assert.match(text, /## 期望行为/);
  assert.match(text, /## 环境信息/);
});

test("issue：buildPrefillUrl 拼装并正确 encode", () => {
  const url = buildPrefillUrl({ repo: "moononnn/demo", issue: { title: "设置 打不开", description: "点设置没反应" }, envText: "【环境信息】" });
  assert.match(url, /^https:\/\/github\.com\/moononnn\/demo\/issues\/new\?/);
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get("title"), "设置 打不开");
  assert.equal(parsed.searchParams.get("body"), "## 描述\n点设置没反应\n\n## 环境信息\n【环境信息】");
});

test("issue：buildPrefillUrl repo 非法返回空串", () => {
  assert.equal(buildPrefillUrl({ repo: "bad", issue: { title: "x" } }), "");
  assert.equal(buildPrefillUrl({ repo: "", issue: { title: "x" } }), "");
});

// ═══════ ChatSession ═══════

test("session：多轮历史、create/push/close", () => {
  const s = new ChatSession();
  const sid = s.create();
  s.push(sid, "user", "你好");
  s.push(sid, "assistant", "你好呀");
  assert.equal(s.history(sid).length, 2);
  assert.equal(s.history(sid)[0].content, "你好");
  s.close(sid);
  assert.equal(s.history(sid).length, 0);
});

test("session：push 时不存在自动创建", () => {
  const s = new ChatSession();
  const sid = s.push("not-exist", "user", "hi");
  assert.ok(sid);
  assert.equal(s.history(sid).length, 1);
});

test("session：TTL 过期后取不到", () => {
  const s = new ChatSession({ ttlMs: 1000 });
  const sid = s.create();
  s.map.get(sid).lastActive = Date.now() - 2000; // 手动把时间拨旧
  assert.equal(s.get(sid), null);
});

test("session：超过上限淘汰最旧", () => {
  const s = new ChatSession({ maxSessions: 2 });
  const a = s.create();
  const b = s.create();
  s.map.get(a).lastActive = Date.now() - 5000;
  const c = s.create();
  assert.equal(s.get(a), null);
  assert.ok(s.get(b));
  assert.ok(s.get(c));
});

test("session：历史超 60 条裁剪", () => {
  const s = new ChatSession();
  const sid = s.create();
  for (let i = 0; i < 70; i++) s.push(sid, "user", "m" + i);
  assert.equal(s.history(sid).length, 60);
});

// ═══════ Feedback 主类 ═══════

test("feedback：缺 ctx 抛错", () => {
  assert.throws(() => new Feedback({}));
});

test("feedback：chat 空消息返回友好错误", async () => {
  const fb = new Feedback({ ctx: makeCtx(), config: { manifestPath: MANIFEST, repo: "o/r" } });
  const r = await fb.chat({ message: "  " });
  assert.equal(r.ok, false);
  assert.match(r.error, /说点什么吧/);
});

test("feedback：单条消息超长时拒绝，不进入模型请求", async () => {
  let called = false;
  const fb = new Feedback({ ctx: makeCtx(), config: { repo: "o/r" } });
  fb.setModelProvider(async () => { called = true; return "不该调用"; });
  const r = await fb.chat({ message: "x".repeat(4001) });
  assert.equal(r.ok, false);
  assert.match(r.error, /4000/);
  assert.equal(called, false);
});

test("feedback：默认走 bus 调用模型，返回 reply + issue + prefillUrl", async () => {
  const calls = [];
  const ctx = makeCtx({
    bus: {
      request: async (topic, payload, opts) => {
        calls.push({ topic, payload });
        return { text: '明白，我确认一下。\n<issue>{"title":"设置打不开","description":"点设置没反应","steps":["打开插件"],"expected":"打开设置","actual":"没反应"}</issue>' };
      },
    },
  });
  const fb = new Feedback({ ctx, config: { manifestPath: MANIFEST, repo: "moononnn/demo", hanaVersion: "v0.9.0" } });
  const r = await fb.chat({ message: "设置打不开了" });
  assert.equal(r.ok, true);
  assert.ok(r.session_id);
  assert.equal(r.reply, "明白，我确认一下。");
  assert.equal(r.issue.title, "设置打不开");
  assert.match(r.prefillUrl, /issues\/new\?/);
  // 确认 system prompt 带上了插件名和环境信息
  const payload = calls[0].payload;
  const sys = payload.messages.find((m) => m.role === "system");
  assert.match(sys.content, /demo-plugin/);
  assert.match(sys.content, /2\.3\.1/);
  assert.match(sys.content, /v0\.9\.0/);
  assert.equal(payload.messages[payload.messages.length - 1].content, "设置打不开了");
});

test("feedback：注入模型 provider 后走注入函数（不再走 bus）", async () => {
  let busCalled = false;
  const ctx = makeCtx({ bus: { request: async () => { busCalled = true; return { text: "x" }; } } });
  const fb = new Feedback({ ctx, config: { manifestPath: MANIFEST, repo: "o/r" } });
  let gotMessages = null;
  fb.setModelProvider(async (messages) => {
    gotMessages = messages;
    return "没问题。";
  });
  const r = await fb.chat({ message: "想加个导出功能" });
  assert.equal(r.ok, true);
  assert.equal(r.reply, "没问题。");
  assert.equal(r.issue, null);
  assert.equal(busCalled, false);
  assert.ok(gotMessages.length >= 2); // system + user
});

test("feedback：注入 provider 返回 { text } 对象也能正确取文本（防 [object Object]）", async () => {
  const fb = new Feedback({ ctx: makeCtx(), config: { repo: "o/r" } });
  fb.setModelProvider(async () => ({ text: "好的，明白了。" }));
  const r = await fb.chat({ message: "hi" });
  assert.equal(r.ok, true);
  assert.equal(r.reply, "好的，明白了。");
  assert.ok(!r.reply.includes("[object Object]"));
});

test("feedback：多轮会话上下文累积", async () => {
  const replies = [
    "还有问题想确认。",
    '好，就这样。<issue>{"title":"t","description":"d"}</issue>',
  ];
  const fb = new Feedback({ ctx: makeCtx(), config: { repo: "o/r" } });
  fb.setModelProvider(async (messages) => {
    const lastUser = [...messages].reverse().find((m) => m.role === "user").content;
    return replies[lastUser === "第一次" ? 0 : 1];
  });
  const r1 = await fb.chat({ message: "第一次" });
  const r2 = await fb.chat({ message: "第二次", session_id: r1.session_id });
  assert.equal(r2.ok, true);
  assert.equal(r2.issue.title, "t");
});

test("feedback：模型调用失败返回友好错误，不抛", async () => {
  const fb = new Feedback({ ctx: makeCtx(), config: {} });
  fb.setModelProvider(async () => { throw new Error("timeout"); });
  const r = await fb.chat({ message: "hi" });
  assert.equal(r.ok, false);
  assert.match(r.error, /模型调用失败/);
});

test("feedback：chat 注入 modelConfigInfo 后 env 带档位", async () => {
  const ctx = makeCtx({
    bus: {
      request: async () => ({ text: "好的。" }),
    },
  });
  const fb = new Feedback({ ctx, config: { manifestPath: MANIFEST, repo: "o/r" } });
  fb.setModelConfigInfo({ source: "custom", customModel: { api: "anthropic-messages" } });
  const r = await fb.chat({ message: "hi" });
  assert.match(r.env.modelSource, /自定义 API/);
});

test("feedback：repo 未配置时 prefillUrl 为空串，不报错", async () => {
  const fb = new Feedback({ ctx: makeCtx(), config: {} });
  fb.setModelProvider(async () => 'ok。<issue>{"title":"t","description":"d"}</issue>');
  const r = await fb.chat({ message: "hi" });
  assert.equal(r.prefillUrl, "");
});

// ═══════ 路由 handler ═══════

test("handler：handleChat 包住异常返回 ok:false", async () => {
  const fb = new Feedback({ ctx: makeCtx(), config: {} });
  const r = await fb.handleChat({ message: "" });
  assert.equal(r.ok, false);
});

test("handler：handleClose 清理会话", async () => {
  const fb = new Feedback({ ctx: makeCtx(), config: {} });
  const r = await fb.chat({ message: "hi" });
  assert.equal(fb.sessions.get(r.session_id) !== null, true);
  const c = await fb.handleClose({ session_id: r.session_id });
  assert.equal(c.ok, true);
  assert.equal(fb.sessions.get(r.session_id), null);
});
