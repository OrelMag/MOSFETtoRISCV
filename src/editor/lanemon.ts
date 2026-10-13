// An RV16 lane computer in the sandbox, DOM-free: a chip with an RV16 program ROM and a placed lane core
// (the campaign's act 9 pins: pc, daddr<i>, dwdata<i>, dwe, rwe, rwa, rwd<i>; a two-warp core adds warp and
// the load port lwe, lwa, lwd<i>; k_frame's the pixel writes fa, fd, fwe), like the campaign's "debug this
// program" bench around a lane core. The golden model (Simt16, or Warps16 for two warps) is checked the
// way the lane and warp benches check it (campaign/lanecheck.ts, warpcheck.ts): every thread's register
// writes and stores, in order, the loads coming back on the load port as the previous cycle's warp's, and
// the rasterizer's pixel writes in the order the model's device drew them.

import { disasm16, REG_NAMES16 } from '../riscv/rv16/isa16';
import { Simt16, type Warp16Step } from '../riscv/rv16/simt16';
import { Warps16 } from '../riscv/rv16/warps16';
import { pack } from '../sim/values';
import type { Chips, Mismatch, MonitorSim, Retired } from './cpu';
import { partNode } from './cpu';
import { rv16Program } from './cpu16';
import type { ChipDoc, PartDoc } from './model';
import { isError, partDef } from './parts';

export interface LaneDesc {
  /** The program ROM (a part of the chip). */
  rom: string;
  /** The core part. */
  core: string;
  lanes: number;
  /** 2: the two-warp core (warp bit, load port). */
  warps: 1 | 2;
  /** k_frame: the rasterizer's pixel writes (fa, fd, fwe). */
  raster: boolean;
  /** The data memory: a 16-bit RAM part from address 0 (its initial words are the model's). */
  ram?: { id: string; k: number; init?: number[] };
}

type Ports = { name: string; dir: string; width: number }[];

function portsOf(p: PartDoc, chips: Chips | undefined): Ports | null {
  if ('chip' in p.ref) return chips?.[p.ref.chip]?.pins ?? null;
  if (!('lib' in p.ref)) return null;
  const d = partDef(p.ref, () => undefined);
  return isError(d) ? null : d.ports;
}

const has = (ports: Ports, name: string, width: number) => ports.some((q) => q.name === name && q.dir === 'out' && q.width === width);

/** Lanes of a lane core's pins (0: not one). */
function lanesOf(ports: Ports): number {
  for (const n of [4, 2, 8]) {
    const each = (p: string) => Array.from({ length: n }, (_, i) => `${p}${i}`);
    if (has(ports, 'pc', 16) && has(ports, 'dwe', n) && has(ports, 'rwe', n) && has(ports, 'rwa', 3)
      && [...each('daddr'), ...each('dwdata'), ...each('rwd')].every((p) => has(ports, p, 16))) return n;
  }
  return 0;
}

/** An RV16 ROM and one placed lane core (the first by id), or null. */
export function detectLanes16(doc: ChipDoc, chips?: Chips): LaneDesc | null {
  const roms = doc.parts.filter((p) => 'rom' in p.ref && p.ref.rom.lang === 'rv16');
  if (!roms.length) return null;
  const rom = roms.find((p) => p.id === 'imem' || p.id === 'rom' || p.id === 'program') ?? roms[0];
  for (const p of [...doc.parts].sort((a, b) => a.id.localeCompare(b.id))) {
    if (p === rom) continue;
    const ports = portsOf(p, chips);
    const n = ports ? lanesOf(ports) : 0;
    if (!ports || !n) continue;
    const warps = has(ports, 'warp', 1) && has(ports, 'lwe', n) && has(ports, 'lwa', 3) ? 2 : 1;
    const raster = warps === 2 && has(ports, 'fa', 10) && has(ports, 'fd', 16) && has(ports, 'fwe', 1);
    // the data memory: the 16-bit RAM named dmem, else the only one
    const rams = doc.parts.filter((q) => 'ram' in q.ref && q.ref.ram.w === 16);
    const r = rams.find((q) => q.id === 'dmem') ?? (rams.length === 1 ? rams[0] : undefined);
    const ram = r && 'ram' in r.ref ? { id: r.id, k: r.ref.ram.k, ...(r.ref.ram.init ? { init: r.ref.ram.init } : {}) } : undefined;
    return { rom: rom.id, core: p.id, lanes: n, warps, raster, ...(ram ? { ram } : {}) };
  }
  return null;
}

/** A write the model made, for one thread (n: the model's step count, to order them). */
interface Expect { n: number; pc: number; instr: number; rd?: number; addr?: number; value: number }
interface Pixel { fa: number; fd: number; tri: number }

const hex4 = (v: number) => `0x${(v & 0xffff).toString(16).padStart(4, '0')}`;
const regName = (r: number) => `${REG_NAMES16[r]} (x${r})`;
const px = (a: number) => (a < 0 ? 'X' : `(${a & 31}, ${a >> 5})`);

/** The lane golden model in lock-step with an RV16 lane computer. */
export class LaneMonitor {
  sim: Simt16 | Warps16 | null = null;
  desc: LaneDesc | null = null;
  mismatch: Mismatch | null = null;
  synced = false;
  /** Register writes, stores and pixel writes the hardware made that matched the model. */
  retired = 0;
  readonly log: Retired[] = [];
  seq = 0;
  problem: string | null = null;
  prog: { words: number[]; k: number } | null = null;
  /** Per thread (warp · lanes + lane), the registers as the write ports set them. */
  hw: Uint16Array[] = [];
  /** The register the last edge wrote, per thread (-1: none). */
  lastWrite: number[] = [];
  /** Pixel writes matched. */
  pixels = 0;
  private endAt = -1;
  private regQ: Expect[][] = [];
  private storeQ: Expect[][] = [];
  private pixQ: Pixel[] = [];
  private drawsSeen = 0;
  private prevWarp = -1;
  private progKey = '';
  private lastDoc: ChipDoc | null = null;
  private lastChips: Chips | undefined;
  private resets = -1;
  private sample: Record<string, number | null> = {};
  private hook = { before: () => this.before(), after: () => this.after() };
  private static readonly LOG = 64;
  /** Model steps without a write before the monitor stops looking (a warp spinning in a loop). */
  private static readonly QUIET = 4096;
  static readonly DRAIN = 8;

  constructor(readonly es: MonitorSim, private doc: () => ChipDoc, private chips: () => Chips | undefined = () => undefined) {
    es.edgeHooks.add(this.hook);
    this.sync();
  }

  destroy(): void {
    this.es.edgeHooks.delete(this.hook);
  }

  /** Threads: warps × lanes. */
  get threads(): number {
    return this.desc ? this.desc.warps * this.desc.lanes : 0;
  }

  /** As Rv16Monitor.sync. */
  sync(): 'program' | 'settings' | null {
    const doc = this.doc(), chips = this.chips();
    if (doc === this.lastDoc && chips === this.lastChips && this.es.resets === this.resets) return null;
    this.lastDoc = doc;
    this.lastChips = chips;
    this.desc = detectLanes16(doc, chips);
    this.prog = this.desc ? rv16Program(doc, this.desc.rom) : null;
    const pk = JSON.stringify([this.desc, this.prog]);
    const changed = !!this.progKey && pk !== this.progKey;
    if (changed || this.es.resets !== this.resets || !this.progKey) {
      this.progKey = pk;
      this.resets = this.es.resets;
      this.restart();
      return changed && this.es.cycles > 0 ? 'program' : null;
    }
    return null;
  }

  private restart(): void {
    const d = this.desc, T = this.threads;
    this.mismatch = null;
    this.retired = 0;
    this.pixels = 0;
    this.log.length = 0;
    this.hw = Array.from({ length: T }, () => new Uint16Array(8));
    this.lastWrite = Array(T).fill(-1);
    this.regQ = Array.from({ length: T }, () => []);
    this.storeQ = Array.from({ length: T }, () => []);
    this.pixQ = [];
    this.drawsSeen = 0;
    this.prevWarp = -1;
    this.endAt = -1;
    this.seq++;
    this.synced = this.es.cycles === 0;
    this.problem = !d ? 'no RV16 ROM and lane core' : !this.prog ? `the program in ROM '${d.rom}' does not build` : null;
    const data = new Map((d?.ram?.init ?? []).map((v, i) => [i, v] as [number, number]));
    this.sim = !d || !this.prog || this.problem ? null
      : d.warps === 2 ? new Warps16(this.prog.words, { lanes: d.lanes, warps: 2, raster: d.raster }, data)
        : new Simt16(this.prog.words, { lanes: d.lanes }, data);
    this.advance();
  }

  get checking(): boolean {
    return !!this.sim && this.synced;
  }

  get halted(): boolean {
    return !!this.sim?.halted;
  }

  get error(): string | null {
    return this.sim?.error ?? null;
  }

  /** Every write the model made before halting has come, and nothing more for DRAIN cycles; or they differ. */
  get done(): boolean {
    return !!this.mismatch || (this.endAt >= 0 && this.es.cycles - this.endAt >= LaneMonitor.DRAIN);
  }

  private who(t: number): string {
    const n = this.desc!.lanes;
    return this.desc!.warps === 2 ? `warp ${Math.floor(t / n)}, lane ${t % n}` : `lane ${t}`;
  }

  /** What the hardware should write next (the oldest pending write of any thread), or null. */
  get next(): string | null {
    if (!this.sim || !this.synced || this.mismatch) return null;
    let best: { e: Expect; t: number } | null = null;
    for (let t = 0; t < this.threads; t++) {
      for (const e of [this.regQ[t][0], this.storeQ[t][0]]) if (e && (!best || e.n < best.e.n)) best = { e, t };
    }
    if (!best) return this.pixQ[0] ? `pixel ${px(this.pixQ[0].fa)} ← ${hex4(this.pixQ[0].fd)}` : null;
    const { e, t } = best;
    const what = e.rd !== undefined ? `${REG_NAMES16[e.rd]} ← ${hex4(e.value)}` : `[${hex4(e.addr!)}] ← ${hex4(e.value)}`;
    return `${this.who(t)}: ${what} from “${disasm16(e.instr, e.pc)}” @ ${hex4(e.pc)}`;
  }

  /** A port of the core, read through the hierarchy. */
  private port(name: string): number | null {
    const d = this.desc, sim = this.es.sim;
    const nets = d && sim ? partNode(sim, d.core)?.ports[name] : undefined;
    return nets && sim ? pack(sim.getBits(nets)) : null;
  }

  /** The core's PC (-1: X, null: none). */
  get pc(): number | null {
    return this.port('pc');
  }

  /** The warp issuing now (two-warp cores; null otherwise). */
  get warp(): number | null {
    return this.desc?.warps === 2 ? this.port('warp') : null;
  }

  /** Run the model one step (one issue slot), queueing what each thread wrote. */
  private stepModel(): void {
    const m = this.sim!, n = this.desc!.lanes;
    let w = 0, s: Warp16Step | null;
    if (m instanceof Warps16) {
      const slot = m.step();
      w = slot.warp;
      s = slot.step;
      for (; this.drawsSeen < m.draws.length; this.drawsSeen++) {
        const dr = m.draws[this.drawsSeen];
        for (const p of dr.pixels) this.pixQ.push({ fa: 32 * p.y + p.x, fd: dr.col, tri: this.drawsSeen });
      }
    } else s = m.step();
    const k = m.steps;
    s?.lanes.forEach((l, i) => {
      const t = w * n + i;
      if (l?.reg) this.regQ[t].push({ n: k, pc: s!.pc, instr: s!.instr, rd: l.reg.rd, value: l.reg.value });
      if (l?.store) this.storeQ[t].push({ n: k, pc: s!.pc, instr: s!.instr, addr: l.store.addr, value: l.store.value });
    });
  }

  /** Step the model until `q` has an entry (or it halts, or stays quiet too long). */
  private fill(q: { length: number }): void {
    for (let i = 0; this.sim && !q.length && !this.sim.halted && i < LaneMonitor.QUIET; i++) this.stepModel();
  }

  /** Nothing pending: run the model to its next write, or its end (then nothing more is expected). */
  private advance(): void {
    for (let i = 0; this.sim && this.idle && !this.sim.halted && i < LaneMonitor.QUIET; i++) this.stepModel();
  }

  /** No write of the model is waiting for the hardware. */
  private get idle(): boolean {
    return this.regQ.every((q) => !q.length) && this.storeQ.every((q) => !q.length) && !this.pixQ.length;
  }

  private before(): void {
    this.sample = {};
    if (!this.sim || !this.synced || this.mismatch) return;
    const d = this.desc!, n = d.lanes;
    const names = ['pc', 'rwe', 'rwa', 'dwe', ...Array.from({ length: n }, (_, i) => [`rwd${i}`, `daddr${i}`, `dwdata${i}`]).flat()];
    if (d.warps === 2) names.push('warp', 'lwe', 'lwa', ...Array.from({ length: n }, (_, i) => `lwd${i}`));
    if (d.raster) names.push('fwe', 'fa', 'fd');
    for (const p of names) this.sample[p] = this.port(p);
  }

  private after(): void {
    const s = this.sample;
    this.lastWrite.fill(-1);
    if (!this.sim || !this.synced || this.mismatch || !('rwe' in s)) return;
    const d = this.desc!, n = d.lanes, cycle = this.es.cycles;
    const v = (p: string) => s[p] ?? -1;
    const where = (e: Expect) => `“${disasm16(e.instr, e.pc)}” @ ${hex4(e.pc)}`;
    const fail = (_t: number, what: string, name: string, e: Expect | undefined, got: number, detail: string) =>
      (this.mismatch = { what, name, expected: e?.value ?? 0, got, after: e ? disasm16(e.instr, e.pc) : this.log.at(-1)?.text ?? 'the reset', cycle, detail });
    const done = (pc: number, text: string, effect: string, _t: number) => {
      this.retired++;
      this.seq++;
      this.log.push({ cycle, pc, text, effect });
      if (this.log.length > LaneMonitor.LOG) this.log.shift();
    };
    const x = ['rwe', 'dwe', ...(d.warps === 2 ? ['warp', 'lwe'] : []), ...(d.raster ? ['fwe'] : [])].find((p) => v(p) < 0);
    if (x) return void fail(-1, x, x, undefined, -1, `${x} is X (unknown): the bench cannot tell whether the core writes`);
    const reg = (t: number, a: number, val: number, port: string): boolean => {
      this.fill(this.regQ[t]);
      const e = this.regQ[t].shift();
      const got = `${a < 0 ? 'x?' : regName(a)} ← ${val < 0 ? 'X' : hex4(val)}`;
      if (!e) return !fail(t, `x${a}`, 'register write', e, val, `${this.who(t)} makes an extra register write ${got}${port}: its program has ended`);
      if (a !== e.rd || val !== e.value) return !fail(t, `x${e.rd}`, regName(e.rd!), e, val, `${this.who(t)}'s register write is ${got}${port}; expected ${regName(e.rd!)} ← ${hex4(e.value)} from ${where(e)}`);
      this.hw[t][a] = val;
      this.lastWrite[t] = a;
      done(e.pc, disasm16(e.instr, e.pc), `${this.who(t)}: ${REG_NAMES16[a]} ← ${hex4(val)}`, t);
      return true;
    };
    // the loads coming back are older than this cycle's instruction: first
    if (d.warps === 2) {
      const lwe = v('lwe'), lwa = v('lwa');
      for (let j = 0; j < n; j++) {
        if (!((lwe >> j) & 1) || lwa === 0) continue;
        if (this.prevWarp < 0) return void fail(-1, 'lwe', 'load port', undefined, lwe, `lwe is ${lwe.toString(2).padStart(n, '0')}, but no warp issued in the cycle before`);
        if (!reg(this.prevWarp * n + j, lwa, v(`lwd${j}`), ' on the load port (lwe)')) return;
      }
    }
    const w = d.warps === 2 ? v('warp') : 0;
    const rwe = v('rwe'), rwa = v('rwa'), dwe = v('dwe');
    for (let j = 0; j < n; j++) {
      const t = w * n + j;
      if ((rwe >> j) & 1 && rwa !== 0 && !reg(t, rwa, v(`rwd${j}`), '')) return;
      if ((dwe >> j) & 1) {
        this.fill(this.storeQ[t]);
        const e = this.storeQ[t].shift();
        const a = v(`daddr${j}`), val = v(`dwdata${j}`);
        const got = `[${a < 0 ? 'X' : hex4(a)}] ← ${val < 0 ? 'X' : hex4(val)}`;
        if (!e) return void fail(t, 'mem', 'store', e, val, `${this.who(t)} makes an extra store ${got}: its program has ended`);
        if (a !== e.addr || val !== e.value) return void fail(t, 'mem', `memory [${hex4(e.addr!)}]`, e, val, `${this.who(t)}'s store is ${got}; expected [${hex4(e.addr!)}] ← ${hex4(e.value)} from ${where(e)}`);
        done(e.pc, disasm16(e.instr, e.pc), `${this.who(t)}: [${hex4(a)}] ← ${hex4(val)}`, t);
      }
    }
    if (d.raster && v('fwe') === 1) {
      this.fill(this.pixQ);
      const e = this.pixQ.shift(), a = v('fa'), val = v('fd');
      const got = `${px(a)} ← ${val < 0 ? 'X' : hex4(val)}`;
      if (!e) return void fail(-1, 'pixel', 'pixel write', undefined, val, `an extra pixel write ${got}: the triangles drawn so far cover no more`);
      if (a !== e.fa || val !== e.fd) {
        this.mismatch = { what: 'pixel', name: `pixel ${px(e.fa)}`, expected: e.fd, got: val, after: this.log.at(-1)?.text ?? 'the reset', cycle, detail: `pixel write #${this.pixels + 1} is ${got}; expected ${px(e.fa)} ← ${hex4(e.fd)} (triangle ${e.tri + 1})` };
        return;
      }
      this.pixels++;
      done(-1, `triangle ${e.tri + 1}`, `pixel ${px(a)} ← ${hex4(val)}`, -1);
    }
    this.prevWarp = w;
    this.advance();
    if (this.endAt < 0 && this.sim.halted && this.idle) this.endAt = cycle;
  }

  runToHalt(budgetMs = 12, cap = 50000): number {
    if (!this.checking) return 0;
    const left = cap - this.es.cycles;
    return left > 0 ? this.es.runCycles(left, () => this.done, budgetMs) : 0;
  }

  /** Clock until the hardware makes its next checked write (at most `cap` cycles). */
  stepInstr(cap = 400): number {
    const n0 = this.retired;
    if (!this.checking) return this.es.runCycles(1);
    return this.es.runCycles(cap, () => this.retired > n0 || this.done);
  }

  wordAt(pc: number): number | null {
    const prog = this.prog;
    if (!prog || pc < 0) return null;
    return prog.words[pc % 2 ** prog.k] ?? 0;
  }
}
