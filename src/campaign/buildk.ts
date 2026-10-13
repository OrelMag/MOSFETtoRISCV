// Act 9's build levels (a GPU, roadmap Phase 15): four lanes, the lane register file, the active
// mask and the reconvergence stack, then the SIMD and SIMT cores on the lane bench. No DOM.

import type { BuildChallenge, PinSpec, SeqStep } from '../editor/challenges';
import { docFromDef } from '../editor/fromdef';
import type { ChipDoc } from '../editor/model';
import { LANE_PORTS, LANES16, leaderOf, MASK16, NL, rv16Lanes, STACK16, StackModel, VRF16 } from '../lib/rv16/lanes16';
import type { ComponentDef } from '../sim/types';
import { rng } from './drills';
import { laneCheck } from './lanecheck';
import { simdTests, simtTests } from './lanetests';

const pins = (ins: [string, number?][], outs: [string, number?][], clock?: string): PinSpec[] => [
  ...ins.map(([name, width = 1]): PinSpec => ({ name, dir: 'in', width, ...(name === clock ? { clock: true } : {}) })),
  ...outs.map(([name, width = 1]): PinSpec => ({ name, dir: 'out', width })),
];
const each = (p: string, w = 16): [string, number][] => Array.from({ length: NL }, (_, i) => [`${p}${i}`, w]);

const answers = new Map<string, ChipDoc[]>();
const refOf = (id: string, def: () => ComponentDef, name: string) => (): ChipDoc[] => {
  let a = answers.get(id);
  if (!a) {
    const doc = docFromDef(def(), { id: `u_ref_cp_${id}`, name: `${name} ref` });
    if ('error' in doc) throw new Error(`reference ${id}: ${doc.error}`);
    answers.set(id, (a = [{ ...doc, notes: `Reference answer. ${def().summary ?? ''}`.trim() }]));
  }
  return a;
};

/** Edge cases the random draw misses: zero operands (nz), the immediate in use, every operation. */
function lanesVectors(): number[][] {
  const r = rng(91);
  const w = () => Math.floor(r() * 0x10000);
  const rows: number[][] = [];
  for (let op = 0; op < 16; op++) {
    const a = [0, w(), 0x8000, 0xffff], b = [w(), 0, 1, 15];
    rows.push([...a, ...b, w(), op & 1, op], [...b, ...a, w(), (op >> 1) & 1, op]);
  }
  rows.push(Array(11).fill(0));
  return rows;
}

function vrfSeq(): SeqStep[] {
  const r = rng(92);
  const regs: (number | undefined)[][] = Array.from({ length: NL }, () => Array(8).fill(undefined));
  const st: SeqStep[] = [];
  const step = (wa: number, we: number, wd: number[], ra1: number, ra2: number) => {
    for (let i = 0; i < NL; i++) if ((we >> i) & 1 && wa) regs[i][wa] = wd[i];
    const expect: Record<string, number> = {};
    for (let i = 0; i < NL; i++) {
      const a = ra1 ? regs[i][ra1] : 0, b = ra2 ? regs[i][ra2] : 0;
      if (a !== undefined) expect[`a${i}`] = a;
      if (b !== undefined) expect[`b${i}`] = b;
    }
    st.push({ set: { wa, we, ra1, ra2, ...Object.fromEntries(wd.map((v, i) => [`wd${i}`, v])) }, tick: true, expect });
  };
  const word = () => Math.floor(r() * 0x10000);
  // fill every register of every lane, each lane its own value; then masked writes and reads
  for (let k = 1; k < 8; k++) step(k, 0b1111, [0, 1, 2, 3].map((i) => (0x1000 * (i + 1) + k) & 0xffff), k, k - 1);
  step(0, 0b1111, [1, 2, 3, 4], 0, 1);
  for (let i = 0; i < 60; i++) step(Math.floor(r() * 8), Math.floor(r() * 16), [word(), word(), word(), word()], Math.floor(r() * 8), Math.floor(r() * 8));
  return st;
}

function maskSeq(): SeqStep[] {
  const r = rng(93);
  let mask = 0;
  const st: SeqStep[] = [];
  const step = (rst: number, ld: number, d: number, rwe: number, mwe: number) => {
    if (rst) mask = 15;
    else if (ld) mask = d;
    const { lead, any } = leaderOf(mask);
    const expect: Record<string, number> = { mask, any, we: rwe ? mask : 0, dwe: mwe ? mask : 0 };
    if (any) expect.lead = lead;
    st.push({ set: { rst, ld, d, rwe, mwe }, tick: true, expect });
  };
  step(1, 0, 0, 1, 0);
  step(0, 0, 3, 1, 1);
  for (let d = 0; d < 16; d++) step(0, 1, d, d & 1, (d >> 1) & 1);
  step(1, 1, 0, 1, 1);
  for (let i = 0; i < 50; i++) step(r() < 0.08 ? 1 : 0, r() < 0.5 ? 1 : 0, Math.floor(r() * 16), r() < 0.5 ? 1 : 0, r() < 0.5 ? 1 : 0);
  return st;
}

function stackSeq(): SeqStep[] {
  const r = rng(94);
  const m = new StackModel();
  const st: SeqStep[] = [];
  const step = (i: { rst: number; split: number; join: number; mask: number; p: number; pc1: number }) => {
    // the outputs, from the state before the edge; then the edge
    const o = m.out(i);
    const expect: Record<string, number> = { ld: o.ld, jump: o.jump };
    if (o.nmask >= 0) expect.nmask = o.nmask;
    if (o.jump) expect.jpc = o.jpc;
    st.push({ set: { ...i }, expect });
    st.push({ set: { ...i }, tick: true, expect: {} });
    m.edge(i);
  };
  const base = { rst: 0, split: 0, join: 0, mask: 15, p: 0, pc1: 0 };
  step({ ...base, rst: 1 });
  // the chapter's if / else: a split, two joins
  step({ ...base, split: 1, mask: 15, p: 0b1010, pc1: 0x0021 });
  step({ ...base, join: 1, mask: 0b1010 });
  step({ ...base, join: 1, mask: 0b0101 });
  // a split the lanes agree on, a join on an empty stack, nested splits
  step({ ...base, split: 1, mask: 15, p: 15, pc1: 0x0100 });
  step({ ...base, join: 1 });
  step({ ...base, join: 1 });
  step({ ...base, split: 1, mask: 15, p: 0b1100, pc1: 0x0200 });
  step({ ...base, split: 1, mask: 0b1100, p: 0b1000, pc1: 0x0300 });
  for (let k = 0; k < 4; k++) step({ ...base, join: 1, mask: Math.floor(r() * 16) });
  for (let i = 0; i < 60; i++) {
    const u = r();
    const depth = m.entries.length;
    const split = u < 0.4 && depth < 4 ? 1 : 0, join = !split && u < 0.85 ? 1 : 0;
    step({ rst: r() < 0.03 ? 1 : 0, split, join, mask: Math.floor(r() * 16), p: Math.floor(r() * 16), pc1: Math.floor(r() * 0x10000) });
  }
  return st;
}

const LANE_PINS: PinSpec[] = LANE_PORTS.map((p) => ({ name: p.name, dir: p.dir === 'out' ? 'out' : 'in', width: p.width, ...(p.name === 'clk' ? { clock: true } : {}) }));

const CORE_BRIEF = 'Pins: one instruction stream (<code>pc</code>, <code>instr</code>) and, per lane <i>i</i>, a memory port (<code>daddr<i>i</i></code>, <code>dwdata<i>i</i></code>, <code>drdata<i>i</i></code>, bit <i>i</i> of <code>dwe</code>) and a register write port (bit <i>i</i> of <code>rwe</code>, <code>rwd<i>i</i></code>; <code>rwa</code> is shared). The bench serves every port in the same cycle, so one instruction per cycle is possible.';

export const BUILDK: Record<string, () => BuildChallenge> = {
  k_lanes: () => ({
    id: 'k_lanes', title: 'Four lanes', level: 'cpu', allowed: 'nand',
    brief: 'Four datapaths, one control: lane <i>i</i> computes <b>y<i>i</i> = ALU(a<i>i</i>, bimm ? imm : b<i>i</i>)</b> with the ALU operation <code>alu</code> (the same for every lane, as your ALU encodes it), and <b>nz</b> bit <i>i</i> = 1 when a<i>i</i> ≠ 0 (split will test it).',
    ports: pins([...each('a'), ...each('b'), ['imm', 16], ['bimm'], ['alu', 4]], [...each('y'), ['nz', NL]]),
    check: { kind: 'table', spec: LANES16.spec!, vectors: lanesVectors },
    answer: refOf('k_lanes', () => LANES16, 'Four lanes'),
  }),
  k_vrf: () => ({
    id: 'k_vrf', title: 'Lane register file', level: 'cpu', allowed: 'nand',
    brief: 'Every lane has its own eight registers. All lanes read the same register numbers (<code>ra1</code> → a<i>i</i>, <code>ra2</code> → b<i>i</i>, combinationally) and, at the clock edge, write their own word <code>wd<i>i</i></code> to register <code>wa</code> when bit <i>i</i> of <code>we</code> is 1. x0 reads 0 in every lane.',
    ports: pins([['wa', 3], ['we', NL], ...each('wd'), ['ra1', 3], ['ra2', 3], ['clk']], [...each('a'), ...each('b')], 'clk'),
    check: { kind: 'sequence', steps: vrfSeq() },
    answer: refOf('k_vrf', () => VRF16, 'Lane register file'),
  }),
  k_mask: () => ({
    id: 'k_mask', title: 'Active mask', level: 'cpu', allowed: 'nand',
    brief: 'A 4-bit <b>mask</b>, one bit per lane: at the clock edge, <b>1111</b> if <code>rst</code>, else <code>d</code> if <code>ld</code>, else hold. Outputs: the mask; <b>lead</b>, the number of the lowest active lane (any value when none is); <b>any</b>, some lane is active; <b>we</b> = mask when <code>rwe</code> (else 0) and <b>dwe</b> = mask when <code>mwe</code>: only active lanes write.',
    ports: pins([['rst'], ['ld'], ['d', NL], ['rwe'], ['mwe'], ['clk']], [['mask', NL], ['lead', 2], ['any'], ['we', NL], ['dwe', NL]], 'clk'),
    check: { kind: 'sequence', steps: maskSeq() },
    answer: refOf('k_mask', () => MASK16, 'Active mask'),
  }),
  k_simd: () => ({
    id: 'k_simd', title: 'SIMD core', level: 'cpu', allowed: 'nand',
    brief: `Four lanes in lock-step: one PC, one control unit, every lane its own registers, ALU and memory port. Only active lanes write (the mask, all on after reset). <code>csrr rd, tid</code> gives lane <i>i</i> the value <i>i</i>; <code>tmc rs1</code> loads the mask from the low four bits of the <b>leader</b>'s rs1 (the lowest active lane); branches and <code>jalr</code> use the leader's registers. Given: the lane decoder. ${CORE_BRIEF}`,
    ports: LANE_PINS,
    check: laneCheck({ tests: simdTests, budget: { cpi: 1, extra: 4 } }, `${simdTests().length} programs on every lane against the lane golden model, one instruction per cycle.`),
    answer: refOf('k_simd', () => rv16Lanes(false), 'SIMD core'),
  }),
  k_stack: () => ({
    id: 'k_stack', title: 'Reconvergence stack', level: 'cpu', allowed: 'nand',
    brief: 'Four entries of (mask, else lanes, resume pc, pending), the top one first. <b>split</b>: then = mask · p, else = mask · ¬p; push (mask, else, <code>pc1</code>, pending = then ≠ 0 and else ≠ 0); the new mask is <i>then</i> if pending, else unchanged. <b>join</b> on a non-empty stack: if the top is pending, the mask becomes its else lanes, <b>jump</b> = 1 to <b>jpc</b> = its pc, and pending clears; otherwise the mask becomes its saved mask and the entry pops. <b>ld</b> = 1 whenever the mask changes (<b>nmask</b>: its new value). <code>rst</code> empties the stack.',
    ports: pins([['rst'], ['split'], ['join'], ['mask', NL], ['p', NL], ['pc1', 16], ['clk']], [['ld'], ['nmask', NL], ['jump'], ['jpc', 16]], 'clk'),
    check: { kind: 'sequence', steps: stackSeq() },
    answer: refOf('k_stack', () => STACK16, 'Reconvergence stack'),
  }),
  k_simt: () => ({
    id: 'k_simt', title: 'SIMT core', level: 'cpu', allowed: 'nand',
    brief: `Your SIMD core, plus <code>split rs1</code> and <code>join</code> on the reconvergence stack: split's p is each lane's rs1 ≠ 0, its pc1 the address after it; a join that jumps loads the PC with jpc. <code>tmc</code> still wins the mask when it runs; <code>bar</code> does nothing (one warp). ${CORE_BRIEF}`,
    ports: LANE_PINS,
    check: laneCheck({ tests: simtTests, budget: { cpi: 1, extra: 4 } }, `${simtTests().length} programs on every lane, if / else and nested ifs among them, one instruction per cycle.`),
    answer: refOf('k_simt', () => rv16Lanes(true), 'SIMT core'),
  }),
};
