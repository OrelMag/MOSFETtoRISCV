// Chapters 28–29 widgets: the lane core scene with its Warp panel (listing, the active mask step by
// step, the split / join stack, each lane's registers, golden-model lock-step), and the lanes
// against cores comparison (NANDs by block and cycles, both measured).

import { alu, laneCore, multiCore, regfile } from '../lib';
import { assemble, type AsmResult } from '../riscv/asm';
import { ABI, disasm } from '../riscv/isa';
import { MultiISS } from '../riscv/multi';
import { SimtISS, type SimtEntry } from '../riscv/simt';
import { SAXPY_CORES, SIMT_PROGRAMS, type SimtProgram } from '../riscv/simtprograms';
import type { HierNode } from '../sim/flatten';
import type { Sim } from '../sim/sim';
import { stats } from '../sim/stats';
import type { ComponentDef } from '../sim/types';
import { h } from '../ui/dom';
import type { Scene, ScenePanel, Stage, Widget } from '../view/stage';
import { laneUse } from './insthw';
import { frameRun, showInstrUse, slowControls } from './slowctl';

const hex = (v: number, d = 8) => '0x' + (v >>> 0).toString(16).toUpperCase().padStart(d, '0');
const bits = (m: number, n: number) => Array.from({ length: n }, (_, i) => (m >> i) & 1);
const kid = (n: HierNode, ...p: string[]) => p.reduce((x, k) => x.children!.get(k)!, n);
/** Registers the kernels use, shown per lane. */
const SHOWN = [5, 6, 7, 28, 10, 8];

export interface LaneSceneOptions {
  lanes?: number;
  highlight?: string[];
  /** Programs offered in the panel's menu (default: all). */
  programs?: string[];
  /** 'gate': GateSim only (probes, the timing diagram and the power estimate; a few hundred cycles a second). Default: the cycle engine. */
  engine?: 'gate' | 'cycle';
}

export function laneCoreScene(id: string, opts: LaneSceneOptions = {}): Scene {
  const p = SIMT_PROGRAMS.find((x) => x.id === id)!;
  const asm = assemble(p.source);
  const n = opts.lanes ?? 4;
  return {
    root: laneCore(asm.words, n), inputs: { clk: 0 }, highlight: opts.highlight ?? ['simt'], panels: [warpPanel(p, asm, n, opts)],
    ...(opts.engine === 'gate' ? {} : { engine: 'cycle' as const }),
  };
}

/** A word read from fixed nets without allocating (the panels compare every register at every instruction); -1 if a bit is X / Z. */
export function wordReader(sim: Sim, nets: readonly number[]): () => number {
  return () => {
    let v = 0;
    for (let i = 0; i < nets.length; i++) {
      const b = sim.get(nets[i]);
      if (b === 1) v |= 1 << i;
      else if (b !== 0) return -1;
    }
    return v >>> 0;
  };
}

/** x0 … x31 of a register file (w1 … w31), readers made once per simulation. */
export function regsReader(sim: Sim, rf: HierNode): () => number[] {
  const rd = Array.from({ length: 31 }, (_, r) => wordReader(sim, rf.children!.get(`w${r + 1}`)!.ports.q));
  return () => [0, ...rd.map((f) => f())];
}

/** Keep a listing's current line in view (a line the learner selected stays where it is). */
export function scrollTo(listing: HTMLElement, line: HTMLElement | undefined): void {
  if (!line) return;
  const top = line.offsetTop - listing.offsetTop, ht = listing.clientHeight;
  if (top < listing.scrollTop || top > listing.scrollTop + ht - 20) listing.scrollTop = Math.max(0, top - 40);
}

/** The lanes an instruction runs on (lane numbers of a mask). */
export const lanesIn = (m: number, n: number) => Array.from({ length: n }, (_, i) => i).filter((i) => (m >> i) & 1);

/** The row of a step in the mask grid. */
interface Trace { pc: number; text: string; mask: number }

function warpPanel(p: SimtProgram, asm: AsmResult, n: number, opts: LaneSceneOptions): ScenePanel {
  return (stage: Stage): Widget => {
    let m = new SimtISS(asm.words, { lanes: n });
    let mismatch: string | null = null;
    let trace: Trace[] = [];
    let stopRun: (() => void) | null = null;
    /** The listing line the learner clicked: its hardware stays lit. */
    let selPc: number | null = null;
    /** Where the instruction of the edge in progress runs (Slow mode at gate level: the view moves under it). */
    let edgeAt: { pc: number; mask: number; served: number } | null = null;
    let willRetire = false;
    const status = h('div', { class: 'cpu-status' });
    const listing = h('div', { class: 'cpu-listing' });
    const usePath = h('div', { class: 'cpu-use' });
    const grid = h('div', { class: 'warp-grid' });
    const stack = h('div', { class: 'warp-stack' });
    const regs = h('div', { class: 'warp-regs' });
    const mem = h('div', { class: 'cpu-mem' });
    const sel = h('select', { 'aria-label': 'program' }) as HTMLSelectElement;
    for (const q of SIMT_PROGRAMS.filter((x) => !opts.programs || opts.programs.includes(x.id))) sel.append(h('option', { value: q.id }, q.title));
    sel.value = p.id;
    sel.addEventListener('change', () => stage.load(laneCoreScene(sel.value, opts)));
    const finished = () => m.halted || !!mismatch || stage.cycles > 5000;
    const runBtn = h('button', { class: 'btn sm primary', title: 'Run until the program halts' }, 'Run to halt');
    const stop = () => stopRun?.();
    runBtn.addEventListener('click', () => {
      if (stopRun) return stop();
      slow.stop();
      slow.tracing = false;
      stage.checkpoint();
      runBtn.textContent = 'Stop';
      stopRun = frameRun(stage, finished, () => { stopRun = null; runBtn.textContent = 'Run to halt'; });
    });
    const slow = slowControls(stage, { multiCycle: true, finished, onStart: stop });
    const lines = asm.words.map((w, i) => {
      const el = h('div', { class: 'ln', title: 'Show the hardware this instruction uses' }, h('span', { class: 'a' }, hex(i * 4, 2)), h('span', null, disasm(w, i * 4)));
      el.addEventListener('click', () => { selPc = selPc === i * 4 ? null : i * 4; update(); });
      listing.append(el);
      return el;
    });
    const title = h('h4', null, `Warp: ${n} lanes, one PC`, h('span', { class: 'fold-hint' }));
    const el = h('div', { class: 'mem-panel cpu-panel warp-panel', 'data-dock': 'right', 'data-fold': 'narrow' }, title,
      h('div', { class: 'cpu-body' }, h('div', { class: 'param-row', style: 'margin-bottom:6px' }, sel, runBtn), slow.el, status,
        h('div', { class: 'cpu-sec' }, 'Program', h('span', { class: 'cpu-sec-hint' }, 'click a line: its hardware')), listing, usePath,
        h('div', { class: 'cpu-sec' }, 'Active mask, instruction by instruction', h('span', { class: 'cpu-sec-hint' }, 'filled: the lane ran it')), grid,
        h('div', { class: 'cpu-sec' }, 'split / join stack', h('span', { class: 'cpu-sec-hint' }, 'top first')), stack,
        h('div', { class: 'cpu-sec' }, 'Registers, per lane'), regs,
        h('div', { class: 'cpu-sec' }, 'Memory (non-zero words)'), mem));
    // readers over the current simulation (a Reset keeps it; a new scene makes a new panel)
    let readers: { sim: Sim; pc: () => number; mask: () => number; retire: () => number; served: () => number; lanes: (() => number[])[]; ram: (() => number)[] } | null = null;
    const rd = () => {
      const sim = stage.sim!;
      if (readers?.sim !== sim) {
        const root = sim.design.root;
        readers = {
          sim, pc: wordReader(sim, root.ports.pcOut), mask: wordReader(sim, root.ports.maskOut), retire: wordReader(sim, root.ports.retire),
          // the sequencer's served lane counts only while a load or store holds it
          served: ((sv, mem) => () => (mem() === 1 ? sv() : 0))(wordReader(sim, kid(root, 'mseq').ports.served), wordReader(sim, kid(root, 'mseq').ports.isMem)),
          lanes: Array.from({ length: n }, (_, i) => regsReader(sim, kid(root, `lane${i}`, 'rf'))),
          ram: Array.from({ length: 32 }, (_, i) => wordReader(sim, kid(root, 'dm', 'ram', `w${i}`).ports.q)),
        };
      }
      return readers;
    };
    stage.edgeHooks.add({
      before: () => {
        if (!stage.sim) return;
        const r = rd();
        edgeAt = { pc: r.pc(), mask: r.mask(), served: r.served() };
        willRetire = !m.halted && r.retire() === 1;
        if (!willRetire) return;
        const s = m.step();
        trace.push({ pc: s.pc, text: s.text, mask: s.mask });
        if (trace.length > 400) trace = trace.slice(-200);
      },
      after: () => {
        edgeAt = null;
        if (willRetire) slow.retired();
        if (!stage.sim || mismatch) return;
        const r = rd();
        if (r.pc() !== m.pc) mismatch = 'PC differs from the model';
        else if (r.mask() !== m.mask) mismatch = 'mask differs from the model';
        // a load writes one lane a cycle: the registers match the model once it retires
        else if (willRetire) for (let i = 0; i < n && !mismatch; i++) {
          const x = r.lanes[i](), d = x.findIndex((v, k) => v !== m.lanes[i].x[k]);
          if (d >= 0) mismatch = `lane ${i}: ${ABI[d]} differs from the model`;
        }
      },
    });
    stage.historyHooks.add({
      save: () => ({ m: m.save(), mismatch, trace: trace.slice() }),
      restore: (v) => {
        const st = v as { m: ReturnType<SimtISS['save']>; mismatch: string | null; trace: Trace[] };
        stop();
        slow.stop();
        m.restore(st.m);
        mismatch = st.mismatch;
        trace = st.trace.slice();
        edgeAt = null;
      },
    });
    /** Light the selected instruction, or in Slow mode the current one on the lanes it runs on now. */
    const showUse = (pc: number, mask: number, served: number) => {
      const at = selPc ?? (slow.tracing ? pc : null);
      if (at === null) return showInstrUse(stage, usePath, null);
      const word = asm.words[at >>> 2] ?? 0x13, now = at === pc;
      const memNow = now && served !== 0;
      const lanes = now ? lanesIn(memNow ? served : mask, n) : undefined;
      showInstrUse(stage, usePath, { pc: at, word, use: laneUse(word, { n }, { lanes }),
        where: !now ? 'not the current instruction; lit: everything it uses' : memNow ? `memory serves lane ${lanes!.join(', ')} this cycle` : `lanes ${lanes!.join(', ') || 'none'} active` });
    };
    const update = () => {
      const sim = stage.sim;
      if (!sim) return;
      slow.update();
      if (stage.cycles === 0 && m.cycles > 0) { m = new SimtISS(asm.words, { lanes: n }); mismatch = null; trace = []; slow.tracing = false; }
      const r = rd();
      const pc = edgeAt?.pc ?? r.pc();
      status.replaceChildren(
        h('span', null, `cycle ${stage.cycles}`),
        h('span', null, `${m.retired} instructions`),
        h('span', null, `lanes busy ${(100 * m.utilization).toFixed(0)} %`),
        ...(m.divergences ? [h('span', { class: 'warn' }, `${m.divergences} divergent branch${m.divergences > 1 ? 'es' : ''}: the leader decided`)] : []),
        mismatch ? h('span', { class: 'bad' }, `✗ ${mismatch}`) : h('span', { class: 'good' }, '✓ matches the SIMT golden model'),
        ...(m.halted ? [h('span', { class: 'warn' }, 'halted')] : []));
      lines.forEach((l, i) => { l.classList.toggle('cur', i * 4 === pc); l.classList.toggle('sel', i * 4 === selPc); });
      if (selPc === null) scrollTo(listing, lines[pc >>> 2]);
      showUse(pc, edgeAt?.mask ?? r.mask(), edgeAt?.served ?? r.served());
      const shown = trace.slice(-16);
      grid.replaceChildren(h('table', null,
        h('tr', null, h('th'), ...shown.map((_, i) => h('th', null, String(trace.length - shown.length + i + 1)))),
        ...Array.from({ length: n }, (_, l) => h('tr', null, h('td', { class: 'lbl' }, `lane ${l}`),
          ...shown.map((t) => h('td', { class: (t.mask >> l) & 1 ? 'on' : '', title: `${t.text}${(t.mask >> l) & 1 ? '' : ' (lane off)'}` }))))));
      const row = (e: SimtEntry, i: number) => h('div', { class: i === 0 ? 'top' : '' },
        h('span', null, 'mask'), maskEl(e.mask, n), h('span', null, 'else'), maskEl(e.elseMask, n),
        h('span', null, e.pending ? `resume at ${hex(e.pc, 2)}` : 'restore, pop'));
      stack.replaceChildren(...(m.stack.length ? [...m.stack].reverse().map(row) : [h('div', { class: 'empty' }, `empty · mask ${m.mask.toString(2).padStart(n, '0').split('').reverse().join('')} (lane 0 first)`)]));
      const xs = r.lanes.map((f) => f());
      regs.replaceChildren(h('table', null,
        h('tr', null, h('th'), ...Array.from({ length: n }, (_, i) => h('th', null, `lane ${i}`))),
        ...SHOWN.map((k) => h('tr', null, h('td', { class: 'lbl' }, ABI[k]), ...xs.map((x) => h('td', { class: x[k] ? '' : 'z' }, String(x[k] | 0)))))));
      const nz = r.ram.map((f, i) => [i, f()] as const).filter(([, v]) => v);
      mem.replaceChildren(...(nz.length ? nz.map(([i, v]) => h('div', { class: 'm' }, h('span', { class: 'n' }, `[${hex(i * 4, 2)}]`), h('span', { class: 'v' }, hex(v)), h('span', { class: 'd' }, String(v | 0)))) : [h('div', { class: 'm z' }, 'all zero')]));
    };
    // opening the immediate generator or the control unit keeps the instruction's colours
    const unNav = stage.onNavigate(() => update());
    update();
    return {
      el, update, destroy: () => {
        stop();
        slow.stop();
        unNav();
        stage.markNets(new Map());
        if (stage.path.length === 0) stage.highlight(stage.scene?.highlight ?? []);
      },
    };
  };
}

function maskEl(m: number, n: number): HTMLElement {
  return h('span', { class: 'mask' }, ...bits(m, n).map((b) => h('i', { class: b ? 'on' : '' })));
}

// ---- lanes against cores ---------------------------------------------------------------------

const CATS = ['Register files', 'ALUs', 'Program ROM', 'PC, decode, control, muxes', 'Memory and its sharing'];

interface Design { name: string; kind: string; parts: number[]; cycles: number }

function breakdown(def: ComponentDef, units: RegExp, n: number, rom: (def: ComponentDef) => number, shared: RegExp): number[] {
  const nl = def.netlist!();
  const total = stats(def).nands;
  const rf = n * stats(regfile(5, 32)).nands, al = n * stats(alu(32, 'ks')).nands;
  const roms = nl.instances.reduce((s, i) => s + (units.test(i.name) || i.name === 'imem' ? rom(i.def) : 0), 0);
  const mem = nl.instances.reduce((s, i) => s + (shared.test(i.name) ? stats(i.def).nands : 0), 0);
  return [rf, al, roms, total - rf - al - roms - mem, mem];
}

/** NANDs by block and cycles on saxpy: one core with four lanes against four cores, both measured. */
export function lanesVsCoresWidget(): Widget {
  const el = h('div', { class: 'widget lanes-vs-cores' });
  const sax = SIMT_PROGRAMS.find((p) => p.id === 'saxpy')!;
  const wl = assemble(sax.source).words, wc = assemble(SAXPY_CORES).words;
  const LC = laneCore(wl, 4), MC = multiCore(wc, 4);
  // a core's program ROM is its 'imem'; the lane core has one at its top level
  const romOf = (d: ComponentDef) => {
    const nl = d.netlist?.();
    const im = nl?.instances.find((i) => i.name === 'imem');
    return im ? stats(im.def).nands : d.id.startsWith('rom') ? stats(d).nands : 0;
  };
  const lanes: Design = { name: '1 core, 4 lanes', kind: 'laneCore(4)', parts: breakdown(LC, /^$/, 4, (d) => stats(d).nands, /^(dm|mAd|mWd|mseq|dwe)$/), cycles: 0 };
  const cores: Design = { name: '4 cores', kind: 'multiCore(4)', parts: breakdown(MC, /^core\d$/, 4, romOf, /^(dm|arb|gm|enc|am|wm|we|h\d)$/), cycles: 0 };
  const sm = new SimtISS(wl, { lanes: 4 }); sm.run(5000); lanes.cycles = sm.cycles;
  const mm = new MultiISS(wc, 4); for (let c = 0; c < 5000 && !mm.halted; c++) mm.step(); cores.cycles = mm.cycles;
  const rows = [cores, lanes];
  const tot = (d: Design) => d.parts.reduce((a, b) => a + b, 0);
  const max = Math.max(...rows.map(tot)) * 1.08;
  const W = 640, x0 = 130, bh = 26;
  const S = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(S, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W + 60} ${rows.length * 46 + 30}`);
  svg.setAttribute('class', 'lvc-bars');
  const add = (tag: string, a: Record<string, string | number>, text?: string) => {
    const e = document.createElementNS(S, tag);
    for (const k in a) e.setAttribute(k, String(a[k]));
    if (text !== undefined) e.textContent = text;
    svg.appendChild(e);
    return e;
  };
  for (const g of [50000, 100000, 150000]) {
    const x = x0 + ((W - x0) * g) / max;
    add('line', { x1: x, y1: 4, x2: x, y2: rows.length * 46 + 4, class: 'grid' });
    add('text', { x, y: rows.length * 46 + 20, 'text-anchor': 'middle', class: 'ax' }, `${g / 1000}K`);
  }
  rows.forEach((d, r) => {
    const y = 10 + r * 46;
    add('text', { x: x0 - 10, y: y + 12, 'text-anchor': 'end', class: 'nm' }, d.name);
    add('text', { x: x0 - 10, y: y + 25, 'text-anchor': 'end', class: 'ax' }, 'measured');
    let x = x0;
    d.parts.forEach((v, i) => {
      const w = ((W - x0) * v) / max;
      const rect = add('rect', { x, y, width: Math.max(0, w - 2), height: bh, rx: i === d.parts.length - 1 ? 4 : 0, fill: `var(--series-${i + 1})` });
      const t = document.createElementNS(S, 'title');
      t.textContent = `${d.name}: ${CATS[i]}, ${v.toLocaleString('en')} NANDs`;
      rect.appendChild(t);
      x += w;
    });
    add('text', { x: x + 8, y: y + 17, class: 'tot' }, tot(d).toLocaleString('en'));
  });
  const legend = h('div', { class: 'lvc-legend' }, ...CATS.map((c, i) => h('span', null, h('i', { style: `background:var(--series-${i + 1})` }), c)));
  const table = h('table', { class: 'lvc-table' },
    h('tr', null, h('th', null, 'NANDs'), ...CATS.map((c) => h('th', null, c)), h('th', null, 'Total'), h('th', null, 'saxpy cycles')),
    ...rows.map((d) => h('tr', null, h('td', null, d.name), ...d.parts.map((v) => h('td', null, v.toLocaleString('en'))), h('td', null, tot(d).toLocaleString('en')), h('td', null, String(d.cycles)))));
  const saving = 1 - tot(lanes) / tot(cores);
  el.append(h('div', { class: 'lvc-title' }, 'NAND gates by block, and cycles for saxpy on 16 elements'), legend, svg, table,
    h('p', { class: 'sub' }, `The lanes cost ${(100 * saving).toFixed(0)} % less, and take ${lanes.cycles} cycles against ${cores.cycles}: `
      + `${lanes.cycles > cores.cycles ? 'slower' : 'faster'}, because ${lanes.cycles > cores.cycles
        ? 'every load or store waits for all four lanes at once, while a core that waits on the memory port lets the others compute.'
        : 'one instruction does four elements.'} Both designs have one memory port.`));
  return { el };
}

/** What divergence costs: every kernel on the golden model, lanes busy per instruction. */
export function divergenceWidget(): Widget {
  const rows = SIMT_PROGRAMS.map((p) => {
    const m = new SimtISS(assemble(p.source).words, { lanes: 4 });
    m.run(5000);
    return h('tr', null, h('td', null, p.title), h('td', null, String(m.retired)), h('td', null, String(m.activeLaneSteps)), h('td', null, String(m.retired * 4)),
      h('td', null, `${(100 * m.utilization).toFixed(0)} %`), h('td', null, String(m.cycles)));
  });
  return { el: h('div', { class: 'widget' }, h('table', { class: 'lvc-table' },
    h('tr', null, h('th', null, 'Kernel (4 lanes)'), h('th', null, 'instructions'), h('th', null, 'lane-steps used'), h('th', null, 'available'), h('th', null, 'lanes busy'), h('th', null, 'cycles')), ...rows),
    h('p', { class: 'sub' }, 'Counted by the golden model, which the gate-level core matches cycle for cycle. The final j . (halt) counts as one instruction.')) };
}
