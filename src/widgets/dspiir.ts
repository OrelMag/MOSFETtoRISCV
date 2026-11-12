// "IIR and stability": the mask and the five designs, the bilinear transform, a pole held in a register (dspzplane.ts's plane with a coefficient word), direct form
// against sections, the biquad in gates, a limit cycle, and the order of sections. Every number is dsp/iir.ts's, which tests/dsp-iir.test.ts holds to scipy.

import { signedOf, wordOf } from '../comm/signals';
import {
  analogGain, analogImpulse, analogPrototype, Biquad, pairPeak, endOf, BQ, burstThenSilence, cabs, cascadeSnr, coefWord, cycleSweep, deadBandOf, directHeld, directStable, FAMILIES, findCycle, kaiserTaps, LIMIT_CYCLE, lowpass, MASK,
  maskDesign, measuredSnr, noiseGain, snrAt, permutations, prefixPeaks, prewarp, runBiquad, scaleSos, sectionWords, sosGain, sosMults, sosMultsFolded, sosStable, sosToTf, SWEEP_VARIANTS,
  SWEEP_RUNS, warpedAt, wordsOf, zpkToSos, type Family, type Sos, type Words, type Zpk,
} from '../dsp/iir';
import { gainAt, polyRoots, type Cx } from '../dsp/zplane';
import { biquad } from '../lib/biquad';
import { treeMul } from '../lib/muldiv';
import { stats } from '../sim/stats';
import { analyzeTiming } from '../sim/timing';
import { flatten } from '../sim/flatten';
import { h, s } from '../ui/dom';
import type { Scene, ScenePanel, Stage, Widget } from '../view/stage';
import { clipButton } from './clip';
import { line, mkChips, num, plotOf, type Plot } from './line';
import { slider } from './mosparts';
import '../styles/line.css';
import '../styles/fourier.css';
import '../styles/signals.css';
import '../styles/dsp.css';
import { groupNum } from '../sim/numfmt';

const range = (n: number) => Array.from({ length: n }, (_, i) => i);
const TAU = 2 * Math.PI;
const dB = (g: number) => 20 * Math.log10(Math.max(g, 1e-6));
const grouped = (v: number) => groupNum(v);
const stems = (p: Plot, ys: readonly number[], cls = '', x0 = 0) => ys.forEach((y, i) => { if (y !== 0) p.layer.append(s('line', { x1: p.X(x0 + i), x2: p.X(x0 + i), y1: p.Y(0), y2: p.Y(y), class: `sg-stem ${cls}` })); });
const freqGrid = range(501).map((i) => (i / 500) * 0.5);

/** |H| of a zeros-poles-gain filter at f cycles a sample. */
export function zpkGain(f: Zpk, x: number): number {
  const w = { re: Math.cos(TAU * x), im: Math.sin(TAU * x) }, prod = (v: readonly Cx[]) => {
    let r = 1, i = 0;
    for (const q of v) { const a = w.re - q.re, b = w.im - q.im, t = r * a - i * b; i = r * b + i * a; r = t; }
    return Math.hypot(r, i);
  };
  return (f.k * prod(f.z)) / prod(f.p);
}

/** The pass and stop regions of the mask, shaded on a gain plot. */
function drawMask(p: Plot): void {
  const lo = -100;
  p.layer.append(
    s('rect', { x: p.X(0), y: p.Y(0), width: p.X(MASK.fp) - p.X(0), height: p.Y(-MASK.rp) - p.Y(0), class: 'dsp-mask' }),
    s('rect', { x: p.X(MASK.fs), y: p.Y(-MASK.rs), width: p.X(0.5) - p.X(MASK.fs), height: p.Y(lo) - p.Y(-MASK.rs), class: 'dsp-mask' }),
  );
}
const gainPlot = (aria: string, W = 640, H = 220) => plotOf({ W, H, x: [0, 0.5], y: [-100, 5], yTicks: [0, -20, -40, -60, -80, -100], xLabel: 'cycles a sample', yLabel: 'gain, dB', aria, yFmt: (v) => num(v, 0) });

// ---- one specification, five designs ----------------------------------------------------------------------------------------------------------

/** The smallest odd Parks–McClellan length that meets the mask (gain within 1 ± 0.00576, so 0.1 dB peak to peak; 60 dB) on an 8 192-point response, found by scipy's remez
 *  (scripts/dsp/oracle.py), held equal in tests/dsp-iir.test.ts. The smallest of any length is 114, an even one; the odd one has a tap in the middle and folds to 58. */
export const PM_TAPS = 115;
export interface DesignRow { id: string; name: string; size: string; mults: number; folded?: number; phase: string; family?: Family; sections?: Sos[] }
let rowsMemo: DesignRow[] | null = null;
export function designRows(): DesignRow[] {
  if (rowsMemo) return rowsMemo;
  const fir = (id: string, name: string, n: number): DesignRow => ({ id, name, size: `${n} taps`, mults: Math.ceil(n / 2), phase: 'Linear' });
  const iir = (f: Family): DesignRow => {
    const d = maskDesign(f), sec = zpkToSos(d.zpk);
    return { id: f, name: `${FAMILIES.find((x) => x.id === f)!.name} IIR`, size: `order ${d.order}, ${sec.length} sections`, mults: sosMults(sec), folded: sosMultsFolded(sec), phase: 'Not linear', family: f, sections: sec };
  };
  return (rowsMemo = [fir('pm', 'Parks–McClellan FIR', PM_TAPS), fir('kaiser', 'Kaiser window FIR', kaiserTaps()), iir('butter'), iir('cheby1'), iir('ellip')]);
}
export const mulNands = (): number => stats(treeMul(16, true)).nands;

export function maskWidget(): Widget {
  const rows = designRows(), mul = mulNands(), most = Math.max(...rows.map((r) => r.mults)) * mul;
  let pick = 4;
  const plot = gainPlot('The gain of the chosen IIR design against frequency, with the mask shaded'), chips = mkChips(3);
  const tbody = h('tbody');
  const paint = () => {
    tbody.replaceChildren(...rows.map((r, i) => h('tr', { class: i === pick ? 'sel' : '', tabindex: r.sections ? '0' : '-1', onclick: () => { if (r.sections) { pick = i; paint(); } }, onkeydown: (ev: Event) => { const e = ev as KeyboardEvent; if (r.sections && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); pick = i; paint(); } } },
      h('td', null, h('b', null, r.name)), h('td', null, r.size), h('td', { class: 'num' }, String(r.mults)), h('td', null, r.phase),
      h('td', { class: 'dsp-barcell' }, h('i', { style: `width:${Math.max(1, ((r.mults * mul) / most) * 100).toFixed(1)}%` }), h('span', { class: 'num' }, grouped(r.mults * mul))))));
    const r = rows[pick], sec = r.sections!;
    plot.clear();
    drawMask(plot);
    line(plot, freqGrid, freqGrid.map((f) => Math.max(-100, dB(sosGain(sec, f)))), 'real');
    const pass = Math.min(...freqGrid.filter((f) => f <= MASK.fp).map((f) => dB(sosGain(sec, f)))), stop = Math.max(...freqGrid.filter((f) => f >= MASK.fs).map((f) => dB(sosGain(sec, f))));
    chips.set(0, `${num(pass, 3)} dB`, `lowest gain in the pass band (the mask allows −${MASK.rp}; the top is 0)`, pass < -MASK.rp - 1e-6 ? 'bad' : '');
    chips.set(1, `${num(stop, 1)} dB`, `highest gain in the stop band (the mask asks −${MASK.rs} or less)`, stop > -MASK.rs + 1e-6 ? 'bad' : '');
    chips.set(2, `${r.mults} × ${grouped(mul)}`, 'multiplications × NANDs in a 16-bit signed multiplier, if all are built');
  };
  paint();
  return {
    el: h('div', { class: 'widget mos sr-w' },
      h('div', { class: 'panel' }, h('h3', null, `Pass to ${num(MASK.fp, 3)}, stop from ${num(MASK.fs, 3)} cycles a sample, ${MASK.rp} dB and ${MASK.rs} dB`),
        h('div', { class: 'dsp-scroll' }, h('table', { class: 'dsp-table dsp-designs' }, h('thead', null, h('tr', null, h('th', null, 'Design'), h('th', null, 'Size'), h('th', { class: 'num' }, 'Mults a sample'), h('th', null, 'Phase'), h('th', null, 'NANDs in multipliers'))), tbody)),
        h('p', { class: 'sub mos-note' }, 'Click an IIR row to draw it. A symmetric FIR folds its taps, so it multiplies half as often as it has taps; an IIR section is counted as built, five multipliers (a section with b₀ = b₂ could fold to four). Ripple is peak to peak.'),
        plot.el, chips.el)),
  };
}

// ---- the bilinear transform ------------------------------------------------------------------------------------------------------------------

function planeSvg(poles: readonly Cx[], zeros: readonly Cx[], win: { x0: number; x1: number; y0: number; y1: number }, unit: boolean, aria: string, W = 300, fixedH = 0, splane = false): SVGSVGElement {
  const Hh = fixedH || (W * (win.y1 - win.y0)) / (win.x1 - win.x0), X = (v: number) => ((v - win.x0) / (win.x1 - win.x0)) * W, Y = (v: number) => ((win.y1 - v) / (win.y1 - win.y0)) * Hh;
  const svg = s('svg', { viewBox: `0 0 ${W} ${Hh.toFixed(0)}`, class: 'dsp-plane dsp-mini', role: 'img', 'aria-label': aria }) as SVGSVGElement;
  svg.append(s('line', { x1: 0, x2: W, y1: Y(0), y2: Y(0), class: 'axis' }), s('line', { x1: X(0), x2: X(0), y1: 0, y2: Hh, class: 'axis' }));
  if (unit) {
    let d = '';
    for (let i = 0; i <= 200; i++) { const t = (i / 200) * TAU; d += `${i ? 'L' : 'M'}${X(Math.cos(t)).toFixed(1)},${Y(Math.sin(t)).toFixed(1)}`; }
    svg.append(s('path', { d, class: 'circle', fill: 'none' }));
  }
  // roots on one spot show how many: a Butterworth design has all its zeros at z = −1
  const spots = new Map<string, { x: number; y: number; n: number }>();
  for (const z of zeros) {
    svg.append(s('circle', { cx: X(z.re), cy: Y(z.im), r: 4, class: 'zero' }));
    const x = X(z.re), y = Y(z.im), k = `${Math.round(x)},${Math.round(y)}`, e = spots.get(k);
    if (e) e.n++; else spots.set(k, { x, y, n: 1 });
  }
  // a pole is a fault where it leaves the stable region: the unit circle in the z-plane, the right half of the s-plane
  for (const p of poles) { const x = X(p.re), y = Y(p.im), m = 5; svg.append(s('path', { d: `M${x - m} ${y - m}L${x + m} ${y + m}M${x - m} ${y + m}L${x + m} ${y - m}`, class: `pole${(splane ? p.re >= 0 : cabs(p) >= 1) ? ' out' : ''}` })); }
  for (const e of spots.values()) if (e.n > 1) svg.append(s('text', { x: e.x + 7, y: e.y - 7, class: 'count' }, `×${e.n}`));
  return svg;
}

export function bilinearWidget(): Widget {
  let kind: Family = 'butter', n = 4, f = 0.1, warp = true;
  const plot = gainPlot('The gain of the digital filter, with the edge you asked for marked', 640, 190), chips = mkChips(4), planes = h('div', { class: 'dsp-pair' });
  const sel = h('select', { 'aria-label': 'Family' }, ...FAMILIES.map((x) => h('option', { value: x.id }, x.name))) as HTMLSelectElement;
  sel.addEventListener('change', () => { kind = sel.value as Family; paint(); });
  const box = h('input', { type: 'checkbox', checked: true, 'aria-label': 'Prewarp the edge' }) as HTMLInputElement;
  box.addEventListener('change', () => { warp = box.checked; paint(); });
  const paint = () => {
    const proto = analogPrototype(kind, n, 0.1, 60), w = warp ? prewarp(f) : TAU * f;
    const analog: Zpk = { z: proto.z.map((q) => ({ re: q.re * w, im: q.im * w })), p: proto.p.map((q) => ({ re: q.re * w, im: q.im * w })), k: proto.k * w ** (proto.p.length - proto.z.length) };
    // the same transform lowpass() does, with the analog edge chosen here; the edge it lands at is warpedAt(w)
    const dig = lowpass(kind, n, warpedAt(w), 0.1, 60);
    planes.replaceChildren(
      h('figure', null, planeSvg(analog.p, analog.z, { x0: -w * 1.6, x1: w * 0.4, y0: -w * 1.6, y1: w * 1.6 }, false, 'The analog poles in the s-plane', 300, 0, true), h('figcaption', null, 'analog poles, s-plane (stable: left of the axis), edge ', h('b', null, `${num(w, 3)} rad/s`))),
      h('figure', null, planeSvg(dig.p, dig.z, { x0: -1.3, x1: 1.3, y0: -1.3, y1: 1.3 }, true, 'The digital poles and zeros in the z-plane'), h('figcaption', null, 'digital, z-plane, after s → (2 + s) / (2 − s)')));
    plot.clear();
    plot.layer.append(s('line', { x1: plot.X(f), x2: plot.X(f), y1: plot.Y(5), y2: plot.Y(-100), class: 'ln-h th' }));
    line(plot, freqGrid, freqGrid.map((x) => Math.max(-100, dB(zpkGain(dig, x)))), 'real');
    const landed = warpedAt(w);
    chips.set(0, `${num(w, 4)} rad/s`, warp ? `analog edge, 2 tan(π × ${num(f, 3)})` : `analog edge, 2π × ${num(f, 3)}: no prewarp`);
    chips.set(1, `${num(landed, 4)}`, `where the edge lands, cycles a sample (asked ${num(f, 3)})`, Math.abs(landed - f) > 1e-9 ? 'bad' : '');
    chips.set(2, String(dig.p.length), 'poles, every one inside the circle: ' + (dig.p.every((q) => cabs(q) < 1) ? 'yes' : 'no'));
    chips.set(3, `${dig.z.filter((q) => Math.abs(q.re + 1) < 1e-9 && Math.abs(q.im) < 1e-9).length} of ${dig.z.length}`, 'zeros at z = −1: the analog filter\'s zero at infinity lands at half the sample rate');
  };
  paint();
  return {
    el: h('div', { class: 'widget mos sr-w' },
      h('div', { class: 'panel' }, h('h3', null, 'An analog filter, mapped'), planes, h('div', { class: 'ln-key' }, h('span', { class: 'fr-k' }, 'edge asked for'), h('span', { class: 'k-far' }, 'gain of the digital filter')), plot.el, chips.el),
      h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row' },
        h('label', { class: 'mos-sl ln-sel' }, h('span', null, 'Family'), sel),
        slider('Order', 2, 12, 1, n, (v) => String(v), (v) => { n = v; paint(); }).el,
        slider('Edge, cycles a sample', 0.02, 0.45, 0.005, f, (v) => num(v, 3), (v) => { f = v; paint(); }).el),
        h('label', { class: 'dsp-check' }, box, h('span', null, 'Prewarp the analog edge (ω = 2 tan πf); off: ω = 2πf')))),
  };
}

// ---- the s-plane ------------------------------------------------------------------------------------------------------------------------------

/** The s-plane step's figure: its starting pair, its RC and its Butterworth corner. */
export const SPLANE = { sigma: -0.3, omega: 2, R: 10e3, C: 10e-9, wc: 1 };
type SMode = 'pair' | 'rc' | 'butter';

export function sPlaneWidget(): Widget {
  let mode: SMode = 'pair', { sigma, omega, R, C, wc } = SPLANE;
  const chips = mkChips(4), planeBox = h('div', { class: 'dsp-splane' }), plotBox = h('div', { class: 'dsp-splots' });
  // RC: the plane in units of 10⁴ s⁻¹, time in µs, frequency in kHz; the other two in s⁻¹, s and rad/s
  const win = () => (mode === 'rc' ? { x0: -5, x1: 1, y0: -3, y1: 3 } : { x0: -2.5, x1: 1, y0: -4, y1: 4 });
  const poles = (): Cx[] => mode === 'rc' ? [{ re: -1 / (R * C), im: 0 }]
    : mode === 'butter' ? analogPrototype('butter', 2).p.map((q) => ({ re: q.re * wc, im: q.im * wc }))
      : [{ re: sigma, im: omega }, { re: sigma, im: -omega }];
  let imp: Plot, gain: Plot;
  const makePlots = () => {
    const rc = mode === 'rc';
    imp = plotOf({ W: 320, H: 190, x: [0, rc ? 500 : 10], y: [-1.1, 1.1], yTicks: [-1, 0, 1], xLabel: rc ? 'time, µs' : 'time, s', yLabel: 'h(t), scaled', aria: 'The impulse response, scaled to fit' });
    gain = plotOf({ W: 320, H: 190, x: [0, rc ? 20 : 5], y: rc ? [-30, 3] : [-40, 30], yTicks: rc ? [-30, -20, -10, -3, 0] : [-40, -20, 0, 20], xLabel: rc ? 'frequency, kHz' : 'ω, rad/s', yLabel: 'gain, dB', aria: 'The gain along the imaginary axis' });
    plotBox.replaceChildren(h('figure', null, imp.el, h('figcaption', null, 'impulse response')), h('figure', null, gain.el, h('figcaption', null, 'gain along the axis, s = jω')));
  };
  const paint = () => {
    const P = poles(), rc = mode === 'rc', u = rc ? 1e4 : 1, w = win();
    planeBox.replaceChildren(planeSvg(P.map((q) => ({ re: q.re / u, im: q.im / u })), [], w, false, 'The s-plane with the poles: stable left of the vertical axis', 260, 260, true),
      h('p', { class: 'sub mos-note' }, rc ? 's-plane, units of 10 000 s⁻¹' : mode === 'pair' ? 's-plane: drag the upper pole (its mirror follows)' : 's-plane'));
    imp.clear(); gain.clear();
    const ts = range(401).map((i) => (i / 400) * (rc ? 500e-6 : 10)), hs = ts.map((t) => analogImpulse(P, t)), top = Math.max(...hs.map(Math.abs)) || 1;
    line(imp, ts.map((t) => (rc ? t * 1e6 : t)), hs.map((v) => v / top), 'real');
    const unstable = P.some((q) => q.re >= 0);
    if (!unstable) {
      const xs = range(401).map((i) => (i / 400) * (rc ? 20 : 5));
      line(gain, xs, xs.map((x) => Math.max(-100, Math.min(100, dB(analogGain(P, [], rc ? TAU * x * 1e3 : x))))), 'real');
      gain.layer.append(s('line', { x1: gain.x0, x2: gain.x1, y1: gain.Y(-3.0103), y2: gain.Y(-3.0103), class: 'ln-h th' }));
    }
    if (mode === 'pair') {
      const left = Math.exp(10 * sigma), pk = pairPeak(sigma, omega);
      chips.set(0, `${num(sigma, 2)} ± j${num(omega, 2)}`, 'the pole pair, in s⁻¹: σ ± jω');
      chips.set(1, sigma < 0 ? `${num(left * 100, 1)} %` : sigma === 0 ? '100 %' : `× ${num(left, 2)}`, sigma < 0 ? 'of its size left after 10 s, e^(10σ)' : sigma === 0 ? 'left after 10 s: on the axis it rings for ever' : 'grown in 10 s, e^(10σ)');
      chips.set(2, sigma < 0 ? 'stable' : sigma === 0 ? 'on the axis' : 'unstable', sigma < 0 ? 'left of the axis' : sigma === 0 ? 'never decays' : 'right of the axis: it grows', sigma < 0 ? '' : 'bad');
      chips.set(3, unstable ? 'none' : pk ? `+${num(dB(pk.gain), 2)} dB` : 'no peak', unstable ? 'no steady gain: the response grows without bound' : pk ? `peak gain, at ${num(pk.at, 3)} rad/s (1 at ω = 0)` : 'the gain only falls: σ is too far left for ω');
    } else if (rc) {
      const fc = 1 / (TAU * R * C), at = (f: number) => dB(analogGain(P, [], TAU * f));
      chips.set(0, `−${grouped(Math.round(1 / (R * C)))} s⁻¹`, 'the pole, at −1 / RC');
      chips.set(1, `${num(R * C * 1e6, 1)} µs`, 'RC, the time constant: 63 % after it');
      chips.set(2, `${num(fc, 1)} Hz`, `the corner, 1 / 2πRC: ${num(at(fc), 2)} dB`);
      chips.set(3, `${num(at(fc / 10), 3)} / ${num(at(fc * 10), 2)} dB`, 'at a tenth of the corner and at ten times it');
    } else {
      const q = P[0];
      chips.set(0, `${num(q.re, 4)} ± j${num(Math.abs(q.im), 4)}`, 'the Butterworth pair, in s⁻¹');
      chips.set(1, `${num(cabs(q), 3)}`, 'its distance from 0, the corner in rad/s, at 45° either side of the negative axis');
      chips.set(2, `${num(dB(analogGain(P, [], wc)), 2)} dB`, 'the gain at the corner');
      chips.set(3, 'stable', 'left of the axis, for any corner');
    }
    for (const [k, b] of Object.entries(btns)) b.setAttribute('aria-pressed', String(k === mode));
    planeBox.classList.toggle('drag', mode === 'pair');
    sPair.el.hidden = mode !== 'pair'; sRc.el.hidden = mode !== 'rc'; sBu.el.hidden = mode !== 'butter';
  };
  const sSig = slider('σ, s⁻¹', -2, 0.8, 0.05, sigma, (v) => num(v, 2), (v) => { sigma = v; paint(); });
  const sOm = slider('ω, rad/s', 0.2, 3.8, 0.05, omega, (v) => num(v, 2), (v) => { omega = v; paint(); });
  const sR = slider('R, kΩ', 5, 20, 1, R / 1e3, (v) => String(v), (v) => { R = v * 1e3; paint(); });
  const sC = slider('C, nF', 5, 20, 1, C * 1e9, (v) => String(v), (v) => { C = v * 1e-9; paint(); });
  const sW = slider('Corner, rad/s', 0.3, 3, 0.05, wc, (v) => num(v, 2), (v) => { wc = v; paint(); });
  const sPair = { el: h('div', { class: 'mos-row' }, sSig.el, sOm.el) }, sRc = { el: h('div', { class: 'mos-row' }, sR.el, sC.el) }, sBu = { el: h('div', { class: 'mos-row' }, sW.el) };
  const pick = (m: SMode) => { if (m !== mode) { mode = m; makePlots(); paint(); } };
  const btns: Record<SMode, HTMLElement> = {
    pair: h('button', { type: 'button', class: 'btn sm', onclick: () => pick('pair') }, 'Pole pair'),
    rc: h('button', { type: 'button', class: 'btn sm', onclick: () => pick('rc') }, 'RC'),
    butter: h('button', { type: 'button', class: 'btn sm', onclick: () => pick('butter') }, 'Butterworth 2'),
  };
  // dragging the upper pole of the pair (the mirror follows); the sliders do the same from the keyboard
  let dragging = false;
  const dragTo = (e: PointerEvent) => {
    const svg = planeBox.querySelector('svg');
    if (!svg) return;
    const r = svg.getBoundingClientRect(), w = win();
    const x = w.x0 + ((e.clientX - r.left) / r.width) * (w.x1 - w.x0), y = w.y1 - ((e.clientY - r.top) / r.height) * (w.y1 - w.y0);
    sigma = Math.round(Math.max(-2, Math.min(0.8, x)) * 20) / 20; omega = Math.round(Math.max(0.2, Math.min(3.8, Math.abs(y))) * 20) / 20;
    sSig.set(sigma); sOm.set(omega); paint();
  };
  planeBox.addEventListener('pointerdown', (e) => { if (mode !== 'pair') return; dragging = true; planeBox.setPointerCapture(e.pointerId); dragTo(e); });
  planeBox.addEventListener('pointermove', (e) => { if (dragging) dragTo(e); });
  const stop = () => { dragging = false; };
  planeBox.addEventListener('pointerup', stop); planeBox.addEventListener('pointercancel', stop);
  makePlots(); paint();
  return {
    el: h('div', { class: 'widget mos sr-w' },
      h('div', { class: 'panel' }, h('h3', null, 'Poles in the s-plane'), h('div', { class: 'dsp-sgrid' }, planeBox, plotBox), chips.el),
      h('div', { class: 'panel mos-ctl' }, h('div', { class: 'dram-ops' }, btns.pair, btns.rc, btns.butter), sPair.el, sRc.el, sBu.el)),
  };
}

// ---- one polynomial or small sections ---------------------------------------------------------------------------------------------------------

export const NARROW = { order: 6, f: 0.04, rp: 0.1, rs: 60 };
let narrowMemo: { zpk: Zpk; sos: Sos[]; b: number[]; a: number[] } | null = null;
/** The narrow elliptic low-pass of this step: order 6, pass edge 0.04 cycles a sample, 0.1 dB, 60 dB. */
export function narrowFilter() {
  if (!narrowMemo) {
    const zpk = lowpass('ellip', NARROW.order, NARROW.f, NARROW.rp, NARROW.rs), sos = zpkToSos(zpk), tf = sosToTf(sos);
    narrowMemo = { zpk, sos, b: tf.b, a: tf.a };
  }
  return narrowMemo;
}
/** The first width, from `from` up to 32, at which the direct form is stable. */
export const firstStableWidth = (from = 8): number | null => { const n = narrowFilter(); for (let b = from; b <= 32; b++) if (directStable(n.a, b)) return b; return null; };
export const sectionsStableFrom = (to = 8): boolean => { const n = narrowFilter(); for (let b = to; b <= 32; b++) if (!sosStable(n.sos, b).every(Boolean)) return false; return true; };

export function sensitivityWidget(): Widget {
  let bits = 14;
  const F = narrowFilter(), plot = gainPlot('The gain of the narrow filter in direct form and in sections, each with its coefficients rounded', 640, 200), chips = mkChips(4), planes = h('div', { class: 'dsp-pair' });
  const win = { x0: 0.8, x1: 1.04, y0: -0.3, y1: 0.3 }, PH = 200;
  const paint = () => {
    const heldA = directHeld(F.a, bits), dfOk = directStable(F.a, bits), roots = polyRoots(heldA), secOk = sosStable(F.sos, bits);
    const heldSec = F.sos.map((q) => { const [A1, A2] = sectionWords(q.a[1], q.a[2], bits), S = 2 ** (bits - 2); return { a1: A1 / S, a2: A2 / S, q }; });
    const secRoots: Cx[] = heldSec.flatMap(({ a1, a2 }) => { const d = a1 * a1 - 4 * a2; return d < 0 ? [{ re: -a1 / 2, im: Math.sqrt(-d) / 2 }, { re: -a1 / 2, im: -Math.sqrt(-d) / 2 }] : [{ re: (-a1 + Math.sqrt(d)) / 2, im: 0 }, { re: (-a1 - Math.sqrt(d)) / 2, im: 0 }]; });
    const ideal = polyRoots(F.a);
    const overlay = (svg: SVGSVGElement, held: Cx[]) => {
      const W = 300, Hh = PH, X = (v: number) => ((v - win.x0) / (win.x1 - win.x0)) * W, Y = (v: number) => ((win.y1 - v) / (win.y1 - win.y0)) * Hh;
      for (const q of ideal) svg.append(s('circle', { cx: X(q.re), cy: Y(q.im), r: 6, class: 'asked' }));
      for (const q of held) if (q.re >= win.x0 && q.re <= win.x1 && Math.abs(q.im) <= win.y1) { const x = X(q.re), y = Y(q.im), m = 5; svg.append(s('path', { d: `M${x - m} ${y - m}L${x + m} ${y + m}M${x - m} ${y + m}L${x + m} ${y - m}`, class: `pole${cabs(q) >= 1 ? ' out' : ''}` })); }
    };
    const a = planeSvg([], [], win, true, 'Direct form: the poles held, zoomed to z = 1', 300, PH), b = planeSvg([], [], win, true, 'Sections: the poles held, zoomed to z = 1', 300, PH);
    overlay(a, roots); overlay(b, secRoots);
    const outside = roots.filter((q) => q.re < win.x0 || q.re > win.x1 || Math.abs(q.im) > win.y1).length;
    planes.replaceChildren(
      h('figure', null, a, h('figcaption', null, h('b', { class: dfOk ? '' : 'bad' }, dfOk ? 'Direct form: stable' : 'Direct form: unstable'), ` (roots found numerically${outside ? `; ${outside} outside this view` : ''})`)),
      h('figure', null, b, h('figcaption', null, h('b', { class: secOk.every(Boolean) ? '' : 'bad' }, secOk.every(Boolean) ? 'Three sections: stable' : 'A section is unstable'), ' (each pair from its own two words)')));
    plot.clear();
    line(plot, freqGrid, freqGrid.map((x) => Math.max(-100, dB(sosGain(F.sos, x)))), 'lump');
    if (dfOk) line(plot, freqGrid, freqGrid.map((x) => Math.max(-100, dB(gainAt(F.b, heldA, x)))), 'near');
    if (secOk.every(Boolean)) line(plot, freqGrid, freqGrid.map((x) => Math.max(-100, dB(heldSec.reduce((g, { a1, a2, q }) => g * gainAt(q.b, [1, a1, a2], x), 1)))), 'real');
    const first = firstStableWidth();
    chips.set(0, dfOk ? 'stable' : 'unstable', `direct form at ${bits} bits: one polynomial of degree ${NARROW.order}`, dfOk ? '' : 'bad');
    chips.set(1, secOk.every(Boolean) ? 'stable' : 'unstable', `${F.sos.length} sections at ${bits} bits: each a₁, a₂ in Q2.${bits - 2}`, secOk.every(Boolean) ? '' : 'bad');
    chips.set(2, first === null ? 'none to 32' : `${first} bits`, 'the narrowest word at which the direct form is stable (from 8)');
    chips.set(3, sectionsStableFrom() ? 'every width from 8' : 'not all', 'widths at which the sections are stable');
  };
  paint();
  return {
    el: h('div', { class: 'widget mos sr-w' },
      h('div', { class: 'panel' }, h('h3', null, `Elliptic low-pass, order ${NARROW.order}, edge ${NARROW.f} cycles a sample`), planes,
        h('div', { class: 'ln-key' }, h('span', { class: 'fr-k' }, 'ideal'), h('span', { class: 'k-near' }, 'direct form, held'), h('span', { class: 'k-far' }, 'sections, held')), plot.el, chips.el,
        h('p', { class: 'sub mos-note' }, 'The numerator is kept exact here: stability depends on the feedback alone. Rings are the poles asked for, crosses what the words hold.')),
      h('div', { class: 'panel mos-ctl' }, slider('Coefficient word', 8, 32, 1, bits, (v) => `${v} bits`, (v) => { bits = v; paint(); }).el)),
  };
}

// ---- the biquad in gates ---------------------------------------------------------------------------------------------------------------------

/** A resonator or notch as Q2.14 words, scaled for a gain of 1 where it matters. */
export function resonatorWords(r: number, f: number): Words {
  const a1 = -2 * r * Math.cos(TAU * f), a2 = r * r, A = Math.hypot(1 + a1 * Math.cos(TAU * f) + a2 * Math.cos(2 * TAU * f), a1 * Math.sin(TAU * f) + a2 * Math.sin(2 * TAU * f));
  return wordsOf({ b: [A, 0, 0], a: [1, a1, a2] });
}
export function notchWords(r: number, f: number): Words {
  const c = Math.cos(TAU * f), a1 = -2 * r * c, a2 = r * r, g = (1 + a1 + a2) / (2 - 2 * c);
  return wordsOf({ b: [g, -2 * c * g, g], a: [1, a1, a2] });
}
export const BIQUAD_FILTERS: { name: string; words: Words }[] = [
  { name: 'Resonator: r = 0.9 at 0.1 cycles a sample', words: resonatorWords(0.9, 0.1) },
  { name: 'Notch at 0.2, poles at r = 0.9', words: notchWords(0.9, 0.2) },
];
const BQ_INPUTS: { name: string; at: (n: number) => number }[] = [
  { name: 'An impulse', at: (n) => (n === 0 ? 16000 : 0) },
  { name: 'A step', at: () => 8000 },
  { name: 'A tone at 0.1', at: (n) => Math.round(12000 * Math.sin(TAU * 0.1 * n)) },
  { name: 'A tone at 0.2', at: (n) => Math.round(12000 * Math.sin(TAU * 0.2 * n)) },
];

const pulse = (st: Stage) => { st.sim!.setInput('clk', 1); st.sim!.settle(); st.sim!.setInput('clk', 0); st.sim!.settle(); };
const setWords = (st: Stage, w: Words) => { for (const [k, v] of Object.entries(w)) st.sim!.setInput(k, wordOf(v, 16)); };
const ZERO_WORDS: Words = { b0: 0, b1: 0, b2: 0, a1: 0, a2: 0 };

/** Run an input through the gates and the model together; every output is compared. */
export function runOnGates(st: Stage, w: Words, xs: readonly number[]): { gates: number[]; model: number[]; same: boolean } {
  const sim = st.sim!;
  // empty the registers: with every coefficient zero the output is zero, and four clocks push four zeros through (a limit cycle would never flush with its own coefficients)
  setWords(st, ZERO_WORDS); sim.setInput('x', 0); sim.settle();
  for (let i = 0; i < 4; i++) pulse(st);
  setWords(st, w); sim.settle();
  const m = new Biquad(w), gates: number[] = [], model: number[] = [];
  let same = true;
  for (const x of xs) {
    sim.setInput('x', wordOf(x, 16)); sim.settle();
    const y = signedOf(st.value('y'), 16), ym = m.step(x);
    if (y !== ym) same = false;
    gates.push(y); model.push(ym);
    pulse(st);
  }
  return { gates, model, same };
}

const costRead = (): { nands: number; mul: number; depth: number } => {
  const d = biquad(), t = analyzeTiming(flatten(d), { outputs: true });
  return { nands: stats(d).nands, mul: mulNands(), depth: t ? t.period : 0 };
};
let costMemo: ReturnType<typeof costRead> | null = null;
export const biquadCost = () => (costMemo ??= costRead());

const tourPanel: ScenePanel = (stage: Stage): Widget => {
  let f = 0, inp = 0, xs: number[] = [], ys: number[] = [], ym: number[] = [], same = true;
  const N = 96, plot = plotOf({ W: 380, H: 120, x: [0, N], y: [-1.1, 1.1], yTicks: [-0.2, 0, 0.2], xLabel: 'clock', yLabel: 'out', aria: 'The biquad\'s output, gates and model' });
  const inPlot = plotOf({ W: 380, H: 120, x: [0, N], y: [-1.1, 1.1], yTicks: [-0.5, 0, 0.5], xLabel: '', yLabel: 'in', aria: 'The input' });
  const read = h('div', { class: 'mc-status' }), note = h('p', { class: 'sub' });
  const paint = () => {
    plot.clear(); inPlot.clear();
    if (xs.length) {
      const top = Math.max(0.05, ...ys.map((v) => Math.abs(v) / 32768)) * 1.25, topIn = Math.max(0.05, ...xs.map((v) => Math.abs(v) / 32768)) * 1.25;
      plot.setY(-top, top); inPlot.setY(-topIn, topIn);
      stems(inPlot, xs.map((v) => v / 32768));
      line(plot, range(ym.length), ym.map((v) => v / 32768), 'ln-s near');
      line(plot, range(ys.length), ys.map((v) => v / 32768), 'ln-s real');
    }
    const cost = biquadCost();
    read.replaceChildren(h('span', null, h('b', null, grouped(cost.nands)), ' NANDs'), h('span', null, h('b', null, String(cost.depth)), ' NAND delays per clock'), h('span', null, 'peak out ', h('b', null, num(Math.max(0, ...ys.map((v) => Math.abs(v) / 32768)), 3))));
    note.textContent = xs.length ? (same ? 'Every output of the gates matched the model at every clock.' : 'The gates and the model disagreed.') : 'Pick an input: the samples go in at the clock, the gates compute, and the model runs beside them.';
  };
  const run = () => {
    stage.checkpoint();
    xs = range(N).map(BQ_INPUTS[inp].at);
    ({ gates: ys, model: ym, same } = runOnGates(stage, BIQUAD_FILTERS[f].words, xs));
    stage.refresh();
    paint();
  };
  const sel = h('select', { 'aria-label': 'Filter' }, ...BIQUAD_FILTERS.map((x, i) => h('option', { value: String(i) }, x.name))) as HTMLSelectElement;
  sel.addEventListener('change', () => { f = Number(sel.value); });
  const el = h('div', { class: 'mem-panel cpu-panel mc-panel clk-panel mdm-panel', 'data-dock': 'right', 'data-phone': 'flow' }, h('h4', null, 'An input through the gates'),
    h('label', { class: 'dsp-field' }, h('span', null, 'Coefficients'), sel),
    h('div', { class: 'dram-ops' }, ...BQ_INPUTS.map((x, i) => h('button', { type: 'button', class: 'btn sm', onclick: () => { inp = i; run(); } }, x.name))),
    h('div', { class: 'ln-key' }, h('span', { class: 'fr-k' }, 'input (own scale)')), inPlot.el, plot.el, h('div', { class: 'ln-key' }, h('span', { class: 'k-far' }, 'gates'), h('span', { class: 'k-near' }, 'model (on the gates)')), read, note);
  stage.resetHooks.add(() => { xs = []; ys = []; ym = []; paint(); });
  paint();
  return { el, update: () => {} };
};

export const cycleInputs = (): number[] => burstThenSilence(LIMIT_CYCLE.amp, LIMIT_CYCLE.burst, LIMIT_CYCLE.cycles);
export const dbfs = (lsb: number): number => 20 * Math.log10(lsb / 2 ** BQ.f);

const cyclePanel: ScenePanel = (stage: Stage): Widget => {
  let ys: number[] = [], same = true, toward: number[] = [];
  const full = plotOf({ W: 380, H: 150, x: [0, LIMIT_CYCLE.cycles], y: [-520, 520], yTicks: [-500, 0, 500], xLabel: 'clock', yLabel: 'LSB', aria: 'The output of the gates after one input word, then silence' });
  const tail = plotOf({ W: 380, H: 130, x: [0, 40], y: [-7, 7], yTicks: [-5, 0, 5], xLabel: 'the last 40 clocks', yLabel: 'LSB', aria: 'The last forty outputs, enlarged' });
  const read = h('div', { class: 'mc-status' }), note = h('p', { class: 'sub' });
  const paint = () => {
    full.clear(); tail.clear();
    if (ys.length) {
      line(full, range(ys.length), ys, 'ln-s real');
      const last = ys.slice(-40);
      stems(tail, last);
      line(tail, range(40), toward.slice(-40), 'ln-s near');
      tail.layer.append(s('line', { x1: tail.x0, x2: tail.x1, y1: tail.Y(0), y2: tail.Y(0), class: 'ln-h th' }));
    }
    const cy = ys.length ? findCycle(ys, 16) : null;
    read.replaceChildren(
      h('span', null, 'cycle ', h('b', null, cy ? `period ${cy.period}` : ys.length ? 'none' : '—')),
      h('span', null, 'peak ', h('b', null, cy ? `${cy.peak} LSB` : '—')),
      h('span', null, 'level ', h('b', null, cy ? `${num(dbfs(cy.peak), 1)} dBFS` : '—')));
    note.textContent = !ys.length ? 'Send one input word and then silence. The model beside the gates is run, too, with the rounding toward zero.'
      : cy ? `${same ? 'Gates and model agreed at every clock. ' : 'The gates and the model disagreed. '}The input stopped after ${LIMIT_CYCLE.burst} sample; the output did not.` : 'It died away.';
  };
  const run = () => {
    stage.checkpoint();
    const xs = cycleInputs();
    const r = runOnGates(stage, LIMIT_CYCLE.words, xs);
    ys = r.gates; same = r.same;
    toward = runBiquad(LIMIT_CYCLE.words, xs, { round: 'zero' });
    stage.refresh();
    paint();
  };
  const el = h('div', { class: 'mem-panel cpu-panel mc-panel clk-panel mdm-panel', 'data-dock': 'right', 'data-phone': 'flow' }, h('h4', null, 'One word in, then silence'),
    h('div', { class: 'dram-ops' }, h('button', { type: 'button', class: 'btn sm', onclick: run }, `Send ${LIMIT_CYCLE.burst} word of ${LIMIT_CYCLE.amp}, then ${LIMIT_CYCLE.cycles - LIMIT_CYCLE.burst} zeros`)),
    full.el, tail.el, h('div', { class: 'ln-key' }, h('span', { class: 'k-far' }, 'gates (rounds half up)'), h('span', { class: 'k-near' }, 'model, rounds toward zero')), read, note);
  stage.resetHooks.add(() => { ys = []; toward = []; paint(); });
  paint();
  return { el, update: () => {} };
};

const unsigned = (w: Words): Record<string, number> => Object.fromEntries(Object.entries(w).map(([k, v]) => [k, wordOf(v, 16)]));
export function biquadScene(): Scene {
  return { root: biquad(), inputs: { x: 0, clk: 0, ...unsigned(BIQUAD_FILTERS[0].words) }, clock: 'clk', autoClock: false, powerOn: 'zero', panels: [tourPanel], hiddenOutputs: ['sat'] };
}
export function cycleScene(): Scene {
  return { root: biquad(), inputs: { x: 0, clk: 0, ...unsigned(LIMIT_CYCLE.words) }, clock: 'clk', autoClock: false, powerOn: 'zero', panels: [cyclePanel], hiddenOutputs: ['sat'] };
}

// ---- what removes a limit cycle --------------------------------------------------------------------------------------------------------------

const ROUNDS: { id: string; name: string; round: 'half-up' | 'trunc' | 'zero' }[] = [{ id: 'half-up', name: 'Round half up (as built)', round: 'half-up' }, { id: 'trunc', name: 'Floor: drop the bits', round: 'trunc' }, { id: 'zero', name: 'Toward zero', round: 'zero' }];
export const CYCLE_RATE = 8000;

/** Toward zero is not a cure near the circle: radius 0.998, one input of 2972 twice. */
export const NEAR_CIRCLE: Words = { b0: 1024, b1: 0, b2: 0, a1: -28873, a2: 16328 };
export const NEAR_INPUT = { amp: 2972, burst: 2 };

export function limitCycleWidget(): Widget {
  let r = 0.95, f = 0.25, ri = 0, extra = 0, found: { runs: number; cycling: number[] } | null = null;
  let custom: Words | null = null, amp: number = LIMIT_CYCLE.amp, burst: number = LIMIT_CYCLE.burst;
  const full = plotOf({ W: 640, H: 150, x: [0, 800], y: [-520, 520], yTicks: [-500, 0, 500], xLabel: 'clock', yLabel: 'LSB', aria: 'The output after one input word, then silence' });
  const tail = plotOf({ W: 640, H: 120, x: [0, 48], y: [-8, 8], yTicks: [-5, 0, 5], xLabel: 'the last 48 clocks', yLabel: 'LSB', aria: 'The last forty-eight outputs, enlarged' });
  const chips = mkChips(4), sweep = h('div', { class: 'dsp-sweep' });
  let ys: number[] = [];
  const words = (): Words => custom ?? ({ b0: 1024, b1: 0, b2: 0, a1: coefWord(-2 * r * Math.cos(TAU * f)), a2: coefWord(r * r) });
  const paint = () => {
    const w = words();
    ys = runBiquad(w, burstThenSilence(amp, burst, 4000), { round: ROUNDS[ri].round, extra });
    const end = endOf(ys, 32), cy = typeof end === 'string' ? null : end, top = Math.max(1, ...ys.slice(0, 800).map(Math.abs)) * 1.1;
    full.setY(-top, top); full.clear(); line(full, range(800), ys.slice(0, 800), 'real');
    tail.clear(); tail.layer.append(s('line', { x1: tail.x0, x2: tail.x1, y1: tail.Y(0), y2: tail.Y(0), class: 'ln-h th' }));
    const lastPk = Math.max(1, ...ys.slice(-48).map(Math.abs));
    tail.setY(-lastPk * 1.4, lastPk * 1.4); stems(tail, ys.slice(-48));
    chips.set(0, cy ? `period ${cy.period}, peak ${cy.peak} LSB` : end === 'dead' ? 'dies away' : 'no short cycle', cy ? `from clock ${cy.start} on, never stops${cy.start > 800 ? ' (past the plot, which ends at 800)' : ''}` : end === 'dead' ? 'the output ends at zero' : 'still moving after 4 000 clocks, or a period over 32', cy ? 'bad' : '');
    chips.set(1, cy ? `${num(dbfs(cy.peak), 1)} dBFS` : '—', 'level of the cycle against full scale');
    const db = deadBandOf(w);
    chips.set(2, db === null ? 'only for a₁ = 0' : num(db, 2), db === null ? '½ / (1 − a₂) holds when a₁ = 0; here a₁ ≠ 0 and the cycle can be far larger' : `½ / (1 − a₂): the dead band, a₂ = ${w.a2} / 2^14 = ${num(w.a2 / 2 ** BQ.cf, 4)}`);
    chips.set(3, `radius ${num(Math.sqrt(w.a2 / 2 ** BQ.cf), 4)}`, `a₁ = ${num(w.a1 / 2 ** BQ.cf, 4)}, angle ${num(Math.acos(Math.max(-1, Math.min(1, -w.a1 / 2 ** BQ.cf / (2 * Math.sqrt(w.a2 / 2 ** BQ.cf))))) / TAU, 3)} cycles`);
    clip.reset();
  };
  const sel = h('select', { 'aria-label': 'Rounding' }, ...ROUNDS.map((x, i) => h('option', { value: String(i) }, x.name))) as HTMLSelectElement;
  sel.addEventListener('change', () => { ri = Number(sel.value); paint(); });
  const rSl = slider('Pole radius', 0.8, 0.999, 0.001, r, (v) => num(v, 3), (v) => { r = v; custom = null; paint(); });
  const fSl = slider('Pole angle, cycles', 0, 0.5, 0.005, f, (v) => num(v, 3), (v) => { f = v; custom = null; paint(); });
  const exSl = slider('Extra bits kept in y[n−1], y[n−2]', 0, 8, 1, extra, (v) => String(v), (v) => { extra = v; paint(); });
  const showSweep = () => {
    sweep.replaceChildren(h('table', { class: 'dsp-table' }, h('thead', null, h('tr', null, h('th', null, 'Variant'), h('th', { class: 'num' }, `Runs ending in a cycle, of ${found!.runs}`))),
      h('tbody', null, ...SWEEP_VARIANTS.map((v, i) => h('tr', null, h('td', null, v.name), h('td', { class: 'num' }, String(found!.cycling[i])))))));
  };
  const clip = clipButton('Listen to the cycle', () => {
    const y = runBiquad(words(), burstThenSilence(amp, burst, CYCLE_RATE * 2), { round: ROUNDS[ri].round, extra }), cy = findCycle(y, 32);
    return cy ? { samples: y.slice(-CYCLE_RATE), rate: CYCLE_RATE, source: 'model' as const, note: `the cycle alone, ${cy.peak} LSB = ${num(dbfs(cy.peak), 1)} dBFS, raised to the player's level` } : null;
  }, 'No cycle to play: nothing repeats');
  paint();
  return {
    el: h('div', { class: 'widget mos sr-w' },
      h('div', { class: 'panel' }, h('h3', null, 'Silence in, and what comes out'), full.el, tail.el, chips.el, clip.el),
      h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row' },
        rSl.el,
        fSl.el,
        h('label', { class: 'mos-sl ln-sel' }, h('span', null, 'Rounding'), sel),
        exSl.el),
        h('div', { class: 'dram-ops' },
          h('button', { type: 'button', class: 'btn sm', onclick: () => { found ??= cycleSweep(); showSweep(); } }, `Search ${SWEEP_RUNS} pole positions`),
          h('button', { type: 'button', class: 'btn sm', onclick: () => { custom = NEAR_CIRCLE; amp = NEAR_INPUT.amp; burst = NEAR_INPUT.burst; ri = 2; extra = 0; exSl.set(0); sel.value = '2'; rSl.set(0.998); fSl.set(0.078); paint(); } }, 'Near the circle'),
          h('button', { type: 'button', class: 'btn sm', onclick: () => { custom = null; amp = LIMIT_CYCLE.amp; burst = LIMIT_CYCLE.burst; r = 0.95; f = 0.25; ri = 0; extra = 0; sel.value = '0'; rSl.set(r); fSl.set(f); exSl.set(0); paint(); } }, "The gates' cycle")), sweep)),
  };
}

// ---- order and scaling -----------------------------------------------------------------------------------------------------------------------

export function orderData() {
  const base = designRows()[4].sections!;
  const rows = permutations(base.length).map((p) => {
    const raw = p.map((i) => base[i]), scaled = scaleSos(raw);
    return { p, raw, scaled, snrRaw: cascadeSnr(raw), snrScaled: cascadeSnr(scaled) };
  });
  return { base, rows };
}
let orderMemo: ReturnType<typeof orderData> | null = null;

export function orderWidget(): Widget {
  const D = (orderMemo ??= orderData());
  let scaled = true, pick = 0;
  const chips = mkChips(4), list = h('div', { class: 'dsp-orders' });
  const sorted = (): typeof D.rows => [...D.rows].sort((a, b) => (scaled ? b.snrScaled - a.snrScaled : b.snrRaw - a.snrRaw));
  const paint = () => {
    const rows = sorted(), vals = rows.map((r) => (scaled ? r.snrScaled : r.snrRaw)), lo = Math.min(...vals) - 2, hi = Math.max(...vals);
    pick = Math.min(pick, rows.length - 1);
    list.replaceChildren(...rows.map((r, i) => h('button', { type: 'button', class: `dsp-order${i === pick ? ' sel' : ''}`, 'aria-pressed': i === pick ? 'true' : 'false', onclick: () => { pick = i; paint(); } },
      h('span', { class: 'n' }, r.p.map((x) => D.base.length - x).join(' ')), h('i', { style: `width:${Math.max(2, ((vals[i] - lo) / (hi - lo + 2)) * 100).toFixed(1)}%` }), h('b', null, `${num(vals[i], 1)}`))));
    const r = rows[pick], sec = scaled ? r.scaled : r.raw, peaks = prefixPeaks(sec), amp = Math.min(0.9, 0.9 / Math.max(...peaks));
    const m = measuredSnr(sec, amp);
    chips.set(0, peaks.map((v) => num(v, 2)).join('  '), 'peak gain from the input to each section\'s output, in this order (above 1 overflows a full-scale sine)', Math.max(...peaks) > 1.0001 ? 'bad' : '');
    chips.set(1, `${num(amp, 2)}`, 'the largest sine (fraction of full scale, at most 0.9) that overflows no section');
    chips.set(2, `${num(10 * Math.log10(noiseGain(sec)), 1)} dB`, 'rounding noise at the output, in units of one rounding (1 / 12 LSB²): predicted');
    chips.set(3, `${num(m.snr, 1)} dB`, `signal to rounding noise, measured on the model's words (predicted ${num(snrAt(sec, amp), 1)} at this amplitude)`, m.overflows ? 'bad' : '');
  };
  const box = h('input', { type: 'checkbox', checked: true, 'aria-label': 'Scale the sections' }) as HTMLInputElement;
  box.addEventListener('change', () => { scaled = box.checked; paint(); });
  paint();
  return {
    el: h('div', { class: 'widget mos sr-w' },
      h('div', { class: 'panel' }, h('h3', null, `All ${D.rows.length} orders of the ${D.base.length} sections of the mask's elliptic filter`),
        h('p', { class: 'sub mos-note' }, 'Each bar is signal to rounding noise, dB, for the largest sine that overflows no section. The digits name the sections by the closeness of their poles to the circle: 1 is the nearest. The left digit comes first.'),
        list, chips.el),
      h('div', { class: 'panel mos-ctl' }, h('label', { class: 'dsp-check' }, box, h('span', null, 'Scale each section so a full-scale sine reaches every output at gain 1')))),
  };
}
