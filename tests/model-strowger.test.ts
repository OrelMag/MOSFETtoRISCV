// The Strowger selector: the state machine held to chapter 40's gate-level DIAL_SELECTOR, and the drawing held to the machine.
import { describe, expect, it } from 'vitest';
import { DIAL_SELECTOR } from '../src/lib/telegraph';
import { BREAK_MS, call, DROP_MS, hunt, HOME, LEVELS, LINES, OVERFLOW, PULSE_MS, pulsesOf, release, stateAt, TURN_HOME_MS, vertical, verticalPulling } from '../src/phys/strowger';
import { flatFaces, flatView } from '../src/gl/parts';
import { flatten } from '../src/sim/flatten';
import { SwitchSim } from '../src/sim/switchsim';
import { B1 } from '../src/sim/types';
import { contactAt, lineAngle, levelY, swParts, wiperTip, type SwPalette } from '../src/widgets/strowger3dparts';

const none = (): boolean[][] => Array.from({ length: LEVELS }, () => Array<boolean>(LINES).fill(false));
const yOf = (sim: SwitchSim) => sim.getBits(sim.design.root.ports.y).reduce<number>((v, x, i) => v | ((x === B1 ? 1 : 0) << i), 0);
const relay = () => { const sim = new SwitchSim(flatten(DIAL_SELECTOR, { mode: 'switch' })); sim.setInput('line', 1); sim.settle(); return sim; };
const pulse = (sim: SwitchSim) => { sim.setInput('pulse', 1); sim.settle(); sim.setInput('pulse', 0); sim.settle(); };
const climbed = (n: number, busy = none()) => stateAt(call(n, busy), pulsesOf(n) * PULSE_MS);

describe('the Strowger machine against the relay selector', () => {
  it('the same n pulses reach the same level: the relay selector is on output n', () => {
    const sim = relay();
    expect(yOf(sim)).toBe(1 << HOME.level);
    for (let n = 1; n <= 7; n++) {
      pulse(sim);
      const m = climbed(n);
      expect(m.level).toBe(n);
      expect(yOf(sim), `after ${n} pulses`).toBe(1 << m.level);
    }
  });

  it('hanging up returns both to rest', () => {
    const sim = relay();
    for (let i = 0; i < 5; i++) pulse(sim);
    sim.setInput('hangup', 1); sim.settle();
    expect(yOf(sim)).toBe(1);
    expect(stateAt([{ t: 0, s: HOME }], 0)).toEqual(HOME);
  });

  it('what only the machine has: ten levels where the relay tree wraps at 8, and a hunt', () => {
    const sim = relay();
    for (let i = 0; i < 9; i++) pulse(sim);
    expect(yOf(sim)).toBe(1 << 1);
    expect(climbed(9).level).toBe(9);
    expect(pulsesOf(0)).toBe(10);
    expect(climbed(0).level).toBe(10);
    expect(vertical({ ...HOME, level: LEVELS }).level).toBe(LEVELS);
  });
});

describe('the hunt', () => {
  it('skips busy lines and takes the first free one', () => {
    const b = none();
    for (const j of [0, 1, 2, 4]) b[3][j] = true;
    const end = call(4, b).at(-1)!.s;
    expect(end).toEqual({ level: 4, line: 4, mode: 'connected' });
  });
  it('a level busy to the end steps on to the 11th (overflow) step, past the last contact, and gives the busy tone', () => {
    const b = none();
    b[6].fill(true);
    const f = call(7, b), end = f.at(-1)!.s;
    expect(OVERFLOW).toBe(LINES + 1);
    expect(end).toEqual({ level: 7, line: OVERFLOW, mode: 'busy' });
    expect(f.filter((x) => x.s.mode === 'hunt')).toHaveLength(LINES);
    // The last contact is free: it is taken, not passed.
    b[6][LINES - 1] = false;
    expect(call(7, b).at(-1)!.s).toEqual({ level: 7, line: LINES, mode: 'connected' });
  });
  it('one step at a time: free is taken, busy moves on', () => {
    expect(hunt({ level: 2, line: 0, mode: 'hunt' }, [false]).mode).toBe('connected');
    expect(hunt({ level: 2, line: 0, mode: 'hunt' }, [true, false])).toEqual({ level: 2, line: 1, mode: 'hunt' });
  });
  it('the pulses come 100 ms apart, the vertical magnet pulling for the GPO’s 66 % break of each', () => {
    const f = call(3, none());
    expect(f.slice(0, 4).map((x) => x.t)).toEqual([0, 100, 200, 300]);
    expect(BREAK_MS / PULSE_MS).toBeGreaterThanOrEqual(0.63);
    expect(BREAK_MS / PULSE_MS).toBeLessThanOrEqual(0.72);
    let on = 0;
    for (let t = 0; t < 300; t++) if (verticalPulling(f, t)) on++;
    expect(on).toBe(3 * BREAK_MS);
    expect(verticalPulling(f, 350)).toBe(false);
  });
});

describe('the release', () => {
  it('turns the shaft home before it drops: the level never falls while the wipers are off the home angle', () => {
    const from = { level: 7, line: 6, mode: 'connected' as const }, f = release(from);
    expect(f.at(-1)!.s).toEqual(HOME);
    expect(f.at(-1)!.t).toBe(TURN_HOME_MS + DROP_MS);
    for (let i = 1; i < f.length; i++) {
      const a = f[i - 1].s, b = f[i].s;
      expect(a.level !== b.level && a.line !== b.line, `frame ${i}`).toBe(false);
      if (b.level < a.level) expect(a.line).toBe(0);
    }
    expect(release(HOME)).toEqual([{ t: 0, s: HOME }]);
  });
  it('dialled again off normal, the selector releases first, then climbs from rest', () => {
    const b = none(), f = call(2, b, { level: 5, line: 3, mode: 'connected' });
    expect(f[0].s).toEqual({ level: 5, line: 3, mode: 'release' });
    const i = f.findIndex((x) => x.s.mode === 'home');
    expect(f[i].t).toBe(TURN_HOME_MS + DROP_MS);
    expect(f[i + 1].s).toEqual({ level: 1, line: 0, mode: 'climb' });
    expect(f.at(-1)!.s).toEqual({ level: 2, line: 1, mode: 'connected' });
  });
});

describe('the drawing', () => {
  const c = (n: number): [number, number, number] => [n, n, n];
  const P: SwPalette = { frame: c(0.1), shaft: c(0.2), brass: c(0.3), free: c(0.4), busy: c(0.5), live: c(0.6), coil: c(0.7), lit: c(0.8), probe: c(0.9) };
  it('at rest on a line the wiper tip is on that contact, at that level', () => {
    for (const [l, j] of [[1, 1], [4, 5], [10, 10]]) {
      const tip = wiperTip({ level: l, line: j }), k = contactAt(l, j);
      for (let i = 0; i < 3; i++) expect(tip[i]).toBeCloseTo(k[i], 0);
      expect(tip[1]).toBeCloseTo(levelY(l), 6);
    }
  });
  it('the 11th step lies past the last contact, on the same arc', () => {
    expect(lineAngle(OVERFLOW) - lineAngle(LINES)).toBeCloseTo(lineAngle(LINES) - lineAngle(LINES - 1), 6);
    const tip = wiperTip({ level: 3, line: OVERFLOW });
    expect(tip[1]).toBeCloseTo(levelY(3), 6);
  });
  it('a contact for every line of every level, busy ones coloured as busy', () => {
    const b = none();
    b[2][4] = true;
    const parts = swParts({ level: 3, line: 5, vmag: false, rmag: false }, { level: 3, line: 5, mode: 'hunt' }, b, P);
    expect(parts.filter((p) => p.color === P.free)).toHaveLength(LEVELS * LINES - 1);
    expect(parts.filter((p) => p.color === P.busy)).toHaveLength(1);
  });
  it('the shaft rises with the level, and the connected contact is marked live', () => {
    const shaft = (level: number) => swParts({ level, line: 0, vmag: false, rmag: false }, HOME, none(), P).find((p) => p.color === P.shaft && p.scale![1] === 28)!;
    // Level 4 up: below that the shaft is cut off at the base.
    expect(shaft(9).pos[1] - shaft(4).pos[1]).toBeCloseTo(5 * 5, 6);
    const live = swParts({ level: 4, line: 4, vmag: false, rmag: false }, { level: 4, line: 4, mode: 'connected' }, none(), P).filter((p) => p.color === P.live);
    expect(live.map((p) => p.pos)).toContainEqual(contactAt(4, 4));
  });
  it('a magnet glows only while it pulls, and the flat view draws it', () => {
    const glow = (v: boolean, rel = false) => swParts({ level: 1, line: 0, vmag: v, rmag: false, rel }, HOME, none(), P).filter((p) => p.color === P.lit).length;
    expect(glow(true)).toBe(1);
    expect(glow(false)).toBe(0);
    expect(glow(false, true)).toBe(1);
    expect(flatFaces(swParts({ level: 1, line: 0, vmag: false, rmag: false }, HOME, none(), P), 0.5, 0.3).length).toBeGreaterThan(100);
    expect(flatView(0, 0)([1, 2, 3])).toHaveLength(3);
  });
});
