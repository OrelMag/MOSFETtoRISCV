// The quartz model's numbers: the divider chain from the library's own clockDivider, the fork's frequency from beam theory,
// the datasheets' temperature curve and the Pierce load (Statek TN31's worked example).
import { describe, expect, it } from 'vitest';
import { clockDivider } from '../src/lib';
import { flatFaces } from '../src/gl/parts';
import {
  atThicknessMm, beamFreq, boardAnchors, boardParts, chainX, crystalAnchors, crystalParts, DIVIDE, F_WATCH, fork, freqAt, loadCap, loaded, modeShape,
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
