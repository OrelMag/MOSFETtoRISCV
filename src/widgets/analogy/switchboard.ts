// Figure: a hotel switchboard as an address decoder (chapter "memory", "Four words, one address").

import { h, s } from '../../ui/dom';
import { board, BOARD_BITS } from './steer';
import { button, setPressed } from './common';

const W = 360, CELL_W = 84, CELL_H = 34, GAP = 8;

export default function mount(host: HTMLElement): void {
  let n = 2, addr = 1, writes = 0;
  const words: number[] = new Array(16).fill(0);
  const svg = s('svg', { viewBox: `0 0 ${W} 172`, class: 'af-svg', role: 'img', 'aria-label': 'Rooms of a switchboard; the decoder lights the line of the addressed one' });
  const read = h('p', { class: 'af-read', 'aria-live': 'polite' });
  const note = h('p', { class: 'af-note' });
  const slider = h('input', { type: 'range', min: '0', max: '3', step: '1', value: '1', 'aria-label': 'Address' }) as HTMLInputElement;
  slider.addEventListener('input', () => { addr = Number(slider.value); paint(); });
  const sliderText = document.createTextNode('');
  const sliderLab = h('label', null, sliderText, slider);
  const bitBtns = BOARD_BITS.map((k) => button(`${k} bit${k > 1 ? 's' : ''}`, () => { n = k; addr = Math.min(addr, 2 ** n - 1); paint(); }, k === n));
  const write = button('Write', () => { words[addr] = (++writes % 15) + 1; paint(); });

  const paint = () => {
    const b = board(n, addr);
    slider.max = String(b.rooms - 1); slider.value = String(addr);
    const cols = Math.min(4, b.rooms), rows = Math.ceil(b.rooms / cols);
    const x0 = (W - (cols * CELL_W + (cols - 1) * GAP)) / 2;
    const cells = b.lines.map((on, k) => {
      const x = x0 + (k % cols) * (CELL_W + GAP), y = 4 + Math.floor(k / cols) * (CELL_H + GAP);
      return s('g', null,
        s('rect', { x, y, width: CELL_W, height: CELL_H, rx: 5, class: on ? 'af-bucket af-lit' : 'af-bucket' }),
        s('text', { x: x + 8, y: y + 23, class: on ? 'af-t af-litt' : 'af-t' }, k.toString(2).padStart(n, '0')),
        s('text', { x: x + CELL_W - 8, y: y + 23, 'text-anchor': 'end', class: 'af-big sm' }, words[k] ? words[k].toString(16).toUpperCase() : '·'));
    });
    svg.setAttribute('viewBox', `0 0 ${W} ${rows * (CELL_H + GAP) - GAP + 8}`);
    svg.replaceChildren(...cells);
    bitBtns.forEach((btn, i) => setPressed(btn, BOARD_BITS[i] === n));
    sliderText.data = `Address ${addr.toString(2).padStart(n, '0')} `;
    read.textContent = `${n} address bit${n > 1 ? 's' : ''}: ${b.rooms} rooms. The decoder lit line ${addr}; Write puts a word in that room only.`;
    note.textContent = `Decoder cost: ${b.nands} NAND${b.nands === 1 ? "" : "s"} for ${b.rooms} rooms (no write enable).`;
  };
  host.replaceChildren(svg, h('div', { class: 'af-ctl' }, ...bitBtns), h('div', { class: 'af-ctl' }, sliderLab, write), read, note);
  paint();
}
