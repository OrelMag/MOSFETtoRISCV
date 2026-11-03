// Chapter 14's control table and clock-period widgets. The table is the real CONTROL unit evaluated on one instruction
// of each class; the period widget draws the static critical path (sim/timing.ts) and the settle times measured per
// instruction class on the gate-level CPU (riscv/cycletime.ts).

import { CONTROL } from '../lib/cpu';
import { assemble } from '../riscv/asm';
import { measureClasses, type CycleTimes } from '../riscv/cycletime';
import { evalOnce, simulate } from '../sim/harness';
import { h } from '../ui/dom';
import type { Widget } from '../view/stage';
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

/** The table as HTML, for a step's body. */
export function controlTableHtml(): string {
  const rows = controlRows();
  const head = ['instruction', 'RegWrite', 'ImmSrc', 'SrcA', 'SrcB', 'MemWrite', 'ResultSrc', 'Branch', 'Jump', 'Jalr', 'ALUControl'];
  const body = rows.map((r) => `<tr><td><code>${r.asm.replace(', L', ', …')}</code></td><td>${r.regWrite}</td><td>${r.imm}</td><td>${r.srcA}</td><td>${r.srcB}</td><td>${r.memWrite}</td><td>${r.regWrite ? r.result : '–'}</td><td>${r.branch}</td><td>${r.jump}</td><td>${r.jalr}</td><td>${r.alu}</td></tr>`).join('');
  return `<table class="mini ctl-tab"><tr>${head.map((x) => `<th>${x}</th>`).join('')}</tr>${body}</table>`;
}

// ---- the clock period ----------------------------------------------------------------------------------

/** The static critical path of the CPU with each adder, NAND delays per block (sim/timing.ts; pinned by tests/cycletime.test.ts). */
export const PERIOD = {
  rca: { pc: 155, rf: 132, dm: 79, stages: [['pc', 3], ['imem', 18], ['ctl', 11], ['imm', 7], ['srcB', 2], ['alu', 93], ['npc', 11], ['pcmux', 5], ['setup', 5]] as [string, number][] },
  ks: { pc: 103, rf: 80, dm: 75, stages: [['pc', 3], ['imem', 18], ['ctl', 11], ['imm', 7], ['srcB', 2], ['alu', 41], ['npc', 11], ['pcmux', 5], ['setup', 5]] as [string, number][] },
};

export function cpuPeriodWidget(): Widget {
  let adder: 'rca' | 'ks' = 'rca';
  const cache = new Map<string, CycleTimes>();
  const ribbon = h('div', { class: 'cp-ribbon' }), bars = h('div', { class: 'cp-bars' }), note = h('p', { class: 'sub' });
  const btn = h('button', { class: 'ghost' }, 'Measure on the gates') as HTMLButtonElement;
  const sw = (['rca', 'ks'] as const).map((a) => h('button', { class: 'cp-sw', onclick: () => { adder = a; paint(); } }, a === 'rca' ? 'Ripple adder' : 'Kogge–Stone'));
  const paint = () => {
    sw.forEach((b, i) => b.classList.toggle('on', (i === 0) === (adder === 'rca')));
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
