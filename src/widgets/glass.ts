// "Light in glass" explorers, all on phys/fibre.ts: loss against wavelength, a ray in a core, modes, a pulse spreading, wavelength channels, an amplifier chain, a coherent
// receiver's constellation, and the budget of an ocean. Models, labelled as models: there are no gates in this chapter.

import { shannon } from '../comm/limits';
import {
  acceptanceDeg, ANCHOR_THZ, beta2Of, bestPower, C_BAND, cdTaps, coherentLink, criticalDeg, dispersionD, dispersionLength, FEC_RATE, gaussianWidth, gradedDelayPsKm, gridChannels, infraredDb, L_BAND, lossDb, maxSpans, MMF_50, modesAt, modesLarge, n2Of, naOf, nmOf, osnrDb,
  QAMS, rayleighDb, rayOf, reachNarrowKm, reachWideKm, requiredSnrDb, SMF_G652, snrFromOsnr, snrWithNli, stepDelayPsKm, vNumber, waterDb, WINDOWS,
} from '../phys/fibre';
import { h, s } from '../ui/dom';
import type { Widget } from '../view/stage';
import { slider } from './mosparts';
import '../styles/glass.css';
import { groupNum } from '../sim/numfmt';

const nf = (x: number, d = 1) => x.toFixed(d);
const stat = (label: string, value: string, cls = '') => h('span', null, `${label} `, h('b', { class: cls }, value));
const poly = (pts: [number, number][], cls: string) => s('polyline', { class: cls, points: pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ') });
const txt = (x: number, y: number, t: string, cls = 'gl-t', anchor = 'start') => { const e = s('text', { x, y, class: cls, 'text-anchor': anchor }); e.textContent = t; return e; };
const line = (x1: number, y1: number, x2: number, y2: number, cls: string) => s('line', { x1, y1, x2, y2, class: cls });

interface Axes { w: number; h: number; x: (v: number) => number; y: (v: number) => number; g: SVGElement[] }
function axes(xr: [number, number], yr: [number, number], xt: number[], yt: number[], fmtX: (v: number) => string, fmtY: (v: number) => string, xl: string, yl: string, log = false, W = 560, H = 230): Axes {
  const L = 44, R = 10, T = 24, B = 34;
  const x = (v: number) => L + ((v - xr[0]) / (xr[1] - xr[0])) * (W - L - R);
  const ly = (v: number) => (log ? Math.log10(v) : v);
  const y = (v: number) => T + (1 - (ly(v) - ly(yr[0])) / (ly(yr[1]) - ly(yr[0]))) * (H - T - B);
  const g: SVGElement[] = [];
  for (const v of yt) { g.push(line(L, y(v), W - R, y(v), 'gl-grid')); g.push(txt(L - 5, y(v) + 4, fmtY(v), 'gl-t', 'end')); }
  for (const v of xt) { g.push(line(x(v), T, x(v), H - B, 'gl-grid')); g.push(txt(x(v), H - B + 14, fmtX(v), 'gl-t', 'middle')); }
  g.push(txt(W - R, H - 4, xl, 'gl-t', 'end'), txt(4, 10, yl, 'gl-t'));
  return { w: W, h: H, x, y, g };
}
const svgOf = (a: { w: number; h: number }, label: string, ...kids: SVGElement[]) => s('svg', { class: 'gl-svg', viewBox: `0 0 ${a.w} ${a.h}`, role: 'img', 'aria-label': label }, ...kids);

// ---- loss ---------------------------------------------------------------------------------------------------------------------
export function lossWidget(): Widget {
  let um = 1.55, km = 100, peak = 0.35;
  const plot = h('div'), out = h('div', { class: 'mc-status' });
  const paint = () => {
    const a = axes([0.7, 1.75], [0.05, 10], [0.8, 1, 1.2, 1.4, 1.6], [0.1, 1, 10], (v) => `${(v * 1000).toFixed(0)}`, (v) => String(v), 'wavelength, nm', 'dB/km', true);
    const curve = (f: (u: number) => number, cls: string) => {
      const pts: [number, number][] = [];
      for (let u = 0.7; u <= 1.75; u += 0.004) { const v = f(u); if (v >= 0.05 && v <= 10) pts.push([a.x(u), a.y(v)]); }
      return poly(pts, cls);
    };
    const marks = WINDOWS.flatMap((w) => [line(a.x(w.nm / 1000), 24, a.x(w.nm / 1000), a.h - 34, 'gl-win'), txt(a.x(w.nm / 1000) + 3, 22, w.name, 'gl-t')]);
    plot.replaceChildren(svgOf(a, `Fibre loss against wavelength; at ${nf(um * 1000, 0)} nm it is ${nf(lossDb(um, peak), 2)} dB per km`, ...a.g, ...marks, curve(rayleighDb, 'gl-l2'), curve(infraredDb, 'gl-l3'), curve((u) => lossDb(u, peak), 'gl-l1'), line(a.x(um), 24, a.x(um), a.h - 34, 'gl-cur'),
      txt(a.x(0.78), a.y(2.4) - 2, 'scattering', 'gl-t gl-c2'), txt(a.x(1.62), a.y(1.3), 'infrared', 'gl-t gl-c3')));
    const db = lossDb(um, peak) * km, left = 10 ** (-db / 10);
    out.replaceChildren(stat('Loss', `${nf(lossDb(um, peak), 2)} dB/km`), stat(`After ${km} km`, `${nf(db, 1)} dB`), stat('Left', left >= 1e-3 ? `${nf(left * 100, left < 0.01 ? 3 : 1)} %` : `1 part in ${left > 1e-30 ? (1 / left).toExponential(0) : '10³⁰⁺'}`), stat('Water line alone', `${nf(waterDb(um, peak), 2)} dB/km`));
  };
  const a = slider('Wavelength', 750, 1700, 5, 1550, (v) => `${v} nm`, (v) => { um = v / 1000; paint(); });
  const b = slider('Distance', 1, 200, 1, km, (v) => `${v} km`, (v) => { km = v; paint(); });
  const c = slider('Water peak', 0, 0.6, 0.05, peak, (v) => `${nf(v, 2)} dB/km`, (v) => { peak = v; paint(); });
  paint();
  return { el: h('div', { class: 'widget mos gl-w' }, h('div', { class: 'mos-row' }, a.el), h('div', { class: 'mos-row' }, b.el), h('div', { class: 'mos-row' }, c.el), plot, out) };
}

// ---- a ray in a core --------------------------------------------------------------------------------------------------------------
export function rayWidget(): Widget {
  let deg = 6, deltaPct = 0.34;
  const plot = h('div'), out = h('div', { class: 'mc-status' });
  const n1 = 1.46;
  const paint = () => {
    const n2 = n1 * (1 - deltaPct / 100), na = naOf(n1, n2), r = rayOf(deg, n1, n2), W = 560, H = 150, T = 40, B = 110, x0 = 40;
    const core = s('rect', { x: x0, y: T, width: W - x0 - 10, height: B - T, class: 'gl-core' });
    const pts: [number, number][] = [[4, (T + B) / 2 - Math.tan((deg * Math.PI) / 180) * (x0 - 4)], [x0, (T + B) / 2]];
    const slope = Math.tan((r.coreDeg * Math.PI) / 180);
    // the scale across is stretched so that the small angles can be seen; the ray's bounces are true to the angle
    const across = 6;
    let x = x0, y = (T + B) / 2, dir = 1;
    while (x < W - 10) {
      const wall = dir > 0 ? T : B, dx = slope > 1e-6 ? Math.abs(y - wall) / (slope * across) : 1e4, nx = Math.min(W - 10, x + dx), ny = y - dir * (nx - x) * slope * across;
      pts.push([nx, ny]);
      if (nx >= W - 10) break;
      if (!r.guided) { pts.push([nx + 40, ny - dir * 60]); break; }
      x = nx; y = ny; dir = -dir;
    }
    plot.replaceChildren(s('svg', { class: 'gl-svg', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': r.guided ? 'The ray bounces along the core' : 'The ray leaves through the cladding' },
      s('rect', { x: x0, y: T - 22, width: W - x0 - 10, height: B - T + 44, class: 'gl-clad' }), core, txt(x0 + 6, T - 8, `cladding, n = ${nf(n2, 4)}`), txt(W - 90, B - 6, `core, n = ${n1}`), poly(pts, r.guided ? 'gl-ray' : 'gl-ray bad')));
    const delay = (r.stretch - 1) * n1 * 1e12 / 299792.458;
    out.replaceChildren(stat('Critical angle', `${nf(criticalDeg(n1, n2), 2)}°`), stat('NA', nf(na, 3)), stat('Accepted from air', `±${nf(acceptanceDeg(na), 1)}°`), stat('This ray', r.guided ? 'stays in' : 'leaks out', r.guided ? 'good' : 'bad'), r.guided ? stat('Longer path', `${nf((r.stretch - 1) * 100, 3)} %`) : h('span'), r.guided ? stat('Arrives late by', `${nf(delay / 1000, 1)} ns/km`) : h('span'));
  };
  const a = slider('Launch angle in air', 0, 25, 0.5, deg, (v) => `${v}°`, (v) => { deg = v; paint(); });
  const b = slider('Index step Δ', 0.2, 2, 0.02, deltaPct, (v) => `${nf(v, 1)} %`, (v) => { deltaPct = v; paint(); });
  paint();
  return { el: h('div', { class: 'widget mos gl-w' }, h('div', { class: 'mos-row' }, a.el), h('div', { class: 'mos-row' }, b.el), plot, out, h('p', { class: 'sub' }, 'Drawn six times taller than it is: the real angles are very small.')) };
}

// ---- modes ------------------------------------------------------------------------------------------------------------------------
export function modesWidget(): Widget {
  let a = 4, um = 1.55, dp = 0.34;
  const out = h('div', { class: 'gl-out' });
  const paint = () => {
    const f = { n1: 1.46, delta: dp / 100 }, na = naOf(f.n1, n2Of(f)), v = vNumber(a, na, um), mm = modesAt(v), listed = mm.reduce((t, m) => t + m.count, 0);
    out.replaceChildren(
      h('div', { class: 'mc-status' }, stat('NA', nf(na, 3)), stat('V', nf(v, 2)), stat('Modes', v > 8 ? `≈ ${nf(modesLarge(v), 0)}` : `${listed}, counting polarizations`), v < 2.405 ? stat('Single mode', 'yes', 'good') : stat('Single mode', 'no', 'bad'), stat('Step core spread', `${nf(stepDelayPsKm(f) / 1000, 2)} ns/km`), stat('Parabolic core', `${nf(gradedDelayPsKm(f), 0)} ps/km`)),
      h('div', { class: 'gl-modes' }, ...(v > 8 ? [h('span', { class: 'gl-mode on' }, `too many to list: V²/2 ≈ ${nf(modesLarge(v), 0)}`)] : mm.map((m) => h('span', { class: 'gl-mode on', title: `cutoff V = ${m.cutoff}` }, `${m.name} ×${m.count}`)))),
    );
  };
  const sa = slider('Core radius', 2, 31, 0.5, a, (v) => `${nf(v, 1)} µm`, (v) => { a = v; paint(); });
  const su = slider('Wavelength', 800, 1650, 10, 1550, (v) => `${v} nm`, (v) => { um = v / 1000; paint(); });
  const sd = slider('Index step Δ', 0.2, 1.5, 0.02, dp, (v) => `${nf(v, 2)} %`, (v) => { dp = v; paint(); });
  const preset = (label: string, ra: number, d: number, nm: number) => { const b = h('button', { class: 'btn sm', type: 'button' }, label); b.addEventListener('click', () => { a = ra; dp = d; um = nm / 1000; sa.set(ra); sd.set(d); su.set(nm); paint(); }); return b; };
  paint();
  return { el: h('div', { class: 'widget mos gl-w' }, h('div', { class: 'dram-ops' }, preset('Single-mode, 1550 nm', SMF_G652.aUm, SMF_G652.delta * 100, 1550), preset('Same, 850 nm', SMF_G652.aUm, SMF_G652.delta * 100, 850), preset('50 µm multimode', MMF_50.aUm, MMF_50.delta * 100, 850)), h('div', { class: 'mos-row' }, sa.el), h('div', { class: 'mos-row' }, su.el), h('div', { class: 'mos-row' }, sd.el), out) };
}

// ---- a pulse spreading --------------------------------------------------------------------------------------------------------------
export function pulseWidget(): Widget {
  let gbps = 10, km = 40, nm = 1550;
  const plot = h('div'), out = h('div', { class: 'mc-status' });
  const paint = () => {
    const D = dispersionD(nm), b2 = beta2Of(D, nm), bit = 1000 / gbps, t0 = 0.3 * bit, t1 = gaussianWidth(t0, b2, km);
    const pattern = [1, 0, 1, 1, 0, 1, 0, 0, 1], span = pattern.length * bit;
    const a = axes([0, span], [0, 1.3], pattern.map((_, i) => i * bit), [0, 0.5, 1], (v) => Math.round(v / bit) % 2 === 0 ? `${Math.round(v / bit)}` : '', (v) => String(v), 'bits', 'intensity', false);
    const at = (t: number, w: number, amp: number) => pattern.reduce((sum, b, i) => sum + (b ? amp * Math.exp(-(((t - (i + 0.5) * bit) / w) ** 2)) : 0), 0);
    const pts = (w: number, amp: number) => Array.from({ length: 280 }, (_, i) => { const t = (i / 279) * span; return [a.x(t), a.y(Math.min(1.3, at(t, w, amp)))] as [number, number]; });
    plot.replaceChildren(svgOf(a, `A pulse pattern before and after ${km} km`, ...a.g, poly(pts(t0, 1), 'gl-l2'), poly(pts(t1, t0 / t1), 'gl-l1')));
    const closed = 4 * (t1 / Math.SQRT2) > bit;   // the same rule as the reach below: an rms width over a quarter of a bit
    const flat = Math.abs(D) < 0.01;
    out.replaceChildren(stat('D', `${nf(D, 1)} ps/(nm·km)`), stat('β₂', `${nf(b2, 1)} ps²/km`), stat('Bit', `${nf(bit, 1)} ps`), stat('Pulse', `${nf(t0, 1)} → ${nf(t1, 1)} ps`, closed ? 'bad' : ''), stat('Doubles in width after', flat ? 'no limit from D' : `${nf(dispersionLength(t0, b2) * Math.sqrt(3), 1)} km`), stat('Clean laser reach', flat ? 'no limit from D' : `${nf(reachNarrowKm(gbps, b2), 0)} km`), stat('1 nm wide source', flat ? 'no limit from D' : `${nf(reachWideKm(gbps, D, 1), 1)} km`));
  };
  const a = slider('Bit rate', 2.5, 100, 2.5, gbps, (v) => `${v} Gb/s`, (v) => { gbps = v; paint(); });
  const b = slider('Distance', 0, 200, 1, km, (v) => `${v} km`, (v) => { km = v; paint(); });
  const c = slider('Wavelength', 1270, 1620, 5, nm, (v) => `${v} nm`, (v) => { nm = v; paint(); });
  paint();
  return { el: h('div', { class: 'widget mos gl-w' }, h('div', { class: 'mos-row' }, a.el), h('div', { class: 'mos-row' }, b.el), h('div', { class: 'mos-row' }, c.el), plot, out, h('p', { class: 'sub' }, 'Each pulse\'s envelope broadens by the Gaussian formula, energy kept; interference between neighbours is left out, so a real waveform is a little worse.')) };
}

// ---- wavelengths ----------------------------------------------------------------------------------------------------------------------
export function wdmWidget(): Widget {
  let ghz = 50, gbd = 32, q = 1, band = 0;
  const plot = h('div'), out = h('div', { class: 'mc-status' });
  const paint = () => {
    const chans = gridChannels(ghz) + (band ? gridChannels(ghz, L_BAND) : 0), fits = gbd * 1.2 <= ghz;
    const W = 560, H = 70, t0 = 184, t1 = 196, x = (t: number) => 10 + ((t - t0) / (t1 - t0)) * (W - 20);
    const rect = (b: [number, number], cls: string) => s('rect', { x: x(299792.458 / b[1]), y: 12, width: x(299792.458 / b[0]) - x(299792.458 / b[1]), height: 36, class: cls });
    const kids: SVGElement[] = [rect(C_BAND, 'gl-band'), ...(band ? [rect(L_BAND, 'gl-band')] : [])];
    const pitch = ghz / 1000;
    for (const b of band ? [C_BAND, L_BAND] : [C_BAND]) {
      for (let t = 299792.458 / b[1] + pitch / 2; t < 299792.458 / b[0]; t += pitch) kids.push(line(x(t), 14, x(t), 46, 'gl-chan'));
    }
    kids.push(txt(x(ANCHOR_THZ), 62, `193.1 THz = ${nf(nmOf(ANCHOR_THZ), 1)} nm`, 'gl-t', 'middle'), txt(x(187.2), 62, band ? 'L band' : '', 'gl-t', 'middle'));
    plot.replaceChildren(s('svg', { class: 'gl-svg', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `${chans} channels` }, ...kids));
    const rate = 2 * gbd * QAMS[q].bitsPerPolSym * FEC_RATE, total = (chans * rate) / 1000;
    out.replaceChildren(stat('Channels', String(chans)), stat('Each', `${nf(rate, 0)} Gb/s`), stat('On one fibre', `${nf(total, 1)} Tb/s`, fits ? '' : 'bad'), stat('Spectral efficiency', `${nf(rate / ghz, 1)} b/s/Hz`), fits ? h('span') : stat('Spacing', 'too tight for this symbol rate', 'bad'));
  };
  const sel = h('select', { class: 'mc-sel', 'aria-label': 'Modulation' }, ...QAMS.map((m, i) => h('option', { value: String(i) }, m.name)));
  (sel as HTMLSelectElement).value = '1';
  sel.addEventListener('change', () => { q = Number((sel as HTMLSelectElement).value); paint(); });
  const bandSel = h('select', { class: 'mc-sel', 'aria-label': 'Band' }, h('option', { value: '0' }, 'C band'), h('option', { value: '1' }, 'C + L'));
  bandSel.addEventListener('change', () => { band = Number((bandSel as HTMLSelectElement).value); paint(); });
  const a = slider('Channel spacing', 25, 150, 12.5, ghz, (v) => `${v} GHz`, (v) => { ghz = v; paint(); });
  const b = slider('Symbol rate', 10, 130, 2, gbd, (v) => `${v} GBd`, (v) => { gbd = v; paint(); });
  paint();
  return { el: h('div', { class: 'widget mos gl-w' }, h('div', { class: 'dram-ops' }, sel, bandSel), h('div', { class: 'mos-row' }, a.el), h('div', { class: 'mos-row' }, b.el), plot, out, h('p', { class: 'sub' }, `Two polarizations, a ${FEC_RATE} code rate; a channel needs about 1.2 × its symbol rate.`)) };
}

// ---- an amplifier chain ---------------------------------------------------------------------------------------------------------------
export function amplifierWidget(): Widget {
  let spans = 10, kmSpan = 80, p = 0, nf_ = 4.5;
  const plot = h('div'), out = h('div', { class: 'mc-status' });
  const paint = () => {
    const spanDb = kmSpan * 0.2, show = Math.min(spans, 12);
    const a = axes([0, show * kmSpan], [-35, 15], Array.from({ length: show + 1 }, (_, i) => i * kmSpan).filter((_, i) => i % 3 === 0), [-30, -20, -10, 0, 10], (v) => `${v}`, (v) => String(v), 'km', 'dBm', false);
    const pts: [number, number][] = [];
    for (let i = 0; i < show; i++) { pts.push([a.x(i * kmSpan), a.y(p)], [a.x((i + 1) * kmSpan), a.y(p - spanDb)]); }
    pts.push([a.x(show * kmSpan), a.y(p)]);
    plot.replaceChildren(svgOf(a, `Signal power along ${spans} spans`, ...a.g, poly(pts, 'gl-l1'), ...Array.from({ length: show }, (_, i) => s('circle', { cx: a.x((i + 1) * kmSpan), cy: a.y(p), r: 3, class: 'gl-amp' }))));
    const o = osnrDb(p, nf_, spanDb, spans), snr = snrFromOsnr(o, 32);
    out.replaceChildren(stat('Span loss', `${nf(spanDb, 1)} dB`), stat('Distance', `${spans * kmSpan} km`), stat('OSNR in 0.1 nm', `${nf(o, 1)} dB`), stat('SNR at 32 GBd', `${nf(snr, 1)} dB`), ...QAMS.map((m) => { const need = requiredSnrDb(m), ok = snr >= need; return stat(m.name, ok ? `closes, ${nf(snr - need, 1)} dB spare` : `short by ${nf(need - snr, 1)} dB`, ok ? 'good' : 'bad'); }));
  };
  const a = slider('Spans', 1, 200, 1, spans, (v) => String(v), (v) => { spans = v; paint(); });
  const b = slider('Span length', 30, 120, 5, kmSpan, (v) => `${v} km`, (v) => { kmSpan = v; paint(); });
  const c = slider('Launch power per channel', -10, 10, 0.5, p, (v) => `${v} dBm`, (v) => { p = v; paint(); });
  const d = slider('Noise figure', 3, 8, 0.5, nf_, (v) => `${v} dB`, (v) => { nf_ = v; paint(); });
  paint();
  return { el: h('div', { class: 'widget mos gl-w' }, h('div', { class: 'mos-row' }, a.el), h('div', { class: 'mos-row' }, b.el), h('div', { class: 'mos-row' }, c.el), h('div', { class: 'mos-row' }, d.el), plot, out, h('p', { class: 'sub' }, 'Noise from amplifiers only here. The next steps add what stops you just raising the power.')) };
}

// ---- a coherent receiver --------------------------------------------------------------------------------------------------------------
export function coherentWidget(): Widget {
  let km = 500, snr = 9, comp = false, track = false, lw = 0;
  const plot = h('div', { class: 'gl-scatter' }), out = h('div', { class: 'mc-status' });
  const paint = () => {
    const b2 = beta2Of(dispersionD(1550), 1550);
    const r = coherentLink({ symbols: 8192, gbd: 32, km, beta2: b2, snrDb: snr, compensate: comp, linewidthMHz: lw, seed: 7, track });
    const W = 260, c = W / 2, g = (W / 2 - 8) / 2;
    const dots: SVGElement[] = [line(c, 4, c, W - 4, 'gl-grid'), line(4, c, W - 4, c, 'gl-grid')];
    for (let i = 0; i < r.rx.length; i += 8) {
      const [a, b] = r.rx[i];
      if (Math.abs(a) > 2 || Math.abs(b) > 2) continue;
      dots.push(s('circle', { cx: c + a * g, cy: c - b * g, r: 1.2, class: r.sent[i][0] * a > 0 && r.sent[i][1] * b > 0 ? 'gl-dot' : 'gl-dot bad' }));
    }
    plot.replaceChildren(s('svg', { class: 'gl-svg sq', viewBox: `0 0 ${W} ${W}`, role: 'img', 'aria-label': `Received symbols, bit error rate ${r.ber.toExponential(1)}` }, ...dots));
    const taps = cdTaps(b2, km, 32);
    out.replaceChildren(stat('BER', r.ber.toExponential(1), r.ber > 3 * r.theory ? 'bad' : 'good'), stat('Q(√SNR)', r.theory.toExponential(1)), stat('Bits', groupNum(r.bits)), stat('Equalizer would need', `${groupNum(taps)} taps at 64 GS/s`));
  };
  const a = slider('Distance', 0, 6600, 100, km, (v) => `${v} km`, (v) => { km = v; paint(); });
  const b = slider('SNR', 3, 18, 0.5, snr, (v) => `${v} dB`, (v) => { snr = v; paint(); });
  const c = slider('Laser linewidth', 0, 5, 0.1, lw, (v) => `${nf(v, 1)} MHz`, (v) => { lw = v; paint(); });
  const box = (label: string, on: boolean, f: (v: boolean) => void) => { const i = h('input', { type: 'checkbox' }) as HTMLInputElement; i.checked = on; i.addEventListener('change', () => { f(i.checked); paint(); }); return h('label', { class: 'gl-box' }, i, ` ${label}`); };
  paint();
  return { el: h('div', { class: 'widget mos gl-w' }, h('div', { class: 'mos-row' }, a.el), h('div', { class: 'mos-row' }, b.el), h('div', { class: 'mos-row' }, c.el), h('div', { class: 'dram-ops' }, box('Undo the dispersion', comp, (v) => { comp = v; }), box('Track the carrier phase', track, (v) => { track = v; })), plot, out, h('p', { class: 'sub' }, 'QPSK at 32 GBd, one polarization, simulated sample by sample at 2 samples a symbol. A model: no optics, an already known clock, and the first symbols standing in as pilots to pick the tracker\'s quadrant.')) };
}

// ---- the ocean --------------------------------------------------------------------------------------------------------------------------
export function oceanWidget(): Widget {
  let km = 6600, kmSpan = 60, q = 0, p = 0, nfdb = 4.5;
  const gbd = 32;
  const plot = h('div'), out = h('div', { class: 'mc-status' });
  const paint = () => {
    const spans = Math.ceil(km / kmSpan), spanDb = kmSpan * 0.2 + 4, need = requiredSnrDb(QAMS[q]), best = bestPower(spans, nfdb, spanDb, gbd), s0 = snrWithNli(p, spans, nfdb, spanDb, gbd);
    const a = axes([-12, 12], [0, 30], [-10, -5, 0, 5, 10], [0, 10, 20, 30], (v) => String(v), (v) => String(v), 'launch power per channel, dBm', 'SNR, dB');
    const curve: [number, number][] = [], linear: [number, number][] = [];
    for (let x = -12; x <= 12; x += 0.2) {
      const v = snrWithNli(x, spans, nfdb, spanDb, gbd);
      if (v >= 0 && v <= 30) curve.push([a.x(x), a.y(v)]);
      const l = snrWithNli(x, spans, nfdb, spanDb, gbd, 0);
      if (l >= 0 && l <= 30) linear.push([a.x(x), a.y(l)]);
    }
    const yNeed = a.y(Math.max(0, Math.min(30, need)));
    plot.replaceChildren(svgOf(a, `SNR against launch power over ${km} km; the best is ${nf(best.snrDb, 1)} dB at ${nf(best.pDbm, 1)} dBm`, ...a.g, poly(linear, 'gl-l2'), poly(curve, 'gl-l1'), line(44, yNeed, a.w - 10, yNeed, 'gl-need'), txt(a.w - 12, yNeed - 4, `${QAMS[q].name} needs ${nf(need, 1)} dB`, 'gl-t', 'end'), s('circle', { cx: a.x(best.pDbm), cy: a.y(Math.max(0, best.snrDb)), r: 4, class: 'gl-amp' }), s('circle', { cx: a.x(p), cy: a.y(Math.max(0, Math.min(30, s0))), r: 3.5, class: 'gl-cur-dot' })));
    const closes = s0 >= need, chans = gridChannels(50) + gridChannels(50, L_BAND), rate = 2 * gbd * QAMS[q].bitsPerPolSym * FEC_RATE, reach = maxSpans(need, nfdb, spanDb, gbd) * kmSpan;
    const lim = (2 * shannon(gbd, 10 ** (best.snrDb / 10))).toFixed(0);
    out.replaceChildren(stat('Amplifiers', String(spans)), stat('This power', `${nf(s0, 1)} dB`, closes ? 'good' : 'bad'), stat('Best power', `${nf(best.pDbm, 1)} dBm, ${nf(best.snrDb, 1)} dB`), stat(`${QAMS[q].name} reach`, `${groupNum(reach)} km`), stat('Channel', `${rate.toFixed(0)} Gb/s (Shannon at the best SNR: ${lim})`), stat('C + L, 50 GHz', `${(chans * rate / 1000).toFixed(1)} Tb/s each way on one pair`));
  };
  const sel = h('select', { class: 'mc-sel', 'aria-label': 'Modulation' }, ...QAMS.map((m, i) => h('option', { value: String(i) }, m.name)));
  sel.addEventListener('change', () => { q = Number((sel as HTMLSelectElement).value); paint(); });
  const a = slider('Distance', 500, 12000, 100, km, (v) => `${groupNum(v)} km`, (v) => { km = v; paint(); });
  const b = slider('Span length', 30, 120, 5, kmSpan, (v) => `${v} km`, (v) => { kmSpan = v; paint(); });
  const c = slider('Launch power', -10, 10, 0.5, p, (v) => `${v} dBm`, (v) => { p = v; paint(); });
  const d = slider('Noise figure', 3, 8, 0.5, nfdb, (v) => `${v} dB`, (v) => { nfdb = v; paint(); });
  paint();
  return { el: h('div', { class: 'widget mos gl-w' }, h('div', { class: 'dram-ops' }, sel), h('div', { class: 'mos-row' }, a.el), h('div', { class: 'mos-row' }, b.el), h('div', { class: 'mos-row' }, c.el), h('div', { class: 'mos-row' }, d.el), plot, out, h('p', { class: 'sub' }, 'Each span is 0.2 dB/km plus 4 dB for splices and margin. The Gaussian-noise model with an illustrative fibre coefficient: thin line for amplifier noise alone, bold for the Kerr effect too. The small dot is your launch power, the green one the best.')) };
}
