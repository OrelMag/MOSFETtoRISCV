// What a packet's journey costs on chapter 53's network: four delays per hop, each from something stated. Propagation: the length over the
// speed of light in fibre, an assumed 200 000 km/s. Serialization: the frame's bits over the link's rate. Queueing: M/M/1's mean wait for cross
// traffic of a stated load and packet size, an assumption about traffic, and a seeded packet-by-packet queue for one packet's own luck.
// Engine: chapter 51's fast path, its cycles at the book's clock; a real router's is far wider, so at real rates this term is an upper bound.

import { CLOCK_NS } from '../dram/timing';
import { LINKS, type Journey, type NetLink } from './internet';

export const FIBRE_KM_PER_S = 200_000;
/** Preamble 8, FCS 4, inter-frame gap 12: what a frame without its FCS costs beyond its own bytes on the wire (chapter 48). */
export const WIRE_EXTRA = 24;
/** The mean size of the cross traffic a queue holds: assumed. */
export const CROSS_BYTES = 800;
/** The wire between a host and its router: short, fast and idle, so that the first delay on the path is the line behind it. */
export const LAN: NetLink = { a: -1, b: -1, km: 0.05, mbps: 1000, load: 0, note: 'host to its router' };

export const propMs = (l: NetLink): number => (l.km / FIBRE_KM_PER_S) * 1000;
export const serMs = (l: NetLink, frame: number): number => ((frame + WIRE_EXTRA) * 8) / (l.mbps * 1000);
/** M/M/1: the mean wait is ρ / (1 − ρ) service times. Past ρ = 1 the queue has no mean: it grows until a buffer overflows. */
export function queueMs(l: NetLink, load = l.load): number {
  if (load >= 1) return Infinity;
  return (load / (1 - load)) * serMs(l, CROSS_BYTES - WIRE_EXTRA);
}
/** The fast path's cycles (the same count as chapter 51's engineCycles, which a test holds equal): frame in, decide, the walk, the port, frame out. */
export const engineMs = (frame: number, reads: number): number => ((frame + 1 + reads + 1 + frame) * CLOCK_NS) / 1e6;

export interface HopDelay { router: number; link: NetLink | null; engine: number; prop: number; ser: number; queue: number; total: number }

/** The hops of a journey: at each router its engine, then the wire to the next. `load` overrides a link's cross traffic, by index. */
export function journeyDelays(j: Journey, frame: number, load: (i: number, l: NetLink) => number = (_, l) => l.load): HopDelay[] {
  return j.hops.map((x) => {
    const r = x.result, reads = r.reads;
    const i = r.kind === 'forward' && r.to.link !== undefined ? r.to.link : -1;
    const link = r.kind === 'forward' ? (i >= 0 ? LINKS[i] : LAN) : null;
    const engine = engineMs(frame, reads);
    if (!link) return { router: x.router, link, engine, prop: 0, ser: 0, queue: 0, total: engine };
    const prop = propMs(link), ser = serMs(link, frame), queue = queueMs(link, load(i, link));
    return { router: x.router, link, engine, prop, ser, queue, total: engine + prop + ser + queue };
  });
}

/** From the host's own wire to the far end, in mean terms. */
export function oneWayMs(j: Journey, frame: number, load?: (i: number, l: NetLink) => number): number {
  return propMs(LAN) + serMs(LAN, frame) + journeyDelays(j, frame, load).reduce((a, d) => a + d.total, 0);
}

/** A small seeded generator: chapters' randomness repeats. */
export function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A FIFO link, packet by packet (Lindley's recursion): Poisson arrivals, exponential sizes. What one packet waits behind what got there first. */
export class LinkQueue {
  private wait = 0;
  private readonly rnd: () => number;
  constructor(readonly load: number, readonly serviceMs: number, seed: number, warm = 256) {
    this.rnd = mulberry(seed);
    for (let i = 0; i < warm; i++) this.next();
  }
  private exp(mean: number): number { return -Math.log(1 - this.rnd()) * mean; }
  /** The next packet's wait. */
  next(): number {
    const w = this.wait;
    if (this.load <= 0) return 0;
    this.wait = Math.max(0, w + this.exp(this.serviceMs) - this.exp(this.serviceMs / this.load));
    return w;
  }
}

/** A journey with this packet's own waits, not the mean: so a later hop can answer sooner than an earlier one. */
export function sampledMs(j: Journey, frame: number, queues: Map<number, LinkQueue>, seed: number): number {
  let t = propMs(LAN) + serMs(LAN, frame);
  for (const d of j.hops) {
    t += engineMs(frame, d.result.reads);
    if (d.result.kind !== 'forward') continue;
    const i = d.result.to.link;
    const l = i !== undefined ? LINKS[i] : LAN;
    t += propMs(l) + serMs(l, frame);
    if (i !== undefined) {
      let q = queues.get(i);
      if (!q) { q = new LinkQueue(l.load, serMs(l, CROSS_BYTES - WIRE_EXTRA), (seed + i * 7919) >>> 0); queues.set(i, q); }
      t += q.next();
    }
  }
  return t;
}

// ---- a page ---------------------------------------------------------------------------------------------------------------------------

export const MSS = 1460;
/** RFC 6928's initial window. */
export const INIT_WINDOW = 10;
/** How long the server takes to answer: assumed. */
export const THINK_MS = 15;

export interface FetchSpec { dnsMs: number; rttMs: number; pageBytes: number; bottleneckMbps: number; tls: boolean; thinkMs?: number }
export interface FetchPhase { name: string; ms: number; what: string }

/** How many round trips slow start needs for `segments`, with no loss: the window doubling from INIT_WINDOW. */
export function slowStartRounds(segments: number): number {
  let sent = 0, w = INIT_WINDOW, n = 0;
  while (sent < segments) { sent += w; w *= 2; n++; }
  return n;
}

/** A segment's headers on the wire: Ethernet 14 + 24, IP 20, TCP 20. */
const SEG_EXTRA = 78;
/** From the first byte of the response to its last. Window k leaves k round trips in; the bits of an earlier window pass inside those round trips, so the last byte comes
 *  at the latest of k·RTT + what is still to send from window k on, over the bottleneck: a FIFO that may still be busy with earlier windows. */
export function responseMs(pageBytes: number, rttMs: number, bottleneckMbps: number): number {
  const segs = Math.max(1, Math.ceil(pageBytes / MSS));
  let sent = 0, w = INIT_WINDOW, k = 0, last = 0;
  while (sent < segs) {
    const left = Math.max(0, pageBytes - sent * MSS) + (segs - sent) * SEG_EXTRA;
    last = Math.max(last, k * rttMs + (left * 8) / (bottleneckMbps * 1000));
    sent += w; w *= 2; k++;
  }
  return last;
}

/** DNS, then TCP's handshake, TLS if any, the request, the response in slow start. No loss, and an ACK for every segment. */
export function fetchPhases(f: FetchSpec): FetchPhase[] {
  const think = f.thinkMs ?? THINK_MS, segs = Math.max(1, Math.ceil(f.pageBytes / MSS)), rounds = slowStartRounds(segs);
  const onWire = ((f.pageBytes + segs * SEG_EXTRA) * 8) / (f.bottleneckMbps * 1000);
  const out: FetchPhase[] = [];
  if (f.dnsMs > 0) out.push({ name: 'DNS', ms: f.dnsMs, what: 'name to address' });
  out.push({ name: 'TCP handshake', ms: f.rttMs, what: 'SYN, SYN-ACK: one round trip before any data' });
  if (f.tls) out.push({ name: 'TLS', ms: f.rttMs, what: 'one more round trip for keys (TLS 1.3); not built in this book' });
  out.push({ name: 'Request, to first byte', ms: f.rttMs + think, what: `one round trip and ${think} ms of the server's own (assumed)` });
  out.push({ name: `Response: ${segs} segment${segs === 1 ? '' : 's'}`, ms: responseMs(f.pageBytes, f.rttMs, f.bottleneckMbps), what: `${rounds} window${rounds === 1 ? '' : 's'} from ${INIT_WINDOW}, doubling; ${onWire.toFixed(1)} ms of bits at the narrowest link${rounds > 1 ? ', some of them inside those round trips' : ''}` });
  return out;
}
export const fetchMs = (f: FetchSpec): number => fetchPhases(f).reduce((a, p) => a + p.ms, 0);
