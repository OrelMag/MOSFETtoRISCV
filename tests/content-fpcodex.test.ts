// The floating-point codex entries and the FP ladder: every chapter link points at the step it names, and the
// block sizes the texts quote that no other test measures are measured here.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { moreIds, moreOf } from '../src/campaign/codexmore';
import { NODES } from '../src/campaign/nodes';
import { chapterById } from '../src/chapters';
import { arrayMul, treeMul } from '../src/lib';
import { resolveComponent } from '../src/lib/resolve';
import { logicDepth, stats } from '../src/sim/stats';

const lib = (id: string) => { const d = resolveComponent(id)!; return [stats(d).nands, logicDepth(d)]; };
const plain = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim();

describe('FP codex and ladder', () => {
  it('every link to a step of chapter 24 names that step', () => {
    const float = chapterById('float')!;
    const links = [
      ...moreIds().flatMap((id) => (moreOf(id)?.chapters ?? []).map((l) => [id, l] as const)),
      ...NODES.flatMap((n) => (n.chapters ?? []).map((l) => [n.id, l] as const)),
    ].filter(([, l]) => l.chapter === 'float' && l.step !== undefined);
    expect(links.length).toBeGreaterThan(20);
    for (const [id, l] of links) expect(plain(float.steps[l.step!].title), `${id}: step ${l.step}`).toBe(l.label);
  });

  it('sizes quoted in the FP cases and walks', () => {
    expect(lib('lzc2')).toEqual([4, 2]);
    expect(lib('lzc8')).toEqual([44, 7]);
    expect(lib('lzc16')).toEqual([104, 9]);
    expect(lib('prienc16')).toEqual([89, 9]);
    expect(lib('rv16_shift16')).toEqual([299, 14]);
    expect(lib('shrs13_4')).toEqual([264, 21]);
    expect(lib('shrs15_4')).toEqual([296, 21]);
    expect([stats(arrayMul(11)).nands, logicDepth(arrayMul(11))]).toEqual([1232, 100]);
    expect([stats(treeMul(11, false, 22)).nands, logicDepth(treeMul(11, false, 22))]).toEqual([1696, 48]);
    expect(lib('fpmul8_23')).toEqual([14913, 176]);
    expect(lib('fpadd8_23')).toEqual([8218, 181]);
    expect(lib('fpfma8_23')).toEqual([26348, 270]);
    expect(lib('cmp16')).toEqual([237, 23]);
    expect(lib('fpcmp5_10')).toEqual([682, 25]);
  });
});
