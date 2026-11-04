// The mask-by-mask model held to the cell data and to fabWidget's steps.
import { describe, expect, it } from 'vitest';
import type { RGB, RGBA } from '../src/gl/instances';
import { disjoint } from '../src/widgets/cell3d';
import { landed, LANDS, layerRects, MASK_AT, maskSolids, masksAnchors, masksParts, stageOf, stageSolids, type MasksPalette, type Stage } from '../src/widgets/masks3dparts';
import { CELLS, FAB, levels } from '../src/widgets/silicon';

const area = (rs: [number, number, number, number][]) => disjoint(rs).reduce((t, [, , w, h]) => t + w * h, 0);
const flat = (s: { x0: number; x1: number; y0: number; y1: number }): [number, number, number, number] => [s.x0, s.y0, s.x1 - s.x0, s.y1 - s.y0];
const G: RGB = [0.5, 0.5, 0.5], CLEAR: RGBA = [0.5, 0.5, 0.5, 0.3];
const P: MasksPalette = { psub: G, plate: CLEAR, chan: [0.1, 0.1, 0.1], layer: { nwell: G, poly: G, ndiff: G, pdiff: G, contact: G, metal: G } };
const STAGES: Stage[] = ['nwell', 'poly', 'ndiff', 'pdiff', 'contact', 'metal'];

describe('masks in 3D', () => {
  it('follows fabWidget’s steps, by name and order', () => {
    expect(FAB.map(([n]) => n)).toEqual(['Substrate', 'N-well', 'Isolation', 'Gate stack', 'Lithography', 'Etch', 'N+ implant', 'P+ implant', 'Contacts', 'Metal']);
    expect(LANDS).toHaveLength(FAB.length);
    expect(MASK_AT).toHaveLength(FAB.length);
    // Layers land in the process order, each once.
    expect(LANDS.filter((l) => l)).toEqual(['nwell', 'poly', 'ndiff', 'pdiff', 'contact', 'metal']);
    expect(FAB[LANDS.indexOf('poly')][0]).toBe('Etch');
    expect(landed(0)).toEqual([]);
    expect(landed(9)).toEqual(STAGES);
  });

  for (const cell of CELLS) {
    it(`${cell.name}: every shape is in exactly one stage and the solids are the cell’s rectangles`, () => {
      const counts = STAGES.map((st) => cell.shapes.filter((s) => stageOf(s) === st).length);
      expect(counts.reduce((a, b) => a + b, 0)).toBe(cell.shapes.length);
      for (const st of STAGES) {
        const src = cell.shapes.filter((s) => stageOf(s) === st).map((s) => s.r), solids = stageSolids(cell, st, 0.4);
        const boxes = solids.map(flat);
        // Same union of area as the source rectangles: nothing missing, nothing invented.
        expect(area(boxes)).toBeCloseTo(area(src), 6);
        expect(area([...boxes, ...src])).toBeCloseTo(area(src), 6);
        // Within one stage the solids do not overlap each other (except channels, which sit under the gate's poly level).
        const plain = solids.filter((s) => !s.chan).map(flat);
        expect(plain.reduce((t, [, , w, h]) => t + w * h, 0)).toBeCloseTo(area(plain), 6);
      }
    });

    it(`${cell.name}: a mask is exactly its layer’s pattern`, () => {
      for (const st of STAGES) {
        const { plate, pattern } = maskSolids(cell, st, 0.4);
        const src = cell.shapes.filter((s) => !s.gate && stageOf(s) === st).map((s) => s.r);
        expect(area(pattern.map(flat))).toBeCloseTo(area(src), 6);
        expect(area([...pattern.map(flat), ...src])).toBeCloseTo(area(src), 6);
        for (const p of pattern) expect(p.z1).toBeLessThanOrEqual(plate.z0 + 1e-9);
        expect(plate.z0).toBeGreaterThan(levels(0.4).metal1);
      }
    });
  }

  it('adds a layer per landing step, and a mask plate with its pattern where there is a mask', () => {
    const cell = CELLS[0], n = (step: number) => masksParts(cell, { step, spread: 0.5 }, P).length;
    const mask = (step: number) => (MASK_AT[step] ? 1 + layerRects(cell, MASK_AT[step]!).length : 0);
    for (let s = 1; s < FAB.length; s++) {
      const grown = LANDS[s] ? stageSolids(cell, LANDS[s]!, 0.5).length : 0;
      // The well replaces the plug of wafer it stands in (one part), so step 1 nets one fewer.
      expect(n(s) - n(s - 1)).toBe(grown - (s === 1 ? 1 : 0) + mask(s) - mask(s - 1));
    }
    expect(n(3)).toBe(n(2));
  });

  it('labels the wafer, the layer that landed and the mask', () => {
    const cell = CELLS[0], text = (step: number) => masksAnchors(cell, { step, spread: 0.5 }).map((a) => a.text);
    expect(text(0)).toEqual(['p-type wafer']);
    expect(text(9)).toEqual(['p-type wafer', 'metal 1', 'metal 1 mask']);
    expect(text(4)).toEqual(['p-type wafer', 'polysilicon mask']);
  });
});
