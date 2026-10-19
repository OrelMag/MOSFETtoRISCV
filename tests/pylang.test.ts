import { describe, expect, it } from 'vitest';
import { singleCycleCpu } from '../src/lib';
import { compilePy, outputOf } from '../src/lang/compile';
import type { Compiled } from '../src/lang/compile';
import { binop, runPy } from '../src/lang/interp';
import { PY_PROGRAMS } from '../src/lang/pyprograms';
import { randomPyProgram } from '../src/lang/randpy';
import { clockCycle, cpuState } from '../src/riscv/cosim';
import { ISS } from '../src/riscv/iss';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';

const pow2 = (n: number) => 2 ** Math.max(1, Math.ceil(Math.log2(Math.max(2, n))));

/** Run a compiled program on the golden model; what it printed. */
function runIss(c: Compiled, maxSteps = 2_000_000): { output: number[]; steps: number; iss: ISS } {
  const L = c.layout!;
  const iss = new ISS(c.words, { dmemWords: L.dmemWords, imemWords: pow2(c.words.length) });
  while (!iss.halted && iss.steps < maxSteps) iss.step();
  expect(iss.halted, 'halts').toBe(true);
  return { output: outputOf(L, iss.x[3], iss.dmem), steps: iss.steps, iss };
}

function both(src: string, dmemWords = 512): { py: number[]; rv: number[]; c: Compiled; steps: number } {
  const ref = runPy(src);
  if (ref.error) throw ref.error;
  const c = compilePy(src, { dmemWords });
  if (c.error) throw c.error;
  const { output, steps } = runIss(c);
  return { py: ref.output, rv: output, c, steps };
}

describe('Python subset: samples', () => {
  for (const p of PY_PROGRAMS) {
    it(p.id, () => {
      const { py, rv, c, steps } = both(p.source, 64);
      expect(py).toEqual(p.expect);
      expect(rv).toEqual(p.expect);
      // every Python statement line maps to instructions, and back
      for (const pc of c.assembled!.lines.map((l) => l.addr)) {
        const line = c.pyOfPc(pc);
        if (line !== null) expect(c.pcsOfPy(line)).toContain(pc);
      }
      console.log(`${p.id}: ${p.source.trim().split('\n').length} Python lines, ${c.words.length} instructions, ${steps} executed`);
    });
  }
});

describe('Python subset: semantics', () => {
  it('runtime routines, value by value', () => {
    const vals = [0, 1, -1, 2, -2, 3, -3, 7, -7, 10, -10, 255, 1 << 30, -(1 << 30), 0x7fffffff, -0x80000000, 123456789, -987654321];
    for (const a of vals) {
      const src = `xs = [${vals.join(', ')}]
a = ${a}
for j in range(${vals.length}):
    b = xs[j]
    print(a * b, a // b, a % b)
`;
      const { rv } = both(src);
      const want = vals.flatMap((b) => [binop('*', a, b), binop('//', a, b), binop('%', a, b)]);
      expect(rv, `a = ${a}`).toEqual(want);
    }
  });

  it('constants: shifts, masks and shift-adds give the same values', () => {
    const src = `xs = [0, 1, -1, 5, -5, 1000, -1000, 2147483647, -2147483648]
for i in range(9):
    x = xs[i]
    print(x * 8, x // 8, x % 8, x * 3, x * 10, x * 7, x // 1, x % 1, x << 33, x >> 31, -x, ~x, abs(x), not x)
`;
    const { py, rv } = both(src);
    expect(rv).toEqual(py);
  });

  it('and / or give the deciding operand, chains evaluate each middle operand once', () => {
    const src = `def f(x):
    print(x)
    return x

print(0 or 5, 3 and 0, 2 and 7, f(0) or f(9))
print(1 < f(2) < 3, 1 < f(5) < 3, f(4) > 3 > f(1))
a = 3
if a > 1 and not a > 5 or a == 100:
    print(1)
else:
    print(0)
print(7 if a < 2 else 8, min(a, 2, 9), max(a, 2, 9))
`;
    const { py, rv } = both(src);
    expect(rv).toEqual(py);
  });

  it('for loops leave the variable at its last value; a body may change it', () => {
    const src = `for i in range(5):
    pass
print(i)
n = 0
for k in range(10, 0, -3):
    n += k
    k = 100
print(n, k)
for e in range(3, 3):
    print(999)
for j in range(0, 20, 7):
    if j == 7:
        continue
    print(j)
while True:
    n -= 1
    if n < 15:
        break
print(n)
`;
    const { py, rv } = both(src);
    expect(rv).toEqual(py);
  });

  it('globals: functions see the top level, `global` writes it', () => {
    const src = `count = 0
limit = 3
def bump(by):
    global count
    count += by
    return count < limit

while bump(1):
    pass
print(count)
`;
    const { py, rv } = both(src);
    expect(py).toEqual([3]);
    expect(rv).toEqual(py);
  });

  it('deep recursion uses the stack and comes back', () => {
    const src = `def down(n):
    if n == 0:
        return 0
    return 1 + down(n - 1)

print(down(40))
`;
    const { rv } = both(src);
    expect(rv).toEqual([40]);
  });

  it('calls inside expressions keep the live temporaries', () => {
    const src = `def sq(x):
    return x * x

def add3(a, b, c):
    return a + b + c

xs = [4, 5, 6]
print(1 + sq(2) + sq(3) * 2, add3(sq(1), sq(2) + 1, add3(1, 2, sq(xs[2]))), xs[1] + sq(xs[0]))
`;
    const { py, rv } = both(src);
    expect(rv).toEqual(py);
  });
});

describe('Python subset: errors', () => {
  const bad: [string, RegExp][] = [
    ['x = 1.5', /only integers/],
    ['print("hi")', /strings are not supported/],
    ['x = 3 / 2', /use \/\/ for integer division/],
    ['if x:\nprint(1)', /indented block/],
    ['print(y)', /name "y" is not defined/],
    ['def f(a):\n    return a\nprint(f(1, 2))', /takes 1 argument, got 2/],
    ['print(f(1))\ndef f(a):\n    return a', /called before its def runs/],
    ['xs = [1, 2]\nxs = 3', /is a list/],
    ['for i in range(0, 10, n):\n    pass', /step must be a constant/],
    ['x = 1\n  y = 2', /unexpected indent/],
    ['return 1', /outside a function/],
    ['def f():\n    xs = [1]\n    return 0', /top level/],
    ['a, b = 1, 2', /tuples|assign/],
  ];
  for (const [src, msg] of bad) {
    it(src.split('\n')[0], () => {
      const c = compilePy(src);
      expect(c.error?.message).toMatch(msg);
      expect(c.error!.line).toBeGreaterThan(0);
    });
  }
});

describe('Python subset: random programs, compiled vs interpreted', () => {
  // PY_FUZZ=<n> runs more seeds (a sweep before changing the code generator)
  const SEEDS = Number(process.env.PY_FUZZ ?? 300);
  it(`${SEEDS} seeded programs`, () => {
    let ran = 0, skipped = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const src = randomPyProgram(seed);
      const ref = runPy(src, { maxSteps: 200_000 });
      if (ref.error) { skipped++; continue; } // Python itself would stop (a name read before it is set)
      const c = compilePy(src, { dmemWords: 512 });
      if (c.error && /nests too deeply|keeps them in registers/.test(c.error.message)) { skipped++; continue; } // the compiler's documented limits
      expect(c.error, `seed ${seed}:\n${src}`).toBeNull();
      const L = c.layout!;
      // more output than fits between the data and the stack overwrites the stack (no check in the code)
      const cap = (L.stackTop - L.outBase) / 4 - 64;
      if (ref.output.length > cap) { skipped++; continue; }
      const iss = new ISS(c.words, { dmemWords: L.dmemWords, imemWords: pow2(c.words.length) });
      while (!iss.halted && iss.steps < 5_000_000) iss.step();
      expect(iss.halted, `seed ${seed} halts`).toBe(true);
      expect(outputOf(L, iss.x[3], iss.dmem), `seed ${seed}:\n${src}\n${c.asm}`).toEqual(ref.output);
      ran++;
    }
    console.log(`random programs: ${ran} compared, ${skipped} skipped`);
    expect(ran).toBeGreaterThan(SEEDS * 0.7);
  }, 120000);
});

describe('Python subset on the gate-level CPU', () => {
  for (const id of ['sum', 'fib']) {
    it(`${id}: lock step with the golden model`, () => {
      const p = PY_PROGRAMS.find((q) => q.id === id)!;
      const c = compilePy(p.source, { dmemWords: 64 });
      expect(c.error).toBeNull();
      const imemK = Math.max(6, Math.ceil(Math.log2(c.words.length)));
      const sim = new GateSim(flatten(singleCycleCpu(c.words, { imemK, dmemK: 6 })));
      sim.setInput('clk', 0);
      sim.settle();
      const iss = new ISS(c.words, { dmemWords: 64, imemWords: 2 ** imemK });
      let cycles = 0;
      while (!iss.halted && cycles < 5000) {
        expect(cpuState(sim).pc, `cycle ${cycles}`).toBe(iss.pc);
        iss.step();
        clockCycle(sim);
        cycles++;
        expect(cpuState(sim).x, `cycle ${cycles}`).toEqual([...iss.x]);
      }
      expect(iss.halted).toBe(true);
      const st = cpuState(sim);
      expect(outputOf(c.layout!, st.x[3], st.dmem)).toEqual(p.expect);
    }, 180000);
  }
});
