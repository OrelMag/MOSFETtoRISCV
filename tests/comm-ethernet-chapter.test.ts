// Chapter 48's typed numbers (the computed ones come from the code and need no pin), its shape, and the experiments behind the widgets.
import { describe, expect, it } from 'vitest';
import { chEthernet } from '../src/chapters/ch-comm-ethernet';
import { chapterById } from '../src/chapters';
import { frameBitTimes, GAP_CLOCKS, LINK_MBPS, maxCableMetres, SLOT_CLOCKS } from '../src/comm/mac';
import { addrOf, maxThroughput, runLoad, runPair, seedsFor } from '../src/comm/macexp';
import { lfsrNext } from '../src/comm/mac';
import { MIN_FRAME } from '../src/comm/ethframe';

describe('chapter 48 typed numbers', () => {
  it('nine steps, building on the UART and error chapters, with three recap questions', () => {
    expect(chEthernet.num).toBeGreaterThan(chapterById('uart')!.num);
    expect(chEthernet.steps.length).toBe(9);
    expect(chEthernet.builds).toEqual(['pcie', 'uart', 'wire', 'errors']);
    expect(chEthernet.recap!.check!.length).toBe(3);
  });
  it('step 1 and 2: a minimum frame is 576 bit times, 2 304 clocks, 9.1 µs at 63 Mb/s; payload is 55 % of the time for minimum frames and 98 % for maximum ones', () => {
    expect(frameBitTimes(MIN_FRAME)).toBe(576);
    expect(576 * 4).toBe(2304);
    expect(LINK_MBPS).toBeCloseTo(63.29, 2);
    expect(576 / LINK_MBPS).toBeCloseTo(9.1, 1);
    expect((8 * 46) / (576 + 96)).toBeCloseTo(0.55, 2);
    expect((8 * 1500) / (frameBitTimes(1518) + 96)).toBeCloseTo(0.975, 3);
  });
  it('step 4: the gap is 96 bit times = 384 clocks = 1.52 µs', () => {
    expect(GAP_CLOCKS).toBe(384);
    expect(96 / LINK_MBPS).toBeCloseTo(1.52, 2);
  });
  it('step 6: 512 bit times are 51.2 µs at 10 Mb/s, 5 065 m of cable at 0.66 c, 507 m at 100 Mb/s, 51 m at 1 Gb/s; 8.09 µs and 2 048 clocks here', () => {
    expect(512 / 10).toBeCloseTo(51.2, 1);
    expect(Math.round(maxCableMetres(512, 0.66, 10))).toBe(5065);
    expect(Math.round(maxCableMetres(512, 0.66, 100))).toBe(507);
    expect(Math.round(maxCableMetres(512, 0.66, 1000))).toBe(51);
    expect(512 / LINK_MBPS).toBeCloseTo(8.09, 2);
    expect(SLOT_CLOCKS).toBe(2048);
  });
  it('step 6: with B starting one clock before A\'s signal reaches it, A sees the collision up to a delay of 1 152 clocks and not beyond', () => {
    const ok = runPair(1152, 1151, 3000, 6000), late = runPair(1153, 1152, 3000, 6000);
    expect(ok.detectA).toBeGreaterThan(0);
    expect(ok.detectA).toBeLessThan(2304);
    expect(late.detectA).toBe(-1);
    expect(late.sentA).toBe(1);
  });
  it('step 5: two stations that start together on a short cable both detect the collision one cable delay after starting', () => {
    const t = runPair(24, 0, 400, 7000);
    expect([t.detectA, t.detectB]).toEqual([24, 24]);
    expect(t.drawsA.length).toBe(1);
    expect(t.drawsA[0]).not.toBe(t.drawsB[0]);
    expect([t.goodA, t.goodB]).toEqual([1, 1]);
  });
});

describe('backoff and the experiments', () => {
  it('the LFSR has period 1 023 from any seed that is not all ones, and the seeds of a segment are distinct and valid', () => {
    let q = 1, n = 0;
    do { q = lfsrNext(q); n++; } while (q !== 1 && n < 5000);
    expect(n).toBe(1023);
    for (const n2 of [2, 4, 8]) {
      const s = seedsFor(n2);
      expect(new Set(s).size).toBe(n2);
      for (const v of s) { expect(v).toBeGreaterThan(0); expect(v).toBeLessThan(1023); }
    }
    expect(addrOf(0)).toEqual([2, 0, 0, 0, 0, 1]);
  });
  it('a light load goes through (delivered about equals offered) and the same seed gives the same run', () => {
    const a = runLoad({ n: 4, payload: 46, load: 0.2, clocks: 200000, seed: 1 }), b = runLoad({ n: 4, payload: 46, load: 0.2, clocks: 200000, seed: 1 });
    expect(a).toEqual(b);
    expect(a.throughput).toBeGreaterThan(0.1);
    expect(a.throughput).toBeLessThan(maxThroughput(46));
    expect(a.drops).toBe(0);
  });
  it('past saturation the throughput stays below the limit and, with two stations, one of them takes nearly every frame (the capture effect)', () => {
    const r = runLoad({ n: 2, payload: 46, load: 1e6, clocks: 400000, seed: 1 });
    expect(r.throughput).toBeLessThan(maxThroughput(46));
    expect(r.throughput).toBeGreaterThan(0.6);
    const total = r.sent[0] + r.sent[1];
    expect(Math.max(...r.sent) / total).toBeGreaterThan(0.9);
    expect(r.collisions).toBeGreaterThan(5);
  });
  it('at a heavier load more stations mean more collisions per frame', () => {
    const two = runLoad({ n: 2, payload: 46, load: 1.5, clocks: 300000, seed: 3 }), eight = runLoad({ n: 8, payload: 46, load: 1.5, clocks: 300000, seed: 3 });
    const cpf = (r: typeof two) => r.collisions / Math.max(1, r.sent.reduce((a, b) => a + b, 0));
    expect(cpf(eight)).toBeGreaterThan(cpf(two));
  });
});
