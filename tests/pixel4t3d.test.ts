// The 4T pixel model, held to phys/imagesensor.ts: photons absorbed deeper for longer wavelengths, electrons per photon
// equal to qe() on average, the CDS phases in order with the FD drop = charge × CG, and the drawing following the state.
import { describe, expect, it } from 'vitest';
import type { RGB, RGBA } from '../src/gl/instances';
import { absorptionDepth, CG_4T, IMX183, qe } from '../src/phys/imagesensor';
import {
  absorbed, AR_T, BACK, CF, dots, DRAWN, FUNNEL, ILD_T, L, P_BACK, STI_D, WAFER_T,
  electronsOf, FILTER_NM, FULL_WELL, IDLE, nextPhase, PHOTONS_PER_FLASH, photonsAt, phaseOf, pixAnchors, pixParts, PITCH, SI_T, sequenceOf, U,
  type PixPalette, type PixState,
} from '../src/widgets/pixel4t3dparts';

const c = (v: number): RGB => [v, v, v], a = (v: number): RGBA => [v, v, v, 0.4];
const P: PixPalette = {
  si: a(0.6), p: c(0.5), n: c(0.7), nplus: c(0.65), poly: [0.8, 0.2, 0.2], metal: c(0.6), oxide: a(0.9), lens: a(0.8),
  filter: { b: [0, 0, 1, 0.5], g: [0, 1, 0, 0.5], r: [1, 0, 0, 0.5] }, charge: [0, 1, 0.5], hot: [1, 0.6, 0], light: { b: [0, 0, 1], g: [0, 1, 0], r: [1, 0, 0] },
  sti: [0.3, 0.3, 0.9, 0.8], dti: [0.2, 0.2, 0.7, 0.7], ar: [[0.5, 0.2, 0.8, 0.9], [0.8, 0.3, 0.6, 0.9], [0.6, 0.8, 0.9, 0.7]], pback: [0.4, 0.5, 0.8, 0.8], grid: c(0.55), ild: a(0.2), wafer: c(0.45),
};

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

describe('the drawing', () => {
  const pose = (s: PixState, o: Partial<{ cut: boolean }> = {}) => ({ s, filter: 'g' as const, photons: [], cut: true, ...o });
  it('draws a dot per DOT electrons in the photodiode, then on FD after TX', () => {
    const charge = (s: PixState) => pixParts(pose(s), P).filter((p) => p.color === P.charge);
    expect(charge({ ...IDLE, pd: 7400 })).toHaveLength(dots(7400));
    let s: PixState = { ...IDLE, pd: 7400 };
    for (let i = 0; i < 3; i++) s = nextPhase(s);
    const after = charge(s);
    expect(after).toHaveLength(dots(7400));
    for (const p of after) expect(p.pos[0]).toBeGreaterThan(1.8 * U); // all at the floating diffusion's x
  });
  it('lights the transfer gate during TX only, the reset gate during RST only', () => {
    const lit = (s: PixState) => pixParts(pose(s), P).filter((p) => p.color === P.poly && p.emissive).length;
    let s: PixState = { ...IDLE, pd: 1000 };
    const counts: number[] = [];
    for (let i = 0; i < 4; i++) { s = nextPhase(s); counts.push(lit(s)); }
    expect(counts).toEqual([2, 1, 2, 1]); // RST + RS, RS, TX + RS, RS
    expect(lit(IDLE)).toBe(0);
  });
  it('keeps every part inside the pixel across, and labels the instances PIXEL_4T names', () => {
    for (const p of pixParts(pose({ ...IDLE, pd: FULL_WELL }, { cut: false }), P)) {
      expect(p.pos[0]).toBeGreaterThanOrEqual(-1e-9);
      expect(p.pos[0]).toBeLessThanOrEqual(PITCH * U + 1e-9);
    }
    const t = pixAnchors(pose(IDLE)).map((a) => a.text).join(' ');
    for (const n of ['pd', 'xfer', 'fd', 'reset', 'sf', 'rs']) expect(t).toMatch(new RegExp(`\\b${n}\\b`));
  });
});

describe('the detail the audit asked for', () => {
  const pose = (cut: boolean) => ({ s: IDLE, filter: 'g' as const, photons: [], cut });
  type Bx = { pos: readonly number[]; scale?: readonly number[] };
  const top = (p: Bx) => (p.pos[1] + p.scale![1] / 2) / U, bot = (p: Bx) => (p.pos[1] - p.scale![1] / 2) / U;
  it('draws deep trench isolation to the full silicon depth, inside the pitch, and shallow trench at the front', () => {
    const parts = pixParts(pose(false), P);
    const dti = parts.filter((p) => p.color === P.dti), sti = parts.filter((p) => p.color === P.sti);
    expect(dti).toHaveLength(4);
    for (const w of dti) { expect(bot(w)).toBeCloseTo(0, 6); expect(top(w)).toBeCloseTo(SI_T, 6); }
    expect(sti).toHaveLength(1);
    expect(top(sti[0])).toBeCloseTo(STI_D, 6);
    expect(bot(sti[0])).toBeCloseTo(0, 6);
  });
  it('stacks the films on the back surface in order, then the filter on top of them, the p+ layer inside the silicon', () => {
    const parts = pixParts(pose(true), P);
    let y = SI_T;
    for (const c of P.ar) {
      const f = parts.find((p) => p.color === c)!;
      expect(bot(f)).toBeCloseTo(y, 6);
      y = top(f);
    }
    expect(y).toBeCloseTo(BACK, 6);
    expect(AR_T).toBeCloseTo(0.19, 9);
    expect(CF[0]).toBe(BACK);
    const pb = parts.find((p) => p.color === P.pback)!;
    expect(top(pb)).toBeCloseTo(SI_T, 6);
    expect(top(pb) - bot(pb)).toBeCloseTo(P_BACK, 6);
  });
  it('bonds a carrier wafer under the oxide below the metal, and keeps every part inside the 2.4 µm pitch in both directions', () => {
    const parts = pixParts(pose(false), P);
    const wafer = parts.find((p) => p.color === P.wafer)!;
    expect(top(wafer)).toBeCloseTo(-ILD_T, 6);
    expect(top(wafer) - bot(wafer)).toBeCloseTo(WAFER_T, 6);
    for (const p of parts) for (const k of [0, 2]) {
      expect(p.pos[k] - p.scale![k] / 2).toBeGreaterThanOrEqual(-1e-6);
      expect(p.pos[k] + p.scale![k] / 2).toBeLessThanOrEqual(PITCH * U + 1e-6);
    }
  });
  it('grades the potential: layers narrow onto the photodiode and strengthen toward it', () => {
    const f = pixParts(pose(false), P).filter((p) => p.color.length === 4 && p.color[0] === P.n[0] && p.color[1] === P.n[1] && p.color[2] === P.n[2] && p.scale![1] / U < 0.4);
    expect(f.length).toBeGreaterThanOrEqual(FUNNEL);
    const g = f.filter((p) => p.pos[1] / U > L.pd.y[1] && p.scale![1] / U < 0.4).sort((a, b) => b.pos[1] - a.pos[1]);
    expect(g).toHaveLength(FUNNEL);
    for (let i = 1; i < g.length; i++) {
      expect(g[i].scale![0]).toBeLessThan(g[i - 1].scale![0]);
      expect(g[i].color[3]!).toBeGreaterThan(g[i - 1].color[3]!);
    }
  });
  it('lights the FD to follower wire while the row is selected, and tints FD by its drop', () => {
    const lit = (s: PixState) => pixParts({ s, filter: 'g' as const, photons: [], cut: false }, P).filter((p) => p.color === P.metal && p.emissive).length;
    let s: PixState = { ...IDLE, pd: 9000 };
    expect(lit(s)).toBe(0);
    s = nextPhase(s);
    expect(lit(s)).toBeGreaterThan(5);
    const fdGlow = (s: PixState) => pixParts({ s, filter: 'g' as const, photons: [], cut: false }, P).find((p) => p.color === P.nplus && p.pos[0] > 1.8 * U && p.pos[2] < 1.2 * U)?.emissive?.[0] ?? 0;
    const after = (n: number) => { let t = { ...IDLE, pd: 9000 } as PixState; for (let i = 0; i < n; i++) t = nextPhase(t); return t; };
    expect(fdGlow(after(2))).toBe(0); // SHR: FD at the reset level
    expect(fdGlow(after(3))).toBeGreaterThan(fdGlow(after(2))); // TX: it has dropped
  });
  it('keeps the instance count sane', () => {
    expect(pixParts(pose(true), P).length).toBeLessThan(120);
    expect(pixParts(pose(false), P).length).toBeLessThan(130);
  });
});
