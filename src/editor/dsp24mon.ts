// The DSP core in the sandbox, DOM-free: a chip with a ROM in DSP24 assembly (lang 'dsp24') beside a placed `dsp24_core`
// part (the core without its memories: lib/dsp24core.ts) and two RAM parts of 256 × 16 on its X and Y ports. One
// instruction per clock, so the golden model (dsp/iss24.ts) steps at every rising edge and every architectural register
// is compared after it, through the paths of DSP24_STATE under the core part; a store is checked in the X or Y RAM.
// The same comparison tests/dsp-core-kit.ts makes on the chapter's computer.

import { decode24, disasm24 } from '../dsp/isa24';
import { Iss24 } from '../dsp/iss24';
import { DSP24_STATE } from '../lib/dsp24core';
import { ramLeafState, ramWords } from '../lib/bigmem';
import { type Isa, isaOf } from '../isa/isa';
import type { HierNode } from '../sim/flatten';
import { pack } from '../sim/values';
import type { Chips, Mismatch, MonitorSim, Retired } from './cpu';
import { partNode } from './cpu';
import { ramInit, romImage, type RomRef } from './memory';
import type { ChipDoc, PartDoc } from './model';
import { PUZZLE_NO_GOLDEN, simHasPuzzlePorts } from './puzzleparts';

export interface Dsp24Desc {
  /** The program ROM (a part of the chip). */
  rom: string;
  /** The placed core part (its instance paths are DSP24_STATE's, below it). */
  core: string;
  /** RAM parts of 256 × 16 on the chip: the X and Y memories are two of them (told apart by the core's address ports). */
  rams: string[];
}

type Dsp24RomPart = PartDoc & { ref: { rom: RomRef } };
const isRom = (p: PartDoc): p is Dsp24RomPart => 'rom' in p.ref && p.ref.rom.lang === 'dsp24';
const isCore = (p: PartDoc) => 'lib' in p.ref && p.ref.lib === 'dsp24_core';
const isDataRam = (p: PartDoc) => 'ram' in p.ref && p.ref.ram.k === 8 && p.ref.ram.w === 16 && !(p.ref.ram.ports && p.ref.ram.ports > 1);

/** A ROM in DSP24 assembly and a placed dsp24_core on the chip (the ROM called rom or imem first), or null. */
export function detectDsp24(doc: ChipDoc, _chips?: Chips): Dsp24Desc | null {
  const roms = doc.parts.filter(isRom), core = doc.parts.find(isCore);
  if (!roms.length || !core) return null;
  const rom = roms.find((p) => p.id === 'rom' || p.id === 'imem') ?? roms[0];
  return { rom: rom.id, core: core.id, rams: doc.parts.filter(isDataRam).map((p) => p.id) };
}

/** The 256 words the ROM holds (the PC is 8 bits: a smaller ROM repeats). */
export function dsp24Program(doc: ChipDoc, rom: string): number[] | null {
  const p = doc.parts.find((q) => q.id === rom);
  if (!p || !isRom(p)) return null;
  const img = romImage(p.ref.rom);
  if (img.error) return null;
  const n = 2 ** p.ref.rom.k;
  return Array.from({ length: 256 }, (_, i) => img.words[i % n] ?? 0);
}

/** The architectural state as the hardware holds it (-1: unknown). */
export interface Dsp24State {
  pc: number; r: number[]; p: number[];
  xb: number; xl: number; xm: number; yb: number; yl: number; ym: number;
  ls: number; le: number; lc: number; la: number;
  /** The 40-bit accumulator, as unsigned bits (-1: unknown). */
  acc: number;
}

const REGS = ['xb', 'xl', 'xm', 'yb', 'yl', 'ym', 'ls', 'le', 'lc', 'la'] as const;

/** The 40-bit accumulator's pattern as a signed value. */
export const acc40 = (bits: number): bigint => BigInt.asIntN(40, BigInt(bits));

/** The units of the core (its instance names: dec, seq, regs, aguX, aguY, mac, alu) an instruction goes through, the memories it touches, and its path in words. */
export function dsp24Use(word: number): { units: string[]; mems: ('x' | 'y')[]; path: string } {
  const d = decode24(word);
  const u = (units: string[], mems: ('x' | 'y')[], path: string) => ({ units: ['dec', 'seq', ...units], mems, path });
  const agu = (n: number) => (n >= 8 && n < 12) || (n >= 16 && n < 19) ? ['aguX'] : n >= 12 && n < 16 || n >= 20 ? ['aguY'] : [];
  switch (d.name) {
    case 'nop': case 'halt': return u([], [], 'Decode; nothing but PC + 1');
    case 'jmp': return u([], [], 'Decode → Sequencer: the address → PC');
    case 'jz': case 'jnz': return u(['regs'], [], 'Registers (ra) → the zero test → Sequencer → PC');
    case 'loop': return u(['regs'], [], 'Decode → Sequencer: start = PC + 1, end, count (a constant, or a register) → the loop unit');
    case 'mov': return u(['regs', ...new Set([...agu(d.dst), ...agu(d.src)])], [], 'Registers or address registers (src) → mov mux → Registers or address registers (dst)');
    case 'ldi': case 'ldh': return u(['regs', ...agu(d.dst)], [], 'Decode (the constant) → write mux → Registers (or an address register)');
    case 'ld': return u(['regs', d.bus ? 'aguY' : 'aguX'], [d.bus ? 'y' : 'x'], `${d.bus ? 'AGU Y' : 'AGU X'} (pointer) → ${d.bus ? 'Y' : 'X'} memory → write mux → Registers; the pointer steps`);
    case 'st': return u(['regs', d.bus ? 'aguY' : 'aguX'], [d.bus ? 'y' : 'x'], `Registers (ra) → ${d.bus ? 'Y' : 'X'} memory at the AGU's address; the pointer steps`);
    case 'clr': return u(['mac'], [], 'Decode → MAC: acc ← 0');
    case 'mac': return u(['aguX', 'aguY', 'mac'], ['x', 'y'], 'AGU X → X memory and AGU Y → Y memory in the same clock → MAC: acc ← acc + x × y; both pointers step');
    case 'rnd': case 'rndc': return u(['mac', 'regs'], [], `MAC: acc ≫ sh, rounded once, saturated once → Registers (rd)${d.name === 'rndc' ? '; acc ← 0' : ''}`);
    case 'out': return u(['regs'], [], 'Registers (ra) → the out port, valid for this clock');
    default: return u(['regs', 'alu'], [], `Registers (ra, rb or the constant) → ALU (${d.name}) → Registers (rd)`);
  }
}

const hx = (v: number, d = 2) => (v < 0 ? '?'.repeat(d) : v.toString(16).toUpperCase().padStart(d, '0'));

/** The golden model in lock-step with the DSP core, compared register by register after every clock. */
export class Dsp24Monitor {
  iss: Iss24 | null = null;
  desc: Dsp24Desc | null = null;
  mismatch: Mismatch | null = null;
  synced = false;
  retired = 0;
  readonly log: Retired[] = [];
  /** The words `out` sent, as the hardware showed them. */
  readonly outs: number[] = [];
  seq = 0;
  problem: string | null = null;
  prog: number[] | null = null;
  /** The RAM parts that are the X and Y memories (null: not told apart yet / not found). */
  xram: string | null = null;
  yram: string | null = null;
  private progKey = '';
  private lastDoc: ChipDoc | null = null;
  private lastChips: Chips | undefined;
  private resets = -1;
  private nodes: { root: unknown; map: Map<string, HierNode | undefined> } = { root: null, map: new Map() };
  private sample: { out: number; outv: number; halt: number } | null = null;
  private hook = { before: () => this.before(), after: () => this.after() };
  private static readonly LOG = 64;

  constructor(readonly es: MonitorSim, private doc: () => ChipDoc, private chips: () => Chips | undefined = () => undefined) {
    es.edgeHooks.add(this.hook);
    this.sync();
  }

  destroy(): void {
    this.es.edgeHooks.delete(this.hook);
  }

  /** As Cpu4Monitor.sync: re-detect; restart on a reset or a new program ('program' mid-run: the caller resets). */
  sync(): 'program' | 'settings' | null {
    const doc = this.doc(), chips = this.chips();
    if (doc === this.lastDoc && chips === this.lastChips && this.es.resets === this.resets) return null;
    this.lastDoc = doc;
    this.lastChips = chips;
    this.desc = detectDsp24(doc, chips);
    this.prog = this.desc ? dsp24Program(doc, this.desc.rom) : null;
    const pk = JSON.stringify([this.desc, this.prog, this.desc?.rams.map((id) => (doc.parts.find((p) => p.id === id)?.ref as { ram?: { init?: number[] } }).ram?.init)]);
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
    this.outs.length = 0;
    this.seq++;
    this.synced = this.es.cycles === 0;
    this.nodes = { root: null, map: new Map() };
    this.xram = this.yram = null;
    this.problem = !this.desc ? 'no ROM in DSP24 assembly beside a DSP core part' : !this.prog ? `the program in ROM '${this.desc.rom}' does not build`
      : simHasPuzzlePorts(this.es.sim) ? PUZZLE_NO_GOLDEN : null;
    this.iss = null;
    this.ensure();
  }

  /** The golden model, once the memories are told apart (they need the built simulation). */
  private ensure(): Iss24 | null {
    if (this.iss || !this.desc || !this.prog || this.problem) return this.iss;
    this.resolveRams();
    if (!this.xram || !this.yram) return null;
    const init = (id: string) => {
      const ref = this.doc().parts.find((p) => p.id === id)?.ref;
      return ramInit(8, 16, ref && 'ram' in ref ? ref.ram.init : undefined);
    };
    this.iss = new Iss24(this.prog, init(this.xram), init(this.yram));
    return this.iss;
  }

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

  private under(path: string): string {
    return `${this.desc!.core}.${path}`;
  }

  /** X is the RAM on the core's xaddr net, Y the one on yaddr (else the parts called xram / yram, else their order). */
  private resolveRams(): void {
    const d = this.desc;
    if (!d || !this.es.sim) return;
    const same = (a?: readonly number[], b?: readonly number[]) => !!a && !!b && a.length === b.length && a.every((n, i) => n === b[i]);
    const core = this.node(d.core);
    const on = (port: string) => d.rams.find((id) => same(core?.ports[port] as readonly number[] | undefined, this.node(id)?.ports.addr as readonly number[] | undefined));
    this.xram = on('xaddr') ?? (d.rams.includes('xram') ? 'xram' : null);
    this.yram = on('yaddr') ?? (d.rams.includes('yram') ? 'yram' : null);
    if (!this.xram && !this.yram && d.rams.length === 2) [this.xram, this.yram] = d.rams;
  }

  /** The hierarchy has the core's registers (a core drawn otherwise is followed, not checked). */
  get hasState(): boolean {
    if (!this.desc || !this.es.sim) return false;
    const S = DSP24_STATE;
    const paths = [S.pc, ...S.r, ...S.p, ...REGS.map((k) => S[k]), S.acc];
    return paths.every((p) => !!this.node(this.under(p))?.ports.q) && !!this.node(this.desc.core)?.ports.halt;
  }

  get checking(): boolean {
    return !!this.ensure() && this.synced && !this.problem && this.hasState;
  }

  /** Why the model is not compared (null: it is, or there is no model at all). */
  get unchecked(): string | null {
    if (this.problem) return null;
    if (!this.hasState) return 'the core’s registers are not where the dsp24_core part has them (seq.pc, regs.r0, aguX.p0, mac.unit.acc …)';
    return this.ensure() ? null : 'the X and Y memories are not found: two RAM parts of 256 × 16 on the core’s xaddr / xdata and yaddr / ydata ports';
  }

  get done(): boolean {
    return !!this.mismatch || !!this.iss?.halted;
  }

  read(): Dsp24State | null {
    if (!this.es.sim || !this.hasState) return null;
    const S = DSP24_STATE, q = (p: string) => this.value(this.under(p), 'q') ?? -1;
    return { pc: q(S.pc), r: S.r.map(q), p: S.p.map(q), xb: q(S.xb), xl: q(S.xl), xm: q(S.xm), yb: q(S.yb), yl: q(S.yl), ym: q(S.ym), ls: q(S.ls), le: q(S.le), lc: q(S.lc), la: q(S.la), acc: q(S.acc) };
  }

  /** The 256 words of the X or Y memory as the hardware holds them (-1: unknown), or null when not readable. */
  mem(bus: 0 | 1): number[] | null {
    const id = bus ? this.yram : this.xram, sim = this.es.sim;
    const st = id && sim ? ramLeafState(sim as unknown as { leafState(li: number): unknown }, this.node(id)) : null;
    return st ? ramWords(st) : null;
  }

  /** The PC: the core's PC register (-1: X, null: none). */
  get pc(): number | null {
    return this.hasState ? this.value(this.under(DSP24_STATE.pc), 'q') : null;
  }

  /** The ROM's instruction set. */
  get isa(): Isa {
    return isaOf('dsp24')!;
  }

  wordAt(pc: number): number | null {
    return this.prog && pc >= 0 ? this.prog[pc & 255] : null;
  }

  private before(): void {
    this.sample = null;
    if (!this.checking || this.mismatch) return;
    const v = (port: string) => this.value(this.desc!.core, port) ?? -1;
    this.sample = { out: v('out'), outv: v('outv'), halt: v('halt') };
  }

  private after(): void {
    const s = this.sample, iss = this.iss;
    if (!s || !iss || this.mismatch) return;
    const was = iss.halted;
    const st = iss.step();
    const text = disasm24(st.instr);
    const cycle = this.es.cycles;
    const fail = (what: string, name: string, expected: number, got: number, detail: string) => {
      this.mismatch ??= { what, name, expected, got, after: text, cycle, detail };
    };
    if (!was) {
      this.retired++;
      this.seq++;
      const effects: string[] = [];
      if (st.store) effects.push(`${st.store.bus ? 'Y' : 'X'}[${st.store.addr}] ← ${hx(st.store.value, 4)}`);
      if (st.out !== undefined) effects.push(`out ← ${hx(st.out, 4)}`);
      if (st.looped) effects.push('loop back');
      if (st.name === 'halt') effects.push('halted');
      else if (iss.pc !== ((st.pc + 1) & 255) && !st.looped) effects.push(`PC → ${hx(iss.pc)}`);
      this.log.push({ cycle, pc: st.pc, text, effect: effects.join(', ') });
      if (this.log.length > Dsp24Monitor.LOG) this.log.shift();
    }
    // What the pins showed just before the edge: halt, and the output word with its valid strobe.
    if (s.halt !== (st.name === 'halt' ? 1 : 0)) fail('halt', 'halt', st.name === 'halt' ? 1 : 0, s.halt, `halt: expected ${st.name === 'halt' ? 1 : 0}, got ${s.halt < 0 ? '?' : s.halt}`);
    if (s.outv !== (st.out !== undefined && !was ? 1 : 0)) fail('outv', 'outv', st.out !== undefined && !was ? 1 : 0, s.outv, `outv: expected ${st.out !== undefined && !was ? 1 : 0}, got ${s.outv < 0 ? '?' : s.outv}`);
    else if (st.out !== undefined && !was) {
      if (s.out !== st.out) fail('out', 'out', st.out, s.out, `out: expected ${hx(st.out, 4)}, got ${hx(s.out, 4)}`);
      else this.outs.push(st.out);
    }
    const hw = this.read();
    if (!hw) return;
    const want: [string, string, number, number, number][] = [
      ['pc', 'PC', iss.pc, hw.pc, 2],
      ...[...iss.r].map((v, i): [string, string, number, number, number] => [`r${i}`, `r${i}`, v, hw.r[i], 4]),
      ...[...iss.p].map((v, i): [string, string, number, number, number] => [`p${i}`, `p${i}`, v, hw.p[i], 2]),
      ['xb', 'xb', iss.xb, hw.xb, 2], ['xl', 'xl', iss.xl, hw.xl, 2], ['xm', 'xm', iss.xm, hw.xm, 2],
      ['yb', 'yb', iss.yb, hw.yb, 2], ['yl', 'yl', iss.yl, hw.yl, 2], ['ym', 'ym', iss.ym, hw.ym, 2],
      ['ls', 'loop start', iss.ls, hw.ls, 2], ['le', 'loop end', iss.le, hw.le, 2], ['lc', 'loop count', iss.lc, hw.lc, 4], ['la', 'loop active', iss.la, hw.la, 1],
      ['acc', 'acc', Number(BigInt.asUintN(40, iss.acc)), hw.acc, 10],
    ];
    const bad = want.find(([, , e, g]) => e !== g);
    if (bad) {
      const [what, name, e, g, d] = bad;
      fail(what, name, e, g, `${name}: expected ${hx(e, d)}, got ${hx(g, d)}`);
    }
    if (st.store && !was) {
      const words = this.mem(st.store.bus);
      const v = words ? words[st.store.addr] : null;
      if (v !== null && v !== st.store.value) fail('mem', `${st.store.bus ? 'Y' : 'X'}[${st.store.addr}]`, st.store.value, v, `${st.store.bus ? 'Y' : 'X'}[${st.store.addr}]: expected ${hx(st.store.value, 4)}, got ${hx(v, 4)}`);
    }
  }

  /** Every word of X and Y against the model (null: they agree, or are not readable). */
  memoryMismatch(): string | null {
    const iss = this.iss;
    if (!iss) return null;
    for (const bus of [0, 1] as const) {
      const words = this.mem(bus), want = bus ? iss.y : iss.x;
      if (words) for (let i = 0; i < 256; i++) if (words[i] !== want[i]) return `${bus ? 'Y' : 'X'}[${i}] is ${hx(words[i], 4)}, expected ${hx(want[i], 4)}`;
    }
    return null;
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
