// Dynamic power, P ≈ α C V² f, estimated from the circuit itself: α from the gate simulator's toggle counts
// (glitches included: transport delay lets a net change several times before it settles), C per net from
// its fan-out (NAND inputs driven, the driver's own drain, a wire estimate per branch), V set by the learner
// and f from static timing. Every 0 → 1 transition draws C·V² from the supply (half lost in the pull-up, half
// stored) and the next 1 → 0 dissipates the stored half, so each toggle costs ½ C V². The capacitances are
// illustrative 28 nm-class values (like PS_PER_NAND), not extracted from a layout; leakage is not modelled.
// Behavioural leaves (the program ROM, large memories) switch nothing inside: only their outputs are counted.

import { flatten, type FlatDesign, type HierNode } from './flatten';
import { GateSim } from './gatesim';
import { needsSwitchLevel } from './harness';
import { hasFeedback, logicDepth, stats } from './stats';
import { analyzeTiming, PS_PER_NAND } from './timing';
import { type ComponentDef, inPorts } from './types';
import { driverOf, FF_DRIVER, FF_INPUT, FF_WIRE, netCaps } from './netcap';

export { driverOf, FF_DRIVER, FF_INPUT, FF_WIRE, netCaps };

/** The default supply (V), a 28 nm-class core voltage. */
export const VDD = 0.9;

export const POWER_NOTE = `An estimate: C per net is ${FF_INPUT} fF per NAND input driven + ${FF_DRIVER} fF for the driver + ${FF_WIRE} fF of wire per branch (illustrative 28 nm-class values, like the ${PS_PER_NAND} ps per NAND), each toggle costs ½ C V², counted from the gate simulation with its glitches; no leakage, no clock buffers, behavioural memories counted at their outputs only.`;

/** ½ C V²: energy (fJ) of `switched` fF·toggles at `v` volts. */
export const energyFj = (switched: number, v = VDD) => 0.5 * switched * v * v;

/** Clock frequency (Hz) of a period in NAND delays. */
export const hzOf = (period: number) => 1e12 / (period * PS_PER_NAND);

/** Power (W) of `fj` femtojoules spent every period of `period` NAND delays. */
export const powerW = (fj: number, period: number) => fj * 1e-15 * hzOf(period);

const scaled = (x: number, units: [number, string][], digits: number) => {
  const a = Math.abs(x);
  const [k, u] = units.find(([k]) => a >= k) ?? units[units.length - 1];
  const v = x / k;
  return `${v.toFixed(Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 10 ? Math.max(0, digits - 2) : digits - 1)} ${u}`;
};
/** An energy given in fJ, in fJ / pJ / nJ / µJ / mJ. */
export const fmtEnergy = (fj: number, digits = 3) => scaled(fj, [[1e12, 'mJ'], [1e9, 'µJ'], [1e6, 'nJ'], [1e3, 'pJ'], [1, 'fJ']], digits);
/** A power given in W, in nW … W. */
export const fmtPower = (w: number, digits = 3) => scaled(w, [[1, 'W'], [1e-3, 'mW'], [1e-6, 'µW'], [1e-9, 'nW']], digits);

/** One row of a breakdown: a child instance (or the nets driven from outside, `child` absent). */
export interface PowerShare {
  name: string;
  child?: HierNode;
  /** fF·toggles of the nets this part drives. */
  switched: number;
}

/**
 * Switching activity of a GateSim from a starting point: `reset()` takes the current toggle counts and
 * settled values as zero; `mark()` after each settle adds the settled changes (a net's functional
 * toggles), so glitch toggles are the rest. Counting stays on in the simulation once a meter is made.
 */
export class PowerMeter {
  readonly design: FlatDesign;
  readonly caps: Float64Array;
  private base: Uint32Array;
  private snap: Uint8Array;
  private func: Uint32Array;
  /** Settles marked since reset (vectors applied, or half clock cycles). */
  marks = 0;

  constructor(readonly sim: GateSim) {
    this.design = sim.design;
    this.caps = netCaps(sim.design);
    if (!sim.toggles) sim.countToggles();
    const n = sim.design.netCount;
    this.base = new Uint32Array(n);
    this.snap = new Uint8Array(n);
    this.func = new Uint32Array(n);
    this.reset();
  }

  reset(): void {
    if (!this.sim.toggles) this.sim.countToggles();
    this.base.set(this.sim.toggles!);
    for (let i = 0; i < this.snap.length; i++) this.snap[i] = this.sim.get(i);
    this.func.fill(0);
    this.marks = 0;
  }

  /** After a settle: count the nets whose settled value went 0 ↔ 1 since the last mark. */
  mark(): void {
    const { snap, func, sim } = this;
    for (let i = 0; i < snap.length; i++) {
      const b = sim.get(i), o = snap[i];
      if (b !== o) { if ((b | o) === 1) func[i]++; snap[i] = b; }
    }
    this.marks++;
  }

  /** Toggles of net i since reset. */
  toggles(i: number): number {
    return (this.sim.toggles?.[i] ?? 0) - this.base[i];
  }

  /** Σ C · toggles (fF) over every net, and over its settled (glitch-free) toggles. */
  totals(): { switched: number; functional: number; toggles: number } {
    let switched = 0, functional = 0, toggles = 0;
    const t = this.sim.toggles;
    if (!t) return { switched, functional, toggles };
    for (let i = 0; i < this.caps.length; i++) {
      const k = t[i] - this.base[i];
      toggles += k;
      switched += k * this.caps[i];
      functional += this.func[i] * this.caps[i];
    }
    return { switched, functional, toggles };
  }

  /**
   * The switched capacitance of `node`'s nets split by the child that drives them (a net is charged by its
   * driver), largest first; at the root, nets driven from outside (inputs) come as rows of their own, the
   * clock by name. Children that switch nothing are left out.
   */
  breakdown(node: HierNode = this.design.root): PowerShare[] {
    const d = this.design, dr = driverOf(d), k = node.path.length;
    const t = this.sim.toggles;
    const byChild = new Map<string, number>();
    let outside = 0, clock = 0;
    const clk = node.parent ? undefined : new Set(node.ports.clk ?? []);
    if (t) {
      for (let i = 0; i < this.caps.length; i++) {
        const s = (t[i] - this.base[i]) * this.caps[i];
        if (!s) continue;
        const li = dr[i];
        if (li < 0) {
          if (!clk) continue;
          if (clk.has(i)) clock += s;
          else outside += s;
          continue;
        }
        const p = d.leaves[li].node.path;
        if (p.length <= k || p.slice(0, k).some((x, j) => x !== node.path[j])) continue;
        const c = p[k];
        byChild.set(c, (byChild.get(c) ?? 0) + s);
      }
    }
    const rows: PowerShare[] = [...byChild].map(([name, switched]) => ({ name, child: node.children?.get(name), switched }));
    if (clock) rows.push({ name: 'clock (clk net)', switched: clock });
    if (outside) rows.push({ name: 'inputs (driven from outside)', switched: outside });
    return rows.sort((a, b) => b.switched - a.switched);
  }
}

/** A measurement on generated stimuli: switched capacitance per operation (a vector, or a clock cycle). */
export interface PowerReport {
  kind: 'vectors' | 'cycles';
  /** Vectors applied, or clock cycles run. */
  units: number;
  /** fF·toggles per unit, all toggles and settled ones only. */
  switched: number;
  functional: number;
  /** 0 ↔ 1 transitions per unit. */
  toggles: number;
  /** Nets of the flattened design, and Σ C (fF). */
  nets: number;
  cap: number;
  /** NAND delays per unit at full speed: the logic depth, or the static-timing period (undefined: none found). */
  period?: number;
  /** Per child, fF·toggles per unit. */
  shares: PowerShare[];
  root: HierNode;
}

/** Activity factor α of P = α C V² f: 0 → 1 transitions per unit, weighted by C, over Σ C. */
export const alphaOf = (r: Pick<PowerReport, 'switched' | 'cap'>) => r.switched / 2 / r.cap;

/** Why a component cannot be measured here ('' if it can). */
export function powerRefusal(def: ComponentDef, maxNands = 40_000): string {
  if (def.prim && def.prim !== 'nand') return 'A primitive: nothing switches inside.';
  if (needsSwitchLevel(def)) return 'Transistor-level circuit: the switch-level solver has no time, so it cannot count glitches.';
  const n = stats(def).nands;
  if (!n) return 'No gates inside.';
  if (n > maxNands) return `${n.toLocaleString()} NANDs: too large to measure on random inputs here.`;
  if (!inPorts(def).length) return 'No inputs to drive.';
  return '';
}

/** A seeded generator of 32-bit words (xorshift32). */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s; };
}

const CONTROL = /^(clk|rst|reset|clr|clear|arst|rst_n|reset_n)$/i;

/**
 * Measure a component on random inputs: a combinational part on `units` random vectors (each applied after
 * the last settled), a clocked one (a `clk` input) for `units` cycles with random data inputs each cycle
 * (resets and clears held inactive at 0). Seeded: the same numbers every time.
 */
export function measurePower(def: ComponentDef, units = 256, seed = 1): PowerReport {
  const design = flatten(def, { mode: 'gate' });
  const sim = new GateSim(design);
  const ins = inPorts(def);
  const clocked = ins.some((p) => p.name === 'clk') && hasFeedback(def);
  const data = ins.filter((p) => !CONTROL.test(p.name));
  const r = rng(seed);
  const randomize = () => {
    for (const p of data) {
      const bits = new Uint8Array(p.width);
      for (let i = 0; i < p.width; i += 32) {
        const w = r();
        for (let j = 0; j < 32 && i + j < p.width; j++) bits[i + j] = (w >>> j) & 1;
      }
      sim.setInputBits(p.name, bits);
    }
  };
  for (const p of ins) sim.setInput(p.name, 0);
  randomize();
  sim.settle();
  if (clocked) { sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.settle(); }
  const m = new PowerMeter(sim);
  for (let u = 0; u < units; u++) {
    // new data (while the clock is low), then a full cycle
    randomize();
    sim.settle(); m.mark();
    if (clocked) {
      sim.setInput('clk', 1); sim.settle(); m.mark();
      sim.setInput('clk', 0); sim.settle(); m.mark();
    }
  }
  const t = m.totals();
  let cap = 0;
  for (const c of m.caps) cap += c;
  const period = clocked ? analyzeTiming(design)?.period : logicDepth(def) ?? undefined;
  return {
    kind: clocked ? 'cycles' : 'vectors', units,
    switched: t.switched / units, functional: t.functional / units, toggles: t.toggles / units,
    nets: design.netCount, cap, ...(period ? { period } : {}),
    shares: m.breakdown().map((s) => ({ ...s, switched: s.switched / units })),
    root: design.root,
  };
}

/** Switched capacitance per vector (fF·toggles) over a given sequence of packed input vectors, each applied once the last has settled. */
export function vectorPower(def: ComponentDef, vectors: number[][]): { switched: number; functional: number } {
  const sim = new GateSim(flatten(def, { mode: 'gate' }));
  const ins = inPorts(def);
  const apply = (v: number[]) => ins.forEach((p, i) => sim.setInput(p.name, v[i]));
  apply(vectors[0]);
  sim.settle();
  const m = new PowerMeter(sim);
  for (let i = 1; i < vectors.length; i++) { apply(vectors[i]); sim.settle(); m.mark(); }
  const t = m.totals(), n = Math.max(1, vectors.length - 1);
  return { switched: t.switched / n, functional: t.functional / n };
}
