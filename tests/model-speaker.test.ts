// The loudspeaker model against the chapter's voice: the real cone is a second-order system (mass-controlled at the voice's
// pitch), the massless contrast sits exactly on the held (ZOH) sample, the drawn dust cap is where the model says, the stroke
// stays within Xmax, and the microphone's EMF is Bl times the cone's velocity.
import { describe, expect, it } from 'vitest';
import { quatRotate } from '../src/gl/math';
import { wavSamples } from './dsp/wav';
import {
  BL, CMS_M_N, QMS, currentA, currentForStroke, evolve, strokeForAmp, DRAW_K, FS_HZ, MMS_KG, PRESSURE_PA, SD_M2, drawnRatio, pitchHz, realMotion, realPeakUm, realUm, velocityMmS, GEOM, I_FULL, VOICE_RATE, WINDOW, XMAX_MM, coneMm, dustY, emfVolts, heldCode, loudestWindow, makeDrive, poseAt, slab,
  speakerAnchors, speakerParts, staircase, type SpeakerPalette,
} from '../src/widgets/speaker3dparts';

const w = wavSamples('public/dsp/voice-8k.wav');
const codes = w.x.slice(loudestWindow(w.x), loudestWindow(w.x) + WINDOW);
const col = (i: number): [number, number, number] => [i / 20, 0.5, 0.5];
const P: SpeakerPalette = {
  steel: col(1), magnet: col(2), basket: col(3), cone: [0.3, 0.3, 0.3, 0.8], dust: col(5), former: col(6), wire: col(7), wire2: col(16), flux: col(17), rubber: col(8), spider: col(9),
  stair: col(10), stairDim: [0.1, 0.1, 0.9, 0.3], trace: col(12), cursor: col(13), live: col(14), zero: col(15),
};
const same = (a: readonly number[], b: readonly number[]) => a.every((v, i) => Math.abs(v - b[i]) < 1e-6);

describe('the speaker model against the chapter', () => {
  it('uses the chapter\'s recording: 8 kHz, a full window of its samples', () => {
    expect(w.rate).toBe(VOICE_RATE);
    expect(codes).toHaveLength(WINDOW);
    expect(Math.max(...codes.map(Math.abs))).toBeGreaterThan(1000);
  });

  it('ZOH: the massless contrast has the cone at any t on the held sample, scaled to Xmax', () => {
    const d = makeDrive(codes, 'speaker', true);
    for (let n = 0; n < WINDOW; n++) {
      for (const f of [0, 0.25, 0.5, 0.999]) {
        const t = n + f, p = poseAt(d, t);
        expect(heldCode(d, t)).toBe(codes[n]);
        expect(p.cone).toBeCloseTo(codes[n] / d.peak, 12);
        expect(coneMm(p.cone)).toBeCloseTo((codes[n] / d.peak) * XMAX_MM, 9);
        expect(p.code).toBe(codes[n]);
      }
    }
    // The staircase drawn is the held codes, one step per sample.
    expect(staircase(d)).toEqual(codes.map((c) => c / d.peak));
  });

  it('the drawn dust cap sits at the cone position (rest height plus the real stroke, DRAW_K = 1)', () => {
    expect(DRAW_K).toBe(1);
    const d = makeDrive(codes, 'speaker', false), dust = (t: number) => speakerParts(d, t, P).filter((p) => same(p.color as number[], P.dust));
    const lowY = (t: number) => Math.min(...dust(t).map((p) => p.pos[1] - p.scale![1] / 2));
    expect(Math.max(...dust(0).map((p) => p.pos[1])) - Math.min(...dust(0).map((p) => p.pos[1]))).toBeGreaterThan(3); // a dome, not a disc
    for (const n of [0, 7, 20, 41, 63]) {
      const c = poseAt(d, n + 0.5).cone;
      expect(lowY(n + 0.5) - lowY(0)).toBeCloseTo(dustY(c) - dustY(poseAt(d, 0).cone), 6);
    }
  });

  it('stays within Xmax, and the coil stays in its gap (the winding covers the gap over the whole stroke)', () => {
    for (const massless of [false, true]) {
      const d = makeDrive(codes, 'speaker', massless);
      let top = 0;
      for (let t = 0; t < WINDOW; t += 0.1) {
        const p = poseAt(d, t);
        top = Math.max(top, Math.abs(coneMm(p.cone)));
        expect(Math.abs(coneMm(p.cone))).toBeLessThanOrEqual(XMAX_MM * 1.005);
        const dy = p.cone * XMAX_MM * DRAW_K, wl = GEOM.windLow + dy, wh = GEOM.windHigh + dy;
        expect(wl).toBeLessThanOrEqual(GEOM.magnetTop + 0.05);
        expect(wh).toBeGreaterThanOrEqual(GEOM.plateTop - 0.05);
      }
      expect(top).toBeGreaterThan(XMAX_MM * 0.99); // the window's largest excursion is Xmax
    }
    expect((GEOM.windHigh - GEOM.windLow - (GEOM.plateTop - GEOM.magnetTop)) / 2).toBe(XMAX_MM);
  });

  it('the coil is centred in the gap: the same clearance inside and out', () => {
    expect(GEOM.formerIn - GEOM.poleR).toBeCloseTo(GEOM.plateIn - GEOM.windOut, 9);
  });

  it('the cone is a second-order system: exact stepping, the static limit, the mass law, no staircase edges', () => {
    const [xs, vs] = evolve(0, 0, 10, 2); // a constant force settles at F·Cms
    expect(xs).toBeCloseTo(10 * CMS_M_N, 6);
    expect(vs).toBeCloseTo(0, 6);
    expect(evolve(0, 0, 10, 1e-4)[0] / (0.5 * (10 / MMS_KG) * 1e-8)).toBeCloseTo(1, 2); // x = ½ (F / M) t² at first
    const wd = Math.sqrt(1 / (MMS_KG * CMS_M_N)) * Math.sqrt(1 - 1 / (4 * QMS * QMS));
    expect(evolve(0, 0, 1, Math.PI / wd)[0]).toBeGreaterThan(CMS_M_N * 1.5); // half a ring on: Q = 3 overshoots
    // the mass law: a sine of one period per window needs i = x · |1/Cms − ω²Mms + jωRms| / Bl, as currentForStroke says
    const sine = Array.from({ length: WINDOW }, (_, i) => Math.round(1000 * Math.sin((2 * Math.PI * i) / WINDOW)));
    const f = VOICE_RATE / WINDOW, d = makeDrive(sine, 'speaker', false);
    expect(d.ipeak / currentForStroke(f)).toBeGreaterThan(0.98);
    expect(d.ipeak / currentForStroke(f)).toBeLessThan(1.04);
    expect(d.ipeak).toBeGreaterThan(5); // amperes at 125 Hz, not the stiffness law's 0.685
    const dv = makeDrive(codes, 'speaker', false); // the voice itself needs several amperes for Xmax at its pitch
    expect(dv.ipeak).toBeGreaterThan(3);
    expect(currentA(dv, 1)).toBeCloseTo(dv.ipeak, 12);
    expect(currentA(makeDrive(codes, 'speaker', true), 1)).toBeCloseTo(I_FULL, 12);
    // the cone is continuous across a sample edge, where the held current jumps (no staircase edge reaches the cone)
    for (const n of [5, 30, 50]) expect(Math.abs(poseAt(dv, n + 1 - 1e-9).cone - poseAt(dv, n + 1).cone)).toBeLessThan(1e-3);
    // above the resonance the stroke from 1 A falls as 1 / f²
    expect(strokeForAmp(500) / strokeForAmp(1000) / 4).toBeGreaterThan(0.95);
    expect(strokeForAmp(500) / strokeForAmp(1000) / 4).toBeLessThan(1.05);
  });

  it('the microphone: EMF is Bl times the cone velocity, and the ADC holds one value a period', () => {
    const f0 = pitchHz(w.x, loudestWindow(w.x)), d = makeDrive(codes, 'mic', false, VOICE_RATE, f0);
    const top = Math.max(...codes.map((c, i) => Math.abs(codes[(i + 1) % WINDOW] - c)));
    for (const n of [3, 30, 62]) {
      // The real velocity: the joined samples' slope times the real peak excursion at 94 dB SPL (1.41 Pa peak) on the RS180-8 at f0.
      const v = (poseAt(d, n + 1 - 1e-9).cone - poseAt(d, n).cone) * realMotion(f0).x * VOICE_RATE;
      expect(velocityMmS(d, n)).toBeCloseTo(v * 1000, 5);
      expect(emfVolts(d, n)).toBeCloseTo(BL * v, 9);
      expect(emfVolts(d, n) * 1000).toBeCloseTo(BL * velocityMmS(d, n), 9); // mV = T·m × mm/s
      expect(poseAt(d, n + 0.2).code).toBe(poseAt(d, n + 0.8).code);
      expect(d.adc[n]).toBeCloseTo((codes[(n + 1) % WINDOW] - codes[n]) / top, 9);
    }
    // The cone itself is continuous: the samples joined.
    expect(poseAt(d, 10).cone).toBeCloseTo(codes[10] / d.peak, 12);
    expect(poseAt(d, 10.5).cone).toBeCloseTo((codes[10] + codes[11]) / 2 / d.peak, 12);
  });

  it('the real stroke: 94 dB SPL (1.41 Pa peak) on Sd, mass-controlled above Fs, and the drawn / real ratio is consistent', () => {
    expect(CMS_M_N * 1000).toBeCloseTo(1.12, 9);
    expect(1 / ((2 * Math.PI * FS_HZ) ** 2 * MMS_KG) * 1000).toBeCloseTo(1.12, 1); // Fs and Mms agree to 1 %
    const f0 = pitchHz(w.x, loudestWindow(w.x));
    expect(f0).toBeGreaterThan(50);
    expect(f0).toBeLessThan(400);
    const { v, x } = realMotion(f0), wr = 2 * Math.PI * f0;
    expect(v).toBeCloseTo((PRESSURE_PA * SD_M2) / (wr * MMS_KG - 1 / (wr * CMS_M_N)), 12);
    expect(x).toBeCloseTo(v / wr, 12);
    expect(f0).toBeGreaterThan(FS_HZ);
    expect(x * 1e6).toBeGreaterThan(0.2); // micrometres, not millimetres
    expect(x * 1e6).toBeLessThan(10);
    const d = makeDrive(codes, 'mic', false, VOICE_RATE, f0);
    expect(realPeakUm(d)).toBeCloseTo(x * 1e6, 9);
    expect(realUm(d, 1)).toBeCloseTo(realPeakUm(d), 12);
    // The drawn stroke is Xmax × DRAW_K; the ratio the readout prints is drawn over real.
    expect(drawnRatio(d) * realPeakUm(d)).toBeCloseTo(XMAX_MM * DRAW_K * 1000, 6);
    // The window's peak sample moves the cone by the real peak, and the drawn dust cap by Xmax × DRAW_K.
    expect(Math.abs(realUm(d, poseAt(d, codes.findIndex((c) => Math.abs(c) === d.peak)).cone))).toBeCloseTo(realPeakUm(d), 9);
    // The EMF of the voice stays in the millivolts a cone-and-coil of this size makes.
    for (let k = 0; k < WINDOW; k++) expect(Math.abs(emfVolts(d, k))).toBeLessThan(0.1);
  });

  it('the datasheet figures', () => {
    expect(XMAX_MM).toBe(6);
    expect(BL).toBe(7.82);
    expect(I_FULL).toBeCloseTo(0.685, 3); // the stiffness law's current, valid below Fs only
    expect(2 * GEOM.formerOut).toBeCloseTo(38, 0); // the 38 mm coil's former
    expect(2 * Math.sqrt(124.7 / Math.PI) * 10).toBeGreaterThan(2 * GEOM.coneRim - 2); // Sd's diameter, 126 mm
  });

  it('slabs are oriented: the local x axis points along the radial slope', () => {
    const phi = 1.25 * Math.PI, s = slab([0, 0, 0], phi, 0.2, 10, 0, 20, 0, 1), x = quatRotate(s.rot!, [1, 0, 0]);
    expect(x[0]).toBeCloseTo(Math.cos(phi), 9);
    expect(x[2]).toBeCloseTo(Math.sin(phi), 9);
    expect(x[1]).toBeCloseTo(0, 9);
  });

  it('every part is cut away at the front (z <= 0) except nothing, and labels are in both modes', () => {
    for (const mode of ['speaker', 'mic'] as const) {
      const d = makeDrive(codes, mode, false);
      for (const p of speakerParts(d, 5.5, P)) if (p.pos[0] < 130) expect(p.pos[2]).toBeLessThanOrEqual(2); // flux / current marks sit just in front of the cut face
      expect(speakerAnchors(d, 5.5).length).toBeGreaterThan(8);
    }
  });
});
