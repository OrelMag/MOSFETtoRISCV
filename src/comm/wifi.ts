// Wi-Fi's MAC, DOM-free: 802.11's distributed coordination function (DCF) clock by clock at 1 clock = 1 µs, so its numbers are the standard's own: the golden model lib/wifi.ts is compared with after
// every clock. The air is a model of who hears whom (Air), and so are the rates, airtimes against SNR and MIMO: the traces of this chapter are modelled, not captured, and it says so.
//
// Timing is 802.11a's OFDM PHY: slot 9 µs, SIFS 16 µs, DIFS 34 µs, CW 15 … 1023. Frames are airtime only: the medium decides what a receiver heard.
// Named simplifications: a backoff is drawn for every frame, including the first on an idle medium; no EIFS after a bad frame; no fragmentation, no QoS classes (EDCA), no beacons or association, one
// access category; a backoff slot in which the medium turns busy is lost, not resumed; NAV comes from a value the air model reads off a heard RTS or CTS; a frame is fully lost if any other transmitter is
// heard during it (no capture, no partial survival); ACK and CTS have fixed lengths.

export const SLOT_US = 9, SIFS_US = 16, DIFS_US = SIFS_US + 2 * SLOT_US, CW_MIN = 15, CW_MAX = 1023, RETRY_LIMIT = 7;
/** Airtime of a frame of `bytes` at an OFDM rate of `ndbps` data bits a 4 µs symbol: preamble and SIGNAL 20 µs, SERVICE 16 + tail 6 bits. */
export const airtimeUs = (bytes: number, ndbps: number): number => 20 + 4 * Math.ceil((22 + 8 * bytes) / ndbps);
export const RATE_24 = 96;
/** ACK and CTS are 14 bytes, RTS 20, at 24 Mb/s here: all three fit in two OFDM symbols. */
export const ACK_US = airtimeUs(14, RATE_24), CTS_US = ACK_US, RTS_US = airtimeUs(20, RATE_24);
/** How long a sender waits for its ACK or CTS to start and finish. */
export const RESP_TIMEOUT = SIFS_US + ACK_US + SLOT_US;
export const LFSR_BITS = 10;
export const lfsrNext = (q: number): number => ((q << 1) | (((q >> 9) ^ (q >> 6)) & 1)) & 1023;   // x¹⁰ + x⁷ + 1: maximal, and never stuck at 0 if seeded non-zero

export const W_IDLE = 0, W_DIFS = 1, W_BO = 2, W_TX = 3, W_WAIT = 4, W_RSIFS = 5, W_RESP = 6, W_RTS = 7, W_WCTS = 8, W_DSIFS = 9;
export const W_NAMES = ['Idle', 'Wait DIFS', 'Backoff', 'Send data', 'Wait for ACK', 'SIFS', 'Send ACK or CTS', 'Send RTS', 'Wait for CTS', 'SIFS before data'] as const;
export const KIND_NONE = 0, KIND_DATA = 1, KIND_ACK = 2, KIND_RTS = 3, KIND_CTS = 4;
export const KIND_NAMES = ['', 'DATA', 'ACK', 'RTS', 'CTS'] as const;

export interface StaIn {
  rst: number; seed: number; pending: number; len: number; use_rts: number;
  /** Carrier sense, physical: somebody heard on the air. */
  busy: number;
  /** A frame for this station has just ended whole. */
  rx_data: number; rx_ack: number; rx_rts: number; rx_cts: number;
  /** A frame for someone else announced a duration: load the NAV to at least this. */
  nav_load: number; nav_val: number;
}
export const STA_IN0: StaIn = { rst: 0, seed: 1, pending: 0, len: 0, use_rts: 0, busy: 0, rx_data: 0, rx_ack: 0, rx_rts: 0, rx_cts: 0, nav_load: 0, nav_val: 0 };

/** One station's DCF. Every assignment has a line in lib/wifi.ts. */
export class DcfStation {
  st = W_IDLE; cnt = 0; bo = 0; cw = CW_MIN; retry = 0; nav = 0; lfsr = 0; drawn = 0; respCts = 0;
  out() {
    const tx = this.st === W_TX || this.st === W_RESP || this.st === W_RTS;
    const kind = this.st === W_TX ? KIND_DATA : this.st === W_RTS ? KIND_RTS : this.st === W_RESP ? (this.respCts ? KIND_CTS : KIND_ACK) : KIND_NONE;
    return { tx: tx ? 1 : 0, kind, st: this.st, bo: this.bo, cw: this.cw, retry: this.retry, nav: this.nav, cnt: this.cnt };
  }
  /** done / drop: pulses on this edge, read before it. */
  pulses(i: StaIn) {
    const fail = (this.st === W_WAIT && !i.rx_ack && this.cnt === RESP_TIMEOUT - 1) || (this.st === W_WCTS && !i.rx_cts && this.cnt === RESP_TIMEOUT - 1);
    return { done: this.st === W_WAIT && i.rx_ack ? 1 : 0, drop: fail && this.retry === RETRY_LIMIT - 1 ? 1 : 0 };
  }
  step(i: StaIn): void {
    if (i.rst) { Object.assign(this, new DcfStation()); this.lfsr = i.seed & 1023 || 1; return; }
    const vb = i.busy || this.nav !== 0, rand = this.lfsr & this.cw;
    let st = this.st, cnt = this.cnt + 1, bo = this.bo, cw = this.cw, retry = this.retry, drawn = this.drawn;
    const toSifs = (cts: number) => { st = W_RSIFS; cnt = 0; this.respCts = cts; };
    switch (this.st) {
      case W_IDLE:
        cnt = 0;
        if (i.rx_data) toSifs(0);
        else if (i.rx_rts) toSifs(1);
        else if (i.pending) { bo = rand; st = W_DIFS; drawn = 1; }
        break;
      case W_DIFS:
        if (i.rx_data) toSifs(0);
        else if (i.rx_rts) toSifs(1);
        else if (vb) cnt = 0;
        else if (this.cnt === DIFS_US - 1) { st = W_BO; cnt = 0; }
        break;
      case W_BO:
        if (i.rx_data) toSifs(0);
        else if (i.rx_rts) toSifs(1);
        else if (vb) { st = W_DIFS; cnt = 0; }
        else if (bo === 0) { st = i.use_rts ? W_RTS : W_TX; cnt = 0; }
        else if (this.cnt === SLOT_US - 1) { bo = this.bo - 1; cnt = 0; }
        break;
      case W_RTS:
        if (this.cnt === RTS_US - 1) { st = W_WCTS; cnt = 0; }
        break;
      case W_WCTS:
        if (i.rx_cts) { st = W_DSIFS; cnt = 0; }
        else if (this.cnt === RESP_TIMEOUT - 1) {
          cnt = 0;
          if (this.retry === RETRY_LIMIT - 1) { retry = 0; cw = CW_MIN; st = W_IDLE; drawn = 0; }
          else { retry = this.retry + 1; cw = Math.min(2 * this.cw + 1, CW_MAX); bo = this.lfsr & cw; st = W_DIFS; }
        }
        break;
      case W_DSIFS:
        if (this.cnt === SIFS_US - 1) { st = W_TX; cnt = 0; }
        break;
      case W_TX:
        if (this.cnt === i.len - 1) { st = W_WAIT; cnt = 0; }
        break;
      case W_WAIT:
        if (i.rx_ack) { st = W_IDLE; cnt = 0; cw = CW_MIN; retry = 0; drawn = 0; }
        else if (this.cnt === RESP_TIMEOUT - 1) {
          cnt = 0;
          if (this.retry === RETRY_LIMIT - 1) { retry = 0; cw = CW_MIN; st = W_IDLE; drawn = 0; }
          else { retry = this.retry + 1; cw = Math.min(2 * this.cw + 1, CW_MAX); bo = this.lfsr & cw; st = W_DIFS; }
        }
        break;
      case W_RSIFS:
        if (this.cnt === SIFS_US - 1) { st = W_RESP; cnt = 0; }
        break;
      case W_RESP:
        if (this.cnt === ACK_US - 1) { st = drawn ? W_DIFS : W_IDLE; cnt = 0; }
        break;
    }
    let nav = this.nav === 0 ? 0 : this.nav - 1;
    if (i.nav_load && i.nav_val > nav) nav = i.nav_val;
    this.st = st; this.cnt = cnt; this.bo = bo; this.cw = cw; this.retry = retry; this.drawn = drawn; this.nav = nav; this.lfsr = lfsrNext(this.lfsr);
  }
}

// ---- the air ----------------------------------------------------------------------------------------------------------------
export interface AirOpts { n: number; hears: (i: number, j: number) => boolean; lenUs: number; useRts: boolean; dest: (i: number) => number; saturated: boolean[]; seeds?: number[] }
export interface AirStats { sent: number[]; delivered: number[]; dropped: number[]; collisions: number; busyUs: number; successUs: number; clock: number }
export interface AirEvent { clock: number; from: number; kind: number; to: number; ok: boolean; len: number }
interface Rx { from: number; kind: number; bad: boolean; to: number }

/** N stations on a model of the air: who hears whom, what arrives whole. stepWith lets gates stand in for the stations; both see the same inputs. */
export class Air {
  sta: DcfStation[];
  inputs: StaIn[];
  prevTx: number[];
  rx: (Rx | null)[];
  sendTo: number[];
  stats: AirStats;
  events: AirEvent[] = [];
  keepEvents = false;
  pending: number[];
  constructor(public o: AirOpts) {
    this.sta = Array.from({ length: o.n }, () => new DcfStation());
    this.inputs = Array.from({ length: o.n }, (_, i) => ({ ...STA_IN0, rst: 1, seed: o.seeds?.[i] ?? 101 + 97 * i }));
    this.prevTx = Array<number>(o.n).fill(0);
    this.rx = Array<Rx | null>(o.n).fill(null);
    this.sendTo = Array.from({ length: o.n }, (_, i) => o.dest(i));
    this.stats = { sent: Array<number>(o.n).fill(0), delivered: Array<number>(o.n).fill(0), dropped: Array<number>(o.n).fill(0), collisions: 0, busyUs: 0, successUs: 0, clock: 0 };
    this.pending = o.saturated.map((s) => (s ? 1 : 0));
    this.sta.forEach((s, i) => s.step(this.inputs[i]));
    this.inputs = this.inputs.map((x) => ({ ...x, rst: 0 }));
  }
  /** Inputs for this clock, from what each station's `outs` show and what the air carried. */
  compute(outs: { tx: number; kind: number }[]): StaIn[] {
    const n = this.o.n, ins: StaIn[] = this.inputs.map((x, i) => ({ ...STA_IN0, seed: x.seed, pending: this.pending[i], len: this.o.lenUs, use_rts: this.o.useRts ? 1 : 0 }));
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) if (j !== i && outs[j].tx && this.o.hears(i, j)) ins[i].busy = 1;
    }
    // receptions: a transmitter's first clock opens one at everyone who hears it; any second voice heard spoils it; its last clock delivers
    for (let i = 0; i < n; i++) {
      const r = this.rx[i];
      if (r) {
        const stillOn = outs[r.from].tx === 1 && outs[r.from].kind === r.kind;
        if (!stillOn) {
          this.rx[i] = null;
          if (!r.bad) {
            if (r.to === i) {
              if (r.kind === KIND_DATA || r.kind === KIND_RTS) this.lastFrom[i] = r.from;
              if (r.kind === KIND_DATA) ins[i].rx_data = 1;
              if (r.kind === KIND_ACK) ins[i].rx_ack = 1;
              if (r.kind === KIND_RTS) ins[i].rx_rts = 1;
              if (r.kind === KIND_CTS) ins[i].rx_cts = 1;
            } else {
              // a heard RTS or CTS reserves the air for the rest of the exchange: the duration field
              const v = navOf(r.kind, this.o.lenUs);
              if (v) { ins[i].nav_load = 1; ins[i].nav_val = v; }
            }
          }
        }
      }
    }
    for (let i = 0; i < n; i++) {
      const talking = outs[i].tx === 1;
      for (let j = 0; j < n; j++) {
        if (j === i || !outs[j].tx || !this.o.hears(i, j)) continue;
        const r = this.rx[i];
        if (r && r.from === j) continue;
        if (r) r.bad = true;
        else if (!this.prevTx[j] || (this.lastKind[j] !== outs[j].kind)) this.rx[i] = { from: j, kind: outs[j].kind, bad: talking || this.anyOther(i, j, outs), to: this.toOf(j, outs[j].kind) };
      }
      if (talking && this.rx[i]) this.rx[i]!.bad = true;
    }
    return ins;
  }
  private lastKind: number[] = [];
  private anyOther(i: number, j: number, outs: { tx: number }[]): boolean {
    for (let k = 0; k < this.o.n; k++) if (k !== i && k !== j && outs[k].tx && this.o.hears(i, k)) return true;
    return false;
  }
  /** A data frame or an RTS goes to the station's destination; an ACK or CTS back to whoever last sent to it. */
  private lastFrom: number[] = [];
  private toOf(j: number, kind: number): number {
    if (kind === KIND_DATA || kind === KIND_RTS) return this.sendTo[j];
    return this.lastFrom[j] ?? -1;
  }
  /** After the edge: bookkeeping that needs the stations' pulses and frames seen. */
  account(outs: { tx: number; kind: number }[], pulses: { done: number; drop: number }[]): void {
    const n = this.o.n, s = this.stats;
    let talkers = 0;
    for (let i = 0; i < n; i++) if (outs[i].tx) talkers++;
    if (talkers) s.busyUs++;
    if (talkers > 1) s.collisions++;
    for (let i = 0; i < n; i++) {
      if (outs[i].tx && (!this.prevTx[i] || this.lastKind[i] !== outs[i].kind)) {
        if (outs[i].kind === KIND_DATA) s.sent[i]++;
        if (this.keepEvents) this.events.push({ clock: s.clock, from: i, kind: outs[i].kind, to: this.toOf(i, outs[i].kind), ok: true, len: 0 });
      }
      if (pulses[i].done) { s.delivered[i]++; s.successUs += this.o.lenUs; this.pending[i] = this.o.saturated[i] ? 1 : 0; }
      if (pulses[i].drop) { s.dropped[i]++; this.pending[i] = this.o.saturated[i] ? 1 : 0; }
    }
    this.prevTx = outs.map((o) => o.tx);
    this.lastKind = outs.map((o) => o.kind);
    s.clock++;
  }
  /** A clock on the model stations. */
  step(): void {
    const outs = this.sta.map((x) => x.out());
    const ins = this.compute(outs), pulses = this.sta.map((x, i) => x.pulses(ins[i]));
    this.account(outs, pulses);
    this.sta.forEach((x, i) => x.step(ins[i]));
  }
  queue(i: number): void { this.pending[i] = 1; }
  /** For Back: everything that changes. */
  save() {
    return { sta: this.sta.map((x) => ({ ...x })), inputs: this.inputs.map((x) => ({ ...x })), prevTx: [...this.prevTx], rx: this.rx.map((r) => (r ? { ...r } : null)), stats: structuredClone(this.stats), pending: [...this.pending], lastKind: [...this.lastKind], lastFrom: [...this.lastFrom] };
  }
  load(v: ReturnType<Air['save']>): void {
    v.sta.forEach((x, i) => Object.assign(this.sta[i], x));
    this.inputs = v.inputs.map((x) => ({ ...x })); this.prevTx = [...v.prevTx]; this.rx = v.rx.map((r) => (r ? { ...r } : null)); this.stats = structuredClone(v.stats);
    this.pending = [...v.pending]; this.lastKind = [...v.lastKind]; this.lastFrom = [...v.lastFrom];
  }
}
/** The duration a heard RTS or CTS carries: what is left of the exchange after it. */
export const navOf = (kind: number, lenUs: number): number => (kind === KIND_RTS ? 3 * SIFS_US + CTS_US + lenUs + ACK_US : kind === KIND_CTS ? 2 * SIFS_US + lenUs + ACK_US : 0);

// ---- Bianchi's model ---------------------------------------------------------------------------------------------------------
export interface Bianchi { tau: number; p: number; throughput: number; slotUs: number }
/** Saturated DCF: n stations, W = CWmin + 1, m doublings. The fixed point τ(p), p(τ), and the share of air carrying payload (G. Bianchi, JSAC 2000). */
export function bianchi(n: number, lenUs: number, useRts = false, W = CW_MIN + 1, m = 6): Bianchi {
  let p = 0.1, tau = 0;
  for (let i = 0; i < 2000; i++) {
    const q = 2 * (1 - 2 * p) / ((1 - 2 * p) * (W + 1) + p * W * (1 - (2 * p) ** m));
    tau = q;
    const np = 1 - (1 - tau) ** (n - 1);
    p = 0.5 * p + 0.5 * np;
  }
  const ptr = 1 - (1 - tau) ** n, ps = (n * tau * (1 - tau) ** (n - 1)) / ptr;
  const Ts = useRts ? RTS_US + SIFS_US + CTS_US + SIFS_US + lenUs + SIFS_US + ACK_US + DIFS_US : lenUs + SIFS_US + ACK_US + DIFS_US;
  const Tc = useRts ? RTS_US + RESP_TIMEOUT + DIFS_US : lenUs + RESP_TIMEOUT + DIFS_US;
  const slot = (1 - ptr) * SLOT_US + ptr * ps * Ts + ptr * (1 - ps) * Tc;
  return { tau, p, throughput: (ps * ptr * lenUs) / slot, slotUs: slot };
}
/** Hears-everybody, all saturated, sending to station 0's peers in a ring: a shared-air throughput measured over `clocks`. */
export function measureThroughput(n: number, lenUs: number, clocks: number, useRts = false, seed = 1): { share: number; collisions: number; delivered: number } {
  const air = new Air({ n: n + 1, hears: () => true, lenUs, useRts, dest: (i) => (i === n ? 0 : n), saturated: Array.from({ length: n + 1 }, (_, i) => i < n), seeds: Array.from({ length: n + 1 }, (_, i) => (seed * 131 + i * 977) % 1023 + 1) });
  for (let c = 0; c < clocks; c++) air.step();
  return { share: air.stats.successUs / clocks, collisions: air.stats.collisions, delivered: air.stats.delivered.reduce((a, b) => a + b, 0) };
}

// ---- rates and airtime -------------------------------------------------------------------------------------------------------
/** 802.11a's eight rates, bits per OFDM symbol, and the SNR each wants: typical receiver figures, labelled constants (the standard sets sensitivities, not these). */
export interface Rate { mbps: number; ndbps: number; modulation: string; snrDb: number }
export const RATES: Rate[] = [
  { mbps: 6, ndbps: 24, modulation: 'BPSK ½', snrDb: 5 }, { mbps: 9, ndbps: 36, modulation: 'BPSK ¾', snrDb: 7 }, { mbps: 12, ndbps: 48, modulation: 'QPSK ½', snrDb: 8 }, { mbps: 18, ndbps: 72, modulation: 'QPSK ¾', snrDb: 10 },
  { mbps: 24, ndbps: 96, modulation: '16-QAM ½', snrDb: 13 }, { mbps: 36, ndbps: 144, modulation: '16-QAM ¾', snrDb: 17 }, { mbps: 48, ndbps: 192, modulation: '64-QAM ⅔', snrDb: 21 }, { mbps: 54, ndbps: 216, modulation: '64-QAM ¾', snrDb: 23 },
];
/** A frame's chance of arriving: a steep edge around the rate's SNR. A shape, not a measurement. */
export const frameOk = (snrDb: number, r: Rate): number => 1 / (1 + Math.exp(-(snrDb - r.snrDb) * 2));
/** One frame's exchange on a free channel, with the average backoff: µs of air for `bytes` delivered. */
export const exchangeUs = (bytes: number, r: Rate, backoffSlots = CW_MIN / 2): number => DIFS_US + backoffSlots * SLOT_US + airtimeUs(bytes + 28, r.ndbps) + SIFS_US + ACK_US;
export const goodputMbps = (bytes: number, r: Rate): number => (8 * bytes) / exchangeUs(bytes, r);
/** n MPDUs aggregated into one frame under one block ACK (with a 4-byte delimiter each): the airtime pays for the preamble once. */
export const aggregateMbps = (bytes: number, n: number, r: Rate): number => (8 * bytes * n) / (DIFS_US + (CW_MIN / 2) * SLOT_US + airtimeUs(n * (bytes + 32), r.ndbps) + SIFS_US + ACK_US);

export interface RateRun { policy: string; mbps: number; lost: number; frames: number; history: { us: number; mbps: number; ok: boolean; snr: number }[] }
/** Frames of `bytes` over a fading SNR: snr(us) in dB, uniform(): a seeded draw; a static rate, ARF (up after 10 good frames, down after 2 lost), or an oracle told the SNR. */
export function rateRun(policy: 'arf' | 'oracle' | number, snr: (us: number) => number, uniform: () => number, bytes: number, totalUs: number): RateRun {
  let t = 0, at = typeof policy === 'number' ? policy : 3, good = 0, bad = 0, bits = 0, lost = 0, frames = 0;
  const history: RateRun['history'] = [];
  while (t < totalUs) {
    const v = snr(t);
    if (policy === 'oracle') { let best = 0, val = 0; RATES.forEach((r, i) => { const e = frameOk(v, r) * goodputMbps(bytes, r); if (e > val) { val = e; best = i; } }); at = best; }
    const r = RATES[at], ok = uniform() < frameOk(v, r), us = ok ? exchangeUs(bytes, r) : exchangeUs(bytes, r) + 7 * SLOT_US;
    frames++;
    if (ok) { bits += 8 * bytes; good++; bad = 0; } else { lost++; bad++; good = 0; }
    if (history.length < 4000) history.push({ us: t, mbps: r.mbps, ok, snr: v });
    t += us;
    if (policy === 'arf') {
      if (good >= 10 && at < RATES.length - 1) { at++; good = 0; }
      if (bad >= 2 && at > 0) { at--; bad = 0; }
    }
  }
  return { policy: String(policy), mbps: bits / t, lost, frames, history };
}

// ---- MIMO ----------------------------------------------------------------------------------------------------------------------------
/** A 2 × 2 channel's two eigenvalues of H Hᴴ. H as [h11, h12, h21, h22], each [re, im]. */
export function eigen2x2(h: [number, number][]): [number, number] {
  const [a, b, c, d] = h, n = (z: [number, number]) => z[0] * z[0] + z[1] * z[1];
  const trace = n(a) + n(b) + n(c) + n(d);
  // det(H) = ad − bc, and λ₁λ₂ = |det H|²
  const dr = a[0] * d[0] - a[1] * d[1] - (b[0] * c[0] - b[1] * c[1]), di = a[0] * d[1] + a[1] * d[0] - (b[0] * c[1] + b[1] * c[0]), det2 = dr * dr + di * di;
  const root = Math.sqrt(Math.max(0, trace * trace - 4 * det2));
  return [(trace + root) / 2, (trace - root) / 2];
}
/** Capacity with power split evenly over two transmit antennas: Σ log₂(1 + (SNR / 2) λ). */
export const capacity2x2 = (h: [number, number][], snr: number): number => eigen2x2(h).reduce((s, l) => s + Math.log2(1 + (snr / 2) * l), 0);
