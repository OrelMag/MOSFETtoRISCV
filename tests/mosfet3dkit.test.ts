// The MOSFET in true geometry (Float32 meshes: compared to 4 decimals) held to the model behind it (mosphys.ts) and to the dimensions its notes cite.
import { describe, expect, it } from 'vitest';
import { boundsOfNamed, isCut, cutsAt, type Item } from '../src/gl/kit/scene';
import { biasLink } from '../src/widgets/mosshare';
import {
  DEPL_MAX, FIELD_R, L0, MOS_HIDDEN, MOS_HOME_FRAME, OX, cutZ, fieldOf, fieldParts, fieldSites, PLUG_D, PLUG_PITCH, POLY, SHEET_MAX, SPACER, STI_DEPTH, W0, depletionAt, extents, ionsAt, mosModel, plugSites, plugsFor, sheetAt, type MosState,
} from '../src/widgets/mosfet3dkit';
import { current, depletionDepth, gateCap, sizedCurrent, VDD, VT } from '../src/widgets/mosphys';

const st = (o: Partial<MosState> = {}): MosState => ({ vg: 1.2, vd: 0.2, w: 1, l: 1, layout: 'real', ...o });
const items = (s: MosState) => mosModel(s).items;
const named = (s: MosState, n: string) => items(s).filter((i) => i.name === n);
const size = (it: Item) => [0, 1, 2].map((a) => it.geo.max[a] - it.geo.min[a]);

describe('the MOSFET in true geometry', () => {
  it('current scales with W / L and the reference device is the chapter’s', () => {
    expect(sizedCurrent(1, 0.5)).toBeCloseTo(current(1, 0.5).id, 9);
    expect(sizedCurrent(1, 0.5, 2, 1)).toBeCloseTo(2 * current(1, 0.5).id, 9);
    expect(sizedCurrent(1, 0.5, 1, 2)).toBeCloseTo(current(1, 0.5).id / 2, 9);
    expect(gateCap(2, 3)).toBeCloseTo(6 * gateCap());
  });

  it('no channel below the threshold, a channel above it', () => {
    expect(named(st({ vg: VT - 0.01 }), 'channel')).toHaveLength(0);
    expect(named(st({ vg: VT + 0.3 }), 'channel')).toHaveLength(1);
  });

  it('the sheet’s thickness is the charge: full at the source, thinning to the drain, never past the maximum', () => {
    const s = st({ vg: VDD, vd: 0.5 }), sheet = named(s, 'channel')[0].geo, { hl } = extents(s);
    expect(sheetAt(s, 0)).toBeCloseTo(SHEET_MAX);
    expect(sheetAt(s, 1)).toBeLessThan(sheetAt(s, 0));
    // the mesh's depth at each end is the charge there (to the vertex), and nothing goes deeper than the maximum
    const P = sheet.positions;
    let atS = 0, atD = 0;
    for (let k = 0; k < P.length; k += 3) {
      expect(-P[k + 1]).toBeLessThanOrEqual(SHEET_MAX + 1e-3);
      if (Math.abs(P[k] + hl) < 1e-6) atS = Math.max(atS, -P[k + 1]);
      if (Math.abs(P[k] - hl) < 1e-6) atD = Math.max(atD, -P[k + 1]);
    }
    expect(atS).toBeCloseTo(sheetAt(s, 0), 3);
    expect(atD).toBeCloseTo(Math.max(0.4, sheetAt(s, 1)), 3);
  });

  it('in saturation the sheet thins to nothing before the drain', () => {
    const s = st({ vg: 1, vd: 1.5 });
    expect(sheetAt(s, 1)).toBe(0);
    expect(sheetAt(s, 0.99)).toBeLessThan(sheetAt(s, 0.5));
  });

  it('W widens the sheet and L lengthens it, each by its factor', () => {
    const one = size(named(st(), 'channel')[0]), wide = size(named(st({ w: 2 }), 'channel')[0]), long = size(named(st({ l: 2 }), 'channel')[0]);
    expect(wide[2]).toBeCloseTo(2 * one[2], 4);
    expect(long[0]).toBeCloseTo(2 * one[0], 4);
    expect(one[0]).toBeCloseTo(L0, 4);
    expect(one[2]).toBeCloseTo(W0, 4);
  });

  it('the depletion layer follows mosphys: √Vgs up to Vt, then no deeper', () => {
    const depth = (vg: number) => { const d = named(st({ vg }), 'depletion layer'); return d.length ? size(d[0])[1] : 0; };
    expect(depth(0)).toBe(0);
    expect(depth(0.3)).toBeCloseTo(DEPL_MAX * depletionDepth(0.3) - 1.2, 4); // the solid stands 0.6 nm in from each face
    expect(depth(VT)).toBeCloseTo(DEPL_MAX - 1.2, 4);
    expect(depth(VDD)).toBeCloseTo(DEPL_MAX - 1.2, 4);
    expect(depletionAt(VT / 2)).toBeCloseTo(DEPL_MAX / Math.SQRT2, 9);
    // its ions fill it down to that depth, and no further
    for (const vg of [0.2, VT, VDD]) for (const p of ionsAt(st({ vg }))) expect(-p[1]).toBeLessThan(depletionAt(vg));
    expect(ionsAt(st({ vg: 0.1 })).length).toBeLessThan(ionsAt(st({ vg: VT })).length);
  });

  it('the cited dimensions: 4 nm oxide, 200 nm poly, 60 nm spacers, 350 nm trenches, 220 nm plugs', () => {
    const s = st();
    expect(size(named(s, 'gate oxide')[0])[1]).toBeCloseTo(OX - 1.2, 4);
    expect(size(named(s, 'gate')[0])[1]).toBeCloseTo(POLY - 1.2, 4);
    expect(size(named(s, 'trench isolation (STI)')[0])[1]).toBeCloseTo(STI_DEPTH - 1.2, 4);
    const sp = named(s, 'spacers')[0].geo, { hl } = extents(s);
    expect(sp.max[0] - hl).toBeCloseTo(SPACER, 0);
    // the plugs' tungsten core and TiN liner together are the plug's width
    const liner = named(s, 'contact plug').map((i) => i.geo);
    const one = plugSites(s)[0], w = Math.max(...liner.map((g) => {
      let best = 0;
      for (let k = 0; k < g.positions.length; k += 3) if (Math.abs(g.positions[k + 2] - one.z) < 1 && Math.abs(g.positions[k + 1] - one.y1) < 1 && Math.abs(g.positions[k] - one.x) < PLUG_D) best = Math.max(best, Math.abs(g.positions[k] - one.x));
      return best;
    }));
    expect(2 * w).toBeCloseTo(PLUG_D, -1);
  });

  it('a plug per 470 nm of width: one on the chapter’s 240 nm device, more as W grows, all within the width', () => {
    expect(plugsFor(1)).toBe(1);
    expect(plugsFor(4)).toBe(Math.floor((4 * W0) / PLUG_PITCH));
    for (const w of [1, 2, 4]) {
      const s = st({ w }), { hw } = extents(s), sites = plugSites(s).filter((p) => p.kind !== 'g');
      expect(sites).toHaveLength(2 * plugsFor(w));
      for (const p of sites) expect(Math.abs(p.z)).toBeLessThanOrEqual(hw - PLUG_D / 2 + 1e-6);
    }
  });

  it('the real layout lands the gate contact on the poly head, off the active area; the textbook one on the gate', () => {
    const real = plugSites(st()).find((p) => p.kind === 'g')!, text = plugSites(st({ layout: 'textbook' })).find((p) => p.kind === 'g')!;
    expect(real.z).toBeGreaterThan(extents(st()).hw + PLUG_D / 2);
    expect(text.z).toBe(0);
    // what the textbook leaves out
    for (const n of ['trench isolation (STI)', 'extension (LDD)', 'silicide', 'metal 1']) {
      expect(named(st(), n).length).toBeGreaterThan(0);
      expect(named(st({ layout: 'textbook' }), n)).toHaveLength(0);
    }
  });

  it('the cut is the cross-section: the plane through the gate’s middle', () => {
    const m = mosModel(st()), cuts = cutsAt(m, 1);
    expect(cuts).toHaveLength(1);
    expect(isCut(cuts, [0, 0, 1])).toBe(true);
    expect(isCut(cuts, [0, 0, -1])).toBe(false);
    expect(isCut(cutsAt(m, 0), [0, 0, 1])).toBe(false);
  });

  it('no two solids share a face (a cut caps each cleanly): neighbours stand apart', () => {
    const b = (n: string) => boundsOfNamed(mosModel(st()), [n]);
    expect(b('gate oxide').min[1]).toBeGreaterThan(0);          // above the silicon's top at 0
    expect(b('source').max[1]).toBeLessThan(0);                 // below it
    expect(b('gate').min[1]).toBeGreaterThan(b('gate oxide').max[1]);
  });

  it('labels carry units and stay on finite points; every tour beat names what it frames', () => {
    const m = mosModel(st({ w: 2 })), t = m.anchors!.map((a) => a.text);
    expect(t).toContain('L = 180 nm');
    expect(t).toContain('W = 480 nm');
    expect(new Set(t).size).toBe(t.length);
    for (const a of m.anchors!) expect(a.p.every(Number.isFinite)).toBe(true);
    const names = new Set(m.items.flatMap((i) => [i.name, i.group]));
    for (const beat of m.beats!) for (const f of beat.frame ?? []) expect(names.has(f)).toBe(true);
  });

  it('the 3D and 2D views share one bias: each hears the other, never itself', () => {
    const link = biasLink(), a = {}, b = {}, seen: string[] = [];
    link.follow(a, (g, d) => seen.push(`a${g},${d}`));
    link.follow(b, (g, d) => seen.push(`b${g},${d}`));
    link.set(1.2, 0.5, a);
    expect(seen).toEqual(['b1.2,0.5']);
    expect([link.vg, link.vd]).toEqual([1.2, 0.5]);
    link.set(1.2, 0.5, b);
    expect(seen).toHaveLength(1);
  });

  it('the pull-back: copies at the device’s own footprint, the count per cm² from it, the real one left in the middle', () => {
    const s = st(), f = fieldOf(s), { X, Z } = extents(s);
    expect([f.w, f.d]).toEqual([Math.round(2 * X), Math.round(2 * Z)]);
    expect(f.perCm2).toBeCloseTo(1e14 / (f.w * f.d), 0);
    expect(f.perCm2).toBeGreaterThan(42e6); // the Pentium 4's count fits in a square centimetre at this pitch
    const sites = fieldSites(s);
    expect(sites).toHaveLength((2 * FIELD_R + 1) ** 2 - 1);
    expect(sites.some((p) => p[0] === 0 && p[2] === 0)).toBe(false);
    expect(fieldParts(s).map((p) => p.key)).not.toContain('field plugs');
    const beat = mosModel(s).beats!.at(-1)!;
    expect(beat.labels).toBe(false);
    expect(beat.text).toContain(`${f.w} × ${f.d} nm`);
  });

  it('the subject first: home frames the gate, the wiring waits for its beats, the plugs drawn faint until then', () => {
    const m = mosModel(st()), names = new Set(m.items.flatMap((i) => [i.name, i.group]));
    expect(MOS_HOME_FRAME.filter((n) => names.has(n)).length).toBeGreaterThanOrEqual(4);
    expect(MOS_HIDDEN).toEqual(['metal']);
    const plugMat = (s: MosState) => named(s, 'contact plug')[0].mat;
    expect(plugMat(st()).transmit).toBeGreaterThan(0.5);
    expect(plugMat(st({ wiring: true })).transmit ?? 0).toBe(0);
    // the beats that show the wiring say so (hide: []), the others keep metal hidden
    for (const b of m.beats!) expect(b.hide === undefined || b.hide.length === 0).toBe(true);
    expect(m.beats!.filter((b) => b.hide?.length === 0).map((b) => b.title)).toEqual(['What a process adds', 'Layer by layer']);
  });

  it('the particles stop at the cut: none past the plane, all with the cut closed', () => {
    const s = st();
    expect(cutZ(s, 0)).toBe(Infinity);
    expect(cutZ(s, 1)).toBe(0);
    const ions = ionsAt(st({ vg: VDD })), kept = ions.filter((p) => p[2] <= cutZ(s, 1));
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(ions.length);
  });

  it('the sheet glows with the overdrive', () => {
    const glow = (vg: number) => named(st({ vg }), 'channel')[0].mat.glow!;
    expect(glow(0.6)).toBeLessThan(glow(1.2));
    expect(glow(1.2)).toBeLessThan(glow(VDD) + 1e-9);
  });
});
