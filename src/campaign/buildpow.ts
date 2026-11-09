// Act 3's optional level "Clock gate" (the Power chapter's ICG, lib/clockgate.ts): gclk passes clk only while en is 1, and
// only whole pulses. The bench changes en at every moment of the clock period outside the gate's setup and hold window and
// fails a pulse cut short, one too many or one missing; a bare clk AND en fails it. Reference: the level's own 4-NAND D latch
// (rv16_dlatch) open while clk is low, an inverter, and the AND as a NAND and an inverter: 7 NANDs. No DOM.

import type { BuildChallenge, CustomRun, PinSpec } from '../editor/challenges';
import { docFromDef } from '../editor/fromdef';
import type { ChipDoc } from '../editor/model';
import { define } from '../lib/define';
import { NOT } from '../lib/gates';
import { NAND } from '../lib/transistors';
import { RV16_DLATCH } from '../lib/rv16/logic';
import { flatten } from '../sim/flatten';
import { GateSim } from '../sim/gatesim';
import type { ComponentDef } from '../sim/types';

/** The bench's clock: high for HALF gate delays, low for HALF. */
export const ICG_HALF = 12;
/** en changes from HOLD delays after a rising edge to SETUP before the next. */
export const ICG_BENCH_HOLD = 2;
export const ICG_BENCH_SETUP = 6;
const CYCLES = 6;

/** The reference: the latch open while clk is low (its enable is ¬clk), then gclk = clk · latched en. */
export const RV16_ICG: ComponentDef = define({
  id: 'rv16_icg', name: 'Clock gate (7 NANDs)', category: 'sequential',
  summary: 'gclk = clk · en, with en held in a latch that is open only while clk is low: en may change in the low half, and is frozen through the high half, so the AND passes whole pulses or none.',
  ports: [{ name: 'en', width: 1, dir: 'in' }, { name: 'clk', width: 1, dir: 'in', clock: true }, { name: 'gclk', width: 1, dir: 'out' }],
  symbol: { kind: 'box', label: 'ICG' },
  netlist: () => ({
    pins: { en: [1, 4], clk: [1, 12], gclk: [35, 6] },
    instances: [
      { name: 'inv', def: NOT, at: [3, 11] },
      { name: 'latch', def: RV16_DLATCH, at: [9, 2] },
      { name: 'nand', def: NAND, at: [23, 4] },
      { name: 'inv2', def: NOT, at: [29, 5] },
    ],
    nets: [
      { name: 'en', ends: ['en', 'latch.d'] },
      { name: 'clk', ends: ['clk', 'inv.a', 'nand.b'], via: { 'nand.b': [[2, 12], [2, 14], [21, 14], [21, 7]] } },
      { name: 'clk_n', ends: ['inv.y', 'latch.e'], trunk: 7.5 },
      { name: 'en_l', ends: ['latch.q', 'nand.a'] },
      { name: 'gclk_n', ends: ['nand.y', 'inv2.a'] },
      { name: 'gclk', ends: ['inv2.y', 'gclk'] },
    ],
  }),
});

/** One run: en toggled `at` delays after every rising edge (null: held at `hold`). Returns the first problem, or ''. */
function runOnce(def: ComponentDef, at: number | null, hold = 0): string {
  const sim = new GateSim(flatten(def, { mode: 'gate' }));
  sim.setInput('clk', 0);
  sim.setInput('en', at === null ? hold : 0);
  sim.reset('zero');
  sim.settle();
  const out = sim.design.root.ports.gclk[0];
  const P = 2 * ICG_HALF;
  const pulses: { cycle: number; width: number }[] = [];
  let rose = -1, en = at === null ? hold : 0, t = 0;
  const expectOn: boolean[] = [];
  for (let c = 0; c < CYCLES; c++) {
    expectOn.push(en === 1);
    for (let k = 0; k < P; k++) {
      if (k === 0) sim.setInput('clk', 1);
      if (k === ICG_HALF) sim.setInput('clk', 0);
      if (at !== null && k === at) sim.setInput('en', (en ^= 1));
      sim.step(); t++;
      const v = sim.get(out);
      if (v > 1) return `gclk is unknown (X) ${t} delays in`;
      if (v === 1 && rose < 0) rose = t;
      if (v === 0 && rose >= 0) { pulses.push({ cycle: Math.floor((rose - 1) / P), width: t - rose }); rose = -1; }
    }
  }
  const when = at === null ? `with en held at ${hold}` : `with en changing ${at} delays after each rising edge`;
  for (const p of pulses) {
    if (!expectOn[p.cycle]) return `${when}: gclk pulsed in cycle ${p.cycle + 1}, where en was 0 at the rising edge`;
    if (Math.abs(p.width - ICG_HALF) > 2) return `${when}: a gclk pulse of ${p.width} delays in cycle ${p.cycle + 1} (the clock's are ${ICG_HALF}): a piece of a pulse`;
  }
  for (let c = 0; c < CYCLES; c++) if (expectOn[c] && !pulses.some((p) => p.cycle === c)) return `${when}: no gclk pulse in cycle ${c + 1}, where en was 1 at the rising edge`;
  return '';
}

export function icgBench(def: ComponentDef): CustomRun {
  const failures: string[] = [];
  const runs: (number | null)[] = [null, null];
  for (let at = ICG_BENCH_HOLD; at <= 2 * ICG_HALF - ICG_BENCH_SETUP; at++) runs.push(at);
  runs.forEach((at, i) => { const why = runOnce(def, at, i === 1 ? 1 : 0); if (why) failures.push(why); });
  return { failures: failures.slice(0, 1), tested: runs.length };
}

const pins: PinSpec[] = [{ name: 'en', dir: 'in', width: 1 }, { name: 'clk', dir: 'in', width: 1, clock: true }, { name: 'gclk', dir: 'out', width: 1 }];

let answer: ChipDoc[] | null = null;

export const BUILDPOW: Record<string, () => BuildChallenge> = {
  s_icg: () => ({
    id: 's_icg', title: 'Clock gate', level: 'sequential', allowed: 'nand',
    brief: `<b>gclk = clk</b> while <code>en</code> = 1, and stays 0 while en = 0, in whole clock pulses only. en may change at any moment except within a few gate delays of a rising edge: the bench changes it from ${ICG_BENCH_HOLD} delays after each rising edge to ${ICG_BENCH_SETUP} before the next (the clock is ${ICG_HALF} delays high, ${ICG_HALF} low). A bare clk AND en fails: en changing while clk is high cuts a pulse.`,
    ports: pins,
    check: { kind: 'custom', describe: `en changed at every moment of the clock period, ${CYCLES} cycles each`, run: (def) => icgBench(def), unit: 'timing' },
    answer: () => (answer ??= (() => {
      const doc = docFromDef(RV16_ICG, { id: 'u_ref_cp_s_icg', name: 'Clock gate ref' });
      if ('error' in doc) throw new Error(`reference s_icg: ${doc.error}`);
      return [{ ...doc, notes: `Reference answer. ${RV16_ICG.summary}` }];
    })()),
  }),
};
