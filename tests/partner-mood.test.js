// 拾光记 · 伙伴心情线测试
// 覆盖：际遇信号预筛（praise/rebuke/self 三类命中与不命中、其他伙伴不掺和）、
// 门控、该伙伴消息流过滤、候选解析复用（围栏、情绪词归一、双方原文证据校验、坏输出容错）、
// 数据层（独立加密存储、日级幂等状态、设置开关默认关）。

import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { UserData } from "../lib/data.js";
import {
  findPartnerFortuneSignals,
  hasPartnerFortuneSignal,
  filterPartnerRows,
  parsePartnerMoodOutput,
} from "../lib/partner-mood.js";

const mk = (ts, role, agentId, text) => ({ ts, role, agentId, text });

test("际遇预筛：用户夸伙伴（praise）命中 user 消息", () => {
  const rows = [
    mk(1000, "user", "hanako", "小花你真棒，这个方案我超满意！"),
    mk(2000, "assistant", "hanako", "嘿嘿谢谢，那我再改一版给你看。"),
  ];
  const signals = findPartnerFortuneSignals(rows, "hanako");
  assert.ok(signals.length >= 1);
  assert.ok(signals.every((s) => s.kind === "praise"), "只有 praise 类信号");
  assert.equal(signals[0].text.includes("你真棒"), true);
});

test("际遇预筛：指向伙伴的负面（rebuke）命中", () => {
  const rows = [mk(1000, "user", "hanako", "你怎么又搞错了，真让人失望")];
  const signals = findPartnerFortuneSignals(rows, "hanako");
  assert.ok(signals.length === 1);
  assert.equal(signals[0].kind, "rebuke");
});

test("际遇预筛：伙伴显式表达（self）认「我」主语的感受", () => {
  const rows = [
    mk(1000, "assistant", "hanako", "我有点担心你最近睡太晚了"),
    mk(2000, "assistant", "hanako", "你别担心，这事我来处理"),
    mk(3000, "assistant", "hanako", "哈哈哈哈哈"),
  ];
  const signals = findPartnerFortuneSignals(rows, "hanako");
  assert.equal(signals.length, 1, "只命中「我有点担心」，镜映安慰与拟声不认");
  assert.equal(signals[0].kind, "self");
});

test("际遇预筛：其他伙伴的消息不掺和进目标伙伴的际遇", () => {
  const rows = [
    mk(1000, "user", "other", "你太厉害了"),
    mk(2000, "assistant", "other", "我挺开心的"),
    mk(3000, "user", "hanako", "小花靠谱！"),
  ];
  const forHanako = findPartnerFortuneSignals(rows, "hanako");
  assert.ok(forHanako.length === 1 && forHanako[0].kind === "praise");
  assert.equal(hasPartnerFortuneSignal(rows, "other"), true, "其他伙伴自己的线也该有信号");
  assert.equal(hasPartnerFortuneSignal(rows, "absent"), false, "没出现的伙伴无信号");
});

test("际遇预筛：空输入/无 agentId 返回空", () => {
  assert.deepEqual(findPartnerFortuneSignals([], "hanako"), []);
  assert.deepEqual(findPartnerFortuneSignals([mk(1, "user", "hanako", "你真棒")], ""), []);
});

test("消息流过滤：只收目标伙伴会话的 user+assistant，按时间排序", () => {
  const rows = [
    mk(3000, "assistant", "hanako", "好的"),
    mk(1000, "user", "hanako", "早呀小花"),
    mk(2000, "user", "other", "聊了些别的事"),
    mk(1500, "assistant", "other", "别的伙伴发言"),
  ];
  const flow = filterPartnerRows(rows, "hanako");
  assert.equal(flow.length, 2);
  assert.ok(flow.every((r) => r.agentId === "hanako"));
  assert.ok(flow[0].ts < flow[1].ts, "按时间排好序");
});

test("伙伴候选解析：围栏 JSON、情绪词归一、证据要能在双方原文里找到", () => {
  const raw = '```json\n[{"mood":"开心","segment":"上午","observedAt":"2026-09-08 09:12","certainty":"clear","evidence":"你那个方案真漂亮","why":"早上被夸方案漂亮"}]\n```';
  const source = "09:10 我：你那个方案真漂亮，夸夸。\n09:12 小花：嘿嘿谢谢！";
  const parsed = parsePartnerMoodOutput(raw, {
    day: "2026-09-08",
    allowedObservedAt: [new Date("2026-09-08T09:12:00").getTime()],
    evidenceSourceText: source,
  });
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].mood, "happy");
  assert.equal(parsed[0].label, "开心");
  assert.equal(parsed[0].evidence, "你那个方案真漂亮", "证据从用户的话里摘出来也算数");
  assert.equal(parsed[0].timePrecision, "turn", "时间与真实消息分钟对应上才落精确时刻");
});

test("伙伴候选解析：证据在原文里找不到就清空，绝不硬安", () => {
  const raw = '[{"mood":"难过","segment":"afternoon","evidence":"这句根本不在对话里","why":"乱猜的"}]';
  const parsed = parsePartnerMoodOutput(raw, {
    day: "2026-09-08",
    allowedObservedAt: [],
    evidenceSourceText: "下午聊的都是别的。",
  });
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].evidence, "", "找不到原文证据就留空");
});

test("伙伴候选解析：坏输出、空输出容错返回空数组", () => {
  assert.deepEqual(parsePartnerMoodOutput("", {}), []);
  assert.deepEqual(parsePartnerMoodOutput("不是 JSON 的废话", {}), []);
  assert.deepEqual(parsePartnerMoodOutput('[{"mood":"不存在的心情词"}]', {}, []), [], "情绪词不在集合里就丢弃");
});

// ── 数据层：伙伴心情线独立加密存储 ──

function tmpDir(name) {
  const d = path.join(os.tmpdir(), `sgj-test-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

const entry = (mood, segment = "morning", extra = {}) => ({
  id: `mood-auto-${Math.random().toString(36).slice(2, 10)}`,
  mood,
  label: mood === "happy" ? "开心" : "难过",
  emoji: mood === "happy" ? "😊" : "😢",
  source: "auto",
  segment,
  note: "",
  recordedAt: "2026-09-08T02:00:00.000Z",
  ...extra,
});

test("伙伴情绪存储：按 date|agentId 读写，与用户 moods 互不污染", async () => {
  const ud = new UserData(tmpDir("partner-moods"));
  await ud.replacePartnerDayMoods("2026-09-08", "hanako", [entry("happy")]);
  await ud.replacePartnerDayMoods("2026-09-08", "other", [entry("sad")]);
  assert.equal(ud.getPartnerMoods("2026-09-08", "hanako").length, 1);
  assert.equal(ud.getPartnerMoods("2026-09-08", "other").length, 1);
  const byAgent = ud.getPartnerDayMoods("2026-09-08");
  assert.deepEqual(Object.keys(byAgent).sort(), ["hanako", "other"]);
  const all = ud.listPartnerMoods("2026-09-08");
  assert.equal(all.length, 2);
  assert.ok(all.every((r) => r.date === "2026-09-08" && r.agentId));
  // 用户情绪表保持干净
  assert.equal(ud.getDayMoods("2026-09-08").length, 0);
});

test("伙伴情绪存储：整组替换覆盖、空数组清空、重启后可读", async () => {
  const d = tmpDir("partner-moods-restart");
  const ud = new UserData(d);
  await ud.replacePartnerDayMoods("2026-09-08", "hanako", [entry("happy")]);
  await ud.replacePartnerDayMoods("2026-09-08", "hanako", []);
  assert.equal(ud.getPartnerMoods("2026-09-08", "hanako").length, 0, "空数组清空那天");
  await ud.replacePartnerDayMoods("2026-09-08", "hanako", [entry("moved")]);
  const restored = new UserData(d);
  assert.equal(restored.getPartnerMoods("2026-09-08", "hanako")[0].mood, "moved", "重新实例化仍能解密读出");
});

test("伙伴链日级状态：幂等存取、重启保留、日期/伙伴校验", async () => {
  const d = tmpDir("partner-mood-harvest");
  const ud = new UserData(d);
  assert.equal(ud.getPartnerMoodHarvestState("2026-09-08", "hanako"), null);
  await ud.updatePartnerMoodHarvestState("2026-09-08", "hanako", { status: "completed" });
  assert.equal(ud.getPartnerMoodHarvestState("2026-09-08", "hanako").status, "completed");
  const restored = new UserData(d);
  assert.equal(restored.getPartnerMoodHarvestState("2026-09-08", "hanako").status, "completed", "重启后仍幂等");
  assert.equal(restored.getPartnerMoodHarvestState("2026-09-08", "other"), null, "不同伙伴各自独立");
  await assert.rejects(() => ud.updatePartnerMoodHarvestState("不是日期", "hanako", {}));
  await assert.rejects(() => ud.updatePartnerMoodHarvestState("2026-09-08", "", {}));
});

test("设置：伙伴心情线默认关，可开启，重启保留", async () => {
  const d = tmpDir("partner-mood-settings");
  const ud = new UserData(d);
  assert.equal(ud.getSettings().partnerMoodEnabled, false, "旧配置没有该键时默认关");
  await ud.updateSettings({ partnerMoodEnabled: true });
  assert.equal(ud.getSettings().partnerMoodEnabled, true);
  const restored = new UserData(d);
  assert.equal(restored.getSettings().partnerMoodEnabled, true);
});

test("路由：伙伴心情线开关通过设置接口回显", () => {
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "sgj-partner-mood-settings-route-"));
  const routeUrl = pathToFileURL(path.resolve("routes/ui.js")).href;
  const childCode = `
    import path from "node:path";
    import registerRoutes from ${JSON.stringify(routeUrl)};
    const dataDir = path.join(process.env.HANA_HOME, "plugin-data", "shiguangji");
    const routes = [];
    const app = {
      get(path, handler) { routes.push({ method: "GET", path, handler }); },
      post(path, handler) { routes.push({ method: "POST", path, handler }); },
      put() {},
      delete() {},
    };
    registerRoutes(app, { dataDir, log: { info() {}, warn() {}, error() {} } });
    const get = routes.find((item) => item.method === "GET" && item.path === "/api/settings");
    const post = routes.find((item) => item.method === "POST" && item.path === "/api/settings");
    const request = (body) => ({ req: { async json() { return body; } }, json(value) { return value; } });
    const saved = await post.handler(request({ partnerMoodEnabled: true }));
    const loaded = await get.handler({ json(value) { return value; } });
    if (!saved.ok || saved.settings.partnerMoodEnabled !== true) throw new Error("保存响应没有回显伙伴心情线开关：" + JSON.stringify(saved));
    if (!loaded.ok || loaded.settings.partnerMoodEnabled !== true) throw new Error("重新读取没有回显伙伴心情线开关：" + JSON.stringify(loaded));
    console.log(JSON.stringify({ saved: saved.settings.partnerMoodEnabled, loaded: loaded.settings.partnerMoodEnabled }));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", childCode], {
    encoding: "utf8",
    cwd: path.resolve("."),
    env: { ...process.env, USERPROFILE: isolatedHome, HOME: isolatedHome, HANA_HOME: path.join(isolatedHome, ".hanako") },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /"saved":true/);
  assert.match(result.stdout, /"loaded":true/);
});

// ── 页面与路由 ──

test("页面：模板包含伙伴心情线开关、图例与伙伴点渲染逻辑", async () => {
  const { renderPage } = await import(pathToFileURL(path.resolve("lib/page-template.js")).href);
  const html = renderPage("test-token");
  assert.match(html, /伙伴心情线/, "设置页应有伙伴心情线开关");
  assert.match(html, /partner-mood-seg/, "开关控件 id 存在");
  assert.match(html, /际遇心情线/, "开关旁应有一句话解释它记什么");
  assert.match(html, /api\/partner-moods/, "页面应能拉伙伴心情数据");
  assert.match(html, /buildPartnerSeriesFromDay/, "某天伙伴数据应能转成前端系列");
  assert.match(html, /partnerMoodPointTitle/, "伙伴点提示应带名字与际遇短注");
  assert.match(html, /moodline-path partner/, "伙伴线应叠在用户线上方");
  assert.match(html, /的际遇/, "图例与条目应标明这是伙伴的际遇");
  const scriptMatch = html.match(/<script>\n([\s\S]*?)\n<\/script>/);
  if (scriptMatch) {
    assert.doesNotThrow(() => new Function(scriptMatch[1]), "页面脚本语法应合法");
  }
});

test("路由：日终翻篇后伙伴际遇候选落库（端到端）", () => {
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "sgj-partner-mood-route-"));
  const routeUrl = pathToFileURL(path.resolve("routes/ui.js")).href;
  const dataUrl = pathToFileURL(path.resolve("lib/data.js")).href;
  const childCode = `
    import fs from "node:fs";
    import path from "node:path";
    import os from "node:os";
    import { UserData } from ${JSON.stringify(dataUrl)};
    import registerRoutes from ${JSON.stringify(routeUrl)};
    const home = path.join(os.homedir(), ".hanako");
    const agents = path.join(home, "agents", "hanako");
    const sessions = path.join(agents, "sessions");
    const dataDir = path.join(home, "plugin-data", "shiguangji");
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(path.join(home, "users.json"), JSON.stringify({ displayName: "小测试" }));
    fs.writeFileSync(path.join(agents, "config.yaml"), "agent:\\n  name: 小花\\n");
    fs.writeFileSync(path.join(sessions, "one.jsonl"),
      JSON.stringify({ type: "message", timestamp: "2026-09-05T10:00:00+08:00", message: { role: "user", content: "小花你真棒，这个方案我超满意" } }) + "\\n" +
      JSON.stringify({ type: "message", timestamp: "2026-09-05T10:01:00+08:00", message: { role: "assistant", content: "嘿嘿谢谢，那我再改一版给你看" } }) + "\\n");
    const data = new UserData(dataDir);
    await data.updateSettings({ autoSummary: false, moodDiscoveryMode: "economical", partnerMoodEnabled: true });
    const calls = [];
    let partnerAttempts = 0;
    const ctx = {
      dataDir,
      bus: { async request(topic, input) {
        calls.push({ topic, input });
        if (input.callPurpose === "partner-mood-discovery") {
          partnerAttempts += 1;
          if (partnerAttempts === 1) return { text: "" };
          return { text: JSON.stringify([{ mood: "开心", segment: "上午", observedAt: "2026-09-05 10:00", certainty: "clear", evidenceType: "explicit", evidence: "小花你真棒，这个方案我超满意", why: "早上被夸方案漂亮" }]) };
        }
        return { text: "小测试今天和小花聊了几句" };
      } },
      log: { info() {}, warn() {}, error() {} },
    };
    const routes = [];
    const app = {
      get(p, h) { routes.push({ method: "GET", path: p, handler: h }); },
      post(p, h) { routes.push({ method: "POST", path: p, handler: h }); },
      put(p, h) { routes.push({ method: "PUT", path: p, handler: h }); },
      delete(p, h) { routes.push({ method: "DELETE", path: p, handler: h }); },
    };
    registerRoutes(app, ctx);
    if (!routes.some((r) => r.method === "GET" && r.path === "/api/partner-moods")) throw new Error("月视图路由未注册");
    if (!routes.some((r) => r.method === "GET" && r.path === "/api/partner-moods/:date")) throw new Error("日视图路由未注册");
    const run = routes.find((item) => item.method === "POST" && item.path === "/api/summaries/run");
    const result = await run.handler({ req: { async json() { return { date: "2026-09-05" }; } }, json(value) { return value; } });
    const moods = new UserData(dataDir).getPartnerMoods("2026-09-05", "hanako");
    const state = new UserData(dataDir).getPartnerMoodHarvestState("2026-09-05", "hanako");
    if (moods.length !== 1 || moods[0].mood !== "happy") throw new Error("际遇候选没有落库：" + JSON.stringify(moods));
    if (moods[0].evidence !== "小花你真棒，这个方案我超满意") throw new Error("证据没有从原文保真：" + JSON.stringify(moods[0]));
    if (moods[0].timePrecision !== "turn") throw new Error("时间没落到真实消息分钟：" + JSON.stringify(moods[0]));
    if (!state || state.status !== "completed") throw new Error("状态没有记成完成：" + JSON.stringify(state));
    const partnerCall = calls.filter((call) => call.input.callPurpose === "partner-mood-discovery").length;
    if (partnerCall !== 2) throw new Error("伙伴链空正文没有走同模型重试：" + partnerCall);
    console.log(JSON.stringify({ partnerCalls: partnerCall, mood: moods[0].label, evidence: moods[0].evidence }));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", childCode], {
    encoding: "utf8",
    cwd: path.resolve("."),
    env: { ...process.env, USERPROFILE: isolatedHome, HOME: isolatedHome, HANA_HOME: path.join(isolatedHome, ".hanako") },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /"partnerCalls":2/);
  assert.match(result.stdout, /"mood":"开心"/);
});

test("路由：Hana 档伙伴心情线空正文走同模型重试并落库", () => {
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "sgj-partner-mood-hana-route-"));
  const routeUrl = pathToFileURL(path.resolve("routes/ui.js")).href;
  const dataUrl = pathToFileURL(path.resolve("lib/data.js")).href;
  const childCode = `
    import fs from "node:fs";
    import path from "node:path";
    import os from "node:os";
    import { UserData } from ${JSON.stringify(dataUrl)};
    import registerRoutes from ${JSON.stringify(routeUrl)};
    const home = path.join(os.homedir(), ".hanako");
    const agents = path.join(home, "agents", "hanako");
    const sessions = path.join(agents, "sessions");
    const dataDir = path.join(home, "plugin-data", "shiguangji");
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(path.join(home, "users.json"), JSON.stringify({ displayName: "小测试" }));
    fs.writeFileSync(path.join(home, "models.json"), JSON.stringify({ providers: {
      "command code": { baseUrl: "https://api.commandcode.ai/provider/v1", api: "openai-completions", models: [{ id: "deepseek/deepseek-v4-flash", input: ["text"], reasoning: true }] },
    } }));
    fs.writeFileSync(path.join(agents, "config.yaml"), "agent:\\n  name: 小花\\n");
    fs.writeFileSync(path.join(sessions, "one.jsonl"),
      JSON.stringify({ type: "message", timestamp: "2026-09-05T10:00:00+08:00", message: { role: "user", content: "小花你真棒，这个方案我超满意" } }) + "\\n" +
      JSON.stringify({ type: "message", timestamp: "2026-09-05T10:01:00+08:00", message: { role: "assistant", content: "嘿嘿谢谢，那我再改一版给你看" } }) + "\\n");
    const data = new UserData(dataDir);
    await data.updateSettings({ autoSummary: false, moodDiscoveryMode: "economical", partnerMoodEnabled: true, modelSource: "hana", hanaModel: { providerId: "command code", modelId: "deepseek/deepseek-v4-flash" } });
    const networkCalls = [];
    const busCalls = [];
    let partnerAttempts = 0;
    const ctx = {
      dataDir,
      bus: { async request(topic, input) {
        busCalls.push({ topic, input });
        if (topic === "provider:credentials") return { apiKey: "runtime-key", baseUrl: "https://api.commandcode.ai/provider/v1", api: "openai-completions" };
        throw new Error("不应请求工具模型总线");
      } },
      network: { async fetch(url, init) {
        const body = JSON.parse(init.body);
        networkCalls.push({ url, body });
        const prompt = String(body.messages?.[0]?.content || "");
        if (prompt.includes("伙伴：")) {
          partnerAttempts += 1;
          if (partnerAttempts === 1) {
            return { ok: true, status: 200, async text() { return JSON.stringify({ choices: [{ message: { reasoning_content: "只返回了思考", content: "" } }], finish_reason: "length" }); } };
          }
          return { ok: true, status: 200, async text() { return JSON.stringify({ choices: [{ message: { content: JSON.stringify([{ mood: "开心", segment: "上午", observedAt: "2026-09-05 10:00", certainty: "clear", evidenceType: "explicit", evidence: "小花你真棒，这个方案我超满意", why: "早上被夸方案漂亮" }]) } }] }); } };
        }
        if (prompt.includes("自动发现候选")) {
          return { ok: true, status: 200, async text() { return JSON.stringify({ choices: [{ message: { content: "[]" } }] }); } };
        }
        return { ok: true, status: 200, async text() { return JSON.stringify({ choices: [{ message: { content: "摘要：正常生成" } }] }); } };
      } },
      log: { info() {}, warn() {}, error() {} },
    };
    const routes = [];
    const app = {
      get(p, h) { routes.push({ method: "GET", path: p, handler: h }); },
      post(p, h) { routes.push({ method: "POST", path: p, handler: h }); },
      put(p, h) { routes.push({ method: "PUT", path: p, handler: h }); },
      delete(p, h) { routes.push({ method: "DELETE", path: p, handler: h }); },
    };
    registerRoutes(app, ctx);
    const run = routes.find((item) => item.method === "POST" && item.path === "/api/summaries/run");
    const result = await run.handler({ req: { async json() { return { date: "2026-09-05" }; } }, json(value) { return value; } });
    const moods = new UserData(dataDir).getPartnerMoods("2026-09-05", "hanako");
    const state = new UserData(dataDir).getPartnerMoodHarvestState("2026-09-05", "hanako");
    if (!result.ok || moods.length !== 1 || moods[0].mood !== "happy") throw new Error("Hana 档伙伴候选没有落库：" + JSON.stringify({ result, moods }));
    if (!state || state.status !== "completed") throw new Error("Hana 档伙伴状态没有完成：" + JSON.stringify(state));
    if (partnerAttempts !== 2) throw new Error("Hana 档空正文没有走同模型重试：" + partnerAttempts);
    if (busCalls.some((call) => call.topic === "utility:call-text")) throw new Error("Hana 档错误请求了工具模型：" + JSON.stringify(busCalls));
    const partnerBodies = networkCalls.filter((call) => String(call.body.messages?.[0]?.content || "").includes("伙伴："));
    if (partnerBodies.length !== 2 || partnerBodies[0].body?.thinking?.type !== "disabled" || partnerBodies[1].body?.max_tokens !== 8000) {
      throw new Error("Hana 档重试参数不对：" + JSON.stringify(partnerBodies));
    }
    console.log(JSON.stringify({ partnerAttempts, partnerRequests: partnerBodies.length, model: partnerBodies[0].body.model, retryTokens: partnerBodies[1].body.max_tokens }));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", childCode], {
    encoding: "utf8",
    cwd: path.resolve("."),
    env: { ...process.env, USERPROFILE: isolatedHome, HOME: isolatedHome, HANA_HOME: path.join(isolatedHome, ".hanako") },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /"partnerAttempts":2/);
  assert.match(result.stdout, /"retryTokens":8000/);
});

test("路由：做册全不选或开关关着时伙伴链不跑", () => {
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "sgj-partner-mood-off-"));
  const routeUrl = pathToFileURL(path.resolve("routes/ui.js")).href;
  const dataUrl = pathToFileURL(path.resolve("lib/data.js")).href;
  const childCode = `
    import fs from "node:fs";
    import path from "node:path";
    import os from "node:os";
    import { UserData } from ${JSON.stringify(dataUrl)};
    import registerRoutes from ${JSON.stringify(routeUrl)};
    const home = path.join(os.homedir(), ".hanako");
    const agents = path.join(home, "agents", "hanako");
    const sessions = path.join(agents, "sessions");
    const dataDir = path.join(home, "plugin-data", "shiguangji");
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(path.join(home, "users.json"), JSON.stringify({ displayName: "小测试" }));
    fs.writeFileSync(path.join(agents, "config.yaml"), "agent:\\n  name: 小花\\n");
    fs.writeFileSync(path.join(sessions, "one.jsonl"),
      JSON.stringify({ type: "message", timestamp: "2026-09-05T10:00:00+08:00", message: { role: "user", content: "小花你真棒" } }) + "\\n");
    const data = new UserData(dataDir);
    // 开关关着（默认），即使做册全选也不该调伙伴链模型
    await data.updateSettings({ autoSummary: false, moodDiscoveryMode: "economical", partnerMoodEnabled: false });
    const calls = [];
    const ctx = {
      dataDir,
      bus: { async request(topic, input) {
        calls.push({ topic, input });
        return { text: "" };
      } },
      log: { info() {}, warn() {}, error() {} },
    };
    const routes = [];
    const app = {
      get(p, h) { routes.push({ method: "GET", path: p, handler: h }); },
      post(p, h) { routes.push({ method: "POST", path: p, handler: h }); },
      put(p, h) { routes.push({ method: "PUT", path: p, handler: h }); },
      delete(p, h) { routes.push({ method: "DELETE", path: p, handler: h }); },
    };
    registerRoutes(app, ctx);
    const run = routes.find((item) => item.method === "POST" && item.path === "/api/summaries/run");
    const result = await run.handler({ req: { async json() { return { date: "2026-09-05" }; } }, json(value) { return value; } });
    const state = new UserData(dataDir).getPartnerMoodHarvestState("2026-09-05", "hanako");
    if (state) throw new Error("开关关着不该产生伙伴链状态：" + JSON.stringify(state));
    console.log(JSON.stringify({ partnerCalls: calls.filter((call) => call.input.callPurpose === "partner-mood-discovery").length }));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", childCode], {
    encoding: "utf8",
    cwd: path.resolve("."),
    env: { ...process.env, USERPROFILE: isolatedHome, HOME: isolatedHome, HANA_HOME: path.join(isolatedHome, ".hanako") },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /"partnerCalls":0/);
});

// ── 补档任务 ──

test("补档任务账本：创建/读取/更新/活跃互斥/重启保留", async () => {
  const d = tmpDir("partner-mood-jobs");
  const ud = new UserData(d);
  const job = await ud.createPartnerMoodJob({ dates: ["2026-09-01", "2026-09-02"] });
  assert.equal(job.status, "queued");
  // 活跃任务存在时不允许再建
  await assert.rejects(() => ud.createPartnerMoodJob({ dates: ["2026-09-03"] }), /已经有一项伙伴心情补档/);
  await ud.updatePartnerMoodJob(job.id, { status: "completed", outcomes: [{ date: "2026-09-01", status: "completed" }] });
  // 完成后可以再建
  const job2 = await ud.createPartnerMoodJob({ dates: ["2026-09-03"] });
  assert.ok(job2.id !== job.id);
  const restored = new UserData(d);
  assert.equal(restored.getPartnerMoodJob(job.id).status, "completed", "重启保留");
  assert.equal(restored.listPartnerMoodJobs()[0].id, job2.id, "最新在前");
  await ud.updatePartnerMoodJob(job2.id, { status: "completed" });
  assert.equal(ud.listPartnerMoodJobs(true).length, 0, "无活跃任务时 activeOnly 为空");
});

test("页面：批量多选区包含补记伙伴心情入口与进度容器", async () => {
  const { renderPage } = await import(pathToFileURL(path.resolve("lib/page-template.js")).href);
  const html = renderPage("test-token");
  assert.match(html, /partner-mood-backfill-btn/, "补记伙伴心情按钮存在");
  assert.match(html, /runPartnerMoodBackfill/, "按钮绑定补档投递");
  assert.match(html, /partner-mood-jobs-calendar/, "补档进度容器存在");
  assert.match(html, /loadPartnerMoodJobs/, "页面会轮询补档进度");
  assert.match(html, /只收情绪，不会改动已定稿的总结页/, "按钮提示讲清不碰总结");
});

test("路由：历史批量补档端到端（force 宽松，不碰总结）", () => {
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "sgj-partner-mood-backfill-"));
  const routeUrl = pathToFileURL(path.resolve("routes/ui.js")).href;
  const dataUrl = pathToFileURL(path.resolve("lib/data.js")).href;
  const childCode = `
    import fs from "node:fs";
    import path from "node:path";
    import os from "node:os";
    import { UserData } from ${JSON.stringify(dataUrl)};
    import registerRoutes from ${JSON.stringify(routeUrl)};
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const home = path.join(os.homedir(), ".hanako");
    const agents = path.join(home, "agents", "hanako");
    const sessions = path.join(agents, "sessions");
    const dataDir = path.join(home, "plugin-data", "shiguangji");
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(path.join(home, "users.json"), JSON.stringify({ displayName: "小测试" }));
    fs.writeFileSync(path.join(agents, "config.yaml"), "agent:\\n  name: 小花\\n");
    const write = (date, hour, text, role) => {
      fs.appendFileSync(path.join(sessions, "one.jsonl"),
        JSON.stringify({ type: "message", timestamp: date + "T" + hour + ":00+08:00", message: { role, content: text } }) + "\\n");
    };
    // 两个过去的生活日，各有一次被夸
    write("2026-09-01", "10:00", "小花你真棒，第一天搞定", "user");
    write("2026-09-01", "10:01", "嘿嘿谢谢", "assistant");
    write("2026-09-02", "15:00", "第二天也靠你啦，太靠谱了", "user");
    write("2026-09-02", "15:01", "交给我放心", "assistant");
    const data = new UserData(dataDir);
    // 先全关再注册，避免注册瞬间的首轮定时检查抢先跑
    await data.updateSettings({ autoSummary: false, moodDiscoveryMode: "off", partnerMoodEnabled: false });
    const calls = [];
    const ctx = {
      dataDir,
      bus: { async request(topic, input) {
        calls.push({ topic, input });
        if (input.callPurpose === "partner-mood-discovery") {
          return { text: JSON.stringify([{ mood: "开心", segment: "上午", certainty: "clear", evidenceType: "explicit", evidence: "你真棒", why: "早上被夸" }]) };
        }
        return { text: "" };
      } },
      log: { info() {}, warn() {}, error() {} },
    };
    const routes = [];
    const app = {
      get(p, h) { routes.push({ method: "GET", path: p, handler: h }); },
      post(p, h) { routes.push({ method: "POST", path: p, handler: h }); },
      put(p, h) { routes.push({ method: "PUT", path: p, handler: h }); },
      delete(p, h) { routes.push({ method: "DELETE", path: p, handler: h }); },
    };
    registerRoutes(app, ctx);
    // 设置更新必须走路由 handler（shared 实例有内存缓存，跨实例直接改文件读不到）
    const settingsPost = routes.find((item) => item.method === "POST" && item.path === "/api/settings");
    const settingsRes = await settingsPost.handler({ req: { async json() { return { moodDiscoveryMode: "economical", partnerMoodEnabled: true }; } }, json(value) { return value; } });
    if (!settingsRes.ok) throw new Error("设置没更新成功：" + JSON.stringify(settingsRes));
    const post = routes.find((item) => item.method === "POST" && item.path === "/api/partner-moods/backfill");
    if (!post) throw new Error("补档路由未注册");
    const created = await post.handler({ req: { async json() { return { dates: ["2026-09-01", "2026-09-02"] }; } }, json(value) { return value; } });
    if (!created.ok) throw new Error("补档任务创建失败：" + JSON.stringify(created));
    const jobId = created.job.id;
    let job = new UserData(dataDir).getPartnerMoodJob(jobId);
    for (let i = 0; i < 60 && job && ["queued", "running"].includes(job.status); i++) {
      await sleep(150);
      job = new UserData(dataDir).getPartnerMoodJob(jobId);
    }
    if (!job || job.status !== "completed") throw new Error("补档任务没跑完：" + JSON.stringify(job));
    const day1 = new UserData(dataDir).getPartnerMoods("2026-09-01", "hanako");
    const day2 = new UserData(dataDir).getPartnerMoods("2026-09-02", "hanako");
    if (day1.length !== 1 || day2.length !== 1) throw new Error("补档没有落库：" + JSON.stringify({ day1, day2, outcomes: job.outcomes }));
    if (day1[0].mood !== "happy" || day2[0].mood !== "happy") throw new Error("情绪词不对：" + JSON.stringify({ day1, day2 }));
    if (day1[0].evidence !== "你真棒") throw new Error("证据没保真：" + JSON.stringify(day1[0]));
    const partnerCalls = calls.filter((call) => call.input.callPurpose === "partner-mood-discovery");
    if (!partnerCalls.length || partnerCalls.some((call) => JSON.stringify(call.input).includes("undefined"))) {
      throw new Error("补档提示词缺少用户称呼或出现 undefined：" + JSON.stringify(partnerCalls));
    }
    // 已定稿的总结没被这次补档碰过
    const summaries = new UserData(dataDir).listSummaryEntries("2026-09-01");
    console.log(JSON.stringify({ partnerCalls: partnerCalls.length, jobStatus: job.status, summaryCount: summaries.length }));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", childCode], {
    encoding: "utf8",
    cwd: path.resolve("."),
    env: { ...process.env, USERPROFILE: isolatedHome, HOME: isolatedHome, HANA_HOME: path.join(isolatedHome, ".hanako") },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /"partnerCalls":2/);
  assert.match(result.stdout, /"jobStatus":"completed"/);
  assert.match(result.stdout, /"summaryCount":0/, "补档不碰总结");
});
