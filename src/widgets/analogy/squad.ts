// Figure: a drill squad (chapter "simt", "When lanes disagree"). The golden model's SimtISS runs simtprograms.ts's
// 'diverge' kernel on four lanes; the grid is its active mask, step by step.

import { h, s } from '../../ui/dom';
import { SQUAD_CONDS, SQUAD_LANES, laneOn, popcount, squadRun } from './system';
import { button, frames, reducedMotion } from './common';
import { choice } from './sysui';

const W = 360, GX = 52, GY = 128, GR = 20, STEP_MS = 420;

export default function mount(host: HTMLElement): void {
  let cond = 1, idx = 0, playing = false;
  const svg = s('svg', { viewBox: `0 0 ${W} 232`, class: 'af-svg', role: 'img', 'aria-label': 'Four soldiers, and a grid of which of them were moving at each step' });
  const read = h('p', { class: 'af-read', 'aria-live': 'polite' });
  const conds = choice(SQUAD_CONDS.map((c) => c.label), (i) => { cond = i; reset(); });
  const run = () => squadRun(SQUAD_CONDS[cond].id);
  const stop = () => { playing = false; };
  const advance = () => { if (idx < run().steps.length - 1) idx++; else stop(); paint(); };
  const stepBtn = button('Step', () => { stop(); advance(); });
  const runBtn = button('Run', () => {
    if (reducedMotion()) { stop(); idx = run().steps.length - 1; paint(); return; }
    if (playing) { stop(); paint(); return; }
    playing = true;
    let acc = 0;
    frames(host, (dt) => { if (!playing) return false; acc += dt; while (acc >= STEP_MS) { acc -= STEP_MS; advance(); } if (!playing) { paint(); return false; } });
    paint();
  });
  const reset = () => { stop(); idx = 0; paint(); };
  const resetBtn = button('Reset', reset);

  const paint = () => {
    const r = run(), cur = r.steps[idx], n = r.steps.length, cw = Math.min(24, (W - GX - 6) / n), last = idx === n - 1;
    const kids: SVGElement[] = [];
    for (let l = 0; l < SQUAD_LANES; l++) {
      const x = 45 + l * 90, on = laneOn(cur.mask, l);
      kids.push(s('g', null,
        s('circle', { cx: x, cy: 22, r: 11, class: on ? 'af-soldier' : 'af-soldier rest' }),
        s('rect', { x: x - 13, y: 38, width: 26, height: 34, rx: 6, class: on ? 'af-soldier' : 'af-soldier rest' }),
        s('text', { x, y: 92, 'text-anchor': 'middle', class: 'af-t' }, `lane ${l}`),
        s('text', { x, y: 110, 'text-anchor': 'middle', class: on ? 'af-t af-warnt' : 'af-t af-m' }, on ? 'moves' : 'stands still')));
    }
    for (let l = 0; l < SQUAD_LANES; l++) {
      kids.push(s('text', { x: 4, y: GY + l * GR + 15, class: 'af-t af-m' }, `lane ${l}`));
      for (let i = 0; i < n; i++) {
        const shown = i <= idx, on = laneOn(r.steps[i].mask, l);
        kids.push(s('rect', { x: GX + i * cw + 1, y: GY + l * GR + 2, width: cw - 2, height: GR - 4, rx: 2, class: !shown ? 'af-cell future' : on ? 'af-cell' : 'af-cell off' }));
      }
    }
    kids.push(s('rect', { x: GX + idx * cw, y: GY - 1, width: cw, height: SQUAD_LANES * GR + 2, class: 'af-cursor' }),
      s('text', { x: GX, y: GY + SQUAD_LANES * GR + 18, class: 'af-t af-m' }, 'one column = one slot'),
      s('text', { x: 4, y: 224, class: 'af-t' }, `slot ${idx + 1} of ${n}: ${cur.text}`));
    svg.replaceChildren(...kids);
    conds.mark(cond);
    stepBtn.disabled = last;
    runBtn.textContent = reducedMotion() ? 'Run to end' : playing ? 'Pause' : 'Run';
    const busy = r.steps.slice(0, idx + 1).reduce((a, x) => a + popcount(x.mask), 0);
    const split = r.steps.filter((x) => x.mask !== 2 ** SQUAD_LANES - 1).length;
    read.textContent = `${SQUAD_CONDS[cond].who}. So far ${busy} of ${(idx + 1) * SQUAD_LANES} lane-slots did work. `
      + (last ? `Done in ${n} slots (${split} of them with part of the squad resting); the same kernel with every lane agreeing takes ${squadRun('all').slots}. ` : '')
      + 'A resting lane still waits out the slot: the slots of both groups add up.';
  };
  host.replaceChildren(svg, h('div', { class: 'af-ctl' }, conds.el), h('div', { class: 'af-ctl' }, stepBtn, runBtn, resetBtn), read);
  paint();
}
