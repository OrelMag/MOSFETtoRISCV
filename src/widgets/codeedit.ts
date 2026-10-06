// A small code editor: a transparent <textarea> (the real editor: caret, selection, undo, IME,
// accessibility) over a highlighted <pre> with identical metrics, plus a line-number gutter that
// carries diagnostics. No dependency: the tokenizer is per line and the whole layer is rebuilt
// on every input (programs here are a few hundred lines at most), with token HTML cached by
// line text.

import { h } from '../ui/dom';
import { tokenize, type CodeLang } from './codetok';

export interface Diagnostic { line: number; message: string; level?: 'error' | 'warn' }

export interface CodeEditorOpts {
  value: string;
  lang: CodeLang;
  onChange?: (v: string) => void;
  readOnly?: boolean;
  /** Visible lines (the box can be resized vertically). */
  rows?: number;
  /** Tab stop / indent width in spaces (default 8 for assembly, the column of the samples). */
  tabSize?: number;
}

export interface CodeEditor {
  el: HTMLElement;
  value: string;
  setDiagnostics(d: Diagnostic[]): void;
  /** Highlight one 1-based line (e.g. the PC's) and scroll it into view; null clears. */
  setActiveLine(n: number | null): void;
  focus(): void;
  destroy(): void;
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ESC[c]);
const LABEL_PREFIX = /^\s*(?:[A-Za-z_.$][\w.$]*\s*:\s*)+/;
/** Start of the line holding offset i (lastIndexOf clamps -1 to 0, which a leading \n would hit). */
const lineStart = (v: string, i: number) => (i > 0 ? v.lastIndexOf('\n', i - 1) + 1 : 0);

export function codeEditor(opts: CodeEditorOpts): CodeEditor {
  const { lang } = opts;
  const tab = opts.tabSize ?? (lang === 'rvasm' ? 8 : 4);
  const ta = h('textarea', {
    class: 'ce-ta', spellcheck: 'false', wrap: 'off', autocomplete: 'off', autocapitalize: 'off',
    'aria-label': lang === 'hex' ? 'hex words' : 'assembly source',
  }) as HTMLTextAreaElement;
  ta.value = opts.value;
  ta.readOnly = !!opts.readOnly;
  const hin = h('div', { class: 'ce-in' });
  const gin = h('div', { class: 'ce-in' });
  const gutter = h('div', { class: 'ce-gutter', 'aria-hidden': 'true' }, gin);
  const el = h('div', { class: `code-edit${opts.readOnly ? ' ro' : ''}`, style: `--rows:${opts.rows ?? 14}` },
    gutter,
    h('div', { class: 'ce-body' }, h('pre', { class: 'ce-hl', 'aria-hidden': 'true' }, hin), ta));

  const cache = new Map<string, string>();
  const tokHtml = (line: string) => {
    let s = cache.get(line);
    if (s === undefined) {
      s = tokenize(line, lang).map((t) => (t.cls ? `<span class="tk-${t.cls}">${esc(t.text)}</span>` : esc(t.text))).join('');
      if (cache.size > 2000) cache.clear(); // unbounded typing history: keep it cheap, not clever
      cache.set(line, s);
    }
    return s;
  };

  let diags = new Map<number, { level: 'error' | 'warn'; message: string }>();
  let active: number | null = null;
  let last = ta.value;
  let gutterKey = '';

  const lineClass = (n: number) => {
    const d = diags.get(n);
    return (d ? (d.level === 'error' ? ' e' : ' w') : '') + (n === active ? ' cur' : '');
  };

  const render = () => {
    const lines = ta.value.split('\n');
    hin.innerHTML = lines.map((l, i) => {
      const d = diags.get(i + 1);
      const msg = d ? `<span class="ce-msg">${esc(d.message.split('\n')[0])}</span>` : '';
      return `<div class="ce-l${lineClass(i + 1)}">${tokHtml(l)}${msg}</div>`;
    }).join('');
    // The gutter only changes with the line count or the diagnostics.
    const key = `${lines.length}|${active}|${[...diags.keys()].join(',')}`;
    if (key !== gutterKey) {
      gutterKey = key;
      gin.innerHTML = lines.map((_, i) => {
        const d = diags.get(i + 1);
        return `<div class="ce-n${lineClass(i + 1)}"${d ? ` title="${esc(d.message)}"` : ''}>${i + 1}</div>`;
      }).join('');
    }
    sync();
  };

  const sync = () => {
    hin.style.transform = `translate(${-ta.scrollLeft}px, ${-ta.scrollTop}px)`;
    gin.style.transform = `translateY(${-ta.scrollTop}px)`;
  };

  const changed = () => {
    if (ta.value === last) return;
    last = ta.value;
    render();
    opts.onChange?.(last);
  };

  /** Replace [start, end) and select [s0, s1), through the browser's editing command when it
   *  exists so the edit lands on the native undo stack. */
  const edit = (start: number, end: number, text: string, s0: number, s1: number) => {
    ta.focus();
    ta.setSelectionRange(start, end);
    const ok = text ? document.execCommand('insertText', false, text) : start === end || document.execCommand('delete');
    if (!ok) ta.setRangeText(text, start, end, 'end');
    ta.setSelectionRange(s0, s1);
    changed();
  };

  /** The whole lines the selection touches (a selection ending at column 0 excludes that line). */
  const block = () => {
    const v = ta.value, s = ta.selectionStart, e = ta.selectionEnd;
    const a = lineStart(v, s);
    let b = v.indexOf('\n', e > s && v[e - 1] === '\n' ? e - 1 : e);
    if (b < 0) b = v.length;
    return { a, b, s, e, lines: v.slice(a, b).split('\n') };
  };

  const rewrite = (map: (l: string) => string) => {
    const { a, b, s, e, lines } = block();
    const out = lines.map(map);
    const text = out.join('\n');
    if (out.every((l, i) => l === lines[i])) return;
    if (s === e) {
      const c = Math.max(a, s + out[0].length - lines[0].length);
      edit(a, b, text, c, c);
    } else edit(a, b, text, a, a + text.length);
  };

  const outdent = (l: string) => l.replace(new RegExp(`^(\\t| {1,${tab}})`), '');

  const toggleComment = () => {
    const { lines } = block();
    const code = lines.filter((l) => l.trim());
    if (!code.length) return;
    const all = code.every((l) => /^\s*#/.test(l));
    const ind = Math.min(...code.map((l) => l.match(/^\s*/)![0].length));
    rewrite(all ? (l) => l.replace(/^(\s*)# ?/, '$1') : (l) => (l.trim() ? `${l.slice(0, ind)}# ${l.slice(ind)}` : l));
  };

  const onKey = (ev: KeyboardEvent) => {
    if (ta.readOnly || ev.isComposing) return;
    const mod = ev.ctrlKey || ev.metaKey;
    if (ev.key === 'Tab' && !mod && !ev.altKey) {
      ev.preventDefault();
      const s = ta.selectionStart, e = ta.selectionEnd;
      if (ev.shiftKey) rewrite(outdent);
      else if (ta.value.slice(s, e).includes('\n')) rewrite((l) => (l.trim() ? ' '.repeat(tab) + l : l));
      else {
        const col = s - lineStart(ta.value, s);
        const pad = ' '.repeat(tab - (col % tab));
        edit(s, e, pad, s + pad.length, s + pad.length);
      }
    } else if (ev.key === 'Enter' && !mod && !ev.altKey && !ev.shiftKey) {
      ev.preventDefault();
      const s = ta.selectionStart, e = ta.selectionEnd, v = ta.value;
      const head = v.slice(lineStart(v, s), s);
      let ind = head.match(/^[ \t]*/)![0];
      // After "loop:   add ..." continue in the mnemonic column; after a bare "loop:", one stop in.
      const lab = lang === 'rvasm' ? head.match(LABEL_PREFIX) : null;
      if (lab) ind = ' '.repeat(head.slice(lab[0].length).trim() ? lab[0].length : tab);
      edit(s, e, '\n' + ind, s + 1 + ind.length, s + 1 + ind.length);
    } else if (mod && ev.key === '/') {
      ev.preventDefault();
      toggleComment();
    }
  };

  ta.addEventListener('input', changed);
  ta.addEventListener('scroll', sync);
  ta.addEventListener('keydown', onKey);
  // Clicking a line number puts the caret at the start of that line.
  gutter.addEventListener('mousedown', (ev) => {
    const n = [...gin.children].indexOf(ev.target as Element);
    if (n < 0) return;
    ev.preventDefault();
    const at = ta.value.split('\n').slice(0, n).reduce((p, l) => p + l.length + 1, 0);
    ta.focus();
    ta.setSelectionRange(at, at);
  });

  render();

  const lineHeight = () => parseFloat(getComputedStyle(ta).lineHeight) || 18;

  return {
    el,
    get value() { return ta.value; },
    set value(v: string) {
      ta.value = v;
      last = v;
      render();
    },
    setDiagnostics(d) {
      diags = new Map();
      gutterKey = '';
      for (const x of d) {
        const prev = diags.get(x.line);
        const level = x.level ?? 'error';
        diags.set(x.line, prev
          ? { level: prev.level === 'error' || level === 'error' ? 'error' : 'warn', message: `${prev.message}\n${x.message}` }
          : { level, message: x.message });
      }
      render();
    },
    setActiveLine(n) {
      if (n === active) return;
      active = n;
      render();
      if (n === null) return;
      const lh = lineHeight(), pad = parseFloat(getComputedStyle(ta).paddingTop) || 0;
      const top = pad + (n - 1) * lh;
      if (top < ta.scrollTop + pad || top + lh > ta.scrollTop + ta.clientHeight - pad) {
        ta.scrollTop = Math.max(0, top - ta.clientHeight / 3);
        sync();
      }
    },
    focus() { ta.focus(); },
    destroy() {
      ta.removeEventListener('input', changed);
      ta.removeEventListener('scroll', sync);
      ta.removeEventListener('keydown', onKey);
      cache.clear();
      el.remove();
    },
  };
}
