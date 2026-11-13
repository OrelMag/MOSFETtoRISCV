// The AGC logic module: the flatpack to drawing 1006321, the counts against lib/agcnor.ts, the gate's rule against the
// switch-level NOR3_RTL, and the drawing following the state.
import { describe, expect, it } from 'vitest';
import { NOR3_RTL, NOR_ADD4, NOR_REG4 } from '../src/lib/agcnor';
import { simulate } from '../src/sim/harness';
import { stats } from '../src/sim/stats';
import {
  ADDER_GATES, ADDER_PACKAGES, BOARDS, FP, LEADS, MOD, MODULE_GATES, PACKAGES, PER_BOARD, PINOUT, REG_PACKAGES, conducting, norOut, packageAt, packagesFor,
} from '../src/widgets/agcmodule3dgeom';
import { agcModel, leadCentres } from '../src/widgets/agcmodule3dkit';

const IN = 25.4;
describe('AGC logic module', () => {
  it('the flatpack is drawing 1006321\'s: 0.275 × 0.190 × 0.070 in, ten leads 0.050 in apart, GND on 5 and VCC on 10', () => {
    expect(FP.l).toBeCloseTo(0.275 * IN, 6); expect(FP.w).toBeCloseTo(0.19 * IN, 6); expect(FP.h).toBeCloseTo(0.07 * IN, 6);
    expect(FP.pitch).toBeCloseTo(0.05 * IN, 6);
    expect(LEADS).toBe(10);
    expect([PINOUT[4], PINOUT[9], PINOUT[0], PINOUT[8]]).toEqual(['GND', 'VCC', 'O1', 'O2']);
    const leads = leadCentres();
    expect(leads.map((l) => l.pin)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    for (let i = 0; i < 4; i++) expect(Math.abs(leads[i + 1].x - leads[i].x)).toBeCloseTo(FP.pitch, 6);
    expect(leads[0].x).toBeGreaterThan(0); // pin 1 at the stripe's end
  });
  it('a module is two boards of sixty: 240 gates; the adder and register in packages are ⌈gates / 2⌉ of lib/agcnor.ts', () => {
    expect([BOARDS, PER_BOARD, PACKAGES, MODULE_GATES]).toEqual([2, 60, 120, 240]);
    expect(ADDER_GATES).toBe(stats(NOR_ADD4).nor3);
    expect(ADDER_PACKAGES).toBe(Math.ceil(ADDER_GATES / 2));
    expect(REG_PACKAGES).toBe(packagesFor(stats(NOR_REG4).nor3!));
    // the sixty fit the CHM outline with their leads, none overlapping
    const span = FP.w + 2 * FP.leadL;
    for (let i = 0; i < PER_BOARD; i++) {
      const a = packageAt(i);
      expect(Math.abs(a.u) + FP.l / 2).toBeLessThan(MOD.l / 2);
      expect(Math.abs(a.v) + span / 2).toBeLessThan(MOD.h / 2);
      for (let j = 0; j < i; j++) { const b = packageAt(j); expect(Math.abs(a.u - b.u) >= FP.l || Math.abs(a.v - b.v) >= span).toBe(true); }
    }
  });
  it('the gate is NOR3_RTL: for every input, y and which transistors conduct', () => {
    const s = simulate(NOR3_RTL);
    for (let k = 0; k < 8; k++) {
      const ins = [k & 1, (k >> 1) & 1, (k >> 2) & 1] as [number, number, number];
      s.setInput('a', ins[0]); s.setInput('b', ins[1]); s.setInput('c', ins[2]); s.settle();
      expect(norOut(...ins), `inputs ${ins}`).toBe(s.getBits(s.design.root.ports.y)[0]);
      expect(conducting(ins).filter(Boolean).length).toBe(ins.filter(Boolean).length);
    }
  });
  it('the drawing: the adder\'s packages lit, the gate\'s output following a, b, c, a tour, a flat fallback', () => {
    const lit = (adder: boolean) => agcModel({ view: 'module', ins: [0, 0, 0], adder }).items.some((i) => i.mat.label === 'a flatpack of the four-bit adder');
    expect(lit(true)).toBe(true); expect(lit(false)).toBe(false);
    const outHigh = (ins: [number, number, number]) => agcModel({ view: 'gate', ins, adder: false }).items.find((i) => i.name === 'gate 1: output pad')!.mat.label!.includes('at 1');
    expect(outHigh([0, 0, 0])).toBe(true);
    expect(outHigh([0, 1, 0])).toBe(false);
    const on = agcModel({ view: 'gate', ins: [1, 0, 1], adder: false }).items.filter((i) => i.mat.label?.startsWith('emitter: this transistor conducts')).map((i) => i.name);
    expect(on).toEqual(['gate 1: transistor a', 'gate 1: transistor c']);
    const m = agcModel({ view: 'tray', ins: [0, 0, 0], adder: true });
    expect((m.beats ?? []).length).toBeGreaterThanOrEqual(5);
    expect(agcModel({ view: 'module', ins: [0, 0, 0], adder: true }, 'flat').items.length).toBeGreaterThan(0);
  });
});
