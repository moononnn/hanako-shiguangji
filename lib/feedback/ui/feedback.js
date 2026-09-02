// feedback · ui/feedback.js — 反馈小助手聊天窗（基础版）
// 用法（插件接入）：
//   1. 后端挂 2 个路由：
//      POST {apiBase}/chat       → fb.handleChat
//      POST {apiBase}/chat/close → fb.handleClose
//   2. 页面插入 feedbackHtml() 的返回值（本文件挂 window 全局，需随插件页面加载：
//      服务端渲染内联，或放插件 assets/ 走 Hana 官方资产 URL，不能用静态 import）
//   3. 页面加载后调 bindFeedback({ apiBase, apiFetch, onToast, openerId })
//      openerId 可传外部可见入口的 id；关闭弹窗后焦点会回到该入口。
// 后端接口约定：
//   POST {apiBase}/chat   body: { message, session_id } → { ok, session_id, reply, issue, env, prefillUrl }
//   POST {apiBase}/chat/close  body: { session_id } → { ok }
// apiFetch：可选。不传时组件自动使用可靠的 Hana 页面请求方式（闲不住等成熟插件验证）：
//   从服务端注入的 window.__TOKEN（或 URL 的 ?token=）取凭证，手动拼「插件前缀 + 相对路径 + ?token=」。
//   不要依赖 window.hana.api.fetch——插件 iframe 里它不可靠，裸 fetch 又会丢 token 导致 403。
//   接入方有特殊封装时可显式注入。
// ⚠️ 前端路由不带斜杠前缀：apiBase 传 "api/feedback"（后端注册的是 "/api/feedback/..."）
// 注意：renderEnvText 与 core/env.js 同步；renderBodyText 与 core/issue.js 的 renderIssueText 同步，改动需两边同步

(function (global) {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // 环境信息渲染（与后端 renderEnvText 同款，前端复制文案用）
  function renderEnvText(env) {
    if (!env) return '';
    var lines = ['【环境信息】（自动收集）'];
    lines.push('- 插件：' + (env.pluginName || '未知') + ' v' + (env.pluginVersion || '未知'));
    lines.push('- Hana 版本：' + (env.hanaVersion || '未知'));
    lines.push('- 系统：' + (env.os || '未知'));
    if (env.modelSource) lines.push('- 模型档位：' + env.modelSource);
    return lines.join('\n');
  }

  // issue 文案渲染（与后端 renderIssueText 同款）
  function renderBodyText(issue, env) {
    if (!issue) return '';
    var parts = [];
    if (issue.description) parts.push('## 描述\n' + issue.description);
    if (issue.steps && issue.steps.length) {
      parts.push('## 复现步骤\n' + issue.steps.map(function (s, i) { return (i + 1) + '. ' + s; }).join('\n'));
    }
    if (issue.expected) parts.push('## 期望行为\n' + issue.expected);
    if (issue.actual) parts.push('## 实际表现\n' + issue.actual);
    var envText = renderEnvText(env);
    if (envText) parts.push('## 环境信息\n' + envText);
    return parts.join('\n\n');
  }

  function issuePreviewHtml(issue, env) {
    if (!issue) return '';
    var html = '<div class="fb-preview-title">Issue 草稿（确认无误再提交）</div>';
    html += '<div class="fb-preview-item"><b>标题：</b>' + esc(issue.title || '（无）') + '</div>';
    if (issue.description) html += '<div class="fb-preview-item"><b>描述：</b>' + esc(issue.description) + '</div>';
    if (issue.steps && issue.steps.length) {
      html += '<div class="fb-preview-item"><b>复现步骤：</b><ol>' + issue.steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol></div>';
    }
    if (issue.expected) html += '<div class="fb-preview-item"><b>期望：</b>' + esc(issue.expected) + '</div>';
    if (issue.actual) html += '<div class="fb-preview-item"><b>实际：</b>' + esc(issue.actual) + '</div>';
    var envText = renderEnvText(env);
    if (envText) html += '<details class="fb-preview-env"><summary>环境信息</summary><pre>' + esc(envText) + '</pre></details>';
    return html;
  }

  function feedbackHtml() {
    return ''
      + '<button type="button" class="fb-open-btn" id="fb-open-btn">反馈</button>'
      + '<div class="fb-modal" id="fb-modal" hidden role="dialog" aria-modal="true" aria-labelledby="fb-modal-title">'
      +   '<div class="fb-modal-mask" data-fb-close></div>'
      +   '<div class="fb-modal-panel">'
      +     '<div class="fb-modal-head">'
      +       '<div class="fb-modal-titles"><span class="fb-modal-title" id="fb-modal-title">反馈小助手</span><span class="fb-modal-sub">想说啥用大白话讲，它帮你整理成规范反馈</span></div>'
      +       '<button type="button" class="fb-modal-close" data-fb-close aria-label="关闭反馈窗口">×</button>'
      +     '</div>'
      +     '<div class="fb-messages" id="fb-messages"></div>'
      +     '<div class="fb-issue-preview" id="fb-issue-preview" hidden></div>'
      +     '<div class="fb-input-row">'
      +       '<textarea id="fb-input" placeholder="比如：更新完设置就打不开了…" rows="2"></textarea>'
      +       '<button type="button" class="fb-send-btn" id="fb-send-btn">发送</button>'
      +     '</div>'
      +     '<div class="fb-actions" id="fb-actions" hidden>'
      +       '<a class="fb-btn fb-btn-primary" id="fb-submit-link" target="_blank" rel="noopener" hidden>生成提交页</a>'
      +       '<button type="button" class="fb-btn" id="fb-copy-btn">复制文案</button>'
      +       '<span class="fb-actions-hint" id="fb-actions-hint">检查整理好的内容后再提交</span>'
      +     '</div>'
      +   '</div>'
      + '</div>';
  }

  function bindFeedback(opts) {
    if (!opts || !opts.apiBase) throw new Error('feedback ui: apiBase 必填');
    var apiBase = opts.apiBase.replace(/\/+$/, '');
    var onToast = opts.onToast || function (msg) { alert(msg); };
    var openerEl = document.getElementById(opts.openerId || 'fb-open-btn');
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

    var modal = document.getElementById('fb-modal');
    var messagesEl = document.getElementById('fb-messages');
    var previewEl = document.getElementById('fb-issue-preview');
    var actionsEl = document.getElementById('fb-actions');
    var inputEl = document.getElementById('fb-input');
    var sendBtn = document.getElementById('fb-send-btn');
    if (!modal || !messagesEl) return;

    var sessionId = null;
    var lastIssue = null;
    var lastEnv = null;

    function toast(msg, isError) {
      onToast((isError ? '⚠ ' : '') + msg, isError);
    }

    function bubble(role, text) {
      var div = document.createElement('div');
      div.className = 'fb-bubble fb-bubble-' + role;
      div.textContent = text;
      messagesEl.appendChild(div);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      return div;
    }

    function showPreview(issue, env, prefillUrl) {
      lastIssue = issue;
      lastEnv = env;
      previewEl.innerHTML = issuePreviewHtml(issue, env);
      previewEl.hidden = false;
      actionsEl.hidden = false;
      // 提交页用 <a> 链接（webview 里 window.open 常被拦，target=_blank 链接实测可用）
      var linkEl = document.getElementById('fb-submit-link');
      if (linkEl) {
        if (prefillUrl) { linkEl.href = prefillUrl; linkEl.hidden = false; }
        else { linkEl.removeAttribute('href'); linkEl.hidden = true; }
      }
      var hintEl = document.getElementById('fb-actions-hint');
      if (hintEl) hintEl.textContent = prefillUrl
        ? '提交页打开后内容已填好，检查一下再提交'
        : '当前还未配置公开仓库，可以复制文案后手动提交';
      actionsEl.scrollIntoView({ block: 'nearest' });
    }

    function resetChat() {
      sessionId = null;
      lastIssue = null;
      lastEnv = null;
      messagesEl.innerHTML = '<div class="fb-welcome">告诉我遇到了什么问题，或者想要什么新功能。\n不清楚的地方它会问你。</div>';
      previewEl.hidden = true;
      actionsEl.hidden = true;
    }

    async function send() {
      var msg = inputEl.value.trim();
      if (!msg) return;
      inputEl.value = '';
      bubble('user', msg);
      sendBtn.disabled = true;
      sendBtn.textContent = '思考中…';
      var thinking = bubble('thinking', '正在整理…');
      try {
        var resp = await apiFetch(apiBase + '/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: msg, session_id: sessionId }),
          signal: AbortSignal.timeout(40000),
        });
        var data = await resp.json();
        thinking.remove();
        if (!data.ok) throw new Error(data.error || '出错了');
        sessionId = data.session_id;
        if (data.reply) bubble('assistant', data.reply);
        if (data.issue) showPreview(data.issue, data.env, data.prefillUrl || '');
      } catch (e) {
        thinking.remove();
        bubble('error', '⚠ ' + e.message);
      } finally {
        sendBtn.disabled = false;
        sendBtn.textContent = '发送';
        inputEl.focus();
      }
    }

    // 事件绑定（事件委托）
    modal.addEventListener('click', function (e) {
      var t = e.target;
      if (t.closest && t.closest('[data-fb-close]')) { close(); return; }
      if (t.id === 'fb-send-btn') { send(); return; }
      if (t.id === 'fb-copy-btn') {
        var bodyText = renderBodyText(lastIssue, lastEnv);
        if (!bodyText) { toast('还没有可复制的内容'); return; }
        try {
          navigator.clipboard.writeText(bodyText).then(function () {
            toast('已复制，打开 GitHub Issues 粘贴即可');
          }, function () {
            toast('复制失败，请手动选择复制', true);
          });
        } catch (err) {
          toast('复制失败：' + err.message, true);
        }
        return;
      }
    });

    inputEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !modal.hidden) close();
    });

    function open() {
      resetChat();
      modal.hidden = false;
      if (openerEl) openerEl.setAttribute('aria-expanded', 'true');
      setTimeout(function () { inputEl.focus(); }, 80);
    }

    function close() {
      modal.hidden = true;
      if (openerEl) openerEl.setAttribute('aria-expanded', 'false');
      if (sessionId) {
        apiFetch(apiBase + '/chat/close', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: sessionId }),
        }).catch(function () {});
        sessionId = null;
      }
      if (openerEl && typeof openerEl.focus === 'function') openerEl.focus();
    }

    var openBtn = document.getElementById('fb-open-btn');
    if (openBtn) openBtn.addEventListener('click', open);
  }

  global.feedbackHtml = feedbackHtml;
  global.bindFeedback = bindFeedback;
})(typeof window !== 'undefined' ? window : globalThis);
