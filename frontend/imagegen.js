// LocModel —— 画图 / 生成视频：stable-diffusion.cpp 本地生成
// 页面：「画图」「视频」（输入提示词生成 + 历史作品）；「模型 → 画图 / 视频模型」（按显卡推荐、下载）

S.img = {
  catalog: null, // 画图 + 视频模型清单（含每个量化的大小、能不能跑、是否已下载）
  engine: undefined, // 画图引擎（undefined = 还没查）
  status: {}, // sd-server 状态
  sel: {}, // 模型列表里每个模型选中的量化
  busy: '', // loading / generating
  busyKind: '', // image / video
  progress: null, // [当前步, 总步数]
  t0: 0,
  error: '',
  history: null,
  thumbs: {}, // 文件路径 → data URL
  forms: {},
};

const IMG_SIZES = [
  ['1:1', 1024, 1024],
  ['3:4', 896, 1152],
  ['4:3', 1152, 896],
  ['9:16', 768, 1344],
  ['16:9', 1344, 768],
];
// 清晰度：按总像素算（1K ≈ 100 万像素，2K ≈ 400 万，4K ≈ 1600 万），再按比例分到宽高，宽高取 64 的倍数
const IMG_RES = [
  ['1K', 1024 * 1024],
  ['2K', 2048 * 2048],
  ['4K', 4096 * 4096],
];
const r64 = (v) => Math.max(256, Math.min(4096, Math.round(v / 64) * 64));
function imgDims(f) {
  if (f.res === 'custom') return [r64(+f.cw || 1024), r64(+f.ch || 1024)];
  const [, bw, bh] = IMG_SIZES.find((x) => x[0] === f.size) || IMG_SIZES[0];
  const area = (IMG_RES.find((x) => x[0] === f.res) || IMG_RES[0])[1];
  const r = bw / bh;
  return [r64(Math.sqrt(area * r)), r64(Math.sqrt(area / r))];
}
// 视频尺寸：480P 所有视频模型都能用；720P 只有 Wan2.2 5B 支持
const VID_SIZES = [
  ['横屏 480P', 832, 480, false],
  ['竖屏 480P', 480, 832, false],
  ['横屏 720P', 1280, 704, true],
  ['竖屏 720P', 704, 1280, true],
];
// 视频时长 → 帧数（Wan 要求帧数 = 4 的倍数 + 1）
// 视频时长：用户自己填秒数（1–20 秒），帧数 = 秒数 × 帧率 + 1（引擎会再按模型要求微调到合适的帧数）
const VID_MAX_SECS = 20;
const vidSecsOf = (v) => Math.max(1, Math.min(VID_MAX_SECS, Math.round(+v || 2)));
const vidFrames = (fps, secs) => vidSecsOf(secs) * (fps || 16) + 1;

// 量化名显示：用户自己导入的文件（local:文件名）显示成「本地 · Q4_K_M」
const qName = (q) => (String(q).startsWith('local:') ? `本地 · ${q.slice(6).match(/(?:UD-)?(?:I?Q\d\w*|BF16|F16|FP16|FP8|F32)(?=\.\w+$)/i)?.[0] || q.slice(6)}` : q);
const mediaKind = () => (S.page === 'video' ? 'video' : 'image');
const KIND_WORD = { image: '画图', video: '视频' };

function imgForm(kind = mediaKind()) {
  if (!S.img.forms[kind]) {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(kind === 'video' ? 'vidForm' : 'imgForm') || 'null'); } catch {}
    const def = kind === 'video'
      ? { model: '', prompt: '', negative: '', size: '横屏 480P', steps: 0, secs: 2, seed: '', initImage: '' }
      : { model: '', prompt: '', negative: '', size: '1:1', steps: 0, count: 1, seed: '', strength: 0.6, refImage: '' };
    S.img.forms[kind] = Object.assign(def, saved || {});
    S.img.forms[kind].initImage = ''; // 首帧图片、参考图片不跨重启保存
    S.img.forms[kind].endImage = '';
    S.img.forms[kind].refImages = [];
    S.img.forms[kind].refImage = '';
  }
  return S.img.forms[kind];
}
function saveImgForm(kind = mediaKind()) {
  try {
    const { initImage, endImage, refImages, refImage, ...rest } = S.img.forms[kind] || {};
    localStorage.setItem(kind === 'video' ? 'vidForm' : 'imgForm', JSON.stringify(rest));
  } catch {}
}

// 参考图片 → 出图尺寸：保持原图比例，面积约 1024×1024，边长取 16 的倍数
async function prepRef(dataUrl) {
  const img = new Image();
  await new Promise((ok, bad) => { img.onload = ok; img.onerror = () => bad(new Error('图片读取失败')); img.src = dataUrl; });
  const r = img.width / img.height;
  const area = 1024 * 1024;
  const r16 = (x) => Math.max(512, Math.min(1536, Math.round(x / 16) * 16));
  const w = r16(Math.sqrt(area * r));
  const h = r16(Math.sqrt(area / r));
  return { w, h, data: await fitImage(dataUrl, w, h) };
}
const editModelHint = '想只改你说的地方（其余保持不变），请下载「Qwen-Image-Edit 改图」或「FLUX.2 klein」';

async function loadImageData(force = false) {
  const jobs = [];
  if (force || !S.img.catalog) jobs.push(call('image_catalog').then((c) => (S.img.catalog = c)).catch(() => {}));
  if (force || S.img.engine === undefined) jobs.push(invoke('image_engine_status').then((e) => (S.img.engine = e)).catch(() => (S.img.engine = null)));
  if (!S.img.history) jobs.push(invoke('image_history').then((h) => (S.img.history = h)).catch(() => (S.img.history = [])));
  jobs.push(invoke('image_status').then((st) => (S.img.status = st)).catch(() => {}));
  jobs.push(invoke('list_loras').then((l) => (S.img.loras = l)).catch(() => (S.img.loras = [])));
  await Promise.all(jobs);
  if (S.page === 'image' || S.page === 'video' || (S.page === 'models' && S.modelsTab === 'image')) {
    render();
    fillThumbs();
  }
}

// 已下载、可以用的模型（模型 + 量化）
function installedImageModels(kind = mediaKind()) {
  const out = [];
  for (const m of S.img.catalog || []) if (m.kind === kind) for (const q of m.quants) if (q.installed) out.push({ m, q, key: `${m.id}|${q.quant}` });
  return out;
}

// ------------------------------------------------------------------ 模型页：画图 / 视频模型
// 主体有了（下载一半或从别处导入的），但配套文件没装全：列出缺什么，给「补齐」和「手动导入」两个办法
function missingPartsHtml(m, q) {
  if (!q.has_main || q.installed || !q.missing?.length) return '';
  const list = q.missing.map((x) => `<li><b>${esc(x.label)}</b> <span class="mono">${esc(x.file)}</span> <span class="muted">${fmtGB(x.size)}</span></li>`).join('');
  return `<div class="miss-parts"><div><b>主体文件已经有了，还缺 ${q.missing.length} 个组件才能用：</b></div><ul>${list}</ul>
    <div class="row" style="gap:8px">${dlSlot(`img:${m.id}:${q.quant}`, `<button class="btn primary sm" data-act="downloadImageModel" data-id="${esc(m.id)}" data-q="${esc(q.quant)}">补齐缺少的组件（${fmtGB(q.need_bytes)}）</button><button class="btn sm" data-act="importImageParts" data-id="${esc(m.id)}">已经下好了？手动导入组件</button>`)}</div></div>`;
}
// 默认选中的量化：用户选过的 → 已经装好 / 导入了主体的 → 推荐的
function pickQuant(m) {
  const sel = S.img.sel[m.id];
  return m.quants.find((x) => x.quant === sel) || m.quants.find((x) => x.installed) || m.quants.find((x) => x.has_main) || m.quants.find((x) => x.quant === m.rec_quant) || m.quants[0];
}

function imageModelRows(kind) {
  if (!S.img.catalog) return '<div class="empty">正在读取…</div>';
  return S.img.catalog
    .filter((m) => m.kind === kind)
    .map((m) => {
      const q = pickQuant(m);
      const id = `img:${m.id}:${q.quant}`;
      const opts = m.quants
        .map((x) => `<option value="${esc(x.quant)}" ${x.quant === q.quant ? 'selected' : ''}>${esc(qName(x.quant))}${x.quant === m.rec_quant && m.quants.length > 1 ? '（推荐）' : ''}${x.installed ? ' · 已下载' : x.has_main ? ' · 缺组件' : ''}</option>`)
        .join('');
      const act = q.installed
        ? `<div class="row" style="gap:6px;justify-content:flex-end"><button class="btn soft" data-act="useImageModel" data-id="${esc(m.id)}" data-q="${esc(q.quant)}" data-kind="${m.kind}">已下载 · 去${m.kind === 'video' ? '生成' : '画图'}</button><button class="btn sm" title="删除这个量化版本" data-act="delImageModel" data-id="${esc(m.id)}" data-q="${esc(q.quant)}">删除</button></div>`
        : q.has_main
          ? '<span class="tag amber">缺组件</span>'
          : dlSlot(id, `<button class="btn primary" data-act="downloadImageModel" data-id="${esc(m.id)}" data-q="${esc(q.quant)}">下载 ${fmtGB(q.need_bytes)}</button>`);
      const tags = `<span class="tag clay">${KIND_WORD[m.kind]}</span>${m.kind === 'video' && m.edit_only ? '<span class="tag blue">需要上传图片</span>' : m.i2v ? '<span class="tag blue">图生视频</span>' : ''}${m.end_frame ? '<span class="tag blue">首尾帧</span>' : ''}${m.refs > 0 ? '<span class="tag blue">多图参考</span>' : ''}${m.audio ? '<span class="tag green">带声音</span>' : ''}${m.hd ? '<span class="tag">720P</span>' : ''}${m.kind === 'image' && m.edit ? `<span class="tag blue">${m.edit_only ? '只能改图' : '能改图'}</span>` : ''}`;
      return `<div class="item">
      <div class="c1"><div class="row" style="gap:8px"><span class="name">${esc(m.name)}</span>${tags}<span class="muted" style="font-size:12px">${esc(m.released)}</span></div><div class="desc"><span class="muted">${esc(m.org)} · </span>${esc(m.desc)}</div></div>
      <div class="c2"><label class="sr" for="iq-${esc(m.id)}">量化</label><select class="input mono" style="font-size:12px" id="iq-${esc(m.id)}" data-change="imgQuant" data-id="${esc(m.id)}">${opts}</select><span class="mono muted" style="font-size:12px">共 ${fmtGB(q.bytes)}</span></div>
      <div class="c3"><div class="row" style="gap:8px">${tierHtml(q)}<span class="muted" style="font-size:12px">${{ fast: '整个模型放进显卡', ok: '文本编码器放内存', slow: '部分放内存，生成较慢', no: '显存和内存都不够' }[q.tier] || ''}</span></div></div>
      <div class="c4">${act}</div>
      ${missingPartsHtml(m, q)}
    </div>`;
    })
    .join('');
}

function imageModelsPane() {
  const e = S.img.engine;
  return `<div class="between" style="gap:12px;margin:2px 0 12px;align-items:flex-start"><div class="muted" style="font-size:13px">每个模型包含主体、文本编码器和 VAE，一键全部下载。按你的显卡推荐了合适的量化版本，也可以自己选。<br>已经在别处下好了画图 / 视频模型文件（GGUF、safetensors）？点右边「导入本地文件」，缺的配套文件会自动补下。</div><button class="btn" data-act="importImageFile" style="flex:0 0 auto">导入本地文件</button></div>
    ${e === null ? imgEngineNotice() : e ? `<div class="muted row" style="font-size:12.5px;gap:8px;margin:-4px 0 10px">画图 / 视频引擎：${esc(e.tag)} · ${esc(e.variant)}${dlSlot('sdengine', '<button class="btn sm" data-act="installImageEngine">检查更新</button>')}</div>` : ''}
    <h2 class="img-h2">画图模型</h2><div class="list">${imageModelRows('image')}</div>
    <h2 class="img-h2">视频模型</h2><div class="list">${imageModelRows('video')}</div>`;
}

function imgEngineNotice() {
  const h = S.overview?.hardware;
  const b = h ? { cuda: 'CUDA（N 卡）', vulkan: 'Vulkan（显卡通用）', metal: 'Metal（Apple 芯片）' }[h.backend] || 'CPU' : '';
  return `<div class="notice" style="margin-bottom:14px"><div><b>先安装画图 / 视频引擎</b><p>第一次使用需要下载 stable-diffusion.cpp 官方 ${b} 版本（几十 MB 到几百 MB），画图和视频共用，以后不用再装。</p></div>
    <div class="row">${dlSlot('sdengine', '<button class="btn primary" data-act="installImageEngine">一键安装</button>')}</div></div>`;
}

// ------------------------------------------------------------------ 画图 / 视频页
function pageImage() {
  const kind = mediaKind();
  const video = kind === 'video';
  const word = video ? '视频' : '画图';
  const f = imgForm(kind);
  const e = S.img.engine;
  if (!S.img.catalog || e === undefined) return `<div class="page"><h1>${word}</h1><div class="empty">正在读取…</div></div>`;
  const inst = installedImageModels(kind);
  const modeTabs = video ? '' : `<div class="seg-tabs" role="tablist" aria-label="画图方式"><button role="tab" class="${S.img.mode !== 'canvas' ? 'on' : ''}" data-act="imgMode" data-m="form">表单</button><button role="tab" class="${S.img.mode === 'canvas' ? 'on' : ''}" data-act="imgMode" data-m="canvas">画布</button></div>`;
  const head = `<div class="page-head"><h1>${video ? '生成视频' : '画图'}</h1>${modeTabs}<div class="row">${S.img.status.running ? `<button class="btn" data-act="stopImage" title="释放模型占用的显存">停止${word}引擎</button>` : ''}<button class="btn" data-act="openImagesDir">打开作品文件夹</button><button class="btn" data-act="go" data-page="models" data-tab="image">下载${word}模型</button></div></div>`;
  if (e === null) return `<div class="page">${head}${imgEngineNotice()}${inst.length ? '' : imgNoModel(kind)}</div>`;
  if (!inst.length) return `<div class="page">${head}${imgNoModel(kind)}</div>`;

  if (!inst.some((x) => x.key === f.model)) f.model = inst[0].key;
  const cur = inst.find((x) => x.key === f.model);
  if (!video && S.img.mode === 'canvas' && typeof pageCanvas === 'function') return pageCanvas(head, inst, f, cur);
  const steps = f.steps || cur.m.steps;
  const opts = inst.map((x) => `<option value="${esc(x.key)}" ${x.key === f.model ? 'selected' : ''}>${esc(x.m.name)} · ${esc(qName(x.q.quant))}${!video && x.m.edit_only ? '（只能改图）' : !video && x.m.edit ? '（能画也能改图）' : ''}</option>`).join('');
  let sizes;
  if (video) {
    const list = VID_SIZES.filter((s) => !s[3] || cur.m.hd);
    if (!list.some((s) => s[0] === f.size)) f.size = list[0][0];
    sizes = list.map(([k, w, h]) => `<button type="button" class="chip ${f.size === k ? 'on' : ''}" data-act="imgSize" data-k="${k}" title="${w}×${h}">${k}</button>`).join('');
  } else if (f.refImage) {
    sizes = '<span class="muted" style="font-size:13px">跟随参考图片的比例</span>';
  } else {
    const custom = f.res === 'custom';
    const [dw, dh] = imgDims(f);
    sizes = `${custom ? '' : IMG_SIZES.map(([k]) => `<button type="button" class="chip ${f.size === k ? 'on' : ''}" data-act="imgSize" data-k="${k}">${k}</button>`).join('')}</div>
      <div class="chips" style="margin-top:8px" role="radiogroup" aria-label="清晰度">${[...IMG_RES.map((x) => x[0]), 'custom'].map((k) => `<button type="button" class="chip ${(f.res || '1K') === k ? 'on' : ''}" data-act="imgRes" data-k="${k}">${k === 'custom' ? '自定义' : k}</button>`).join('')}</div>
      ${custom ? `<div class="row" style="gap:8px;margin-top:8px;align-items:center"><input class="input mono" data-imgf="cw" type="number" min="256" max="4096" step="64" value="${esc(f.cw || 1024)}" aria-label="宽" style="width:100px"><span class="muted">×</span><input class="input mono" data-imgf="ch" type="number" min="256" max="4096" step="64" value="${esc(f.ch || 1024)}" aria-label="高" style="width:100px"></div>` : ''}
      <div class="help" style="margin-top:6px">实际尺寸 ${dw}×${dh}${dw * dh > 6e6 ? '。4K 出图比 1K 慢十几倍、显存占用也大很多，建议先用 1K 出满意的图，再用同样的种子出 4K' : dw * dh > 2.5e6 ? '。2K 比 1K 慢 3–4 倍' : ''}${custom ? '（宽高会自动取 64 的倍数）' : ''}</div><div>`;
  }
  const needRef = (cur.m.edit_only && (video ? !f.initImage : !f.refImage)) || (video && cur.m.refs > 0 && !(f.refImages || []).length);
  const busy = S.img.busy && S.img.busyKind === kind;
  const otherBusy = S.img.busy && S.img.busyKind !== kind;
  const btn = busy
    ? `<button class="btn lg" data-act="${video ? 'cancelVideo' : 'stopImage'}" style="width:100%">停止</button>`
    : `<button class="btn primary lg" data-act="generateImage" style="width:100%" ${f.prompt.trim() && !otherBusy && !needRef ? '' : 'disabled'}>${otherBusy ? '正在生成图片…' : needRef ? (video ? (cur.m.refs > 0 ? '先上传参考图片' : '先上传第一帧图片') : '先选一张要修改的图片') : f.refImage ? (cur.m.edit ? '修改图片' : '按参考图重画') : '生成'}</button>`;
  const extra = video
    ? `<div class="img-3">
          <div class="field"><label for="imgSteps">步数</label><input class="input mono" id="imgSteps" data-imgf="steps" type="number" min="1" max="60" value="${steps}"></div>
          <div class="field"><label for="vidSecs">时长（秒）</label><input class="input mono" id="vidSecs" data-change="vidSecs" type="number" min="1" max="${VID_MAX_SECS}" step="1" value="${vidSecsOf(f.secs)}"></div>
          <div class="field"><label for="imgSeed">种子</label><input class="input mono" id="imgSeed" data-imgf="seed" placeholder="随机" value="${esc(f.seed)}"></div>
        </div>
        ${cur.m.i2v ? `<div class="field"><label>第一帧图片${cur.m.edit_only ? '（必填）' : '（可选）'}</label>
          ${f.initImage ? `<div class="vid-init"><img src="${f.initImage}" alt=""><button class="btn sm" data-act="clearInitImage">去掉</button></div>` : `<button class="btn" data-act="pickInitImage" style="width:100%">上传一张图片，让它动起来</button>`}
          <div class="help">${cur.m.edit_only ? '这个模型是图生视频：上传一张图片，再描述它怎么动。' : '不上传就是根据文字生成视频。'}${cur.m.audio ? '会同时生成声音，可以在描述里写对白、音效或背景音乐。' : ''}</div></div>` : ''}
        ${cur.m.end_frame ? `<div class="field"><label>最后一帧图片（可选）</label>
          ${f.endImage ? `<div class="vid-init"><img src="${f.endImage}" alt=""><button class="btn sm" data-act="clearEndImage">去掉</button></div>` : `<button class="btn" data-act="pickInitImage" data-slot="end" style="width:100%">上传最后一帧（首尾帧：从第一帧变到这一帧）</button>`}</div>` : ''}
        ${cur.m.refs > 0 ? `<div class="field"><label>参考图片（1–${cur.m.refs} 张，必填）</label>
          <div class="vid-refs">${(f.refImages || []).map((x, i) => `<div class="vid-ref"><img src="${x}" alt=""><button class="ax" data-act="delVidRef" data-i="${i}" aria-label="去掉这张">✕</button></div>`).join('')}${(f.refImages || []).length < cur.m.refs ? `<button class="vid-ref add" data-act="pickVidRefs" aria-label="添加参考图片">＋</button>` : ''}</div>
          <div class="help">上传人物、商品或场景的照片（可以一次选多张），再在描述里说他们在视频里做什么，例如：图 1 的女孩拿着图 2 的杯子在图 3 的咖啡馆里喝咖啡。${cur.m.audio ? '会同时生成声音。' : ''}</div></div>` : ''}
        <div class="help" style="margin-top:-4px">时长可以填 1–${VID_MAX_SECS} 秒。视频生成比较慢：4090 上 2 秒视频大约需要 1–3 分钟，时长翻倍耗时和显存占用也会明显增加。${/^wan/.test(cur.m.id) ? 'Wan 模型按 5 秒左右训练，超过 5 秒画面可能变差。' : ''}</div>`
    : `<div class="img-3">
          <div class="field"><label for="imgSteps">步数</label><input class="input mono" id="imgSteps" data-imgf="steps" type="number" min="1" max="60" value="${steps}"></div>
          <div class="field"><label for="imgCount">张数</label><select class="input" id="imgCount" data-change="imgCount">${[1, 2, 3, 4].map((n) => `<option ${+f.count === n ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
          <div class="field"><label for="imgSeed">种子</label><input class="input mono" id="imgSeed" data-imgf="seed" placeholder="随机" value="${esc(f.seed)}"></div>
        </div>
        <div class="field"><label>${cur.m.edit_only ? '要修改的图片' : '参考图片（可选）'}</label>
          ${f.refImage ? `<div class="vid-init"><img src="${f.refImage}" alt=""><button class="btn sm" data-act="clearRefImage">去掉</button></div>` : `<button class="btn" data-act="pickRefImage" style="width:100%">${cur.m.edit ? '上传一张图片，用一句话修改它' : '上传一张图片，在它的基础上重画'}</button>`}
          <div class="help">${cur.m.edit ? '例如：把背景换成海边 / 给她戴上墨镜 / 把图里的字改成“新年快乐”。' : f.refImage ? '' : editModelHint + '。'}</div>
          ${f.refImage && !cur.m.edit ? `<label class="help" for="imgStrength" style="display:block;margin-top:6px">重画幅度：<b>${Math.round((+f.strength || 0.6) * 100)}%</b>（越大越不像原图）</label><input id="imgStrength" type="range" min="0.2" max="0.95" step="0.05" value="${+f.strength || 0.6}" data-change="imgStrength" style="width:100%">` : ''}
        </div>`;
  return `<div class="page img-page">${head}
    <div class="img-wrap">
      <section class="card img-form">
        <div class="field"><label for="imgModel">模型</label><select class="input" id="imgModel" data-change="imgModel">${opts}</select></div>
        <div class="field"><label for="imgPrompt">${video ? '描述视频里发生的事' : '描述你想要的画面'}</label>
          <textarea class="input" id="imgPrompt" data-imgf="prompt" rows="5" placeholder="${video ? '例如：一只橘猫在草地上追蝴蝶，镜头跟随，阳光明媚，电影感' : '例如：一只橘猫在樱花树下睡觉，阳光透过花瓣，水彩风格'}">${esc(f.prompt)}</textarea>
          <div class="help">${cur.m.id === 'flux1-schnell' ? 'FLUX 对英文提示词效果最好。' : '可以直接写中文。'}${video ? '写清楚主体、动作、镜头和氛围，效果更好。' : '写清楚主体、场景、风格、光线，效果更好。'}</div></div>
        <details ${f.negative ? 'open' : ''}><summary class="muted" style="font-size:13px;cursor:pointer">不想出现的内容（反向提示词）</summary>
          <textarea class="input" id="imgNeg" data-imgf="negative" rows="2" style="margin-top:8px" placeholder="${video ? '例如：画面闪烁，模糊，变形，静止不动，字幕，水印' : '例如：模糊，变形，多余的手指，水印'}">${esc(f.negative)}</textarea></details>
        <div class="field"><label>${video ? '画面尺寸' : f.refImage ? '画面比例' : '画面比例和清晰度'}</label><div class="chips">${sizes}</div></div>
        ${loraHtml(f, video)}
        ${extra}
        ${btn}
        <div id="imgStatus">${imgStatusHtml(kind)}</div>
      </section>
      <section class="img-gallery">${galleryHtml(kind)}</section>
    </div>
  </div>`;
}

// LoRA：风格、人物、动作微调模型。放进 LoRA 文件夹后在这里选，可以叠加几个、分别调强度
const activeLoras = (f) => (f.loras || []).filter((l) => (S.img.loras || []).some((x) => x.name === l.name) && +l.weight !== 0).map((l) => ({ name: l.name, weight: +l.weight }));
function loraHtml(f, video) {
  const all = S.img.loras || [];
  const sel = (f.loras || []).filter((l) => all.some((x) => x.name === l.name));
  const rest = all.filter((x) => !sel.some((l) => l.name === x.name));
  return `<details class="lora-box" ${sel.length ? 'open' : ''}><summary class="muted" style="font-size:13px;cursor:pointer">LoRA${sel.length ? `（已选 ${sel.length} 个）` : '（可选）'}</summary>
    <div class="stack" style="gap:8px;margin-top:8px">
      ${sel.map((l) => { const i = (f.loras || []).indexOf(l); return `<div class="lora-row"><span class="nm" title="${esc(l.name)}">${esc(l.name)}</span><input type="range" min="0" max="1.5" step="0.05" value="${l.weight}" data-change="loraWeight" data-i="${i}" aria-label="${esc(l.name)} 强度"><output>${(+l.weight).toFixed(2)}</output><button class="ax" data-act="delLora" data-i="${i}" aria-label="去掉 ${esc(l.name)}">✕</button></div>`; }).join('')}
      ${rest.length ? `<select class="input" data-change="addLora" aria-label="添加 LoRA"><option value="">＋ 选一个 LoRA…</option>${rest.map((x) => `<option value="${esc(x.name)}">${esc(x.name)}（${fmtSize(x.size)}）</option>`).join('')}</select>` : ''}
      <div class="row" style="gap:8px"><button class="btn sm" data-act="importLora">导入 LoRA 文件</button><button class="btn sm" data-act="openLoraDir">打开 LoRA 文件夹</button></div>
      <div class="help">LoRA 要和当前模型配套（${video ? '例如 Wan2.2 的 LoRA 只能配 Wan2.2' : '例如 FLUX 的 LoRA 只能配 FLUX'}），否则没效果或报错。强度一般 0.6–1。</div>
    </div></details>`;
}

function imgNoModel(kind, edit = false) {
  const word = edit ? '改图' : KIND_WORD[kind];
  const recs = (S.img.catalog || []).filter((m) => m.kind === kind && (edit ? m.edit : !m.edit_only)).map((m) => ({ m, q: m.quants.find((q) => q.quant === m.rec_quant) })).filter((x) => x.q && x.q.tier !== 'no');
  // 导入过主体但缺组件的：先告诉用户还差什么
  const partial = (S.img.catalog || []).filter((m) => m.kind === kind).flatMap((m) => m.quants.filter((q) => q.has_main && !q.installed).map((q) => ({ m, q })));
  if (partial.length) {
    return `<div class="card img-nomodel">${partial.map(({ m, q }) => `<div style="padding:6px 0"><b style="font-size:15px">${esc(m.name)} · ${esc(qName(q.quant))}</b>${missingPartsHtml(m, q)}</div>`).join('')}</div>`;
  }
  return `<div class="card img-nomodel">
    <b style="font-size:15px">还没有${word}模型</b>
    <p class="muted" style="margin:6px 0 14px">${recs.length ? '按你的电脑推荐：' : '你的电脑显存和内存不太够，可以去模型页看看全部模型。'}</p>
    ${recs.map(({ m, q }) => `<div class="between" style="padding:8px 0;border-top:1px solid var(--line)"><div><b>${esc(m.name)}</b> <span class="muted" style="font-size:12.5px">${esc(m.desc)}</span></div><div class="row" style="gap:8px">${tierHtml(q)}${dlSlot(`img:${m.id}:${q.quant}`, `<button class="btn primary sm" data-act="downloadImageModel" data-id="${esc(m.id)}" data-q="${esc(q.quant)}">下载 ${fmtGB(q.need_bytes)}</button>`)}</div></div>`).join('')}
    <div style="margin-top:12px"><a href="#" data-act="go" data-page="models" data-tab="image">查看全部${word}模型 →</a></div></div>`;
}

function imgStatusHtml(kind = mediaKind()) {
  const g = S.img;
  if (g.error && (!g.errorKind || g.errorKind === kind)) return `<div class="img-err">${esc(g.error)}<div style="margin-top:6px"><a href="#" data-act="showImgLog">查看完整日志</a></div></div>`;
  if (!g.busy || g.busyKind !== kind) return '';
  const secs = Math.round((Date.now() - g.t0) / 1000);
  const t = secs >= 60 ? `${Math.floor(secs / 60)} 分 ${secs % 60} 秒` : `${secs}s`;
  if (g.busy === 'loading') return `<div class="img-st"><span class="qp-spin"></span>正在加载${KIND_WORD[kind]}模型…（第一次要几十秒） ${t}</div>`;
  const p = g.progress;
  const pct = p && p[1] ? Math.round((p[0] / p[1]) * 100) : 0;
  return `<div class="img-st"><span class="qp-spin"></span>正在生成${p ? ` · 第 ${p[0]}/${p[1]} 步` : '…'} · ${t}</div>${p ? `<div class="bar thin" style="margin-top:6px"><i class="c-gpu" style="width:${pct}%"></i></div>` : ''}`;
}
function refreshImgStatus() {
  const el = document.getElementById('imgStatus');
  if (el) el.innerHTML = imgStatusHtml();
}

function historyOf(kind) {
  return (S.img.history || []).filter((r) => (r.kind || 'image') === kind);
}

function galleryHtml(kind) {
  const h = historyOf(kind);
  const video = kind === 'video';
  if (!h.length) return `<div class="img-empty"><div style="font-size:40px">${video ? '🎬' : '🎨'}</div><div>生成的${video ? '视频' : '图片'}会显示在这里</div><div class="muted" style="font-size:12.5px">同时自动保存在电脑上，点「打开作品文件夹」可以找到</div></div>`;
  return `<div class="img-grid">${h
    .slice(0, 120)
    .map((r) => {
      const isVid = r.path.toLowerCase().endsWith('.webm');
      const src = S.img.thumbs[r.path];
      const media = isVid
        ? `<video data-path="${esc(r.path)}" ${src ? `src="${src}"` : ''} muted loop autoplay playsinline></video>`
        : `<img data-path="${esc(r.path)}" alt="" ${src ? `src="${src}"` : ''}>`;
      const info = video ? `${r.width}×${r.height} · ${r.fps ? (r.frames / r.fps).toFixed(1) + ' 秒' : ''} · 用时 ${fmtSecs(r.secs)}` : `${r.width}×${r.height} · ${fmtSecs(r.secs)}`;
      return `<figure class="img-card">
      <div class="img-thumb" data-act="viewGen" data-path="${esc(r.path)}" style="aspect-ratio:${r.width}/${r.height}">${media}${isVid ? '<span class="vid-badge">▶</span>' : ''}</div>
      <figcaption><div class="img-p" title="${esc(r.prompt)}">${esc(r.prompt)}</div>
        <div class="img-meta"><span>${esc(r.model)} · ${info}</span>
          <span class="img-acts"><a href="#" data-act="reuseGen" data-path="${esc(r.path)}" title="用它的提示词和种子">复用</a><a href="#" data-act="copyGenPrompt" data-path="${esc(r.path)}">复制提示词</a><a href="#" data-act="delGen" data-path="${esc(r.path)}">删除</a></span></div></figcaption></figure>`;
    })
    .join('')}</div>`;
}
const fmtSecs = (s) => (s >= 60 ? `${Math.floor(s / 60)} 分 ${Math.round(s % 60)} 秒` : `${Math.round(s)}s`);

// 缩略图 / 视频：按需读取本地文件
async function fillThumbs() {
  for (const el of document.querySelectorAll('.img-thumb [data-path]')) {
    const p = el.dataset.path;
    if (!S.img.thumbs[p]) {
      try {
        S.img.thumbs[p] = await invoke('read_image', { path: p });
      } catch {
        continue;
      }
    }
    if (!el.getAttribute('src')) el.src = S.img.thumbs[p];
  }
}

// 大屏播放视频
function openVideo(src) {
  let el = document.getElementById('vidViewer');
  if (!el) {
    el = document.createElement('div');
    el.id = 'vidViewer';
    el.innerHTML = '<video controls autoplay loop playsinline></video><button type="button" aria-label="关闭">✕</button>';
    el.addEventListener('click', (ev) => {
      if (ev.target === el || ev.target.tagName === 'BUTTON') closeVideo();
    });
    document.body.appendChild(el);
  }
  el.querySelector('video').src = src;
  el.classList.add('on');
  document.addEventListener('keydown', videoKeys, true);
}
function closeVideo() {
  const el = document.getElementById('vidViewer');
  if (!el) return;
  el.classList.remove('on');
  el.querySelector('video').pause();
  document.removeEventListener('keydown', videoKeys, true);
}
function videoKeys(ev) {
  if (ev.key === 'Escape') closeVideo();
}

const recByPath = (p) => (S.img.history || []).find((r) => r.path === p);

// ------------------------------------------------------------------ 交互
document.addEventListener('input', (ev) => {
  const el = ev.target.closest?.('[data-imgf]');
  if (!el) return;
  const f = imgForm();
  f[el.dataset.imgf] = el.value;
  saveImgForm();
  if (el.dataset.imgf === 'prompt') {
    const b = document.querySelector('[data-act="generateImage"]');
    if (b) b.disabled = !el.value.trim() || (S.img.busy && S.img.busyKind !== mediaKind());
  }
});

Object.assign(changeHandlers, {
  imgQuant: (el) => {
    S.img.sel[el.dataset.id] = el.value;
    render();
  },
  imgModel: (el) => {
    const f = imgForm();
    f.model = el.value;
    f.steps = 0; // 换模型用它自己的默认步数
    saveImgForm();
    render();
  },
  addLora: (el) => {
    const f = imgForm();
    if (el.value && !(f.loras || []).some((x) => x.name === el.value)) (f.loras ||= []).push({ name: el.value, weight: 1 });
    saveImgForm();
    render();
  },
  loraWeight: (el) => {
    const f = imgForm();
    const l = (f.loras || [])[+el.dataset.i];
    if (l) l.weight = Math.max(-2, Math.min(2, +el.value || 0));
    saveImgForm();
    const out = el.parentElement?.querySelector('output');
    if (out) out.textContent = (+el.value).toFixed(2);
  },
  imgCount: (el) => {
    imgForm().count = +el.value;
    saveImgForm();
  },
  imgStrength: (el) => {
    imgForm('image').strength = +el.value;
    saveImgForm('image');
    render();
  },
  vidSecs: (el) => {
    imgForm().secs = vidSecsOf(el.value);
    el.value = imgForm().secs;
    saveImgForm();
  },
});

Object.assign(actions, {
  // 画图 / 视频引擎的完整日志（出错时发给开发者用）
  showImgLog: async (d, el, ev) => {
    ev?.preventDefault?.();
    const lines = await call('image_logs').catch(() => []);
    const text = lines.length ? lines.join('\n') : '还没有日志';
    S.modal = {
      step: 'custom',
      wide: true,
      text,
      html: (m) => `<h2>画图 / 视频引擎日志</h2><pre class="cmd" data-noi18n style="max-height:60vh;overflow:auto;font-size:12px;white-space:pre-wrap">${esc(m.text)}</pre>
        <div class="row" style="justify-content:flex-end;margin-top:10px"><button class="btn" data-act="copyImgLog">复制日志</button><button class="btn primary" data-act="closeModal">关闭</button></div>`,
    };
    renderModal();
  },
  copyImgLog: () => {
    navigator.clipboard.writeText(S.modal?.text || '');
    toast('日志已复制');
  },
  importImageFile: async (d) => {
    try {
      const m = await invoke('import_image_file', { id: d.id || null, path: d.path || null });
      if (!m) return;
      S.modal = null;
      renderModal();
      S.img.catalog = null;
      await loadImageData(true);
      S.img.sel[m.id] = m.quant;
      toast(`已导入：${m.name} ${qName(m.quant)}。缺的配套文件点「下载」补齐`, 6000);
      render();
    } catch (e) {
      const msg = String(e);
      if (msg.startsWith('UNKNOWN_FAMILY|')) {
        // 认不出是哪个模型：让用户选
        const path = msg.split('|').slice(2).join('|');
        await loadImageData();
        S.modal = {
          step: 'custom',
          path,
          html: (m) => `<h2>这个文件是哪个模型？</h2>
            <p class="muted" style="font-size:13px">${esc(m.path.split(/[\\/]/).pop())}<br>从文件名认不出来，请选一下它属于哪个模型（选错了会无法出图，可以再删掉重新导入）。</p>
            <select id="impFam" class="input">${(S.img.catalog || []).map((x) => `<option value="${esc(x.id)}">${esc(x.name)}（${x.kind === 'video' ? '视频' : '画图'}）</option>`).join('')}</select>
            <div class="row" style="justify-content:flex-end;margin-top:14px"><button class="btn" data-act="closeModal">取消</button><button class="btn primary" data-act="importImagePicked">导入</button></div>`,
        };
        renderModal();
      } else toast(msg.split('\n')[0], 6000);
    }
  },
  importImagePicked: () => actions.importImageFile({ id: $('#impFam').value, path: S.modal.path }),
  importImageParts: async (d) => {
    try {
      const done = await call('import_image_parts', { id: d.id });
      if (done?.length) {
        toast(`已导入：${done.join('、')}`);
        S.img.catalog = null;
        await loadImageData(true);
      }
    } catch {}
  },
  importImageEngine: async () => {
    try {
      const e = await call('import_image_engine_zip');
      if (e) {
        S.img.engine = e;
        S.img.status = {};
        toast(`画图 / 视频引擎导入完成（${e.tag} · ${e.variant}）`);
        render();
      }
    } catch {}
  },
  installImageEngine: async () => {
    S.downloads.sdengine = { id: 'sdengine', status: 'downloading', done: 0, total: 0, speed: 0, file_index: 0, file_count: 1, message: '' };
    render();
    const before = S.img.engine?.tag;
    try {
      S.img.engine = await call('install_image_engine');
      delete S.downloads.sdengine;
      toast(before && before === S.img.engine?.tag ? `画图 / 视频引擎已经是最新版本（${S.img.engine.tag}）` : '画图 / 视频引擎安装完成');
    } catch {}
    render();
  },
  downloadImageModel: async (d) => {
    const id = `img:${d.id}:${d.q}`;
    S.downloads[id] = { id, status: 'downloading', done: 0, total: 0, speed: 0, file_index: 0, file_count: 1, message: '' };
    S.dlRestart[id] = () => actions.downloadImageModel(d);
    delete S.stall[id];
    delete S.dlBase[id];
    render();
    try {
      const job = call('download_image_model', { id: d.id, quant: d.q });
      S.dlJobs[id] = job;
      await job;
      delete S.downloads[id];
      toast('模型下载完成');
      S.img.catalog = null;
      await loadImageData(true);
    } catch (e) {
      const msg = String(e);
      delete S.downloads[id];
      const retry = () => actions.downloadImageModel(d);
      if (msg.startsWith('NEED_ACCEL|')) needAccelModal({ retry });
      else if (msg.startsWith('MEMBER_EXPIRED|')) openModal({ retry, expired: true, reason: msg.split('|')[1] });
      else S.downloads[id] = { id, status: 'error', message: msg, done: 0, total: 0, speed: 0, file_index: 0, file_count: 0 };
      render();
    }
  },
  delImageModel: async (d) => {
    if (!confirm('删除这个模型？（几个模型共用的文本编码器和 VAE 会保留）')) return;
    await call('delete_image_model', { id: d.id, quant: d.q });
    await loadImageData(true);
  },
  useImageModel: (d) => {
    const kind = d.kind === 'video' ? 'video' : 'image';
    imgForm(kind).model = `${d.id}|${d.q}`;
    saveImgForm(kind);
    go(kind);
  },
  imgRes: (d) => {
    const f = imgForm();
    if (d.k === 'custom' && f.res !== 'custom') [f.cw, f.ch] = imgDims(f);
    f.res = d.k;
    saveImgForm();
    render();
  },
  // LoRA：选用、调强度、去掉、导入、打开文件夹
  delLora: (d) => {
    const f = imgForm();
    f.loras = (f.loras || []).filter((_, i) => i !== +d.i);
    saveImgForm();
    render();
  },
  importLora: async () => {
    const names = await call('import_lora');
    if (!names?.length) return;
    S.img.loras = await invoke('list_loras').catch(() => S.img.loras);
    const f = imgForm();
    for (const n of names) {
      const name = n.replace(/\.[^.]+$/, '');
      if (!(f.loras || []).some((x) => x.name === name)) (f.loras ||= []).push({ name, weight: 1 });
    }
    saveImgForm();
    toast(S.img.status.running ? '已导入。正在运行的引擎要重启后才能用新的 LoRA：点右上角「停止引擎」，下次生成会自动重新加载' : '已导入 LoRA');
    render();
  },
  openLoraDir: async () => call('open_path', { path: await invoke('lora_dir_path') }),
  imgSize: (d) => {
    imgForm().size = d.k;
    saveImgForm();
    render();
  },
  stopImage: async () => {
    await invoke('stop_image');
    S.img.status = {};
    if (S.img.busy) {
      S.img.error = '已停止';
      S.img.errorKind = S.img.busyKind;
    }
    S.img.busy = '';
    render();
  },
  cancelVideo: async () => {
    if (S.img.busy === 'loading') return actions.stopImage();
    await invoke('cancel_video');
    toast('正在取消…');
  },
  openImagesDir: () => call('open_images_dir'),
  pickVidRefs: () => {
    const f = imgForm('video');
    const cur = installedImageModels('video').find((x) => x.key === f.model);
    const max = cur?.m.refs || 4;
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.multiple = true;
    inp.accept = 'image/png,image/jpeg,image/webp,image/bmp';
    inp.onchange = async () => {
      for (const file of [...(inp.files || [])]) {
        if ((f.refImages || []).length >= max) break;
        const url = await new Promise((ok) => { const rd = new FileReader(); rd.onload = () => ok(rd.result); rd.readAsDataURL(file); });
        // 参考图保持原比例，缩到 1024 以内，转成不带透明通道的 JPEG
        const jpg = await toJpeg(url, 1024);
        if (jpg) f.refImages = [...(f.refImages || []), jpg];
      }
      render();
    };
    inp.click();
  },
  delVidRef: (d) => {
    const f = imgForm('video');
    f.refImages = (f.refImages || []).filter((_, i) => i !== +d.i);
    render();
  },
  clearEndImage: () => {
    imgForm('video').endImage = '';
    render();
  },
  pickInitImage: (d) => {
    const slot = d?.slot === 'end' ? 'endImage' : 'initImage';
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/png,image/jpeg,image/webp';
    inp.onchange = () => {
      const file = inp.files?.[0];
      if (!file) return;
      // 缩放到当前视频尺寸，并转成不带透明通道的 JPEG（引擎要求 3 通道）
      const f = imgForm('video');
      const [, w, h] = VID_SIZES.find((s) => s[0] === f.size) || VID_SIZES[0];
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, w, h);
        const s = Math.max(w / img.width, h / img.height);
        ctx.drawImage(img, (w - img.width * s) / 2, (h - img.height * s) / 2, img.width * s, img.height * s);
        f[slot] = c.toDataURL('image/jpeg', 0.92);
        render();
      };
      img.src = URL.createObjectURL(file);
    };
    inp.click();
  },
  pickRefImage: () => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/png,image/jpeg,image/webp,image/bmp';
    inp.onchange = () => {
      const file = inp.files?.[0];
      if (!file) return;
      const rd = new FileReader();
      rd.onload = async () => {
        // 太大的照片先缩到 2048 以内，省内存
        imgForm('image').refImage = (await makeThumb(rd.result, 2048)) || rd.result;
        render();
      };
      rd.readAsDataURL(file);
    };
    inp.click();
  },
  clearRefImage: () => {
    imgForm('image').refImage = '';
    render();
  },
  clearInitImage: () => {
    imgForm('video').initImage = '';
    render();
  },
  generateImage: async () => {
    const kind = mediaKind();
    const video = kind === 'video';
    const f = imgForm(kind);
    const [id, quant] = f.model.split('|');
    const m = (S.img.catalog || []).find((x) => x.id === id);
    if (!m || !f.prompt.trim() || S.img.busy) return;
    if (S.server.running && !confirm(`${video ? '生成视频' : '画图'}需要占用显存，先停止正在运行的对话模型吗？\n（完成以后可以在「运行」页重新启动）`)) return;
    S.img.error = '';
    S.img.errorKind = '';
    S.img.progress = null;
    S.img.busyKind = kind;
    S.img.t0 = Date.now();
    const timer = setInterval(refreshImgStatus, 1000);
    try {
      const st = S.img.status;
      if (!(st.running && st.ready && st.model === id && st.quant === quant)) {
        S.img.busy = 'loading';
        render();
        S.img.status = await call('start_image', { id, quant });
        S.server = await invoke('server_status');
      }
      S.img.busy = 'generating';
      S.img.t0 = Date.now();
      render();
      const seed = /^\d+$/.test(String(f.seed).trim()) ? +f.seed : -1;
      const steps = +f.steps || m.steps;
      let recs;
      if (video) {
        const [, w, h] = VID_SIZES.find((x) => x[0] === f.size) || VID_SIZES[0];
        const frames = vidFrames(m.fps, f.secs);
        recs = await call('generate_video', {
          req: { prompt: f.prompt.trim(), negative_prompt: (f.negative || '').trim(), width: w, height: h, steps, frames, seed, init_image: m.i2v && f.initImage ? f.initImage : null, end_image: m.end_frame && f.endImage ? f.endImage : null, ref_images: m.refs > 0 ? f.refImages || [] : [], loras: activeLoras(f) },
        });
      } else {
        let [w, h] = imgDims(f);
        let ref = null;
        if (f.refImage) ({ w, h, data: ref } = await prepRef(f.refImage));
        recs = await call('generate_image', {
          req: { prompt: f.prompt.trim(), negative_prompt: (f.negative || '').trim(), width: w, height: h, steps, cfg_scale: m.cfg, seed, count: +f.count || 1, ref_image: ref, strength: +f.strength || 0.6, loras: activeLoras(f) },
        });
      }
      S.img.history = [...recs, ...(S.img.history || [])];
      if (video) toast('视频生成好了');
    } catch (e) {
      if (S.img.busy) {
        S.img.error = String(e).split('\n').slice(0, 14).join('\n');
        S.img.errorKind = kind;
      }
    }
    clearInterval(timer);
    S.img.busy = '';
    S.img.progress = null;
    S.img.status = await invoke('image_status').catch(() => ({}));
    render();
    fillThumbs();
  },
  viewGen: async (d) => {
    const r = recByPath(d.path);
    if (!r) return;
    const src = S.img.thumbs[r.path] || (S.img.thumbs[r.path] = await invoke('read_image', { path: r.path }).catch(() => ''));
    if (r.path.toLowerCase().endsWith('.webm')) return openVideo(src);
    const list = historyOf(r.kind || 'image').filter((x) => !x.path.toLowerCase().endsWith('.webm')).slice(0, 120);
    const items = await Promise.all(list.map(async (x) => ({ name: x.prompt.slice(0, 40), data: S.img.thumbs[x.path] || (S.img.thumbs[x.path] = await invoke('read_image', { path: x.path }).catch(() => '')) })));
    openViewer(items, Math.max(0, list.findIndex((x) => x.path === r.path)));
  },
  copyGenPrompt: (d) => {
    const r = recByPath(d.path);
    if (r) navigator.clipboard.writeText(r.prompt).then(() => toast('已复制提示词'));
  },
  reuseGen: (d) => {
    const r = recByPath(d.path);
    if (!r) return;
    const kind = r.kind || 'image';
    const f = imgForm(kind);
    f.prompt = r.prompt;
    f.negative = r.negative_prompt || '';
    f.seed = String(r.seed);
    f.steps = r.steps;
    const sz = (kind === 'video' ? VID_SIZES : IMG_SIZES).find((x) => x[1] === r.width && x[2] === r.height);
    if (sz) {
      f.size = sz[0];
      if (kind !== 'video') f.res = '1K';
    } else if (kind !== 'video') {
      // 2K / 4K / 自定义尺寸：按原尺寸用自定义
      f.res = 'custom';
      f.cw = r.width;
      f.ch = r.height;
    }
    if (kind === 'video' && r.fps) f.secs = Math.max(1, Math.round(r.frames / r.fps));
    saveImgForm(kind);
    if (d.open) {
      go(kind);
      return toast('已填入它的提示词和种子，可以调整后重新生成');
    }
    render();
    toast('已填入它的提示词和种子');
  },
  toggleChatMedia: (d) => {
    S.chatMedia = S.chatMedia === d.k ? '' : d.k;
    if (S.chatMedia) loadImageData();
    render();
    $('#msgInput')?.focus();
  },
  delGen: async (d) => {
    const r = recByPath(d.path);
    if (!r || !confirm('删除这个作品？（电脑上的文件也会删除）')) return;
    await call('delete_image', { path: r.path });
    S.img.history = S.img.history.filter((x) => x.path !== r.path);
    render();
    fillThumbs();
  },
});

listen('image-progress', (e) => {
  S.img.progress = e.payload;
  refreshImgStatus();
  chatJobRefresh();
});

// ================================================================== 在对话里直接画图 / 生成视频（像 ChatGPT 一样）
// 输入框下方有「画图」「视频」两个开关；不开开关时，也会识别「画一只猫」「生成一段视频」这类请求。
// 生成前用正在运行的对话模型把需求改写成提示词，然后暂停对话模型让出显存；下次发普通消息时自动重新启动。
S.chatMedia = ''; // '' / image / video
S.pausedChat = null; // 为了画图暂停的对话模型路径
S.img.chatJob = null; // { chatId, mi }

const MEDIA_ASK = /(能|会|可以|支持|怎么|如何|怎样)(画图|画画|生成图片|生成视频|做视频|画)/;
const IMG_VERB = /((^|[，,。！!\s帮我给请你来先再])画(?!面|质|家|展|册|廊|风|作品|布|板|笔)|绘制|生成|制作|创作|设计|渲染|做|出)[^，。！？?\n]{0,14}(图|图片|照片|插画|海报|壁纸|头像|logo|表情包|封面|插图|漫画|写真|肖像|画)/i;
const IMG_START = /^(请|帮我|给我|你|再|来)?(画|绘)(一|个|张|幅|只|条|朵|座|位|下|出|些|两|几|副|个)/;
const IMG_EN = /\b(draw|paint|generate|create|make|render)\b[^.?!]{0,40}\b(image|picture|photo|illustration|poster|wallpaper|portrait|logo|painting)s?\b|^\s*draw (a|an|me)\b/i;
const IMG_NEG = /(这张|这幅|这个图|图中|图里|上面|附件|图表|流程图|思维导图|架构图|示意图|结构图|拓扑图|折线|柱状|饼图|甘特|代码|表格|脚本|python|html|svg|css|javascript|mermaid|plantuml|excel|ppt|word|教程|提示词|prompt|软件|工具|网站|推荐|文案|方案|原理|是什么|为什么|区别|意思)/i;
const VID_VERB = /(生成|制作|创作|渲染|做|拍|来|变成|转成|做成)[^，。！？?\n]{0,14}(视频|动画|短片|动图)|动起来/;
const EDIT_VERB = /(改|换|变|去掉|去除|删掉|删除|移除|擦掉|抹掉|加上|加个|加一|添加|增加|放上|调|修|抠|替换|上色|风格|背景|衣服|发型|颜色|美颜|瘦|胖|修复|清晰|水印|[Pp]图|[Pp]掉|戴上|穿上|拿着|更亮|更暗|亮一点|暗一点)/;
const EDIT_ASK = /(是什么|写了什么|写的什么|多少|识别|看看|看下|看一下|分析|描述|翻译|总结|提取|哪|怎么|如何|为什么|解释|告诉我|能不能|可以吗|吗[？?]?$|[？?])/;
const VID_NEG = /(文案|脚本|剧本|分镜|方案|标题|大纲|剪辑|代码|教程|推荐|软件|工具|网站|总结|字幕|下载|是什么|为什么|区别)/;

/** 这句话是不是要画图 / 改图 / 生成视频？返回 image / edit / video / ''。lastImage = 上一条回复是刚画的图 */
function detectMediaIntent(text, atts = [], lastImage = false) {
  const t = text.trim();
  if (/^\/(改图|改|edit)(\s|$)/i.test(t)) return 'edit';
  if (/^\/(画|图|image|img|draw)(\s|$)/i.test(t)) return 'image';
  if (/^\/(视频|video)(\s|$)/i.test(t)) return 'video';
  if (!t || t.length > 300 || MEDIA_ASK.test(t) && /吗|？|\?/.test(t)) return '';
  if (atts.some((a) => a.kind === 'text')) return '';
  const hasImg = atts.some((a) => a.kind === 'image');
  if (VID_VERB.test(t) && !VID_NEG.test(t)) return 'video';
  // 带了图片：说的是怎么改它就是改图，否则多半是问图片内容
  if (hasImg) return EDIT_VERB.test(t) && !EDIT_ASK.test(t) ? 'edit' : '';
  // 刚画完一张图，接着说「把背景换成…」：在上一张的基础上改（「再画一张」还是重新画）
  if (lastImage && t.length <= 80 && EDIT_VERB.test(t) && !EDIT_ASK.test(t) && !IMG_NEG.test(t) && !/^(请|你)?(再|重新|另外)(画|来|生成|做)/.test(t)) return 'edit';
  if ((IMG_START.test(t) || IMG_VERB.test(t) || IMG_EN.test(t)) && !IMG_NEG.test(t)) return 'image';
  return '';
}

const lastMediaPrompt = (c, kind) => {
  for (let i = c.messages.length - 1; i >= 0; i--) {
    const m = c.messages[i].media;
    if (m && m.prompt && (!kind || m.kind === kind)) return m.prompt;
  }
  return '';
};
const stripCmd = (t) => t.replace(/^\/(改图|改|edit|画|图|image|img|draw|视频|video)\s*/i, '').trim();
// 这个对话里最近一张画好的图（要接着改它）
function lastChatImage(c) {
  if (!c) return '';
  for (let i = c.messages.length - 1; i >= 0; i--) {
    const m = c.messages[i];
    if (m.role === 'assistant' && m.media) return m.media.kind === 'image' && m.media.status === 'done' && m.media.items?.length ? m.media.items[0] : '';
    if (m.role === 'assistant' && m.content) return '';
  }
  return '';
}

/** 用对话模型把需求改写成提示词（模型没在运行就直接用原话） */
async function rewriteMediaPrompt(kind, text, prev, english, edit = false, join = false) {
  const raw = stripCmd(text)
    .replace(/[，,。\s]*(画|生成|来|做)?\s*[1-4一两二三四几]\s*(张|幅|个版本)[，,。]?/g, '')
    .replace(/[，,。\s]*\d+\s*秒(钟)?(的)?/g, '')
    .replace(/^(请|麻烦)?(你)?(帮我|给我|帮忙|再)?(画|绘制|生成|制作|做)(一|个|张|幅|段|部|条|只)*(图片|图|视频)?[，,：:]?/, '')
    .trim() || stripCmd(text);
  const fallback = prev && (join || /^(再|换|改|把它|把这|继续|同样|一样|还是|背景|颜色|风格)/.test(raw)) ? `${prev}，${raw}` : raw;
  if (edit) prev = '';
  if (!srcReady()) return edit ? stripCmd(text) : fallback;
  const sys = edit ? [
    '你是图片编辑指令助手。用户要修改一张已有的图片，把他的要求改写成一句清晰、具体的图片编辑指令：只说要改什么、改成什么样，其余部分保持不变，不要描述整张图，不超过 60 字。',
    english ? '指令必须用英文。' : '指令用中文。',
    '用户要求图里出现的文字原样保留。只输出指令本身，不要解释，不要加引号或前缀。',
  ].join('\n') : [
    kind === 'video'
      ? '你是视频生成提示词助手。把用户的需求改写成一段给文生视频模型用的提示词：写清主体、动作、场景、镜头运动、光线和风格，60 到 120 字。'
      : '你是画图提示词助手。把用户的需求改写成一段给文生图模型用的提示词：写清主体、场景、构图、风格、光线和细节，50 到 120 字。',
    english ? '提示词必须用英文。' : '提示词用中文。',
    '如果用户要的是在上一张基础上修改，就在上一次的提示词上改。用户要求画面里出现的文字原样保留。',
    '只输出提示词本身，不要解释，不要加引号或前缀。',
  ].join('\n');
  const user = (prev ? `上一次的提示词：${prev}\n\n` : '') + `用户的需求：${raw}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 40000);
  try {
    let out = await llmComplete([{ role: 'system', content: sys }, { role: 'user', content: user }], { signal: ctl.signal });
    out = out.replace(/^(提示词|指令|编辑指令|prompt|instruction)\s*[:：]\s*/i, '').replace(/^["“「]|["”」]$/g, '').trim();
    return out.length >= 2 && out.length < 1500 ? out : edit ? stripCmd(text) : fallback;
  } catch {
    return edit ? stripCmd(text) : fallback;
  } finally {
    clearTimeout(timer);
  }
}

/** 从用户的话里猜尺寸、张数、时长 */
function mediaOptions(kind, text, m) {
  const f = imgForm(kind);
  const o = {};
  if (kind === 'image') {
    let size = f.size;
    if (/9[:：比]16|竖屏|手机壁纸|手机屏保|竖版|竖图|竖着/.test(text)) size = '9:16';
    else if (/16[:：比]9|横屏|电脑壁纸|桌面壁纸|横版|横图|宽屏|banner|封面图/i.test(text)) size = '16:9';
    else if (/3[:：比]4|海报/.test(text)) size = '3:4';
    else if (/4[:：比]3/.test(text)) size = '4:3';
    else if (/1[:：比]1|方图|正方形|头像|logo|表情包/i.test(text)) size = '1:1';
    const [, w, h] = IMG_SIZES.find((x) => x[0] === size) || IMG_SIZES[0];
    const cn = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 几: 2 };
    const cm = text.match(/([1-4一两二三四几])\s*(张|幅|个版本|种)/);
    o.count = cm ? cn[cm[1]] || +cm[1] || 1 : 1;
    Object.assign(o, { w, h, size });
  } else {
    const list = VID_SIZES.filter((s) => !s[3] || m.hd);
    let size = list.some((s) => s[0] === f.size) ? f.size : list[0][0];
    const p720 = /720|高清/.test(text) && m.hd;
    if (/竖屏|竖版|竖着|手机|抖音|9[:：比]16/.test(text)) size = p720 ? '竖屏 720P' : '竖屏 480P';
    else if (/横屏|横版|16[:：比]9/.test(text) || p720) size = p720 ? '横屏 720P' : '横屏 480P';
    const [, w, h] = VID_SIZES.find((x) => x[0] === size) || list[0];
    const sm = text.match(/(\d+)\s*秒/);
    const secs = vidSecsOf(sm ? +sm[1] : +f.secs || 2);
    Object.assign(o, { w, h, size, secs, frames: vidFrames(m.fps, secs) });
  }
  return o;
}

// 图片 → 保持比例、最长边不超过 max 的 JPEG（白底，去掉透明通道）
async function toJpeg(dataUrl, max) {
  try {
    const img = new Image();
    await new Promise((ok, bad) => { img.onload = ok; img.onerror = bad; img.src = dataUrl; });
    const s = Math.min(1, max / Math.max(img.width, img.height));
    const w = Math.max(8, Math.round((img.width * s) / 8) * 8), h = Math.max(8, Math.round((img.height * s) / 8) * 8);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    return c.toDataURL('image/jpeg', 0.92);
  } catch {
    return '';
  }
}

// 参考图片 → 视频尺寸的 JPEG（引擎要求 3 通道、和视频同尺寸）
async function fitImage(dataUrl, w, h) {
  const img = new Image();
  await new Promise((ok, bad) => { img.onload = ok; img.onerror = bad; img.src = dataUrl; });
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  const s = Math.max(w / img.width, h / img.height);
  ctx.drawImage(img, (w - img.width * s) / 2, (h - img.height * s) / 2, img.width * s, img.height * s);
  return c.toDataURL('image/jpeg', 0.92);
}

function chatJobRefresh() {
  const j = S.img.chatJob;
  if (j && S.page === 'chat' && S.chatId === j.chatId) updateStreamingMessage(j.mi);
}

/** 对话里发出一条画图 / 改图 / 生成视频的请求（kind = image / edit / video） */
async function sendMediaMessage(kind, text) {
  const edit = kind === 'edit';
  if (edit) kind = 'image';
  const word = edit ? '改图' : KIND_WORD[kind];
  const c = curChat();
  const atts = S.pending.splice(0);
  // 改图的原图：这次附上的图片，没有就用对话里刚画的那张
  const srcAtt = edit ? atts.find((a) => a.kind === 'image') : null;
  const srcPath = edit && !srcAtt ? lastChatImage(c) : '';
  const user = { role: 'user', content: text, attachments: atts };
  c.messages.push(user);
  if (c.messages.length === 1) c.title = stripCmd(text).slice(0, 24) || word;
  $('#msgInput').value = '';
  const media = { kind, mode: edit ? 'edit' : '', status: 'prep', prompt: '', model: '', items: [], note: '', error: '' };
  const ai = { role: 'assistant', content: '', media, done: false };
  c.messages.push(ai);
  const mi = c.messages.length - 1;
  S.img.chatJob = { chatId: c.id, mi };
  S.streaming = true;
  S.abort = new AbortController();
  const aborted = () => S.abort?.signal.aborted;
  render();
  $('#msgs') && ($('#msgs').scrollTop = 1e9);
  const timer = setInterval(chatJobRefresh, 1000);
  const notes = [];
  try {
    await loadImageData(true);
    const f = imgForm(kind);
    const inst = installedImageModels(kind);
    let pick;
    let srcData = '';
    if (edit) {
      srcData = srcAtt ? (await fullSrc(srcAtt)).src : srcPath ? await invoke('read_image', { path: srcPath }).catch(() => '') : '';
      if (!srcData) throw new Error('没找到要修改的图片：请把图片拖进输入框，再说怎么改');
      media.srcThumb = (await makeThumb(srcData, 240)) || '';
      // 优先用改图模型；没有就用普通画图模型「按原图重画」
      const edits = inst.filter((x) => x.m.edit);
      // 已经加载着的改图模型 → 画图页选的 → Qwen-Image-Edit（中文指令最准）→ 其他
      const loaded = S.img.status?.running && edits.find((x) => x.m.id === S.img.status.model && x.q.quant === S.img.status.quant);
      pick = loaded || edits.find((x) => x.key === f.model) || edits.find((x) => x.m.id === 'qwen-image-edit') || edits[0];
      if (!pick) {
        pick = inst.find((x) => !x.m.edit_only && x.key === f.model) || inst.find((x) => !x.m.edit_only);
        if (pick) {
          media.mode = 'redraw';
          notes.push(`还没有改图模型，这次是在原图基础上重画，细节会有变化。${editModelHint}。`);
        }
      }
    } else {
      const usable = inst.filter((x) => !x.m.edit_only);
      pick = usable.find((x) => x.key === f.model) || usable[0];
    }
    if (S.img.engine === null || !pick) {
      media.status = 'nomodel';
      return;
    }
    if (S.img.busy) throw new Error(`「${KIND_WORD[S.img.busyKind] || '画图'}」页正在生成，等它完成再试`);
    // 带了图片要做视频时，优先能「图生视频」的模型
    const refImg = kind === 'video' ? atts.find((a) => a.kind === 'image') : null;
    if (refImg && !pick.m.i2v) {
      const alt = inst.find((x) => x.m.i2v);
      if (alt) pick = alt;
      else notes.push('已下载的视频模型不支持参考图片，这次只按文字生成（Wan2.2、LTX-2.3、MiniMax-H3 都支持让图片动起来）。');
    }
    // 只能图生视频的模型（Wan2.2 A14B），没给图片时换一个能文生视频的
    if (kind === 'video' && !refImg && pick.m.edit_only) {
      const alt = inst.find((x) => !x.m.edit_only);
      if (!alt) throw new Error(`${pick.m.name} 需要一张图片当第一帧：把图片拖进输入框，再说怎么动`);
      pick = alt;
    }
    const m = pick.m;
    media.model = `${m.name} · ${qName(pick.q.quant)}`;
    const english = m.id.startsWith('flux');
    // 1. 改写提示词（用还在运行的对话模型）
    media.status = 'prompt';
    chatJobRefresh();
    // 重画：以原图（如果是这里画的）的提示词为底，加上修改要求
    const prev = media.mode === 'redraw' ? (srcPath && recByPath(srcPath)?.prompt) || '' : lastMediaPrompt(c, kind);
    media.prompt = await rewriteMediaPrompt(kind, text, prev, english, media.mode === 'edit', media.mode === 'redraw');
    if (english && !srcReady() && /[\u4e00-\u9fa5]/.test(media.prompt)) notes.push(`${m.name} 对英文${media.mode === 'edit' ? '指令' : '提示词'}效果最好；先启动一个对话模型可以自动翻译。`);
    if (aborted()) throw new DOMException('aborted', 'AbortError');
    let o;
    let ref = null;
    if (edit) {
      const r = await prepRef(srcData);
      ref = r.data;
      o = { w: r.w, h: r.h, count: 1 };
    } else {
      o = mediaOptions(kind, text, m);
    }
    Object.assign(media, { w: o.w, h: o.h, secs: o.secs, count: o.count });
    // 2. 暂停对话模型，加载画图模型
    const st = S.img.status || {};
    if (!(st.running && st.ready && st.model === m.id && st.quant === pick.q.quant)) {
      if (S.server.running) {
        S.pausedChat = S.server.model_path || S.run.path;
        notes.push(usingApi() ? `本地对话模型已暂停，把显存让给${kind === 'video' ? '视频模型' : '画图模型'}（现在对话用的是第三方 API，不受影响）。` : `对话模型已暂停，把显存让给${kind === 'video' ? '视频模型' : '画图模型'}；直接发下一条消息会自动重新启动。`);
      }
      media.status = 'loading';
      S.img.busy = 'loading';
      S.img.busyKind = kind;
      S.img.t0 = Date.now();
      chatJobRefresh();
      S.img.status = await invoke('start_image', { id: m.id, quant: pick.q.quant });
      S.server = await invoke('server_status');
    }
    if (aborted()) throw new DOMException('aborted', 'AbortError');
    // 3. 生成
    media.status = 'generating';
    S.img.busy = 'generating';
    S.img.busyKind = kind;
    S.img.progress = null;
    S.img.t0 = media.t0 = Date.now();
    render();
    let recs;
    if (kind === 'video') {
      const init = refImg && pick.m.i2v ? await fitImage((await fullSrc(refImg)).src, o.w, o.h).catch(() => null) : null;
      recs = await invoke('generate_video', { req: { prompt: media.prompt, negative_prompt: (f.negative || '').trim(), width: o.w, height: o.h, steps: m.steps, frames: o.frames, seed: -1, init_image: init } });
    } else {
      recs = await invoke('generate_image', { req: { prompt: media.prompt, negative_prompt: edit ? '' : (f.negative || '').trim(), width: o.w, height: o.h, steps: m.steps, cfg_scale: m.cfg, seed: -1, count: o.count, ref_image: ref, strength: 0.6 } });
    }
    S.img.history = [...recs, ...(S.img.history || [])];
    media.items = recs.map((r) => r.path);
    media.secsUsed = recs[0]?.secs;
    media.status = 'done';
  } catch (e) {
    if (e?.name === 'AbortError' || aborted()) {
      media.status = 'cancelled';
    } else {
      media.status = 'error';
      media.error = String(e?.message || e).split('\n').slice(0, 6).join('\n');
    }
  } finally {
    clearInterval(timer);
    media.note = notes.join('\n');
    if (S.img.busy) S.img.busy = '';
    S.img.progress = null;
    S.img.chatJob = null;
    S.img.status = await invoke('image_status').catch(() => ({}));
    S.server = await invoke('server_status').catch(() => S.server);
    ai.done = true;
    S.streaming = false;
    S.abort = null;
    saveChats();
    render();
    const box = $('#msgs');
    if (box) box.scrollTop = box.scrollHeight;
  }
}

// 点 ■：视频走取消接口；图片没有取消接口，直接停掉画图引擎
async function stopChatMedia() {
  const j = S.img.chatJob;
  S.abort?.abort();
  if (!j) return;
  const msg = S.chats.find((x) => x.id === j.chatId)?.messages[j.mi];
  if (!msg?.media) return;
  if (msg.media.kind === 'video' && msg.media.status === 'generating') await invoke('cancel_video').catch(() => {});
  else if (msg.media.status === 'loading' || msg.media.status === 'generating') {
    await invoke('stop_image').catch(() => {});
    S.img.status = {};
  }
}

/** 对话被暂停（让显存给画图）后，再发普通消息时自动重新启动 */
async function resumePausedChat() {
  if (S.server.ready || !S.pausedChat) return S.server.ready;
  toast('正在重新启动对话模型…', 8000);
  S.run.path = S.pausedChat;
  S.resuming = true;
  render();
  try {
    await actions.startModel();
  } finally {
    S.resuming = false;
  }
  if (S.server.ready) S.pausedChat = null;
  if (S.page !== 'chat') go('chat');
  else render();
  return S.server.ready;
}

/** 对话里的图片 / 视频消息 */
function chatMediaHtml(msg) {
  const md = msg.media;
  const isEdit = !!md.mode;
  const word = isEdit ? '改图' : KIND_WORD[md.kind];
  const video = md.kind === 'video';
  const live = !msg.done;
  const elapsed = md.t0 ? Math.round((Date.now() - md.t0) / 1000) : 0;
  let body = '';
  if (md.status === 'nomodel') {
    const e = S.img.engine;
    body = `<div class="cm-note">还没有${word}模型${e === null ? '，也还没装画图引擎' : ''}。下载一个就能直接在对话里${video ? '生成视频' : isEdit ? '改图' : '画图'}了（按你的显卡推荐）：</div>
      ${e === null ? imgEngineNotice() : ''}${S.img.catalog ? imgNoModel(md.kind, isEdit) : ''}`;
  } else if (md.status === 'prep' || md.status === 'prompt') {
    body = `<div class="img-st"><span class="qp-spin"></span>${md.status === 'prompt' ? (isEdit ? '正在理解你要怎么改…' : '正在理解你的需求，整理提示词…') : '准备中…'}</div>`;
  } else if (md.status === 'loading') {
    body = `<div class="img-st"><span class="qp-spin"></span>正在加载${md.model ? esc(md.model) : `${word}模型`}…（第一次要几十秒）</div>`;
  } else if (md.status === 'generating') {
    const p = S.img.progress;
    const pct = p && p[1] ? Math.round((p[0] / p[1]) * 100) : 0;
    const box = `aspect-ratio:${md.w || 1}/${md.h || 1}`;
    body = `<div class="cm-wait ${(md.h || 1) > (md.w || 1) ? 'portrait' : ''}" style="${box}"><div><span class="qp-spin"></span><div>${video ? '正在生成视频' : md.mode === 'edit' ? '正在修改图片' : md.mode === 'redraw' ? '正在按原图重画' : `正在画${md.count > 1 ? ` ${md.count} 张` : ''}`}… ${p ? `第 ${p[0]}/${p[1]} 步 · ` : ''}${fmtSecs(elapsed)}</div>${p ? `<div class="cm-bar"><i style="width:${pct}%"></i></div>` : ''}${video ? '<div class="muted" style="font-size:12px;margin-top:4px">视频比较慢，一般要几分钟</div>' : ''}</div></div>`;
  } else if (md.status === 'done' && !S.img.history) {
    if (!S.img.histLoading) {
      S.img.histLoading = true;
      loadImageData().then(() => { S.img.histLoading = false; render(); });
    }
    body = '<div class="img-st"><span class="qp-spin"></span>读取中…</div>';
  } else if (md.status === 'done') {
    const portrait = (md.h || 1) > (md.w || 1);
    body = `<div class="cm-grid ${md.items.length > 1 ? 'multi' : ''} ${portrait ? 'portrait' : ''}">${md.items
      .map((p) => {
        const r = recByPath(p);
        const src = S.img.thumbs[p];
        const isVid = p.toLowerCase().endsWith('.webm');
        if (!r) return `<div class="cm-gone">${isVid ? '视频' : '图片'}已删除</div>`;
        const el = isVid ? `<video data-path="${esc(p)}" ${src ? `src="${src}"` : ''} muted loop autoplay playsinline></video>` : `<img data-path="${esc(p)}" alt="" ${src ? `src="${src}"` : ''}>`;
        return `<div class="img-thumb" data-act="viewGen" data-path="${esc(p)}" style="aspect-ratio:${r.width}/${r.height}">${el}${isVid ? '<span class="vid-badge">▶</span>' : ''}</div>`;
      })
      .join('')}</div>`;
  } else if (md.status === 'cancelled') {
    body = '<div class="cm-note muted">已停止</div>';
  } else if (md.status === 'error') {
    body = `<div class="img-err">${esc(md.error)}</div>`;
  }
  const first = md.items?.[0];
  const acts = md.status === 'done' && first && recByPath(first)
    ? `<span class="cm-acts"><a href="#" data-act="reuseGen" data-path="${esc(first)}" data-open="1">在${video ? '视频' : '画图'}页调整</a><a href="#" data-act="copyGenPrompt" data-path="${esc(first)}">复制提示词</a><a href="#" data-act="openImagesDir">打开文件夹</a></span>`
    : '';
  const meta = md.model && md.status !== 'nomodel'
    ? `<div class="m-meta">${esc(md.model)}${md.w ? ` · ${md.w}×${md.h}` : ''}${video && md.secs ? ` · ${md.secs} 秒` : ''}${md.secsUsed ? ` · 用时 ${fmtSecs(md.secsUsed)}` : ''}${acts}</div>`
    : '';
  const prompt = md.prompt ? `<details class="think cm-prompt"><summary>${md.mode === 'edit' ? '修改指令' : '提示词'}</summary><div>${esc(md.prompt)}</div></details>` : '';
  const src = md.srcThumb && md.status !== 'nomodel' ? `<div class="cm-src"><img src="${md.srcThumb}" alt="原图"><span>原图</span></div>` : '';
  const note = md.note && !live ? `<div class="cm-tip">${esc(md.note).replace(/\n/g, '<br>')}</div>` : '';
  return `<div class="cm">${prompt}${src}${body}${note}${meta}</div>`;
}
