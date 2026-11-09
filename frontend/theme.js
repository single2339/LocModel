// 深色 / 浅色主题：设置里选「跟随系统 / 浅色 / 深色」，存在本机；在页面绘制前就设好，打开时不闪白
(function () {
  const get = () => {
    try { return localStorage.getItem('theme') || 'auto'; } catch { return 'auto'; }
  };
  const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function apply() {
    const p = get();
    const dark = p === 'dark' || (p === 'auto' && !!mq && mq.matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    // 窗口顶部的系统标题栏也跟着变色（选「跟随系统」时交给系统决定）
    try { window.__TAURI__?.core?.invoke('set_window_theme', { theme: p }).catch(() => {}); } catch {}
  }
  apply();
  if (mq && mq.addEventListener) mq.addEventListener('change', apply);
  window.setTheme = (v) => {
    try { v === 'auto' ? localStorage.removeItem('theme') : localStorage.setItem('theme', v); } catch {}
    apply();
  };
  window.themeSelectHtml = () => {
    const p = get();
    const o = (v, l) => `<option value="${v}" ${p === v ? 'selected' : ''}>${l}</option>`;
    return `<select class="input" id="st-theme" style="max-width:260px">${o('auto', '跟随系统')}${o('light', '浅色')}${o('dark', '深色')}</select>`;
  };
  document.addEventListener('change', (e) => {
    if (e.target && e.target.id === 'st-theme') window.setTheme(e.target.value);
  });
})();
