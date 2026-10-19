// The DRAM controller and device of chapter 34, as cycle-exact reference models. The gate-level
// controller (lib/dramctrl.ts) is checked against CtrlModel cycle by cycle; the device leaf behind it
// is DeviceModel itself. One request (a 4-word line, read or written) at a time, as the caches' miss
// controller issues them.
//
// Timing of a cycle: the controller's outputs depend on its state and this cycle's request (Mealy);
// the device samples the command at the rising edge that ends the cycle. A read issued in cycle c
// returns word w in cycle c + tCAS + w; a write takes word w from the controller in that same cycle.

import { type DramTiming, TIMING, type PagePolicy } from './timing';

/** Device commands (the controller's cmd output). */
export const Cmd = { NOP: 0, ACT: 1, RD: 2, WR: 3, PRE: 4, PREA: 5, REF: 6 } as const;
export const CMD_NAMES = ['NOP', 'ACT', 'RD', 'WR', 'PRE', 'PREA', 'REF'];

export interface DramConfig {
  /** 2^k words of memory. */
  k: number;
  banks: number;
  /** Words per row (a power of two, at least a line). */
  rowWords: number;
  policy: PagePolicy;
  /** XOR the row's parity into the bank number. */
  hash?: boolean;
  t?: DramTiming;
}

/** Address fields of a line address (k − 2 bits): column = the line in its row, then bank, then row. */
export function fieldWidths(c: DramConfig): { cb: number; bb: number; rb: number } {
  const cb = Math.log2(c.rowWords / 4), bb = Math.log2(c.banks), rb = c.k - 2 - cb - bb;
  if (!Number.isInteger(cb) || !Number.isInteger(bb) || rb < 1) throw new Error(`bad DRAM geometry ${JSON.stringify(c)}`);
  return { cb, bb, rb };
}

export function splitLine(c: DramConfig, la: number): { col: number; bank: number; row: number } {
  const { cb, bb } = fieldWidths(c);
  const col = la & ((1 << cb) - 1), row = la >>> (cb + bb);
  let bank = (la >>> cb) & ((1 << bb) - 1);
  if (c.hash && bb > 0) {
    let p = 0;
    for (let r = row; r; r >>>= 1) p ^= r & 1;
    bank ^= p;
  }
  return { col, bank, row };
}

/** A REF may be postponed this many times (DDR4: 8) before the device loses data. */
export const MAX_POSTPONE = 8;

/** dm: the data mask of a write burst's word (DDR's DM pins), bit i = byte i written; omitted: all four. */
export interface DeviceIn { cmd: number; ba: number; ra: number; ca: number; wd: number; dm?: number }
export interface DeviceOut { rd: number; rv: boolean; err: boolean }

/**
 * A DRAM device: banks of rows, a row buffer per bank, and every timing rule a controller must keep.
 * A command that breaks one sets `err` (sticky) and names the rule in `why`; the burst it starts reads X.
 * Words are addressed {row, bank, column, word} so the controller's line address maps straight on.
 */
export class DeviceModel {
  readonly mem: Uint32Array;
  readonly x: Uint8Array;
  readonly t: DramTiming;
  /** Per bank: the open row (−1 closed), cycle of its last ACT and of its last PRE. */
  open: number[];
  lastAct: number[];
  lastPre: number[];
  cycle = 0;
  lastRef = 0;
  refBusyUntil = -1;
  err = false;
  why = '';
  /** Bursts in flight: data word w of a read is out in cycle at + w; a write takes it then. */
  private bursts: { at: number; base: number; write: boolean; bad: boolean }[] = [];
  /** What the outputs show during the current cycle. */
  out: DeviceOut = { rd: 0, rv: false, err: false };

  constructor(readonly c: DramConfig, init?: ArrayLike<number>) {
    this.t = c.t ?? TIMING;
    this.mem = new Uint32Array(2 ** c.k);
    this.x = new Uint8Array(2 ** c.k);
    // initial words by CPU address, stored where the mapping puts them
    if (init) for (let a = 0; a < Math.min(init.length, this.mem.length); a++) {
      const { col, bank, row } = splitLine(c, a >>> 2);
      this.mem[this.addr(bank, row, col, a & 3)] = init[a] >>> 0;
    }
    this.open = new Array<number>(c.banks).fill(-1);
    this.lastAct = new Array<number>(c.banks).fill(-1e9);
    this.lastPre = new Array<number>(c.banks).fill(-1e9);
  }

  private fail(why: string): void {
    if (!this.err) this.why = `cycle ${this.cycle}: ${why}`;
    this.err = true;
  }

  /** The word address of word w of the line at (bank, row, col). */
  addr(bank: number, row: number, col: number, w = 0): number {
    const { cb, bb } = fieldWidths(this.c);
    return ((((row << bb) | bank) << cb | col) << 2) | w;
  }

  /** Word `a` of the CPU's address space (the line address mapped as the controller maps it); −1 if unknown. */
  read(a: number): number {
    const { col, bank, row } = splitLine(this.c, a >>> 2), i = this.addr(bank, row, col, a & 3);
    return this.x[i] ? -1 : this.mem[i];
  }

  /** The rising edge at the end of the current cycle, with that cycle's inputs; then the next cycle's outputs. */
  edge(i: DeviceIn): DeviceOut {
    const now = this.cycle, t = this.t;
    // the data cycle that is ending: a write burst takes its word now
    for (const b of this.bursts) {
      const w = now - b.at;
      if (b.write && w >= 0 && w < 4) {
        const a = b.base + w, dm = i.dm ?? 15;
        if (dm === 0) continue;
        if (b.bad || i.wd < 0) this.x[a] = 1;
        else if (dm === 15) { this.mem[a] = i.wd >>> 0; this.x[a] = 0; } else {
          // a masked write keeps the other bytes (an unknown word stays unknown)
          let m = 0;
          for (let k = 0; k < 4; k++) if ((dm >> k) & 1) m |= 0xff << (8 * k);
          this.mem[a] = ((this.mem[a] & ~m) | (i.wd & m)) >>> 0;
        }
      }
    }
    this.bursts = this.bursts.filter((b) => now - b.at < 3);
    const busy = now < this.refBusyUntil;
    if (i.cmd !== Cmd.NOP && busy) this.fail(`${CMD_NAMES[i.cmd]} during a refresh (tRFC)`);
    const bank = i.ba;
    switch (i.cmd) {
      case Cmd.ACT:
        if (this.open[bank] >= 0) this.fail(`ACT to bank ${bank} with row ${this.open[bank]} open`);
        if (now - this.lastPre[bank] < t.tRP) this.fail(`ACT to bank ${bank} ${now - this.lastPre[bank]} cycles after its PRE (tRP ${t.tRP})`);
        this.open[bank] = i.ra;
        this.lastAct[bank] = now;
        break;
      case Cmd.RD: case Cmd.WR: {
        let bad = false;
        if (this.open[bank] < 0) { this.fail(`${CMD_NAMES[i.cmd]} to closed bank ${bank}`); bad = true; }
        else if (now - this.lastAct[bank] < t.tRCD) { this.fail(`${CMD_NAMES[i.cmd]} ${now - this.lastAct[bank]} cycles after ACT (tRCD ${t.tRCD})`); bad = true; }
        this.bursts.push({ at: now + t.tCAS, base: this.addr(bank, Math.max(0, this.open[bank]), i.ca), write: i.cmd === Cmd.WR, bad });
        break;
      }
      case Cmd.PRE: case Cmd.PREA:
        for (let b = 0; b < this.c.banks; b++) {
          if (i.cmd === Cmd.PRE && b !== bank) continue;
          if (this.open[b] >= 0 && now - this.lastAct[b] < t.tRAS) this.fail(`PRE of bank ${b} ${now - this.lastAct[b]} cycles after its ACT (tRAS ${t.tRAS})`);
          if (this.open[b] >= 0) this.lastPre[b] = now;
          this.open[b] = -1;
        }
        break;
      case Cmd.REF:
        if (this.open.some((r) => r >= 0)) this.fail('REF with a bank open');
        if (this.lastPre.some((p) => now - p < t.tRP)) this.fail('REF before tRP');
        this.refBusyUntil = now + t.tRFC;
        this.lastRef = now;
        break;
    }
    // refresh postponed too long: the rows it should have kept are gone
    if (now - this.lastRef > (MAX_POSTPONE + 1) * t.tREFI) {
      this.fail(`no REF for ${now - this.lastRef} cycles: data lost`);
      this.x.fill(1);
      this.lastRef = now;
    }
    this.cycle = now + 1;
    // the next cycle's read data
    const b = this.bursts.find((q) => !q.write && this.cycle - q.at >= 0 && this.cycle - q.at < 4);
    const a = b ? b.base + (this.cycle - b.at) : -1;
    this.out = { rd: !b ? 0 : b.bad || this.x[a] ? -1 : this.mem[a], rv: !!b, err: this.err };
    return this.out;
  }
}

/** The device model inside a simulation leaf's state (lib/dramctrl.ts dramDevice), if it is one. */
export const deviceIn = (s: unknown): DeviceModel | null =>
  s && typeof s === 'object' && 'dev' in s && (s as { dev: unknown }).dev instanceof DeviceModel ? (s as { dev: DeviceModel }).dev : null;

/** Controller states (the gate-level controller's one-hot flip-flops, in this order). */
export const ST = { IDLE: 0, WPRE: 1, WACT: 2, BURST: 3, CLOSE: 4, WCLOSE: 5, WREF1: 6, WREF2: 7 } as const;
export const ST_NAMES = ['IDLE', 'WPRE', 'WACT', 'BURST', 'CLOSE', 'WCLOSE', 'WREF1', 'WREF2'];

export interface CtrlIn { req: boolean; wr: boolean; la: number }
export interface CtrlOut {
  cmd: number; ba: number; ra: number; ca: number;
  /** The word of the burst in this cycle; a read's word is valid (dv), a write's is taken (wv). */
  word: number; dv: boolean; wv: boolean;
  /** The last word of the request's burst: the cache finishes at this edge. */
  done: boolean;
  /** How this request found its bank (in the cycle it starts): row hit, miss (closed) or conflict. */
  hit: boolean; miss: boolean; conflict: boolean;
}

/**
 * The controller: one request at a time from the cache (held until done). In IDLE a due refresh
 * goes first (precharge all, REF, wait tRFC); else a request is a row hit (RD / WR now), a miss (ACT,
 * then RD / WR after tRCD) or a conflict (PRE, ACT after tRP, ...). The burst ends tCAS + 3 cycles
 * after the column command. Open page leaves the row open; closed page precharges it at once.
 */
export class CtrlModel {
  readonly t: DramTiming;
  state: number = ST.IDLE;
  /** The wait counter: loaded on entering a state, down to 0. */
  cnt = 0;
  open: number[];
  cur = { wr: false, bank: 0, row: 0, col: 0 };
  refCnt = 0;
  refPend = false;
  stats = { hits: 0, misses: 0, conflicts: 0, refreshes: 0, busy: 0 };

  constructor(readonly c: DramConfig) {
    this.t = c.t ?? TIMING;
    this.open = new Array<number>(c.banks).fill(-1);
  }

  /** This cycle's outputs (no state change). */
  outputs(i: CtrlIn): CtrlOut {
    const t = this.t, s = this.state, z = this.cnt === 0;
    const live = splitLine(this.c, i.la);
    const o: CtrlOut = { cmd: Cmd.NOP, ba: 0, ra: 0, ca: 0, word: 0, dv: false, wv: false, done: false, hit: false, miss: false, conflict: false };
    const at = s === ST.IDLE ? live : this.cur;
    o.ba = at.bank; o.ra = at.row; o.ca = at.col;
    const rw = (wr: boolean) => (wr ? Cmd.WR : Cmd.RD);
    if (s === ST.IDLE) {
      if (this.refPend) o.cmd = this.open.some((r) => r >= 0) ? Cmd.PREA : Cmd.REF;
      else if (i.req) {
        const r = this.open[live.bank];
        o.hit = r === live.row; o.conflict = r >= 0 && r !== live.row; o.miss = r < 0;
        o.cmd = o.hit ? rw(i.wr) : o.miss ? Cmd.ACT : Cmd.PRE;
      }
    } else if (s === ST.WPRE && z) o.cmd = Cmd.ACT;
    else if (s === ST.WACT && z) o.cmd = rw(this.cur.wr);
    else if (s === ST.CLOSE) o.cmd = Cmd.PRE;
    else if (s === ST.WREF1 && z) o.cmd = Cmd.REF;
    else if (s === ST.BURST && this.cnt < 4) {
      o.word = 3 - this.cnt;
      o.dv = !this.cur.wr; o.wv = this.cur.wr;
      o.done = z;
    }
    void t;
    return o;
  }

  /** The rising edge ending this cycle. */
  edge(i: CtrlIn): CtrlOut {
    const o = this.outputs(i), t = this.t, s = this.state, z = this.cnt === 0;
    if (s === ST.IDLE && !this.refPend && i.req) {
      this.cur = { wr: i.wr, ...splitLine(this.c, i.la) };
      if (o.hit) this.stats.hits++; else if (o.miss) this.stats.misses++; else this.stats.conflicts++;
    }
    let next = s, load = -1;
    switch (o.cmd) {
      case Cmd.PREA: next = ST.WREF1; load = t.tRP - 1; break;
      case Cmd.REF: next = ST.WREF2; load = t.tRFC - 2; this.refPend = false; this.stats.refreshes++; break;
      case Cmd.RD: case Cmd.WR: next = ST.BURST; load = t.tCAS + 2; break;
      case Cmd.ACT: next = ST.WACT; load = t.tRCD - 1; break;
      case Cmd.PRE: next = s === ST.CLOSE ? ST.WCLOSE : ST.WPRE; load = t.tRP - (s === ST.CLOSE ? 2 : 1); break;
    }
    if (o.cmd === Cmd.NOP && z && (s === ST.WCLOSE || s === ST.WREF2)) next = ST.IDLE;
    if (o.done) next = this.c.policy === 'open' ? ST.IDLE : ST.CLOSE;
    // the open-row table follows the commands
    if (o.cmd === Cmd.ACT) this.open[o.ba] = o.ra;
    if (o.cmd === Cmd.PRE) this.open[o.ba] = -1;
    if (o.cmd === Cmd.PREA) this.open.fill(-1);
    if (s !== ST.IDLE || o.cmd !== Cmd.NOP) this.stats.busy++;
    this.cnt = load >= 0 ? load : next !== s ? 0 : Math.max(0, this.cnt - 1);
    this.state = next;
    // refresh: due every tREFI cycles
    if (this.refCnt === t.tREFI - 1) { this.refCnt = 0; this.refPend = true; } else this.refCnt++;
    return o;
  }
}

/**
 * A cache-side driver for the models: transfer a 4-word line (read or write) through controller and
 * device, cycle by cycle, from the cycle the request is raised. Returns the words read and the cycles
 * the request took (raise → done, inclusive).
 */
export function transfer(ctrl: CtrlModel, dev: DeviceModel, wr: boolean, la: number, data: number[] = [0, 0, 0, 0]): { words: number[]; cycles: number } {
  const words: number[] = [];
  for (let n = 1; n < 10_000; n++) {
    const o = ctrl.outputs({ req: true, wr, la });
    if (o.dv) words[o.word] = dev.out.rd;
    dev.edge({ cmd: o.cmd, ba: o.ba, ra: o.ra, ca: o.ca, wd: o.wv ? data[o.word] : 0 });
    ctrl.edge({ req: true, wr, la });
    if (o.done) return { words, cycles: n };
  }
  throw new Error('request never finished');
}

/** Idle cycles: no request (refresh still runs). */
export function idle(ctrl: CtrlModel, dev: DeviceModel, n: number): void {
  for (let k = 0; k < n; k++) {
    const o = ctrl.outputs({ req: false, wr: false, la: 0 });
    dev.edge({ cmd: o.cmd, ba: o.ba, ra: o.ra, ca: o.ca, wd: 0 });
    ctrl.edge({ req: false, wr: false, la: 0 });
  }
}
