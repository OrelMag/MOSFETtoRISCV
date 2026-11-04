// The asynchronous FIFO's golden model (lib/sync.ts asyncFifo), DOM-free: the circuit one clock edge at a time. Two
// unrelated clocks are modelled as a total order of edges, 'w' (wclk rises) and 'r' (rclk rises), each of which
// updates only its own domain's flip-flops from the values before it. What it cannot model is two edges close enough
// to race (phys/metastable.ts): the gates cannot either.

/** Binary to Gray. */
export const toGray = (b: number): number => b ^ (b >>> 1);
/** Gray to binary. */
export function fromGray(g: number): number {
  let x = g;
  for (let s = 1; s < 32; s <<= 1) x ^= x >>> s;
  return x >>> 0;
}
/** The Gray code of the next value after a counter of `bits` bits wraps: one bit differs, always. */
export const grayStep = (b: number, bits: number): number => toGray((b + 1) & ((1 << bits) - 1));

/** Number of bits in which two words differ. */
export const hamming = (a: number, b: number): number => { let x = (a ^ b) >>> 0, n = 0; while (x) { n += x & 1; x >>>= 1; } return n; };

export interface FifoState {
  mem: number[];
  /** Binary pointers, k + 1 bits (the top bit is the lap). */
  wb: number; rb: number;
  /** Their Gray copies, registered. */
  wg: number; rg: number;
  /** The read pointer on its way into the write domain (two flip-flops), the write pointer into the read domain. */
  rs1: number; rs2: number; ws1: number; ws2: number;
}

export interface EdgeResult {
  /** The write / read happened (enable and no flag). */
  did: boolean;
  /** Word read at this edge (the oldest word before the edge). */
  word?: number;
}

export class AsyncFifoModel {
  readonly N: number;
  readonly mask: number;
  s: FifoState;
  constructor(readonly k: number, readonly w: number) {
    this.N = 2 ** k;
    this.mask = (2 ** (k + 1)) - 1;
    this.s = { mem: Array(this.N).fill(0), wb: 0, rb: 0, wg: 0, rg: 0, rs1: 0, rs2: 0, ws1: 0, ws2: 0 };
  }

  /** The write domain's flag: the write pointer is one lap ahead of the (old) read pointer it has seen. */
  get full(): boolean { return this.s.wg === this.target(this.s.rs2); }
  /** The read domain's flag: the read pointer has caught up with the (old) write pointer it has seen. */
  get empty(): boolean { return this.s.rg === this.s.ws2; }
  /** The oldest word (rdata). */
  get rdata(): number { return this.s.mem[this.s.rb & (this.N - 1)]; }

  /** A Gray pointer with its top two bits inverted. */
  private target(g: number): number {
    return (g ^ (3 << (this.k - 1))) & this.mask;
  }

  /** Words truly in the FIFO (binary pointers, which no single clock domain sees). */
  get occupancy(): number { return (this.s.wb - this.s.rb) & this.mask; }

  /** Pointer value the write domain thinks the read side is at, in binary: how stale `full` is. */
  get readSeenByWriter(): number { return fromGray(this.s.rs2); }
  get writeSeenByReader(): number { return fromGray(this.s.ws2); }

  /** A rising edge of wclk with the write port's inputs `we`, `wdata`. */
  wEdge(we: boolean, wdata: number): EdgeResult {
    const s = this.s, wen = we && !this.full;
    const rs2 = s.rs1, rs1 = s.rg;
    if (wen) {
      s.mem[s.wb & (this.N - 1)] = wdata & (2 ** this.w - 1);
      s.wb = (s.wb + 1) & this.mask;
      s.wg = toGray(s.wb);
    }
    s.rs2 = rs2; s.rs1 = rs1;
    return { did: wen };
  }

  /** A rising edge of rclk with the read port's input `re`: the word shown before the edge is the one consumed. */
  rEdge(re: boolean): EdgeResult {
    const s = this.s, ren = re && !this.empty, word = this.rdata;
    const ws2 = s.ws1, ws1 = s.wg;
    if (ren) {
      s.rb = (s.rb + 1) & this.mask;
      s.rg = toGray(s.rb);
    }
    s.ws2 = ws2; s.ws1 = ws1;
    return { did: ren, word };
  }
}

/**
 * The order of two clocks' edges, one at a time: wclk at `fw`, rclk at `fr` (any units), the first rclk edge a quarter
 * period after the first wclk edge so that no two edges coincide.
 */
export class EdgeSchedule {
  i = 0;
  j = 0;
  constructor(readonly fw: number, readonly fr: number) {}
  next(): 'w' | 'r' {
    const tw = (this.i + 0.25) / this.fw, tr = (this.j + 0.625) / this.fr;
    if (tw <= tr) { this.i++; return 'w'; }
    this.j++;
    return 'r';
  }
}

/** The first `edges` edges of two clocks as a string of 'w' and 'r'. */
export function interleave(fw: number, fr: number, edges: number): ('w' | 'r')[] {
  const s = new EdgeSchedule(fw, fr);
  return Array.from({ length: edges }, () => s.next());
}

/** The ratios the scene's panel offers, as [wclk, rclk] relative rates. */
export const RATIOS: readonly [number, number][] = [[1, 1], [2, 1], [1, 2], [3, 2], [5, 3], [1, 7], [7, 1]];
