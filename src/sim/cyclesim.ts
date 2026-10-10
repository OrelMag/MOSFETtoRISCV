// The cycle engine: settled values without gate timing, for running big synchronous circuits (a
// CPU in the sandbox) many times faster than the event-driven GateSim, with the same result.
//
// Storage (every feedback loop: flip-flops, latches, found structurally by clusters.ts, whether
// from the library or drawn from NANDs) becomes table lookups (ffmacro.ts): no gate inside is
// evaluated, yet every internal net still has its value. The rest of the circuit must then be
// acyclic; it is levelized, and a settle evaluates each gate or behavioural leaf whose inputs
// changed once, in level order (zero delay: no glitches).
//
// A settle has two phases, mirroring what GateSim does at the instant inputs change: first every
// cluster that follows a changed root input (a clock edge, a reset pin, a latch's pins; through
// inverters too: the table schedules each at its delay) and every behavioural leaf that reads one
// or was poked takes its next state from the values *before* anything reacts (in GateSim nothing
// caused by the change reaches a cluster's data inputs sooner than one gate delay later, or than
// the table's `early` for a clock through inverters: FfTable checks that the cluster does not
// mind); then the changes propagate through the levelized logic. The settled values equal
// GateSim's when: every cluster with data inputs follows at least one pin, no behavioural leaf
// reads a signal derived from a clock by logic, the remaining logic has no loop, and stateful
// behavioural leaves change their state only on a clock transition (as the sandbox's RAMs do).
// build() refuses a design that breaks the structural conditions (a ripple or gated clock among
// them), and settle() returns false, changing nothing, when a cluster would see a clock that is not
// 0 / 1, a transition its table cannot vouch for, or a pin changing together with a clock on a path
// too short for the clusters clocked by its inverse: the caller (DualSim) then hands that settle to
// GateSim, and `refusal` says why. tests/cyclesim*.test.ts compare every net with GateSim after
// every settle.

import { findClusters } from './clusters';
import { CONST, DATA, FfTable, type Profile } from './ffmacro';
import type { FlatDesign, HierNode } from './flatten';
import { cloneState, GateSim } from './gatesim';
import type { PowerOnMode, Sim, SimState } from './sim';
import { B0, B1, BX, BZ, type Bit, inPorts, isExternal, netlistOf, outPorts } from './types';
import { pack, unpack } from './values';

const NAND_T = new Uint8Array(16);
for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) NAND_T[(a << 2) | b] = a === B0 || b === B0 ? B1 : a === B1 && b === B1 ? B0 : BX;

/** Inputs per cluster in the engine's flat arrays (≥ ffmacro MAX_IN). */
const STRIDE = 5;
/** Distances the timing check of clusters clocked through inverters looks at. */
const FAR = 32;

/** A tabulated cluster: its table, its nets (local → design), inputs (table order) and outputs. */
interface Macro {
  table: FfTable;
  node: HierNode;
  ins: number[];
  outs: number[];
  nets: Int32Array;
  /** Per input: the root pin a timed input follows (−1: data or constant), and whether inverted. */
  roots: number[];
  parity: number[];
  /** The clock's pin (−1: none). */
  clk: number;
}

/** Tables by structure and profile, shared by every design built in this session (bounded). */
const TABLES = new Map<string, FfTable>();
const MAX_TABLES = 512;
function tableFor(key: string, make: () => FfTable): FfTable {
  let t = TABLES.get(key);
  if (t) {
    TABLES.delete(key);
    TABLES.set(key, t);
    return t;
  }
  t = make();
  TABLES.set(key, t);
  if (TABLES.size > MAX_TABLES) TABLES.delete(TABLES.keys().next().value!);
  return t;
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
  /** Clusters as flat arrays: table, input nets (STRIDE per cluster, table order), outputs (CSR), state. */
  private tabs: FfTable[] = [];
  private mTab: Uint16Array;
  private mIn: Int32Array;
  private mNin: Uint8Array;
  private mOutStart: Int32Array;
  private mOutList: Int32Array;
  private mstate: Int32Array;
  /** Per input (STRIDE per cluster): the root pin a timed input follows (−1: data), inversion; per cluster: its clock pin (−1: none). */
  private mRoot: Int32Array;
  private mPar: Uint8Array;
  private mClkPin: Int32Array;
  /** Root nets that clock a cluster; and those whose clusters a short path makes a pin change together with them unsafe for. */
  private isClock: Uint8Array;
  private hazard: Uint8Array;
  /** Why the last load / settle could not be done here, or the last settle left a cluster where its table cannot follow ('' if none). */
  refusal = '';
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

  private constructor(design: FlatDesign, macros: Macro[], gates: number[], behaviors: number[], level: Int32Array, maxLevel: number, hazard: Uint8Array) {
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
    this.mTab = new Uint16Array(M);
    this.mIn = new Int32Array(STRIDE * M).fill(-1);
    this.mRoot = new Int32Array(STRIDE * M).fill(-1);
    this.mPar = new Uint8Array(STRIDE * M);
    this.mNin = new Uint8Array(M);
    this.mClkPin = new Int32Array(M);
    this.mOutStart = new Int32Array(M + 1);
    this.mBuf = new Int32Array(M);
    this.nBuf = new Int32Array(M);
    this.clockSlot = new Int32Array(n).fill(-1);
    this.mSlot = new Int32Array(M).fill(-1);
    this.actPos = new Int32Array(M).fill(-1);
    this.isClock = new Uint8Array(n);
    this.hazard = hazard;
    const outs: number[] = [], perSlot: number[] = [];
    const tabIndex = new Map<FfTable, number>();
    macros.forEach((m, mi) => {
      let t = tabIndex.get(m.table);
      if (t === undefined) { t = this.tabs.push(m.table) - 1; tabIndex.set(m.table, t); }
      this.mTab[mi] = t;
      m.ins.forEach((net, i) => {
        this.mIn[STRIDE * mi + i] = net;
        this.mRoot[STRIDE * mi + i] = m.roots[i];
        this.mPar[STRIDE * mi + i] = m.parity[i];
      });
      this.mNin[mi] = m.ins.length;
      this.mClkPin[mi] = m.clk;
      this.mOutStart[mi] = outs.length;
      outs.push(...m.outs);
      const clk = m.clk;
      if (clk < 0) return;
      this.isClock[clk] = 1;
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
      m.nets.forEach((net, iso) => {
        if (!ports.has(net)) { this.macroOf[net] = mi; this.isoOf[net] = iso; }
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

    // readers of every net (each node once per net); a cluster reads its data inputs, and the pins
    // of its timed inputs other than the clock (it reads the clock through its slot)
    const ins = (k: number): number[] => {
      if (k < G) return [this.ga[k], this.gb[k]];
      if (k < G + B) return leaves[this.bLeaf[k - G]].inputs.flat();
      const m = macros[k - G - B];
      return m.ins.map((net, i) => (m.roots[i] < 0 ? net : m.roots[i])).filter((net) => net !== m.clk);
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
    if (leaves.some((l) => l.kind !== 'nand' && l.kind !== 'behavior')) return { reason: 'switch-level parts' };
    const rootIn = new Uint8Array(n), clockPin = new Uint8Array(n);
    for (const p of design.root.def.ports) {
      if (p.dir !== 'in') continue;
      for (const net of design.root.ports[p.name]) { rootIn[net] = 1; if (p.clock) clockPin[net] = 1; }
    }
    const found = findClusters(design);
    if ('reason' in found) return found;
    const { clusters, chainRoot, chainDelay, chainParity, driver: leafOf, rdStart, rdList } = found;
    const inMacro = new Int32Array(leaves.length).fill(-1);
    clusters.forEach((c, ci) => { for (const li of c.leaves) inMacro[li] = ci; });
    // constants: stateless behaviours with no inputs that the world outside does not drive (tie cells)
    const constNet = new Uint8Array(n);
    for (const l of leaves) {
      if (l.kind === 'behavior' && l.inputs.length === 0 && !isExternal(l.def) && !l.def.behavior?.init) for (const p of l.outputs) for (const net of p) constNet[net] = 1;
    }
    const where = (node: HierNode) => node.path.join('.') || 'the chip';
    /** A net's name as seen from an instance: one of its ports, else a port or named net of an instance around it. */
    const nameIn = (node: HierNode, net: number): string => {
      for (let nd: HierNode | null = node; nd; nd = nd.parent) {
        const at = (p: string) => (nd === node ? p : nd!.parent ? `${nd!.path.join('.')}.${p}` : `pin ${p}`);
        for (const [p, nets] of Object.entries(nd.ports)) {
          const i = nets.indexOf(net);
          if (i >= 0) return nets.length > 1 ? `${at(p)}[${i}]` : at(p);
        }
        const defs = nd.nets ? netlistOf(nd.def)?.nets : undefined;
        if (defs) {
          for (let k = 0; k < nd.nets!.length; k++) {
            const i = nd.nets![k].indexOf(net), name = defs[k]?.name;
            if (i >= 0 && name) return nd.nets![k].length > 1 ? `${at(name)}[${i}]` : at(name);
          }
        }
      }
      return `net ${net}`;
    };
    /**
     * A clock of the cluster's instance or of one around it (a port marked clock, or a flip-flop's
     * clk) that no pin drives, even through inverters: why the cluster cannot be tabulated, or ''.
     */
    const derivedClock = (node: HierNode): string => {
      for (let nd: HierNode | null = node; nd; nd = nd.parent) {
        for (const p of nd.def.ports) {
          if (p.dir !== 'in' || !(p.clock || nd.def.ff?.clk === p.name)) continue;
          for (const net of nd.ports[p.name] ?? []) {
            if (chainRoot[net] >= 0 || constNet[net]) continue;
            // trace inverters back to say where it comes from
            let x = net, d = leafOf[x];
            while (d >= 0 && inMacro[d] < 0 && leaves[d].kind === 'nand' && leaves[d].inputs[0][0] === leaves[d].inputs[1][0]) { x = leaves[d].inputs[0][0]; d = leafOf[x]; }
            const from = d >= 0 && inMacro[d] >= 0 ? `comes from the flip-flop ${where(clusters[inMacro[d]].node)} (a ripple clock)`
              : d >= 0 && leaves[d].kind === 'behavior' ? `comes from ${where(leaves[d].node)}, not a pin` : 'is made by logic (a gated or derived clock)';
            return `${where(nd)}: its clock ${p.name} ${from}; the cycle engine needs every clock from a pin of the chip, or a pin inverted`;
          }
        }
      }
      return '';
    };

    // Each cluster's inputs: timed (following a pin, maybe through inverters), data or constant.
    interface Plan { ins: number[]; pins: number[]; group: number[]; delay: number[]; parity: number[]; primary: number }
    const plans: Plan[] = [];
    for (const c of clusters) {
      const ins = c.ins.map((l) => c.nets[l]);
      const pins: number[] = [], group: number[] = [], delay: number[] = [], parity: number[] = [];
      for (const x of ins) {
        const r = chainRoot[x];
        if (r >= 0) {
          let g = pins.indexOf(r);
          if (g < 0) g = pins.push(r) - 1;
          group.push(g);
          delay.push(chainDelay[x]);
          parity.push(chainParity[x]);
        } else {
          group.push(constNet[x] ? CONST : DATA);
          delay.push(0);
          parity.push(0);
        }
      }
      const derived = derivedClock(c.node);
      if (derived) return { reason: derived };
      if (!pins.length && group.includes(DATA)) {
        return { reason: `${where(c.node)}: storage that no pin of the chip clocks, sets or enables (a gated or derived clock, a latch enabled by logic, or an oscillator)` };
      }
      plans.push({ ins, pins, group, delay, parity, primary: -1 });
    }
    // The clock of each: the hint of a flip-flop around it, a pin marked clock, else the pin most clusters follow.
    const fan = new Map<number, number>();
    for (const p of plans) for (const r of p.pins) fan.set(r, (fan.get(r) ?? 0) + 1);
    clusters.forEach((c, ci) => {
      const p = plans[ci];
      if (!p.pins.length) return;
      for (let nd: HierNode | null = c.node; nd && p.primary < 0; nd = nd.parent) {
        const ff = nd.def.ff, nets = ff ? nd.ports[ff.clk] : undefined;
        if (nets && nets.length === 1 && chainRoot[nets[0]] >= 0) p.primary = p.pins.indexOf(chainRoot[nets[0]]);
      }
      if (p.primary < 0) p.primary = p.pins.findIndex((r) => clockPin[r]);
      if (p.primary < 0) p.primary = p.pins.reduce((b, r, g) => (fan.get(r)! > fan.get(p.pins[b])! ? g : b), 0);
    });
    const isPrimary = new Uint8Array(n);
    for (const p of plans) if (p.primary >= 0) isPrimary[p.pins[p.primary]] = 1;

    // Clusters clocked through inverters see their clock k delays late: their data inputs must not
    // change before k + 1 (else the table would need to know when they do). `early` is the soonest a
    // clock edge reaches them; a change of another pin or a poke reaching them sooner (hazard) makes
    // the settles where it comes with their clock GateSim's.
    const hazard = new Uint8Array(n);
    let fromClocks: Uint8Array | null = null, fromOthers: Uint8Array | null = null;
    const reach = (sources: [number, number][]): Uint8Array => {
      const d = new Uint8Array(n).fill(255);
      const buckets: number[][] = Array.from({ length: FAR + 1 }, () => []);
      for (const [net, k] of sources) if (k < d[net]) { d[net] = k; buckets[k].push(net); }
      for (let k = 0; k <= FAR; k++) {
        for (const x of buckets[k]) {
          if (d[x] !== k) continue;
          for (let i = rdStart[x]; i < rdStart[x + 1]; i++) {
            const l = leaves[rdList[i]], t = k + (l.kind === 'nand' ? 1 : Math.max(1, l.def.behavior?.delay ?? 1));
            if (t > FAR) continue;
            for (const p of l.outputs) for (const y of p) if (t < d[y]) { d[y] = t; buckets[t].push(y); }
          }
        }
      }
      return d;
    };
    const macros: Macro[] = [];
    clusters.forEach((c, ci) => {
      const p = plans[ci];
      const late = Math.max(0, ...p.delay);
      let early = 1;
      if (late > 0) {
        if (!fromClocks) {
          const pins: [number, number][] = [], others: [number, number][] = [];
          for (let net = 0; net < n; net++) if (rootIn[net]) (isPrimary[net] ? pins : others).push([net, 0]);
          for (const l of leaves) if (l.kind === 'behavior') for (const q of l.outputs) for (const net of q) others.push([net, 1]);
          fromClocks = reach(pins);
          fromOthers = reach(others);
        }
        early = late + 1;
        let soonest = 255;
        p.ins.forEach((x, i) => {
          if (p.group[i] !== DATA) return;
          early = Math.min(early, fromClocks![x]);
          soonest = Math.min(soonest, fromOthers![x]);
        });
        if (soonest < early) for (const r of p.pins) hazard[r] = 1;
      }
      const profile: Profile = { group: p.group, delay: p.delay, parity: p.parity, primary: p.primary, early };
      const key = `${c.key}#${p.group.join(',')}|${p.delay.join(',')}|${p.parity.join(',')}|${p.primary}|${early}`;
      const table = tableFor(key, () => new FfTable({
        gates: c.gates, netCount: c.nets.length, ins: c.ins, outs: c.outs, profile, names: p.ins.map((x) => nameIn(c.node, x)),
      }));
      macros.push({
        table, node: c.node, ins: p.ins, outs: c.outs.map((l) => c.nets[l]), nets: Int32Array.from(c.nets),
        roots: p.ins.map((_, i) => (p.group[i] >= 0 ? p.pins[p.group[i]] : -1)), parity: p.parity, clk: p.primary >= 0 ? p.pins[p.primary] : -1,
      });
    });

    const gates: number[] = [], behaviors: number[] = [];
    leaves.forEach((l, li) => {
      if (inMacro[li] >= 0) return;
      if (l.kind === 'nand') gates.push(li);
      else behaviors.push(li);
    });

    // Levels over gates and behaviours; cluster outputs, root inputs and constants are sources.
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
    const nodeIns = (k: number): number[] => (k < G ? leaves[gates[k]].inputs.flat() : k < G + B ? combIns(behaviors[k - G]) : macros[k - G - B].ins.filter((_, i) => macros[k - G - B].roots[i] < 0));
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
      return { reason: `a loop through a behavioural part${l ? ` (${l.node.path.join('.')})` : ''}` };
    }

    // no behavioural leaf may read a signal the clock reaches through logic (it would see the edge late)
    const clocks = new Set(macros.flatMap((m) => (m.clk >= 0 ? [m.clk] : [])));
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
    return new CycleSim(design, macros, gates, behaviors, level, maxLevel, hazard);
  }

  // ---- loading and handing over ----------------------------------------------------------

  /**
   * Take over a settled simulation of the same design (nothing pending): every net, behavioural
   * states (shared, not copied: one engine runs at a time), inputs and time. False (`refusal` says
   * why) when a cluster is in a state its table refuses (a clock that is not 0 / 1, not settled, a
   * state good() rejects): this engine is then unusable until the next successful load.
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
      const s = new Uint8Array(m.nets.length);
      for (let i = 0; i < s.length; i++) s[i] = v[m.nets[i]];
      const id = m.table.intern(s);
      if (id < 0) return this.refuse(`${CycleSim.where(m)}: ${m.table.refusal(s)}`);
      if (!m.table.good(id)) return this.refuse(`${CycleSim.where(m)}: ${m.table.why(id)}`);
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
    this.refusal = '';
    return true;
  }

  /** Are the clock pins 0 / 1 in this simulation (else load() would refuse: try again when they are)? */
  clocksKnown(src: Sim): boolean {
    for (const net of this.clockNet) if (src.get(net) > B1) return false;
    return true;
  }

  private static where(m: Macro): string {
    return m.node.path.join('.') || 'the chip';
  }

  /** Say why, and return false. */
  private refuse(why: string): false {
    this.refusal = why;
    return false;
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

  /** A cluster's state now, given its clock's value c (a stable one is either state of its pair). */
  private eff(mi: number, c: number): number {
    const s = this.mstate[mi], t = this.tabs[this.mTab[mi]];
    if (this.mSlot[mi] < 0 || t.clockv[s] === c) return s;
    const p = t.partner(s);
    return p >= 0 ? p : s;
  }

  /** Put a flip-flop on its clock's active list, or take it off, after its state changed. */
  private track(mi: number): void {
    if (this.mSlot[mi] < 0) return;
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
    // a clock change not settled yet has not reached the cluster: its clock as it was
    const clk = this.mClkPin[mi];
    const s = clk < 0 ? this.mstate[mi] : this.eff(mi, this.changedMark[clk] ? this.prevVal[clk] : this.val[clk]);
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
    const { tabs, mTab, mstate, mBuf, nBuf, mOutStart, mOutList, mClkPin } = this;
    // A clock that is not 0 / 1 (all its clusters, the stable ones too): GateSim's job. So is a
    // clock that reaches clusters through inverters, changing together with another pin (or a
    // poke) whose path to their data inputs is shorter than the clock's (hazard).
    let other = this.poked.length > 0, hazard = false;
    for (const net of this.changedNets) {
      if (!this.isClock[net]) other = true;
      else if (v[net] > B1) return this.refuse('a clock pin is X');
      if (this.hazard[net]) hazard = true;
    }
    if (hazard && other) return this.refuse('a pin changed together with a clock that reaches flip-flops through inverters, on a shorter path than the clock');
    // Phase 1: the active clusters of every clock that changed join the readers of changed pins.
    for (const cs of this.changedClocks) {
      const list = this.actList[cs];
      for (let j = 0; j < this.actLen[cs]; j++) this.toSnap(GB + list[j]);
    }
    // Their next states, from the state before this instant (none applied yet).
    let nm = 0;
    for (const k of this.snap) {
      if (k < GB) continue;
      const mi = k - GB, code = this.code(mi);
      if (code < 0) return this.refuse(`${CycleSim.where(this.macros[mi])}: its clock is X`);
      const clk = mClkPin[mi];
      const pre = clk < 0 ? mstate[mi] : this.eff(mi, this.changedMark[clk] ? this.prevVal[clk] : v[clk]);
      const t = tabs[mTab[mi]];
      let nx = t.next[pre * t.codes + code];
      if (nx === -1) nx = t.step(pre, code);
      if (nx < 0) return this.refuse(`${CycleSim.where(this.macros[mi])}: no settled state after this change (a race or an oscillation)`);
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
          // a data input changed, the pins steady: the state moves, the outputs cannot (FfTable checks it)
          const mi = k - GB, t = tabs[mTab[mi]], code = this.code(mi), clk = mClkPin[mi];
          const e = clk < 0 ? mstate[mi] : this.eff(mi, v[clk]);
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
    for (const mi of this.moved) {
      const t = tabs[mTab[mi]];
      if (t.good(mstate[mi])) continue;
      this.tainted = true;
      this.refusal = `${CycleSim.where(this.macros[mi])}: ${t.why(mstate[mi])}`;
    }
    this.moved.length = 0;
    for (const net of this.changedNets) this.changedMark[net] = 0;
    this.changedNets = [];
    this.poked = [];
    return true;
  }

  /**
   * A cluster's input code for its table (base 3, input i weighs 3^i): a timed input from its pin's
   * value (it may not have reached the input yet, through inverters), the others as they are; −1
   * if its clock is not 0 / 1.
   */
  private code(mi: number): number {
    const v = this.val, base = STRIDE * mi, clk = this.mClkPin[mi];
    let c = 0;
    for (let i = this.mNin[mi] - 1; i >= 0; i--) {
      const r = this.mRoot[base + i];
      let b: number;
      if (r >= 0) {
        b = v[r];
        if (b > B1) {
          if (r === clk) return -1;
          b = BX;
        } else b ^= this.mPar[base + i];
      } else {
        b = v[this.mIn[base + i]];
        if (b > BX) b = BX;
      }
      c = c * 3 + b;
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
