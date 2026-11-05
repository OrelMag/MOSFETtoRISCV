// Inside the data centre's models (DOM-free), labelled as models: a folded Clos by its counts, ECMP as balls in bins, an incast read a packet at a time, go-back-N against selective repeat, priority flow control's headroom and its victim, a
// cyclic buffer dependency, and the tail at scale. DCTCP runs on comm/queues.ts's bottleneck. tests/comm-dc.test.ts holds each to its closed form.

import { rng } from '../phys/line';

// ---- the fabric ----------------------------------------------------------------------------------------------------------------

/** A k-ary fat tree (Al-Fares et al., 2008) of k-port switches, three layers: k pods of k / 2 edge and k / 2 aggregation switches, (k / 2)² core. */
export function fatTree(k: number): { hosts: number; switches: number; edge: number; agg: number; core: number; paths: number; links: number } {
  const edge = (k * k) / 2, agg = (k * k) / 2, core = (k * k) / 4;
  return { hosts: (k * k * k) / 4, switches: edge + agg + core, edge, agg, core, paths: core, links: (k * k * k) / 4 * 3 };
}
/** What a leaf's hosts can offer over what its uplinks can carry. 1: full bisection. */
export const oversubscription = (hostsPerLeaf: number, hostGbps: number, uplinks: number, upGbps: number): number => (hostsPerLeaf * hostGbps) / (uplinks * upGbps);

// ---- ECMP ------------------------------------------------------------------------------------------------------------------------

/** n flows hashed onto m equal paths, each flow able to fill a path. The count on each path. */
export function ecmpAssign(n: number, m: number, seed: number): number[] {
  const u = rng(seed), bins = new Array<number>(m).fill(0);
  for (let i = 0; i < n; i++) bins[Math.floor(u() * m)]++;
  return bins;
}
/** Total carried, in paths' worth: a used path carries one. */
export const ecmpCarried = (bins: readonly number[]): number => bins.reduce((a, b) => a + (b > 0 ? 1 : 0), 0);
/** Expected share of the fabric carried: n flows on m paths leave a path idle with chance (1 − 1 / m)^n. */
export const ecmpExpected = (n: number, m: number): number => 1 - (1 - 1 / m) ** n;
/** The chance no two of n flows share a path. */
export function ecmpNoCollision(n: number, m: number): number {
  if (n > m) return 0;
  let p = 1;
  for (let i = 0; i < n; i++) p *= (m - i) / m;
  return p;
}

// ---- incast ---------------------------------------------------------------------------------------------------------------------

export interface IncastSpec { senders: number; blockBytes: number; bufferPkts: number; rtoMs: number; rttUs?: number; gbps?: number; iw?: number; pktBytes?: number }
export interface IncastRun { ms: number; goodputGbps: number; share: number; drops: number; timeouts: number }

/**
 * One barrier-synchronized read, as in Phanishayee et al. (2008): every server sends its block through one port with a shallow buffer, and the next read waits for the last packet of all of them. Time is packet slots on that port. Each sender has cumulative
 * ACKs, slow start then one packet a round trip, a fast retransmit on three duplicate ACKs (halving), NewReno partial ACKs for further holes, and otherwise a retransmission timer that restarts from the first unacknowledged packet with a window of one.
 */
export function incast(s: IncastSpec): IncastRun {
  const pkt = s.pktBytes ?? 1500, gbps = s.gbps ?? 1, slotUs = (pkt * 8) / (gbps * 1e3), rtt = Math.max(1, Math.round((s.rttUs ?? 100) / slotUs)), rto = Math.round((s.rtoMs * 1000) / slotUs), total = Math.ceil(s.blockBytes / pkt), N = s.senders;
  interface Tx { base: number; next: number; cwnd: number; ssth: number; dup: number; lastAck: number; got: Uint8Array; rcvd: number; timer: number; rec: number }
  const tx: Tx[] = Array.from({ length: N }, () => ({ base: 0, next: 0, cwnd: s.iw ?? 2, ssth: Infinity, dup: 0, lastAck: 0, got: new Uint8Array(total), rcvd: 0, timer: rto, rec: -1 }));
  const q: { f: number; seq: number }[] = [];
  let head = 0, drops = 0, timeouts = 0, t = 0, done = 0, rr = 0;
  const acks: { f: number; ack: number }[][] = Array.from({ length: rtt + 1 }, () => []);
  const send = (f: number, seq: number) => { if (q.length - head >= s.bufferPkts) drops++; else q.push({ f, seq }); };
  while (done < N && t < 1e9) {
    const bucket = acks[t % (rtt + 1)];
    for (const a of bucket) {
      const x = tx[a.f];
      if (a.ack > x.base) {
        const n = a.ack - x.base;
        x.base = a.ack; x.dup = 0; x.timer = t + rto; x.next = Math.max(x.next, x.base);
        // NewReno: an ACK that stops short of what was sent before the loss names the next hole
        if (x.base < x.rec) send(a.f, x.base);
        else x.cwnd += x.cwnd < x.ssth ? n : n / x.cwnd;
        if (x.base >= total && x.rcvd >= 0) { x.rcvd = -1; done++; }
      } else if (a.ack === x.base && x.base < total && ++x.dup === 3) {
        x.ssth = Math.max(2, x.cwnd / 2); x.cwnd = x.ssth; x.rec = x.next; x.timer = t + rto;
        send(a.f, x.base);
      }
    }
    bucket.length = 0;
    for (let k = 0; k < N; k++) {
      const f = (rr + k) % N, x = tx[f];
      if (x.base >= total) continue;
      if (t >= x.timer) { timeouts++; x.ssth = Math.max(2, x.cwnd / 2); x.cwnd = 1; x.next = x.base; x.dup = 0; x.rec = -1; x.timer = t + rto; }
      while (x.next < total && x.next - x.base < Math.floor(x.cwnd)) { send(f, x.next); x.next++; }
    }
    rr = (rr + 1) % N;
    if (head < q.length) {
      const p = q[head++], x = tx[p.f];
      if (head > 4096) { q.splice(0, head); head = 0; }
      x.got[p.seq] = 1;
      let ack = x.lastAck;
      while (ack < total && x.got[ack]) ack++;
      x.lastAck = ack;
      acks[(t + rtt) % (rtt + 1)].push({ f: p.f, ack });
    }
    t++;
  }
  const secs = (t * slotUs) / 1e6, g = (N * s.blockBytes * 8) / secs / 1e9;
  return { ms: secs * 1000, goodputGbps: g, share: g / gbps, drops, timeouts };
}

// ---- losing a packet at a high rate ---------------------------------------------------------------------------------------------

/** Go-back-N: a loss throws away the W packets in flight behind it. Expected transmissions per good packet: 1 + W p / (1 − p). */
export const gbnGoodput = (p: number, W: number): number => (1 - p) / (1 - p + W * p);
/** Selective repeat: each packet is sent until it arrives. */
export const srGoodput = (p: number): number => 1 - p;
/** The same, a packet at a time: per transmission, a good packet advances; a lost one costs the pipe, W sends in all. */
export function arqRun(p: number, W: number, scheme: 'gbn' | 'sr', n: number, seed: number): number {
  const u = rng(seed);
  let good = 0, sent = 0;
  while (good < n) {
    sent++;
    if (u() >= p) good++;
    else if (scheme === 'gbn') sent += W;
  }
  return good / sent;
}

// ---- priority flow control ----------------------------------------------------------------------------------------------------

/** What must fit above XOFF: while the pause travels, and while the sender finishes what it has started: 2 × one-way delay of packets, plus one being sent at each end. */
export const pfcHeadroom = (oneWay: number): number => 2 * oneWay + 2;

export interface PfcSpec { /** All the traffic to the slow port: the worst case for the headroom. */ oneFlow?: boolean; lossless: boolean; /** The slower receiver's rate, of the link. */ r1: number; buffer: number; headroom: number; oneWay: number; slots: number; seed?: number }
export interface PfcRun { f1: number; f2: number; drops: number; pausedShare: number; maxHeld: number }

/**
 * Two flows share one upstream FIFO into a switch, on the same priority class, then leave by different ports: flow 1 to a slow receiver, flow 2 to a fast one. Lossy: flow 1's overflow is dropped and flow 2 goes through. Lossless: when the downstream buffer
 * passes XOFF (buffer − headroom) the upstream is paused, oneWay slots later; so packets for the slow port hold up the packets behind them, and flow 2 falls to flow 1's rate: congestion spreading.
 */
export function pfcRun(s: PfcSpec): PfcRun {
  const xoff = s.buffer - s.headroom, xon = Math.max(0, xoff - 2);
  let q1 = 0, q2 = 0, drops = 0, f1 = 0, f2 = 0, credit = 0, paused = false, pausedSlots = 0, maxHeld = 0, turn = 0;
  const wire: (number | null)[] = new Array<number>(s.oneWay).fill(-1).map(() => null);
  const pauseWire: boolean[] = new Array<boolean>(s.oneWay).fill(false);
  // the upstream FIFO always has both flows' packets waiting, alternately
  for (let t = 0; t < s.slots; t++) {
    const head = wire[t % s.oneWay];
    wire[t % s.oneWay] = null;
    if (head !== null) {
      // lossy: each output has its own limit, so the slow port's overflow is its own; lossless: the ingress counter is one
      if (s.lossless ? q1 + q2 >= s.buffer : (head === 1 ? q1 : q2) >= s.buffer) drops++;
      else if (head === 1) q1++; else q2++;
    }
    credit = Math.min(1, credit + s.r1);
    if (q1 > 0 && credit >= 1) { q1--; f1++; credit -= 1; }
    if (q2 > 0) { q2--; f2++; }
    const held = q1 + q2;
    if (held > maxHeld) maxHeld = held;
    if (s.lossless) {
      if (!paused && held >= xoff) paused = true;
      else if (paused && held <= xon) paused = false;
    }
    const arrived = pauseWire[t % s.oneWay];
    pauseWire[t % s.oneWay] = paused;
    if (!arrived) { wire[t % s.oneWay] = turn % 2 && !s.oneFlow ? 2 : 1; turn++; } else pausedSlots++;
  }
  return { f1: f1 / s.slots, f2: f2 / s.slots, drops, pausedShare: pausedSlots / s.slots, maxHeld };
}

// ---- deadlock ------------------------------------------------------------------------------------------------------------------

export interface LoopRun { delivered: number[]; stoppedAt: number | null }
/**
 * `n` switches in a ring, a lossless queue of `buffer` packets on each link. Each flow enters at its own switch and goes `hops` links clockwise, then leaves. With hops ≥ 2 each link's queue waits on the next: a cycle of buffer dependencies. Every link moves one packet a
 * slot if it can. Blocked heads all round, and nothing can ever move again.
 */
export function ringRun(n: number, hops: number, buffer: number, slots: number, offered = 1, seed = 1): LoopRun {
  const u = rng(seed), q: number[][] = Array.from({ length: n }, () => []), delivered = new Array<number>(n).fill(0);
  let stoppedAt: number | null = null, flowOf: number[][] = Array.from({ length: n }, () => []);
  for (let t = 0; t < slots; t++) {
    let moved = 0;
    const nq = q.map((x) => x.length);
    for (let i = 0; i < n; i++) {
      if (!q[i].length) continue;
      const left = q[i][0], next = (i + 1) % n;
      if (left <= 1) { q[i].shift(); delivered[flowOf[i].shift()!]++; moved++; }
      else if (nq[next] < buffer) { q[i].shift(); const f = flowOf[i].shift()!; q[next].push(left - 1); flowOf[next].push(f); nq[next]++; moved++; }
    }
    for (let i = 0; i < n; i++) if (q[i].length < buffer && u() < offered) { q[i].push(hops); flowOf[i].push(i); moved++; }
    if (moved === 0 && stoppedAt === null) { stoppedAt = t; break; }
  }
  flowOf = [];
  return { delivered, stoppedAt };
}

// ---- the tail at scale --------------------------------------------------------------------------------------------------------

/** A request that waits for n servers, each slow with chance q, is slow with chance 1 − (1 − q)^n (Dean and Barroso, 2013). */
export const fanoutSlow = (n: number, q: number): number => 1 - (1 - q) ** n;
/** The fan-out at which half of all requests are slow. */
export const fanoutHalf = (q: number): number => Math.log(0.5) / Math.log(1 - q);
