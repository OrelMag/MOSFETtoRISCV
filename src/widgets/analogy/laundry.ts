// Figure: laundry, the pipeline (chapter "pipeline", "Overlap the work").

import { h, s } from '../../ui/dom';
import { LOADS, STAGES, STAGE_NAMES, laundry } from './model';
import { button, setPressed } from './common';

const W = 360, L = 48, TOP = 24, ROW = 34, SLOT_MAX = 12;

export default function mount(host: HTMLElement): void {
  let pipelined = true, stall = false;
  const svg = s('svg', { viewBox: `0 0 ${W} ${TOP + LOADS * ROW + 22}`, class: 'af-svg', role: 'img', 'aria-label': 'Timeline of four laundry loads through wash, dry and fold' });
  const read = h('p', { class: 'af-read', 'aria-live': 'polite' });
  const modeBtn = button('Pipelined', () => { pipelined = !pipelined; paint(); }, true);
  const stallBtn = button('Load 3 waits on load 2', () => { stall = !stall; paint(); }, false);

  const paint = () => {
    const sch = laundry(pipelined, stall), cw = (W - L - 4) / SLOT_MAX;
    const kids: SVGElement[] = [];
    for (let t = 0; t < sch.slots; t++) kids.push(s('text', { x: L + t * cw + cw / 2, y: 14, 'text-anchor': 'middle', class: 'af-t af-m' }, String(t + 1)));
    kids.push(s('text', { x: 2, y: 14, class: 'af-t af-m' }, 'slot'));
    for (let i = 0; i < LOADS; i++) kids.push(s('text', { x: 2, y: TOP + i * ROW + ROW / 2 + 4, class: 'af-t' }, `Load ${i + 1}`));
    for (const c of sch.cells) kids.push(s('g', null,
      s('rect', { x: L + c.slot * cw + 1, y: TOP + c.load * ROW + 3, width: cw - 2, height: ROW - 8, rx: 3, class: `af-stage st${c.stage}` }),
      s('text', { x: L + c.slot * cw + cw / 2, y: TOP + c.load * ROW + ROW / 2 + 2, 'text-anchor': 'middle', class: 'af-t af-on' }, STAGE_NAMES[c.stage][0])));
    // a bubble: the empty slot in a machine's row, drawn on the load that waited behind it
    for (const b of sch.bubbles) {
      const c = sch.cells.find((x) => x.stage === b.stage && x.slot === b.slot + 1)!;
      kids.push(s('rect', { x: L + b.slot * cw + 1, y: TOP + c.load * ROW + 3, width: cw - 2, height: ROW - 8, rx: 3, class: 'af-bubble' }));
    }
    kids.push(s('line', { x1: L, x2: L + sch.slots * cw, y1: TOP + LOADS * ROW + 2, y2: TOP + LOADS * ROW + 2, class: 'af-half' }),
      s('text', { x: L + sch.slots * cw, y: TOP + LOADS * ROW + 16, 'text-anchor': 'end', class: 'af-t' }, `all done after ${sch.slots} slots`));
    svg.replaceChildren(...kids);
    setPressed(modeBtn, pipelined);
    modeBtn.textContent = pipelined ? 'Pipelined' : 'One at a time';
    setPressed(stallBtn, stall);
    stallBtn.disabled = !pipelined;
    const how = pipelined ? 'a load finishes every slot once the pipe is full' : `${STAGES} slots a load, one load at a time`;
    read.textContent = `${sch.slots} slots for ${LOADS} loads: ${how}${pipelined && stall ? '; the dashed cells are bubbles, and every load behind waits' : ''}. W, D, F: wash, dry, fold. In the CPU a slot is one clock cycle and the stages are F / D / E / M / W.`;
  };
  host.replaceChildren(svg, h('div', { class: 'af-ctl' }, modeBtn, stallBtn), read);
  paint();
}
