// The threads kernel (riscv/osprograms.ts kernelSource({ threads: true })) and chapter 'threads''s programs (riscv/threadprograms.ts):
// on the golden model, then on the gate-level vm CPU in lock step with it (tests/verify/vmlock.ts), every register every instruction.
import { describe, expect, it } from 'vitest';
import { OS_DMEM_K, OS_IMEM_K, osImage } from '../src/riscv/osprograms';
import { runOs } from '../src/riscv/osrun';
import { WALK_CYCLES } from '../src/riscv/vmprograms';
import { counting, prodCons, semRing, twoLocks, waiting } from '../src/riscv/threadprograms';
import { lockstep } from './verify/vmlock';
import { tick } from './yieldtick';

const SLICE = 200;
const CASES: [string, string, string][] = [
  ['the count under a lock', counting(6, { lock: true, work: 2 }), 'A 12\nall done\n'],
  ['producer and consumer on conditions', prodCons(6, 4), 'A 21\nall done\n'],
  ['the ring on two semaphores', semRing(6, 4), 'A 21\nall done\n'],
  ['sleeping on a lock', waiting(300, 'sleep'), 'A 1\nall done\n'],
  ['a deadlock', twoLocks(2), 'deadlock\n'],
];

describe('the threads kernel on the golden model', () => {
  it.each(CASES)('%s', (_id, src, want) => {
    const r = runOs(osImage([src], { threads: true, slice: SLICE }), 200000);
    expect(r.halted).toBe(true);
    expect(r.output).toBe(want);
  });

  it('a switch between two threads keeps satp: no TLB refills after it, where a process switch has them', () => {
    const r = runOs(osImage([counting(40, { lock: true })], { threads: true, slice: SLICE }), 200000);
    const switches = r.trips.filter((t) => t.from !== t.to);
    expect(switches.length).toBeGreaterThan(3);
    expect(switches.every((t) => t.userWalks === 0)).toBe(true);
  });
});

describe('the threads kernel on the gates, in lock step with the golden model', () => {
  it.each(CASES)('%s', async (_id, src, want) => {
    const img = osImage([src], { threads: true, slice: SLICE });
    const r = await lockstep(img.words, { imemK: OS_IMEM_K, dmemK: OS_DMEM_K, maxCycles: 40000, pause: tick });
    expect(r.why).toBe('');
    expect(r.halted).toBe(true);
    expect(r.iss.console).toBe(want);
    const m = runOs(img, 200000);
    expect(r.stalls).toBe(WALK_CYCLES * m.walks);
    expect(r.cycles - m.cycles).toBeGreaterThanOrEqual(0);
    expect(r.cycles - m.cycles).toBeLessThanOrEqual(8);
  }, 300_000);
});
