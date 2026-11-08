// Cellular's models against independent statements: lattice geometry computed by measuring distances, the harmonic-number law, zero-forcing's mean, the resource grid's printed sizes.
import { describe, expect, it } from 'vitest';
import { channelOverlap, clusterOf, CLUSTERS, cpUs, crossingM, elementsPerMs, gramInverseDiag, gridMbps, handover, harmonic, hexGrid, LTE_RBS, rbKhz, reachKm, reuseRatio, reuseSweep, SCHED_SEED, SCHED_SLOTS, schedule, sirAt, sirClosedDb, slotMs, zfMeanSnr, zfRates, type C } from '../src/phys/cellular';
import { rng } from '../src/phys/line';
import { fsplDb } from '../src/phys/radio';
import { tick as yieldTick } from './yieldtick';

describe('reuse', () => {
  it('cluster sizes are i² + ij + j²', () => {
    const made = new Set<number>();
    for (let i = 0; i <= 5; i++) for (let j = 0; j <= i; j++) made.add(clusterOf(i, j));
    for (const k of CLUSTERS) expect(made.has(k)).toBe(true);
    expect(made.has(2)).toBe(false); expect(made.has(5)).toBe(false);
  });
  it('the colouring is real: nearest co-channel cells are exactly √(3K) away, six of them', () => {
    for (const k of CLUSTERS.filter((c) => c > 1)) {
      const cells = hexGrid(14, k), c0 = cells.find((c) => c.q === 0 && c.r === 0)!;
      const same = cells.filter((c) => c !== c0 && c.colour === c0.colour).map((c) => Math.hypot(c.x, c.y)).sort((a, b) => a - b);
      expect(same[0]).toBeCloseTo(reuseRatio(k), 6);
      expect(same[5]).toBeCloseTo(reuseRatio(k), 6);
      expect(same[6]).toBeGreaterThan(reuseRatio(k) + 0.01);
      expect(new Set(cells.map((c) => c.colour)).size).toBe(k);
    }
  });
  it('at a cell corner the SIR on the grid is near the closed form', () => {
    for (const [k, n] of [[7, 4], [3, 3.5], [12, 4]] as const) {
      const cells = hexGrid(10, k), s = sirAt(cells, 0.0001, 0.9999, n), db = 10 * Math.log10(s.sir), want = sirClosedDb(k, n);
      expect(db).toBeLessThan(want);
      expect(want - db).toBeLessThan(3);
    }
  });
  it('K = 7, n = 4 is the textbook 18.7 dB', () => {
    expect(sirClosedDb(7, 4)).toBeCloseTo(18.66, 1);
  });
  it('larger clusters: better SIR, less spectrum per cell; with these numbers K = 1 carries the most', () => {
    const a = reuseSweep(1, 3.5, 800), b = reuseSweep(3, 3.5, 800), c = reuseSweep(7, 3.5, 800);
    expect(c.edgeDb).toBeGreaterThan(b.edgeDb); expect(b.edgeDb).toBeGreaterThan(a.edgeDb);
    expect(a.perCell).toBeGreaterThan(b.perCell); expect(b.perCell).toBeGreaterThan(c.perCell);
  });
});

describe('the resource grid', () => {
  it('LTE: 100 blocks of 180 kHz fill 18 of 20 MHz; 1 ms has 14 symbols', () => {
    expect(rbKhz()).toBe(180);
    for (const [mhz, rbs] of LTE_RBS) expect((rbs * rbKhz()) / 1000).toBeLessThanOrEqual(mhz);
    expect(elementsPerMs(100)).toBe(16800);
  });
  it('a 20 MHz carrier at 64-QAM ¾ and 25 % overhead is on the order of 60 Mb/s, and 2 × 2 doubles it', () => {
    const r = gridMbps(100, 4.5);
    expect(r).toBeCloseTo(56.7, 1);
    expect(gridMbps(100, 4.5, 0.25, 0, 2)).toBeCloseTo(2 * r, 6);
  });
  it('5G numerology halves slot and cyclic prefix with each µ', () => {
    expect(slotMs(0)).toBe(1); expect(slotMs(3)).toBe(0.125);
    expect(cpUs(1)).toBeCloseTo(cpUs(0) / 2, 6);
    expect(rbKhz(3)).toBe(1440);
    // a quarter of the blocks at µ = 2 and four times the symbols a ms: the same elements
    expect(elementsPerMs(100, 0)).toBe(elementsPerMs(25, 2));
    expect(gridMbps(100, 4.5, 0.25, 0)).toBeCloseTo(gridMbps(25, 4.5, 0.25, 2), 9);
  });
});

describe('schedulers', () => {
  it('the best of n Rayleigh users has H_n times the mean SNR', () => {
    const u = rng(7);
    for (const n of [2, 4, 16]) {
      let s = 0;
      const T = 40000;
      for (let t = 0; t < T; t++) { let m = 0; for (let i = 0; i < n; i++) m = Math.max(m, -Math.log(1 - u())); s += m; }
      expect((s / T) / harmonic(n)).toBeGreaterThan(0.97); expect((s / T) / harmonic(n)).toBeLessThan(1.03);
    }
    expect(harmonic(1)).toBe(1); expect(harmonic(2)).toBe(1.5);
  });
  it('equal users: round robin earns the single-user rate; both opportunistic schedulers earn more, the same', async () => {
    const m = [10, 10, 10, 10, 10, 10, 10, 10];
    const rr = schedule('rr', m, 30000, 1), mx = schedule('max', m, 30000, 2), pf = schedule('pf', m, 30000, 3);
    expect(mx.total).toBeGreaterThan(1.4 * rr.total);
    expect(pf.total / mx.total).toBeGreaterThan(0.97);
    expect(mx.jain).toBeGreaterThan(0.98);
    await yieldTick();
  });
  it('unequal users: max-rate starves the far one, round robin wastes, proportional fair gives each its time and gains', () => {
    const m = [20, 20, 5, 0];
    const rr = schedule('rr', m, 30000, 1), mx = schedule('max', m, 30000, 2), pf = schedule('pf', m, 30000, 3);
    expect(mx.total).toBeGreaterThan(pf.total); expect(pf.total).toBeGreaterThan(rr.total);
    expect(mx.perUser[3]).toBeLessThan(0.1 * pf.perUser[3]);
    for (let i = 0; i < 4; i++) expect(pf.perUser[i]).toBeGreaterThan(rr.perUser[i]);
    for (const v of pf.served) expect(v / 30000).toBeGreaterThan(0.2);
    expect(pf.jain).toBeGreaterThan(mx.jain);
  });
});

describe('handover', () => {
  const o = { sites: [0, 1000, 2000], speedMs: 20, n: 3.5, shadowDb: 4, corrM: 50, hystDb: 3, tttMs: 320, seed: 3, lengthM: 2000, refDbm: -30 };
  it('with no shadowing, the crossing is at the closed form', () => {
    const r = handover({ ...o, shadowDb: 0, tttMs: 0, hystDb: 3 });
    expect(r.events.length).toBe(2);
    const want = crossingM(1000, 3.5, 3);
    expect(Math.abs(r.events[0].m - want)).toBeLessThanOrEqual(10);
    expect(want).toBeGreaterThan(500);
  });
  it('more hysteresis means fewer handovers, on average over seeds', () => {
    const count = (h: number, t: number) => { let c = 0; for (let s = 0; s < 40; s++) c += handover({ ...o, hystDb: h, tttMs: t, seed: s }).events.length; return c; };
    expect(count(0, 0)).toBeGreaterThan(count(3, 0));
    expect(count(3, 0)).toBeGreaterThan(count(6, 0));
    expect(count(0, 0)).toBeGreaterThan(count(0, 640));
    // at least one handover a road crossing two boundaries, once it can trigger at all
    expect(count(6, 320)).toBeGreaterThanOrEqual(40);
  });
  it('the ping-pong count: 0 → 1 → 0 within the window counts; a straight road does not', () => {
    const r = handover({ ...o, shadowDb: 0, tttMs: 0, hystDb: 3 });
    expect(r.pingPongs).toBe(0);
    let tot = 0;
    for (let s = 0; s < 20; s++) {
      const q = handover({ ...o, hystDb: 0, tttMs: 0, shadowDb: 6, seed: s });
      let want = 0, prev = 0;
      q.events.forEach((e, i) => { const from = i ? q.events[i - 1] : null, back = i >= 2 ? q.events[i - 2].to : 0; if (from && (e.m - from.m) / o.speedMs < 5 && back === e.to) want++; prev = e.to; });
      void prev;
      expect(q.pingPongs).toBe(want);
      tot += want;
    }
    expect(tot).toBeGreaterThan(20);
  });
});

describe('many antennas', () => {
  it('the Gram inverse: known matrices', () => {
    const I: C[][] = [[[1, 0], [0, 0]], [[0, 0], [1, 0]]];
    expect(gramInverseDiag(I)).toEqual([1, 1]);
    const two: C[][] = [[[2, 0]], ];
    expect(gramInverseDiag(two)[0]).toBeCloseTo(0.25, 9);
    const m: C[][] = [[[1, 0], [1, 0]], [[1, 0], [-1, 0]]];   // Gram 2I
    expect(gramInverseDiag(m)[0]).toBeCloseTo(0.5, 9);
  });
  it('zero-forcing: mean SNR is ρ(M − K + 1) / K', async () => {
    for (const [K, M] of [[2, 4], [4, 16], [4, 64]] as const) {
      const z = zfRates(K, M, 10, 4000, K + M);
      expect(z.meanSnr / zfMeanSnr(K, M, 10)).toBeGreaterThan(0.95);
      expect(z.meanSnr / zfMeanSnr(K, M, 10)).toBeLessThan(1.05);
      await yieldTick();
    }
  });
  it('more antennas, more rate; the gain per doubling of M is about K b/s/Hz in the large', () => {
    const a = zfRates(4, 32, 10, 1000, 1).sumRate, b = zfRates(4, 64, 10, 1000, 2).sumRate;
    expect(b - a).toBeGreaterThan(3); expect(b - a).toBeLessThan(5);
  });
  it('channels turn orthogonal as √M grows', () => {
    const a = channelOverlap(16, 4000, 1), b = channelOverlap(256, 2000, 2);
    expect(a / (Math.sqrt(Math.PI) / (2 * Math.sqrt(16)))).toBeGreaterThan(0.95);
    expect(a / (Math.sqrt(Math.PI) / (2 * Math.sqrt(16)))).toBeLessThan(1.05);
    expect(a / b).toBeGreaterThan(3.5); expect(a / b).toBeLessThan(4.5);
  });
  it('reach: 20 dB more budget is ten times the distance; matches the dB form', () => {
    expect(reachKm(140, 3.5) / reachKm(120, 3.5)).toBeCloseTo(10, 6);
    expect(fsplDb(reachKm(140, 28), 28)).toBeCloseTo(140, 6);
  });
});

describe('the figures the chapter and its codex quote', () => {
  it('reuse table at n = 3.5 (the reuse panel\'s default) and the handover crossing', () => {
    const r = [1, 3, 7].map((k) => reuseSweep(k, 3.5, 1500));
    expect(r.map((x) => Math.round(x.medianDb))).toEqual([4, 14, 21]);
    expect(r.map((x) => x.perCell.toFixed(2))).toEqual(['2.67', '1.79', '1.09']);
    expect((r[0].perCell / r[2].perCell).toFixed(1)).toBe('2.5');
    expect(Math.round(crossingM(1000, 3.5, 3))).toBe(549);
    expect(sirClosedDb(7, 4).toFixed(1)).toBe('18.7');
  });
  it('eight users at 10 dB, the scheduler panel\'s own run (SCHED_SLOTS, SCHED_SEED)', () => {
    const m = Array<number>(8).fill(10);
    const t = (['rr', 'pf', 'max'] as const).map((p) => schedule(p, m, SCHED_SLOTS, SCHED_SEED).total.toFixed(2));
    expect(t).toEqual(['2.91', '4.61', '4.68']);
    expect(harmonic(8).toFixed(2)).toBe('2.72');
  });
});
