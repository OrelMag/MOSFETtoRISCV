// The inspector's "Power" section: what the selected part spends, P ≈ α C V² f (sim/power.ts). On the
// running scene it reads the scene's own simulation (toggles counted from the moment the section opens);
// elsewhere it measures the part on seeded random inputs. V is the learner's; f comes from static timing.

import type { HierNode } from '../sim/flatten';
import { alphaOf, energyFj, fmtEnergy, fmtPower, hzOf, measurePower, POWER_NOTE, powerRefusal, powerW, VDD, type PowerMeter, type PowerReport, type PowerShare } from '../sim/power';
import type { ComponentDef } from '../sim/types';
import { h } from '../ui/dom';

/** The running scene's view of a part: its meter (counting since `since`), clock cycles since then, the clock period. */
export interface LivePower {
  meter: PowerMeter;
  node: HierNode;
  cycles: number;
  /** NAND delays per cycle of the scene (static timing), if it has a clock. */
  period?: number;
  restart: () => void;
}

let volts = VDD;
const reports = new WeakMap<ComponentDef, PowerReport | string>();

const fmtHz = (hz: number) => (hz >= 1e9 ? `${(hz / 1e9).toFixed(2)} GHz` : `${Math.round(hz / 1e6)} MHz`);

export function powerBody(def: ComponentDef, live: LivePower | null, rerender: () => void): HTMLElement {
  const box = h('div', { class: 'insp-power' });
  const vIn = h('input', { type: 'number', min: '0.4', max: '1.5', step: '0.05', value: String(volts), 'aria-label': 'Supply voltage' }) as HTMLInputElement;
  vIn.addEventListener('change', () => {
    const v = Number(vIn.value);
    if (v >= 0.2 && v <= 3) volts = v;
    rerender();
  });
  const head = h('div', { class: 'insp-power-v' }, h('label', null, 'V', h('sub', null, 'DD'), ' ', vIn, ' V'));
  box.append(head);

  let perUnit: number, functional: number | null, unit: string, period: number | undefined, shares: PowerShare[], cap = 0;
  if (live) {
    const units = Math.max(1, live.cycles);
    let sw = 0;
    const inside = live.meter.breakdown(live.node);
    for (const s of inside) sw += s.switched;
    perUnit = sw / units;
    functional = null;
    unit = live.cycles ? 'cycle' : 'run';
    period = live.cycles ? live.period : undefined;
    shares = inside.map((s) => ({ ...s, switched: s.switched / units }));
    head.append(h('button', { class: 'btn ghost sm', title: 'Count from now', onclick: () => { live.restart(); rerender(); } }, 'Restart'));
    box.append(h('p', { class: 'insp-power-src' }, live.cycles
      ? `Measured on this scene’s simulation over its last ${live.cycles.toLocaleString()} clock cycle${live.cycles > 1 ? 's' : ''} (since it loaded, a Reset, a step back or Restart), glitches included.`
      : sw ? 'Measured on this scene’s simulation: every input change since it loaded (or Restart), glitches included. Run the clock for energy per cycle.'
        : 'Nothing has switched yet: change an input or run the clock.'));
  } else {
    let r = reports.get(def);
    if (r === undefined) {
      const why = powerRefusal(def);
      r = why || measurePower(def);
      reports.set(def, r);
    }
    if (typeof r === 'string') {
      box.append(h('p', { class: 'empty' }, r));
      return box;
    }
    perUnit = r.switched;
    functional = r.functional;
    unit = r.kind === 'cycles' ? 'cycle' : 'operation';
    period = r.period;
    shares = r.shares;
    cap = r.cap;
    box.append(h('p', { class: 'insp-power-src' }, r.kind === 'cycles'
      ? `Measured over ${r.units} clock cycles with random data inputs (resets held off), glitches included.`
      : `Measured over ${r.units} random input vectors, each applied once the last has settled, glitches included.`));
  }

  const e = energyFj(perUnit, volts);
  const cells: [string, string][] = [[fmtEnergy(e), `per ${unit}`]];
  if (period) cells.push([fmtPower(powerW(e, period)), `at ${fmtHz(hzOf(period))} (${period} NAND delays)`]);
  if (functional !== null && perUnit > 0) cells.push([`${Math.round(100 * (1 - functional / perUnit))} %`, 'of it glitches']);
  if (cap) cells.push([alphaOf({ switched: perUnit, cap }).toFixed(3), 'activity α (0 → 1 per net, C-weighted)']);
  box.append(h('div', { class: 'stats' }, cells.map(([v, l]) => h('div', { class: 'stat' }, h('b', null, v), h('span', null, l)))));

  const total = shares.reduce((a, s) => a + s.switched, 0);
  if (total > 0 && shares.length > 1) {
    const SHOW = 10;
    const rows = shares.slice(0, SHOW).map((s) => {
      const pct = (100 * s.switched) / total;
      const sub = s.child && s.child.def.name !== s.name ? h('small', null, ` ${s.child.def.name}`) : null;
      return h('tr', null,
        h('td', null, s.name, sub),
        h('td', { class: 'val' }, fmtEnergy(energyFj(s.switched, volts))),
        h('td', { class: 'insp-power-bar' }, h('i', { style: `width:${pct.toFixed(1)}%` }), h('span', null, `${pct.toFixed(pct < 10 ? 1 : 0)} %`)));
    });
    const rest = shares.slice(SHOW).reduce((a, s) => a + s.switched, 0);
    if (rest > 0) rows.push(h('tr', null, h('td', null, `${shares.length - SHOW} more`), h('td', { class: 'val' }, fmtEnergy(energyFj(rest, volts))),
      h('td', { class: 'insp-power-bar' }, h('i', { style: `width:${((100 * rest) / total).toFixed(1)}%` }), h('span', null, `${((100 * rest) / total).toFixed(1)} %`))));
    box.append(h('div', { class: 'insp-used-h' }, `Per ${unit}, by the part driving each net`),
      h('table', { class: 'ports used insp-power-t' }, h('tbody', null, rows)));
  }
  box.append(h('p', { class: 'insp-power-note' }, POWER_NOTE));
  return box;
}
