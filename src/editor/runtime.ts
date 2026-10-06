// The sandbox's live simulation. Every edit recompiles the chip (UserLibrary); this keeps one
// simulator running across those edits. An edit that only moves things leaves the connectivity
// key unchanged and the simulator untouched; any other edit rebuilds it (debounced, so a burst
// of edits costs one flatten) and carries the state over (Sim.carry), so a counter keeps its
// count and a latch its bit while the user adds parts around them.
//
// Two run modes: 'cycle' toggles the clock pins at a rate in Hz, each half period settled
// (a per-frame time budget keeps the page responsive and reports the rate achieved); 'gate'
// advances one gate delay per tick so propagation can be watched, toggling the clock only once
// the logic is quiet. advance() holds the stepping logic and needs no DOM; the rAF loop lives in
// start()/pause().

import { flatten } from '../sim/flatten';
import { GateSim } from '../sim/gatesim';
import type { PowerOnMode, Sim } from '../sim/sim';
import { SwitchSim } from '../sim/switchsim';
import { type Bit, BZ, type ComponentDef, netlistOf } from '../sim/types';
import { mask } from '../sim/values';
import { checkSimulatable, type Compiled, type Diag } from './compile';
import type { PinDoc } from './model';

export type RunMode = 'cycle' | 'gate';

/** Clock rates offered in cycle mode (Infinity: as fast as the frame budget allows). */
export const HZ_STEPS = [1, 2, 5, 10, 20, 50, 100, 1000, 10000, Infinity];

export interface EditorSimOptions {
  /** Delay before a structural edit rebuilds the simulator (ms). */
  debounceMs?: number;
  /** Gate delays per second in gate mode. */
  gateRate?: () => number;
  /** Per-frame time budget in cycle mode (ms). */
  budgetMs?: number;
}

const serials = new WeakMap<ComponentDef, number>();
let nextSerial = 1;
const serial = (d: ComponentDef) => serials.get(d) ?? (serials.set(d, nextSerial), nextSerial++);

/**
 * When the simulator must be rebuilt: the connectivity, the level, and the identity of every
 * part's definition (a user chip edited in another tab is a new def under the same ref).
 */
export function simKey(c: Compiled): string {
  const insts = netlistOf(c.def)?.instances ?? [];
  return `${c.connKey}|${c.mode}|${insts.map((i) => `${i.name}:${serial(i.def)}`).join(',')}`;
}

export class EditorSim {
  sim: Sim | null = null;
  /** The compile the simulator's net numbering belongs to (values are read through it). */
  built: Compiled | null = null;
  /** Why the chip cannot be simulated, when it cannot. */
  diags: Diag[] = [];
  mode: RunMode = 'cycle';
  running = false;
  hz = 10;
  powerOn: PowerOnMode = 'zero';
  /** Rising clock edges since the last reset. */
  cycles = 0;
  /** Power cycles so far: time restarts at 0 (a recording of the old time must start over). */
  resets = 0;
  /** Clock rate actually achieved over the last second (cycle mode, running). */
  achievedHz = 0;
  /** Called whenever values on screen may have changed. */
  onChange: () => void = () => {};

  private latest: Compiled | null = null;
  private pins: PinDoc[] = [];
  private key = '';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private raf = 0;
  private lastFrame = 0;
  private due = 0;
  private clkHigh = false;
  private samples: [number, number][] = [];
  private readonly debounceMs: number;
  private readonly gateRate: () => number;
  private readonly budgetMs: number;

  constructor(opts: EditorSimOptions = {}) {
    this.debounceMs = opts.debounceMs ?? 120;
    this.gateRate = opts.gateRate ?? (() => 12);
    this.budgetMs = opts.budgetMs ?? 8;
  }

  /** Take the latest compile of the chip (on every edit). */
  update(c: Compiled, pins: PinDoc[]): void {
    this.latest = c;
    this.pins = pins;
    const key = simKey(c);
    if (key === this.key) {
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
      this.built = c;
      return;
    }
    if (!this.sim && !this.timer && !this.key) return this.rebuild();
    if (this.timer) clearTimeout(this.timer);
    if (this.debounceMs <= 0) return this.rebuild();
    this.timer = setTimeout(() => this.rebuild(), this.debounceMs);
  }

  /** Rebuild now if one is pending (tests, and before stepping). */
  flush(): void {
    if (this.timer) this.rebuild();
  }

  /** True while a rebuild is pending: wires drawn since then have no value yet. */
  get pending(): boolean {
    return this.timer !== null;
  }

  private rebuild(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const c = this.latest;
    if (!c) return;
    const key = simKey(c);
    try {
      const d = flatten(c.def, { mode: c.mode });
      const sim: Sim = c.mode === 'gate' ? new GateSim(d) : new SwitchSim(d);
      // Unknown values do not carry (unless X is the power-on mode): storage that went X while
      // half wired (a clock not connected yet) starts from its power-on value once it is.
      // Inputs first: a power-on resolves races (an SR latch released 1/1) with them in place.
      this.applyPins(sim);
      if (this.sim) sim.carry(this.sim, { known: this.powerOn !== 'x' });
      else sim.reset(this.powerOn);
      this.applyPins(sim);
      sim.settle();
      this.sim = sim;
      this.diags = [];
    } catch (e) {
      const ds = checkSimulatable(c);
      this.diags = ds.length ? ds : [{ level: 'error', msg: `cannot simulate: ${e instanceof Error ? e.message : String(e)}` }];
      this.sim = null;
    }
    this.built = c;
    this.key = key;
    this.onChange();
  }

  /** Drive every input pin from its document value (clocks keep the level the run loop gave them). */
  private applyPins(sim: Sim): void {
    for (const p of this.pins) {
      if (p.dir === 'inout' && this.hasInput(sim, p)) drive(sim, p, p.value);
      if (p.dir !== 'in' || !this.hasInput(sim, p)) continue;
      if (p.kind === 'clock') sim.setInput(p.name, this.clkHigh ? 1 : 0);
      else if (p.kind === 'button') sim.setInput(p.name, 0);
      else sim.setInput(p.name, (p.value ?? 0) % (mask(p.width) + 1));
    }
  }

  /** Inputs, and (switch level only) bidirectional pins the user may drive. */
  private hasInput(sim: Sim, p: PinDoc): boolean {
    if (p.dir === 'inout' && !(sim instanceof SwitchSim)) return false;
    return p.dir !== 'out' && sim.design.root.def.ports.some((q) => q.name === p.name && q.dir === p.dir && q.width === p.width);
  }

  private clocks(): string[] {
    const sim = this.sim;
    return sim ? this.pins.filter((p) => p.dir === 'in' && p.kind === 'clock' && this.hasInput(sim, p)).map((p) => p.name) : [];
  }

  get hasClock(): boolean {
    return this.clocks().length > 0;
  }

  // ---- values ------------------------------------------------------------------------------

  netBits(i: number | undefined): Bit[] | null {
    if (i === undefined || i < 0 || !this.sim) return null;
    const nets = this.sim.design.root.nets?.[i];
    return nets ? this.sim.getBits(nets) : null;
  }
  wireBits(id: string): Bit[] | null {
    return this.netBits(this.built?.netOfWire.get(id));
  }
  /** `p:part.port` or `pin:id` (compile's endKey). */
  endBits(key: string): Bit[] | null {
    return this.netBits(this.built?.netOfEnd.get(key));
  }
  labelBits(id: string): Bit[] | null {
    return this.netBits(this.built?.netOfLabel.get(id));
  }
  pinBits(name: string): Bit[] | null {
    const nets = this.sim?.design.root.ports[name];
    return nets ? this.sim!.getBits(nets) : null;
  }
  /** Switch level: 1 conducting, 2 maybe (gate X), 0 off; undefined for anything else. */
  conducting(part: string): number | undefined {
    const sim = this.sim;
    if (!(sim instanceof SwitchSim)) return undefined;
    const li = sim.design.root.children?.get(part)?.leafIndex;
    if (li === undefined) return undefined;
    const k = sim.design.leaves[li].kind;
    return k === 'nmos' || k === 'pmos' ? sim.conducting[li] : undefined;
  }
  get unstable(): boolean {
    return !!this.sim?.unstable;
  }
  get time(): number {
    return this.sim?.time ?? 0;
  }

  // ---- driving -----------------------------------------------------------------------------

  /** Set an input pin. Gate mode lets the run loop (or Step) propagate it one delay at a time. */
  setInput(p: PinDoc, v: number): void {
    const sim = this.sim;
    if (!sim || !this.hasInput(sim, p)) return;
    sim.setInput(p.name, v % (mask(p.width) + 1));
    if (this.mode === 'cycle') sim.settle();
    this.onChange();
  }

  /** Drive a bidirectional pin from outside with a value, or release it (undefined: Z). */
  driveInout(p: PinDoc, v: number | undefined): void {
    const sim = this.sim;
    if (!sim || p.dir !== 'inout' || !this.hasInput(sim, p)) return;
    drive(sim, p, v);
    sim.settle();
    this.onChange();
  }

  /** A click on a clock pin: the next clock half period, by hand. */
  toggleClocks(): void {
    const sim = this.sim;
    const clks = this.clocks();
    if (!sim || !clks.length) return;
    this.clkHigh = !this.clkHigh;
    for (const c of clks) sim.setInput(c, this.clkHigh ? 1 : 0);
    if (this.clkHigh) this.cycles++;
    if (this.mode === 'cycle') sim.settle();
    this.onChange();
  }

  /** One full clock cycle: every clock pin high, settle, low, settle. */
  private cycle(sim: Sim, clks: string[]): void {
    for (const c of clks) sim.setInput(c, 1);
    sim.settle();
    for (const c of clks) sim.setInput(c, 0);
    sim.settle();
    this.clkHigh = false;
    this.cycles++;
  }

  /** One gate delay; when the logic is quiet, the next clock half period instead. */
  private gateTick(sim: Sim, clks: string[]): boolean {
    if (sim.busy()) {
      if (sim.kind === 'gate') sim.step();
      else sim.settle();
      return true;
    }
    if (!clks.length) return false;
    this.clkHigh = !this.clkHigh;
    for (const c of clks) sim.setInput(c, this.clkHigh ? 1 : 0);
    if (this.clkHigh) this.cycles++;
    return true;
  }

  /**
   * Advance by `dt` seconds of run time within `budgetMs` of work. Returns the number of steps
   * taken (cycles in cycle mode, ticks in gate mode).
   */
  advance(dt: number, budgetMs = this.budgetMs): number {
    this.flush();
    const sim = this.sim;
    if (!sim) return 0;
    const clks = this.clocks();
    const rate = this.mode === 'cycle' ? this.hz : this.gateRate();
    this.due = Math.min(this.due + dt * rate, Number.isFinite(rate) ? rate + 1 : Infinity);
    const t0 = now();
    let n = 0;
    while (this.due >= 1 || !Number.isFinite(this.due)) {
      if (this.mode === 'cycle') {
        if (!clks.length) { sim.settle(); this.due = 0; break; }
        this.cycle(sim, clks);
      } else if (!this.gateTick(sim, clks)) { this.due = 0; break; }
      n++;
      if (Number.isFinite(this.due)) this.due--;
      if (now() - t0 > budgetMs) break;
    }
    // Behind schedule: drop the backlog rather than spiral (the achieved rate shows it).
    if (!Number.isFinite(this.due) || this.due > 2) this.due = 0;
    return n;
  }

  /** Step: one cycle (cycle mode) or one gate delay (gate mode). */
  stepOnce(): void {
    this.flush();
    const sim = this.sim;
    if (!sim) return;
    const clks = this.clocks();
    if (this.mode === 'cycle') {
      if (clks.length) this.cycle(sim, clks);
      else sim.settle();
    } else this.gateTick(sim, clks);
    this.onChange();
  }

  /** Power-cycle with a power-on mode (zero / x / random), inputs kept. */
  reset(mode: PowerOnMode = this.powerOn): void {
    this.powerOn = mode;
    this.flush();
    const sim = this.sim;
    if (!sim) return;
    this.clkHigh = false;
    this.cycles = 0;
    this.resets++;
    this.due = 0;
    this.applyPins(sim);
    sim.reset(mode);
    sim.settle();
    this.onChange();
  }

  setMode(m: RunMode): void {
    this.mode = m;
    this.due = 0;
    // Leaving gate mode: finish whatever was propagating, so cycle mode starts settled.
    if (m === 'cycle' && this.sim) {
      if (this.clkHigh) for (const c of this.clocks()) this.sim.setInput(c, 0);
      this.clkHigh = false;
      this.sim.settle();
    }
    this.onChange();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastFrame = now();
    this.samples = [];
    const frame = () => {
      if (!this.running) return;
      const t = now();
      const dt = Math.min(0.25, (t - this.lastFrame) / 1000);
      this.lastFrame = t;
      this.advance(dt);
      this.samples.push([t, this.cycles]);
      while (this.samples.length > 2 && t - this.samples[0][0] > 1000) this.samples.shift();
      const [t0, c0] = this.samples[0];
      this.achievedHz = t > t0 ? ((this.cycles - c0) * 1000) / (t - t0) : 0;
      this.onChange();
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
    this.onChange();
  }

  pause(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.achievedHz = 0;
    this.onChange();
  }

  destroy(): void {
    this.running = false;
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.raf);
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

/** A root inout of a switch-level simulation: driven with a value, or left floating (Z). */
function drive(sim: Sim, p: PinDoc, v: number | undefined): void {
  if (!(sim instanceof SwitchSim)) return;
  if (v === undefined) sim.setInputBit(p.name, BZ);
  else sim.setInput(p.name, v % (mask(p.width) + 1));
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
