// Large memories: RAM and ROM of 2^7 … 2^21 words (the sandbox offers up to 2^16). At run time each is one behavioural leaf
// (a typed array: a 64K × 32 RAM costs one evaluation per access, not millions of gates); its
// structure is still the real circuit, built lazily level by level, so the box stays transparent:
//
//   bigRam(k, w):  addr → split [low, high]; decoder(high) & we → one bank's we;
//                  2^b banks of 2^(k-b) words share low, din, clk; a mux tree on high reads.
//   banks:         bigRam(k - 4) again (16 per level), down to ramBank(w) = ram(6, w) (gates).
//
// So 2^16 words are 16 × 2^12 → 16 × 2^8 → 4 × 2^6: four levels, at most 16 boxes on any one,
// each level a preferBehavior leaf until it is opened. Opening one starts a sub-simulation of its
// structure whose banks are seeded from the leaf's state (Behavior.inside), down to the latches
// of the gate-level bank. The ROM is the same tree of 2^8-word mux-tree ROMs (romLevels).
//
// The leaf's write semantics follow the master–slave flip-flops of ram(6, w): while clk is low the
// inputs are sampled (the master is transparent), and a rising edge writes what was sampled, so the
// order in which a simulator evaluates the leaf around an edge does not matter (GateSim, BitSim,
// SwitchSim alike). Unknowns: an X address reads X; a word written with X data is X; an edge that
// may or may not have happened (clk X), or a write enable that is X, makes the word(s) it may have
// written X (all of them for an X address), except those already holding din, as the gates would.
// Power-on: 'zero' gives the initial contents, 'x' all X, 'random' random words (per word: the
// state keeps one unknown flag per word, not per bit).

import { symbolGeom } from '../sim/geometry';
import { B0, B1, BX, type Behavior, type ComponentDef, type InstanceDef, type NetDef } from '../sim/types';
import { decoder, muxTree } from './combinational';
import { stats, type Stats } from '../sim/stats';
import { define, merger, splitter } from './define';
import { AND } from './gates';
import { ram } from './memory';

/** The gate-level bank at the bottom of a large RAM: ram(6, w). */
export const BANK_K = 6;
/** Largest memory: 2^21 words (8 MiB of bytes: Appendix B's Doom computer). */
export const BIG_MAX_K = 21;
/** At most 2^4 banks per level. */
const FAN_K = 4;

/** A word count as people say it: 512, 4K, 64K. */
export const kWords = (n: number) => (n >= 1024 && n % 1024 === 0 ? `${n / 1024}K` : String(n));

/** Bank size one level down. */
const subK = (k: number) => Math.max(BANK_K, k - FAN_K);

// ---- RAM state ----------------------------------------------------------------------------

/** The private state of a large RAM leaf (plain data: Sim.saveState copies it). */
export interface RamState {
  /** The words (an unknown word's entry is meaningless). */
  mem: Uint32Array;
  /** 1 where a word is unknown (X). */
  x: Uint8Array;
  /** clk as last seen: 0, 1 or 2 (X). */
  clk: number;
  /** we (0, 1, 2 = X), addr and din (-1: X) as last sampled while clk was low: what an edge writes. */
  we: number;
  a: number;
  d: number;
  /** Writes since power-on (a cheap change counter for views). */
  writes: number;
}

export function isRamState(s: unknown): s is RamState {
  return !!s && typeof s === 'object' && (s as RamState).mem instanceof Uint32Array && (s as RamState).x instanceof Uint8Array;
}

const copyState = (s: RamState): RamState => ({ ...s, mem: s.mem.slice(), x: s.x.slice() });

function freshState(N: number, w: number, mode: 'x' | 'zero' | 'random' | undefined, init?: ArrayLike<number>): RamState {
  const mem = new Uint32Array(N), x = new Uint8Array(N);
  if (mode === 'x') x.fill(1);
  else if (mode === 'random') for (let i = 0; i < N; i++) mem[i] = Math.floor(Math.random() * 2 ** w);
  else if (init) mem.set(init.length > N ? Array.prototype.slice.call(init, 0, N) as number[] : init);
  return { mem, x, clk: 0, we: 0, a: 0, d: 0, writes: 0 };
}

/** The word a RAM state reads at index i (-1: X). */
export const ramWord = (s: RamState, i: number): number => (s.x[i] ? -1 : s.mem[i]);

/** Every word of a RAM state (-1: X). */
export function ramWords(s: RamState): number[] {
  const out = new Array<number>(s.mem.length);
  for (let i = 0; i < out.length; i++) out[i] = s.x[i] ? -1 : s.mem[i];
  return out;
}

function write(s: RamState, sure: boolean): void {
  if (s.we === 0) return;
  s.writes++;
  if (sure && s.we === 1 && s.a >= 0) {
    s.x[s.a] = s.d < 0 ? 1 : 0;
    s.mem[s.a] = s.d < 0 ? 0 : s.d;
    return;
  }
  // It may or may not have written: the words it may have written are unknown unless they hold din already.
  const N = s.mem.length;
  const lo = s.a < 0 ? 0 : s.a, hi = s.a < 0 ? N : s.a + 1;
  for (let i = lo; i < hi; i++) if (s.d < 0 || s.x[i] || s.mem[i] !== s.d) s.x[i] = 1;
}

/**
 * The behaviour of a 2^k × w RAM (ports addr, din, we, clk → dout). `init`: the words at
 * power-on ('zero' mode). Its delay is the read path of the tree: 3 NAND delays per address bit.
 */
export function ramBehavior(k: number, w: number, init?: ArrayLike<number>, inside?: Behavior['inside']): Behavior {
  const N = 2 ** k;
  return {
    delay: 3 * k,
    init: (mode) => freshState(N, w, mode, init),
    seq: { clk: 'clk', comb: ['addr'] },
    eval: ([a, d, we, clk], st) => {
      const s = st as RamState;
      const c = clk < 0 ? 2 : clk;
      if (c !== 1) {
        s.we = we < 0 ? 2 : we;
        s.a = a;
        s.d = d;
      }
      const p = s.clk;
      s.clk = c;
      if (p !== 1 && c !== 0 && p !== c) write(s, p === 0 && c === 1);
      return [a < 0 || s.x[a] ? -1 : s.mem[a]];
    },
    carry: (prev, known) => {
      if (!isRamState(prev) || prev.mem.length !== N) return freshState(N, w, 'zero', init);
      const s = copyState(prev);
      if (known) {
        // as gate-level storage heals on an edit: unknown words take their power-on value
        for (let i = 0; i < N; i++) if (s.x[i]) { s.x[i] = 0; s.mem[i] = init?.[i] ?? 0; }
        if (s.we === 2) s.we = 0;
      }
      return s;
    },
    inside,
  };
}

/** Bank i's share of a RAM state, as the bank's own leaf state (its we as the decoder gives it). */
export function bankState(s: RamState, i: number, ks: number): RamState {
  const n = 2 ** ks, lo = i * n;
  const we = s.we === 0 ? 0 : s.a < 0 ? 2 : Math.floor(s.a / n) === i ? s.we : 0;
  return { mem: s.mem.slice(lo, lo + n), x: s.x.slice(lo, lo + n), clk: s.clk, we, a: s.a < 0 ? -1 : s.a % n, d: s.d, writes: s.writes };
}

// ---- the gate-level bank ------------------------------------------------------------------

/** Latch nets of ram(6, w): word i, bit j → master q, q_n, slave q, q_n (as ramWithInit seeds them). */
const latchPaths = new Map<number, string[][]>();
function latches(w: number): string[][] {
  let p = latchPaths.get(w);
  if (!p) {
    p = [];
    for (let i = 0; i < 2 ** BANK_K; i++) for (let j = 0; j < w; j++) {
      const f = `w${i}.ff${j}.ff`;
      p.push([`${f}.master.sr.q`, `${f}.master.sr.q_n`, `${f}.slave.sr.q`, `${f}.slave.sr.q_n`]);
    }
    latchPaths.set(w, p);
  }
  return p;
}

/** The bank's words into the latches of its flip-flops (an unknown word: X in both). */
export function seedLatches(w: number): Behavior['inside'] {
  const one = [B1], zero = [B0], x = [BX];
  return (st, seed) => {
    const s = st as RamState;
    const paths = latches(w);
    for (let i = 0; i < s.mem.length; i++) {
      for (let j = 0; j < w; j++) {
        const v = s.x[i] ? x : Math.floor(s.mem[i] / 2 ** j) % 2 ? one : zero;
        const n = s.x[i] ? x : v === one ? zero : one;
        const [mq, mqn, sq, sqn] = paths[i * w + j];
        seed.bits(mq, v);
        seed.bits(mqn, n);
        seed.bits(sq, v);
        seed.bits(sqn, n);
      }
    }
  };
}

const bankCache = new Map<number, ComponentDef>();

/**
 * ram(6, w) as the bottom bank of a large RAM: the same circuit (decoder, 64 registers, mux
 * tree), simulated as a lookup until it is opened; opened, its latches are seeded from the leaf.
 */
export function ramBank(w: number): ComponentDef {
  let d = bankCache.get(w);
  if (d) return d;
  const base = ram(BANK_K, w);
  d = define({
    ...base,
    id: `${base.id}_bank`, name: `${base.name} bank`,
    summary: `${base.summary} Inside a large memory it is simulated as a lookup; open it to see its flip-flops hold the words.`,
    behavior: ramBehavior(BANK_K, w, undefined, seedLatches(w)),
    preferBehavior: true,
  });
  bankCache.set(w, d);
  return d;
}

// ---- RAM levels ---------------------------------------------------------------------------

const ramCache = new Map<string, ComponentDef>();

const ramVerilog = (k: number, w: number) => `module ram #(parameter int K = ${k}, W = ${w}) (
  input  logic [K-1:0] addr,
  input  logic [W-1:0] din,
  input  logic         we, clk,
  output logic [W-1:0] dout);
  logic [W-1:0] mem [0:2**K-1];
  always_ff @(posedge clk) if (we) mem[addr] <= din;   // write: decoder + enables, bank by bank
  assign dout = mem[addr];                             // read: multiplexer trees
endmodule`;

const range = (w: number) => (w > 1 ? `[${w - 1}:0] ` : '');
const hexLit = (w: number, v: number) => `${w}'h${v.toString(16)}`;

/** Synthesis body of a 2^k × w RAM (vexport): an array, written on the clock, read combinationally. */
function ramSynth(k: number, w: number, init?: ArrayLike<number>): string[] {
  const lines = [`  reg ${range(w)}mem [0:${2 ** k - 1}];`];
  if (init && Array.prototype.some.call(init, (v: number) => v)) {
    lines.push('  initial begin');
    for (let i = 0; i < init.length; i++) if (init[i]) lines.push(`    mem[${i}] = ${hexLit(w, init[i])};`);
    lines.push('  end');
  }
  lines.push('  always @(posedge clk) if (we) mem[addr] <= din;', '  assign dout = mem[addr];');
  return lines;
}

/**
 * A 2^k × w RAM for k = 7 … 16 (w ≤ 32): banks of banks down to ramBank(w), a behavioural leaf
 * at run time (see the top of this file). Ports as ram(k, w): addr, din, we, clk → dout.
 */
export function bigRam(k: number, w: number): ComponentDef {
  if (!Number.isInteger(k) || k <= BANK_K || k > BIG_MAX_K) throw new Error(`bigRam: k must be ${BANK_K + 1}–${BIG_MAX_K}`);
  if (!Number.isInteger(w) || w < 1 || w > 32) throw new Error('bigRam: word width must be 1–32');
  const key = `${k}x${w}`;
  const hit = ramCache.get(key);
  if (hit) return hit;
  const N = 2 ** k, ks = subK(k), b = k - ks, n = 2 ** b;
  const sub = () => (ks === BANK_K ? ramBank(w) : bigRam(ks, w));
  const d = define({
    id: `ram${N}x${w}`, name: `${kWords(N)}×${w} memory`, category: 'memory',
    summary: `${N} words of ${w} bits (${N * w} bits): ${n} banks of ${2 ** ks} words. Writing: a decoder on the high address bits enables one bank. `
      + 'Reading: a multiplexer tree picks the addressed bank\'s word. Simulated as a lookup; its banks open down to flip-flops.',
    ports: [
      { name: 'addr', width: k, dir: 'in' },
      { name: 'din', width: w, dir: 'in' },
      { name: 'we', width: 1, dir: 'in' },
      { name: 'clk', width: 1, dir: 'in', side: 'bottom', clock: true },
      { name: 'dout', width: w, dir: 'out' },
    ],
    symbol: { kind: 'box', label: `RAM ${kWords(N)}×${w}` },
    behavior: ramBehavior(k, w, undefined, (st, seed) => {
      for (let i = 0; i < n; i++) seed.state(`bank${i}`, bankState(st as RamState, i, ks));
    }),
    preferBehavior: true,
    netlist: () => ramLevel(k, w, sub()),
    hdl: { verilog: ramVerilog(k, w), synth: ramSynth(k, w) },
    notes: `Simulated as a lookup table (one evaluation per access). The structure is real: ${n} banks of ${2 ** ks} words behind a `
      + `${b}→${n} decoder and a ${n}:1 multiplexer tree, level after level down to ${2 ** BANK_K}-word banks of flip-flops. `
      + 'Open a bank to see the words it holds.',
  });
  ramCache.set(key, d);
  return d;
}

/** The netlist of one level: decoder, banks, mux tree; one row pitch so wires stay straight. */
function ramLevel(k: number, w: number, B: ComponentDef): ReturnType<NonNullable<ComponentDef['netlist']>> {
  const ks = subK(k), b = k - ks, n = 2 ** b;
  const bg = symbolGeom(B);
  const pitch = Math.max(bg.h + 4, 10);
  const D = decoder(b, true, pitch);
  const M = muxTree(b, w, pitch);
  const dg = symbolGeom(D), mg = symbolGeom(M);
  const SA = splitter([ks, b]);

  const dAt: [number, number] = [8, 6];
  const dOut = (i: number) => dAt[1] + dg.ports[`y${i}`].pos[1];
  const xR = dAt[0] + dg.w + 10;
  // Bank i is placed so its we lines up with decoder output i.
  const rTop = (i: number) => dOut(i) - bg.ports.we.pos[1];
  const xM = xR + bg.w + 7;
  // Mux input i lines up with bank i's dout.
  const mTop = rTop(0) + bg.ports.dout.pos[1] - mg.ports.d0.pos[1];

  const instances: InstanceDef[] = [
    { name: 'sa', def: SA, at: [2, 0] },
    { name: 'dec', def: D, at: dAt },
    { name: 'rmux', def: M, at: [xM, mTop] },
  ];
  const nets: NetDef[] = [];
  const low = ['sa.o0'], din = ['din'], clk = ['clk'];
  for (let i = 0; i < n; i++) {
    instances.push({ name: `bank${i}`, def: B, at: [xR, rTop(i)] });
    nets.push({ name: `we${i}`, ends: [`dec.y${i}`, `bank${i}.we`] });
    nets.push({ name: `q${i}`, ends: [`bank${i}.dout`, `rmux.d${i}`] });
    low.push(`bank${i}.addr`);
    din.push(`bank${i}.din`);
    clk.push(`bank${i}.clk`);
  }
  const bottom = Math.max(rTop(n - 1) + bg.h, dAt[1] + dg.h, mTop + mg.h) + 3;
  const aY = dAt[1] + dg.ports.a.pos[1];
  const sx = xM + mg.ports.s.pos[0];
  const hiY = symbolGeom(SA).ports.o1.pos[1];
  nets.push({ name: 'addr', ends: ['addr', 'sa.in'] });
  nets.push({ name: 'bank', ends: ['sa.o1', 'dec.a', 'rmux.s'], via: { 'dec.a': [[5, hiY], [5, aY]], 'rmux.s': [[5, hiY], [5, bottom + 2], [sx, bottom + 2]] } });
  nets.push({ name: 'word', ends: low, trunk: xR - 5 });
  nets.push({ name: 'we', ends: ['we', 'dec.en'] });
  nets.push({ name: 'din', ends: din, trunk: xR - 3 });
  nets.push({ name: 'clk', ends: clk, trunk: xR + bg.w + 2 });
  nets.push({ name: 'dout', ends: ['rmux.y', 'dout'] });
  return {
    pins: {
      addr: [0, symbolGeom(SA).ports.in.pos[1]], we: [0, dAt[1] + dg.ports.en.pos[1]],
      din: [0, bottom], clk: [0, bottom + 4],
      dout: [xM + mg.w + 4, mTop + mg.ports.y.pos[1]],
    },
    instances, nets,
  };
}

const initCache = new Map<string, ComponentDef>();
const INIT_CACHE_SIZE = 8;

/** Two independent 32-bit hashes of a word list (FNV-1a and a multiplicative one), as hex. */
export function wordsHash(words: ArrayLike<number>): string {
  let h = 2166136261, g = 0x9e3779b9;
  for (let i = 0; i < words.length; i++) {
    const x = words[i] >>> 0;
    h ^= x; h = Math.imul(h, 16777619) >>> 0;
    g = (Math.imul(g ^ x, 0x85ebca6b) + i) >>> 0; g = (g ^ (g >>> 13)) >>> 0;
  }
  return h.toString(16).padStart(8, '0') + g.toString(16).padStart(8, '0');
}

/**
 * bigRam(k, w) holding `words` at power-on ('zero' mode): the same structure, with the words
 * in its leaf's initial state (no power-on hints: a behavioural array has no latches to seed).
 */
export function bigRamWithInit(k: number, w: number, words: ArrayLike<number>): ComponentDef {
  const base = bigRam(k, w);
  const h = wordsHash(words);
  const key = `${k}/${w}/${h}`;
  const hit = initCache.get(key);
  if (hit) {
    initCache.delete(key);
    initCache.set(key, hit);
    return hit;
  }
  const init = Uint32Array.from(words);
  const d: ComponentDef = {
    ...base, id: `${base.id}_i${h}`,
    summary: `${base.summary} Starts with its initial contents at power-on.`,
    behavior: { ...ramBehavior(k, w, init), inside: base.behavior!.inside },
    hdl: { ...base.hdl, synth: ramSynth(k, w, init) },
  };
  initCache.set(key, d);
  if (initCache.size > INIT_CACHE_SIZE) initCache.delete(initCache.keys().next().value!);
  return d;
}

/** A RAM leaf's state in a simulation: the node is a large RAM simulated as a lookup. */
export function ramLeafState(sim: { leafState(li: number): unknown }, node: { leafIndex?: number } | undefined): RamState | null {
  if (node?.leafIndex === undefined) return null;
  const s = sim.leafState(node.leafIndex);
  return isRamState(s) ? s : null;
}

// ---- a byte-banked large RAM ------------------------------------------------------------------

/** A banked RAM's state: a RamState of whole words, plus the byte enables sampled with the rest. */
export interface BankedRamState extends RamState {
  /** be as last sampled while clk was low (-1: X). */
  be: number;
}

const byteMask = (be: number) => ((be & 1 ? 0xff : 0) | (be & 2 ? 0xff00 : 0) | (be & 4 ? 0xff0000 : 0) | (be & 8 ? 0xff000000 : 0)) >>> 0;

function bankedWrite(s: BankedRamState, sure: boolean): void {
  if (s.we === 0 || s.be === 0) return;
  s.writes++;
  if (sure && s.we === 1 && s.a >= 0 && s.be > 0) {
    if (s.d < 0) { s.x[s.a] = 1; return; }
    const m = byteMask(s.be);
    s.mem[s.a] = ((s.mem[s.a] & ~m) | (s.d & m)) >>> 0;
    // a word with unknown bytes stays unknown unless all four were written
    if (s.be === 15) s.x[s.a] = 0;
    return;
  }
  // it may or may not have written: those words become unknown (one flag per word)
  const N = s.mem.length;
  const lo = s.a < 0 ? 0 : s.a, hi = s.a < 0 ? N : s.a + 1;
  for (let i = lo; i < hi; i++) s.x[i] = 1;
}

/** Byte lane i of a banked RAM's state, as that bank's own RAM state (its we as the AND gate gives it). */
function laneState(s: BankedRamState, i: number): RamState {
  const N = s.mem.length, mem = new Uint32Array(N);
  for (let j = 0; j < N; j++) mem[j] = (s.mem[j] >>> (8 * i)) & 0xff;
  const we = s.we === 0 ? 0 : s.be < 0 ? 2 : s.be & (1 << i) ? s.we : 0;
  return { mem, x: s.x.slice(), clk: s.clk, we, a: s.a, d: s.d < 0 ? -1 : (s.d >>> (8 * i)) & 0xff, writes: s.writes };
}

const bankedCache = new Map<number, ComponentDef>();

/**
 * 2^k words of 32 bits as four byte banks (bigRam(k, 8) each, an AND of we and the lane's byte
 * enable for its write): bankedMemory's circuit at the large-memory sizes. At run time one
 * behavioural leaf (one 32-bit word per entry); opened, its banks are seeded with their bytes.
 * Ports: addr (a byte address: word = addr[k+1:2]), wdata, be, we, clk → rdata.
 */
export function bankedBigRam(k: number): ComponentDef {
  const hit = bankedCache.get(k);
  if (hit) return hit;
  if (!Number.isInteger(k) || k <= BANK_K || k > BIG_MAX_K) throw new Error(`bankedBigRam: k must be ${BANK_K + 1}–${BIG_MAX_K}`);
  const N = 2 ** k;
  const behavior: Behavior = {
    delay: 3 * k,
    init: (mode) => ({ ...freshState(N, 32, mode), be: 0 }) as BankedRamState,
    seq: { clk: 'clk', comb: ['addr'] },
    eval: ([addr, d, be, we, clk], st) => {
      const s = st as BankedRamState;
      const a = addr < 0 ? -1 : Math.floor(addr / 4) % N;
      const c = clk < 0 ? 2 : clk;
      if (c !== 1) {
        s.we = we < 0 ? 2 : we;
        s.a = a;
        s.d = d;
        s.be = be;
      }
      const p = s.clk;
      s.clk = c;
      if (p !== 1 && c !== 0 && p !== c) bankedWrite(s, p === 0 && c === 1);
      return [a < 0 || s.x[a] ? -1 : s.mem[a]];
    },
    inside: (st, seed) => {
      for (let i = 0; i < 4; i++) seed.state(`b${i}`, laneState(st as BankedRamState, i));
    },
  };
  const d = define({
    id: `bram${N}`, name: `${kWords(N)}×32 memory (byte banks)`, category: 'memory',
    summary: `${N} words of 32 bits as four byte-wide banks of ${kWords(N)} bytes. Each bank has its own write enable (we and its byte enable), so a store writes one, two or four bytes; reads return the whole word.`,
    ports: [
      { name: 'addr', width: 32, dir: 'in' }, { name: 'wdata', width: 32, dir: 'in' }, { name: 'be', width: 4, dir: 'in' },
      { name: 'we', width: 1, dir: 'in' }, { name: 'clk', width: 1, dir: 'in', side: 'bottom', clock: true }, { name: 'rdata', width: 32, dir: 'out' },
    ],
    symbol: { kind: 'box', label: `RAM ${kWords(N)}×32` },
    behavior,
    preferBehavior: true,
    netlist: () => bankedLevel(k),
    notes: 'Simulated as a lookup table (one evaluation per access). Its structure is four byte banks, each a large RAM of banks down to flip-flops.',
  });
  bankedCache.set(k, d);
  return d;
}

function bankedLevel(k: number): ReturnType<NonNullable<ComponentDef['netlist']>> {
  const R = bigRam(k, 8), rg = symbolGeom(R);
  const pitch = rg.h + 6, bankY = (i: number) => 4 + pitch * i;
  const nets: NetDef[] = [
    { name: 'addr', ends: ['addr', 'sa.in'] },
    { name: 'index', ends: ['sa.o1', ...[0, 1, 2, 3].map((i) => `b${i}.addr`)], tags: [0, 1, 2, 3].map((i) => `b${i}.addr`) },
    { name: 'wdata', ends: ['wdata', 'lanes.in'] },
    { name: 'be', ends: ['be', 'sbe.in'] },
    { name: 'we', ends: ['we', ...[0, 1, 2, 3].map((i) => `w${i}.a`)], tags: [0, 1, 2, 3].map((i) => `w${i}.a`) },
    { name: 'clk', ends: ['clk', ...[0, 1, 2, 3].map((i) => `b${i}.clk`)], tags: [0, 1, 2, 3].map((i) => `b${i}.clk`) },
    { name: 'rdata', ends: ['mr.out', 'rdata'] },
  ];
  const instances: InstanceDef[] = [
    { name: 'sa', def: splitter([2, k, 30 - k]), at: [4, -6] },
    { name: 'lanes', def: splitter([8, 8, 8, 8], pitch), at: [4, bankY(0) + rg.ports.din.pos[1] - pitch / 2] },
    { name: 'sbe', def: splitter([1, 1, 1, 1]), at: [4, bankY(4) + 2] },
    { name: 'mr', def: merger([8, 8, 8, 8], pitch), at: [24 + rg.w + 6, bankY(0) + rg.ports.dout.pos[1] - pitch / 2] },
  ];
  for (let i = 0; i < 4; i++) {
    instances.push({ name: `w${i}`, def: AND, at: [14, bankY(i) + rg.ports.we.pos[1] - 1] });
    instances.push({ name: `b${i}`, def: R, at: [24, bankY(i)] });
    nets.push(
      { name: `lane${i}`, ends: [`lanes.o${i}`, `b${i}.din`] },
      { name: `be${i}`, ends: [`sbe.o${i}`, `w${i}.b`], tags: true },
      { name: `we${i}`, ends: [`w${i}.y`, `b${i}.we`] },
      { name: `out${i}`, ends: [`b${i}.dout`, `mr.i${i}`] },
    );
  }
  return {
    pins: { addr: [0, -3], wdata: [0, bankY(1) + 2], be: [0, bankY(4) + 4], we: [0, bankY(4) + 8], clk: [0, bankY(4) + 11], rdata: [24 + rg.w + 12, bankY(2)] },
    instances, nets,
  };
}

// ---- ROM levels ---------------------------------------------------------------------------

/** A ROM leaf's cost from its words alone (what stats() counts in leaf(k, w, words)): see romLevelsStats. */
export type RomLeafStats = (k: number, w: number, content: Uint32Array) => Stats;

/**
 * stats() of romLevels(k, w, rv, content, …, leaf) without building its levels (rv only changes a splitter, which costs nothing): each level is
 * its multiplexer tree, its splitter (wiring) and its banks, down to leaves whose cost `leafStats`
 * gives (it must equal stats(leaf(…)) for the same words).
 */
export function romLevelsStats(k: number, w: number, content: Uint32Array, leafStats: RomLeafStats): Stats {
  const ks = Math.max(ROM_LEAF_K, k - FAN_K), b = k - ks, n = 2 ** b, sz = 2 ** ks;
  const banks: Stats[] = [];
  for (let i = 0; i < n; i++) {
    const slice = content.subarray(i * sz, (i + 1) * sz);
    banks.push(ks <= ROM_LEAF_K ? leafStats(ks, w, slice) : romLevelsStats(ks, w, slice, leafStats));
  }
  // the multiplexer's pitch follows the banks' height, which does not change its cost
  return sumStats([stats(muxTree(b, w)), ...banks]);
}

/** The stats of a structure whose instances (none of them wiring) cost these. */
export function sumStats(parts: Stats[]): Stats {
  const s: Stats = { nands: 0, transistors: 0, resistors: 0, capacitors: 0, relays: 0, depletion: 0, parts: 0, descendants: 0, levels: 0 };
  for (const c of parts) {
    s.nands += c.nands; s.transistors += c.transistors; s.resistors += c.resistors; s.capacitors += c.capacitors; s.depletion += c.depletion;
    s.parts++;
    s.descendants += 1 + c.descendants;
    s.levels = Math.max(s.levels, 1 + c.levels);
  }
  return s;
}

/** The largest ROM built as one mux tree of constants; larger ones are banks of these. */
export const ROM_LEAF_K = 8;

/** Builds a word-addressed ROM of 2^k ≤ 2^ROM_LEAF_K words (the sandbox's mux tree of constants). */
export type RomLeaf = (k: number, w: number, content: Uint32Array) => ComponentDef;

/** Synthesis body of a ROM: a case table (the classic ROM style; tools read 64K entries of it in seconds). */
const romSynth = (k: number, w: number, rv: boolean, content: Uint32Array): string[] => {
  const lines = [`  reg ${range(w)}q;`, `  assign data = q;`, `  always @* case (${rv ? `addr[${k + 1}:2]` : 'addr'})`];
  for (let i = 0; i < content.length; i++) if (content[i]) lines.push(`    ${i}: q = ${hexLit(w, content[i])};`);
  lines.push(`    default: q = ${w}'h0;`, '  endcase');
  return lines;
};

/**
 * A ROM of 2^k words for k > ROM_LEAF_K: 2^b word-addressed sub-ROMs (`leaf` ones at the bottom,
 * identical slices sharing one definition) and a mux tree, built when first opened, simulated as
 * a lookup into `content`. 'rv32' (rv): a 32-bit byte address, word = addr[k+1:2].
 */
export function romLevels(k: number, w: number, rv: boolean, content: Uint32Array, id: string, leaf: RomLeaf): ComponentDef {
  const N = 2 ** k, ks = Math.max(ROM_LEAF_K, k - FAN_K), b = k - ks, n = 2 ** b;
  const idx = (a: number) => (rv ? Math.floor(a / 4) : a) % N;
  return {
    id, name: `ROM ${kWords(N)}×${w}`, category: 'memory',
    summary: `${N} words of ${w} bits, read-only: ${n} ROMs of ${2 ** ks} words behind a ${n}:1 multiplexer tree.`
      + (rv ? ' Byte addressed like a PC: word = addr / 4.' : ' Word addressed.'),
    ports: [{ name: 'addr', width: rv ? 32 : k, dir: 'in' }, { name: 'data', width: w, dir: 'out' }],
    symbol: { kind: 'box', label: 'ROM' },
    behavior: { eval: ([a]) => [a < 0 ? -1 : content[idx(a)]], delay: 3 * k },
    preferBehavior: true,
    spec: ([a]) => [content[idx(a)]],
    netlist: () => romLevel(k, w, rv, content, id, leaf),
    // built when read (vexport): a case table of every word is large for a big ROM
    hdl: { get synth() { return romSynth(k, w, rv, content); } },
    notes: `Simulated as a lookup table. Its structure is the real circuit: ${n} ROMs of ${2 ** ks} words, each a tree of `
      + `two-input multiplexers whose inputs are tied to the program's bits, and a ${n}:1 tree choosing between them.`,
  };
}

function romLevel(k: number, w: number, rv: boolean, content: Uint32Array, id: string, leaf: RomLeaf): ReturnType<NonNullable<ComponentDef['netlist']>> {
  const ks = Math.max(ROM_LEAF_K, k - FAN_K), b = k - ks, n = 2 ** b, sz = 2 ** ks;
  const shared = new Map<string, ComponentDef>();
  const bankOf = (i: number): ComponentDef => {
    const slice = content.subarray(i * sz, (i + 1) * sz);
    const h = wordsHash(slice);
    let d = shared.get(h);
    if (!d) shared.set(h, (d = ks <= ROM_LEAF_K ? leaf(ks, w, slice) : romLevels(ks, w, false, slice, `${id}_${h}`, leaf)));
    return d;
  };
  const banks = Array.from({ length: n }, (_, i) => bankOf(i));
  const bg = symbolGeom(banks[0]);
  const pitch = bg.h + 4;
  const M = muxTree(b, w, pitch);
  const mg = symbolGeom(M);
  const xB = 12, xM = xB + bg.w + 6;
  const SA = splitter(rv ? [2, ks, b, 30 - k] : [ks, b]);
  const sg = symbolGeom(SA);
  const sY = mg.h + 4;
  const [oLow, oHigh] = rv ? ['o1', 'o2'] : ['o0', 'o1'];
  const instances: InstanceDef[] = [{ name: 'mux', def: M, at: [xM, 0] }, { name: 'sa', def: SA, at: [3, sY] }];
  const lowEnds = [`sa.${oLow}`];
  const nets: NetDef[] = [];
  banks.forEach((B, i) => {
    const y = mg.ports[`d${i}`].pos[1] - bg.ports.data.pos[1];
    instances.push({ name: `bank${i}`, def: B, at: [xB, y], label: `[${(i * sz).toString(16)}]` });
    nets.push({ ends: [`bank${i}.data`, `mux.d${i}`] });
    lowEnds.push(`bank${i}.addr`);
  });
  const sx = xM + mg.ports.s.pos[0];
  const hy = sY + sg.ports[oHigh].pos[1];
  nets.push({ name: 'addr', ends: ['addr', 'sa.in'] });
  nets.push({ name: 'word', ends: lowEnds, trunk: 9 });
  nets.push({ name: 'bank', ends: [`sa.${oHigh}`, 'mux.s'], via: { 'mux.s': [[sx, hy]] } });
  nets.push({ name: 'data', ends: ['mux.y', 'data'] });
  return {
    pins: { addr: [0, sY + sg.ports.in.pos[1]], data: [xM + mg.w + 6, mg.ports.y.pos[1]] },
    instances, nets,
  };
}
