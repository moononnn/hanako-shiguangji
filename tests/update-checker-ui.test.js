import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UI_SOURCE = fs.readFileSync(path.join(ROOT, "lib", "update-checker", "ui", "update-checker.js"), "utf8");
const RELEASE_URL = "https://github.com/moononnn/hanako-shiguangji/releases";

function makeElement(id) {
  return {
    id,
    textContent: id === "uc-check-btn" ? "检查更新" : "",
    hidden: id === "uc-link",
    disabled: false,
    href: "",
    title: "",
    listeners: {},
    addEventListener(type, handler) {
      this.listeners[type] = handler;
    },
  };
}

function createHarness({ apiResponse, apiError, fallbackReleaseUrl = RELEASE_URL }) {
  const elements = {
    "uc-check-btn": makeElement("uc-check-btn"),
    "uc-result": makeElement("uc-result"),
    "uc-link": makeElement("uc-link"),
  };
  const window = {
    __TOKEN: "test-token",
    location: { pathname: "/api/plugins/shiguangji/page", search: "?token=test-token" },
  };
  const context = {
    window,
    document: { getElementById(id) { return elements[id] || null; } },
    AbortSignal: { timeout() { return {}; } },
    setTimeout,
    console,
    alert() {},
  };
  context.globalThis = context;
  vm.runInNewContext(UI_SOURCE, context, { filename: "update-checker.js" });
  window.bindUpdateChecker({
    apiBase: "api/check-update",
    releaseUrl: fallbackReleaseUrl,
    apiFetch: apiError
      ? async () => { throw apiError; }
      : async () => ({ json: async () => apiResponse }),
    onToast() {},
  });
  return { elements, window };
}

test("检查更新 UI：未检查前不渲染手动地址框", () => {
  const { window } = createHarness({
    apiResponse: { ok: true, hasUpdate: false, message: "已是最新版本" },
  });
  const html = window.updateCheckerHtml();

  assert.match(html, /id="uc-check-btn"/);
  assert.match(html, /id="uc-result"/);
  assert.doesNotMatch(html, /uc-manual|uc-copy|自动检查暂不可用/);
});

test("检查更新 UI：后端自动检查失败时在结果文字保留仓库地址并展示链接", async () => {
  const { elements, window } = createHarness({
    apiResponse: {
      ok: true,
      hasUpdate: false,
      message: `检查失败（网络不通或超时），请手动查看仓库：${RELEASE_URL}`,
      releaseUrl: RELEASE_URL,
      manualCheck: true,
    },
  });

  await elements["uc-check-btn"].listeners.click();

  assert.ok(elements["uc-result"].textContent.includes(RELEASE_URL));
  assert.equal(elements["uc-link"].hidden, false);
  assert.equal(elements["uc-link"].href, RELEASE_URL);
  assert.equal(elements["uc-link"].textContent, "打开仓库");
  assert.doesNotMatch(window.updateCheckerHtml(), /uc-manual|uc-copy/);
});

test("检查更新 UI：页面请求本身失败时结果文字仍保留仓库地址", async () => {
  const { elements } = createHarness({ apiError: new Error("请求失败") });

  await elements["uc-check-btn"].listeners.click();

  assert.match(elements["uc-result"].textContent, /请手动查看更新/);
  assert.ok(elements["uc-result"].textContent.includes(RELEASE_URL));
  assert.equal(elements["uc-link"].hidden, false);
  assert.equal(elements["uc-link"].href, RELEASE_URL);
  assert.equal(elements["uc-link"].textContent, "打开仓库");
});
