// Chapter 49's switch, DOM-free: the golden model the gates (lib/ethswitch.ts) are compared with every output every cycle, a traffic
// simulator on that model, and the closed forms the chapter quotes.
//
// The switch has four ports. A port is a byte stream each way (comm/ethframe.ts: data, valid, last, ready; a frame from the
// destination address to its last byte; one more input, `err`, rides on the last byte: the MAC found a bad FCS). A frame is written
// into one of four cells of its input's buffer. After the 12th byte the input asks the table, once: the answer is an output mask.
// Store-and-forward queues the frame at its last byte, cut-through at the answer. A queue holds cell numbers: one per input
// (`fifo`) or one per output (`voq`, virtual output queues). Each cycle every input with something to send picks the lowest
// idle output it has a frame for, and each output grants one of the inputs that picked it, round robin. A transfer reads the cell
// a byte a cycle while the output's ready is 1. Everything below is the register-transfer description of that, cycle by cycle.

import { BROADCAST, ETHERTYPE_LOCAL, frameBody, GAP_BYTES, isGroup, MAX_FRAME, type Mac } from './ethframe';

export const PORTS = 4;
/** Counters are this wide and wrap. */
export const COUNT_BITS = 16;
const CMASK = (1 << COUNT_BITS) - 1;

export interface SwitchOpts {
  /** A cell holds 2^cellK bytes; 11 holds any legal frame (the longest on the stream is 1514 bytes). */
  cellK: number;
  /** One queue per output in each input (true) or one queue per input. */
  voq: boolean;
  /** Start sending when the table has answered (true), or at the last byte (false). */
  cut: boolean;
  /** Cells in each input buffer (2, 4, 8 or 16). */
  cells: number;
  /** The table has 2^tableK entries. */
  tableK: number;
  /** One age tick every 2^tickLog2 clock cycles. */
  tickLog2: number;
}
export const DEFAULTS: SwitchOpts = { cellK: 11, cells: 4, voq: false, cut: false, tableK: 7, tickLog2: 4 };
export const withDefaults = (o: Partial<SwitchOpts> = {}): SwitchOpts => ({ ...DEFAULTS, ...o });

/** An entry younger than this many ticks is live. */
export const AGE_TICKS = 64;
export const STAMP_BITS = 8;

// ---- addresses and the hash ------------------------------------------------------------------------------------------------

/** The 48-bit address as one number, the first byte on the wire the most significant. */
export const addrOf = (m: Mac): number => m.reduce((a, b) => a * 256 + b, 0);
export const bitOf = (a: number, i: number): number => Math.floor(a / 2 ** i) % 2;
/** The first byte's low bit (bit 40 of the number) marks a group address. */
export const isGroupAddr = (a: number): boolean => bitOf(a, 40) === 1;

/** XOR-fold: hash bit i is the XOR of address bits i, i + t, i + 2t … Every address bit moves exactly one hash bit, so addresses
 *  that differ in the low bits (consecutive NICs of one maker) never collide; it is 48 − t two-input XORs. */
export function hashAddr(a: number, t: number): number {
  let h = 0;
  for (let i = 0; i < t; i++) {
    let x = 0;
    for (let j = i; j < 48; j += t) x ^= bitOf(a, j);
    h |= x << i;
  }
  return h;
}

// ---- round-robin arbiter (lib/mpdecode.ts arbiterN) ---------------------------------------------------------------------------

export class Arbiter {
  ptr = 0;
  constructor(readonly n = PORTS) {}
  /** The grant for requests `r` (a bit mask) without changing the pointer: first at or after the pointer, else the lowest. */
  pick(r: number): number {
    for (let k = 0; k < this.n; k++) { const i = (this.ptr + k) % this.n; if ((r >> i) & 1) return i; }
    return -1;
  }
  /** The clock edge: with two or more requesters the pointer moves past the winner. */
  edge(r: number): void {
    const w = this.pick(r);
    if (w >= 0 && (r & (r - 1)) !== 0) this.ptr = (w + 1) % this.n;
  }
}

// ---- the address table ------------------------------------------------------------------------------------------------------------

export interface Entry { key: number; valid: boolean; port: number; stamp: number }
export interface Lookup { mask: number; hit: boolean; flood: boolean; filtered: boolean; learned: boolean; evicted: boolean }

export class MacTable {
  entries: Entry[];
  tick = 0; ps = 0; pend = false; sidx = 0;
  learned = 0; evicted = 0; flooded = 0; filtered = 0;
  constructor(readonly t: number, readonly tl: number) {
    this.entries = Array.from({ length: 2 ** t }, () => ({ key: 0, valid: false, port: 0, stamp: 0 }));
  }
  fresh(e: Entry): boolean { return ((this.tick - e.stamp) & 255) < AGE_TICKS; }
  live(e: Entry): boolean { return e.valid && this.fresh(e); }
  /** What a lookup of `dst` for a frame from `src` on `sport` gives, without writing. */
  peek(dst: number, src: number, sport: number): Lookup {
    const d = this.entries[hashAddr(dst, this.t)], s = this.entries[hashAddr(src, this.t)];
    const hit = this.live(d) && d.key === dst;
    const group = isGroupAddr(dst);
    const flood = group || !hit;
    const filtered = !flood && d.port === sport;
    const mask = flood ? 15 & ~(1 << sport) : filtered ? 0 : 1 << d.port;
    const learnable = !isGroupAddr(src);
    const same = this.live(s) && s.key === src;
    return { mask, hit, flood, filtered, learned: learnable && !same, evicted: learnable && this.live(s) && s.key !== src };
  }
  /** One operation: the lookup of dst, then the write of src's entry (the lookup sees the old contents). */
  op(dst: number, src: number, sport: number): Lookup {
    const r = this.peek(dst, src, sport);
    if (r.flood) this.flooded = (this.flooded + 1) & CMASK;
    if (r.filtered) this.filtered = (this.filtered + 1) & CMASK;
    if (r.learned) this.learned = (this.learned + 1) & CMASK;
    if (r.evicted) this.evicted = (this.evicted + 1) & CMASK;
    if (!isGroupAddr(src)) this.entries[hashAddr(src, this.t)] = { key: src, valid: true, port: sport, stamp: this.tick };
    this.advance(true);
    return r;
  }
  /** A clock edge without an operation: the sweeper may clear one stale entry. */
  idle(): void { this.advance(false); }
  private advance(op: boolean): void {
    const pulse = this.ps === 2 ** this.tl - 1;
    const sweep = !op && this.pend;
    if (sweep) {
      const e = this.entries[this.sidx];
      if (e.valid && !this.fresh(e)) e.valid = false;
      this.sidx = (this.sidx + 1) % 2 ** this.t;
    }
    this.pend = pulse || (this.pend && op);
    if (pulse) this.tick = (this.tick + 1) & 255;
    this.ps = (this.ps + 1) % 2 ** this.tl;
  }
  /** Live entries by address, for the panels. */
  liveEntries(): Entry[] { return this.entries.filter((e) => this.live(e)); }
}

// ---- the switch -------------------------------------------------------------------------------------------------------------------

export interface PortIn { valid: number; data: number; last: number; err: number }
export interface SwitchIn { rx: PortIn[]; txReady: number[] }
export interface PortOut { valid: number; data: number; last: number }
export interface SwitchOut {
  tx: PortOut[];
  drops: number[]; bad: number[]; frames: number[];
  learned: number; evicted: number; flooded: number; filtered: number;
}
export const idleIn = (): SwitchIn => ({ rx: Array.from({ length: PORTS }, () => ({ valid: 0, data: 0, last: 0, err: 0 })), txReady: Array(PORTS).fill(1) });

class Input {
  mem: Uint16Array[];
  inFrame = false; drop = false; wslot = 0; widx = 0;
  dst = new Array(6).fill(0); src = new Array(6).fill(0);
  reqPending = false; maskValid = false; maskReg = 0;
  rem: number[];
  q: number[][];
  txActive = false; txSlot = 0; txIdx = 0;
  drops = 0; bad = 0;
  constructor(o: SwitchOpts) {
    this.rem = new Array(o.cells).fill(0);
    this.mem = Array.from({ length: o.cells }, () => new Uint16Array(2 ** o.cellK));
    this.q = Array.from({ length: o.voq ? PORTS : 1 }, () => []);
  }
}

const lowest = (m: number): number => (m & -m);
const log2 = (oneHot: number): number => 31 - Math.clz32(oneHot);

export class SwitchModel {
  readonly o: SwitchOpts;
  readonly table: MacTable;
  private ins: Input[];
  private tarb = new Arbiter();
  private oarb = Array.from({ length: PORTS }, () => new Arbiter());
  private busy = Array(PORTS).fill(false);
  private src = Array(PORTS).fill(0);
  frames = Array(PORTS).fill(0);
  cycle = 0;

  constructor(opts: Partial<SwitchOpts> = {}) {
    this.o = withDefaults(opts);
    this.table = new MacTable(this.o.tableK, this.o.tickLog2);
    this.ins = Array.from({ length: PORTS }, () => new Input(this.o));
  }

  private free(p: Input, s: number): boolean { return p.rem[s] === 0 && !(p.txActive && p.txSlot === s) && !(p.inFrame && !p.drop && p.wslot === s); }
  private avail(p: Input): boolean { return !this.o.cut || !(p.inFrame && !p.drop && p.wslot === p.txSlot) || p.txIdx !== p.widx; }
  private word(p: Input): number { return p.mem[p.txSlot][p.txIdx]; }
  private txValidOf(p: Input): boolean { return p.txActive && this.avail(p); }

  /** The outputs this cycle: they depend on the state alone (valid never waits for ready). */
  out(): SwitchOut {
    const tx: PortOut[] = [];
    for (let j = 0; j < PORTS; j++) {
      const p = this.ins[this.src[j]], on = this.busy[j] && this.txValidOf(p);
      const w = on ? this.word(p) : 0;
      tx.push({ valid: on ? 1 : 0, data: w & 255, last: (w >> 8) & 1 });
    }
    return {
      tx, drops: this.ins.map((p) => p.drops), bad: this.ins.map((p) => p.bad), frames: [...this.frames],
      learned: this.table.learned, evicted: this.table.evicted, flooded: this.table.flooded, filtered: this.table.filtered,
    };
  }

  /** Occupied cells of input i (for the panels). */
  occupancy(i: number): number { const p = this.ins[i]; return p.rem.filter((r, s) => r !== 0 || !this.free(p, s)).length; }
  queueLengths(i: number): number[] { return this.ins[i].q.map((q) => q.length); }
  isBusy(j: number): boolean { return this.busy[j]; }
  /** Nothing is being received, queued or sent. */
  quiet(): boolean { return this.ins.every((p) => !p.inFrame && !p.txActive && !p.reqPending && p.q.every((q) => q.length === 0)) && this.busy.every((b) => !b); }
  /** The cells of input i holding a frame now: [cell, remaining outputs mask]. */
  cellsOf(i: number): number[] { return this.ins[i].rem.slice(); }
  /** The input driving output j, or -1 while it is idle. */
  srcOf(j: number): number { return this.busy[j] ? this.src[j] : -1; }
  /** Everything a later step can change, copied (for Back). */
  save(): unknown { return structuredClone({ ins: this.ins, tarb: this.tarb, oarb: this.oarb, table: this.table, busy: this.busy, src: this.src, frames: this.frames, cycle: this.cycle }); }
  restore(saved: unknown): void {
    const c = structuredClone(saved) as { ins: Input[]; tarb: Arbiter; oarb: Arbiter[]; table: MacTable; busy: boolean[]; src: number[]; frames: number[]; cycle: number };
    this.ins.forEach((p, i) => Object.assign(p, c.ins[i]));
    Object.assign(this.tarb, c.tarb); this.oarb.forEach((a, i) => Object.assign(a, c.oarb[i])); Object.assign(this.table, c.table);
    this.busy = c.busy; this.src = c.src; this.frames = c.frames; this.cycle = c.cycle;
  }

  step(inp: SwitchIn): void {
    const o = this.o, ins = this.ins;
    // ---- combinational: requests to the table
    const lreq = ins.reduce((m, p, i) => m | ((p.reqPending ? 1 : 0) << i), 0);
    const lg = this.tarb.pick(lreq);
    let look: Lookup | null = null;
    if (lg >= 0) look = this.table.peek(addrOf(ins[lg].dst), addrOf(ins[lg].src), lg);
    // ---- per input: selection
    const sel = new Array(PORTS).fill(0), selSlot = new Array(PORTS).fill(0);
    for (let i = 0; i < PORTS; i++) {
      const p = ins[i];
      if (p.txActive) continue;
      let cand = 0;
      for (let j = 0; j < PORTS; j++) {
        const want = o.voq ? p.q[j].length > 0 : p.q[0].length > 0 && ((p.rem[p.q[0][0]] >> j) & 1) === 1;
        if (want && !this.busy[j]) cand |= 1 << j;
      }
      if (!cand) continue;
      sel[i] = lowest(cand);
      selSlot[i] = o.voq ? p.q[log2(sel[i])][0] : p.q[0][0];
    }
    // ---- per output: grants
    const gnt = Array(PORTS).fill(false), gOut = Array(PORTS).fill(-1);
    const rj = Array(PORTS).fill(0);
    for (let j = 0; j < PORTS; j++) {
      for (let i = 0; i < PORTS; i++) if ((sel[i] >> j) & 1) rj[j] |= 1 << i;
      const g = this.oarb[j].pick(rj[j]);
      if (g >= 0) { gnt[g] = true; gOut[j] = g; }
    }
    // ---- advance of the running transfers
    const moved = Array(PORTS).fill(false), ended = Array(PORTS).fill(false), lastMoved = Array(PORTS).fill(false);
    for (let j = 0; j < PORTS; j++) {
      if (!this.busy[j]) continue;
      const p = ins[this.src[j]];
      if (this.txValidOf(p) && inp.txReady[j]) { moved[this.src[j]] = true; if ((this.word(p) >> 8) & 1) { ended[j] = true; lastMoved[this.src[j]] = true; } }
    }
    // ---- next state, input by input (everything above was read from the old state)
    const next: Array<() => void> = [];
    for (let i = 0; i < PORTS; i++) {
      const p = ins[i], r = inp.rx[i];
      const start = !!r.valid && !p.inFrame;
      let alloc = -1;
      for (let s = 0; s < o.cells; s++) if (this.free(p, s)) { alloc = s; break; }
      const curDrop = p.inFrame ? p.drop : alloc < 0;
      const wr = !!r.valid && !curDrop;
      const curSlot = p.inFrame ? p.wslot : Math.max(alloc, 0);
      const lastAcc = wr && !!r.last;
      const lgrant = lg === i;
      let commit = false, cmask = 0;
      if (o.cut) { commit = lgrant && look!.mask !== 0; cmask = look ? look.mask : 0; }
      else { commit = lastAcc && !r.err && p.maskValid && p.maskReg !== 0; cmask = p.maskReg; }
      const snapAddr = (b: number, k: number): void => { (k < 6 ? p.dst : p.src)[k % 6] = b; };
      next.push(() => {
        // rx
        if (r.valid) {
          if (wr) {
            p.mem[curSlot][p.widx] = (r.last ? 256 : 0) | (r.data & 255);
            if (p.widx < 12) snapAddr(r.data & 255, p.widx);
          }
        }
        const reqSet = wr && p.widx === 11;
        if (start && alloc < 0) p.drops = (p.drops + 1) & CMASK;
        if (lastAcc && r.err) p.bad = (p.bad + 1) & CMASK;
        p.reqPending = reqSet || (p.reqPending && !lgrant);
        if (lgrant) { p.maskReg = look!.mask; }
        p.maskValid = r.valid && r.last ? false : lgrant ? true : p.maskValid;
        // selection result
        const g = gnt[i];
        if (g) {
          p.txActive = true; p.txSlot = selSlot[i]; p.txIdx = 0;
          p.rem[selSlot[i]] &= ~sel[i];
          if (o.voq) p.q[log2(sel[i])].shift();
          else if (p.rem[p.q[0][0]] === 0) p.q[0].shift();
        } else if (moved[i]) {
          p.txIdx++;
          if (lastMoved[i]) p.txActive = false;
        }
        if (commit) {
          p.rem[curSlot] = cmask;
          if (o.voq) { for (let j = 0; j < PORTS; j++) if ((cmask >> j) & 1) p.q[j].push(curSlot); } else p.q[0].push(curSlot);
        }
        if (r.valid) {
          p.widx = r.last ? 0 : p.widx + 1;
          if (start) p.wslot = Math.max(alloc, 0);
          p.drop = r.last ? false : p.inFrame ? p.drop : alloc < 0;
          p.inFrame = !r.last;
        }
      });
    }
    // The queue pop and the rem clear above run after the word reads of this cycle: collect word reads first (moved uses this.word)
    // before any state changed, which is why `ended` and `moved` were computed already; the closures read this.word(p) for the
    // same input only after its own tx state is untouched at that point.
    const startStats = { lg, look };
    for (const f of next) f();
    // ---- outputs' state
    for (let j = 0; j < PORTS; j++) {
      this.oarb[j].edge(rj[j]);
      const g = gOut[j];
      if (g >= 0) { this.busy[j] = true; this.src[j] = g; } else if (ended[j]) this.busy[j] = false;
      if (ended[j]) this.frames[j] = (this.frames[j] + 1) & CMASK;
    }
    this.tarb.edge(lreq);
    if (startStats.lg >= 0) this.table.op(addrOf(ins[startStats.lg].dst), addrOf(ins[startStats.lg].src), startStats.lg);
    else this.table.idle();
    this.cycle++;
  }
}

// ---- traffic ------------------------------------------------------------------------------------------------------------------------

export type Pattern = 'uniform' | 'permutation' | 'hotspot';
export const hostMac = (port: number): Mac => [0x02, 0x00, 0x00, 0x00, 0x00, port + 1];

export interface TrafficOpts { pattern: Pattern; load: number; frameBytes: number; cycles: number; seed: number; hot?: number; opts?: Partial<SwitchOpts> }
export interface TrafficResult {
  offered: number; throughput: number; meanDelay: number; delivered: number; sent: number; drops: number; opts: SwitchOpts;
  /** Throughput of each output as a fraction of one byte a cycle. */
  perOutput: number[];
}

export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

/** A frame of `bytes` stream bytes (at least 60) from port src to host dst, the id in the first payload bytes. */
export function trafficFrame(src: number, dst: number, id: number, bytes: number): number[] {
  const plen = Math.max(0, bytes - 14);
  const payload = Array.from({ length: Math.max(plen, 4) }, (_, k) => (k < 4 ? (id >> (8 * (3 - k))) & 255 : (id + k) & 255));
  const f = frameBody({ dst: hostMac(dst), src: hostMac(src), type: ETHERTYPE_LOCAL, payload });
  return f;
}

/** The frame each host sends once to teach the table where it is. */
export const teachFrames = (): number[][] => Array.from({ length: PORTS }, (_, p) => frameBody({ dst: BROADCAST, src: hostMac(p), type: ETHERTYPE_LOCAL, payload: [0, 0, 0, 0] }));

function teach(m: SwitchModel): void {
  // each host speaks once to the broadcast address, which teaches the table where it is
  const frames = teachFrames();
  for (let p = 0; p < PORTS; p++) {
    for (const [k, b] of frames[p].entries()) {
      const i = idleIn();
      i.rx[p] = { valid: 1, data: b, last: k === frames[p].length - 1 ? 1 : 0, err: 0 };
      m.step(i);
    }
    for (let k = 0; k < 40; k++) m.step(idleIn());
  }
  for (let k = 0; k < 400; k++) m.step(idleIn());
}

/** Drive the model with Bernoulli-gapped frames at an offered load (fraction of one byte a cycle on each input) and measure. */
export function runTraffic(t: TrafficOpts): TrafficResult {
  const m = new SwitchModel(t.opts), R = rng(t.seed);
  teach(m);
  const base = m.out();
  const queue: Array<{ bytes: number[]; k: number; id: number }> = [];
  void queue;
  const srcs = Array.from({ length: PORTS }, () => ({ cur: null as number[] | null, k: 0, gap: 0 }));
  const t0 = new Map<number, number>();
  let id = 1, sent = 0, delivered = 0, delaySum = 0, bytesOut = 0;
  const per = Array(PORTS).fill(0);
  const cur = Array.from({ length: PORTS }, () => ({ id: 0, k: 0 }));
  const meanGap = t.load >= 1 ? 0 : t.frameBytes * (1 - t.load) / t.load;
  const pick = (i: number): number => {
    const others = [0, 1, 2, 3].filter((x) => x !== i);
    if (t.pattern === 'permutation') return (i + 1) % PORTS;
    if (t.pattern === 'hotspot' && i !== (t.hot ?? 0) && R() < 0.5) return t.hot ?? 0;
    return others[Math.floor(R() * others.length)];
  };
  for (let c = 0; c < t.cycles; c++) {
    const inp = idleIn();
    for (let i = 0; i < PORTS; i++) {
      const s = srcs[i];
      if (!s.cur) {
        if (s.gap > 0) s.gap--;
        else { s.cur = trafficFrame(i, pick(i), id, t.frameBytes); s.k = 0; t0.set(id, c); id++; sent++; }
      }
      if (s.cur) {
        inp.rx[i] = { valid: 1, data: s.cur[s.k], last: s.k === s.cur.length - 1 ? 1 : 0, err: 0 };
        if (++s.k === s.cur.length) { s.cur = null; s.gap = meanGap > 0 ? Math.floor(-Math.log(1 - R()) * meanGap) : 0; }
      }
    }
    const o = m.out();
    for (let j = 0; j < PORTS; j++) {
      const tx = o.tx[j];
      if (tx.valid) {
        const c2 = cur[j];
        if (c2.k >= 14 && c2.k < 18) c2.id = (c2.id << 8) | tx.data;
        c2.k++;
        bytesOut++; per[j]++;
        if (tx.last) { delaySum += c - (t0.get(c2.id) ?? c); delivered++; cur[j] = { id: 0, k: 0 }; }
      }
    }
    m.step(inp);
  }
  return {
    offered: t.load, throughput: bytesOut / (t.cycles * PORTS), meanDelay: delivered ? delaySum / delivered : 0, delivered, sent,
    drops: m.out().drops.reduce((a, b, k) => a + b - base.drops[k], 0), opts: m.o, perOutput: per.map((x) => x / t.cycles),
  };
}

export interface Single { firstIn: number; firstOut: number; lastIn: number; lastOut: number; delivered: number; bad: number; dropped: number }

/** One frame of `bytes` from port 0 to host 1 through a switch whose table has learned the hosts, at one byte a cycle; times from its first byte in. */
export function singleFrame(opts: Partial<SwitchOpts>, bytes: number, err = false): Single {
  const m = new SwitchModel(opts);
  teach(m);
  const f = trafficFrame(0, 1, 1, bytes);
  const r: Single = { firstIn: 0, firstOut: -1, lastIn: f.length - 1, lastOut: -1, delivered: 0, bad: 0, dropped: 0 };
  const before = m.out();
  for (let c = 0; c < f.length + 600; c++) {
    const i = idleIn();
    if (c < f.length) i.rx[0] = { valid: 1, data: f[c], last: c === f.length - 1 ? 1 : 0, err: err && c === f.length - 1 ? 1 : 0 };
    const o = m.out();
    if (o.tx[1].valid) { if (r.firstOut < 0) r.firstOut = c; if (o.tx[1].last) { r.lastOut = c; r.delivered++; } }
    m.step(i);
  }
  r.bad = m.out().bad[0] - before.bad[0];
  return r;
}

// ---- head-of-line blocking in the abstract (fixed cells, one slot each) --------------------------------------------------------

/**
 * The classic experiment: N inputs always have a cell to send, destinations uniform over the N outputs, one cell per output per slot.
 * With one FIFO per input only the head contends (random winner per output); with virtual output queues a maximum matching is found.
 */
export function holSaturation(N: number, voq: boolean, slots: number, seed = 1, self = true): number {
  const R = rng(seed);
  let served = 0;
  /** A destination for input i: any output, or (self = false) any but i, as on a switch whose frames never return to their port. */
  const dest = (i: number): number => (self ? Math.floor(R() * N) : (i + 1 + Math.floor(R() * (N - 1))) % N);
  if (!voq) {
    const head = Array.from({ length: N }, (_, i) => dest(i));
    for (let s = 0; s < slots; s++) {
      const by: number[][] = Array.from({ length: N }, () => []);
      head.forEach((d, i) => by[d].push(i));
      for (let d = 0; d < N; d++) {
        if (!by[d].length) continue;
        const w = by[d][Math.floor(R() * by[d].length)];
        head[w] = dest(w);
        served++;
      }
    }
  } else {
    // saturated VOQs are never empty: a perfect matching exists every slot
    served = N * slots;
  }
  return served / (N * slots);
}

/** Karol, Hluchyj and Morgan's saturation throughput of an input-queued N × N switch: 2 − √2 as N grows. */
export const HOL_LIMIT = 2 - Math.SQRT2;
/** The same paper's value for N = 4, as commonly tabulated (0.6553). */
export const HOL_N4 = 0.6553;

// ---- statistical multiplexing -----------------------------------------------------------------------------------------------------

/** P(X > c) for X ~ Binomial(n, p). */
export function binomialTail(n: number, p: number, c: number): number {
  let t = 0, term = (1 - p) ** n;
  for (let k = 0; k <= n; k++) {
    if (k > c) t += term;
    term = (term * (n - k) / (k + 1)) * (p / (1 - p));
  }
  return t;
}

/** Capacity (in peak-rate units) a shared link needs so that n on/off sources with activity p overflow with probability below eps. */
export function sharedCapacity(n: number, p: number, eps: number): number {
  let c = 0;
  while (binomialTail(n, p, c) > eps) c++;
  return c;
}

/** P(X = k) for X ~ Binomial(n, p). */
export function binomialPmf(n: number, p: number, k: number): number {
  let lg = 0;
  for (let i = 1; i <= k; i++) lg += Math.log((n - k + i) / i);
  return Math.exp(lg + k * Math.log(p) + (n - k) * Math.log(1 - p));
}

// ---- timing ------------------------------------------------------------------------------------------------------------------------------

/** Wire time of a frame of `bytes` (destination to FCS) plus preamble and SFD, in bit times. */
export const wireBits = (bytes: number): number => (bytes + 8) * 8;
/** Latency a store-and-forward switch adds to a frame of `bytes` (stream bytes + FCS) at one hop: the whole frame once more. */
export const storeAndForwardBits = (bytes: number): number => wireBits(bytes);
/** Cut-through starts sending after the destination address has been read (6 bytes), plus preamble: the least a switch can wait. */
export const cutThroughBits = (lookupBytes = 6): number => (8 + lookupBytes) * 8;
export const maxFrameBytes = MAX_FRAME;
export const interFrameBits = GAP_BYTES * 8;
export { isGroup };
