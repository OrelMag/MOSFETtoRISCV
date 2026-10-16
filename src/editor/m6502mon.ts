// A 6502 in the sandbox, DOM-free: a placed 6502 part (lib/m6502/core.ts, the cycle-exact model behind
// synchronous pins) and a ROM in 6502 assembly. The part is the golden model itself, so there is nothing
// to check it against: the monitor follows it. Every rising edge ends one bus cycle; the bus is read
// just before the edge (the address, R/W, and the byte written or read), so each instruction is known
// with its bytes and everything it wrote, and it ends where the next opcode fetch (SYNC) begins.

import { core6502Regs } from '../lib/m6502/core';
import { disasmAt, OPCODES } from '../m6502/isa';
import type { HierNode } from '../sim/flatten';
import type { Chips, MonitorSim, Retired } from './cpu';
import { partAt, partNode } from './cpu';
import { romImage } from './memory';
import type { ChipDoc, PartDoc } from './model';
import type { BuiltProgram } from './program';

export interface M6502Desc {
  /** The placed 6502 (a part of the chip). */
  core: string;
  /** The program ROM: a part of the chip or of a chip placed in it ('mem.rom'); absent: none found. */
  rom?: string;
  /** A RAM of bytes, here or one chip down ('mem.ram'). */
  ram?: string;
}

const isCore = (p: PartDoc) => 'lib' in p.ref && p.ref.lib === 'm6502_core';
const isRom = (p: PartDoc) => 'rom' in p.ref && p.ref.rom.lang === '6502';
const isRam = (p: PartDoc) => 'ram' in p.ref && p.ref.ram.w === 8;

/** Paths of the parts passing `ok`, here first, then one placed chip down. */
function find(doc: ChipDoc, chips: Chips | undefined, ok: (p: PartDoc) => boolean): string[] {
  const here = doc.parts.filter(ok).map((p) => p.id);
  const down = doc.parts.flatMap((p) => {
    const sub = 'chip' in p.ref ? chips?.[p.ref.chip] : undefined;
    return sub && sub !== doc ? sub.parts.filter(ok).map((q) => `${p.id}.${q.id}`) : [];
  });
  return [...here, ...down];
}

/** A 6502 part on the chip, with its program ROM and RAM where found, or null. */
export function detect6502(doc: ChipDoc, chips?: Chips): M6502Desc | null {
  const core = doc.parts.find(isCore);
  if (!core) return null;
  const roms = find(doc, chips, isRom), rams = find(doc, chips, isRam);
  const named = (xs: string[], ...ids: string[]) => xs.find((x) => ids.includes(x.split('.').pop()!)) ?? xs[0];
  const rom = named(roms, 'rom', 'imem', 'program'), ram = named(rams, 'ram', 'mem');
  return { core: core.id, ...(rom ? { rom } : {}), ...(ram ? { ram } : {}) };
}

/** The registers as the 6502 holds them (between the cycles of an instruction: as far as it got). */
export interface Regs6502 { a: number; x: number; y: number; s: number; p: number; pc: number }

/** One bus cycle: the address, a write or a read, the byte, SYNC (an opcode fetch). */
export interface Bus6502 { addr: number; write: boolean; data: number; sync: number }

interface Instr {
  pc: number; cycle: number; regs: Regs6502; bytes: Map<number, number>; writes: [number, number][]; cycles: number;
  /** An interrupt sequence (IRQ or NMI): the opcode fetched at pc is dropped for a BRK of its own. */
  int?: boolean;
}

const hx = (v: number, d = 2) => v.toString(16).toUpperCase().padStart(d, '0');
const FLAGS = 'NV-BDIZC';
/** P as letters: set flags upper case ('nv-bdIZc' → N V and so on). */
export const flags6502 = (p: number) => [...FLAGS].map((c, i) => (c === '-' ? '-' : (p >> (7 - i)) & 1 ? c : c.toLowerCase())).join('');

export class M6502Monitor {
  desc: M6502Desc | null = null;
  /** Never set: the part is the cycle-exact model; kept for the panel's common code. */
  readonly mismatch = null;
  readonly synced = true;
  retired = 0;
  readonly log: Retired[] = [];
  seq = 0;
  /** Why it cannot be followed now (an unknown read, an undocumented opcode), or null. */
  problem: string | null = null;
  /** The program ran into an instruction that jumps to itself (JMP *, a branch to itself). */
  halted = false;
  /** This cycle's bus, as it was just before the last edge; and the cycle of the instruction it was. */
  bus: Bus6502 | null = null;
  tcycle = 0;
  private cur: Instr | null = null;
  private boundary = false;
  private img: BuiltProgram | null = null;
  private romK = 0;
  private lastDoc: ChipDoc | null = null;
  private lastChips: Chips | undefined;
  private resets = -1;
  private progKey = '';
  private nodes: { root: unknown; core?: HierNode } = { root: null };
  private hook = { before: () => this.before(), after: () => this.after() };
  private static readonly LOG = 64;

  constructor(readonly es: MonitorSim, private doc: () => ChipDoc, private chips: () => Chips | undefined = () => undefined) {
    es.edgeHooks.add(this.hook);
    this.sync();
  }

  destroy(): void {
    this.es.edgeHooks.delete(this.hook);
  }

  /** Re-detect; start over on a reset or a new program ('program' mid-run: the caller resets). */
  sync(): 'program' | null {
    const doc = this.doc(), chips = this.chips();
    if (doc === this.lastDoc && chips === this.lastChips && this.es.resets === this.resets) return null;
    this.lastDoc = doc;
    this.lastChips = chips;
    this.desc = detect6502(doc, chips);
    const at = this.desc?.rom ? partAt(doc, this.desc.rom, chips) : null;
    const r = at && 'rom' in at.part.ref ? at.part.ref.rom : null;
    this.img = r ? romImage(r) : null;
    this.romK = r?.k ?? 0;
    const pk = JSON.stringify([this.desc, r?.src, r?.k]);
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
    this.retired = 0;
    this.log.length = 0;
    this.seq++;
    this.halted = false;
    this.problem = null;
    this.cur = null;
    this.bus = null;
    this.tcycle = 0;
  }

  /** The part's state (null: not simulated). */
  private state() {
    const sim = this.es.sim;
    if (!sim || !this.desc) return null;
    if (this.nodes.root !== sim.design.root) this.nodes = { root: sim.design.root, core: partNode(sim, this.desc.core) };
    const li = this.nodes.core?.leafIndex;
    return li === undefined ? null : core6502Regs(sim.leafState(li));
  }

  /** The registers now. */
  read(): Regs6502 | null {
    const s = this.state();
    return s && !s.x6502 ? { a: s.a, x: s.x, y: s.y, s: s.s, p: s.p, pc: s.pc } : null;
  }

  /** The address of the instruction under way (the opcode just fetched, or about to be). */
  get pc(): number | null {
    const s = this.state();
    if (!s) return null;
    if (s.x6502) return -1;
    return this.cur?.pc ?? (s.bus.sync ? s.bus.addr : null);
  }

  get checking(): boolean {
    return !!this.state() && !this.problem;
  }

  get done(): boolean {
    return this.halted || !!this.problem;
  }

  /** The ROM byte the CPU reads at an address (the ROM repeats every 2^k bytes), or null. */
  romByte(addr: number): number | null {
    if (!this.img || this.img.errors.length) return null;
    return this.img.words[addr % 2 ** this.romK] ?? 0;
  }

  /** The ROM's word (its listing row) for a CPU address. */
  romIndex(addr: number): number | null {
    return this.romK ? addr % 2 ** this.romK : null;
  }

  /** The instruction at an address: from the bytes the CPU fetched for it, else the ROM. */
  disasm(addr: number, bytes?: Map<number, number>): string {
    return disasmAt((a) => bytes?.get(a) ?? this.romByte(a) ?? 0, addr).text;
  }

  get current(): string | null {
    const pc = this.pc;
    return pc === null || pc < 0 ? null : this.disasm(pc, this.cur?.bytes);
  }

  /** Just before an edge: the cycle it ends, as the bus shows it. */
  private before(): void {
    const s = this.state();
    if (!s || s.x6502) return;
    this.bus = { ...s.bus };
    const c = this.cur;
    if (!c) return;
    if (!s.bus.write) c.bytes.set(s.bus.addr, s.bus.data);
    else c.writes.push([s.bus.addr, s.bus.data]);
  }

  /** Just after an edge: an opcode fetch begins a new instruction (the last one is complete). */
  private after(): void {
    const s = this.state();
    if (!s) return;
    if (s.x6502) {
      this.problem ??= 'the 6502 read an unknown value (X) or its clock went X: Reset';
      return;
    }
    const c = this.cur;
    if (c && ++c.cycles === 1) c.int = s.ir === 0 && (c.bytes.get(c.pc) ?? 0) !== 0; // ir 0 for a non-zero opcode: not BRK
    this.tcycle++;
    if (s.illegal !== null) this.problem ??= `undocumented opcode $${hx(s.illegal)}: the 6502 part stops on it (it reads one address forever)`;
    if (!s.bus.sync) return;
    const at = s.bus.addr;
    if (this.cur) this.retire(this.cur, s, at);
    this.cur = { pc: at, cycle: this.es.cycles, regs: { a: s.a, x: s.x, y: s.y, s: s.s, p: s.p, pc: at }, bytes: new Map(), writes: [], cycles: 0 };
    this.tcycle = 0;
    this.boundary = true;
  }

  private retire(c: Instr, s: Regs6502, next: number): void {
    const text = c.int ? `${c.bytes.has(0xfffa) ? 'NMI' : 'IRQ'} (the interrupt sequence)` : this.disasm(c.pc, c.bytes);
    const eff: string[] = [];
    const r = c.regs;
    if (s.a !== r.a) eff.push(`A ← ${hx(s.a)}`);
    if (s.x !== r.x) eff.push(`X ← ${hx(s.x)}`);
    if (s.y !== r.y) eff.push(`Y ← ${hx(s.y)}`);
    if (s.s !== r.s) eff.push(`S ← ${hx(s.s)}`);
    if ((s.p & 0xcf) !== (r.p & 0xcf)) eff.push(`P ${flags6502(s.p)}`);
    for (const [a, v] of c.writes) eff.push(`[$${hx(a, 4)}] ← ${hx(v)}`);
    const n = c.int ? 0 : OPCODES[c.bytes.get(c.pc) ?? this.romByte(c.pc) ?? 0]?.bytes ?? 1;
    if (c.int || next !== ((c.pc + n) & 0xffff)) eff.push(`PC → $${hx(next, 4)}`);
    this.retired++;
    this.seq++;
    this.log.push({ cycle: c.cycle, pc: c.pc, text, effect: `${eff.join(', ')}${eff.length ? ' · ' : ''}${c.cycles} cycles` });
    if (this.log.length > M6502Monitor.LOG) this.log.shift();
    if (next === c.pc && !c.int) this.halted = true;
  }

  runToHalt(budgetMs = 12, cap = 50000): number {
    if (!this.checking) return 0;
    const left = cap - this.es.cycles;
    return left > 0 ? this.es.runCycles(left, () => this.done, budgetMs) : 0;
  }

  /** Clock to the next opcode fetch: one instruction (a reset or an interrupt sequence counts as one). */
  stepInstr(): number {
    this.boundary = false;
    return this.es.runCycles(16, () => this.boundary || this.done);
  }
}
