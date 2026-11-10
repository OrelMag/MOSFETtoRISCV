// Chapter 15's compiler targeting the kernel (compilePy { user: true }): two Python programs as processes, the output of each equal to the
// interpreter's (src/lang/interp.ts runPy), on the golden model and on the gates in lock step.
import { describe, expect, it } from 'vitest';
import { compilePy } from '../src/lang/compile';
import { runPy } from '../src/lang/interp';
import { PY_PROGRAMS } from '../src/lang/pyprograms';
import { OS_DMEM_K, OS_IMEM_K, PY_DMEM_WORDS, osImage } from '../src/riscv/osprograms';
import { runOs } from '../src/riscv/osrun';
import { lockstep } from './verify/vmlock';
import { tick } from './yieldtick';

const src = (id: string) => PY_PROGRAMS.find((p) => p.id === id)!.source;
const asProcess = (id: string) => {
  const c = compilePy(src(id), { dmemWords: PY_DMEM_WORDS, user: true });
  expect(c.error).toBeNull();
  return c.asm;
};
/** The numbers a process wrote, from its lines "A 55". */
const numbers = (text: string) => text.split('\n').filter(Boolean).map((l) => Number(l.slice(2)));

describe('Python programs as processes', () => {
  it('print becomes the write call and the end of the program exit; the data stays in the process\'s two pages', () => {
    const c = compilePy(src('sum'), { dmemWords: PY_DMEM_WORDS, user: true });
    expect(c.asm).toMatch(/li   a7, 2\n\s+ecall/);
    expect(c.asm).toMatch(/li   a7, 93\n\s+ecall/);
    expect(c.asm).not.toMatch(/\(gp\)/);
  });

  it.each([['fibloop', 'squares'], ['sum', 'collatz'], ['primes', 'mul'], ['gcd', 'insertion']])('%s and %s share the CPU, each prints what runPy says', (a, b) => {
    const r = runOs(osImage([asProcess(a), asProcess(b)]), 400000);
    expect(r.halted).toBe(true);
    expect(numbers(r.byProc[0])).toEqual(runPy(src(a)).output);
    expect(numbers(r.byProc[1])).toEqual(runPy(src(b)).output);
  });

  it('a program that prints strings: the characters come out one number each, as runPy\'s output', () => {
    const s = 'print("hi")\nprint(7)\n';
    const c = compilePy(s, { dmemWords: PY_DMEM_WORDS, user: true });
    expect(c.error).toBeNull();
    const r = runOs(osImage([c.asm, asProcess('sum')]), 100000);
    expect(numbers(r.byProc[0])).toEqual(runPy(s).output);
  });

  it('on the gates, in lock step with the golden model', async () => {
    const img = osImage([asProcess('fibloop'), asProcess('squares')]);
    const r = await lockstep(img.words, { imemK: OS_IMEM_K, dmemK: OS_DMEM_K, maxCycles: 40000, pause: tick });
    expect(r.why).toBe('');
    expect(r.halted).toBe(true);
    const m = runOs(img);
    expect(r.iss.console).toBe(m.output);
    expect(r.stalls).toBe(3 * m.walks);
    expect(numbers(m.byProc[0])).toEqual(runPy(src('fibloop')).output);
    expect(numbers(m.byProc[1])).toEqual(runPy(src('squares')).output);
  }, 600_000);
});
