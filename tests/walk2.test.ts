// Walk 2.0: an alternative named by a walk step is a real library part (its cost is measured on screen); the rows a
// step gets right are listed row by row as well as counted; taking a step out of the finished circuit breaks exactly
// the outputs that step serves.

import { describe, expect, it } from 'vitest';
import { nodeById } from '../src/campaign/nodes';
import { levelChallenge } from '../src/campaign/levels';
import { stepMetrics, walkOf, withoutStep } from '../src/campaign/walk';
import { WALKS } from '../src/campaign/walks';
import '../src/lib';
import { registry } from '../src/lib/define';

describe('walk 2.0', () => {
  it('every alternative is a registered part', () => {
    for (const [id, script] of Object.entries(WALKS)) for (const s of script) {
      if (s.whyNot?.alt) expect(registry.get(s.whyNot.alt), `${id} / ${s.title}: ${s.whyNot.alt}`).toBeTruthy();
      if (s.whyNot) expect(s.whyNot.text.length, `${id} / ${s.title}`).toBeGreaterThan(30);
    }
  });

  it('rows are listed as well as counted', () => {
    const node = nodeById('a_fa')!, w = walkOf(node)!, ch = levelChallenge(node)!;
    for (let k = 0; k < w.steps.length; k++) {
      for (const r of stepMetrics(w, k, ch).rows!) expect(r.ok!.filter(Boolean).length).toBe(r.right);
    }
  });

  it('without the carry step only cout breaks; without the second XOR only s', () => {
    const node = nodeById('a_fa')!, w = walkOf(node)!, ch = levelChallenge(node)!;
    const at = (title: string) => w.steps.findIndex((s) => s.title === title);
    const carry = withoutStep(w, at('The carry'), ch)!;
    expect(carry.find((r) => r.out === 'cout')!.wrong).toBeGreaterThan(0);
    const xor2 = withoutStep(w, at('Second XOR'), ch)!;
    expect(xor2.find((r) => r.out === 's')!.wrong).toBeGreaterThan(0);
    expect(xor2.find((r) => r.out === 'cout')!.wrong).toBe(0);
  });
});
