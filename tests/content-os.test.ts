// Chapter 'os': every number its prose quotes is measured on the golden model running the kernel; pinned here, and the images they come from are
// run on the gates in lock step so the model's cycle counts are the gates' (a stall cycle for every TLB miss, a cycle for every step).
import { describe, expect, it } from 'vitest';
import { chOs, osFigures } from '../src/chapters/ch-os';
import { counter, hello, OS_DMEM_K, OS_IMEM_K, osImage, spinner2 } from '../src/riscv/osprograms';
import { booted, captureSwitch, planOf, runOs, tripsOf } from '../src/riscv/osrun';
import { WALK_CYCLES } from '../src/riscv/vmprograms';
import { SLICES, overheadTable } from '../src/widgets/os';
import { lockstep } from './verify/vmlock';
import { tick } from './yieldtick';

const exitNow = '  li a7, 93\n  ecall\n';
const writeOnce = (v: number) => `  li a0, ${v}\n  li a7, 2\n  ecall\n${exitNow}`;
const yieldOnce = `  li a7, 3\n  ecall\n${exitNow}`;

describe('the figures the chapter quotes', () => {
  it('kernel size, one switch, the system calls, the timer, the plan, the Python pair', () => {
    expect(osFigures()).toEqual({
      kernelWords: 361, kernelBytes: 1444,
      saveInstr: 37, chooseInstr: 23, restoreInstr: 38, switchInstr: 99, switchCycles: 102, switchStall: 3,
      putchar: 84, write1: 171, write5: 219, writeMax: 360, yieldTrip: 109, exitTrip: 114, tickStays: 97, tickSwitches: 98,
      refillWalks: 2, sliceUser: 542, bootInstr: 123,
      slice: 600, overhead: 16, overheadShort: 70.8, overheadLong: 0.8,
      frames: 16, usedFrames: 9,
      py: { a: 'fibloop', b: 'squares', steps: 5874, cycles: 5928, switches: 8, outA: 15, outB: 10, calls: 25 },
      nands: 79701,
    });
  });

  it('the slice table: the cost falls as the slice grows, and the same table is what the widget shows', () => {
    const t = overheadTable();
    expect(t.map((r) => r.slice)).toEqual(SLICES);
    expect(t.map((r) => Math.round(r.overhead * 1000) / 10)).toEqual([70.8, 42, 23.1, 12.1, 6.2, 3.2, 1.6, 0.8]);
    expect(t.map((r) => r.switches)).toEqual([284, 166, 90, 47, 24, 12, 6, 3]);
    for (let i = 1; i < t.length; i++) expect(t[i].overhead).toBeLessThan(t[i - 1].overhead);
  });

  it('a switch is the interrupt, then 36 stores of the save block, and the phases add up', () => {
    const f = captureSwitch(osImage([counter(1, 6), counter(10, 6)]));
    expect(f.length).toBe(osFigures().switchInstr);
    expect(f.filter((x) => x.phase === 'save').length + f.filter((x) => x.phase === 'choose').length + f.filter((x) => x.phase === 'restore').length + 1).toBe(f.length);
    // one cycle a step, and the walk that fetches B's first instruction
    expect(f[f.length - 1].cycles).toBe(f.length + WALK_CYCLES);
    // A's registers end up in A's block and come out of B's into the CPU: the CPU's s0 (x8) is B's 0x1000 at the end, A's block holds A's
    const last = f[f.length - 1];
    expect(last.regs[8]).toBe(0x1000);
    expect(last.pcb[0][0]).not.toBe(0);
  });

  it('the plan is read from the page tables the boot code built', () => {
    const plan = planOf(osImage([counter(1, 1), counter(1, 1)]));
    expect(plan.dataFrames.filter((x) => x.owner === 0)).toHaveLength(4);
    expect(plan.dataFrames.filter((x) => x.owner === 1)).toHaveLength(4);
    expect(plan.dataFrames[0].owner).toBe(2);
    expect(plan.maps.map((m) => m.map((r) => r.va))).toEqual([[0, 0x1000, 0x2000, 0x4000], [0, 0x1000, 0x2000, 0x4000]]);
    expect(plan.maps[0].map((r) => r.flags)).toEqual(['VRW·U·AD', 'VRW·U·AD', 'VRW···AD', 'VR·XU·A·']);
    expect(plan.maps[0].find((r) => r.va === 0x1000)!.pa).not.toBe(plan.maps[1].find((r) => r.va === 0x1000)!.pa);
    expect(plan.satp.map((s) => s >>> 31)).toEqual([1, 1]);
    expect(booted(osImage([counter(1, 1), counter(1, 1)])).priv).toBe(0);
  });
});

describe('the model\'s cycles are the gates\'', () => {
  const images: [string, string[], number][] = [
    ['two counters (the switch, the writes, the timer)', [counter(1, 6), counter(10, 6)], 30000],
    ['putchar', [hello('x'), exitNow], 4000],
    ['write of the largest number', [writeOnce(-2147483648), exitNow], 4000],
    ['yield', [yieldOnce, counter(1, 3)], 8000],
  ];
  it.each(images)('%s', async (_, procs, max) => {
    const img = osImage(procs);
    const r = await lockstep(img.words, { imemK: OS_IMEM_K, dmemK: OS_DMEM_K, maxCycles: max, pause: tick });
    expect(r.why).toBe('');
    expect(r.halted).toBe(true);
    const m = runOs(img);
    expect(r.stalls).toBe(WALK_CYCLES * m.walks);
    expect(r.stallRuns).toEqual({ [WALK_CYCLES]: m.walks });
    // the model's steps are the gates' retirements one for one
    expect(r.steps - m.steps).toBeLessThanOrEqual(8);
  }, 300_000);

  it('a timer interrupt that finds nobody else to run (the spinner alone, the other process gone)', async () => {
    const img = osImage([spinner2, exitNow]);
    const r = await lockstep(img.words, { imemK: OS_IMEM_K, dmemK: OS_DMEM_K, maxCycles: 2500, pause: tick });
    expect(r.why).toBe('');
    const m = runOs(img, r.steps);
    expect(Math.abs(r.stalls - WALK_CYCLES * m.walks)).toBeLessThanOrEqual(2);
    expect(tripsOf(m, 'timer').some((t) => t.from === t.to && t.kernelCycles === osFigures().tickStays)).toBe(true);
  }, 300_000);
});

describe('the chapter', () => {
  it('has eight steps, a quiz on each, a recap of three checks, and no unfilled number', () => {
    expect(chOs.steps).toHaveLength(8);
    for (const s of chOs.steps) {
      expect(s.challenge?.kind).toBe('quiz');
      expect(s.body).not.toMatch(/NaN|undefined|\[object/);
    }
    expect(chOs.recap?.check).toHaveLength(3);
    expect(chOs.recap?.keep.join(' ')).not.toMatch(/NaN|undefined|\[object/);
  });
});
