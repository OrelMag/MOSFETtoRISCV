// The floating-gate string: the rule held to chapter 37's lib/flash.ts and the switch-level solver, the drawing to the rule.
import { describe, expect, it } from 'vitest';
import { V_READ, vtOf } from '../src/lib/flash';
import { FG_READ, FG_STEP } from '../src/sim/switchsim';
import { CELLS, E_FULL, PASS_V, conducts, electrons, erase, fresh, program, pulse, readConduction, stringConducts } from '../src/phys/fgate';
import { CG0, CG1, FG0, FG1, FN_MV_CM, GCR_MODEL, HALF, ONO_T, V_PGM, cellX, leaving, slot, toxField, toxVolts, windowOf } from '../src/widgets/fgate3dparts';
import { A_Z, ELECTRON, MATS, STI_TOP, electronsAt, fgModel } from '../src/widgets/fgate3dkit';
import type { Item } from '../src/gl/kit/scene';

/** The drawn electrons of a pose: the electron item's vertices over one bead's. */
const drawnElectrons = (m: ReturnType<typeof fgModel>) => { const it = m.items.find((i) => i.name === 'electron'); return it ? it.geo.positions.length / ELECTRON.positions.length : 0; };
const named = (m: ReturnType<typeof fgModel>, name: string): Item[] => m.items.filter((i) => i.name === name);
/** The parts of a geometry's vertices with z beyond zMin (one side across the string). */
const ys = (it: Item, keep: (x: number, y: number, z: number) => boolean) => { const p = it.geo.positions, out: number[] = []; for (let k = 0; k < p.length; k += 3) if (keep(p[k], p[k + 1], p[k + 2])) out.push(p[k + 1]); return out; };
/** Every charge a pulse train reaches, from a fresh cell. */
const reachable = (() => { const l = [0]; while (l[l.length - 1] < 1) l.push(pulse(l[l.length - 1])); return l; })();

describe('the charge rule', () => {
  it('reachable charges are the pulse train, ending at 1', () => {
    expect(reachable[1]).toBe(FG_STEP);
    expect(reachable.at(-1)).toBe(1);
    expect(pulse(1)).toBe(1);
  });
  it('conduction at V_READ equals the solver rule q < FG_READ, for every reachable charge', () => {
    for (const q of reachable) {
      expect(conducts(q, V_READ), `q = ${q}`).toBe(q < FG_READ);
      expect(vtOf(q)).toBeCloseTo(1 + 5 * q, 9);
    }
    expect(V_READ).toBe(vtOf(FG_READ));
  });
  it('at the pass voltage every reachable cell conducts', () => {
    for (const q of reachable) expect(conducts(q, PASS_V)).toBe(true);
  });
  it('the string conducts only if the chosen cell does, whatever the others hold', () => {
    for (const q of reachable) for (const other of reachable) for (let sel = 0; sel < CELLS; sel++) {
      const b = { q: Array.from({ length: CELLS }, (_, i) => (i === sel ? q : other)), sel };
      expect(stringConducts(b)).toBe(q < FG_READ);
      expect(readConduction(b)[sel]).toBe(q < FG_READ);
    }
  });
  it('programming touches only the chosen cell; erase empties the block', () => {
    let b = fresh();
    b = { ...b, sel: 2 };
    b = program(program(b));
    expect(b.q).toEqual([0, 0, pulse(pulse(0)), 0]);
    expect(stringConducts(b)).toBe(false);
    b = erase(b);
    expect(b.q.every((q) => q === 0)).toBe(true);
    expect(stringConducts(b)).toBe(true);
  });
});

describe('the drawing', () => {
  const at = (q: number[], extra: object = {}) => fgModel({ bank: { q, sel: 0 }, reading: false, programming: false, ...extra });
  it('electron counts are monotonic in charge, 0 at 0 and E_FULL at 1', () => {
    let prev = -1;
    for (const q of reachable) { const n = electrons(q); expect(n).toBeGreaterThanOrEqual(prev); prev = n; }
    expect(electrons(0)).toBe(0);
    expect(electrons(1)).toBe(E_FULL);
  });
  it('the parts show exactly that many electrons per cell, and none after an erase', () => {
    const q = [0, 2 * FG_STEP, 1, 3 * FG_STEP];
    expect(drawnElectrons(at(q))).toBe(q.reduce((t, x) => t + electrons(x), 0));
    expect(drawnElectrons(at(erase({ q, sel: 0 }).q))).toBe(0);
  });
  it('every electron sits inside its cell\'s floating gate', () => {
    for (let k = 0; k < E_FULL; k++) for (let i = 0; i < CELLS; i++) {
      const [x, y, z] = slot(i, k);
      expect(Math.abs(x - cellX(i))).toBeLessThan(5);
      expect(y).toBeGreaterThan(3); expect(y).toBeLessThan(8);
      expect(Math.abs(z)).toBeLessThan(6);
    }
  });
  it('electrons leaving in an erase start in their slot, end below the silicon surface, and are drawn from the old counts', () => {
    for (let k = 0; k < E_FULL; k++) {
      expect(leaving(1, k, 0)).toEqual(slot(1, k));
      expect(leaving(1, k, 1)[1]).toBeLessThan(0);
      expect(leaving(1, k, 0.5)[1]).toBeLessThan(slot(1, k)[1]);
    }
    const q = [1, 0, 0.4, 0];
    const from = q.map(electrons);
    const pose = { bank: { q: erase({ q, sel: 0 }).q, sel: 0 }, reading: false, programming: false, erase: { from, t: 0.5 } };
    expect(electronsAt(pose)).toHaveLength(from.reduce((a, b) => a + b, 0));
    expect(drawnElectrons(fgModel(pose))).toBe(from.reduce((a, b) => a + b, 0));
  });
});

describe('the stack (Pavan et al., Proc. IEEE 85, 1997)', () => {
  it('the interpoly ONO is thicker than the tunnel oxide, three layers of ONO_T', () => {
    expect(CG0 - FG1).toBeCloseTo(3 * ONO_T, 9);
    expect(CG0 - FG1).toBeGreaterThan(FG0);
    expect(CG0 - FG1).toBeLessThan(2 * FG0);
  });
  const m = fgModel({ bank: fresh(), reading: false, programming: false });
  it('every slot sits inside its floating gate, every bead clear of its faces', () => {
    for (let i = 0; i < CELLS; i++) for (let k = 0; k < E_FULL; k++) {
      const [x, y, z] = slot(i, k), r = ELECTRON.max[0];
      expect(Math.abs(x - cellX(i)) + r).toBeLessThan(HALF);
      expect(y - r).toBeGreaterThan(FG0); expect(y + r).toBeLessThan(FG1);
      expect(Math.abs(z) + r).toBeLessThan(A_Z);
    }
  });
  it('one floating gate per cell, self-aligned under its control gate (same length along the string), as wide as the strip', () => {
    const fg = named(m, 'floating gate'), cg = named(m, 'control gate = word line');
    expect(fg).toHaveLength(CELLS); expect(cg).toHaveLength(CELLS);
    fg.forEach((f, i) => {
      expect(f.geo.min[0]).toBeCloseTo(cellX(i) - HALF, 6); expect(f.geo.max[0]).toBeCloseTo(cellX(i) + HALF, 6);
      expect(cg[i].geo.min[0]).toBeCloseTo(f.geo.min[0], 6); expect(cg[i].geo.max[0]).toBeCloseTo(f.geo.max[0], 6);
      expect(f.geo.min[2]).toBeCloseTo(-A_Z, 6); expect(f.geo.max[2]).toBeCloseTo(A_Z, 6);
      expect(f.mat).toBe(MATS.fg);
    });
  });
  it('the control gate is the word line: across the whole width, its skirts down both sides of the floating gate below its mid-height', () => {
    for (const c of named(m, 'control gate = word line')) {
      expect(c.geo.max[1]).toBeCloseTo(CG1, 6);
      for (const sg of [-1, 1]) {
        const side = ys(c, (_x, _y, z) => sg * z > A_Z);
        expect(side.length).toBeGreaterThan(0);
        expect(Math.min(...side)).toBeLessThan((FG0 + FG1) / 2);
        expect(Math.min(...side)).toBeCloseTo(STI_TOP, 6);
      }
      // nothing of it inside the floating gate's footprint below the ONO
      expect(ys(c, (_x, y, z) => Math.abs(z) < A_Z - 1e-6 && y < CG0 - 1e-6)).toHaveLength(0);
    }
  });
  it('the skirts stand on the trench oxide, above the silicon: the word line never touches the channel', () => {
    expect(STI_TOP).toBeGreaterThan(0);
    for (const s2 of named(m, 'trench isolation')) { expect(s2.geo.max[1]).toBeCloseTo(STI_TOP, 6); expect(s2.geo.min[1]).toBeLessThan(0); }
  });
  it('the string ends in select gates with no floating gate, a bit line and a source line', () => {
    expect(named(m, 'string select gate')).toHaveLength(1);
    expect(named(m, 'ground select gate')).toHaveLength(1);
    expect(named(m, 'bit line')).toHaveLength(1);
    expect(named(m, 'common source line')).toHaveLength(1);
  });
  it('the tunnel oxide warms only under a field, on the chosen cell for a pulse and on every cell for an erase', () => {
    const glow = (mm: ReturnType<typeof fgModel>) => named(mm, 'tunnel oxide').map((t) => (t.mat.glow ?? 0) > 0);
    expect(glow(m)).toEqual([false, false, false, false]);
    expect(glow(fgModel({ bank: { q: [0, 0, 0, 0], sel: 2 }, reading: false, programming: true, field: 1, fly: { cell: 2, n0: 0, n1: 4, t: 0.5 } }))).toEqual([false, false, true, false]);
    expect(glow(fgModel({ bank: { q: [0, 0, 0, 0], sel: 2 }, reading: false, programming: false, field: 1, erase: { from: [1, 1, 1, 1], t: 0.5 } }))).toEqual([true, true, true, true]);
  });
  it('every beat names groups the model has', () => {
    const groups = new Set(m.items.flatMap((i) => [i.group, i.name]));
    groups.add('charge');
    for (const b of m.beats ?? []) for (const g of [...(b.frame ?? []), ...(b.show ?? [])]) expect(groups.has(g), g).toBe(true);
  });
  it('the coupling ratio sets the tunnel-oxide voltage and the window; the model is the 0.6 case', () => {
    expect(windowOf(GCR_MODEL)).toBeCloseTo(5, 9);
    expect(vtOf(1) - vtOf(0)).toBeCloseTo(windowOf(GCR_MODEL), 9);
    expect(toxVolts(0.6)).toBeCloseTo(0.6 * V_PGM, 9);
    expect(toxField(0.6)).toBeGreaterThan(FN_MV_CM);
    expect(toxField(0.4)).toBeLessThan(toxField(0.6));
    expect(windowOf(0.4)).toBeGreaterThan(windowOf(0.8));
  });
});
