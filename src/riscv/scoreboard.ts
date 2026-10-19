// The CDC 6600's scoreboard (1964), as Hennessy & Patterson tell it, for chapter 24's explorer. DOM-free.
// Four steps per instruction, each at least a cycle, every decision taken on the state at the start of the cycle:
//   issue      in order, when its unit is free and no instruction in flight writes the same register (WAW);
//   read       both operands, once no unit in flight still has to write them (RAW);
//   execute    the unit's latency;
//   write      once no earlier instruction still has to read the old value of that register (WAR).
// No renaming, no result bus: a stalled issue stops everything behind it.

import { classify, type Latencies, LAT, type UopClass } from './ilp';
import { disasm } from './isa';

export type SbUnit = 'Load' | 'ALU' | 'Mul' | 'Div';
const UNIT_OF: Record<UopClass, SbUnit> = {
  load: 'Load', store: 'Load', alu: 'ALU', branch: 'ALU', jal: 'ALU', jalr: 'ALU', lui: 'ALU', mul: 'Mul', div: 'Div',
};

export interface SbInstr {
  text: string;
  unit: SbUnit;
  rd: number;
  srcs: number[];
  /** Cycles of each step (-1: not yet). */
  issue: number;
  read: number;
  exec: number;
  write: number;
}

export interface SbUnitState {
  name: SbUnit;
  /** The instruction it holds (index), or -1. */
  busy: number;
  /** Destination and sources (registers), and the units that will produce the sources (Qj, Qk) if not ready. */
  fi: number;
  fj: number;
  fk: number;
  qj: SbUnit | null;
  qk: SbUnit | null;
  /** Source ready and not read yet (Rj, Rk). */
  rj: boolean;
  rk: boolean;
}

/** Why an instruction is waiting this cycle (for the explorer). */
export type SbStall = 'unit busy' | 'WAW' | 'RAW' | 'WAR' | 'executing' | 'in order' | '';

export class Scoreboard {
  cycle = 0;
  readonly ins: SbInstr[];
  readonly units: SbUnitState[];
  /** Register → the unit that will write it. */
  readonly regs = new Map<number, SbUnit>();
  readonly stall: SbStall[];
  private next = 0;

  constructor(words: number[], readonly lat: Latencies = LAT) {
    this.ins = words.map((w, i) => {
      const c = classify(w);
      return { text: disasm(w, i * 4), unit: UNIT_OF[c.cls], rd: c.rd, srcs: c.srcs, issue: -1, read: -1, exec: -1, write: -1 };
    });
    this.units = (['Load', 'ALU', 'Mul', 'Div'] as SbUnit[]).map((name) => ({ name, busy: -1, fi: 0, fj: 0, fk: 0, qj: null, qk: null, rj: false, rk: false }));
    this.stall = this.ins.map(() => '');
  }

  get done(): boolean { return this.ins.every((i) => i.write >= 0); }

  private unit(n: SbUnit): SbUnitState { return this.units.find((u) => u.name === n)!; }

  private latency(u: SbUnit): number {
    return u === 'Load' ? this.lat.load : u === 'Mul' ? this.lat.mul : u === 'Div' ? this.lat.div : this.lat.alu;
  }

  /** One cycle: every step decided on the state the cycle starts with. */
  step(): void {
    const t = ++this.cycle;
    const acts: (() => void)[] = [];
    this.stall.fill('');
    // Write: the result goes to the register file when no earlier instruction still needs the old value (WAR).
    for (const u of this.units) {
      if (u.busy < 0) continue;
      const k = u.busy, i = this.ins[k];
      if (i.exec < 0 || i.exec >= t) continue;
      const war = this.units.some((o) => o.busy >= 0 && o.busy < k && ((o.fj === u.fi && o.rj) || (o.fk === u.fi && o.rk)));
      if (war && u.fi) { this.stall[k] = 'WAR'; continue; }
      acts.push(() => {
        i.write = t;
        for (const o of this.units) {
          if (o.qj === u.name) { o.qj = null; o.rj = true; }
          if (o.qk === u.name) { o.qk = null; o.rk = true; }
        }
        if (u.fi && this.regs.get(u.fi) === u.name) this.regs.delete(u.fi);
        u.busy = -1;
      });
    }
    // Execute: a latency after the operands were read.
    for (const u of this.units) {
      if (u.busy < 0) continue;
      const i = this.ins[u.busy];
      if (i.read >= 0 && i.exec < 0) {
        if (i.read + this.latency(u.name) <= t) acts.push(() => { i.exec = t; });
        else this.stall[u.busy] = 'executing';
      }
    }
    // Read operands: both ready (RAW).
    for (const u of this.units) {
      if (u.busy < 0) continue;
      const i = this.ins[u.busy];
      if (i.issue < 0 || i.issue >= t || i.read >= 0) continue;
      if (u.qj || u.qk) { this.stall[u.busy] = 'RAW'; continue; }
      acts.push(() => { i.read = t; u.rj = false; u.rk = false; });
    }
    // Issue: in order, a free unit, no WAW.
    if (this.next < this.ins.length) {
      const k = this.next, i = this.ins[k], u = this.unit(i.unit);
      if (u.busy >= 0) this.stall[k] = 'unit busy';
      else if (i.rd && this.regs.has(i.rd)) this.stall[k] = 'WAW';
      else {
        acts.push(() => {
          i.issue = t;
          const [j, kk] = [i.srcs[0] ?? 0, i.srcs[1] ?? 0];
          const qj = j ? this.regs.get(j) ?? null : null, qk = kk ? this.regs.get(kk) ?? null : null;
          Object.assign(u, { busy: k, fi: i.rd, fj: j, fk: kk, qj, qk, rj: !qj, rk: !qk });
          if (i.rd) this.regs.set(i.rd, u.name);
          this.next++;
        });
      }
      for (let n = k + 1; n < this.ins.length; n++) this.stall[n] = this.ins[n].issue < 0 ? 'in order' : this.stall[n];
    }
    for (const a of acts) a();
  }

  run(max = 10_000): number {
    while (!this.done && this.cycle < max) this.step();
    return this.cycle;
  }
}
