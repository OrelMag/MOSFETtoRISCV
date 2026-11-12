// The hard disk model: the fitted seek curve against its datasheet points, rotation exact, the planned read landing on its
// sector, the clock conversion to the flash chapter's cycles, and the 3D drawing held to the same numbers.
import { describe, expect, it } from 'vitest';
import { groupNum } from '../src/sim/numfmt';
import { FLASH_REAL_US, FLASH_TIMES } from '../src/flash/model';
import { CLOCK_NS } from '../src/dram/timing';
import type { RGB, RGBA } from '../src/gl/instances';
import {
  AVG_LATENCY_MS, BAND_IN, BAND_OUT, CYLINDERS, FULL_STROKE_MS, PITCH_NM, PIVOT_D, ARM_L, PLATTER_R, RPM, SCALE_VS_CPU, SECTORS, SEEK_AVG_MS, SEEK_FULL_DATASHEET_MS,
  SEEK_T2T_MS, TRACKS, TURN_MS, ZERO_SKEW_R, trackBytes, cpuCycles, cylinderOf, fmtMs, diskAnchors, diskParts, distance, driveRows, headAt, mediaRate, modelCycles,
  phaseAt, planRead, radiusAt, readoutRows, sectorUnder, seekMs, trackRadius, type DiskPalette,
  blockMs, CAPACITY_BYTES, CAPACITY_NAMED_BYTES, DATASHEET_MEDIA_MBIT, OUTER_SECTORS, PICO_MM, QUEUE, RAMP_R, RAMP_C, SLIDER_DRAWN, guessLine, queueLine, queueRun, queueSorted, rewriteLine, PLATTER_Y,
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
    expect(CYLINDERS).toBe(Math.round(((BAND_OUT - BAND_IN) * 1e6) / PITCH_NM));
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
  it('matches the drive it names: 500 GB, and an outer media rate at the data sheet maximum of 1388 Mbit/s (DSDS721008EN-01)', () => {
    expect(Math.abs(CAPACITY_BYTES / CAPACITY_NAMED_BYTES - 1)).toBeLessThan(0.01);
    expect(Math.abs((mediaRate(BAND_OUT) * 8) / 1e6 / DATASHEET_MEDIA_MBIT - 1)).toBeLessThan(0.01);
    // The capacity from the per-track bytes themselves (4 surfaces, every cylinder at its own radius) agrees with the closed form.
    let sum = 0;
    for (let c = 0; c < CYLINDERS; c += 7) sum += trackBytes(BAND_OUT - (c * (BAND_OUT - BAND_IN)) / (CYLINDERS - 1)) * 7;
    expect(Math.abs((4 * sum) / CAPACITY_BYTES - 1)).toBeLessThan(0.002);
    expect(OUTER_SECTORS).toBe(353);
    expect(DATASHEET_MEDIA_MBIT).toBe(1388);
    expect(PITCH_NM).toBe(216);
    // 216 nm = 118 ktpi; the areal density at the outer edge stays under the family maximum of 270 Gbit/in^2 (same data sheet).
    const ktpi = 25.4e6 / PITCH_NM / 1e3, bpi = (trackBytes(BAND_OUT) * 8) / ((2 * Math.PI * BAND_OUT) / 25.4);
    expect(ktpi).toBeGreaterThan(110);
    expect(ktpi).toBeLessThan(125);
    expect((ktpi * 1e3 * bpi) / 1e9).toBeLessThan(270);
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
      expect(p.transfer).toBeCloseTo(blockMs(trackRadius(p.to)), 12);
      expect(sectorUnder(p.t2 + 1e-6, to)).toBe(s);
      // the 4 KiB block is a sliver at the wedge's leading edge: the wedge is still under the head once it has passed
      expect(sectorUnder(p.t3 - 1e-6, to)).toBe(s);
      expect(sectorUnder(p.t3 + 1e-6, to)).toBe(s);
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
      // the block is at the wedge's leading edge, so the head is over the first of its three chords
      const r = trackRadius(track), half = r * Math.sin(Math.PI / SECTORS / 3);
      expect(dist((p.t2 + p.t3) / 2)).toBeLessThan(half + 0.2);
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

describe('rewriting in place, against flash', () => {
  it('a rewrite of the sector just read needs no seek and waits almost a full turn (the sector has just gone by)', () => {
    const read = planRead(0, 4, 8, 5), w = planRead(read.t3, 8, 8, 5, { kind: 'write' });
    expect(w.kind).toBe('write');
    expect(w.seek).toBe(0);
    expect(w.wait).toBeCloseTo(TURN_MS - blockMs(trackRadius(8)), 6);
    expect(w.total).toBeLessThan(TURN_MS + 1e-9);
    // Whatever the sector, an in-place rewrite from its own track is at most one turn.
    for (let s = 0; s < SECTORS; s++) for (const t0 of [0, 2.2, 9.1]) expect(planRead(t0, 6, 6, s, { kind: 'write' }).total).toBeLessThanOrEqual(TURN_MS + blockMs(trackRadius(6)) + 1e-9);
  });
  it('the readout and the one-line contrast name the flash program, not the read', () => {
    const w = planRead(1, 5, 5, 2, { kind: 'write' }), rows = Object.fromEntries(readoutRows(w, 5, { track: 5, sector: 2 }));
    expect(rows['Request']).toContain('rewrite');
    expect(rows['Against a flash page program']).toContain(thin(Math.round((w.total * 1000) / FLASH_REAL_US.program)));
    expect(rows['Against a flash page read']).toBeUndefined();
    expect(rewriteLine(w)).toContain(`${FLASH_REAL_US.program} µs`);
    expect(rewriteLine(w)).toContain(fmtMs(w.total));
  });
});

describe('predict, then see', () => {
  it('a random read is mostly seek and latency, the transfer a few per cent', () => {
    let mean = 0, n = 0;
    for (let a = 0; a < TRACKS; a++) for (let b = 0; b < TRACKS; b++) for (let s = 0; s < SECTORS; s += 3) { const p = planRead(a * 3.7 + s, a, b, s); mean += p.transfer / p.total; n++; }
    expect(mean / n).toBeLessThan(0.1);
  });
  it('the guess line reports the factor and the shares from the plan', () => {
    const p = planRead(0, 0, 11, 6);
    expect(guessLine(p.total / 2, p)).toContain('2.0× more');
    expect(guessLine(p.total * 4, p)).toContain('4.0× less');
    expect(guessLine(10, p)).toContain(((100 * p.transfer) / p.total).toFixed(1));
  });
  it('eight random reads cost less sorted by track, on seek, and the line prints both totals', () => {
    expect(QUEUE).toHaveLength(8);
    const a = queueRun(QUEUE), b = queueRun(queueSorted());
    expect(b.seek).toBeLessThan(a.seek);
    expect(b.total).toBeLessThan(a.total);
    expect(a.transfer).toBeCloseTo(QUEUE.reduce((s, q) => s + blockMs(trackRadius(q.track)), 0), 9);
    expect(queueSorted().map((q) => q.track)).toEqual([...QUEUE.map((q) => q.track)].sort((x, y) => x - y));
    expect(queueLine()).toContain(fmtMs(a.total));
    expect(queueLine()).toContain(fmtMs(b.total));
    expect(queueLine()).toContain(fmtMs((8 * FLASH_REAL_US.read) / 1000));
  });
});

describe('the ramp and the added parts', () => {
  it('a head parked on the ramp sits beyond the recording band, and the first read starts there', () => {
    expect(RAMP_R).toBeGreaterThan(BAND_OUT);
    expect(radiusAt(null, null, 0)).toBe(RAMP_R);
    const p = planRead(2, 0, 7, 3, { fromRamp: true });
    expect(p.fromRamp).toBe(true);
    expect(radiusAt(p, null, 2)).toBe(RAMP_R);
    expect(radiusAt(p, null, p.t1)).toBe(trackRadius(7));
    expect(Math.hypot(headAt(RAMP_R).x, headAt(RAMP_R).z)).toBeCloseTo(RAMP_R, 6);
    expect(Object.fromEntries(readoutRows(null, null, { track: 2, sector: 0 }))['Head']).toContain('ramp');
  });
  it('the slider is drawn at twice the pico slider, the ramp stands beyond the platter edge, and the new parts are labelled', () => {
    expect(PICO_MM).toEqual([1.25, 1.0, 0.3]);
    expect(SLIDER_DRAWN[0]).toBe(2.5);
    expect(SLIDER_DRAWN[2]).toBe(2.0);
    const parts = diskParts({ phi: 0, r: RAMP_R, sel: null, phase: 'idle' }, P), rp = headAt(RAMP_C);
    expect(RAMP_C - 1.5).toBeGreaterThan(PLATTER_R);
    expect(parts.some((q) => q.color === P.hub && q.kind === 'box' && Math.hypot(q.pos[0] - rp.x, q.pos[2] - rp.z) < 0.01 && q.scale![1] > PLATTER_Y[1] - PLATTER_Y[0])).toBe(true);
    const names = diskAnchors({ phi: 0, r: RAMP_R, sel: null, phase: 'idle' }).map((a) => a.text).join('|');
    for (const w of ['ramp', 'preamp', 'flex cable', 'spindle motor']) expect(names).toContain(w);
  });
  it('only the head and the platters stay named when the stage is narrow', () => {
    const major = diskAnchors({ phi: 0, r: 30, sel: null, phase: 'idle' }).filter((a) => !a.minor).map((a) => a.text);
    expect(major).toEqual(['platters, 95 mm', 'head']);
  });
});

describe('one story for the transfer (batch 24 review)', () => {
  it('a read moves one 4 KiB block: tens of microseconds, the bar nearly all seek and latency', () => {
    for (let k = 0; k < TRACKS; k++) { const ms = blockMs(trackRadius(k)); expect(ms).toBeGreaterThan(0.02); expect(ms).toBeLessThan(0.06); }
    const p = planRead(0, 0, 8, 11);
    expect(p.transfer * 1000).toBeCloseTo(4096 / mediaRate(trackRadius(8)) * 1e6, 6);
    expect(p.transfer / p.total).toBeLessThan(0.01);
    const row = readoutRows(p, null, { track: 8, sector: 11 }).find(([k]) => k === 'Transfer')![1];
    expect(row).toContain('one 4 KiB block');
  });
});
