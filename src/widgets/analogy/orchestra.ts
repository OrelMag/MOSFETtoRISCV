// Figure: the clock as a conductor's beat, on the library 4-bit counter's real paths (chapter "registers").

import { h, s } from '../../ui/dom';
import '../../styles/analogy-d.css';
import { beat, counterPlayers, PS_PER_NAND, SETUP, slowestNeed } from './storage';
import { button } from './common';

const W = 360, X0 = 62, X1 = 346, MAXT = 20, ROW = 30, Y0 = 24;
const names = (bits: number[]) => bits.map((b) => `bit ${b}`).join(' and ');
const bin = (v: number) => (v & 15).toString(2).padStart(4, '0');

export default function mount(host: HTMLElement): void {
  const players = counterPlayers();
  let period = slowestNeed(players), q = 5, prev = 5, late: number[] = [], beats = 0;
  const svg = s('svg', { viewBox: `0 0 ${W} 230`, class: 'af-svg', role: 'img', 'aria-label': 'For each flip-flop, how long its next value takes to be ready, against the beat' });
  const read = h('p', { class: 'af-read', 'aria-live': 'polite' });
  const px = (t: number) => X0 + (t / MAXT) * (X1 - X0);

  const slider = h('input', { type: 'range', min: '6', max: String(MAXT), step: '1', value: String(period), 'aria-label': 'Clock period in NAND delays' });
  const lab = h('label', null, 'Period ', slider);
  const out = h('span', { class: 'af-note' });
  slider.addEventListener('input', () => { period = Number(slider.value); paint(); });
  const beatBtn = button('Beat', () => { prev = q; const r = beat(q, period, players); q = r.q; late = r.late; beats++; paint(); });
  const resetBtn = button('Reset', () => { q = 5; prev = 5; late = []; beats = 0; paint(); });

  const paint = () => {
    const kids: SVGElement[] = [];
    players.forEach((p, i) => {
      const y = Y0 + i * ROW, ok = p.need <= period;
      kids.push(
        s('text', { x: 4, y: y + 19, class: 'af-t' }, `bit ${p.bit}`),
        s('rect', { x: X0, y: y + 4, width: px(p.ready) - X0, height: 18, class: ok ? 'af-ready' : 'af-ready late' }),
        s('rect', { x: px(p.ready), y: y + 4, width: px(p.need) - px(p.ready), height: 18, class: 'af-setup' }));
    });
    const bot = Y0 + players.length * ROW;
    [0, 5, 10, 15, 20].forEach((t) => kids.push(s('text', { x: px(t), y: bot + 18, 'text-anchor': 'middle', class: 'af-t af-m' }, String(t))));
    kids.push(
      s('text', { x: (X0 + X1) / 2, y: bot + 38, 'text-anchor': 'middle', class: 'af-t af-m' }, 'NAND delays after the beat'),
      s('line', { x1: px(period), x2: px(period), y1: Y0 - 6, y2: bot + 2, class: 'af-beatline' }),
      s('text', { x: px(period) + (px(period) > 250 ? -4 : 4), y: Y0 - 8, 'text-anchor': px(period) > 250 ? 'end' : 'start', class: 'af-t af-beat' }, 'next beat'));
    const ys = bot + 74;
    kids.push(s('text', { x: 4, y: ys, class: 'af-t af-m' }, 'count'));
    const digits = bin(q), want = bin(prev + 1);
    for (let i = 0; i < 4; i++) {
      const bit = 3 - i, miss = late.includes(bit);
      kids.push(s('text', { x: X0 + 12 + i * 26, y: ys, 'text-anchor': 'middle', class: miss ? 'af-big bad' : 'af-big' }, digits[i]));
    }
    if (late.length) kids.push(s('text', { x: X0 + 124, y: ys, class: 'af-t' }, `wanted ${want}`));
    svg.replaceChildren(...kids);
    const need = slowestNeed(players);
    out.textContent = `${period} delays = ${period * PS_PER_NAND} ps`;
    read.textContent = (period >= need
      ? `Every player is ready before the beat. Coloured: the path from the beat to the new value; grey: the ${SETUP} delays of setup the flip-flop wants first.`
      : `The beat falls before ${names(players.filter((p) => p.need > period).map((p) => p.bit))} ${players.filter((p) => p.need > period).length > 1 ? 'are' : 'is'} ready (red).`)
      + (beats ? (late.length ? ` The count is ${bin(q)} instead of ${bin((prev + 1) & 15)}: the late player still plays the old note.` : ` The count went ${bin(prev)} to ${bin(q)}${period < need ? ': no late bit had to change this time' : ''}.`) : '')
      + ` The slowest player needs ${need} delays.`;
  };
  host.replaceChildren(svg, h('div', { class: 'af-ctl' }, lab, out, beatBtn, resetBtn), read,
    h('p', { class: 'af-note' }, 'Paths are the library 4-bit counter (register plus incrementer) from the static timing analysis. A late player keeping its old value is our simplification; real silicon may catch something half-changed.'));
  paint();
}
