// Act 13, sp_sd: the loop's reference passes at par, the loops that nearly work fail with the clock that shows why, and the case's numbers are measured.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { SD_REF } from '../src/campaign/sdcheck';
import { CASESS } from '../src/campaign/casesS';
import { levelChallenge } from '../src/campaign/levels';
import { nodeById } from '../src/campaign/nodes';
import { sdScenarios } from '../src/campaign/sdcheck';
import { SD_GUARD } from '../src/dsp/converters';
import { checkChallenge } from '../src/editor/challenges';
import type { Compiled } from '../src/editor/compile';
import { Builder } from '../src/lib/builder';
import { define } from '../src/lib/define';
import { satAdder } from '../src/lib/fixedpt';
import { cut } from '../src/lib/fft';
import { TIE0 } from '../src/lib/transistors';
import { sdModulator } from '../src/lib/sigmadelta';
import { stats } from '../src/sim/stats';
import type { ComponentDef } from '../src/sim/types';
import { swap, tie } from './mutate';

const compiled = (def: ComponentDef): Compiled =>
  ({ def, diags: [], mode: 'gate', netOfWire: new Map(), netOfEnd: new Map(), netOfLabel: new Map() }) as unknown as Compiled;
const check = (def: ComponentDef) => checkChallenge(levelChallenge(nodeById('sp_sd')!)!, compiled(def));
const W = () => nodeW() + SD_GUARD;
const nodeW = () => 8;

/** An adder with rca's pins that stops at the ends of the word instead of wrapping: a loop whose integrator saturates. */
function satRca(n: number): ComponentDef {
  const b = new Builder(6, 10, 4);
  b.pins('a', 'b', 'cin');
  const s = b.op(satAdder(n), ['a', 'b']);
  const z = b.op1(TIE0, [], undefined, 'z');
  b.next();
  b.wire(`${s}.y`, 's'); b.wire(z, 'co');
  return define({
    id: `sd_satrca${n}`, name: 'saturating adder (rca pins)', category: 'arithmetic', summary: 'test mutant',
    ports: [{ name: 'a', width: n, dir: 'in' }, { name: 'b', width: n, dir: 'in' }, { name: 'cin', width: 1, dir: 'in' }, { name: 's', width: n, dir: 'out' }, { name: 'co', width: 1, dir: 'out' }],
    symbol: { kind: 'box', label: 'SAT', w: 8 }, netlist: () => ({ pins: { a: [0, 2], b: [0, 8], cin: [0, 12], s: [b.right, 6], co: [b.right, 12] }, instances: b.instances, nets: b.nets() }),
  });
}

describe('sp_sd: sigma-delta loop', () => {
  it('the reference passes, at par', () => {
    const r = check(SD_REF());
    expect(r.failures).toEqual([]);
    expect(r.score.nand).toBe(nodeById('sp_sd')!.par!.nand);
  });
  it('feedback with the wrong sign (y1 adds v) fails at the first clock', () => {
    const r = check(tie(SD_REF(), 's1.sub', 0));
    expect(r.ok).toBe(false);
  });
  it('the second integrator with the wrong sign fails', () => {
    const r = check(tie(SD_REF(), 's2.sub', 0));
    expect(r.ok).toBe(false);
  });
  it('the comparator on the wrong bit fails', () => {
    const r = check(swap(SD_REF(), 'sign', cut(W(), W() - 2, 1)));
    expect(r.ok).toBe(false);
  });
  it('an integrator that saturates fails on the inputs that overload it', () => {
    const r = check(swap(SD_REF(), 'a2', satRca(W())));
    expect(r.ok).toBe(false);
  });
  it('the failures name the clock, the input and what the model has', () => {
    expect(check(tie(SD_REF(), 's1.sub', 0)).failures[0]).toMatch(/^clock 0, a steady input of [+]0 full scale: y1 = 128, the model has -128/);
    expect(check(tie(SD_REF(), 's1.sub', 0)).failures.join(' ')).toMatch(/average 0.119 over the last 2000 clocks, not 0.5/);
    expect(check(swap(SD_REF(), 'sign', cut(W(), W() - 2, 1))).failures[0]).toMatch(/^clock 15, .*overloads the sums/);
    expect(check(swap(SD_REF(), 'a2', satRca(W()))).failures[0]).toMatch(/^clock 29, .*must wrap/);
  });
  it('sixteen inputs', () => { expect(sdScenarios().length).toBe(16); });
  it('the case quotes the loops: 502 and 987 NANDs', () => {
    const t = Object.values(CASESS.sp_sd).flat().map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
    expect(stats(sdModulator(1, 8)).nands).toBe(502);
    expect(stats(SD_REF()).nands).toBe(987);
    expect(t).toContain('First order is 502 NANDs, second order 987');
    expect(t).toContain('1 579');
    expect(stats(sdModulator(2, 16)).nands).toBe(1579);
  });
});
