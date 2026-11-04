// The Fourier explainers of chapters 46 and 45: a bit pattern as harmonics, cut or sent through the channel's pole, in time and in
// frequency; and a block of QPSK tones through an inverse FFT, a prefix, an echo and an FFT back. Every number is comm/fourier.ts's.

import { aOf, fftMults, gibbsOvershoot, ofdmLink, PATTERNS, poleAt, poleGain, qpskErrors, randomQpsk, seriesOf, sumAt, throughPole, toDb, toneGains } from '../comm/fourier';
import { h, s } from '../ui/dom';
import type { Widget } from '../view/stage';
import { line, mkChips, num, plotOf, type Plot } from './line';
import { fitText, slider } from './mosparts';
import '../styles/line.css';
import '../styles/fourier.css';

const db = (x: number) => `${x > -0.05 ? '0' : x.toFixed(1).replace('-', '−')} dB`;

// ---- a pattern as harmonics ---------------------------------------------------------------------------------------------------

/** A vertical marker with a label at the top of the plot, in the plot's clipped layer. */
function vmark(p: Plot, v: number, label: string, anchor: 'start' | 'end', cls: string) {
  const x = p.X(v);
  p.layer.append(s('line', { x1: x, x2: x, y1: p.Y(1.45), y2: p.Y(0), class: `fr-mark ${cls}` }), s('text', { x: x + (anchor === 'start' ? 4 : -4), y: p.Y(1.34), 'text-anchor': anchor, class: `fr-ml ${cls}` }, label));
}

export function harmonicsWidget(): Widget {
  let pat = 0, kept = 3, rate = 8, bw = 1;
  const WIN = 8, SAMPLES = 480;
  const time = plotOf({ W: 640, H: 220, x: [0, WIN], y: [-1.45, 1.45], yTicks: [-1, 0, 1], xLabel: 'bits', yLabel: 'level', aria: 'A repeating bit pattern, the sum of the harmonics kept, and the line\'s output, against time', xFmt: (v) => num(v, 0), yFmt: (v) => num(v, 0) });
  const spec = plotOf({ W: 640, H: 200, x: [0, 24], y: [0, 1.45], yTicks: [0, 0.5, 1], xLabel: 'GHz', yLabel: 'amplitude', aria: 'The pattern\'s harmonics before and after the line, with the line\'s gain, against frequency', yFmt: (v) => num(v, 1) });
  const chips = mkChips(4), note = h('p', { class: 'sub mos-note' });
  const sel = h('select', { 'aria-label': 'Bit pattern' }, ...PATTERNS.map((p, i) => h('option', { value: String(i) }, p.name))) as HTMLSelectElement;
  sel.addEventListener('change', () => { pat = Number(sel.value); paint(); });

  function paint() {
    const bits = PATTERNS[pat].bits, n = bits.length, f0 = rate / n, a = aOf(rate, bw);
    const fMax = 3 * rate, series = seriesOf(bits, Math.ceil(fMax / f0)), out = throughPole(series, n, rate, bw);
    const ts = Array.from({ length: SAMPLES + 1 }, (_, i) => (i / SAMPLES) * WIN);
    time.clear();
    line(time, ts, ts.map((t) => (bits[Math.min(n - 1, Math.floor(t % n))] ? 1 : -1)), 'ln-s lump');
    line(time, ts, ts.map((t) => sumAt(series, n, t, kept)), 'ln-s near');
    line(time, ts, ts.map((t) => poleAt(bits, rate, bw, t)), 'ln-s real');

    spec.setX(fMax);
    spec.clear();
    const fs = Array.from({ length: 121 }, (_, i) => (i / 120) * fMax);
    line(spec, fs, fs.map((f) => poleGain(f, bw)), 'ln-s fr-gain');
    vmark(spec, bw, `pole ${num(bw, 2)} GHz`, 'start', 'pole');
    if (rate / 2 > bw * 1.6 || rate / 2 < bw / 1.6) vmark(spec, rate / 2, `Nyquist ${num(rate / 2, 1)}`, 'start', 'nyq');
    const dx = Math.min(4, Math.max(1.5, (spec.X(f0) - spec.X(0)) / 4));
    const stem = (f: number, amp: number, off: number, cls: string) => spec.layer.append(s('line', { x1: spec.X(f) + off, x2: spec.X(f) + off, y1: spec.Y(0), y2: spec.Y(amp), class: `fr-stem ${cls}` }));
    series.harmonics.forEach((hm, i) => { stem(hm.k * f0, hm.amp, -dx / 2, i < kept ? 'in on' : 'in'); stem(hm.k * f0, out.harmonics[i].amp, dx / 2, 'out'); });

    let power = series.dc ** 2;
    for (const hm of series.harmonics.slice(0, kept)) power += hm.amp ** 2 / 2;
    const first = series.harmonics[0], ends = bits.map((_, i) => (bits[i] ? 1 : -1) * poleAt(bits, rate, bw, i + 1 - 1e-9));
    const margin = Math.min(...ends), half = 1 - 2 * a;
    chips.set(0, a.toFixed(3), 'a = e^(−2π B / R): what the line keeps of the last level after one bit');
    chips.set(1, db(toDb(poleGain(first.k * f0, bw))), `at the fundamental, ${num(first.k * f0, 2)} GHz: 0 dB at DC`);
    chips.set(2, margin.toFixed(3), 'smallest sample at the end of a bit, this pattern', margin <= 0 ? 'bad' : '');
    chips.set(3, half > 0 ? half.toFixed(3) : 'closed', 'half the eye, any pattern: 1 − 2a', half > 0 ? '' : 'bad');
    note.textContent = `The ${kept} harmonic${kept > 1 ? 's' : ''} kept hold ${(100 * power).toFixed(1)} % of the power${pat === 0 ? `; the first peak overshoots by ${(100 * gibbsOvershoot(kept)).toFixed(1)} % of the step, and more harmonics only narrow it` : ''}. A cut spectrum rings; the pole's spectrum falls smoothly, so it rounds and does not ring.`;
  }
  paint();
  const key = h('div', { class: 'ln-key' }, h('span', { class: 'fr-k bits' }, 'bits sent'), h('span', { class: 'k-near' }, 'sum of the harmonics kept'), h('span', { class: 'k-far' }, 'after the line'));
  const key2 = h('div', { class: 'ln-key' }, h('span', { class: 'fr-k kept' }, 'harmonics sent (kept in colour)'), h('span', { class: 'k-far' }, 'after the line'), h('span', { class: 'fr-k bits' }, 'the line\'s gain'));
  return {
    el: h('div', { class: 'widget mos sr-w' },
      h('div', { class: 'panel' }, h('h3', null, 'The same wave in time'), key, time.el),
      h('div', { class: 'panel' }, h('h3', null, 'And in frequency'), key2, spec.el),
      h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row' },
        h('label', { class: 'mos-sl ln-sel' }, h('span', null, 'Pattern'), sel),
        slider('Harmonics', 1, 25, 1, kept, (v) => String(v), (v) => { kept = v; paint(); }).el,
        slider('Rate', 1, 16, 0.5, rate, (v) => `${v.toFixed(1)} Gb/s`, (v) => { rate = v; paint(); }).el,
        slider('Bandwidth', 0.5, 4, 0.25, bw, (v) => `${v.toFixed(2)} GHz`, (v) => { bw = v; paint(); }).el), chips.el, note)),
  };
}

// ---- many tones, one FFT --------------------------------------------------------------------------------------------------------

/** A scatter of complex points on the four QPSK targets. */
function scatter(label: string) {
  const W = 220, R = 1.75, m = 12, X = (v: number) => W / 2 + (v / R) * (W / 2 - m), Y = (v: number) => W / 2 - (v / R) * (W / 2 - m);
  const svg = s('svg', { viewBox: `0 0 ${W} ${W}`, class: 'mos-plot fr-scatter', role: 'img', 'aria-label': label }) as SVGSVGElement;
  svg.append(s('line', { x1: m, x2: W - m, y1: Y(0), y2: Y(0), class: 'ax' }), s('line', { x1: X(0), x2: X(0), y1: m, y2: W - m, class: 'ax' }));
  for (const a of [-1, 1]) for (const b of [-1, 1]) svg.append(s('circle', { cx: X(a * Math.SQRT1_2), cy: Y(b * Math.SQRT1_2), r: 9, class: 'fr-target' }));
  fitText(svg, W);
  const dots = svg.appendChild(s('g'));
  return { svg, paint(pts: readonly (readonly [number, number])[]) { dots.replaceChildren(...pts.map(([a, b]) => s('circle', { cx: Math.max(2, Math.min(W - 2, X(a))), cy: Math.max(2, Math.min(W - 2, Y(b))), r: 3, class: 'fr-dot' }))); } };
}

const N_POINTS = 64, TONES = N_POINTS / 2 - 1;

export function ofdmWidget(): Widget {
  let cp = 0, delay = 5, echo = 0.6, seed = 1;
  const time = plotOf({ W: 640, H: 210, x: [0, N_POINTS + 16], y: [-0.5, 0.5], yTicks: [-0.4, 0, 0.4], xLabel: 'samples', yLabel: 'level', aria: 'The block as sent and as received, the prefix shaded', xFmt: (v) => num(v, 0), yFmt: (v) => num(v, 1) });
  const raw = scatter('The FFT\'s output per tone, before the one-tap equalizer'), eq = scatter('Each tone after its one complex tap, on the four QPSK points');
  const chips = mkChips(4), note = h('p', { class: 'sub mos-note' });

  function paint() {
    const sy = randomQpsk(TONES, seed), prev = randomQpsk(TONES, seed + 1000), taps = [1, ...Array<number>(delay).fill(0)];
    if (delay > 0) taps[delay] = echo; else taps[0] = 1 + echo;
    const r = ofdmLink(sy, prev, N_POINTS, cp, taps), H = toneGains(taps, N_POINTS);
    const errs = qpskErrors(sy, r.equalized), span = N_POINTS + cp;
    const peak = Math.max(0.2, ...Array.from(r.received, Math.abs), ...Array.from(r.sent, Math.abs)) * 1.1;
    time.setX(N_POINTS + 16); time.setY(-peak, peak);
    time.clear();
    if (cp > 0) time.layer.append(s('rect', { x: time.X(0), width: time.X(cp) - time.X(0), y: time.Y(peak), height: time.Y(-peak) - time.Y(peak), class: 'fr-prefix' }));
    const idx = Array.from({ length: span }, (_, i) => i);
    line(time, idx, Array.from(r.sent), 'ln-s near');
    line(time, idx, Array.from(r.received), 'ln-s real');
    raw.paint(r.raw);
    eq.paint(r.equalized);
    let weak = Infinity;
    for (let k = 1; k <= TONES; k++) weak = Math.min(weak, Math.hypot(H.re[k], H.im[k]));
    chips.set(0, `${errs} of ${2 * TONES}`, 'wrong bits after the equalizer', errs ? 'bad' : 'ok');
    chips.set(1, r.evm < 1e-9 ? 'none' : `${(100 * r.evm).toFixed(1)} %`, 'error vector left on the tones', r.evm < 1e-9 ? 'ok' : 'bad');
    chips.set(2, db(toDb(weak)), 'the weakest tone\'s gain');
    chips.set(3, `${fftMults(N_POINTS)} / ${N_POINTS * N_POINTS}`, 'multiplications a block: FFT / by definition');
    note.textContent = cp >= delay
      ? `The prefix of ${cp} covers the echo of ${delay}: the FFT sees a circular convolution, so tone k comes out as H[k] X[k], and one complex division on each tone puts all ${TONES} back on their points. The price is ${num((100 * cp) / span, 1)} % of the samples.`
      : `The echo of ${delay} is longer than the prefix of ${cp}: ${delay - cp} sample${delay - cp > 1 ? 's' : ''} of the block before leak in and the same number wrap around lost, so the tones are no longer orthogonal, and no division on one tone can remove what came from the others.`;
  }
  const prefix = slider('Prefix', 0, 16, 1, cp, (v) => `${v} samples`, (v) => { cp = v; paint(); });
  const newBits = h('button', { class: 'btn sm', type: 'button', title: 'Other bits on the tones' }, 'New bits');
  newBits.addEventListener('click', () => { seed++; paint(); });
  paint();
  const key = h('div', { class: 'ln-key' }, h('span', { class: 'k-near' }, 'as sent'), h('span', { class: 'k-far' }, 'as received'), h('span', { class: 'fr-k bits' }, 'shaded: the prefix'));
  return {
    el: h('div', { class: 'widget mos sr-w' },
      h('div', { class: 'panel' }, h('h3', null, `One block: ${TONES} QPSK tones through a ${N_POINTS}-point inverse FFT`), key, time.el),
      h('div', { class: 'panel fr-two' }, h('div', null, h('h3', null, 'Out of the FFT'), raw.svg), h('div', null, h('h3', null, 'After one complex tap a tone'), eq.svg)),
      h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row' }, prefix.el,
        slider('Echo delay', 0, 16, 1, delay, (v) => `${v} samples`, (v) => { delay = v; paint(); }).el,
        slider('Echo', 0, 0.95, 0.05, echo, (v) => v.toFixed(2), (v) => { echo = v; paint(); }).el, newBits), chips.el, note)),
  };
}
