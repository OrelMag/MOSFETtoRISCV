// Queues and congestion: the model against what can be worked out without it.
import { describe, expect, it } from 'vitest';
import type { FlowSpec } from '../src/comm/queues';
import { bottleneck, chiuJain, CoDel, codelNext, cubicCurve, cubicK, cubicWindow, jain, md1Wait, mg1Wait, mm1kBlock, mm1Quantile, mm1Tail, mm1Wait, queueRun, redBase, renoUtilization, renoWindow } from '../src/comm/queues';

const near = (a: number, b: number, frac: number, msg?: string) => { expect(Math.abs(a - b) / Math.max(Math.abs(b), 1e-12), `${msg ?? ''} ${a} against ${b}`).toBeLessThan(frac); };

describe('a queue by itself', () => {
  it('M/M/1 waits ρ / (1 − ρ), and M/D/1 half of it', () => {
    for (const rho of [0.3, 0.5, 0.7, 0.9]) {
      near(queueRun(rho, 400000, { seed: 3 }).meanWait, mm1Wait(rho), 0.05, `exp ρ ${rho}`);
      near(queueRun(rho, 400000, { service: 'fixed', seed: 4 }).meanWait, md1Wait(rho), 0.05, `fixed ρ ${rho}`);
    }
  });
  it('Pollaczek-Khinchine covers both, and a service of 0 or 2 (cs² = 1) waits as M/M/1', () => {
    expect(mg1Wait(0.7, 1)).toBeCloseTo(mm1Wait(0.7), 12);
    expect(mg1Wait(0.7, 0)).toBeCloseTo(md1Wait(0.7), 12);
    near(queueRun(0.7, 400000, { service: 'two', seed: 5 }).meanWait, mg1Wait(0.7, 1), 0.05);
  });
  it('Little: the mean number in the system is the rate times the mean time in it', () => {
    const r = queueRun(0.8, 300000, { seed: 6 });
    near(r.meanInSystem, 0.8 * (r.meanWait + 1), 0.03);
    near(r.utilization, 0.8, 0.02);
  });
  it('the tail is exponential', () => {
    const rho = 0.9, r = queueRun(rho, 800000, { seed: 7 });
    near(mm1Tail(rho, mm1Quantile(rho, 0.01)), 0.01, 1e-9);
    near(r.p99, mm1Quantile(rho, 0.01), 0.12, 'p99');
  });
  it('M/M/1/K drops what its formula says', () => {
    for (const [rho, K] of [[0.8, 5], [1, 10], [1.5, 8]] as const) {
      const r = queueRun(rho, 400000, { K, seed: 8 });
      near(r.dropped / r.arrivals, mm1kBlock(rho, K), 0.05, `ρ ${rho} K ${K}`);
    }
  });
});

describe('additive increase, multiplicative decrease', () => {
  it('AIMD converges to fair from anywhere; AIAD and MIMD keep the difference or the ratio', () => {
    const end = (k: 'aimd' | 'aiad' | 'mimd') => { const s = chiuJain(70, 5, k, 1500).slice(-200); return jain([s.reduce((a, c) => a + c.x, 0), s.reduce((a, c) => a + c.y, 0)]); };
    expect(end('aimd')).toBeGreaterThan(0.999);
    expect(end('aiad')).toBeLessThan(0.9);
    expect(end('mimd')).toBeLessThan(0.7);
  });
  it('jain is 1 for equals and 1 / n for one taking all', () => {
    expect(jain([3, 3, 3])).toBeCloseTo(1, 12);
    expect(jain([1, 0, 0, 0])).toBeCloseTo(0.25, 12);
  });
});

describe('the disciplines\' rules', () => {
  it('RED rises in a line between its thresholds', () => {
    expect(redBase(4, 5, 15, 0.1)).toBe(0);
    expect(redBase(10, 5, 15, 0.1)).toBeCloseTo(0.05, 12);
    expect(redBase(15, 5, 15, 0.1)).toBe(1);
  });
  it('CoDel\'s next drop comes interval / √count later', () => {
    expect(codelNext(0, 100, 1)).toBe(100);
    expect(codelNext(0, 100, 4)).toBe(50);
  });
  it('CoDel\'s dequeue, RFC 8289: nothing for an interval, a drop, then 100, 100 / √2, 100 / √3 later; below the target it stops; soon after, it resumes from the drops of the last spell', () => {
    const c = new CoDel(5, 100), drops: number[] = [];
    for (let t = 1; t <= 400; t++) if (c.verdict(10, t, 50)) drops.push(t);
    expect(drops[0]).toBe(101);
    expect(drops[1]).toBeCloseTo(201, -1);
    expect(drops[2] - drops[1]).toBeCloseTo(100 / Math.SQRT2, -1);
    expect(drops[3] - drops[2]).toBeCloseTo(100 / Math.sqrt(3), -1);
    expect(c.verdict(1, 401, 50)).toBe(false);
    expect(c.dropping).toBe(false);
    const n = c.count, last = c.lastCount;
    for (let t = 402; t <= 520; t++) c.verdict(10, t, 50);
    expect(c.dropping).toBe(true);
    expect(c.count).toBeGreaterThanOrEqual(n - last > 1 ? n - last : 1);
    expect(c.count).toBeLessThan(n + 3);
    expect(new CoDel(5, 100).verdict(10, 1, 1)).toBe(false);
  });
});

describe('the sawtooth', () => {
  const L = (buf: number) => bottleneck({ mbps: 10, bufferPkts: buf }, [{ cc: 'reno', rttMs: 100 }], 240, 60);
  const BDP = (10e6 * 0.1) / (1500 * 8); // 83.3 packets
  it('fills the link with one BDP of buffer, and runs near ¾ with next to none', () => {
    expect(L(Math.ceil(BDP)).utilization).toBeGreaterThan(0.98);
    expect(renoUtilization(100, 0)).toBeCloseTo(0.75, 12);
    expect(renoUtilization(100, 100)).toBe(1);
    for (const B of [4, 20, 40]) near(L(B).utilization, renoUtilization(BDP, B), 0.05, `B ${B}`);
  });
  it('a queue longer than a BDP adds delay and no throughput', () => {
    const a = L(Math.ceil(BDP)), b = L(Math.ceil(4 * BDP));
    expect(b.utilization).toBeGreaterThan(0.99);
    expect(b.meanDelayMs).toBeGreaterThan(3 * a.meanDelayMs);
    expect(b.maxQueue).toBeLessThanOrEqual(Math.ceil(4 * BDP));
  });
});

describe('windows under loss', () => {
  // CUBIC's curve is flat near its old maximum, so a window that overshot in slow start comes down by about a packet a cycle: the closed form is the steady state, a long way in.
  const run = (cc: 'reno' | 'cubic', p: number, rtt: number) => bottleneck({ mbps: 40, bufferPkts: 100000, lossEvery: Math.round(1 / p) }, [{ cc, rttMs: rtt * 1000, pureCubic: true }], 3000, 2600).meanCwnd[0];
  it('Reno keeps Mathis\'s √(3 / 2p)', () => {
    for (const p of [1e-3, 1e-4]) near(run('reno', p, 0.1), renoWindow(p), 0.08, `p ${p}`);
  });
  it('CUBIC keeps RFC 9438\'s average', () => {
    for (const p of [1e-3, 1e-4]) near(run('cubic', p, 0.1), cubicWindow(p, 0.1), 0.1, `p ${p}`);
  });
  it('the cubic curve returns to its old maximum at K', () => {
    expect(cubicCurve(cubicK(100), 100)).toBeCloseTo(100, 9);
    expect(cubicCurve(0, 100)).toBeCloseTo(70, 9);
  });
});

describe('CUBIC beyond its pure curve', () => {
  it('its Reno-friendly region holds it at or above the pure curve on a small window, and fast convergence gives way to a newcomer', () => {
    const go = (pureCubic: boolean) => bottleneck({ mbps: 100, bufferPkts: 100000, lossEvery: 100 }, [{ cc: 'cubic', rttMs: 10, pureCubic }], 300, 200).meanCwnd[0];
    expect(go(false)).toBeGreaterThan(go(true) * 1.05);
    const two = bottleneck({ mbps: 20, bufferPkts: 170 }, [{ cc: 'cubic', rttMs: 50 }, { cc: 'cubic', rttMs: 50, startS: 20 }], 600, 300);
    expect(two.jain).toBeGreaterThan(0.95);
  });
});

describe('sharing', () => {
  it('Reno flows of equal RTT share equally; shorter RTT wins', () => {
    const a = bottleneck({ mbps: 20, bufferPkts: 170 }, [{ cc: 'reno', rttMs: 100 }, { cc: 'reno', rttMs: 100, startS: 5 }], 300, 100);
    expect(a.jain).toBeGreaterThan(0.97);
    const b = bottleneck({ mbps: 20, bufferPkts: 170 }, [{ cc: 'reno', rttMs: 25 }, { cc: 'reno', rttMs: 100 }], 300, 100);
    expect(b.goodputMbps[0]).toBeGreaterThan(1.5 * b.goodputMbps[1]);
  });
});

describe('active queue management', () => {
  const big = 800;
  const run = (aqm: 'tail' | 'red' | 'codel' | 'fq', flows: FlowSpec[] = [{ cc: 'cubic', rttMs: 50 }]) => bottleneck({ mbps: 10, bufferPkts: big, aqm, pingMs: 20 }, flows, 120, 30);
  it('a large tail-drop buffer fills: the delay is the buffer', () => {
    const r = run('tail');
    expect(r.pingP95Ms).toBeGreaterThan(500);
    expect(r.utilization).toBeGreaterThan(0.98);
  });
  it('CoDel holds the delay near its target, with the link still busy', () => {
    const r = run('codel');
    expect(r.pingMeanMs).toBeLessThan(60);
    expect(r.utilization).toBeGreaterThan(0.75);
  });
  it('RED holds it well under the buffer, near its thresholds', () => {
    const r = run('red');
    expect(r.pingP95Ms).toBeLessThan(0.65 * big * 1.2);
  });
  it('fair queueing gives a sparse packet its turn among a few flows, and equal shares', () => {
    const r = run('fq', [{ cc: 'cubic', rttMs: 50 }, { cc: 'reno', rttMs: 20 }, { cc: 'cubic', rttMs: 200 }]);
    expect(r.pingP95Ms).toBeLessThan(10 * 1.2);
    expect(r.jain).toBeGreaterThan(0.97);
  });
});

describe('ECN', () => {
  it('marks in place of drops: no data lost, the same delay, the same throughput', () => {
    const a = bottleneck({ mbps: 10, bufferPkts: 800, aqm: 'codel', pingMs: 20 }, [{ cc: 'cubic', rttMs: 50 }], 120, 30);
    const b = bottleneck({ mbps: 10, bufferPkts: 800, aqm: 'codel', pingMs: 20 }, [{ cc: 'cubic', rttMs: 50, ecn: true }], 120, 30);
    expect(a.drops).toBeGreaterThan(0);
    expect(b.drops).toBe(0);
    expect(b.marks).toBeGreaterThan(0);
    near(b.utilization, a.utilization, 0.1);
    expect(Math.abs(b.pingMeanMs - a.pingMeanMs)).toBeLessThan(3);
  });
});

describe('BBR', () => {
  it('alone, finds the link and keeps the queue near one BDP or less', () => {
    const r = bottleneck({ mbps: 10, bufferPkts: 800, pingMs: 20 }, [{ cc: 'bbr', rttMs: 100 }], 120, 30);
    expect(r.utilization).toBeGreaterThan(0.85);
    expect(r.meanQueue).toBeLessThan(1.2 * r.bdpPkts);
    expect(r.drops).toBe(0);
  });
  it('does not read random loss as congestion, where Reno collapses as Mathis says', () => {
    const b = bottleneck({ mbps: 100, bufferPkts: 2000, lossP: 0.01 }, [{ cc: 'bbr', rttMs: 100 }], 60, 15);
    const r = bottleneck({ mbps: 100, bufferPkts: 2000, lossP: 0.01 }, [{ cc: 'reno', rttMs: 100 }], 60, 15);
    expect(b.goodputMbps[0]).toBeGreaterThan(70);
    near(r.goodputMbps[0], (renoWindow(0.01) * 1500 * 8) / 0.1 / 1e6, 0.25, 'Mathis');
  });
  it('on a shallow buffer takes most from CUBIC; on a deep one does not', () => {
    const f = [{ cc: 'bbr' as const, rttMs: 50 }, { cc: 'cubic' as const, rttMs: 50 }];
    const shallow = bottleneck({ mbps: 20, bufferPkts: 20 }, f, 180, 60), deep = bottleneck({ mbps: 20, bufferPkts: 800 }, f, 180, 60);
    expect(shallow.goodputMbps[0]).toBeGreaterThan(2 * shallow.goodputMbps[1]);
    expect(deep.goodputMbps[0] / deep.goodputMbps[1]).toBeLessThan(shallow.goodputMbps[0] / shallow.goodputMbps[1]);
  });
});
