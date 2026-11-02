import { describe, expect, it } from 'vitest';
import { bench } from '../src/chapters/types';
import { registry } from '../src/lib';
import { flatten } from '../src/sim/flatten';
import { needsSwitchLevel } from '../src/sim/harness';
import { netlistOf } from '../src/sim/types';

describe('workbench opens every part', () => {
  it('flattens the root the workbench would load, at the level the stage picks', () => {
    for (const id of ['nmos', 'pmos', 'nmos_strong', 'pmos_weak']) {
      const def = registry.get(id)!;
      const root = bench(def);
      expect(needsSwitchLevel(root), id).toBe(true);
      expect(() => flatten(root, { mode: 'switch' }), id).not.toThrow();
    }
  });
  it('every registered primitive with ports benches', () => {
    for (const def of registry.values()) {
      if (!def.prim || netlistOf(def)) continue;
      const root = bench(def);
      expect(() => flatten(root, { mode: needsSwitchLevel(root) ? 'switch' : 'gate' }), def.id).not.toThrow();
    }
  });
});

import { ctrlConfig } from '../src/widgets/dramwork';
import { price, workloads } from '../src/dram/workload';

describe('chapter 36 explorer', () => {
  it('every toggle combination prices every workload', () => {
    for (const policy of ['open', 'closed'] as const) for (const banks of [2, 4]) for (const hash of [false, true]) {
      for (const w of workloads()) {
        expect(() => price(w, ctrlConfig(w.dmemWords, banks, policy, hash))).not.toThrow();
      }
    }
  });
});

import { DeviceModel, deviceIn } from '../src/dram/controller';
import { cloneState } from '../src/sim/gatesim';

describe('saved simulation state', () => {
  it('keeps a DRAM device inside a plain state object a DeviceModel', () => {
    const dev = new DeviceModel({ k: 7, banks: 2, rowWords: 16, policy: 'open' });
    const c = cloneState({ dev, clk: 0 }) as { dev: DeviceModel };
    expect(deviceIn(c)).not.toBeNull();
    expect(c.dev).not.toBe(dev);
    expect(c.dev.mem).not.toBe(dev.mem);
  });
});

import { DRILLS } from '../src/campaign/drills';

describe('binary drill', () => {
  it('does not take a decimal for a binary answer', () => {
    const d = DRILLS.binary;
    let seen = 0;
    for (let s = 1; s < 400; s++) {
      let st = s;
      const r = () => { st = (st + 0x6d2b79f5) >>> 0; let t = Math.imul(st ^ (st >>> 15), st | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32; };
      const q = d.make(r);
      if (!/in binary/.test(q.prompt)) continue;
      seen++;
      const want = parseInt(q.answer.replace(/\s/g, ''), 2);
      expect(q.check(q.answer).ok).toBe(true);
      expect(q.check('0b' + q.answer).ok).toBe(true);
      const dec = String(want);
      if (/^[01]+$/.test(dec) && dec !== q.answer.replace(/\s/g, '')) continue; // a decimal that reads as binary
      expect(q.check(dec).ok, `${q.prompt} ${dec}`).toBe(false);
    }
    expect(seen).toBeGreaterThan(10);
  });
});
