// Figure: buckets on one hose (chapter 1, "What one switch costs"). The numbers are mosphys.ts's, as in the step's widget.

import { h, s } from '../../ui/dom';
import { BUCKET_T_MAX, bucketRun } from './model';
import { button, frames, reducedMotion } from './common';

const W = 360, PX = 168, PY = 8, PW = 184, PH = 96; // the V–t plot
const BT = 124, BH = 52; // buckets' top and height

export default function mount(host: HTMLElement): void {
  let n = 2, t = BUCKET_T_MAX, playing = false;
  const svg = s('svg', { viewBox: `0 0 ${W} 190`, class: 'af-svg', role: 'img', 'aria-label': 'A hose filling buckets through a manifold, and their level over time' });
  const hose = s('g');
  const buckets = s('g');
  const curve = s('path', { class: 'af-curve' });
  const half = s('line', { x1: PX, x2: PX + PW, y1: PY + PH / 2, y2: PY + PH / 2, class: 'af-half' });
  const mark = s('line', { class: 'af-mark', y1: PY, y2: PY + PH });
  const dot = s('circle', { r: 3.5, class: 'af-dot' });
  const now = s('line', { class: 'af-now', y1: PY, y2: PY + PH });
  svg.append(
    s('rect', { x: PX, y: PY, width: PW, height: PH, class: 'af-plot' }), half, mark, now, curve, dot,
    s('text', { x: PX + PW - 3, y: PY + PH / 2 - 4, 'text-anchor': 'end', class: 'af-t af-m' }, 'half full'),
    s('text', { x: PX + PW / 2, y: PY + PH + 12, 'text-anchor': 'middle', class: 'af-t af-m' }, `time, 0 to ${BUCKET_T_MAX} ps`),
    s('text', { x: PX - 4, y: PY + 9, 'text-anchor': 'end', class: 'af-t af-m' }, 'full'),
    s('text', { x: 8, y: 20, class: 'af-t' }, 'output channel'), hose, buckets);
  const read = h('p', { class: 'af-read', 'aria-live': 'polite' });
  const X = (ps: number) => PX + (ps / BUCKET_T_MAX) * PW, Y = (f: number) => PY + PH - f * PH;

  const paint = () => {
    const r = bucketRun(n), i = Math.min(r.t.length - 1, Math.round(t));
    const lvl = r.fill[i];
    curve.setAttribute('d', r.t.slice(0, i + 1).map((ps, k) => `${k ? 'L' : 'M'}${X(ps).toFixed(1)},${Y(r.fill[k]).toFixed(1)}`).join(''));
    const t50x = X(r.t50);
    mark.setAttribute('x1', String(t50x)); mark.setAttribute('x2', String(t50x));
    dot.setAttribute('cx', String(t50x)); dot.setAttribute('cy', String(Y(0.5)));
    now.setAttribute('x1', String(X(t))); now.setAttribute('x2', String(X(t)));
    // a hose into a manifold, then one branch per bucket
    const bw = Math.min(40, (W - 16) / n - 8), gap = (W - 16 - n * bw) / n, cx = (k: number) => 8 + gap / 2 + k * (bw + gap) + bw / 2;
    hose.replaceChildren(
      s('path', { d: `M8,30 H${W / 2 - 20} V80`, class: 'af-pipe' }),
      s('text', { x: 16, y: 44, class: 'af-t af-m' }, 'R'),
      s('path', { d: `M${Math.min(cx(0), W / 2 - 20)},80 H${Math.max(cx(n - 1), W / 2 - 20)}`, class: 'af-pipe' }),
      ...Array.from({ length: n }, (_, k) => s('path', { d: `M${cx(k)},80 V${BT - 4}`, class: 'af-pipe' })));
    buckets.replaceChildren(...Array.from({ length: n }, (_, k) => s('g', null,
      s('rect', { x: cx(k) - bw / 2, y: BT, width: bw, height: BH, rx: 3, class: 'af-bucket' }),
      s('rect', { x: cx(k) - bw / 2 + 1, y: BT + BH * (1 - lvl), width: bw - 2, height: BH * lvl, class: 'af-water' }),
      s('line', { x1: cx(k) - bw / 2, x2: cx(k) + bw / 2, y1: BT + BH / 2, y2: BT + BH / 2, class: 'af-half' }))));
    read.textContent = `${n} input${n > 1 ? 's' : ''}: ${r.cLoad} fF of buckets. Half full at ${r.t50.toFixed(0)} ps${t >= r.t50 ? ' (reached)' : ''}; filling and emptying them once costs C·V² = ${r.energy.toFixed(0)} fJ.`;
  };

  const run = () => {
    if (reducedMotion()) { t = BUCKET_T_MAX; paint(); return; }
    t = 0;
    playing = true;
    paint();
    frames(host, (dt) => { t = Math.min(BUCKET_T_MAX, t + dt / 25); paint(); if (t >= BUCKET_T_MAX) { playing = false; return false; } });
  };
  const slider = h('input', { type: 'range', min: 1, max: 6, step: 1, value: n, id: `af-n-${Math.random().toString(36).slice(2, 7)}` });
  const out = h('output', null, String(n));
  slider.addEventListener('input', () => { n = +slider.value; if (!playing) t = BUCKET_T_MAX; out.textContent = String(n); paint(); });
  host.replaceChildren(svg, h('div', { class: 'af-ctl' },
    h('label', { for: slider.id }, 'Fan-out (buckets) ', slider, ' ', out), button('Switch on', run)), read,
    h('p', { class: 'af-note' }, 'Ratios, not litres: the drawing shows that twice the load takes about twice as long and costs twice the energy.'));
  paint();
}
