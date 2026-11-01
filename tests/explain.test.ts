import { describe, expect, it } from 'vitest';
import { FULL_ADDER, rca, SR_LATCH, DFF } from '../src/lib';
import { registry } from '../src/lib/define';
import { explainNet, explainNets, stepList, whyAt, whyNet, type Why } from '../src/sim/explain';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { inputBits, needsSwitchLevel, reachesTransistors } from '../src/sim/harness';
import { B0, B1, BX, type ComponentDef, inPorts, outPorts } from '../src/sim/types';

function sim(def: ComponentDef, inputs: Record<string, number>): GateSim {
  const s = new GateSim(flatten(def, { mode: 'gate' }));
  s.reset('zero');
  for (const [k, v] of Object.entries(inputs)) s.setInput(k, v);
  s.settle();
  return s;
}

/** Root pin nets a cause tree rests on. */
function pinsOf(w: Why, out = new Set<number>(), seen = new Set<Why>()): Set<number> {
  if (seen.has(w)) return out;
  seen.add(w);
  if (w.kind === 'pin') out.add(w.net);
  w.because.forEach((c) => pinsOf(c, out, seen));
  return out;
}

describe('whyNet', () => {
  it('follows the controlling input of the 9-NAND full adder', () => {
    const s = sim(FULL_ADDER, { a: 1, b: 0, cin: 1 });
    const cout = s.design.root.ports.cout[0];
    const { steps, lines } = explainNet(s, cout);
    expect(s.get(cout)).toBe(B1);
    expect(lines[0]).toMatch(/= 1 because .* = 0: one 0 into a NAND is enough/);
    // cout rests on cin (through g5) and on a / b (through the XOR), not on every pin by accident
    expect(steps.some((st) => st.kind === 'pin' && st.port === 'cin')).toBe(true);
  });

  it('a 0 out of a NAND cites every input', () => {
    const s = sim(FULL_ADDER, { a: 1, b: 1, cin: 0 });
    const w = whyNet(s, s.design.root.ports.s[0]);
    expect(w.value).toBe(B0);
    expect(w.kind).toBe('nand');
    expect(w.because.length).toBe(2);
  });

  it('stops at storage', () => {
    const s = sim(SR_LATCH, { s_n: 1, r_n: 1 });
    const q = s.design.root.ports.q[0];
    const steps = stepList(whyAt(s, whyNet(s, q)));
    expect(steps.some((st) => st.kind === 'storage')).toBe(true);
    const d = sim(DFF, { d: 1, clk: 0 });
    const top = whyAt(d, whyNet(d, d.design.root.ports.q[0]));
    expect(top.stored).toBe(true);
    expect(top.because.map((b) => b.port)).toEqual(['clk']);
  });

  it('folds a ripple adder into its full adders', () => {
    const s = sim(rca(4), { a: 9, b: 7, cin: 0 });
    const cout = s.design.root.ports.cout[0];
    const steps = stepList(whyAt(s, whyNet(s, cout)));
    expect(steps[0].inst).toBe('fa3');
    expect(steps[0].kind).toBe('box');
    expect(steps.some((st) => st.inst === 'fa2' && st.port === 'cout')).toBe(true);
  });

  // The causes are sufficient: with only the cited pins driven (every other input X), the
  // three-valued simulation still gives the same value.
  it('cited pins alone decide the value, over the library', () => {
    let seed = 99;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    let checked = 0;
    for (const def of registry.values()) {
      if (!def.spec || def.prim || !def.netlist || needsSwitchLevel(def) || reachesTransistors(def)) continue;
      if (inputBits(def) > 24 || inPorts(def).some((p) => p.name === 'clk')) continue;
      const design = flatten(def, { mode: 'gate' });
      if (design.leaves.some((l) => l.kind === 'behavior' && (l.def.behavior!.init || l.def.behavior!.seq))) continue;
      const s = new GateSim(design);
      const x = new GateSim(design);
      for (let t = 0; t < 4; t++) {
        s.reset('zero');
        const ins = inPorts(def).map((p) => Math.floor(rnd() * 2 ** Math.min(p.width, 30)));
        inPorts(def).forEach((p, i) => s.setInput(p.name, ins[i]));
        s.settle();
        for (const p of outPorts(def)) for (const net of design.root.ports[p.name]) {
          const v = s.get(net);
          if (v !== B0 && v !== B1) continue;
          const w = whyNet(s, net, 1e9);
          const cited = pinsOf(w);
          x.reset('x');
          for (const q of inPorts(def)) x.setInputBits(q.name, design.root.ports[q.name].map((n) => (cited.has(n) ? s.get(n) : BX)));
          x.settle();
          expect(x.get(net), `${def.id}.${p.name} at ${ins}`).toBe(v);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(500);
  });
  it('names a bus whole and its bits where a box uses them', () => {
    const s = sim(rca(4), { a: 9, b: 7, cin: 0 });
    const { lines } = explainNets(s, s.design.root.ports.s);
    expect(lines.filter((l) => l.startsWith('a = 9 is an input pin'))).toHaveLength(1);
    expect(lines).toContain('fa1.s = 0 from a[1] = 0, b[1] = 1, fa0.cout = 1.');
  });
});
