// The numbers the chapters quote about load-dependent delay (docs/PLAN-FINEDELAY.md, stage 5), measured again: the ripple
// adder's glitches (adders), the mux's dip (gates), the setup / hold sweeps and the skew pair (chapter 8), the CPU's
// static path and per-class settle times (chapter 14). widgets/finedelay.ts FINE and widgets/cpucost.ts PERIOD_LOAD /
// MEASURED hold them so no chapter simulates at load.

import { describe, expect, it } from 'vitest';
import { singleCycleCpu } from '../src/lib';
import { NAND } from '../src/lib/transistors';
import { assemble } from '../src/riscv/asm';
import { measureClasses } from '../src/riscv/cycletime';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { analyzeTiming } from '../src/sim/timing';
import type { ComponentDef } from '../src/sim/types';
import { MEASURED, PERIOD, PERIOD_LOAD } from '../src/widgets/cpucost';
import { sweepOf } from '../src/widgets/edgesweep';
import { FINE, muxDip, rippleGlitches, sharedNotWidth, skewTimes, sweepNumbers } from '../src/widgets/finedelay';
import { tick } from './yieldtick';

const MODELS = ['unit', 'load'] as const;

describe('adders: glitches of the ripple adder', () => {
  for (const m of MODELS) {
    it(m, () => {
      const g = rippleGlitches(m), want = FINE.ripple[m];
      for (const k of Object.keys(want) as (keyof typeof want)[]) expect(g[k], k).toBeCloseTo(want[k], 2);
    });
  }
  it('more glitches under load, the settled toggles and their energy the same', () => {
    const u = rippleGlitches('unit'), l = rippleGlitches('load');
    expect(l.glitches).toBeGreaterThan(u.glitches);
    expect(u.glitches).toBeGreaterThan(0);
    expect(l.settled).toBe(u.settled);
    expect(l.settledEnergy).toBe(u.settledEnergy);
  });
});

describe('gates: the mux dip', () => {
  it('one unit wide under both models', () => {
    for (const m of MODELS) expect(muxDip(m)).toBe(FINE.muxDip[m]);
  });
  // a mux bit whose ¬s comes from one inverter shared with n − 1 others: the dip on bit 0 is that inverter's delay
  const shared = (n: number): ComponentDef => {
    const instances = [{ name: 'inv', def: NAND, at: [0, 0] as [number, number] }];
    const nets: { ends: string[] }[] = [{ ends: ['s', 'inv.a', 'inv.b'] }];
    const ns: string[] = ['inv.y'];
    for (let i = 0; i < n; i++) {
      instances.push({ name: `ga${i}`, def: NAND, at: [6, 6 * i] }, { name: `gb${i}`, def: NAND, at: [6, 6 * i + 3] }, { name: `go${i}`, def: NAND, at: [12, 6 * i] });
      ns.push(`ga${i}.b`);
      nets.push({ ends: [`a${i}`, `ga${i}.a`] }, { ends: [`b${i}`, `gb${i}.a`] }, { ends: [`ga${i}.y`, `go${i}.a`] }, { ends: [`gb${i}.y`, `go${i}.b`] }, { ends: [`go${i}.y`, `y${i}`] });
    }
    nets.push({ ends: ns });
    nets[0].ends.push(...Array.from({ length: n }, (_, i) => `gb${i}.b`));
    const ports = [{ name: 's', width: 1, dir: 'in' as const }];
    for (let i = 0; i < n; i++) ports.push({ name: `a${i}`, width: 1, dir: 'in' }, { name: `b${i}`, width: 1, dir: 'in' }, { name: `y${i}`, width: 1, dir: 'out' as never });
    return { id: `test_sharedmux${n}`, name: 'shared-inverter mux', category: 'routing', ports, symbol: { kind: 'box' }, netlist: () => ({ pins: {}, instances, nets }) } as unknown as ComponentDef;
  };
  for (const n of [1, 8, 32]) {
    it(`¬s shared by ${n}: the dip is the inverter's load-model delay`, () => {
      expect(sharedNotWidth(n)).toBe(FINE.muxShared[n]);
      const d = flatten(shared(n), { mode: 'gate' });
      const sim = new GateSim(d, { delay: 'load' });
      for (let i = 0; i < n; i++) { sim.setInput(`a${i}`, 1); sim.setInput(`b${i}`, 1); }
      sim.setInput('s', 1); sim.settle();
      const y = d.root.ports.y0[0];
      let fell = -1, width = 0;
      sim.onTrace = (net, b, t) => { if (net !== y) return; if (b === 0) fell = t; else if (fell >= 0) width = t - fell; };
      sim.watch([y]);
      sim.setInput('s', 0); sim.settle();
      expect(Math.round(width * 10) / 10).toBe(FINE.muxShared[n]);
    });
  }
});

describe('chapter 8 under load', () => {
  for (const id of ['ms', 'e6'] as const) for (const dir of ['rise', 'fall'] as const) for (const m of MODELS) {
    it(`${id} ${dir} ${m}`, () => expect(sweepNumbers(sweepOf(id, dir, m))).toEqual(FINE.sweep[id][dir][m]));
  }
  it('the unit sweep is the one the chapter quoted before', () => {
    expect(sweepOf('ms', 'rise').offsets).toEqual(sweepOf('ms', 'rise', 'unit').offsets);
    expect(sweepOf('ms', 'rise', 'load').offsets.length).toBe(161);
  });
  for (const m of MODELS) {
    it(`the skew pair, ${m}`, () => expect([0, 1, 2, 3].map((k) => skewTimes(k, m))).toEqual(FINE.skew[m]));
  }
  it('the outcome per buffer count is the same under both models', () => {
    expect(FINE.skew.load.map((x) => x.q2)).toEqual(FINE.skew.unit.map((x) => x.q2));
  });
});

describe('chapter 14 under load', () => {
  const t = (x: number) => Math.round(x * 10) / 10;
  for (const adder of ['rca', 'ks'] as const) {
    it(`${adder}: the static load-model path and its ribbon`, () => {
      const rep = analyzeTiming(flatten(singleCycleCpu(assemble('li a0, 1\nhalt: j halt').words, { adder }), { mode: 'gate' }), { delay: 'load' })!;
      const p = PERIOD_LOAD[adder];
      expect(t(rep.period)).toBe(p.pc);
      expect(Object.fromEntries(rep.byCapture.map((c) => [c.inst, t(c.period)]))).toEqual({ pc: p.pc, rf: p.rf, dm: p.dm });
      const s = rep.stages;
      expect(p.stages.map(([n]) => n)).toEqual([...s.slice(0, -1).map((x) => x.inst), 'setup']);
      // each block's share rounded to a tenth; the last takes up the rounding, so the ribbon adds up to the period
      for (let i = 0; i < s.length - 1; i++) expect(p.stages[i][1], s[i].inst).toBe(t(i ? s[i].arrival - s[i - 1].arrival : s[i].arrival));
      expect(t(p.stages.reduce((a, [, d]) => a + d, 0))).toBe(p.pc);
      expect(Math.abs(p.stages[p.stages.length - 1][1] - (rep.period - s[s.length - 2].arrival))).toBeLessThan(0.15);
    });
    it(`${adder}: per-class settle times on both models, every cycle under its static path`, async () => {
      for (const m of MODELS) {
        const r = await measureClasses(adder, [1, 2, 3], 60, tick, m);
        const want = MEASURED[adder][m];
        expect(r.cycles).toBe(304);
        expect(r.worst).toBe(want.worst);
        for (const c of ['R', 'I', 'LOAD', 'STORE', 'BRANCH', 'LUI'] as const) expect(r.classes.find((x) => x.cls === c)!.max, c).toBe(want[c]);
        expect(r.worst).toBeLessThanOrEqual(m === 'unit' ? PERIOD[adder].pc : PERIOD_LOAD[adder].pc);
      }
    }, 120_000);
  }
});
