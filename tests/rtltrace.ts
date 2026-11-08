// What every Rtl design does, cycle by cycle: seeded random inputs, every clock pin pulsed, every output read after each edge,
// hashed. tests/redrawclear-fsm.test.ts holds the hashes and NAND counts of every design to tests/fixtures/rtl-traces.json, so a
// drawing change (lib/rtl.ts's blocks) cannot change what a design does or what it costs.

import type { ComponentDef } from '../src/sim/types';
import { simulate } from '../src/sim/harness';
import { stats } from '../src/sim/stats';

const lcg = (seed: number) => { let s = seed >>> 0; return (n: number) => Math.floor(((s = (s * 1103515245 + 12345) >>> 0) / 2 ** 32) * n); };

export interface Trace { hash: string; nands: number; transistors: number }

/** A reset held most of the time would hide the design: resets are on for the first two cycles, then one cycle in 32. */
const resetLevel = (name: string, c: number, r: number): number | null => {
  const on = c < 2 || r === 0;
  if (/^(rst|reset|clr|init)/i.test(name)) return name.endsWith('n') || name.endsWith('_n') ? (on ? 0 : 1) : on ? 1 : 0;
  return null;
};

export function traceOf(def: ComponentDef, cycles = 400, seed = 7): Trace {
  const sim = simulate(def, 'gate');
  const rnd = lcg(seed);
  const ins = def.ports.filter((p) => p.dir === 'in'), outs = def.ports.filter((p) => p.dir === 'out');
  const clocks = ins.filter((p) => p.clock), data = ins.filter((p) => !p.clock);
  let h = 2166136261 >>> 0;
  const mix = (v: number) => { h = Math.imul(h ^ v, 16777619) >>> 0; };
  for (let c = 0; c < cycles; c++) {
    const r = rnd(32);
    for (const p of data) {
      const lv = p.width === 1 ? resetLevel(p.name, c, r) : null;
      sim.setInputBits(p.name, lv !== null ? [lv] : Array.from({ length: p.width }, () => rnd(2)));
    }
    sim.settle();
    for (const p of clocks) sim.setInput(p.name, 1);
    sim.settle();
    for (const p of clocks) sim.setInput(p.name, 0);
    sim.settle();
    for (const p of outs) for (const b of sim.getBits(sim.design.root.ports[p.name])) mix(b === 0 ? 1 : b === 1 ? 2 : 3);
  }
  const st = stats(def);
  return { hash: h.toString(16), nands: st.nands, transistors: st.transistors };
}
