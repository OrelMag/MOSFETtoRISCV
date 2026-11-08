// The fast adders and the control unit, redrawn (circuit eyeballing, phase 2b). A drawing change only, held here two ways:
// every one does what it did before (the adders against their specs, the control unit output by output against a hash
// recorded before the change, tests/fixtures/fastadd-truth.json) at the same cost (NANDs and depth in all three delay models);
// and no wire runs through a part. RECORD=1 rewrites the fixture (do that only on a tree whose drawing is the reference).

import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { brentKung, CLA4, koggeStone, sklansky } from '../src/lib/fastadd';
import { control } from '../src/lib/cpu';
import { simulate, evalOnce, forEachInput } from '../src/sim/harness';
import { logicDepth, stats } from '../src/sim/stats';
import { netlistOf, type ComponentDef } from '../src/sim/types';
import { CUSTOM_PRESETS } from '../src/riscv/custom';
import { routeNetlist } from '../src/view/route';
import { drawnNetlist, wiresThroughParts } from '../src/view/wirefirst';
import { tick } from './yieldtick';

const FIXTURE = new URL('./fixtures/fastadd-truth.json', import.meta.url);

const adders = (): ComponentDef[] => [4, 8, 16, 32, 64].flatMap((n) => [koggeStone(n), brentKung(n), sklansky(n)]);
const controls = (): [string, ComponentDef][] => [
  ['control', control()], ['control + MAC', control([], true)], ['control + two custom rows', control(CUSTOM_PRESETS.slice(0, 2))],
];
const costOf = (d: ComponentDef) => [stats(d).nands, logicDepth(d, 'unit'), logicDepth(d, 'load'), logicDepth(d, 'drawn')];

/** FNV-1a over every output of every sampled input: the whole space for the plain unit, a seeded sample for the variants. */
async function truthHash(def: ComponentDef, full: boolean): Promise<string> {
  const sim = simulate(def);
  let h = 0x811c9dc5 >>> 0;
  const mix = (v: number) => { h = Math.imul(h ^ (v & 0xffff), 0x01000193) >>> 0; h = Math.imul(h ^ (v >>> 16), 0x01000193) >>> 0; };
  let n = 0;
  if (full) forEachInput(def, (ins) => { evalOnce(sim, ins).forEach(mix); void n++; });
  else {
    let s = 12345;
    const rnd = (m: number) => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return (s >>> 8) % m; };
    for (let i = 0; i < 6000; i++) {
      const ins = [rnd(128), rnd(8), rnd(128)];
      // class opcodes now and then: random opcodes hit no class
      if (i % 2) ins[0] = [0x33, 0x13, 0x03, 0x23, 0x63, 0x6f, 0x67, 0x37, 0x17, 0x0b, 0x2b, 0x5b][rnd(12)];
      evalOnce(sim, ins).forEach(mix);
      if (i % 1500 === 0) await tick();
    }
  }
  return h.toString(16);
}

const record = async () => {
  const out: Record<string, unknown> = { cost: {}, truth: {} };
  for (const d of [CLA4, ...adders(), ...controls().map(([, c]) => c)]) (out.cost as Record<string, unknown>)[d.id] = costOf(d);
  for (const [name, c] of controls()) (out.truth as Record<string, unknown>)[name] = await truthHash(c, name === 'control');
  writeFileSync(FIXTURE, JSON.stringify(out, null, 1));
};

describe('fast adders and the control unit', () => {
  if (process.env.RECORD) it('records the fixture', async () => { await record(); }, 300_000);
  const fx = process.env.RECORD ? { cost: {}, truth: {} } : JSON.parse(readFileSync(FIXTURE, 'utf8'));

  it('cost the same: NANDs and depth (unit, load, drawn)', () => {
    for (const d of [CLA4, ...adders(), ...controls().map(([, c]) => c)]) expect(costOf(d), d.id).toEqual(fx.cost[d.id]);
  }, 120_000);

  it('CLA4 adds, every input', () => {
    forEachInput(CLA4, ([a, b, c]) => {
      const t = a + b + c;
      expect(CLA4.spec!([a, b, c]), `${a} ${b} ${c}`).toEqual([t % 16, t > 15 ? 1 : 0]);
    });
    const sim = simulate(CLA4);
    forEachInput(CLA4, (ins) => { expect(evalOnce(sim, ins)).toEqual(CLA4.spec!(ins)); });
  });

  it.each([8, 16, 32])('%i-bit prefix adders match their specs on seeded random vectors', async (n) => {
    let s = 7 + n;
    const rnd = () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s; };
    for (const d of [koggeStone(n), brentKung(n), sklansky(n)]) {
      const sim = simulate(d);
      for (let i = 0; i < 150; i++) {
        const ins = [n === 32 ? rnd() : rnd() % 2 ** n, n === 32 ? rnd() : rnd() % 2 ** n, rnd() & 1];
        if (i < 4) { ins[0] = [0, 2 ** n - 1, 2 ** n - 1, 1][i]; ins[1] = [0, 1, 2 ** n - 1, 2 ** n - 1][i]; }
        expect(evalOnce(sim, ins), `${d.id} ${ins}`).toEqual(d.spec!(ins));
      }
      await tick();
    }
  }, 120_000);

  it.each(controls())('%s: every output on every input as before', async (name, c) => {
    expect(await truthHash(c, name === 'control')).toBe(fx.truth[name]);
  }, 300_000);

  const levels: [string, () => ComponentDef][] = [
    ['CLA4', () => CLA4], ['control', () => control()], ['control + MAC', () => control([], true)], ['control + custom rows', () => control(CUSTOM_PRESETS.slice(0, 2))],
    ...[4, 8, 16, 32, 64].flatMap((n): [string, () => ComponentDef][] => [[`ks${n}`, () => koggeStone(n)], [`bk${n}`, () => brentKung(n)], [`sk${n}`, () => sklansky(n)]]),
  ];
  it.each(levels)('%s: no wire runs through a part', (_, make) => {
    const def = make();
    const nl = drawnNetlist(def, netlistOf(def)!);
    const hit = wiresThroughParts(nl, routeNetlist(def, nl).nets);
    expect([...hit].map((i) => nl.nets[i].name ?? nl.nets[i].ends[0])).toEqual([]);
  }, 60_000);
});
