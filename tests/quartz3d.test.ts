// The quartz model's numbers: the divider chain from the library's own clockDivider, the fork's frequency from beam theory,
// the datasheets' temperature curve and the Pierce load (Statek TN31's worked example).
import { describe, expect, it } from 'vitest';
import { clockDivider } from '../src/lib';
import { flatFaces } from '../src/gl/parts';
import {
  atThicknessMm, beamFreq, boardAnchors, driftAnchors, realPerScreen, screenSlip, SLIP_S, driftOf, driftParts, driveCurrent, fmtTime, GROOVE_D, GROOVE_W, inWindow, tipAmplitude, TOL_PPM, WINDOW_FRAC, boardParts, chainX, crystalAnchors, crystalParts, DIVIDE, F_WATCH, fork, freqAt, loadCap, loaded, modeShape,
  PIERCE, ringTau, secPerDay, STAGES, stageBits, stageFreq, TINE_L, TINE_W, tempPpm, type QuartzPalette,
} from '../src/widgets/quartz3dparts';

const c = (v: number): [number, number, number] => [v, v, v];
const P: QuartzPalette = {
  quartz: [0.8, 0.9, 1, 0.4], gold: c(0.8), ceramic: c(0.9), pad: c(0.8), glue: c(0.5), lid: [0.5, 0.5, 0.5, 0.3], plus: [0, 1, 0], minus: [1, 0, 0],
  pcb: c(0.2), copper: c(0.7), body: c(0.6), chip: c(0.1), led: [0, 1, 0], ledOff: c(0.2), metal: c(0.7),
};

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
  it('moves the tines in antiphase', () => {
    const a = crystalParts({ disp: 1, lid: false }, P), z = (parts: typeof a) => parts.filter((p) => p.pos[0] > fork.x0 + fork.L * 0.9 && p.pos[1] < 3.2 && p.pos[1] > 2.4);
    const tips = z(a).map((p) => p.pos[2]);
    expect(Math.max(...tips)).toBeGreaterThan(0);
    expect(Math.min(...tips)).toBeLessThan(0);
    const tine1 = Math.max(...tips), rest = crystalParts({ disp: 0, lid: false }, P), r1 = Math.max(...z(rest).map((p) => p.pos[2]));
    const tine2 = Math.min(...tips), r2 = Math.min(...z(rest).map((p) => p.pos[2]));
    expect(tine1 - r1).toBeCloseTo(-(tine2 - r2), 6);
    expect(tine1 - r1).toBeGreaterThan(0.5);
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

describe('drawing', () => {
  it('builds both views with labels and flat faces', () => {
    const cp = crystalParts({ disp: 0.5, lid: true }, P), bp = boardParts({ bits: stageBits(12345), vib: 1 }, P);
    expect(cp.length).toBeGreaterThan(100);
    expect(flatFaces([...cp, ...bp], 0.5, 0.3).length).toBeGreaterThan(0);
    expect(crystalAnchors({ disp: 0, lid: false }).length).toBeGreaterThan(3);
    expect(boardAnchors().length).toBeGreaterThan(5);
    expect(chainX(STAGES - 1)).toBeGreaterThan(-24);
  });
  it('lights stage 15 only when its bit is 1', () => {
    const on = (bits: number[]) => boardParts({ bits, vib: 0 }, P).filter((p) => p.emissive && p.pos[0] === chainX(STAGES - 1)).length;
    expect(on(stageBits(DIVIDE / 2))).toBe(1);
    expect(on(stageBits(0))).toBe(0);
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
  it('draws both forks, the ring and its dots, with modest counts', () => {
    const parts = driftParts({ disp: 1, dispB: -1, slip: 0.5 }, P);
    expect(parts.length).toBeLessThan(260);
    expect(driftAnchors(0.5).length).toBeGreaterThan(3);
    const hit = (slip: number) => driftParts({ disp: 0, dispB: 0, slip }, P).filter((p) => p.emissive && p.emissive[0] === 1).length;
    expect(hit(0.5)).toBe(0); // B's dot dim away from the window
    expect(driftParts({ disp: 0, dispB: 0, slip: 0.01 }, P).length).toBe(driftParts({ disp: 0, dispB: 0, slip: 0.5 }, P).length);
  });
});

describe('the grooved tine, Rd and the sealed package', () => {
  it('has grooves inside the patent ranges (width ratio 0.35–1, depth under 0.79)', () => {
    expect(GROOVE_W).toBeGreaterThan(0.35);
    expect(GROOVE_W).toBeLessThan(1);
    expect(GROOVE_D).toBeLessThan(0.79);
    expect(2 * GROOVE_D).toBeLessThan(1); // the floor keeps some quartz between the two grooves
  });
  it('builds a tine segment from two shoulders and a floor, thinner than the shoulders', () => {
    const a = crystalParts({ disp: 0, lid: false, seg: 14 }, P);
    const tineY = a.filter((p) => p.pos[0] > fork.x0 && p.pos[0] < fork.x0 + fork.L + 0.1 && p.scale![1] > 0.1 && p.scale![1] < fork.t * 0.9 && p.scale![1] > fork.t * (1 - 2 * GROOVE_D) - 1e-9);
    expect(tineY.length).toBe(2 * 14);
    expect(tineY[0]!.scale![1]).toBeCloseTo(fork.t * (1 - 2 * GROOVE_D), 9);
  });
  it('has underside pads below the package floor', () => {
    expect(crystalParts({ disp: 0, lid: false }, P).filter((p) => p.pos[1] < 0).length).toBe(2);
  });
  it('has a drive resistor Rd on the inverter output and a larger LED on a phone', () => {
    expect(boardAnchors().some((a) => /^Rd/.test(a.text))).toBe(true);
    const r = (big: boolean) => boardParts({ bits: stageBits(1), vib: 0, big }, P).filter((p) => p.kind === 'cyl' && Math.abs(p.pos[0] - chainX(3)) < 1e-9);
    expect(r(true)[0]!.scale![0]).toBeGreaterThan(r(false)[0]!.scale![0] - 0);
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
