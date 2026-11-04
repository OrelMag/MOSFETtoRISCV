// The 3D DRAM array held to its simulator: every height drawn is a `level` read back after the protocol step.
import { describe, expect, it } from 'vitest';
import type { RGB, RGBA } from '../src/gl/instances';
import { BITLINE_C, CELL_C } from '../src/lib/dram';
import { SENSE_OFFSET } from '../src/sim/switchsim';
import { DramBench, PATTERN } from '../src/widgets/dram3dbench';
import { dramAnchors, dramParts, HMAX, PAD, R_BL, R_CELL, X_OF, Z_OF, type DramPalette } from '../src/widgets/dram3dparts';

const c = (n: number): RGB => [n, n, n];
const P: DramPalette = { plate: c(0.1), line: c(0.2), wl: c(0.3), charge: c(0.4), open: c(0.5), bl: c(0.6), unknown: [0.7, 0.7, 0.7, 0.5] as RGBA };
const share = (v: number) => (CELL_C * v + BITLINE_C * 0.5) / (CELL_C + BITLINE_C);

/** The height drawn at (x, z): the column of any colour but the pad. */
function heightAt(b: DramBench, x: number, z: number): number {
  const ps = dramParts(b.snap(), P).filter((p) => p.kind === 'cyl' && Math.abs(p.pos[0] - x) < 1e-9 && Math.abs(p.pos[2] - z) < 1e-9 && p.color !== P.line);
  return ps.reduce((t, p) => t + (p.scale as number[])[1], 0) / HMAX;
}
function heldToSim(b: DramBench): void {
  const s = b.snap();
  s.cell.forEach((row, r) => row.forEach((l, cc) => {
    if (Number.isFinite(l)) expect(heightAt(b, X_OF(cc), Z_OF(r))).toBeCloseTo(l, 9);
  }));
  s.bl.forEach((l, cc) => { if (Number.isFinite(l)) expect(heightAt(b, X_OF(cc), -30)).toBeCloseTo(l, 9); });
}

describe('the drawing is the simulator', () => {
  it('heights equal the levels at every protocol step and after Wait', () => {
    const b = new DramBench();
    b.write(); heldToSim(b);
    b.activate(0); heldToSim(b);
    b.sense(); heldToSim(b);
    b.close(); heldToSim(b);
    b.precharge(); heldToSim(b);
    b.wait(200); heldToSim(b);
    b.refreshAll(); heldToSim(b);
  });
  it('the pattern is stored: 1s at full height, 0s at none', () => {
    const b = new DramBench(); b.write();
    PATTERN.forEach((bits, r) => [0, 1, 2, 3].forEach((cc) => expect(b.snap().cell[r][cc]).toBeCloseTo((bits >> cc) & 1, 9)));
  });
  it('a destructive read: the shared level is Cs V + Cb/2 over Cs + Cb, as the sim reports', () => {
    const b = new DramBench(); b.write(); b.precharge(); b.activate(0);
    const s = b.snap();
    [0, 1, 2, 3].forEach((cc) => {
      const v = (PATTERN[0] >> cc) & 1;
      expect(s.cell[0][cc]).toBeCloseTo(share(v), 9);
      expect(s.bl[cc]).toBeCloseTo(share(v), 9);
      expect(s.dv[cc]).toBeCloseTo((v - 0.5) * CELL_C / (CELL_C + BITLINE_C), 9);
    });
  });
  it('sensing restores the charge; the rows not opened are untouched', () => {
    const b = new DramBench(); b.write(); b.activate(0); b.sense();
    const s = b.snap();
    [0, 1, 2, 3].forEach((cc) => expect(s.cell[0][cc]).toBeCloseTo((PATTERN[0] >> cc) & 1, 9));
    [0, 1, 2, 3].forEach((cc) => expect(s.cell[1][cc]).toBeCloseTo((PATTERN[1] >> cc) & 1, 9));
  });
  it('refresh keeps a bit past the readable time; waiting too long loses it', () => {
    const kept = new DramBench(); kept.write();
    for (let i = 0; i < 3; i++) { kept.wait(200); kept.refreshAll(); }
    expect(kept.snap().cell[2].every((l) => Math.abs(l - 1) < 1e-9)).toBe(true);
    const lost = new DramBench(); lost.write(); lost.wait(600);
    lost.precharge(); lost.activate(2); lost.sense();
    expect(lost.snap().cell[2].every((l) => !(l > 0.5))).toBe(true);
  });
  it('the readable level needs a swing above the amplifier offset', () => {
    const b = new DramBench(); b.write(); b.wait(150); b.precharge(); b.activate(2);
    expect(Math.min(...b.snap().dv)).toBeGreaterThan(SENSE_OFFSET);
  });
  it('footprint area follows capacitance, and the first frame has a row open with a stored pattern', () => {
    expect((R_BL / R_CELL) ** 2).toBeCloseTo(BITLINE_C / CELL_C, 9);
    expect(PAD).toBeGreaterThan(0);
    const b = new DramBench(); b.write(); b.activate(0);
    expect(b.snap().open).toBe(0);
    expect(dramAnchors(b.snap()).length).toBeGreaterThan(2);
    expect(dramParts(b.snap(), P).length).toBeLessThan(200);
  });
});
