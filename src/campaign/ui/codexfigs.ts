// Figures for codex entries that have no library part to draw: the site's own widgets, live or computed when the
// entry opens (the pipeline diagrams run the gate-level pipeline for a few cycles), so they cannot drift either.

import { pipelinedCpu } from '../../lib';
import { assemble } from '../../riscv/asm';
import { clockCycle, pipeSnap, type PipeSnap } from '../../riscv/cosim';
import type { Fmt } from '../../riscv/isa';
import { flatten } from '../../sim/flatten';
import { GateSim } from '../../sim/gatesim';
import { h } from '../../ui/dom';
import type { Widget } from '../../view/stage';
import { numberWidget } from '../../widgets/numbers';
import { formatStrip, instrBreakdown } from '../../widgets/instrfields';
import { pipeGridRows } from '../../widgets/pipegrid';
import { adderComparison } from '../../widgets/timing';

export interface CodexFigure {
  el: HTMLElement;
  caption: string;
  destroy?: () => void;
  /** A chapter's widget, drawn for a page's width: shown under the entry's columns, full width. */
  wide?: boolean;
}

const INDEP = ['li a0, 1', 'li a1, 2', 'li a2, 3', 'li a3, 4', 'li a4, 5', 'li a5, 6', 'halt: j halt'];
const HAZARDS = ['li t0, 5', 'li t1, 7', 'add t2, t0, t1', 'sub t3, t2, t0', 'sw t3, 0(zero)', 'lw t4, 0(zero)', 'addi t5, t4, 1', 'halt: j halt'];
const BRANCH = ['li t0, 1', 'beq t0, t0, skip', 'addi t1, zero, 99', 'addi t1, zero, 98', 'skip: addi a0, t0, 1', 'halt: j halt'];

/** The gate-level pipeline run for `cycles` cycles on `lines`, drawn as the chapters' pipeline diagram. */
function pipelineRun(lines: string[], cycles: number, caption: string): CodexFigure {
  const grid = h('div', { class: 'pipe-grid cx-pipe' }, h('p', { class: 'sub' }, 'Running the gate-level RV32I pipeline…'));
  const timer = setTimeout(() => {
    if (!grid.isConnected) return; // the entry was left before the run started
    const words = assemble(lines.join('\n')).words;
    const sim = new GateSim(flatten(pipelinedCpu(words)));
    sim.setInput('clk', 0);
    sim.settle();
    const snaps: PipeSnap[] = [];
    for (let c = 1; c <= cycles; c++) {
      clockCycle(sim);
      const s = pipeSnap(sim, sim.design.root, c);
      if (s) snaps.push(s);
    }
    grid.replaceChildren(...pipeGridRows(snaps, (pc) => words[pc >>> 2], cycles));
  }, 30);
  const listing = h('pre', { class: 'cx-listing' }, lines.join('\n'));
  return { el: h('div', null, listing, grid), caption, destroy: () => clearTimeout(timer) };
}

const fields = (fmts: Fmt[]) => h('div', { class: 'cx-fields' }, fmts.map((f) => h('div', null, h('b', null, `${f}-type`), formatStrip(f))));
const breakdown = (src: string) => instrBreakdown(assemble(src).words[0]);
const live = (w: { el: HTMLElement; destroy?: () => void }, caption: string): CodexFigure => ({ el: w.el, caption, destroy: w.destroy });

/**
 * A widget from a chunk of its own (a chapter's widget module), loaded when the entry opens, and destroyed once the
 * entry has left the page (an interval, a WebGL context or a running simulation stops with it).
 */
function lazy(load: () => Promise<Widget>, caption: string): CodexFigure {
  const host = h('div', { class: 'cx-lazy' }, h('p', { class: 'sub' }, 'Loading the figure…'));
  let w: Widget | null = null, gone = false, watch: ReturnType<typeof setInterval> | undefined;
  const destroy = () => {
    gone = true;
    if (watch !== undefined) clearInterval(watch);
    w?.destroy?.();
  };
  void load().then((x) => {
    if (gone) return x.destroy?.();
    w = x;
    host.replaceChildren(x.el);
    watch = setInterval(() => { if (!host.isConnected) destroy(); }, 2000);
  }, () => { host.replaceChildren(h('p', { class: 'sub' }, 'The figure could not load.')); });
  return { el: host, caption, destroy, wide: true };
}

/** Amdahl's law drawn: speed-up against cores for a few parallel fractions, the ceilings 1 / (1 − p) dashed. */
function amdahlCurve(): HTMLElement {
  const W = 360, H = 220, L = 34, B = 26, T = 10, R = 92, maxN = 64, maxS = 40;
  const x = (n: number) => L + (Math.log2(n) / Math.log2(maxN)) * (W - L - R);
  const y = (sp: number) => H - B - (Math.min(sp, maxS) / maxS) * (H - B - T);
  const ns = Array.from({ length: 61 }, (_, i) => 2 ** (i / 10));
  const path = (p: number) => ns.map((n, i) => `${i ? 'L' : 'M'}${x(n).toFixed(1)},${y(1 / ((1 - p) + p / n)).toFixed(1)}`).join('');
  const lines = [0.5, 0.9, 0.95, 0.99].map((p, i) => {
    const cap = 1 / (1 - p), s64 = 1 / ((1 - p) + p / maxN);
    return `<path d="${path(p)}" class="amd-l amd-${i}"/><text x="${W - R + 4}" y="${y(s64) + 4}" class="amd-t">p = ${p}: ${s64.toFixed(1)}×</text>`
      + (cap <= maxS ? `<path d="M${L},${y(cap)}H${W - R}" class="amd-cap"/>` : '');
  }).join('');
  const xt = [1, 2, 4, 8, 16, 32, 64].map((n) => `<text x="${x(n)}" y="${H - 10}" class="amd-a" text-anchor="middle">${n}</text>`).join('');
  const yt = [1, 10, 20, 30, 40].map((v) => `<path d="M${L},${y(v)}H${W - R}" class="amd-g"/><text x="${L - 6}" y="${y(v) + 4}" class="amd-a" text-anchor="end">${v}×</text>`).join('');
  const el = h('div', { class: 'cx-amdahl' });
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Speed-up against cores for parallel fractions 0.5, 0.9, 0.95 and 0.99">${yt}${xt}${lines}<text x="${(L + W - R) / 2}" y="${H - 1}" class="amd-a" text-anchor="middle">cores (log scale)</text></svg>`;
  return el;
}

const FIGS: Record<string, () => CodexFigure> = {
  positional: () => live(numberWidget(8, false), 'The number explorer: click a bit to flip it and read the same pattern in binary, hex and decimal.'),
  hex: () => live(numberWidget(8, false), 'Click bits: each hex digit is one group of four.'),
  twos: () => live(numberWidget(8, false), 'Set the top bit: the unsigned and the two\'s-complement readings part ways by 256.'),
  overflow: () => live(numberWidget(8, false), 'Walk a value past 127 and watch the signed reading wrap.'),
  formats: () => ({ el: fields(['R', 'I', 'S', 'B', 'U', 'J']), caption: 'The six RV32I formats: rs1, rs2 and rd never move; the immediate is scattered so that they can stay put.' }),
  isa: () => ({ el: breakdown('add a0, a1, a2'), caption: 'One instruction word, field by field.' }),
  loadstore: () => ({ el: h('div', { class: 'cx-fields' }, breakdown('lw a0, 8(sp)'), breakdown('sw a0, 8(sp)')), caption: 'A load and a store: the same base + offset, the offset split in the S format so rs2 keeps its place.' }),
  assembly: () => ({ el: breakdown('addi a0, a0, 1'), caption: 'What the assembler makes of one line: opcode, registers and the immediate in their fields.' }),
  criticalpath: () => live(adderComparison(), 'Adders compared on gates and depth: the depth is the critical path through each.'),
  pipeline: () => pipelineRun(INDEP, 11, 'Independent instructions on the chapters\' gate-level RV32I pipeline: after four cycles of fill, one retires every cycle.'),
  hazards: () => pipelineRun(HAZARDS, 13, 'Every data hazard in a row, on the chapters\' gate-level RV32I pipeline (it bypasses W into D where RV16 writes its registers at the falling edge): the event row marks each forward and the load-use stall.'),
  forwarding: () => pipelineRun(HAZARDS, 13, 'The event row marks where a value is forwarded (M→E, W→E) instead of waited for.'),
  loaduse: () => pipelineRun(HAZARDS, 13, 'The add after the load is held in D for one cycle: a bubble enters E.'),
  stall: () => pipelineRun(HAZARDS, 13, 'A stall freezes F and D for a cycle and sends a bubble down the pipe.'),
  flush: () => pipelineRun(BRANCH, 10, 'A taken branch resolved in E: the two instructions fetched behind it become bubbles.'),
  controlhazard: () => pipelineRun(BRANCH, 10, 'The pipeline fetched two wrong-path instructions before the branch resolved; both are flushed.'),
  fde: () => pipelineRun(INDEP, 11, 'The same steps on the chapters\' gate-level RV32I pipeline, each in a stage of its own: F, D, E, M and W work on five instructions at once.'),
  bin2dec: () => live(numberWidget(8, false), 'The same bits in binary and decimal: flip one and watch the decimal digits change.'),
  amdahl: () => ({ el: amdahlCurve(), caption: 'Speed-up = 1 / ((1 − p) + p / n), at 64 cores on the right. Dashed: the ceilings 1 / (1 − p) for p = 0.5, 0.9 and 0.95.' }),
  cpi: () => lazy(() => import('../../widgets/perf').then((m) => m.perfTable('Time per instruction = CPI × period', [
    { name: 'Single-cycle, Kogge–Stone', pipeline: false, adder: 'ks' },
    { name: 'Pipeline, balanced, Kogge–Stone', pipeline: true, adder: 'ks', balanced: true },
    { name: 'Pipeline, balanced + BTB', pipeline: true, adder: 'ks', balanced: true, predictor: true },
  ], ['fib', 'gcd', 'mul'], 'Single-cycle: CPI 1 and a long period. Pipelined: a short period, and a CPI above 1 from stalls and flushes.')), 'Measured on the chapters\' gate-level RV32I CPUs: periods from static timing, CPI from running the programs.'),
  memwall: () => lazy(() => import('../../widgets/dramtiming').then((m) => m.timingWidget()), 'DDR4\'s timings are set in nanoseconds; counted in cycles of a faster clock, the wait grows.'),
  rowbuffer: () => lazy(() => import('../../widgets/dramtiming').then((m) => m.rowBufferWidget()), 'Request streams against the row buffers: hits, conflicts and closed banks.'),
  pagepolicy: () => lazy(() => import('../../widgets/dramwork').then((m) => m.ctrlExplorer()), 'The benchmarks\' line requests priced by page policy, bank count and address mapping.'),
  amat: () => lazy(() => import('../../widgets/cache').then((m) => m.hierarchyWidget()), 'The memory hierarchy: each level\'s size against its access time.'),
  threecs: () => lazy(() => import('../../widgets/cache').then((m) => m.cacheExplorer({ trace: 'colmajor' })), 'A real program\'s trace through a cache of your choice, every miss classified compulsory, capacity or conflict.'),
  assoc: () => lazy(() => import('../../widgets/cache').then((m) => m.cacheExplorer({ trace: 'colmajor', ways: 2 })), 'Change the ways and watch the conflict misses go.'),
  writepolicy: () => lazy(() => import('../../widgets/cache').then((m) => m.cacheExplorer({ write: 'wt' })), 'Switch between write-through and write-back and compare the traffic to memory.'),
  hollerith: () => lazy(() => import('../../widgets/cards').then((m) => m.cardEditorWidget()), 'Type a line and see its holes: a character a column, in zone and digit rows.'),
  relaystep: () => lazy(() => import('../../widgets/relay3d').then((m) => m.relayCloseup()), 'The relay\'s physics model: flux, armature travel, contact bounce, pull-in and drop-out.'),
  stdcell: () => lazy(() => import('../../widgets/silicon').then((m) => m.mappingWidget()), 'A netlist mapped onto a real cell library.'),
  skew: () => lazy(() => import('../../widgets/silicon').then((m) => m.clockTreeWidget()), 'A clock tree: balanced branches bring the edge to every flip-flop at the same time.'),
  coherence: () => lazy(() => import('../../widgets/multicore').then((m) => m.coherenceWidget()), 'Two caches under a snooping protocol: every read and write, and the line states it leaves.'),
  throughput: () => lazy(() => import('../../widgets/lanes').then((m) => m.lanesVsCoresWidget()), 'Lanes against cores: the same work, priced in gates and cycles.'),
  divergence: () => lazy(() => import('../../widgets/lanes').then((m) => m.divergenceWidget()), 'A branch the lanes disagree on: each side runs with the other lanes masked off.'),
  utilization: () => lazy(() => import('../../widgets/lanes').then((m) => m.divergenceWidget()), 'Masked lanes do nothing: utilization falls with every split.'),
  occupancy: () => lazy(() => import('../../widgets/warps').then((m) => m.occupancyWidget()), 'Resident warps against cycles: more warps fill more issue slots.'),
  scoreboard: () => lazy(() => import('../../widgets/ooo').then((m) => m.scoreboardWidget()), 'The CDC 6600\'s scoreboard, cycle by cycle: an instruction issues when the registers it needs are not pending.'),
};

/** The figure for an entry, or null. */
export function codexFigure(id: string): CodexFigure | null {
  return FIGS[id]?.() ?? null;
}

export const hasCodexFigure = (id: string): boolean => id in FIGS;
