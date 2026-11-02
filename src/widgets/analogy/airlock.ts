// Figure: the master-slave flip-flop as an airlock (chapter "latches", "The flip-flop: act only on the edge").

import { h, s } from '../../ui/dom';
import { airlockEdge, airlockSetD, airlockStart, type Airlock } from './model';
import { button, reducedMotion, setPressed } from './common';

const W = 360, H = 150, STEP_MS = 420;

export default function mount(host: HTMLElement): void {
  let st: Airlock = airlockStart(), busy = false;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'af-svg', role: 'img', 'aria-label': 'Two doors with a chamber between them: the master and slave latches' });
  const read = h('p', { class: 'af-read', 'aria-live': 'polite' });
  const bit = (v: boolean) => (v ? '1' : '0');
  const door = (x: number, open: boolean, name: string) => s('g', null,
    s('rect', { x: x - 3, y: 22, width: 6, height: 70, class: 'af-wall' }),
    s('rect', { x: x - 3, y: open ? 22 : 40, width: 6, height: open ? 14 : 34, class: open ? 'af-door open' : 'af-door' }),
    s('text', { x, y: 112, 'text-anchor': 'middle', class: 'af-t af-m' }, `${name} ${open ? 'open' : 'shut'}`));

  const dBtn = button('D = 0', () => { st = airlockSetD(st, !st.d); paint(); }, false);
  const clkBtn = button('Clock: rise', () => {
    const phases = airlockEdge(st, !st.clk);
    if (reducedMotion()) { st = phases[phases.length - 1]; paint(); return; }
    busy = true;
    phases.forEach((p, i) => setTimeout(() => { if (!host.isConnected) return; st = p; if (i === phases.length - 1) busy = false; paint(); }, i * STEP_MS));
  });

  const paint = () => {
    svg.replaceChildren(
      s('rect', { x: 110, y: 22, width: 140, height: 70, class: 'af-room' }),
      s('text', { x: 180, y: 15, 'text-anchor': 'middle', class: 'af-t af-m' }, 'master chamber'),
      s('text', { x: 180, y: 66, 'text-anchor': 'middle', class: 'af-big' }, bit(st.master)),
      door(110, st.outer, 'outer'), door(250, st.inner, 'inner'),
      s('text', { x: 40, y: 66, 'text-anchor': 'middle', class: 'af-big' }, bit(st.d)),
      s('text', { x: 40, y: 40, 'text-anchor': 'middle', class: 'af-t af-m' }, 'D'),
      s('text', { x: 316, y: 66, 'text-anchor': 'middle', class: 'af-big' }, bit(st.q)),
      s('text', { x: 316, y: 40, 'text-anchor': 'middle', class: 'af-t af-m' }, 'Q (slave)'),
      s('text', { x: 180, y: 140, 'text-anchor': 'middle', class: 'af-t' }, `clock ${st.clk ? 'high' : 'low'}`));
    setPressed(dBtn, st.d);
    dBtn.textContent = `D = ${bit(st.d)}`;
    clkBtn.textContent = st.clk ? 'Clock: fall' : 'Clock: rise';
    clkBtn.disabled = busy;
    read.textContent = st.outer
      ? 'Clock low: the outer door is open, so the chamber follows D. Q keeps its old value.'
      : st.inner ? "Clock high: the inner door is open and Q has the chamber's value; changing D now does nothing."
        : 'Both doors shut for an instant: the doors are never open together.';
  };
  host.replaceChildren(svg, h('div', { class: 'af-ctl' }, dBtn, clkBtn), read);
  paint();
}
