// Small pieces for the multi-core processor (kept free of cpu.ts imports to avoid a module cycle):
// the decoder for atomics and csrr mhartid, and the round-robin memory arbiter.

import { symbolGeom } from '../sim/geometry';
import type { ComponentDef, PortDef } from '../sim/types';
import { constWord, isZero, orN } from './alu';
import { Builder } from './builder';
import { andN, busMux2, equal } from './combinational';
import { define, merger, splitter } from './define';
import { AND, NOT, OR, XOR } from './gates';
import { DFF, DFFE } from './sequential';

const bit = (name: string, dir: 'in' | 'out'): PortDef => ({ name, width: 1, dir });
const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });

/**
 * Recognises amoswap.w / amoadd.w and csrr rd, mhartid. An atomic is handed to the integer control
 * unit disguised as lw (it reads memory and writes rd); its address is rs1 itself (no offset).
 */
export const MP_DECODE: ComponentDef = define({
  id: 'mpdec', name: 'Atomic & hart-id decoder', category: 'cpu',
  summary: 'amoswap.w / amoadd.w: opcode 0101111 (funct5 picks the operation). csrr rd, mhartid: SYSTEM, funct3 = 2, CSR 0xF14, rs1 = 0. Atomics look like lw to the integer control unit.',
  ports: [bus('op', 7, 'in'), bus('funct3', 3, 'in'), bus('funct7', 7, 'in'), bus('rs1', 5, 'in'), bus('rs2', 5, 'in'),
    bit('isAMO', 'out'), bit('amoAdd', 'out'), bit('isHart', 'out'), bus('opInt', 7, 'out')],
  symbol: { kind: 'box', label: 'AMO / HART' },
  netlist: () => ({
    pins: { op: [0, 4], funct3: [0, 10], funct7: [0, 14], rs1: [0, 18], rs2: [0, 22], isAMO: [62, 4], amoAdd: [62, 10], isHart: [62, 16], opInt: [62, 22] },
    instances: [
      { name: 'kA', def: constWord(7, 0b0101111), at: [4, 0] }, { name: 'eA', def: equal(7), at: [16, 0], label: 'AMO?' },
      { name: 'kS', def: constWord(7, 0b1110011), at: [4, 46] }, { name: 'eS', def: equal(7), at: [16, 46], label: 'SYSTEM?' },
      { name: 'k3', def: constWord(3, 2), at: [4, 92] }, { name: 'e3', def: equal(3), at: [16, 92], label: 'csrrs?' },
      { name: 'imm', def: merger([5, 7]), at: [8, 112] },
      { name: 'kC', def: constWord(12, 0xf14), at: [4, 120] }, { name: 'eC', def: equal(12), at: [16, 116], label: 'mhartid?' },
      { name: 'z1', def: isZero(5), at: [16, 196], label: 'rs1 = 0' },
      { name: 'f5', def: splitter([2, 5]), at: [8, 210] }, { name: 'z5', def: isZero(5), at: [16, 210], label: 'funct5 = 0' },
      { name: 'hart', def: andN(4), at: [46, 100] },
      { name: 'add', def: AND, at: [46, 210] },
      { name: 'kL', def: constWord(7, 0b0000011), at: [36, 30] }, { name: 'om', def: busMux2(7), at: [48, 20], label: 'as lw' },
    ],
    nets: [
      { name: 'op', ends: ['op', 'eA.a', 'eS.a', 'om.a'], tags: ['eS.a', 'om.a'] },
      { ends: ['kA.y', 'eA.b'] }, { ends: ['kS.y', 'eS.b'] }, { ends: ['k3.y', 'e3.b'] }, { ends: ['kC.y', 'eC.b'] }, { ends: ['kL.y', 'om.b'] },
      { name: 'funct3', ends: ['funct3', 'e3.a'] },
      { name: 'rs2', ends: ['rs2', 'imm.i0'] },
      { name: 'funct7', ends: ['funct7', 'imm.i1', 'f5.in'], tags: ['f5.in'] },
      { name: 'csr', ends: ['imm.out', 'eC.a'] },
      { name: 'rs1', ends: ['rs1', 'z1.a'], tags: ['z1.a'] },
      { name: 'funct5', ends: ['f5.o1', 'z5.a'] },
      { name: 'isAMO', ends: ['eA.eq', 'om.s', 'add.a', 'isAMO'], tags: true },
      { name: 'sys', ends: ['eS.eq', 'hart.i0'], tags: true }, { name: 'f3is2', ends: ['e3.eq', 'hart.i1'], tags: true },
      { name: 'isMhartid', ends: ['eC.eq', 'hart.i2'], tags: true }, { name: 'rs1zero', ends: ['z1.z', 'hart.i3'], tags: true },
      { name: 'isHart', ends: ['hart.y', 'isHart'] },
      { name: 'swap0', ends: ['z5.z', 'add.b'] },
      { name: 'amoAdd', ends: ['add.y', 'amoAdd'] },
      { name: 'opInt', ends: ['om.y', 'opInt'] },
    ],
  }),
});

/**
 * Two-way round-robin arbiter: if only one core asks for the memory port it gets it; if both ask,
 * the one holding priority wins and priority passes to the other. No core can starve.
 */
export const ARBITER2: ComponentDef = define({
  id: 'arb2', name: 'Round-robin arbiter (2 ways)', category: 'sequential',
  summary: 'g0 = r0 AND NOT (r1 AND p); g1 = r1 AND NOT (r0 AND NOT p). On every conflict the priority bit p flips, so the loser of this round wins the next.',
  ports: [bit('r0', 'in'), bit('r1', 'in'), { name: 'clk', width: 1, dir: 'in', side: 'bottom', clock: true }, bit('g0', 'out'), bit('g1', 'out'), bit('p', 'out')],
  symbol: { kind: 'box', label: 'ARBITER' },
  netlist: () => ({
    pins: { r0: [0, 4], r1: [0, 14], clk: [0, 26], g0: [54, 4], g1: [54, 14], p: [54, 24] },
    instances: [
      { name: 'np', def: NOT, at: [12, 20] },
      { name: 'b0', def: AND, at: [20, 8] }, { name: 'n0', def: NOT, at: [28, 9] }, { name: 'g0', def: AND, at: [36, 3] },
      { name: 'b1', def: AND, at: [20, 15] }, { name: 'n1', def: NOT, at: [28, 16] }, { name: 'g1', def: AND, at: [36, 13] },
      { name: 'both', def: AND, at: [20, 26] }, { name: 'x', def: XOR, at: [28, 26] }, { name: 'ff', def: DFF, at: [36, 24], label: 'priority' },
    ],
    nets: [
      { name: 'r0', ends: ['r0', 'g0.a', 'b1.a', 'both.a'], trunk: 6 },
      { name: 'r1', ends: ['r1', 'b0.a', 'g1.a', 'both.b'], trunk: 8 },
      { name: 'p', ends: ['ff.q', 'b0.b', 'np.a', 'x.b', 'p'], tags: ['b0.b', 'np.a', 'x.b'] },
      { name: '¬p', ends: ['np.y', 'b1.b'] },
      { ends: ['b0.y', 'n0.a'] }, { ends: ['n0.y', 'g0.b'] }, { ends: ['b1.y', 'n1.a'] }, { ends: ['n1.y', 'g1.b'] },
      { name: 'conflict', ends: ['both.y', 'x.a'] }, { name: 'pNext', ends: ['x.y', 'ff.d'] },
      { name: 'clk', ends: ['clk', 'ff.clk'] },
      { name: 'g0', ends: ['g0.y', 'g0'] }, { name: 'g1', ends: ['g1.y', 'g1'] },
    ],
  }),
});

const arbiters = new Map<number, ComponentDef>();

/**
 * n-way round-robin arbiter (n = 2 … 8), the policy of ARBITER2 and of the golden model
 * (riscv/multi.ts): a one-hot pointer names the requester holding priority, and the first requester
 * at or after it wins. Two fixed-priority chains (lowest index first) search: one over the requests
 * at or after the pointer (masked by its thermometer code), one over all of them, used when the
 * masked set is empty (the search wraps around). On a conflict (two or more requests) the pointer
 * moves to the one after the winner. Pointer bit 0 is stored inverted, so power-on (every flip-flop
 * 0) gives requester 0 the priority, and bit n - 1 is not stored at all: the mask never reads it
 * (at or after n - 1 means n - 1 alone, which the unmasked chain also finds), so n - 1 flip-flops.
 */
export function arbiterN(n: number): ComponentDef {
  if (!Number.isInteger(n) || n < 2 || n > 8) throw new Error('arbiterN: 2–8 ways');
  let d = arbiters.get(n);
  if (d) return d;
  const I = Array.from({ length: n }, (_, i) => i);
  const r = I.map((i) => `r${i}`);
  const b = new Builder(20); // room for the input pins' labels left of the pointer's
  b.pins(...r, 'clk');
  // the pointer register (n - 1 bits): its inputs come back from the last column
  const ff = I.slice(0, n - 1).map((i) => b.add(DFFE, `ptr ${i}`, `ff${i}`));
  ff.forEach((f) => b.wire('clk', `${f}.clk`));
  b.next();
  const p = [b.name(b.op1(NOT, [`${ff[0]}.q`], undefined, 'np0'), 'p0', true), ...I.slice(1, n - 1).map((i) => b.name(`${ff[i]}.q`, `p${i}`, true))];
  b.next();
  // thermometer mask: m_i = p_0 + … + p_i (at or after the pointer); m_(n-1) is always 1
  const m = [p[0]];
  for (let i = 1; i < n - 1; i++) m.push(b.op1(OR, [m[i - 1], p[i]], undefined, `m${i}`));
  b.next();
  const hi = I.map((i) => (i === n - 1 ? r[i] : b.op1(AND, [r[i], m[i]], undefined, `hi${i}`)));
  b.next();
  // below[i] = some request with a lower index (in the masked set / in all of them)
  const prefix = (xs: string[], tag: string) => {
    const a = ['', xs[0]];
    for (let i = 2; i < n; i++) a.push(b.op1(OR, [a[i - 1], xs[i - 1]], undefined, `${tag}${i}`));
    return a;
  };
  const bh = prefix(hi, 'bh'), br = prefix(r, 'br');
  const anyHi = b.op1(OR, [bh[n - 1], hi[n - 1]], 'any at or after', 'anyHi');
  b.next();
  const nbh = I.map((i) => (i ? b.op1(NOT, [bh[i]], undefined, `nbh${i}`) : ''));
  const nbr = I.map((i) => (i ? b.op1(NOT, [br[i]], undefined, `nbr${i}`) : ''));
  const nAny = b.op1(NOT, [anyHi], undefined, 'nAny');
  b.next();
  const gh = I.map((i) => (i ? b.op1(AND, [hi[i], nbh[i]], undefined, `gh${i}`) : hi[0]));
  const gl = I.map((i) => (i ? b.op1(AND, [r[i], nbr[i]], undefined, `gl${i}`) : r[0]));
  const two = I.slice(1).map((i) => b.op1(AND, [r[i], br[i]], undefined, `two${i}`));
  b.next();
  const wrap = I.map((i) => b.op1(AND, [gl[i], nAny], undefined, `wrap${i}`));
  const conflict = b.name(two.length === 1 ? two[0] : b.op1(orN(two.length), two, 'two or more', 'conflict'), 'conflict', true);
  b.next();
  const g = I.map((i) => b.name(b.op1(OR, [gh[i], wrap[i]], undefined, `gor${i}`), `g${i}`));
  // the next pointer: the one after the winner, loaded on a conflict
  const ng = b.name(b.op1(NOT, [g[n - 1]], undefined, 'ng'), `¬g${n - 1}`);
  ff.forEach((f, i) => { b.wire(i ? g[i - 1] : ng, `${f}.d`); b.wire(conflict, `${f}.en`); });
  g.forEach((x, i) => b.wire(x, `g${i}`));
  const yOut = symbolGeom(OR).ports.y.pos[1];
  const at = new Map(b.instances.map((x) => [x.name, x.at!]));
  const pins: Record<string, [number, number]> = { clk: [0, 2 * n + 4] };
  I.forEach((i) => { pins[`r${i}`] = [0, 2 + 2 * i]; pins[`g${i}`] = [b.right, at.get(`gor${i}`)![1] + yOut]; });
  d = define({
    id: `arbrr${n}`, name: `${n}-way round-robin arbiter`, category: 'sequential',
    summary: `${n} requesters, one grant per cycle. A one-hot pointer holds the priority; the first requester at or after it wins (a masked priority chain, then an unmasked one when nobody at or after the pointer asks). On a conflict the pointer moves past the winner, so every requester is served within ${n} conflicts.`,
    ports: [...r.map((x) => bit(x, 'in')), { name: 'clk', width: 1, dir: 'in', side: 'bottom', clock: true }, ...I.map((i) => bit(`g${i}`, 'out'))],
    symbol: { kind: 'box', label: 'ARBITER' },
    netlist: () => ({ pins, instances: b.instances, nets: b.nets() }),
    hdl: {
      verilog: `module arbiter_rr #(parameter int N = ${n}) (input logic clk, input logic [N-1:0] r, output logic [N-1:0] g);
  logic [N-1:0] ptr = 1;                     // one-hot: who has priority
  always_comb begin
    g = '0;
    for (int k = 0; k < N; k++) begin        // first requester at or after ptr
      int i = ($clog2(ptr) + k) % N;
      if (r[i] && g == '0) g[i] = 1;
    end
  end
  always_ff @(posedge clk) if ($countones(r) > 1) ptr <= {g[N-2:0], g[N-1]};
endmodule`,
    },
  });
  arbiters.set(n, d);
  return d;
}
