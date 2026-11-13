// The loudspeaker model against the chapter's voice: the real cone is a second-order system (mass-controlled at the voice's
// pitch), the massless contrast sits exactly on the held (ZOH) sample, the cone is drawn where the model says and the phase plug stays put, the stroke
// stays within Xmax, and the microphone's EMF is Bl times the cone's velocity.
import { describe, expect, it } from 'vitest';
import { wavSamples } from './dsp/wav';
import {
  BL, CMS_M_N, QMS, I_RATED, peakStrokeMm, currentA, currentForStroke, evolve, strokeForAmp, DRAW_K, FS_HZ, MMS_KG, PRESSURE_PA, SD_M2, drawnRatio, pitchHz, realMotion, realPeakUm, realUm, velocityMmS, GEOM, I_FULL, VOICE_RATE, WINDOW, XMAX_MM, coneMm, neckY, emfVolts, GEOM as G0, PLUG, heldCode, loudestWindow, makeDrive, poseAt, NECK_Y,
  staircase,
} from '../src/widgets/speaker3dparts';
import { bentAt, dyOf, speakerModel, speakerPose } from '../src/widgets/speaker3dkit';
import { boundsOfNamed } from '../src/gl/kit/scene';

const w = wavSamples('public/dsp/voice-8k.wav');
const codes = w.x.slice(loudestWindow(w.x), loudestWindow(w.x) + WINDOW);

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

  it('the drawn cone sits at the cone position (rest height plus the real stroke, the drawn magnification)', () => {
    expect(DRAW_K).toBe(1);
    const d = makeDrive(codes, 'speaker', false);
    for (const n of [0, 7, 20, 41, 63]) {
      const s = { d, t: n + 0.5 }, mv = speakerPose(s).get('moving')!;
      expect(mv[13]).toBeCloseTo(neckY(poseAt(d, n + 0.5).cone, d.mag) - NECK_Y, 5);
      expect(dyOf(s)).toBeCloseTo(mv[13], 5);
    }
  });

  it('the phase plug (Dayton: solid aluminium, no dust cap) is fixed, solid, clear of the former and above the neck', () => {
    const d = makeDrive(codes, 'speaker', false), m = speakerModel({ d, t: 0 });
    for (const n of [7, 20, 41, 63]) expect(speakerPose({ d, t: n + 0.5 }).has('plug')).toBe(false); // the cone moves, the plug does not
    expect(m.items.some((i) => /dust cap/.test(i.name ?? ''))).toBe(false);
    expect(boundsOfNamed(m, ['plug']).max[1]).toBeCloseTo(PLUG.tip, 3);
    let top = 0;
    for (let t = 0; t < WINDOW; t += 0.1) top = Math.max(top, neckY(poseAt(d, t).cone, d.mag));
    expect(top).toBeGreaterThan(G0.formerTop);
    expect(PLUG.tip).toBeGreaterThan(top + 10); // it stands well above the neck at the window's highest drawn stroke
    expect(PLUG.r).toBeLessThan(G0.formerIn); // a clearance to the moving former
  });

  it('the drive is the rated power: peak current <= sqrt(2 P / Re), the real stroke <= Xmax, the drawn one too and the coil stays in its gap', () => {
    expect(I_RATED).toBeCloseTo(Math.sqrt((2 * 60) / 6.4), 12); // Dayton: 60 W RMS, Re 6.4 ohm
    expect(I_RATED).toBeLessThan(5);
    for (const massless of [false, true]) {
      const d = makeDrive(codes, 'speaker', massless);
      let top = 0;
      for (let t = 0; t < WINDOW; t += 0.1) {
        const p = poseAt(d, t);
        expect(Math.abs(currentA(d, p.drive))).toBeLessThanOrEqual((massless ? I_FULL : I_RATED) + 1e-9);
        top = Math.max(top, Math.abs(coneMm(p.cone)));
        expect(Math.abs(coneMm(p.cone))).toBeLessThanOrEqual(XMAX_MM * 1.005);
        const dy = p.cone * XMAX_MM * d.mag, wl = GEOM.windLow + dy, wh = GEOM.windHigh + dy;
        expect(Math.abs(dy)).toBeLessThanOrEqual(XMAX_MM * 1.005);
        expect(wl).toBeLessThanOrEqual(GEOM.magnetTop + 0.05);
        expect(wh).toBeGreaterThanOrEqual(GEOM.plateTop - 0.05);
      }
      if (massless) { expect(top).toBeGreaterThan(XMAX_MM * 0.99); expect(d.mag).toBe(1); }
      else {
        // the real stroke at voice pitch is about a millimetre, far under Xmax, and the picture says how much it is magnified
        expect(top).toBeLessThan(2);
        expect(top).toBeCloseTo(peakStrokeMm(d), 1);
        expect(d.mag).toBeGreaterThan(2);
        expect(top * d.mag).toBeGreaterThan(XMAX_MM * 0.7);
        expect(top * (d.mag + 1)).toBeGreaterThan(XMAX_MM); // the largest whole factor that stays in the gap
      }
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
    expect(evolve(0, 0, 10, 1e-4)[0] / (0.5 * (10 / MMS_KG) * 1e-8)).toBeCloseTo(1, 1); // x = ½ (F / M) t² at first
    const wd = Math.sqrt(1 / (MMS_KG * CMS_M_N)) * Math.sqrt(1 - 1 / (4 * QMS * QMS));
    expect(evolve(0, 0, 1, Math.PI / wd)[0]).toBeGreaterThan(CMS_M_N * 1.2); // half a ring on: Q = 1.22 overshoots by exp(-pi z / sqrt(1 - z^2)) = 24 %
    // the mass law: a sine of one period per window needs i = x · |1/Cms − ω²Mms + jωRms| / Bl, as currentForStroke says
    const sine = Array.from({ length: WINDOW }, (_, i) => Math.round(1000 * Math.sin((2 * Math.PI * i) / WINDOW)));
    const f = VOICE_RATE / WINDOW, d = makeDrive(sine, 'speaker', false);
    const stroke = peakStrokeMm(d); // the sine's real stroke at the rated peak current
    expect(stroke / strokeForAmp(f, I_RATED)).toBeGreaterThan(0.97);
    expect(stroke / strokeForAmp(f, I_RATED)).toBeLessThan(1.03);
    expect(stroke).toBeLessThan(XMAX_MM * 0.6); // mass-controlled at 125 Hz: Xmax would take currentForStroke(f) amperes
    expect(currentForStroke(f)).toBeGreaterThan(1.5 * I_RATED);
    const dv = makeDrive(codes, 'speaker', false); // the voice itself needs several amperes for Xmax at its pitch
    expect(dv.ipeak).toBe(I_RATED);
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
    // The window's peak sample moves the cone by the real peak, and the drawn cone by Xmax × DRAW_K.
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

  it('the spider, surround and lead bend in place: the same counts at every pose', () => {
    const r = bentAt(0, 'full');
    for (const dy of [-6, -2.5, 3, 6]) {
      const b = bentAt(dy, 'full');
      for (const k of ['spider', 'surround', 'lead'] as const) { expect(b[k].positions.length).toBe(r[k].positions.length); expect(b[k].indices.length).toBe(r[k].indices.length); }
    }
  });

  it('the model cuts the front half away, every part is finite, labels sit on named groups, and the mic draws no force', () => {
    for (const mode of ['speaker', 'mic'] as const) {
      const d = makeDrive(codes, mode, false), m = speakerModel({ d, t: 5.5 });
      expect(m.cuts!.planes[0].n).toEqual([0, 0, 1]);
      for (const it of m.items) for (const v of it.geo.positions) expect(Number.isFinite(v)).toBe(true);
      const groups = new Set(m.items.map((i) => i.group));
      for (const a of m.anchors!) expect(groups.has(a.on!)).toBe(true);
      expect(m.anchors!.length).toBeGreaterThanOrEqual(6);
      expect(groups.has('force')).toBe(mode === 'speaker');
    }
  });

});
