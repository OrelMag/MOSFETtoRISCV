// Many carriers: water-filling, greedy loading, the peak and the frequency offset, against what can be worked out without them.
import { describe, expect, it } from 'vitest';
import { equalizerTaps, flatBest, flatPower, leak, loadBits, offsetSirDb, offsetSirMeasured, paprCcdf, paprMeasured, waterFill } from '../src/comm/carriers';
import { rng } from '../src/phys/line';

describe('water-filling', () => {
  it('solves two tones as by hand', () => {
    // floors 1 and 1/2, budget 3: level 2.25, powers 1.25 and 1.75
    const p = waterFill([1, 2], 3);
    expect(p.level).toBeCloseTo(2.25, 12);
    expect(p.power[0]).toBeCloseTo(1.25, 12); expect(p.power[1]).toBeCloseTo(1.75, 12);
    expect(p.total).toBeCloseTo(Math.log2(1 + 1.25) + Math.log2(1 + 3.5), 12);
  });
  it('leaves a tone dry when the level does not reach its floor', () => {
    // floors 1 and 10, budget 2: level 3 on the good tone alone
    const p = waterFill([1, 0.1], 2);
    expect(p.power).toEqual([2, 0]);
    expect(p.level).toBeCloseTo(3, 12);
    expect(p.used).toBe(1);
  });
  it('spends the whole budget and keeps one level', () => {
    const u = rng(5);
    for (let t = 0; t < 200; t++) {
      const g = Array.from({ length: 2 + Math.floor(u() * 30) }, () => 10 ** (4 * u() - 2)), B = 10 ** (3 * u() - 1), p = waterFill(g, B);
      expect(p.power.reduce((a, b) => a + b, 0)).toBeCloseTo(B, 9);
      p.power.forEach((x, i) => { if (x > 0) expect(x + 1 / g[i]).toBeCloseTo(p.level, 9); else expect(1 / g[i]).toBeGreaterThanOrEqual(p.level - 1e-9); });
    }
  });
  it('beats every small move of power and every flat plan', () => {
    const u = rng(9);
    for (let t = 0; t < 100; t++) {
      const g = Array.from({ length: 12 }, () => 10 ** (4 * u() - 2)), B = 10 ** (2 * u()), p = waterFill(g, B);
      expect(p.total + 1e-9).toBeGreaterThanOrEqual(flatPower(g, B).total);
      expect(p.total + 1e-9).toBeGreaterThanOrEqual(flatBest(g, B).total);
      for (let m = 0; m < 30; m++) {
        const a = Math.floor(u() * 12), b = Math.floor(u() * 12), d = Math.min(p.power[a], 0.01 * B * u());
        const q = p.power.slice(); q[a] -= d; q[b] += d;
        const c = q.reduce((s, x, i) => s + Math.log2(1 + g[i] * x), 0);
        expect(c).toBeLessThanOrEqual(p.total + 1e-9);
      }
    }
  });
  it('tends to flat when power is plentiful: the difference is bounded and small', () => {
    const g = [1, 0.5, 2, 0.8, 1.2];
    const low = waterFill(g, 0.5).total - flatPower(g, 0.5).total, high = waterFill(g, 5000).total - flatPower(g, 5000).total;
    expect(high).toBeLessThan(1e-3);
    expect(low).toBeGreaterThan(high);
  });
  it('a gap Γ only moves the floors', () => {
    const g = [3, 1, 0.3], G = 8, a = waterFill(g, 20, G), b = waterFill(g.map((x) => x / G), 20);
    a.power.forEach((p, i) => expect(p).toBeCloseTo(b.power[i], 12));
    expect(a.total).toBeCloseTo(b.total, 12);
  });
});

describe('greedy loading', () => {
  const best = (g: number[], B: number, max: number) => {
    let top = 0;
    const walk = (i: number, left: number, sum: number) => {
      if (i === g.length) { if (sum > top) top = sum; return; }
      for (let b = 0; b <= max; b++) { const e = (2 ** b - 1) / g[i]; if (e > left) break; walk(i + 1, left - e, sum + b); }
    };
    walk(0, B, 0);
    return top;
  };
  it('finds the most bits any allocation can, on small cases', () => {
    const u = rng(21);
    for (let t = 0; t < 300; t++) {
      const g = Array.from({ length: 2 + Math.floor(u() * 4) }, () => 10 ** (3 * u() - 1)), B = 10 ** (2 * u());
      expect(loadBits(g, B, 1, 6).total, `${g} ${B}`).toBe(best(g, B, 6));
    }
  });
  it('stays under the budget, under water-filling\'s rate and within a bit a tone of it', () => {
    const u = rng(22);
    for (let t = 0; t < 100; t++) {
      const g = Array.from({ length: 16 }, () => 10 ** (4 * u() - 1)), B = 10 ** (2 * u() + 1), L = loadBits(g, B, 1, 40), W = waterFill(g, B);
      expect(L.energy).toBeLessThanOrEqual(B);
      expect(L.total).toBeLessThanOrEqual(W.total + 1e-9);
      expect(W.total - L.total).toBeLessThanOrEqual(g.length);
    }
  });
  it('honours the top constellation', () => { expect(loadBits([1e9], 1e9, 1, 15).bits[0]).toBe(15); });
});

describe('what breaks a block of tones', () => {
  it('peak over mean follows its closed form', () => {
    for (const [db, N] of [[8, 64], [10, 64], [9, 256], [11, 256]] as const) {
      const c = paprCcdf(db, N), m = paprMeasured(db, N, 2500, 3 + db + N);
      expect(m, `${db} dB, ${N}`).toBeGreaterThan(c * 0.75 - 0.003);
      expect(m, `${db} dB, ${N}`).toBeLessThan(c * 1.25 + 0.003);
    }
  });
  it('a carrier offset leaks what the closed form says', () => {
    expect(leak(0, 0, 64)).toBe(1);
    expect(leak(3, 0, 64)).toBeCloseTo(0, 12);
    // the leaks of one tone over all tones sum to 1
    for (const e of [0.02, 0.1, 0.3]) { let s = 0; for (let d = 0; d < 64; d++) s += leak(d, e, 64) ** 2; expect(s).toBeCloseTo(1, 10); }
    for (const e of [0.01, 0.05, 0.2]) expect(offsetSirMeasured(e, 256, 4), `ε ${e}`).toBeCloseTo(offsetSirDb(e, 256), 0);
  });
  it('an echo\'s inverse is long; a block of tones divides once a tone', () => {
    expect(equalizerTaps(0.5, 1, 0.01)).toBe(7); // 0.5^7 < 0.01
    expect(equalizerTaps(0.9, 5, 0.01)).toBe(5 * 44);
  });
});
