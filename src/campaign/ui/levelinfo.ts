// A level's task as the campaign page and the level screen both show it: the success criteria
// (what Check runs, in words) and the grading table (par against the learner's best).

import { h } from '../../ui/dom';
import type { BuildChallenge } from '../../editor/challenges';
import { METRIC } from '../grade';
import { progress } from '../progress';
import type { CampaignNode, Metric } from '../types';

/** What a challenge's test set is, in words (the level's success criteria). */
export function criteria(ch: BuildChallenge): string[] {
  const ins = ch.ports.filter((p) => p.dir === 'in' && !p.clock), outs = ch.ports.filter((p) => p.dir === 'out');
  const pin = (p: { name: string; width: number }) => (p.width > 1 ? `${p.name}[${p.width - 1}:0]` : p.name);
  const out = [`Pins: ${ins.map(pin).join(', ') || '—'}${ch.ports.some((p) => p.clock) ? ', clk' : ''} → ${outs.map(pin).join(', ')}.`];
  if (ch.check.kind === 'table') {
    const bits = ins.reduce((a, p) => a + p.width, 0);
    const chosen = bits <= 16 ? 0 : ch.check.vectors?.().length ?? 0;
    out.push(bits <= 16
      ? `Every input combination: all ${2 ** bits} rows of the truth table must match.`
      : `${chosen ? `${chosen} chosen edge cases, then ` : ''}4096 random input vectors (${bits} input bits) must match.`);
    if (ch.check.care) out.push('Rows the brief leaves open are not checked (don\'t-cares).');
    out.push('An output that is X (undriven, or a short) or Z counts as wrong; the circuit must settle (no oscillation).');
  } else if (ch.check.kind === 'sequence') {
    out.push(`A clocked sequence of ${ch.check.steps.length} steps from power-on: inputs change, the clock ticks, every expected output must match.`);
  } else {
    out.push(ch.check.describe);
  }
  out.push(typeof ch.allowed === 'string'
    ? ch.allowed === 'transistors' ? 'Built from transistors, rails and wiring (and your own chips made of them).' : 'Built from NAND gates (and your chips made of them).'
    : ch.allowed.strict ? `Built only from ${ch.allowed.label ?? 'the parts listed below'} (and your own chips made of them): no MOSFET, no NAND.`
    : 'Built from NAND, wiring, constants, your own chips, and the parts unlocked below.');
  return out;
}

/** Par against the learner's best, per graded metric, and how stars are earned. */
export function gradeTable(n: CampaignNode): HTMLElement {
  const np = progress().get(n.id);
  const par = n.par ?? {};
  const keys = Object.keys(par) as Metric[];
  // A percentage (idle lanes) carries its unit; counts read fine bare, the label names them.
  const fmt = (k: Metric, v: number) => (METRIC[k].unit === '%' ? `${v} %` : String(v));
  return h('div', { class: 'cp-grade' }, h('h4', null, 'Grading'),
    keys.length
      ? h('table', null, h('tr', null, h('th', null, 'Metric'), h('th', null, 'Par'), h('th', null, 'Your best')),
        keys.map((k) => h('tr', { title: METRIC[k].hint }, h('td', null, METRIC[k].label), h('td', null, fmt(k, par[k]!)),
          h('td', { class: np?.best?.[k] !== undefined ? (np.best[k]! <= par[k]! ? 'par' : 'over') : '' }, np?.best?.[k] !== undefined ? fmt(k, np.best[k]!) : '—'))))
      : h('p', { class: 'sub' }, 'Passing earns all three stars: nothing to optimise here.'),
    keys.length ? h('p', { class: 'sub' }, '★ passes · ★★ every metric within 1.5 × par · ★★★ every metric at or under par.') : null);
}
