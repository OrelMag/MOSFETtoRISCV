// The quartz model's numbers: the divider chain from the library's own clockDivider, the fork's frequency from beam theory,
// the datasheets' temperature curve and the Pierce load (Statek TN31's worked example); and the studio drawing following them.
import { describe, expect, it } from 'vitest';
import { clockDivider } from '../src/lib';
import type { Geo } from '../src/gl/kit/geo';
import type { Model3 } from '../src/gl/kit/scene';
import { LID_CUT, QZ_HOME, quartzModel, type QuartzState } from '../src/widgets/quartz3dkit';
import {
  atThicknessMm, beamFreq, realPerScreen, screenSlip, SLIP_S, driftOf, driveCurrent, fmtTime, GROOVE_D, GROOVE_W, inWindow, tipAmplitude, TIP_DRAWN, TOL_PPM, WINDOW_FRAC, chainX, DIVIDE, F_WATCH, fork, freqAt, loadCap, loaded, modeShape,
  PIERCE, ringTau, secPerDay, STAGES, stageBits, stageFreq, TINE_L, TINE_W, tempPpm,
  atPpm, AT_F, AT_LAYERS, AT_N, shearAt,
} from '../src/widgets/quartz3dgeom';

describe('divider chain', () => {
  it('has the library divider\'s stage count and ends at 1 Hz', () => {
    const d = clockDivider(STAGES);
    expect(d.ports.find((p) => p.name === 'q')!.width).toBe(STAGES);
    expect(DIVIDE).toBe(32768);
    expect(stageFreq(STAGES - 1)).toBe(1);
    expect(stageFreq(0)).toBe(16384);
  });
  it('bit i toggles every 2^i input cycles', () => {
    for (let i = 0; i < STAGES; i++) {
      const per = 2 ** (i + 1);
      expect(stageBits(0)[i]).toBe(0);
      expect(stageBits(per / 2)[i]).toBe(1);
      expect(stageBits(per)[i]).toBe(0);
    }
  });
});

describe('the fork', () => {
  it('has a tine length from beam theory that rings at 32 768 Hz and fits the patents\' size', () => {
    expect(beamFreq(TINE_W * 1e-3, TINE_L * 1e-3)).toBeCloseTo(F_WATCH, 3);
    expect(TINE_L).toBeGreaterThan(1.2);
    expect(TINE_L).toBeLessThan(2.2);
    expect(TINE_W).toBeLessThan(0.18);
  });
  it('fits its package and the mode shape runs from 0 at the root to 1 at the tip', () => {
    expect(fork.x0 + fork.L).toBeLessThan(14.5);
    expect(modeShape(0)).toBeCloseTo(0, 9);
    expect(modeShape(1)).toBeCloseTo(1, 9);
    expect(modeShape(0.5)).toBeGreaterThan(0.15);
    expect(modeShape(0.5)).toBeLessThan(0.4);
  });
});

describe('numbers', () => {
  it('temperature: parabola about 25 °C; 45 °C is −13.6 ppm, 1.2 s a day', () => {
    expect(Math.abs(tempPpm(25))).toBe(0);
    expect(tempPpm(45)).toBeCloseTo(-13.6, 6);
    expect(tempPpm(5)).toBeCloseTo(tempPpm(45), 9);
    expect(secPerDay(tempPpm(45))).toBeCloseTo(-1.175, 3);
    expect(freqAt(45)).toBeLessThan(F_WATCH);
  });
  it('Q = 50 000 rings down with τ = 0.49 s', () => {
    expect(ringTau()).toBeCloseTo(0.4857, 3);
  });
  it('Statek TN31: C1 = C2 = 15 pF and 1.5 pF stray make CL = 9.0 pF, which pulls fs to 32 768 Hz', () => {
    const CL = loadCap(PIERCE.c, PIERCE.c, PIERCE.cs);
    expect(CL).toBeCloseTo(9e-12, 15);
    expect(loaded(CL)).toBeCloseTo(F_WATCH, 0);
  });
  it('an AT-cut blank is a different crystal: 16 MHz is 0.104 mm thick', () => {
    expect(atThicknessMm(16e6)).toBeCloseTo(0.1044, 3);
  });
});

describe('two crystals', () => {
  it('a tolerance term shifts the frequency; the FC-135 is ±20 ppm', () => {
    expect(TOL_PPM).toBe(20);
    expect(freqAt(25, F_WATCH, 20)).toBeCloseTo(F_WATCH * (1 + 20e-6), 6);
    expect(secPerDay(20)).toBeCloseTo(1.728, 3);
    expect(freqAt(45, F_WATCH, 0)).toBe(freqAt(45));
  });
  it('the quiz of the step: two 200 MHz clocks at ±20 ppm slip a cycle every 125 µs', () => {
    const d = driftOf(200e6, 20, 25, -20, 25);
    expect(d.dppm).toBeCloseTo(40, 9);
    expect(d.dHz).toBeCloseTo(8000, 3);
    expect(d.slipS).toBeCloseTo(125e-6, 12);
    expect(fmtTime(d.slipS)).toBe('125 µs');
    // 20 ppm apart is twice as slow
    expect(driftOf(200e6, 20, 25, 0, 25).slipS).toBeCloseTo(250e-6, 12);
  });
  it('two watch crystals 40 ppm apart slip a cycle in 0.76 s; equal ones never; temperature counts', () => {
    expect(driftOf(F_WATCH, 20, 25, -20, 25).slipS).toBeCloseTo(0.7629, 3);
    expect(driftOf(F_WATCH, 5, 30, 5, 30).slipS).toBe(Infinity);
    expect(fmtTime(Infinity)).toBe('never');
    // A at 25 C, B at 45 C (−13.6 ppm), same tolerance: the temperature alone makes 13.6 ppm
    expect(driftOf(F_WATCH, 0, 25, 0, 45).dppm).toBeCloseTo(13.6, 6);
  });
  it('time formatting spans µs to days', () => {
    expect(fmtTime(2.5e-3)).toBe('2.50 ms');
    expect(fmtTime(3)).toBe('3.00 s');
    expect(fmtTime(600)).toBe('10.0 min');
    expect(fmtTime(86400 * 3)).toBe('3.00 days');
  });
  it('the setup + hold window is around the edge of the receiver', () => {
    expect(inWindow(0)).toBe(true);
    expect(inWindow(1 - WINDOW_FRAC / 2)).toBe(true);
    expect(inWindow(0.5)).toBe(false);
    expect(inWindow(-0.01)).toBe(true);
  });
});

describe('the grooved tine, Rd and the sealed package', () => {
  it('has grooves inside the patent ranges (width ratio 0.35–1, depth under 0.79)', () => {
    expect(GROOVE_W).toBeGreaterThan(0.35);
    expect(GROOVE_W).toBeLessThan(1);
    expect(GROOVE_D).toBeLessThan(0.79);
    expect(2 * GROOVE_D).toBeLessThan(1); // the floor keeps some quartz between the two grooves
  });
});

describe('the tine amplitude is an estimate from the drive level', () => {
  it('a few micrometres at 0.1 µW, Q = 50 000: not below one', () => {
    const x = tipAmplitude() * 1e6;
    expect(x).toBeGreaterThan(2);
    expect(x).toBeLessThan(20);
  });
  it('scales as √(P·Q) and the motional current is about 1.4 µA at 50 kΩ', () => {
    expect(tipAmplitude(0.4e-6) / tipAmplitude(0.1e-6)).toBeCloseTo(2, 9);
    expect(tipAmplitude(0.1e-6, 100000) / tipAmplitude()).toBeCloseTo(Math.SQRT2, 9);
    expect(driveCurrent() * 1e6).toBeCloseTo(1.414, 3);
  });
});

describe('the ring screen speed', () => {
  const rate = (a: number, b: number, f = 200e6) => screenSlip(f, driftOf(f, a, 25, b, 25).dHz);
  it('is proportional to the frequency difference with one time scale', () => {
    expect(Math.abs(rate(20, -20))).toBeCloseTo(1 / SLIP_S, 9);
    expect(Math.abs(rate(20, 0))).toBeCloseTo(1 / (2 * SLIP_S), 9);
    expect(Math.abs(rate(10, -10)) * 2).toBeCloseTo(Math.abs(rate(20, -20)), 9);
    expect(Math.abs(rate(20, -20, F_WATCH))).toBeCloseTo(1 / SLIP_S, 9);
  });
  it('is zero at equal settings and reverses with the sign', () => {
    expect(Math.abs(rate(5, 5))).toBe(0);
    expect(rate(20, -20)).toBeLessThan(0);
    expect(rate(-20, 20)).toBeGreaterThan(0);
    expect(rate(-20, 20)).toBeCloseTo(-rate(20, -20), 12);
  });
  it('states the scale: at 200 MHz one screen second is 125 µs / 8', () => {
    expect(realPerScreen(200e6)).toBeCloseTo(125e-6 / SLIP_S, 12);
  });
});

describe('the AT-cut view', () => {
  it('f = N / t: a 16 MHz fundamental blank is about 0.104 mm thick, and halving the thickness doubles f', () => {
    expect(AT_N).toBeGreaterThanOrEqual(1.66e6); expect(AT_N).toBeLessThanOrEqual(1.67e6);
    expect(atThicknessMm(AT_F)).toBeCloseTo(0.104, 3);
    expect(atThicknessMm(2 * AT_F)).toBeCloseTo(atThicknessMm(AT_F) / 2, 9);
  });
  it('the temperature curve is a cubic about 25 °C, within ±15 ppm over −40 … 85 °C, flatter near room temperature than the fork', () => {
    expect(atPpm(25)).toBe(0);
    for (let T = -40; T <= 85; T++) expect(Math.abs(atPpm(T))).toBeLessThanOrEqual(15 + 1e-9);
    expect(atPpm(-20)).toBeCloseTo(15, 9); expect(atPpm(70)).toBeCloseTo(-15, 9);
    expect(atPpm(25 + 7) + atPpm(25 - 7)).toBeCloseTo(0, 9); // odd about the inflection
    expect(Math.abs(atPpm(45))).toBeLessThan(Math.abs(-0.034 * 20 * 20) * 2); // both a few ppm at 45 °C; the fork's grows as the square
  });
    expect(shearAt(0.5)).toBeCloseTo(1, 12); expect(shearAt(-0.5)).toBeCloseTo(-1, 12); expect(shearAt(0)).toBe(0);
});

describe('the studio model', () => {
  const st = (o: Partial<QuartzState> = {}): QuartzState => ({ view: 'crystal', disp: 0, dispB: 0, slip: 0.5, bits: stageBits(0), ...o });
  const named = (m: Model3, name: string) => m.items.filter((i) => i.name === name);
  const zOf = (g: Geo, xMin: number) => { const z: number[] = []; for (let k = 0; k < g.positions.length; k += 3) if (g.positions[k] > xMin) z.push(g.positions[k + 2]); return z; };
  it('moves the tines in antiphase, the tips by the drawn swing, the roots not at all', () => {
    const tips = (disp: number) => named(quartzModel(st({ disp })), 'tine').map((t) => { const z = zOf(t.geo, fork.x0 + fork.L * 0.98); return (Math.max(...z) + Math.min(...z)) / 2; });
    const rest = tips(0), bent = tips(1);
    expect(rest).toHaveLength(2);
    expect(bent[0] - rest[0]).toBeCloseTo(TIP_DRAWN, 1);
    expect(bent[1] - rest[1]).toBeCloseTo(-TIP_DRAWN, 1);
    const roots = (disp: number) => named(quartzModel(st({ disp })), 'tine').map((t) => { const z: number[] = []; for (let k = 0; k < t.geo.positions.length; k += 3) if (t.geo.positions[k] < fork.x0 + 0.01) z.push(t.geo.positions[k + 2]); return Math.max(...z); });
    expect(roots(1)[0]).toBeCloseTo(roots(0)[0], 4);
  });
  it('a tine keeps its geometry and bends in place (the renderer re-uploads it)', () => {
    const a = named(quartzModel(st({ disp: 1 })), 'tine')[0].geo, b = named(quartzModel(st({ disp: -1 })), 'tine')[0].geo;
    expect(b).toBe(a);
  });
  it('a grooved tine: two shoulders at full thickness and a floor thinner by both grooves', () => {
    const g = named(quartzModel(st()), 'tine')[0].geo, ys = new Set<string>();
    for (let k = 1; k < g.positions.length; k += 3) ys.add(g.positions[k].toFixed(4));
    const mid = fork.y0 + fork.t / 2, y = [...ys].map(Number).filter((v) => Math.abs(v - mid) > 1e-3).sort((p, q) => p - q); // the caps' centres sit at the middle
    expect(y).toHaveLength(4);
    expect(y[3] - y[0]).toBeCloseTo(fork.t, 4);
    expect(y[2] - y[1]).toBeCloseTo(fork.t * (1 - 2 * GROOVE_D), 4);
  });
  it('the films change polarity with the swing, the groove and the side opposite', () => {
    const emit = (disp: number, name: string) => named(quartzModel(st({ disp })), name).map((i) => i.mat.emit);
    expect(emit(1, 'gold electrode in the groove')).toEqual(['--qz-plus', '--qz-minus']);
    expect(emit(1, 'gold electrode on the side')).toEqual(['--qz-minus', '--qz-plus']);
    expect(emit(-1, 'gold electrode in the groove')).toEqual(['--qz-minus', '--qz-plus']);
  });
  it('the package: 3.2 × 1.5 × 0.8 mm (FC-135), pads below its floor; the cut takes the lid off and leaves the fork whole', () => {
    const m = quartzModel(st()), pkg = named(m, 'ceramic package').map((i) => i.geo);
    const lo = Math.min(...pkg.map((g) => g.min[0])), hi = Math.max(...pkg.map((g) => g.max[0]));
    expect(hi - lo).toBeCloseTo(32, 6);
    expect(Math.max(...pkg.map((g) => g.max[2])) - Math.min(...pkg.map((g) => g.min[2]))).toBeCloseTo(15, 6);
    const lid = named(m, 'lid')[0].geo;
    expect(lid.max[1]).toBeLessThanOrEqual(8.6 + 1e-6);
    expect(named(m, 'underside pads')[0].geo.max[1]).toBeLessThanOrEqual(0);
    expect(lid.min[1]).toBeGreaterThan(LID_CUT);
    for (const t of named(quartzModel(st({ disp: 1 })), 'tine')) expect(t.geo.max[1]).toBeLessThan(LID_CUT);
    expect(m.cuts!.planes[0].d).toBe(LID_CUT);
    expect(fork.x0 + fork.L).toBeLessThan(14.5);
  });
  it('the board lights stage 15 only when its bit is 1, has Rd on the inverter output and larger LEDs on a phone', () => {
    const lit = (bits: number[]) => quartzModel(st({ view: 'loop', bits })).items.filter((i) => i.name === `÷2 stage ${STAGES}` && i.mat.emit).length;
    expect(lit(stageBits(DIVIDE / 2))).toBe(1);
    expect(lit(stageBits(0))).toBe(0);
    const m = quartzModel(st({ view: 'loop', bits: stageBits(12345) }));
    expect(named(m, 'Rd').length).toBe(3);
    expect((m.anchors ?? []).some((a) => /^Rd/.test(a.text))).toBe(true);
    const led = (big: boolean) => quartzModel(st({ view: 'loop', bits: stageBits(1), big })).items.filter((i) => i.name === 'Rf 10 MΩ' || i.name === '÷2 stage 4').map((i) => i.geo.max[0] - i.geo.min[0]);
    expect(Math.min(...led(true))).toBeLessThanOrEqual(Math.min(...led(false)));
    expect(chainX(STAGES - 1)).toBeGreaterThan(-24);
  });
  it('two crystals and the ring: B\'s edge glows only inside A\'s window and the hand points at it', () => {
    const glow = (slip: number) => named(quartzModel(st({ view: 'drift', slip })), "B's edge")[0].mat.glow!;
    expect(glow(0.01)).toBeGreaterThan(glow(0.5));
    const m = quartzModel(st({ view: 'drift', slip: 0.25 })), b = named(m, "B's edge")[0];
    expect(b.at![0]).toBeGreaterThan(0); // a quarter turn clockwise seen from above: to the right of the centre
    expect(named(m, 'tine')).toHaveLength(4);
  });
  it('thickness shear: the faces move opposite ways, the middle plane stays, the electrodes ride on their faces', () => {
    const layers = (disp: number) => named(quartzModel(st({ view: 'at', disp })), 'quartz blank, AT-cut').map((i) => i.at![0]);
    const L1 = layers(1);
    expect(L1).toHaveLength(AT_LAYERS);
    for (let i = 0; i < AT_LAYERS; i++) expect(L1[i]).toBeCloseTo(-L1[AT_LAYERS - 1 - i], 9);
    expect(L1[AT_LAYERS - 1]).toBeGreaterThan(0);
    for (const x of layers(0)) expect(x).toBeCloseTo(0, 12);
    const e = named(quartzModel(st({ view: 'at', disp: 1 })), 'gold electrode').map((i) => i.at![0]);
    expect(e[0]).toBeCloseTo(-e[1], 9);
    expect(e[0]).toBeGreaterThan(L1[AT_LAYERS - 1]);
  });
  it('every view has a home, names and a tour', () => {
    for (const view of ['crystal', 'loop', 'drift', 'at'] as const) {
      const m = quartzModel(st({ view }));
      expect(QZ_HOME[view]).toBeDefined();
      expect((m.anchors ?? []).length).toBeGreaterThanOrEqual(4);
      expect((m.beats ?? []).length).toBeGreaterThanOrEqual(2);
      expect(quartzModel(st({ view }), 'flat').items.length).toBe(m.items.length);
    }
  });
});
