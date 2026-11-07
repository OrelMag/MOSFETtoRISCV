// Act 13, Circular address: the reference passes every pointer in every mode on the chosen windows, at par; the circuits that
// nearly do fail, naming the first wrong vector; the case quotes the reference.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { CASESS } from '../src/campaign/casesS';
import { CIRC_REF } from '../src/campaign/builddsp';
import { CIRC_TRIPLES, CIRC_VECTORS, runCirc } from '../src/campaign/circcheck';
import { levelChallenge } from '../src/campaign/levels';
import { nodeById } from '../src/campaign/nodes';
import { aguStep } from '../src/dsp/iss24';
import { checkChallenge } from '../src/editor/challenges';
import type { Compiled } from '../src/editor/compile';
import { constWord } from '../src/lib/alu';
import { rca } from '../src/lib/combinational';
import { define } from '../src/lib/define';
import { AND, NOT } from '../src/lib/gates';
import { TIE1 } from '../src/lib/transistors';
import { bitwise } from '../src/lib/wide';
import { logicDepth, stats } from '../src/sim/stats';
import type { ComponentDef, InstanceDef, NetDef } from '../src/sim/types';
import { netlistOf } from '../src/sim/types';
import { force, swap } from './mutate';

const compiled = (def: ComponentDef): Compiled =>
  ({ def, diags: [], mode: 'gate', netOfWire: new Map(), netOfEnd: new Map(), netOfLabel: new Map() }) as unknown as Compiled;
const check = (def: ComponentDef) => checkChallenge(levelChallenge(nodeById('sp_circ')!)!, compiled(def));

let uid = 0;
/** A copy of the step with its top level edited. */
function edit(def: ComponentDef, f: (instances: InstanceDef[], nets: NetDef[]) => void): ComponentDef {
  const nl = netlistOf(def)!;
  const instances = nl.instances.map((i) => ({ ...i }));
  const nets = nl.nets.map((x) => ({ ...x, ends: [...x.ends] }));
  f(instances, nets);
  return define({ ...def, id: `mut_circ_${uid++}`, netlist: () => ({ ...nl, instances, nets }) } as ComponentDef);
}
const netOf = (nets: NetDef[], end: string): NetDef => nets.find((n) => n.ends.includes(end))!;
const drop = (nets: NetDef[], end: string) => { const n = netOf(nets, end); n.ends = n.ends.filter((e) => e !== end); };

/** The window end as a 9-bit sum: a carry out of base + len keeps the next address from ever equalling it. */
const nineBitEnd = (): ComponentDef => edit(CIRC_REF(), (ins, nets) => {
  ins.push({ name: 'mn', def: NOT, at: [0, 0] }, { name: 'mx', def: AND, at: [0, 0] });
  drop(nets, 'u18.eq');
  nets.push({ ends: ['u18.eq', 'mx.a'] }, { ends: ['u9.cout', 'mn.a'] }, { ends: ['mn.y', 'mx.b'] });
  netOf(nets, 'u20.b').ends.push('mx.y');
});

/** ">=" for "=": the next address is at or past the end (the carry of t − end). */
const atOrPastEnd = (): ComponentDef => edit(CIRC_REF(), (ins, nets) => {
  ins.push({ name: 'xr', def: bitwise('xor', 8), at: [0, 0] }, { name: 'ge', def: rca(8), at: [0, 0] }, { name: 'one', def: TIE1, at: [0, 0] });
  drop(nets, 'u18.eq');
  netOf(nets, 'u18.b').ends.push('xr.a');
  netOf(nets, 'u13.b').ends.push('xr.b');
  netOf(nets, 'u18.a').ends.push('ge.a');
  nets.push({ ends: ['xr.y', 'ge.b'] }, { ends: ['one.y', 'ge.cin'] });
  netOf(nets, 'u20.b').ends.push('ge.cout');
});

/** The modifier added as it is, only p reversed (the reversal of m left out). */
const plainM = (): ComponentDef => edit(CIRC_REF(), (_ins, nets) => {
  drop(nets, 'u7.out');
  drop(nets, 'u15.b');
  netOf(nets, 'm').ends.push('u15.b');
});

describe('sp_circ: circular address', () => {
  it('the reference passes every vector, at par, in a few seconds', () => {
    const t = Date.now();
    const r = check(CIRC_REF());
    expect(r.failures).toEqual([]);
    expect(Date.now() - t).toBeLessThan(5000);
    expect(r.score.nand).toBe(nodeById('sp_circ')!.par!.nand);
    expect(r.score.depth).toBe(nodeById('sp_circ')!.par!.depth);
    expect(r.tested).toBe(CIRC_VECTORS);
  });

  it('the windows include the corners the brief names', () => {
    const t = CIRC_TRIPLES;
    expect(t.some(([b, l]) => b + l > 255)).toBe(true);                       // crosses 255
    expect(t.some(([b, l]) => b + l === 256)).toBe(true);                     // ends at exactly 0
    for (const l of [0, 1, 255]) expect(t.some(([, len]) => len === l)).toBe(true);
    for (const b of [0, 255]) expect(t.some(([base]) => base === b)).toBe(true);
    for (const m of [0, 1, 32, 128, 255]) expect(t.some(([, , mm]) => mm === m)).toBe(true);
    expect(t[0]).toEqual([4, 6, 32]);
  });

  it('a 9-bit window end fails on a window that crosses 255', () => {
    const r = check(nineBitEnd());
    expect(r.ok).toBe(false);
    expect(r.failures.join('\n')).toMatch(/mode \+circular, base \d+, len \d+, m \d+: y = \d+, the model gives \d+/);
    expect(r.failures.join('\n')).toMatch(/does not fit 8 bits/);
  });

  it('>= in place of = for the end test fails: a pointer outside the window wraps', () => {
    const r = check(atOrPastEnd());
    expect(r.ok).toBe(false);
    expect(r.failures.join('\n')).toContain('mode +circular');
  });

  it('-circular wrapping to the end instead of end - 1 fails', () => {
    const r = check(swap(CIRC_REF(), 'u11', constWord(8, 0)));
    expect(r.ok).toBe(false);
    expect(r.failures.join('\n')).toMatch(/mode −circular.*end − 1/);
  });

  it('bit-reversed adding m instead of the reversed m fails', () => {
    const r = check(plainM());
    expect(r.ok).toBe(false);
    expect(r.failures.join('\n')).toMatch(/mode bit-reversed.*modifier was not reversed/);
  });

  it('the step mux ignoring mode 0 (stay) fails', () => {
    const r = check(force(CIRC_REF(), 'u0.y0', 0));
    expect(r.ok).toBe(false);
    expect(r.failures.join('\n')).toContain('mode stay');
  });

  it('names the chapter\'s own example as the first window', () => {
    // A pointer at 9 in the window 4 .. 9 (base 4, len 6) goes to 4: a mutant that never wraps says so first.
    expect(aguStep(9, 4, 4, 6, 32)).toBe(4);
    const r = runCirc(force(CIRC_REF(), 'u0.y4', 0), 'gate');
    expect(r.failures.join('\n')).toContain('base 4, len 6, m 32');
  });

  it('the case quotes the reference', () => {
    const t = Object.values(CASESS.sp_circ).flat().map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
    const n = (d: ComponentDef) => stats(d).nands;
    expect(n(CIRC_REF())).toBe(639);
    expect(n(rca(8))).toBe(72);
    const ins = netlistOf(CIRC_REF())!.instances;
    const of = (...names: string[]) => names.reduce((s, x) => s + n(ins.find((i) => i.name === x)!.def), 0);
    expect(of('u18', 'u19', 'u9', 'u13', 'u23', 'u24', 'u20', 'u21', 'u22')).toBe(323);
    for (const s of ['639 NANDs and 53 delays', 'of 72 NANDs each', 'two equality comparators of 54', 'five 8-bit muxes of 32', 'decoder of 35', 'inverter of 32', 'circular modes cost 323']) expect(t).toContain(s);
    expect(logicDepth(CIRC_REF())).toBe(53);
  });
});
