// The CIC decimator level's bench (act 13, sp_cic): seeded input words, one scenario to a BitSim lane, and after every clock y and
// valid compared with the chapter's model (dsp/multirate.ts CicModel). The registers of the reference wrap by design; the worst
// inputs are in the scenarios so that a register that saturates, or is too narrow, is caught. No DOM.

import type { CustomRun } from '../editor/challenges';
import { signedOf, wordOf } from '../comm/signals';
import { CicModel, cicWidth } from '../dsp/multirate';
import { cicDecimator } from '../lib/multirate';
import type { ComponentDef } from '../sim/types';
import { rng } from './drills';
import { finish, simOf } from './commcheck';

/** The level's decimator: order 2, ÷ 4, 6-bit samples: registers of 6 + 2·log2 4 = 10 bits. */
export const CIC_LV = { N: 2, R: 4, wIn: 6 } as const;
/** Built when the module loads, so the library id (cic2_4_6) resolves for the level's unlocks and its case. */
const CIC_DEF = cicDecimator(CIC_LV.N, CIC_LV.R, CIC_LV.wIn);
export const CIC_REF = (): ComponentDef => CIC_DEF;
export const CIC_W = cicWidth(CIC_LV.N, CIC_LV.R, CIC_LV.wIn);
export const CIC_CYCLES = 160;

interface Scenario { name: string; x: number[] }

/** 32 input streams of CIC_CYCLES words: the worst inputs held, then steps, alternation, a ramp, quiet noise, and seeded noise. */
export function cicScenarios(seed: number): Scenario[] {
  const { wIn } = CIC_LV, lo = -(2 ** (wIn - 1)), hi = 2 ** (wIn - 1) - 1, span = 2 ** wIn;
  const out: Scenario[] = [
    { name: `the most negative word (${lo}) held`, x: Array(CIC_CYCLES).fill(lo) },
    { name: `the most positive word (${hi}) held`, x: Array(CIC_CYCLES).fill(hi) },
    { name: 'silence, then a step to the most negative word', x: Array.from({ length: CIC_CYCLES }, (_, i) => (i < 20 ? 0 : lo)) },
    { name: 'full-scale alternation', x: Array.from({ length: CIC_CYCLES }, (_, i) => (i % 2 ? hi : lo)) },
    { name: 'a ramp', x: Array.from({ length: CIC_CYCLES }, (_, i) => ((i * 3) % span) + lo) },
    { name: 'a square wave of 8 clocks', x: Array.from({ length: CIC_CYCLES }, (_, i) => ((i >> 2) % 2 ? hi : lo)) },
  ];
  for (let l = 0; out.length < 32; l++) {
    const r = rng(seed * 101 + l);
    const amp = l % 4 === 3 ? 3 : span; // some of them quiet
    out.push({ name: `${amp < span ? 'quiet noise' : 'noise'} (seed ${seed}.${l})`, x: Array.from({ length: CIC_CYCLES }, () => Math.floor(r() * amp) - (amp >> 1)) });
  }
  return out;
}

export function runCic(def: ComponentDef, mode: 'gate' | 'switch', seed = 1): CustomRun {
  if (mode === 'switch') return { failures: ['switch level: the decimator is gates'], tested: 0 };
  const { N, R, wIn } = CIC_LV, w = CIC_W;
  const sim = simOf(def, ['x', 'clk', 'y', 'valid']);
  if (typeof sim === 'string') return { failures: [sim], tested: 0 };
  const sc = cicScenarios(seed), lanes = sc.length;
  const models = sc.map(() => new CicModel(N, R, w)), failed = new Set<number>(), fails: string[] = [];
  for (let t = 0; t < CIC_CYCLES; t++) {
    sim.setInput('x', sc.map((s) => wordOf(s.x[t], wIn)));
    sim.cycle();
    const y = sim.get('y', lanes), v = sim.get('valid', lanes);
    for (let l = 0; l < lanes; l++) {
      const m = models[l];
      m.edge(sc[l].x[t]);
      if (failed.has(l)) continue;
      const got = signedOf(y[l], w), want = m.y, gv = v[l] & 1, wv = m.valid ? 1 : 0;
      if (gv !== wv) {
        failed.add(l);
        fails.push(`${sc[l].name}, clock ${t + 1}: valid = ${gv}, the model gives ${wv}. valid is 1 for one clock in every ${R}: the one on which the output register has just taken a result`);
      } else if (got !== want) {
        failed.add(l);
        const edge = got === 2 ** (w - 1) - 1 || got === -(2 ** (w - 1));
        const hint = edge ? ' y sits at the end of its range: a register that clamps has lost the number the combs subtract; let the sums wrap'
          : ` the difference is ${got - want}${(got - want) % 2 ** (w - 1) === 0 ? ', a multiple of half the word: a register is too narrow or wraps early' : ''}`;
        fails.push(`${sc[l].name}, clock ${t + 1}: y = ${got}, the model gives ${want}.${hint}`);
      }
    }
  }
  return finish(fails, lanes, def);
}
