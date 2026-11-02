// Figure: desk, shelf, library, warehouse (chapter "cache", "The memory hierarchy"): a stream of requests through the
// hierarchy table's four places, each a real CacheModel; a miss brings back a whole line.

import { h, s } from '../../ui/dom';
import { DESK_TIERS, Desk, LINE_BYTES, tierCycles, type DeskAccess, type Pattern } from './mem';
import { button, frames, reducedMotion, setPressed } from './common';

const W = 360, ROW = 32, BAR_X = 104, BAR_MAX = 150, SHOWN = 16, SQ = 20;
const hex = (a: number) => `0x${a.toString(16)}`;

export default function mount(host: HTMLElement): void {
  let pattern: Pattern = 'sequential', desk = new Desk(), running = false, looping = false;
  const svg = s('svg', { viewBox: `0 0 ${W} 240`, class: 'af-svg', role: 'img', 'aria-label': 'Four places to fetch from, their walking times, the last requests and the lines on the desk' });
  const read = h('p', { class: 'af-read', 'aria-live': 'polite' });
  const seq = button('Sequential', () => pick('sequential'), true), rnd = button('Random', () => pick('random'), false);
  const step = (n: number) => { for (let i = 0; i < n; i++) desk.access(desk.nextAddr(pattern)); paint(); };
  const pick = (p: Pattern) => { pattern = p; desk = new Desk(); paint(); };
  const runBtn = button('Run', () => {
    running = !running;
    paint();
    if (running && !looping) {
      looping = true;
      let acc = 0;
      frames(host, (dt) => { if (!running) { looping = false; return false; } acc += dt; if (acc > 160) { acc = 0; step(1); } });
    }
  }, false);

  const paint = () => {
    const kids: SVGElement[] = [], last: DeskAccess | undefined = desk.log.at(-1);
    DESK_TIERS.forEach((t, i) => {
      const y = 4 + i * ROW, c = tierCycles(i), w = (Math.log(c) / Math.log(tierCycles(3))) * BAR_MAX, on = last?.tier === i;
      kids.push(
        s('text', { x: 2, y: y + 19, class: `af-t${on ? ' af-strong' : ''}` }, t.place),
        s('rect', { x: BAR_X, y: y + 3, width: Math.max(w, 6), height: ROW - 10, rx: 3, class: `af-tier t${i}${on ? ' on' : ''}` }),
        s('text', { x: BAR_X + Math.max(w, 6) + 6, y: y + 19, class: 'af-t af-m' }, `${c} cycles`));
    });
    kids.push(s('text', { x: 2, y: 4 + 4 * ROW + 14, class: 'af-t af-m' }, 'walking time, log scale'));
    // the request stream, newest on the right
    const sy = 4 + 4 * ROW + 28, shown = desk.log.slice(-SHOWN);
    kids.push(s('text', { x: 2, y: sy + 15, class: 'af-t' }, 'requests'));
    shown.forEach((a, k) => kids.push(s('rect', { x: 100 + k * 16, y: sy, width: 14, height: SQ, rx: 2, class: `af-tier t${a.tier}` })));
    // the desk: 4 lines of 4 words; the line a miss just brought lights up
    const dy = sy + SQ + 26, lines = desk.deskLines();
    kids.push(s('text', { x: 2, y: dy - 8, class: 'af-t' }, 'on the desk: 4 lines of 4 words'));
    lines.forEach((base, k) => {
      const x = 4 + k * 88;
      for (let wd = 0; wd < LINE_BYTES / 4; wd++) {
        const addr = base === null ? -1 : base + 4 * wd, cur = last && addr === last.addr;
        const fresh = last?.filled !== null && last?.filled !== undefined && base === last.filled;
        kids.push(s('rect', { x: x + wd * 20, y: dy, width: 18, height: 22, rx: 2, class: `af-cell${base === null ? '' : ' full'}${fresh ? ' new' : ''}${cur ? ' cur' : ''}` }));
      }
    });
    svg.replaceChildren(...kids);
    setPressed(seq, pattern === 'sequential');
    setPressed(rnd, pattern === 'random');
    setPressed(runBtn, running);
    runBtn.textContent = running ? 'Stop' : 'Run';
    const n = desk.accesses;
    if (!last) read.textContent = 'Press Step: each request starts at the desk and walks outward until some place has the word.';
    else {
      const t = DESK_TIERS[last.tier];
      const first = `Word ${hex(last.addr)}: ${last.tier === 0 ? 'on the desk' : `not on the desk; found ${last.tier === 3 ? 'only in the warehouse' : `in the ${t.place}`}`}, ${last.cycles} cycles.`;
      const fill = last.filled === null ? '' : ` A whole line of ${LINE_BYTES / 4} words (${hex(last.filled)}–${hex(last.filled + LINE_BYTES - 1)}) came back to the desk: the highlighted neighbours are free next time.`;
      read.textContent = `${first}${fill} After ${n}: average ${desk.average.toFixed(1)} cycles; served by the desk ${desk.hits[0]}, shelf ${desk.hits[1]}, library ${desk.hits[2]}, warehouse ${desk.hits[3]}.`;
    }
  };
  const ctl = h('div', { class: 'af-ctl' }, seq, rnd, button('Step', () => step(1)), button('Step ×16', () => step(16)));
  if (!reducedMotion()) ctl.append(runBtn);
  host.replaceChildren(svg, ctl, read,
    h('p', { class: 'af-note' }, 'Places and times are in the step\'s hierarchy table (desk L1, shelf L2, library L3, warehouse DRAM; cycles = ns × 4). The figure\'s caches are scaled down to 64 B, 256 B and 1 KB so a short run shows every level.'));
  paint();
}
