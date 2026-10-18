// Build along: a learner's step is matched to the reference by kind and place, then by the ports each net joins, so
// their own part names and wire shapes pass and a missing part or wire does not.

import { describe, expect, it } from 'vitest';
import { checkBuild, matchParts, snapCandidate } from '../src/campaign/buildalong';
import { nodeById } from '../src/campaign/nodes';
import { partialDoc, walkOf } from '../src/campaign/walk';
import { compileChip } from '../src/editor/compile';
import type { ChipDoc } from '../src/editor/model';
import { partDef } from '../src/editor/parts';

const nets = (d: ChipDoc) => compileChip(d, (r) => partDef(r, () => undefined)).netOfEnd;
/** The same chip with every part renamed: what a learner who named things differently would draw. */
const renamed = (d: ChipDoc): ChipDoc => {
  let s = JSON.stringify(d);
  for (const p of d.parts) s = s.replaceAll(`"part":"${p.id}"`, `"part":"mine_${p.id}"`).replaceAll(`"id":"${p.id}"`, `"id":"mine_${p.id}"`);
  return JSON.parse(s) as ChipDoc;
};

describe('build along', () => {
  const w = walkOf(nodeById('g_xor')!)!;
  const k = 1; // after "a and not b"
  const ref = partialDoc(w, k);

  it('accepts the step built under other names', () => {
    const mine = renamed(ref);
    expect(matchParts(ref, mine).size).toBe(ref.parts.length);
    const r = checkBuild(ref, nets(ref), mine, nets(mine));
    expect(r).toMatchObject({ ok: true, missing: [], wiring: [], extra: [] });
  });

  it('names a part not yet on its outline', () => {
    const step = w.steps[k].parts[0];
    const mine = { ...ref, parts: ref.parts.filter((p) => p.id !== step), wires: ref.wires.filter((x) => !JSON.stringify(x).includes(`"part":"${step}"`)) };
    const r = checkBuild(ref, nets(ref), mine, nets(mine));
    expect(r.ok).toBe(false);
    expect(r.missing.map((p) => p.id)).toEqual([step]);
  });

  it('names a port wired differently', () => {
    const step = w.steps[k].parts[0];
    const cut = ref.wires.find((x) => JSON.stringify(x).includes(`"part":"${step}"`))!;
    const mine = { ...ref, wires: ref.wires.filter((x) => x !== cut) };
    const r = checkBuild(ref, nets(ref), mine, nets(mine));
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual([]);
    expect(r.wiring.length).toBeGreaterThan(0);
  });

  it('snaps a part dropped near its outline, not one far away', () => {
    const guide = ref.parts.find((p) => p.id === w.steps[k].parts[0])!;
    const near = { ...ref, parts: [...ref.parts.filter((p) => p.id !== guide.id), { ...guide, id: 'x', at: [guide.at[0] + 1, guide.at[1] + 2] as [number, number] }] };
    expect(snapCandidate([guide], near)).toEqual({ id: 'x', at: guide.at, flip: !!guide.flip });
    const far = { ...near, parts: near.parts.map((p) => (p.id === 'x' ? { ...p, at: [guide.at[0] + 9, guide.at[1]] as [number, number] } : p)) };
    expect(snapCandidate([guide], far)).toBeNull();
  });
});
