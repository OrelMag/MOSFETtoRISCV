// The 3D DRAM array held to its simulator: every height drawn is a `level` read back after the protocol step, and the
// bit lines' capacitance (the learner's ratio) changes what the simulator does, not only the drawing.
import { describe, expect, it } from 'vitest';
import type { RGB, RGBA } from '../src/gl/instances';
import { BITLINE_C, CELL_C } from '../src/lib/dram';
import { SENSE_OFFSET } from '../src/sim/switchsim';
import { SAFE_CYCLES } from '../src/widgets/dram';
import { DramBench, PATTERN, RATIO, RATIOS, safeCyclesOf, swingOf } from '../src/widgets/dram3dbench';
import {
  A_CELL, BL_X, BLB_X, dramAnchors, dramParts, HMAX, LINE_Z0, lineLength, PAD, R_CELL, W_LINE, X_OF, Z_OF, type DramPalette,
} from '../src/widgets/dram3dparts';

const c = (n: number): RGB => [n, n, n];
const P: DramPalette = {
  plate: c(0.1), line: c(0.2), wl: c(0.3), charge: c(0.4), open: c(0.5), bl: c(0.6), blb: c(0.65), unknown: [0.7, 0.7, 0.7, 0.5] as RGBA,
  amp: c(0.8), half: [0.9, 0.9, 0.9, 0.3] as RGBA, fet: c(0.85),
};
const share = (v: number, k = RATIO) => (v + k * 0.5) / (1 + k);

/** The height drawn at (x, z): the solid of any colour but the pads and wires. */
function heightAt(b: DramBench, x: number, z: number): number {
  const ps = dramParts(b.snap(), P).filter((p) => Math.abs(p.pos[0] - x) < 1e-9 && Math.abs(p.pos[2] - z) < 1e-9 && p.color !== P.line && p.pos[1] > PAD / 2);
  return ps.reduce((t, p) => t + (p.scale as number[])[1], 0) / HMAX;
}
function heldToSim(b: DramBench): void {
  const s = b.snap(), zl = LINE_Z0 - lineLength(s.ratio) / 2;
  s.cell.forEach((row, r) => row.forEach((l, cc) => {
    if (Number.isFinite(l)) expect(heightAt(b, X_OF(cc), Z_OF(r))).toBeCloseTo(l, 9);
  }));
  s.bl.forEach((l, cc) => { if (Number.isFinite(l)) expect(heightAt(b, BL_X(cc), zl)).toBeCloseTo(l, 9); });
  s.blb.forEach((l, cc) => { if (Number.isFinite(l)) expect(heightAt(b, BLB_X(cc), zl)).toBeCloseTo(l, 9); });
}

describe('the drawing is the simulator', () => {
  it('heights equal the levels at every protocol step and after Wait, bit and reference lines included', () => {
    for (const k of [RATIO, 16]) {
      const b = new DramBench(k);
      b.write(); heldToSim(b);
      b.activate(0); heldToSim(b);
      b.sense(); heldToSim(b);
      b.close(); heldToSim(b);
      b.precharge(); heldToSim(b);
      b.wait(200); heldToSim(b);
      b.refreshAll(); heldToSim(b);
    }
  });
  it('the pattern is stored: 1s at full height, 0s at none', () => {
    const b = new DramBench(); b.write();
    PATTERN.forEach((bits, r) => [0, 1, 2, 3].forEach((cc) => expect(b.snap().cell[r][cc]).toBeCloseTo((bits >> cc) & 1, 9)));
  });
  it('a destructive read: the shared level is (Cs V + Cb VDD/2) / (Cs + Cb) at every ratio, the reference stays at VDD/2', () => {
    for (const k of RATIOS) {
      const b = new DramBench(k); b.write(); b.precharge(); b.activate(0);
      const s = b.snap();
      [0, 1, 2, 3].forEach((cc) => {
        const v = (PATTERN[0] >> cc) & 1;
        expect(s.cell[0][cc]).toBeCloseTo(share(v, k), 9);
        expect(s.bl[cc]).toBeCloseTo(share(v, k), 9);
        expect(s.blb[cc]).toBeCloseTo(0.5, 9);
        expect(Math.abs(s.dv[cc])).toBeCloseTo(swingOf(k), 9);
      });
    }
  });
  it('the chapter’s ratio is its own: 100 fF over 25 fF, the readable time its SAFE_CYCLES', () => {
    expect(RATIO).toBe(BITLINE_C / CELL_C);
    expect(safeCyclesOf(RATIO)).toBe(SAFE_CYCLES);
  });
  it('a longer bit line: the swing falls under the offset at 64 ×, and the amplifier cannot restore the row', () => {
    for (const k of RATIOS) {
      const b = new DramBench(k); b.write(); b.activate(0); b.sense();
      const cells = b.snap().cell[0], ok = swingOf(k) > SENSE_OFFSET;
      expect(ok).toBe(k < 64);
      [0, 1, 2, 3].forEach((cc) => (ok ? expect(cells[cc]).toBeCloseTo((PATTERN[0] >> cc) & 1, 9) : expect(Number.isFinite(cells[cc])).toBe(false)));
      expect(safeCyclesOf(k) > 0).toBe(ok);
    }
  });
  it('sensing restores the charge; the rows not opened are untouched', () => {
    const b = new DramBench(); b.write(); b.activate(0); b.sense();
    const s = b.snap();
    [0, 1, 2, 3].forEach((cc) => expect(s.cell[0][cc]).toBeCloseTo((PATTERN[0] >> cc) & 1, 9));
    [0, 1, 2, 3].forEach((cc) => expect(s.cell[1][cc]).toBeCloseTo((PATTERN[1] >> cc) & 1, 9));
    // driven apart: the bit line to its cell's rail, the reference to the other
    [0, 1, 2, 3].forEach((cc) => expect(s.blb[cc]).toBeCloseTo(1 - ((PATTERN[0] >> cc) & 1), 9));
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
  it('waiting with a row open and not sensed is explained, not hidden', () => {
    const b = new DramBench(); b.write(); b.activate(0); b.wait(200);
    expect(b.note).toMatch(/open and not sensed/);
    b.sense(); b.wait(50);
    expect(b.note).toBe('50 cycles passed.');
  });
});

describe('the drawing', () => {
  it('footprint area follows capacitance: a cell’s circle, a bit line’s trough ratio × as large', () => {
    for (const k of RATIOS) expect(W_LINE * lineLength(k)).toBeCloseTo(k * A_CELL, 9);
    expect(A_CELL).toBeCloseTo(Math.PI * R_CELL * R_CELL, 12);
  });
  it('the open row’s access transistors and word line are lit, the amplifiers only while sensing', () => {
    const b = new DramBench(); b.write(); b.activate(1);
    const lit = (q: DramBench) => dramParts(q.snap(), P);
    expect(lit(b).filter((p) => p.color === P.wl && p.kind === 'box')).toHaveLength(4);
    expect(lit(b).filter((p) => p.color === P.amp)).toHaveLength(0);
    b.sense();
    expect(lit(b).filter((p) => p.color === P.amp)).toHaveLength(4);
  });
  it('anchors name the ratio from the bench, and the first frame has a row open with a stored pattern', () => {
    const b = new DramBench(16); b.write(); b.activate(0);
    expect(b.snap().open).toBe(0);
    expect(dramAnchors(b.snap()).map((a) => a.text)).toContain(`bit line: 16× a cell (${16 * CELL_C} fF)`);
    expect(dramParts(b.snap(), P).length).toBeLessThan(220);
  });
});
