// Figure: the SR latch as two people who always disagree (chapter "latches", "Two NANDs holding hands").

import { h, s } from '../../ui/dom';
import '../../styles/analogy-d.css';
import { SR_POWER_ON, srSettle, type Say } from './storage';
import { button, reducedMotion, setPressed } from './common';

const W = 360, H = 190, STEP_MS = 520;

export default function mount(host: HTMLElement): void {
  let st: Say = SR_POWER_ON;
  let inp = { sn: 1, rn: 1 }, token = 0;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'af-svg', role: 'img', 'aria-label': 'Two speech bubbles, A and B, each saying the opposite of the other' });
  const read = h('p', { class: 'af-read', 'aria-live': 'polite' });
  const word = (v: number) => (v ? 'yes' : 'no');

  const bubble = (x: number, name: string, v: number, shouting: boolean, ear: string) => s('g', null,
    s('text', { x: x + 55, y: 62, 'text-anchor': 'middle', class: 'af-t af-m' }, name),
    s('rect', { x, y: 70, width: 110, height: 52, rx: 14, class: v ? 'af-say yes' : 'af-say' }),
    s('text', { x: x + 55, y: 105, 'text-anchor': 'middle', class: 'af-big' }, word(v)),
    s('path', { d: `M ${x + 55} 28 L ${x + 55} 48`, class: shouting ? 'af-shout' : 'af-ear' }),
    s('text', { x: x + 55, y: 22, 'text-anchor': 'middle', class: shouting ? 'af-t af-shoutt' : 'af-t af-m' }, shouting ? `${ear} shouts` : `${ear} quiet`));

  const paint = (frame: Say, note?: string) => {
    svg.replaceChildren(
      bubble(20, 'A', frame.a, inp.sn === 0, 'Set'),
      bubble(230, 'B', frame.b, inp.rn === 0, 'Reset'),
      s('path', { d: 'M 134 86 L 224 86 M 216 80 L 224 86 L 216 92', class: 'af-link' }),
      s('path', { d: 'M 226 108 L 136 108 M 144 102 L 136 108 L 144 114', class: 'af-link' }),
      s('text', { x: 180, y: 78, 'text-anchor': 'middle', class: 'af-t af-m' }, 'says the'),
      s('text', { x: 180, y: 130, 'text-anchor': 'middle', class: 'af-t af-m' }, 'opposite'),
      s('text', { x: 180, y: 170, 'text-anchor': 'middle', class: 'af-t' }, "A is the latch's q, B is q_n"));
    setPressed(setBtn, inp.sn === 0 && inp.rn === 1);
    setPressed(resetBtn, inp.sn === 1 && inp.rn === 0);
    setPressed(relBtn, inp.sn === 1 && inp.rn === 1);
    read.textContent = note ?? (inp.sn === 0 ? 'A is being told "yes" and B follows with "no".'
      : inp.rn === 0 ? 'B is being told "yes", so A follows with "no".'
        : `Nobody is shouting: A says ${word(frame.a)}, B says ${word(frame.b)}, and each keeps the other where it is.`);
  };

  const press = (sn: number, rn: number) => {
    const my = ++token;
    inp = { sn, rn };
    const r = srSettle(st, sn, rn);
    const bothYes = 'For one gate delay both say "yes": the one just told has spoken, the other has not heard yet.';
    if (reducedMotion()) { st = r.final; paint(r.final); return; }
    r.frames.forEach((f, i) => setTimeout(() => {
      if (my !== token || !host.isConnected) return;
      if (i === r.frames.length - 1) st = r.final;
      paint(f, i > 0 && f.a && f.b ? bothYes : undefined);
    }, i * STEP_MS));
  };
  const setBtn = button('Set', () => press(0, 1), false), resetBtn = button('Reset', () => press(1, 0), false), relBtn = button('Release', () => press(1, 1), true);
  host.replaceChildren(svg, h('div', { class: 'af-ctl' }, setBtn, resetBtn, relBtn), read);
  paint(st);
}
