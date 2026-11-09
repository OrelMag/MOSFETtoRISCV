// The Power panel (the Power chapter, any gate-level scene): where the energy goes, live. Bars by top-level block from
// the stage's PowerMeter (sim/power.ts: every toggle × its net's C, ½ C V² each, glitches included), the clock net
// apart; energy per cycle and the power at the scene's static-timing period; the leakage of the state the circuit is
// in now, for both processes of phys/cmosv.ts (sim/leakage.ts). Counted since the scene loaded, a Reset, a step back
// or Restart. Off GateSim (a cycle-engine scene) it says why instead.

import { PROCESSES } from '../phys/cmosv';
import { leakageOf } from '../sim/leakage';
import { energyFj, fmtEnergy, fmtPower, powerW, VDD } from '../sim/power';
import { h } from '../ui/dom';
import type { ScenePanel, Stage, Widget } from '../view/stage';

/** Redraws at most this often while the clock runs (ms). */
const EVERY_MS = 250;
/** Blocks shown by name; the rest are summed into one row. */
const ROWS = 6;

export interface PowerPanelOptions {
  /** What a clock cycle is called in the totals ('instruction' on a single-cycle CPU). */
  per?: string;
}

export function powerPanel(opts: PowerPanelOptions = {}): ScenePanel {
  return (stage: Stage): Widget => {
    const body = h('div', { class: 'pw-body' });
    const restart = h('button', { class: 'btn ghost sm', title: 'Count from now' }, 'Restart');
    const el = h('div', { class: 'mem-panel power-panel', 'data-dock': 'right', 'data-fold': 'narrow' },
      h('h4', null, 'Power', h('span', { class: 'fold-hint' })), body);
    let last = 0, cyclesShown = -1;

    const paint = () => {
      const live = stage.power();
      if (!live) {
        body.replaceChildren(h('p', { class: 'sub' }, 'This scene runs on the cycle engine, which counts no toggles: no energy to show.'));
        return;
      }
      restart.onclick = () => { live.restart(); cyclesShown = -1; paint(); };
      const cycles = live.cycles;
      cyclesShown = cycles;
      const shares = live.meter.breakdown(live.node);
      const total = shares.reduce((a, s) => a + s.switched, 0);
      if (!cycles || !total) {
        body.replaceChildren(h('p', { class: 'sub' }, 'Nothing has run yet: Step or Run the clock, and each block’s share of the energy appears here.'), restart);
        return;
      }
      const per = opts.per ?? 'cycle';
      const fj = energyFj(total) / cycles;
      const shown = shares.slice(0, ROWS);
      const rest = shares.slice(ROWS).reduce((a, s) => a + s.switched, 0);
      const rows = [...shown.map((s) => [s.name, s.switched] as const), ...(rest ? [['others', rest] as const] : [])];
      const max = Math.max(...rows.map((r) => r[1]));
      const bars = h('div', { class: 'pw-bars', role: 'list' }, ...rows.flatMap(([name, sw]) => [
        h('span', { class: 'pw-name', role: 'listitem' }, name),
        h('span', { class: 'pw-bar' + (name.startsWith('clock') ? ' clk' : '') , style: `width:${(100 * sw / max).toFixed(1)}%` }),
        h('span', { class: 'pw-num' }, `${fmtEnergy(energyFj(sw) / cycles)} · ${Math.round((100 * sw) / total)} %`),
      ]));
      const leak = (['hp', 'lp'] as const).map((id) => {
        const r = leakageOf(live.meter.sim, live.meter.design, PROCESSES[id]);
        return h('div', null, h('b', null, fmtPower(r.watts)), h('span', null, `leaking now, ${PROCESSES[id].name.toLowerCase()} process`));
      });
      body.replaceChildren(
        h('div', { class: 'pw-kpi' },
          h('div', null, h('b', null, fmtEnergy(fj)), h('span', null, `per ${per}, ${VDD} V`)),
          ...(live.period ? [h('div', null, h('b', null, fmtPower(powerW(fj, live.period))), h('span', null, `dynamic, at a period of ${Math.round(live.period)} NAND delays`))] : []),
          ...leak),
        bars,
        h('p', { class: 'sub' }, `Over the last ${cycles} ${per}${cycles === 1 ? '' : 's'}: every toggle of every net, glitches included, at ½ C V². Leakage: the NANDs’ off transistors in the state the circuit is in now.`),
        restart);
    };

    paint();
    return {
      el,
      update: () => {
        const now = performance.now();
        const live = stage.power();
        if (live && live.cycles === cyclesShown) return;
        if (now - last < EVERY_MS && cyclesShown > 0) return;
        last = now;
        paint();
      },
    };
  };
}
