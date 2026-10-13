// Act 9's build levels (a GPU, roadmap Phase 15): four lanes, the lane register file, the active
// mask and the reconvergence stack, then the SIMD and SIMT cores on the lane bench; the coalescer and
// the two-warp core; the graphics levels: edge stepper, tile walk, rasterizer, and the two-warp core with the
// rasterizer as a device. No DOM.

import type { BuildChallenge, PinSpec, SeqStep } from '../editor/challenges';
import { docFromDef } from '../editor/fromdef';
import type { ChipDoc, PartRef } from '../editor/model';
import { LANE_PORTS, LANES16, leaderOf, MASK16, NL, rv16Lanes, STACK16, StackModel, VRF16 } from '../lib/rv16/lanes16';
import { COAL16, FRAME_PORTS, RV16_FRAME, RV16_WARPS, WARP_PORTS } from '../lib/rv16/warps16';
import { EDGE16, RASTER16, ROFF, ROPER16, RSEQ16, RSETUP16, RSUB8, RTEST16, RTILES, TILE16 } from '../lib/rv16/raster16';
import { CMD16, Edge16, w16, Walk16 } from '../gfx/raster16';
import { runRaster } from './rastercheck';
import type { ComponentDef } from '../sim/types';
import { rng } from './drills';
import { laneCheck } from './lanecheck';
import { frameTests, simdTests, simtTests, warpTests } from './lanetests';
import { warpCheck } from './warpcheck';

const pins = (ins: [string, number?][], outs: [string, number?][], clock?: string): PinSpec[] => [
  ...ins.map(([name, width = 1]): PinSpec => ({ name, dir: 'in', width, ...(name === clock ? { clock: true } : {}) })),
  ...outs.map(([name, width = 1]): PinSpec => ({ name, dir: 'out', width })),
];
const each = (p: string, w = 16): [string, number][] => Array.from({ length: NL }, (_, i) => [`${p}${i}`, w]);

const answers = new Map<string, ChipDoc[]>();
/** A reference answer: the top def drawn as a chip, and `subs` (def → chip name) drawn as chips it places. */
const refOf = (id: string, def: () => ComponentDef, name: string, subs: () => [ComponentDef, string][] = () => []) => (): ChipDoc[] => {
  let a = answers.get(id);
  if (a) return a;
  const chips = new Map(subs().map(([d, n], i) => [d, { id: `u_ref_cp_${id}_${i}`, name: `${n} ref` }]));
  const refOfDef = (d: ComponentDef): PartRef | undefined => (chips.has(d) ? { chip: chips.get(d)!.id } : undefined);
  const docs: ChipDoc[] = [];
  for (const [d, c] of chips) {
    const doc = docFromDef(d, { ...c, refOf: refOfDef });
    if ('error' in doc) throw new Error(`reference ${id} (${d.id}): ${doc.error}`);
    docs.push({ ...doc, notes: `Part of the reference answer. ${d.summary ?? ''}`.trim() });
  }
  const top = docFromDef(def(), { id: `u_ref_cp_${id}`, name: `${name} ref`, refOf: refOfDef });
  if ('error' in top) throw new Error(`reference ${id}: ${top.error}`);
  answers.set(id, (a = [...docs, { ...top, notes: `Reference answer. ${def().summary ?? ''}`.trim() }]));
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

/** Address patterns over every mask: one line, four lines, pairs, lines one bit apart, a masked lane in the leader's line. */
function coalVectors(): number[][] {
  const r = rng(95);
  const w = () => Math.floor(r() * 0x10000);
  const rows: number[][] = [];
  for (let mask = 0; mask < 16; mask++) {
    const base = w() & 0xfffc;
    const pats = [
      [base, base + 1, base + 2, base + 3], // neighbouring threads, neighbouring words: one line
      [base + 3, base + 2, base + 1, base], // the same line, any order
      L4.map((i) => (base + 4 * i) & 0xffff), // a stride of four words: four lines
      [base, base + 2, base ^ 0x40, (base ^ 0x40) + 1], // two pairs
      [base, base ^ 4, base ^ 0x8000, base ^ 0x8004], // lines that differ in bit 2 or bit 15 only
      [w(), base + 1, base + 2, base], // lane 0 alone in its line
      [base, base, base, base], // one word
      [w(), w(), w(), w()],
    ];
    for (const p of pats) rows.push([...p, mask]);
  }
  return rows;
}
const L4 = [0, 1, 2, 3];

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

/** The edge stepper: every command, with steps of both signs, against the model. */
function edgeSeq(): SeqStep[] {
  const r = rng(96);
  const m = new Edge16();
  const st: SeqStep[] = [];
  const small = () => Math.floor(r() * 1024) - 512;
  const step = (cmd: number, a: number, b: number, e0: number) => {
    m.step(cmd, a, b, e0);
    st.push({ set: { cmd, a: w16(a), b: w16(b), e0: w16(e0) }, tick: true, expect: { e: w16(m.e), inside: m.inside } });
  };
  step(CMD16.load, 12, -40, -300);
  for (const c of [CMD16.right, CMD16.right, CMD16.skip, CMD16.down, CMD16.up, CMD16.down, CMD16.band, CMD16.hold, CMD16.right, CMD16.band, CMD16.skip]) step(c, 12, -40, 0);
  // the set-up's shift-and-add: E = 0, then double and add over the bits of 0b1011 (11 · 37 = 407)
  step(CMD16.load, 0, 0, 0);
  for (const bitv of [1, 0, 1, 1]) step(CMD16.double, bitv ? 37 : 0, 0, 0);
  for (let i = 0; i < 80; i++) step(Math.floor(r() * 8), small(), small(), Math.floor(r() * 0x10000) - 0x8000);
  return st;
}

/** The tile walk: boxes of every shape, tiles accepted and rejected, a reset in the middle. */
function tileSeq(): SeqStep[] {
  const r = rng(97);
  const m = new Walk16();
  const st: SeqStep[] = [];
  let box = { tx0: 0, tx1: 0, ty0: 0, ty1: 0 };
  const step = (go: number, ok: number, rst = 0) => {
    const o = m.out(box, ok);
    const expect: Record<string, number> = { busy: o.busy, test: o.test, pix: o.pix, cmd: o.cmd };
    if (o.busy) { expect.x = o.x; expect.y = o.y; }
    const set = { ...box, go, ok, rst };
    st.push({ set, expect });
    st.push({ set, tick: true, expect: {} });
    m.edge(box, go, ok, rst);
  };
  step(0, 0, 1);
  const boxes = [{ tx0: 1, tx1: 1, ty0: 2, ty1: 2 }, { tx0: 0, tx1: 2, ty0: 0, ty1: 1 }, { tx0: 5, tx1: 7, ty0: 6, ty1: 7 }, { tx0: 3, tx1: 3, ty0: 0, ty1: 3 }];
  boxes.forEach((b, k) => {
    box = b;
    step(1, 1);
    for (let i = 0; m.busy && i < 400; i++) step(0, k === 0 ? 1 : r() < 0.55 ? 1 : 0);
    step(0, 1);
  });
  // a reset while walking
  box = { tx0: 0, tx1: 7, ty0: 0, ty1: 7 };
  step(1, 1);
  for (let i = 0; i < 9; i++) step(0, 1);
  step(0, 1, 1);
  step(0, 1);
  return st;
}

const pinsOf = (ports: typeof LANE_PORTS): PinSpec[] => ports.map((p) => ({ name: p.name, dir: p.dir === 'out' ? 'out' : 'in', width: p.width, ...(p.name === 'clk' ? { clock: true } : {}) }));
const LANE_PINS = pinsOf(LANE_PORTS);

const CORE_BRIEF = 'Pins: one instruction stream (<code>pc</code>, <code>instr</code>) and, per lane <i>i</i>, a memory port (<code>daddr<i>i</i></code>, <code>dwdata<i>i</i></code>, <code>drdata<i>i</i></code>, bit <i>i</i> of <code>dwe</code>) and a register write port (bit <i>i</i> of <code>rwe</code>, <code>rwd<i>i</i></code>; <code>rwa</code> is shared). The bench serves every port in the same cycle, so one instruction per cycle is possible.';

export const BUILDK: Record<string, () => BuildChallenge> = {
  k_edge: () => ({
    id: 'k_edge', title: 'Edge stepper', level: 'cpu', allowed: 'nand',
    brief: 'One edge function E (16 bits, two\'s complement), stepped with adders only, and R, the start of the current band. At each clock edge, by <code>cmd</code>: 0 hold; 1 load: E, R ← <code>e0</code>; 2 right: E ← E + <code>a</code>; 3 skip a tile: E ← E + 4a; 4 down: E ← E + <code>b</code>; 5 up: E ← E − b; 6 next band: E, R ← R + 4b; 7 double: E ← 2E + a (the set-up multiplies with it). Outputs: <b>e</b> = E and <b>inside</b> = E ≥ 0, the sign bit inverted.',
    ports: pins([['a', 16], ['b', 16], ['e0', 16], ['cmd', 3], ['clk']], [['e', 16], ['inside']], 'clk'),
    check: { kind: 'sequence', steps: edgeSeq() },
    answer: refOf('k_edge', () => EDGE16, 'Edge stepper'),
  }),
  k_tile: () => ({
    id: 'k_tile', title: 'Tile walk', level: 'cpu', allowed: 'nand',
    brief: 'Walk a box of tiles (4 × 4 pixels each; tiles <code>tx0</code> … <code>tx1</code> across, <code>ty0</code> … <code>ty1</code> down, 0 … 7, held while busy) in <b>bands</b>: a band is a row of tiles, left to right. <code>go</code> while idle starts at the first tile; <b>busy</b> = 1 from the next cycle until the last tile is done; <code>rst</code> stops at once. '
      + 'Each tile begins with one <b>TEST</b> cycle (<b>test</b> = 1) at its top-left pixel. If <code>ok</code> = 0, the tile is skipped: <b>cmd</b> = 3 (skip) to the next tile, or 6 (band) to the next band\'s first tile, or 0 after the last. If ok = 1, its 16 pixels follow (<b>pix</b> = 1), column by column: down the first (cmd 4), up the second (cmd 5), down, up; <b>cmd</b> = 2 (right) at the end of each column; the last pixel, the tile\'s top-right, moves right to the next tile, or bands (6), or 0 after the last tile. The TEST before them holds (cmd 0). '
      + '<b>x</b>, <b>y</b>: the pixel where the walk is (4·tile + column, 4·tile + row); test, pix and cmd are 0 while idle.',
    ports: pins([['tx0', 3], ['tx1', 3], ['ty0', 3], ['ty1', 3], ['go'], ['ok'], ['clk'], ['rst']], [['x', 5], ['y', 5], ['cmd', 3], ['test'], ['pix'], ['busy']], 'clk'),
    check: { kind: 'sequence', steps: tileSeq() },
    answer: refOf('k_tile', () => TILE16, 'Tile walk'),
  }),
  k_raster: () => ({
    id: 'k_raster', title: 'Rasterizer', level: 'cpu', allowed: 'nand',
    brief: 'A triangle in, its pixels out, one a cycle, on a 32 × 32 screen. Vertices <code>v0x</code> … <code>v2y</code> are 7-bit quarter pixels (pixel (x, y)\'s centre is (4x + 2, 4y + 2)); with <code>col</code> they are held from <code>go</code> until busy falls. <b>busy</b> = 1 from the cycle after go until the last pixel. '
      + 'Edge i runs from vertex i to i + 1: A = y<sub>i</sub> − y<sub>i+1</sub>, B = x<sub>i+1</sub> − x<sub>i</sub>, E<sub>i</sub>(p) = A·(p.x − x<sub>i</sub>) + B·(p.y − y<sub>i</sub>), minus 1 unless the edge is left (A &gt; 0) or top (A = 0, B &gt; 0). A pixel is inside when its three E ≥ 0. A triangle whose E sum (twice its area, biases added back) is ≤ 0 is a back face: nothing is drawn. '
      + 'Walk the box of tiles (first tile (min + 1) &gt;&gt; 4, last max(max − 2, 0) &gt;&gt; 4, in quarter pixels) with your tile walk; a tile whose E + 12·(A⁺ + B⁺) &lt; 0 for some edge (A⁺: A if positive, else 0) is skipped. For each pixel inside: <b>fwe</b> = 1, <b>fa</b> = 32·y + x, <b>fd</b> = col, in the walk\'s order. No multiplier: E at the first tile by shift-and-add on each stepper (double).',
    ports: pins([['v0x', 7], ['v0y', 7], ['v1x', 7], ['v1y', 7], ['v2x', 7], ['v2y', 7], ['col', 16], ['go'], ['clk'], ['rst']], [['fa', 10], ['fd', 16], ['fwe'], ['busy']], 'clk'),
    check: { kind: 'custom', describe: '64 triangles, 32 at once (back faces, slivers, shared edges, the screen\'s corners among them): every pixel write in the walk\'s order; cycles from go until busy falls.', run: runRaster },
    answer: refOf('k_raster', () => RASTER16, 'Rasterizer', () => [[RSUB8, 'Subtractor'], [RTILES, 'Tile range'], [ROFF, 'Tile test offset'], [RSETUP16, 'Set-up'], [RSEQ16, 'Set-up steps'], [ROPER16, 'Stepper operands'], [RTEST16, 'Cull and tile test']]),
  }),
  k_frame: () => ({
    id: 'k_frame', title: 'A frame', level: 'cpu', allowed: 'nand',
    brief: 'Your two-warp core with your rasterizer as a device. Lane 0\'s stores to <b>0xFFF0 … 0xFFF5</b> set v0x … v2y (the low 7 bits), its store to <b>0xFFF6</b> sets the colour and starts the triangle in the next cycle; the other lanes\' stores there do nothing special. The rasterizer writes the screen, the words <b>0xF000 + 32·y + x</b> (RGB565), through <code>fa</code>, <code>fd</code>, <code>fwe</code>. '
      + 'While it is busy (or about to start), a warp whose instruction would store to it from lane 0, or load from the screen with any active lane, does not issue: its turn passes, and it tries again at its next turn. Everything else is the two-warp core: the same pins, the memory one cycle late. The golden model draws at once, so the picture and every load agree.',
    ports: pinsOf(FRAME_PORTS),
    check: warpCheck({ tests: frameTests, budget: { cpi: 1, extra: 4 }, raster: true }, `${frameTests().length} programs on two warps against the golden model with its rasterizer: register writes, stores and every pixel write in order.`),
    answer: refOf('k_frame', () => RV16_FRAME, 'A frame'),
  }),
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
  k_warps: () => ({
    id: 'k_warps', title: 'Two warps', level: 'cpu', allowed: 'nand',
    brief: 'Two warps of your SIMT core take turns: warp 0 issues in the first cycle after reset, then warp 1, then warp 0 again, and so on. Each warp has its own PC (both start at 0), mask, stack and lane registers; fetch, decode, control and the four lanes are shared. <code>csrr rd, tid</code> gives warp · 4 + lane. '
      + 'The data memory now answers <b>one cycle late</b>: <code>drdata<i>i</i></code> is the word at the address lane <i>i</i> gave in the previous cycle (stores land at the end of their cycle). So a load writes nothing when it issues: keep its lanes and rd for a cycle and write the word through the second port, <code>lwe</code> (a bit per lane), <code>lwa</code>, <code>lwd<i>i</i></code>, during the other warp’s turn. '
      + '<code>rwe</code>, <code>rwa</code>, <code>rwd<i>i</i></code> carry every other register write, of the warp issuing now; <code>warp</code> says which warp that is. '
      + '<b>bar</b>: the first warp to arrive issues nothing in its turns until the other arrives too, or has ended. A warp with no active lane (after <code>tmc x0</code>) has ended: it issues nothing more.',
    ports: pinsOf(WARP_PORTS),
    check: warpCheck({ tests: warpTests, budget: { cpi: 1, extra: 4 } }, `${warpTests().length} programs on two warps of four lanes against the two-warp golden model, the warps taking turns every cycle.`),
    answer: refOf('k_warps', () => RV16_WARPS, 'Two warps'),
  }),
  k_coal: () => ({
    id: 'k_coal', title: 'Coalescer', level: 'cpu', allowed: 'nand',
    brief: 'One memory port for four lanes: serve at once every active lane whose word is in the same <b>line</b>. RV16 is word-addressed with 16-bit words, so a line is four words: the address with bits 1 … 0 dropped, <b>a<i>i</i>[15:2]</b>. '
      + 'The lowest active lane (the leader, as in your mask) picks the line: <b>line</b> = its a[15:2]; <b>served</b> bit <i>i</i> = 1 when lane <i>i</i> is active and its a<i>i</i>[15:2] equals line; <b>left</b> = the active lanes not served, for the next access. '
      + 'With no lane active, served and left are 0 and line is anything.',
    ports: pins([...each('a'), ['mask', NL]], [['line', 14], ['served', NL], ['left', NL]]),
    check: { kind: 'table', spec: COAL16.spec!, vectors: coalVectors, care: (v) => [v[4] ? 0x3fff : 0, 15, 15] },
    answer: refOf('k_coal', () => COAL16, 'Coalescer'),
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
