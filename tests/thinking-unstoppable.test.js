// 拾光记 · 「关不掉思考」的模型档：记住它、下次首轮直接给足、设置页告知用户
//
// 背景：部分中转/兼容端点忽略 thinking:{type:"disabled"}，模型照思考不误，小预算被思考吃光、
// 正文为空。首轮注定空跑，只能靠重试给足预算救回——所以观测到一次就记住这个档。

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { currentModelKey, isThinkingUnstoppable } from "../routes/ui.js";
import { ModelConfig } from "../lib/model-config/index.js";

// ── 档位键与判定（纯函数） ──

test("模型档键：Hana / 自定义档有键，跟随档没有（跟随档由宿主决定，不瞎记）", () => {
  assert.equal(
    currentModelKey({ modelSource: "hana", hanaModel: { providerId: "command code", modelId: "deepseek/deepseek-v4-flash" } }),
    "command code/deepseek/deepseek-v4-flash",
  );
  assert.equal(currentModelKey({ modelSource: "custom", customModel: { model: "gpt-4o" } }), "custom/gpt-4o");
  assert.equal(currentModelKey({ modelSource: "agent" }), "");
  assert.equal(currentModelKey({ modelSource: "hana" }), "");
  assert.equal(currentModelKey({ modelSource: "custom", customModel: {} }), "");
  assert.equal(currentModelKey(), "");
});

test("关不掉清单：按档命中，换档不误伤", () => {
  const settings = {
    modelSource: "hana",
    hanaModel: { providerId: "command code", modelId: "m" },
    thinkingUnstoppable: { "command code/m": { seenAt: "2026-09-10T00:00:00.000Z" } },
  };
  assert.equal(isThinkingUnstoppable(settings), true);
  assert.equal(isThinkingUnstoppable(settings, "command code/m"), true);
  assert.equal(isThinkingUnstoppable(settings, "minimax/MiniMax-M3"), false);
  // 换了档就不该再命中
  assert.equal(
    isThinkingUnstoppable({ modelSource: "hana", hanaModel: { providerId: "minimax", modelId: "MiniMax-M3" }, thinkingUnstoppable: settings.thinkingUnstoppable }),
    false,
  );
  assert.equal(isThinkingUnstoppable({}), false);
});

// ── 模型层诊断 ──

function makeCustomModel(respond) {
  return new ModelConfig({
    ctx: {
      network: {
        async fetch(url, init) {
          respond.lastBody = JSON.parse(init.body);
          return { ok: true, status: 200, async text() { return JSON.stringify(respond()); } };
        },
      },
      log: { info() {}, warn() {}, error() {} },
    },
    store: {
      getConfig() {
        return {
          modelSource: "custom",
          customModel: { baseUrl: "https://api.example.test/v1", apiKey: "k", model: "m", api: "openai-completions" },
        };
      },
      saveConfig() {},
    },
  });
}

test("诊断：要了关思考却仍有思考就标记出来；正常返回时不标记", async () => {
  const stuck = makeCustomModel(() => ({
    choices: [{ message: { reasoning_content: "想了半天", content: "" } }],
    finish_reason: "length",
  }));
  await assert.rejects(stuck.sample([{ role: "user", content: "hi" }], { maxTokens: 100, reasoningLevel: "off" }));
  assert.equal(stuck.lastDiagnostics.hadThinking, true);
  assert.equal(stuck.lastDiagnostics.finishReason, "length");
  assert.equal(stuck.lastDiagnostics.reasoningDisabledButStillThinking, true);
  assert.equal(stuck.lastDiagnostics.retried, true);
  assert.equal(stuck.lastDiagnostics.retrySucceeded, false);

  const fine = makeCustomModel(() => ({ choices: [{ message: { content: "正文" } }], finish_reason: "stop" }));
  const text = await fine.sample([{ role: "user", content: "hi" }], { maxTokens: 100, reasoningLevel: "off" });
  assert.equal(text, "正文");
  assert.equal(fine.lastDiagnostics.reasoningDisabledButStillThinking, false);
  assert.equal(fine.lastDiagnostics.retried, false);
});

test("诊断：没要求关思考时，即使有思考也不算「关不掉」", async () => {
  const mc = makeCustomModel(() => ({
    choices: [{ message: { reasoning_content: "想", content: "正文" } }],
    finish_reason: "stop",
  }));
  await mc.sample([{ role: "user", content: "hi" }], { maxTokens: 100, reasoningLevel: "high" });
  assert.equal(mc.lastDiagnostics.hadThinking, true);
  assert.equal(mc.lastDiagnostics.reasoningDisabledButStillThinking, false);
});

// ── 集成：记下 + 下一次首轮给足 + 设置接口回传 ──

test("路由：观测到关不掉思考就记下这一个档，下一次首轮直接给足预算", () => {
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "sgj-thinking-unstoppable-"));
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
    fs.writeFileSync(path.join(home, "users.json"), JSON.stringify({ defaultUserId: "u1", users: [{ userId: "u1", displayName: "小测试" }] }));
    fs.writeFileSync(path.join(home, "models.json"), JSON.stringify({ providers: {
      "command code": { baseUrl: "https://api.commandcode.ai/provider/v1", api: "openai-completions", models: [{ id: "deepseek/deepseek-v4-flash", input: ["text"], reasoning: true }] },
    } }));
    fs.writeFileSync(path.join(agents, "config.yaml"), "agent:\\n  name: 小花\\n");
    fs.writeFileSync(path.join(sessions, "one.jsonl"),
      JSON.stringify({ type: "message", timestamp: "2026-09-05T10:00:00+08:00", message: { role: "user", content: "今天把模型这块收一下" } }) + "\\n" +
      JSON.stringify({ type: "message", timestamp: "2026-09-05T10:01:00+08:00", message: { role: "assistant", content: "要得，我来收" } }) + "\\n");

    const data = new UserData(dataDir);
    await data.updateSettings({
      autoSummary: true, moodDiscoveryMode: "off", partnerMoodEnabled: false, dayBoundaryHour: 4,
      modelSource: "hana", hanaModel: { providerId: "command code", modelId: "deepseek/deepseek-v4-flash" },
    });

    const calls = [];
    const ctx = {
      dataDir,
      bus: { async request(topic) {
        if (topic === "provider:credentials") return { apiKey: "runtime-key", baseUrl: "https://api.commandcode.ai/provider/v1", api: "openai-completions" };
        throw new Error("不应请求工具模型总线");
      } },
      network: { async fetch(url, init) {
        const body = JSON.parse(init.body);
        calls.push(body);
        // 这个档的模拟：思考一大堆、正文为空、被长度截断（关不掉思考的典型样子）
        return { ok: true, status: 200, async text() {
          return JSON.stringify({ choices: [{ message: { reasoning_content: "想了很久很久", content: "" } }], finish_reason: "length" });
        } };
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
    const settingsRoute = routes.find((item) => item.method === "GET" && item.path === "/api/settings");
    const call = () => run.handler({ req: { async json() { return { date: "2026-09-05" }; } }, json(v) { return v; } });

    // 第一次：注定失败，但要把「这个档关不掉思考」记下来
    await call();
    const afterFirst = new UserData(dataDir).getSettings();
    const key = "command code/deepseek/deepseek-v4-flash";
    if (!afterFirst.thinkingUnstoppable || !afterFirst.thinkingUnstoppable[key]) {
      throw new Error("没有记下关不掉思考的档：" + JSON.stringify(afterFirst.thinkingUnstoppable));
    }
    const firstTokens = calls[0].max_tokens;

    // 第二次：首轮就该给足，不再从小预算试起
    calls.length = 0;
    await call();
    const secondFirst = calls[0].max_tokens;

    // 设置接口要把标记回传给页面
    const settingsRes = await settingsRoute.handler({ json(v) { return v; } });
    if (settingsRes.settings.thinkingUnstoppable !== true) {
      throw new Error("设置接口没回传关不掉标记：" + JSON.stringify(settingsRes.settings.thinkingUnstoppable));
    }
    if (settingsRes.settings.thinkingModelKey !== key) {
      throw new Error("设置接口没回传当前档位：" + settingsRes.settings.thinkingModelKey);
    }

    console.log(JSON.stringify({ firstTokens, secondFirst, unstoppable: settingsRes.settings.thinkingUnstoppable }));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", childCode], {
    encoding: "utf8",
    cwd: path.resolve("."),
    env: { ...process.env, USERPROFILE: isolatedHome, HOME: isolatedHome, HANA_HOME: path.join(isolatedHome, ".hanako") },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /"firstTokens":500/, "第一次应该还是原来的小预算");
  assert.match(result.stdout, /"secondFirst":8000/, "第二次首轮就应该给足");
  assert.match(result.stdout, /"unstoppable":true/);
});
