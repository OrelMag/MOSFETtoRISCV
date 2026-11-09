// Chapter 8: where does the clock edge catch d? Every cell is one run of the real flip-flop on GateSim: d flips t gate
// delays before (t < 0) or after the rising edge and q settles to the old value, the new one, or never decides. The
// strip's boundaries are the setup and hold times of the circuit; a click shows that run as a waveform.

import { DFF_EDGE6 } from '../lib/seqdeep';
import { DFF } from '../lib/sequential';
import { qTrace, sweepEdge, type Capture, type EdgeSweep } from '../sim/edgetiming';
import { CLK_TO_Q, SETUP } from '../sim/timing';
import type { ComponentDef } from '../sim/types';
import { h, s } from '../ui/dom';
import '../styles/edgesweep.css';
import type { Widget } from '../view/stage';

const LO = -8, HI = 8;
const PARTS: { id: string; label: string; def: ComponentDef }[] = [
  { id: 'ms', label: 'Master–slave (chapter 8)', def: DFF },
  { id: 'e6', label: 'Six-gate (7474)', def: DFF_EDGE6 },
];
const sweeps = new Map<string, EdgeSweep>();
export const sweepOf = (id: string, dir: 'rise' | 'fall'): EdgeSweep => {
  const k = `${id}/${dir}`;
  let r = sweeps.get(k);
  if (!r) sweeps.set(k, (r = sweepEdge(PARTS.find((p) => p.id === id)!.def, dir, LO, HI)));
  return r;
};

const LETTER: Record<Capture, string> = { new: 'N', old: 'O', x: '?' };
const signed = (t: number) => (t > 0 ? `+${t}` : t < 0 ? `−${-t}` : '0');

export function edgeSweepWidget(): Widget {
  let part = 'ms', dir: 'rise' | 'fall' = 'rise', sel = -2;
  const strip = h('div', { class: 'es-strip', role: 'group', 'aria-label': 'when d changes, in gate delays from the rising clock edge' });
  const wave = s('svg', { class: 'es-wave', viewBox: '0 0 640 150', role: 'img' });
  const read = h('div', { class: 'es-read' });
  const say = h('p', { class: 'sub', role: 'status', 'aria-live': 'polite' });
  const bar = h('div', { class: 'es-bar' });

  const seg = (items: [string, string][], get: () => string, set: (v: string) => void, label: string) => {
    const el = h('div', { class: 'seg', role: 'group', 'aria-label': label });
    const bs = items.map(([, t]) => h('button', { type: 'button', 'aria-pressed': 'false' }, t));
    items.forEach(([v], i) => bs[i].addEventListener('click', () => { set(v); paint(); }));
    el.append(...bs);
    return { el, sync: () => items.forEach(([v], i) => bs[i].setAttribute('aria-pressed', String(get() === v))) };
  };
  const partSeg = seg(PARTS.map((p) => [p.id, p.label]), () => part, (v) => (part = v), 'flip-flop');
  const dirSeg = seg([['rise', 'd rises 0 → 1'], ['fall', 'd falls 1 → 0']], () => dir, (v) => (dir = v as 'rise' | 'fall'), 'direction of the change in d');
  bar.append(partSeg.el, dirSeg.el);

  const X = (t: number) => 20 + ((t + 8) * 600) / 24; // −8 … +16 delays
  const lane = (y: number, hi: number, lo: number) => (v: number) => (v ? y - hi : y - lo);
  function drawWave(sw: EdgeSweep, t: number) {
    const def = PARTS.find((p) => p.id === part)!.def;
    const from = dir === 'rise' ? 0 : 1, to = (1 - from) as 0 | 1;
    const tr = qTrace(def, from, to, t, 16);
    const clkY = lane(40, 28, 0), dY = lane(90, 28, 0), qY = lane(140, 28, 0);
    const poly = (start: number, ev: [number, number][], y: (v: number) => number, x0: number) => {
      let d = `M${X(x0)} ${y(start)}`;
      for (const [tt, v] of ev) { d += ` H${X(tt)} V${y(v)}`; }
      return d + ` H${X(16)}`;
    };
    wave.replaceChildren(
      s('line', { class: 'ed', x1: X(0), x2: X(0), y1: 4, y2: 146 }),
      s('text', { x: X(0) + 4, y: 10 }, 'rising edge'),
      s('text', { x: 2, y: 22 }, 'clk'), s('path', { class: 'ln', d: poly(0, [[0, 1]], clkY, -8) }),
      s('text', { x: 2, y: 72 }, 'd'), s('path', { class: 'dl', d: poly(from, [[t, to]], dY, -8) }),
      s('text', { x: 2, y: 122 }, 'q'), s('path', { class: 'ql', d: poly(tr.start, tr.changes.filter(([tt]) => tt >= -8), qY, -8) }),
      ...[-8, -4, 0, 4, 8, 12, 16].map((tt) => s('text', { x: X(tt) - 6, y: 149 }, signed(tt))),
    );
    wave.setAttribute('aria-label', `d changes ${Math.abs(t)} delays ${t < 0 ? 'before' : t > 0 ? 'after' : 'at'} the edge; q ends as ${LETTER[sw.outcome[sw.offsets.indexOf(t)]] === 'N' ? 'the new value' : LETTER[sw.outcome[sw.offsets.indexOf(t)]] === 'O' ? 'the old value' : 'undecided'}`);
  }
  function paint() {
    partSeg.sync(); dirSeg.sync();
    const sw = sweepOf(part, dir);
    strip.replaceChildren(...sw.offsets.map((t, i) => {
      const o = sw.outcome[i];
      const b = h('button', { type: 'button', class: `es-cell ${o}`, 'aria-pressed': String(t === sel), 'aria-label': `d changes at ${signed(t)}: ${o === 'new' ? 'new value captured' : o === 'old' ? 'old value kept' : 'undecided'}` }, LETTER[o], h('small', null, signed(t)));
      b.addEventListener('click', () => { sel = t; paint(); });
      return b;
    }));
    drawWave(sw, sel);
    const o = sw.outcome[sw.offsets.indexOf(sel)];
    say.textContent = o === 'new' ? `d changes ${signed(sel)} delays from the edge: q takes the new value.`
      : o === 'old' ? `d changes ${signed(sel)} delays from the edge: the edge already saw the old value, q keeps it.`
        : `d changes ${signed(sel)} delays from the edge: the master's SR pair is released from both sides at once and never decides (the simulator stops it after ${'4000'} delays and picks one).`;
    const aperture = sw.hold + sw.setup;
    read.replaceChildren(
      ...([['setup', `${sw.setup}`, 'delays before the edge'], ['hold', `${sw.hold}`, 'delays after the edge'], ['aperture', `${aperture}`, 'setup + hold: the window d must not move in'],
        ['clock-to-q', `${sw.cqRise} / ${sw.cqFall}`, 'q rising / falling']] as const).map(([k, v, n]) => h('div', null, k, h('b', null, v), n)),
    );
  }
  paint();
  return {
    el: h('div', { class: 'widget' }, h('div', { class: 'panel' },
      h('h3', null, 'Where does the edge catch d?'),
      h('p', { class: 'sub' }, `Each cell is a run of the flip-flop's real netlist: d flips t gate delays from the rising edge, then q is read once everything settles. N: the new d was captured. O: the edge still saw the old d. ?: neither (the cell's master latch never decided). The boundaries are the circuit's setup and hold times; the static timing of the CPU chapters budgets setup ${SETUP} and clock-to-q ${CLK_TO_Q}.`),
      bar, strip,
      h('p', { class: 'es-key' }, h('span', null, h('b', null, 'N'), 'new captured'), h('span', null, h('b', null, 'O'), 'old kept'), h('span', null, h('b', null, '?'), 'undecided (metastable)')),
      say, wave, read)),
  };
}
