// The relay close-up's drawing held to phys/relay.ts: pole area, residual stud, twin contacts, the hysteresis sweep.
import { describe, expect, it } from 'vitest';
import type { RGB } from '../src/gl/instances';
import { RELAY, RELAY_SUPPLY, relaySim, relayStatic } from '../src/phys/relay';
import { EXAG, POLE_R, SWEEP_MARKS, relayParts, type Palette } from '../src/widgets/relay3dview';

const G: RGB = [0.5, 0.5, 0.5];
const P: Palette = { bakelite: G, steel: G, steel2: G, steel3: G, copper: [0.7, 0.4, 0.2], glow: G, spring: G, blade: G, stud: G, silver: G, good: [0, 1, 0] };
const run = relaySim(RELAY_SUPPLY);
const open = run.s[0], closed = run.s[100];

describe('the relay drawing against the model', () => {
  it('draws the pole face at the model\'s area (100 mm2)', () => {
    expect(Math.PI * POLE_R * POLE_R).toBeCloseTo(RELAY.A * 1e6, -1);
    const faces = relayParts(closed, P).filter((p) => p.kind === 'cyl' && Math.abs((p.scale?.[0] ?? 0) - 2 * POLE_R) < 1e-9);
    expect(faces).toHaveLength(1);
  });

  it('puts a residual stud under the armature whose height is the residual gap times the exaggeration', () => {
    const stud = relayParts(closed, P).find((p) => p.id === 'residual')!;
    expect(stud.scale![1]).toBeCloseTo(RELAY.gRes * 1e3 * EXAG + 0.05, 6);
    // closed: its foot rests on the pole face (y = 25 mm); open it is lifted by the gap
    const foot = (q: typeof closed) => { const p = relayParts(q, P).find((x) => x.id === 'residual')!; return p.pos[1] - (p.scale![1] / 2) * Math.cos(Math.atan2(2 * p.rot![2] * p.rot![3], 1 - 2 * p.rot![2] ** 2)); };
    expect(foot(closed)).toBeLessThan(foot(open) - 3);
  });

  it('carries twin dome contacts on every spring: four buttons on each side of the blade', () => {
    const buttons = (q: typeof closed) => relayParts(q, P).filter((p) => p.kind === 'cyl' && Math.abs((p.scale?.[0] ?? 0) - 2.3) < 1e-9);
    const b = buttons(closed);
    expect(b).toHaveLength(8); // fixed NC + NO + blade's two faces, two domes each
    expect(new Set(b.map((p) => Math.abs(p.pos[2])))).toEqual(new Set([1.7]));
  });
});

describe('the hysteresis sweep follows relayStatic', () => {
  it('changes state at the drop-out voltage going down and the pull-in voltage coming back', () => {
    const { pull, drop } = relayStatic();
    expect(SWEEP_MARKS).toHaveLength(4);
    const v = (k: number) => RELAY_SUPPLY * Math.abs(1 - (2 * k) / 1000);
    expect(v(SWEEP_MARKS[1])).toBeLessThan(drop!);
    expect(v(SWEEP_MARKS[1])).toBeGreaterThan(drop! - 0.1);
    expect(v(SWEEP_MARKS[2])).toBeGreaterThanOrEqual(pull!);
    expect(v(SWEEP_MARKS[2])).toBeLessThan(pull! + 0.1);
  });
});
