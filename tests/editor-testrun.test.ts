// The test player's engine: it replays exactly the cases Check ran (same count, same failing
// indices), on the editor's own simulation, forward and backward; a reference answer reads
// correct on every case; end() gives the simulation back as it was; an edit while paused
// replays the case on the rebuilt circuit.

import { describe, expect, it } from 'vitest';
import { levelChallenge } from '../src/campaign/levels';
import { NODES, nodeById } from '../src/campaign/nodes';
import { CHALLENGES, challengeById } from '../src/editor/challengeset';
import { type BuildChallenge, checkChallenge, startChallenge } from '../src/editor/challenges';
import { UserLibrary } from '../src/editor/library';
import { type ChipDoc, emptyWorkspace } from '../src/editor/model';
import { EditorSim } from '../src/editor/runtime';
import { testSet, TestReplay } from '../src/editor/testrun';
import { chip, part, pin, wire, workspace } from './editorkit';

const ch = (id: string): BuildChallenge => challengeById(id)!;

/** A chip (with the chips it uses) on an EditorSim, as the sandbox runs it. */
function open(doc: ChipDoc, ...deps: ChipDoc[]) {
  const lib = new UserLibrary(workspace(doc, ...deps));
  const c = lib.compiled(doc.id)!;
  const es = new EditorSim({ debounceMs: 0 });
  es.update(c, doc.pins);
  return { es, c };
}

function answer(c: BuildChallenge) {
  const chips = c.answer();
  const main = chips[chips.length - 1];
  return { main, ...open(main, ...chips.slice(0, -1)) };
}

const xorPins = () => [pin('a', 'in', [0, 2]), pin('b', 'in', [0, 6]), pin('y', 'out', [20, 4])];

describe('testSet', () => {
  it.each(CHALLENGES.filter((c) => c.check.kind !== 'custom').map((c) => [c.id, c] as const))('%s: the reference answer reads correct on every case Check ran', (_, c) => {
    const { es, c: comp } = answer(c);
    const r = checkChallenge(c, comp);
    const set = testSet(c)!;
    expect(set.n).toBe(r.tested);
    expect(r.failed).toEqual([]);
    const rp = new TestReplay(es, set, c.check);
    const last = Math.min(set.n, 300);
    for (let k = 0; k < last; k++) {
      rp.goto(k);
      const v = rp.read();
      expect(v.ok, `${c.id} case ${k}: ${JSON.stringify(v.outs)}`).toBe(true);
    }
    rp.end();
  });

  const levels = NODES.map((n) => levelChallenge(n)).filter((c): c is BuildChallenge => !!c && c.check.kind !== 'custom');
  // (campaign.test.ts checks these answers pass; here only the replay.)
  it.each(levels.map((c) => [c.id, c] as const))('campaign %s: the reference answer replays correct', (_, c) => {
    const { es } = answer(c);
    const set = testSet(c)!;
    const rp = new TestReplay(es, set, c.check);
    for (let k = 0; k < Math.min(set.n, 48); k++) {
      rp.goto(k);
      expect(rp.read().ok, `case ${k}`).toBe(true);
    }
    rp.goto(set.n - 1);
    expect(rp.read().ok, 'last case').toBe(true);
    rp.end();
  });

  it('is null for a custom bench (a core level)', () => {
    expect(testSet(levelChallenge(nodeById('c_core1')!)!)).toBeNull();
  });
});

describe('TestReplay', () => {
  it('lands on the failing row Check found, and only that one fails', () => {
    // OR instead of XOR: only a = b = 1 differs.
    const or = ch('g_or').answer()[0];
    const doc = chip('u_ch_g_xor', 'XOR', {
      pins: xorPins(), parts: [part('g', { chip: or.id }, [6, 0])],
      wires: [wire('a', 'pin:a', 'g.a'), wire('b', 'pin:b', 'g.b'), wire('y', 'g.y', 'pin:y')],
    });
    const { es, c } = open(doc, or);
    const r = checkChallenge(ch('g_xor'), c);
    expect(r.failed).toEqual([3]);
    const rp = new TestReplay(es, testSet(ch('g_xor'))!, ch('g_xor').check);
    rp.goto(r.failed![0]);
    const v = rp.read();
    expect(v.case.inputs).toEqual(r.vector);
    expect(v.ok).toBe(false);
    expect(v.outs[0]).toMatchObject({ name: 'y', got: [1], want: 0, ok: false });
    for (const k of [0, 1, 2]) {
      rp.goto(k);
      expect(rp.read().ok).toBe(true);
    }
  });

  it('gives the simulation back as it was, and never writes the document', () => {
    const or = ch('g_or').answer()[0];
    const doc = chip('u_x', 'XOR', {
      pins: [{ ...xorPins()[0], value: 1 }, ...xorPins().slice(1)], parts: [part('g', { chip: or.id }, [6, 0])],
      wires: [wire('a', 'pin:a', 'g.a'), wire('b', 'pin:b', 'g.b'), wire('y', 'g.y', 'pin:y')],
    });
    const { es } = open(doc, or);
    expect(es.pinBits('y')).toEqual([1]);
    const rp = new TestReplay(es, testSet(ch('g_xor'))!, ch('g_xor').check);
    rp.goto(0);
    expect(es.pinBits('a')).toEqual([0]);
    expect(es.pinBits('y')).toEqual([0]);
    rp.end();
    expect(rp.active).toBe(false);
    expect(es.pinBits('a')).toEqual([1]);
    expect(es.pinBits('y')).toEqual([1]);
    expect(doc.pins[0].value).toBe(1);
  });

  it('a sequence: stepping back and scrubbing read what the forward pass read', () => {
    const c = ch('s_cnt4');
    const { es } = answer(c);
    const set = testSet(c)!;
    expect(set.kind).toBe('sequence');
    expect(set.n).toBeGreaterThan(8);
    const rp = new TestReplay(es, set, c.check);
    const fwd = [];
    for (let k = 0; k < set.n; k++) {
      rp.goto(k);
      fwd.push(rp.read());
    }
    expect(fwd.every((v) => v.ok)).toBe(true);
    for (const k of [set.n - 1, 3, 0, Math.floor(set.n / 2), 1, set.n - 2]) {
      rp.goto(k);
      expect(rp.read(), `step ${k}`).toEqual(fwd[k]);
    }
    rp.end();
  });

  it('a long sequence uses its checkpoints (a campaign register file)', () => {
    const c = levelChallenge(nodeById('m_rf')!)!;
    expect(c.check.kind).toBe('sequence');
    const { es } = answer(c);
    const set = testSet(c)!;
    expect(set.n).toBeGreaterThan(64);
    const rp = new TestReplay(es, set, c.check);
    rp.goto(set.n - 1);
    expect(rp.read().ok).toBe(true);
    for (const k of [70, 33, 65, 2]) {
      rp.goto(k);
      expect(rp.read().ok, `step ${k}`).toBe(true);
    }
    rp.end();
  });

  it('a failing sequence: Check\'s failing steps read wrong, the others right', () => {
    const c = ch('s_dff');
    const ws = startChallenge(emptyWorkspace(), c).ws;
    const doc = ws.chips[`u_ch_${c.id}`];
    const { es, c: comp } = open(doc);
    const r = checkChallenge(c, comp);
    expect(r.failed!.length).toBeGreaterThan(0);
    const rp = new TestReplay(es, testSet(c)!, c.check);
    for (let k = 0; k < r.tested; k++) {
      rp.goto(k);
      expect(rp.read().ok, `step ${k}`).toBe(!r.failed!.includes(k));
    }
  });

  it('an edit while paused: the case plays again on the rebuilt circuit', () => {
    const or = ch('g_or').answer()[0];
    const xor = ch('g_xor').answer().at(-1)!;
    const wrong = chip('u_x', 'XOR', {
      pins: xorPins(), parts: [part('g', { chip: or.id }, [6, 0])],
      wires: [wire('a', 'pin:a', 'g.a'), wire('b', 'pin:b', 'g.b'), wire('y', 'g.y', 'pin:y')],
    });
    const { es } = open(wrong, or);
    const rp = new TestReplay(es, testSet(ch('g_xor'))!, ch('g_xor').check);
    rp.goto(3);
    expect(rp.read().ok).toBe(false);
    // The learner fixes it: same pins, the reference XOR inside.
    const fixed = { ...xor, id: 'u_x' };
    const lib = new UserLibrary(workspace(fixed, ...ch('g_xor').answer().slice(0, -1)));
    const before = es.sim;
    es.update(lib.compiled('u_x')!, fixed.pins);
    expect(es.sim).not.toBe(before);
    rp.resync();
    expect(rp.k).toBe(3);
    expect(es.pinBits('a')).toEqual([1]);
    expect(rp.read().ok).toBe(true);
    rp.end();
    expect(es.pinBits('a')).toEqual([0]); // the document's values (none: 0)
  });
});
