// Chapter 2's "The voltage in between": the inverter's transfer curve from phys/inverter.ts, a Vin slider with the
// output and the region of each device, and the noise margins at a movable PMOS width. The model is the chapter-1
// square-law device; the simulator below it is switch level (0 / 1 / X) and does not change.

import { h, s } from '../ui/dom';
import { curve, metrics, MOBILITY_RATIO, point, strength } from '../phys/inverter';
import type { Widget } from '../view/stage';
import { VDD } from './mosphys';
import { fitText, slider } from './mosparts';

const W = 560, H = 320, M = { l: 50, r: 14, t: 14, b: 38 };
const REGION = { cut: 'off', lin: 'linear', sat: 'saturation' } as const;

export function vtcWidget(): Widget {
  let wr = MOBILITY_RATIO, vin = 0.6;
  const X = (v: number) => M.l + (v / VDD) * (W - M.l - M.r);
  const Y = (v: number) => H - M.b - (v / VDD) * (H - M.t - M.b);
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'mos-plot', role: 'img', 'aria-label': 'Inverter output voltage against input voltage' }) as SVGSVGElement;
  fitText(svg, W);
  for (let v = 0; v <= VDD + 1e-9; v += 0.3) {
    svg.append(s('line', { x1: X(v), x2: X(v), y1: M.t, y2: H - M.b, class: 'grid' }), s('text', { x: X(v), y: H - M.b + 14, 'text-anchor': 'middle', class: 'tick' }, v.toFixed(1)),
      s('line', { x1: M.l, x2: W - M.r, y1: Y(v), y2: Y(v), class: 'grid' }), s('text', { x: M.l - 6, y: Y(v) + 3.5, 'text-anchor': 'end', class: 'tick' }, v.toFixed(1)));
  }
  svg.append(s('line', { x1: M.l, x2: W - M.r, y1: H - M.b, y2: H - M.b, class: 'ax' }), s('line', { x1: M.l, x2: M.l, y1: M.t, y2: H - M.b, class: 'ax' }),
    s('line', { x1: X(0), y1: Y(0), x2: X(VDD), y2: Y(VDD), class: 'vt' }),
    s('text', { x: W - M.r, y: H - 4, 'text-anchor': 'end', class: 'axl' }, 'Vin (V)'),
    s('text', { x: 6, y: M.t, 'text-anchor': 'end', 'dominant-baseline': 'hanging', transform: `rotate(-90 6 ${M.t})`, class: 'axl' }, 'Vout (V)'));
  const band = svg.appendChild(s('rect', { class: 'rg-sat' }));
  const ref = svg.appendChild(s('path', { class: 'fam' }));
  const cur = svg.appendChild(s('path', { class: 'cur' }));
  const vmDot = svg.appendChild(s('circle', { r: 4.5, class: 'bound', fill: 'none' }));
  const vmLab = svg.appendChild(s('text', { class: 'rl sat' }));
  const dot = svg.appendChild(s('circle', { r: 5.5, class: 'op' }));
  const pathOf = (pts: { vin: number; vout: number }[]) => pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.vin).toFixed(1)},${Y(p.vout).toFixed(1)}`).join('');
  const refCurve = pathOf(curve(1));

  const cell = () => { const b = h('b'), sp = h('span'); return { b, sp, el: h('div', null, b, sp) }; };
  const c = [cell(), cell(), cell(), cell()];
  const tab = h('table', { class: 'mini' });

  const paint = () => {
    const k = strength(wr), m = metrics(k), p = point(vin, k);
    cur.setAttribute('d', pathOf(curve(k)));
    ref.setAttribute('d', wr === MOBILITY_RATIO ? '' : refCurve);
    band.setAttribute('x', String(X(m.vil)));
    band.setAttribute('width', String(X(m.vih) - X(m.vil)));
    band.setAttribute('y', String(M.t));
    band.setAttribute('height', String(H - M.t - M.b));
    vmDot.setAttribute('cx', String(X(m.vm)));
    vmDot.setAttribute('cy', String(Y(m.vm)));
    vmLab.setAttribute('x', String(X(m.vm) + 9));
    vmLab.setAttribute('y', String(Y(m.vm) - 7));
    vmLab.textContent = `VM = ${m.vm.toFixed(2)} V`;
    dot.setAttribute('cx', String(X(vin)));
    dot.setAttribute('cy', String(Y(p.vout)));
    c[0].b.textContent = `${vin.toFixed(2)} V`; c[0].sp.textContent = 'Vin';
    c[1].b.textContent = `${p.vout.toFixed(2)} V`; c[1].sp.textContent = 'Vout';
    c[2].b.textContent = `NMOS ${REGION[p.n]}`; c[2].sp.textContent = `Vgs ${vin.toFixed(2)} V`;
    c[3].b.textContent = `PMOS ${REGION[p.p]}`; c[3].sp.textContent = `Vsg ${(VDD - vin).toFixed(2)} V`;
    const row = (a: string, v: string, note: string) => h('tr', null, h('th', null, a), h('td', null, v), h('td', { class: 'sub' }, note));
    tab.replaceChildren(
      row('VM', `${m.vm.toFixed(2)} V`, 'Vin = Vout'),
      row('VIL / VIH', `${m.vil.toFixed(2)} / ${m.vih.toFixed(2)} V`, 'where the slope is −1 (shaded between)'),
      row('VOH / VOL', `${m.voh.toFixed(2)} / ${m.vol.toFixed(2)} V`, 'outputs at those inputs'),
      row('NML / NMH', `${m.nmL.toFixed(2)} / ${m.nmH.toFixed(2)} V`, 'VIL − VOL, VOH − VIH'),
      row('peak gain', `${m.gain.toFixed(0)}`, '|dVout / dVin| at VM'));
  };
  const vSl = slider('Vin', 0, VDD, 0.01, vin, (v) => `${v.toFixed(2)} V`, (v) => { vin = v; paint(); });
  const wSl = slider('Wp / Wn', 1, 4, 0.25, wr, (v) => `${v.toFixed(2)}×`, (v) => { wr = v; paint(); });
  const el = h('div', { class: 'widget mos' },
    h('div', { class: 'panel' }, h('h3', null, 'Voltage transfer characteristic'), svg),
    h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row' }, vSl.el, wSl.el),
      h('p', { class: 'sub mos-note' }, `Square-law model of chapter 1 (Vt 0.45 V, VDD ${VDD} V, channel-length factor), a PMOS ${MOBILITY_RATIO}× wider than the NMOS matches it. `
        + 'Dashed: the matched curve, for comparison.')),
    h('div', { class: 'mos-chips' }, ...c.map((x) => x.el)),
    h('div', { class: 'panel' }, tab));
  paint();
  return { el };
}

export { MOBILITY_RATIO };
