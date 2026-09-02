// update-checker 测试 — node:test 零依赖
// 运行：node --test tests/update-checker.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { compareVersions, UpdateChecker } from "../index.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/manifest.json", import.meta.url));
const MISSING = fileURLToPath(new URL("./fixtures/not-exist.json", import.meta.url));

// ── mock fetch 工厂 ──
function makeFetcher(handler) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init, calls.length);
  };
  return { fetch, calls };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

// ═══════ compareVersions ═══════

test("compare：常规版本比较", () => {
  assert.equal(compareVersions("1.2.3", "1.2.2"), 1);
  assert.equal(compareVersions("1.2.2", "1.2.3"), -1);
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
  assert.equal(compareVersions("2.0.0", "1.9.9"), 1);
});

test("compare：预发布 < 正式版", () => {
  assert.equal(compareVersions("2.0.0-beta.1", "2.0.0"), -1);
  assert.equal(compareVersions("2.0.0", "2.0.0-beta.1"), 1);
  assert.equal(compareVersions("1.0.0-alpha", "1.0.0-beta"), -1);
  assert.equal(compareVersions("1.0.0-beta", "1.0.0-rc"), -1);
  assert.equal(compareVersions("1.0.0-rc", "1.0.0"), -1);
});

test("compare：缺段位补 0", () => {
  assert.equal(compareVersions("1.2", "1.2.0"), 0);
  assert.equal(compareVersions("1.2.1", "1.2"), 1);
  assert.equal(compareVersions("1", "1.0.0"), 0);
});

test("compare：v 前缀忽略", () => {
  assert.equal(compareVersions("v1.2.3", "1.2.3"), 0);
  assert.equal(compareVersions("v2.0.0", "1.9.9"), 1);
});

test("compare：非数字容错（解析不了当 0.0.0，不抛错）", () => {
  assert.equal(compareVersions("abc", "1.0.0"), -1);
  assert.equal(compareVersions("", "0.0.0"), 0);
  assert.equal(compareVersions(null, "1.0.0"), -1);
  assert.equal(compareVersions("1.2.3", "???"), 1);
});

test("compare：+build 构建元数据忽略（不算预发布）", () => {
  assert.equal(compareVersions("1.2.3+build5", "1.2.3"), 0);
  assert.equal(compareVersions("1.2.3+build5", "1.2.2"), 1);
  assert.equal(compareVersions("1.2.4", "1.2.3+build99"), 1);
  // 预发布 + build 的组合：1.0.0-beta.1+build5 仍是预发布
  assert.equal(compareVersions("1.0.0-beta.1+build5", "1.0.0"), -1);
});

test("compare：同等级预发布数字后缀按数值比（beta.10 > beta.2）", () => {
  assert.equal(compareVersions("1.0.0-beta.10", "1.0.0-beta.2"), 1);
  assert.equal(compareVersions("1.0.0-rc.10", "1.0.0-rc.9"), 1);
  assert.equal(compareVersions("1.0.0-beta.2", "1.0.0-beta.10"), -1);
  assert.equal(compareVersions("1.0.0-beta.10", "1.0.0-beta.10"), 0);
});

test("compare：黏连式数字后缀也按数值比（beta10 > beta2，beta2 == beta.2）", () => {
  assert.equal(compareVersions("1.0.0-beta10", "1.0.0-beta2"), 1);
  assert.equal(compareVersions("1.0.0-beta2", "1.0.0-beta10"), -1);
  assert.equal(compareVersions("1.0.0-beta2", "1.0.0-beta.2"), 0);
  assert.equal(compareVersions("1.0.0-rc10", "1.0.0-rc9"), 1);
});

test("compare：dev/snapshot 等开发中版本比 alpha 还早", () => {
  assert.equal(compareVersions("1.0.0-dev", "1.0.0-alpha"), -1);
  assert.equal(compareVersions("1.0.0-snapshot", "1.0.0-beta"), -1);
  assert.equal(compareVersions("1.0.0-dev", "1.0.0"), -1);
  assert.equal(compareVersions("1.0.0-alpha", "1.0.0-dev"), 1);
});

// ═══════ UpdateChecker ═══════

test("check：有更新时返回新版本信息", async () => {
  const { fetch, calls } = makeFetcher(() => jsonResponse({
    tag_name: "v2.4.0",
    name: "新版本标题",
    html_url: "https://github.com/o/r/releases/tag/v2.4.0",
  }));
  const uc = new UpdateChecker({ ctx: { network: { fetch } }, manifestPath: null });
  const r = await uc.check({ repo: "o/r", manifestPath: null });
  assert.equal(r.ok, true);
  assert.equal(r.hasUpdate, true);
  assert.equal(r.latest, "2.4.0");
  assert.equal(r.latestTitle, "新版本标题");
  assert.equal(r.current, "0.0.0"); // 没 manifest 时当前版本 0.0.0
  assert.match(r.releaseUrl, /o\/r/);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /repos\/o\/r\/releases\/latest/);
});

test("check：无更新时返回已是最新", async () => {
  const { fetch } = makeFetcher(() => jsonResponse({ tag_name: "v1.0.0", html_url: "https://x" }));
  const uc = new UpdateChecker({ ctx: { network: { fetch } }, manifestPath: null });
  const r = await uc.check({ repo: "o/r", manifestPath: FIXTURE }); // manifest 1.0.0
  assert.equal(r.hasUpdate, false);
  assert.match(r.message, /最新/);
});

test("check：读 manifest 拿当前版本（有更新判断正确）", async () => {
  const { fetch } = makeFetcher(() => jsonResponse({ tag_name: "v1.2.0", html_url: "https://x" }));
  const uc = new UpdateChecker({ ctx: { network: { fetch } }, manifestPath: null });
  const r = await uc.check({ repo: "o/r", manifestPath: FIXTURE });
  assert.equal(r.current, "1.0.0");
  assert.equal(r.hasUpdate, true);
});

test("check：manifest 不存在时当前版本 0.0.0，不抛错", async () => {
  const { fetch } = makeFetcher(() => jsonResponse({ tag_name: "v0.1.0", html_url: "https://x" }));
  const uc = new UpdateChecker({ ctx: { network: { fetch } }, manifestPath: null });
  const r = await uc.check({ repo: "o/r", manifestPath: MISSING });
  assert.equal(r.current, "0.0.0");
  assert.equal(r.hasUpdate, true);
});

test("check：404（仓库无 release）优雅降级", async () => {
  const { fetch } = makeFetcher(() => jsonResponse({ message: "Not Found" }, 404));
  const uc = new UpdateChecker({ ctx: { network: { fetch } }, manifestPath: null });
  const r = await uc.check({ repo: "o/r" });
  assert.equal(r.hasUpdate, false);
  assert.match(r.message, /还没有发布版本/);
});

test("check：限流 403 优雅降级", async () => {
  const { fetch } = makeFetcher(() => jsonResponse({ message: "rate limit" }, 403));
  const uc = new UpdateChecker({ ctx: { network: { fetch } }, manifestPath: null });
  const r = await uc.check({ repo: "o/r" });
  assert.equal(r.hasUpdate, false);
  assert.match(r.message, /403/);
});

test("check：网络异常（fetch 抛错）优雅降级，不抛", async () => {
  const { fetch } = makeFetcher(() => { throw new Error("ENOTFOUND"); });
  const uc = new UpdateChecker({ ctx: { network: { fetch } }, manifestPath: null });
  const r = await uc.check({ repo: "o/r" });
  assert.equal(r.hasUpdate, false);
  assert.match(r.message, /检查失败/);
});

test("check：repo 格式非法返回友好错误", async () => {
  const { fetch, calls } = makeFetcher(() => jsonResponse({ tag_name: "v1.0.0" }));
  const uc = new UpdateChecker({ ctx: { network: { fetch } }, manifestPath: null });
  const r = await uc.check({ repo: "bad-repo" });
  assert.equal(r.hasUpdate, false);
  assert.match(r.message, /配置有误/);
  assert.equal(calls.length, 0); // 没发请求
});

test("check：缓存生效（10 分钟内不重复请求）", async () => {
  const { fetch, calls } = makeFetcher(() => jsonResponse({ tag_name: "v9.9.9", html_url: "https://x" }));
  const uc = new UpdateChecker({ ctx: { network: { fetch } }, manifestPath: null });
  await uc.check({ repo: "o/r" });
  await uc.check({ repo: "o/r" });
  await uc.check({ repo: "o/r" });
  assert.equal(calls.length, 1);
  // 不同 repo 不串缓存
  await uc.check({ repo: "o/r2" });
  assert.equal(calls.length, 2);
});

test("check：网络异常结果不进缓存（恢复后重试能拿到真结果）", async () => {
  let fail = true;
  const { fetch, calls } = makeFetcher(() => {
    if (fail) throw new Error("ENOTFOUND");
    return jsonResponse({ tag_name: "v2.0.0", html_url: "https://x" });
  });
  const uc = new UpdateChecker({ ctx: { network: { fetch } }, manifestPath: null });
  const r1 = await uc.check({ repo: "o/r" });
  assert.equal(r1.hasUpdate, false);
  fail = false; // 网络恢复
  const r2 = await uc.check({ repo: "o/r" }); // 若异常结果被缓存，这里会返回假失败
  assert.equal(r2.hasUpdate, true);
  assert.equal(calls.length, 2);
});

test("check：404 结果进缓存（防 GitHub 限流，重复点不刷请求）", async () => {
  const { fetch, calls } = makeFetcher(() => jsonResponse({ message: "Not Found" }, 404));
  const uc = new UpdateChecker({ ctx: { network: { fetch } }, manifestPath: null });
  await uc.check({ repo: "o/r" });
  await uc.check({ repo: "o/r" });
  assert.equal(calls.length, 1);
});

test("check：缓存超 50 个 repo 自动清理最旧", async () => {
  const { fetch, calls } = makeFetcher(() => jsonResponse({ tag_name: "v1.0.0", html_url: "https://x" }));
  const uc = new UpdateChecker({ ctx: { network: { fetch } }, manifestPath: null });
  for (let i = 0; i < 55; i++) {
    await uc.check({ repo: `o/r${i}` });
  }
  assert.equal(calls.length, 55);
  assert.ok(uc.cache.size <= 50);
  // 最旧的 repo 已被清理：再查会重新请求
  await uc.check({ repo: "o/r0" });
  assert.equal(calls.length, 56);
});

test("check：缓存结果带 cached 标记，clearCache 后重新请求", async () => {
  const { fetch, calls } = makeFetcher(() => jsonResponse({ tag_name: "v1.1.0", html_url: "https://x" }));
  const uc = new UpdateChecker({ ctx: { network: { fetch } }, manifestPath: null });
  const r1 = await uc.check({ repo: "o/r" });
  assert.equal(r1.cached, false);
  const r2 = await uc.check({ repo: "o/r" });
  assert.equal(r2.cached, true);
  uc.clearCache();
  const r3 = await uc.check({ repo: "o/r" });
  assert.equal(r3.cached, false);
  assert.equal(calls.length, 2);
});

test("readCurrentVersion：正常 / 损坏 / 缺失 三态", () => {
  const uc = new UpdateChecker({ ctx: {}, manifestPath: null });
  assert.equal(uc.readCurrentVersion(null), "0.0.0");
  assert.equal(uc.readCurrentVersion(MISSING), "0.0.0");
  assert.equal(uc.readCurrentVersion(FIXTURE), "1.0.0");
});
