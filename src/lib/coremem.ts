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
import { Builder } from './builder';
import { decoder } from './combinational';
import { define, merger, ones, splitter } from './define';
import { AND, MUX2, NOR, NOT } from './gates';
import { DFF, DFFE } from './sequential';
import { TIE0 } from './transistors';

export { CORE_FULL, coreDrive, coreNext, coreSwitching, type CoreState, isCoreState };

const bit = (name: string, dir: 'in' | 'out', side?: PortDef['side'], clock?: boolean): PortDef => ({ name, width: 1, dir, side, ...(clock ? { clock: true } : {}) });
const bus = (name: string, width: number, dir: 'in' | 'out', side?: PortDef['side']): PortDef => ({ name, width, dir, side });

const fresh = (mode?: 'x' | 'zero' | 'random'): CoreState => ({ b: mode === 'x' ? -1 : mode === 'random' ? (Math.random() < 0.5 ? 0 : 1) : 0, clk: 0, lo: 0, hi: 0 });

/** The core in Verilog: a flip-flop that a full current sets or clears, and its sense pulse. x, y: bit 0 read, bit 1 write. */
const CORE_SYNTH = [
  "  reg b = 1'b0;  // the ring's magnetisation",
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
  behavior: coreBehavior,
  hdl: { synth: CORE_SYNTH, verilog: CORE_SYNTH.join('\n') },
});

/** Rows, columns and planes of the store; a word is one core per plane. */
const N = 4, PLANES = 4, WORDS = N * N;
export const CORE_WORDS = WORDS, CORE_PLANES = PLANES;

/** The plane's grid: the first core's corner and the pitch between cores (grid units). */
const X0 = 16, Y0 = 14, P = 10;
/** A core's instance name in a plane: c<row><column>. */
export const coreName = (r: number, c: number) => `c${r}${c}`;

/**
 * A 4 x 4 plane of cores: an X line along each row and a Y line down each column (each line two wires, its read and write
 * drivers: x and y carry them in pairs, row r on bits 2r, 2r + 1), one inhibit wire and one sense winding through all
 * sixteen, row by row. Only the core where a driven X and a driven Y cross sees a full current.
 */
export const CORE_PLANE: ComponentDef = (() => {
  const instances: InstanceDef[] = [
    { name: 'sx', def: splitter(ones(N).map(() => 2), P), at: [4, Y0 - 7] },
    { name: 'sy', def: splitter(ones(N).map(() => 2), P), at: [X0 - 8, Y0 - 6], flip: true, rot: 3 },
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
    for (let c = 0; c < N; c++) instances.push({ name: coreName(r, c), def: CORE, at: [X0 + P * c, Y0 + P * r] });
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
  return define({
    id: 'core_plane4', name: '4 x 4 core plane', category: 'memory',
    summary: 'Sixteen cores on a grid: an X line along each row and a Y line down each column (each with a read and a write driver), one inhibit wire and one sense winding through all sixteen. Only the core where a driven X and a driven Y cross sees a full current.',
    ports: [bus('x', 2 * N, 'in'), bus('y', 2 * N, 'in'), bit('inh', 'in'), bit('clk', 'in', 'bottom', true), bit('s', 'out')],
    symbol: { kind: 'box', label: 'PLANE' },
    netlist: () => ({
      pins: { x: [0, Y0 + 13], y: [0, Y0 - 10], inh: [0, Y0 + P * N + 2], clk: [0, Y0 + P * N + 5], s: [R, Y0 + P * (N - 1) + 3] },
      instances, nets,
    }),
  });
})();

/**
 * The store: address, data and op registers taken at go; the phase register (READ, then WRITE); X and Y decoders with
 * a read and a write driver per line; an inhibit driver and a buffer bit per plane; four planes.
 */
export const CORE_STORE: ComponentDef = (() => {
  const b = new Builder(16, 14, 5);
  b.pins('addr', 'din', 'we', 'go', 'inhOn', 'clk');
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
  // a line's read and write drivers side by side on its pair of wires: line k on bits 2k (read), 2k + 1 (write)
  const lines = (sel: string, axis: string): string => {
    const r = b.op(decoder(2, true), [sel, 'rd.q'], `${axis} read`, `${axis.toLowerCase()}r`);
    const w = b.op(decoder(2, true), [sel, 'wr.q'], `${axis} write`, `${axis.toLowerCase()}w`);
    return b.name(b.op1(merger(ones(2 * N), 2), Array.from({ length: 2 * N }, (_, k) => `${k & 1 ? w : r}.y${k >> 1}`)), axis.toLowerCase(), true);
  };
  const x = lines(ax, 'X'), y = lines(ay, 'Y');
  b.next();
  const inhOn = b.name(b.op1(AND, ['wr.q', 'inhOn'], 'inhibit on'), 'inhW', true);
  b.next();
  // per plane: its inhibit (WRITE and a 0 to write), its plane, its buffer bit (loaded at the edge that ends READ)
  const q: string[] = [];
  for (let p = 0; p < PLANES; p++) {
    const zero = b.op1(NOT, [`buf${p}.q`], `not b${p}`);
    const inh = b.name(b.op1(AND, [inhOn, zero], `inhibit ${p}`, `inh${p}`), `inh${p}`, true);
    const s = b.name(`${b.op(CORE_PLANE, [x, y, inh, 'clk'], `plane ${p}`, `p${p}`)}.s`, `sense${p}`, true);
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
    ports: [bus('addr', 4, 'in'), bus('din', PLANES, 'in'), bit('we', 'in'), bit('go', 'in'), bit('inhOn', 'in'), bit('clk', 'in', 'bottom', true), bus('dout', PLANES, 'out'), bus('phase', 2, 'out')],
    symbol: { kind: 'box', label: 'CORE 16x4' },
    netlist: () => ({ pins: { addr: [0, 4], din: [0, 8], we: [0, 12], go: [0, 16], inhOn: [0, 20], clk: [0, 24], dout: [R, 4], phase: [R, 8] }, instances: b.instances, nets: b.nets() }),
  });
})();

/** The store's inputs at a clock edge (inhOn defaults to 1: the inhibit drivers on). */
export interface CoreInputs { addr: number; din: number; we: number; go: number; inhOn?: number }

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
