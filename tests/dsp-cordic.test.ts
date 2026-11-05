// CORDIC: the model against Math at every angle a word can hold, and the gates against the model every clock.

import { describe, expect, it } from 'vitest';
import { atanTable, cordicBound, CordicIter, CordicPipe, cordicError, cordicRun, cordicSinCos, cordicStretch, cordicVector, type CordicSpec } from '../src/dsp/cordic';
import { signedOf, wordOf } from '../src/comm/signals';
import { arithShifter, cordicIterative, cordicPipeline } from '../src/lib/cordic';
import { flatten } from '../src/sim/flatten';
import { BitSim } from '../src/sim/bitsim';

const S: CordicSpec = { w: 16, z: 16, n: 14 };
const SMALL: CordicSpec = { w: 12, z: 12, n: 10 };

describe('the model', () => {
  it('the stretch tends to 1 / 0.607253', () => {
    expect(1 / cordicStretch(24)).toBeCloseTo(0.607253, 6);
    expect(1 / cordicStretch(2)).toBeCloseTo(1 / (Math.SQRT2 * Math.sqrt(1.25)), 12);
  });
  it('the angles add up to about 99.9°, so the half-turn covers the rest of the circle', () => {
    const sum = atanTable({ w: 16, z: 16, n: 16 }).reduce((a, b) => a + b, 0) / 2 ** 16 * 360;
    expect(sum).toBeGreaterThan(99.8);
    expect(sum).toBeLessThan(99.95);
  });
  it('sine and cosine stay inside the bound at every angle a word can hold', () => {
    const scale = 2 ** 14, e = cordicError(S, scale);
    expect(e.worst).toBeLessThanOrEqual(cordicBound(S, scale));
    expect(e.worst).toBeLessThan(12); // a 15-bit result, wrong in its last four bits at worst
  });
  it('a stage more halves the angle left over, until rounding takes over', () => {
    const scale = 2 ** 14, err = (n: number) => cordicError({ w: 16, z: 16, n }, scale).worst;
    expect(err(6)).toBeGreaterThan(1.7 * err(7));
    expect(err(8)).toBeGreaterThan(1.7 * err(9));
    expect(err(14)).toBeGreaterThan(0.5 * err(13));
  });
  it('rotating lands where the angle says, in all four quadrants', () => {
    for (const t of [0.1, 0.3, 0.6, 0.9]) {
      const r = cordicSinCos(t, S, 2 ** 14);
      expect(r.cos / 2 ** 14).toBeCloseTo(Math.cos(2 * Math.PI * t), 3);
      expect(r.sin / 2 ** 14).toBeCloseTo(Math.sin(2 * Math.PI * t), 3);
    }
  });
  it('vectoring gives arctangent and magnitude, against atan2 and hypot', () => {
    const k = cordicStretch(S.n), scale = 2 ** 13;
    for (let t = 0; t < 1; t += 0.037) {
      const x = Math.round(scale * Math.cos(2 * Math.PI * t)), y = Math.round(scale * Math.sin(2 * Math.PI * t));
      const v = cordicVector(x, y, S);
      const want = Math.atan2(y, x) / (2 * Math.PI), got = v.turn, diff = Math.abs(((got - want + 0.5) % 1 + 1) % 1 - 0.5);
      expect(diff).toBeLessThan(2.5 * 2 ** -S.z + 2 ** -S.n / 2);
      expect(Math.abs(v.mag / k - Math.hypot(x, y))).toBeLessThan(12);
    }
  });
  it('the angle ends near 0 rotating, and y near 0 vectoring', () => {
    const r = cordicRun({ x: 5000, y: 0, z: 3000 }, S, 'rotate');
    expect(Math.abs(r.z)).toBeLessThanOrEqual(atanTable(S)[S.n - 1] + S.n);
    const v = cordicRun({ x: 5000, y: 3000, z: 0 }, S, 'vector');
    expect(Math.abs(v.y)).toBeLessThan(8);
  });
});

describe('the gates', () => {
  it('the shifter keeps the sign', () => {
    const d = arithShifter(8, 3), f = d.spec!;
    expect(f([0xf0, 2])).toEqual([0xfc]);
    expect(f([0x70, 2])).toEqual([0x1c]);
  });
  it('the pipeline equals the model every clock, on every angle a word can hold', () => {
    const def = cordicPipeline(SMALL), sim = new BitSim(flatten(def)), m = new CordicPipe(SMALL);
    const set = (n: string, v: number) => sim.setInput(n, [v]);
    const X = Math.round(2 ** 9 / cordicStretch(SMALL.n));
    for (const n of ['x', 'y', 'z', 'rotate']) set(n, 0);
    sim.cycle();
    m.edge({ x: 0, y: 0, z: 0 }, false);
    for (let n = 0; n < SMALL.n + 2; n++) { sim.cycle(); m.edge({ x: 0, y: 0, z: 0 }, false); }
    let u = 0;
    for (const rotate of [true, false]) {
      for (let k = 0; k < 2 ** SMALL.z; k++, u++) {
        const z = signedOf(k, SMALL.z), x = rotate ? X : 300 - (k % 601), y = rotate ? 0 : 300 - ((k * 7) % 601);
        set('x', wordOf(x, SMALL.w)); set('y', wordOf(y, SMALL.w)); set('z', rotate ? k : 0); set('rotate', rotate ? 1 : 0);
        sim.cycle();
        m.edge({ x, y, z: rotate ? z : 0 }, rotate);
        const o = m.out;
        const got = [signedOf(sim.get('xo', 1)[0], SMALL.w), signedOf(sim.get('yo', 1)[0], SMALL.w), signedOf(sim.get('zo', 1)[0], SMALL.z)];
        if (got[0] !== o.x || got[1] !== o.y || got[2] !== o.z) expect([u, ...got]).toEqual([u, o.x, o.y, o.z]);
      }
    }
  }, 120_000);
  it('the iterative form equals the model every clock, and takes n clocks', () => {
    const def = cordicIterative(SMALL), sim = new BitSim(flatten(def)), m = new CordicIter(SMALL);
    const set = (n: string, v: number) => sim.setInput(n, [v]);
    for (const n of ['x', 'y', 'z', 'rotate', 'start']) set(n, 0);
    const check = () => {
      expect([signedOf(sim.get('xo', 1)[0], SMALL.w), signedOf(sim.get('yo', 1)[0], SMALL.w), signedOf(sim.get('zo', 1)[0], SMALL.z), sim.get('busy', 1)[0]])
        .toEqual([m.st.x, m.st.y, m.st.z, m.busy ? 1 : 0]);
    };
    sim.cycle();
    m.edge({ x: 0, y: 0, z: 0 }, false, false);
    for (let trial = 0; trial < 60; trial++) {
      const rotate = trial % 3 !== 0, k = (trial * 137 + 11) % 2 ** SMALL.z;
      const inp = { x: rotate ? 300 : 300 - (k % 601), y: rotate ? 0 : 300 - ((k * 7) % 601), z: rotate ? signedOf(k, SMALL.z) : 0 };
      set('x', wordOf(inp.x, SMALL.w)); set('y', wordOf(inp.y, SMALL.w)); set('z', wordOf(inp.z, SMALL.z)); set('rotate', rotate ? 1 : 0); set('start', 1);
      sim.cycle();
      m.edge(inp, rotate, true);
      check();
      set('start', 0);
      let clocks = 0;
      while (m.busy) { sim.cycle(); m.edge(inp, rotate, false); check(); clocks++; if (clocks > 100) throw new Error('stuck'); }
      expect(clocks).toBe(SMALL.n);
      sim.cycle(); m.edge(inp, rotate, false); check(); // and it holds
    }
  }, 60_000);
});
