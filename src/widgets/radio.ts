// The Radio chapter's explorers, all on phys/radio.ts: an antenna's pattern and an array, path loss, the link budget, a mixer, a software radio, multipath, fading, diversity. Models,
// labelled as models: there are no gates in this chapter.

import { dbToRatio } from '../comm/limits';
import {
  WALL_DB, apertureM2, arrayDbi, arrayFactor, bpskAwgn, bpskMrc, bpskRayleigh, channelAt, Clarke, coherenceMHz, coherenceTime, delaySpread, dipoleField, dopplerHz, fadeDuration, fsplDb, imageOf, levelCrossing, linkBudget, logDistanceDb, mixed, mixSpectrum, sdrReceive, wavelengthM, widebandLimitMbps, type Ray,
} from '../phys/radio';
import { h, s } from '../ui/dom';
import type { Widget } from '../view/stage';
import { slider } from './mosparts';
import '../styles/radio.css';

const nf = (x: number, d = 1) => x.toFixed(d);
const stat = (label: string, value: string, cls = '') => h('span', null, `${label} `, h('b', { class: cls }, value));
const poly = (pts: [number, number][], cls: string) => s('polyline', { class: cls, points: pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ') });
const txt = (x: number, y: number, t: string, cls = 'rd-t', anchor = 'start') => { const e = s('text', { x, y, class: cls, 'text-anchor': anchor }); e.textContent = t; return e; };
const line = (x1: number, y1: number, x2: number, y2: number, cls: string) => s('line', { x1, y1, x2, y2, class: cls });
const row = (el: Node) => h('div', { class: 'mos-row' }, el);

interface Axes { w: number; h: number; x: (v: number) => number; y: (v: number) => number; g: SVGElement[]; top: number; bottom: number }
function axes(xr: [number, number], yr: [number, number], xt: number[], yt: number[], fmtX: (v: number) => string, fmtY: (v: number) => string, xl: string, yl: string, log = false, W = 560, H = 220): Axes {
  const L = 48, R = 10, T = 24, B = 34;
  const x = (v: number) => L + ((v - xr[0]) / (xr[1] - xr[0])) * (W - L - R);
  const ly = (v: number) => (log ? Math.log10(v) : v);
  const y = (v: number) => T + (1 - (ly(v) - ly(yr[0])) / (ly(yr[1]) - ly(yr[0]))) * (H - T - B);
  const g: SVGElement[] = [];
  for (const v of yt) { g.push(line(L, y(v), W - R, y(v), 'rd-grid')); g.push(txt(L - 5, y(v) + 4, fmtY(v), 'rd-t', 'end')); }
  for (const v of xt) { g.push(line(x(v), T, x(v), H - B, 'rd-grid')); g.push(txt(x(v), H - B + 14, fmtX(v), 'rd-t', 'middle')); }
  g.push(txt(W - R, H - 4, xl, 'rd-t', 'end'), txt(4, 12, yl, 'rd-t'));
  return { w: W, h: H, x, y, g, top: T, bottom: H - B };
}
const svgOf = (a: { w: number; h: number }, label: string, ...kids: SVGElement[]) => s('svg', { class: 'rd-svg', viewBox: `0 0 ${a.w} ${a.h}`, role: 'img', 'aria-label': label }, ...kids);
const clampY = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const selectOf = (label: string, options: [string, string][], value: string, f: (v: string) => void) => {
  const e = h('select', { class: 'mc-sel', 'aria-label': label }, ...options.map(([v, t]) => h('option', { value: v }, t))) as HTMLSelectElement;
  e.value = value;
  e.addEventListener('change', () => f(e.value));
  return e;
};

// ---- the antenna ---------------------------------------------------------------------------------------------------------------
export function antennaWidget(): Widget {
  let n = 1, steer = 0, ghz = 2.4;
  const plot = h('div'), out = h('div', { class: 'mc-status' });
  const paint = () => {
    const W = 340, c = W / 2, R = W / 2 - 16, kids: SVGElement[] = [s('circle', { cx: c, cy: c, r: R, class: 'rd-ring' }), s('circle', { cx: c, cy: c, r: R / 2, class: 'rd-ring' }), line(c, c - R, c, c + R, 'rd-grid'), line(c - R, c, c + R, c, 'rd-grid')];
    const pts: [number, number][] = [];
    // the plane holding the array, angle from broadside; a dipole's own pattern is about its axis, which is vertical here
    for (let d = 0; d <= 360; d += 1) {
      const a = (d * Math.PI) / 180, el = n === 1 ? dipoleField(a) : arrayFactor(n, 0.5, steer, d - 90) * Math.abs(Math.sin(a));
      const rr = R * Math.abs(el);
      pts.push([c + rr * Math.sin(a), c - rr * Math.cos(a)]);
    }
    kids.push(poly(pts, 'rd-l1'));
    plot.replaceChildren(s('svg', { class: 'rd-svg sq', viewBox: `0 0 ${W} ${W}`, role: 'img', 'aria-label': `Radiation pattern of ${n} element${n > 1 ? 's' : ''}` }, ...kids));
    const gainArr = arrayDbi(n, steer), lam = wavelengthM(ghz);
    out.replaceChildren(stat('Wavelength', `${nf(lam * 100, 1)} cm`), stat('Half-wave dipole', `${nf(lam * 50, 1)} cm long`), stat('Gain', `${nf(gainArr, 1)} dBi`), stat('Effective aperture', `${nf(apertureM2(gainArr, ghz) * 1e4, 0)} cm²`), n > 1 && steer === 0 ? stat('First null at broadside', `±${nf((Math.asin(Math.min(1, 2 / n)) * 180) / Math.PI, 0)}°`) : n > 1 ? stat('Beam', `steered to ${steer}°`) : stat('Beam', 'all round the axis'));
  };
  const a = slider('Elements', 1, 16, 1, n, (v) => String(v), (v) => { n = v; paint(); });
  const b = slider('Steering', -60, 60, 5, steer, (v) => `${v}°`, (v) => { steer = v; paint(); });
  const c = slider('Frequency', 0.8, 28, 0.2, ghz, (v) => `${nf(v, 1)} GHz`, (v) => { ghz = v; paint(); });
  paint();
  return { el: h('div', { class: 'widget mos rd-w' }, row(a.el), row(b.el), row(c.el), plot, out, h('p', { class: 'sub' }, 'Half-wavelength spacing; elements fed with a phase step to steer. Field strength, not dB.')) };
}

// ---- path loss --------------------------------------------------------------------------------------------------------------------
export function pathWidget(): Widget {
  let ghz = 2.4, nExp = 3.5, tx = 20;
  const plot = h('div'), out = h('div', { class: 'mc-status' });
  const paint = () => {
    const a = axes([0, 4], [-120, 20], [0, 1, 2, 3, 4], [-100, -60, -20, 20], (v) => `${10 ** v} m`.replace('10000 m', '10 km').replace('1000 m', '1 km'), (v) => String(v), 'distance (log)', 'dBm received');
    const free: [number, number][] = [], ind: [number, number][] = [];
    for (let d = 0; d <= 4; d += 0.05) {
      const m = 10 ** d;
      free.push([a.x(d), a.y(clampY(tx - fsplDb(m / 1000, ghz), -120, 20))]);
      ind.push([a.x(d), a.y(clampY(tx - logDistanceDb(m, ghz, nExp), -120, 20))]);
    }
    plot.replaceChildren(svgOf(a, 'Received power against distance', ...a.g, poly(free, 'rd-l2'), poly(ind, 'rd-l1'), txt(a.x(3.2), a.y(tx - fsplDb(10 ** 3.2 / 1000, ghz)) - 6, 'free space', 'rd-t rd-c2')));
    out.replaceChildren(stat('Free space at 100 m', `${nf(fsplDb(0.1, ghz), 1)} dB`), stat(`With n = ${nExp}`, `${nf(logDistanceDb(100, ghz, nExp), 1)} dB`), stat('Each doubling', `${nf(3.01 * nExp, 1)} dB`), stat('Aperture of a 0 dBi antenna', `${nf(apertureM2(0, ghz) * 1e4, 1)} cm²`));
  };
  const f = slider('Frequency', 0.4, 60, 0.1, ghz, (v) => `${nf(v, 1)} GHz`, (v) => { ghz = v; paint(); });
  const n = slider('Exponent n', 2, 5, 0.1, nExp, (v) => nf(v, 1), (v) => { nExp = v; paint(); });
  const t = slider('Transmit power', 0, 40, 1, tx, (v) => `${v} dBm`, (v) => { tx = v; paint(); });
  paint();
  return { el: h('div', { class: 'widget mos rd-w' }, row(f.el), row(n.el), row(t.el), plot, out) };
}

// ---- the link budget ---------------------------------------------------------------------------------------------------------------
export { WALL_DB };
export const BUDGET_DEFAULT = { tx: 20, ga: 2, nf: 6, m: 50, walls: 2, ghz: 2.4, mhz: 20 };
export function budgetWidget(): Widget {
  let { tx, ga, m, walls, ghz, mhz } = BUDGET_DEFAULT;
  const nfdb = BUDGET_DEFAULT.nf;
  const plot = h('div'), out = h('div', { class: 'mc-status' });
  const paint = () => {
    const wall = walls * WALL_DB(ghz), b = linkBudget({ txDbm: tx, gtDbi: ga, grDbi: ga, km: m / 1000, ghz, extraDb: wall, mhz, nfDb: nfdb });
    const st: [string, number][] = [['Transmitter', tx], ['Antenna', b.eirp], ['Path', b.eirp - b.path], ['Walls', b.eirp - b.path - wall], ['Received', b.rx]];
    const a = axes([0, 5], [-130, 40], [], [-120, -80, -40, 0, 40], () => '', (v) => String(v), '', 'dBm');
    const x = (i: number) => a.x(i + 0.5), pts = st.map(([, v], i) => [x(i), a.y(clampY(v, -130, 40))] as [number, number]);
    const dots = st.flatMap(([n, v], i) => [s('circle', { cx: x(i), cy: pts[i][1], r: 4.5, class: 'rd-dot' }), txt(x(i), pts[i][1] - 9, nf(v, 1), 'rd-t rd-strong', 'middle'), txt(x(i), a.h - 18, n, 'rd-t', 'middle')]);
    const ny = a.y(clampY(b.noise, -130, 40));
    plot.replaceChildren(svgOf(a, `Signal at each stage; received ${nf(b.rx, 1)} dBm, noise floor ${nf(b.noise, 1)} dBm`, ...a.g, poly(pts, 'rd-l1'), line(48, ny, a.w - 10, ny, 'rd-need'), txt(52, ny - 5, `noise floor ${nf(b.noise, 1)} dBm`, 'rd-t rd-c3'), ...dots));
    out.replaceChildren(stat('Path loss', `${nf(b.path, 1)} dB`), stat('SNR', `${nf(b.snr, 1)} dB`, b.snr < 5 ? 'bad' : ''), stat('Shannon limit', b.capacityMbps >= 1000 ? `${nf(b.capacityMbps / 1000, 2)} Gb/s` : `${nf(b.capacityMbps, 0)} Mb/s`), stat('Wide-band limit', `${nf(widebandLimitMbps(b.rx, nfdb) / 1000, 1)} Gb/s`));
  };
  const a = slider('Range', 1, 300, 1, m, (v) => `${v} m`, (v) => { m = v; paint(); });
  const b = slider('Walls', 0, 6, 1, walls, (v) => String(v), (v) => { walls = v; paint(); });
  const c = slider('Transmit power', 0, 30, 1, tx, (v) => `${v} dBm`, (v) => { tx = v; paint(); });
  const d = slider('Antenna gain each', 0, 15, 1, ga, (v) => `${v} dBi`, (v) => { ga = v; paint(); });
  const band = selectOf('Band', [['2.4', '2.4 GHz'], ['5.5', '5.5 GHz'], ['6.5', '6.5 GHz']], '2.4', (v) => { ghz = Number(v); paint(); });
  const chan = selectOf('Channel', [['20', '20 MHz'], ['40', '40 MHz'], ['80', '80 MHz'], ['160', '160 MHz']], '20', (v) => { mhz = Number(v); paint(); });
  paint();
  return { el: h('div', { class: 'widget mos rd-w' }, h('div', { class: 'dram-ops' }, band, chan), row(a.el), row(b.el), row(c.el), row(d.el), plot, out, h('p', { class: 'sub' }, `Illustrative: ${nfdb} dB noise figure, ${WALL_DB(2.4)} dB a wall at 2.4 GHz and ${WALL_DB(5.5)} dB above 3 GHz. Free space otherwise.`)) };
}

// ---- a mixer -----------------------------------------------------------------------------------------------------------------------
export function mixerWidget(): Widget {
  let f = 340, lo = 300, image = false;
  const plot = h('div'), out = h('div', { class: 'mc-status' });
  const paint = () => {
    const fs = 1024, ins = image ? [f, imageOf(f, lo)] : [f], sp = mixSpectrum(ins, lo, fs), N = sp.length;
    const a = axes([0, 512], [0, 1.2], [0, 100, 200, 300, 400, 500], [0, 0.5, 1], (v) => String(v), (v) => String(v), 'frequency', 'amplitude');
    const bars: SVGElement[] = [];
    for (let k = 0; k < N; k++) if (sp[k] > 0.02) bars.push(line(a.x(k), a.y(0), a.x(k), a.y(Math.min(1.2, sp[k])), 'rd-bar'));
    const marks = [line(a.x(lo), a.top, a.x(lo), a.bottom, 'rd-need'), txt(a.x(lo) + 3, a.top + 12, 'LO', 'rd-t'), line(a.x(f), a.top, a.x(f), a.bottom, 'rd-mark'), txt(a.x(f) + 3, a.top + 24, 'signal', 'rd-t')];
    plot.replaceChildren(svgOf(a, 'Output spectrum of the mixer', ...a.g, ...marks, ...bars));
    const [d, su] = mixed(f, lo), im = imageOf(f, lo);
    out.replaceChildren(stat('Difference, the IF', String(d)), stat('Sum', su > 512 ? `${su}, aliases in this sampling` : String(su)), stat('Image', im > 0 ? String(im) : 'none in range', image ? 'bad' : ''), image ? stat('Both land on', String(d), 'bad') : h('span'));
  };
  const a = slider('Signal', 100, 480, 4, f, (v) => String(v), (v) => { f = v; paint(); });
  const b = slider('Local oscillator', 100, 480, 4, lo, (v) => String(v), (v) => { lo = v; paint(); });
  const box = h('input', { type: 'checkbox' }) as HTMLInputElement;
  box.addEventListener('change', () => { image = box.checked; paint(); });
  paint();
  return { el: h('div', { class: 'widget mos rd-w' }, row(a.el), row(b.el), h('label', { class: 'rd-box' }, box, ' A station on the image too'), plot, out, h('p', { class: 'sub' }, 'A sampled multiplication of two cosines, its FFT shown. Frequencies in arbitrary units.')) };
}

// ---- a software radio -------------------------------------------------------------------------------------------------------------
const SDR_STATIONS = [{ offset: -5, amp: 0.7, seed: 11 }, { offset: -2, amp: 1, seed: 12 }, { offset: 3, amp: 3, seed: 13 }, { offset: 6, amp: 0.5, seed: 14 }];
export function sdrWidget(): Widget {
  let tune = -2, snr = 8;
  const plot = h('div'), iq = h('div', { class: 'rd-sq' }), out = h('div', { class: 'mc-status' });
  const paint = () => {
    const r = sdrReceive(SDR_STATIONS, tune, { symbols: 512, decim: 8, sps: 2, snrDb: snr, seed: 4 });
    const N = r.spectrum.length, a = axes([-8, 8], [0, 3.5], [-8, -4, 0, 4, 8], [0, 1, 2, 3], (v) => String(v), (v) => String(v), 'cycles a symbol', 'relative level');
    const pts = r.spectrum.map((v, k) => [a.x(((k - N / 2) / N) * 16), a.y(Math.min(3.5, v * 14))] as [number, number]);
    plot.replaceChildren(svgOf(a, 'The band the ADC sees, four stations', ...a.g, poly(pts, 'rd-l1'), line(a.x(tune), a.top, a.x(tune), a.bottom, 'rd-need'), txt(a.x(tune) + 3, a.top + 12, 'tuned', 'rd-t')));
    const W = 220, c = W / 2, g = W / 2 - 14, dots: SVGElement[] = [line(c, 6, c, W - 6, 'rd-grid'), line(6, c, W - 6, c, 'rd-grid')];
    r.bb.forEach(([x, y], i) => { if (Math.abs(x) < 2 && Math.abs(y) < 2) dots.push(s('circle', { cx: c + (x * g) / 2, cy: c - (y * g) / 2, r: 1.5, class: x * r.sent[i] > 0 ? 'rd-pt' : 'rd-pt bad' })); });
    iq.replaceChildren(s('svg', { class: 'rd-svg sq', viewBox: `0 0 ${W} ${W}`, role: 'img', 'aria-label': `Received symbols, ${r.errors} wrong of ${r.bits}` }, ...dots));
    const hit = SDR_STATIONS.some((st) => st.offset === tune);
    out.replaceChildren(stat('Tuned to', `${tune > 0 ? '+' : ''}${tune}`, hit ? 'good' : 'bad'), stat('Wrong', `${r.errors} of ${r.bits}`, r.ber > 0.1 ? 'bad' : ''), stat('Decimated', `${r.decim * 2} samples to 1`));
  };
  const a = slider('Tune', -8, 8, 0.5, tune, (v) => String(v), (v) => { tune = v; paint(); });
  const b = slider('SNR of a unit station', 0, 25, 1, snr, (v) => `${v} dB`, (v) => { snr = v; paint(); });
  paint();
  return { el: h('div', { class: 'widget mos rd-w' }, row(a.el), row(b.el), plot, iq, out, h('p', { class: 'sub' }, 'BPSK stations, one ADC. Everything after the ADC is arithmetic: multiply, average, slice.')) };
}

// ---- multipath -----------------------------------------------------------------------------------------------------------------------
export function multipathWidget(): Widget {
  let d1 = 40, a1 = 0.7, d2 = 200, a2 = 0.4, bwMhz = 20;
  const plot = h('div'), out = h('div', { class: 'mc-status' });
  const rays = (): Ray[] => [{ ns: 0, amp: 1, phase: 0 }, { ns: d1, amp: a1, phase: 0 }, { ns: d2, amp: a2, phase: 0 }];
  const paint = () => {
    const r = rays(), span = 40, a = axes([-span, span], [-30, 10], [-40, -20, 0, 20, 40], [-30, -20, -10, 0, 10], (v) => String(v), (v) => String(v), 'MHz from the carrier', 'dB');
    const pts: [number, number][] = [];
    let worst = 99, best = -99;
    for (let m = -span; m <= span; m += 0.1) {
      const c = channelAt(r, m), db = 20 * Math.log10(Math.max(1e-3, Math.hypot(c.re, c.im)));
      pts.push([a.x(m), a.y(clampY(db, -30, 10))]);
      if (Math.abs(m) <= bwMhz / 2) { worst = Math.min(worst, db); best = Math.max(best, db); }
    }
    const band = s('rect', { x: a.x(-bwMhz / 2), y: a.top, width: a.x(bwMhz / 2) - a.x(-bwMhz / 2), height: a.bottom - a.top, class: 'rd-band' });
    plot.replaceChildren(svgOf(a, 'The channel\'s gain against frequency', band, ...a.g, poly(pts, 'rd-l1')));
    const tau = delaySpread(r), bc = coherenceMHz(tau), sym = 1000 / bwMhz;
    out.replaceChildren(stat('Delay spread', `${nf(tau, 0)} ns`), stat('Coherence bandwidth', tau > 0 ? `${nf(bc, 1)} MHz` : 'no echoes'), stat('Across the channel', `${nf(best - worst, 1)} dB`, best - worst > 10 ? 'bad' : ''), stat('Symbol time', `${nf(sym, 0)} ns`), stat('Echo reaches', `${nf(Math.max(d1, d2) / sym, 1)} symbols`, Math.max(d1, d2) > sym ? 'bad' : ''));
  };
  const s1 = slider('Echo 1 delay', 0, 500, 5, d1, (v) => `${v} ns`, (v) => { d1 = v; paint(); });
  const s2 = slider('Echo 1 gain', 0, 1, 0.05, a1, (v) => nf(v, 2), (v) => { a1 = v; paint(); });
  const s3 = slider('Echo 2 delay', 0, 1000, 5, d2, (v) => `${v} ns`, (v) => { d2 = v; paint(); });
  const s4 = slider('Echo 2 gain', 0, 1, 0.05, a2, (v) => nf(v, 2), (v) => { a2 = v; paint(); });
  const s5 = slider('Channel width', 1, 80, 1, bwMhz, (v) => `${v} MHz`, (v) => { bwMhz = v; paint(); });
  paint();
  return { el: h('div', { class: 'widget mos rd-w' }, row(s1.el), row(s2.el), row(s3.el), row(s4.el), row(s5.el), plot, out) };
}

// ---- fading ---------------------------------------------------------------------------------------------------------------------------
export function fadingWidget(): Widget {
  let kmh = 50, ghz = 2.4;
  const plot = h('div'), out = h('div', { class: 'mc-status' });
  const paint = () => {
    const fd = dopplerHz(kmh, ghz), g = new Clarke(fd, 9), Tms = fd > 0 ? Math.min(1000, Math.round(20000 / fd)) : 1000, rho = Math.sqrt(0.1);
    const a = axes([0, Tms], [-40, 10], [0, 0.25, 0.5, 0.75, 1].map((f) => f * Tms), [-40, -30, -20, -10, 0, 10], (v) => nf(v, Tms < 20 ? 1 : 0), (v) => String(v), 'ms', 'dB');
    const pts: [number, number][] = [];
    const steps = 800;
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * (Tms / 1000), c = g.at(t), db = 20 * Math.log10(Math.max(1e-3, Math.hypot(c.re, c.im)));
      pts.push([a.x((i / steps) * Tms), a.y(clampY(db, -40, 10))]);
    }
    plot.replaceChildren(svgOf(a, `A faded signal at ${kmh} km/h`, ...a.g, poly(pts, 'rd-l1')));
    out.replaceChildren(stat('Doppler', `${nf(dopplerHz(kmh, ghz), 0)} Hz`), ...(fd > 0 ? [stat('Coherence time', `${nf(coherenceTime(fd) * 1000, 1)} ms`), stat('Fades below −10 dB', `${nf(levelCrossing(rho, fd), 1)} a second`), stat('Lasting', `${nf(fadeDuration(rho, fd) * 1000, 1)} ms`)] : [stat('Standing still', 'no fading in time', 'good')]));
  };
  const a = slider('Speed', 0, 300, 5, kmh, (v) => `${v} km/h`, (v) => { kmh = v; paint(); });
  const b = slider('Carrier', 0.7, 28, 0.1, ghz, (v) => `${nf(v, 1)} GHz`, (v) => { ghz = v; paint(); });
  paint();
  return { el: h('div', { class: 'widget mos rd-w' }, row(a.el), row(b.el), plot, out, h('p', { class: 'sub' }, 'Clarke\'s model: rays arriving from all round, summed. Power is 1 on average; 0 dB is the mean.')) };
}

// ---- BER: fading and diversity ------------------------------------------------------------------------------------------------------
export function diversityWidget(): Widget {
  let L = 2;
  const plot = h('div'), out = h('div', { class: 'mc-status' });
  const paint = () => {
    const a = axes([0, 30], [1e-6, 1], [0, 10, 20, 30], [1, 1e-2, 1e-4, 1e-6], (v) => String(v), (v) => (v === 1 ? '1' : v.toExponential(0).replace('e-', 'e−')), 'mean SNR, dB', 'BER', true);
    const curve = (f: (snr: number) => number, cls: string) => {
      const pts: [number, number][] = [];
      for (let d = 0; d <= 30; d += 0.5) { const v = f(dbToRatio(d)); if (v >= 1e-6) pts.push([a.x(d), a.y(v)]); }
      return poly(pts, cls);
    };
    plot.replaceChildren(svgOf(a, 'BER against SNR', ...a.g, curve(bpskAwgn, 'rd-l2'), curve(bpskRayleigh, 'rd-l3'), curve((x) => bpskMrc(x, L), 'rd-l1'), txt(a.x(7), a.y(1e-5), 'no fading', 'rd-t rd-c2'), txt(a.x(21), a.y(5e-3) - 4, 'one antenna', 'rd-t rd-c3')));
    const need = (f: (x: number) => number) => { let lo = -5, hi = 60; for (let i = 0; i < 50; i++) { const m = (lo + hi) / 2; if (f(dbToRatio(m)) > 1e-3) lo = m; else hi = m; } return (lo + hi) / 2; };
    out.replaceChildren(stat('For BER 10⁻³, no fading', `${nf(need(bpskAwgn), 1)} dB`), stat('One antenna', `${nf(need(bpskRayleigh), 1)} dB`), stat(`${L} antennas`, `${nf(need((x) => bpskMrc(x, L)), 1)} dB`, 'good'));
  };
  const a = slider('Receive antennas', 1, 8, 1, L, (v) => String(v), (v) => { L = v; paint(); });
  paint();
  return { el: h('div', { class: 'widget mos rd-w' }, row(a.el), plot, out, h('p', { class: 'sub' }, 'BPSK, coherent, independent branches combined by their strengths; SNR per branch.')) };
}
