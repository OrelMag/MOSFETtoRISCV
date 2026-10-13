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

  it('counts the scalar acts in the scalar finale and act 9 in the SIMT core', () => {
    expect(finalCpu()?.node.id).toBe('y_final');
    expect(finalCpu(nodeById('a_fa'))?.node.id).toBe('y_final');
    const k = nodeById('k_vrf')!;
    expect(finalCpu(k)?.node.id).toBe('k_simt');
    // One lane register file, one set of four lanes, one stack in the SIMT core.
    expect(copiesInFinal(k)).toBe(1);
    expect(copiesInFinal(nodeById('k_lanes')!)).toBe(1);
    expect(copiesInFinal(nodeById('k_stack')!)).toBe(1);
    expect(copiesInFinal(nodeById('k_simt')!)).toBe(0);
  });
});
