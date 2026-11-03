// Bug hunts: every planted fault is real (the faulty chip fails the level's check), the answer passes, and the
// answer is par edits from the faulty drawing; the timing level's block passes and misses its period, its answer
// meets it at par. Edits count connectivity, not drawing.

import { describe, expect, it } from 'vitest';
import { BUG_HUNT_IDS } from '../src/campaign/bughunts';
import { ruleFor, unlockedPartCount } from '../src/campaign/graph';
import { levelChallenge } from '../src/campaign/levels';
import { nodeById } from '../src/campaign/nodes';
import { checkChallenge, libAllowed, solveChallenge, startChallenge } from '../src/editor/challenges';
import { editCount } from '../src/editor/edits';
import { UserLibrary } from '../src/editor/library';
import { type ChipDoc, emptyWorkspace } from '../src/editor/model';
import { resolveComponent } from '../src/lib/resolve';
import type { ComponentDef } from '../src/sim/types';
import { tick } from './yieldtick';

function compile(docs: ChipDoc[]) {
  const ws = emptyWorkspace();
  for (const d of docs) ws.chips[d.id] = d;
  return new UserLibrary(ws).compiled(docs[docs.length - 1].id)!;
}

describe('editCount', () => {
  const fa = resolveComponent('full_adder')!;
  const nl = fa.netlist!();
  const variant = (f: (n: typeof nl) => void): ComponentDef => {
    const copy = { ...nl, instances: nl.instances.map((i) => ({ ...i })), nets: nl.nets.map((n) => ({ ...n, ends: [...n.ends] })) };
    f(copy);
    return { ...fa, id: 'fa_variant', netlist: () => copy };
  };
  it('is 0 for the same circuit, drawn anew', () => {
    expect(editCount(fa, variant(() => {}))).toBe(0);
  });
  it('counts a pin moved to another net once', () => {
    const [n0, n1] = variant(() => {}).netlist!().nets;
    const moved = variant((c) => { const e = n1.ends[n1.ends.length - 1]; c.nets[1].ends = c.nets[1].ends.filter((x) => x !== e); c.nets[0].ends.push(e); });
    expect(n0.ends.length).toBeGreaterThan(0);
    expect(editCount(fa, moved)).toBe(1);
    expect(editCount(moved, fa)).toBe(1);
  });
  it('counts a removed part once, its pins not again', () => {
    const name = nl.instances[0].name;
    const gone = variant((c) => { c.instances = c.instances.filter((i) => i.name !== name); c.nets.forEach((n) => { n.ends = n.ends.filter((e) => !e.startsWith(`${name}.`)); }); });
    expect(editCount(fa, gone)).toBe(1);
  });
});

describe('bug hunts', () => {
  it('are optional, hang off their level and withhold its parts', () => {
    expect(BUG_HUNT_IDS).toHaveLength(13);
    for (const id of BUG_HUNT_IDS) {
      const n = nodeById(id)!;
      expect(n.optional, id).toBe(true);
      expect(n.requires, id).toEqual([n.bug!.after]);
      const rule = ruleFor(id);
      for (const w of n.withhold ?? []) if (!w.endsWith('*')) expect(libAllowed(rule, w), `${id} offers ${w}`).toBe(false);
    }
    expect(libAllowed(ruleFor('b_fa'), 'full_adder')).toBe(false);
    expect(libAllowed(ruleFor('a_add4'), 'full_adder')).toBe(true);
    // the palette counts what the rule offers: b_fa offers what a_fa did, its own unlocks withheld
    expect(unlockedPartCount(ruleFor('b_fa'))).toBe(unlockedPartCount(ruleFor('a_fa')));
  });

  for (const id of BUG_HUNT_IDS) {
    it(`${id}: the fault fails, the answer passes, par edits apart`, async () => {
      const n = nodeById(id)!, ch = levelChallenge(n)!;
      const start = ch.start!(), answer = ch.answer();
      const bad = compile(start);
      await tick();
      const rb = checkChallenge(ch, bad);
      await tick();
      const good = compile(answer);
      const rg = checkChallenge(ch, good);
      await tick();
      expect(rg.failures, `${id}: answer`).toEqual([]);
      expect(rg.ok, `${id}: answer ${rg.restrictionViolations.join('; ')}`).toBe(true);
      if (n.par?.edits !== undefined) {
        expect(rb.ok, `${id}: the faulty chip passes`).toBe(false);
        expect(rb.score.edits).toBe(0);
        expect(editCount(ch.baseline!(), good.def), id).toBe(n.par.edits);
        expect(rg.score.edits).toBe(n.par.edits);
      } else {
        expect(rb.failures, `${id}: the slow block is right`).toEqual([]);
        expect(rb.score.period!).toBeGreaterThan(n.par!.period!);
        expect(rg.score.period!).toBeLessThanOrEqual(n.par!.period!);
        expect(rg.score.nand).toBe(n.par!.nand);
      }
    }, 120_000);
  }

  it('start from the faulty drawing and are fixed in place', () => {
    const ch = levelChallenge(nodeById('b_fwd')!)!;
    const s = startChallenge(emptyWorkspace(), ch);
    const chip = s.ws.chips[s.chipId];
    expect(chip.parts.some((p) => 'chip' in p.ref && p.ref.chip === 'u_bug_b_fwd_u23')).toBe(true);
    const before = JSON.stringify(s.ws.chips.u_bug_b_fwd_u23);
    const r = solveChallenge(s.ws, ch);
    expect(JSON.stringify(r.ws.chips.u_bug_b_fwd_u23)).not.toBe(before);
    expect(checkChallenge(ch, new UserLibrary(r.ws).compiled(r.chipId)).score.edits).toBe(1);
  }, 120_000);
});
