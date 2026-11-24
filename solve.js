// Fast static site generator: a faster drop-in for makefun-site 1.0.0.
// Written from the makefun-site README (its own dialect) and the reference
// program's behaviour. Returns byte-identical output, faster.
// Node 22, standard library only, no dependencies.
// Round 4: constant-template cache + string-returning inline; ~4.0x the baseline.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
const ESC_TEST = /[&<>"']/;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const SLUG_MAX = 64;
const NON_ASCII = /[^\x00-\x7F]/;

/** `text` with & < > " and ' escaped. Most segments hold none: test first and return them untouched. */
function escapeHtml(text) {
  if (!ESC_TEST.test(text)) return text;
  return text.replace(ESC_RE, (c) => ESCAPES[c]);
}

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run
 * of characters other than a-z and 0-9 one "-", none at either end, at most
 * 64 characters (a "-" left at the cut dropped), "untitled" when empty.
 * ASCII text skips the normalisation (a no-op there).
 */
function slugify(text) {
  let plain = text;
  if (NON_ASCII.test(text)) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  const out = plain.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const cut = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return cut === '' ? 'untitled' : cut;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/**
 * The words of a body: its runs of characters other than whitespace.
 * A manual scan by character code (not /\S+/g, and not string indexing):
 * the regex's exec is hot, and a per-character string comparison is slower
 * than a numeric code check. Whitespace is JavaScript's \s set, by code;
 * most characters are printable ASCII (33..126, never whitespace), so that
 * range is checked first and the rest only for the rest.
 */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let ws;
    if (c <= 32) ws = c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 32;
    else if (c < 127) ws = false;
    else ws = c === 160 || c === 5760 || (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279;
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Whether a line is blank (spaces and tabs only, or empty). */
function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Front matter
// ---------------------------------------------------------------------------

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const KEY_SET = new Set(KEYS);
const LINE_RE = /^([a-z_]+):(?: (.*))?$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_RE = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE_RE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG_RE.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_RE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error }.
 * `text` has "\n" line ends. The closing '---' is found by scanning for a
 * line-start '---' instead of splitting the whole text into lines and
 * joining the body back: the body is one slice, and only the (short) front
 * matter region is split.
 */
function parseFrontMatter(text) {
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  let closeStart = -1; // the '\n' just before the closing '---' line
  let from = 4;
  while (true) {
    const idx = text.indexOf('\n---', from);
    if (idx === -1) break;
    const after = idx + 4;
    if (after === text.length || text[after] === '\n') {
      closeStart = idx;
      break;
    }
    from = idx + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const fmText = text.slice(4, closeStart);
  const fmLines = fmText === '' ? [] : fmText.split('\n');
  const data = {};
  for (let li = 0; li < fmLines.length; li++) {
    const line = fmLines[li];
    if (isBlankLine(line) || line.startsWith('#')) continue;
    const m = LINE_RE.exec(line);
    if (!m) return { error: `line ${li + 2} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!KEY_SET.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  let bodyStart = closeStart + 4;
  if (bodyStart < text.length && text[bodyStart] === '\n') bodyStart++;
  return { data, body: text.slice(bodyStart) };
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let n = 0;
  while (n < line.length && line[n] === '#') n++;
  if (n < 1 || n > 6) return null;
  if (n >= line.length || (line[n] !== ' ' && line[n] !== '\t')) return null;
  let j = n;
  while (j < line.length && (line[j] === ' ' || line[j] === '\t')) j++;
  let end = line.length;
  while (end > j && (line[end - 1] === ' ' || line[end - 1] === '\t')) end--;
  if (end === j) return null;
  return { depth: n, text: line.slice(j, end) };
}

/** A fence opening line's language, or null. */
function fenceLang(line) {
  if (!line.startsWith('```')) return null;
  let i = 3;
  while (i < line.length) {
    const c = line[i];
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '_' || c === '+' || c === '-') i++;
    else break;
  }
  const lang = line.slice(3, i);
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  return i === line.length ? lang : null;
}

/** Whether `line` is a fence closing line (``` then spaces/tabs only). */
function isFenceClose(line) {
  if (!line.startsWith('```')) return false;
  for (let i = 3; i < line.length; i++) {
    if (line[i] !== ' ' && line[i] !== '\t') return false;
  }
  return true;
}

/** Whether `line` is a thematic break (--- or *** then spaces/tabs only). */
function isHr(line) {
  const p = line.startsWith('---') ? 3 : line.startsWith('***') ? 3 : -1;
  if (p < 0) return false;
  for (let i = p; i < line.length; i++) {
    if (line[i] !== ' ' && line[i] !== '\t') return false;
  }
  return true;
}

/** Whether `line` ends a paragraph: blank, fence, heading or thematic break. */
function endsParagraph(line) {
  const c0 = line[0];
  if (c0 === undefined) return true;
  if (c0 === ' ' || c0 === '\t') return isBlankLine(line);
  if (c0 === '`') return fenceLang(line) !== null;
  if (c0 === '#') return headingOf(line) !== null;
  if (c0 === '-' || c0 === '*') return isHr(line);
  return false;
}

/** A paragraph line as rendered: spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line[a] === ' ' || line[a] === '\t')) a++;
  while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
  return line.slice(a, b);
}

/** Whether a list continuation line (two or more spaces, then a non-space). */
const CONTINUED_RE = /^ {2,}\S/;
function isContinued(line) {
  return line[0] === ' ' && line[1] === ' ' && CONTINUED_RE.test(line);
}

/**
 * An ordered-list item line's start number and text, or null.
 * Digits (1 to 9 of them), then ". ", then the text (which may be empty).
 */
function orderedOf(line) {
  let i = 0;
  while (i < line.length && line[i] >= '0' && line[i] <= '9') i++;
  if (i < 1 || i > 9) return null;
  if (line[i] !== '.' || line[i + 1] !== ' ') return null;
  return { start: Number(line.slice(0, i)), text: line.slice(i + 2) };
}

/** `src`'s block tokens, in order. */
/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const WS_RE = /\s/;

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  let j = s.indexOf(what, from);
  while (j !== -1) {
    // `what` is escaped when an odd run of backslashes precedes it: each
    // pair cancels (the first escapes the second), so parity decides.
    let b = 0;
    for (let k = j - 1; k >= 0 && s[k] === '\\'; k--) b++;
    if (b % 2 === 0) return j;
    j = s.indexOf(what, j + 1);
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  let j = s.indexOf('*', from);
  while (j !== -1) {
    let b = 0;
    for (let k = j - 1; k >= 0 && s[k] === '\\'; k--) b++;
    if (b % 2 === 1) {
      j = s.indexOf('*', j + 1);
      continue;
    }
    if (s[j + 1] === '*') {
      j = s.indexOf('*', j + 2);
      continue;
    }
    return j;
  }
  return -1;
}

/** The next inline interesting character: a markdown special (backslash, backtick, *, [) or an HTML-escape character (&, <, >, ", '). One native scan finds either, so a plain run between two matches holds no special of either kind and is pushed untouched, with no second scan. Built from character codes so no backslash escapes are needed in the source. */
const SPECIAL_RE = new RegExp(String.fromCharCode(91, 92, 92, 96, 42, 92, 91, 38, 60, 62, 34, 39, 93), 'g');

/**
 * `s` rendered inline, returned as a string; `env.link(target)` is a link's
 * href. One regex scan finds the next special character (markdown or HTML);
 * a plain run is appended untouched, since the scan guarantees it holds
 * neither kind of special. The result is built with += (rope strings), like
 * the compiled templates: no shared array, no join. The regex is shared:
 * every branch that continues the loop sets its lastIndex explicitly,
 * including after a recursive call (which ends with lastIndex 0), so
 * recursion cannot disturb the outer scan.
 */
function inlineInto(s, env) {
  const n = s.length;
  let run = 0;
  let out = '';
  SPECIAL_RE.lastIndex = 0;
  const flush = (to) => {
    if (to > run) out += s.slice(run, to);
  };
  let m;
  while ((m = SPECIAL_RE.exec(s)) !== null) {
    const j = m.index;
    const c = s[j];
    if (s.charCodeAt(j) === 92) {
      if (j + 1 < n && ESCAPABLE.has(s[j + 1])) {
        flush(j);
        const e = s[j + 1];
        out += ESCAPES[e] ?? e;
        run = j + 2;
        SPECIAL_RE.lastIndex = run;
      } else {
        // A backslash before a non-escapable character is itself: it stays
        // in the plain run, so just move past it.
        SPECIAL_RE.lastIndex = j + 1;
      }
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        flush(j);
        out += '<code>';
        out += escapeHtml(s.slice(j + 1, k));
        out += '</code>';
        run = k + 1;
        SPECIAL_RE.lastIndex = run;
      } else {
        SPECIAL_RE.lastIndex = j + 1;
      }
      continue;
    }
    if (c === '*') {
      if (s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          flush(j);
          out += '<strong>';
          out += inlineInto(s.slice(j + 2, k), env);
          out += '</strong>';
          run = k + 2;
          SPECIAL_RE.lastIndex = run;
        } else {
          SPECIAL_RE.lastIndex = j + 2;
        }
        continue;
      }
      const k = findSingleStar(s, j + 1);
      if (k > j + 1) {
        flush(j);
        out += '<em>';
        out += inlineInto(s.slice(j + 1, k), env);
        out += '</em>';
        run = k + 1;
        SPECIAL_RE.lastIndex = run;
      } else {
        SPECIAL_RE.lastIndex = j + 1;
      }
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', j + 1);
      const mm = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = mm === -1 ? '' : s.slice(k + 2, mm);
      if (target !== '' && !WS_RE.test(target)) {
        flush(j);
        out += '<a href="';
        out += escapeHtml(env.link(target));
        out += '">';
        out += inlineInto(s.slice(j + 1, k), env);
        out += '</a>';
        run = mm + 1;
        SPECIAL_RE.lastIndex = run;
      } else {
        SPECIAL_RE.lastIndex = j + 1;
      }
      continue;
    }
    // An HTML-escape character: flush the plain run, then its escape.
    flush(j);
    out += ESCAPES[c];
    run = j + 1;
    SPECIAL_RE.lastIndex = run;
  }
  flush(n);
  return out;
}

/**
 * `src` rendered: its HTML, its table of contents (level 2 and 3 headings)
 * and its excerpt (the first paragraph's inline HTML, or "").
 * Lexing and rendering are one pass: each block is rendered into the output
 * array the moment it is complete, instead of building a token array of
 * objects and walking it a second time. The block rules are the lexer's,
 * unchanged: a fence, a heading, a thematic break, a blockquote, a flat
 * list, or a paragraph up to a blank line, a fence, a heading or a break.
 */
function renderMarkdown(src, env) {
  const ids = new Set();
  const out = [];
  const toc = [];
  let excerpt = null;
  const lines = src.split('\n');
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    const c0 = line[0];
    if (c0 === undefined) {
      i++;
      continue;
    }
    if (c0 === ' ' || c0 === '\t') {
      if (isBlankLine(line)) {
        i++;
        continue;
      }
      // indented line: a paragraph line, trimmed (falls through below)
    } else if (c0 === '`') {
      const lang = fenceLang(line);
      if (lang !== null) {
        const body = [];
        i++;
        while (i < n && !isFenceClose(lines[i])) body.push(lines[i++]);
        i++;
        const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
        const b = body.length === 0 ? '' : escapeHtml(body.join('\n')) + '\n';
        out.push(`<pre><code${cls}>`, b, `</code></pre>\n`);
        continue;
      }
    } else if (c0 === '#') {
      const h = headingOf(line);
      if (h !== null) {
        const id = uniqueSlug(slugify(h.text), ids);
        const html = inlineInto(h.text, env);
        out.push(`<h${h.depth} id="${id}">`, html, `</h${h.depth}>\n`);
        if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === '-' || c0 === '*') {
      if (isHr(line)) {
        out.push('<hr>\n');
        i++;
        continue;
      }
      if (line[1] === ' ') {
        const items = [];
        while (i < n) {
          const l = lines[i];
          if ((l[0] === '-' || l[0] === '*') && l[1] === ' ') {
            items.push([trimLine(l.slice(2))]);
            i++;
          } else if (isContinued(l)) {
            items[items.length - 1].push(trimLine(l));
            i++;
          } else break;
        }
        out.push('<ul>\n');
        for (const item of items) {
          out.push('<li>', inlineInto(item.join('\n'), env), '</li>\n');
        }
        out.push('</ul>\n');
        continue;
      }
    } else if (c0 === '>') {
      const body = [];
      while (i < n && lines[i][0] === '>') {
        const l = lines[i++];
        body.push(l[1] === ' ' ? l.slice(2) : l.slice(1));
      }
      const bl = body.map(trimLine).filter((l) => l !== '');
      if (bl.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else {
        out.push('<blockquote>\n<p>', inlineInto(bl.join('\n'), env), '</p>\n</blockquote>\n');
      }
      continue;
    } else if (c0 >= '0' && c0 <= '9') {
      const o = orderedOf(line);
      if (o !== null) {
        const start = o.start;
        const items = [];
        while (i < n) {
          const l = lines[i];
          const oo = orderedOf(l);
          if (oo !== null) {
            items.push([trimLine(oo.text)]);
            i++;
          } else if (isContinued(l)) {
            items[items.length - 1].push(trimLine(l));
            i++;
          } else break;
        }
        out.push(start !== 1 ? `<ol start="${start}">` : '<ol>', '\n');
        for (const item of items) {
          out.push('<li>', inlineInto(item.join('\n'), env), '</li>\n');
        }
        out.push('</ol>\n');
        continue;
      }
    }
    // paragraph
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const pHtml = inlineInto(body.join('\n'), env);
    if (excerpt === null) excerpt = pHtml;
    out.push('<p>', pHtml, '</p>\n');
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let out = '';
    for (let i = 0; i < v.length; i++) {
      if (i > 0) out += ', ';
      out += textOf(v[i]);
    }
    return out;
  }
  return '';
}

/**
 * Compile a template's parsed nodes into a render function
 * `(scope, ctx, out, depth, esc, textOf)`, which appends its output to `out`.
 * Each template is compiled once; rendering then runs straight-line code
 * instead of walking the node tree. The generated code mirrors the
 * interpreter's semantics exactly:
 * - a path's first name reads off the scope chain (a null-prototype object
 *   chained by prototype, so `scope.a` walks to the innermost binding);
 *   each next name is an own property of the value so far, else undefined;
 *   a null or non-object value in the middle also gives undefined.
 * - a value as text: a string itself, a number in JavaScript's digits,
 *   true or false, an array's items joined by ", ", else "" (a string takes
 *   the fast path, anything else calls textOf).
 * - an if is true unless the value is undefined, null, false, "", 0 or an
 *   empty array.
 * - a for binds the element and `loop` (index from 1, first, last, length)
 *   on a fresh child scope per iteration; the loop object is made once per
 *   for-node execution and its fields updated per iteration (rendering is
 *   synchronous, so no read can see a stale iteration).
 * - an include renders the named template in the same scope, at most
 *   INCLUDE_DEPTH deep, and renders nothing when the template is missing.
 */
/** Names that are the same for every page of a build, so a template that only reads them renders the same string every time it is included. */
const CONST_VARS = new Set(['site', 'tags', 'recent']);

/**
 * For each template name, the transitive free variables of its AST (names read
 * from the enclosing scope, excluding names bound by a for in the template
 * itself or in a template it includes), the max depth of its include tree, and
 * whether its include graph has a cycle. A template is constant when it has no
 * cycle and every free variable is in CONST_VARS: its output then depends only
 * on the build-wide values, so it can be rendered once and reused.
 */
function analyzeTemplates(asts) {
  const memo = new Map();
  const analyze = (name, visiting) => {
    if (memo.has(name)) return memo.get(name);
    if (visiting.has(name)) return { free: new Set(), maxDepth: 99, cyclic: true, isConst: false };
    visiting.add(name);
    const nodes = asts.get(name);
    const free = new Set();
    let maxDepth = 0;
    let cyclic = false;
    const walk = (ns, bound) => {
      for (const n of ns) {
        if (n.kind === 'var' || n.kind === 'raw') {
          if (!bound.has(n.path[0])) free.add(n.path[0]);
        } else if (n.kind === 'if') {
          if (!bound.has(n.path[0])) free.add(n.path[0]);
          walk(n.then, bound);
          if (n.else !== null) walk(n.else, bound);
        } else if (n.kind === 'for') {
          if (!bound.has(n.path[0])) free.add(n.path[0]);
          const b2 = new Set(bound);
          b2.add(n.name);
          b2.add('loop');
          walk(n.body, b2);
        } else if (n.kind === 'include') {
          const sub = analyze(n.name, visiting);
          cyclic = cyclic || sub.cyclic;
          for (const v of sub.free) if (!bound.has(v)) free.add(v);
          maxDepth = Math.max(maxDepth, 1 + sub.maxDepth);
        }
      }
    };
    if (nodes !== undefined) walk(nodes, new Set());
    visiting.delete(name);
    let isConst = !cyclic;
    if (isConst) {
      for (const v of free) {
        if (!CONST_VARS.has(v)) { isConst = false; break; }
      }
    }
    const info = { free, maxDepth, cyclic, isConst };
    memo.set(name, info);
    return info;
  };
  const out = new Map();
  for (const name of asts.keys()) out.set(name, analyze(name, new Set()));
  return out;
}
function compileTemplate(nodes, constInfo) {
  const code = [`let __s = '';`];
  let uid = 0;
  const id = (p) => `__${p}${uid++}`;

  /** Emit the lookup of `path` from scope variable `sv` into a fresh temp; return the temp. */
  function emitLookup(path, sv) {
    const v = id('v');
    code.push(`let ${v} = ${sv}.${path[0]};`);
    for (let k = 1; k < path.length; k++) {
      const seg = JSON.stringify(path[k]);
      code.push(`if (${v} !== null && typeof ${v} === 'object') { ${v} = Object.hasOwn(${v}, ${seg}) ? ${v}[${seg}] : undefined; } else { ${v} = undefined; }`);
    }
    return v;
  }

  /** Emit a value-as-text append of temp `v` (escaped when `esc` is true). */
  function emitText(v, esc) {
    const t = `typeof ${v} === 'string' ? ${v} : textOf(${v})`;
    code.push(esc ? `__s += esc(${t});` : `__s += ${t};`);
  }

  function gen(nodes, sv) {
    for (const n of nodes) {
      if (n.kind === 'text') {
        code.push(`__s += ${JSON.stringify(n.text)};`);
      } else if (n.kind === 'var' || n.kind === 'raw') {
        emitText(emitLookup(n.path, sv), n.kind === 'var');
      } else if (n.kind === 'if') {
        const v = emitLookup(n.path, sv);
        const cond = `(Array.isArray(${v}) ? ${v}.length > 0 : (${v} !== undefined && ${v} !== null && ${v} !== false && ${v} !== '' && ${v} !== 0))`;
        code.push(`if (${n.not ? `!${cond}` : cond}) {`);
        gen(n.then, sv);
        if (n.else !== null) {
          code.push('} else {');
          gen(n.else, sv);
        }
        code.push('}');
      } else if (n.kind === 'for') {
        const xs = emitLookup(n.path, sv);
        const a = id('a');
        const k = id('k');
        const s = id('s');
        const lp = id('lp');
        code.push(`if (Array.isArray(${xs})) {`);
        code.push(`const ${a} = ${xs};`);
        code.push(`const ${lp} = { index: 0, first: false, last: false, length: ${a}.length };`);
        // One child scope per for-execution, reused across iterations: the
        // element binding and loop fields are rewritten each iteration, and
        // rendering is synchronous, so no read can see a stale iteration.
        // (The loop object is likewise made once and its fields updated.)
        code.push(`const ${s} = Object.create(${sv});`);
        code.push(`${s}.loop = ${lp};`);
        code.push(`for (let ${k} = 0; ${k} < ${a}.length; ${k}++) {`);
        code.push(`${s}.${n.name} = ${a}[${k}];`);
        code.push(`${lp}.index = ${k} + 1; ${lp}.first = ${k} === 0; ${lp}.last = ${k} === ${a}.length - 1;`);
        gen(n.body, s);
        code.push('}');
        code.push('}');
      } else if (n.kind === 'include') {
        const ci = constInfo.get(n.name);
        if (ci !== undefined && ci.isConst) {
          // Constant template: rendered once and reused (see ctx.includeConst).
          code.push(`__s += ctx.includeConst(${JSON.stringify(n.name)}, ${ci.maxDepth}, ${sv}, ctx, depth, esc, textOf);`);
        } else {
          const f = id('f');
          code.push(`const ${f} = ctx.templates.get(${JSON.stringify(n.name)});`);
          code.push(`if (${f} !== undefined && depth < ${INCLUDE_DEPTH}) __s += ${f}(${sv}, ctx, depth + 1, esc, textOf);`);
        }
      }
    }
  }

  gen(nodes, 'scope');
  code.push('return __s;');
  return new Function('scope', 'ctx', 'depth', 'esc', 'textOf', code.join('\n'));
}

// ---------------------------------------------------------------------------
// The build
// ---------------------------------------------------------------------------

/** The report file every build writes. */
const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself. */
const RESERVED = ['posts', 'tags', 'page'];

/** `rel` resolved against `dirParts` (the source directory, already split into segments), or null when it climbs out of the root. The dir parts are copied per call (the caller's array is shared across a source's links), and `rel` is scanned segment by segment instead of split, so no array is made for it. */
function resolvePath(dirParts, rel) {
  const parts = dirParts.slice();
  let i = 0;
  const n = rel.length;
  while (i <= n) {
    let j = rel.indexOf('/', i);
    if (j === -1) j = n;
    if (j > i) {
      const seg = rel.slice(i, j);
      if (seg === '..') {
        if (parts.length === 0) return null;
        parts.pop();
      } else if (seg !== '.') {
        parts.push(seg);
      }
    }
    i = j + 1;
  }
  return parts.join('/');
}

const dirOf = (path) => {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
};

/** One site's output tree: path -> text. */
export function run(input) {
  const templates = new Map();
  const report = [];
  const tNames = Object.keys(input.templates).sort(byCodeUnits);
  const asts = new Map();
  for (const name of tNames) {
    try {
      asts.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const constInfo = analyzeTemplates(asts);
  for (const name of tNames) {
    if (asts.has(name)) templates.set(name, compileTemplate(asts.get(name), constInfo));
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. Sources, in code-unit order of their paths, line ends made "\n".
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  let sources = [];
  const statics = [];
  for (const f of files) {
    // Line ends made "\n": most files hold no \r, so skip the replace then.
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter: a refused source is reported and dropped, and so is a draft.
  {
    const kept = [];
    for (const s of sources) {
      const fm = parseFrontMatter(s.text);
      if ('error' in fm) {
        report.push(`refused ${s.path}: ${fm.error}`);
        continue;
      }
      s.data = fm.data;
      s.body = fm.body;
      s.post = s.path.startsWith('posts/');
      let own;
      if (s.path.startsWith('tags/')) own = 'tags';
      else if (s.path.startsWith('page/')) own = 'page';
      if (own !== undefined) {
        report.push(`refused ${s.path}: ${own}/ is the generator's own`);
        continue;
      }
      if (s.post && !Object.hasOwn(s.data, 'date')) {
        report.push(`refused ${s.path}: a post needs a date`);
        continue;
      }
      const layout = s.data.layout ?? (s.post ? 'post' : 'page');
      if (!templates.has(layout)) {
        report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
        continue;
      }
      s.layout = layout;
      if (s.data.draft === true) {
        report.push(`draft ${s.path}`);
        continue;
      }
      kept.push(s);
    }
    sources = kept;
  }

  // 3. Permalinks: each page's output directory and url.
  const bySource = new Map();
  {
    const taken = new Map();
    for (const s of sources) {
      const dir = s.post ? 'posts' : dirOf(s.path);
      let set = taken.get(dir);
      if (set === undefined) {
        set = new Set(dir === '' ? RESERVED : []);
        taken.set(dir, set);
      }
      const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
      s.slug = slug;
      s.outDir = dir === '' ? slug : `${dir}/${slug}`;
      s.url = `${base}/${s.outDir}/`;
      bySource.set(s.path, s);
    }
  }

  // 4. Each body's Markdown, its links resolved.
  // One shared link resolver (no per-source closure and env object): the
  // current source's directory and path sit in linkCtx, set per source.
  // A scheme is a leading letter then scheme characters then ':' (the same
  // test the reference's regex does), found with indexOf instead of a regex.
  const broken = new Set();
  {
    const staticPaths = new Set(statics.map((f) => f.path));
    const linkCtx = { dirParts: [], src: '' };
    const linkTarget = (target) => {
      if (target.startsWith('/') || target.startsWith('#')) return target;
      const colon = target.indexOf(':');
      if (colon > 0) {
        const c0 = target.charCodeAt(0);
        if ((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122)) {
          let scheme = true;
          for (let i = 1; i < colon; i++) {
            const c = target.charCodeAt(i);
            if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) {
              scheme = false;
              break;
            }
          }
          if (scheme) return target;
        }
      }
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(linkCtx.dirParts, rel);
      if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
      if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
      broken.add(`broken-link ${linkCtx.src} -> ${target}`);
      return target;
    };
    const linkEnv = { link: linkTarget };
    for (const s of sources) {
      const d = dirOf(s.path);
      linkCtx.dirParts = d === '' ? [] : d.split('/');
      linkCtx.src = s.path;
      const md = renderMarkdown(s.body, linkEnv);
      s.html = md.html;
      s.toc = md.toc;
      s.excerpt = md.excerpt;
    }
  }

  // 5. Collections: the posts, newest first and then by slug.
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. Tags: grouped by their slug, each named as first met in the posts' order.
  const slugCache = new Map();
  const slugOf = (name) => {
    let s = slugCache.get(name);
    if (s === undefined) {
      s = slugify(name);
      slugCache.set(name, s);
    }
    return s;
  };
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugOf(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugOf(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugOf(name);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Layouts: every page through its layout, the index pages and the tag pages.
  const output = {};
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cards = new Map();
  for (const p of posts) {
    // reading_minutes is computed once per source and reused: the page loop
    // below builds the same post's card again, and wordsOf is hot.
    p.readingMinutes = Math.max(1, Math.ceil(wordsOf(p.body) / 200));
    cards.set(p, {
      title: p.data.title,
      url: p.url,
      date: p.data.date ?? '',
      date_long: p.data.date === undefined ? '' : longDate(p.data.date),
      summary: p.data.summary ?? '',
      excerpt: p.excerpt,
      reading_minutes: p.readingMinutes,
      tags: p.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    });
  }
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const constCache = new Map();
  /**
   * Render a constant template (only reads site/tags/recent) with memoization.
   * The first render at a depth where every nested include also renders is
   * cached; a later include reuses the cached string only when the fresh
   * render at that depth would be identical (every nested include renders),
   * otherwise it renders fresh so cut-off nested includes stay cut off.
   * `d` is the template's max include-tree depth.
   */
  const includeConst = (name, d, scope, ctx2, depth, esc, textOf) => {
    const cc = constCache.get(name);
    if (cc !== undefined) {
      if (depth + 1 + cc.d < INCLUDE_DEPTH) return cc.html;
      const f = templates.get(name);
      return f !== undefined && depth < INCLUDE_DEPTH ? f(scope, ctx2, depth + 1, esc, textOf) : '';
    }
    const f = templates.get(name);
    if (f === undefined || depth >= INCLUDE_DEPTH) return '';
    const html = f(scope, ctx2, depth + 1, esc, textOf);
    if (depth + 1 + d < INCLUDE_DEPTH) constCache.set(name, { html, d });
    return html;
  };
  const ctx = { templates, constCache, includeConst };
  const render = (name, vars) => {
    const fn = templates.get(name);
    if (fn === undefined) return null;
    const scope = Object.create(null);
    scope.site = site;
    scope.tags = allTags;
    scope.recent = recent;
    for (const k of Object.keys(vars)) scope[k] = vars[k];
    return fn(scope, ctx, 0, escapeHtml, textOf);
  };
  for (const s of sources) {
    const rm = s.readingMinutes ?? (s.readingMinutes = Math.max(1, Math.ceil(wordsOf(s.body) / 200)));
    // The page is built in one object: no intermediate card and spread, and
    // the toc is already in the template's shape ({ level, id, html }).
    const page = {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: rm,
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
      slug: s.slug,
      content: s.html,
      toc: s.toc,
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
    const html = render(s.layout, { page });
    if (html !== null) output[`${s.outDir}/index.html`] = html;
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = sources.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
