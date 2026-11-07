// The capstone "A filter to a mask" (cap_mask) bench (DOM-free): a low-pass to a stated mask, judged at its pins on BitSim. One sample a clock; x a 12-bit signed
// word, y a 14-bit one at the same scale. The bench never looks inside. It reads the filter from its gates three ways:
//   1. an impulse response (a full-scale impulse, then silence), from which everything linear follows;
//   2. swept sines, measured by correlation over whole periods, against the mask (the gain is the filter's, not the model's);
//   3. a worst-case input built from that impulse response (every tap's contribution made to add up), and full-scale noise,
//      against the convolution of the impulse response: an output that wrapped or clipped is named by sample;
//   4. bursts and then silence, lane by lane: an output that never dies is a limit cycle, named by its period.
// Frequencies, phases, burst sizes and noise are drawn from a seed the learner never sees (a hash of the circuit and a constant). NANDs are scored against the budget.

import type { CustomRun } from '../editor/challenges';
import { findCycle, maskDesign, type Sos, sosGain, type Words, wordsOf, zpkToSos } from '../dsp/iir';
import { type MaskFir, maskAccBits, maskFir } from '../lib/maskfilter';
import { remez } from '../dsp/firdesign';
import { groupDigits } from '../sim/numfmt';
import type { BitSim } from '../sim/bitsim';
import { stats } from '../sim/stats';
import type { ComponentDef } from '../sim/types';
import { rng } from './drills';
import { finish, simOf } from './commcheck';

/** The sheet. Frequencies are fractions of the sample rate; kHz at the stated rate. */
export const MASK_SPEC = {
  /** The sample rate: one sample a clock. */
  rate: 48_000,
  /** Gain within ±rippleDb of 1 (unity) from 0 to passEdge. */
  passEdge: 0.1,
  rippleDb: 0.5,
  /** At most -stopDb from stopEdge to the Nyquist frequency. */
  stopEdge: 0.2,
  stopDb: 40,
  xBits: 12,
  yBits: 14,
  /** The largest input and the smallest. */
  xMax: 2047,
  xMin: -2048,
  /** NANDs the filter may use. */
  budget: 13_000,
} as const;

export const MASK_TAPS = 21;
export const MASK_FRAC = 11;

const khz = (f: number): string => `${+(f * MASK_SPEC.rate / 1000).toFixed(2)} kHz`;
const dbOf = (g: number): number => (g > 1e-6 ? 20 * Math.log10(g) : -120);
const fmtDb = (v: number): string => `${v < 0 ? '−' : v > 0 ? '+' : ''}${Math.abs(v).toFixed(1)} dB`;
const signed = (v: number, bits: number): number => (v >= 2 ** (bits - 1) ? v - 2 ** bits : v);
const sgn = (v: number): string => (v > 0 ? `+${v}` : `${v}`);

// ---- the designs: the reference, and the wrong ones ------------------------------------------------------------------------------------------------------

/** The gain of real taps at f (cycles a sample). */
export function tapGain(t: readonly number[], f: number): number {
  let re = 0, im = 0;
  t.forEach((c, k) => { re += c * Math.cos(2 * Math.PI * f * k); im -= c * Math.sin(2 * Math.PI * f * k); });
  return Math.hypot(re, im);
}

/**
 * Tap words of an equiripple design to the mask, N odd, exactly symmetric. The pass band's ripple is centred on unity (scaled by 1 / sqrt(max · min) over the band),
 * so that the tolerance is shared evenly on both sides, then rounded to `frac` fractional bits. `stopWeight` below 1 lets the stop band slip for a
 * flatter pass band (the wrong designs).
 */
export function maskWords(N: number, frac = MASK_FRAC, stopWeight = 1): number[] {
  const dp = 10 ** (MASK_SPEC.rippleDb / 20) - 1, ds = 10 ** (-MASK_SPEC.stopDb / 20);
  const t = remez(N, [0, MASK_SPEC.passEdge, MASK_SPEC.stopEdge, 0.5], [1, 0], [1 / dp, stopWeight / ds]).taps;
  let hi = 0, lo = Infinity;
  for (let i = 0; i <= 400; i++) { const g = tapGain(t, (i / 400) * MASK_SPEC.passEdge); hi = Math.max(hi, g); lo = Math.min(lo, g); }
  const k = 1 / Math.sqrt(hi * lo), half = (N - 1) / 2, w = new Array<number>(N).fill(0);
  for (let i = 0; i <= half; i++) w[i] = w[N - 1 - i] = Math.round(t[i] * k * 2 ** frac);
  return w;
}

let refMemo: MaskFir | null = null;
/** The reference: 21 taps in 11 fractional bits, the accumulator the least that cannot wrap. */
export function maskReference(): MaskFir {
  if (!refMemo) { const words = maskWords(MASK_TAPS); refMemo = { words, frac: MASK_FRAC, accBits: maskAccBits(words) }; }
  return refMemo;
}
/** An elliptic IIR to the mask (order 4: two biquads in Q2.14), the ripple centred on unity: not the reference (it costs three times the budget), but a feedback design the bench must judge. */
export function maskIirSections(): Words[] {
  const d = maskDesign('ellip', { fp: MASK_SPEC.passEdge, fs: MASK_SPEC.stopEdge, rp: 0.8, rs: 46 });
  let sos = zpkToSos(d.zpk), hi = 0, lo = Infinity;
  for (let i = 0; i <= 400; i++) { const g = sosGain(sos, (i / 400) * MASK_SPEC.passEdge); hi = Math.max(hi, g); lo = Math.min(lo, g); }
  const k = 1 / Math.sqrt(hi * lo);
  sos = sos.map((q, i) => (i === 0 ? { ...q, b: q.b.map((v) => v * k) as Sos['b'] } : q));
  return sos.map((q) => wordsOf(q));
}

export const maskReferenceDef = (): ComponentDef => maskFir(maskReference());

// ---- the bench ------------------------------------------------------------------------------------------------------------------------------------------

const WINDOW = 200;     // samples a sine is measured over (whole periods for every m / 200)
const SETTLE = 120;     // samples before it
const SINE_AMP = 1800;
const IMPULSE = MASK_SPEC.xMax;
const T1 = 420;         // impulse and bursts: samples
const TAIL = 128;       // the last samples that must be zero
const BURSTS = 31;
/** How far y may be from what the impulse response predicts before the worst-case check calls it wrong, in output units: 1.6 % of the 14-bit range,
 *  about 9 % of the reference's 2 936 peak. A correct IIR's rounding stays under 100 (the toward-zero one, 40 seeds), the reference FIR's under 2. */
const TOLERANCE = 256;
/** How close to a power of two a difference must be to be called a wrap (the output's own rounding). */
const WRAP_SLACK = 1;

/** Lanes: DC; nine in the pass band, its edge and eight drawn; 22 in the stop band, its edge and the bin before Nyquist and 20 drawn. */
export interface SineLane { m: number; phase: number; band: 'dc' | 'pass' | 'stop' }
export function sineLanes(seed: number): SineLane[] {
  const r = rng(seed ^ 0x51ed), pick = (lo: number, hi: number, n: number, fixed: number[]): number[] => {
    const s = new Set(fixed);
    while (s.size < n) s.add(lo + Math.floor(r() * (hi - lo + 1)));
    return [...s].sort((a, b) => a - b);
  };
  const pass = pick(1, 20, 9, [20]), stop = pick(40, 99, 22, [40, 99]);
  return [{ m: 0, phase: 0, band: 'dc' }, ...pass.map((m): SineLane => ({ m, phase: r() * 2 * Math.PI, band: 'pass' })), ...stop.map((m): SineLane => ({ m, phase: r() * 2 * Math.PI, band: 'stop' }))];
}

/** x for lane l at each of `T` clocks, as 12-bit two's complement. */
type Drive = (lane: number, n: number) => number;

/** Run T clocks with each lane driven by `drive`, reading y (signed) just before every rising edge. */
function run(sim: BitSim, T: number, lanes: number, drive: Drive): number[][] {
  const out: number[][] = Array.from({ length: lanes }, () => new Array<number>(T));
  const xs = new Array<number>(32).fill(0);
  for (let n = 0; n < T; n++) {
    for (let l = 0; l < 32; l++) xs[l] = (l < lanes ? drive(l, n) : 0) & 0xfff;
    sim.setInput('x', xs);
    sim.settle();
    const ys = sim.get('y');
    for (let l = 0; l < lanes; l++) out[l][n] = signed(ys[l], MASK_SPEC.yBits);
    sim.cycle();
  }
  return out;
}

export interface MaskOpts { seed?: number; budget?: number }

/** The seed a circuit gets when none is given: a constant and the circuit's own size, so that no fixed test is worth tuning to. */
export const maskSeed = (def: ComponentDef): number => (0x6d61736b ^ Math.imul(stats(def).nands + 1, 2654435761)) >>> 0;

export interface MaskMeasure {
  /** Worst gain over the pass band, as dB from unity (absolute, the larger of the two sides), and where. */
  passWorst: { db: number; f: number };
  /** Highest gain in the stop band, dB, and where. */
  stopWorst: { db: number; f: number };
  /** The sum of |h|, in full scales. */
  gainSum: number;
  /** Largest and smallest output of the worst-case input compared with what the impulse response predicts (|difference|). */
  worstErr: number;
}

export function runMask(def: ComponentDef, mode: 'gate' | 'switch', o: MaskOpts = {}): CustomRun & { measure?: MaskMeasure } {
  if (mode === 'switch') return { failures: ['switch level: the filter is gates and flip-flops'], tested: 0 };
  const pinFail: string[] = [];
  for (const [name, width, dir] of [['x', MASK_SPEC.xBits, 'in'], ['y', MASK_SPEC.yBits, 'out']] as const) {
    const p = def.ports.find((q) => q.name === name);
    if (p && (p.width !== width || p.dir !== dir)) pinFail.push(`pin ${name} is ${p.width} bits${p.dir !== dir ? ` and an ${p.dir}put` : ''}; the sheet says ${width} bits, an ${dir}put`);
  }
  if (pinFail.length) return { failures: pinFail, tested: 0 };
  const sim = simOf(def, ['x', 'clk', 'y']);
  if (typeof sim === 'string') return { failures: [sim], tested: 0 };
  const seed = o.seed ?? maskSeed(def), budget = o.budget ?? MASK_SPEC.budget;
  const r = rng(seed);
  const fails: string[] = [];
  let tested = 0;

  // ---- 1 and 4: the impulse response, and bursts then silence --------------------------------------------------------------------------------
  const bursts = Array.from({ length: BURSTS }, () => {
    const amp = r() < 0.4 ? (r() < 0.5 ? MASK_SPEC.xMax : MASK_SPEC.xMin) : (r() < 0.5 ? -1 : 1) * (100 + Math.floor(r() * 1900));
    return { amp: Math.max(MASK_SPEC.xMin, Math.min(MASK_SPEC.xMax, amp)), burst: 1 + Math.floor(r() * 3) };
  });
  const imp = run(sim, T1, 1 + BURSTS, (l, n) => (l === 0 ? (n === 0 ? IMPULSE : 0) : n < bursts[l - 1].burst ? bursts[l - 1].amp : 0));
  const h = imp[0];
  let Lh = 0;
  h.forEach((v, n) => { if (v !== 0) Lh = n + 1; });
  const gainSum = h.reduce((s, v) => s + Math.abs(v), 0) / IMPULSE;
  tested += 1 + BURSTS;
  if (Lh === 0) fails.push(`an impulse of full scale (${IMPULSE}) gives an output of zero at every clock: nothing gets through`);
  const stuck = bursts.map((b, i) => ({ b, ys: imp[i + 1] })).filter(({ ys }) => ys.slice(T1 - TAIL).some((v) => v !== 0));
  if (stuck.length) {
    const { b, ys } = stuck[0];
    const cyc = findCycle(ys, 32), what = b.burst === 1 ? `one input of ${sgn(b.amp)}` : `${b.burst} inputs of ${sgn(b.amp)}`;
    const peak = Math.max(...ys.slice(T1 - TAIL).map(Math.abs));
    fails.push(cyc
      ? `after ${what} and then silence the output never dies: from sample ${cyc.start} it repeats every ${cyc.period} sample${cyc.period === 1 ? '' : 's'} (${cyc.seq.slice(0, 8).map(sgn).join(', ')}${cyc.seq.length > 8 ? ', …' : ''}). A limit cycle: rounding inside a feedback loop is holding the output up${stuck.length > 1 ? ` (${stuck.length} of ${BURSTS} runs end like this)` : ''}`
      : `after ${what} and then silence the output is still moving after ${T1} samples (up to ±${peak} in the last ${TAIL})${stuck.length > 1 ? `; ${stuck.length} of ${BURSTS} runs do` : ''}`);
  }

  // ---- 2: swept sines ----------------------------------------------------------------------------------------------------------------------------
  const lanes = sineLanes(seed);
  // each pass starts from power-on: a fresh BitSim
  const fresh = (): BitSim => simOf(def, ['x', 'clk', 'y']) as BitSim;
  const T2 = SETTLE + WINDOW;
  const inputs = lanes.map((ln) => Array.from({ length: T2 }, (_, n) => (ln.band === 'dc' ? SINE_AMP : Math.round(SINE_AMP * Math.sin((2 * Math.PI * ln.m * n) / WINDOW + ln.phase)))));
  const ys2 = run(fresh(), T2, lanes.length, (l, n) => inputs[l][n]);
  const gains = lanes.map((ln, l) => {
    const win = (v: number[]) => v.slice(SETTLE);
    if (ln.band === 'dc') return win(ys2[l]).reduce((s, v) => s + v, 0) / WINDOW / SINE_AMP;
    const corr = (v: number[]) => {
      let I = 0, Q = 0;
      win(v).forEach((s, i) => { const t = (2 * Math.PI * ln.m * i) / WINDOW; I += s * Math.sin(t); Q += s * Math.cos(t); });
      return Math.hypot(I, Q);
    };
    return corr(ys2[l]) / corr(inputs[l]);
  });
  tested += lanes.length;
  const eps = 1e-9;
  const passMiss = lanes.map((ln, l) => ({ ln, db: dbOf(gains[l]) })).filter(({ ln, db }) => ln.band !== 'stop' && Math.abs(db) > MASK_SPEC.rippleDb + eps);
  const stopMiss = lanes.map((ln, l) => ({ ln, db: dbOf(gains[l]) })).filter(({ ln, db }) => ln.band === 'stop' && db > -MASK_SPEC.stopDb + eps);
  const at = (m: number) => khz(m / WINDOW);
  // held until the worst-case check has run: when a word wraps, that is the cause and a bad gain only its symptom
  const bandFails: string[] = [];
  const dcGain = gains[lanes.findIndex((ln) => ln.band === 'dc')];
  if (passMiss.length) {
    const w = passMiss.reduce((a, c) => (Math.abs(c.db) > Math.abs(a.db) ? c : a));
    const miss = passMiss.length > 1 ? `; ${passMiss.length} of ${lanes.filter((x) => x.band !== 'stop').length} frequencies miss` : '';
    const rule = `the pass band must stay within ±${MASK_SPEC.rippleDb} dB of unity up to ${khz(MASK_SPEC.passEdge)}`;
    // dB cannot say a gain is negative or zero: say what came out instead
    bandFails.push(w.ln.band === 'dc' && dcGain < 1e-6
      ? `pass band: at 0 Hz (DC) an input of +${SINE_AMP} held steady comes out near ${String(Math.round(dcGain * SINE_AMP)).replace('-', '−')}: ${dcGain > -1e-6 ? 'nothing gets through' : `the gain is negative (× ${dcGain.toFixed(2).replace('-', '−')})${dcGain < -0.5 && dcGain > -2 ? ', so the output is inverted' : ''}`}; ${rule}${miss ? ` (${miss.slice(2)})` : ''}`
      : `pass band: at ${w.ln.band === 'dc' ? '0 Hz (DC)' : at(w.ln.m)} the gain is ${fmtDb(w.db)}; ${rule} (${(Math.abs(w.db) - MASK_SPEC.rippleDb).toFixed(1)} dB outside${miss})`);
  }
  if (stopMiss.length) {
    const w = stopMiss.reduce((a, c) => (c.db > a.db ? c : a));
    bandFails.push(`stop band: at ${at(w.ln.m)} the gain is ${fmtDb(w.db)}; from ${khz(MASK_SPEC.stopEdge)} up it must be ${fmtDb(-MASK_SPEC.stopDb)} or lower (${(w.db + MASK_SPEC.stopDb).toFixed(1)} dB short${stopMiss.length > 1 ? `; ${stopMiss.length} of ${lanes.filter((x) => x.band === 'stop').length} frequencies miss` : ''})`);
  }
  const passDb = lanes.map((ln, l) => ({ f: ln.m / WINDOW, db: dbOf(gains[l]), band: ln.band }));
  const passWorst = passDb.filter((x) => x.band !== 'stop').reduce((a, c) => (Math.abs(c.db) > Math.abs(a.db) ? c : a));
  const stopWorst = passDb.filter((x) => x.band === 'stop').reduce((a, c) => (c.db > a.db ? c : a));

  // ---- 3: the worst case, and full-scale noise, against the impulse response ---------------------------------------------------------------------
  let worstErr = 0;
  if (Lh > 0) {
    const hk = h.slice(0, Lh).map((v) => v / IMPULSE);
    const T3 = Math.max(Lh + 80, 200);
    const sign = (v: number) => (v >= 0 ? 1 : -1);
    const noise = Array.from({ length: 4 }, () => Array.from({ length: T3 }, () => (r() < 0.5 ? MASK_SPEC.xMax : MASK_SPEC.xMin)));
    const stim: number[][] = [
      Array.from({ length: T3 }, (_, n) => (n < Lh ? (sign(h[Lh - 1 - n]) > 0 ? MASK_SPEC.xMax : MASK_SPEC.xMin) : 0)),
      Array.from({ length: T3 }, (_, n) => (n < Lh ? (sign(h[Lh - 1 - n]) > 0 ? MASK_SPEC.xMin : MASK_SPEC.xMax) : 0)),
      ...noise,
    ];
    const ys3 = run(fresh(), T3, stim.length, (l, n) => stim[l][n]);
    // rounding inside a feedback loop makes the response a little non-linear (a long impulse response is read to ±½ at every clock); a wrap or a clip is thousands
    const tol = TOLERANCE;
    tested += stim.length;
    const bad: { lane: number; n: number; y: number; e: number; errs: number[] }[] = [];
    stim.forEach((x, l) => {
      let first: { n: number; y: number; e: number } | undefined;
      const errs: number[] = [];
      for (let n = 0; n < T3; n++) {
        let e = 0;
        for (let k = 0; k < Lh && k <= n; k++) e += hk[k] * x[n - k];
        const err = ys3[l][n] - e;
        worstErr = Math.max(worstErr, Math.abs(err));
        if (Math.abs(err) > tol) { first ??= { n, y: ys3[l][n], e: Math.round(e) }; errs.push(Math.round(err)); }
      }
      if (first) bad.push({ lane: l, ...first, errs });
    });
    if (bad.length) {
      const b = bad[0], d = b.y - b.e, k = Math.round(Math.log2(Math.abs(d))), what = b.lane < 2 ? 'the worst-case input (your own impulse response, signs reversed, so that every tap adds)' : 'full-scale noise';
      // a wrap is off by a power of two to within the output's rounding, at every sample it is off (a clip or a loop's rounding is not; a wrap fed back through a loop no longer is, and reads as a difference)
      const onGrid = (v: number) => { const m = Math.round(v / 2 ** k); return m !== 0 && Math.abs(v - m * 2 ** k) <= WRAP_SLACK; };
      const wrapped = Math.abs(d) >= 64 && b.errs.every(onGrid);
      const clipped = !wrapped && Math.sign(b.y) === Math.sign(b.e) && Math.abs(b.y) < Math.abs(b.e);
      const peak = Math.round(hk.reduce((s, v) => s + Math.abs(v), 0) * MASK_SPEC.xMax);
      const how = wrapped ? `so a word wrapped: y is off by exactly ${groupDigits(2 ** k)} = 2^${k}`
        : clipped ? `so the output clipped: it falls ${groupDigits(Math.abs(d))} short, so something saturates on the way`
        : `a difference of ${groupDigits(Math.abs(d))}, more than the ±${tol} rounding may explain`;
      // figures from h only when nothing bent it: a wrap bends the impulse response too, and a limit cycle's rounding is not a word too narrow
      const advice = stuck.length && !wrapped
        ? 'This may be the limit cycle above: rounding fed back through a loop adds to every output, so fix that first'
        : wrapped
          ? 'Every word that carries the running sum, the accumulator included, must hold it without wrapping: widen the one that wraps (the impulse response measured here is bent by the same wrap, so it cannot say by how much)'
          : `Your impulse response adds up to ${gainSum.toFixed(2)} × full scale, so the running sum reaches ±${groupDigits(peak)}: every word that carries it, the accumulator included, must hold that without wrapping or saturating (y alone needs ${Math.ceil(Math.log2(peak + 1)) + 1} bits)`;
      fails.push(`${what}, sample ${b.n + 1}: y reads ${b.y} where the impulse response says ${b.e}, ${how}. ${advice}${bad.length > 1 ? ` (${bad.length} of ${stim.length} inputs fail)` : ''}`);
    }
  }

  fails.push(...bandFails);

  // ---- the budget --------------------------------------------------------------------------------------------------------------------------------
  const nands = stats(def).nands;
  if (nands > budget) fails.push(`${groupDigits(nands)} NANDs; the budget is ${groupDigits(budget)} (${groupDigits(nands - budget)} over)`);
  const out = finish(fails, tested, def);
  return { ...out, measure: { passWorst: { db: passWorst.db, f: passWorst.f }, stopWorst: { db: stopWorst.db, f: stopWorst.f }, gainSum, worstErr } };
}

// ---- the sheet -----------------------------------------------------------------------------------------------------------------------------------------

/** The parts a filter may be built from: gates, adders, registers, multipliers, memories and constants. Not a finished filter (the FIR, the biquad). */
export const MASK_PARTS = ['and', 'and3', 'and4', 'and8', 'andx*', 'or', 'or3', 'or4', 'or8', 'orx*', 'xor', 'xnor', 'xorx*', 'mux*', 'mux2', 'not',
  'dff', 'dffe', 'reg*', 'creg*', 'counter*', 'half_adder', 'full_adder', 'full_adder_ha', 'rca*', 'addsub*', 'inc*', 'cla4', 'ks16', 'eq*', 'zero*', 'dec*', 'wmul*', 'csdmul*',
  'fxrnd*', 'ram*', 'pmem*', 'tie0', 'tie1', 'split_*', 'merge_*', 'sr_latch'];

export const MASK_BRIEF = `A low-pass filter, one sample a clock. <code>x</code> is a 12-bit signed sample (−2048 … 2047), <code>y</code> the filtered one: 14 bits, the same scale (a gain of 1 puts y equal to x), so the two bits above are headroom. `
  + `The bench reads y just before each rising edge, with that clock's x applied: a path from x straight to y is allowed, and so is any delay, because only the response is judged. There is no reset pin; every flip-flop powers up 0.`
  + ` <b>The mask</b>, at ${MASK_SPEC.rate / 1000} kHz: from 0 to ${khz(MASK_SPEC.passEdge)} the gain stays within ±${MASK_SPEC.rippleDb} dB of 1 (unity, 0 dB); from ${khz(MASK_SPEC.stopEdge)} to the Nyquist frequency (${MASK_SPEC.rate / 2000} kHz) it is ${MASK_SPEC.stopDb} dB or lower. Between the two edges anything goes.`
  + ` <b>The input class</b>: any 12-bit sample sequence, up to full scale. A worst case exists: the sequence that makes every tap's term add, which the bench builds from your own impulse response, and y must equal what that response predicts. A word that wraps or clips on it fails, and the check names the sample.`
  + ` <b>Silence</b>: after a burst of input and then zeros, the output must go back to exactly 0, not hold or cycle.`
  + ` <b>The budget</b>: ${groupDigits(MASK_SPEC.budget)} NANDs, counted through your chips. The bench measures the gain by correlating y with sines at frequencies it chooses, and uses amplitudes, sequences and bursts you will never see: a design that meets the mask meets it between the points too. `
  + `The chapters on <a href="#/c/firdesign/0">FIR design</a> and <a href="#/c/iir/0">IIR and stability</a> have the vocabulary and the parts. No walkthrough, no hints: the sheet is all you get.`;
