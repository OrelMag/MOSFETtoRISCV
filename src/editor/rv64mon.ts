// An RV64 core in the sandbox, DOM-free: a placed rv64i_core / rv64im_core (lib/cpu64.ts xlenCpu with its program on
// a port; the data memory is inside the part) next to a ROM. The golden model is ISS64 (riscv/iss64.ts) stepped at every
// rising edge the core retires on, and every register, the PC and the data memory after a store are compared as BigInts:
// nothing here goes through a JS number (it rounds past 53 bits). The register file is '<core>.rf', the memory '<core>.dm'.

import type { HierNode } from '../sim/flatten';
import { bitsBig } from '../riscv/cosim';
import { ISS64 } from '../riscv/iss64';
import { ABI } from '../riscv/isa';
import { PUZZLE_NO_GOLDEN, simHasPuzzlePorts } from './puzzleparts';
import type { Chips, MonitorSim, Retired } from './cpu';
import { partAt, partNode, romProgram } from './cpu';
import type { ChipDoc, PartDoc } from './model';

export const CORE64 = /^rv64(i|im)(?:_d(\d))?_core$/;

export interface Rv64Desc {
  /** The program ROM (a part path). */
  rom: string;
  /** The core part. */
  core: string;
  m: boolean;
  /** log2 of the data memory's doublewords. */
  dmemK: number;
}

type RomPart = PartDoc & { ref: { rom: { addr: string; w: number } } };
const isRom = (p: PartDoc): p is RomPart => 'rom' in p.ref && p.ref.rom.addr === 'rv32' && p.ref.rom.w === 32;

/** A placed 64-bit core and a byte-addressed 32-bit ROM on the chip (null: none). */
export function detectRv64(doc: ChipDoc, _chips?: Chips): Rv64Desc | null {
  const core = doc.parts.find((p) => 'lib' in p.ref && CORE64.test(p.ref.lib));
  if (!core || !('lib' in core.ref)) return null;
  const roms = doc.parts.filter(isRom);
  const rom = roms.find((p) => p.id === 'imem') ?? roms[0];
  if (!rom) return null;
  const m = CORE64.exec(core.ref.lib)!;
  return { rom: rom.id, core: core.id, m: m[1] === 'im', dmemK: m[2] ? +m[2] : 6 };
}

/** The architectural state as BigInts. */
export interface Rv64State { pc: bigint; x: bigint[]; dmem: bigint[]; retiring: boolean }

export interface Mismatch64 {
  /** 'x5', 'pc' or 'mem'. */
  what: string;
  name: string;
  expected: bigint;
  got: bigint;
  after: string;
  cycle: number;
}

export const hex64 = (v: bigint) => `0x${BigInt.asUintN(64, v).toString(16).padStart(16, '0')}`;

export function mismatch64Text(m: Mismatch64): string {
  const what = m.what === m.name || m.what === 'pc' || m.what === 'mem' ? m.name : `${m.name} (${m.what})`;
  return `${what} after “${m.after}”, cycle ${m.cycle}: expected ${hex64(m.expected)}, got ${hex64(m.got)}`;
}

/** First doubleword where the hardware and the model differ. */
export function memDiff64(hw: bigint[], iss: ISS64): { i: number; hw: bigint; model: bigint } | null {
  const n = Math.min(hw.length, iss.dmem.length / 2);
  for (let i = 0; i < n; i++) {
    const model = iss.readDword(BigInt(8 * i));
    if (hw[i] !== model) return { i, hw: hw[i] ?? 0n, model };
  }
  return null;
}

export class Rv64Monitor {
  iss: ISS64 | null = null;
  desc: Rv64Desc | null = null;
  mismatch: Mismatch64 | null = null;
  synced = false;
  retired = 0;
  readonly log: Retired[] = [];
  seq = 0;
  problem: string | null = null;
  prog: { words: number[]; k: number } | null = null;
  private progKey = '';
  private lastDoc: ChipDoc | null = null;
  private lastChips: Chips | undefined;
  private resets = -1;
  private willRetire = false;
  private hook = { before: () => this.before(), after: () => this.after() };
  private static readonly LOG = 64;

  constructor(readonly es: MonitorSim, private doc: () => ChipDoc, private chips: () => Chips | undefined = () => undefined) {
    es.edgeHooks.add(this.hook);
    this.sync();
  }

  destroy(): void {
    this.es.edgeHooks.delete(this.hook);
  }

  /** As CpuMonitor.sync. */
  sync(): 'program' | 'settings' | null {
    const doc = this.doc(), chips = this.chips();
    if (doc === this.lastDoc && chips === this.lastChips && this.es.resets === this.resets) return null;
    this.lastDoc = doc;
    this.lastChips = chips;
    this.desc = detectRv64(doc, chips);
    this.prog = this.desc ? romProgram(doc, this.desc.rom, chips) : null;
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
    this.mismatch = null;
    this.retired = 0;
    this.log.length = 0;
    this.seq++;
    this.synced = this.es.cycles === 0;
    const d = this.desc;
    this.problem = !d ? 'no 64-bit core with a program ROM' : !this.prog ? `the program in ROM '${d.rom}' does not build` : simHasPuzzlePorts(this.es.sim) ? PUZZLE_NO_GOLDEN : null;
    this.iss = d && this.prog && !this.problem
      ? new ISS64(this.prog.words, { m: d.m, imemWords: 2 ** this.prog.k, dmemWords: 2 ** (d.dmemK + 1) }) : null;
  }

  private node(sub = ''): HierNode | undefined {
    const d = this.desc, sim = this.es.sim;
    return d && sim ? partNode(sim, sub ? `${d.core}.${sub}` : d.core) : undefined;
  }

  /** The core's state from the simulation (null: not built yet). */
  read(): Rv64State | null {
    const sim = this.es.sim, core = this.node();
    if (!sim || !core?.children) return null;
    const rf = core.children.get('rf'), dm = core.children.get('dm');
    if (!rf?.children) return null;
    const x = [0n];
    for (let i = 1; i < 32; i++) {
      const w = rf.children.get(`w${i}`);
      x.push(w ? bitsBig(sim.getBits(w.ports.q)) : 0n);
    }
    const dmem: bigint[] = [];
    if (dm?.children) {
      const banks = [...dm.children.keys()].filter((n) => /^b\d+$/.test(n)).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))).map((n) => dm.children!.get(n)!);
      banks.forEach((bank, l) => {
        for (const [name, n] of bank.children ?? []) {
          if (!/^w\d+$/.test(name)) continue;
          const i = Number(name.slice(1));
          dmem[i] = (dmem[i] ?? 0n) | (bitsBig(sim.getBits(n.ports.q)) << BigInt(8 * l));
        }
      });
    }
    const pc = core.ports.pcOut ? bitsBig(sim.getBits(core.ports.pcOut)) : 0n;
    const rt = core.ports.retire;
    return { pc, x, dmem, retiring: rt ? bitsBig(sim.getBits(rt)) === 1n : true };
  }

  get checking(): boolean {
    return !!this.iss && this.synced && !this.problem;
  }

  get done(): boolean {
    return !!this.iss?.halted || !!this.mismatch;
  }

  /** The instruction at a byte address of the program. */
  wordAt(pc: number): number | null {
    const p = this.prog;
    return p && pc >= 0 ? p.words[(pc >>> 2) % 2 ** p.k] ?? 0x13 : null;
  }

  private before(): void {
    this.willRetire = false;
    if (!this.checking || this.mismatch || this.iss!.halted) return;
    this.willRetire = this.read()?.retiring ?? false;
  }

  private after(): void {
    const iss = this.iss;
    if (!this.willRetire || !iss || this.mismatch) return;
    this.willRetire = false;
    const info = iss.step();
    this.retired++;
    this.seq++;
    const effect = [
      info.rd ? `${ABI[info.rd]} ← ${hex64(info.value ?? 0n)}` : '',
      info.store ? `[${hex64(info.store.addr)}] ← ${info.store.value.toString(16)}` : '',
      info.halted ? 'halt' : '',
    ].filter(Boolean).join(' · ') || '—';
    this.log.push({ cycle: this.es.cycles, pc: Number(info.pc & 0xffffffffn), text: info.text, effect });
    if (this.log.length > Rv64Monitor.LOG) this.log.shift();
    const hw = this.read();
    if (!hw) return;
    const at = (what: string, name: string, expected: bigint, got: bigint) =>
      (this.mismatch = { what, name, expected, got, after: info.text, cycle: this.es.cycles });
    const i = hw.x.findIndex((v, k) => v !== iss.x[k]);
    if (i >= 0) return void at(`x${i}`, ABI[i], iss.x[i], hw.x[i]);
    if (hw.pc !== iss.pc) return void at('pc', 'PC', iss.pc, hw.pc);
    if (info.store) {
      const m = memDiff64(hw.dmem, iss);
      if (m) at('mem', `memory [0x${(8 * m.i).toString(16).padStart(2, '0')}]`, m.model, m.hw);
    }
  }

  runToHalt(budgetMs = 12, cap = 50000): number {
    if (!this.checking) return 0;
    const left = cap - this.es.cycles;
    return left > 0 ? this.es.runCycles(left, () => this.done, budgetMs) : 0;
  }

  /** Clock until the next instruction retires. */
  stepInstr(cap = 400): number {
    const n0 = this.retired;
    if (!this.iss || !this.synced) return this.es.runCycles(1);
    return this.es.runCycles(cap, () => this.retired > n0 || !!this.iss?.halted);
  }
}

export { partAt };
