import { describe, expect, it } from 'vitest';
import {
  BLOCK_X, CHOSEN, CORE_NM, HOLES, HOLE_NM, LEVELS, ONO_NM, ONO_SPLIT_NM, PITCH_NM, POLY_NM, RINGS, SLIT_NM, SLIT_W, SLIT_Z, STACK_TOP, STAIR_K, STAIR_UM, TREAD, WORD_LINES,
  levelEnd, levelOfWl, levelY,
} from '../src/flash/string3d';
import { nandBlock } from '../src/lib/flash';
import { PULSES_TO_PROGRAM, electrons, program, stringConducts, type Bank } from '../src/phys/fgate';
import { flatten } from '../src/sim/flatten';
import { FG_STEP, SwitchSim } from '../src/sim/switchsim';
import { B0, B1 } from '../src/sim/types';
import { boundsOf } from '../src/gl/kit/scene';
import { CUT_Z, MATS, freshString, nandModel, plateRects, trappedAt } from '../src/widgets/nand3dkit';

describe('the 3D NAND block (flash/string3d.ts): the sources\' numbers', () => {
  it('the hole, its films and the core: 120 nm, 22 nm of ONO, 11 nm of channel, and the 54 nm core they leave', () => {
    expect([HOLE_NM, ONO_NM, POLY_NM]).toEqual([120, 22, 11]);
    expect(CORE_NM).toBe(54);
    // the typical split adds up to the sourced total, and the rings close up from the hole wall to the core
    expect(ONO_SPLIT_NM.blocking + ONO_SPLIT_NM.nitride + ONO_SPLIT_NM.tunnel).toBe(ONO_NM);
    expect(RINGS.hole * 2 * 10).toBeCloseTo(HOLE_NM, 9);
    expect(RINGS.blocking[1]).toBe(RINGS.hole);
    expect(RINGS.nitride[1]).toBe(RINGS.blocking[0]);
    expect(RINGS.tunnel[1]).toBe(RINGS.nitride[0]);
    expect(RINGS.poly[1]).toBe(RINGS.tunnel[0]);
    expect(RINGS.core).toBe(RINGS.poly[0]);
    expect(RINGS.core * 2 * 10).toBeCloseTo(CORE_NM, 9);
  });
  it('38 levels: a ground select, two dummies, 32 word lines, two dummies, a string select', () => {
    expect(LEVELS.length).toBe(38);
    expect(LEVELS.filter((l) => l.kind === 'wl').length).toBe(WORD_LINES);
    expect(LEVELS.filter((l) => l.kind === 'dummy').length).toBe(4);
    expect([LEVELS[0].kind, LEVELS[LEVELS.length - 1].kind]).toEqual(['gsl', 'ssl']);
    for (let w = 0; w < WORD_LINES; w++) expect(LEVELS[levelOfWl(w)].wl).toBe(w);
    expect(levelOfWl(1)).toBe(levelOfWl(0) + 1);
  });
  it('44 nm a level (the 128-layer part\'s pitch, labelled so), a 1.67 µm stack, levels that never touch', () => {
    expect(PITCH_NM).toBe(44);
    expect(STACK_TOP * 10).toBeCloseTo(38 * 44, 9);
    for (let i = 1; i < LEVELS.length; i++) expect(levelY(i)[0]).toBeGreaterThan(levelY(i - 1)[1]);
    expect(levelY(LEVELS.length - 1)[1]).toBeLessThan(STACK_TOP);
  });
  it('slits 725 nm apart; four staggered rows of holes between them, none touching another or a slit', () => {
    expect(SLIT_Z * 2 * 10).toBeCloseTo(SLIT_NM, 9);
    expect(SLIT_NM).toBe(725);
    expect(HOLES.length).toBe(22);
    for (let i = 0; i < HOLES.length; i++) {
      for (let j = i + 1; j < HOLES.length; j++) expect(Math.hypot(HOLES[i][0] - HOLES[j][0], HOLES[i][1] - HOLES[j][1])).toBeGreaterThan(2 * RINGS.hole + 1);
      expect(SLIT_Z - SLIT_W / 2 - Math.abs(HOLES[i][1])).toBeGreaterThan(RINGS.hole);
      expect(Math.abs(HOLES[i][0]) + RINGS.hole).toBeLessThan(BLOCK_X);
    }
    // the pitch along a row is the article's 260 nm
    const row = HOLES.filter((h) => h[1] === HOLES[0][1]);
    expect((row[1][0] - row[0][0]) * 10).toBeCloseTo(260, 9);
  });
  it('the staircase: one tread per level over about 20 µm, drawn one stated factor shorter', () => {
    expect(STAIR_UM).toBe(20);
    expect(STAIR_K).toBe(12);
    expect(TREAD * STAIR_K * LEVELS.length * 10).toBeCloseTo(STAIR_UM * 1000, 6);
    for (let i = 1; i < LEVELS.length; i++) expect(levelEnd(i - 1) - levelEnd(i)).toBeCloseTo(TREAD, 9);
    expect(levelEnd(LEVELS.length - 1)).toBeGreaterThan(BLOCK_X);
  });
});

/** The chapter's planar string, nandBlock(1, 8), on the switch-level solver: the cells' charges set, a read of each row. */
function planarReads(q: readonly number[]): number[] {
  const def = nandBlock(1, 8), design = flatten(def, { mode: 'switch' }), sim = new SwitchSim(design);
  const fg = design.leaves.flatMap((l, i) => (l.kind === 'fgmos' ? [[l.node.path.join('.'), i] as const] : []));
  for (let r = 0; r < 8; r++) sim.setFgCharge(fg.find(([p]) => p === `c${r}_0`)![1], q[r]);
  const out: number[] = [];
  for (let r = 0; r < 8; r++) {
    for (const [k, v] of Object.entries({ pgm: 0, ers: 0, din0: 1, row: r, rd: 1 })) sim.setInput(k, v);
    sim.settle();
    const b = sim.get(design.root.ports.dout0[0]);
    out.push(b === B1 ? 1 : b === B0 ? 0 : -1);
  }
  return out;
}

describe('the pillar is the chapter\'s string stood up', () => {
  const full = Math.min(1, PULSES_TO_PROGRAM * FG_STEP);
  it('for every pattern of 8 erased or programmed cells, each read equals nandBlock(1, 8)\'s on the switch-level solver', () => {
    for (let pat = 0; pat < 256; pat++) {
      const q = Array.from({ length: 8 }, (_, r) => ((pat >> r) & 1 ? full : 0));
      const ours = Array.from({ length: 8 }, (_, sel) => (stringConducts({ q, sel }) ? 1 : 0));
      expect(ours, `pattern ${pat.toString(2).padStart(8, '0')}`).toEqual(planarReads(q));
    }
  });
  it('and for partly programmed cells (one pulse short, one pulse)', () => {
    const levels = [0, FG_STEP, (PULSES_TO_PROGRAM - 1) * FG_STEP, full];
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
    for (let n = 0; n < 40; n++) {
      const q = Array.from({ length: 8 }, () => levels[Math.floor(rnd() * levels.length)]);
      expect(Array.from({ length: 8 }, (_, sel) => (stringConducts({ q, sel }) ? 1 : 0))).toEqual(planarReads(q));
    }
  });
});

describe('the 3D NAND model (widgets/nand3dkit.ts)', () => {
  it('the plates cover the block between the slits and out to their tread, holes left out', () => {
    for (const i of [0, 20, LEVELS.length - 1]) {
      const area = plateRects(levelEnd(i)).reduce((a, r) => a + (r.x1 - r.x0) * (r.z1 - r.z0), 0);
      const zIn = SLIT_Z - SLIT_W / 2;
      expect(area).toBeCloseTo((levelEnd(i) + BLOCK_X) * 2 * zIn, 6);
      expect(plateRects(levelEnd(i)).filter((r) => r.hole).length).toBe(HOLES.length);
    }
    expect(CUT_Z).toBe(HOLES[CHOSEN][1]);
  });
  it('a program pulse puts electrons into the chosen word line\'s level only, in the nitride ring', () => {
    let b: Bank = freshString();
    expect(trappedAt(b).length).toBe(0);
    b = { ...b, sel: 5 };
    for (let k = 0; k < PULSES_TO_PROGRAM; k++) b = program(b);
    const pts = trappedAt(b), [y0, y1] = levelY(levelOfWl(5)), [hx, hz] = HOLES[CHOSEN];
    expect(pts.length).toBe(electrons(b.q[5]));
    for (const p of pts) {
      expect(p[1]).toBeGreaterThan(y0); expect(p[1]).toBeLessThan(y1);
      const r = Math.hypot(p[0] - hx, p[2] - hz);
      expect(r).toBeGreaterThan(RINGS.nitride[0]); expect(r).toBeLessThan(RINGS.nitride[1]);
    }
  });
  it('the channel lights exactly when the string conducts', () => {
    const lit = (b: Bank, reading: boolean) => nandModel({ bank: b, reading }).items.find((i) => i.name === 'the chosen string\'s channel')!.mat === MATS.polyOn;
    let b = { ...freshString(), sel: 3 };
    expect(lit(b, true)).toBe(true);
    expect(lit(b, false)).toBe(false);
    for (let k = 0; k < PULSES_TO_PROGRAM; k++) b = program(b);
    expect(lit(b, true)).toBe(false);
    expect(lit({ ...b, sel: 4 }, true)).toBe(true);
  });
  it('every part is named and finite, typical sizes say so, anchors are unique, seven beats', () => {
    const m = nandModel({ bank: freshString(), reading: false });
    for (const it of m.items) {
      expect(it.geo.positions.every(Number.isFinite), it.name).toBe(true);
      expect(it.mat.label, it.name).toBeTruthy();
    }
    const card = (n: string) => m.items.find((i) => i.name === n)!.info!;
    for (const n of ['blocking oxide', 'charge trap (nitride)', 'tunnel oxide']) expect(card(n).dim).toMatch(/typical/);
    expect(card('word line').dim).toMatch(/128-layer/);
    expect(card('word-line contact').dim).toMatch(new RegExp(`${STAIR_K}× shorter`));
    expect(card('oxide core').dim).toMatch(/calculated/);
    expect(new Set(m.anchors!.map((a) => a.text)).size).toBe(m.anchors!.length);
    expect(m.beats!.length).toBe(7);
    const { min, max } = boundsOf(m);
    expect(max[1]).toBeGreaterThan(STACK_TOP);
    expect(min[0]).toBeLessThan(-BLOCK_X);
  });
});
