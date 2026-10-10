// What the level screen measures besides Check: library parts' cost and the copies of a level's
// part in the finished CPU.

import { describe, expect, it } from 'vitest';
import { copiesInFinal, countedPart, finalCpu, libCost } from '../src/campaign/measure';
import { nodeById } from '../src/campaign/nodes';

describe('level screen measurements', () => {
  it('measures library parts', () => {
    expect(libCost('full_adder')).toEqual({ nand: 9, transistors: 36, depth: 6 });
    expect(libCost('no_such_part')).toBeUndefined();
  });

  it('counts a level\'s part in the finished CPU', () => {
    const cpu = finalCpu();
    expect(cpu?.node.kind).toBe('core');
    const fa = nodeById('a_fa')!;
    expect(countedPart(fa)?.id).toBe('full_adder');
    expect(copiesInFinal(fa)).toBeGreaterThanOrEqual(16);
    // The finished CPU's own level counts nothing (it is the CPU).
    expect(copiesInFinal(cpu!.node)).toBe(0);
  });
});
