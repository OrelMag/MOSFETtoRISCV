import { describe, expect, it } from 'vitest';
import { M } from '../src/gl/kit/materials';
import { cutoff, MU, plateCurrent, plateVoltage } from '../src/phys/triode';
import { TS_GRID, TS_PLATES, TUNGSOL_IP, worstFit } from '../src/phys/triodedata';
import { muOf, triodeField, wireRadiusFor } from '../src/phys/triodefield';
import { cathodeFieldAt, FIELD_GEO, FIELD_H, FIELD_W, FIELD_WIRE_R, newFieldTex, paintField, texelAt, tubeModel } from '../src/widgets/triode3dkit';
import { stateAt } from '../src/widgets/triode3dview';

describe('the field on the cut face (phys/triodefield.ts)', () => {
  const g = FIELD_GEO, r = FIELD_WIRE_R;
  it('the wire radius gives the geometry phys/triode.ts’s µ, and a wire tens of microns across', () => {
    expect(muOf(g, r)).toBeCloseTo(MU, 6);
    expect(wireRadiusFor(g, 10)).toBeLessThan(r); // a finer wire screens the plate less: a lower µ
    expect(2e3 * r).toBeGreaterThan(20);
    expect(2e3 * r).toBeLessThan(80);
  });
  it('the potential is the electrodes’ on the cathode, the wire and the plate', () => {
    for (const [vg, vp] of [[0, 81], [-8, 200], [-12, 250]]) {
      const f = triodeField(g, vg, vp, r);
      for (const y of [0, 0.1, 0.3, 0.45]) expect(f.at(0, y)).toBeCloseTo(0, 9);
      for (const y of [0, 0.2, 0.3]) expect(f.at(g.d2, y)).toBeCloseTo(vp, 3);
      expect(f.at(g.d1 + r, 0)).toBeCloseTo(vg, 2);
      expect(Math.abs(f.at(g.d1, r) - vg)).toBeLessThan(0.005 * vp); // round the wire too (a thin line charge: nearly)
    }
  });
  it('the field at the cathode turns round where the lumped model cuts off', () => {
    for (const vp of [100, 200, 250]) {
      expect(triodeField(g, cutoff(vp), vp, r).cathodeField).toBeCloseTo(0, 9);
      expect(triodeField(g, cutoff(vp) + 0.5, vp, r).cathodeField).toBeGreaterThan(0);
      expect(triodeField(g, cutoff(vp) - 0.5, vp, r).cathodeField).toBeLessThan(0);
    }
    // in the circuit: at −12 V the pull at the cathode is a small fraction of 0 V's: the cloud sits
    expect(cathodeFieldAt(-12)).toBeGreaterThan(0);
    expect(cathodeFieldAt(-12)).toBeLessThan(0.15 * cathodeFieldAt(0));
    expect(cathodeFieldAt(-20)).toBeLessThan(0);
  });
  it('the strips run cathode to plate, the left wires half a pitch up', () => {
    expect(texelAt(true, 0, 0)[0]).toBeLessThan(texelAt(true, FIELD_W - 1, 0)[0]);
    expect(texelAt(false, 0, 0)[0]).toBeGreaterThan(texelAt(false, FIELD_W - 1, 0)[0]);
    expect(texelAt(false, 0, 5)[1] - texelAt(true, 0, 5)[1]).toBeCloseTo(-g.a / 2, 9);
  });
  it('painted: blue next to the wires when the grid is negative, amber by the plate', () => {
    const t = newFieldTex();
    paintField(t, -12, plateVoltage(-12));
    const px = (i: number, j: number) => Array.from(t.right.pixels.slice((j * FIELD_W + i) * 4, (j * FIELD_W + i) * 4 + 3));
    // the texel nearest a wire (u = d1, y = 0 mod a)
    let best = [0, 0], d = Infinity;
    for (let j = 0; j < FIELD_H; j++) for (let i = 0; i < FIELD_W; i++) { const [u, y] = texelAt(true, i, j), yy = y - Math.round(y / g.a) * g.a, e = Math.hypot(u - g.d1, yy); if (e < d) { d = e; best = [i, j]; } }
    const [r0, , b0] = px(best[0], best[1]);
    expect(b0).toBeGreaterThan(r0);
    const [r1, , b1] = px(FIELD_W - 2, FIELD_H >> 1);
    expect(r1).toBeGreaterThan(b1);
    expect(t.right.rev).toBe(1);
  });
  it('the model carries the field only when asked, on the near section, and a tour beat for it', () => {
    const look = { charge: true, detail: 'full' as const, electron: M.steel };
    const st = stateAt(-12, 20);
    expect(tubeModel(st, look).items.some((i) => i.group === 'field')).toBe(false);
    const m = tubeModel(st, { ...look, field: newFieldTex() });
    const f = m.items.filter((i) => i.group === 'field');
    expect(f).toHaveLength(2);
    for (const it of f) expect(it.at![0]).toBeLessThan(0);
    expect(tubeModel(st, { ...look, detail: 'flat', field: newFieldTex() }).items.some((i) => i.group === 'field')).toBe(false);
    expect(m.beats![4].title).toBe('A field, not a current');
    expect(m.beats![4].show).toContain('field');
  });
});

describe('the Tung-Sol 6SN7GTB sheet against the model (phys/triodedata.ts)', () => {
  it('the sheet’s chart agrees with its own table: 7–13 mA at 250 V, −8 V; ≤ 50 µA at −18 V', () => {
    const at8 = TUNGSOL_IP[250][TS_GRID.indexOf(-8)];
    expect(at8).toBeGreaterThanOrEqual(7);
    expect(at8).toBeLessThanOrEqual(13);
    expect(TUNGSOL_IP[250][TS_GRID.indexOf(-16)]).toBe(0);
    for (const ep of TS_PLATES) for (let i = 1; i < TS_GRID.length; i++) expect(TUNGSOL_IP[ep][i]).toBeLessThanOrEqual(TUNGSOL_IP[ep][i - 1]);
  });
  it('the model stays within 2.5 mA of every point read (the figure the page quotes)', () => {
    const w = worstFit();
    expect(Math.abs(w.err)).toBeLessThan(2.5);
    expect(Math.abs(plateCurrent(0, 250) * 1e3 - 42.9)).toBeLessThan(1.5);
  });
});
