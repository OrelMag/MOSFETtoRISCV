// Act 13, a CORDIC stage: the reference passes every input at par, the circuits that nearly do fail, the case quotes the reference.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { CASESS } from '../src/campaign/casesS';
import { CORDIC_I, CORDIC_REF, CORDIC_SPEC } from '../src/campaign/builddsp';
import { levelChallenge } from '../src/campaign/levels';
import { nodeById } from '../src/campaign/nodes';
import { atanTable } from '../src/dsp/cordic';
import { checkChallenge } from '../src/editor/challenges';
import type { Compiled } from '../src/editor/compile';
import { constWord } from '../src/lib/alu';
import { addSub } from '../src/lib/combinational';
import { arrayMul } from '../src/lib/muldiv';
import { cut, placed } from '../src/lib/fft';
import { logicDepth, stats } from '../src/sim/stats';
import type { ComponentDef } from '../src/sim/types';
import { force, swap, tie } from './mutate';

const compiled = (def: ComponentDef): Compiled =>
  ({ def, diags: [], mode: 'gate', netOfWire: new Map(), netOfEnd: new Map(), netOfLabel: new Map() }) as unknown as Compiled;
const check = (def: ComponentDef) => checkChallenge(levelChallenge(nodeById('sp_cordic')!)!, compiled(def));
const { w, z } = CORDIC_SPEC;

describe('sp_cordic: a CORDIC stage', () => {
  it('the reference passes every input, at par', () => {
    const r = check(CORDIC_REF());
    expect(r.failures).toEqual([]);
    expect(r.score.nand).toBe(nodeById('sp_cordic')!.par!.nand);
    expect(r.score.depth).toBe(nodeById('sp_cordic')!.par!.depth);
  });

  it('x moved down 2 places instead of 1 fails', () => {
    const m = swap(swap(CORDIC_REF(), 'xsc', cut(w, 2, w - 2)), 'xs', placed(w - 2, 0, w));
    expect(check(m).ok).toBe(false);
  });

  it('an angle one step off fails', () => {
    expect(check(swap(CORDIC_REF(), 'atan', constWord(z, atanTable(CORDIC_SPEC)[CORDIC_I] + 1))).ok).toBe(false);
  });

  it('x that always adds (the wrong sign) fails', () => {
    expect(check(tie(CORDIC_REF(), 'ax.sub', 0)).ok).toBe(false);
  });

  it('a direction stuck at "forward" fails', () => {
    expect(check(force(CORDIC_REF(), 'd.y', 1)).ok).toBe(false);
  });

  it('the case quotes the reference', () => {
    const t = Object.values(CASESS.sp_cordic).flat().map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
    const n = (d: ComponentDef) => stats(d).nands;
    expect(n(CORDIC_REF()) - 3 * n(addSub(w))).toBe(6);
    for (const s of [`${n(addSub(w))} NANDs each, ${3 * n(addSub(w))} together`, `${n(CORDIC_REF())} NANDs and ${logicDepth(CORDIC_REF())} delays`, `${n(arrayMul(4))} NANDs and ${logicDepth(arrayMul(4))} delays`]) expect(t).toContain(s);
  });
});
