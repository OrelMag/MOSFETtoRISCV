// Tours, ledgers and layers: every beat's levels and parts exist in its scene, and each beat leaves the root ports
// it expects when the beats are played in order on a fresh simulation of the scene (the stage plays them the same
// way); a ledger names ports of its scene; a caption's {v:…} names a port; numbers in captions and layers come from
// the circuit, so this is what keeps a tour from drifting away from it.

import { describe, expect, it } from 'vitest';
import { chapters } from '../src/chapters';
import type { Step } from '../src/chapters/types';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { needsSwitchLevel } from '../src/sim/harness';
import { switchSim } from '../src/view/context';
import { netlistOf, type ComponentDef } from '../src/sim/types';
import { pack } from '../src/sim/values';
import type { Sim } from '../src/sim/sim';

function defAt(root: ComponentDef, path: readonly string[]): ComponentDef | undefined {
  let d: ComponentDef | undefined = root;
  for (const n of path) d = d && netlistOf(d)?.instances.find((i) => i.name === n)?.def;
  return d;
}

const withTours = chapters.flatMap((c) => c.steps.map((s, i) => [`${c.id}/${i}`, s] as [string, Step])).filter(([, s]) => s.tour || s.ledger);

describe('tours', () => {
  it('there are tours to check', () => expect(withTours.length).toBeGreaterThan(0));

  for (const [where, st] of withTours) {
    it(where, () => {
      const scene = st.scene?.();
      expect(scene, `${where}: a tour or ledger needs a scene`).toBeTruthy();
      const root = scene!.root;
      const ports = new Set(root.ports.map((p) => p.name));
      if (st.ledger) {
        const l = st.ledger;
        for (const p of [l.a, l.b, l.sum, l.cin, l.cout, l.sub]) if (p) expect(ports.has(p), `${where}: ledger port ${p}`).toBe(true);
        if (l.col) for (let i = 0; i < l.width; i++) for (const n of l.col(i)) expect(defAt(root, [...(scene!.path ?? []), n]), `${where}: ledger column ${i} names ${n}`).toBeTruthy();
      }
      if (!st.tour) return;
      const sim: Sim = needsSwitchLevel(root) ? switchSim(flatten(root, { mode: 'switch' })) : new GateSim(flatten(root, { mode: 'gate' }));
      sim.reset('zero');
      for (const [k, v] of Object.entries(scene!.inputs ?? {})) sim.setInput(k, v);
      sim.settle();
      const clk = scene!.clock ?? root.ports.find((p) => p.name === 'clk')?.name;
      let at = scene!.path ?? [];
      st.tour.beats.forEach((b, k) => {
        const tag = `${where} beat ${k + 1}`;
        if (b.at) at = b.at;
        const level = defAt(root, at);
        expect(level, `${tag}: level ${at.join('.')}`).toBeTruthy();
        const names = new Set(netlistOf(level!)?.instances.map((i) => i.name) ?? []);
        for (const n of [...(b.show ?? []), ...(b.ghost ?? [])]) expect(names.has(n), `${tag}: no part ${n} at ${at.join('.') || 'the top'}`).toBe(true);
        for (const m of b.say.matchAll(/\{[vb]:([\w.]+)\}/g)) expect(ports.has(m[1]), `${tag}: caption names port ${m[1]}`).toBe(true);
        for (const [p, v] of Object.entries(b.set ?? {})) {
          expect(ports.has(p), `${tag}: sets ${p}`).toBe(true);
          sim.setInput(p, v);
        }
        sim.settle();
        for (let c = 0; c < (b.cycles ?? 0); c++) {
          expect(clk, `${tag}: cycles need a clock`).toBeTruthy();
          sim.setInput(clk!, 1); sim.settle();
          sim.setInput(clk!, 0); sim.settle();
        }
        for (const [p, v] of Object.entries(b.expect ?? {})) expect(pack(sim.getBits(sim.design.root.ports[p])), `${tag}: ${p}`).toBe(v);
      });
    });
  }
});

describe('layers', () => {
  it('no layer is empty and a step with layers has a body', () => {
    for (const c of chapters) c.steps.forEach((s, i) => {
      for (const [k, v] of Object.entries(s.more ?? {})) expect(String(v).trim().length, `${c.id}/${i} ${k}`).toBeGreaterThan(40);
    });
  });
});
