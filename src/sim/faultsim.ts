// Fault simulation (DOM-free): how many manufacturing defects a set of test vectors would catch (docs/PLAN-VERIFY.md).
//
// The defect model is the stuck-at fault of sim/faults.ts: one net reads 0 (or 1) whatever drives it. The sites are the
// stems: every input bit of the circuit and every NAND's output, as the fault brush puts them (a fan-out branch, one reader's
// copy of a net, is not a site of its own here; the chapter says so). A vector detects a fault when some output bit differs
// from the good circuit's. Combinational gate-level blocks only (NANDs and stateless behaviours such as constants);
// sequential logic is tested through a scan chain, which turns it into this.
//
// Two-valued and bit-parallel: 32 vectors per word, one pass of the leaves per fault (a stuck net forced after its driver).
// Outputs read the stuck value too, as seenNets makes a drawing do: tests/faultsim.test.ts holds every detection equal to
// GateSim on applyFaults' rewrite. A vector packs the input ports in order, the first port's bit 0 lowest.

import { flatten, type FlatDesign } from './flatten';
import { inPorts, outPorts, type ComponentDef } from './types';

/** Most input bits for which "every vector" (exhaustive tests, exact covers) is offered. */
export const MAX_EXHAUSTIVE = 16;

export interface FaultSite {
  net: number;
  /** "a[2]", "cin", "fa1.g5": an input bit, or the instance path of the NAND driving the net. */
  name: string;
}

export interface StuckFault {
  site: number;
  v: 0 | 1;
}

export interface FaultModel {
  def: ComponentDef;
  design: FlatDesign;
  sites: FaultSite[];
  /** Two per site: stuck at 0, then stuck at 1. */
  faults: StuckFault[];
  inBits: number;
  outBits: number;
  /** Leaves in evaluation order. */
  order: number[];
  inNets: number[];
  outNets: number[];
  /** For each net, its site (or −1). */
  siteOf: Int32Array;
}

export const faultName = (m: FaultModel, f: StuckFault | number): string => {
  const x = typeof f === 'number' ? m.faults[f] : f;
  return `${m.sites[x.site].name} stuck at ${x.v}`;
};

const models = new WeakMap<ComponentDef, FaultModel | string>();

/** The stuck-at fault model of a combinational gate-level block, or why it has none. Memoized per component. */
export function faultModel(def: ComponentDef): FaultModel | string {
  const had = models.get(def);
  if (had) return had;
  const m = build(def);
  models.set(def, m);
  return m;
}

function build(def: ComponentDef): FaultModel | string {
  let design: FlatDesign;
  try { design = flatten(def, { mode: 'gate' }); } catch { return 'it reaches transistors (switch level)'; }
  const driver = new Int32Array(design.netCount).fill(-1);
  for (const [i, l] of design.leaves.entries()) {
    if (l.kind !== 'nand' && l.kind !== 'behavior') return 'it reaches transistors (switch level)';
    if (l.kind === 'behavior' && (l.def.behavior!.init || l.def.behavior!.seq)) return `${l.node.path.join('.') || l.def.name} holds state`;
    for (const p of l.outputs) for (const n of p) driver[n] = i;
  }
  const deps = design.leaves.map((l) => new Set(l.inputs.flat().map((n) => driver[n]).filter((d) => d >= 0)));
  const users: number[][] = design.leaves.map(() => []);
  deps.forEach((ds, i) => ds.forEach((d) => users[d].push(i)));
  const left = deps.map((s) => s.size);
  const order: number[] = [];
  left.forEach((k, i) => { if (!k) order.push(i); });
  for (let q = 0; q < order.length; q++) for (const u of users[order[q]]) if (--left[u] === 0) order.push(u);
  if (order.length < design.leaves.length) return 'it has feedback (storage): test it through a scan chain';

  const sites: FaultSite[] = [];
  const siteOf = new Int32Array(design.netCount).fill(-1);
  const add = (net: number, name: string) => { if (siteOf[net] < 0) { siteOf[net] = sites.length; sites.push({ net, name }); } };
  const inNets: number[] = [];
  for (const p of inPorts(def)) design.root.ports[p.name].forEach((n, b) => { inNets.push(n); add(n, p.width > 1 ? `${p.name}[${b}]` : p.name); });
  for (const li of order) {
    const l = design.leaves[li];
    if (l.kind === 'nand') add(l.outputs[0][0], l.node.path.join('.'));
  }
  const outNets = outPorts(def).flatMap((p) => design.root.ports[p.name]);
  if (inNets.length > 30) return `${inNets.length} input bits: a vector would not fit a number`;
  return {
    def, design, sites, faults: sites.flatMap((_, s) => [{ site: s, v: 0 as const }, { site: s, v: 1 as const }]),
    inBits: inNets.length, outBits: outNets.length, order, inNets, outNets, siteOf,
  };
}

/** One pass for up to 32 vectors: the value of every net as a lane word, with one net forced (or none). */
function evalWord(m: FaultModel, vecs: ArrayLike<number>, from: number, val: Int32Array, force = -1, fv = 0): void {
  const { design, order, inNets } = m;
  const lanes = Math.min(32, vecs.length - from);
  val.fill(0);
  inNets.forEach((n, b) => {
    let w = 0;
    for (let l = 0; l < lanes; l++) if ((vecs[from + l] >>> b) & 1) w |= 1 << l;
    val[n] = w;
  });
  const forced = force >= 0 ? (fv ? -1 : 0) : 0;
  if (force >= 0) val[force] = forced;
  for (const li of order) {
    const leaf = design.leaves[li];
    if (leaf.kind === 'nand') {
      let a = -1;
      for (const p of leaf.inputs) for (const n of p) a &= val[n];
      const o = leaf.outputs[0][0];
      val[o] = o === force ? forced : ~a;
    } else {
      // a stateless behaviour lane by lane (constants, small tables)
      const outs = leaf.outputs.map((p) => p.map(() => 0));
      for (let l = 0; l < lanes; l++) {
        const ins = leaf.inputs.map((p) => p.reduce((v, n, b) => v + (((val[n] >>> l) & 1) ? 2 ** b : 0), 0));
        const res = leaf.def.behavior!.eval(ins, undefined);
        leaf.outputs.forEach((p, k) => p.forEach((_, b) => { if (Math.floor(res[k] / 2 ** b) % 2) outs[k][b] |= 1 << l; }));
      }
      leaf.outputs.forEach((p, k) => p.forEach((n, b) => { val[n] = n === force ? forced : outs[k][b]; }));
    }
  }
}

/** Every vector of a block (0 … 2^inBits − 1), when it has at most MAX_EXHAUSTIVE input bits. */
export function allVectors(m: FaultModel): number[] {
  if (m.inBits > MAX_EXHAUSTIVE) throw new Error(`${m.inBits} input bits: too many for every vector`);
  return Array.from({ length: 2 ** m.inBits }, (_, v) => v);
}

/** The outputs of the good circuit (or with one fault) for each vector, packed as the outputs are (first port lowest). */
export function responses(m: FaultModel, vecs: readonly number[], fault?: StuckFault): number[] {
  const val = new Int32Array(m.design.netCount), out: number[] = [];
  for (let from = 0; from < vecs.length; from += 32) {
    evalWord(m, vecs, from, val, fault ? m.sites[fault.site].net : -1, fault?.v ?? 0);
    for (let l = 0; l < Math.min(32, vecs.length - from); l++) out.push(m.outNets.reduce((v, n, b) => v + (((val[n] >>> l) & 1) ? 2 ** b : 0), 0));
  }
  return out;
}

/** Which vectors detect which faults: for each fault, a bit set over `vecs` (word w, bit l = vector 32w + l). */
export interface Detection {
  vecs: readonly number[];
  words: number;
  /** faults.length × words. */
  hits: Uint32Array;
}

export function detect(m: FaultModel, vecs: readonly number[]): Detection {
  const words = Math.ceil(vecs.length / 32), hits = new Uint32Array(m.faults.length * words);
  const good = new Int32Array(m.design.netCount), bad = new Int32Array(m.design.netCount);
  for (let w = 0; w < words; w++) {
    const from = w * 32, lanes = Math.min(32, vecs.length - from), live = lanes === 32 ? -1 : (1 << lanes) - 1;
    evalWord(m, vecs, from, good);
    m.faults.forEach((f, i) => {
      const net = m.sites[f.site].net;
      // a vector whose good value already equals the stuck value cannot show the fault: skip the pass when none differs
      if (((f.v ? ~good[net] : good[net]) & live) === 0) return;
      evalWord(m, vecs, from, bad, net, f.v);
      let diff = 0;
      for (const n of m.outNets) diff |= good[n] ^ bad[n];
      hits[i * words + w] = (diff & live) >>> 0;
    });
  }
  return { vecs, words, hits };
}

export const detects = (d: Detection, fault: number, vec: number): boolean => ((d.hits[fault * d.words + (vec >>> 5)] >>> (vec & 31)) & 1) === 1;

/** Faults some vector of `d` detects. */
export function detectable(d: Detection, faults: number): number[] {
  const out: number[] = [];
  for (let f = 0; f < faults; f++) for (let w = 0; w < d.words; w++) if (d.hits[f * d.words + w]) { out.push(f); break; }
  return out;
}

/** Faults detected by the chosen vectors (indices into d.vecs). */
export function coveredBy(d: Detection, faults: number, chosen: readonly number[]): number[] {
  const out: number[] = [];
  for (let f = 0; f < faults; f++) if (chosen.some((v) => detects(d, f, v))) out.push(f);
  return out;
}

export interface Coverage {
  detected: number;
  total: number;
  /** Faults no chosen vector detects. */
  missed: number[];
}

/** Fault coverage of a test set (vectors as numbers). */
export function coverage(m: FaultModel, tests: readonly number[]): Coverage {
  const d = detect(m, tests);
  const hit = detectable(d, m.faults.length), set = new Set(hit);
  return { detected: hit.length, total: m.faults.length, missed: m.faults.map((_, i) => i).filter((i) => !set.has(i)) };
}

/**
 * Greedy cover: repeatedly the vector (index into d.vecs) catching the most faults not yet caught, lowest index on a tie,
 * until every detectable fault is caught.
 */
export function greedyCover(d: Detection, faults: number): number[] {
  let left = detectable(d, faults);
  const pick: number[] = [];
  while (left.length) {
    let best = -1, bn = 0;
    for (let v = 0; v < d.vecs.length; v++) {
      let n = 0;
      for (const f of left) if (detects(d, f, v)) n++;
      if (n > bn) { bn = n; best = v; }
    }
    pick.push(best);
    left = left.filter((f) => !detects(d, f, best));
  }
  return pick;
}

/**
 * A smallest cover (indices into d.vecs), by branch and bound: take the uncaught fault with the fewest detecting vectors and
 * try each of them, bounded by the best so far (the greedy cover to begin with). null when the search ran past `budget` nodes.
 */
export function exactCover(d: Detection, faults: number, budget = 3_000_000): number[] | null {
  const need = detectable(d, faults);
  const by = need.map((f) => { const vs: number[] = []; for (let v = 0; v < d.vecs.length; v++) if (detects(d, f, v)) vs.push(v); return vs; });
  let best = greedyCover(d, faults), nodes = 0, aborted = false;
  const chosen: number[] = [];
  const caught = new Uint16Array(need.length);
  const go = (): void => {
    if (aborted) return;
    if (++nodes > budget) { aborted = true; return; }
    let pickF = -1, few = Infinity;
    for (let i = 0; i < need.length; i++) if (!caught[i] && by[i].length < few) { few = by[i].length; pickF = i; }
    if (pickF < 0) { if (chosen.length < best.length) best = [...chosen]; return; }
    if (chosen.length + 1 >= best.length) return;
    for (const v of by[pickF]) {
      chosen.push(v);
      for (let i = 0; i < need.length; i++) if (detects(d, need[i], v)) caught[i]++;
      go();
      for (let i = 0; i < need.length; i++) if (detects(d, need[i], v)) caught[i]--;
      chosen.pop();
    }
  };
  go();
  return aborted ? null : best.sort((a, b) => a - b);
}

/** Seeded random vectors (xorshift32), the same sequence everywhere. */
export function randomVectors(m: FaultModel, n: number, seed = 1): number[] {
  let s = seed >>> 0 || 1;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    out.push(m.inBits >= 32 ? s : s % 2 ** m.inBits);
  }
  return out;
}

/** Faults detected after the first k vectors of `vecs`, for each k in `at`: the coverage curve of a test sequence. */
export function coverageCurve(m: FaultModel, vecs: readonly number[], at: readonly number[]): number[] {
  const d = detect(m, vecs);
  const first = m.faults.map((_, f) => { for (let v = 0; v < vecs.length; v++) if (detects(d, f, v)) return v; return Infinity; });
  return at.map((k) => first.filter((v) => v < k).length);
}
