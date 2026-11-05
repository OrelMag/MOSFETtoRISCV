// "Filters that learn"'s explorers: the error's bowl and a step down it, the step size, an echo canceller on generated speech-like sound, an equalizer, and the integer filter in gates. Every number is dsp/adaptive.ts's. Nothing here is a recording.

import { signedOf, wordOf } from '../comm/signals';
import { prepareClip, type Clip } from '../dsp/clip';
import { correlate, ECHO_RATE, farEnd, levinson, Lms, LmsFixed, peakEnergy, runEcho, runEqualizer, type LmsSpec } from '../dsp/adaptive';
import { lmsFilter } from '../lib/sigmadelta';
import { gaussian, rng } from '../phys/line';
import { h } from '../ui/dom';
import type { Scene, ScenePanel, Stage, Widget } from '../view/stage';
import { clipButton } from './clip';
import { line, mkChips, num, plotOf } from './line';
import { slider } from './mosparts';
import '../styles/line.css';
import '../styles/fourier.css';
import '../styles/signals.css';

const range = (n: number) => Array.from({ length: n }, (_, i) => i);
const minus = (t: string) => t.replace(/-/g, '−');
const dbs = (x: number, d = 1) => `${minus(x.toFixed(d))} dB`;
const smooth = (x: readonly number[], n: number): number[] => { let s = 0; const out: number[] = []; x.forEach((v, i) => { s += v * v; if (i >= n) s -= x[i - n] * x[i - n]; out.push(10 * Math.log10(Math.max(s / Math.min(i + 1, n), 1e-10))); }); return out; };
const every = <T,>(x: readonly T[], k: number): T[] => x.filter((_, i) => i % k === 0);

// ---- finding two taps by walking downhill -----------------------------------------------------------------------------------------------------------

/** Two taps to find: an unknown 2-tap filter, a white input, and the path LMS takes across the plane of its coefficients. */
export const BOWL_TARGET = [0.7, -0.4];
/** Plots run from 0 on x, so this plane is drawn shifted by this much, and its ticks labelled back. */
const RC = 2;
export function bowlWidget(): Widget {
  let lm = -2, tint = 0.6;
  const plot = plotOf({ W: 340, H: 340, x: [0, 2 * RC], y: [-RC, RC], yTicks: [-1, 0, 1], xLabel: 'c₀', yLabel: 'c₁', xFmt: (v) => num(v - RC, 0), aria: 'The path of two coefficients from zero to the best filter, over rings of equal error' });
  plot.el.style.maxWidth = '380px';
  const chips = mkChips(3);
  const paint = () => {
    const mu = 10 ** lm, u = rng(5), n = 1500, x: number[] = [];
    // correlated input tilts the bowl: x = white + tint × last
    let prev = 0;
    for (let i = 0; i < n; i++) { prev = gaussian(u) + tint * prev; x.push(prev * Math.sqrt(1 - tint * tint)); }
    const d = x.map((_, i) => BOWL_TARGET[0] * x[i] + BOWL_TARGET[1] * (x[i - 1] ?? 0));
    const { r, p } = correlate(x, d, 2), best = levinson(r, p), f = new Lms(2, mu), cs: number[] = [0], ds: number[] = [0];
    x.forEach((v, i) => { f.step(v, d[i]); if (i < 800 || i % 8 === 0) { cs.push(f.w[0]); ds.push(f.w[1]); } });
    plot.clear();
    // rings of equal error around the best point
    for (const e of [0.05, 0.2, 0.5]) {
      const th = range(65).map((i) => (2 * Math.PI * i) / 64), lam1 = 1 + tint, lam2 = 1 - tint;
      const a = Math.sqrt(e / lam1), b = Math.sqrt(e / lam2), q = Math.SQRT1_2;
      line(plot, th.map((t) => RC + best[0] + q * (a * Math.cos(t) + b * Math.sin(t))), th.map((t) => best[1] + q * (a * Math.cos(t) - b * Math.sin(t))), 'ln-s lump');
    }
    const clip = (v: number) => Math.max(-RC, Math.min(RC, v));
    line(plot, cs.map((v) => RC + clip(v)), ds.map(clip), 'ln-s real');
    const off = Math.hypot(f.w[0] - best[0], f.w[1] - best[1]);
    chips.set(0, minus(`${num(best[0], 3)}, ${minus(num(best[1], 3))}`), 'the Wiener solution, solved from the correlations');
    chips.set(1, Number.isFinite(off) && off < 100 ? minus(`${num(f.w[0], 3)}, ${minus(num(f.w[1], 3))}`) : 'it left', 'where LMS ended, knowing none of that');
    chips.set(2, num(Math.sqrt((1 + tint) / (1 - tint)), 1), 'how much longer the bowl is than wide: the root of the eigenvalues\' ratio');
  };
  const sm = slider('Step μ', -3.3, 0, 0.1, lm, (x) => num(10 ** x, 4), (x) => { lm = x; paint(); });
  const st = slider('Input colour', 0, 0.95, 0.05, tint, (x) => num(x, 2), (x) => { tint = x; paint(); });
  paint();
  return { el: h('div', { class: 'widget mos sr-w' }, h('div', { class: 'panel' }, h('h3', null, 'Down the bowl'), plot.el, chips.el), h('div', { class: 'panel mos-ctl' }, sm.el, st.el)) };
}

// ---- an echo canceller --------------------------------------------------------------------------------------------------------------------------------

export const ECHO_N = 32000, ECHO_TAPS = 128;
/** The plain form's μ is this much of the slider's, so the slider reaches past its limit (peakEnergy). */
const PLAIN = 0.15;
export function echoClip(which: 'mic' | 'after'): Clip {
  const r = runEcho({ n: ECHO_N, seed: 3, taps: ECHO_TAPS, mu: 0.5, normalized: true });
  const raw = which === 'mic' ? r.d : r.e, peak = r.d.reduce((m, v) => Math.max(m, Math.abs(v)), 1e-9);
  return { samples: prepareClip(raw, { scale: 0.3 / peak }), rate: ECHO_RATE, source: 'model', note: which === 'mic' ? 'generated sound, through a hidden path' : 'the same, less what the canceller subtracts' };
}
export function echoWidget(): Widget {
  let lm = -0.3, taps = ECHO_TAPS, normalized = true, talk = false, freeze = false, loud = 1;
  const mu = (l = lm) => (normalized ? 10 ** l : PLAIN * 10 ** l);
  const plot = plotOf({ W: 640, H: 200, x: [0, ECHO_N / ECHO_RATE], y: [-80, 0], yTicks: [-80, -60, -40, -20, 0], xLabel: 'seconds', yLabel: 'dB', aria: 'The microphone\'s level and what is left after the canceller, over time' });
  const chips = mkChips(3);
  const paint = () => {
    const x = farEnd(ECHO_N, 3).map((v) => v * loud);
    const r = runEcho({ n: ECHO_N, seed: 3, taps, mu: mu(), normalized, x, ...(talk ? { talkFrom: 18000, talkTo: 25000, freeze } : {}) });
    plot.clear();
    const t = every(range(ECHO_N), 40).map((i) => i / ECHO_RATE), cl = (a: number[]) => every(a, 40).map((v) => Math.max(-80, Math.min(0, Number.isFinite(v) ? v : 0)));
    line(plot, t, cl(smooth(r.d, 240)), 'ln-s lump');
    line(plot, t, cl(smooth(r.e, 240)), 'ln-s real');
    const diverged = !Number.isFinite(r.erle) || r.erle < -3;
    chips.set(0, diverged ? 'it diverged' : dbs(r.erle), 'echo return loss enhancement, last quarter');
    chips.set(1, normalized ? 'none here' : num(2 / peakEnergy(x, taps), 3), normalized ? 'step limit from loudness: NLMS has divided it out' : `plain μ\'s limit at this loudness, 2 / (the loudest ${taps} samples\' energy)`);
    chips.set(2, `${taps * 2}`, 'multiplications a sample');
  };
  const sm = slider('Step μ', -2, 0.2, 0.1, lm, (x) => num(mu(x), 3), (x) => { lm = x; paint(); });
  const st = slider('Taps', 8, 128, 8, taps, (x) => String(x), (x) => { taps = x; paint(); });
  const sv = slider('Far end\'s loudness', 0.1, 2, 0.1, loud, (x) => num(x, 1), (x) => { loud = x; paint(); });
  const cb = (label: string, on: boolean, set: (v: boolean) => void) => h('label', { class: 'cd-check' }, h('input', { type: 'checkbox', checked: on, onchange: (e: Event) => { set((e.target as HTMLInputElement).checked); paint(); } }), ` ${label}`);
  paint();
  return {
    el: h('div', { class: 'widget mos sr-w' },
      h('div', { class: 'panel' }, h('h3', null, 'An echo you cannot measure'), plot.el, h('div', { class: 'ln-key' }, h('span', { class: 'fr-k' }, 'at the microphone'), h('span', { class: 'k-far' }, 'after the canceller')), chips.el),
      h('div', { class: 'panel mos-ctl' }, sm.el, st.el, sv.el, cb('Normalized (NLMS)', normalized, (v) => { normalized = v; sm.set(lm); }), cb('Someone talks at the near end', talk, (v) => { talk = v; }), cb('Stop learning while they talk', freeze, (v) => { freeze = v; }),
        clipButton('Hear the microphone', () => echoClip('mic')).el, clipButton('Hear what is left', () => echoClip('after')).el)),
  };
}

// ---- an equalizer ----------------------------------------------------------------------------------------------------------------------------------------

export const CHANNELS: { name: string; h: number[] }[] = [{ name: 'A smeared channel', h: [0.35, 1, -0.6, 0.2] }, { name: 'A milder one', h: [0.25, 1, 0.45, -0.15] }, { name: 'A zero on the circle', h: [0.5, 1, 0.5] }];
export function eqWidget(): Widget {
  let pick = 0, train = 4000;
  const plot = plotOf({ W: 640, H: 180, x: [0, 12000], y: [-1.8, 1.8], yTicks: [-1, 0, 1], xLabel: 'symbol', yLabel: 'output', aria: 'The equalizer\'s output sorting itself into two levels' });
  const chips = mkChips(3);
  const paint = () => {
    const r = runEqualizer({ channel: CHANNELS[pick].h, taps: 15, delay: 8, mu: 0.05, n: 12000, seed: 5, train });
    plot.clear();
    const xs = range(r.y.length).filter((i) => i % 3 === 0);
    plot.layer.append(...xs.map((i) => { const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle'); c.setAttribute('cx', String(plot.X(i))); c.setAttribute('cy', String(plot.Y(Math.max(-1.8, Math.min(1.8, r.y[i]))))); c.setAttribute('r', '0.8'); c.style.fill = 'var(--accent)'; return c; }));
    chips.set(0, minus(num(r.openingBefore, 2)), 'the eye on the line, as a gap between + and − (below 0: shut)');
    chips.set(1, minus(num(r.opening, 2)), 'after it, once training is over');
    chips.set(2, String(r.wrongAfter), 'symbols wrong, on its own decisions');
  };
  const sel = h('select', { 'aria-label': 'Channel' }, ...CHANNELS.map((c, i) => h('option', { value: String(i), selected: i === pick }, c.name))) as HTMLSelectElement;
  sel.addEventListener('change', () => { pick = Number(sel.value); paint(); });
  const st = slider('Training symbols', 500, 8000, 500, train, (x) => String(x), (x) => { train = x; paint(); });
  paint();
  return { el: h('div', { class: 'widget mos sr-w' }, h('div', { class: 'panel' }, h('h3', null, 'A filter that fixes a line'), plot.el, chips.el), h('div', { class: 'panel mos-ctl' }, h('label', { class: 'mos-sl ln-sel' }, h('span', null, 'Channel'), sel), st.el)) };
}

// ---- in gates ------------------------------------------------------------------------------------------------------------------------------------------------

export const LMS_SPEC: LmsSpec = { n: 4, wx: 8, w: 12, f: 8, s: 7 };
export const LMS_TARGET = [0.75, -0.5, 0.25, 0.125];
/** A full input converges in a few dozen clocks. A quiet one crawls for thousands, and stops in the dead zone. */
export const LMS_RUNS = { loud: { clocks: 200, amp: 64, every: 1 }, quiet: { clocks: 8000, amp: 8, every: 16 } };
export const lmsApi = new WeakMap<Stage, { agrees: () => boolean; clocks: () => number; errorDb: () => number; run: () => void }>();
const pulse = (st: Stage) => { st.sim!.setInput('clk', 1); st.sim!.settle(); st.sim!.setInput('clk', 0); st.sim!.settle(); };

const lmsPanel: ScenePanel = (stage: Stage): Widget => {
  const S = LMS_SPEC, makePlot = (clocks: number) => plotOf({ W: 380, H: 180, x: [0, clocks], y: [-1, 1], yTicks: [-1, 0, 1], xLabel: 'clock', yLabel: 'coefficient', aria: 'Four coefficients walking from zero toward the target, drawn beside it' });
  let tr: number[][] = [], ok = true, ran = 0, last = 0, mode = LMS_RUNS.loud, plot = makePlot(mode.clocks);
  const host = h('div', null, plot.el), read = h('div', { class: 'mc-status' }), note = h('p', { class: 'sub' });
  const paint = () => {
    plot.clear();
    LMS_TARGET.forEach((t) => line(plot, [0, mode.clocks], [t, t], 'ln-s lump'));
    tr.forEach((c) => line(plot, c.map((_, i) => i * mode.every), c, 'ln-s real'));
    read.replaceChildren(h('span', null, 'clocks ', h('b', null, String(ran))), h('span', null, 'output against d ', h('b', null, ran ? dbs(last) : '—')), h('span', null, 'target ', h('b', null, minus(LMS_TARGET.join(' ')))), h('span', null, 'now ', h('b', null, ran ? minus(tr.map((c) => num(c[c.length - 1], 2)).join(' ')) : '—')));
    note.textContent = !ran ? 'The filter never sees the target. It gets x, and d, which is x through an unknown filter.' : !ok ? 'The gates and the model disagreed.' : `At every clock the gates' coefficients and output matched the integer model.${mode === LMS_RUNS.quiet ? ` With x this small, e × x seldom gets past ±${2 ** (S.s - 1)}, so most updates round to nothing: the coefficients crawl, and stop short of the target.` : ''}`;
  };
  const run = (m0: typeof mode = LMS_RUNS.loud) => {
    stage.checkpoint();
    if (m0 !== mode) { mode = m0; plot = makePlot(mode.clocks); host.replaceChildren(plot.el); }
    const sim = stage.sim!, m = new LmsFixed(S), u = rng(21), hist = [0, 0, 0, 0], { clocks, amp, every: k0 } = mode;
    sim.reset('zero'); sim.setInput('clk', 0); sim.settle();
    tr = LMS_TARGET.map(() => []); ok = true; ran = 0;
    let a = 0, b = 0;
    for (let i = 0; i < clocks; i++) {
      const x = Math.max(-128, Math.min(127, Math.round(amp * gaussian(u)))), d = Math.max(-128, Math.min(127, Math.round(LMS_TARGET.reduce((s, t, k) => s + t * hist[k], 0))));
      if (i > (3 * clocks) / 4) { const e = m.e(d); a += d * d; b += e * e; }
      sim.setInput('x', wordOf(x, S.wx)); sim.setInput('d', wordOf(d, S.wx)); sim.settle();
      pulse(stage);
      m.edge(x, d);
      hist.pop(); hist.unshift(x);
      for (let k = 0; k < S.n; k++) { const c = signedOf(stage.value(`c${k}`), S.w); if (c !== m.c[k]) ok = false; if (i % k0 === 0) tr[k].push(c / 2 ** S.f); }
      if (signedOf(stage.value('y'), S.w) !== m.y) ok = false;
      ran++;
    }
    last = 10 * Math.log10(b / Math.max(a, 1e-9));
    stage.refresh();
    paint();
  };
  lmsApi.set(stage, { agrees: () => ok && ran > 0, clocks: () => ran, errorDb: () => last, run: () => run() });
  const el = h('div', { class: 'mem-panel cpu-panel mc-panel clk-panel mdm-panel', 'data-dock': 'right', 'data-phone': 'flow' }, h('h4', null, 'Learning a filter'),
    h('div', { class: 'dram-ops' }, h('button', { type: 'button', class: 'btn sm', onclick: () => run(LMS_RUNS.loud) }, 'Learn'), h('button', { type: 'button', class: 'btn sm', onclick: () => run(LMS_RUNS.quiet) }, 'Learn from a quiet input')), host, read, note);
  stage.resetHooks.add(() => { tr = []; ran = 0; paint(); });
  paint();
  return { el, update: () => {} };
};
export function lmsScene(): Scene {
  return { root: lmsFilter(LMS_SPEC), inputs: { x: 0, d: 0, clk: 0 }, clock: 'clk', autoClock: false, powerOn: 'zero', engine: 'cycle', panels: [lmsPanel] };
}
