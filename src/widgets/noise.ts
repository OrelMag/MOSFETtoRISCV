// The noise chapter's explorers: the noise floor, a decision against noise, the matched filter, the error-rate curve, capacity against
// band, a random code against the limit, and a chain's noise figure. Closed forms from comm/noise.ts and comm/ber.ts beside seeded counts.

import { shannonBinaryDb, uncodedBer } from '../comm/ber';
import { EBN0_MIN, ratioToDb } from '../comm/limits';
import {
  capacityAt, capacityCeiling, cascadeNfDb, decisionError, errorAfter, johnsonVolts, measuredBer, measuredDecision, measuredReceiver, noiseDensityDbm, noiseFloorDbm, PULSES, receiverFloorDbm, randomCodeError, RECEIVERS, snrAfter, type ChainStage,
} from '../comm/noise';
import { gaussian, rng } from '../phys/line';
import { groupDigits } from '../sim/numfmt';
import { h, s } from '../ui/dom';
import type { Widget } from '../view/stage';
import { line, mkChips, num, plotOf, sci } from './line';
import { fmtRate, pow10 } from './message';
import { slider } from './mosparts';
import '../styles/line.css';
import '../styles/fourier.css';
import '../styles/signals.css';

const hz = (v: number) => fmtRate(v).replace('b/s', 'Hz');
const volts = (v: number) => (v >= 1e-3 ? `${(v * 1e3).toPrecision(3)} mV` : v >= 1e-6 ? `${(v * 1e6).toPrecision(3)} µV` : `${(v * 1e9).toPrecision(3)} nV`);
const dbm = (v: number) => `${v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)} dBm`;
/** A share counted in n trials: a count of none says only that, never a figure smaller than the trials can show. */
const counted = (b: number, n: number) => (b > 0 ? sci(b) : `none in ${groupDigits(n)}`);
/** A slow count remembered per setting, so a dragged slider recounts each value once. */
function remembered<K, V>(f: (k: K) => V): (k: K) => V {
  const seen = new Map<K, V>();
  return (k) => { if (!seen.has(k)) seen.set(k, f(k)); return seen.get(k)!; };
}
const db = (v: number, d = 1) => `${v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)} dB`;

export function thermalWidget(): Widget {
  let exp = 7, kelvin = 290, nf = 6;
  const chips = mkChips(4);
  function paint() {
    const B = 10 ** exp;
    chips.set(0, dbm(noiseDensityDbm(kelvin)).replace('dBm', 'dBm/Hz'), `kT, a source at ${kelvin} K`);
    chips.set(1, dbm(noiseFloorDbm(B, 0, kelvin)), `the source alone, in ${hz(B)}`);
    chips.set(2, dbm(receiverFloorDbm(B, nf, kelvin)), `with a receiver of ${nf} dB noise figure, which adds ${Math.round((10 ** (nf / 10) - 1) * 290)} K of its own`);
    chips.set(3, volts(johnsonVolts(50, B, kelvin)), 'across an open 50 Ω resistor');
  }
  paint();
  return {
    el: h('div', { class: 'widget mos sr-w' },
      h('div', { class: 'panel' }, h('h3', null, 'The floor nothing goes below'), chips.el),
      h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row' },
        slider('Bandwidth', 3, 10, 0.1, exp, (v) => hz(10 ** v), (v) => { exp = v; paint(); }).el,
        slider('Source at', 4, 400, 1, kelvin, (v) => `${v} K`, (v) => { kelvin = v; paint(); }).el,
        slider('Noise figure', 0, 12, 1, nf, (v) => `${v} dB`, (v) => { nf = v; paint(); }).el))),
  };
}

const countedDecision = remembered((sigma: number) => measuredDecision(sigma, 200000, 9));

export function decisionWidget(): Widget {
  let sigma = 0.4;
  const BINS = 80, SPAN = 3.2, N = 20000;
  const plot = plotOf({ W: 640, H: 210, x: [0, 2 * SPAN], y: [0, 1], yTicks: [], xLabel: 'level read', yLabel: 'how often', aria: 'How often each level is read when 0 is sent and when 1 is sent, and the threshold half way', xFmt: (v) => num(v - SPAN, 1) });
  const chips = mkChips(3);
  function paint() {
    const a = new Array<number>(BINS).fill(0), b = new Array<number>(BINS).fill(0), u = rng(5);
    const bin = (v: number) => Math.floor(((v + SPAN) / (2 * SPAN)) * BINS);
    for (let i = 0; i < N; i++) {
      const lo = bin(-1 + sigma * gaussian(u)), hi = bin(1 + sigma * gaussian(u));
      if (lo >= 0 && lo < BINS) a[lo]++;
      if (hi >= 0 && hi < BINS) b[hi]++;
    }
    const top = Math.max(...a, ...b), w = plot.X(2 * SPAN / BINS) - plot.X(0);
    plot.clear();
    const bars = (c: number[], cls: string) => c.forEach((v, i) => { if (v) plot.layer.append(s('rect', { x: plot.X((i * 2 * SPAN) / BINS), width: w, y: plot.Y(v / top), height: plot.Y(0) - plot.Y(v / top), class: `sg-hist ${cls}` })); });
    bars(a, 'a'); bars(b, 'b');
    plot.layer.append(s('line', { x1: plot.X(SPAN), x2: plot.X(SPAN), y1: plot.Y(1), y2: plot.Y(0), class: 'sg-th' }));
    chips.set(0, db(20 * Math.log10(1 / sigma)), 'SNR: level² ÷ σ²');
    chips.set(1, sci(decisionError(1, sigma)), 'the Gaussian tail, Q(1 / σ)');
    chips.set(2, counted(countedDecision(sigma), 200000), 'the share wrong in 200 000 counted');
  }
  paint();
  return {
    el: h('div', { class: 'widget mos sr-w' },
      h('div', { class: 'panel' }, h('h3', null, 'Two levels and a threshold'), plot.el, chips.el),
      h('div', { class: 'panel mos-ctl' }, slider('Noise σ', 0.1, 1.5, 0.02, sigma, (v) => num(v, 2), (v) => { sigma = v; paint(); }).el)),
  };
}

const countedReceiver = remembered((key: string) => {
  const [pi, ri, sg] = key.split('/').map(Number), p = PULSES[pi].shape;
  return measuredReceiver(p, RECEIVERS[ri].weights(p), sg, 40000, 13);
});

export function matchedWidget(): Widget {
  let pulse = 1, recv = 0, sigma = 2;
  const plot = plotOf({ W: 640, H: 200, x: [0, 15], y: [-3, 3], yTicks: [-2, 0, 2], xLabel: 'sample of the symbol', yLabel: 'level', aria: 'One noisy symbol, the clean pulse under it, and the weights the receiver gives each sample' });
  const pSel = h('select', { 'aria-label': 'Pulse' }, ...PULSES.map((p, i) => h('option', { value: String(i), selected: i === pulse }, p.name))) as HTMLSelectElement;
  const rSel = h('select', { 'aria-label': 'Receiver' }, ...RECEIVERS.map((r, i) => h('option', { value: String(i), selected: i === recv }, r.name))) as HTMLSelectElement;
  pSel.addEventListener('change', () => { pulse = Number(pSel.value); paint(); });
  rSel.addEventListener('change', () => { recv = Number(rSel.value); paint(); });
  const chips = mkChips(4);
  function paint() {
    const p = PULSES[pulse].shape, w = RECEIVERS[recv].weights(p), u = rng(3);
    const xs = p.map((_, i) => i), snr = snrAfter(p, w, sigma), best = snrAfter(p, RECEIVERS[2].weights(p), sigma);
    plot.clear();
    line(plot, xs, p.map((v) => v + sigma * gaussian(u)), 'ln-s near');
    line(plot, xs, p, 'ln-s real');
    const wMax = Math.max(...w);
    w.forEach((v, i) => { if (v) plot.layer.append(s('line', { x1: plot.X(i), x2: plot.X(i), y1: plot.Y(0), y2: plot.Y(-(v / wMax) * 2), class: 'sg-stem out' })); });
    chips.set(0, db(10 * Math.log10(snr)), 'SNR of the decision');
    chips.set(1, db(10 * Math.log10(best / snr)), 'below the best any weights can do', best / snr > 1.001 ? 'bad' : 'good');
    chips.set(2, sci(errorAfter(snr)), 'errors, closed form');
    chips.set(3, counted(countedReceiver(`${pulse}/${recv}/${sigma}`), 40000), 'errors in 40 000 counted');
  }
  paint();
  return {
    el: h('div', { class: 'widget mos sr-w' },
      h('div', { class: 'panel' }, h('h3', null, 'One symbol in noise'), h('div', { class: 'ln-key' }, h('span', { class: 'k-far' }, 'the pulse sent'), h('span', { class: 'k-near' }, 'what arrives'), h('span', { class: 'fr-k' }, 'weights (drawn downward)')), plot.el, chips.el),
      h('div', { class: 'panel mos-ctl' }, h('label', { class: 'mos-sl ln-sel' }, h('span', null, 'Pulse'), pSel), h('label', { class: 'mos-sl ln-sel' }, h('span', null, 'Receiver'), rSel),
        slider('Noise σ', 0.5, 5, 0.1, sigma, (v) => num(v, 1), (v) => { sigma = v; paint(); }).el)),
  };
}

/** log10 of a rate, on an axis that starts at 0: the plot's x starts at 0, so dB is shifted by this. */
const DB0 = 4;

export function berCurveWidget(): Widget {
  let at = 7;
  const plot = plotOf({ W: 640, H: 260, x: [0, 18], y: [-10, 0], yTicks: [0, -2, -4, -6, -8, -10], xLabel: 'Eb/N0, dB', yLabel: '', aria: 'Bit error rate of uncoded signalling against Eb over N0: the closed form, counted points, and the limit for any code', xFmt: (v) => num(v - DB0, 0), yFmt: pow10 });
  const chips = mkChips(3);
  const dots: [number, number][] = [];
  for (const d of [0, 2, 4, 6, 7, 8]) { const b = measuredBer(d, 400000, 41 + d); if (b > 0) dots.push([d, b]); }
  function paint() {
    const xs = Array.from({ length: 91 }, (_, i) => -DB0 + (i / 90) * 18);
    plot.clear();
    line(plot, xs.map((d) => d + DB0), xs.map((d) => Math.max(-10, Math.log10(uncodedBer(d)))), 'ln-s real');
    for (const [d, b] of dots) plot.layer.append(s('circle', { cx: plot.X(d + DB0), cy: plot.Y(Math.log10(b)), r: 4, class: 'sg-pt' }));
    const wall = ratioToDb(EBN0_MIN);
    plot.layer.append(s('line', { x1: plot.X(wall + DB0), x2: plot.X(wall + DB0), y1: plot.Y(0), y2: plot.Y(-10), class: 'sg-limit' }), s('text', { x: plot.X(wall + DB0) + 5, y: plot.Y(-9.5), class: 'sg-limit-t' }, 'no code passes this'));
    plot.layer.append(s('circle', { cx: plot.X(at + DB0), cy: plot.Y(Math.max(-10, Math.log10(uncodedBer(at)))), r: 5, class: 'sg-dot' }));
    chips.set(0, sci(uncodedBer(at)), `uncoded, at ${db(at)}`);
    chips.set(1, db(at - wall), 'above the limit for any code');
    chips.set(2, groupDigits(Math.round(uncodedBer(at) * 1e9)), 'wrong bits a second at 1 Gb/s');
  }
  paint();
  return {
    el: h('div', { class: 'widget mos sr-w' },
      h('div', { class: 'panel' }, h('h3', null, 'Bit errors: the curve every link is judged on'), h('div', { class: 'ln-key' }, h('span', { class: 'k-far' }, 'closed form'), h('span', { class: 'k-near' }, 'counted (400 000 bits)')), plot.el, chips.el),
      h('div', { class: 'panel mos-ctl' }, slider('Eb/N0', -3, 14, 0.5, at, (v) => db(v), (v) => { at = v; paint(); }).el)),
  };
}

export function capacityWidget(): Widget {
  let pn = 6;
  // x is log10 of the band over P/N0, shifted to start at 0: from a hundredth of it to a hundred times
  const plot = plotOf({ W: 640, H: 220, x: [0, 4], y: [0, 1.1], yTicks: [0, 0.5, 1], xLabel: 'band ÷ (P / N0)', yLabel: 'share of the ceiling', aria: 'Capacity against bandwidth at fixed power: it rises, then flattens at a ceiling', xFmt: (v) => pow10(v - 2) });
  const chips = mkChips(3);
  function paint() {
    const p = 10 ** pn, top = capacityCeiling(p), xs = Array.from({ length: 81 }, (_, i) => i / 20);
    plot.clear();
    line(plot, xs, xs.map((x) => capacityAt(p, p * 10 ** (x - 2)) / top), 'ln-s real');
    plot.layer.append(s('line', { x1: plot.X(0), x2: plot.X(4), y1: plot.Y(1), y2: plot.Y(1), class: 'sg-limit' }));
    chips.set(0, fmtRate(top), 'the ceiling, P / (N0 ln 2), with all the band there is');
    chips.set(1, fmtRate(capacityAt(p, p)), `at a band of ${hz(p)}, where SNR is 0 dB: ${(100 * Math.LN2).toFixed(0)} % of it`);
    chips.set(2, fmtRate(capacityAt(p, p / 100)), `at ${hz(p / 100)}, where SNR is 20 dB: power to spare, band short`);
  }
  paint();
  return {
    el: h('div', { class: 'widget mos sr-w' },
      h('div', { class: 'panel' }, h('h3', null, 'More band, the same power'), plot.el, chips.el),
      h('div', { class: 'panel mos-ctl' }, slider('P / N0', 3, 9, 1, pn, (v) => hz(10 ** v), (v) => { pn = v; paint(); }).el)),
  };
}

/** The random-code runs, slow enough to be cut into a point a timer tick. */
export const CODE_LENGTHS = [8, 12, 20];
const CODE_DBS = [-3, -2, -1, 0, 1, 2, 3, 4, 5, 6];
const CODE_TRIALS = 600;
const CODE_CLASS = ['ln-s lump', 'ln-s near', 'ln-s real'];

export function randomCodeWidget(): Widget {
  const plot = plotOf({ W: 640, H: 240, x: [0, 10], y: [-3, 0], yTicks: [0, -1, -2, -3], xLabel: 'Eb/N0, dB', yLabel: '', aria: 'Word error rate of random codes of rate one half at three lengths, against the limit for that rate', xFmt: (v) => num(v - DB0, 0), yFmt: pow10 });
  const results = CODE_LENGTHS.map(() => new Array<number>(CODE_DBS.length).fill(NaN));
  const note = h('p', { class: 'sub mos-note' }), chips = mkChips(2);
  let timer = 0, running = false;
  const limit = shannonBinaryDb(0.5);
  function paint() {
    plot.clear();
    plot.layer.append(s('line', { x1: plot.X(limit + DB0), x2: plot.X(limit + DB0), y1: plot.Y(0), y2: plot.Y(-3), class: 'sg-limit' }), s('text', { x: plot.X(limit + DB0) + 5, y: plot.Y(-0.12), class: 'sg-limit-t' }, 'the limit at rate ½'));
    results.forEach((r, i) => {
      const keep = CODE_DBS.map((_, j) => j).filter((j) => r[j] > 0);
      if (keep.length > 1) line(plot, keep.map((j) => CODE_DBS[j] + DB0), keep.map((j) => Math.log10(r[j])), CODE_CLASS[i]);
    });
    chips.set(0, db(limit, 2), 'Eb/N0 at the limit for rate ½ on ±1 signals');
    const i6 = CODE_DBS.indexOf(6);
    chips.set(1, Number.isNaN(results[2][i6]) ? '—' : `${(results[0][i6] * 100).toFixed(1)} % → ${(results[2][i6] * 100).toFixed(1)} %`, `words wrong at ${db(6, 0)}, ${CODE_LENGTHS[0]} bits → ${CODE_LENGTHS[2]} bits`);
  }
  function run() {
    if (running) return;
    running = true;
    const jobs = CODE_LENGTHS.flatMap((n, i) => CODE_DBS.map((d, j) => ({ n, i, d, j })));
    results.forEach((r) => r.fill(NaN));
    const step = () => {
      const job = jobs.shift();
      if (!job) { running = false; note.textContent = `Each point is ${CODE_TRIALS} words, each with a new random codebook, decoded by trying every word.`; return; }
      note.textContent = `Running: ${job.n} bits at ${db(job.d, 0)}…`;
      results[job.i][job.j] = randomCodeError(job.n, job.n / 2, job.d, CODE_TRIALS, job.n * 1000 + job.j);
      paint();
      timer = window.setTimeout(step, 0);
    };
    step();
  }
  paint();
  note.textContent = 'Press Run: a few seconds of real decoding.';
  return {
    el: h('div', { class: 'widget mos sr-w' },
      h('div', { class: 'panel' }, h('h3', null, 'Words wrong: the code from Shannon\'s proof'), h('div', { class: 'ln-key' }, ...CODE_LENGTHS.map((n, i) => h('span', { class: ['fr-k', 'k-near', 'k-far'][i] }, `${n} bits`))), plot.el, chips.el, note),
      h('div', { class: 'panel mos-ctl' }, h('button', { type: 'button', class: 'btn sm primary', onclick: run }, 'Run'))),
    destroy() { clearTimeout(timer); },
  };
}

export function chainWidget(): Widget {
  const lna: ChainStage = { name: 'Amplifier', gainDb: 20, nfDb: 1 }, cable: ChainStage = { name: 'Cable', gainDb: -10, nfDb: 10 };
  let first = true, gain = 20, loss = 10, nf = 1;
  const chips = mkChips(3), order = h('div', { class: 'sg-dbrows' });
  const box = h('input', { type: 'checkbox', checked: true, 'aria-label': 'Amplifier before the cable' }) as HTMLInputElement;
  box.addEventListener('change', () => { first = box.checked; paint(); });
  function paint() {
    lna.gainDb = gain; lna.nfDb = nf; cable.gainDb = -loss; cable.nfDb = loss;
    const chain = first ? [lna, cable] : [cable, lna], total = cascadeNfDb(chain);
    order.replaceChildren(h('div', { class: 'sg-dbrow head' }, h('span', null, 'In order'), h('span', null, 'Gain'), h('span', null, 'Noise figure'), h('span', null, '')),
      ...chain.map((c) => h('div', { class: 'sg-dbrow' }, h('span', null, c.name), h('span', null, db(c.gainDb, 0)), h('span', null, db(c.nfDb, 0)), h('span', null, ''))));
    chips.set(0, db(total, 2), 'noise figure of the chain', total > 3 ? 'bad' : 'good');
    chips.set(1, dbm(noiseFloorDbm(20e6, total)), 'noise floor in 20 MHz');
    const other = cascadeNfDb(first ? [cable, lna] : [lna, cable]) - total;
    chips.set(2, db(Math.abs(other), 1), other > 0 ? 'what the other order would cost' : 'what the other order would save');
  }
  paint();
  return {
    el: h('div', { class: 'widget mos sr-w' },
      h('div', { class: 'panel' }, h('h3', null, 'A receiver is a chain'), order, chips.el),
      h('div', { class: 'panel mos-ctl' }, h('label', { class: 'mos-sl' }, box, h('span', null, 'Amplifier before the cable')), h('div', { class: 'mos-row' },
        slider('Amplifier gain', 0, 40, 1, gain, (v) => `${v} dB`, (v) => { gain = v; paint(); }).el,
        slider('Amplifier noise', 0, 6, 0.5, nf, (v) => `${v} dB`, (v) => { nf = v; paint(); }).el,
        slider('Cable loss', 0, 30, 1, loss, (v) => `${v} dB`, (v) => { loss = v; paint(); }).el))),
  };
}
