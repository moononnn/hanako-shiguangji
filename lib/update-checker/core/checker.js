// update-checker · core/checker.js — UpdateChecker 类
// 流程：读 manifest 当前版本 → 查 GitHub releases/latest → 对比 → 返回结果
// 降级：GitHub 不可用（限流/404/超时/断网）时返回 hasUpdate:false + 友好 message，不抛错
// 缓存：同一 repo 10 分钟内不重复请求（GitHub 未认证限 60 次/小时）

import fs from "node:fs";
import { compareVersions } from "./compare.js";

const CACHE_TTL_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8000;

export class UpdateChecker {
  constructor({ ctx, manifestPath }) {
    this.ctx = ctx;
    this.manifestPath = manifestPath || null;
    this.cache = new Map(); // repo → { at, data }
  }

  clearCache() {
    this.cache.clear();
  }

  // 读取当前版本（读不到返回 0.0.0，不抛错，但留日志方便排查）
  readCurrentVersion(manifestPath) {
    const mPath = manifestPath || this.manifestPath;
    if (!mPath) return "0.0.0";
    try {
      const raw = fs.readFileSync(mPath, "utf-8");
      const manifest = JSON.parse(raw);
      return String(manifest.version || "0.0.0");
    } catch (e) {
      this.ctx?.log?.warn?.("[update-checker] 读取 manifest 失败（视为 0.0.0）:", e.message);
      return "0.0.0";
    }
  }

  // repo 格式："owner/name"
  async check({ repo, manifestPath } = {}) {
    if (!repo || !/^[^/]+\/[^/]+$/.test(repo)) {
      return { ok: true, hasUpdate: false, current: "0.0.0", latest: "0.0.0", releaseUrl: "", message: "仓库地址配置有误" };
    }
    const current = this.readCurrentVersion(manifestPath);

    const cached = this.cache.get(repo);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return { ...cached.data, cached: true };
    }

    const data = await this._fetchLatest(repo, current);
    // 网络异常（断网/超时）不缓存：恢复后重试不应拿到假失败；404/403 等 GitHub 侧状态缓存（防限流）
    if (!data._transient) {
      this.cache.set(repo, { at: Date.now(), data });
      // 缓存上限 50：防止异常场景（大量 repo 切换）内存膨胀，超限删最早插入的
      if (this.cache.size > 50) {
        const oldest = this.cache.keys().next().value;
        if (oldest) this.cache.delete(oldest);
      }
    }
    return { ...data, cached: false };
  }

  async _fetchLatest(repo, current) {
    const fetcher = this.ctx?.network?.fetch || globalThis.fetch;
    try {
      const resp = await fetcher(`https://api.github.com/repos/${repo}/releases/latest`, {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "plugin-kit-update-checker",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (resp.status === 404) {
        this.ctx?.log?.info?.("[update-checker] 仓库无 release（404）:", repo);
        return { ok: true, hasUpdate: false, current, latest: current, latestTitle: "", releaseUrl: `https://github.com/${repo}/releases`, message: "这个仓库还没有发布版本" };
      }
      if (!resp.ok) {
        this.ctx?.log?.warn?.("[update-checker] GitHub 返回非 2xx:", `HTTP ${resp.status}`, repo);
        return { ok: true, hasUpdate: false, current, latest: current, latestTitle: "", releaseUrl: `https://github.com/${repo}/releases`, message: `GitHub 暂时不可用（${resp.status}），稍后再试` };
      }

      let json;
      try {
        json = await resp.json();
      } catch (e) {
        this.ctx?.log?.warn?.("[update-checker] release 响应 JSON 解析失败:", e.message);
        return { ok: true, hasUpdate: false, current, latest: current, latestTitle: "", releaseUrl: `https://github.com/${repo}/releases`, message: "GitHub 返回了无法解析的内容，稍后再试" };
      }
      const tag = String(json.tag_name || "").replace(/^v/i, "");
      const hasUpdate = compareVersions(tag, current) > 0;
      return {
        ok: true,
        hasUpdate,
        current,
        latest: tag || current,
        latestTitle: json.name || json.tag_name || "",
        releaseUrl: json.html_url || `https://github.com/${repo}/releases`,
        message: hasUpdate ? "发现新版本" : "已是最新版本 ✨",
      };
    } catch (e) {
      this.ctx?.log?.warn?.("[update-checker] 检查更新网络异常:", e?.message || e);
      return { ok: true, hasUpdate: false, current, latest: current, latestTitle: "", releaseUrl: `https://github.com/${repo}/releases`, message: "检查失败（网络不通或超时），稍后再试", _transient: true };
    }
  }
}
