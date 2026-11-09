// 界面多语言。源码里的文字都是简体中文，这里在运行时把界面翻成繁体中文 / English / 日本語 / 한국어：
//  - 语言：设置里选过就用选的，否则跟随系统语言（navigator.languages）
//  - 繁体：用 opencc-js 整句转换（台湾用词）
//  - 英日韩：i18n-dict.js 词典，先整句匹配，再按带 {0} 的句式匹配，最后按短语替换
//  - 用户自己写的内容（对话、提示词、代码、日志）不翻译：见 SKIP
(function () {
  const LANGS = [['zh', '简体中文'], ['zh-TW', '繁體中文'], ['en', 'English'], ['ja', '日本語'], ['ko', '한국어']];
  function sysLang() {
    const list = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || 'zh-CN'];
    for (const raw of list) {
      const l = String(raw).toLowerCase();
      if (/^zh[-_](tw|hk|mo)|hant/.test(l)) return 'zh-TW';
      if (l.startsWith('zh')) return 'zh';
      if (l.startsWith('ja')) return 'ja';
      if (l.startsWith('ko')) return 'ko';
      if (l.startsWith('en')) return 'en';
    }
    return 'en';
  }
  let pref = 'auto';
  try { pref = localStorage.getItem('lang') || 'auto'; } catch {}
  const SYS = sysLang();
  const LANG = LANGS.some((x) => x[0] === pref) ? pref : SYS;
  window.LANG = LANG;
  window.LANG_PREF = LANGS.some((x) => x[0] === pref) ? pref : 'auto';
  document.documentElement.lang = { zh: 'zh-CN', 'zh-TW': 'zh-TW', en: 'en', ja: 'ja', ko: 'ko' }[LANG];
  window.setLang = (v) => {
    try { v === 'auto' ? localStorage.removeItem('lang') : localStorage.setItem('lang', v); } catch {}
    location.reload();
  };
  // 设置页的语言下拉框
  window.langSelectHtml = () => {
    const name = (c) => LANGS.find((x) => x[0] === c)[1];
    const opt = (v, label) => `<option value="${v}" ${window.LANG_PREF === v ? 'selected' : ''}>${label}</option>`;
    return `<select class="input" id="st-lang" data-noi18n style="max-width:260px">${opt('auto', `${window.tr('跟随系统')}（${name(SYS)}）`)}${LANGS.map((x) => opt(x[0], x[1])).join('')}</select>`;
  };
  document.addEventListener('change', (e) => {
    if (e.target && e.target.id === 'st-lang') window.setLang(e.target.value);
  });

  if (LANG === 'zh') {
    window.tr = (s) => s;
    return;
  }
  // 语言包只在需要时加载（解析期间 document.write 的脚本会在 app.js 之前执行完）
  document.write(LANG === 'zh-TW' ? '<script src="opencc-cn2t.js"><\/script>' : '<script src="i18n-dict.js"><\/script>');

  const CJK = /[㐀-鿿]/;
  const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let ready = false, conv = null, exact = null, pats = [], fragRe = null, fragMap = null;
  const cache = new Map();

  function init() {
    ready = true;
    if (LANG === 'zh-TW') {
      try { conv = window.OpenCC.Converter({ from: 'cn', to: 'twp' }); } catch { conv = (s) => s; }
      return;
    }
    const d = window.I18N_DICT || { k: [] };
    const tl = d[LANG] || [];
    exact = new Map();
    const fr = [];
    d.k.forEach((k, i) => {
      const v = tl[i];
      const kt = k.trim();
      if (!v || !kt) return;
      if (/\{\d+\}/.test(kt)) {
        // 相邻的占位符（如 {0}{1}）没法拆开，合成一组：整段放到前一个位置，后一个留空
        const order = [];
        const parts = kt.split(/(\{\d+\})/);
        let src = '', prevPh = false;
        for (const p of parts) {
          const m = p.match(/^\{(\d+)\}$/);
          if (m) {
            if (prevPh) order[order.length - 1].push(+m[1]);
            else { order.push([+m[1]]); src += '([\\s\\S]+?)'; }
            prevPh = true;
          } else {
            src += reEsc(p);
            if (p) prevPh = false;
          }
        }
        const lits = parts.filter((p) => p && !/^\{\d+\}$/.test(p));
        const need = lits.sort((a, b) => b.length - a.length)[0] || '';
        if (!need.trim()) return;
        pats.push({ re: new RegExp('^' + src + '$'), order, v: v.trim(), need, len: lits.join('').length });
      } else if (CJK.test(kt)) {
        if (!exact.has(kt)) exact.set(kt, v.trim());
        if (kt.length >= 2) fr.push([kt, v.trim()]);
      }
    });
    pats.sort((a, b) => b.len - a.len);
    fr.sort((a, b) => b[0].length - a[0].length);
    fragMap = new Map(fr);
    fragRe = fr.length ? new RegExp(fr.map((x) => reEsc(x[0])).join('|'), 'g') : null;
  }

  // 保留首尾空白，只翻中间
  function wrap(s, fn) {
    const m = s.match(/^(\s*)([\s\S]*?)(\s*)$/);
    return m[1] + fn(m[2]) + m[3];
  }
  function frag(s) {
    if (!fragRe) return s;
    let r = s.replace(fragRe, (m) => (LANG === 'en' ? ' ' + fragMap.get(m) + ' ' : fragMap.get(m)));
    if (LANG === 'en') {
      r = r.replace(/ {2,}/g, ' ').replace(/ ([,.:;!?)\]，。：；！？）】」])/g, '$1').replace(/([(\[（【「]) /g, '$1');
      if (!/^\s/.test(s)) r = r.replace(/^ /, '');
      if (!/\s$/.test(s)) r = r.replace(/ $/, '');
    }
    return r;
  }
  function core(s, depth) {
    if (!CJK.test(s)) return s;
    const e = exact.get(s);
    if (e !== undefined) return e;
    if (depth < 4) {
      for (const p of pats) {
        if (!s.includes(p.need)) continue;
        const m = p.re.exec(s);
        if (!m) continue;
        const out = p.v.replace(/\{(\d+)\}/g, (_, n) => {
          const gi = p.order.findIndex((o) => o.includes(+n));
          if (gi < 0 || p.order[gi][0] !== +n) return '';
          return wrap(m[gi + 1], (x) => core(x, depth + 1));
        });
        return out.replace(/ {2,}/g, ' ');
      }
    }
    return frag(s);
  }
  function tr(s) {
    if (s == null) return s;
    s = String(s);
    if (!CJK.test(s)) return s;
    if (!ready) {
      if (LANG === 'zh-TW' ? !window.OpenCC : !window.I18N_DICT) return s;
      init();
    }
    const c = cache.get(s);
    if (c !== undefined) return c;
    let r;
    if (conv) r = conv(s);
    else if (s.includes('\n')) r = s.split('\n').map(tr).join('\n');
    else r = wrap(s, (x) => core(x, 0));
    if (cache.size > 8000) cache.clear();
    cache.set(s, r);
    return r;
  }
  window.tr = tr;

  // ---------------------------------------------------------------- 页面
  const SKIP = '[data-noi18n],.m-user,.md-body,.think>div,.cm-prompt>div,.sum-bar>div,pre,code,textarea,script,style,iframe,.ci>span,.img-p';
  const ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];
  const doneText = new WeakMap();
  const doneAttr = new WeakMap();

  function doText(n) {
    const v = n.nodeValue;
    if (!v || doneText.get(n) === v || !CJK.test(v)) return;
    const t = tr(v);
    doneText.set(n, t);
    if (t !== v) n.nodeValue = t;
  }
  function doAttr(el, a) {
    const v = el.getAttribute(a);
    if (!v || !CJK.test(v)) return;
    let d = doneAttr.get(el);
    if (d && d[a] === v) return;
    const t = tr(v);
    if (!d) doneAttr.set(el, (d = {}));
    d[a] = t;
    if (t !== v) el.setAttribute(a, t);
  }
  function doEl(el) {
    for (const a of ATTRS) if (el.hasAttribute(a)) doAttr(el, a);
  }
  // 模型回复正文不翻译，但里面代码块的按钮栏（复制 / 下载 / 运行预览）是界面，要翻
  const attrSkipped = (el) => !!el.closest('[data-noi18n],.m-user,.md-body,.img-p');
  const skipped = (el) => !el || (!!el.closest(SKIP) && !el.closest('.code-bar'));
  function walk(root) {
    if (root.nodeType === 3) return skipped(root.parentElement) ? undefined : doText(root);
    if (root.nodeType !== 1) return;
    const deep = !!root.closest('.md-body') || !!root.querySelector('.md-body');
    if (root.matches(SKIP) && !root.matches('.md-body')) {
      if (root.matches('textarea,input') && !attrSkipped(root)) doEl(root);
      return;
    }
    if (!skipped(root)) doEl(root);
    const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => {
        if (n.nodeType === 3) return deep && skipped(n.parentElement) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
        if (n.matches('.md-body')) return NodeFilter.FILTER_SKIP;
        if (!n.matches(SKIP)) return NodeFilter.FILTER_ACCEPT;
        if (n.matches('textarea,input') && !attrSkipped(n)) doEl(n); // 输入框的提示文字是界面
        return NodeFilter.FILTER_REJECT;
      },
    });
    let n;
    while ((n = w.nextNode())) {
      if (n.nodeType === 3) doText(n);
      else if (!deep || !skipped(n)) doEl(n);
    }
  }

  const mo = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'childList') {
        const t = m.target.nodeType === 1 ? m.target : m.target.parentElement;
        if (t && t.closest(SKIP) && !t.closest('.md-body')) continue;
        m.addedNodes.forEach(walk);
      } else if (m.type === 'characterData') {
        if (!skipped(m.target.parentElement)) doText(m.target);
      } else if (m.type === 'attributes') {
        if (m.target.matches('textarea,input') ? !attrSkipped(m.target) : !skipped(m.target)) doAttr(m.target, m.attributeName);
      }
    }
  });
  mo.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  const start = () => { walk(document.body); if (document.title) document.title = tr(document.title); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  // 系统弹窗
  const oc = window.confirm.bind(window), oa = window.alert.bind(window), op = window.prompt.bind(window);
  window.confirm = (m) => oc(tr(m));
  window.alert = (m) => oa(tr(m));
  window.prompt = (m, d) => op(tr(m), d);
})();
