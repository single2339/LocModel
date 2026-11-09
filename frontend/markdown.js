// 轻量 Markdown 渲染：段落、标题、列表、引用、表格、行内代码、粗斜体、链接、代码块
// 代码块单独收集到 codes 数组，界面上给每个代码块加「复制 / 下载 / 运行预览」
(function () {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function inline(s) {
    // 先把行内代码抠出来，避免里面的符号被当成粗体等
    const slots = [];
    s = s.replace(/`([^`\n]+)`/g, (_, c) => {
      slots.push(`<code class="inl">${esc(c)}</code>`);
      return `\u0000${slots.length - 1}\u0000`;
    });
    s = esc(s);
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
    s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" data-act="extLink" data-url="$2">$1</a>');
    s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[+i]);
    return s;
  }

  function table(lines) {
    const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));
    const head = cells(lines[0]);
    const body = lines.slice(2).map(cells);
    return `<table><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${body
      .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`)
      .join('')}</tbody></table>`;
  }

  /**
   * @param {string} src
   * @param {(code:{lang:string,text:string,index:number,closed:boolean})=>string} renderCode
   */
  function render(src, renderCode) {
    const lines = String(src || '').replace(/\r\n/g, '\n').split('\n');
    const out = [];
    const codes = [];
    let i = 0;
    let para = [];
    const flush = () => {
      if (para.length) {
        out.push(`<p>${para.map(inline).join('<br>')}</p>`);
        para = [];
      }
    };

    while (i < lines.length) {
      const line = lines[i];
      const fence = line.match(/^\s*(```|~~~)\s*([\w+#.-]*)\s*$/);
      if (fence) {
        flush();
        const mark = fence[1];
        const lang = (fence[2] || '').toLowerCase();
        const buf = [];
        i++;
        let closed = false;
        while (i < lines.length) {
          if (lines[i].trim().startsWith(mark)) {
            closed = true;
            i++;
            break;
          }
          buf.push(lines[i]);
          i++;
        }
        const code = { lang, text: buf.join('\n'), index: codes.length, closed };
        codes.push(code);
        out.push(renderCode(code));
        continue;
      }
      if (/^\s*$/.test(line)) {
        flush();
        i++;
        continue;
      }
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) {
        flush();
        out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
        i++;
        continue;
      }
      if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
        flush();
        out.push('<hr>');
        i++;
        continue;
      }
      if (/^\s*>/.test(line)) {
        flush();
        const buf = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) {
          buf.push(lines[i].replace(/^\s*>\s?/, ''));
          i++;
        }
        out.push(`<blockquote>${buf.map(inline).join('<br>')}</blockquote>`);
        continue;
      }
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
        flush();
        const buf = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
          buf.push(lines[i]);
          i++;
        }
        out.push(table(buf));
        continue;
      }
      const li = line.match(/^\s*([-*+]|\d+[.)])\s+(.*)$/);
      if (li) {
        flush();
        const ordered = /\d/.test(li[1]);
        const items = [];
        while (i < lines.length) {
          const m = lines[i].match(/^\s*([-*+]|\d+[.)])\s+(.*)$/);
          if (!m) break;
          items.push(`<li>${inline(m[2])}</li>`);
          i++;
        }
        out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
        continue;
      }
      para.push(line);
      i++;
    }
    flush();
    return { html: out.join(''), codes };
  }

  window.MD = { render, esc };
})();
