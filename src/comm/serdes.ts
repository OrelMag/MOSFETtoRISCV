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
