// 对话管理：
//   - 左侧对话列表：搜索、按收藏 / 分类 / 标签筛选；每个对话可以改名、收藏、设分类和标签、导出、删除
//   - 每条消息：复制、编辑、删除；回答可以重新生成，或者按要求改写（更简洁、更详细、更正式…）
'use strict';

S.chatQ = '';
S.chatFilter = '';
S.editMsg = null; // 正在编辑的消息序号

const TONES = [
  ['更简洁', '请把回答改得更简洁，只保留要点。'],
  ['更详细', '请把回答写得更详细，多给例子和步骤。'],
  ['更正式', '请用更正式、专业的语气重新回答。'],
  ['更口语', '请用更轻松、口语化的语气重新回答。'],
  ['换个说法', '请换一种思路和说法重新回答。'],
  ['改用英文', '请用英文重新回答。'],
];

function chatCats() {
  return [...new Set(S.chats.map((c) => (c.cat || '').trim()).filter(Boolean))].sort();
}
function chatTags() {
  return [...new Set(S.chats.flatMap((c) => c.tags || []).filter(Boolean))].sort();
}
function chatMatches(c) {
  const f = S.chatFilter;
  if (f === 'star' && !c.star) return false;
  if (f.startsWith('cat:') && (c.cat || '') !== f.slice(4)) return false;
  if (f.startsWith('tag:') && !(c.tags || []).includes(f.slice(4))) return false;
  const q = S.chatQ.trim().toLowerCase();
  if (!q) return true;
  if ((c.title || '').toLowerCase().includes(q)) return true;
  return c.messages.some((m) => typeof m.content === 'string' && m.content.toLowerCase().includes(q));
}

// 左侧对话列表（对话页）
S.chatListCollapsed = store.get('chatListCollapsed', false);
S.chatSel = null; // 批量管理时选中的对话 id（Set）；null = 不在批量模式

const ICO_COLLAPSE = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M15 10l-2 2 2 2"/></svg>';
const ICO_EXPAND = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M13 10l2 2-2 2"/></svg>';
const ICO_PLUS = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
const ICO_CHECK = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 12l3 3 5-6"/></svg>';

// 对话页左栏：可以收起成一条窄边（只留展开和新对话按钮）
function chatListWrap() {
  if (S.chatListCollapsed) {
    return `<div class="chat-rail"><button class="rail-btn" data-act="toggleChatList" title="展开对话列表" aria-label="展开对话列表">${ICO_EXPAND}</button><button class="rail-btn" data-act="newChat" title="新对话" aria-label="新对话">${ICO_PLUS}</button></div>`;
  }
  return `<div class="chat-list">${chatListHtml()}</div>${paneSplit('chat-list', 'left')}`;
}

function chatListHtml() {
  const cats = chatCats();
  const tags = chatTags();
  // 分类、标签是用户自己起的名字，不翻译；只翻固定的几个字
  const opt = (v, l) => `<option value="${esc(v)}" ${S.chatFilter === v ? 'selected' : ''}>${esc(l)}</option>`;
  const filter = `<select class="chat-filter" id="chatFilter" data-noi18n aria-label="${esc(tr('筛选对话'))}" title="${esc(tr('筛选对话'))}">${opt('', tr('全部'))}${opt('star', '★ ' + tr('收藏'))}${cats.map((x) => opt('cat:' + x, tr('分类') + ' · ' + x)).join('')}${tags.map((x) => opt('tag:' + x, '#' + x)).join('')}</select>`;
  const sel = S.chatSel;
  const shown = S.chats.filter(chatMatches);
  return `<div class="chat-head"><button class="btn new-chat" data-act="newChat">+ 新对话</button><button class="icon-btn" data-act="toggleChatList" title="收起对话列表" aria-label="收起对话列表">${ICO_COLLAPSE}</button></div>
    <div class="chat-find"><input id="chatSearch" placeholder="搜索对话" value="${esc(S.chatQ)}" aria-label="搜索对话">${filter}</div>
    ${sel
      ? `<div class="chat-batch"><div class="cb-row"><label class="ck"><input type="checkbox" data-change="chatSelAll" ${shown.length && shown.every((c) => sel.has(c.id)) ? 'checked' : ''}> 全选</label><span class="muted">已选 ${sel.size}</span></div>
          <div class="cb-row"><button class="btn sm danger" data-act="chatBatchDel" ${sel.size ? '' : 'disabled'}>删除选中</button><button class="btn sm" data-act="chatBatchEnd">完成</button></div></div>`
      : S.chats.length > 1 ? `<button class="chat-manage" data-act="chatBatchStart">${ICO_CHECK}<span>批量管理</span></button>` : ''}
    <div id="chatItems">${chatItemsHtml()}</div>`;
}
function chatItemsHtml() {
  const list = S.chats.filter(chatMatches);
  if (!list.length) return `<div class="muted" style="font-size:12.5px;padding:8px 4px">${S.chatQ || S.chatFilter ? '没有符合条件的对话' : ''}</div>`;
  return list
    .map(
      (x) => S.chatSel
        ? `<label class="ci sel ${S.chatSel.has(x.id) ? 'on' : ''}"><input type="checkbox" data-change="chatSelOne" data-id="${x.id}" ${S.chatSel.has(x.id) ? 'checked' : ''}><span>${esc(x.title === '新对话' ? tr('新对话') : x.title)}</span></label>`
        : `<div class="ci ${x.id === S.chatId ? 'on' : ''}" data-act="openChat" data-id="${x.id}" role="button" tabindex="0">
      ${x.star ? '<i class="ci-star" aria-label="已收藏">★</i>' : ''}<span>${esc(x.title === '新对话' ? tr('新对话') : x.title)}${x.cat ? `<small class="ci-cat">${esc(x.cat)}</small>` : ''}</span>
      <button class="x" data-act="chatMenu" data-id="${x.id}" aria-label="对话设置" title="改名、收藏、分类、标签、导出、删除">⋯</button></div>`,
    )
    .join('');
}

// 每条消息下面的操作
function msgActionsHtml(m, i) {
  if (S.streaming || m.media || (m.role === 'assistant' && !m.done)) return '';
  const b = (act, label, extra = '') => `<button class="ma" data-act="${act}" data-i="${i}" ${extra}>${label}</button>`;
  if (m.role === 'user') {
    return `<div class="m-acts u">${m.steer ? `<span class="steer">要求：${esc(m.steer.label)}</span>` : ''}${b('msgCopy', '复制')}${b('msgEdit', '编辑')}${b('msgDel', '删除')}</div>`;
  }
  const tone = `<select class="ma-sel" data-change="msgTone" data-i="${i}" aria-label="调整回答"><option value="">调整回答…</option>${TONES.map(([k]) => `<option value="${esc(k)}">${esc(k)}</option>`).join('')}</select>`;
  const last = i === (curChat()?.messages.length || 0) - 1;
  return `<div class="m-acts ${last ? 'last' : ''}">${b('msgCopy', '复制')}${b('msgRegen', '重新生成')}${tone}${b('msgEdit', '编辑')}${b('msgDel', '删除')}</div>`;
}

// 正在编辑的消息
function msgEditorHtml(m, i) {
  return `<div class="m-edit"><textarea class="input" id="msgEditBox" rows="${Math.min(14, Math.max(3, (m.content || '').split('\n').length + 1))}">${esc(m.content || '')}</textarea>
    <div class="row" style="justify-content:flex-end;gap:8px;margin-top:6px">
      <button class="btn sm" data-act="msgEditCancel">取消</button>
      ${m.role === 'user' ? `<button class="btn sm" data-act="msgEditSave" data-i="${i}">只保存</button><button class="btn sm primary" data-act="msgEditSave" data-i="${i}" data-resend="1">保存并重新回答</button>` : `<button class="btn sm primary" data-act="msgEditSave" data-i="${i}">保存</button>`}
    </div></div>`;
}

// 改了第 i 条之前的内容：压缩摘要就不准了，丢掉，下次需要时重新压缩
function touchHistory(c, i) {
  if (c.summary && i < c.summary.upto) c.summary = null;
  c.updated = Date.now();
}

async function regenerateFrom(c, i) {
  if (!srcReady()) {
    if (S.pausedChat) {
      if (!(await resumePausedChat())) return;
    } else return toast(usingApi() ? '这个 API 还没填 Key' : '先在「运行」页启动一个模型');
  }
  c.messages = c.messages.slice(0, i);
  touchHistory(c, i);
  S.editMsg = null;
  await streamReply(c);
}

function exportChat(c, kind) {
  const day = new Date().toISOString().slice(0, 10);
  const safe = (c.title || '对话').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
  if (kind === 'json') {
    const data = { title: c.title, cat: c.cat || '', tags: c.tags || [], star: !!c.star, exported: new Date().toISOString(), messages: c.messages.map((m) => ({ role: m.role, content: m.content || (m.media ? `[${m.media.kind === 'video' ? '视频' : '图片'}] ${m.media.prompt || ''}` : ''), attachments: (m.attachments || []).map((a) => a.name) })) };
    return call('save_text_file', { fileName: `${safe}-${day}.json`, content: JSON.stringify(data, null, 2) });
  }
  const lines = [`# ${c.title}`, ''];
  if (c.cat || c.tags?.length) lines.push(`> ${[c.cat ? '分类：' + c.cat : '', c.tags?.length ? '标签：' + c.tags.join('、') : ''].filter(Boolean).join(' · ')}`, '');
  for (const m of c.messages) {
    const who = m.role === 'user' ? '**我**' : '**助手**';
    const att = (m.attachments || []).length ? `\n\n附件：${m.attachments.map((a) => a.name).join('、')}` : '';
    const body = m.media ? `[${m.media.kind === 'video' ? '视频' : '图片'}] ${m.media.prompt || ''}` : m.content || '';
    lines.push(`${who}：`, '', body + att, '', '---', '');
  }
  return call('save_text_file', { fileName: `${safe}-${day}.md`, content: lines.join('\n') });
}

// 对话设置弹窗：改名、收藏、分类、标签、导出、删除
function chatMenuHtml(m) {
  const c = S.chats.find((x) => x.id === m.chatId);
  if (!c) return '';
  const f = 'class="field" style="margin:0 0 14px"';
  return `<h2>管理对话</h2>
    <div ${f}><label for="cmTitle">标题</label><input class="input" id="cmTitle" value="${esc(c.title)}"></div>
    <div ${f}><label for="cmCat">分类</label><input class="input" id="cmCat" list="cmCats" value="${esc(c.cat || '')}" placeholder="例如：工作、学习、写作（留空 = 不分类）"><datalist id="cmCats">${chatCats().map((x) => `<option value="${esc(x)}">`).join('')}</datalist></div>
    <div ${f}><label for="cmTags">标签</label><input class="input" id="cmTags" value="${esc((c.tags || []).join('，'))}" placeholder="多个标签用逗号隔开，例如：Python，周报"></div>
    <label class="ck" style="display:flex;align-items:center;gap:8px;margin:0 0 16px"><input type="checkbox" id="cmStar" ${c.star ? 'checked' : ''}> ★ 收藏这个对话</label>
    <div class="row" style="gap:8px;flex-wrap:wrap;padding:12px 0;border-top:1px solid var(--line)">
      <span class="muted" style="font-size:12.5px">${c.messages.length} 条消息</span>
      <button class="btn sm" data-act="chatExport" data-kind="md" style="margin-left:auto">导出 Markdown</button>
      <button class="btn sm" data-act="chatExport" data-kind="json">导出 JSON</button>
    </div>
    <div class="between" style="margin-top:6px">
      <button class="btn sm danger" data-act="chatMenuDel">删除对话</button>
      <div class="row" style="gap:8px"><button class="btn" data-act="closeModal">取消</button><button class="btn primary" data-act="chatMenuSave">保存</button></div>
    </div>`;
}


Object.assign(actions, {
  toggleChatList: () => {
    S.chatListCollapsed = !S.chatListCollapsed;
    store.set('chatListCollapsed', S.chatListCollapsed);
    render();
  },
  chatBatchStart: () => {
    S.chatSel = new Set();
    render();
  },
  chatBatchEnd: () => {
    S.chatSel = null;
    render();
  },
  chatBatchDel: () => {
    const n = S.chatSel?.size || 0;
    if (!n) return;
    if (!confirm(tr('删除选中的 {0} 个对话？删除后不能恢复。').replace('{0}', n))) return;
    const del = S.chatSel;
    S.chats = S.chats.filter((c) => !del.has(c.id));
    if (del.has(S.chatId)) S.chatId = null;
    S.chatSel = S.chats.length ? new Set() : null;
    saveChats();
    toast(tr('已删除 {0} 个对话').replace('{0}', n));
    render();
  },
  chatMenu: (d, el, ev) => {
    ev?.stopPropagation();
    S.modal = { step: 'custom', html: chatMenuHtml, chatId: d.id };
    renderModal();
  },
  chatMenuSave: () => {
    const c = S.chats.find((x) => x.id === S.modal?.chatId);
    if (!c) return closeModal();
    c.title = $('#cmTitle').value.trim().slice(0, 60) || c.title;
    c.cat = $('#cmCat').value.trim().slice(0, 20);
    c.tags = [...new Set($('#cmTags').value.split(/[,，、\s]+/).map((x) => x.trim().replace(/^#/, '')).filter(Boolean))].slice(0, 10);
    c.star = $('#cmStar').checked;
    saveChats();
    closeModal();
    render();
  },
  chatMenuDel: () => {
    const id = S.modal?.chatId;
    if (!id || !confirm('确定删除这个对话？删除后不能恢复。')) return;
    S.chats = S.chats.filter((c) => c.id !== id);
    if (S.chatId === id) S.chatId = null;
    saveChats();
    closeModal();
    render();
  },
  chatExport: async (d) => {
    const c = S.chats.find((x) => x.id === S.modal?.chatId);
    if (!c) return;
    try {
      const p = await exportChat(c, d.kind);
      if (p) toast(`已导出到 ${p}`);
    } catch {}
  },
  msgCopy: (d, el) => {
    const m = curThread()?.messages[+d.i];
    if (!m) return;
    navigator.clipboard.writeText(m.content || '');
    el.textContent = '已复制';
    setTimeout(() => (el.textContent = '复制'), 1200);
  },
  msgEdit: (d) => {
    S.editMsg = +d.i;
    render();
    const t = $('#msgEditBox');
    if (t) {
      t.focus();
      t.setSelectionRange(t.value.length, t.value.length);
    }
  },
  msgEditCancel: () => {
    S.editMsg = null;
    render();
  },
  msgEditSave: async (d) => {
    const c = curChat();
    const i = +d.i;
    const m = c?.messages[i];
    if (!m) return;
    const v = $('#msgEditBox').value;
    if (!v.trim() && !(m.attachments || []).length) return toast('内容不能为空');
    m.content = v;
    m.edited = true;
    touchHistory(c, i);
    S.editMsg = null;
    if (i === 0 && m.role === 'user') c.title = v.trim().slice(0, 24) || c.title;
    saveChats();
    // 改了问题：后面的回答作废，按新问题重新回答
    if (d.resend) return regenerateFrom(c, i + 1);
    render();
  },
  msgDel: (d) => {
    const c = curChat();
    const i = +d.i;
    const m = c?.messages[i];
    if (!m) return;
    const pair = m.role === 'user' && c.messages[i + 1]?.role === 'assistant';
    if (!confirm(pair ? '删除这个问题和它的回答？' : '删除这条消息？')) return;
    c.messages.splice(i, pair ? 2 : 1);
    touchHistory(c, i);
    saveChats();
    render();
  },
  msgRegen: (d) => {
    const c = curChat();
    const i = +d.i;
    if (!c?.messages[i] || S.streaming) return;
    // 去掉这条回答之前用户临时加的改写要求
    const u = [...c.messages.slice(0, i)].reverse().find((x) => x.role === 'user');
    if (u) delete u.steer;
    regenerateFrom(c, i);
  },
});

Object.assign(changeHandlers, {
  chatSelOne: (el) => {
    if (!S.chatSel) return;
    if (el.checked) S.chatSel.add(el.dataset.id);
    else S.chatSel.delete(el.dataset.id);
    render();
  },
  chatSelAll: (el) => {
    if (!S.chatSel) return;
    const shown = S.chats.filter(chatMatches);
    if (el.checked) shown.forEach((c) => S.chatSel.add(c.id));
    else shown.forEach((c) => S.chatSel.delete(c.id));
    render();
  },
  msgTone: (el) => {
    const c = curChat();
    const i = +el.dataset.i;
    const t = TONES.find(([k]) => k === el.value);
    if (!c || !t || S.streaming) return;
    const u = [...c.messages.slice(0, i)].reverse().find((x) => x.role === 'user');
    if (!u) return;
    u.steer = { label: el.value, text: t[1] };
    regenerateFrom(c, i);
  },
});

// 搜索、筛选：只刷新列表，不打断输入
document.addEventListener('input', (e) => {
  if (e.target?.id !== 'chatSearch') return;
  S.chatQ = e.target.value;
  const box = $('#chatItems');
  if (box) box.innerHTML = chatItemsHtml();
});
document.addEventListener('change', (e) => {
  if (e.target?.id !== 'chatFilter') return;
  S.chatFilter = e.target.value;
  const box = $('#chatItems');
  if (box) box.innerHTML = chatItemsHtml();
});

// ------------------------------------------------------------------ 拖动调整左右栏宽度（对话页、Agent 页）
// 宽度存在 CSS 变量里，页面重新渲染不会丢；双击分隔条恢复默认
const PANE_W = {
  'chat-list': { def: 200, min: 150, max: 420 },
  'ag-list': { def: 200, min: 150, max: 420 },
  'ag-side': { def: 300, min: 220, max: 560 },
};
function applyPaneWidths() {
  const saved = store.get('paneW', {});
  for (const [k, v] of Object.entries(PANE_W)) {
    const w = Math.min(v.max, Math.max(v.min, +saved[k] || v.def));
    document.documentElement.style.setProperty(`--${k}-w`, w + 'px');
  }
}
applyPaneWidths();
function paneSplit(key, side) {
  return `<div class="pane-split ${side === 'right' ? 'ps-right' : ''}" data-split="${key}" data-side="${side}" role="separator" aria-orientation="vertical" aria-label="拖动调整宽度" title="拖动调整宽度，双击恢复默认"></div>`;
}
document.addEventListener('mousedown', (ev) => {
  const sp = ev.target.closest?.('.pane-split');
  if (!sp || ev.button !== 0) return;
  ev.preventDefault();
  const key = sp.dataset.split;
  const conf = PANE_W[key];
  const right = sp.dataset.side === 'right';
  const x0 = ev.clientX;
  const w0 = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(`--${key}-w`)) || conf.def;
  let w = w0;
  document.body.classList.add('pane-dragging');
  sp.classList.add('on');
  const move = (e) => {
    const dx = e.clientX - x0;
    w = Math.round(Math.min(conf.max, Math.max(conf.min, right ? w0 - dx : w0 + dx)));
    document.documentElement.style.setProperty(`--${key}-w`, w + 'px');
  };
  const up = () => {
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
    document.body.classList.remove('pane-dragging');
    sp.classList.remove('on');
    store.set('paneW', { ...store.get('paneW', {}), [key]: w });
  };
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
});
document.addEventListener('dblclick', (ev) => {
  const sp = ev.target.closest?.('.pane-split');
  if (!sp) return;
  const key = sp.dataset.split;
  const saved = store.get('paneW', {});
  delete saved[key];
  store.set('paneW', saved);
  applyPaneWidths();
});
