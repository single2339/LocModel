// LocModel —— 前端逻辑（原生 JS，无需打包）
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const GB = 1024 ** 3;
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtGB = (b) => {
  const g = (b || 0) / GB;
  return (g >= 100 ? g.toFixed(0) : g.toFixed(1)) + ' GB';
};
const fmtSpeed = (bps) => (bps >= 1024 * 1024 ? (bps / 1024 / 1024).toFixed(1) + ' MB/s' : (bps / 1024).toFixed(0) + ' KB/s');
const fmtTps = (t) => (t >= 10 ? `约 ${t.toFixed(0)} tok/s` : t >= 1 ? `约 ${t.toFixed(1)} tok/s` : '不到 1 tok/s');
const store = {
  get(k, d) {
    try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; }
  },
  set(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch {}
  },
};

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
async function call(cmd, args) {
  try {
    return await invoke(cmd, args);
  } catch (e) {
    const msg = typeof e === 'string' ? e : e?.message || String(e);
    if (msg !== '已取消' && !/^(NEED_ACCEL|MEMBER_EXPIRED|NO_GGUF)\|/.test(msg)) toast(msg.split('\n')[0], 5000);
    throw e;
  }
}

// ------------------------------------------------------------------ 状态
const S = {
  slow: {},
  stall: {},
  dlBase: {},
  // 每个下载怎么重新开始（开通高速下载后切线路用）
  dlRestart: {},
  dlArgs: {},
  dlJobs: {},
  page: 'overview',
  settings: null,
  overview: null,
  catalog: null,
  local: null,
  engine: null,
  server: { running: false, ready: false },
  downloads: {},
  modelsTab: 'rec',
  filter: 'fit',
  search: { q: '', hits: null, loading: false, repo: null, quants: null, qLoading: false },
  run: { path: null, ctx: 0, plan: null, starting: false, error: '', lastTps: null, stats: null },
  logs: [],
  thinking: store.get('thinking', true),
  chats: store.get('chats', []),
  chatId: null,
  streaming: false,
  abort: null,
  previews: new Set(),
  net: { hf_ok: true, gh_ok: true, checked: false },
  accel: { member: false, token: '', expires: 0, device_id: '', lines: [] },
  modal: null,
  importing: null,
  crash: null,
  autoRecovering: false,
  justImported: null,
  localError: '',
  lineTests: null,
};

const BPW = { Q2_K: 3.0, Q3_K_M: 3.9, Q4_K_M: 4.85, Q5_K_M: 5.7, Q6_K: 6.6, Q8_0: 8.5, F16: 16, BF16: 16 };
const TAGS = ['对话', '编程', '看图', '推理'];

function modelsDisk() {
  const o = S.overview;
  if (!o) return null;
  const dir = (o.models_dir || '').toLowerCase();
  return o.hardware.disks
    .filter((d) => dir.startsWith(d.mount.toLowerCase()))
    .sort((a, b) => b.mount.length - a.mount.length)[0] || o.hardware.disks[0];
}
function primaryGpu() {
  const h = S.overview?.hardware;
  return h && h.primary_gpu !== null && h.primary_gpu !== undefined ? h.gpus[h.primary_gpu] : null;
}

// ------------------------------------------------------------------ 通用片段
function tierHtml(plan) {
  return `<span class="tier ${plan.tier}">${esc(plan.tier_label)}</span>`;
}
function splitBar(plan, cls = '') {
  const total = plan.gpu_bytes + plan.ram_bytes + plan.disk_bytes || 1;
  const w = (x) => ((x / total) * 100).toFixed(1);
  return `<div class="bar ${cls} t-${plan.tier || 'fast'}" title="深色 = 放显卡（最快），浅色 = 放内存，灰色 = 放硬盘（最慢）"><i class="c-fit" style="width:${w(plan.gpu_bytes)}%"></i><i class="c-ram" style="width:${w(plan.ram_bytes)}%"></i><i class="c-disk" style="width:${w(plan.disk_bytes)}%"></i></div>`;
}
function placeText(plan) {
  const parts = [];
  if (plan.gpu_bytes > 0) parts.push(`显卡 ${fmtGB(plan.gpu_bytes)}`);
  if (plan.ram_bytes > 0) parts.push(`内存 ${fmtGB(plan.ram_bytes)}`);
  if (plan.disk_bytes > 0) parts.push(`硬盘 ${fmtGB(plan.disk_bytes)}`);
  if (plan.ram_bytes <= 0 && plan.disk_bytes <= 0 && plan.gpu_bytes > 0) return '全部放进显卡';
  return parts.join(' + ');
}
// 线路名只显示「加速服务」，不显示具体的第三方镜像站（旧版本后端报的名字也换掉）
const routeName = (r) => String(r || '').replace(/国内镜像\s*hf-mirror|hf-mirror(\.com)?/gi, '加速服务');
function dlHtml(p) {
  if (!p) return '';
  if (p.route) p = { ...p, route: routeName(p.route) };
  if (p.status === 'error') return `<div class="dl"><div class="top"><b style="color:var(--red-ink)">下载失败</b></div><div class="muted" style="font-size:12px">${esc(p.message)}</div></div>`;
  const pct = p.total ? Math.min(100, (p.done / p.total) * 100) : 0;
  const left = p.speed > 0 && p.total ? Math.max(0, (p.total - p.done) / p.speed) : 0;
  const eta = left > 3600 ? `约 ${(left / 3600).toFixed(1)} 小时` : left > 60 ? `约 ${Math.ceil(left / 60)} 分钟` : left > 0 ? '不到 1 分钟' : '';
  // 刚开始：线路还在连接、多线程还没跑起来（这次还没收到 2 MB）时，提示正在启动，别让人以为卡住了
  const starting = p.status === 'downloading' && dlStarting(p);
  // 大文件 1% 就是好几百 MB：前 10% 显示一位小数，已下载不到 1 GB 时按 MB 显示，看得出在动
  const pctTxt = pct > 0 && pct < 10 ? pct.toFixed(1) : pct.toFixed(0);
  const doneTxt = p.done > 0 && p.done < GB ? `${Math.max(1, Math.round(p.done / 1024 / 1024))} MB` : fmtGB(p.done);
  const label = p.status === 'cancelled' ? '已暂停' : p.status === 'done' ? '完成' : starting ? '准备中' : `${pctTxt}%`;
  // 还没收到数据时后端没报线路名：开通了高速下载就按加速服务提示
  const accelRoute = p.route ? /^(加速服务|高速下载)/.test(p.route) : !!S.accel?.member;
  // 中国大陆的会员走高速线路时：开着 VPN / 代理（尤其是全局、TUN 模式）流量会绕到国外再回来，速度反而慢
  const vpnTip = p.status === 'downloading' && accelRoute && S.accel?.member && isMainland()
    ? '<div class="muted" style="font-size:11.5px;margin-top:4px">提示：如果电脑开着 VPN / 代理类软件，请先关闭再下载，否则会影响加速效果。</div>'
    : '';
  const startTip = accelRoute ? '加速服务正在启动中，请稍等，马上开始…' : /^官方源/.test(p.route || '') ? '正在连接官方源，请稍等，马上开始…' : '正在连接下载服务器，请稍等，马上开始…';
  return `<div class="dl">
    <div class="top"><b>${label}</b><span class="muted">${[p.route ? esc(p.route) : '', p.status === 'downloading' && !starting ? fmtSpeed(p.speed) : ''].filter(Boolean).join(' · ')}</span></div>
    <div class="bar thin${starting ? ' dl-starting' : ''}"><i class="c-gpu" style="width:${starting ? 100 : pct}%"></i></div>
    <div class="between" style="font-size:11px"><span class="muted">${starting ? startTip : `${doneTxt} / ${fmtGB(p.total)}${p.file_count > 1 ? ` · 第 ${Math.min(p.file_index + 1, p.file_count)}/${p.file_count} 个文件` : ''}${eta ? ' · 剩余' + eta : ''}`}</span>
    ${p.status === 'downloading' ? `<button class="btn sm" data-act="cancelDl" data-id="${esc(p.id)}">暂停</button>` : ''}</div>
    ${vpnTip}
  </div>`;
}
// 这次下载（同一条线路）开始时已有多少：断点续传时从已下载的部分算起
// 是不是在中国大陆（看系统时区；开着 VPN 时网络检测不准，时区不受影响）
function isMainland() {
  try {
    return ['Asia/Shanghai', 'Asia/Chongqing', 'Asia/Chungking', 'Asia/Harbin', 'Asia/Urumqi', 'PRC'].includes(Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch {
    return false;
  }
}
function dlStarting(p) {
  const b = S.dlBase[p.id];
  if (!b || b.route !== (p.route || '')) {
    S.dlBase[p.id] = { route: p.route || '', d0: p.done || 0 };
    return true;
  }
  return !p.total || p.done - b.d0 < 2 * 1024 * 1024;
}
function dlSlot(id, inner) {
  const p = S.downloads[id];
  const active = p && (p.status === 'downloading' || p.status === 'error' || p.status === 'cancelled');
  return `<div data-dl="${esc(id)}" style="display:flex;justify-content:flex-end;align-items:center;gap:8px;flex-wrap:wrap;margin-left:auto">${active ? dlHtml(p) + (p.status !== 'downloading' ? inner : '') : inner}</div>`;
}

// ------------------------------------------------------------------ 页面：概览
// 硬件名精简：去掉厂商前缀和商标符号，只留型号
function shortGpu(n) {
  return String(n || '')
    .replace(/\((R|TM)\)/gi, '')
    .replace(/^NVIDIA\s+/i, '')
    .replace(/^GeForce\s+/i, '')
    .replace(/^AMD\s+/i, '')
    .replace(/\s+Graphics$/i, ' 核显')
    .replace(/\s+/g, ' ')
    .trim();
}
function shortCpu(n) {
  return String(n || '')
    .replace(/\((R|TM)\)/gi, '')
    .replace(/^\d+(st|nd|rd|th) Gen\s+/i, '')
    .replace(/^(Intel|AMD)\s+/i, '')
    .replace(/\s+\d+-Core Processor$/i, '')
    .replace(/\s+(CPU\s+)?@.*$/i, '')
    .replace(/\s+Processor$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}
function fmtSize(b) {
  const g = (b || 0) / GB;
  if (g >= 1000) return (g / 1024).toFixed(1) + ' TB';
  return (g >= 100 ? g.toFixed(0) : g.toFixed(g >= 10 ? 0 : 1)) + ' GB';
}

// 开始使用的三步：全部完成后不再显示
function setupSteps(o, hasModel) {
  const engineDone = !!o.engine;
  if (engineDone && hasModel) return '';
  const g = primaryGpu();
  const backend = { cuda: 'CUDA', vulkan: 'Vulkan', metal: 'Metal' }[o.hardware.backend] || 'CPU';
  const step = (n, done, now, title, body) =>
    `<li class="${done ? 'done' : now ? 'now' : ''}"><span class="n" aria-hidden="true">${done ? '✓' : n}</span><div class="t">${title}</div><div class="b">${body}</div></li>`;
  return `<ol class="setup" aria-label="开始使用">
    ${step(1, true, false, '检测硬件', '已完成')}
    ${step(2, engineDone, !engineDone, '安装推理引擎', engineDone ? '已安装' : dlSlot('engine', `<button class="btn primary sm" data-act="installEngine">一键安装</button><span class="muted">${g ? shortGpu(g.name) + ' · ' : ''}${backend} 版，约 100–600 MB</span>`))}
    ${step(3, hasModel, engineDone && !hasModel, '下载一个模型', hasModel ? '已有模型' : '从下面的推荐里选一个')}
  </ol>`;
}

// 容量尺：按真实 GB 比例画出显卡、内存各能放多少模型，硬盘兜底；标出首选模型落在哪
function capacityRuler(vram, ram, pick) {
  const total = vram + ram || 1;
  const gw = vram > 0 ? Math.max(12, (vram / total) * 76) : 0;
  const rw = 76 - gw;
  let marker = '';
  if (pick) {
    const b = pick.bytes;
    const x = b <= total ? (b / total) * 76 : Math.min(97, 76 + ((b - total) / total) * 24);
    marker = `<div class="pin" style="left:${x.toFixed(1)}%"><span>${esc(pick.model.name)} · ${fmtSize(b)}</span></div>`;
  }
  return `<div class="ruler" role="img" aria-label="显卡 ${fmtSize(vram)}，可用内存 ${fmtSize(ram)}，其余用硬盘">
    <div class="track">
      ${vram > 0 ? `<div class="seg gpu" style="width:${gw}%"><b>显卡</b><span>${fmtSize(vram)}</span></div>` : ''}
      <div class="seg ram" style="width:${rw}%"><b>内存</b><span>${fmtSize(ram)}</span></div>
      <div class="seg disk"><b>硬盘</b><span>兜底</span></div>
      ${marker}
    </div>
    <p class="cap">模型先放进显卡，放不下的部分依次放到内存、硬盘。越靠左越快。</p>
  </div>`;
}

function recAction(it, big) {
  const r = it.rec;
  const id = `${r.model.repo}:${r.quant}`;
  return it.installed_path
    ? `<button class="btn soft${big ? '' : ' sm'}" data-act="goRun" data-path="${esc(it.installed_path)}">运行</button>`
    : dlSlot(id, `<button class="btn primary${big ? '' : ' sm'}" data-act="download" data-repo="${esc(r.model.repo)}" data-quant="${esc(r.quant)}" data-vision="${r.model.vision ? 1 : 0}">下载 ${fmtSize(r.bytes)}</button>`);
}

function pageOverview() {
  const o = S.overview;
  if (!o) return `<div class="page ov"><section class="machine loading"><h1>正在检测硬件</h1><p class="lede">第一次打开需要几秒钟。</p></section></div>`;
  const h = o.hardware;
  const g = primaryGpu();
  const disk = modelsDisk();
  const ramAvail = h.memory.available_bytes;
  const vram = g ? g.vram_bytes : 0;
  const hasModel = o.recs.some((x) => x.installed_path) || (S.local && S.local.length > 0);
  const recs = o.recs.slice(0, 6);
  const pick = recs[0]?.rec;

  const spec = (k, v, sub) => `<div class="spec"><dt>${k}</dt><dd><b>${v}</b><span>${sub}</span></dd></div>`;
  const gpuRow = g
    ? spec('显卡', esc(shortGpu(g.name)), `${fmtSize(g.vram_bytes)} 显存${g.vram_used_bytes != null ? `，已用 ${fmtSize(g.vram_used_bytes)}` : ''}`)
    : spec('显卡', '未检测到独立显卡', '用 CPU 运行 · <a href="#" data-act="go" data-page="settings">有独显？手动指定</a>');
  const specs = `<dl class="specs">
    ${gpuRow}
    ${spec('处理器', esc(shortCpu(h.cpu.name)), `${h.cpu.physical_cores} 核 ${h.cpu.logical_cores} 线程`)}
    ${spec('内存', `${fmtSize(h.memory.total_bytes)} ${esc(h.memory.kind || '')}`, `可用 ${fmtSize(ramAvail)}`)}
    ${disk ? spec('模型盘', esc(disk.mount.replace(/\\$/, '')), `剩余 ${fmtSize(disk.available_bytes)}，${disk.is_ssd ? '固态' : '机械硬盘'} <a href="#" data-act="go" data-page="settings">更改</a>`) : ''}
  </dl>`;

  const pickHtml = pick
    ? `<article class="pick">
        <div class="pick-main">
          <div class="pick-title"><h3>${esc(pick.model.name)}</h3>${releaseHtml(pick.model)}</div>
          <p>${esc(pick.model.desc)}</p>
          <div class="facts">
            <span><b>${fmtTps(pick.plan.est_tps).replace('约 ', '')}</b>预计速度</span>
            <span><b>${esc(placeText(pick.plan))}</b>放在哪</span>
            <span><b>${esc(pick.quant)}</b>量化</span>
          </div>
        </div>
        <div class="pick-act">${tierHtml(pick.plan)}${recAction(recs[0], true)}</div>
      </article>`
    : '';
  const rows = recs
    .slice(1)
    .map((it) => {
      const r = it.rec;
      return `<div class="rrow">
        <div class="rn"><b>${esc(r.model.name)}</b>${releaseHtml(r.model)}</div>
        <div class="rd">${esc(r.model.desc)}</div>
        <div class="rs mono">${fmtTps(r.plan.est_tps)}</div>
        <div class="rt">${tierHtml(r.plan)}</div>
        <div class="ra">${recAction(it, false)}</div>
      </div>`;
    })
    .join('');

  return `<div class="page ov">
    ${setupSteps(o, hasModel)}${S.engine ? engineHealthWarn() || engineGpuWarn() : ''}
    <section class="machine" aria-label="这台电脑">
      <div class="m-top">
        <div class="verdict">
          <h1>${esc(o.conclusion.headline)}</h1>
          <p class="lede">${esc(o.conclusion.detail)}</p>
          ${capacityRuler(vram, ramAvail, pick)}
        </div>
        <div>${specs}<button class="link" data-act="redetect">重新检测硬件</button></div>
      </div>
    </section>
    <section class="recs" aria-label="推荐模型">
      <div class="recs-head"><h2>为这台电脑推荐</h2><a href="#" data-act="go" data-page="models">全部模型</a></div>
      ${pickHtml || '<div class="empty">没有合适的推荐</div>'}
      ${rows ? `<div class="rlist">${rows}</div>` : ''}
    </section>
  </div>`;
}

// ------------------------------------------------------------------ 页面：模型
function routeHint() {
  if (S.accel.member) return `<span class="muted" style="font-size:12px">下载走高速下载服务</span>`;
  return '';
}

// ------------------------------------------------------------------ 模型加载进度
function diskOfPath(path) {
  const disks = S.overview?.hardware?.disks || [];
  const p = (path || '').toLowerCase();
  return disks.filter((d) => p.startsWith(d.mount.toLowerCase())).sort((a, b) => b.mount.length - a.mount.length)[0] || null;
}
function fmtDur(s) {
  s = Math.max(0, Math.round(s));
  return s >= 60 ? `${Math.floor(s / 60)} 分 ${s % 60} 秒` : `${s} 秒`;
}
// 启动后的实际分配（来自引擎日志），以及会导致变慢的情况
function actualHtml(a) {
  const parts = [];
  if (a.gpu_layers != null) parts.push(`显卡上 ${a.gpu_layers}/${a.total_layers} 层`);
  if (a.ctx) parts.push(`上下文 ${a.ctx >= 1024 ? Math.round(a.ctx / 1024) + 'K' : a.ctx}`);
  if (a.auto_fit) parts.push('按实际空闲显存自动分配');
  if (a.safe_level) parts.push(`兼容模式 ${a.safe_level}（${['', 'KV 缓存不量化', 'KV 缓存不量化 + 关闭 Flash Attention', 'KV 缓存不量化 + 关闭 Flash Attention 和 CUDA Graphs', '在第 3 级基础上不加载看图组件', '再改用 cuBLAS 计算、调小批次'][a.safe_level] || ''}）`);
  if (!a.vision && S.local?.find((m) => m.path === S.run.path)?.mmproj) parts.push('未带看图组件');
  const warn = [];
  if (a.vram_full) warn.push('显存已经几乎占满：N 卡会把放不下的部分挪到「共享 GPU 内存」（系统内存），生成速度可能掉到原来的十分之一。请关掉占显存的程序（OBS、浏览器硬件加速、ComfyUI、游戏等）后重新启动模型，或在上方把上下文调小。');
  else if (S.engine?.variant !== 'cpu' && (S.overview?.hardware?.gpus || []).some((g) => !g.integrated) && (a.gpu_layers === 0 || (S.engCheck && !S.engCheck.unknown && !S.engCheck.gpu_ok))) warn.push('这次加载没有用上显卡，模型全部在 CPU / 内存里跑，速度会很慢。上面的「预计速度」只是估算，请按提示重新安装推理引擎，或更新显卡驱动后重启电脑。');
  else if (a.gpu_layers != null && a.total_layers && a.gpu_layers < a.total_layers) warn.push(`有 ${a.total_layers - a.gpu_layers} 层放不进显卡、在内存里跑，速度会明显变慢。关掉占显存的程序、调小上下文，或换小一档的量化可以全部放进显卡。`);
  return `<div style="flex:1 1 100%;display:flex;flex-direction:column;gap:6px">
    <div class="muted" style="font-size:12px">实际：${parts.map(esc).join(' · ')}</div>
    ${warn.map((w) => `<div style="font-size:12px;color:var(--red-ink);background:var(--red-soft);border-radius:8px;padding:8px 10px;line-height:1.6">${esc(w)}</div>`).join('')}
  </div>`;
}

const LOAD_STEPS = ['准备', '读取模型', '分配缓存', '预热', '完成'];
function stepOf(stage) {
  if (/读取模型权重/.test(stage)) return 1;
  if (/看图|缓存/.test(stage)) return 2;
  if (/预热/.test(stage)) return 3;
  if (/就绪/.test(stage)) return 4;
  return 0;
}
// 启动进度卡片：步骤条 + 总进度 + 读取速度 + 原因提示
function loadHtml() {
  const L = S.run.load;
  const running = L && L.running;
  const stage = running ? L.stage : '读取模型信息、准备启动参数';
  const step = running ? stepOf(L.stage) : 0;
  const known = running && L.fraction >= 0;
  const pct = step === 1 ? (known ? 5 + Math.round(L.fraction * 80) : null) : [2, null, 88, 95, 100][step];
  const eta = known && L.speed_bps > 1e6 ? (L.total_bytes - L.read_bytes) / L.speed_bps : null;
  const detail = running
    ? step === 1 && known
      ? `已读取 ${fmtGB(L.read_bytes)} / ${fmtGB(L.total_bytes)} · ${fmtSpeed(L.speed_bps)}${eta != null && L.fraction < 0.99 ? ` · 还需约 ${fmtDur(eta)}` : ''}`
      : step === 3 ? '第一次计算，通常几秒到几十秒' : step === 2 ? '在显卡上分配对话缓存' : step === 0 && L.elapsed_s > 8 ? `按显卡空闲显存计算怎么分配模型${L.read_bytes > 0 ? `，已读取 ${fmtGB(L.read_bytes)}` : ''}` : ''
    : '';
  const hints = [];
  if (S.run.note) hints.push(S.run.note);
  const disk = diskOfPath(S.server.model_path || S.run.path);
  if (step <= 1 && disk && !disk.is_ssd) hints.push(`模型放在机械硬盘（${disk.mount}）上，读取慢。建议在「设置」里把模型目录改到固态硬盘，再把模型文件夹移过去，以后加载只要十几秒。`);
  else if (step === 1 && known && L.elapsed_s > 20 && L.speed_bps < 80 * 1024 * 1024 && L.fraction < 0.95) hints.push(`读取速度只有 ${fmtSpeed(L.speed_bps)}，偏慢：可能是机械硬盘、U 盘 / 移动硬盘，或杀毒软件在扫描模型文件（可把模型目录加入白名单）。`);
  if (step === 1 && running && !known) hints.push('这个模型比可用内存还大，一部分要从硬盘按需读取，第一次加载和第一次回答都会比较慢。');
  const steps = LOAD_STEPS.map((n, i) => `<div class="st ${i < step ? 'done' : i === step ? 'now' : ''}"><i></i><span>${n}</span></div>`).join('');
  return `<div class="head"><div class="stack" style="gap:3px"><b>正在启动 ${esc(S.server.model_name || (S.local || []).find((m) => m.path === S.run.path)?.name || '')}</b><span class="muted" style="font-size:12px">${esc(stage)}${running ? ` · 已用 ${fmtDur(L.elapsed_s)}` : ''}</span></div>${pct != null ? `<span class="pct">${pct}%</span>` : ''}</div>
    <div class="steps">${steps}</div>
    ${detail ? `<div class="muted mono" style="font-size:12px">${detail}</div>` : ''}
    ${running && L.last_log ? `<div class="lastlog" title="引擎最新日志">${esc(L.last_log)}</div>` : ''}
    ${hints.map((h) => `<div class="hint" style="font-size:12px;color:var(--clay-ink);line-height:1.6;margin-top:6px">${esc(h)}</div>`).join('')}`;
}

// 发布时间："2026-08" → "2026年8月发布"；三个月内的标「新」
function releaseHtml(m) {
  if (!m.release) return '';
  const [y, mo] = m.release.split('-').map(Number);
  const now = new Date();
  const ago = (now.getFullYear() - y) * 12 + (now.getMonth() + 1 - mo);
  const isNew = ago >= 0 && ago <= 3;
  return `${isNew ? '<span class="tag clay">新</span>' : ''}<span class="muted" style="font-size:12px">${y}年${mo}月发布</span>`;
}

function catalogRows() {
  if (!S.catalog) return '<div class="empty">加载中…</div>';
  const rows = S.catalog.filter((it) => {
    const r = it.rec;
    if (S.filter === 'fit') return r.plan.tier === 'fast' || r.plan.tier === 'ok';
    if (S.filter === 'all') return true;
    return r.model.tags.includes(S.filter);
  });
  if (!rows.length) return '<div class="empty">这个分类下暂时没有适合的模型</div>';
  return rows
    .map((it) => {
      const r = it.rec;
      const id = `${r.model.repo}:${r.quant}`;
      const opts = r.model.quants.map((q) => `<option value="${esc(q)}" ${q === r.quant ? 'selected' : ''}>${esc(q)}${q === r.quant ? '（推荐）' : ''}</option>`).join('');
      const act = it.installed_path
        ? `<button class="btn soft" data-act="goRun" data-path="${esc(it.installed_path)}">已安装 · 运行</button>`
        : dlSlot(id, `<button class="btn primary" data-act="downloadSel" data-repo="${esc(r.model.repo)}" data-vision="${r.model.vision ? 1 : 0}" data-sel="q-${esc(r.model.id)}">下载</button>`);
      return `<div class="item">
      <div class="c1"><div class="row" style="gap:8px"><span class="name">${esc(r.model.name)}</span>${r.model.vision ? '<span class="tag blue">看图</span>' : ''}${releaseHtml(r.model)}</div><div class="desc"><span class="muted">${esc(r.model.org)} · </span>${esc(r.model.desc)}</div></div>
      <div class="c2"><label class="sr" for="q-${esc(r.model.id)}">量化</label><select class="input mono" style="font-size:12px" id="q-${esc(r.model.id)}" data-params="${r.model.params_b}" data-sizes='${esc(JSON.stringify(r.model.size_gb || {}))}' data-change="quantSize">${opts}</select><span class="mono muted" style="font-size:12px" id="sz-${esc(r.model.id)}">${fmtGB(r.bytes)}</span></div>
      <div class="c3"><div class="row" style="gap:8px">${tierHtml(r.plan)}<span class="muted" style="font-size:12px">${fmtTps(r.plan.est_tps)}</span></div>${splitBar(r.plan, 'thin')}</div>
      <div class="c4">${act}</div>
    </div>`;
    })
    .join('');
}

function localRows() {
  if (S.localError) return `<div class="empty">读取本地模型失败：${esc(S.localError)}<br><button class="btn sm" style="margin-top:10px" data-act="reloadLocal">重试</button></div>`;
  if (!S.local) return '<div class="empty">正在读取本地模型…</div>';
  if (!S.local.length) return `<div class="empty">还没有模型。去「推荐模型」下载一个，或者导入你已有的 .gguf 文件。</div>`;
  return S.local
    .map((m) => {
      const i = m.info;
      const moe = i.expert_count ? `MoE · ${i.expert_count} 专家选 ${i.expert_used_count}` : '稠密';
      const hl = m.path === S.justImported;
      return `<div class="item${hl ? ' hl' : ''}" ${hl ? 'id="justImported"' : ''}>
      <div class="c1"><div class="row" style="gap:8px"><span class="name">${esc(m.name)}</span>${hl ? '<span class="tag clay">刚导入</span>' : ''}${m.imported ? '<span class="tag">导入</span>' : ''}${m.mmproj ? '<span class="tag blue">看图</span>' : ''}</div>
        <div class="desc mono" style="font-size:12px">${esc(i.arch)} · ${i.block_count} 层 · ${moe} · ${i.files.length > 1 ? i.files.length + ' 个分卷' : '单文件'}</div></div>
      <div class="c2"><span class="mono" style="font-size:12px">${esc(i.file_type)}</span><span class="mono muted" style="font-size:12px">${fmtGB(i.total_bytes)}</span></div>
      <div class="c3"><div class="row" style="gap:8px">${tierHtml(m.plan)}<span class="muted" style="font-size:12px">${fmtTps(m.plan.est_tps)}</span></div>${splitBar(m.plan, 'thin')}</div>
      <div class="c4 row" style="gap:6px">
        <button class="btn sm" data-act="openFolder" data-path="${esc(m.path)}">打开位置</button>
        <button class="btn sm danger" data-act="removeLocal" data-path="${esc(m.path)}" data-imported="${m.imported ? 1 : 0}">${m.imported ? '移除' : '删除'}</button>
        <button class="btn soft" data-act="goRun" data-path="${esc(m.path)}">运行</button>
      </div>
    </div>`;
    })
    .join('');
}

function searchPane() {
  const s = S.search;
  let body = '';
  if (s.repo) {
    const rows = s.qLoading
      ? '<div class="empty">正在读取文件列表…</div>'
      : (s.quants || []).length
      ? s.quants
          .map((q) => {
            const id = `${s.repo}:${q.quant}`;
            return `<div class="item">
          <div class="c1"><span class="name mono" style="font-size:14px">${esc(q.quant)}</span><span class="desc">${q.files.length > 1 ? q.files.length + ' 个分卷' : esc(q.files[0].name)}</span></div>
          <div class="c2"><span class="mono" style="font-size:12px">${fmtGB(q.bytes)}</span></div>
          <div class="c3"><div class="row" style="gap:8px"><span class="tier ${q.tier}">${esc(q.tier_label)}</span><span class="muted" style="font-size:12px">${fmtTps(q.est_tps)}（估算）</span></div></div>
          <div class="c4">${dlSlot(id, `<button class="btn primary" data-act="download" data-repo="${esc(s.repo)}" data-quant="${esc(q.quant)}" data-vision="1">下载</button>`)}</div>
        </div>`;
          })
          .join('')
      : '<div class="empty">这个仓库里没有 GGUF 文件</div>';
    body = `<div class="between"><div class="row"><button class="btn sm" data-act="searchBack">← 返回结果</button><h3 class="mono">${esc(s.repo)}</h3></div></div><div class="list">${rows}</div>`;
  } else if (s.loading) {
    body = '<div class="empty">搜索中…</div>';
  } else if (s.needAccel) {
    body = `<div class="empty">暂时无法从官方源搜索模型，开通高速下载服务后就能搜索和下载。<br><button class="btn primary sm" style="margin-top:10px" data-act="searchAccel">开通高速下载</button></div>`;
  } else if (s.hits) {
    body = s.hits.length
      ? `<div class="list">${s.hits
          .map(
            (h) => `<div class="item"><div class="c1"><span class="name mono" style="font-size:14px">${esc(h.id)}</span></div>
          <div class="c3"><span class="muted" style="font-size:12px">下载 ${h.downloads.toLocaleString()} · 赞 ${h.likes}</span></div>
          <div class="c4"><button class="btn" data-act="openRepo" data-repo="${esc(h.id)}">查看版本</button></div></div>`,
          )
          .join('')}</div>`
      : s.note
        ? `<div class="empty">${esc(s.note)}</div>`
        : '<div class="empty">没有找到，换个关键词试试（例如 qwen3.8、gemma-4），也可以直接粘贴 HuggingFace 模型页的链接</div>';
  } else {
    body = '<div class="empty">输入模型名字搜索 HuggingFace 上的 GGUF 模型，例如 qwen3.8、gemma-4、glm；也可以直接粘贴模型页链接</div>';
  }
  return `<form class="row" data-submit="search"><label class="sr" for="sq">搜索</label><input id="sq" class="input" style="flex:1" placeholder="搜索模型名，或粘贴 HuggingFace 模型链接…" value="${esc(s.q)}"><button class="btn primary" type="submit">搜索</button></form>${body}`;
}

function pageModels() {
  const t = S.modelsTab;
  const chips = [['fit', '适合我的电脑'], ['all', '全部'], ...TAGS.map((x) => [x, x])]
    .map(([k, v]) => `<button class="chip ${S.filter === k ? 'on' : ''}" data-act="filter" data-f="${esc(k)}">${esc(v)}</button>`)
    .join('');
  let body;
  if (t === 'rec') body = `<div class="chips">${chips}</div><div class="list">${catalogRows()}</div>`;
  else if (t === 'local')
    body = `<div class="list">${localRows()}</div>
      <div class="drop"><div><b>已经有模型文件？</b><p>选择 .gguf 文件导入，自动识别量化和需要的显存。分卷文件选第一卷即可；同目录的 mmproj 会自动识别为看图组件。</p></div><button class="btn" data-act="importGguf" ${S.importing ? 'disabled' : ''}>${S.importing ? '正在导入…' : '选择文件'}</button></div>`;
  else if (t === 'image') body = imageModelsPane();
  else body = searchPane();
  return `<div class="page">
    <div class="page-head"><h1>模型</h1><div class="row">${routeHint()}<button class="btn" data-act="importGguf" ${S.importing ? 'disabled' : ''}>${S.importing ? '正在导入…' : '导入本地 GGUF'}</button></div></div>
    ${S.importing ? `<div class="notice" role="status"><div><b>正在导入：${esc(S.importing)}</b><p>正在读取模型信息（架构、层数、量化），通常几秒钟。不会复制文件，模型还在原来的位置。</p></div><span class="spinner" aria-hidden="true"></span></div>` : ''}
    <div class="tabs" role="tablist">
      <button role="tab" class="${t === 'rec' ? 'on' : ''}" data-act="tab" data-t="rec">推荐模型</button>
      <button role="tab" class="${t === 'local' ? 'on' : ''}" data-act="tab" data-t="local">已安装${S.local ? `（${S.local.length}）` : ''}</button>
      <button role="tab" class="${t === 'image' ? 'on' : ''}" data-act="tab" data-t="image">画图 / 视频模型</button>
      <button role="tab" class="${t === 'search' ? 'on' : ''}" data-act="tab" data-t="search">搜索 HuggingFace</button>
    </div>
    ${body}
  </div>`;
}

// ------------------------------------------------------------------ 页面：运行
// RTX 50 系（Blackwell）要 CUDA 12.8 以上的引擎；装着旧的 CUDA 包时加载模型会失败
function isBlackwell(name) {
  const n = String(name || '').toLowerCase();
  if (/blackwell|gb10|dgx spark|\bb[123]00\b/.test(n)) return true;
  const m = n.match(/rtx\s*(5\d\d0)/);
  return !!m && /^50[5-9]0$/.test(m[1]);
}
// N 卡驱动主版本号：「581.57」或 Windows 里的「32.0.15.8157」（= 581.57）
function nvDriverMajor(d) {
  const p = String(d || '').trim().split('.');
  if (p.length >= 4) return +(String(p[2]).slice(-1) + p[3]).slice(0, 3) || 0;
  return +p[0] || 0;
}
// 引擎自检（每次打开软件查一次，装完引擎再查）：运行库架构不对、识别不到显卡时，明确告诉用户并给出一键修复
S.engCheck = null;
let engCheckBusy = false;
async function runEngineCheck() {
  if (engCheckBusy || !S.engine) return;
  engCheckBusy = true;
  try {
    S.engCheck = await invoke('engine_check');
  } catch {
    S.engCheck = null;
  }
  engCheckBusy = false;
  if (['run', 'overview', 'settings'].includes(S.page)) render();
}
function engineHealthWarn() {
  const c = S.engCheck;
  if (!c || !S.engine) {
    if (S.engine && c === null && !engCheckBusy) setTimeout(runEngineCheck, 0);
    return '';
  }
  const btn = `${dlSlot('engine', '<button class="btn primary sm" data-act="installEngine" data-force="1">重新安装推理引擎</button>')}`;
  if (c.bad_arch.length) {
    return `<div class="card warn-card" role="alert"><b>推理引擎文件有问题，显卡用不上</b><div class="help" style="margin-top:4px">这些运行库的架构和电脑不匹配：${esc(c.bad_arch.join('、'))}。现在模型只能在 CPU 上跑，速度会非常慢。点下面重新安装就能修好（旧版本软件的引擎下载有这个问题，已修复）。</div><div class="row" style="margin-top:8px">${btn}</div></div>`;
  }
  const hasGpu = (S.overview?.hardware?.gpus || []).some((g) => !g.integrated);
  if (!c.unknown && !c.gpu_ok && S.engine.variant !== 'cpu' && hasGpu) {
    return `<div class="card warn-card" role="alert"><b>推理引擎识别不到显卡</b><div class="help" style="margin-top:4px">模型会退回 CPU 运行，速度很慢。可以先重新安装推理引擎；还不行的话，更新显卡驱动后重启电脑再试。</div>
      <details style="margin-top:6px"><summary class="muted" style="font-size:12px;cursor:pointer">引擎的检测结果</summary><pre class="mono" style="font-size:11.5px;white-space:pre-wrap;margin:6px 0 0">${esc(c.devices || '（没有输出）')}</pre></details>
      <div class="row" style="margin-top:8px">${btn}</div></div>`;
  }
  return '';
}
function engineGpuWarn() {
  const g = primaryGpu();
  const v = S.engine?.variant || '';
  if (!g || !isBlackwell(g.name)) return '';
  const m = v.match(/^cuda-(\d+)\.(\d+)/);
  const old = (m && (+m[1] < 12 || (+m[1] === 12 && +m[2] < 8))) || v === 'cuda' || v === 'cuda-12';
  if (old) {
    return `<div class="card warn-card" role="alert"><b>${esc(shortGpu(g.name))} 需要新版推理引擎</b><div class="help" style="margin-top:4px">当前装的是 ${esc(v)} 版，这块显卡要 CUDA 12.8 以上的引擎，否则加载模型会失败。点下面重新安装，软件会自动选对版本。</div>
      <div class="row" style="margin-top:8px">${dlSlot('engine', '<button class="btn primary sm" data-act="installEngine">重新安装推理引擎</button>')}</div></div>`;
  }
  // 驱动其实够新（580 以上）却装着 Vulkan 版：多半是旧版本软件选错了，重新安装就会换成 CUDA 版
  const drv = nvDriverMajor(g.driver);
  if (v === 'vulkan' && (drv >= 580 || (g.cuda_version && parseFloat(g.cuda_version) >= 13))) {
    return `<div class="card warn-card" role="alert"><b>可以换成更快的 CUDA 版引擎</b><div class="help" style="margin-top:4px">${esc(shortGpu(g.name))} 的驱动${drv ? `（${drv}）` : ''}已经支持 CUDA 版，当前装的是 Vulkan 版。点下面重新安装，速度更快。</div>
      <div class="row" style="margin-top:8px">${dlSlot('engine', '<button class="btn primary sm" data-act="installEngine">换成 CUDA 版</button>')}</div></div>`;
  }
  if (v === 'vulkan' && (g.cuda_version ? parseFloat(g.cuda_version) < 13 : true)) {
    return `<div class="card warn-card"><b>当前用的是 Vulkan 版引擎</b><div class="help" style="margin-top:4px">${esc(shortGpu(g.name))} 的显卡驱动版本较旧，装不了更快的 CUDA 版。把 NVIDIA 显卡驱动更新到 580 以上，再到「设置」点「更新到最新版」，可以换成 CUDA 版，速度更快。</div></div>`;
  }
  return '';
}

function engineCard() {
  const h = S.overview?.hardware;
  const backend = h ? { cuda: 'CUDA（N 卡）', vulkan: 'Vulkan（显卡通用）', metal: 'Metal（Apple 芯片）' }[h.backend] || 'CPU' : '';
  return `<div class="notice"><div><b>先安装推理引擎</b><p>将自动下载 llama.cpp 官方 ${backend} 版本。</p></div>
    <div class="row">${dlSlot('engine', `<button class="btn primary" data-act="installEngine">一键安装</button>`)}</div></div>`;
}

// 启动失败的提示；引擎一启动就退出（老显卡驱动）时给出「改用 CPU 版引擎」按钮
function runErrorHtml(err) {
  const crash = err.startsWith('ENGINE_CRASH|');
  const text = crash ? err.slice('ENGINE_CRASH|'.length) : err;
  const amd = /amd|radeon/i.test(S.hw?.gpus?.[S.hw.primary_gpu ?? 0]?.name || '');
  const btns = crash && !S.settings?.engine_cpu
    ? `<div class="row" style="margin-top:10px">${dlSlot('engine', '<button class="btn primary sm" data-act="useCpuEngine">改用 CPU 版引擎</button>')}<button class="btn sm" data-act="extLink" data-url="${amd ? 'https://www.amd.com/zh-cn/support/download/drivers.html' : 'https://www.nvidia.cn/drivers/'}">下载最新显卡驱动</button></div>`
    : '';
  return `<div class="alert">${esc(text)}${btns}</div>`;
}

// 启动命令里可以改的部分（去掉程序名、模型路径、看图组件、地址、端口，这些由软件管理）
function editableArgs(cmd) {
  const toks = (String(cmd).match(/"[^"]*"|\S+/g) || []).slice(1);
  const managed = ['-m', '--model', '--mmproj', '--host', '--port'];
  const out = [];
  for (let i = 0; i < toks.length; i++) {
    if (managed.includes(toks[i])) {
      i++;
      continue;
    }
    out.push(toks[i]);
  }
  return out.join(' ');
}

// 高级：查看和自定义启动参数（每个模型单独保存）
function argsHtml(r) {
  const saved = r.plan.custom_args || '';
  if (r.argsFor !== r.path) {
    r.argsFor = r.path;
    r.argsDraft = saved;
  }
  const dirty = (r.argsDraft || '').trim() !== saved.trim();
  const running = S.server.running && S.server.model_path === r.path;
  return `<details class="adv-args" data-open="argsOpen" ${r.argsOpen || saved ? 'open' : ''}><summary>高级：启动参数${saved ? ' <span class="tag clay" style="margin-left:6px">已自定义</span>' : ''}</summary>
    <div class="muted" style="font-size:12.5px;margin-top:10px">软件自动生成的启动命令${saved ? '（已包含你的自定义参数）' : ''}：</div>
    <pre class="cmd">${HL.highlight(r.plan.command, 'powershell')}</pre>
    <div class="field" style="margin-top:12px"><label for="customArgs">自定义启动参数</label>
      <textarea class="input mono" id="customArgs" data-input="argsDraft" rows="3" style="font-size:12.5px;resize:vertical" placeholder="例如：-c 32768 -ngl 99 --temp 0.6 --top-k 20 --jinja">${esc(r.argsDraft || '')}</textarea>
      <div class="help">这里写的参数会<b>替换</b>自动生成的同一项（例如写 <code>-ngl 24 -c 2048</code>，命令里就不再有 -ngl 999、-c 32768），没写的保持自动。也可以点「填入当前全部参数」，在原命令基础上直接改数字。不用写模型路径、--host、--port（由软件管理）。写了 -ngl、-c、-ot、--n-cpu-moe 等显存相关参数后，软件不再自动分配显存。只对这个模型生效${running ? '，<b>重新启动模型后生效</b>' : ''}。</div></div>
    <div class="row" style="margin-top:8px"><button class="btn sm primary" data-act="saveArgs" ${dirty ? '' : 'disabled'}>保存参数</button><button class="btn sm" data-act="fillArgs">填入当前全部参数</button>${saved ? '<button class="btn sm" data-act="clearArgs">清空，恢复自动</button>' : ''}${running && saved && !dirty ? '<button class="btn sm" data-act="restartModel">重新启动模型</button>' : ''}
      <a href="#" class="muted" style="font-size:12.5px;margin-left:auto" data-act="extLink" data-url="https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md">llama-server 参数说明</a></div>
  </details>`;
}

function pageRun() {
  const r = S.run;
  const sv = S.server;
  const locals = S.local || [];
  if (!r.path && sv.running) r.path = sv.model_path;
  if (!r.path && locals.length) r.path = locals[0].path;
  const p = r.plan?.plan;
  const m = r.plan?.model;
  const g = primaryGpu();
  const h = S.overview?.hardware;
  const runningThis = sv.running && sv.model_path === r.path;

  if (!locals.length) {
    return `<div class="page"><h1>运行</h1>${!S.engine ? engineCard() : engineHealthWarn() || engineGpuWarn()}<div class="card empty">还没有模型。<br><button class="btn primary" style="margin-top:12px" data-act="go" data-page="models">去下载模型</button></div></div>`;
  }

  const opts = locals.map((x) => `<option value="${esc(x.path)}" ${x.path === r.path ? 'selected' : ''}>${esc(x.name)} · ${esc(x.info.file_type)} · ${fmtGB(x.info.total_bytes)}</option>`).join('');
  const ctxs = [[0, '自动'], [8192, '8K'], [16384, '16K'], [32768, '32K'], [65536, '64K']]
    .map(([v, l]) => `<button role="radio" aria-checked="${r.ctx === v}" class="${r.ctx === v ? 'on' : ''}" data-act="ctx" data-v="${v}">${l}</button>`)
    .join('');

  const layer = (cls, title, used, cap, note) => `<div class="layer ${cls}">
      <div class="between"><span>${title}</span><span class="mono" style="font-size:13px">${cap ? `${fmtGB(used)} / ${fmtGB(cap)}` : fmtGB(used)}</span></div>
      <div class="bar"><i class="c-${cls}" style="width:${cap ? Math.min(100, (used / cap) * 100).toFixed(0) : used > 0 ? 8 : 0}%"></i></div>
      <div class="note">${esc(note)}</div></div>`;

  const planHtml = p
    ? `<div class="stack" style="gap:6px"><h2 style="font-size:18px">自动分层规划</h2><div style="font-size:13px;color:var(--text-2);line-height:1.7">${esc(p.summary)}</div></div>
       ${layer('gpu', `显卡 · ${esc(g ? g.name : '无独立显卡')}`, p.gpu_bytes + (p.gpu_bytes > 0 ? p.kv_bytes : 0), g ? g.vram_bytes : 0, p.gpu_note)}
       ${layer('ram', `内存 · ${esc(h?.memory.kind || '')}`, p.ram_bytes, h ? h.memory.total_bytes : 0, p.ram_note)}
       ${layer('disk', '硬盘 · 按需读取', p.disk_bytes, 0, p.disk_note)}
       ${argsHtml(r)}`
    : '<div class="empty">正在计算…</div>';

  // 首次加载时间：固态约 1.5 GB/s，机械硬盘约 0.15 GB/s
  const mdisk = m ? diskOfPath(m.path) : null;
  const loadSecs = m ? Math.round(m.info.total_bytes / GB / (mdisk && !mdisk.is_ssd ? 0.15 : 1.5) + 5) : 0;
  const stats = r.stats;
  const monitor = sv.running
    ? `<section class="card monitor" aria-label="运行状态">
        <div class="row" style="gap:8px"><span class="pulse ${sv.ready ? 'live' : ''}"></span><b style="font-size:13px">${sv.ready ? '运行中 · ' + esc(sv.model_name) : '正在加载模型…'}</b></div>
        ${sv.ready && r.actual ? actualHtml(r.actual) : ''}
        <div class="stat"><span>生成速度</span><b>${r.lastTps ? r.lastTps.toFixed(1) + ' tok/s' : '—'}</b></div>
        <div class="stat"><span>显存</span><b style="color:var(--clay-ink)">${stats && stats.vram_used != null ? `${fmtGB(stats.vram_used)} / ${fmtGB(stats.vram_total)}` : '—'}</b></div>
        <div class="stat"><span>内存</span><b style="color:var(--blue-ink)">${stats ? `${fmtGB(stats.ram_used)} / ${fmtGB(stats.ram_total)}` : '—'}</b></div>
        <div class="row" style="flex:1 1 260px;justify-content:flex-end;gap:8px"><code class="mono" style="font-size:12px;background:var(--sunk);border:1px solid var(--line);border-radius:6px;padding:7px 10px">http://127.0.0.1:${sv.port}/v1</code><button class="btn sm" data-act="copyApi">复制</button></div>
      </section>`
    : '';

  // 画图 / 视频模型（在「搜索 HuggingFace」里下载的）：不能用对话引擎运行，给一键移过去的按钮
  const cur = locals.find((x) => x.path === r.path);
  const diffusion = cur?.info?.is_diffusion;
  const diffusionCard = `<section class="card diffusion-card">
      <h2 style="font-size:18px">这是画图 / 视频模型</h2>
      <p>「${esc(cur?.name || '')}」是 stable-diffusion 格式的${/h3|ltx|wan|hunyuan|video|vid/i.test(r.path) ? '视频' : '画图'}模型，不能在这里用对话引擎启动（所以会报「不支持这个模型架构」）。</p>
      <p class="muted" style="font-size:13px">点下面的按钮，把它移到画图 / 视频模型里（不用重新下载）。视频模型还需要配套的文本编码器和 VAE，移过去以后在模型页点「下载」会自动只补缺的部分。</p>
      <div class="row" style="gap:8px;margin-top:6px"><button class="btn primary" data-act="adoptImageModel" data-path="${esc(r.path)}" ${r.adopting ? 'disabled' : ''}>${r.adopting ? '正在移动…' : '移到视频 / 画图模型'}</button><button class="btn" data-act="go" data-page="models" data-tab="image">查看画图 / 视频模型</button></div>
      ${r.adoptUnknown ? `<div class="adopt-pick"><label for="adoptFam">认不出这个文件属于哪个模型，请选一下：</label><div class="row" style="gap:8px;margin-top:6px"><select id="adoptFam" class="input" style="max-width:320px">${(S.img?.catalog || []).map((x) => `<option value="${esc(x.id)}">${esc(x.name)}（${x.kind === 'video' ? '视频' : '画图'}）</option>`).join('')}</select><button class="btn primary" data-act="adoptImageModel" data-path="${esc(r.path)}" data-pick="1">移过去</button></div></div>` : ''}
      ${r.adoptError ? `<div class="pay-err" style="margin-top:10px">${esc(r.adoptError)}</div>` : ''}
    </section>`;

  return `<div class="page">
    ${!S.engine ? engineCard() : engineHealthWarn() || engineGpuWarn()}
    <div class="page-head">
      <div class="stack" style="gap:6px"><div class="muted" style="font-size:13px">${runningThis ? (sv.ready ? '正在运行' : '正在加载') : '准备运行'}</div>
        <label class="sr" for="runSel">选择模型</label><select id="runSel" class="input" data-change="runSel" style="font-size:15px;font-weight:600;max-width:640px">${opts}</select></div>
      <button class="btn" data-act="go" data-page="models">管理模型</button>
    </div>
    ${diffusion ? diffusionCard : `${r.error ? runErrorHtml(r.error) : ''}
    ${r.starting || (runningThis && !sv.ready) ? `<section class="card loadcard" id="loadcard" aria-live="polite">${loadHtml()}</section>` : ''}
    <div class="split">
      <section class="card stack" style="gap:16px" aria-label="自动分层规划">${planHtml}</section>
      <section class="card side-card stack" style="gap:20px" aria-label="运行设置">
        <div class="stack" style="gap:10px"><div class="muted" style="font-size:13px">上下文长度${p ? ` · 当前 ${p.ctx / 1024}K` : ''}</div><div class="radios" role="radiogroup" aria-label="上下文长度">${ctxs}</div><div class="muted" style="font-size:12px">越长越能读长文档，但更占显存。「自动」会选不降速的最大值。</div></div>
        <div class="opt"><div><div class="t">思考模式</div><div class="s">先想再答，更准但更慢（支持的模型才有效）</div></div><button class="switch ${S.thinking ? 'on' : ''}" role="switch" aria-checked="${S.thinking}" aria-label="思考模式" data-act="toggleThinking"></button></div>
        ${gpuPickHtml()}
        ${perfOptsHtml()}
        <div class="opt"><div><div class="t">局域网访问</div><div class="s">让手机、其他电脑也能调用这里的 API</div></div><button class="switch ${S.settings?.lan_access ? 'on' : ''}" role="switch" aria-checked="${!!S.settings?.lan_access}" aria-label="局域网访问" data-act="toggleLan"></button></div>
        <div class="est"><div class="stat">${S.server.ready && S.server.model_path === r.path && r.lastTps ? `<span>实际速度</span><b>${r.lastTps.toFixed(1)} tok/s</b>` : `<span>预计速度</span><b>${p ? fmtTps(p.est_tps).replace('约 ', '') : '—'}</b>`}</div><div class="stat"><span>首次加载</span><b>${loadSecs ? `约 ${fmtDur(loadSecs)}` : '—'}</b></div></div>
        ${runningThis
          ? `<button class="btn lg block" data-act="stopModel">停止模型</button>${sv.ready ? '<button class="btn primary lg block" data-act="go" data-page="chat">开始对话</button>' : ''}`
          : `<button class="btn primary lg block" data-act="startModel" ${r.starting || !S.engine || !p ? 'disabled' : ''}>${r.starting ? '正在启动…' : sv.running ? '切换到这个模型' : '启动模型'}</button>`}
      </section>
    </div>`}
    ${monitor}
    <details data-open="logsOpen" ${r.logsOpen ?? r.error ? 'open' : ''}><summary>运行日志</summary><div class="logs" id="logs" style="margin-top:10px">${S.logs.slice(-200).map(logLine).join('\n')}</div></details>
  </div>`;
}

// ------------------------------------------------------------------ 页面：对话
const EXT = { html: 'html', htm: 'html', javascript: 'js', js: 'js', typescript: 'ts', ts: 'ts', python: 'py', py: 'py', bash: 'sh', sh: 'sh', shell: 'sh', zsh: 'sh', powershell: 'ps1', ps1: 'ps1', bat: 'bat', cmd: 'bat', batch: 'bat', css: 'css', json: 'json', sql: 'sql', go: 'go', rust: 'rs', rs: 'rs', java: 'java', c: 'c', cpp: 'cpp', 'c++': 'cpp', csharp: 'cs', cs: 'cs', php: 'php', ruby: 'rb', rb: 'rb', lua: 'lua', vue: 'vue', jsx: 'jsx', tsx: 'tsx', yaml: 'yml', yml: 'yml', xml: 'xml', markdown: 'md', md: 'md', svg: 'svg', dockerfile: 'Dockerfile', kotlin: 'kt', swift: 'swift', r: 'r', toml: 'toml', ini: 'ini' };
const PREVIEWABLE = new Set(['html', 'htm', 'svg', 'xml']);

function curChat() {
  return S.chats.find((c) => c.id === S.chatId);
}
// 保存对话：图片只存缩略图、长文档截短、不保存「本次对话允许」的授权，避免本地存储爆满
function saveChats() {
  const slim = S.chats.slice(0, 100).map(({ allow, ...c }) => ({
    ...c,
    messages: c.messages.map((m) =>
      m.attachments
        ? { ...m, attachments: m.attachments.map((a) => (a.kind === 'image' ? { ...a, data: '' } : { ...a, data: (a.data || '').slice(0, 30000) })) }
        : m,
    ),
  }));
  store.set('chats', slim);
}
function newChat() {
  const c = { id: Date.now().toString(36), title: '新对话', messages: [] };
  S.chats.unshift(c);
  S.chatId = c.id;
  saveChats();
}

/** 日志一行上色：错误红、警告黄、LocModel 自己的提示蓝、时间戳灰 */
function logLine(line) {
  const s = String(line);
  const cls = /(^|\s)E\s|error|错误|失败|CUDA error|illegal|misaligned/i.test(s) ? 'del' : /(^|\s)W\s|warn/i.test(s) ? 'warn' : /^\[LocModel\]/.test(s) ? 'fn' : '';
  const m = s.match(/^(\d+\.\d+\.\d+\.\d+\s+)([\s\S]*)$/);
  const body = m ? m[2] : s;
  const head = m ? `<span class="t-com">${esc(m[1])}</span>` : '';
  return head + (cls ? `<span class="t-${cls}">${esc(body)}</span>` : esc(body));
}

function renderAiMessage(msg, mi) {
  const { html } = MD.render(msg.content, (code) => {
    const key = `${mi}:${code.index}`;
    const lang = code.lang || 'text';
    const canPrev = PREVIEWABLE.has(lang) || (!code.lang && /^\s*<(!doctype|html|svg)/i.test(code.text));
    const acts = code.closed
      ? `<button class="btn sm" data-act="copyCode" data-mi="${mi}" data-ci="${code.index}">复制</button>
         <button class="btn sm" data-act="saveCode" data-mi="${mi}" data-ci="${code.index}">下载 .${esc(EXT[lang] || 'txt')}</button>
         ${canPrev ? `<button class="btn sm primary" data-act="previewCode" data-mi="${mi}" data-ci="${code.index}">${S.previews.has(key) ? '收起预览' : '▶ 运行预览'}</button>` : ''}`
      : '<span class="muted" style="font-size:12px">生成中…</span>';
    let out = `<div class="code"><div class="code-bar"><span class="lang"><i></i><i></i><i></i>${esc(lang)}</span><div class="acts">${acts}</div></div><pre class="hl">${HL.highlight(code.text, code.lang)}</pre></div>`;
    if (S.previews.has(key) && code.closed) {
      out += `<div class="preview"><div class="code-bar"><span>预览 · 沙箱运行，不能访问你的文件</span><div class="acts"><button class="btn sm" data-act="rerunPreview" data-key="${key}">↻ 重新运行</button><button class="btn sm" data-act="fullPreview" data-mi="${mi}" data-ci="${code.index}">全屏</button></div></div>
        <iframe sandbox="allow-scripts allow-modals allow-forms allow-pointer-lock" data-key="${key}" srcdoc="${esc(previewDoc(code))}"></iframe></div>`;
    }
    return out;
  });
  const think = msg.reasoning
    ? `<details class="think" ${msg.done ? '' : 'open'}><summary>${msg.done ? '思考过程' : '正在思考…'}</summary><div>${esc(msg.reasoning)}</div></details>`
    : '';
  // 正在输出时：在回答下面实时显示生成速度（和 llama.cpp 网页版一样）；说完后换成最终统计
  const meta = msg.stats
    ? `<div class="m-meta">${msg.stats}</div>`
    : !msg.done && msg.liveTps
      ? `<div class="m-meta live"><span class="live-dot" aria-hidden="true"></span>${msg.liveTokens} tokens · ${msg.liveTps.toFixed(1)} tok/s</div>`
      : '';
  if (msg.media && typeof chatMediaHtml === 'function') return chatMediaHtml(msg);
  const steps = typeof stepsHtml === 'function' ? stepsHtml(msg) : '';
  // 正在做什么（Agent 长任务、对话压缩）：一直显示一条状态，让人知道它在干活
  const live = !msg.done && msg.live
    ? `<div class="live-bar"><span class="spin" aria-hidden="true"></span><span>${esc(msg.live.label)}</span>${msg.t0 ? `<span class="live-t">${fmtSecs((Date.now() - msg.t0) / 1000)}${msg.steps?.length ? ` · ${msg.steps.filter((x) => x.name !== '_note').length} 步` : ''}</span>` : ''}</div>`
    : '';
  return `${think}${steps}${html ? `<div class="md-body">${html}</div>` : msg.done || msg.steps?.length || live ? '' : '<span class="muted">…</span>'}${live}${meta}`;
}
function previewDoc(code) {
  const t = code.text;
  if (code.lang === 'svg' || /^\s*<svg/i.test(t)) return `<!doctype html><html><body style="margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#fff">${t}</body></html>`;
  return t;
}
// 当前页面上的对话（对话页 = 当前对话；Agent 页 = 当前任务）
function curThread() {
  return S.page === 'agent' && typeof curTask === 'function' ? curTask() : curChat();
}
function codeOf(mi, ci) {
  const msg = curThread()?.messages[mi];
  if (!msg) return null;
  let found = null;
  MD.render(msg.content, (c) => {
    if (c.index === ci) found = c;
    return '';
  });
  return found;
}

// 记住「推理加速与稳定性」是否展开（页面重绘后保持）
document.addEventListener('toggle', (e) => { if (e.target?.classList?.contains('perf-opts')) S.run.perfOpen = e.target.open; }, true);
// 「运行」页：多张显卡时选用哪几张（不选 = 全部，引擎按显存自动分配）
function gpuPickHtml() {
  const gpus = S.engCheck?.gpus || [];
  if (gpus.length < 2) return '';
  const sel = (S.settings?.gpu_devices || []).filter((d) => gpus.some((g) => g.id === d));
  const all = !sel.length;
  const chip = (id, label, on, title = '') => `<button type="button" class="chip ${on ? 'on' : ''}" data-act="pickGpu" data-id="${esc(id)}" title="${esc(title)}" aria-pressed="${on}">${label}</button>`;
  return `<div class="stack" style="gap:6px"><div class="t" style="font-size:14px">使用的显卡</div>
    <div class="chips">${chip('', `全部 ${gpus.length} 张`, all, '模型自动分到几张卡上，能跑更大的模型')}${gpus.map((g) => chip(g.id, `${esc(shortGpu(g.name))}${g.mib ? ` · ${Math.round(g.mib / 1024)} GB` : ''}`, sel.includes(g.id), g.id)).join('')}</div>
    <div class="muted" style="font-size:12px">选「全部」会把模型分到几张卡上，能跑更大的模型；只选一张更稳定，另一张可以留给画图、游戏。</div>${S.server.running && S.run.gpuDirty ? '<div class="row" style="gap:8px;align-items:center"><span class="muted" style="font-size:12px">重新启动模型后生效</span><button class="btn sm" data-act="restartModel">立即重启</button></div>' : ''}</div>`;
}
// 「运行」页：推理加速和稳定性选项
function perfOptsHtml() {
  const s = S.settings || {};
  const fa = s.perf_fa !== 'off';
  const kv = s.perf_kv || 'q8_0';
  const kvBtn = (v, label) => `<button type="button" class="${kv === v ? 'on' : ''}" role="radio" aria-checked="${kv === v}" data-act="setPerf" data-k="kv" data-v="${v}">${label}</button>`;
  return `<details class="perf-opts" ${S.run.perfOpen ? 'open' : ''}>
    <summary><span class="t">推理加速与稳定性</span><span class="s">Flash Attention ${fa ? '开' : '关'} · KV 缓存 ${{ q8_0: 'Q8', f16: 'F16', q4_0: 'Q4' }[kv]} · 崩溃自动重启 ${s.auto_restart === false ? '关' : '开'}</span></summary>
    <div class="perf-body">
    <div class="opt"><div><div class="t">Flash Attention</div><div class="s">更快、更省显存，建议一直开着</div></div><button class="switch ${fa ? 'on' : ''}" role="switch" aria-checked="${fa}" aria-label="Flash Attention" data-act="setPerf" data-k="fa"></button></div>
    <div class="stack" style="gap:6px"><div class="t" style="font-size:14px">KV 缓存精度</div><div class="radios" role="radiogroup" aria-label="KV 缓存精度">${kvBtn('q8_0', 'Q8（推荐）')}${kvBtn('f16', 'F16 最准')}${kvBtn('q4_0', 'Q4 最省')}</div>
      <div class="muted" style="font-size:12px">Q8：显存占用减半，质量几乎不变；F16：最准但更占显存；Q4：显存最省，能开更长的上下文，回答质量略降${fa ? '' : '（Flash Attention 关闭时只量化 K）'}。</div></div>
    <div class="opt"><div><div class="t">崩溃自动重启</div><div class="s">模型进程意外退出时自动重新启动；显卡计算出错会自动换兼容模式</div></div><button class="switch ${s.auto_restart === false ? '' : 'on'}" role="switch" aria-checked="${s.auto_restart !== false}" aria-label="崩溃自动重启" data-act="setPerf" data-k="restart"></button></div>
    ${S.run.perfDirty && S.server.running ? '<div class="row" style="gap:8px;align-items:center"><span class="muted" style="font-size:12px">重新启动模型后生效</span><button class="btn sm" data-act="restartModel">立即重启</button></div>' : ''}
    </div>
  </details>`;
}

// 模型运行中崩溃：原因 + 一键重启（用上次的模型和设置）
function crashBanner() {
  const [head, ...rest] = S.crash.message.split('\n\n');
  return `<div class="crash" role="alert">
    <div class="between" style="align-items:flex-start;gap:12px"><div><b>模型进程意外退出</b><div style="margin-top:4px">${esc(head)}</div></div>
      <div class="row" style="gap:6px;flex:0 0 auto"><button class="btn sm" data-act="dismissCrash">关闭</button><button class="btn sm primary" data-act="restartModel">重新启动模型</button></div></div>
    ${rest.length ? `<details style="margin-top:8px"><summary>查看日志</summary><pre class="cmd">${rest.join('\n\n').split('\n').map(logLine).join('\n')}</pre></details>` : ''}
  </div>`;
}

function chatPlaceholder() {
  if (S.chatMedia === 'image') return S.pending?.some((a) => a.kind === 'image') ? '说说要怎么改这张图，例如：把背景换成海边' : '描述你想要的画面，或者附一张图说怎么改';
  if (S.chatMedia === 'video') return '描述视频里发生的事，例如：海浪拍打礁石，日落，镜头缓慢推进';
  const sv = S.server;
  if (usingApi() || sv.ready) return S.useComputer ? '告诉它要在电脑上做什么，例如：打开记事本写一首诗' : '问点什么（Enter 发送，Shift+Enter 换行）';
  if (sv.running) return '模型加载中…';
  if (S.pausedChat) return '对话模型已暂停（显存让给了画图），直接发消息会自动重新启动';
  return '点左上角的模型名，选一个本地模型就会自动加载；画图、做视频不用加载';
}
function pageChat() {
  if (!S.chatId || !curChat()) {
    if (!S.chats.length) newChat();
    else S.chatId = S.chats[0].id;
  }
  const c = curChat();
  const sv = S.server;
  const sumAt = c.summary?.upto || 0;
  const sumBar = (i) => (i === sumAt && sumAt > 0
    ? `<details class="sum-bar"><summary>以上 ${sumAt} 条消息已压缩成摘要（模型现在只记得摘要，你仍然可以往上翻看原文）</summary><div>${esc(c.summary.text)}</div></details>`
    : '');
  const msgs = c.messages.length
    ? c.messages
        .map((m, i) => sumBar(i) +
          (S.editMsg === i
            ? msgEditorHtml(m, i)
            : m.role === 'user'
            ? `${m.attachments?.length ? `<div class="m-att">${attachChips(m.attachments, false, i)}</div>` : ''}${m.content ? `<div class="m-user">${esc(m.content)}</div>` : ''}${msgActionsHtml(m, i)}`
            : `<div class="m-ai" id="msg-${i}">${renderAiMessage(m, i)}</div>${msgActionsHtml(m, i)}`),
        )
        .join('')
    : `<div class="welcome"><h1>有什么可以帮你？</h1><p>模型完全在你的电脑上运行，对话内容不会上传。</p></div>`;
  const status = sv.running
    ? `<span class="pulse ${sv.ready ? 'live' : ''}"></span>${esc(sv.model_name)}${sv.ready ? '' : '（加载中）'}`
    : `<span class="pulse" style="background:#B5AFA1"></span>${S.pausedChat ? '对话模型已暂停（显存让给了画图）' : '还没有启动模型'}`;
  return `<div class="chat-wrap">
    ${chatListWrap()}
    <div class="chat-main">
      <div class="chat-top">${typeof srcButton === 'function' ? srcButton() : `<button class="btn" data-act="go" data-page="run" style="display:flex;align-items:center;gap:8px;font-weight:600">${status}</button>`}
        <div class="info"><span>思考：${S.thinking ? '开' : '关'}</span><span>本机运行 · 不联网</span></div></div>
      ${S.crash ? crashBanner() : ''}
      <div class="msgs" id="msgs"><div class="msgs-in">${msgs}</div></div>
      <div class="composer-wrap">
        <form class="composer" data-submit="send">
          <div class="pending ${S.pending?.length ? '' : 'hidden'}" id="pendingBox">${attachChips(S.pending, true)}</div>
          <label class="sr" for="msgInput">输入消息</label>
          <textarea id="msgInput" rows="2" placeholder="${chatPlaceholder()}"></textarea>
          <div class="cfoot">${composerBar()}<button class="send" type="submit" aria-label="${S.streaming ? '停止' : '发送'}" id="sendBtn">${S.streaming ? '■' : '↑'}</button></div></form>
        <div class="hint">${S.chatMedia ? (S.chatMedia === 'video' ? '视频模式：描述画面就能生成视频，可以说「竖屏」「5 秒」；附上图片能让它动起来' : '画图模式：描述画面就能画，可以说「竖屏」「画 4 张」；附上图片说「把背景换成海边」就能改图') : S.useComputer ? '操作电脑已开启：每一步都会先问你，点 ■ 随时停止' : '支持图片和文档；要画图、改图或生成视频，先点下面的「画图」或「视频」按钮'}</div>
      </div>
    </div>
  </div>`;
}

let rafPending = false;
function updateStreamingMessage(mi) {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    const el = document.getElementById(`msg-${mi}`);
    const msg = curThread()?.messages[mi];
    if (!el || !msg) return;
    const box = $('#msgs');
    const atBottom = box ? box.scrollHeight - box.scrollTop - box.clientHeight < 120 : false;
    el.innerHTML = renderAiMessage(msg, mi);
    if (box && atBottom) box.scrollTop = box.scrollHeight;
  });
}

// sendMessage / retryLast / streamReply 在 agent.js（附件、工具调用、操作电脑）

// ------------------------------------------------------------------ 页面：设置
function fmtDate(sec) {
  if (!sec) return '';
  if (sec >= 4102444800) return '终身';
  const d = new Date(sec * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 设置页「显卡」：显示检测结果；检测不到或显存不对时可以手动指定
function gpuSection() {
  const h = S.overview?.hardware;
  const g = h ? primaryGpu(h) : null;
  const o = S.settings?.gpu_override;
  const all = (h?.gpus || []).map((x) => `${esc(x.name)}（${fmtSize(x.vram_bytes)}${x.integrated ? '，核显' : ''}）`).join('、');
  const back = { cuda: 'CUDA（N 卡）', vulkan: 'Vulkan（显卡通用）', metal: 'Metal（Apple 芯片）', cpu: 'CPU' }[h?.backend] || '';
  return `<section class="card form">
      <h2 style="font-size:17px">显卡</h2>
      <div class="between"><div><b>${g ? `${esc(g.name)} · ${fmtSize(g.vram_bytes)}` : '未检测到独立显卡'}</b>
        <div class="help" style="font-size:12px;color:var(--text-3);margin-top:4px">${o && o.vram_gb > 0 ? '手动指定' : '自动检测'}${back ? ` · 推理用 ${back}` : ''}${all ? `<br>检测到：${all}` : ''}</div></div>
        <button class="btn sm" data-act="redetectGpu">重新检测</button></div>
      <details ${o && o.vram_gb > 0 ? 'open' : ''}><summary class="muted" style="font-size:13px;cursor:pointer">检测不到显卡，或者显存不对？手动指定</summary>
        <div class="row" style="margin-top:12px;align-items:flex-end">
          <div class="field" style="margin:0"><label for="st-gv">品牌</label><select class="input" id="st-gv">${[['amd', 'AMD（A 卡）'], ['nvidia', 'NVIDIA（N 卡）'], ['intel', 'Intel（i 卡）']].map(([k, v]) => `<option value="${k}" ${(o?.vendor || 'amd') === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
          <div class="field" style="margin:0;flex:1;min-width:180px"><label for="st-gn">型号</label><input class="input" id="st-gn" value="${esc(o?.name || '')}" placeholder="例如 AMD Radeon RX 9070 XT"></div>
          <div class="field" style="margin:0;width:110px"><label for="st-gm">显存（GB）</label><input class="input" id="st-gm" type="number" min="0" step="1" value="${o?.vram_gb || ''}" placeholder="16"></div>
        </div>
        <div class="help" style="margin-top:8px">保存设置后生效。显存填 0 或留空 = 取消手动指定，改回自动检测。A 卡、i 卡用 Vulkan 版推理引擎运行。</div>
      </details>
    </section>`;
}

// 下载服务器：把每条线路（m1、m2）解析出的所有服务器拉平成「下载服务器 1、2、3…」，逐台测延迟，用户自由切换
function nodesHtml() {
  const a = S.accel;
  const nodes = a.nodes || [];
  if (!nodes.length) return '';
  const testing = S.lineTesting;
  const auto = !a.preferred;
  const pings = (S.serverPings || []).filter((p) => p.ip);
  const okMs = pings.filter((p) => p.ok).map((p) => p.ms);
  const bestMs = okMs.length ? Math.min(...okMs) : 0;
  const msColor = (ms) => (ms <= 120 ? '#2E7D4F' : ms <= 250 ? 'var(--clay-ink)' : 'var(--red-ink)');
  let rows;
  if (!S.serverPings) {
    rows = `<div class="muted" style="font-size:12.5px;padding:6px 0">${testing ? '正在解析下载服务器并测试延迟…' : '点「测试延迟」查看每台下载服务器的延迟'}</div>`;
  } else if (!pings.length) {
    rows = '<div style="font-size:12.5px;color:var(--red-ink);padding:6px 0">没有解析到下载服务器，请检查网络后重试</div>';
  } else {
    rows = pings
      .map((p, k) => {
        const cur = a.preferred === p.line && a.preferred_ip === p.ip;
        const lat = p.ok
          ? `<span class="mono" style="color:${msColor(p.ms)}">${p.ms} ms</span>${p.ms === bestMs ? ' <span class="tag" style="font-size:11px">最快</span>' : ''}`
          : '<span style="color:var(--red-ink)">超时</span>';
        const btn = cur
          ? '<span class="tag clay">使用中</span>'
          : `<button class="btn sm" data-act="useServer" data-url="${esc(p.line)}" data-ip="${esc(p.ip)}" ${testing || !p.ok ? 'disabled' : ''}>使用</button>`;
        return `<div class="between" style="font-size:13px;min-height:32px;gap:10px;border-top:1px solid var(--line)"><span style="flex:1">下载服务器 ${k + 1}</span><span style="width:130px;text-align:right">${lat}</span><span style="width:84px;text-align:right">${btn}</span></div>`;
      })
      .join('');
  }
  // 中国大陆网络（连不上 HuggingFace）：国内加速线路直接用本地网络下载，比绕到国外的下载服务器快得多。
  // 不管下面选了哪台服务器，都先用它；速度不够时才自动换下面的下载服务器
  const cnNet = S.net?.checked && S.net.hf_ok === false && S.settings?.hf_mirror !== 'off';
  if (cnNet) {
    rows = `<div class="between" style="font-size:13px;min-height:32px;gap:10px"><span style="flex:1"><b>最快加速</b> <span class="muted" style="font-size:12px">国内网络专用，用本地网络直接下载</span></span><span style="width:130px;text-align:right"><span class="tag" style="font-size:11px">推荐</span></span><span style="width:84px;text-align:right"><span class="tag clay">优先使用</span></span></div>` + rows;
  }
  const curIdx = pings.findIndex((p) => p.line === a.preferred && p.ip === a.preferred_ip);
  const curTxt = auto ? '当前：自动分配服务器' : curIdx >= 0 ? `当前：下载服务器 ${curIdx + 1}（连不上时自动换其他服务器）` : '当前：已指定服务器（连不上时自动换其他服务器）';
  return `<div class="stack" style="gap:2px;background:var(--sunk);border-radius:10px;padding:12px 14px">
    <div class="between" style="margin-bottom:6px"><b style="font-size:13.5px">下载服务器</b>
      <div class="row" style="gap:8px">${auto ? '' : `<button class="btn sm" data-act="autoServer" ${testing ? 'disabled' : ''}>改回自动</button>`}
      <button class="btn sm primary" data-act="testLines" ${testing ? 'disabled' : ''}>${testing ? '正在测试…' : '测试延迟'}</button></div></div>
    ${rows}
    <div class="muted" style="font-size:12px;margin-top:6px">${cnNet ? '检测到国内网络：下载时总是先用「最快加速」，速度不够时才换下面的下载服务器（下面选的服务器只影响备用顺序）。' : ''}${curTxt}。ping 值越低意味着网络越稳定，但不代表下载速度越快，建议切换不同的服务器试试。</div>
  </div>`;
}
function refreshNodes() {
  const el = document.getElementById('nodeBox');
  if (el) el.innerHTML = nodesHtml();
}
async function runPingTest() {
  if (S.lineTesting) return;
  S.lineTesting = true;
  refreshNodes();
  try {
    S.serverPings = await call('ping_servers');
  } catch {}
  S.lineTesting = false;
  refreshNodes();
}

function pageSettings() {
  const s = S.settings;
  if (S.imagesDirPath === undefined) {
    S.imagesDirPath = '';
    invoke('images_dir_path').then((p) => { S.imagesDirPath = p; const el = $('#st-imgdir'); if (el) el.placeholder = '默认：' + p; }).catch(() => {});
  }
  if (!s) return '<div class="page"><h1>设置</h1></div>';
  if (S.autostart === undefined && !S.autostartLoading) {
    S.autostartLoading = true;
    invoke('get_autostart').then((v) => { S.autostart = !!v; if (S.page === 'settings') render(); }).catch(() => { S.autostart = false; });
  }
  const e = S.engine;
  const a = S.accel;
  const f = (id, label, val, help, type = 'text', ph = '') => `<div class="field"><label for="${id}">${label}</label><input class="input" id="${id}" type="${type}" value="${esc(val)}" placeholder="${esc(ph)}">${help ? `<div class="help">${help}</div>` : ''}</div>`;
  const accel = a.member
    ? `<div class="between"><div><b>已开启</b><div class="help" style="font-size:12px;color:var(--text-3);margin-top:4px">${a.expires ? (a.expires >= 4102444800 ? '终身有效' : '到期 ' + fmtDate(a.expires)) : ''}</div></div>
         <div class="row"><button class="btn sm" data-act="openBuy">续费</button></div></div>
       <div id="nodeBox">${nodesHtml()}</div>
       <div class="field"><label>激活码（更新软件、重装系统、换电脑时用它恢复，请保存好）</label><div class="row"><input class="input mono" style="flex:1;font-size:12px" readonly value="${esc(a.token)}"><button class="btn sm" data-act="copyToken">复制</button></div></div>`
    : `<div class="between"><div><b>未开启</b></div><button class="btn sm primary" data-act="openBuy">立即开通</button></div>
       <div id="nodeBox">${nodesHtml()}</div>
       <div class="field"><label for="st-code">激活码 / 令牌 / 订单号</label><div class="row"><input class="input mono" id="st-code" style="flex:1" placeholder="输入激活码、令牌或购买时的订单号"><button class="btn" data-act="activateFromSettings">激活</button></div>
         <div class="help">以前买过但找不到激活码：填支付宝 / 微信账单详情里的订单号也能恢复，或者 <a href="#" data-act="modalRecover">用购买时填的邮箱找回</a>。</div></div>`;
  return `<div class="page" style="max-width:820px">
    <h1>设置</h1>
    <section class="card stack" style="gap:18px">
      <h2 style="font-size:17px">模型存放</h2>
      <div class="field"><label for="st-dir">模型目录</label><div class="row"><input class="input" id="st-dir" style="flex:1" value="${esc(s.models_dir)}"><button class="btn" data-act="pickDir">选择…</button></div><div class="help">放在剩余空间大的固态硬盘上，加载更快。已下载的模型不会自动搬家。</div></div>
      <div class="field"><label for="st-imgdir">作品保存位置（画图 / 视频）</label><div class="row"><input class="input" id="st-imgdir" style="flex:1" value="${esc(s.images_dir || '')}" placeholder="${esc(S.imagesDirPath ? '默认：' + S.imagesDirPath : '默认：图片/LocModel')}"><button class="btn" data-act="pickImgDir">选择…</button></div><div class="help">留空用默认位置。生成后提示「保存图片失败：找不到指定的文件」时，换成一个普通文件夹（例如 D:\\LocModel作品）再保存设置。</div></div>
    </section>
    <section class="card form">
      <h2 style="font-size:17px">界面</h2>
      <div class="field"><label for="st-lang">界面语言</label><div class="row" style="gap:12px;align-items:center">${typeof langSelectHtml === 'function' ? langSelectHtml() : ''}<span class="help" style="margin:0">切换后界面会重新加载</span></div></div>
      <div class="field"><label for="st-theme">外观</label>${typeof themeSelectHtml === 'function' ? themeSelectHtml() : ''}</div>
      <div class="between" style="gap:16px"><div><b style="font-size:13.5px">开机自动启动</b><div class="help" style="margin-top:2px">开机后自动打开 LocModel（最小化到任务栏）。默认关闭，需要时再打开。</div></div>
        <button class="switch ${S.autostart ? 'on' : ''}" role="switch" aria-checked="${!!S.autostart}" aria-label="开机自动启动" data-act="toggleAutostart" ${S.autostart === undefined ? 'disabled' : ''}></button></div>
    </section>
    ${gpuSection()}
    <section class="card form">
      <h2 style="font-size:17px">高速下载服务</h2>
      ${accel}
    </section>
    <section class="card form">
      <h2 style="font-size:17px">推理引擎</h2>
      <div class="between"><div><b>${e ? `llama.cpp ${esc(e.tag)} · ${esc(e.variant)}` : '未安装'}</b><div class="help" style="font-size:12px;color:var(--text-3);margin-top:4px">${e ? esc(e.server_path) : '首次运行模型前需要安装'}</div></div>
      <div class="row">${dlSlot('engine', `<button class="btn" data-act="importEngineDir">用已有的 llama.cpp</button><button class="btn" data-act="importEngine">手动导入 zip</button><button class="btn primary" data-act="installEngine">${e ? '更新到最新版' : '一键安装'}</button>`)}</div></div>
      <div class="between" style="gap:16px"><div><b style="font-size:13.5px">使用 CPU 版引擎（不用显卡）</b><div class="help" style="margin-top:2px">只在显卡驱动太旧、引擎一启动就退出时打开：不用显卡，速度慢一些，但能正常运行。切换后会重新安装引擎。</div></div>
        <button class="switch ${s.engine_cpu ? 'on' : ''}" role="switch" aria-checked="${!!s.engine_cpu}" aria-label="使用 CPU 版引擎" data-act="toggleEngineCpu"></button></div>
      ${f('st-port', '本地 API 端口', s.port, '被占用时会自动往后找空闲端口', 'number')}
    </section>
    <section class="card about">
      <div class="brand-mark lg" aria-hidden="true"><i class="c-gpu"></i><i class="c-ram"></i><i class="c-disk"></i></div>
      <div style="flex:1;min-width:0"><b style="font-size:15px">LocModel</b><span class="muted mono" style="font-size:12px;margin-left:8px">${S.version ? 'v' + esc(S.version) : ''}</span>
        <div class="help" style="font-size:12px;color:var(--text-3);margin-top:3px">本地大模型启动器 · 一键下载、自动适配硬件、离线对话</div></div>
      <div class="row" style="gap:6px"><button class="btn sm" data-act="checkUpdateNow">检查更新</button><button class="btn sm" data-act="extLink" data-url="https://www.locmodel.com/">访问官网</button></div>
    </section>
    <details class="card"><summary>高级设置</summary><div class="form" style="margin-top:16px">
      ${f('st-hf', 'HuggingFace 令牌（可选）', s.hf_token, '下载需要同意协议的模型（如部分 Llama、Gemma 仓库）时才需要。', 'password', 'hf_...')}
      ${f('st-mirror', 'HuggingFace 镜像（可选）', s.custom_mirror, '从官方源下载时改走指定镜像站。留空 = 官方地址。', 'text', 'https://')}
      ${f('st-gh', 'GitHub 下载前缀（可选）', s.github_mirror, '从 GitHub 官方下载引擎时加的代理前缀。', 'text', 'https://ghfast.top/')}
      <div class="field"><label for="st-lines">高速线路（每行一个，按顺序尝试）</label><textarea class="input mono" id="st-lines" rows="3" style="font-size:12px;resize:vertical">${esc((s.accel_lines || []).join('\n'))}</textarea></div>
      ${f('st-account', '账号中心地址', s.account_base, '')}
    </div></details>
    ${typeof apisSection === 'function' ? apisSection() : ''}
    <div class="row"><button class="btn primary lg" data-act="saveSettings">保存设置</button><button class="btn" data-act="openAppDir">打开数据目录</button></div>
    <div class="muted" style="font-size:12px;line-height:1.8">推理引擎：llama.cpp（MIT 协议）。模型和对话都只保存在你的电脑上，不会上传；软件只上报匿名的安装统计（版本、显卡型号），用来改进软件。官网 <a href="#" data-act="extLink" data-url="https://www.locmodel.com/">www.locmodel.com</a></div>
  </div>`;
}

// ------------------------------------------------------------------ 高速下载服务弹窗
function modalHtml() {
  const m = S.modal;
  if (!m) return '';
  let body;
  if (m.step === 'ask' && m.stall) {
    body = `<h2>官方源连接缓慢</h2>
      <p>已经等了几秒，还没从官方源收到数据，可能是网络环境原因。是否使用高速下载服务？</p>
      <p class="muted" style="font-size:13px">${esc(SLOW.sub)}</p>
      <div class="row" style="justify-content:flex-end;margin-top:8px"><button class="btn" data-act="closeModal">继续等待</button><button class="btn primary" data-act="openBuy">开通高速下载</button></div>
      <div style="margin-top:14px;font-size:12px"><a href="#" data-act="modalCode">已有激活码？</a></div>`;
  } else if (m.step === 'ask' && m.slow) {
    const fill = (t) => esc(t).replace(/\{speed\}/g, `<b>${fmtSpeed(m.slow.speed)}</b>`).replace(/\{time\}/g, `<b>${fmtMin(m.slow.remainMin)}</b>`);
    body = `<h2>${esc(SLOW.title)}</h2>
      <p>${fill(SLOW.text)}</p>
      <p class="muted" style="font-size:13px">${fill(SLOW.sub)}</p>
      <div class="row" style="justify-content:flex-end;margin-top:8px"><button class="btn" data-act="closeModal">继续当前下载</button><button class="btn primary" data-act="openBuy">开通高速下载</button></div>
      <div style="margin-top:14px;font-size:12px"><a href="#" data-act="modalCode">已有激活码？</a></div>`;
  } else if (m.step === 'ask') {
    const search = m.kind === 'search';
    body = `<h2>${m.expired ? '高速下载已到期' : '官方源下载失败'}</h2>
      <p>${m.expired ? esc(m.reason || '续费后即可继续下载，已下载的部分会保留。') : '从官方源下载失败，是否使用高速下载服务？'}</p>
      ${m.expired ? '' : `<p class="muted" style="font-size:13px">开启后，畅享高速、稳定的模型${search ? '搜索和' : ''}下载体验。<br>支持断点续传，主线路不可用时自动切换备用线路。</p>`}
      <div class="row" style="justify-content:flex-end;margin-top:8px"><button class="btn" data-act="closeModal">取消</button><button class="btn primary" data-act="openBuy">${m.expired ? '续费' : '开通高速下载'}</button></div>
      <div style="margin-top:14px;font-size:12px"><a href="#" data-act="modalCode">已有激活码？</a></div>`;
  } else if (m.step === 'custom') {
    body = m.html(m);
  } else if (m.step === 'chatcfg') {
    body = chatCfgHtml(m);
  } else if (m.step === 'vision') {
    body = visionHtml(m);
  } else if (m.step === 'plans') {
    body = plansHtml(m);
  } else if (m.step === 'pay') {
    body = payHtml(m);
  } else if (m.step === 'code') {
    body = `<h2>输入激活码</h2>
      <p class="muted" style="font-size:13px">输入激活码、高速下载令牌，或者购买时的订单号（在支付宝 / 微信账单详情里能看到）。</p>
      <form class="row" data-submit="modalActivate"><label class="sr" for="modalCode">激活码</label><input class="input mono" id="modalCode" style="flex:1" placeholder="激活码 / 令牌 / 订单号" autofocus><button class="btn primary" type="submit">激活</button></form>
      ${m.error ? `<div style="color:var(--red-ink);font-size:13px;margin-top:10px">${esc(m.error)}</div>` : ''}
      <div class="between" style="margin-top:14px"><a href="#" data-act="modalRecover" style="font-size:12.5px">找不到激活码？用购买邮箱找回</a><button class="btn" data-act="closeModal">取消</button></div>`;
  } else if (m.step === 'recover') {
    body = `<h2>用邮箱找回激活码</h2>
      <p class="muted" style="font-size:13px">输入购买时填的邮箱，我们会把激活码重新发给你。收到后在「输入激活码」里粘贴即可。</p>
      <form class="row" data-submit="modalRecover"><label class="sr" for="recoverEmail">邮箱</label><input class="input" id="recoverEmail" type="email" style="flex:1" placeholder="name@qq.com" value="${esc(m.email ?? S.settings?.buy_email ?? '')}" autofocus><button class="btn primary" type="submit" ${m.busy ? 'disabled' : ''}>${m.busy ? '正在发送…' : '发送'}</button></form>
      ${m.error ? `<div style="color:var(--red-ink);font-size:13px;margin-top:10px">${esc(m.error)}</div>` : ''}
      ${m.msg ? `<div style="font-size:13px;margin-top:10px">${esc(m.msg)}</div>` : ''}
      <p class="muted" style="font-size:12px;margin-top:12px">购买时没填邮箱：可以填支付宝 / 微信账单里的订单号直接恢复，或者联系客服并提供订单号。</p>
      <div class="between" style="margin-top:6px"><a href="#" data-act="modalCode" style="font-size:12.5px">输入激活码 / 订单号</a><button class="btn" data-act="closeModal">关闭</button></div>`;
  } else {
    body = `<h2>高速下载已开通</h2><p>${m.retry ? (m.kind === 'search' ? '正在重新搜索…' : '正在继续下载…') : '现在可以满速下载模型了。'}</p>
      <p class="muted" style="font-size:12.5px">激活码随时可以在「设置 → 高速下载服务」里查看和复制${m.email ? `，也已发送到 ${esc(m.email)}` : ''}。</p>`;
  }
  const wide = m.step === 'plans' || m.step === 'pay' || m.step === 'chatcfg' || m.wide;
  return `<div class="modal-bg" data-act="modalBg"><div class="modal${wide ? ' cashier' : ''}" role="dialog" aria-modal="true">${body}</div></div>`;
}

// ------------------------------------------------------------------ 对话设置：自定义系统提示词 + 模型参数
// 参数留空 = 用模型自带的默认值（llama.cpp 会读模型文件里推荐的采样参数）
const CHAT_PARAMS = [
  ['temperature', '温度 temperature', '越高越有创意、越低越严谨，常用 0.6～1.0', '0.1'],
  ['top_p', 'Top P', '只从累计概率前 P 的词里选，常用 0.8～0.95', '0.05'],
  ['top_k', 'Top K', '只从概率最高的 K 个词里选，常用 20～40', '1'],
  ['min_p', 'Min P', '过滤概率太低的词，常用 0～0.05', '0.01'],
  ['repeat_penalty', '重复惩罚', '大于 1 减少车轱辘话，常用 1.0～1.1', '0.05'],
  ['presence_penalty', '话题新鲜度 presence', '大于 0 鼓励换新话题，常用 0～1.5', '0.1'],
  ['max_tokens', '最大回复长度', '单次回复最多多少 token，留空 = 不限', '256'],
  ['seed', '随机种子', '固定后同样的问题回答一样，留空 = 随机', '1'],
];
function loadChatCfg() {
  const c = store.get('chatCfg', null) || {};
  return { system: c.system || '', params: c.params || {} };
}
function chatCfgActive() {
  const c = loadChatCfg();
  return !!(c.system.trim() || Object.keys(c.params).length);
}
function chatCfgHtml(m) {
  const c = m.cfg;
  const n = Object.keys(c.params).length;
  const fields = CHAT_PARAMS.map(([k, label, help, step]) => `<div class="field" style="margin:0"><label for="cc-${k}">${label}</label>
      <input class="input mono" id="cc-${k}" type="number" step="${step}" value="${c.params[k] ?? ''}" placeholder="默认"><div class="help" style="font-size:11.5px">${help}</div></div>`).join('');
  return `<h2>对话设置</h2>
    <div class="field"><label for="cc-system">系统提示词</label>
      <textarea class="input" id="cc-system" rows="5" style="resize:vertical;font-size:13.5px;line-height:1.7" placeholder="例如：你是一名资深的 Python 工程师，回答简洁，代码要有中文注释。&#10;或：请始终用简体中文回答。">${esc(c.system)}</textarea>
      <div class="help">每次对话都会先发给模型，用来设定角色、语气、回答格式。留空 = 不设置。</div></div>
    <details ${n ? 'open' : ''} style="margin-top:6px"><summary style="cursor:pointer;font-size:14px;font-weight:600">高级：模型参数${n ? `（已改 ${n} 项）` : ''}</summary>
      <div class="muted" style="font-size:12.5px;margin:8px 0 10px">留空 = 用模型自带的推荐值（大多数情况下最好）。改了效果不好，点「恢复默认」即可。</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px 16px">${fields}</div>
    </details>
    <div class="between" style="margin-top:18px"><button class="btn" data-act="resetChatCfg">恢复默认</button>
      <div class="row"><button class="btn" data-act="closeModal">取消</button><button class="btn primary" data-act="saveChatCfg">保存</button></div></div>`;
}

// ------------------------------------------------------------------ 发图片但当前模型不能看图
// 同一个模型别人能看图、自己不能，几乎都是这三种情况之一，按启动结果告诉用户具体原因和一键解决办法
function visionHtml(m) {
  const busy = m.busy ? 'disabled' : '';
  const err = m.error ? `<div class="pay-err">${esc(m.error)}</div>` : '';
  const pickBtn = `<button class="btn" data-act="visionPick" ${busy}>选择看图组件文件</button>`;
  const close = `<button class="btn" data-act="closeModal">关闭</button>`;
  let title, text, btns;
  if (m.reason === 'safe') {
    title = '看图组件被兼容模式关掉了';
    text = `这个模型之前在你的电脑上运行出过错，软件为了稳定自动进入了兼容模式（第 ${m.level} 级），其中一项是不加载看图组件，所以现在不能看图。<br>可以恢复看图并重启模型；如果之后又出错，软件会再次自动关掉它。`;
    btns = `${close}<button class="btn primary" data-act="visionRestore" ${busy}>${m.busy ? '正在重启…' : '恢复看图并重启模型'}</button>`;
  } else if (m.reason === 'mismatch') {
    title = '看图组件和模型不配套';
    text = '模型文件夹里的看图组件（mmproj 文件）和这个模型对不上，启动时已自动去掉，所以现在只能文字对话。' + (m.repo ? '<br>可以重新下载配套的看图组件。' : '<br>请选择和这个模型同系列、同样大小的 mmproj 文件。');
    btns = `${close}${pickBtn}${m.repo ? `<button class="btn primary" data-act="visionFetch" ${busy}>${m.busy ? '正在下载…' : '下载配套的看图组件'}</button>` : ''}`;
  } else if (m.reason === 'none') {
    title = '这个模型没带看图组件';
    text = '模型要看图，除了模型文件，同一个文件夹里还要有配套的「看图组件」（文件名带 mmproj 的 .gguf 文件）。你的模型文件夹里没有，所以只能文字对话。' +
      (m.repo ? '<br>点下面的按钮自动补下载（几百 MB 到 1 GB 多，模型本身不用重新下载）。' : '<br>这个模型是手动导入的：把配套的 mmproj 文件放到模型同一个文件夹，或者点「选择看图组件文件」。');
    btns = `${close}${pickBtn}${m.repo ? `<button class="btn primary" data-act="visionFetch" ${busy}>${m.busy ? '正在下载…' : '自动下载看图组件'}</button>` : ''}`;
  } else {
    title = '当前模型不能看图';
    text = '请换一个带「看图」标签的模型（例如 Qwen3.6、Gemma 4），或者去掉图片再发送。';
    btns = close;
  }
  const prog = m.busy && m.reason !== 'safe' ? '<div id="visionProg" style="margin-top:10px"><span class="muted" style="font-size:12.5px">正在连接…下载完会自动重启模型</span></div>' : '';
  const lead = m.why === 'computer' ? '<p class="muted" style="font-size:13px">「操作电脑」要先看屏幕截图，所以需要模型能看图。</p>' : '';
  return `<h2>${title}</h2>${lead}<p>${text}</p>${err}${prog}<div class="row" style="justify-content:flex-end;margin-top:12px;flex-wrap:wrap">${btns}</div>`;
}

function showVisionHelp(why) {
  const a = S.run.actual || {};
  S.modal = { step: 'vision', why, reason: a.vision_off || '', repo: a.model_repo || '', level: a.safe_level || 0, path: S.run.path || S.server.model_path };
  renderModal();
}

async function visionRestart() {
  S.modal = null;
  renderModal();
  S.vision = {};
  if (!S.run.path) S.run.path = S.server.model_path;
  await actions.startModel();
  if (S.server.ready) {
    go('chat');
    toast(S.run.actual?.vision ? '已可以看图，请重新发送' : '模型已重启，但仍然不能看图', 5000);
  }
}

// ------------------------------------------------------------------ 软件内收银台
// 支付方式图标（src/icons/pay-*.svg），网银和 PayPal 会打开浏览器付款，名字后面加个小箭头提示
const PAY_ICON = { alipay: 1, wxpay: 1, bank: 1, paypal: 1, usdt: 1 };
const PAY_EXTERNAL = new Set(['bank', 'paypal']);
// 按钮上用短名字（后台旧设置里可能还是「网银 / 银行卡」「USDT（TRC20）」）
const payName = (x) => ({ bank: '网银', usdt: 'USDT' })[x.id] || x.name;
const METHOD_HINT = { alipay: '支付宝扫码', wxpay: '微信扫码', bank: '网银', paypal: 'PayPal', usdt: 'USDT · TRC20' };

function plansHtml(m) {
  const head = `<h2>${m.expired ? '续费高速下载' : '开通高速下载'}</h2>
    <p class="muted" style="font-size:13px;margin-bottom:14px">畅享高速、稳定的模型下载体验，支持断点续传，主线路不可用时自动切换备用线路。</p>`;
  if (m.error && !m.plans) return `${head}<div class="pay-err">${esc(m.error)}</div><div class="row" style="justify-content:flex-end;margin-top:14px"><button class="btn" data-act="closeModal">取消</button><button class="btn primary" data-act="openBuy">重试</button></div>`;
  if (!m.plans) return `${head}<div class="pay-wait"><span class="spinner"></span>正在读取套餐…</div>`;
  const plan = m.plans.find((p) => p.id === m.plan) || m.plans[0];
  const plans = m.plans
    .map((p) => `<button type="button" class="plan ${p.id === plan.id ? 'on' : ''}" data-act="pickPlan" data-id="${esc(p.id)}" aria-pressed="${p.id === plan.id}">
        <span class="pn">${esc(p.name.replace(/^(加速通道|高速下载(服务)?)\s*·\s*/, ''))}</span><span class="pp">¥${esc(p.price)}</span>
        ${p.tip ? `<span class="pt">${esc(p.tip)}</span>` : (p.days > 0 ? `<span class="pt quiet">约 ¥${(p.price / Math.max(1, p.days / 30.4)).toFixed(1)} / 月</span>` : `<span class="pt quiet">一次购买，永久使用</span>`)}</button>`)
    .join('');
  const methods = m.methods.length
    ? m.methods.map((x) => `<button type="button" class="pm ${x.id === m.method ? 'on' : ''}" data-act="pickMethod" data-id="${esc(x.id)}" aria-pressed="${x.id === m.method}">${PAY_ICON[x.id] ? `<span class="pm-ico"><img src="icons/pay-${x.id}.svg" alt=""></span>` : ''}<span>${esc(payName(x))}</span>${PAY_EXTERNAL.has(x.id) ? '<svg class="pm-ext" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-label="在浏览器中打开"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>' : ''}</button>`).join('')
    : '<div class="muted" style="font-size:13px">暂时没有可用的支付方式，请用激活码开通</div>';
  return `${head}
    <div class="plans" role="group" aria-label="套餐">${plans}</div>
    <div class="pm-label">支付方式</div>
    <div class="pms" role="group" aria-label="支付方式">${methods}</div>
    <div class="pm-label"><label for="payEmail">接收激活码的邮箱（选填）</label></div>
    <input class="input" id="payEmail" type="email" inputmode="email" autocomplete="email" placeholder="例如 name@qq.com" value="${esc(m.email ?? S.settings?.buy_email ?? '')}" style="width:100%">
    <div class="muted" style="font-size:12px;margin-top:6px">付款成功后把激活码发到这个邮箱。更新软件、重装系统、换电脑时可以凭它恢复，不用重新购买。</div>
    ${m.error ? `<div class="pay-err">${esc(m.error)}</div>` : ''}
    <div class="between" style="margin-top:18px">
      <a href="#" data-act="modalCode" style="font-size:12.5px">已有激活码？</a>
      <div class="row"><button class="btn" data-act="closeModal">取消</button>
      <button class="btn primary" data-act="createOrder" ${m.loading || !m.method ? 'disabled' : ''}>${m.loading ? '正在下单…' : `支付 ¥${esc(plan.price)}`}</button></div>
    </div>`;
}

function payHtml(m) {
  const o = m.order;
  const back = `<div class="between" style="margin-top:16px"><a href="#" data-act="changeMethod" style="font-size:12.5px">换个支付方式</a><button class="btn" data-act="closeModal">稍后再说</button></div>`;
  const waiting = `<div class="pay-wait"><span class="pulse live"></span>${m.expired ? '订单已过期' : '付款后自动开通，不用关闭这个窗口'}</div>`;
  const price = o.currency === 'CNY' ? `¥${esc(o.money)}` : o.currency === 'USD' ? `$${esc(o.pay_amount)}<span class="muted" style="font-size:13px;font-weight:400"> ≈ ¥${esc(o.money)}</span>` : '';
  if (m.expired) {
    return `<h2>订单已过期</h2><p>请重新下单。如果你已经转账，请联系客服并提供订单号 ${esc(o.order)}。</p>
      <div class="row" style="justify-content:flex-end;margin-top:14px"><button class="btn" data-act="closeModal">关闭</button><button class="btn primary" data-act="changeMethod">重新下单</button></div>`;
  }
  if (o.kind === 'qr') {
    // 居中的收款码：顶部套餐和金额，中间带支付方式图标的二维码，一眼看出是支付宝还是微信
    const app = o.method === 'wxpay' ? '微信' : o.method === 'alipay' ? '支付宝' : o.method_name;
    const ico = PAY_ICON[o.method] ? `<img src="icons/pay-${esc(o.method)}.svg" alt="">` : '';
    return `<div class="qr-pay m-${esc(o.method)}">
        <div class="qp-plan">${esc(o.plan)}</div>
        <div class="qp-price">${price}</div>
        <div class="qp-method">${ico}<b>${esc(app)}扫码支付</b></div>
        <div class="qp-box">${m.qrSvg || ''}${ico ? `<span class="qp-logo">${ico}</span>` : ''}</div>
        <div class="qp-tip">打开<b>${esc(app)}</b>「扫一扫」付款</div>
        <div class="qp-wait"><span class="qp-spin"></span>等待付款…<span id="payLeft"></span></div>
        <div class="qp-no">订单号 ${esc(o.order)}</div>
      </div>${back}`;
  }
  if (o.kind === 'usdt') {
    return `<h2 class="row" style="gap:8px"><img src="icons/pay-usdt.svg" alt="" style="width:24px;height:24px">USDT 支付</h2>
      <div class="qr-wrap"><div class="qr">${m.qrSvg || ''}</div>
        <div class="qr-side">
          <span class="muted">请转账这个准确金额</span>
          <div class="usdt-amt"><b>${esc(o.pay_amount)}</b> USDT <button class="btn sm" data-act="copyText" data-text="${esc(o.pay_amount)}">复制</button></div>
          <span class="muted">收款地址（${esc(o.network)} 网络）</span>
          <div class="usdt-addr"><code>${esc(o.address)}</code><button class="btn sm" data-act="copyText" data-text="${esc(o.address)}">复制</button></div>
          <span class="muted" id="usdtLeft"></span>
        </div></div>
      <div class="pay-note"><b>到账金额</b>要和上面完全一致（包括小数），系统靠金额认出你的订单。从交易所提币时，手续费通常会从提币金额里扣掉（比如提 ${esc(o.pay_amount)}，实际只到账少几 USDT），请把手续费加在提币金额上，保证到账正好是这个数。只支持 TRC20 网络，转错网络无法找回。到账后一般 1–3 分钟自动开通。</div>
      ${waiting}${back}`;
  }
  return `<h2>${esc(o.method_name)} ${price}</h2>
    <p>已在你的浏览器里打开 ${esc(o.method_name)} 付款页面，在浏览器里登录并完成付款即可。付款成功后回到这里，会自动开通。</p>
    <p class="muted" style="font-size:13px">${esc(o.plan)} · 订单号 ${esc(o.order)}</p>
    ${waiting}
    <div class="row" style="margin-top:10px"><button class="btn sm" data-act="reopenPay">浏览器没打开？再打开一次</button><button class="btn sm" data-act="copyText" data-text="${esc(o.url || '')}">复制付款链接</button></div>${back}`;
}

async function loadPlans() {
  const m = S.modal;
  try {
    const r = await invoke('accel_plans');
    m.plans = r.plans || [];
    m.methods = r.methods || [];
    m.plan = m.plan || (m.plans[0] && m.plans[0].id);
    m.method = m.method || (m.methods[0] && m.methods[0].id);
    m.error = '';
  } catch (e) {
    m.error = String(e);
  }
  if (S.modal === m) renderModal();
}

let usdtTimer = null;
function startPayPoll() {
  stopPoll();
  const m = S.modal;
  const t0 = Date.now();
  const order = m.order.order;
  let polling = false;
  pollTimer = setInterval(async () => {
    if (S.modal !== m || Date.now() - t0 > 30 * 60 * 1000) return stopPoll();
    if (polling) return;
    polling = true;
    try {
      const r = await invoke('accel_order', { order });
      if (S.modal !== m || m.step !== 'pay' || m.order.order !== order) return;
      if (r.status === 'paid' && r.accel?.member) await accelDone(r.accel);
      else if (r.status === 'expired') {
        m.expired = true;
        stopPoll();
        renderModal();
      }
    } catch {} finally { polling = false; }
  }, 2500);
  if (m.order.expires_at && (m.order.kind === 'usdt' || m.order.kind === 'qr')) {
    const tick = () => {
      const left = m.order.expires_at - Math.floor(Date.now() / 1000);
      const mmss = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
      const el = document.getElementById('usdtLeft');
      if (el) el.textContent = left > 0 ? `请在 ${Math.floor(left / 60)} 分 ${String(left % 60).padStart(2, '0')} 秒内转账` : '订单已过期';
      const el2 = document.getElementById('payLeft');
      if (el2) el2.textContent = left > 0 ? ` · ${mmss} 内有效` : ' · 已过期';
    };
    tick();
    usdtTimer = setInterval(tick, 1000);
  }
}

// 开通高速下载服务后重新执行搜索
async function searchAgain(q) {
  S.search = { ...S.search, q, loading: true, hits: null, repo: null, needAccel: false, note: '' };
  render();
  try {
    S.search.hits = await call('search_hf', { query: q });
  } catch {
    S.search.hits = [];
  }
  S.search.loading = false;
  render();
}

let pollTimer = null;
function stopPoll() {
  clearInterval(pollTimer);
  pollTimer = null;
  clearInterval(usdtTimer);
  usdtTimer = null;
}
function openModal(opts) {
  S.modal = { step: 'ask', ...opts };
  renderModal();
}
function closeModal() {
  stopPoll();
  if (S.modal?.step === 'pay') invoke('close_pay_window').catch(() => {});
  S.modal = null;
  renderModal();
}
function renderModal() {
  let host = document.getElementById('modal-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'modal-host';
    document.body.appendChild(host);
  }
  host.innerHTML = modalHtml();
  host.querySelector('input')?.focus();
}
async function accelDone(status) {
  if (!status?.member) throw new Error('账号中心尚未确认开通');
  const modal = S.modal;
  stopPoll();
  S.accel = status;
  S.settings = await invoke('get_settings');
  if (S.modal !== modal) return;
  const retry = modal?.retry;
  if (modal) {
    S.modal.step = 'done';
    renderModal();
  }
  render();
  setTimeout(() => {
    if (S.modal !== modal) return;
    closeModal();
    if (retry) retry();
  }, 2500);
}
// ------------------------------------------------------------------ 渲染
function renderSide() {
  ['overview', 'models', 'run', 'chat', 'agent', 'image', 'video', 'settings'].forEach((p) => {
    const b = document.getElementById(`nav-${p}`);
    b.classList.toggle('on', S.page === p);
    if (S.page === p) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  $('#run-dot').classList.toggle('hidden', !S.server.running && !S.run.starting);
  $('#run-dot').classList.toggle('busy', S.run.starting || (S.server.running && !S.server.ready));
}

function render() {
  renderSide();
  const main = $('#main');
  // 重绘前记下各个折叠框（运行日志、启动参数等）现在是展开还是收起，重绘后保持不变
  document.querySelectorAll('#main details[data-open]').forEach((d) => (S.run[d.dataset.open] = d.open));
  const html = { overview: pageOverview, models: pageModels, run: pageRun, chat: pageChat, agent: () => pageAgent(), image: () => pageImage(), video: () => pageImage(), monitor: () => pageMonitor(), settings: pageSettings }[S.page]();
  // 对话页保持滚动位置
  const box = $('#msgs');
  const keep = (S.page === 'chat' || S.page === 'agent') && box ? box.scrollTop : null;
  // 重绘时保留输入框里没发出去的文字
  const draftEl = $('#msgInput');
  const draft = draftEl ? draftEl.value : null;
  const hadFocus = draftEl && document.activeElement === draftEl;
  // 日志框保持滚动位置（在最底部时继续跟着最新日志）
  const lg = $('#logs');
  const logPos = lg ? (lg.scrollTop + lg.clientHeight >= lg.scrollHeight - 8 ? 'end' : lg.scrollTop) : 'end';
  main.innerHTML = html;
  if ((S.page === 'image' || S.page === 'video' || S.page === 'chat') && typeof fillThumbs === 'function') fillThumbs();
  const lg2 = $('#logs');
  if (lg2) lg2.scrollTop = logPos === 'end' ? lg2.scrollHeight : logPos;
  if (draft && $('#msgInput')) {
    $('#msgInput').value = draft;
    if (hadFocus) $('#msgInput').focus();
  }
  main.style.overflowY = S.page === 'chat' || S.page === 'agent' ? 'hidden' : 'auto';
  if (keep !== null && $('#msgs')) $('#msgs').scrollTop = keep;
  const logs = $('#logs');
  if (logs) logs.scrollTop = logs.scrollHeight;
}

function go(page) {
  S.page = page;
  render();
  // 打开设置页时自动测一次各下载服务器的延迟
  if (page === 'settings' && !S.serverPings && !S.lineTesting && (S.accel?.nodes || []).length) runPingTest();
  if (page === 'models') {
    if (!S.catalog) loadCatalog();
    if (!S.local) loadLocal();
    if (S.modelsTab === 'image') loadImageData();
  }
  if (page === 'image' || page === 'video') loadImageData();
  if (page === 'run') {
    if (!S.local) loadLocal().then(() => refreshPlan());
    else refreshPlan();
  }
  if (page === 'chat') {
    const box = $('#msgs');
    if (box) box.scrollTop = box.scrollHeight;
  }
}

// ------------------------------------------------------------------ 数据
async function loadOverview(refresh = false) {
  S.overview = await call('get_overview', { refresh });
  S.engine = S.overview.engine;
  if (S.page === 'overview') render();
}
async function loadCatalog() {
  S.catalog = await call('get_catalog');
  if (S.page === 'models') render();
}
async function loadLocal() {
  S.localError = '';
  // 对话模型目录里的画图 / 视频模型文件（在「搜索 HuggingFace」里下的）自动移到画图模型里，新手不用管
  try {
    const moved = await invoke('auto_adopt_image_models');
    if (moved?.length) {
      // 静默处理，不弹提示
      if (S.img) S.img.catalog = null;
      if (typeof loadImageData === 'function') loadImageData(true);
    }
  } catch {}
  try {
    S.local = await call('list_local');
  } catch (e) {
    S.local = [];
    S.localError = String(e).split('\n')[0];
  }
  if (S.page === 'models' || S.page === 'run') render();
}
async function refreshPlan() {
  const r = S.run;
  if (!r.path) {
    render();
    return;
  }
  try {
    r.plan = await call('plan_model', { path: r.path, ctx: r.ctx || null });
  } catch {
    r.plan = null;
  }
  if (S.page === 'run') render();
}
async function refreshAfterDownload() {
  await Promise.all([loadLocal(), loadCatalog(), loadOverview(false)]);
  render();
}

// ------------------------------------------------------------------ 动作
const actions = {
  go: (d, el, ev) => {
    ev?.preventDefault?.();
    if (d.tab) S.modelsTab = d.tab;
    go(d.page);
  },
  redetect: async () => {
    S.overview = null;
    render();
    await loadOverview(true);
    S.catalog = null;
    S.local = null;
  },
  tab: (d) => {
    S.modelsTab = d.t;
    render();
    if (d.t === 'local') loadLocal();
    if (d.t === 'image') loadImageData();
  },
  filter: (d) => {
    S.filter = d.f;
    render();
  },
  download: async (d) => {
    const id = `${d.repo}:${d.quant}`;
    S.downloads[id] = { id, status: 'downloading', done: 0, total: 0, speed: 0, file_index: 0, file_count: 1, message: '' };
    S.dlArgs[id] = d;
    S.dlRestart[id] = () => actions.download(d);
    delete S.stall[id];
    delete S.dlBase[id];
    render();
    try {
      const job = call('download_model', { repo: d.repo, quant: d.quant, vision: d.vision === '1' });
      S.dlJobs[id] = job;
      await job;
      toast('下载完成');
      delete S.downloads[id];
      await refreshAfterDownload();
    } catch (e) {
      const msg = String(e);
      delete S.downloads[id];
      const retry = () => actions.download(d);
      if (msg.startsWith('NEED_ACCEL|')) needAccelModal({ retry });
      else if (msg.startsWith('MEMBER_EXPIRED|')) openModal({ retry, expired: true, reason: msg.split('|')[1] });
      else S.downloads[id] = { id, status: 'error', message: msg, done: 0, total: 0, speed: 0, file_index: 0, file_count: 0 };
      render();
    }
  },
  downloadSel: (d) => {
    const sel = document.getElementById(d.sel);
    actions.download({ repo: d.repo, quant: sel.value, vision: d.vision });
  },
  cancelDl: (d) => call('cancel_download', { id: d.id }),
  goRun: (d) => {
    S.run.path = d.path;
    S.run.error = '';
    go('run');
  },
  importGguf: async () => {
    if (S.importing) return;
    const path = await call('pick_gguf');
    if (!path) return;
    S.importing = path.split(/[\\/]/).pop();
    S.page = 'models';
    S.modelsTab = 'local';
    render();
    try {
      const m = await call('import_path', { path });
      S.justImported = m.path;
      S.importing = null;
      S.local = null;
      render();
      await loadLocal();
      toast(`已导入：${m.name}`);
      $('#justImported')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } catch {
      S.importing = null;
      render();
    }
  },
  reloadLocal: () => {
    S.local = null;
    render();
    loadLocal().catch(() => {});
  },
  removeLocal: async (d) => {
    const imported = d.imported === '1';
    if (!confirm(imported ? '从列表移除这个模型？（不会删除文件）' : '删除这个模型文件？删除后需要重新下载。')) return;
    await call('remove_local', { path: d.path, deleteFiles: !imported });
    await refreshAfterDownload();
  },
  openFolder: (d) => call('open_path', { path: d.path.replace(/[\\/][^\\/]+$/, '') }),
  openRepo: async (d) => {
    S.search.repo = d.repo;
    S.search.quants = null;
    S.search.qLoading = true;
    render();
    try {
      S.search.quants = await call('repo_quants', { repo: d.repo });
    } catch (e) {
      S.search.quants = [];
      if (String(e).startsWith('NEED_ACCEL|')) openModal({ kind: 'search', retry: () => actions.openRepo(d) });
    }
    S.search.qLoading = false;
    render();
  },
  searchAccel: () => openModal({ kind: 'search', retry: () => searchAgain(S.search.q) }),
  searchBack: () => {
    S.search.repo = null;
    render();
  },
  installEngine: async (d = {}) => {
    S.downloads.engine = { id: 'engine', status: 'downloading', done: 0, total: 0, speed: 0, file_index: 0, file_count: 1, message: '' };
    render();
    const before = S.engine?.tag;
    const beforeV = S.engine?.variant;
    try {
      S.engine = await call('install_engine', { force: !!d.force });
      delete S.downloads.engine;
      S.engCheck = null;
      runEngineCheck();
      const g = primaryGpu();
      toast(
        before && before === S.engine?.tag && beforeV === S.engine?.variant
          ? `已经是最新版本（${S.engine.tag}），不用更新`
          : S.engine?.variant === 'vulkan' && g && isBlackwell(g.name)
            ? '已安装 Vulkan 版推理引擎。显卡驱动更新到 580 以上后，再点「更新到最新版」可以换成更快的 CUDA 版'
            : `推理引擎已安装：${S.engine?.tag || ''} · ${S.engine?.variant || ''}`,
        6000,
      );
      await loadOverview(false);
    } catch {}
    render();
  },
  importEngine: async () => {
    const e = await call('import_engine_zip');
    if (e) {
      S.engine = e;
      toast('引擎导入完成');
      await loadOverview(false);
      render();
    }
  },
  importEngineDir: async () => {
    const e = await call('import_engine_dir');
    if (e) {
      S.engine = e;
      toast(`已改用 ${e.server_path.replace(/\\[^\\]+$/, '')} 里的引擎（${e.tag}）`);
      await loadOverview(false);
      render();
    }
  },
  ctx: (d) => {
    S.run.ctx = +d.v;
    refreshPlan();
  },
  toggleThinking: () => {
    S.thinking = !S.thinking;
    store.set('thinking', S.thinking);
    render();
  },
  pickGpu: async (d) => {
    const s = S.settings;
    const gpus = (S.engCheck?.gpus || []).map((g) => g.id);
    let sel = (s.gpu_devices || []).filter((x) => gpus.includes(x));
    if (!d.id) sel = [];
    else if (sel.includes(d.id)) sel = sel.filter((x) => x !== d.id);
    else sel = [...sel, d.id];
    if (sel.length === gpus.length) sel = []; // 全选等于「全部」
    s.gpu_devices = sel;
    await call('save_settings', { settings: s });
    if (S.server.running) S.run.gpuDirty = true;
    render();
  },
  toggleAutostart: async () => {
    try {
      S.autostart = await invoke('set_autostart', { on: !S.autostart });
      toast(S.autostart ? '已开启开机自动启动' : '已关闭开机自动启动');
    } catch (e) {
      toast(String(e), 5000);
    }
    render();
  },
  toggleEngineCpu: async () => {
    S.settings.engine_cpu = !S.settings.engine_cpu;
    await call('save_settings', { settings: S.settings });
    render();
    if (S.engine) {
      toast(S.settings.engine_cpu ? '正在换成 CPU 版引擎…' : '正在换回显卡加速版引擎…', 5000);
      actions.installEngine({ force: '1' });
    }
  },
  // 引擎一启动就退出（老显卡驱动）：换成 CPU 版引擎再启动
  useCpuEngine: async () => {
    S.settings.engine_cpu = true;
    await call('save_settings', { settings: S.settings });
    S.run.error = '';
    toast('正在换成 CPU 版引擎，装好后点「启动模型」即可', 6000);
    render();
    actions.installEngine({ force: '1' });
  },
  // 把自动生成的启动参数全部填进输入框，直接改数字
  fillArgs: () => {
    const r = S.run;
    r.argsDraft = r.plan.editable_args ?? editableArgs(r.plan.command);
    render();
    $('#customArgs')?.focus();
  },
  // 推理加速、崩溃自动重启
  setPerf: async (d) => {
    const s = S.settings;
    if (d.k === 'fa') s.perf_fa = s.perf_fa === 'off' ? 'on' : 'off';
    if (d.k === 'kv') s.perf_kv = d.v;
    if (d.k === 'restart') s.auto_restart = s.auto_restart === false;
    await call('save_settings', { settings: s });
    if (d.k !== 'restart' && S.server.running) S.run.perfDirty = true;
    render();
  },
  toggleLan: async () => {
    S.settings.lan_access = !S.settings.lan_access;
    await call('save_settings', { settings: S.settings });
    if (S.server.running) toast('重新启动模型后生效');
    refreshPlan();
  },
  dismissCrash: () => {
    S.crash = null;
    render();
  },
  restartModel: async () => {
    S.crash = null;
    S.run.perfDirty = false;
    S.run.gpuDirty = false;
    if (!S.run.path) S.run.path = S.server.model_path || S.local?.[0]?.path;
    go('run');
    await actions.startModel();
    if (S.server.ready) go('chat');
  },
  toggleFullscreen: () => toggleFullscreen(),
  toggleSide: () => {
    const app = $('#app');
    const c = app.classList.toggle('collapsed');
    store.set('sideCollapsed', c);
    const t = $('#sideToggle');
    t.title = c ? '展开侧边栏' : '收起侧边栏';
    t.setAttribute('aria-label', t.title);
    t.setAttribute('aria-expanded', String(!c));
  },
  adoptImageModel: async (d) => {
    const r = S.run;
    r.adopting = true;
    r.adoptError = '';
    const id = d.pick ? $('#adoptFam')?.value : null;
    render();
    try {
      const m = await invoke('adopt_image_model', { path: d.path, id });
      r.adoptUnknown = false;
      r.path = null;
      r.plan = null;
      r.error = '';
      S.local = null;
      await loadLocal();
      if (typeof loadImageData === 'function') await loadImageData(true);
      S.modelsTab = 'image';
      if (S.img) S.img.sel[m.id] = m.quant; // 模型页直接选中刚移过去的这个版本
      toast(`已移到${m.kind === 'video' ? '视频' : '画图'}模型：${m.name} ${typeof qName === 'function' ? qName(m.quant) : m.quant}。缺的配套文件点「下载」补齐`, 6000);
      go('models');
    } catch (e) {
      const msg = String(e);
      if (msg.startsWith('UNKNOWN_FAMILY|')) {
        r.adoptUnknown = true;
        if (typeof loadImageData === 'function') await loadImageData();
      } else r.adoptError = msg;
    }
    r.adopting = false;
    render();
  },
  startModel: async (opts = {}) => {
    const r = S.run;
    const safe = typeof opts.safe === 'number' ? opts.safe : null;
    r.starting = true;
    r.error = '';
    r.load = null;
    r.note = '';
    r.actual = null;
    S.vision = {};
    S.logs = [];
    render();
    try {
      r.actual = await call('start_model', { path: r.path, ctx: r.ctx || null, safe });
      toast('模型已就绪，可以开始对话了');
    } catch (e) {
      r.error = typeof e === 'string' ? e : String(e);
    }
    r.starting = false;
    S.server = await invoke('server_status');
    render();
  },
  stopModel: async () => {
    await call('stop_model');
    S.server = await invoke('server_status');
    render();
  },
  copyApi: () => {
    navigator.clipboard.writeText(`http://127.0.0.1:${S.server.port}/v1`);
    toast('已复制 API 地址（OpenAI 兼容）');
  },
  newChat: () => {
    newChat();
    render();
    $('#msgInput')?.focus();
  },
  openChat: (d) => {
    S.chatId = d.id;
    S.previews.clear();
    render();
    const box = $('#msgs');
    if (box) box.scrollTop = box.scrollHeight;
  },
  delChat: (d, el, ev) => {
    ev.stopPropagation();
    S.chats = S.chats.filter((c) => c.id !== d.id);
    if (S.chatId === d.id) S.chatId = null;
    saveChats();
    render();
  },
  copyCode: (d, el) => {
    const c = codeOf(+d.mi, +d.ci);
    if (!c) return;
    navigator.clipboard.writeText(c.text);
    el.textContent = '已复制';
    setTimeout(() => (el.textContent = '复制'), 1200);
  },
  saveCode: async (d) => {
    const c = codeOf(+d.mi, +d.ci);
    if (!c) return;
    const ext = EXT[c.lang] || 'txt';
    const name = ext === 'Dockerfile' ? 'Dockerfile' : `code-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}.${ext}`;
    const p = await call('save_text_file', { fileName: name, content: c.text });
    if (p) toast(`已保存到 ${p}`);
  },
  previewCode: (d) => {
    const key = `${d.mi}:${d.ci}`;
    if (S.previews.has(key)) S.previews.delete(key);
    else S.previews.add(key);
    const msg = curThread().messages[+d.mi];
    const el = document.getElementById(`msg-${d.mi}`);
    if (el) el.innerHTML = renderAiMessage(msg, +d.mi);
  },
  rerunPreview: (d) => {
    const f = document.querySelector(`iframe[data-key="${d.key}"]`);
    if (f) f.srcdoc = f.srcdoc;
  },
  fullPreview: (d) => {
    const c = codeOf(+d.mi, +d.ci);
    if (!c) return;
    const wrap = document.createElement('div');
    wrap.className = 'fullscreen';
    wrap.innerHTML = `<div class="box"><div class="code-bar" style="background:var(--clay-soft)"><span style="font-size:12px;color:var(--clay-ink);font-weight:600">全屏预览 · 按 Esc 关闭</span><button class="btn sm" data-act="closeFull">关闭</button></div><iframe sandbox="allow-scripts allow-modals allow-forms allow-pointer-lock"></iframe></div>`;
    wrap.querySelector('iframe').srcdoc = previewDoc(c);
    document.body.appendChild(wrap);
  },
  closeFull: () => document.querySelector('.fullscreen')?.remove(),
  closeModal: () => closeModal(),
  saveArgs: async () => {
    const r = S.run;
    try {
      const dropped = await call('set_custom_args', { path: r.path, args: r.argsDraft || '' });
      toast(dropped.length ? `已保存（${dropped.join(' ')} 由软件管理，已忽略）` : S.server.running && S.server.model_path === r.path ? '已保存，重新启动模型后生效' : '已保存，启动模型时生效', 5000);
      r.argsOpen = true;
      await refreshPlan();
    } catch {}
  },
  clearArgs: async () => {
    const r = S.run;
    r.argsDraft = '';
    await call('set_custom_args', { path: r.path, args: '' });
    toast('已恢复自动参数');
    await refreshPlan();
  },
  openChatCfg: () => {
    const c = loadChatCfg();
    S.modal = { step: 'chatcfg', cfg: { ...c, params: { ...c.params } } };
    renderModal();
  },
  saveChatCfg: () => {
    const m = S.modal;
    const host = document.getElementById('modal-host');
    const cfg = { system: host.querySelector('#cc-system').value, params: {} };
    for (const [k] of CHAT_PARAMS) {
      const v = host.querySelector(`#cc-${k}`).value.trim();
      if (v !== '' && !isNaN(+v)) cfg.params[k] = +v;
    }
    store.set('chatCfg', cfg);
    closeModal();
    render();
    toast('已保存，下一条消息开始生效');
  },
  resetChatCfg: () => {
    store.set('chatCfg', { system: '', params: {} });
    closeModal();
    render();
    toast('已恢复默认');
  },
  visionRestore: async () => {
    const m = S.modal;
    m.busy = true;
    m.error = '';
    renderModal();
    try {
      await call('restore_vision', { path: m.path });
      await visionRestart();
    } catch (e) {
      m.busy = false;
      m.error = String(e);
      renderModal();
    }
  },
  visionFetch: async () => {
    const m = S.modal;
    m.busy = true;
    m.error = '';
    renderModal();
    try {
      await call('fetch_mmproj', { path: m.path });
      S.local = null;
      await visionRestart();
    } catch (e) {
      const msg = typeof e === 'string' ? e : String(e);
      if (msg.startsWith('NEED_ACCEL') || msg.startsWith('MEMBER_EXPIRED')) {
        const back = { ...m, busy: false, error: '' };
        openModal({ expired: msg.startsWith('MEMBER_EXPIRED'), reason: msg.split('|')[1], retry: () => { S.modal = back; actions.visionFetch(); } });
        return;
      }
      m.busy = false;
      m.error = msg.replace(/^NO_MMPROJ\|/, '');
      renderModal();
    }
  },
  visionPick: async () => {
    const m = S.modal;
    m.error = '';
    try {
      const got = await call('pick_mmproj_file', { path: m.path });
      if (!got) return;
      m.busy = true;
      renderModal();
      S.local = null;
      await visionRestart();
    } catch (e) {
      m.busy = false;
      m.error = String(e);
      renderModal();
    }
  },
  modalBg: (d, el, ev) => {
    if (ev.target === el && S.modal?.step !== 'pay') closeModal();
  },
  // 打开软件内收银台（弹窗里的「开通高速下载」、设置页的「续费 / 了解」）
  openBuy: () => {
    stopPoll();
    S.modal = { ...(S.modal || {}), step: 'plans', plans: null, methods: null, error: '', loading: false, expired: S.modal?.expired };
    renderModal();
    loadPlans();
  },
  pickPlan: (d) => {
    S.modal.plan = d.id;
    renderModal();
  },
  pickMethod: (d) => {
    S.modal.method = d.id;
    renderModal();
  },
  createOrder: async () => {
    const m = S.modal;
    if (!m || m.step !== 'plans' || m.loading || !m.plan || !m.method) return;
    m.email = ($('#payEmail')?.value || '').trim();
    if (m.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(m.email)) {
      m.error = '邮箱格式不正确（可以不填）';
      renderModal();
      return;
    }
    m.loading = true;
    m.error = '';
    renderModal();
    try {
      const o = await invoke('accel_create', { plan: m.plan, method: m.method, email: m.email });
      if (S.modal !== m) return;
      m.order = o;
      m.qrSvg = o.qr ? await invoke('make_qr', { text: o.qr }) : '';
      if (S.modal !== m) return;
      m.step = 'pay';
      m.expired = false;
      // 网银、PayPal 这类要登录账户的支付方式：用系统浏览器打开（用户的浏览器里一般保存着账号密码），软件这边继续等待到账
      renderModal();
      startPayPoll();
      if (o.kind === 'web') await invoke('open_url', { url: o.url }).catch(e => toast(String(e)));
    } catch (e) {
      m.error = String(e);
      renderModal();
    }
    m.loading = false;
    if (m.step === 'plans') renderModal();
  },
  changeMethod: () => {
    stopPoll();
    invoke('close_pay_window').catch(() => {});
    S.modal.step = 'plans';
    S.modal.expired = false;
    S.modal.order = null;
    renderModal();
  },
  reopenPay: () => S.modal?.order?.url && invoke('open_url', { url: S.modal.order.url }),
  copyText: (d) => {
    navigator.clipboard.writeText(d.text);
    toast('已复制');
  },
  modalRecover: () => {
    S.modal = { ...(S.modal || {}), step: 'recover', error: '', msg: '', busy: false };
    renderModal();
  },
  modalCode: () => {
    S.modal = { ...(S.modal || {}), step: 'code', error: '' };
    renderModal();
  },
  activateFromSettings: async () => {
    const code = $('#st-code').value.trim();
    if (!code) return;
    try {
      S.accel = await invoke('activate_code', { code });
      S.settings = await invoke('get_settings');
      toast('高速下载已开通');
      render();
    } catch (e) {
      toast(String(e), 4000);
    }
  },
  copyToken: () => {
    navigator.clipboard.writeText(S.accel.token);
    toast('令牌已复制，在新电脑的「设置 → 高速下载」里输入即可');
  },
  testLines: () => runPingTest(),
  useServer: async (d) => {
    // 手动选节点是会员功能：免费用户（国内外都一样）直接弹出开通界面
    if (!S.accel?.member) {
      toast('手动选择下载服务器需要开通高速下载服务');
      return actions.openBuy();
    }
    S.accel = await call('set_preferred_line', { url: d.url, ip: d.ip });
    refreshNodes();
    toast('已切换，之后的下载走这台服务器');
  },
  autoServer: async () => {
    S.accel = await call('set_preferred_line', { url: '', ip: '' });
    refreshNodes();
  },
  extLink: (d, el, ev) => {
    ev.preventDefault();
    call('open_url', { url: d.url });
  },
  pickImgDir: async () => {
    const p = await call('pick_folder');
    if (p) $('#st-imgdir').value = p;
  },
  pickDir: async () => {
    const p = await call('pick_folder');
    if (p) $('#st-dir').value = p;
  },
  openAppDir: () => call('open_path', { path: S.engine ? S.engine.server_path.replace(/[\\/]engines[\\/].*$/, '') : S.settings.models_dir }),
  redetectGpu: async () => {
    toast('正在重新检测硬件…');
    await loadOverview(true);
    S.catalog = null;
    render();
    const g = primaryGpu(S.overview.hardware);
    toast(g ? `检测到 ${g.name}（${fmtSize(g.vram_bytes)}）` : '还是没检测到独立显卡，可以在下面手动指定');
  },
  saveSettings: async () => {
    const s = { ...S.settings };
    s.models_dir = $('#st-dir').value.trim();
    s.custom_mirror = $('#st-mirror').value.trim();
    s.accel_lines = $('#st-lines').value.split(/\s+/).map((x) => x.trim()).filter(Boolean);
    s.account_base = $('#st-account').value.trim();
    s.hf_token = $('#st-hf').value.trim();
    s.github_mirror = $('#st-gh').value.trim();
    s.port = Math.max(1024, Math.min(65535, parseInt($('#st-port').value, 10) || 8686));
    s.images_dir = ($('#st-imgdir')?.value || '').trim();
    const gm = parseFloat($('#st-gm')?.value || '0') || 0;
    s.gpu_override = gm > 0 ? { vendor: $('#st-gv').value, name: $('#st-gn').value.trim(), vram_gb: gm } : null;
    const accountChanged = s.account_base !== S.settings.account_base;
    S.settings = await call('save_settings', { settings: s });
    if (accountChanged) {
      S.accel = await invoke('accel_status');
      S.newVer = S.update = null;
      const updateButton = document.getElementById('updSide');
      if (updateButton) updateButton.hidden = true;
      refreshMembership();
      loadClientConfig();
    }
    // 指定的作品文件夹写不进去时，软件会自动改用能写的位置，告诉用户实际存在哪
    let warn = '';
    try {
      S.imagesDirPath = await invoke('images_dir_path');
      const want = s.images_dir.replace(/[\\/]+$/, '');
      if (want && S.imagesDirPath.replace(/[\\/]+$/, '') !== want) warn = `作品文件夹「${want}」无法写入，暂时保存到：${S.imagesDirPath}`;
    } catch {}
    S.catalog = null;
    S.local = null;
    toast(warn || '设置已保存', warn ? 6000 : 2600);
    loadOverview(false);
    render();
  },
};

const changeHandlers = {
  quantSize: (el) => {
    const id = el.id.replace(/^q-/, '');
    const sizes = JSON.parse(el.dataset.sizes || '{}');
    const q = el.value;
    const bytes = sizes[q] ? sizes[q] * GB : (parseFloat(el.dataset.params) * 1e9 * (BPW[q] || 4.85)) / 8;
    const sz = document.getElementById(`sz-${id}`);
    if (sz) sz.textContent = fmtGB(bytes);
  },
  runSel: (el) => {
    S.run.path = el.value;
    S.run.error = '';
    refreshPlan();
  },
};

document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-act]');
  if (!el) return;
  const fn = actions[el.dataset.act];
  if (!fn) return;
  if (el.tagName === 'A') ev.preventDefault();
  fn(el.dataset, el, ev);
});
// 输入框草稿：页面重新渲染时不丢（例如运行页的自定义启动参数）
document.addEventListener('input', (ev) => {
  const el = ev.target.closest?.('[data-input]');
  if (!el) return;
  S.run[el.dataset.input] = el.value;
  if (el.dataset.input === 'argsDraft') {
    const btn = document.querySelector('[data-act="saveArgs"]');
    if (btn) btn.disabled = (el.value || '').trim() === (S.run.plan?.custom_args || '').trim();
  }
});
document.addEventListener('toggle', (ev) => {
  const el = ev.target;
  if (el.dataset?.open) {
    S.run[el.dataset.open] = el.open;
    const lg = el.open && el.querySelector('#logs');
    if (lg) lg.scrollTop = lg.scrollHeight;
  }
}, true);
document.addEventListener('change', (ev) => {
  const el = ev.target.closest('[data-change]');
  if (el) changeHandlers[el.dataset.change]?.(el);
});
document.addEventListener('submit', async (ev) => {
  const f = ev.target.closest('[data-submit]');
  if (!f) return;
  ev.preventDefault();
  if (f.dataset.submit === 'send') sendMessage();
  if (f.dataset.submit === 'modalActivate') {
    const code = $('#modalCode').value.trim();
    if (!code) return;
    try {
      const st = await invoke('activate_code', { code });
      accelDone(st);
    } catch (e) {
      S.modal.error = String(e);
      renderModal();
    }
  }
  if (f.dataset.submit === 'modalRecover') {
    const m = S.modal;
    m.email = $('#recoverEmail').value.trim();
    if (!m.email) return;
    m.busy = true;
    m.error = m.msg = '';
    renderModal();
    try {
      m.msg = await invoke('accel_recover', { email: m.email });
    } catch (e) {
      m.error = String(e);
    }
    m.busy = false;
    renderModal();
  }
  if (f.dataset.submit === 'search') {
    const q = $('#sq').value.trim();
    if (!q) return;
    S.search = { ...S.search, q, loading: true, hits: null, repo: null, needAccel: false, note: '' };
    render();
    try {
      S.search.hits = await call('search_hf', { query: q });
    } catch (e) {
      S.search.hits = [];
      // 粘贴的模型还没有 GGUF 版本：在结果区说明原因
      if (String(e).startsWith('NO_GGUF|')) S.search.note = String(e).slice(8);
      // 连不上 HuggingFace：提示开通高速下载，开通后自动重新搜索
      if (String(e).startsWith('NEED_ACCEL|')) {
        S.search.needAccel = true;
        openModal({ kind: 'search', retry: () => searchAgain(q) });
      }
    }
    S.search.loading = false;
    render();
  }
});
// 真正的全屏（盖住任务栏）：F11 切换；Esc 在没有弹窗、没有代码预览时退出全屏
async function toggleFullscreen(force) {
  try {
    const w = window.__TAURI__.window.getCurrentWindow();
    const now = await w.isFullscreen();
    const next = typeof force === 'boolean' ? force : !now;
    if (next !== now) await w.setFullscreen(next);
    S.fullscreen = next;
    const b = $('#fsToggle');
    if (b) {
      b.title = next ? '退出全屏（F11）' : '全屏（F11）';
      b.setAttribute('aria-label', b.title);
      b.classList.toggle('on', next);
      const l = b.querySelector('.lbl');
      if (l) l.textContent = next ? '退出全屏' : '全屏';
    }
    if (next) toast('已全屏，按 F11 或 Esc 退出');
  } catch (e) {
    toast('无法切换全屏：' + e);
  }
}

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'F11') {
    ev.preventDefault();
    toggleFullscreen();
    return;
  }
  if (ev.key === 'Escape') {
    const hadOverlay = !!document.querySelector('.fullscreen') || (S.modal && S.modal.step !== 'pay');
    actions.closeFull();
    if (S.modal && S.modal.step !== 'pay') closeModal();
    if (!hadOverlay && S.fullscreen) toggleFullscreen(false);
  }
  if (ev.target.id === 'msgInput' && ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
    ev.preventDefault();
    sendMessage();
  }
  if (ev.key === 'Enter' && (ev.target.classList?.contains('ci') || ev.target.classList?.contains('aimg'))) ev.target.click();
});

// ------------------------------------------------------------------ 事件
// ------------------------------------------------------------------ 下载慢时推荐高速下载服务
// 不管国内还是海外：没开高速下载服务、直连下载持续很慢、剩余时间还很长时，弹一次窗推荐开通；
// 开通后自动停掉直连、改走高速线路接着下（已下载的部分保留）
// 下面是默认值；软件启动时会从后台取最新的规则覆盖（后台「设置 → 下载慢时推荐高速下载服务」）
const SLOW = {
  // warmup：收到数据后多久判断；window：按最近几秒的平均速度算
  enabled: true, warmup: 3, window: 3, speed: 3 * 1024 * 1024, remainMin: 15, quietHours: 12,
  title: '下载速度较慢',
  text: '当前下载速度约 {speed}，预计还要 {time}。是否使用高速下载服务？',
  sub: '高速下载服务使用专用服务器多线程下载，速度更快。已下载的部分会保留，开通后自动接着下载。',
};
function applySlowConfig(c) {
  if (!c) return;
  if (typeof c.enabled === 'boolean') SLOW.enabled = c.enabled;
  if (c.speed_kb > 0) SLOW.speed = c.speed_kb * 1024;
  if (c.remain_min >= 0) SLOW.remainMin = c.remain_min;
  if (c.warmup_s >= 2) SLOW.warmup = c.warmup_s;
  if (c.quiet_hours >= 0) SLOW.quietHours = c.quiet_hours;
  for (const k of ['title', 'text', 'sub']) if (typeof c[k] === 'string' && c[k].trim()) SLOW[k] = c[k];
}
try { applySlowConfig(JSON.parse(localStorage.getItem('slowConfig') || 'null')); } catch {}
function refreshMembership() {
  const initialAccount = S.accel;
  invoke('refresh_membership').then(st => {
    // A more recent payment or activation can complete while the startup request is pending.
    if (S.accel.device_id !== initialAccount.device_id || S.accel.token !== initialAccount.token || S.accel.expires !== initialAccount.expires) return;
    S.accel = { ...S.accel, member: st.member, token: st.token, expires: st.expires };
    render();
    if (st.member && !initialAccount.member) toast('已恢复你购买的高速下载服务');
  }).catch(() => {});
}
async function loadClientConfig() {
  const device = S.accel.device_id;
  try {
    const j = await invoke('client_config');
    if (device !== S.accel.device_id) return;
    if (j && j.slow) {
      applySlowConfig(j.slow);
      try { localStorage.setItem('slowConfig', JSON.stringify(j.slow)); } catch {}
    }
    if (j && j.hf_mirror) invoke('set_hf_mirror', { mode: j.hf_mirror }).catch(() => {});
    if (j && Array.isArray(j.nodes)) {
      const account = await invoke('accel_status');
      if (device !== S.accel.device_id) return;
      S.accel = { ...S.accel, lines: account.lines, nodes: account.nodes };
      refreshNodes();
    }
    // 有新版本：问用户要不要更新（等几秒，别和启动时的其他提示挤在一起）
    if (j && j.update && typeof checkUpdate === 'function') setTimeout(() => { if (device === S.accel.device_id) checkUpdate(j.update); }, 4000);
  } catch {}
}
function watchSlow(p) {
  if (!SLOW.enabled || p.status !== 'downloading' || S.accel?.member || !p.total || /高速/.test(p.route || '')) return;
  if (S.stall[p.id]?.asked) return;
  const w = (S.slow[p.id] ||= { t0: Date.now(), samples: [], asked: false });
  const now = Date.now();
  w.samples.push([now, p.done]);
  while (w.samples.length > 2 && now - w.samples[0][0] > SLOW.window * 1000) w.samples.shift();
  if (w.asked || now - w.t0 < SLOW.warmup * 1000 || S.modal) return;
  const [t1, d1] = w.samples[0];
  // 至少攒 2 秒的数据再算速度
  if (now - t1 < 2000) return;
  const speed = (p.done - d1) / ((now - t1) / 1000);
  const remainMin = (p.total - p.done) / Math.max(speed, 1) / 60;
  if (speed >= SLOW.speed || (SLOW.remainMin > 0 && remainMin < SLOW.remainMin)) return;
  let last = 0;
  try { last = +localStorage.getItem('slowAskAt') || 0; } catch {}
  if (now - last < SLOW.quietHours * 3600 * 1000) return;
  w.asked = true;
  try { localStorage.setItem('slowAskAt', String(now)); } catch {}
  openModal({ slow: { speed, remainMin }, retry: switchToAccel(p.id) });
}
// 开通成功后：停掉直连，改走高速线路接着下（已下载的部分保留）
function switchToAccel(id) {
  return async () => {
    const again = S.dlRestart[id];
    if (!again) return;
    await call('cancel_download', { id }).catch(() => {});
    await (S.dlJobs[id] || Promise.resolve()).catch(() => {});
    toast('已切换到高速下载，接着刚才的进度继续下载');
    again();
  };
}
// 连不上 / 下不动：点下载后 5 秒还没收到数据（或者收到一点就卡住），马上提示开通高速下载。
// 不会停掉当前下载：用户点「继续等待」就接着等
const STALL_MS = 5000;
function watchStall() {
  if (!SLOW.enabled || S.accel?.member) return;
  const now = Date.now();
  for (const [id, p] of Object.entries(S.downloads)) {
    if (p.status !== 'downloading' || /高速/.test(p.route || '') || !S.dlRestart[id]) continue;
    const w = (S.stall[id] ||= { d0: p.done, last: p.done, lastT: now, asked: false });
    if (p.done !== w.last) {
      w.last = p.done;
      w.lastT = now;
    }
    if (w.asked || S.modal || now - w.lastT < STALL_MS || p.done - w.d0 > 256 * 1024) continue;
    w.asked = true;
    openModal({ stall: true, retry: switchToAccel(id) });
  }
}
setInterval(watchStall, 1000);
// 下载失败、需要开通高速下载：如果用户已经在开通窗口里（选套餐、付款中），只换掉开通后要做的事，别把窗口重置
function needAccelModal(o) {
  const m = S.modal;
  if (m && ['ask', 'plans', 'pay', 'code'].includes(m.step) && !m.expired) {
    m.retry = o.retry;
    if (m.step === 'ask' && (m.stall || m.slow)) {
      delete m.stall;
      delete m.slow;
      renderModal();
    }
    return;
  }
  openModal(o);
}
const fmtMin = (m) => (m >= 120 ? `${Math.round(m / 60)} 小时` : m >= 60 ? `${Math.floor(m / 60)} 小时 ${Math.round(m % 60)} 分钟` : `${Math.round(m)} 分钟`);

listen('download-progress', (e) => {
  const p = e.payload;
  if (p.status === 'reset') {
    delete S.downloads[p.id];
    return;
  }
  S.downloads[p.id] = p;
  watchSlow(p);
  document.querySelectorAll(`[data-dl="${CSS.escape(p.id)}"]`).forEach((el) => {
    if (p.status === 'downloading') el.innerHTML = dlHtml(p);
  });
  if (p.status === 'downloading' && S.modal?.step === 'vision' && S.modal.busy) {
    const el = document.getElementById('visionProg');
    if (el) el.innerHTML = dlHtml(p);
  }
  if (p.status === 'error' || p.status === 'cancelled') render();
});
listen('server-log', (e) => {
  S.logs.push(e.payload);
  if (S.logs.length > 400) S.logs.splice(0, S.logs.length - 400);
  const el = $('#logs');
  if (el) {
    el.insertAdjacentHTML('beforeend', (el.textContent ? '\n' : '') + logLine(e.payload));
    el.scrollTop = el.scrollHeight;
  }
});
// 启动时按设备号自动恢复了已购买的高速下载
listen('accel-status', (e) => {
  S.accel = e.payload;
  invoke('get_settings').then((s) => (S.settings = s)).catch(() => {});
  render();
  toast('已恢复你购买的高速下载服务');
});
listen('net-status', (e) => {
  S.net = e.payload;
});
listen('server-status', (e) => {
  S.server = e.payload;
  renderSide();
  if (S.page === 'run' || S.page === 'chat') render();
});

// 加载中每秒刷新一次进度（只更新进度框，不整页重绘）
setInterval(async () => {
  if (!S.run.starting && (!S.server.running || S.server.ready)) return;
  try {
    S.run.load = await invoke('load_progress');
    const box = $('#loadcard');
    if (box) box.innerHTML = loadHtml();
    renderSide();
  } catch {}
}, 1000);

// 模型运行中崩溃：显卡计算出错时自动降一级兼容模式重启，并重新回答；否则在对话页顶部说明原因
listen('server-crashed', async (e) => {
  let info = e.payload;
  try { S.server = await invoke('server_status'); } catch {}
  const level = S.run.actual?.safe_level ?? 0;
  if (info.gpu_error && level < 5 && info.model_path) {
    S.autoRecovering = true;
    S.crash = null;
    toast(`显卡计算出错，正在切换兼容模式 ${level + 1} 重新启动…`, 6000);
    S.run.path = info.model_path;
    const back = S.page;
    if (back !== 'chat') render();
    await actions.startModel({ safe: level + 1, stay: true });
    S.autoRecovering = false;
    if (S.server.ready) {
      toast('已切换兼容模式，正在重新回答');
      if (back === 'chat') render();
      setTimeout(() => retryLast(), 300);
    } else {
      S.crash = info;
      render();
    }
    return;
  }
  // 其他原因的意外退出：自动重启（10 分钟内最多 3 次，避免一直崩一直重启）
  if (!info.gpu_error && info.model_path && S.settings?.auto_restart !== false) {
    const now = Date.now();
    S.crashTimes = (S.crashTimes || []).filter((t) => now - t < 10 * 60 * 1000);
    if (S.crashTimes.length < 3) {
      S.crashTimes.push(now);
      S.autoRecovering = true;
      S.crash = null;
      toast(`模型进程意外退出，正在自动重启（第 ${S.crashTimes.length} 次）…`, 6000);
      S.run.path = info.model_path;
      const back = S.page;
      render();
      await actions.startModel({ safe: level, stay: true });
      S.autoRecovering = false;
      if (S.server.ready) {
        toast('模型已自动重启。刚才没答完的问题，可以点「重新生成」');
        if (back === 'chat') render();
        return;
      }
    } else {
      info = { ...info, message: `10 分钟内已经自动重启了 3 次还是退出，先停下来。${info.message}` };
    }
  }
  if (info.gpu_error && level >= 5) {
    const log = info.message.split('\n\n').slice(1).join('\n\n');
    info = {
      ...info,
      message: `五级兼容模式都试过了，还是出显卡计算错误。如果换别的模型也一样，问题多半不在模型，而在推理引擎版本或显卡本身。可以按顺序试：① 日志第一行有引擎版本号，到「设置 → 推理引擎」换一个旧一点的版本（手动导入 llama.cpp 官方 Releases 里一两周前的 cuda-12.4 包）；② 关掉显卡超频 / 降压工具（MSI Afterburner、挖矿软件等），恢复默认频率和功耗；③ 用 DDU 卸干净后重装 NVIDIA 驱动。\n\n${log}`,
    };
  }
  S.crash = info;
  toast('模型进程意外退出了，原因见对话页顶部', 6000);
  render();
});

listen('server-note', (e) => {
  S.run.note = e.payload;
  toast(e.payload.replace('[启动器] ', ''), 6000);
});

// 模型清单在线更新后，刷新推荐
listen('catalog-updated', () => {
  S.catalog = null;
  loadOverview(false).catch(() => {});
  if (S.page === 'models') loadCatalog().catch(() => {});
});

// 运行中每 2 秒刷新一次显存/内存
setInterval(async () => {
  if (!S.server.running || S.page !== 'run') return;
  try {
    S.run.stats = await invoke('live_stats');
    if (!S.streaming) render();
  } catch {}
}, 2000);

// ------------------------------------------------------------------ 启动
(async function init() {
  if ($('#app').classList.contains('collapsed')) {
    const t = $('#sideToggle');
    t.title = '展开侧边栏';
    t.setAttribute('aria-label', t.title);
    t.setAttribute('aria-expanded', 'false');
  }
  render();
  try {
    S.settings = await invoke('get_settings');
    try { S.version = await window.__TAURI__.app.getVersion(); } catch {}
    S.server = await invoke('server_status');
    S.accel = await invoke('accel_status');
  } catch {}
  renderSide();
  refreshMembership();
  loadClientConfig();
  await loadOverview(false).catch(() => {});
  loadLocal().catch(() => {});
})();
