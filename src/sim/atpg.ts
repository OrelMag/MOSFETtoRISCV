// Automatic test pattern generation in miniature (DOM-free; docs/PLAN-VERIFY.md): find one input vector that shows a
// stuck-at fault at an output, or prove there is none. PODEM's search, small enough to follow step by step:
//
//   activate  drive the faulty net to the opposite of its stuck value (the good circuit and the faulty one now differ there)
//   propagate pick a gate on the D-frontier (a difference at an input, the output still unknown) and ask its other inputs for
//             the value that lets a NAND pass a change: 1
//   justify   trace an objective back through the gates to an input not yet set (a NAND's 0 needs every input 1, its 1 any
//             input 0), set it, and simulate both circuits on three values (0, 1, X)
//   backtrack when an objective can no longer be met, flip the last input set, then free it
//
// Each net carries two values, the good circuit's and the faulty one's; a net where both are known and differ is what the
// D-algorithm writes D (1 / 0) or D̄ (0 / 1). Gate-level blocks of NANDs and constants (sim/faultsim.ts's FaultModel).
// tests/atpg.test.ts: every vector returned is checked by the fault simulator, and every detectable fault of the chapter's
// blocks gets one; the consensus circuit's redundant fault is proved untestable.

import type { FaultModel, StuckFault } from './faultsim';

export const X = 2;
type V = 0 | 1 | 2;

export type AtpgStepKind = 'activate' | 'propagate' | 'assign' | 'backtrack' | 'detected' | 'untestable' | 'aborted';

export interface AtpgStep {
  kind: AtpgStepKind;
  /** The net the step is about: the objective's, or the input set. */
  net?: number;
  value?: 0 | 1;
  /** Input bit (for assign / backtrack). */
  input?: number;
  /** The gate whose input is the objective (propagate): its leaf index. */
  gate?: number;
  text: string;
}

export interface AtpgResult {
  fault: StuckFault;
  status: 'test' | 'untestable' | 'aborted';
  /** The test, unset inputs as 0. */
  vector?: number;
  /** Per input bit: the value the search set, or null (any value works). */
  cube?: (0 | 1 | null)[];
  steps: AtpgStep[];
  backtracks: number;
}

/** Leaves in order with their drivers and each net's distance to an output, computed once per model. */
interface Prep {
  driver: Int32Array;
  /** Gates from the net to the nearest output (Infinity: reaches none). */
  toOut: Float64Array;
  /** Gates from the inputs to the net (its level). */
  level: Int32Array;
  inBit: Int32Array;
  isOut: Uint8Array;
}

const preps = new WeakMap<FaultModel, Prep>();
function prep(m: FaultModel): Prep {
  const had = preps.get(m);
  if (had) return had;
  const n = m.design.netCount, leaves = m.design.leaves;
  const driver = new Int32Array(n).fill(-1), level = new Int32Array(n), inBit = new Int32Array(n).fill(-1), isOut = new Uint8Array(n);
  m.inNets.forEach((net, b) => { inBit[net] = b; });
  for (const net of m.outNets) isOut[net] = 1;
  for (const li of m.order) {
    const l = leaves[li];
    const lv = 1 + Math.max(0, ...l.inputs.flat().map((x) => level[x]));
    for (const p of l.outputs) for (const net of p) { driver[net] = li; level[net] = lv; }
  }
  const toOut = new Float64Array(n).fill(Infinity);
  for (const net of m.outNets) toOut[net] = 0;
  for (let k = m.order.length - 1; k >= 0; k--) {
    const l = leaves[m.order[k]];
    const d = Math.min(...l.outputs.flat().map((x) => toOut[x])) + 1;
    for (const x of l.inputs.flat()) if (d < toOut[x]) toOut[x] = d;
  }
  const p = { driver, toOut, level, inBit, isOut };
  preps.set(m, p);
  return p;
}

const nand3 = (ins: readonly number[], v: Uint8Array): V => {
  let any0 = false, allKnown = true;
  for (const x of ins) { if (v[x] === 0) any0 = true; else if (v[x] === X) allKnown = false; }
  return any0 ? 1 : allKnown ? 0 : X;
};

/** Find a test for one stuck-at fault. `budget` caps the backtracks (aborted beyond it). */
export function atpg(m: FaultModel, fault: StuckFault | number, budget = 5000): AtpgResult {
  const f = typeof fault === 'number' ? m.faults[fault] : fault;
  const P = prep(m), leaves = m.design.leaves, site = m.sites[f.site].net, stuck = f.v;
  const n = m.design.netCount;
  const g = new Uint8Array(n), b = new Uint8Array(n);
  const pi = new Uint8Array(m.inBits).fill(X);
  const steps: AtpgStep[] = [];
  let backtracks = 0, aborted = false;
  const name = (net: number) => {
    const s = m.siteOf[net];
    if (s >= 0) return m.sites[s].name;
    const d = P.driver[net];
    return d >= 0 ? leaves[d].node.path.join('.') : `net ${net}`;
  };

  /** Three-valued simulation of both circuits from the inputs set so far. */
  const imply = () => {
    g.fill(X); b.fill(X);
    m.inNets.forEach((net, i) => { g[net] = pi[i]; b[net] = pi[i]; });
    if (P.inBit[site] >= 0) b[site] = stuck;
    for (const li of m.order) {
      const l = leaves[li];
      if (l.kind === 'nand') {
        const ins = l.inputs.flat(), o = l.outputs[0][0];
        g[o] = nand3(ins, g);
        b[o] = o === site ? stuck : nand3(ins, b);
      } else {
        // a constant: no inputs, evaluated once
        const res = l.def.behavior!.eval([], undefined);
        l.outputs.forEach((p, k) => p.forEach((o, bit) => { const v = (Math.floor(res[k] / 2 ** bit) % 2) as 0 | 1; g[o] = v; b[o] = o === site ? stuck : v; }));
      }
    }
  };
  const differs = (net: number) => g[net] !== X && b[net] !== X && g[net] !== b[net];
  const detected = () => m.outNets.some(differs);

  /** The next objective, or null when the fault can no longer be shown under these inputs. */
  const objective = (): { net: number; value: 0 | 1; gate?: number } | null => {
    if (g[site] === X) return { net: site, value: (1 - stuck) as 0 | 1 };
    if (g[site] === stuck) return null;
    let best = -1, bestD = Infinity;
    for (const li of m.order) {
      const l = leaves[li];
      if (l.kind !== 'nand') continue;
      const o = l.outputs[0][0];
      if (g[o] !== X && b[o] !== X) continue;
      if (!l.inputs.flat().some(differs)) continue;
      if (!l.inputs.flat().some((x) => g[x] === X)) continue;
      if (P.toOut[o] < bestD) { bestD = P.toOut[o]; best = li; }
    }
    if (best < 0 || bestD === Infinity) return null;
    const free = leaves[best].inputs.flat().find((x) => g[x] === X);
    return free === undefined ? null : { net: free, value: 1, gate: best };
  };

  /** Back from an objective to an input that is not set yet. */
  const backtrace = (net: number, value: 0 | 1): { input: number; value: 0 | 1 } | null => {
    for (;;) {
      if (P.inBit[net] >= 0) return { input: P.inBit[net], value };
      const d = P.driver[net];
      if (d < 0 || leaves[d].kind !== 'nand') return null;
      const ins = leaves[d].inputs.flat().filter((x) => g[x] === X);
      if (!ins.length) return null;
      // a NAND's 0 needs every input at 1: start with the hardest (deepest); its 1 needs one 0: the easiest
      ins.sort((a, c) => (value === 0 ? P.level[c] - P.level[a] : P.level[a] - P.level[c]));
      net = ins[0];
      value = value === 0 ? 1 : 0;
    }
  };

  const search = (): boolean => {
    imply();
    if (detected()) return true;
    const obj = objective();
    if (!obj) return false;
    steps.push(obj.gate === undefined
      ? { kind: 'activate', net: obj.net, value: obj.value, text: `Activate: ${name(obj.net)} must be ${obj.value} in the good circuit (the fault holds it at ${stuck})` }
      : { kind: 'propagate', net: obj.net, value: 1, gate: obj.gate, text: `Propagate through ${leaves[obj.gate].node.path.join('.')}: its other input ${name(obj.net)} must be 1 to let the difference pass` });
    const t = backtrace(obj.net, obj.value);
    if (!t) return false;
    for (const v of [t.value, (1 - t.value) as 0 | 1]) {
      pi[t.input] = v;
      steps.push({ kind: 'assign', input: t.input, net: m.inNets[t.input], value: v, text: `Set ${name(m.inNets[t.input])} = ${v}` });
      if (search()) return true;
      if (aborted) return false;
      if (++backtracks > budget) { aborted = true; return false; }
      steps.push({ kind: 'backtrack', input: t.input, net: m.inNets[t.input], value: v, text: `Conflict: ${name(m.inNets[t.input])} = ${v} cannot show the fault; ${v === t.value ? 'try the other value' : 'free it and go back'}` });
    }
    pi[t.input] = X;
    imply();
    return false;
  };

  const ok = search();
  if (ok) {
    const cube = Array.from(pi, (v) => (v === X ? null : (v as 0 | 1)));
    const vector = cube.reduce<number>((s, v, i) => s + (v ? 2 ** i : 0), 0);
    const out = m.outNets.find(differs)!;
    steps.push({ kind: 'detected', net: out, text: `Detected: output ${name(out)} is ${g[out]} in the good circuit and ${b[out]} with the fault` });
    return { fault: f, status: 'test', vector, cube, steps, backtracks };
  }
  steps.push(aborted
    ? { kind: 'aborted', text: `Gave up after ${budget} backtracks` }
    : { kind: 'untestable', text: `Every choice tried: no input vector shows ${name(site)} stuck at ${stuck}. The fault is redundant` });
  return { fault: f, status: aborted ? 'aborted' : 'untestable', steps, backtracks };
}
