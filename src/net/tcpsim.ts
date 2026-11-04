// Chapter 52's explorers: net/tcp.ts's two endpoints across a bottleneck, event by event, fast enough to move a slider. The network is a model and says so: a queue
// of whole frames in front of a link of so many clocks a byte, and a propagation delay each way. Times are clock cycles, as on the real stack (net/lanbench.ts).

import { ip4 } from '../comm/netframes';
import { ESTABLISHED, parseSeg, segBytes, TCP_K, TcpModel, type Segment, type TcpEvent } from './tcp';

export const FRAME_OVERHEAD = 14 + 20 + 20;
const A = ip4(10, 0, 1, 2), B = ip4(10, 0, 2, 2);

export interface SimOptions {
  /** Bytes of data A sends B; 0: the handshake alone. */
  bytes: number;
  /** Clocks a byte takes on the link from A to B. */
  byteClocks?: number;
  /** Frames the bottleneck's queue holds, the one in service included. */
  queue?: number;
  /** Propagation, one way, clocks. */
  delay?: number;
  /** Lost on the way: segment numbers in the order they were sent, counted over both directions. */
  lost?: ReadonlySet<number>;
  /** A random loss, per cent of A's segments, from a seed. */
  lossPct?: number; seed?: number;
  /** Clocks between the receiving application's reads (each up to `readBytes`); 0: at once. */
  readEvery?: number; readBytes?: number;
  /** Stop at this time whatever is left. */
  until?: number;
  /** Close after the data. */
  close?: boolean;
  isnA?: number; isnB?: number;
}

export interface SegRec {
  n: number; t: number; from: 'a' | 'b'; seg: Segment;
  /** Where it ended: delivered at this time, dropped by the full queue, or lost. */
  fate: 'ok' | 'queue' | 'lost' | 'flight';
  at: number;
  /** Frames queued ahead of it when it arrived. */
  depth: number;
  /** Sent before, at this sequence number. */
  retrans: boolean;
}
export interface TracePoint { t: number; cwnd: number; ssthresh: number; flight: number; sndWnd: number; held: number; q: number; srtt: number; rto: number }
export interface SimResult {
  segs: SegRec[];
  trace: TracePoint[];
  events: TcpEvent[];
  /** When the last byte reached the receiving application (-1: it did not). */
  doneAt: number;
  delivered: number;
  got: number[];
  drops: number; losses: number; retrans: number; timeouts: number; fast: number; probes: number;
  /** Round-trip samples, in the sender's own measure. */
  rtts: number[];
  endState: { a: number; b: number };
}

const lcgNext = (s: number) => (Math.imul(s, 1103515245) + 12345) >>> 0;
const streamByte = (i: number) => (i + (i >> 8) * 7) & 255;

export function runTcp(o: SimOptions): SimResult {
  const byteClocks = o.byteClocks ?? 32, queue = o.queue ?? 32, delay = o.delay ?? 10_000, ackDelay = delay;
  const segs: SegRec[] = [], trace: TracePoint[] = [], events: TcpEvent[] = [], rtts: number[] = [], got: number[] = [];
  const wire: { at: number; to: 'a' | 'b'; bytes: number[]; rec: SegRec }[] = [];
  /** The bottleneck: the time its queue's last frame leaves, and those still in it. */
  const leaving: number[] = [];
  let free = 0, now = 1, count = 0, rnd = (o.seed ?? 1) >>> 0;
  const seen = new Set<number>();
  const send = (from: 'a' | 'b', s: Segment, to: number): boolean => {
    while (leaving.length && leaving[0] <= now) leaving.shift();
    const carries = s.data.length + (s.flags & 3 ? 1 : 0) > 0, n = count++, retrans = from === 'a' && carries && seen.has(s.seq);
    if (from === 'a' && carries) seen.add(s.seq);
    const rec: SegRec = { n, t: now, from, seg: s, fate: 'flight', at: 0, depth: 0, retrans };
    segs.push(rec);
    let lose = o.lost?.has(n) ?? false;
    if (!lose && o.lossPct && from === 'a') { rnd = lcgNext(rnd); lose = (rnd >>> 16) % 100 < o.lossPct; }
    const bytes = segBytes(s, from === 'a' ? A : B, to);
    if (lose) { rec.fate = 'lost'; rec.at = now + delay / 2; return true; }
    let at: number;
    if (from === 'a') {
      rec.depth = leaving.length;
      if (leaving.length >= queue) { rec.fate = 'queue'; rec.at = now + delay / 2; return true; }
      const size = Math.max(60, bytes.length + 34) * byteClocks;
      free = Math.max(free, now) + size;
      leaving.push(free);
      at = free + delay;
    } else at = now + ackDelay + Math.max(60, bytes.length + 34) * 32;
    rec.at = at;
    wire.push({ at, to: from === 'a' ? 'b' : 'a', bytes, rec });
    return true;
  };
  const a: TcpModel = new TcpModel({ ip: A, isn: o.isnA ?? 0x1000, send: (s, to) => send('a', s, to), onEvent: (e) => { events.push(e); if (e.why === 'sample') rtts.push(e.srtt); } });
  const b: TcpModel = new TcpModel({ ip: B, isn: o.isnB ?? 0x2000, send: (s, to) => send('b', s, to) });
  const point = () => {
    while (leaving.length && leaving[0] <= now) leaving.shift();
    trace.push({ t: now, cwnd: a.cwnd, ssthresh: a.ssthresh, flight: (a.sndMax - a.sndUna) | 0, sndWnd: a.sndWnd, held: (b.rcvNxt - b.rcvRead) | 0, q: leaving.length, srtt: a.srtt, rto: a.rto });
  };
  b.listen(80);
  a.connect(B, 40000, 80, now);
  let sent = 0, closed = false, nextRead = 1, doneAt = -1;
  const readEvery = o.readEvery ?? 0, readBytes = o.readBytes ?? TCP_K.RCV, until = o.until ?? 2_000_000_000;
  const feed = () => {
    if (a.st !== ESTABLISHED) return;
    while (sent < o.bytes) {
      const k = Math.min(256, o.bytes - sent), n = a.write(Array.from({ length: k }, (_, i) => streamByte(sent + i)), now);
      sent += n;
      if (n < k) return;
    }
    if (o.close && !closed) { closed = true; a.close(now); }
  };
  const read = () => {
    if (now < nextRead) return;
    const r = b.read(readBytes, now);
    if (r.length) { got.push(...r); if (got.length >= o.bytes && doneAt < 0) doneAt = now; }
    nextRead = now + readEvery;
  };
  feed();
  point();
  const finished = () => (o.bytes > 0 ? got.length >= o.bytes : a.st === ESTABLISHED && b.st === ESTABLISHED) && (!o.close || a.st === 0 || a.st >= 6 || a.err);
  for (let guard = 0; guard < 400_000 && !finished() && !a.err && now < until; guard++) {
    let next = Infinity;
    for (const w of wire) if (w.at < next) next = w.at;
    if (a.rtoOn && a.rtoAt < next) next = a.rtoAt;
    if (b.rtoOn && b.rtoAt < next) next = b.rtoAt;
    if (readEvery && (b.rcvNxt - b.rcvRead) > 0 && nextRead < next) next = nextRead;
    if (next === Infinity) break;
    now = Math.max(now, next);
    for (let i = 0; i < wire.length;) {
      if (wire[i].at <= now) {
        const w = wire.splice(i, 1)[0];
        w.rec.fate = 'ok';
        (w.to === 'a' ? a : b).input(w.bytes, w.to === 'a' ? B : A, now);
        i = 0;
      } else i++;
    }
    a.tick(now); b.tick(now);
    read();
    feed();
    point();
  }
  for (const r of segs) if (r.fate === 'flight' && r.at <= now) r.fate = 'ok';
  const sum = (w: TcpEvent['why']) => events.filter((e) => e.why === w).length;
  return {
    segs, trace, events, doneAt, delivered: got.length, got, drops: segs.filter((s) => s.fate === 'queue').length, losses: segs.filter((s) => s.fate === 'lost').length,
    retrans: segs.filter((s) => s.retrans).length, timeouts: sum('timeout'), fast: sum('fast'), probes: sum('probe'), rtts, endState: { a: a.st, b: b.st },
  };
}

/** The steady RTT a queue of q frames adds: what the sender measures with it full, at this link's speed. */
export const queueDelay = (q: number, byteClocks: number, mss: number = TCP_K.MSS) => q * (mss + FRAME_OVERHEAD) * byteClocks;

export { parseSeg };
