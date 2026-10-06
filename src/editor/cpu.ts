// A chip as a processor, DOM-free: which ROM holds its program, which net is its PC, which part
// is its register file (and data memory), when an instruction retires, and what the golden
// model (the ISS) must implement. ChipDoc.cpu stores what the user set; detectCpu fills the rest
// from the names the site's CPUs use (a CPU opened with "Open in Sandbox" keeps its instance
// names: imem, pc, rf, dm, frf; its pins pcOut / pcF, retire, validW), so a remixed CPU and the
// fetch-loop example need no setup. Readers take the editor's simulation and the compile its nets
// belong to; CpuMonitor runs the ISS in lock-step on the editor's rising edges and reports the
// first difference.

import { cacheLines } from '../riscv/cosim';
import { ABI, FABI } from '../riscv/isa';
import { ISS, type IssOptions } from '../riscv/iss';
import { stepEffect } from '../riscv/trace';
import type { HierNode } from '../sim/flatten';
import type { Sim } from '../sim/sim';
import { pack } from '../sim/values';
import type { Compiled } from './compile';
import { romImage, type RomRef } from './memory';
import type { ChipDoc, PartDoc } from './model';

/** A net of the chip: a pin (by id), a pointer (by name: same name, same net), a wire, or a part's port. */
export type NetRef = { pin: string } | { pointer: string } | { wire: string } | { part: string; port: string };

/** What the golden model implements (the chapters' CPUs: system = Zicsr, traps, MMIO). */
export interface CpuIss {
  system?: boolean;
  m?: boolean;
  f?: boolean;
  /** Data memory words (default: as many as the data memory part holds, else 32). */
  dmemWords?: number;
}

/** ChipDoc.cpu: the user's settings; every field left out is detected. */
export interface CpuDoc {
  /** The program ROM (a part with { rom: { addr: 'rv32', w: 32 } }). */
  rom?: string;
  /** The PC: the address of the instruction being fetched. */
  pc?: NetRef;
  /** Register file part (x1..x31 in registers named w1..w31, like the library's regfile or a RAM). */
  regs?: string;
  /** Floating-point register file part (f0..f31). */
  fregs?: string;
  /** Data memory part. */
  dmem?: string;
  /** 1 when an instruction retires at the next rising edge; 'every': one per cycle (also when absent). */
  retire?: NetRef | 'every';
  /** The PC runs ahead of retirement (a pipeline): compare registers only. */
  pipeline?: boolean;
  iss?: CpuIss;
}

/** A complete description (rom always set). */
export interface CpuDesc extends CpuDoc {
  rom: string;
  iss: CpuIss;
  /** Which fields were detected rather than set by the user. */
  auto: Set<keyof CpuDoc>;
}

type RomPart = PartDoc & { ref: { rom: RomRef } };
const isRvRom = (p: PartDoc): p is RomPart => 'rom' in p.ref && p.ref.rom.addr === 'rv32' && p.ref.rom.w === 32;

/** Program ROMs of a chip (byte addressed, 32-bit words): what a CPU can fetch from. */
export const romParts = (doc: ChipDoc): RomPart[] => doc.parts.filter(isRvRom);

const partNamed = (doc: ChipDoc, ...ids: string[]) => ids.map((id) => doc.parts.find((p) => p.id === id)).find((p) => p);
const pinNamed = (doc: ChipDoc, dir: 'in' | 'out', width: number, ...names: string[]) =>
  names.map((n) => doc.pins.find((p) => p.name === n && p.dir === dir && p.width === width)).find((p) => p);

/**
 * Everything detectCpu can find, or null when the chip has no program ROM. Names first (the
 * site's CPUs), then shapes: the PC is what drives the ROM's address when nothing is named pc.
 */
export function detectCpu(doc: ChipDoc): CpuDesc | null {
  const roms = romParts(doc);
  const rom = roms.find((p) => p.id === 'imem') ?? roms[0];
  if (!rom) return null;
  const auto = new Set<keyof CpuDoc>(['rom', 'pc', 'regs', 'fregs', 'dmem', 'retire', 'pipeline', 'iss']);
  const pcPin = pinNamed(doc, 'out', 32, 'pcOut', 'pcF', 'pc');
  const pcReg = partNamed(doc, 'pc');
  const pc: NetRef = pcPin ? { pin: pcPin.id } : pcReg ? { part: pcReg.id, port: 'q' } : { part: rom.id, port: 'addr' };
  const regs = partNamed(doc, 'rf', 'regs', 'regfile') ?? doc.parts.find((p) => 'lib' in p.ref && /^regfile/.test(p.ref.lib));
  const fregs = partNamed(doc, 'frf', 'fregs');
  const ram32 = doc.parts.filter((p) => 'ram' in p.ref && p.ref.ram.w === 32 && p !== regs);
  const dmem = partNamed(doc, 'dm', 'dmem') ?? (ram32.length === 1 ? ram32[0] : undefined);
  const validW = pinNamed(doc, 'out', 1, 'validW');
  const retire = validW ?? pinNamed(doc, 'out', 1, 'retire');
  const pipeline = !!validW || (!!partNamed(doc, 'FD') && !!partNamed(doc, 'MW'));
  const system = !!partNamed(doc, 'csr') && !!partNamed(doc, 'trap');
  return {
    rom: rom.id, pc, auto, iss: { ...(system ? { system } : {}), ...(system && retire ? { m: true } : {}), ...(system && fregs ? { f: true } : {}) },
    ...(regs ? { regs: regs.id } : {}), ...(fregs ? { fregs: fregs.id } : {}), ...(dmem ? { dmem: dmem.id } : {}),
    ...(retire ? { retire: { pin: retire.id } } : {}), ...(pipeline ? { pipeline } : {}),
  };
}

/** The user's settings over what detection finds (null: no program ROM to run). */
export function resolveCpu(doc: ChipDoc): CpuDesc | null {
  const set = doc.cpu;
  const det = detectCpu(doc);
  if (!set) return det;
  const romId = set.rom && doc.parts.some((p) => p.id === set.rom && isRvRom(p)) ? set.rom : det?.rom;
  if (!romId) return null;
  const auto = new Set(det?.auto ?? []);
  const out: CpuDesc = { ...(det ?? { rom: romId, iss: {}, auto }), rom: romId, auto };
  for (const k of ['rom', 'pc', 'regs', 'fregs', 'dmem', 'retire', 'pipeline', 'iss'] as const) {
    if (set[k] === undefined) continue;
    (out as unknown as Record<string, unknown>)[k] = set[k];
    auto.delete(k);
  }
  // A ROM chosen by hand: the detected PC may belong to another ROM's address.
  if (set.rom && !set.pc && det && 'part' in det.pc! && det.pc.port === 'addr') out.pc = { part: romId, port: 'addr' };
  for (const k of ['regs', 'fregs', 'dmem'] as const) if (out[k] === '') delete out[k];
  out.iss = { ...out.iss };
  return out;
}

// ---- sanitizer -------------------------------------------------------------------------------

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);
const str = (x: unknown): x is string => typeof x === 'string';

export function sanitizeNetRef(r: unknown): NetRef | undefined {
  if (!isObj(r)) return undefined;
  if (str(r.part) && str(r.port)) return { part: r.part, port: r.port };
  if (str(r.pin)) return { pin: r.pin };
  if (str(r.pointer) && r.pointer.trim()) return { pointer: r.pointer };
  if (str(r.wire)) return { wire: r.wire };
  return undefined;
}

/** ChipDoc.cpu from untrusted JSON (undefined: none, or nothing usable). Empty part ids mean "none". */
export function sanitizeCpu(c: unknown): CpuDoc | undefined {
  if (!isObj(c)) return undefined;
  const out: CpuDoc = {};
  for (const k of ['rom', 'regs', 'fregs', 'dmem'] as const) if (str(c[k])) out[k] = c[k] as string;
  const pc = sanitizeNetRef(c.pc);
  if (pc) out.pc = pc;
  const retire = c.retire === 'every' ? 'every' : sanitizeNetRef(c.retire);
  if (retire) out.retire = retire;
  if (typeof c.pipeline === 'boolean') out.pipeline = c.pipeline;
  if (isObj(c.iss)) {
    const i = c.iss;
    const iss: CpuIss = {};
    for (const k of ['system', 'm', 'f'] as const) if (typeof i[k] === 'boolean') iss[k] = i[k] as boolean;
    if (Number.isInteger(i.dmemWords) && (i.dmemWords as number) >= 1 && (i.dmemWords as number) <= 1 << 16) iss.dmemWords = i.dmemWords as number;
    out.iss = iss;
  }
  return Object.keys(out).length ? out : undefined;
}

// ---- readers ---------------------------------------------------------------------------------

/** What readers need: the simulation and the compile its net numbering belongs to (EditorSim has both). */
export interface CpuSimView {
  sim: Sim | null;
  built: Compiled | null;
}

/** The flat nets of a NetRef (null: not connected, or not in this build). */
export function refNets(v: CpuSimView, doc: ChipDoc, r: NetRef): number[] | null {
  const sim = v.sim, b = v.built;
  if (!sim || !b) return null;
  let i: number | undefined;
  if ('pin' in r) i = b.netOfEnd.get(`pin:${r.pin}`);
  else if ('part' in r) i = b.netOfEnd.get(`p:${r.part}.${r.port}`);
  else if ('wire' in r) i = b.netOfWire.get(r.wire);
  else if ('pointer' in r) {
    for (const l of doc.labels) if (l.name === r.pointer && (i = b.netOfLabel.get(l.id)) !== undefined && i >= 0) break;
  }
  if (i === undefined || i < 0) return null;
  return sim.design.root.nets?.[i] ?? null;
}

/** A NetRef's value (-1: unknown), or null when it does not resolve. */
export function refValue(v: CpuSimView, doc: ChipDoc, r: NetRef): number | null {
  const nets = refNets(v, doc, r);
  return nets && v.sim ? pack(v.sim.getBits(nets)) : null;
}

const WORD = /^w(\d+)$/;

/** Registers named w<i> (each with a q port) directly under a node. */
function wordRegs(n: HierNode): Map<number, HierNode> {
  const out = new Map<number, HierNode>();
  for (const [name, c] of n.children ?? []) {
    const m = WORD.exec(name);
    if (m && c.ports.q) out.set(Number(m[1]), c);
  }
  return out;
}

/**
 * Where a part keeps its words: the node itself (regfile, RAM: w0, w1, ... registers), its `ram`
 * (the data memory, a cache's main memory), or the one child that has them (a user's wrapper chip).
 */
export function storageOf(n: HierNode | undefined, depth = 3): Map<number, HierNode> | null {
  if (!n?.expanded) return null;
  const own = wordRegs(n);
  if (own.size >= 2) return own;
  if (depth <= 0) return null;
  const ram = storageOf(n.children?.get('ram'), depth - 1);
  if (ram) return ram;
  const found = [...(n.children?.values() ?? [])].map((c) => storageOf(c, depth - 1)).filter((x) => x);
  return found.length === 1 ? found[0] : null;
}

const partNode = (sim: Sim, id: string | undefined) => (id ? sim.design.root.children?.get(id) : undefined);

/** x0..x31 (or f0..f31) of a register file part; x0 reads 0 when the part has no w0. -1: unknown. */
export function readRegs(sim: Sim, part: string | undefined): number[] | null {
  const st = storageOf(partNode(sim, part));
  if (!st) return null;
  return Array.from({ length: 32 }, (_, i) => {
    const r = st.get(i);
    return r ? pack(sim.getBits(r.ports.q)) : 0;
  });
}

/**
 * The data memory as the program sees it: the words of its storage, a byte-banked memory's four
 * lanes joined, a write-back cache's dirty lines over main memory (cosim.ts cacheLines). -1: unknown.
 */
export function readMem(sim: Sim, part: string | undefined): number[] | null {
  const n = partNode(sim, part);
  if (!n?.expanded) return null;
  let words: number[] | null = null;
  const banks = [0, 1, 2, 3].map((i) => storageOf(n.children?.get(`b${i}`), 1));
  if (banks.every((b) => b)) {
    words = [];
    for (let lane = 0; lane < 4; lane++) {
      for (const [i, r] of banks[lane]!) {
        const v = pack(sim.getBits(r.ports.q));
        words[i] = words[i] === -1 || v < 0 ? -1 : ((words[i] ?? 0) + v * 2 ** (8 * lane)) >>> 0;
      }
    }
  } else {
    const st = storageOf(n);
    if (!st) return null;
    words = [];
    for (const [i, r] of st) words[i] = pack(sim.getBits(r.ports.q));
  }
  if (n.children?.has('way0') || n.children?.has('tags')) {
    try {
      for (const l of cacheLines(sim, n)) if (l.valid && l.dirty) l.words.forEach((v, i) => (words![l.base + i] = v));
    } catch { /* not the library's cache: main memory only */ }
  }
  for (let i = 0; i < words.length; i++) words[i] ??= 0;
  return words;
}

export interface CpuRead {
  /** -1: unknown; null: no PC. */
  pc: number | null;
  x: number[] | null;
  f: number[] | null;
  dmem: number[] | null;
  /** An instruction retires at the next rising edge. */
  retiring: boolean;
}

export function readCpu(v: CpuSimView, doc: ChipDoc, d: CpuDesc): CpuRead | null {
  const sim = v.sim;
  if (!sim) return null;
  const r = d.retire && d.retire !== 'every' ? refValue(v, doc, d.retire) : 1;
  return {
    pc: d.pc ? refValue(v, doc, d.pc) : null,
    x: readRegs(sim, d.regs),
    f: readRegs(sim, d.fregs),
    dmem: readMem(sim, d.dmem),
    retiring: r === 1 || r === null,
  };
}

/** The program a ROM part holds (null: no such ROM, or it does not build). */
export function romProgram(doc: ChipDoc, rom: string): { words: number[]; k: number } | null {
  const p = doc.parts.find((q) => q.id === rom);
  if (!p || !isRvRom(p)) return null;
  const img = romImage(p.ref.rom);
  return img.error ? null : { words: img.words, k: p.ref.rom.k };
}

/**
 * Where each in-flight instruction of a pipelined CPU is (the site's pipeline: pipeline registers
 * FD, DE, EM, (MX, XW |) MW with pc<stage> / valid<stage> ports); null for any other CPU.
 * F is the PC being fetched.
 */
export function pipelineSlots(v: CpuSimView, doc: ChipDoc, d: CpuDesc): { stage: string; pc: number }[] | null {
  const sim = v.sim;
  const kids = sim?.design.root.children;
  if (!sim || !kids || !d.pipeline || !kids.has('FD') || !kids.has('DE') || !kids.has('EM')) return null;
  const val = (inst: string, port: string) => {
    const n = kids.get(inst)?.ports[port];
    return n ? pack(sim.getBits(n)) : -1;
  };
  const regs: [string, string][] = [['D', 'FD'], ['E', 'DE'], ['M', 'EM'], ...(kids.has('MX') ? [['X', 'MX'], ['W', 'XW']] as [string, string][] : [['W', 'MW']] as [string, string][])];
  const out: { stage: string; pc: number }[] = [];
  const f = d.pc ? refValue(v, doc, d.pc) : null;
  if (f !== null && f >= 0) out.push({ stage: 'F', pc: f });
  for (const [stage, inst] of regs) if (val(inst, `valid${stage}`) === 1 && val(inst, `pc${stage}`) >= 0) out.push({ stage, pc: val(inst, `pc${stage}`) });
  return out;
}

// ---- lock-step -------------------------------------------------------------------------------

export interface Mismatch {
  /** 'x5', 'f3' or 'pc'. */
  what: string;
  /** ABI name ('a0'), or 'PC'. */
  name: string;
  expected: number;
  got: number;
  /** The instruction after which it differed. */
  after: string;
  cycle: number;
}

export interface Retired { cycle: number; pc: number; text: string; effect: string }

/** What the monitor needs from EditorSim. */
export interface MonitorSim extends CpuSimView {
  cycles: number;
  resets: number;
  edgeHooks: Set<{ before?(): void; after?(): void }>;
  runCycles(n: number, stop?: () => boolean, budgetMs?: number): number;
  pinBits?(name: string): ArrayLike<number> | null;
}

const hex = (v: number) => (v < 0 ? 'x'.repeat(8) : (v >>> 0).toString(16).padStart(8, '0'));
export const fmtWord = (v: number) => (v < 0 ? '0x????????' : `0x${hex(v)}`);

/**
 * The golden model in lock-step with a CPU chip: on every rising edge at which the hardware
 * retires an instruction, the ISS executes one and the registers (and, outside a pipeline, the
 * PC) are compared. Restarts on a power cycle or when the program changes; a monitor that joins
 * after cycle 0 waits for the next reset (`synced` false).
 */
export class CpuMonitor {
  iss: ISS | null = null;
  desc: CpuDesc | null = null;
  mismatch: Mismatch | null = null;
  /** The ISS started with the hardware (cycle 0). */
  synced = false;
  /** Instructions retired since the reset. */
  retired = 0;
  readonly log: Retired[] = [];
  /** Bumped on every retirement (views redraw on change). */
  seq = 0;
  /** Why there is no golden model (no ROM, a ROM program that does not build). */
  problem: string | null = null;
  /** The program the ISS runs (null: none). */
  prog: { words: number[]; k: number } | null = null;
  private progKey = '';
  private lastDoc: ChipDoc | null = null;
  private resets = -1;
  private willRetire = false;
  private hook = { before: () => this.before(), after: () => this.after() };
  private static readonly LOG = 64;

  constructor(readonly es: MonitorSim, private doc: () => ChipDoc) {
    es.edgeHooks.add(this.hook);
    this.sync();
  }

  destroy(): void {
    this.es.edgeHooks.delete(this.hook);
  }

  /** Re-read the description (the document or the build changed); restart on a reset or a new program. Returns true when the program changed. */
  sync(): boolean {
    const doc = this.doc();
    if (doc === this.lastDoc && this.es.resets === this.resets) return false;
    this.lastDoc = doc;
    this.desc = resolveCpu(doc);
    const prog = this.desc ? romProgram(doc, this.desc.rom) : null;
    this.prog = prog;
    const key = this.desc ? JSON.stringify([prog?.words ?? null, prog?.k, this.desc.iss, this.desc.dmem, this.desc.regs]) : '';
    const changed = key !== this.progKey;
    if (changed || this.es.resets !== this.resets) {
      const progChanged = changed && this.progKey !== '';
      this.progKey = key;
      this.resets = this.es.resets;
      this.restart(prog);
      return progChanged;
    }
    return false;
  }

  private restart(prog: { words: number[]; k: number } | null): void {
    this.mismatch = null;
    this.retired = 0;
    this.log.length = 0;
    this.seq++;
    this.synced = this.es.cycles === 0;
    const d = this.desc;
    this.problem = !d ? 'no program ROM (a ROM part with byte addresses and 32-bit words)'
      : !prog ? `the program in ROM '${d.rom}' does not build`
      : null;
    if (!d || !prog) { this.iss = null; return; }
    // The ISS's memory wraps like the hardware's: as many words as the data memory part holds.
    const sim = this.es.sim;
    const n = d.iss.dmemWords ?? (sim && d.dmem ? readMem(sim, d.dmem)?.length : undefined) ?? 32;
    const { dmemWords: _n, ...rest } = d.iss;
    const opts: IssOptions = { ...rest, imemWords: 2 ** prog.k, dmemWords: 2 ** Math.round(Math.log2(Math.max(1, n))) };
    this.iss = new ISS(prog.words, opts);
  }

  /** Can the golden model check this CPU (a program, registers to compare, in step since cycle 0)? */
  get checking(): boolean {
    return !!this.iss && this.synced && !!this.desc?.regs;
  }

  read(): CpuRead | null {
    return this.desc ? readCpu(this.es, this.doc(), this.desc) : null;
  }

  private before(): void {
    const d = this.desc, iss = this.iss;
    this.willRetire = false;
    if (!d || !iss || !this.synced) return;
    const doc = this.doc();
    const r = d.retire && d.retire !== 'every' ? refValue(this.es, doc, d.retire) : 1;
    this.willRetire = r === 1;
    if (iss.system) {
      // The system CPU's inputs, sampled like the hardware samples them.
      const pin = (n: string) => doc.pins.find((p) => p.name === n && p.dir === 'in');
      const irq = pin('irq'), sw = pin('switches');
      if (irq) iss.irq = refValue(this.es, doc, { pin: irq.id }) === 1;
      if (sw) iss.switches = Math.max(0, refValue(this.es, doc, { pin: sw.id }) ?? 0);
    }
  }

  private after(): void {
    const iss = this.iss, d = this.desc;
    if (!this.willRetire || !iss || !d || iss.halted) return;
    this.willRetire = false;
    if (!d.regs) {
      // Nothing to compare with (a datapath being built): count, but do not let the model run
      // its own course (it takes branches the hardware may not have yet).
      this.retired++;
      this.seq++;
      return;
    }
    const info = iss.step();
    this.retired++;
    this.seq++;
    this.log.push({ cycle: this.es.cycles, pc: info.pc, text: info.text, effect: stepEffect(info) });
    if (this.log.length > CpuMonitor.LOG) this.log.shift();
    if (this.mismatch) return;
    const sim = this.es.sim;
    if (!sim) return;
    const at = (what: string, name: string, expected: number, got: number) =>
      (this.mismatch = { what, name, expected: expected >>> 0, got, after: info.text, cycle: this.es.cycles });
    const x = readRegs(sim, d.regs);
    if (x) {
      const i = x.findIndex((v, k) => v !== iss.x[k] >>> 0);
      if (i >= 0) return void at(`x${i}`, ABI[i], iss.x[i], x[i]);
    }
    const f = readRegs(sim, d.fregs);
    if (f) {
      const i = f.findIndex((v, k) => v !== iss.f[k] >>> 0);
      if (i >= 0) return void at(`f${i}`, FABI[i], iss.f[i], f[i]);
    }
    if (!d.pipeline && d.pc) {
      const pc = refValue(this.es, this.doc(), d.pc);
      if (pc !== null && pc !== iss.pc >>> 0) at('pc', 'PC', iss.pc, pc);
    }
  }

  /** Run until the program halts (the ISS says so), a mismatch, `cap` cycles in all, or the time budget. */
  runToHalt(budgetMs = 12, cap = 50000): number {
    if (!this.checking) return 0;
    const left = cap - this.es.cycles;
    if (left <= 0) return 0;
    return this.es.runCycles(left, () => this.done, budgetMs);
  }

  /** Clock until the next instruction retires (at most `cap` cycles). */
  stepInstr(cap = 400): number {
    const n0 = this.retired;
    if (!this.iss || !this.synced) return this.es.runCycles(1);
    return this.es.runCycles(cap, () => this.retired > n0 || (!!this.iss?.halted && !!this.desc?.regs));
  }

  /** Nothing more to run: halted, or a mismatch. */
  get done(): boolean {
    return !!this.iss?.halted || !!this.mismatch;
  }

  /** The instruction at a byte address of the program. */
  wordAt(pc: number): number | null {
    const prog = this.prog;
    if (!prog || pc < 0) return null;
    return prog.words[(pc >>> 2) % 2 ** prog.k] ?? 0x13;
  }
}

/** One line for a mismatch: `a0 (x10) after "addi a0, a0, 1", cycle 7: expected 0x…, got 0x…`. */
export function mismatchText(m: Mismatch): string {
  const reg = m.what === 'pc' ? 'PC' : `${m.name} (${m.what})`;
  return `${reg} after “${m.after}”, cycle ${m.cycle}: expected ${fmtWord(m.expected)}, got ${fmtWord(m.got)}`;
}

/** What the panel can show and what it cannot, in words (for a CPU being built). */
export function cpuGaps(d: CpuDesc, r: CpuRead | null): string[] {
  const out: string[] = [];
  if (!d.pc || r?.pc === null) out.push('no PC: set the net that holds the fetch address');
  if (!d.regs || !r?.x) out.push('no register file: registers cannot be shown or checked');
  if (d.dmem && !r?.dmem) out.push(`data memory '${d.dmem}' has no words to read`);
  return out;
}

