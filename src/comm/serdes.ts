// A clockless serial link at 4 cycles a bit, cycle by cycle (chapter 46), DOM-free: the golden model lib/serdes.ts is compared with
// every output after every edge. The sender's bit clock is a phase accumulator (so its rate is a number we can offset), the receiver
// has only the line: it samples it every cycle, finds the transitions with an Alexander (bang-bang) phase detector, and slides its
// bit strobe by one sample when enough votes agree.
//
//   sender    acc += inc each cycle; a carry out of the 12-bit sum ticks the serializer (inc = 1024: a bit every 4 cycles)
//   serializer 10-bit shift register, MSB first; on the tick after the last bit it loads the next word
//   line      d cycles of delay and an optional flipped bit (a model, labelled as one)
//   receiver  samples x0 (newest) … x4; a strobe every c+1 cycles: d = x0, e = x2 (the edge sample), p = x4 (the previous d)
//             early = d ≠ p and e = p (the edge sample saw no transition yet: strobe early, delay it)
//             late  = d ≠ p and e = d (the transition was already past it: bring the strobe forward)
//             f ± 1 per vote; at ±F the strobe period is 5 (delay) or 3 (advance) once and f is cleared
//   deserializer 10-bit shift register on the strobe; a comma (0011111 / 1100000) in its low 7 bits sets the bit count to 7

import { encode8b10b, type Rd } from './linecode';

export const NCO_BITS = 12;
export const NOMINAL_INC = 1 << (NCO_BITS - 2);   // 1024: a tick every 4 cycles
export const CYCLES_PER_BIT = 4;
/** The filter's limit: after F votes the same way the strobe moves a sample. */
export const FILTER_LIMIT = 4;
/** Gate-level link speed (decision 7): 4 cycles a bit at 3.95 ns a cycle. */
export const CYCLE_NS = 3.95;
export const GATE_BIT_NS = CYCLES_PER_BIT * CYCLE_NS;
export const GATE_MBPS = 1000 / GATE_BIT_NS;

const COMMA_A = 0b0011111, COMMA_B = 0b1100000;

export class TxModel {
  acc = 0; sr = 0; cnt = 0;
  /** Comb outputs before the edge. */
  tick(inc: number): number { return (this.acc + inc) >> NCO_BITS & 1; }
  last(): number { return this.cnt === 9 ? 1 : 0; }
  txd(): number { return (this.sr >> 9) & 1; }
  wload(inc: number): number { return this.tick(inc) & this.last(); }
  step(inc: number, word: number): void {
    const t = this.tick(inc), last = this.last();
    this.acc = (this.acc + inc) & ((1 << NCO_BITS) - 1);
    if (t) {
      this.sr = last ? word & 1023 : (this.sr << 1) & 1023;
      this.cnt = last ? 0 : this.cnt + 1;
    }
  }
}

/** A delay of d cycles with a flip: out(t) = in(t − d), the bit flipped where err was 1 as it entered. */
export class LineModel {
  q: number[];
  constructor(public delay: number) { this.q = Array(delay).fill(0); }
  out(): number { return this.q[0]; }
  step(inp: number, err: number): void { this.q.push(inp ^ err); this.q.shift(); }
}

export class RxModel {
  x = [0, 0, 0, 0, 0];
  c = 0; f = 0; sr = 0; bc = 0; word = 0; wv = 0;
  strobe(): number { return this.c === 0 ? 1 : 0; }
  trans(): number { return this.x[0] ^ this.x[4]; }
  early(): number { return this.strobe() & this.trans() & (1 ^ this.x[2] ^ this.x[4]); }
  late(): number { return this.strobe() & this.trans() & (this.x[2] ^ this.x[4]); }
  step(rxd: number): void {
    const s = this.strobe(), early = this.early(), late = this.late();
    let c = this.c - 1, f = this.f;
    if (s) {
      const g = f + early - late;
      if (g >= FILTER_LIMIT) { c = 4; f = 0; } else if (g <= -FILTER_LIMIT) { c = 2; f = 0; } else { c = 3; f = g; }
      const d = this.x[0], srn = ((this.sr << 1) | d) & 1023, low = srn & 127;
      const comma = low === COMMA_A || low === COMMA_B;
      const bcs = comma ? 7 : this.bc + 1;
      this.sr = srn;
      if (bcs === 10) { this.word = srn; this.wv = 1; this.bc = 0; } else { this.bc = bcs; this.wv = 0; }
    } else this.wv = 0;
    this.c = c; this.f = f;
    this.x = [rxd, this.x[0], this.x[1], this.x[2], this.x[3]];
  }
}

/** A word source: the next word to send each time the serializer asks. */
export type WordSource = (n: number) => number;

export interface LinkRun {
  /** Words the receiver produced (wv pulses), and the cycle each arrived. */
  got: number[]; at: number[];
  /** Words the sender loaded, in order. */
  sent: number[];
}

/** Run the sender → line → receiver for `cycles` cycles. `err(t)` is the line's error stream. */
export function runLink(words: WordSource, cycles: number, inc = NOMINAL_INC, delay = 3, err: (t: number) => number = () => 0, init?: { rx?: Partial<RxModel> }): LinkRun {
  const tx = new TxModel(), line = new LineModel(delay), rx = new RxModel();
  if (init?.rx) Object.assign(rx, init.rx);
  const got: number[] = [], at: number[] = [], sent: number[] = [];
  let n = 0, next = words(n++);
  for (let t = 0; t < cycles; t++) {
    if (rx.wv) { got.push(rx.word); at.push(t); }
    const load = tx.wload(inc);
    if (load) { sent.push(next); }
    const txd = tx.txd(), w = next;
    rx.step(line.out());
    line.step(txd, err(t));
    tx.step(inc, w);
    if (load) next = words(n++);
  }
  return { got, at, sent };
}

// ---- the loop's lock range, from the model ----------------------------------------------------------------------------------------

/** The byte for word n of a stream: a pattern is a function of the word's number and a random byte source. */
export type BytePattern = (n: number, rnd: () => number) => { v: number; k: boolean };
const COMMA = { v: 0xbc, k: true };
/** The patterns the link scene offers: a comma every eighth word, between them these. */
export const LINK_PATTERNS: { name: string; din: number | null; kin: number; bytes: BytePattern }[] = [
  { name: 'Commas and random bytes', din: null, kin: 0, bytes: (n, r) => (n % 8 === 0 ? COMMA : { v: r(), k: false }) },
  { name: 'D21.5 between commas (1010101010)', din: 0xb5, kin: 0, bytes: (n) => (n % 8 === 0 ? COMMA : { v: 0xb5, k: false }) },
  { name: 'D30.3 between commas (few edges)', din: 30 + 3 * 32, kin: 0, bytes: (n) => (n % 8 === 0 ? COMMA : { v: 30 + 3 * 32, k: false }) },
  { name: 'K28.5 only', din: 0xbc, kin: 1, bytes: () => COMMA },
];

/** Words the receiver gets wrong (after the first 20) with the sender's accumulator step at `inc`, on this pattern, by the models. */
export function wrongWords(pattern: BytePattern, inc: number, cycles = 24000): number {
  let rd: Rd = 0, st = 1, n = 0;
  const rnd = () => { st = (Math.imul(st, 1664525) + 1013904223) >>> 0; return st >>> 24; };
  const tx = new TxModel(), line = new LineModel(3), rx = new RxModel();
  const sent: number[] = [], got: number[] = [];
  const make = () => { const b = pattern(n++, rnd), e = encode8b10b(b.v, b.k, rd); rd = e.rd; return e.code; };
  let next = make();
  for (let t = 0; t < cycles; t++) {
    if (rx.wv) got.push(rx.word);
    const load = tx.wload(inc);
    if (load) sent.push(next);
    const word = next;
    rx.step(line.out()); line.step(tx.txd(), 0); tx.step(inc, word);
    if (load) next = make();
  }
  let best = Infinity;
  for (let off = 0; off < 8; off++) {
    let e = 0;
    for (let i = 20; i < got.length; i++) { const sv = sent[i + off - 4]; if (sv !== undefined && sv !== got[i]) e++; }
    best = Math.min(best, e);
  }
  return best;
}

/** The largest offset of the accumulator step, in counts, at which both signs still give no wrong word. */
export function lockRange(pattern: BytePattern, cycles = 24000): number {
  const side = (sign: number) => { let lo = 0, hi = 200; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (wrongWords(pattern, NOMINAL_INC + sign * m, cycles) === 0) lo = m; else hi = m; } return lo; };
  return Math.min(side(1), side(-1));
}

/** Fraction of bit periods of a pattern's stream that carry a transition: the votes the loop gets. */
export function patternDensity(pattern: BytePattern): number {
  let rd: Rd = 0, st = 1, tr = 0, bits = 0, last = 0;
  const rnd = () => { st = (Math.imul(st, 1664525) + 1013904223) >>> 0; return st >>> 24; };
  for (let i = 0; i < 400; i++) {
    const b = pattern(i, rnd), e = encode8b10b(b.v, b.k, rd);
    rd = e.rd;
    for (let j = 9; j >= 0; j--) { const bit = (e.code >> j) & 1; if (bits && bit !== last) tr++; last = bit; bits++; }
  }
  return tr / (bits - 1);
}

/** The lock range from the pattern's transition density: a slip of one sample takes F votes, a bit is 4 samples. */
export const theoryRange = (density: number): number => density / (4 * FILTER_LIMIT);
