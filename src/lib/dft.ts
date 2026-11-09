// Design for test (docs/PLAN-VERIFY.md): the scan flip-flop and the circuits around it, a deliberately redundant circuit
// (the one fault a test cannot find), and what full scan costs a design. The fault simulator is sim/faultsim.ts, the test
// generator sim/atpg.ts, the self-test hardware lib/bist.ts.

import { symbolGeom } from '../sim/geometry';
import { netlistOf, type ComponentDef, type InstanceDef, type NetDef, type PortDef } from '../sim/types';
import { incrementer } from './combinational';
import { define, merger, ones, splitter } from './define';
import { MUX2, NOT } from './gates';
import { NAND3 } from './seqparts';
import { DFF } from './sequential';
import { NAND } from './transistors';

const bit = (name: string, dir: 'in' | 'out', side?: PortDef['side'], clock?: boolean): PortDef => ({ name, width: 1, dir, side, clock });

const cache = new Map<string, ComponentDef>();
function memo(key: string, f: () => ComponentDef): ComponentDef {
  let d = cache.get(key);
  if (!d) cache.set(key, (d = f()));
  return d;
}

/**
 * The scan flip-flop: a 2:1 multiplexer in front of a D flip-flop. se = 0: it is the flip-flop (q takes d at the edge);
 * se = 1: q takes si, and a row of them chained q → si is a shift register from the chip's scan-in pin to its scan-out.
 */
export const SCAN_DFF: ComponentDef = define({
  id: 'scan_dff', name: 'Scan flip-flop', category: 'sequential',
  summary: 'A D flip-flop with a multiplexer in front: with se = 1 it takes si instead of d, so a row of them chained q → si shifts a test state in and the result out. Four NANDs more than the flip-flop.',
  ports: [bit('d', 'in'), bit('si', 'in'), bit('se', 'in'), bit('clk', 'in', 'left', true), bit('q', 'out')],
  symbol: { kind: 'box', label: 'SDFF' },
  ff: { d: 'd', q: 'q', clk: 'clk' },
  netlist: () => ({
    pins: { d: [1, 4], si: [1, 6], se: [1, 10], clk: [1, 12], q: [26, 6] },
    instances: [
      { name: 'mux', def: MUX2, at: [6, 2], label: 'scan?' },
      { name: 'ff', def: DFF, at: [14, 3] },
    ],
    nets: [
      { name: 'd', ends: ['d', 'mux.a'] },
      { name: 'si', ends: ['si', 'mux.b'] },
      { name: 'se', ends: ['se', 'mux.s'] },
      { name: 'next', ends: ['mux.y', 'ff.d'] },
      { name: 'clk', ends: ['clk', 'ff.clk'], via: { 'ff.clk': [[12, 12], [12, 7]] } },
      { name: 'q', ends: ['ff.q', 'q'] },
    ],
  }),
  hdl: {
    verilog: `module scan_dff (input logic d, si, se, clk, output logic q);
  always_ff @(posedge clk) q <= se ? si : d;
endmodule`,
  },
});

/** n scan flip-flops sharing clk and se, the chain si → ff0 → … → ff(n−1) → so; d and q as a register's. */
export function scanRegister(n: number): ComponentDef {
  return memo(`scanreg${n}`, () => {
    const P = 14, X = 12, Y0 = 2, g = symbolGeom(SCAN_DFF);
    const instances: InstanceDef[] = [
      { name: 'sd', def: splitter(ones(n), P), at: [5, Y0 + g.ports.d.pos[1] - P / 2] },
      { name: 'mq', def: merger(ones(n), P), at: [X + g.w + 6, Y0 + g.ports.q.pos[1] - P / 2] },
    ];
    const nets: NetDef[] = [{ name: 'd', ends: ['d', 'sd.in'] }, { name: 'q', ends: ['mq.out', 'q'] }];
    const se = ['se'], clk = ['clk'];
    for (let i = 0; i < n; i++) {
      instances.push({ name: `ff${i}`, def: SCAN_DFF, at: [X, Y0 + P * i] });
      nets.push({ name: `d${i}`, ends: [`sd.o${i}`, `ff${i}.d`] });
      const q = [`ff${i}.q`, `mq.i${i}`, i < n - 1 ? `ff${i + 1}.si` : 'so'];
      // the chain: each q runs on to the next flip-flop's si (a wire down and back along the row's gap)
      nets.push(i < n - 1
        ? { name: `q${i}`, ends: q, via: { [`ff${i + 1}.si`]: [[X + g.w + 2, Y0 + P * i + g.ports.q.pos[1]], [X + g.w + 2, Y0 + P * i + g.h + 2], [X - 3, Y0 + P * i + g.h + 2], [X - 3, Y0 + P * (i + 1) + g.ports.si.pos[1]]] } }
        : { name: `q${i}`, ends: q, tags: ['so'] });
      se.push(`ff${i}.se`);
      clk.push(`ff${i}.clk`);
    }
    nets.push({ name: 'si', ends: ['si', 'ff0.si'] });
    nets.push({ name: 'se', ends: se, trunk: 9 });
    nets.push({ name: 'clk', ends: clk, trunk: 10 });
    const bottom = Y0 + P * n, mid = (P * n) / 2;
    return define({
      id: `scanreg${n}`, name: `${n}-bit scan register`, category: 'sequential',
      summary: `${n} scan flip-flops: a register while se = 0, a shift register from si to so while se = 1 (${n} clocks shift a whole state in, and the old one out).`,
      ports: [{ name: 'd', width: n, dir: 'in' }, bit('si', 'in'), bit('se', 'in'), bit('clk', 'in', 'bottom', true), { name: 'q', width: n, dir: 'out' }, bit('so', 'out')],
      symbol: { kind: 'box', label: `SREG${n}` },
      netlist: () => ({
        pins: {
          d: [1, Y0 + g.ports.d.pos[1] - P / 2 + mid], si: [1, Y0 - 1], se: [1, bottom + 1], clk: [1, bottom + 3],
          q: [X + g.w + 12, Y0 + g.ports.q.pos[1] - P / 2 + mid], so: [X + g.w + 12, bottom + 1],
        },
        instances, nets,
      }),
    });
  });
}

/** Software model of scanCounter(n) at one rising edge: count (se = 0) or shift (se = 1). */
export function scanCounterNext(q: number, n: number, se: number, si: number): number {
  const m = 2 ** n - 1;
  return se ? ((q << 1) | si) & m : (q + 1) & m;
}

/** An n-bit counter whose flip-flops are scan flip-flops: counts while se = 0, shifts si in (into bit 0) while se = 1. */
export function scanCounter(n: number): ComponentDef {
  return memo(`scancnt${n}`, () => {
    const R = scanRegister(n), I = incrementer(n), rg = symbolGeom(R), ig = symbolGeom(I);
    const rAt: [number, number] = [10, 2], iAt: [number, number] = [10 + Math.round((rg.w - ig.w) / 2), 2 + rg.h + 5];
    const qy = rAt[1] + rg.ports.q.pos[1], iy = iAt[1] + ig.ports.a.pos[1], yy = iAt[1] + ig.ports.y.pos[1];
    const R0 = rAt[0] + rg.w;
    return define({
      id: `scancnt${n}`, name: `${n}-bit scan counter`, category: 'sequential',
      summary: 'The counter with its register made of scan flip-flops: it counts while se = 0; with se = 1 its state shifts in from si and out at so, so a tester sets and reads it in n clocks.',
      ports: [bit('si', 'in'), bit('se', 'in'), bit('clk', 'in', 'bottom', true), { name: 'q', width: n, dir: 'out' }, bit('so', 'out')],
      symbol: { kind: 'box', label: `SCNT${n}` },
      netlist: () => ({
        pins: {
          si: [1, rAt[1] + rg.ports.si.pos[1]], se: [1, rAt[1] + rg.ports.se.pos[1]], clk: [1, iAt[1] + ig.h + 3],
          q: [R0 + 12, qy], so: [R0 + 12, rAt[1] + rg.ports.so.pos[1]],
        },
        instances: [
          { name: 'reg', def: R, at: rAt },
          { name: 'inc', def: I, at: iAt, flip: true },
        ],
        nets: [
          { name: 'q', ends: ['reg.q', 'q', 'inc.a'], via: { 'inc.a': [[R0 + 4, iy]] } },
          { name: 'next', ends: ['inc.y', 'reg.d'], via: { 'reg.d': [[5, yy], [5, rAt[1] + rg.ports.d.pos[1]]] } },
          { name: 'si', ends: ['si', 'reg.si'] },
          { name: 'se', ends: ['se', 'reg.se'] },
          { name: 'so', ends: ['reg.so', 'so'] },
          { name: 'clk', ends: ['clk', 'reg.clk'], via: { 'reg.clk': [[R0 + 7, iAt[1] + ig.h + 3], [R0 + 7, rAt[1] + rg.h + 2], [rAt[0] + rg.ports.clk.pos[0], rAt[1] + rg.h + 2]] } },
        ],
      }),
    });
  });
}

/**
 * y = a·b + ¬a·c + b·c, all three terms built: the consensus term b·c never decides y (where b = c = 1, a·b or ¬a·c is 1
 * already), so its NAND stuck at 1 changes nothing a test could see. A redundant circuit: the fault no vector detects.
 */
export const CONSENSUS: ComponentDef = define({
  id: 'consensus', name: 'Consensus (redundant term)', category: 'gate',
  summary: 'a·b + ¬a·c with the redundant consensus term b·c also built: the same function as a 2:1 multiplexer, and one gate whose stuck-at-1 fault no test can find.',
  ports: [bit('a', 'in'), bit('b', 'in'), bit('c', 'in'), bit('y', 'out')],
  symbol: { kind: 'box', label: 'CONS' },
  spec: ([a, b, c]) => [(a & b) | (~a & 1 & c)],
  netlist: () => ({
    pins: { a: [1, 3], b: [1, 9], c: [1, 15], y: [32, 9] },
    instances: [
      { name: 'na', def: NOT, at: [6, 12] },
      { name: 'ab', def: NAND, at: [12, 2] },
      { name: 'nac', def: NAND, at: [12, 12] },
      { name: 'bc', def: NAND, at: [12, 17] },
      { name: 'y', def: NAND3, at: [20, 5] },
    ],
    nets: [
      { name: 'a', ends: ['a', 'ab.a', 'na.a'], via: { 'na.a': [[4, 3], [4, 13]] } },
      { name: 'b', ends: ['b', 'ab.b', 'bc.a'], via: { 'ab.b': [[9, 9], [9, 5]], 'bc.a': [[9, 9], [9, 18]] } },
      { name: 'c', ends: ['c', 'nac.b', 'bc.b'], via: { 'nac.b': [[10, 15]], 'bc.b': [[10, 15], [10, 20]] } },
      { name: 'na', ends: ['na.y', 'nac.a'] },
      { name: 't_ab', ends: ['ab.y', 'y.a'], via: { 'y.a': [[18, 4], [18, 7]] } },
      { name: 't_nac', ends: ['nac.y', 'y.b'], via: { 'y.b': [[17, 14], [17, 9]] } },
      { name: 't_bc', ends: ['bc.y', 'y.c'], via: { 'y.c': [[18, 19], [18, 11]] } },
      { name: 'y', ends: ['y.y', 'y'] },
    ],
  }),
});

export interface ScanCost {
  /** D flip-flops in the design (every one becomes a scan flip-flop). */
  flipFlops: number;
  /** NANDs full scan adds: a 2:1 multiplexer per flip-flop. */
  nands: number;
  /** Clocks to shift one state in (one chain): its length. */
  shift: number;
}

const ffCount = new WeakMap<ComponentDef, number>();
/** D flip-flops below a component, counted from the definitions (each counted once per use, never flattened). */
function flipFlopsOf(def: ComponentDef): number {
  if (def === DFF || def === SCAN_DFF) return 1;
  const had = ffCount.get(def);
  if (had !== undefined) return had;
  const nl = netlistOf(def);
  const n = nl && nl.level !== 'switch' ? nl.instances.reduce((s, i) => s + flipFlopsOf(i.def), 0) : 0;
  ffCount.set(def, n);
  return n;
}

/** What full scan costs a design: every D flip-flop given a multiplexer, all of them on one chain. */
export function scanCost(def: ComponentDef): ScanCost {
  const ff = flipFlopsOf(def), extra = netlistOf(MUX2)!.instances.length;
  return { flipFlops: ff, nands: ff * extra, shift: ff };
}

// the chapter's sizes, registered with the library (and so checked by the registry-wide tests)
scanCounter(4);
