// Figure: a moving company (chapter "bus", "DMA"). The bus timing is the gate-level bench's (system.ts moveRun, pinned
// to busBench in tests/analogyfigs-h.test.ts); the CPU is a loop of MOVE_GAP ALU instructions and a load from RAM.

import { h, s } from '../../ui/dom';
import { MOVE_GAP, MOVE_LENGTHS, cpuAlone, moveRun, type MoveSource } from './system';
import { button, frames, reducedMotion } from './common';
import { choice } from './sysui';

const W = 360, BX = 10, BW = 340;
const SRC: MoveSource[] = ['ram', 'flash'];
const SRC_NAME = ['From RAM', 'From flash'];

export default function mount(host: HTMLElement): void {
  let li = 1, si = 0, t = 0, playing = false;
  const svg = s('svg', { viewBox: `0 0 ${W} 214`, class: 'af-svg', role: 'img', 'aria-label': 'The CPU and the DMA engine sharing a bus, and who holds it over time' });
  const read = h('p', { class: 'af-read', 'aria-live': 'polite' });
  const lens = choice(MOVE_LENGTHS.map((n) => `${n} words`), (i) => { li = i; reset(); });
  const srcs = choice(SRC_NAME, (i) => { si = i; reset(); });
  const run = () => moveRun(MOVE_LENGTHS[li], SRC[si]);
  const stop = () => { playing = false; };
  const scrub = h('input', { type: 'range', min: 0, max: 1, step: 1, value: 0, 'aria-label': 'Cycle since the order was given' });
  scrub.addEventListener('input', () => { stop(); t = +scrub.value; paint(); });
  const startBtn = button('Start', () => {
    stop(); t = 0;
    if (reducedMotion()) { t = run().irqAt; paint(); return; }
    playing = true;
    const total = run().irqAt, rate = Math.max(1, total / 120); // a copy takes about two seconds on screen
    let acc = 0;
    frames(host, (dt) => { if (!playing) return false; acc += (dt / 16.7) * rate; t = Math.min(total, Math.floor(acc)); paint(); if (t >= total) { playing = false; return false; } });
    paint();
  });
  const reset = () => { stop(); t = 0; paint(); };

  const paint = () => {
    const r = run(), total = r.irqAt, len = MOVE_LENGTHS[li];
    t = Math.min(t, total);
    scrub.max = String(total); scrub.value = String(t);
    const X = (c: number) => BX + (c / total) * BW, cur = r.owner[Math.min(t, r.owner.length - 1)];
    const done = t >= total, words = r.words[t], instr = r.cpu[t];
    const kids: SVGElement[] = [
      // the machines and the road between them
      s('rect', { x: 8, y: 8, width: 70, height: 40, rx: 6, class: cur === 'cpu' ? 'af-row head' : 'af-row' }),
      s('text', { x: 43, y: 34, 'text-anchor': 'middle', class: 'af-t' }, 'CPU'),
      s('rect', { x: 282, y: 8, width: 70, height: 40, rx: 6, class: cur === 'dma' ? 'af-row head' : 'af-row' }),
      s('text', { x: 317, y: 34, 'text-anchor': 'middle', class: 'af-t' }, 'DMA van'),
      s('rect', { x: 78, y: 24, width: 204, height: 8, class: cur === 'cpu' ? 'af-bus-cpu' : cur === 'dma' ? 'af-bus-dma' : 'af-bus-idle' }),
      s('text', { x: 180, y: 20, 'text-anchor': 'middle', class: 'af-t af-m' }, cur === 'idle' ? 'road free' : `road: ${cur === 'cpu' ? 'CPU' : 'DMA'}`),
      s('circle', { cx: 180, cy: 62, r: 11, class: done ? 'af-bell ring' : 'af-bell' }),
      s('text', { x: 198, y: 67, class: done ? 'af-t af-warnt' : 'af-t af-m' }, done ? 'irq: the bell rings' : 'irq: quiet'),
      // who held the bus, cycle by cycle
      s('text', { x: BX, y: 100, class: 'af-t af-m' }, 'bus owner, by cycle:'),
    ];
    // runs of one owner, drawn up to the cursor
    let from = 0;
    for (let c = 1; c <= Math.min(t, total); c++) {
      if (c === Math.min(t, total) || r.owner[c] !== r.owner[from]) {
        kids.push(s('rect', { x: X(from), y: 108, width: Math.max(0.6, X(c) - X(from)), height: 18, class: `af-bus-${r.owner[from]}` }));
        from = c;
      }
    }
    kids.push(s('rect', { x: BX, y: 108, width: BW, height: 18, fill: 'none', class: 'af-row' }), s('line', { x1: X(t), x2: X(t), y1: 104, y2: 130, class: 'af-now' }),
      s('rect', { x: BX, y: 146, width: 14, height: 14, class: 'af-bus-cpu' }), s('text', { x: BX + 20, y: 158, class: 'af-t' }, 'CPU load'),
      s('rect', { x: BX + 110, y: 146, width: 14, height: 14, class: 'af-bus-dma' }), s('text', { x: BX + 130, y: 158, class: 'af-t' }, 'DMA read / write'),
      s('text', { x: BX, y: 190, class: 'af-big sm' }, `CPU: ${instr} instructions`),
      s('text', { x: BX, y: 208, class: 'af-big sm' }, `moved: ${words} of ${len} words`));
    svg.replaceChildren(...kids);
    lens.mark(li); srcs.mark(si);
    startBtn.textContent = reducedMotion() ? 'Start (to end)' : 'Start';
    const alone = cpuAlone(total)[total];
    const waits = r.loads.reduce((a, l) => a + (l - 2), 0), worst = Math.max(0, ...r.loads);
    const solo = moveRun(len, SRC[si], -1).irqAt;
    read.textContent = `Cycle ${t} of ${total}: the CPU has finished ${instr} instructions while the DMA moved ${words} of ${len} words. `
      + (done ? `The copy took ${total} cycles (${solo} with the CPU off the bus). The CPU finished ${instr} instructions where it would have done ${alone} with the bus to itself: its loads waited ${waits} cycles in all, the longest ${worst} cycles${SRC[si] === 'flash' ? ', behind a flash page read' : ''}. ` : '')
      + `The CPU here runs ${MOVE_GAP} ALU instructions then a load from RAM, over and over. A RAM access takes 2 cycles; one holding the bus makes the other wait.`;
  };
  host.replaceChildren(svg, h('div', { class: 'af-ctl' }, lens.el, srcs.el), h('div', { class: 'af-ctl' }, startBtn, h('label', { class: 'af-slide' }, 'cycle ', scrub)), read);
  paint();
}
