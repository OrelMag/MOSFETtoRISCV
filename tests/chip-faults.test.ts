// A chip's switched-on faults (the fault brush, ChipDoc.faults) wherever it is simulated: in Check and the Tests pane on
// the chip itself, and inside every chip that places it (editor/chipfaults.ts). Before this a table passed on a chip whose
// circuit was visibly broken: only the open tab's simulation had the faults.
import { describe, expect, it } from 'vitest';
import { checkChallenge } from '../src/editor/challenges';
import { lookOf, withChipFaults } from '../src/editor/chipfaults';
import { UserLibrary } from '../src/editor/library';
import type { ChipDoc } from '../src/editor/model';
import { EditorSim } from '../src/editor/runtime';
import { planTest, runTest, type TestPlan } from '../src/editor/testtable';
import { pack } from '../src/sim/values';
import { chip, part, pin, wire, workspace } from './editorkit';

// a NOT gate between two pins; a fault on its input wire makes y stuck
const inv = (faults?: ChipDoc['faults']): ChipDoc => chip('u_inv', 'INV', {
  pins: [{ ...pin('a', 'in', [0, 2]), value: 0 }, pin('y', 'out', [20, 2])],
  parts: [part('n', { lib: 'not' }, [8, 0])],
  wires: [wire('w1', 'pin:a', 'n.a'), wire('w2', 'n.y', 'pin:y')],
  ...(faults ? { faults } : {}),
});
// a chip that places INV twice in a row (a buffer): a fault in INV is in both copies
const buf = (): ChipDoc => chip('u_buf', 'BUF', {
  pins: [{ ...pin('a', 'in', [0, 2]), value: 0 }, pin('y', 'out', [60, 2])],
  parts: [part('i1', { chip: 'u_inv' }, [10, 0]), part('i2', { chip: 'u_inv' }, [34, 0])],
  wires: [wire('v1', 'pin:a', 'i1.a'), wire('v2', 'i1.y', 'i2.a'), wire('v3', 'i2.y', 'pin:y')],
});
const STUCK = [{ id: 'f1', kind: 'stuck1' as const, target: { wires: ['w1'] } }];
const TABLES = { inv: 'a y\n0 1\n1 0', buf: 'a y\n0 0\n1 1' };

function setup(faults?: ChipDoc['faults']) {
  const ws = workspace(buf(), inv(faults));
  const lib = new UserLibrary(ws);
  return { ws, lib, look: lookOf(ws, lib) };
}

/** The table's run on a chip as Check and the Tests pane now see it. */
function table(id: 'u_inv' | 'u_buf', faults?: ChipDoc['faults']) {
  const { lib, look } = setup(faults);
  const c = lib.compiled(id)!;
  const plan = planTest(c.def, { name: 't', src: TABLES[id === 'u_inv' ? 'inv' : 'buf'] }) as TestPlan;
  expect('error' in plan).toBe(false);
  const wrap = (d: typeof c.def) => withChipFaults(d, id, look, lib.deps(id));
  return {
    tests: runTest(wrap(c.def), 'gate', plan, ['a', 'y']).failed.length,
    check: checkChallenge(plan.ch, c, wrap).ok,
  };
}

describe('a chip\'s faults in Check and the Tests pane', () => {
  it('the open chip: healthy passes; a fault switched on fails both; switched off passes again', () => {
    expect(table('u_inv')).toEqual({ tests: 0, check: true });
    const bad = table('u_inv', STUCK);
    expect(bad.tests).toBeGreaterThan(0);
    expect(bad.check).toBe(false);
    expect(table('u_inv', [{ ...STUCK[0], off: true }])).toEqual({ tests: 0, check: true });
  });

  it('placed: a table on the parent fails while a chip it places is faulted', () => {
    expect(table('u_buf')).toEqual({ tests: 0, check: true });
    const bad = table('u_buf', STUCK);
    expect(bad.tests).toBeGreaterThan(0);
    expect(bad.check).toBe(false);
  });

  it('without the lookup, a chip with no faults of its own is the same def', () => {
    const { lib, look } = setup();
    const def = lib.compiled('u_buf')!.def;
    expect(withChipFaults(def, 'u_buf', look, lib.deps('u_buf'))).toBe(def);
  });
});

describe('placed: the parent\'s canvas', () => {
  // the parent's simulation, as the editor builds it: y for a = 0 and a = 1
  const outs = (faults?: ChipDoc['faults']) => {
    const { ws, lib, look } = setup(faults);
    const doc = ws.chips.u_buf;
    return [0, 1].map((a) => {
      const es = new EditorSim({ debounceMs: 0 });
      const d = { ...doc, pins: doc.pins.map((p) => (p.name === 'a' ? { ...p, value: a } : p)) };
      es.update(lib.compiled('u_buf')!, d.pins, d, { look, deps: lib.deps('u_buf') });
      es.flush();
      const y = pack(es.pinBits('y')!);
      es.destroy();
      return y;
    });
  };

  it('a placed chip\'s fault acts inside the chip that places it, and heals when switched off', () => {
    expect(outs()).toEqual([0, 1]);
    // every copy carries its chip's faults: the second copy's input is stuck at 1 too, so y is 0 whatever a is
    expect(outs(STUCK)).toEqual([0, 0]);
    expect(outs([{ ...STUCK[0], off: true }])).toEqual([0, 1]);
  });
});
