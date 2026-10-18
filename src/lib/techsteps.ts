// The steps on a design's worst path, for the technology setting (lib/tech.ts): NAND delays of a combinational
// part's depth or of a clocked part's period; for a native relay circuit, relay steps measured on the switch-level
// simulator (random input changes, each settled from the last). Kept apart from tech.ts so that pricing from
// counts alone (the Statistics tab) does not pull in the simulators.

import { flatten } from '../sim/flatten';
import { needsSwitchLevel } from '../sim/harness';
import { hasFeedback, logicDepth } from '../sim/stats';
import { SwitchSim } from '../sim/switchsim';
import { analyzeTiming } from '../sim/timing';
import { type ComponentDef, inPorts } from '../sim/types';
import { partKind } from './tech';

export interface DesignSteps {
  /** Steps on the worst path (null: not measurable, e.g. a tube circuit, an oscillator). */
  steps: number | null;
  /** A clocked part: the steps are its clock period. */
  clocked: boolean;
}

const cache = new WeakMap<ComponentDef, DesignSteps>();

export function designSteps(def: ComponentDef): DesignSteps {
  const hit = cache.get(def);
  if (hit) return hit;
  let r: DesignSteps = { steps: null, clocked: false };
  try {
    const kind = partKind(def);
    if (kind === 'relay') r = { steps: relaySteps(def), clocked: false };
    else if (def.prim === 'nand') r = { steps: 1, clocked: false };
    else if (kind === 'nand' && !needsSwitchLevel(def)) {
      if (!hasFeedback(def)) r = { steps: logicDepth(def), clocked: false };
      else r = { steps: analyzeTiming(flatten(def, { mode: 'gate' }))?.period ?? null, clocked: true };
    }
  } catch { /* unmeasurable: a dash */ }
  cache.set(def, r);
  return r;
}

/** A tiny deterministic generator, so the measured steps never change between visits. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/**
 * The most relay steps any input change takes to settle: every single-bit change from every input combination when
 * there are at most 8 input bits, else `samples` random changes. Null if it never settles (a buzzer) or has no inputs.
 */
export function relaySteps(def: ComponentDef, samples = 64): number | null {
  const ports = inPorts(def);
  if (!ports.length) return null;
  const sim = new SwitchSim(flatten(def, { mode: 'switch' }));
  const bits = ports.reduce((n, p) => n + p.width, 0);
  const apply = (v: number[]) => ports.forEach((p, i) => sim.setInput(p.name, v[i]));
  const word = (p: { width: number }, r: () => number) => Math.floor(r() * 2 ** Math.min(p.width, 30));
  const settle = (): number | null => {
    const t0 = sim.time;
    sim.settle();
    return sim.unstable ? null : sim.time - t0;
  };
  let worst = 0;
  if (bits <= 8) {
    for (let v = 0; v < 2 ** bits; v++) {
      for (let b = 0; b < bits; b++) {
        apply(split(v, ports));
        if (settle() === null) return null;
        apply(split(v ^ (1 << b), ports));
        const s = settle();
        if (s === null) return null;
        worst = Math.max(worst, s);
      }
    }
    return worst;
  }
  const r = rng(1);
  apply(ports.map((p) => word(p, r)));
  if (settle() === null) return null;
  for (let k = 0; k < samples; k++) {
    apply(ports.map((p) => word(p, r)));
    const s = settle();
    if (s === null) return null;
    worst = Math.max(worst, s);
  }
  return worst;
}

/** A packed input combination as one value per port, first port in the low bits. */
function split(v: number, ports: { width: number }[]): number[] {
  const out: number[] = [];
  for (const p of ports) {
    out.push(v & ((1 << p.width) - 1));
    v >>>= p.width;
  }
  return out;
}
