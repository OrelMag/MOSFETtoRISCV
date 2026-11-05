// Act 13, sp_cic: the reference passes the bench at par, the circuits that nearly do fail it with the clock and value that show why.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { cicGives } from '../src/campaign/builddsp';
import { CIC_REF, CIC_W, runCic } from '../src/campaign/cicbench';
import { CASESS } from '../src/campaign/casesS';
import { levelChallenge } from '../src/campaign/levels';
import { nodeById } from '../src/campaign/nodes';
import { checkChallenge } from '../src/editor/challenges';
import type { Compiled } from '../src/editor/compile';
import { Builder } from '../src/lib/builder';
import { define } from '../src/lib/define';
import { satAdder } from '../src/lib/fixedpt';
import { comb, integrator } from '../src/lib/multirate';
import { register } from '../src/lib/sequential';
import { TIE1 } from '../src/lib/transistors';
import { stats } from '../src/sim/stats';
import type { ComponentDef } from '../src/sim/types';
import { force, swap, tie } from './mutate';

const compiled = (def: ComponentDef): Compiled =>
  ({ def, diags: [], mode: 'gate', netOfWire: new Map(), netOfEnd: new Map(), netOfLabel: new Map() }) as unknown as Compiled;
const check = (def: ComponentDef) => checkChallenge(levelChallenge(nodeById('sp_cic')!)!, compiled(def));
const first = (def: ComponentDef, seed = 1) => runCic(def, 'gate', seed).failures[0] ?? '';

/** An integrator that clamps instead of wrapping: the habit of the saturating adder. */
const satIntegrator = (w: number): ComponentDef => {
  const b = new Builder(8, 12, 4);
  b.pins('a', 'clk');
  const one = b.op(TIE1, [], undefined, 'one');
  const r = b.add(register(w), 'keeps the sum', 'r');
  b.next();
  const s = b.op(satAdder(w), [`${r}.q`, 'a'], 'adds, and clamps', 'add');
  b.wire(`${s}.y`, `${r}.d`); b.wire(`${one}.y`, `${r}.en`); b.wire('clk', `${r}.clk`);
  b.next();
  b.wire(`${r}.q`, 'y');
  const R = b.right;
  return define({
    id: `sat_int${w}`, name: 'Saturating integrator', category: 'arithmetic', summary: 'A running sum that clamps.', ports: integrator(w).ports, symbol: { kind: 'box', label: '∫sat', w: 6 },
    netlist: () => ({ pins: { a: [0, 2], clk: [8, b.height + 3], y: [R, 2] }, instances: b.instances, nets: b.nets() }),
  });
};

describe('sp_cic: CIC decimator', () => {
  const ref = CIC_REF();
  it('the reference passes, at par, quickly', () => {
    const t = Date.now();
    const r = check(ref);
    expect(r.failures).toEqual([]);
    expect(Date.now() - t).toBeLessThan(5000);
    expect(r.score.nand).toBe(nodeById('sp_cic')!.par!.nand);
    expect(r.score.period).toBe(nodeById('sp_cic')!.par!.period);
  });
  it('the reference passes at several seeds', () => {
    for (const s of [1, 2, 3, 4, 5]) expect(runCic(ref, 'gate', s).failures).toEqual([]);
  });
  it('saturating integrators fail, at every seed, and the message says why', () => {
    const bad = swap(swap(ref, 'int0', satIntegrator(CIC_W)), 'int1', satIntegrator(CIC_W));
    for (const s of [1, 2, 3, 4]) expect(first(bad, s)).toMatch(/clock \d+: y = -?\d+, the model gives -?\d+/);
    const one = first(swap(ref, 'int1', satIntegrator(CIC_W)));
    expect(one).toMatch(/y = /);
    expect(check(swap(ref, 'int1', satIntegrator(CIC_W))).ok).toBe(false);
  });
  it('combs that load on every clock fail', () => {
    for (const s of [1, 2, 3]) expect(first(tie(ref, 'comb0.en', 1), s)).toMatch(/clock \d+: y = /);
  });
  it('an output register that loads on every clock fails', () => {
    for (const s of [1, 2, 3]) expect(first(tie(ref, 'yr.en', 1), s)).toMatch(/y = /);
  });
  it('a valid stuck low fails', () => {
    for (const s of [1, 2, 3]) expect(first(force(ref, 'vr.q', 0), s)).toMatch(/valid = 0, the model gives 1/);
  });
  it('the level\'s gives leave the integrator and comb to the learner', () => {
    expect(cicGives()).not.toContain(integrator(CIC_W).id);
    expect(cicGives()).not.toContain(comb(CIC_W).id);
  });
  it('the case quotes the reference', () => {
    const t = Object.values(CASESS.sp_cic).flat().map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
    const n = (d: ComponentDef) => stats(d).nands;
    expect(t).toContain('1 263 NANDs');
    expect(n(ref)).toBe(1263);
    expect(t).toContain(`Each of the two integrators is ${n(integrator(CIC_W))} NANDs`);
    expect(t).toContain(`each comb ${n(comb(CIC_W))}`);
  });
});
