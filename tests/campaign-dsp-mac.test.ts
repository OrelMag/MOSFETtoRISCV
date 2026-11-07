// Act 13, MAC with guard bits: the chapter's unit passes the bench at par on several seeds in a few seconds, the units that nearly do
// fail it with the clock and the value that show why, the bench's streams hold what the level claims, and the case quotes the reference.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { MAC_REF, MAC_RW } from '../src/campaign/builddsp';
import { CASESS } from '../src/campaign/casesS';
import { levelChallenge } from '../src/campaign/levels';
import { MAC_CLOCKS, MAC_LANES, macBench, macLanes, modelStep, traceOf } from '../src/campaign/maccheck';
import { nodeById } from '../src/campaign/nodes';
import { ACC_BITS, raccOf } from '../src/dsp/mac';
import { checkChallenge } from '../src/editor/challenges';
import type { Compiled } from '../src/editor/compile';
import { busMux2 } from '../src/lib/combinational';
import { define } from '../src/lib/define';
import { cut, placed } from '../src/lib/fft';
import { clampWide } from '../src/lib/firmac';
import { macRead } from '../src/lib/macunit';
import { stats } from '../src/sim/stats';
import type { ComponentDef, InstanceDef, NetDef } from '../src/sim/types';
import { force, swap, tie } from './mutate';

const compiled = (def: ComponentDef): Compiled =>
  ({ def, diags: [], mode: 'gate', netOfWire: new Map(), netOfEnd: new Map(), netOfLabel: new Map() }) as unknown as Compiled;
const check = (def: ComponentDef) => checkChallenge(levelChallenge(nodeById('sp_mac')!)!, compiled(def));
const SEEDS = [1, 2, 3, 4];
const W = ACC_BITS;

/** The accumulator's input mux (ports a, b, s, y), followed by `then` (40 bits in, 40 out): the mutants that change what the register loads. */
function afterMux(tag: string, then: [ComponentDef, string][], out: string): ComponentDef {
  const instances: InstanceDef[] = [{ name: 'm', def: busMux2(W), at: [0, 0] }];
  const nets: NetDef[] = [{ name: 'a', ends: ['a', 'm.a'] }, { name: 'b', ends: ['b', 'm.b'] }, { name: 's', ends: ['s', 'm.s'] }];
  let prev = 'm.y';
  then.forEach(([def, port], i) => {
    instances.push({ name: `t${i}`, def, at: [10 * (i + 1), 0] });
    nets.push({ name: `n${i}`, ends: [prev, `t${i}.a`] });
    prev = `t${i}.${port}`;
  });
  nets.push({ name: 'y', ends: [prev, 'y'] });
  void out;
  return define({ ...busMux2(W), id: `mut_mac_${tag}`, netlist: () => ({ pins: { a: [0, 2], b: [0, 6], s: [0, 10], y: [60, 4] }, instances, nets }) } as ComponentDef);
}
/** The loaded value clamped to 32 bits and sign-extended back: a clamp on every add. */
const clampEachAdd = (): ComponentDef => {
  // clampWide(40, 32) has ports x, y, sat: its y is 32 bits, so the mutant is mux -> clamp -> sign-extend, built with two stages
  const cl = clampWide(W, 32), ex = placed(32, 0, W);
  const instances: InstanceDef[] = [{ name: 'm', def: busMux2(W), at: [0, 0] }, { name: 'cl', def: cl, at: [10, 0] }, { name: 'ex', def: ex, at: [20, 0] }];
  const nets: NetDef[] = [
    { name: 'a', ends: ['a', 'm.a'] }, { name: 'b', ends: ['b', 'm.b'] }, { name: 's', ends: ['s', 'm.s'] },
    { name: 'n0', ends: ['m.y', 'cl.x'] }, { name: 'n1', ends: ['cl.y', 'ex.a'] }, { name: 'y', ends: ['ex.y', 'y'] },
  ];
  return define({ ...busMux2(W), id: 'mut_mac_clampadd', netlist: () => ({ pins: { a: [0, 2], b: [0, 6], s: [0, 10], y: [30, 4] }, instances, nets }) } as ComponentDef);
};
/** A 39-bit accumulator: the top bit of the loaded value is a copy of bit 38. */
const narrowAcc = (): ComponentDef => afterMux('acc39', [[cut(W, 0, W - 1), 'y'], [placed(W - 1, 0, W), 'y']], 'y');

const mutants: [string, () => ComponentDef, RegExp][] = [
  ['a 39-bit accumulator', () => swap(MAC_REF(), 'nxt', narrowAcc()), /acc = -?\d+, the model gives -?\d+/],
  ['a clamp on every add (the register loads at most 32 bits)', () => swap(MAC_REF(), 'nxt', clampEachAdd()), /clamps to 32 bits on every add/],
  ['truncation instead of rounding', () => swap(MAC_REF(), 'read', force(macRead(), 'rnd.y', 0)), /drops the bits without adding the first one back/],
  ['mac2 adds only one product', () => tie(MAC_REF(), 'g1.s', 0), /mac2 adds only one product/],
  ['clracc ignored', () => tie(MAC_REF(), 'nxt.s', 0), /clracc is ignored/],
  ['racc writes the accumulator', () => force(MAC_REF(), 'nr.y', 1), /racc changes the accumulator/],
];

describe('sp_mac: MAC with guard bits', () => {
  it('the reference passes at par, in a few seconds', () => {
    const t0 = Date.now();
    const r = check(MAC_REF());
    const ms = Date.now() - t0;
    expect(r.failures).toEqual([]);
    expect(ms).toBeLessThan(8000);
    expect(r.score.nand).toBe(nodeById('sp_mac')!.par!.nand);
    expect(r.score.period).toBe(nodeById('sp_mac')!.par!.period);
  });

  it('the reference passes on other seeds too', () => {
    for (const s of SEEDS) expect(macBench(MAC_REF(), 'gate', s).failures, `seed ${s}`).toEqual([]);
  });

  for (const [name, make, msg] of mutants) {
    it(`${name} fails on every seed, naming the clock and the value`, () => {
      const def = make();
      for (const s of SEEDS) {
        const r = macBench(def, 'gate', s);
        expect(r.failures.length, `seed ${s}`).toBeGreaterThan(0);
        expect(r.failures.join(' | '), `seed ${s}`).toMatch(/clock \d+/);
        expect(r.failures.join(' | '), `seed ${s}`).toMatch(msg);
      }
    });
  }

  it('the checked claims hold in the bench\'s own streams', () => {
    const lanes = macLanes(1), find = (s: string) => lanes.find((l) => l.name.startsWith(s))!;
    expect(lanes.length).toBe(MAC_LANES);
    for (const l of lanes) expect(l.steps.length, l.name).toBe(MAC_CLOCKS);
    // 255 full-scale mac2 fit; the same read at 39 gives 1, past 40 gives 0
    const worst = traceOf(find('255 mac2 of full-scale').steps);
    expect(worst.accAfter[254]).toBe(255n * 2n ** 31n);
    expect(worst.accAfter[254]).toBeLessThan(2n ** 39n);
    // the excursion goes far past 32 bits and the final sum fits
    const exc = traceOf(find('an excursion that comes back').steps);
    expect(exc.accAfter[119] > 2n ** 37n).toBe(true);
    expect(exc.accAfter[239]).toBe(120n * 2n ** 16n);
    // the 256th wraps to -2^39
    const wrap = traceOf(find('256 full-scale mac2').steps);
    expect(wrap.accAfter[254]).toBe(255n * 2n ** 31n);
    expect(wrap.accAfter[255]).toBe(-(2n ** 39n));
    // the half-up tie, and the reads past the accumulator
    expect(raccOf(-5n, 1).y).toBe(-2);
    expect(traceOf(find('half-way').steps).y[2]).toBe(-2);
    const reads = new Set(find('reads at every shift of a sum').steps.map((s) => s.sh));
    for (const sh of [0, 15, 39, 40, 63]) expect(reads.has(sh), `shift ${sh}`).toBe(true);
    // the model's accumulator wraps at 40 bits and sat acts somewhere in the random streams
    expect(lanes.filter((l) => l.name.startsWith('seeded')).some((l) => traceOf(l.steps).sat.includes(1))).toBe(true);
    // en = 0 never changes the accumulator in the model
    expect(modelStep(5n, { op: 0, en: 0, a: 7, b: 7, sh: 0 })).toBe(5n);
  });

  it('the bench is seeded: the same verdict twice', () => {
    const m = tie(MAC_REF(), 'g1.s', 0);
    expect(macBench(m, 'gate', 1).failures).toEqual(macBench(m, 'gate', 1).failures);
  });

  it('the case quotes the reference', () => {
    const t = Object.values(CASESS.sp_mac).flat().map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
    const n = (d: ComponentDef) => stats(d).nands, g = (v: number) => String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    const all = n(MAC_REF()), par = nodeById('sp_mac')!.par!;
    expect(all).toBe(par.nand);
    const mul = n(placedMul()), read = n(macRead()), roundC = n(clampWide(MAC_RW, 32));
    for (const s of [`${g(all)} NANDs`, `${g(mul)} NANDs each`, `${g(read)}`, `${g(roundC)}`, `${par.period} NAND delays`, `${g(n(clampEachAdd()) - n(busMux2(W)))} NANDs`]) expect(t, s).toContain(s);
  });
});

function placedMul(): ComponentDef {
  // the signed 16 × 16 tree multiplier the unit places twice
  const inst = (MAC_REF().netlist!() as { instances: InstanceDef[] }).instances;
  return inst.find((i) => i.name === 'mul0')!.def;
}
