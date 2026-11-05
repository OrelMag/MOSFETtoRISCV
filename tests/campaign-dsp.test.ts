// Act 13 (Signals): each reference passes its bench, the circuits that nearly do fail it with the case that shows why, and the
// numbers the level's case quotes are the reference's.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { CASESS } from '../src/campaign/casesS';
import { SAT_CLAMP, SAT_REF } from '../src/campaign/builddsp';
import { levelChallenge } from '../src/campaign/levels';
import { nodeById } from '../src/campaign/nodes';
import { checkChallenge } from '../src/editor/challenges';
import type { Compiled } from '../src/editor/compile';
import { rca } from '../src/lib/combinational';
import { logicDepth, stats } from '../src/sim/stats';
import type { ComponentDef } from '../src/sim/types';
import { force, swap, tie } from './mutate';

const compiled = (def: ComponentDef): Compiled =>
  ({ def, diags: [], mode: 'gate', netOfWire: new Map(), netOfEnd: new Map(), netOfLabel: new Map() }) as unknown as Compiled;
const check = (id: string, def: ComponentDef) => checkChallenge(levelChallenge(nodeById(id)!)!, compiled(def));

describe('sp_sat: saturating adder', () => {
  it('the reference passes every pair, at par', () => {
    const r = check('sp_sat', SAT_REF());
    expect(r.failures).toEqual([]);
    expect(r.score.nand).toBe(nodeById('sp_sat')!.par!.nand);
    expect(r.score.depth).toBe(nodeById('sp_sat')!.par!.depth);
  });

  it('a clamp that never clamps wraps: 127 + 1 comes out −128', () => {
    const r = check('sp_sat', swap(SAT_REF(), 'clamp', tie(SAT_CLAMP(), 'pick.s', 0)));
    expect(r.ok).toBe(false);
  });

  it('a limit that is always positive gets negative overflows wrong', () => {
    const r = check('sp_sat', swap(SAT_REF(), 'clamp', tie(SAT_CLAMP(), 'lim.s', 0)));
    expect(r.ok).toBe(false);
  });

  it('a sat flag stuck at 0 fails though every y is right', () => {
    const r = check('sp_sat', force(SAT_REF(), 'clamp.sat', 0));
    expect(r.ok).toBe(false);
  });

  it('the case quotes the reference: 9-bit adder + clamp against the 8-bit adder', () => {
    const t = Object.values(CASESS.sp_sat).flat().map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
    const n = (d: ComponentDef) => stats(d).nands;
    expect(n(rca(9)) + n(SAT_CLAMP())).toBe(n(SAT_REF()));
    for (const s of [`${n(rca(9))} NANDs and ${logicDepth(rca(9))} delays`, `${n(SAT_CLAMP())} NANDs and ${logicDepth(SAT_CLAMP())} delays`, `${n(SAT_REF())} against ${n(rca(8))}`]) expect(t).toContain(s);
  });
});
