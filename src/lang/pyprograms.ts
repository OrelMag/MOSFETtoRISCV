// Python programs for the chapter "From Python to gates". Each one compiles to RV32I and runs on the gate-level
// CPU; `expect` is what it prints (tests check it against the interpreter and the golden model).

export interface PyProgram {
  id: string;
  name: string;
  blurb: string;
  source: string;
  expect: number[];
}

export const PY_PROGRAMS: PyProgram[] = [
  {
    id: 'sum',
    name: 'Sum 1..10',
    blurb: 'A for loop and an addition: the counter and the total live in registers.',
    expect: [55],
    source: `total = 0
for i in range(1, 11):
    total += i
print(total)
`,
  },
  {
    id: 'collatz',
    name: 'Collatz',
    blurb: 'A while loop and an if. n % 2 is a mask and n // 2 a shift; 3 * n is two adds.',
    expect: [111],
    source: `n = 27
steps = 0
while n != 1:
    if n % 2 == 0:
        n = n // 2
    else:
        n = 3 * n + 1
    steps += 1
print(steps)
`,
  },
  {
    id: 'fib',
    name: 'Fibonacci, recursive',
    blurb: 'A function calling itself: every call pushes a frame (ra and the saved registers) on the stack.',
    expect: [13],
    source: `def fib(n):
    if n < 2:
        return n
    return fib(n - 1) + fib(n - 2)

print(fib(7))
`,
  },
  {
    id: 'gcd',
    name: 'Greatest common divisor',
    blurb: 'Euclid with %: RV32I has no divider, so % calls a 32-step shift-and-subtract routine.',
    expect: [21, 6],
    source: `def gcd(a, b):
    while b != 0:
        t = a % b
        a = b
        b = t
    return a

print(gcd(1071, 462))
print(gcd(48, 18))
`,
  },
  {
    id: 'primes',
    name: 'Primes (sieve)',
    blurb: 'A list in data memory: sieve[j] is a load or a store at the list\'s base + 4 j.',
    expect: [2, 3, 5, 7, 11, 13, 17, 19, 23, 29],
    source: `N = 30
sieve = [1] * 30
for i in range(2, N):
    if sieve[i]:
        print(i)
        j = i + i
        while j < N:
            sieve[j] = 0
            j += i
`,
  },
  {
    id: 'sort',
    name: 'Bubble sort',
    blurb: 'Nested loops over a list; swapping two elements is two loads and two stores.',
    expect: [1, 2, 3, 5, 8, 9],
    source: `xs = [5, 3, 8, 1, 9, 2]
n = len(xs)
for i in range(n):
    for j in range(n - 1 - i):
        if xs[j] > xs[j + 1]:
            t = xs[j]
            xs[j] = xs[j + 1]
            xs[j + 1] = t
for i in range(n):
    print(xs[i])
`,
  },
  {
    id: 'mul',
    name: 'Multiply, by hand',
    blurb: 'What x * y becomes without a multiplier: the shift-and-add loop of a hardware multiplier, in software.',
    expect: [391, -391, 4096],
    source: `def times(x, y):
    p = 0
    while y != 0:
        if y & 1:
            p += x
        x = x << 1
        y = y >> 1
    return p

print(17 * 23)
print(times(-17, 23))
print(times(64, 64))
`,
  },
];
