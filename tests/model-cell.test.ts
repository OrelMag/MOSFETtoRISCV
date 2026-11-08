// The standard-cell model held to the cell data, to sky130's layer stack and to the step's own text.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { RGB } from '../src/gl/instances';
import { disjoint } from '../src/widgets/cellgeom';
import {
  CELL_LAYERS, cellAnchors, cellParts, cellSolids, clipAt, colourOf, cz, defaultCut, gateCut, LAMBDA_NM, pinsOf, ROW_UM, sectionText, tapsOf, tone,
  type CellPalette, type CellState,
} from '../src/widgets/cell3dparts';
import { area, DEPTH, type R } from '../src/widgets/masks3dparts';
import { CELLS } from '../src/widgets/silicon';

const G: RGB = [0.5, 0.5, 0.5];
const P: CellPalette = { psub: G, nwell: G, sti: G, ndiff: G, pdiff: G, poly: G, gox: G, licon: G, li1: G, mcon: G, metal: G, chanOn: [0, 1, 0] };
const state = (c: (typeof CELLS)[number], over: Partial<CellState> = {}): CellState => ({
  ins: Object.fromEntries(c.inputs.map((n) => [n, 1])), spread: 0.3, cut: null, show: Object.fromEntries(CELL_LAYERS.map((l) => [l, true])) as CellState['show'], ...over,
});
const inside = (rs: R[], x: number, y: number) => rs.some(([a, b, w, h]) => a < x && x < a + w && b < y && y < b + h);

describe('standard cell in 3D', () => {
  it('turns overlapping rectangles into disjoint ones covering the same area', () => {
    for (const rs of [[[0, 0, 24, 4], [3, 0, 3, 14], [18, 0, 3, 14]], [[10.5, 10, 3, 15], [10.5, 22, 10, 3], [17.5, 22, 3, 12]]] as R[][]) {
      const d = disjoint(rs);
      for (let x = 0.25; x < 25; x += 0.5) for (let y = 0.25; y < 40; y += 0.5) {
        expect(inside(d, x, y)).toBe(inside(rs, x, y));
        expect(d.filter((r) => inside([r], x, y)).length).toBeLessThanOrEqual(1);
      }
    }
  });

  it('is scaled so the 44 λ row is sky130’s 2.72 µm, and says so', () => {
    expect(ROW_UM).toBe(2.72);
    expect(44 * LAMBDA_NM).toBeCloseTo(2720, 6);
    expect(LAMBDA_NM).toBeCloseTo(61.8, 1);
    const view = readFileSync(new URL('../src/widgets/cell3dview.ts', import.meta.url), 'utf8');
    expect(view).toContain('1.38 µm × 2.72 µm');
    // A NAND2 of 24 λ is 1.48 µm: 7 % wider than nand2_1.
    expect((24 * LAMBDA_NM) / 1380).toBeCloseTo(1.075, 2);
  });

  for (const cell of CELLS) {
    describe(cell.name, () => {
      const solids = cellSolids(cell, state(cell)), z = cz(0.3);
      const of = (l: string) => solids.filter((s) => s.layer === l);

      it('diffusion is sunk into the surface, never raised; the trenches are the active area’s complement', () => {
        for (const s of [...of('diff'), ...of('chan'), ...of('si'), ...of('sti')]) expect(s.z1).toBeLessThanOrEqual(1e-9);
        for (const s of of('diff')) expect(s.z0).toBe(-DEPTH.junction);
        const act = [...cell.shapes.filter((s) => s.layer === 'ndiff' || s.layer === 'pdiff').map((s) => s.r), tapsOf(cell).n, tapsOf(cell).p];
        expect(area(of('sti').map((s) => s.r)) + area(act)).toBeCloseTo(cell.w * 44, 6);
      });

      it('has a contact stack: licon1 to li1 to mcon to met1, in height order', () => {
        expect(z.li0).toBeGreaterThan(z.poly1);
        expect(z.li1).toBeGreaterThan(z.li0);
        expect(z.metal0).toBeGreaterThan(z.li1);
        const diffContacts = cell.shapes.filter((s) => s.layer === 'contact').length + 2;
        expect(of('mcon')).toHaveLength(diffContacts);
        expect(of('licon')).toHaveLength(diffContacts + cell.inputs.length);
        for (const l of of('licon')) expect(l.z1).toBe(z.li0);
        for (const m of of('mcon')) { expect(m.z0).toBe(z.li1); expect(m.z1).toBe(z.metal0); }
        // every plug sits on an li1 pad
        for (const p of [...of('licon'), ...of('mcon')]) expect(of('li1').some((l) => p.r[0] >= l.r[0] - 1e-9 && p.r[0] + p.r[2] <= l.r[0] + l.r[2] + 1e-9 && p.r[1] >= l.r[1] - 1e-9 && p.r[1] + p.r[3] <= l.r[1] + l.r[3] + 1e-9)).toBe(true);
      });

      it('every input is a poly pad with a contact on it, and the pad belongs to its gate’s poly', () => {
        for (const p of pinsOf(cell)) {
          expect(p.contact[0]).toBeGreaterThanOrEqual(p.pad[0] - 1e-9);
          expect(p.contact[0] + p.contact[2]).toBeLessThanOrEqual(p.pad[0] + p.pad[2] + 1e-9);
          expect(p.contact[1]).toBeGreaterThanOrEqual(p.pad[1] - 1e-9);
          expect(p.contact[1] + p.contact[3]).toBeLessThanOrEqual(p.pad[1] + p.pad[3] + 1e-9);
          const strip = cell.shapes.find((s) => s.layer === 'poly' && !s.gate && s.node === p.node && s.r[3] > s.r[2])!;
          expect(area([[...p.pad] as R, [...strip.r] as R]) < area([[...p.pad] as R]) + area([[...strip.r] as R])).toBe(true);
          // a licon on poly, not on silicon
          expect(of('licon').some((l) => l.node === p.node && l.z0 === z.poly1)).toBe(true);
        }
      });

      it('the n-well is tied to VDD and the substrate to GND by taps under the rails', () => {
        const t = tapsOf(cell), well = cell.shapes.find((s) => s.layer === 'nwell')!.r;
        const ins = (a: R, b: R) => a[0] >= b[0] && a[1] >= b[1] && a[0] + a[2] <= b[0] + b[2] && a[1] + a[3] <= b[1] + b[3];
        expect(ins(t.n, well)).toBe(true);
        expect(ins(t.p, well)).toBe(false);
        const vdd = cell.shapes.find((s) => s.layer === 'metal' && s.node === 'vdd')!.r, gnd = cell.shapes.find((s) => s.layer === 'metal' && s.node === 'gnd')!.r;
        expect(ins(t.nc, vdd)).toBe(true);
        expect(ins(t.pc, gnd)).toBe(true);
        expect(of('diff').filter((s) => s.node === 'vdd' && s.kind === 'n' && s.r[0] === t.n[0])).toHaveLength(1);
      });

      it('metal and poly are the cell’s rectangles, merged per net without overlap', () => {
        for (const [layer, src] of [['metal', 'metal'], ['poly', 'poly']] as const) {
          const mine = of(layer).map((s) => s.r), cellRs = cell.shapes.filter((s) => s.layer === src && !s.gate).map((s) => s.r);
          const extra = layer === 'poly' ? pinsOf(cell).map((p) => p.pad) : [];
          expect(area(mine)).toBeCloseTo(area([...cellRs, ...extra]), 6);
          expect(mine.reduce((t, r) => t + r[2] * r[3], 0)).toBeCloseTo(area(mine), 6);
        }
      });

      it('the channel conducts as the old picture said: NMOS on a 1, PMOS on a 0', () => {
        for (const ins of [{ A: 0, B: 0 }, { A: 1, B: 0 }, { A: 1, B: 1 }]) {
          const sol = cellSolids(cell, { ins, spread: 0.3 }).filter((s) => s.layer === 'chan');
          for (const g of cell.shapes.filter((s) => s.gate)) {
            const on = g.gate![1] === 'n' ? (ins as Record<string, number>)[g.gate![0]] === 1 : (ins as Record<string, number>)[g.gate![0]] === 0;
            if (!(g.gate![0] in ins)) continue;
            expect(sol.find((s) => s.r === g.r)!.on).toBe(on);
          }
        }
        expect(colourOf({ layer: 'chan', r: [0, 0, 1, 1], z0: 0, z1: 0, on: true, kind: 'n' }, P)).toEqual(P.chanOn);
      });

      it('a section plane keeps y ≤ cut, flat at the plane, and loses no area below it', () => {
        const cut = defaultCut(cell), clipped = clipAt(solids, cut);
        for (const s of clipped) expect(s.r[1] + s.r[3]).toBeLessThanOrEqual(cut + 1e-9);
        for (const layer of ['psub', 'metal', 'poly', 'diff'] as const) {
          const full = solids.filter((s) => s.layer === layer).map((s) => s.r), part = clipped.filter((s) => s.layer === layer).map((s) => s.r);
          const kept = full.filter((r) => r[1] < cut).map((r): R => [r[0], r[1], r[2], Math.min(r[1] + r[3], cut) - r[1]]);
          expect(area(part)).toBeCloseTo(area(kept), 6);
        }
        expect(clipAt(solids, null)).toBe(solids);
        expect(cellParts(cell, state(cell, { cut }), P).length).toBeLessThan(cellParts(cell, state(cell), P).length + 1);
      });

      it('the default plane cuts an NMOS gate: n+ | gate oxide | polysilicon | n+', () => {
        const y = defaultCut(cell), g = gateCut(cell, y)!;
        expect(g.kind).toBe('n');
        expect([g.left, g.right]).toEqual(['n+', 'n+']);
        expect(g.x1 - g.x0).toBe(2);
        expect(sectionText(cell, y)).toMatch(/n\+ \| gate oxide \| polysilicon \| n\+/);
        // the solids at the plane, bottom to top over the channel: silicon, inversion layer, oxide, poly
        const x = (g.x0 + g.x1) / 2, at = (l: string) => cellSolids(cell, state(cell)).filter((s) => s.layer === l && s.r[0] < x && x < s.r[0] + s.r[2] && s.r[1] <= y && y < s.r[1] + s.r[3]);
        const [si] = at('si'), [chan] = at('chan'), [gox] = at('gox'), [poly] = at('poly');
        expect([si.z1, chan.z1, gox.z0, gox.z1 <= poly.z0, poly.z1 > poly.z0]).toEqual([chan.z0, 0, 0, true, true]);
        // and on either side, n+ at the surface down to the junction
        for (const side of [g.x0 - 0.5, g.x1 + 0.5]) expect(cellSolids(cell, state(cell)).some((s) => s.layer === 'diff' && s.kind === 'n' && s.r[0] < side && side < s.r[0] + s.r[2] && s.r[1] <= y && y < s.r[1] + s.r[3])).toBe(true);
        // a plane through no gate says so
        expect(sectionText(cell, 20)).toMatch(/no gate/);
      });

      it('hides what the layer toggles hide, and labels the rails, the output and the inputs', () => {
        const all = cellParts(cell, state(cell), P).length;
        for (const l of CELL_LAYERS) expect(cellParts(cell, state(cell, { show: { ...state(cell).show, [l]: false } }), P).length).toBeLessThan(all);
        const text = cellAnchors(cell, state(cell)).map((a) => a.text);
        expect(text).toEqual(expect.arrayContaining(['VDD', 'GND', ...cell.inputs.map((n) => `${n} = 1`)]));
        expect(text.some((t) => t.startsWith('y = '))).toBe(true);
      });
    });
  }

  it('nets are bright at 1, dark at 0, faded when floating', () => {
    expect(tone(G, 1)[0]).toBeGreaterThan(G[0]);
    expect(tone(G, 0)[0]).toBeLessThan(G[0]);
    expect(tone(G, 'z')).toHaveLength(4);
    expect(tone(G, undefined)).toEqual(G);
  });

  it('opens on NAND2 like the layout step did, and the index points at the new factory', () => {
    const view = readFileSync(new URL('../src/widgets/cell3dview.ts', import.meta.url), 'utf8');
    expect(view).toMatch(/let cell = CELLS\[1\]/);
    expect(CELLS[1].name).toBe('NAND2');
  });
});
