// Core memory as a circuit (the Memory chapter's "A core plane, wired"; the 3D plane beside it is widgets/core3d.ts). Whirlwind's
// coincident-current scheme (Forrester, US 2,736,880; MIT Report R-221, 1954, section 5) at the level the rest of the book
// is simulated at: gates and flip-flops around one new element, the ferrite core.
//
// CORE (prim 'core'): a bit stored as the direction of a ring's magnetisation. Every wire through it adds its current: the
// read and write enables of its X and Y lines (R-221: one driver per line in each direction), each a half-select, and its
// plane's inhibit, a half the other way. Counted in half-select units, a write half is +1, a read half -1 and the inhibit
// -1. The loop is taken as square: the core switches to 1 when the sum reaches +2 and to 0 at -2, and holds at anything in
// between (a single half, or a write half cancelled by the inhibit). It switches at the clock edge that ends a phase, from
// the drive it saw while the clock was low, as every storage leaf here does; its sense output is 1 during the phase in
// which it is switching (a read of a 1, or a 1 written into a 0: the pulse of the other polarity, which nothing strobes),
// the flux change that induces a pulse in the sense winding. The winding threads every core of a plane in series, so the pulses add: each core passes on what it receives
// (si) and adds its own (so = si OR switching). Exact for the logic, since only one core of a plane is fully selected at
// once; the small pulses of half-selected cores (the noise real sense amplifiers had to reject) are left out, and the
// chapter says so.
//
// CORE_STORE: 16 words of 4 bits in four 4 x 4 digit planes, one per bit. The X and Y selection lines run through all
// four planes, so a whole word is selected at once (R-221 section 5.1's "selection plane"). A cycle is READ then WRITE:
// READ drives the addressed cores toward 0, the planes' sense lines carry the word, and the edge that ends READ is the
// strobe (Whirlwind strobed during the read current) that loads the buffer register; WRITE drives toward 1, with the
// inhibit on in the planes whose buffer bit is 0. A read writes back what it read; a write (we = 1) loads the buffer
// with din instead. go starts a cycle when idle; the address, din and we are taken then.

import type { Behavior, ComponentDef, PortDef } from '../sim/types';
import { Builder } from './builder';
import { decoder } from './combinational';
import { define, merger, ones, splitter } from './define';
import { AND, MUX2, NOR, NOT } from './gates';
import { DFF, DFFE } from './sequential';
import { TIE0 } from './transistors';

const bit = (name: string, dir: 'in' | 'out', side?: PortDef['side'], clock?: boolean): PortDef => ({ name, width: 1, dir, side, ...(clock ? { clock: true } : {}) });
const bus = (name: string, width: number, dir: 'in' | 'out', side?: PortDef['side']): PortDef => ({ name, width, dir, side });

/** A core's private state: its bit (-1 unknown), the clock as last seen, the drive range sampled while the clock was low. */
export interface CoreState { b: number; clk: number; lo: number; hi: number }

export const isCoreState = (s: unknown): s is CoreState => !!s && typeof s === 'object' && typeof (s as CoreState).b === 'number' && typeof (s as CoreState).lo === 'number';

/** The drive that switches a core, in half-select units (one select wire or the inhibit carries one). */
const FULL = 2;

/** The drive on a core as a range (an X input could be on or off): write halves +1, read halves and the inhibit -1. */
export function coreDrive(xr: number, xw: number, yr: number, yw: number, inh: number): { lo: number; hi: number } {
  let lo = 0, hi = 0;
  for (const [v, sign] of [[xw, 1], [yw, 1], [xr, -1], [yr, -1], [inh, -1]] as const) {
    if (v === 1) { lo += sign; hi += sign; }
    else if (v !== 0) { lo += Math.min(0, sign); hi += Math.max(0, sign); }
  }
  return { lo, hi };
}

/** Is a core with bit b switching under this drive: 1 sure, 0 not, -1 maybe (an unknown bit or drive). */
export function coreSwitching(b: number, lo: number, hi: number): number {
  if ((b === 0 && lo >= FULL) || (b === 1 && hi <= -FULL)) return 1;
  const may = (b !== 1 && hi >= FULL) || (b !== 0 && lo <= -FULL);
  return may ? -1 : 0;
}

/** The bit after an edge with this drive (sure: a clean 0 → 1 edge; otherwise anything it could have become is unknown). */
export function coreNext(b: number, lo: number, hi: number, sure: boolean): number {
  if (sure && lo >= FULL) return 1;
  if (sure && hi <= -FULL) return 0;
  let n = b;
  if (hi >= FULL && n !== 1) n = -1;
  if (lo <= -FULL && n !== 0) n = -1;
  return n;
}

const fresh = (mode?: 'x' | 'zero' | 'random'): CoreState => ({ b: mode === 'x' ? -1 : mode === 'random' ? (Math.random() < 0.5 ? 0 : 1) : 0, clk: 0, lo: 0, hi: 0 });

/** The core in Verilog: a flip-flop that a full current sets or clears, and its sense pulse. */
const CORE_SYNTH = [
  "  reg b = 1'b0;  // the ring's magnetisation",
  '  // currents in half-select units: write halves one way, read halves and the inhibit the other',
  "  wire [2:0] up = {2'b0, xw} + {2'b0, yw};",
  "  wire [2:0] down = {2'b0, xr} + {2'b0, yr} + {2'b0, inh};",
  "  wire set = up >= down + 3'd2, clear = down >= up + 3'd2;",
  "  always @(posedge clk) if (set) b <= 1'b1; else if (clear) b <= 1'b0;",
  "  // the sense winding: what the cores before it induced, and this core's pulse while it switches",
  '  assign so = si | (b ? clear : set);',
];

const coreBehavior: Behavior = {
  init: fresh,
  seq: { clk: 'clk', comb: ['xr', 'xw', 'yr', 'yw', 'inh', 'si'] },
  eval: ([xr, xw, yr, yw, inh, si, clk], st) => {
    const s = st as CoreState;
    const { lo, hi } = coreDrive(xr, xw, yr, yw, inh);
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
  ports: [bit('xr', 'in'), bit('xw', 'in'), bit('yr', 'in', 'top'), bit('yw', 'in', 'top'), bit('inh', 'in'), bit('si', 'in'), bit('clk', 'in', 'bottom', true), bit('so', 'out')],
  symbol: { kind: 'box', label: 'CORE' },
  behavior: coreBehavior,
  hdl: {
    synth: CORE_SYNTH,
    verilog: CORE_SYNTH.join('\n'),
  },
});

/** Rows, columns and planes of the store; a word is one core per plane. */
const N = 4, PLANES = 4, WORDS = N * N;
export const CORE_WORDS = WORDS, CORE_PLANES = PLANES;

/** The order the sense winding threads a plane's cores: row by row, back and forth (index r * N + c). */
export const CORE_SENSE_ORDER: readonly number[] = Array.from({ length: N }, (_, r) => Array.from({ length: N }, (_, k) => r * N + (r % 2 ? N - 1 - k : k))).flat();

/** A 4 x 4 plane of cores: X lines by row, Y lines by column, one inhibit and one sense winding through all sixteen. */
export const CORE_PLANE: ComponentDef = (() => {
  const b = new Builder(10, 16, 9);
  b.pins('xr', 'xw', 'yr', 'yw', 'inh', 'clk');
  const sx = b.op(splitter(ones(N), 3), ['xr']), sxw = b.op(splitter(ones(N), 3), ['xw']);
  const sy = b.op(splitter(ones(N), 3), ['yr']), syw = b.op(splitter(ones(N), 3), ['yw']);
  const z = b.op1(TIE0, []);
  const name = (k: number) => `c${Math.floor(k / N)}${k % N}`;
  let si = z;
  // a column per row of the plane, cores in winding order so the sense chain runs down each column
  CORE_SENSE_ORDER.forEach((k, i) => {
    if (i % N === 0) b.next();
    const r = Math.floor(k / N), c = k % N;
    si = `${b.op(CORE, [`${sx}.o${r}`, `${sxw}.o${r}`, `${sy}.o${c}`, `${syw}.o${c}`, 'inh', si, 'clk'], `row ${r} col ${c}`, name(k))}.so`;
  });
  b.wire(si, 's');
  const R = b.right + 6;
  return define({
    id: 'core_plane4', name: '4 x 4 core plane', category: 'memory',
    summary: 'Sixteen cores on a grid: an X line through each row and a Y line through each column (each with a read and a write driver), one inhibit wire and one sense winding through all sixteen. Only the core where a driven X and a driven Y cross sees a full current.',
    ports: [bus('xr', N, 'in'), bus('xw', N, 'in'), bus('yr', N, 'in'), bus('yw', N, 'in'), bit('inh', 'in'), bit('clk', 'in', 'bottom', true), bit('s', 'out')],
    symbol: { kind: 'box', label: 'PLANE' },
    netlist: () => ({ pins: { xr: [0, 4], xw: [0, 8], yr: [0, 12], yw: [0, 16], inh: [0, 20], clk: [0, 24], s: [R, 4] }, instances: b.instances, nets: b.nets() }),
  });
})();

/**
 * The store: address, data and op registers taken at go; the phase register (READ, then WRITE); X and Y decoders with
 * a read and a write driver per line; an inhibit driver and a buffer bit per plane; four planes.
 */
export const CORE_STORE: ComponentDef = (() => {
  const b = new Builder(16, 14, 5);
  b.pins('addr', 'din', 'we', 'go', 'clk');
  // phase register: idle = neither; READ follows go when idle, WRITE follows READ
  const idle = b.name(b.op1(NOR, ['rd.q', 'wr.q'], 'idle'), 'idle', true);
  const start = b.name(b.op1(AND, [idle, 'go'], 'start'), 'start', true);
  b.next();
  b.op(DFF, [start, 'clk'], 'READ', 'rd');
  b.op(DFF, ['rd.q', 'clk'], 'WRITE', 'wr');
  b.name('rd.q', 'READ', true);
  b.name('wr.q', 'WRITE', true);
  // address, data and op taken at the start
  const sa = b.op(splitter(ones(4), 3), ['addr']), sd = b.op(splitter(ones(PLANES), 3), ['din']);
  b.next();
  const a = Array.from({ length: 4 }, (_, i) => `${b.op(DFFE, [`${sa}.o${i}`, start, 'clk'], `a${i}`, `a${i}`)}.q`);
  const d = Array.from({ length: PLANES }, (_, i) => `${b.op(DFFE, [`${sd}.o${i}`, start, 'clk'], `d${i}`, `d${i}`)}.q`);
  const op = b.name(`${b.op(DFFE, ['we', start, 'clk'], 'we', 'op')}.q`, 'op', true);
  b.next();
  // address bits 3:2 pick the row (X), 1:0 the column (Y)
  const ax = b.op1(merger([1, 1], 2), [a[2], a[3]]), ay = b.op1(merger([1, 1], 2), [a[0], a[1]]);
  b.next();
  const lines = (sel: string, en: string, label: string, n: string): string => {
    const dec = b.op(decoder(2, true), [sel, en], label);
    return b.name(b.op1(merger(ones(N), 3), Array.from({ length: N }, (_, k) => `${dec}.y${k}`)), n, true);
  };
  const xr = lines(ax, 'rd.q', 'X read', 'xr'), xw = lines(ax, 'wr.q', 'X write', 'xw');
  const yr = lines(ay, 'rd.q', 'Y read', 'yr'), yw = lines(ay, 'wr.q', 'Y write', 'yw');
  b.next();
  // per plane: its inhibit (WRITE and a 0 to write), its plane, its buffer bit (loaded at the edge that ends READ)
  const q: string[] = [];
  for (let p = 0; p < PLANES; p++) {
    const zero = b.op1(NOT, [`buf${p}.q`], `not b${p}`);
    const inh = b.name(b.op1(AND, ['wr.q', zero], `inhibit ${p}`), `inh${p}`, true);
    const s = b.name(`${b.op(CORE_PLANE, [xr, xw, yr, yw, inh, 'clk'], `plane ${p}`, `p${p}`)}.s`, `sense${p}`, true);
    const nb = b.op1(MUX2, [s, d[p], op], `buffer in ${p}`);
    q.push(`${b.op(DFFE, [nb, 'rd.q', 'clk'], `buffer ${p}`, `buf${p}`)}.q`);
  }
  b.next();
  b.wire(b.op1(merger(ones(PLANES), 3), q), 'dout');
  b.wire(b.op1(merger([1, 1], 2), ['rd.q', 'wr.q']), 'phase');
  const R = b.right + 6;
  return define({
    id: 'core_store16x4', name: '16 x 4 core store', category: 'memory',
    summary: 'Sixteen words of four bits in four core planes, Whirlwind\'s scheme in miniature: go starts a cycle, READ empties the addressed word into the buffer register through the sense windings, WRITE puts the buffer back (or din, when we = 1), the inhibit keeping the zeros.',
    ports: [bus('addr', 4, 'in'), bus('din', PLANES, 'in'), bit('we', 'in'), bit('go', 'in'), bit('clk', 'in', 'bottom', true), bus('dout', PLANES, 'out'), bus('phase', 2, 'out')],
    symbol: { kind: 'box', label: 'CORE 16x4' },
    netlist: () => ({ pins: { addr: [0, 4], din: [0, 8], we: [0, 12], go: [0, 16], clk: [0, 20], dout: [R, 4], phase: [R, 8] }, instances: b.instances, nets: b.nets() }),
  });
})();

/** What the store does, clock by clock (the gates are held to it every edge: tests/coremem.test.ts). */
export class CoreModel {
  /** words[a] bit p = the core of word a in plane p (row a >> 2, column a & 3). */
  words = new Uint8Array(WORDS);
  rd = 0;
  wr = 0;
  addr = 0;
  din = 0;
  op = 0;
  buf = 0;
  /** A rising clock edge with these inputs (as they were just before it). */
  edge(i: { addr: number; din: number; we: number; go: number }): void {
    const start = !this.rd && !this.wr && i.go ? 1 : 0;
    // the cores switch from the drive of the phase that ends here
    if (this.rd) {
      const read = this.words[this.addr];
      this.words[this.addr] = 0;
      this.buf = this.op ? this.din : read;
    } else if (this.wr) {
      // write halves on every plane; the inhibit holds the planes whose buffer bit is 0, so the word becomes the buffer
      this.words[this.addr] = this.buf;
    }
    this.wr = this.rd;
    this.rd = start;
    if (start) { this.addr = i.addr; this.din = i.din; this.op = i.we; }
  }
  /** The outputs after the edge, and each plane's sense line now (READ: the word's bits, before the cores switch). */
  get out(): { dout: number; phase: number; sense: number } {
    return { dout: this.buf, phase: this.rd | (this.wr << 1), sense: this.rd ? this.words[this.addr] : this.wr ? ~this.words[this.addr] & this.buf & 0xf : 0 };
  }
}
