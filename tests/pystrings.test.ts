import { describe, expect, it } from 'vitest';
import { compilePy, outputOf } from '../src/lang/compile';
import { runPy } from '../src/lang/interp';
import { PY_PROGRAMS, PY_STRING_PROGRAMS, ch } from '../src/lang/pyprograms';
import { randomStrProgram } from '../src/lang/randpy';
import { ISS } from '../src/riscv/iss';
import { ABI } from '../src/riscv/isa';

const pow2 = (n: number) => 2 ** Math.max(1, Math.ceil(Math.log2(Math.max(2, n))));

/** The interpreter and the compiled program on the golden model; the machine may stop early (heap full, index out of range) where the interpreter reports the error. */
function both(src: string, o: { dmem?: number; m?: boolean; heapBytes?: number } = {}) {
  const dmem = o.dmem ?? 512;
  const ref = runPy(src, o.heapBytes ? { heapBytes: o.heapBytes } : {});
  const c = compilePy(src, { dmemWords: dmem, m: o.m, heapBytes: o.heapBytes });
  if (c.error) throw c.error;
  const L = c.layout!;
  const iss = new ISS(c.words, { dmemWords: dmem, imemWords: pow2(c.words.length) });
  while (!iss.halted && iss.steps < 3_000_000) iss.step();
  expect(iss.halted, 'halts').toBe(true);
  return { ref, c, L, out: outputOf(L, iss.x[3], iss.dmem), tp: iss.x[4], iss };
}

describe('Python strings: the samples', () => {
  for (const p of PY_STRING_PROGRAMS) {
    for (const m of [false, true]) {
      it(`${p.id} (${m ? 'RV32IM' : 'RV32I'}) prints what it says, in a 64-word data memory`, () => {
        const { ref, L, out, tp } = both(p.source, { dmem: 64, m });
        expect(ref.error).toBeUndefined();
        expect(ref.output).toEqual(p.expect);
        expect(out).toEqual(p.expect);
        expect(ref.heapUsed).toBe(p.heap);
        expect(tp - L.heap!.base, 'tp moved by the heap the interpreter counted').toBe(p.heap);
      });
    }
  }
  it('print marks which words are characters', () => {
    const r = runPy('print("ab", 7, "c")\n');
    expect(r.output).toEqual([...ch('ab'), 7, ...ch('c')]);
    expect(r.strOut).toEqual([1, 1, 0, 2]);
  });
});

describe('Python strings: semantics, interpreter and compiled code alike', () => {
  const same = (src: string, expectOut?: number[], o: { dmem?: number; m?: boolean; heapBytes?: number } = {}) => {
    const { ref, out, L, tp } = both(src, { heapBytes: 400, ...o });
    expect(ref.error?.message).toBeUndefined();
    expect(out).toEqual(ref.output);
    if (expectOut) expect(out).toEqual(expectOut);
    expect(tp - L.heap!.base).toBe(ref.heapUsed);
    return ref;
  };
  it('literals, escapes, a # inside a string, empty strings', () => {
    same(String.raw`a = 'it\'s'
b = "tab\there\n"
c = "q#r \\ \"x\""   # a comment
print(a, b, c, "", len(""), len(c))
`);
    same('print("", "")\nx = "" + ""\nprint(len(x), x == "")\n', [0, 1]);
  });
  it('negative indices, ord and chr', () => {
    same('s = "xyz"\nprint(ord(s[-1]), ord(s[-3]), ord(s[1]), s[-2], chr(65), ord("A"), ord(chr(200)))\n',
      [122, 120, 121, ...ch('y'), ...ch('A'), 65, 200]);
  });
  it('== and != compare contents, not places', () => {
    same('a = "ab" + "c"\nb = "abc"\nprint(a == b, a != b, a == "abd", "" == "", a == "ab", "ab" != a)\n', [1, 0, 0, 1, 0, 1]);
  });
  it('globals read in functions, strs through calls, returns and conditional expressions', () => {
    same(`sep = "-"
def join3(a, b, c):
    return a + sep + b + sep + c
def pick(flag, a, b):
    return a if flag else b
def first(s):
    return s[0]
x = join3("a", "b", "c")
print(x, pick(1, x, "no"), pick(0, x, "no"), first(x) + first("zz"), len(pick(len(x), x, "")))
`);
  });
  it('a function that only uses strings is not a leaf: its variables stay safe across the routines', () => {
    same(`def f(a, b):
    c = a + b
    d = c + a
    return len(d) + len(c) + ord(d[1])
print(f("ab", "cd"), f("q", "z"))
`, undefined, { dmem: 1024 });
  });
  it('temporaries live across string routines', () => {
    same(`x = "ab"
y = "c"
print(1 + len(x + y) * (2 + ord(x[1])) + (len(y + y) if x == "ab" else 9) - ord(y))
`);
  });
  it('s += t, on globals and locals', () => {
    same(`acc = ""
def add(s, n):
    r = s
    for i in range(n):
        r += chr(97 + i)
    return r
acc += "x"
acc += add("", 3)
print(acc)
`);
  });
  it('the same output on RV32IM', () => {
    same(PY_STRING_PROGRAMS[3].source, undefined, { m: true });
  });
  it('an int-only program carries nothing of the strings', () => {
    for (const p of PY_PROGRAMS) {
      const c = compilePy(p.source);
      expect(c.layout!.heap, p.id).toBeUndefined();
      expect(c.layout!.strings, p.id).toBeUndefined();
      expect(c.asm, p.id).not.toMatch(/\btp\b|rt\.(concat|sidx|chr|ord|pstr|streq)/);
    }
  });
});

describe('Python strings: where the machine stops and the interpreter says why', () => {
  const stops = (src: string, msg: RegExp, printedBefore: number[], heapBytes = 400) => {
    const { ref, out } = both(src, { heapBytes });
    expect(ref.error?.message).toMatch(msg);
    expect(ref.output).toEqual(printedBefore);
    expect(out).toEqual(printedBefore);
  };
  it('an index past the end, either side', () => {
    stops('s = "abc"\nprint(1)\nprint(ord(s[3]))\nprint(2)\n', /IndexError/, [1]);
    stops('s = "abc"\nprint(1)\nprint(s[-4])\nprint(2)\n', /IndexError/, [1]);
    stops('s = ""\nprint(5)\nprint(ord(s[0]))\n', /IndexError/, [5]);
  });
  it('ord of a long string, chr out of range', () => {
    stops('print(1)\nprint(ord("ab"))\n', /TypeError/, [1]);
    stops('print(1)\nprint(chr(256))\n', /ValueError/, [1]);
    stops('print(1)\nprint(chr(-1))\n', /ValueError/, [1]);
  });
  it('a full heap: the arena is fixed, nothing is freed', () => {
    const src = 'print(7)\ns = "0123456789"\nfor i in range(100):\n    s += s\n    print(i)\n';
    const { ref, out, L, tp } = both(src, { heapBytes: 200 });
    expect(ref.error?.message).toMatch(/MemoryError/);
    expect(out).toEqual(ref.output);
    expect(out.length).toBeGreaterThan(2);
    expect(tp).toBeLessThanOrEqual(L.heap!.end);
  });
});

describe('Python strings: errors found before anything runs', () => {
  const bad: [string, RegExp][] = [
    ['x = "a" + 1', /only be added to a str/],
    ['x = 1 + "a"', /only be added to a str/],
    ['x = "a" * 3', /does not work on a str/],
    ['x = "a"\nx = 5', /in one place and/],
    ['x = "a"\nif x:\n    pass', /no truth value/],
    ['x = "a" < "b"', /== and != only/],
    ['x = "a" == 1', /only be compared with a str/],
    ['x = "a"\nx[0] = "b"', /cannot be changed in place/],
    ['x = 5\ny = x[0]\nz = "a"', /not a list or a str/],
    ['x = "ab"\ny = x["0"]', /index must be an int/],
    ['x = len(5)', /len\(\) takes/],
    ['x = ord(5)', /must be a str/],
    ['x = chr("a")', /must be an int/],
    ['x = -"a"', /must be an int/],
    ['x = not "a"', /must be an int/],
    ['x = abs("a")', /must be an int/],
    ['xs = [1]\nxs[0] = "a"', /must be an int/],
    ['def f(a):\n    return a\nx = f("s") + f(1)', /takes a str|gets/],
    ['def f(a):\n    if a:\n        return "x"\n    return 1\nx = f(1)', /returns a str on one path/],
    ['def f(a):\n    if a:\n        return "x"\nx = f(1)', /end every path with a return/],
    ['x = "abc', /not closed/],
    ['x = "a\\qb"', /unsupported escape/],
    ['x = """a"""', /triple/],
    ['x = "\u00e9"', /printable ASCII/],
    ['x = "abc"[1]', /index a variable/],
    ['x = 1 if "a" else 2', /must be an int/],
    ['ord = 3', /built-in/],
  ];
  for (const [src, msg] of bad) {
    it(src.split('\n').join(' / '), () => {
      const c = compilePy(src);
      expect(c.error?.message).toMatch(msg);
      expect(c.error!.line).toBeGreaterThan(0);
      expect(() => runPy(src)).toThrow();
    });
  }
  it('a program whose strings do not fit says so', () => {
    expect(compilePy('s = "' + 'x'.repeat(200) + '"\nprint(s)\n', { dmemWords: 64 }).error?.message).toMatch(/data memory has 64/);
  });
});

describe('Python strings: the fuzz', () => {
  const SEEDS = Number(process.env.PY_FUZZ ?? 300);
  it(`${SEEDS} seeded programs: output and heap agree with the interpreter`, () => {
    let ran = 0, stopped = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const src = randomStrProgram(seed);
      const ref = runPy(src, { heapBytes: 600, maxSteps: 200_000 });
      if (ref.error && !/MemoryError/.test(ref.error.message)) throw new Error(`seed ${seed}: ${ref.error.message}\n${src}`);
      const c = compilePy(src, { dmemWords: 1024, heapBytes: 600 });
      if (c.error && /nests too deeply|keeps them in registers/.test(c.error.message)) continue;
      expect(c.error, `seed ${seed}:\n${src}`).toBeNull();
      const L = c.layout!;
      if (ref.output.length > (L.stackTop - L.outBase) / 4 - 64) continue;
      const iss = new ISS(c.words, { dmemWords: L.dmemWords, imemWords: pow2(c.words.length) });
      while (!iss.halted && iss.steps < 5_000_000) iss.step();
      expect(iss.halted, `seed ${seed} halts`).toBe(true);
      expect(outputOf(L, iss.x[3], iss.dmem), `seed ${seed}:\n${src}\n${c.asm}`).toEqual(ref.output);
      if (!ref.error) expect(iss.x[4] - L.heap!.base, `seed ${seed} heap`).toBe(ref.heapUsed);
      else stopped++;
      ran++;
    }
    console.log(`string programs: ${ran} compared, ${stopped} filled the heap`);
    expect(ran).toBeGreaterThan(SEEDS * 0.8);
  }, 180000);
});

describe('Python strings: what the panel reads back', () => {
  it('a str variable is read through its pointer, the output as text, the heap as blocks', async () => {
    const { strAt, outputLines, quoted } = await import('../src/widgets/python');
    const p = PY_STRING_PROGRAMS[0];
    const { c, iss, ref, out } = both(p.source, { dmem: 64 });
    const L = c.layout!;
    const line = L.homes.find((h) => h.name === 'line')!;
    expect(line.str).toBe(true);
    const ptr = line.reg ? iss.x[ABI.indexOf(line.reg)] : iss.dmem[line.addr! >>> 2];
    expect(strAt(iss.dmem, ptr)).toBe('Hello, world!');
    expect(strAt(iss.dmem, 0)).toBeNull();
    expect(outputLines(out, ref)).toEqual([quoted('Hello, world!'), '13']);
    // the heap's first block is "Hello, " and the blocks end exactly at tp
    expect(strAt(iss.dmem, L.heap!.base)).toBe('Hello, ');
    expect(outputLines([1, 2], null)).toBeNull();
  });
});
