// LocModel —— 第三方大模型 API（用户自己的 Key）+ 模型来源切换（本地 / API）
// 请求经 Rust 转发（避免跨域），流式结果通过 api-stream 事件回来；Key 只保存在本机
'use strict';

const API_PRESETS = [
  { name: 'DeepSeek', base_url: 'https://api.deepseek.com/v1', models: ['deepseek-chat', 'deepseek-reasoner'], site: 'https://platform.deepseek.com/api_keys' },
  { name: '阿里通义（百炼）', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-plus', 'qwen-max'], site: 'https://bailian.console.aliyun.com/' },
  { name: 'Kimi（月之暗面）', base_url: 'https://api.moonshot.cn/v1', models: [], site: 'https://platform.moonshot.cn/console/api-keys' },
  { name: '智谱 GLM', base_url: 'https://open.bigmodel.cn/api/paas/v4', models: [], site: 'https://open.bigmodel.cn/usercenter/apikeys' },
  { name: '硅基流动', base_url: 'https://api.siliconflow.cn/v1', models: [], site: 'https://cloud.siliconflow.cn/account/ak' },
  { name: 'OpenRouter', base_url: 'https://openrouter.ai/api/v1', models: [], site: 'https://openrouter.ai/keys' },
  { name: 'OpenAI', base_url: 'https://api.openai.com/v1', models: [], site: 'https://platform.openai.com/api-keys' },
  { name: '自定义（OpenAI 兼容接口）', base_url: '', models: [], site: '' },
];

S.apis = [];
S.src = store.get('modelSrc', { type: 'local' }); // { type: 'local' } 或 { type: 'api', id, model }
S.srcMenu = false;

async function loadApis() {
  try { S.apis = await invoke('api_list'); } catch { S.apis = []; }
  if (S.src.type === 'api' && !apiOf(S.src.id)) setSrc({ type: 'local' });
}
const apiOf = (id) => S.apis.find((a) => a.id === id);
function setSrc(src) {
  S.src = src;
  store.set('modelSrc', src);
}
const usingApi = () => S.src.type === 'api' && !!apiOf(S.src.id);
/** 当前模型来源能不能直接用 */
function srcReady() {
  if (!usingApi()) return !!S.server.ready;
  return !!apiOf(S.src.id).key;
}
function srcName() {
  if (!usingApi()) return S.server.running ? S.server.model_name : '本地模型';
  const a = apiOf(S.src.id);
  return `${a.name} · ${S.src.model || a.model}`;
}

// ------------------------------------------------------------------ 请求：本地 llama-server 或第三方 API
const API_STREAMS = new Map(); // 请求编号 → 回调
listen('api-stream', (e) => API_STREAMS.get(e.payload.id)?.(e.payload));

// API 只认标准参数；llama.cpp 专有的（top_k、min_p、repeat_penalty、思考开关）去掉，免得被拒绝
const STD_PARAMS = ['temperature', 'top_p', 'max_tokens', 'presence_penalty', 'frequency_penalty', 'seed', 'stop'];

/** 发起一次对话请求，返回和 fetch 一样的对象（ok / status / text() / body.getReader()） */
async function llmFetch(body, signal) {
  if (!usingApi()) {
    return fetch(`http://127.0.0.1:${S.server.port}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal, body: JSON.stringify(body) });
  }
  const b = { messages: body.messages, stream: true };
  if (body.tools) b.tools = body.tools;
  for (const k of STD_PARAMS) if (body[k] !== undefined) b[k] = body[k];
  return apiFetch(S.src.id, S.src.model || '', b, signal);
}

function apiFetch(provider, model, body, signal) {
  const id = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const enc = new TextEncoder();
  let ctrl;
  const stream = new ReadableStream({ start(c) { ctrl = c; } });
  const fail = (t) => ({ ok: false, status: 0, apiError: true, text: async () => t });
  return new Promise((resolve, reject) => {
    let started = false;
    const start = () => {
      if (!started) {
        started = true;
        resolve({ ok: true, status: 200, body: stream, text: async () => '' });
      }
    };
    const end = () => API_STREAMS.delete(id);
    API_STREAMS.set(id, (p) => {
      if (p.kind === 'data') {
        start();
        ctrl.enqueue(enc.encode(p.text));
      } else if (p.kind === 'end') {
        start();
        try { ctrl.close(); } catch {}
        end();
      } else {
        end();
        if (!started) {
          started = true;
          resolve(fail(p.text));
        } else {
          try { ctrl.error(new Error(p.text)); } catch {}
        }
      }
    });
    signal?.addEventListener('abort', () => {
      invoke('api_abort', { reqId: id }).catch(() => {});
      end();
      const err = new DOMException('aborted', 'AbortError');
      if (!started) {
        started = true;
        reject(err);
      } else {
        try { ctrl.error(err); } catch {}
      }
    });
    invoke('api_stream', { reqId: id, provider, model, body }).catch((e) => {
      end();
      if (!started) {
        started = true;
        resolve(fail(String(e)));
      }
    });
  });
}

/** 不需要流式显示时：一次拿到完整回复（改写画图提示词等） */
async function llmComplete(messages, { maxTokens = 400, temperature = 0.6, signal } = {}) {
  const res = await llmFetch({ messages, stream: true, max_tokens: maxTokens, temperature, chat_template_kwargs: { enable_thinking: false } }, signal);
  if (!res.ok) throw new Error(await res.text());
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const l of lines) {
      const t = l.trim();
      if (!t.startsWith('data:')) continue;
      try { out += JSON.parse(t.slice(5)).choices?.[0]?.delta?.content || ''; } catch {}
    }
  }
  return out.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

// ------------------------------------------------------------------ 模型来源切换（对话页、Agent 页顶部）
function srcButton() {
  const api = usingApi();
  const sv = S.server;
  const dot = api ? '<span class="pulse live" style="background:#5B8DEF"></span>' : `<span class="pulse ${sv.ready ? 'live' : ''}" ${sv.running ? '' : 'style="background:#B5AFA1"'}></span>`;
  const label = api ? esc(srcName()) : S.run.starting && S.run.quickName ? `正在加载 ${esc(S.run.quickName)}…` : sv.running ? `${esc(sv.model_name)}${sv.ready ? '' : '（加载中）'}` : S.pausedChat ? '对话模型已暂停（显存让给了画图）' : '本地模型：还没有启动';
  return `<div class="src-wrap"><button class="btn src-btn" data-act="toggleSrcMenu" aria-expanded="${S.srcMenu}" title="切换模型：点一下就加载">${dot}${label}<span class="caret">▾</span></button>${S.srcMenu ? srcMenuHtml() : ''}</div>`;
}
function srcMenuHtml() {
  const sv = S.server;
  // 本地模型：下载过的都列出来（不用先去「运行」页），点一下就加载并切换过去
  const list = (S.local || []).filter((m) => !m.info?.is_diffusion);
  const cur = !usingApi() && sv.running ? sv.model_path : '';
  const busy = S.run.starting;
  const locals = S.local === null
    ? '<div class="src-empty">正在读取本地模型…</div>'
    : list.length
      ? list
          .map((m) => {
            const on = m.path === cur;
            const loading = busy && S.run.path === m.path;
            const meta = [m.info?.file_type, m.info?.total_bytes ? fmtSize(m.info.total_bytes) : '', m.plan?.tier_label].filter(Boolean).join(' · ');
            const state = loading ? '正在加载…' : on ? (sv.ready ? '使用中' : '加载中…') : '';
            return `<button class="src-item local ${on ? 'on' : ''}" data-act="quickLoad" data-path="${esc(m.path)}" ${busy ? 'disabled' : ''} title="${esc(m.path)}"><b>${esc(m.name)}</b><span>${esc(meta)}${state ? `<em class="src-state">${state}</em>` : ''}</span></button>`;
          })
          .join('')
      : '<div class="src-empty">还没有下载对话模型。</div>';
  // 第三方 API：只有在设置里填过 Key 的才显示
  const apis = S.apis
    .filter((a) => a.key)
    .map((a) => {
      const models = [...new Set([a.model, ...(a.models || [])].filter(Boolean))].slice(0, 30);
      return `<div class="src-group">${esc(a.name)}</div>${models
        .map((m) => `<button class="src-item api ${usingApi() && S.src.id === a.id && (S.src.model || a.model) === m ? 'on' : ''}" data-act="pickSrc" data-type="api" data-id="${esc(a.id)}" data-model="${esc(m)}"><b>${esc(m)}</b></button>`)
        .join('')}`;
    })
    .join('');
  return `<div class="src-menu" role="menu"><div class="src-group first">本地模型</div>${locals}${apis}
    <button class="src-item manage" data-act="srcMoreModels">＋ 下载更多模型</button></div>`;
}

// ------------------------------------------------------------------ 设置页：第三方 API
function apisSection() {
  const rows = S.apis.length
    ? S.apis
        .map((a) => `<div class="between api-row"><div><b>${esc(a.name)}</b> <span class="muted" style="font-size:12.5px">${esc(a.model || '未选模型')}${a.key ? '' : ' · 未填 Key'}</span><div class="help mono" style="font-size:11.5px">${esc(a.base_url)}</div></div>
          <div class="row" style="gap:6px"><button class="btn sm" data-act="editApi" data-id="${esc(a.id)}">编辑</button><button class="btn sm" data-act="delApi" data-id="${esc(a.id)}">删除</button></div></div>`)
        .join('')
    : '<div class="muted" style="font-size:13px">还没有添加。本地模型显存不够、或者要跑 Agent 长任务时，可以接入 DeepSeek、通义千问、Kimi、智谱等大模型 API（用你自己的 Key，按它们的价格付费）。</div>';
  return `<section class="card form" id="apiSection">
      <div class="between"><h2 style="font-size:17px">第三方 API</h2><button class="btn sm primary" data-act="editApi">添加 API</button></div>
      ${rows}
      <div class="help">Key 只保存在这台电脑上，对话和 Agent 都可以在顶部切换用本地模型还是 API。</div>
    </section>`;
}

function apiEditHtml(m) {
  const d = m.api;
  const preset = API_PRESETS[m.preset] || API_PRESETS[API_PRESETS.length - 1];
  const opts = API_PRESETS.map((p, i) => `<option value="${i}" ${i === m.preset ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  const models = [...new Set([...(d.models || []), ...(preset.models || [])])];
  return `<h2>${m.isNew ? '添加' : '编辑'}第三方 API</h2><div class="stack" style="gap:14px">
    ${m.isNew ? `<div class="field"><label for="ap-preset">服务商</label><select class="input" id="ap-preset" data-change="apiPreset">${opts}</select></div>` : ''}
    <div class="field"><label for="ap-name">名称</label><input class="input" id="ap-name" value="${esc(d.name)}"></div>
    <div class="field"><label for="ap-url">接口地址（OpenAI 兼容）</label><input class="input mono" id="ap-url" value="${esc(d.base_url)}" placeholder="https://…/v1"></div>
    <div class="field"><label for="ap-key">API Key</label><div class="row"><input class="input mono" id="ap-key" type="password" style="flex:1" value="${esc(d.key)}" placeholder="sk-…" autocomplete="off"><button class="btn sm" type="button" data-act="toggleKey">显示</button></div>
      ${preset.site && m.isNew ? `<div class="help">还没有 Key？<a href="#" data-act="extLink" data-url="${esc(preset.site)}">去 ${esc(preset.name)} 官网申请</a></div>` : ''}</div>
    <div class="field"><label for="ap-model">默认模型</label><div class="row"><input class="input mono" id="ap-model" list="ap-models" style="flex:1" value="${esc(d.model)}" placeholder="模型名，例如 deepseek-chat"><button class="btn sm" type="button" data-act="fetchApiModels" ${m.busy ? 'disabled' : ''}>${m.busy ? '获取中…' : '获取模型列表'}</button></div>
      <datalist id="ap-models">${models.map((x) => `<option value="${esc(x)}">`).join('')}</datalist>
      <div class="help">${(d.models || []).length ? `已获取 ${d.models.length} 个模型，可以在输入框里下拉选择。` : '点「获取模型列表」同时也能测试 Key 对不对。'}</div></div>
    ${m.error ? `<div class="pay-err">${esc(m.error)}</div>` : ''}${m.ok ? `<div class="api-ok">${esc(m.ok)}</div>` : ''}</div>
    <div class="row" style="justify-content:flex-end;margin-top:14px"><button class="btn" data-act="closeModal">取消</button><button class="btn primary" data-act="saveApi">保存</button></div>`;
}
function readApiForm() {
  const d = S.modal.api;
  d.name = $('#ap-name').value.trim();
  d.base_url = $('#ap-url').value.trim();
  d.key = $('#ap-key').value.trim();
  d.model = $('#ap-model').value.trim();
  return d;
}

Object.assign(changeHandlers, {
  apiPreset: (el) => {
    const m = S.modal;
    readApiForm();
    m.preset = +el.value;
    const p = API_PRESETS[m.preset];
    m.api.name = p.name.replace(/（.*）/, '');
    m.api.base_url = p.base_url;
    m.api.models = [];
    m.api.model = p.models[0] || '';
    m.error = m.ok = '';
    renderModal();
  },
});

Object.assign(actions, {
  toggleSrcMenu: (d, el, ev) => {
    ev?.stopPropagation?.();
    S.srcMenu = !S.srcMenu;
    if (S.srcMenu) {
      loadApis().then(() => S.srcMenu && render());
      if (!S.local) loadLocal().then(() => S.srcMenu && render());
    }
    render();
  },
  // 顶部菜单里点一个本地模型：直接加载并切换过去（不用再去「运行」页）
  quickLoad: async (d) => {
    S.srcMenu = false;
    const m = (S.local || []).find((x) => x.path === d.path);
    if (!m) return render();
    if (!S.engine) {
      toast('先安装推理引擎');
      return go('run');
    }
    if (S.streaming) return toast('正在回答，等它说完或先点停止再切换');
    setSrc({ type: 'local' });
    if (S.server.running && S.server.model_path === m.path) {
      render();
      return;
    }
    // 画图 / 视频引擎占着显存：先停掉
    try {
      if (S.img?.status?.running) {
        await invoke('stop_image');
        S.img.status = { running: false };
      }
    } catch {}
    S.pausedChat = null;
    S.run.path = m.path;
    S.run.ctx = null;
    S.run.quickName = m.name;
    toast(`正在加载 ${m.name}…`);
    await actions.startModel();
    S.run.quickName = '';
    if (S.run.error) {
      toast(`加载失败：${S.run.error.split('\n')[0]}`, 6000);
      return go('run');
    }
    render();
  },
  srcMoreModels: () => {
    S.srcMenu = false;
    go('models');
  },
  pickSrc: (d) => {
    S.srcMenu = false;
    if (d.type === 'local') {
      setSrc({ type: 'local' });
      if (!S.server.running && !S.pausedChat) return go('run');
    } else {
      setSrc({ type: 'api', id: d.id, model: d.model });
      toast(`已切换到 ${srcName()}`);
    }
    render();
  },
  manageApis: () => {
    S.srcMenu = false;
    go('settings');
    setTimeout(() => document.getElementById('apiSection')?.scrollIntoView({ behavior: 'smooth' }), 50);
  },
  editApi: (d) => {
    const a = d.id ? apiOf(d.id) : null;
    const p = API_PRESETS[0];
    S.modal = {
      step: 'custom',
      wide: true,
      html: apiEditHtml,
      isNew: !a,
      preset: 0,
      api: a ? { ...a, models: [...(a.models || [])] } : { id: '', name: 'DeepSeek', base_url: p.base_url, key: '', models: [], model: p.models[0] },
    };
    renderModal();
  },
  toggleKey: (d, el) => {
    const i = $('#ap-key');
    i.type = i.type === 'password' ? 'text' : 'password';
    el.textContent = i.type === 'password' ? '显示' : '隐藏';
  },
  fetchApiModels: async () => {
    const m = S.modal;
    const a = readApiForm();
    if (!a.base_url || !a.key) {
      m.error = '先填接口地址和 API Key';
      return renderModal();
    }
    m.busy = true;
    m.error = m.ok = '';
    renderModal();
    try {
      a.models = await invoke('api_models', { baseUrl: a.base_url, key: a.key });
      if (!a.model || !a.models.includes(a.model)) a.model = a.models.find((x) => /chat|plus|turbo|glm-4|instruct/i.test(x)) || a.models[0];
      m.ok = `连接成功，获取到 ${a.models.length} 个模型`;
    } catch (e) {
      m.error = String(e);
    }
    m.busy = false;
    renderModal();
  },
  saveApi: async () => {
    const m = S.modal;
    const a = readApiForm();
    if (!a.name || !/^https?:\/\//.test(a.base_url)) {
      m.error = '请填写名称和以 http(s):// 开头的接口地址';
      return renderModal();
    }
    if (!a.key) {
      m.error = '请填写 API Key';
      return renderModal();
    }
    if (!a.model) {
      m.error = '请填写或选择一个默认模型';
      return renderModal();
    }
    if (!a.id) a.id = `api${Date.now().toString(36)}`;
    const list = S.apis.filter((x) => x.id !== a.id);
    list.push(a);
    try {
      await invoke('api_save', { list });
    } catch (e) {
      m.error = String(e);
      return renderModal();
    }
    S.apis = list;
    const first = m.isNew && !usingApi();
    closeModal();
    if (first) {
      setSrc({ type: 'api', id: a.id, model: a.model });
      toast(`已添加，对话和 Agent 现在用 ${a.name} · ${a.model}（顶部可以随时切回本地模型）`, 4500);
    } else toast('已保存');
    render();
  },
  delApi: async (d) => {
    const a = apiOf(d.id);
    if (!a || !confirm(`删除「${a.name}」？`)) return;
    const list = S.apis.filter((x) => x.id !== d.id);
    await call('api_save', { list });
    S.apis = list;
    if (S.src.id === d.id) setSrc({ type: 'local' });
    render();
  },
});

// 点菜单外面关闭
document.addEventListener('click', (ev) => {
  if (S.srcMenu && !ev.target.closest('.src-wrap')) {
    S.srcMenu = false;
    render();
  }
});

loadApis().then(() => (S.page === 'chat' || S.page === 'agent' || S.page === 'settings') && render());
