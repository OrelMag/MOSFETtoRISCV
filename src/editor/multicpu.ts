// A multi-core chip in the sandbox, DOM-free: several placed user chips that are each a complete
// CPU (cpu.ts detectCpu finds a program ROM and a register file in them, like the chapters'
// dual-core: core0, core1, a shared data memory behind an arbiter), checked against the
// multi-hart golden model (riscv/multi.ts MultiISS: one program, one memory port, round-robin
// arbitration). Every cycle the model steps every hart that is not stalled; which cores retired is
// compared with their retire outputs, then each core's registers and PC and the shared memory.

import { MultiISS } from '../riscv/multi';
import { ABI } from '../riscv/isa';
import { stepEffect } from '../riscv/trace';
import {
  type Chips, memDiff, type Mismatch, type MonitorSim, type NetRef, readMem, readRegs, refValue, resolveCpu, type Retired,
  romParts, romProgram,
} from './cpu';
import type { ChipDoc } from './model';

export interface CoreDesc {
  /** The core's part in the multi-core chip. */
  part: string;
  /** Paths from the multi-core chip: its ROM and register file. */
  rom: string;
  regs: string;
  /** The core's PC and retire outputs, as ports of its part (null: none). */
  pc: NetRef | null;
  retire: NetRef | null;
}

export interface MultiDesc {
  cores: CoreDesc[];
  /** The shared data memory (a part of the multi-core chip). */
  dmem?: string;
}

const byName = new Intl.Collator('en', { numeric: true }).compare;

/** Two or more placed CPUs (and no program ROM of the chip's own), or null. */
export function detectMulti(doc: ChipDoc, chips: Chips | undefined): MultiDesc | null {
  if (!chips || romParts(doc).length) return null;
  const cores: CoreDesc[] = [];
  for (const p of [...doc.parts].sort((a, b) => byName(a.id, b.id))) {
    const sub = 'chip' in p.ref ? chips[p.ref.chip] : undefined;
    if (!sub || sub === doc) continue;
    const d = resolveCpu(sub, chips);
    if (!d?.regs) continue;
    const port = (r: NetRef | 'every' | undefined): NetRef | null => {
      const pin = r && r !== 'every' && 'pin' in r ? sub.pins.find((q) => q.id === r.pin) : undefined;
      return pin ? { part: p.id, port: pin.name } : null;
    };
    cores.push({ part: p.id, rom: `${p.id}.${d.rom}`, regs: `${p.id}.${d.regs}`, pc: port(d.pc), retire: port(d.retire) });
  }
  if (cores.length < 2) return null;
  const ram32 = doc.parts.filter((p) => 'ram' in p.ref && p.ref.ram.w === 32);
  const dm = ['dm', 'dmem', 'mem'].map((id) => doc.parts.find((p) => p.id === id)).find((p) => p) ?? (ram32.length === 1 ? ram32[0] : undefined);
  return { cores, ...(dm ? { dmem: dm.id } : {}) };
}

/** The multi-hart golden model in lock-step with a multi-core chip (the CpuMonitor of several cores). */
export class MultiMonitor {
  m: MultiISS | null = null;
  desc: MultiDesc | null = null;
  mismatch: Mismatch | null = null;
  synced = false;
  /** Instructions retired per core since the reset, and cycles each core stalled. */
  retiredBy: number[] = [];
  stalls: number[] = [];
  /** Which cores stalled at the last edge. */
  lastStall: boolean[] = [];
  readonly log: Retired[] = [];
  seq = 0;
  problem: string | null = null;
  prog: { words: number[]; k: number } | null = null;
  private progKey = '';
  private lastDoc: ChipDoc | null = null;
  private lastChips: Chips | undefined;
  private resets = -1;
  private hook = { before: () => this.before(), after: () => this.after() };
  private static readonly LOG = 64;

  constructor(readonly es: MonitorSim, private doc: () => ChipDoc, private chips: () => Chips | undefined) {
    es.edgeHooks.add(this.hook);
    this.sync();
  }

  destroy(): void {
    this.es.edgeHooks.delete(this.hook);
  }

  /** As CpuMonitor.sync: 'program' when the program changed mid-run (the caller resets). */
  sync(): 'program' | 'settings' | null {
    const doc = this.doc(), chips = this.chips();
    if (doc === this.lastDoc && chips === this.lastChips && this.es.resets === this.resets) return null;
    this.lastDoc = doc;
    this.lastChips = chips;
    this.desc = detectMulti(doc, chips);
    const progs = this.desc?.cores.map((c) => romProgram(doc, c.rom, chips)) ?? [];
    const same = progs.every((p) => JSON.stringify(p) === JSON.stringify(progs[0]));
    this.prog = same ? progs[0] ?? null : null;
    const pk = JSON.stringify([this.desc, this.prog]);
    const changed = !!this.progKey && pk !== this.progKey;
    if (changed || this.es.resets !== this.resets || !this.progKey) {
      this.progKey = pk;
      this.resets = this.es.resets;
      this.problem = !this.desc ? 'not a multi-core chip'
        : !same ? 'the cores hold different programs (the golden model runs one program on every hart)'
        : !this.prog ? `the program in ${this.desc.cores[0].rom} does not build` : null;
      this.restart();
      return changed && this.es.cycles > 0 ? 'program' : null;
    }
    return null;
  }

  private restart(): void {
    const n = this.desc?.cores.length ?? 0;
    this.mismatch = null;
    this.retiredBy = new Array(n).fill(0);
    this.stalls = new Array(n).fill(0);
    this.lastStall = new Array(n).fill(false);
    this.log.length = 0;
    this.seq++;
    this.synced = this.es.cycles === 0;
    const sim = this.es.sim;
    if (!this.desc || !this.prog || this.problem) { this.m = null; return; }
    const words = (sim && this.desc.dmem ? readMem(sim, this.desc.dmem)?.length : undefined) ?? 32;
    this.m = new MultiISS(this.prog.words, n, 2 ** Math.round(Math.log2(Math.max(1, words))));
  }

  get checking(): boolean {
    return !!this.m && this.synced;
  }

  get retired(): number {
    return this.retiredBy.reduce((a, b) => a + b, 0);
  }

  get done(): boolean {
    return !!this.m?.halted || !!this.mismatch;
  }

  /** Each core's registers and PC as the hardware holds them (null entries: not readable). */
  read(): { x: number[] | null; pc: number | null }[] {
    const sim = this.es.sim, doc = this.doc();
    return (this.desc?.cores ?? []).map((c) => ({ x: sim ? readRegs(sim, c.regs) : null, pc: c.pc ? refValue(this.es, doc, c.pc) : null }));
  }

  readMem(): number[] | null {
    const sim = this.es.sim;
    return sim && this.desc?.dmem ? readMem(sim, this.desc.dmem) : null;
  }

  private before(): void {
    const m = this.m, d = this.desc;
    if (!m || !d || !this.synced || m.halted) return;
    const doc = this.doc();
    const hw = d.cores.map((c) => (c.retire ? refValue(this.es, doc, c.retire) === 1 : true));
    const r = m.step();
    this.lastStall = r.map((x) => !x);
    r.forEach((x, i) => (x ? this.retiredBy[i]++ : this.stalls[i]++));
    m.last.forEach((info, hart) => {
      if (info) this.log.push({ cycle: this.es.cycles + 1, pc: info.pc, text: info.text, effect: stepEffect(info), hart });
    });
    while (this.log.length > MultiMonitor.LOG) this.log.shift();
    this.seq++;
    const i = hw.findIndex((x, k) => x !== r[k]);
    if (!this.mismatch && i >= 0) {
      const what = (x: boolean) => (x ? 'retires' : 'stalls');
      this.mismatch = {
        what: 'retire', name: 'arbitration', expected: +r[i], got: +hw[i], hart: i, cycle: this.es.cycles + 1,
        after: m.last[i]?.text ?? 'a stall', detail: `the hardware ${what(hw[i])} where the model ${what(r[i])}`,
      };
    }
  }

  private after(): void {
    const m = this.m, d = this.desc, sim = this.es.sim;
    if (!m || !d || !sim || !this.synced || this.mismatch) return;
    const doc = this.doc();
    const cyc = this.es.cycles;
    for (let i = 0; i < d.cores.length; i++) {
      const c = d.cores[i], h = m.harts[i];
      const after = m.last[i]?.text ?? 'a stall';
      const x = readRegs(sim, c.regs);
      const k = x ? x.findIndex((v, j) => v !== h.x[j] >>> 0) : -1;
      if (x && k >= 0) return void (this.mismatch = { what: `x${k}`, name: ABI[k], expected: h.x[k] >>> 0, got: x[k], after, cycle: cyc, hart: i });
      const pc = c.pc ? refValue(this.es, doc, c.pc) : null;
      if (pc !== null && pc !== h.pc >>> 0) return void (this.mismatch = { what: 'pc', name: 'PC', expected: h.pc >>> 0, got: pc, after, cycle: cyc, hart: i });
    }
    const mem = this.readMem();
    const diff = mem && memDiff(mem, m.dmem);
    if (diff) {
      const after = m.last.find((x) => x?.store)?.text ?? m.last.find((x) => x)?.text ?? 'a stall';
      this.mismatch = { what: 'mem', name: `memory [0x${(4 * diff.i).toString(16).padStart(2, '0')}]`, expected: diff.model, got: diff.hw, after, cycle: cyc };
    }
  }

  runToHalt(budgetMs = 12, cap = 50000): number {
    if (!this.checking) return 0;
    const left = cap - this.es.cycles;
    return left > 0 ? this.es.runCycles(left, () => this.done, budgetMs) : 0;
  }

  /** One clock cycle (every core that is not stalled retires one instruction). */
  stepInstr(): number {
    return this.es.runCycles(1);
  }

  wordAt(pc: number): number | null {
    const prog = this.prog;
    if (!prog || pc < 0) return null;
    return prog.words[(pc >>> 2) % 2 ** prog.k] ?? 0x13;
  }
}


