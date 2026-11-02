// The microcode painter: the multicycle controller's microwords as a grid of cells (lib/ucode.ts is the model).
// A dialog in the sandbox (editor/ucodeui.ts) and a sheet under the chapter's stage; either way the same grid, the
// selected word explained with the datapath it drives lit, and the check against the golden model
// (lib/ucodecheck.ts) before Apply. The grid is a real grid: arrow keys move, Space / Enter paint (a multi-bit cell
// cycles its named values, Shift reverses), digits set a value, Delete clears; a mouse drag down a column paints it.

import '../styles/ucode.css';
import { MC_PROGRAM, type McState } from '../lib/multicycle';
import {
  addWord, bookProgram, changedCell, changedDispatch, changedNext, changedWord, CLASS_NAMES, cycleField, doesOf, MAX_WORDS, nextText, removeLast,
  sameProgram, seqOf, SEQ_NAMES, setDispatch, setField, setNext, setSeq, U_COLUMNS, unitsLit, validate, WORD_BITS, type Microprogram, type UColumn,
} from '../lib/ucode';
import { bookReport, checkProgram, type UcodeReport } from '../lib/ucodecheck';
import { h, icon, s } from '../ui/dom';

export interface PainterOptions {
  /** The program the CPU runs now. */
  program: Microprogram;
  /** Where the dialog goes (the editor's element, or the chapter page). */
  host: HTMLElement;
  /** 'sheet': under the stage with no backdrop (the stage shows the lit units); default a modal dialog. */
  mode?: 'dialog' | 'sheet';
  subtitle?: string;
  applyLabel?: string;
  /** Apply: the CPU is rebuilt from this program. `report`: the last check of exactly this program, if any. */
  onApply(p: Microprogram, report: UcodeReport | null): void;
  /** The selected word's units (instance names of the CPU), or null when the painter closes: light them on a real stage. */
  onHighlight?(units: string[] | null): void;
  /** A check of the edited program finished (the book's report beside it). */
  onChecked?(report: UcodeReport, book: UcodeReport, p: Microprogram): void;
  onClose?(): void;
}

const CLASS_LABEL: Record<string, string> = { LOAD: 'load', STORE: 'store', R: 'R-type', I: 'I-type', JAL: 'jal', BRANCH: 'branch', JALR: 'jalr', LUI: 'lui', AUIPC: 'auipc' };
const NAMED = new Set(['resultSrc', 'aluSrcA', 'aluSrcB']);
const nCols = U_COLUMNS.length + 2;

let current: HTMLElement | null = null;

/** The datapath sketch: blocks and links, lit where the word drives them. */
const BLOCKS: Record<string, [number, number, number, number, string, string[]]> = {
  pc: [6, 12, 36, 26, 'PC', ['pc']], mem: [64, 8, 70, 40, 'Memory', ['imem', 'dm']], ir: [160, 6, 34, 20, 'IR', ['ir']], oldpc: [160, 30, 34, 20, 'OldPC', ['oldpc']],
  data: [64, 74, 46, 22, 'Data', ['data']], rf: [140, 74, 54, 48, 'Regs', ['rf']], ra: [212, 74, 28, 20, 'A', ['ra']], rb: [212, 100, 28, 20, 'B', ['rb']],
  imm: [140, 138, 54, 22, 'imm', ['imm']], srcA: [262, 46, 22, 40, 'SrcA', ['srcA']], srcB: [262, 94, 22, 50, 'SrcB', ['srcB']],
  alu: [302, 62, 44, 62, 'ALU', ['alu']], aluout: [362, 62, 40, 24, 'ALUOut', ['aluout']], res: [362, 104, 40, 40, 'Result', ['res']],
};

function sketch(st: McState, lit: Set<string>): SVGSVGElement {
  const g = (f: string) => st.sig[f] ?? 0;
  const result = g('regWrite') || g('pcUpdate') || g('branch');
  const on = (k: string) => BLOCKS[k][5].some((u) => lit.has(u));
  const pt = (k: string, side: 'l' | 'r' | 't' | 'b', d = 0): [number, number] => {
    const [x, y, w, hh] = BLOCKS[k];
    return side === 'r' ? [x + w, y + hh / 2 + d] : side === 'l' ? [x, y + hh / 2 + d] : side === 'b' ? [x + w / 2 + d, y + hh] : [x + w / 2 + d, y];
  };
  const parts: SVGElement[] = [];
  const link = (a: [number, number], b: [number, number], litOn: boolean, mid?: number) => {
    const mx = mid ?? (a[0] + b[0]) / 2;
    parts.push(s('path', { class: litOn ? 'lit' : '', d: `M${a[0]} ${a[1]}H${mx}V${b[1]}H${b[0]}` }));
  };
  link(pt('pc', 'r'), pt('mem', 'l', -8), g('adrSrc') === 0);
  link(pt('mem', 'r', -10), pt('ir', 'l'), !!g('irWrite'));
  link(pt('mem', 'b', -12), pt('data', 't', -4), g('adrSrc') === 1 && !g('memWrite'), undefined);
  link(pt('ra', 'r'), pt('srcA', 'l', 8), g('aluSrcA') === 2);
  link(pt('oldpc', 'r'), pt('srcA', 'l', -8), g('aluSrcA') === 1, 252);
  link(pt('rb', 'r'), pt('srcB', 'l', -14), g('aluSrcB') === 0);
  link(pt('imm', 'r'), pt('srcB', 'l', 6), g('aluSrcB') === 1, 250);
  link(pt('srcA', 'r'), pt('alu', 'l', -14), true);
  link(pt('srcB', 'r'), pt('alu', 'l', 14), true);
  link(pt('alu', 'r'), pt('aluout', 'l'), true);
  link(pt('alu', 'r', 10), pt('res', 'l', -10), !!result && g('resultSrc') === 2, 352);
  link(pt('aluout', 'b'), pt('res', 't'), !!result && g('resultSrc') === 0);
  link(pt('data', 'b'), pt('res', 'b'), !!result && g('resultSrc') === 1, 170);
  link(pt('rf', 'r', -22), pt('ra', 'l'), g('aluSrcA') === 2);
  link(pt('res', 'r'), [412, 168], !!g('regWrite'));
  const names = [...Object.keys(BLOCKS).filter(on).map((k) => BLOCKS[k][4])];
  for (const [k, [x, y, w, hh, n]] of Object.entries(BLOCKS)) {
    parts.push(s('g', { class: on(k) ? 'lit' : '' }, s('rect', { x, y, width: w, height: hh, rx: 5 }), s('text', { x: x + w / 2, y: y + hh / 2 }, n)));
  }
  return s('svg', { class: 'uc-dp', viewBox: '0 0 420 172', role: 'img', 'aria-label': `Datapath sketch. Driven by this word: ${names.join(', ') || 'nothing'}` }, parts);
}

const cellText = (c: UColumn, v: number) => (NAMED.has(c.field) ? (c.names?.[v] ?? String(v)) : '');

export function openMicrocode(o: PainterOptions): { close(): void } {
  current?.remove();
  const book = MC_PROGRAM;
  let prog = structuredClone(o.program);
  const undo: Microprogram[] = [];
  let sel = Math.min(o.program.states.length - 1, 8);
  let focus: [number, number] = [sel, 0];
  let report: UcodeReport | null = null, reportOf: Microprogram | null = null, running = false;
  let bookRep: UcodeReport | null = null;
  const abort = { aborted: false };

  const grid = h('div', { class: 'uc-grid', role: 'grid', 'aria-label': 'Microwords', 'aria-rowcount': String(prog.states.length + 1) });
  const gridWrap = h('div', { class: 'uc-gridwrap' }, grid);
  const dispatchEl = h('div', { class: 'uc-dispatch' });
  const problemsEl = h('div', { class: 'uc-probs', role: 'status' });
  const wordHead = h('div', { class: 'uc-k' });
  const wordText = h('div', { class: 'uc-does' });
  const figure = h('figure', { class: 'uc-fig' });
  const checkEl = h('section', { class: 'uc-check', 'aria-label': 'Check', 'aria-live': 'polite' });
  const sub = h('span', { class: 'uc-sub' });
  const undoBtn = h('button', { type: 'button', class: 'btn ghost sm', onclick: () => doUndo() }, icon('undo', 14), 'Undo') as HTMLButtonElement;
  const resetBtn = h('button', { type: 'button', class: 'btn ghost sm', onclick: () => edit(() => bookProgram()) }, icon('reset', 14), 'Reset to the book\'s') as HTMLButtonElement;
  const addBtn = h('button', { type: 'button', class: 'btn ghost sm', title: `Add an empty word at the end (up to ${MAX_WORDS}: the µPC is 4 bits)`, onclick: () => edit(addWord) }, icon('plus', 14), 'Word') as HTMLButtonElement;
  const dropBtn = h('button', { type: 'button', class: 'btn ghost sm', title: 'Remove the last word', onclick: () => edit(removeLast) }, icon('minus', 14), 'Word') as HTMLButtonElement;
  const checkBtn = h('button', { type: 'button', class: 'btn sm', onclick: () => void runCheck() }, icon('play', 13), 'Run the check') as HTMLButtonElement;
  const applyBtn = h('button', { type: 'button', class: 'btn sm primary', onclick: () => apply() }, o.applyLabel ?? 'Apply to the CPU') as HTMLButtonElement;

  const close = () => {
    abort.aborted = true;
    root.remove();
    if (current === root) current = null;
    o.onHighlight?.(null);
    o.onClose?.();
  };

  const changedCount = () => prog.states.reduce((a, _, i) => a + (changedWord(prog, i) || i >= book.states.length ? 1 : 0), 0) + (changedDispatch(prog) ? 1 : 0);

  function edit(f: (p: Microprogram) => Microprogram, keepUndo = true): void {
    const next = f(prog);
    if (sameProgram(next, prog) && JSON.stringify(next) === JSON.stringify(prog)) return;
    if (keepUndo) undo.push(prog);
    prog = next;
    if (sel >= prog.states.length) sel = prog.states.length - 1;
    if (focus[0] >= prog.states.length) focus = [prog.states.length - 1, focus[1]];
    stale();
    render();
  }
  function doUndo(): void {
    const p = undo.pop();
    if (!p) return;
    prog = p;
    if (sel >= prog.states.length) sel = prog.states.length - 1;
    if (focus[0] >= prog.states.length) focus = [prog.states.length - 1, focus[1]];
    stale();
    render();
  }
  /** An edit makes a finished check out of date. */
  function stale(): void {
    if (report && reportOf && !sameProgram(reportOf, prog)) { report = null; reportOf = null; }
  }

  // ---- the grid ----
  const headRow = () => h('div', { class: 'uc-row uc-head', role: 'row' },
    h('span', { role: 'columnheader' }, '#'), h('span', { role: 'columnheader' }, 'state'),
    ...U_COLUMNS.map((c) => h('span', { role: 'columnheader', title: c.names ? `${c.field}: ${c.names.join(' / ')}` : c.field }, c.head)),
    h('span', { role: 'columnheader', title: 'next-address field (used when the mode is "next")' }, 'next'), h('span', { role: 'columnheader', title: 'sequencing mode: the next field, or a dispatch through a table indexed by the opcode' }, 'seq'));

  function cellFor(i: number, ci: number): HTMLElement {
    const st = prog.states[i];
    const on = i === focus[0] && ci === focus[1];
    const attrs: Record<string, unknown> = { role: 'gridcell', tabindex: on ? '0' : '-1', 'data-r': String(i), 'data-c': String(ci) };
    if (ci < U_COLUMNS.length) {
      const c = U_COLUMNS[ci], v = st.sig[c.field] ?? 0, chg = changedCell(prog, i, c.field);
      const named = NAMED.has(c.field);
      return h('span', {
        ...attrs, class: `uc-cell ${named ? 'named' : 'bit'}${v ? ' on' : ''}${chg ? ' chg' : ''}`,
        'aria-label': `${st.name}, ${c.field}: ${named ? c.names![v] : v}${chg ? ', changed from the book' : ''}`,
      }, named ? cellText(c, v) : '');
    }
    if (ci === U_COLUMNS.length) {
      const chg = changedNext(prog, i);
      return h('span', { ...attrs, class: `uc-cell txt${chg ? ' chg' : ''}`, title: 'Click: next state; Shift+click or right-click: previous; or type a digit', 'aria-label': `${st.name}, next address: ${typeof st.next === 'number' ? `${st.next}, ${prog.states[st.next]?.name}` : 'not used, the dispatch picks'}${chg ? ', changed from the book' : ''}` },
        typeof st.next === 'number' ? String(st.next) : '—');
    }
    const chg = changedNext(prog, i);
    return h('span', { ...attrs, class: `uc-cell txt seq${chg ? ' chg' : ''}`, 'aria-label': `${st.name}, sequencing: ${SEQ_NAMES[seqOf(st)]}` }, SEQ_NAMES[seqOf(st)]);
  }

  function render(): void {
    grid.setAttribute('aria-rowcount', String(prog.states.length + 1));
    const rows = prog.states.map((st, i) => {
      const edited = changedWord(prog, i) || i >= book.states.length;
      const row = h('div', { class: `uc-row${i === sel ? ' sel' : ''}${edited ? ' edited' : ''}`, role: 'row', 'aria-selected': String(i === sel), 'data-r': String(i) },
        h('span', { class: 'uc-i', role: 'rowheader' }, String(i)), h('span', { class: 'uc-n', role: 'rowheader' }, st.name),
        ...Array.from({ length: nCols }, (_, ci) => cellFor(i, ci)));
      return row;
    });
    grid.replaceChildren(headRow(), ...rows);
    const hadFocus = root.contains(document.activeElement) && (document.activeElement as HTMLElement)?.closest?.('.uc-grid');
    if (hadFocus || pendingFocus) { pendingFocus = false; (grid.querySelector(`[data-r="${focus[0]}"][data-c="${focus[1]}"]`) as HTMLElement | null)?.focus({ preventScroll: false }); }
    renderDispatch();
    renderSide();
    undoBtn.disabled = !undo.length;
    resetBtn.disabled = sameProgram(prog, book);
    addBtn.disabled = prog.states.length >= MAX_WORDS;
    dropBtn.disabled = prog.states.length <= 2;
    const n = changedCount();
    sub.textContent = `multicycle RV32I · ${prog.states.length} microwords × ${WORD_BITS} bits · ${n ? `${n} changed from the book` : 'the book\'s microcode'}`;
  }
  let pendingFocus = false;

  function renderDispatch(): void {
    const sel1 = (table: 1 | 2, cls: string, w: number) => {
      const el = h('select', {
        'aria-label': `${table === 1 ? 'Decode' : 'Memory'} dispatch for ${cls}`, class: changedDispatchOf(table, cls, w) ? 'chg' : '',
        onchange: (e: Event) => edit((p) => setDispatch(p, table, cls, Number((e.target as HTMLSelectElement).value))),
      }, prog.states.map((st, i) => h('option', { value: i, selected: i === w }, `${i} ${st.name}`)));
      return h('label', { class: 'uc-d' }, CLASS_LABEL[cls] ?? cls, el);
    };
    dispatchEl.replaceChildren(
      h('div', null, h('b', null, 'Dispatch 1'), ' (opcode → word, after Decode) ', ...prog.dispatch.map(([c, w]) => sel1(1, c, w))),
      h('div', null, h('b', null, 'Dispatch 2'), ' (load / store → word, after MemAdr) ', ...prog.dispatch2.map(([c, w]) => sel1(2, c, w))));
  }
  const changedDispatchOf = (table: 1 | 2, cls: string, w: number) => (table === 1 ? book.dispatch : book.dispatch2).find(([c]) => c === cls)?.[1] !== w;

  function renderSide(): void {
    const st = prog.states[sel];
    const edited = changedWord(prog, sel) || sel >= book.states.length;
    wordHead.textContent = `WORD ${sel} · ${st.name.toUpperCase()}${edited ? ' (EDITED)' : ''}`;
    const was = sel < book.states.length && edited ? `was: ${book.states[sel].does}; next: ${nextText(book, book.states[sel])}` : '';
    wordText.replaceChildren(h('div', null, doesOf(prog, sel)), was ? h('div', { class: 'was' }, was) : '');
    const units = unitsLit(st);
    figure.replaceChildren(sketch(st, new Set(units)), h('figcaption', null, 'Lit: what this word drives.'));
    o.onHighlight?.(units);
    // problems
    const ps = validate(prog);
    problemsEl.replaceChildren(...ps.map((p) => h('div', { class: p.level }, p.text)));
    const bad = ps.some((p) => p.level === 'bad');
    applyBtn.disabled = bad || running;
    checkBtn.disabled = bad || running;
    renderCheck();
  }

  function renderCheck(): void {
    const ps = validate(prog), bad = ps.some((p) => p.level === 'bad');
    checkEl.className = 'uc-check';
    if (running) {
      checkEl.classList.add('run');
      checkEl.replaceChildren(h('strong', null, 'Checking against the golden model…'), h('span', { class: 'uc-prog' }, progress));
      return;
    }
    if (bad) {
      checkEl.classList.add('bad');
      checkEl.replaceChildren(h('strong', null, 'Not runnable'), h('span', null, 'Fix the problems above first: a word list that cannot retire an instruction would only hang the CPU.'));
      return;
    }
    if (!report || !reportOf || !sameProgram(reportOf, prog)) {
      if (sameProgram(prog, book) && bookRep) { showReport(bookRep, bookRep); return; }
      checkEl.replaceChildren(h('strong', null, 'Not checked yet'), h('span', null, 'Run the check: the riscv-tests rv32ui images the multicycle CPU supports and the benchmark programs run on the edited CPU, every result compared with the golden model.'));
      return;
    }
    showReport(report, bookRep);
  }

  function showReport(r: UcodeReport, b: UcodeReport | null): void {
    const pass = r.tests.filter((t) => t.pass).length, benchOk = r.benches.filter((x) => x.ok).length;
    checkEl.classList.add(r.allPass ? 'good' : 'bad');
    const lines: HTMLElement[] = [h('strong', null, r.allPass ? 'Checked against the golden model' : 'Fails against the golden model')];
    lines.push(h('span', null, r.allPass ? `riscv-tests rv32ui: all ${r.tests.length} pass on the edited CPU. Benchmarks: ${benchOk} of ${r.benches.length} end in the golden model's state.`
      : `riscv-tests rv32ui: ${pass} of ${r.tests.length} pass. Benchmarks: ${benchOk} of ${r.benches.length} correct.`));
    if (!r.allPass) {
      const bad = [...r.tests.filter((t) => !t.pass).map((t) => `${t.name} (${t.text})`), ...r.benches.filter((x) => !x.ok).map((x) => `${x.id}: ${x.diff}`)];
      lines.push(h('span', { class: 'uc-fails' }, `Failing: ${bad.slice(0, 4).join('; ')}${bad.length > 4 ? `; and ${bad.length - 4} more` : ''}`));
      if (r.firstMismatch) lines.push(h('span', { class: 'uc-first' }, h('b', null, 'First mismatch '), r.firstMismatch));
    }
    if (b) {
      const diffs = CLASS_NAMES.filter((c) => r.cycles[c] !== b.cycles[c]).map((c) => `${CLASS_LABEL[c]}: ${b.cycles[c]} → ${r.cycles[c] ?? 'never returns'} cycles`);
      lines.push(h('span', null, diffs.length ? diffs.join(' · ') : 'Every instruction class takes the book\'s cycles.'));
      if (r.cpi !== null && b.cpi !== null) lines.push(h('span', null, `CPI on the benchmarks: ${b.cpi.toFixed(2)} → ${r.cpi.toFixed(2)}${r.cpi < b.cpi - 1e-9 ? ` (${Math.round((1 - r.cpi / b.cpi) * 100)} % fewer cycles)` : ''}.`));
      lines.push(h('span', { class: 'uc-muted' }, `Control: ${r.nands.toLocaleString('en').replace(/,/g, ' ')} NANDs in the microcode controller${r.nands === b.nands ? ', unchanged size: the ROMs are constants, the contents cost nothing' : ` (the book's: ${b.nands.toLocaleString('en').replace(/,/g, ' ')})`}.`));
    }
    checkEl.replaceChildren(...lines);
  }

  let progress = '';
  async function runCheck(): Promise<void> {
    if (running) return;
    running = true;
    progress = 'starting…';
    renderSide();
    const mine = structuredClone(prog);
    try {
      if (!bookRep) bookRep = await bookReport({ onProgress: (t) => { progress = `the book's microcode first: ${t}`; renderCheck(); }, signal: abort });
      const r = sameProgram(mine, book) ? bookRep : await checkProgram(mine, { onProgress: (t) => { progress = t; renderCheck(); }, signal: abort });
      running = false;
      if (abort.aborted) return;
      if (sameProgram(mine, prog)) { report = r; reportOf = mine; }
      renderSide();
      o.onChecked?.(r, bookRep, mine);
    } catch (e) {
      running = false;
      if (abort.aborted) return;
      checkEl.className = 'uc-check bad';
      checkEl.replaceChildren(h('strong', null, 'The check did not run'), h('span', null, String((e as Error).message ?? e)));
    }
  }

  function apply(): void {
    abort.aborted = true;
    const r = report && reportOf && sameProgram(reportOf, prog) ? report : null;
    root.remove();
    if (current === root) current = null;
    o.onHighlight?.(null);
    o.onApply(structuredClone(prog), r);
    o.onClose?.();
  }

  // ---- keys and pointer ----
  const cellAt = (r: number, c: number) => grid.querySelector(`[data-r="${r}"][data-c="${c}"]`) as HTMLElement | null;
  const moveTo = (r: number, c: number) => {
    r = Math.max(0, Math.min(prog.states.length - 1, r));
    c = Math.max(0, Math.min(nCols - 1, c));
    cellAt(focus[0], focus[1])?.setAttribute('tabindex', '-1');
    focus = [r, c];
    const el = cellAt(r, c);
    if (el) { el.setAttribute('tabindex', '0'); el.focus(); }
    if (sel !== r) { sel = r; grid.querySelectorAll('.uc-row.sel').forEach((x) => x.classList.remove('sel')); el?.closest('.uc-row')?.classList.add('sel'); renderSide(); }
  };
  const paint = (r: number, c: number, step: number) => {
    pendingFocus = true;
    sel = r;
    if (c < U_COLUMNS.length) edit((p) => cycleField(p, r, U_COLUMNS[c].field, step));
    else if (c === U_COLUMNS.length) edit((p) => (typeof p.states[r].next === 'number' ? setNext(p, r, (p.states[r].next as number + step + p.states.length) % p.states.length) : p));
    else edit((p) => setSeq(p, r, (seqOf(p.states[r]) + step + 3) % 3));
  };
  grid.addEventListener('keydown', (e) => {
    const t = (e.target as HTMLElement).closest('[data-r]') as HTMLElement | null;
    if (!t || !t.dataset.c) return;
    const r = Number(t.dataset.r), c = Number(t.dataset.c);
    const k = e.key;
    if (e.ctrlKey || e.metaKey) return;
    if (k === 'ArrowDown') moveTo(r + 1, c);
    else if (k === 'ArrowUp') moveTo(r - 1, c);
    else if (k === 'ArrowRight') moveTo(r, c + 1);
    else if (k === 'ArrowLeft') moveTo(r, c - 1);
    else if (k === 'Home') moveTo(r, e.shiftKey ? c : 0);
    else if (k === 'End') moveTo(r, nCols - 1);
    else if (k === 'PageDown') moveTo(prog.states.length - 1, c);
    else if (k === 'PageUp') moveTo(0, c);
    else if (k === ' ' || k === 'Enter') paint(r, c, e.shiftKey ? -1 : 1);
    else if ((k === 'Delete' || k === 'Backspace') && c < U_COLUMNS.length) { pendingFocus = true; edit((p) => setField(p, r, U_COLUMNS[c].field, 0)); }
    else if (/^[0-9]$/.test(k) && c < U_COLUMNS.length) { pendingFocus = true; edit((p) => setField(p, r, U_COLUMNS[c].field, Number(k))); }
    else if (/^[0-9]$/.test(k) && c === U_COLUMNS.length) { pendingFocus = true; edit((p) => setNext(p, r, Number(k))); }
    else return;
    e.preventDefault();
  });
  grid.addEventListener('focusin', (e) => {
    const t = (e.target as HTMLElement).closest('[data-r]') as HTMLElement | null;
    if (!t?.dataset.c) return;
    focus = [Number(t.dataset.r), Number(t.dataset.c)];
    if (sel !== focus[0]) { sel = focus[0]; grid.querySelectorAll('.uc-row.sel').forEach((x) => x.classList.remove('sel')); t.closest('.uc-row')?.classList.add('sel'); renderSide(); }
  });
  // a click paints; a mouse drag down (or up) the column paints the same value on every cell it crosses, one undo step
  let drag: { c: number; value: number; field: string; touched: Set<number> } | null = null;
  grid.addEventListener('pointerdown', (e) => {
    const t = (e.target as HTMLElement).closest('.uc-cell') as HTMLElement | null;
    const row = (e.target as HTMLElement).closest('.uc-row') as HTMLElement | null;
    if (!row || row.classList.contains('uc-head')) return;
    const r = Number(row.dataset.r);
    if (!t) { pendingFocus = false; sel = r; render(); return; }
    const c = Number(t.dataset.c);
    e.preventDefault();
    focus = [r, c];
    pendingFocus = true;
    if (c < U_COLUMNS.length && e.pointerType !== 'touch' && e.button === 0) {
      const field = U_COLUMNS[c].field, n = 2 ** (U_COLUMNS[c].width);
      const value = ((prog.states[r].sig[field] ?? 0) + 1) % n;
      undo.push(prog);
      prog = setField(prog, r, field, value);
      sel = r;
      stale();
      render();
      drag = { c, value, field, touched: new Set([r]) };
      grid.setPointerCapture?.(e.pointerId);
    } else paint(r, c, e.shiftKey || e.button === 2 ? -1 : 1); // Shift+click or right-click steps back down
  });
  grid.addEventListener('contextmenu', (e) => { if ((e.target as HTMLElement).closest('.uc-cell')) e.preventDefault(); });
  grid.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.uc-row') as HTMLElement | null;
    if (!el || el.classList.contains('uc-head') || el.dataset.r === undefined) return;
    const r = Number(el.dataset.r);
    if (drag.touched.has(r)) return;
    drag.touched.add(r);
    prog = setField(prog, r, drag.field, drag.value);
    stale();
    pendingFocus = false;
    render();
  });
  const endDrag = () => { drag = null; };
  grid.addEventListener('pointerup', endDrag);
  grid.addEventListener('pointercancel', endDrag);

  const root = h('div', { class: `uc-dlg${o.mode === 'sheet' ? ' sheet' : ' sb-help'}`, role: 'dialog', 'aria-label': 'Microcode', 'aria-modal': o.mode === 'sheet' ? 'false' : 'true' },
    h('div', { class: 'panel uc-panel' },
      h('header', { class: 'uc-head-bar' }, h('h3', null, icon('table', 16), 'Microcode'), sub, h('span', { class: 'uc-grow' }), undoBtn, resetBtn,
        h('button', { type: 'button', class: 'btn ghost icon-only', 'aria-label': 'Close', title: 'Close (Esc)', onclick: close }, icon('close', 16))),
      h('div', { class: 'uc-body' },
        h('main', { class: 'uc-main' }, gridWrap,
          h('div', { class: 'uc-legend' },
            h('span', null, h('i', { class: 'k on' }), '1'), h('span', null, h('i', { class: 'k' }), '0'), h('span', null, h('i', { class: 'k chg' }), 'changed from the book'),
            h('span', { class: 'uc-grow' }), addBtn, dropBtn),
          dispatchEl, problemsEl),
        h('aside', { class: 'uc-side' }, wordHead, wordText, figure, checkEl,
          h('div', { class: 'uc-foot' }, checkBtn, h('span', { class: 'uc-grow' }), h('button', { type: 'button', class: 'btn sm', onclick: close }, 'Cancel'), applyBtn)))));
  root.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape' && !(e.target as HTMLElement).matches('select')) { e.preventDefault(); close(); }
    else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); doUndo(); }
  });
  if (o.mode !== 'sheet') root.addEventListener('pointerdown', (e) => { if (e.target === root) close(); });
  current = root;
  o.host.append(root);
  render();
  (cellAt(focus[0], focus[1]) as HTMLElement | null)?.focus();
  // the book's numbers are the "before" of every comparison: start them when the dialog is idle
  setTimeout(() => { if (!abort.aborted && !bookRep) void bookReport({ signal: abort }).then((r) => { bookRep = r; if (!running) renderCheck(); }, () => {}); }, 400);
  return { close };
}

/** Is a painter open? */
export const painterOpen = () => !!current?.isConnected;
export type { McState };
