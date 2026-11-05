// "Music"'s explorers: the nocturne and its spectrum, the MDCT's overlapping frames and how they cancel, a frame's bands against the (simplified) mask, where the bits go, and the
// codec heard at three rates both ways. The recording is a CC0 Musopen one (widgets/dspaudio.ts); every number is dsp/music.ts's. The codec is ours, and no format.

import { prepareClip, type Clip } from '../dsp/clip';
import { audibleShare, bandPowersDb, bands, encodeMusic, imdct, maskDb, mdct, MDCT_M, mdctFrames, meanNmrDb, quietDb, MASK, sineWindow } from '../dsp/music';
import { snrDb } from '../dsp/speech';
import { h } from '../ui/dom';
import type { Widget } from '../view/stage';
import { clipButton } from './clip';
import { CLIPS, loadClip, type Recording } from './dspaudio';
import { line, mkChips, num, plotOf } from './line';
import { slider } from './mosparts';
import '../styles/line.css';
import '../styles/signals.css';
import '../styles/fourier.css';
import '../styles/speech.css';

const minus = (t: string) => t.replace(/-/g, '−');
const dbs = (x: number, d = 1) => `${minus(x.toFixed(d))} dB`;
const range = (n: number) => Array.from({ length: n }, (_, i) => i);
const credit = () => h('p', { class: 'sub' }, `Music: ${CLIPS.nocturne.credit}.`);
const clip = (x: readonly number[], rate: number, note: string): Clip => ({ samples: prepareClip(x), rate, source: 'model', note });
const kbps = (k: number) => Math.round((k * 1000 * MDCT_M) / 16000);

function withMusic(title: string, build: (v: Recording, x: number[], panel: HTMLElement, ctl: HTMLElement) => void): Widget {
  const panel = h('div', { class: 'panel' }, h('h3', null, title), h('p', { class: 'sub' }, 'Loading the recording…')), ctl = h('div', { class: 'panel mos-ctl' });
  loadClip('nocturne').then((v) => { panel.lastElementChild!.remove(); build(v, v.x.map((t) => t / 32768), panel, ctl); panel.append(credit()); }).catch((e: Error) => { panel.lastElementChild!.textContent = `The recording would not load: ${e.message}`; });
  return { el: h('div', { class: 'widget mos sr-w' }, panel, ctl) };
}

// ---- the recording ------------------------------------------------------------------------------------------------------------------------------

export function musicWidget(): Widget {
  return withMusic('Ten seconds of a piano', (v, x, panel, ctl) => {
    const frames = mdctFrames(x), spec = plotOf({ W: 640, H: 190, x: [0, v.rate / 2], y: [-110, 0], yTicks: [-100, -80, -60, -40, -20, 0], xLabel: 'Hz', yLabel: 'dB of full scale', aria: 'The nocturne\'s average MDCT spectrum' });
    const avg = range(MDCT_M).map((k) => { let s = 0; for (const f of frames) s += f[k] ** 2; return 10 * Math.log10(s / frames.length / ((MDCT_M * MDCT_M) / 4) + 1e-14); });
    line(spec, range(MDCT_M).map((k) => ((k + 0.5) * v.rate) / (2 * MDCT_M)), avg.map((d) => Math.max(-110, d)), 'ln-s real');
    const chips = mkChips(3);
    chips.set(0, `${v.rate} a second`, 'samples, mono: up to 8 kHz, enough to hear what is thrown away');
    chips.set(1, `${num((v.rate * 16) / 1000, 0)} kb/s`, 'at 16 bits, the codec\'s starting point');
    chips.set(2, `${frames.length}`, `frames of ${MDCT_M} coefficients, one every ${num((1000 * MDCT_M) / v.rate, 0)} ms`);
    panel.append(spec.el, chips.el);
    ctl.append(clipButton('Hear it', () => clip(x, v.rate, '16-bit, 16 kHz')).el);
  });
}

// ---- the MDCT -------------------------------------------------------------------------------------------------------------------------------------

export function tdacWidget(): Widget {
  return withMusic('Two frames, each wrong, together right', (_v, x, panel, ctl) => {
    let at = 40000;
    const M = MDCT_M, plot = plotOf({ W: 640, H: 200, x: [0, 3 * M], y: [-1, 1], yTicks: [-1, 0, 1], xLabel: 'sample', yLabel: '', aria: 'Two overlapping frames back from the inverse MDCT, each with aliasing, and their sum' });
    const chips = mkChips(3), w = sineWindow(M);
    const paint = () => {
      const seg = x.slice(at, at + 3 * M), top = Math.max(1e-6, ...seg.map(Math.abs)), a = imdct(mdct(seg.slice(0, 2 * M))), b = imdct(mdct(seg.slice(M, 3 * M)));
      const sum = range(M).map((i) => a[M + i] + b[i]);
      plot.clear();
      line(plot, range(3 * M), seg.map((t) => t / top), 'ln-s lump');
      line(plot, range(2 * M), Array.from(a, (t) => t / top), 'ln-s near');
      line(plot, range(2 * M).map((i) => M + i), Array.from(b, (t) => t / top), 'ln-s drv');
      line(plot, range(M).map((i) => M + i), sum.map((t) => t / top), 'ln-s real');
      const err = Math.max(...sum.map((t, i) => Math.abs(t - seg[M + i])));
      chips.set(0, `${2 * M} → ${M}`, 'samples in, coefficients out, each frame: no more numbers than samples');
      chips.set(1, err.toExponential(1), 'largest error in the overlap once the two are added, against the original');
      chips.set(2, num(w[M / 2] ** 2 + w[M / 2 + M] ** 2, 6), 'w[n]² + w[n + M]², for any n: the window\'s condition');
    };
    ctl.append(slider('Where', 0, x.length - 3 * MDCT_M, 64, at, (t) => `${num(t / 16000, 2)} s`, (t) => { at = t; paint(); }).el);
    paint();
    panel.append(plot.el, h('div', { class: 'ln-key' }, h('span', { class: 'fr-k' }, 'the music'), h('span', { class: 'k-near' }, 'first frame back'), h('span', { class: 'k-drv' }, 'second frame back'), h('span', { class: 'k-far' }, 'their sum')), chips.el);
  });
}

// ---- the mask ----------------------------------------------------------------------------------------------------------------------------------------

export function maskWidget(): Widget {
  return withMusic('A frame, and what would hide under it', (v, x, panel, ctl) => {
    let f = 200;
    const frames = mdctFrames(x), bs = bands(v.rate), zs = bs.map((b) => b.bark);
    const plot = plotOf({ W: 640, H: 220, x: [0, 22], y: [-120, 0], yTicks: [-120, -90, -60, -30, 0], xLabel: 'Bark (critical bands)', yLabel: 'dB of full scale', aria: 'One frame\'s band levels, the mask they make, and the threshold in quiet' });
    const chips = mkChips(3);
    const paint = () => {
      const L = bandPowersDb(frames[f], bs), m = maskDb(L, bs, v.rate), q = bs.map((b) => quietDb(((b.lo + b.hi) / 2 * v.rate) / (2 * MDCT_M)) - MASK.fullScaleSpl + 10 * Math.log10(b.hi - b.lo));
      plot.clear();
      line(plot, zs, L.map((t) => Math.max(-120, t)), 'ln-s real');
      line(plot, zs, m.map((t) => Math.max(-120, t)), 'ln-s near');
      line(plot, zs, q.map((t) => Math.max(-120, Math.min(0, t))), 'ln-s lump');
      const under = L.filter((t, i) => t < m[i]).length;
      chips.set(0, `${under} of ${bs.length}`, 'bands entirely under the mask: nothing there need be sent');
      chips.set(1, `${MASK.down} and ${MASK.up} dB a Bark`, 'how fast a masker\'s reach falls below and above it, in this simplified model');
      chips.set(2, `${MASK.offset} dB`, 'how far under a masker the mask sits, in this simplified model');
    };
    ctl.append(slider('Frame', 0, frames.length - 1, 1, f, (t) => `${num((t * MDCT_M) / v.rate, 2)} s`, (t) => { f = t; paint(); }).el);
    paint();
    panel.append(plot.el, h('div', { class: 'ln-key' }, h('span', { class: 'k-far' }, 'the frame\'s bands'), h('span', { class: 'k-near' }, 'the mask (simplified)'), h('span', { class: 'fr-k' }, 'threshold in quiet')), chips.el, h('p', { class: 'sub' }, `Bark from Zwicker\'s formula and the threshold in quiet from Terhardt\'s, both from memory; full scale is taken as ${MASK.fullScaleSpl} dB SPL. A real codec\'s model is far more careful.`));
  });
}

// ---- the bits -----------------------------------------------------------------------------------------------------------------------------------------

export function codecWidget(): Widget {
  return withMusic('Where the bits go', (v, x, panel, ctl) => {
    let rate = 64, f = 200;
    const short = x, bs = bands(v.rate);
    const bars = h('div', { class: 'dsp-bars', role: 'img', 'aria-label': 'Bits per coefficient in each band, by mask and by signal' }), chips = mkChips(4);
    let res = { mask: encodeMusic(short, { fs: v.rate, bitsPerFrame: kbps(rate), by: 'mask' }), signal: encodeMusic(short, { fs: v.rate, bitsPerFrame: kbps(rate), by: 'signal' }) };
    const paint = () => {
      const a = res.mask.frames[Math.min(f, res.mask.frames.length - 1)].bits, b = res.signal.frames[Math.min(f, res.signal.frames.length - 1)].bits, top = Math.max(1, ...a, ...b);
      bars.replaceChildren(...bs.flatMap((_, i) => [h('span', { style: `height:${(100 * a[i]) / top}%`, title: `band ${i + 1}: ${a[i]} bits by mask` }), h('span', { class: 'alt', style: `height:${(100 * b[i]) / top}%`, title: `band ${i + 1}: ${b[i]} bits by signal` })]));
      chips.set(0, `${num(res.mask.bitRate / 1000, 1)} and ${num(res.signal.bitRate / 1000, 1)} kb/s`, 'spent, by mask and by signal, side information included');
      chips.set(1, `${num(100 * audibleShare(res.mask.frames), 1)} % and ${num(100 * audibleShare(res.signal.frames), 1)} %`, 'of band-frames with noise above the mask (by this model)');
      chips.set(2, `${dbs(snrDb(short, res.mask.y))} and ${dbs(snrDb(short, res.signal.y))}`, 'SNR, by mask and by signal');
      chips.set(3, `${dbs(meanNmrDb(res.mask.frames))} and ${dbs(meanNmrDb(res.signal.frames))}`, 'mean noise-to-mask ratio: below 0, unheard by the model');
    };
    const recompute = () => { res = { mask: encodeMusic(short, { fs: v.rate, bitsPerFrame: kbps(rate), by: 'mask' }), signal: encodeMusic(short, { fs: v.rate, bitsPerFrame: kbps(rate), by: 'signal' }) }; paint(); };
    ctl.append(slider('Budget', 16, 96, 16, rate, (t) => `${t} kb/s`, (t) => { rate = t; recompute(); }).el, slider('Frame', 0, res.mask.frames.length - 1, 1, f, (t) => `${num((t * MDCT_M) / v.rate, 2)} s`, (t) => { f = t; paint(); }).el,
      clipButton('Hear: bits by mask', () => clip(res.mask.y, v.rate, `ours, ${rate} kb/s budget, by mask`)).el, clipButton('Hear: bits by signal', () => clip(res.signal.y, v.rate, `ours, ${rate} kb/s budget, by signal`)).el, clipButton('Hear the original', () => clip(short, v.rate, '16-bit')).el);
    paint();
    panel.append(bars, h('div', { class: 'ln-key' }, h('span', { class: 'k-far' }, 'bits by mask'), h('span', { class: 'k-near' }, 'bits by signal')), chips.el);
  });
}
