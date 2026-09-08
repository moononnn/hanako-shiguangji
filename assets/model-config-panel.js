// model-config · ui/model-config-panel.js — 模型配置弹窗组件（基础版）
// 用法（插件接入）：
//   1. 后端挂积木的 4 个 handler（见 index.js 注释），得到 apiBase
//   2. 页面某处插入 modelConfigPanelHtml() 的返回值（一个「配置模型」按钮）
//      （本文件挂 window 全局，需随插件页面加载：服务端渲染内联，或放插件 assets/ 走 Hana 官方资产 URL，不能用静态 import）
//   3. 页面加载后调 bindModelConfigPanel({ apiBase, apiFetch, onToast })
// 组件只做事件绑定与渲染，样式在 model-config-panel.css（插件自行引入或内联）
// apiFetch：可选。不传时组件自动使用可靠的 Hana 页面请求方式（闲不住等成熟插件验证）：
//   从服务端注入的 window.__TOKEN（或 URL 的 ?token=）取凭证，手动拼「插件前缀 + 相对路径 + ?token=」。
//   不要依赖 window.hana.api.fetch——插件 iframe 里它不可靠，裸 fetch 又会丢 token 导致 403。
//   接入方有特殊封装时可显式注入。
// ⚠️ 前端路由不带斜杠前缀：apiBase 传 "api/model-config"（后端注册的是 "/api/model-config"）
// 后端接口约定：
//   GET  {apiBase}              → { ok, config }（config 已脱敏）
//   POST {apiBase}              → body: patch → { ok, config }
//   POST {apiBase}/test         → body: { source } → { ok, note } | { ok: false, error }
//   GET  {apiBase}/hana-models  → { ok, models: [{ providerId, providerName, baseUrl, api, models: [{ modelId, name }] }] }

(function (global) {
  'use strict';

  var SOURCES = [
    { id: 'agent',  name: '跟随伙伴', desc: '使用 Hana 工具模型；工具模型留空时回落伙伴主对话模型' },
    { id: 'hana',   name: '从 Hana 模型列表选择', desc: '自动拉取已配置模型，按 Hana 凭据直连所选模型' },
    { id: 'custom', name: '自定义 API', desc: '地址、Key、模型名自己填，适合有自己渠道的用户' },
  ];

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // 返回「配置模型」按钮 + 弹窗的 HTML 片段（插件把它挂到页面里）
  function modelConfigPanelHtml() {
    var radioHtml = SOURCES.map(function (s) {
      return '<label class="mc-source-option" data-source="' + s.id + '">'
        + '<input type="radio" name="mc-source" value="' + s.id + '" hidden>'
        + '<span class="mc-source-name">' + esc(s.name) + '</span>'
        + '<span class="mc-source-desc">' + esc(s.desc) + '</span>'
        + '</label>';
    }).join('');

    return ''
      + '<button type="button" class="mc-open-btn" id="mc-open-btn">配置模型</button>'
      + '<div class="mc-modal" id="mc-modal" hidden>'
      +   '<div class="mc-modal-mask" data-mc-close></div>'
      +   '<div class="mc-modal-panel">'
      +     '<div class="mc-modal-head">'
      +       '<span class="mc-modal-title">模型配置</span>'
      +       '<button type="button" class="mc-modal-close" data-mc-close>×</button>'
      +     '</div>'
      +     '<div class="mc-modal-body">'
      +       '<div class="mc-current" id="mc-current">当前使用：加载中…</div>'
      +       '<div class="mc-source-list">' + radioHtml + '</div>'
      +       '<div class="mc-form" id="mc-form-agent">'
      +         '<p class="mc-hint">使用 Hana 的工具模型；工具模型留空时，才会回落到当前伙伴的主对话模型。</p>'
      +       '</div>'
      +       '<div class="mc-form" id="mc-form-hana" hidden>'
      +         '<label class="mc-field">供应商'
      +           '<select id="mc-provider"><option value="">请选择</option></select>'
      +         '</label>'
      +         '<label class="mc-field">模型'
      +           '<select id="mc-model"><option value="">请选择</option></select>'
      +         '</label>'
      +         '<p class="mc-hint">从 Hana 已配置的模型里选择。插件会读取该供应商的运行时凭据并直连所选模型，不需要另填 Key。列表里没有的供应商，可改用“自定义 API”。</p>'
      +         '<p class="mc-hint" id="mc-hana-import-detail">选好模型后会显示当前选择。</p>'
      +       '</div>'
      +       '<div class="mc-form" id="mc-form-custom" hidden>'
      +         '<label class="mc-field">API 地址'
      +           '<input type="text" id="mc-custom-url" placeholder="https://api.example.com/v1">'
      +         '</label>'
      +         '<label class="mc-field">API Key'
      +           '<div class="mc-key-control">'
      +             '<input type="password" id="mc-custom-key" placeholder="留空表示不修改" autocomplete="off" spellcheck="false">'
      +             '<button type="button" class="mc-key-toggle" id="mc-custom-key-toggle" aria-controls="mc-custom-key" aria-pressed="false">显示</button>'
      +           '</div>'
      +         '</label>'
      +         '<label class="mc-field">模型名'
      +           '<input type="text" id="mc-custom-model" placeholder="如 gpt-4o-mini">'
      +         '</label>'
      +         '<label class="mc-field">接口格式'
      +           '<select id="mc-custom-api">'
      +             '<option value="openai-completions">OpenAI 兼容（chat/completions）</option>'
      +             '<option value="openai-responses">OpenAI 新版（responses）</option>'
      +             '<option value="anthropic-messages">Anthropic 格式</option>'
      +           '</select>'
      +         '</label>'
      +         '<p class="mc-hint">已预置 OpenAI / Anthropic / DeepSeek / Kimi / 智谱 / MiniMax / 火山 / 百炼 / 硅基流动等常见服务域名；名单外的域名可在插件 manifest.json 的 network.allowedHosts 里添加后重启 HanaAgent 生效。</p>'
      +         '<p class="mc-hint" id="mc-custom-key-hint"></p>'
      +         '<button type="button" class="mc-link-btn" id="mc-clear-key-btn" hidden>清除已存 Key</button>'
      +       '</div>'
      +     '</div>'
      +     '<div class="mc-modal-foot">'
      +       '<button type="button" class="mc-btn mc-btn-test" id="mc-test-btn">测试一下</button>'
      +       '<span class="mc-test-result" id="mc-test-result"></span>'
      +       '<span class="mc-foot-spacer"></span>'
      +       '<button type="button" class="mc-btn mc-btn-save" id="mc-save-btn">保存</button>'
      +     '</div>'
      +   '</div>'
      + '</div>';
  }

  // 绑定事件。opts: { apiBase, onToast }
  function bindModelConfigPanel(opts) {
    if (!opts || !opts.apiBase) throw new Error('model-config ui: apiBase 必填');
    var apiBase = opts.apiBase.replace(/\/+$/, '');
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
    var onSaved = typeof opts.onSaved === 'function' ? opts.onSaved : null; // 保存成功回调（config 已脱敏）

    var modal = document.getElementById('mc-modal');
    if (!modal) return;

    var state = { source: 'agent', hanaModels: [], config: null };
    var pendingHanaEcho = null; // 回显竞态：配置先回来、模型列表后到时暂存待回显值
    // 请求序号分两个独立计数器：读配置和拉模型列表并发执行，共用计数器会让先发请求的响应被后发请求的序号淘汰
    var configSeq = 0;  // 配置请求序号（快速开关弹窗时丢弃过期响应）
    var modelsSeq = 0;  // 模型列表请求序号

    function toast(msg, isError) {
      onToast((isError ? '⚠ ' : '') + msg, isError);
    }

    // 兼容两种返回：hana.api.fetch 可能返回标准 Response（有 .json），也可能直接返回解析好的对象
    function parseResp(value) {
      return value && typeof value.json === 'function' ? value.json() : Promise.resolve(value);
    }

    function setSource(source) {
      state.source = source;
      resetKeyVisibility();
      var radios = document.querySelectorAll('input[name="mc-source"]');
      for (var i = 0; i < radios.length; i++) radios[i].checked = (radios[i].value === source);
      var optsList = document.querySelectorAll('.mc-source-option');
      for (var j = 0; j < optsList.length; j++) {
        optsList[j].classList.toggle('active', optsList[j].getAttribute('data-source') === source);
      }
      document.getElementById('mc-form-agent').hidden = source !== 'agent';
      document.getElementById('mc-form-hana').hidden = source !== 'hana';
      document.getElementById('mc-form-custom').hidden = source !== 'custom';
      document.getElementById('mc-test-result').textContent = '';
    }

    function resetKeyVisibility() {
      ['mc-custom-key'].forEach(function (id) {
        var input = document.getElementById(id);
        var button = document.getElementById(id + '-toggle');
        if (input) input.type = 'password';
        if (button) {
          button.textContent = '显示';
          button.setAttribute('aria-pressed', 'false');
        }
      });
    }

    function toggleKeyVisibility(inputId, buttonId) {
      var input = document.getElementById(inputId);
      var button = document.getElementById(buttonId);
      if (!input || !button) return;
      var visible = input.type === 'password';
      input.type = visible ? 'text' : 'password';
      button.textContent = visible ? '隐藏' : '显示';
      button.setAttribute('aria-pressed', String(visible));
    }

    function renderConfig(cfg) {
      state.config = cfg;
      pendingHanaEcho = null; // 先清残留：本次不是 hana 档就不会带回显旧值
      setSource(cfg.source || 'agent');
      // 当前使用状态行（重启后也能一眼看出选的是哪档）
      var curEl = document.getElementById('mc-current');
      if (curEl) {
        var label = '跟随伙伴';
        if (cfg.source === 'hana') {
          label = 'Hana · ' + (cfg.hanaModel && cfg.hanaModel.providerId ? cfg.hanaModel.providerId : '未选');
          if (cfg.hanaModel && cfg.hanaModel.modelId) label += ' / ' + cfg.hanaModel.modelId;
        } else if (cfg.source === 'custom') {
          label = '自定义 API · ' + ((cfg.customModel && cfg.customModel.model) || '未填写模型');
        }
        curEl.textContent = '当前使用：' + label;
      }
      // hana 档：只回显已选 provider/model，凭据不进入页面。
      if (cfg.hanaModel && cfg.hanaModel.providerId) {
        pendingHanaEcho = { providerId: cfg.hanaModel.providerId, modelId: cfg.hanaModel.modelId };
        var sel = document.getElementById('mc-provider');
        sel.value = cfg.hanaModel.providerId;
        fillModels(cfg.hanaModel.providerId, cfg.hanaModel.modelId);
      }
      // custom 档：回显（Key 只显示掩码提示）
      if (cfg.customModel) {
        document.getElementById('mc-custom-url').value = cfg.customModel.baseUrl || '';
        document.getElementById('mc-custom-key').value = '';
        document.getElementById('mc-custom-model').value = cfg.customModel.model || '';
        document.getElementById('mc-custom-api').value = cfg.customModel.api || 'openai-completions';
        var hint = document.getElementById('mc-custom-key-hint');
        var mode = cfg.customModel.storageMode || 'none';
        if (cfg.customModel.apiKeyMask) {
          if (mode === 'plain') {
            hint.textContent = '已保存的 Key：' + cfg.customModel.apiKeyMask + '（当前以明文保存在本机；Windows 下会自动转为系统加密）';
          } else if (mode === 'dpapi') {
            hint.textContent = '已保存的 Key：' + cfg.customModel.apiKeyMask + '（系统加密保护，留空不修改）';
          } else {
            hint.textContent = '已保存的 Key：' + cfg.customModel.apiKeyMask + '（留空不修改）';
          }
        } else {
          hint.textContent = '还没配置 Key';
        }
        var clearBtn = document.getElementById('mc-clear-key-btn');
        if (clearBtn) clearBtn.hidden = !cfg.customModel.apiKeyMask;
      }
    }

    function fillProviders() {
      var sel = document.getElementById('mc-provider');
      var cur = sel.value;
      sel.innerHTML = '<option value="">请选择</option>' + state.hanaModels.map(function (p) {
        var pid = p.providerId || p.provider || '';
        return '<option value="' + esc(pid) + '">' + esc(p.providerName || pid) + '</option>';
      }).join('');
      if (cur) sel.value = cur;
    }

    function selectedHanaProvider() {
      var providerId = document.getElementById('mc-provider').value;
      return state.hanaModels.find(function (p) {
        return (p.providerId || p.provider) === providerId;
      }) || null;
    }

    function updateHanaImportDetail() {
      var detail = document.getElementById('mc-hana-import-detail');
      var provider = selectedHanaProvider();
      var modelId = document.getElementById('mc-model').value;
      if (detail) detail.textContent = provider && modelId
        ? '已选择“' + (provider.providerName || provider.providerId) + '”的模型“' + modelId + '”，测试或保存后会按 Hana 运行时配置直连。'
        : '选好模型后会显示当前选择。';
    }

    function fillModels(providerId, selectedModel) {
      var sel = document.getElementById('mc-model');
      var provider = selectedHanaProvider();
      var list = provider && Array.isArray(provider.models) ? provider.models : [];
      sel.innerHTML = '<option value="">请选择</option>' + list.map(function (m) {
        var mid = m.modelId || m.model || m.id || '';
        return '<option value="' + esc(mid) + '">' + esc(m.label || m.name || mid) + '</option>';
      }).join('');
      if (selectedModel) sel.value = selectedModel;
      updateHanaImportDetail();
    }

    async function loadConfig() {
      var seq = ++configSeq;
      try {
        var resp = await apiFetch(apiBase, { signal: AbortSignal.timeout(10000) });
        var data = await parseResp(resp);
        if (seq !== configSeq) return; // 过期响应丢弃
        if (!data.ok) throw new Error(data.error || '读取配置失败');
        renderConfig(data.config);
      } catch (e) {
        if (seq !== configSeq) return;
        var curFail = document.getElementById('mc-current');
        if (curFail) curFail.textContent = '当前使用：读取失败';
        toast('读取配置失败：' + e.message, true);
      }
    }

    async function loadHanaModels() {
      var seq = ++modelsSeq;
      try {
        var resp = await apiFetch(apiBase + '/hana-models', { signal: AbortSignal.timeout(10000) });
        var data = await parseResp(resp);
        if (seq !== modelsSeq) return; // 过期响应丢弃
        if (data.ok && Array.isArray(data.models)) {
          state.hanaModels = data.models;
          fillProviders();
          // 列表到齐后重放暂存的回显（修复配置先返回导致的"请选择"假象）
          if (pendingHanaEcho) {
            document.getElementById('mc-provider').value = pendingHanaEcho.providerId;
            fillModels(pendingHanaEcho.providerId, pendingHanaEcho.modelId);
            pendingHanaEcho = null;
          }
        }
      } catch (e) {
        if (seq !== modelsSeq) return;
        toast('拉取模型列表失败：' + e.message, true);
      }
    }

    function collectPatch() {
      var patch = { source: state.source };
      if (state.source === 'hana') {
        patch.hanaModel = {
          providerId: document.getElementById('mc-provider').value,
          modelId: document.getElementById('mc-model').value,
        };
      } else if (state.source === 'custom') {
        patch.customModel = {
          baseUrl: document.getElementById('mc-custom-url').value.trim(),
          apiKey: document.getElementById('mc-custom-key').value,
          model: document.getElementById('mc-custom-model').value.trim(),
          api: document.getElementById('mc-custom-api').value,
        };
      }
      return patch;
    }

    async function save() {
      var patch = collectPatch();
      try {
        var resp = await apiFetch(apiBase, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
          signal: AbortSignal.timeout(10000),
        });
        var data = await parseResp(resp);
        if (!data.ok) throw new Error(data.error || '保存失败');
        renderConfig(data.config);
        toast('保存成功！'); // 气泡提醒，不关闭弹窗
        if (onSaved) onSaved(data.config);
      } catch (e) {
        toast('保存失败：' + e.message, true);
      }
    }

    async function test() {
      var btn = document.getElementById('mc-test-btn');
      btn.disabled = true;
      var old = btn.textContent;
      btn.textContent = '测试中…';
      var resultEl = document.getElementById('mc-test-result');
      resultEl.textContent = '';
      try {
        // 带上当前表单值：测的是"想保存的配置"而不是旧配置（不落盘）
        var resp = await apiFetch(apiBase + '/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source: state.source, patch: collectPatch() }),
          signal: AbortSignal.timeout(25000),
        });
        var data = await parseResp(resp);
        if (!data.ok) throw new Error(data.error || '连通失败');
        resultEl.textContent = data.note || '连通了';
      } catch (e) {
        resultEl.textContent = '⚠ ' + e.message;
      } finally {
        btn.disabled = false;
        btn.textContent = old;
      }
    }

    function saveWithClearKey() {
      // 明确清除自定义 API 的 Key（与留空不覆盖区分）
      var patch = collectPatch();
      if (!patch.customModel) patch.customModel = {};
      patch.customModel.clearApiKey = true;
      apiFetch(apiBase, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
        signal: AbortSignal.timeout(10000),
      }).then(function (resp) { return parseResp(resp); }).then(function (data) {
        if (!data.ok) throw new Error(data.error || '清除失败');
        renderConfig(data.config);
        toast('已清除 Key');
      }).catch(function (e) {
        toast('清除失败：' + e.message, true);
      });
    }

    function open() {
      modal.hidden = false;
      loadConfig();
      loadHanaModels();
    }

    function close() {
      modal.hidden = true;
    }

    // 事件绑定（事件委托，兼容 webview）
    modal.addEventListener('click', function (e) {
      var t = e.target;
      if (t.closest && t.closest('[data-mc-close]')) { close(); return; }
      if (t.id === 'mc-save-btn') { save(); return; }
      if (t.id === 'mc-test-btn') { test(); return; }
      if (t.id === 'mc-custom-key-toggle') { toggleKeyVisibility('mc-custom-key', 'mc-custom-key-toggle'); return; }
      if (t.id === 'mc-clear-key-btn') {
        saveWithClearKey();
        return;
      }
      var opt = t.closest ? t.closest('.mc-source-option') : null;
      if (opt) { setSource(opt.getAttribute('data-source')); return; }
    });
    document.getElementById('mc-provider').addEventListener('change', function () {
      fillModels(this.value, '');
    });
    document.getElementById('mc-model').addEventListener('change', updateHanaImportDetail);
    document.getElementById('mc-open-btn').addEventListener('click', open);
  }

  global.modelConfigPanelHtml = modelConfigPanelHtml;
  global.bindModelConfigPanel = bindModelConfigPanel;
})(typeof window !== 'undefined' ? window : globalThis);
