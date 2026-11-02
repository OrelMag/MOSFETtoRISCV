// Figure: the SR latch's race as a ball on a hilltop (chapter "latches", "The forbidden input, and races").

import { h, s } from '../../ui/dom';
import '../../styles/analogy-d.css';
import { expectedHistogram, histogram, mulberry32, rollBoth, rollOne, TIE_BREAK_P, type Roll } from './storage';
import { button, reducedMotion } from './common';

const W = 360, H = 170, TICK_MS = 420, MAX_TICKS = 10, BINS = 8, RUN = 100;
const ground = (x: number) => 128 - 74 * Math.exp(-(((x - 180) / 42) ** 2)) + 22 * (Math.exp(-(((x - 62) / 40) ** 2)) + Math.exp(-(((x - 298) / 40) ** 2)));
const VALLEY_X = [62, 298], TOP_X = 180, R = 11;

export default function mount(host: HTMLElement): void {
  let token = 0, batch = 0;
  let ballX = TOP_X, wobble = 0, label = 'Both inputs held low (the forbidden input): both people say "yes". Choose how to let go.';
  let hist: { counts: number[]; ones: number } | null = null;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'af-svg', role: 'img', 'aria-label': 'A ball on a hill between two valleys, 0 on the left and 1 on the right' });
  const histSvg = s('svg', { viewBox: `0 0 ${W} 130`, class: 'af-svg', role: 'img', 'aria-label': 'Histogram of how many gate delays the ball stayed on the top over 100 releases' });
  const read = h('p', { class: 'af-read', 'aria-live': 'polite' });
  histSvg.style.display = 'none';

  const pts = Array.from({ length: 73 }, (_, i) => { const x = 8 + i * 4.9; return `${x.toFixed(1)},${ground(x).toFixed(1)}`; }).join(' ');
  const paint = () => {
    const ballY = ground(ballX) - R - 1;
    svg.replaceChildren(
      s('polyline', { points: pts, class: 'af-ground' }),
      s('text', { x: VALLEY_X[0], y: 160, 'text-anchor': 'middle', class: 'af-t' }, 'valley 0'),
      s('text', { x: VALLEY_X[1], y: 160, 'text-anchor': 'middle', class: 'af-t' }, 'valley 1'),
      s('text', { x: TOP_X, y: 26, 'text-anchor': 'middle', class: 'af-t af-m' }, 'the top'),
      s('circle', { cx: ballX + wobble, cy: ballY, r: R, class: 'af-ballc' }));
    read.textContent = label;
  };

  const settle = (roll: Roll, how: string, my: number) => {
    const done = () => { ballX = VALLEY_X[roll.valley ? 1 : 0]; wobble = 0; label = `${how} It took ${roll.delays} gate ${roll.delays === 1 ? 'delay' : 'delays'} and ended in valley ${roll.valley}.`; paint(); };
    if (reducedMotion() || roll.delays <= 1) { done(); return; }
    const ticks = Math.min(roll.delays - 1, MAX_TICKS);
    for (let i = 0; i < ticks; i++) setTimeout(() => {
      if (my !== token || !host.isConnected) return;
      ballX = TOP_X; wobble = i % 2 ? 4 : -4;
      label = `Still on the top after ${i + 1} gate ${i ? 'delays' : 'delay'}: both say ${i % 2 ? '"no"' : '"yes"'}, then both flip.${roll.delays - 1 > MAX_TICKS && i === ticks - 1 ? ' (A long wait: the rest is skipped.)' : ''}`;
      paint();
    }, i * TICK_MS);
    setTimeout(() => { if (my === token && host.isConnected) done(); }, ticks * TICK_MS);
  };

  const both = button('Release both', () => {
    const my = ++token;
    ballX = TOP_X; wobble = 0;
    settle(rollBoth(mulberry32(7 + (batch += 1) * 977)), 'Both inputs let go at once: no push either way.', my);
    paint();
  });
  const one = button('Release one', () => {
    const my = ++token;
    ballX = TOP_X; wobble = 0;
    const held = batch++ % 2 ? 'r' : 's';
    settle(rollOne(held), `Only ${held === 's' ? 'Reset' : 'Set'} let go; ${held === 's' ? 'Set' : 'Reset'} is still shouting, so the ball is pushed off the top.`, my);
  });
  const run = button(`Run ${RUN}`, () => {
    token++;
    const rng = mulberry32(2000 + ++batch);
    const rolls = Array.from({ length: RUN }, () => rollBoth(rng));
    hist = { counts: histogram(rolls, BINS), ones: rolls.filter((r) => r.valley).length };
    ballX = TOP_X; wobble = 0;
    label = `${RUN} releases of both: ${hist.ones} ended in valley 1 and ${RUN - hist.ones} in valley 0. Dashed: the counts expected if each gate delay broke the tie with chance ${TIE_BREAK_P}.`;
    paint(); paintHist();
  });

  const paintHist = () => {
    if (!hist) return;
    histSvg.style.display = '';
    const exp = expectedHistogram(RUN, BINS), top = Math.max(...hist.counts, ...exp, 1);
    const x0 = 40, bw = 36, base = 86, hh = 62;
    const kids: SVGElement[] = [];
    hist.counts.forEach((c, i) => {
      const x = x0 + i * bw, bh = (c / top) * hh, eh = (exp[i] / top) * hh;
      kids.push(
        s('rect', { x: x + 4, y: base - bh, width: bw - 8, height: bh, class: 'af-bar' }),
        s('rect', { x: x + 4, y: base - eh, width: bw - 8, height: eh, class: 'af-bar exp' }),
        s('text', { x: x + bw / 2, y: base - Math.max(bh, eh) - 4, 'text-anchor': 'middle', class: 'af-t af-m' }, String(c)),
        s('text', { x: x + bw / 2, y: base + 18, 'text-anchor': 'middle', class: 'af-t' }, i === BINS - 1 ? `${BINS}+` : String(i + 1)));
    });
    kids.push(s('text', { x: x0 + (BINS * bw) / 2, y: 124, 'text-anchor': 'middle', class: 'af-t af-m' }, 'gate delays on the top (of 100 releases)'));
    histSvg.replaceChildren(...kids);
  };

  host.replaceChildren(svg, h('div', { class: 'af-ctl' }, both, one, run), read, histSvg,
    h('p', { class: 'af-note' }, `The simulator only says the latch resolves (it flags the release as a race). That the chance halves each delay is our assumption: ${TIE_BREAK_P} per gate delay, not a measurement.`));
  paint();
}
