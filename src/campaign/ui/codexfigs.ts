// Figures for codex entries that have no library part to draw: the site's own widgets, live or computed when the
// entry opens (the pipeline diagrams run the gate-level pipeline for a few cycles), so they cannot drift either.

import { pipelinedCpu } from '../../lib';
import { assemble } from '../../riscv/asm';
import { clockCycle, pipeSnap, type PipeSnap } from '../../riscv/cosim';
import type { Fmt } from '../../riscv/isa';
import { flatten } from '../../sim/flatten';
import { GateSim } from '../../sim/gatesim';
import { h } from '../../ui/dom';
import { numberWidget } from '../../widgets/numbers';
import { formatStrip, instrBreakdown } from '../../widgets/instrfields';
import { pipeGridRows } from '../../widgets/pipegrid';
import { adderComparison } from '../../widgets/timing';

export interface CodexFigure { el: HTMLElement; caption: string; destroy?: () => void }

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
  pipeline: () => pipelineRun(INDEP, 11, 'Independent instructions on the chapters' gate-level RV32I pipeline: after four cycles of fill, one retires every cycle.'),
  hazards: () => pipelineRun(HAZARDS, 13, 'Every data hazard in a row, on the chapters' gate-level RV32I pipeline (it bypasses W into D where RV16 writes its registers at the falling edge): the event row marks each forward and the load-use stall.'),
  forwarding: () => pipelineRun(HAZARDS, 13, 'The event row marks where a value is forwarded (M→E, W→E) instead of waited for.'),
  loaduse: () => pipelineRun(HAZARDS, 13, 'The add after the load is held in D for one cycle: a bubble enters E.'),
  stall: () => pipelineRun(HAZARDS, 13, 'A stall freezes F and D for a cycle and sends a bubble down the pipe.'),
  flush: () => pipelineRun(BRANCH, 10, 'A taken branch resolved in E: the two instructions fetched behind it become bubbles.'),
  controlhazard: () => pipelineRun(BRANCH, 10, 'The pipeline fetched two wrong-path instructions before the branch resolved; both are flushed.'),
};

/** The figure for an entry, or null. */
export function codexFigure(id: string): CodexFigure | null {
  return FIGS[id]?.() ?? null;
}

export const hasCodexFigure = (id: string): boolean => id in FIGS;
