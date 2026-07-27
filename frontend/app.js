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
const EMOJIS = ['📚', '📖', '✏️', '🧪', '🧮', '🌍', '💻', '🎨', '🎵', '🏛️', '🧠', '⚖️', '💊', '🗣️', '📐', '⚽'];
const COLORS = ['#4F5BD5', '#D5484F', '#E8871E', '#2F9E63', '#0E9BB5', '#8A5CD6', '#D6558E', '#5B7083'];

const state = {
  providers: [],
  settings: {},
  subjects: [],
  view: { type: 'home' },      // {type:'home'|'settings'|'subject', sid, tab}
  convs: [],
  convId: null,
  useRag: true,
  sending: false,
  modelCache: {},              // provider_id -> [model,...]
};
let docsPollTimer = null;

function subjectById(sid) { return state.subjects.find(s => s.id === sid); }
function providerById(pid) { return state.providers.find(p => p.id === pid); }

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
  state.view = view;
  renderSidebar();
  renderMain();
}

function renderSidebar() {
  const list = $('#subjectList');
  list.innerHTML = state.subjects.map(s => {
    const active = state.view.type === 'subject' && state.view.sid === s.id;
    return '<button class="subject-item' + (active ? ' active' : '') + '" data-sid="' + s.id + '">' +
      '<span class="subject-icon" style="background:' + esc(s.color) + '22">' + esc(s.icon) + '</span>' +
      '<span class="s-name">' + esc(s.name) + '</span>' +
      '<span class="s-count">' + s.doc_count + '</span></button>';
  }).join('') || '<div style="padding:10px;color:var(--muted);font-size:12.5px">还没有科目，点下方按钮创建</div>';
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
  const totalChunks = state.subjects.reduce((a, s) => a + s.chunk_count, 0);
  const st = state.settings;
  const steps = [
    {
      done: state.providers.length > 0,
      title: '添加 API 服务商',
      desc: '填入任意 OpenAI 兼容服务的 Base URL 和 API Key（OpenAI / DeepSeek / SiliconFlow / 智谱 / Ollama 等）',
      btn: '去添加', act: () => nav({ type: 'settings' }),
    },
    {
      done: !!(st.default_embed_model && st.default_chat_model),
      title: '选择默认模型',
      desc: '设置默认的向量化（Embedding）模型和对话模型，各科目也可以单独覆盖',
      btn: '去设置', act: () => nav({ type: 'settings' }),
    },
    {
      done: state.subjects.length > 0,
      title: '创建科目',
      desc: '比如「语文」「高数」「专业课」，每个科目有独立的资料库和对话记录',
      btn: '新建科目', act: newSubjectModal,
    },
    {
      done: totalDocs > 0,
      title: '上传资料，开始学习',
      desc: '把 PPT、PDF、Word、笔记拖进科目资料库，然后就可以针对资料提问了',
      btn: null,
    },
  ];
  $('#main').innerHTML = '<div class="page">' +
    '<div class="page-title">👋 欢迎回来</div>' +
    '<div class="page-desc">知库 — 把你的学习资料变成可以对话的知识库</div>' +
    '<div class="stat-row">' +
    '<div class="stat-tile"><div class="num">' + state.subjects.length + '</div><div class="lbl">科目</div></div>' +
    '<div class="stat-tile"><div class="num">' + totalDocs + '</div><div class="lbl">学习资料</div></div>' +
    '<div class="stat-tile"><div class="num">' + totalChunks + '</div><div class="lbl">知识片段</div></div>' +
    '</div>' +
    '<div class="card"><h3>使用步骤</h3><div class="step-list">' +
    steps.map((s, i) =>
      '<div class="step-item' + (s.done ? ' done' : '') + '">' +
      '<div class="step-num">' + (s.done ? '✓' : i + 1) + '</div>' +
      '<div class="step-body"><div class="step-title">' + s.title + '</div>' +
      '<div class="step-desc">' + s.desc + '</div></div>' +
      (s.btn && !s.done ? '<button class="btn btn-sm" data-step="' + i + '">' + s.btn + '</button>' : '') +
      '</div>'
    ).join('') +
    '</div></div></div>';
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
    (allowLocal ? '<option value="local"' + (isLocal ? ' selected' : '') + '>🖥️ 内置本地模型</option>' : '') +
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
    '<div class="page-title">⚙️ 全局设置</div>' +
    '<div class="page-desc">管理 API 服务商与默认模型，所有配置仅保存在本机</div>' +
    '<div class="card"><h3>API 服务商</h3>' +
    '<div class="card-hint">任何 OpenAI 兼容接口均可：OpenAI、DeepSeek、SiliconFlow、智谱、月之暗面、本地 Ollama 等。' +
    '每个服务商可配置自己的对话模型和向量模型，点「启用」一键切换当前使用哪一家</div>' +
    '<div id="providerList"></div>' +
    '<button class="btn btn-ghost" id="addProviderBtn" style="width:100%;justify-content:center">＋ 添加服务商</button>' +
    '</div>' +
    '<div class="card"><h3>当前使用的模型（高级）</h3>' +
    '<div class="card-hint">通常不用动这里——点上方服务商卡片的「启用」即可整套切换。' +
    '需要混合搭配时（如对话用 A 家、向量用 B 家）才在这里单独调整；各科目还可在「科目设置」中覆盖</div>' +
    '<div class="form-row"><label>向量化模型（Embedding，用于资料入库和检索）</label>' +
    modelPickerHtml('defEmbed', st.default_embed_provider_id, st.default_embed_model, false, true) +
    '<div class="hint">可选「🖥️ 内置本地模型」免 API 离线运行；在线模型如 text-embedding-3-small、BAAI/bge-m3 等</div></div>' +
    '<div class="form-row"><label>对话模型（用于学习问答）</label>' +
    modelPickerHtml('defChat', st.default_chat_provider_id, st.default_chat_model, false) +
    '<div class="hint">如 gpt-4o-mini、deepseek-chat、glm-4-flash 等</div></div>' +
    '<button class="btn btn-primary" id="saveSettingsBtn">保存调整</button>' +
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
        ? '<span class="model-chip' + (act.chatActive ? ' on' : '') + '">💬 ' + esc(p.chat_model) + '</span>'
        : '<span class="model-chip empty">💬 未配置对话模型</span>') +
      (p.embed_model
        ? '<span class="model-chip' + (act.embedActive ? ' on' : '') + '">🧬 ' + esc(p.embed_model) + '</span>'
        : '<span class="model-chip empty">🧬 未配置向量模型</span>') +
      '</div>';
    return '<div class="provider-card' + (act.fullActive ? ' active' : '') + '">' +
      '<div class="provider-info">' +
      '<div class="provider-name">' + esc(p.name) +
      (act.fullActive ? ' <span class="badge ok">✓ 使用中</span>' : '') + '</div>' +
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
    '<div class="provider-name">🖥️ 本地向量模型（内置）' +
    (localActive ? ' <span class="badge ok">✓ 使用中</span>' : '') + '</div>' +
    '<div class="provider-key">免 API Key · 数据不出本机 · 负责资料向量化，对话仍用上面的在线模型</div>' +
    '<div class="provider-models">' +
    '<span class="model-chip' + (localActive ? ' on' : '') + '">🧬 ' + LOCAL_EMBED_MODEL + '</span>' +
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
    '<div style="margin-bottom:10px"><button class="btn btn-sm" id="pvFetch">🔄 获取模型列表</button>' +
    '<span class="hint" id="pvFetchStatus" style="margin-left:8px"></span></div>' +
    '<div class="form-inline" style="margin-bottom:8px">' +
    '<span style="min-width:88px;font-size:13px">💬 对话模型</span>' +
    '<input class="input" id="pvChatModel" list="pvModelList" placeholder="如 deepseek-chat，用于学习问答" value="' +
    esc(p ? p.chat_model : '') + '"></div>' +
    '<div class="form-inline">' +
    '<span style="min-width:88px;font-size:13px">🧬 向量模型</span>' +
    '<input class="input" id="pvEmbedModel" list="pvModelList" placeholder="如 BAAI/bge-m3，用于资料检索" value="' +
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
  ['chat', '💬 学习问答'],
  ['docs', '📁 资料库'],
  ['search', '🔍 检索测试'],
  ['config', '⚙️ 科目设置'],
];

function renderSubject() {
  const s = subjectById(state.view.sid);
  if (!s) { nav({ type: 'home' }); return; }
  const tab = state.view.tab;
  $('#main').innerHTML = '<div class="page">' +
    '<div class="subj-head">' +
    '<div class="subj-head-icon" style="background:' + esc(s.color) + '22">' + esc(s.icon) + '</div>' +
    '<div><h1>' + esc(s.name) + '</h1>' +
    '<div class="subj-meta">' + s.doc_count + ' 份资料 · ' + s.chunk_count + ' 个知识片段 · ' +
    s.conv_count + ' 组对话' + (s.description ? ' · ' + esc(s.description) : '') + '</div></div></div>' +
    '<div class="tabs">' +
    TABS.map(([k, label]) =>
      '<button class="tab' + (tab === k ? ' active' : '') + '" data-tab="' + k + '">' + label + '</button>'
    ).join('') +
    '</div><div id="tabContent"></div></div>';

  $$('.tab').forEach(el => {
    el.onclick = () => nav({ type: 'subject', sid: s.id, tab: el.dataset.tab });
  });

  if (tab === 'docs') renderDocsTab(s);
  else if (tab === 'chat') renderChatTab(s);
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
    '<button class="btn btn-primary" id="uploadBtn">⬆️ 上传资料</button>' +
    '<span class="doc-hint">支持 PDF · PPTX · DOCX · TXT · Markdown，可多选</span>' +
    '<span class="flex-spacer"></span>' +
    '<button class="btn btn-sm" id="reindexBtn" title="用当前向量模型对全部资料重新向量化">🔄 重建索引</button>' +
    '</div>' +
    '<input type="file" id="fileInput" multiple accept=".pdf,.pptx,.docx,.txt,.md,.markdown" style="display:none">' +
    '<div class="dropzone" id="dropzone"><div class="dz-icon">📥</div>' +
    '把文件拖到这里，或点击选择文件</div>' +
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

  refreshDocs(s.id);
}

async function uploadFiles(sid, files) {
  const btn = $('#uploadBtn');
  if (btn && btn.disabled) return;  // 上传进行中，避免重复提交
  const fd = new FormData();
  for (const f of files) fd.append('files', f, f.name);
  if (btn) { btn.disabled = true; btn.textContent = '⏳ 上传中…'; }
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
    if (b) { b.disabled = false; b.textContent = '⬆️ 上传资料'; }
    const d = $('#dropzone');
    if (d) d.style.pointerEvents = '';
  }
}

async function refreshDocs(sid) {
  if (state.view.type !== 'subject' || state.view.sid !== sid || state.view.tab !== 'docs') return;
  let docs;
  try { docs = await api('/subjects/' + sid + '/documents'); }
  catch (e) { return; }
  const wrap = $('#docTableWrap');
  if (!wrap) return;

  if (!docs.length) {
    wrap.innerHTML = '<div class="empty-state"><div class="big">🗂️</div>' +
      '把这门课的课件、讲义、笔记都传上来吧</div>';
  } else {
    wrap.innerHTML = '<table class="doc-table"><thead><tr>' +
      '<th style="width:56px">类型</th><th>文件名</th><th>大小</th><th>片段</th><th>状态</th><th>上传时间</th><th style="width:44px"></th>' +
      '</tr></thead><tbody>' +
      docs.map(d => {
        let status;
        if (d.status === 'ready') {
          status = '<span class="badge ok">✓ 已就绪</span>';
        } else if (d.status === 'error') {
          status = '<span class="badge err" title="' + esc(d.error) + '">✕ 失败</span> ' +
            '<button class="btn btn-sm" data-retry="' + d.id + '">重试</button>' +
            '<div class="err-text">' + esc(d.error) + '</div>';
        } else {
          const pct = d.total_chunks ? Math.round(d.processed_chunks / d.total_chunks * 100) : 0;
          status = '<div class="progress-wrap"><span class="spinner"></span>' +
            (d.total_chunks
              ? '<div class="progress-bar"><div style="width:' + pct + '%"></div></div>' +
                '<span class="progress-txt">' + pct + '%</span>'
              : '<span class="progress-txt">解析中…</span>') +
            '</div>';
        }
        return '<tr>' +
          '<td>' + ftBadge(d.filetype) + '</td>' +
          '<td class="doc-name"><a href="/api/documents/' + d.id + '/file" target="_blank" title="' +
          esc(d.filename) + '">' + esc(d.filename) + '</a></td>' +
          '<td>' + fmtSize(d.size) + '</td>' +
          '<td>' + (d.chunk_count || '-') + '</td>' +
          '<td>' + status + '</td>' +
          '<td style="color:var(--muted);font-size:12.5px">' + fmtTime(d.created_at) + '</td>' +
          '<td><button class="btn btn-sm" style="border:none" data-del="' + d.id + '" title="删除">🗑️</button></td>' +
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

  const hasProcessing = docs.some(d => d.status === 'processing');
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
    '<div class="conv-panel-head"><button class="btn" id="newConvBtn">＋ 新对话</button></div>' +
    '<div class="conv-items" id="convItems"></div></div>' +
    '<div class="chat-panel">' +
    '<div class="chat-msgs" id="chatMsgs"></div>' +
    '<div class="composer">' +
    '<div class="composer-opts"><label><input type="checkbox" id="ragToggle"' +
    (state.useRag ? ' checked' : '') + '> 结合资料库回答（引用来源）</label></div>' +
    '<div class="composer-box">' +
    '<textarea id="chatInput" rows="1" placeholder="向「' + esc(s.name) + '」资料库提问，Enter 发送，Shift+Enter 换行"></textarea>' +
    '<button class="btn btn-primary send-btn" id="sendBtn"' + (state.sending ? ' disabled' : '') + '>发送</button>' +
    '</div></div></div></div>';

  $('#ragToggle').onchange = e => { state.useRag = e.target.checked; };
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
    '<button class="sources-toggle">📎 参考来源 (' + sources.length + ') ▾</button>' +
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
    box.innerHTML = '<div class="chat-empty"><div class="big">💬</div>' +
      '<div>开始提问吧，AI 会结合你上传的资料回答</div>' +
      '<div style="font-size:12px">例如：帮我总结第三章的重点 / 这个概念是什么意思？</div></div>';
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
    body: JSON.stringify({ message, use_rag: useRag }),
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
      '<button class="think-toggle">💭 思考中…</button>' +
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
      thinkToggle.textContent = '💭 思考过程（点击展开）';
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
      thinkToggle.textContent = '💭 思考过程';
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
        '<div class="banner-warn" style="margin:8px 0 0">⚠️ ' + esc(errMsg) + '</div>');
      if (!acc.trim()) restoreInput();
    }
    if (extraEl) {
      extraEl.innerHTML = sourcesHtml(sources, warning);
      bindSourceToggles(extraEl);
    }
  } catch (e) {
    if (contentEl) {
      contentEl.innerHTML = (acc ? md(acc) : '') +
        '<div class="banner-warn" style="margin:8px 0 0">⚠️ ' + esc(e.message) + '</div>';
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
      const data = await api('/subjects/' + s.id + '/search', {
        method: 'POST',
        body: { query: q, top_k: parseInt($('#searchTopK').value, 10) },
      });
      let html = '';
      if (data.warning) html += '<div class="banner-warn">' + esc(data.warning) + '</div>';
      if (!data.results.length) {
        html += '<div class="empty-state"><div class="big">🔍</div>没有找到相关片段，试试上传更多资料</div>';
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

/* ---------- 科目设置 ---------- */

function renderConfigTab(s) {
  $('#tabContent').innerHTML =
    '<div class="card"><h3>基本信息</h3>' +
    '<div class="form-grid">' +
    '<div class="form-row"><label>科目名称</label><input class="input" id="cfgName" value="' + esc(s.name) + '"></div>' +
    '<div class="form-row"><label>简介（可选）</label><input class="input" id="cfgDesc" placeholder="如：高中语文 · 必修上册" value="' + esc(s.description) + '"></div>' +
    '</div>' +
    '<div class="form-row"><label>图标</label><div class="emoji-grid" id="cfgEmoji">' +
    EMOJIS.map(e => '<button class="emoji-opt' + (e === s.icon ? ' sel' : '') + '" data-emoji="' + e + '">' + e + '</button>').join('') +
    '</div></div>' +
    '<div class="form-row"><label>颜色</label><div class="color-row" id="cfgColor">' +
    COLORS.map(c => '<button class="color-opt' + (c === s.color ? ' sel' : '') + '" data-color="' + c + '" style="background:' + c + '"></button>').join('') +
    '</div></div></div>' +

    '<div class="card"><h3>模型配置</h3>' +
    '<div class="card-hint">默认跟随全局设置；如需为本科目单独指定模型，在这里选择</div>' +
    (state.providers.length === 0
      ? '<div class="banner-warn">还没有添加任何 API 服务商，请先到「全局设置」添加</div>' : '') +
    '<div class="form-row"><label>向量化模型（Embedding）</label>' +
    modelPickerHtml('subjEmbed', s.embed_provider_id, s.embed_model, true, true) +
    '<div class="hint">⚠️ 更换向量化模型后需要「重建索引」，否则新旧向量不一致会影响检索</div></div>' +
    '<div class="form-row"><label>对话模型</label>' +
    modelPickerHtml('subjChat', s.chat_provider_id, s.chat_model, true) + '</div>' +
    '<div class="form-row"><label>检索片段数（top_k）</label>' +
    '<input class="input" id="cfgTopK" type="number" min="1" max="20" value="' + (s.top_k || 5) + '" style="max-width:120px">' +
    '<div class="hint">每次回答时检索的资料片段数量，越大上下文越多</div></div>' +
    '<div class="form-row"><label>自定义系统提示词（可选）</label>' +
    '<textarea class="input" id="cfgPrompt" placeholder="留空使用默认提示词。可以写：你是我的语文老师，讲解时先给结论再举例…">' + esc(s.system_prompt) + '</textarea></div>' +
    '<button class="btn btn-primary" id="cfgSaveBtn">保存设置</button></div>' +

    '<div class="card"><h3 style="color:var(--danger)">危险操作</h3>' +
    '<div class="form-inline" style="justify-content:space-between">' +
    '<span style="color:var(--muted);font-size:13px">删除科目将同时删除其全部资料、索引和对话记录，不可恢复</span>' +
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
    '<div class="form-row"><label>图标</label><div class="emoji-grid" id="nsEmoji">' +
    EMOJIS.map((e, i) => '<button class="emoji-opt' + (i === 0 ? ' sel' : '') + '" data-emoji="' + e + '">' + e + '</button>').join('') +
    '</div></div>' +
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
  $('#addSubjectBtn').onclick = newSubjectModal;
  $('#homeBtn').onclick = () => nav({ type: 'home' });
  $('#settingsBtn').onclick = () => nav({ type: 'settings' });
  try {
    await loadCore();
  } catch (e) {
    $('#main').innerHTML = '<div class="page"><div class="banner-warn">无法连接后端服务：' +
      esc(e.message) + '</div></div>';
    return;
  }
  nav({ type: 'home' });
}

init();
