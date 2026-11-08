// The 3D models' parts: the kit's geometry, and each model's drawing held to the model behind it.
import { describe, expect, it } from 'vitest';
import type { RGB, RGBA } from '../src/gl/instances';
import { quatRotate, type Vec3 } from '../src/gl/math';
import { box, cyl, flatFaces, rod } from '../src/gl/parts';
import { biasLink } from '../src/widgets/mosshare';
import { contactsFor, depletionAt, DEPL_MAX, lengthNm, NM_PER_UNIT, widthNm, mosAnchors, mosParts, sheetAt, SHEET_MAX, type MosPalette, type MosState } from '../src/widgets/mosfet3dparts';
import { current, depletionDepth, gateCap, sizedCurrent, VDD, VT } from '../src/widgets/mosphys';

const GREY: RGB = [0.5, 0.5, 0.5], CLEAR: RGBA = [0.5, 0.5, 0.5, 0.4];

describe('the kit', () => {
  it('a rod runs between its ends, whichever way it points', () => {
    const ends: [Vec3, Vec3][] = [[[0, 0, 0], [3, 4, 0]], [[1, 2, 3], [1, 7, 3]], [[1, 7, 3], [1, 2, 3]], [[0, 0, 0], [0, 0, -5]], [[-1, -1, -1], [2, 3, 5]]];
    for (const [a, b] of ends) {
      const p = rod(GREY, a, b, 0.5), half = quatRotate(p.rot!, [0, p.scale![1] / 2, 0]);
      for (let k = 0; k < 3; k++) {
        expect(p.pos[k] + half[k]).toBeCloseTo(b[k], 6);
        expect(p.pos[k] - half[k]).toBeCloseTo(a[k], 6);
      }
    }
  });

  it('the flat view shows three faces of a box, nearest last, and half a cylinder', () => {
    expect(flatFaces([box(GREY, 0, 1, 0, 1, 0, 1)], -0.5, 0.5)).toHaveLength(3);
    const near = box(GREY, 0, 1, 0, 1, 10, 11), far = box(GREY, 0, 1, 0, 1, -11, -10), faces = flatFaces([near, far], 0, 0.5);
    expect(faces[0].depth).toBeLessThan(faces[faces.length - 1].depth);
    const n = flatFaces([cyl(GREY, 0, 0, 0, 1, 1)], 0.3, 0.5).length;
    expect(n).toBeGreaterThanOrEqual(6);
    expect(n).toBeLessThanOrEqual(8);
  });

  it('keeps a part’s alpha in the flat view', () => {
    expect(flatFaces([box(CLEAR, 0, 1, 0, 1, 0, 1)], 0.2, 0.5)[0].color[3]).toBeCloseTo(0.4);
  });
});

describe('the MOSFET in 3D', () => {
  const P: MosPalette = { depl: [1, 0.6, 0, 0.4], si: GREY, p: GREY, pClear: CLEAR, n: GREY, poly: [0.8, 0.1, 0.1], oxide: [0.1, 0.2, 0.9, 0.45], metal: [0.7, 0.7, 0.1], charge: [0, 1, 0], carrier: GREY, dim: GREY };
  const st = (o: Partial<MosState> = {}): MosState => ({ vg: 1.2, vd: 0.2, w: 1, l: 1, lift: 0, ...o });
  const sheet = (s: MosState) => mosParts(s, P, []).filter((p) => p.color === P.charge);

  it('current scales with W / L and the reference device is the chapter’s', () => {
    expect(sizedCurrent(1, 0.5)).toBeCloseTo(current(1, 0.5).id, 9);
    expect(sizedCurrent(1, 0.5, 2, 1)).toBeCloseTo(2 * current(1, 0.5).id, 9);
    expect(sizedCurrent(1, 0.5, 1, 2)).toBeCloseTo(current(1, 0.5).id / 2, 9);
    expect(gateCap(2, 3)).toBeCloseTo(6 * gateCap());
  });

  it('no sheet below the threshold', () => {
    expect(sheet(st({ vg: VT - 0.01 }))).toHaveLength(0);
    expect(sheet(st({ vg: VT + 0.3 })).length).toBeGreaterThan(0);
  });

  it('the sheet’s thickness is the charge: full at the source, thinning to the drain, the maximum never passed', () => {
    const s = st({ vg: VDD, vd: 0.5 });
    expect(sheetAt(s, 0)).toBeCloseTo(SHEET_MAX);
    expect(sheetAt(s, 1)).toBeLessThan(sheetAt(s, 0));
    for (const seg of sheet(s)) expect(seg.scale![1]).toBeLessThanOrEqual(SHEET_MAX + 1e-9);
    const drawn = sheet(s).map((p) => p.scale![1]);
    for (let i = 1; i < drawn.length; i++) expect(drawn[i]).toBeLessThan(drawn[i - 1]);
  });

  it('in saturation the sheet stops short of the drain', () => {
    const s = st({ vg: 1, vd: 1.5 }), hl = 6, last = sheet(s).at(-1)!;
    expect(sheetAt(s, 1)).toBe(0);
    expect(last.pos[0]).toBeLessThan(hl);
  });

  it('W widens the sheet and L lengthens it, each by its factor', () => {
    const one = sheet(st())[0], wide = sheet(st({ w: 2 }))[0], long = sheet(st({ l: 2 }))[0];
    expect(wide.scale![2]).toBeCloseTo(2 * one.scale![2]);
    expect(long.scale![0]).toBeCloseTo(2 * one.scale![0]);
  });


  it('the depletion layer follows mosphys: √Vgs up to Vt, then no deeper', () => {
    const dep = (vg: number) => mosParts(st({ vg }), P, []).filter((p) => p.color === P.depl);
    expect(dep(0)).toHaveLength(0);
    const depth = (vg: number) => dep(vg)[0].scale![1];
    expect(depth(0.3)).toBeCloseTo(DEPL_MAX * depletionDepth(0.3), 9);
    expect(depth(0.3)).toBeLessThan(depth(VT));
    expect(depth(VT)).toBeCloseTo(DEPL_MAX, 9);
    expect(depth(VDD)).toBeCloseTo(DEPL_MAX, 9);
    expect(depletionAt(VT / 2)).toBeCloseTo(DEPL_MAX / Math.SQRT2, 9);
  });

  it('proportions: a 180 nm channel, a 4 nm oxide under a 200 nm gate than it', () => {
    expect(lengthNm(1)).toBe(180);
    expect(widthNm(2)).toBe(480);
    const parts = mosParts(st(), P, []), ox = parts.find((p) => p.color === P.oxide && p.scale![0] > 10)!, poly = parts.find((p) => p.color === P.poly)!;
    expect(ox.scale![1] * NM_PER_UNIT).toBeCloseTo(4, 6);
    expect(poly.scale![1] * NM_PER_UNIT).toBeCloseTo(200, 6);
  });

  it('contacts are arrayed along W: a row per island, within the width, and the gate contact stays alone', () => {
    for (const w of [1, 2, 4]) {
      const cs = mosParts(st({ w }), P, []).filter((p) => p.color === P.metal);
      expect(cs).toHaveLength(2 * contactsFor(w) + 1);
      const hw = (16 * w) / 2;
      for (const c of cs) expect(Math.abs(c.pos[2])).toBeLessThanOrEqual(hw);
    }
    expect(contactsFor(4)).toBeGreaterThan(contactsFor(1));
  });

  it('dimension labels carry units', () => {
    const t = mosAnchors(st({ w: 2, l: 1 })).map((a) => a.text);
    expect(t).toContain('L = 180 nm');
    expect(t).toContain('W = 480 nm');
    expect(new Set(t).size).toBe(t.length);
  });

  it('the 3D and 2D views share one bias: each hears the other, never itself', () => {
    const link = biasLink(), a = {}, b = {}, seen: string[] = [];
    link.follow(a, (g, d) => seen.push("a" + g + "," + d));
    link.follow(b, (g, d) => seen.push("b" + g + "," + d));
    link.set(1.2, 0.5, a);
    expect(seen).toEqual(['b1.2,0.5']);
    expect([link.vg, link.vd]).toEqual([1.2, 0.5]);
    link.set(1.2, 0.5, b);
    expect(seen).toHaveLength(1);
  });

  it('lifting the gate moves only the gate and its contact, and every label stays on a finite point', () => {
    const a = mosParts(st({ lift: 0 }), P, []), b = mosParts(st({ lift: 6 }), P, []);
    expect(b).toHaveLength(a.length);
    expect(a.filter((p, i) => p.pos[1] !== b[i].pos[1])).toHaveLength(2);
    for (const l of mosAnchors(st())) expect(l.p.every(Number.isFinite)).toBe(true);
  });
});
