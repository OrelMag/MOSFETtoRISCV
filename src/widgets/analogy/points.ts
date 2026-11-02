// Figure: railway points as a 2:1 multiplexer (chapter "gates", "The multiplexer: a digital switch").

import { h, s } from '../../ui/dom';
import { button, setPressed } from './common';
import { PointsRun } from './steer';

const W = 360, H = 150;

export default function mount(host: HTMLElement): void {
  const run = new PointsRun();
  let y = 0, wire = 0, inner = 0, out = 0, last = 'Settled at s = 0, a = 0, b = 0.';
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'af-svg', role: 'img', 'aria-label': 'Two tracks a and b meeting at railway points and continuing as one track y' });
  const read = h('p', { class: 'af-read', 'aria-live': 'polite' });
  const tally = h('p', { class: 'af-note' });

  const go = (sv: number, a: number, b: number) => {
    const before = { ...run.state };
    const st = run.set(sv, a, b);
    y = st.y; wire += st.wireToggles; inner += st.innerToggles; out += st.outToggles;
    const unselected = sv === before.s && (sv ? a !== before.a : b !== before.b);
    const what = sv !== before.s ? 'The points moved' : a !== before.a ? 'Track a changed' : 'Track b changed';
    last = `${what}: ${st.wireToggles} input wire toggle${st.wireToggles === 1 ? '' : 's'}, ${st.innerToggles} inside the mux, ${st.outToggles} at y. `
      + (unselected ? 'That track is not selected: its first NAND is blocked by s, so nothing inside moves.' : '');
    paint();
  };
  const sBtn = button('s = 0', () => go(1 - run.state.s, run.state.a, run.state.b), false);
  const aBtn = button('a = 0', () => go(run.state.s, 1 - run.state.a, run.state.b), false);
  const bBtn = button('b = 0', () => go(run.state.s, run.state.a, 1 - run.state.b), false);
  const reset = button('Clear counts', () => { wire = inner = out = 0; last = 'Counts cleared.'; paint(); });

  const paint = () => {
    const { s: sv, a, b } = run.state;
    const path = (sel: boolean, d: string) => s('path', { d, class: sel ? 'af-pipe' : 'af-pipe off' });
    const train = (x: number, yy: number, v: number) => s('g', null,
      s('rect', { x: x - 14, y: yy - 14, width: 28, height: 28, rx: 5, class: 'af-bucket' }),
      s('text', { x, y: yy + 7, 'text-anchor': 'middle', class: 'af-big sm' }, String(v)));
    svg.replaceChildren(
      path(sv === 0, 'M52 40 H150 L215 75 H300'), path(sv === 1, 'M52 110 H150 L215 75 H300'),
      train(30, 40, a), train(30, 110, b), train(328, 75, y),
      s('text', { x: 30, y: 16, 'text-anchor': 'middle', class: 'af-t af-m' }, 'a'),
      s('text', { x: 30, y: 142, 'text-anchor': 'middle', class: 'af-t af-m' }, 'b'),
      s('text', { x: 328, y: 52, 'text-anchor': 'middle', class: 'af-t af-m' }, 'y'),
      s('line', { x1: 215, y1: 75, x2: 170, y2: sv ? 100 : 50, class: 'af-lever' }),
      s('circle', { cx: 215, cy: 75, r: 5, class: 'af-dot' }),
      s('text', { x: 235, y: 140, 'text-anchor': 'middle', class: 'af-t' }, `points: s = ${sv} (${sv ? 'b' : 'a'})`));
    for (const [btn, v, name] of [[sBtn, sv, 's'], [aBtn, a, 'a'], [bBtn, b, 'b']] as const) { btn.textContent = `${name} = ${v}`; setPressed(btn, v === 1); }
    read.textContent = last;
    tally.textContent = `Since cleared: ${wire} toggles on the input wires, ${inner} on the NAND outputs inside the mux, ${out} at y.`;
  };
  host.replaceChildren(svg, h('div', { class: 'af-ctl' }, sBtn, aBtn, bBtn, reset), read, tally);
  paint();
}
