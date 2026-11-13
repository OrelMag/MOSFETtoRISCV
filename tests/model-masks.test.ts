// The mask-by-mask model held to the cell data, to sky130's mask set and to fabWidget's steps.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { RGB, RGBA } from '../src/gl/instances';
import {
  activeOf, area, channelOf, DEPTH, LAMBDA_UM, MK_DEPTH, TRUE_UM, V_FACTOR, implanted, intersect, LAND_AT, LAYERS, maskRects, MASK_AT, masksAnchors, masksParts, minus, misalignment, place, polyOf, rayPoints, reticle, windowOf, WINDOW_MARGIN, zs,
  type MaskName, type MasksPalette, type R,
} from '../src/widgets/masks3dparts';
import { CELLS, FAB } from '../src/widgets/silicon';
import { cutZ, ionInstances, masksModel, TOUR_STEPS } from '../src/widgets/masks3dkit';

const G: RGB = [0.5, 0.5, 0.5], CLEAR: RGBA = [0.5, 0.5, 0.5, 0.3];
const P: MasksPalette = { psub: G, sti: G, gox: G, resist: CLEAR, ild: CLEAR, uv: CLEAR, chrome: CLEAR, plate: CLEAR, pell: CLEAR, frame: G, layer: Object.fromEntries(LAYERS.map((l) => [l, G])) as MasksPalette['layer'] };
const MASKS: MaskName[] = ['diff', 'nwell', 'poly', 'nsdm', 'psdm', 'licon1', 'met1'];
const st = (step: number, over: Partial<{ shift: number; aligned: boolean; spread: number }> = {}) => ({ step, spread: 0.35, shift: 0, aligned: true, ...over });
const top = (p: { pos: number[]; scale?: number[] }) => p.pos[1] + (p.scale?.[1] ?? 0) / 2;

describe('masks in 3D', () => {
  it('follows fabWidget’s steps in sky130’s order: isolation before the well', () => {
    expect(FAB.map(([n]) => n)).toEqual(['Substrate', 'Isolation', 'N-well', 'Gate stack', 'Lithography', 'Etch', 'N+ implant', 'P+ implant', 'Contacts', 'Metal']);
    expect(MASK_AT).toHaveLength(FAB.length);
    expect(LAND_AT.sti).toBeLessThan(LAND_AT.nwell);
    expect(MASK_AT.filter((m) => m)).toEqual(['diff', 'nwell', 'poly', 'poly', 'nsdm', 'psdm', 'licon1', 'met1']);
    // The text says what the model draws (sky130: aluminium, five metals).
    expect(FAB[9][1]).toMatch(/five metal layers, aluminium/);
    expect(FAB[9][1]).not.toMatch(/Copper wires/);
  });

  it('every step changes what is drawn', () => {
    for (const cell of CELLS) for (let s = 1; s < FAB.length; s++) {
      const a = JSON.stringify(masksParts(cell, st(s - 1), P)), b = JSON.stringify(masksParts(cell, st(s), P));
      expect(b, `${cell.name}: step ${s} is identical to step ${s - 1}`).not.toBe(a);
    }
  });

  for (const cell of CELLS) {
    describe(cell.name, () => {
      it('implant windows are larger than the diffusion by the margin on every side, and are not its shape', () => {
        for (const k of ['n', 'p'] as const) {
          const w = windowOf(cell, k)[0], act = activeOf(cell, k);
          for (const r of act) {
            expect(r[1] - w[1]).toBeGreaterThanOrEqual(WINDOW_MARGIN - 1e-9);
            expect(w[1] + w[3] - (r[1] + r[3])).toBeGreaterThanOrEqual(WINDOW_MARGIN - 1e-9);
            expect(r[0]).toBeGreaterThanOrEqual(w[0]);
            expect(r[0] + r[2]).toBeLessThanOrEqual(w[0] + w[2]);
          }
          expect(area([w])).toBeGreaterThan(area(act));
        }
        expect(area(intersect(windowOf(cell, 'n'), activeOf(cell, 'p')))).toBe(0);
        expect(area(intersect(windowOf(cell, 'p'), activeOf(cell, 'n')))).toBe(0);
      });

      it('active area is the diffusions with their channels', () => {
        const all = cell.shapes.filter((s) => s.layer === 'ndiff' || s.layer === 'pdiff').map((s) => s.r);
        expect(area(maskRects(cell, 'diff'))).toBeCloseTo(area(all), 6);
        expect(area(channelOf(cell, 'n', 0)) + area(channelOf(cell, 'p', 0))).toBeCloseTo(area(cell.shapes.filter((s) => s.gate).map((s) => s.r)), 6);
      });

      it('the implant lands on window ∩ active minus the gate: never under the gate, never in the field', () => {
        for (const k of ['n', 'p'] as const) for (const shift of [-2, -0.5, 0, 1, 2]) {
          const imp = implanted(cell, k, shift, true), gate = polyOf(cell, shift);
          expect(area(intersect(imp, gate))).toBe(0);
          expect(area(minus(imp, activeOf(cell, k)))).toBe(0);
          expect(area(imp) + area(channelOf(cell, k, shift))).toBeCloseTo(area(activeOf(cell, k)), 6);
        }
      });

      it('self-aligned: any poly shift leaves neither overlap nor a gap; implanting first does', () => {
        for (const shift of [-2, -1, 0, 1, 2]) expect(misalignment(cell, shift, true)).toEqual({ overlap: 0, gap: 0 });
        expect(misalignment(cell, 0, false)).toEqual({ overlap: 0, gap: 0 });
        const m = misalignment(cell, 1, false);
        expect(m.overlap).toBeGreaterThan(0);
        expect(m.gap).toBeGreaterThan(0);
        // A shift of s λ puts s λ of each gate over source/drain and leaves s λ of its channel bare: equal areas.
        expect(m.overlap).toBeCloseTo(m.gap, 6);
      });

      it('masks are the cell’s shapes (contacts, metal), poly follows the shift', () => {
        expect(area(maskRects(cell, 'licon1'))).toBeCloseTo(cell.shapes.filter((s) => s.layer === 'contact').length * 4, 6);
        expect(area(maskRects(cell, 'met1'))).toBeCloseTo(area(cell.shapes.filter((s) => s.layer === 'metal').map((s) => s.r)), 6);
        expect(maskRects(cell, 'nsdm')).toHaveLength(1);
        expect(maskRects(cell, 'poly', 1.5)[0][0]).toBeCloseTo(maskRects(cell, 'poly', 0)[0][0] + 1.5, 9);
      });

      it('the STI is the active area’s complement; the silicon stays at or below the surface until the gate stack', () => {
        const f: R = [0, 0, cell.w, 44], sti = minus([f], maskRects(cell, 'diff'));
        expect(area(sti) + area(maskRects(cell, 'diff'))).toBeCloseTo(area([f]), 6);
        for (const step of [0, 1, 2]) for (const p of masksParts(cell, st(step), P)) if (p.color.length === 3 && top(p) < zs(0.35).plate - 2) expect(top(p)).toBeLessThanOrEqual(1e-9);
        // The implants of the last wafer steps are sunk into the active area too.
        const z = (step: number) => Math.max(...masksParts(cell, st(step), P).filter((p) => p.color.length === 3 && p.pos[1] < 0.5 && top(p) < zs(0.35).plate - 2).map(top));
        expect(z(7)).toBeLessThanOrEqual(1e-9 + 0.14);
        expect(DEPTH.sti).toBeLessThan(DEPTH.well);
        expect(DEPTH.junction).toBeLessThan(DEPTH.sti);
      });

      it('the gate stack is blanket, lithography leaves resist on the pattern, the etch leaves the pattern', () => {
        const z = zs(0.35), mid = (a: number, b: number) => (a + b) / 2;
        const at = (step: number, y: number) => masksParts(cell, st(step), P).filter((p) => p.kind === 'box' && Math.abs(p.pos[1] - y) < 1e-9);
        const polyY = mid(z.poly0, z.poly1), resY = mid(z.res0, z.res1);
        expect(at(3, polyY)).toHaveLength(1);
        expect(at(3, polyY)[0].scale![0]).toBeCloseTo(cell.w, 9);
        expect(at(5, polyY)).toHaveLength(maskRects(cell, 'poly').length);
        expect(at(4, resY)).toHaveLength(maskRects(cell, 'poly').length);
        expect(at(5, resY)).toHaveLength(0);
      });

      it('UV rays pass through clear parts of the reticle only', () => {
        const pat = polyOf(cell, 0), pts = rayPoints(cell, 0);
        expect(pts.length).toBeGreaterThan(0);
        for (const [x, y] of pts) expect(pat.some((r) => x >= r[0] && x <= r[0] + r[2] && y >= r[1] && y <= r[1] + r[3])).toBe(false);
      });

      it('a reticle has plate, chrome pattern, pellicle frame and film, above the stack', () => {
        for (const m of MASKS) {
          const parts = reticle(cell, m, st(4), P);
          expect(parts.length).toBe(1 + maskRects(cell, m).length + 4 + 1 + rayPoints(cell, 0).length);
          for (const p of parts.filter((q) => q.kind === 'box')) expect(p.pos[1] - p.scale![1] / 2).toBeGreaterThan(zs(0.35).res1);
        }
      });

      it('labels the wafer, what the step does and the reticle', () => {
        const text = (step: number) => masksAnchors(cell, st(step)).map((a) => a.text);
        expect(text(0)).toEqual(['p-type wafer']);
        expect(text(1)).toEqual(['p-type wafer', 'STI oxide', 'active (diff) reticle']);
        expect(text(3)).toEqual(['p-type wafer', 'blanket poly']);
        expect(text(9)).toEqual(['p-type wafer', 'metal 1', 'metal 1 (met1) reticle']);
      });
    });
  }

  it('opens on the cell the layout step opens on', () => {
    const src = readFileSync(new URL('../src/widgets/masks3dview.ts', import.meta.url), 'utf8');
    expect(CELLS[1].name).toBe('NAND2');
    expect(src).toMatch(/let cell = CELLS\[1\]/);
  });
});

describe('masks on the studio renderer', () => {
  const cell = CELLS[1];
  it('every slab is drawn once, merged by what it is made of', () => {
    for (let s = 0; s < FAB.length; s++) {
      const m = masksModel(cell, st(s)), parts = masksParts(cell, st(s), P), dark = s === 6 || s === 7;
      const tri = (n: number) => n * 12; // a box is 12 triangles
      const drawn = m.items.reduce((a, i) => a + i.geo.indices.length / 3, 0);
      // the boxes (dark-field implant masks redraw the chrome: plate minus window) and the beams' cylinders
      const boxes = parts.filter((p) => p.kind === 'box').length - (dark ? maskRects(cell, MASK_AT[s]!).length : 0);
      if (!dark && !parts.some((p) => p.kind === 'cyl')) expect(drawn).toBe(tri(boxes));
      for (const it of m.items) for (const v of it.geo.positions) expect(Number.isFinite(v)).toBe(true);
      expect(new Set(m.items.map((i) => i.name)).size).toBe(m.items.length);
    }
  });
  it('an implant reticle is dark-field: the window is clear, so the ions fall through it and stop on the gate or in the silicon', () => {
    const m = masksModel(cell, st(6)), chrome = m.items.find((i) => i.name === 'chrome pattern')!.geo, w = windowOf(cell, 'n')[0];
    // no chrome over the window's middle
    const mid = place(cell, w[0] + w[2] / 2, w[1] + w[3] / 2, 0);
    const P3 = chrome.positions;
    let over = false;
    for (let i = 0; i < P3.length; i += 3) if (Math.abs(P3[i] - mid[0]) < 1 && Math.abs(P3[i + 2] - mid[2]) < 1) over = true;
    expect(over).toBe(false);
    const ions = ionInstances(cell, st(6), 10, [1, 1, 1]);
    expect(ions.length).toBeGreaterThan(50);
    for (const p of ions) { expect(p.pos[2]).toBeGreaterThanOrEqual(place(cell, 0, w[1], 0)[2] - 1e-9); expect(p.pos[2]).toBeLessThanOrEqual(place(cell, 0, w[1] + w[3], 0)[2] + 1e-9); }
    expect(ionInstances(cell, st(5), 10, [1, 1, 1])).toEqual([]);
  });
  it('the cut runs along the NMOS row; the tour visits its steps', () => {
    const m = masksModel(cell, st(6)), a = activeOf(cell, 'n');
    expect(m.cuts!.planes[0].d).toBeCloseTo(place(cell, 0, (Math.min(...a.map((r) => r[1])) + Math.max(...a.map((r) => r[1] + r[3]))) / 2, 0)[2], 9);
    expect(cutZ(cell)).toBe(m.cuts!.planes[0].d);
    expect(m.beats).toHaveLength(TOUR_STEPS.length);
    expect(TOUR_STEPS.map((s) => MASK_AT[s])).toEqual(['diff', 'poly', 'nsdm', 'met1']);
  });
});

describe('masks: one height factor', () => {
  it('every layer is drawn at V_FACTOR of its sky130 thickness against the footprint (1 λ = 62 nm)', () => {
    expect(V_FACTOR).toBe(0.25);
    expect(LAMBDA_UM).toBe(0.062);
    const z = zs(0), u = (um: number) => (V_FACTOR * um) / LAMBDA_UM;
    expect(z.poly1 - z.poly0).toBeCloseTo(u(0.18), 9);
    expect(z.res1 - z.res0).toBeCloseTo(u(1.14), 9);
    expect(z.metal1 - z.metal0).toBeCloseTo(u(0.35), 9);
    expect(z.ild).toBeCloseTo(u(0.5) + z.poly0, 9); // the dielectric's top is 0.5 µm above the gate's foot
    expect(MK_DEPTH.well).toBeCloseTo(u(1.1), 9);
    expect(MK_DEPTH.junction).toBeCloseTo(u(0.1), 9);
    // the true ratios hold in the drawing: metal 1 is 0.35 / 0.18 the poly's thickness
    expect((z.metal1 - z.metal0) / (z.poly1 - z.poly0)).toBeCloseTo(0.35 / 0.18, 9);
    expect(TRUE_UM).toEqual({ poly: 0.18, ild: 0.5, metal: 0.35, resist: 1.14, well: 1.1, junction: 0.1, sti: 0.3 });
  });
});
