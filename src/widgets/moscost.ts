// "What one switch costs": an NMOS discharging the gates it drives. The delay (to VDD / 2) and the energy
// per swing (C·V²) come from the same device model as the rest of the chapter; the capacitances are
// illustrative (mosphys.ts C_GATE, C_WIRE).

import { h, s } from '../ui/dom';
import type { Widget } from '../view/stage';
import { C_GATE, current, discharge, loadOf, VDD, VT } from './mosphys';
import { slider } from './mosparts';

const W = 640, H = 260, T_MAX = 120, M = { l: 54, r: 16, t: 14, b: 34 };

export function mosCostWidget(): Widget {
  let width = 1, fanout = 2;
  const X = (t: number) => M.l + (t / T_MAX) * (W - M.l - M.r);
  const Y = (v: number) => H - M.b - (v / VDD) * (H - M.t - M.b);
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'mos-plot', role: 'img', 'aria-label': 'Output voltage falling after the gate switches on' });
  for (let t = 0; t <= T_MAX; t += 20) {
    svg.append(s('line', { x1: X(t), x2: X(t), y1: M.t, y2: H - M.b, class: 'grid' }), s('text', { x: X(t), y: H - M.b + 14, 'text-anchor': 'middle', class: 'tick' }, String(t)));
  }
  for (let v = 0; v <= VDD + 1e-9; v += 0.3) {
    svg.append(s('line', { x1: M.l, x2: W - M.r, y1: Y(v), y2: Y(v), class: 'grid' }), s('text', { x: M.l - 6, y: Y(v) + 3.5, 'text-anchor': 'end', class: 'tick' }, v.toFixed(1)));
  }
  svg.append(s('line', { x1: M.l, x2: W - M.r, y1: H - M.b, y2: H - M.b, class: 'ax' }), s('line', { x1: M.l, x2: M.l, y1: M.t, y2: H - M.b, class: 'ax' }),
    s('text', { x: W - M.r, y: H - 4, 'text-anchor': 'end', class: 'axl' }, 'time after the gate switches on (ps)'),
    s('text', { x: 6, y: M.t, 'text-anchor': 'end', 'dominant-baseline': 'hanging', transform: `rotate(-90 6 ${M.t})`, class: 'axl' }, 'Vout (V)'),
    s('line', { x1: M.l, x2: W - M.r, y1: Y(VDD / 2), y2: Y(VDD / 2), class: 'vt' }),
    s('text', { x: W - M.r - 2, y: Y(VDD / 2) - 5, 'text-anchor': 'end', class: 'tick' }, 'VDD / 2'));
  const ref = svg.appendChild(s('path', { class: 'fam' }));
  const refL = svg.appendChild(s('text', { class: 'tick' }, 'width 1×'));
  const cur = svg.appendChild(s('path', { class: 'cur' }));
  const mark = svg.appendChild(s('line', { class: 't50' }));
  const dot = svg.appendChild(s('circle', { r: 5, class: 'op' }));
  const lab = svg.appendChild(s('text', { class: 'rl t50l' }));

  const cell = () => { const b = h('b'), sp = h('span'); return { b, sp, el: h('div', null, b, sp) }; };
  const c = [cell(), cell(), cell(), cell()];
  const pathOf = (r: { t: number[]; v: number[] }) => r.t.map((t, i) => `${i ? 'L' : 'M'}${X(t).toFixed(1)},${Y(r.v[i]).toFixed(1)}`).join('');

  const paint = () => {
    const cl = loadOf(fanout), r = discharge(width, cl, T_MAX), ion = width * current(VDD - VT, VDD).id;
    cur.setAttribute('d', pathOf(r));
    if (width > 1) {
      const r1 = discharge(1, cl, T_MAX), i = r1.t.findIndex((t) => t >= Math.min(T_MAX * 0.7, r1.t50 * 1.6));
      ref.setAttribute('d', pathOf(r1));
      refL.setAttribute('x', String(X(r1.t[i]) + 6));
      refL.setAttribute('y', String(Y(r1.v[i]) - 6));
      refL.style.display = '';
    } else { ref.setAttribute('d', ''); refL.style.display = 'none'; }
    const t50 = Math.min(r.t50, T_MAX);
    for (const [k, v] of [['x1', X(t50)], ['x2', X(t50)], ['y1', Y(VDD / 2)], ['y2', H - M.b]] as const) mark.setAttribute(k, String(v));
    dot.setAttribute('cx', String(X(t50)));
    dot.setAttribute('cy', String(Y(VDD / 2)));
    lab.setAttribute('x', String(X(t50) + 8));
    lab.setAttribute('y', String(Y(VDD / 2) - 10));
    lab.textContent = `${r.t50.toFixed(0)} ps`;
    c[0].b.textContent = `${cl} fF`;
    c[0].sp.textContent = `load: ${fanout} input${fanout > 1 ? 's' : ''} × 2 gates + wire`;
    c[1].b.textContent = `${ion.toFixed(0)} µA`;
    c[1].sp.textContent = 'on current';
    c[2].b.textContent = `${r.t50.toFixed(0)} ps`;
    c[2].sp.textContent = 'delay to VDD / 2';
    c[3].b.textContent = `${(cl * VDD * VDD).toFixed(1)} fJ`;
    c[3].sp.textContent = 'energy per 0 → 1 → 0 (C·V²)';
    inCap.textContent = `This transistor's own gate is ${width * C_GATE} fF of load on the stage that drives it.`;
  };
  const inCap = h('p', { class: 'sub mos-note' });
  const wSl = slider('Width', 1, 4, 1, width, (v) => `${v}×`, (v) => { width = v; paint(); });
  const fSl = slider('Fan-out', 1, 6, 1, fanout, (v) => String(v), (v) => { fanout = v; paint(); });

  const el = h('div', { class: 'widget mos' },
    h('div', { class: 'panel' }, h('h3', null, 'Output voltage after the gate switches on'), svg),
    h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row' }, wSl.el, fSl.el), inCap),
    h('div', { class: 'mos-chips' }, ...c.map((x) => x.el)));
  paint();
  return { el };
}
