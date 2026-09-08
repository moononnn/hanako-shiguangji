// 拾光记 · 网络边界回归测试
// 生产网络只能从宿主 ctx.network.fetch 出口；无出口时功能 fail-closed。

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ModelConfig, mergeModelConfig } from "../lib/model-config/index.js";
import {
  createWeatherFetcher,
  getWeatherForInject,
} from "../lib/weather.js";
import { UpdateChecker } from "../lib/update-checker/index.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));

function makeWeatherData(settings, cache = null) {
  return {
    getSettings() {
      return settings;
    },
    getWeatherCache() {
      return cache;
    },
    async setWeatherCache(next) {
      cache = next;
    },
  };
}

test("manifest：只保留实际贡献与网络响应上限", () => {
  assert.deepEqual(Object.keys(MANIFEST.contributes), ["page"]);
  assert.equal(MANIFEST.ui, undefined);
  assert.equal(MANIFEST.network.maxResponseBytes, 1024 * 1024);
});

test("天气：请求经宿主网络出口并携带超时/响应大小限制", async () => {
  const calls = [];
  const network = {
    async fetch(url, init) {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            current: {
              temperature_2m: 28,
              weather_code: 0,
              is_day: 1,
              time: "2026-09-03T08:00:00+08:00",
            },
          };
        },
      };
    },
  };
  const data = makeWeatherData({
    weatherLocation: "四川省 成都市 武侯区",
    weatherArea: { code: "510107" },
    weatherIntervalHours: 3,
  });
  const weather = await getWeatherForInject({
    data,
    location: "四川省 成都市 武侯区",
    coordinates: { latitude: 30.63, longitude: 104.04 },
    now: new Date("2026-09-03T08:00:00+08:00"),
    fetcher: createWeatherFetcher(network),
    noCache: true,
  });
  assert.equal(weather.temp, 28);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^https:\/\/api\.open-meteo\.com\/v1\/forecast/);
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.timeoutMs, 8000);
  assert.equal(calls[0].init.maxResponseBytes, 1024 * 1024);
});

test("天气：没有宿主网络出口时不出网，缓存仍可读", async () => {
  const settings = {
    weatherLocation: "四川省 成都市 武侯区",
    weatherArea: { code: "510107" },
    weatherIntervalHours: 3,
  };
  const freshCache = {
    location: settings.weatherLocation,
    fetchedAt: Date.now(),
    result: { place: settings.weatherLocation, line: "晴朗，28°C", temp: 28, code: 0, isDay: true },
  };
  const cached = await getWeatherForInject({
    data: makeWeatherData(settings, freshCache),
    now: new Date(),
  });
  assert.equal(cached.temp, 28);

  const noNetwork = await getWeatherForInject({
    data: makeWeatherData(settings),
    coordinates: { latitude: 30.63, longitude: 104.04 },
    now: new Date(),
  });
  assert.equal(noNetwork, null);
});

test("检查更新：没有宿主网络出口时不回退全局 fetch", async () => {
  const checker = new UpdateChecker({ ctx: {}, manifestPath: null });
  const result = await checker.check({ repo: "owner/repo" });
  assert.equal(result.hasUpdate, false);
  assert.equal(result._transient, true);
  assert.match(result.message, /检查失败/);
  assert.match(result.message, /https:\/\/github\.com\/owner\/repo\/releases/);
  assert.equal(result.manualCheck, true);
  assert.equal(result.releaseUrl, "https://github.com/owner/repo/releases");
});

test("自定义模型：请求经宿主网络出口并保留响应解析", async () => {
  const calls = [];
  const model = new ModelConfig({
    ctx: {
      network: {
        async fetch(url, init) {
          calls.push({ url, init });
          return {
            ok: true,
            status: 200,
            async text() {
              return JSON.stringify({ choices: [{ message: { content: "通了" } }] });
            },
          };
        },
      },
    },
    store: {
      getConfig() {
        return {
          modelSource: "custom",
          customModel: { baseUrl: "https://example.test/v1", apiKey: "test-key", model: "demo" },
        };
      },
      saveConfig() {},
    },
  });
  const text = await model.sample([{ role: "user", content: "测试" }], { source: "custom" });
  assert.equal(text, "通了");
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/chat\/completions$/);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.maxResponseBytes, 1024 * 1024);
});

test("自定义模型：没有宿主网络出口时拒绝直连", async () => {
  const model = new ModelConfig({
    ctx: {},
    store: {
      getConfig() {
        return {
          modelSource: "custom",
          customModel: { baseUrl: "https://example.test/v1", apiKey: "test-key", model: "demo" },
        };
      },
      saveConfig() {},
    },
  });
  await assert.rejects(
    model.sample([{ role: "user", content: "测试" }], { source: "custom" }),
    /宿主网络能力不可用/,
  );
});

test("Hana 模型档：按所选模型读取运行时凭据并直连，不请求工具模型", async () => {
  const networkCalls = [];
  const busCalls = [];
  const model = new ModelConfig({
    ctx: {
      network: {
        async fetch(url, init) {
          networkCalls.push({ url, init });
          return {
            ok: true,
            status: 200,
            async text() {
              return JSON.stringify({ choices: [{ message: { content: "通了" } }] });
            },
          };
        },
      },
      bus: {
        async request(topic, input) {
          busCalls.push({ topic, input });
          return { apiKey: "runtime-key", baseUrl: "https://api.deepseek.com", api: "openai-completions" };
        },
      },
    },
    store: {
      getConfig() {
        return {
          modelSource: "hana",
          hanaModel: { providerId: "deepseek", modelId: "deepseek-v4-flash" },
        };
      },
      saveConfig() {},
    },
  });
  model.setHanaModelsProvider(async () => [{
    providerId: "deepseek",
    providerName: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    api: "openai-completions",
    models: [{ modelId: "deepseek-v4-flash", name: "DeepSeek V4 Flash", reasoning: true }],
  }]);
  const text = await model.sample([{ role: "user", content: "测试" }], { source: "hana", retryOnEmpty: false });
  assert.equal(text, "通了");
  assert.deepEqual(busCalls.map((entry) => entry.topic), ["provider:credentials"]);
  assert.equal(networkCalls.length, 1);
  assert.equal(networkCalls[0].url, "https://api.deepseek.com/chat/completions");
  assert.equal(networkCalls[0].init.headers.Authorization, "Bearer runtime-key");
  assert.equal(JSON.parse(networkCalls[0].init.body).model, "deepseek-v4-flash");
  assert.equal(JSON.parse(networkCalls[0].init.body).thinking.type, "disabled");
});

test("Hana 模型档：openai-responses 接口走 /responses 并提取 output_text", async () => {
  const calls = [];
  const model = new ModelConfig({
    ctx: {
      bus: { async request() { return { apiKey: "runtime-key", baseUrl: "https://api.deepseek.com", api: "openai-responses" }; } },
      network: {
        async fetch(url, init) {
          calls.push({ url, body: JSON.parse(init.body) });
          return {
            ok: true,
            status: 200,
            async text() {
              return JSON.stringify({
                output: [
                  { type: "reasoning", summary: [{ type: "summary_text", text: "隐藏思考" }] },
                  { type: "message", content: [{ type: "output_text", text: "通了" }] },
                ],
              });
            },
          };
        },
      },
    },
    store: {
      getConfig() {
        return { modelSource: "hana", hanaModel: { providerId: "deepseek", modelId: "deepseek-v4-flash" } };
      },
      saveConfig() {},
    },
  });
  model.setHanaModelsProvider(async () => [{
    providerId: "deepseek",
    baseUrl: "https://api.deepseek.com",
    api: "openai-responses",
    models: [{ modelId: "deepseek-v4-flash", reasoning: true }],
  }]);
  const text = await model.sample([{ role: "user", content: "测试" }], { source: "hana", retryOnEmpty: false });
  assert.equal(text, "通了");
  assert.equal(calls[0].url, "https://api.deepseek.com/responses");
  assert.equal(calls[0].body.model, "deepseek-v4-flash");
  assert.deepEqual(calls[0].body.reasoning, { effort: "none" });
  assert.ok(Array.isArray(calls[0].body.input));
});

test("Hana 模型档：没有运行时凭据时明确失败，不静默回落工具槽", async () => {
  const networkCalls = [];
  const model = new ModelConfig({
    ctx: {
      bus: { async request() { return { error: "no_credentials" }; } },
      network: { async fetch(...args) { networkCalls.push(args); } },
    },
    store: {
      getConfig() {
        return { modelSource: "hana", hanaModel: { providerId: "deepseek", modelId: "deepseek-v4-flash" } };
      },
      saveConfig() {},
    },
  });
  model.setHanaModelsProvider(async () => [{ providerId: "deepseek", baseUrl: "https://api.deepseek.com", models: [{ modelId: "deepseek-v4-flash" }] }]);
  const result = await model.handleTest({ source: "hana" });
  assert.equal(result.ok, false);
  assert.match(result.error, /没有可用凭据/);
  assert.equal(networkCalls.length, 0);
});

test("Hana 模型档：保存只保留 provider/model，旧测试 Key 不落盘", async () => {
  let config = { modelSource: "agent" };
  const model = new ModelConfig({
    ctx: {},
    store: {
      getConfig() { return config; },
      async saveConfig(mutator) { mutator(config); },
    },
  });
  const result = await model.handleSave({
    source: "hana",
    hanaModel: {
      providerId: "deepseek",
      modelId: "deepseek-v4-flash",
      baseUrl: "https://api.deepseek.com",
      api: "openai-completions",
      apiKey: "super-secret-key",
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(config.hanaModel, { providerId: "deepseek", modelId: "deepseek-v4-flash" });
  assert.doesNotMatch(JSON.stringify(result.config), /super-secret-key/);
  assert.deepEqual(result.config.hanaModel, { providerId: "deepseek", modelId: "deepseek-v4-flash" });
});

test("Hana 模型档：启动清理与用户保存共用串行队列，不恢复旧字段", async () => {
  let config = {
    modelSource: "hana",
    hanaModel: { providerId: "p1", modelId: "m1", baseUrl: "https://old.example", apiKey: "old-secret" },
  };
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let writes = 0;
  const store = {
    getConfig() { return config; },
    async saveConfig(mutator) {
      writes++;
      if (writes === 1) await gate;
      mutator(config);
    },
  };
  const model = new ModelConfig({ ctx: {}, store });
  const cleanup = model.cleanupLegacyHanaCredentials();
  await new Promise((resolve) => setImmediate(resolve));
  const save = model.saveConfig({ source: "hana", hanaModel: { providerId: "p2", modelId: "m2" } });
  release();
  await Promise.all([cleanup, save]);
  assert.equal(writes, 2);
  assert.deepEqual(config.hanaModel, { providerId: "p2", modelId: "m2" });
});

test("Hana 模型档：切换到其他档位时也清理旧地址或 Key", async () => {
  const previous = {
    modelSource: "hana",
    hanaModel: {
      providerId: "deepseek",
      modelId: "deepseek-v4-flash",
      baseUrl: "https://api.deepseek.com",
      api: "openai-completions",
      apiKey: "deepseek-key",
    },
  };
  const switched = await mergeModelConfig(previous, { source: "agent" });
  assert.deepEqual(switched.hanaModel, { providerId: "deepseek", modelId: "deepseek-v4-flash" });
  assert.doesNotMatch(JSON.stringify(switched), /deepseek-key|api\.deepseek\.com/);
});

test("Hana 模型档：切换供应商时不会带着旧地址或 Key", async () => {
  const previous = {
    modelSource: "hana",
    hanaModel: {
      providerId: "deepseek",
      modelId: "deepseek-v4-flash",
      baseUrl: "https://api.deepseek.com",
      api: "openai-completions",
      apiKey: "deepseek-key",
    },
  };
  const switched = await mergeModelConfig(previous, {
    source: "hana",
    hanaModel: { providerId: "minimax", modelId: "MiniMax-M2.5" },
  });
  assert.deepEqual(switched.hanaModel, { providerId: "minimax", modelId: "MiniMax-M2.5" });
});

test("网络生产模块：不存在 globalThis.fetch 降级路径", () => {
  for (const relative of [
    "lib/weather.js",
    "lib/update-checker/core/checker.js",
    "lib/model-config/core/client.js",
  ]) {
    const source = fs.readFileSync(path.join(ROOT, relative), "utf8");
    assert.doesNotMatch(source, /globalThis\.fetch/, relative);
  }
});

test("manifest：网络白名单收窄为已知域名（不含 * 通配）", () => {
  const hosts = MANIFEST.network.allowedHosts;
  assert.ok(Array.isArray(hosts) && hosts.length > 0);
  assert.ok(!hosts.includes("*"), "不允许裸 * 通配（宿主只认精确域名与 *.子域）");
  for (const required of ["api.open-meteo.com", "geocoding-api.open-meteo.com", "api.github.com"]) {
    assert.ok(hosts.includes(required), `缺少基础域名 ${required}`);
  }
  // 预置主流 OpenAI 兼容服务域名，custom 档常用供应商不用改 manifest
  for (const vendor of [
    "api.deepseek.com",
    "api.openai.com",
    "api.anthropic.com",
    "openrouter.ai",
    "api.commandcode.ai",
    "note3-prev-api.askdiandian.com",
  ]) {
    assert.ok(hosts.includes(vendor), `缺少模型商域名 ${vendor}`);
  }
});

test("自定义模型：名单外域名被宿主拦截时报可读中文引导", async () => {
  const model = new ModelConfig({
    ctx: {
      network: {
        async fetch() {
          const err = new Error(
            'Plugin network.fetch host "api.unknown.test" is not declared in manifest network.allowedHosts',
          );
          err.code = "PLUGIN_NETWORK_HOST_NOT_ALLOWED";
          throw err;
        },
      },
    },
    store: {
      getConfig() {
        return {
          modelSource: "custom",
          customModel: { baseUrl: "https://api.unknown.test/v1", apiKey: "test-key", model: "demo" },
        };
      },
      saveConfig() {},
    },
  });
  await assert.rejects(
    model.sample([{ role: "user", content: "测试" }], { source: "custom", retryOnEmpty: false }),
    /api\.unknown\.test 不在拾光记的网络放行名单里/,
  );
});

test("自定义模型：Anthropic system 放到顶层，不把 system role 塞进 messages", async () => {
  let capturedBody = null;
  const model = new ModelConfig({
    ctx: {
      network: {
        async fetch(url, init) {
          capturedBody = JSON.parse(init.body);
          return {
            ok: true,
            status: 200,
            async text() {
              return JSON.stringify({ content: [{ type: "text", text: "通了" }] });
            },
          };
        },
      },
    },
    store: {
      getConfig() {
        return {
          modelSource: "custom",
          customModel: { baseUrl: "https://api.anthropic.com/v1", apiKey: "test-key", model: "claude-test", api: "anthropic-messages" },
        };
      },
      saveConfig() {},
    },
  });
  const text = await model.sample([
    { role: "system", content: "只说中文" },
    { role: "user", content: "测试" },
  ], { source: "custom", retryOnEmpty: false });
  assert.equal(text, "通了");
  assert.equal(capturedBody.system, "只说中文");
  assert.deepEqual(capturedBody.messages, [{ role: "user", content: "测试" }]);
});

test("连通测试：探测请求带足 token 预算（避免思考模型空正文误报）", async () => {
  let capturedBody = null;
  const model = new ModelConfig({
    ctx: {
      network: {
        async fetch(url, init) {
          capturedBody = JSON.parse(init.body);
          return {
            ok: true,
            status: 200,
            async text() {
              return JSON.stringify({ choices: [{ message: { content: "通了" } }] });
            },
          };
        },
      },
    },
    store: {
      getConfig() {
        return {
          modelSource: "custom",
          customModel: { baseUrl: "https://example.test/v1", apiKey: "test-key", model: "demo" },
        };
      },
      saveConfig() {},
    },
  });
  const result = await model.testConnection("custom");
  assert.equal(result.ok, true);
  assert.ok(capturedBody && capturedBody.max_tokens >= 512, `探测预算应 ≥512，实际 ${capturedBody?.max_tokens}`);
});

test("天气：网络失败原因可经 onError 透出", async () => {
  const failures = [];
  const data = makeWeatherData({
    weatherLocation: "四川省 成都市 武侯区",
    weatherArea: { code: "510107" },
    weatherIntervalHours: 3,
  });
  const weather = await getWeatherForInject({
    data,
    location: "四川省 成都市 武侯区",
    coordinates: { latitude: 30.63, longitude: 104.04 },
    now: new Date(),
    fetcher: async () => {
      throw new Error("模拟网络不可达");
    },
    noCache: true,
    onError: (e) => failures.push(e.message),
  });
  assert.equal(weather, null);
  assert.deepEqual(failures, ["模拟网络不可达"]);
});
