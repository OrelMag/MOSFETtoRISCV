// Chapter 14's control table and clock-period widgets. The table is the real CONTROL unit evaluated on one instruction
// of each class; the period widget draws the static critical path (sim/timing.ts) and the settle times measured per
// instruction class on the gate-level CPU (riscv/cycletime.ts).

import { CONTROL } from '../lib/cpu';
import { assemble } from '../riscv/asm';
import { measureClasses, type CycleTimes } from '../riscv/cycletime';
import { evalOnce, simulate } from '../sim/harness';
import { pack } from '../sim/values';
import { h } from '../ui/dom';
import type { Stage, Widget } from '../view/stage';
import '../styles/cpucost.css';

/** One instruction per control class, in the order the table lists them. */
export const CONTROL_ROWS = [
  'add a0, a1, a2', 'sub a0, a1, a2', 'addi a0, a1, 5', 'srai a0, a1, 3', 'lw a0, 8(a1)', 'sw a0, 8(a1)',
  'beq a0, a1, L', 'jal ra, L', 'jalr ra, 0(a1)', 'lui a0, 0x12345', 'auipc a0, 1',
] as const;

const ALU_NAMES: Record<number, string> = { 0: 'ADD', 1: 'SLL', 2: 'SLT', 3: 'SLTU', 4: 'XOR', 5: 'SRL', 6: 'OR', 7: 'AND', 8: 'SUB', 13: 'SRA' };
const IMM = ['I', 'S', 'B', 'U', 'J'];
const RES = ['ALU', 'mem', 'PC + 4', 'imm'];

export interface ControlRow {
  asm: string;
  regWrite: number;
  imm: string;
  srcA: string;
  srcB: string;
  memWrite: number;
  result: string;
  branch: number;
  jump: number;
  jalr: number;
  alu: string;
  /** The raw output words, for the test. */
  raw: number[];
}

/** CONTROL evaluated on each instruction (the opcode and function fields of its assembled word). */
export function controlRows(): ControlRow[] {
  const sim = simulate(CONTROL, 'gate');
  return CONTROL_ROWS.map((asm) => {
    const w = assemble(`${asm}\nL: nop`).words[0];
    const o = evalOnce(sim, [w & 0x7f, (w >>> 12) & 7, (w >>> 25) & 0x7f]);
    // outputs in port order: regWrite, immSrc, aluSrcA, aluSrcB, memWrite, resultSrc, branch, jump, jalr, aluCtl
    const [regWrite, immSrc, srcA, srcB, memWrite, resultSrc, branch, jump, jalr, aluCtl] = o;
    return {
      asm, regWrite, imm: IMM[immSrc] ?? String(immSrc), srcA: srcA ? 'PC' : 'rs1', srcB: srcB ? 'imm' : 'rs2', memWrite,
      result: RES[resultSrc], branch, jump, jalr, alu: ALU_NAMES[aluCtl] ?? String(aluCtl), raw: o,
    };
  });
}

/** A program with one instruction of each row, in order; a branch or jump goes to the next one, so every row is reachable by falling through. */
export const CONTROL_SOURCE = (() => {
  const out: string[] = ['# one instruction of each control class: click a row of the table'];
  CONTROL_ROWS.forEach((r, i) => {
    out.push(`        ${r.replace(', L', `, n${i}`)}`);
    if (r.endsWith(', L')) out.push(`n${i}:`);
  });
  out.push('halt:   j    halt');
  return out.join('\n');
})();

/** The control table as a panel beside the circuit: a row loads that instruction (a reset, then i cycles) and lights up as the PC reaches it. */
export function controlPanel(stage: Stage): Widget {
  const rows = controlRows();
  const head: [string, string][] = [['instr', 'instruction'], ['RegW', 'RegWrite'], ['ImmSrc', 'ImmSrc'], ['SrcA', 'SrcA'], ['SrcB', 'SrcB'], ['MemW', 'MemWrite'], ['Result', 'ResultSrc'], ['Br', 'Branch'], ['Jmp', 'Jump'], ['Jalr', 'Jalr'], ['ALU', 'ALUControl']];
  const trs = rows.map((r, i) => {
    const tr = h('tr', { tabindex: '0', role: 'button', 'aria-label': `run ${r.asm.replace(', L', ', …')}`, onclick: () => load(i), onkeydown: (e: Event) => { const k = (e as KeyboardEvent).key; if (k === 'Enter' || k === ' ') { e.preventDefault(); load(i); } } },
      h('td', { title: r.asm.replace(', L', ', …') }, h('code', null, r.asm.split(' ')[0])), ...[r.regWrite, r.imm, r.srcA, r.srcB, r.memWrite, r.regWrite ? r.result : '–', r.branch, r.jump, r.jalr, r.alu].map((v) => h('td', null, String(v))));
    return tr;
  });
  const load = (i: number) => {
    stage.checkpoint();
    stage.powerCycle();
    stage.runCycles(i);
    update();
  };
  const title = h('h4', null, 'Control table', h('span', { class: 'fold-hint' }));
  const el = h('div', { class: 'mem-panel ctl-panel', 'data-dock': 'left', 'data-fold': 'narrow', 'data-keep': 'open', 'data-phone': 'flow' }, title,
    h('div', { class: 'ctl-scroll' }, h('table', { class: 'mini ctl-tab' }, h('thead', null, h('tr', null, ...head.map(([x, full]) => h('th', { title: full }, x)))), h('tbody', null, ...trs))),
    h('p', { class: 'sub' }, 'Click a row: the CPU resets and runs up to that instruction.'));
  const update = () => {
    const root = stage.rootCtx?.node;
    const sim = stage.sim;
    if (!sim || !root?.ports.pcOut) return;
    const pc = pack(sim.getBits(root.ports.pcOut)) >> 2;
    trs.forEach((tr, i) => tr.classList.toggle('sel', i === pc));
  };
  return { el, update };
}

// ---- the clock period ----------------------------------------------------------------------------------

/** The single-cycle CPU's NANDs without its program ROM, ripple adders (chapter 14 quotes it; pinned by tests/ship-figures.test.ts). */
export const CPU_NANDS = 48434;

/** The static critical path of the CPU with each adder, NAND delays per block (sim/timing.ts; pinned by tests/cycletime.test.ts). */
export const PERIOD = {
  rca: { pc: 155, rf: 132, dm: 79, stages: [['pc', 3], ['imem', 18], ['ctl', 11], ['imm', 7], ['srcB', 2], ['alu', 93], ['npc', 11], ['pcmux', 5], ['setup', 5]] as [string, number][] },
  ks: { pc: 103, rf: 80, dm: 75, stages: [['pc', 3], ['imem', 18], ['ctl', 11], ['imm', 7], ['srcB', 2], ['alu', 41], ['npc', 11], ['pcmux', 5], ['setup', 5]] as [string, number][] },
};

export function cpuPeriodWidget(): Widget {
  let adder: 'rca' | 'ks' = 'rca';
  const cache = new Map<string, CycleTimes>();
  const ribbon = h('div', { class: 'cp-ribbon' }), bars = h('div', { class: 'cp-bars' }), note = h('p', { class: 'sub' });
  const btn = h('button', { class: 'btn sm primary' }, 'Measure on the gates') as HTMLButtonElement;
  const sw = (['rca', 'ks'] as const).map((a) => h('button', { class: 'btn sm', onclick: () => { adder = a; paint(); } }, a === 'rca' ? 'Ripple adder' : 'Kogge–Stone'));
  const paint = () => {
    sw.forEach((b, i) => b.classList.toggle('primary', (i === 0) === (adder === 'rca')));
    const p = PERIOD[adder];
    ribbon.replaceChildren(...p.stages.map(([n, d]) => h('span', { class: 'cp-seg', style: `flex:${Math.max(d, 3)}`, title: `${n}: ${d} delays` }, h('b', null, n), h('i', null, String(d)))));
    const r = cache.get(adder);
    const top = Math.max(p.pc, r?.worst ?? 0);
    bars.replaceChildren(
      h('div', { class: 'cp-row' }, h('span', null, 'static critical path'), h('div', { class: 'cp-track' }, h('div', { class: 'cp-fill st', style: `width:${(100 * p.pc) / top}%` })), h('b', null, String(p.pc))),
      ...(r ? r.classes.filter((c) => c.n).map((c) => h('div', { class: 'cp-row' }, h('span', null, h('code', null, c.cls), ` ${c.label}`),
        h('div', { class: 'cp-track' }, h('div', { class: 'cp-fill', style: `width:${(100 * c.max) / top}%` }), h('div', { class: 'cp-mean', style: `left:${(100 * c.mean) / top}%` })), h('b', null, `${c.max}`))) : []));
    note.textContent = r
      ? `Settle time after the edge over ${r.cycles} cycles of three random programs: bar = longest seen, tick = mean. The clock must cover the static path, ${p.pc} delays (${((p.pc * 25) / 1000).toFixed(2)} ns at 25 ps a delay), not the longest cycle seen.`
      : `Static timing, in NAND delays: the clock must cover ${p.pc}. Writing the register file needs ${p.rf}, the data memory ${p.dm}.`;
    btn.disabled = cache.has(adder);
  };
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Measuring …';
    const a = adder;
    cache.set(a, await measureClasses(a, [1, 2, 3], 60, () => new Promise((res) => setTimeout(res, 0))));
    btn.textContent = 'Measure on the gates';
    paint();
  });
  paint();
  return {
    el: h('div', { class: 'widget' }, h('div', { class: 'panel' }, h('h3', null, 'The critical path, block by block (NAND delays)'), h('div', { class: 'cp-sws' }, ...sw), ribbon,
      h('h3', null, 'Settle time by instruction class'), bars, h('div', null, btn), note)),
  };
}
