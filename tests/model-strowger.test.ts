// The Strowger selector: the state machine held to chapter 40's gate-level DIAL_SELECTOR, and the drawing held to the machine.
import { describe, expect, it } from 'vitest';
import { DIAL_SELECTOR } from '../src/lib/telegraph';
import { BREAK_MS, call, DROP_MS, HUNT_MS, hunt, HOME, LEVELS, LINES, motionAt, OVERFLOW, PULSE_MS, pulsesOf, release, stateAt, TURN_HOME_MS, vertical, verticalPulling, type Frame } from '../src/phys/strowger';
import { flatten } from '../src/sim/flatten';
import { SwitchSim } from '../src/sim/switchsim';
import { B1 } from '../src/sim/types';
import {
  BANK_ARC, contactAt, contactInstances, ENVELOPE, LEVEL_PITCH, lineAngle, levelY, PAWL_Y, R_BETA, R_PAWL_TIP, R_PIVOT, R_TIP, ROT_HOLD_Y, ROT_PAWL_Y, ROT_R, ROT_Y, SHAFT_Y,
  swModel, toothFace, V_ALPHA, V_PAWL_TIP_Z, V_PIVOT, wiperTip, type SwPalette,
} from '../src/widgets/strowger3dkit';
import { itemMatrix } from '../src/gl/kit/scene';
import { quatAxisAngle, quatRotate } from '../src/gl/math';

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

describe('the mechanism between frames (motionAt)', () => {
  const b = none();
  for (const j of [0, 1, 2]) b[3][j] = true;
  const full = none();
  full[6].fill(true);
  const calls: Frame[][] = [call(4, b), call(7, full), call(2, b, { level: 5, line: 3, mode: 'connected' }), release({ level: 6, line: 8, mode: 'connected' })];
  it('lands exactly on every frame: the drawing never disagrees with the state', () => {
    for (const f of calls) for (const x of f) {
      const m = motionAt(f, x.t);
      expect(m.level, `t ${x.t}`).toBe(x.s.level);
      expect(m.line, `t ${x.t}`).toBe(x.s.line);
    }
  });
  it('a pulse: the vertical coil is on exactly while verticalPulling says so, and the tooth completes as the level steps', () => {
    const f = calls[0];
    for (let t = 0; t <= f.at(-1)!.t; t += 1) {
      const m = motionAt(f, t), s = stateAt(f, t);
      expect(m.vOn, `t ${t}`).toBe(verticalPulling(f, t));
      expect(m.level).toBeGreaterThanOrEqual(s.level);
      expect(m.level).toBeLessThanOrEqual(s.level + 1);
    }
    // half-way through the second pulse's break the shaft is half-way up its tooth
    expect(motionAt(f, 2 * PULSE_MS - BREAK_MS / 2).level).toBeCloseTo(1.5, 6);
  });
  it('a hunt step falls inside the HUNT_MS before its frame, the rotary coil on for the pull only', () => {
    const f = calls[0], steps = f.filter((x, k) => k > 0 && x.s.line === f[k - 1].s.line + 1);
    expect(steps.length).toBe(4);
    for (const x of steps) {
      expect(motionAt(f, x.t - HUNT_MS).line).toBe(x.s.line - 1);
      const mid = motionAt(f, x.t - HUNT_MS / 2);
      expect(mid.line).toBeGreaterThan(x.s.line - 1);
      expect(mid.line).toBeLessThanOrEqual(x.s.line);
      expect(motionAt(f, x.t - HUNT_MS + 1).rOn).toBe(true);
      expect(motionAt(f, x.t - 1).rOn).toBe(false);
    }
  });
  it('release: the pawls lifted throughout, the line home before the level falls, never a drop while turned', () => {
    for (const f of [calls[2], calls[3]]) for (let t = 0; t <= f.at(-1)!.t; t += 1) {
      const m = motionAt(f, t), s = stateAt(f, t);
      if (s.mode !== 'release') continue;
      expect(m.relOn).toBe(true);
      expect(m.held).toBe(false);
      if (m.line > 1e-9) expect(m.level).toBe(s.level);
    }
    const r = calls[3];
    expect(motionAt(r, TURN_HOME_MS / 2).line).toBeCloseTo(4, 6);
    expect(motionAt(r, TURN_HOME_MS + DROP_MS / 2).level).toBeCloseTo(6 * 0.75, 6);
  });
});

describe('the selector in true geometry', () => {
  const c = (n: number): [number, number, number] => [n, n, n];
  const P: SwPalette = { busy: c(0.5), live: c(0.6) };
  const still = (level: number, line: number) => ({ level, line, vArm: 0, rArm: 0, relArm: 0, vOn: false, rOn: false, relOn: false, held: level > 0 });
  const xf = (m: Float32Array, p: ArrayLike<number>, k: number): [number, number, number] => [0, 1, 2].map((a) => m[a] * p[k] + m[4 + a] * p[k + 1] + m[8 + a] * p[k + 2] + m[12 + a]) as [number, number, number];
  it('fits the Science Museum’s selector: 422 mm tall, 170 wide, 200 deep', () => {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const it of swModel(still(0, 0)).items) {
      const m = itemMatrix(it, 0), g = it.geo.positions;
      for (let k = 0; k < g.length; k += 3) { const v = xf(m, g, k); for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], v[a]); hi[a] = Math.max(hi[a], v[a]); } }
    }
    expect(hi[1] - lo[1]).toBeLessThanOrEqual(ENVELOPE.h + 1);
    expect(hi[1] - lo[1]).toBeGreaterThan(ENVELOPE.h - 2);
    expect(hi[0] - lo[0]).toBeLessThanOrEqual(ENVELOPE.w + 1);
    expect(hi[2] - lo[2]).toBeLessThanOrEqual(ENVELOPE.d + 1);
  });
  it('at rest on a line each wiper reaches its own contact of that level (the carrier turned and lifted by the shaft)', () => {
    for (const [l, j] of [[1, 1], [4, 5], [10, 10]] as const) for (let k = 0; k < 3; k++) {
      const tip = wiperTip(l, j, k), con = contactAt(l, j, k);
      expect(Math.abs(tip[1] - con[1])).toBeLessThan(1e-9);
      expect(Math.hypot(tip[0], tip[2])).toBeCloseTo(R_TIP, 9);
      const blade = swModel(still(l, j)).items.find((x) => x.name === ['tip', 'ring', 'sleeve'][k] + ' wiper')!, m = itemMatrix(blade, 0), g = blade.geo.positions;
      let far = 0, farP: [number, number, number] = [0, 0, 0];
      for (let q = 0; q < g.length; q += 3) { const v = xf(m, g, q), r = Math.hypot(v[0], v[2]); if (r > far) { far = r; farP = v; } }
      expect(far).toBeGreaterThan(R_TIP);
      expect(far).toBeLessThan(R_TIP + 2);
      // the blade's end is at the contact's angle and within the wiper's leaves of its height
      expect(Math.abs(Math.atan2(farP[0], -farP[2]) - Math.atan2(con[0], -con[2]))).toBeLessThan(0.05);
      expect(Math.abs(farP[1] - con[1])).toBeLessThan(1);
    }
  });
  it('the rest angle lies off the bank, so the wipers climb clear; the 11th step one step past line 10', () => {
    expect(lineAngle(0)).toBeLessThan(BANK_ARC[0]);
    expect(lineAngle(LINES)).toBeLessThan(BANK_ARC[1]);
    expect(lineAngle(OVERFLOW) - lineAngle(LINES)).toBeCloseTo(lineAngle(LINES) - lineAngle(LINES - 1), 9);
    expect(levelY(1) - levelY(0)).toBe(LEVEL_PITCH);
  });
  it('the vertical pawl: a full pull lifts its tip one level, and at every level a tooth’s face waits at it', () => {
    const tip0: [number, number, number] = [0, PAWL_Y - V_PIVOT[1], V_PAWL_TIP_Z - V_PIVOT[2]];
    const pulled = quatRotate(quatAxisAngle([1, 0, 0], V_ALPHA), tip0);
    expect(pulled[1] - tip0[1]).toBeCloseTo(LEVEL_PITCH, 0);
    for (let l = 0; l < LEVELS; l++) expect(toothFace(LEVELS - 1 - l, l)).toBe(PAWL_Y);
  });
  it('the rotary pawl moves one tooth a stroke, and both rotary pawls meet the ratchet at every level', () => {
    const arm = Math.hypot(R_PIVOT[0] - R_PAWL_TIP[0], R_PIVOT[2] - R_PAWL_TIP[2]);
    expect(arm * R_BETA).toBeCloseTo(ROT_R[1] * (Math.PI / 12), 6);
    for (let l = 0; l <= LEVELS; l++) for (const y of [ROT_PAWL_Y, ROT_HOLD_Y]) {
      expect(y).toBeGreaterThan(ROT_Y[0] + LEVEL_PITCH * l);
      expect(y).toBeLessThan(ROT_Y[1] + LEVEL_PITCH * l);
    }
    expect(SHAFT_Y[1]).toBeLessThan(ENVELOPE.h);
  });
  it('the shaft and the wipers move as one with the level', () => {
    const at = (level: number) => itemMatrix(swModel(still(level, 3)).items.find((x) => x.name === 'wiper carrier')!, 0)[13];
    expect(at(7) - at(2)).toBeCloseTo(5 * LEVEL_PITCH, 6);
  });
  it('the bank: 10 × 10 × 3 contacts, a busy line’s sleeve coloured, the held line live', () => {
    const b = none();
    b[2][4] = true;
    const inst = contactInstances({ level: 3, line: 6, mode: 'connected' }, b, P);
    expect(inst).toHaveLength(LEVELS * LINES * 3);
    expect(inst.filter((x) => x.color === P.busy)).toHaveLength(1);
    expect(inst.filter((x) => x.color === P.live)).toHaveLength(3);
    expect(inst.filter((x) => x.color === P.live).map((x) => x.pos)).toContainEqual(contactAt(3, 6, 2));
  });
  it('a coil glows only while it pulls; the holding pawls swing off only on release', () => {
    const lit = (o: Partial<ReturnType<typeof still>>) => [...new Set(swModel({ ...still(3, 0), ...o }).items.filter((x) => x.mat.emit).map((x) => x.name))];
    expect(lit({})).toEqual([]);
    expect(lit({ vOn: true })).toEqual(['vertical magnet']);
    expect(lit({ rOn: true })).toEqual(['rotary magnet']);
    expect(lit({ relOn: true })).toEqual(['release magnet']);
    const hold = (held: boolean) => swModel({ ...still(3, 0), held }).items.find((x) => x.name === 'holding pawl')!.rot!;
    expect(hold(true)[3]).toBeCloseTo(1, 9);
    expect(hold(false)[3]).toBeLessThan(1);
  });
});
