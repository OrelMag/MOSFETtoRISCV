// A toy core rope (Appendix F's weave widget): the AGC's read-only memory, small enough to see whole. DOM-free.
//
// How the real one reads (R-700 vol. III, E. C. Hall 1972, sec. 3.5.2 and Fig. 3-12, 3-13): a set current would switch
// every core, and inhibit currents cancel it in all but one, so the address is decoded by the inhibit lines threaded
// through the cores. The one core that switches induces a pulse in every sense line that threads it: "A stored bit is a
// 1 whenever a sense wire threads a core, and is a 0 whenever it fails to thread a core." Each Block II core stores 12
// words, so 192 sense lines run through or past it; a diode switching network in the module passes the 16 of the
// addressed word to the sense amplifiers (a second stage picks one of the six modules).
//
// Here: `cores` cores (2^coreBits), each storing `strands` words of `bits` bits; an address is core · strands + strand.
// Inhibit line (k, v) is driven when address bit k of the core number is v and threads every core whose bit k is not v,
// so every core but the addressed one has a driven inhibit through it.

export interface ToyRope {
  coreBits: number;
  strands: number;
  bits: number;
  /** thread[core][strand][bit]: the sense line for that bit of that strand passes through the core (a 1). */
  thread: boolean[][][];
}

export const coresOf = (r: ToyRope): number => 2 ** r.coreBits;
export const wordsOf = (r: ToyRope): number => coresOf(r) * r.strands;

/** A rope woven to hold these words (address = core · strands + strand), low bit first. */
export function weave(words: number[], coreBits = 2, strands = 2, bits = 4): ToyRope {
  const cores = 2 ** coreBits;
  const thread = Array.from({ length: cores }, (_, c) => Array.from({ length: strands }, (_, s) =>
    Array.from({ length: bits }, (_, b) => (((words[c * strands + s] ?? 0) >> b) & 1) === 1)));
  return { coreBits, strands, bits, thread };
}

/** The words a rope holds, by address. */
export function wordsIn(r: ToyRope): number[] {
  const out: number[] = [];
  for (let c = 0; c < coresOf(r); c++) for (let s = 0; s < r.strands; s++) out.push(r.thread[c][s].reduce((v, t, b) => v | (t ? 1 << b : 0), 0));
  return out;
}

/** Inhibit line (k, v) threads a core whose bit k differs from v. */
export const inhibitThreads = (core: number, k: number, v: number): boolean => ((core >> k) & 1) !== v;

export interface RopeRead {
  core: number;
  strand: number;
  /** Per core: driven inhibit lines through it (the addressed core has none, so it alone switches). */
  inhibits: number[];
  /** pulse[strand][bit]: the sense line picked up the switching core's pulse (it threads that core). */
  pulse: boolean[][];
  /** The word the sense amplifiers see: the addressed strand's pulses, the others blocked by the diode switch. */
  word: number;
}

/** A read of one address: decode by inhibits, switch the one core, sense the lines through it, select the strand. */
export function readRope(r: ToyRope, addr: number): RopeRead {
  const core = Math.floor(addr / r.strands) % coresOf(r), strand = addr % r.strands;
  const inhibits = Array.from({ length: coresOf(r) }, (_, c) => {
    let n = 0;
    for (let k = 0; k < r.coreBits; k++) if (inhibitThreads(c, k, (core >> k) & 1)) n++;
    return n;
  });
  const switched = inhibits.findIndex((n) => n === 0);
  const pulse = r.thread[switched].map((row) => row.slice());
  const word = pulse[strand].reduce((v, p, b) => v | (p ? 1 << b : 0), 0);
  return { core, strand, inhibits, pulse, word };
}

/** Rethread one crossing: the only way to change a rope's contents (it is rewoven, not written). */
export function rethread(r: ToyRope, core: number, strand: number, bit: number): ToyRope {
  const thread = r.thread.map((cs, c) => cs.map((bs, s) => bs.map((t, b) => (c === core && s === strand && b === bit ? !t : t))));
  return { ...r, thread };
}

/** The sourced Block II figures the widget quotes (R-700 vol. III sec. 3.5.2, Table 2-1) and what follows from them. */
export const BLOCK2_ROPE = {
  wordsPerCore: 12,
  senseLines: 192,
  bitsRead: 16,
  modules: 6,
  words: 36_864,
  /** words per module and cores per module, computed: 36 864 / 6, then / 12 */
  wordsPerModule: 36_864 / 6,
  coresPerModule: 36_864 / 6 / 12,
} as const;
