// Experiments on the software segment (comm/mac.ts) for chapter 48's widgets: two stations a cable apart, and n stations under
// a Poisson load. DOM-free; everything below the arrivals is the MAC model, clock by clock, the same machine the gates are
// compared with.

import { FCS_BYTES, MIN_FRAME } from './ethframe';
import { BYTE_CLOCKS, GAP_CLOCKS, PREAMBLE_BYTES, Segment, Station, type StationIn } from './mac';

const mulberry = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** LFSR seeds for n stations: distinct, nonzero, not all ones. */
export const seedsFor = (n: number, salt = 0): number[] => Array.from({ length: n }, (_, i) => 1 + ((0x155 + 0x9b * i + 0x35 * salt * (i + 1)) % 1021));
export const addrOf = (i: number): number[] => [0x02, 0, 0, 0, 0, i + 1];

/** n stations `spacing` clocks apart along the cable, reset. */
function stationsOn(n: number, salt: number, spacing: number): Segment {
  const x = Array.from({ length: n }, (_, i) => i * spacing), sd = seedsFor(n, salt);
  const seg = new Segment(x.map((_, i) => new Station(addrOf(i), sd[i])), x);
  seg.step(seg.st.map(() => ({ rst: 1, go: 0, len: 0 })));
  return seg;
}

/** A frame from station `from` to station `to` (destination to pad, no FCS), padded to the minimum. */
export function frameBodyOf(from: number, to: number, payload = 46): number[] {
  const b = [...addrOf(to), ...addrOf(from), 0x08, 0x00, ...Array.from({ length: payload }, (_, i) => (i * 3 + from) & 0xff)];
  while (b.length < MIN_FRAME - FCS_BYTES) b.push(0);
  return b;
}

export interface PairTrace {
  /** One sample per clock from A's first txen: who sends, what each hears, who sees the collision, who is jamming. */
  txenA: number[]; txenB: number[]; hearA: number[]; hearB: number[]; colA: number[]; colB: number[]; jamA: number[]; jamB: number[];
  /** First txen of each, relative to A's (-1: never within the run). */
  startB: number;
  /** When each station's collision input first rose, relative to A's start (-1: never). */
  detectA: number; detectB: number;
  /** The backoff slots each station drew, in order. */
  drawsA: number[]; drawsB: number[];
  /** Frames each station completed, and the frames each kept / threw away. */
  sentA: number; sentB: number; goodA: number; goodB: number; badA: number; badB: number;
}

/**
 * Two stations d clocks apart, each with one minimum frame for the other. B's go comes so that its first txen is `offset` clocks after A's.
 * The trace covers `clocks` clocks from A's start; the run goes on `tail` clocks more so that frames get through.
 */
export function runPair(d: number, offset: number, clocks: number, tail = 0, salt = 0): PairTrace {
  const seg = stationsOn(2, salt, d);
  const [A, B] = seg.st;
  const fa = frameBodyOf(0, 1), fb = frameBodyOf(1, 0);
  A.load(fa); B.load(fb);
  const START = GAP_CLOCKS + 1;
  // a station that goes at clock g starts sending at g + 2 once the gap is over (the first clock after reset counts as 0)
  const goB = Math.max(1, START + offset - 2);
  const goA = Math.max(1, START - 2 - Math.min(0, offset));
  const tr: PairTrace = { txenA: [], txenB: [], hearA: [], hearB: [], colA: [], colB: [], jamA: [], jamB: [], startB: -1, detectA: -1, detectB: -1, drawsA: [], drawsB: [], sentA: 0, sentB: 0, goodA: 0, goodB: 0, badA: 0, badB: 0 };
  let t0 = -1;
  const total = goA + START + Math.abs(offset) + clocks + tail + 40;
  for (let c = 0; c < total; c++) {
    if (A.tx.txen && t0 < 0) t0 = c;
    if (t0 >= 0 && c - t0 < clocks) {
      const t = c - t0;
      tr.txenA.push(A.tx.txen); tr.txenB.push(B.tx.txen); tr.hearA.push(A.crsO); tr.hearB.push(B.crsO); tr.colA.push(A.col); tr.colB.push(B.col);
      tr.jamA.push(A.tx.jam); tr.jamB.push(B.tx.jam);
      if (B.tx.txen && tr.startB < 0) tr.startB = t;
      if (A.col && tr.detectA < 0) tr.detectA = t;
      if (B.col && tr.detectB < 0) tr.detectB = t;
    }
    if (A.tx.restart) tr.drawsA.push(A.tx.bo);
    if (B.tx.restart) tr.drawsB.push(B.tx.bo);
    tr.sentA += A.tx.sent; tr.sentB += B.tx.sent;
    seg.step([{ rst: 0, go: c === goA ? 1 : 0, len: fa.length }, { rst: 0, go: c === goB ? 1 : 0, len: fb.length }]);
  }
  tr.goodA = A.ngood; tr.goodB = B.ngood; tr.badA = A.nbad; tr.badB = B.nbad;
  return tr;
}

export interface LoadResult {
  /** Fraction of the wire's time spent on frames that were sent through (preamble to FCS). */
  throughput: number;
  /** What the arrivals asked for, in the same unit. */
  offered: number;
  sent: number[];
  collisions: number; drops: number; blocked: number;
  /** Mean number of frames in a row from the same station, over the order frames got through. */
  meanRun: number;
  clocks: number;
}

export interface LoadOpts { n: number; payload: number; load: number; clocks: number; seed: number; spacing?: number }

const frameClocks = (payload: number): number => (PREAMBLE_BYTES + Math.max(MIN_FRAME - FCS_BYTES, 14 + payload) + FCS_BYTES) * BYTE_CLOCKS;

/**
 * n stations on a short cable, frames of `payload` bytes, Poisson arrivals totalling `load` of the capacity for such frames (one frame
 * and gap per slot: the most one station could send). A station holds one frame; an arrival while it is busy is turned away and
 * counted as offered.
 */
export function runLoad(o: LoadOpts): LoadResult {
  const seg = stationsOn(o.n, o.seed, o.spacing ?? 3);
  const rnd = mulberry(o.seed * 7919 + o.n);
  const bodies = seg.st.map((_, i) => frameBodyOf(i, (i + 1) % o.n, o.payload));
  seg.st.forEach((s, i) => s.load(bodies[i]));
  const fc = frameClocks(o.payload), slot = fc + GAP_CLOCKS;
  const p = o.load / (o.n * slot);
  const order: number[] = [];
  const sent = seg.st.map(() => 0);
  let col = 0, drops = 0, blocked = 0, arrivals = 0;
  const ins: StationIn[] = seg.st.map((_, i) => ({ rst: 0, go: 0, len: bodies[i].length }));
  for (let c = 0; c < o.clocks; c++) {
    for (let i = 0; i < o.n; i++) {
      const s = seg.st[i];
      let go = 0;
      if (rnd() < p) { arrivals++; if (s.busy) blocked++; else go = 1; }
      ins[i].go = go;
      if (s.tx.restart) col++;
      if (s.tx.drop) drops++;
      if (s.tx.sent) { sent[i]++; order.push(i); }
    }
    seg.step(ins);
  }
  let runs = 0;
  order.forEach((v, k) => { if (k === 0 || v !== order[k - 1]) runs++; });
  const total = sent.reduce((a, b) => a + b, 0);
  return { throughput: (total * fc) / o.clocks, offered: (arrivals * slot) / o.clocks, sent, collisions: col, drops, blocked, meanRun: runs ? total / runs : 0, clocks: o.clocks };
}

/** The most a wire can carry for frames of this payload: one frame every frame + gap. */
export const maxThroughput = (payload: number): number => frameClocks(payload) / (frameClocks(payload) + GAP_CLOCKS);
