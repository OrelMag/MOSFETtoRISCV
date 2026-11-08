// The loudspeaker model against the chapter's voice: with no smoothing the cone sits exactly on the held (ZOH) sample at
// every instant, the drawing's dust cap is where the model says, the stroke stays within Xmax, and the microphone's EMF is
// Bl times the cone's velocity.
import { describe, expect, it } from 'vitest';
import { quatRotate } from '../src/gl/math';
import { wavSamples } from './dsp/wav';
import {
  BL, DRAW_K, DUST_Y, GEOM, I_FULL, VOICE_RATE, WINDOW, XMAX_MM, coneMm, dustY, emfVolts, heldCode, loudestWindow, makeDrive, poseAt, slab,
  speakerAnchors, speakerParts, staircase, type SpeakerPalette,
} from '../src/widgets/speaker3dparts';

const w = wavSamples('public/dsp/voice-8k.wav');
const codes = w.x.slice(loudestWindow(w.x), loudestWindow(w.x) + WINDOW);
const col = (i: number): [number, number, number] => [i / 20, 0.5, 0.5];
const P: SpeakerPalette = {
  steel: col(1), magnet: col(2), basket: col(3), cone: [0.3, 0.3, 0.3, 0.8], dust: col(5), former: col(6), wire: col(7), rubber: col(8), spider: col(9),
  stair: col(10), stairDim: [0.1, 0.1, 0.9, 0.3], trace: col(12), cursor: col(13), live: col(14), zero: col(15),
};
const same = (a: readonly number[], b: readonly number[]) => a.every((v, i) => Math.abs(v - b[i]) < 1e-6);
const dustPart = (d: ReturnType<typeof makeDrive>, t: number) => speakerParts(d, t, P).find((p) => same(p.color as number[], P.dust))!;

describe('the speaker model against the chapter', () => {
  it('uses the chapter\'s recording: 8 kHz, a full window of its samples', () => {
    expect(w.rate).toBe(VOICE_RATE);
    expect(codes).toHaveLength(WINDOW);
    expect(Math.max(...codes.map(Math.abs))).toBeGreaterThan(1000);
  });

  it('ZOH: with no smoothing the cone at any t is the held sample, scaled to Xmax', () => {
    const d = makeDrive(codes, 'speaker', false);
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

  it('the drawn dust cap sits at the cone position (rest height plus the stroke as drawn)', () => {
    const d = makeDrive(codes, 'speaker', false);
    for (const n of [0, 7, 20, 41, 63]) {
      const p = dustPart(d, n + 0.5), c = codes[n] / d.peak;
      expect(p.pos[1] - 0.6).toBeCloseTo(DUST_Y + c * XMAX_MM * DRAW_K, 9);
      expect(p.pos[1] - 0.6).toBeCloseTo(dustY(c), 9);
    }
  });

  it('stays within Xmax, with or without smoothing, and the coil stays in its gap', () => {
    for (const smooth of [false, true]) {
      const d = makeDrive(codes, 'speaker', smooth);
      for (let t = 0; t < WINDOW; t += 0.1) {
        const p = poseAt(d, t);
        expect(Math.abs(coneMm(p.cone))).toBeLessThanOrEqual(XMAX_MM + 1e-9);
        // The winding (height 18) overlaps the gap (6) over the whole stroke only if |x| <= (18 - 6) / 2.
        const dy = p.cone * XMAX_MM, wl = GEOM.windLow + dy, wh = GEOM.windHigh + dy;
        expect(wl).toBeLessThanOrEqual(GEOM.magnetTop + 1e-9);
        expect(wh).toBeGreaterThanOrEqual(GEOM.plateTop - 1e-9);
      }
    }
    expect((GEOM.windHigh - GEOM.windLow - (GEOM.plateTop - GEOM.magnetTop)) / 2).toBe(XMAX_MM);
  });

  it('smoothing is a lag, not a different signal: it matches the hold at the start of a long constant run', () => {
    const flat = Array.from({ length: 16 }, (_, i) => (i < 8 ? 1000 : 0));
    const d = makeDrive(flat, 'speaker', true);
    expect(poseAt(d, 7.999).cone).toBeGreaterThan(0.95);
    expect(poseAt(d, 8.0).cone).toBeLessThan(1);
    expect(poseAt(d, 8.5).cone).toBeGreaterThan(0);
  });

  it('the microphone: EMF is Bl times the cone velocity, and the ADC holds one value a period', () => {
    const d = makeDrive(codes, 'mic', false);
    const top = Math.max(...codes.map((c, i) => Math.abs(codes[(i + 1) % WINDOW] - c)));
    for (const n of [3, 30, 62]) {
      const v = ((poseAt(d, n + 1 - 1e-9).cone - poseAt(d, n).cone) * XMAX_MM / 1000) * VOICE_RATE;
      expect(emfVolts(d, n)).toBeCloseTo(BL * v, 6);
      expect(poseAt(d, n + 0.2).code).toBe(poseAt(d, n + 0.8).code);
      expect(d.adc[n]).toBeCloseTo((codes[(n + 1) % WINDOW] - codes[n]) / top, 9);
    }
    // The cone itself is continuous: the samples joined.
    expect(poseAt(d, 10).cone).toBeCloseTo(codes[10] / d.peak, 12);
    expect(poseAt(d, 10.5).cone).toBeCloseTo((codes[10] + codes[11]) / 2 / d.peak, 12);
  });

  it('the datasheet figures', () => {
    expect(XMAX_MM).toBe(6);
    expect(BL).toBe(7.82);
    expect(I_FULL).toBeCloseTo(0.685, 3);
    expect(2 * GEOM.formerOut).toBeCloseTo(39, 0); // the 38 mm coil's former plus its winding
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
      for (const p of speakerParts(d, 5.5, P)) if (p.pos[0] < 130) expect(p.pos[2]).toBeLessThanOrEqual(1e-6);
      expect(speakerAnchors(d, 5.5).length).toBeGreaterThan(8);
    }
  });
});
