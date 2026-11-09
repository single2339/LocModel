// 系统监测：CPU、内存、显卡使用率 / 显存 / 温度 / 功耗、模型进程占用
// 只在打开「监测」页时每 2 秒读取一次，离开页面就停
'use strict';

S.mon = { data: null, hist: { cpu: [], gpu: [], vram: [], mem: [] }, timer: null, err: '' };
const MON_POINTS = 60; // 最近 2 分钟

async function monTick() {
  try {
    const d = await invoke('sys_monitor');
    S.mon.data = d;
    S.mon.err = '';
    const g = d.gpus[0];
    const push = (k, v) => {
      const a = S.mon.hist[k];
      a.push(v);
      if (a.length > MON_POINTS) a.shift();
    };
    push('cpu', d.cpu);
    push('mem', d.mem_total ? (d.mem_used * 100) / d.mem_total : 0);
    push('gpu', g?.util ?? null);
    push('vram', g && g.vram_total ? (g.vram_used * 100) / g.vram_total : null);
  } catch (e) {
    S.mon.err = String(e);
  }
  if (S.page !== 'monitor') return monStop();
  const box = $('#monBody');
  if (box) box.innerHTML = monBody();
}
function monStart() {
  if (S.mon.timer) return;
  monTick();
  S.mon.timer = setInterval(monTick, 2000);
}
function monStop() {
  clearInterval(S.mon.timer);
  S.mon.timer = null;
}

// 小折线图：0–100%
function spark(arr, cls) {
  const pts = arr.map((v, i) => (v == null ? null : [(i * 300) / (MON_POINTS - 1), 60 - (Math.min(100, Math.max(0, v)) * 56) / 100 - 2]));
  const seg = [];
  let cur = [];
  for (const p of pts) {
    if (p) cur.push(p);
    else if (cur.length) (seg.push(cur), (cur = []));
  }
  if (cur.length) seg.push(cur);
  const path = seg.map((s) => 'M' + s.map((p) => p.map((n) => n.toFixed(1)).join(',')).join('L')).join('');
  return `<svg class="mon-spark ${cls}" viewBox="0 0 300 60" preserveAspectRatio="none" aria-hidden="true"><path d="${path}" fill="none" stroke="currentColor" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>`;
}
const pct = (v) => (v == null ? '—' : `${Math.round(v)}%`);
const lvl = (v, warn = 80, bad = 95) => (v == null ? '' : v >= bad ? 'bad' : v >= warn ? 'warn' : 'ok');

// 每种指标的图标
const MON_ICO = {
  cpu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/></svg>',
  mem: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="10" rx="1.5"/><path d="M6 11v2M10 11v2M14 11v2M18 11v2M5 17v3M19 17v3"/></svg>',
  gpu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 7h18a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H6"/><path d="M2 4v16"/><circle cx="10" cy="12.5" r="2.5"/><circle cx="16.5" cy="12.5" r="2.5"/><path d="M6 18v2h4v-2"/></svg>',
  vram: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5.5" rx="8" ry="2.5"/><path d="M4 5.5v6c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5v-6"/><path d="M4 11.5v6c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5v-6"/></svg>',
  temp: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 14.8V4a2 2 0 0 0-4 0v10.8a4 4 0 1 0 4 0z"/></svg>',
  power: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>',
  proc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 3 8l9 5 9-5z"/><path d="m3 13 9 5 9-5"/></svg>',
};
function monCard(title, big, sub, hist, cls, level, ico, val, chips = '') {
  const bar = val == null ? '' : `<div class="mon-bar ${cls}"><i style="width:${Math.max(0, Math.min(100, val)).toFixed(1)}%"></i></div>`;
  return `<section class="card mon-card"><div class="mon-h"><span class="mon-ico ${cls}" aria-hidden="true">${MON_ICO[ico] || ''}</span><span class="mon-t">${title}</span><span class="mon-big ${level}">${big}</span></div>
    ${bar}<div class="mon-s">${sub}</div>${chips ? `<div class="mon-chips">${chips}</div>` : ''}${hist ? spark(hist, cls) : ''}</section>`;
}

function monBody() {
  const d = S.mon.data;
  if (!d) return `<div class="card muted">${S.mon.err ? esc(S.mon.err) : '正在读取…'}</div>`;
  const memPct = d.mem_total ? (d.mem_used * 100) / d.mem_total : 0;
  const cards = [
    monCard('CPU', pct(d.cpu), `${esc(d.cpu_name || '')} · ${d.cores} 线程`, S.mon.hist.cpu, 'c1', lvl(d.cpu), 'cpu', d.cpu),
    monCard('内存', pct(memPct), `${fmtSize(d.mem_used)} / ${fmtSize(d.mem_total)}`, S.mon.hist.mem, 'c2', lvl(memPct, 85, 95), 'mem', memPct),
  ];
  d.gpus.forEach((g, i) => {
    const vp = g.vram_total ? (g.vram_used * 100) / g.vram_total : null;
    const chips = [
      g.temp != null ? `<span class="mon-chip ${g.temp >= 85 ? 'bad' : g.temp >= 75 ? 'warn' : ''}">${MON_ICO.temp}${Math.round(g.temp)} ℃</span>` : '',
      g.power != null ? `<span class="mon-chip">${MON_ICO.power}${Math.round(g.power)}${g.power_limit ? ` / ${Math.round(g.power_limit)}` : ''} W</span>` : '',
    ].join('');
    cards.push(monCard(`显卡${d.gpus.length > 1 ? ' ' + (i + 1) : ''}`, pct(g.util), `${esc(shortGpu(g.name))}${g.util == null ? '<br>这块显卡读不到使用率' : ''}`, i === 0 ? S.mon.hist.gpu : null, 'c3', g.temp != null && g.temp >= 85 ? 'bad' : '', 'gpu', g.util, chips));
    cards.push(monCard(`显存${d.gpus.length > 1 ? ' ' + (i + 1) : ''}`, pct(vp), `${fmtSize(g.vram_used)} / ${fmtSize(g.vram_total)}`, i === 0 ? S.mon.hist.vram : null, 'c4', lvl(vp, 90, 97), 'vram', vp));
  });
  const procs = d.procs.length
    ? `<table class="mon-procs"><tr><th>进程</th><th>CPU</th><th>内存</th></tr>${d.procs.map((p) => `<tr><td><span class="mon-pdot" aria-hidden="true"></span>${esc(p.name)}</td><td>${pct(p.cpu)}</td><td>${fmtSize(p.mem)}</td></tr>`).join('')}</table>`
    : '<div class="muted" style="font-size:13px">现在没有运行模型。启动对话模型或画图 / 视频引擎后，这里会显示它们占用的资源。</div>';
  const tips = [];
  const g0 = d.gpus[0];
  if (g0 && g0.vram_total && g0.vram_used / g0.vram_total > 0.97) tips.push('显存快满了：模型可能变慢或出错，可以在「运行」页把上下文调小，或者换小一号的量化。');
  if (memPct > 95) tips.push('内存快满了：关掉不用的程序，或者换小一点的模型。');
  if (g0?.temp >= 85) tips.push('显卡温度偏高：注意机箱散热，长时间满载可能降频。');
  if (S.server?.ready && g0?.util != null && g0.util < 5 && S.streaming) tips.push('正在回答但显卡几乎没在算：模型可能大部分跑在内存里，速度会慢。');
  return `<div class="mon-grid">${cards.join('')}</div>
    ${tips.length ? `<div class="card warn-card" role="status">${tips.map((t) => `<div>${t}</div>`).join('')}</div>` : ''}
    <section class="card mon-card"><div class="mon-h" style="margin-bottom:8px"><span class="mon-ico c5" aria-hidden="true">${MON_ICO.proc}</span><span class="mon-t">模型进程</span></div>${procs}</section>`;
}

function pageMonitor() {
  setTimeout(monStart, 0);
  return `<div class="page"><h1>系统监测</h1><p class="muted" style="margin:-6px 0 16px">每 2 秒刷新一次，曲线是最近 2 分钟。只读取系统信息，不会改动任何设置。</p><div id="monBody">${monBody()}</div></div>`;
}
