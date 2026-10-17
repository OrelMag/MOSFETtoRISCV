// "Levels that do not line up" (prologue P2): a plate swings between about 81 and 250 V, a grid conducts near 0 V and
// is cut off below −12.5 V. A divider from the plate to a bias rail shifts one onto the other; this widget computes the
// plate's two levels (loaded by `fanout` dividers), the next grid's, and whether the chain still works, from
// phys/triode.ts. The ratio, the bias rail and the fan-out are the learner's.

import { B_PLUS, V_CUTOFF, cutoff, dividerPower, gateLevels } from '../phys/triode';
import { h, s } from '../ui/dom';
import type { Widget } from '../view/stage';
import { slider } from './mosparts';

const W = 640, H = 300, M = { l: 58, r: 20, t: 16, b: 26 }, V_MIN = -160, V_MAX = 260;
const X_PLATE = 200, X_GRID = 470;
/** The divider's total resistance (Ω): only the ratio moves the levels, the total sets the power. */
const R_TOTAL = 1e6;

export function tubeDividerWidget(): Widget {
  let ratio = 5 / 3, bias = -150, fanout = 1;
  const Y = (v: number) => M.t + ((V_MAX - v) / (V_MAX - V_MIN)) * (H - M.t - M.b);
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'mos-plot tdiv', role: 'img', 'aria-label': 'Plate levels and the grid levels a divider makes of them' });
  for (let v = -150; v <= 250; v += 50) {
    svg.append(s('line', { x1: M.l, x2: W - M.r, y1: Y(v), y2: Y(v), class: 'grid' }), s('text', { x: M.l - 6, y: Y(v) + 3.5, 'text-anchor': 'end', class: 'tick' }, String(v)));
  }
  // where a grid conducts (between cutoff and 0 V) and where it draws grid current (above 0 V)
  svg.append(
    s('rect', { x: X_GRID - 70, width: 140, y: Y(0), height: Y(V_CUTOFF) - Y(0), class: 'tdiv-on' }),
    s('rect', { x: X_GRID - 70, width: 140, y: Y(V_MAX), height: Y(0) - Y(V_MAX), class: 'tdiv-gc' }),
    s('line', { x1: X_GRID - 70, x2: X_GRID + 70, y1: Y(V_CUTOFF), y2: Y(V_CUTOFF), class: 'vt' }),
    s('text', { x: X_GRID + 74, y: Y(0) + 1, class: 'tick tdiv-onl' }, 'conducts'),
    s('text', { x: X_GRID + 74, y: Y(V_CUTOFF) + 13, class: 'tick' }, `cutoff ${V_CUTOFF} V`),
    s('text', { x: X_GRID + 74, y: Y(130), class: 'tick' }, 'grid current'),
    s('line', { x1: M.l, x2: M.l, y1: M.t, y2: H - M.b, class: 'ax' }),
    s('text', { x: 8, y: M.t, 'text-anchor': 'end', 'dominant-baseline': 'hanging', transform: `rotate(-90 8 ${M.t})`, class: 'axl' }, 'volts'),
    s('text', { x: X_PLATE, y: H - 6, 'text-anchor': 'middle', class: 'axl' }, 'this plate'),
    s('text', { x: X_GRID, y: H - 6, 'text-anchor': 'middle', class: 'axl' }, 'the next grid'));
  const links = svg.appendChild(s('g'));
  const dots = svg.appendChild(s('g'));

  const cell = () => { const b = h('b'), sp = h('span'); return { b, sp, el: h('div', null, b, sp) }; };
  const c = [cell(), cell(), cell(), cell()];
  const verdict = h('p', { class: 'sub mos-note' });

  const paint = () => {
    const top = (R_TOTAL * ratio) / (1 + ratio), bottom = R_TOTAL / (1 + ratio);
    const l = gateLevels(fanout, top, bottom, bias);
    const okHigh = l.gridHigh > cutoff(l.high) + 2, okLow = l.gridLow < V_CUTOFF - 5;
    links.replaceChildren(), dots.replaceChildren();
    const level = (vp: number, vg: number, cls: string, name: string) => {
      links.append(s('line', { x1: X_PLATE + 8, y1: Y(vp), x2: X_GRID - 8, y2: Y(vg), class: `tdiv-link ${cls}` }));
      dots.append(
        s('circle', { cx: X_PLATE, cy: Y(vp), r: 6, class: `tdiv-dot ${cls}` }),
        s('text', { x: X_PLATE - 12, y: Y(vp) + 4, 'text-anchor': 'end', class: 'rl' }, `${name}: ${vp.toFixed(0)} V`),
        s('circle', { cx: X_GRID, cy: Y(vg), r: 6, class: `tdiv-dot ${cls}` }),
        s('text', { x: X_GRID - 12, y: Y(vg) + 4, 'text-anchor': 'end', class: 'rl' }, `${vg.toFixed(1)} V`));
    };
    level(l.high, l.gridHigh, okHigh ? 'hi' : 'bad', '1, cut off');
    level(l.low, l.gridLow, okLow ? 'lo' : 'bad', '0, conducting');
    c[0].b.textContent = `${l.gridHigh.toFixed(1)} V`;
    c[0].sp.textContent = okHigh ? 'grid from a 1: conducts' : 'grid from a 1: cut off, wrong';
    c[1].b.textContent = `${l.gridLow.toFixed(1)} V`;
    c[1].sp.textContent = okLow ? `grid from a 0: ${(V_CUTOFF - l.gridLow).toFixed(0)} V below cutoff` : 'grid from a 0: conducts, wrong';
    c[2].b.textContent = `${(l.high - l.low).toFixed(0)} V`;
    c[2].sp.textContent = `plate swing, ${fanout} divider${fanout > 1 ? 's' : ''} on it`;
    c[3].b.textContent = `${(dividerPower(top, bottom, bias) * 1e3).toFixed(0)} mW`;
    c[3].sp.textContent = 'per divider, all the time';
    verdict.textContent = okHigh && okLow
      ? `It works: the next tube conducts on a 1 and is cut off on a 0. (${(top / 1e3).toFixed(0)} kΩ over ${(bottom / 1e3).toFixed(0)} kΩ to ${bias} V.)`
      : !okLow && bias > -60 ? 'A 0 does not cut the next tube off: with the bias rail this close to ground, even an 81 V plate holds the grid above cutoff.'
      : !okLow ? 'A 0 does not cut the next tube off: the divider leaves too much of the low plate on the grid.'
      : fanout > 2 ? 'Too many dividers on one plate: they pull a cut-off plate down so far that a 1 no longer reaches the next grid. Real machines put a cathode follower here.'
      : 'A 1 no longer turns the next tube on: the divider pulls the grid below cutoff even from a high plate.';
    verdict.classList.toggle('bad', !(okHigh && okLow));
  };
  const rSl = slider('Ratio', 0.6, 3, 0.05, ratio, (v) => `${v.toFixed(2)}:1`, (v) => { ratio = v; paint(); });
  const bSl = slider('Bias', -200, 0, 10, bias, (v) => `${v} V`, (v) => { bias = v; paint(); });
  const fSl = slider('Fan-out', 1, 4, 1, fanout, (v) => String(v), (v) => { fanout = v; paint(); });

  const el = h('div', { class: 'widget mos' },
    h('div', { class: 'panel' }, h('h3', null, `A plate on ${B_PLUS} V through a 22 kΩ resistor, and the divider to the next grid`), svg),
    h('div', { class: 'panel mos-ctl' }, h('div', { class: 'mos-row' }, rSl.el, bSl.el, fSl.el), verdict),
    h('div', { class: 'mos-chips' }, ...c.map((x) => x.el)));
  paint();
  return { el };
}
