// The cycle engine against GateSim in tests: every net equal after every settle, on random
// stimulus (data inputs sometimes X or all at once with the clock, X clocks, save / restore, a
// trace listener now and then), in each power-on mode.

import { expect, vi } from 'vitest';
import { DualSim } from '../src/sim/dualsim';
import { type FlatDesign, flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import type { PowerOnMode, Sim } from '../src/sim/sim';
import type { ComponentDef, PortDef } from '../src/sim/types';

export function rng(seed: number): () => number {
  let r = seed >>> 0;
  return () => ((r = (r * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

export function seedRandom(seed: number): void {
  const r = rng(seed);
  vi.spyOn(Math, 'random').mockImplementation(r);
}

/** Every net of a and b equal (the cycle engine reads cluster insides from its tables). */
export function sameNets(a: Sim, b: Sim, at: string): void {
  const n = a.design.netCount;
  for (let net = 0; net < n; net++) {
    if (a.get(net) !== b.get(net)) expect.fail(`${at}: net ${net} is ${a.get(net)} on the cycle engine, ${b.get(net)} on GateSim`);
  }
}

/** A DualSim allowed to use the cycle engine, next to a GateSim, both powered on alike. */
export function pair(def: ComponentDef | FlatDesign, mode: PowerOnMode, seed = 1): { dual: DualSim; ref: GateSim } {
  const d = 'leaves' in def ? def : flatten(def);
  const dual = new DualSim(d), ref = new GateSim(d);
  seedRandom(seed);
  dual.reset(mode);
  seedRandom(seed);
  ref.reset(mode);
  vi.restoreAllMocks();
  dual.preferFast = true;
  dual.prepare();
  return { dual, ref };
}

/**
 * Random stimulus on both: data inputs (sometimes X, sometimes all at once with the clock), clock
 * toggles (sometimes X), save / restore, a trace listener on and off. Returns the share of settles
 * the cycle engine did.
 */
export function lockstep(def: ComponentDef | FlatDesign, ops: number, seed: number, modes: PowerOnMode[] = ['zero', 'x', 'random'], xClock = true, clock = 'clk'): number {
  let fast = 0, total = 0;
  const root = 'leaves' in def ? def.root.def : def;
  for (const mode of modes) {
    const { dual, ref } = pair(def, mode, seed);
    sameNets(dual, ref, `${root.id} ${mode} power-on`);
    const rnd = rng(seed * 7 + 1);
    const ins = root.ports.filter((p) => p.dir === 'in');
    const clk = ins.find((p) => p.name === clock);
    const data = ins.filter((p) => p !== clk);
    let saved: [ReturnType<Sim['saveState']>, ReturnType<Sim['saveState']>] | null = null;
    const both = (f: (s: Sim) => void) => { f(dual); f(ref); };
    for (let k = 0; k < ops; k++) {
      const r = rnd();
      const value = (p: PortDef) => Math.floor(rnd() * 2 ** Math.min(p.width, 30));
      if (r < 0.45 && clk) both((s) => s.setInput(clock, 1 - Math.max(0, s.getInput(clock))));
      else if (r < 0.75 && data.length) {
        const p = data[Math.floor(rnd() * data.length)];
        if (rnd() < 0.1) {
          const bits = Array.from({ length: p.width }, () => (rnd() < 0.3 ? 2 : rnd() < 0.5 ? 1 : 0));
          both((s) => s.setInputBits(p.name, bits));
        } else {
          const v = value(p);
          both((s) => s.setInput(p.name, v));
        }
      } else if (r < 0.85) {
        // everything at once, the clock too
        const vs = data.map(value);
        const c = rnd() < 0.5 ? 1 : 0;
        both((s) => { data.forEach((p, i) => s.setInput(p.name, vs[i])); if (clk) s.setInput(clock, c); });
      } else if (r < 0.88 && clk && xClock) both((s) => s.setInputBits(clock, [2]));
      else if (r < 0.93) {
        if (saved && rnd() < 0.5) { dual.restoreState(saved[0]); ref.restoreState(saved[1]); } else saved = [dual.saveState(), ref.saveState()];
      }
      // now and then a trace listener for one settle: GateSim takes over, gives back after
      const traced = r >= 0.93 && r < 0.95;
      if (traced) dual.onTrace = () => {};
      if (dual.engine === 'cycle') fast++;
      total++;
      both((s) => s.settle());
      if (traced) dual.onTrace = undefined;
      sameNets(dual, ref, `${root.id} ${mode} op ${k}`);
    }
  }
  return fast / total;
}
