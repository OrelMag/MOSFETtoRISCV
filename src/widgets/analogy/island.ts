// Figure: the floating gate as an island (chapter "flash", "A gate that remembers"): FG_STEP per pulse, FG_READ at the
// read voltage, and FlashDevice's erase count against its endurance.

import { h, s } from '../../ui/dom';
import { FG_READ, FG_STEP } from '../../sim/switchsim';
import { ISLAND_ENDURANCE, Island, PULSES_TO_PROGRAM } from './mem';
import { button } from './common';

const W = 360, SX = 16, SW = 200;
type Last = 'program' | 'erase' | 'read' | null;

export default function mount(host: HTMLElement): void {
  const cell = new Island();
  let last: Last = null, note = '';
  const slots = Math.round(1 / FG_STEP);
  const svg = s('svg', { viewBox: `0 0 ${W} 236`, class: 'af-svg', role: 'img', 'aria-label': 'A floating island of charge between a control gate and a channel, a charge gauge with the read mark, and a wear meter' });
  const read = h('p', { class: 'af-read', 'aria-live': 'polite' });
  const prog = button('Program pulse', () => { note = cell.program() ? '' : 'The block is worn out: the pulse changes nothing.'; last = 'program'; paint(); });
  const rd = button('Read', () => { last = 'read'; note = ''; paint(); });
  const er = button('Erase', () => { note = cell.erase() ? '' : 'The erase failed: the block is bad.'; last = 'erase'; paint(); });
  const wear = button('Erase ×50', () => { note = ''; for (let i = 0; i < 50; i++) if (!cell.erase()) { note = 'The erase failed: the block is bad.'; break; } last = 'erase'; paint(); });

  const arrows = (up: boolean) => [SX + 40, SX + 100, SX + 160].map((x) => s('path', { d: up ? `M${x},124 v-14 m-4,5 l4,-5 l4,5` : `M${x},110 v14 m-4,-5 l4,5 l4,-5`, class: 'af-tunnel' }));

  const paint = () => {
    const q = cell.q, dots = Math.round(q / FG_STEP), r = cell.read();
    const gy = 14, gh = 118, fill = gh * q, mark = gy + gh * (1 - FG_READ);
    const conduct = last === 'read' ? r === 1 : null;
    svg.replaceChildren(
      s('rect', { x: SX, y: 6, width: SW, height: 26, rx: 3, class: 'af-room' }),
      s('text', { x: SX + SW / 2, y: 25, 'text-anchor': 'middle', class: 'af-t' }, 'control gate'),
      s('rect', { x: SX + 10, y: 44, width: SW - 20, height: 62, rx: 6, class: `af-island${cell.worn ? ' worn' : ''}` }),
      s('text', { x: SX + SW / 2, y: 62, 'text-anchor': 'middle', class: 'af-t af-m' }, 'island'),
      ...Array.from({ length: slots }, (_, k) => s('circle', { cx: SX + 30 + k * ((SW - 60) / (slots - 1)), cy: 88, r: 8, class: k < dots ? 'af-charge' : 'af-slot' })),
      ...(last === 'program' && cell.pulses ? arrows(true) : last === 'erase' ? arrows(false) : []),
      s('rect', { x: SX, y: 128, width: SW, height: 28, rx: 3, class: `af-channel${conduct === null ? '' : conduct ? ' on' : ' off'}` }),
      s('text', { x: SX + SW / 2, y: 148, 'text-anchor': 'middle', class: 'af-t' }, conduct === null ? 'channel' : conduct ? 'channel conducts' : 'channel stays off'),
      // the gauge: charge on the island, and the read threshold
      s('text', { x: 280, y: 11, 'text-anchor': 'middle', class: 'af-t af-m' }, 'charge'),
      s('rect', { x: 268, y: gy + 4, width: 24, height: gh, class: 'af-plot' }),
      s('rect', { x: 269, y: gy + 4 + gh - fill, width: 22, height: fill, class: 'af-charge-bar' }),
      s('line', { x1: 262, x2: 298, y1: mark + 4, y2: mark + 4, class: 'af-mark' }),
      s('text', { x: 302, y: mark + 9, class: 'af-t af-m' }, String(FG_READ)),
      s('text', { x: 280, y: gy + gh + 24, 'text-anchor': 'middle', class: 'af-t' }, q.toFixed(1)),
      // wear
      s('text', { x: 4, y: 188, class: 'af-t' }, `erases ${cell.erases} of ${ISLAND_ENDURANCE}`),
      s('rect', { x: 4, y: 196, width: W - 8, height: 14, rx: 3, class: 'af-plot' }),
      s('rect', { x: 5, y: 197, width: Math.max(0, (W - 10) * Math.min(1, cell.erases / ISLAND_ENDURANCE)), height: 12, rx: 2, class: `af-wear${cell.worn ? ' dead' : ''}` }),
      s('text', { x: 4, y: 230, class: 'af-t af-m' }, cell.worn ? 'worn out: the block is bad' : `${cell.pulses} program pulses so far`));
    prog.disabled = cell.worn;
    const bit = last === 'read' ? ` Read: ${r === 1 ? 'the charge is below' : 'the charge is at or above'} ${FG_READ}, so the cell ${r === 1 ? 'conducts and reads 1' : 'stays off and reads 0'}.` : '';
    read.textContent = `Each pulse pushes ${FG_STEP} of charge across the oxide, so reading 0 takes ${PULSES_TO_PROGRAM} (${(PULSES_TO_PROGRAM * FG_STEP).toFixed(1)} ≥ ${FG_READ}) and the island holds at most 1. Erase empties it and counts one of the block's ${ISLAND_ENDURANCE} erases (this chapter's wear model).${bit}${note ? ' ' + note : ''}`;
  };
  host.replaceChildren(svg, h('div', { class: 'af-ctl' }, prog, rd, er, wear), read);
  paint();
}
