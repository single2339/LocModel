// 画图页的「无限画布」模式：
//   - 图片（上传的、生成的）摆在一块可以无限拖动、缩放的画布上
//   - 上传：点「上传图片」可多选，或把图片拖进窗口、Ctrl+V 粘贴
//   - 选中一张或多张图（Shift 多选）当参考，在下方写一句话生成；改图模型（Qwen-Image-Edit、FLUX.2 klein）能同时参考多张图
//   - 生成的图放在参考图右边，什么都没选就放在画布中间
//   - 画布内容（图片路径和位置）存在本机，下次打开还在；从画布上移除不会删除电脑上的文件
(function () {
  const KEY = 'canvasBoard';
  const ITEM_W = 320;

  function load() {
    try {
      const v = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (v && Array.isArray(v.items)) return { items: v.items, view: v.view || { x: 60, y: 40, z: 1 }, sel: [] };
    } catch {}
    return { items: [], view: { x: 60, y: 40, z: 1 }, sel: [] };
  }
  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify({ items: cv().items, view: cv().view }));
    } catch {}
  }
  function cv() {
    if (!S.cv) S.cv = load();
    return S.cv;
  }
  window.canvasState = cv;
  try {
    S.img.mode = localStorage.getItem('imgMode') === 'canvas' ? 'canvas' : 'form';
  } catch {}

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const board = () => document.getElementById('cvBoard');
  const layer = () => document.getElementById('cvLayer');
  const applyView = () => {
    const v = cv().view;
    const l = layer();
    if (l) l.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.z})`;
    const z = document.getElementById('cvZoom');
    if (z) z.textContent = `${Math.round(v.z * 100)}%`;
    const b = board();
    if (b) b.style.backgroundPosition = `${v.x}px ${v.y}px`;
    if (b) b.style.backgroundSize = `${24 * v.z}px ${24 * v.z}px`;
  };
  // 屏幕坐标 → 画布坐标
  function toWorld(cx, cy) {
    const b = board();
    const r = b ? b.getBoundingClientRect() : { left: 0, top: 0 };
    const v = cv().view;
    return { x: (cx - r.left - v.x) / v.z, y: (cy - r.top - v.y) / v.z };
  }
  function viewCenter() {
    const b = board();
    if (!b) return { x: 200, y: 200 };
    const r = b.getBoundingClientRect();
    return toWorld(r.left + r.width / 2, r.top + r.height / 2.4);
  }

  // 读图片尺寸（显示时按比例）
  async function dims(path) {
    const src = S.img.thumbs[path] || (S.img.thumbs[path] = await invoke('read_image', { path }).catch(() => ''));
    if (!src) return null;
    const img = new Image();
    await new Promise((ok) => { img.onload = ok; img.onerror = ok; img.src = src; });
    return img.width ? { w: img.width, h: img.height } : null;
  }

  // 把几张图依次放到 (x, y) 开始的一排
  async function addPaths(paths, at, extra = {}) {
    const c = cv();
    let x = at.x;
    const added = [];
    for (const p of paths) {
      const d = await dims(p);
      if (!d) continue;
      const w = ITEM_W;
      const h = Math.round((ITEM_W * d.h) / d.w);
      const it = { id: uid(), path: p, x: Math.round(x), y: Math.round(at.y), w, h, ...extra };
      c.items.push(it);
      added.push(it.id);
      x += w + 24;
    }
    if (added.length) {
      c.sel = added;
      save();
      render();
    }
    return added;
  }
  window.canvasAddPaths = (paths, clientPos) => {
    const at = clientPos ? toWorld(clientPos.x, clientPos.y) : viewCenter();
    return addPaths(paths, { x: at.x - ITEM_W / 2, y: at.y - 120 });
  };

  // ---------------------------------------------------------------- 页面
  window.pageCanvas = function (head, inst, f, cur) {
    const c = cv();
    const opts = inst.map((x) => `<option value="${esc(x.key)}" ${x.key === f.model ? 'selected' : ''}>${esc(x.m.name)} · ${esc(qName(x.q.quant))}${x.m.edit_only ? '（只能改图）' : x.m.edit ? '（能画也能改图）' : ''}</option>`).join('');
    const selItems = c.items.filter((x) => c.sel.includes(x.id));
    const items = c.items
      .map(
        (it) => `<div class="cv-item ${c.sel.includes(it.id) ? 'on' : ''}" data-cv="${it.id}" style="left:${it.x}px;top:${it.y}px;width:${it.w}px;height:${it.h}px">
        <img data-cvpath="${esc(it.path)}" alt="" draggable="false">
        ${it.prompt ? `<div class="cv-cap" title="${esc(it.prompt)}" data-noi18n>${esc(it.prompt)}</div>` : ''}
        <button class="cv-x" data-act="cvRemove" data-id="${it.id}" title="从画布上移除（不删除文件）" aria-label="从画布上移除">✕</button>
      </div>`,
      )
      .join('');
    const busy = S.img.busy && S.img.busyKind === 'image';
    const pend = busy && c.pending ? `<div class="cv-item cv-pending" style="left:${c.pending.x}px;top:${c.pending.y}px;width:${c.pending.w}px;height:${c.pending.h}px"><span class="spin" aria-hidden="true"></span><span>生成中…</span></div>` : '';
    const refNote = selItems.length
      ? cur.m.edit
        ? `参考选中的 ${selItems.length} 张图${selItems.length > 4 ? '（最多用前 4 张）' : ''}，例如：把图 1 的人放进图 2 的场景里`
        : `当前模型只能用选中的第 1 张图做底稿重画；想同时参考多张图，请用「Qwen-Image-Edit」或「FLUX.2 klein」`
      : cur.m.edit_only
        ? '这个模型只能改图：先在画布上点选一张或多张图'
        : '没有选中图片：直接按描述生成新图（点选图片可以当参考，Shift 多选）';
    const needRef = cur.m.edit_only && !selItems.length;
    const btn = busy
      ? '<button class="btn lg" data-act="stopImage">停止</button>'
      : `<button class="btn primary lg" data-act="cvGenerate" ${f.prompt.trim() && !needRef && !(S.img.busy && S.img.busyKind !== 'image') ? '' : 'disabled'}>${selItems.length && cur.m.edit ? '按参考图生成' : '生成'}</button>`;
    return `<div class="page img-page cv-page">${head}
      <div class="cv-wrap">
        <div class="cv-board" id="cvBoard" tabindex="0" aria-label="画布">
          <div class="cv-layer" id="cvLayer" style="transform:translate(${c.view.x}px,${c.view.y}px) scale(${c.view.z})">${items}${pend}</div>
          ${c.items.length || pend ? '' : `<div class="cv-empty"><div style="font-size:36px">🖼️</div><div>把图片拖进来、Ctrl+V 粘贴，或点左上角「上传图片」</div><div class="muted">也可以直接在下面写一句话生成。点选图片当参考（Shift 多选），拖动空白处移动画布，滚轮缩放</div></div>`}
          <div class="cv-tools">
            <button class="btn sm" data-act="cvUpload">上传图片</button>
            <button class="btn sm" data-act="cvFit" title="显示全部图片">适应窗口</button>
            <button class="btn sm" data-act="cvZoomReset" title="缩放到 100%"><span id="cvZoom">${Math.round(c.view.z * 100)}%</span></button>
            ${c.sel.length ? `<button class="btn sm" data-act="cvRemoveSel">移除选中（${c.sel.length}）</button>` : ''}
          </div>
        </div>
        <div class="cv-bar card">
          <div class="cv-ref muted">${refNote}</div>
          <textarea class="input" id="cvPrompt" data-imgf="prompt" rows="2" placeholder="${selItems.length ? '例如：把背景换成海边 / 把图 1 的人放进图 2 的场景里' : '例如：一只橘猫在樱花树下睡觉，阳光透过花瓣，水彩风格'}">${esc(f.prompt)}</textarea>
          <div class="cv-row">
            <select class="input" id="imgModel" data-change="imgModel" style="flex:1;min-width:0">${opts}</select>
            ${selItems.length ? '' : `<select class="input" data-change="cvSize" style="width:92px" title="画面比例">${IMG_SIZES.map(([k]) => `<option ${f.size === k ? 'selected' : ''}>${k}</option>`).join('')}</select>`}
            <select class="input" data-change="imgCount" style="width:76px" title="张数">${[1, 2, 3, 4].map((n) => `<option value="${n}" ${+f.count === n ? 'selected' : ''}>${n} 张</option>`).join('')}</select>
            ${btn}
          </div>
          <div id="imgStatus">${imgStatusHtml('image')}</div>
        </div>
      </div>
    </div>`;
  };

  // 渲染后填图片（图片数据按路径缓存）
  async function fill() {
    for (const el of document.querySelectorAll('img[data-cvpath]')) {
      const p = el.dataset.cvpath;
      if (!S.img.thumbs[p]) {
        try {
          S.img.thumbs[p] = await invoke('read_image', { path: p });
        } catch {
          el.closest('.cv-item')?.classList.add('missing');
          continue;
        }
      }
      if (!el.getAttribute('src')) el.src = S.img.thumbs[p];
    }
    applyView();
  }
  const prevFill = window.fillThumbs;
  window.fillThumbs = async function () {
    if (typeof prevFill === 'function') await prevFill();
    if (document.getElementById('cvBoard')) await fill();
  };

  // ---------------------------------------------------------------- 生成
  async function generate() {
    const c = cv();
    const f = imgForm('image');
    const [id, quant] = f.model.split('|');
    const m = (S.img.catalog || []).find((x) => x.id === id);
    if (!m || !f.prompt.trim() || S.img.busy) return;
    if (S.server.running && !confirm('画图需要占用显存，先停止正在运行的对话模型吗？\n（完成以后可以在「运行」页重新启动）')) return;
    const sel = c.items.filter((x) => c.sel.includes(x.id));
    // 新图放在参考图右边；没有参考图就放在画布中间
    let at;
    if (sel.length) {
      const right = Math.max(...sel.map((x) => x.x + x.w));
      const top = Math.min(...sel.map((x) => x.y));
      at = { x: right + 48, y: top };
    } else {
      const v = viewCenter();
      at = { x: v.x - ITEM_W / 2, y: v.y - 160 };
    }
    S.img.error = '';
    S.img.errorKind = '';
    S.img.progress = null;
    S.img.busyKind = 'image';
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
      // 参考图：第一张决定画面比例；改图模型其余几张也一起送进去
      let [, w, h] = IMG_SIZES.find((x) => x[0] === f.size) || IMG_SIZES[0];
      let first = null;
      const rest = [];
      if (sel.length) {
        const srcs = await Promise.all(sel.slice(0, 4).map((x) => S.img.thumbs[x.path] || invoke('read_image', { path: x.path })));
        ({ w, h, data: first } = await prepRef(srcs[0]));
        if (m.edit) for (const s of srcs.slice(1)) rest.push(await toJpeg(s, 1024));
      }
      c.pending = { x: at.x, y: at.y, w: ITEM_W, h: Math.round((ITEM_W * h) / w) };
      S.img.busy = 'generating';
      S.img.t0 = Date.now();
      render();
      const steps = +f.steps || m.steps;
      const recs = await call('generate_image', {
        req: { prompt: f.prompt.trim(), negative_prompt: (f.negative || '').trim(), width: w, height: h, steps, cfg_scale: m.cfg, seed: -1, count: +f.count || 1, ref_image: first, ref_images: rest.filter(Boolean), strength: +f.strength || 0.6 },
      });
      S.img.history = [...recs, ...(S.img.history || [])];
      c.pending = null;
      await addPaths(recs.map((r) => r.path), at, { prompt: f.prompt.trim(), gen: true });
    } catch (e) {
      if (S.img.busy) {
        S.img.error = String(e).split('\n').slice(0, 14).join('\n');
        S.img.errorKind = 'image';
      }
    }
    c.pending = null;
    clearInterval(timer);
    S.img.busy = '';
    S.img.progress = null;
    S.img.status = await invoke('image_status').catch(() => ({}));
    render();
  }

  // ---------------------------------------------------------------- 操作
  Object.assign(actions, {
    imgMode: (d) => {
      S.img.mode = d.m === 'canvas' ? 'canvas' : 'form';
      try { localStorage.setItem('imgMode', S.img.mode); } catch {}
      render();
    },
    cvGenerate: () => generate(),
    cvUpload: async () => {
      const paths = await call('pick_image_files').catch(() => []);
      if (paths?.length) await window.canvasAddPaths(paths);
    },
    cvRemove: (d) => {
      const c = cv();
      c.items = c.items.filter((x) => x.id !== d.id);
      c.sel = c.sel.filter((x) => x !== d.id);
      save();
      render();
    },
    cvRemoveSel: () => {
      const c = cv();
      c.items = c.items.filter((x) => !c.sel.includes(x.id));
      c.sel = [];
      save();
      render();
    },
    cvZoomReset: () => zoomAt(1, null),
    cvFit: () => {
      const c = cv();
      const b = board();
      if (!b || !c.items.length) return;
      const r = b.getBoundingClientRect();
      const x0 = Math.min(...c.items.map((x) => x.x)), y0 = Math.min(...c.items.map((x) => x.y));
      const x1 = Math.max(...c.items.map((x) => x.x + x.w)), y1 = Math.max(...c.items.map((x) => x.y + x.h));
      const z = Math.max(0.1, Math.min(2, Math.min((r.width - 80) / (x1 - x0), (r.height - 200) / (y1 - y0))));
      c.view = { x: (r.width - (x1 - x0) * z) / 2 - x0 * z, y: 64 - y0 * z, z };
      applyView();
      save();
    },
  });
  Object.assign(changeHandlers, {
    cvSize: (el) => {
      imgForm('image').size = el.value;
      saveImgForm('image');
    },
  });

  function zoomAt(z, client) {
    const c = cv();
    const b = board();
    if (!b) return;
    const r = b.getBoundingClientRect();
    const cx = client ? client.x - r.left : r.width / 2;
    const cy = client ? client.y - r.top : r.height / 2;
    const v = c.view;
    const nz = Math.max(0.1, Math.min(4, z));
    v.x = cx - ((cx - v.x) * nz) / v.z;
    v.y = cy - ((cy - v.y) * nz) / v.z;
    v.z = nz;
    applyView();
    clearTimeout(zoomAt.t);
    zoomAt.t = setTimeout(save, 300);
  }

  // 拖动画布 / 拖动图片 / 点选
  let drag = null;
  document.addEventListener('pointerdown', (e) => {
    const b = e.target.closest?.('#cvBoard');
    if (!b || e.button === 2 || e.target.closest('button, .cv-tools')) return;
    const c = cv();
    const itemEl = e.target.closest('.cv-item[data-cv]');
    if (itemEl) {
      const id = itemEl.dataset.cv;
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        c.sel = c.sel.includes(id) ? c.sel.filter((x) => x !== id) : [...c.sel, id];
      } else if (!c.sel.includes(id)) {
        c.sel = [id];
      }
      const start = c.items.filter((x) => c.sel.includes(x.id)).map((x) => ({ it: x, x: x.x, y: x.y }));
      drag = { kind: 'item', sx: e.clientX, sy: e.clientY, start, moved: false, id, toggled: e.shiftKey || e.ctrlKey || e.metaKey };
      document.querySelectorAll('.cv-item[data-cv]').forEach((el) => el.classList.toggle('on', c.sel.includes(el.dataset.cv)));
    } else {
      drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: c.view.x, vy: c.view.y, moved: false };
      b.classList.add('panning');
    }
    b.setPointerCapture?.(e.pointerId);
    b.focus({ preventScroll: true });
  });
  document.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    const c = cv();
    if (drag.kind === 'pan') {
      c.view.x = drag.vx + dx;
      c.view.y = drag.vy + dy;
      applyView();
    } else if (drag.moved) {
      const z = c.view.z;
      for (const s of drag.start) {
        s.it.x = Math.round(s.x + dx / z);
        s.it.y = Math.round(s.y + dy / z);
        const el = document.querySelector(`.cv-item[data-cv="${s.it.id}"]`);
        if (el) {
          el.style.left = s.it.x + 'px';
          el.style.top = s.it.y + 'px';
        }
      }
    }
  });
  document.addEventListener('pointerup', () => {
    if (!drag) return;
    const d = drag;
    drag = null;
    board()?.classList.remove('panning');
    const c = cv();
    if (d.kind === 'pan') {
      if (!d.moved && c.sel.length) {
        c.sel = [];
        render();
      } else if (d.moved) save();
      return;
    }
    if (d.kind === 'item' && !d.moved && !d.toggled) c.sel = [d.id];
    save();
    render();
  });
  document.addEventListener(
    'wheel',
    (e) => {
      if (!e.target.closest?.('#cvBoard')) return;
      e.preventDefault();
      const c = cv();
      // 触控板双指滑动（没按 Ctrl）= 平移；鼠标滚轮 / 触控板捏合 = 缩放
      if (!e.ctrlKey && Math.abs(e.deltaX) > 0 && e.deltaMode === 0 && Math.abs(e.deltaY) < 40) {
        c.view.x -= e.deltaX;
        c.view.y -= e.deltaY;
        applyView();
        return;
      }
      zoomAt(c.view.z * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), { x: e.clientX, y: e.clientY });
    },
    { passive: false },
  );
  document.addEventListener('dblclick', async (e) => {
    const el = e.target.closest?.('.cv-item[data-cv]');
    if (!el) return;
    const it = cv().items.find((x) => x.id === el.dataset.cv);
    if (!it) return;
    const items = await Promise.all(cv().items.map(async (x) => ({ name: (x.prompt || '').slice(0, 40), data: S.img.thumbs[x.path] || (S.img.thumbs[x.path] = await invoke('read_image', { path: x.path }).catch(() => '')) })));
    openViewer(items.filter((x) => x.data), Math.max(0, cv().items.indexOf(it)));
  });
  document.addEventListener('keydown', (e) => {
    if (!document.getElementById('cvBoard') || e.target.closest?.('input, textarea, select')) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && cv().sel.length) {
      e.preventDefault();
      actions.cvRemoveSel();
    } else if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
      e.preventDefault();
      cv().sel = cv().items.map((x) => x.id);
      render();
    }
  });
  // 写描述时更新「生成」按钮能不能点（不整页重绘，免得打字卡）
  document.addEventListener('input', (e) => {
    if (e.target?.id !== 'cvPrompt') return;
    const b = document.querySelector('[data-act="cvGenerate"]');
    if (!b) return;
    const f = imgForm('image');
    const cur = installedImageModels('image').find((x) => x.key === f.model);
    const needRef = cur?.m.edit_only && !cv().sel.length;
    b.disabled = !e.target.value.trim() || needRef || (S.img.busy && S.img.busyKind !== 'image');
  });
  // 粘贴图片到画布
  document.addEventListener('paste', async (e) => {
    if (!document.getElementById('cvBoard') || e.target.closest?.('input, textarea')) return;
    const files = [...(e.clipboardData?.items || [])].filter((it) => it.kind === 'file' && it.type.startsWith('image/')).map((it) => it.getAsFile());
    if (!files.length) return;
    e.preventDefault();
    const paths = [];
    for (const file of files) {
      const data = await new Promise((ok) => { const rd = new FileReader(); rd.onload = () => ok(rd.result); rd.readAsDataURL(file); });
      try {
        paths.push(await call('save_upload_image', { data }));
      } catch {}
    }
    if (paths.length) await window.canvasAddPaths(paths);
  });
})();
