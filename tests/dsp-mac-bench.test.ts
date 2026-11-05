// The MAC chapter's benchmarks: the data and exact outputs equal scipy's vectors (tests/dsp/vectors/mac.json), every machine's gates leave those outputs in memory,
// and the cycle counts and costs equal the checked-in figures (src/dsp/macbench.json, scripts/mac-bench.ts). The software-multiply machine runs on gates for the
// dot product only (the single-cycle cores retire one instruction a clock, which every other lane shows); its long kernels are counted on the golden model.
import { describe, expect, it } from 'vitest';
import { biquadData, boxTaps, dotData, firData, MAC_BENCHES, MAC_MACHINES, macPlan, type MacBench, type MacMachine } from '../src/dsp/macbench';
import figures from '../src/dsp/macbench.json';
import vec from './dsp/vectors/mac.json';
import { issCount, macCost, macPrograms, runMachine } from './verify/macbench';

describe('the data and the exact outputs are the oracle\'s', () => {
  it('FIR 16 and 64, equal to scipy-checked integers', () => {
    for (const [id, d] of [['fir16', firData(16, 16, 16)], ['fir64', firData(64, 8, 64)]] as const) {
      const v = vec[id];
      expect(d.h, id).toEqual(v.h); expect(d.x, id).toEqual(v.x); expect(d.y, id).toEqual(v.y);
      expect(Math.abs(v.sum_abs_h - 32768), 'taps sum to 1.0').toBeLessThan(8);
    }
    expect(boxTaps(16).reduce((a, b) => a + b, 0)).toBeGreaterThan(32760);
  });
  it('the biquad cascade and the dot product', () => {
    const b = biquadData();
    expect(b.sections).toEqual(vec.biquad.sos_q13); expect(b.x).toEqual(vec.biquad.x); expect(b.y).toEqual(vec.biquad.y);
    expect(vec.biquad.vs_sosfilt_max, 'LSB from scipy sosfilt with the same coefficients').toBeLessThan(4);
    const d = dotData();
    expect(d.a).toEqual(vec.dot.a); expect(d.b).toEqual(vec.dot.b); expect(d.y).toBe(vec.dot.y);
    expect(vec.dot.sum).toBe(vec.dot.numpy);
  });
});

type Fig = { cycles: number; setupCycles: number; kernel: number; products: number };
const fig = (m: MacMachine, b: MacBench) => (figures.machines as unknown as Record<string, { nands: number; period: number; benches: Record<string, Fig> }>)[m];

describe('the figures in macbench.json, re-measured', () => {
  for (const m of MAC_MACHINES) {
    it(`${m}: cycles, outputs and cost`, async () => {
      const f = fig(m, 'dot');
      const onGates: MacBench[] = m === 'rv32i' ? ['dot'] : [...MAC_BENCHES];
      const runs = await runMachine(m, onGates);
      for (const r of runs) {
        expect(r.diff, `${m} ${r.bench}`).toBe('');
        expect(r.cycles, `${m} ${r.bench} cycles`).toBe(f.benches[r.bench].cycles);
        expect(r.setupCycles, `${m} ${r.bench} setup`).toBe(f.benches[r.bench].setupCycles);
      }
      // the rest on the golden model, which the gates equalled clock for clock above
      for (const p of macPrograms(m, MAC_BENCHES.filter((b) => !onGates.includes(b)))) expect(issCount(p.full, p.endPc, m).n, `${m} ${p.plan.bench}`).toBe(f.benches[p.plan.bench].cycles);
      for (const b of MAC_BENCHES) expect(f.benches[b].products, b).toBe(macPlan(b, m).products);
      const c = macCost(m);
      expect(c.nands).toBe(f.nands); expect(c.period).toBe(f.period);
    }, 300000);
  }
});
