// Chapter 20's "Polling or interrupting": two programs run on the golden model at the chosen event period and work
// chunk (riscv/pollirq.ts). The strips are the first 240 cycles; the table is the whole run.

import { crossover, runPollIrq, STRIP, type PollIrqRun } from '../riscv/pollirq';
import { h, s } from '../ui/dom';
import type { Widget } from '../view/stage';
import '../styles/pollirq.css';

const RUN = 6000;
const PERIODS = [10, 15, 20, 30, 40, 60, 80, 120, 200, 400, 1000, 2000];
const pct = (x: number) => `${(100 * x).toFixed(1)} %`;

function strip(run: PollIrqRun, period: number, first: number): SVGElement {
  const svg = s('svg', { class: 'pi-strip', viewBox: `0 0 ${STRIP} 10`, preserveAspectRatio: 'none', role: 'img', 'aria-label': 'The first 240 cycles: work and overhead' });
  let i = 0;
  while (i < run.strip.length) {
    let j = i;
    while (j < run.strip.length && run.strip[j] === run.strip[i]) j++;
    svg.append(s('rect', { class: run.strip[i], x: i, y: 0, width: j - i, height: 10 }));
    i = j;
  }
  for (let d = first; d < STRIP; d += period) svg.append(s('line', { class: 'ev', x1: d, x2: d, y1: 0, y2: 10 }));
  return svg;
}

export function pollIrqWidget(): Widget {
  let period = 40, chunk = 6;
  const out = h('div');
  const ctl = (label: string, min: number, max: number, get: () => number, set: (v: number) => void, steps?: number[]) => {
    const o = h('output', null, String(get()));
    const inp = h('input', { type: 'range', min: String(steps ? 0 : min), max: String(steps ? steps.length - 1 : max), value: String(steps ? steps.indexOf(get()) : get()), 'aria-label': label,
      oninput: () => { const v = steps ? steps[+inp.value] : +inp.value; set(v); o.textContent = String(v); render(); } }) as HTMLInputElement;
    return [h('span', null, label), inp, o];
  };
  const el = h('div', { class: 'widget' }, h('div', { class: 'panel pi' }, h('h3', null, 'Polling against interrupts'), h('div', { class: 'pi-ctl' },
    ...ctl('event period (cycles)', 0, 0, () => period, (v) => (period = v), PERIODS),
    ...ctl('work between polls (instructions)', 2, 40, () => chunk, (v) => (chunk = v))), out));

  function render(): void {
    const p = runPollIrq('poll', period, chunk, RUN), q = runPollIrq('irq', period, chunk, RUN);
    const x = crossover(chunk);
    const row = (name: string, r: PollIrqRun, win: boolean) => h('tr', null, h('td', null, name),
      h('td', { class: win ? 'win' : '' }, pct(r.work / r.cycles)), h('td', null, (r.overhead / Math.max(1, r.served)).toFixed(1)),
      h('td', null, String(r.worst)), h('td', null, r.mean.toFixed(1)));
    out.replaceChildren(
      h('div', { class: 'pi-cap' }, 'Polling (work, then read mtime and branch)'), strip(p, period, p.first),
      h('div', { class: 'pi-cap' }, 'Interrupt (work; trap, handler and mret when due)'), strip(q, period, q.first),
      h('div', { class: 'pi-legend' }, h('span', null, h('i', { class: 'w' }), 'work'), h('span', null, h('i', { class: 'o' }), 'overhead'), h('span', null, h('i', { class: 'ev' }), 'event due')),
      h('table', { class: 'pi-t' },
        h('tr', null, h('th', null, `${RUN} cycles`), h('th', null, 'cycles on work'), h('th', null, 'overhead / event'), h('th', null, 'worst latency'), h('th', null, 'mean latency')),
        row('polling', p, p.work >= q.work), row('interrupt', q, q.work > p.work)),
      h('p', { class: 'pi-note' }, `Served: ${p.served} and ${q.served} events. With ${chunk} instructions between polls the interrupt version leaves more cycles for work once events are at least ${x} cycles apart; latency is a poll away (${p.worst} worst) against a trap entry (${q.worst}).`));
  }
  render();
  return { el };
}
