// The colour picture tube on the studio renderer (widgets/crt3dkit.ts) held to its sources and to crt3dparts.ts: the 29.1 mm
// neck (Toshiba 1974), the mask's pitch, hole and steel inside the patents' ranges, the screen as a texture that is CrtRun's
// cells (mirrored for a surface facing the viewer), the beams ending on the dot beamPath gives, and one layer at a time.
import { describe, expect, it } from 'vitest';
import { boundsOfNamed } from '../src/gl/kit/scene';
import { quatRotate, type Vec3 } from '../src/gl/math';
import { CrtRun, GEOM, MASK, W, beamAt, beamPath, levelsOf, spotOf, timingFor } from '../src/widgets/crt3dparts';
import { BEAT_VIEW, FRAME_GROUPS, SCREEN_GAIN, SRC, beamSegments, crtModel, ghostSegments, newScreenTex, quatFromY, screenPixels, type CrtLook } from '../src/widgets/crt3dkit';
import { barsPicture, ringsPicture } from '../src/gfx/scenepics';

const rgb: CrtLook['rgb'] = { r: [1, 0, 0], g: [0, 1, 0], b: [0, 0, 1], ghost: [0.6, 0.6, 0.7], copper: [0.8, 0.5, 0.2], heater: [1, 0.6, 0.2] };
const look = (o: Partial<CrtLook> = {}): CrtLook => ({ detail: 'full', view: 'overview', tex: newScreenTex(), cell: () => [0, 0, 0], beam: null, levels: [0, 0, 0], current: { h: 0, v: 0 }, rgb, ...o });
const named = (m: ReturnType<typeof crtModel>, n: string) => m.items.filter((it) => it.name === n);
const PICS: [Uint8Array, Uint8Array] = [barsPicture(), ringsPicture()];

describe('sourced figures', () => {
  it('the neck is 29.1 mm across (Toshiba 1974, US6107729), drawn at that size', () => {
    expect(GEOM.NECK_OD).toBe(29.1);
    expect(SRC.neck).toContain('29.1');
    const neck = named(crtModel(look()), 'neck')[0];
    expect(neck.geo.max[1] - neck.geo.min[1]).toBeCloseTo(29.1, 1);
  });
  it('the mask is inside the patents’ ranges: pitch 0.2–0.3 mm, hole 0.08–0.14 mm (US6107729), steel 0.15–0.2 mm (US4707633)', () => {
    expect(GEOM.TRIAD).toBeGreaterThanOrEqual(0.2); expect(GEOM.TRIAD).toBeLessThanOrEqual(0.3);
    expect(MASK.HOLE).toBeGreaterThanOrEqual(0.08); expect(MASK.HOLE).toBeLessThanOrEqual(0.14);
    expect(MASK.THICK).toBeGreaterThanOrEqual(0.15); expect(MASK.THICK).toBeLessThanOrEqual(0.2);
    expect(SRC.triad).toContain('0.2 to 0.3'); expect(SRC.hole).toContain('0.08 to 0.14'); expect(SRC.mask).toContain('0.15 to 0.2');
    expect(GEOM.GUN_PITCH).toBe(5.08);
  });
  it('the screen spans the 4:3 picture on the face, facing the viewer (+x)', () => {
    const s = named(crtModel(look()), 'phosphor screen')[0].geo;
    // the curved face pulls the edges back toward the deflection centre: spotOf's own extent, a little inside 272 × 204 mm
    expect(s.max[2] - s.min[2]).toBeCloseTo(spotOf(0, W / 2)[2] - spotOf(W, W / 2)[2], 3);
    expect(s.max[1] - s.min[1]).toBeCloseTo(spotOf(W / 2, 0)[1] - spotOf(W / 2, W)[1], 3);
    expect(s.max[2] - s.min[2]).toBeGreaterThan(GEOM.W_MM * 0.95);
    let out = 0;
    for (let k = 0; k < s.normals.length; k += 3) if (s.normals[k] > 0.9) out++;
    expect(out).toBe(s.normals.length / 3);
  });
});

describe('the screen is CrtRun’s cells', () => {
  it('each texel is its cell’s colour times its glow, mirrored across (the surface runs right to left seen from the front)', () => {
    const run = new CrtRun(timingFor('a'), PICS), px = new Uint8Array(W * W * 4), tau = 1e9;
    run.advance(W * 4); // the first row lit
    screenPixels(run, W * 4, tau, px);
    for (const i of [0, 5, 63]) {
      const c = levelsOf(run.litCol[i]), g = run.glow(i, W * 4, tau), o = 4 * (W - 1 - i);
      expect(px[o]).toBe(Math.round(255 * SCREEN_GAIN * g * c[0]));
      expect(px[o + 1]).toBe(Math.round(255 * SCREEN_GAIN * g * c[1]));
      expect(px[o + 3]).toBe(255);
    }
    // a row the beam has not reached is dark
    expect(px[4 * (5 * W) + 0] + px[4 * (5 * W) + 1] + px[4 * (5 * W) + 2]).toBe(0);
  });
});

describe('the beams', () => {
  it('a segment per leg of beamPath for each lit gun, the last one ending on its dot', () => {
    const b = beamAt(timingFor('a'), 100.5), segs = beamSegments(b, [1, 1, 1], rgb), path = beamPath(0, spotOf(b.x, b.y));
    expect(segs).toHaveLength(3 * (path.length - 1));
    const g = segs.slice(path.length - 1, 2 * (path.length - 1)), last = g[g.length - 1];
    const end = quatRotate(last.rot!, [0, last.scale![1] / 2, 0]).map((v, k) => v + last.pos[k]) as Vec3;
    end.forEach((v, k) => expect(v).toBeCloseTo(path[path.length - 1][k], 6));
    expect(beamSegments(b, [1, 0, 0], rgb)).toHaveLength(path.length - 1);
  });
  it('blanked: no beam, one faint ghost', () => {
    const tm = timingFor('b'), b = beamAt(tm, tm.hAct + 3.5);
    expect(b.blanked).toBe(true);
    expect(beamSegments(b, [1, 1, 1], rgb)).toHaveLength(0);
    expect(ghostSegments(b, rgb).length).toBeGreaterThan(0);
  });
  it('quatFromY turns +y onto any direction', () => {
    for (const d of [[1, 0, 0], [0, 0, -1], [0.3, -0.8, 0.5], [0, -1, 0]] as Vec3[]) {
      const l = Math.hypot(...d), r = quatRotate(quatFromY(d), [0, 1, 0]);
      r.forEach((v, k) => expect(v).toBeCloseTo(d[k] / l, 9));
    }
  });
});

describe('the subject first', () => {
  it('opened along the axis on the camera’s side; the screen, faceplate and band stay whole', () => {
    const m = crtModel(look());
    expect(m.cuts!.planes).toEqual([{ n: [0, 0, 1], d: 0 }]);
    for (const n of ['phosphor screen', 'faceplate', 'implosion band']) expect(named(m, n)[0].cut).toBe('none');
    for (const g of ['tubebox', 'screenbox', 'gunbox', 'yokebox']) expect(m.items.some((it) => it.group === g)).toBe(true);
    expect(BEAT_VIEW.length).toBe(m.beats!.length);
  });
  it('the frames hold what they frame: the gun box the electrodes, the tube box the whole tube', () => {
    const m = crtModel(look()), gun = boundsOfNamed(m, ['gunbox']), cath = boundsOfNamed(m, ['cathodes']);
    for (let a = 0; a < 3; a++) { expect(gun.min[a]).toBeLessThanOrEqual(cath.min[a]); expect(gun.max[a]).toBeGreaterThanOrEqual(cath.max[a]); }
  });
  it('the Mask view is a model of its own: the patch, its dots and the frame, no tube', () => {
    const m = crtModel(look({ view: 'mask', beam: beamAt(timingFor('a'), 0.5), levels: [1, 1, 1] }));
    expect(m.items.some((it) => it.name === 'funnel')).toBe(false);
    expect(named(m, 'R · G · B dots')).toHaveLength(3 * MASK.COLS * MASK.ROWS);
    expect(m.items.some((it) => it.group === 'maskbox')).toBe(true);
    expect(named(m, 'the beams cross in this hole')).toHaveLength(3);
    expect(FRAME_GROUPS).toContain('maskbox');
  });
  it('the flat drawing has the screen as 32 × 32 cells and the beam as parts', () => {
    const b = beamAt(timingFor('a'), 100.5), m = crtModel(look({ detail: 'flat', beam: b, levels: [1, 1, 1] }));
    expect(named(m, 'phosphor screen')).toHaveLength(32 * 32);
    expect(named(m, 'electron beams')).toHaveLength(3);
  });
});
