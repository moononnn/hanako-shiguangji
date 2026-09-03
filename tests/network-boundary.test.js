// 拾光记 · 网络边界回归测试
// 生产网络只能从宿主 ctx.network.fetch 出口；无出口时功能 fail-closed。

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ModelConfig } from "../lib/model-config/index.js";
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
