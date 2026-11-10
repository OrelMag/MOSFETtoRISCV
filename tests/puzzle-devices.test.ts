// Puzzle devices (puzzles/devices.ts, editor/devparts.ts, puzzles/devpuzzles.ts, devrefs.ts): each world's rules fire on the
// step they should with the words they should, the reference controller passes every test, and the reference circuit on its
// gates (the sandbox's cycle engine) does exactly what the reference controller does, pin for pin, step for step.

import { describe, expect, it } from 'vitest';
import {
  CROSSING_MODEL, CROSSING_TESTS, type CrossingTest, DEVICE_IDS, DEVICES, MAZE_MODEL, MAZE_TESTS, type MazeTest, playWorld, VEND_MODEL, VEND_TESTS, type VendTest,
} from '../src/puzzles/devices';
import { copyWithDevice, REFERENCE_CONTROLLERS, referenceChip, referenceDef } from '../src/puzzles/devrefs';
import { DEVICE_PUZZLES, deviceStars, deviceTests, devicePuzzleChipId, devicePuzzleOfChip, findDevice, parNands, playDeviceTest, runDevicePuzzle } from '../src/puzzles/devpuzzles';
import { deviceDef, deviceOf, deviceLeaves, type DeviceState } from '../src/editor/devparts';
import { UserLibrary } from '../src/editor/library';
import { emptyWorkspace } from '../src/editor/model';
import { EditorSim } from '../src/editor/runtime';
import { sanitizeRef } from '../src/editor/store';
import { decodeShare, encodeShare } from '../src/editor/share';
import { partDef } from '../src/editor/parts';
import { DualSim } from '../src/sim/dualsim';
import { flatten } from '../src/sim/flatten';

const cross = (t: CrossingTest, ctl: (s: number[], k: number) => number[]) => playWorld(CROSSING_MODEL, t, ctl);
const one: CrossingTest = { name: 'one', steps: 40, presses: [3] };
// lamps [r, y, g, walk]
const G = [0, 0, 1, 0], Y = [0, 1, 0, 0], R = [1, 0, 0, 0], W = [1, 0, 0, 1];
/** A crossing controller from a list of lamp settings per step (the last one held). */
const script = (xs: number[][]) => (_: number[], k: number) => xs[Math.min(k, xs.length - 1)];
const run = (spec: [number[], number][]) => spec.flatMap(([l, n]) => Array.from({ length: n }, () => l));

describe('the crossing: every rule fires where it should', () => {
  it('the reference passes every test; a press is served in at most 9 steps', () => {
    for (const t of CROSSING_TESTS) {
      const r = cross(t, REFERENCE_CONTROLLERS.crossing());
      expect(r.ok, `${t.name}: ${r.why}`).toBe(true);
      expect((r.world as { waited: number }).waited).toBeLessThanOrEqual(9);
    }
  });
  it.each([
    ['two lamps', run([[[0, 1, 1, 0], 1]]), 0, 'yellow and green lit together: exactly one car lamp at a time'],
    ['no lamp', run([[[0, 0, 0, 0], 1]]), 0, 'no car lamp lit: exactly one at a time'],
    ['walk on green', run([[G, 3], [[0, 0, 1, 1], 1]]), 3, 'WALK while the cars have green: only on red'],
    ['red after green', run([[G, 6], [R, 1]]), 6, 'red straight after green: yellow first, for at least 2 steps'],
    ['yellow too short', run([[G, 6], [Y, 1], [R, 1]]), 7, 'yellow for only 1 step: at least 2'],
    ['back to green', run([[G, 6], [Y, 2], [G, 1]]), 8, 'green again straight after yellow: yellow leads to red'],
    ['walk with nobody', run([[Y, 2], [W, 1]]), 2, 'WALK with nobody waiting: only after a press'],
    ['walk too short', run([[G, 6], [Y, 2], [W, 3], [R, 1]]), 11, 'WALK for only 3 steps: at least 4'],
    ['never served', run([[G, 40]]), 15, 'the press at step 3 not served within 12 steps'],
    ['yellow after red', run([[R, 1], [Y, 1]]), 1, 'yellow after red: red goes back to green'],
  ] as const)('%s', (_, xs, at, why) => {
    const r = cross(one, script(xs as number[][]));
    expect([r.ok, r.at, r.why]).toEqual([false, at, why]);
  });
  it('green too short between two walks, and an X lamp', () => {
    const t: CrossingTest = { name: 'two', steps: 40, presses: [1, 12] };
    const r = cross(t, script(run([[G, 2], [Y, 2], [W, 4], [R, 1], [G, 2], [Y, 2], [W, 1]])));
    expect([r.ok, r.at, r.why]).toEqual([false, 13, 'WALK again after only 2 steps of green: cars get at least 6']);
    expect(cross(one, () => [0, 0, -1, 0]).why).toBe('car_g is X (unknown): drive every pin to 0 or 1');
  });
  it('at the end: a press still waiting', () => {
    const r = cross({ name: 'short', steps: 10, presses: [3] }, script(run([[G, 10]])));
    expect([r.ok, r.at, r.why]).toEqual([false, 10, 'the press at step 3 still waits at the end']);
  });
  it('a press while WALK is lit is not counted again', () => {
    const r = cross({ name: 'w', steps: 40, presses: [3, 10] }, REFERENCE_CONTROLLERS.crossing());
    expect(r.ok).toBe(true);
    expect((r.world as { walks: number }).walks).toBe(1);
  });
});

describe('the maze: every rule fires where it should', () => {
  const left = () => [0, 1, 0];
  it('the reference passes every maze; without its flip-flop it goes round in every one', () => {
    const steps = MAZE_TESTS.map((t) => cross0(t, REFERENCE_CONTROLLERS.maze()));
    expect(steps).toEqual([28, 45, 85, 9]);
    // a fresh controller every step: "just turned" is always 0
    const noFlop = (s: number[]) => REFERENCE_CONTROLLERS.maze()(s);
    for (const t of MAZE_TESTS) {
      const r = playWorld(MAZE_MODEL, t, noFlop);
      expect(r.ok, t.name).toBe(false);
      expect(r.why).toMatch(/^not at the goal after \d+ steps .*going round\?$/);
    }
  });
  it('a wall, two commands, an X', () => {
    const t = MAZE_TESTS[0] as MazeTest;
    // the long way starts in the top-left corner facing south: turn right twice (now north) and drive into the outer wall
    const r = playWorld(MAZE_MODEL, t, script([[0, 0, 1], [0, 0, 1], [1, 0, 0]]));
    expect([r.ok, r.at, r.why]).toEqual([false, 2, 'drove forward into a wall at row 1, column 1, facing north']);
    expect(playWorld(MAZE_MODEL, t, () => [1, 1, 0]).why).toBe('fwd and left at once: one command a step');
    expect(playWorld(MAZE_MODEL, t, () => [0, -1, 0]).why).toBe('left is X (unknown): drive every pin to 0 or 1');
    // turning on the spot for ever: the step limit, and the repeat it noticed
    expect(playWorld(MAZE_MODEL, t, left).why).toBe('not at the goal after 60 steps (row 1, column 1); it stood here facing south at step 0 too: going round?');
  });
});

function cross0(t: MazeTest, ctl: (s: number[]) => number[]): number {
  const r = playWorld(MAZE_MODEL, t, ctl);
  expect(r.ok, `${t.name}: ${r.why}`).toBe(true);
  return r.at;
}

describe('the vending machine: every rule fires where it should', () => {
  const vend = (t: VendTest, ctl: (s: number[], k: number) => number[]) => playWorld(VEND_MODEL, t, ctl);
  const t35: VendTest = { name: '35', steps: 24, script: [[1, 'c25'], [2, 'c10'], [4, 'buy']] };
  const at = (pairs: Record<number, number[]>) => (_: number[], k: number) => pairs[k] ?? [0, 0];
  it('the reference passes every test, with the right items and change', () => {
    const got = VEND_TESTS.map((t) => {
      const r = vend(t, REFERENCE_CONTROLLERS.vend());
      expect(r.ok, `${t.name}: ${r.why}`).toBe(true);
      const w = r.world as { items: number; returned: number; credit: number };
      return [w.items, w.returned, w.credit];
    });
    expect(got).toEqual([[1, 0, 0], [1, 5, 0], [1, 20, 0], [0, 25, 0], [2, 5, 0], [0, 0, 0]]);
  });
  it('each rule', () => {
    expect(vend(t35, at({ 2: [1, 0] })).why).toBe('dropped an item with only 25¢ paid');
    expect(vend(t35, at({ 3: [1, 0] })).why).toBe('dropped an item with nobody pressing buy');
    expect(vend(t35, at({ 3: [0, 1] })).why).toBe('gave back 5¢ with no sale or refund to make change for');
    expect(vend(t35, at({ 4: [1, 2] })).why).toBe('gave back 10¢ with only 5¢ left to return');
    expect(vend(t35, at({ 4: [0, 3] })).why).toBe('chg = 3: there is no such coin to return');
    expect(vend(t35, at({})).why).toBe('buy at step 4 not served within 4 steps');
    const r = vend(t35, at({ 4: [1, 0] }));
    expect([r.at, r.why]).toEqual([13, '5¢ change still owed 10 steps after step 4']);
    expect(vend(t35, at({ 5: [1, 0], 6: [0, 1] })).ok).toBe(true);
  });
  it('at the end: a buy never served, change still owed', () => {
    const buyLate: VendTest = { name: 'late', steps: 6, script: [[0, 'c10'], [1, 'c10'], [2, 'c10'], [5, 'buy']] };
    expect([vend(buyLate, at({})).at, vend(buyLate, at({})).why]).toEqual([6, 'buy at step 5 never served']);
    const owed: VendTest = { name: 'owed', steps: 6, script: [[0, 'c25'], [1, 'c10'], [3, 'buy']] };
    const r = vend(owed, at({ 3: [1, 0] }));
    expect([r.ok, r.at, r.why]).toEqual([false, 6, '5¢ change still owed at the end']);
  });
});

describe('the device part', () => {
  it('a ref round-trips through the sanitizer and gives back the memoized part', () => {
    for (const dev of DEVICE_IDS) for (const en of [false, true]) {
      const ref = sanitizeRef(en ? { device: dev, en: true } : { device: dev });
      expect(ref).toEqual(en ? { device: dev, en: true } : { device: dev });
      expect(partDef(ref!, () => undefined)).toBe(deviceDef(dev, en));
      expect(deviceOf(deviceDef(dev, en))).toEqual({ dev, en });
    }
    expect(sanitizeRef({ device: 'robot' })).toBeNull();
  });
  it('pins: drive in, sense out, clk at the bottom; en only when asked', () => {
    expect(deviceDef('crossing').ports.map((p) => `${p.name}:${p.dir}`)).toEqual(['car_r:in', 'car_y:in', 'car_g:in', 'walk:in', 'clk:in', 'req:out']);
    expect(deviceDef('maze', true).ports.map((p) => p.name)).toEqual(['fwd', 'left', 'right', 'en', 'clk', 'wall_f', 'wall_l', 'wall_r', 'goal']);
    for (const dev of DEVICE_IDS) expect(DEVICES[dev].sense.length + DEVICES[dev].drive.length).toBeGreaterThan(0);
  });
  it('en paces the world: no step while en = 0, one per rising edge with en = 1; a chip copy gets the device beside it', () => {
    const d = deviceDef('maze', true), m = MAZE_MODEL;
    const st = d.behavior!.init!() as DeviceState;
    const edge = (en: number, drive: number[]) => { d.behavior!.eval([...drive, en, 0], st); return d.behavior!.eval([...drive, en, 1], st); };
    edge(0, [0, 0, 1]);
    edge(0, [0, 0, 1]);
    expect(st.n).toBe(0);
    edge(1, [0, 0, 1]);
    expect([st.n, (st.w as { d: number }).d]).toEqual([1, 3]);
    // the sense pins follow the world alone, whatever the drive pins do between edges
    expect(d.behavior!.eval([1, 1, 1, 1, 1], st)).toEqual(m.sensors(st.w as never));
    const copy = copyWithDevice({ id: 'u_cpu', name: 'My CPU', pins: [], parts: [{ id: 'dev', ref: { lib: 'nand' }, at: [4, 2] }], wires: [], labels: [] }, 'maze', 'u_pz_maze', 'Puzzle', true, () => 6);
    expect(copy.parts.at(-1)).toEqual({ id: 'dev2', ref: { device: 'maze', en: true }, at: [18, 2], label: 'maze robot' });
  });
});

describe('the reference circuits on their gates', () => {
  for (const p of DEVICE_PUZZLES) {
    it(`${p.title}: every test passes, and every step equals the reference controller's`, () => {
      const id = devicePuzzleChipId(p);
      expect(devicePuzzleOfChip(id)).toBe(p);
      const doc = referenceChip(p.dev, id, p.title);
      const ws = { ...emptyWorkspace(), chips: { [id]: doc } };
      const c = new UserLibrary(ws).compiled(id)!;
      expect(c.diags.filter((d) => d.level === 'error')).toEqual([]);
      const r = runDevicePuzzle(p, c, doc.pins);
      expect(r.problems).toEqual([]);
      for (const t of r.results) expect(t.ok, `${t.name}: ${t.why}`).toBe(true);
      // step for step against the TypeScript reference: the frames the device recorded
      const es = new EditorSim({ debounceMs: 0 });
      es.setMode('cycle');
      es.update(c, doc.pins);
      const found = findDevice(es, p);
      if (Array.isArray(found)) throw new Error(found.join('; '));
      deviceTests(p).forEach((t, k) => {
        playDeviceTest(es, found, p, k);
        const st = es.sim!.leafState(found.li) as DeviceState;
        const want = playWorld(DEVICES[p.dev], t, REFERENCE_CONTROLLERS[p.dev]());
        expect(st.frames.map((f) => [f.drive, f.sense]), t.name).toEqual(want.frames.map((f) => [f.drive, f.sense]));
      });
      // on the cycle engine (the device is a seq leaf: no loop through it)
      expect(es.engine, 'cycle engine').toBe('cycle');
      es.destroy();
      // and on GateSim (gate mode: Gate delay, the Timing panel, probes), the same steps
      const eg = new EditorSim({ debounceMs: 0 });
      eg.setMode('gate');
      eg.update(c, doc.pins);
      const fg = findDevice(eg, p);
      if (Array.isArray(fg)) throw new Error(fg.join('; '));
      deviceTests(p).forEach((t, k) => {
        expect(playDeviceTest(eg, fg, p, k).ok, `${t.name} on gates`).toBe(true);
        const st = eg.sim!.leafState(fg.li) as DeviceState;
        const want = playWorld(DEVICES[p.dev], t, REFERENCE_CONTROLLERS[p.dev]());
        expect(st.frames.map((f) => [f.drive, f.sense]), `${t.name} on gates`).toEqual(want.frames.map((f) => [f.drive, f.sense]));
      });
      eg.destroy();
    });
  }
  it('a device chip survives a share link (the same sanitizer as storage)', async () => {
    const doc = referenceChip('maze', 'u_pz_maze', 'Maze');
    const back = await decodeShare(await encodeShare([doc]));
    if ('error' in back) throw new Error(back.error);
    expect(back[0].parts.find((q) => 'device' in q.ref)?.ref).toEqual({ device: 'maze' });
    expect(back[0]).toEqual(doc);
  });
  it('the par: NANDs of each reference, and the stars', () => {
    const pars = Object.fromEntries(DEVICE_PUZZLES.map((p) => [p.id, parNands(p.dev)]));
    expect(pars).toMatchInlineSnapshot(`
      {
        "crossing": 121,
        "maze": 30,
        "vending": 211,
      }
    `);
    expect([deviceStars(40, 40), deviceStars(60, 40), deviceStars(61, 40)]).toEqual([3, 2, 1]);
  });
  it('the cycle engine takes a reference without falling back to gates', () => {
    for (const dev of DEVICE_IDS) {
      const sim = new DualSim(flatten(referenceDef(dev), { mode: 'gate' }));
      sim.preferFast = true;
      sim.reset('zero');
      sim.settle();
      sim.prepare();
      expect(sim.whyNot, dev).toBe('');
      expect(sim.engine, dev).toBe('cycle');
      expect(deviceLeaves(sim).length).toBe(1);
    }
  });
});
