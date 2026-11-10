// Our static timing against OpenSTA's after routing on the two sky130 layouts (chapter silicon, "The real thing", Numbers). The paths are
// a layout run's (tests/sky/<design>.json.gz, scripts/sky-fixture.ts); ours are recomputed from our netlists every run, so the chapter's
// table (src/chapters/silicon/skytiming.json, scripts/sky-paths.ts --write) cannot drift from the delay model, and a change to the model
// that narrows or widens the spread shows here first.

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { dualCore, systemCore } from '../src/lib';
import { flatten } from '../src/sim/flatten';
import SKY from '../src/chapters/silicon/skytiming.json';
import { matchPaths, type SkyFixture, summarize, unslim } from '../scripts/skypathlib';
import { tick } from './yieldtick';

const DESIGNS = { dual: () => dualCore([], 5, true), sys: () => systemCore({ m: true }) };

const measured = async (design: 'dual' | 'sys') => {
  const fx: SkyFixture = JSON.parse(gunzipSync(readFileSync(`tests/sky/${design}.json.gz`)).toString('utf8'));
  const d = flatten(DESIGNS[design](), { mode: 'gate' });
  await tick();
  const { rows, unmatched } = matchPaths(d, fx.paths.map(unslim), design === 'dual' ? 2 : 1);
  return { fx, rows, unmatched, sum: summarize(fx, rows) };
};

describe('our static timing against sky130 after routing', () => {
  for (const design of ['dual', 'sys'] as const) {
    it(`${design}: every endpoint matched, and the chapter's table is what the paths and our model give`, async () => {
      const { fx, rows, unmatched, sum } = await measured(design);
      expect(unmatched).toEqual([]);
      expect(rows).toHaveLength(fx.paths.length);
      expect(sum).toEqual((SKY as Record<string, unknown>)[design]);
    }, 60_000);
  }

  it('the spreads: the load model does not narrow them on these layouts (dual 15 → 21 %, sys 25 → 31 %)', async () => {
    const dual = (await measured('dual')).sum, sys = (await measured('sys')).sum;
    expect([dual.worstUnit.cv, dual.worstLoad.cv]).toEqual([0.15, 0.21]);
    expect([sys.worstUnit.cv, sys.worstLoad.cv]).toEqual([0.25, 0.31]);
    // the scale: one of our delays is worth well over the illustrative constant on sky130 at 1.8 V
    expect([dual.worstUnit.median, dual.worstLoad.median, sys.worstUnit.median, sys.worstLoad.median]).toEqual([148, 86, 159, 92]);
  }, 120_000);
});
