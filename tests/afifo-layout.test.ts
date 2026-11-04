// The FIFO's hand drawing computes its positions: every size the workbench offers has to come out clean too.
import { describe, expect, it } from 'vitest';
import { asyncFifo } from '../src/lib';
import { netlistOf } from '../src/sim/types';
import { labelOverlaps, symbolOverlaps } from '../src/view/route';

describe('the asynchronous FIFO drawing', () => {
  it.each([[1, 4], [1, 8], [2, 4], [2, 8], [3, 4], [3, 8], [4, 4], [4, 8]])('2^%i words of %i bits: nothing overlaps', (k, w) => {
    const d = asyncFifo(k, w), n = netlistOf(d)!;
    expect(symbolOverlaps(n)).toEqual([]);
    expect(labelOverlaps(d, n)).toEqual([]);
  });
});
