// The hard disk model: the fitted seek curve against its datasheet points, rotation exact, the planned read landing on its
// sector, the clock conversion to the flash chapter's cycles, and the 3D drawing held to the same numbers.
import { describe, expect, it } from 'vitest';
import { groupNum } from '../src/sim/numfmt';
import { FLASH_REAL_US, FLASH_TIMES } from '../src/flash/model';
import { CLOCK_NS } from '../src/dram/timing';
import type { RGB, RGBA } from '../src/gl/instances';
import {
  AVG_LATENCY_MS, BAND_IN, BAND_OUT, CYLINDERS, FULL_STROKE_MS, PITCH_NM, PIVOT_D, ARM_L, PLATTER_R, RPM, SCALE_VS_CPU, SECTORS, SEEK_AVG_MS, SEEK_FULL_DATASHEET_MS,
  SEEK_T2T_MS, TRACKS, TURN_MS, ZERO_SKEW_R, cpuCycles, cylinderOf, fmtMs, diskAnchors, diskParts, distance, driveRows, headAt, mediaRate, modelCycles,
  phaseAt, planRead, radiusAt, readoutRows, sectorUnder, seekMs, trackRadius, type DiskPalette,
} from '../src/widgets/disk3dparts';

const col = (i: number): RGB => [i / 20, 0.5, 0.5], al = (i: number): RGBA => [i / 20, 0.5, 0.5, 0.4];
const P: DiskPalette = { base: col(1), platter: col(2), ring: col(3), mark: col(4), hub: col(5), steel: col(6), slider: col(7), copper: col(8), magnet: col(9), yoke: al(10), magnetTop: al(11), target: col(12), live: col(13) };
const thin = (n: number) => groupNum(n);

describe('the fitted seek curve', () => {
  it('passes through the datasheet track-to-track and average seek', () => {
    expect(seekMs(0)).toBe(0);
    expect(seekMs(1)).toBeCloseTo(SEEK_T2T_MS, 9);
    // The mean over random pairs of cylinders: density 2(1 - x) of the distance fraction x.
    let mean = 0;
    const n = 200000;
    for (let i = 0; i < n; i++) { const x = (i + 0.5) / n; mean += (seekMs(x * CYLINDERS) * 2 * (1 - x)) / n; }
    expect(mean).toBeCloseTo(SEEK_AVG_MS, 1);
  });
  it('predicts the full stroke the datasheet gives, which it was not fitted to', () => {
    expect(Math.abs(FULL_STROKE_MS - SEEK_FULL_DATASHEET_MS)).toBeLessThan(0.3);
  });
  it('grows with distance, and more slowly the further it goes', () => {
    let prev = 0;
    for (let d = 1; d <= CYLINDERS; d *= 2) {
      const t = seekMs(d);
      expect(t).toBeGreaterThan(prev);
      prev = t;
    }
    // Concave: the second half of the stroke costs less than the first.
    expect(seekMs(CYLINDERS) - seekMs(CYLINDERS / 2)).toBeLessThan(seekMs(CYLINDERS / 2) - seekMs(1));
  });
});

describe('the drive', () => {
  it('turns once in 8.33 ms, and half of that is the average latency', () => {
    expect(RPM).toBe(7200);
    expect(TURN_MS).toBeCloseTo(8.3333, 3);
    expect(AVG_LATENCY_MS).toBeCloseTo(4.1667, 3);
  });
  it('has the cylinders its band and track pitch make', () => {
    expect(CYLINDERS).toBe(((BAND_OUT - BAND_IN) * 1e6) / PITCH_NM);
    expect(BAND_OUT).toBeLessThan(PLATTER_R);
  });
  it('drawn tracks run from the outer to the inner edge of the band, over the whole stroke', () => {
    expect(trackRadius(0)).toBe(BAND_OUT);
    expect(trackRadius(TRACKS - 1)).toBeCloseTo(BAND_IN, 9);
    expect(cylinderOf(0)).toBe(0);
    expect(cylinderOf(TRACKS - 1)).toBe(CYLINDERS - 1);
    expect(distance(0, TRACKS - 1)).toBe(CYLINDERS - 1);
  });
  it('the outer zone is faster than the inner one', () => {
    expect(mediaRate(BAND_OUT) / mediaRate(BAND_IN)).toBeCloseTo(BAND_OUT / BAND_IN, 1);
    expect(mediaRate(BAND_OUT) / 1e6).toBeGreaterThan(150);
    expect(mediaRate(BAND_OUT) / 1e6).toBeLessThan(250);
  });
  it('the arm puts the head exactly at the radius asked, with zero skew at the stated radius and a few tens of degrees across the band', () => {
    for (let r = BAND_IN; r <= BAND_OUT; r += 0.5) {
      const h = headAt(r);
      expect(Math.hypot(h.x, h.z)).toBeCloseTo(r, 9);
      expect(Math.hypot(PIVOT_D - h.x, h.z)).toBeCloseTo(ARM_L, 9);
    }
    expect(headAt(ZERO_SKEW_R).skew).toBeCloseTo(0, 6);
    const spread = Math.abs(headAt(BAND_IN).skew - headAt(BAND_OUT).skew) * (180 / Math.PI);
    expect(spread).toBeGreaterThan(25);
    expect(spread).toBeLessThan(45);
  });
});

describe('a planned read', () => {
  it('takes seek + latency + transfer, and the sector is under the head exactly while it transfers', () => {
    for (let from = 0; from < TRACKS; from += 3) for (let to = 0; to < TRACKS; to += 2) for (let s = 0; s < SECTORS; s++) for (const t0 of [0, 1.234, 5.5, 77.7]) {
      const p = planRead(t0, from, to, s);
      expect(p.total).toBeCloseTo(p.seek + p.wait + p.transfer, 9);
      expect(p.seek).toBeCloseTo(seekMs(distance(from, to)), 12);
      expect(p.wait).toBeGreaterThanOrEqual(0);
      expect(p.wait).toBeLessThan(TURN_MS + 1e-9);
      expect(p.transfer).toBeCloseTo(TURN_MS / SECTORS, 12);
      expect(sectorUnder(p.t2 + 1e-6, to)).toBe(s);
      expect(sectorUnder(p.t3 - 1e-6, to)).toBe(s);
      expect(sectorUnder(p.t3 + 1e-6, to)).toBe((s + 1) % SECTORS);
      if (p.wait > 1e-6) expect(sectorUnder(p.t2 - 1e-6, to)).toBe((s + SECTORS - 1) % SECTORS);
    }
  });
  it('the rotational latency averages half a turn over arrival times', () => {
    let sum = 0, n = 0;
    for (let t0 = 0; t0 < 40 * TURN_MS; t0 += 0.0137) for (const s of [3, 11]) { sum += planRead(t0, 4, 4, s).wait; n++; }
    expect(sum / n).toBeCloseTo(AVG_LATENCY_MS, 1);
  });
  it('a read on the same track needs no seek', () => {
    expect(planRead(3, 6, 6, 2).seek).toBe(0);
    expect(planRead(3, 6, 6, 2).t1).toBe(3);
  });
  it('the phases and the head radius follow the plan', () => {
    const p = planRead(10, 1, 9, 5);
    expect(phaseAt(p, 9)).toBe('idle');
    expect(phaseAt(p, 10 + p.seek / 2)).toBe('seek');
    expect(phaseAt(p, p.t2 + 0.001)).toBe('transfer');
    expect(phaseAt(p, p.t3 + 0.001)).toBe('done');
    expect(radiusAt(p, 1, 9)).toBe(trackRadius(1));
    expect(radiusAt(p, 1, p.t1)).toBe(trackRadius(9));
    expect(radiusAt(p, 1, 10 + p.seek / 2)).toBeCloseTo((trackRadius(1) + trackRadius(9)) / 2, 9);
    let last = Infinity;
    for (let t = 10; t <= p.t1; t += p.seek / 50) { const r = radiusAt(p, 1, t); expect(r).toBeLessThanOrEqual(last + 1e-12); last = r; }
  });
});

describe('the clock', () => {
  it('a flash-model cycle is the real read time over its cycles, and gives the chapter read, program and (rounded) erase', () => {
    expect(modelCycles(FLASH_REAL_US.read / 1000)).toBe(FLASH_TIMES.read);
    expect(modelCycles(FLASH_REAL_US.program / 1000)).toBe(FLASH_TIMES.program);
    expect(modelCycles(FLASH_REAL_US.erase / 1000) / FLASH_TIMES.erase).toBeGreaterThan(0.9);
    expect(modelCycles(FLASH_REAL_US.erase / 1000) / FLASH_TIMES.erase).toBeLessThan(1.0);
  });
  it('is about a hundred times the CPU clock, the scale the chapter states', () => {
    expect(SCALE_VS_CPU).toBeGreaterThan(95);
    expect(SCALE_VS_CPU).toBeLessThan(105);
    expect(cpuCycles(TURN_MS) / modelCycles(TURN_MS)).toBeCloseTo(SCALE_VS_CPU, 1);
    expect(cpuCycles(1)).toBe(Math.round(1e6 / CLOCK_NS));
  });
});

describe('what is printed', () => {
  it('prints the plan own times and its flash comparison', () => {
    const p = planRead(2.5, 2, 10, 7), rows = Object.fromEntries(readoutRows(p, 2, { track: 10, sector: 7 }));
    expect(rows['Seek']).toContain(fmtMs(seekMs(p.cylinders)));
    expect(rows['Rotational latency']).toContain(fmtMs(p.wait));
    expect(rows['Total']).toBe(fmtMs(p.total));
    expect(rows['In flash-model cycles']).toContain(thin(modelCycles(p.total)));
    expect(rows['Against a flash page read']).toContain(thin(Math.round((p.total * 1000) / FLASH_REAL_US.read)));
  });
  it('the drive rows quote the fitted curve', () => {
    const r = Object.fromEntries(driveRows());
    expect(r['1 cylinder · average · full stroke']).toContain(FULL_STROKE_MS.toFixed(1));
    expect(r['Flash-model clock']).toContain(String(FLASH_REAL_US.read));
  });
});

describe('the drawing follows the model', () => {
  const lit = (t: number, track: number, sector: number) =>
    diskParts({ phi: t / TURN_MS, r: trackRadius(track), sel: { track, sector }, phase: 'transfer' }, P).filter((q) => q.color === P.live && q.kind === 'box' && q.scale![1] < 0.2);
  it('the highlighted wedge is under the head while the sector transfers, and away from it just before', () => {
    for (const [track, sector] of [[0, 3], [5, 11], [TRACKS - 1, 0]]) {
      const p = planRead(0, 3, track, sector), h = headAt(trackRadius(track));
      const dist = (t: number) => Math.min(...lit(t, track, sector).map((q) => Math.hypot(q.pos[0] - h.x, q.pos[2] - h.z)));
      expect(dist((p.t2 + p.t3) / 2)).toBeLessThan(1.5);
      if (p.wait > 1) expect(dist(p.t2 - 0.5)).toBeGreaterThan(1.5);
    }
  });
  it('sector boundaries are radial lines that turn with the platter, a sixteenth apart', () => {
    const rods = (phi: number) => diskParts({ phi, r: 30, sel: null, phase: 'idle' }, P).filter((q) => q.color === P.mark && q.kind === 'cyl' && q.scale![1] > 20);
    expect(rods(0.1)).toHaveLength(SECTORS);
    const a = rods(0).map((q) => Math.atan2(q.pos[2], q.pos[0])), b = rods(1 / SECTORS).map((q) => Math.atan2(q.pos[2], q.pos[0]));
    const norm = (x: number) => Math.atan2(Math.sin(x), Math.cos(x));
    for (const k of a.keys()) expect(Math.abs(norm(b[k] - a[k] - (2 * Math.PI) / SECTORS))).toBeLessThan(1e-6);
  });
  it('the head slider is where the arm puts it, and labels name the main parts', () => {
    const parts = diskParts({ phi: 0, r: 40, sel: null, phase: 'seek' }, P), h = headAt(40);
    expect(parts.some((q) => q.color === P.target && Math.hypot(q.pos[0] - h.x, q.pos[2] - h.z) < 0.01)).toBe(true);
    const names = diskAnchors({ phi: 0, r: 40, sel: null, phase: 'seek' }).map((a) => a.text).join('|');
    for (const w of ['spindle hub', 'platters', 'head', 'actuator arm', 'pivot', 'voice coil', 'magnet']) expect(names).toContain(w);
  });
});
