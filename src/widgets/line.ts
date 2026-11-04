// Chapter 41's explainers: the driver and its load, an RC wire, repeaters, a wavefront on a line, reflections, termination, noise
// (crosstalk, ground bounce, a differential pair, an eye), and the panel beside the I/O pad. Every number and every curve is
// computed in phys/line.ts; this file draws and wires sliders.

import { PAD_FINAL, PAD_LINK, PAD_PIN_FF, padDriveOhms } from '../lib/pad';
import {
  berOf, bestRepeaters, boardDelay, coupling, criticalLength, crosstalk, differential, eye, farStats, groundBounce, iSat, isLumped, lattice,
  lcOf, minRsStaysHigh, parallelPower, plan, prbs, qOf, rcDelay50, rcStep, repeatedDelay, repeaterOptimum, rEff, rOn, seriesResistor, unitR,
  VIH, VIL, VIO, wireDelayTerms, wireDominates, wireLadder, PCB_PS_PER_MM, WIRE_C_PER_MM, WIRE_R_PER_MM, Z0_BOARD, type LineSpec,
  rng, gaussian,
} from '../phys/line';
import { discharge } from './mosphys';
import { h, s } from '../ui/dom';
import type { Scene, ScenePanel, Stage, Widget } from '../view/stage';
import { fitText, slider } from './mosparts';
import '../styles/line.css';

// ---------------------------------------------------------------------------------------------------------------------
// A small plot: fixed axes, a layer that is redrawn

interface PlotOpts {
  W?: number; H?: number;
  /** x runs from 0 to x[1]; setX moves the end and redraws the ticks. */
  x: [number, number]; y: [number, number];
  yTicks: number[];
  xLabel: string; yLabel: string; aria: string;
  xFmt?: (v: number) => string; yFmt?: (v: number) => string;
}
interface Plot { el: SVGSVGElement; X(v: number): number; Y(v: number): number; layer: SVGGElement; clear(): void; setX(max: number): void; setY(lo: number, hi: number): void; xMax: number; x0: number; x1: number }

const num = (v: number, d = 1) => (Math.abs(v) < 1e-9 ? '0' : v.toFixed(d).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, ''));

/** A "nice" tick step (1, 2, 5 × 10^k) giving about n ticks on [0, max]. */
function tickStep(max: number, n = 4): number {
  const raw = max / n, p = 10 ** Math.floor(Math.log10(raw)), f = raw / p;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
}

function plotOf(o: PlotOpts): Plot {
  const W = o.W ?? 460, H = o.H ?? 230, m = { l: 48, r: 12, t: 12, b: 36 };
  let xMax = o.x[1], yLo = o.y[0], yHi = o.y[1];
  const X = (v: number) => m.l + (v / xMax) * (W - m.l - m.r);
  const Y = (v: number) => H - m.b - ((v - yLo) / (yHi - yLo)) * (H - m.t - m.b);
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'mos-plot ln-plot', role: 'img', 'aria-label': o.aria }) as SVGSVGElement;
  const yf = o.yFmt ?? ((v: number) => num(v, 2));
  const gx = svg.appendChild(s('g'));
  const gy = svg.appendChild(s('g'));
  const drawY = (ticks: number[]) => gy.replaceChildren(...ticks.flatMap((v) => [s('line', { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v), class: 'grid' }), s('text', { x: m.l - 6, y: Y(v) + 3.5, 'text-anchor': 'end', class: 'tick' }, yf(v))]));
  drawY(o.yTicks);
  const clipId = `lnclip${Math.random().toString(36).slice(2, 8)}`;
  svg.append(s('clipPath', { id: clipId }, s('rect', { x: m.l, y: m.t, width: W - m.l - m.r, height: H - m.t - m.b })));
  svg.append(s('line', { x1: m.l, x2: W - m.r, y1: H - m.b, y2: H - m.b, class: 'ax' }), s('line', { x1: m.l, x2: m.l, y1: m.t, y2: H - m.b, class: 'ax' }),
    s('text', { x: W - m.r, y: H - 4, 'text-anchor': 'end', class: 'axl' }, o.xLabel),
    s('text', { x: 6, y: m.t, 'text-anchor': 'end', 'dominant-baseline': 'hanging', transform: `rotate(-90 6 ${m.t})`, class: 'axl' }, o.yLabel));
  fitText(svg, W);
  const layer = svg.appendChild(s('g', { 'clip-path': `url(#${clipId})` }));
  const xf = o.xFmt;
  const p: Plot = {
    el: svg, X, Y, layer, clear: () => layer.replaceChildren(), xMax, x0: m.l, x1: W - m.r,
    setX(max) {
      xMax = max; p.xMax = max;
      const st = tickStep(max), d = st < 1 ? 1 : 0, kids: SVGElement[] = [];
      for (let v = 0; v <= max * 1.0001; v += st) kids.push(s('line', { x1: X(v), x2: X(v), y1: m.t, y2: H - m.b, class: 'grid' }), s('text', { x: X(v), y: H - m.b + 14, 'text-anchor': 'middle', class: 'tick' }, xf ? xf(v) : num(v, d + (st < 0.1 ? 2 : st < 1 ? 1 : 0))));
      gx.replaceChildren(...kids);
    },
    setY(lo, hi) {
      yLo = lo; yHi = hi;
      const st = tickStep(hi - lo, 4), ticks: number[] = [];
      for (let v = Math.ceil(lo / st) * st; v <= hi + 1e-9; v += st) ticks.push(Math.abs(v) < st * 1e-6 ? 0 : v);
      drawY(ticks);
    },
  };
  p.setX(xMax);
  return p;
}

const line = (p: Plot, xs: number[], ys: number[], cls: string) => {
  let d = '';
  for (let i = 0; i < xs.length; i++) d += `${i ? 'L' : 'M'}${p.X(xs[i]).toFixed(1)},${p.Y(ys[i]).toFixed(1)}`;
  p.layer.append(s('path', { d, class: `ln-s ${cls}` }));
};
/** A horizontal marker across the plot, labelled at its right end. */
const hline = (p: Plot, v: number, label: string, cls = 'th') => {
  p.layer.append(s('line', { x1: p.x0, x2: p.x1, y1: p.Y(v), y2: p.Y(v), class: `ln-h ${cls}` }),
    s('text', { x: p.x1 - 4, y: p.Y(v) - 4, 'text-anchor': 'end', class: `ln-hl ${cls}` }, label));
};

const mkChips = (n: number) => {
  const cells = Array.from({ length: n }, () => { const b = h('b'), sp = h('span'); return { b, sp, el: h('div', null, b, sp) }; });
  return { cells, el: h('div', { class: 'mos-chips' }, ...cells.map((c) => c.el)), set(i: number, b: string, sp: string, cls = '') { cells[i].b.textContent = b; cells[i].b.className = cls; cells[i].sp.textContent = sp; } };
};

const ns = (v: number) => (v < 0.1 ? `${(v * 1000).toFixed(0)} ps` : `${v.toFixed(2)} ns`);
const ps = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(2)} ns` : `${v.toFixed(0)} ps`);
const ohm = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)} kΩ` : `${v.toFixed(0)} Ω`);
const fj = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(2)} pJ` : `${v.toFixed(0)} fJ`);
const sci = (b: number) => (b <= 0 || b < 1e-30 ? 'below 10⁻³⁰' : b > 0.1 ? b.toFixed(2) : b.toExponential(0).replace('e-', ' × 10⁻'));

// ---------------------------------------------------------------------------------------------------------------------
// 1. The driver and its load

export function driverWidget(): Widget {
  let lw = 3, c = 100;
  const plot = plotOf({ W: 720, H: 260, x: [0, 1], y: [0, VIO], yTicks: [0, 0.6, 1.2, 1.8], xLabel: 'ps', yLabel: 'volts', aria: 'Output voltage of an inverter discharging a capacitor, against an RC exponential', xFmt: (v) => num(v, 0) });
  const chips = mkChips(4), note = h('p', { class: 'sub mos-note' });
  const paint = () => {
    const w = 2 ** lw, R = rEff(w), tau = (R * c) / 1000, span = 5 * tau;
    const d = discharge(w, c, span, Math.max(0.01, Math.round(span / 120 / 0.01) * 0.01));
    plot.clear();
    plot.setX(span);
    // the lumped model with the effective R: V = VDD · 2^(−t / t50), so it crosses VDD / 2 where the device does
    line(plot, d.t, d.t.map((t) => VIO * 2 ** (-t / d.t50)), 'lump');
    line(plot, d.t, d.v, 'real');
    plot.layer.append(s('line', { x1: plot.X(d.t50), x2: plot.X(d.t50), y1: plot.Y(0), y2: plot.Y(VIO / 2), class: 'ln-h t50' }),
      s('text', { x: plot.X(d.t50) + 4, y: plot.Y(VIO / 2) - 6, class: 'ln-hl t50' }, `t50 = ${ps(d.t50)}`));
    chips.set(0, ohm(R), 'effective R of the driver');
    chips.set(1, `${(iSat(w) / 1000).toFixed(2)} mA`, 'saturation current (output drive)');
    chips.set(2, ps(d.t50), `t50 = ln 2 · R · C = ${ps(rcDelay50(R, c))}`);
    chips.set(3, fj(0.5 * c * VIO * VIO), '½ C V² per transition');
    note.textContent = `Solid: the square-law device discharging ${c} fF. Dashed: a resistor of ${ohm(R)} (the width of the output stage, ${w}×, gives the drive; the unit device alone is ${ohm(unitR())}). `
      + `Small-signal on-resistance is lower, ${ohm(rOn(w))}: the device saturates for the first part of the swing, which an effective R averages in.`;
  };
  const wSl = slider('Width', 0, 8, 1, lw, (v) => `${2 ** v}×`, (v) => { lw = v; paint(); });
  const cSl = slider('Load', 10, 1000, 10, c, (v) => `${v} fF`, (v) => { c = v; paint(); });
  const el = h('div', { class: 'widget mos' }, h('div', { class: 'panel' }, plot.el), h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row' }, wSl.el, cSl.el), note), chips.el);
  paint();
  return { el };
}

// ---------------------------------------------------------------------------------------------------------------------
// 2. A long wire on a chip

export function wireRcWidget(): Widget {
  let lw = 4, len = 2;
  const CL = 4;
  const wf = plotOf({ x: [0, 1], y: [0, 1], yTicks: [0, 0.5, 1], xLabel: 'ps', yLabel: 'V / VDD', aria: 'Voltage at the far end of the wire against time', xFmt: (v) => num(v, 0) });
  const gr = plotOf({ x: [0, 10], y: [0, 8], yTicks: [0, 2, 4, 6, 8], xLabel: 'length (mm)', yLabel: 'delay (ns)', aria: 'Delay against wire length: the driver term grows linearly, the wire term quadratically', xFmt: (v) => num(v, 0) });
  const chips = mkChips(4), note = h('p', { class: 'sub mos-note' });
  const paint = () => {
    const w = 2 ** lw, rd = rEff(w), spec = { rd, len, cl: CL };
    const t = wireDelayTerms(spec), R = len * WIRE_R_PER_MM, C = len * WIRE_C_PER_MM;
    const span = Math.max(3 * t.total, 10), lad = wireLadder(spec, span, span / 200);
    wf.clear();
    wf.setX(span);
    line(wf, lad.t, lad.far, 'real');
    line(wf, lad.t, lad.near, 'lump');
    // the lumped guess: all of Rw and Cw at the driver, one exponential
    const rc = rcStep(rd + R, C + CL, 1, span, span / 100);
    line(wf, rc.t, rc.v, 'lump2');
    wf.layer.append(s('line', { x1: wf.X(t.total), x2: wf.X(t.total), y1: wf.Y(0), y2: wf.Y(0.5), class: 'ln-h t50' }),
      s('text', { x: wf.X(t.total) + 4, y: wf.Y(0.25), class: 'ln-hl t50' }, `${ps(t.total)}`));
    gr.clear();
    const xs: number[] = [], tot: number[] = [], drv: number[] = [], wr: number[] = [];
    for (let l = 0.05; l <= 10.001; l += 0.05) {
      const q = wireDelayTerms({ rd, len: l, cl: CL });
      xs.push(l); tot.push(q.total / 1000); drv.push((q.driver + q.load) / 1000); wr.push(q.wire / 1000);
    }
    line(gr, xs, wr, 'wire'); line(gr, xs, drv, 'drv'); line(gr, xs, tot, 'real');
    gr.layer.append(s('circle', { cx: gr.X(len), cy: gr.Y(Math.min(8, t.total / 1000)), r: 5, class: 'ln-pt' }));
    
    chips.set(0, ps(t.total), `${len.toFixed(1)} mm from a ${w}× driver`);
    chips.set(1, ps(t.driver + t.load), 'driver and load: ln 2 · (Rd · C + Rw · Cl)');
    chips.set(2, ps(t.wire), 'the wire itself: 0.38 · Rw · Cw');
    chips.set(3, `${wireDominates(rd).toFixed(1)} mm`, 'where the wire\'s term passes the driver\'s');
    note.textContent = `${len.toFixed(1)} mm of mid-level metal is ${ohm(R)} and ${C.toFixed(0)} fF (${WIRE_R_PER_MM} Ω and ${WIRE_C_PER_MM} fF per mm, a 28 nm-class illustration). `
      + `Left: the far end from a 40-section ladder. Dashed: the lumped guess, one resistor of ${ohm(rd + R)} charging ${(C + CL).toFixed(0)} fF, overestimates because the far end of the wire is charged through less resistance than the near end. `
      + `Right: doubling the length doubles the driver term and quadruples the wire term.`;
  };
  const wSl = slider('Driver', 0, 8, 1, lw, (v) => `${2 ** v}×`, (v) => { lw = v; paint(); });
  const lSl = slider('Length', 0.1, 10, 0.1, len, (v) => `${v.toFixed(1)} mm`, (v) => { len = v; paint(); });
  const el = h('div', { class: 'widget mos' }, h('div', { class: 'mos-charts' }, h('div', { class: 'panel' }, h('p', { class: 'ln-key' }, h('span', { class: 'k-far' }, 'Far end (40-section ladder)'), h('span', { class: 'k-near' }, 'Near end'), h('span', { class: 'k-lump' }, 'Lumped guess')), wf.el), h('div', { class: 'panel' }, h('p', { class: 'ln-key' }, h('span', { class: 'k-far' }, 'Total'), h('span', { class: 'k-wire' }, 'Wire term'), h('span', { class: 'k-drv' }, 'Driver and load')), gr.el)),
    h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row' }, wSl.el, lSl.el), note), chips.el);
  paint();
  return { el };
}

// ---------------------------------------------------------------------------------------------------------------------
// 3. Repeaters

export function repeaterWidget(): Widget {
  let len = 10, kForce = 0;
  const gr = plotOf({ W: 720, H: 260, x: [0, 20], y: [0, 8], yTicks: [0, 2, 4, 6, 8], xLabel: 'length (mm)', yLabel: 'delay (ns)', aria: 'Delay against length with and without repeaters', xFmt: (v) => num(v, 0) });
  const chips = mkChips(4), strip = h('div', { class: 'ln-rep' }), note = h('p', { class: 'sub mos-note' });
  const opt = repeaterOptimum();
  const paint = () => {
    const best = bestRepeaters(len), k = kForce || best.k, p = kForce ? plan(len, k, opt.h) : best;
    const bare = repeatedDelay(len, 1, opt.h);
    gr.clear();
    const xs: number[] = [], a: number[] = [], b: number[] = [];
    for (let l = 0.25; l <= 20.001; l += 0.25) { xs.push(l); a.push(repeatedDelay(l, 1, opt.h) / 1000); b.push(bestRepeaters(l).delay / 1000); }
    line(gr, xs, a, 'wire'); line(gr, xs, b, 'real');
    gr.layer.append(s('circle', { cx: gr.X(len), cy: gr.Y(Math.min(8, p.delay / 1000)), r: 5, class: 'ln-pt' }),
      s('text', { x: gr.X(20) - 4, y: gr.Y(7.2), 'text-anchor': 'end', class: 'ln-hl wire' }, 'one driver: quadratic'),
      s('text', { x: gr.X(20) - 4, y: gr.Y(b[b.length - 1]) - 12, 'text-anchor': 'end', class: 'ln-hl' }, 'repeaters: linear'));
    strip.replaceChildren(h('span', { class: 'ln-rep-src' }, 'driver'),
      ...Array.from({ length: Math.min(k, 24) }, (_, i) => h('span', { class: 'ln-rep-seg', title: `segment ${i + 1}: ${(len / k).toFixed(2)} mm` }, i < Math.min(k, 24) - 1 ? '▷' : '')),
      h('span', { class: 'ln-rep-load' }, k > 24 ? `${k} segments` : 'load'));
    chips.set(0, `${k} × ${(len / k).toFixed(2)} mm`, kForce ? 'segments you chose' : `segments: the best of 1 … 256 (optimum ${(opt.kPerMm * len).toFixed(1)})`);
    chips.set(1, ps(p.delay), `${ps(bare)} with one driver, ${(bare / p.delay).toFixed(1)}× slower`);
    chips.set(2, `${Math.round(p.area)}`, `unit inverters of area: ${k} repeaters of ${opt.h.toFixed(0)}×`);
    chips.set(3, fj(0.5 * p.switched * VIO * VIO), `½ C V² per transition: wire + ${k} repeaters (wire alone ${fj(0.5 * len * WIRE_C_PER_MM * VIO * VIO)})`);
    note.textContent = `Each repeater is ${opt.h.toFixed(0)}× a unit inverter. By logical effort each stage drives ${p.stageEffort.toFixed(1)}× its own input capacitance (the wire's ${(len * WIRE_C_PER_MM / k).toFixed(0)} fF plus the next repeater's gate, over its own gate): `
      + `a segment is one more stage in an inverter chain, with the wire as the load. The closed-form optimum is ${opt.psPerMm.toFixed(0)} ps per mm for any length, ${(opt.segMm * 1000).toFixed(0)} µm between repeaters.`;
  };
  const lSl = slider('Length', 1, 20, 0.5, len, (v) => `${v.toFixed(1)} mm`, (v) => { len = v; paint(); });
  const kSl = slider('Segments', 0, 40, 1, kForce, (v) => (v ? String(v) : 'best'), (v) => { kForce = v; paint(); });
  const el = h('div', { class: 'widget mos' }, h('div', { class: 'panel' }, gr.el), h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row' }, lSl.el, kSl.el), strip, note), chips.el);
  paint();
  return { el };
}

// ---------------------------------------------------------------------------------------------------------------------
// 4. When lumped thinking fails: a front travelling on a line

export function flightWidget(): Widget {
  let len = 150, rise = 0.3, z0 = Z0_BOARD, tFrac = 0.5;
  const pr = plotOf({ W: 720, H: 260, x: [0, 1], y: [0, VIO], yTicks: [0, 0.6, 1.2, 1.8], xLabel: 'mm along the trace', yLabel: 'volts', aria: 'Voltage along the line at one instant', xFmt: (v) => num(v, 0) });
  const chips = mkChips(4), verdict = h('p', { class: 'sub mos-note' }), tOut = h('output', null);
  const paint = () => {
    const td = boardDelay(len), lumped = isLumped(td, rise), tMax = td + rise + 0.2 * td, t = tFrac * tMax;
    // a source of Z0 into a matched far end: the front launches at V / 2 and meets no reflection
    const l = lattice({ v: VIO, rs: z0, z0, delay: td, rl: z0, rise });
    pr.clear();
    pr.setX(len);
    const xs = Array.from({ length: 201 }, (_, i) => (i / 200) * len);
    line(pr, xs, xs.map((x) => l.at(x / len, t)), 'real');
    // the line as a node would have: every point at the near-end voltage
    line(pr, [0, len], [l.near(t), l.near(t)], 'lump2');
    pr.layer.append(s('text', { x: pr.x1 - 4, y: pr.Y(l.near(t)) - 5, 'text-anchor': 'end', class: 'ln-hl' }, 'a node: one voltage everywhere'));
    tOut.textContent = ns(t);
    const { l: lp, c: cp } = lcOf(z0);
    chips.set(0, ns(td), `one-way delay of ${len} mm (${PCB_PS_PER_MM} ps / mm)`);
    chips.set(1, `${criticalLength(rise).toFixed(0)} mm`, `longest trace that is still a node for a ${ns(rise)} edge`);
    chips.set(2, `${z0} Ω`, `√(L′ / C′) with L′ = ${lp.toFixed(0)} nH/m, C′ = ${cp.toFixed(0)} pF/m`);
    chips.set(3, lumped ? 'a node' : 'a line', lumped ? 'delay ≤ rise / 6: draw it as one wire' : 'delay > rise / 6: the voltage depends on where and when', lumped ? 'ok' : 'bad');
    verdict.textContent = lumped
      ? `The edge takes ${ns(rise)}, the signal ${ns(td)} to cross: by the time the edge is over, the whole trace has followed it. The trace is a node with a capacitance, and chapter 41's earlier steps apply.`
      : `The edge is ${((rise / td) * 100).toFixed(0)} % of the flight time: the near end is already high while the far end has not yet heard of it. The line carries a front, ${((rise * 1000) / PCB_PS_PER_MM).toFixed(0)} mm long, at ${(1000 / PCB_PS_PER_MM / 1).toFixed(0)} mm/ns.`;
  };
  const lSl = slider('Length', 5, 600, 5, len, (v) => `${v} mm`, (v) => { len = v; paint(); });
  const rSl = slider('Edge', 0.05, 3, 0.05, rise, (v) => ns(v), (v) => { rise = v; paint(); });
  const zSl = slider('Z₀', 25, 100, 5, z0, (v) => `${v} Ω`, (v) => { z0 = v; paint(); });
  const tSl = slider('Time', 0, 1, 0.01, tFrac, () => '', (v) => { tFrac = v; paint(); });
  tSl.el.querySelector('output')!.replaceWith(tOut);
  const el = h('div', { class: 'widget mos' }, h('div', { class: 'panel' }, pr.el), h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row' }, lSl.el, rSl.el, zSl.el, tSl.el), verdict), chips.el);
  paint();
  return { el };
}

// ---------------------------------------------------------------------------------------------------------------------
// 5. Reflections (the mockup's frame)

const lineSpec = (rs: number, rl: number, lenMm: number, rise: number): LineSpec => ({ v: VIO, rs, z0: Z0_BOARD, delay: boardDelay(lenMm), rl, rise });

export function reflectionWidget(): Widget {
  let rs = 10, len = 150, rise = 0.2, rl = Infinity;
  const pl = plotOf({ W: 720, H: 270, x: [0, 16], y: [-0.4, 3.6], yTicks: [0, 1, 2, 3], xLabel: 'ns', yLabel: 'volts', aria: 'Voltage at the near and far ends of the line against time' });
  const chips = mkChips(4), key = h('p', { class: 'ln-key' }, h('span', { class: 'k-near' }, 'Near end (at the driver)'), h('span', { class: 'k-far' }, 'Far pin'));
  const sel = h('select', { 'aria-label': 'Far end' }, h('option', { value: 'open' }, 'Open CMOS input'), h('option', { value: '50' }, '50 Ω to ground'), h('option', { value: '150' }, '150 Ω to ground')) as HTMLSelectElement;
  const note = h('p', { class: 'sub mos-note' });
  let rsSl: ReturnType<typeof slider>;
  const paint = () => {
    const spec = lineSpec(rs, rl, len, rise), l = lattice(spec), td = spec.delay;
    const tMax = Math.max(6, 16 * td + 2 * rise);
    pl.clear();
    pl.setX(tMax);
    const n = 600, ts = Array.from({ length: n + 1 }, (_, i) => (i * tMax) / n);
    hline(pl, VIH, 'VIH'); hline(pl, VIL, 'VIL');
    line(pl, ts, ts.map((t) => l.near(t)), 'near');
    line(pl, ts, ts.map((t) => l.far(t)), 'real');
    const st = farStats(l, tMax, VIH, VIL, 0.05);
    chips.set(0, `${l.firstFar.toFixed(2)} V`, 'first wave at the far pin: V·Z₀/(Z₀+Rs) · (1+Γ)');
    chips.set(1, `${st.peak.toFixed(2)} V`, st.overshoot > 0.1 ? `+${st.overshoot.toFixed(2)} V over its final value ${l.final.toFixed(2)} V (an ESD clamp would carry it)` : `final value ${l.final.toFixed(2)} V`, st.overshoot > 0.1 ? 'bad' : '');
    chips.set(2, st.firstHigh === null ? 'never' : ns(st.firstHigh), st.fallBacks ? `crosses VIH, then falls back ${st.fallBacks}×: a double clock` : 'first crossing of VIH', st.fallBacks || st.firstHigh === null ? 'bad' : 'ok');
    chips.set(3, ns(st.settle), `settled within 5 % · flight time ${ns(td)}`);
    note.textContent = `Γ at the driver ${l.gammaS.toFixed(2)}, at the far end ${l.gammaL.toFixed(2)}: each trip down the line multiplies the wave by Γ_far · Γ_driver = ${(l.gammaS * l.gammaL).toFixed(2)}.`
      + (Number.isFinite(rl) ? '' : ` Smallest Rs that holds the far pin above VIH after its first crossing, for this edge and length: ${minRsStaysHigh(VIO, Z0_BOARD, td, rise) ?? 'none'} Ω.`);
  };
  const rsS = slider('Rs', 5, 150, 1, rs, (v) => `${v} Ω`, (v) => { rs = v; paint(); });
  rsSl = rsS;
  const lS = slider('Length', 50, 600, 10, len, (v) => `${v / 10} cm`, (v) => { len = v; paint(); });
  const tS = slider('Edge', 0.05, 2, 0.05, rise, (v) => ns(v), (v) => { rise = v; paint(); });
  sel.addEventListener('change', () => { rl = sel.value === 'open' ? Infinity : +sel.value; paint(); });
  const preset = (label: string, r: number, far: string) => h('button', { type: 'button', class: 'btn', onclick: () => { rs = r; rsSl.set(r); sel.value = far; rl = far === 'open' ? Infinity : +far; paint(); } }, label);
  const el = h('div', { class: 'widget mos' }, h('div', { class: 'panel' }, key, pl.el),
    h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row' }, rsS.el, lS.el, tS.el, h('label', { class: 'mos-sl ln-sel' }, h('span', null, 'Far end'), sel)),
      h('div', { class: 'ln-presets' }, preset('Strong driver', 10, 'open'), preset('Series terminated', 50, 'open'), preset('Parallel terminated', 5, '50')), note), chips.el);
  paint();
  return { el };
}

// ---------------------------------------------------------------------------------------------------------------------
// 6. Termination

export function terminationWidget(): Widget {
  let len = 150, rise = 0.2;
  const RD = 10;
  const schemes = [
    { name: 'None', note: 'driver 10 Ω, open end', rs: RD, rl: Infinity },
    { name: 'Series', note: `${seriesResistor(RD, Z0_BOARD)} Ω at the driver`, rs: Z0_BOARD, rl: Infinity },
    { name: 'Parallel', note: '50 Ω to ground at the far end', rs: RD, rl: Z0_BOARD },
  ];
  const plots = schemes.map(() => plotOf({ W: 300, H: 190, x: [0, 12], y: [-0.4, 3.6], yTicks: [0, 1, 2, 3], xLabel: 'ns', yLabel: 'volts', aria: 'Near and far voltage' }));
  const tbl = h('div', { class: 'ln-tbl' });
  const note = h('p', { class: 'sub mos-note' });
  const paint = () => {
    const rows: Record<string, string[]> = { 'Far pin first above VIH': [], 'Settled to 5 %': [], 'Overshoot': [], 'Falls back below VIH': [], 'Driver sees first': [], 'Static power while high': [], 'Needs': [] };
    schemes.forEach((sc, i) => {
      const l = lattice(lineSpec(sc.rs, sc.rl, len, rise)), td = boardDelay(len), tMax = Math.max(6, 16 * td + 2 * rise);
      const p = plots[i];
      p.clear();
      p.setX(tMax);
      const ts = Array.from({ length: 401 }, (_, k) => (k * tMax) / 400);
      hline(p, VIH, 'VIH'); hline(p, VIL, 'VIL');
      line(p, ts, ts.map((t) => l.near(t)), 'near'); line(p, ts, ts.map((t) => l.far(t)), 'real');
      const st = farStats(l, tMax, VIH, VIL);
      rows['Far pin first above VIH'].push(st.firstHigh === null ? 'never' : ns(st.firstHigh));
      rows['Settled to 5 %'].push(ns(st.settle));
      rows['Overshoot'].push(st.overshoot < 0.02 ? 'none' : `${st.overshoot.toFixed(2)} V`);
      rows['Falls back below VIH'].push(st.fallBacks ? `${st.fallBacks}×` : 'no');
      rows['Driver sees first'].push(`${l.launch.toFixed(2)} V for ${ns(2 * td)}`);
      rows['Static power while high'].push(Number.isFinite(sc.rl) ? `${(parallelPower(VIO, sc.rs, sc.rl) * 1000).toFixed(0)} mW` : '0');
      rows['Needs'].push(sc.note);
    });
    tbl.replaceChildren(h('table', { class: 'mini ln-table' }, h('tr', null, h('th', null, ''), ...schemes.map((x) => h('th', null, x.name))),
      ...Object.entries(rows).map(([k, v]) => h('tr', null, h('th', null, k), ...v.map((x) => h('td', null, x))))));
    const flight = boardDelay(len);
    note.textContent = `Series: nothing flows once the line has charged, the far pin steps cleanly after one flight (${ns(flight)}) plus the edge, and the price is that the driver's own pin sits at half the swing for a round trip (${ns(2 * flight)}); any receiver along the line sees that half-swing first. `
      + `Parallel: the line is quiet and every receiver sees the final edge at once, and the price is a DC path, ${(parallelPower(VIO, RD, Z0_BOARD) * 1000).toFixed(0)} mW per line while it is held high. At 100 lines that is the power of the chip.`;
  };
  const lS = slider('Length', 50, 600, 10, len, (v) => `${v / 10} cm`, (v) => { len = v; paint(); });
  const rS = slider('Edge', 0.05, 2, 0.05, rise, (v) => ns(v), (v) => { rise = v; paint(); });
  const el = h('div', { class: 'widget mos ln-term' }, h('div', { class: 'ln-plots' }, ...plots.map((p, i) => h('div', { class: 'panel' }, h('h4', null, schemes[i].name), p.el))),
    h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row' }, lS.el, rS.el), note), h('div', { class: 'panel ln-scroll' }, tbl));
  paint();
  return { el };
}

// ---------------------------------------------------------------------------------------------------------------------
// 7. Crosstalk and ground bounce, a differential pair, an eye

/** Peak current of a pad driving the 50 Ω line (A): VIO / (Rd + Z0). */
export const padSwing = (): number => VIO / (padDriveOhms() + Z0_BOARD);

export function noiseWidget(): Widget {
  let sh = 1, len = 100, rise = 0.2, gbr = 1, n = 8, lnh = 3, cm = 0.3, cmrr = 40, mis = 2, rate = 1, bw = 0.5, sig = 60;
  const xt = plotOf({ W: 340, H: 190, x: [0, 2], y: [-60, 160], yTicks: [-50, 0, 50, 100, 150], xLabel: 'ns', yLabel: 'mV', aria: 'Crosstalk on a quiet victim line, near and far end', xFmt: (v) => num(v, 1), yFmt: (v) => num(v, 0) });
  const xtChips = mkChips(4), gbChips = mkChips(3), dfChips = mkChips(4), eyeChips = mkChips(4);
  const dfBars = h('div', { class: 'ln-bars' });
  const eyePlot = plotOf({ W: 340, H: 190, x: [0, 2], y: [-1.3, 1.3], yTicks: [-1, 0, 1], xLabel: 'unit intervals', yLabel: 'swing', aria: 'Eye diagram of a pseudo-random pattern through a single-pole channel', xFmt: (v) => num(v, 1), yFmt: (v) => num(v, 1) });
  const bits = prbs(9, 1022);

  const paintXt = () => {
    const { kl, kc } = coupling(sh), td = boardDelay(len), x = crosstalk({ v: VIO, rise, delay: td, kc, kl });
    xt.clear();
    const T = 2, ts = Array.from({ length: 401 }, (_, i) => (i * T) / 400);
    // the pulse sits on a time axis in ns; long runs are clipped by the axis
    const top = Math.max(x.next, x.fext, 0.05) * 1150, bot = Math.min(x.next, x.fext, 0) * 1150;
    xt.setY(Math.min(-20, bot), Math.max(60, top));
    line(xt, ts, ts.map((t) => x.nearAt(t) * 1000), 'near'); line(xt, ts, ts.map((t) => x.farAt(t) * 1000), 'real');
    xt.layer.append(s('text', { x: xt.X(T) - 4, y: xt.Y(Math.min(-20, bot)) - 6, 'text-anchor': 'end', class: 'ln-hl' }, `near-end pulse lasts ${ns(x.nextWidth)}`));
    xtChips.set(0, `${(x.next * 1000).toFixed(0)} mV`, `near end: Kb = ¼ (kc + kl) = ${x.kb.toFixed(3)}, ${((x.next / VIL) * 100).toFixed(0)} % of VIL`, x.next > VIL / 2 ? 'bad' : '');
    xtChips.set(1, `${(x.fext * 1000).toFixed(0)} mV`, `far end: ½ (kc − kl) · delay / edge · V (negative: inductive coupling wins)`);
    xtChips.set(2, `${kl.toFixed(2)} / ${kc.toFixed(2)}`, 'coupling kl = Lm/L, kc = Cm/C at this spacing');
    xtChips.set(3, ns(td), 'flight time of the parallel run');
  };
  const paintGb = () => {
    const i = padSwing(), v = groundBounce(n, i, gbr, lnh);
    gbChips.set(0, `${(i * 1000).toFixed(1)} mA`, `each pad: ${VIO} V / (${padDriveOhms().toFixed(0)} Ω driver + ${Z0_BOARD} Ω line)`);
    gbChips.set(1, `${v.toFixed(2)} V`, `L · n · di/dt for ${n} pads at once through ${lnh} nH in ${ns(gbr)}`, v > VIL ? 'bad' : '');
    gbChips.set(2, v > VIL ? 'a 0 reads as a 1' : `${(v / VIL * 100).toFixed(0)} % of VIL`, v > VIL ? 'the chip\'s ground has lifted past VIL: a quiet low output is read high' : 'of the low-level noise margin');
  };
  const paintDf = () => {
    const d = differential({ amp: 0.2, common: cm, mismatch: mis / 100, cmrrDb: cmrr, offset: 0.005, vcm: 0.9, range: [0.2, 1.6] });
    const bar = (label: string, v: number, ref: number) => h('div', { class: 'ln-bar' }, h('span', null, label),
      h('div', { class: 'ln-barbox' }, h('i', { class: v > 0 ? 'ok' : 'bad', style: `width:${Math.min(100, Math.max(2, (Math.abs(v) / ref) * 100))}%` })), h('b', { class: v > 0 ? 'ok' : 'bad' }, `${v >= 0 ? '+' : '−'}${Math.abs(v * 1000).toFixed(0)} mV`));
    dfBars.replaceChildren(bar('Single-ended margin', d.singleMargin, 0.4), bar('Differential margin', d.diffMargin, 0.4));
    dfChips.set(0, `${(d.singleNoise * 1000).toFixed(0)} mV`, 'noise at the single-ended receiver: all of it');
    dfChips.set(1, `${(d.diffNoise * 1000).toFixed(0)} mV`, `left at the differential receiver: ${(mis).toFixed(0)} % leg mismatch + CMRR ${cmrr} dB + 5 mV offset`);
    dfChips.set(2, Number.isFinite(d.rejectionDb) ? `${d.rejectionDb.toFixed(0)} dB` : '∞', 'rejection achieved');
    dfChips.set(3, d.inRange ? 'in range' : 'out of range', d.inRange ? 'common mode stays inside the receiver\'s input range' : 'noise pushes the common mode out of the receiver\'s range: CMRR no longer holds', d.inRange ? 'ok' : 'bad');
  };
  const paintEye = () => {
    const e = eye(bits, { rate, bandwidth: bw }), p = eyePlot, S = e.spu;
    p.clear();
    const u = rng(12345), g = p.layer.appendChild(s('g', { class: 'ln-eye' }));
    const start = e.phase - S;
    for (let i = 20; i < 170; i++) {
      let d = '';
      const off = sig * gaussian(u) / 1000;
      for (let j = 0; j <= 2 * S; j += 2) {
        const idx = i * S + start + j;
        d += `${j ? 'L' : 'M'}${p.X(j / S).toFixed(1)},${p.Y(e.wave[idx] + off * 0.6 + sig * 0.8 * gaussian(u) / 1000).toFixed(1)}`;
      }
      g.append(s('path', { d, class: 'ln-s eyeline' }));
    }
    const open = Math.max(e.opening, 0), q = qOf(open, sig / 1000), ber = e.opening <= 0 ? 0.5 : berOf(open / 2, sig / 1000);
    if (open > 0) p.layer.append(s('line', { x1: p.X(1), x2: p.X(1), y1: p.Y(e.lowOne), y2: p.Y(e.highZero), class: 'ln-open' }));
    eyeChips.set(0, e.opening > 0 ? `${(e.opening * 50).toFixed(0)} %` : 'closed', 'vertical opening of the ±1 swing', e.opening > 0 ? '' : 'bad');
    eyeChips.set(1, `${e.ui.toFixed(0)} ps`, `bit period at ${rate} Gb/s · bandwidth ${bw} GHz`);
    eyeChips.set(2, Number.isFinite(q) ? q.toFixed(1) : '∞', 'Q = half the opening / σ');
    eyeChips.set(3, sci(ber), 'BER = ½ erfc(Q / √2)', ber > 1e-12 ? 'bad' : 'ok');
  };
  const sl = (label: string, a: number, b: number, st: number, v: number, fmt: (x: number) => string, f: (x: number) => void) => slider(label, a, b, st, v, fmt, (x) => f(x)).el;
  const sec = (title: string, lead: string, ...kids: (Node | string)[]) => h('div', { class: 'panel ln-sec' }, h('h4', null, title), h('p', { class: 'sub' }, lead), ...kids);
  const el = h('div', { class: 'widget mos ln-noise' },
    sec('Crosstalk', 'An aggressor edge on one trace, a quiet neighbour.',
      xt.el, h('div', { class: 'mos-row' }, sl('Spacing', 0.5, 5, 0.1, sh, (v) => `${v.toFixed(1)}·h`, (v) => { sh = v; paintXt(); }), sl('Run', 10, 300, 10, len, (v) => `${v} mm`, (v) => { len = v; paintXt(); }),
        sl('Edge', 0.05, 2, 0.05, rise, ns, (v) => { rise = v; paintXt(); })), xtChips.el),
    sec('Ground bounce', 'Pads that switch together share one return path.',
      h('div', { class: 'mos-row' }, sl('Pads', 1, 32, 1, n, (v) => String(v), (v) => { n = v; paintGb(); }), sl('L', 0.5, 10, 0.5, lnh, (v) => `${v} nH`, (v) => { lnh = v; paintGb(); }), sl('Edge', 0.1, 4, 0.1, gbr, ns, (v) => { gbr = v; paintGb(); })), gbChips.el),
    sec('A differential pair', 'The same noise on both legs; the receiver subtracts them.',
      dfBars, h('div', { class: 'mos-row' }, sl('Common', 0, 1, 0.05, cm, (v) => `${v.toFixed(2)} V`, (v) => { cm = v; paintDf(); }), sl('CMRR', 20, 80, 5, cmrr, (v) => `${v} dB`, (v) => { cmrr = v; paintDf(); }), sl('Mismatch', 0, 20, 1, mis, (v) => `${v} %`, (v) => { mis = v; paintDf(); })), dfChips.el),
    sec('What noise does to a bit', 'A pseudo-random pattern through a single-pole channel; chapter 46 reads this picture in depth.',
      eyePlot.el, h('div', { class: 'mos-row' }, sl('Rate', 0.2, 4, 0.1, rate, (v) => `${v.toFixed(1)} Gb/s`, (v) => { rate = v; paintEye(); }), sl('Bandwidth', 0.1, 4, 0.05, bw, (v) => `${v.toFixed(2)} GHz`, (v) => { bw = v; paintEye(); }), sl('Noise', 0, 200, 5, sig, (v) => `${v} mV`, (v) => { sig = v; paintEye(); })), eyeChips.el));
  paintXt(); paintGb(); paintDf(); paintEye();
  return { el };
}

// ---------------------------------------------------------------------------------------------------------------------
// 8. The wire between two pads: the panel beside the schematic

export interface PadLinkState { rs: number; len: number; last: 'rise' | 'fall' | null; contention: boolean }
const padStates = new WeakMap<Stage, PadLinkState>();
export const padLinkState = (st: Stage): PadLinkState | undefined => padStates.get(st);

const PAD_RISE = (r: number) => (2.2 * r * PAD_PIN_FF) / 1e6; // 10-90 % of the pin RC, ns

function padPanel(): ScenePanel {
  return (stage: Stage): Widget => {
    const st: PadLinkState = { rs: 0, len: 150, last: null, contention: false };
    padStates.set(stage, st);
    const pl = plotOf({ W: 340, H: 180, x: [0, 8], y: [-0.4, 3.6], yTicks: [0, 1, 2, 3], xLabel: 'ns', yLabel: 'volts', aria: 'Voltage at the driving pad and at the far pad after the last edge' });
    const chips = mkChips(4), status = h('p', { class: 'sub ln-status' });
    const title = h('h4', null, 'The wire: a model', h('span', { class: 'fold-hint' }));
    const lenOut = slider('Trace', 20, 600, 10, st.len, (v) => `${v / 10} cm`, (v) => { st.len = v; draw(); });
    const rsOut = slider('Series R', 0, 100, 1, st.rs, (v) => `${v} Ω`, (v) => { st.rs = v; draw(); });
    const el = h('div', { class: 'mem-panel ln-panel', 'data-dock': 'left', 'data-phone': 'flow' }, title, status, pl.el, h('div', { class: 'ln-pctl' }, lenOut.el, rsOut.el), chips.el);
    title.addEventListener('click', () => el.classList.toggle('collapsed'));
    let prev: { d: number; en: number; rd: number; ren: number; line: number } | null = null;
    let level = 0; // what the wire held before this edge (0 or 1)
    let edge: 'rise' | 'fall' | null = null, from: 'A' | 'B' = 'A';
    const draw = () => {
      const rDrv = padDriveOhms(PAD_FINAL), rs = rDrv + st.rs, tr = PAD_RISE(rs);
      const td = boardDelay(st.len);
      pl.clear();
      hline(pl, VIH, 'VIH'); hline(pl, VIL, 'VIL');
      if (!edge) {
        status.textContent = st.contention ? 'Both output stages are on and disagree.' : 'Drive d or rd to launch an edge: this panel plots the voltage at both pads.';
        chips.set(0, ohm(rDrv), `source: the ${PAD_FINAL}× output stage's effective resistance`);
        chips.set(1, ns(td), 'flight time'); chips.set(2, ns(tr), 'edge the pin\'s RC allows'); chips.set(3, st.contention ? 'fight' : '–', st.contention ? `${(VIO / (2 * rDrv) * 1000).toFixed(0)} mA through both stages` : '', st.contention ? 'bad' : '');
        return;
      }
      const l = lattice({ v: VIO, rs, z0: Z0_BOARD, delay: td, rl: Infinity, rise: tr });
      const tMax = Math.max(8, 14 * td + 2 * tr);
      pl.setX(tMax);
      const sgn = edge === 'rise' ? (v: number) => v : (v: number) => VIO - v;
      const ts = Array.from({ length: 401 }, (_, k) => (k * tMax) / 400);
      line(pl, ts, ts.map((t) => sgn(l.near(t))), 'near');
      line(pl, ts, ts.map((t) => sgn(l.far(t))), 'real');
      const sf = farStats(l, tMax, VIH, VIL);
      status.textContent = `${from === 'A' ? 'Chip A' : 'Chip B'} drives a ${edge === 'rise' ? 'rising' : 'falling'} edge into the trace; the other pad is an open CMOS input. ${edge === 'fall' ? 'The falling edge is the mirror image of the rising one.' : ''}`;
      chips.set(0, ohm(rs), `source R = ${ohm(rDrv)} output stage${st.rs ? ` + ${st.rs} Ω series` : ''}`);
      chips.set(1, `${l.launch.toFixed(2)} V`, `launched: ${VIO} V · ${Z0_BOARD} / (${Z0_BOARD} + ${rs.toFixed(0)})`);
      chips.set(2, `${sf.peak.toFixed(2)} V`, sf.overshoot > 0.1 ? `far pad overshoots ${sf.overshoot.toFixed(2)} V` : 'far pad peak', sf.overshoot > 0.1 ? 'bad' : '');
      chips.set(3, sf.firstHigh === null ? 'never' : ns(sf.firstHigh), sf.fallBacks ? `then falls back ${sf.fallBacks}×` : `far pad above VIH · edge ${ns(tr)} · flight ${ns(td)}`, sf.fallBacks ? 'bad' : 'ok');
      st.last = edge;
    };
    const update = () => {
      const sim = stage.sim;
      if (!sim) return;
      const cur = { d: stage.value('d'), en: stage.value('en'), rd: stage.value('rd'), ren: stage.value('ren'), line: stage.value('line') };
      const swSim = sim as unknown as { hasShort?: boolean };
      st.contention = !!swSim.hasShort;
      if (prev) {
        const aDrives = cur.en === 1 && cur.ren !== 1, bDrives = cur.ren === 1 && cur.en !== 1;
        if (!st.contention && ((aDrives && (cur.d !== prev.d || prev.en !== 1)) || (bDrives && (cur.rd !== prev.rd || prev.ren !== 1)))) {
          const target = aDrives ? cur.d : cur.rd;
          if (target === 0 || target === 1) {
            if (cur.line === target || cur.line === -1) { edge = target ? 'rise' : 'fall'; from = aDrives ? 'A' : 'B'; level = target; }
          }
        }
      }
      void level;
      prev = cur;
      draw();
    };
    stage.historyHooks.add({ save: () => ({ edge, from }), restore: (v) => { const o = v as { edge: typeof edge; from: typeof from }; edge = o.edge; from = o.from; draw(); } });
    update();
    return { el, update };
  };
}

export function padScene(): Scene {
  return { root: PAD_LINK, inputs: { d: 0, en: 1, rd: 0, ren: 0 }, panels: [padPanel()] };
}

