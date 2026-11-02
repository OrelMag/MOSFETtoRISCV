// Figure: handoff, forwarding (chapter "pipeline", "Data hazards and forwarding").

import { h, s } from '../../ui/dom';
import { button, setPressed } from './common';
import { schedule, type Op } from './pipe';
import { GRID_W, gridHeight, gridKids } from './pipegridsvg';

const OPS: Op[] = [{ name: '1', kind: 'alu' }, { name: '2', kind: 'alu', dep: 1 }];
// the slowest mode sets the width
const COLS = schedule(OPS, false).cycles;

export default function mount(host: HTMLElement): void {
  let fwd = true;
  const svg = s('svg', { viewBox: `0 0 ${GRID_W} ${gridHeight()}`, class: 'af-svg', role: 'img', 'aria-label': "Two dishes through five cooks F D E M W; the second needs the first one's sauce" });
  const read = h('p', { class: 'af-read', 'aria-live': 'polite' });
  const btn = button('Forwarding', () => { fwd = !fwd; paint(); }, true);
  const paint = () => {
    const sc = schedule(OPS, fwd);
    svg.replaceChildren(...gridKids({ cells: sc.cells, bubbles: sc.bubbles, hands: sc.hands, cols: COLS, shown: sc.cycles, label: (i) => OPS[i].name }));
    setPressed(btn, fwd);
    btn.textContent = fwd ? 'Forwarding on' : 'Forwarding off';
    read.textContent = fwd
      ? `${sc.cycles} cycles, no wait: dish 1's sauce is ready at the end of its cook E, and the arrow hands it from M straight to dish 2's cook in E. That arrow is a multiplexer input in front of the ALU, the extra hand.`
      : `${sc.cycles} cycles, ${sc.stalls} lost: dish 2 waits in D (pale cells; the dashed cells behind are bubbles) until dish 1's sauce is on the shelf, the register file, which it reaches when dish 1 is in W. Rows are the stages F, D, E, M, W; columns the clock cycles.`;
  };
  host.replaceChildren(svg, h('div', { class: 'af-ctl' }, btn), read);
  paint();
}
