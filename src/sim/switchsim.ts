// Switch-level solver for transistor schematics. A MOSFET is modelled as a switch:
// NMOS conducts when its gate is 1, PMOS when its gate is 0. Each node takes the value of
// the rail(s) it is connected to through conducting transistors:
//   VDD only → 1, GND only → 0, both → X (a short: current flows from VDD to GND),
//   neither → Z (floating). A gate driven by X/Z "maybe" conducts, which yields X.
// Nodes feed the gates of other transistors, so we iterate to a fixed point.
//
// Strengths (ratioed logic): a path is as strong as its weakest element (rails and inputs are
// strongest). A node takes the value of its strongest definite path, unless an equally strong or
// stronger path to the opposite value exists or might exist (then X). This is what lets a bit-line
// driver overpower an SRAM cell's weak pull-up. Levels, strongest first:
//   7        rails and driven inputs
//   6, 5, 4  transistors of strength 4 (wide), 3 (default), 2 (narrow)
//   3        resistors (strength 1): always conducting, weaker than any transistor
//   2        bias resistors (strength 0): a divider's leg to a bias rail, overridden by any resistor
//   1        stored charge: nets marked `cap` (or with a capacitor) keep their value when undriven
// So a node reached only through a pull-up resistor is 1, any conducting transistor path to GND
// overrides it (pseudo-NMOS, open-drain buses), and two resistors pulling opposite ways give X.
// A short (`shorted`) is a fight between transistor paths; a resistor that loses draws current
// by design (that static current is the cost of ratioed logic) and is not flagged.
// Weak levels (`weakOf`): an NMOS passes a 1 only up to VDD − Vt, a PMOS a 0 only down to Vt. A driven 1 that no sure
// path brings from a 1 source without an NMOS is H, a 0 no path brings without a PMOS is L (resistors, relays, tubes
// and sense amplifiers pass both whole). The bit stands: a CMOS gate reading H reads 1, its output comes from its rails
// (restored), and its PMOS is partly on (`leaky`: static current). A 1 that only an NMOS gated by H brings is X (0.8 V
// at the gate passes 0.5 V), likewise a 0 only a PMOS gated by L brings. Stored-charge nets keep their charge's level.
// Iteration starts from the previous solution, so storage loops (cross-coupled inverters)
// remember their state; for loop-free circuits the result is unique anyway.
//
// Sources are ideal: rails and driven inputs are terminals, never internal conducting nodes. A
// path ends at a source; it never runs through one from a transistor to another. So one VDD (or
// GND, or input) net shared by many transistors behaves exactly like one rail symbol per
// transistor (a 6T cell with a single VDD writes from X just like the library cell). An input
// driven Z is not a source: it floats, and the circuit may drive it. Root `inout` ports are
// inputs that start undriven (Z) until setInput / setInputBit drives them.
//
// Charge levels (DRAM). Stored charge is a level, a fraction of VDD, kept per net (`level`). Where
// floating charge nets meet through conducting switches, with no stronger path, they share their
// charge: every net of the group takes Σ C·V / Σ C (C from NetDef.cap, 1 for `true`). A level reads
// as a bit only near a rail (≥ HI: 1, ≤ LO: 0, between: X), so gates see X on a half-charged bit
// line. A VDD/2 rail (prim 'vhalf') is a source of level ½ (X as a bit; with a 0 or a 1 at the same
// strength it is an X fight). The sense amplifier (prim 'sense', terminals en, a, b) is the one part
// that reads levels: when en rises it compares a with b, latches X if they differ by less than its
// offset, else drives the higher line to 1 and the other to 0 with transistor strength (so a
// stronger write driver flips it, and it follows). leak(cycles) drains nets with NetDef.leak.
//
// Floating gates (flash). prim 'fgmos' (terminals g, d, s, vp, pgm, ers) is an NMOS whose threshold is
// charge stored on an insulated gate (`fgCharge`, 0 erased … 1). At the read voltage (g = 1) it
// conducts only while the charge is below FG_READ; at the pass voltage (vp = 1) it always conducts
// (NAND strings). A rising pgm with g = 1 and the drain at 0 adds FG_STEP of charge (one program
// pulse: programming is program, verify, repeat); a rising ers removes it all (erase).
//
// Relays (prologue P1). prim 'relay' (terminals: the coil's ends a, b, then per pole c, no, nc) is a coil and
// changeover contacts. The coil is a resistor between its ends (strength 1), so a line that only a coil reaches is
// pulled to 0 through it: relay logic's "an open line is 0". Its contacts are switches at the strongest transistor
// strength (metal on metal), conducting both ways, driven not by a net but by the armature: no–c closes while it
// is operated, nc–c while it is released. The armature moves only at a relay step (one operate time, about 8 ms):
// every relay takes the state its coil had (current flowing: its ends at different values) at once, then the
// contacts are solved again. So a carry running through contacts settles within a step, and a coil fed through its
// own break contact oscillates with a period of two steps. time counts relay steps; step() takes one, settle()
// takes them until no coil disagrees with its armature (an oscillator stops after RELAY_SETTLE_MAX and is unstable).
//
// Vacuum tubes (prologue P2). Current crosses a tube one way only, from plate (anode) to cathode, so a tube can pull
// its plate down or its cathode up but never passes a signal back: no transmission gate. prim 'diode' (terminals a, k)
// always conducts that way; prim 'triode' (g, p, k) only while its grid is 1. Each is two sources of its own, at the
// element's strength, re-derived every iteration from the far side: one on the anode carrying the cathode's 0, one on
// the cathode carrying the anode's 1, each as strong as the path behind that value (vLv, kept from the last solution
// so a cross-coupled pair of triodes keeps its bit). A far side at X makes it a maybe, as strong as the path that
// could bring that value (not the other one: a junction that might be pulled to 0 hard offers no strong 1). Tubes
// take no time of their own.

import { matchNets, sharedInputs } from './carry';
import { findNode, type FlatDesign } from './flatten';
import { cloneState } from './gatesim';
import type { PowerOnMode, Sim, SimState } from './sim';
import { B0, B1, BX, BZ, type Bit } from './types';
import { pack, unpack } from './values';

export class SwitchSim implements Sim {
  readonly kind = 'switch' as const;
  readonly design: FlatDesign;
  /** Relay steps taken (see the header); 0 for a design without relays. */
  time = 0;
  unstable = false;
  evaluations = 0;
  onTrace?: (net: number, value: Bit, time: number) => void;

  private val: Uint8Array;
  /**
   * Root input values: a number from setInput (negative: every bit −v, i.e. X or Z), bits from
   * setInputBits (wide values stay exact).
   */
  private inputs = new Map<string, number | Bit[]>();
  private inputNets = new Map<string, number[]>();
  private dirty = true;
  /**
   * Private state of the behavioural leaves (external sources: a key part in a transistor
   * circuit). Their outputs are sources, as strong as rails and driven inputs.
   */
  private state: unknown[];
  private readonly behaviors: number[];
  /** Per leaf: 1 if the transistor conducts (a resistor always does), 2 if it might (gate X/Z), 0 if off. */
  readonly conducting: Uint8Array;
  /** Nets that are part of a VDD–GND short in the last solution. */
  readonly shorted: Uint8Array;
  /** Per net: WEAK_H (a 1 an NMOS passed: VDD − Vt), WEAK_L (a 0 a PMOS passed: Vt) or 0 (full, or not a bit). */
  private weak: Uint8Array;
  /** Does the design have MOSFETs (else nothing can be weak)? */
  private readonly mosfets: boolean;
  /** Per net: its level as a fraction of VDD (NaN: unknown or floating), see the header. */
  private lv: Float64Array;
  /** Sense amplifier leaves, and what each has latched: −1 off, 0 / 1 (the value on a), BX. */
  private readonly senses: number[];
  private senseDec: Int8Array;
  /** Floating-gate leaves, their charge, and their pgm / ers values at the last settle (edges). */
  private readonly fgs: number[];
  private fgQ: Float64Array;
  private fgPrev: Uint8Array;
  /** Relay leaves, their index by leaf, and each one's armature: B0 released, B1 operated, BX unknown. */
  private readonly relays: number[];
  private readonly relayOf = new Map<number, number>();
  private relayOp: Uint8Array;
  /** Triode and diode leaves (one-way elements, see the header). */
  private readonly oneWays: number[];
  /** Per net and value (index 2·net + value): the level of the path that brings that value in the last solution, sure
   *  or possible (what a one-way element passes on). */
  private vLv: Uint8Array;

  constructor(design: FlatDesign) {
    this.design = design;
    this.val = new Uint8Array(design.netCount).fill(BZ);
    this.conducting = new Uint8Array(design.leaves.length);
    this.shorted = new Uint8Array(design.netCount);
    this.weak = new Uint8Array(design.netCount);
    this.mosfets = design.leaves.some((l) => l.kind === 'nmos' || l.kind === 'pmos' || l.kind === 'fgmos');
    this.lv = new Float64Array(design.netCount).fill(NaN);
    this.senses = design.leaves.flatMap((l, li) => (l.kind === 'sense' ? [li] : []));
    this.senseDec = new Int8Array(this.senses.length).fill(-1);
    this.fgs = design.leaves.flatMap((l, li) => (l.kind === 'fgmos' ? [li] : []));
    this.fgQ = new Float64Array(this.fgs.length);
    this.fgPrev = new Uint8Array(this.fgs.length);
    this.behaviors = design.leaves.flatMap((l, li) => (l.kind === 'behavior' ? [li] : []));
    this.relays = design.leaves.flatMap((l, li) => (l.kind === 'relay' ? [li] : []));
    this.relays.forEach((li, k) => this.relayOf.set(li, k));
    this.relayOp = new Uint8Array(this.relays.length).fill(B0);
    this.oneWays = design.leaves.flatMap((l, li) => (l.kind === 'triode' || l.kind === 'diode' ? [li] : []));
    this.vLv = new Uint8Array(2 * design.netCount);
    this.state = design.leaves.map((l) => l.def.behavior?.init?.());
    for (const p of design.root.def.ports) {
      if (p.dir === 'in') {
        this.inputNets.set(p.name, design.root.ports[p.name]);
        this.inputs.set(p.name, 0);
      } else if (p.dir === 'inout') {
        this.inputNets.set(p.name, design.root.ports[p.name]);
        this.inputs.set(p.name, -BZ);
      }
    }
    this.settle();
  }

  get(net: number): Bit {
    return this.val[net] as Bit;
  }
  /** Level of a net as a fraction of VDD: 1 / 0 for a driven bit, ½ from a VDD/2 rail, stored or shared charge; NaN unknown. */
  level(net: number): number {
    return this.lv[net];
  }
  /** Does the design hold charge levels (capacitive nets or a VDD/2 rail)? */
  get hasLevels(): boolean {
    return this.design.caps.size > 0 || this.design.leaves.some((l) => l.kind === 'vhalf');
  }
  /** Sense amplifier at a leaf: what it latched (−1 off, 0 / 1 the value it drives on a, BX unresolved). */
  senseState(leaf: number): number {
    const k = this.senses.indexOf(leaf);
    return k < 0 ? -1 : this.senseDec[k];
  }
  /** Charge on a floating-gate leaf's gate (0 erased … 1), or NaN if the leaf is not one. */
  fgCharge(leaf: number): number {
    const k = this.fgs.indexOf(leaf);
    return k < 0 ? NaN : this.fgQ[k];
  }
  /** Set a floating gate's charge (a chapter's starting state). */
  setFgCharge(leaf: number, q: number): void {
    const k = this.fgs.indexOf(leaf);
    if (k < 0) return;
    this.fgQ[k] = Math.min(1, Math.max(0, q));
    this.dirty = true;
  }

  /** A net's weak level: WEAK_H, WEAK_L or 0 (see the header). */
  weakOf(net: number): number {
    return this.weak[net];
  }
  /** Is some net at a weak level? */
  get hasWeak(): boolean {
    return this.weak.includes(WEAK_H) || this.weak.includes(WEAK_L);
  }
  /** A transistor partly on: a PMOS whose gate is H (or an NMOS whose gate is L), so current leaks through its gate. */
  leaky(leaf: number): boolean {
    const l = this.design.leaves[leaf];
    if (!l || (l.kind !== 'nmos' && l.kind !== 'pmos')) return false;
    const g = l.terminals![0];
    return l.kind === 'pmos' ? this.val[g] === B1 && this.weak[g] === WEAK_H : this.val[g] === B0 && this.weak[g] === WEAK_L;
  }

  /** Is some net part of a short in the last solution? */
  get hasShort(): boolean {
    return this.shorted.includes(1);
  }

  /**
   * The shorts of the last solution, one per group of shorted nets joined by conducting elements: for each, the
   * nearest 1 source and 0 source (rails or driven inputs) and the conducting leaves on the way, nearest the source
   * first. Computed on demand (a view or a check asks only when `hasShort`).
   */
  shorts(): Short[] {
    if (!this.hasShort) return [];
    const n = this.design.netCount, leaves = this.design.leaves;
    const src = new Int8Array(n).fill(-1);
    for (const l of leaves) {
      if (l.kind === 'vdd') src[l.terminals![0]] = B1;
      else if (l.kind === 'gnd') src[l.terminals![0]] = B0;
    }
    for (const [port, v] of this.inputs) {
      const bits = this.inputBits(port, v);
      this.inputNets.get(port)!.forEach((net, i) => { if (bits[i] === B0 || bits[i] === B1) src[net] = bits[i]; });
    }
    // the elements conducting now, as edges between nets (a relay: the contact its armature closes on each pole)
    const adj: [number, number][][] = Array.from({ length: n }, () => []);
    const edge = (a: number, b: number, li: number) => { adj[a].push([b, li]); adj[b].push([a, li]); };
    leaves.forEach((l, li) => {
      const t = l.terminals, c = this.conducting[li];
      if (!t) return;
      if ((l.kind === 'nmos' || l.kind === 'pmos' || l.kind === 'fgmos') && c === 1) edge(t[1], t[2], li);
      // a relay: operated (1) closes c–no, released (0) c–nc
      else if (l.kind === 'relay' && c !== 2) for (let p = 2; p + 2 < t.length; p += 3) edge(t[p], t[p + (c === 1 ? 1 : 2)], li);
    });
    const seen = new Uint8Array(n);
    const out: Short[] = [];
    for (let s0 = 0; s0 < n; s0++) {
      if (!this.shorted[s0] || seen[s0]) continue;
      // the group: shorted nets reachable without passing through a source
      const group: number[] = [s0];
      seen[s0] = 1;
      for (let k = 0; k < group.length; k++) {
        for (const [m] of adj[group[k]]) if (!seen[m] && src[m] < 0 && this.shorted[m]) { seen[m] = 1; group.push(m); }
      }
      // breadth first from the whole group to the nearest source of each value
      const from = new Map<number, [number, number]>(group.map((g) => [g, [-1, -1]]));
      const found: (number | undefined)[] = [undefined, undefined];
      for (let q = [...group], k = 0; k < q.length && (found[0] === undefined || found[1] === undefined); k++) {
        for (const [m, li] of adj[q[k]]) {
          if (from.has(m)) continue;
          from.set(m, [q[k], li]);
          if (src[m] >= 0) found[src[m]] ??= m;
          else q.push(m);
        }
      }
      const pathTo = (end: number | undefined): ShortSide | null => {
        if (end === undefined) return null;
        const via: number[] = [];
        for (let at = end; from.get(at)![1] >= 0; at = from.get(at)![0]) via.push(from.get(at)![1]);
        return { source: end, via };
      };
      out.push({ nets: group, hi: pathTo(found[1]), lo: pathTo(found[0]) });
    }
    return out;
  }

  /** Does the design have relays (then time counts relay steps)? */
  get hasRelays(): boolean {
    return this.relays.length > 0;
  }
  /** A relay leaf's armature (B0 released, B1 operated, BX unknown), or undefined if the leaf is not a relay. */
  relayState(leaf: number): Bit | undefined {
    const k = this.relayOf.get(leaf);
    return k === undefined ? undefined : (this.relayOp[k] as Bit);
  }
  /** Current through a relay's coil now (B1 yes, B0 no, BX unknown): its armature follows at the next relay step. */
  relayEnergized(leaf: number): Bit | undefined {
    const k = this.relayOf.get(leaf);
    return k === undefined ? undefined : this.energized(k);
  }
  private energized(k: number): Bit {
    const [a, b] = this.design.leaves[this.relays[k]].terminals!;
    const va = this.val[a], vb = this.val[b];
    if ((va === B0 || va === B1) && (vb === B0 || vb === B1)) return va !== vb ? B1 : B0;
    return va === BX || vb === BX ? BX : B0;
  }
  /** Is some armature about to move (its coil disagrees with it)? */
  private relayPending(): boolean {
    for (let k = 0; k < this.relays.length; k++) if (this.energized(k) !== this.relayOp[k]) return true;
    return false;
  }
  /** One relay step: every armature takes its coil's state at once, then the contacts are solved again. False if none moved. */
  relayStep(): boolean {
    let moved = false;
    for (let k = 0; k < this.relays.length; k++) {
      const e = this.energized(k);
      if (e !== this.relayOp[k]) {
        this.relayOp[k] = e;
        moved = true;
      }
    }
    if (!moved) return false;
    this.time++;
    this.dirty = true;
    this.settleNow();
    return true;
  }

  /**
   * Let `cycles` clock cycles of leakage pass: every net with NetDef.leak loses charge (its level
   * halves every `leak` cycles), then the circuit settles again (driven nets are restored at once).
   */
  leak(cycles: number): void {
    const leaks = this.design.leaks;
    if (!leaks?.size || !(cycles > 0)) return;
    for (const [net, h] of leaks) if (Number.isFinite(this.lv[net])) this.lv[net] *= 2 ** (-cycles / h);
    this.dirty = true;
    this.settle();
  }
  getBits(nets: readonly number[]): Bit[] {
    return nets.map((n) => this.val[n] as Bit);
  }
  getInput(port: string): number {
    const v = this.inputs.get(port) ?? 0;
    if (typeof v === 'number') return v;
    return v.every((b) => b === v[0]) && v[0] !== B0 && v[0] !== B1 ? -v[0] : pack(v);
  }
  getInputBits(port: string): Bit[] {
    return this.inputBits(port, this.inputs.get(port) ?? 0);
  }
  private inputBits(port: string, v: number | Bit[]): Bit[] {
    const w = this.inputNets.get(port)?.length ?? 0;
    return typeof v !== 'number' ? v.slice() : v >= 0 ? unpack(v, w) : new Array<Bit>(w).fill((-v) as Bit);
  }
  setInputBits(port: string, bits: ArrayLike<number>): void {
    const nets = this.inputNets.get(port);
    if (!nets) throw new Error(`no input port '${port}'`);
    this.inputs.set(port, nets.map((_, i) => (bits[i] ?? BZ) as Bit));
    this.dirty = true;
  }
  setInput(port: string, value: number): void {
    if (!this.inputNets.has(port)) throw new Error(`no input port '${port}'`);
    this.inputs.set(port, value);
    this.dirty = true;
  }
  /** Drive an input with an explicit bit, including X or Z (used for "what if" demos). */
  setInputBit(port: string, b: Bit): void {
    this.inputs.set(port, b === B0 ? 0 : b === B1 ? 1 : -(b as number));
    this.dirty = true;
  }
  watch(): void {}
  poke(leaf: number, state: unknown): void {
    this.state[leaf] = state;
    this.dirty = true;
  }
  leafState(leaf: number): unknown {
    return this.state[leaf];
  }
  busy(): boolean {
    return this.dirty || (this.relays.length > 0 && this.relayPending());
  }
  reset(mode?: PowerOnMode): void {
    this.state = this.design.leaves.map((l) => l.def.behavior?.init?.(mode));
    // springs hold every armature released while the power is off, whatever the mode
    this.relayOp.fill(B0);
    this.dirty = true;
    this.settle();
  }
  /**
   * Take over the node values of a simulation of a previous version of the design: nets matched
   * through the hierarchy (see matchNets), root inputs by port name and width. The solve starts
   * from them, so cross-coupled inverters keep their bit and `cap` nets keep their charge. With
   * `known`, X nodes of `prev` are not copied.
   */
  carry(prev: Sim, opts: { known?: boolean } = {}): void {
    for (const name of sharedInputs(this.design, prev.design)) this.inputs.set(name, prev.getInputBits(name));
    // root inouts too (only a switch-level simulation drives them)
    for (const p of this.design.root.def.ports) {
      const q = p.dir === 'inout' && prev.kind === 'switch' && prev.design.root.def.ports.find((x) => x.name === p.name);
      if (q && q.dir === 'inout' && q.width === p.width) this.inputs.set(p.name, prev.getInputBits(p.name));
    }
    const map = matchNets(this.design, prev.design);
    for (let net = 0; net < map.length; net++) {
      if (map[net] < 0) continue;
      const b = prev.get(map[net]);
      if (!opts.known || b !== BX) {
        this.val[net] = b;
        this.lv[net] = prev instanceof SwitchSim ? prev.lv[map[net]] : levelOfBit(b);
        for (const w of [B0, B1]) this.vLv[2 * net + w] = prev instanceof SwitchSim ? prev.vLv[2 * map[net] + w] : b === w ? LV_FET : 0;
      }
    }
    // behavioural leaves at the same path with the same definition keep their state (a held key)
    for (const li of this.behaviors) {
      const l = this.design.leaves[li];
      const o = findNode(prev.design.root, l.node.path);
      if (o?.leafIndex === undefined || o.def.id !== l.def.id) continue;
      const s = prev.leafState(o.leafIndex), c = l.def.behavior!.carry;
      this.state[li] = c && s !== undefined ? c(s, !!opts.known) : cloneState(s);
    }
    // relays at the same path keep their armature
    if (prev instanceof SwitchSim) this.relays.forEach((li, k) => {
      const o = findNode(prev.design.root, this.design.leaves[li].node.path);
      const pk = o?.leafIndex === undefined ? undefined : prev.relayOf.get(o.leafIndex);
      if (pk !== undefined) this.relayOp[k] = prev.relayOp[pk];
    });
    this.dirty = true;
    this.settle();
  }

  saveState(): SimState {
    const st: SwitchState = {
      val: this.val.slice(), conducting: this.conducting.slice(), shorted: this.shorted.slice(), weak: this.weak.slice(),
      lv: this.lv.slice(), senseDec: this.senseDec.slice(), fgQ: this.fgQ.slice(), fgPrev: this.fgPrev.slice(),
      relayOp: this.relayOp.slice(), time: this.time, vLv: this.vLv.slice(),
      inputs: new Map([...this.inputs].map(([k, v]) => [k, Array.isArray(v) ? v.slice() : v])),
      state: this.state.map(cloneState),
      unstable: this.unstable, evaluations: this.evaluations, dirty: this.dirty,
    };
    return st as unknown as SimState;
  }

  restoreState(saved: SimState): void {
    const s = saved as unknown as SwitchState;
    this.val.set(s.val);
    this.conducting.set(s.conducting);
    this.shorted.set(s.shorted);
    this.weak.set(s.weak);
    this.lv.set(s.lv);
    this.senseDec.set(s.senseDec);
    this.fgQ.set(s.fgQ);
    this.fgPrev.set(s.fgPrev);
    this.relayOp.set(s.relayOp);
    this.time = s.time;
    this.vLv.set(s.vLv);
    this.inputs = new Map([...s.inputs].map(([k, v]) => [k, Array.isArray(v) ? v.slice() : v]));
    this.state = s.state.map(cloneState);
    this.unstable = s.unstable;
    this.evaluations = s.evaluations;
    this.dirty = s.dirty;
  }

  /** A copy of every node value (index = flat net). */
  snapshot(): Uint8Array {
    return this.val.slice();
  }

  /**
   * Overwrite node values (as if the circuit had been left in that state: storage loops and
   * charge start from them). Inputs and rails still win at the next settle().
   */
  restore(vals: ArrayLike<number>): void {
    for (let i = 0; i < this.val.length; i++) {
      this.val[i] = vals[i];
      this.lv[i] = levelOfBit(vals[i]);
      this.vLv[2 * i] = vals[i] === B0 ? LV_FET : 0;
      this.vLv[2 * i + 1] = vals[i] === B1 ? LV_FET : 0;
    }
    this.dirty = true;
  }

  /** Solve after a change; then each call is one relay step. True while an armature is still to move. */
  step(): boolean {
    if (this.dirty) {
      this.settleNow();
      return this.relays.length > 0 && this.relayPending();
    }
    return this.relays.length > 0 && this.relayStep() && this.relayPending();
  }

  /** Solve, then take relay steps until every armature agrees with its coil (see the header). */
  settle(): void {
    this.settleNow();
    if (!this.relays.length) return;
    for (let n = 0; n < RELAY_SETTLE_MAX && this.relayStep(); n++);
    // still moving: it oscillates (a coil fed through its own break contact)
    if (this.relayPending()) this.unstable = true;
  }

  /** Solve the node values for the inputs and armatures now (no relay moves). */
  private settleNow(): void {
    this.settleOnce();
    // a program or erase pulse changes a threshold: settle again with it
    for (let i = 0; i < 4 && this.fgPulses(); i++) {
      this.dirty = true;
      this.settleOnce();
    }
  }

  /** Apply the rising edges of pgm / ers on the floating gates; true if a charge changed. */
  private fgPulses(): boolean {
    let changed = false;
    this.fgs.forEach((li, k) => {
      const [g, d, , , pgm, ers] = this.design.leaves[li].terminals!;
      const p = this.val[pgm] === B1 ? 1 : 0, e = this.val[ers] === B1 ? 2 : 0, prev = this.fgPrev[k];
      if (p && !(prev & 1) && this.val[g] === B1 && this.val[d] === B0 && this.fgQ[k] < 1) {
        this.fgQ[k] = Math.min(1, this.fgQ[k] + FG_STEP);
        changed = true;
      }
      if (e && !(prev & 2) && this.fgQ[k] > 0) {
        this.fgQ[k] = 0;
        changed = true;
      }
      this.fgPrev[k] = p | e;
    });
    return changed;
  }

  private settleOnce(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const n = this.design.netCount;
    const leaves = this.design.leaves;

    // Strong sources: rails and driven inputs.
    const source = new Int8Array(n).fill(-1);
    for (const l of leaves) {
      if (l.kind === 'vdd') source[l.terminals![0]] = B1;
      else if (l.kind === 'gnd') source[l.terminals![0]] = B0;
      else if (l.kind === 'vhalf') source[l.terminals![0]] = HALF;
    }
    for (const [port, v] of this.inputs) {
      const nets = this.inputNets.get(port)!;
      const bits = this.inputBits(port, v);
      nets.forEach((net, i) => { if (bits[i] !== BZ) source[net] = bits[i]; });
    }
    if (!this.behaviors.length) return this.solve(source);

    // Behavioural leaves drive their outputs as sources too. One whose outputs depend on its
    // inputs is re-evaluated on the solution until nothing changes (a few rounds at most).
    let outs = this.behaviorOutputs();
    this.unstable = false;
    for (let round = 0; ; round++) {
      const src = source.slice();
      for (const [net, b] of outs) src[net] = b;
      const was: boolean = this.unstable;
      this.solve(src);
      this.unstable ||= was;
      const next = this.behaviorOutputs();
      if (round >= 8 || [...next].every(([net, b]) => outs.get(net) === b)) {
        if (round >= 8) this.unstable = true;
        return;
      }
      outs = next;
    }
  }

  /** Output bits of every behavioural leaf for the node values now (X when a packed input has X / Z). */
  private behaviorOutputs(): Map<number, Bit> {
    const out = new Map<number, Bit>();
    for (const li of this.behaviors) {
      const l = this.design.leaves[li];
      const ins = l.inputs.map((p) => pack(p.map((net) => this.val[net])));
      const res = l.def.behavior!.eval(ins, this.state[li]);
      this.evaluations++;
      l.outputs.forEach((p, pi) => unpack(res[pi] ?? -1, p.length).forEach((b, i) => out.set(p[i], b)));
    }
    return out;
  }

  /** One solve of the node values from the given sources (−1: not a source; HALF: the VDD/2 rail). */
  private solve(source: Int8Array, depth = 0): void {
    const n = this.design.netCount;
    const leaves = this.design.leaves;
    const val = this.val;
    // stored charge: the levels before this solve
    const prev = this.lv;
    const lv = new Float64Array(n).fill(NaN);
    for (let i = 0; i < n; i++) if (source[i] >= 0) val[i] = source[i] === HALF ? BX : source[i];
    const charge = new Int8Array(n).fill(-1);
    for (const c of this.design.caps) if (source[c] < 0 && Number.isFinite(prev[c])) charge[c] = bitOfLevel(prev[c]);
    const capW = (c: number) => this.design.capWeight?.get(c) ?? 1;

    // Sources are terminals, never conducting nodes: every transistor terminal on a rail or a driven
    // input gets its own copy of that source (a virtual node n, n + 1, …), so paths cannot pass
    // through a source from one transistor to another. One VDD symbol feeding many pull-ups then
    // behaves exactly like one symbol per transistor.
    const srcLv: number[] = [], srcV: number[] = [];
    for (let i = 0; i < n; i++) {
      srcLv.push(charge[i] >= 0 ? LV_CHARGE : 0);
      srcV.push(charge[i]);
    }
    const term = (net: number) => {
      if (source[net] < 0) return net;
      srcLv.push(LV_SOURCE);
      srcV.push(source[net]);
      return srcLv.length - 1;
    };
    // Conducting elements: transistors (switched by their gate) and resistors (always on).
    const fets: { li: number; g: number; a: number; b: number; nmos: boolean; s: number; fg?: number; vp?: number; relay?: number; when?: number }[] = [];
    const ress: { a: number; b: number; s: number }[] = [];
    leaves.forEach((l, li) => {
      if (l.kind === 'res' || l.kind === 'dep') {
        const [a, b] = l.terminals!;
        ress.push({ a: term(a), b: term(b), s: level(l.def.strength ?? 1) });
        this.conducting[li] = 1;
        return;
      }
      if (l.kind === 'relay') {
        const t = l.terminals!, k = this.relayOf.get(li)!;
        // the coil: a resistor between its ends, the load that pulls an undriven line to 0
        ress.push({ a: term(t[0]), b: term(t[1]), s: level(1) });
        // each pole: c–no closes while operated, c–nc while released
        const s = level(l.def.strength ?? 4);
        for (let p = 2; p + 2 < t.length; p += 3) {
          fets.push({ li, g: -1, a: term(t[p]), b: term(t[p + 1]), nmos: true, s, relay: k, when: B1 });
          fets.push({ li, g: -1, a: term(t[p]), b: term(t[p + 2]), nmos: true, s, relay: k, when: B0 });
        }
        const o = this.relayOp[k];
        this.conducting[li] = o === B1 ? 1 : o === B0 ? 0 : 2;
        return;
      }
      if (l.kind === 'fgmos') {
        const [g, a, b, vp] = l.terminals!;
        fets.push({ li, g, a: term(a), b: term(b), nmos: true, s: level(l.def.strength ?? 3), fg: this.fgs.indexOf(li), vp });
        return;
      }
      if (l.kind !== 'nmos' && l.kind !== 'pmos') return;
      const [g, a, b] = l.terminals!;
      fets.push({ li, g, a: term(a), b: term(b), nmos: l.kind === 'nmos', s: level(l.def.strength ?? 3) });
    });
    // Sense amplifiers: each line joined, while enabled, to a source of its own (va, vb) whose value
    // is the latched decision, at transistor strength.
    const sas = this.senses.map((li, k) => {
      const l = leaves[li], [en, a, b] = l.terminals!;
      srcLv.push(LV_SOURCE, LV_SOURCE);
      srcV.push(BX, BX);
      return { k, en, a, b, ta: term(a), tb: term(b), va: srcLv.length - 2, vb: srcLv.length - 1, s: level(l.def.strength ?? 3), off: l.def.offset ?? SENSE_OFFSET };
    });
    // One-way elements: two sources each (va on the anode, vk on the cathode), set every iteration (see the header).
    const ows = this.oneWays.map((li) => {
      const l = leaves[li], t = l.terminals!;
      const [g, a, k] = l.kind === 'triode' ? t : [-1, t[0], t[1]];
      const ta = term(a), tk = term(k); // (term pushes a source copy: before the element's own two)
      srcLv.push(0, 0);
      srcV.push(B0, B1);
      return { li, g, a, k, ta, tk, va: srcLv.length - 2, vk: srcLv.length - 1, s: level(l.def.strength ?? 3), sa: 0, sk: 0 };
    });
    /** How a net offers `want` to a one-way element: [level, 2 sure / 1 maybe / 0 not]. */
    const offer = (net: number, want: number): [number, number] => {
      const sv = source[net];
      if (sv >= 0) return sv === want ? [LV_SOURCE, 2] : sv === HALF ? [LV_SOURCE, 1] : [0, 0];
      const v = val[net], l = this.vLv[2 * net + want];
      return v === want ? [l, 2] : v === BX && l ? [l, 1] : [0, 0];
    };
    const N = srcLv.length;
    /** Per sense amplifier this iteration: −1 off, −2 maybe on (en X / Z), else the value on a (0, 1, BX). */
    const dec = new Int8Array(sas.length);

    let iter = 0;
    let changed = true;
    while (changed && iter < 64) {
      iter++;
      changed = false;
      this.evaluations++;
      // conduction state from the current gate values
      const on = new Uint8Array(fets.length), maybeOn = new Uint8Array(fets.length);
      fets.forEach((f, k) => {
        if (f.relay !== undefined) {
          const o = this.relayOp[f.relay];
          on[k] = o === f.when ? 1 : 0;
          maybeOn[k] = o === f.when || o === BX ? 1 : 0;
          return;
        }
        const gv = val[f.g];
        let o = f.nmos ? gv === B1 : gv === B0, off = f.nmos ? gv === B0 : gv === B1;
        if (f.fg !== undefined) {
          // a floating gate: on at the pass voltage, or at the read voltage while (nearly) erased
          const pv = val[f.vp!], low = this.fgQ[f.fg] < FG_READ;
          o = pv === B1 || (gv === B1 && low);
          off = pv === B0 && (gv === B0 || (gv === B1 && !low));
        }
        this.conducting[f.li] = o ? 1 : off ? 0 : 2;
        on[k] = o ? 1 : 0;
        maybeOn[k] = off ? 0 : 1;
      });
      for (const sa of sas) {
        const e = val[sa.en], held = this.senseDec[sa.k];
        // just enabled: compare the lines' levels as they were before (the bit lines after sharing)
        const d = e === B0 ? -1 : e !== B1 ? -2 : held >= 0 ? held : decide(prev[sa.a], prev[sa.b], sa.off);
        dec[sa.k] = d;
        srcV[sa.va] = d === B0 || d === B1 ? d : BX;
        srcV[sa.vb] = d === B0 || d === B1 ? 1 - d : BX;
      }
      for (const o of ows) {
        const gv = o.g < 0 ? B1 : val[o.g];
        const gate = gv === B1 ? 2 : gv === B0 ? 0 : 1;
        const [la, fa] = offer(o.k, B0), [lk, fk] = offer(o.a, B1);
        const sa = Math.min(gate, fa), sk = Math.min(gate, fk);
        const nla = sa ? la : 0, nlk = sk ? lk : 0;
        if (sa !== o.sa || sk !== o.sk || nla !== srcLv[o.va] || nlk !== srcLv[o.vk]) changed = true;
        o.sa = sa; o.sk = sk; srcLv[o.va] = nla; srcLv[o.vk] = nlk;
        this.conducting[o.li] = o.g >= 0 ? (gate === 2 ? 1 : gate === 1 ? 2 : 0) : sa === 2 || sk === 2 ? 1 : sa || sk ? 2 : 0;
      }
      // Levels nothing sits on add nothing (the same groups and sources as the level above): skip them.
      const present = new Uint8Array(LV_SOURCE + 1);
      present[LV_SOURCE] = present[LV_CHARGE] = 1;
      for (const f of fets) present[f.s] = 1;
      for (const r of ress) present[r.s] = 1;
      for (const sa of sas) present[sa.s] = 1;
      for (const o of ows) present[o.s] = 1;
      for (let i = 0; i < N; i++) present[srcLv[i]] = 1;
      // Strongest definite / possible path from a 1, a 0, a ½ or an X source, per node (levels: see
      // the header).
      const d1 = new Uint8Array(n), d0 = new Uint8Array(n), dX = new Uint8Array(n), dH = new Uint8Array(n);
      const m1 = new Uint8Array(n), m0 = new Uint8Array(n), mX = new Uint8Array(n), mH = new Uint8Array(n);
      let sureC: UF | null = null, maybeC: UF | null = null;
      for (let L = LV_SOURCE; L >= LV_CHARGE; L--) {
        if (!present[L]) continue;
        const sure = new UF(N), maybe = new UF(N);
        fets.forEach((f, k) => {
          if (f.s < L) return;
          if (on[k]) sure.union(f.a, f.b);
          if (maybeOn[k]) maybe.union(f.a, f.b);
        });
        for (const r of ress) {
          if (r.s < L) continue;
          sure.union(r.a, r.b);
          maybe.union(r.a, r.b);
        }
        for (const o of ows) {
          if (o.s < L) continue;
          if (o.sa === 2) sure.union(o.ta, o.va);
          if (o.sa) maybe.union(o.ta, o.va);
          if (o.sk === 2) sure.union(o.tk, o.vk);
          if (o.sk) maybe.union(o.tk, o.vk);
        }
        for (const sa of sas) {
          const d = dec[sa.k];
          if (sa.s < L || d === -1) continue;
          if (d !== -2) {
            sure.union(sa.ta, sa.va);
            sure.union(sa.tb, sa.vb);
          }
          maybe.union(sa.ta, sa.va);
          maybe.union(sa.tb, sa.vb);
        }
        if (L === LV_CHARGE) {
          sureC = sure;
          maybeC = maybe;
        }
        const sHi = new Uint8Array(N), sLo = new Uint8Array(N), sX = new Uint8Array(N), sH = new Uint8Array(N);
        const mHi = new Uint8Array(N), mLo = new Uint8Array(N), mXx = new Uint8Array(N), mHh = new Uint8Array(N);
        for (let i = 0; i < N; i++) {
          if (srcLv[i] < L) continue;
          const v = srcV[i], rs = sure.find(i), rm = maybe.find(i);
          if (v === B1) { sHi[rs] = 1; mHi[rm] = 1; } else if (v === B0) { sLo[rs] = 1; mLo[rm] = 1; } else if (v === HALF) { sH[rs] = 1; mHh[rm] = 1; } else { sX[rs] = 1; mXx[rm] = 1; }
        }
        for (let i = 0; i < n; i++) {
          const rs = sure.find(i), rm = maybe.find(i);
          if (sHi[rs] && !d1[i]) d1[i] = L;
          if (sLo[rs] && !d0[i]) d0[i] = L;
          if (sX[rs] && !dX[i]) dX[i] = L;
          if (sH[rs] && !dH[i]) dH[i] = L;
          if (mHi[rm] && !m1[i]) m1[i] = L;
          if (mLo[rm] && !m0[i]) m0[i] = L;
          if (mXx[rm] && !mX[i]) mX[i] = L;
          if (mHh[rm] && !mH[i]) mH[i] = L;
        }
      }
      // Charge sharing among nets no stronger path reaches: per group of nets joined by conducting
      // elements, Σ C·V / Σ C over its charged nets; groups a maybe-conducting element joins agree
      // or are unknown.
      const gC = new Float64Array(N), gCV = new Float64Array(N);
      const mLoL = new Float64Array(N).fill(Infinity), mHiL = new Float64Array(N).fill(-Infinity);
      for (const c of this.design.caps) {
        if (charge[c] < 0) continue;
        const r = sureC!.find(c), w = capW(c);
        gC[r] += w;
        gCV[r] += w * prev[c];
      }
      for (const c of this.design.caps) {
        if (charge[c] < 0) continue;
        const r = sureC!.find(c), rm = maybeC!.find(c), l = gCV[r] / gC[r];
        if (l < mLoL[rm]) mLoL[rm] = l;
        if (l > mHiL[rm]) mHiL[rm] = l;
      }
      // Weak levels (see the header): per value, the sure paths that pass it whole (a 1: no NMOS; a 0: no PMOS) and
      // the paths that pass it at all (not through an NMOS gated by H / a PMOS gated by L), from last iteration's levels.
      const weak = this.weak;
      let full1: UF | null = null, ok1: UF | null = null, full0: UF | null = null, ok0: UF | null = null;
      const f1 = new Uint8Array(N), o1 = new Uint8Array(N), f0 = new Uint8Array(N), o0 = new Uint8Array(N);
      if (this.mosfets) {
        const F1 = (full1 = new UF(N)), O1 = (ok1 = new UF(N)), F0 = (full0 = new UF(N)), O0 = (ok0 = new UF(N));
        const all = (a: number, b: number) => { F1.union(a, b); O1.union(a, b); F0.union(a, b); O0.union(a, b); };
        fets.forEach((f, k) => {
          if (!on[k]) return;
          if (f.relay !== undefined) return all(f.a, f.b);
          const gw = weak[f.g];
          if (f.nmos) {
            F0.union(f.a, f.b); O0.union(f.a, f.b);
            if (gw !== WEAK_H) O1.union(f.a, f.b);
          } else {
            F1.union(f.a, f.b); O1.union(f.a, f.b);
            if (gw !== WEAK_L) O0.union(f.a, f.b);
          }
        });
        for (const r of ress) all(r.a, r.b);
        for (const o of ows) {
          if (o.sa === 2) all(o.ta, o.va);
          if (o.sk === 2) all(o.tk, o.vk);
        }
        for (const sa of sas) if (dec[sa.k] >= 0) { all(sa.ta, sa.va); all(sa.tb, sa.vb); }
        for (let i = 0; i < N; i++) {
          if (srcLv[i] <= LV_CHARGE) continue;
          if (srcV[i] === B1) { f1[F1.find(i)] = 1; o1[O1.find(i)] = 1; } else if (srcV[i] === B0) { f0[F0.find(i)] = 1; o0[O0.find(i)] = 1; }
        }
      }
      for (let i = 0; i < n; i++) {
        if (source[i] >= 0) {
          weak[i] = 0;
          this.shorted[i] = 0;
          lv[i] = source[i] === HALF ? 0.5 : levelOfBit(source[i]);
          continue;
        }
        let v: number, l = NaN;
        const best = Math.max(d1[i], d0[i], dH[i]);
        if (dX[i] && dX[i] >= best) v = BX;
        else if (d1[i] > d0[i] && d1[i] > dH[i] && d1[i] > m0[i] && d1[i] > mX[i] && d1[i] > mH[i]) v = B1;
        else if (d0[i] > d1[i] && d0[i] > dH[i] && d0[i] > m1[i] && d0[i] > mX[i] && d0[i] > mH[i]) v = B0;
        else if (dH[i] > d1[i] && dH[i] > d0[i] && dH[i] > m1[i] && dH[i] > m0[i] && dH[i] > mX[i]) { v = BX; l = 0.5; }
        else v = m1[i] || m0[i] || mX[i] || mH[i] ? BX : BZ;
        // a weak level: the bit stands (stored-charge nets keep theirs: their level is the charge's), or X when only
        // an NMOS gated by H brings the 1 (a PMOS gated by L the 0)
        let w = 0;
        if (full1 && (v === B0 || v === B1) && Math.max(d1[i], d0[i]) > LV_CHARGE && !this.design.caps.has(i)) {
          if (v === B1 && !f1[full1.find(i)]) {
            if (o1[ok1!.find(i)]) w = WEAK_H;
            else v = BX;
          } else if (v === B0 && !f0[full0!.find(i)]) {
            if (o0[ok0!.find(i)]) w = WEAK_L;
            else v = BX;
          }
        }
        if (weak[i] !== w) {
          weak[i] = w;
          changed = true;
        }
        if (v === B0 || v === B1) l = v;
        if (Math.max(d1[i], d0[i], dX[i], dH[i], m1[i], m0[i], mX[i], mH[i]) <= LV_CHARGE) {
          // only charge reaches this net: it holds its group's shared level
          const r = sureC!.find(i), rm = maybeC!.find(i);
          if (gC[r] > 0) {
            l = mHiL[rm] - mLoL[rm] > 1e-9 ? NaN : gCV[r] / gC[r];
            v = Number.isFinite(l) ? bitOfLevel(l) : BX;
          }
        }
        lv[i] = l;
        const any = Math.max(mX[i], dX[i], mH[i]);
        this.vLv[2 * i] = v === B0 ? d0[i] : v === BX ? Math.max(m0[i], any) : 0;
        this.vLv[2 * i + 1] = v === B1 ? d1[i] : v === BX ? Math.max(m1[i], any) : 0;
        // current flows from a rail to the other through conducting transistors
        this.shorted[i] = d1[i] >= LV_FET && d0[i] >= LV_FET ? 1 : 0;
        if (val[i] !== v) {
          val[i] = v;
          changed = true;
        }
      }
    }
    this.unstable = changed;
    this.lv = lv;
    // A latched amplifier follows its lines when something stronger (a write driver) forces one of
    // them: it flips, and the circuit is solved again with the amplifier driving the new value.
    let flipped = false;
    const known = (v: number) => v === B0 || v === B1;
    for (const sa of sas) {
      const d = dec[sa.k], va = val[sa.a], vb = val[sa.b];
      let nd = d;
      if (d === -1 || d === -2) nd = -1;
      else if (known(va) && vb === 1 - va) nd = va;
      else if (known(va) && va !== d) nd = va;
      else if (known(vb) && vb !== 1 - d) nd = 1 - vb;
      if (nd !== d && nd >= 0) flipped = true;
      this.senseDec[sa.k] = nd;
    }
    if (flipped && depth < 4) this.solve(source, depth + 1);
  }
}

/** What a sense amplifier latches from its lines' levels: the higher one's side, X when unknown or too close. */
function decide(a: number, b: number, offset: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a - b) < offset) return BX;
  return a > b ? B1 : B0;
}

/** One side of a short: the source it reaches (a net) and the conducting leaves from it to the shorted nets. */
export interface ShortSide { source: number; via: number[] }
/** A group of shorted nets and its two sides (null: not found among transistors, e.g. through a behaviour). */
export interface Short { nets: number[]; hi: ShortSide | null; lo: ShortSide | null }

/** A short in words: `VDD shorted to GND through p1, n1` (sources by rail or input pin, leaves by instance path). */
export function shortText(sim: SwitchSim, s: Short): string {
  const d = sim.design;
  const srcName = (side: ShortSide | null, v: Bit): string => {
    if (!side) return v === B1 ? 'a 1' : 'a 0';
    for (const l of d.leaves) if ((l.kind === 'vdd' || l.kind === 'gnd') && l.terminals![0] === side.source) return l.kind === 'vdd' ? 'VDD' : 'GND';
    for (const p of d.root.def.ports) {
      const i = d.root.ports[p.name]?.indexOf(side.source) ?? -1;
      if (i >= 0) return `${p.name}${p.width > 1 ? `[${i}]` : ''} = ${v === B1 ? 1 : 0}`;
    }
    return v === B1 ? 'a 1' : 'a 0';
  };
  const name = (li: number) => d.leaves[li].node.path.join('.') || d.leaves[li].node.name;
  const via = [...(s.hi?.via ?? []).map(name), ...(s.lo?.via ?? []).map(name).reverse()];
  return `${srcName(s.hi, B1)} shorted to ${srcName(s.lo, B0)}${via.length ? ` through ${[...new Set(via)].join(', ')}` : ''}`;
}

/** Weak levels (see the header): a 1 an NMOS passed, a 0 a PMOS passed; their voltages for display (VDD − Vt, Vt). */
export const WEAK_H = 1, WEAK_L = 2;
export const VT_VOLTS = 0.3;

/** Solver levels (see the header): sources, the weakest transistor, stored charge. */
const LV_SOURCE = 7, LV_FET = 4, LV_CHARGE = 1;
/** Relay steps settle() takes at most: a relay circuit still moving after them oscillates. */
export const RELAY_SETTLE_MAX = 64;
/** Charge a program pulse adds to a floating gate, and the charge above which it no longer conducts at the read voltage. */
export const FG_STEP = 0.2, FG_READ = 0.3;
/** A source of level ½ (the VDD/2 rail): an X as a bit. */
const HALF = 4;
/** The supply the levels are fractions of, in volts (for display). */
export const VDD_VOLTS = 1.1;
/** A level reads as 1 at or above HI, as 0 at or below LO, else as X. */
export const LEVEL_HI = 0.7, LEVEL_LO = 0.3;
/** A sense amplifier's default offset: 15 mV of a 1.1 V supply. */
export const SENSE_OFFSET = 0.015 / VDD_VOLTS;
const bitOfLevel = (l: number): Bit => (l >= LEVEL_HI ? B1 : l <= LEVEL_LO ? B0 : BX);
const levelOfBit = (b: number): number => (b === B1 ? 1 : b === B0 ? 0 : NaN);
/** Level of a conducting element of strength s (0 = bias resistor, 1 = resistor … 4 = wide transistor). */
const level = (s: number) => Math.min(LV_SOURCE - 1, Math.max(LV_CHARGE + 1, Math.round(s) + 2));

class UF {
  p: Int32Array;
  constructor(n: number) {
    this.p = new Int32Array(n);
    for (let i = 0; i < n; i++) this.p[i] = i;
  }
  find(x: number): number {
    const p = this.p;
    while (p[x] !== x) {
      p[x] = p[p[x]];
      x = p[x];
    }
    return x;
  }
  union(a: number, b: number): void {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.p[ra] = rb;
  }
}

interface SwitchState {
  val: Uint8Array; conducting: Uint8Array; shorted: Uint8Array; weak: Uint8Array; lv: Float64Array; senseDec: Int8Array; fgQ: Float64Array; fgPrev: Uint8Array; inputs: Map<string, number | Bit[]>; state: unknown[];
  relayOp: Uint8Array; time: number; vLv: Uint8Array;
  unstable: boolean; evaluations: number; dirty: boolean;
}
