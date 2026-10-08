// The core bench: every test program is valid (halts, never reads an unwritten register), the
// reference cores pass, a core missing hardware fails with a message naming the instruction, and
// the bit-parallel bench agrees with the event-driven one.

import { describe, expect, it } from 'vitest';
import { corePeriod, golden, runCore } from '../src/campaign/corecheck';
import { coreTests } from '../src/campaign/coretests';
import '../src/lib';
import { rv16Core } from '../src/lib/rv16/cpu';
import { randomProgram } from '../src/riscv/rv16/randprog';

describe('core test programs', () => {
  it('every directed and random program halts on the golden model with strict initialisation', () => {
    for (const st of [1, 2, 3] as const) for (const t of coreTests(st)) expect(() => golden(t, {}), t.name).not.toThrow();
    for (const level of [1, 2, 3] as const) {
      for (let seed = 1; seed <= 60; seed++) {
        const src = randomProgram(seed, level);
        expect(randomProgram(seed, level)).toBe(src);
        expect(() => golden({ name: `${level}.${seed}`, src }, {}), src).not.toThrow();
      }
    }
  });
});

describe('the core bench', () => {
  const tests = (st: 1 | 2 | 3) => ({ tests: () => coreTests(st), budget: { cpi: 1, extra: 2 } });

  it('the reference single-cycle cores pass every stage they implement', () => {
    for (const st of [1, 2] as const) expect(runCore(rv16Core(false), 'gate', tests(st)).failures).toEqual([]);
    const r = runCore(rv16Core(true), 'gate', tests(3));
    expect(r.failures).toEqual([]);
    expect(r.tested).toBe(coreTests(3).length);
    expect(r.cycles).toBeGreaterThan(500);
  });

  it('a core without branch hardware fails the control-flow programs, naming the instruction', () => {
    const r = runCore(rv16Core(false), 'gate', tests(3));
    expect(r.failures.length).toBeGreaterThan(0);
    expect(r.failures.join('\n')).toMatch(/expected .* from "(beq|bne|blt|bge|jal|j|call)/);
  });

  it('a core over its cycle budget is reported', () => {
    const r = runCore(rv16Core(true), 'gate', { tests: () => coreTests(3).slice(0, 2), budget: { cpi: 0.5, extra: 0 } });
    expect(r.failures.join('\n')).toMatch(/budget|only/);
  });

  it('the event-driven bench agrees with the bit-parallel one', () => {
    const spec = { tests: () => coreTests(3).slice(0, 4), budget: { cpi: 1, extra: 2 } };
    const a = runCore(rv16Core(true), 'gate', spec), b = runCore(rv16Core(true), 'gate', spec, 'gate');
    expect(b).toEqual(a);
  });

  it('measures the period with the memories in the path', () => {
    const p = corePeriod(rv16Core(true))!;
    expect(p).toBeGreaterThan(60);
    expect(corePeriod(rv16Core(true, true))!).toBeLessThan(p);
  });
});

describe('the pipeline levels', () => {
  it('each mechanism is needed: without it, the next level\'s programs fail', async () => {
    const { rv16Pipe } = await import('../src/lib/rv16/pipe');
    const { pipeTests } = await import('../src/campaign/coretests');
    const run = (o: { fwd: boolean; stall: boolean; flush: boolean }, st: 1 | 2 | 3) =>
      runCore(rv16Pipe(o), 'gate', { tests: () => pipeTests(st).slice(0, 8), budget: { cpi: 2.5, extra: 10 } });
    expect(run({ fwd: false, stall: false, flush: false }, 1).failures.length).toBeGreaterThan(0);
    expect(run({ fwd: true, stall: false, flush: false }, 2).failures.length).toBeGreaterThan(0);
    expect(run({ fwd: true, stall: true, flush: false }, 3).failures.length).toBeGreaterThan(0);
    expect(run({ fwd: true, stall: true, flush: true }, 3).failures).toEqual([]);
  });
});

describe('the side-quest cores', () => {
  it('MD, prediction and loop programs halt on the golden model with strict initialisation', async () => {
    const { mdTests, predictTests } = await import('../src/campaign/coretests');
    for (const t of mdTests('all')) expect(() => golden(t, { m: true }), t.name).not.toThrow();
    for (const t of predictTests()) expect(() => golden(t, {}), t.name).not.toThrow();
    for (let seed = 1; seed <= 30; seed++) for (const md of ['mul', 'all'] as const) {
      const src = randomProgram(seed, 3, 30, md);
      expect(() => golden({ name: `${md}.${seed}`, src }, { m: true }), src).not.toThrow();
    }
    // The MD option leaves the other levels' programs unchanged.
    expect(randomProgram(5, 3)).toBe(randomProgram(5, 3, 40, undefined));
  });

  it('multiplies need the multiplier, divides the divider and its stall', async () => {
    const { mdTests } = await import('../src/campaign/coretests');
    const mul = { tests: () => mdTests('mul'), budget: { cpi: 1, extra: 2 }, m: true };
    const all = { tests: () => mdTests('all'), budget: { cpi: 20, extra: 20 }, m: true };
    expect(runCore(rv16Core(true), 'gate', mul).failures.join('\n')).toMatch(/from "mul/);
    expect(runCore(rv16Core(true, false, 'mul'), 'gate', mul).failures).toEqual([]);
    expect(runCore(rv16Core(true, false, 'mul'), 'gate', all).failures.join('\n')).toMatch(/from "(div|rem)/);
    expect(runCore(rv16Core(true, false, 'div'), 'gate', all).failures).toEqual([]);
  });

  it('the divide core agrees on both benches', async () => {
    const { mdTests } = await import('../src/campaign/coretests');
    const spec = { tests: () => mdTests('all').slice(0, 2), budget: { cpi: 20, extra: 20 }, m: true };
    const a = runCore(rv16Core(true, false, 'div'), 'gate', spec), b = runCore(rv16Core(true, false, 'div'), 'gate', spec, 'gate');
    expect(b.failures).toEqual([]);
    expect(b.cycles).toBe(a.cycles);
  });

  it('the multicycle core takes 3 to 4 cycles per instruction at a shorter period', async () => {
    const { RV16_MULTI } = await import('../src/lib/rv16/multi');
    const spec = { tests: () => coreTests(3), budget: { cpi: 1, extra: 2 } };
    const one = runCore(rv16Core(true), 'gate', spec);
    const mc = runCore(RV16_MULTI, 'gate', { ...spec, budget: { cpi: 4, extra: 4 } });
    expect(mc.failures).toEqual([]);
    expect(mc.cycles!).toBeGreaterThan(3 * one.cycles!);
    expect(mc.cycles!).toBeLessThan(4 * one.cycles!);
    expect(corePeriod(RV16_MULTI)!).toBeLessThan(corePeriod(rv16Core(true))!);
  });

  it('branch prediction saves cycles on loops: without it the level misses par', async () => {
    const { predictTests } = await import('../src/campaign/coretests');
    const { rv16Pipe } = await import('../src/lib/rv16/pipe');
    const { nodeById } = await import('../src/campaign/nodes');
    const spec = { tests: predictTests, budget: { cpi: 3, extra: 8 } };
    const plain = runCore(rv16Pipe({ fwd: true, stall: true, flush: true }), 'gate', spec);
    const pred = runCore(rv16Pipe({ fwd: true, stall: true, flush: true, predict: true }), 'gate', spec);
    expect(plain.failures).toEqual([]);
    expect(pred.failures).toEqual([]);
    expect(pred.cycles!).toBeLessThan(plain.cycles! * 0.9);
    expect(plain.cycles!).toBeGreaterThan(nodeById('o_bpred')!.par!.cycles!);
  });
});
