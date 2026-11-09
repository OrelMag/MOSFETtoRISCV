// Faults (DOM-free): what the sandbox's fault brush does to a flattened design (docs/PLAN-ONI.md, D).
//
// stuck at 0 / 1: a rewrite after flatten. A fresh net driven by a constant leaf, and every leaf input reading the
//   faulted net reads it instead (a chip output pin too). The original driver still drives its net, so a probe on the
//   driver side shows the healthy value, as a stuck-at on the inputs would. The input arrays flatten shares (with
//   HierNode.ports and other leaves) are copied, never changed; HierNode.ports keep the original nets.
// slow (+k gate delays): data on the design, not a new leaf, so CycleSim and BitSim see exactly the healthy netlist:
//   design.extraDelay maps the driving leaf to k; GateSim and leafDelays (static timing) add it, DualSim stays on
//   GateSim (the cycle engine has no delays).
// flip once: no rewrite; the stored bit is written in the running simulation (flipBits, flipRamBit).
// No faults: applyFaults returns the design itself.

import type { FlatDesign, FlatLeaf, HierNode } from './flatten';
import { B0, B1, type Bit, type ComponentDef } from './types';
import type { Sim } from './sim';
import type { RamState } from '../lib/bigmem';

export type FaultKind = 'stuck0' | 'stuck1' | 'slow';

/** A fault on flat nets (the editor resolves its targets to these). */
export interface FlatFault {
  kind: FaultKind;
  nets: readonly number[];
  /** slow: extra gate delays (1 …). */
  delay?: number;
}

/** The most extra delay a slow fault may add (GateSim's event wheel holds 63 delays). */
export const MAX_SLOW = 32;

const tieDefs = new Map<number, ComponentDef>();
/** The constant a stuck-at net is tied to: a behavioural leaf with no inputs (every engine evaluates it the same). */
function tie(v: 0 | 1): ComponentDef {
  const had = tieDefs.get(v);
  if (had) return had;
  const d: ComponentDef = {
    id: `fault_stuck${v}`, name: `Stuck at ${v} (fault)`, category: 'plumbing',
    summary: `A fault: the net reads ${v} whatever drives it.`,
    ports: [{ name: 'y', width: 1, dir: 'out' }],
    symbol: { kind: 'box', label: `⚡${v}` },
    behavior: { eval: () => [v] },
  };
  tieDefs.set(v, d);
  return d;
}

/** A leaf's node outside the hierarchy (no parent's children map holds it): named for the fault and its net. */
function faultNode(def: ComponentDef, net: number, y: number): HierNode {
  return { name: `fault_n${net}`, def, parent: null, ports: { y: [y] }, expanded: false, get path() { return [`fault_n${net}`]; } };
}

export type ApplyResult = { design: FlatDesign; problems: string[] };

/**
 * The design with these faults (a new object, sharing everything it does not change), and why any could not be set.
 * A net both stuck and slow is stuck (slowness is meaningless on a constant); stuck at 0 and at 1 on one net: the last wins.
 */
export function applyFaults(d: FlatDesign, faults: readonly FlatFault[]): ApplyResult {
  const problems: string[] = [];
  if (!faults.length) return { design: d, problems };
  const stuck = new Map<number, 0 | 1>();
  for (const f of faults) if (f.kind !== 'slow') for (const n of f.nets) stuck.set(n, f.kind === 'stuck1' ? 1 : 0);
  let driver: Int32Array | null = null;
  const extra = new Map<number, number>();
  for (const f of faults) {
    if (f.kind !== 'slow') continue;
    const k = Math.round(f.delay ?? 1);
    if (!(k >= 1 && k <= MAX_SLOW)) { problems.push(`a slow fault adds 1 to ${MAX_SLOW} gate delays, not ${f.delay}`); continue; }
    if (!driver) {
      driver = new Int32Array(d.netCount).fill(-1);
      d.leaves.forEach((l, li) => { for (const p of l.outputs) for (const n of p) driver![n] = li; });
    }
    for (const n of f.nets) {
      if (stuck.has(n)) continue;
      const li = driver[n];
      if (li < 0) { problems.push('a slow fault needs a gate driving the net (an input pin has none)'); continue; }
      const l = d.leaves[li];
      if (l.kind !== 'nand' && l.outputs.reduce((a, p) => a + p.length, 0) > 1) {
        problems.push(`a slow fault slows one gate: ${l.node.path.join('.') || l.def.name} drives several nets`);
        continue;
      }
      extra.set(li, Math.max(extra.get(li) ?? 0, k));
    }
  }
  if (!stuck.size && !extra.size) return { design: d, problems };
  let netCount = d.netCount;
  let leaves = d.leaves;
  let root = d.root;
  const stuckTo = new Map<number, number>();
  if (stuck.size) {
    // a fresh net per stuck net, driven by its constant
    const to = stuckTo;
    const ties: FlatLeaf[] = [];
    for (const [n, v] of stuck) {
      const y = netCount++;
      to.set(n, y);
      const def = tie(v);
      ties.push({ kind: 'behavior', def, node: faultNode(def, n, y), inputs: [], outputs: [[y]] });
    }
    const remap = (p: number[]) => (p.some((n) => to.has(n)) ? p.map((n) => to.get(n) ?? n) : p);
    leaves = d.leaves.map((l) => {
      const inputs = l.inputs.map(remap);
      return inputs.some((p, i) => p !== l.inputs[i]) ? { ...l, inputs } : l;
    });
    leaves.push(...ties);
    // the chip's output pins read the stuck value too (inputs keep their nets: the pin drives them)
    const outs = Object.fromEntries(root.def.ports.filter((p) => p.dir === 'out').map((p) => [p.name, root.ports[p.name]]).filter(([, nets]) => nets && (nets as number[]).some((n) => to.has(n)))) as Record<string, number[]>;
    if (Object.keys(outs).length) {
      const ports = { ...root.ports };
      for (const [k, nets] of Object.entries(outs)) ports[k] = remap(nets);
      root = Object.assign(Object.create(Object.getPrototypeOf(root)), root, { ports }) as HierNode;
    }
  }
  return { design: { ...d, root, netCount, leaves, ...(extra.size ? { extraDelay: extra } : {}), ...(stuckTo.size ? { stuckTo } : {}) }, problems };
}

/** A stable text of the faults, for a simulation's key. '' with none. */
export const faultsKey = (faults: readonly FlatFault[]): string =>
  faults.map((f) => `${f.kind}${f.kind === 'slow' ? `+${f.delay ?? 1}` : ''}:${f.nets.join('.')}`).sort().join(',');

/** What flipBits needs of a simulation: GateSim and DualSim. */
export type Flippable = Sim & { forceNets(nets: readonly number[], bits: ArrayLike<number>): void; recheck(nets: readonly number[]): void };

export const canFlip = (sim: Sim): sim is Flippable =>
  typeof (sim as Partial<Flippable>).forceNets === 'function' && typeof (sim as Partial<Flippable>).recheck === 'function';

/**
 * Flip stored bits once (a single-event upset): each net forced to its inverse and the circuit settled; then the nets'
 * drivers are evaluated again and it settles once more. Returns, per net, whether the flip held: a bit a loop stores
 * keeps it (the loop took the new value), a net a gate computes from elsewhere, or a latch transparent at that moment,
 * goes back. A net at X cannot flip. On DualSim the state moves to GateSim for it.
 */
export function flipBits(sim: Sim, nets: readonly number[]): boolean[] {
  if (!canFlip(sim)) return nets.map(() => false);
  const before = sim.getBits(nets);
  const flipped = before.map((b) => (b === B0 ? B1 : b === B1 ? B0 : b)) as Bit[];
  const known = nets.filter((_, i) => flipped[i] !== before[i]);
  sim.forceNets(known, known.map((n) => flipped[nets.indexOf(n)]));
  sim.settle();
  sim.recheck(known);
  sim.settle();
  const after = sim.getBits(nets);
  return nets.map((_, i) => before[i] !== flipped[i] && after[i] === flipped[i]);
}

/** Flip bit `bit` of word `addr` in a large memory's leaf (lib/bigmem.ts RamState): a copy of its state, poked. */
export function flipRamBit(sim: Sim, leaf: number, addr: number, bit: number): boolean {
  const s = sim.leafState(leaf) as RamState | undefined;
  if (!s || !(s.mem instanceof Uint32Array) || addr < 0 || addr >= s.mem.length || s.x[addr]) return false;
  const mem = s.mem.slice();
  mem[addr] = (mem[addr] ^ (1 << bit)) >>> 0;
  sim.poke(leaf, { ...s, mem });
  return true;
}
