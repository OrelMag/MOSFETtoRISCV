// Build challenges: every reference answer passes its own check (and meets its own par), wrong
// circuits fail with readable vectors, palette restrictions are enforced on the compiled
// hierarchy, and the checker never throws on whatever the learner has drawn so far.

import { describe, expect, it } from 'vitest';
import { CHALLENGES, challengeById } from '../src/editor/challengeset';
import {
  type BuildChallenge, challengeChipId, challengeOf, checkChallenge, importAnswer, LEVELS, solveChallenge, startChallenge,
} from '../src/editor/challenges';
import { checkSimulatable } from '../src/editor/compile';
import { UserLibrary } from '../src/editor/library';
import { type ChipDoc, emptyWorkspace, type Workspace } from '../src/editor/model';
import { chip, part, pin, wire, workspace } from './editorkit';

const ch = (id: string): BuildChallenge => challengeById(id)!;

/** Compile a chip in the context of a workspace and check it. */
function check(c: BuildChallenge, doc: ChipDoc, ...deps: ChipDoc[]) {
  const lib = new UserLibrary(workspace(doc, ...deps));
  return checkChallenge(c, lib.compiled(doc.id));
}

describe('the challenge set', () => {
  it('covers every level, 15–22 challenges, unique ids', () => {
    expect(CHALLENGES.length).toBeGreaterThanOrEqual(15);
    expect(CHALLENGES.length).toBeLessThanOrEqual(22);
    expect(new Set(CHALLENGES.map((c) => c.id)).size).toBe(CHALLENGES.length);
    for (const l of LEVELS) expect(CHALLENGES.some((c) => c.level === l.id), l.id).toBe(true);
  });

  it.each(CHALLENGES.map((c) => [c.id, c] as const))('%s: the reference answer passes its own check and par', (_, c) => {
    const chips = c.answer();
    const main = chips[chips.length - 1];
    const lib = new UserLibrary(workspace(main, ...chips.slice(0, -1)));
    for (const d of chips) {
      expect(lib.compiled(d.id)!.diags, d.id).toEqual([]);
      expect(checkSimulatable(lib.compiled(d.id)!), d.id).toEqual([]);
    }
    const r = checkChallenge(c, lib.compiled(main.id));
    expect(r.failures).toEqual([]);
    expect(r.restrictionViolations).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.tested).toBeGreaterThan(0);
    const { maxNand, maxTransistors, maxDepth } = c.limits ?? {};
    if (maxNand !== undefined) expect(r.score.nand).toBeLessThanOrEqual(maxNand);
    if (maxTransistors !== undefined) expect(r.score.transistors).toBeLessThanOrEqual(maxTransistors);
    if (maxDepth !== undefined) expect(r.score.depth).toBeLessThanOrEqual(maxDepth);
    // Every pin of the challenge is a pin of the answer, same direction and width.
    for (const p of c.ports) expect(main.pins.find((q) => q.name === p.name), p.name).toMatchObject({ dir: p.dir, width: p.width });
  });

  it('answers are memoized documents (one object per chip) and reuse the rungs below', () => {
    expect(ch('a_add4').answer()[0]).toBe(ch('a_fa').answer()[0]);
    expect(ch('s_reg4').answer().map((c) => c.id)).toEqual(expect.arrayContaining(['u_ref_dff', 'u_ref_dlatch', 'u_ref_sr', 'u_ref_mux']));
  });
});

describe('checkChallenge', () => {
  const xorPins = () => [pin('a', 'in', [0, 2]), pin('b', 'in', [0, 6]), pin('y', 'out', [20, 4])];

  it('a wrong circuit fails with the vectors that differ', () => {
    // OR instead of XOR: only a = b = 1 differs.
    const or = ch('g_or').answer()[0];
    const doc = chip('u_ch_g_xor', 'XOR', {
      pins: xorPins(), parts: [part('g', { chip: or.id }, [6, 0])],
      wires: [wire('a', 'pin:a', 'g.a'), wire('b', 'pin:b', 'g.b'), wire('y', 'g.y', 'pin:y')],
    });
    const r = check(ch('g_xor'), doc, or);
    expect(r.ok).toBe(false);
    expect(r.failures).toEqual(['a=1 b=1 → y=1, expected y=0']);
    expect(r.restrictionViolations).toEqual([]);
    expect(r.score.nand).toBe(3);
  });

  it('an unconnected output reads X, a multi-bit one per bit', () => {
    const doc = chip('u_x', 'X', { pins: xorPins() });
    const r = check(ch('g_xor'), doc);
    expect(r.failures[0]).toBe('a=0 b=0 → y=X, expected y=0');
    expect(r.failures.at(-1)).toMatch(/more of 4 rows wrong|expected/);
    const add = chip('u_add', 'A', {
      pins: [pin('a', 'in', [0, 0], 4), pin('b', 'in', [0, 2], 4), pin('cin', 'in', [0, 4]), pin('s', 'out', [20, 0], 4), pin('cout', 'out', [20, 2])],
    });
    const r2 = check(ch('a_add4'), add);
    expect(r2.failures[0]).toMatch(/^a=0 b=0 cin=0 → s=0bXXXX cout=X, expected s=0 cout=0$/);
    expect(r2.failures).toHaveLength(6);
    expect(r2.failures[5]).toBe('… 507 more of 512 rows wrong');
  });

  it('flags library parts the challenge does not allow', () => {
    const doc = chip('u_ch_g_xor', 'XOR', {
      pins: xorPins(), parts: [part('x', { lib: 'xor' }, [6, 0])],
      wires: [wire('a', 'pin:a', 'x.a'), wire('b', 'pin:b', 'x.b'), wire('y', 'x.y', 'pin:y')],
    });
    const r = check(ch('g_xor'), doc);
    expect(r.failures).toEqual([]); // it does compute XOR...
    expect(r.ok).toBe(false); // ...but from a forbidden part
    expect(r.restrictionViolations).toEqual(['x: library part XOR: only NAND gates (and your chips built from them)']);
    // Inside a user chip too, with its path.
    const inner = chip('u_inner', 'Inner', { ...doc, id: 'u_inner' });
    const outer = chip('u_outer', 'Outer', {
      pins: xorPins(), parts: [part('i', { chip: 'u_inner' }, [6, 0])],
      wires: [wire('a', 'pin:a', 'i.a'), wire('b', 'pin:b', 'i.b'), wire('y', 'i.y', 'pin:y')],
    });
    expect(check(ch('g_xor'), outer, inner).restrictionViolations).toEqual(['i.x: library part XOR: only NAND gates (and your chips built from them)']);
    // A library NAND in a transistor challenge.
    const nand = chip('u_n', 'N', {
      pins: xorPins(), parts: [part('g', { lib: 'nand' }, [6, 0])],
      wires: [wire('a', 'pin:a', 'g.a'), wire('b', 'pin:b', 'g.b'), wire('y', 'g.y', 'pin:y')],
    });
    const rn = check(ch('t_nand'), nand);
    expect(rn.failures).toEqual([]);
    expect(rn.restrictionViolations).toEqual(['g: a library NAND: build it from transistors']);
    // 'any' allows the library.
    expect(checkChallenge(ch('c_alu'), undefined).restrictionViolations).toEqual([]);
  });

  it('reports pin problems instead of simulating', () => {
    const doc = chip('u_p', 'P', { pins: [pin('a', 'in', [0, 2], 2), pin('c', 'in', [0, 6]), pin('q', 'out', [20, 4])] });
    const r = check(ch('g_xor'), doc);
    expect(r.failures).toEqual([
      "pin 'a' must be 1 bit wide (it is 2)", "missing input pin 'b'", "missing output pin 'y'",
      "unexpected input pin 'c': the test drives only a, b",
    ]);
    expect(r.tested).toBe(0);
  });

  it('never throws: nothing, an empty chip, a broken chip, an oscillator', () => {
    for (const c of CHALLENGES) {
      expect(checkChallenge(c, undefined).ok).toBe(false);
      const r = check(c, chip('u_e', 'E', {}));
      expect(r.ok).toBe(false);
      expect(r.failures.length).toBeGreaterThan(0);
    }
    const broken = chip('u_b', 'B', {
      pins: xorPins(), parts: [part('g', { lib: 'no_such_part' }, [6, 0]), part('h', { chip: 'u_missing' }, [6, 8])],
      wires: [wire('a', 'pin:a', 'g.a'), wire('y', 'pin:y', 'zz.q')],
    });
    const rb = check(ch('g_xor'), broken);
    expect(rb.ok).toBe(false);
    expect(rb.failures.some((f) => f.startsWith('error: g: unknown library part'))).toBe(true);
    // A ring of three inverting NANDs: y oscillates.
    const ring = chip('u_r', 'R', {
      pins: xorPins(), parts: [part('n1', { lib: 'nand' }, [6, 0]), part('n2', { lib: 'nand' }, [12, 0]), part('n3', { lib: 'nand' }, [18, 0])],
      wires: [
        wire('a', 'pin:a', 'n1.a'), wire('b', 'pin:b', 'n2.b'), wire('c', 'n1.y', 'n2.a'), wire('d', 'n2.y', 'n3.a'),
        wire('e', 'n2.y', 'n3.b'), wire('f', 'n3.y', 'n1.b', [[24, 6], [4, 6]]), wire('y', 'n3.y', 'pin:y'),
      ],
    });
    const rr = check(ch('g_xor'), ring);
    expect(rr.ok).toBe(false);
    expect(rr.failures.join(' ')).toMatch(/settle|oscillat|expected/);
    // A sequential challenge on a chip that is not clocked at all.
    const nodff = chip('u_d', 'D', { pins: [pin('d', 'in', [0, 2]), pin('clk', 'in', [0, 6]), pin('q', 'out', [20, 4])], wires: [wire('w', 'pin:d', 'pin:q')] });
    const rd = check(ch('s_dff'), nodff);
    expect(rd.ok).toBe(false);
    expect(rd.failures[0]).toBe('step 2: d=0 clk=0 → q=0, expected q=1');
  });
});

describe('starting and solving', () => {
  it('startChallenge creates the pins (inputs left, outputs right) and opens the chip', () => {
    const c = ch('s_reg4');
    const { ws, chipId, created } = startChallenge(emptyWorkspace(), c);
    expect(created).toBe(true);
    expect(chipId).toBe('u_ch_s_reg4');
    expect(challengeOf(chipId, CHALLENGES)).toBe(c);
    expect(ws.open[ws.open.length - 1]).toBe(chipId);
    const doc = ws.chips[chipId];
    expect(doc.pins.map((p) => [p.name, p.dir, p.width, p.kind ?? ''])).toEqual([
      ['d', 'in', 4, ''], ['en', 'in', 1, ''], ['clk', 'in', 1, 'clock'], ['q', 'out', 4, ''],
    ]);
    const ins = doc.pins.filter((p) => p.dir === 'in'), outs = doc.pins.filter((p) => p.dir === 'out');
    expect(Math.max(...ins.map((p) => p.at[0]))).toBeLessThan(Math.min(...outs.map((p) => p.at[0])));
    expect(doc.notes).toMatch(/^Challenge: At a rising edge of clk, q ← d/);
    // The new chip already compiles; its check fails (nothing inside) without throwing.
    const r = checkChallenge(c, new UserLibrary(ws).compiled(chipId));
    expect(r.ok).toBe(false);
    // Starting again only opens it: the learner's work stays.
    const edited: Workspace = { ...ws, chips: { ...ws.chips, [chipId]: { ...doc, parts: [part('x', { lib: 'nand' }, [6, 0])] } }, open: ['u_main'] };
    const again = startChallenge(edited, c);
    expect(again.created).toBe(false);
    expect(again.ws.chips[chipId].parts).toHaveLength(1);
    expect(again.ws.open.at(-1)).toBe(chipId);
  });

  it('the fetch challenge provides its ROM', () => {
    const { ws, chipId } = startChallenge(emptyWorkspace(), ch('c_fetch'));
    expect(ws.chips[chipId].parts.map((p) => p.id)).toEqual(['rom']);
  });

  it('solveChallenge fills the challenge chip with the answer, which then passes', () => {
    for (const id of ['g_xor', 's_dff', 'a_add4', 'c_fetch']) {
      const c = ch(id);
      const { ws, chipId } = solveChallenge(emptyWorkspace(), c);
      expect(chipId).toBe(challengeChipId(c));
      expect(ws.chips[chipId].name).toBe(c.title);
      expect(Object.keys(ws.chips).filter((k) => k.startsWith('u_ref_')).sort()).toEqual(c.answer().slice(0, -1).map((d) => d.id).sort());
      const r = checkChallenge(c, new UserLibrary(ws).compiled(chipId));
      expect(r.failures, id).toEqual([]);
      expect(r.ok, id).toBe(true);
    }
    expect(solveChallenge(emptyWorkspace(), ch('s_dff')).ws.chips.u_ch_s_dff.ff).toEqual({ d: 'd', q: 'q', clk: 'clk' });
  });

  it('importAnswer adds new chips and never overwrites the learner\'s', () => {
    const c = ch('a_add4');
    // The learner has a chip with the reference full adder's id but other content.
    const mine = chip('u_ref_fa', 'My FA', { pins: [pin('a', 'in', [0, 0])] });
    const ws0: Workspace = { ...emptyWorkspace(), chips: { ...emptyWorkspace().chips, u_ref_fa: mine } };
    const { ws, main, added } = importAnswer(ws0, c);
    expect(ws.chips.u_ref_fa).toBe(mine);
    expect(added).toEqual(['u_ref_fa_2', 'u_ref_add4']);
    expect(main).toBe('u_ref_add4');
    expect(ws.open.at(-1)).toBe('u_ref_add4');
    expect(ws.chips.u_ref_add4.parts.filter((p) => 'chip' in p.ref).map((p) => (p.ref as { chip: string }).chip)).toEqual(Array(4).fill('u_ref_fa_2'));
    // Twice: nothing new.
    expect(importAnswer(ws, c).added).toEqual([]);
  });
});
