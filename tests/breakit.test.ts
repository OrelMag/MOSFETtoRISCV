// Break-it levels (campaign/breakit.ts, docs/PLAN-ONI.md D2): every planted fault sits on a net of the drawing's top
// level and shows (Check fails with it, passes without), the accusation rule (symptomsDiffer: the same outputs on every
// case; the CPU bench: the same net), and the stars a wrong accusation costs.
import { describe, expect, it } from 'vitest';
import { BREAK_IT_IDS } from '../src/campaign/breakit';
import { DEBUG_ACT } from '../src/campaign/bughunts';
import { stars } from '../src/campaign/grade';
import { levelChallenge } from '../src/campaign/levels';
import { nodeById } from '../src/campaign/nodes';
import { checkChallenge, plantedFaults, plantedNets, symptomsDiffer } from '../src/editor/challenges';
import { UserLibrary } from '../src/editor/library';
import { type ChipDoc, emptyWorkspace } from '../src/editor/model';
import type { FlatFault } from '../src/sim/faults';
import { findNode, flatten } from '../src/sim/flatten';
import { tick } from './yieldtick';

function compile(docs: ChipDoc[]) {
  const ws = emptyWorkspace();
  for (const d of docs) ws.chips[d.id] = d;
  return new UserLibrary(ws).compiled(docs[docs.length - 1].id)!;
}

const level = (id: string) => {
  const n = nodeById(id)!;
  const ch = levelChallenge(n)!;
  const c = compile(ch.start!());
  return { n, ch, c, d: flatten(c.def, { mode: c.mode }) };
};

describe('break-it levels', () => {
  it('are four, in the Debugging act, each FIND IT and graded on wrong accusations alone', () => {
    expect(BREAK_IT_IDS).toHaveLength(4);
    for (const id of BREAK_IT_IDS) {
      const n = nodeById(id)!;
      expect(n.act).toBe(DEBUG_ACT);
      expect(n.optional).toBe(true);
      expect(n.bug?.find).toBe(true);
      expect(n.par).toEqual({ wrong: 0 });
      expect(n.requires).toEqual([n.bug!.after]);
    }
  });

  for (const id of BREAK_IT_IDS) {
    it(`${id}: the fault sits on a top-level net of the drawing, Check fails with it and the drawing passes without it`, async () => {
      const { ch, c, d } = level(id);
      expect(ch.planted).toHaveLength(1);
      const p = ch.planted![0];
      const nets = plantedNets(d.root, p);
      expect(nets, `${id}: ${p.end}`).not.toBeNull();
      // a top-level wire: the part is a child of the chip itself, so the brush can click it
      expect(findNode(d.root, [p.end.split('.')[0]])?.parent).toBe(d.root);
      await tick();
      const r = checkChallenge(ch, c);
      expect(r.ok).toBe(false);
      expect(r.failures.length).toBeGreaterThan(0);
      // a real failing case, not the masked-fault guard
      expect(r.failures.join(' ')).not.toMatch(/masked/);
      await tick();
      const healthy = checkChallenge({ ...ch, planted: undefined }, c);
      expect(healthy.ok, healthy.failures.join('; ')).toBe(true);
    }, 120_000);
  }
});

describe('the accusation rule', () => {
  it('the planted fault itself, or another name for its net, is right; a neighbouring net is not, with the case that tells them apart', () => {
    const { ch, c, d } = level('x_add4');
    const planted = plantedFaults(d.root, ch.planted!);
    expect(symptomsDiffer(ch, c.def, c.mode, planted, planted)).toBeNull();
    // fa1's carry out is the same net as fa2's carry in
    const sameNet: FlatFault[] = [{ kind: 'stuck0', nets: [...findNode(d.root, ['fa1'])!.ports.cout] }];
    expect(symptomsDiffer(ch, c.def, c.mode, sameNet, planted)).toBeNull();
    const wrongValue: FlatFault[] = [{ kind: 'stuck1', nets: planted[0].nets }];
    const v = symptomsDiffer(ch, c.def, c.mode, wrongValue, planted);
    expect(v).not.toBeNull();
    expect(v!.index).toBeGreaterThanOrEqual(0);
    expect(v!.text).toMatch(/against/);
    const neighbour: FlatFault[] = [{ kind: 'stuck0', nets: [...findNode(d.root, ['fa1'])!.ports.cin] }];
    expect(symptomsDiffer(ch, c.def, c.mode, neighbour, planted)).not.toBeNull();
  });

  it('a sequence: compares every step', () => {
    const { ch, c, d } = level('x_cnt');
    const planted = plantedFaults(d.root, ch.planted!);
    expect(symptomsDiffer(ch, c.def, c.mode, planted, planted)).toBeNull();
    const other: FlatFault[] = [{ kind: 'stuck0', nets: [findNode(d.root, ['reg'])!.ports.d[1]] }];
    expect(symptomsDiffer(ch, c.def, c.mode, other, planted)).not.toBeNull();
  });

  it('the CPU bench: only the same net and kind', () => {
    const { ch, c, d } = level('x_core');
    const planted = plantedFaults(d.root, ch.planted!);
    expect(symptomsDiffer(ch, c.def, c.mode, planted, planted)).toBeNull();
    expect(symptomsDiffer(ch, c.def, c.mode, [{ kind: 'stuck0', nets: planted[0].nets }], planted)?.index).toBe(-1);
  });
});

describe('stars', () => {
  it('a wrong accusation costs a star', () => {
    expect(stars({ wrong: 0 }, { wrong: 0 })).toBe(3);
    expect(stars({ wrong: 1 }, { wrong: 0 })).toBe(2);
    expect(stars({ wrong: 2 }, { wrong: 0 })).toBe(1);
    expect(stars({ wrong: 9 }, { wrong: 0 })).toBe(1);
  });
});
