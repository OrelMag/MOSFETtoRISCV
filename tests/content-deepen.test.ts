// Chapters 19, 20, 34 and 37 deepened: the numbers the new steps quote are measured here, and the prose carries them.

import { describe, expect, it } from 'vitest';
import { chFlash } from '../src/chapters/ch-flash';
import { chGfxPipeline } from '../src/chapters/ch-gfx';
import { ioProbe, latchedPulse } from '../src/chapters/ch-system-more';
import { chIO, chTraps } from '../src/chapters/ch-system';
import { bchParity, codewordFail, maxRber } from '../src/flash/ecc';
import { assemble } from '../src/riscv/asm';
import { ISS } from '../src/riscv/iss';
import { crossover, runPollIrq } from '../src/riscv/pollirq';
import { SYSTEM_PROGRAMS } from '../src/riscv/sysprograms';

const flat = (s: string) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
const step = (c: { steps: { title: string; body: string }[] }, t: string) => c.steps.find((s) => s.title === t)!;

describe('chapter 20: polling against interrupts, measured on the golden model', () => {
  it('the crossings quoted in the text', () => {
    expect([2, 6, 14, 30].map((w) => crossover(w))).toEqual([18, 30, 60, 110]);
    expect(flat(step(chTraps, 'Polling or interrupting').body)).toContain('every 30 cycles');
  });
  it('latency and the asymptotes', () => {
    const p = runPollIrq('poll', 40, 6, 6000), i = runPollIrq('irq', 40, 6, 6000);
    expect([p.worst, i.worst]).toEqual([10, 2]);
    expect(p.served).toBe(i.served);
    const pl = runPollIrq('poll', 2000, 6, 6000), il = runPollIrq('irq', 2000, 6, 6000);
    expect(pl.work / pl.cycles).toBeCloseTo(0.75, 2);
    expect(il.work / il.cycles).toBeCloseTo(6 / 7, 2);
    expect(runPollIrq('irq', 20, 6, 6000).work).toBeLessThan(runPollIrq('poll', 20, 6, 6000).work);
  });
  it('the nested program counts a press taken inside the slow handler', () => {
    const iss = new ISS(assemble(SYSTEM_PROGRAMS.find((p) => p.id === 'nested')!.source).words, { system: true, mmio: true } as never);
    for (let c = 0; c < 160; c++) { iss.irq = c === 60; iss.step(); }
    expect([iss.x[20], iss.x[21], iss.x[9]]).toEqual([1, 1, 1]); // s4 presses, s5 nested ones, s1 ticks
    expect(iss.x[8]).toBeGreaterThan(0);
  });
  it('the latched request is served once, after the handler', () => {
    expect(latchedPulse()).toEqual({ bareServed: false, servedAt: 9, pendingFrom: 4 });
    expect(flat(step(chTraps, 'A request that waits').body)).toContain('claimed at cycle 9, 6 cycles after the pulse');
  });
});

describe('chapter 19: the clock and I/O registers', () => {
  it('the dot comes 3 cycles after the deadline', () => {
    const iss = new ISS(assemble(SYSTEM_PROGRAMS.find((p) => p.id === 'poll')!.source).words, { system: true, mmio: true } as never);
    let at = -1;
    for (let c = 0; c < 60 && at < 0; c++) { const m = iss.mtime; iss.step(); if (iss.console.length) at = m; }
    expect(at - 41).toBe(3);
  });
  it('an I/O register takes the replicated word', () => {
    expect(ioProbe('sb', 0x2a, 20).cmp).toBe(0x2a2a2a2a);
    expect(ioProbe('sh', 0x1234, 20).cmp).toBe(0x12341234);
    expect(ioProbe('sw', 0x1234, 20).cmp).toBe(0x1234);
    expect(ioProbe('sb', 0xab, 5).leds).toBe(0xab);
    expect(flat(step(chIO, 'Registers with side effects').body)).toContain('0x12341234');
  });
});

describe('chapter 37: ECC', () => {
  it('BCH parity and the correctable RBER', () => {
    expect([1, 8, 40].map((t) => bchParity(8192, t))).toEqual([14, 112, 560]);
    expect(maxRber(8192, 8)).toBeGreaterThan(2e-5);
    expect(maxRber(8192, 8)).toBeLessThan(4e-5);
    expect(maxRber(8192, 40)).toBeGreaterThan(1e-3);
    const n = 8192 + bchParity(8192, 8);
    expect(codewordFail(n, 8, 1e-5)).toBeLessThan(1e-15);
    expect(codewordFail(n, 8, 1e-3)).toBeGreaterThan(0.3);
    // brute-force check of the tail at a small size: n = 20, t = 1, p = 0.1
    let direct = 0;
    for (let i = 2; i <= 20; i++) { let c = 1; for (let k = 1; k <= i; k++) c = (c * (20 - k + 1)) / k; direct += c * 0.1 ** i * 0.9 ** (20 - i); }
    expect(codewordFail(20, 1, 0.1)).toBeCloseTo(direct, 10);
    expect(flat(step(chFlash, 'Bit errors and ECC').body)).toContain('280 bytes');
  });
});

describe('chapter 34: texturing', () => {
  it('the mip chain is 4/3 of the image', () => {
    const t = flat(step(chGfxPipeline, 'Texturing').body);
    expect(t).toContain('87 381 bytes');
    expect(t).toContain('1.333');
  });
});
