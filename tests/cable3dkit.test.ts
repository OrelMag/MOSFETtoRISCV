// The twisted pair and the coax on the studio renderer (widgets/cable3dkit.ts) held to their sources and to phys/cable.ts:
// the coax layers at the Belden sheets' diameters, a Cat5e wire's 0.511 mm copper and 0.92 mm insulation in the true-proportion
// pair at the 11.2 mm lay, and the field in time: each loop's voltage the model's sign and share, the receiver's sum nothing for
// odd equal half twists, the beads pushed opposite ways in neighbouring loops.
import { describe, expect, it } from 'vitest';
import { boundsOfNamed } from '../src/gl/kit/scene';
import { COAX_PRESETS, LAY_A_MM, loopCount, unevenLoops } from '../src/phys/cable';
import { LEN, type CableState } from '../src/widgets/cable3dparts';
import {
  BEADS_PER_LOOP, CAT5E, CMM, COAX_LAYERS, FRAME_GROUPS, PAIR_LAYERS, TRUE_Z, UPM, cableModel, coaxRadii, fieldArrows, lenses, loopsNow, pushBeads, receiver, tighterThanLife,
  type CableLayer, type CableLook,
} from '../src/widgets/cable3dkit';

const rgb: CableLook['rgb'] = { pos: [1, 0, 0], neg: [0, 0, 1], field: [0.5, 0.5, 0.5], push: [0, 1, 0], load: [0.4, 0.4, 0.4], hot: [1, 0.6, 0.2] };
const PAIR: CableState = { twists: 5, coax: false, preset: 'rg58', diel: 'pe', uneven: 0, neighbour: 'off' };
const look = (st: Partial<CableState> = {}, layers: CableLayer[] = [], detail: CableLook['detail'] = 'full'): CableLook => ({ detail, st: { ...PAIR, ...st }, layers: new Set(layers), rgb });
const named = (m: ReturnType<typeof cableModel>, n: string) => m.items.filter((it) => it.name === n);
const span = (g: { min: number[]; max: number[] }, a: number) => g.max[a] - g.min[a];

describe('sourced figures', () => {
  it('a Cat5e wire: 24 AWG copper 0.511 mm in 0.92 mm of insulation; the drawn pair’s width stands for that spacing', () => {
    expect(CAT5E).toEqual({ conductor: 0.511, insulated: 0.92 });
    expect(UPM * CAT5E.insulated).toBeCloseTo(6.4, 9);
    // 5 half twists: 6 loops of 10 units, a turn every 20 against 11.2 mm × UPM
    expect(tighterThanLife(5)).toBeCloseTo((LAY_A_MM * UPM) / 20, 9);
  });
  it('every coax is drawn at its sheet’s D, d and jacket, the layers nested in order', () => {
    for (const p of COAX_PRESETS) {
      const R = coaxRadii(p);
      expect((2 * R.core) / CMM).toBeCloseTo(p.d, 9);
      expect((2 * R.diel) / CMM).toBeCloseTo(p.D, 9);
      expect((2 * R.jacket) / CMM).toBeCloseTo(p.jacket, 9);
      expect(R.core < R.diel && R.diel < R.braidIn && R.braidIn < R.braidOut && R.braidOut < R.jacketIn && R.jacketIn < R.jacket).toBe(true);
      const m = cableModel(look({ coax: true, preset: p.id }));
      expect(span(named(m, 'centre conductor')[0].geo, 1) / CMM).toBeCloseTo(p.d, 3);
      expect(span(named(m, 'jacket')[0].geo, 1) / CMM).toBeCloseTo(p.jacket, 3);
      expect(named(m, 'jacket')[0].info?.source).toContain(p.sheet.replace('Belden ', ''));
    }
  });
  it('the true-proportion pair: two 0.92 mm wires touching, a turn every 11.2 mm, at the drawn pair’s scale', () => {
    const m = cableModel(look({}, ['true'])), w = named(m, 'the same pair, true proportion');
    expect(w).toHaveLength(2);
    // each wire winds round the axis at its own radius: the two together span two wire widths
    expect(span(w[0].geo, 1) / UPM).toBeCloseTo(2 * CAT5E.insulated * 0.9925, 1);
    expect((w[0].geo.min[2] + w[0].geo.max[2]) / 2).toBeGreaterThan(TRUE_Z - 1);
    expect(w[0].info?.dim).toContain('11.2 mm');
  });
});

describe('the field in time follows phys/cable.ts', () => {
  it('each loop’s voltage is the model’s, scaled: sign, share and dB/dt = cos', () => {
    for (const [n, u] of [[5, 0], [4, 0], [7, 0.15]] as const) {
      const ref = unevenLoops(n, 1, 1, 1, u), L = loopCount(n), now = loopsNow({ twists: n, uneven: u }, 0);
      now.emf.forEach((e, k) => expect(e).toBeCloseTo(ref[k] * L, 12));
      expect(now.net).toBeCloseTo(now.emf.reduce((a, b) => a + b, 0), 12);
    }
  });
  it('odd equal half twists: the receiver gets nothing at any moment; even: one loop’s worth, rising and falling', () => {
    for (let ph = 0; ph < 6.3; ph += 0.3) {
      expect(Math.abs(loopsNow({ twists: 5, uneven: 0 }, ph).net)).toBeLessThan(1e-12);
      expect(Math.abs(loopsNow({ twists: 4, uneven: 0 }, ph).net)).toBeCloseTo(Math.abs(Math.cos(ph)), 12);
      expect(receiver({ ...PAIR, twists: 5 }, ph, rgb)[0].emissive!.every((c) => c < 1e-9)).toBe(true);
    }
    expect(receiver({ ...PAIR, twists: 4 }, 0, rgb)[0].emissive![0]).toBeGreaterThan(0.3);
  });
  it('the lenses: one a loop, along the whole run, coloured by their voltage’s sign', () => {
    const ls = lenses(PAIR, 0, rgb);
    expect(ls).toHaveLength(6);
    expect(ls.reduce((a, l) => a + l.scale![0], 0)).toBeCloseTo(LEN, 9);
    ls.forEach((l, k) => expect(l.color.slice(0, 3)).toEqual(k % 2 ? rgb.neg : rgb.pos));
    lenses(PAIR, Math.PI, rgb).forEach((l, k) => expect(l.color.slice(0, 3)).toEqual(k % 2 ? rgb.pos : rgb.neg));
  });
  it('the field’s arrows are as long as B now and turn over with it', () => {
    const up = fieldArrows(PAIR, Math.PI / 2, rgb), down = fieldArrows(PAIR, -Math.PI / 2, rgb);
    expect(up.shafts).toHaveLength(6);
    expect(up.shafts[0].scale![1]).toBeCloseTo(15, 9);
    expect(up.heads[0].pos[1]).toBeGreaterThan(0);
    expect(down.heads[0].pos[1]).toBeLessThan(0);
  });
  it('the beads: three a leg a loop, pushed along wire A one way in a loop and the other way in the next', () => {
    const at = (ph: number) => pushBeads(PAIR, ph, rgb), loopA = (b: ReturnType<typeof at>, k: number) => b.slice(k * 2 * BEADS_PER_LOOP, k * 2 * BEADS_PER_LOOP + BEADS_PER_LOOP);
    const mean = (b: ReturnType<typeof at>) => b.reduce((s, x) => s + x.pos[0], 0) / b.length;
    expect(at(0)).toHaveLength(6 * 2 * BEADS_PER_LOOP + 3);
    expect(mean(loopA(at(Math.PI / 2), 0)) - mean(loopA(at(0), 0))).toBeGreaterThan(0.5);
    expect(mean(loopA(at(Math.PI / 2), 1)) - mean(loopA(at(0), 1))).toBeLessThan(-0.5);
  });
});

describe('the subject first, one layer at a time', () => {
  it('home is the pair with its loops and field; the electric field, true proportion and neighbour only with their layer', () => {
    const m = cableModel(look());
    expect(m.items.some((it) => it.group === 'electric' || it.group === 'true' || it.group === 'neighbour')).toBe(false);
    expect(cableModel(look({}, ['electric'])).items.some((it) => it.group === 'electric')).toBe(true);
    expect(cableModel(look({ neighbour: 'other' })).items.some((it) => it.group === 'neighbour')).toBe(true);
    expect(cableModel(look({ coax: true })).items.some((it) => it.group === 'fields')).toBe(false);
    expect(cableModel(look({ coax: true }, ['fields'])).items.some((it) => it.group === 'fields')).toBe(true);
  });
  it('each mode’s beats match its layer lists, and its frames are in both builds', () => {
    for (const coax of [false, true]) for (const detail of ['full', 'flat'] as const) {
      const m = cableModel(look({ coax }, [], detail));
      expect((coax ? COAX_LAYERS : PAIR_LAYERS).length).toBe(m.beats!.length);
      expect(m.items.some((it) => it.group === 'homebox')).toBe(true);
      const box = boundsOfNamed(m, ['homebox']);
      expect(box.max[0] - box.min[0]).toBeGreaterThan(30);
    }
    for (const g of FRAME_GROUPS) expect(cableModel(look({}, ['true'])).items.some((it) => it.group === g) || cableModel(look({ coax: true })).items.some((it) => it.group === g)).toBe(true);
  });
  it('the flat view draws the loops, the field and the receiver as parts (it has no instances)', () => {
    const m = cableModel(look({}, ['field'], 'flat'));
    expect(m.items.filter((it) => it.group === 'loops')).toHaveLength(6);
    expect(m.items.some((it) => it.group === 'field')).toBe(true);
    expect(named(m, 'the receiver').length).toBeGreaterThan(0);
    expect(cableModel(look({}, ['field'])).items.some((it) => it.group === 'loops' || it.group === 'field')).toBe(false);
  });
});
