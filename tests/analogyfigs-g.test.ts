import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DESK_TIERS, Desk, ISLAND_ENDURANCE, Island, PULSES_TO_PROGRAM, seesawDiffMv, seesawSense, tierCycles } from '../src/widgets/analogy/mem';
import { DRAM_OFFSET_MV, deltaMv } from '../src/widgets/analogy/model';
import { CacheModel } from '../src/sim/cachemodel';
import { LEVELS, cyclesOf } from '../src/widgets/hierarchy3ddata';
import { FG_READ, FG_STEP } from '../src/sim/switchsim';

describe('desk figure', () => {
  it('its tiers and latencies are the hierarchy step table (ns, cycles = ns x 4)', () => {
    for (const t of DESK_TIERS) {
      const r = LEVELS.find((x) => x.name === t.level);
      expect(r, t.level).toBeDefined();
      expect(r!.cap).toBe(t.capacity);
      expect(r!.ns).toBe(t.ns);
      expect(tierCycles(DESK_TIERS.indexOf(t))).toBe(cyclesOf(r!.ns));
    }
    expect(DESK_TIERS.map((t) => t.level)).toEqual(['L1 cache', 'L2 cache', 'L3 cache', 'DRAM']);
    expect(DESK_TIERS.map((_, i) => tierCycles(i))).toEqual([4, 14, 64, 320]);
    // the step's table is drawn from LEVELS
    expect(readFileSync('src/widgets/cache.ts', 'utf8')).toContain("import { LEVELS, cyclesOf } from './hierarchy3ddata'");
  });
  it('a sequential sweep hits 3 of every 4 words on the desk; the first touch of a line walks to the warehouse', () => {
    const d = new Desk();
    for (let i = 0; i < 64; i++) d.access(d.nextAddr('sequential'));
    expect(d.hits).toEqual([48, 0, 0, 16]);
    expect(d.total).toBe(48 * 4 + 16 * 320);
    expect(d.log[0].filled).toBe(0);
    expect(d.log[1].filled).toBeNull();
    expect(d.deskLines()).toEqual([192, 208, 224, 240]);
  });
  it('the desk agrees with a CacheModel run alone, and random access walks further than sequential', () => {
    const d = new Desk(), ref = new CacheModel({ size: 64, line: 16, ways: 1, replacement: 'lru', write: 'wb' });
    for (let i = 0; i < 200; i++) { const a = d.nextAddr('random'); d.access(a); ref.access(a); }
    expect(d.hits[0]).toBe(ref.stats.hits);
    const s = new Desk();
    for (let i = 0; i < 200; i++) s.access(s.nextAddr('sequential'));
    expect(d.average).toBeGreaterThan(s.average);
  });
  it('random addresses are seeded: the same every run', () => {
    const a = new Desk(), b = new Desk();
    expect([0, 1, 2, 3].map(() => a.nextAddr('random'))).toEqual([0, 1, 2, 3].map(() => b.nextAddr('random')));
  });
});

describe('seesaw figure', () => {
  it("precharged, the move is the leaky figure's deltaMv: +-110 mV for a full cell", () => {
    for (const l of [0, 0.3, 0.5, 0.8, 1]) expect(seesawDiffMv(l, true)).toBeCloseTo(deltaMv(l), 9);
    expect(seesawDiffMv(1, true)).toBeCloseTo(110, 6);
    expect(seesawDiffMv(0, true)).toBeCloseTo(-110, 6);
  });
  it('under the sense offset (15 mV) the read is X and the outcome is the coin', () => {
    expect(DRAM_OFFSET_MV).toBeCloseTo(15, 9);
    const half = 0.5 + 14 / 1100 / 0.2; // 14 mV
    expect(seesawSense(half, true, () => true).read).toBe('X');
    expect(seesawSense(half, true, () => true).resolved).toBe(1);
    expect(seesawSense(half, true, () => false).resolved).toBe(0);
    expect(seesawSense(0.5 + 16 / 1100 / 0.2, true, () => false).read).toBe(1);
    expect(seesawSense(1, true).cell).toBe(1);
    expect(seesawSense(0, true).cell).toBe(0);
  });
  it('without precharge the line is already tipped to the rail: a stored 0 still reads 1', () => {
    expect(seesawDiffMv(0, false)).toBeGreaterThan(DRAM_OFFSET_MV);
    expect(seesawSense(0, false).read).toBe(1);
  });
});

describe('island figure', () => {
  it('FG_STEP 0.2 and FG_READ 0.3: erased reads 1, one pulse still 1, two pulses read 0', () => {
    expect([FG_STEP, FG_READ]).toEqual([0.2, 0.3]);
    expect(PULSES_TO_PROGRAM).toBe(2);
    const c = new Island();
    expect(c.read()).toBe(1);
    c.program();
    expect(c.read()).toBe(1);
    c.program();
    expect(c.read()).toBe(0);
    for (let i = 0; i < 10; i++) c.program();
    expect(c.q).toBe(1);
    expect(c.erase()).toBe(true);
    expect(c.q).toBe(0);
    expect(c.read()).toBe(1);
  });
  it("the wear count is FlashDevice's: the 400-erase endurance of the wear widget, then the block is bad", () => {
    expect(readFileSync('src/widgets/flash.ts', 'utf8')).toMatch(/ENDURANCE = 400/);
    expect(ISLAND_ENDURANCE).toBe(400);
    const c = new Island();
    for (let i = 0; i < 400; i++) expect(c.erase()).toBe(true);
    expect(c.erases).toBe(400);
    expect(c.worn).toBe(false);
    expect(c.erase()).toBe(false);
    expect(c.worn).toBe(true);
    expect(c.program()).toBe(false);
  });
});
