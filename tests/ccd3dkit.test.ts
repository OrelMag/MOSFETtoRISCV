// The CCD's studio model (widgets/ccd3dkit.ts) held to its sources and to CcdRun: the datasheet's package, pins and image area,
// its typical bias on the gates' cards, the gates overlapping a third of the pitch each, the potential surface deep under the
// high phases only, and the electrons: as many as the charge, under the oxide, following the clock.
import { describe, expect, it } from 'vitest';
import { CcdRun, CHANNEL, COLS, FULL_WELL, GATE, PITCH, ROWS, WELL_HI, WELL_LO, highAt, phaseOf } from '../src/widgets/ccd3dparts';
import { BEADS_FULL, BEAT_LAYERS, BIAS, FRAME_GROUPS, PACKAGE, SRC, beadsOf, ccdModel, depthAt, electrons, highs, profile, type CcdLook } from '../src/widgets/ccd3dkit';

const rgb: CcdLook['rgb'] = { si: [0.5, 0.5, 0.6], p: [0.3, 0.5, 0.7], n: [0.8, 0.4, 0.5], poly: [0.8, 0.4, 0.4], oxide: [0.8, 0.8, 0.9], metal: [0.6, 0.6, 0.7], well: [0.3, 0.5, 0.8], charge: [0.2, 0.8, 0.5], hot: [1, 0.7, 0.3] };
const exposed = () => { const r = new CcdRun(); r.expose(1); return r; };
const look = (o: Partial<CcdLook> = {}): CcdLook => ({ detail: 'full', run: exposed(), t: 1, moving: 'idle', layers: new Set(), rgb, ...o });
const named = (m: ReturnType<typeof ccdModel>, n: string) => m.items.filter((it) => it.name === n);

describe('the datasheet', () => {
  it('the package: ceramic DIL 37.0 × 51.7 mm, 24 pins at 2.54 mm, rows 45.72 mm apart; a 27.6 mm image area (2048 × 13.5 µm)', () => {
    expect(PACKAGE).toEqual({ w: 37.0, l: 51.7, pins: 24, pinPitch: 2.54, rows: 45.72, image: 27.6 });
    expect((2048 * PITCH) / 1000).toBeCloseTo(PACKAGE.image, 1);
    const m = ccdModel(look({ layers: new Set(['package']) })), body = named(m, 'ceramic package')[0];
    expect((body.geo.max[0] - body.geo.min[0]) / 1000).toBeCloseTo(PACKAGE.w, 3);
    expect((body.geo.max[2] - body.geo.min[2]) / 1000).toBeCloseTo(PACKAGE.l, 3);
    const pins = named(m, 'pin');
    expect(pins).toHaveLength(24);
    const zs = [...new Set(pins.map((p) => Math.round(p.at![2])))];
    expect(zs).toHaveLength(2);
    expect(Math.abs(zs[0] - zs[1]) / 1000).toBeCloseTo(PACKAGE.rows, 3);
    expect(body.info?.source).toBe(SRC.pkg);
  });
  it('the cards quote its typical bias: image clocks 0 / 10 V, register 1 / 11 V, OG1 3 V, OD 29 V, RD 17 V, DD 24 V', () => {
    expect(BIAS).toMatchObject({ image: [0, 10], register: [1, 11], og1: 3, od: 29, rd: 17, dd: 24 });
    const m = ccdModel(look());
    expect(named(m, 'output gate')[0].info?.note).toContain('3 V');
    expect(named(m, 'reset drain')[0].info?.note).toContain('17 V');
    expect(m.items.find((it) => it.name?.startsWith('image gate'))!.info?.note).toContain('0 to 10 V');
  });
});

describe('the gates and the potential', () => {
  it('three gates a pixel, each a third of the pitch, overlapping its neighbours', () => {
    expect(GATE * 3).toBeCloseTo(PITCH, 9);
    const g = ccdModel(look()).items.filter((it) => it.name?.startsWith('image gate'));
    expect(g).toHaveLength(3 * ROWS);
    for (const it of g) expect(it.geo.max[2] - it.geo.min[2]).toBeGreaterThan(GATE);
  });
  it('the well is deep exactly under the high phases, and the profile is continuous between gates', () => {
    for (let s = 0; s < 6; s++) {
      const hi = highAt(s);
      for (let g = 0; g < 3 * ROWS; g++) expect(depthAt(g, hi)).toBe(hi.includes(phaseOf(g)) ? WELL_HI : WELL_LO);
      for (let x = 0.01; x < 3 * ROWS; x += 0.01) expect(Math.abs(profile(x, 3 * ROWS, hi) - profile(x - 0.01, 3 * ROWS, hi))).toBeLessThan(0.2);
      for (let g = 0; g < 3 * ROWS; g++) expect(profile(g + 0.5, 3 * ROWS, hi)).toBe(depthAt(g, hi));
    }
  });
  it('a waiting register rests with φ1 high', () => {
    const r = exposed();
    expect(highs(r, 'idle')).toEqual({ v: [1], h: [1] });
    r.step();
    expect(highs(r, 'vertical').v).toEqual(highAt(1));
  });
});

describe('the electrons', () => {
  it('as many beads as the charge (full well = BEADS_FULL), at least one for any charge', () => {
    expect(beadsOf(FULL_WELL)).toBe(BEADS_FULL);
    expect(beadsOf(1)).toBe(1);
    expect(beadsOf(0)).toBe(0);
    const r = exposed(), total = r.v.flat().reduce((t, e) => t + beadsOf(e), 0);
    expect(electrons(r, 1, 'idle', rgb.charge)).toHaveLength(total);
  });
  it('sit in the channel’s wells, under the oxide, inside their column', () => {
    const r = exposed();
    for (const b of electrons(r, 1, 'idle', rgb.charge)) {
      expect(b.pos[1]).toBeLessThan(CHANNEL);
      expect(b.pos[1]).toBeGreaterThan(CHANNEL - WELL_HI - 0.01);
      const c = Math.floor(b.pos[0] / PITCH);
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThan(COLS);
      expect(b.pos[0] - c * PITCH).toBeGreaterThan(1);
      expect((c + 1) * PITCH - b.pos[0]).toBeGreaterThan(1);
    }
  });
  it('follow the clock: a step moves them half a gate toward the register, six a pixel', () => {
    const r = exposed(), meanZ = () => { const e = electrons(r, 1, 'idle', rgb.charge); return e.reduce((t, b) => t + b.pos[2], 0) / e.length; };
    const z0 = meanZ();
    r.step();
    expect(meanZ() - z0).toBeCloseTo(-GATE / 2, 1);
  });
});

describe('the subject first, one layer at a time', () => {
  it('home is the corner, cut open; the light and the package only with their layers', () => {
    const m = ccdModel(look());
    expect(m.items.some((it) => it.group === 'light' || it.group === 'package')).toBe(false);
    expect(ccdModel(look({ layers: new Set(['light']) })).items.some((it) => it.group === 'light')).toBe(true);
    expect(m.cuts!.planes).toHaveLength(1);
    for (const g of FRAME_GROUPS) expect(m.items.some((it) => it.group === g)).toBe(true);
    expect(BEAT_LAYERS.length).toBe(m.beats!.length);
    BEAT_LAYERS.forEach((ls, i) => expect(ls.includes('package')).toBe(m.beats![i].title === 'The whole chip'));
  });
});
