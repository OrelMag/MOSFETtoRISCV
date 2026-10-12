// Storage as tables, for the cycle engine (cyclesim.ts). A flip-flop is a dozen NANDs that every
// clock edge toggles inside, which is most of the work of simulating a CPU. Its settled response
// is a small state machine: given the settled values of its nets and new input values, gate-level
// simulation of it alone (unit delays, exactly GateSim's semantics) gives the next settled values.
// FfTable tabulates that over the states it meets, so the cycle engine looks a transition up
// instead of evaluating gates, and still knows the value of every internal net.
//
// A table describes a cluster of NANDs (clusters.ts finds them: the library's flip-flops, one
// drawn from NANDs, a latch with a reset) and how its inputs arrive (its Profile). A *timed*
// input follows a pin of the chip: the pin itself, or the pin through k inverters, so it changes
// exactly k delays after the pin; inputs that follow one pin form a group (a clock and its
// inverse), and one group may be the clock (partner() pairs states over its toggles). A *data*
// input comes from logic: it changes no sooner than `early` delays after the pins, at a time the
// table does not know, maybe several times (glitches).
//
// A table is exact inside a whole circuit only if it does not care when, after that, its data
// inputs change, nor about glitches on them, and if its outputs never follow a data input while
// the pins hold (they can then be computed at the instant the pins change, and logic reading them
// has no loop through the table). good() checks all of that by simulation, state by state as
// states are met: every combination of pin changes, then each data input changing at every delay
// from `early` to past the settling time, pulses of every width, pairs of inputs in any order; and
// the cycle engine hands a cluster in a refused state to GateSim, with the reason (why()). warm()
// checks ahead the states 0 / 1 inputs reach, so a run meets no new state in its first frames.

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
/** Inputs of one table at most (3^5 input codes per state). */
export const MAX_IN = 5;
const NAND_T = new Uint8Array(16);
for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) NAND_T[(a << 2) | b] = a === B0 || b === B0 ? B1 : a === B1 && b === B1 ? B0 : BX;

/** Input kinds in Profile.group besides a group index. */
export const DATA = -1;
/** A data input that never changes (a constant). */
export const CONST = -2;

/** How the inputs of a table arrive (see the header). */
export interface Profile {
  /** Per input: its timing group (≥ 0), DATA or CONST. Groups are numbered from 0 in order of first input. */
  group: number[];
  /** Per input: delays after its pin changes (timed inputs; 0 for data). */
  delay: number[];
  /** Per input: 1 when it is its pin inverted (timed inputs; 0 for data). */
  parity: number[];
  /** The clock's group (its value must be 0 / 1 in every state), or −1. */
  primary: number;
  /** Data inputs change no sooner than this many delays after the pins change (≥ 1). */
  early: number;
}

/** A cluster to tabulate: NANDs over local nets, its inputs and outputs (local), their timing. */
export interface TableSpec {
  /** a, b, y of each NAND, local net numbers. */
  gates: ArrayLike<number>;
  netCount: number;
  ins: number[];
  outs: number[];
  profile: Profile;
  /** Input names, for messages. */
  names?: string[];
}

export class FfTable {
  readonly netCount: number;
  /** Input nets (local). */
  readonly inNets: number[];
  readonly profile: Profile;
  readonly groups: number;
  /** Inputs of each group. */
  readonly groupIns: number[][];
  /** Data inputs (constants excluded). */
  private readonly dataIns: number[];
  /** Output nets (local): those read outside the cluster. */
  readonly outNets: number[];
  readonly names: string[];
  /** NAND leaves: a, b, y. */
  private readonly ga: Int32Array;
  private readonly gb: Int32Array;
  private readonly gy: Int32Array;
  private readonly scratch: Uint8Array;
  /** Interned settled states: every net's value in the cluster. */
  readonly states: Uint8Array[] = [];
  /** outv[id * outNets.length + i]: output bit i in state id (grows: read it again after intern / step). */
  outv = new Uint8Array(0);
  /** clockv[id]: the clock's pin value in state id (0 or 1; 0 without a clock). */
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
  private readonly whyNot = new Map<number, string>();
  private readonly warmed = new Set<number>();

  constructor(spec: TableSpec) {
    const p = spec.profile;
    this.netCount = spec.netCount;
    this.inNets = spec.ins.slice();
    this.outNets = spec.outs.slice();
    this.profile = p;
    this.names = spec.names ?? spec.ins.map((_, i) => `input ${i}`);
    this.groups = p.group.reduce((m, g) => Math.max(m, g + 1), 0);
    this.groupIns = Array.from({ length: this.groups }, (_, g) => p.group.flatMap((x, i) => (x === g ? [i] : [])));
    this.dataIns = p.group.flatMap((x, i) => (x === DATA ? [i] : []));
    const G = spec.gates.length / 3;
    this.ga = new Int32Array(G);
    this.gb = new Int32Array(G);
    this.gy = new Int32Array(G);
    for (let i = 0; i < G; i++) {
      this.ga[i] = spec.gates[3 * i];
      this.gb[i] = spec.gates[3 * i + 1];
      this.gy[i] = spec.gates[3 * i + 2];
    }
    this.codes = 3 ** this.inNets.length;
    this.scratch = new Uint8Array(G);
  }

  private static cache = new WeakMap<ComponentDef, (FfTable & { flat: FlatDesign }) | null>();

  /**
   * The table of a flip-flop definition on its own (its clock a pin, the other inputs data), or
   * null when it cannot be one: not marked `ff`, ports wider than a bit, too many inputs, or
   * anything but NANDs inside. For tests and tools; the cycle engine finds clusters structurally.
   */
  static of(def: ComponentDef): (FfTable & { flat: FlatDesign }) | null {
    let t = FfTable.cache.get(def);
    if (t !== undefined) return t;
    t = null;
    try {
      const ins = inPorts(def), outs = outPorts(def);
      const ok = !!def.ff && def.ports.every((p) => p.width === 1 && p.dir !== 'inout') && ins.length >= 1 && ins.length <= MAX_IN
        && ins.some((p) => p.name === def.ff!.clk) && outs.length >= 1;
      if (ok) {
        const flat = flatten(def);
        if (flat.leaves.every((l) => l.kind === 'nand')) {
          const gates = flat.leaves.flatMap((l) => [l.inputs[0][0], l.inputs[1][0], l.outputs[0][0]]);
          const clk = ins.map((p) => p.name === def.ff!.clk);
          const table = new FfTable({
            gates, netCount: flat.netCount, ins: ins.map((p) => flat.root.ports[p.name][0]), outs: outs.map((p) => flat.root.ports[p.name][0]),
            profile: { group: clk.map((c) => (c ? 0 : DATA)), delay: clk.map(() => 0), parity: clk.map(() => 0), primary: 0, early: 1 },
            names: ins.map((p) => p.name),
          });
          t = Object.assign(table, { flat });
        }
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
   * The id of a settled state (every net's value in the cluster); −1 when it is not settled, its
   * clock is not 0 / 1, or the inputs of one group disagree. Whether the table is exact from it is
   * good()'s question.
   */
  intern(s: Uint8Array): number {
    const key = s.join('');
    const known = this.ids.get(key);
    if (known !== undefined) return known;
    if (!this.consistent(s) || !this.settled(s) || this.states.length >= MAX_STATES) return -1;
    return this.add(s);
  }

  /** Why intern() refuses a state ('' if it would not). */
  refusal(s: Uint8Array): string {
    if (this.ids.has(s.join(''))) return '';
    if (!this.consistent(s)) return 'its clock is not 0 or 1';
    if (!this.settled(s)) return 'it is not settled (an oscillation)';
    return this.states.length >= MAX_STATES ? `more than ${MAX_STATES} states` : '';
  }

  /**
   * Is the table exact from this state on (see the header)? Checked by simulation the first time a
   * state is asked about, then remembered.
   */
  good(id: number): boolean {
    if (this.status[id] === 0) {
      const why = this.verify(this.states[id]);
      this.status[id] = why === null ? 1 : 2;
      if (why !== null) this.whyNot.set(id, why);
    }
    return this.status[id] === 1;
  }

  /** Why a state is not good (after good() said so). */
  why(id: number): string {
    return this.whyNot.get(id) ?? '';
  }

  /**
   * Check ahead of time every state reachable from these with 0 / 1 inputs (a cycle engine loading
   * a design: the first frames of a run then meet no new state to check). Each state is explored
   * once per table; unknown values are still checked when they come.
   */
  warm(ids: Iterable<number>): void {
    const queue = [...ids].filter((id) => !this.warmed.has(id));
    const n = this.inNets.length, { group, parity } = this.profile;
    const dataBit = new Map(this.dataIns.map((i, k) => [i, this.groups + k]));
    const free = this.groups + this.dataIns.length;
    while (queue.length && this.warmed.size < MAX_WARM) {
      const id = queue.pop()!;
      if (this.warmed.has(id)) continue;
      this.warmed.add(id);
      if (!this.good(id)) continue;
      const s = this.states[id];
      for (let bits = 0; bits < 2 ** free; bits++) {
        let code = 0;
        for (let i = n - 1; i >= 0; i--) {
          const g = group[i];
          const v = g >= 0 ? ((bits >> g) & 1) ^ parity[i] : g === DATA ? (bits >> dataBit.get(i)!) & 1 : Math.min(s[this.inNets[i]], BX);
          code = code * 3 + v;
        }
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
    const now: (number | undefined)[] = [], later: [number, number, number][] = [];
    const { group, delay } = this.profile;
    this.codeInputs(code).forEach((v, k) => {
      if (v === s[this.inNets[k]]) return;
      if (group[k] >= 0 && delay[k] > 0) later.push([delay[k], k, v]);
      else now[k] = v;
    });
    n = this.run(s, now, later) >= 0 ? this.intern(s) : -1;
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
   * (−1: none). A cluster in such a pair ignores its clock until another input changes: the cycle
   * engine then skips it at every edge and takes whichever of the two states the clock says.
   */
  partner(id: number): number {
    const p = this.pairv[id];
    if (p !== -3) return p;
    const pg = this.profile.primary;
    if (pg < 0 || !this.good(id)) return (this.pairv[id] = -1);
    const s = this.states[id];
    const code = this.inputCode(s);
    let flipped = code;
    for (const k of this.groupIns[pg]) flipped += (s[this.inNets[k]] === B0 ? 1 : -1) * 3 ** k;
    const a = this.step(id, flipped);
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

  /** The pin value of group g in state s (BX if its inputs are X). */
  private pinOf(s: Uint8Array, g: number): number {
    const k = this.groupIns[g][0], v = s[this.inNets[k]];
    return v > B1 ? BX : v ^ this.profile.parity[k];
  }

  /** The inputs of each group agree on their pin, and the clock's pin is 0 / 1. */
  private consistent(s: Uint8Array): boolean {
    const { parity, primary } = this.profile;
    for (let g = 0; g < this.groups; g++) {
      const pin = this.pinOf(s, g);
      if (g === primary && pin > B1) return false;
      for (const k of this.groupIns[g]) {
        const v = s[this.inNets[k]];
        if ((v > B1 ? BX : v ^ parity[k]) !== pin) return false;
      }
    }
    return true;
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
    this.clockv[id] = this.profile.primary >= 0 ? this.pinOf(s, this.profile.primary) : 0;
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
   * Unit-delay simulation of the cluster alone from s (in place): `inputs` applied at t = 0
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

  /** The pin changes of combination m (mixed radix over groups: 0 keeps, else another value; the clock only flips). */
  private changes(s: Uint8Array, m: number, radix: number[]): { now: (number | undefined)[]; later: [number, number, number][]; moved: string[] } {
    const { delay, parity, primary } = this.profile;
    const now: (number | undefined)[] = new Array(this.inNets.length).fill(undefined), later: [number, number, number][] = [];
    const moved: string[] = [];
    for (let g = 0; g < this.groups; g++) {
      const d = m % radix[g];
      m = Math.floor(m / radix[g]);
      if (d === 0) continue;
      const pin = this.pinOf(s, g);
      const to = g === primary ? 1 - pin : VALS.filter((v) => v !== pin)[d - 1];
      moved.push(this.names[this.groupIns[g][0]]);
      for (const k of this.groupIns[g]) {
        const v = to > B1 ? BX : to ^ parity[k];
        if (delay[k] > 0) later.push([delay[k], k, v]);
        else now[k] = v;
      }
    }
    return { now, later, moved };
  }

  /**
   * From settled state s, for every combination of pin changes (each group keeps its value or
   * takes another; the clock only 0 / 1), each at its delay: the cluster must settle; no data
   * change may then move an output; and every change of one data input or of two, arriving at any
   * time from `early` to past the settling time K, and every pulse on one input, must end where
   * the table says (the change applied after everything settled). Null if so, else why not.
   */
  private verify(s: Uint8Array): string | null {
    const n = this.inNets.length, { primary, early } = this.profile;
    const data = this.dataIns, inNets = this.inNets, names = this.names;
    const radix = Array.from({ length: this.groups }, (_, g) => (g === primary ? 2 : 3));
    const combos = radix.reduce((a, r) => a * r, 1);
    for (let m = 0; m < combos; m++) {
      const { now, later, moved } = this.changes(s, m, radix);
      const what = moved.length ? `after ${moved.join(' and ')} change${moved.length > 1 ? '' : 's'}` : 'while its pins hold';
      const s1 = s.slice();
      let tmax = this.run(s1, now, later);
      // no settled state (a race, an oscillation): step() says so, and the cycle engine hands that settle to GateSim
      if (tmax < 0) continue;
      const singles: [number, number, Uint8Array][] = [];
      for (const i of data) {
        for (const v of VALS) {
          if (v === s1[inNets[i]]) continue;
          const e = s1.slice();
          const one: (number | undefined)[] = new Array(n).fill(undefined);
          one[i] = v;
          const t = this.run(e, one, []);
          if (t < 0) return `no settled state when ${names[i]} changes (an oscillation)`;
          // edge-triggered: outputs do not follow data while the pins hold
          for (const net of this.outNets) {
            if (e[net] !== s1[net]) return `its output follows ${names[i]} while its clock holds (a latch, or a clock made by logic or by another flip-flop)`;
          }
          singles.push([i, v, e]);
          tmax = Math.max(tmax, t);
        }
      }
      // Past K a change meets a settled cluster: what the table does. With no pin change nothing
      // happens before the first data change, so only the times relative to it matter.
      const K = tmax + 2, hi = m === 0 ? early : Math.max(early, K);
      for (const [i, v, e] of singles) {
        for (let k = early; k <= hi; k++) {
          const a = s.slice();
          if (this.run(a, now, [...later, [k, i, v]]) < 0 || !FfTable.same(a, e)) return `${names[i]} changing ${k} delays ${what} ends elsewhere than later (not edge-triggered)`;
          // a pulse: the state the pins left survives it
          for (let w = 1; w <= K; w++) {
            const p = s.slice();
            if (this.run(p, now, [...later, [k, i, v], [k + w, i, s1[inNets[i]]]]) < 0 || !FfTable.same(p, s1)) return `a glitch on ${names[i]} ${what} leaves a trace`;
          }
        }
      }
      const top = Math.max(early, K);
      for (let x = 0; x < data.length; x++) for (let y = x + 1; y < data.length; y++) {
        const i = data[x], j = data[y];
        for (const vi of VALS) for (const vj of VALS) {
          if (vi === s1[inNets[i]] || vj === s1[inNets[j]]) continue;
          const e = s1.slice();
          const both: (number | undefined)[] = new Array(n).fill(undefined);
          both[i] = vi;
          both[j] = vj;
          if (this.run(e, both, []) < 0) return `no settled state when ${names[i]} and ${names[j]} change (an oscillation)`;
          for (let ki = early; ki <= top; ki++) for (let kj = early; kj <= top; kj++) {
            if (m === 0 && ki !== early && kj !== early) continue;
            const a = s.slice();
            if (this.run(a, now, [...later, [ki, i, vi], [kj, j, vj]]) < 0 || !FfTable.same(a, e)) return `${names[i]} and ${names[j]} changing in another order ${what} end elsewhere`;
          }
        }
      }
    }
    return null;
  }
}
