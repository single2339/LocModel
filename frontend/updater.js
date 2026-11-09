// LocModel —— 新版本提醒：启动时从后台读最新版本，比当前新就问用户；用户点「立即更新」才下载安装
'use strict';

S.update = null; // { version, notes, url, page, force, state: ask/downloading/ready/error, path, error }

const updSize = (b) => (b >= GB ? fmtGB(b) : `${Math.round(b / 1048576)} MB`);

/** 1.2.10 和 1.2.9 这种按数字比较；返回 a 比 b 新为正 */
function cmpVer(a, b) {
  const pa = String(a).replace(/^v/i, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/i, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

async function checkUpdate(u, manual = false) {
  if (!u || !u.version || !S.version) {
    if (manual) toast('没有可用的版本信息');
    return;
  }
  if (cmpVer(u.version, S.version) <= 0) {
    if (manual) toast(`已经是最新版本（v${S.version}）`);
    return;
  }
  const force = !!u.force_below && cmpVer(S.version, u.force_below) < 0;
  // 有新版本：侧边栏左下角一直显示「更新」按钮（跳过了这个版本也显示，只是不再自动弹窗）
  S.newVer = u;
  sideUpdateBtn();
  let skipped = '';
  try { skipped = localStorage.getItem('skipVersion') || ''; } catch {}
  if (!manual && !force && skipped === u.version) return;
  if (S.update?.version !== u.version || !['downloading', 'ready'].includes(S.update.state)) await prepareUpdate(u, force);
  showUpdate();
}

async function prepareUpdate(u, force) {
  let portable = false;
  try { portable = await invoke('is_portable'); } catch {}
  const platform = await invoke('update_platform');
  const url = portable || !platform ? '' : u[platform] || '';
  const candidate = (portable && u.win_portable) || u.page || '';
  let page = 'https://www.locmodel.com';
  try {
    const link = new URL(candidate);
    if (link.protocol === 'https:' && ['www.locmodel.com', 'locmodel.com', 'get.locmodel.com'].includes(link.hostname) && !link.username && !link.password && !link.port) page = link.href;
  } catch {}
  S.update = { version: u.version, notes: u.notes || '', url, page, force, portable, state: 'ask' };
}

function sideUpdateBtn() {
  const b = document.getElementById('updSide');
  if (!b || !S.newVer) return;
  b.hidden = false;
  const l = b.querySelector('.lbl');
  if (l) l.textContent = `更新到 v${S.newVer.version}`;
  b.title = `发现新版本 v${S.newVer.version}，点这里更新`;
}

function showUpdate() {
  if (S.modal && S.modal.step !== 'custom') return; // 收银台等弹窗开着：不打扰
  S.modal = { step: 'custom', wide: false, update: true, html: updateHtml };
  renderModal();
}

function updateHtml() {
  const u = S.update;
  if (!u) return '';
  const notes = u.notes.split('\n').map((x) => x.trim()).filter(Boolean);
  const d = u.prog;
  let body;
  if (u.state === 'downloading') {
    const pct = d && d.total ? Math.round((d.done / d.total) * 100) : 0;
    body = `<div class="upd-bar"><i style="width:${pct}%"></i></div>
      <div class="muted" style="font-size:13px;margin-top:8px">正在下载新版本… ${d && d.total ? `${pct}% · ${updSize(d.done)} / ${updSize(d.total)}${d.speed ? ` · ${fmtSpeed(d.speed)}` : ''}` : ''}</div>
      <div class="row" style="justify-content:flex-end;margin-top:14px"><button class="btn" data-act="cancelUpdate">取消</button></div>`;
  } else if (u.state === 'ready') {
    body = `<p>新版本已经下载好了。${OS_NAME === 'Windows' ? '点「安装官方版」后，此程序会关闭，官方安装程序会打开。' : OS_NAME === 'macOS' ? '点「安装官方版」打开磁盘映像，然后将应用拖入「应用程序」。' : '点「安装官方版」打开 ZIP 压缩包，然后解压并运行官方程序。'}</p>
      <div class="row" style="justify-content:flex-end;margin-top:14px">${u.force ? '' : '<button class="btn" data-act="laterUpdate">稍后</button>'}<button class="btn primary" data-act="installUpdate">安装官方版</button></div>`;
  } else {
    body = `${notes.length ? `<div class="upd-notes"><b>更新内容</b><ul>${notes.map((x) => `<li>${esc(x.replace(/^[-*•·]\s*/, ''))}</li>`).join('')}</ul></div>` : ''}
      ${u.force ? '<p class="muted" style="font-size:13px">当前版本有严重问题，需要更新后才能继续使用。</p>' : ''}
      ${u.error ? `<div class="pay-err">${esc(u.error)}</div>` : ''}
      <div class="row" style="justify-content:flex-end;margin-top:14px;gap:8px">
        ${u.force ? '' : '<button class="btn" data-act="skipUpdate" style="margin-right:auto">跳过这个版本</button><button class="btn" data-act="laterUpdate">稍后</button>'}
        <button class="btn primary" data-act="startUpdate">${u.url ? '立即更新' : '去下载页'}</button></div>`;
  }
  return `<h2>发现新版本 v${esc(u.version)}</h2><div class="muted" style="font-size:13px;margin:-4px 0 12px">当前重建版 v${esc(S.version || '')}。此更新来自 LocModel 官方。安装后将使用官方程序。</div>${body}`;
}

Object.assign(actions, {
  // 侧边栏左下角的「更新」按钮
  openUpdate: async () => {
    if (!S.newVer) return;
    if (!S.update || S.update.version !== S.newVer.version || S.update.state === 'error') {
      await prepareUpdate(S.newVer, !!S.newVer.force_below && cmpVer(S.version, S.newVer.force_below) < 0);
    }
    showUpdate();
  },
  checkUpdateNow: async () => {
    toast('正在检查更新…');
    try {
      const j = await invoke('client_config');
      await checkUpdate(j.update, true);
    } catch {
      toast('检查更新失败，请稍后再试');
    }
  },
  laterUpdate: () => {
    if (S.update?.force) return;
    S.modal = null;
    renderModal();
  },
  skipUpdate: () => {
    try { localStorage.setItem('skipVersion', S.update.version); } catch {}
    actions.laterUpdate();
  },
  startUpdate: async () => {
    const u = S.update;
    if (!u || u.state !== 'ask') return;
    if (!u.url) {
      invoke('open_url', { url: u.page }).catch(() => {});
      if (!u.force) actions.laterUpdate();
      return;
    }
    u.state = 'downloading';
    u.error = '';
    u.prog = null;
    renderModal();
    try {
      u.path = await invoke('download_update', { url: u.url, version: u.version });
      u.state = 'ready';
    } catch (e) {
      const msg = String(e);
      u.state = 'ask';
      u.error = msg === '已取消' || /已取消/.test(msg) ? '' : `${msg.split('\n')[0]}。也可以去官网下载页手动下载。`;
      if (u.error) u.url = '';
    }
    if (S.modal?.update) renderModal();
  },
  cancelUpdate: () => invoke('cancel_download', { id: 'update' }).catch(() => {}),
  installUpdate: async () => {
    if (S.update?.state !== 'ready' || !confirm('安装官方版本将替换当前重建版。继续安装吗？')) return;
    S.update.state = 'installing';
    try {
      await invoke('install_update', { path: S.update.path, officialConfirmed: true });
      S.update = null;
      S.modal = null;
      renderModal();
    } catch (e) {
      S.update.state = 'ask';
      S.update.error = String(e);
      renderModal();
    }
  },
});

// 下载进度刷新弹窗
listen('download-progress', (e) => {
  if (e.payload?.id !== 'update' || !S.update) return;
  S.update.prog = e.payload;
  if (S.modal?.update) renderModal();
});
