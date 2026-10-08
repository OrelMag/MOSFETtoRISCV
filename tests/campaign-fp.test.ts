// The floating-point ladder: each rung builds one block of the binary16 adder and never may place
// that block itself; the adder, multiplier, comparator and int → float get the blocks only from the
// rungs below them (their own gifts are generic parts); the leading-zero counter's reference builds
// its halves as chips. (Every reference passing its check under its rule, at par: campaign.test.ts.)

import { describe, expect, it } from 'vitest';
import { FP_BLOCK } from '../src/campaign/buildfp';
import { ancestors, ruleFor } from '../src/campaign/graph';
import { levelChallenge } from '../src/campaign/levels';
import { nodeById } from '../src/campaign/nodes';
import { libAllowed } from '../src/editor/challenges';
import { resolveComponent } from '../src/lib/resolve';

const RUNGS: [string, string][] = [
  ['o_fpunpack', 'fpun5_10'], ['o_fpround', 'fpround'], ['o_fpsticky', 'shrs13_4'], ['o_fplzc', 'lzc16'], ['o_fpnorm', 'fpnr5_10_15'],
];

describe('the FP ladder', () => {
  it.each(RUNGS)('%s builds %s: not allowed there, unlocked after it', (id, block) => {
    expect(libAllowed(ruleFor(id), block)).toBe(false);
    const after = ['o_fpadd', 'o_fpnorm', 'o_fpcmp'].filter((n) => n !== id && ancestors(n).has(id));
    expect(after.length).toBeGreaterThan(0);
    for (const n of after) expect(libAllowed(ruleFor(n), block), `${n} may place ${block}`).toBe(true);
  });

  it('no level is given an FP block: they come from the rungs that built them', () => {
    for (const id of ['o_fpunpack', 'o_fpround', 'o_fpsticky', 'o_fplzc', 'o_fpnorm', 'o_fpadd', 'o_fpmul', 'o_fpcmp', 'o_fpcvt']) {
      const n = nodeById(id)!;
      expect(n.givesOf!().filter((g) => FP_BLOCK.test(g)), id).toEqual([]);
    }
    for (const b of ['fpun5_10', 'shrs13_4', 'fpnr5_10_15']) expect(libAllowed(ruleFor('o_fpadd'), b)).toBe(true);
    expect(libAllowed(ruleFor('o_fpmul'), 'fpnr5_10_22')).toBe(true);
    expect(libAllowed(ruleFor('o_fpcvt'), 'fpnr5_10_16')).toBe(true);
  });

  it('the leading-zero counter is built recursively: its halves are chips of the answer', () => {
    const chips = levelChallenge(nodeById('o_fplzc')!)!.answer();
    expect(chips.map((c) => c.name)).toEqual(['2-bit leading-zero count ref', '4-bit leading-zero count ref', '8-bit leading-zero count ref', 'Leading-zero counter ref']);
    const top = chips[chips.length - 1];
    expect(top.parts.filter((p) => 'chip' in p.ref).length).toBe(2);
    expect(top.parts.some((p) => 'lib' in p.ref && p.ref.lib.startsWith('lzc'))).toBe(false);
  });

  it('the unlocked blocks resolve by id on a fresh page (generator patterns)', () => {
    for (const id of ['shrs13_4', 'shrs22_5', 'shl15_4', 'incf8', 'fpun5_10', 'fpnr5_10_22', 'fpcvt5_10_16', 'fpround']) expect(resolveComponent(id)?.id, id).toBe(id);
  });
});
