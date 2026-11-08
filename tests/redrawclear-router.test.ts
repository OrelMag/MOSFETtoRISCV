import { describe, expect, it } from 'vitest';
import { fftNet } from '../src/lib/fft';
import { FIR5 } from '../src/lib/fir';
import { RT_CHECK, RT_COUNT, RT_WALK } from '../src/lib/router';
import { asyncFifo } from '../src/lib/sync';
import { DIAL_SELECTOR } from '../src/lib/telegraph';
import { netlistOf, type ComponentDef } from '../src/sim/types';
import { routeNetlist } from '../src/view/route';
import { drawnNetlist, wiresThroughParts } from '../src/view/wirefirst';

// The router area's redrawn levels (the survey's phase 2b): no wire runs through a part.
const levels: [string, () => ComponentDef][] = [
  ['byte counter', () => RT_COUNT],
  ['header checks', () => RT_CHECK],
  ['trie walk', () => RT_WALK],
  ['dial selector', () => DIAL_SELECTOR],
  ['FFT network', () => fftNet(8, 10)],
  ['FIR filter', () => FIR5],
  ['asynchronous FIFO', () => asyncFifo(2, 8)],
];

describe('router-area levels', () => {
  it.each(levels)('%s: no wire runs through a part', (_, make) => {
    const def = make();
    const nl = drawnNetlist(def, netlistOf(def)!);
    const hit = wiresThroughParts(nl, routeNetlist(def, nl).nets);
    expect([...hit].map((i) => nl.nets[i].name ?? nl.nets[i].ends[0])).toEqual([]);
  });
});
