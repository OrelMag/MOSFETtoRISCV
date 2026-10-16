// Doom played on the fast interpreter (DOM-free; the sandbox's Doom drawer draws it).
//
// Running: advance(wallMs) runs the game toward wall-clock time at the nominal clock (game time is
// mtime / CLOCK_KHZ, so a slow machine plays slower, never differently), inside a compute budget per
// call. It runs in chunks of SAMPLE instructions; the PC after each chunk is one sample, so the time
// per function and the instruction mix are counted on every SAMPLE-th instruction, for free.
// Paused: step / stepN / toNextPixel / toFrameEnd, each undone by back(): a single step keeps a
// small journal (registers, CSRs, the one word it stores, the devices' small state), anything larger
// a whole snapshot (8 MiB of RAM copied: a few ms), at most MAX_SNAPSHOTS of them.

import { disasm } from '../riscv/isa';
import { K } from '../riscv/fastiss';
import { symbolAt, type DoomImage, type DoomSymbol } from './image';
import { CLOCK_KHZ, DoomDevices, FB_BASE, FastDoom } from './machine';

export const SAMPLE = 4096;
const RECENT = 64;
const MAX_HISTORY = 256, MAX_SNAPSHOTS = 6;

/** Instruction classes of the mix. */
export const CLASSES = ['ALU', 'load', 'store', 'branch', 'jump', 'mul / div', 'system'] as const;
export type InstrClass = (typeof CLASSES)[number];

function classOf(kind: number): number {
  if (kind >= K.LB && kind <= K.LHU) return 1;
  if (kind >= K.SB && kind <= K.SW) return 2;
  if (kind >= K.BEQ && kind <= K.BGEU) return 3;
  if (kind === K.JAL || kind === K.JALR) return 4;
  if (kind >= K.MUL && kind <= K.REMU) return 5;
  if (kind >= K.AMOADD) return 6;
  return 0;
}

const SCALARS = ['pc', 'mtime', 'steps', 'retired', 'halted', 'mie', 'mpie', 'mtie', 'meie', 'mtvec', 'mscratch', 'mepc', 'mcause', 'mtval', 'mtimecmp', 'leds', 'switches', 'irq'] as const;
type Scalars = Record<(typeof SCALARS)[number], number | boolean>;

interface Journal {
  kind: 'step';
  s: Scalars;
  x: Uint32Array;
  consoleLen: number;
  cycles: number;
  lastPixel: number;
  /** The word the instruction may store to (RAM index or frame-buffer address) and its old value. */
  ram?: [number, number];
  fb?: [number, number];
  keys?: number[];
  flips?: number;
  shown?: Uint8Array;
  shownPalette?: Uint32Array;
}

interface Snapshot {
  kind: 'snap';
  s: Scalars;
  x: Uint32Array;
  console: string;
  cycles: number;
  lastPixel: number;
  dmem: Uint32Array;
  fb: Uint8Array;
  keys: number[];
  flips: number;
  shown: Uint8Array;
  shownPalette: Uint32Array;
}

export interface ProfileRow {
  name: string;
  share: number;
}

export class DoomPlayer {
  readonly cpu: FastDoom;
  readonly dev: DoomDevices;
  paused = false;
  /** Cycles since power-on (mtime extended past 32 bits). */
  cycles = 0;
  private lastMt = 0;
  /** Game time the wall clock asks for, in cycles. */
  private target = 0;
  private readonly samplesFn = new Map<number, number>();
  private readonly samplesCls = new Float64Array(CLASSES.length);
  private samplesTotal = 0;
  /** The last full second's profile and mix (what the drawer shows). */
  profile: ProfileRow[] = [];
  mix: number[] = new Array(CLASSES.length).fill(0);
  private windowStart = 0;
  private windowInstr = 0;
  private windowWall = 0;
  private windowGame = 0;
  /** Instructions per second of compute, and game time per wall time, over the last window. */
  mips = 0;
  speed = 0;
  /** The last instructions run (PCs, oldest first): the tail of each advance, stepped one by one. */
  private readonly recentPcs = new Uint32Array(RECENT);
  private recentAt = 0;
  private recentN = 0;
  private readonly history: (Journal | Snapshot)[] = [];

  constructor(readonly image: DoomImage, wad: Uint8Array, readonly syms: readonly DoomSymbol[]) {
    this.dev = new DoomDevices(wad);
    this.cpu = new FastDoom(image, this.dev);
  }

  /** Bring `cycles` up to date with mtime. */
  private tick(): void {
    this.cycles += (this.cpu.mtime - this.lastMt) >>> 0;
    this.lastMt = this.cpu.mtime;
  }

  private sample(): void {
    const cpu = this.cpu, i = (cpu.pc >>> 2) & (cpu.imemWords - 1);
    this.samplesCls[classOf(cpu.kind[i])]++;
    const s = symbolAt(this.syms, cpu.pc);
    const key = s ? s[0] : -1;
    this.samplesFn.set(key, (this.samplesFn.get(key) ?? 0) + 1);
    this.samplesTotal++;
  }

  private remember(pc: number): void {
    this.recentPcs[this.recentAt] = pc;
    this.recentAt = (this.recentAt + 1) % RECENT;
    this.recentN = Math.min(RECENT, this.recentN + 1);
  }

  /**
   * Run toward wall-clock time: `wallMs` since the last call (capped, so a hidden tab does not
   * come back to minutes of catching up), for at most `budgetMs` of compute. Returns the
   * instructions run.
   */
  advance(wallMs: number, budgetMs: number, now = performance.now()): number {
    if (this.paused || this.cpu.halted) return 0;
    const t0 = performance.now(), cpu = this.cpu, r0 = cpu.retired, g0 = this.cycles;
    this.target = Math.max(this.target, this.cycles) + Math.min(wallMs, 100) * CLOCK_KHZ;
    while (this.cycles < this.target && !cpu.halted) {
      cpu.run(SAMPLE);
      this.tick();
      this.sample();
      if (performance.now() - t0 > budgetMs) break;
    }
    // behind: let at most one frame's worth of debt carry over
    this.target = Math.min(this.target, this.cycles + 50 * CLOCK_KHZ);
    for (let k = 0; k < RECENT && !cpu.halted; k++) { this.remember(cpu.pc); cpu.run(1); }
    this.tick();
    const ran = cpu.retired - r0;
    this.windowInstr += ran;
    this.windowWall += wallMs;
    this.windowGame += (this.cycles - g0) / CLOCK_KHZ;
    this.windowCompute += performance.now() - t0;
    if (now - this.windowStart >= 1000) this.closeWindow(now);
    return ran;
  }

  private windowCompute = 0;

  private closeWindow(now: number): void {
    const total = this.samplesTotal || 1;
    const rows = [...this.samplesFn].map(([addr, n]) => ({ name: addr < 0 ? '(no symbol)' : this.syms.find((s) => s[0] === addr)?.[2] ?? '?', share: n / total }));
    rows.sort((a, b) => b.share - a.share);
    this.profile = rows;
    this.mix = [...this.samplesCls].map((n) => n / total);
    this.mips = this.windowCompute > 0 ? this.windowInstr / this.windowCompute / 1000 : 0;
    this.speed = this.windowWall > 0 ? this.windowGame / this.windowWall : 0;
    this.samplesFn.clear(); this.samplesCls.fill(0); this.samplesTotal = 0;
    this.windowInstr = this.windowWall = this.windowGame = this.windowCompute = 0;
    this.windowStart = now;
  }

  /** The last instructions, oldest first. */
  recent(): number[] {
    const out: number[] = [];
    for (let k = 0; k < this.recentN; k++) out.push(this.recentPcs[(this.recentAt - this.recentN + k + RECENT) % RECENT]);
    return out;
  }

  /** The function at pc and the offset into it. */
  where(pc = this.cpu.pc): { name: string; offset: number } | null {
    const s = symbolAt(this.syms, pc);
    return s ? { name: s[2], offset: pc - s[0] } : null;
  }

  /** Disassembly of the words around pc: [address, word, text]. */
  listing(pc = this.cpu.pc, before = 5, after = 6): [number, number, string][] {
    const out: [number, number, string][] = [];
    for (let a = pc - 4 * before; a <= pc + 4 * after; a += 4) {
      if (a < 0 || a >>> 2 >= this.image.text.length) continue;
      const w = this.cpu.fetch(a);
      out.push([a, w, disasm(w, a)]);
    }
    return out;
  }

  // ---- paused: stepping and Back ----

  private scalars(): Scalars {
    const c = this.cpu as unknown as Record<string, number | boolean>, s = {} as Scalars;
    for (const k of SCALARS) s[k] = c[k];
    return s;
  }

  private putScalars(s: Scalars): void {
    const c = this.cpu as unknown as Record<string, number | boolean>;
    for (const k of SCALARS) c[k] = s[k];
    this.lastMt = this.cpu.mtime;
  }

  private push(e: Journal | Snapshot): void {
    this.history.push(e);
    if (this.history.length > MAX_HISTORY) this.history.shift();
    let snaps = 0;
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i].kind === 'snap' && ++snaps > MAX_SNAPSHOTS) { this.history.splice(0, i + 1); break; }
    }
  }

  private snapshot(): void {
    const d = this.dev;
    this.push({
      kind: 'snap', s: this.scalars(), x: this.cpu.x.slice(), console: this.cpu.console, cycles: this.cycles, lastPixel: d.lastPixel,
      dmem: this.cpu.dmem.slice(), fb: d.fb.slice(), keys: d.keys.slice(), flips: d.flips, shown: d.shown.slice(), shownPalette: d.shownPalette.slice(),
    });
  }

  /** One instruction, undoable. */
  step(): void {
    const cpu = this.cpu, d = this.dev, i = (cpu.pc >>> 2) & (cpu.imemWords - 1), k = cpu.kind[i];
    const j: Journal = { kind: 'step', s: this.scalars(), x: cpu.x.slice(), consoleLen: cpu.console.length, cycles: this.cycles, lastPixel: d.lastPixel };
    const isStore = (k >= K.SB && k <= K.SW) || k === K.AMOADD || k === K.AMOSWAP;
    const isLoad = k >= K.LB && k <= K.LHU;
    if (isStore || isLoad) {
      const base = k === K.AMOADD || k === K.AMOSWAP ? cpu.x[cpu.frs1[i]] : (cpu.x[cpu.frs1[i]] + cpu.fimm[i]) >>> 0;
      const addr = base >>> 0;
      if (isStore && addr < 0x80000000 && addr >>> 28 !== 1) { const w = (addr >>> 2) & (cpu.dmem.length - 1); j.ram = [w, cpu.dmem[w]]; }
      else if (isStore && addr >= FB_BASE) { const a = addr & ~3; j.fb = [a, d.readWord(a) ?? 0]; }
      else if (addr >= 0x80000000 && addr < FB_BASE) {
        j.keys = d.keys.slice(); j.flips = d.flips;
        if (isStore) { j.shown = d.shown.slice(); j.shownPalette = d.shownPalette.slice(); }
      }
    }
    cpu.run(1);
    this.tick();
    this.remember(j.s.pc as number);
    this.push(j);
  }

  /** Run a multi-instruction operation undoably: a snapshot first. */
  private bigStep(run: () => void): void {
    this.snapshot();
    run();
    this.tick();
  }

  stepN(n: number): void {
    if (n <= 16) { for (let k = 0; k < n && !this.cpu.halted; k++) this.step(); return; }
    this.bigStep(() => { for (let k = 0; k < n - RECENT && !this.cpu.halted;) k += this.cpu.run(Math.min(SAMPLE, n - RECENT - k)); for (let k = 0; k < RECENT; k++) { this.remember(this.cpu.pc); this.cpu.run(1); } });
  }

  /** Run until the next store into the picture (at most `limit` instructions). */
  toNextPixel(limit = 5_000_000): void {
    this.bigStep(() => this.runUntil('pixel', limit));
  }

  /** Run until the frame is complete (the next FLIP). */
  toFrameEnd(limit = 50_000_000): void {
    this.bigStep(() => this.runUntil('flip', limit));
  }

  private runUntil(what: 'pixel' | 'flip', limit: number): void {
    const cpu = this.cpu;
    if (what === 'pixel') cpu.yieldOnPixel = true; else cpu.yieldOnFlip = true;
    try {
      cpu.yieldNow = false;
      // run() returning early without a halt: the instruction that stopped it was the store / FLIP
      for (let n = 0; n < limit && !cpu.halted;) {
        const k = cpu.run(SAMPLE);
        n += k;
        if (k < SAMPLE && !cpu.halted) break;
      }
    } finally {
      cpu.yieldOnPixel = cpu.yieldOnFlip = false;
      cpu.yieldNow = false;
    }
  }

  /** Undo the last step or operation; false when there is nothing to undo. */
  back(): boolean {
    const e = this.history.pop();
    if (!e) return false;
    const cpu = this.cpu, d = this.dev;
    this.putScalars(e.s);
    cpu.x.set(e.x);
    this.cycles = e.cycles;
    if (e.kind === 'step') {
      cpu.console = cpu.console.slice(0, e.consoleLen);
      if (e.ram) cpu.dmem[e.ram[0]] = e.ram[1];
      if (e.fb) d.write(e.fb[0], 2, e.fb[1]);
      if (e.keys) { d.keys.splice(0, d.keys.length, ...e.keys); d.flips = e.flips!; }
      if (e.shown) { d.shown.set(e.shown); d.shownPalette.set(e.shownPalette!); }
    } else {
      cpu.console = e.console;
      cpu.dmem.set(e.dmem);
      d.fb.set(e.fb);
      d.keys.splice(0, d.keys.length, ...e.keys);
      d.flips = e.flips;
      d.shown.set(e.shown);
      d.shownPalette.set(e.shownPalette);
    }
    d.lastPixel = e.lastPixel; // after the frame-buffer write above, which moves it
    this.target = this.cycles;
    return true;
  }

  get canGoBack(): boolean {
    return this.history.length > 0;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    this.target = this.cycles;
    this.history.length = 0;
  }
}
