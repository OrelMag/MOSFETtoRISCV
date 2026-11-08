import { describe, expect, it } from 'vitest';
import { gfConst } from '../src/lib/rs';
import { rsDecoder, rsDelta, rsLamSlice, rsOmSlice } from '../src/lib/rsdec';
import { viterbi } from '../src/lib/viterbi';
import { netlistOf, type ComponentDef } from '../src/sim/types';
import { routeNetlist } from '../src/view/route';
import { drawnNetlist, wiresThroughParts } from '../src/view/wirefirst';

// Chapter 47's decoders, redrawn by hand (rows with the chains of neighbours as staircases): no wire runs through a part.
const through = (def: ComponentDef) => {
  const nl = drawnNetlist(def, netlistOf(def)!);
  return [...wiresThroughParts(nl, routeNetlist(def, nl).nets)].map((i) => nl.nets[i].name ?? nl.nets[i].ends[0]);
};
const levels: [string, () => ComponentDef][] = [
  ['RS decoder RS(26, 16)', () => rsDecoder(10, 26)],
  ['RS decoder RS(15, 11)', () => rsDecoder(4, 15)],
  ['discrepancy', () => rsDelta(5)],
  ...[1, 2, 3, 4, 5].map((j): [string, () => ComponentDef] => [`locator coefficient ${j}`, () => rsLamSlice(j, 26)]),
  ...[0, 1, 2, 3, 4].map((i): [string, () => ComponentDef] => [`evaluator coefficient ${i}`, () => rsOmSlice(i, 26)]),
  ['Viterbi decoder, K = 3', () => viterbi(undefined, { depth: 15 })],
];

describe('hand-drawn codes levels', () => {
  it.each(levels)('%s: no wire runs through a part', (_, make) => {
    expect(through(make())).toEqual([]);
  });
  it('GF(256) constant multipliers: a wire through a gate is the exception', () => {
    let bad = 0, n = 0;
    for (let c = 2; c < 256; c += 5) { n++; if (through(gfConst(c)).length) bad++; }
    expect(bad / n).toBeLessThan(0.1);
  });
});
