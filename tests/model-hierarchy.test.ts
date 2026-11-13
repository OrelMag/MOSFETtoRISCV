// The memory hierarchy as distances: one source of numbers for the step's table and the model, distance follows the
// stated log scale, the order of levels is monotonic, an access takes the level's latency, and the cache chapter's quoted
// ranges hold for the constants.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CORE_GHZ, DEFAULT_HITS, LEVELS, REAL_CYCLES, amatCycles, amatShares, cyclesOf } from '../src/widgets/hierarchy3ddata';
import { DESK_TIERS } from '../src/widgets/analogy/mem';
import {
  CORE, NS0, PLACES, placeOf, SCALE, TICKS, accessNs, asSeconds, distOf, elapsedNs, flightSeconds, fmtNs, hierarchyAnchors, levelX, timeAt,
} from '../src/widgets/hierarchy3dparts';
import { hierarchyModel, TOUR_LEVELS } from '../src/widgets/hierarchy3dkit';
import { itemMatrix } from '../src/gl/kit/scene';

const chapter = readFileSync(new URL('../src/chapters/ch-cache.ts', import.meta.url), 'utf8');
const analogy = readFileSync(new URL('../src/chapters/analogies.ts', import.meta.url), 'utf8');
const get = (id: string) => LEVELS.find((l) => l.id === id)!;

describe('the hierarchy model against the chapter', () => {
  it('has the levels the step’s table has, nearest first, strictly slower and strictly farther', () => {
    expect(LEVELS.map((l) => l.id)).toEqual(['reg', 'l1', 'l2', 'l3', 'dram', 'ssd']);
    for (let i = 1; i < LEVELS.length; i++) {
      expect(LEVELS[i].ns).toBeGreaterThan(LEVELS[i - 1].ns);
      expect(levelX(LEVELS[i])).toBeGreaterThan(levelX(LEVELS[i - 1]));
    }
  });
  it('distance is SCALE units per decade of latency from NS0, the table bar’s axis', () => {
    expect(distOf(NS0)).toBe(0);
    expect(distOf(NS0 * 10)).toBeCloseTo(SCALE, 9);
    expect(distOf(NS0 * 1e5)).toBeCloseTo(5 * SCALE, 9);
    for (const l of LEVELS) expect(levelX(l)).toBeCloseTo(SCALE * Math.log10(l.ns / 0.1), 9);
    // The ratio of latencies is the ratio of the powers, not of the distances: the scale is logarithmic.
    expect(get('ssd').ns / get('l1').ns).toBe(80_000);
    expect(levelX(get('ssd')) / levelX(get('l1'))).toBeLessThan(10);
  });
  it('an access takes the level’s latency: the clock at the level’s distance is its latency', () => {
    for (const l of LEVELS) { expect(accessNs(l)).toBeCloseTo(l.ns, 6); expect(timeAt(levelX(l)) / l.ns).toBeCloseTo(1, 12); }
    for (let x = 0; x < 120; x += 7) expect(distOf(timeAt(x))).toBeCloseTo(x, 9);
  });
  it('the cycles shown are ns × the core clock, and sit in the ranges the chapter’s “real” paragraph states', () => {
    expect(CORE_GHZ).toBe(4);
    for (const id of ['l1', 'l2', 'l3', 'dram'] as const) {
      const c = cyclesOf(get(id).ns), [lo, hi] = REAL_CYCLES[id];
      expect(c, id).toBeGreaterThanOrEqual(lo);
      expect(c, id).toBeLessThanOrEqual(hi);
    }
    expect(cyclesOf(get('reg').ns)).toBe(1);
    expect(cyclesOf(get('ssd').ns)).toBe(320_000);
  });
  it('the ranges are the ones in the chapter’s text, and its worked 4 / 12 / 250 cycles lie inside them', () => {
    const flat = chapter.replace(/\s+/g, ' ');
    expect(flat).toContain('L1 32 to 48 KB at 4 to 5 cycles');
    expect(flat).toContain('L2 256 KB to 2 MB at about 12 to 15');
    expect(flat).toContain('L3 of tens of MB at 40 or more, DRAM at 200 or more');
    expect(flat).toContain('amat([[4, 0.05], [12, 0.2]], 250)');
    expect(4).toBeGreaterThanOrEqual(REAL_CYCLES.l1[0]); expect(4).toBeLessThanOrEqual(REAL_CYCLES.l1[1]);
    expect(12).toBeGreaterThanOrEqual(REAL_CYCLES.l2[0]); expect(12).toBeLessThanOrEqual(REAL_CYCLES.l2[1]);
    expect(250).toBeGreaterThanOrEqual(REAL_CYCLES.dram[0]); expect(250).toBeLessThanOrEqual(cyclesOf(get('dram').ns));
  });
  it('the “if a cycle were a second” lines match the step’s own sentence (register 1 s, L1 4 s, DRAM 5 minutes, SSD 4 days)', () => {
    expect(asSeconds(cyclesOf(get('reg').ns))).toBe('1 s');
    expect(asSeconds(cyclesOf(get('l1').ns))).toBe('4 s');
    expect(asSeconds(cyclesOf(get('dram').ns))).toBe('5.3 minutes');
    expect(asSeconds(cyclesOf(get('ssd').ns))).toBe('3.7 days');
    expect(fmtNs(80_000)).toBe('80 µs');
    expect(fmtNs(0.25)).toBe('0.25 ns');
  });
  it('uses no model-clock number: flash is farther than DRAM by the real ratio, not FLASH_TIMES', () => {
    expect(get('ssd').ns / get('dram').ns).toBe(1000);
  });
  it('the places are the analogy’s, in order, and every level has one that holds its distance', () => {
    for (const w of ['your desk', 'a shelf', 'the library', 'a warehouse across town']) expect(analogy.replace(/\s+/g, ' ')).toContain(w);
    expect(PLACES.map((p) => p.id)).toEqual(['desk', 'shelf', 'library', 'warehouse', 'city']);
    for (let i = 1; i < PLACES.length; i++) expect(PLACES[i].x0).toBeGreaterThan(PLACES[i - 1].x1);
    expect(PLACES[0].x0).toBeGreaterThan(CORE.x1);
    // the desk figure's mapping (analogy/mem.ts DESK_TIERS): one analogy, one mapping on the step
    for (const t of DESK_TIERS) expect(LEVELS.find((l) => l.name === t.level)!.place, t.level).toBe(t.place);
    expect(get('reg').place).toBe('core');
    expect(get('ssd').place).toBe('city');
    for (const l of LEVELS) {
      const p = placeOf(l);
      expect(levelX(l)).toBeGreaterThan(p.x0);
      expect(levelX(l)).toBeLessThan(p.x1);
    }
  });
  it('flights are longer for farther levels, and the parts and labels build with no stray values', () => {
    const f = LEVELS.map((l) => flightSeconds(levelX(l)));
    for (let i = 1; i < f.length; i++) expect(f[i]).toBeGreaterThan(f[i - 1]);
    expect(f[5]).toBeLessThan(6);
    const m = hierarchyModel({ x: 30, phase: 'out', target: 2 });
    expect(m.items.length).toBeGreaterThan(20);
    for (const it of m.items) for (const v of it.geo.positions) expect(Number.isFinite(v)).toBe(true);
    // the courier is where the pose puts it; the target's crate is the lit one
    expect(itemMatrix(m.items.find((i) => i.name === 'courier')!, 0)[12]).toBe(30);
    expect(m.items.filter((i) => i.mat.emit).map((i) => i.name)).toEqual([`${LEVELS[2].name}: its data`]);
    // every crate stands at its level's distance, and the tour visits levels by their own views
    LEVELS.forEach((l, k) => { const c = m.items.find((i) => i.name === `${l.name}: its data`)!.geo; expect((c.min[0] + c.max[0]) / 2, `${k}`).toBeCloseTo(levelX(l), 4); });
    expect(m.beats).toHaveLength(TOUR_LEVELS.length);
    const labels = hierarchyAnchors().map((a) => a.text);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).toEqual(['Core', 'Regs', 'L1\nDesk', 'L2\nShelf', 'L3\nLibrary', 'DRAM\nWarehouse', 'SSD\nAnother city']);
    expect(TICKS.map(distOf).every((x, i, a) => i === 0 || x > a[i - 1])).toBe(true);
  });
  it('the clock is a round trip: half the latency at the far end of the outward leg, the whole of it only when the data is home', () => {
    for (const l of LEVELS) {
      const X = levelX(l);
      expect(elapsedNs(l.ns, 'out', 0)).toBe(0);
      expect(elapsedNs(l.ns, 'out', X)).toBeCloseTo(l.ns / 2, 9);
      expect(elapsedNs(l.ns, 'back', X)).toBeCloseTo(l.ns / 2, 9);
      expect(elapsedNs(l.ns, 'back', 0)).toBeGreaterThan(l.ns * 0.75);
      expect(elapsedNs(l.ns, 'idle', 0)).toBe(l.ns);
      let prev = 0;
      for (let s = 0; s <= 20; s++) { const e = elapsedNs(l.ns, 'out', (X * s) / 20); expect(e).toBeGreaterThanOrEqual(prev); prev = e; }
      for (let s = 0; s <= 20; s++) { const e = elapsedNs(l.ns, 'back', X * (1 - s / 20)); expect(e).toBeGreaterThanOrEqual(prev); prev = e; }
    }
  });
  it('on a narrow stage the labels are the short names only, so none overlaps its neighbour', () => {
    expect(hierarchyAnchors(true).map((a) => a.text)).toEqual(['Core', 'Regs', 'L1', 'L2', 'L3', 'DRAM', 'SSD']);
  });
  it('L3 is 64 cycles, in the 40 to 80+ range the row states', () => {
    expect(cyclesOf(get('l3').ns)).toBe(64);
    expect(get('l3').real).toContain('40 to 80+');
  });
  it('AMAT over the table’s latencies: the recursion, the shares add up, and a perfect L1 leaves its own latency', () => {
    const c = (id: string) => cyclesOf(get(id).ns);
    const m = DEFAULT_HITS;
    expect(amatCycles(m)).toBeCloseTo(c('l1') + 0.05 * (c('l2') + 0.2 * (c('l3') + 0.25 * c('dram'))), 9);
    expect(amatShares(m).reduce((a, s) => a + s.cycles, 0)).toBeCloseTo(amatCycles(m), 9);
    expect(amatCycles({ l1: 1, l2: 0.5, l3: 0.5 })).toBe(c('l1'));
    expect(amatCycles({ l1: 0, l2: 0, l3: 0 })).toBe(c('l1') + c('l2') + c('l3') + c('dram'));
    expect(amatCycles({ ...m, l1: 0.9 })).toBeGreaterThan(amatCycles(m));
  });
  it('the chapter says its derivation uses round numbers and where the model’s differ', () => {
    const flat = chapter.replace(/\s+/g, ' ');
    expect(flat).toContain('These are round numbers (L2 12 cycles, DRAM 250, no L3)');
    expect(flat).toContain("(L2 14, L3 64, DRAM 320)");
    expect(cyclesOf(get('l2').ns)).toBe(14);
    expect(cyclesOf(get('dram').ns)).toBe(320);
  });
});
