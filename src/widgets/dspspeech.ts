// "Speech"'s explorers: the voice and its spectrum, why μ-law is logarithmic, a sample through G.711 bit by bit, μ-law in gates, ADPCM and its step size, ADPCM on the RV32,
// linear prediction's envelope, and a 2.4 kb/s vocoder, every clip side by side. The voice is a public-domain LibriVox reading (widgets/dspaudio.ts); every number is dsp/speech.ts's.

import { cx, fft } from '../comm/fourier';
import { prepareClip, type Clip } from '../dsp/clip';
import { ADPCM_ASM, adpcmOnRv, adpcmProgramLength } from '../dsp/adpcmrv';
import { adpcmDecode, adpcmEncode, autocorr, durbin, lpcEnvelopeDb, predictionGainDb, sineSnr, snrDb, ulawDecode, ulawEncode, ulawFields, uniform, VOC, VOC_BITS, vocBitRate, vocBitsPerFrame, vocode } from '../dsp/speech';
import { ulawLine } from '../lib/ulaw';
import { h } from '../ui/dom';
import type { Scene, ScenePanel, Stage, Widget } from '../view/stage';
import { clipButton } from './clip';
import { CLIPS, loadClip, type Recording } from './dspaudio';
import { line, mkChips, num, plotOf } from './line';
import { slider } from './mosparts';
import '../styles/line.css';
import '../styles/signals.css';
import '../styles/dsp.css';
import '../styles/fourier.css';
import '../styles/speech.css';

const minus = (t: string) => t.replace(/-/g, '−');
const dbs = (x: number, d = 1) => `${minus(x.toFixed(d))} dB`;
const kbs = (b: number) => `${num(b / 1000, b < 10000 ? 1 : 0)} kb/s`;
const range = (n: number) => Array.from({ length: n }, (_, i) => i);
/** The voice as 14-bit samples, which is what G.711 takes: the 16-bit recording, two bits down. */
const to14 = (x: readonly number[]) => x.map((v) => v >> 2);
const credit = () => h('p', { class: 'sub' }, `Voice: ${CLIPS.voice.credit}.`);
const clip = (x: readonly number[], rate: number, note: string): Clip => ({ samples: prepareClip(x), rate, source: 'model', note });

/** A widget that waits for the voice, says so while it does, and says what failed if it cannot load. */
function withVoice(title: string, build: (v: Recording, panel: HTMLElement, ctl: HTMLElement) => void): Widget {
  const panel = h('div', { class: 'panel' }, h('h3', null, title), h('p', { class: 'sub' }, 'Loading the recording…')), ctl = h('div', { class: 'panel mos-ctl' });
  loadClip('voice').then((v) => { panel.lastElementChild!.remove(); build(v, panel, ctl); panel.append(credit()); }).catch((e: Error) => { panel.lastElementChild!.textContent = `The recording would not load: ${e.message}`; });
  return { el: h('div', { class: 'widget mos sr-w' }, panel, ctl) };
}
/** Average power spectrum, in dB, from Hann-windowed blocks of 512: the frequencies and levels. */
function spectrum(x: readonly number[], rate: number, n = 512): { f: number[]; db: number[] } {
  const p = new Float64Array(n / 2), w = range(n).map((i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
  let blocks = 0;
  for (let at = 0; at + n <= x.length; at += n / 2, blocks++) {
    const z = fft(cx(range(n).map((i) => (x[at + i] / 32768) * w[i])));
    for (let k = 0; k < n / 2; k++) p[k] += z.re[k] ** 2 + z.im[k] ** 2;
  }
  return { f: range(n / 2).map((k) => (k * rate) / n), db: Array.from(p, (v) => 10 * Math.log10(v / Math.max(1, blocks) / (n * n / 16) + 1e-12)) };
}

// ---- the voice ------------------------------------------------------------------------------------------------------------------------------

export function voiceWidget(): Widget {
  return withVoice('Six seconds of a voice', (v, panel, ctl) => {
    const wave = plotOf({ W: 640, H: 150, x: [0, v.x.length / v.rate], y: [-1, 1], yTicks: [-1, 0, 1], xLabel: 'seconds', yLabel: '', aria: 'The voice\'s waveform, six seconds' });
    const spec = plotOf({ W: 640, H: 170, x: [0, v.rate / 2], y: [-90, 0], yTicks: [-80, -60, -40, -20, 0], xLabel: 'Hz', yLabel: 'dB', aria: 'The voice\'s average spectrum, 0 to 4 kHz' });
    const pk: number[] = [], ts: number[] = [];
    for (let i = 0; i < v.x.length; i += 40) { let m = 0; for (let j = i; j < i + 40 && j < v.x.length; j++) m = Math.max(m, Math.abs(v.x[j])); pk.push(m / 32768); ts.push(i / v.rate); }
    line(wave, ts, pk, 'ln-s real'); line(wave, ts, pk.map((p) => -p), 'ln-s real');
    const s = spectrum(v.x, v.rate);
    line(spec, s.f, s.db.map((d) => Math.max(-90, d)), 'ln-s real');
    const chips = mkChips(3);
    chips.set(0, `${v.rate} a second`, 'samples, enough for 0 to 4 kHz, the telephone\'s band');
    chips.set(1, kbs(v.rate * 16), 'as it is stored here, 16 bits a sample');
    chips.set(2, kbs(v.rate * 8), 'at 8 bits a sample, the telephone network\'s rate');
    panel.append(wave.el, spec.el, chips.el);
    ctl.append(clipButton('Hear it', () => clip(v.x, v.rate, '16-bit, 8 kHz')).el);
  });
}

// ---- why logarithms --------------------------------------------------------------------------------------------------------------------------

export function companderWidget(): Widget {
  const plot = plotOf({ W: 640, H: 220, x: [-60, 0], y: [0, 80], yTicks: [0, 20, 40, 60, 80], xLabel: 'sine peak, dB of full scale', yLabel: 'SNR, dB', aria: 'Signal to noise against level, for uniform 8 and 12 bits and for μ-law' });
  const levels = range(31).map((i) => -60 + 2 * i), peak = (db: number) => 8191 * 10 ** (db / 20);
  const mu = (x: number) => ulawDecode(ulawEncode(x)), curves: [string, (v: number) => number][] = [['8 bits, uniform', uniform(8)], ['12 bits, uniform', uniform(12)], ['8 bits, μ-law', mu]];
  const ys = curves.map(([, c]) => levels.map((l) => sineSnr(peak(l), c)));
  ys.forEach((y, i) => line(plot, levels, y.map((v) => Math.max(0, v)), i === 2 ? 'ln-s real' : i === 0 ? 'ln-s lump' : 'ln-s near'));
  const at = (i: number, db: number) => ys[i][levels.indexOf(db)];
  const chips = mkChips(3);
  chips.set(0, `${dbs(at(2, 0))} and ${dbs(at(2, -40))}`, 'μ-law at full scale, and 40 dB down: nearly the same');
  chips.set(1, `${dbs(at(0, 0))} and ${dbs(at(0, -40))}`, '8 uniform bits at the same two levels');
  chips.set(2, dbs(at(1, -40)), '12 uniform bits at −40 dB: what μ-law\'s 8 bits match for quiet speech');
  return { el: h('div', { class: 'widget mos sr-w' }, h('div', { class: 'panel' }, h('h3', null, 'Noise that scales with the signal'), plot.el, h('div', { class: 'ln-key' }, h('span', { class: 'fr-k' }, '8 bits, uniform'), h('span', { class: 'k-near' }, '12 bits, uniform'), h('span', { class: 'k-far' }, '8 bits, μ-law')), chips.el)) };
}

// ---- G.711, bit by bit -------------------------------------------------------------------------------------------------------------------------

export function ulawWidget(): Widget {
  return withVoice('One sample through G.711', (v, panel, ctl) => {
    let x = 1000;
    const bits = h('div', { class: 'dsp-bits' }), chips = mkChips(4);
    const paint = () => {
      const c = ulawEncode(x), f = ulawFields(c), y = ulawDecode(c);
      bits.replaceChildren(...range(8).map((i) => { const b = (c >> (7 - i)) & 1; return h('div', { class: `dsp-bit${b ? ' on' : ''}${i === 0 ? ' sign' : ''}` }, h('b', null, String(b)), h('span', null, i === 0 ? 'polarity' : i < 4 ? 'segment' : 'step')); }));
      chips.set(0, `${f.segment} of 8`, `segment, ${f.segment === 1 ? 'steps of 1 and 2' : `steps of ${2 ** f.segment}`}`);
      chips.set(1, String(f.step), 'step within it, of 16');
      chips.set(2, minus(String(y)), 'what the far end gets back');
      chips.set(3, minus(String(y - x)), `error, against a step of ${f.segment === 1 ? 2 : 2 ** f.segment}`);
    };
    const s14 = to14(v.x), u8 = uniform(8);
    ctl.append(slider('Sample, 14 bits', -8192, 8191, 1, x, (t) => minus(String(t)), (t) => { x = t; paint(); }).el,
      clipButton('Hear 8 uniform bits', () => clip(s14.map(u8), v.rate, '8 bits, uniform')).el, clipButton('Hear 8 μ-law bits', () => clip(s14.map((t) => ulawDecode(ulawEncode(t))), v.rate, '8 bits, μ-law (G.711)')).el);
    const sn = (f: (t: number) => number) => snrDb(s14, s14.map(f));
    const all = mkChips(2);
    all.set(0, dbs(sn((t) => ulawDecode(ulawEncode(t)))), 'μ-law on the whole voice');
    all.set(1, dbs(sn(u8)), '8 uniform bits on the same voice');
    paint();
    panel.append(bits, chips.el, all.el);
  });
}

// ---- in gates -------------------------------------------------------------------------------------------------------------------------------------

export const ulawApi = new WeakMap<Stage, { agrees: () => boolean; sent: () => number; run: () => void }>();
const ulawPanel: ScenePanel = (stage: Stage): Widget => {
  let ok = true, sent = 0, xs: number[] = [], ys: number[] = [];
  const plot = plotOf({ W: 380, H: 160, x: [0, 400], y: [-1, 1], yTicks: [-1, 0, 1], xLabel: 'sample', yLabel: '', aria: 'The voice in, and back out of the gates, 50 ms of it' });
  const read = h('div', { class: 'mc-status' }), note = h('p', { class: 'sub' });
  const paint = () => {
    plot.clear();
    if (xs.length) { line(plot, range(xs.length), xs.map((v) => v / 8192), 'ln-s lump'); line(plot, range(ys.length), ys.map((v) => v / 8192), 'ln-s real'); }
    read.replaceChildren(h('span', null, 'samples ', h('b', null, String(sent))), h('span', null, 'SNR ', h('b', null, xs.length ? dbs(snrDb(xs, ys)) : '—')));
    note.textContent = sent ? (ok ? 'Every code and every sample back matched G.711\'s model.' : 'The gates and the model disagreed.') : 'Send 400 samples of the voice through the encoder and the decoder, a sample at a time.';
  };
  const run = () => {
    stage.checkpoint();
    loadClip('voice').then((v) => {
      const sim = stage.sim!, src = to14(v.x).slice(8000, 8400);
      ok = true; sent = 0; xs = []; ys = [];
      for (const x of src) {
        sim.setInput('x', (x + 16384) % 16384); sim.settle();
        const c = stage.value('code'), y0 = stage.value('y'), y = y0 >= 8192 ? y0 - 16384 : y0;
        if (c !== ulawEncode(x) || y !== ulawDecode(c)) ok = false;
        xs.push(x); ys.push(y); sent++;
      }
      stage.refresh(); paint();
    }).catch(() => { note.textContent = 'The recording would not load.'; });
  };
  ulawApi.set(stage, { agrees: () => ok && sent > 0, sent: () => sent, run });
  const el = h('div', { class: 'mem-panel cpu-panel mc-panel clk-panel mdm-panel', 'data-dock': 'right', 'data-phone': 'flow' }, h('h4', null, 'A voice down the line'),
    h('div', { class: 'dram-ops' }, h('button', { type: 'button', class: 'btn sm', onclick: run }, 'Send 50 ms')), plot.el, read, note);
  stage.resetHooks.add(() => { xs = []; ys = []; sent = 0; paint(); });
  paint();
  return { el, update: () => {} };
};
export function ulawScene(): Scene {
  return { root: ulawLine(), inputs: { x: 1000 }, powerOn: 'zero', engine: 'cycle', panels: [ulawPanel] };
}

// ---- ADPCM ------------------------------------------------------------------------------------------------------------------------------------------

export function adpcmWidget(): Widget {
  return withVoice('Sending the difference', (v, panel, ctl) => {
    // open just before the first loud onset, where the step has to grow
    let at = Math.max(0, v.x.findIndex((t) => Math.abs(t) > 0.4 * 32768) - 120);
    const n = 160, plot = plotOf({ W: 640, H: 210, x: [0, n], y: [-1, 1], yTicks: [-1, 0, 1], xLabel: 'sample (20 ms)', yLabel: '', aria: 'Input, ADPCM output, its error ten times larger, and its step size' });
    const codes = adpcmEncode(v.x), back = adpcmDecode(codes), steps: number[] = [];
    { const s = { pred: 0, index: 0 }; for (const x of v.x) { steps.push(s.index); adpcmEncode([x], s); } }
    const paint = () => {
      plot.clear();
      line(plot, range(n), v.x.slice(at, at + n).map((t) => t / 32768), 'ln-s lump');
      line(plot, range(n), back.slice(at, at + n).map((t) => t / 32768), 'ln-s real');
      line(plot, range(n), range(n).map((i) => Math.max(-1, Math.min(1, (10 * (v.x[at + i] - back[at + i])) / 32768))), 'ln-s wire');
      line(plot, range(n), steps.slice(at, at + n).map((i) => i / 88 - 1), 'ln-s near');
    };
    const mu = v.x.map((t) => 4 * ulawDecode(ulawEncode(t >> 2)));
    const chips = mkChips(4);
    chips.set(0, kbs(4 * v.rate), 'ADPCM: 4 bits a sample');
    chips.set(1, dbs(snrDb(v.x, back)), 'its SNR on the whole voice');
    chips.set(2, dbs(snrDb(v.x, mu)), 'μ-law\'s, at twice the rate');
    chips.set(3, String(Math.max(...steps)), 'the highest step index reached, of 88');
    ctl.append(slider('Where', 0, v.x.length - n, 40, at, (t) => `${num(t / v.rate, 2)} s`, (t) => { at = t; paint(); }).el,
      clipButton('Hear ADPCM, 32 kb/s', () => clip(back, v.rate, 'IMA ADPCM, 4 bits')).el, clipButton('Hear μ-law, 64 kb/s', () => clip(mu, v.rate, 'G.711 μ-law')).el);
    paint();
    panel.append(plot.el, h('div', { class: 'ln-key' }, h('span', { class: 'fr-k' }, 'the voice'), h('span', { class: 'k-far' }, 'ADPCM back'), h('span', { class: 'k-wire' }, 'error × 10'), h('span', { class: 'k-near' }, 'step index, scaled')), chips.el);
  });
}

export function adpcmRvWidget(): Widget {
  return withVoice('ADPCM as a program', (v, panel) => {
    const r = adpcmOnRv(v.x.slice(0, v.rate)), same = r.codes.join() === adpcmEncode(v.x.slice(0, v.rate)).join(), chips = mkChips(4);
    chips.set(0, String(adpcmProgramLength()), 'instructions in the program, RV32I');
    chips.set(1, num(r.perSample, 1), 'instructions a sample, on the golden model');
    chips.set(2, `${num((r.perSample * v.rate) / 1e6, 2)} MIPS`, 'to keep up at 8 kHz, at one instruction a cycle');
    chips.set(3, same ? 'every one' : 'not all', 'codes equal to the model\'s, over the first second');
    panel.append(chips.el, h('pre', { class: 'dsp-asm' }, ADPCM_ASM));
  });
}

// ---- linear prediction -------------------------------------------------------------------------------------------------------------------------------

export function lpcWidget(): Widget {
  return withVoice('A spectrum from ten numbers', (v, panel, ctl) => {
    // open on a voiced frame of the reader's
    let frame = 100, order = 10;
    const plot = plotOf({ W: 640, H: 220, x: [0, v.rate / 2], y: [-90, 10], yTicks: [-80, -60, -40, -20, 0], xLabel: 'Hz', yLabel: 'dB', aria: 'One frame\'s spectrum and the envelope its predictor draws' });
    const chips = mkChips(3);
    const paint = () => {
      const at = frame * VOC.hop, f = v.x.slice(at, at + VOC.win), x = f.map((t, i) => t - 0.9375 * (f[i - 1] ?? 0)), n = 256;
      const w = range(VOC.win).map((i) => 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (VOC.win - 1)));
      const z = fft(cx(range(n).map((i) => (i < VOC.win ? (x[i] / 32768) * w[i] : 0)))), db = range(n / 2).map((k) => 10 * Math.log10(z.re[k] ** 2 + z.im[k] ** 2 + 1e-14));
      const r = autocorr(x, order), d = durbin(r, order), g = Math.sqrt(Math.max(d.err, 1e-20)) / 32768, env = range(n / 2).map((k) => lpcEnvelopeDb(d.a, k / n, g));
      plot.clear();
      line(plot, range(n / 2).map((k) => (k * v.rate) / n), db.map((t) => Math.max(-90, t)), 'ln-s lump');
      line(plot, range(n / 2).map((k) => (k * v.rate) / n), env.map((t) => Math.max(-90, Math.min(10, t))), 'ln-s real');
      chips.set(0, dbs(predictionGainDb(x, d.a)), 'prediction gain: how much smaller the error is than the frame');
      chips.set(1, `${order}`, 'coefficients, sent instead of the frame\'s 240 samples');
      chips.set(2, minus(d.k.slice(0, 3).map((k) => num(k, 2)).join(', ')), 'the first reflection coefficients, each inside ±1');
    };
    ctl.append(slider('Frame', 0, Math.floor((v.x.length - VOC.win) / VOC.hop), 1, frame, (t) => `${num((t * VOC.hop) / v.rate, 2)} s`, (t) => { frame = t; paint(); }).el,
      slider('Order', 2, 20, 1, order, (t) => String(t), (t) => { order = t; paint(); }).el);
    paint();
    panel.append(plot.el, h('div', { class: 'ln-key' }, h('span', { class: 'fr-k' }, 'the frame, pre-emphasized'), h('span', { class: 'k-far' }, 'the predictor\'s envelope')), chips.el);
  });
}

// ---- the vocoder ---------------------------------------------------------------------------------------------------------------------------------------

export function vocoderWidget(): Widget {
  return withVoice('All of them, side by side', (v, panel, ctl) => {
    const voc = vocode(v.x), lags = voc.frames.filter((f) => f.voiced).map((f) => f.lag).sort((a, b) => a - b);
    const mu = v.x.map((t) => 4 * ulawDecode(ulawEncode(t >> 2))), ad = adpcmDecode(adpcmEncode(v.x));
    const rows: [string, number, string][] = [['The recording, 16 bits', v.rate * 16, '—'], ['μ-law (G.711), the model the gates equal', v.rate * 8, dbs(snrDb(v.x, mu))], ['IMA ADPCM, the model the RV32 program equals', v.rate * 4, dbs(snrDb(v.x, ad))], ['Our vocoder, a model', vocBitRate(v.rate), 'not a waveform coder']];
    panel.append(h('table', { class: 'dsp-table' }, h('tr', null, h('th', null, 'Coder'), h('th', null, 'Rate'), h('th', null, 'SNR')), ...rows.map(([n, b, s]) => h('tr', null, h('td', null, n), h('td', null, kbs(b)), h('td', null, s)))));
    const chips = mkChips(4);
    chips.set(0, `${vocBitsPerFrame()} bits`, `a 22.5 ms frame: ${VOC_BITS.k.reduce((a, b) => a + b, 0)} for ten reflection coefficients, ${VOC_BITS.pitch} pitch and voicing, ${VOC_BITS.gain} gain, ${VOC_BITS.sync} sync`);
    chips.set(1, `${num((100 * voc.voiced) / voc.frames.length, 0)} %`, 'of frames found voiced');
    chips.set(2, `${num(v.rate / lags[lags.length >> 1], 0)} Hz`, 'the reader\'s median pitch, as found');
    chips.set(3, `${num((v.x.length * 16) / ((voc.frames.length * vocBitsPerFrame())), 0)} : 1`, 'against the 16-bit recording');
    panel.append(chips.el);
    ctl.append(clipButton('The recording', () => clip(v.x, v.rate, '16 bits')).el, clipButton('μ-law', () => clip(mu, v.rate, '64 kb/s')).el, clipButton('ADPCM', () => clip(ad, v.rate, '32 kb/s')).el, clipButton('The vocoder', () => clip(voc.y, v.rate, '2.4 kb/s, a model')).el);
  });
}
