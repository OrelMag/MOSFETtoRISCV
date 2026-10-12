// Pieces shared by the MOSFET widgets: the I–V charts (drawn to scale from mosphys.ts, with volt and
// µA ticks), a slider row and the readout chips.

import { h, s } from '../ui/dom';
import { current, type Region, VDD, VT } from './mosphys';

/** Top of every current axis: the largest current the device reaches, plus headroom. */
export const I_MAX = current(VDD - VT, VDD).id * 1.06;

interface Axes { X: (v: number) => number; Y: (i: number) => number; svg: SVGSVGElement; xl: SVGTextElement }

function axes(W: number, H: number, xLabel: string, label: string): Axes {
  const m = { l: 54, r: 12, t: 12, b: 34 };
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'mos-plot', role: 'img', 'aria-label': label }) as SVGSVGElement;
  const X = (v: number) => m.l + (v / VDD) * (W - m.l - m.r);
  const Y = (i: number) => H - m.b - (i / I_MAX) * (H - m.t - m.b);
  for (let v = 0; v <= VDD + 1e-9; v += 0.3) {
    svg.append(s('line', { x1: X(v), x2: X(v), y1: m.t, y2: H - m.b, class: 'grid' }),
      s('text', { x: X(v), y: H - m.b + 14, 'text-anchor': 'middle', class: 'tick' }, v.toFixed(1)));
  }
  for (let i = 0; i <= I_MAX; i += 50) {
    svg.append(s('line', { x1: m.l, x2: W - m.r, y1: Y(i), y2: Y(i), class: 'grid' }),
      s('text', { x: m.l - 6, y: Y(i) + 3.5, 'text-anchor': 'end', class: 'tick' }, String(i)));
  }
  const xl = s('text', { x: W - m.r, y: H - 4, 'text-anchor': 'end', class: 'axl' }, xLabel);
  svg.append(s('line', { x1: m.l, x2: W - m.r, y1: H - m.b, y2: H - m.b, class: 'ax' }), s('line', { x1: m.l, x2: m.l, y1: m.t, y2: H - m.b, class: 'ax' }),
    xl, s('text', { x: 6, y: m.t, 'text-anchor': 'end', 'dominant-baseline': 'hanging', transform: `rotate(-90 6 ${m.t})`, class: 'axl' }, 'Id (µA)'));
  return { X, Y, svg, xl };
}

const curvePath = (f: (v: number) => number, X: (v: number) => number, Y: (i: number) => number) => {
  let d = '';
  for (let v = 0; v <= VDD + 1e-9; v += 0.01) d += `${d ? 'L' : 'M'}${X(v).toFixed(1)},${Y(f(v)).toFixed(1)}`;
  return d;
};

export interface IvChart {
  el: SVGSVGElement;
  /** drive = Vgs (Vsg for PMOS), vds = Vds (Vsd), both magnitudes; p swaps the axis names. */
  paint(drive: number, vds: number, p: boolean): void;
}

/** Id against the gate drive at the present drain voltage, threshold marked. */
export function idVgsChart(W = 320, H = 190): IvChart {
  const { X, Y, svg, xl } = axes(W, H, 'Vgs (V)', 'Drain current against gate voltage');
  svg.append(s('line', { x1: X(VT), x2: X(VT), y1: 12, y2: H - 34, class: 'vt' }), s('text', { x: X(VT) + 4, y: 22, class: 'tick' }, 'Vt'));
  const cur = svg.appendChild(s('path', { class: 'cur' })), op = svg.appendChild(s('circle', { r: 5, class: 'op' }));
  let lastVds = NaN;
  return {
    el: svg,
    paint(drive, vds, p) {
      xl.textContent = p ? 'Vsg (V)' : 'Vgs (V)';
      if (vds !== lastVds) { cur.setAttribute('d', curvePath((v) => current(v - VT, vds).id, X, Y)); lastVds = vds; }
      op.setAttribute('cx', String(X(drive)));
      op.setAttribute('cy', String(Y(current(drive - VT, vds).id)));
    },
  };
}

/** The output characteristics: Id against Vds for five gate voltages, the pinch-off boundary Vds = Vgs − Vt
 *  dashed, the present gate's curve and operating point on top. `big` shades and names the regions. */
export function idVdsChart(W = 320, H = 190, big = false): IvChart {
  const { X, Y, svg, xl } = axes(W, H, 'Vds (V)', 'Drain current against drain voltage');
  let bound = `M${X(0)},${Y(0)}`;
  for (let v = 0; v <= VDD - VT + 1e-9; v += 0.02) bound += ` L${X(v).toFixed(1)},${Y(current(v, v).id).toFixed(1)}`;
  const top = Y(I_MAX - 1e-9);
  if (big) {
    // Left of the boundary is linear, right of it saturation, up to the top of the chart.
    svg.append(s('path', { d: `${bound} L${X(VDD - VT)},${top} L${X(0)},${top} Z`, class: 'rg-lin' }),
      s('path', { d: `${bound} L${X(VDD - VT)},${top} L${X(VDD)},${top} L${X(VDD)},${Y(0)} Z`, class: 'rg-sat' }),
      s('text', { x: X(0.1), y: Y(I_MAX * 0.9), class: 'rl lin' }, 'linear: a resistor'),
      s('text', { x: X(1.12), y: Y(100), class: 'rl sat' }, 'saturation: a current source'),
      // In the clear band between the 1.5 V and 1.8 V curves, just right of the boundary.
      s('text', { x: X(1.3), y: Y(178), class: 'rl sat' }, '← pinch-off'));
  }
  for (const vg of [0.6, 0.9, 1.2, 1.5, 1.8]) {
    svg.append(s('path', { d: curvePath((v) => current(vg - VT, v).id, X, Y), class: 'fam' }));
    if (big) svg.append(s('text', { x: X(VDD) - 2, y: Y(current(vg - VT, VDD).id) - 5, 'text-anchor': 'end', class: 'tick fam-l' }, `${vg.toFixed(1)} V`));
  }
  svg.append(s('path', { d: bound, class: 'bound' }));
  const cur = svg.appendChild(s('path', { class: 'cur' })), op = svg.appendChild(s('circle', { r: big ? 6 : 5, class: 'op' }));
  let lastDrive = NaN;
  return {
    el: svg,
    paint(drive, vds, p) {
      xl.textContent = p ? 'Vsd (V)' : 'Vds (V)';
      if (drive !== lastDrive) { cur.setAttribute('d', curvePath((v) => current(drive - VT, v).id, X, Y)); lastDrive = drive; }
      op.setAttribute('cx', String(X(vds)));
      op.setAttribute('cy', String(Y(current(drive - VT, vds).id)));
    },
  };
}

/** A labelled slider with its value; `set` moves it without firing input. */
export function slider(label: string, min: number, max: number, step: number, value: number, fmt: (v: number) => string, onInput: (v: number) => void) {
  const input = h('input', { type: 'range', min, max, step, value, 'aria-label': label }) as HTMLInputElement;
  const out = h('output', null, fmt(value));
  input.addEventListener('input', () => { out.textContent = fmt(Number(input.value)); onInput(Number(input.value)); });
  return {
    el: h('label', { class: 'mos-sl' }, h('span', null, label), input, out),
    set(v: number) { input.value = String(v); out.textContent = fmt(v); },
  };
}

const REGION: Record<Region, string> = { cut: 'cut-off', lin: 'linear', sat: 'saturation' };

/** Four readout chips: drive, drain voltage, current, and on / off with the region as a pill. */
export function chips() {
  const cell = () => { const b = h('b'), sp = h('span'); return { b, sp, el: h('div', null, b, sp) }; };
  const c = [cell(), cell(), cell(), cell()];
  const pill = h('span', { class: 'mos-pill' });
  c[3].sp.replaceWith(pill);
  return {
    el: h('div', { class: 'mos-chips' }, ...c.map((x) => x.el)),
    paint(drive: number, vds: number, p: boolean) {
      const { id, kind } = current(drive - VT, vds);
      c[0].b.textContent = `${drive.toFixed(2)} V`;
      c[0].sp.textContent = p ? 'Vsg (source − gate)' : 'Vgs (gate − source)';
      c[1].b.textContent = `${vds.toFixed(2)} V`;
      c[1].sp.textContent = p ? 'Vsd (source − drain)' : 'Vds (drain − source)';
      c[2].b.textContent = id < 0.05 ? '0 µA' : `${id.toFixed(0)} µA`;
      c[2].sp.textContent = 'drain current';
      c[3].b.textContent = kind === 'cut' ? 'OFF' : 'ON';
      pill.textContent = REGION[kind];
      pill.className = `mos-pill ${kind}`;
    },
  };
}
