// The tiny operating system (riscv/osprograms.ts): its demos on the golden model, then on the gate-level vm CPU in lock step (tests/verify/vmlock.ts),
// the model-side cycle counts (riscv/osrun.ts) held to the gates' stall cycles.
import { describe, expect, it } from 'vitest';
import { ISS } from '../src/riscv/iss';
import { OS_DEMOS, OS_DMEM_K, OS_IMEM_K, ROOT_OF, VA, counter, hello, osImage, privateWord, rogueCsr, rogueLoad, rogueStore } from '../src/riscv/osprograms';
import { runOs, tripsOf } from '../src/riscv/osrun';
import { WALK_CYCLES } from '../src/riscv/vmprograms';
import { lockstep } from './verify/vmlock';
import { tick } from './yieldtick';

const WANT: Record<string, string> = {
  rogue: 'o!A killed, cause 2\nB 1\nB 2\nB 3\nall done\n',
  calls: 'HB 10\nB 20\nB 30\niall done\n',
  share: 'A 1\nA 2\nB 10\nB 20\nA 3\nB 30\nA 4\nA 5\nB 40\nB 50\nall done\n',
  wall: 'o!A killed, cause 15\n!B killed, cause 13\nall done\n',
};

describe('the kernel on the golden model', () => {
  it.each(OS_DEMOS.map((d) => [d.id, d] as const))('%s: console output and which process wrote what', (id, d) => {
    const r = runOs(osImage(d.procs, { slice: d.slice }));
    expect(r.halted).toBe(true);
    expect(r.output).toBe(WANT[id]);
  });

  it('both processes use address 0x1000 and never see each other\'s data: the words sit in different frames', () => {
    const img = osImage([privateWord(7), privateWord(9)]);
    const r = runOs(img);
    expect(r.byProc[0]).toBe('A 7\n');
    expect(r.byProc[1]).toBe('B 9\n');
    // process A's page 1 is the frame at root + 0x3000 + ... : root, leaf, page 0, page 1
    const pageOf = (root: number) => r.iss.dmem[(root + 0x3000) / 4];
    expect([pageOf(ROOT_OF[0]), pageOf(ROOT_OF[1])]).toEqual([7, 9]);
    expect(VA.data1).toBe(0x1000);
  });

  it('a process that reads a machine register, writes the kernel\'s frame or reads an unmapped page is ended; the other carries on', () => {
    const cases: [string, number][] = [[rogueCsr, 2], [rogueStore, 15], [rogueLoad, 13]];
    for (const [src, cause] of cases) {
      const r = runOs(osImage([src, counter(1, 3, 20)]));
      expect(r.halted).toBe(true);
      expect(r.output).toContain(`!A killed, cause ${cause}\n`);
      expect(r.byProc[1]).toBe('B 1\nB 2\nB 3\n');
      expect(r.output).not.toContain('X');
    }
  });

  it('the timer takes the CPU from a process that does not give it up', () => {
    const r = runOs(osImage([counter(1, 5), counter(10, 5)]));
    expect(tripsOf(r, 'timer').length).toBeGreaterThan(3);
    expect(r.byProc[0]).toBe('A 1\nA 2\nA 3\nA 4\nA 5\n');
    expect(r.byProc[1]).toBe('B 10\nB 20\nB 30\nB 40\nB 50\n');
  });

  it('yield hands the CPU over at once', () => {
    const r = runOs(osImage([hello('ab', true), hello('XY', true)]));
    expect(r.output).toBe('aXbYall done\n');
  });

  it('write prints negative numbers, zero and the largest ones', () => {
    const src = (v: number) => `  li a0, ${v}\n  li a7, 2\n  ecall\n  li a7, 93\n  ecall\n`;
    const out = [0, -1, 2147483647, -2147483648, 1000000000, 90].map((v) => runOs(osImage([src(v)])).byProc[0]);
    expect(out).toEqual(['A 0\n', 'A -1\n', 'A 2147483647\n', 'A -2147483648\n', 'A 1000000000\n', 'A 90\n']);
  });
});

describe('the kernel on the gates, in lock step with the golden model', () => {
  it.each(OS_DEMOS.map((d) => [d.id, d] as const))('%s', async (id, d) => {
    const img = osImage(d.procs, { slice: d.slice });
    const r = await lockstep(img.words, { imemK: OS_IMEM_K, dmemK: OS_DMEM_K, maxCycles: 20000, pause: tick });
    expect(r.why).toBe('');
    expect(r.halted).toBe(true);
    expect(r.iss.console).toBe(WANT[id]);
    const m = runOs(img);
    // the gates stall WALK_CYCLES per TLB miss and retire once a cycle otherwise
    expect(r.stalls).toBe(WALK_CYCLES * m.walks);
    expect(r.cycles).toBeGreaterThanOrEqual(m.cycles);
    expect(r.cycles - m.cycles).toBeLessThanOrEqual(8);
    // user mode, machine mode: both ran, and the interrupts came from the timer
    expect(r.byPriv[0]).toBeGreaterThan(0);
    expect(r.byPriv[3]).toBeGreaterThan(0);
  }, 300_000);
});
