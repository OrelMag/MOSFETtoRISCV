// Chapter 47's repeat-request models: seeded simulations held to the closed forms (utilization against the
// bandwidth-delay product), the no-loss limits exactly, and the model's invariants.
import { describe, expect, it } from 'vitest';
import { aOf, fullWindow, rttOf, simulate, utilization, type Proto } from '../src/comm/arq';

const near = (x: number, y: number, rel: number) => expect(Math.abs(x - y) / y, `${x} vs ${y}`).toBeLessThan(rel);

describe('without loss', () => {
  it('stop-and-wait delivers one frame a round trip, a window fills the pipe at W = 1 + 2a, and below that it is W / (1 + 2a)', () => {
    for (const a of [0, 1, 4, 9]) {
      const R = rttOf(a);
      expect(simulate('saw', a, 1, 0, 400).u).toBeCloseTo(1 / R, 2);
      for (const proto of ['gbn', 'sr'] as Proto[]) {
        expect(simulate(proto, a, fullWindow(a), 0, 2000).u).toBeGreaterThan(0.99);
        if (R > 2) expect(simulate(proto, a, 2, 0, 2000).u).toBeCloseTo(2 / R, 2);
      }
    }
  });
});

describe('with loss', () => {
  const frames = 60000;
  it('stop-and-wait: (1 - p) / (1 + 2a)', () => {
    for (const [a, p] of [[2, 0.1], [5, 0.2], [1, 0.02]]) near(simulate('saw', a, 1, p, frames / 4, 3).u, utilization('saw', a, 1, p), 0.03);
  });
  it('go-back-N with the window at or above the round trip: (1 - p) / (1 + 2ap), exact', () => {
    for (const [a, W, p] of [[4, 9, 0.05], [4, 9, 0.2], [2, 5, 0.02], [9, 30, 0.05], [0, 1, 0.1]]) near(simulate('gbn', a, W, p, frames, 5 + a).u, utilization('gbn', a, W, p), 0.03);
  });
  it('go-back-N below the round trip: the Stallings form is within 15 % and the simulation is the higher', () => {
    for (const [a, W, p] of [[4, 5, 0.1], [9, 6, 0.1], [4, 3, 0.01], [9, 3, 0.2]]) {
      const u = simulate('gbn', a, W, p, frames, 5 + a).u, f = utilization('gbn', a, W, p);
      near(u, f, 0.15);
      expect(u).toBeGreaterThan(f);
    }
  });
  it('selective repeat reaches 1 - p with a window of three round trips, and falls short of it at one', () => {
    for (const [a, p] of [[4, 0.05], [4, 0.2], [9, 0.01]]) {
      const R = rttOf(a);
      near(simulate('sr', a, 3 * R, p, frames, 6 + a).u, utilization('sr', a, 3 * R, p), 0.04);
      expect(simulate('sr', a, R, p, frames, 6 + a).u).toBeLessThan(0.9 * utilization('sr', a, R, p));
    }
  });
  it('selective repeat beats go-back-N with enough window and some loss; the closed forms are equal at p = 0', () => {
    expect(simulate('sr', 4, 27, 0.1, 40000, 3).u).toBeGreaterThan(simulate('gbn', 4, 27, 0.1, 40000, 3).u);
    expect(utilization('sr', 4, 9, 0)).toBe(utilization('gbn', 4, 9, 0));
  });
  it('is seeded: the same seed gives the same run', () => {
    expect(simulate('gbn', 4, 9, 0.1, 500, 9, 30).events).toEqual(simulate('gbn', 4, 9, 0.1, 500, 9, 30).events);
    expect(simulate('gbn', 4, 9, 0.1, 500, 9).slots).not.toBe(simulate('gbn', 4, 9, 0.1, 500, 10).slots);
  });
  it('counts: every frame is delivered, transmissions are at least the frames', () => {
    const r = simulate('sr', 3, 7, 0.2, 5000, 2);
    expect(r.delivered).toBe(5000);
    expect(r.sent).toBeGreaterThanOrEqual(5000);
    near(r.perFrame, 1 / 0.8, 0.03);
  });
});

describe('the link numbers', () => {
  it('a 1500-byte frame at 63 Mb/s takes 190 us; 10 ms one way is a = 52 and needs 106 frames in flight', () => {
    const a = aOf(10e-3, 1500 * 8, 63e6);
    expect((1500 * 8) / 63e6 * 1e6).toBeCloseTo(190.5, 1);
    expect(a).toBeCloseTo(52.5, 1);
    expect(fullWindow(a)).toBe(106);
  });
});
