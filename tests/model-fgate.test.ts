// The floating-gate string: the rule held to chapter 37's lib/flash.ts and the switch-level solver, the drawing to the rule.
import { describe, expect, it } from 'vitest';
import { V_READ, vtOf } from '../src/lib/flash';
import { FG_READ, FG_STEP } from '../src/sim/switchsim';
import { CELLS, E_FULL, PASS_V, conducts, electrons, erase, fresh, program, pulse, readConduction, stringConducts } from '../src/phys/fgate';
import { cellX, fgParts, slot, type FgPalette } from '../src/widgets/fgate3dparts';

const c = (n: number): [number, number, number] => [n, n, n];
const P: FgPalette = { si: c(0.1), n: c(0.2), poly: c(0.3), oxide: c(0.4), metal: c(0.5), charge: c(0.6), carrier: c(0.7), hot: c(0.8) };
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
  const electronParts = (q: number[]) => fgParts({ bank: { q, sel: 0 }, reading: false, programming: false }, P).filter((p) => p.color[0] === P.charge[0] && p.color[1] === P.charge[1] && p.scale![0] < 2);
  it('electron counts are monotonic in charge, 0 at 0 and E_FULL at 1', () => {
    let prev = -1;
    for (const q of reachable) { const n = electrons(q); expect(n).toBeGreaterThanOrEqual(prev); prev = n; }
    expect(electrons(0)).toBe(0);
    expect(electrons(1)).toBe(E_FULL);
  });
  it('the parts show exactly that many electrons per cell, and none after an erase', () => {
    const q = [0, 2 * FG_STEP, 1, 3 * FG_STEP];
    expect(electronParts(q)).toHaveLength(q.reduce((t, x) => t + electrons(x), 0));
    expect(electronParts(erase({ q, sel: 0 }).q)).toHaveLength(0);
  });
  it('every electron sits inside its cell\'s floating gate', () => {
    for (let k = 0; k < E_FULL; k++) for (let i = 0; i < CELLS; i++) {
      const [x, y, z] = slot(i, k);
      expect(Math.abs(x - cellX(i))).toBeLessThan(5);
      expect(y).toBeGreaterThan(3); expect(y).toBeLessThan(8);
      expect(Math.abs(z)).toBeLessThan(6);
    }
  });
});
