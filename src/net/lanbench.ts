// Two computers and what lies between them, at model speed: the golden model on each CPU, comm/nic.ts's NIC and comm/mac.ts's MACs, on one clock.
// Chapter 52's long transfers run here. A load or store on the bus costs a clock more; contention between the CPU and the NIC's DMA is not modelled, which
// puts chapter 50's ping within 5 clocks of the gates' 14 689 (tests/net-lanbench.test.ts). Between the computers: chapter 50's switch model, or a router
// as a queue in front of a slower link, frame by frame: it decrements the TTL, fixes the checksum and rewrites the addresses as chapter 51's fast path does.

import { BusModel } from '../bus/model';
import { idleIn, SwitchModel, type SwitchOpts } from '../comm/ethswitch';
import { BYTE_CLOCKS, MacRx, MacTx } from '../comm/mac';
import { STACK_RAM_K } from '../comm/stack/layout';
import { OPCODES } from '../riscv/isa';
import { ISS } from '../riscv/iss';

const ZERO_MAC = [0, 0, 0, 0, 0, 0];
const TX_SEED = 0x155;

/** What sits at a port: the pins, and a clock. */
export interface Endpoint { rxd: number; crs: number; readonly txd: number; readonly txen: number; clock(c: number): void }

/** A CPU and its NIC. */
export class Host implements Endpoint {
  readonly bus = new BusModel(STACK_RAM_K, [], 4096, { nic: {} });
  readonly iss: ISS;
  private wait = 0;
  /** The wire at this NIC's pins, this clock. */
  rxd = 0; crs = 0;
  constructor(words: ArrayLike<number>, imemK: number) {
    this.iss = new ISS(words as number[], { system: true, imemWords: 2 ** imemK, bus: this.bus });
    this.bus.nic!.line = () => ({ rxd: this.rxd, crs: this.crs });
  }
  get txd(): number { return this.bus.nic!.core.tx.txd; }
  get txen(): number { return this.bus.nic!.core.tx.txen; }
  /** Clock c (from 0): the NIC's edge, and the instruction that retires then. */
  clock(c: number): void {
    this.bus.nic!.advanceTo(c + 1);
    if (this.wait > 0) { this.wait--; return; }
    if (this.iss.halted) return;
    const w = this.iss.fetch(this.iss.pc), op = w & 0x7f;
    let extra = 0;
    if (op === OPCODES.LOAD || op === OPCODES.STORE) {
      const imm = op === OPCODES.LOAD ? w >> 20 : ((w >> 25) << 5) | ((w >>> 7) & 31);
      if (((this.iss.x[(w >>> 15) & 31] + imm) >>> 0) < 0x80000000) extra = 1;
    }
    this.wait = extra;
    this.bus.now = c + 1 + extra;
    this.iss.mtime = c + extra;
    this.iss.step();
  }
  /** No bus access under way: the next clock starts an instruction. */
  get atBoundary(): boolean { return this.wait === 0; }
  /** A word of its RAM. */
  word(a: number): number { return this.bus.ram[a >>> 2] >>> 0; }
}

export interface StreamByte { valid: number; data: number; last: number }
export type RxByte = StreamByte & { err: number };

/** What carries frames between the two MAC pairs. */
export interface Middle {
  /** Clock c: the bytes the receivers offer, whether each transmitter takes one; returns the byte each transmitter is offered. */
  step(c: number, rx: RxByte[], ready: number[]): StreamByte[];
}

/** Chapter 50's switch. */
export class SwitchMiddle implements Middle {
  private readonly sw: SwitchModel;
  private readonly inp = idleIn();
  constructor(o: Partial<SwitchOpts> = { cellK: 7, cells: 2 }) { this.sw = new SwitchModel(o); }
  step(_c: number, rx: RxByte[], ready: number[]): StreamByte[] {
    const o = this.sw.out();
    for (let p = 0; p < 2; p++) { this.inp.rx[p] = rx[p]; this.inp.txReady[p] = ready[p]; }
    this.sw.step(this.inp);
    return [o.tx[0], o.tx[1]];
  }
}

export interface RouterOptions {
  /** Each port's host and the router's own address on it. */
  ports: { host: readonly number[]; mac: readonly number[] }[];
  /** Frames that fit in the queue of each direction, the one in service included. */
  queue: number;
  /** Clocks a byte takes on the slow link beyond the router (at least the wire's 32), per direction: [to port 0, to port 1]. */
  byteClocks?: [number, number];
  /** One way, on top of the wire, clocks. */
  delay?: number;
  /** Decides a frame's fate (true: lost, as noise would). */
  lose?: (from: number, frame: number[]) => boolean;
}

export type Fate = 'queued' | 'drop' | 'lost' | 'bad';
export interface RouterLog { t: number; from: number; bytes: number[]; fate: Fate; depth: number }

/** A router as a queue: a frame that finds it full is dropped at the tail, and what is waiting is the delay the chapter plots. */
export class RouterMiddle implements Middle {
  private readonly q: { frame: number[]; at: number }[][] = [[], []];
  private readonly cur: (number[] | null)[] = [null, null];
  private readonly sending: (number[] | null)[] = [null, null];
  private readonly idx = [0, 0];
  private readonly nextFree = [0, 0];
  private readonly idle: StreamByte = { valid: 0, data: 0, last: 0 };
  drops = 0; lost = 0; forwarded = 0;
  /** Every frame, in the order it arrived, when asked for. */
  log: RouterLog[] | null = null;
  constructor(readonly o: RouterOptions) {}

  private route(f: number[], to: number): number[] | null {
    if (f.length < 34 || f[12] !== 8 || f[13] !== 0 || f[22] <= 1) return null;
    const out = f.slice();
    out[22]--;
    // RFC 1624's update: the TTL is the top byte of its word
    let s = (~((f[24] << 8) | f[25]) & 0xffff) + (~((f[22] << 8) | f[23]) & 0xffff) + ((out[22] << 8) | out[23]);
    while (s > 0xffff) s = (s & 0xffff) + (s >>> 16);
    s = ~s & 0xffff;
    out[24] = s >> 8; out[25] = s & 255;
    this.o.ports[to].host.forEach((b, i) => { out[i] = b; });
    this.o.ports[to].mac.forEach((b, i) => { out[6 + i] = b; });
    return out;
  }

  step(c: number, rx: RxByte[], ready: number[]): StreamByte[] {
    const res: StreamByte[] = [this.idle, this.idle];
    for (let p = 0; p < 2; p++) {
      const r = rx[p];
      if (!r.valid) continue;
      (this.cur[p] ??= []).push(r.data);
      if (!r.last) continue;
      const f = this.cur[p]!, to = 1 - p, depth = this.depth(to);
      this.cur[p] = null;
      const out = r.err ? null : this.route(f, to);
      let fate: Fate = 'queued';
      if (!out) fate = 'bad';
      else if (this.o.lose?.(p, f)) { fate = 'lost'; this.lost++; }
      else if (depth >= this.o.queue) { fate = 'drop'; this.drops++; }
      else this.q[to].push({ frame: out, at: c + (this.o.delay ?? 0) });
      this.log?.push({ t: c, from: p, bytes: f, fate, depth });
    }
    for (let to = 0; to < 2; to++) {
      if (!this.sending[to] && this.q[to].length && c >= this.q[to][0].at && c >= this.nextFree[to]) {
        const s = this.q[to].shift()!;
        this.sending[to] = s.frame; this.idx[to] = 0;
        this.nextFree[to] = c + s.frame.length * (this.o.byteClocks?.[to] ?? BYTE_CLOCKS);
        this.forwarded++;
      }
      const s = this.sending[to];
      if (s) {
        const i = this.idx[to], last = i === s.length - 1;
        res[to] = { valid: 1, data: s[i], last: last ? 1 : 0 };
        if (ready[to]) { this.idx[to]++; if (last) this.sending[to] = null; }
      }
    }
    return res;
  }
  /** Frames waiting towards a port, the one in service included. */
  depth(to: number): number { return this.q[to].length + (this.sending[to] ? 1 : 0); }
}

/** Two hosts, a MAC pair a port, and the middle. */
export class LanBench {
  readonly rx = [new MacRx(), new MacRx()];
  readonly tx = [new MacTx(), new MacTx()];
  c = 0;
  /** What takes each port's clocks: the host, or gates in its place. */
  readonly ends: Endpoint[];
  private readonly rin: RxByte[] = [{ valid: 0, data: 0, last: 0, err: 0 }, { valid: 0, data: 0, last: 0, err: 0 }];
  private readonly ready = [0, 0];
  constructor(readonly hosts: [Host, Host], readonly middle: Middle) { this.ends = [hosts[0], hosts[1]]; }
  clock(): void {
    const { ends, rx, tx, c } = this;
    for (let p = 0; p < 2; p++) {
      ends[p].rxd = tx[p].txd; ends[p].crs = tx[p].txen;
      this.rin[p].valid = rx[p].valid; this.rin[p].data = rx[p].data; this.rin[p].last = rx[p].last; this.rin[p].err = rx[p].err;
      this.ready[p] = tx[p].ready;
    }
    const td0 = ends[0].txd, td1 = ends[1].txd, te0 = ends[0].txen, te1 = ends[1].txen;
    const out = this.middle.step(c, this.rin, this.ready);
    ends[0].clock(c); ends[1].clock(c);
    rx[0].step({ rst: 0, rxd: td0, crs: te0, ready: 1, promisc: 1, addr: ZERO_MAC });
    rx[1].step({ rst: 0, rxd: td1, crs: te1, ready: 1, promisc: 1, addr: ZERO_MAC });
    tx[0].step({ rst: 0, data: out[0].data, valid: out[0].valid, last: out[0].last, crs: 0, col: 0, seed: TX_SEED });
    tx[1].step({ rst: 0, data: out[1].data, valid: out[1].valid, last: out[1].last, crs: 0, col: 0, seed: TX_SEED });
    this.c = c + 1;
  }
}
