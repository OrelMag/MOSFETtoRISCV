// A bench for the NIC: a RAM slave with random wait states on its master port, a register script on its slave port, and frames
// on its line. The same inputs go to the golden model (comm/nic.ts) and the gates (lib/nic.ts); every output is compared every clock.

import { expect } from 'vitest';
import { BIT_CLOCKS, MacRx, MacTx } from '../src/comm/mac';
import { frameBody } from '../src/comm/ethframe';
import { idleIn, NicCore, type NicIn, type NicOut } from '../src/comm/nic';
import { nic } from '../src/lib/nic';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { pack } from '../src/sim/values';
import { lcg } from './util';

export const NIC_OUTS = ['awready', 'wready', 'bvalid', 'arready', 'rvalid', 'rdata', 'm_awvalid', 'm_awaddr', 'm_wvalid', 'm_wdata', 'm_wstrb', 'm_bready', 'm_arvalid', 'm_araddr', 'm_rready', 'txd', 'txen', 'irq'] as const;

/** A RAM answering the master port like chapter 38's slave, plus `maxWait` random extra cycles. */
export class BusRam {
  readonly ram: Uint32Array;
  private busy = false; private delay = 0; private resp: 'b' | 'r' | null = null; private data = 0;
  /** Transactions served, in order: [we, addr, data, strb]. */
  readonly log: [number, number, number, number][] = [];
  constructor(words = 8192, private maxWait = 0, private rnd = lcg(5)) { this.ram = new Uint32Array(words); }
  get ready(): boolean { return !this.busy; }
  inputs(): Pick<NicIn, 'm_awready' | 'm_wready' | 'm_bvalid' | 'm_arready' | 'm_rvalid' | 'm_rdata'> {
    const r = this.ready ? 1 : 0;
    return { m_awready: r, m_wready: r, m_arready: r, m_bvalid: this.resp === 'b' ? 1 : 0, m_rvalid: this.resp === 'r' ? 1 : 0, m_rdata: this.resp === 'r' ? this.data : 0 };
  }
  update(o: NicOut): void {
    const ready = this.ready;
    if (this.resp) { this.resp = null; this.busy = false; } else if (this.busy) { if (--this.delay <= 0) this.resp = this.pend; }
    if (ready) {
      const w = this.maxWait ? this.rnd(this.maxWait + 1) : 0;
      if (o.m_awvalid && o.m_wvalid) {
        const a = (o.m_awaddr >>> 2) % this.ram.length;
        let mask = 0;
        for (let b = 0; b < 4; b++) if ((o.m_wstrb >> b) & 1) mask |= 255 << (8 * b);
        this.ram[a] = ((this.ram[a] & ~mask) | (o.m_wdata & mask)) >>> 0;
        this.log.push([1, o.m_awaddr, o.m_wdata, o.m_wstrb]);
        this.busy = true; this.delay = w; this.pend = 'b'; if (w === 0) this.resp = 'b';
      } else if (o.m_arvalid) {
        this.data = this.ram[(o.m_araddr >>> 2) % this.ram.length];
        this.log.push([0, o.m_araddr, this.data, 0]);
        this.busy = true; this.delay = w; this.pend = 'r'; if (w === 0) this.resp = 'r';
      }
    }
  }
  private pend: 'b' | 'r' = 'b';
  setBytes(addr: number, bytes: ArrayLike<number>): void { for (let i = 0; i < bytes.length; i++) this.setByte(addr + i, bytes[i]); }
  setByte(a: number, v: number): void { const w = a >>> 2, s = 8 * (a & 3); this.ram[w] = ((this.ram[w] & ~(255 << s)) | ((v & 255) << s)) >>> 0; }
  byte(a: number): number { return (this.ram[a >>> 2] >>> (8 * (a & 3))) & 255; }
  bytes(addr: number, n: number): number[] { return Array.from({ length: n }, (_, i) => this.byte(addr + i)); }
}

export interface RegOp { w: boolean; addr: number; data?: number; /** idle clocks before this op */ gap?: number }

/** The CPU's side: one register access at a time. */
export class RegScript {
  private i = 0; private phase: 'gap' | 'req' | 'resp' = 'gap'; private left: number;
  readonly reads: number[] = [];
  constructor(private ops: RegOp[]) { this.left = ops[0]?.gap ?? 0; }
  get done(): boolean { return this.i >= this.ops.length; }
  inputs(): Pick<NicIn, 'awvalid' | 'awaddr' | 'wvalid' | 'wdata' | 'wstrb' | 'arvalid' | 'araddr' | 'bready' | 'rready'> {
    const op = this.ops[this.i], req = !!op && this.phase === 'req';
    return { awvalid: req && op.w ? 1 : 0, awaddr: req && op.w ? op.addr : 0, wvalid: req && op.w ? 1 : 0, wdata: req && op.w ? (op.data ?? 0) : 0, wstrb: req && op.w ? 15 : 0, arvalid: req && !op.w ? 1 : 0, araddr: req && !op.w ? op.addr : 0, bready: 1, rready: 1 };
  }
  update(o: NicOut): void {
    const op = this.ops[this.i];
    if (!op) return;
    if (this.phase === 'gap') { if (this.left-- <= 0) this.phase = 'req'; return; }
    if (this.phase === 'req') {
      if (op.w ? o.awready && o.wready : o.arready) this.phase = 'resp';
      return;
    }
    if (op.w ? o.bvalid : o.rvalid) {
      if (!op.w) this.reads.push(o.rdata);
      this.i++; this.phase = 'gap'; this.left = this.ops[this.i]?.gap ?? 0;
    }
  }
}

/** The line a transmitter would drive for a frame body (destination to pad, no FCS): rxd and crs per clock; flipBit inverts that bit time of the transmission (preamble first). */
export function serialLine(body: number[], lead = 20, tail = 60, flipBit = -1): { rxd: number[]; crs: number[] } {
  const tx = new MacTx();
  tx.step({ rst: 1, data: 0, valid: 0, last: 0, crs: 0, col: 0, seed: 7 });
  const rxd: number[] = Array(lead).fill(0), crs: number[] = Array(lead).fill(0);
  let idx = 0, started = false, n = 0;
  for (let c = 0; c < 400000; c++) {
    const valid = idx < body.length ? 1 : 0;
    const rdy = tx.ready;
    const i = { rst: 0, data: valid ? body[idx] : 0, valid, last: idx === body.length - 1 ? 1 : 0, crs: 0, col: 0, seed: 7 };
    if (rdy && valid) idx++;
    tx.step(i);
    if (tx.txen) { started = true; const v = tx.txd ^ (Math.floor(n / BIT_CLOCKS) === flipBit ? 1 : 0); rxd.push(v); crs.push(1); n++; } else if (started) break;
    else { rxd.push(0); crs.push(0); }
  }
  for (let c = 0; c < tail; c++) { rxd.push(0); crs.push(0); }
  return { rxd, crs };
}

/** Frame bytes from a transmitted line (txd, txen per clock), through the receiver model with promisc: each frame's bytes and verdict. */
export function decodeLine(txd: number[], txen: number[]): { bytes: number[]; err: number }[] {
  const m = new MacRx(), got: { bytes: number[]; err: number }[] = [];
  let cur: number[] = [];
  m.step({ rst: 1, rxd: 0, crs: 0, ready: 1, promisc: 1, addr: [0, 0, 0, 0, 0, 0] });
  for (let c = 0; c < txd.length; c++) {
    m.step({ rst: 0, rxd: txd[c], crs: txen[c], ready: 1, promisc: 1, addr: [0, 0, 0, 0, 0, 0] });
    if (m.valid) { cur.push(m.data); if (m.last) { got.push({ bytes: cur, err: m.err }); cur = []; } }
  }
  return got;
}

export interface Bench {
  model: NicCore; sim: GateSim; ram: BusRam; cycle: number;
  txd: number[]; txen: number[]; irq: number[];
  /** One clock with the line inputs given; the gates and the model must agree on every output. */
  clock(script: RegScript | null, rxd: number, crs: number, compare: boolean): void;
}

export function bench(maxWait = 0, ramWords = 8192, withGates = true): Bench {
  const model = new NicCore(), ram = new BusRam(ramWords, maxWait);
  const sim = withGates ? new GateSim(flatten(nic())) : (null as unknown as GateSim);
  if (sim) { sim.reset('zero'); sim.setInput('clk', 0); }
  const b: Bench = {
    model, sim, ram, cycle: 0, txd: [], txen: [], irq: [],
    clock(script, rxd, crs, compare) {
      const o = model.out();
      const inp: NicIn = { ...idleIn(), ...(script ? script.inputs() : {}), ...ram.inputs(), rxd, crs };
      if (sim && compare) {
        for (const [k, v] of Object.entries(inp)) sim.setInput(k, v as number);
        sim.settle();
        const root = sim.design.root;
        for (const k of NIC_OUTS) expect(pack(sim.getBits(root.ports[k])) >>> 0, `${k} at clock ${b.cycle}`).toBe((o[k] as number) >>> 0);
        sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.settle();
      }
      b.txd.push(o.txd); b.txen.push(o.txen); b.irq.push(o.irq);
      script?.update(o); ram.update(o);
      model.step(inp);
      b.cycle++;
    },
  };
  return b;
}

export const frameFor = (dst: readonly number[], src: readonly number[], type: number, payload: number[]): number[] => frameBody({ dst, src, type, payload });
