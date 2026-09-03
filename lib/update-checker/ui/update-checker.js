// update-checker · ui/update-checker.js — 检查更新按钮 + 结果（基础版）
// 用法（插件接入）：
//   1. 后端挂一个路由：GET {apiBase} → uc.check({ repo }) 的结果
//   2. 页面插入 updateCheckerHtml() 的返回值（本文件挂 window 全局，需随插件页面加载：
//      服务端渲染内联，或放插件 assets/ 走 Hana 官方资产 URL，不能用静态 import）
//   3. 页面加载后调 bindUpdateChecker({ apiBase, apiFetch, onToast })
// 后端接口约定：
//   GET {apiBase} → { ok, hasUpdate, current, latest, latestTitle, releaseUrl, message, cached }
// releaseUrl：自动检查失败时也应返回 Releases 地址；opts.releaseUrl 是页面请求本身失败时的固定兜底地址。
// apiFetch：可选。不传时组件自动使用可靠的 Hana 页面请求方式（闲不住等成熟插件验证）：
//   从服务端注入的 window.__TOKEN（或 URL 的 ?token=）取凭证，手动拼「插件前缀 + 相对路径 + ?token=」。
//   不要依赖 window.hana.api.fetch——插件 iframe 里它不可靠，裸 fetch 又会丢 token 导致 403。
//   接入方有特殊封装时可显式注入。
// ⚠️ 前端路由不带斜杠前缀：apiBase 传 "api/check-update"（后端注册的是 "/api/check-update"）

(function (global) {
  'use strict';

  function updateCheckerHtml() {
    return ''
      + '<div class="uc-wrap">'
      +   '<button type="button" class="uc-btn" id="uc-check-btn">检查更新</button>'
      +   '<span class="uc-result" id="uc-result"></span>'
      +   '<a class="uc-link" id="uc-link" target="_blank" rel="noopener" hidden>去看看</a>'
      + '</div>';
  }

  function bindUpdateChecker(opts) {
    if (!opts || !opts.apiBase) throw new Error('update-checker ui: apiBase 必填');
    var apiBase = opts.apiBase.replace(/\/+$/, '');
    var fallbackReleaseUrl = opts.releaseUrl || opts.repositoryUrl || '';
    var onToast = opts.onToast || function (msg) { alert(msg); };
    // Hana 页面 API 请求必须带凭证：优先用接入方注入的 apiFetch；不传则自动探测
    // window.__TOKEN（服务端从页面 URL 的 ?token= 注入），手动拼「插件前缀 + 路径 + ?token=」。
    // 不用 window.hana.api.fetch（iframe 里不可靠），也不裸 fetch（会丢 token → 403）。
    function pluginApiFetch(url, init) {
      var base = (window.location.pathname || '').replace(/\/page\/?$/, '').replace(/\/+$/, '');
      var token = (typeof window.__TOKEN !== 'undefined' && window.__TOKEN) || '';
      if (!token) {
        try {
          var m = /[?&]token=([^&]+)/.exec(window.location.search || '');
          if (m) token = decodeURIComponent(m[1]);
        } catch (e) { /* 忽略 */ }
      }
      var cleanUrl = String(url || '').replace(/^\/+/, '');
      var full = (base ? base + '/' : '') + cleanUrl;
      if (token) full += (full.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(token);
      return fetch(full, init || {});
    }
    var apiFetch = (typeof opts.apiFetch === 'function')
      ? opts.apiFetch
      : pluginApiFetch;

    var btn = document.getElementById('uc-check-btn');
    var resultEl = document.getElementById('uc-result');
    var linkEl = document.getElementById('uc-link');
    if (!btn || !resultEl) return;

    function isHttpUrl(value) {
      return typeof value === 'string' && /^https?:\/\//i.test(value);
    }

    function showRepositoryLink(url, label) {
      if (!linkEl || !isHttpUrl(url)) return;
      linkEl.href = url;
      linkEl.textContent = label || '手动查看仓库';
      linkEl.title = url;
      linkEl.hidden = false;
    }

    btn.addEventListener('click', async function () {
      btn.disabled = true;
      var old = btn.textContent;
      btn.textContent = '检查中…';
      resultEl.textContent = '';
      if (linkEl) linkEl.hidden = true;
      try {
        var resp = await apiFetch(apiBase, { signal: AbortSignal.timeout(15000) });
        var data = await resp.json();
        if (!data.ok) throw new Error(data.error || '检查失败');
        resultEl.textContent = data.hasUpdate
          ? '发现新版本 v' + String(data.latest || '') + (data.latestTitle ? '（' + String(data.latestTitle) + '）' : '')
          : String(data.message || '检查完成');
        if (data.releaseUrl && isHttpUrl(data.releaseUrl)) {
          var linkLabel = data.hasUpdate
            ? '去看看新版本'
            : (data.manualCheck === true || data._transient === true ? '打开仓库' : '查看仓库');
          showRepositoryLink(data.releaseUrl, linkLabel);
        }
      } catch (e) {
        var errorMessage = e && e.message ? e.message : '检查失败';
        resultEl.textContent = '⚠ ' + errorMessage;
        if (isHttpUrl(fallbackReleaseUrl)) {
          resultEl.textContent += '，请手动查看更新：' + fallbackReleaseUrl;
          showRepositoryLink(fallbackReleaseUrl, '打开仓库');
        }
      } finally {
        btn.disabled = false;
        btn.textContent = old;
      }
    });
  }

  global.updateCheckerHtml = updateCheckerHtml;
  global.bindUpdateChecker = bindUpdateChecker;
})(typeof window !== 'undefined' ? window : globalThis);
