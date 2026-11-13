// The Difference Engine column's studio model (widgets/babbage3dkit.ts) held to its sources and to the DOM-free model: the
// figure wheel's 40 teeth and four decades of numerals at 9° a unit (Swade, Technical Description, A/171), the engine's 7 ft ×
// 11 ft × 18 in (CHM), the carry lever's lozenge in the arms' path only when warned, and the motion following the carry phase.
import { describe, expect, it } from 'vitest';
import { boundsOfNamed } from '../src/gl/kit/scene';
import {
  ARM_LEN, BEAT_LAYERS, CONTACT, C_AXIS, DEG_PER_UNIT, ENGINE_MM, FRAME_GROUPS, MAX_TURN, SRC, SWING, TEETH, W_AXIS, armTipAt, babbageModel, lozengeAt, motion,
  type BabbageLook,
} from '../src/widgets/babbage3dkit';
import { ARMS, DIGITS, EVENTS, advanceTo, begin, fromValue, giveOff, type Carry } from '../src/widgets/babbage3dparts';

const rgb: BabbageLook['rgb'] = { brass: [0.8, 0.6, 0.3], warn: [1, 0.6, 0.2], nine: [1, 0.4, 0.6], live: [0.3, 0.9, 0.5], ink: [0.1, 0.1, 0.1] };
const look = (o: Partial<BabbageLook> = {}): BabbageLook => ({ detail: 'full', col: fromValue(0n), carry: null, foresee: null, lookAhead: false, layers: new Set(), rgb, ...o });
const named = (m: ReturnType<typeof babbageModel>, n: string) => m.items.filter((it) => it.name === n);
const dist = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);

describe('sourced figures', () => {
  it('a figure wheel has 40 teeth, four decades of numerals: 9° a unit, at most 81° in an addition', () => {
    expect(TEETH).toBe(40);
    expect(DEG_PER_UNIT).toBe(9);
    expect(MAX_TURN).toBe(81);
    expect(SRC.wheel).toContain('40 teeth');
  });
  it('the whole engine is 7 ft × 11 ft × 18 in (CHM), its outline drawn at that size', () => {
    expect(ENGINE_MM).toEqual({ h: 2133.6, l: 3352.8, d: 457.2 });
    const m = babbageModel(look({ layers: new Set(['engine']) })), env = named(m, 'Difference Engine No. 2')[0];
    expect(env.geo.max[0] - env.geo.min[0]).toBeCloseTo(ENGINE_MM.l, 2);
    expect(env.geo.max[1] - env.geo.min[1]).toBeCloseTo(ENGINE_MM.h, 2);
    expect(env.info?.source).toBe(SRC.engine);
    expect(named(m, 'another column')).toHaveLength(7);
    const person = named(m, 'a person, 1.75 m')[0];
    expect(person.geo.max[1] - person.geo.min[1]).toBeCloseTo(1750, -1);
  });
});

describe('the column', () => {
  it('31 wheels, 31 carry levers (the top one the overflow flag), 30 carry arms', () => {
    const m = babbageModel(look());
    const wheels = m.items.filter((it) => /wheel/.test(it.name ?? '') && it.geo.name === 'figure wheel');
    expect(wheels).toHaveLength(DIGITS);
    expect(named(m, 'carry lever').length + named(m, 'carry lever (the overflow flag)').length).toBe(DIGITS);
    expect(named(m, 'carry arm')).toHaveLength(ARMS);
  });
  it('every named part says where it comes from', () => {
    for (const it of babbageModel(look({ layers: new Set(['engine']), lookAhead: true })).items) if (it.name && it.name !== 'a person, 1.75 m') expect(it.info?.source, it.name).toBeTruthy();
  });
  it('the whole engine and the look-ahead appear only with their layer and their carriage', () => {
    expect(babbageModel(look()).items.some((it) => it.group === 'engine' || it.group === 'look')).toBe(false);
    expect(babbageModel(look({ lookAhead: true })).items.some((it) => it.group === 'look')).toBe(true);
    const m = babbageModel(look());
    expect(BEAT_LAYERS.length).toBe(m.beats!.length);
    BEAT_LAYERS.forEach((ls, i) => expect(ls.includes('engine')).toBe(m.beats![i].title === 'The whole engine'));
  });
  it('the frames the views fit to are in both builds (the stage hides them), round what they frame', () => {
    for (const g of FRAME_GROUPS) {
      expect(babbageModel(look()).items.some((it) => it.group === g)).toBe(true);
      expect(babbageModel(look({ detail: 'flat' })).items.some((it) => it.group === g)).toBe(true);
    }
    const col = boundsOfNamed(babbageModel(look()), ['colbox']), wheels = boundsOfNamed(babbageModel(look()), ['wheels']);
    for (let a = 0; a < 3; a++) { expect(col.min[a]).toBeLessThanOrEqual(wheels.min[a]); expect(col.max[a]).toBeGreaterThanOrEqual(wheels.max[a]); }
  });
});

describe('the carry lever and the arms', () => {
  it('a warned lever’s lozenge is in the arm’s path: the arm at its poll reaches it', () => {
    expect(dist(lozengeAt(0), armTipAt(0))).toBeLessThan(4);
    expect(dist(lozengeAt(0), C_AXIS)).toBeLessThan(ARM_LEN);
  });
  it('unwarned and carried, the lozenge is clear of every arm’s circle', () => {
    for (const s of [SWING, -SWING]) expect(dist(lozengeAt(s), C_AXIS) - ARM_LEN).toBeGreaterThan(3);
    expect(dist(W_AXIS, C_AXIS)).toBeGreaterThan(ARM_LEN);
  });
});

describe('the motion follows the model', () => {
  it('each wheel stands at its digit × 9°; a warned lever at 0, others unwarned', () => {
    const col = giveOff(fromValue(7999999n), 1n), mo = motion(col, null);
    col.w.forEach((d, i) => expect(mo.turn[i]).toBe(d * 9));
    col.warn.forEach((w, i) => expect(mo.lever[i]).toBe(w ? 0 : SWING));
  });
  it('as an arm comes up to an armed lever the wheel above turns its tooth and the lever swings over; then both stay', () => {
    // arm 1 services the lever arm 0 warned (a run of 9s): wheel 2 stands at 9 until arm 1 comes up
    const g = giveOff(fromValue(7999999n), 1n), t1 = EVENTS.find((e) => e.arm === 1)!.t;
    const at = (th: number): Carry => advanceTo(begin(g), th);
    const b = at(t1 - CONTACT), m = at(t1 - CONTACT / 2);
    expect(b.col.warn[1]).toBe(true);
    expect(motion(b.col, b).turn[2]).toBeCloseTo(9 * 9, 9);
    expect(motion(m.col, m).turn[2]).toBeCloseTo(9 * 9 + 4.5, 9);
    expect(motion(m.col, m).lever[1]).toBeCloseTo(-SWING / 2, 9);
    const after = at(t1);
    expect(after.fired).toContain(1);
    const ma = motion(after.col, after);
    expect(ma.lever[1]).toBe(-SWING);
    // the wheel above is now at its new digit: 9 + 1 = 0, and its own lever warned for the next arm
    expect(ma.turn[2]).toBe(0);
    expect(after.col.warn[2]).toBe(true);
  });
  it('the carry arms turn with the axis: at its poll an arm points at the levers', () => {
    const g = giveOff(fromValue(9n), 1n), s = advanceTo(begin(g), EVENTS[0].t), m = babbageModel(look({ col: s.col, carry: s }));
    expect(named(m, 'carry arm')).toHaveLength(ARMS);
  });
});

describe('the tour quotes the document’s angles', () => {
  it('22½° between arms, 45° at the gap, written as the Technical Description writes them', () => {
    const helix = babbageModel(look()).beats!.find((b) => b.title === 'The helix of arms')!.text;
    expect(helix).toContain('22½° apart');
    expect(helix).toContain('45° between the 15th and 16th');
  });
});
