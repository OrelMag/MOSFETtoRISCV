// The sandbox's breakpoints (breakpoints.ts): a properties section listing the chip's breakpoints (switch, condition, hits,
// an unknown read or a problem, delete; + Stop when…), the same list narrowed to a selected pin, pointer or wire with
// "Stop when <name>…", the run bar's toast saying which one stopped the run, and the wires it reads lit until the next run.

import { netlistOf } from '../sim/types';
import { h, icon } from '../ui/dom';
import { breakText, Breakpoints, resolveName } from './breakpoints';
import { type Editor, registerEditorPlugin } from './editor';
import type { BreakDoc, ChipDoc } from './model';
import { registerPropsSection } from './props';
import { MAX_BREAKS } from './store';
import '../styles/editor-breaks.css';

interface State { bp: Breakpoints; doc: ChipDoc | null; design: unknown; lit: string }
const states = new WeakMap<Editor, State>();

/** The breakpoints of the chip the editor shows, bound to its simulation now (a new one after a tab switch). */
export function breakpointsOf(ed: Editor): Breakpoints {
  let s = states.get(ed);
  if (!s || s.bp.sim !== ed.sim) {
    s?.bp.dispose();
    s = { bp: new Breakpoints(ed.sim), doc: null, design: null, lit: '' };
    states.set(ed, s);
  }
  const design = ed.sim.sim?.design ?? null;
  if (s.doc !== ed.doc || s.design !== design) {
    s.doc = ed.doc;
    s.design = design;
    s.bp.bind(ed.doc);
  }
  return s.bp;
}

const newId = (doc: ChipDoc) => { const ids = new Set((doc.breaks ?? []).map((b) => b.id)); for (let i = 1; ; i++) if (!ids.has(`b${i}`)) return `b${i}`; };
const setBreaks = (doc: ChipDoc, breaks: BreakDoc[]): ChipDoc => { const { breaks: _, ...rest } = doc; return breaks.length ? { ...rest, breaks } : rest; };

/** Add a breakpoint (one undo step) and put the caret in its condition. */
export function addBreak(ed: Editor, b: Omit<BreakDoc, 'id'>, focus = true): void {
  if ((ed.doc.breaks?.length ?? 0) >= MAX_BREAKS) return ed.toast(`At most ${MAX_BREAKS} breakpoints on a chip`, 'err');
  const id = newId(ed.doc);
  ed.edit((d) => setBreaks(d, [...(d.breaks ?? []), { id, ...b }]));
  ed.props.update(true);
  if (focus) requestAnimationFrame(() => {
    const i = ed.props.el.querySelector<HTMLInputElement>(`.sb-bp-row[data-id="${id}"] input.sb-bp-cond`);
    if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); }
  });
}

function changeBreak(ed: Editor, id: string, f: (b: BreakDoc) => BreakDoc | null): void {
  ed.edit((d) => setBreaks(d, (d.breaks ?? []).flatMap((b) => { if (b.id !== id) return [b]; const n = f(b); return n ? [n] : []; })));
}

/** The words after a breakpoint in the list: its hits, an unknown read, or what is wrong. */
function statusText(ed: Editor, b: BreakDoc): { text: string; cls: string; title: string } {
  const st = breakpointsOf(ed).status(b.id);
  if (!st) return { text: '', cls: '', title: '' };
  if (st.error) return { text: st.error, cls: 'err', title: 'This condition does not parse' };
  if (st.missing.length) return { text: `no signal ${st.missing.join(', ')}`, cls: 'err', title: 'Names a pin, a pointer, part.port or a path into a placed chip (cpu.rf.w5)' };
  if (b.off) return { text: 'off', cls: 'muted', title: 'Switched off: not checked' };
  const hits = st.hits ? `hit ${st.hits}×` : 'not hit yet';
  return st.unknown ? { text: `${hits} · unknown`, cls: 'warn', title: 'The last check read an unknown bit (X or Z), so it could not hold' } : { text: hits, cls: st.hits ? 'hit' : 'muted', title: 'Times it held since the chip was opened or powered on' };
}

function row(ed: Editor, b: BreakDoc): HTMLElement {
  const on = h('input', { type: 'checkbox', checked: !b.off, 'aria-label': `Check ${breakText(b)}` }) as HTMLInputElement;
  on.addEventListener('change', () => changeBreak(ed, b.id, (x) => { const n = { ...x }; if (on.checked) delete n.off; else n.off = true; return n; }));
  let cond: HTMLElement;
  if (b.pc !== undefined) cond = h('span', { class: 'sb-bp-pc', title: 'Stops when the instruction at this address retires (the CPU drawer\'s listing)' }, breakText(b));
  else {
    const i = h('input', { type: 'text', class: 'sb-bp-cond', value: b.cond ?? '', spellcheck: 'false', 'aria-label': 'Stop when', placeholder: 'count == 5' }) as HTMLInputElement;
    i.addEventListener('change', () => changeBreak(ed, b.id, (x) => ({ ...x, cond: i.value })));
    i.addEventListener('keydown', (e) => { if (e.key === 'Enter') i.blur(); });
    cond = i;
  }
  const st = statusText(ed, b);
  const gate = b.pc === undefined ? h('label', { class: 'sb-bp-gate', title: 'In gate mode, checked after every gate delay, so a run stops the moment it holds, between two edges. In cycle mode it is checked after each rising edge like the others.' },
    (() => { const g = h('input', { type: 'checkbox', checked: !!b.gate }) as HTMLInputElement; g.addEventListener('change', () => changeBreak(ed, b.id, (x) => { const n = { ...x }; if (g.checked) n.gate = true; else delete n.gate; return n; })); return g; })(), 'every change') : null;
  return h('div', { class: 'sb-bp-row', 'data-id': b.id },
    on, cond,
    h('button', { class: 'btn sm ghost icon', title: 'Delete this breakpoint', 'aria-label': `Delete ${breakText(b)}`, onclick: () => changeBreak(ed, b.id, () => null) }, icon('x', 13)),
    h('span', { class: `sb-bp-st ${st.cls}`, title: st.title }, st.text),
    gate);
}

/** The name a selected pin, pointer or wire goes by in a condition (null: nothing a condition can read). */
function selName(ed: Editor): string | null {
  const s = ed.sel, doc = ed.doc, c = ed.compiled;
  if (s.pins?.length === 1) return doc.pins.find((p) => p.id === s.pins![0])?.name ?? null;
  if (s.labels?.length === 1) return doc.labels.find((p) => p.id === s.labels![0])?.name ?? null;
  if (s.wires?.length === 1 && c) {
    const n = c.netOfWire.get(s.wires[0]);
    const nd = n !== undefined && n >= 0 ? netlistOf(c.def)?.nets[n] : undefined;
    if (!nd) return null;
    // its name, else a chip pin on it, else a part's port on it (any end names the same net)
    return nd.name ?? nd.ends.find((e) => !e.includes('.')) ?? nd.ends[0] ?? null;
  }
  return null;
}

const widthOf = (ed: Editor, name: string): number => {
  const b = ed.sim.built, root = ed.sim.sim?.design.root;
  return (b && root ? resolveName(name, ed.doc, b, root)?.length : undefined) ?? 1;
};

registerPropsSection({
  id: 'breaks',
  order: 55,
  advanced: (ed) => !ed.doc.breaks?.length && !ed.sim.hasClock,
  render(ed) {
    const s = ed.sel;
    const any = !!(s.parts?.length || s.pins?.length || s.labels?.length || s.wires?.length || s.comments?.length || s.sections?.length);
    const name = any ? selName(ed) : null;
    if (any && !name) return null;
    const all = ed.doc.breaks ?? [];
    const reads = (b: BreakDoc) => !!b.cond && new RegExp(`(^|[^\\w.$])${name!.replace(/[.$]/g, '\\$&')}($|[^\\w.$])`).test(b.cond);
    const shown = name ? all.filter(reads) : all;
    const add = name
      ? h('button', { class: 'btn sm', title: `A breakpoint on ${name}: Run stops after the step on which it holds`, onclick: () => addBreak(ed, { cond: widthOf(ed, name) === 1 ? `rose(${name})` : `${name} == 0` }) }, icon('plus', 13), `Stop when ${name}…`)
      : h('button', { class: 'btn sm', title: 'A condition on the chip\'s signals: Run, Step ×n and Run to halt stop after the step on which it holds', onclick: () => addBreak(ed, { cond: '' }) }, icon('plus', 13), 'Stop when…');
    return h('section', { class: 'sb-sec-props sb-bp' },
      h('h3', null, 'Breakpoints'),
      !name && !all.length ? h('p', { class: 'sb-sum' }, 'Stop a run when a condition holds: ', h('code', null, 'pc == 0x40'), ', ', h('code', null, 'count >= 12 && en'), ', ', h('code', null, 'rose(miss)'), '. Names: pins, pointers, part.port, a path into a placed chip.') : null,
      ...shown.map((b) => row(ed, b)),
      h('div', { class: 'sb-btns' }, add));
  },
});

registerEditorPlugin((ed) => {
  /** Wires of the chip-level nets a breakpoint reads, lit while the run stays stopped on it. */
  const light = () => {
    const bp = breakpointsOf(ed), s = states.get(ed)!;
    const st = ed.sim.stopReason && ed.sim.stopReason !== 'halt' && !ed.sim.running && bp.stoppedBy ? bp.status(bp.stoppedBy) : undefined;
    const flat = new Set(st?.nets ?? []);
    const built = ed.sim.built, root = ed.sim.sim?.design.root;
    const wires: string[] = [];
    if (flat.size && built && root?.nets) for (const [w, n] of built.netOfWire) if (n >= 0 && root.nets[n]?.some((x) => flat.has(x))) wires.push(w);
    const key = `${ed.chipId}|${wires.join(',')}`;
    const svg = ed.view.svg;
    if (key === s.lit && (!wires.length || svg.querySelector('.bp-lit'))) return;
    s.lit = key;
    svg.querySelectorAll('.bp-lit').forEach((e) => e.classList.remove('bp-lit'));
    for (const w of wires) svg.querySelectorAll(`path.wire[data-wire="${w}"]`).forEach((e) => e.classList.add('bp-lit'));
  };
  /** Hit counts and unknown reads change while running: the list's status words in place. */
  const paint = () => {
    breakpointsOf(ed);
    for (const r of ed.props.el.querySelectorAll<HTMLElement>('.sb-bp-row')) {
      const b = ed.doc.breaks?.find((x) => x.id === r.dataset.id), el = r.querySelector('.sb-bp-st');
      if (!b || !el) continue;
      const st = statusText(ed, b);
      if (el.textContent !== st.text) { el.textContent = st.text; el.className = `sb-bp-st ${st.cls}`; el.setAttribute('title', st.title); }
    }
    light();
  };
  ed.paintHooks.add(paint);
  const off = ed.onSimChange(() => breakpointsOf(ed));
  return () => { ed.paintHooks.delete(paint); off(); states.get(ed)?.bp.dispose(); states.delete(ed); };
});
