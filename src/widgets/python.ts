// Chapter 15, From Python to gates: the linked Python / assembly / machine-word view, the cost of each line on
// the golden model, and the Python panel docked beside the gate-level CPU (the line running now, its
// instructions, cycles and toggles, the variables read from the registers and data memory, the output, the
// stack). Everything comes from the compiler's maps (src/lang/compile.ts); nothing is drawn by hand.

import { compilePy, outputOf } from '../lang/compile';
import type { Compiled } from '../lang/compile';
import type { Home } from '../lang/codegen';
import { PY_GROUPS, PY_PROGRAMS } from '../lang/pyprograms';
import { cpuState } from '../riscv/cosim';
import { ABI, disasm } from '../riscv/isa';
import { ISS } from '../riscv/iss';
import { GateSim } from '../sim/gatesim';
import { h } from '../ui/dom';
import type { Scene, ScenePanel, Stage, Widget } from '../view/stage';
import { codeEditor } from './codeedit';
import { cpuScene } from './cpupanel';
import { instrUse } from './insthw';
import { instrBreakdown } from './instrfields';
import { clearInstr, markInstr } from './slowctl';
import '../styles/python.css';

/** The chapter's CPU: the single-cycle RV32I of chapter 14 with a 256-word ROM and 64 words of data memory. */
export const PY_IMEM_K = 8, PY_DMEM_K = 6;

export function pyCompile(source: string): Compiled {
  return compilePy(source, { dmemWords: 2 ** PY_DMEM_K });
}

/** Why a compiled program cannot be loaded (null: it can). */
export function pyProblem(c: Compiled): string | null {
  if (c.error) return `line ${c.error.line}: ${c.error.message}`;
  if (c.words.length > 2 ** PY_IMEM_K) return `${c.words.length} instructions: the ROM holds ${2 ** PY_IMEM_K}`;
  return null;
}

const signed = (v: number) => String(v | 0);
const hex8 = (v: number) => (v >>> 0).toString(16).padStart(8, '0');
const progOf = (id: string) => PY_PROGRAMS.find((p) => p.id === id)!;

/** The program list in its sections; the chosen program's blurb in `blurb`. */
function programPicker(label: string, blurb: HTMLElement): HTMLSelectElement {
  const sel = h('select', { class: 'py-sel', 'aria-label': label }) as HTMLSelectElement;
  for (const g of PY_GROUPS) sel.append(h('optgroup', { label: g }, ...PY_PROGRAMS.filter((p) => p.group === g).map((p) => h('option', { value: p.id }, p.name))));
  sel.addEventListener('change', () => { blurb.textContent = PY_PROGRAMS.find((p) => p.id === sel.value)?.blurb ?? ''; });
  return sel;
}

/** Python lines of a source (1-based index → text). */
const pyLines = (src: string) => src.replace(/\s+$/, '').split('\n');

// ---- step 1 / 2: one program in three languages ----

/** Python | assembly | machine words, linked line by line; the chosen word's fields; where each variable lives. */
export function pyLinked(initial: string, line: number): Widget {
  const blurb = h('div', { class: 'py-blurb' }, progOf(initial).blurb);
  const sel = programPicker('program', blurb);
  sel.value = initial;
  const body = h('div');
  const el = h('div', { class: 'py-widget' }, h('div', { class: 'py-row' }, sel, h('span', { class: 'py-hint' }, 'point at a line: the same line in every column; click: pin it, its fields below')), blurb, body);
  let pinned = line, hover: number | null = null;
  let c = pyCompile(progOf(initial).source);
  const cols = { py: h('div', { class: 'py-code' }), asm: h('div', { class: 'py-code' }), words: h('div', { class: 'py-code' }) };
  const fields = h('div', { class: 'py-fields' }), homes = h('div', { class: 'py-homes' });
  body.append(
    h('div', { class: 'py-tri' },
      h('div', null, h('div', { class: 'cpu-sec' }, 'Python'), cols.py),
      h('div', null, h('div', { class: 'cpu-sec' }, 'RV32I assembly'), cols.asm),
      h('div', null, h('div', { class: 'cpu-sec' }, 'Machine words (ROM)'), cols.words)),
    fields, homes);
  const lineEl = (py: number | null, ...kids: (HTMLElement | string)[]) => {
    const e = h('div', { class: 'ln', 'data-py': py === null ? '' : String(py) }, ...kids);
    if (py !== null) {
      e.addEventListener('mouseenter', () => { hover = py; mark(); });
      e.addEventListener('mouseleave', () => { hover = null; mark(); });
      e.addEventListener('click', () => { pinned = py; mark(); showFields(); });
    }
    return e;
  };
  const build = () => {
    const src = progOf(sel.value).source;
    c = pyCompile(src);
    if (!c.pcsOfPy(pinned).length) pinned = [...pyLines(src).keys()].map((i) => i + 1).find((n) => c.pcsOfPy(n).length) ?? 1;
    cols.py.replaceChildren(...pyLines(src).map((t, i) => lineEl(c.pcsOfPy(i + 1).length ? i + 1 : null, h('span', { class: 'no' }, String(i + 1)), t || ' ')));
    const firstAddr = new Map<number, number>();
    c.assembled!.lines.forEach((l) => { if (!firstAddr.has(l.srcLine)) firstAddr.set(l.srcLine, l.addr); });
    cols.asm.replaceChildren(...c.lines.map((l, i) => {
      const a = firstAddr.get(i + 1);
      const e = lineEl(l.py, h('span', { class: 'no' }, a === undefined ? '' : a.toString(16).padStart(3, '0')), l.text);
      e.classList.add(l.text.startsWith('#') ? 'cm' : /^\S.*:$/.test(l.text) ? 'lb' : 'in');
      return e;
    }));
    cols.words.replaceChildren(...c.assembled!.lines.map((l) => lineEl(c.lines[l.srcLine - 1].py, h('span', { class: 'no' }, l.addr.toString(16).padStart(3, '0')), hex8(l.word))));
    homes.replaceChildren(h('div', { class: 'cpu-sec' }, 'Where the variables live'), homeTable(c));
    mark();
    showFields();
  };
  const mark = () => {
    const on = String(hover ?? pinned);
    for (const col of Object.values(cols)) col.querySelectorAll<HTMLElement>('.ln').forEach((e) => e.classList.toggle('on', e.dataset.py === on));
  };
  const showFields = () => {
    const pcs = c.pcsOfPy(pinned);
    const words = pcs.map((pc) => ({ pc, w: c.words[pc >>> 2] }));
    fields.replaceChildren(h('div', { class: 'cpu-sec' }, `Line ${pinned}: ${pcs.length} instruction${pcs.length === 1 ? '' : 's'}, as the decoder splits ${pcs.length === 1 ? 'it' : 'them'}`),
      ...words.slice(0, 4).map(({ pc, w }) => h('div', { class: 'py-fld' }, h('code', null, `${pc.toString(16).padStart(3, '0')}  ${hex8(w)}  ${disasm(w, pc)}`), instrBreakdown(w, { compact: true }))),
      words.length > 4 ? h('div', { class: 'py-hint' }, `… and ${words.length - 4} more`) : '');
  };
  sel.addEventListener('change', build);
  build();
  return { el };
}

/** Where every variable of a compiled program lives (registers, data memory), its lists, the stack and the output. */
function homeTable(c: Compiled): HTMLElement {
  const L = c.layout!;
  const rows: HTMLElement[] = [];
  const add = (k: string, v: string, title?: string) => rows.push(h('span', title ? { title } : null, k), h('span', null, v));
  for (const hm of L.homes.filter((x) => !x.hidden)) add(`${hm.scope ? `${hm.scope}: ` : ''}${hm.name}`, hm.reg ?? `data memory [${hm.addr}]`, hm.reg ? 'a register' : 'a word of data memory: a function reads or writes it');
  for (const l of L.lists) add(`${l.name}[${l.len}]`, `data memory [${l.addr}…${l.addr + 4 * l.len - 4}]`);
  add('the output (gp)', `from [${L.outBase}] up`, 'print stores each value at gp and moves gp on a word');
  add('the stack (sp)', `down from ${L.stackTop}`, 'calls save the return address and registers here');
  if (L.runtime.length) add('runtime routines', L.runtime.map((r) => `rt.${r}`).join(', '), 'RV32I has no multiplier or divider: these loops do it');
  return h('div', { class: 'py-kv' }, ...rows);
}

// ---- step 3: what each line costs ----

interface Profile { own: Map<number, number>; rt: Map<number, number>; steps: number }

/** Cycles per Python line on the golden model (the single-cycle CPU: one instruction a cycle); a runtime routine's
 *  cycles go to the line that called it. */
export function pyProfile(c: Compiled, maxSteps = 200_000): Profile {
  const iss = new ISS(c.words, { dmemWords: c.layout!.dmemWords, imemWords: 2 ** PY_IMEM_K });
  const own = new Map<number, number>(), rt = new Map<number, number>();
  const rtStart = Math.min(...(c.layout!.runtime.map((r) => c.assembled!.labels.get(`rt.${r}`)!)), Infinity);
  let last = 0;
  while (!iss.halted && iss.steps < maxSteps) {
    const py = c.pyOfPc(iss.pc);
    if (py !== null) { own.set(py, (own.get(py) ?? 0) + 1); last = py; }
    else if (iss.pc >= rtStart && last) rt.set(last, (rt.get(last) ?? 0) + 1);
    iss.step();
  }
  return { own, rt, steps: iss.steps };
}

export function pyCost(ids: string[]): Widget {
  const blurb = h('div', { class: 'py-blurb' }, progOf(ids[0]).blurb);
  const sel = programPicker('program', blurb);
  const out = h('div');
  const el = h('div', { class: 'py-widget' }, h('div', { class: 'py-row' }, sel, h('span', { class: 'py-hint' }, 'cycles per Python line, measured on the golden model')), blurb, out);
  const show = () => {
    const src = progOf(sel.value).source, c = pyCompile(src), p = pyProfile(c);
    const lines = pyLines(src).map((t, i) => ({ n: i + 1, t, own: p.own.get(i + 1) ?? 0, rt: p.rt.get(i + 1) ?? 0, ins: c.pcsOfPy(i + 1).length })).filter((r) => r.ins);
    const max = Math.max(1, ...lines.map((r) => r.own + r.rt));
    out.replaceChildren(
      h('div', { class: 'py-prof' },
        h('span', { class: 'hd' }, 'line'), h('span', { class: 'hd' }, 'instr.'), h('span', { class: 'hd' }, 'cycles run'), h('span', { class: 'hd' }, ''),
        ...lines.flatMap((r) => [
          h('code', { class: 'k', title: c.pcsOfPy(r.n).map((pc) => disasm(c.words[pc >>> 2], pc)).join('\n') }, r.t.trim()),
          h('span', { class: 'i' }, String(r.ins)),
          h('span', { class: 'bw' }, h('span', { class: 'b', style: `width:${(100 * r.own / max).toFixed(1)}%` }), r.rt ? h('span', { class: 'b rt', style: `width:${(100 * r.rt / max).toFixed(1)}%`, title: `${r.rt.toLocaleString('en')} cycles in the runtime routine` }) : ''),
          h('span', { class: 'v' }, (r.own + r.rt).toLocaleString('en')),
        ])),
      h('p', { class: 'py-hint' }, `${p.steps.toLocaleString('en')} cycles in all; ${c.words.length} instructions in the ROM`,
        c.layout!.runtime.length ? h('span', null, '; ', h('span', { class: 'py-sw rt' }), ` inside ${c.layout!.runtime.map((r) => `rt.${r}`).join(' and ')}`) : '', '.'));
  };
  sel.value = ids[0];
  sel.addEventListener('change', show);
  show();
  return { el };
}

// ---- steps 4–6: the Python panel beside the gate-level CPU ----

/** A scene running a Python program on the gate-level single-cycle CPU, with the Python panel. */
export function pyScene(source: string, o: { edit?: boolean; highlight?: string[] } = {}): Scene {
  let c = pyCompile(source);
  if (pyProblem(c)) c = pyCompile(PY_PROGRAMS[0].source);
  return cpuScene({ source: c.asm, imemK: PY_IMEM_K, dmemK: PY_DMEM_K, highlight: o.highlight, extraPanels: [pyPanel(c, source, !!o.edit)] });
}

/** Which function the instruction at pc belongs to ('' the top level, null a runtime routine or the frame). */
function scopeAt(c: Compiled, pc: number): string | null {
  const L = c.assembled!.labels;
  let best: string | null = null, at = -1;
  const halt = L.get('halt') ?? L.get('program.halt') ?? 0;
  if (pc <= halt) return '';
  for (const fn of c.layout!.funcs) {
    const a = L.get(fn);
    if (a !== undefined && a <= pc && a > at) { at = a; best = fn; }
  }
  const rt = Math.min(...c.layout!.runtime.map((r) => L.get(`rt.${r}`)!), Infinity);
  return pc >= rt ? null : best ?? '';
}

interface PanelState {
  cycles: [number, number][];
  rt: [number, number][];
  lastToggles: number;
  lineToggles: [number, number][];
  stack: [number, string][];
  lastLine: number;
}

function pyPanel(c: Compiled, source: string, editOpen: boolean): ScenePanel {
  return (stage: Stage): Widget => {
    const L = c.layout!, A = c.assembled!;
    const lines = pyLines(source);
    const haltPc = A.labels.get('halt') ?? A.labels.get('program.halt') ?? 0;
    const cycles = new Map<number, number>(), rtCycles = new Map<number, number>(), lineToggles = new Map<number, number>();
    const stack = new Map<number, string>();
    let lastLine = 0, lastToggles = 0, before = 0, edgeLine = 0;
    let selLine: number | null = null;
    let timer: number | null = null;

    const mine = PY_PROGRAMS.find((p) => p.source === source);
    const blurb = h('div', { class: 'py-blurb' }, mine?.blurb ?? '');
    const sel = programPicker('Python program', blurb);
    sel.append(h('option', { value: '__custom' }, 'My program'));
    sel.value = mine?.id ?? '__custom';
    sel.addEventListener('change', () => {
      const p = PY_PROGRAMS.find((q) => q.id === sel.value);
      if (p) stage.load(pyScene(p.source, { edit: !editWrap.hidden }));
    });

    // the editor: compiles as you type, the error at its line in Python's terms
    const errBox = h('div', { class: 'asm-errors' });
    const stats = h('div', { class: 'py-hint' });
    const recheck = () => {
      const k = pyCompile(editor.value), why = pyProblem(k);
      editor.setDiagnostics(k.error ? [{ line: k.error.line, message: k.error.message }] : []);
      stats.textContent = why ?? `${pyLines(editor.value).length} Python lines → ${k.words.length} instructions of the ROM's ${2 ** PY_IMEM_K}`;
      errBox.textContent = '';
      return why;
    };
    let pend: number | null = null;
    const editor = codeEditor({ value: source.replace(/\s+$/, '') + '\n', lang: 'py', rows: 12, onChange: () => { if (pend) clearTimeout(pend); pend = window.setTimeout(recheck, 250); } });
    const editWrap = h('div', { class: 'py-edit', hidden: !editOpen }, editor.el, errBox, stats,
      h('div', { class: 'py-row' },
        h('button', { class: 'btn sm primary', onclick: () => {
          const why = recheck();
          if (why) { errBox.textContent = why; return; }
          stage.load(pyScene(editor.value, { edit: true }));
        } }, 'Compile & load'),
        h('button', { class: 'btn sm', onclick: () => { editWrap.hidden = true; } }, 'Close')));
    recheck();

    const stepBtn = h('button', { class: 'btn sm', title: 'Clock the CPU until the next Python line starts (Back undoes it)' }, 'Step line');
    const playBtn = h('button', { class: 'btn sm', title: 'Step one Python line about every second' }, 'Run line by line');
    const editBtn = h('button', { class: 'btn sm', onclick: () => { editWrap.hidden = !editWrap.hidden; } }, 'Edit');

    const status = h('div', { class: 'py-hint' });
    const listing = h('div', { class: 'cpu-listing py-listing' });
    const thisLine = h('div', { class: 'py-kv' });
    const vars = h('div', { class: 'py-kv' });
    const out = h('div', { class: 'py-out', 'aria-live': 'polite' });
    const stackBox = h('div', { class: 'py-kv py-stack' });
    const hasFuncs = L.funcs.length > 0;
    // Bottom-left, beside the CPU panel on the right (two right-docked panels would cover each other).
    const title = h('h4', null, 'Python', h('span', { class: 'fold-hint' }));
    const el = h('div', { class: 'mem-panel py-panel', 'data-dock': 'left' }, title,
      h('div', { class: 'param-row', style: 'margin-bottom:6px' }, sel, editBtn, stepBtn, playBtn),
      blurb, editWrap, status,
      h('div', { class: 'py-cols' },
        h('div', null,
          h('div', { class: 'cpu-sec' }, 'Program', h('span', { class: 'cpu-sec-hint' }, 'click a line: its instructions and hardware')), listing,
          h('div', { class: 'cpu-sec' }, 'This line, on the hardware'), thisLine),
        h('div', null,
          h('div', { class: 'cpu-sec' }, 'Variables, read from the gates'), vars,
          h('div', { class: 'cpu-sec' }, `Output (data memory from ${L.outBase} up to gp)`), out,
          ...(hasFuncs ? [h('div', { class: 'cpu-sec' }, `The stack (from sp up to ${L.stackTop})`), stackBox] : []))));
    title.addEventListener('click', () => { el.classList.toggle('collapsed'); stage.layoutDock(); });
    /** Each instruction's source form (li, j, …: the assembly the compiler wrote, not the disassembly). */
    const asmText = new Map(A.lines.map((l) => [l.addr, l.text]));

    const pc = () => (stage.sim ? cpuState(stage.sim).pc : 0);
    const halted = () => pc() === haltPc;
    const toggleSum = (): number => {
      const sim = stage.sim;
      if (!(sim instanceof GateSim)) return 0;
      if (!sim.toggles) sim.countToggles();
      let s = 0;
      for (const t of sim.toggles!) s += t;
      return s;
    };

    // Every rising edge: its cycle and wire toggles go to the Python line it executed; stores to the stack are labelled.
    const hook = {
      before: () => {
        const sim = stage.sim;
        if (!sim) return;
        const st = cpuState(sim), py = c.pyOfPc(st.pc);
        edgeLine = py ?? (scopeAt(c, st.pc) === null ? -lastLine : 0);
        before = toggleSum();
        const w = c.words[st.pc >>> 2] ?? 0x13;
        if ((w & 0x7f) === 0x23 && ((w >>> 15) & 31) === 2) {
          const off = ((w >> 25) << 5) | ((w >>> 7) & 31), rs2 = (w >>> 20) & 31;
          const fn = scopeAt(c, st.pc);
          const reg = disasm(w, st.pc).split(/[\s,]+/)[1];
          stack.set((st.x[2] + off) >>> 0, rs2 === 1 ? `${fn ? `${fn}: ` : ''}return address` : reg.startsWith('t') ? `${reg}: waiting across a call` : `${fn ? `${fn}: ` : ''}saved ${reg}`);
        }
      },
      after: () => {
        if (edgeLine > 0) { cycles.set(edgeLine, (cycles.get(edgeLine) ?? 0) + 1); lastLine = edgeLine; }
        else if (edgeLine < 0) rtCycles.set(-edgeLine, (rtCycles.get(-edgeLine) ?? 0) + 1);
        const t = toggleSum();
        lastToggles = t - before;
        if (edgeLine > 0) lineToggles.set(edgeLine, lastToggles);
        // a frame popped: its words are free again
        if (stage.sim) { const sp = cpuState(stage.sim).x[2]; for (const a of [...stack.keys()]) if (a < sp) stack.delete(a); }
      },
    };
    stage.edgeHooks.add(hook);
    const hist = {
      save: (): PanelState => ({ cycles: [...cycles], rt: [...rtCycles], lastToggles, lineToggles: [...lineToggles], stack: [...stack], lastLine }),
      restore: (v: unknown) => {
        const s = v as PanelState;
        stopPlay();
        cycles.clear(); s.cycles.forEach(([k, n]) => cycles.set(k, n));
        rtCycles.clear(); s.rt.forEach(([k, n]) => rtCycles.set(k, n));
        lineToggles.clear(); s.lineToggles.forEach(([k, n]) => lineToggles.set(k, n));
        stack.clear(); s.stack.forEach(([k, n]) => stack.set(k, n));
        ({ lastToggles, lastLine } = s);
      },
    };
    stage.historyHooks.add(hist);

    /** Clock until a different Python line starts (or the program halts); false if nothing ran. */
    const stepLine = (): boolean => {
      if (!stage.sim || halted()) return false;
      stage.checkpoint();
      const from = c.pyOfPc(pc());
      stage.runCycles(20_000, () => {
        const p = pc(), py = c.pyOfPc(p);
        return p === haltPc || (py !== null && py !== from);
      });
      return true;
    };
    const stopPlay = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
      playBtn.textContent = 'Run line by line';
    };
    stepBtn.addEventListener('click', () => { stopPlay(); stepLine(); });
    playBtn.addEventListener('click', () => {
      if (timer !== null) return stopPlay();
      playBtn.textContent = 'Stop';
      timer = window.setInterval(() => { if (!stepLine() || halted()) stopPlay(); }, 900);
    });

    const valueOf = (hm: Home, x: number[], dmem: number[]): number => (hm.reg ? x[regIndex(hm.reg)] : dmem[hm.addr! >>> 2] ?? 0);

    const update = () => {
      const sim = stage.sim;
      if (!sim) return;
      if (stage.cycles === 0) { cycles.clear(); rtCycles.clear(); lineToggles.clear(); stack.clear(); lastLine = 0; lastToggles = 0; }
      const st = cpuState(sim);
      const cur = c.pyOfPc(st.pc), scope = scopeAt(c, st.pc);
      const shown = cur ?? (scope === null ? lastLine : null);
      status.textContent = st.pc === haltPc ? `Halted after ${stage.cycles.toLocaleString('en')} cycles.`
        : cur !== null ? `Running line ${cur}${scope ? ` in ${scope}()` : ''}.` : scope === null ? `Inside a runtime routine, for line ${lastLine}.` : 'Setting up: the stack and the output pointer.';
      const keep = listing.scrollTop;
      listing.replaceChildren(...lines.map((t, i) => {
        const n = i + 1, k = cycles.get(n) ?? 0, r = rtCycles.get(n) ?? 0;
        const e = h('div', { class: `ln${n === shown ? ' cur' : ''}${n === selLine ? ' sel' : ''}`, title: c.pcsOfPy(n).length ? 'Show its instructions and their hardware' : '' },
          h('span', { class: 'a' }, String(n)), h('span', { class: 't' }, t || ' '),
          k + r ? h('span', { class: 'py-cyc', title: `${k} cycles on this line${r ? `, ${r} in a runtime routine` : ''}` }, (k + r).toLocaleString('en')) : '');
        if (c.pcsOfPy(n).length) e.addEventListener('click', () => { selLine = selLine === n ? null : n; update(); });
        return e;
      }));
      listing.scrollTop = keep;
      const curEl = listing.querySelector('.cur') as HTMLElement | null;
      if (curEl && (curEl.offsetTop < listing.scrollTop || curEl.offsetTop > listing.scrollTop + listing.clientHeight - 20)) listing.scrollTop = Math.max(0, curEl.offsetTop - 40);

      // the line in focus: the clicked one, else the one running
      const focus = selLine ?? shown;
      const pcs = focus ? c.pcsOfPy(focus) : [];
      thisLine.replaceChildren(...(focus ? [
        h('span', null, 'line'), h('span', null, h('code', null, (lines[focus - 1] ?? '').trim())),
        h('span', null, 'instructions'), h('span', { class: 'py-ins' }, ...pcs.map((p) => h('code', { class: p === st.pc ? 'now' : '' }, `${p.toString(16).padStart(3, '0')} ${asmText.get(p) ?? disasm(c.words[p >>> 2], p)}`))),
        h('span', null, 'clock cycles so far'), h('span', null, `${(cycles.get(focus) ?? 0).toLocaleString('en')}${rtCycles.get(focus) ? ` + ${rtCycles.get(focus)!.toLocaleString('en')} in rt` : ''}`),
        ...(sim instanceof GateSim ? [h('span', { title: 'Nets that changed value during its last clock cycle on the gates (glitches included)' }, 'wire toggles, its last cycle'), h('span', null, (lineToggles.get(focus) ?? 0).toLocaleString('en'))] : []),
      ] : [h('span', { class: 'py-hint' }, st.pc === haltPc ? 'The program has halted: click a line to see its instructions.' : 'No Python line yet.'), h('span')]));
      if (selLine !== null) {
        const units = [...new Set(pcs.flatMap((p) => instrUse(c.words[p >>> 2]).units))];
        markInstr(stage, c.words[pcs[0] >>> 2] ?? null, units);
      }

      // the variables of the scope running now, then the globals in memory and the lists
      const dmem = st.dmem;
      const inScope = L.homes.filter((x) => !x.hidden && (x.scope === (scope ?? '') || (x.addr !== undefined && x.scope === '')));
      const seen = new Set<string>();
      vars.replaceChildren(...inScope.flatMap((hm) => {
        const key = `${hm.scope}.${hm.name}`;
        if (seen.has(key)) return [];
        seen.add(key);
        return [h('span', null, `${hm.scope ? `${hm.scope}: ` : ''}${hm.name} `, h('span', { class: 'py-where' }, hm.reg ?? `[${hm.addr}]`)), h('span', null, signed(valueOf(hm, st.x, dmem)))];
      }), ...L.lists.flatMap((l) => [h('span', null, `${l.name} `, h('span', { class: 'py-where' }, `[${l.addr}]`)),
        h('span', { class: 'py-list' }, `[${Array.from({ length: Math.min(l.len, 16) }, (_, i) => signed(dmem[(l.addr >>> 2) + i] ?? 0)).join(', ')}${l.len > 16 ? ', …' : ''}]`)]));
      const printed = outputOf(L, st.x[3], dmem);
      out.textContent = printed.length ? printed.join('\n') : ' ';
      if (hasFuncs) {
        const rows: HTMLElement[] = [];
        for (let a = L.stackTop - 4; a >= st.x[2]; a -= 4) rows.push(h('span', null, `[${a}] `, h('span', { class: 'py-where' }, stack.get(a) ?? '')), h('span', null, signed(dmem[a >>> 2] ?? 0)));
        stackBox.replaceChildren(...(rows.length ? rows : [h('span', { class: 'py-hint' }, 'empty: no call in progress'), h('span')]));
      }
      stepBtn.toggleAttribute('disabled', st.pc === haltPc);
    };
    update();
    return {
      el, update, destroy: () => {
        stopPlay();
        if (pend) clearTimeout(pend);
        stage.edgeHooks.delete(hook);
        stage.historyHooks.delete(hist);
        editor.destroy();
        if (selLine !== null) clearInstr(stage);
      },
    };
  };
}

const regIndex = (r: string) => ABI.indexOf(r);
