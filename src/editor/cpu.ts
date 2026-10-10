// A chip as a processor, DOM-free: which ROM holds its program, which net is its PC, which part
// is its register file (and data memory), when an instruction retires, and what the golden
// model (the ISS) must implement. ChipDoc.cpu stores what the user set; detectCpu fills the rest
// from the names the site's CPUs use (a CPU opened with "Open in Sandbox" keeps its instance
// names: imem, pc, rf, dm, frf, fcsr; its pins pcOut / pcF, retire, validW, and the system CPU's
// switches, irq, consoleData, consoleValid, leds), so a remixed CPU and the fetch-loop example
// need no setup. A part may sit inside a user chip: its path is dotted ('imem.rom', the ROM behind
// an instruction cache). Readers take the editor's simulation and the compile its nets belong
// to; CpuMonitor runs the ISS in lock-step on the editor's rising edges and reports the first
// difference: registers, PC, fcsr, data memory (after stores), console and LEDs.
//
// A library core placed as a part (the multi-core's rv32i_core: no data memory, a memory port)
// counts too: its register file is '<part>.rf'. A chip that also places a console or a switch bank
// (the computer example) gets the ISS's memory-mapped I/O without the rest of the system (mmio):
// the console part's text, a switch bank's positions and an LED bank named leds stand in for the
// system CPU's consoleData / switches / leds pins.

import { type RamState, ramLeafState, ramWords } from '../lib/bigmem';
import { consoleAppend, consoleInit, type ConsoleState, consoleText, ioNodes, ioState, type SwitchState } from './ioparts';
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
  /** Memory-mapped console, LEDs and switches only (riscv/iss.ts IssOptions.mmio). */
  mmio?: boolean;
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

/** A complete description (rom always set). Part fields are paths: 'rf', or 'imem.rom' inside a user chip. */
export interface CpuDesc extends CpuDoc {
  rom: string;
  iss: CpuIss;
  /** The part with an `fcsr` output (RV32F: frm and the accrued flags); detected only. */
  fcsr?: string;
  /** Which fields were detected rather than set by the user. */
  auto: Set<keyof CpuDoc>;
}

/** The workspace's user chips by id: what a part path follows. */
export type Chips = Readonly<Record<string, ChipDoc>>;

type RomPart = PartDoc & { ref: { rom: RomRef } };
const isRvRom = (p: PartDoc): p is RomPart => 'rom' in p.ref && p.ref.rom.addr === 'rv32' && p.ref.rom.w === 32;

/** Program ROMs of a chip (byte addressed, 32-bit words): what a CPU can fetch from. */
export const romParts = (doc: ChipDoc): RomPart[] => doc.parts.filter(isRvRom);

/** A part by path ('imem.rom': the part rom of the user chip placed as imem), with the chip it is in. */
export function partAt(doc: ChipDoc, path: string, chips?: Chips): { doc: ChipDoc; part: PartDoc } | null {
  const ids = path.split('.');
  let d = doc;
  for (let i = 0; ; i++) {
    const p = d.parts.find((q) => q.id === ids[i]);
    if (!p) return null;
    if (i === ids.length - 1) return { doc: d, part: p };
    const sub = 'chip' in p.ref ? chips?.[p.ref.chip] : undefined;
    if (!sub) return null;
    d = sub;
  }
}

/** Paths of the program ROMs inside the user chips placed in `doc` (up to `depth` levels down). */
export function nestedRoms(doc: ChipDoc, chips: Chips | undefined, depth = 2): string[] {
  if (!chips || depth <= 0) return [];
  const out: string[] = [];
  for (const p of doc.parts) {
    const sub = 'chip' in p.ref ? chips[p.ref.chip] : undefined;
    if (!sub || sub === doc) continue;
    for (const r of romParts(sub)) out.push(`${p.id}.${r.id}`);
    for (const r of nestedRoms(sub, chips, depth - 1)) out.push(`${p.id}.${r}`);
  }
  return out;
}

/** Library cores with a memory port and no data memory (singleCycleCpu shared): their register file is '<part>.rf'. */
const isPortCore = (lib: string) => lib === 'rv32i_core' || /_core$/.test(lib);

/** Does the chip (or a user chip placed in it) hold a console or a switch bank? */
function hasIoParts(doc: ChipDoc, chips: Chips | undefined, depth = 2): boolean {
  return doc.parts.some((p) => 'console' in p.ref || 'switches' in p.ref
    || (depth > 0 && 'chip' in p.ref && !!chips?.[p.ref.chip] && chips[p.ref.chip] !== doc && hasIoParts(chips[p.ref.chip], chips, depth - 1)));
}

const partNamed = (doc: ChipDoc, ...ids: string[]) => ids.map((id) => doc.parts.find((p) => p.id === id)).find((p) => p);
export const pinNamed = (doc: ChipDoc, dir: 'in' | 'out', width: number, ...names: string[]) =>
  names.map((n) => doc.pins.find((p) => p.name === n && p.dir === dir && p.width === width)).find((p) => p);

/**
 * Everything detectCpu can find, or null when the chip has no program ROM. Names first (the
 * site's CPUs), then shapes: the PC is what drives the ROM's address when nothing is named pc.
 * A ROM inside one placed user chip counts (an instruction cache wrapped around it); ROMs inside
 * several are several cores (multicpu.ts).
 */
export function detectCpu(doc: ChipDoc, chips?: Chips): CpuDesc | null {
  const roms = romParts(doc);
  let rom = (roms.find((p) => p.id === 'imem') ?? roms[0])?.id;
  if (!rom) {
    const nested = nestedRoms(doc, chips);
    if (new Set(nested.map((r) => r.split('.')[0])).size !== 1) return null;
    rom = nested.find((r) => r.startsWith('imem.')) ?? nested[0];
  }
  const auto = new Set<keyof CpuDoc>(['rom', 'pc', 'regs', 'fregs', 'dmem', 'retire', 'pipeline', 'iss']);
  const pcPin = pinNamed(doc, 'out', 32, 'pcOut', 'pcF', 'pc');
  const pcReg = partNamed(doc, 'pc');
  const pc: NetRef = pcPin ? { pin: pcPin.id } : pcReg ? { part: pcReg.id, port: 'q' } : { part: rom.split('.')[0], port: 'addr' };
  const core = doc.parts.find((p) => 'lib' in p.ref && isPortCore(p.ref.lib));
  const regs = partNamed(doc, 'rf', 'regs', 'regfile') ?? doc.parts.find((p) => 'lib' in p.ref && /^regfile/.test(p.ref.lib));
  const regsPath = regs?.id ?? (core ? `${core.id}.rf` : undefined);
  const fregs = partNamed(doc, 'frf', 'fregs');
  const ram32 = doc.parts.filter((p) => 'ram' in p.ref && p.ref.ram.w === 32 && p !== regs);
  const dmem = partNamed(doc, 'dm', 'dmem') ?? (ram32.length === 1 ? ram32[0] : undefined);
  const validW = pinNamed(doc, 'out', 1, 'validW');
  const retire = validW ?? pinNamed(doc, 'out', 1, 'retire');
  const pipeline = !!validW || (!!partNamed(doc, 'FD') && !!partNamed(doc, 'MW'));
  const system = !!partNamed(doc, 'csr') && !!partNamed(doc, 'trap');
  const fcsr = partNamed(doc, 'fcsr');
  const mmio = !system && hasIoParts(doc, chips);
  return {
    rom, pc, auto, iss: { ...(system ? { system } : {}), ...(mmio ? { mmio } : {}), ...(system && retire ? { m: true } : {}), ...(system && fregs ? { f: true } : {}) },
    ...(regsPath ? { regs: regsPath } : {}), ...(fregs ? { fregs: fregs.id } : {}), ...(dmem ? { dmem: dmem.id } : {}),
    ...(retire ? { retire: { pin: retire.id } } : {}), ...(pipeline ? { pipeline } : {}), ...(fcsr ? { fcsr: fcsr.id } : {}),
  };
}

/** The user's settings over what detection finds (null: no program ROM to run). */
export function resolveCpu(doc: ChipDoc, chips?: Chips): CpuDesc | null {
  const set = doc.cpu;
  const det = detectCpu(doc, chips);
  if (!set) return det;
  const at = set.rom ? partAt(doc, set.rom, chips) : null;
  const romId = at && isRvRom(at.part) ? set.rom! : det?.rom;
  if (!romId) return null;
  const auto = new Set(det?.auto ?? []);
  const out: CpuDesc = { ...(det ?? { rom: romId, iss: {}, auto }), rom: romId, auto };
  for (const k of ['rom', 'pc', 'regs', 'fregs', 'dmem', 'retire', 'pipeline', 'iss'] as const) {
    if (set[k] === undefined) continue;
    (out as unknown as Record<string, unknown>)[k] = set[k];
    auto.delete(k);
  }
  // A ROM chosen by hand: the detected PC may belong to another ROM's address.
  if (set.rom && !set.pc && det && 'part' in det.pc! && det.pc.port === 'addr') out.pc = { part: romId.split('.')[0], port: 'addr' };
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
    for (const k of ['system', 'mmio', 'm', 'f'] as const) if (typeof i[k] === 'boolean') iss[k] = i[k] as boolean;
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

/** The flat nets of a NetRef (null: not connected, or not in this build). A part's port may be a path's. */
export function refNets(v: CpuSimView, doc: ChipDoc, r: NetRef): number[] | null {
  const sim = v.sim, b = v.built;
  if (!sim || !b) return null;
  if ('part' in r && r.part.includes('.')) return partNode(sim, r.part)?.ports[r.port] ?? null;
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

/** The value of a pin by name (-1: unknown), or null when there is no such pin. */
export function pinValue(v: CpuSimView, doc: ChipDoc, name: string, dir: 'in' | 'out', width: number): number | null {
  const p = pinNamed(doc, dir, width, name);
  return p ? refValue(v, doc, { pin: p.id }) : null;
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

/** Where a memory keeps its words: w<i> registers, or a large RAM's leaf state (lib/bigmem.ts). */
export type MemStore = { regs: Map<number, HierNode> } | { ram: RamState };

/** storageOf, also finding a large RAM simulated as a lookup (the node itself, its `ram`, or the one child that has one). */
export function memStoreOf(sim: Sim, n: HierNode | undefined, depth = 3): MemStore | null {
  const st = ramLeafState(sim, n);
  if (st) return { ram: st };
  if (!n?.expanded) return null;
  const own = wordRegs(n);
  if (own.size >= 2) return { regs: own };
  if (depth <= 0) return null;
  const ram = memStoreOf(sim, n.children?.get('ram'), depth - 1);
  if (ram) return ram;
  const found = [...(n.children?.values() ?? [])].map((c) => memStoreOf(sim, c, depth - 1)).filter((x) => x);
  return found.length === 1 ? found[0] : null;
}

/** The simulation's node of a part path ('rf', 'imem.rom'). */
export function partNode(sim: Sim, path: string | undefined): HierNode | undefined {
  if (!path) return undefined;
  let n: HierNode | undefined = sim.design.root;
  for (const id of path.split('.')) n = n?.children?.get(id);
  return n;
}

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
  const leaf = ramLeafState(sim, n);
  if (leaf) return ramWords(leaf);
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
    const st = memStoreOf(sim, n);
    if (!st) return null;
    if ('ram' in st) words = ramWords(st.ram);
    else {
      words = [];
      for (const [i, r] of st.regs) words[i] = pack(sim.getBits(r.ports.q));
    }
  }
  if (n.children?.has('way0') || n.children?.has('tags')) {
    try {
      for (const l of cacheLines(sim, n)) if (l.valid && l.dirty) l.words.forEach((v, i) => (words![l.base + i] = v));
    } catch { /* not the library's cache: main memory only */ }
  }
  for (let i = 0; i < words.length; i++) words[i] ??= 0;
  return words;
}

/** A part's fcsr output ({frm, fflags}; -1: unknown), or null. */
export function readFcsr(sim: Sim, part: string | undefined): number | null {
  const nets = partNode(sim, part)?.ports.fcsr;
  return nets ? pack(sim.getBits(nets)) : null;
}

export interface CpuRead {
  /** -1: unknown; null: no PC. */
  pc: number | null;
  x: number[] | null;
  f: number[] | null;
  fcsr: number | null;
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
    fcsr: readFcsr(sim, d.fcsr),
    dmem: readMem(sim, d.dmem),
    retiring: r === 1 || r === null,
  };
}

/** The program a ROM part holds (null: no such ROM, or it does not build). */
export function romProgram(doc: ChipDoc, rom: string, chips?: Chips): { words: number[]; k: number } | null {
  const p = partAt(doc, rom, chips)?.part;
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
  /** 'x5', 'f3', 'pc', 'fcsr', 'mem', 'console' or 'leds'. */
  what: string;
  /** ABI name ('a0'), 'PC', 'fcsr', 'memory [0x40]', 'LEDs', 'console'. */
  name: string;
  expected: number;
  got: number;
  /** Replaces "expected …, got …" (the console: the text each one printed). */
  detail?: string;
  /** The instruction after which it differed. */
  after: string;
  cycle: number;
  /** Which core (a multi-core chip). */
  hart?: number;
}

export interface Retired { cycle: number; pc: number; text: string; effect: string; hart?: number }

/** What the monitor needs from EditorSim. */
export interface MonitorSim extends CpuSimView {
  cycles: number;
  resets: number;
  edgeHooks: Set<{ before?(): void; after?(): void }>;
  runCycles(n: number, stop?: () => boolean, budgetMs?: number): number;
}

const hex = (v: number) => (v < 0 ? 'x'.repeat(8) : (v >>> 0).toString(16).padStart(8, '0'));
export const fmtWord = (v: number) => (v < 0 ? '0x????????' : `0x${hex(v)}`);

/** The first data-memory word where the hardware and the model differ (null: none). */
export function memDiff(hw: number[], model: ArrayLike<number>): { i: number; hw: number; model: number } | null {
  const n = Math.min(hw.length, model.length);
  for (let i = 0; i < n; i++) if (hw[i] !== model[i] >>> 0) return { i, hw: hw[i], model: model[i] >>> 0 };
  return null;
}

const memName = (i: number) => `memory [0x${(4 * i).toString(16).padStart(2, '0')}]`;
const quote = (s: string) => JSON.stringify(s.length > 24 ? `…${s.slice(-24)}` : s);

/**
 * The golden model in lock-step with a CPU chip: on every rising edge at which the hardware
 * retires an instruction, the ISS executes one and the registers (and, outside a pipeline, the
 * PC), fcsr, the data memory after a store (a pipeline's at the halt: its stores run ahead of
 * retirement), the console and the LEDs are compared. Restarts on a power cycle or when the
 * program changes; a monitor that joins after cycle 0 waits for the next reset (`synced` false).
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
  /** What the hardware wrote to the console (consoleValid / consoleData pins, or a console part) since the reset. */
  console = '';
  private progKey = '';
  private cfgKey = '';
  private lastDoc: ChipDoc | null = null;
  private lastChips: Chips | undefined;
  private resets = -1;
  private willRetire = false;
  /** The console and switch-bank parts of the simulation they were found in (mmio without pins). */
  private io: { sim: Sim; console?: HierNode; switches?: HierNode } | null = null;
  /** Characters the console part had taken when `console` was last read from it (-1: not yet). */
  private conN = -1;
  /** The ISS's console text as a console part shows it (control codes applied), for the comparison. */
  private issCon: ConsoleState = consoleInit();
  private issConLen = 0;
  /** What both consoles had printed when they were last compared. */
  private compared = '';
  private hook = { before: () => this.before(), after: () => this.after() };
  private static readonly LOG = 64;

  constructor(readonly es: MonitorSim, private doc: () => ChipDoc, private chips: () => Chips | undefined = () => undefined) {
    es.edgeHooks.add(this.hook);
    this.sync();
  }

  destroy(): void {
    this.es.edgeHooks.delete(this.hook);
  }

  /**
   * Re-read the description (the document changed); restart on a reset, a new program or new
   * settings. Returns what changed mid-run ('program' or 'settings'; null otherwise): the caller
   * resets the hardware so both start over together.
   */
  sync(): 'program' | 'settings' | null {
    const doc = this.doc(), chips = this.chips();
    if (doc === this.lastDoc && chips === this.lastChips && this.es.resets === this.resets) return null;
    this.lastDoc = doc;
    this.lastChips = chips;
    this.desc = resolveCpu(doc, chips);
    const prog = this.desc ? romProgram(doc, this.desc.rom, chips) : null;
    this.prog = prog;
    const pk = JSON.stringify(prog ? [prog.words, prog.k] : null);
    const ck = this.desc ? JSON.stringify([this.desc.rom, this.desc.iss, this.desc.dmem, this.desc.regs, this.desc.fregs, this.desc.retire, this.desc.pipeline, this.desc.pc]) : '';
    const what = this.progKey && pk !== this.progKey ? 'program' : this.cfgKey && ck !== this.cfgKey ? 'settings' : null;
    if (what || this.es.resets !== this.resets || !this.progKey) {
      this.progKey = pk;
      this.cfgKey = ck;
      this.resets = this.es.resets;
      this.restart(prog);
      return this.es.cycles > 0 ? what : null;
    }
    return null;
  }

  private restart(prog: { words: number[]; k: number } | null): void {
    this.mismatch = null;
    this.retired = 0;
    this.log.length = 0;
    this.console = '';
    this.conN = -1;
    this.issCon = consoleInit();
    this.issConLen = 0;
    this.compared = '';
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

  /** The LEDs pin of a system CPU, or an LED bank part named leds (null: none; -1: unknown). */
  get leds(): number | null {
    const doc = this.doc();
    const pin = pinValue(this.es, doc, 'leds', 'out', 8);
    if (pin !== null) return pin;
    const p = doc.parts.find((q) => q.id === 'leds' && 'display' in q.ref && q.ref.display === 'led' && (q.ref.width ?? 1) <= 8);
    return p ? refValue(this.es, doc, { part: p.id, port: 'a' }) : null;
  }

  /** The console and switch bank (I/O parts at any depth) standing in for the system CPU's pins. */
  private ioParts(): { console?: HierNode; switches?: HierNode } {
    const sim = this.es.sim;
    if (!sim) return {};
    if (this.io?.sim !== sim) {
      const nodes = ioNodes(sim.design.root);
      this.io = { sim, console: nodes.find((n) => n.info.kind === 'console')?.node, switches: nodes.find((n) => n.info.kind === 'switches')?.node };
    }
    return this.io;
  }

  /** Whether the chip shows a console, LEDs or switches the monitor follows (pins or parts). */
  get hasIo(): boolean {
    const doc = this.doc();
    if (pinNamed(doc, 'out', 1, 'consoleValid') || pinNamed(doc, 'in', 8, 'switches')) return true;
    const io = this.ioParts();
    return !!io.console || !!io.switches || this.leds !== null;
  }

  /** The switch bank part the ISS reads (null: none): the simulation's leaf, as ioparts.ts keeps it. */
  get switchBank(): HierNode | null {
    return pinNamed(this.doc(), 'in', 8, 'switches') ? null : this.ioParts().switches ?? null;
  }

  /** A console part's text into `console` when it has taken a character since the last look. */
  private readConsolePart(): boolean {
    const sim = this.es.sim, node = this.ioParts().console;
    if (!sim || !node || pinNamed(this.doc(), 'out', 1, 'consoleValid')) return false;
    const st = ioState(sim, node) as ConsoleState | undefined;
    if (st && st.n !== this.conN) {
      this.conN = st.n;
      this.console = consoleText(st);
    }
    return true;
  }

  private before(): void {
    const d = this.desc, iss = this.iss;
    this.willRetire = false;
    if (!d) return;
    const doc = this.doc();
    // The console takes a character on every edge with consoleValid (the IO unit's write strobe).
    if (pinValue(this.es, doc, 'consoleValid', 'out', 1) === 1) this.console += String.fromCharCode(Math.max(0, pinValue(this.es, doc, 'consoleData', 'out', 8) ?? 0) & 0xff);
    if (!iss || !this.synced) return;
    const r = d.retire && d.retire !== 'every' ? refValue(this.es, doc, d.retire) : 1;
    this.willRetire = r === 1;
    if (iss.io) {
      // The system CPU's inputs, sampled like the hardware samples them (or a switch bank part).
      const irq = iss.system ? pinValue(this.es, doc, 'irq', 'in', 1) : null;
      if (irq !== null) iss.irq = irq === 1;
      const bank = this.switchBank, sim = this.es.sim;
      const sw = bank && sim ? (ioState(sim, bank) as SwitchState | undefined)?.v ?? null : pinValue(this.es, doc, 'switches', 'in', 8);
      if (sw !== null) iss.switches = Math.max(0, sw);
    }
  }

  private after(): void {
    const iss = this.iss, d = this.desc;
    const conPart = !!d && this.readConsolePart();
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
    const doc = this.doc();
    const at = (what: string, name: string, expected: number, got: number, detail?: string) =>
      (this.mismatch = { what, name, expected: expected >>> 0, got, after: info.text, cycle: this.es.cycles, ...(detail ? { detail } : {}) });
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
    const fc = readFcsr(sim, d.fcsr);
    if (fc !== null && fc !== ((iss.frm << 5) | iss.fflags)) return void at('fcsr', 'fcsr', (iss.frm << 5) | iss.fflags, fc);
    if (!d.pipeline && d.pc) {
      const pc = refValue(this.es, doc, d.pc);
      if (pc !== null && pc !== iss.pc >>> 0) return void at('pc', 'PC', iss.pc, pc);
    }
    // (a store to I/O leaves the data memory alone: no need to read it)
    if (d.dmem && (d.pipeline ? iss.halted : info.store && !(iss.io && info.store.addr >= 0x80000000))) {
      const mem = readMem(sim, d.dmem);
      const m = mem && memDiff(mem, iss.dmem);
      if (m) return void at('mem', memName(m.i), m.model, m.hw);
    }
    if (iss.io) {
      let model = iss.console;
      if (conPart) {
        // compare what the console part shows with the model's text put through the same terminal
        if (iss.console.length !== this.issConLen) {
          for (let k = this.issConLen; k < iss.console.length; k++) consoleAppend(this.issCon, iss.console.charCodeAt(k));
          this.issConLen = iss.console.length;
        }
        model = consoleText(this.issCon);
      }
      const key = `${this.conN}|${this.console.length}|${iss.console.length}`;
      if (key !== this.compared && this.console !== model) {
        const i = [...this.console].findIndex((c, k) => c !== model[k]);
        const k = i < 0 ? this.console.length : i;
        return void at('console', 'console', model.charCodeAt(k) || 0, this.console.charCodeAt(k) || 0, `console: expected ${quote(model)}, got ${quote(this.console)}`);
      }
      this.compared = key;
      const leds = this.leds;
      if (leds !== null && leds !== iss.leds) return void at('leds', 'LEDs', iss.leds, leds);
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
  const core = m.hart !== undefined ? `core ${m.hart}: ` : '';
  if (m.detail) return `${core}${m.detail} (after “${m.after}”, cycle ${m.cycle})`;
  const what = m.what === 'pc' || m.what === m.name || m.what === 'mem' || m.what === 'leds' ? m.name : `${m.name} (${m.what})`;
  const fmt = m.what === 'leds' ? (v: number) => (v < 0 ? '????????' : `0b${v.toString(2).padStart(8, '0')}`) : fmtWord;
  return `${core}${what} after “${m.after}”, cycle ${m.cycle}: expected ${fmt(m.expected)}, got ${fmt(m.got)}`;
}

/** What the panel can show and what it cannot, in words (for a CPU being built). */
export function cpuGaps(d: CpuDesc, r: CpuRead | null): string[] {
  const out: string[] = [];
  if (!d.pc || r?.pc === null) out.push('no PC: set the net that holds the fetch address');
  if (!d.regs || !r?.x) out.push('no register file: registers cannot be shown or checked');
  if (d.dmem && !r?.dmem) out.push(`data memory '${d.dmem}' has no words to read`);
  return out;
}
