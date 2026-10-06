// Static-timing panel for CPU scenes, and the adder cost/speed comparison.

import { koggeStone, rca, CLA4 } from '../lib';
import { flatten } from '../sim/flatten';
import { logicDepth, stats } from '../sim/stats';
import { analyzeTiming, CLK_TO_Q, PS_PER_NAND, SETUP, type TimingReport } from '../sim/timing';
import { h } from '../ui/dom';
import type { ScenePanel, Stage, Widget } from '../view/stage';

const reports = new WeakMap<object, TimingReport | null>();

export const timingPanel: ScenePanel = (stage: Stage): Widget => {
  const body = h('div');
  const title = h('h4', null, 'Critical path', h('span', { style: 'font-weight:500;color:var(--muted)' }, 'static timing'));
  const el = h('div', { class: 'mem-panel', style: 'left:12px;right:auto;bottom:12px;width:300px' }, title, body);
  title.addEventListener('click', () => el.classList.toggle('collapsed'));
  const design = stage.sim!.design;
  let rep = reports.get(design);
  if (rep === undefined) {
    rep = analyzeTiming(design);
    reports.set(design, rep);
  }
  if (!rep) {
    body.append(h('p', { class: 'sub' }, 'No flip-flops: nothing to time.'));
    return { el };
  }
  const r = rep;
  const ns = (r.period * PS_PER_NAND) / 1000;
  const mhz = 1000 / ns;
  let on = true;
  const btn = h('button', { class: 'btn sm toggle on' }, 'Highlight path');
  const apply = () => {
    btn.classList.toggle('on', on);
    stage.highlight(on ? [...new Set(r.stages.map((s) => s.inst))] : []);
  };
  btn.addEventListener('click', () => { on = !on; apply(); });
  const maxA = r.stages[r.stages.length - 1]?.arrival ?? 1;
  let prev = 0;
  body.append(
    h('div', { class: 'readout', style: 'margin-top:0' },
      h('div', null, h('b', null, String(r.period)), h('span', null, 'NAND delays per cycle')),
      h('div', null, h('b', null, `${mhz.toFixed(0)} MHz`), h('span', null, `at ~${PS_PER_NAND} ps / NAND`))),
    h('p', { class: 'sub', style: 'margin:8px 0 6px;font-size:12.5px' }, `clk→q ${CLK_TO_Q} + logic ${r.logic} + setup ${SETUP}. Launch: ${r.launch.join('.')}, capture: ${r.capture.slice(0, 2).join('.')}…`),
    h('div', { class: 'tstages' }, r.stages.map((s) => {
      const w = Math.max(2, ((s.arrival - prev) / maxA) * 100);
      prev = s.arrival;
      return h('div', { class: 'ts' }, h('span', { class: 'n' }, s.inst), h('span', { class: 'bar', style: `width:${w}%` }), h('span', { class: 'a' }, String(s.arrival)));
    })),
    h('div', { style: 'margin-top:8px' }, btn),
  );
  apply();
  return { el, destroy: () => stage.highlight([]) };
};

export function adderComparison(): Widget {
  const rows: HTMLElement[] = [];
  const widths = [4, 8, 16, 32];
  const data = widths.map((n) => {
    const r = rca(n), k = koggeStone(n);
    return { n, rN: stats(r).nands, rD: logicDepth(r) ?? 0, kN: stats(k).nands, kD: logicDepth(k) ?? 0 };
  });
  const maxD = Math.max(...data.map((d) => d.rD));
  const bar = (v: number, cls: string) => h('span', { class: `cbar ${cls}`, style: `width:${(v / maxD) * 100}%` });
  for (const d of data) {
    rows.push(h('tr', null,
      h('td', null, `${d.n}-bit`),
      h('td', { class: 'num' }, String(d.rN)), h('td', { class: 'num' }, String(d.rD)), h('td', { class: 'barcell' }, bar(d.rD, 'r')),
      h('td', { class: 'num' }, String(d.kN)), h('td', { class: 'num' }, String(d.kD)), h('td', { class: 'barcell' }, bar(d.kD, 'k'))));
  }
  const cla = { nands: stats(CLA4).nands, depth: logicDepth(CLA4) ?? 0 };
  void flatten;
  return {
    el: h('div', { class: 'widget' }, h('div', { class: 'panel' },
      h('h3', null, 'Cost versus speed, measured'),
      h('p', { class: 'sub' }, 'NAND count and worst-case depth (NAND delays, any input to any output), computed from each circuit\'s netlist.'),
      h('table', { class: 'cmp' },
        h('thead', null, h('tr', null, h('th', null, ''), h('th', { colspan: 3 }, 'ripple-carry'), h('th', { colspan: 3 }, 'Kogge–Stone')),
          h('tr', null, h('th', null, 'width'), h('th', null, 'NANDs'), h('th', null, 'depth'), h('th', null, ''), h('th', null, 'NANDs'), h('th', null, 'depth'), h('th', null, ''))),
        h('tbody', null, rows)),
      h('p', { class: 'sub', style: 'margin-top:12px' },
        `4-bit carry-lookahead (2-input NAND trees only): ${cla.nands} NANDs, depth ${cla.depth}: worse than ripple at this width. At 4 bits the prefix adder only ties ripple; the crossover is the point. Ripple grows by 2 delays per bit; Kogge–Stone by one prefix level (2 NANDs) per doubling, but its area grows as n·log n, and its wiring (the long diagonals) is the real cost on silicon. Practical designs mix the two: Brent–Kung, Han–Carlson, sparse trees.`))),
  };
}
