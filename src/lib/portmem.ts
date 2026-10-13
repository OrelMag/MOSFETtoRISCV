// A memory with a read and a write port per lane, of any size up to 1K words: the data memory of the
// campaign's lane-core benches (act 9), where every lane loads and stores in the same cycle. Up to 64
// words it is lanePortMemory (gates: a decoder per write port, a register per word behind a priority
// mux, a read tree per port). Larger, it is one behavioural leaf (as bigRam) whose structure is one
// level of 64-word banks: per port a decoder on the high address bits enables one bank, and a mux tree
// on them reads; opened, the banks are seeded from the leaf's state down to their latches.
//
// Writes follow lanePortMemory: at the rising edge every port with its we bit set writes its word,
// lowest port first, so the highest port wins a word several write (the lane golden models store
// lowest lane first). The leaf samples its inputs while clk is low, as bigRam, and treats unknowns the
// same way (an X address or write enable makes the words it may have written X).

import type { Behavior, ComponentDef } from '../sim/types';
import { BANK_K, isRamState, kWords, type RamState, seedLatches } from './bigmem';
import { Builder } from './builder';
import { decoder, muxTree } from './combinational';
import { define, merger, ones, splitter } from './define';
import { lanePortMemory } from './warps';

/** Largest port memory: 2^10 words (16 banks on one level). */
export const PORT_MAX_K = 10;
/** Most ports. */
export const PORT_MAX_N = 8;

/** A port memory leaf's state: a RamState (readers and views take it as one) plus what each port sampled. */
export interface PortRamState extends RamState {
  /** Per port, sampled while clk was low: we (0, 1, 2 = X), address and data (-1: X). */
  pw: number[];
  pa: number[];
  pd: number[];
}

const fresh = (N: number, w: number, n: number, mode: 'x' | 'zero' | 'random' | undefined, init?: ArrayLike<number>): PortRamState => {
  const mem = new Uint32Array(N), x = new Uint8Array(N);
  if (mode === 'x') x.fill(1);
  else if (mode === 'random') for (let i = 0; i < N; i++) mem[i] = Math.floor(Math.random() * 2 ** w);
  else if (init) for (let i = 0; i < Math.min(N, init.length); i++) mem[i] = init[i];
  return { mem, x, clk: 0, we: 0, a: 0, d: 0, writes: 0, pw: Array(n).fill(0), pa: Array(n).fill(0), pd: Array(n).fill(0) };
};

/** Port i's write at an edge (sure: a clean 0 → 1). */
function writePort(s: PortRamState, i: number, sure: boolean): void {
  const we = s.pw[i], a = s.pa[i], d = s.pd[i];
  if (we === 0) return;
  s.writes++;
  if (sure && we === 1 && a >= 0) {
    s.x[a] = d < 0 ? 1 : 0;
    s.mem[a] = d < 0 ? 0 : d;
    return;
  }
  const lo = a < 0 ? 0 : a, hi = a < 0 ? s.mem.length : a + 1;
  for (let j = lo; j < hi; j++) if (d < 0 || s.x[j] || s.mem[j] !== d) s.x[j] = 1;
}

/** The behaviour of a 2^k × w memory with n ports (addr<i>, wd<i>, we (n bits), clk → rd<i>). */
export function portBehavior(k: number, w: number, n: number, init?: ArrayLike<number>, inside?: Behavior['inside']): Behavior {
  const N = 2 ** k;
  return {
    delay: 3 * k,
    init: (mode) => fresh(N, w, n, mode, init),
    seq: { clk: 'clk', comb: Array.from({ length: n }, (_, i) => `addr${i}`) },
    eval: (ins, st) => {
      const s = st as PortRamState;
      const we = ins[2 * n], clk = ins[2 * n + 1];
      const c = clk < 0 ? 2 : clk;
      if (c !== 1) {
        for (let i = 0; i < n; i++) {
          s.pw[i] = we < 0 ? 2 : Math.floor(we / 2 ** i) % 2;
          s.pa[i] = ins[i];
          s.pd[i] = ins[n + i];
        }
      }
      const p = s.clk;
      s.clk = c;
      if (p !== 1 && c !== 0 && p !== c) for (let i = 0; i < n; i++) writePort(s, i, p === 0 && c === 1);
      const out = new Array<number>(n);
      for (let i = 0; i < n; i++) { const a = ins[i]; out[i] = a < 0 || s.x[a] ? -1 : s.mem[a]; }
      return out;
    },
    carry: (prev, known) => {
      if (!isRamState(prev) || prev.mem.length !== N || !('pw' in prev)) return fresh(N, w, n, 'zero', init);
      const q = prev as PortRamState;
      const s: PortRamState = { ...q, mem: q.mem.slice(), x: q.x.slice(), pw: q.pw.slice(0, n), pa: q.pa.slice(0, n), pd: q.pd.slice(0, n) };
      while (s.pw.length < n) { s.pw.push(0); s.pa.push(0); s.pd.push(0); }
      if (known) {
        for (let i = 0; i < N; i++) if (s.x[i]) { s.x[i] = 0; s.mem[i] = init?.[i] ?? 0; }
        s.pw = s.pw.map((v) => (v === 2 ? 0 : v));
      }
      return s;
    },
    inside,
  };
}

/** Bank b's share of a port memory's state (2^ks words each): each port's we as its decoder gives it. */
export function portBankState(s: PortRamState, b: number, ks: number): PortRamState {
  const m = 2 ** ks, lo = b * m;
  const hit = (a: number, we: number) => (we === 0 ? 0 : a < 0 ? 2 : Math.floor(a / m) === b ? we : 0);
  return {
    mem: s.mem.slice(lo, lo + m), x: s.x.slice(lo, lo + m), clk: s.clk, we: 0, a: 0, d: 0, writes: s.writes,
    pw: s.pw.map((we, i) => hit(s.pa[i], we)), pa: s.pa.map((a) => (a < 0 ? -1 : a % m)), pd: s.pd.slice(),
  };
}

const cache = new Map<string, ComponentDef>();
const memo = (key: string, f: () => ComponentDef) => {
  let d = cache.get(key);
  if (!d) cache.set(key, (d = f()));
  return d;
};

/** lanePortMemory(6, n, w) at the bottom of a larger one: simulated as a lookup until opened, then seeded. */
export function portBank(w: number, n: number): ComponentDef {
  return memo(`bank/${w}/${n}`, () => {
    const base = lanePortMemory(BANK_K, n, undefined, false, w);
    return define({
      ...base, id: `${base.id}_bank`, name: `${base.name}, a bank`,
      summary: `${base.summary} Inside a larger memory it is simulated as a lookup; open it to see its flip-flops hold the words.`,
      behavior: portBehavior(BANK_K, w, n, undefined, seedLatches(w)),
      preferBehavior: true,
    });
  });
}

/**
 * A 2^k × w memory with n read / write ports (k = 7 … 10): 2^(k − 6) banks of portBank(w, n), a
 * behavioural leaf at run time. Ports as lanePortMemory: addr<i>, wd<i>, we (bit i: port i), clk → rd<i>.
 */
export function bigPortMemory(k: number, w: number, n: number): ComponentDef {
  if (!Number.isInteger(k) || k <= BANK_K || k > PORT_MAX_K) throw new Error(`bigPortMemory: k must be ${BANK_K + 1}–${PORT_MAX_K}`);
  return memo(`big/${k}/${w}/${n}`, () => {
    const N = 2 ** k, hb = k - BANK_K, nb = 2 ** hb;
    const L = Array.from({ length: n }, (_, i) => i), B = Array.from({ length: nb }, (_, j) => j);
    const BANK = portBank(w, n);
    const ins = [...L.map((i) => `addr${i}`), ...L.map((i) => `wd${i}`), 'we', 'clk'];
    // Every wire between the columns is a label: 2^(k − 6) banks × n ports would otherwise be a weave.
    const b = new Builder(10, 14, 8);
    b.pins(...ins);
    const wes = b.op(splitter(ones(n)), ['we'], undefined, 'wes');
    const sa = L.map((i) => b.op(splitter([BANK_K, hb]), [`addr${i}`], undefined, `sa${i}`));
    L.forEach((i) => { b.name(`${sa[i]}.o0`, `low${i}`, true); b.name(`${sa[i]}.o1`, `bank${i}`, true); });
    b.next();
    const dec = L.map((i) => b.op(decoder(hb, true), [`${sa[i]}.o1`, `${wes}.o${i}`], `port ${i} writes`, `dec${i}`));
    L.forEach((i) => B.forEach((j) => b.name(`${dec[i]}.y${j}`, `s${j}_${i}`, true)));
    b.next();
    L.forEach((i) => b.name(`wd${i}`, `wd${i}`, true));
    const wes2 = B.map((j) => b.op1(merger(ones(n)), L.map((i) => `${dec[i]}.y${j}`), undefined, `wm${j}`));
    b.next();
    const bank = wes2.map((we, j) => {
      const nm = b.add(BANK, `words ${j * 2 ** BANK_K}–${(j + 1) * 2 ** BANK_K - 1}`, `bank${j}`);
      L.forEach((i) => { b.wire(`${sa[i]}.o0`, `${nm}.addr${i}`); b.wire(`wd${i}`, `${nm}.wd${i}`); });
      b.wire(we, `${nm}.we`);
      b.wire('clk', `${nm}.clk`);
      L.forEach((i) => b.name(`${nm}.rd${i}`, `q${j}_${i}`, true));
      return nm;
    });
    b.next();
    L.forEach((i) => {
      const m = b.add(muxTree(hb, w), `port ${i} reads`, `rm${i}`);
      bank.forEach((nm, j) => b.wire(`${nm}.rd${i}`, `${m}.d${j}`));
      b.wire(`${sa[i]}.o1`, `${m}.s`);
      b.wire(`${m}.y`, `rd${i}`);
    });
    const R = b.right;
    const bus = (name: string, width: number, dir: 'in' | 'out') => ({ name, width, dir });
    return define({
      id: `pmem${N}x${w}_${n}`, name: `${kWords(N)} × ${w} memory, ${n} ports`, category: 'memory',
      summary: `${N} words of ${w} bits with a read and a write port for each of ${n} lanes: ${nb} banks of 64 words. Per port a decoder on the high address bits enables one bank and a ${nb}:1 multiplexer tree reads one; `
        + 'the highest port wins a word several write. Simulated as a lookup; its banks open down to flip-flops.',
      ports: [...L.map((i) => bus(`addr${i}`, k, 'in')), ...L.map((i) => bus(`wd${i}`, w, 'in')), bus('we', n, 'in'),
        { name: 'clk', width: 1, dir: 'in', side: 'bottom', clock: true }, ...L.map((i) => bus(`rd${i}`, w, 'out'))] as ComponentDef['ports'],
      symbol: { kind: 'box', label: `RAM ${kWords(N)}×${w} ×${n}` },
      behavior: portBehavior(k, w, n, undefined, (st, seed) => {
        for (let j = 0; j < nb; j++) seed.state(`bank${j}`, portBankState(st as PortRamState, j, BANK_K));
      }),
      preferBehavior: true,
      netlist: () => ({
        pins: { ...Object.fromEntries(ins.map((p, i) => [p, [0, 2 + 3 * i]])), ...Object.fromEntries(L.map((i) => [`rd${i}`, [R, 2 + 3 * i]])) },
        instances: b.instances, nets: b.nets(),
      }),
      notes: `Simulated as a lookup table. The structure is real: ${nb} banks of 64 words, each with ${n} ports, behind a decoder and a multiplexer tree per port. Open a bank to see the words it holds.`,
    });
  });
}

/** A 2^k × w memory with n ports holding `init` at power-on (k ≤ 6: gates, seeded flip-flops; larger: the leaf's state). */
export function portMemory(k: number, w: number, n: number, init?: ArrayLike<number>): ComponentDef {
  if (!Number.isInteger(n) || n < 1 || n > PORT_MAX_N) throw new Error(`portMemory: 1–${PORT_MAX_N} ports`);
  const words = init && Array.from(init).some((v) => v) ? Array.from(init, (v) => v >>> 0) : undefined;
  if (k <= BANK_K) return lanePortMemory(k, n, words, false, w);
  const base = bigPortMemory(k, w, n);
  if (!words) return base;
  let h = 2166136261;
  for (const x of words) { h ^= x; h = Math.imul(h, 16777619) >>> 0; }
  return memo(`${base.id}/${h}`, () => ({
    ...base, id: `${base.id}_i${h.toString(16).padStart(8, '0')}`,
    summary: `${base.summary} Starts with its initial contents at power-on.`,
    behavior: { ...portBehavior(k, w, n, Uint32Array.from(words)), inside: base.behavior!.inside },
  }));
}
