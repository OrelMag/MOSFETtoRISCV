// Figure: emptyplate, the load-use stall (chapter "pipeline", "The load-use stall").

import { h, s } from '../../ui/dom';
import { button, setPressed } from './common';
import { schedule, type Op } from './pipe';
import { GRID_W, gridHeight, gridKids } from './pipegridsvg';

const ops = (dependent: boolean): Op[] => [{ name: '1', kind: 'load' }, { name: '2', kind: 'alu', dep: dependent ? 1 : 0 }, { name: '3', kind: 'alu' }];
const COLS = schedule(ops(true), true).cycles;

export default function mount(host: HTMLElement): void {
  let dependent = true, shown = COLS;
  const svg = s('svg', { viewBox: `0 0 ${GRID_W} ${gridHeight()}`, class: 'af-svg', role: 'img', 'aria-label': 'Three dishes through five cooks; dish 1 is a load whose result dish 2 may need' });
  const read = h('p', { class: 'af-read', 'aria-live': 'polite' });
  const depBtn = button('Dish 2 needs the load', () => { dependent = !dependent; shown = COLS; paint(); }, true);
  const stepBtn = button('Step', () => { shown = shown >= COLS ? 1 : shown + 1; paint(); });
  const paint = () => {
    const sc = schedule(ops(dependent), true);
    const t = Math.min(shown, sc.cycles);
    svg.replaceChildren(...gridKids({ cells: sc.cells, bubbles: sc.bubbles, hands: sc.hands, cols: COLS, shown: t, label: (i) => String(i + 1) }));
    setPressed(depBtn, dependent);
    depBtn.textContent = dependent ? 'Dish 2 needs the load' : 'Dish 2 is independent';
    stepBtn.textContent = t >= sc.cycles ? 'Replay' : `Step (${t}/${sc.cycles})`;
    read.textContent = t < sc.cycles ? `Cycle ${t} of ${sc.cycles}.`
      : dependent
        ? `${sc.cycles} cycles: dish 1 (a load) has its data only at the end of M, one cycle after dish 2's cook needs it in E. Dish 2 waits one beat in D and an empty plate (the dashed bubble) travels down the line through E, M and W. The arrow is the forwarding from W.`
        : `${sc.cycles} cycles, no bubble: dish 2 does not read the load's result, so nothing waits. Only an instruction that reads it in the very next slot costs a beat.`;
  };
  host.replaceChildren(svg, h('div', { class: 'af-ctl' }, depBtn, stepBtn), read);
  paint();
}
