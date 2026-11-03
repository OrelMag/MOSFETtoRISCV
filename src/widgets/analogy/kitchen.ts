// Figure: a kitchen with a pass (chapter "ooo", "Rename, wait, commit in order"). OooModel's own cycles: the tickets are
// instructions in the reorder buffer, the cooks its two ports.

import { h, s } from '../../ui/dom';
import { KITCHEN_PROGRAMS, KITCHEN_WINDOWS, kitchenCycles, kitchenRun } from './system';
import { button, frames, reducedMotion } from './common';
import { choice } from './sysui';

const W = 360, ROW = 27, TOP = 34, CYCLE_MS = 260;

export default function mount(host: HTMLElement): void {
  let prog = 0, win = 1, idx = 0, playing = false;
  const svg = s('svg', { viewBox: `0 0 ${W} 100`, class: 'af-svg', role: 'img', 'aria-label': 'The pass: the reorder buffer as a column of tickets, oldest at the top' });
  const read = h('p', { class: 'af-read', 'aria-live': 'polite' });
  const progs = choice(KITCHEN_PROGRAMS.map((p) => p.name), (i) => { prog = i; reset(); });
  const wins = choice(KITCHEN_WINDOWS.map((w) => `${w} entries`), (i) => { win = i; reset(); });
  const run = () => kitchenRun(KITCHEN_PROGRAMS[prog].id, KITCHEN_WINDOWS[win]);
  const stop = () => { playing = false; };
  const advance = () => { if (idx < run().frames.length - 1) idx++; else stop(); paint(); };
  const stepBtn = button('Step', () => { stop(); advance(); });
  const runBtn = button('Run', () => {
    if (reducedMotion()) { stop(); idx = run().frames.length - 1; paint(); return; }
    if (playing) { stop(); paint(); return; }
    playing = true;
    let acc = 0;
    frames(host, (dt) => { if (!playing) return false; acc += dt; while (acc >= CYCLE_MS) { acc -= CYCLE_MS; advance(); } if (!playing) { paint(); return false; } });
    paint();
  });
  const reset = () => { stop(); idx = 0; paint(); };
  const resetBtn = button('Reset', reset);

  const paint = () => {
    const r = run(), f = r.frames[idx], n = KITCHEN_WINDOWS[win], last = idx === r.frames.length - 1;
    svg.setAttribute('viewBox', `0 0 ${W} ${TOP + n * ROW + 6}`);
    const kids: SVGElement[] = [
      s('text', { x: 4, y: 20, class: 'af-t' }, `tickets waiting: ${f.waiting}`),
      s('text', { x: W - 4, y: 20, 'text-anchor': 'end', class: f.full ? 'af-t af-warnt' : 'af-t af-m' }, f.full ? 'pass full' : `cycle ${f.cycle + 1}`),
    ];
    for (let i = 0; i < n; i++) {
      const t = f.rob[i], y = TOP + i * ROW;
      if (!t) { kids.push(s('rect', { x: 2, y: y + 1, width: W - 4, height: ROW - 2, rx: 4, class: 'af-row empty' })); continue; }
      const label = t.state === 'queued' ? 'waiting' : t.state === 'issued' ? `cook ${t.port}` : 'ready';
      kids.push(s('rect', { x: 2, y: y + 1, width: W - 4, height: ROW - 2, rx: 4, class: i === 0 ? 'af-row head' : 'af-row' }),
        s('text', { x: 8, y: y + 20, class: 'af-t af-m' }, `#${t.seq}`),
        s('text', { x: 52, y: y + 20, class: 'af-t' }, t.text),
        s('rect', { x: W - 96, y: y + 4, width: 90, height: ROW - 8, rx: 10, class: `af-pill ${t.state}` }),
        s('text', { x: W - 51, y: y + 19, 'text-anchor': 'middle', class: 'af-t' }, label));
    }
    svg.replaceChildren(...kids);
    progs.mark(prog); wins.mark(win);
    runBtn.textContent = reducedMotion() ? 'Run to end' : playing ? 'Pause' : 'Run';
    stepBtn.disabled = last;
    const others = KITCHEN_WINDOWS.map((w) => `${w}: ${kitchenCycles(KITCHEN_PROGRAMS[prog].id, w)}`).join(', ');
    read.textContent = `Cycle ${f.cycle + 1}: ${f.served} of ${r.instructions} tickets served, in ticket order. ${f.out.length ? `Out this cycle: ${f.out.map((q) => '#' + q).join(' ')}. ` : ''}`
      + (last ? `Done in ${r.cycles} cycles. ` : '')
      + `The pass was full on ${r.frames.slice(0, idx + 1).filter((x) => x.full).length} of the cycles so far. Whole program by window size, in cycles (${others}). Tickets leave only from the top: up to two a cycle, oldest first, and none past one that is not ready.`;
  };
  host.replaceChildren(svg, h('div', { class: 'af-ctl' }, progs.el, wins.el), h('div', { class: 'af-ctl' }, stepBtn, runBtn, resetBtn), read);
  paint();
}
