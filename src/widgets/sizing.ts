// Chapter 2's "Driving a big load": a chain of inverters, each ρ bigger than the last, from phys/sizing.ts.

import { h } from '../ui/dom';
import { bestStages, chainDelay, FO4_TAU, PS_PER_TAU } from '../phys/sizing';
import type { Widget } from '../view/stage';
import { slider } from './mosparts';

export function sizingWidget(): Widget {
  let lg = 6; // load = 2^lg inverter inputs
  const table = h('div'), chain = h('div', { class: 'sz-chain' }), note = h('p', { class: 'sub mos-note' });
  const paint = () => {
    const F = 2 ** lg, best = bestStages(F), d = (n: number) => chainDelay(F, n);
    const rows = Array.from({ length: 8 }, (_, i) => i + 1);
    table.replaceChildren(h('table', { class: 'mini' },
      h('tr', null, h('th', null, 'stages N'), ...rows.map((n) => h('td', { class: n === best ? 'sz-best' : '' }, String(n)))),
      h('tr', null, h('th', null, 'ratio ρ = F^(1/N)'), ...rows.map((n) => h('td', { class: n === best ? 'sz-best' : '' }, (F ** (1 / n)).toFixed(1)))),
      h('tr', null, h('th', null, 'delay (τ)'), ...rows.map((n) => h('td', { class: n === best ? 'sz-best' : '' }, d(n).toFixed(1)))),
      h('tr', null, h('th', null, 'delay (ps)'), ...rows.map((n) => h('td', { class: n === best ? 'sz-best' : '' }, (d(n) * PS_PER_TAU).toFixed(0))))));
    const rho = F ** (1 / best);
    chain.replaceChildren(...Array.from({ length: best }, (_, i) => h('span', { class: 'sz-inv', style: `height:${Math.min(64, 10 + 8 * Math.log2(rho ** i * 2))}px`, title: `size ${(rho ** i).toFixed(1)}×` }, `${(rho ** i).toFixed(1)}×`)),
      h('span', { class: 'sz-load' }, `load ${F}×`));
    note.textContent = `Best: N = ${best}, ρ = ${rho.toFixed(1)}, ${d(best).toFixed(1)} τ = ${(d(best) * PS_PER_TAU).toFixed(0)} ps. A single stage takes ${d(1).toFixed(0)} τ. `
      + `Yardstick: one inverter driving four copies of itself (FO4) is ${FO4_TAU} τ = ${FO4_TAU * PS_PER_TAU} ps.`;
  };
  const sl = slider('Load', 1, 16, 1, lg, (v) => `${2 ** v}× input`, (v) => { lg = v; paint(); });
  const el = h('div', { class: 'widget mos' }, h('div', { class: 'panel mos-ctl' }, sl.el, chain, note), h('div', { class: 'panel' }, table));
  paint();
  return { el };
}
