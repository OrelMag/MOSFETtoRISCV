// The 4T pixel model, held to phys/imagesensor.ts: photons absorbed deeper for longer wavelengths, electrons per photon
// equal to qe() on average, the CDS phases in order with the FD drop = charge × CG, and the drawing following the state.
import { describe, expect, it } from 'vitest';
import type { Item } from '../src/gl/kit/scene';
import { CUT_Z, cutAt, lensHeight, LENS_H, pixModel } from '../src/widgets/pixel4t3dkit';
import { absorptionDepth, CG_4T, IMX183, qe } from '../src/phys/imagesensor';
import {
  absorbed, AR_T, BACK, CF, dots, DRAWN, FUNNEL, ILD_T, L, P_BACK, STI_D, WAFER_T,
  electronsOf, FILTER_NM, FULL_WELL, IDLE, nextPhase, PHOTONS_PER_FLASH, photonsAt, phaseOf, PITCH, SI_T, sequenceOf, DOT, dotAt, PD_BOX, FD_BOX,
  type PixState,
} from '../src/widgets/pixel4t3dgeom';


describe('light into charge', () => {
  it('the IMX183\'s pitch, its BSI collecting depth and full well', () => {
    expect(PITCH).toBe(2.4);
    expect(SI_T).toBe(3);
    expect(FULL_WELL).toBe(IMX183.fullWell);
  });
  it('blue is absorbed near the lit surface, red deep, and some red passes through', () => {
    const mean = (nm: number) => { const ps = photonsAt(nm, 4000, 7); return ps.reduce((t, p) => t + Math.min(p.depth, 50), 0) / ps.length; };
    expect(mean(FILTER_NM.b)).toBeLessThan(0.6);
    expect(mean(FILTER_NM.b)).toBeLessThan(mean(FILTER_NM.g));
    expect(mean(FILTER_NM.g)).toBeLessThan(mean(FILTER_NM.r));
    expect(mean(FILTER_NM.r)).toBeCloseTo(absorptionDepth(FILTER_NM.r), 0);
    expect(photonsAt(FILTER_NM.r, 400, 3).some((p) => !absorbed(p))).toBe(true);
    expect(photonsAt(FILTER_NM.b, 4000, 3).filter((p) => !absorbed(p)).length / 4000).toBeLessThan(0.02);
  });
  it('electrons per photon average to qe() at each colour', () => {
    for (const f of ['b', 'g', 'r'] as const) {
      const ps = photonsAt(FILTER_NM[f], 20_000, 11), got = ps.reduce((t, p) => t + electronsOf(p), 0) / (ps.length * PHOTONS_PER_FLASH / DRAWN);
      expect(got).toBeCloseTo(qe(FILTER_NM[f]), 2);
    }
  });
});

describe('the read', () => {
  const full = (pd: number): PixState[] => { const out: PixState[] = []; let s: PixState = { ...IDLE, pd }; for (let i = 0; i < 5; i++) { s = nextPhase(s); out.push(s); } return out; };
  it('runs RST, SHR, TX, SHS, then integrates again', () => {
    expect(full(5000).map((s) => phaseOf(s)?.name ?? 'idle')).toEqual(['RST', 'SHR', 'TX', 'SHS', 'idle']);
  });
  it('TX moves the photodiode onto FD; the FD drop is charge × CG; CDS gives the charge back', () => {
    const [rst, shr, tx, shs] = full(8000);
    expect(rst.fd).toBe(0);
    expect(shr.pd).toBe(8000);
    expect(tx.pd).toBe(0);
    expect(tx.fd).toBe(8000);
    const seq = sequenceOf(shs);
    expect(seq.phases[1].fd - seq.phases[3].fd).toBeCloseTo(8000 * CG_4T * 1e-6, 9);
    expect(seq.cdsE).toBeCloseTo(8000, 6);
    expect(phaseOf(shr)!.sample).toBe('reset');
    expect(phaseOf(shs)!.sample).toBe('signal');
  });
});

describe('the studio model', () => {
  const m = (s: PixState, filter: 'b' | 'g' | 'r' = 'g') => pixModel({ s, filter });
  const named = (s: PixState, name: string) => m(s).items.filter((i) => i.name === name);
  const yRange = (i: Item) => [(i.at?.[1] ?? 0) + i.geo.min[1], (i.at?.[1] ?? 0) + i.geo.max[1]];
  const after = (n: number, pd = 9000) => { let t: PixState = { ...IDLE, pd }; for (let i = 0; i < n; i++) t = nextPhase(t); return t; };
  it('charge dots: one per DOT electrons, in the photodiode, then on the floating diffusion after TX', () => {
    expect(dots(7400)).toBe(Math.round(7400 / DOT));
    for (let k = 0; k < dots(FULL_WELL); k++) {
      const p = dotAt(k, PD_BOX.x, PD_BOX.y, PD_BOX.z);
      expect(p[0]).toBeGreaterThanOrEqual(L.pd.x[0]); expect(p[0]).toBeLessThanOrEqual(L.pd.x[1]);
      expect(p[1]).toBeGreaterThanOrEqual(L.pd.y[0]); expect(p[1]).toBeLessThanOrEqual(L.pd.y[1]);
      expect(dotAt(k, FD_BOX.x, FD_BOX.y, FD_BOX.z)[0]).toBeGreaterThan(1.8);
    }
  });
  it('lights the transfer gate during TX only, the reset gate during RST only, the select while the row is read', () => {
    const lit = (s: PixState) => m(s).items.filter((i) => i.group === 'gates' && i.mat.emit).map((i) => i.name).sort();
    expect(lit(after(1))).toEqual(['reset', 'rs: row select']);
    expect(lit(after(2))).toEqual(['rs: row select']);
    expect(lit(after(3))).toEqual(['rs: row select', 'xfer: transfer gate']);
    expect(lit(after(4))).toEqual(['rs: row select']);
    expect(lit(IDLE)).toEqual([]);
  });
  it('lights the FD to follower wire while the row is selected, and the FD glows once its voltage has dropped', () => {
    const wire = (s: PixState) => named(s, 'FD to the follower\'s gate (metal 1)').filter((i) => i.mat.emit).length;
    expect(wire(IDLE)).toBe(0);
    expect(wire(after(1))).toBeGreaterThan(4);
    const fd = (s: PixState) => (named(s, 'fd: floating diffusion')[0].mat.glow ?? 0);
    expect(fd(after(2))).toBe(0);
    expect(fd(after(3))).toBeGreaterThan(0);
  });
  it('deep trenches run the full silicon depth, four walls; the shallow trench is at the front', () => {
    const dti = named(IDLE, 'DTI: deep trench');
    expect(dti).toHaveLength(4);
    for (const w of dti) { const [a, b] = yRange(w); expect(a).toBeCloseTo(0, 6); expect(b).toBeCloseTo(SI_T, 6); }
    const [sti] = named(IDLE, 'STI: shallow trench'), [a, b] = yRange(sti);
    expect(a).toBeCloseTo(0, 6); expect(b).toBeCloseTo(STI_D, 6);
  });
  it('stacks the films on the back surface, the filter on them, the lens on the filter; p+ inside the silicon', () => {
    const films = named(IDLE, 'anti-reflection films').map(yRange).sort((p, q) => p[0] - q[0]);
    let y = SI_T;
    for (const [a, b] of films) { expect(a).toBeCloseTo(y, 6); y = b; }
    expect(y).toBeCloseTo(BACK, 6); expect(AR_T).toBeCloseTo(0.19, 9);
    expect(yRange(named(IDLE, 'colour filter')[0])[0]).toBeCloseTo(CF[0], 6);
    expect(yRange(named(IDLE, 'microlens')[0])[0]).toBeCloseTo(CF[1], 6);
    const [pa, pb] = yRange(named(IDLE, 'p+ back layer')[0]);
    expect(pb).toBeCloseTo(SI_T, 6); expect(pb - pa).toBeCloseTo(P_BACK, 6);
  });
  it('the carrier wafer under the oxide, and every part inside the 2.4 µm pitch both ways', () => {
    const [a, b] = yRange(named(IDLE, 'carrier wafer')[0]);
    expect(b).toBeCloseTo(-ILD_T, 6); expect(b - a).toBeCloseTo(WAFER_T, 6);
    for (const i of m({ ...IDLE, pd: FULL_WELL }).items.filter((x) => x.group !== 'neighbours')) for (const k of [0, 2]) {
      expect((i.at?.[k] ?? 0) + i.geo.min[k]).toBeGreaterThanOrEqual(-1e-6);
      expect((i.at?.[k] ?? 0) + i.geo.max[k]).toBeLessThanOrEqual(PITCH + 1e-6);
    }
  });
  it('the funnel: layers narrow onto the photodiode and grow stronger toward it', () => {
    const f = named(IDLE, 'potential funnel').sort((p, q) => (q.at![1]) - (p.at![1]));
    expect(f).toHaveLength(FUNNEL);
    for (let i = 1; i < f.length; i++) {
      expect(f[i].geo.max[0] - f[i].geo.min[0]).toBeLessThan(f[i - 1].geo.max[0] - f[i - 1].geo.min[0]);
      expect(f[i].mat.transmit!).toBeLessThan(f[i - 1].mat.transmit!);
    }
  });
  it('the microlens is a spherical cap on the square cell: its corners meet the filter, its centre is the sag, and it is closed', () => {
    expect(lensHeight(0, 0)).toBeCloseTo(LENS_H, 9);
    expect(lensHeight(PITCH / 2, PITCH / 2)).toBeCloseTo(0, 6);
    expect(lensHeight(PITCH / 2, 0)).toBeGreaterThan(0.2);
    const g = named(IDLE, 'microlens')[0].geo, edges = new Map<string, number>(), I = g.indices, P = g.positions;
    const key = (i: number) => `${P[3 * i].toFixed(5)},${P[3 * i + 1].toFixed(5)},${P[3 * i + 2].toFixed(5)}`;
    for (let t = 0; t < I.length; t += 3) for (let e = 0; e < 3; e++) {
      const a = key(I[t + e]), b = key(I[t + (e + 1) % 3]), c = key(I[t + (e + 2) % 3]);
      if (a === b || b === c || a === c) continue; // a sliver where a wall comes down to the corner: zero area
      const k = a < b ? `${a}|${b}` : `${b}|${a}`;
      edges.set(k, (edges.get(k) ?? 0) + 1);
    }
    expect([...edges.values()].filter((n) => n % 2 !== 0)).toHaveLength(0);
  });
  it('the cut is through the photodiode\'s middle; particles in front of it are left out', () => {
    expect(CUT_Z).toBeCloseTo((L.pd.z[0] + L.pd.z[1]) / 2, 9);
    expect(cutAt(1)).toBeCloseTo(CUT_Z, 9);
    expect(cutAt(0)).toBe(-Infinity);
  });
  it('labels the instances PIXEL_4T names, and has a tour', () => {
    const t = (m(IDLE).anchors ?? []).map((a) => a.text).join(' ');
    for (const n of ['pd', 'xfer', 'fd', 'reset', 'sf', 'rs']) expect(t).toMatch(new RegExp(`\\b${n}\\b`));
    expect(m(IDLE).beats!.length).toBeGreaterThanOrEqual(5);
  });
});
