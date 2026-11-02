// Figure: a doorbell, not checking the door (chapter "traps", "The timer interrupt"). Both timelines are the golden
// model's: the chapter's timer program with its interrupt, and the same program polling mtime (system.ts).

import { h, s } from '../../ui/dom';
import { doorbellRun, doorCosts, type DoorRun, type Slice } from './system';
import { slider } from './sysui';

const W = 360, SX = 10, SW = 340, WINDOW = 200, HORIZON = 1000;
const CLS: Record<Slice, string> = { work: 'af-sl-work', check: 'af-sl-check', service: 'af-sl-service', trap: 'af-sl-trap' };

export default function mount(host: HTMLElement): void {
  let every = 40, work = 6;
  const svg = s('svg', { viewBox: `0 0 ${W} 196`, class: 'af-svg', role: 'img', 'aria-label': 'Two timelines of 200 cycles: a CPU that polls, and a CPU that is interrupted' });
  const read = h('p', { class: 'af-read', 'aria-live': 'polite' });
  const a = slider('Visitor every', 16, 100, 4, every, (v) => { every = v; paint(); });
  const b = slider('Poll after', 2, 30, 2, work, (v) => { work = v; paint(); });

  const strip = (y: number, title: string, r: DoorRun): SVGElement[] => {
    const cw = SW / WINDOW, out: SVGElement[] = [s('text', { x: SX, y: y - 18, class: 'af-t' }, title)];
    let from = 0;
    for (let c = 1; c <= WINDOW; c++) {
      if (c === WINDOW || r.slices[c] !== r.slices[from]) {
        out.push(s('rect', { x: SX + from * cw, y, width: (c - from) * cw, height: 22, class: CLS[r.slices[from]] }));
        from = c;
      }
    }
    out.push(s('rect', { x: SX, y, width: SW, height: 22, class: 'af-frame' }));
    for (const arr of r.arrivals) if (arr < WINDOW) out.push(s('path', { d: `M${SX + arr * cw - 5},${y - 12} h10 l-5,10 z`, class: 'af-visitor' }));
    return out;
  };

  const paint = () => {
    const pollW = doorbellRun('poll', every, work, WINDOW), irqW = doorbellRun('irq', every, work, WINDOW);
    const poll = doorbellRun('poll', every, work, HORIZON), irq = doorbellRun('irq', every, work, HORIZON), c = doorCosts();
    const share = (r: DoorRun, k: Slice) => r.slices.filter((x) => x === k).length / r.slices.length;
    const pct = (x: number) => `${Math.round(x * 100)}%`;
    const avg = (d: number[]) => (d.length ? d.reduce((x, y) => x + y, 0) / d.length : 0);
    const lg = (x: number, label: string, k: Slice) => [s('rect', { x, y: 142, width: 14, height: 14, class: CLS[k] }), s('text', { x: x + 19, y: 154, class: 'af-t' }, label)];
    svg.replaceChildren(...strip(36, 'Polling: check the door', pollW), ...strip(104, 'Interrupt: the bell', irqW),
      ...lg(SX, 'work', 'work'), ...lg(SX + 70, 'poll', 'check'), ...lg(SX + 140, 'service', 'service'), ...lg(SX + 230, 'trap entry', 'trap'),
      s('path', { d: `M${SX + 5},176 h10 l-5,10 z`, class: 'af-visitor' }), s('text', { x: SX + 22, y: 186, class: 'af-t' }, 'a visitor arrives'));
    const worst = (d: number[]) => Math.max(0, ...d);
    read.textContent = `Visitor every ${every} cycles, a poll after every ${work} cycles of work (so ${work + c.check} per round). Over ${HORIZON} cycles, polling spends ${pct(1 - share(poll, 'work'))} of them not working (polls ${pct(share(poll, 'check'))}, service ${pct(share(poll, 'service'))}); a visitor waits ${avg(poll.delays).toFixed(1)} cycles on average, up to ${worst(poll.delays)}. `
      + `The bell spends ${pct(1 - share(irq, 'work'))} (${c.trap} trap + ${c.handler} handler = ${c.trap + c.handler} cycles a visit) and answers in ${worst(irq.delays)} cycles. `
      + `${1 - share(irq, 'work') < 1 - share(poll, 'work') ? 'The bell wastes fewer cycles here.' : 'Polling wastes fewer cycles here.'} Each poll that finds nothing costs ${c.check} cycles; service is the handler's body, ${c.serve} cycles polled.`;
  };
  host.replaceChildren(svg, h('div', { class: 'af-ctl' }, a.el, b.el), read);
  paint();
}
