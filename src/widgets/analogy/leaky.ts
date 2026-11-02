// Figure: DRAM cells as leaky buckets (chapter "dram", "Leaks and refresh"), with the real charge-sharing numbers.

import { h, s } from '../../ui/dom';
import { CELL_HALFLIFE } from '../../lib/dram';
import { DRAM_OFFSET_MV, decay, deltaMv, refreshLevel, senseRead } from './model';
import { button, frames, reducedMotion, setPressed } from './common';

const W = 360, BT = 30, BH = 72, BW = 56;
const CYCLES_PER_S = 40;

export default function mount(host: HTMLElement): void {
  // one stored 0 and three 1s written at different times, so they have leaked by different amounts
  const bits = [1, 0, 1, 1];
  let level = [1, 0, 0.8, 0.62];
  let age = 0, running = !reducedMotion(), looping = false;
  const svg = s('svg', { viewBox: `0 0 ${W} 192`, class: 'af-svg', role: 'img', 'aria-label': 'Four leaking buckets, the half line, and what a read of each would give' });
  const read = h('p', { class: 'af-read', 'aria-live': 'polite' });

  const advance = (c: number) => { age += c; level = level.map((l) => decay(l, c)); paint(); };
  const loop = () => {
    if (looping) return;
    looping = true;
    frames(host, (dt) => { if (!running) { looping = false; return false; } advance((dt / 1000) * CYCLES_PER_S); });
  };
  const runBtn = button('Time: running', () => {
    running = !running;
    setPressed(runBtn, running);
    runBtn.textContent = running ? 'Time: running' : 'Time: paused';
    if (running) loop();
  }, running);
  runBtn.textContent = running ? 'Time: running' : 'Time: paused';
  const wait = button('Wait 50 cycles', () => advance(50));
  const refresh = button('Refresh', () => { level = level.map((l) => refreshLevel(l)); paint(); });

  const paint = () => {
    const gap = (W - 4 * BW) / 5, kids: SVGElement[] = [];
    level.forEach((l, k) => {
      const x = gap + k * (BW + gap), r = senseRead(l), d = deltaMv(l);
      kids.push(
        s('rect', { x, y: BT, width: BW, height: BH, rx: 3, class: 'af-bucket' }),
        s('rect', { x: x + 1, y: BT + BH * (1 - l), width: BW - 2, height: BH * l, class: 'af-water' }),
        s('line', { x1: x - 4, x2: x + BW + 4, y1: BT + BH / 2, y2: BT + BH / 2, class: 'af-half' }),
        s('path', { d: `M${x + BW / 2},${BT + BH} v6`, class: 'af-drip' }),
        s('text', { x: x + BW / 2, y: BT - 8, 'text-anchor': 'middle', class: 'af-t af-m' }, `stored ${bits[k]}`),
        s('text', { x: x + BW / 2, y: BT + BH + 24, 'text-anchor': 'middle', class: 'af-t' }, `${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(0)} mV`),
        s('text', { x: x + BW / 2, y: BT + BH + 44, 'text-anchor': 'middle', class: `af-big sm${r === 'X' ? ' bad' : ''}` }, `→ ${r}`));
    });
    kids.push(s('text', { x: W / 2, y: 182, 'text-anchor': 'middle', class: 'af-t af-m' }, `${age.toFixed(0)} cycles · half-life ${CELL_HALFLIFE}`));
    svg.replaceChildren(...kids);
    const xs = level.filter((l) => senseRead(l) === 'X').length;
    read.textContent = `A read shares the cell's charge with the bit line (precharged to ½, 4× the capacitance): ΔV = (level − ½)·VDD·C_cell / (C_cell + C_bit). The amplifier needs ${DRAM_OFFSET_MV.toFixed(0)} mV; ${xs ? `${xs} cell${xs > 1 ? 's' : ''} below that read${xs > 1 ? '' : 's'} X, and a refresh now would toss a coin for ${xs > 1 ? 'each' : 'it'}.` : 'every cell still reads clearly.'}`;
  };
  host.replaceChildren(svg, h('div', { class: 'af-ctl' }, runBtn, wait, refresh), read);
  paint();
  if (running) loop();
}
