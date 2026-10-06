// "Recreate every level": the journey from transistors to a program-fetching datapath, drawn in
// the sandbox the way a learner would (pins, parts, wires, pointers), each chip built from the
// chips of the rung below, and checked against the library part it recreates.

import { describe, expect, it } from 'vitest';
import { checkSimulatable, type Compiled } from '../src/editor/compile';
import { UserLibrary } from '../src/editor/library';
import type { ChipDoc, PartRef, Vec, WireDoc } from '../src/editor/model';
import { buildProgram } from '../src/editor/program';
import { aluSpec, AND, D_LATCH, DFF, DRAM_CELL, INV_CMOS, NAND, NOR_CMOS, NOT, OR, ram, SR_LATCH, SRAM_CELL, SRAM_COLUMN, XOR } from '../src/lib';
import { counter, register } from '../src/lib/sequential';
import { flatten, findNode } from '../src/sim/flatten';
import { evalOnce, forEachInput, simulate } from '../src/sim/harness';
import type { Sim } from '../src/sim/sim';
import { SwitchSim } from '../src/sim/switchsim';
import { analyzeTiming } from '../src/sim/timing';
import { synthVerilog } from '../src/sim/vexport';
import { B0, B1, BZ, type ComponentDef, inPorts, netlistOf } from '../src/sim/types';
import { chip, fan, lbl, part, pin, wire, workspace } from './editorkit';
import { lcg, out, set, tick } from './util';

const L = (lib: string): PartRef => ({ lib });
const C = (id: string): PartRef => ({ chip: id });
const clk = (at: Vec) => ({ ...pin('clk', 'in', at), kind: 'clock' as const });

// ---- rung 1: CMOS cells from transistors -----------------------------------------------------

const inverter = chip('u_inv', 'CMOS inverter', {
  pins: [pin('a', 'in', [0, 8]), pin('y', 'out', [14, 8])],
  parts: [part('vdd', L('vdd'), [7, 0]), part('p1', L('pmos'), [5, 3]), part('n1', L('nmos'), [5, 9]), part('gnd', L('gnd'), [7, 14])],
  wires: [...fan('a', 'pin:a', 'p1.g', 'n1.g'), wire('up', 'vdd.p', 'p1.s'), wire('mid', 'p1.d', 'n1.d'), wire('y', 'n1.d', 'pin:y'), wire('dn', 'gnd.p', 'n1.s')],
});

// Parallel pull-up, series pull-down.
const nand = chip('u_nand', 'CMOS NAND', {
  pins: [pin('a', 'in', [0, 5]), pin('b', 'in', [0, 17]), pin('y', 'out', [20, 8])],
  parts: [
    part('vdd', L('vdd'), [10, 0]), part('p1', L('pmos'), [6, 3]), part('p2', L('pmos'), [12, 3]),
    part('n1', L('nmos'), [12, 10]), part('n2', L('nmos'), [12, 15]), part('gnd', L('gnd'), [14, 20]),
  ],
  wires: [
    ...fan('a', 'pin:a', 'p1.g', 'n1.g'), ...fan('b', 'pin:b', 'p2.g', 'n2.g'), ...fan('vdd', 'vdd.p', 'p1.s', 'p2.s'),
    ...fan('y', 'pin:y', 'p1.d', 'p2.d', 'n1.d'), wire('m', 'n1.s', 'n2.d'), wire('gnd', 'gnd.p', 'n2.s'),
  ],
});

// Series pull-up, parallel pull-down.
const nor = chip('u_nor', 'CMOS NOR', {
  pins: [pin('a', 'in', [0, 4]), pin('b', 'in', [0, 9]), pin('y', 'out', [18, 12])],
  parts: [
    part('vdd', L('vdd'), [12, 0]), part('p1', L('pmos'), [10, 2]), part('p2', L('pmos'), [10, 7]),
    part('n2', L('nmos'), [4, 13]), part('n1', L('nmos'), [10, 13]), part('gnd', L('gnd'), [9, 19]),
  ],
  wires: [
    ...fan('a', 'pin:a', 'p1.g', 'n1.g'), ...fan('b', 'pin:b', 'p2.g', 'n2.g'), wire('vdd', 'vdd.p', 'p1.s'), wire('m', 'p1.d', 'p2.s'),
    ...fan('y', 'p2.d', 'n1.d', 'n2.d', 'pin:y'), ...fan('gnd', 'gnd.p', 'n1.s', 'n2.s'),
  ],
});

// ---- rung 2: every gate from the user's NAND --------------------------------------------------

const N = C('u_nand');
const not = chip('u_not', 'NOT', {
  pins: [pin('a', 'in', [0, 2]), pin('y', 'out', [12, 2])],
  parts: [part('g', N, [5, 0])],
  wires: [...fan('a', 'pin:a', 'g.a', 'g.b'), wire('y', 'g.y', 'pin:y')],
});
const and = chip('u_and', 'AND', {
  pins: [pin('a', 'in', [0, 1]), pin('b', 'in', [0, 3]), pin('y', 'out', [20, 2])],
  parts: [part('g', N, [4, 0]), part('i', C('u_not'), [12, 1])],
  wires: [wire('a', 'pin:a', 'g.a'), wire('b', 'pin:b', 'g.b'), wire('m', 'g.y', 'i.a'), wire('y', 'i.y', 'pin:y')],
});
const or = chip('u_or', 'OR', {
  pins: [pin('a', 'in', [0, 1]), pin('b', 'in', [0, 7]), pin('y', 'out', [20, 4])],
  parts: [part('ia', C('u_not'), [3, 0]), part('ib', C('u_not'), [3, 6]), part('g', N, [12, 2])],
  wires: [wire('a', 'pin:a', 'ia.a'), wire('b', 'pin:b', 'ib.a'), wire('na', 'ia.y', 'g.a'), wire('nb', 'ib.y', 'g.b'), wire('y', 'g.y', 'pin:y')],
});
const xor = chip('u_xor', 'XOR', {
  pins: [pin('a', 'in', [0, 2]), pin('b', 'in', [0, 10]), pin('y', 'out', [30, 6])],
  parts: [part('g1', N, [6, 5]), part('g2', N, [14, 1]), part('g3', N, [14, 9]), part('g4', N, [22, 4])],
  wires: [
    ...fan('a', 'pin:a', 'g1.a', 'g2.a'), ...fan('b', 'pin:b', 'g1.b', 'g3.b'), ...fan('m', 'g1.y', 'g2.b', 'g3.a'),
    wire('p', 'g2.y', 'g4.a'), wire('q', 'g3.y', 'g4.b'), wire('y', 'g4.y', 'pin:y'),
  ],
});

// ---- rung 3: the 9-NAND full adder, four of them in a ripple-carry adder ----------------------

const fa = chip('u_fa', 'Full adder', {
  pins: [pin('a', 'in', [0, 2]), pin('b', 'in', [0, 11]), pin('cin', 'in', [0, 15]), pin('s', 'out', [50, 11]), pin('cout', 'out', [50, 19])],
  parts: ([[6, 4], [13, 1], [13, 8], [20, 5], [28, 8], [35, 5], [35, 12], [42, 9], [42, 17]] as Vec[]).map((at, i) => part(`g${i + 1}`, N, at)),
  wires: [
    ...fan('a', 'pin:a', 'g1.a', 'g2.a'), ...fan('b', 'pin:b', 'g1.b', 'g3.b'), ...fan('cin', 'pin:cin', 'g5.b', 'g7.a'),
    ...fan('m1', 'g1.y', 'g2.b', 'g3.a', 'g9.a'), wire('p1', 'g2.y', 'g4.a'), wire('q1', 'g3.y', 'g4.b'),
    ...fan('x1', 'g4.y', 'g5.a', 'g6.a'), ...fan('m2', 'g5.y', 'g6.b', 'g7.b', 'g9.b'),
    wire('p2', 'g6.y', 'g8.a'), wire('q2', 'g7.y', 'g8.b'), wire('s', 'g8.y', 'pin:s'), wire('co', 'g9.y', 'pin:cout'),
  ],
});
const rca4 = chip('u_rca4', 'RCA4', {
  pins: [pin('a', 'in', [0, 0], 4), pin('b', 'in', [0, 2], 4), pin('cin', 'in', [0, 4]), pin('s', 'out', [90, 0], 4), pin('cout', 'out', [90, 2])],
  parts: [
    part('sa', { split: [1, 1, 1, 1] }, [4, 10]), part('sb', { split: [1, 1, 1, 1] }, [4, 30]), part('ms', { merge: [1, 1, 1, 1] }, [80, 10]),
    ...[0, 1, 2, 3].map((i) => part(`fa${i}`, C('u_fa'), [20 + 14 * i, 10 + 6 * i])),
  ],
  wires: [
    wire('wa', 'pin:a', 'sa.in'), wire('wb', 'pin:b', 'sb.in'), wire('wc', 'pin:cin', 'fa0.cin'), wire('wm', 'ms.out', 'pin:s'), wire('wo', 'fa3.cout', 'pin:cout'),
    ...[0, 1, 2, 3].flatMap((i) => [
      wire(`a${i}`, `sa.o${i}`, `fa${i}.a`), wire(`b${i}`, `sb.o${i}`, `fa${i}.b`), wire(`s${i}`, `fa${i}.s`, `ms.i${i}`),
      ...(i < 3 ? [wire(`c${i}`, `fa${i}.cout`, `fa${i + 1}.cin`)] : []),
    ]),
  ],
});

// ---- rung 4: latch → flip-flop → register → counter --------------------------------------------

// Cross-coupled NANDs; the wires q and q_n carry the power-on state (q = 0).
const sr = chip('u_sr', 'SR latch', {
  pins: [pin('s_n', 'in', [0, 2]), pin('r_n', 'in', [0, 12]), pin('q', 'out', [18, 3]), pin('q_n', 'out', [18, 11])],
  parts: [part('g1', N, [6, 1]), part('g2', N, [6, 9])],
  wires: [
    wire('s', 'pin:s_n', 'g1.a'), wire('r', 'pin:r_n', 'g2.b'),
    wire('q', 'g1.y', 'pin:q', [], { name: 'q', init: 0 }), wire('qf', 'g1.y', 'g2.a', [[14, 3], [14, 6], [4, 6], [4, 10]]),
    wire('qn', 'g2.y', 'pin:q_n', [], { name: 'q_n', init: 1 }), wire('qnf', 'g2.y', 'g1.b', [[15, 11], [15, 8], [3, 8], [3, 4]]),
  ],
});
const dlatch = chip('u_dlatch', 'D latch', {
  pins: [pin('d', 'in', [0, 3]), pin('e', 'in', [0, 8]), pin('q', 'out', [34, 4]), pin('q_n', 'out', [34, 6])],
  parts: [part('inv', C('u_not'), [2, 10]), part('g1', N, [10, 2]), part('g2', N, [10, 10]), part('sr', C('u_sr'), [18, 2])],
  wires: [
    ...fan('d', 'pin:d', 'g1.a', 'inv.a'), ...fan('e', 'pin:e', 'g1.b', 'g2.b'), wire('dn', 'inv.y', 'g2.a'),
    wire('s', 'g1.y', 'sr.s_n'), wire('r', 'g2.y', 'sr.r_n'), wire('q', 'sr.q', 'pin:q'), wire('qn', 'sr.q_n', 'pin:q_n'),
  ],
});
// Ticked "this chip is a flip-flop": static timing stops at it, as at the library DFF.
const dff = chip('u_dff', 'D flip-flop', {
  ff: { d: 'd', q: 'q', clk: 'clk' },
  pins: [pin('d', 'in', [0, 3]), clk([0, 10]), pin('q', 'out', [40, 3])],
  parts: [part('inv', C('u_not'), [3, 9]), part('master', C('u_dlatch'), [9, 1]), part('slave', C('u_dlatch'), [24, 1])],
  wires: [wire('d', 'pin:d', 'master.d'), ...fan('clk', 'pin:clk', 'inv.a', 'slave.e'), wire('cn', 'inv.y', 'master.e'), wire('m', 'master.q', 'slave.d'), wire('q', 'slave.q', 'pin:q')],
});
// Load enable: a multiplexer feeds q back while en = 0.
const dffe = chip('u_dffe', 'DFF with enable', {
  ff: { d: 'd', q: 'q', clk: 'clk', en: 'en' },
  pins: [pin('d', 'in', [0, 5]), pin('en', 'in', [0, 8]), clk([0, 12]), pin('q', 'out', [28, 5])],
  parts: [part('mux', L('mux2'), [5, 1]), part('ff', C('u_dff'), [14, 2])],
  wires: [
    wire('d', 'pin:d', 'mux.b'), wire('en', 'pin:en', 'mux.s'), wire('clk', 'pin:clk', 'ff.clk'), wire('nx', 'mux.y', 'ff.d'),
    ...fan('q', 'ff.q', 'pin:q', 'mux.a'),
  ],
});
const reg4 = chip('u_reg4', 'Register 4', {
  pins: [pin('d', 'in', [0, 16], 4), pin('en', 'in', [0, 36]), clk([0, 38]), pin('q', 'out', [40, 16], 4)],
  parts: [
    part('sd', { split: [1, 1, 1, 1], pitch: 8 }, [5, 4]), part('mq', { merge: [1, 1, 1, 1], pitch: 8 }, [33, 4]),
    ...[0, 1, 2, 3].map((i) => part(`ff${i}`, C('u_dffe'), [12, 2 + 8 * i])),
  ],
  wires: [
    wire('d', 'pin:d', 'sd.in'), wire('q', 'mq.out', 'pin:q'),
    ...[0, 1, 2, 3].flatMap((i) => [wire(`d${i}`, `sd.o${i}`, `ff${i}.d`), wire(`q${i}`, `ff${i}.q`, `mq.i${i}`)]),
    ...fan('en', 'pin:en', 'ff0.en', 'ff1.en', 'ff2.en', 'ff3.en'), ...fan('clk', 'pin:clk', 'ff0.clk', 'ff1.clk', 'ff2.clk', 'ff3.clk'),
  ],
});
// The incrementer's input reaches the register's output through a pointer pair named q.
const cnt4 = chip('u_cnt4', 'Counter 4', {
  pins: [pin('en', 'in', [0, 6]), clk([0, 30]), pin('q', 'out', [50, 6], 4)],
  parts: [part('reg', C('u_reg4'), [8, 2]), part('inc', L('inc4'), [20, 24], true)],
  labels: [lbl('lq', 'q', [44, 10]), lbl('lq2', 'q', [36, 26], 'right')],
  wires: [
    wire('en', 'pin:en', 'reg.en'), wire('clk', 'pin:clk', 'reg.clk'), ...fan('q', 'reg.q', 'pin:q', 'lbl:lq'), wire('ia', 'lbl:lq2', 'inc.a'),
    wire('nx', 'inc.y', 'reg.d', [[4, 26], [4, 4]]),
  ],
});

// ---- rung 5: memory cells at switch level --------------------------------------------------------

/**
 * One hand-drawn 6T cell at (x, y): weak pull-ups, strong pull-downs, access transistors, one VDD
 * for both pull-ups and one GND for both pull-downs (a rail is a terminal, never a path between
 * the two halves of the cell, so this behaves like the library cell's one rail per transistor).
 */
function cell6t(i: number, x: number, y: number): { parts: ChipDoc['parts']; wires: WireDoc[] } {
  const p = (n: string) => `c${i}${n}`;
  return {
    parts: [
      part(p('a1'), L('nmos'), [x, y + 8]),
      part(p('vdd'), L('vdd'), [x + 15, y]), part(p('p1'), L('pmos_weak'), [x + 8, y + 3]),
      part(p('n1'), L('nmos_strong'), [x + 8, y + 13]), part(p('gnd'), L('gnd'), [x + 15, y + 19]),
      part(p('p2'), L('pmos_weak'), [x + 18, y + 3]), part(p('n2'), L('nmos_strong'), [x + 18, y + 13]),
      part(p('a2'), L('nmos'), [x + 28, y + 8]),
    ],
    wires: [
      ...fan(p('wl'), `pin:wl${i}`, `${p('a1')}.g`, `${p('a2')}.g`),
      ...fan(p('v'), `${p('vdd')}.p`, `${p('p1')}.s`, `${p('p2')}.s`), ...fan(p('g'), `${p('gnd')}.p`, `${p('n1')}.s`, `${p('n2')}.s`),
      wire(p('q'), `${p('p1')}.d`, `${p('n1')}.d`, [], { name: `q${i}` }), ...fan(p('qx'), `${p('n1')}.d`, `${p('a1')}.s`, `${p('p2')}.g`, `${p('n2')}.g`),
      wire(p('qb'), `${p('p2')}.d`, `${p('n2')}.d`, [], { name: `qb${i}` }), ...fan(p('qbx'), `${p('n2')}.d`, `${p('a2')}.s`, `${p('p1')}.g`, `${p('n1')}.g`),
      // The bit lines run past every cell: pointers named bl / blb.
      wire(p('bl'), `${p('a1')}.d`, `lbl:${p('lbl')}`), wire(p('blb'), `${p('a2')}.d`, `lbl:${p('lblb')}`),
    ],
  };
}
const c0 = cell6t(0, 10, 14), c1 = cell6t(1, 10, 40);
const sramcol = chip('u_sramcol', 'SRAM column', {
  pins: [
    pin('pre_n', 'in', [0, 4]), pin('wl0', 'in', [0, 22]), pin('wl1', 'in', [0, 48]), pin('w0', 'in', [0, 70]), pin('w1', 'in', [0, 74]),
    pin('bl', 'out', [60, 10]), pin('blb', 'out', [60, 14]),
  ],
  parts: [
    part('vdd0', L('vdd'), [12, 0]), part('pre0', L('pmos'), [10, 2]), part('vdd1', L('vdd'), [38, 0]), part('pre1', L('pmos'), [36, 2]),
    ...c0.parts, ...c1.parts,
    part('d0', L('nmos_strong'), [10, 66]), part('d1', L('nmos_strong'), [36, 66]), part('g0', L('gnd'), [12, 72]), part('g1', L('gnd'), [38, 72]),
  ],
  labels: [
    lbl('bl_top', 'bl', [13, 10]), lbl('blb_top', 'blb', [39, 10]), lbl('bl_bot', 'bl', [13, 62]), lbl('blb_bot', 'blb', [39, 62]),
    ...[0, 1].flatMap((i) => [lbl(`c${i}lbl`, 'bl', [13, 6 + 26 * (i + 1)]), lbl(`c${i}lblb`, 'blb', [41, 6 + 26 * (i + 1)])]),
  ],
  wires: [
    ...fan('pre', 'pin:pre_n', 'pre0.g', 'pre1.g'), wire('v0', 'vdd0.p', 'pre0.s'), wire('v1', 'vdd1.p', 'pre1.s'),
    wire('blp', 'pre0.d', 'lbl:bl_top', [], { cap: true }), wire('blbp', 'pre1.d', 'lbl:blb_top', [], { cap: true }),
    wire('blo', 'lbl:bl_top', 'pin:bl'), wire('blbo', 'lbl:blb_top', 'pin:blb'),
    wire('bld', 'lbl:bl_bot', 'd0.d'), wire('blbd', 'lbl:blb_bot', 'd1.d'),
    wire('w0', 'pin:w0', 'd0.g'), wire('w1', 'pin:w1', 'd1.g'), wire('gn0', 'g0.p', 'd0.s'), wire('gn1', 'g1.p', 'd1.s'),
    ...c0.wires, ...c1.wires,
  ],
});
// The cell packaged as a chip: its bit lines are bidirectional pins (the parent precharges and
// writes through them, the cell discharges them on a read).
const sramcell = chip('u_sram6t', '6T cell', {
  pins: [pin('wl', 'in', [0, 26]), { ...pin('bl', 'inout', [2, 0]), face: 'down' }, { ...pin('blb', 'inout', [40, 0]), face: 'down' }],
  parts: [
    part('a1', L('nmos'), [6, 9]), part('vdd', L('vdd'), [21, 0]), part('p1', L('pmos_weak'), [14, 4]), part('n1', L('nmos_strong'), [14, 14]),
    part('gnd', L('gnd'), [21, 20]), part('p2', L('pmos_weak'), [24, 4]), part('n2', L('nmos_strong'), [24, 14]), part('a2', L('nmos'), [34, 9]),
  ],
  wires: [
    ...fan('wl', 'pin:wl', 'a1.g', 'a2.g'), wire('bl', 'pin:bl', 'a1.d'), wire('blb', 'pin:blb', 'a2.d'),
    ...fan('v', 'vdd.p', 'p1.s', 'p2.s'), ...fan('g', 'gnd.p', 'n1.s', 'n2.s'),
    wire('q', 'p1.d', 'n1.d', [], { name: 'q' }), ...fan('qx', 'n1.d', 'a1.s', 'p2.g', 'n2.g'),
    wire('qb', 'p2.d', 'n2.d', [], { name: 'qb' }), ...fan('qbx', 'n2.d', 'a2.s', 'p1.g', 'n1.g'),
  ],
});
// Two of them in a column: the bit lines are pointers past both cells.
const sramcolchip = chip('u_sramcol_chips', 'SRAM column (cell chips)', {
  pins: [...sramcol.pins],
  parts: [
    part('vdd0', L('vdd'), [12, 0]), part('pre0', L('pmos'), [10, 2]), part('vdd1', L('vdd'), [38, 0]), part('pre1', L('pmos'), [36, 2]),
    part('c0', C('u_sram6t'), [20, 16]), part('c1', C('u_sram6t'), [20, 32]),
    part('d0', L('nmos_strong'), [10, 66]), part('d1', L('nmos_strong'), [36, 66]), part('g0', L('gnd'), [12, 72]), part('g1', L('gnd'), [38, 72]),
  ],
  labels: [
    lbl('bl_top', 'bl', [13, 10]), lbl('blb_top', 'blb', [39, 10]), lbl('bl_bot', 'bl', [13, 62]), lbl('blb_bot', 'blb', [39, 62]),
    ...[0, 1].flatMap((i) => [lbl(`c${i}lbl`, 'bl', [14, 18 + 16 * i], 'left'), lbl(`c${i}lblb`, 'blb', [14, 20 + 16 * i], 'left')]),
  ],
  wires: [
    ...fan('pre', 'pin:pre_n', 'pre0.g', 'pre1.g'), wire('v0', 'vdd0.p', 'pre0.s'), wire('v1', 'vdd1.p', 'pre1.s'),
    wire('blp', 'pre0.d', 'lbl:bl_top', [], { cap: true }), wire('blbp', 'pre1.d', 'lbl:blb_top', [], { cap: true }),
    wire('blo', 'lbl:bl_top', 'pin:bl'), wire('blbo', 'lbl:blb_top', 'pin:blb'),
    wire('bld', 'lbl:bl_bot', 'd0.d'), wire('blbd', 'lbl:blb_bot', 'd1.d'),
    wire('w0', 'pin:w0', 'd0.g'), wire('w1', 'pin:w1', 'd1.g'), wire('gn0', 'g0.p', 'd0.s'), wire('gn1', 'g1.p', 'd1.s'),
    ...[0, 1].flatMap((i) => [
      wire(`c${i}wl`, `pin:wl${i}`, `c${i}.wl`), wire(`c${i}bl`, `lbl:c${i}lbl`, `c${i}.bl`), wire(`c${i}blb`, `lbl:c${i}lblb`, `c${i}.blb`),
    ]),
  ],
});
const dram = chip('u_dram', 'DRAM cell', {
  pins: [pin('wl', 'in', [0, 6]), pin('bl', 'in', [6, 0]), pin('q', 'out', [20, 10])],
  parts: [part('a', L('nmos'), [3, 4])],
  wires: [wire('wl', 'pin:wl', 'a.g'), wire('bl', 'pin:bl', 'a.d'), wire('c', 'a.s', 'pin:q', [], { name: 'storage', cap: true })],
});

// ---- rung 6: a 4 × 4 memory from the user's registers --------------------------------------------

const ram4 = chip('u_ram4x4', 'RAM 4×4', {
  pins: [pin('addr', 'in', [0, 4], 2), pin('we', 'in', [0, 8]), pin('din', 'in', [0, 60], 4), clk([0, 64]), pin('dout', 'out', [90, 30], 4)],
  parts: [
    part('dec', L('dec2e'), [6, 2]), part('mux', L('mux4x4'), [60, 10]),
    ...[0, 1, 2, 3].map((i) => part(`w${i}`, C('u_reg4'), [24, 2 + 44 * i])),
  ],
  wires: [
    ...fan('a', 'pin:addr', 'dec.a', 'mux.s'), wire('we', 'pin:we', 'dec.en'), wire('o', 'mux.y', 'pin:dout'),
    ...fan('din', 'pin:din', 'w0.d', 'w1.d', 'w2.d', 'w3.d'), ...fan('clk', 'pin:clk', 'w0.clk', 'w1.clk', 'w2.clk', 'w3.clk'),
    ...[0, 1, 2, 3].flatMap((i) => [wire(`en${i}`, `dec.y${i}`, `w${i}.en`), wire(`q${i}`, `w${i}.q`, `mux.d${i}`)]),
  ],
});

// ---- rung 7: an ALU from library units ------------------------------------------------------------

// ctl as in alu(n): f3 = ctl[2:0] picks the result (0 add/sub, 4 xor, 6 or, 7 and), ctl[3] subtracts.
const alu4 = chip('u_alu4', 'ALU 4', {
  pins: [pin('a', 'in', [0, 2], 4), pin('b', 'in', [0, 6], 4), pin('ctl', 'in', [0, 60], 4), pin('y', 'out', [80, 20], 4), pin('zero', 'out', [80, 30])],
  parts: [
    part('as', L('addsub4'), [14, 0]), part('x', L('xorx4'), [14, 14]), part('o', L('orx4'), [14, 22]), part('n', L('andx4'), [14, 30]),
    part('k0', { const: { width: 4, value: 0 } }, [30, 40]), part('sc', { split: [3, 1] }, [6, 56]),
    part('mux', L('mux8x4'), [44, 4]), part('z', L('zero4'), [66, 28]),
  ],
  wires: [
    ...fan('a', 'pin:a', 'as.a', 'x.a', 'o.a', 'n.a'), ...fan('b', 'pin:b', 'as.b', 'x.b', 'o.b', 'n.b'),
    wire('ctl', 'pin:ctl', 'sc.in'), wire('f3', 'sc.o0', 'mux.s'), wire('sub', 'sc.o1', 'as.sub'),
    wire('sum', 'as.s', 'mux.d0'), ...fan('k', 'k0.y', 'mux.d1', 'mux.d2', 'mux.d3', 'mux.d5'),
    wire('xy', 'x.y', 'mux.d4'), wire('oy', 'o.y', 'mux.d6'), wire('ny', 'n.y', 'mux.d7'),
    ...fan('y', 'mux.y', 'pin:y', 'z.a'), wire('zz', 'z.z', 'pin:zero'),
  ],
});

// ---- rung 8: fetch: PC, PC + 4 and a program ROM, the PC fed back through a pointer pair -----------

const PROGRAM = `
  addi x1, x0, 3
  addi x2, x0, 4
loop:
  add  x3, x1, x2
  sw   x3, 0(x0)
  beq  x0, x0, loop
`;
const fetch = chip('u_fetch', 'Fetch', {
  pins: [clk([0, 20]), pin('instr', 'out', [80, 4], 32), pin('pc', 'out', [80, 30], 32)],
  parts: [
    part('pcr', L('reg32'), [10, 2]), part('one', { const: { width: 1, value: 1 } }, [2, 12]),
    part('inc', L('plus4'), [10, 40]), part('rom', { rom: { k: 3, w: 32, addr: 'rv32', lang: 'asm', src: PROGRAM } }, [50, 2]),
  ],
  labels: [lbl('p1', 'pc', [40, 34]), lbl('p2', 'pc', [4, 44], 'left')],
  wires: [
    wire('clk', 'pin:clk', 'pcr.clk'), wire('en', 'one.y', 'pcr.en'),
    ...fan('q', 'pcr.q', 'rom.addr', 'pin:pc', 'lbl:p1'),
    wire('ia', 'lbl:p2', 'inc.a'), wire('nx', 'inc.y', 'pcr.d', [[46, 44], [46, 60], [6, 60], [6, 4]]),
    wire('i', 'rom.data', 'pin:instr'),
  ],
});

const ALL = [inverter, nand, nor, not, and, or, xor, fa, rca4, sr, dlatch, dff, dffe, reg4, cnt4, sramcol, sramcell, sramcolchip, dram, ram4, alu4, fetch];
const lib = new UserLibrary(workspace(...ALL));
const compiled = (id: string): Compiled => lib.compiled(id)!;
const def = (id: string): ComponentDef => lib.defOf(id)!;

describe('every chip of the ladder compiles cleanly', () => {
  it.each(ALL.map((c) => [c.id]))('%s', (id) => {
    expect(compiled(id).diags).toEqual([]);
    expect(checkSimulatable(compiled(id))).toEqual([]);
  });
});

/** it.each rows: user chip id, library id (for the title), library part. */
const cases = (c: [string, ComponentDef][]): [string, string, ComponentDef][] => c.map(([id, ref]) => [id, ref.id, ref]);

/** Same outputs as `ref` for every input, both simulated (library ports matched by name). */
function sameTable(mine: ComponentDef, ref: ComponentDef): void {
  const a = simulate(mine), b = simulate(ref);
  forEachInput(ref, (v) => {
    const named = Object.fromEntries(inPorts(ref).map((p, i) => [p.name, v[i]]));
    expect(evalOnce(a, inPorts(mine).map((p) => named[p.name])), `${mine.id}(${v})`).toEqual(evalOnce(b, v));
  });
}

describe('1. CMOS cells from transistors (switch level)', () => {
  it.each(cases([['u_inv', INV_CMOS], ['u_nand', NAND], ['u_nor', NOR_CMOS]]))('%s ≡ %s', (id, _, ref) => {
    const c = compiled(id);
    expect(c.mode).toBe('switch');
    expect(netlistOf(c.def)!.level).toBe('switch');
    expect(c.derived).toMatchObject({ ok: true });
    forEachInput(ref, (v) => expect(c.def.spec!(v), `${id}(${v})`).toEqual(ref.spec!(v)));
    // The transistor circuit itself, solved at switch level, against the library cell's.
    const a = new SwitchSim(flatten(c.def, { mode: 'switch' })), b = new SwitchSim(flatten(ref, { mode: 'switch' }));
    forEachInput(ref, (v) => expect(evalOnce(a, v)).toEqual(evalOnce(b, v)));
  });
});

describe('2. the user NAND is the only brick', () => {
  it.each(cases([['u_not', NOT], ['u_and', AND], ['u_or', OR], ['u_xor', XOR]]))('%s ≡ %s', (id, _, ref) => {
    const d = def(id);
    expect(compiled(id).mode).toBe('gate');
    const leaves = flatten(d).leaves;
    expect(leaves.every((l) => l.kind === 'behavior' && l.def === def('u_nand'))).toBe(true);
    sameTable(d, ref);
  });
});

describe('3. adders', () => {
  it('the 9-NAND full adder adds', () => {
    const sim = simulate(def('u_fa'));
    expect(flatten(def('u_fa')).leaves).toHaveLength(9);
    forEachInput(def('u_fa'), ([a, b, c]) => expect(evalOnce(sim, [a, b, c])).toEqual([(a + b + c) & 1, (a + b + c) >> 1]));
  });
  it('the 4-bit ripple-carry adder of user full adders: all 512 sums', () => {
    const d = def('u_rca4');
    expect(flatten(d).leaves).toHaveLength(36);
    const sim = simulate(d);
    forEachInput(d, ([a, b, c]) => expect(evalOnce(sim, [a, b, c]), `${a}+${b}+${c}`).toEqual([(a + b + c) & 15, (a + b + c) >> 4]));
  });
});

/** Lock-step: apply each step to both, then compare the named outputs. */
function lockstep(a: Sim, b: Sim, outs: string[], steps: (Record<string, number> | 'tick')[]): void {
  steps.forEach((s, k) => {
    for (const sim of [a, b]) (s === 'tick' ? tick(sim) : set(sim, s));
    expect(outs.map((p) => out(a, p)), `step ${k}: ${JSON.stringify(s)}`).toEqual(outs.map((p) => out(b, p)));
  });
}

describe('4. latches, flip-flops, registers, counters', () => {
  it('SR latch: power-on state from the wires, set / hold / reset ≡ library', () => {
    expect(def('u_sr').powerOn).toEqual(SR_LATCH.powerOn);
    const a = simulate(def('u_sr')), b = simulate(SR_LATCH);
    // Power on holding (both inputs high): the wires' init values are the stored bit.
    for (const sim of [a, b]) {
      sim.setInput('s_n', 1);
      sim.setInput('r_n', 1);
      sim.reset('zero');
    }
    expect([out(a, 'q'), out(a, 'q_n')]).toEqual([0, 1]);
    expect([out(b, 'q'), out(b, 'q_n')]).toEqual([0, 1]);
    const r = lcg(1);
    const pairs = [[0, 1], [1, 0], [1, 1]]; // (0, 0) then (1, 1) is the forbidden race
    lockstep(a, b, ['q', 'q_n'], Array.from({ length: 40 }, () => {
      const [s_n, r_n] = pairs[r(3)];
      return { s_n, r_n };
    }));
  });
  it('D latch ≡ library', () => {
    const r = lcg(2);
    lockstep(simulate(def('u_dlatch')), simulate(D_LATCH), ['q', 'q_n'], Array.from({ length: 60 }, () => ({ d: r(2), e: r(2) })));
  });
  it('master–slave D flip-flop ≡ library', () => {
    const r = lcg(3);
    const a = simulate(def('u_dff')), b = simulate(DFF);
    lockstep(a, b, ['q'], [{ clk: 0, d: 0 }, ...Array.from({ length: 40 }, (_, i) => (i % 2 ? 'tick' as const : { d: r(2) }))]);
  });
  it('4-bit register ≡ register(4)', () => {
    const r = lcg(4);
    lockstep(simulate(def('u_reg4')), simulate(register(4)), ['q'], [
      { clk: 0, en: 0, d: 0 },
      ...Array.from({ length: 60 }, (_, i) => (i % 2 ? 'tick' as const : { d: r(16), en: r(3) ? 1 : 0 })),
    ]);
  });
  it('4-bit counter (feedback through a pointer) ≡ counter(4)', () => {
    const nl = netlistOf(def('u_cnt4'))!;
    expect(nl.nets.find((n) => n.name === 'q')!.tags).toContain('inc.a');
    const a = simulate(def('u_cnt4')), b = simulate(counter(4));
    const r = lcg(5);
    lockstep(a, b, ['q'], [{ clk: 0, en: 1 }, ...Array.from({ length: 50 }, (_, i) => (i % 3 === 2 ? { en: r(4) ? 1 : 0 } : 'tick' as const))]);
    set(a, { en: 1 });
    const q0 = out(a, 'q');
    for (let i = 1; i <= 20; i++) { tick(a); expect(out(a, 'q')).toBe((q0 + i) % 16); }
  });
});

describe('4b. user flip-flops in static timing', () => {
  it('the ticked DFF / DFFE carry ff; a register and a counter built from them time like the library ones', () => {
    expect(def('u_dff').ff).toEqual(DFF.ff);
    expect(def('u_dffe').ff).toEqual({ d: 'd', q: 'q', clk: 'clk', en: 'en' });
    for (const [mine, ref] of [['u_reg4', register(4)], ['u_cnt4', counter(4)]] as const) {
      const a = analyzeTiming(flatten(def(mine)))!, b = analyzeTiming(flatten(ref))!;
      expect(a, mine).not.toBeNull();
      expect([a.period, a.logic, a.path.length, a.launch.length > 0], mine).toEqual([b.period, b.logic, b.path.length, b.launch.length > 0]);
      expect(a.byCapture.map((c) => c.period).sort(), mine).toEqual(b.byCapture.map((c) => c.period).sort());
    }
    expect(analyzeTiming(flatten(def('u_cnt4')))!.logic).toBeGreaterThan(0); // the incrementer and the enable mux
    // Exported for synthesis as a process, not as its latches.
    const v = synthVerilog(def('u_cnt4')).verilog;
    expect(v).toContain('always @(posedge clk) if (en) q <= d;'); // the user DFFE, as the library's
    expect(v).not.toMatch(/module u_dlatch/);
  });
  it('a latch ticked as a flip-flop is refused, and so are wrong pins', () => {
    const tryFf = (ff: ChipDoc['ff']) => new UserLibrary(workspace(...ALL, { ...dlatch, id: 'u_try', ff })).compiled('u_try')!;
    const latch = tryFf({ d: 'd', q: 'q', clk: 'e' });
    expect(latch.def.ff).toBeUndefined();
    expect(latch.diags.map((d) => d.msg)).toEqual(['not an edge-triggered flip-flop: q follows d while clk = 1: a latch? (q = 0)']);
    expect(tryFf({ d: 'd', q: 'q', clk: 'nope' }).diags[0].msg).toBe("not an edge-triggered flip-flop: no pin 'nope' (clk)");
    expect(tryFf({ d: 'q', q: 'q', clk: 'e' }).diags[0].msg).toBe("not an edge-triggered flip-flop: d pin 'q' must be an input");
    // A negative-edge flip-flop (the clock inverted in front of the user DFF) is refused too.
    const negedge = chip('u_neg', 'negedge', {
      ff: { d: 'd', q: 'q', clk: 'clk' },
      pins: [pin('d', 'in', [0, 2]), clk([0, 6]), pin('q', 'out', [30, 2])],
      parts: [part('i', C('u_not'), [4, 5]), part('f', C('u_dff'), [12, 1])],
      wires: [wire('d', 'pin:d', 'f.d'), wire('c', 'pin:clk', 'i.a'), wire('cn', 'i.y', 'f.clk'), wire('q', 'f.q', 'pin:q')],
    });
    const n = new UserLibrary(workspace(...ALL, negedge)).compiled('u_neg')!;
    expect(n.def.ff).toBeUndefined();
    expect(n.diags[0].msg).toMatch(/^not an edge-triggered flip-flop: q /);
  });
});

describe('5. memory cells at switch level', () => {
  it('6T SRAM column (bit lines as pointers, with charge): ≡ the library column, step by step', () => {
    const c = compiled('u_sramcol');
    expect(c.mode).toBe('switch');
    const a = new SwitchSim(flatten(c.def, { mode: 'switch' })), b = new SwitchSim(flatten(SRAM_COLUMN, { mode: 'switch' }));
    const nl = netlistOf(c.def)!;
    expect(nl.nets.filter((n) => n.cap).map((n) => n.name).sort()).toEqual(['bl', 'blb']);
    const mine = (net: string) => a.get(a.design.root.nets![nl.nets.findIndex((n) => n.name === net)][0]);
    const theirs = (cell: string, net: string) => {
      const n = findNode(b.design.root, [cell])!;
      return b.get(n.nets![netlistOf(n.def)!.nets.findIndex((x) => x.name === net)][0]);
    };
    const steps: Record<string, number>[] = [
      { pre_n: 1, w0: 0, w1: 0, wl0: 0, wl1: 0 }, { w1: 1, wl0: 1 }, { wl0: 0, w1: 0 }, { w0: 1, wl1: 1 }, { wl1: 0, w0: 0 },
      { pre_n: 0 }, { pre_n: 1 }, { wl0: 1 }, { wl0: 0, pre_n: 0 }, { pre_n: 1, wl1: 1 }, { wl1: 1, w1: 1 },
      { wl1: 0, w1: 0 }, { pre_n: 0 }, { pre_n: 1, wl1: 1 },
    ];
    steps.forEach((s, k) => {
      set(a, s);
      set(b, s);
      const at = `step ${k}: ${JSON.stringify(s)}`;
      expect([out(a, 'bl'), out(a, 'blb')], at).toEqual([out(b, 'bl'), out(b, 'blb')]);
      expect([mine('q0'), mine('qb0'), mine('q1'), mine('qb1')], at).toEqual([theirs('c0', 'q'), theirs('c0', 'q̄'), theirs('c1', 'q'), theirs('c1', 'q̄')]);
      expect(a.shorted.some((x) => x), at).toBe(false);
    });
    expect([mine('q0'), mine('q1')]).toEqual([B1, B1]); // cell 0 written 1, cell 1 overwritten with 1
    expect([out(a, 'bl'), out(a, 'blb')]).toEqual([B1, B0]); // reading a stored 1 discharges bl̄
  });
  it('the cell packaged as a chip: bidirectional bit-line pins, ≡ the library cell driven from outside', () => {
    const c = compiled('u_sram6t');
    expect(c.mode).toBe('switch');
    expect(c.def.ports).toEqual(SRAM_CELL.ports);
    expect(c.derived).toMatchObject({ ok: false });
    const a = new SwitchSim(flatten(c.def, { mode: 'switch' })), b = new SwitchSim(flatten(SRAM_CELL, { mode: 'switch' }));
    const Z = -BZ;
    const steps: [number, number, number][] = [[0, Z, Z], [1, 1, 0], [0, Z, Z], [1, Z, Z], [1, 0, 1], [0, 1, 1], [1, Z, Z]];
    for (const [k, [wl, bl, blb]] of steps.entries()) {
      for (const s of [a, b]) { s.setInput('wl', wl); s.setInput('bl', bl); s.setInput('blb', blb); s.settle(); }
      expect([out(a, 'bl'), out(a, 'blb')], `step ${k}`).toEqual([out(b, 'bl'), out(b, 'blb')]);
    }
    expect([a.getBits(a.design.root.ports.bl)[0], a.getBits(a.design.root.ports.blb)[0]]).toEqual([B0, B1]); // reads the 0 written at step 4
  });
  it('a column of two packaged cells (bit lines through their inout pins) ≡ the library column', () => {
    const c = compiled('u_sramcol_chips');
    expect(c.mode).toBe('switch');
    const a = new SwitchSim(flatten(c.def, { mode: 'switch' })), b = new SwitchSim(flatten(SRAM_COLUMN, { mode: 'switch' }));
    const q = (s: SwitchSim, cell: string, net: string) => {
      const n = findNode(s.design.root, [cell])!;
      return s.get(n.nets![netlistOf(n.def)!.nets.findIndex((x) => x.name === net)][0]);
    };
    const steps: Record<string, number>[] = [
      { pre_n: 1, w0: 0, w1: 0, wl0: 0, wl1: 0 }, { w1: 1, wl0: 1 }, { wl0: 0, w1: 0 }, { w0: 1, wl1: 1 }, { wl1: 0, w0: 0 },
      { pre_n: 0 }, { pre_n: 1 }, { wl0: 1 }, { wl0: 0, pre_n: 0 }, { pre_n: 1, wl1: 1 }, { wl1: 1, w1: 1 },
      { wl1: 0, w1: 0 }, { pre_n: 0 }, { pre_n: 1, wl1: 1 }, { wl1: 0, pre_n: 0 }, { pre_n: 1, wl0: 1 }, { wl0: 1, w0: 1 },
    ];
    steps.forEach((st, k) => {
      set(a, st);
      set(b, st);
      const at = `step ${k}: ${JSON.stringify(st)}`;
      expect([out(a, 'bl'), out(a, 'blb')], at).toEqual([out(b, 'bl'), out(b, 'blb')]);
      expect([q(a, 'c0', 'q'), q(a, 'c0', 'qb'), q(a, 'c1', 'q'), q(a, 'c1', 'qb')], at)
        .toEqual([q(b, 'c0', 'q'), q(b, 'c0', 'q̄'), q(b, 'c1', 'q'), q(b, 'c1', 'q̄')]);
      expect(a.shorted.some((x) => x), at).toBe(false);
    });
    expect([q(a, 'c0', 'q'), q(a, 'c1', 'q')]).toEqual([B0, B1]);
  });
  it('1T1C DRAM cell (a capacitive storage net) ≡ library', () => {
    const c = compiled('u_dram');
    expect(c.mode).toBe('switch');
    expect(c.derived).toMatchObject({ ok: false });
    const a = new SwitchSim(flatten(c.def, { mode: 'switch' })), b = new SwitchSim(flatten(DRAM_CELL, { mode: 'switch' }));
    const steps: Record<string, number>[] = [{ wl: 0, bl: 0 }, { wl: 1, bl: 1 }, { wl: 0 }, { bl: 0 }, { wl: 1 }, { wl: 0, bl: 1 }, { bl: 0 }, { wl: 1, bl: 1 }];
    steps.forEach((s, k) => {
      set(a, s);
      set(b, s);
      expect(out(a, 'q'), `step ${k}`).toBe(out(b, 'q'));
    });
    expect(out(a, 'q')).toBe(1);
  });
});

describe('6. memory', () => {
  it('4 × 4 RAM from the user registers ≡ ram(2, 4): random writes and reads', () => {
    const r = lcg(6);
    lockstep(simulate(def('u_ram4x4')), simulate(ram(2, 4)), ['dout'], [
      { clk: 0, we: 0, addr: 0, din: 0 },
      ...Array.from({ length: 80 }, (_, i) => (i % 2 ? 'tick' as const : { addr: r(4), din: r(16), we: r(2) })),
    ]);
  });
});

describe('7. ALU', () => {
  it('a 4-bit ALU from library units ≡ alu(4) for add, sub, xor, or, and (all operands)', () => {
    const sim = simulate(def('u_alu4'));
    const spec = aluSpec(4);
    for (const ctl of [0, 8, 4, 6, 7, 12, 14, 15]) {
      for (let a = 0; a < 16; a++) for (let b = 0; b < 16; b++) {
        expect(evalOnce(sim, [a, b, ctl]), `ctl ${ctl}: ${a}, ${b}`).toEqual(spec([a, b, ctl]).slice(0, 2));
      }
    }
  });
});

describe('8. fetch datapath with a pointer', () => {
  it('stepping the clock fetches the assembled words in order', () => {
    const d = def('u_fetch');
    const pcNet = netlistOf(d)!.nets.find((n) => n.name === 'pc')!;
    expect(pcNet.tags).toEqual(expect.arrayContaining(['pcr.q', 'inc.a']));
    const words = buildProgram('asm', PROGRAM).words;
    expect(words).toHaveLength(5);
    const sim = simulate(d);
    set(sim, { clk: 0 });
    for (let i = 0; i < 12; i++) {
      expect(out(sim, 'pc'), `cycle ${i}`).toBe(4 * i);
      expect(out(sim, 'instr'), `cycle ${i}`).toBe(i % 8 < words.length ? words[i % 8] >>> 0 : 0x13);
      tick(sim);
    }
  });
});
