// Chapter 52's typed numbers, pinned to what they describe; tcpcosts.json held to the bench; the chapter's place.

import { describe, expect, it } from 'vitest';
import { chTcp, MEASURED_MBPS, WIRE_DATA_MBPS } from '../src/chapters/ch-comm-tcp';
import { LINK_MBPS } from '../src/comm/mac';
import { TCP } from '../src/comm/stack/tcp';
import NET from '../src/comm/stack/netcosts.json';
import { TCP_K } from '../src/net/tcp';
import { measureBench, tcpBench } from '../src/net/tcpbench';
import COSTS from '../src/net/tcpcosts.json';
import { runTcp } from '../src/net/tcpsim';
import { mbps, rtoSeries, rttSamples } from '../src/widgets/tcp';
import { chapterById, chapters } from '../src/chapters';
import { tick } from './yieldtick';

describe('chapter 52', () => {
  it('sits between the router and the appendices', () => {
    expect(chTcp.num).toBe(52);
    expect(chapterById('tcp')).toBe(chTcp);
    expect(chapterById('router')!.num).toBe(51);
    for (const c of chapters.filter((x) => x.appendix)) expect(c.num).toBeGreaterThan(53);
  });
  it('the figures in tcpcosts.json are the bench\'s: the wire-speed run', async () => {
    const m = await measureBench(COSTS.fast.bytes, COSTS.fast.o, tick);
    expect(m.clocks).toBe(COSTS.fast.clocks);
    expect(m.fast).toBe(0);
    expect(m.timeouts).toBe(0);
    expect(m.drops).toBe(0);
    expect(m.misses).toBe(0);
    expect(m.console.b).toBe(`received ${COSTS.fast.bytes} bytes, all correct\n`);
    const t = tcpBench(1000);
    expect(t.a.compiled.words.length).toBe(COSTS.words.a);
    expect(TCP.py.split('\n').length).toBe(COSTS.lines);
  }, 120000);
  it('the sawtooth run has fast retransmits, the short queue has timeouts and no fast retransmit: as the text says', () => {
    expect(COSTS.saw.fast).toBeGreaterThan(COSTS.saw.timeouts);
    expect(COSTS.small.fast).toBe(0);
    expect(COSTS.small.timeouts).toBeGreaterThan(0);
    expect(COSTS.fast.misses + COSTS.saw.misses + COSTS.small.misses).toBe(0);
  });
  it('the rates: the data a small segment can carry, and that the CPU is what limits the run', () => {
    expect(WIRE_DATA_MBPS).toBeCloseTo(mbps(64, 142 * 32), 6);
    expect(WIRE_DATA_MBPS).toBeLessThan(LINK_MBPS);
    expect(MEASURED_MBPS).toBeLessThan(WIRE_DATA_MBPS * 0.7);
    expect(1460 / (1460 + 54 + 4 + 8 + 12)).toBeGreaterThan(0.94);
  });
  it('the worked numbers in the text', () => {
    expect((2 ** 32 * 8) / 10e9).toBeCloseTo(3.44, 1);
    expect((1e6 * 8) / 10e6).toBeCloseTo(0.8, 6);
    expect(NET.rtt).toBe(14689);
    expect(TCP_K.RCV / TCP_K.MSS).toBe(8);
    expect((TCP_K.MSS + 54) * 200).toBe(23600);
  });
  it('a queue past the window changes nothing; a longer one up to it costs round trip, as the text says', () => {
    const q = (queue: number) => runTcp({ bytes: 8000, byteClocks: 200, queue, delay: 20000 });
    expect(q(12).doneAt).toBe(q(8).doneAt);
    expect(q(8).drops).toBe(0);
    expect(q(4).drops).toBeGreaterThan(0);
  });
  it('the adaptive timer fires early less often than a fixed one, on a noisy path', () => {
    for (const spread of [30, 60]) {
      const x = rttSamples(60000, spread), { rto } = rtoSeries(x);
      const adaptive = x.filter((r, i) => i > 0 && r > rto[i - 1]).length, fixed = x.filter((r) => r > 78000).length;
      expect(adaptive).toBeLessThan(fixed);
    }
  });
});
