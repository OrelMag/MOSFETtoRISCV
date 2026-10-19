// Measured performance: clock period from static timing × CPI from running the gate-level
// processors, and the energy per instruction (sim/power.ts: toggles counted on the same runs).
// Computed incrementally so the page stays responsive.

import { pipelinedCpu, singleCycleCpu } from '../lib';
import { assemble } from '../riscv/asm';
import { clockCycle, retiring } from '../riscv/cosim';
import { ISS } from '../riscv/iss';
import { PROGRAMS } from '../riscv/programs';
import { flatten } from '../sim/flatten';
import { GateSim } from '../sim/gatesim';
import { energyFj, fmtEnergy, POWER_NOTE, PowerMeter, VDD } from '../sim/power';
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

const energyCache = new Map<string, number>();

/** fF·toggles per retired instruction of cfg running a program, glitches included; yields every 128 cycles. */
function* measureEnergy(cfg: PerfConfig, programId: string): Generator<void, number> {
  const key = `${programId}_${JSON.stringify(cfg)}`;
  const hit = energyCache.get(key);
  if (hit !== undefined) return hit;
  const words = assemble(PROGRAMS.find((p) => p.id === programId)!.source).words;
  const def = cfg.pipeline ? pipelinedCpu(words, { adder: cfg.adder, balanced: cfg.balanced, predictor: cfg.predictor }) : singleCycleCpu(words, { adder: cfg.adder });
  const sim = new GateSim(flatten(def));
  sim.setInput('clk', 0);
  sim.settle();
  const m = new PowerMeter(sim);
  const iss = new ISS(words);
  let cycles = 0;
  while (!iss.halted && cycles < 3000) {
    const r = retiring(sim);
    clockCycle(sim);
    cycles++;
    if (r) iss.step();
    if ((cycles & 127) === 0) yield;
  }
  const e = m.totals().switched / iss.steps;
  energyCache.set(key, e);
  return e;
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
    const cells = { period: h('td', { class: 'num' }, '…'), cpi: h('td', { class: 'num' }, '…'), t: h('td', { class: 'num' }, '…'), e: h('td', { class: 'num', title: POWER_NOTE }, '…'), bar: h('td', { class: 'barcell' }) };
    body.append(h('tr', null, h('td', null, c.name), cells.period, cells.cpi, cells.t, cells.e, cells.bar));
    return { c, cells, t: 0 };
  });
  const el = h('div', { class: 'widget' }, h('div', { class: 'panel' },
    h('h3', null, title),
    h('table', { class: 'cmp' },
      h('thead', null, h('tr', null, h('th', null, 'processor'), h('th', null, 'period'), h('th', null, `CPI (${programs.join(', ')})`), h('th', { title: `Average, then per program (${programs.join(' · ')})` }, 'time / instr'), h('th', { title: POWER_NOTE }, `energy / instr (${VDD} V)`), h('th', null, 'speed'))),
      body),
    status,
    h('p', { class: 'sub', style: 'margin-top:8px' }, note)));
  let i = 0, cancelled = false;
  // after the times: the energies, one program run at a time in slices
  let ei = 0, run: Generator<void, number> | null = null, sum = 0, pi = 0;
  const energyStep = () => {
    if (cancelled) return;
    if (ei >= rows.length) {
      status.textContent = `Periods in NAND delays (static timing). CPI averaged over the programs, measured on the gate-level pipeline; under each time / instr, the time per program (${programs.join(' · ')}); energy per instruction on the same programs, every net’s toggles counted (an estimate: hover the column). Speed bars: longer is faster.`;
      return;
    }
    const r = rows[ei];
    run ??= measureEnergy(r.c, programs[pi]);
    const t0 = performance.now();
    let res = run.next();
    while (!res.done && performance.now() - t0 < 30) res = run.next();
    if (res.done) {
      sum += res.value;
      run = null;
      if (++pi === programs.length) {
        r.cells.e.textContent = fmtEnergy(energyFj(sum / programs.length));
        ei++;
        sum = pi = 0;
      }
    }
    status.textContent = `Measuring energy… ${ei} / ${rows.length}`;
    setTimeout(energyStep, 0);
  };
  const step = () => {
    if (cancelled) return;
    if (i >= rows.length) {
      const best = Math.min(...rows.map((r) => r.t));
      for (const r of rows) r.cells.bar.replaceChildren(h('span', { class: 'cbar k', style: `width:${(best / r.t) * 100}%` }));
      setTimeout(energyStep, 20);
      return;
    }
    const r = rows[i++];
    const period = measurePeriod(r.c);
    const cpis = programs.map((p) => measureCpi(r.c, p));
    const cpi = cpis.reduce((a, b) => a + b, 0) / programs.length;
    r.t = period * cpi;
    r.cells.period.textContent = String(period);
    r.cells.cpi.textContent = cpi.toFixed(2);
    // the average hides which programs win: each program's time below it
    r.cells.t.replaceChildren(r.t.toFixed(0), h('div', { class: 'sub', style: 'font-size:11px;white-space:nowrap', title: programs.join(' · ') }, cpis.map((c) => (period * c).toFixed(0)).join(' · ')));
    status.textContent = `Measuring… ${i} / ${rows.length}`;
    setTimeout(step, 20);
  };
  setTimeout(step, 50);
  return { el, destroy: () => { cancelled = true; } };
}
