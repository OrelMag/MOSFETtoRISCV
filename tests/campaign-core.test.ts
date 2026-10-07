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
