// The Cellular chapter's explorers, on phys/cellular.ts: a hexagonal map with its channel sets, the resource grid and numerology, schedulers, handover along a road, many antennas, and mmWave's budget. Models throughout: nothing here is
// measured on a real network, and no trace is a capture.

import { arrayFactor } from '../phys/radio';
import { channelOverlap, CLUSTERS, cpUs, gridMbps, handover, harmonic, hexGrid, LTE_RBS, rbKhz, reachKm, reuseRatio, reuseSweep, schedule, sirAt, sirClosedDb, slotMs, zfMeanSnr, zfRates, type Policy } from '../phys/cellular';
import { h, s } from '../ui/dom';
import type { Widget } from '../view/stage';
import { slider } from './mosparts';
import '../styles/cellular.css';

const nf = (x: number, d = 1) => x.toFixed(d);
const stat = (label: string, value: string, cls = '') => h('span', null, `${label} `, h('b', { class: cls }, value));
const poly = (pts: [number, number][], cls: string) => s('polyline', { class: cls, points: pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ') });
const txt = (x: number, y: number, t: string, cls = 'cl-t', anchor = 'start') => { const e = s('text', { x, y, class: cls, 'text-anchor': anchor }); e.textContent = t; return e; };
const line = (x1: number, y1: number, x2: number, y2: number, cls: string) => s('line', { x1, y1, x2, y2, class: cls });
const row = (el: Node) => h('div', { class: 'mos-row' }, el);
function axes(xr: [number, number], yr: [number, number], xt: number[], yt: number[], fmtX: (v: number) => string, fmtY: (v: number) => string, xl: string, yl: string, W = 560, H = 220) {
  const L = 44, R = 10, T = 24, B = 34;
  const x = (v: number) => L + ((v - xr[0]) / (xr[1] - xr[0])) * (W - L - R), y = (v: number) => T + (1 - (v - yr[0]) / (yr[1] - yr[0])) * (H - T - B);
  const g: SVGElement[] = [];
  for (const v of yt) { g.push(line(L, y(v), W - R, y(v), 'cl-grid')); g.push(txt(L - 5, y(v) + 4, fmtY(v), 'cl-t', 'end')); }
  for (const v of xt) { g.push(line(x(v), T, x(v), H - B, 'cl-grid')); g.push(txt(x(v), H - B + 14, fmtX(v), 'cl-t', 'middle')); }
  g.push(txt(W - R, H - 4, xl, 'cl-t', 'end'), txt(4, 12, yl, 'cl-t'));
  return { w: W, h: H, x, y, g, top: T, bottom: H - B };
}
const svgOf = (a: { w: number; h: number }, label: string, ...kids: SVGElement[]) => s('svg', { class: 'cl-svg', viewBox: `0 0 ${a.w} ${a.h}`, role: 'img', 'aria-label': label }, ...kids);
const selectOf = (label: string, options: [string, string][], value: string, f: (v: string) => void) => {
  const e = h('select', { class: 'mc-sel', 'aria-label': label }, ...options.map(([v, t]) => h('option', { value: v }, t))) as HTMLSelectElement;
  e.value = value;
  e.addEventListener('change', () => f(e.value));
  return e;
};
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// ---- the map -----------------------------------------------------------------------------------------------------------------------------
export function reuseWidget(): Widget {
  let k = 7, n = 4;
  const map = h('div'), out = h('div', { class: 'mc-status' });
  const paint = () => {
    const cells = hexGrid(5, k), W = 420, H = 340, sc = 24, cx = W / 2, cy = H / 2;
    const c0 = cells.find((c) => c.q === 0 && c.r === 0)!;
    const hex = (x: number, y: number) => Array.from({ length: 6 }, (_, i) => { const a = (Math.PI / 3) * i + Math.PI / 6; return `${(cx + (x + Math.cos(a)) * sc).toFixed(1)},${(cy + (y + Math.sin(a)) * sc).toFixed(1)}`; }).join(' ');
    const kids: SVGElement[] = cells.filter((c) => Math.abs(c.x * sc) < W / 2 + sc && Math.abs(c.y * sc) < H / 2 + sc).map((c) => s('polygon', { points: hex(c.x, c.y), class: `cl-hex${c.colour === c0.colour ? ' same' : ''}${c === c0 ? ' mine' : ''}`, style: `--h:${(c.colour * 360) / k}` }));
    map.replaceChildren(s('svg', { class: 'cl-svg map', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Cells on a hexagonal grid, cluster size ${k}` }, ...kids));
    const r = reuseSweep(k, n, 1000), edge = sirAt(hexGrid(8, k), 0.0001, 0.9999, n).sir;
    out.replaceChildren(stat('Reuse distance', `${nf(reuseRatio(k), 2)} × R`), stat('Rule at the edge', `${nf(sirClosedDb(k, n), 1)} dB`), stat('Grid at a corner', `${nf(10 * Math.log10(edge), 1)} dB`), stat('Median SIR', `${nf(r.medianDb, 1)} dB`), stat('Worst 5 %', `${nf(r.edgeDb, 1)} dB`), stat('Mean b/s/Hz a cell', nf(r.perCell, 2), 'good'));
  };
  const a = selectOf('Cluster size', CLUSTERS.map((c) => [String(c), `K = ${c}`]), String(k), (v) => { k = Number(v); paint(); });
  const b = slider('Path-loss exponent', 2.5, 5, 0.1, n, (v) => nf(v, 1), (v) => { n = v; paint(); });
  paint();
  return { el: h('div', { class: 'widget mos cl-w' }, h('div', { class: 'dram-ops' }, a), row(b.el), map, out, h('p', { class: 'sub' }, 'Equal base stations on a regular grid, all co-channel ones transmitting, no noise, no shadowing. SIR at points through the middle cell; rate by Shannon, the band shared across K cells.')) };
}

// ---- the grid ----------------------------------------------------------------------------------------------------------------------------
export function gridWidget(): Widget {
  let mhzI = 3, bits = 4.5, layers = 2, mu = 0;
  const grid = h('div'), out = h('div', { class: 'mc-status' });
  const paint = () => {
    const rbs = LTE_RBS[mhzI][1], W = 560, H = 150, cols = 14, rows = 12, cw = 26, ch = 9, x0 = 44, y0 = 8;
    const kids: SVGElement[] = [];
    for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) kids.push(s('rect', { x: x0 + c * cw, y: y0 + r * ch, width: cw - 1, height: ch - 1, class: c < 2 ? 'cl-re ctl' : (c === 4 || c === 7 || c === 11) && r % 6 === (c % 2 ? 1 : 4) ? 'cl-re ref' : 'cl-re' }));
    kids.push(txt(4, y0 + 56, '1 block', 'cl-t'), txt(x0, y0 + rows * ch + 14, `${nf(slotMs(mu), 3)} ms: 14 symbols of ${nf(66.7 / 2 ** mu, 1)} µs`, 'cl-t'));
    grid.replaceChildren(s('svg', { class: 'cl-svg', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'One resource block for one slot: control at the start, reference signals scattered, data the rest' }, ...kids));
    out.replaceChildren(stat('Blocks', String(rbs)), stat('Block width', `${rbKhz(mu)} kHz`), stat('Slot', `${nf(slotMs(mu), 3)} ms`), stat('Cyclic prefix', `${nf(cpUs(mu), 2)} µs`), stat('Peak of this carrier', `${nf(gridMbps(rbs, bits, 0.25, 0, layers), 0)} Mb/s`, 'good'));
  };
  const a = selectOf('Channel', LTE_RBS.map(([m], i) => [String(i), `${m} MHz`]), String(mhzI), (v) => { mhzI = Number(v); paint(); });
  const c = selectOf('Modulation and code', [['1', 'QPSK ½'], ['2.67', '16-QAM ⅔'], ['4.5', '64-QAM ¾'], ['6', '256-QAM ¾']], '4.5', (v) => { bits = Number(v); paint(); });
  const d = selectOf('Layers', [['1', '1 stream'], ['2', '2 streams'], ['4', '4 streams']], '2', (v) => { layers = Number(v); paint(); });
  const e = slider('Numerology µ', 0, 3, 1, mu, (v) => `${15 * 2 ** v} kHz`, (v) => { mu = v; paint(); });
  paint();
  return { el: h('div', { class: 'widget mos cl-w' }, h('div', { class: 'dram-ops' }, a, c, d), row(e.el), grid, out, h('p', { class: 'sub' }, 'LTE\'s channels by their published block counts; peak = elements a millisecond × bits × layers, 25 % taken for control and reference signals (labelled constant). Wider subcarriers take the same share of symbols in less time, for the same rate per hertz.')) };
}

// ---- schedulers -----------------------------------------------------------------------------------------------------------------------------
export function schedulerWidget(): Widget {
  let far = 15, users = 6;
  const plot = h('div'), out = h('div', { class: 'mc-status' });
  const paint = () => {
    const means = Array.from({ length: users }, (_, i) => 20 - (i * far) / Math.max(1, users - 1));
    const res = (['rr', 'pf', 'max'] as Policy[]).map((p) => schedule(p, means, 6000, 7));
    const W = 560, H = 220, a = axes([0, users], [0, Math.max(...res.flatMap((r) => r.perUser)) * 1.1], [], [], () => '', () => '', 'users, near to far', 'b/s/Hz', W, H);
    const bars: SVGElement[] = [], pw = (W - 54) / users / 3.4;
    res.forEach((r, j) => r.perUser.forEach((v, i) => {
      const y = a.y(v);
      bars.push(s('rect', { x: a.x(i) + 3 + j * pw, y, width: pw - 1, height: Math.max(0, a.bottom - y), class: `cl-bar b${j}` }));
    }));
    means.forEach((m, i) => bars.push(txt(a.x(i + 0.5), a.bottom + 14, `${nf(m, 0)} dB`, 'cl-t', 'middle')));
    plot.replaceChildren(svgOf(a, 'Each user\'s rate under three schedulers', ...a.g, ...bars), h('div', { class: 'cl-key' }, ...['Round robin', 'Proportional fair', 'Max rate'].map((n, j) => h('span', null, h('i', { class: `cl-sw b${j}` }), n))));
    const [rr, pf, mx] = res;
    out.replaceChildren(stat('Cell, round robin', `${nf(rr.total, 2)} b/s/Hz`), stat('Proportional fair', `${nf(pf.total, 2)}`, 'good'), stat('Max rate', nf(mx.total, 2)), stat('Fairness (Jain)', `${nf(rr.jain, 2)} · ${nf(pf.jain, 2)} · ${nf(mx.jain, 2)}`), stat(`H_${users}`, nf(harmonic(users), 2)));
  };
  const a = slider('Users', 2, 16, 1, users, (v) => String(v), (v) => { users = v; paint(); });
  const b = slider('Nearest to farthest', 0, 30, 1, far, (v) => `${v} dB`, (v) => { far = v; paint(); });
  paint();
  return { el: h('div', { class: 'widget mos cl-w' }, row(a.el), row(b.el), plot, out, h('p', { class: 'sub' }, 'Simulated slots, one user served in each; independent Rayleigh fades drawn fresh every slot; rate by Shannon. A model, not a measured cell.')) };
}

// ---- handover --------------------------------------------------------------------------------------------------------------------------------
export function handoverWidget(): Widget {
  let hyst = 3, ttt = 320, shadow = 6, speed = 20, seed = 3;
  const plot = h('div'), out = h('div', { class: 'mc-status' });
  const paint = () => {
    const sites = [0, 1000, 2000], r = handover({ sites, speedMs: speed, n: 3.5, shadowDb: shadow, corrM: 50, hystDb: hyst, tttMs: ttt, seed, lengthM: 2000, refDbm: -5 });
    const a = axes([0, 2000], [-130, -30], [0, 500, 1000, 1500, 2000], [-120, -100, -80, -60, -40], (v) => String(v), (v) => String(v), 'metres along the road', 'dBm');
    const curve = (i: number) => poly(r.rsrp[i].map((v, k) => [a.x(k * 5), a.y(clamp(v, -130, -30))] as [number, number]), `cl-site s${i}`);
    const marks = r.events.map((e) => line(a.x(e.m), a.top, a.x(e.m), a.bottom, 'cl-ho'));
    const servedPts = r.serving.map((sv, k) => [a.x(k * 5), a.y(clamp(r.rsrp[sv][k], -130, -30))] as [number, number]);
    plot.replaceChildren(svgOf(a, `Signal from three sites along a road; ${r.events.length} handovers`, ...a.g, curve(0), curve(1), curve(2), ...marks, poly(servedPts, 'cl-served')));
    out.replaceChildren(stat('Handovers', String(r.events.length), r.events.length > 2 ? 'bad' : 'good'), stat('Back and forth', String(r.pingPongs), r.pingPongs ? 'bad' : ''), stat('Below −110 dBm', `${r.outageM} m`, r.outageM ? 'bad' : ''), stat('Trigger takes', `${nf((ttt / 1000) * speed, 0)} m at this speed`));
  };
  const a = slider('Hysteresis', 0, 10, 0.5, hyst, (v) => `${v} dB`, (v) => { hyst = v; paint(); });
  const b = slider('Time to trigger', 0, 1280, 40, ttt, (v) => `${v} ms`, (v) => { ttt = v; paint(); });
  const c = slider('Shadowing', 0, 10, 0.5, shadow, (v) => `${v} dB`, (v) => { shadow = v; paint(); });
  const d = slider('Speed', 1, 40, 1, speed, (v) => `${v} m/s`, (v) => { speed = v; paint(); });
  const again = h('button', { class: 'btn sm', type: 'button' }, 'Another road');
  again.addEventListener('click', () => { seed++; paint(); });
  paint();
  return { el: h('div', { class: 'widget mos cl-w' }, h('div', { class: 'dram-ops' }, again), row(a.el), row(b.el), row(c.el), row(d.el), plot, out, h('p', { class: 'sub' }, 'Three sites 1 km apart; thin lines their levels by log-distance and correlated shadowing, the thick line what the phone is attached to. A model.')) };
}

// ---- many antennas ------------------------------------------------------------------------------------------------------------------------
export function massiveWidget(): Widget {
  let M = 32, K = 4, rho = 0, steer = 20;
  const pattern = h('div'), out = h('div', { class: 'mc-status' });
  const paint = () => {
    const W = 340, c = W / 2, R = W / 2 - 14, n = Math.min(M, 64), kids: SVGElement[] = [s('circle', { cx: c, cy: c, r: R, class: 'cl-ring' }), s('circle', { cx: c, cy: c, r: R / 2, class: 'cl-ring' }), line(c, c - R, c, c + R, 'cl-grid'), line(c - R, c, c + R, c, 'cl-grid')];
    const pts: [number, number][] = [];
    for (let d = -90; d <= 90; d += 0.25) { const a = (d * Math.PI) / 180, v = arrayFactor(n, 0.5, steer, d); pts.push([c + R * v * Math.sin(a), c - R * v * Math.cos(a)]); }
    kids.push(poly(pts, 'cl-beam'));
    pattern.replaceChildren(s('svg', { class: 'cl-svg sq', viewBox: `0 0 ${W} ${W}`, role: 'img', 'aria-label': `Beam of ${n} elements at ${steer} degrees` }, ...kids));
    const z = zfRates(K, Math.max(M, K), rho, 200, 3), ov = channelOverlap(M, 200, 3);
    out.replaceChildren(stat('Array gain', `${nf(10 * Math.log10(M), 1)} dB`), stat('Each user\'s SNR (closed form)', `${nf(10 * Math.log10(zfMeanSnr(K, Math.max(M, K), rho)), 1)} dB`), stat('Simulated', `${nf(10 * Math.log10(z.meanSnr), 1)} dB`), stat('Cell', `${nf(z.sumRate, 1)} b/s/Hz`, 'good'), stat('Two channels overlap', nf(ov, 3)));
  };
  const a = slider('Antennas', 2, 128, 2, M, (v) => String(v), (v) => { M = v; paint(); });
  const b = slider('Users at once', 1, 8, 1, K, (v) => String(v), (v) => { K = v; paint(); });
  const c = slider('Total SNR at one antenna', -10, 20, 1, rho, (v) => `${v} dB`, (v) => { rho = v; paint(); });
  const d = slider('Steering', -60, 60, 5, steer, (v) => `${v}°`, (v) => { steer = v; paint(); });
  paint();
  return { el: h('div', { class: 'widget mos cl-w' }, row(a.el), row(b.el), row(c.el), row(d.el), pattern, out, h('p', { class: 'sub' }, 'Zero-forcing downlink over independent Rayleigh channels, perfect channel knowledge: the ideal case. The beam is one user\'s, drawn in a line of up to 64 half-wavelength elements. A model.')) };
}

// ---- millimetre waves ------------------------------------------------------------------------------------------------------------------------
export function mmwaveWidget(): Widget {
  let eirp = 50, sens = -100, elements = 64;
  const body = h('tbody');
  const paint = () => {
    const budget = eirp - sens;
    const rows: [string, number, number][] = [['700 MHz', 0.7, 0], ['3.5 GHz', 3.5, 0], ['3.5 GHz, array', 3.5, 10 * Math.log10(elements)], ['28 GHz', 28, 0], ['28 GHz, array', 28, 10 * Math.log10(elements)]];
    body.replaceChildren(...rows.map(([n, f, g]) => { const k = reachKm(budget, f, g), w = 299792458 / (f * 1e9); return h('tr', null, h('td', null, n), h('td', { class: 'num' }, `${nf(w * 100, 1)} cm`), h('td', { class: 'num' }, `${nf(g, 0)} dB`), h('td', { class: 'num' }, k >= 1 ? `${nf(k, 1)} km` : `${nf(k * 1000, 0)} m`)); }));
  };
  const a = slider('Transmit EIRP', 30, 70, 1, eirp, (v) => `${v} dBm`, (v) => { eirp = v; paint(); });
  const b = slider('Receiver needs', -120, -80, 1, sens, (v) => `${v} dBm`, (v) => { sens = v; paint(); });
  const c = slider('Array elements', 4, 256, 4, elements, (v) => String(v), (v) => { elements = v; paint(); });
  paint();
  return { el: h('div', { class: 'widget mos cl-w' }, row(a.el), row(b.el), row(c.el), h('div', { class: 'cl-scroll' }, h('table', { class: 'cl-table' }, h('thead', null, h('tr', null, ...['Band', 'Wavelength', 'Added array gain', 'Free-space reach'].map((t) => h('th', null, t)))), body)), h('p', { class: 'sub' }, 'Friis only, in free space with a clear line: real reach is far shorter, and worse at 28 GHz, where walls, foliage and a hand stop the signal. The comparison between rows is the point.')) };
}
