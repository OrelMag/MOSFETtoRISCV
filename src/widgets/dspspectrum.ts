// "Measuring a spectrum": a tone's skirt, the windows that shape it, two tones close together, zero padding, a spectrogram, overlap-save, Goertzel, and
// the Goertzel cell in gates decoding a keypad. Every number is dsp/spectrum.ts's (held to scipy by tests/dsp-spectrum.test.ts); the cell is lib/goertzel.ts.

import { signedOf, wordOf } from '../comm/signals';
import {
  amplitudeSpectrum, bestBlock, blockErrors, binsBreakEven, centred, coefWord, crossoverTaps, dbOf, dftPowerAt, DIP_NEEDED, dipIn, dipOf, directMults, DTMF_COLS, DTMF_FS, DTMF_KEYS, DTMF_ROWS, dtmfBlock, dtmfClip, dtmfDecode,
  dtmfFreqs, fftRealMults, goertzelCoef, goertzelFx, goertzelPower, goertzelRun, keyAt, olsMults, overlapSave, paddedLength, pairOf, seenAt, skirtAt, spectrogram, spectrogramSignal, tone,
  windowFigures, windowName, windowOf, windowTransform, WINDOWS, type WinKind, SEEN_BY,
} from '../dsp/spectrum';
import { windowedSinc } from '../comm/signals';
import { convolve } from '../dsp/zplane';
import { goertzelCell, GZ_STATE } from '../lib/goertzel';
import { h, s } from '../ui/dom';
import type { Scene, ScenePanel, Stage, Widget } from '../view/stage';
import { clipButton } from './clip';
import { line, mkChips, num, plotOf, type Plot } from './line';
import { slider } from './mosparts';
import '../styles/line.css';
import '../styles/fourier.css';
import '../styles/signals.css';
import '../styles/dsp.css';

const range = (n: number) => Array.from({ length: n }, (_, i) => i);
const FLOOR = -120;
const dbl = (m: number) => Math.max(FLOOR, dbOf(m, FLOOR));
const hz = (v: number) => (v >= 1000 ? `${num(v / 1000, 2)} kHz` : `${num(v, v < 100 ? 1 : 0)} Hz`);

const windowSelect = (get: () => WinKind, set: (k: WinKind) => void, kinds: readonly WinKind[] = WINDOWS.map((w) => w.id)) => {
  const sel = h('select', { 'aria-label': 'Window' }, ...kinds.map((k) => h('option', { value: k, selected: k === get() }, windowName(k)))) as HTMLSelectElement;
  sel.addEventListener('change', () => set(sel.value as WinKind));
  return h('label', { class: 'mos-sl ln-sel' }, h('span', null, 'Window'), sel);
};

// ---- a tone that is not a line ---------------------------------------------------------------------------------------------------------------

export const LEAK_N = 64;
export const LEAK_AWAY = 16;
/** What the leakage widget reads off a tone at  bins: the largest bin, the bin LEAK_AWAY away, and how many bins read above −60 dB. */
export function leakStats(f: number, kind: WinKind): { top: number; far: number; above60: number } {
  const bins = amplitudeSpectrum(tone(LEAK_N, f / LEAK_N), kind, 1);
  return { top: Math.max(...bins), far: bins[Math.min(LEAK_N / 2, Math.round(f) + LEAK_AWAY)], above60: bins.filter((m) => dbl(m) > -60).length };
}
export function leakageWidget(kinds: readonly WinKind[] = ['rect']): Widget {
  let f = 10.5, kind: WinKind = kinds[0];
  const N = LEAK_N, PAD = 16;
  const plot = plotOf({ W: 640, H: 230, x: [0, N / 2], y: [FLOOR, 6], yTicks: [0, -20, -40, -60, -80, -100], xLabel: 'bins (cycles per block)', yLabel: '', aria: 'The spectrum of one tone: the bins the transform has, and the curve between them', yFmt: (v) => num(v, 0) });
  const chips = mkChips(3), note = h('p', { class: 'sub mos-note' });
  const paint = () => {
    const x = tone(N, f / N), dense = amplitudeSpectrum(x, kind, PAD), bins = amplitudeSpectrum(x, kind, 1);
    plot.clear();
    line(plot, dense.map((_, i) => i / PAD), dense.map(dbl), 'lump');
    bins.forEach((m, k) => plot.layer.append(s('line', { x1: plot.X(k), x2: plot.X(k), y1: plot.Y(FLOOR), y2: plot.Y(dbl(m)), class: 'sg-stem' }), s('circle', { cx: plot.X(k), cy: plot.Y(dbl(m)), r: 3, class: 'sg-pt real' })));
    const { top, far, above60 } = leakStats(f, kind);
    chips.set(0, `${num(top, 3)}  (${num(dbOf(top), 1)} dB)`, 'the largest bin, for a tone of amplitude 1');
    chips.set(1, dbl(far) <= FLOOR ? `below ${FLOOR} dB` : `${num(dbl(far), 1)} dB`, `the bin ${LEAK_AWAY} bins away`);
    chips.set(2, String(above60), 'of the 33 bins read above −60 dB');
    const onBin = Math.abs(f - Math.round(f)) < 1e-9;
    note.textContent = onBin ? 'The tone fits the block a whole number of times, so all the other bins of the transform land on zeros of the skirt. The skirt is still there between the bins, in grey.'
      : `Between bins the block cuts the tone off in the middle of a cycle. Each bin now reads a different point of the same skirt, and none is zero.`;
  };
  paint();
  return {
    el: h('div', { class: 'widget mos sr-w' },
      h('div', { class: 'panel' }, h('h3', null, `${N} samples of one tone`), h('div', { class: 'ln-key' }, h('span', { class: 'fr-k' }, 'the skirt, finely sampled'), h('span', { class: 'k-far' }, 'what the transform gives: one value a bin'), h('span', { class: 'fr-k' }, '0 dB = a tone of amplitude 1')), plot.el, chips.el, note),
      h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row' }, slider('Tone, in bins', 8, 13, 0.05, f, (v) => num(v, 2), (v) => { f = v; paint(); }).el,
        kinds.length > 1 ? windowSelect(() => kind, (k) => { kind = k; paint(); }, kinds) : ''))),
  };
}

// ---- windows ---------------------------------------------------------------------------------------------------------------------------------

export function windowsWidget(): Widget {
  let kind: WinKind = 'hann';
  const N = 64, BINS = 12;
  const tw = plotOf({ W: 300, H: 170, x: [0, N], y: [0, 1.05], yTicks: [0, 0.5, 1], xLabel: 'sample n', yLabel: '', aria: 'The window over one block' });
  const fr = plotOf({ W: 460, H: 170, x: [0, BINS], y: [-120, 6], yTicks: [0, -20, -40, -60, -80, -100], xLabel: 'bins from the tone', yLabel: '', aria: 'The window\'s transform: the skirt a tone takes', yFmt: (v) => num(v, 0) });
  const rows = h('tbody');
  const fig = (k: WinKind) => windowFigures(k, 128);
  const paint = () => {
    const w = windowOf(kind, N), t = windowTransform(kind, 128, BINS);
    tw.clear(); line(tw, range(N), w, 'real');
    fr.clear(); line(fr, t.map((_, i) => i / 32), t.map((m) => Math.max(-120, dbOf(m))), 'real');
    rows.replaceChildren(...WINDOWS.map((x) => { const f = fig(x.id); return h('tr', { class: x.id === kind ? 'on' : '' }, h('td', null, x.name), h('td', { class: 'num' }, num(f.mainLobeBins, 1)), h('td', { class: 'num' }, num(f.sidelobeDb, 1)), h('td', { class: 'num' }, num(f.enbw, 3)), h('td', { class: 'num' }, num(f.scallopDb, 2))); }));
  };
  paint();
  return {
    el: h('div', { class: 'widget mos sr-w' },
      h('div', { class: 'panel dsp-wgrid' }, h('div', null, h('h3', null, 'The window, w[n]'), tw.el), h('div', null, h('h3', null, 'The skirt it gives a tone (its transform), dB'), fr.el)),
      h('div', { class: 'panel' }, h('table', { class: 'dsp-table' }, h('thead', null, h('tr', null, h('th', null, 'Window'), h('th', { class: 'num' }, 'Main lobe, bins'), h('th', { class: 'num' }, 'Highest sidelobe, dB'), h('th', { class: 'num' }, 'Noise bandwidth, bins'), h('th', { class: 'num' }, 'Loss at half a bin, dB'))), rows)),
      h('div', { class: 'panel mos-ctl' }, windowSelect(() => kind, (k) => { kind = k; paint(); }))),
  };
}

// ---- two tones -------------------------------------------------------------------------------------------------------------------------------

export const RES_N = 64;
export function resolveWidget(): Widget {
  let kind: WinKind = 'rect', sep = 6, rel = -40;
  const N = RES_N, PAD = 16;
  const plot = plotOf({ W: 640, H: 240, x: [0, 32], y: [FLOOR, 6], yTicks: [0, -20, -40, -60, -80, -100], xLabel: 'bins', yLabel: '', aria: 'The spectrum of two tones', yFmt: (v) => num(v, 0) });
  const chips = mkChips(4);
  const paint = () => {
    const p = pairOf(N, sep, rel), x = centred(N, p.f1 / N).map((v, n) => v + centred(N, (p.f1 + sep) / N, 10 ** (rel / 20))[n]);
    const S = amplitudeSpectrum(x, kind, PAD), alone = amplitudeSpectrum(centred(N, p.f1 / N), kind, PAD);
    plot.setX(32);
    plot.clear();
    line(plot, alone.map((_, i) => i / PAD), alone.map(dbl), 'lump');
    line(plot, S.map((_, i) => i / PAD), S.map(dbl), 'real');
    for (const [nu, y] of [[p.f1, 0], [p.f1 + sep, rel]] as [number, number][]) plot.layer.append(s('circle', { cx: plot.X(nu), cy: plot.Y(Math.max(FLOOR, y)), r: 5, class: 'sg-pt' }));
    const d = dipOf(N, sep, kind), seen = seenAt(N, sep, rel, kind);
    chips.set(0, `${num(d.dipDb, 1)} dB`, `dip if the two tones were equal, ${num(sep, 2)} bins apart`, d.resolved ? '' : 'bad');
    chips.set(1, d.resolved ? 'resolved' : d.dipDb >= 0.5 ? 'a shallow dip' : 'one lump', d.resolved ? `a dip of ${DIP_NEEDED} dB or more` : d.dipDb >= 0.5 ? `a dip shows, but ${DIP_NEEDED} dB is the rule` : `needs a dip of ${DIP_NEEDED} dB`, d.resolved ? '' : 'bad');
    chips.set(2, `${num(skirtAt(kind, sep, N), 1)} dB`, `the top of this window's skirt ${num(sep, 2)} bins from a tone`);
    chips.set(3, seen.seen ? 'seen' : 'hidden', `the weak tone stands ${num(Math.abs(seen.byDb), 1)} dB ${seen.byDb >= 0 ? 'above' : 'below'} that skirt; ${SEEN_BY} dB above counts`, seen.seen ? '' : 'bad');
  };
  paint();
  return {
    el: h('div', { class: 'widget mos sr-w' },
      h('div', { class: 'panel' }, h('h3', null, `Two tones in ${N} samples`), h('div', { class: 'ln-key' }, h('span', { class: 'fr-k' }, 'the first tone alone'), h('span', { class: 'k-far' }, 'both tones'), h('span', { class: 'k-near' }, '● where the tones are'), h('span', { class: 'fr-k' }, '0 dB = the first tone')), plot.el, chips.el),
      h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row' },
        windowSelect(() => kind, (k) => { kind = k; paint(); }),
        slider('Separation, bins', 0.5, 12, 0.05, sep, (v) => num(v, 2), (v) => { sep = v; paint(); }).el,
        slider('Second tone', -100, 0, 1, rel, (v) => `${v} dB`, (v) => { rel = v; paint(); }).el))),
  };
}

// ---- zero padding ----------------------------------------------------------------------------------------------------------------------------

export const PAD_F1 = 0.2;
export const PAD_GAP = 0.02;
export const PADS = [1, 2, 4, 8, 16];
export const padTones = (N: number): number[] => centred(N, PAD_F1).map((v, n) => v + centred(N, PAD_F1 + PAD_GAP)[n]);
/** The dip between the two tones of this step, read off the underlying curve (a ×16 pad) of the very block drawn. */
export const padDip = (N: number, kind: WinKind) => dipIn(amplitudeSpectrum(padTones(N), kind, 16), paddedLength(N, 16) / N, PAD_F1 * N, (PAD_F1 + PAD_GAP) * N);
/** The fewest samples (any number) at which the two tones show a dip. */
export function minSamples(kind: WinKind): number { for (let N = 16; N < 400; N++) if (padDip(N, kind).resolved) return N; return Infinity; }
export function padWidget(): Widget {
  let N = 32, pi = 0, kind: WinKind = 'hann';
  const plot = plotOf({ W: 640, H: 220, x: [0, 0.5], y: [0, 2.2], yTicks: [0, 1, 2], xLabel: 'cycles a sample', yLabel: '', aria: 'The spectrum of two close tones, the points the transform computes', xFmt: (v) => num(v, 2) });
  const chips = mkChips(4);
  const paint = () => {
    const sepBins = PAD_GAP * N, pad = PADS[pi], P = paddedLength(N, pad);
    const S = amplitudeSpectrum(padTones(N), kind, pad);
    plot.clear();
    line(plot, S.map((_, i) => i / P), S, 'real');
    if (P / 2 <= 140) S.forEach((m, i) => plot.layer.append(s('circle', { cx: plot.X(i / P), cy: plot.Y(m), r: 2.6, class: 'sg-pt' })));
    plot.layer.append(...[PAD_F1, PAD_F1 + PAD_GAP].map((f) => s('line', { x1: plot.X(f), x2: plot.X(f), y1: plot.Y(0), y2: plot.Y(2.2), class: 'ln-h th' })));
    const d = padDip(N, kind);
    chips.set(0, `${num(sepBins, 2)} bins`, `the tones are ${PAD_GAP} cycles a sample apart; one bin is 1 / ${N} of the rate`);
    chips.set(1, String(P), 'points in the transform: samples plus zeros');
    chips.set(2, `${num(d.dipDb, 1)} dB`, 'dip between the tones');
    chips.set(3, d.resolved ? 'resolved' : d.dipDb >= 0.5 ? 'a shallow dip' : 'one lump', d.resolved ? `a dip of ${DIP_NEEDED} dB or more` : d.dipDb >= 0.5 ? `a dip shows, but ${DIP_NEEDED} dB is the rule` : `needs a dip of ${DIP_NEEDED} dB`, d.resolved ? '' : 'bad');
  };
  paint();
  return {
    el: h('div', { class: 'widget mos sr-w' },
      h('div', { class: 'panel' }, h('h3', null, 'The same two tones, drawn with more points'), h('div', { class: 'ln-key' }, h('span', { class: 'k-far' }, 'the transform, linear amplitude'), h('span', { class: 'k-near' }, '● the points computed'), h('span', { class: 'fr-k' }, '| where the tones are')), plot.el, chips.el),
      h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row' },
        slider('Samples', 16, 160, 8, N, (v) => String(v), (v) => { N = v; paint(); }).el,
        slider('Zero padding', 0, PADS.length - 1, 1, pi, (v) => `× ${PADS[v]}`, (v) => { pi = v; paint(); }).el,
        windowSelect(() => kind, (k) => { kind = k; paint(); }, ['rect', 'hann', 'blackman'])))),
  };
}

// ---- a spectrogram ---------------------------------------------------------------------------------------------------------------------------

export const SG_FRAMES = [32, 64, 128, 256, 512];
const RAMP: [number, number, number][] = [[12, 14, 30], [52, 36, 120], [130, 50, 150], [225, 90, 90], [250, 190, 70], [255, 250, 200]];
const ramp = (t: number): string => {
  const u = Math.max(0, Math.min(1, t)) * (RAMP.length - 1), i = Math.min(RAMP.length - 2, Math.floor(u)), f = u - i;
  return `rgb(${RAMP[i].map((c, k) => Math.round(c + (RAMP[i + 1][k] - c) * f)).join(',')})`;
};
export function spectrogramWidget(): Widget {
  let fi = 2, hopDiv = 2, kind: WinKind = 'hann';
  const x = spectrogramSignal(), W = 640, H = 256;
  const canvas = h('canvas', { width: W, height: H, class: 'dsp-sg', role: 'img', 'aria-label': 'Spectrogram: time across, frequency up, level as colour' }) as HTMLCanvasElement;
  const chips = mkChips(4), gap = h('p', { class: 'sub dsp-sgnote' });
  const paint = () => {
    const N = SG_FRAMES[fi], hop = Math.max(1, N / hopDiv), g = spectrogram(x, N, hop, kind), bins = N / 2 + 1, c = canvas.getContext('2d');
    const f = windowFigures(kind, 128);
    if (c) {
      c.fillStyle = ramp(0); c.fillRect(0, 0, W, H);
      const cw = Math.max(1, (hop / x.length) * W);
      g.forEach((fr, t) => { const x0 = ((t * hop + N / 2) / x.length) * W - cw / 2; fr.forEach((m, k) => { c.fillStyle = ramp((dbOf(m, -90) + 70) / 70); c.fillRect(x0, H - ((k + 1) / bins) * H, cw + 0.6, H / bins + 0.6); }); });
    }
    chips.set(0, hz((f.mainLobeBins * DTMF_FS) / N), `main lobe, ${num(f.mainLobeBins, 0)} bins of ${hz(DTMF_FS / N)}: the frequency detail`);
    chips.set(1, `${num((N / DTMF_FS) * 1000, 1)} ms`, `a frame of ${N} samples: the time detail`);
    chips.set(2, String(g.length), `frames, one every ${hop} samples (${num((hop / DTMF_FS) * 1000, 1)} ms)`);
    chips.set(3, `${num((g.length * N) / x.length, 1)} ×`, 'samples computed per sample of signal: the cost of overlap');
    gap.textContent = `Each frame is drawn at its middle: the first and last ${N / 2} samples have no whole frame centred on them, so they stay blank.`;
  };
  paint();
  const clip = clipButton('Play the signal', () => ({ samples: x, rate: DTMF_FS, source: 'model', note: 'chirp, steady tone and two bursts, 8 kHz' }));
  return {
    el: h('div', { class: 'widget mos sr-w' },
      h('div', { class: 'panel' }, h('h3', null, `${x.length} samples at ${DTMF_FS / 1000} kHz: a rising chirp, a steady tone, two short bursts`),
        h('div', { class: 'dsp-sgbox' }, h('div', { class: 'dsp-sgy' }, ...['4 kHz', '3 kHz', '2 kHz', '1 kHz', '0'].map((t) => h('span', null, t))), canvas),
        h('div', { class: 'dsp-sgx' }, h('span', null, '0'), h('span', null, `${num((x.length / DTMF_FS) * 1000, 0)} ms`)),
        h('div', { class: 'dsp-sgkey' }, h('span', null, '−70 dB'), h('i', { style: `background:linear-gradient(90deg,${RAMP.map((c, i) => `rgb(${c.join(',')}) ${(i / (RAMP.length - 1)) * 100}%`).join(',')})` }), h('span', null, '0 dB, a tone of amplitude 1')), gap, chips.el),
      h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row' },
        slider('Frame length', 0, SG_FRAMES.length - 1, 1, fi, (v) => `${SG_FRAMES[v]} samples`, (v) => { fi = v; paint(); }).el,
        slider('Overlap', 0, 3, 1, Math.log2(hopDiv), (v) => (v === 0 ? 'none' : `${(1 - 1 / 2 ** v) * 100} %`), (v) => { hopDiv = 2 ** v; paint(); }).el,
        windowSelect(() => kind, (k) => { kind = k; paint(); }, ['rect', 'hann', 'blackman'])), clip.el)),
  };
}

// ---- overlap-save ----------------------------------------------------------------------------------------------------------------------------

export const OLS_LEN = 600;
export const olsSignal = (): number[] => Array.from({ length: OLS_LEN }, (_, i) => Math.sin(2 * Math.PI * 0.03 * i) + 0.6 * Math.sin(2 * Math.PI * 0.31 * i + 1) + 0.3 * Math.sin(i * 12.9898));
export function olsWidget(): Widget {
  let M = 33, Nexp = 7;
  const x = olsSignal();
  const plot = plotOf({ W: 640, H: 170, x: [0, 300], y: [-2, 2], yTicks: [-1, 0, 1], xLabel: 'sample n', yLabel: '', aria: 'The filtered signal by blocks, and the direct form over it' });
  const strip = s('svg', { viewBox: '0 0 640 54', class: 'dsp-blocks', role: 'img', 'aria-label': 'The blocks laid over the input' }) as SVGSVGElement;
  const chips = mkChips(5);
  const paint = () => {
    const N = 2 ** Nexp, h_ = windowedSinc(M, 0.1), direct = convolve(x, h_), run = overlapSave(x, h_, N), L = N - M + 1, err = Math.max(...run.y.map((v, i) => Math.abs(v - direct[i]))), be = blockErrors(x, h_, N);
    plot.clear();
    line(plot, range(300), direct.slice(0, 300), 'lump');
    line(plot, range(300), run.y.slice(0, 300), 'real');
    const u = 600 / (3 * L + M - 1);
    strip.replaceChildren(...range(3).flatMap((b) => [
      s('rect', { x: 20 + b * L * u, y: 6 + b * 14, width: Math.max(1, N * u), height: 12, class: 'dsp-blk' }),
      s('rect', { x: 20 + b * L * u, y: 6 + b * 14, width: Math.max(1, (M - 1) * u), height: 12, class: 'dsp-blk drop' }),
    ]));
    chips.set(0, `${L}`, `new samples a block: ${N} − ${M} + 1; the first ${M - 1} outputs are thrown away`);
    chips.set(1, `${run.blocks}`, 'blocks for this signal');
    chips.set(2, err < 1e-9 ? '< 1e-9' : num(err, 12), 'largest difference from the direct form, the first M − 1 of each block thrown away');
    chips.set(4, `${num(be.wrapped, 2)} and ${be.kept < 1e-9 ? '< 1e-9' : num(be.kept, 12)}`, 'largest error of a block kept whole: in its first M − 1 samples, and in the rest', 'bad');
    chips.set(3, `${num(directMults(M), 0)} against ${num(olsMults(M, N), 1)}`, `real multiplications a sample, direct form and blocks (blocks win from ${crossoverTaps()} taps, with the best block)`, olsMults(M, N) < M ? '' : 'bad');
  };
  paint();
  return {
    el: h('div', { class: 'widget mos sr-w' },
      h('div', { class: 'panel' }, h('h3', null, 'A long filter by blocks'), h('div', { class: 'ln-key' }, h('span', { class: 'fr-k' }, 'output:'), h('span', { class: 'fr-k' }, 'direct form'), h('span', { class: 'k-far' }, 'by blocks')), plot.el,
        h('div', { class: 'ln-key' }, h('span', { class: 'fr-k' }, 'three blocks of the input; the shaded start of each is the part thrown away')), strip, chips.el),
      h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row' },
        slider('Taps', 8, 60, 1, M, (v) => String(v), (v) => { M = v; paint(); }).el,
        slider('Block', 6, 10, 1, Nexp, (v) => String(2 ** v), (v) => { Nexp = v; paint(); }).el))),
  };
}
export const olsBest = (M: number): number => bestBlock(M);

// ---- Goertzel on a model ---------------------------------------------------------------------------------------------------------------------

export function goertzelWidget(): Widget {
  let tone_ = 1000, target = 1000, N = 205;
  const states = plotOf({ W: 640, H: 170, x: [0, 256], y: [-1, 1], yTicks: [0], xLabel: 'sample n', yLabel: '', aria: 'The Goertzel state against the sample number' });
  const sweep = plotOf({ W: 640, H: 190, x: [0, DTMF_FS / 2], y: [-80, 6], yTicks: [0, -20, -40, -60], xLabel: 'Hz, the frequency Goertzel is set to', yLabel: '', aria: 'The power Goertzel reports as its frequency is swept', xFmt: (v) => num(v, 0), yFmt: (v) => num(v, 0) });
  const chips = mkChips(4);
  const paint = () => {
    const x = tone(N, tone_ / DTMF_FS), c = goertzelCoef(target / DTMF_FS), r = goertzelRun(x, c), p = goertzelPower(r.s1, r.s2, c), ref = (N / 2) ** 2;
    const top = N / (2 * Math.max(0.05, Math.abs(Math.sin((2 * Math.PI * target) / DTMF_FS))));
    states.setX(256); states.setY(-1, 1);
    states.clear();
    line(states, range(N), r.states.map((v) => v / top), 'real');
    chips.set(0, `${num(dbOf(Math.sqrt(p / ref)), 1)} dB`, `power at ${hz(target)}, against a tone landing exactly on it`);
    chips.set(1, `${num(p / dftPowerAt(x, target / DTMF_FS), 9)}`, 'divided by the direct sum of N complex products: the same number');
    chips.set(2, `${N} against 3`, 'multiplications in the loop, and for the power at the end once factored as s1² + s2 (s2 − c s1); four as written');
    const n2 = 2 ** Math.ceil(Math.log2(N));
    chips.set(3, `${fftRealMults(n2)}`, `real multiplications for every bin of a ${n2}-point FFT: cheaper than Goertzel from ${num(binsBreakEven(n2), 0)} bins`);
    sweep.clear();
    const fs_ = range(1025).map((i) => (i / 1024) * (DTMF_FS / 2));
    line(sweep, fs_, fs_.map((f) => { const cc = goertzelCoef(f / DTMF_FS), g = goertzelRun(x, cc); return Math.max(-80, dbOf(Math.sqrt(goertzelPower(g.s1, g.s2, cc) / ref), -80)); }), 'real');
    range(Math.floor(N / 2) + 1).forEach((k) => { const f = (k * DTMF_FS) / N, cc = goertzelCoef(f / DTMF_FS), g = goertzelRun(x, cc); sweep.layer.append(s('circle', { cx: sweep.X(f), cy: sweep.Y(Math.max(-80, dbOf(Math.sqrt(goertzelPower(g.s1, g.s2, cc) / ref), -80))), r: 2.4, class: 'sg-pt' })); });
    sweep.layer.append(s('line', { x1: sweep.X(target), x2: sweep.X(target), y1: sweep.Y(-80), y2: sweep.Y(6), class: 'ln-h th' }));
  };
  paint();
  return {
    el: h('div', { class: 'widget mos sr-w' },
      h('div', { class: 'panel' }, h('h3', null, 'The loop s[n] = x[n] + c s[n−1] − s[n−2]'), h('div', { class: 'ln-key' }, h('span', { class: 'fr-k' }, 'state, scaled: 1 is the most a matching tone reaches')), states.el),
      h('div', { class: 'panel' }, h('h3', null, 'Power against the frequency Goertzel is set to'), h('div', { class: 'ln-key' }, h('span', { class: 'k-far' }, 'any frequency'), h('span', { class: 'k-near' }, '● the bins an FFT of this length has'), h('span', { class: 'fr-k' }, '| set to'), h('span', { class: 'fr-k' }, 'dB, 0 = a tone landing exactly on the setting')), sweep.el, chips.el),
      h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row' },
        slider('Tone', 300, 3500, 1, tone_, (v) => hz(v), (v) => { tone_ = v; paint(); }).el,
        slider('Goertzel set to', 300, 3500, 1, target, (v) => hz(v), (v) => { target = v; paint(); }).el,
        slider('Block', 64, 256, 1, N, (v) => String(v), (v) => { N = v; paint(); }).el))),
  };
}

// ---- the keypad in gates ---------------------------------------------------------------------------------------------------------------------

export const DTMF_N = 205;
export const NOISES = [{ name: 'No noise', amp: 0 }, { name: 'Noise ±60', amp: 60 }, { name: 'Noise ±200 (clipped to a byte)', amp: 200 }];
export const dtmfCoefs = (): number[] => dtmfFreqs().map((f) => coefWord(f / DTMF_FS));

/** Drive the cell through a key's block, once for each of the eight tones (a clear, then the samples), checking the state words against the model at every clock. */
export function runKey(sim: { setInput(n: string, v: number): void; settle(): unknown }, value: (port: string) => number, key: string, noise: number): { ok: boolean; clocks: number; power: number[] } {
  const x = dtmfBlock(key, DTMF_N, { noise, seed: PANEL_SEED }), Cs = dtmfCoefs(), power: number[] = [];
  let ok = true, clocks = 0;
  const edge = () => { sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.settle(); clocks++; };
  Cs.forEach((C, t) => {
    sim.setInput('c', wordOf(C, 16)); sim.setInput('clr', 1); sim.setInput('x', 0); sim.settle(); edge();
    sim.setInput('clr', 0);
    let s1 = 0, s2 = 0;
    for (let i = 0; i < x.length; i++) {
      sim.setInput('x', wordOf(x[i], 8)); sim.settle(); edge();
      const m = goertzelFx(x.slice(0, i + 1), C, GZ_STATE);
      s1 = signedOf(value('s1'), GZ_STATE); s2 = signedOf(value('s2'), GZ_STATE);
      if (s1 !== m.s1 || s2 !== m.s2) ok = false;
    }
    power[t] = goertzelPower(s1, s2, C / 2 ** 14);
  });
  return { ok, clocks, power };
}

const dtmfPanel: ScenePanel = (stage: Stage): Widget => {
  let key = '5', noise = 0, ok = true, ran = false, clocks = 0, pw: number[] = [], read = dtmfDecode(new Array<number>(8).fill(0), DTMF_N);
  const bars = h('div', { class: 'dsp-bars' }), status = h('div', { class: 'mc-status' }), note = h('p', { class: 'sub' });
  const fr = dtmfFreqs();
  const paint = () => {
    const top = Math.max(1, ...pw);
    bars.replaceChildren(...fr.map((f, i) => h('div', { class: `dsp-bar${ran && (i === read.row || i === 4 + read.col) ? ' on' : ''}` },
      h('i', { style: `height:${ran ? Math.max(1, (pw[i] / top) * 100).toFixed(1) : 0}%` }), h('b', null, `${f}`), h('span', null, ran ? num(dbOf(Math.sqrt(pw[i] / ((DTMF_N / 2) ** 2)), -90), 1) : ''))));
    status.replaceChildren(h('span', null, 'key pressed ', h('b', null, key)), h('span', null, 'read back ', h('b', null, ran ? (read.key ?? 'none') : '—')), h('span', null, 'clocks ', h('b', null, String(clocks))));
    note.textContent = !ran ? 'Pick a key: its block goes through the one cell eight times, once for each tone, and the model runs beside the gates.'
      : `${ok ? 'Every state word of the gates matched the model at every clock.' : 'The gates and the model disagreed.'} Read as: ${read.why}.`;
  };
  const run = () => {
    stage.checkpoint();
    const r = runKey(stage.sim!, (p) => stage.value(p), key, noise);
    ok = r.ok; clocks = r.clocks; pw = r.power;
    read = dtmfDecode(pw, DTMF_N); ran = true;
    stage.refresh(); paint();
  };
  const keys = h('div', { class: 'dsp-keys' }, ...DTMF_KEYS.flatMap((rw) => [...rw].map((k) => h('button', { type: 'button', class: 'btn sm', 'aria-label': `Key ${k}`, onclick: () => { key = k; run(); } }, k))));
  const sel = h('select', { 'aria-label': 'Noise' }, ...NOISES.map((n, i) => h('option', { value: String(i) }, n.name))) as HTMLSelectElement;
  sel.addEventListener('change', () => { noise = NOISES[Number(sel.value)].amp; if (ran) run(); });
  const clip = clipButton('Play this key', () => ({ samples: dtmfClip(key, 1600, 0), rate: DTMF_FS, source: 'model', note: `${DTMF_ROWS[keyAt(key).row]} Hz and ${DTMF_COLS[keyAt(key).col]} Hz` }));
  const el = h('div', { class: 'mem-panel cpu-panel mc-panel clk-panel mdm-panel', 'data-dock': 'right', 'data-phone': 'flow' }, h('h4', null, 'A keypad through the gates'),
    keys, h('label', { class: 'mos-sl ln-sel' }, h('span', null, 'Noise'), sel), h('div', { class: 'ln-key' }, h('span', { class: 'k-far' }, 'power at each tone, Hz; under it dB against a tone of 1')), bars, status, note, clip.el);
  stage.resetHooks.add(() => { ran = false; clocks = 0; pw = []; paint(); });
  paint();
  return { el, update: () => {} };
};

export function dtmfScene(): Scene {
  return { root: goertzelCell(), inputs: { x: 0, c: 0, clr: 1, clk: 0 }, clock: 'clk', autoClock: false, powerOn: 'zero', panels: [dtmfPanel] };
}
export type { Plot };

/** The eight tones' power after a block, from the integer recursion the gates follow. */
export const dtmfPowers = (x: number[]): number[] => dtmfCoefs().map((C) => { const g = goertzelFx(x, C, GZ_STATE); return goertzelPower(g.s1, g.s2, C / 2 ** 14); });
export const PANEL_SEED = 5;
/** The keys the decoder misreads at this noise, with the panel's seed. */
export const misreads = (noise: number): string[] => [...DTMF_KEYS.join('')].filter((k) => dtmfDecode(dtmfPowers(dtmfBlock(k, DTMF_N, { noise, seed: PANEL_SEED })), DTMF_N).key !== k);
