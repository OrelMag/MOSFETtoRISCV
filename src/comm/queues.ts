// Queues and congestion's models (DOM-free). One bottleneck, simulated a packet at a time: this is a labelled model, not the gates and not the TCP of the TCP chapter. tests/comm-queues.test.ts holds it to what
// can be worked out without it: M/M/1, M/D/1 and M/M/1/K, the sawtooth's 75 %, Mathis's formula, CUBIC's RFC 9438 average, RED's and CoDel's own rules, Chiu and Jain.
//
// Time is slots, a slot being one packet's time on the bottleneck. In each slot: ACKs and loss notices due arrive; senders send what their window and pacing allow; what is sent meets the queue's discipline; one packet
// leaves. A packet that leaves is acknowledged one base RTT later; one dropped is noticed one base RTT later (as duplicate ACKs would tell it) and its data is sent again as new packets, so goodput is packets acknowledged.
// No timeouts and no slow-start restart: the model's window never gets small enough to need them. Senders' rules are Reno (one cut a round trip), CUBIC (RFC 9438, with its Reno-friendly region) and BBR v1 (Cardwell
// et al., 2016: the delivery rate's maximum over ten round trips, the RTT's minimum over ten seconds, gains 2.89 / 1.25 / 0.75, a window of two BDPs, ignoring loss). Simplified: BBR's gain phases last one base RTT each with no early exit, and it has no packet conservation in recovery;
// RED has no idle-time decay and no gentle region; FQ-CoDel is packet round robin per flow, with no byte quantum and no new-flow list, and the delay probe always has a queue of its own (real fq_codel hashes, and serves sparse flows first).

import { rng } from '../phys/line';

// ---- a queue by itself -----------------------------------------------------------------------------------------------------

/** Mean wait in the queue, in service times, at load ρ. Exponential service: ρ / (1 − ρ). */
export const mm1Wait = (rho: number): number => rho / (1 - rho);
/** Fixed service: half of that. */
export const md1Wait = (rho: number): number => rho / (2 * (1 - rho));
/** Pollaczek-Khinchine: service whose squared coefficient of variation is cs2. cs2 = 1 is M/M/1, 0 is M/D/1. */
export const mg1Wait = (rho: number, cs2: number): number => (rho * (1 + cs2)) / (2 * (1 - rho));
/** The chance an M/M/1 packet waits longer than t service times. */
export const mm1Tail = (rho: number, t: number): number => rho * Math.exp(-(1 - rho) * t);
/** The wait that only this share of packets pass. */
export const mm1Quantile = (rho: number, share: number): number => (share >= rho ? 0 : Math.log(rho / share) / (1 - rho));
/** M/M/1/K: the chance an arrival finds K in the system and is dropped. */
export const mm1kBlock = (rho: number, K: number): number => (Math.abs(rho - 1) < 1e-12 ? 1 / (K + 1) : ((1 - rho) * rho ** K) / (1 - rho ** (K + 1)));

export type Service = 'exp' | 'fixed' | 'two';
export interface QueueRun { arrivals: number; dropped: number; meanWait: number; meanInSystem: number; p99: number; utilization: number }

/** Poisson arrivals at load ρ into one server, `K` the most in the system (Infinity: no limit). 'two': a service of 0 or 2, equally likely: mean 1, cs² = 1, as bursty as exponential with a different shape. */
export function queueRun(rho: number, n: number, o: { service?: Service; K?: number; seed?: number } = {}): QueueRun {
  const u = rng(o.seed ?? 1), K = o.K ?? Infinity, svc = o.service ?? 'exp';
  const draw = () => (svc === 'fixed' ? 1 : svc === 'exp' ? -Math.log(1 - u()) : u() < 0.5 ? 2 - 1e-12 : 1e-12);
  let t = 0, busyUntil = 0, sum = 0, busy = 0, dropped = 0, area = 0, count = 0;
  const leaving: number[] = [], waits: number[] = [];
  let head = 0;
  for (let i = 0; i < n; i++) {
    t += -Math.log(1 - u()) / rho;
    while (head < leaving.length && leaving[head] <= t) head++;
    if (leaving.length - head >= K) { dropped++; continue; }
    const start = Math.max(t, busyUntil), s = draw(), end = start + s;
    busyUntil = end; busy += s;
    leaving.push(end);
    sum += start - t; area += end - t; count++;
    if (i % 8 === 0) waits.push(start - t);
  }
  waits.sort((a, b) => a - b);
  return { arrivals: n, dropped, meanWait: sum / count, meanInSystem: area / t, p99: waits[Math.floor(waits.length * 0.99)] ?? 0, utilization: busy / t };
}

// ---- two senders: why additive increase, multiplicative decrease --------------------------------------------------------------

export interface ChiuStep { x: number; y: number }
/** Chiu and Jain, 1989: two flows share `cap`. Over it, both cut; under it, both raise. AIMD: +a and ×b. Others: 'aiad' +a and −c; 'mimd' ×g and ×b. */
export function chiuJain(x0: number, y0: number, kind: 'aimd' | 'aiad' | 'mimd', steps: number, cap = 100): ChiuStep[] {
  let x = x0, y = y0;
  const out: ChiuStep[] = [{ x, y }];
  for (let i = 0; i < steps; i++) {
    const over = x + y > cap;
    if (kind === 'aimd') { x = over ? x / 2 : x + 1; y = over ? y / 2 : y + 1; }
    else if (kind === 'aiad') { x = Math.max(0, over ? x - 1 : x + 1); y = Math.max(0, over ? y - 1 : y + 1); }
    else { x = over ? x / 2 : x * 1.05; y = over ? y / 2 : y * 1.05; }
    out.push({ x, y });
  }
  return out;
}
/** Jain's fairness index: 1 when all are equal, 1 / n when one has it all. */
export const jain = (xs: readonly number[]): number => { const s = xs.reduce((a, b) => a + b, 0), q = xs.reduce((a, b) => a + b * b, 0); return q ? (s * s) / (xs.length * q) : 1; };

// ---- closed forms for a window --------------------------------------------------------------------------------------------------

/** Reno under loss one packet in 1 / p: W average = √(3 / (2p)), the throughput formula of Mathis et al. (1997). */
export const renoWindow = (p: number): number => Math.sqrt(3 / (2 * p));
/** CUBIC's window curve, RFC 9438: W(t) = C (t − K)³ + Wmax. */
export const CUBIC_C = 0.4, CUBIC_BETA = 0.7;
export const cubicK = (wmax: number): number => Math.cbrt((wmax * (1 - CUBIC_BETA)) / CUBIC_C);
export const cubicCurve = (t: number, wmax: number): number => CUBIC_C * (t - cubicK(wmax)) ** 3 + wmax;
/** Its average window under the same loss, seconds of RTT: (C (3 + β) / (4 (1 − β)))^¼ (RTT / p)^¾, 1.054 at C = 0.4, β = 0.7. In the RFC's "CUBIC region". */
export const cubicWindow = (p: number, rtt: number): number => ((CUBIC_C * (3 + CUBIC_BETA)) / (4 * (1 - CUBIC_BETA))) ** 0.25 * (rtt / p) ** 0.75;

/**
 * The sawtooth's utilization: the window runs from half of the pipe plus buffer to all of it, one packet a round trip. While it is under the pipe the link has that share of its packets; while above, all of them. Each window counted equal: above the pipe the round trip is longer, so this understates a little for 0 < B < BDP.
 * B ≥ BDP: all of it. B = 0: three quarters.
 */
export function renoUtilization(bdp: number, buffer: number): number {
  const top = bdp + buffer, low = top / 2;
  if (low >= bdp) return 1;
  // equal time at each window from low to top: the mean of min(W, bdp) / bdp
  return (((bdp * bdp - low * low) / 2 + bdp * (top - bdp)) / (top - low)) / bdp;
}

// ---- DCTCP, Alizadeh et al. (2010), for a window W* = (C RTT + K) / N at the top

export const DCTCP_G = 1 / 16;
/** The steady share marked. */
export const dctcpAlpha = (wStar: number): number => Math.sqrt(2 / wStar);
/** The queue's swing: ½ √(2 N W*) · √N, for one flow ½ √(2 W*). */
export const dctcpAmplitude = (wStar: number, N = 1): number => (N / 2) * Math.sqrt(2 * wStar);
/** The smallest K that keeps the link busy, by the paper's bound: C RTT / 7 (with synchronized flows). */
export const dctcpMinK = (bdp: number): number => bdp / 7;

// ---- the disciplines' own rules ----------------------------------------------------------------------------------------------

/** RED's initial drop chance from the averaged queue: 0 below min, up to maxP at max, then every packet. */
export function redBase(avg: number, min: number, max: number, maxP: number): number {
  if (avg < min) return 0;
  if (avg >= max) return 1;
  return (maxP * (avg - min)) / (max - min);
}
/** CoDel's control law, RFC 8289: the next drop comes interval / √count after this one. */
export const codelNext = (t: number, interval: number, count: number): number => t + interval / Math.sqrt(count);

// ---- the bottleneck --------------------------------------------------------------------------------------------------------

export type CcKind = 'reno' | 'cubic' | 'bbr' | 'dctcp';
export type AqmKind = 'tail' | 'red' | 'codel' | 'fq' | 'step';
export interface FlowSpec { cc: CcKind; rttMs: number; startS?: number; ecn?: boolean; /** No Reno-friendly region and no fast convergence: CUBIC as its pure curve, which is what the closed form averages. */ pureCubic?: boolean }
export interface LinkSpec {
  mbps: number; bufferPkts: number; aqm?: AqmKind; pktBytes?: number;
  /** Random loss per packet on the wire, after the queue. */ lossP?: number;
  /** Deterministic loss: every this many packets on the wire. */ lossEvery?: number;
  /** A small packet every this many ms measures the delay a video call would see. */ pingMs?: number;
  /** CoDel's target and interval, ms (RFC 8289: 5 and 100). */ target?: number; interval?: number;
  /** The 'step' queue: mark every packet that arrives with at least this many queued (a data-centre switch). */ markK?: number;
  seed?: number;
}

interface Pkt { flow: number; sentAt: number; enq: number; deliveredAtSend: number; ce: boolean }

export interface Sample { t: number; cwnd: number[]; queue: number; delayMs: number; rate: number[] }

export interface SimResult {
  samples: Sample[];
  /** Over the part after warm-up. */
  goodputMbps: number[]; utilization: number; meanQueue: number; maxQueue: number;
  meanDelayMs: number; pingMeanMs: number; pingP95Ms: number; pingLost: number;
  drops: number; marks: number; wireLost: number; slotMs: number; bdpPkts: number;
  /** Mean window per flow, after warm-up. */ meanCwnd: number[];
  minQueue?: number; /** The first DCTCP flow's α at the end. */ dctcpAlpha?: number;
  jain: number;
}

class Sender {
  cwnd = 10; ssthresh = Infinity; inflight = 0; delivered = 0; recoverUntil = -1; acked = 0; sumCwnd = 0; nCwnd = 0;
  // cubic
  wmax = 0; lastWmax = 0; epoch = -1; k = 0; wEst = 0;
  // dctcp
  alpha = 1; ackedW = 0; markedW = 0; windowEnd = 0;
  // bbr
  btlbw = 0; samples: { t: number; v: number }[] = []; minRtt = Infinity; minRttAt = 0; state: 'startup' | 'drain' | 'probe' | 'probertt' = 'startup'; credit = 0; gainAt = 0; gainIdx = 0; fullBw = 0; fullCount = 0; roundEnd = 0; rttEnd = 0;
  constructor(readonly spec: FlowSpec, readonly rtt: number, readonly slotS: number, readonly start: number) {}
  get paced(): boolean { return this.spec.cc === 'bbr'; }
  bdp(): number { return this.btlbw * (Number.isFinite(this.minRtt) ? this.minRtt : this.rtt); }
  /** The gain now. */
  gain(): number {
    if (this.state === 'startup') return 2.89;
    if (this.state === 'drain') return 1 / 2.89;
    if (this.state === 'probertt') return 1;
    return [1.25, 0.75, 1, 1, 1, 1, 1, 1][this.gainIdx];
  }
  limit(): number {
    if (this.spec.cc !== 'bbr') return this.cwnd;
    if (this.state === 'probertt') return 4;
    const b = this.bdp();
    return b > 0 ? Math.max(4, (this.state === 'startup' ? 2.89 : 2) * b) : 10;
  }
  onAck(p: Pkt, t: number): void {
    this.inflight--; this.delivered++; this.acked++;
    const s = this.spec.cc;
    if (s === 'bbr') { this.bbrAck(p, t); return; }
    if (s === 'dctcp') {
      // Alizadeh et al., 2010: over each window of data, α ← (1 − g) α + g F, F the share marked; a marked window cuts by α / 2 once
      this.ackedW++; if (p.ce) this.markedW++;
      if (p.ce && t > this.recoverUntil) { this.recoverUntil = t + this.rtt; this.cwnd = Math.max(2, this.cwnd * (1 - this.alpha / 2)); this.ssthresh = this.cwnd; }
      if (this.delivered >= this.windowEnd) { this.alpha = (1 - DCTCP_G) * this.alpha + DCTCP_G * (this.markedW / Math.max(1, this.ackedW)); this.ackedW = 0; this.markedW = 0; this.windowEnd = this.delivered + this.cwnd; }
    } else if (p.ce) this.congest(t);
    if (this.cwnd < this.ssthresh) { this.cwnd += 1; return; }
    if (s === 'reno' || s === 'dctcp') { this.cwnd += 1 / this.cwnd; return; }
    // CUBIC, one ACK's worth towards the curve one RTT ahead
    const RTT = this.rtt * this.slotS;
    if (this.epoch < 0) { this.epoch = t; this.wmax = this.cwnd; this.k = 0; this.wEst = this.cwnd; }
    const el = (t - this.epoch) * this.slotS, target = cubicCurve2(el + RTT, this.wmax, this.k);
    if (target > this.cwnd) this.cwnd += (target - this.cwnd) / this.cwnd; else this.cwnd += 0.01 / this.cwnd;
    if (!this.spec.pureCubic) {
      this.wEst += ((3 * (1 - CUBIC_BETA)) / (1 + CUBIC_BETA)) / this.cwnd;
      if (this.wEst > this.cwnd) this.cwnd = this.wEst;
    }
  }
  private bbrAck(p: Pkt, t: number): void {
    const rtt = t - p.sentAt;
    if (rtt > 0 && rtt <= this.minRtt) { this.minRtt = rtt; this.minRttAt = t; }
    const span = t - p.sentAt;
    if (span > 0) {
      const v = (this.delivered - p.deliveredAtSend) / span;
      this.samples.push({ t, v });
    }
    const win = 10 * (Number.isFinite(this.minRtt) ? this.minRtt : this.rtt);
    let i = 0;
    while (i < this.samples.length && this.samples[i].t < t - win) i++;
    if (i > 64) this.samples = this.samples.slice(i); else i = 0;
    let best = 0;
    for (let k = i; k < this.samples.length; k++) if (this.samples[k].t >= t - win && this.samples[k].v > best) best = this.samples[k].v;
    this.btlbw = best;
    if (p.deliveredAtSend >= this.roundEnd) {
      this.roundEnd = this.delivered;
      if (this.state === 'startup') {
        if (this.btlbw >= this.fullBw * 1.25) { this.fullBw = this.btlbw; this.fullCount = 0; } else if (++this.fullCount >= 3) this.state = 'drain';
      }
    }
    if (this.state === 'drain' && this.inflight <= this.bdp()) { this.state = 'probe'; this.gainAt = t; this.gainIdx = 0; }
    if (this.state === 'probe' && t - this.gainAt >= this.minRtt) { this.gainIdx = (this.gainIdx + 1) % 8; this.gainAt = t; }
    const tenS = 10 / this.slotS;
    if (this.state === 'probe' && t - this.minRttAt > tenS) { this.state = 'probertt'; this.rttEnd = t + Math.max(0.2 / this.slotS, this.minRtt); this.minRtt = Infinity; this.minRttAt = t; }
    if (this.state === 'probertt' && t >= this.rttEnd) { this.state = 'probe'; this.gainAt = t; this.gainIdx = 2; }
  }
  /** A loss noticed, or a CE mark: at most one cut a round trip. */
  congest(t: number): void {
    if (this.spec.cc === 'bbr' || t <= this.recoverUntil) return;
    this.recoverUntil = t + this.rtt;
    if (this.spec.cc === 'reno' || this.spec.cc === 'dctcp') { this.cwnd = Math.max(2, this.cwnd / 2); this.ssthresh = this.cwnd; return; }
    const w = this.cwnd;
    this.wmax = !this.spec.pureCubic && w < this.lastWmax ? (w * (1 + CUBIC_BETA)) / 2 : w;
    this.lastWmax = w;
    this.k = Math.cbrt((this.wmax * (1 - CUBIC_BETA)) / CUBIC_C);
    this.cwnd = Math.max(2, w * CUBIC_BETA);
    this.ssthresh = this.cwnd; this.epoch = t; this.wEst = this.cwnd;
  }
}
const cubicCurve2 = (t: number, wmax: number, k: number): number => CUBIC_C * (t - k) ** 3 + wmax;

/** CoDel's state for one queue, RFC 8289's dequeue logic. */
export class CoDel {
  first = 0; dropping = false; dropNext = 0; count = 0; lastCount = 0;
  constructor(readonly target: number, readonly interval: number) {}
  private okToDrop(sojourn: number, t: number, qlen: number): boolean {
    if (sojourn < this.target || qlen <= 1) { this.first = 0; return false; }
    if (this.first === 0) { this.first = t + this.interval; return false; }
    return t >= this.first;
  }
  /** Should the packet at the head, with this sojourn, be dropped (or marked)? */
  verdict(sojourn: number, t: number, qlen: number): boolean {
    const ok = this.okToDrop(sojourn, t, qlen);
    if (this.dropping) {
      if (!ok) { this.dropping = false; return false; }
      if (t >= this.dropNext) { this.count++; this.dropNext = codelNext(this.dropNext, this.interval, this.count); return true; }
      return false;
    }
    if (ok) {
      this.dropping = true;
      const delta = this.count - this.lastCount;
      this.count = delta > 1 && t - this.dropNext < 16 * this.interval ? delta : 1;
      this.lastCount = this.count;
      this.dropNext = codelNext(t, this.interval, this.count);
      return true;
    }
    return false;
  }
}

/** Run the link for `seconds`, the first `warm` of them not counted. */
export function bottleneck(link: LinkSpec, flows: readonly FlowSpec[], seconds: number, warm = seconds / 4): SimResult {
  const pktBytes = link.pktBytes ?? 1500, slotS = (pktBytes * 8) / (link.mbps * 1e6), slotMs = slotS * 1000, N = flows.length, u = rng(link.seed ?? 1), aqm = link.aqm ?? 'tail';
  const T = Math.round(seconds / slotS), W = Math.round(warm / slotS);
  const senders = flows.map((f) => new Sender(f, Math.max(1, Math.round((f.rttMs / 1000) / slotS)), slotS, Math.round((f.startS ?? 0) / slotS)));
  const maxRtt = Math.max(...senders.map((s) => s.rtt)) + 2;
  // the calendar: what arrives back in each slot
  const cal: ({ p: Pkt; lost: boolean } | null)[][] = Array.from({ length: maxRtt }, () => []);
  const pingFlow = N, fifo: Pkt[] = [];
  let fifoHead = 0;
  const fq: Pkt[][] = Array.from({ length: N + 1 }, () => []), fqHead = new Array<number>(N + 1).fill(0);
  const target = (link.target ?? 5) / slotMs, interval = (link.interval ?? 100) / slotMs;
  const cod = new CoDel(target, interval), cods = Array.from({ length: N + 1 }, () => new CoDel(target, interval));
  let rr = 0, total = 0, avg = 0, redCount = 0;
  const minTh = link.bufferPkts * 0.2, maxTh = link.bufferPkts * 0.6, maxP = 0.1, wq = 0.002;
  let drops = 0, marks = 0, wireLost = 0, wirePkts = 0, out = 0, sumQ = 0, maxQ = 0, minQ = Infinity, sumDelay = 0, nDelay = 0, pingLost = 0;
  const pingDelays: number[] = [], samples: Sample[] = [], acked0 = new Array<number>(N).fill(0);
  const every = Math.max(1, Math.round(T / 400)), rateMark = new Array<number>(N).fill(0);
  const pingEvery = link.pingMs ? link.pingMs / slotMs : 0;
  let nextPing = pingEvery, lastDelay = 0;

  const notifyLost = (p: Pkt, t: number) => { if (p.flow !== pingFlow) cal[(t + senders[p.flow].rtt) % maxRtt].push({ p, lost: true }); };
  const dropAt = (p: Pkt, t: number) => { if (p.flow === pingFlow) pingLost++; else { drops++; notifyLost(p, t); } };
  const ecnOf = (p: Pkt) => p.flow !== pingFlow && flows[p.flow].ecn;

  const enqueue = (p: Pkt, t: number) => {
    if (aqm === 'step' && total >= (link.markK ?? Infinity) && ecnOf(p)) { p.ce = true; marks++; }
    if (aqm === 'red') {
      avg = (1 - wq) * avg + wq * total;
      const pb = redBase(avg, minTh, maxTh, maxP);
      if (pb >= 1) { dropAt(p, t); return; }
      if (pb > 0) {
        redCount++;
        const pa = pb / Math.max(1e-9, 1 - redCount * pb);
        if (pa >= 1 || u() < pa) {
          redCount = 0;
          if (ecnOf(p)) { p.ce = true; marks++; } else { dropAt(p, t); return; }
        }
      } else redCount = 0;
    }
    if (total >= link.bufferPkts) {
      if (aqm === 'fq') {
        // fq_codel: when full, drop at the head of the longest queue
        let L = 0, nL = -1;
        for (let i = 0; i <= N; i++) { const n = fq[i].length - fqHead[i]; if (n > nL) { nL = n; L = i; } }
        const victim = fq[L][fqHead[L]++];
        total--;
        dropAt(victim, t);
      } else { dropAt(p, t); return; }
    }
    p.enq = t;
    if (aqm === 'fq') fq[p.flow].push(p); else fifo.push(p);
    total++;
  };

  const dequeue = (t: number): Pkt | null => {
    for (;;) {
      if (total === 0) return null;
      let p: Pkt, codel: CoDel | null = null, left: number;
      if (aqm === 'fq') {
        while (fq[rr].length - fqHead[rr] === 0) rr = (rr + 1) % (N + 1);
        const q = rr;
        p = fq[q][fqHead[q]++];
        left = fq[q].length - fqHead[q];
        if (fqHead[q] > 256) { fq[q] = fq[q].slice(fqHead[q]); fqHead[q] = 0; }
        codel = cods[q];
        rr = (rr + 1) % (N + 1);
      } else {
        p = fifo[fifoHead++];
        left = fifo.length - fifoHead;
        if (fifoHead > 4096) { fifo.splice(0, fifoHead); fifoHead = 0; }
        if (aqm === 'codel') codel = cod;
      }
      total--;
      if (codel && codel.verdict(t - p.enq, t, left + 1)) {
        if (ecnOf(p)) { p.ce = true; marks++; return p; }
        dropAt(p, t);
        continue;
      }
      return p;
    }
  };

  for (let t = 0; t < T; t++) {
    const counted = t >= W;
    if (t === W) senders.forEach((s, i) => { acked0[i] = s.acked; drops = 0; marks = 0; wireLost = 0; pingLost = 0; });
    // 1. what comes back
    const bucket = cal[t % maxRtt];
    if (bucket.length) {
      for (const e of bucket) {
        const s = senders[e!.p.flow];
        if (e!.lost) { s.inflight--; s.congest(t); } else s.onAck(e!.p, t);
      }
      bucket.length = 0;
    }
    // 2. what is sent
    for (let i = 0; i < N; i++) {
      const s = senders[i];
      if (t < s.start) continue;
      if (s.paced) {
        const rate = s.btlbw > 0 ? s.gain() * s.btlbw : 1;
        s.credit = Math.min(s.credit + rate, 4);
        while (s.credit >= 1 && s.inflight < s.limit()) { s.credit -= 1; s.inflight++; enqueue({ flow: i, sentAt: t, enq: t, deliveredAtSend: s.delivered, ce: false }, t); }
      } else {
        while (s.inflight < s.cwnd) { s.inflight++; enqueue({ flow: i, sentAt: t, enq: t, deliveredAtSend: s.delivered, ce: false }, t); }
      }
      if (counted) { s.sumCwnd += s.spec.cc === 'bbr' ? s.limit() : s.cwnd; s.nCwnd++; }
    }
    if (pingEvery && t >= nextPing) { nextPing += pingEvery; enqueue({ flow: pingFlow, sentAt: t, enq: t, deliveredAtSend: 0, ce: false }, t); }
    // 3. one packet leaves
    if (counted) { sumQ += total; if (total > maxQ) maxQ = total; if (total < minQ) minQ = total; }
    const p = dequeue(t);
    if (p) {
      if (counted) out++;
      if (p.flow === pingFlow) { if (counted) pingDelays.push((t - p.enq + 1) * slotMs); }
      else {
        const d = (t - p.enq + 1) * slotMs;
        lastDelay = d;
        if (counted) { sumDelay += d; nDelay++; }
        wirePkts++;
        const lost = (link.lossP && u() < link.lossP) || (link.lossEvery && wirePkts % link.lossEvery === 0);
        if (lost) { wireLost++; notifyLost(p, t); } else cal[(t + senders[p.flow].rtt) % maxRtt].push({ p, lost: false });
      }
    }
    if (t % every === 0) {
      const dt = every * slotS;
      samples.push({ t: t * slotS, cwnd: senders.map((s) => (s.spec.cc === 'bbr' ? s.limit() : s.cwnd)), queue: total, delayMs: lastDelay, rate: senders.map((s, i) => { const v = ((s.acked - rateMark[i]) * pktBytes * 8) / dt / 1e6; rateMark[i] = s.acked; return v; }) });
    }
  }
  const secs = (T - W) * slotS, goodput = senders.map((s, i) => ((s.acked - acked0[i]) * pktBytes * 8) / secs / 1e6);
  const pd = pingDelays.slice().sort((a, b) => a - b);
  return {
    samples, goodputMbps: goodput, utilization: out / (T - W), meanQueue: sumQ / (T - W), maxQueue: maxQ,
    meanDelayMs: nDelay ? sumDelay / nDelay : 0, pingMeanMs: pd.length ? pd.reduce((a, b) => a + b, 0) / pd.length : 0, pingP95Ms: pd.length ? pd[Math.floor(pd.length * 0.95)] : 0, pingLost,
    drops, marks, wireLost, slotMs, bdpPkts: (flows[0].rttMs / slotMs),
    meanCwnd: senders.map((s) => s.sumCwnd / Math.max(1, s.nCwnd)), jain: jain(goodput), minQueue: minQ, dctcpAlpha: senders.find((s) => s.spec.cc === 'dctcp')?.alpha,
  };
}
