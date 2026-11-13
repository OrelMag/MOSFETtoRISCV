// ENIAC's decade ring counter: the counting rule against the library's own ring counter on the gate simulator, decimal
// counting with the carry over 0–99, each stage an Eccles–Jordan holding its bit, and the drawing following the state.
import { describe, expect, it } from 'vitest';
import { ringCounter } from '../src/lib/seqparts';
import { ECCLES_JORDAN } from '../src/lib/tubes';
import { simulate } from '../src/sim/harness';
import type { Sim } from '../src/sim/sim';
import { ENIAC } from '../src/phys/triode';
import {
  ACCUMULATORS, DIGITS, PITCH, RING_TRIODES, STAGES, TUBES_PER_DIGIT, UNIT_L, after, oneHot, pulse, stageX, zero,
} from '../src/widgets/eniac3dgeom';
import { eniacModel } from '../src/widgets/eniac3dkit';

const out = (s: Sim, p: string) => { let v = 0; s.getBits(s.design.root.ports[p]).forEach((b: number, i: number) => { if (b === 1) v |= 1 << i; }); return v; };
const set = (s: Sim, v: Record<string, number>) => { for (const [k, x] of Object.entries(v)) s.setInput(k, x); s.settle(); };
const tick = (s: Sim) => { set(s, { clk: 1 }); set(s, { clk: 0 }); };

describe('ENIAC\'s decade ring', () => {
  it('a decade is the library\'s ringCounter(10): the one-hot stage after every pulse is the model\'s digit', () => {
    const s = simulate(ringCounter(STAGES));
    set(s, { init: 1, clk: 0 }); tick(s); set(s, { init: 0 });
    let d = zero(1);
    for (let i = 0; i < 25; i++) {
      expect(out(s, 'q'), `pulse ${i}`).toBe(1 << d.digits[0]);
      expect(oneHot(d.digits[0]).map((b, k) => (b ? 1 << k : 0)).reduce((a, b) => a + b)).toBe(out(s, 'q'));
      tick(s); d = pulse(d);
    }
  });
  it('two decades count 0–99 in decimal, the tens stepping exactly when the units pass nine', () => {
    let d = zero();
    for (let n = 1; n < 200; n++) {
      const before = d.digits[0];
      d = pulse(d);
      expect(d.digits[1] * 10 + d.digits[0]).toBe(n % 100);
      expect(d.carried[1]).toBe(before === 9);
    }
    expect(after(57).digits).toEqual([7, 5]);
  });
  it('each stage is an Eccles–Jordan flip-flop: set, it holds its 1 with the inputs let go; reset, its 0', () => {
    const s = simulate(ECCLES_JORDAN);
    set(s, { set: 1, reset: 0 }); set(s, { set: 0 });
    expect([out(s, 'q'), out(s, 'nq')]).toEqual([1, 0]);
    set(s, { reset: 1 }); set(s, { reset: 0 });
    expect([out(s, 'q'), out(s, 'nq')]).toEqual([0, 1]);
  });
  it('the sourced counts: ten stages of twin triodes, 36 tubes a digit, 20 accumulators of 10 digits, within ENIAC\'s tubes', () => {
    expect(RING_TRIODES).toBe(20);
    expect(TUBES_PER_DIGIT).toBe(36);
    expect(ACCUMULATORS * DIGITS * TUBES_PER_DIGIT).toBeLessThan(ENIAC.tubes);
    expect(stageX(STAGES - 1) - stageX(0) + PITCH).toBeLessThan(UNIT_L); // the ring fits the 114.5 cm unit
  });
  it('the drawing: one lit neon per decade at its digit, the carry wire lit only on a carrying pulse, a tour', () => {
    const d = after(39), m = eniacModel({ d, pulsing: false });
    const lit = m.items.filter((i) => i.name?.startsWith('neon:') && i.mat.emit && i.mat.label?.startsWith('neon lamp')).map((i) => [i.group, i.name]);
    expect(lit).toEqual([['units decade', 'neon: stage 9'], ['tens decade', 'neon: stage 3']]);
    const carry = (p: boolean, dd = pulse(d)) => eniacModel({ d: dd, pulsing: p }).items.find((i) => i.name === 'carry')!.mat.emit;
    expect(carry(true)).toBeTruthy();
    expect(carry(false)).toBeFalsy();
    expect(carry(true, pulse(after(40)))).toBeFalsy(); // 40 → 41 carries nothing
    expect(m.items.filter((i) => i.name?.startsWith('6SN7: stage') && i.info).length).toBe(2 * STAGES);
    expect((m.beats ?? []).length).toBeGreaterThanOrEqual(4);
    expect(eniacModel({ d, pulsing: false }, 'flat').items.length).toBeGreaterThan(0);
  });
});
