// Flip-flops as tables, for the cycle engine (cyclesim.ts). A flip-flop (a definition marked `ff`,
// e.g. the library's master–slave DFF) is a dozen NANDs that every clock edge toggles inside, which
// is most of the work of simulating a CPU. Its settled response is a small state machine: given the
// settled values of its nets and new input values, gate-level simulation of the flip-flop alone
// (unit delays, exactly GateSim's semantics) gives the next settled values. FfTable tabulates that
// over the states reachable from the ones it is given, so the cycle engine looks a transition up
// instead of evaluating gates, and still knows the value of every internal net.
//
// A table is only exact inside a whole circuit if the flip-flop does not care *when* its data
// inputs change after a clock edge (they arrive at least one gate delay later: they come from the
// edge itself, through other flip-flops and logic) nor about glitches on them, and if its outputs
// never follow a data input while the clock is steady (it is edge-triggered). intern() checks all of
// that by simulation for every reachable state (data changes 1 … K delays after the edge, pairs of
// inputs arriving in any order, pulses of every short width) and refuses the state otherwise.

import { flatten, type FlatDesign } from './flatten';
import { B0, B1, BX, type ComponentDef, inPorts, outPorts } from './types';

/** Values a net can take at gate level (Z reads as X). */
const VALS = [B0, B1, BX];
/** A table larger than this is not a small state machine. */
const MAX_STATES = 4096;
/** warm() explores at most this many states of one table. */
const MAX_WARM = 256;
/** An isolated settle longer than this is an oscillation: unsupported. */
const LIMIT = 64;
const NAND_T = new Uint8Array(16);
for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) NAND_T[(a << 2) | b] = a === B0 || b === B0 ? B1 : a === B1 && b === B1 ? B0 : BX;

export class FfTable {
  readonly def: ComponentDef;
  readonly flat: FlatDesign;
  /** Input bits in port order (all 1 bit): their nets in the isolated design; which one is the clock. */
  readonly inNets: number[];
  readonly clk: number;
  /** Output port bits: nets in the isolated design. */
  readonly outNets: number[];
  /** NAND leaves of the isolated design: a, b, y. */
  private readonly ga: Int32Array;
  private readonly gb: Int32Array;
  private readonly gy: Int32Array;
  private readonly scratch: Uint8Array;
  /** Interned settled states: every net's value in the isolated design. */
  readonly states: Uint8Array[] = [];
  /** outv[id * outNets.length + i]: output bit i in state id (grows: read it again after intern / step). */
  outv = new Uint8Array(0);
  /** clockv[id]: the clock input's value in state id (0 or 1). */
  clockv = new Uint8Array(0);
  private pairv = new Int32Array(0);
  private readonly ids = new Map<string, number>();
  /**
   * next[id * codes + code]: the state after the inputs change to `code` (base 3 over inputs, input i
   * weighs 3^i); −1 not computed yet (step() computes it), −2 unsupported. Grows: read it again after step().
   */
  next = new Int32Array(0);
  readonly codes: number;
  /** Per state: 0 not checked yet, 1 exact from here, 2 not (see good()). */
  private status = new Uint8Array(0);
  private readonly warmed = new Set<number>();

  private constructor(def: ComponentDef, flat: FlatDesign) {
    this.def = def;
    this.flat = flat;
    const ins = inPorts(def);
    this.inNets = ins.map((p) => flat.root.ports[p.name][0]);
    this.clk = ins.findIndex((p) => p.name === def.ff!.clk);
    this.outNets = outPorts(def).map((p) => flat.root.ports[p.name][0]);
    const L = flat.leaves.length;
    this.ga = new Int32Array(L);
    this.gb = new Int32Array(L);
    this.gy = new Int32Array(L);
    flat.leaves.forEach((l, i) => {
      this.ga[i] = l.inputs[0][0];
      this.gb[i] = l.inputs[1][0];
      this.gy[i] = l.outputs[0][0];
    });
    this.codes = 3 ** ins.length;
    this.scratch = new Uint8Array(L);
  }

  private static cache = new WeakMap<ComponentDef, FfTable | null>();

  /**
   * The table of a flip-flop definition, or null when it cannot be one: not marked `ff`, ports wider
   * than a bit, more than two data inputs, or anything but NANDs inside.
   */
  static of(def: ComponentDef): FfTable | null {
    let t = FfTable.cache.get(def);
    if (t !== undefined) return t;
    t = null;
    try {
      const ins = inPorts(def), outs = outPorts(def);
      const ok = !!def.ff && def.ports.every((p) => p.width === 1 && p.dir !== 'inout') && ins.length >= 2 && ins.length <= 3
        && ins.some((p) => p.name === def.ff!.clk) && outs.length >= 1;
      if (ok) {
        const flat = flatten(def);
        if (flat.leaves.every((l) => l.kind === 'nand')) t = new FfTable(def, flat);
      }
    } catch {
      t = null;
    }
    FfTable.cache.set(def, t);
    return t;
  }

  /** The input code of a state (base 3, input i weighs 3^i). */
  inputCode(s: Uint8Array): number {
    let c = 0;
    for (let i = this.inNets.length - 1; i >= 0; i--) c = c * 3 + Math.min(s[this.inNets[i]], BX);
    return c;
  }

  /**
   * The id of a settled state (every net's value in the isolated design); −1 when it is not
   * settled or its clock is not 0 / 1. Whether the table is exact from it is good()'s question.
   */
  intern(s: Uint8Array): number {
    const key = s.join('');
    const known = this.ids.get(key);
    if (known !== undefined) return known;
    const c = s[this.inNets[this.clk]];
    if ((c !== B0 && c !== B1) || !this.settled(s) || this.states.length >= MAX_STATES) return -1;
    return this.add(s);
  }

  /**
   * Is the table exact from this state on (see the header)? Checked by simulation the first time a
   * state is asked about, then remembered.
   */
  good(id: number): boolean {
    if (this.status[id] === 0) this.status[id] = this.verify(this.states[id]) ? 1 : 2;
    return this.status[id] === 1;
  }

  /**
   * Check ahead of time every state reachable from these with 0 / 1 inputs (a cycle engine loading
   * a design: the first frames of a run then meet no new state to check). Each state is explored
   * once per table; unknown values are still checked when they come.
   */
  warm(ids: Iterable<number>): void {
    const queue = [...ids].filter((id) => !this.warmed.has(id));
    const n = this.inNets.length;
    while (queue.length && this.warmed.size < MAX_WARM) {
      const id = queue.pop()!;
      if (this.warmed.has(id)) continue;
      this.warmed.add(id);
      if (!this.good(id)) continue;
      for (let bits = 0; bits < 2 ** n; bits++) {
        let code = 0;
        for (let i = n - 1; i >= 0; i--) code = code * 3 + ((bits >> i) & 1);
        const nx = this.step(id, code);
        if (nx >= 0 && !this.warmed.has(nx)) queue.push(nx);
      }
    }
  }

  /** The state after the inputs change to `code` (−2: unsupported, e.g. it oscillates). */
  step(id: number, code: number): number {
    const i = id * this.codes + code;
    let n = this.next[i];
    if (n !== -1) return n;
    const s = this.states[id].slice();
    n = this.run(s, this.codeInputs(code), []) >= 0 ? this.intern(s) : -1;
    if (n < 0) n = -2;
    this.next[i] = n;
    return n;
  }

  /** The state's value of output bit i. */
  out(id: number, i: number): number {
    return this.outv[id * this.outNets.length + i];
  }

  /**
   * The state a clock edge leads to when the next edge leads back here with the outputs unchanged
   * (−1: none). A flip-flop in such a pair ignores its clock until a data input changes: the cycle
   * engine then skips it at every edge and takes whichever of the two states the clock says.
   */
  partner(id: number): number {
    const p = this.pairv[id];
    if (p !== -3) return p;
    if (!this.good(id)) return (this.pairv[id] = -1);
    const s = this.states[id];
    const code = this.inputCode(s);
    const w = 3 ** this.clk;
    const a = this.step(id, s[this.inNets[this.clk]] === B0 ? code + w : code - w);
    let r = -1;
    if (a >= 0 && this.step(a, code) === id && this.good(a)) {
      const no = this.outNets.length;
      r = a;
      for (let i = 0; i < no; i++) if (this.outv[a * no + i] !== this.outv[id * no + i]) r = -1;
    }
    this.pairv[id] = r;
    return r;
  }

  // ---- internals -------------------------------------------------------------------------

  private codeInputs(code: number): number[] {
    const v: number[] = [];
    for (let i = 0; i < this.inNets.length; i++, code = Math.floor(code / 3)) v.push(VALS[code % 3]);
    return v;
  }

  private add(s: Uint8Array): number {
    const id = this.states.length;
    this.states.push(s);
    const no = this.outNets.length;
    if (this.outv.length < (id + 1) * no) {
      const g = new Uint8Array(Math.max(16, (id + 1) * 2) * no);
      g.set(this.outv);
      this.outv = g;
    }
    this.outNets.forEach((net, i) => { this.outv[id * no + i] = s[net]; });
    if (this.clockv.length <= id) {
      const c = new Uint8Array(Math.max(16, (id + 1) * 2));
      c.set(this.clockv);
      this.clockv = c;
      const p = new Int32Array(c.length).fill(-3);
      p.set(this.pairv);
      this.pairv = p;
    }
    if (this.status.length <= id) {
      const g = new Uint8Array(this.clockv.length);
      g.set(this.status);
      this.status = g;
    }
    this.clockv[id] = s[this.inNets[this.clk]];
    this.pairv[id] = -3;
    this.status[id] = 0;
    this.ids.set(s.join(''), id);
    if (this.next.length < this.states.length * this.codes) {
      const g = new Int32Array(Math.max(this.states.length * 2, 16) * this.codes).fill(-1);
      g.set(this.next);
      this.next = g;
    }
    return id;
  }

  /** Is s settled (every NAND agrees with its inputs)? */
  private settled(s: Uint8Array): boolean {
    for (let g = 0; g < this.gy.length; g++) if (s[this.gy[g]] !== NAND_T[(s[this.ga[g]] << 2) | s[this.gb[g]]]) return false;
    return true;
  }

  /**
   * Unit-delay simulation of the isolated flip-flop from s (in place): `inputs` applied at t = 0
   * (undefined: unchanged), then `later` changes [time, input, value] at their times. Exactly
   * GateSim: an input change is seen at its time, a NAND's output follows its inputs one delay
   * later. Returns the delays it took to settle, or −1 if it has not LIMIT delays after the last change.
   */
  private run(s: Uint8Array, inputs: (number | undefined)[], later: [number, number, number][]): number {
    const { ga, gb, gy, inNets } = this;
    inputs.forEach((v, i) => { if (v !== undefined) s[inNets[i]] = v; });
    const last = later.reduce((m, e) => Math.max(m, e[0]), 0);
    const nxt = this.scratch;
    for (let t = 0; t <= last + LIMIT; t++) {
      if (t > 0) for (const [at, i, v] of later) if (at === t) s[inNets[i]] = v;
      let changed = false;
      for (let g = 0; g < gy.length; g++) {
        nxt[g] = NAND_T[(s[ga[g]] << 2) | s[gb[g]]];
        if (nxt[g] !== s[gy[g]]) changed = true;
      }
      if (!changed && t >= last) return t;
      for (let g = 0; g < gy.length; g++) s[gy[g]] = nxt[g];
    }
    return -1;
  }

  /** Same-state test of two value vectors. */
  private static same(a: Uint8Array, b: Uint8Array): boolean {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  /**
   * From settled state s: for each clock value (an edge, or none), every change of one data input
   * and of two, arriving at any delay after the edge up to past the settling time K, and every
   * pulse on one input, must end where the table says (the change applied after everything settled),
   * and no data change may move an output while the clock is steady.
   */
  private verify(s: Uint8Array): boolean {
    const n = this.inNets.length;
    const data = Array.from({ length: n }, (_, i) => i).filter((i) => i !== this.clk);
    for (const c of [B0, B1]) {
      const s1 = s.slice();
      const clkIn: (number | undefined)[] = new Array(n).fill(undefined);
      clkIn[this.clk] = c;
      let tmax = this.run(s1, clkIn, []);
      if (tmax < 0) return false;
      const singles: [number, number, Uint8Array][] = [];
      for (const i of data) {
        for (const v of VALS) {
          if (v === s1[this.inNets[i]]) continue;
          const e = s1.slice();
          const one: (number | undefined)[] = new Array(n).fill(undefined);
          one[i] = v;
          const t = this.run(e, one, []);
          if (t < 0) return false;
          // edge-triggered: outputs do not follow data while the clock is steady
          for (const net of this.outNets) if (e[net] !== s1[net]) return false;
          singles.push([i, v, e]);
          tmax = Math.max(tmax, t);
        }
      }
      // past K a change meets a settled flip-flop: what the table does
      const K = tmax + 2;
      for (const [i, v, e] of singles) {
        for (let k = 1; k <= K; k++) {
          const a = s.slice();
          if (this.run(a, clkIn, [[k, i, v]]) < 0 || !FfTable.same(a, e)) return false;
          // a pulse: the state the edge left survives it
          for (let w = 1; w <= K; w++) {
            const p = s.slice();
            if (this.run(p, clkIn, [[k, i, v], [k + w, i, s1[this.inNets[i]]]]) < 0 || !FfTable.same(p, s1)) return false;
          }
        }
      }
      if (data.length === 2) {
        const [i, j] = data;
        for (const vi of VALS) for (const vj of VALS) {
          if (vi === s1[this.inNets[i]] || vj === s1[this.inNets[j]]) continue;
          const e = s1.slice();
          const both: (number | undefined)[] = new Array(n).fill(undefined);
          both[i] = vi;
          both[j] = vj;
          if (this.run(e, both, []) < 0) return false;
          for (let ki = 1; ki <= K; ki++) for (let kj = 1; kj <= K; kj++) {
            const a = s.slice();
            if (this.run(a, clkIn, [[ki, i, vi], [kj, j, vj]]) < 0 || !FfTable.same(a, e)) return false;
          }
        }
      }
    }
    return true;
  }
}
