// The design brief's results (tier 4, ui/pages/capstone.ts): the cost / speed chart and the submissions table.
// The references are rings on a dashed front, the learner's measured designs dots (the latest solid). Axes are to scale
// from 0; every number comes from campaign/brief.ts (references: briefrefs.json) or the learner's own measurements.

import { groupDigits } from '../../sim/numfmt';
import { briefFront, briefRefs, type BriefRefPoint, type BriefStars, timeOf } from '../../campaign/brief';
import type { Submission } from '../../campaign/progress';
import { h, s } from '../dom';

const W = 640, H = 300, X0 = 64, X1 = 620, Y0 = 250, Y1 = 20;

/** A round axis maximum at or above v with about four steps: 1, 2, 2.5 or 5 × 10^k. */
export function niceAxis(v: number): { max: number; step: number } {
  const raw = v / 4, p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((x) => x >= raw)!;
  return { max: step * Math.ceil(v / step), step };
}

export const fmtN = (n: number): string => (n >= 1e6 ? `${+(n / 1e6).toFixed(2)}M` : n >= 1000 ? `${+(n / 1000).toFixed(1)}k` : String(n));

export const starText = (n: BriefStars): string => '★'.repeat(n);
export const GRADE_WORD: Record<BriefStars, string> = { 1: 'runs the workload', 2: 'on the front', 3: 'beats a reference on both' };

/** Why a reference is off the front: the one that is at least as cheap and as fast. */
export function dominatedNote(refs: BriefRefPoint[]): string[] {
  return refs.flatMap((r) => {
    const q = refs.find((o) => o !== r && o.nand <= r.nand && o.time <= r.time && (o.nand < r.nand || o.time < r.time));
    return q ? [`The ${r.name} core is off the front: the ${q.name} one is ${q.nand < r.nand ? 'cheaper' : 'as cheap'} and ${q.time < r.time ? 'faster' : 'as fast'}.`] : [];
  });
}

export function briefChart(subs: Submission[]): SVGSVGElement {
  const refs = briefRefs();
  const dots = [...refs.map((r) => ({ nand: r.nand, time: r.time })), ...subs.map((q) => ({ nand: q.nand, time: timeOf(q) }))];
  const ax = niceAxis(Math.max(...dots.map((d) => d.time)) * 1.08), ay = niceAxis(Math.max(...dots.map((d) => d.nand)) * 1.08);
  const px = (t: number) => X0 + (t / ax.max) * (X1 - X0), py = (n: number) => Y0 - (n / ay.max) * (Y0 - Y1);
  const front = briefFront(refs);
  const el = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'bf-chart', role: 'img', 'aria-label': `Cost in NANDs against total time: ${refs.length} reference cores, ${front.length} on the front, and ${subs.length} of your designs. The table below lists every number.` });
  for (let t = 0; t <= ax.max + 1e-9; t += ax.step) el.append(s('line', { class: 'gl', x1: px(t), y1: Y0, x2: px(t), y2: Y1 }), s('text', { class: 'tk', x: px(t), y: Y0 + 14, 'text-anchor': 'middle' }, fmtN(t)));
  for (let n = 0; n <= ay.max + 1e-9; n += ay.step) el.append(s('line', { class: 'gl', x1: X0, y1: py(n), x2: X1, y2: py(n) }), s('text', { class: 'tk', x: X0 - 8, y: py(n) + 4, 'text-anchor': 'end' }, fmtN(n)));
  el.append(
    s('line', { class: 'ax', x1: X0, y1: Y0, x2: X1, y2: Y0 }), s('line', { class: 'ax', x1: X0, y1: Y1, x2: X0, y2: Y0 }),
    s('text', { class: 'lb', x: (X0 + X1) / 2, y: H - 6, 'text-anchor': 'middle' }, 'total time, gate delays (cycles × period over the workload)'),
    s('text', { class: 'lb', x: 14, y: (Y0 + Y1) / 2, transform: `rotate(-90 14 ${(Y0 + Y1) / 2})`, 'text-anchor': 'middle' }, 'NANDs'),
    s('polyline', { class: 'front', points: front.map((r) => `${px(r.time)},${py(r.nand)}`).join(' ') }),
  );
  for (const r of refs) {
    const x = px(r.time), y = py(r.nand), left = x > X1 - 120;
    el.append(s('circle', { class: 'ref', cx: x, cy: y, r: 7 }, s('title', null, `${r.name} (reference): ${groupDigits(r.nand)} NANDs, ${groupDigits(r.time)} gate delays`)),
      s('text', { class: 'lb', x: left ? x - 12 : x + 12, y: y - 8, 'text-anchor': left ? 'end' : 'start' }, `${r.name} (ref)`));
  }
  subs.forEach((q, i) => {
    const x = px(timeOf(q)), y = py(q.nand);
    el.append(s('circle', { class: i === 0 ? 'mine' : 'mine-old', cx: x, cy: y, r: i === 0 ? 8 : 6 },
      s('title', null, `yours${i === 0 ? ', latest' : ` #${subs.length - i}`}: ${groupDigits(q.nand)} NANDs, ${groupDigits(timeOf(q))} gate delays, ${starText(q.stars)}`)));
    if (i === 0) {
      // left of the dot and above it: the references' labels run to the right of their rings
      el.append(s('text', { class: 'lb mine-lb', x: x - 13, y: y - 9, 'text-anchor': 'end' }, 'yours, latest'));
    }
  });
  return el;
}

/** The whole results view: grade line, chart, table. */
export function briefResults(subs: Submission[]): HTMLElement {
  const refs = briefRefs();
  const latest = subs[0];
  const n = subs.length;
  const num = groupDigits;
  const rows = [
    ...subs.map((q, i) => h('tr', { class: i === 0 ? 'me' : '' }, h('td', null, i === 0 ? `yours, latest (#${n})` : `yours, #${n - i}`), h('td', { class: 'n' }, num(q.nand)), h('td', { class: 'n' }, num(q.period)),
      h('td', { class: 'n' }, num(q.cycles)), h('td', { class: 'n' }, num(timeOf(q))), h('td', { class: 'stars', 'aria-label': `${q.stars} of 3 stars` }, starText(q.stars)))),
    ...refs.map((r) => h('tr', null, h('td', null, `reference: ${r.name}`), h('td', { class: 'n' }, num(r.nand)), h('td', { class: 'n' }, num(r.period)), h('td', { class: 'n' }, num(r.cycles)), h('td', { class: 'n' }, num(r.time)), h('td'))),
  ];
  return h('div', { class: 'bf-results' },
    h('div', { class: 'bf-card' },
      h('div', { class: 'bf-head' }, h('h4', null, 'Your designs against the references'),
        latest ? h('span', { class: 'lv-badge good' }, `${starText(latest.stars)} ${GRADE_WORD[latest.stars]}`) : h('span', { class: 'lv-badge' }, 'nothing measured yet')),
      h('div', { class: 'bf-svgwrap' }, briefChart(subs)),
      ...dominatedNote(refs).map((t) => h('p', { class: 'bf-note' }, t))),
    h('div', { class: 'bf-card' },
      h('h4', null, 'Submissions'),
      n ? null : h('p', { class: 'bf-note' }, 'Build a core on the Design view and press Measure: each pass is kept here (the last 10), so you can explore the trade-off instead of aiming at one target.'),
      h('div', { class: 'cap-tw' }, h('table', { class: 'bf-tbl' },
        h('thead', null, h('tr', null, ['design', 'NANDs', 'period', 'cycles', 'time', 'grade'].map((t) => h('th', null, t)))), h('tbody', null, rows))),
      h('p', { class: 'bf-note' }, 'A submission is what was measured, not the chip: change your core and Measure again for a new point. Time = period × cycles.')),
  );
}
