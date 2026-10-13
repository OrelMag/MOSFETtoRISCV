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

  it('counts the scalar acts in the scalar finale and act 9 in the two-warp core', () => {
    expect(finalCpu()?.node.id).toBe('y_final');
    expect(finalCpu(nodeById('a_fa'))?.node.id).toBe('y_final');
    const k = nodeById('k_vrf')!;
    expect(finalCpu(k)?.node.id).toBe('k_warps');
    // Per warp a lane register file, a mask and a stack; one set of four lanes, shared.
    expect(copiesInFinal(k)).toBe(2);
    expect(copiesInFinal(nodeById('k_mask')!)).toBe(2);
    expect(copiesInFinal(nodeById('k_stack')!)).toBe(2);
    expect(copiesInFinal(nodeById('k_lanes')!)).toBe(1);
    expect(copiesInFinal(nodeById('k_simt')!)).toBe(0);
    expect(copiesInFinal(nodeById('k_coal')!)).toBe(0);
    // act 9 is optional as a whole: its finale is still found
    expect(['k_lesson', 'k_lanes', 'k_simt', 'k_coal', 'k_warps', 'p_hist', 'k_frame'].every((id) => nodeById(id)!.optional)).toBe(true);
  });
});
