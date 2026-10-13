// Appendix A's transistor ledger: our RV32I and our 6502 counted block by block, the same functions
// side by side in each technology, and the count over the years. Every count of ours is measured
// from the circuits (sim/stats.ts); the real chips' counts are published figures.

import { FULL_ADDER } from '../lib/combinational';
import { singleCycleCpu } from '../lib/cpu';
import { controlUnit, datapath, m6502 } from '../lib/m6502/chip';
import { naoi } from '../lib/m6502/cells';
import { MS_BIT } from '../lib/m6502/demo';
import { NINV, NNAND2 } from '../lib/nmos';
import { DFF } from '../lib/sequential';
import { NAND } from '../lib/transistors';
import { assemble } from '../riscv/asm';
import { PROGRAMS } from '../riscv/programs';
import { stats } from '../sim/stats';
import { type ComponentDef, netlistOf } from '../sim/types';
import { h } from '../ui/dom';
import type { Widget } from '../view/stage';

const fmt = (n: number) => Math.round(n).toLocaleString('en');
const T = (d: ComponentDef) => stats(d).transistors;

/** Transistors per top-level block, largest first. */
function blocks(def: ComponentDef, names: Record<string, string>): { name: string; n: number; dep: number }[] {
  return (netlistOf(def)?.instances ?? []).filter((i) => i.def.prim !== 'alias')
    .map((i) => ({ name: names[i.name] ?? i.name, n: T(i.def), dep: stats(i.def).depletion }))
    .filter((b) => b.n > 0).sort((a, b) => b.n - a.n);
}

/** Published transistor counts (enhancement transistors where a source separates the loads). */
const HISTORY: [string, number, string?][] = [
  ['4004 (1971)', 2300], ['6502 (1975)', 3510], ['Z80 (1976)', 8500], ['8086 (1978)', 29000], ['68000 (1979)', 68000], ['80386 (1985)', 275000],
];

export function ledger(): Widget {
  const el = h('div', { class: 'm65-ledger' }, h('p', { class: 'm65-note' }, 'Counting…'));
  // measured after the first paint: building the RV32I's netlists takes a moment
  setTimeout(() => {
    const rv = singleCycleCpu(assemble(PROGRAMS[0].source).words);
    const rvB = blocks(rv, { rf: 'register file 32 × 32', dm: 'data memory 32 words', imem: 'program ROM 64 words', alu: 'ALU', imm: 'immediates', pc: 'PC' });
    const rvTotal = T(rv);
    const rvMem = rvB.filter((b) => /register file|memory|ROM/.test(b.name)).reduce((s, b) => s + b.n, 0);
    const chip = m6502();
    const names6502 = { decode: 'decode PLA', control: 'control lines', timing: 'timing', intr: 'interrupts', ir: 'IR', rega: 'A', regx: 'X', regy: 'Y', regs: 'S',
      alu: 'ALU', pc: 'PC', addr: 'address register', data: 'data latches', flags: 'P (flags)', buses: 'buses, precharge', clock: 'clock' };
    // the blocks of both units (the chip's top level is the control unit and the datapath)
    const cpuB = [...blocks(controlUnit(), names6502), ...blocks(datapath(), names6502)].sort((a, b) => b.n - a.n);
    const st = stats(chip);
    const max = Math.max(rvB[0].n, cpuB[0].n);
    const bar = (name: string, n: number, cls: string, note = '') => h('div', { class: 'm65-bar' },
      h('span', null, name), h('span', { class: 't' }, h('i', { class: cls, style: `width:${Math.max(0.4, (100 * n) / max)}%` })), h('span', { class: 'r' }, `${fmt(n)}${note}`));
    // one function in each technology: our CMOS NAND-only parts against the 6502's NMOS cells
    const regBit = netlistOf(datapath())!.instances.find((i) => i.name === 'rega')!.def;
    const adder6502 = 2 * T(naoi('ab|cd')) + T(naoi('ab|ac|bc')) + 2 * T(NINV);
    const rfBit = rvB.find((b) => /register file/.test(b.name))!.n / 1024;
    const rows: [string, number, number, string][] = [
      ['a 2-input gate', T(NAND), T(NNAND2), 'NAND: 2 + 2 transistors; NMOS: 2 pull-downs + a load'],
      ['a clocked bit', T(DFF), T(MS_BIT), 'master–slave flip-flop of NANDs; two dynamic latches on φ1 / φ2'],
      ['a register bit, two read ports', rfBit, T(regBit) / 8, 'flip-flop + its share of the read multiplexers; a refreshed node + bus pull-downs'],
      ['an adder bit', T(FULL_ADDER), adder6502, '9 NANDs; XOR, majority and sum as NMOS complex gates'],
      ['the whole CPU', rvTotal, st.transistors, 'single-cycle RV32I with its memories; the 6502 (memory off the chip)'],
    ];
    const lmax = Math.log10(Math.max(rvTotal, 3e5)), lmin = 3;
    const hist = [...HISTORY.map(([n, v]) => [n, v, 'real'] as const), ['our 6502', st.transistors, 'us'] as const,
      ['our RV32I, no memory', rvTotal - rvMem, 'rv'] as const, ['our RV32I', rvTotal, 'rv'] as const].sort((a, b) => a[1] - b[1]);
    el.replaceChildren(
      h('div', { class: 'm65-ledger-cols' },
        h('div', null,
          h('h5', null, `Our RV32I: ${fmt(rvTotal)} transistors`), ...rvB.slice(0, 7).map((b) => bar(b.name, b.n, 'rv')),
          h('h5', null, `Our 6502: ${fmt(st.transistors)} transistors, ${fmt(st.depletion)} of them loads`), ...cpuB.slice(0, 10).map((b) => bar(b.name, b.n, 'us')),
          h('p', { class: 'm65-note' }, `The real 6502: 3,510 transistors plus about 1,018 depletion loads (4,528). The bars share one scale: the RV32I's register file alone is ${fmt(rvB[0].n / st.transistors)} of our 6502s.`)),
        h('div', null,
          h('h5', null, 'One function, two technologies (transistors)'),
          h('table', { class: 'm65-cmp' },
            h('tr', null, h('th', null, ''), h('th', null, 'our RV32I parts'), h('th', null, 'our 6502'), h('th', null, '×')),
            ...rows.map(([what, a, b, how]) => h('tr', { title: how }, h('td', null, what), h('td', null, fmt(a)), h('td', null, fmt(b)), h('td', null, `${(a / b).toFixed(1)}`)))),
          h('h5', null, 'Transistors per CPU (log scale)'),
          h('div', { class: 'm65-hist' }, ...hist.map(([n, v, k]) => h('div', { class: k, title: `${n}: ${fmt(v)}` },
            h('b', null, v >= 1e5 ? `${Math.round(v / 1000)}k` : fmt(v)),
            h('i', { style: `height:${(100 * (Math.log10(v) - lmin + 0.3)) / (lmax - lmin + 0.3)}%` }),
            h('span', null, n)))))));
  }, 30);
  return { el };
}
