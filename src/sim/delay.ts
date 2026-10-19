// Load-dependent delay (Phase 19): a NAND's delay by logical effort instead of one unit for every gate.
// d = p + g·h in units of τ, with NAND2's logical effort g = 4/3 and parasitic delay p = 2, and h the
// electrical effort: the capacitance the output drives (NAND inputs and wire, from power.ts's netCaps; the
// driver's own drain is in p) over one NAND input's. Every NAND is minimum size, as drawn; where a net's
// load is large, a chain of inverter pairs in front of it (sized by logical effort, polarity kept) is
// assumed when it is faster, as synthesis would insert one, and the buffers are not counted as NANDs.
// The unit is the delay of a NAND driving one NAND input (four in five NAND outputs in the CPUs), so a
// ripple chain keeps its unit-delay numbers and a loaded net costs more. Behavioural leaves keep their
// declared delay; root inputs are ideal sources.

import type { FlatDesign } from './flatten';
import type { TimingReport } from './timing';
import { FF_DRIVER as DRIVER_OWN, FF_INPUT, FF_WIRE, netCaps } from './netcap';

/** 'unit': every NAND 1. 'load': by its load, buffered where that pays. 'drawn': by its load, minimum size, no buffers. */
export type DelayModel = 'unit' | 'load' | 'drawn';

/** NAND2: logical effort and parasitic delay (τ). An inverter: 1 and 1. */
export const G_NAND = 4 / 3;
export const P_NAND = 2;
export const P_INV = 1;

/** Delay (τ) of a NAND2 driving `load` fF, its own size fixed, with `pairs` inverter pairs of buffering. */
export function effortDelay(load: number, pairs = 0): number {
  const f = G_NAND * (load / FF_INPUT); // path effort: the inverters' g = 1, branching none
  const stages = 1 + 2 * pairs;
  return stages * f ** (1 / stages) + P_NAND + 2 * pairs * P_INV;
}

/** One delay unit in τ: a NAND2 driving one NAND input over one wire branch. */
export const TAU_PER_UNIT = effortDelay(FF_INPUT + FF_WIRE);

/** The best buffering of a NAND driving `load` fF: inverter pairs and the delay in units. */
export function bestBuffering(load: number): { pairs: number; delay: number } {
  let best = { pairs: 0, delay: effortDelay(load) };
  for (let pairs = 1; pairs <= 8; pairs++) {
    const d = effortDelay(load, pairs);
    if (d >= best.delay) break; // convex in the number of stages
    best = { pairs, delay: d };
  }
  return { pairs: best.pairs, delay: best.delay / TAU_PER_UNIT };
}

/** Delay of a NAND driving `load` fF, in units: as drawn (no buffers), or with the best buffer chain. */
export const nandDelay = (load: number, buffered = true) =>
  buffered ? bestBuffering(load).delay : effortDelay(load) / TAU_PER_UNIT;

const ONE_INPUT = FF_INPUT + FF_WIRE;
const loadCache = new WeakMap<FlatDesign, Float64Array>();

/**
 * The load (fF) on every net as its driver sees it: the NAND inputs and wire it drives (netCaps without the
 * driver's own drain, which logical effort has in p), plus one NAND input on each of the root's outputs,
 * so a part measured alone is measured between gates, as it would be used.
 */
export function netLoads(d: FlatDesign): Float64Array {
  const hit = loadCache.get(d);
  if (hit) return hit;
  const caps = netCaps(d), out = new Float64Array(d.netCount);
  for (const l of d.leaves) for (const p of l.outputs) for (const net of p) out[net] = -DRIVER_OWN;
  for (let n = 0; n < d.netCount; n++) out[n] += caps[n];
  for (const p of d.root.def.ports) if (p.dir === 'out') for (const net of d.root.ports[p.name] ?? []) out[net] += ONE_INPUT;
  loadCache.set(d, out);
  return out;
}

/** Fan-out (NAND inputs, each with its wire) that a load of `load` fF stands for. */
export const fanoutOf = (load: number) => Math.max(0, Math.round(load / ONE_INPUT));

const leafCache = { load: new WeakMap<FlatDesign, Float64Array>(), drawn: new WeakMap<FlatDesign, Float64Array>() };

/**
 * Delay of every leaf in units under `model`. 'unit': a NAND 1, a behaviour its declared delay (1 if none).
 * 'load': a NAND by its output's load (the larger if it drives several nets), buffered where that pays; 'drawn': unbuffered.
 */
export function leafDelays(d: FlatDesign, model: DelayModel): Float64Array {
  if (model !== 'unit') {
    const hit = leafCache[model].get(d);
    if (hit) return hit;
  }
  const loads = model !== 'unit' ? netLoads(d) : null;
  const out = new Float64Array(d.leaves.length);
  d.leaves.forEach((l, i) => {
    if (l.kind !== 'nand') { out[i] = l.def.behavior?.delay ?? 1; return; }
    if (!loads) { out[i] = 1; return; }
    let load = 0;
    for (const p of l.outputs) for (const net of p) load = Math.max(load, loads[net]);
    out[i] = nandDelay(load, model === 'load');
  });
  if (model !== 'unit') leafCache[model].set(d, out);
  return out;
}

const inputCache = { load: new WeakMap<FlatDesign, Float64Array>(), drawn: new WeakMap<FlatDesign, Float64Array>() };

/**
 * Arrival time of every net nothing inside drives (0 but under the load model): a root input is driven by a
 * minimum NAND outside, so the time that NAND takes beyond one unit (its load beyond one input) counts.
 */
export function inputArrivals(d: FlatDesign, model: DelayModel): Float64Array | null {
  if (model === 'unit') return null;
  const hit = inputCache[model].get(d);
  if (hit) return hit;
  const loads = netLoads(d), out = new Float64Array(d.netCount);
  for (const p of d.root.def.ports) {
    if (p.dir !== 'in') continue;
    for (const net of d.root.ports[p.name] ?? []) out[net] = Math.max(0, nandDelay(loads[net], model === 'load') - 1);
  }
  inputCache[model].set(d, out);
  return out;
}

/** Picoseconds per τ: an illustrative 28 nm-class value (an FO4 inverter ≈ 5 τ ≈ 20 ps), like PS_PER_NAND. */
export const PS_PER_TAU = 4;
/** Picoseconds per unit of the load model. */
export const PS_PER_UNIT = PS_PER_TAU * TAU_PER_UNIT;

export const DELAY_NOTE = `Load-dependent delay: each NAND by logical effort, d = p + g·h (NAND2: g = 4/3, p = 2 τ), h its load over one input (${FF_INPUT} fF per NAND input driven + ${FF_WIRE} fF of wire per branch, as for power): minimum-size gates as drawn, with a chain of inverter pairs assumed where a net's load makes one faster (not counted in the NANDs). One unit = a NAND driving one NAND input (${TAU_PER_UNIT.toFixed(2)} τ, ≈ ${PS_PER_UNIT.toFixed(1)} ps at an illustrative ${PS_PER_TAU} ps per τ). A part alone is measured between gates: each input driven by a minimum NAND, each output loading one NAND input. Wire length is not modelled: a drawing's wires are not a layout's.`;

/** A load-model number as text: one decimal, a unit-model one as an integer. */
export const fmtDelay = (x: number, model: DelayModel) => (model === 'unit' ? String(Math.round(x)) : x.toFixed(1));

/** Words for a delay figure: "NAND delays" or "units". */
export const delayWord = (model: DelayModel) => (model === 'unit' ? 'NAND delays' : 'units');

/** Picoseconds per delay under a model (unit: PS_PER_NAND, passed in to keep timing.ts out of the cycle). */
export const psPer = (model: DelayModel, psPerNand: number) => (model === 'unit' ? psPerNand : PS_PER_UNIT);

export interface HeavyNet {
  /** The leaf driving the net (hierarchical path). */
  node: string[];
  fanout: number;
  /** Its delay on the path, in units, and the inverter pairs assumed in front of the load. */
  delay: number;
  pairs: number;
}

/** The most heavily loaded nets on a load-model critical path (fan-out above 4), heaviest first. */
export function heavyNets(r: TimingReport, n = 4): HeavyNet[] {
  if (r.model === 'unit') return [];
  const out: HeavyNet[] = [];
  r.path.forEach((p, i) => {
    const fo = p.fanout ?? 0;
    if (fo <= 4) return;
    const delay = p.arrival - (i ? r.path[i - 1].arrival : r.launch.length ? r.stages[0].arrival : 0);
    out.push({ node: p.node, fanout: fo, delay, pairs: r.model === 'load' ? bestBuffering(fo * ONE_INPUT).pairs : 0 });
  });
  return out.sort((a, b) => b.fanout - a.fanout).slice(0, n);
}
