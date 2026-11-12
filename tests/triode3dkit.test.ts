import { describe, expect, it } from 'vitest';
import { M } from '../src/gl/kit/materials';
import { boundsOf, cutsAt, isCut, pick } from '../src/gl/kit/scene';
import { tubeModel, XA } from '../src/widgets/triode3dkit';
import { pinPos, stateAt } from '../src/widgets/triode3dview';

const look = { charge: true, detail: 'full' as const, electron: M.steel };

describe('the 6SN7 studio model', () => {
  const m = tubeModel(stateAt(0, 20), look);
  it('stands on its key post and fits a T-9 bulb 28.6 mm across', () => {
    const { min, max } = boundsOf(m);
    expect(min[1]).toBeCloseTo(-12.5, 1);
    expect(max[1]).toBeCloseTo(70, 1);
    expect(Math.max(max[0], -min[0], max[2], -min[2])).toBeLessThanOrEqual(15.1 + 1e-6); // the base rim, 0.3 proud of the base
    const glass = m.items.find((i) => i.name === 'glass bulb')!;
    expect(glass.geo.max[0]).toBeCloseTo(14.3, 2);
  });
  it('every named part has a material label, and the bulb and pins carry a source', () => {
    for (const it of m.items) if (it.name) expect(it.mat.label, it.name).toBeTruthy();
    expect(m.items.find((i) => i.name === 'glass bulb')!.info?.source).toMatch(/6SN7/);
    expect(m.items.find((i) => i.name?.startsWith('pin 1'))!.info?.source).toMatch(/octal/);
  });
  it('the pins sit on the 17.45 mm circle', () => {
    for (let k = 1; k <= 8; k++) expect(Math.hypot(...pinPos(k))).toBeCloseTo(17.5 / 2, 6);
  });
  it('a ray from the front meets the glass only when asked, else the plate; with the cut open, the cathode inside', () => {
    const o: [number, number, number] = [XA, 41, 200], d: [number, number, number] = [0, 0, -1];
    expect(pick(m, o, d, { explode: 0, cut: 0 }, { glass: true })?.item.name).toBe('glass bulb');
    expect(pick(m, o, d, { explode: 0, cut: 0 })?.item.name).toBe('plate');
    expect(pick(m, o, d, { explode: 0, cut: 1 })?.item.name).toBe('cathode');
  });
  it('the cut takes the front quarter at x < 0 only', () => {
    const c = cutsAt(m, 1);
    expect(isCut(c, [XA, 40, 1])).toBe(true);
    expect(isCut(c, [-XA, 40, 1])).toBe(false);
    expect(isCut(c, [XA, 40, -1])).toBe(false);
    expect(cutsAt(m, 0)).toEqual([]);
  });
  it('the cathode glows when hot and not when cold, from the tube model', () => {
    const cat = (th: number) => tubeModel(stateAt(0, th), look).items.find((i) => i.name === 'cathode')!.mat;
    expect(cat(20).glow ?? 0).toBeGreaterThan(0.1);
    expect(cat(0).glow ?? 0).toBe(0);
  });
  it('exploded, the bulb lifts clear of the mount', () => {
    const glassY = (k: number) => { const it = m.items.find((i) => i.name === 'glass bulb')!; return (it.explode?.[1] ?? 0) * (k * k * (3 - 2 * k)); };
    expect(glassY(1)).toBe(90);
    expect(boundsOf(m, 1).max[1]).toBeCloseTo(160, 0);
  });
});
