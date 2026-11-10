// What a ferrite core opens onto (lib/coremem.ts): it has no transistors to drill into, so its idealised square
// hysteresis loop (Forrester's patent: "an almost rectangular hysteresis loop"), drawn in the units the circuit counts,
// half-selects, with this core's bit and the drive through it now.

import { CORE_FULL, coreSwitching, isCoreState } from '../sim/core';
import { h, s as svg } from '../ui/dom';
import type { Widget } from '../view/stage';

/** The drive axis runs from -SPAN to +SPAN half-selects. */
const SPAN = 3;
const W = 300, H = 170, PAD = 28;
const xOf = (d: number) => PAD + ((d + SPAN) / (2 * SPAN)) * (W - 2 * PAD);
const yOf = (b: number) => (b ? PAD : H - PAD);

/** The loop's outline: a 0 holds until the drive reaches +2 and switches up there; a 1 holds until -2 and switches down there. */
export const LOOP_PATH = `M${xOf(-SPAN)},${yOf(0)} H${xOf(CORE_FULL)} V${yOf(1)} M${xOf(SPAN)},${yOf(1)} H${xOf(-CORE_FULL)} V${yOf(0)}`;
export { xOf as loopX, yOf as loopY };

/** What a drive of d half-selects is made of in this circuit (the phase that drives it). */
function driveWords(lo: number, hi: number): string {
  if (lo !== hi) return 'unknown (a select line is X)';
  if (lo === 0) return 'none';
  const n = Math.abs(lo);
  if (lo >= CORE_FULL) return `+${lo}: write halves on its X and its Y line`;
  if (lo <= -CORE_FULL) return `${lo}: read halves on its X and its Y line`;
  return `${lo > 0 ? '+' : ''}${lo}: ${n === 1 ? 'one half-select' : `${n} halves`}${lo === 1 ? ' (half-selected: it holds)' : ' (it holds)'}`;
}

export function coreLoopWidget(state: () => unknown): Widget {
  const dot = svg('circle', { r: 5, class: 'core-loop-dot' });
  const trail = svg('path', { class: 'core-loop-move' });
  const tick = (d: number) => svg('text', { x: xOf(d), y: H - 8, class: 'core-loop-tick', 'text-anchor': 'middle' }, d > 0 ? `+${d}` : String(d));
  const pic = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'core-loop', role: 'img', 'aria-label': 'The core\'s square hysteresis loop with its bit and the drive through it now' },
    svg('line', { x1: PAD - 8, y1: H / 2, x2: W - PAD + 8, y2: H / 2, class: 'core-loop-axis' }),
    svg('line', { x1: xOf(0), y1: PAD - 10, x2: xOf(0), y2: H - PAD + 10, class: 'core-loop-axis' }),
    svg('path', { d: LOOP_PATH, class: 'core-loop-line' }),
    svg('path', { d: `M${xOf(CORE_FULL) - 4},${H / 2 + 6} L${xOf(CORE_FULL)},${H / 2 - 2} L${xOf(CORE_FULL) + 4},${H / 2 + 6} M${xOf(-CORE_FULL) - 4},${H / 2 - 6} L${xOf(-CORE_FULL)},${H / 2 + 2} L${xOf(-CORE_FULL) + 4},${H / 2 - 6}`, class: 'core-loop-line' }),
    svg('text', { x: PAD - 12, y: yOf(1) + 4, class: 'core-loop-tick', 'text-anchor': 'end' }, '1'),
    svg('text', { x: PAD - 12, y: yOf(0) + 4, class: 'core-loop-tick', 'text-anchor': 'end' }, '0'),
    ...[-2, -1, 1, 2].map(tick),
    trail, dot);
  const now = h('p', { class: 'sub' });
  const el = h('div', { class: 'core-loop-host' }, pic, h('p', { class: 'sub' }, 'Drive in half-selects: a write half +1, a read half or the inhibit -1. Anything short of ±2 leaves the bit where it is.'), now);
  const update = () => {
    const s = state();
    if (!isCoreState(s)) { now.textContent = ''; return; }
    const { b, lo, hi } = s;
    const d = lo === hi ? Math.max(-SPAN, Math.min(SPAN, lo)) : 0;
    const sw = coreSwitching(b, lo, hi);
    dot.setAttribute('cx', String(xOf(d)));
    dot.setAttribute('cy', String(b < 0 ? H / 2 : yOf(b)));
    dot.setAttribute('class', `core-loop-dot${b < 0 ? ' x' : b ? ' one' : ''}`);
    // a switching core: the path it is taking up or down its side of the loop
    trail.setAttribute('d', sw === 1 ? `M${xOf(d)},${yOf(b)} V${yOf(b ? 0 : 1)}` : '');
    now.textContent = `Bit ${b < 0 ? 'unknown' : b}. Drive now ${driveWords(lo, hi)}.${sw === 1 ? ` It switches to ${b ? 0 : 1}: the change of flux is the pulse on the sense wire.` : ''}`;
  };
  update();
  return { el, update };
}
