// Storage structures beyond the RAM: a ROM (decoder + OR plane), a PLA (AND plane + OR plane, its
// product terms found by Quine–McCluskey), a FIFO, a stack, a content-addressable memory and a
// register file with more ports.

import type { ComponentDef, InstanceDef, NetDef, PortDef } from '../sim/types';
import { constWord, isZero } from './alu';
import { Builder } from './builder';
import { laid } from './layered';
import { addSub, andN, busMux2, decoder, equal, incrementer } from './combinational';
import { priorityEncoder } from './coding';
import { define, merger, ones, splitter } from './define';
import { LiteralRails } from './rails';
import { instPort, orientGeom, symbolGeom, type Vec } from '../sim/geometry';
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
    // Drawn as the matrix it is: the decoder's word lines run across, each output bit's OR stands turned below them with its
    // inputs facing up, and every 1 in the contents is a drop from a word line (its dot) to that OR. A crossing without a dot is
    // a 0. (Drawn by the Builder, the 112 connections were pointers in a column: rom_seg7 3.3 px a unit at fit.)
    const dec = decoder(P.k), D: Vec = [6, 0];
    const yOf = (i: number) => instPort(dec, D, false, `y${i}`).pos[1];
    const top = Math.max(...P.data.map((_, i) => yOf(i))) + 3;
    const instances: InstanceDef[] = [{ name: 'dec', def: dec, at: D, label: 'word lines' }];
    const nets: NetDef[] = [{ name: 'addr', ends: ['addr', 'dec.a'] }];
    const word = new Map<number, NetDef>();
    // each bit's driver and the x its wire comes down at (a bit set in one word only is that word line: no x)
    const bits: { end: string; x?: number; word?: number }[] = [];
    let x = D[0] + symbolGeom(dec).w + 6, bottom = top;
    for (let j = 0; j < P.w; j++) {
      const on = P.data.map((v, i) => ((v >> j) & 1 ? i : -1)).filter((i) => i >= 0);
      const name = `b${j}`;
      const drop = (wi: number, end: string, px: number) => {
        let n = word.get(wi);
        if (!n) word.set(wi, (n = { name: `w${wi}`, ends: [`dec.y${wi}`], via: {} }));
        n.ends.push(end);
        n.via![end] = [[px, yOf(wi)]];
      };
      if (on.length < 2) {
        // no 1 in this bit: a tie cell; one: the word line itself is the bit
        if (!on.length) {
          instances.push({ name, def: TIE0, at: [x, top], rot: 1, label: `bit ${j}` });
          bits.push({ end: `${name}.y`, x: instPort(TIE0, [x, top], false, 'y', 1).pos[0] });
          x += orientGeom(TIE0, false, 1).w + 4;
        } else bits.push({ end: `dec.y${on[0]}`, word: on[0] });
        continue;
      }
      const o = on.length === 2 ? OR : orN(on.length), g = orientGeom(o, false, 1);
      instances.push({ name, def: o, at: [x, top], rot: 1, label: `bit ${j}` });
      // left to right in word order, so the drops nest instead of crossing each other
      const ins = on.map((_, q) => [instPort(o, [x, top], false, o === OR ? 'ab'[q] : `i${q}`, 1).pos[0], q] as const).sort((p, r) => p[0] - r[0]);
      on.forEach((wi, n) => drop(wi, `${name}.${o === OR ? 'ab'[ins[n][1]] : `i${ins[n][1]}`}`, ins[n][0]));
      bits.push({ end: `${name}.y`, x: instPort(o, [x, top], false, 'y', 1).pos[0] });
      bottom = Math.max(bottom, top + g.h);
      x += g.w + 4;
    }
    const mg = merger(ones(P.w)), M: Vec = [x + 2, bottom + 4];
    // mirrored and turned half round: bit 0 enters at the bottom, so each bit's wire turns under the ones to its right, never across
    instances.push({ name: 'mg', def: mg, at: M, flip: true, rot: 2 });
    bits.forEach((b, j) => {
      const end = `mg.i${j}`, y = instPort(mg, M, true, `i${j}`, 2).pos[1];
      const n = b.word === undefined ? undefined : word.get(b.word);
      if (n) n.ends.push(end);
      else nets.push({ ends: [b.end, end], ...(b.x === undefined ? {} : { via: { [end]: [[b.x, y]] } }) });
    });
    nets.push(...[...word.keys()].sort((p, r) => p - r).map((k) => word.get(k)!));
    nets.push({ name: 'data', ends: ['mg.out', 'data'] });
    const R = M[0] + orientGeom(mg, true, 2).w + 4, dy = instPort(mg, M, true, 'out', 2).pos[1];
    const ay = instPort(dec, D, false, 'a').pos[1];
    return define({
      id: `rom_${preset}`, name: `ROM: ${P.name}`, category: 'memory',
      summary: `${2 ** P.k} words × ${P.w} bits. A ${P.k}→${2 ** P.k} decoder raises one word line; output bit j is the OR of the word lines whose word has bit j set. Changing the contents means rewiring the OR plane: mask ROMs were set by the last metal layer.`,
      ports: [bus('addr', P.k, 'in'), bus('data', P.w, 'out')],
      symbol: { kind: 'box', label: 'ROM' },
      spec: ([a]) => [P.data[a]],
      netlist: () => ({ pins: { addr: [0, ay], data: [R, dy] }, instances, nets }),
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
    // Drawn as the textbook PLA: the input splitter and the inverters on top, the true and complement literal rails running down
    // (lib/rails.ts), one product term per row with its AND gate at the row's right end, each input a tap from its rail; then the
    // OR plane, an OR per output beside the rows of its terms, each term line a vertical trunk (lanes) with a tap into every OR
    // that uses it, and the outputs into the merger.
    const instances: InstanceDef[] = [], nets: NetDef[] = [];
    const sx = 'sx';
    instances.push({ name: sx, def: splitter(ones(P.n)), at: [1, 2] });
    const yNot = 4 + 2 * P.n;
    const rails = new LiteralRails(Array.from({ length: P.n }, (_, i) => ({ src: `${sx}.o${i}`, y: 3 + 2 * i, name: `x${i}`, not: `n${i}` })), 6, yNot);
    instances.push(...rails.instances);
    // the AND plane: a row per term, literals tapped in rail order (left to right, top to bottom)
    const xA = rails.right + 4, y0 = yNot + 5;
    const rowY: number[] = [], rowH: number[] = [], rowOut: string[] = [];
    let y = y0;
    terms.forEach((t, k) => {
      const lits = Array.from({ length: P.n }, (_, i) => i).filter((i) => !((t.mask >> i) & 1)).map((i): [number, 0 | 1] => [i, ((t.val >> i) & 1) as 0 | 1]);
      lits.sort((a, b) => rails.x(a[0], a[1]) - rails.x(b[0], b[1]));
      const def = lits.length === 0 ? TIE1 : lits.length === 1 ? undefined : lits.length === 2 ? AND : andN(lits.length);
      const g = def ? symbolGeom(def) : { h: 2 };
      rowY.push(y); rowH.push(g.h);
      if (def) {
        const name = `t${k}`;
        instances.push({ name, def, at: [xA, y], label: `term ${k}` });
        const ins = def.ports.filter((p) => p.dir === 'in').map((p) => p.name);
        lits.forEach(([i, v], p) => rails.use(i, v, `${name}.${ins[p]}`));
        rowOut.push(`${name}.${def.ports.find((p) => p.dir === 'out')!.name}`);
      } else rowOut.push(`${sx}.o${lits[0][0]}`);
      y += g.h + 1;
    });
    // the OR plane: an OR per output at the middle of its rows, kept in output order so the merger meets them without crossings
    const orDef = (k: number) => (k === 2 ? OR : orN(k));
    const hOf = (j: number) => (uses[j].length < 2 ? 2 : symbolGeom(orDef(uses[j].length)).h);
    const centre = (j: number) => (uses[j].length ? uses[j].reduce((s, k) => s + rowY[k] + rowH[k] / 2, 0) / uses[j].length : y0);
    const oy: number[] = [];
    let floor = y0;
    for (let j = 0; j < P.m; j++) {
      oy.push(Math.max(floor, Math.round(centre(j) - hOf(j) / 2)));
      floor = oy[j] + hOf(j) + 1;
    }
    const sinksOf = terms.map(() => [] as { end: string; y: number }[]);
    const lanesX0 = xA + 6;
    const outs: string[] = [];
    // pin order of each OR: its terms from the top row down, so the taps do not cross each other
    const orderOf = uses.map((u) => [...u].sort((a, b) => rowY[a] - rowY[b]));
    // lane per term line, left-edge style: a line occupies the vertical range from its row to its last tap
    const pinY = (j: number, p: number) => oy[j] + 1 + 2 * p + (hOf(j) - 2 * uses[j].length) / 2;
    const spans = terms.map((_, k) => {
      let lo = rowY[k] + rowH[k] / 2, hi = lo;
      for (let j = 0; j < P.m; j++) { const p = orderOf[j].indexOf(k); if (p >= 0) { lo = Math.min(lo, pinY(j, p)); hi = Math.max(hi, pinY(j, p)); } }
      return [lo, hi] as const;
    });
    const lane: number[] = terms.map(() => -1);
    const laneEnd: number[] = [];
    [...terms.keys()].filter((k) => spans[k][1] > spans[k][0]).sort((a, b) => spans[a][0] - spans[b][0]).forEach((k) => {
      let l = laneEnd.findIndex((e) => e < spans[k][0] - 0.5);
      if (l < 0) l = laneEnd.length;
      laneEnd[l] = spans[k][1];
      lane[k] = l;
    });
    const xO = lanesX0 + 2 * laneEnd.length + 1;
    orderOf.forEach((ord, j) => {
      if (ord.length === 0) {
        instances.push({ name: `z${j}`, def: TIE0, at: [xO, oy[j]] });
        outs.push(`z${j}.y`);
      } else if (ord.length === 1) {
        outs.push(rowOut[ord[0]]);
      } else {
        const def = orDef(ord.length), name = `o${j}`;
        instances.push({ name, def, at: [xO, oy[j]], label: `out ${j}` });
        const ins = def.ports.filter((p) => p.dir === 'in').map((p) => p.name);
        ord.forEach((k, p) => sinksOf[k].push({ end: `${name}.${ins[p]}`, y: pinY(j, p) }));
        outs.push(`${name}.${def.ports.find((p) => p.dir === 'out')!.name}`);
      }
    });
    terms.forEach((_, k) => {
      if (sinksOf[k].length) nets.push({ name: `term ${k}`, ends: [rowOut[k], ...sinksOf[k].map((s) => s.end)], trunk: lane[k] >= 0 ? lanesX0 + 2 * lane[k] : undefined });
    });
    // the merger, level with the middle of the OR column
    const xM = xO + 10;
    const yM = Math.max(2, Math.round((oy[0] + oy[P.m - 1] + hOf(P.m - 1)) / 2 - P.m));
    instances.push({ name: 'mg', def: merger(ones(P.m)), at: [xM, yM] });
    outs.forEach((o, j) => nets.push({ ends: [o, `mg.i${j}`] }));
    nets.push({ name: 'y', ends: ['mg.out', 'y'] });
    nets.push({ name: 'x', ends: ['x', `${sx}.in`] });
    nets.push(...rails.nets());
    const R = xM + 4, yPin = yM + P.m;
    return define({
      id: `pla_${preset}`, name: `PLA: ${P.name}`, category: 'gate',
      summary: `${P.n} inputs, ${terms.length} product terms, ${P.m} outputs. The AND plane builds each term from the true and complemented input rails; the OR plane sums the terms each output needs. A ROM decodes all ${2 ** P.n} input combinations; the PLA builds only the terms the outputs use, each from just the literals it needs.`,
      ports: [bus('x', P.n, 'in'), bus('y', P.m, 'out')],
      symbol: { kind: 'box', label: 'PLA' },
      spec: ([x]) => [P.f(x)],
      netlist: () => ({ pins: { x: [0, 2 + P.n], y: [R, yPin] }, instances, nets }),
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
    // Drawn by hand, as the FIFO is: the gates on the left; the stack pointer with +1 above it and −1 below, a mux
    // mirrored top to bottom so each comes into its own side, its output back over the top into the register; the
    // decoder, words, merger and read port on the right, the read slot (sp − 1) coming up into the read port's select.
    // The taps that would cross the pointer's loop (sp to its splitter and the zero test, write to the decoder's enable,
    // push to its inverter) and the full / empty feedback are pointers.
    const P = 10, H = 5 * N, Wy = H, Bot = 10 * N + 8, R = 112;
    const instances: InstanceDef[] = [
      { name: 'nfu', def: NOT, at: [7, Wy - 12] },
      { name: 'wr', def: AND, at: [12, Wy - 14], label: 'push if not full' },
      { name: 'go', def: OR, at: [20, Wy - 1], label: 'move sp' },
      { name: 'nem', def: NOT, at: [2, Wy + 6] },
      { name: 'rda', def: AND, at: [6, Wy + 4] },
      { name: 'npu', def: NOT, at: [7, Wy + 10] },
      { name: 'rd', def: AND, at: [12, Wy + 5], label: 'pop if not empty' },
      { name: 'sp', def: register(k + 1), at: [26, Wy - 3], label: 'stack pointer' },
      { name: 'inc', def: incrementer(k + 1), at: [38, Wy - 6], label: 'sp + 1' },
      { name: 'one', def: constWord(k + 1, 1), at: [32, Wy + 7] },
      { name: 'sub', def: TIE1, at: [36, Wy + 9] },
      { name: 'dm', def: addSub(k + 1), at: [38, Wy + 3], label: 'sp − 1' },
      { name: 'spm', def: busMux2(k + 1), at: [54, Wy - 3], flip: true, rot: 2, label: 'push or pop' },
      { name: 's2', def: splitter([k, 1], 4), at: [54, Wy + 8] },
      { name: 'spl', def: splitter([k, 1], 4), at: [62, Wy - 2] },
      { name: 'ez', def: isZero(k + 1), at: [66, Bot + 4], label: 'empty' },
      { name: 'dec', def: decoder(k, true, P), at: [66, 8], label: 'write slot sp' },
      ...Array.from({ length: N }, (_, i): InstanceDef => ({ name: `word${i}`, def: register(w), at: [80, 6 + P * i], label: `word ${i}` })),
      { name: 'all', def: merger(Array(N).fill(w), P), at: [92, 4] },
      { name: 'rdp', def: readPort(k, w), at: [96, 2 + H], label: 'slot sp − 1' },
    ];
    const nets: NetDef[] = [
      { name: 'push', ends: ['push', 'wr.a', 'npu.a'], tags: ['npu.a'] }, { name: 'pop', ends: ['pop', 'rda.a'] },
      { name: 'not full', ends: ['nfu.y', 'wr.b'] }, { name: 'not empty', ends: ['nem.y', 'rda.b'] }, { name: 'not push', ends: ['npu.y', 'rd.b'] },
      { name: 'pop ok', ends: ['rda.y', 'rd.a'] },
      { name: 'write', ends: ['wr.y', 'go.a', 'spm.s', 'dec.en'], tags: ['dec.en'], via: { 'go.a': [[17, Wy - 12], [17, Wy]], 'spm.s': [[56, Wy - 12]] } },
      { name: 'read', ends: ['rd.y', 'go.b'] },
      { name: 'move', ends: ['go.y', 'sp.en'] },
      { name: 'sp', ends: ['sp.q', 'inc.a', 'dm.a', 'spl.in', 'ez.a'], tags: ['spl.in', 'ez.a'], trunk: 36 },
      { name: '1', ends: ['one.y', 'dm.b'] }, { name: 'subtract', ends: ['sub.y', 'dm.sub'] },
      { name: 'sp+1', ends: ['inc.y', 'spm.b'] },
      { name: 'sp−1', ends: ['dm.s', 'spm.a', 's2.in'], trunk: 53 },
      { name: 'next sp', ends: ['spm.y', 'sp.d'], via: { 'sp.d': [[59, Wy], [59, Wy - 10], [25, Wy - 10], [25, Wy - 1]] } },
      { name: 'slot', ends: ['spl.o0', 'dec.a'] },
      { name: 'read slot', ends: ['s2.o0', 'rdp.sel'], via: { 'rdp.sel': [[57, Wy + 10], [57, Bot], [101, Bot]] } },
      { name: 'full', ends: ['spl.o1', 'full', 'nfu.a'], tags: true, tagAt: { 'spl.o1': [63, Wy + 8] } },
      { name: 'empty', ends: ['ez.z', 'empty', 'nem.a'], tags: ['nem.a'] },
      { name: 'din', ends: ['din', ...Array.from({ length: N }, (_, i) => `word${i}.d`)], trunk: 78 },
      { name: 'clk', ends: ['clk', 'sp.clk', ...Array.from({ length: N }, (_, i) => `word${i}.clk`)], tags: true },
      ...Array.from({ length: N }, (_, i): NetDef => ({ name: `we${i}`, ends: [`dec.y${i}`, `word${i}.en`] })),
      ...Array.from({ length: N }, (_, i): NetDef => ({ name: `word ${i}`, ends: [`word${i}.q`, `all.i${i}`] })),
      { name: 'words', ends: ['all.out', 'rdp.words'] },
      { name: 'top', ends: ['rdp.y', 'top'] },
    ];
    return define({
      id: `stack${N}x${w}`, name: `${N}-word stack (${w}-bit)`, category: 'memory',
      summary: `The stack pointer sp counts the words held. push writes din to slot sp and increments; pop decrements; top shows slot sp − 1. empty when sp = 0, full when sp = ${N}. A push and a pop together count as a push (on a full stack, neither happens).`,
      ports: [bit('push', 'in'), bit('pop', 'in'), bus('din', w, 'in'), clock(), bus('top', w, 'out'), bit('empty', 'out'), bit('full', 'out')],
      symbol: { kind: 'box', label: 'STACK' },
      netlist: () => ({
        pins: { din: [0, 2], push: [0, Wy - 13], pop: [0, Wy + 5], clk: [0, Wy + 16], top: [R, 4 + H], full: [R, Bot - 2], empty: [R, Bot + 6] },
        instances, nets,
      }),
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
    return define({
      id: `cam${N}x${w}`, name: `${N}-entry CAM (${w}-bit keys)`, category: 'memory',
      summary: `${N} entries written by address (we, waddr, wdata) and searched by content: each entry has its own ${w}-bit comparator, all comparing with key in parallel; a priority encoder turns the matches into hit and index. Search costs one comparator per entry, which is why CAMs stay small (TLBs, fully associative caches, network routers).`,
      ports: [bit('we', 'in'), bus('waddr', k, 'in'), bus('wdata', w, 'in'), bus('key', w, 'in'), clock(), bit('hit', 'out'), bus('index', k, 'out')],
      symbol: { kind: 'box', label: 'CAM' },
      netlist: laid(b, { pinOrder: ['we', 'waddr', 'wdata', 'key', 'clk', 'hit', 'index'], room: true, keepOrder: true, wires: { wdata: true, key: true } }),
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
