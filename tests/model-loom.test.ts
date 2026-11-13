// The Jacquard head in 3D against the loom widget's own rule (cards.ts loomPick, which loomWidget draws its cloth from):
// at every pick the hooks left over the knife are the card's holes, the threads lifted follow "hook j lifts j, j + 8, …", the
// cloth row is the widget's row, and the chain loops.
import { describe, expect, it } from 'vitest';
import { HOOKS, LOOM_PRESETS, PICKS, WARP, loomPick } from '../src/widgets/cards';
import { HOOK_BAR_X, HOOK_Z, HOOK_ROW, ROW_A, NEEDLE_H, SHUTTLE_Y, Z_WEFT, Z_HEDDLE, HOOK_Y1, KNIFE_Y, PUSH, SHED, THREAD_X, Z_FELL, clothRow, loomParts, poseOf, steppedPose, type LoomPalette } from '../src/widgets/loom3dparts';
import { bake, FRONT_Z, loomModel, TOUR_T } from '../src/widgets/loom3dkit';
import { UNIT_BOX, UNIT_CYL } from '../src/gl/kit/fromparts';

const col = (i: number): [number, number, number] => [i / 20, 0.5, 0.5];
const P: LoomPalette = { wood: col(1), iron: col(2), steel: col(3), spring: col(4), card: col(5), hole: col(6), warp: col(7), weft: col(8), cord: col(9), lead: col(10), brass: col(11), live: col(12) };
const presets = Object.entries(LOOM_PRESETS).map(([k, v]) => [k, v.cards.map((r) => r.split('').map((c) => c === '1'))] as const);

describe('the Jacquard head model against the loom widget', () => {
  it.each(presets)('%s: lifted hooks are the card\'s holes, lifted threads follow the harness rule, pick by pick', (_k, cards) => {
    for (let p = 1; p <= 3 * PICKS; p++) {
      const L = loomPick(cards, p), o = poseOf(cards, p, 0.5); // shed open
      expect(o.card).toBe(L.card);
      expect(L.card).toBe((p - 1) % cards.length); // the chain loops
      for (let j = 0; j < HOOKS; j++) {
        expect(o.hookLift[j] > 0).toBe(cards[L.card][j]);
        expect(o.hookLift[j] > 0).toBe(L.hooks.includes(j));
        // a blank place pushes needle and hook off the knife; a hole leaves them over it
        expect(o.push[j] > 0).toBe(!cards[L.card][j]);
        if (o.push[j] > 0) expect(o.push[j]).toBe(PUSH);
      }
      for (let w = 0; w < WARP; w++) {
        expect(o.threadLift[w] > 0).toBe(cards[L.card][w % HOOKS]);
        expect(o.threadLift[w] > 0).toBe(L.threads[w]);
        expect(o.threadLift[w]).toBe(o.hookLift[w % HOOKS]);
      }
    }
  });

  it.each(presets)('%s: the cloth row woven at a pick is the widget\'s row, the chain loops down the cloth', (_k, cards) => {
    for (let p = 1; p <= 2 * PICKS; p++) {
      const o = poseOf(cards, p, 0.8);
      expect(o.rows).toBe(p);
      expect(clothRow(cards, p - 1)).toEqual(loomPick(cards, p).threads);
      expect(clothRow(cards, p - 1 + cards.length)).toEqual(clothRow(cards, p - 1));
    }
  });

  it('the drawing holds the same: hooks above the knife where the card has holes, cloth cells where the rule says', () => {
    const [, cards] = presets[0];
    for (const p of [1, 2, 5, 9]) {
      const o = poseOf(cards, p, 0.5), parts = loomParts(cards, o, P), L = loomPick(cards, p);
      // hook bars (iron, tall): their lift above rest is the pose's
      const bars = parts.filter((q) => q.color === P.iron && q.scale![1] === HOOK_Y1 - 34 && Math.abs(q.scale![2] - 2) < 1e-9);
      expect(bars).toHaveLength(HOOKS);
      for (let k = 0; k < HOOKS; k++) {
        const b = bars.find((q) => Math.abs(q.pos[0] - HOOK_BAR_X(k)) < 1e-9 && Math.abs(q.pos[2] - HOOK_Z(k) - (L.hooks.includes(k) ? 0 : PUSH)) < 1e-9)!;
        expect(b.pos[1] - (34 + HOOK_Y1) / 2).toBeCloseTo(L.hooks.includes(k) ? SHED : 0, 9);
        // a blank place's hook sits clear of the knife (z past its end), a hole's over it
        expect(b.pos[2] - HOOK_Z(k) > 1).toBe(!L.hooks.includes(k));
      }
      expect(KNIFE_Y).toBeLessThan(HOOK_Y1);
      // the newest cloth row (at the fell) rebuilt from its cells
      const o2 = poseOf(cards, p, 0.8), cells = loomParts(cards, o2, P).filter((q) => q.kind === 'box' && Math.abs(q.pos[2] - Z_FELL) < 1e-6 && q.pos[1] < 0);
      const row: (boolean | null)[] = new Array(WARP).fill(null);
      for (const c of cells) for (let w = 0; w < WARP; w++) if (Math.abs(THREAD_X(w) - c.pos[0]) <= c.scale![0] / 2) row[w] = c.color === P.warp;
      expect(row).toEqual(L.threads);
    }
  });

  it('the pick cycle runs in the mechanism\'s order', () => {
    const [, cards] = presets[0];
    const at = (T: number) => poseOf(cards, 3, T);
    expect(at(0).away).toBe(1); // starts withdrawn, the next card turned to the front
    expect(at(0.1).away).toBeLessThan(0.2); expect(at(0.12).away).toBe(0); // the cylinder presses the card
    expect(at(0.12).griffe).toBe(0); expect(at(0.35).griffe).toBe(SHED); // then the griffe rises
    expect(at(0.35).shuttleX).toBeCloseTo(-44 * at(0.35).dir); expect(at(0.6).shuttleX).toBeCloseTo(44 * at(0.6).dir);
    expect(at(0.6).reedZ).toBeLessThan(at(0.72).reedZ); expect(at(0.72).weftZ).toBe(Z_FELL); // the beater beats up
    expect(at(0.85).griffe).toBe(0); expect(at(0.85).away).toBe(0); // the griffe is down before the cylinder withdraws
    expect(at(0.92).away).toBe(1); expect(at(1).turn).toBe(1); // withdrawn, then turned
    expect(poseOf(cards, 4, 0).dir).toBe(-at(0).dir); // the shuttle comes back the other way
  });

  it('a stepped view shows the shed open with the row woven, and nothing before the first pick', () => {
    const [, cards] = presets[0];
    expect(steppedPose(cards, 0).rows).toBe(0);
    expect(steppedPose(cards, 0).threadLift.every((v) => v === 0)).toBe(true);
    for (const d of [1, 4, 33]) {
      const o = steppedPose(cards, d);
      expect(o.rows).toBe(d);
      expect(o.threadLift.map((v) => v > 0)).toEqual(loomPick(cards, d).threads);
    }
  });

  it('the weft is thrown in the open shed near the fell, and the beat is short', () => {
    const [, cards] = presets[0], o = poseOf(cards, 3, 0.5);
    expect(Z_FELL - Z_WEFT).toBe(12);
    expect(Z_WEFT).toBeGreaterThan(Z_HEDDLE); // between the heddle plane and the fell
    // the shuttle's box sits between the lowest threads (y 0) and the raised ones at its z: warp height at z is lift * (1 - z / Z_FELL)
    const top = SHED * (1 - Z_WEFT / Z_FELL);
    expect(SHUTTLE_Y + 1.3).toBeLessThan(top); expect(SHUTTLE_Y - 1.3).toBeGreaterThan(0);
    expect(o.reedZ).toBeLessThan(Z_WEFT - 1.8); // the reed stays behind the shuttle, on the beam side
    expect(poseOf(cards, 3, 0.72).reedZ).toBeLessThan(Z_FELL);
  });

  it('eight hooks as two rows of four: needles at two heights, each over the right card row, a knife per row', () => {
    const [, cards] = presets[0], parts = loomParts(cards, poseOf(cards, 2, 0.5), P);
    expect(new Set(Array.from({ length: HOOKS }, (_, k) => NEEDLE_H(k))).size).toBe(2);
    expect(ROW_A[0]).toBeGreaterThan(ROW_A[1]);
    expect(HOOK_ROW(0)).toBe(0); expect(HOOK_ROW(1)).toBe(1);
    const knives = parts.filter((q) => q.color === P.iron && q.scale![0] === 70 && Math.abs(q.scale![1] - 1.6) < 1e-9);
    expect(knives).toHaveLength(2);
    // every needle ends in a tip; the prism has pits (wood boxes) under the hole positions: more pieces than one cube
    expect(parts.filter((q) => q.color === P.wood && q.scale![0] === 72).length).toBeGreaterThan(8);
  });
});

describe('the loom on the studio renderer', () => {
  const [, cards] = presets[0];
  it('every box and rod is baked once (the frame’s front left out), the lifted hooks and cords lit', () => {
    const o = poseOf(cards, 2, 0.3), parts = loomParts(cards, o, P);
    const m = loomModel(cards, o, false), front = parts.filter((p) => p.color === P.wood && Math.abs(p.pos[2] - FRONT_Z) < 1e-6);
    expect(front.length).toBeGreaterThan(0);
    const tris = (p: { kind: string }) => (p.kind === 'box' ? UNIT_BOX : UNIT_CYL).indices.length / 3;
    const want = parts.filter((p) => !front.includes(p)).reduce((a, p) => a + tris(p), 0);
    expect(m.items.reduce((a, i) => a + i.geo.indices.length / 3, 0)).toBe(want);
    for (const it of m.items) for (const v of it.geo.positions) expect(Number.isFinite(v)).toBe(true);
    expect(m.items.filter((i) => i.mat.emit).length).toBeGreaterThan(0);
    expect(m.beats).toHaveLength(TOUR_T.length);
  });
  it('bake puts a turned rod where its part says', () => {
    const rod = loomParts(cards, poseOf(cards, 1, 0), P).find((p) => p.kind === 'cyl' && p.rot)!;
    const g = bake([rod], 'r'), c = [(g.min[0] + g.max[0]) / 2, (g.min[1] + g.max[1]) / 2, (g.min[2] + g.max[2]) / 2];
    for (let a = 0; a < 3; a++) expect(c[a]).toBeCloseTo(rod.pos[a], 3);
  });
});
