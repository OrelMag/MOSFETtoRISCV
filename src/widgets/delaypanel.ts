// A Unit / Load switch for a chapter scene (docs/PLAN-FINEDELAY.md, stage 5): the scene reloads on the other delay model with
// the inputs it has now. With `glitches`, it also counts the last input change's toggles: those that left a net on a new
// value (settled) and the rest (glitches: a net that changed and changed back), with their energy (½ C V², sim/power.ts).

import { GateSim } from '../sim/gatesim';
import { netCaps } from '../sim/netcap';
import { energyFj } from '../sim/power';
import { h } from '../ui/dom';
import { delaySwitch } from '../view/delayui';
import type { ScenePanel, Stage, Widget } from '../view/stage';

/** The scene again on `model`, with the inputs it has now. */
export function reloadWithDelay(stage: Stage, model: 'unit' | 'load'): void {
  const sc = stage.scene;
  if (!sc) return;
  const inputs: Record<string, number> = { ...sc.inputs };
  for (const p of sc.root.ports) if (p.dir === 'in') inputs[p.name] = stage.getInput(p.name);
  const { delay: _old, ...rest } = sc;
  stage.load({ ...rest, inputs, ...(model === 'load' ? { delay: 'load' } : {}) });
}

export function delayPanel(opts: { glitches?: boolean } = {}): ScenePanel {
  return (stage: Stage): Widget => {
    const model = stage.delayOf(stage.scene!);
    const read = h('div', { class: 'dp-read', role: 'status', 'aria-live': 'polite' });
    const el = h('div', { class: 'mem-panel dp-panel', 'data-dock': 'right' }, h('h4', null, 'Gate delays', h('span', { class: 'fold-hint' })),
      h('div', { class: 'param-row' }, delaySwitch(model, (m) => reloadWithDelay(stage, m === 'load' ? 'load' : 'unit'))),
      h('p', { class: 'dp-note' }, model === 'unit' ? 'Every NAND takes one delay.' : 'Each NAND takes longer the more inputs it drives (in units: one unit is a NAND driving one input).'),
      ...(opts.glitches ? [read] : []));
    if (!opts.glitches) return { el };
    // the last change, counted when the circuit is quiet again
    let sim: GateSim | null = null, caps: Float64Array = new Float64Array(0), snap: Uint8Array = new Uint8Array(0), base: Uint32Array = new Uint32Array(0), at = -1;
    const start = () => {
      sim = stage.sim instanceof GateSim ? stage.sim : null;
      if (!sim) return;
      if (!sim.toggles) sim.countToggles();
      caps = netCaps(sim.design);
      snap = new Uint8Array(sim.design.netCount).map((_, i) => sim!.get(i));
      base = sim.toggles!.slice();
      at = sim.time;
    };
    read.textContent = 'Change an input: its toggles are counted here.';
    const update = () => {
      if (stage.sim !== sim) start();
      if (!sim || sim.busy() || sim.time === at) return;
      const t = sim.toggles!;
      let toggles = 0, settled = 0, cap = 0;
      for (let i = 0; i < snap.length; i++) {
        const k = t[i] - base[i];
        toggles += k;
        cap += k * caps[i];
        const b = sim.get(i);
        if (b !== snap[i] && (b | snap[i]) === 1) settled++;
      }
      read.replaceChildren(
        h('div', null, 'Last change: ', h('b', null, String(toggles)), ' toggles'),
        h('div', null, h('b', null, String(settled)), ' settled, ', h('b', null, String(toggles - settled)), ` glitch${toggles - settled === 1 ? '' : 'es'}`),
        h('div', null, h('b', null, `${energyFj(cap).toFixed(2)} fJ`), ' switched'));
      start();
    };
    start();
    return { el, update };
  };
}
