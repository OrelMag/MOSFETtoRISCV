// Act 13's clocked benches (Signals): the circuit's outputs every cycle against the chapter's model in dsp/. No DOM.
// sp_biquad: 32 runs side by side on BitSim lanes, each its own coefficients and its own input, 140 clocks; the registers
// are emptied first, so a run starts from silence as the model does.

import { Biquad, BQ, burstThenSilence, coefWord, dropBits, LIMIT_CYCLE, type Words } from '../dsp/iir';
import { satTo } from '../dsp/fixed';
import type { CustomRun } from '../editor/challenges';
import type { ComponentDef } from '../sim/types';
import { finish, simOf } from './commcheck';

const wordOf = (v: number, w: number): number => (v < 0 ? v + 2 ** w : v);
const signedOf = (v: number, w: number): number => (v >= 2 ** (w - 1) ? v - 2 ** w : v);

/** A seeded generator in [0, 1). */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

export const BQ_LANES = 32;
export const BQ_CYCLES = 140;

export interface BqRun { name: string; c: Words; xs: number[]; hint?: string }

const clip = (v: number): number => Math.max(-32768, Math.min(32767, Math.round(v)));

/** The 32 runs of the biquad bench: named cases first, then the rounding probes, then seeded filters. */
export function biquadRuns(seed = 1): BqRun[] {
  const rnd = seeded(seed), n = BQ_CYCLES;
  const sp = (lo: number, hi: number) => lo + (hi - lo) * rnd();
  const impulse = (amp: number) => burstThenSilence(amp, 1, n);
  const runs: BqRun[] = [];
  const cw = coefWord;
  // The chapter's resonator: one word in, then silence. The model rings at ±5 for ever; the registers hold the rounded values.
  runs.push({ name: 'impulse into the radius-0.95 resonator', c: LIMIT_CYCLE.words, xs: burstThenSilence(LIMIT_CYCLE.amp, LIMIT_CYCLE.burst, n), hint: 'This is the chapter\'s limit cycle: the model\'s output rings at ±5 least significant bits for ever. The delayed outputs are the rounded ones, and the rounding is half up.' });
  runs.push({ name: 'impulse into a low-pass', c: { b0: cw(0.067), b1: cw(0.135), b2: cw(0.067), a1: cw(-1.143), a2: cw(0.413) }, xs: impulse(20000) });
  runs.push({ name: 'impulse into a resonator at 0.1 cycles a sample', c: { b0: cw(0.1), b1: 0, b2: cw(-0.1), a1: cw(-2 * 0.97 * Math.cos(2 * Math.PI * 0.1)), a2: cw(0.97 * 0.97) }, xs: impulse(30000) });
  runs.push({ name: 'a step into a low-pass', c: { b0: cw(0.067), b1: cw(0.135), b2: cw(0.067), a1: cw(-1.143), a2: cw(0.413) }, xs: Array.from({ length: n }, (_, i) => (i < 4 ? 0 : 10000)) });
  runs.push({ name: 'a₁ = −2 (the word −32 768) with a₂ = 1: poles on the circle', c: { b0: 4096, b1: 0, b2: 0, a1: -32768, a2: 16384 }, xs: impulse(12000) });
  runs.push({ name: 'full-scale input squares into three large gains', c: { b0: 32767, b1: 32767, b2: 32767, a1: 0, a2: 0 }, xs: Array.from({ length: n }, (_, i) => ((i >> 2) % 2 ? -32768 : 32767)) });
  runs.push({ name: 'a resonator driven past full scale: the clamped output is what circulates', c: { b0: 16384, b1: 0, b2: 0, a1: cw(-1.9), a2: cw(0.98) }, xs: Array.from({ length: n }, (_, i) => (i < 30 ? (i % 6 < 3 ? 32767 : -32768) : 0)) });
  runs.push({ name: 'most negative word in, most negative coefficients', c: { b0: -32768, b1: -32768, b2: 32767, a1: -32768, a2: 32767 }, xs: Array.from({ length: n }, (_, i) => (i % 3 === 0 ? -32768 : i % 3 === 1 ? 32767 : 1)) });
  // Rounding probes: a tiny gain, so the sum sits exactly on or beside a half of the output step, in both signs.
  const halves = (len: number) => Array.from({ length: len }, () => {
    const k = [1, 3, 5, -1, -3, -5, 0, 2][Math.floor(rnd() * 8)] * 8192 + [-1, 0, 0, 1][Math.floor(rnd() * 4)];
    return clip(k);
  });
  const probes: Words[] = [
    { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 },
    { b0: 1, b1: 0, b2: 0, a1: 1, a2: 0 },
    { b0: 1, b1: 1, b2: 0, a1: 0, a2: 1 },
    { b0: 0, b1: 1, b2: 1, a1: -1, a2: 0 },
    { b0: 1, b1: 0, b2: -1, a1: 0, a2: -1 },
    { b0: 1, b1: -1, b2: 0, a1: 1, a2: 1 },
  ];
  probes.forEach((c, i) => runs.push({ name: `rounding probe ${i + 1}: gain 2⁻¹⁴, sums beside a half step`, c, xs: halves(n), hint: 'The sum is a whole number of 2⁻²⁹ units; the 14 low bits come off and the first one dropped is added back (half up). A subtraction is an inversion and a +1.' }));
  // Tame random filters (poles inside the circle), then raw random words.
  while (runs.length < 24) {
    const r = sp(0.3, 0.97), th = sp(0.02, 0.48) * 2 * Math.PI, amp = [3000, 12000, 32767][Math.floor(rnd() * 3)];
    runs.push({
      name: `random stable section ${runs.length - 14}`,
      c: { b0: cw(sp(0.05, 0.5)), b1: cw(sp(-0.5, 1)), b2: cw(sp(-0.3, 0.5)), a1: cw(-2 * r * Math.cos(th)), a2: cw(r * r) },
      xs: Array.from({ length: n }, (_, i) => (i < 100 ? clip(sp(-amp, amp)) : 0)),
    });
  }
  while (runs.length < BQ_LANES) {
    const w = () => Math.floor(rnd() * 65536) - 32768;
    runs.push({ name: `random words ${runs.length - 23}`, c: { b0: w(), b1: w(), b2: w(), a1: w(), a2: w() }, xs: Array.from({ length: n }, (_, i) => (i % 9 === 0 ? (i % 2 ? 32767 : -32768) : w())) });
  }
  return runs;
}

/** The model's y and sat for each cycle of a run. */
export function modelOf(run: BqRun, round: 'half-up' | 'trunc' | 'zero' = 'half-up'): { y: number[]; sat: number[] } {
  const m = new Biquad(run.c, { round });
  const y: number[] = [], sat: number[] = [];
  for (const x of run.xs) {
    const acc = m.c.b0 * x + m.c.b1 * m.x1 + m.c.b2 * m.x2 - m.c.a1 * m.y1 - m.c.a2 * m.y2;
    const v = dropBits(acc, BQ.drop, round);
    sat.push(satTo(v, BQ.w) === v ? 0 : 1);
    y.push(m.step(x));
  }
  return { y, sat };
}

const PINS = ['x', 'b0', 'b1', 'b2', 'a1', 'a2', 'clk', 'y', 'sat'];

/** The biquad bench: y and sat every clock against the model's, on every run. */
export const runBiquadBench = (def: ComponentDef, mode: 'gate' | 'switch'): CustomRun => biquadBench(def, mode, 1);
export function biquadBench(def: ComponentDef, mode: 'gate' | 'switch', seed: number): CustomRun {
  if (mode === 'switch') return { failures: ['switch level: the biquad is gates'], tested: 0 };
  const widthOf = (p: string) => def.ports.find((q) => q.name === p)?.width;
  for (const p of ['x', 'b0', 'b1', 'b2', 'a1', 'a2', 'y']) if (def.ports.some((q) => q.name === p) && widthOf(p) !== 16) return { failures: [`${p} is ${widthOf(p)} bits wide; the biquad's words are 16`], tested: 0 };
  const sim = simOf(def, PINS);
  if (typeof sim === 'string') return { failures: [sim], tested: 0 };
  const runs = biquadRuns(seed), L = runs.length, n = BQ_CYCLES;
  // Empty the registers: zero coefficients and zero input for three clocks make every stored y and x zero.
  sim.setInput('clk', 0);
  for (const p of ['x', 'b0', 'b1', 'b2', 'a1', 'a2']) sim.setInput(p, 0);
  sim.settle();
  for (let i = 0; i < 3; i++) sim.cycle();
  for (const p of ['b0', 'b1', 'b2', 'a1', 'a2'] as const) sim.setInput(p, runs.map((r) => wordOf(r.c[p], 16)));
  const ys: number[][] = runs.map(() => []), sats: number[][] = runs.map(() => []);
  for (let t = 0; t < n; t++) {
    sim.setInput('x', runs.map((r) => wordOf(r.xs[t], 16)));
    sim.settle();
    const y = sim.get('y', L), s = sim.get('sat', L);
    for (let l = 0; l < L; l++) { ys[l].push(signedOf(y[l], 16)); sats[l].push(s[l]); }
    sim.cycle();
  }
  const fails: string[] = [], failed: number[] = [];
  runs.forEach((r, l) => {
    const want = modelOf(r);
    let c = -1;
    for (let t = 0; t < n && c < 0; t++) if (ys[l][t] !== want.y[t] || sats[l][t] !== want.sat[t]) c = t;
    if (c < 0) return;
    failed.push(l);
    const at = `${r.name}, cycle ${c}`;
    const yd = ys[l][c] - want.y[c];
    let why = '';
    const alt = ys[l][c] === want.y[c] ? undefined : (['trunc', 'zero'] as const).find((m) => { const a = modelOf(r, m); return a.y.every((v, t) => v === ys[l][t]); });
    if (ys[l][c] === want.y[c]) why = `sat = ${sats[l][c]}, the model gives ${want.sat[c]}: sat is 1 exactly when the clamp changed the value`;
    else why = `y = ${ys[l][c]}, the model gives ${want.y[c]}`;
    if (alt) why += `. Over the whole run your y equals the model that rounds ${alt === 'zero' ? 'toward zero' : 'by dropping the bits (floor)'}; the chapter's gates round half up`;
    else if (c === 0 && Math.abs(yd) > 1) why += '. Cycle 0 has empty registers, so only b₀·x[n] counts: check the first product, its sign and where the binary point sits (data Q1.15, coefficients Q2.14, product Q3.29)';
    else if (Math.abs(yd) === 1) why += '. One step off is the rounding: the 14 low bits of the sum come off, the first one dropped is added back, and a subtracted term is inverted and carries a 1 in';
    else if (r.hint && c > 20) why += `. ${r.hint}`;
    else if (Math.abs(yd) > 1) why += '. The error is more than a rounding: look at which of the four delayed words feeds which product, and the sign of the a terms (they are subtracted)';
    fails.push(`${at}: ${why}`);
  });
  return finish(fails, L, def, { failed });
}
