// A 4-bit CPU in the sandbox, DOM-free: a chip with a ROM in 4-bit assembly (lang 'cpu4') whose
// (or in a Custom ISA: lang 'isa', followed only: a table has no golden model)
// hierarchy holds the example's architectural registers (lib/cpu4.ts CPU4_STATE: pcs.pc, acc.a,
// regs.r0 …). One instruction per clock, so the golden model steps at every rising edge with the
// TEST pin and the switches the hardware sampled, and every register is compared after it.

import { decode4, disasm4 } from '../isa4/isa4';
import { Iss4 } from '../isa4/iss4';
import { CPU4_STATE } from '../lib/cpu4';
import { type Isa, isaOf } from '../isa/isa';
import { type IsaDoc, tableOf } from '../isa/table';
import type { HierNode } from '../sim/flatten';
import { pack } from '../sim/values';
import type { Chips, Mismatch, MonitorSim, Retired } from './cpu';
import { partNode, refValue } from './cpu';
import { romImage, type RomRef } from './memory';
import type { ChipDoc, PartDoc } from './model';

export interface Cpu4Desc {
  /** The program ROM (a part of the chip). */
  rom: string;
  /** A Custom ISA's table (lang 'isa'): listed and followed, never checked. */
  table?: IsaDoc;
}

type Cpu4RomPart = PartDoc & { ref: { rom: RomRef } };
const isCpu4Rom = (p: PartDoc): p is Cpu4RomPart => 'rom' in p.ref && (p.ref.rom.lang === 'cpu4' || (p.ref.rom.lang === 'isa' && !!p.ref.rom.isa));

/** A ROM in 4-bit assembly on the chip (the one called rom or imem first), or null. */
export function detectCpu4(doc: ChipDoc, _chips?: Chips): Cpu4Desc | null {
  const roms = doc.parts.filter(isCpu4Rom);
  if (!roms.length) return null;
  const rom = roms.find((p) => p.id === 'rom' || p.id === 'imem') ?? roms[0];
  return rom.ref.rom.lang === 'isa' ? { rom: rom.id, table: rom.ref.rom.isa } : { rom: rom.id };
}

/** The 256 words the ROM holds (the PC is 8 bits: a smaller ROM repeats). */
export function cpu4Program(doc: ChipDoc, rom: string): number[] | null {
  const p = doc.parts.find((q) => q.id === rom);
  if (!p || !isCpu4Rom(p)) return null;
  const img = romImage(p.ref.rom);
  if (img.error) return null;
  const n = 2 ** p.ref.rom.k;
  return Array.from({ length: 256 }, (_, i) => img.words[i % n] ?? 0);
}

/** The architectural state as the hardware holds it (-1: unknown). */
export interface Cpu4State { pc: number; a: number; cy: number; src: number; stack: number[]; r: number[]; ports: number[] }

/** The blocks (the example's part ids) an instruction uses, and its path in words. */
export function cpu4Use(word: number): { units: string[]; path: string } {
  const n = decode4(word).name;
  const fetch = ['rom', 'dec', 'pcs'];
  const u = (more: string[], path: string) => ({ units: [...fetch, ...more], path });
  switch (n) {
    case 'ADD': case 'SUB': return u(['regs', 'alu', 'acc'], `ROM → Decode; Index regs (r) → ALU (A ${n === 'ADD' ? '+ r' : '+ ¬r'} + carry) → Accumulator, carry`);
    case 'LD': return u(['regs', 'acc'], 'ROM → Decode; Index regs (r) → Accumulator');
    case 'XCH': return u(['regs', 'acc'], 'ROM → Decode; Index regs (r) → Accumulator, Accumulator (A) → Index regs');
    case 'INC': return u(['regs'], 'ROM → Decode; Index regs: r → r + 1 → r');
    case 'ISZ': return u(['regs'], 'ROM → Decode; Index regs: r + 1 → r, and its zero test → Decode → PC (jump unless 0)');
    case 'FIM': return u(['regs'], 'ROM → Decode; the second byte → Index regs (a whole pair)');
    case 'SRC': return u(['regs', 'io'], 'ROM → Decode; Index regs (pair) → I/O (port address)');
    case 'JIN': return u(['regs'], 'ROM → Decode; Index regs (pair) → PC');
    case 'JUN': return u([], 'ROM → Decode; the address byte → PC');
    case 'JMS': return u([], 'ROM → Decode; PC + 1 → stack; the address byte → PC');
    case 'BBL': return u(['acc'], 'ROM → Decode; stack → PC; OPA → Accumulator');
    case 'JCN': return u(['acc'], 'ROM → Decode; A = 0, the carry and TEST → the condition → PC');
    case 'LDM': return u(['acc'], 'ROM → Decode; OPA → Accumulator');
    case 'WRR': return u(['acc', 'io'], 'ROM → Decode; Accumulator (A) → I/O (the port SRC chose)');
    case 'RDR': return u(['acc', 'io_sw'], 'ROM → Decode; switches → Accumulator');
    case 'NOP': return u([], 'ROM → Decode; nothing but PC + 1');
    default: return u(['alu', 'acc'], `ROM → Decode; Accumulator, carry → ALU (${n}) → Accumulator, carry`);
  }
}

const hx = (v: number, d = 1) => (v < 0 ? '?'.repeat(d) : v.toString(16).toUpperCase().padStart(d, '0'));

/** The golden model in lock-step with a 4-bit CPU, compared register by register after every clock. */
export class Cpu4Monitor {
  iss: Iss4 | null = null;
  desc: Cpu4Desc | null = null;
  mismatch: Mismatch | null = null;
  synced = false;
  retired = 0;
  readonly log: Retired[] = [];
  seq = 0;
  problem: string | null = null;
  prog: number[] | null = null;
  private progKey = '';
  private lastDoc: ChipDoc | null = null;
  private lastChips: Chips | undefined;
  private resets = -1;
  private sample: { test: number; sw: number } | null = null;
  private nodes: { root: unknown; map: Map<string, HierNode | undefined> } = { root: null, map: new Map() };
  private hook = { before: () => this.before(), after: () => this.after() };
  private static readonly LOG = 64;

  constructor(readonly es: MonitorSim, private doc: () => ChipDoc, private chips: () => Chips | undefined = () => undefined) {
    es.edgeHooks.add(this.hook);
    this.sync();
  }

  destroy(): void {
    this.es.edgeHooks.delete(this.hook);
  }

  /** As CpuMonitor.sync: re-detect; restart on a reset or a new program ('program' mid-run: the caller resets). */
  sync(): 'program' | 'settings' | null {
    const doc = this.doc(), chips = this.chips();
    if (doc === this.lastDoc && chips === this.lastChips && this.es.resets === this.resets) return null;
    this.lastDoc = doc;
    this.lastChips = chips;
    this.desc = detectCpu4(doc, chips);
    this.prog = this.desc ? cpu4Program(doc, this.desc.rom) : null;
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
    const table = this.desc?.table;
    this.iss = this.desc && this.prog && !table ? new Iss4(this.prog) : null;
    this.problem = !this.desc ? 'no ROM in 4-bit assembly' : !this.prog ? `the program in ROM '${this.desc.rom}' does not build`
      : table ? `${table.name} is a custom instruction set: its table says how instructions are written, not what they do` : null;
  }

  /** A node of the hierarchy by dotted path (cached per build). */
  private node(path: string): HierNode | undefined {
    const sim = this.es.sim;
    if (!sim) return undefined;
    if (this.nodes.root !== sim.design.root) this.nodes = { root: sim.design.root, map: new Map() };
    if (!this.nodes.map.has(path)) this.nodes.map.set(path, partNode(sim, path));
    return this.nodes.map.get(path);
  }

  private value(path: string, port: string): number | null {
    const nets = this.node(path)?.ports[port], sim = this.es.sim;
    return nets && sim ? pack(sim.getBits(nets)) : null;
  }

  /** The hierarchy has the example's registers (a CPU drawn otherwise is followed, not checked). */
  get hasState(): boolean {
    if (this.desc?.table) return false;
    const S = CPU4_STATE;
    return [S.pc, S.a, S.cy, S.src, ...S.stack, ...S.regs, ...S.ports].every((p) => !!this.node(p)?.ports.q);
  }

  get checking(): boolean {
    return !!this.iss && this.synced && !this.problem && this.hasState;
  }

  /** Why the model is not compared (null: it is, or there is no model at all). */
  get unchecked(): string | null {
    if (this.problem || !this.iss) return null;
    return this.hasState ? null : 'the registers are not where the 4-bit CPU example has them (pcs.pc, acc.a, regs.r0 …)';
  }

  get done(): boolean {
    return !!this.mismatch || !!this.iss?.halted;
  }

  read(): Cpu4State | null {
    if (!this.es.sim || !this.hasState) return null;
    const S = CPU4_STATE, q = (p: string) => this.value(p, 'q') ?? -1;
    return { pc: q(S.pc), a: q(S.a), cy: q(S.cy), src: q(S.src), stack: S.stack.map(q), r: S.regs.map(q), ports: S.ports.map(q) };
  }

  /** The PC: the example's PC register, else what addresses the ROM (-1: X, null: none). */
  get pc(): number | null {
    const v = this.hasState ? this.value(CPU4_STATE.pc, 'q') : null;
    if (v !== null) return v;
    const d = this.desc;
    return d ? refValue(this.es, this.doc(), { part: d.rom, port: 'addr' }) : null;
  }

  /** The ROM's instruction set (the 4-bit CPU's, or the ROM's table). */
  get isa(): Isa {
    return isaOf(this.desc?.table ? 'isa' : 'cpu4', this.desc?.table)!;
  }

  /** What a word does, in words: the blocks it goes through (the 4-bit CPU), or its table row's summary. */
  describe(w: number): string | null {
    const t = this.desc?.table;
    if (!t) return decode4(w).undef ? null : cpu4Use(w).path;
    return tableOf(t).match(w)?.def.summary ?? null;
  }

  wordAt(pc: number): number | null {
    return this.prog && pc >= 0 ? this.prog[pc & 255] : null;
  }

  private before(): void {
    this.sample = null;
    if (!this.checking || this.mismatch || this.iss!.halted) return;
    // What Decode and the accumulator see of the outside: the TEST pin and the switches.
    const test = this.value('dec', 'test'), sw = this.value('acc', 'sw');
    this.sample = { test: test === 1 ? 1 : 0, sw: sw !== null && sw >= 0 ? sw : 0 };
  }

  private after(): void {
    const s = this.sample, iss = this.iss;
    if (!s || !iss || this.mismatch) return;
    const was = iss.save();
    iss.test = s.test;
    iss.switches = s.sw;
    const st = iss.step();
    const text = disasm4(st.instr);
    const effects: string[] = [];
    if (iss.a !== was.a) effects.push(`A ← ${hx(iss.a)}`);
    if (iss.cy !== was.cy) effects.push(`CY ← ${iss.cy}`);
    for (const r of st.regs ?? []) effects.push(`R${r} ← ${hx(iss.r[r])}`);
    if (st.port) effects.push(`port ${st.port.n} ← ${hx(st.port.value)}`);
    if (iss.src !== was.src) effects.push(`SRC ← ${hx(iss.src, 2)}`);
    if (iss.pc !== ((st.pc + 1) & 255)) effects.push(`PC → ${hx(iss.pc, 2)}`);
    this.retired++;
    this.seq++;
    const cycle = this.es.cycles;
    this.log.push({ cycle, pc: st.pc, text, effect: effects.join(', ') });
    if (this.log.length > Cpu4Monitor.LOG) this.log.shift();
    const hw = this.read();
    if (!hw) return;
    const want: [string, string, number, number, number][] = [
      ['pc', 'PC', iss.pc, hw.pc, 2], ['a', 'A', iss.a, hw.a, 1], ['cy', 'CY', iss.cy, hw.cy, 1],
      ...[...iss.r].map((v, i): [string, string, number, number, number] => [`r${i}`, `R${i}`, v, hw.r[i], 1]),
      ...[...iss.stack].map((v, i): [string, string, number, number, number] => [`s${i + 1}`, `stack S${i + 1}`, v, hw.stack[i], 2]),
      ['src', 'SRC', iss.src, hw.src, 2],
      ...[...iss.ports].map((v, i): [string, string, number, number, number] => [`port${i}`, i === 4 ? 'port 4 (LEDs)' : `port ${i}`, v, hw.ports[i], 1]),
    ];
    const bad = want.find(([, , e, g]) => e !== g);
    if (bad) {
      const [what, name, e, g, d] = bad;
      this.mismatch = { what, name, expected: e, got: g, after: text, cycle, detail: `${name}: expected ${hx(e, d)}, got ${hx(g, d)}` };
    }
  }

  runToHalt(budgetMs = 12, cap = 50000): number {
    if (!this.checking) return 0;
    const left = cap - this.es.cycles;
    return left > 0 ? this.es.runCycles(left, () => this.done, budgetMs) : 0;
  }

  /** One instruction: one clock. */
  stepInstr(): number {
    return this.es.runCycles(1);
  }
}
