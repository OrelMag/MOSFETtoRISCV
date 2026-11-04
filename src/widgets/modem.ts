// Chapter 45's explainers: the voice channel and its tones, the FSK waveform (driven by the same integer models the gates are
// checked against), a carrier with an in-phase and a quadrature part, a constellation in noise (measured against the closed
// form), Shannon's limit against the modems that approached it, ADSL's bit loading, and the gate-level scenes' panels.
// Models: comm/modem.ts, comm/limits.ts.

import '../styles/modem.css';
import {
  ACC_BITS, ADSL, BELL103, bitLoad, bitsOf, bitsPerSymbol, constellation, DOWN_TONES, FS, FskRxModel, FTW_MARK, FTW_SPACE, fskModulate, gapDb,
  MODEMS, monteCarlo, ncoHz, noisy, RX_LONG, SAMPLES_PER_BIT, serClosed, snrForSer, toneSnrDb, tuningWord, type Kind,
} from '../comm/modem';
import { dbToRatio, levelsSupported, ratioToDb, shannon, snrNeeded } from '../comm/limits';
import { gaussian, rng } from '../phys/line';
import { findNode } from '../sim/flatten';
import { pack } from '../sim/values';
import { FSK_LINK, NCO } from '../lib';
import { h, s } from '../ui/dom';
import type { Scene, ScenePanel, Stage, Widget } from '../view/stage';
import { fitText, slider } from './mosparts';

const nf = (x: number, d = 2) => x.toFixed(d);
const fmtRate = (x: number) => (x >= 1e6 ? `${+(x / 1e6).toPrecision(3)} Mb/s` : x >= 1e3 ? `${+(x / 1e3).toPrecision(3)} kb/s` : `${+x.toPrecision(3)} b/s`);
const sci = (x: number): string => (x === 0 ? '0' : x >= 0.001 ? x.toPrecision(2) : x.toExponential(1));

function frame(W: number, H: number, xr: [number, number], yr: [number, number], xl: string, yl: string, label: string, xt: number, yt: number, m = { l: 52, r: 14, t: 12, b: 34 }, xf: (v: number) => string = (v) => nf(v, 0), yf: (v: number) => string = (v) => nf(v, 0)) {
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'mos-plot', role: 'img', 'aria-label': label }) as SVGSVGElement;
  fitText(svg, W);
  const X = (v: number) => m.l + ((v - xr[0]) / (xr[1] - xr[0])) * (W - m.l - m.r);
  const Y = (v: number) => H - m.b - ((v - yr[0]) / (yr[1] - yr[0])) * (H - m.t - m.b);
  if (xt > 0) for (let v = xr[0]; v <= xr[1] + 1e-9; v += xt) svg.append(s('line', { x1: X(v), x2: X(v), y1: m.t, y2: H - m.b, class: 'grid' }), s('text', { x: X(v), y: H - m.b + 14, 'text-anchor': 'middle', class: 'tick' }, xf(v)));
  if (yt > 0) for (let v = yr[0]; v <= yr[1] + 1e-9; v += yt) svg.append(s('line', { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v), class: 'grid' }), s('text', { x: m.l - 6, y: Y(v) + 3.5, 'text-anchor': 'end', class: 'tick' }, yf(v)));
  svg.append(s('line', { x1: m.l, x2: W - m.r, y1: H - m.b, y2: H - m.b, class: 'ax' }), s('line', { x1: m.l, x2: m.l, y1: m.t, y2: H - m.b, class: 'ax' }),
    s('text', { x: W - m.r, y: H - 4, 'text-anchor': 'end', class: 'axl' }, xl),
    s('text', { x: 6, y: m.t, 'text-anchor': 'end', 'dominant-baseline': 'hanging', transform: `rotate(-90 6 ${m.t})`, class: 'axl' }, yl));
  return { svg, X, Y, W, H, m };
}
const path = (pts: [number, number][]) => pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
const chipsOf = (n: number) => {
  const cells = Array.from({ length: n }, () => ({ b: h('b'), c: h('span') }));
  return { el: h('div', { class: 'mos-chips' }, ...cells.map((c) => h('div', null, c.b, c.c))), set(i: number, v: string, cap: string) { cells[i].b.textContent = v; cells[i].c.textContent = cap; } };
};
const seg = <T extends string>(label: string, opts: [T, string][], cur: T, on: (v: T) => void) => {
  const el = h('div', { class: 'seg', role: 'group', 'aria-label': label });
  const bs = opts.map(([v, t]) => { const b = h('button', { type: 'button', 'aria-pressed': String(v === cur) }, t); b.addEventListener('click', () => { bs.forEach((x) => x.setAttribute('aria-pressed', String(x === b))); on(v); }); return b; });
  el.append(...bs);
  return el;
};

// ---- 1. the channel built for voices ----------------------------------------------------------------------------------------

export function passbandWidget(): Widget {
  let snrDb = 35;
  const B = 3100, F0 = 300, F1 = 3400;
  const f = frame(560, 240, [0, 4000], [-50, 5], 'Hz', 'dB', 'The voice channel\'s pass band with the tones of the early modems', 500, 10, { l: 44, r: 14, t: 14, b: 34 }, (v) => `${v}`, (v) => `${v}`);
  // an illustrative trapezoid: a transformer and the exchange's filters cut below 300 Hz and above 3400 Hz
  const resp = (hz: number) => (hz < F0 ? -40 * Math.min(1, (F0 - hz) / 250) * 1 - 3 : hz > F1 ? -3 - 45 * Math.min(1, (hz - F1) / 600) : 0);
  f.svg.append(s('rect', { class: 'clk-zone', x: f.X(F0), width: f.X(F1) - f.X(F0), y: f.m.t, height: f.H - f.m.t - f.m.b }));
  f.svg.append(s('path', { class: 'cur', d: path(Array.from({ length: 161 }, (_, i): [number, number] => [f.X(i * 25), f.Y(resp(i * 25))])) }));
  const marks: [number, string, string][] = [
    [BELL103.originate.space, '1070', 'o'], [BELL103.originate.mark, '1270', 'o'], [BELL103.answer.space, '2025', 'a'], [BELL103.answer.mark, '2225', 'a'],
    [1200, 'V.22 o', 'v'], [2400, 'V.22 a', 'v'], [1800, 'V.32', 'w'],
  ];
  marks.forEach(([hz, t, c], i) => f.svg.append(s('line', { x1: f.X(hz), x2: f.X(hz), y1: f.Y(-46), y2: f.Y(0), class: `mdm-tone ${c}` }), s('text', { x: f.X(hz), y: f.Y(-8 - ((i % 3) * 8)) , 'text-anchor': 'middle', class: 'mdm-tl' }, t)));
  f.svg.append(s('text', { x: f.X(1850), y: f.Y(3.5), 'text-anchor': 'middle', class: 'mk-l' }, '300 – 3400 Hz'));
  const chips = chipsOf(4);
  const note = h('p', { class: 'sub mos-note' });
  const paint = () => {
    const cap = shannon(B, dbToRatio(snrDb));
    const fit = [...MODEMS].filter((m) => m.id !== 'v90' && m.rate <= cap).pop();
    chips.set(0, `${B} Hz`, 'usable band (300 – 3400 Hz)');
    chips.set(1, `${2 * B} / s`, 'Nyquist: 2B real values, B complex symbols');
    chips.set(2, fmtRate(cap), `Shannon at ${nf(snrDb, 0)} dB`);
    chips.set(3, `${nf(levelsSupported(dbToRatio(snrDb)), 0)} levels`, 'per axis the noise allows');
    note.textContent = fit ? `The fastest voice-band modem below that capacity is ${fit.name} (${fmtRate(fit.rate)}).` : 'No voice-band modem of the table fits under that capacity.';
  };
  const sl = slider('SNR', 10, 50, 1, snrDb, (v) => `${v} dB`, (v) => { snrDb = v; paint(); });
  paint();
  return { el: h('div', { class: 'widget mos comm mdm-w' }, h('div', { class: 'panel' }, h('h3', null, 'A channel for 300 – 3400 Hz'), f.svg,
    h('p', { class: 'sub' }, 'Pass band: an illustrative shape (the real response is set by the loop\'s transformers and the exchange\'s filters). Tones: Bell 103 o = originating, a = answering; V.22 carriers; V.32\'s carrier.')),
  h('div', { class: 'panel mos-ctl' }, sl.el, h('p', { class: 'sub mos-note' }, '35 dB is the signal-to-noise ratio this chapter assumes for a good call (ours to assume; the real figure is measured at the start of every V.34 call).')), chips.el, note) };
}

// ---- 2. FSK, from the integer models -------------------------------------------------------------------------------------------

export function fskWidget(): Widget {
  let bits = [1, 0, 1, 1, 0, 0, 1, 0], sigma = 0, seed = 1;
  const W = 600, spb = SAMPLES_PER_BIT;
  const fW = frame(W, 150, [0, bits.length * spb], [0, 63], 'sample (19 200 Hz)', 'line', 'The line signal: 6-bit samples', 0, 0, { l: 40, r: 10, t: 8, b: 24 });
  const fD = frame(W, 110, [0, bits.length * spb], [-0.2, 1.2], 'sample', '', 'The receiver\'s decision register and the bits read from it', 0, 0, { l: 40, r: 10, t: 8, b: 24 });
  const wave = fW.svg.appendChild(s('path', { class: 'wave mdm-sig' })), clean = fW.svg.appendChild(s('path', { class: 'mdm-ghost' }));
  const dec = fD.svg.appendChild(s('path', { class: 'wave mdm-dec' })), dots = fD.svg.appendChild(s('g'));
  const seps = fW.svg.appendChild(s('g'));
  const chips = chipsOf(4), row = h('div', { class: 'mdm-bits', role: 'group', 'aria-label': 'Bits to send' });
  const paint = () => {
    const tx = fskModulate(bits, spb), line = sigma > 0 ? noisy(tx, sigma, seed) : tx;
    const rx = new FskRxModel(), d: number[] = [];
    let maxCnt = 0;
    for (const x of line) { rx.clock(x); d.push(rx.d); }
    wave.setAttribute('d', path(line.map((v, i): [number, number] => [fW.X(i), fW.Y(v)])));
    clean.setAttribute('d', sigma > 0 ? path(tx.map((v, i): [number, number] => [fW.X(i), fW.Y(v)])) : '');
    dec.setAttribute('d', path(d.map((v, i): [number, number] => [fD.X(i), fD.Y(v)])));
    seps.replaceChildren(...bits.map((b, i) => s('text', { x: fW.X((i + 0.5) * spb), y: fW.Y(58), 'text-anchor': 'middle', class: 'mdm-bit' }, String(b))),
      ...bits.map((_, i) => s('line', { x1: fW.X(i * spb), x2: fW.X(i * spb), y1: fW.m.t, y2: fW.H - fW.m.b, class: 'mk' })));
    const got = bits.map((_, i) => d[Math.floor((i + 0.75) * spb)]);
    dots.replaceChildren(...got.map((g, i) => s('circle', { cx: fD.X((i + 0.75) * spb), cy: fD.Y(g), r: 5, class: `mdm-dot ${g === bits[i] || i < 1 ? 'ok' : 'bad'}` })));
    const errs = got.filter((g, i) => i >= 1 && g !== bits[i]).length;
    void maxCnt;
    chips.set(0, `${nf(ncoHz(FTW_SPACE), 1)} / ${nf(ncoHz(FTW_MARK), 1)} Hz`, `tuning words ${FTW_SPACE} / ${FTW_MARK}`);
    chips.set(1, `${FS / spb} baud`, `${spb} samples a bit`);
    chips.set(2, `${RX_LONG}`, 'clocks between edges: ≥ is a 0');
    chips.set(3, `${errs} of ${bits.length - 1}`, 'bits wrong (the first is the start-up)');
    row.querySelectorAll('button').forEach((b, i) => { b.textContent = String(bits[i]); b.setAttribute('aria-label', `Bit ${i + 1}: ${bits[i]}. Toggle`); });
  };
  bits.forEach((_, i) => row.append(h('button', { type: 'button', class: 'btn sm mdm-b', onclick: () => { bits = bits.map((b, j) => (j === i ? 1 - b : b)); paint(); } })));
  const sl = slider('Noise', 0, 20, 0.5, sigma, (v) => `${nf(v, 1)} steps rms`, (v) => { sigma = v; paint(); });
  const roll = h('button', { type: 'button', class: 'btn sm', onclick: () => { seed++; paint(); } }, 'Another noise');
  paint();
  return { el: h('div', { class: 'widget mos comm mdm-w' }, h('div', { class: 'panel' }, h('h3', null, 'Eight bits as tones'), row, fW.svg, fD.svg,
    h('p', { class: 'sub' }, 'Top: what goes on the line (the NCO\'s 6-bit samples; the light curve is the noise-free signal). Bottom: the decision register of the period counter and the value read in the 3/4 point of each bit.')),
  h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row' }, sl.el, roll)), chips.el) };
}

// ---- 3. a carrier with two parts ------------------------------------------------------------------------------------------------

export function iqWidget(): Widget {
  let M = 4, kind: Kind = 'qam', sel = 0;
  const cs = () => constellation(kind, M);
  const fC = frame(300, 300, [-1.6, 1.6], [-1.6, 1.6], 'I', 'Q', 'Constellation: click a point', 0, 0, { l: 30, r: 10, t: 10, b: 28 });
  const fW = frame(300, 300, [0, 2], [-1.6, 1.6], 'carrier cycles', '', 'The carrier for the chosen symbol', 0, 0, { l: 14, r: 10, t: 10, b: 28 });
  const gPts = fC.svg.appendChild(s('g')), cur = fW.svg.appendChild(s('path', { class: 'wave mdm-sig' }));
  fC.svg.append(s('line', { x1: fC.X(-1.6), x2: fC.X(1.6), y1: fC.Y(0), y2: fC.Y(0), class: 'vt' }), s('line', { x1: fC.X(0), x2: fC.X(0), y1: fC.Y(-1.6), y2: fC.Y(1.6), class: 'vt' }));
  fW.svg.append(s('line', { x1: fW.X(0), x2: fW.X(2), y1: fW.Y(0), y2: fW.Y(0), class: 'vt' }));
  const ref = fW.svg.appendChild(s('path', { class: 'mdm-ghost' }));
  const chips = chipsOf(4), bitsFmt = (i: number) => i.toString(2).padStart(bitsOf(M), '0');
  const paint = () => {
    const c = cs();
    if (sel >= M) sel = 0;
    gPts.replaceChildren(...c.pts.map(([x, y], i) => {
      const g = s('g', { role: 'button', tabindex: 0, 'aria-label': `Symbol ${bitsFmt(i)} at I ${nf(x)}, Q ${nf(y)}`, class: `mdm-pt${i === sel ? ' on' : ''}` },
        s('circle', { cx: fC.X(x), cy: fC.Y(y), r: i === sel ? 7 : 5 }), M <= 16 ? s('text', { x: fC.X(x), y: fC.Y(y) - 10, 'text-anchor': 'middle', class: 'mdm-tl' }, bitsFmt(i)) : null);
      const pick = () => { sel = i; paint(); };
      g.addEventListener('click', pick);
      g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
      return g;
    }));
    const [I, Q] = c.pts[sel], A = Math.hypot(I, Q), ph = (Math.atan2(Q, I) * 180) / Math.PI;
    cur.setAttribute('d', path(Array.from({ length: 201 }, (_, k): [number, number] => { const t = (k / 200) * 2; return [fW.X(t), fW.Y(I * Math.cos(2 * Math.PI * t) - Q * Math.sin(2 * Math.PI * t))]; })));
    ref.setAttribute('d', path(Array.from({ length: 201 }, (_, k): [number, number] => { const t = (k / 200) * 2; return [fW.X(t), fW.Y(Math.cos(2 * Math.PI * t))]; })));
    chips.set(0, bitsFmt(sel), 'bits (Gray labelled)');
    chips.set(1, `${nf(I)} , ${nf(Q)}`, 'I , Q');
    chips.set(2, nf(A), 'amplitude');
    chips.set(3, `${nf(ph, 0)}°`, 'phase');
  };
  const choice = seg('Constellation', [['q4', 'QPSK'], ['p8', '8-PSK'], ['q16', '16-QAM']] as [string, string][], 'q4', (v) => { kind = v[0] === 'p' ? 'psk' : 'qam'; M = Number(v.slice(1)); sel = 0; paint(); });
  paint();
  return { el: h('div', { class: 'widget mos comm mdm-w' }, h('div', { class: 'panel' }, h('h3', null, 'x(t) = I cos 2πft − Q sin 2πft'), choice,
    h('div', { class: 'clk-two' }, fC.svg, fW.svg),
    h('p', { class: 'sub' }, 'Each point is one symbol: its I scales a cosine, its Q a sine, and the sum is one sinusoid of the same frequency with a new amplitude and phase. The dashed curve is the reference carrier. Labels are Gray: neighbours differ in one bit.')), chips.el) };
}

// ---- 4. a constellation in noise --------------------------------------------------------------------------------------------------

export function constellationWidget(): Widget {
  let kind: Kind = 'qam', M = 16, snrDb = 18, seed = 1, labels = false;
  const N_DRAW = 1500, N_MC = 20000;
  const f = frame(360, 360, [-1.7, 1.7], [-1.7, 1.7], 'I', 'Q', 'Received symbols in noise', 0, 0, { l: 30, r: 10, t: 10, b: 28 });
  const regions = f.svg.appendChild(s('path', { class: 'mdm-regions' })), cloud = f.svg.appendChild(s('path', { class: 'mdm-cloud' })), ideal = f.svg.appendChild(s('path', { class: 'mdm-ideal' })), lab = f.svg.appendChild(s('g'));
  const chips = chipsOf(6), verdict = h('p', { class: 'clk-verdict', role: 'status' });
  const paint = () => {
    const c = constellation(kind, M), snr = dbToRatio(snrDb), sg = Math.sqrt(1 / (2 * snr)), u = rng(seed * 7919 + M);
    let d = '';
    for (let i = 0; i < N_DRAW; i++) {
      const [x, y] = c.pts[Math.floor(u() * M)];
      d += `M${f.X(x + sg * gaussian(u)).toFixed(1)},${f.Y(y + sg * gaussian(u)).toFixed(1)}h0`;
    }
    cloud.setAttribute('d', d);
    ideal.setAttribute('d', c.pts.map(([x, y]) => `M${f.X(x).toFixed(1)},${f.Y(y).toFixed(1)}h0`).join(''));
    // decision boundaries: the grid midway between neighbours (QAM), the rays midway between phases (PSK)
    let r = '';
    if (kind === 'qam') {
      const L = Math.round(Math.sqrt(M));
      for (let i = 1; i < L; i++) { const v = (2 * i - L) * c.dmin; r += `M${f.X(v)},${f.Y(-1.7)}V${f.Y(1.7)}M${f.X(-1.7)},${f.Y(v)}H${f.X(1.7)}`; }
    } else for (let k = 0; k < M; k++) { const a = ((2 * k + 1) * Math.PI) / M; r += `M${f.X(0)},${f.Y(0)}L${f.X(1.7 * Math.cos(a))},${f.Y(1.7 * Math.sin(a))}`; }
    regions.setAttribute('d', r);
    lab.replaceChildren(...(labels && M <= 16 ? c.pts.map(([x, y], i) => s('text', { x: f.X(x), y: f.Y(y) - 8, 'text-anchor': 'middle', class: 'mdm-tl' }, i.toString(2).padStart(bitsOf(M), '0'))) : []));
    const cf = serClosed(kind, M, snr), mc = monteCarlo(c, snrDb, N_MC, seed);
    const need = snrForSer(kind, M, 1e-6), floor = ratioToDb(snrNeeded(bitsOf(M)));
    chips.set(0, `${bitsOf(M)} bits`, 'a symbol');
    chips.set(1, sci(cf), 'symbol errors, closed form');
    chips.set(2, mc.symErrors ? sci(mc.ser) : `< ${sci(1 / N_MC)}`, `measured, ${N_MC / 1000} k symbols`);
    chips.set(3, sci(cf / bitsOf(M)), 'bit errors (Gray)');
    chips.set(4, `${nf(need, 1)} dB`, 'Es/N0 for 1 in 10⁶');
    chips.set(5, `+${nf(need - floor, 1)} dB`, 'above Shannon\'s floor');
    verdict.className = `clk-verdict ${cf < 1e-3 ? 'ok' : 'bad'}`;
    verdict.textContent = cf < 1e-6 ? 'Clean: errors are rarer than a million symbols.' : cf < 1e-3 ? `About one symbol in ${Math.round(1 / cf).toLocaleString('en')} is wrong.` : `One symbol in ${Math.max(1, Math.round(1 / cf))} is wrong: a code on top would have to repair this.`;
  };
  const choice = seg('Modulation', [['p4', 'QPSK'], ['p8', '8-PSK'], ['q16', '16-QAM'], ['q64', '64-QAM'], ['q256', '256-QAM']] as [string, string][], 'q16', (v) => { kind = v[0] === 'p' ? 'psk' : 'qam'; M = Number(v.slice(1)); if (kind === 'psk' && M === 4) kind = 'qam'; paint(); });
  const sl = slider('Es/N0', 0, 35, 0.5, snrDb, (v) => `${nf(v, 1)} dB`, (v) => { snrDb = v; paint(); });
  const roll = h('button', { type: 'button', class: 'btn sm', onclick: () => { seed++; paint(); } }, 'Another draw');
  const tog = h('label', { class: 'comm-check' }, h('input', { type: 'checkbox', onchange: (e: Event) => { labels = (e.target as HTMLInputElement).checked; paint(); } }), 'Show Gray labels (up to 16 points)');
  paint();
  return { el: h('div', { class: 'widget mos comm mdm-w' }, h('div', { class: 'panel' }, h('h3', null, 'Symbols after the channel'), choice, f.svg,
    h('p', { class: 'sub' }, 'Dots: 1500 received symbols; the larger marks are the ideal points; grey lines are the receiver\'s decision boundaries. Es/N0 is the symbol energy over the noise power in the symbol-rate bandwidth. Average symbol energy is 1 for every choice, which is why the points crowd as M grows.')),
  h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row' }, sl.el, roll), tog), chips.el, verdict) };
}

// ---- 5. Shannon against the modems ----------------------------------------------------------------------------------------------

export function milestonesWidget(): Widget {
  let snrDb = 35;
  const B = 3100, W = 600;
  const f = frame(W, 300, [0, 60], [0, 70], 'SNR (dB)', 'kb/s', 'Shannon capacity of 3.1 kHz against the voice-band modems', 10, 10, { l: 44, r: 14, t: 14, b: 34 });
  f.svg.append(s('path', { class: 'cur', d: path(Array.from({ length: 121 }, (_, i): [number, number] => [f.X(i / 2), f.Y(Math.min(70, shannon(B, dbToRatio(i / 2)) / 1000))])) }));
  for (const m of MODEMS.filter((x) => x.id !== 'v90')) {
    const need = ratioToDb(snrNeeded(m.rate / B));
    f.svg.append(s('line', { x1: f.X(0), x2: f.X(Math.min(60, need)), y1: f.Y(m.rate / 1000), y2: f.Y(m.rate / 1000), class: 'mdm-lvl' }),
      s('circle', { cx: f.X(need), cy: f.Y(m.rate / 1000), r: 4.5, class: 'mdm-m' }),
      s('text', { x: f.X(need) + 8, y: f.Y(m.rate / 1000) + 4, class: 'mdm-tl l' }, m.name.replace(' (Bell 212A)', '')));
  }
  const v90 = MODEMS.find((m) => m.id === 'v90')!;
  f.svg.append(s('line', { x1: f.X(0), x2: f.X(60), y1: f.Y(v90.rate / 1000), y2: f.Y(v90.rate / 1000), class: 'mdm-lvl v90' }), s('text', { x: f.X(1), y: f.Y(v90.rate / 1000) - 5, class: 'mdm-tl l' }, 'V.90 down: 56 kb/s, not on this curve'));
  const op = f.svg.appendChild(s('line', { class: 'bound', y1: f.m.t, y2: f.H - f.m.b })), chips = chipsOf(3);
  const tbl = h('table', { class: 'comm-table' }, h('thead', null, h('tr', null, ...['modem', 'rate', 'baud', 'bits / symbol', 'Shannon floor, 3.1 kHz'].map((t) => h('th', null, t)))),
    h('tbody', null, ...MODEMS.map((m) => h('tr', { id: `mdm-${m.id}` }, h('td', null, m.name), h('td', null, fmtRate(m.rate)), h('td', null, `${m.baud}`), h('td', null, nf(bitsPerSymbol(m), m.rate % m.baud ? 1 : 0)),
      h('td', null, m.id === 'v90' ? 'n/a: digital server' : `${nf(ratioToDb(snrNeeded(m.rate / B)), 1)} dB`)))));
  const paint = () => {
    op.setAttribute('x1', String(f.X(snrDb))); op.setAttribute('x2', String(f.X(snrDb)));
    const cap = shannon(B, dbToRatio(snrDb));
    chips.set(0, fmtRate(cap), `capacity at ${snrDb} dB`);
    chips.set(1, `${nf(cap / 1000 / (shannon(B, dbToRatio(snrDb - 3)) / 1000), 2)}×`, '3 dB more SNR: only this much slower');
    chips.set(2, `+${nf(ratioToDb(snrNeeded(v90.rate / B)) - snrDb, 0)} dB`, 'more SNR 56 kb/s would need through 3.1 kHz');
    tbl.querySelectorAll('tr').forEach((tr) => { const m = MODEMS.find((x) => `mdm-${x.id}` === tr.id); if (m) tr.classList.toggle('now', m.id !== 'v90' && m.rate <= cap && !MODEMS.some((o) => o.id !== 'v90' && o.rate <= cap && o.rate > m.rate)); });
  };
  const sl = slider('SNR', 10, 55, 1, snrDb, (v) => `${v} dB`, (v) => { snrDb = v; paint(); });
  paint();
  return { el: h('div', { class: 'widget mos comm mdm-w' }, h('div', { class: 'panel' }, h('h3', null, 'Shannon\'s curve for a 3.1 kHz line'), f.svg,
    h('p', { class: 'sub' }, 'Each dot is where a modem\'s rate meets the curve: the SNR it cannot do without, whatever its modulation. Every one of them ran on a line with more than that. V.90 is a different question, and the line below it is not on the curve.')),
  h('div', { class: 'panel mos-ctl' }, sl.el), chips.el, h('div', { class: 'panel' }, tbl)) };
}

// ---- 6. ADSL ----------------------------------------------------------------------------------------------------------------------

export function adslWidget(): Widget {
  let km = 3, floor = -120, gap = gapDb(1e-7);
  const W = 600, f = frame(W, 250, [32, 256], [0, 16], 'tone (4.3125 kHz apart)', 'bits', 'Bits loaded on each downstream tone', 32, 3, { l: 40, r: 10, t: 12, b: 34 });
  const bars = f.svg.appendChild(s('path', { class: 'mdm-bars' })), snrLine = f.svg.appendChild(s('path', { class: 'bound' }));
  const chips = chipsOf(4);
  const paint = () => {
    const L = bitLoad(km, floor, gap), bw = (f.X(33) - f.X(32)) * 0.8;
    bars.setAttribute('d', DOWN_TONES.map((k, i) => (L.bits[i] ? `M${(f.X(k) + (f.X(k + 1) - f.X(k)) / 2).toFixed(1)},${f.Y(0)}V${f.Y(L.bits[i]).toFixed(1)}` : '')).join(''));
    bars.style.strokeWidth = String(Math.max(1, bw));
    snrLine.setAttribute('d', path(DOWN_TONES.map((k): [number, number] => [f.X(k), f.Y(Math.max(0, Math.min(16, (toneSnrDb(k, km, floor) - gap) / 3.01)))])));
    const used = L.bits.filter(Boolean).length, last = DOWN_TONES.filter((_, i) => L.bits[i]).pop();
    chips.set(0, fmtRate(L.rate), `${L.total} bits × 4000 symbols/s`);
    chips.set(1, `${used} of ${DOWN_TONES.length}`, 'tones with a bit');
    chips.set(2, last ? `${nf((last * ADSL.spacingHz) / 1000, 0)} kHz` : 'none', 'highest tone in use');
    chips.set(3, `${nf(gap, 1)} dB`, 'SNR gap Γ (uncoded, 1 in 10⁷)');
  };
  paint();
  return { el: h('div', { class: 'widget mos comm mdm-w' }, h('div', { class: 'panel' }, h('h3', null, 'One QAM per tone, each as many bits as its SNR allows'), f.svg,
    h('p', { class: 'sub' }, 'Bars: bits on each tone, ⌊log₂(1 + SNR/Γ)⌋ up to 15. Dashed: the unrounded value. Loop and noise model: 20 dB/km at 1 MHz growing as √f, transmit −40 dBm/Hz, a noise floor you set; illustrative, not a G.992.1 test loop.')),
  h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row' },
    slider('Loop', 0.5, 6, 0.1, km, (v) => `${nf(v, 1)} km`, (v) => { km = v; paint(); }).el,
    slider('Noise floor', -140, -100, 1, floor, (v) => `${v} dBm/Hz`, (v) => { floor = v; paint(); }).el,
    slider('Gap Γ', 3, 12, 0.1, gap, (v) => `${nf(v, 1)} dB`, (v) => { gap = v; paint(); }).el)), chips.el) };
}

// ---- the gate-level scenes ----------------------------------------------------------------------------------------------------------

function sample(stage: Stage, port: string, path: string[] = []): number {
  const sim = stage.sim!, node = path.length ? findNode(sim.design.root, path) : sim.design.root;
  return node ? pack(sim.getBits(node.ports[port])) : -1;
}
const tickClock = (stage: Stage): void => {
  const sim = stage.sim!;
  sim.settle(); sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.settle();
};
const scopeLine = (f: ReturnType<typeof frame>, ys: number[]): string => path(ys.map((v, i): [number, number] => [f.X(i), f.Y(v)]));

/** The NCO scene's panel: a tuning word, the samples it makes, the frequency it means. */
const ncoPanel: ScenePanel = (stage: Stage): Widget => {
  const N = 256;
  const f = frame(380, 150, [0, N], [0, 63], 'clock', 'sample', 'The NCO output over 256 clocks', 0, 0, { l: 38, r: 8, t: 8, b: 24 });
  const wave = f.svg.appendChild(s('path', { class: 'wave mdm-sig' })), read = h('div', { class: 'mc-status' }), note = h('p', { class: 'sub' });
  let ys: number[] = [];
  const word = () => sample(stage, 'ftw');
  const run = () => {
    stage.checkpoint();
    ys = [];
    for (let i = 0; i < N; i++) { ys.push(sample(stage, 's')); tickClock(stage); }
    stage.refresh(); paint();
  };
  const paint = () => {
    wave.setAttribute('d', scopeLine(f, ys.map((v) => Math.max(0, v))));
    const w = word(), hz = ncoHz(w);
    read.replaceChildren(h('span', null, 'word ', h('b', null, String(w))), h('span', null, 'f = word · 19 200 / 8192 = ', h('b', null, `${nf(hz, 1)} Hz`)),
      h('span', null, 'step ', h('b', null, `${nf(FS / 2 ** ACC_BITS, 2)} Hz`)));
    const near = [BELL103.originate.space, BELL103.originate.mark, BELL103.answer.space, BELL103.answer.mark].find((t) => tuningWord(t) === w);
    note.textContent = near ? `The nearest word for ${near} Hz, which comes out at ${nf(hz, 1)} Hz.` : `Words per Hz: ${nf(2 ** ACC_BITS / FS, 4)}. Set the word below the clock, or pick a Bell 103 tone.`;
  };
  const btn = (label: string, hz: number) => h('button', { type: 'button', class: 'btn sm', onclick: () => { stage.checkpoint(); stage.sim!.setInput('ftw', tuningWord(hz)); stage.sim!.settle(); stage.refresh(); paint(); } }, label);
  const el = h('div', { class: 'mem-panel cpu-panel mc-panel clk-panel mdm-panel', 'data-dock': 'right' }, h('h4', null, 'The oscillator\'s output', h('span', { class: 'fold-hint' })),
    f.svg, h('div', { class: 'dram-ops' }, h('button', { type: 'button', class: 'btn sm primary', onclick: run }, 'Run 256 clocks'), btn('1070 Hz', 1070), btn('1270 Hz', 1270), btn('2025 Hz', 2025), btn('2225 Hz', 2225)), read, note);
  stage.resetHooks.add(() => { ys = []; paint(); });
  paint();
  return { el, update: paint };
};
export function ncoScene(): Scene {
  return { root: NCO, inputs: { ftw: tuningWord(1070), clk: 0 }, clock: 'clk', autoClock: false, powerOn: 'zero', panels: [ncoPanel] };
}

const MSG = 'Hi';
const toBits = (t: string): number[] => [...t].flatMap((c) => Array.from({ length: 8 }, (_, i) => (c.charCodeAt(0) >> (7 - i)) & 1));
const fromBits = (b: number[]): string => String.fromCharCode(...Array.from({ length: Math.floor(b.length / 8) }, (_, k) => b.slice(k * 8, k * 8 + 8).reduce((a, x) => a * 2 + x, 0)));

/** The link panel: type a message, send it bit by bit through TX → line → RX; hit the line; read what the receiver decided. */
const linkPanel: ScenePanel = (stage: Stage): Widget => {
  const SHOW = 320;
  let sent: number[] = [], got: number[] = [], tx: number[] = [], rxin: number[] = [], dd: number[] = [], hitAt = -1, hitNext = false, timer: ReturnType<typeof setInterval> | null = null, queue: number[] = [], pos = 0;
  const f = frame(380, 170, [0, SHOW], [0, 63], 'clock', '', 'Transmitted and received samples', 0, 0, { l: 12, r: 8, t: 6, b: 22 });
  const fd = frame(380, 70, [0, SHOW], [-0.2, 1.2], 'clock', '', 'The receiver\'s decision', 0, 0, { l: 12, r: 8, t: 4, b: 20 });
  const pt = f.svg.appendChild(s('path', { class: 'mdm-ghost' })), pr = f.svg.appendChild(s('path', { class: 'wave mdm-sig' })), pd = fd.svg.appendChild(s('path', { class: 'wave mdm-dec' }));
  const input = h('input', { class: 'comm-input', value: MSG, maxlength: '4', 'aria-label': 'Message to send (ASCII, up to 4 characters)' }) as HTMLInputElement;
  const status = h('div', { class: 'mc-status' }), out = h('div', { class: 'mdm-out', 'aria-live': 'polite' });
  const reset = () => { stop(); sent = []; got = []; tx = []; rxin = []; dd = []; queue = []; pos = 0; hitAt = -1; paint(); };
  stage.resetHooks.add(reset);
  const drive = (bit: number, hit: number) => { const sim = stage.sim!; sim.setInput('bit', bit); sim.setInput('hit', hit); sim.settle(); };
  /** One clock with the bit at index `pos`: remember the signals and, in the bit's 3/4 point, the receiver's decision. */
  const step = () => {
    const bi = Math.floor(pos / SAMPLES_PER_BIT), ci = pos % SAMPLES_PER_BIT;
    if (ci === 0) sent.push(queue[bi]);
    const hit = bi === hitAt && ci >= 16 && ci < 48 ? 1 : 0;
    drive(queue[bi], hit);
    tx.push(sample(stage, 'tx')); rxin.push(sample(stage, 'rxin'));
    tickClock(stage);
    dd.push(sample(stage, 'd'));
    if (ci === 48) got.push(dd[dd.length - 1]);
    pos++;
    if (pos >= queue.length * SAMPLES_PER_BIT) { stop(); stage.refresh(); }
  };
  const stop = () => { if (timer) clearInterval(timer); timer = null; go.textContent = 'Send'; };
  const start = () => {
    if (timer) { stop(); return; }
    stage.checkpoint();
    const t = input.value.replace(/[^\x20-\x7e]/g, '').slice(0, 4) || MSG;
    input.value = t;
    sent = []; got = []; tx = []; rxin = []; dd = []; pos = 0; queue = [1, 1, ...toBits(t), 1, 1]; // two idle bits (a mark, the line's rest state) in front and behind
    hitAt = hitNext ? 2 + 3 : -1; // the fourth data bit
    go.textContent = 'Stop';
    timer = setInterval(() => { for (let i = 0; i < 24 && timer; i++) step(); paint(); stage.refresh(); }, 40);
  };
  const go = h('button', { type: 'button', class: 'btn sm primary', onclick: start }, 'Send');
  const hitBtn = h('button', { type: 'button', class: 'btn sm', 'aria-pressed': 'false', title: 'Flip the sign of the samples through half of the 4th data bit', onclick: () => { hitNext = !hitNext; hitBtn.setAttribute('aria-pressed', String(hitNext)); } }, 'Hit the line');
  const paint = () => {
    const lo = Math.max(0, tx.length - SHOW), a = tx.slice(lo), b = rxin.slice(lo), c = dd.slice(lo);
    pt.setAttribute('d', scopeLine(f, a)); pr.setAttribute('d', scopeLine(f, b)); pd.setAttribute('d', scopeLine(fd, c));
    const recv = got.slice(2), want = sent.slice(2, 2 + recv.length), errs = recv.filter((x, i) => x !== want[i]).length;
    const text = fromBits(recv.slice(0, Math.max(0, recv.length - (recv.length % 8))));
    status.replaceChildren(h('span', null, 'bits sent ', h('b', null, String(Math.max(0, sent.length - 2)))), h('span', null, 'wrong ', h('b', null, String(errs))));
    out.textContent = sent.length ? `received: ${recv.join('')}${text ? `  "${text}"` : ''}` : 'Type up to four characters and press Send. Bit timing is shared between the two ends here; a real receiver has to recover it from the signal.';
  };
  const el = h('div', { class: 'mem-panel cpu-panel mc-panel clk-panel mdm-panel', 'data-dock': 'right' }, h('h4', null, 'Send a message', h('span', { class: 'fold-hint' })),
    input, h('div', { class: 'dram-ops' }, go, hitBtn), h('div', { class: 'cpu-sec' }, 'Line in (light) and out (dark), then the decision'), f.svg, fd.svg, status, out);
  paint();
  return { el, update: paint, destroy: stop };
};
export function linkScene(): Scene {
  return { root: FSK_LINK, inputs: { bit: 1, hit: 0, clk: 0 }, clock: 'clk', autoClock: false, powerOn: 'zero', hiddenInputs: ['bit', 'hit'], panels: [linkPanel] };
}

