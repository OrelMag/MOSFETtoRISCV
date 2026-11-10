// Core memory as a circuit (the Memory chapter's "A core plane, wired"; the 3D plane beside it is widgets/core3d.ts).
// Whirlwind's coincident-current scheme (Forrester, US 2,736,880; MIT Report R-221, 1954, section 5) at the level the rest
// of the book is simulated at: gates and flip-flops around one new element, the ferrite core.
//
// CORE (prim 'core'): a bit stored as the direction of a ring's magnetisation. Every wire through it adds its current:
// its X line and its Y line, each with a read and a write driver (R-221: one driver per line in each direction), and its
// plane's inhibit, a half the other way. Counted in half-select units, a write half is +1, a read half -1 and the inhibit
// -1 (sim/core.ts). The loop is taken as square: the core switches to 1 when the sum reaches +2 and to 0 at -2, and holds
// at anything in between (a single half, or a write half cancelled by the inhibit). It switches at the clock edge that
// ends a phase, from the drive it saw while the clock was low, as every storage leaf here does; its sense output is 1
// during the phase in which it is switching (a read of a 1, or a 1 written into a 0: the pulse of the other polarity,
// which nothing strobes), the flux change that induces a pulse in the sense winding. The winding threads every core of a
// plane in series, so the pulses add: each core passes on what it receives (si) and adds its own (so = si OR switching).
// Exact for the logic, since only one core of a plane is fully selected at once; the small pulses of half-selected cores
// (the noise real sense amplifiers had to reject) are left out, and the chapter says so.
//
// CORE_STORE: 16 words of 4 bits in four 4 x 4 digit planes, one per bit. The X and Y selection lines run through all
// four planes, so a whole word is selected at once (R-221 section 5.1's "selection plane"). A cycle is two clocks, READ
// then WRITE. READ drives the addressed cores toward 0 and the planes' sense lines carry the word; the edge that ends READ
// loads the buffer register from them, so the strobe falls inside the read current, as Whirlwind's did. WRITE drives
// toward 1, with the inhibit on in the planes whose buffer bit is 0. A read writes back what it read; a write (we = 1)
// loads the buffer with din instead. go starts a cycle when idle; the address, din and we are taken then. inhOn = 0
// switches the inhibit drivers off (the chapter's experiment: then WRITE sets every bit of the word).

import { CORE_FULL, coreDrive, coreNext, coreSwitching, type CoreState, isCoreState } from '../sim/core';
import type { Behavior, ComponentDef, InstanceDef, NetDef, PortDef } from '../sim/types';
import { decoder } from './combinational';
import { define, merger, ones, splitter } from './define';
import { AND, MUX2, NOR, NOT } from './gates';
import { DFF, DFFE } from './sequential';
import { TIE0 } from './transistors';

export { CORE_FULL, coreDrive, coreNext, coreSwitching, type CoreState, isCoreState };

const cache = new Map<string, ComponentDef>();
function memo(key: string, f: () => ComponentDef): ComponentDef {
  let d = cache.get(key);
  if (!d) cache.set(key, (d = f()));
  return d;
}

const bit = (name: string, dir: 'in' | 'out', side?: PortDef['side'], clock?: boolean): PortDef => ({ name, width: 1, dir, side, ...(clock ? { clock: true } : {}) });
const bus = (name: string, width: number, dir: 'in' | 'out', side?: PortDef['side']): PortDef => ({ name, width, dir, side });

const fresh = (mode?: 'x' | 'zero' | 'random'): CoreState => ({ b: mode === 'x' ? -1 : mode === 'random' ? (Math.random() < 0.5 ? 0 : 1) : 0, clk: 0, lo: 0, hi: 0 });

/** The core in Verilog: a flip-flop that a full current sets or clears, and its sense pulse. x, y: bit 0 read, bit 1 write. */
const coreSynth = (one: boolean) => [
  `  reg b = 1'b${one ? 1 : 0};  // the ring's magnetisation (as it powers on)`,
  '  // currents in half-select units: write halves one way, read halves and the inhibit the other',
  "  wire [2:0] up = {2'b0, x[1]} + {2'b0, y[1]};",
  "  wire [2:0] down = {2'b0, x[0]} + {2'b0, y[0]} + {2'b0, inh};",
  "  wire set = up >= down + 3'd2, clear = down >= up + 3'd2;",
  "  always @(posedge clk) if (set) b <= 1'b1; else if (clear) b <= 1'b0;",
  "  // the sense winding: what the cores before it induced, and this core's pulse while it switches",
  '  assign so = si | (b ? clear : set);',
];

const coreBehavior: Behavior = {
  init: fresh,
  seq: { clk: 'clk', comb: ['x', 'y', 'inh', 'si'] },
  eval: ([x, y, inh, si, clk], st) => {
    const s = st as CoreState;
    const { lo, hi } = coreDrive(x, y, inh);
    const c = clk < 0 ? 2 : clk;
    if (c !== 1) { s.lo = lo; s.hi = hi; }
    const p = s.clk;
    s.clk = c;
    if (p !== 1 && c !== 0 && p !== c) s.b = coreNext(s.b, s.lo, s.hi, p === 0 && c === 1);
    const f = coreSwitching(s.b, lo, hi);
    return [si === 1 || f === 1 ? 1 : si === 0 && f === 0 ? 0 : -1];
  },
  carry: (prev, known) => (isCoreState(prev) ? { ...prev, b: known && prev.b < 0 ? 0 : prev.b } : fresh('zero')),
};

export const CORE: ComponentDef = define({
  id: 'core', name: 'Ferrite core', category: 'memory', prim: 'core',
  summary: 'One bit as the direction of a ferrite ring\'s magnetisation. The currents of the wires through it add: two half-selects in the same direction switch it, one alone (or a half cancelled by the inhibit) does not. Switching induces a pulse in the sense winding.',
  ports: [bus('x', 2, 'in', 'top'), bus('y', 2, 'in'), bit('inh', 'in', 'bottom'), bit('si', 'in'), bit('clk', 'in', 'bottom', true), bit('so', 'out')],
  symbol: { kind: 'core' },
  modelPanel: 'core',
  behavior: coreBehavior,
  hdl: { synth: coreSynth(false), verilog: coreSynth(false).join('\n') },
});

/**
 * The same core holding a 1 when the power comes on: a store with contents is built from both (coreStore), as a core
 * plane keeps its bits with the power off. Not in the library: it is the core, at another starting value.
 */
export const CORE_SET: ComponentDef = {
  ...CORE, id: 'core_set', name: 'Ferrite core (holding a 1)',
  behavior: { ...coreBehavior, init: (mode) => ({ ...fresh(mode), b: mode === 'x' ? -1 : mode === 'random' ? fresh(mode).b : 1 }) },
  hdl: { synth: coreSynth(true), verilog: coreSynth(true).join('\n') },
};

/** Rows, columns and planes of the store; a word is one core per plane. */
const N = 4, PLANES = 4, WORDS = N * N;
export const CORE_WORDS = WORDS, CORE_PLANES = PLANES;

/** The plane's grid: the first core's corner and the pitch between cores (grid units). */
const X0 = 16, Y0 = 14, P = 10;
/** A core's instance name in a plane: c<row><column>. */
export const coreName = (r: number, c: number) => `c${r}${c}`;

/** Wiring: a line bus (read wires on bits 0-3, write wires on 4-7) to a pair per line, o<k> = (read k, write k). */
const LINE_PAIRS: ComponentDef = {
  id: 'core_line_pairs', name: 'Split lines into read / write pairs', category: 'plumbing',
  summary: 'Pure wiring: each line\'s read wire and write wire side by side.',
  ports: [bus('in', 2 * N, 'in'), ...Array.from({ length: N }, (_, k) => bus(`o${k}`, 2, 'out'))],
  symbol: { kind: 'split', pitch: P }, prim: 'alias',
  alias: Array.from({ length: N }, (_, k): [string, number, string, number][] => [['in', k, `o${k}`, 0], ['in', N + k, `o${k}`, 1]]).flat(),
};

/**
 * A 4 x 4 plane of cores: an X line along each row and a Y line down each column (each line two wires, its read and write
 * drivers: x and y carry line k's read wire on bit k and its write wire on bit 4 + k), one inhibit wire and one sense winding through all
 * sixteen, row by row. Only the core where a driven X and a driven Y cross sees a full current.
 */
export const corePlane = (bits = 0): ComponentDef => memo(`plane${bits}`, () => {
  const instances: InstanceDef[] = [
    { name: 'sx', def: LINE_PAIRS, at: [4, Y0 - 7] },
    { name: 'sy', def: LINE_PAIRS, at: [X0 - 8, Y0 - 6], flip: true, rot: 3 },
    { name: 'z', def: TIE0, at: [X0 - 7, Y0 + 2] },
  ];
  const nets: NetDef[] = [
    { name: 'x', ends: ['x', 'sx.in'] },
    { name: 'y', ends: ['y', 'sy.in'], via: { 'sy.in': [[X0 + 12, Y0 - 10]] } },
    { name: 'inh', ends: ['inh', ...Array.from({ length: WORDS }, (_, k) => `${coreName(k >> 2, k & 3)}.inh`)] },
    { name: 'clk', ends: ['clk', ...Array.from({ length: WORDS }, (_, k) => `${coreName(k >> 2, k & 3)}.clk`)] },
  ];
  for (let r = 0; r < N; r++) {
    nets.push({ name: `x${r}`, ends: [`sx.o${r}`, ...Array.from({ length: N }, (_, c) => `${coreName(r, c)}.x`)] });
    nets.push({ name: `y${r}`, ends: [`sy.o${r}`, ...Array.from({ length: N }, (_, c) => `${coreName(c, r)}.y`)] });
    for (let c = 0; c < N; c++) instances.push({ name: coreName(r, c), def: bits >> (r * N + c) & 1 ? CORE_SET : CORE, at: [X0 + P * c, Y0 + P * r] });
  }
  // the sense winding, row by row: along a row from core to core, then back under it to the next row's first core
  let si = 'z.y';
  for (let k = 0; k < WORDS; k++) {
    const r = k >> 2, c = k & 3, here = `${coreName(r, c)}.si`;
    const net: NetDef = { name: k ? `s${k}` : 's0', ends: [si, here] };
    if (k && c === 0) {
      const y = Y0 + P * (r - 1);
      net.via = { [here]: [[X0 + P * (N - 1) + 6, y + 3], [X0 + P * (N - 1) + 6, y + 7], [X0 - 1.5, y + 7], [X0 - 1.5, y + P + 3]] };
    }
    nets.push(net);
    si = `${coreName(r, c)}.so`;
  }
  const R = X0 + P * (N - 1) + 10;
  nets.push({ name: 'sense', ends: [si, 's'] });
  return (bits ? (d: ComponentDef) => d : define)({
    id: bits ? `core_plane4_${bits.toString(16).padStart(4, '0')}` : 'core_plane4', name: '4 x 4 core plane', category: 'memory',
    summary: 'Sixteen cores on a grid: an X line along each row and a Y line down each column (each with a read and a write driver), one inhibit wire and one sense winding through all sixteen. Only the core where a driven X and a driven Y cross sees a full current.',
    ports: [bus('x', 2 * N, 'in'), bus('y', 2 * N, 'in'), bit('inh', 'in'), bit('clk', 'in', 'bottom', true), bit('s', 'out')],
    symbol: { kind: 'box', label: 'PLANE' },
    netlist: () => ({
      pins: { x: [0, Y0 + 13], y: [0, Y0 - 10], inh: [0, Y0 + P * N + 2], clk: [0, Y0 + P * N + 5], s: [R, Y0 + P * (N - 1) + 3] },
      instances, nets,
    }),
  });
});
export const CORE_PLANE = corePlane();

/**
 * The store: address, data and op registers taken at go; the phase register (READ, then WRITE); X and Y decoders with a
 * read and a write driver per line (a line bus: the read wires on bits 0-3, the write wires on 4-7); an inhibit driver
 * and a buffer bit per plane; four planes. Laid out by hand in bands: registers and phase on the left, the drivers, the
 * planes with their inhibit drivers, the buffer.
 */
export const coreStore = (words: readonly number[] = []): ComponentDef => memo(`store${words.join(',')}`, () => {
  // plane p holds bit p of every word: core k of the plane is word k
  const planeBits = (p: number) => Array.from({ length: WORDS }, (_, k) => ((words[k] ?? 0) >> p & 1) << k).reduce((a, b) => a | b, 0);
  const any = words.some((w) => w);
  const PX = 76, PY = (p: number) => 4 + 24 * p; // the planes' column and rows
  const inst = (name: string, def: ComponentDef, at: [number, number], label?: string): InstanceDef => ({ name, def, at, label });
  const instances: InstanceDef[] = [
    // address, data and op registers, each bit's d level with its splitter's output
    inst('sa', splitter(ones(4), 10), [6, -1]),
    ...Array.from({ length: 4 }, (_, i) => inst(`a${i}`, DFFE, [16, 2 + 10 * i], `a${i}`)),
    inst('sd', splitter(ones(PLANES), 10), [6, 41]),
    ...Array.from({ length: PLANES }, (_, i) => inst(`d${i}`, DFFE, [16, 44 + 10 * i], `d${i}`)),
    inst('op', DFFE, [16, 84], 'we'),
    // phase: idle = neither READ nor WRITE; READ follows go when idle, WRITE follows READ
    inst('idle', NOR, [6, 98], 'idle'),
    inst('start', AND, [16, 98], 'start'),
    inst('rd', DFF, [36, 98], 'READ'),
    inst('wr', DFF, [36, 110], 'WRITE'),
    inst('inhon', AND, [54, 114], 'inhibit on'),
    // address bits 1:0 pick the column (Y), 3:2 the row (X)
    inst('ay', merger([1, 1], 10), [28, 0]),
    inst('ax', merger([1, 1], 10), [28, 20]),
    inst('yr', decoder(2, true), [36, 6], 'Y read'),
    inst('yw', decoder(2, true), [36, 20], 'Y write'),
    inst('xr', decoder(2, true), [36, 34], 'X read'),
    inst('xw', decoder(2, true), [36, 48], 'X write'),
    inst('ym', merger(ones(2 * N), 2), [52, 7]),
    inst('xm', merger(ones(2 * N), 2), [52, 35]),
  ];
  const nets: NetDef[] = [
    { name: 'addr', ends: ['addr', 'sa.in'] },
    { name: 'din', ends: ['din', 'sd.in'] },
    { name: 'we', ends: ['we', 'op.d'] },
    { name: 'go', ends: ['go', 'start.b'] },
    { name: 'inhOn', ends: ['inhOn', 'inhon.b'] },
    { name: 'idle', ends: ['idle.y', 'start.a'] },
    { name: 'start', ends: ['start.y', 'rd.d', 'op.en', ...Array.from({ length: 4 }, (_, i) => `a${i}.en`), ...Array.from({ length: PLANES }, (_, i) => `d${i}.en`)], tags: true },
    { name: 'READ', ends: ['rd.q', 'wr.d', 'idle.a', 'yr.en', 'xr.en', ...Array.from({ length: PLANES }, (_, p) => `buf${p}.en`), 'mp.i0'], tags: true },
    { name: 'WRITE', ends: ['wr.q', 'idle.b', 'yw.en', 'xw.en', 'inhon.a', 'mp.i1'], tags: true },
    { name: 'inhW', ends: ['inhon.y', ...Array.from({ length: PLANES }, (_, p) => `inh${p}.a`)], tags: true },
    { name: 'op', ends: ['op.q', ...Array.from({ length: PLANES }, (_, p) => `mx${p}.s`)], tags: true },
    { name: 'ay', ends: ['ay.out', 'yr.a', 'yw.a'] },
    { name: 'ax', ends: ['ax.out', 'xr.a', 'xw.a'] },
    { name: 'y', ends: ['ym.out', ...Array.from({ length: PLANES }, (_, p) => `p${p}.y`)], tags: true },
    { name: 'x', ends: ['xm.out', ...Array.from({ length: PLANES }, (_, p) => `p${p}.x`)], tags: true },
    { name: 'clk', ends: ['clk', 'rd.clk', 'wr.clk', 'op.clk', ...['a', 'd', 'buf'].flatMap((r) => Array.from({ length: 4 }, (_, i) => `${r}${i}.clk`)), ...Array.from({ length: PLANES }, (_, p) => `p${p}.clk`)], tags: true },
    { name: 'dout', ends: ['mo.out', 'dout'] },
    { name: 'phase', ends: ['mp.out', 'phase'] },
  ];
  for (let i = 0; i < 4; i++) {
    nets.push({ name: `addr${i}`, ends: [`sa.o${i}`, `a${i}.d`] });
    nets.push({ name: `din${i}`, ends: [`sd.o${i}`, `d${i}.d`] });
    nets.push({ name: `d${i}`, ends: [`d${i}.q`, `mx${i}.b`], tags: true });
  }
  nets.push({ name: 'a0', ends: ['a0.q', 'ay.i0'] }, { name: 'a1', ends: ['a1.q', 'ay.i1'] }, { name: 'a2', ends: ['a2.q', 'ax.i0'] }, { name: 'a3', ends: ['a3.q', 'ax.i1'] });
  // a line's read wire on bit k of its bus, its write wire on bit 4 + k
  for (const [dec, m, base] of [['yr', 'ym', 0], ['yw', 'ym', N], ['xr', 'xm', 0], ['xw', 'xm', N]] as const) {
    for (let k = 0; k < N; k++) nets.push({ name: `${dec}${k}`, ends: [`${dec}.y${k}`, `${m}.i${base + k}`] });
  }
  // per plane: its inhibit (WRITE, inhibit on and a 0 to write), the plane, the buffer bit's input (sense, or din on a write)
  for (let p = 0; p < PLANES; p++) {
    const y = PY(p);
    instances.push(
      inst(`nb${p}`, NOT, [61, y + 6], `not b${p}`),
      inst(`inh${p}`, AND, [66, y + 4], `inhibit ${p}`),
      inst(`p${p}`, corePlane(planeBits(p)), [PX, y], `plane ${p}`),
      inst(`mx${p}`, MUX2, [92, y + 2], `buffer in ${p}`),
      inst(`buf${p}`, DFFE, [104, y + 3], `buffer ${p}`),
    );
    nets.push(
      { name: `b${p}`, ends: [`buf${p}.q`, `mo.i${p}`, `nb${p}.a`], tags: true },
      { name: `nb${p}`, ends: [`nb${p}.y`, `inh${p}.b`] },
      { name: `inh${p}`, ends: [`inh${p}.y`, `p${p}.inh`] },
      { name: `sense${p}`, ends: [`p${p}.s`, `mx${p}.a`] },
      { name: `nbuf${p}`, ends: [`mx${p}.y`, `buf${p}.d`] },
    );
  }
  instances.push(inst('mo', merger(ones(PLANES), 24), [124, -3]), inst('mp', merger([1, 1], 2), [124, 104]));
  return (any ? (d: ComponentDef) => d : define)({
    id: any ? `core_store16x4_${words.map((w) => (w & 15).toString(16)).join('')}` : 'core_store16x4', name: '16 x 4 core store', category: 'memory',
    summary: 'Sixteen words of four bits in four core planes, Whirlwind\'s scheme in miniature: go starts a cycle, READ empties the addressed word into the buffer register through the sense windings, WRITE puts the buffer back (or din, when we = 1), the inhibit keeping the zeros.',
    ports: [bus('addr', 4, 'in'), bus('din', PLANES, 'in'), bit('we', 'in'), bit('go', 'in'), bit('inhOn', 'in'), bit('clk', 'in', 'bottom', true), bus('dout', PLANES, 'out'), bus('phase', 2, 'out')],
    symbol: { kind: 'box', label: 'CORE 16x4' },
    netlist: () => ({ pins: { addr: [0, 19], din: [0, 61], we: [0, 86], go: [0, 101], inhOn: [0, 120], clk: [0, 126], dout: [132, 45], phase: [132, 106] }, instances, nets }),
  });
});
export const CORE_STORE = coreStore();

/** The store's inputs at a clock edge (inhOn defaults to 1: the inhibit drivers on). */
export interface CoreInputs { addr: number; din: number; we: number; go: number; inhOn?: number }

/** What the store does, clock by clock (the gates are held to it every edge: tests/coremem.test.ts). */
export class CoreModel {
  /** words[a] bit p = the core of word a in plane p (row a >> 2, column a & 3). */
  words = new Uint8Array(WORDS);
  /** Power on with these words in the planes (coreStore(words)). */
  constructor(init: readonly number[] = []) { init.forEach((w, k) => (this.words[k] = w & 15)); }
  rd = 0;
  wr = 0;
  addr = 0;
  din = 0;
  op = 0;
  buf = 0;
  /** A rising clock edge with these inputs (as they were just before it). */
  edge(i: CoreInputs): void {
    const start = !this.rd && !this.wr && i.go ? 1 : 0;
    // the cores switch from the drive of the phase that ends here
    if (this.rd) {
      const read = this.words[this.addr];
      this.words[this.addr] = 0;
      this.buf = this.op ? this.din : read;
    } else if (this.wr) {
      // write halves on every plane; the inhibit holds the planes whose buffer bit is 0 (without it, every bit is set)
      this.words[this.addr] = (i.inhOn ?? 1) ? this.buf : (1 << PLANES) - 1;
    }
    this.wr = this.rd;
    this.rd = start;
    if (start) { this.addr = i.addr; this.din = i.din; this.op = i.we; }
  }
  /** The outputs after the edge. */
  get out(): { dout: number; phase: number } {
    return { dout: this.buf, phase: this.rd | (this.wr << 1) };
  }
}

/** Is this definition a ferrite core (the view paints its bit and drive; memory readers read it)? */
export const isCore = (d: ComponentDef) => d.prim === 'core';
export { CORE_FULL as CORE_SWITCH };
