// Event-driven switch-level engine for large NMOS circuits (the 6502 of Appendix A: thousands of
// transistors, dynamic latches, precharged buses). SwitchSim re-solves the whole circuit with a
// strength analysis on every change; this engine, like visual6502 / perfect6502, recomputes only
// the channel-connected groups a change reaches:
//
//   - a group is the set of nodes joined by conducting transistors; rails and driven inputs end a
//     path (they are terminals, never members);
//   - its value: GND or an input at 0 → 0; else VDD or an input at 1 → 1; else a pull-up
//     (a depletion load or a resistor to VDD) → 1, a pull-down → 0; else stored charge: the value
//     of its largest-capacitance node (NetDef.cap: a precharged bus beats a storage node);
//   - a group reaching both 0 and 1 sources is a short: 0 wins and `shorts` counts it. Two equal
//     capacitances holding different values share their charge: 1 wins and `sharing` counts it;
//   - when a node changes, the transistors it gates switch, and the groups on both sides of each are
//     recomputed in the next wave, until nothing changes (or `unstable` after MAX_WAVES).
//
// Two-valued: every node is 0 or 1 (power-on 'x' starts from 0, like an unpowered chip's empty
// gates). Ratioed logic is the single strength rule above: any transistor path to GND beats a
// load. SwitchSim agrees with it wherever no node is X (tests/nmossim.test.ts checks the cells).

import { matchNets, sharedInputs } from './carry';
import type { FlatDesign } from './flatten';
import type { PowerOnMode, Sim, SimState } from './sim';
import { B0, B1, BZ, type Bit } from './types';
import { pack, unpack } from './values';

/** Waves before a settle gives up (a ring oscillator never settles). */
const MAX_WAVES = 400;

export class NmosSim implements Sim {
  readonly kind = 'switch' as const;
  readonly design: FlatDesign;
  readonly time = 0;
  unstable = false;
  evaluations = 0;
  /** Groups that reached both a 0 and a 1 source (a short) since the last resetCounters(). */
  shorts = 0;
  /** Groups resolved by charge between equal capacitances holding different values. */
  sharing = 0;
  /** The nodes still changing when a settle gave up (unstable). */
  stuck: number[] = [];
  onTrace?: (net: number, value: Bit, time: number) => void;

  /** Node values (0 / 1). */
  private val: Uint8Array;
  /** Per transistor: 1 when conducting. */
  private on: Uint8Array;
  /** Per leaf: 1 if the transistor conducts (loads and resistors always do), 0 if off (views read it). */
  readonly conducting: Uint8Array;
  private tg: Int32Array; private ta: Int32Array; private tb: Int32Array; private tp: Uint8Array;
  private tLeaf: Int32Array;
  /** CSR lists: transistors whose channel touches a node, transistors a node gates. */
  private chS: Int32Array; private chT: Int32Array;
  private gS: Int32Array; private gT: Int32Array;
  /** 1 = GND, 2 = VDD (rails are terminals). */
  private rail: Uint8Array;
  /** 1 = pulled up (a load or resistor to VDD), 2 = pulled down. */
  private pull: Uint8Array;
  private capW: Float64Array;
  /** Driven root input value per node: 0 / 1, or 255 when not driven. */
  private src: Uint8Array;
  private inputNets = new Map<string, number[]>();
  private inputs = new Map<string, Bit[]>();
  private dirtyNodes: number[] = [];
  private stamp: Int32Array;
  private gen = 1;
  private stack: Int32Array;
  private group: Int32Array;

  constructor(design: FlatDesign) {
    this.design = design;
    const n = design.netCount;
    this.val = new Uint8Array(n);
    this.rail = new Uint8Array(n);
    this.pull = new Uint8Array(n);
    this.src = new Uint8Array(n).fill(255);
    this.stamp = new Int32Array(n);
    this.stack = new Int32Array(n);
    this.group = new Int32Array(n);
    this.conducting = new Uint8Array(design.leaves.length);
    const fets: number[] = [];
    for (const [li, l] of design.leaves.entries()) {
      if (l.kind === 'vdd') this.rail[l.terminals![0]] |= 2;
      else if (l.kind === 'gnd') this.rail[l.terminals![0]] |= 1;
      else if (l.kind === 'nmos' || l.kind === 'pmos') fets.push(li);
      else if (l.kind === 'behavior') throw new Error(`NmosSim: behavioural leaf ${l.node.path.join('.')} (use SwitchSim)`);
      // one strength rule only: transistors drawn stronger or weaker (an SRAM cell's write) need SwitchSim
      if (l.def.strength !== undefined && l.kind !== 'res') throw new Error(`NmosSim: ${l.node.path.join('.')} has a drive strength (use SwitchSim)`);
    }
    for (let i = 0; i < n; i++) if (this.rail[i] === 3) throw new Error('NmosSim: a net is both VDD and GND');
    // loads and resistors: pull-ups / pull-downs on the node they reach from a rail
    for (const [li, l] of design.leaves.entries()) {
      if (l.kind !== 'dep' && l.kind !== 'res') continue;
      this.conducting[li] = 1;
      const [a, b] = l.terminals!;
      const ra = this.rail[a], rb = this.rail[b];
      if (ra && !rb) this.pull[b] |= ra === 2 ? 1 : 2;
      else if (rb && !ra) this.pull[a] |= rb === 2 ? 1 : 2;
      else if (!ra && !rb) throw new Error(`NmosSim: ${l.node.path.join('.')} joins two signal nodes (only loads to a rail are supported)`);
    }
    const m = fets.length;
    this.tg = new Int32Array(m); this.ta = new Int32Array(m); this.tb = new Int32Array(m);
    this.tp = new Uint8Array(m); this.tLeaf = new Int32Array(m); this.on = new Uint8Array(m);
    fets.forEach((li, t) => {
      const l = design.leaves[li];
      const [g, a, b] = l.terminals!;
      this.tg[t] = g; this.ta[t] = a; this.tb[t] = b; this.tp[t] = l.kind === 'pmos' ? 1 : 0; this.tLeaf[t] = li;
    });
    [this.chS, this.chT] = csr(n, m, (t, add) => { add(this.ta[t]); if (this.tb[t] !== this.ta[t]) add(this.tb[t]); });
    [this.gS, this.gT] = csr(n, m, (t, add) => add(this.tg[t]));
    this.capW = new Float64Array(n);
    for (const c of design.caps) this.capW[c] = 1;
    for (const [c, w] of design.capWeight ?? []) this.capW[c] = w;
    for (const p of design.root.def.ports) {
      if (p.dir === 'out') continue;
      const nets = design.root.ports[p.name];
      this.inputNets.set(p.name, nets);
      this.inputs.set(p.name, nets.map(() => (p.dir === 'in' ? B0 : BZ)) as Bit[]);
      // an input starts driven at the 0 it reads as (setInput skips an unchanged bit: left at 0, it floated)
      if (p.dir === 'in') for (const net of nets) this.src[net] = 0;
    }
    this.reset('zero');
  }

  get(net: number): Bit {
    return this.val[net] as Bit;
  }
  getBits(nets: readonly number[]): Bit[] {
    return nets.map((n) => this.val[n] as Bit);
  }
  getInput(port: string): number {
    const v = this.inputs.get(port) ?? [];
    return v.every((b) => b === B0 || b === B1) ? pack(v) : -BZ;
  }
  getInputBits(port: string): Bit[] {
    return (this.inputs.get(port) ?? []).slice();
  }
  setInput(port: string, value: number): void {
    const nets = this.inputNets.get(port);
    if (!nets) throw new Error(`no input port '${port}'`);
    this.setInputBits(port, value >= 0 ? unpack(value, nets.length) : nets.map(() => (-value) as Bit));
  }
  setInputBits(port: string, bits: ArrayLike<number>): void {
    const nets = this.inputNets.get(port);
    if (!nets) throw new Error(`no input port '${port}'`);
    const cur = this.inputs.get(port)!;
    for (let i = 0; i < nets.length; i++) {
      const b = (bits[i] ?? BZ) as Bit;
      if (cur[i] === b) continue;
      cur[i] = b;
      this.drive(nets[i], b === B0 ? 0 : b === B1 ? 1 : 255);
    }
  }
  setInputBit(port: string, b: Bit): void {
    const nets = this.inputNets.get(port);
    if (nets) this.setInputBits(port, nets.map(() => b));
  }
  /** Drive a node from outside (0 / 1), or release it (255): the test benches' fast path. */
  drive(net: number, v: number): void {
    if (this.src[net] === v) return;
    this.src[net] = v;
    this.dirtyNodes.push(net);
  }
  watch(): void {}
  poke(): void {}
  leafState(): unknown {
    return undefined;
  }
  busy(): boolean {
    return this.dirtyNodes.length > 0;
  }
  step(): boolean {
    this.settle();
    return false;
  }

  settle(): void {
    if (!this.dirtyNodes.length) return;
    const seeds = this.dirtyNodes;
    this.dirtyNodes = [];
    const list: number[] = [];
    for (const net of seeds) {
      // a source node itself: its value, and every group it touches
      const s = this.src[net];
      if (s !== 255) this.setNode(net, s, list);
      else list.push(net);
      for (let k = this.chS[net]; k < this.chS[net + 1]; k++) {
        const t = this.chT[k];
        list.push(this.ta[t] === net ? this.tb[t] : this.ta[t]);
      }
    }
    this.run(list);
  }

  /** Recompute the groups of `list`, then of everything they changed, until quiet. */
  private run(list: number[]): void {
    let waves = 0;
    let cur = list;
    while (cur.length) {
      if (++waves > MAX_WAVES) {
        // an oscillation (a ring of inverters, or an undocumented opcode joining a bus to its own
        // inverse): give up for now, but keep what is still moving pending, so that the next settle
        // recomputes it once the cause is gone instead of leaving half-propagated values behind
        this.unstable = true;
        this.stuck = cur.slice();
        for (const n of cur) this.dirtyNodes.push(n);
        return;
      }
      const next: number[] = [];
      const gen = ++this.gen;
      for (const n of cur) {
        if (this.stamp[n] === gen || this.rail[n] || this.src[n] !== 255) continue;
        this.recalc(n, gen, next);
      }
      cur = next;
    }
    this.unstable = false;
  }

  /** One group: collect it from `start`, decide its value, apply it. */
  private recalc(start: number, gen: number, next: number[]): void {
    this.evaluations++;
    const { stack, group, stamp, chS, chT, ta, tb, on, rail, src, pull, capW, val } = this;
    let sp = 0, gn = 0;
    let lo = 0, hi = 0, pu = 0, pd = 0;
    let best = -1, bestV = 0, tie = 0;
    stack[sp++] = start;
    stamp[start] = gen;
    while (sp) {
      const n = stack[--sp];
      group[gn++] = n;
      const p = pull[n];
      if (p & 1) pu = 1;
      if (p & 2) pd = 1;
      const w = capW[n];
      if (w > best) { best = w; bestV = val[n]; tie = 0; } else if (w === best && val[n] !== bestV) tie = 1;
      for (let k = chS[n]; k < chS[n + 1]; k++) {
        const t = chT[k];
        if (!on[t]) continue;
        const o = ta[t] === n ? tb[t] : ta[t];
        const r = rail[o];
        if (r) { if (r === 1) lo = 1; else hi = 1; continue; }
        const s = src[o];
        if (s !== 255) { if (s) hi = 1; else lo = 1; continue; }
        if (stamp[o] === gen) continue;
        stamp[o] = gen;
        stack[sp++] = o;
      }
    }
    let v: number;
    if (lo) { v = 0; if (hi) this.shorts++; } else if (hi) v = 1;
    else if (pu || pd) { v = pu ? (pd ? 0 : 1) : 0; if (pu && pd) this.shorts++; } else if (tie) { v = 1; this.sharing++; } else v = bestV;
    for (let i = 0; i < gn; i++) this.setNode(group[i], v, next);
  }

  /** Set a node; on a change, switch the transistors it gates and queue both sides of each. */
  private setNode(n: number, v: number, next: number[]): void {
    if (this.val[n] === v) return;
    this.val[n] = v;
    this.onTrace?.(n, v as Bit, 0);
    const { gS, gT, tp, on, ta, tb, tLeaf, conducting } = this;
    for (let k = gS[n]; k < gS[n + 1]; k++) {
      const t = gT[k];
      const o = tp[t] ? v ^ 1 : v;
      if (on[t] === o) continue;
      on[t] = o;
      conducting[tLeaf[t]] = o;
      next.push(ta[t], tb[t]);
    }
  }

  reset(mode: PowerOnMode = 'zero'): void {
    const n = this.design.netCount;
    for (let i = 0; i < n; i++) this.val[i] = mode === 'random' ? (Math.random() < 0.5 ? 1 : 0) : 0;
    for (const [i, v] of this.design.powerOn) this.val[i] = v;
    for (let i = 0; i < n; i++) {
      if (this.rail[i]) this.val[i] = this.rail[i] === 2 ? 1 : 0;
      else if (this.src[i] !== 255) this.val[i] = this.src[i];
    }
    this.resyncOn();
    this.dirtyNodes = [];
    const all: number[] = [];
    for (let i = 0; i < n; i++) all.push(i);
    this.run(all);
  }

  /** Transistor states from the gate values (after values were written directly). */
  private resyncOn(): void {
    for (let t = 0; t < this.on.length; t++) {
      const g = this.val[this.tg[t]];
      this.on[t] = this.tp[t] ? g ^ 1 : g;
      this.conducting[this.tLeaf[t]] = this.on[t];
    }
  }

  /** Recompute every group from the present values (a check that incremental updates missed nothing). */
  recomputeAll(): void {
    const all: number[] = [];
    for (let i = 0; i < this.design.netCount; i++) all.push(i);
    this.run(all);
  }

  resetCounters(): void {
    this.shorts = 0;
    this.sharing = 0;
  }

  carry(prev: Sim): void {
    for (const name of sharedInputs(this.design, prev.design)) this.setInputBits(name, prev.getInputBits(name));
    const map = matchNets(this.design, prev.design);
    for (let net = 0; net < map.length; net++) {
      if (map[net] < 0 || this.rail[net] || this.src[net] !== 255) continue;
      const b = prev.get(map[net]);
      if (b === B0 || b === B1) this.val[net] = b;
    }
    this.resyncOn();
    const all: number[] = [];
    for (let i = 0; i < this.design.netCount; i++) all.push(i);
    this.run(all);
  }

  saveState(): SimState {
    const st: NmosState = {
      val: this.val.slice(), src: this.src.slice(),
      inputs: new Map([...this.inputs].map(([k, v]) => [k, v.slice()])),
      unstable: this.unstable, evaluations: this.evaluations, dirty: this.dirtyNodes.slice(),
    };
    return st as unknown as SimState;
  }

  restoreState(saved: SimState): void {
    const s = saved as unknown as NmosState;
    this.val.set(s.val);
    this.src.set(s.src);
    this.inputs = new Map([...s.inputs].map(([k, v]) => [k, v.slice()]));
    this.unstable = s.unstable;
    this.evaluations = s.evaluations;
    this.dirtyNodes = s.dirty.slice();
    this.resyncOn();
  }

  /** A copy of every node value (index = flat net). */
  snapshot(): Uint8Array {
    return this.val.slice();
  }
}

interface NmosState {
  val: Uint8Array; src: Uint8Array; inputs: Map<string, Bit[]>; unstable: boolean; evaluations: number; dirty: number[];
}

/** Compressed lists: for each node, the transistors `each` adds it to. */
function csr(n: number, m: number, each: (t: number, add: (node: number) => void) => void): [Int32Array, Int32Array] {
  const count = new Int32Array(n + 1);
  for (let t = 0; t < m; t++) each(t, (node) => count[node + 1]++);
  for (let i = 0; i < n; i++) count[i + 1] += count[i];
  const fill = count.slice(0, n);
  const out = new Int32Array(count[n]);
  for (let t = 0; t < m; t++) each(t, (node) => (out[fill[node]++] = t));
  return [count, out];
}
