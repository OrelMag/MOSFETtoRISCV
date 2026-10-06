// Measured performance: clock period from static timing × CPI from running the gate-level
// processors. Computed incrementally so the page stays responsive.

import { pipelinedCpu, singleCycleCpu } from '../lib';
import { assemble } from '../riscv/asm';
import { clockCycle, retiring } from '../riscv/cosim';
import { ISS } from '../riscv/iss';
import { PROGRAMS } from '../riscv/programs';
import { flatten } from '../sim/flatten';
import { GateSim } from '../sim/gatesim';
import { analyzeTiming } from '../sim/timing';
import { h } from '../ui/dom';
import type { Widget } from '../view/stage';

export interface PerfConfig {
  name: string;
  pipeline: boolean;
  adder: 'rca' | 'ks';
  balanced?: boolean;
  predictor?: boolean;
}

const cpiCache = new Map<string, number>();
const periodCache = new Map<string, number>();

function measureCpi(cfg: PerfConfig, programId: string): number {
  if (!cfg.pipeline) return 1;
  const key = `${programId}_${!!cfg.predictor}`; // CPI does not depend on adders or balancing
  const hit = cpiCache.get(key);
  if (hit) return hit;
  const words = assemble(PROGRAMS.find((p) => p.id === programId)!.source).words;
  const sim = new GateSim(flatten(pipelinedCpu(words, { adder: 'ks', balanced: true, predictor: cfg.predictor })));
  sim.setInput('clk', 0);
  sim.settle();
  const iss = new ISS(words);
  let cycles = 0;
  while (!iss.halted && cycles < 3000) {
    const r = retiring(sim);
    clockCycle(sim);
    cycles++;
    if (r) iss.step();
  }
  const cpi = cycles / iss.steps;
  cpiCache.set(key, cpi);
  return cpi;
}

function measurePeriod(cfg: PerfConfig): number {
  const key = JSON.stringify(cfg);
  const hit = periodCache.get(key);
  if (hit) return hit;
  const words = assemble(PROGRAMS[0].source).words;
  const def = cfg.pipeline ? pipelinedCpu(words, { adder: cfg.adder, balanced: cfg.balanced, predictor: cfg.predictor }) : singleCycleCpu(words, { adder: cfg.adder });
  const p = analyzeTiming(flatten(def))!.period;
  periodCache.set(key, p);
  return p;
}

export function perfTable(title: string, configs: PerfConfig[], programs: string[], note: string): Widget {
  const body = h('tbody');
  const status = h('p', { class: 'sub' }, 'Measuring…');
  const rows = configs.map((c) => {
    const cells = { period: h('td', { class: 'num' }, '…'), cpi: h('td', { class: 'num' }, '…'), t: h('td', { class: 'num' }, '…'), bar: h('td', { class: 'barcell' }) };
    body.append(h('tr', null, h('td', null, c.name), cells.period, cells.cpi, cells.t, cells.bar));
    return { c, cells, t: 0 };
  });
  const el = h('div', { class: 'widget' }, h('div', { class: 'panel' },
    h('h3', null, title),
    h('table', { class: 'cmp' },
      h('thead', null, h('tr', null, h('th', null, 'processor'), h('th', null, 'period'), h('th', null, `CPI (${programs.join(', ')})`), h('th', null, 'time / instr'), h('th', null, 'speed'))),
      body),
    status,
    h('p', { class: 'sub', style: 'margin-top:8px' }, note)));
  let i = 0, cancelled = false;
  const step = () => {
    if (cancelled) return;
    if (i >= rows.length) {
      const best = Math.min(...rows.map((r) => r.t));
      for (const r of rows) r.cells.bar.replaceChildren(h('span', { class: 'cbar k', style: `width:${(best / r.t) * 100}%` }));
      status.textContent = 'Periods in NAND delays (static timing). CPI averaged over the programs, measured on the gate-level pipeline. Speed bars: longer is faster.';
      return;
    }
    const r = rows[i++];
    const period = measurePeriod(r.c);
    const cpi = programs.map((p) => measureCpi(r.c, p)).reduce((a, b) => a + b, 0) / programs.length;
    r.t = period * cpi;
    r.cells.period.textContent = String(period);
    r.cells.cpi.textContent = cpi.toFixed(2);
    r.cells.t.textContent = r.t.toFixed(0);
    status.textContent = `Measuring… ${i} / ${rows.length}`;
    setTimeout(step, 20);
  };
  setTimeout(step, 50);
  return { el, destroy: () => { cancelled = true; } };
}
