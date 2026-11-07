// Storage structures beyond the RAM: a ROM (decoder + OR plane), a PLA (AND plane + OR plane, its
// product terms found by Quine–McCluskey), a FIFO, a stack, a content-addressable memory and a
// register file with more ports.

import type { ComponentDef, InstanceDef, NetDef, PortDef } from '../sim/types';
import { constWord, isZero } from './alu';
import { Builder } from './builder';
import { addSub, andN, busMux2, decoder, equal, incrementer } from './combinational';
import { priorityEncoder } from './coding';
import { define, merger, ones, splitter } from './define';
import { AND, NOT, OR, XOR } from './gates';
import { readPort } from './regfile';
import { register } from './sequential';
import { TIE0, TIE1 } from './transistors';
import { orN } from './wide';

const bit = (name: string, dir: 'in' | 'out', side?: PortDef['side'], clock?: boolean): PortDef => ({ name, width: 1, dir, side, clock });
const bus = (name: string, width: number, dir: 'in' | 'out', side?: PortDef['side']): PortDef => ({ name, width, dir, side });
const clock = () => bit('clk', 'in', 'bottom', true);

const cache = new Map<string, ComponentDef>();
function memo(key: string, f: () => ComponentDef): ComponentDef {
  let d = cache.get(key);
  if (!d) cache.set(key, (d = f()));
  return d;
}
const orOf = (b: Builder, drivers: string[], label?: string): string =>
  drivers.length === 0 ? b.op1(TIE0, []) : drivers.length === 1 ? drivers[0] : b.op1(drivers.length === 2 ? OR : orN(drivers.length), drivers, label);
const andOf = (b: Builder, drivers: string[], label?: string): string =>
  drivers.length === 0 ? b.op1(TIE1, []) : drivers.length === 1 ? drivers[0] : b.op1(drivers.length === 2 ? AND : andN(drivers.length), drivers, label);

// ---- tables ---------------------------------------------------------------------------------------------

/** Segments a–g (bits 0–6) lit for the hex digits 0–F. */
export const SEVEN_SEG = [0x3f, 0x06, 0x5b, 0x4f, 0x66, 0x6d, 0x7d, 0x07, 0x7f, 0x6f, 0x77, 0x7c, 0x39, 0x5e, 0x79, 0x71];

export interface RomPreset { k: number; w: number; name: string; data: number[] }
export const ROM_PRESETS: Record<string, RomPreset> = {
  squares: { k: 4, w: 8, name: 'squares (n²)', data: Array.from({ length: 16 }, (_, i) => i * i) },
  seg7: { k: 4, w: 7, name: '7-segment font', data: SEVEN_SEG },
  sine: { k: 5, w: 8, name: 'sine table', data: Array.from({ length: 32 }, (_, i) => Math.round(127.5 + 127.5 * Math.sin((2 * Math.PI * i) / 32))) },
};

// ---- ROM --------------------------------------------------------------------------------------------------

/**
 * Read-only memory as it was first built: a decoder raises one word line, and each output bit ORs the
 * word lines of the words where that bit is 1. The contents are the wiring (a "diode matrix").
 */
export function romArray(preset: keyof typeof ROM_PRESETS): ComponentDef {
  const P = ROM_PRESETS[preset];
  return memo(`rom_${preset}`, () => {
    const b = new Builder(10, 14);
    b.pins('addr');
    const dec = b.op(decoder(P.k), ['addr'], 'word lines');
    b.next();
    const bits = Array.from({ length: P.w }, (_, j) => orOf(b, P.data.map((v, i) => ((v >> j) & 1 ? `${dec}.y${i}` : '')).filter(Boolean), `bit ${j}`));
    b.next();
    b.wire(b.op1(merger(ones(P.w)), bits), 'data');
    const R = b.right;
    return define({
      id: `rom_${preset}`, name: `ROM: ${P.name}`, category: 'memory',
      summary: `${2 ** P.k} words × ${P.w} bits. A ${P.k}→${2 ** P.k} decoder raises one word line; output bit j is the OR of the word lines whose word has bit j set. Changing the contents means rewiring the OR plane: mask ROMs were set by the last metal layer.`,
      ports: [bus('addr', P.k, 'in'), bus('data', P.w, 'out')],
      symbol: { kind: 'box', label: 'ROM' },
      spec: ([a]) => [P.data[a]],
      netlist: () => ({ pins: { addr: [0, 6], data: [R, 6] }, instances: b.instances, nets: b.nets() }),
      hdl: { verilog: `always_comb case (addr)\n${P.data.map((v, i) => `  ${P.k}'d${i}: data = ${P.w}'h${v.toString(16)};`).join('\n')}\nendcase` },
    });
  });
}

// ---- PLA ---------------------------------------------------------------------------------------------------

/** A product term: bits in `mask` are don't-care, the others must equal `val`. */
export interface Cube { val: number; mask: number }

/** Quine–McCluskey: the prime implicants of a function given by its minterms, then a greedy cover. */
export function minimize(minterms: number[]): Cube[] {
  if (!minterms.length) return [];
  let cubes: Cube[] = minterms.map((m) => ({ val: m, mask: 0 }));
  const primes: Cube[] = [];
  const key = (c: Cube) => `${c.val}/${c.mask}`;
  while (cubes.length) {
    const used = new Set<string>(), next = new Map<string, Cube>();
    for (let i = 0; i < cubes.length; i++) for (let j = i + 1; j < cubes.length; j++) {
      const a = cubes[i], c = cubes[j];
      const diff = a.val ^ c.val;
      if (a.mask === c.mask && diff && !(diff & (diff - 1))) {
        const m: Cube = { val: a.val & ~diff, mask: a.mask | diff };
        next.set(key(m), m);
        used.add(key(a)).add(key(c));
      }
    }
    for (const c of cubes) if (!used.has(key(c)) && !primes.some((p) => key(p) === key(c))) primes.push(c);
    cubes = [...next.values()];
  }
  const covers = (c: Cube, m: number) => (m & ~c.mask) === c.val;
  const left = new Set(minterms), chosen: Cube[] = [];
  while (left.size) {
    // essential first (a minterm covered by one prime only), otherwise the prime covering the most
    let pick: Cube | undefined;
    for (const m of left) {
      const by = primes.filter((p) => covers(p, m));
      if (by.length === 1) { pick = by[0]; break; }
    }
    pick ??= primes.reduce((best, p) => ([...left].filter((m) => covers(p, m)).length > [...left].filter((m) => covers(best, m)).length ? p : best));
    chosen.push(pick);
    for (const m of [...left]) if (covers(pick, m)) left.delete(m);
  }
  return chosen;
}

export interface PlaPreset { n: number; m: number; name: string; ins: string; f: (x: number) => number }
export const PLA_PRESETS: Record<string, PlaPreset> = {
  fa: { n: 3, m: 2, name: 'full adder', ins: 'cin, b, a', f: (x) => { const s = (x & 1) + ((x >> 1) & 1) + ((x >> 2) & 1); return (s & 1) | ((s >> 1) << 1); } },
  seg7: { n: 4, m: 7, name: '7-segment decoder', ins: 'hex digit', f: (x) => SEVEN_SEG[x] },
};

/** Product terms of every output of a preset, shared between outputs when equal. */
export function plaTerms(p: PlaPreset): { terms: Cube[]; uses: number[][] } {
  const terms: Cube[] = [], uses: number[][] = [];
  for (let j = 0; j < p.m; j++) {
    const mins = Array.from({ length: 2 ** p.n }, (_, x) => x).filter((x) => (p.f(x) >> j) & 1);
    uses.push(minimize(mins).map((c) => {
      let t = terms.findIndex((u) => u.val === c.val && u.mask === c.mask);
      if (t < 0) t = terms.push(c) - 1;
      return t;
    }));
  }
  return { terms, uses };
}

/**
 * Programmable logic array: true and complement rails for each input, an AND plane making the product
 * terms (found by Quine–McCluskey and shared between outputs), an OR plane summing them per output.
 */
export function pla(preset: keyof typeof PLA_PRESETS): ComponentDef {
  const P = PLA_PRESETS[preset];
  return memo(`pla_${preset}`, () => {
    const { terms, uses } = plaTerms(P);
    const b = new Builder(10, 14);
    b.pins('x');
    const sx = b.op(splitter(ones(P.n)), ['x']);
    b.next();
    const neg = Array.from({ length: P.n }, (_, i) => b.name(b.op1(NOT, [`${sx}.o${i}`]), `x${i}′`, true));
    for (let i = 0; i < P.n; i++) b.name(`${sx}.o${i}`, `x${i}`, true);
    b.next();
    const lit = (t: Cube) => Array.from({ length: P.n }, (_, i) => i).filter((i) => !((t.mask >> i) & 1)).map((i) => ((t.val >> i) & 1 ? `${sx}.o${i}` : neg[i]));
    const tOut = terms.map((t, k) => andOf(b, lit(t), `term ${k}`));
    b.next();
    const outs = uses.map((u, j) => orOf(b, u.map((k) => tOut[k]), `out ${j}`));
    b.next();
    b.wire(b.op1(merger(ones(P.m)), outs), 'y');
    const R = b.right;
    return define({
      id: `pla_${preset}`, name: `PLA: ${P.name}`, category: 'gate',
      summary: `${P.n} inputs, ${terms.length} product terms, ${P.m} outputs. The AND plane builds each term from the true and complemented input rails; the OR plane sums the terms each output needs. A ROM decodes all ${2 ** P.n} input combinations; the PLA builds only the terms the outputs use, each from just the literals it needs.`,
      ports: [bus('x', P.n, 'in'), bus('y', P.m, 'out')],
      symbol: { kind: 'box', label: 'PLA' },
      spec: ([x]) => [P.f(x)],
      netlist: () => ({ pins: { x: [0, 6], y: [R, 6] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

// ---- FIFO and stack -------------------------------------------------------------------------------------------

/**
 * First-in first-out queue of 2^k words: a register per word, a write pointer that a decoder turns into
 * one write enable, a read pointer that steers a multiplexer. The pointers have one extra bit: equal
 * pointers mean empty, equal addresses with different extra bits mean full.
 */
export function fifo(k: number, w: number): ComponentDef {
  const N = 2 ** k;
  return memo(`fifo${N}x${w}`, () => {
    // Drawn by hand: the write pointer (its gate, register and +1 loop) at the decoder's height, the comparators under
    // it, the read pointer under them; the words in a column whose rows the decoder's outputs and the merger's inputs
    // meet straight (pitch P), the read port to their right with the read address coming up into its select. full
    // and empty go back to the gates on the left as pointers: feedback across the whole level.
    const P = 10, H = 5 * N; // decoder.a sits at 8 + H - 8, its rows at 10 + P·i
    // write pointer at the decoder's address, read pointer under it, the comparators under the words beside full / empty
    const Wy = H, Ry = H + 30, Bot = 10 * N + 8, X = 12;
    const R = 104;
    const instances: InstanceDef[] = [
      // write pointer
      { name: 'nf', def: NOT, at: [6, Wy + 1] },
      { name: 'wr', def: AND, at: [10, Wy - 1], label: 'push if not full' },
      { name: 'wp', def: register(k + 1), at: [18, Wy - 3], label: 'write pointer' },
      { name: 'wi', def: incrementer(k + 1), at: [28, Wy - 3], label: '+1' },
      { name: 'sw', def: splitter([k, 1], 4), at: [40, Wy - 4] },
      { name: 'dec', def: decoder(k, true, P), at: [46 + X, 8], label: 'which word' },
      // read pointer
      { name: 'ne', def: NOT, at: [6, Ry + 1] },
      { name: 'rd', def: AND, at: [10, Ry - 1], label: 'pop if not empty' },
      { name: 'rp', def: register(k + 1), at: [18, Ry - 3], label: 'read pointer' },
      { name: 'ri', def: incrementer(k + 1), at: [28, Ry - 3], label: '+1' },
      { name: 'sr', def: splitter([k, 1], 4), at: [40, Ry - 4] },
      // the words, the merger and the read port
      ...Array.from({ length: N }, (_, i): InstanceDef => ({ name: `word${i}`, def: register(w), at: [60 + X, 6 + P * i], label: `word ${i}` })),
      { name: 'all', def: merger(Array(N).fill(w), P), at: [72 + X, 4] },
      { name: 'rdp', def: readPort(k, w), at: [76 + X, 2 + H], label: 'oldest word' },
      // comparators, their outputs straight to full and empty
      { name: 'same', def: equal(k), at: [43, Wy + 6], label: 'same slot' },
      { name: 'lap', def: XOR, at: [43, Wy + 14], label: 'a lap apart' },
      { name: 'fl', def: AND, at: [51, Wy + 10], label: 'full' },
      { name: 'emp', def: equal(k + 1), at: [29, Wy + 12], label: 'empty' },
    ];
    const loop = (y: number): [number, number][] => [[37, y - 1], [37, y - 5], [16, y - 5], [16, y - 1]];
    const nets: NetDef[] = [
      { name: 'push', ends: ['push', 'wr.a'] }, { name: 'pop', ends: ['pop', 'rd.a'] },
      { name: 'not full', ends: ['nf.y', 'wr.b'] }, { name: 'not empty', ends: ['ne.y', 'rd.b'] },
      { name: 'write', ends: ['wr.y', 'wp.en', 'dec.en'], via: { 'dec.en': [[15, Wy + 1], [15, Wy - 7], [57, Wy - 7], [57, Wy + 10]] } },
      { name: 'read', ends: ['rd.y', 'rp.en'] },
      // the comparators read the pointers by name (pointers): their taps would cross both pointer loops
      { name: 'wp', ends: ['wp.q', 'wi.a', 'sw.in', 'emp.a'], via: { 'sw.in': [[27, Wy + 6], [39, Wy + 6], [39, Wy]] } },
      { name: 'rp', ends: ['rp.q', 'ri.a', 'sr.in', 'emp.b'], via: { 'sr.in': [[27, Ry + 6], [39, Ry + 6], [39, Ry]] } },
      { name: 'wp+1', ends: ['wi.y', 'wp.d'], via: { 'wp.d': loop(Wy) } },
      { name: 'rp+1', ends: ['ri.y', 'rp.d'], via: { 'rp.d': loop(Ry) } },
      { name: 'waddr', ends: ['sw.o0', 'dec.a', 'same.a'] },
      { name: 'raddr', ends: ['sr.o0', 'rdp.sel', 'same.b'], via: { 'rdp.sel': [[43, Ry - 2], [43, Bot], [81 + X, Bot]] } },
      { name: 'wlap', ends: ['sw.o1', 'lap.a'] },
      { name: 'rlap', ends: ['sr.o1', 'lap.b'] },
      { name: 'same', ends: ['same.eq', 'fl.a'] }, { name: 'lapped', ends: ['lap.y', 'fl.b'] },
      { name: 'full', ends: ['fl.y', 'full', 'nf.a'], tags: ['nf.a'], via: { full: [[56, Wy + 12], [56, Bot + 4]] } },
      { name: 'empty', ends: ['emp.eq', 'empty', 'ne.a'], tags: ['ne.a'] },
      { name: 'din', ends: ['din', ...Array.from({ length: N }, (_, i) => `word${i}.d`)], trunk: 58 + X },
      { name: 'clk', ends: ['clk', 'wp.clk', 'rp.clk', ...Array.from({ length: N }, (_, i) => `word${i}.clk`)], tags: true },
      ...Array.from({ length: N }, (_, i): NetDef => ({ name: `we${i}`, ends: [`dec.y${i}`, `word${i}.en`] })),
      ...Array.from({ length: N }, (_, i): NetDef => ({ name: `word ${i}`, ends: [`word${i}.q`, `all.i${i}`] })),
      { name: 'words', ends: ['all.out', 'rdp.words'] },
      { name: 'dout', ends: ['rdp.y', 'dout'] },
    ];
    return define({
      id: `fifo${N}x${w}`, name: `${N}-word FIFO (${w}-bit)`, category: 'memory',
      summary: `A circular buffer of ${N} words. push writes din at the write pointer and advances it; pop advances the read pointer, and dout always shows the oldest word. ${k + 1}-bit pointers: equal means empty; same slot but one lap apart means full. Push when full and pop when empty are ignored.`,
      ports: [bit('push', 'in'), bit('pop', 'in'), bus('din', w, 'in'), clock(), bus('dout', w, 'out'), bit('empty', 'out'), bit('full', 'out')],
      symbol: { kind: 'box', label: 'FIFO' },
      netlist: () => ({
        pins: { din: [0, 2], push: [0, Wy], pop: [0, Ry], clk: [0, Ry + 10], dout: [R, 4 + H], full: [R, Bot + 4], empty: [R, Bot + 8] },
        instances, nets,
      }),
      hdl: {
        verilog: `wire write = push & ~full, read = pop & ~empty;
assign empty = wp == rp;
assign full  = wp[K-1:0] == rp[K-1:0] && wp[K] != rp[K];
assign dout  = mem[rp[K-1:0]];
always_ff @(posedge clk) begin
  if (write) begin mem[wp[K-1:0]] <= din; wp <= wp + 1; end
  if (read)  rp <= rp + 1;
end`,
      },
    });
  });
}

/** Last-in first-out stack of 2^k words: a stack pointer counts up on push and down on pop. */
export function stack(k: number, w: number): ComponentDef {
  const N = 2 ** k;
  return memo(`stack${N}x${w}`, () => {
    const b = new Builder(12, 12);
    b.pins('push', 'pop', 'din', 'clk');
    // full / empty come from instances further right ('spl' and 'ez'); the builder wires by name
    const fullN = b.op1(NOT, ['spl.o1']), emptyN = b.op1(NOT, ['ez.z']), pushN = b.op1(NOT, ['push']);
    const wr = b.name(b.op1(AND, ['push', fullN], 'push if not full'), 'write', true);
    const rdA = b.op1(AND, ['pop', emptyN]);
    const rd = b.name(b.op1(AND, [rdA, pushN], 'pop if not empty'), 'read', true);
    const go = b.name(b.op1(OR, [wr, rd], 'move sp'), 'move', true);
    b.next();
    const sp = b.op(register(k + 1), ['spm.y', go, 'clk'], 'stack pointer', 'sp');
    b.name(`${sp}.q`, 'sp', true);
    b.next();
    const inc = b.op(incrementer(k + 1), [`${sp}.q`], 'sp + 1');
    const dec = b.op(addSub(k + 1), [`${sp}.q`, b.op1(constWord(k + 1, 1), []), b.op1(TIE1, [])], 'sp − 1');
    b.name(`${dec}.s`, 'sp−1', true);
    b.next();
    b.op(busMux2(k + 1), [`${dec}.s`, `${inc}.y`, wr], 'push or pop', 'spm');
    const s1 = b.op(splitter([k, 1]), [`${sp}.q`], undefined, 'spl');
    const s2 = b.op(splitter([k, 1]), [`${dec}.s`]);
    b.name(b.op1(isZero(k + 1), [`${sp}.q`], 'empty', 'ez'), 'empty', true);
    b.name(`${s1}.o1`, 'full', true);
    b.next();
    const decw = b.op(decoder(k, true), [`${s1}.o0`, wr], 'write slot sp');
    b.next();
    const words = Array.from({ length: N }, (_, i) => b.op1(register(w), ['din', `${decw}.y${i}`, 'clk'], `word ${i}`));
    b.next();
    const all = b.op1(merger(Array(N).fill(w)), words);
    b.next();
    b.wire(b.op1(readPort(k, w), [all, `${s2}.o0`], 'slot sp − 1'), 'top');
    b.wire('ez.z', 'empty');
    b.wire(`${s1}.o1`, 'full');
    const R = b.right;
    return define({
      id: `stack${N}x${w}`, name: `${N}-word stack (${w}-bit)`, category: 'memory',
      summary: `The stack pointer sp counts the words held. push writes din to slot sp and increments; pop decrements; top shows slot sp − 1. empty when sp = 0, full when sp = ${N}. A push and a pop together count as a push.`,
      ports: [bit('push', 'in'), bit('pop', 'in'), bus('din', w, 'in'), clock(), bus('top', w, 'out'), bit('empty', 'out'), bit('full', 'out')],
      symbol: { kind: 'box', label: 'STACK' },
      netlist: () => ({ pins: { push: [0, 2], pop: [0, 6], din: [0, 10], clk: [0, 14], top: [R, 4], empty: [R, 8], full: [R, 12] }, instances: b.instances, nets: b.nets() }),
      hdl: {
        verilog: `wire write = push & ~full, read = pop & ~empty & ~push;
assign empty = sp == 0;
assign full  = sp[K];
assign top   = mem[sp[K-1:0] - 1];
always_ff @(posedge clk)
  if (write) begin mem[sp[K-1:0]] <= din; sp <= sp + 1; end
  else if (read) sp <= sp - 1;`,
      },
    });
  });
}

// ---- CAM and a multi-ported register file ---------------------------------------------------------------------

/**
 * Content-addressable memory: instead of an address, give a key; every entry compares it at once, and a
 * priority encoder reports which entry matched. One comparator per entry: the cost of a TLB or a fully
 * associative cache.
 */
export function cam(k: number, w: number): ComponentDef {
  const N = 2 ** k;
  return memo(`cam${N}x${w}`, () => {
    const b = new Builder(12, 12);
    b.pins('we', 'waddr', 'wdata', 'key', 'clk');
    const dec = b.op(decoder(k, true), ['waddr', 'we'], 'write which entry');
    const one = b.op1(TIE1, []);
    b.next();
    const ent = Array.from({ length: N }, (_, i) => ({
      q: b.op1(register(w), ['wdata', `${dec}.y${i}`, 'clk'], `entry ${i}`),
      v: b.op1(register(1), [one, `${dec}.y${i}`, 'clk'], `valid ${i}`),
    }));
    b.next();
    const eqs = ent.map((e, i) => b.op1(equal(w), [e.q, 'key'], `= key? ${i}`));
    b.next();
    const hits = ent.map((e, i) => b.op1(AND, [eqs[i], e.v]));
    b.next();
    const pe = b.op(priorityEncoder(N), [b.op1(merger(ones(N)), hits, 'matches')], 'which matched');
    b.next();
    b.wire(`${pe}.v`, 'hit');
    b.wire(`${pe}.y`, 'index');
    const R = b.right;
    return define({
      id: `cam${N}x${w}`, name: `${N}-entry CAM (${w}-bit keys)`, category: 'memory',
      summary: `${N} entries written by address (we, waddr, wdata) and searched by content: each entry has its own ${w}-bit comparator, all comparing with key in parallel; a priority encoder turns the matches into hit and index. Search costs one comparator per entry, which is why CAMs stay small (TLBs, fully associative caches, network routers).`,
      ports: [bit('we', 'in'), bus('waddr', k, 'in'), bus('wdata', w, 'in'), bus('key', w, 'in'), clock(), bit('hit', 'out'), bus('index', k, 'out')],
      symbol: { kind: 'box', label: 'CAM' },
      netlist: () => ({ pins: { we: [0, 2], waddr: [0, 6], wdata: [0, 10], key: [0, 14], clk: [0, 18], hit: [R, 4], index: [R, 8] }, instances: b.instances, nets: b.nets() }),
      hdl: {
        verilog: `always_comb begin
  hit = 0; index = '0;
  for (int i = 0; i < N; i++) if (valid[i] && entry[i] == key) begin hit = 1; index = i; end
end
always_ff @(posedge clk) if (we) begin entry[waddr] <= wdata; valid[waddr] <= 1; end`,
      },
    });
  });
}

/**
 * Register file with `reads` read ports and `writes` (1 or 2) write ports. Each extra read port is
 * another multiplexer tree over all the words; each extra write port another decoder and a multiplexer
 * in front of every register (write port 1 wins a conflict).
 */
export function regfileMP(k: number, w: number, reads: number, writes: 1 | 2): ComponentDef {
  const N = 2 ** k, id = `rfmp${N}x${w}_${reads}r${writes}w`;
  return memo(id, () => {
    const b = new Builder(12, 12);
    const wps = Array.from({ length: writes }, (_, p) => p);
    b.pins('clk', ...wps.flatMap((p) => [`we${p}`, `wa${p}`, `wd${p}`]), ...Array.from({ length: reads }, (_, r) => `ra${r}`));
    const decs = wps.map((p) => b.op(decoder(k, true), [`wa${p}`, `we${p}`], `write port ${p}`));
    b.next();
    const regs = Array.from({ length: N }, (_, i) => {
      if (writes === 1) return b.op1(register(w), ['wd0', `${decs[0]}.y${i}`, 'clk'], `x${i}`);
      const en = b.op1(OR, [`${decs[0]}.y${i}`, `${decs[1]}.y${i}`]);
      const d = b.op1(busMux2(w), ['wd0', 'wd1', `${decs[1]}.y${i}`]);
      return { en, d, i };
    });
    let words: string[];
    if (writes === 2) {
      b.next();
      words = (regs as { en: string; d: string; i: number }[]).map((r) => b.op1(register(w), [r.d, r.en, 'clk'], `x${r.i}`));
    } else words = regs as string[];
    b.next();
    const all = b.name(b.op1(merger(Array(N).fill(w)), words), 'all words', true);
    b.next();
    for (let r = 0; r < reads; r++) b.wire(b.op1(readPort(k, w), [all, `ra${r}`], `read port ${r}`), `rd${r}`);
    const R = b.right;
    const ports: PortDef[] = [clock()];
    for (const p of wps) ports.push(bit(`we${p}`, 'in'), bus(`wa${p}`, k, 'in'), bus(`wd${p}`, w, 'in'));
    for (let r = 0; r < reads; r++) ports.push(bus(`ra${r}`, k, 'in'));
    for (let r = 0; r < reads; r++) ports.push(bus(`rd${r}`, w, 'out'));
    const pins: Record<string, [number, number]> = { clk: [0, 2] };
    let y = 6;
    for (const p of ports.slice(1)) if (p.dir === 'in') { pins[p.name] = [0, y]; y += 4; }
    for (let r = 0; r < reads; r++) pins[`rd${r}`] = [R, 4 + 4 * r];
    return define({
      id, name: `Register file (${N} × ${w}, ${reads} read, ${writes} write)`, category: 'memory',
      summary: `${reads} read ports (a ${N}:1 multiplexer tree each) and ${writes} write port${writes > 1 ? 's' : ''} (a decoder each${writes > 1 ? ', plus a multiplexer in front of every register; port 1 wins a conflict' : ''}). A superscalar core issuing two instructions per cycle needs 4 reads and 2 writes.`,
      ports,
      symbol: { kind: 'box', label: 'REGS' },
      netlist: () => ({ pins, instances: b.instances, nets: b.nets() }),
    });
  });
}
