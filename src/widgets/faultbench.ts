// The expert's bench: a broken network's evidence, drawn from comm/faults.ts, and a choice of causes. A chapter step lists a few cases and
// explains each answer at once; capstone 4 shows the same view and says nothing until the attempt ends (`quiet`).

import { FAULT_CASES, type Evidence, type FaultCase } from '../comm/faults';
import { gaussian, rng } from '../phys/line';
import { h, s } from '../ui/dom';
import { shuffleOrder } from '../ui/quiz';
import type { Widget } from '../view/stage';
import { hline, line, plotOf } from './line';
import '../styles/line.css';
import '../styles/fourier.css';
import '../styles/signals.css';

/** A round upper end for an axis: 1, 2 or 5 times a power of ten, at or above v. */
function niceTop(v: number): number {
  const p = 10 ** Math.floor(Math.log10(Math.max(v, 1e-9)));
  for (const m of [1, 2, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}
const axis = (v: number): string => (Math.abs(v) >= 1e6 ? `${+(v / 1e6).toPrecision(3)} M` : Math.abs(v) >= 1e3 ? `${+(v / 1e3).toPrecision(3)} k` : `${+v.toPrecision(3)}`);

function drawEvidence(e: Evidence): HTMLElement {
  const box = h('div', { class: 'fb-ev' }, h('h3', null, e.title));
  if (e.kind === 'lines') box.append(h('pre', { class: 'fb-lines', tabindex: 0 }, e.lines.join('\n')));
  else if (e.kind === 'counters') box.append(h('div', { class: 'fb-rows' }, ...e.rows.map(([k, v]) => h('div', null, h('span', null, k), h('b', null, v)))));
  else if (e.kind === 'series') {
    const xMax = niceTop(Math.max(1, ...e.lines.flatMap((l) => l.xs))), yMax = niceTop(Math.max(1, ...e.lines.flatMap((l) => l.ys)));
    const p = plotOf({ W: 640, H: 170, x: [0, xMax], y: [0, yMax * 1.05], yTicks: [0, yMax / 2, yMax], xLabel: e.xLabel, yLabel: e.yLabel, aria: e.title, xFmt: axis, yFmt: axis });
    for (const l of e.lines) line(p, l.xs, l.ys, 'ln-s real');
    box.append(p.el);
  } else {
    const p = plotOf({ W: 640, H: 230, x: [0, 2], y: [-1.4, 1.4], yTicks: [-1, 0, 1], xLabel: 'bit periods', yLabel: 'of the swing', aria: `${e.title}: many bits drawn on top of one another` });
    const u = rng(77), g = p.layer.appendChild(s('g', { class: 'ln-eye' })), S = e.spu;
    for (let i = 24; i + 3 < e.wave.length / S && i < 190; i++) {
      let d = '';
      for (let j = 0; j <= 2 * S; j += 2) d += `${j ? 'L' : 'M'}${p.X(j / S).toFixed(1)},${p.Y(Math.max(-1.4, Math.min(1.4, e.wave[i * S + j] + e.sigma * gaussian(u)))).toFixed(1)}`;
      g.append(s('path', { d, class: 'ln-s eyeline' }));
    }
    hline(p, 0, 'threshold');
    box.append(p.el);
  }
  return box;
}

export interface CaseOpts {
  /** The attempt's capstone view: a pick is kept and can be changed, with nothing said about it. */
  quiet?: boolean;
  picked?: number | null;
  onPick?: (rightAnswer: boolean, index: number) => void;
}

/** One case: the symptom, the evidence, the causes in a fixed shuffle. */
export function caseView(c: FaultCase, salt: string, o: CaseOpts = {}): HTMLElement {
  const order = shuffleOrder(c.options.length, `${c.id}:${salt}`), said = h('div', { class: 'fb-said', 'aria-live': 'polite' });
  const buttons = order.map((k) => {
    const b = h('button', { type: 'button', class: `btn sm fb-opt${o.picked === k ? ' on' : ''}`, onclick: () => pick(k, b) }, c.options[k]);
    return b;
  });
  function pick(k: number, b: HTMLElement) {
    for (const x of buttons) x.classList.remove('on', 'right', 'wrong');
    if (o.quiet) b.classList.add('on');
    else {
      b.classList.add(k === 0 ? 'right' : 'wrong');
      said.textContent = k === 0 ? c.why : `${c.against[k - 1]} Look again.`;
    }
    o.onPick?.(k === 0, k);
  }
  return h('div', { class: 'fb-case' },
    h('p', { class: 'fb-symptom' }, c.symptom),
    ...c.evidence.map(drawEvidence),
    h('h3', null, 'What is the cause?'),
    h('div', { class: 'fb-opts', role: 'group', 'aria-label': 'Possible causes' }, ...buttons), said);
}

/** A chapter step's bench: a tab per case, and a new run of the same fault with other numbers. */
export function benchWidget(ids: readonly string[], names: readonly string[]): () => Widget {
  return () => {
    let at = 0, seed = 1;
    const tabs = ids.map((_, i) => h('button', { type: 'button', class: 'btn sm', 'aria-pressed': 'false', onclick: () => { at = i; paint(); } }, names[i]));
    const body = h('div');
    function paint() {
      tabs.forEach((t, i) => { t.classList.toggle('on', i === at); t.setAttribute('aria-pressed', i === at ? 'true' : 'false'); });
      const c = FAULT_CASES.find((x) => x.id === ids[at])!.build(seed);
      body.replaceChildren(caseView(c, String(seed)));
    }
    paint();
    return {
      el: h('div', { class: 'widget mos sr-w' }, h('div', { class: 'panel' },
        h('div', { class: 'fb-tabs', role: 'group', 'aria-label': 'Which case' }, ...(tabs.length > 1 ? tabs : []),
          h('button', { type: 'button', class: 'btn sm', onclick: () => { seed++; paint(); } }, 'Same fault, other numbers')), body)),
    };
  };
}
