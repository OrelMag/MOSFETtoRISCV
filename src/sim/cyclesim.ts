// The cycle engine: settled values without gate timing, for running big synchronous circuits (a
// CPU in the sandbox) many times faster than the event-driven GateSim, with the same result.
//
// Flip-flops (definitions marked `ff` that FfTable can tabulate, e.g. the library DFF / DFFE) become
// table lookups: no gate inside them is evaluated, yet every internal net still has its value. The
// rest of the circuit must then be acyclic; it is levelized, and a settle evaluates each gate or
// behavioural leaf whose inputs changed once, in level order (zero delay: no glitches).
//
// A settle has two phases, mirroring what GateSim does at the instant inputs change: first every
// flip-flop and behavioural leaf that reads a changed root input (a clock edge) or was poked takes
// its next state from the values *before* anything reacts (in GateSim nothing caused by an edge
// reaches a flip-flop sooner than one gate delay later, when its master latch has closed: FfTable
// checks that the flip-flop does not mind); then the changes propagate through the levelized logic.
// The settled values equal GateSim's when: every flip-flop's clock is a root input pin, no
// behavioural leaf reads a signal derived from a clock by logic, the remaining logic has no loop,
// and stateful behavioural leaves change their state only on a clock transition (as the sandbox's
// RAMs do). build() refuses a design that breaks the structural conditions, and settle() returns
// false, changing nothing, when a flip-flop would see a clock that is not 0 / 1 or a transition its
// table cannot vouch for: the caller (DualSim) then hands that settle to GateSim.
// tests/cyclesim.test.ts compares every net with GateSim after every cycle on the CPUs.

import type { FlatDesign, HierNode } from './flatten';
import { FfTable } from './ffmacro';
import { cloneState, GateSim } from './gatesim';
import type { PowerOnMode, Sim, SimState } from './sim';
import { B0, B1, BX, BZ, type Bit, inPorts, outPorts } from './types';
import { pack, unpack } from './values';

const NAND_T = new Uint8Array(16);
for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) NAND_T[(a << 2) | b] = a === B0 || b === B0 ? B1 : a === B1 && b === B1 ? B0 : BX;

/** A tabulated flip-flop instance: its table, its input nets (port order), output nets, and its nets in the table's numbering. */
interface Macro {
  table: FfTable;
  node: HierNode;
  ins: number[];
  outs: number[];
  /** Big-design net of each isolated net (−1: none). */
  netOf: Int32Array;
}

export class CycleSim implements Sim {
  readonly kind = 'gate' as const;
  readonly design: FlatDesign;
  time = 0;
  readonly unstable = false;
  evaluations = 0;
  onTrace?: (net: number, value: Bit, time: number) => void;

  private val: Uint8Array;
  private watched: Uint8Array;
  /** Nodes: gates [0, G), behavioural leaves [G, G + B), flip-flops [G + B, N). */
  private G: number;
  private B: number;
  private ga: Int32Array;
  private gb: Int32Array;
  private gy: Int32Array;
  /** Behavioural node → design leaf, and back (−1: not a behavioural node). */
  private bLeaf: Int32Array;
  private bNode: Int32Array;
  private macros: Macro[];
  /** Flip-flops as flat arrays: table, input nets (3 per flip-flop, port order), which input is the clock, outputs (CSR), state. */
  private tabs: FfTable[] = [];
  private mTab: Uint8Array;
  private mIn: Int32Array;
  private mNin: Uint8Array;
  private mClk: Uint8Array;
  private mOutStart: Int32Array;
  private mOutList: Int32Array;
  private mstate: Int32Array;
  /**
   * Clocks: each distinct clock net is a slot. A flip-flop whose state is one of a clock pair
   * (FfTable.partner) is *stable*: edges cannot change its outputs, so it is skipped and its state
   * read from the clock's value. The others are *active*, listed per clock slot (actPos: index in
   * the list, −1 when stable) and stepped at every edge of their clock.
   */
  private clockSlot: Int32Array;
  private clockNet: number[] = [];
  private mSlot: Int32Array;
  private actList: Int32Array[];
  private actLen: Int32Array;
  private actPos: Int32Array;
  /** Internal nets of flip-flops: which flip-flop, which net of its table (−1: not internal). */
  private macroOf: Int32Array;
  private isoOf: Int32Array;
  private level: Int32Array;
  private maxLevel: number;
  /** Net → reader nodes (CSR); a flip-flop reads its data inputs here, its clock through the slots. */
  private fanStart: Int32Array;
  private fanList: Int32Array;
  /** Phase-2 buckets: a linked list per level. */
  private head: Int32Array;
  private link: Int32Array;
  private queued: Uint8Array;
  /** Phase 2: the level being swept (−1 outside it), and the lowest level queued behind it. */
  private at = -1;
  private behind = Infinity;
  /** Phase 1: nodes to evaluate on the values of the instant (readers of changed root inputs, poked leaves, active flip-flops). */
  private snap: number[] = [];
  private snapMark: Uint8Array;
  /** Root nets changed since the last settle, with their values before; clock slots that changed; poked leaves. */
  private changedNets: number[] = [];
  private changedMark: Uint8Array;
  private prevVal: Uint8Array;
  private changedClocks: number[] = [];
  private clockChanged: Uint8Array;
  private poked: number[] = [];
  /** Phase-1 scratch: flip-flops and their next states. */
  private mBuf: Int32Array;
  private nBuf: Int32Array;
  /** Flip-flops a settle moved; and whether one landed in a state its table cannot vouch for from there on. */
  private moved: number[] = [];
  /**
   * The last settle was exact, but left a flip-flop in a state from which its table is not
   * (FfTable.good): the next settle must be GateSim's (DualSim hands over).
   */
  tainted = false;
  private state: unknown[];
  private inputs = new Map<string, number | Bit[]>();
  private inputNets = new Map<string, number[]>();

  private constructor(design: FlatDesign, macros: Macro[], gates: number[], behaviors: number[], level: Int32Array, maxLevel: number) {
    this.design = design;
    const n = design.netCount;
    const leaves = design.leaves;
    this.val = new Uint8Array(n).fill(BX);
    this.watched = new Uint8Array(n);
    const G = (this.G = gates.length), B = (this.B = behaviors.length), M = macros.length, N = G + B + M;
    this.macros = macros;
    this.ga = Int32Array.from(gates, (li) => leaves[li].inputs[0][0]);
    this.gb = Int32Array.from(gates, (li) => leaves[li].inputs[1][0]);
    this.gy = Int32Array.from(gates, (li) => leaves[li].outputs[0][0]);
    this.bLeaf = Int32Array.from(behaviors);
    this.bNode = new Int32Array(leaves.length).fill(-1);
    behaviors.forEach((li, i) => { this.bNode[li] = G + i; });

    this.mstate = new Int32Array(M);
    this.mTab = new Uint8Array(M);
    this.mIn = new Int32Array(3 * M).fill(-1);
    this.mNin = new Uint8Array(M);
    this.mClk = new Uint8Array(M);
    this.mOutStart = new Int32Array(M + 1);
    this.mBuf = new Int32Array(M);
    this.nBuf = new Int32Array(M);
    this.clockSlot = new Int32Array(n).fill(-1);
    this.mSlot = new Int32Array(M);
    this.actPos = new Int32Array(M).fill(-1);
    const outs: number[] = [], perSlot: number[] = [];
    macros.forEach((m, mi) => {
      let t = this.tabs.indexOf(m.table);
      if (t < 0) t = this.tabs.push(m.table) - 1;
      this.mTab[mi] = t;
      m.ins.forEach((net, i) => { this.mIn[3 * mi + i] = net; });
      this.mNin[mi] = m.ins.length;
      this.mClk[mi] = m.table.clk;
      this.mOutStart[mi] = outs.length;
      outs.push(...m.outs);
      const clk = m.ins[m.table.clk];
      if (this.clockSlot[clk] < 0) { this.clockSlot[clk] = perSlot.length; perSlot.push(0); this.clockNet.push(clk); }
      this.mSlot[mi] = this.clockSlot[clk];
      perSlot[this.mSlot[mi]]++;
    });
    this.mOutStart[M] = outs.length;
    this.mOutList = Int32Array.from(outs);
    this.actList = perSlot.map((k) => new Int32Array(k));
    this.actLen = new Int32Array(perSlot.length);
    this.clockChanged = new Uint8Array(perSlot.length);

    this.macroOf = new Int32Array(n).fill(-1);
    this.isoOf = new Int32Array(n).fill(-1);
    macros.forEach((m, mi) => {
      const ports = new Set([...m.ins, ...m.outs]);
      m.netOf.forEach((net, iso) => {
        if (net >= 0 && !ports.has(net)) { this.macroOf[net] = mi; this.isoOf[net] = iso; }
      });
    });
    this.level = level;
    this.maxLevel = maxLevel;
    this.head = new Int32Array(maxLevel + 1).fill(-1);
    this.link = new Int32Array(N);
    this.queued = new Uint8Array(N);
    this.snapMark = new Uint8Array(N);
    this.changedMark = new Uint8Array(n);
    this.prevVal = new Uint8Array(n);
    this.state = new Array(leaves.length);

    // readers of every net (each node once per net)
    const ins = (k: number): number[] => {
      if (k < G) return [this.ga[k], this.gb[k]];
      if (k < G + B) return leaves[this.bLeaf[k - G]].inputs.flat();
      const m = macros[k - G - B];
      return m.ins.filter((_, i) => i !== m.table.clk);
    };
    const counts = new Int32Array(n + 1);
    const seen = new Int32Array(n).fill(-1);
    const each = (f: (net: number, k: number) => void): void => {
      seen.fill(-1);
      for (let k = 0; k < N; k++) for (const net of ins(k)) if (seen[net] !== k) { seen[net] = k; f(net, k); }
    };
    each((net) => { counts[net + 1]++; });
    for (let i = 0; i < n; i++) counts[i + 1] += counts[i];
    this.fanStart = counts;
    this.fanList = new Int32Array(counts[n]);
    const fill = counts.slice(0, n);
    each((net, k) => { this.fanList[fill[net]++] = k; });
    for (const p of design.root.def.ports) {
      if (p.dir !== 'in') continue;
      this.inputNets.set(p.name, design.root.ports[p.name]);
      this.inputs.set(p.name, 0);
    }
  }

  /**
   * The cycle engine for a design, or why there cannot be one. Nothing is loaded: call load() with
   * a settled simulation (GateSim) of the same design first.
   */
  static build(design: FlatDesign): CycleSim | { reason: string } {
    const leaves = design.leaves;
    const n = design.netCount;
    const inMacro = new Int32Array(leaves.length).fill(-1);
    const macros: Macro[] = [];
    const rootIn = new Uint8Array(n);
    for (const p of design.root.def.ports) if (p.dir === 'in') for (const net of design.root.ports[p.name]) rootIn[net] = 1;

    // readers of each net among the design's leaves, to check a flip-flop's insides stay inside
    const rdStart = new Int32Array(n + 1);
    for (const l of leaves) for (const p of l.inputs) for (const net of p) rdStart[net + 1]++;
    for (let i = 0; i < n; i++) rdStart[i + 1] += rdStart[i];
    const rdList = new Int32Array(rdStart[n]);
    {
      const at = rdStart.slice(0, n);
      leaves.forEach((l, li) => { for (const p of l.inputs) for (const net of p) rdList[at[net]++] = li; });
    }

    const leafRange = (node: HierNode): [number, number] | null => {
      let lo = Infinity, hi = -1;
      const walk = (x: HierNode): void => {
        if (x.leafIndex !== undefined) { lo = Math.min(lo, x.leafIndex); hi = Math.max(hi, x.leafIndex); }
        x.children?.forEach(walk);
      };
      walk(node);
      return hi < 0 ? null : [lo, hi];
    };
    const tryMacro = (node: HierNode): boolean => {
      const t = node.def.ff && node.expanded ? FfTable.of(node.def) : null;
      if (!t) return false;
      const r = leafRange(node);
      const iso = t.flat.leaves;
      if (!r || r[1] - r[0] + 1 !== iso.length) return false;
      const netOf = new Int32Array(t.flat.netCount).fill(-1);
      const bind = (a: number, b: number): boolean => {
        if (netOf[a] >= 0 && netOf[a] !== b) return false;
        netOf[a] = b;
        return true;
      };
      for (let k = 0; k < iso.length; k++) {
        const big = leaves[r[0] + k], small = iso[k];
        if (big.kind !== 'nand' || big.def !== small.def) return false;
        if (!bind(small.inputs[0][0], big.inputs[0][0]) || !bind(small.inputs[1][0], big.inputs[1][0]) || !bind(small.outputs[0][0], big.outputs[0][0])) return false;
      }
      for (const p of node.def.ports) if (!bind(t.flat.root.ports[p.name][0], node.ports[p.name][0])) return false;
      // two nets of the table on one net of the design (a port tied to another): not the table's flip-flop
      const seen = new Set<number>();
      for (const b of netOf) { if (b >= 0 && seen.has(b)) return false; seen.add(b); }
      const ins = t.inNets.map((x) => netOf[x]);
      const outs = t.outNets.map((x) => netOf[x]);
      const ports = new Set([...ins, ...outs]);
      // nothing outside may read a net inside (only its outputs)
      for (const b of netOf) {
        if (b < 0 || ports.has(b)) continue;
        for (let i = rdStart[b]; i < rdStart[b + 1]; i++) if (rdList[i] < r[0] || rdList[i] > r[1]) return false;
      }
      const mi = macros.length;
      macros.push({ table: t, node, ins, outs, netOf });
      for (let li = r[0]; li <= r[1]; li++) inMacro[li] = mi;
      return true;
    };
    const visit = (node: HierNode): void => {
      if (node !== design.root && tryMacro(node)) return;
      node.children?.forEach(visit);
    };
    visit(design.root);

    // every flip-flop's clock straight from a root input pin
    for (const m of macros) {
      const clk = m.ins[m.table.clk];
      if (!rootIn[clk]) return { reason: `${m.node.path.join('.')}: its clock is not a pin of the chip (a derived or gated clock)` };
    }

    const gates: number[] = [], behaviors: number[] = [];
    leaves.forEach((l, li) => {
      if (inMacro[li] >= 0) return;
      if (l.kind === 'nand') gates.push(li);
      else if (l.kind === 'behavior') behaviors.push(li);
    });
    if (gates.length + behaviors.length + macros.reduce((s, m) => s + m.table.flat.leaves.length, 0) !== leaves.length) {
      return { reason: 'switch-level parts' };
    }

    // Levels over gates and behaviours; flip-flop outputs, root inputs and constants are sources.
    const G = gates.length, B = behaviors.length, M = macros.length, N = G + B + M;
    // A storage behaviour (Behavior.seq, a large RAM) is like a flip-flop: its outputs follow only
    // its comb inputs (and its state), so only those order it; the others are sinks.
    const seqClk = (li: number): number[] | null => {
      const q = leaves[li].def.behavior?.seq;
      if (!q) return null;
      const ps = inPorts(leaves[li].def), i = ps.findIndex((p) => p.name === q.clk);
      return i < 0 ? null : leaves[li].inputs[i];
    };
    const combIns = (li: number): number[] => {
      const l = leaves[li], q = l.def.behavior?.seq;
      if (!q) return l.inputs.flat();
      return inPorts(l.def).flatMap((p, i) => (q.comb.includes(p.name) ? l.inputs[i] : []));
    };
    for (const li of behaviors) {
      const c = seqClk(li);
      if (c && !c.every((net) => rootIn[net])) return { reason: `${leaves[li].node.path.join('.')}: its clock is not a pin of the chip (a derived or gated clock)` };
    }
    const nodeIns = (k: number): number[] => (k < G ? leaves[gates[k]].inputs.flat() : k < G + B ? combIns(behaviors[k - G]) : macros[k - G - B].ins.filter((_, i) => i !== macros[k - G - B].table.clk));
    const nodeOuts = (k: number): number[] => (k < G ? leaves[gates[k]].outputs.flat() : k < G + B ? leaves[behaviors[k - G]].outputs.flat() : []);
    const driver = new Int32Array(n).fill(-1);
    for (let k = 0; k < G + B; k++) for (const net of nodeOuts(k)) driver[net] = k;
    const level = new Int32Array(N);
    const indeg = new Int32Array(N);
    // fan-out of driven nets to the nodes ordered by them (CSR)
    const ins: number[][] = Array.from({ length: N }, (_, k) => nodeIns(k));
    const fStart = new Int32Array(n + 1);
    for (let k = 0; k < N; k++) for (const net of ins[k]) if (driver[net] >= 0) { indeg[k]++; fStart[net + 1]++; }
    for (let i = 0; i < n; i++) fStart[i + 1] += fStart[i];
    const fList = new Int32Array(fStart[n]);
    {
      const at = fStart.slice(0, n);
      for (let k = 0; k < N; k++) for (const net of ins[k]) if (driver[net] >= 0) fList[at[net]++] = k;
    }
    const queue: number[] = [];
    for (let k = 0; k < N; k++) if (indeg[k] === 0) queue.push(k);
    let done = 0, maxLevel = 0;
    for (let h = 0; h < queue.length; h++) {
      const k = queue[h];
      done++;
      if (level[k] > maxLevel) maxLevel = level[k];
      for (const net of nodeOuts(k)) {
        for (let i = fStart[net]; i < fStart[net + 1]; i++) {
          const c = fList[i];
          if (level[c] < level[k] + 1) level[c] = level[k] + 1;
          if (--indeg[c] === 0) queue.push(c);
        }
      }
    }
    if (done < N) {
      const k = indeg.findIndex((d) => d > 0);
      const l = k < G ? leaves[gates[k]] : k < G + B ? leaves[behaviors[k - G]] : null;
      return { reason: `a loop that is not a flip-flop${l ? ` (through ${l.node.path.join('.')})` : ''}: a latch, or a flip-flop built by hand` };
    }

    // no behavioural leaf may read a signal the clock reaches through logic (it would see the edge late)
    const clocks = new Set(macros.map((m) => m.ins[m.table.clk]));
    const derived = new Uint8Array(n);
    // (clocks: the flip-flops', the storage behaviours' and the pins marked as clocks)
    for (const li of behaviors) for (const net of seqClk(li) ?? []) clocks.add(net);
    for (const p of design.root.def.ports) if (p.dir === 'in' && p.clock) for (const net of design.root.ports[p.name]) clocks.add(net);
    // In level order: a gate or behaviour is derived if any input is (a storage behaviour: any comb
    // input; its clock is a pin, its other inputs are sampled before an edge, as a flip-flop's d).
    for (const k of queue) {
      if (k >= G + B) continue;
      const li = k < G ? -1 : behaviors[k - G];
      const ins = k < G ? leaves[gates[k]].inputs.flat() : combIns(li);
      if (li >= 0 && !seqClk(li) && ins.some((net) => derived[net])) {
        return { reason: `${leaves[li].node.path.join('.')} reads a signal derived from a clock` };
      }
      if (ins.some((net) => clocks.has(net) || derived[net])) for (const net of nodeOuts(k)) derived[net] = 1;
    }
    return new CycleSim(design, macros, gates, behaviors, level, maxLevel);
  }

  // ---- loading and handing over ----------------------------------------------------------

  /**
   * Take over a settled simulation of the same design (nothing pending): every net, behavioural
   * states (shared, not copied: one engine runs at a time), inputs and time. False when a
   * flip-flop is in a state its table refuses (a clock that is not 0 / 1, not settled): this engine
   * is then unusable until the next successful load.
   */
  load(src: Sim): boolean {
    const n = this.design.netCount;
    const v = this.val;
    for (let net = 0; net < n; net++) {
      const b = src.get(net);
      v[net] = b === BZ ? BX : b;
    }
    for (let mi = 0; mi < this.macros.length; mi++) {
      const m = this.macros[mi];
      const s = new Uint8Array(m.netOf.length);
      for (let i = 0; i < s.length; i++) s[i] = m.netOf[i] >= 0 ? v[m.netOf[i]] : BX;
      const id = m.table.intern(s);
      if (id < 0 || !m.table.good(id)) return false;
      this.mstate[mi] = id;
    }
    // the states a run will meet, checked now rather than in its first frames
    const byTab = this.tabs.map(() => new Set<number>());
    for (let mi = 0; mi < this.macros.length; mi++) byTab[this.mTab[mi]].add(this.mstate[mi]);
    this.tabs.forEach((t, i) => t.warm(byTab[i]));
    this.actLen.fill(0);
    this.actPos.fill(-1);
    for (let mi = 0; mi < this.macros.length; mi++) this.track(mi);
    for (let k = 0; k < this.B; k++) {
      const li = this.bLeaf[k];
      this.state[li] = src.leafState(li);
    }
    for (const [port] of this.inputNets) this.inputs.set(port, src.getInputBits(port));
    this.time = src.time;
    this.clearPending();
    this.tainted = false;
    return true;
  }

  /** Root nets changed and leaves poked since the last settle (what GateSim.adopt must re-evaluate). */
  get pendingNets(): readonly number[] {
    return this.changedNets;
  }

  get pendingLeaves(): readonly number[] {
    return this.poked;
  }

  private clearPending(): void {
    for (const net of this.changedNets) this.changedMark[net] = 0;
    this.changedNets = [];
    for (const cs of this.changedClocks) this.clockChanged[cs] = 0;
    this.changedClocks = [];
    this.poked = [];
    for (const k of this.snap) this.snapMark[k] = 0;
    this.snap = [];
    for (let lv = 0; lv <= this.maxLevel; lv++) {
      for (let k = this.head[lv]; k >= 0; k = this.link[k]) this.queued[k] = 0;
      this.head[lv] = -1;
    }
  }

  /** A flip-flop's state now, given its clock's value c (a stable one is either state of its pair). */
  private eff(mi: number, c: number): number {
    const s = this.mstate[mi], t = this.tabs[this.mTab[mi]];
    if (t.clockv[s] === c) return s;
    const p = t.partner(s);
    return p >= 0 ? p : s;
  }

  /** Put a flip-flop on its clock's active list, or take it off, after its state changed. */
  private track(mi: number): void {
    const stable = this.tabs[this.mTab[mi]].partner(this.mstate[mi]) >= 0;
    const at = this.actPos[mi], cs = this.mSlot[mi];
    if (!stable && at < 0) {
      this.actPos[mi] = this.actLen[cs];
      this.actList[cs][this.actLen[cs]++] = mi;
    } else if (stable && at >= 0) {
      const list = this.actList[cs], last = list[--this.actLen[cs]];
      list[at] = last;
      this.actPos[last] = at;
      this.actPos[mi] = -1;
    }
  }

  // ---- the Sim interface -----------------------------------------------------------------

  get(net: number): Bit {
    const mi = this.macroOf[net];
    if (mi < 0) return this.val[net] as Bit;
    // a clock change not settled yet has not reached the flip-flop: its clock as it was
    const clk = this.mIn[3 * mi + this.mClk[mi]];
    const s = this.eff(mi, this.changedMark[clk] ? this.prevVal[clk] : this.val[clk]);
    return this.tabs[this.mTab[mi]].states[s][this.isoOf[net]] as Bit;
  }

  getBits(nets: readonly number[]): Bit[] {
    const out: Bit[] = new Array(nets.length);
    for (let i = 0; i < nets.length; i++) out[i] = this.get(nets[i]);
    return out;
  }

  getInput(port: string): number {
    const v = this.inputs.get(port) ?? 0;
    return typeof v === 'number' ? v : pack(v);
  }

  getInputBits(port: string): Bit[] {
    const v = this.inputs.get(port) ?? 0;
    return typeof v === 'number' ? unpack(v, this.inputNets.get(port)?.length ?? 0) : v.slice();
  }

  setInput(port: string, value: number): void {
    const nets = this.inputNets.get(port);
    if (!nets) throw new Error(`no input port '${port}'`);
    this.inputs.set(port, value);
    const bits = unpack(value, nets.length);
    nets.forEach((net, i) => this.drive(net, bits[i]));
  }

  setInputBits(port: string, bits: ArrayLike<number>): void {
    const nets = this.inputNets.get(port);
    if (!nets) throw new Error(`no input port '${port}'`);
    const b = nets.map((_, i) => (bits[i] === B0 || bits[i] === B1 ? bits[i] : BX) as Bit);
    this.inputs.set(port, b);
    nets.forEach((net, i) => this.drive(net, b[i]));
  }

  /** A root input net takes a value: its readers are evaluated at the next settle. */
  private drive(net: number, b: Bit): void {
    const old = this.val[net];
    if (old === b) return;
    this.val[net] = b;
    if (this.watched[net] && this.onTrace) this.onTrace(net, b, this.time);
    if (!this.changedMark[net]) {
      this.changedMark[net] = 1;
      this.prevVal[net] = old;
      this.changedNets.push(net);
    }
    const cs = this.clockSlot[net];
    if (cs >= 0 && !this.clockChanged[cs]) {
      this.clockChanged[cs] = 1;
      this.changedClocks.push(cs);
    }
    for (let f = this.fanStart[net]; f < this.fanStart[net + 1]; f++) {
      const k = this.fanList[f];
      if (k < this.G) this.enqueue(k);
      else this.toSnap(k);
    }
  }

  private toSnap(k: number): void {
    if (this.snapMark[k]) return;
    this.snapMark[k] = 1;
    this.snap.push(k);
  }

  watch(nets: readonly number[]): void {
    for (const n of nets) this.watched[n] = 1;
  }

  poke(leaf: number, state: unknown): void {
    this.state[leaf] = state;
    this.poked.push(leaf);
    if (this.bNode[leaf] >= 0) this.toSnap(this.bNode[leaf]);
  }

  leafState(leaf: number): unknown {
    return this.state[leaf];
  }

  busy(): boolean {
    return this.snap.length > 0 || this.changedNets.length > 0 || this.poked.length > 0;
  }

  /** There is no time to step through: one settle. */
  step(): boolean {
    const was = this.busy();
    if (was && !this.settle()) throw new Error('CycleSim: this settle needs gate timing (DualSim hands it to GateSim)');
    return was;
  }

  /**
   * Settle everything that changed since the last settle. Returns false, having changed nothing,
   * when it cannot do it exactly (a clock that is not 0 / 1, a transition no table vouches for).
   */
  settle(): boolean {
    if (!this.busy()) return true;
    const G = this.G, GB = G + this.B, v = this.val;
    const { tabs, mTab, mstate, mBuf, nBuf, mOutStart, mOutList, mIn, mClk } = this;
    // A clock that is not 0 / 1 (all its flip-flops, the stable ones too): GateSim's job.
    for (const cs of this.changedClocks) if (v[this.clockNet[cs]] > B1) return false;
    // Phase 1: the active flip-flops of every clock that changed join the readers of changed pins.
    for (const cs of this.changedClocks) {
      const list = this.actList[cs];
      for (let j = 0; j < this.actLen[cs]; j++) this.toSnap(GB + list[j]);
    }
    // Their next states, from the state before this instant (none applied yet).
    let nm = 0;
    for (const k of this.snap) {
      if (k < GB) continue;
      const mi = k - GB, code = this.code(mi);
      if (code < 0) return false;
      const clk = mIn[3 * mi + mClk[mi]];
      const pre = this.eff(mi, this.changedMark[clk] ? this.prevVal[clk] : v[clk]);
      const t = tabs[mTab[mi]];
      let nx = t.next[pre * t.codes + code];
      if (nx === -1) nx = t.step(pre, code);
      if (nx < 0) return false;
      mBuf[nm] = mi;
      nBuf[nm++] = nx;
    }
    const outs: [number, number[]][] = [];
    for (const k of this.snap) if (k >= G && k < GB) outs.push([k, this.evalBehavior(this.bLeaf[k - G])]);
    for (let j = 0; j < nm; j++) {
      const mi = mBuf[j], nx = nBuf[j], t = tabs[mTab[mi]], o0 = mOutStart[mi], no = mOutStart[mi + 1] - o0;
      mstate[mi] = nx;
      this.track(mi);
      this.moved.push(mi);
      for (let o = 0; o < no; o++) {
        const net = mOutList[o0 + o], b = t.outv[nx * no + o];
        if (v[net] !== b) this.set(net, b as Bit);
      }
    }
    this.evaluations += nm + outs.length;
    for (const [k, bits] of outs) {
      const l = this.design.leaves[this.bLeaf[k - G]];
      let j = 0;
      for (const p of l.outputs) for (const net of p) this.set(net, bits[j++] as Bit);
    }
    for (const k of this.snap) this.snapMark[k] = 0;
    this.snap = [];
    for (const cs of this.changedClocks) this.clockChanged[cs] = 0;
    this.changedClocks = [];
    // Phase 2: level by level, each node once, except a storage behaviour whose sampled (non-comb)
    // inputs change after its level was passed: it is evaluated again (its outputs cannot change).
    const { ga, gb, gy, head, link, queued } = this;
    let evals = 0, sweeps = 0;
    this.behind = Infinity;
    for (let lv = 0; ; lv++) {
      if (lv > this.maxLevel) {
        if (this.behind > this.maxLevel) break;
        if (++sweeps > 1000) throw new Error('CycleSim: a storage behaviour keeps changing its outputs from inputs it samples');
        lv = this.behind;
        this.behind = Infinity;
      }
      this.at = lv;
      let k = head[lv];
      if (k < 0) continue;
      head[lv] = -1;
      while (k >= 0) {
        const nk = link[k];
        queued[k] = 0;
        evals++;
        if (k < G) {
          const y = NAND_T[(v[ga[k]] << 2) | v[gb[k]]];
          if (v[gy[k]] !== y) this.set(gy[k], y as Bit);
        } else if (k < GB) {
          const l = this.design.leaves[this.bLeaf[k - G]];
          const bits = this.evalBehavior(this.bLeaf[k - G]);
          let j = 0;
          for (const p of l.outputs) for (const net of p) this.set(net, bits[j++] as Bit);
        } else {
          // a data input changed, the clock steady: the state moves, the outputs cannot (FfTable checks it)
          const mi = k - GB, t = tabs[mTab[mi]], code = this.code(mi);
          const e = this.eff(mi, v[mIn[3 * mi + mClk[mi]]]);
          let nx = code < 0 ? -2 : t.next[e * t.codes + code];
          if (nx === -1) nx = t.step(e, code);
          if (nx < 0) throw new Error(`CycleSim: ${this.macros[mi].node.path.join('.')}: no table entry for a data change`);
          mstate[mi] = nx;
          this.track(mi);
          this.moved.push(mi);
        }
        k = nk;
      }
    }
    this.at = -1;
    this.evaluations += evals;
    for (const mi of this.moved) if (!tabs[mTab[mi]].good(mstate[mi])) this.tainted = true;
    this.moved.length = 0;
    for (const net of this.changedNets) this.changedMark[net] = 0;
    this.changedNets = [];
    this.poked = [];
    return true;
  }

  /** A flip-flop's input code for its table (base 3, input i weighs 3^i); −1 if its clock is not 0 / 1. */
  private code(mi: number): number {
    const v = this.val, base = 3 * mi, clk = this.mClk[mi];
    let c = 0;
    for (let i = this.mNin[mi] - 1; i >= 0; i--) {
      const b = v[this.mIn[base + i]];
      if (i === clk && b > B1) return -1;
      c = c * 3 + (b > BX ? BX : b);
    }
    return c;
  }

  /** A net takes a value; its readers are queued at their levels. */
  private set(net: number, b: Bit): void {
    const v = this.val;
    if (v[net] === b) return;
    v[net] = b;
    if (this.watched[net] && this.onTrace) this.onTrace(net, b, this.time);
    const { fanStart, fanList } = this;
    for (let f = fanStart[net], e = fanStart[net + 1]; f < e; f++) this.enqueue(fanList[f]);
  }

  private enqueue(k: number): void {
    if (this.queued[k]) return;
    this.queued[k] = 1;
    const lv = this.level[k];
    this.link[k] = this.head[lv];
    this.head[lv] = k;
    if (lv <= this.at && lv < this.behind) this.behind = lv;
  }

  private evalBehavior(li: number): number[] {
    const leaf = this.design.leaves[li];
    const v = this.val;
    const ins = leaf.inputs.map((p) => {
      const bits: number[] = new Array(p.length);
      for (let i = 0; i < p.length; i++) bits[i] = v[p[i]];
      return pack(bits);
    });
    const outs = leaf.def.behavior!.eval(ins, this.state[li]);
    const res: number[] = [];
    outPorts(leaf.def).forEach((p, pi) => { for (const b of unpack(outs[pi] ?? -1, p.width)) res.push(b); });
    return res;
  }

  /** Power-on through GateSim (whose power-on this must equal), then taken over. */
  reset(mode: PowerOnMode = 'zero'): void {
    const g = new GateSim(this.design);
    for (const [port, v] of this.inputs) {
      if (typeof v === 'number') g.setInput(port, v);
      else g.setInputBits(port, v);
    }
    g.reset(mode);
    if (!this.load(g)) throw new Error('CycleSim: the power-on state has no table (DualSim keeps GateSim then)');
  }

  carry(prev: Sim, opts: { known?: boolean } = {}): void {
    const g = new GateSim(this.design);
    g.carry(prev, opts);
    if (!this.load(g)) throw new Error('CycleSim: the carried state has no table (DualSim keeps GateSim then)');
  }

  saveState(): SimState {
    const st: CycleState = {
      val: this.val.slice(), mstate: this.mstate.slice(), state: this.state.map(cloneState),
      inputs: new Map([...this.inputs].map(([k, v]) => [k, Array.isArray(v) ? v.slice() : v])),
      time: this.time, evaluations: this.evaluations,
      changed: this.changedNets.map((net) => [net, this.prevVal[net]]), poked: this.poked.slice(), snap: this.snap.slice(), queued: this.queuedList(),
    };
    return st as unknown as SimState;
  }

  restoreState(saved: SimState): void {
    const s = saved as unknown as CycleState;
    this.val.set(s.val);
    this.mstate.set(s.mstate);
    this.state = s.state.map(cloneState);
    this.inputs = new Map([...s.inputs].map(([k, v]) => [k, Array.isArray(v) ? v.slice() : v]));
    this.time = s.time;
    this.evaluations = s.evaluations;
    this.clearPending();
    this.actLen.fill(0);
    this.actPos.fill(-1);
    for (let mi = 0; mi < this.macros.length; mi++) this.track(mi);
    for (const [net, old] of s.changed) {
      this.changedMark[net] = 1;
      this.prevVal[net] = old;
      this.changedNets.push(net);
      const cs = this.clockSlot[net];
      if (cs >= 0 && !this.clockChanged[cs]) { this.clockChanged[cs] = 1; this.changedClocks.push(cs); }
    }
    this.poked = s.poked.slice();
    for (const k of s.snap) this.toSnap(k);
    for (const k of s.queued) this.enqueue(k);
  }

  private queuedList(): number[] {
    const out: number[] = [];
    for (let lv = 0; lv <= this.maxLevel; lv++) for (let k = this.head[lv]; k >= 0; k = this.link[k]) out.push(k);
    return out;
  }

  /** Tabulated flip-flops, the logic's size and depth (for the perf script and tests). */
  get stats(): { flipFlops: number; gates: number; behaviors: number; levels: number; active: number } {
    let active = 0;
    for (const n of this.actLen) active += n;
    return { flipFlops: this.macros.length, gates: this.G, behaviors: this.B, levels: this.maxLevel + 1, active };
  }
}

interface CycleState {
  val: Uint8Array; mstate: Int32Array; state: unknown[]; inputs: Map<string, number | Bit[]>;
  time: number; evaluations: number; changed: [number, number][]; poked: number[]; snap: number[]; queued: number[];
}
