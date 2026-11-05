// "A software radio"'s explorers: the band as the ADC saw it, an FM station's width against Carson's rule, a tuner that moves a station to zero, the mixer and the front end in gates, how fine the oscillator's
// table has to be, the channel filter and the discriminator, the audio filter and de-emphasis, and the receiver with a dial. Every number is dsp/sdr.ts's or the gates'; the filters after the CIC are floating
// point (the DSP core's job) and every panel that shows them says so.

import { signedOf, wordOf } from '../comm/signals';
import type { Clip } from '../dsp/clip';
import {
  ADC_SCALE, ALPHA, AUD, AUDIO, AUDIO_R, AUDIO_TAPS, bandSpectrum, CHAN, CHAN_EDGE, CHAN_TAPS, carrierToNoise, stationBand, carson, CIC_GAIN, CIC_R, FrontModel, FS, FS_CIC, keyingRatio, mixBlock, MixModel,
  mixerSfdr, modIndex, NCO_K, occupied, receive, sample, STATIONS, stationAt, synthBand, TAU, toneFm, toneSnr, tuningWord, W_CIC, W_IN, W_MIX, wordHz, workPerSecond, type Band,
} from '../dsp/sdr';
import { CLIP_CLOCKS, gateClip, modelClip } from '../dsp/sdrclip';
import { fft } from '../comm/fourier';
import { complexMixer, sdrFront, sdrNco } from '../lib/sdr';
import { stats } from '../sim/stats';
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
const khz = (hz: number) => `${hz >= 0 ? '+' : '−'}${Math.abs(hz / 1000)} kHz`;
const sp = (x: number) => Math.round(x).toLocaleString('en').replace(/,/g, ' ');
const z0 = (v: number) => (Math.abs(v) < 0.05 ? 0 : v);
const dbOf = (x: number) => 20 * Math.log10(Math.max(x, 1e-9));
let theBand: Band | undefined;
/** One second of the band, made on first use and kept: every explorer reads the same samples. */
export const band = (): Band => (theBand ??= synthBand(FS));

/** A phone gets plots drawn smaller, so their text is not scaled down to nothing. */
const NARROW = typeof matchMedia === 'function' && matchMedia('(max-width: 720px)').matches;
const PW = NARROW ? 420 : 640;
const SPEC_FLOOR = -70, SPEC_TOP = 18;
/** A spectrum from −FS/2 to +FS/2 (or the part of it asked for) as a line, on a plot whose x is kHz. */
function drawSpectrum(p: Plot, db: ArrayLike<number>, span: number, cls = 'real'): void {
  const M = db.length, xs: number[] = [], ys: number[] = [];
  for (let i = 0; i < M; i += 2) {
    const f = ((i / M - 0.5) * span) / 1000;
    xs.push(f); ys.push(Math.max(SPEC_FLOOR, Math.max(db[i], db[Math.min(M - 1, i + 1)])));
  }
  line(p, xs, ys, cls);
}
const specPlot = (aria: string, W = PW, H = NARROW ? 190 : 170, half = 480) => plotOf({ W, H, x: [-half, half], y: [SPEC_FLOOR, SPEC_TOP], yTicks: [0, -20, -40, -60], xLabel: 'kHz from the band\'s centre · dB from the peak', yLabel: '', aria, xFmt: (v) => String(v) });
const band2 = (p: Plot, f0: number, f1: number, cls = 'sdr-chan') => p.layer.append(s('rect', { x: p.X(f0), y: p.Y(SPEC_TOP), width: Math.max(1, p.X(f1) - p.X(f0)), height: p.Y(SPEC_FLOOR) - p.Y(SPEC_TOP), class: cls }));
const mark = (p: Plot, fk: number, cls = 'ln-s lump') => p.layer.append(s('line', { x1: p.X(fk), x2: p.X(fk), y1: p.Y(SPEC_TOP), y2: p.Y(SPEC_FLOOR), class: cls }));
const label = (p: Plot, fk: number, y: number, text: string) => p.layer.append(s('text', { x: p.X(fk), y, 'text-anchor': 'middle', class: 'tick' }, text));

// ---- what is in the air ------------------------------------------------------------------------------------------------------------------------

export function bandWidget(): Widget {
  let noise = -40;
  const plot = specPlot('The spectrum of the band as the ADC saw it: four stations as raised humps on a noise floor'), chips = mkChips(4);
  const paint = () => {
    const b = band(), smp = sample(b, noise, 0, 1 << 16), sp2 = bandSpectrum(smp.xr, smp.xi);
    plot.clear();
    drawSpectrum(plot, sp2, FS);
    STATIONS.forEach((st) => { band2(plot, (st.f - stationBand(st) / 2) / 1000, (st.f + stationBand(st) / 2) / 1000, 'sdr-occ'); label(plot, st.f / 1000, plot.Y(9), st.short); });
    chips.set(0, `${sp(FS)} /s`, 'complex samples a second, I and Q');
    chips.set(1, `${W_IN} bits`, `each of I and Q; ±${2 ** (W_IN - 1)} steps`);
    chips.set(2, `${num(20 * Math.log10(STATIONS[0].a / STATIONS[3].a), 0)} dB`, 'loudest station over the weakest');
    chips.set(3, String(smp.clipped), noise > -20 ? 'samples at full scale: the ADC clips' : 'samples at full scale');
  };
  const sn = slider('Noise', -60, 0, 1, noise, (v) => `${v} dB`, (v) => { noise = v; paint(); });
  const table = h('table', { class: 'dsp-table' }, h('thead', null, h('tr', null, h('th', null, 'Station'), h('th', { class: 'num' }, 'Centre'), h('th', { class: 'num' }, 'Amplitude'), h('th', { class: 'num' }, 'Carson band'))),
    ...STATIONS.map((st) => h('tr', null, h('td', null, st.name), h('td', { class: 'num' }, khz(st.f)), h('td', { class: 'num' }, String(st.a)), h('td', { class: 'num' }, `${num(stationBand(st) / 1000, 0)} kHz`))));
  paint();
  return { el: h('div', { class: 'widget mos sr-w sdr-w' }, h('div', { class: 'panel' }, h('h3', null, 'One second of the band, as the ADC saw it'), plot.el, h('div', { class: 'ln-key' }, h('span', { class: 'k-far' }, 'power spectrum'), h('span', { class: 'k-near' }, 'shaded: the band each station occupies, by Carson\'s rule')), chips.el), h('div', { class: 'panel' }, table), h('div', { class: 'panel mos-ctl' }, sn.el)) };
}

// ---- how wide a station is -----------------------------------------------------------------------------------------------------------------------

export function carsonWidget(): Widget {
  let dev = 50_000, fm = 5_000;
  const plot = plotOf({ W: PW, H: 190, x: [-250, 250], y: [-80, 3], yTicks: [0, -20, -40, -60], xLabel: 'kHz from the carrier · dB from the peak', yLabel: '', aria: 'The spectrum of one FM station modulated by a tone, with Carson\'s band and the measured band marked', xFmt: (v) => String(v) });
  const chips = mkChips(4);
  const paint = () => {
    const x = toneFm(dev, fm), N = x.re.length, X = fft({ re: x.re, im: x.im }), p = new Float64Array(N);
    let peak = 0;
    for (let k = 0; k < N; k++) { p[k] = X.re[k] ** 2 + X.im[k] ** 2; peak = Math.max(peak, p[k]); }
    plot.clear();
    const car = carson(dev, fm), got = occupied(x, 0.98), all = occupied(x, 0.999);
    band2(plot, -car / 2000, car / 2000, 'sdr-occ');
    const xs: number[] = [], ys: number[] = [], step = 8;
    for (let k = -250_000 / (FS / N); k <= 250_000 / (FS / N); k += step) {
      let m = 0;
      for (let j = 0; j < step; j++) m = Math.max(m, p[(Math.round(k) + j + N) % N]);
      xs.push((k * FS) / N / 1000); ys.push(Math.max(-80, 10 * Math.log10(Math.max(m, 1e-30) / peak)));
    }
    line(plot, xs, ys, 'real');
    mark(plot, -got / 2000, 'ln-s near'); mark(plot, got / 2000, 'ln-s near');
    chips.set(0, num(modIndex(dev, fm), 1), 'modulation index, deviation / highest audio frequency');
    chips.set(1, `${num(car / 1000, 1)} kHz`, 'Carson: 2 (deviation + audio)');
    chips.set(2, `${num(got / 1000, 1)} kHz`, 'measured, the band holding 98 % of the power');
    chips.set(3, `${num(all / 1000, 0)} kHz`, 'measured, holding 99.9 %');
  };
  const sd = slider('Deviation', 5_000, 75_000, 5_000, dev, (v) => `${v / 1000} kHz`, (v) => { dev = v; paint(); });
  const sf = slider('Audio tone', 1_000, 15_000, 1_000, fm, (v) => `${v / 1000} kHz`, (v) => { fm = v; paint(); });
  paint();
  return { el: h('div', { class: 'widget mos sr-w sdr-w' }, h('div', { class: 'panel' }, h('h3', null, 'One station, modulated by a single tone'), plot.el, h('div', { class: 'ln-key' }, h('span', { class: 'k-far' }, 'spectrum'), h('span', { class: 'fr-k' }, 'shaded: Carson\'s band · dashed: measured 98 %')), chips.el), h('div', { class: 'panel mos-ctl' }, sd.el, sf.el)) };
}

// ---- moving a station to zero --------------------------------------------------------------------------------------------------------------------

export function tuneWidget(): Widget {
  let f = -300_000;
  const before = specPlot('The band before the mixer, the tuning marked'), after = specPlot('The band after the mixer: the tuned station sits at zero');
  const chips = mkChips(3);
  const paint = () => {
    const b = band(), smp = sample(b, -40, 0, 1 << 16), ftw = tuningWord(f), { mr, mi } = mixBlock(smp.xr, smp.xi, ftw);
    before.clear(); drawSpectrum(before, bandSpectrum(smp.xr, smp.xi), FS); mark(before, f / 1000, 'ln-s near');
    after.clear(); band2(after, -CHAN_EDGE / 1000, CHAN_EDGE / 1000); drawSpectrum(after, bandSpectrum(mr, mi), FS); mark(after, 0, 'ln-s near');
    chips.set(0, String(ftw), `tuning word, of ${sp(2 ** 16)}`);
    chips.set(1, `${num(wordHz(ftw) / 1000, 3)} kHz`, `what the register turns at, one step is ${num(FS / 2 ** 16, 1)} Hz`);
    const st = stationAt(f);
    chips.set(2, st ? st.short : 'none', st ? 'a station is inside the channel' : 'nothing within 25 kHz');
  };
  const sf = slider('Tune', -440, 440, 5, f / 1000, (v) => `${v > 0 ? '+' : ''}${v} kHz`, (v) => { f = v * 1000; paint(); });
  paint();
  return { el: h('div', { class: 'widget mos sr-w sdr-w' }, h('div', { class: 'panel' }, h('h3', null, 'Before the mixer'), before.el), h('div', { class: 'panel' }, h('h3', null, 'After it: the station you chose is at zero'), after.el, h('div', { class: 'ln-key' }, h('span', { class: 'fr-k' }, 'shaded: the channel the next filter keeps, ± 75 kHz')), chips.el), h('div', { class: 'panel mos-ctl' }, sf.el)) };
}

// ---- the gates, with a panel ---------------------------------------------------------------------------------------------------------------------

export interface SdrApi { agrees: () => boolean; tuned: () => number; ran: () => boolean; run: (f: number) => void }
export const sdrApi = new WeakMap<Stage, SdrApi>();
const pulse = (st: Stage) => { st.sim!.setInput('clk', 1); st.sim!.settle(); st.sim!.setInput('clk', 0); st.sim!.settle(); };
const STATION_BUTTONS: [string, number][] = STATIONS.map((st) => [`${st.short} · ${khz(st.f)}`, st.f]);

/** Runs a station through the gates beside the model, every clock, and plots what leaves. */
function gatePanel(o: { title: string; clocks: number; intro: string; front: boolean }): ScenePanel {
  return (stage: Stage): Widget => {
    let f = STATIONS[0].f, ok = true, ran = false, outs = 0;
    let ia: number[] = [], qa: number[] = [];
    const plot = o.front
      ? plotOf({ W: 300, H: 280, x: [-1.2, 1.2], y: [-1.2, 1.2], yTicks: [-1, 0, 1], xLabel: 'I', yLabel: 'Q', aria: 'The words leaving the CIC, Q against I, scaled to the largest: a tuned FM station stays on a circle', xFmt: (v) => num(v, 1) })
      : plotOf({ W: 380, H: 190, x: [0, o.clocks], y: [-1.2, 1.2], yTicks: [-1, 0, 1], xLabel: 'clock', yLabel: '', aria: 'The mixer\'s I and Q outputs, as a share of the ADC\'s full scale' });
    const read = h('div', { class: 'mc-status' }), note = h('p', { class: 'sub' });
    const paint = () => {
      plot.clear();
      if (ia.length) {
        if (o.front) line(plot, ia, qa, 'ln-s real');
        else { line(plot, ia.map((_, i) => i), ia, 'ln-s real'); line(plot, qa.map((_, i) => i), qa, 'ln-s near'); }
      }
      read.replaceChildren(h('span', null, 'tuned to ', h('b', null, khz(f))), h('span', null, o.front ? 'outputs ' : 'clocks ', h('b', null, String(o.front ? outs : ia.length))));
      note.textContent = ran ? (ok ? 'Every output of the gates matched the model at every clock.' : 'The gates and the model disagreed.') : o.intro;
    };
    const run = (fr: number) => {
      stage.checkpoint();
      f = fr; ok = true; ran = true; ia = []; qa = []; outs = 0;
      const b = band(), { xr, xi } = sample(b, -40, 0, o.clocks), sim = stage.sim!, ftw = tuningWord(f);
      const mix = new MixModel(ftw), front = new FrontModel(ftw);
      sim.reset('zero');
      sim.setInput('clk', 0); sim.setInput('ftw', ftw); sim.settle();
      const unit = o.front ? CIC_GAIN * ADC_SCALE : ADC_SCALE;
      for (let i = 0; i < o.clocks; i++) {
        sim.setInput('xr', wordOf(xr[i], W_IN)); sim.setInput('xi', wordOf(xi[i], W_IN)); sim.settle();
        if (!o.front) {
          const m = mix.edge(xr[i], xi[i]), yr = signedOf(stage.value('yr'), W_MIX), yi = signedOf(stage.value('yi'), W_MIX);
          if (yr !== m.yr || yi !== m.yi) ok = false;
          ia.push(yr / unit); qa.push(yi / unit);
          pulse(stage);
        } else {
          pulse(stage);
          front.edge(xr[i], xi[i]);
          const yr = signedOf(stage.value('yr'), W_CIC), yi = signedOf(stage.value('yi'), W_CIC), v = stage.value('valid');
          if (yr !== front.yr || yi !== front.yi || v !== (front.valid ? 1 : 0)) ok = false;
          if (front.valid) { outs++; ia.push(yr / unit); qa.push(yi / unit); }
        }
      }
      if (o.front && ia.length) { const m = Math.max(1e-9, ...ia.map((v, i) => Math.hypot(v, qa[i]))); ia = ia.map((v) => v / m); qa = qa.map((v) => v / m); }
      stage.refresh();
      paint();
    };
    sdrApi.set(stage, { agrees: () => ok && ran, tuned: () => (ran ? f : NaN), ran: () => ran, run });
    const el = h('div', { class: 'mem-panel cpu-panel mc-panel clk-panel mdm-panel', 'data-dock': 'right', 'data-phone': 'flow' }, h('h4', null, o.title),
      h('div', { class: 'dram-ops' }, ...STATION_BUTTONS.map(([l, fr]) => h('button', { type: 'button', class: 'btn sm', onclick: () => run(fr) }, l))), plot.el, read, note);
    stage.resetHooks.add(() => { ia = []; qa = []; ran = false; outs = 0; paint(); });
    paint();
    return { el, update: () => {} };
  };
}

export const MIXER_CLOCKS = 240;
export const FRONT_CLOCKS = 800;
export function mixerScene(): Scene {
  return { root: complexMixer(), inputs: { xr: 0, xi: 0, ftw: 0, clk: 0 }, clock: 'clk', autoClock: false, powerOn: 'zero', engine: 'cycle', hiddenInputs: ['xr', 'xi', 'ftw'], panels: [gatePanel({ title: 'Four stations through the mixer', clocks: MIXER_CLOCKS, front: false, intro: `Pick a station. The ADC's samples go in at every clock, ${MIXER_CLOCKS} of them. The tuned station now turns slowly, within its own deviation; the others spin across it at their distance.` })] };
}
export function frontScene(): Scene {
  return { root: sdrFront(), inputs: { xr: 0, xi: 0, ftw: 0, clk: 0 }, clock: 'clk', autoClock: false, powerOn: 'zero', engine: 'cycle', hiddenInputs: ['xr', 'xi', 'ftw'], panels: [gatePanel({ title: 'A station through the front end', clocks: FRONT_CLOCKS, front: true, intro: `Pick a station. ${FRONT_CLOCKS} clocks go in and ${FRONT_CLOCKS / CIC_R} words of I and Q come out, each drawn as a point in the plane and joined to the last.` })] };
}
export const nandsOf = () => ({ mixer: stats(complexMixer()).nands, nco: stats(sdrNco()).nands, front: stats(sdrFront()).nands });

// ---- how fine a table ------------------------------------------------------------------------------------------------------------------------------

export const TABLE_KS = [3, 4, 5, 6, 7, 8, 9] as const;
export interface TableRow { k: number; nands: number; sfdr: number; keying: number }
let tableRows: TableRow[] | undefined;
/** Each table size's cost in gates (the NCO alone) and the two things it buys. The weak station is received from the same second of band as everywhere else. */
export function tableSweep(): TableRow[] {
  return (tableRows ??= TABLE_KS.map((k) => ({ k, nands: stats(sdrNco(k)).nands, sfdr: mixerSfdr(k), keying: keyingRatio(receive(band(), STATIONS[3].f, -40, FS, k).chain.audio) })));
}
export function tableWidget(): Widget {
  let k = NCO_K;
  const rows = tableSweep(), chips = mkChips(4);
  const body = h('tbody');
  const paint = () => {
    const r = rows.find((q) => q.k === k)!;
    body.replaceChildren(...rows.map((q) => h('tr', { class: q.k === k ? 'sel' : '' }, h('td', { class: 'num' }, `${q.k}`), h('td', { class: 'num' }, sp(2 ** q.k)), h('td', { class: 'num' }, sp(q.nands)), h('td', { class: 'num' }, `${num(q.sfdr, 1)} dB`), h('td', { class: 'num' }, `${num(z0(q.keying), 1)} dB`))));
    chips.set(0, sp(2 ** k), 'steps in a turn');
    chips.set(1, sp(r.nands), 'NANDs in the oscillator');
    chips.set(2, `${num(r.sfdr, 0)} dB`, 'the largest spur under the carrier');
    chips.set(3, `${num(z0(r.keying), 0)} dB`, 'weak station: key down over key up');
  };
  const sk = slider('Table bits', 3, 9, 1, k, (v) => String(v), (v) => { k = v; paint(); play.reset(); });
  const play = clipButton('Hear the weak station', () => ({ samples: receive(band(), STATIONS[3].f, -40, FS, k).chain.audio, rate: AUD, source: 'model', note: `${2 ** k}-step table, one second` } satisfies Clip));
  const table = h('table', { class: 'dsp-table' }, h('thead', null, h('tr', null, h('th', { class: 'num' }, 'Bits'), h('th', { class: 'num' }, 'Steps'), h('th', { class: 'num' }, 'NANDs, oscillator'), h('th', { class: 'num' }, 'Spur-free range'), h('th', { class: 'num' }, 'Key down / up'))), body);
  paint();
  return { el: h('div', { class: 'widget mos sr-w sdr-w' }, h('div', { class: 'panel' }, h('h3', null, 'The oscillator\'s table, bit by bit'), table, chips.el), h('div', { class: 'panel mos-ctl' }, sk.el, play.el)) };
}

// ---- the channel filter and the discriminator (the DSP core's job) ---------------------------------------------------------------------------------

export function channelWidget(): Widget {
  let k = 0;
  const f240 = (h2: ArrayLike<number>, f: number) => { let re = 0, im = 0; for (let i = 0; i < h2.length; i++) { const w = (-2 * Math.PI * f * i) / FS_CIC; re += h2[i] * Math.cos(w); im += h2[i] * Math.sin(w); } return Math.hypot(re, im); };
  const sp1 = plotOf({ W: PW, H: 170, x: [-120, 120], y: [-90, 3], yTicks: [0, -20, -40, -60, -80], xLabel: 'kHz from the tuned station · dB', yLabel: '', aria: 'The spectrum after the CIC, with the channel filter\'s response over it', xFmt: (v) => String(v) });
  const sp2 = plotOf({ W: PW, H: 150, x: [0, 5], y: [-1.5, 1.5], yTicks: [-1, 0, 1], xLabel: 'ms', yLabel: 'share of deviation', aria: 'The discriminator\'s output: how far the frequency is from the centre, as a share of the deviation' });
  const chips = mkChips(4), buttons = h('div', { class: 'dram-ops' });
  const paint = () => {
    const st = STATIONS[k], r = receive(band(), st.f, -40, 1 << 17), n = 2048, re = new Float64Array(n), im = new Float64Array(n), o = 1000;
    for (let i = 0; i < n; i++) { const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n); re[i] = r.yr[o + i] * w; im[i] = r.yi[o + i] * w; }
    const X = fft({ re, im }), pw = Array.from({ length: n }, (_, i) => X.re[i] ** 2 + X.im[i] ** 2), peak = Math.max(...pw);
    sp1.clear();
    const xs = range(n).map((i) => ((i / n - 0.5) * FS_CIC) / 1000), ys = range(n).map((i) => Math.max(-90, 10 * Math.log10(Math.max(pw[(i + n / 2) % n], 1e-30) / peak)));
    band2(sp1, -CHAN_EDGE / 1000, CHAN_EDGE / 1000);
    line(sp1, xs, ys, 'real');
    const fx = range(241).map((i) => i - 120), fy = fx.map((v) => Math.max(-90, dbOf(f240(CHAN, v * 1000))));
    line(sp1, fx, fy, 'ln-s near');
    sp2.clear();
    const m = Math.floor((5e-3 * FS_CIC)), start = 3000, d = r.chain.disc;
    line(sp2, range(m).map((i) => (i / FS_CIC) * 1000), range(m).map((i) => d[start + i]), 'real');
    chips.set(0, `${CHAN_TAPS} taps`, `${sp(workPerSecond.channel)} multiplications a second, I and Q`);
    chips.set(1, `${num(-dbOf(f240(CHAN, 100_000)), 0)} dB`, 'the channel filter\'s attenuation 100 kHz from the tuned station');
    chips.set(2, `${num(Math.max(...range(m).map((i) => Math.abs(d[start + i]))), 2)}`, 'largest discriminator output, in deviations');
    chips.set(3, `${r.clipped}`, 'ADC samples at full scale');
    picks.forEach((b, i) => b.setAttribute('aria-pressed', String(i === k)));
  };
  const picks = STATIONS.map((st, i) => h('button', { type: 'button', class: 'btn sm', onclick: () => { k = i; paint(); } }, `${st.short} · ${khz(st.f)}`));
  buttons.append(...picks);
  paint();
  return { el: h('div', { class: 'widget mos sr-w sdr-w' }, h('div', { class: 'panel' }, h('h3', null, 'After the CIC, at 240 kHz: model, floating point'), sp1.el, h('div', { class: 'ln-key' }, h('span', { class: 'k-far' }, 'the station and its neighbours'), h('span', { class: 'k-near' }, 'the channel filter\'s response')), chips.el),
    h('div', { class: 'panel' }, h('h3', null, 'The discriminator: the phase step between neighbours'), sp2.el), h('div', { class: 'panel mos-ctl sdr-pick' }, buttons)) };
}

// ---- the audio filter and de-emphasis -------------------------------------------------------------------------------------------------------------------

export function audioWidget(): Widget {
  const resp = (h2: ArrayLike<number>, f: number, fs: number) => { let re = 0, im = 0; for (let i = 0; i < h2.length; i++) { const w = (-2 * Math.PI * f * i) / fs; re += h2[i] * Math.cos(w); im += h2[i] * Math.sin(w); } return Math.hypot(re, im); };
  const sp1 = plotOf({ W: PW, H: 170, x: [0, 24], y: [-80, 3], yTicks: [0, -20, -40, -60], xLabel: 'kHz, at the CIC\'s 240 kHz rate', yLabel: 'dB', aria: 'The audio filter\'s response, and the new Nyquist at 12 kHz', xFmt: (v) => String(v) });
  const sp2 = plotOf({ W: PW, H: 150, x: [0, 12], y: [-20, 20], yTicks: [-20, -10, 0, 10, 20], xLabel: 'kHz', yLabel: 'dB', aria: 'The transmitter\'s pre-emphasis and the receiver\'s de-emphasis: mirror images', xFmt: (v) => String(v) });
  const pre = (f: number) => { const re = 1 - ALPHA * Math.cos((2 * Math.PI * f) / AUD), im = ALPHA * Math.sin((2 * Math.PI * f) / AUD); return Math.hypot(re, im) / (1 + ALPHA); };
  const chips = mkChips(4);
  sp1.clear();
  line(sp1, range(481).map((i) => i * 0.05), range(481).map((i) => Math.max(-80, dbOf(resp(AUDIO, i * 50, FS_CIC)))), 'real');
  mark(sp1, AUD / 2000, 'ln-s lump');
  sp2.clear();
  line(sp2, range(241).map((i) => i * 0.05), range(241).map((i) => dbOf(pre(i * 50))), 'ln-s near');
  line(sp2, range(241).map((i) => i * 0.05), range(241).map((i) => -dbOf(pre(i * 50))), 'real');
  chips.set(0, `${AUDIO_TAPS} taps`, `${sp(workPerSecond.audio)} multiplications a second: only every ${AUDIO_R}th output is computed`);
  chips.set(1, `${num(dbOf(resp(AUDIO, 12_000, FS_CIC)), 0)} dB`, 'at 12 kHz, where what folds onto the audio begins');
  chips.set(2, `${num(1 / (2 * Math.PI * TAU) / 1000, 2)} kHz`, `corner of a ${TAU * 1e6} µs time constant`);
  chips.set(3, `${num(dbOf(pre(10_000)) - dbOf(pre(0)), 1)} dB`, 'the transmitter lifts 10 kHz over the bass by this much; the receiver takes it back');
  const ar = receive(band(), STATIONS[1].f, -40);
  const raw = Float32Array.from({ length: ar.chain.audio.length }, () => 0);
  // without de-emphasis: the filtered discriminator itself
  { const d = ar.chain.disc; for (let i = 0; i < raw.length; i++) { let v = 0; for (let t = 0, m = Math.min(AUDIO_TAPS, i * AUDIO_R + 1); t < m; t++) v += AUDIO[t] * d[i * AUDIO_R - t]; raw[i] = v; } }
  return { el: h('div', { class: 'widget mos sr-w sdr-w' }, h('div', { class: 'panel' }, h('h3', null, 'The audio filter, ÷ 10 to 24 kHz: model, floating point'), sp1.el, chips.el),
    h('div', { class: 'panel' }, h('h3', null, 'Pre-emphasis at the transmitter and its mirror at the receiver'), sp2.el, h('div', { class: 'ln-key' }, h('span', { class: 'k-near' }, 'pre-emphasis, at the transmitter'), h('span', { class: 'k-far' }, 'de-emphasis, at the receiver'))),
    h('div', { class: 'panel mos-ctl' }, clipButton('Hear the arpeggio without de-emphasis', () => ({ samples: raw, rate: AUD, source: 'model', note: 'treble boosted, as it was sent' })).el, clipButton('Hear it with de-emphasis', () => ({ samples: ar.chain.audio, rate: AUD, source: 'model', note: 'as received' })).el)) };
}

// ---- turn the dial -------------------------------------------------------------------------------------------------------------------------------------

export const DIAL_DEFAULT = { f: -300_000, noise: -40 };
export interface DialState { f: number; noise: number }
export function dialWidget(): Widget {
  let f = DIAL_DEFAULT.f, noise = DIAL_DEFAULT.noise, timer = 0, clipTask = 0;
  const spec = specPlot('The whole band with the tuned channel marked'), wave = plotOf({ W: PW, H: 120, x: [0, 30], y: [-1.1, 1.1], yTicks: [-1, 0, 1], xLabel: 'ms of the output', yLabel: '', aria: 'Thirty milliseconds of the demodulated audio, scaled to fit', xFmt: (v) => String(v) });
  const read = h('div', { class: 'mc-status' }), working = h('p', { class: 'sub' });
  let last: Float32Array | null = null;
  const paint = () => {
    const b = band(), r = receive(b, f, noise), smp = sample(b, noise, 0, 1 << 16), a = r.chain.audio;
    last = a;
    spec.clear();
    band2(spec, (f - CHAN_EDGE) / 1000, (f + CHAN_EDGE) / 1000);
    drawSpectrum(spec, bandSpectrum(smp.xr, smp.xi), FS);
    mark(spec, f / 1000, 'ln-s near');
    wave.clear();
    const w0 = Math.floor(a.length / 2), n = 720;
    let mx = 1e-6;
    for (let i = 0; i < n; i++) mx = Math.max(mx, Math.abs(a[w0 + i]));
    line(wave, range(n).map((i) => (i / AUD) * 1000), range(n).map((i) => a[w0 + i] / mx), 'real');
    const st = stationAt(f), bw = st ? stationBand(st) : 0;
    const bits: (Node | string)[] = [];
    const tag = (label: string, value: string, cls = '') => h('span', null, `${label} `, h('b', { class: cls }, value));
    bits.push(tag('Tuned to', st ? st.name : 'nothing that was put there'));
    if (st) bits.push(tag('Carrier to noise in the channel', `${num(carrierToNoise(st.a, noise, bw), 1)} dB`));
    if (st === STATIONS[0]) { const snr = toneSnr(a); bits.push(tag('Tone against everything else', `${num(snr, 1)} dB`, snr < 15 ? 'fail' : '')); }
    if (r.clipped) bits.push(tag('ADC samples clipped', sp(r.clipped), 'fail'));
    bits.push(tag('Band to audio', `${sp(FS)} → ${sp(AUD)} /s`));
    read.replaceChildren(...bits);
    working.textContent = '';
  };
  const queue = () => { working.textContent = 'Working…'; window.clearTimeout(timer); timer = window.setTimeout(paint, 120); };
  const sf = slider('Tune', -440, 440, 5, f / 1000, (v) => `${v > 0 ? '+' : ''}${v} kHz`, (v) => { f = v * 1000; playModel.reset(); playGates.reset(); queue(); });
  const sn = slider('Noise', -60, 0, 1, noise, (v) => `${v} dB`, (v) => { noise = v; playModel.reset(); playGates.reset(); queue(); });
  const playModel = clipButton('Play one second (model)', () => (last ? { samples: last, rate: AUD, source: 'model', note: 'a second of the band, the whole chain in the model' } : null));
  // the gates take seconds: a click starts them, the button shows how far they are, and the sound plays when they are done
  const gateBtn = h('button', { type: 'button', class: 'btn sm' }, `Render ${num((CLIP_CLOCKS / FS) * 1000, 0)} ms with the gates`) as HTMLButtonElement, gateSay = h('span', { class: 'sub clip-what' });
  const playGates = (() => {
    let ready: Clip | null = null;
    const play = clipButton('Play it', () => ready, 'Render it first');
    return { el: play.el, reset: () => { ready = null; gateSay.textContent = ''; play.button.disabled = true; play.reset(); }, set: (c: Clip) => { ready = c; play.button.disabled = false; }, button: play.button };
  })();
  playGates.button.disabled = true;
  gateBtn.addEventListener('click', async () => {
    const my = ++clipTask;
    gateBtn.disabled = true;
    try {
      const run = await gateClip(band(), f, noise, { progress: (p) => { if (my === clipTask) gateSay.textContent = `rendering… ${Math.round(p * 100)} %`; }, pause: () => new Promise((res) => setTimeout(res, 0)) });
      if (my !== clipTask) return;
      const m = modelClip(band(), f, noise), same = run.clip.samples.length === m.samples.length && Array.from(run.clip.samples).every((v, i) => v === m.samples[i]);
      gateSay.textContent = same ? 'the gates and the model agree on every sample of this clip' : 'the gates and the model DISAGREE';
      playGates.set(run.clip);
    } finally { gateBtn.disabled = false; }
  });
  paint();
  return { el: h('div', { class: 'widget mos sr-w sdr-w' }, h('div', { class: 'panel' }, h('h3', null, 'The band, and the channel you tuned'), spec.el, wave.el, read, working),
    h('div', { class: 'panel mos-ctl' }, sf.el, sn.el, playModel.el), h('div', { class: 'panel mos-ctl' }, gateBtn, playGates.el, gateSay)) };
}

