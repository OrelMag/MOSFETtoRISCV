// The bench of the sigma-delta loop level (act 13): seeded inputs run through the learner's loop and the chapter's model (dsp/converters.ts
// SdLoop) clock by clock on BitSim lanes, one scenario a lane. The bit and both integrators are compared at every clock, and on the
// steady inputs the average of the bits is compared with the input: that is what the loop is for. No DOM.

import type { CustomRun } from '../editor/challenges';
import { SD_GUARD, SdLoop } from '../dsp/converters';
import { signedOf, wordOf } from '../comm/signals';
import type { ComponentDef } from '../sim/types';
import { sdModulator } from '../lib/sigmadelta';
import { leafGives } from './buildcomm';
import { finish, simOf } from './commcheck';
import { rng } from './drills';

/** The level's loop: second order, 8-bit input (the chapter's gate build is 16 bits: the same drawing, smaller words so Check takes a second). */
export const SD_ORDER = 2 as const;
export const SD_W = 8;
export const SD_WORD = SD_W + SD_GUARD;
export const SD_REF = (): ComponentDef => sdModulator(SD_ORDER, SD_W);
/** The loop's parts (registers, adders, wiring): the loop is what the level builds. */
export const sdGives = leafGives(SD_REF, () => []);
export const SD_CLOCKS = 3000;
/** Steady inputs are judged on the average of the bits over the last SD_AVG clocks. */
export const SD_AVG = 2000;
/** How far the average of the bits may stray from the input, in full scales: the loop's error in that many clocks is about 1 / SD_AVG. */
export const SD_AVG_TOL = 0.01;

export interface SdScenario { name: string; u: (t: number) => number; dc?: number; overload?: boolean }

const FS = 2 ** (SD_W - 1);
const dc = (level: number): SdScenario => ({ name: `a steady input of ${level >= 0 ? '+' : '−'}${Math.abs(level)} full scale`, u: () => Math.round(level * FS), dc: level });
const sine = (name: string, amp: number, period: number, phase = 0): SdScenario => ({ name, u: (t) => Math.round(amp * FS * Math.sin((2 * Math.PI * t) / period + phase)) });

export function sdScenarios(): SdScenario[] {
  const r = rng(11);
  const seeded = Array.from({ length: 2 }, (_, k) => {
    const amp = 0.3 + 0.6 * r(), period = 150 + Math.floor(r() * 500), phase = 6.28 * r();
    return sine(`a seeded sine ${k + 1} (amplitude ${amp.toFixed(2)}, period ${period} clocks)`, amp, period, phase);
  });
  return [
    dc(0), dc(0.5), dc(-0.5), dc(0.9), dc(-0.9), dc(0.25), dc(-0.1),
    { name: 'a steady input of +1 LSB', u: () => 1 },
    { name: 'a steady input of full scale (+127), where the integrators grow without bound and wrap', u: () => FS - 1, overload: true },
    { name: 'a steady input of −full scale (−128), where the integrators wrap', u: () => -FS, overload: true },
    sine('a slow sine, amplitude 0.9, period 512 clocks', 0.9, 512),
    sine('a sine of amplitude 0.5, period 200 clocks', 0.5, 200),
    sine('a fast sine, amplitude 0.95, period 37 clocks', 0.95, 37),
    { name: 'steps: 0, +0.6, −0.6, 0 in blocks of 400 clocks', u: (t) => Math.round([0, 0.6, -0.6, 0][Math.floor(t / 400) % 4] * FS) },
    ...seeded,
  ];
}

export function runSd(def: ComponentDef, mode: 'gate' | 'switch'): CustomRun {
  if (mode === 'switch') return { failures: ['switch level: the loop is gates and flip-flops'], tested: 0 };
  const sim = simOf(def, ['u', 'clk', 'bit', 'y1', 'y2']);
  if (typeof sim === 'string') return { failures: [sim], tested: 0 };
  const OVER = ' This input overloads the sums: they must wrap at their width like the model, not stop at the end, and the bit is the sign after wrapping.', sc = sdScenarios(), lanes = sc.length, W = SD_W + SD_GUARD, models = sc.map(() => new SdLoop(SD_ORDER, SD_W));
  const bad = new Set<number>(), fails: string[] = [], ones = sc.map(() => 0);
  for (let t = 0; t < SD_CLOCKS; t++) {
    const u = sc.map((s) => s.u(t));
    sim.setInput('u', u.map((x) => wordOf(x, SD_W)));
    sim.cycle();
    const bit = sim.get('bit', lanes), y1 = sim.get('y1', lanes), y2 = sim.get('y2', lanes);
    for (let l = 0; l < lanes; l++) {
      const m = models[l];
      m.edge(u[l]);
      if (t >= SD_CLOCKS - SD_AVG) ones[l] += bit[l] & 1;
      if (bad.has(l)) continue;
      const g1 = signedOf(y1[l], W), g2 = signedOf(y2[l], W);
      if ((bit[l] & 1) !== m.bit) {
        bad.add(l);
        fails.push(`clock ${t}, ${sc[l].name}: bit = ${bit[l] & 1}, the model gives ${m.bit}. y2 is ${g2}, the model has ${m.y2}: the decision is the sign of the last integrator, a 1 when it is not negative${sc[l].overload ? OVER : ''}`);
      } else if (g1 !== m.y1) {
        bad.add(l);
        fails.push(`clock ${t}, ${sc[l].name}: y1 = ${g1}, the model has ${m.y1}. y1 takes in u minus v, where v is +${FS} after a 1 and −${FS} after a 0${sc[l].overload ? OVER : ''}`);
      } else if (g2 !== m.y2) {
        bad.add(l);
        fails.push(`clock ${t}, ${sc[l].name}: y2 = ${g2}, the model has ${m.y2}. y2 takes in the new y1 minus v${sc[l].overload ? OVER : ''}`);
      }
    }
  }
  const avgFails: string[] = [];
  sc.forEach((s, l) => {
    if (s.dc === undefined) return;
    const mean = (2 * ones[l]) / SD_AVG - 1;
    if (Math.abs(mean - s.dc) > SD_AVG_TOL) avgFails.push(`${s.name}: the bits (1 → +1, 0 → −1) average ${mean.toFixed(3)} over the last ${SD_AVG} clocks, not ${s.dc}: the loop should make their average the input`);
  });
  return finish([...fails.slice(0, 3), ...avgFails.slice(0, 2), ...fails.slice(3), ...avgFails.slice(2)], lanes, def);
}
