// The standard cell's studio model (widgets/cell3dkit.ts) held to its sources: the SkyWater PDK's film thicknesses at the
// 44 λ = 2.72 µm row, the contact stack in height order, the layers the reader and the tour switch on, and the charge
// that moves through the conducting channels when the output switches.
import { describe, expect, it } from 'vitest';
import type { RGB } from '../src/gl/instances';
import { boundsOfNamed } from '../src/gl/kit/scene';
import { LAMBDA_NM, ROW_UM, type CellPalette } from '../src/widgets/cell3dparts';
import { BEAT_LAYERS, DRAWN, FRAME_GROUPS, PDK, SRC, UM, carriers, cellModel, heights, lanes, type CellLayer, type CellLook } from '../src/widgets/cell3dkit';
import { CELLS } from '../src/widgets/silicon';

const G: RGB = [0.5, 0.5, 0.5];
const P: CellPalette = { psub: G, nwell: G, sti: G, ndiff: G, pdiff: G, poly: G, gox: G, licon: G, li1: G, mcon: G, metal: G, chanOn: [0, 1, 0] };
const NAND2 = CELLS[1];
const look = (layers: CellLayer[] = ['metal'], ins: Record<string, number> = { A: 1, B: 1 }): CellLook => ({ detail: 'flat', ins, layers: new Set(layers), pal: P });
const um = (l: number) => (l * LAMBDA_NM) / 1000;

describe('sourced dimensions', () => {
  it('1 λ is a 44th of sky130’s 2.72 µm row', () => {
    expect(ROW_UM).toBe(2.72);
    expect(um(44)).toBeCloseTo(2.72, 9);
    expect(UM * LAMBDA_NM).toBeCloseTo(1000, 9);
    expect(SRC.lef).toContain('2.72');
  });
  it('the films are the PDK’s thicknesses, the gate oxide drawn thicker and said so', () => {
    const z = heights();
    expect(um(z.poly1 - z.poly0)).toBeCloseTo(PDK.poly, 9);
    expect(um(z.li1 - z.li0)).toBeCloseTo(PDK.li1, 9);
    expect(um(z.met1 - z.met0)).toBeCloseTo(PDK.met1, 9);
    expect(um(z.li0)).toBeCloseTo(PDK.preLi, 9);
    expect(um(z.well)).toBeCloseTo(PDK.nwell, 9);
    expect(um(z.junction)).toBeCloseTo(PDK.junction, 9);
    expect(um(z.gox)).toBeCloseTo(PDK.gox * DRAWN.goxScale, 9);
    expect([PDK.poly, PDK.li1, PDK.met1, PDK.preLi, PDK.nwell]).toEqual([0.18, 0.1, 0.35, 0.5, 1.1]);
    expect(SRC.pdk).toContain('SkyWater');
  });
  it('the stack is in height order: oxide, poly, li1, metal 1; the drawn films sit at those heights', () => {
    const z = heights();
    expect(z.gox).toBeLessThanOrEqual(z.poly0);
    expect(z.poly1).toBeLessThan(z.li0);
    expect(z.li1).toBeLessThan(z.met0);
    const m = cellModel(NAND2, look());
    const b = (n: string) => boundsOfNamed(m, [n]);
    expect(b('polysilicon').min[1]).toBeCloseTo(z.poly0, 6);
    expect(b('polysilicon').max[1]).toBeCloseTo(z.poly1, 6);
    expect(b('li1 (local interconnect)').min[1]).toBeCloseTo(z.li0, 6);
    expect(b('metal 1').max[1]).toBeCloseTo(z.met1, 6);
    expect(b('metal 1').min[1]).toBeCloseTo(z.met0, 6);
  });
  it('the cell is its layout: w λ wide, 44 λ deep, centred', () => {
    for (const c of CELLS) {
      const b = boundsOfNamed(cellModel(c, look(['metal'], Object.fromEntries(c.inputs.map((n) => [n, 1])))), ['metal 1']);
      expect(b.max[2] - b.min[2]).toBeLessThanOrEqual(44 + 1e-6);
      expect(b.max[0] - b.min[0]).toBeLessThanOrEqual(c.w + 1e-6);
    }
  });
});

describe('the subject first, one layer at a time', () => {
  it('home has no oxide over the cell and no neighbours; metal 1 is a layer the reader can take off', () => {
    const m = cellModel(NAND2, look());
    expect(m.items.some((it) => it.group === 'ild' || it.group === 'row')).toBe(false);
    const off = cellModel(NAND2, look([]));
    expect(off.items.some((it) => it.name === 'metal 1' || it.name === 'mcon contact')).toBe(false);
    expect(off.items.some((it) => it.name === 'li1 (local interconnect)')).toBe(true);
  });
  it('the oxide between the films and the neighbours appear only with their layers', () => {
    expect(cellModel(NAND2, look(['metal', 'ild'])).items.filter((it) => it.group === 'ild')).toHaveLength(2);
    const row = cellModel(NAND2, look(['metal', 'row'])), b = boundsOfNamed(row, []);
    expect(row.items.some((it) => it.group === 'row')).toBe(true);
    // the neighbours carry no names, so the gutters name only the cell itself
    expect(row.items.filter((it) => it.group === 'row').every((it) => it.name === undefined)).toBe(true);
    expect(b.max[0] - b.min[0]).toBeGreaterThan(2 * NAND2.w);
  });
  it('every beat names the layers it lends; only the oxide beat shows the oxide, only the row beat the neighbours', () => {
    const m = cellModel(NAND2, look());
    expect(BEAT_LAYERS.length).toBe(m.beats!.length);
    BEAT_LAYERS.forEach((ls, i) => {
      expect(ls.includes('ild')).toBe(m.beats![i].title === 'Oxide between');
      expect(ls.includes('row')).toBe(m.beats![i].title === 'Cells abut in rows');
    });
    for (const g of FRAME_GROUPS) {
      expect(cellModel(NAND2, { ...look(), detail: 'full' }).items.some((it) => it.group === g)).toBe(true);
      expect(m.items.some((it) => it.group === g)).toBe(true);
    }
  });
  it('the cut runs through the NMOS gate', () => {
    const m = cellModel(NAND2, look()), g = NAND2.shapes.find((s) => s.gate && s.gate[1] === 'n')!;
    const d = m.cuts!.planes[0].d;
    expect(d).toBeGreaterThan(g.r[1] - 22);
    expect(d).toBeLessThan(g.r[1] + g.r[3] - 22);
  });
});

describe('the charge that moves when the output switches', () => {
  it('y falling: electrons through every NMOS that is on, from the GND side toward the output', () => {
    const ls = lanes(NAND2, { A: 1, B: 1 });
    expect(NAND2.eval({ A: 1, B: 1 }).y).toBe(0);
    expect(ls.length).toBe(NAND2.shapes.filter((s) => s.gate && s.gate[1] === 'n').length);
    expect(ls.every((l) => l.kind === 'n')).toBe(true);
  });
  it('y rising: holes through the PMOS that are on, and only those', () => {
    const ls = lanes(NAND2, { A: 0, B: 1 });
    expect(NAND2.eval({ A: 0, B: 1 }).y).toBe(1);
    expect(ls).toHaveLength(1);
    expect(ls[0].kind).toBe('p');
    const s = NAND2.shapes.find((q) => q.gate && q.gate[1] === 'p' && q.gate[0] === 'A')!;
    expect(ls[0].r).toBe(s.r);
  });
  it('the inverter: electrons leave the GND side, holes the VDD side', () => {
    const inv = CELLS[0];
    for (const [v, kind, rail] of [[1, 'n', 'gnd'], [0, 'p', 'vdd']] as const) {
      const [l] = lanes(inv, { [inv.inputs[0]]: v });
      expect(l.kind).toBe(kind);
      const layer = kind === 'n' ? 'ndiff' : 'pdiff';
      const railSide = inv.shapes.find((q) => q.layer === layer && !q.gate && q.node === rail)!;
      const railX = railSide.r[0] + railSide.r[2] / 2;
      expect(Math.abs(l.from - railX)).toBeLessThan(Math.abs(l.to - railX));
    }
  });
  it('the beads fade in and out over the burst and stay on their channel', () => {
    const ls = lanes(NAND2, { A: 1, B: 1 }), col = { e: [1, 0, 0] as RGB, h: [0, 0, 1] as RGB };
    expect(carriers(NAND2, ls, 0, col).every((b) => b.scale![0] === 0)).toBe(true);
    expect(carriers(NAND2, ls, 1, col).every((b) => Math.abs(b.scale![0]) < 1e-9)).toBe(true);
    const mid = carriers(NAND2, ls, 0.5, col);
    expect(mid).toHaveLength(ls.length * 6);
    for (const b of mid) expect(b.pos[1]).toBeLessThan(heights().poly1);
  });
});
