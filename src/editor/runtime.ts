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
//
// Halt parts (displays of kind 'halt', at any depth of the hierarchy) stop Run after the step on
// which their input reads non-zero, like Turing Complete's halt. The test is on levels, not edges:
// while a halt still reads 1, Run advances one step and stops again; Step ignores it.
//
// Key and keyboard parts (parts.ts, at any depth too) are external sources: leaves whose private
// state the editor sets (Sim.poke). A key is held or not (setKey; the held set survives rebuilds
// and resets, since the finger is still on the key). A keyboard queues typed codes (typeKey) and
// drops the oldest when its `ack` input reads 1, sampled like a clocked peripheral would: just
// before every rising clock edge, or, in a chip without a clock, whenever the logic has settled.
// Switch banks, consoles and screens (ioparts.ts) keep their state in their leaves too: pokeLeaf
// flips a switch; a reset puts the switches back where they were (the world outside).

import { DualSim } from '../sim/dualsim';
import { flatten } from '../sim/flatten';
import type { PowerOnMode, Sim } from '../sim/sim';
import { SwitchSim } from '../sim/switchsim';
import { B1, type Bit, BZ, type ComponentDef, netlistOf } from '../sim/types';
import { unpackBig } from '../sim/values';
import type { HierNode } from '../sim/flatten';
import { checkSimulatable, type Compiled, type Diag } from './compile';
import { pinBig, type PinDoc, type PinValue } from './model';
import { holdSwitches } from './ioparts';
import { HALT_PREFIX, KEYBOARD_DEPTH, KEYBOARD_ID, keyBindOf, type KeyboardState, type KeyState } from './parts';

export type RunMode = 'cycle' | 'gate';

/**
 * Observers of rising clock edges (like the chapters' stage.edgeHooks): `before` runs with the
 * clock still low and the logic settled, `after` once the edge has propagated (gate mode: when the
 * logic is quiet again). A CPU's golden model steps in `after`.
 */
export interface EdgeHook {
  before?(): void;
  after?(): void;
}

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
  /** Called when a halt part stops Run (after the pause). */
  onHalt: () => void = () => {};
  /** Rising-edge observers (every edge the run loop, Step, a click on a clock or runCycles makes). */
  readonly edgeHooks = new Set<EdgeHook>();

  private latest: Compiled | null = null;
  private pins: PinDoc[] = [];
  private key = '';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private raf = 0;
  private lastFrame = 0;
  private due = 0;
  private clkHigh = false;
  /** A rising edge whose `after` hooks have not run yet (gate mode: still propagating). */
  private edgeOpen = false;
  private samples: [number, number][] = [];
  /** Flat nets of every halt part's input in the current simulation. */
  private haltNets: number[] = [];
  /** advance() stopped on a halt: the run loop pauses. */
  private haltHit = false;
  /** Key parts of the current simulation (leaf index, the key each listens to) and keyboard parts (leaf indices). */
  private keyLeaves: { li: number; bind: string }[] = [];
  private kbdLeaves: number[] = [];
  /** Keys held now (as normalizeKey names them): applied again after a rebuild or a reset. */
  private held = new Set<string>();
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
      // gate level: GateSim, and the cycle engine while running in cycle mode (DualSim switches)
      const sim: Sim = c.mode === 'gate' ? new DualSim(d) : new SwitchSim(d);
      if (sim instanceof DualSim) sim.preferFast = this.mode === 'cycle';
      // Unknown values do not carry (unless X is the power-on mode): storage that went X while
      // half wired (a clock not connected yet) starts from its power-on value once it is.
      // Inputs first: a power-on resolves races (an SR latch released 1/1) with them in place.
      this.applyPins(sim);
      if (this.sim) sim.carry(this.sim, { known: this.powerOn !== 'x' });
      else sim.reset(this.powerOn);
      this.applyPins(sim);
      this.scanSources(sim);
      this.applyKeys(sim);
      this.quiet(sim);
      this.sim = sim;
      this.haltNets = haltNets(sim.design.root);
      this.diags = [];
    } catch (e) {
      const ds = checkSimulatable(c);
      this.diags = ds.length ? ds : [{ level: 'error', msg: `cannot simulate: ${e instanceof Error ? e.message : String(e)}` }];
      this.sim = null;
      this.haltNets = [];
      this.keyLeaves = [];
      this.kbdLeaves = [];
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
      else sim.setInputBits(p.name, pinBits(p.value, p.width));
    }
  }

  /** Inputs, and (switch level only) bidirectional pins the user may drive. */
  private hasInput(sim: Sim, p: PinDoc): boolean {
    if (p.dir === 'inout' && !(sim instanceof SwitchSim)) return false;
    return p.dir !== 'out' && sim.design.root.def.ports.some((q) => q.name === p.name && q.dir === p.dir && q.width === p.width);
  }

  private clocks(): string[] {
    return this.sim ? this.clocksOf(this.sim) : [];
  }

  private clocksOf(sim: Sim): string[] {
    return this.pins.filter((p) => p.dir === 'in' && p.kind === 'clock' && this.hasInput(sim, p)).map((p) => p.name);
  }

  // ---- external sources: keys and keyboards ------------------------------------------------

  /** Find the key and keyboard leaves of a (new) simulation, at any depth. */
  private scanSources(sim: Sim): void {
    this.keyLeaves = [];
    this.kbdLeaves = [];
    sim.design.leaves.forEach((l, li) => {
      if (l.def.id === KEYBOARD_ID) this.kbdLeaves.push(li);
      else {
        const bind = keyBindOf(l.def);
        if (bind !== null) this.keyLeaves.push({ li, bind });
      }
    });
  }

  /** Every key part reads whether its key is held (after a rebuild or a reset: the finger is still there). */
  private applyKeys(sim: Sim): void {
    for (const k of this.keyLeaves) sim.poke(k.li, { v: this.held.has(k.bind) ? 1 : 0 } satisfies KeyState);
  }

  /**
   * Settle, and in a chip without a clock let the keyboards see `ack` (with a clock they look at
   * each rising edge instead, in rise()).
   */
  private quiet(sim: Sim): void {
    sim.settle();
    if (this.kbdLeaves.length && !this.clocksOf(sim).length && this.serviceKeyboards(sim)) sim.settle();
  }

  /** Every keyboard whose `ack` reads 1 drops its oldest key. Returns whether any did. */
  private serviceKeyboards(sim: Sim): boolean {
    let popped = false;
    for (const li of this.kbdLeaves) {
      const q = queueOf(sim, li);
      if (q.length && sim.getBits(sim.design.leaves[li].inputs[0])[0] === B1) {
        sim.poke(li, { q: q.slice(1) } satisfies KeyboardState);
        popped = true;
      }
    }
    return popped;
  }

  /** An external input changed: in cycle mode it takes effect now, in gate mode the run loop (or Step) propagates it. */
  private afterInput(sim: Sim): void {
    if (this.mode === 'cycle') this.quiet(sim);
    this.onChange();
  }

  /** The keys the chip's key parts listen to (at any depth), each once. */
  get keyBinds(): string[] {
    return [...new Set(this.keyLeaves.map((k) => k.bind))];
  }

  /** Does the chip contain a keyboard part (in it or in any chip it places)? */
  get hasKeyboard(): boolean {
    return this.kbdLeaves.length > 0;
  }

  /** The key `bind` went down or up: every key part listening to it follows. Returns whether any does. */
  setKey(bind: string, down: boolean): boolean {
    if (down) this.held.add(bind);
    else this.held.delete(bind);
    const hits = this.keyLeaves.filter((k) => k.bind === bind);
    const sim = this.sim;
    if (!sim || !hits.length) return hits.length > 0;
    for (const k of hits) sim.poke(k.li, { v: down ? 1 : 0 } satisfies KeyState);
    this.afterInput(sim);
    return true;
  }

  /** Every held key let go (the window lost focus). */
  releaseKeys(): void {
    for (const b of [...this.held]) this.setKey(b, false);
  }

  /** A key typed into every keyboard part (its code: parts.ts keyCode). A full keyboard drops it. */
  typeKey(code: number): void {
    const sim = this.sim;
    if (!sim || !this.kbdLeaves.length) return;
    for (const li of this.kbdLeaves) {
      const q = queueOf(sim, li);
      if (q.length < KEYBOARD_DEPTH) sim.poke(li, { q: [...q, code] } satisfies KeyboardState);
    }
    this.afterInput(sim);
  }

  /** Every keyboard part forgets its waiting keys. */
  clearKeyboards(): void {
    const sim = this.sim;
    if (!sim || !this.kbdLeaves.length) return;
    for (const li of this.kbdLeaves) sim.poke(li, { q: [] } satisfies KeyboardState);
    this.afterInput(sim);
  }

  /**
   * Set the private state of an external source's leaf from outside (a switch flipped, a console
   * or screen cleared): it takes effect like an input change.
   */
  pokeLeaf(li: number, state: unknown): void {
    const sim = this.sim;
    if (!sim || li < 0 || li >= sim.design.leaves.length) return;
    sim.poke(li, state);
    this.afterInput(sim);
  }

  /** The keys waiting in a keyboard part placed in this chip (by part id), oldest first; null for any other part. */
  keyboardQueue(part: string): number[] | null {
    const sim = this.sim;
    if (!sim) return null;
    const li = this.kbdLeaves.find((i) => { const p = sim.design.leaves[i].node.path; return p.length === 1 && p[0] === part; });
    return li === undefined ? null : queueOf(sim, li);
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
  /** Does the chip contain a halt part (in it or in any chip it places)? */
  get hasHalt(): boolean {
    return this.haltNets.length > 0;
  }
  /** Some halt part's input reads 1 on at least one bit (X and Z do not halt). */
  get halted(): boolean {
    const sim = this.sim;
    return !!sim && this.haltNets.length > 0 && sim.getBits(this.haltNets).includes(B1);
  }
  get unstable(): boolean {
    return !!this.sim?.unstable;
  }
  get time(): number {
    return this.sim?.time ?? 0;
  }
  /**
   * The engine simulating now: 'gate' (event-driven, the time counts gate delays), 'cycle' (the
   * cycle engine: settled values only, the time stands still) or 'switch' (transistors).
   */
  get engine(): 'gate' | 'cycle' | 'switch' | null {
    const sim = this.sim;
    if (!sim) return null;
    return sim instanceof DualSim ? sim.engine : sim.kind;
  }

  // ---- driving -----------------------------------------------------------------------------

  /**
   * Something else drove the simulation (the test player): repaint. `restarted`: its time went
   * back (a restored state, a reset), so recordings over it start over (`resets` is bumped).
   */
  notify(restarted = false): void {
    if (restarted) this.resets++;
    this.onChange();
  }

  /** Put the document's input values back on the simulation (after the test player drove it). */
  reapply(): void {
    const sim = this.sim;
    if (!sim) return;
    this.applyPins(sim);
    this.applyKeys(sim);
    this.quiet(sim);
    this.onChange();
  }

  /** Set an input pin. Gate mode lets the run loop (or Step) propagate it one delay at a time. */
  setInput(p: PinDoc, v: PinValue): void {
    const sim = this.sim;
    if (!sim || !this.hasInput(sim, p)) return;
    sim.setInputBits(p.name, pinBits(v, p.width));
    this.afterInput(sim);
  }

  /** Drive a bidirectional pin from outside with a value, or release it (undefined: Z). */
  driveInout(p: PinDoc, v: PinValue | undefined): void {
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
    if (this.clkHigh) {
      this.clkHigh = false;
      for (const c of clks) sim.setInput(c, 0);
    } else this.rise(sim, clks);
    if (this.mode === 'cycle') {
      sim.settle();
      this.endEdge();
    }
    this.onChange();
  }

  /** True while a rising edge propagates in gate mode (its `after` hooks have not run). */
  get inEdge(): boolean {
    return this.edgeOpen;
  }

  /** Clock pins high, with the edge hooks' `before` first. */
  private rise(sim: Sim, clks: string[]): void {
    this.endEdge();
    for (const hk of this.edgeHooks) hk.before?.();
    // a keyboard samples `ack` at the edge, like a register its D: the next key shows after it
    if (this.kbdLeaves.length) this.serviceKeyboards(sim);
    this.clkHigh = true;
    for (const c of clks) sim.setInput(c, 1);
    this.cycles++;
    this.edgeOpen = true;
  }

  /** The edge has propagated: the hooks' `after`. */
  private endEdge(): void {
    if (!this.edgeOpen) return;
    this.edgeOpen = false;
    for (const hk of this.edgeHooks) hk.after?.();
  }

  /** One full clock cycle: every clock pin high, settle, low, settle. */
  private cycle(sim: Sim, clks: string[]): void {
    this.rise(sim, clks);
    sim.settle();
    this.endEdge();
    for (const c of clks) sim.setInput(c, 0);
    sim.settle();
    this.clkHigh = false;
  }

  /**
   * Up to `n` full clock cycles at once (a CPU panel's Run to halt / Step instruction), stopping
   * early when `stop()` says so (checked before each cycle), when a halt part reads 1 after a
   * cycle, or after `budgetMs` of work. Whatever was propagating (gate mode) settles first.
   * Returns the cycles run.
   */
  runCycles(n: number, stop?: () => boolean, budgetMs = Infinity): number {
    this.flush();
    const sim = this.sim;
    const clks = this.clocks();
    if (!sim || !clks.length) return 0;
    sim.settle();
    this.endEdge();
    if (this.clkHigh) {
      for (const c of clks) sim.setInput(c, 0);
      sim.settle();
      this.clkHigh = false;
    }
    if (this.mode === 'cycle' && sim instanceof DualSim) sim.prepare();
    const t0 = now();
    let k = 0;
    while (k < n && !stop?.()) {
      this.cycle(sim, clks);
      k++;
      if (this.halted || now() - t0 > budgetMs) break;
    }
    this.onChange();
    return k;
  }

  /** One gate delay; when the logic is quiet, the next clock half period instead. */
  private gateTick(sim: Sim, clks: string[]): boolean {
    if (sim.busy()) {
      if (sim.kind === 'gate') sim.step();
      else sim.settle();
      return true;
    }
    this.endEdge();
    // no clock: quiet, unless a keyboard has a key to drop (its outputs then propagate, one delay at a time)
    if (!clks.length) return this.kbdLeaves.length > 0 && this.serviceKeyboards(sim);
    if (this.clkHigh) {
      this.clkHigh = false;
      for (const c of clks) sim.setInput(c, 0);
    } else this.rise(sim, clks);
    return true;
  }

  /**
   * Advance by `dt` seconds of run time within `budgetMs` of work. Returns the number of steps
   * taken (cycles in cycle mode, ticks in gate mode). Stops early, with `stoppedOnHalt` set, after
   * a step that leaves a halt part reading 1.
   */
  advance(dt: number, budgetMs = this.budgetMs): number {
    this.flush();
    const sim = this.sim;
    if (!sim) return 0;
    const clks = this.clocks();
    const rate = this.mode === 'cycle' ? this.hz : this.gateRate();
    this.due = Math.min(this.due + dt * rate, Number.isFinite(rate) ? rate + 1 : Infinity);
    // the cycle engine's one-time set-up is not part of a frame's work
    if (this.mode === 'cycle' && sim instanceof DualSim && clks.length) sim.prepare();
    const t0 = now();
    let n = 0;
    this.haltHit = false;
    while (this.due >= 1 || !Number.isFinite(this.due)) {
      if (this.mode === 'cycle') {
        if (!clks.length) { this.quiet(sim); this.due = 0; break; }
        this.cycle(sim, clks);
      } else if (!this.gateTick(sim, clks)) { this.due = 0; break; }
      n++;
      if (Number.isFinite(this.due)) this.due--;
      if (this.halted) { this.haltHit = true; this.due = 0; break; }
      if (now() - t0 > budgetMs) break;
    }
    // Behind schedule: drop the backlog rather than spiral (the achieved rate shows it).
    if (!Number.isFinite(this.due) || this.due > 2) this.due = 0;
    return n;
  }

  /** The last advance() stopped on a halt (cleared by the next one). */
  get stoppedOnHalt(): boolean {
    return this.haltHit;
  }

  /** Step: one cycle (cycle mode) or one gate delay (gate mode). */
  stepOnce(): void {
    this.flush();
    const sim = this.sim;
    if (!sim) return;
    const clks = this.clocks();
    if (this.mode === 'cycle') {
      if (clks.length) this.cycle(sim, clks);
      else this.quiet(sim);
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
    this.edgeOpen = false;
    this.cycles = 0;
    this.resets++;
    this.due = 0;
    this.applyPins(sim);
    const switches = holdSwitches(sim);
    sim.reset(mode);
    // keys still held stay pressed and switches where they were; the keyboards' queues, consoles' text and screens' pictures went with the power
    this.applyKeys(sim);
    switches();
    this.quiet(sim);
    this.onChange();
  }

  setMode(m: RunMode): void {
    this.mode = m;
    this.due = 0;
    // gate mode steps one delay at a time: the event-driven engine (the cycle engine takes over again in cycle mode)
    if (this.sim instanceof DualSim) this.sim.preferFast = m === 'cycle';
    // Leaving gate mode: finish whatever was propagating, so cycle mode starts settled.
    if (m === 'cycle' && this.sim) {
      this.sim.settle();
      this.endEdge();
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
      if (this.haltHit) {
        this.pause();
        this.onHalt();
        return;
      }
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

/** The input nets of every halt part under `node` (any depth: a CPU chip may halt itself). */
function haltNets(node: HierNode, out: number[] = []): number[] {
  for (const c of node.children?.values() ?? []) {
    if (c.def.id.startsWith(HALT_PREFIX)) out.push(...c.ports.a);
    else haltNets(c, out);
  }
  return out;
}

/** The waiting keys of keyboard leaf `li` (the state the simulation holds, never mutated in place). */
function queueOf(sim: Sim, li: number): number[] {
  const s = sim.leafState(li) as KeyboardState | undefined;
  return s?.q ?? [];
}

/** A root inout of a switch-level simulation: driven with a value, or left floating (Z). */
function drive(sim: Sim, p: PinDoc, v: PinValue | undefined): void {
  if (!(sim instanceof SwitchSim)) return;
  if (v === undefined) sim.setInputBit(p.name, BZ);
  else sim.setInputBits(p.name, pinBits(v, p.width));
}

/** A pin value as the pin's bits: the low `w` bits, exact at any width. */
export const pinBits = (v: PinValue | undefined, w: number): Bit[] => unpackBig(pinBig(v), w);

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
