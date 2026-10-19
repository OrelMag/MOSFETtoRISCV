// The instruction composer in the program editor of an RV32 ROM: Ctrl+Space (or the footer's
// button) opens it under the source on the caret's line, with that line's instruction, its address
// and the program's labels; Replace writes the line back (its label, indentation and comment kept),
// Insert adds a line below. Each is one native undo step in the code editor. The composer is
// loaded on first use (its own chunk).

import { assemble } from '../riscv/asm';
import { h } from '../ui/dom';
import type { CodeEditor } from '../widgets/codeedit';
import type { Composer } from '../widgets/composer';

const LABELS = /^(\s*(?:[A-Za-z_.$][\w.$]*\s*:\s*)*)([^#]*?)(\s*#.*)?$/;

/** A line split into its label prefix (with indentation), code and trailing comment. */
export function splitLine(line: string): { prefix: string; code: string; comment: string } {
  const m = line.match(LABELS)!;
  return { prefix: m[1], code: m[2].trim(), comment: m[3] ?? '' };
}

/** Line n rewritten around new code: the label, indentation and comment stay. */
export function withCode(line: string, code: string, tab = 8): string {
  const { prefix, code: old, comment } = splitLine(line);
  return `${prefix || (old ? '' : ' '.repeat(tab))}${code}${comment && !/^\s/.test(comment) ? ' ' : ''}${comment}`;
}

/** Indentation for a new line of code after `line`: its code column (past a label: at least a tab stop). */
export function codeIndent(line: string, tab = 8): string {
  const { prefix, code } = splitLine(line);
  if (prefix.trim()) return ' '.repeat(Math.max(prefix.length, tab));
  if (prefix || code) return prefix;
  return ' '.repeat(tab);
}

export interface RomComposer {
  /** The footer's button. */
  button: HTMLElement;
  open(): void;
  /** Close it if open (true: it was). */
  close(): boolean;
  readonly isOpen: boolean;
}

export function romComposer(ce: CodeEditor, body: HTMLElement, toast: (m: string) => void): RomComposer {
  let pane: HTMLElement | null = null;
  let seq = 0;

  const close = () => {
    if (!pane) return false;
    pane.remove();
    pane = null;
    body.classList.remove('composing');
    ce.focus();
    return true;
  };

  const open = async () => {
    const my = ++seq;
    const n = ce.caretLine();
    const src = ce.value;
    const lines = src.split('\n');
    const line = lines[n - 1] ?? '';
    const { code } = splitLine(line);
    const r = assemble(src);
    const here = r.lines.filter((l) => l.srcLine === n);
    const broken = r.errors.some((e) => e.line === n);
    // Replace a line holding one instruction (or a broken one); a pseudo-instruction's words, or a
    // line with none (label, comment, blank), get a new line below.
    const canReplace = here.length === 1 || (broken && !!code);
    const after = r.lines.find((l) => l.srcLine > n);
    const pc = here.length ? here[0].addr : after?.addr ?? r.words.length * 4;
    const word = here.length === 1 ? here[0].word : undefined;
    const { instrComposer } = await import('../widgets/composer');
    if (my !== seq) return;
    close();
    const cmp: Composer = instrComposer({ word, pc: canReplace ? pc : here.length ? here[here.length - 1].addr + 4 : pc, labels: r.labels });

    const put = (below: boolean) => {
      if (!cmp.ok) return void toast('Not an instruction this builder writes: fix the word first');
      if (ce.value !== src && ce.value.split('\n')[n - 1] !== line) return void toast(`Line ${n} changed since the builder opened: open it again`);
      if (below) ce.putLine(n, codeIndent(line) + cmp.text, true);
      else ce.putLine(n, withCode(line, cmp.text));
      close();
    };
    const what = here.length > 1 ? `line ${n} is a pseudo-instruction (${here.length} words): a new instruction goes below it`
      : canReplace ? `line ${n}${word === undefined ? ' (does not assemble)' : ''}: ${code || '(empty)'}` : `after line ${n}`;
    pane = h('div', { class: 'sb-rom-cmp', role: 'region', 'aria-label': 'Instruction builder' },
      h('div', { class: 'sb-rom-cmp-head' }, h('b', null, 'Build an instruction'), h('span', null, `· ${what} · address 0x${pc.toString(16)}`), h('span', { class: 'grow' }),
        canReplace ? h('button', { class: 'btn sm primary', title: 'Replace the line (Enter in the builder\'s text box)', onclick: () => put(false) }, `Replace line ${n}`) : null,
        h('button', { class: `btn sm${canReplace ? '' : ' primary'}`, onclick: () => put(true) }, 'Insert below'),
        h('button', { class: 'btn sm ghost', title: 'Close the builder (Esc)', onclick: () => close() }, 'Close')),
      cmp.el);
    pane.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && (e.target as HTMLElement).classList.contains('cmp-in')) { e.preventDefault(); put(!canReplace); }
    });
    body.append(pane);
    body.classList.add('composing');
    ce.reveal(n);
    cmp.focus();
  };

  // Ctrl+Space on the source opens it on the caret's line (before the editor's own keys see it).
  ce.el.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && (e.ctrlKey || e.metaKey) && !e.altKey) { e.preventDefault(); e.stopPropagation(); void open(); }
  }, true);

  const button = h('button', { class: 'btn sm ghost', title: 'Build the instruction on the caret\'s line from its fields (Ctrl+Space)', onclick: () => void open() }, 'Build instruction');
  return { button, open: () => void open(), close, get isOpen() { return !!pane; } };
}
