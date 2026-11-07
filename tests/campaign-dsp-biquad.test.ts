// Act 13, sp_biquad: the reference passes the bench at par on several seeds, circuits that nearly do fail it with the clock and value that show why,
// and the numbers the level's case quotes are the reference's.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { BIQUAD_REF } from '../src/campaign/builddsp';
import { CASESS } from '../src/campaign/casesS';
import { biquadBench, BQ_LANES } from '../src/campaign/dspcheck';
import { levelChallenge } from '../src/campaign/levels';
import { nodeById } from '../src/campaign/nodes';
import { checkChallenge } from '../src/editor/challenges';
import type { Compiled } from '../src/editor/compile';
import { biquad } from '../src/lib/biquad';
import { cut } from '../src/lib/fft';
import { treeMul } from '../src/lib/muldiv';
import { stats } from '../src/sim/stats';
import type { ComponentDef } from '../src/sim/types';
import { force, swap, tie } from './mutate';

const compiled = (def: ComponentDef): Compiled =>
  ({ def, diags: [], mode: 'gate', netOfWire: new Map(), netOfEnd: new Map(), netOfLabel: new Map() }) as unknown as Compiled;
const check = (def: ComponentDef) => checkChallenge(levelChallenge(nodeById('sp_biquad')!)!, compiled(def));
const SEEDS = [1, 2, 3, 4];

describe('sp_biquad: a biquad', () => {
  it('the reference passes at par: NANDs and the clock period', () => {
    const r = check(BIQUAD_REF());
    expect(r.failures).toEqual([]);
    expect(r.score.nand).toBe(nodeById('sp_biquad')!.par!.nand);
    expect(r.score.period).toBe(nodeById('sp_biquad')!.par!.period);
  });

  it('the reference passes on other seeds too', () => {
    for (const s of SEEDS) expect(biquadBench(BIQUAD_REF(), 'gate', s).failures, `seed ${s}`).toEqual([]);
  });

  const mutants: [string, () => ComponentDef][] = [
    ['subtraction without its +1', () => tie(BIQUAD_REF(), 'acc.cin', 0)],
    ['a stray carry into the first sum', () => tie(BIQUAD_REF(), 'sum01.cin', 1)],
    ['the dropped bits floored, not rounded', () => force(BIQUAD_REF(), 'lo.y', 0)],
    ['rounding toward zero', () => biquad('zero')],
    ['sat never raised', () => force(BIQUAD_REF(), 'clamp.sat', 0)],
    ['the feedback terms added, not subtracted', () => swap(BIQUAD_REF(), 'inv', cut(35, 0, 35))],
  ];
  for (const [name, make] of mutants) {
    it(`${name} fails on every seed`, () => {
      const def = make();
      for (const s of SEEDS) expect(biquadBench(def, 'gate', s).failures.length, `seed ${s}`).toBeGreaterThan(0);
    });
  }

  it('the failure names the run, the clock and both values', () => {
    const f = biquadBench(force(BIQUAD_REF(), 'lo.y', 0), 'gate', 1).failures;
    expect(f[0]).toMatch(/cycle \d+: y = -?\d+, the model gives -?\d+/);
    expect(f.join(' ')).toContain('dropping the bits (floor)');
    expect(biquadBench(biquad('zero'), 'gate', 1).failures.join(' ')).toContain('toward zero');
    expect(biquadBench(force(BIQUAD_REF(), 'clamp.sat', 0), 'gate', 1).failures.join(' ')).toContain('sat = 0, the model gives 1');
  });

  it('a pin of the wrong width is named, not simulated', () => {
    const bad = { ...BIQUAD_REF(), ports: BIQUAD_REF().ports.map((p) => (p.name === 'x' ? { ...p, width: 8 } : p)) } as ComponentDef;
    expect(biquadBench(bad, 'gate', 1).failures[0]).toContain('x is 8 bits wide');
  });

  it('the bench has its runs and the limit cycle among them', () => {
    expect(BQ_LANES).toBe(32);
  });

  it('the case quotes the reference', () => {
    const t = Object.values(CASESS.sp_biquad).flat().map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
    const n = (d: ComponentDef) => stats(d).nands, g = (v: number) => String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    const mul = n(treeMul(16, true)), all = n(biquad()), par = nodeById('sp_biquad')!.par!;
    expect(all).toBe(par.nand);
    for (const s of [`${g(mul)} NANDs each, ${g(5 * mul)} of the ${g(all)}`, `${par.period} NAND delays`, `${n(biquad('zero')) - all} NANDs more`]) expect(t).toContain(s);
  });
});
