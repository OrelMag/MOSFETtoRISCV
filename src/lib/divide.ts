// Faster division: non-restoring (add or subtract, never restore) and radix-2 SRT (a redundant
// quotient digit chosen from a few remainder bits, the remainder kept in carry-save form so a step
// has no carry chain at all). The restoring divider of muldiv.ts is the reference.

import { symbolGeom } from '../sim/geometry';
import type { ComponentDef, InstanceDef, NetDef, PortDef } from '../sim/types';
import { mask } from '../sim/values';
import { constWord, isZero } from './alu';
import { addSub, andN, busMux2, equal, incrementer, rca } from './combinational';
import { Builder } from './builder';
import { define, merger, ones, splitter } from './define';
import { addSubFast, fanout, koggeStone } from './fastadd';
import { lzc, shiftLeft, shiftRightSticky } from './fpu';
import { AND, NOT, OR, XOR } from './gates';
import { csa } from './muldiv';
import { DFF, register } from './sequential';
import { NAND, TIE0, TIE1 } from './transistors';
import { bitwise, orN } from './wide';

const bit = (name: string, dir: 'in' | 'out', side?: PortDef['side'], clock?: boolean): PortDef => ({ name, width: 1, dir, side, clock });
const bus = (name: string, width: number, dir: 'in' | 'out', side?: PortDef['side']): PortDef => ({ name, width, dir, side });

const cache = new Map<string, ComponentDef>();
function memo(key: string, f: () => ComponentDef): ComponentDef {
  let d = cache.get(key);
  if (!d) cache.set(key, (d = f()));
  return d;
}
const log2 = (n: number) => Math.round(Math.log2(n));
const divRef = (a: number, b: number, n: number) => (b === 0 ? [mask(n), a] : [Math.floor(a / b), a % b]);

// ---- non-restoring division ---------------------------------------------------------------------

/**
 * One non-restoring step. The partial remainder r is signed (n + 1 bits). Shift in the next dividend
 * bit, then subtract d if r ≥ 0, add it if r < 0. The quotient bit is 1 when the new remainder is ≥ 0.
 * A negative remainder is never put back: the next step's addition does that work.
 */
export function nrDivStep(n: number, fast = n >= 16): ComponentDef {
  const id = `nrstep${n}${fast ? 'f' : ''}`;
  return memo(id, () => {
    const W = n + 1, SUB = fast ? addSubFast(W) : addSub(W), sg = symbolGeom(SUB);
    const xs = 26, xr = xs + sg.w + 10;
    return define({
      id, name: `${n}-bit non-restoring division step`, category: 'arithmetic',
      summary: 'r2 = (r << 1) | next dividend bit. If r ≥ 0 subtract d, otherwise add it. Quotient bit = 1 when the result is ≥ 0. One adder / subtractor and nothing else: no restore multiplexer.',
      ports: [bus('r', W, 'in'), bit('qin', 'in'), bus('d', n, 'in'), bus('rout', W, 'out'), bit('q', 'out')],
      symbol: { kind: 'box', label: 'NR STEP' },
      spec: ([r, qin, d]) => {
        const r2 = (r % 2 ** n) * 2 + qin;
        const res = (r >= 2 ** n ? r2 + d : r2 - d + 2 ** W) % 2 ** W;
        return [res, res < 2 ** n ? 1 : 0];
      },
      netlist: () => ({
        pins: { r: [0, 5], qin: [0, 12], d: [0, 2 + sg.ports.b.pos[1] + 6], rout: [xr + 6, 2 + sg.ports.s.pos[1]], q: [xr + 6, 2 + sg.h + 6] },
        instances: [
          { name: 'sr', def: splitter([n, 1], 4), at: [4, 1] },
          { name: 'r2', def: merger([1, n]), at: [14, 2 + sg.ports.a.pos[1] - 2] },
          { name: 'dz', def: merger([n, 1]), at: [14, 2 + sg.ports.b.pos[1] + 2] },
          { name: 'z', def: TIE0, at: [9, 2 + sg.ports.b.pos[1] + 6] },
          { name: 'pos', def: NOT, at: [17, 2 + sg.h + 5] },
          { name: 'add', def: SUB, at: [xs, 2], label: 'r2 ∓ d' },
          { name: 'nq', def: NOT, at: [xr - 3, 2 + sg.h + 5] },
        ],
        nets: [
          { name: 'r', ends: ['r', 'sr.in'] },
          { name: 'rlow', ends: ['sr.o0', 'r2.i1'] },
          { name: 'sign', ends: ['sr.o1', 'pos.a'], tags: true },
          { name: 'qin', ends: ['qin', 'r2.i0'] },
          { name: 'r2', ends: ['r2.out', 'add.a'] },
          { name: 'd', ends: ['d', 'dz.i0'] },
          { ends: ['z.y', 'dz.i1'] },
          { name: 'd′', ends: ['dz.out', 'add.b'] },
          { name: 'subtract', ends: ['pos.y', 'add.sub'], tags: true },
          { name: 'rout', ends: ['add.s', 'rout'] },
          { name: 'neg', ends: ['add.n', 'nq.a'], tags: true },
          { name: 'q', ends: ['nq.y', 'q'] },
        ],
      }),
      hdl: {
        verilog: `wire [N:0] r2 = {r[N-1:0], qin};
assign rout = r[N] ? r2 + {1'b0, d}      // negative: add d back as part of this step
                   : r2 - {1'b0, d};
assign q    = ~rout[N];`,
      },
    });
  });
}

/** If the final non-restoring remainder is negative, add d once: r = r + (d AND sign). */
export function nrFix(n: number): ComponentDef {
  return memo(`nrfix${n}`, () => {
    const A = bitwise('and', n), ag = symbolGeom(A), ADD = n >= 16 ? koggeStone(n) : rca(n), dg = symbolGeom(ADD);
    const xa = 22, xd = xa + ag.w + 10;
    return define({
      id: `nrfix${n}`, name: `${n}-bit remainder correction`, category: 'arithmetic',
      summary: 'The last non-restoring step can leave a negative remainder (−d ≤ r < 0). One addition of d fixes it; the quotient bits are already right.',
      ports: [bus('r', n + 1, 'in'), bus('d', n, 'in'), bus('rem', n, 'out')],
      symbol: { kind: 'box', label: 'FIX' },
      spec: ([r, d]) => [r >= 2 ** n ? (r + d) % 2 ** n : r],
      netlist: () => ({
        pins: { r: [0, 3], d: [0, 2 + ag.ports.a.pos[1] + 8], rem: [xd + dg.w + 6, 2 + 8 + dg.ports.s.pos[1]] },
        instances: [
          { name: 'sr', def: splitter([n, 1], 4), at: [4, 1] },
          { name: 'f', def: fanout(n), at: [12, 2 + 8 + ag.ports.b.pos[1] - 1] },
          { name: 'm', def: A, at: [xa, 10], label: 'd if r < 0' },
          { name: 'z', def: TIE0, at: [xd - 4, 4] },
          { name: 'add', def: ADD, at: [xd, 10] },
        ],
        nets: [
          { name: 'r', ends: ['r', 'sr.in'] },
          { name: 'rlow', ends: ['sr.o0', 'add.a'], tags: true },
          { name: 'sign', ends: ['sr.o1', 'f.in'] },
          { name: 'd', ends: ['d', 'm.a'] },
          { ends: ['f.out', 'm.b'] },
          { name: 'dsel', ends: ['m.y', 'add.b'] },
          { ends: ['z.y', 'add.cin'] },
          { name: 'rem', ends: ['add.s', 'rem'] },
        ],
      }),
      hdl: { verilog: 'assign rem = r[N] ? r[N-1:0] + d : r[N-1:0];' },
    });
  });
}

/** Combinational non-restoring divider: n steps in a row, then one correction of the remainder. */
export function nrArrayDiv(n: number): ComponentDef {
  return memo(`nrdiv${n}`, () => {
    const ST = nrDivStep(n, false), FX = nrFix(n);
    const g = symbolGeom(ST), fg = symbolGeom(FX);
    const rowH = g.h + 6, dx = g.w + 6;
    const instances: InstanceDef[] = [
      { name: 'sa', def: splitter(ones(n), 2), at: [2, 2] },
      { name: 'z', def: constWord(n + 1, 0), at: [4, 2 * n + 4] },
    ];
    const nets: NetDef[] = [{ name: 'a', ends: ['a', 'sa.in'] }];
    const dEnds = ['b'];
    let prev = 'z.y';
    const qBits: string[] = [];
    for (let i = 0; i < n; i++) {
      instances.push({ name: `st${i}`, def: ST, at: [14 + dx * i, 2 + rowH * i], label: `bit ${n - 1 - i}` });
      nets.push({ name: i === 0 ? 'zero' : `r${i - 1}`, ends: [prev, `st${i}.r`] });
      nets.push({ name: `a${n - 1 - i}`, ends: [`sa.o${n - 1 - i}`, `st${i}.qin`] });
      dEnds.push(`st${i}.d`);
      qBits[n - 1 - i] = `st${i}.q`;
      prev = `st${i}.rout`;
    }
    const xf = 14 + dx * n, yf = 2 + rowH * n;
    instances.push({ name: 'fix', def: FX, at: [xf, yf] });
    dEnds.push('fix.d');
    nets.push({ name: `r${n - 1}`, ends: [prev, 'fix.r'] });
    nets.push({ name: 'd', ends: dEnds, tags: dEnds.slice(1) });
    const right = xf + fg.w + 8;
    instances.push({ name: 'mq', def: merger(ones(n)), at: [right, 2] });
    qBits.forEach((d, i) => nets.push({ name: `q${i}`, ends: [d, `mq.i${i}`], tags: true }));
    nets.push({ name: 'q', ends: ['mq.out', 'q'] }, { name: 'r', ends: ['fix.rem', 'r'] });
    return define({
      id: `nrdiv${n}`, name: `${n}-bit non-restoring array divider`, category: 'arithmetic',
      summary: `${n} non-restoring steps (add or subtract, never restore) and one final correction of the remainder. Same quotient as restoring division, one adder per row and no multiplexers.`,
      ports: [bus('a', n, 'in'), bus('b', n, 'in'), bus('q', n, 'out'), bus('r', n, 'out')],
      symbol: { kind: 'box', label: `NRDIV${n}` },
      spec: ([a, b]) => divRef(a, b, n),
      netlist: () => ({ pins: { a: [0, n + 2], b: [0, 2 * n + 10], q: [right + 6, n + 2], r: [right + 6, yf + fg.ports.rem.pos[1]] }, instances, nets }),
      hdl: {
        verilog: `always_comb begin
  r = '0;                                  // N+1 bits, signed
  for (int i = N-1; i >= 0; i--) begin
    r = r[N] ? {r[N-1:0], a[i]} + b : {r[N-1:0], a[i]} - b;
    q[i] = ~r[N];
  end
  rem = r[N] ? r[N-1:0] + b : r[N-1:0];
end`,
      },
    });
  });
}

// ---- the iteration controller --------------------------------------------------------------------

/**
 * Control for an n-step iterative unit: start (while idle) raises load for one cycle; then busy, with
 * step = 1, for n cycles; done rises for one cycle when the count reaches n. n + 2 cycles in all.
 */
export function iterCtrl(n: number): ComponentDef {
  // A power of two is reached when the count's top bit rises; any other n needs a comparator.
  const pow2 = 2 ** log2(n) === n;
  const k = pow2 ? log2(n) : Math.ceil(Math.log2(n + 1)), cw = pow2 ? k + 1 : k;
  return memo(`iter${n}`, () => {
    const CNT = register(cw), MC = busMux2(cw), INC = incrementer(cw);
    const cg = symbolGeom(CNT), mg = symbolGeom(MC), ig = symbolGeom(INC);
    const x1 = 10, x2 = x1 + mg.w + 8, x3 = x2 + cg.w + 10, yC = 4, yG = yC + cg.h + 12;
    const instances: InstanceDef[] = [
      { name: 'zc', def: constWord(cw, 0), at: [1, yC - 2] },
      { name: 'mcnt', def: MC, at: [x1, yC], label: 'load 0' },
      { name: 'cnt', def: CNT, at: [x2, yC], label: 'step count' },
      { name: 'inc', def: INC, at: [x3, yC - 2 - ig.h] },
      ...(pow2 ? [{ name: 'sc', def: splitter([k, 1]), at: [x3, yC + 4] as [number, number] }]
        : [{ name: 'nc', def: constWord(cw, n), at: [x3, yC + 12] as [number, number] }, { name: 'sc', def: equal(cw), at: [x3 + 14, yC + 4] as [number, number], label: `= ${n}` }]),
      { name: 'nbusy', def: NOT, at: [2, yG] },
      { name: 'load', def: AND, at: [7, yG + 3] },
      { name: 'en', def: OR, at: [x1 + 8, yG + 5] },
      { name: 'dn', def: AND, at: [x3, yG + 6] },
      { name: 'ndn', def: NOT, at: [x3, yG + 13] },
      { name: 'keep', def: AND, at: [x3 + 6, yG + 11] },
      { name: 'nrun', def: OR, at: [x3 + 13, yG] },
      { name: 'run', def: DFF, at: [x3 + 24, yG - 1], label: 'busy' },
    ];
    const nets: NetDef[] = [
      { name: 'start', ends: ['start', 'load.a'] },
      { name: '¬busy', ends: ['nbusy.y', 'load.b'] },
      { name: 'load', ends: ['load.y', 'mcnt.s', 'en.a', 'nrun.a', 'load'], tags: ['mcnt.s', 'nrun.a', 'load'] },
      { name: 'busy', ends: ['run.q', 'nbusy.a', 'en.b', 'dn.a', 'keep.a', 'busy'], tags: ['nbusy.a', 'en.b', 'dn.a', 'keep.a'] },
      { name: 'step', ends: ['en.y', 'cnt.en', 'step'], tags: ['cnt.en', 'step'] },
      { name: 'zc', ends: ['zc.y', 'mcnt.b'] },
      { name: 'cntD', ends: ['mcnt.y', 'cnt.d'] },
      { name: 'count', ends: ['cnt.q', 'inc.a', pow2 ? 'sc.in' : 'sc.a'], tags: ['inc.a'] },
      ...(pow2 ? [] : [{ ends: ['nc.y', 'sc.b'] }]),
      { name: 'count+1', ends: ['inc.y', 'mcnt.a'], tags: true },
      { name: pow2 ? `count[${k}]` : `count = ${n}`, ends: [pow2 ? 'sc.o1' : 'sc.eq', 'dn.b'], tags: true },
      { name: 'done', ends: ['dn.y', 'ndn.a', 'done'], tags: true },
      { name: '¬done', ends: ['ndn.y', 'keep.b'] },
      { name: 'stay', ends: ['keep.y', 'nrun.b'] },
      { name: 'busyNext', ends: ['nrun.y', 'run.d'] },
      { name: 'clk', ends: ['clk', 'cnt.clk', 'run.clk'], tags: ['cnt.clk', 'run.clk'] },
    ];
    const right = x3 + 40;
    return define({
      id: `iter${n}`, name: `${n}-step iteration control`, category: 'sequential',
      summary: `start (while idle) gives one load cycle; then busy, stepping a ${cw}-bit counter, until the count reaches ${n}: done for one cycle, and back to idle. ${n + 2} cycles per operation.`,
      ports: [bit('clk', 'in', 'bottom', true), bit('start', 'in'), bit('load', 'out'), bit('step', 'out'), bit('done', 'out'), bit('busy', 'out')],
      symbol: { kind: 'box', label: 'CTRL' },
      netlist: () => ({
        pins: { start: [0, yG + 4], clk: [0, yG + 18], load: [right, yG + 22], step: [right, yG + 26], done: [right, yG + 8], busy: [right, yG + 1] },
        instances, nets,
      }),
      hdl: {
        verilog: `wire load = start & ~busy;
assign done = busy & ${pow2 ? `count[${k}]` : `count == ${n}`};
assign step = load | busy;
always_ff @(posedge clk) begin
  if (step) count <= load ? '0 : count + 1;
  busy <= load | (busy & ~done);
end`,
      },
    });
  });
}

/** Iterative non-restoring divider: the same protocol as seqDivider (n + 2 cycles), one add/sub per step. */
export function nrSeqDivider(n: number): ComponentDef {
  return memo(`nrsdiv${n}`, () => {
    const W = n + 1;
    const RR = register(W), REG = register(n), ST = nrDivStep(n), FX = nrFix(n), C = iterCtrl(n);
    const MR = busMux2(W), MX = busMux2(n);
    const rg = symbolGeom(REG), sg = symbolGeom(ST), mg = symbolGeom(MX), fg = symbolGeom(FX), cg = symbolGeom(C);
    const x1 = 12, x2 = x1 + mg.w + 8, x3 = x2 + rg.w + 12, x4 = x3 + sg.w + 14;
    const yR = 4, yQ = yR + rg.h + 10, yD = yQ + rg.h + 10, yC = yD + rg.h + 10;
    const instances: InstanceDef[] = [
      { name: 'mr', def: MR, at: [x1, yR], label: 'load 0' },
      { name: 'rr', def: RR, at: [x2, yR], label: 'remainder (signed)' },
      { name: 'mq', def: MX, at: [x1, yQ], label: 'load a' },
      { name: 'rq', def: REG, at: [x2, yQ], label: 'quotient / dividend' },
      { name: 'rd', def: REG, at: [x2, yD], label: 'divisor' },
      { name: 'step', def: ST, at: [x3, yR] },
      { name: 'sq', def: splitter([n - 1, 1]), at: [x3 - 4, yQ + 2] },
      { name: 'nq', def: merger([1, n - 1]), at: [x4, yQ + 2] },
      { name: 'z', def: constWord(W, 0), at: [2, yR - 2] },
      { name: 'fix', def: FX, at: [x3, yD], label: 'final correction' },
      { name: 'ctl', def: C, at: [x1, yC] },
    ];
    const nets: NetDef[] = [
      { name: 'start', ends: ['start', 'ctl.start'] },
      { name: 'clk', ends: ['clk', 'ctl.clk', 'rr.clk', 'rq.clk', 'rd.clk'], tags: ['rr.clk', 'rq.clk', 'rd.clk'] },
      { name: 'load', ends: ['ctl.load', 'mr.s', 'mq.s', 'rd.en'], tags: true },
      { name: 'step', ends: ['ctl.step', 'rr.en', 'rq.en'], tags: true },
      { name: 'zero', ends: ['z.y', 'mr.b'] },
      { name: 'R', ends: ['rr.q', 'step.r', 'fix.r'], tags: ['fix.r'] },
      { name: 'rNext', ends: ['step.rout', 'mr.a'], tags: true },
      { name: 'Rd', ends: ['mr.y', 'rr.d'] },
      { name: 'Q', ends: ['rq.q', 'sq.in', 'q'], tags: ['q'] },
      { name: 'qTop', ends: ['sq.o1', 'step.qin'], tags: true },
      { name: 'qLow', ends: ['sq.o0', 'nq.i1'] },
      { name: 'qBit', ends: ['step.q', 'nq.i0'], tags: true },
      { name: 'qNext', ends: ['nq.out', 'mq.a'], tags: true },
      { name: 'a', ends: ['a', 'mq.b'] },
      { name: 'Qd', ends: ['mq.y', 'rq.d'] },
      { name: 'b', ends: ['b', 'rd.d'] },
      { name: 'D', ends: ['rd.q', 'step.d', 'fix.d'], tags: true },
      { name: 'r', ends: ['fix.rem', 'r'] },
      { name: 'done', ends: ['ctl.done', 'done'] },
      { name: 'busy', ends: ['ctl.busy', 'busy'] },
    ];
    const right = x4 + 14;
    return define({
      id: `nrsdiv${n}`, name: `${n}-bit iterative non-restoring divider`, category: 'sequential',
      summary: `One non-restoring step reused every clock, with the remainder correction on the way out. ${n + 2} cycles per division, like the restoring version; each step is one add or subtract with no restore multiplexer.`,
      ports: [bit('clk', 'in', 'bottom', true), bit('start', 'in'), bus('a', n, 'in'), bus('b', n, 'in'), bus('q', n, 'out'), bus('r', n, 'out'), bit('done', 'out'), bit('busy', 'out')],
      symbol: { kind: 'box', label: `NRDIV${n} (iterative)` },
      netlist: () => ({
        pins: {
          start: [0, yC + cg.ports.start.pos[1]], clk: [0, yC + cg.h + 4], a: [0, yQ + 4], b: [0, yD + 4],
          q: [right, yQ + 4], r: [right, yD + fg.ports.rem.pos[1]], done: [right, yC + cg.ports.done.pos[1]], busy: [right, yC + cg.ports.busy.pos[1]],
        },
        instances, nets,
      }),
      hdl: {
        verilog: `module nr_divider #(parameter int N = ${n}) (input logic clk, start, input logic [N-1:0] a, b,
                    output logic [N-1:0] q, r, output logic done, busy);
  logic [N:0] rem;  logic [N-1:0] d;
  wire [N:0] r2 = {rem[N-1:0], q[N-1]};
  wire [N:0] nxt = rem[N] ? r2 + {1'b0, d} : r2 - {1'b0, d};
  assign r = rem[N] ? rem[N-1:0] + d : rem[N-1:0];
  // iteration control as in seq_divider
  always_ff @(posedge clk)
    if (load) begin rem <= '0; q <= a; d <= b; end
    else if (busy) begin rem <= nxt; q <= {q[N-2:0], ~nxt[N]}; end
endmodule`,
      },
    });
  });
}

// ---- radix-2 SRT ---------------------------------------------------------------------------------------

/**
 * SRT quotient-digit selection from a 4-bit estimate of the shifted remainder (the top bits of its sum
 * and carry words, added): estimate ≥ 0 → +1, estimate = −1 (−½ in units of the divisor) → 0,
 * otherwise −1. The estimate is low by less than one unit, and the redundant digit absorbs that.
 * Only two facts about the 4-bit sum are needed, and both come faster than the sum itself: its sign
 * (a 3-bit lookahead carry into the top bit) and whether it is −1 (all four bit pairs differ).
 */
export const SRT_SELECT: ComponentDef = (() => {
  const A3 = andN(3), O3 = orN(3), A4 = andN(4);
  const P = 6, X1 = 12, X2 = 20, X3 = 30, X4 = 40, X5 = 48;
  const instances: InstanceDef[] = [
    { name: 'ss', def: splitter(ones(4), P), at: [4, 0] },
    { name: 'sc', def: splitter(ones(4), P), at: [7, 2] },
  ];
  const nets: NetDef[] = [{ name: 's', ends: ['s', 'ss.in'] }, { name: 'c', ends: ['c', 'sc.in'] }];
  for (let i = 0; i < 4; i++) {
    instances.push({ name: `p${i}`, def: XOR, at: [X1, 2 + P * i] });
    const sEnds = [`ss.o${i}`, `p${i}.a`], cEnds = [`sc.o${i}`, `p${i}.b`];
    if (i < 3) {
      instances.push({ name: `g${i}`, def: AND, at: [X1, 26 + 6 * i] });
      sEnds.push(`g${i}.a`);
      cEnds.push(`g${i}.b`);
    }
    nets.push({ name: `s${i}`, ends: sEnds, tags: sEnds.slice(2) }, { name: `c${i}`, ends: cEnds, tags: cEnds.slice(2) });
  }
  instances.push(
    { name: 't1', def: AND, at: [X2, 28] },
    { name: 't2', def: A3, at: [X2, 34] },
    { name: 'cy', def: O3, at: [X3, 28], label: 'carry into bit 3' },
    { name: 'sign', def: XOR, at: [X4, 18] },
    { name: 'm1', def: A4, at: [X2, 2], label: 'all differ: −1' },
    { name: 'pos', def: NOT, at: [X5, 19] },
    { name: 'nm1', def: NOT, at: [X4, 6] },
    { name: 'neg', def: AND, at: [X5, 6] },
  );
  nets.push(
    { name: 'p0', ends: ['p0.y', 'm1.i0'] },
    { name: 'p1', ends: ['p1.y', 'm1.i1', 't2.i1'], tags: ['t2.i1'] },
    { name: 'p2', ends: ['p2.y', 'm1.i2', 't1.a', 't2.i0'], tags: ['t1.a', 't2.i0'] },
    { name: 'p3', ends: ['p3.y', 'm1.i3', 'sign.a'], tags: ['sign.a'] },
    { name: 'g0', ends: ['g0.y', 't2.i2'] },
    { name: 'g1', ends: ['g1.y', 't1.b'] },
    { name: 'g2', ends: ['g2.y', 'cy.i0'] },
    { ends: ['t1.y', 'cy.i1'] }, { ends: ['t2.y', 'cy.i2'] },
    { name: 'c3', ends: ['cy.y', 'sign.b'] },
    { name: 'e3', ends: ['sign.y', 'pos.a', 'neg.b'], tags: ['neg.b'] },
    { name: 'minus1', ends: ['m1.y', 'nm1.a'] },
    { ends: ['nm1.y', 'neg.a'] },
    { name: 'qp', ends: ['pos.y', 'qp'] },
    { name: 'qn', ends: ['neg.y', 'qn'] },
  );
  return define({
    id: 'srtsel', name: 'SRT digit selection', category: 'arithmetic',
    summary: "Looks at the top four bits of the remainder's sum and carry words. Their 4-bit sum is the estimate, but only its sign (a 3-bit lookahead carry into bit 3) and whether it is −1 (every bit pair differs) matter: +1 if ≥ 0, 0 if −1, −1 below. qp = (digit = +1), qn = (digit = −1).",
    ports: [bus('s', 4, 'in'), bus('c', 4, 'in'), bit('qp', 'out'), bit('qn', 'out')],
    symbol: { kind: 'box', label: 'SELECT' },
    spec: ([s, c]) => {
      const e = (s + c) % 16;
      return [e < 8 ? 1 : 0, e >= 8 && e !== 15 ? 1 : 0];
    },
    netlist: () => ({ pins: { s: [0, 12], c: [0, 14], qp: [X5 + 8, 20], qn: [X5 + 8, 8] }, instances, nets }),
    hdl: { verilog: "wire [3:0] e = s + c;          // only e[3] and (e == 4'b1111) are needed\nassign qp = ~e[3];\nassign qn = e[3] & ~&e;" },
  });
})();

/** −q·d for one bit, given qp, qn and both d and NOT d: two levels of NAND. */
const SRT_TERM: ComponentDef = define({
  id: 'srtterm', name: 'SRT term bit', category: 'arithmetic',
  summary: 'The bit of −q·d: NOT d when q = +1 (the +1 that completes the negation enters the carry word), d when q = −1, 0 when q = 0.',
  ports: [bit('qp', 'in'), bit('nd', 'in'), bit('qn', 'in'), bit('d', 'in'), bit('t', 'out')],
  symbol: { kind: 'box', label: '−q·d' },
  spec: ([qp, nd, qn, d]) => [(qp && nd) || (qn && d) ? 1 : 0],
  netlist: () => ({
    pins: { qp: [0, 2], nd: [0, 4], qn: [0, 8], d: [0, 10], t: [16, 6] },
    instances: [{ name: 'a', def: NAND, at: [4, 1] }, { name: 'b', def: NAND, at: [4, 7] }, { name: 'o', def: NAND, at: [10, 4] }],
    nets: [
      { ends: ['qp', 'a.a'] }, { ends: ['nd', 'a.b'] }, { ends: ['qn', 'b.a'] }, { ends: ['d', 'b.b'] },
      { ends: ['a.y', 'o.a'] }, { ends: ['b.y', 'o.b'] }, { name: 't', ends: ['o.y', 't'] },
    ],
  }),
  hdl: { verilog: 'assign t = (qp & nd) | (qn & d);' },
});

/** The −q·d word, W bits: d (n bits) zero-extended, so the upper bits are just qp. */
export function srtTerm(n: number, W: number): ComponentDef {
  return memo(`srtterms${n}_${W}`, () => {
    const b = new Builder(8, 10);
    b.pins('s', 'c', 'x', 'd');
    const one = b.op1(fanout(n), [b.op1(TIE1, [])]);
    const sd = b.op(splitter(ones(n)), ['d']);
    b.next();
    const nd = b.op(splitter(ones(n)), [b.name(b.op1(bitwise('xor', n), ['d', one], 'NOT d'), '¬d')]);
    b.next();
    const ts = Array.from({ length: n }, (_, i) => b.op1(SRT_TERM, ['qp', `${nd}.o${i}`, 'qn', `${sd}.o${i}`], `bit ${i}`));
    ts.push(b.op1(fanout(W - n), ['qp'], `bits ${n}..${W - 1}`));
    b.next();
    b.wire(b.op1(merger([...ones(n), W - n]), ts), 't');
    const R = b.right;
    return define({
      id: `srtterms${n}_${W}`, name: `SRT term (${W} bits)`, category: 'arithmetic',
      summary: 'The word −q·d: one two-level NAND multiplexer per divisor bit. NOT d comes from the divisor register, so it is ready long before the digit is.',
      ports: [bus('d', n, 'in'), bit('qp', 'in'), bit('qn', 'in'), bus('t', W, 'out')],
      symbol: { kind: 'box', label: '−q·d' },
      spec: W <= 52 ? ([d, qp, qn]) => [qp ? (2 ** W - 1 - d) : qn ? d : 0] : undefined,
      netlist: () => ({ pins: { d: [0, 4], qp: [0, 10], qn: [0, 14], t: [R, 6] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

/**
 * One radix-2 SRT step with the remainder in carry-save form (sum s and carry c, n + 3 bits each).
 * Shift both left (the next dividend bit enters s), select q ∈ {−1, 0, +1} from their top four bits,
 * and add −q·d with one row of full adders. No carry propagates, so the delay does not grow with n.
 */
export function srtStep(n: number): ComponentDef {
  const W = n + 3;
  return memo(`srtstep${n}`, () => {
    const b = new Builder(8, 10);
    b.pins('d', 'qp', 'qn');
    const ss = b.op(splitter([W - 1, 1]), ['s']);
    const cs = b.op(splitter([W - 1, 1]), ['c']);
    const z = b.op1(TIE0, []);
    b.next();
    const s2 = b.name(b.op1(merger([1, W - 1]), ['x', `${ss}.o0`], '2s + x'), '2s+x', true);
    const c2 = b.name(b.op1(merger([1, W - 1]), [z, `${cs}.o0`], '2c'), '2c', true);
    b.next();
    const st = b.op(splitter([W - 4, 4]), [s2]);
    const ct = b.op(splitter([W - 4, 4]), [c2]);
    b.next();
    const sel = b.op(SRT_SELECT, [`${st}.o1`, `${ct}.o1`], 'digit');
    const qp = b.name(`${sel}.qp`, 'qp', true), qn = b.name(`${sel}.qn`, 'qn', true);
    b.next();
    const t = b.name(b.op1(srtTerm(n, W), ['d', qp, qn], '−q·d'), '−q·d');
    b.next();
    const add = b.op(csa(W), [s2, c2, t], 'add −q·d');
    b.next();
    const csp = b.op(splitter([W - 1, 1]), [`${add}.c`]);
    b.next();
    b.wire(`${add}.s`, 'so');
    // The carry word moves up one place; its free bit 0 takes the +1 that completes −d = NOT d + 1.
    b.wire(b.op1(merger([1, W - 1]), [qp, `${csp}.o0`], 'carry'), 'co');
    b.wire(qp, 'qp');
    b.wire(qn, 'qn');
    const R = b.right;
    const MW = 2n ** BigInt(W), ONES = MW - 1n;
    return define({
      id: `srtstep${n}`, name: `${n}-bit radix-2 SRT step`, category: 'arithmetic',
      summary: `Remainder kept as two words (sum, carry) whose total is the true value. Shift, pick a digit from 4 top bits, add −q·d with ${W} independent full adders. The step's delay is the same at any width: no carry propagates.`,
      ports: [bus('s', W, 'in'), bus('c', W, 'in'), bit('x', 'in'), bus('d', n, 'in'), bus('so', W, 'out'), bus('co', W, 'out'), bit('qp', 'out'), bit('qn', 'out')],
      symbol: { kind: 'box', label: 'SRT STEP' },
      spec: 2 * W <= 52 ? ([s, c, x, d]) => {
        const S = (BigInt(s) % (MW / 2n)) * 2n + BigInt(x), C = (BigInt(c) % (MW / 2n)) * 2n;
        const e = Number((S >> BigInt(W - 4)) + (C >> BigInt(W - 4))) % 16;
        const p = e < 8, m = e >= 8 && e !== 15;
        const T = p ? (BigInt(d) ^ ONES) : m ? BigInt(d) : 0n;
        const so = S ^ C ^ T, co = ((((S & C) | (S & T) | (C & T)) << 1n) | (p ? 1n : 0n)) % MW;
        return [Number(so), Number(co), p ? 1 : 0, m ? 1 : 0];
      } : undefined,
      netlist: () => ({
        pins: { s: [0, 4], c: [0, 10], x: [0, 16], d: [0, 22], so: [R, 4], co: [R, 10], qp: [R, 16], qn: [R, 22] },
        instances: b.instances, nets: b.nets(),
      }),
      hdl: {
        verilog: `wire [W-1:0] s2 = {s[W-2:0], x}, c2 = {c[W-2:0], 1'b0};
wire [3:0]   e  = s2[W-1:W-4] + c2[W-1:W-4];          // estimate of 2w, in units of d/2
assign qp = ~e[3];                                      // ≥ 0      → +1
assign qn = e[3] & ~&e;                                 // ≤ −2     → −1   (−1 → 0)
wire [W-1:0] t  = qp ? ~{3'b0, d} : qn ? {3'b0, d} : '0;
assign so = s2 ^ c2 ^ t;
assign co = {((s2 & c2) | (s2 & t) | (c2 & t)), qp};`,
      },
    });
  });
}

/** Normalize for SRT: shift b left until its top bit is 1, and shift the dividend by the same amount. */
export function srtNorm(n: number): ComponentDef {
  const k = log2(n);
  return memo(`srtnorm${n}`, () => {
    const b = new Builder(8, 10);
    b.pins('a', 'b');
    const lz = b.op(lzc(n), ['b'], 'leading zeros');
    b.next();
    // b = 0 has no leading one: shift by 0, and the zero divisor makes every step a plain shift.
    const sh = b.name(b.op1(bitwise('and', k), [`${lz}.c`, b.op1(fanout(k), [`${lz}.v`])], 'shift'), 'shift', true);
    const ax = b.op1(merger([n, n]), ['a', b.op1(constWord(n, 0), [])], '{0, a}');
    b.next();
    const dn = b.op1(shiftLeft(n, k), ['b', sh], 'b << shift');
    const N = b.op(splitter([n, n]), [b.op1(shiftLeft(2 * n, k), [ax, sh], 'a << shift')]);
    b.next();
    b.wire(dn, 'd');
    b.wire(`${N}.o1`, 'hi');
    b.wire(`${N}.o0`, 'lo');
    b.wire(sh, 's');
    const R = b.right;
    return define({
      id: `srtnorm${n}`, name: `${n}-bit SRT normalization`, category: 'arithmetic',
      summary: 'SRT needs ½ ≤ d < 1: shift b left by its leading-zero count, and the dividend with it (a 2n-bit shift, split into the first remainder and the bits still to come). The remainder is shifted back at the end.',
      ports: [bus('a', n, 'in'), bus('b', n, 'in'), bus('d', n, 'out'), bus('hi', n, 'out'), bus('lo', n, 'out'), bus('s', k, 'out')],
      symbol: { kind: 'box', label: 'NORMALIZE' },
      spec: 2 * n <= 52 ? ([a, bb]) => {
        let s = 0;
        if (bb) while (bb * 2 ** s < 2 ** (n - 1)) s++;
        const N = a * 2 ** s;
        return [(bb * 2 ** s) % 2 ** n, Math.floor(N / 2 ** n), N % 2 ** n, s];
      } : undefined,
      netlist: () => ({ pins: { a: [0, 4], b: [0, 10], d: [R, 4], hi: [R, 8], lo: [R, 12], s: [R, 16] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

/** Finish SRT: resolve the carry-save remainder, correct a negative one, convert the signed-digit quotient, denormalize. */
export function srtFinish(n: number): ComponentDef {
  const k = log2(n), W = n + 3;
  return memo(`srtfin${n}`, () => {
    const b = new Builder(16, 10);
    for (const p of ['s', 'c', 'qp', 'qn', 'd', 'sh']) b.name(p, p);
    const ADD = (w: number) => (w >= 16 ? koggeStone(w) : rca(w));
    const w = b.op(ADD(W), ['s', 'c', b.op1(TIE0, [])], 'resolve s + c');
    b.next();
    const ws = b.op(splitter([n, 3]), [`${w}.s`]);
    const sg = b.op(splitter([2, 1]), [`${ws}.o1`]);
    const neg = b.name(`${sg}.o1`, 'negative', true);
    b.next();
    const pos = b.op1(NOT, [neg]);
    const dsel = b.op1(bitwise('and', n), ['d', b.op1(fanout(n), [neg])], 'd if < 0');
    const nqn = b.op1(bitwise('xor', n), ['qn', b.op1(fanout(n), [b.op1(TIE1, [])])], 'NOT qn');
    b.next();
    const rem = b.op(ADD(n), [`${ws}.o0`, dsel, b.op1(TIE0, [])], 'correct remainder');
    // q = qp − qn, minus one if the remainder was negative: qp + NOT qn + (remainder ≥ 0).
    const q = b.op(ADD(n), ['qp', nqn, pos], 'qp − qn');
    b.next();
    const r = b.op(shiftRightSticky(n, k), [`${rem}.s`, 'sh'], 'denormalize');
    b.next();
    b.wire(`${q}.s`, 'q');
    b.wire(`${r}.y`, 'r');
    const R = b.right;
    return define({
      id: `srtfin${n}`, name: `${n}-bit SRT finish`, category: 'arithmetic',
      summary: 'After the last step: add the sum and carry words (the only carry-propagate addition of the whole division), add d back if the remainder is negative, form the quotient as (+1 digits) − (−1 digits) with the same correction, and shift the remainder back.',
      ports: [bus('s', W, 'in'), bus('c', W, 'in'), bus('qp', n, 'in'), bus('qn', n, 'in'), bus('d', n, 'in'), bus('sh', k, 'in'), bus('q', n, 'out'), bus('r', n, 'out')],
      symbol: { kind: 'box', label: 'FINISH' },
      netlist: () => ({ pins: { s: [0, 4], c: [0, 8], qp: [0, 12], qn: [0, 16], d: [0, 20], sh: [0, 24], q: [R, 8], r: [R, 16] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

/**
 * Iterative radix-2 SRT divider: normalize, n carry-save steps (one quotient digit per clock, a step
 * delay independent of n), finish. Same ports and n + 2 cycles as seqDivider; the finish logic is
 * combinational after the registers.
 */
export function srtDivider(n: number): ComponentDef {
  const k = log2(n), W = n + 3;
  return memo(`srtdiv${n}`, () => {
    const b = new Builder(8, 10);
    b.pins('clk', 'start', 'a', 'b');
    const ctl = b.op(iterCtrl(n), ['clk', 'start'], 'control');
    const nm = b.op(srtNorm(n), ['a', 'b']);
    const load = b.name(`${ctl}.load`, 'load', true), step = b.name(`${ctl}.step`, 'step', true);
    b.next();
    // load multiplexers: first remainder and the operands, or the step's results
    const zs = b.op1(constWord(3, 0), []);
    const hiW = b.op1(merger([n, 3]), [`${nm}.hi`, zs], 'hi (W bits)');
    const mS = b.op(busMux2(W), ['', hiW, load], 'load / step');
    const mC = b.op(busMux2(W), ['', b.op1(constWord(W, 0), []), load]);
    const mX = b.op(busMux2(n), ['', `${nm}.lo`, load]);
    const mN = b.op(busMux2(n), ['', b.op1(constWord(n, 0), []), load]);
    b.next();
    const rS = b.op(register(W), [`${mS}.y`, step, 'clk'], 'remainder: sum');
    const rC = b.op(register(W), [`${mC}.y`, step, 'clk'], 'remainder: carry');
    const rX = b.op(register(n), [`${mX}.y`, step, 'clk'], 'dividend → +1 digits');
    const rN = b.op(register(n), [`${mN}.y`, step, 'clk'], '−1 digits');
    const rD = b.op(register(n), [`${nm}.d`, load, 'clk'], 'divisor');
    const rH = b.op(register(k), [`${nm}.s`, load, 'clk'], 'shift');
    // b = 0: every digit choice gives the same remainder, so the digits mean nothing; force q = all ones.
    const rZ = b.op(register(1), [b.op1(isZero(n), ['b'], 'b = 0'), load, 'clk'], 'divide by 0');
    const S = b.name(`${rS}.q`, 'S', true), C = b.name(`${rC}.q`, 'C', true), X = b.name(`${rX}.q`, 'X', true);
    const QN = b.name(`${rN}.q`, 'QN', true), D = b.name(`${rD}.q`, 'D', true);
    b.next();
    const xs = b.op(splitter([n - 1, 1]), [X]);
    const qs = b.op(splitter([n - 1, 1]), [QN]);
    b.next();
    const st = b.op(srtStep(n), [S, C, `${xs}.o1`, D], 'one digit');
    b.name(`${st}.so`, 'sNext', true);
    b.name(`${st}.co`, 'cNext', true);
    b.next();
    const xn = b.name(b.op1(merger([1, n - 1]), [`${st}.qp`, `${xs}.o0`], 'shift in +1'), 'xNext', true);
    const nn = b.name(b.op1(merger([1, n - 1]), [`${st}.qn`, `${qs}.o0`], 'shift in −1'), 'nNext', true);
    b.next();
    const fin = b.op(srtFinish(n), [S, C, X, QN, D, `${rH}.q`]);
    // close the loops: the step's results feed the load multiplexers' a inputs
    b.wire(`${st}.so`, `${mS}.a`);
    b.wire(`${st}.co`, `${mC}.a`);
    b.wire(xn, `${mX}.a`);
    b.wire(nn, `${mN}.a`);
    b.next();
    b.next();
    b.wire(b.op1(bitwise('or', n), [`${fin}.q`, b.op1(fanout(n), [`${rZ}.q`])], 'q (all ones if b = 0)'), 'q');
    b.wire(`${fin}.r`, 'r');
    b.wire(`${ctl}.done`, 'done');
    b.wire(`${ctl}.busy`, 'busy');
    const R = b.right;
    const inst = b.instances, nets = b.nets();
    return define({
      id: `srtdiv${n}`, name: `${n}-bit iterative SRT divider`, category: 'sequential',
      summary: `Radix-2 SRT: the divisor is normalized, the remainder lives in carry-save form, and each clock picks one digit from {−1, 0, +1} by looking at 4 bits. ${n + 2} cycles like the other iterative dividers, but the clock period no longer depends on the width.`,
      ports: [bit('clk', 'in', 'bottom', true), bit('start', 'in'), bus('a', n, 'in'), bus('b', n, 'in'), bus('q', n, 'out'), bus('r', n, 'out'), bit('done', 'out'), bit('busy', 'out')],
      symbol: { kind: 'box', label: `SRT DIV${n}` },
      netlist: () => ({ pins: { clk: [0, 30], start: [0, 6], a: [0, 14], b: [0, 18], q: [R, 6], r: [R, 10], done: [R, 14], busy: [R, 18] }, instances: inst, nets }),
    });
  });
}
