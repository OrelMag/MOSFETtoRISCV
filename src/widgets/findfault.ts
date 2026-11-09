// "Find it" steps in the CPU chapters (docs/PLAN-ONI.md D2, roadmap Phase 23): the chapter's CPU with one fault planted
// in its silicon (sim/faults.ts withPlanted: a top-level net stuck at 0 or 1, never drawn). The CPU panel's golden model
// stops at the first mismatch: that is the clue. The learner right-clicks the wire they suspect, "It is stuck at 0 here",
// and is right when it names the planted net and value (on a CPU only the very net will do, as on the campaign's CPU
// bench). A wrong accusation is answered with what that fault would have done to the same program, computed
// (riscv/firstwrong.ts), never written by hand. Chapters are ungraded: no stars, only the step's challenge.

import type { Challenge } from '../chapters/types';
import { firstWrong, type FirstWrong } from '../riscv/firstwrong';
import type { IssOptions } from '../riscv/iss';
import { type FlatFault, plantedDef, plantedFaults, type PlantedFault } from '../sim/faults';
import type { ComponentDef } from '../sim/types';
import { h } from '../ui/dom';
import type { MenuEntry } from '../ui/menu';
import type { Scene, ScenePanel, Stage, Widget } from '../view/stage';
import { assemble } from '../riscv/asm';
import { cpuRoot, cpuScene, type CpuSceneOptions, issOptsOf } from './cpupanel';

export interface FindSpec {
  /** The healthy CPU (the scene's root before planting) and its program. */
  healthy: () => ComponentDef;
  words: readonly number[];
  iss: IssOptions;
  inputs?: Record<string, number>;
  pipelined?: boolean;
  planted: PlantedFault[];
  /** HTML: what the fault was and how it showed (after it is found, and the challenge's answer). */
  fault: string;
}

interface Accusation { name: string; kind: 'stuck0' | 'stuck1'; right: boolean; would: FirstWrong | null }
interface State { found: boolean; helped: boolean; tries: Accusation[] }

// per stage and step (a chapter's stage stays across its steps)
const states = new WeakMap<Stage, Map<FindSpec, State>>();
const stateOf = (stage: Stage, spec: FindSpec): State => {
  let m = states.get(stage);
  if (!m) states.set(stage, (m = new Map()));
  let s = m.get(spec);
  if (!s) m.set(spec, (s = { found: false, helped: false, tries: [] }));
  return s;
};

const MENU_BITS = 32;
const same = (a: readonly number[], b: readonly number[]) => a.length === b.length && [...a].sort((x, y) => x - y).every((v, i) => v === [...b].sort((x, y) => x - y)[i]);

/** The panel: how to accuse, every accusation so far with what that fault would do, and the fault once found. */
export function findPanel(spec: FindSpec): ScenePanel {
  return (stage: Stage): Widget => {
    const st = stateOf(stage, spec);
    let plantedWrong: FirstWrong | null | undefined;
    const title = h('h4', null, 'Find the fault', h('span', { class: 'fold-hint' }));
    const body = h('div', { class: 'find-body' });
    const el = h('div', { class: 'mem-panel find-panel', 'data-dock': 'left', 'data-phone': 'flow' }, title, body);
    title.addEventListener('click', () => el.classList.toggle('collapsed'));

    /** The planted faults on this scene's nets (the root's numbering, the same as flatten's of the healthy CPU). */
    const planted = (): FlatFault[] | null => (stage.sim ? plantedFaults(stage.sim.design.root, spec.planted) : null);

    const accuse = (nets: readonly number[], name: string, kind: 'stuck0' | 'stuck1') => {
      const p = planted();
      if (!p) return;
      const right = p.length === 1 && p[0].kind === kind && same(p[0].nets, nets);
      // what this fault would do to the same program: the CPU without the planted fault, with this one instead
      const would = right ? null : firstWrong(plantedDef(spec.healthy(), (n) => (n.parent === null ? [{ kind, nets }] : []), 'accused'), spec.words, spec.iss, { inputs: spec.inputs, pipelined: spec.pipelined });
      st.tries.push({ name, kind, right, would });
      if (right) st.found = true;
      paint();
      stage.refresh();
    };

    stage.accuser = (flat, name) => {
      if (st.found || !flat.length) return [];
      const say = (kind: 'stuck0' | 'stuck1'): MenuEntry => {
        const label = `It is stuck at ${kind === 'stuck0' ? 0 : 1} here`;
        return flat.length === 1
          ? { label, hint: 'Find the fault: accuse this wire', run: () => accuse(flat, name, kind) }
          : { label, sub: Array.from({ length: Math.min(flat.length, MENU_BITS) }, (_, b) => ({ label: `Bit ${b}`, run: () => accuse([flat[b]], `${name}[${b}]`, kind) })) };
      };
      return [say('stuck0'), say('stuck1')];
    };

    const paint = () => {
      const rows = st.tries.map((t) => {
        const v = t.kind === 'stuck0' ? 0 : 1;
        if (t.right) return h('li', { class: 'good' }, `✓ ${t.name} stuck at ${v}: that is the fault.`);
        plantedWrong ??= firstWrong(plantedDef(spec.healthy(), (n) => (n.parent === null ? planted() ?? [] : []), 'planted'), spec.words, spec.iss, { inputs: spec.inputs, pipelined: spec.pipelined });
        const here = plantedWrong ? ` This CPU: ${plantedWrong.text} (cycle ${plantedWrong.cycle}).` : '';
        return h('li', { class: 'bad' }, `✗ ${t.name} stuck at ${v}: `, t.would
          ? `the first wrong instruction would be different: ${t.would.text} (cycle ${t.would.cycle}).${here}`
          : `with it, this program would run right to the end.${here}`);
      });
      body.replaceChildren(
        st.found
          ? h('div', null, h('p', { class: 'good' }, st.helped ? 'The fault, shown for you:' : 'Found it.'), h('p', { html: spec.fault }))
          : h('p', { class: 'sub' }, 'Run until the golden model stops at a mismatch. Then right-click the wire you suspect: “It is stuck at 0 here” or “… at 1”.'),
        ...(rows.length ? [h('ul', { class: 'find-tries' }, ...rows)] : []));
    };
    paint();
    return {
      el,
      update: () => { if (st.found && !body.querySelector('.good')) paint(); },
      destroy: () => { if (stage.accuser) stage.accuser = null; },
    };
  };
}

/** The step's challenge: name the planted fault. Show answer says what it was; Do it for me names it (helped). */
export function findChallenge(spec: FindSpec, goal: string, hints: string[]): Challenge {
  return {
    kind: 'reach', goal, hints,
    check: (stage) => states.get(stage)?.get(spec)?.found === true,
    answer: spec.fault,
    solve: (stage) => { const s = stateOf(stage, spec); s.found = true; s.helped = true; stage.refresh(); },
  };
}

/**
 * A chapter's find-it step from its CPU scene's options: the scene (the CPU with the fault planted, the Find the fault
 * panel beside the CPU panel, paused at power-on) and the step's challenge.
 */
export function findIt(opts: CpuSceneOptions & { planted: PlantedFault[]; fault: string; goal: string; hints: string[] }): { scene: () => Scene; challenge: Challenge } {
  const asm = assemble(opts.source, opts.custom, { mac: opts.mac });
  const spec: FindSpec = {
    healthy: () => cpuRoot(opts, asm), words: asm.words, iss: issOptsOf(opts, asm), pipelined: !!opts.pipeline,
    inputs: opts.system ? { clk: 0, switches: 0, irq: 0 } : { clk: 0 }, planted: opts.planted, fault: opts.fault,
  };
  return {
    scene: () => ({ ...cpuScene({ ...opts, extraPanels: [...(opts.extraPanels ?? []), findPanel(spec)] }), autoClock: false }),
    challenge: findChallenge(spec, opts.goal, opts.hints),
  };
}
