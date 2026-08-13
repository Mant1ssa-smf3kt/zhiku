'use strict';

/* ================= 工具函数 ================= */

const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtSize(n) {
  if (n == null) return '-';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function fmtTime(ts) {
  if (!ts) return '-';
  const d = new Date(ts * 1000);
  const now = new Date();
  const pad = x => String(x).padStart(2, '0');
  const hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
  if (d.toDateString() === now.toDateString()) return '今天 ' + hm;
  return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm;
}

function toast(msg, type) {
  const el = document.createElement('div');
  el.className = 'toast ' + (type === 'err' ? 'err' : 'ok');
  el.textContent = msg;
  $('#toastRoot').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, 3600);
  setTimeout(() => el.remove(), 4000);
}

function setBootText(t) {
  const el = $('#bootSplashText');
  if (el) el.textContent = t || '';
}

function hideBootSplash() {
  const el = $('#bootSplash');
  if (!el || el.classList.contains('hide')) return;
  el.classList.add('hide');
  setTimeout(() => { try { el.remove(); } catch (e) { /* ignore */ } }, 320);
}

/** 按需加载 vis-network：不阻塞首屏；失败可重试 */
let _visLoadPromise = null;
function ensureVisNetwork() {
  if (typeof vis !== 'undefined' && vis.Network) return Promise.resolve(vis);
  if (_visLoadPromise) return _visLoadPromise;
  _visLoadPromise = new Promise((resolve, reject) => {
    const urls = [
      'https://unpkg.com/vis-network@9.1.9/standalone/umd/vis-network.min.js',
      'https://cdn.jsdelivr.net/npm/vis-network@9.1.9/standalone/umd/vis-network.min.js',
    ];
    let i = 0;
    const tryNext = () => {
      if (typeof vis !== 'undefined' && vis.Network) {
        resolve(vis);
        return;
      }
      if (i >= urls.length) {
        _visLoadPromise = null;
        reject(new Error('图谱库加载失败（请检查网络后点刷新）'));
        return;
      }
      const url = urls[i++];
      const s = document.createElement('script');
      s.src = url;
      s.async = true;
      s.onload = () => {
        if (typeof vis !== 'undefined' && vis.Network) resolve(vis);
        else tryNext();
      };
      s.onerror = () => tryNext();
      document.head.appendChild(s);
    };
    tryNext();
  });
  return _visLoadPromise;
}

function progressBarHtml(pct, label) {
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  return '<div class="gprog">' +
    '<div class="gprog-track"><div class="gprog-fill" style="width:' + p.toFixed(1) + '%"></div></div>' +
    (label != null ? '<div class="gprog-label">' + esc(String(label)) + '</div>' : '') +
    '</div>';
}

async function api(path, opts) {
  opts = opts || {};
  const init = { method: opts.method || 'GET' };
  if (opts.body instanceof FormData) {
    init.body = opts.body;
  } else if (opts.body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(opts.body);
  }
  const res = await fetch('/api' + path, init);
  if (!res.ok) {
    let msg = '请求失败 (' + res.status + ')';
    try {
      const d = await res.json();
      if (d.detail) msg = typeof d.detail === 'string' ? d.detail : JSON.stringify(d.detail);
    } catch (e) { /* ignore */ }
    throw new Error(msg);
  }
  return res.json();
}

/* ---------- Markdown 渲染（输入先整体转义，再做结构转换） ---------- */

function mdInline(s) {
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return s;
}

function md(src) {
  if (!src) return '';
  const codes = [];
  // 围栏必须位于行首，避免行内出现 ``` 时吞掉后续全部内容
  let text = esc(src).replace(/(^|\n)```[^\n]*\n([\s\S]*?)(?:\n```(?=\s*(?:\n|$))|$)/g, (m, pre, body) => {
    codes.push(body.replace(/\n$/, ''));
    return pre + '\x00' + (codes.length - 1) + '\x00';
  });

  const lines = text.split('\n');
  const out = [];
  let para = [], list = null, table = [];

  const flushPara = () => {
    if (para.length) { out.push('<p>' + mdInline(para.join('<br>')) + '</p>'); para = []; }
  };
  const flushList = () => {
    if (list) {
      out.push('<' + list.type + '>' +
        list.items.map(i => '<li>' + mdInline(i) + '</li>').join('') +
        '</' + list.type + '>');
      list = null;
    }
  };
  const flushTable = () => {
    if (!table.length) return;
    const rows = table.map(r =>
      r.replace(/^\||\|$/g, '').split('|').map(c => c.trim()));
    let html = '<table>';
    rows.forEach((cells, ri) => {
      if (cells.every(c => /^:?-{2,}:?$/.test(c))) return; // 分隔行
      const tag = ri === 0 ? 'th' : 'td';
      html += '<tr>' + cells.map(c => '<' + tag + '>' + mdInline(c) + '</' + tag + '>').join('') + '</tr>';
    });
    out.push(html + '</table>');
    table = [];
  };

  for (const raw of lines) {
    const t = raw.trim();
    const codeM = t.match(/^\x00(\d+)\x00$/);
    if (codeM) { flushPara(); flushList(); flushTable(); out.push('<pre><code>' + codes[+codeM[1]] + '</code></pre>'); continue; }
    if (!t) { flushPara(); flushList(); flushTable(); continue; }
    if (t.startsWith('|')) { flushPara(); flushList(); table.push(t); continue; }
    flushTable();
    const h = t.match(/^(#{1,4})\s+(.*)$/);
    if (h) { flushPara(); flushList(); const n = h[1].length; out.push('<h' + n + '>' + mdInline(h[2]) + '</h' + n + '>'); continue; }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { flushPara(); flushList(); out.push('<hr>'); continue; }
    const ul = t.match(/^[-*+•]\s+(.*)$/);
    // 「.」「)」后必须有空白，避免「3.14 是圆周率」这类行首小数被吞成列表
    const ol = t.match(/^\d{1,3}(?:[.)]\s+|、\s*)(.+)$/);
    if (ul || ol) {
      flushPara();
      const ty = ul ? 'ul' : 'ol';
      if (!list || list.type !== ty) { flushList(); list = { type: ty, items: [] }; }
      list.items.push((ul || ol)[1]);
      continue;
    }
    if (t.startsWith('&gt;')) {
      flushPara(); flushList();
      out.push('<blockquote>' + mdInline(t.replace(/^&gt;\s?/, '')) + '</blockquote>');
      continue;
    }
    flushList();
    para.push(t);
  }
  flushPara(); flushList(); flushTable();
  return out.join('');
}

/* ---------- 弹窗 ---------- */

function openModal(html, onDismiss) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = '<div class="modal">' + html + '</div>';
  $('#modalRoot').appendChild(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener('mousedown', e => {
    if (e.target === overlay) { close(); if (onDismiss) onDismiss(); }
  });
  return { overlay, close };
}

function confirmModal(opts) {
  return new Promise(resolve => {
    const m = openModal(
      '<h2>' + esc(opts.title || '确认操作') + '</h2>' +
      '<p style="color:var(--muted);font-size:13.5px">' + (opts.html || esc(opts.text || '')) + '</p>' +
      '<div class="modal-actions">' +
      '<button class="btn" data-act="cancel">取消</button>' +
      '<button class="btn ' + (opts.danger ? 'btn-danger' : 'btn-primary') + '" data-act="ok">' +
      esc(opts.okText || '确定') + '</button></div>',
      () => resolve(false)  // 点遮罩关闭等价于取消，避免 Promise 永久挂起
    );
    $('[data-act=cancel]', m.overlay).onclick = () => { m.close(); resolve(false); };
    $('[data-act=ok]', m.overlay).onclick = () => { m.close(); resolve(true); };
  });
}

/* ================= 全局状态 ================= */

const LOCAL_EMBED_MODEL = 'BAAI/bge-small-zh-v1.5';
const EMOJIS = ['Aa', 'Nb', 'En', 'Hs', 'Cs', 'Py', 'Js', 'Ai', 'Ml', 'Db', 'Net', 'Law', 'Med', 'Art', 'Math', 'Geo'];
const COLORS = ['#131810', '#3d3a30', '#6a4a32', '#8a3a28', '#2c5a38', '#2a3f5c', '#5a3a52', '#7a5a20'];

const state = {
  providers: [],
  settings: {},
  subjects: [],
  view: { type: 'home' },      // {type:'home'|'settings'|'subject', sid, tab}
  convs: [],
  convId: null,
  useRag: true,
  useGraph: true,
  topicFilter: '',
  graphLimit: 300,
  sending: false,
  modelCache: {},              // provider_id -> [model,...]
  graphNet: null,
  _graphRo: null,
  _graphPollTimer: null,
};
let docsPollTimer = null;

function subjectById(sid) { return state.subjects.find(s => s.id === sid); }
function providerById(pid) { return state.providers.find(p => p.id === pid); }

/** 科目标记：优先用用户设置的短标签，否则取名称首字 */
function subjectMark(s) {
  const icon = (s && s.icon || '').trim();
  // 仅接受短字母/数字/汉字标签；旧数据里的 emoji 会回退到科目首字
  if (icon && /^[A-Za-z0-9一-鿿]{1,3}$/.test(icon)) return icon;
  const name = (s && s.name || '').trim();
  return name ? name.slice(0, 1) : '知';
}

async function loadCore() {
  const [providers, settings, subjects] = await Promise.all([
    api('/providers'), api('/settings'), api('/subjects'),
  ]);
  state.providers = providers;
  state.settings = settings;
  state.subjects = subjects;
}

async function refreshSubjects() {
  state.subjects = await api('/subjects');
  renderSidebar();
}

/* ================= 导航 ================= */

function nav(view) {
  if (docsPollTimer) { clearInterval(docsPollTimer); docsPollTimer = null; }
  if (state._graphPollTimer) { clearInterval(state._graphPollTimer); state._graphPollTimer = null; }
  if (state.graphNet) {
    try { state.graphNet.destroy(); } catch (e) { /* ignore */ }
    state.graphNet = null;
  }
  if (state._graphRo) {
    try { state._graphRo.disconnect(); } catch (e) { /* ignore */ }
    state._graphRo = null;
  }
  state.view = view;
  renderSidebar();
  renderMain();
}

function renderSidebar() {
  const list = $('#subjectList');
  list.innerHTML = state.subjects.map(s => {
    const active = state.view.type === 'subject' && state.view.sid === s.id;
    const mark = subjectMark(s);
    return '<button class="subject-item' + (active ? ' active' : '') + '" data-sid="' + s.id + '">' +
      '<span class="subject-icon" style="background:' + esc(s.color || '#131810') + '">' + esc(mark) + '</span>' +
      '<span class="s-name">' + esc(s.name) + '</span>' +
      '<span class="s-count">' + s.doc_count + '</span></button>';
  }).join('') || '<div style="padding:10px;color:var(--muted);font-size:12.5px">还没有科目</div>';
  $$('.subject-item', list).forEach(el => {
    el.onclick = () => openSubject(el.dataset.sid);
  });
  $('#homeBtn').classList.toggle('active', state.view.type === 'home');
  $('#settingsBtn').classList.toggle('active', state.view.type === 'settings');
}

function openSubject(sid, tab) {
  const s = subjectById(sid);
  if (!s) return;
  if (!tab) tab = s.chunk_count > 0 ? 'chat' : 'docs';
  if (state.view.sid !== sid) { state.convId = null; }
  nav({ type: 'subject', sid, tab });
}

function renderMain() {
  const v = state.view;
  if (v.type === 'home') return renderHome();
  if (v.type === 'settings') return renderSettings();
  if (v.type === 'subject') return renderSubject();
}

/* ================= 首页 ================= */

function renderHome() {
  const totalDocs = state.subjects.reduce((a, s) => a + s.doc_count, 0);
  const st = state.settings;
  const setupDone = state.providers.length > 0 &&
    !!(st.default_embed_model && st.default_chat_model) &&
    state.subjects.length > 0 && totalDocs > 0;
  const steps = [
    {
      done: state.providers.length > 0,
      title: '接入模型服务',
      desc: '任意 OpenAI 兼容接口：DeepSeek、SiliconFlow、智谱、Ollama 均可',
      btn: '设置', act: () => nav({ type: 'settings' }),
    },
    {
      done: !!(st.default_embed_model && st.default_chat_model),
      title: '指定默认模型',
      desc: '向量模型负责入库，对话模型负责回答。科目里还能单独改',
      btn: '设置', act: () => nav({ type: 'settings' }),
    },
    {
      done: state.subjects.length > 0,
      title: '建一个科目',
      desc: '语文、高数、专业课——各自一套资料和对话',
      btn: '新建', act: newSubjectModal,
    },
    {
      done: totalDocs > 0,
      title: '放进资料',
      desc: 'PDF、PPT、Word、笔记拖进去，解析完就能问',
      btn: null,
    },
  ];

  const desk = state.subjects.length
    ? '<div class="desk-list">' +
      state.subjects.map(s =>
        '<button class="desk-item" data-desk="' + s.id + '">' +
        '<span class="desk-mark" style="background:' + esc(s.color || '#131810') + '">' + esc(subjectMark(s)) + '</span>' +
        '<span class="desk-body"><span class="desk-name">' + esc(s.name) + '</span>' +
        '<span class="desk-meta">' + s.doc_count + ' 份资料 · ' + s.chunk_count + ' 段</span></span>' +
        '<span class="desk-go">打开</span></button>'
      ).join('') +
      '</div>'
    : '<div class="empty-state">还没有科目。左边「＋ 科目」，或下面直接建一个。</div>';

  const setupHtml = setupDone ? '' :
    '<div class="card"><h3>还差几步</h3><div class="step-list">' +
    steps.map((s, i) =>
      '<div class="step-item' + (s.done ? ' done' : '') + '">' +
      '<div class="step-num">' + (s.done ? '—' : String(i + 1).padStart(2, '0')) + '</div>' +
      '<div class="step-body"><div class="step-title">' + s.title + '</div>' +
      '<div class="step-desc">' + s.desc + '</div></div>' +
      (s.btn && !s.done ? '<button class="btn btn-sm" data-step="' + i + '">' + s.btn + '</button>' : '') +
      '</div>'
    ).join('') +
    '</div></div>';

  $('#main').innerHTML = '<div class="page page-home">' +
    '<div class="mast">' +
    '<div class="mast-kicker">本机 · 不联网也能翻资料</div>' +
    '<div class="page-title">知库</div>' +
    '<div class="page-desc">按科目收资料，问的时候带回原文出处。数据只落在这台机器上。</div>' +
    '</div>' +
    desk + setupHtml + '</div>';

  $$('[data-desk]').forEach(el => {
    el.onclick = () => openSubject(el.dataset.desk);
  });
  steps.forEach((s, i) => {
    const btn = $('[data-step="' + i + '"]');
    if (btn) btn.onclick = s.act;
  });
}

/* ================= 全局设置 ================= */

async function fetchModels(pid, force) {
  if (!pid) return [];
  if (!force && state.modelCache[pid]) return state.modelCache[pid];
  const data = await api('/providers/' + pid + '/models');
  state.modelCache[pid] = data.models || [];
  return state.modelCache[pid];
}

function modelPickerHtml(prefix, providerId, model, allowDefault, allowLocal) {
  const isLocal = !!allowLocal && providerId === 'local';
  // 引用的服务商可能已被删除：视为未选择并清空模型，避免「看着已配置、实际不生效」
  const orphan = !!providerId && !isLocal && !state.providers.some(p => p.id === providerId);
  if (orphan) { providerId = ''; model = ''; }
  if (isLocal && !model) model = LOCAL_EMBED_MODEL;
  const provOpts =
    (allowDefault ? '<option value="">跟随全局默认</option>' : '<option value="">请选择服务商</option>') +
    (allowLocal ? '<option value="local"' + (isLocal ? ' selected' : '') + '>内置本地模型</option>' : '') +
    state.providers.map(p =>
      '<option value="' + esc(p.id) + '"' + (p.id === providerId ? ' selected' : '') + '>' +
      esc(p.name) + '</option>').join('');
  return '<div class="form-inline">' +
    '<select class="input" id="' + prefix + 'Provider" style="max-width:170px">' + provOpts + '</select>' +
    '<input class="input" id="' + prefix + 'Model" list="' + prefix + 'List" placeholder="模型名称，可点右侧获取" ' +
    'value="' + esc(model || '') + '"' + (providerId && !isLocal ? '' : ' disabled') + '>' +
    '<datalist id="' + prefix + 'List"></datalist>' +
    '<button class="btn btn-sm" id="' + prefix + 'Fetch" title="从服务商获取模型列表"' + (providerId && !isLocal ? '' : ' disabled') + '>获取列表</button>' +
    '<button class="btn btn-sm" id="' + prefix + 'Test"' + (providerId ? '' : ' disabled') + '>测试</button>' +
    '</div>' +
    (orphan ? '<div class="hint" style="color:var(--danger)">原服务商已被删除，请重新选择并保存</div>' : '');
}

function bindModelPicker(prefix, testType) {
  const provSel = $('#' + prefix + 'Provider');
  const modelInp = $('#' + prefix + 'Model');
  const fetchBtn = $('#' + prefix + 'Fetch');
  const testBtn = $('#' + prefix + 'Test');
  const dl = $('#' + prefix + 'List');
  const isLocal = () => provSel.value === 'local';

  const fillList = models => {
    dl.innerHTML = models.map(m => '<option value="' + esc(m) + '">').join('');
  };
  if (provSel.value && !isLocal() && state.modelCache[provSel.value]) {
    fillList(state.modelCache[provSel.value]);
  }

  provSel.onchange = () => {
    if (isLocal()) {
      modelInp.value = LOCAL_EMBED_MODEL;
      modelInp.disabled = true;
      fetchBtn.disabled = true;
      testBtn.disabled = false;
      dl.innerHTML = '';
      return;
    }
    const has = !!provSel.value;
    modelInp.disabled = !has;
    fetchBtn.disabled = !has;
    testBtn.disabled = !has;
    if (!has) modelInp.value = '';
    else if (modelInp.value === LOCAL_EMBED_MODEL) modelInp.value = '';
    dl.innerHTML = '';
    if (has && state.modelCache[provSel.value]) fillList(state.modelCache[provSel.value]);
  };
  fetchBtn.onclick = async () => {
    fetchBtn.disabled = true; fetchBtn.textContent = '获取中…';
    try {
      const models = await fetchModels(provSel.value, true);
      fillList(models);
      toast('获取到 ' + models.length + ' 个模型，点击输入框选择');
      modelInp.focus();
    } catch (e) { toast(e.message, 'err'); }
    fetchBtn.disabled = false; fetchBtn.textContent = '获取列表';
  };
  testBtn.onclick = async () => {
    if (isLocal()) {
      testBtn.disabled = true; testBtn.textContent = '加载中…';
      try {
        const r = await api('/local-embed/test', { method: 'POST' });
        toast(r.message, r.ok ? 'ok' : 'err');
      } catch (e) { toast(e.message, 'err'); }
      testBtn.disabled = false; testBtn.textContent = '测试';
      return;
    }
    if (!modelInp.value.trim()) { toast('请先填写模型名称', 'err'); return; }
    testBtn.disabled = true; testBtn.textContent = '测试中…';
    try {
      const r = await api('/providers/' + provSel.value + '/test', {
        method: 'POST', body: { type: testType, model: modelInp.value.trim() },
      });
      toast(r.message, r.ok ? 'ok' : 'err');
    } catch (e) { toast(e.message, 'err'); }
    testBtn.disabled = false; testBtn.textContent = '测试';
  };
}

function renderSettings() {
  const st = state.settings;
  $('#main').innerHTML = '<div class="page">' +
    '<div class="mast"><div class="mast-kicker">本机配置</div>' +
    '<div class="page-title">设置</div>' +
    '<div class="page-desc">服务商和默认模型。密钥只写进本机数据库，不上传。</div></div>' +
    '<div class="card"><h3>API 服务商</h3>' +
    '<div class="card-hint">支持任意 OpenAI 兼容接口。配置对话与向量模型后，点「启用」切换当前服务。</div>' +
    '<div id="providerList"></div>' +
    '<button class="btn btn-ghost" id="addProviderBtn" style="width:100%;justify-content:center">添加服务商</button>' +
    '</div>' +
    '<div class="card"><h3>默认模型</h3>' +
    '<div class="card-hint">通常通过服务商卡片「启用」即可。需要混合搭配（对话与向量不同服务）时再单独调整。</div>' +
    '<div class="form-row"><label>向量模型</label>' +
    modelPickerHtml('defEmbed', st.default_embed_provider_id, st.default_embed_model, false, true) +
    '<div class="hint">可选内置本地模型离线运行；或 text-embedding-3-small、BAAI/bge-m3 等</div></div>' +
    '<div class="form-row"><label>对话模型</label>' +
    modelPickerHtml('defChat', st.default_chat_provider_id, st.default_chat_model, false) +
    '<div class="hint">如 gpt-4o-mini、deepseek-chat、glm-4-flash</div></div>' +
    '<button class="btn btn-primary" id="saveSettingsBtn">保存</button>' +
    '</div>' +
    '<div class="card"><h3>知识图谱</h3>' +
    '<div class="card-hint">资料入库后自动抽取术语并构建共现图；失败不挡问答。</div>' +
    '<div class="form-row"><label class="check-row"><input type="checkbox" id="graphEnabled"' +
    ((st.graph_enabled === '0') ? '' : ' checked') +
    '> 启用图谱增强检索</label></div>' +
    '<div class="form-row"><label class="check-row"><input type="checkbox" id="graphLlmExtract"' +
    (st.graph_llm_extract === '1' ? ' checked' : '') +
    '> LLM 增强抽图（默认关）</label></div>' +
    '<button class="btn btn-primary" id="saveGraphSettingsBtn">保存图谱设置</button>' +
    '</div></div>';

  renderProviderList();
  $('#addProviderBtn').onclick = () => providerModal(null);
  bindModelPicker('defEmbed', 'embed');
  bindModelPicker('defChat', 'chat');
  $('#saveSettingsBtn').onclick = async () => {
    try {
      state.settings = await api('/settings', {
        method: 'PUT',
        body: {
          default_embed_provider_id: $('#defEmbedProvider').value,
          default_embed_model: $('#defEmbedModel').value.trim(),
          default_chat_provider_id: $('#defChatProvider').value,
          default_chat_model: $('#defChatModel').value.trim(),
        },
      });
      toast('默认模型已保存');
    } catch (e) { toast(e.message, 'err'); }
  };
  $('#saveGraphSettingsBtn').onclick = async () => {
    try {
      state.settings = await api('/settings', {
        method: 'PUT',
        body: {
          graph_enabled: $('#graphEnabled').checked ? '1' : '0',
          graph_llm_extract: $('#graphLlmExtract').checked ? '1' : '0',
        },
      });
      toast('图谱设置已保存');
    } catch (e) { toast(e.message, 'err'); }
  };
}

function providerActiveState(p) {
  const st = state.settings;
  const chatActive = !!p.chat_model &&
    st.default_chat_provider_id === p.id && st.default_chat_model === p.chat_model;
  const embedActive = !!p.embed_model &&
    st.default_embed_provider_id === p.id && st.default_embed_model === p.embed_model;
  const fullActive = (p.chat_model || p.embed_model) &&
    (!p.chat_model || chatActive) && (!p.embed_model || embedActive);
  return { chatActive, embedActive, fullActive };
}

function renderProviderList() {
  const box = $('#providerList');
  if (!box) return;
  box.innerHTML = state.providers.map(p => {
    const act = providerActiveState(p);
    const modelLine =
      '<div class="provider-models">' +
      (p.chat_model
        ? '<span class="model-chip' + (act.chatActive ? ' on' : '') + '">' + esc(p.chat_model) + '</span>'
        : '<span class="model-chip empty">未配置对话模型</span>') +
      (p.embed_model
        ? '<span class="model-chip' + (act.embedActive ? ' on' : '') + '">' + esc(p.embed_model) + '</span>'
        : '<span class="model-chip empty">未配置向量模型</span>') +
      '</div>';
    return '<div class="provider-card' + (act.fullActive ? ' active' : '') + '">' +
      '<div class="provider-info">' +
      '<div class="provider-name">' + esc(p.name) +
      (act.fullActive ? ' <span class="badge ok">使用中</span>' : '') + '</div>' +
      '<div class="provider-url">' + esc(p.base_url) + '</div>' +
      modelLine +
      '</div>' +
      '<div class="provider-actions">' +
      (act.fullActive ? '' :
        '<button class="btn btn-sm btn-primary" data-act="use" data-pid="' + p.id + '">启用</button>') +
      '<button class="btn btn-sm" data-act="conn" data-pid="' + p.id + '">测试连接</button>' +
      '<button class="btn btn-sm" data-act="edit" data-pid="' + p.id + '">编辑</button>' +
      '<button class="btn btn-sm btn-danger" data-act="del" data-pid="' + p.id + '">删除</button>' +
      '</div></div>';
  }).join('');

  // 内置本地向量模型卡片（始终显示）
  const localActive = state.settings.default_embed_provider_id === 'local';
  box.innerHTML +=
    '<div class="provider-card' + (localActive ? ' active' : '') + '">' +
    '<div class="provider-info">' +
    '<div class="provider-name">本地向量模型' +
    (localActive ? ' <span class="badge ok">使用中</span>' : '') + '</div>' +
    '<div class="provider-key">免 API Key · 数据不出本机 · 负责资料向量化，对话仍用上面的在线模型</div>' +
    '<div class="provider-models">' +
    '<span class="model-chip' + (localActive ? ' on' : '') + '">' + LOCAL_EMBED_MODEL + '</span>' +
    '<span class="model-chip empty" id="localEmbedStatus">状态检查中…</span></div>' +
    '</div>' +
    '<div class="provider-actions">' +
    (localActive ? '' : '<button class="btn btn-sm btn-primary" data-act="uselocal">启用</button>') +
    '<button class="btn btn-sm" data-act="testlocal">测试</button>' +
    '</div></div>';

  api('/local-embed/status').then(st => {
    const el = $('#localEmbedStatus');
    if (!el) return;
    el.textContent = !st.available ? '组件未安装'
      : st.model_cached ? (st.loaded ? '模型已加载' : '模型已下载 · 按需加载')
      : '首次使用自动下载（约 100MB）';
  }).catch(() => { /* 忽略状态查询失败 */ });

  const useLocalBtn = $('[data-act=uselocal]', box);
  if (useLocalBtn) useLocalBtn.onclick = async () => {
    useLocalBtn.disabled = true;
    try {
      state.settings = await api('/local-embed/activate', { method: 'POST' });
      toast('已切换到内置本地向量模型');
      if (state.view.type === 'settings') renderSettings();
    } catch (e) { toast(e.message, 'err'); useLocalBtn.disabled = false; }
  };
  const testLocalBtn = $('[data-act=testlocal]', box);
  if (testLocalBtn) testLocalBtn.onclick = async () => {
    testLocalBtn.disabled = true; testLocalBtn.textContent = '加载中…';
    try {
      const r = await api('/local-embed/test', { method: 'POST' });
      toast(r.message, r.ok ? 'ok' : 'err');
    } catch (e) { toast(e.message, 'err'); }
    testLocalBtn.disabled = false; testLocalBtn.textContent = '测试';
    renderProviderList();
  };

  $$('[data-act]', box).forEach(btn => {
    const pid = btn.dataset.pid;
    if (!pid) return;
    if (btn.dataset.act === 'edit') btn.onclick = () => providerModal(providerById(pid));
    if (btn.dataset.act === 'use') btn.onclick = async () => {
      btn.disabled = true;
      try {
        state.settings = await api('/providers/' + pid + '/activate', { method: 'POST' });
        const p = providerById(pid);
        toast('已切换到「' + (p ? p.name : '') + '」');
        if (state.view.type === 'settings') renderSettings();
      } catch (e) { toast(e.message, 'err'); btn.disabled = false; }
    };
    if (btn.dataset.act === 'conn') btn.onclick = async () => {
      btn.disabled = true; btn.textContent = '测试中…';
      try {
        const models = await fetchModels(pid, true);
        toast('连接成功，共 ' + models.length + ' 个可用模型');
      } catch (e) { toast(e.message, 'err'); }
      btn.disabled = false; btn.textContent = '测试连接';
    };
    if (btn.dataset.act === 'del') btn.onclick = async () => {
      const ok = await confirmModal({
        title: '删除服务商',
        text: '删除后，使用该服务商的科目将无法向量化和对话，需要重新配置。确定删除吗？',
        danger: true, okText: '删除',
      });
      if (!ok) return;
      try {
        await api('/providers/' + pid, { method: 'DELETE' });
        await loadCore();
        renderSidebar();
        if (state.view.type === 'settings') renderSettings();
        toast('已删除');
      } catch (e) { toast(e.message, 'err'); }
    };
  });
}

function providerModal(p) {
  const isEdit = !!p;
  const m = openModal(
    '<h2>' + (isEdit ? '编辑服务商' : '添加 API 服务商') + '</h2>' +
    '<div class="form-row"><label>名称</label>' +
    '<input class="input" id="pvName" placeholder="如：DeepSeek、SiliconFlow" value="' + esc(p ? p.name : '') + '"></div>' +
    '<div class="form-row"><label>Base URL</label>' +
    '<input class="input" id="pvUrl" placeholder="https://api.openai.com/v1" value="' + esc(p ? p.base_url : '') + '">' +
    '<div class="hint">常见地址：DeepSeek https://api.deepseek.com/v1 · SiliconFlow https://api.siliconflow.cn/v1 · ' +
    '智谱 https://open.bigmodel.cn/api/paas/v4 · Ollama http://127.0.0.1:11434/v1</div></div>' +
    '<div class="form-row"><label>API Key</label>' +
    '<input class="input" id="pvKey" type="password" placeholder="' +
    (isEdit ? (p.has_key ? '留空则保持不变' : '未设置，可填入') : 'sk-…（本地 Ollama 可留空）') + '">' +
    '<div class="hint">仅保存在本机数据库中，不会上传到任何地方</div></div>' +
    '<div class="form-row" style="border-top:1px solid var(--border);padding-top:14px">' +
    '<label>模型配置</label>' +
    '<div class="hint" style="margin-bottom:8px">填好地址和密钥后点「获取模型」从列表选择，也可以直接手动输入模型名</div>' +
    '<div style="margin-bottom:10px"><button class="btn btn-sm" id="pvFetch">获取模型列表</button>' +
    '<span class="hint" id="pvFetchStatus" style="margin-left:8px"></span></div>' +
    '<div class="form-inline" style="margin-bottom:8px">' +
    '<span style="min-width:72px;font-size:13px">对话</span>' +
    '<input class="input" id="pvChatModel" list="pvModelList" placeholder="如 deepseek-chat" value="' +
    esc(p ? p.chat_model : '') + '"></div>' +
    '<div class="form-inline">' +
    '<span style="min-width:72px;font-size:13px">向量</span>' +
    '<input class="input" id="pvEmbedModel" list="pvModelList" placeholder="如 BAAI/bge-m3" value="' +
    esc(p ? p.embed_model : '') + '"></div>' +
    '<datalist id="pvModelList"></datalist></div>' +
    '<div class="modal-actions">' +
    '<button class="btn" data-act="cancel">取消</button>' +
    '<button class="btn btn-primary" data-act="save">' + (isEdit ? '保存' : '添加') + '</button></div>'
  );

  $('#pvFetch', m.overlay).onclick = async () => {
    const btn = $('#pvFetch', m.overlay);
    const status = $('#pvFetchStatus', m.overlay);
    btn.disabled = true; status.textContent = '获取中…';
    try {
      const data = await api('/providers/probe', {
        method: 'POST',
        body: {
          base_url: $('#pvUrl', m.overlay).value.trim(),
          api_key: $('#pvKey', m.overlay).value,
          provider_id: isEdit ? p.id : null,
        },
      });
      $('#pvModelList', m.overlay).innerHTML =
        (data.models || []).map(mo => '<option value="' + esc(mo) + '">').join('');
      status.textContent = '共 ' + data.models.length + ' 个模型，点击下方输入框选择';
      if (isEdit) state.modelCache[p.id] = data.models || [];
    } catch (e) {
      status.textContent = '';
      toast(e.message, 'err');
    }
    btn.disabled = false;
  };

  $('[data-act=cancel]', m.overlay).onclick = m.close;
  $('[data-act=save]', m.overlay).onclick = async () => {
    const body = {
      name: $('#pvName').value.trim(),
      base_url: $('#pvUrl').value.trim(),
      chat_model: $('#pvChatModel').value.trim(),
      embed_model: $('#pvEmbedModel').value.trim(),
    };
    const key = $('#pvKey').value;
    if (!isEdit) body.api_key = key;
    else if (key !== '') body.api_key = key;
    try {
      let saved;
      if (isEdit) saved = await api('/providers/' + p.id, { method: 'PUT', body });
      else saved = await api('/providers', { method: 'POST', body });
      // 首个配好模型的服务商自动启用，省去再点一次
      const st = state.settings;
      const nothingActive = !st.default_chat_model && !st.default_embed_model;
      let autoActivated = false;
      if (nothingActive && (body.chat_model || body.embed_model)) {
        try {
          state.settings = await api('/providers/' + saved.id + '/activate', { method: 'POST' });
          autoActivated = true;
        } catch (e) { /* 忽略，用户可手动点启用 */ }
      }
      m.close();
      await loadCore();
      if (state.view.type === 'settings') renderSettings();
      toast(isEdit ? '已保存'
        : (autoActivated ? '服务商已添加并设为当前使用' : '服务商已添加'));
    } catch (e) { toast(e.message, 'err'); }
  };
}

/* ================= 科目页 ================= */

const TABS = [
  ['chat', '问答'],
  ['docs', '资料'],
  ['graph', '图谱'],
  ['search', '检索'],
  ['config', '设置'],
];

function renderSubject() {
  const s = subjectById(state.view.sid);
  if (!s) { nav({ type: 'home' }); return; }
  const tab = state.view.tab;
  const mark = subjectMark(s);
  $('#main').innerHTML = '<div class="page' + (tab === 'graph' ? ' page-graph' : '') + '">' +
    '<div class="subj-head">' +
    '<div class="subj-head-icon" style="background:' + esc(s.color || '#131810') + '">' + esc(mark) + '</div>' +
    '<div><h1>' + esc(s.name) + '</h1>' +
    '<div class="subj-meta">' + s.doc_count + ' 资料 · ' + s.chunk_count + ' 片段 · ' +
    s.conv_count + ' 对话' + (s.description ? ' · ' + esc(s.description) : '') + '</div></div></div>' +
    '<div class="tabs">' +
    TABS.map(([k, label]) =>
      '<button class="tab' + (tab === k ? ' active' : '') + '" data-tab="' + k + '">' + label + '</button>'
    ).join('') +
    '</div><div id="tabContent"></div></div>';

  // 切 tab 时主区域始终从顶开始，避免「上面 UI 被顶走」
  const main = $('#main');
  if (main) main.scrollTop = 0;

  $$('.tab').forEach(el => {
    el.onclick = () => nav({ type: 'subject', sid: s.id, tab: el.dataset.tab });
  });

  if (tab === 'docs') renderDocsTab(s);
  else if (tab === 'chat') renderChatTab(s);
  else if (tab === 'graph') renderGraphTab(s);
  else if (tab === 'search') renderSearchTab(s);
  else if (tab === 'config') renderConfigTab(s);
}

/* ---------- 资料库 ---------- */

function ftBadge(ft) {
  const known = ['pdf', 'pptx', 'docx', 'txt', 'md', 'markdown'];
  const cls = known.includes(ft) ? 'ft-' + ft : 'ft-other';
  return '<span class="ft-badge ' + cls + '">' + esc(ft || '?') + '</span>';
}

function renderDocsTab(s) {
  $('#tabContent').innerHTML =
    '<div class="doc-toolbar">' +
    '<button class="btn btn-primary" id="uploadBtn">上传资料</button>' +
    '<span class="doc-hint">PDF · PPTX · DOCX · TXT · Markdown</span>' +
    '<span class="flex-spacer"></span>' +
    '<select id="topicFilter" class="topic-filter"><option value="">全部主题</option></select>' +
    '<button class="btn btn-sm" id="reindexBtn" title="用当前向量模型重新向量化">重建索引</button>' +
    '</div>' +
    '<input type="file" id="fileInput" multiple accept=".pdf,.pptx,.docx,.txt,.md,.markdown" style="display:none">' +
    '<div class="dropzone" id="dropzone">把文件拖到这里，或点此选择。PDF、PPTX、DOCX、TXT、Markdown。</div>' +
    '<div id="docTableWrap"></div>';

  const input = $('#fileInput');
  $('#uploadBtn').onclick = () => input.click();
  const dz = $('#dropzone');
  dz.onclick = () => input.click();
  dz.ondragover = e => { e.preventDefault(); dz.classList.add('dragover'); };
  dz.ondragleave = () => dz.classList.remove('dragover');
  dz.ondrop = e => {
    e.preventDefault();
    dz.classList.remove('dragover');
    if (e.dataTransfer.files.length) uploadFiles(s.id, e.dataTransfer.files);
  };
  input.onchange = () => {
    if (input.files.length) uploadFiles(s.id, input.files);
    input.value = '';
  };
  $('#reindexBtn').onclick = async () => {
    const ok = await confirmModal({
      title: '重建索引',
      text: '将用当前配置的向量化模型对本科目全部资料重新向量化（无需重新上传文件）。更换向量模型后需要执行此操作。继续吗？',
      okText: '开始重建',
    });
    if (!ok) return;
    try {
      const r = await api('/subjects/' + s.id + '/reindex', { method: 'POST' });
      toast('已开始重建 ' + r.started + ' 份资料的索引');
      await refreshDocs(s.id);
    } catch (e) { toast(e.message, 'err'); }
  };

  loadTopicFilter(s.id).then(() => refreshDocs(s.id));
}

async function loadTopicFilter(sid) {
  const sel = $('#topicFilter');
  if (!sel) return;
  let topics = [];
  try { topics = await api('/subjects/' + sid + '/topics'); } catch (e) { topics = []; }
  const cur = state.topicFilter || '';
  sel.innerHTML = '<option value="">全部主题</option>' +
    topics.map(t => '<option value="' + esc(t.id) + '"' + (t.id === cur ? ' selected' : '') + '>' +
      esc(t.name) + ' (' + t.doc_count + ')</option>').join('');
  sel.onchange = () => {
    state.topicFilter = sel.value || '';
    refreshDocs(sid);
  };
}

async function uploadFiles(sid, files) {
  const btn = $('#uploadBtn');
  if (btn && btn.disabled) return;  // 上传进行中，避免重复提交
  const fd = new FormData();
  for (const f of files) fd.append('files', f, f.name);
  if (btn) { btn.disabled = true; btn.textContent = '上传中…'; }
  const dz = $('#dropzone');
  if (dz) dz.style.pointerEvents = 'none';
  try {
    const docs = await api('/subjects/' + sid + '/documents', { method: 'POST', body: fd });
    const failed = docs.filter(d => d.status === 'error').length;
    toast(failed
      ? '已上传 ' + docs.length + ' 个文件，其中 ' + failed + ' 个无法解析（见列表）'
      : '已上传 ' + docs.length + ' 个文件，正在解析入库…');
    await refreshDocs(sid);
    refreshSubjects();
  } catch (e) { toast(e.message, 'err'); }
  finally {
    const b = $('#uploadBtn');
    if (b) { b.disabled = false; b.textContent = '上传资料'; }
    const d = $('#dropzone');
    if (d) d.style.pointerEvents = '';
  }
}

async function refreshDocs(sid) {
  if (state.view.type !== 'subject' || state.view.sid !== sid || state.view.tab !== 'docs') return;
  let docs;
  try {
    if (state.topicFilter) {
      docs = await api('/subjects/' + sid + '/topics/' + state.topicFilter + '/documents');
    } else {
      docs = await api('/subjects/' + sid + '/documents');
    }
  } catch (e) { return; }
  const wrap = $('#docTableWrap');
  if (!wrap) return;

  if (!docs.length) {
    wrap.innerHTML = '<div class="empty-state">' +
      (state.topicFilter ? '这个主题下还没有资料。' : '还没有资料。把课件、讲义或笔记拖上来。') + '</div>';
  } else {
    wrap.innerHTML = '<table class="doc-table"><thead><tr>' +
      '<th style="width:56px">类型</th><th>文件名</th><th>大小</th><th>片段</th><th>状态</th><th>图谱</th><th>上传时间</th><th style="width:44px"></th>' +
      '</tr></thead><tbody>' +
      docs.map(d => {
        let status;
        if (d.status === 'ready') {
          status = '<span class="badge ok">就绪</span>';
        } else if (d.status === 'error') {
          status = '<span class="badge err" title="' + esc(d.error) + '">失败</span> ' +
            '<button class="btn btn-sm" data-retry="' + d.id + '">重试</button>' +
            '<div class="err-text">' + esc(d.error) + '</div>';
        } else {
          const pct = d.total_chunks ? Math.round(d.processed_chunks / d.total_chunks * 100) : 0;
          status = '<div class="progress-wrap"><span class="spinner"></span>' +
            (d.total_chunks
              ? '<div class="progress-bar"><div style="width:' + pct + '%"></div></div>' +
                '<span class="progress-txt">' + pct + '%</span>'
              : '<span class="progress-txt">解析中</span>') +
            '</div>';
        }
        let gstatus;
        const gs = d.graph_status || 'none';
        if (gs === 'ready') gstatus = '<span class="badge ok">图就绪</span>';
        else if (gs === 'error') {
          gstatus = '<span class="badge err" title="' + esc(d.graph_error || '') + '">图失败</span> ' +
            '<button class="btn btn-sm" data-gretry="' + d.id + '">重试</button>';
        } else if (gs === 'pending' || gs === 'building') {
          gstatus = '<div class="gprog-inline"><span class="badge">建图中</span>' +
            progressBarHtml(gs === 'pending' ? 2 : 35, gs === 'pending' ? '排队' : '构建') +
            '</div>';
        } else {
          gstatus = '<span class="badge">—</span>';
        }
        return '<tr>' +
          '<td>' + ftBadge(d.filetype) + '</td>' +
          '<td class="doc-name"><a href="/api/documents/' + d.id + '/file" target="_blank" title="' +
          esc(d.filename) + '">' + esc(d.filename) + '</a></td>' +
          '<td>' + fmtSize(d.size) + '</td>' +
          '<td>' + (d.chunk_count || '-') + '</td>' +
          '<td>' + status + '</td>' +
          '<td>' + gstatus + '</td>' +
          '<td style="color:var(--muted);font-size:12.5px">' + fmtTime(d.created_at) + '</td>' +
          '<td><button class="btn btn-sm btn-ghost" data-del="' + d.id + '" title="删除">删除</button></td>' +
          '</tr>';
      }).join('') + '</tbody></table>';

    $$('[data-retry]', wrap).forEach(btn => {
      btn.onclick = async () => {
        btn.disabled = true;
        try {
          await api('/documents/' + btn.dataset.retry + '/retry', { method: 'POST' });
          toast('已重新开始处理');
          await refreshDocs(sid);
        } catch (e) { toast(e.message, 'err'); btn.disabled = false; }
      };
    });
    $$('[data-gretry]', wrap).forEach(btn => {
      btn.onclick = async () => {
        btn.disabled = true;
        try {
          await api('/documents/' + btn.dataset.gretry + '/graph/retry', { method: 'POST' });
          toast('已重新建图');
          await refreshDocs(sid);
        } catch (e) { toast(e.message, 'err'); btn.disabled = false; }
      };
    });
    $$('[data-del]', wrap).forEach(btn => {
      btn.onclick = async () => {
        const doc = docs.find(d => d.id === btn.dataset.del);
        const ok = await confirmModal({
          title: '删除资料',
          text: '删除《' + (doc ? doc.filename : '') + '》及其全部知识片段？',
          danger: true, okText: '删除',
        });
        if (!ok) return;
        try {
          await api('/documents/' + btn.dataset.del, { method: 'DELETE' });
          toast('已删除');
          await refreshDocs(sid);
          refreshSubjects();
        } catch (e) { toast(e.message, 'err'); }
      };
    });
  }

  const hasProcessing = docs.some(d => d.status === 'processing' ||
    d.graph_status === 'pending' || d.graph_status === 'building');
  if (hasProcessing && !docsPollTimer) {
    docsPollTimer = setInterval(() => refreshDocs(sid), 1500);
  } else if (!hasProcessing && docsPollTimer) {
    clearInterval(docsPollTimer);
    docsPollTimer = null;
    refreshSubjects();
  }
}

/* ---------- 学习问答 ---------- */

async function renderChatTab(s) {
  $('#tabContent').innerHTML = '<div class="chat-layout">' +
    '<div class="conv-panel">' +
    '<div class="conv-panel-head"><button class="btn" id="newConvBtn">新对话</button></div>' +
    '<div class="conv-items" id="convItems"></div></div>' +
    '<div class="chat-panel">' +
    '<div class="chat-msgs" id="chatMsgs"></div>' +
    '<div class="composer">' +
    '<div class="composer-opts"><label><input type="checkbox" id="ragToggle"' +
    (state.useRag ? ' checked' : '') + '> 结合资料库回答（引用来源）</label> ' +
    '<label><input type="checkbox" id="graphToggle"' +
    (state.useGraph ? ' checked' : '') + '> 图谱增强</label></div>' +
    '<div class="composer-box">' +
    '<textarea id="chatInput" rows="1" placeholder="向「' + esc(s.name) + '」资料库提问，Enter 发送，Shift+Enter 换行"></textarea>' +
    '<button class="btn btn-primary send-btn" id="sendBtn"' + (state.sending ? ' disabled' : '') + '>发送</button>' +
    '</div></div></div></div>';

  $('#ragToggle').onchange = e => { state.useRag = e.target.checked; };
  const gt = $('#graphToggle');
  if (gt) gt.onchange = e => { state.useGraph = e.target.checked; };
  $('#newConvBtn').onclick = () => { state.convId = null; renderConvList(); renderMessages([]); };

  const input = $('#chatInput');
  input.oninput = () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 140) + 'px';
  };
  // Safari 确认输入法候选词时 compositionend 先于 Enter 的 keydown 且 isComposing 已为 false，
  // 需要用时间戳兜底，否则中文输入按 Enter 上屏会直接发送
  let lastCompositionEnd = 0;
  input.addEventListener('compositionend', () => { lastCompositionEnd = Date.now(); });
  input.onkeydown = e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      if (e.isComposing || e.keyCode === 229 || Date.now() - lastCompositionEnd < 80) return;
      e.preventDefault();
      sendMessage(s);
    }
  };
  $('#sendBtn').onclick = () => sendMessage(s);

  await loadConvs(s.id);
  if (state.convId) {
    await loadMessages(state.convId);
  } else {
    renderMessages([]);
  }
}

async function loadConvs(sid) {
  const convs = await api('/subjects/' + sid + '/conversations');
  // 请求返回时用户可能已切到别的科目，丢弃过期结果，避免把 A 科目的会话渲染进 B 科目
  if (state.view.type !== 'subject' || state.view.sid !== sid) return;
  state.convs = convs;
  if (state.convId && !state.convs.some(c => c.id === state.convId)) state.convId = null;
  renderConvList(sid);
}

function renderConvList(sid) {
  if (sid !== undefined && (state.view.type !== 'subject' || state.view.sid !== sid)) return;
  const box = $('#convItems');
  if (!box) return;
  box.innerHTML = state.convs.map(c =>
    '<div class="conv-item' + (c.id === state.convId ? ' active' : '') + '" data-cid="' + c.id + '">' +
    '<span class="c-title" title="' + esc(c.title) + '">' + esc(c.title) + '</span>' +
    '<button class="c-del" data-delconv="' + c.id + '" title="删除对话">✕</button></div>'
  ).join('') || '<div style="padding:10px;color:var(--muted);font-size:12px;text-align:center">暂无历史对话</div>';

  $$('.conv-item', box).forEach(el => {
    el.onclick = async e => {
      if (e.target.closest('.c-del')) return;
      state.convId = el.dataset.cid;
      renderConvList();
      await loadMessages(state.convId);
    };
  });
  $$('[data-delconv]', box).forEach(btn => {
    btn.onclick = async () => {
      const ok = await confirmModal({ title: '删除对话', text: '删除这组对话记录？', danger: true, okText: '删除' });
      if (!ok) return;
      try {
        await api('/conversations/' + btn.dataset.delconv, { method: 'DELETE' });
        if (state.convId === btn.dataset.delconv) { state.convId = null; renderMessages([]); }
        const s = subjectById(state.view.sid);
        if (s) await loadConvs(s.id);
      } catch (e) { toast(e.message, 'err'); }
    };
  });
}

async function loadMessages(cid) {
  const msgs = await api('/conversations/' + cid + '/messages');
  renderMessages(msgs);
}

function sourcesHtml(sources, warning) {
  let html = '';
  if (warning) html += '<div class="banner-warn" style="margin:8px 0 0">' + esc(warning) + '</div>';
  if (!sources || !sources.length) return html;
  html += '<div class="sources-block">' +
    '<button class="sources-toggle">出处 ' + sources.length + ' ▾</button>' +
    '<div class="sources-list" style="display:none">' +
    sources.map(src =>
      '<div class="source-card">' +
      '<div class="src-head"><span>[' + src.index + '] 《' + esc(src.doc_name) + '》</span>' +
      (src.location ? '<span style="font-weight:400;color:var(--muted)">' + esc(src.location) + '</span>' : '') +
      '<span class="src-score">相似度 ' + Math.round((src.score || 0) * 100) + '%</span></div>' +
      '<div class="src-text">' + esc(src.text) + '</div></div>'
    ).join('') + '</div></div>';
  return html;
}

function bindSourceToggles(root) {
  $$('.sources-toggle', root).forEach(btn => {
    if (btn._bound) return;
    btn._bound = true;
    btn.onclick = () => {
      const list = btn.nextElementSibling;
      const open = list.style.display !== 'none';
      list.style.display = open ? 'none' : 'flex';
      btn.textContent = btn.textContent.replace(open ? '▴' : '▾', open ? '▾' : '▴');
    };
  });
  $$('.source-card', root).forEach(card => {
    if (card._bound) return;
    card._bound = true;
    card.onclick = () => card.classList.toggle('expanded');
  });
}

function renderMessages(msgs) {
  const box = $('#chatMsgs');
  if (!box) return;
  if (!msgs.length) {
    box.innerHTML = '<div class="chat-empty">' +
      '<div>对着这堆资料问。回答会标出处。</div>' +
      '<div style="font-size:12px;color:var(--muted)">比如：第三章在讲什么；这个概念原文怎么定义</div></div>';
    return;
  }
  box.innerHTML = msgs.map(m => {
    if (m.role === 'user') {
      return '<div class="msg-row user"><div class="bubble">' + esc(m.content) + '</div></div>';
    }
    return '<div class="msg-row assistant"><div class="bubble">' +
      '<div class="md">' + md(m.content) + '</div>' +
      sourcesHtml(m.sources) + '</div></div>';
  }).join('');
  bindSourceToggles(box);
  box.scrollTop = box.scrollHeight;
}

async function streamChat(cid, message, useRag, handlers) {
  const res = await fetch('/api/conversations/' + cid + '/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, use_rag: useRag, use_graph: !!state.useGraph }),
  });
  if (!res.ok || !res.body) {
    let msg = '请求失败 (' + res.status + ')';
    try { const d = await res.json(); if (d.detail) msg = d.detail; } catch (e) { /* ignore */ }
    throw new Error(msg);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        let ev;
        try { ev = JSON.parse(line.slice(5).trim()); } catch (e) { continue; }
        handlers(ev);
      }
    }
  }
}

async function sendMessage(s) {
  if (state.sending) { toast('上一条回答仍在生成中，请稍候'); return; }
  const input = $('#chatInput');
  const text = input.value.trim();
  if (!text) return;

  state.sending = true;
  const sendBtn = $('#sendBtn');
  if (sendBtn) sendBtn.disabled = true;
  input.value = '';
  input.style.height = 'auto';

  // 失败且没有生成任何内容时，把用户输入放回输入框，避免重打
  const restoreInput = () => {
    const inp = $('#chatInput');
    if (inp && !inp.value) inp.value = text;
  };

  // 全程持有元素引用，不用全局 id 定位流式节点：
  // 避免连续发送 / 出错重试时新回答渲染进旧气泡的错位问题
  let contentEl = null, extraEl = null;
  let acc = '';

  try {
    if (!state.convId) {
      const conv = await api('/subjects/' + s.id + '/conversations', { method: 'POST', body: {} });
      state.convId = conv.id;
      state.convs.unshift(conv);
      renderConvList(s.id);
    }
    const box = $('#chatMsgs');
    if (!box) { restoreInput(); return; }  // 等待建会话期间用户已离开对话页
    if ($('.chat-empty', box)) box.innerHTML = '';
    box.insertAdjacentHTML('beforeend',
      '<div class="msg-row user"><div class="bubble">' + esc(text) + '</div></div>' +
      '<div class="msg-row assistant"><div class="bubble">' +
      '<div class="think-block" style="display:none">' +
      '<button class="think-toggle">思考中…</button>' +
      '<div class="think-body"></div></div>' +
      '<div class="md stream-content"><span class="cursor-blink"></span></div>' +
      '<div class="stream-extra"></div></div></div>');
    const bubble = $('.bubble', box.lastElementChild);
    contentEl = $('.stream-content', bubble);
    extraEl = $('.stream-extra', bubble);
    const thinkBlock = $('.think-block', bubble);
    const thinkBody = $('.think-body', bubble);
    const thinkToggle = $('.think-toggle', bubble);
    thinkToggle.onclick = () => {
      thinkBody.style.display = thinkBody.style.display === 'none' ? 'block' : 'none';
    };
    box.scrollTop = box.scrollHeight;

    let sources = [], warning = null, errMsg = null;
    let tacc = '', noContent = false;
    let finished = false, rafPending = false, rafThink = false;
    const paint = final => {
      contentEl.innerHTML = md(acc) + (final ? '' : '<span class="cursor-blink"></span>');
      const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
      if (nearBottom) box.scrollTop = box.scrollHeight;
    };
    const paintThink = () => {
      thinkBody.textContent = tacc;
      thinkBody.scrollTop = thinkBody.scrollHeight;
      const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
      if (nearBottom) box.scrollTop = box.scrollHeight;
    };
    const collapseThink = () => {
      thinkToggle.textContent = '思考过程（点击展开）';
      thinkBody.style.display = 'none';
    };

    await streamChat(state.convId, text, state.useRag, ev => {
      if (ev.type === 'delta') {
        if (!acc && tacc) collapseThink();  // 正式回答开始，折叠思考过程
        acc += ev.content;
        if (!rafPending) {
          rafPending = true;
          requestAnimationFrame(() => {
            rafPending = false;
            if (!finished) paint(false);  // 收尾后不再被延迟帧覆盖
          });
        }
      } else if (ev.type === 'thinking') {
        tacc += ev.content;
        if (thinkBlock.style.display === 'none') {
          thinkBlock.style.display = 'block';
          thinkBody.style.display = 'block';
        }
        if (!rafThink) {
          rafThink = true;
          requestAnimationFrame(() => {
            rafThink = false;
            if (!finished) paintThink();
          });
        }
      } else if (ev.type === 'sources') {
        sources = ev.sources || [];
        warning = ev.warning;
      } else if (ev.type === 'done') {
        noContent = !!ev.no_content;
      } else if (ev.type === 'error') {
        errMsg = ev.message || '未知错误';
      }
    });

    finished = true;
    paintThink();
    if (noContent) {
      // 模型只输出了思考过程：保持展开并提示（后端已把思考内容存为本条消息）
      thinkToggle.textContent = '思考过程';
      thinkBody.style.display = 'block';
      contentEl.innerHTML = '<div class="banner-warn" style="margin:0">模型未输出正式回答' +
        '（思考可能被输出上限截断），已保留思考过程，可重新提问或更换模型</div>';
    } else {
      paint(true);
      if (tacc && !acc) collapseThink();
    }
    if (errMsg) {
      // 与后端「保留部分内容」的落库行为一致：不清空已生成的文字，在尾部追加错误提示
      contentEl.insertAdjacentHTML('beforeend',
        '<div class="banner-warn" style="margin:8px 0 0">' + esc(errMsg) + '</div>');
      if (!acc.trim()) restoreInput();
    }
    if (extraEl) {
      extraEl.innerHTML = sourcesHtml(sources, warning);
      bindSourceToggles(extraEl);
    }
  } catch (e) {
    if (contentEl) {
      contentEl.innerHTML = (acc ? md(acc) : '') +
        '<div class="banner-warn" style="margin:8px 0 0">' + esc(e.message) + '</div>';
    } else {
      toast(e.message, 'err');
      restoreInput();
    }
  } finally {
    state.sending = false;
    const btn = $('#sendBtn');
    if (btn) btn.disabled = false;
    const inp = $('#chatInput');
    if (inp) inp.focus();
    try { await loadConvs(s.id); } catch (e) { /* 刷新会话列表失败不影响主流程 */ }
  }
}

/* ---------- 检索测试 ---------- */

function renderSearchTab(s) {
  $('#tabContent').innerHTML =
    '<div class="card"><h3>检索测试</h3>' +
    '<div class="card-hint">看看一个问题会命中资料库中的哪些片段，用于调试检索效果</div>' +
    '<div class="form-inline">' +
    '<input class="input" id="searchInput" placeholder="输入问题或关键词，如：文言文虚词的用法">' +
    '<select class="input" id="searchTopK" style="max-width:110px">' +
    [3, 5, 8, 10].map(k => '<option value="' + k + '"' + (k === 5 ? ' selected' : '') + '>前 ' + k + ' 条</option>').join('') +
    '</select>' +
    '<label class="check-inline"><input type="checkbox" id="searchUseGraph"' +
    (state.useGraph ? ' checked' : '') + '> 图谱加成</label>' +
    '<button class="btn btn-primary" id="searchBtn">检索</button>' +
    '</div></div><div id="searchResults"></div>';

  const doSearch = async () => {
    const q = $('#searchInput').value.trim();
    if (!q) return;
    const btn = $('#searchBtn');
    if (btn.disabled) return;  // 检索进行中，忽略重复提交
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
    const box = $('#searchResults');
    try {
      const useG = $('#searchUseGraph') ? $('#searchUseGraph').checked : true;
      state.useGraph = useG;
      const data = await api('/subjects/' + s.id + '/search', {
        method: 'POST',
        body: { query: q, top_k: parseInt($('#searchTopK').value, 10), use_graph: useG },
      });
      let html = '';
      if (data.warning) html += '<div class="banner-warn">' + esc(data.warning) + '</div>';
      if (!data.results.length) {
        html += '<div class="empty-state">没有命中相关片段。</div>';
      } else {
        html += data.results.map((r, i) =>
          '<div class="result-card"><div class="result-head">' +
          '<span class="result-rank">' + (i + 1) + '</span>' +
          '<span class="result-doc">《' + esc(r.doc_name) + '》</span>' +
          (r.location ? '<span class="result-loc">' + esc(r.location) + '</span>' : '') +
          '<div class="score-wrap"><div class="score-bar"><div style="width:' +
          Math.round(Math.max(0, Math.min(1, r.score)) * 100) + '%"></div></div>' +
          '<span class="score-num">' + (r.score * 100).toFixed(1) + '%</span></div>' +
          '</div><div class="result-text">' + esc(r.text) + '</div></div>'
        ).join('');
      }
      box.innerHTML = html;
    } catch (e) {
      box.innerHTML = '<div class="banner-warn">' + esc(e.message) + '</div>';
    }
    btn.disabled = false; btn.textContent = '检索';
  };
  $('#searchBtn').onclick = doSearch;
  let lastSearchCompEnd = 0;
  $('#searchInput').addEventListener('compositionend', () => { lastSearchCompEnd = Date.now(); });
  $('#searchInput').onkeydown = e => {
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229 &&
        Date.now() - lastSearchCompEnd >= 80) doSearch();
  };
}

/* ---------- 知识图谱 ---------- */

function stopGraphPoll() {
  if (state._graphPollTimer) {
    clearInterval(state._graphPollTimer);
    state._graphPollTimer = null;
  }
}

async function refreshGraphBuildPanel(sid) {
  const panel = $('#graphBuildPanel');
  const hint = $('#graphMetaHint');
  if (!panel && !hint) return null;
  let meta;
  try {
    meta = await api('/subjects/' + sid + '/graph');
  } catch (e) {
    if (hint) hint.textContent = e.message;
    return null;
  }
  if (hint) {
    hint.textContent = '状态 ' + meta.status + ' · v' + meta.version +
      ' · 实体 ' + meta.entity_count + ' · 关系 ' + meta.relation_count +
      ' · 主题 ' + meta.topic_count +
      (meta.jobs_pending ? ' · 排队 ' + meta.jobs_pending : '');
  }
  if (panel) {
    const building = (meta.docs_graph_building || 0) + (meta.docs_graph_pending || 0) > 0 ||
      meta.status === 'building';
    if (building || (meta.docs_graph_error || 0) > 0) {
      const pct = meta.progress_pct != null ? meta.progress_pct : 0;
      const msgParts = [];
      if (meta.docs_total) {
        msgParts.push('资料 ' + (meta.docs_graph_ready || 0) + '/' + meta.docs_total + ' 已建图');
      }
      if (meta.docs_graph_building) msgParts.push(meta.docs_graph_building + ' 构建中');
      if (meta.docs_graph_pending) msgParts.push(meta.docs_graph_pending + ' 排队');
      if (meta.docs_graph_error) msgParts.push(meta.docs_graph_error + ' 失败');
      const active = (meta.active_jobs || [])[0];
      if (active && active.message) msgParts.push(active.message);
      panel.style.display = '';
      panel.innerHTML =
        '<div class="graph-build-head"><strong>知识图谱构建中</strong>' +
        '<span>' + pct.toFixed(0) + '%</span></div>' +
        progressBarHtml(pct) +
        '<div class="graph-build-msg">' + esc(msgParts.join(' · ') || '处理中…') + '</div>';
    } else {
      panel.style.display = 'none';
      panel.innerHTML = '';
    }
  }
  return meta;
}

async function renderGraphTab(s) {
  // page-graph 已在 renderSubject 挂上；这里只保证滚动归零
  const main = $('#main');
  if (main) main.scrollTop = 0;
  stopGraphPoll();

  const limits = [100, 200, 300, 500, 800, 1000];
  let curLimit = state.graphLimit || 300;
  if (limits.indexOf(curLimit) < 0) curLimit = 300;

  $('#tabContent').innerHTML =
    '<div class="graph-shell">' +
    '<div class="doc-toolbar">' +
    '<span class="doc-hint" id="graphMetaHint">加载中…</span>' +
    '<span class="flex-spacer"></span>' +
    '<label class="check-inline">节点上限 <select id="graphLimit" class="input" style="width:auto;max-width:100px;padding:4px 8px">' +
    limits.map(n => '<option value="' + n + '"' + (n === curLimit ? ' selected' : '') + '>' + n + '</option>').join('') +
    '</select></label>' +
    '<button class="btn btn-sm" id="graphReloadBtn">刷新</button>' +
    '<button class="btn btn-sm" id="graphRebuildBtn">重建图谱</button>' +
    '</div>' +
    '<div id="graphBuildPanel" class="graph-build-panel" style="display:none"></div>' +
    '<div class="graph-layout">' +
    '<div id="graphCanvas" class="graph-canvas"></div>' +
    '<div id="graphSide" class="graph-side"><div class="empty-state" style="padding:8px 0">' +
    '点一个节点看原文；再点一次或点空白取消锁定。</div></div>' +
    '</div>' +
    '</div>';

  await refreshGraphBuildPanel(s.id);

  const reload = () => paintGraphNetwork(s.id);

  $('#graphRebuildBtn').onclick = async () => {
    const ok = await confirmModal({
      title: '重建知识图谱',
      text: '将对本科目已入库资料重新抽取实体与共现关系。不改动原文与向量索引。',
      okText: '开始重建',
    });
    if (!ok) return;
    try {
      const r = await api('/subjects/' + s.id + '/graph/rebuild', { method: 'POST' });
      toast('已开始重建 ' + r.started + ' 份资料的图谱');
      await refreshGraphBuildPanel(s.id);
      startGraphBuildPoll(s.id);
    } catch (e) { toast(e.message, 'err'); }
  };
  $('#graphReloadBtn').onclick = reload;
  $('#graphLimit').onchange = () => {
    state.graphLimit = parseInt($('#graphLimit').value, 10) || 300;
    reload();
  };

  startGraphBuildPoll(s.id);
  await paintGraphNetwork(s.id);
}

function startGraphBuildPoll(sid) {
  stopGraphPoll();
  state._graphPollTimer = setInterval(async () => {
    if (state.view.type !== 'subject' || state.view.sid !== sid || state.view.tab !== 'graph') {
      stopGraphPoll();
      return;
    }
    const meta = await refreshGraphBuildPanel(sid);
    if (!meta) return;
    const busy = (meta.docs_graph_building || 0) + (meta.docs_graph_pending || 0) > 0 ||
      meta.status === 'building';
    if (!busy) {
      stopGraphPoll();
      // 构建刚结束时自动刷新一次画布
      if (meta.entity_count > 0 && !state.graphNet) paintGraphNetwork(sid);
    }
  }, 1200);
}

async function paintGraphNetwork(sid) {
  const canvas = $('#graphCanvas');
  if (!canvas) return;

  if (state.graphNet) {
    try { state.graphNet.destroy(); } catch (e) { /* ignore */ }
    state.graphNet = null;
  }

  canvas.innerHTML =
    '<div class="graph-loading">' +
    '<div class="spinner"></div>' +
    '<div>准备图谱引擎…</div></div>';

  try {
    await ensureVisNetwork();
  } catch (e) {
    canvas.innerHTML = '<div class="banner-warn">' + esc(e.message) +
      ' <button class="btn btn-sm" id="visRetryBtn">重试加载</button></div>';
    const btn = $('#visRetryBtn');
    if (btn) btn.onclick = () => paintGraphNetwork(sid);
    return;
  }

  const limitEl = $('#graphLimit');
  const limit = limitEl ? parseInt(limitEl.value, 10) || (state.graphLimit || 300) : (state.graphLimit || 300);
  state.graphLimit = limit;

  canvas.innerHTML =
    '<div class="graph-loading">' +
    '<div class="spinner"></div>' +
    '<div>拉取子图（最多 ' + limit + ' 节点）…</div></div>';

  let data;
  try {
    data = await api('/subjects/' + sid + '/graph/view?depth=1&limit=' + limit);
  } catch (e) {
    canvas.innerHTML = '<div class="banner-warn">' + esc(e.message) + '</div>';
    return;
  }
  if (!data.nodes || !data.nodes.length) {
    canvas.innerHTML = '<div class="empty-state">还没有实体。资料入库后会按术语自动抽图。</div>';
    return;
  }

  canvas.innerHTML =
    '<div class="graph-loading">' +
    '<div class="spinner"></div>' +
    '<div>布局 ' + data.nodes.length + ' 个节点…</div></div>';

  // 下一帧再挂 canvas，保证 loading 先绘制
  await new Promise(r => requestAnimationFrame(() => r()));

  canvas.innerHTML = '';
  // 不再用 JS 改 canvas 外联高度（那会牵动整页布局）
  // 高度完全由 .graph-layout / flex 决定

  let edgeList = data.edges || [];
  // 大图时边数随 limit 放宽，但仍设上限保流畅
  const maxEdges = Math.min(edgeList.length, Math.min(limit * 4, 3000));
  if (edgeList.length > maxEdges) {
    edgeList = edgeList.slice().sort((a, b) => (b.weight || 0) - (a.weight || 0)).slice(0, maxEdges);
  }

  // 节点很多时减弱物理，但始终保留轻微动效（类 Obsidian，不全固定）
  const heavy = data.nodes.length >= 400;
  const ambientPhysics = {
    enabled: true,
    solver: 'forceAtlas2Based',
    forceAtlas2Based: {
      gravitationalConstant: heavy ? -22 : -32,
      centralGravity: heavy ? 0.006 : 0.01,
      springLength: heavy ? 78 : 96,
      springConstant: heavy ? 0.035 : 0.045,
      damping: 0.42,
      avoidOverlap: 0.25,
    },
    maxVelocity: heavy ? 18 : 28,
    minVelocity: 0.35,
    timestep: 0.35,
    stabilization: {
      enabled: true,
      iterations: heavy ? 55 : 100,
      updateInterval: 25,
      fit: true,
    },
  };
  // 聚焦时略加强斥力，但仍保持全局可动
  const focusPhysics = {
    enabled: true,
    solver: 'forceAtlas2Based',
    forceAtlas2Based: {
      gravitationalConstant: heavy ? -38 : -58,
      centralGravity: 0.006,
      springLength: heavy ? 100 : 120,
      springConstant: 0.035,
      damping: 0.38,
      avoidOverlap: 0.35,
    },
    maxVelocity: heavy ? 26 : 40,
    minVelocity: 0.25,
    timestep: 0.4,
    stabilization: { enabled: false },
  };

  // 画布上节点 / 边 / 字必须分三层：
  // 节点用色块，边用淡底线，字用墨色+纸色描边。禁止 inherit（canvas 读不到 CSS）。
  const darkGraph = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const GRAPH = {
    ink: darkGraph ? '#efece1' : '#131810',
    paper: darkGraph ? '#1b1d16' : '#f7f4ea',
    accent: darkGraph ? '#d45a48' : '#b42318',
    edge: darkGraph ? 'rgba(239,236,225,0.18)' : 'rgba(19,24,16,0.14)',
    edgeDim: darkGraph ? 'rgba(239,236,225,0.06)' : 'rgba(19,24,16,0.06)',
    dimFill: darkGraph ? 'rgba(239,236,225,0.10)' : 'rgba(19,24,16,0.07)',
    dimLabel: darkGraph ? 'rgba(239,236,225,0.32)' : 'rgba(19,24,16,0.28)',
    face: 'PingFang SC, Hiragino Sans GB, Noto Sans CJK SC, sans-serif',
    groups: darkGraph ? {
      Term: { bg: '#8d8876', border: '#c4bfae', hi: '#d4cfbf' },
      Concept: { bg: '#d45a48', border: '#f0b0a4', hi: '#e07060' },
      Person: { bg: '#6a8aaa', border: '#b0c6d8', hi: '#8aa8c4' },
      Other: { bg: '#a07858', border: '#d2b496', hi: '#b89070' },
    } : {
      Term: { bg: '#c9c2ad', border: '#8a8676', hi: '#ddd6c2' },
      Concept: { bg: '#b42318', border: '#8a1c14', hi: '#d45a48' },
      Person: { bg: '#3d5a72', border: '#2a3f5c', hi: '#5a7a94' },
      Other: { bg: '#8a6750', border: '#6a4a32', hi: '#a88870' },
    },
  };
  const GRAPH_GROUP_COLORS = GRAPH.groups;
  const labelFont = (size, extra) => Object.assign({
    size: size,
    face: GRAPH.face,
    color: GRAPH.ink,
    strokeWidth: 4,
    strokeColor: GRAPH.paper,
    bold: false,
  }, extra || {});
  const edgeColor = (hex, opacity) => ({
    color: hex, highlight: GRAPH.accent, hover: GRAPH.accent, opacity: opacity == null ? 1 : opacity,
  });

  const nodes = new vis.DataSet(data.nodes.map(n => {
    const group = n.group || n.type || 'Term';
    const baseColor = GRAPH_GROUP_COLORS[group] || GRAPH_GROUP_COLORS.Term;
    return {
      id: String(n.id),
      label: String(n.label || n.id),
      value: Math.max(1, n.mentions || 1),
      group: group,
      title: (n.type || '') + ' · 提及 ' + (n.mentions || 0) + ' · 点击锁定聚焦',
      borderWidth: 1,
      color: {
        background: baseColor.bg,
        border: baseColor.border,
        highlight: { background: baseColor.hi, border: baseColor.border },
        hover: { background: baseColor.hi, border: baseColor.border },
      },
      font: labelFont(heavy ? 11 : 13),
      opacity: 1,
    };
  }));
  const edges = new vis.DataSet(edgeList.map(e => ({
    id: String(e.id),
    from: String(e.from),
    to: String(e.to),
    value: Math.max(1, e.weight || 1),
    title: (e.label || '') + ' · w=' + (e.weight || 1),
    width: 1,
    color: edgeColor(GRAPH.edge, 1),
    smooth: heavy ? false : { type: 'continuous', roundness: 0.4 },
  })));

  // 邻接表：悬停预览 / 点击锁定
  const adj = {};
  edgeList.forEach(e => {
    const a = String(e.from);
    const b = String(e.to);
    if (!adj[a]) adj[a] = new Set();
    if (!adj[b]) adj[b] = new Set();
    adj[a].add(b);
    adj[b].add(a);
  });

  let net;
  try {
    net = new vis.Network(canvas, { nodes: nodes, edges: edges }, {
      autoResize: true,
      height: '100%',
      width: '100%',
      physics: ambientPhysics,
      interaction: {
        hover: true,
        tooltipDelay: 100,
        navigationButtons: false,
        keyboard: false,
        zoomView: true,
        dragNodes: true,
        hideEdgesOnDrag: heavy,
      },
      nodes: {
        shape: 'dot',
        scaling: { min: heavy ? 6 : 10, max: heavy ? 26 : 32 },
        font: labelFont(heavy ? 11 : 13),
        borderWidth: 1,
      },
      edges: {
        color: edgeColor(GRAPH.edge, 1),
        smooth: heavy ? false : { type: 'continuous', roundness: 0.4 },
        selectionWidth: 2,
      },
      groups: {
        Term: { color: { background: GRAPH_GROUP_COLORS.Term.bg, border: GRAPH_GROUP_COLORS.Term.border } },
        Concept: { color: { background: GRAPH_GROUP_COLORS.Concept.bg, border: GRAPH_GROUP_COLORS.Concept.border } },
        Person: { color: { background: GRAPH_GROUP_COLORS.Person.bg, border: GRAPH_GROUP_COLORS.Person.border } },
        Other: { color: { background: GRAPH_GROUP_COLORS.Other.bg, border: GRAPH_GROUP_COLORS.Other.border } },
      },
    });
  } catch (e) {
    canvas.innerHTML = '<div class="banner-warn">图谱渲染失败：' + esc(e.message || e) + '</div>';
    return;
  }
  state.graphNet = net;

  // focus: locked=点击锁定；preview=仅悬停预览（未锁定时）
  // 关键规则：主节点 fixed，邻居可动，悬停预览只改样式不推开（防抽搐导致点不中）
  const focusState = {
    lockedId: null,
    previewId: null,
    anim: null,
    fixedMainId: null,
  };

  const fitOnce = () => {
    // 只适配画布内部视口，绝不改外层滚动位置
    const main = $('#main');
    const keepScroll = main ? main.scrollTop : 0;
    try {
      net.redraw();
      net.fit({ animation: false });
    } catch (e) { /* ignore */ }
    if (main && main.scrollTop !== keepScroll) main.scrollTop = keepScroll;
  };
  net.once('stabilizationIterationsDone', () => {
    fitOnce();
    // 稳定后保留很轻的环境物理（不全冻死）
    try {
      net.setOptions({
        physics: Object.assign({}, ambientPhysics, {
          stabilization: { enabled: false },
          maxVelocity: heavy ? 8 : 12,
          minVelocity: 0.55,
        }),
      });
    } catch (e) { /* ignore */ }
  });
  // 只做有限次 fit，避免反复布局把页面顶动
  setTimeout(fitOnce, 280);
  // 禁止 fit 动画；交互仅在 canvas 内
  try {
    net.setOptions({
      interaction: {
        hover: true,
        tooltipDelay: 100,
        navigationButtons: false,
        keyboard: false,
        zoomView: true,
        dragView: true,
        dragNodes: true,
        hideEdgesOnDrag: heavy,
      },
    });
  } catch (e) { /* ignore */ }

  if (typeof ResizeObserver !== 'undefined') {
    if (state._graphRo) {
      try { state._graphRo.disconnect(); } catch (e) { /* ignore */ }
    }
    state._graphRo = new ResizeObserver(() => {
      try { net.redraw(); } catch (e) { /* ignore */ }
    });
    state._graphRo.observe(canvas);
  }

  const hint = $('#graphMetaHint');
  if (hint) {
    const extra = ' · 显示 ' + data.nodes.length + ' 点 / ' + edgeList.length + ' 边' +
      (data.truncated ? '（已截断，可提高上限）' : '') +
      ' · 点击锁定聚焦，点空白取消';
    if (hint.textContent.indexOf('显示') < 0) hint.textContent += extra;
  }

  function cancelFocusAnim() {
    if (focusState.anim) {
      cancelAnimationFrame(focusState.anim);
      focusState.anim = null;
    }
  }

  function unpinMain() {
    if (!focusState.fixedMainId) return;
    try {
      nodes.update({ id: focusState.fixedMainId, fixed: { x: false, y: false } });
    } catch (e) { /* ignore */ }
    focusState.fixedMainId = null;
  }

  function pinMain(id) {
    if (!id) return;
    if (focusState.fixedMainId && focusState.fixedMainId !== id) unpinMain();
    try {
      // 钉在当前坐标，避免悬停/锁定时主节点被物理拽走
      const pos = net.getPositions([id])[id];
      if (pos) {
        nodes.update({ id: id, x: pos.x, y: pos.y, fixed: { x: true, y: true } });
      } else {
        nodes.update({ id: id, fixed: { x: true, y: true } });
      }
      focusState.fixedMainId = id;
    } catch (e) { /* ignore */ }
  }

  function resetVisualStyles(exceptFixedId) {
    const nUpdates = nodes.getIds().map(id => {
      const n = nodes.get(id);
      const group = (n && n.group) || 'Term';
      const c = GRAPH_GROUP_COLORS[group] || GRAPH_GROUP_COLORS.Term;
      return {
        id: id,
        opacity: 1,
        borderWidth: 1,
        color: {
          background: c.bg,
          border: c.border,
          highlight: { background: c.hi, border: c.border },
          hover: { background: c.hi, border: c.border },
        },
        font: labelFont(heavy ? 11 : 13),
        // 只保留当前主节点固定；其余解开
        fixed: (exceptFixedId && id === exceptFixedId)
          ? { x: true, y: true }
          : { x: false, y: false },
      };
    });
    nodes.update(nUpdates);
    const eUpdates = edges.getIds().map(id => ({
      id: id,
      width: 1,
      color: edgeColor(GRAPH.edge, 1),
    }));
    edges.update(eUpdates);
  }

  function setAmbientPhysics(mode) {
    try {
      if (mode === 'focus') {
        // 锁定时略增强，但速度压低，减少抖动
        net.setOptions({
          physics: Object.assign({}, focusPhysics, {
            maxVelocity: heavy ? 10 : 16,
            minVelocity: 0.4,
            stabilization: { enabled: false },
          }),
        });
      } else {
        net.setOptions({
          physics: Object.assign({}, ambientPhysics, {
            stabilization: { enabled: false },
            maxVelocity: heavy ? 8 : 12,
            minVelocity: 0.55,
          }),
        });
      }
    } catch (e) { /* ignore */ }
  }

  function paintFocusVisual(focusId, mode) {
    const neighborSet = adj[focusId] ? new Set(adj[focusId]) : new Set();
    neighborSet.add(focusId);
    const nUpdates = nodes.getIds().map(id => {
      const n = nodes.get(id);
      const group = (n && n.group) || 'Term';
      const c = GRAPH_GROUP_COLORS[group] || GRAPH_GROUP_COLORS.Term;
      if (id === focusId) {
        return {
          id: id,
          opacity: 1,
          borderWidth: 3,
          fixed: { x: true, y: true },
          color: {
            background: c.hi,
            border: mode === 'lock' ? GRAPH.ink : c.border,
            highlight: { background: c.hi, border: GRAPH.ink },
            hover: { background: c.hi, border: GRAPH.ink },
          },
          font: labelFont(heavy ? 13 : 15, { bold: true, strokeWidth: 5 }),
        };
      }
      if (neighborSet.has(id)) {
        return {
          id: id,
          opacity: 1,
          borderWidth: 2,
          fixed: { x: false, y: false },
          color: {
            background: c.bg,
            border: c.border,
            highlight: { background: c.hi, border: c.border },
            hover: { background: c.hi, border: c.border },
          },
          font: labelFont(heavy ? 12 : 13),
        };
      }
      return {
        id: id,
        opacity: mode === 'lock' ? 0.22 : 0.36,
        borderWidth: 1,
        fixed: { x: false, y: false },
        color: {
          background: GRAPH.dimFill,
          border: GRAPH.edge,
          highlight: { background: GRAPH.dimFill, border: GRAPH.edge },
          hover: { background: GRAPH.dimFill, border: GRAPH.edge },
        },
        font: labelFont(heavy ? 10 : 11, { color: GRAPH.dimLabel, strokeWidth: 3 }),
      };
    });
    nodes.update(nUpdates);

    const eUpdates = edges.getIds().map(id => {
      const e = edges.get(id);
      const connected = e && (e.from === focusId || e.to === focusId);
      if (connected) {
        return {
          id: id,
          width: Math.min(6, 2 + Math.log2(1 + (e.value || 1))),
          color: { color: GRAPH.accent, highlight: GRAPH.accent, hover: GRAPH.accent, opacity: 1 },
        };
      }
      return {
        id: id,
        width: 1,
        color: edgeColor(GRAPH.edgeDim, mode === 'lock' ? 0.35 : 0.5),
      };
    });
    edges.update(eUpdates);
  }

  function pushNeighborsOnce(focusId, mode) {
    // 只在锁定时推开一次；主节点固定，邻居移动
    let positions = {};
    try { positions = net.getPositions(); } catch (e) { return; }
    const fp = positions[focusId];
    if (!fp) return;
    const neighborSet = adj[focusId] ? Array.from(adj[focusId]) : [];
    if (!neighborSet.length) return;

    const basePush = heavy ? 36 : 58;
    const pushExtra = Math.min(56, neighborSet.length);
    const targetGain = 1.16;
    const from = {};
    const to = {};
    neighborSet.forEach(id => {
      const p = positions[id];
      if (!p) return;
      let dx = p.x - fp.x;
      let dy = p.y - fp.y;
      let dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 1e-3) {
        const ang = Math.random() * Math.PI * 2;
        dx = Math.cos(ang);
        dy = Math.sin(ang);
        dist = 1;
      }
      const ux = dx / dist;
      const uy = dy / dist;
      const want = Math.max(dist * targetGain, dist + basePush + pushExtra * 0.1);
      from[id] = { x: p.x, y: p.y };
      to[id] = { x: fp.x + ux * want, y: fp.y + uy * want };
    });

    cancelFocusAnim();
    const t0 = performance.now();
    const dur = heavy ? 180 : 240;
    const step = (now) => {
      if (focusState.lockedId !== focusId) return;
      const t = Math.min(1, (now - t0) / dur);
      const k = 1 - Math.pow(1 - t, 3);
      Object.keys(to).forEach(id => {
        const a = from[id];
        const b = to[id];
        if (!a || !b) return;
        try {
          net.moveNode(id, a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k);
        } catch (e) { /* ignore */ }
      });
      if (t < 1) focusState.anim = requestAnimationFrame(step);
      else focusState.anim = null;
    };
    focusState.anim = requestAnimationFrame(step);
  }

  function clearFocus(opts) {
    opts = opts || {};
    cancelFocusAnim();
    const had = focusState.lockedId || focusState.previewId;
    focusState.lockedId = null;
    focusState.previewId = null;
    if (!had && !opts.force) return;
    unpinMain();
    resetVisualStyles(null);
    setAmbientPhysics('ambient');
  }

  function applyFocus(focusId, mode) {
    // mode: 'preview' | 'lock'
    if (!focusId) return;
    if (mode === 'preview' && focusState.lockedId) return;
    if (mode === 'preview' && focusState.previewId === focusId) return;
    if (mode === 'lock' && focusState.lockedId === focusId) return;

    if (mode === 'lock') {
      focusState.lockedId = focusId;
      focusState.previewId = null;
    } else {
      focusState.previewId = focusId;
    }

    // 先钉住主节点，再改样式，避免抽搐导致 hover 丢失
    pinMain(focusId);
    paintFocusVisual(focusId, mode);

    if (mode === 'lock') {
      setAmbientPhysics('focus');
      pushNeighborsOnce(focusId, mode);
    } else {
      // 预览：只高亮，不推开、不改全局物理力度，保证鼠标能稳得点中
      setAmbientPhysics('ambient');
    }
  }

  // 悬停预览：只样式，不推开（解决点不中）
  net.on('hoverNode', params => {
    if (!params || params.node == null) return;
    if (focusState.lockedId) return;
    applyFocus(String(params.node), 'preview');
  });
  net.on('blurNode', () => {
    if (focusState.lockedId) return;
    if (focusState.previewId) {
      focusState.previewId = null;
      cancelFocusAnim();
      unpinMain();
      resetVisualStyles(null);
      setAmbientPhysics('ambient');
    }
  });

  // 点击：锁定 / 解锁；空白取消
  net.on('click', async params => {
    const side = $('#graphSide');
    if (params.nodes && params.nodes.length) {
      const eid = String(params.nodes[0]);
      if (focusState.lockedId === eid) {
        clearFocus({ force: true });
      } else {
        applyFocus(eid, 'lock');
      }
      if (side) {
        side.innerHTML = '<div class="card-hint">加载来源…</div>';
        try {
          const info = await api('/entities/' + eid + '/sources');
          const name = info.entity ? info.entity.name : eid;
          const srcs = info.sources || [];
          const lockNote = focusState.lockedId === eid
            ? '<div class="card-hint" style="margin-top:6px">已锁定 · 主节点固定 · 再点该节点或空白取消</div>'
            : '';
          side.innerHTML = '<div class="graph-side-head"><strong>' + esc(name) + '</strong>' +
            (info.entity ? ' <span class="badge">' + esc(info.entity.type) + '</span>' : '') +
            '</div>' + lockNote +
            (srcs.length ? srcs.map(r =>
              '<div class="result-card" style="margin:8px 0"><div class="result-head">' +
              '<span class="result-doc">《' + esc(r.doc_name) + '》</span>' +
              (r.location ? '<span class="result-loc">' + esc(r.location) + '</span>' : '') +
              '</div><div class="result-text">' + esc(r.text) + '</div></div>'
            ).join('') : '<div class="empty-state">无来源片段</div>');
        } catch (e) {
          side.innerHTML = '<div class="banner-warn">' + esc(e.message) + '</div>';
        }
      }
      return;
    }
    if (focusState.lockedId || focusState.previewId) {
      clearFocus({ force: true });
      if (side) {
        side.innerHTML = '<div class="empty-state" style="padding:8px 0">' +
          '点一个节点看原文；再点一次或点空白取消锁定。</div>';
      }
    }
  });
}

/* ---------- 科目设置 ---------- */

function renderConfigTab(s) {
  $('#tabContent').innerHTML =
    '<div class="card"><h3>基本信息</h3>' +
    '<div class="form-grid">' +
    '<div class="form-row"><label>科目名称</label><input class="input" id="cfgName" value="' + esc(s.name) + '"></div>' +
    '<div class="form-row"><label>简介（可选）</label><input class="input" id="cfgDesc" placeholder="如：高中语文 · 必修上册" value="' + esc(s.description) + '"></div>' +
    '</div>' +
    '<div class="form-row"><label>标记</label><div class="emoji-grid" id="cfgEmoji">' +
    EMOJIS.map(e => '<button class="emoji-opt' + (e === s.icon ? ' sel' : '') + '" data-emoji="' + e + '">' + e + '</button>').join('') +
    '</div><div class="hint">短标签用于侧栏与标题，也可用科目名首字</div></div>' +
    '<div class="form-row"><label>颜色</label><div class="color-row" id="cfgColor">' +
    COLORS.map(c => '<button class="color-opt' + (c === s.color ? ' sel' : '') + '" data-color="' + c + '" style="background:' + c + '"></button>').join('') +
    '</div></div></div>' +

    '<div class="card"><h3>模型</h3>' +
    '<div class="card-hint">默认跟随全局设置；可为本科目单独指定</div>' +
    (state.providers.length === 0
      ? '<div class="banner-warn">还没有服务商，请先到设置添加</div>' : '') +
    '<div class="form-row"><label>向量模型</label>' +
    modelPickerHtml('subjEmbed', s.embed_provider_id, s.embed_model, true, true) +
    '<div class="hint">更换向量模型后需重建索引</div></div>' +
    '<div class="form-row"><label>对话模型</label>' +
    modelPickerHtml('subjChat', s.chat_provider_id, s.chat_model, true) + '</div>' +
    '<div class="form-row"><label>检索片段数 top_k</label>' +
    '<input class="input" id="cfgTopK" type="number" min="1" max="20" value="' + (s.top_k || 5) + '" style="max-width:120px">' +
    '<div class="hint">每次回答引用的资料片段数量</div></div>' +
    '<div class="form-row"><label>系统提示词（可选）</label>' +
    '<textarea class="input" id="cfgPrompt" placeholder="留空使用默认提示词">' + esc(s.system_prompt) + '</textarea></div>' +
    '<button class="btn btn-primary" id="cfgSaveBtn">保存</button></div>' +

    '<div class="card"><h3 style="color:var(--danger)">危险区域</h3>' +
    '<div class="form-inline" style="justify-content:space-between">' +
    '<span style="color:var(--muted);font-size:13px">删除科目及其资料、索引与对话，不可恢复</span>' +
    '<button class="btn btn-danger" id="cfgDeleteBtn">删除科目</button></div></div>';

  let selEmoji = s.icon, selColor = s.color;
  $$('#cfgEmoji .emoji-opt').forEach(btn => {
    btn.onclick = () => {
      selEmoji = btn.dataset.emoji;
      $$('#cfgEmoji .emoji-opt').forEach(b => b.classList.toggle('sel', b === btn));
    };
  });
  $$('#cfgColor .color-opt').forEach(btn => {
    btn.onclick = () => {
      selColor = btn.dataset.color;
      $$('#cfgColor .color-opt').forEach(b => b.classList.toggle('sel', b === btn));
    };
  });
  bindModelPicker('subjEmbed', 'embed');
  bindModelPicker('subjChat', 'chat');

  $('#cfgSaveBtn').onclick = async () => {
    const oldEmbed = (s.embed_provider_id || '') + '|' + (s.embed_model || '');
    const body = {
      name: $('#cfgName').value.trim(),
      description: $('#cfgDesc').value.trim(),
      icon: selEmoji,
      color: selColor,
      embed_provider_id: $('#subjEmbedProvider').value,
      embed_model: $('#subjEmbedModel').value.trim(),
      chat_provider_id: $('#subjChatProvider').value,
      chat_model: $('#subjChatModel').value.trim(),
      top_k: parseInt($('#cfgTopK').value, 10) || 5,
      system_prompt: $('#cfgPrompt').value.trim(),
    };
    try {
      const updated = await api('/subjects/' + s.id, { method: 'PUT', body });
      const i = state.subjects.findIndex(x => x.id === s.id);
      if (i >= 0) state.subjects[i] = updated;
      toast('设置已保存');
      renderSidebar();
      const newEmbed = (updated.embed_provider_id || '') + '|' + (updated.embed_model || '');
      if (oldEmbed !== newEmbed && updated.chunk_count > 0) {
        const ok = await confirmModal({
          title: '向量化模型已更改',
          text: '现有资料是用旧模型向量化的，需要重建索引才能正常检索。是否立即重建？',
          okText: '立即重建',
        });
        if (ok) {
          try {
            const r = await api('/subjects/' + s.id + '/reindex', { method: 'POST' });
            toast('已开始重建 ' + r.started + ' 份资料的索引，可到「资料库」查看进度');
          } catch (e) { toast(e.message, 'err'); }
        }
      }
      renderSubject();
    } catch (e) { toast(e.message, 'err'); }
  };

  $('#cfgDeleteBtn').onclick = async () => {
    const ok = await confirmModal({
      title: '删除科目「' + s.name + '」',
      text: '将删除该科目的 ' + s.doc_count + ' 份资料、' + s.chunk_count +
        ' 个知识片段和全部对话记录，不可恢复。确定删除吗？',
      danger: true, okText: '确认删除',
    });
    if (!ok) return;
    try {
      await api('/subjects/' + s.id, { method: 'DELETE' });
      await loadCore();
      toast('科目已删除');
      nav({ type: 'home' });
    } catch (e) { toast(e.message, 'err'); }
  };
}

/* ================= 新建科目 ================= */

function newSubjectModal() {
  let selEmoji = EMOJIS[0], selColor = COLORS[0];
  const m = openModal(
    '<h2>新建科目</h2>' +
    '<div class="form-row"><label>科目名称</label>' +
    '<input class="input" id="nsName" placeholder="如：语文、高等数学、数据结构"></div>' +
    '<div class="form-row"><label>标记</label><div class="emoji-grid" id="nsEmoji">' +
    EMOJIS.map((e, i) => '<button class="emoji-opt' + (i === 0 ? ' sel' : '') + '" data-emoji="' + e + '">' + e + '</button>').join('') +
    '</div><div class="hint">用于侧栏显示的短标签</div></div>' +
    '<div class="form-row"><label>颜色</label><div class="color-row" id="nsColor">' +
    COLORS.map((c, i) => '<button class="color-opt' + (i === 0 ? ' sel' : '') + '" data-color="' + c + '" style="background:' + c + '"></button>').join('') +
    '</div></div>' +
    '<div class="form-row"><label>简介（可选）</label>' +
    '<input class="input" id="nsDesc" placeholder="如：2026 春季学期"></div>' +
    '<div class="modal-actions">' +
    '<button class="btn" data-act="cancel">取消</button>' +
    '<button class="btn btn-primary" data-act="create">创建</button></div>'
  );
  $$('#nsEmoji .emoji-opt', m.overlay).forEach(btn => {
    btn.onclick = () => {
      selEmoji = btn.dataset.emoji;
      $$('#nsEmoji .emoji-opt', m.overlay).forEach(b => b.classList.toggle('sel', b === btn));
    };
  });
  $$('#nsColor .color-opt', m.overlay).forEach(btn => {
    btn.onclick = () => {
      selColor = btn.dataset.color;
      $$('#nsColor .color-opt', m.overlay).forEach(b => b.classList.toggle('sel', b === btn));
    };
  });
  $('[data-act=cancel]', m.overlay).onclick = m.close;
  $('[data-act=create]', m.overlay).onclick = async () => {
    const name = $('#nsName', m.overlay).value.trim();
    if (!name) { toast('请填写科目名称', 'err'); return; }
    try {
      const s = await api('/subjects', {
        method: 'POST',
        body: { name, icon: selEmoji, color: selColor, description: $('#nsDesc', m.overlay).value.trim() },
      });
      m.close();
      await loadCore();
      toast('科目「' + name + '」已创建，上传资料开始学习吧');
      openSubject(s.id, 'docs');
    } catch (e) { toast(e.message, 'err'); }
  };
  setTimeout(() => $('#nsName', m.overlay).focus(), 50);
}

/* ================= 启动 ================= */

async function init() {
  setBootText('启动');
  $('#addSubjectBtn').onclick = newSubjectModal;
  $('#homeBtn').onclick = () => nav({ type: 'home' });
  $('#settingsBtn').onclick = () => nav({ type: 'settings' });
  const bootStarted = Date.now();
  try {
    await loadCore();
    setBootText('就绪');
  } catch (e) {
    setBootText('启动失败');
    hideBootSplash();
    $('#main').innerHTML = '<div class="page"><div class="banner-warn">无法连接后端：' +
      esc(e.message) + '</div></div>';
    return;
  }
  nav({ type: 'home' });
  const remain = Math.max(0, 700 - (Date.now() - bootStarted));
  setTimeout(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => hideBootSplash());
    });
  }, remain);
  const idle = window.requestIdleCallback || function (cb) { setTimeout(cb, 1200); };
  idle(() => { ensureVisNetwork().catch(() => {}); });
}

init();
