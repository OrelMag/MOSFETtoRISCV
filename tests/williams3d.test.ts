import { describe, expect, it } from 'vitest';
import { beamPath, cellOf, deflectionOf, DIGITS, funnelRadius, LINES, spotCentre, spotYZ, WGEOM } from '../src/widgets/williams3dparts';
import { BOX, chargeAt, CHASSIS, lightAt, newTex, PLATE_HALF, PLATE_X, PX, ROW, stamp, staticFace, TEX, williamsModel, type WilliamsState } from '../src/widgets/williams3dkit';
import { DIGIT_S, LEAK_S, Store, THRESH } from '../src/widgets/williams3dview';
import { boundsOf } from '../src/gl/kit/scene';

const state = (o: Partial<WilliamsState> = {}): WilliamsState => ({ cell: null, plate: 0, active: null, pickup: 'mesh', charge: newTex('emit'), display: newTex('emit'), acc: newTex('emit'), ctl: newTex('emit'), ...o });
const px = (tex: ReturnType<typeof newTex>, line: number, digit: number, i: number, j: number) => { const o = ((line * PX + j) * TEX + digit * PX + i) * 4; return [...tex.pixels.slice(o, o + 3)]; };

describe('the Williams tube geometry', () => {
  it('quotes its figures: the CV1131 face drawn 12-inch (300 mm) after Lavington (Computer50 says 6), 32 x 32 spots, a raster inside the glass', () => {
    expect(WGEOM.FACE_D).toBe(300);
    expect(DIGITS * LINES).toBe(1024);
    expect(Math.hypot(...spotYZ(0, 0))).toBeLessThan(WGEOM.FACE_R);
    expect(WGEOM.RASTER).toBe(DIGITS * WGEOM.PITCH);
  });

  it('digit 0 is on the left seen from the front (z positive), digits run left to right, line 0 at the top', () => {
    const [y0, z0] = spotYZ(0, 0), z31 = spotYZ(0, 31)[1], y1 = spotYZ(31, 0)[0];
    expect(z0).toBeGreaterThan(z31);
    expect(spotYZ(0, 1)[1]).toBeLessThan(z0);
    expect(y0).toBeGreaterThan(y1);
    expect(z0 + z31).toBeCloseTo(0, 9); // centred
  });

  it('the beam ends on its spot, leaves the gun on the axis and bends only in and after the plates', () => {
    for (const [l, d] of [[0, 0], [31, 31], [10, 20]]) {
      const p = beamPath(spotCentre(l, d));
      expect(p[0]).toEqual([WGEOM.GUN_X0 + 30, 0, 0]);
      expect(p[p.length - 1]).toEqual(spotCentre(l, d));
      for (const q of p.filter((q) => q[0] <= WGEOM.Y_PLATES[0])) expect(Math.hypot(q[1], q[2])).toBe(0);
      for (let i = 1; i < p.length; i++) expect(p[i][0]).toBeGreaterThan(p[i - 1][0]);
    }
  });

  it('plate voltages are about +-1 at the edges of the raster', () => {
    const tl = deflectionOf(0, 0), br = deflectionOf(31, 31);
    expect(tl.vy).toBeGreaterThan(0.95);
    expect(br.vy).toBeLessThan(-0.95);
    expect(tl.vx).toBeLessThan(-0.95);
    expect(br.vx).toBeGreaterThan(0.95);
    expect(Math.abs(tl.vy + br.vy)).toBeLessThan(1e-9);
  });

  it('the funnel opens from the neck to wider than the face, and the beams stay inside the glass along their whole length', () => {
    expect(funnelRadius(WGEOM.JOIN_X - 10)).toBe(WGEOM.NECK_R + 1);
    expect(funnelRadius(WGEOM.FACE_X - 12)).toBeGreaterThan(WGEOM.FACE_R);
    for (const [l, d] of [[0, 0], [0, 31], [31, 0], [31, 31]]) {
      for (const q of beamPath(spotCentre(l, d)).slice(0, -1)) expect(Math.hypot(q[1], q[2])).toBeLessThan(q[0] <= WGEOM.JOIN_X ? WGEOM.NECK_R : funnelRadius(q[0]));
    }
  });
});


describe('the model', () => {
  const m = williamsModel(state());
  const named = (n: string) => m.items.filter((i) => i.name === n);
  const box = (n: string) => boundsOf({ items: named(n) });

  it('draws the parts the sources name: gun, plates, the face as charge, a pick-up plate covering the raster, the screening box', () => {
    for (const n of ['electron gun', 'Y plates', 'X plates', 'stored charge', 'pick-up plate (wire mesh)', 'screening box', 'glass envelope']) expect(named(n).length, n).toBeGreaterThan(0);
    const p = box('pick-up plate (wire mesh)');
    expect(p.min[0]).toBeGreaterThan(WGEOM.FACE_X + WGEOM.GLASS); // in front of the glass
    expect(PLATE_HALF).toBeGreaterThan(WGEOM.RASTER / 2); // over the whole raster
    expect(Math.min(-p.min[1], p.max[1], -p.min[2], p.max[2])).toBeGreaterThanOrEqual(WGEOM.RASTER / 2);
    expect(williamsModel(state({ pickup: 'plate' })).items.some((i) => i.name === 'pick-up plate')).toBe(true);
  });

  it('the glass is the CV1131’s 300 mm face (sources differ: the card says so), and the charge fills the raster on the face', () => {
    const g = box('glass envelope');
    expect(g.max[1] - g.min[1]).toBeGreaterThan(WGEOM.FACE_D);
    expect(g.max[1] - g.min[1]).toBeLessThan(WGEOM.FACE_D + 20);
    expect(named('glass envelope')[0].info?.dim).toMatch(/sources differ/);
    const f = box('stored charge');
    expect(f.max[1] - f.min[1]).toBeCloseTo(WGEOM.RASTER, 3);
    expect(f.max[0]).toBeCloseTo(WGEOM.FACE_X, 3);
  });

  it('the screening box encloses the tube, the plate and the beam; the pick-up sits inside it', () => {
    const b = box('screening box'), all = boundsOf({ items: m.items.filter((i) => i.group === 'tube' || i.group === 'pickup') });
    for (let a = 0; a < 3; a++) { expect(b.min[a]).toBeLessThanOrEqual(all.min[a]); expect(b.max[a]).toBeGreaterThanOrEqual(all.max[a]); }
    expect(BOX.x1).toBeGreaterThan(PLATE_X);
  });

  it('three store tubes and a display tube in a row, apart; only the display has no plate in front', () => {
    for (const n of ['display tube', 'accumulator tube', 'control tube']) expect(named(n).length, n).toBe(1);
    expect(m.items.filter((i) => i.name === 'pick-up plate').length).toBe(2); // the accumulator's and the control tube's
    const zs = [0, ROW.display, ROW.acc, ROW.ctl];
    for (let k = 1; k < zs.length; k++) expect(zs[k - 1] - zs[k]).toBeGreaterThan(2 * BOX.half);
  });

  it('the beam is drawn only when on, ends on its spot; the regenerator lights the stage working; three chassis', () => {
    expect(m.items.some((i) => i.name === 'electron beam')).toBe(false);
    const on = williamsModel(state({ cell: cellOf(3, 5), active: 'disc', plate: 1 }));
    const beam = boundsOf({ items: on.items.filter((i) => i.name === 'electron beam') }), s = spotCentre(3, 5);
    expect(beam.max[0]).toBeCloseTo(s[0], 0);
    expect(CHASSIS.map((c) => c.name)).toEqual(['amplifier', 'discriminator', 'beam control']);
    expect(on.items.find((i) => i.name === 'discriminator')!.mat.glow).toBeGreaterThan(0);
    expect(on.items.find((i) => i.name === 'amplifier')!.mat.glow ?? 0).toBe(0);
  });

  it('every part a reader can point at has a name, and the tour frames named groups', () => {
    const lit = williamsModel(state({ cell: 0 })), groups = new Set(lit.items.flatMap((i) => [i.group, i.name]));
    for (const b of m.beats!) for (const g of [...(b.frame ?? []), ...(b.show ?? []), ...(b.hide ?? [])]) expect(groups.has(g), `${b.title}: ${g}`).toBe(true);
    expect(m.beats!.length).toBeGreaterThanOrEqual(4);
    for (const a of m.anchors!) expect(groups.has(a.on!), a.text).toBe(true);
  });
});

describe('charge and light', () => {
  it('a patch is positive at its centre with a negative ring; a dash is drawn out along the line', () => {
    expect(chargeAt('dot', 0, 0)).toBeGreaterThan(0.9);
    expect(Math.min(...[1.5, 1.75, 2].map((r) => chargeAt('dot', r, 0)))).toBeLessThan(-0.3);
    expect(chargeAt('dash', 1.4, 0)).toBeGreaterThan(0.9); // still the centre's charge along the line
    expect(chargeAt('dot', 1.4, 0)).toBeLessThan(0);
    expect(chargeAt('dash', 0, 1.4)).toBeCloseTo(chargeAt('dot', 0, 1.4), 9); // across the line: the same
    expect(lightAt('dash', 2, 0)).toBeGreaterThan(0);
    expect(lightAt('dot', 2, 0)).toBe(0);
  });

  it('stamps a spot into its own cell of the texture, amber at the centre; nothing outside the cell changes', () => {
    const t = newTex('emit'), before = [...t.pixels];
    stamp(t, 2, 3, 'dot', 1, 'charge');
    const c = px(t, 2, 3, PX / 2, PX / 2);
    expect(c[0]).toBeGreaterThan(c[2]); // positive: warm
    let changed = 0;
    for (let k = 0; k < t.pixels.length; k += 4) if (t.pixels[k] !== before[k]) { const p = k / 4, u = p % TEX, v = Math.floor(p / TEX); expect(Math.floor(u / PX)).toBe(3); expect(Math.floor(v / PX)).toBe(2); changed++; }
    expect(changed).toBeGreaterThan(0);
    const s = staticFace([1], newTex('emit'));
    expect(px(s, 0, 0, PX / 2 + 2, PX / 2)[0]).toBeGreaterThan(px(s, 0, 1, PX / 2 + 2, PX / 2)[0]); // digit 0 a dash, digit 1 a dot
    expect(px(s, 1, 0, PX / 2, PX / 2)[0]).toBeLessThan(20); // an unused line is blank
  });
});

describe('the store', () => {
  const bits: number[] = Array.from({ length: LINES * DIGITS }, (_, i) => (i % 3 === 0 ? 1 : 0)), ones = bits.reduce((a, b) => a + b, 0);
  it('regenerating, the beam goes round and keeps every bit: the charge never leaks below the threshold', () => {
    const s = new Store(bits);
    s.scan(10 * LINES * DIGITS);
    expect(s.ones()).toBe(ones);
    expect(s.shape.map((x) => (x === 'dash' ? 1 : 0))).toEqual(bits);
    // a full pass is 1 024 digits of 8.5 µs: 8.7 ms, against a 0.2 s leak
    expect(Math.exp(-(LINES * DIGITS * DIGIT_S) / LEAK_S)).toBeGreaterThan(0.95);
  });
  it('reading without writing back leaves a dot: after one pass every bit reads 0', () => {
    const s = new Store(bits);
    s.rewrite = false;
    s.scan(LINES * DIGITS / 2);
    expect(s.ones()).toBe(bits.slice(LINES * DIGITS / 2).reduce((a, b) => a + b, 0));
    s.scan(LINES * DIGITS / 2);
    expect(s.ones()).toBe(0);
  });
  it('left alone the patches leak: past the threshold’s time a one reads as a zero, and the beam cannot bring it back', () => {
    const s = new Store(bits);
    s.tau = -LEAK_S * Math.log(THRESH) * 0.9;
    expect(s.ones()).toBe(ones);
    s.tau = -LEAK_S * Math.log(THRESH) * 1.1;
    expect(s.ones()).toBe(0);
    s.scan(LINES * DIGITS);
    expect(s.ones()).toBe(0);
  });
});

describe('the face’s texture', () => {
  it('is turned onto the face by the item’s rotation (transform() keeps no UVs): u along the digits to −z, v down the lines to −y, facing +x', async () => {
    const { quatRotate } = await import('../src/gl/math');
    const { FACE_Q } = await import('../src/widgets/williams3dkit');
    const r = (v: [number, number, number]) => quatRotate(FACE_Q, v).map((x) => Math.round(x * 1e9) / 1e9 + 0);
    expect(r([1, 0, 0])).toEqual([0, 0, -1]);
    expect(r([0, 1, 0])).toEqual([1, 0, 0]);
    expect(r([0, 0, 1])).toEqual([0, -1, 0]);
    const face = williamsModel(state()).items.find((i) => i.name === 'stored charge')!;
    expect(face.geo.uvs?.length).toBe(8);
    expect(face.mat.data).toBeDefined();
    // texel (digit 0, line 0) is the plane's u = 0, v = 0 corner: after the turn, on spot (0, 0)'s side of the face
    const corner = quatRotate(FACE_Q, [-WGEOM.RASTER / 2, 0, -WGEOM.RASTER / 2]), [y, z] = spotYZ(0, 0);
    expect(Math.sign(corner[1])).toBe(Math.sign(y));
    expect(Math.sign(corner[2])).toBe(Math.sign(z));
  });
});
