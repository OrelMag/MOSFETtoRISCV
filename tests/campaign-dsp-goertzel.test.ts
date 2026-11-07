// Act 13, Goertzel for one tone: the chapter's resonator passes the bench at par, the circuits that nearly do fail it with the clock
// and the word that shows why, and the numbers the level's case quotes are the reference's.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { CASESS } from '../src/campaign/casesS';
import { GZ_REF } from '../src/campaign/builddsp';
import { GZ_BLOCK } from '../src/campaign/goertzelcheck';
import { levelChallenge } from '../src/campaign/levels';
import { nodeById } from '../src/campaign/nodes';
import { checkChallenge } from '../src/editor/challenges';
import type { Compiled } from '../src/editor/compile';
import { fftStream } from '../src/lib/fft';
import { DTMF_N } from '../src/widgets/dspspectrum';
import { stats } from '../src/sim/stats';
import { netlistOf } from '../src/sim/types';
import type { ComponentDef } from '../src/sim/types';
import { tie } from './mutate';

const compiled = (def: ComponentDef): Compiled =>
  ({ def, diags: [], mode: 'gate', netOfWire: new Map(), netOfEnd: new Map(), netOfLabel: new Map() }) as unknown as Compiled;
const check = (def: ComponentDef) => checkChallenge(levelChallenge(nodeById('sp_goertzel')!)!, compiled(def));
const bad = (def: ComponentDef): string => check(def).failures.join(' | ');

describe('sp_goertzel: Goertzel for one tone', () => {
  it('the bench uses the chapter\'s block', () => expect(GZ_BLOCK).toBe(DTMF_N));

  it('the reference passes every block at every tone, at par', () => {
    const t0 = Date.now();
    const r = check(GZ_REF());
    expect(r.failures).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(20000);
    expect(r.score.nand).toBe(nodeById('sp_goertzel')!.par!.nand);
    expect(r.score.period).toBe(nodeById('sp_goertzel')!.par!.period);
  });

  it('a product that is truncated, not rounded, drifts from the model', () => {
    expect(bad(tie(GZ_REF(), 'rnd.c', 0))).toMatch(/s1 = -?\d+, the model gives -?\d+/);
  });

  it('a subtraction without its carry in is off by one', () => {
    expect(bad(tie(GZ_REF(), 'a2.cin', 0))).toMatch(/off by one/);
  });

  it('a clear that leaves s2 starts the next tone from the last one\'s state', () => {
    expect(bad(tie(GZ_REF(), 'm2.s', 0))).toMatch(/s2 = -?\d+, the model gives|both registers must be 0/);
  });

  it('a clear that leaves s1 fails at the clock that clears', () => {
    expect(bad(tie(GZ_REF(), 'm1.s', 0))).toMatch(/clr = 1 at the clock that starts the block/);
  });

  it('every mutant fails the same way twice (the bench is seeded)', () => {
    for (const end of ['rnd.c', 'a2.cin', 'm2.s', 'm1.s']) expect(check(tie(GZ_REF(), end, 0)).ok).toBe(false);
  });

  it('the case quotes the reference', () => {
    const t = Object.values(CASESS.sp_goertzel).flat().map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
    const n = (d: ComponentDef) => stats(d).nands, ref = GZ_REF();
    const parts = netlistOf(ref)!.instances;
    const mul = parts.find((i) => i.name === 'mul')!.def;
    expect([n(ref), n(mul), n(ref) - n(mul), 8 * n(ref), n(fftStream(256, 12))]).toEqual([4389, 3427, 962, 35112, 167844]);
    for (const s of ['4 389 NANDs', '3 427 of them', 'is 962', '35 112', '167 844']) expect(t).toContain(s);
    expect(8 * (GZ_BLOCK + 1)).toBe(1648);
    expect(1648 / (GZ_BLOCK / 8000) / 1000).toBeGreaterThan(64);
    expect(1648 / (GZ_BLOCK / 8000) / 1000).toBeLessThan(65);
  });
});
