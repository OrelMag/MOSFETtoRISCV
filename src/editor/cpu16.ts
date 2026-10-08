// An RV16 computer in the sandbox, DOM-free: a chip with an RV16 program ROM (lang 'rv16') and a
// placed core (any part with the campaign's core pins: pc, rwe, rwa, rwd, dwe, daddr, dwdata), like
// the campaign's "A computer" level or its "debug this test" bench. The golden model (Iss16) is
// checked the way the campaign's core bench checks it: every register write the core reports on
// its write port, and every store, in order. That needs nothing inside the core to be named, and
// holds for single-cycle, multicycle and pipelined cores alike (their writes come in program order).

import { disasm16, REG_NAMES16 } from '../riscv/rv16/isa16';
import { Iss16, type Step16 } from '../riscv/rv16/iss16';
import { pack } from '../sim/values';
import type { Chips, Mismatch, MonitorSim, Retired } from './cpu';
import { partNode, refValue } from './cpu';
import { romImage, type RomRef } from './memory';
import type { ChipDoc, PartDoc } from './model';
import { isError, partDef } from './parts';

export interface Rv16Desc {
  /** The program ROM (a part of the chip). */
  rom: string;
  /** The core part. */
  core: string;
  /** The core has an irq input (traps and interrupts: the golden model runs the system part). */
  system: boolean;
  /** The data memory: a RAM part of 16-bit words (a sandbox RAM, or the library's), decoded on its low address bits. */
  ram?: { id: string; k: number; init?: number[] };
}

/** The pins that make a part a core (CORE_PORTS of lib/rv16/cpu.ts). */
const CORE_OUTS: [string, number][] = [['pc', 16], ['daddr', 16], ['dwdata', 16], ['dwe', 1], ['rwe', 1], ['rwa', 3], ['rwd', 16]];

type Rv16RomPart = PartDoc & { ref: { rom: RomRef } };
const isRv16Rom = (p: PartDoc): p is Rv16RomPart => 'rom' in p.ref && p.ref.rom.lang === 'rv16';

/** A part's ports (a user chip's pins, a library part's ports), or null. */
function portsOf(p: PartDoc, chips: Chips | undefined): { name: string; dir: string; width: number }[] | null {
  if ('chip' in p.ref) return chips?.[p.ref.chip]?.pins ?? null;
  if (!('lib' in p.ref)) return null;
  const d = partDef(p.ref, () => undefined);
  return isError(d) ? null : d.ports;
}

const isCore = (ports: { name: string; dir: string; width: number }[]) =>
  CORE_OUTS.every(([n, w]) => ports.some((q) => q.name === n && q.dir === 'out' && q.width === w));

/** An RV16 ROM and one placed core (the first by id when there are several), or null. */
export function detectRv16(doc: ChipDoc, chips?: Chips): Rv16Desc | null {
  const roms = doc.parts.filter(isRv16Rom);
  if (!roms.length) return null;
  const rom = roms.find((p) => p.id === 'imem' || p.id === 'rom') ?? roms[0];
  for (const p of [...doc.parts].sort((a, b) => a.id.localeCompare(b.id))) {
    if (p === rom) continue;
    const ports = portsOf(p, chips);
    if (ports && isCore(ports)) {
      const rams = doc.parts.flatMap((q) => {
        if ('ram' in q.ref && q.ref.ram.w === 16) return [{ id: q.id, k: q.ref.ram.k, ...(q.ref.ram.init ? { init: q.ref.ram.init } : {}) }];
        const m = 'lib' in q.ref ? /^ram(\d+)x16$/.exec(q.ref.lib) : null;
        return m ? [{ id: q.id, k: Math.round(Math.log2(Number(m[1]))) }] : [];
      });
      return { rom: rom.id, core: p.id, system: ports.some((q) => q.name === 'irq' && q.dir === 'in'), ...(rams.length === 1 ? { ram: rams[0] } : {}) };
    }
  }
  return null;
}

/** The program an RV16 ROM part holds, padded to the ROM's size (it wraps like the hardware). */
export function rv16Program(doc: ChipDoc, rom: string): { words: number[]; k: number } | null {
  const p = doc.parts.find((q) => q.id === rom);
  if (!p || !isRv16Rom(p)) return null;
  const img = romImage(p.ref.rom);
  if (img.error) return null;
  const words = Array.from({ length: 2 ** p.ref.rom.k }, (_, i) => img.words[i] ?? 0);
  return { words, k: p.ref.rom.k };
}

/** A write the model made: n orders register writes and stores (the model's step count). */
interface Expect { n: number; pc: number; instr: number; rd?: number; addr?: number; value: number }

const hex4 = (v: number) => `0x${(v & 0xffff).toString(16).padStart(4, '0')}`;
const regName = (r: number) => `${REG_NAMES16[r]} (x${r})`;

/** The golden model in lock-step with an RV16 computer (the CpuMonitor of the campaign's cores). */
export class Rv16Monitor {
  iss: Iss16 | null = null;
  desc: Rv16Desc | null = null;
  mismatch: Mismatch | null = null;
  synced = false;
  /** Register writes and stores the hardware made that matched the model. */
  retired = 0;
  readonly log: Retired[] = [];
  seq = 0;
  problem: string | null = null;
  prog: { words: number[]; k: number } | null = null;
  /** The registers as the hardware's write port set them (x0 = 0). */
  readonly hw = new Uint16Array(8);
  /** Which registers the last edge wrote (for highlighting). */
  lastWrite = -1;
  /** The cycle at which the model had halted with every write matched (-1: not yet). */
  private endAt = -1;
  private regQ: Expect[] = [];
  private storeQ: Expect[] = [];
  private progKey = '';
  private lastDoc: ChipDoc | null = null;
  private lastChips: Chips | undefined;
  private resets = -1;
  private sample: Record<string, number | null> = {};
  private hook = { before: () => this.before(), after: () => this.after() };
  private static readonly LOG = 64;
  /** Instructions the model may run without a register write or a store (a halt loop ends earlier). */
  private static readonly QUIET = 4096;
  /** Cycles to keep watching after the end, for writes past it (the core bench's drain). */
  static readonly DRAIN = 8;

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
    this.desc = detectRv16(doc, chips);
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
    this.mismatch = null;
    this.retired = 0;
    this.log.length = 0;
    this.hw.fill(0);
    this.lastWrite = -1;
    this.regQ = [];
    this.storeQ = [];
    this.endAt = -1;
    this.seq++;
    this.synced = this.es.cycles === 0;
    const d = this.desc;
    this.problem = !d ? 'no RV16 ROM and core' : !this.prog ? `the program in ROM '${d.rom}' does not build` : null;
    // A RAM decoded on its low bits: the model's memory wraps the same way and starts with its contents.
    const data = new Map((d?.ram?.init ?? []).map((v, i) => [i, v] as [number, number]));
    this.iss = d && this.prog ? new Iss16(this.prog.words, { m: true, system: d.system, ...(d.ram ? { dmemWords: 2 ** d.ram.k, wrap: true } : {}) }, data) : null;
    this.fill(this.regQ);
  }

  get checking(): boolean {
    return !!this.iss && this.synced;
  }

  /** The hardware made every write the model made before halting, and nothing more for DRAIN cycles; or they differ. */
  get done(): boolean {
    return !!this.mismatch || (this.endAt >= 0 && this.es.cycles - this.endAt >= Rv16Monitor.DRAIN);
  }

  /** What the core should write next ("a0 ← 0x0003 from “jal ra, 0xa”"), or null: nothing pending. */
  get next(): string | null {
    if (!this.iss || !this.synced || this.mismatch) return null;
    const r = this.regQ[0], st = this.storeQ[0];
    const e = r && st ? (r.n <= st.n ? r : st) : r ?? st;
    if (!e) return null;
    const what = e.rd !== undefined ? `${REG_NAMES16[e.rd]} ← ${hex4(e.value)}` : `[${hex4(e.addr!)}] ← ${hex4(e.value)}`;
    return `${what} from “${disasm16(e.instr, e.pc)}” @ ${hex4(e.pc)}`;
  }

  /** A port of the core, read through the hierarchy (its outputs need not be wired to anything). */
  private port(name: string): number | null {
    const d = this.desc, sim = this.es.sim;
    const nets = d && sim ? partNode(sim, d.core)?.ports[name] : undefined;
    return nets && sim ? pack(sim.getBits(nets)) : null;
  }

  /** The core's PC (word address; -1: X, null: none). */
  get pc(): number | null {
    return this.port('pc');
  }

  /** The LEDs: a 16-bit `leds` pin of the chip, if any. */
  get leds(): number | null {
    const pin = this.doc().pins.find((p) => p.name === 'leds' && p.dir === 'out');
    return pin ? refValue(this.es, this.doc(), { pin: pin.id }) : null;
  }

  /** Step the model until the queue `q` has an event (or it halts, or stays quiet too long). */
  private fill(q: Expect[]): void {
    const iss = this.iss;
    for (let n = 0; iss && !q.length && !iss.halted && n < Rv16Monitor.QUIET; n++) this.push(iss.step());
  }

  private push(s: Step16): void {
    const n = this.iss!.steps;
    if (s.reg) this.regQ.push({ n, pc: s.pc, instr: s.instr, rd: s.reg.rd, value: s.reg.value });
    if (s.store) this.storeQ.push({ n, pc: s.pc, instr: s.instr, addr: s.store.addr, value: s.store.value });
  }

  private before(): void {
    this.sample = {};
    if (!this.iss || !this.synced || this.mismatch) return;
    for (const p of ['rwe', 'rwa', 'rwd', 'dwe', 'daddr', 'dwdata']) this.sample[p] = this.port(p);
  }

  private after(): void {
    const s = this.sample;
    this.lastWrite = -1;
    if (!this.iss || !this.synced || this.mismatch || !('rwe' in s)) return;
    const cycle = this.es.cycles;
    const where = (e: Expect) => `“${disasm16(e.instr, e.pc)}” @ ${hex4(e.pc)}`;
    const fail = (what: string, name: string, e: Expect | undefined, got: number, detail: string) =>
      (this.mismatch = { what, name, expected: e?.value ?? 0, got, after: e ? disasm16(e.instr, e.pc) : this.log.at(-1)?.text ?? 'the reset', cycle, detail });
    const done = (e: Expect, effect: string) => {
      this.retired++;
      this.seq++;
      this.log.push({ cycle, pc: e.pc, text: disasm16(e.instr, e.pc), effect });
      if (this.log.length > Rv16Monitor.LOG) this.log.shift();
    };
    if (s.rwe === null || s.dwe === null || s.rwe < 0 || s.dwe < 0) return void fail('rwe', 'write enable', undefined, -1, 'rwe or dwe is X (unknown): the bench cannot tell whether the core writes');
    if (s.rwe === 1 && s.rwa !== 0) {
      this.fill(this.regQ);
      const e = this.regQ.shift();
      const rwa = s.rwa ?? -1, rwd = s.rwd ?? -1;
      if (!e) return void fail(`x${rwa}`, 'register write', e, rwd, `an extra register write ${rwa < 0 ? 'x?' : regName(rwa)} ← ${rwd < 0 ? 'X' : hex4(rwd)}: the program has ended`);
      if (rwa !== e.rd || rwd !== e.value) {
        return void fail(`x${e.rd}`, regName(e.rd!), e, rwd, `register write ${rwa < 0 ? 'x?' : regName(rwa)} ← ${rwd < 0 ? 'X' : hex4(rwd)}; expected ${regName(e.rd!)} ← ${hex4(e.value)} from ${where(e)}`);
      }
      this.hw[rwa] = rwd;
      this.lastWrite = rwa;
      done(e, `${REG_NAMES16[rwa]} ← ${hex4(rwd)}`);
    }
    if (s.dwe === 1) {
      this.fill(this.storeQ);
      const e = this.storeQ.shift();
      const a = s.daddr ?? -1, v = s.dwdata ?? -1;
      if (!e) return void fail('mem', 'store', e, v, `an extra store [${a < 0 ? 'X' : hex4(a)}] ← ${v < 0 ? 'X' : hex4(v)}: the program has ended`);
      if (a !== e.addr || v !== e.value) {
        return void fail('mem', `memory [${hex4(e.addr!)}]`, e, v, `store [${a < 0 ? 'X' : hex4(a)}] ← ${v < 0 ? 'X' : hex4(v)}; expected [${hex4(e.addr!)}] ← ${hex4(e.value)} from ${where(e)}`);
      }
      done(e, `[${hex4(a)}] ← ${hex4(v)}`);
    }
    // Run the model on to its next write: it may halt (then nothing more is expected).
    if (!this.regQ.length && !this.storeQ.length) this.fill(this.regQ);
    if (this.endAt < 0 && this.iss.halted && !this.regQ.length && !this.storeQ.length) this.endAt = cycle;
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
