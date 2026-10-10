// The sandbox's memories, DOM-free: a ROM's program image (what fits, what does not, the
// listing and which row the circuit is reading), language conversion, sample programs, and a
// RAM's contents (read live from the simulation, seeded at power-on from `init`).

import { BANK_K, bigRam, bigRamWithInit, ramLeafState, ramWords } from '../lib/bigmem';
import { ram } from '../lib/memory';
import { PROGRAMS } from '../riscv/programs';
import { disasm16 } from '../riscv/rv16/isa16';
import type { HierNode } from '../sim/flatten';
import type { Sim } from '../sim/sim';
import type { Bit, ComponentDef } from '../sim/types';
import { pack } from '../sim/values';
import type { PartRef } from './model';
import { buildProgram, type ProgramLang, type BuiltProgram, type ProgramError } from './program';

export type RomRef = Extract<PartRef, { rom: unknown }>['rom'];
export type RamRef = Extract<PartRef, { ram: unknown }>['ram'];

export interface RomImage extends BuiltProgram {
  /** 2^k words. */
  capacity: number;
  /** Everything that keeps the ROM from being built, located on source lines (0: no line). */
  problems: ProgramError[];
  /** The first problem as the part reports it ('ROM program: line N: …'), or null. */
  error: string | null;
}

/** Build a ROM's program and check it against the ROM's size and word width. */
export function romImage(r: Pick<RomRef, 'k' | 'w' | 'lang' | 'src'>): RomImage {
  const p = buildProgram(r.lang, r.src);
  const capacity = 2 ** r.k;
  const problems: ProgramError[] = [...p.errors];
  let error = p.errors.length ? `ROM program: line ${p.errors[0].line}: ${p.errors[0].message}` : null;
  // source line of word i (a map, built on the first problem: a 64K-word program has 64K lines)
  let lines: Map<number, number> | null = null;
  const lineOf = (i: number) => (lines ??= new Map(p.lines.map((l) => [l.addr, l.srcLine]))).get(4 * i) ?? 0;
  if (p.words.length > capacity) {
    const msg = `${p.words.length} words do not fit in 2^${r.k} = ${capacity} words`;
    problems.push({ line: lineOf(capacity), message: msg });
    error ??= `ROM program: ${msg}`;
  }
  if (r.w < 32) {
    for (let i = 0, n = 0; i < p.words.length && n < 100; i++) {
      if (p.words[i] >>> 0 < 2 ** r.w) continue;
      n++;
      const line = lineOf(i);
      const msg = `word ${i} (0x${(p.words[i] >>> 0).toString(16)}) does not fit in ${r.w} bits`;
      problems.push({ line, message: msg });
      error ??= `ROM program: line ${line}: ${msg}`;
    }
  }
  return { ...p, capacity, problems, error };
}

/** The word a ROM reads for an address value (-1: X), or null when the address is unknown. */
export function romIndex(r: Pick<RomRef, 'k' | 'addr'>, addr: number): number | null {
  if (addr < 0) return null;
  const N = 2 ** r.k;
  return (r.addr === 'rv32' ? Math.floor(addr / 4) : addr) % N;
}

export interface ListingRow {
  index: number;
  /** As the circuit addresses it: a byte address (rv32) or a word index. */
  addr: string;
  word: string;
  /** Disassembly for 32-bit words, empty otherwise. */
  text: string;
  srcLine: number;
}

/** One row per word of the program (the fill past its end is not listed). */
export function romListing(r: Pick<RomRef, 'w' | 'addr'>, img: BuiltProgram): ListingRow[] {
  const digits = r.w / 4;
  return img.lines.map((l, i) => ({
    index: i,
    addr: r.addr === 'rv32' ? `0x${l.addr.toString(16).padStart(4, '0')}` : `[${i}]`,
    word: (l.word >>> 0).toString(16).padStart(digits, '0'),
    text: r.w === 32 ? l.text : '',
    srcLine: l.srcLine,
  }));
}

/** The ROM's address input as a number (-1: X / unknown); null when nothing drives it. */
export const addrValue = (bits: Bit[] | null): number | null => (bits ? pack(bits) : null);

/**
 * A program in the other language: assembly → hex words (each with its disassembly as a
 * comment); hex → `.word` lines. Null when the source does not build (nothing to convert).
 */
export function convertProgram(src: string, to: ProgramLang, from: ProgramLang = to === 'hex' ? 'asm' : 'hex'): string | null {
  if (from === to) return src;
  if (to !== 'hex' && from !== 'hex') return null; // assembly ↔ assembly of another ISA: no
  const p = buildProgram(from, src);
  if (p.errors.length) return null;
  if (!src.trim()) return '';
  const d = to === 'rv16' || from === 'rv16' ? 4 : 8;
  return p.lines.map((l, i) => {
    const w = `0x${(l.word >>> 0).toString(16).padStart(d, '0')}`;
    const text = to === 'rv16' ? disasm16(l.word, i) : l.text;
    return to === 'hex' ? `${w}  # ${l.text}` : `        .word ${w}   # ${text}`;
  }).join('\n');
}

export interface RomSample {
  id: string;
  name: string;
  lang: ProgramLang;
  src: string;
}

/** The campaign's computer: Fibonacci numbers through the RAM to the LEDs (0xFFFB), forever. */
export const RV16_LEDS = `# RV16: Fibonacci numbers, each stored to RAM, read back and shown on the LEDs
        li   sp, 0x20        # a RAM pointer
        li   a0, 0
        li   a1, 1
loop:   sw   a0, 0(sp)
        lw   t0, 0(sp)       # through the RAM
        sw   t0, -5(x0)      # LEDS (0xFFFB)
        add  a2, a0, a1
        mv   a0, a1
        mv   a1, a2
        addi sp, sp, 1
        j    loop
`;

/** Segments a…g of a 7-segment digit for 0–F (bit 0 = a), the classic font. */
export const SEG7_FONT = [0x3f, 0x06, 0x5b, 0x4f, 0x66, 0x6d, 0x7d, 0x07, 0x7f, 0x6f, 0x77, 0x7c, 0x39, 0x5e, 0x79, 0x71];

const hexDigits = (ws: number[], d = 2) => ws.map((x) => x.toString(16).padStart(d, '0')).join(' ');

/** Programs to start from: the CPU chapters' samples (RV32I) and a few data tables. */
export const ROM_SAMPLES: RomSample[] = [
  ...PROGRAMS.map((p): RomSample => ({ id: p.id, name: p.name, lang: 'asm', src: p.source })),
  { id: 'seg7', name: '7-segment font 0–F', lang: 'hex', src: `# segments a..g = bits 0..6, one word per digit 0-F\n${hexDigits(SEG7_FONT.slice(0, 8))}\n${hexDigits(SEG7_FONT.slice(8))}` },
  { id: 'squares', name: 'Squares 0–15', lang: 'hex', src: `# n * n for n = 0..15\n${hexDigits(Array.from({ length: 16 }, (_, i) => i * i))}` },
  { id: 'hello', name: 'ASCII "Hello, RISC-V"', lang: 'hex', src: `# one character per word\n${hexDigits([...'Hello, RISC-V'].map((c) => c.charCodeAt(0)))} 00` },
  { id: 'rv16leds', name: 'RV16: Fibonacci on the LEDs', lang: 'rv16', src: RV16_LEDS },
];

/** Smallest k whose 2^k words hold n words (at least 1). */
export const kFor = (n: number) => Math.max(1, Math.ceil(Math.log2(Math.max(n, 2))));

// ---- RAM ---------------------------------------------------------------------------------

/** The RAM instance's node in a simulation of the chip that places it (null: not there). */
export function ramNode(sim: Sim, part: string): HierNode | null {
  const n = sim.design.root.children?.get(part);
  return n?.expanded && n.children?.has('w0') ? n : null;
}

/**
 * Every word of a placed RAM (-1: unknown): a large one's from its leaf's state, a small one's
 * from its registers; null when it is not simulated.
 */
export function readRam(sim: Sim, part: string): number[] | null {
  const big = ramLeafState(sim, sim.design.root.children?.get(part));
  if (big) return ramWords(big);
  const n = ramNode(sim, part);
  if (!n) return null;
  const out: number[] = [];
  for (let i = 0; n.children!.has(`w${i}`); i++) out.push(pack(sim.getBits(n.children!.get(`w${i}`)!.ports.q)));
  return out;
}

/** Initial words as a RAM part uses them: trimmed to 2^k words, each masked to w bits. */
export function ramInit(k: number, w: number, init: number[] | undefined): number[] {
  const N = 2 ** k;
  const M = 2 ** w;
  return Array.from({ length: N }, (_, i) => {
    const v = Math.trunc(Number(init?.[i] ?? 0));
    return Number.isFinite(v) ? ((v % M) + M) % M : 0;
  });
}

const RAM_CACHE_SIZE = 16;
const ramCache = new Map<string, ComponentDef>();

/**
 * ram(k, w) holding `init` at power-on: the same circuit, with power-on hints that seed each
 * 1 bit in both latches of its flip-flop (master and slave, q and q_n, so the loops agree).
 * Read in 'to 0' mode; 'random' power-on randomizes them like any storage, 'to X' ignores them.
 * Paths follow the library: word register w<i> → DFFE ff<j> → DFF ff → D latch → SR latch sr.
 */
export function ramWithInit(k: number, w: number, init: number[] | undefined): ComponentDef {
  const words = ramInit(k, w, init);
  // Larger than the gates simulate: a lookup whose initial words are its leaf's power-on state.
  if (k > BANK_K) return words.some((x) => x) ? bigRamWithInit(k, w, words) : bigRam(k, w);
  const base = ram(k, w);
  if (!words.some((x) => x)) return base;
  const key = `${k}/${w}/${words.join(',')}`;
  const hit = ramCache.get(key);
  if (hit) {
    ramCache.delete(key);
    ramCache.set(key, hit);
    return hit;
  }
  const powerOn: Record<string, 0 | 1> = {};
  words.forEach((v, i) => {
    for (let j = 0; j < w; j++) {
      if (Math.floor(v / 2 ** j) % 2 === 0) continue;
      for (const l of ['master', 'slave']) {
        powerOn[`w${i}.ff${j}.ff.${l}.sr.q`] = 1;
        powerOn[`w${i}.ff${j}.ff.${l}.sr.q_n`] = 0;
      }
    }
  });
  let h = 2166136261;
  for (const x of words) { h ^= x; h = Math.imul(h, 16777619) >>> 0; }
  const d: ComponentDef = {
    ...base, id: `${base.id}_i${h.toString(16).padStart(8, '0')}`, powerOn,
    summary: `${base.summary} Starts with its initial contents at power-on.`,
  };
  ramCache.set(key, d);
  if (ramCache.size > RAM_CACHE_SIZE) ramCache.delete(ramCache.keys().next().value!);
  return d;
}

/** Initial contents as hex text (one row of up to 8 words; trailing zeros dropped). */
export function initText(init: number[] | undefined, w: number): string {
  const ws = (init ?? []).slice();
  while (ws.length && !ws[ws.length - 1]) ws.pop();
  const d = Math.max(1, Math.ceil(w / 4));
  const rows: string[] = [];
  for (let i = 0; i < ws.length; i += 8) rows.push(ws.slice(i, i + 8).map((x) => x.toString(16).padStart(d, '0')).join(' '));
  return rows.join('\n');
}

/** Parse initial contents (the ROM's hex format: words, @index markers, comments). */
export function parseInit(text: string, k: number, w: number): { init: number[] } | { error: string } {
  const p = romImage({ k, w: 32, lang: 'hex', src: text });
  if (p.error) return { error: p.error.replace(/^ROM program: /, '') };
  const big = p.words.findIndex((x) => w < 32 && x >>> 0 >= 2 ** w);
  if (big >= 0) return { error: `word ${big} (0x${(p.words[big] >>> 0).toString(16)}) does not fit in ${w} bits` };
  return { init: p.words.map((x) => x >>> 0) };
}
