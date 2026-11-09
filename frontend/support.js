// 联系我们：用户在软件里提交工单、看客服回复（工单存在控制后台 get.locmodel.com）
// 直接从网页里请求后台 api.php（后台已允许跨域），不经过 Rust
(function () {
  const SP = { list: null, cats: {}, unread: 0, view: 'list', ticket: null, msgs: [], form: { category: 'run', contact: '', diag: true }, images: [], sending: false, err: '' };
  S.support = SP;

  const api = () => (S.settings?.account_base || 'https://get.locmodel.com').replace(/\/+$/, '') + '/api.php';
  const dev = () => S.settings?.device_id || '';

  async function apiGet(act, params = {}) {
    const q = new URLSearchParams({ act, device: dev(), ...params });
    const r = await fetch(`${api()}?${q}`, { cache: 'no-store' });
    const j = await r.json().catch(() => ({ ok: false, error: `服务器返回异常（HTTP ${r.status}）` }));
    if (j.ok === false) throw new Error(j.error || '请求失败');
    return j;
  }
  async function apiPost(act, fields, images = []) {
    const fd = new FormData();
    fd.append('device', dev());
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    images.forEach((d) => fd.append('images[]', d));
    const r = await fetch(`${api()}?act=${act}`, { method: 'POST', body: fd });
    const j = await r.json().catch(() => ({ ok: false, error: `服务器返回异常（HTTP ${r.status}）` }));
    if (!j.ok) throw new Error(j.error || '提交失败');
    return j;
  }

  // 自动附带的诊断信息：方便客服判断问题，不含对话内容
  async function diagnostics() {
    let ver = '';
    try { ver = await window.__TAURI__.app.getVersion(); } catch {}
    const hw = S.overview?.hardware;
    const g = hw?.gpus?.[hw.primary_gpu ?? -1];
    const lines = [
      `软件版本：${ver || '未知'}`,
      `系统：${navigator.userAgent.match(/Windows NT [\d.]+/)?.[0] || navigator.platform}`,
      `显卡：${g ? `${g.name}（${Math.round((g.vram_bytes || 0) / 2 ** 30)} GB，驱动 ${g.driver || '?'}，CUDA ${g.cuda_version || '-'}）` : '无独显'}`,
      hw ? `内存：${Math.round((hw.memory?.total_bytes || 0) / 2 ** 30)} GB · CPU：${hw.cpu?.name || ''}` : '',
      `推理引擎：${S.engine ? `${S.engine.tag} ${S.engine.variant}` : '未安装'}`,
      `网络：${S.net ? (S.net.hf_ok ? '能直连 HuggingFace' : '连不上 HuggingFace') : '未检测'}`,
      `加速通道：${S.accel?.member ? '已开启' + (S.accel.token ? `（令牌 ${S.accel.token}）` : '') : '未开启'}`,
      `模型：${S.server?.running ? S.server.model_name || '运行中' : '未运行'}`,
    ].filter(Boolean);
    const logs = (S.logs || []).slice(-60);
    if (logs.length) lines.push('', '最近的运行日志：', ...logs);
    return lines.join('\n');
  }

  async function refreshList(silent) {
    if (!dev()) return;
    try {
      const j = await apiGet('ticket_list');
      SP.list = j.tickets;
      SP.cats = j.categories || {};
      SP.unread = j.unread || 0;
      SP.err = '';
    } catch (e) {
      if (!silent) SP.err = '连不上服务器：' + e.message;
    }
    updateBadge();
    if (S.page === 'support' && SP.view === 'list') render();
  }

  async function openTicket(id) {
    SP.view = 'ticket';
    SP.ticket = { id };
    SP.msgs = [];
    render();
    try {
      const j = await apiGet('ticket_get', { id });
      SP.ticket = j.ticket;
      SP.msgs = j.messages;
      const t = SP.list?.find((x) => x.id === id);
      if (t && t.unread) {
        t.unread = false;
        SP.unread = Math.max(0, SP.unread - 1);
        updateBadge();
      }
    } catch (e) {
      toast(e.message);
      SP.view = 'list';
    }
    render();
    const box = $('#tkThread');
    if (box) box.scrollTop = box.scrollHeight;
  }

  function updateBadge() {
    const d = document.getElementById('support-dot');
    if (d) d.classList.toggle('hidden', !SP.unread);
  }

  const fmtTime = (s) => {
    const d = new Date(s * 1000);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  function imagesHtml() {
    return SP.images.length
      ? `<div class="tk-pics">${SP.images.map((d, i) => `<div class="tk-pic"><img src="${d}" alt="截图" data-act="tkViewPending" data-i="${i}"><button type="button" class="ax" data-act="tkRemovePic" data-i="${i}" aria-label="移除">✕</button></div>`).join('')}</div>`
      : '';
  }

  function composer(placeholder, sendAct, sendLabel) {
    return `${imagesHtml()}
      <textarea class="input tk-text" id="tkText" rows="5" placeholder="${placeholder}">${esc(SP.draft || '')}</textarea>
      <div class="between">
        <div class="row"><button class="btn sm" data-act="tkAddPic">添加截图</button><span class="muted" style="font-size:12px">也可以直接 Ctrl+V 粘贴截图，最多 4 张</span></div>
        <button class="btn primary" data-act="${sendAct}" ${SP.sending ? 'disabled' : ''}>${SP.sending ? '发送中…' : sendLabel}</button>
      </div>`;
  }

  window.pageSupport = function () {
    if (SP.view === 'new') {
      const cats = Object.keys(SP.cats).length ? SP.cats : { pay: '付款 / 开通', download: '下载 / 加速通道', run: '模型运行 / 报错', suggest: '功能建议', other: '其他' };
      return `<div class="page" style="max-width:820px">
        <div class="row"><button class="btn sm" data-act="tkBack">← 返回</button><h1 style="margin:0">提交问题</h1></div>
        <section class="card stack" style="gap:14px">
          <div class="field"><label>问题类型</label><div class="tk-cats">${Object.entries(cats)
            .map(([k, v]) => `<button type="button" class="chip ${SP.form.category === k ? 'on' : ''}" data-act="tkCat" data-k="${k}">${esc(v)}</button>`)
            .join('')}</div></div>
          <div class="field"><label for="tkText">问题描述</label>${composer('遇到了什么问题？在哪一步出现的？有报错的话可以直接截图贴进来。', 'tkSubmit', '提交')}</div>
          <div class="field"><label for="tkContact">联系方式（选填）</label><input class="input" id="tkContact" value="${esc(SP.form.contact)}" placeholder="邮箱 / 微信 / Telegram，方便客服在软件外联系你"></div>
          <label class="row" style="font-size:13px;color:var(--text-2);cursor:pointer"><input type="checkbox" id="tkDiag" ${SP.form.diag ? 'checked' : ''}> 附带诊断信息（软件版本、显卡、引擎版本、最近的运行日志，不含对话内容），客服能更快定位问题</label>
          ${SP.err ? `<div class="alert">${esc(SP.err)}</div>` : ''}
        </section>
      </div>`;
    }
    if (SP.view === 'ticket') {
      const t = SP.ticket || {};
      const closed = t.status === 'closed';
      const thread = SP.msgs.length
        ? SP.msgs
            .map((m) => `<div class="tk-msg ${m.sender === 'admin' ? 'staff' : 'me'}"><div class="who">${m.sender === 'admin' ? '客服' : '我'} · ${fmtTime(m.at)}</div>
              ${m.content ? `<div class="bubble">${esc(m.content).replace(/\n/g, '<br>')}</div>` : ''}
              ${m.images.length ? `<div class="tk-pics">${m.images.map((id) => `<div class="tk-pic"><img data-img="${id}" alt="图片" data-act="tkViewImg" data-id="${id}"></div>`).join('')}</div>` : ''}</div>`)
            .join('')
        : '<div class="muted" style="text-align:center;padding:30px">加载中…</div>';
      return `<div class="page tk-page" style="max-width:860px">
        <div class="between"><div class="row"><button class="btn sm" data-act="tkBack">← 返回</button><h1 style="margin:0;font-size:19px">${esc(t.title || '')}</h1></div>
          ${t.status ? `<span class="tk-st ${t.status}">${esc(t.status_text || '')}</span>` : ''}</div>
        <div class="tk-thread" id="tkThread">${thread}</div>
        ${closed
          ? `<div class="card between"><span class="muted">这个工单已关闭。还有问题可以继续回复，会重新打开。</span><button class="btn sm" data-act="tkReopen">继续回复</button></div>`
          : `<section class="card stack" style="gap:10px">${composer('补充说明或回复客服…', 'tkReply', '发送')}
             <div class="row" style="justify-content:flex-end"><button class="btn sm" data-act="tkClose">问题已解决，关闭工单</button></div></section>`}
      </div>`;
    }
    // 列表
    const list = SP.list;
    const rows = !list
      ? `<div class="muted" style="padding:20px;text-align:center">${SP.err ? esc(SP.err) : '加载中…'}</div>`
      : list.length
        ? list
            .map((t) => `<button class="tk-item" data-act="tkOpen" data-id="${t.id}">${t.unread ? '<i class="tk-dot"></i>' : ''}<div class="tk-main"><b>${esc(t.title)}</b><span class="muted">${esc(t.category)} · ${fmtTime(t.updated_at)}</span></div><span class="tk-st ${t.status}">${esc(t.status_text)}</span></button>`)
            .join('')
        : '<div class="muted" style="padding:28px;text-align:center">还没有提交过问题</div>';
    return `<div class="page" style="max-width:820px">
      <div class="between"><h1 style="margin:0">联系我们</h1><button class="btn primary" data-act="tkNew">提交问题</button></div>
      <p class="muted" style="margin:0">付款没开通、下载失败、模型跑不起来，或者有功能建议，都可以在这里告诉我们。客服回复后，左侧「联系我们」会出现红点。</p>
      <section class="card tk-list">${rows}</section>
    </div>`;
  };

  async function addPics(files) {
    for (const f of files) {
      if (SP.images.length >= 4) return toast('最多 4 张截图');
      if (!/^image\//.test(f.type)) continue;
      const url = await new Promise((res) => {
        const r = new FileReader();
        r.onload = () => res(r.result);
        r.readAsDataURL(f);
      });
      // 压缩到长边 1600，避免太大
      SP.images.push((await makeThumb(url, 1600)) || url);
    }
    keepDraft();
    render();
  }
  const keepDraft = () => {
    const t = $('#tkText');
    if (t) SP.draft = t.value;
    const c = $('#tkContact');
    if (c) SP.form.contact = c.value;
    const d = $('#tkDiag');
    if (d) SP.form.diag = d.checked;
  };

  Object.assign(actions, {
    tkNew: () => {
      SP.view = 'new';
      SP.err = '';
      SP.draft = '';
      SP.images = [];
      render();
    },
    tkBack: () => {
      keepDraft();
      SP.view = 'list';
      SP.images = [];
      SP.draft = '';
      render();
      refreshList(true);
    },
    tkCat: (d) => {
      keepDraft();
      SP.form.category = d.k;
      render();
    },
    tkOpen: (d) => openTicket(+d.id),
    tkAddPic: () => {
      keepDraft();
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = 'image/*';
      inp.multiple = true;
      inp.onchange = () => addPics([...inp.files]);
      inp.click();
    },
    tkRemovePic: (d) => {
      keepDraft();
      SP.images.splice(+d.i, 1);
      render();
    },
    tkViewPending: (d) => openViewer(SP.images.map((data, i) => ({ name: `截图 ${i + 1}`, data })), +d.i),
    tkViewImg: (d, el) => {
      const imgs = [...document.querySelectorAll('#tkThread img[data-img]')].filter((x) => x.src);
      openViewer(imgs.map((x, i) => ({ name: `图片 ${i + 1}`, data: x.src })), Math.max(0, imgs.indexOf(el)));
    },
    tkSubmit: async () => {
      keepDraft();
      const content = (SP.draft || '').trim();
      if (!content && !SP.images.length) return toast('请先写一下遇到的问题');
      SP.sending = true;
      SP.err = '';
      render();
      try {
        const info = SP.form.diag ? await diagnostics() : '';
        const j = await apiPost('ticket_new', { category: SP.form.category, content, contact: SP.form.contact, info }, SP.images);
        SP.images = [];
        SP.draft = '';
        toast('已提交，客服回复后会有红点提醒');
        SP.sending = false;
        await refreshList(true);
        await openTicket(j.id);
      } catch (e) {
        SP.err = e.message;
        SP.sending = false;
        render();
      }
    },
    tkReply: async () => {
      keepDraft();
      const content = (SP.draft || '').trim();
      if (!content && !SP.images.length) return;
      SP.sending = true;
      render();
      try {
        await apiPost('ticket_reply', { id: SP.ticket.id, content }, SP.images);
        SP.images = [];
        SP.draft = '';
        SP.sending = false;
        await openTicket(SP.ticket.id);
      } catch (e) {
        SP.sending = false;
        toast(e.message);
        render();
      }
    },
    tkReopen: () => {
      SP.ticket.status = 'open';
      render();
    },
    tkClose: async () => {
      try {
        await apiPost('ticket_close', { id: SP.ticket.id });
        toast('工单已关闭');
        await openTicket(SP.ticket.id);
      } catch (e) {
        toast(e.message);
      }
    },
  });

  // 工单里的图片按需加载（用设备号鉴权）
  const loadImgs = () => {
    document.querySelectorAll('#tkThread img[data-img]:not([src])').forEach(async (img) => {
      img.setAttribute('src', '');
      try {
        const j = await apiGet('ticket_img', { ticket: SP.ticket.id, id: img.dataset.img });
        img.src = j.data;
      } catch {}
    });
  };
  new MutationObserver(() => S.page === 'support' && SP.view === 'ticket' && loadImgs()).observe(document.getElementById('main'), { childList: true, subtree: true });

  // 在提交页粘贴截图
  document.addEventListener(
    'paste',
    (ev) => {
      if (S.page !== 'support' || SP.view === 'list') return;
      const files = [...(ev.clipboardData?.files || [])].filter((f) => /^image\//.test(f.type));
      if (!files.length) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      addPics(files);
    },
    true,
  );

  window.supportEnter = () => {
    if (SP.view === 'list') refreshList(false);
    else if (SP.view === 'ticket' && SP.ticket?.id) openTicket(SP.ticket.id);
  };

  // 启动后查一次有没有客服回复，之后每 10 分钟查一次
  const poll = () => refreshList(true);
  setTimeout(function wait() {
    if (S.settings?.device_id) poll();
    else setTimeout(wait, 2000);
  }, 3000);
  setInterval(poll, 10 * 60 * 1000);
})();
