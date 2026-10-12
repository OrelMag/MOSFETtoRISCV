import { describe, expect, it } from 'vitest';
import {
  CMP_MERGE, absValue, demux, eccChannel, encoder, hammingDec, hammingDecodeRef, hammingEnc, hammingEncodeRef, hammingLayout,
  magComparator, parity, popcount, priorityEncoder,
} from '../src/lib';
import { evalOnce, simulate } from '../src/sim/harness';
import { logicDepth } from '../src/sim/stats';
import { checkSpec, corners } from './util';

describe('comparison and coding blocks match their specs', () => {
  const small = [
    CMP_MERGE, magComparator(2), magComparator(4), magComparator(4, true), magComparator(5), magComparator(6, true),
    priorityEncoder(2), priorityEncoder(4), priorityEncoder(8), encoder(2), encoder(4), encoder(8),
    demux(1, 1), demux(2, 1), demux(2, 4), demux(3, 1), popcount(2), popcount(4), popcount(8),
    absValue(4), absValue(8), parity(3), parity(8), hammingEnc(4), hammingEnc(8),
  ];
  for (const d of small) it(d.id, () => checkSpec(d));
  const big = [magComparator(16), magComparator(16, true), magComparator(32, true), priorityEncoder(16), priorityEncoder(32), encoder(16), popcount(16), popcount(32), absValue(32), parity(32), hammingEnc(16), hammingDec(8), hammingDec(16), eccChannel(4), eccChannel(8)];
  for (const d of big) it(d.id, () => checkSpec(d, 300, corners(d)));
});

describe('comparator', () => {
  it('has logarithmic depth, unlike a subtractor', () => {
    expect(logicDepth(magComparator(32))!).toBeLessThan(logicDepth(magComparator(8))! + 12);
  });
});

describe('Hamming SEC-DED', () => {
  it('code layout', () => {
    expect(hammingLayout(4)).toEqual({ r: 3, n: 8, dataPos: [3, 5, 6, 7] });
    expect(hammingLayout(8)).toMatchObject({ r: 4, n: 13 });
    expect(hammingLayout(16)).toMatchObject({ r: 5, n: 22 });
  });
  it('corrects every single flip and detects every double flip (reference)', () => {
    for (let d = 0; d < 256; d++) {
      const c = hammingEncodeRef(d, 8);
      expect(hammingDecodeRef(c, 8)).toEqual({ d, syndrome: 0, single: 0, double: 0 });
      for (let i = 0; i < 13; i++) {
        const one = hammingDecodeRef(c ^ (1 << i), 8);
        expect([one.d, one.single, one.double]).toEqual([d, 1, 0]);
        for (let j = i + 1; j < 13; j++) expect(hammingDecodeRef(c ^ (1 << i) ^ (1 << j), 8)).toMatchObject({ single: 0, double: 1 });
      }
    }
  });
  it('gate-level encoder → one flip → decoder recovers the data', () => {
    const enc = simulate(hammingEnc(8)), dec = simulate(hammingDec(8));
    for (const d of [0, 1, 0x5a, 0xa5, 0xff, 0x80]) {
      const [c] = evalOnce(enc, [d]);
      for (let i = 0; i < 13; i++) expect(evalOnce(dec, [c ^ (1 << i)])).toEqual([d, i & 15, 1, 0]);
    }
  });
});
