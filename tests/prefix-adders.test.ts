import { describe, expect, it } from 'vitest';
import { bkLevels, brentKung, koggeStone, ksLevels, prefixInfo, sklansky, skLevels } from '../src/lib/fastadd';
import { resolveComponent } from '../src/lib/resolve';
import { logicDepth } from '../src/sim/stats';
import { type ComponentDef, netlistOf } from '../src/sim/types';
import { checkSpec, corners } from './util';

const ADDERS = { ks: koggeStone, bk: brentKung, sk: sklansky };
const LEVELS = { ks: ksLevels, bk: bkLevels, sk: skLevels };
const kinds = Object.keys(ADDERS) as (keyof typeof ADDERS)[];
const log2 = (n: number) => Math.round(Math.log2(n));

/** The adder's carry chain, read off its netlist: per cell, its level (from the instance name `L<level>_<bit>`). */
function cells(def: ComponentDef) {
  return netlistOf(def)!.instances.flatMap((i) => {
    const m = i.name.match(/^L(\d+)_(\d+)$/);
    return m ? [{ name: i.name, level: +m[1], bit: +m[2], kind: i.def.id }] : [];
  });
}

/** Per G output feeding the prefix cells (gp, the cin fold, a cell): how many cell inputs it drives on each level. */
function fanouts(def: ComponentDef): number[][] {
  const level = new Map(cells(def).map((c) => [c.name, c.level]));
  const out: number[][] = [];
  for (const net of netlistOf(def)!.nets) {
    const [drv, ...sinks] = net.ends;
    if (!/\.(g|go)$/.test(drv)) continue;
    const per: number[] = [];
    for (const s of sinks) {
      const [inst, port] = s.split('.');
      const l = level.get(inst);
      if (l !== undefined && (port === 'g' || port === 'gl')) per[l] = (per[l] ?? 0) + 1;
    }
    out.push(per.map((c) => c ?? 0));
  }
  return out;
}

describe('parallel-prefix adders match their specs', () => {
  for (const k of kinds) {
    it(`${k}4, ${k}5: every input`, () => { checkSpec(ADDERS[k](4)); checkSpec(ADDERS[k](5)); });
    for (const n of [12, 16, 32]) it(`${k}${n}: random vectors`, () => checkSpec(ADDERS[k](n), 600, corners(ADDERS[k](n))));
  }
});

describe('prefix networks', () => {
  it('ids, memoized and resolvable', () => {
    for (const k of kinds) for (const n of [4, 8, 16, 32]) {
      const d = ADDERS[k](n);
      expect(d.id).toBe(`${k}${n}`);
      expect(ADDERS[k](n)).toBe(d);
      expect(resolveComponent(d.id)).toBe(d);
    }
  });

  it('cells per level', () => {
    for (const n of [8, 16, 32]) {
      const k = log2(n), per = (d: ComponentDef) => {
        const c: number[] = [];
        for (const { level } of cells(d)) c[level] = (c[level] ?? 0) + 1;
        return c;
      };
      expect(per(koggeStone(n))).toEqual(Array.from({ length: k }, (_, j) => n - 2 ** j));
      // up-sweep n/2, n/4, … 1; down-sweep 1, 3, 7, … n/2 − 1
      expect(per(brentKung(n))).toEqual([...Array.from({ length: k }, (_, j) => n >> (j + 1)), ...Array.from({ length: k - 1 }, (_, j) => 2 ** (j + 1) - 1)]);
      expect(per(sklansky(n))).toEqual(Array(k).fill(n / 2));
      expect(cells(brentKung(n)).length).toBe(2 * n - 2 - k);
      expect(cells(sklansky(n)).length).toBe((n / 2) * k);
      expect(cells(koggeStone(n)).length).toBe(n * k - n + 1);
    }
  });

  it('gray cells exactly where the group reaches bit 0', () => {
    for (const k of kinds) for (const n of [5, 12, 16]) {
      const f = prefixInfo(n, LEVELS[k](n)), cs = cells(ADDERS[k](n));
      expect(cs.filter((c) => c.kind === 'graycell').length, `${k}${n}`).toBe(f.gray);
      expect(cs.filter((c) => c.kind === 'blackcell').length, `${k}${n}`).toBe(f.black);
      expect(f.gray, `${k}${n}`).toBe(n - 1); // one finished prefix per bit above bit 0
    }
  });

  it('depth: Brent–Kung deeper than Kogge–Stone, Sklansky as shallow', () => {
    for (const n of [16, 32]) {
      const ks = logicDepth(koggeStone(n))!;
      expect(logicDepth(brentKung(n))!, `bk${n}`).toBeGreaterThan(ks);
      expect(logicDepth(sklansky(n))!, `sk${n}`).toBe(ks);
    }
  });

  it('fan-out: Kogge–Stone and Brent–Kung ≤ 2 per level, Sklansky n/2 on the last', () => {
    for (const n of [8, 16, 32]) {
      const max = (d: ComponentDef) => Math.max(...fanouts(d).flat());
      expect(max(koggeStone(n))).toBe(2);
      expect(max(brentKung(n))).toBeLessThanOrEqual(2);
      expect(max(sklansky(n))).toBe(n / 2);
      const last = log2(n) - 1;
      expect(Math.max(...fanouts(sklansky(n)).map((p) => p[last] ?? 0))).toBe(n / 2);
      // the counts the summaries quote
      for (const k of kinds) {
        const f = prefixInfo(n, LEVELS[k](n)), fo = fanouts(ADDERS[k](n));
        expect(f.perLevel, `${k}${n}`).toBe(Math.max(...fo.flat()));
        expect(f.total, `${k}${n}`).toBe(Math.max(...fo.map((p) => p.reduce((a, b) => a + b, 0))));
      }
    }
  });

  it('a malformed network is refused', () => {
    expect(() => prefixInfo(4, [[[1, 0]], [[3, 1]]])).toThrow(); // 3's group is [3:3], not [3:2]
    expect(() => prefixInfo(4, [[[1, 0]]])).toThrow(); // carries 2 and 3 never finish
  });
});
