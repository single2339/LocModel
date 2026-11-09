// 轻量代码高亮（不依赖外部库，离线可用）：关键字、字符串、数字、注释、函数、类型、变量、HTML 标签……
// 用法：HL.highlight(text, lang) → 已转义、带 <span class="t-xx"> 的 HTML
(function () {
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const set = (s) => new Set(s.split(/\s+/).filter(Boolean));

  const KW = {
    c: set(`if else for while do switch case default break continue return goto sizeof typedef struct union enum const static extern volatile register inline
      class public private protected virtual override final new delete this namespace using template typename try catch throw operator friend auto
      void int long short char float double bool unsigned signed nullptr __global__ __device__ __host__`),
    js: set(`var let const function return if else for while do switch case default break continue new delete typeof instanceof in of this class extends super
      import export from as async await yield try catch finally throw void with static get set interface type enum implements declare readonly
      public private protected abstract namespace keyof`),
    py: set(`def return if elif else for while break continue pass class import from as try except finally raise with lambda yield global nonlocal assert del
      in is not and or async await match case`),
    rs: set(`fn let mut const static if else match for while loop break continue return struct enum impl trait pub use mod crate self super where as in ref move
      async await dyn unsafe extern type Self`),
    go: set(`func package import var const type struct interface map chan go defer select return if else for range switch case default break continue fallthrough goto`),
    java: set(`public private protected class interface extends implements static final abstract void new return if else for while do switch case default break continue
      try catch finally throw throws import package this super synchronized volatile transient instanceof enum record var val fun func let struct guard`),
    php: set(`function return if else elseif foreach for while do switch case default break continue class new public private protected static const use namespace
      try catch finally throw echo print require require_once include include_once array fn match as instanceof extends implements interface trait global isset unset empty`),
    sh: set(`if then else elif fi for in do done while until case esac function return local export readonly unset shift exit set source alias echo cd sudo apt apt-get
      pip pip3 npm npx git curl wget chmod chown mkdir rm cp mv cat grep sed awk systemctl docker python python3 cargo`),
    ps: set(`function param begin process end if elseif else foreach for while do until switch break continue return try catch finally throw trap exit filter in`),
    sql: set(`select from where insert into values update set delete create table index view drop alter add column primary key foreign references join left right
      inner outer on group by order having limit offset as and or not is in like between distinct union all case when then else end exists default unique
      integer text real blob varchar int bigint boolean date timestamp count sum avg min max local function return if elseif then end for do while`),
    bat: set('if else for in do goto call set echo exit not exist errorlevel defined setlocal endlocal pause cd start'),
  };
  const LIT = set('true false null undefined None True False nil NaN Infinity TRUE FALSE NULL');
  const BUILTIN = set('self this console print len range str int float list dict tuple println printf fmt std Math JSON Object Array String Number Promise document window');

  const ALIAS = {
    javascript: 'js', jsx: 'js', ts: 'js', typescript: 'js', tsx: 'js', mjs: 'js', node: 'js', vue: 'html',
    python: 'py', py3: 'py', rust: 'rs', golang: 'go', kotlin: 'java', kt: 'java', swift: 'java', scala: 'java', dart: 'java', cs: 'java', csharp: 'java',
    h: 'c', cpp: 'c', 'c++': 'c', cc: 'c', hpp: 'c', cuda: 'c', cu: 'c',
    bash: 'sh', shell: 'sh', zsh: 'sh', console: 'sh', dockerfile: 'sh', docker: 'sh', makefile: 'sh', make: 'sh',
    powershell: 'ps', ps1: 'ps', pwsh: 'ps', cmd: 'bat', batch: 'bat',
    xml: 'html', svg: 'html', htm: 'html',
    scss: 'css', less: 'css',
    jsonc: 'json', json5: 'json',
    yml: 'yaml', toml: 'yaml', ini: 'yaml', conf: 'yaml', env: 'yaml',
    sqlite: 'sql', mysql: 'sql', postgres: 'sql', lua: 'sql',
    patch: 'diff', markdown: 'md',
  };

  const span = (cls, s) => `<span class="t-${cls}">${esc(s)}</span>`;

  // 通用扫描器：按顺序尝试每种记号（注释、字符串、数字、变量、标识符、运算符）
  function scan(text, cfg) {
    const Q3 = '"'.repeat(3);
    const S3 = "'".repeat(3);
    const rules = [];
    if (cfg.block) rules.push([cfg.block.source, 'com']);
    if (cfg.line) rules.push([cfg.line.source, 'com']);
    if (cfg.pre) rules.push([cfg.pre.source, 'kw']);
    if (cfg.triple) rules.push([`${Q3}[\\s\\S]*?(?:${Q3}|$)|${S3}[\\s\\S]*?(?:${S3}|$)`, 'str']);
    rules.push([`"(?:\\\\[\\s\\S]|[^"\\\\\\n])*"?`, 'str']);
    if (!cfg.noSingle) rules.push([`'(?:\\\\[\\s\\S]|[^'\\\\\\n])*'?`, 'str']);
    if (cfg.backtick) rules.push(['`(?:\\\\[\\s\\S]|[^`\\\\])*`?', 'str']);
    rules.push([`\\b(?:0[xX][\\da-fA-F_]+|0[bB][01_]+|\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)[a-zA-Z]*\\b`, 'num']);
    if (cfg.vars) rules.push([cfg.vars.source, 'var']);
    if (cfg.flags) rules.push([`(?<![\\w-])--?[A-Za-z][\\w-]*`, 'attr']);
    if (!cfg.noDecorator) rules.push([`@[A-Za-z_][\\w.]*`, 'dec']);
    rules.push([cfg.dash ? `[A-Za-z_][\\w-]*` : `[A-Za-z_$][\\w$]*`, 'id']);
    rules.push([`[+\\-*/%=<>!&|^~?:]+`, 'op']);
    const re = new RegExp(rules.map((r) => `(${r[0]})`).join('|'), 'g');

    let out = '';
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m[0] === '') {
        re.lastIndex++;
        continue;
      }
      if (m.index > last) out += esc(text.slice(last, m.index));
      const tok = m[0];
      let kind = 'op';
      for (let g = 1; g < m.length; g++) {
        if (m[g] !== undefined) {
          kind = rules[g - 1][1];
          break;
        }
      }
      if (kind === 'id') {
        const word = cfg.ci ? tok.toLowerCase() : tok;
        if (cfg.kw.has(word) || cfg.kw.has(tok)) kind = 'kw';
        else if (LIT.has(tok)) kind = 'lit';
        else if (BUILTIN.has(tok)) kind = 'bi';
        else if (cfg.ps && /^[A-Za-z]+-[A-Za-z]+/.test(tok)) kind = 'fn';
        else if (/^\s*\(/.test(text.slice(re.lastIndex, re.lastIndex + 40))) kind = 'fn';
        else if (/^[A-Z][a-z0-9]/.test(tok)) kind = 'ty';
        else kind = '';
      }
      out += kind ? span(kind, tok) : esc(tok);
      last = re.lastIndex;
    }
    if (last < text.length) out += esc(text.slice(last));
    return out;
  }

  function html(text) {
    let out = '';
    const re = /(<!--[\s\S]*?(?:-->|$)|<![A-Za-z][^>]*>)|(<\/?)([\w:-]+)((?:\s+[^\s=>\/]+(?:\s*=\s*(?:"[^"]*"?|'[^']*'?|[^\s>]+))?)*)\s*(\/?>)?|(&[#\w]+;)/g;
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m.index > last) out += esc(text.slice(last, m.index));
      if (m[1]) out += span('com', m[1]);
      else if (m[6]) out += span('lit', m[6]);
      else {
        out += span('punc', m[2]) + span('tag', m[3]);
        out += (m[4] || '').replace(/(\s+)|([^\s=]+)(\s*=\s*)?("[^"]*"?|'[^']*'?|[^\s>]+)?/g, (all, sp, a, eq, v) =>
          sp ? sp : span('attr', a) + (eq ? esc(eq) : '') + (v ? span('str', v) : '')
        );
        if (m[5]) out += span('punc', m[5]);
      }
      last = re.lastIndex;
      // <script> / <style> 里的内容按 JS / CSS 高亮
      if (m[3] && m[2] === '<' && /^(script|style)$/i.test(m[3]) && m[5]) {
        const rest = text.slice(last);
        const end = rest.search(new RegExp(`</${m[3]}\\s*>`, 'i'));
        const body = end < 0 ? rest : rest.slice(0, end);
        out += /style/i.test(m[3]) ? css(body) : scan(body, CFG.js);
        last += body.length;
        re.lastIndex = last;
      }
    }
    if (last < text.length) out += esc(text.slice(last));
    return out;
  }

  function css(text) {
    let out = '';
    const re = /(\/\*[\s\S]*?(?:\*\/|$))|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?)|(@[\w-]+)|(#[\da-fA-F]{3,8}\b)|(-?\d*\.?\d+(?:px|em|rem|%|vh|vw|s|ms|deg|fr|ch)?)|(--[\w-]+|[a-zA-Z-]+)(?=\s*:[^:])|([.#]?-?[A-Za-z_][\w-]*|::?[\w-]+)|([{}:;,()>+~*!])/g;
    let last = 0;
    let m;
    let depth = 0;
    while ((m = re.exec(text))) {
      if (m[0] === '') {
        re.lastIndex++;
        continue;
      }
      if (m.index > last) out += esc(text.slice(last, m.index));
      const t = m[0];
      if (m[1]) out += span('com', t);
      else if (m[2]) out += span('str', t);
      else if (m[3]) out += span('kw', t);
      else if (m[4] || m[5]) out += span('num', t);
      else if (m[6] && depth > 0) out += span('attr', t);
      else if (m[6] || m[7]) {
        if (depth > 0) out += /^(important|auto|none|inherit|initial|unset)$/.test(t) ? span('lit', t) : esc(t);
        else out += span(/^[.#]/.test(t) ? 'fn' : /^:/.test(t) ? 'kw' : 'tag', t);
      } else {
        if (t === '{') depth++;
        if (t === '}') depth = Math.max(0, depth - 1);
        out += span('punc', t);
      }
      last = re.lastIndex;
    }
    if (last < text.length) out += esc(text.slice(last));
    return out;
  }

  function json(text) {
    return text.replace(/("(?:\\.|[^"\\])*"?)(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|(\/\/[^\n]*)|([\s\S])/g, (all, s, colon, num, lit, com, other) => {
      if (s) return colon ? span('attr', s) + esc(colon) : span('str', s);
      if (num) return span('num', num);
      if (lit) return span('lit', lit);
      if (com) return span('com', com);
      return esc(other);
    });
  }

  function yaml(text) {
    return text
      .split('\n')
      .map((line) => {
        const c = line.match(/^(\s*)([#;].*)$/);
        if (c) return esc(c[1]) + span('com', c[2]);
        const sec = line.match(/^(\s*)(\[[^\]]+\])(.*)$/);
        if (sec) return esc(sec[1]) + span('tag', sec[2]) + esc(sec[3]);
        const kv = line.match(/^(\s*-?\s*)([\w.\-"' ]+?)(\s*[:=])(\s*)(.*)$/);
        if (kv) {
          let v = kv[5];
          let com = '';
          const ci = v.search(/\s#/);
          if (ci >= 0) {
            com = v.slice(ci);
            v = v.slice(0, ci);
          }
          const tv = v.trim();
          const vv = /^(true|false|null|yes|no|on|off|~)$/i.test(tv) ? span('lit', v) : /^-?\d+(\.\d+)?$/.test(tv) ? span('num', v) : v ? span('str', v) : '';
          return esc(kv[1]) + span('attr', kv[2]) + esc(kv[3] + kv[4]) + vv + (com ? span('com', com) : '');
        }
        const li = line.match(/^(\s*-\s+)(.*)$/);
        if (li) return esc(li[1]) + span('str', li[2]);
        return esc(line);
      })
      .join('\n');
  }

  function diff(text) {
    return text
      .split('\n')
      .map((l) => (/^\+/.test(l) ? span('add', l) : /^-/.test(l) ? span('del', l) : /^@@/.test(l) ? span('fn', l) : esc(l)))
      .join('\n');
  }

  function bat(text) {
    return text
      .split('\n')
      .map((l) => (/^\s*(rem\b|::)/i.test(l) ? span('com', l) : scan(l, CFG.bat)))
      .join('\n');
  }

  const CFG = {
    c: { kw: KW.c, block: /\/\*[\s\S]*?(?:\*\/|$)/, line: /\/\/[^\n]*/, pre: /#\s*[a-z]+/ },
    js: { kw: KW.js, block: /\/\*[\s\S]*?(?:\*\/|$)/, line: /\/\/[^\n]*/, backtick: true },
    java: { kw: KW.java, block: /\/\*[\s\S]*?(?:\*\/|$)/, line: /\/\/[^\n]*/ },
    rs: { kw: KW.rs, block: /\/\*[\s\S]*?(?:\*\/|$)/, line: /\/\/[^\n]*/, pre: /#!?\[[^\]\n]*\]/, noSingle: true, noDecorator: true },
    go: { kw: KW.go, block: /\/\*[\s\S]*?(?:\*\/|$)/, line: /\/\/[^\n]*/, backtick: true },
    php: { kw: KW.php, block: /\/\*[\s\S]*?(?:\*\/|$)/, line: /\/\/[^\n]*|#[^\n]*/, vars: /\$\w+/ },
    py: { kw: KW.py, line: /#[^\n]*/, triple: true },
    sh: { kw: KW.sh, line: /(?<![\w$\\])#[^\n]*/, vars: /\$\{[^}\n]*\}|\$\w+|\$[@*#?$!0-9]/, flags: true, dash: true, noDecorator: true },
    ps: { kw: KW.ps, block: /<#[\s\S]*?(?:#>|$)/, line: /#[^\n]*/, vars: /\$[\w:]+|\$\{[^}\n]*\}/, flags: true, ci: true, ps: true, dash: true },
    sql: { kw: KW.sql, block: /\/\*[\s\S]*?(?:\*\/|$)/, line: /--[^\n]*/, ci: true },
    bat: { kw: KW.bat, vars: /%[\w~:]+%|%%?\w/, ci: true, noDecorator: true },
  };
  CFG.generic = { kw: new Set([...KW.js, ...KW.py, ...KW.c, ...KW.rs, ...KW.go]), block: /\/\*[\s\S]*?(?:\*\/|$)/, line: /\/\/[^\n]*|#[^\n]*/ };

  function highlight(text, lang) {
    text = String(text || '');
    if (text.length > 80000) return esc(text);
    const raw = (lang || '').toLowerCase();
    const l = ALIAS[raw] || raw;
    try {
      if (l === 'html') return html(text);
      if (l === 'css') return css(text);
      if (l === 'json') return json(text);
      if (l === 'yaml') return yaml(text);
      if (l === 'diff') return diff(text);
      if (l === 'bat') return bat(text);
      if (['md', 'text', 'txt', 'plain', 'plaintext', 'log', 'output'].includes(l)) return esc(text);
      if (!l && /^\s*</.test(text) && /<\/?[a-z][\s\S]*>/i.test(text)) return html(text);
      if (!l && /^\s*[{[]/.test(text)) return json(text);
      return scan(text, CFG[l] || CFG.generic);
    } catch (e) {
      return esc(text);
    }
  }

  window.HL = { highlight };
})();
