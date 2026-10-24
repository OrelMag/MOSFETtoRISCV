// Static-timing panel for CPU scenes, and the adder cost/speed comparison.

import { brentKung, busMux2, CLA4, koggeStone, ram, rca, register, sklansky } from '../lib';
import { flatten } from '../sim/flatten';
import { logicDepth, stats } from '../sim/stats';
import { analyzeTiming, CLK_TO_Q, PS_NOTE, PS_PER_NAND, SETUP, type TimingReport } from '../sim/timing';
import { DELAY_NOTE, type DelayModel, delayWord, fanoutOf, fmtDelay, nandDelay, netLoads, psPer } from '../sim/delay';
import { type ComponentDef, netlistOf } from '../sim/types';
import { h } from '../ui/dom';
import { defaultDelay, delaySwitch, heavyList } from '../view/delayui';
import type { ScenePanel, Stage, Widget } from '../view/stage';

const reports = { unit: new WeakMap<object, TimingReport | null>(), load: new WeakMap<object, TimingReport | null>(), drawn: new WeakMap<object, TimingReport | null>() };

export const timingPanel: ScenePanel = (stage: Stage): Widget => {
  const body = h('div');
  let model = defaultDelay();
  const sw = h('span');
  const title = h('h4', null, h('span', null, 'Critical path ', h('span', { style: 'font-weight:500;color:var(--muted)' }, 'static timing')), sw);
  const el = h('div', { class: 'mem-panel', 'data-dock': 'left', style: 'width:300px' }, title, body);
  title.addEventListener('click', () => el.classList.toggle('collapsed'));
  const design = stage.sim!.design;
  const reportOf = (m: DelayModel) => {
    let r = reports[m].get(design);
    if (r === undefined) reports[m].set(design, (r = analyzeTiming(design, { delay: m })));
    return r;
  };
  let on = true;
  const btn = h('button', { class: 'btn sm toggle on' }, 'Highlight path');
  const apply = () => {
    btn.classList.toggle('on', on);
    const r = reportOf(model);
    stage.highlight(on && r ? [...new Set(r.stages.map((s) => s.inst))] : []);
  };
  btn.addEventListener('click', () => { on = !on; apply(); });
  const render = () => {
    const r = reportOf(model);
    sw.replaceChildren(delaySwitch(model, (m) => { model = m; render(); apply(); }));
    if (!r) return void body.replaceChildren(h('p', { class: 'sub' }, 'No flip-flops: nothing to time.'));
    const other = reportOf(model === 'load' ? 'unit' : 'load')!;
    const ps = psPer(model, PS_PER_NAND), mhz = 1e6 / (r.period * ps);
    const otherMhz = 1e6 / (other.period * psPer(other.model, PS_PER_NAND));
    const q = r.stages[0]?.arrival ?? CLK_TO_Q;
    const f = (x: number) => fmtDelay(x, model);
    const maxA = r.stages[r.stages.length - 1]?.arrival ?? 1;
    let prev = 0;
    body.replaceChildren(
      h('div', { class: 'readout', style: 'margin-top:0' },
        h('div', null, h('b', null, f(r.period)), h('span', null, `${delayWord(model)} per cycle`)),
        h('div', { title: model === 'load' ? DELAY_NOTE : PS_NOTE }, h('b', null, `${mhz.toFixed(0)} MHz`), h('span', null, model === 'load' ? `at ≈ ${ps.toFixed(1)} ps / unit` : `at an illustrative ${PS_PER_NAND} ps / NAND`))),
      h('p', { class: 'sub', style: 'margin:8px 0 6px;font-size:12.5px' }, `clk→q ${f(r.launch.length ? q : CLK_TO_Q)} + logic ${f(r.logic)} + setup ${SETUP}. Launch: ${r.launch.join('.')}, capture: ${r.capture.slice(0, 2).join('.')}…`),
      h('div', { class: 'tstages' }, r.stages.map((s) => {
        const w = Math.max(2, ((s.arrival - prev) / maxA) * 100);
        prev = s.arrival;
        return h('div', { class: 'ts' }, h('span', { class: 'n' }, s.inst), h('span', { class: 'bar', style: `width:${w}%` }), h('span', { class: 'a' }, f(s.arrival)));
      })),
      ...[heavyList(r)].filter((x): x is HTMLElement => !!x),
      h('p', { class: 'sub', style: 'margin:6px 0 0;font-size:12px' }, model === 'load'
        ? `Unit delay: ${other.period} NAND delays, ${otherMhz.toFixed(0)} MHz.`
        : `Under load: ${fmtDelay(other.period, 'load')} units, ${otherMhz.toFixed(0)} MHz.`),
      h('div', { style: 'margin-top:8px' }, btn),
    );
  };
  render();
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

type Depths = { nands: number; unit: number; load: number; drawn: number; fanout: number };
const rowCache = new Map<number, Depths>(), clockCache = new Map<number, Depths>();

/**
 * A 64-word memory's write path without its read tree: address → row decoder → word line → the word's n
 * flip-flops (their enable muxes to d). The read tree is left out because the address pins also drive its
 * selects, which would bury the decoder's own load under the address lines'.
 */
export function rowDecoderDelays(n: number): Depths {
  const hit = rowCache.get(n);
  if (hit) return hit;
  const R = ram(6, n), nl = netlistOf(R)!;
  const def: ComponentDef = {
    ...R, id: `${R.id}_rows`, ports: R.ports.filter((p) => p.name !== 'dout'),
    netlist: () => ({
      ...nl,
      pins: Object.fromEntries(Object.entries(nl.pins ?? {}).filter(([k]) => k !== 'dout')),
      instances: nl.instances.filter((i) => i.name !== 'rmux'),
      nets: nl.nets.filter((x) => x.name !== 'dout' && !/^q\d+$/.test(x.name ?? ''))
        .map((x) => (x.name === 'addr' ? { ...x, ends: x.ends.filter((e) => e !== 'rmux.s'), via: undefined } : x)),
    }),
  };
  const d = flatten(def, { mode: 'gate' });
  const at = (m: DelayModel) => analyzeTiming(d, { delay: m })!;
  const dec = netlistOf(def)!.instances.find((i) => i.name === 'dec')!.def;
  const r: Depths = { nands: stats(dec).nands, unit: at('unit').logic, load: at('load').logic, drawn: at('drawn').logic, fanout: fanoutOf(netLoads(d)[d.root.children!.get('w0')!.ports.en[0]]) };
  rowCache.set(n, r);
  return r;
}

/** An n-bit register's clock net: the one NAND driving every flip-flop's clock inputs (a clock tree under 'load'). */
export function clockNetDelays(n: number): Depths {
  const hit = clockCache.get(n);
  if (hit) return hit;
  const d = flatten(register(n), { mode: 'gate' });
  const load = netLoads(d)[d.root.ports.clk[0]];
  const r: Depths = { nands: 0, unit: 1, load: nandDelay(load), drawn: nandDelay(load, false), fanout: fanoutOf(load) };
  clockCache.set(n, r);
  return r;
}

/** Chapter 16's last step: the prefix family (and a wide select) under unit delay, under load, and as drawn. */
export function prefixDelays(): Widget {
  const body = h('div');
  const pick = h('div', { class: 'seg', role: 'group', 'aria-label': 'Width' });
  const rowsOf = (n: number): ({ name: string; def: ComponentDef } & Omit<Depths, 'fanout'> & { fanout?: number })[] => [
    { name: 'Ripple carry', def: rca(n) },
    { name: 'Brent–Kung', def: brentKung(n) },
    { name: 'Sklansky', def: sklansky(n) },
    { name: 'Kogge–Stone', def: koggeStone(n) },
    { name: `${n}-bit mux (one select)`, def: busMux2(n) },
  ].map((r) => ({ ...r, nands: stats(r.def).nands, unit: logicDepth(r.def) ?? 0, load: logicDepth(r.def, 'load') ?? 0, drawn: logicDepth(r.def, 'drawn') ?? 0 }))
    .concat([
      { name: `Row decoder, 64 × ${n} memory`, def: ram(6, n), ...rowDecoderDelays(n) },
      { name: `Clock of a ${n}-bit register`, def: register(n), ...clockNetDelays(n) },
    ]);
  const cache = new Map<number, ReturnType<typeof rowsOf>>();
  const show = (n: number) => {
    for (const b of pick.querySelectorAll('button')) b.classList.toggle('on', b.dataset.n === String(n));
    let rows = cache.get(n);
    if (!rows) cache.set(n, (rows = rowsOf(n)));
    // Ripple carry is off this scale (it grows with n): its numbers only. The scale is the prefix adders' and the
    // mux's; the decoder and the clock run past it as drawn.
    const max = Math.max(...rows.slice(1, 5).map((r) => r.drawn));
    const bar = (v: number, cls: string) => h('span', { class: `cbar ${cls}`, style: `width:${Math.min(100, (v / max) * 100)}%` });
    body.replaceChildren(h('table', { class: 'cmp pfx' },
      h('thead', null, h('tr', null, h('th', null, `${n} bits`), h('th', { class: 'num' }, 'NANDs'), h('th', { class: 'num', title: 'Every NAND one delay' }, 'unit'),
        h('th', { class: 'num', title: DELAY_NOTE }, 'load'), h('th', { class: 'num', title: 'By load, minimum-size gates, no buffers' }, 'as drawn'), h('th', null, ''))),
      h('tbody', null, rows.map((r, i) => h('tr', null,
        h('td', null, h('a', { href: `#/workbench/${r.def.id}` }, r.name), r.fanout !== undefined ? h('span', { class: 'sub' }, ` · drives ${r.fanout}`) : null),
        h('td', { class: 'num', title: i === 5 ? "The decoder's own NANDs" : undefined }, r.nands ? r.nands.toLocaleString() : '—'),
        h('td', { class: 'num' }, String(r.unit)),
        h('td', { class: 'num' }, r.load.toFixed(1)),
        h('td', { class: 'num' }, r.drawn.toFixed(1)),
        h('td', { class: 'barcell' }, i ? h('span', { class: 'pfx-bars' }, bar(r.unit, 'u'), bar(r.load, 'l'), bar(r.drawn, 'd')) : h('span', { class: 'sub' }, 'off the scale')))))));
  };
  for (const n of [16, 32, 64]) pick.append(h('button', { 'data-n': String(n), onclick: () => show(n) }, `${n}-bit`));
  show(32);
  return {
    el: h('div', { class: 'widget' }, h('div', { class: 'panel' },
      h('h3', null, 'When fan-out costs ', pick),
      h('p', { class: 'sub' }, "Worst-case depth of each circuit from its netlist, in three models: every NAND one delay; each NAND by its load with buffer trees where they pay; by its load with minimum-size gates and no buffers. Measured between gates: each input driven by a minimum NAND, each output loading one NAND input. The row decoder: address to a word's flip-flops, its word line loaded by the word's enable muxes. The clock: the one NAND that drives every flip-flop's clock inputs."),
      body,
      h('div', { class: 'pfx-legend sub' }, h('span', null, h('i', { class: 'u' }), 'unit'), h('span', null, h('i', { class: 'l' }), 'load'), h('span', null, h('i', { class: 'd' }), 'as drawn')))),
  };
}
