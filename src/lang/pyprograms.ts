// Python programs for the chapter "From Python to gates". Each one compiles to RV32I and runs on the gate-level
// CPU; `expect` is what it prints (tests check it against the interpreter and the golden model).

/** The program list's sections, in order. */
export const PY_GROUPS = ['First steps', 'Numbers', 'Lists', 'Functions', 'Bits', 'Multiply & divide'] as const;

export interface PyProgram {
  id: string;
  name: string;
  group: (typeof PY_GROUPS)[number];
  blurb: string;
  source: string;
  expect: number[];
}

export const PY_PROGRAMS: PyProgram[] = [
  {
    id: 'sum',
    name: 'Sum 1..10',
    group: 'First steps',
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
    group: 'Numbers',
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
    group: 'Functions',
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
    group: 'Numbers',
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
    group: 'Lists',
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
    group: 'Lists',
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
    group: 'Multiply & divide',
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
  {
    id: 'countdown',
    name: 'Countdown',
    group: 'First steps',
    blurb: 'A while loop counting down: one compare-and-branch, a store and two adds a pass.',
    expect: [10, 9, 8, 7, 6, 5, 4, 3, 2, 1],
    source: `n = 10
while n > 0:
    print(n)
    n -= 1
`,
  },
  {
    id: 'powers2',
    name: 'Powers of two',
    group: 'First steps',
    blurb: 'Doubling is one add: p + p.',
    expect: [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024],
    source: `p = 1
for k in range(11):
    print(p)
    p = p + p
`,
  },
  {
    id: 'triangle',
    name: 'Triangular numbers',
    group: 'First steps',
    blurb: '1, 3, 6, 10…: a running total, printed every pass.',
    expect: [1, 3, 6, 10, 15, 21, 28, 36, 45, 55],
    source: `t = 0
for k in range(1, 11):
    t += k
    print(t)
`,
  },
  {
    id: 'squares',
    name: 'Squares without multiplying',
    group: 'First steps',
    blurb: '(k + 1)² = k² + 2k + 1: the squares from adds alone, as a difference engine would.',
    expect: [1, 4, 9, 16, 25, 36, 49, 64, 81, 100],
    source: `sq = 0
odd = 1
for k in range(1, 11):
    sq += odd
    odd += 2
    print(sq)
`,
  },
  {
    id: 'fibloop',
    name: 'Fibonacci, with a loop',
    group: 'First steps',
    blurb: 'Three variables in three registers; compare with the recursive version\'s cycle count.',
    expect: [0, 1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 377],
    source: `a = 0
b = 1
for k in range(15):
    print(a)
    t = a + b
    a = b
    b = t
`,
  },
  {
    id: 'digits',
    name: 'Digit sum and reverse',
    group: 'Numbers',
    blurb: '% 10 and // 10 each call the divide routine: about 240 cycles a digit for each.',
    expect: [15, 54321],
    source: `n = 12345
s = 0
r = 0
while n > 0:
    d = n % 10
    s += d
    r = r * 10 + d
    n = n // 10
print(s, r)
`,
  },
  {
    id: 'isqrt',
    name: 'Integer square root',
    group: 'Numbers',
    blurb: 'Bit by bit, two bits of n per pass: shifts, adds and compares, no divide.',
    expect: [31, 256, 9, 46340],
    source: `def isqrt(n):
    root = 0
    bit = 1 << 30
    while bit > n:
        bit >>= 2
    while bit != 0:
        if n >= root + bit:
            n -= root + bit
            root = (root >> 1) + bit
        else:
            root >>= 1
        bit >>= 2
    return root

print(isqrt(1000), isqrt(65536), isqrt(99), isqrt(2147395600))
`,
  },
  {
    id: 'isprime',
    name: 'Is it prime?',
    group: 'Numbers',
    blurb: 'Trial division by odd numbers up to √n: every test is a call to the divide routine.',
    expect: [1, 0, 0, 1],
    source: `def is_prime(n):
    if n < 2:
        return False
    if n % 2 == 0:
        return n == 2
    d = 3
    while d * d <= n:
        if n % d == 0:
            return False
        d += 2
    return True

print(is_prime(97), is_prime(91), is_prime(221), is_prime(997))
`,
  },
  {
    id: 'factors',
    name: 'Prime factors',
    group: 'Numbers',
    blurb: 'Divide out each factor while it divides: 360 = 2 · 2 · 2 · 3 · 3 · 5.',
    expect: [2, 2, 2, 3, 3, 5, 7, 11, 13],
    source: `def factor(n):
    d = 2
    while d * d <= n:
        while n % d == 0:
            print(d)
            n = n // d
        d += 1
    if n > 1:
        print(n)

factor(360)
factor(1001)
`,
  },
  {
    id: 'lcm',
    name: 'Least common multiple',
    group: 'Numbers',
    blurb: 'lcm(a, b) = a // gcd(a, b) * b: a function calling a function.',
    expect: [12, 42, 36],
    source: `def gcd(a, b):
    while b != 0:
        t = a % b
        a = b
        b = t
    return a

def lcm(a, b):
    return a // gcd(a, b) * b

print(lcm(4, 6), lcm(21, 6), lcm(12, 18))
`,
  },
  {
    id: 'powmod',
    name: 'Powers, by squaring',
    group: 'Numbers',
    blurb: '3²⁰⁰ mod 1000 in eight squarings: the exponent\'s bits pick the multiplies.',
    expect: [1, 824, 7],
    source: `def pow_mod(b, e, m):
    r = 1
    b = b % m
    while e > 0:
        if e & 1:
            r = r * b % m
        b = b * b % m
        e >>= 1
    return r

print(pow_mod(3, 200, 1000), pow_mod(2, 30, 1000), pow_mod(7, 13, 100))
`,
  },
  {
    id: 'wrap',
    name: 'Factorials, and where ints wrap',
    group: 'Numbers',
    blurb: '12! fits in 32 bits, 13! does not: the machine keeps the low 32 bits (Python itself would not).',
    expect: [1, 2, 6, 24, 120, 720, 5040, 40320, 362880, 3628800, 39916800, 479001600, 1932053504],
    source: `f = 1
for k in range(1, 14):
    f = f * k
    print(f)
`,
  },
  {
    id: 'stats',
    name: 'Sum, minimum, maximum',
    group: 'Lists',
    blurb: 'One pass over a list in data memory: a load per element, then compares.',
    expect: [397, 4, 97, 39],
    source: `xs = [31, 4, 15, 92, 6, 53, 58, 97, 9, 32]
total = 0
lo = xs[0]
hi = xs[0]
for i in range(len(xs)):
    x = xs[i]
    total += x
    lo = min(lo, x)
    hi = max(hi, x)
print(total, lo, hi, total // len(xs))
`,
  },
  {
    id: 'reverse',
    name: 'Reverse in place',
    group: 'Lists',
    blurb: 'Two indices walking toward each other, swapping: two loads and two stores a pass.',
    expect: [8, 7, 6, 5, 4, 3, 2, 1],
    source: `xs = [1, 2, 3, 4, 5, 6, 7, 8]
i = 0
j = len(xs) - 1
while i < j:
    t = xs[i]
    xs[i] = xs[j]
    xs[j] = t
    i += 1
    j -= 1
for k in range(len(xs)):
    print(xs[k])
`,
  },
  {
    id: 'insertion',
    name: 'Insertion sort',
    group: 'Lists',
    blurb: 'Each element slides left past the larger ones: fewer swaps than bubble sort.',
    expect: [1, 5, 10, 13, 14, 29, 37, 88],
    source: `xs = [29, 10, 14, 37, 13, 5, 88, 1]
for i in range(1, len(xs)):
    key = xs[i]
    j = i - 1
    while j >= 0 and xs[j] > key:
        xs[j + 1] = xs[j]
        j -= 1
    xs[j + 1] = key
for i in range(len(xs)):
    print(xs[i])
`,
  },
  {
    id: 'bsearch',
    name: 'Binary search',
    group: 'Lists',
    blurb: 'Halve the range each step: (lo + hi) >> 1 is a shift, so no divide.',
    expect: [0, 8, 15, -1],
    source: `xs = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53]

def find(x):
    lo = 0
    hi = len(xs) - 1
    while lo <= hi:
        mid = (lo + hi) >> 1
        if xs[mid] == x:
            return mid
        if xs[mid] < x:
            lo = mid + 1
        else:
            hi = mid - 1
    return -1

print(find(2), find(23), find(53), find(24))
`,
  },
  {
    id: 'prefix',
    name: 'Running sums',
    group: 'Lists',
    blurb: 'Each element becomes the sum of those before it: xs[i] += xs[i - 1].',
    expect: [3, 4, 8, 9, 14, 23, 25, 31],
    source: `xs = [3, 1, 4, 1, 5, 9, 2, 6]
for i in range(1, len(xs)):
    xs[i] += xs[i - 1]
for i in range(len(xs)):
    print(xs[i])
`,
  },
  {
    id: 'histogram',
    name: 'Counting sort',
    group: 'Lists',
    blurb: 'Count each value, then print each as often as it was seen: two lists, no compares.',
    expect: [0, 1, 1, 2, 3, 3, 4, 5, 5, 5, 6, 7],
    source: `xs = [3, 1, 4, 1, 5, 2, 6, 5, 3, 5, 0, 7]
count = [0] * 8
for i in range(len(xs)):
    count[xs[i]] += 1
for v in range(8):
    for k in range(count[v]):
        print(v)
`,
  },
  {
    id: 'pascal',
    name: 'Pascal\'s triangle',
    group: 'Lists',
    blurb: 'Row 8 built in place, right to left, so each sum still sees the old value.',
    expect: [1, 8, 28, 56, 70, 56, 28, 8, 1],
    source: `row = [0] * 9
row[0] = 1
for n in range(1, 9):
    for k in range(n, 0, -1):
        row[k] += row[k - 1]
for k in range(9):
    print(row[k])
`,
  },
  {
    id: 'matmul',
    name: 'Matrix multiply',
    group: 'Lists',
    blurb: 'Two 3 × 3 matrices in flat lists: element (i, j) at 3 i + j, a shift and an add.',
    expect: [30, 24, 18, 84, 69, 54, 138, 114, 90],
    source: `a = [1, 2, 3, 4, 5, 6, 7, 8, 9]
b = [9, 8, 7, 6, 5, 4, 3, 2, 1]
c = [0] * 9
for i in range(3):
    for j in range(3):
        s = 0
        for k in range(3):
            s += a[3 * i + k] * b[3 * k + j]
        c[3 * i + j] = s
for i in range(9):
    print(c[i])
`,
  },
  {
    id: 'factorial',
    name: 'Factorial, recursive',
    group: 'Functions',
    blurb: 'n · (n − 1)!: each call waits on the stack for the one below it.',
    expect: [120, 3628800, 479001600],
    source: `def fact(n):
    if n <= 1:
        return 1
    return n * fact(n - 1)

print(fact(5), fact(10), fact(12))
`,
  },
  {
    id: 'hanoi',
    name: 'Towers of Hanoi',
    group: 'Functions',
    blurb: 'Four parameters saved per call; each move printed as from · 10 + to.',
    expect: [13, 12, 32, 13, 21, 23, 13, 7],
    source: `def hanoi(n, src, dst, via):
    if n == 0:
        return 0
    a = hanoi(n - 1, src, via, dst)
    print(src * 10 + dst)
    return a + 1 + hanoi(n - 1, via, dst, src)

print(hanoi(3, 1, 3, 2))
`,
  },
  {
    id: 'ackermann',
    name: 'Ackermann',
    group: 'Functions',
    blurb: 'A function that is not primitive recursive: tiny arguments, a deep stack.',
    expect: [5, 7],
    source: `def ack(m, n):
    if m == 0:
        return n + 1
    if n == 0:
        return ack(m - 1, 1)
    return ack(m - 1, ack(m, n - 1))

print(ack(1, 3), ack(2, 2))
`,
  },
  {
    id: 'evenodd',
    name: 'Even and odd, mutually',
    group: 'Functions',
    blurb: 'is_even calls is_odd calls is_even…: two functions, one stack.',
    expect: [1, 1, 0],
    source: `def is_even(n):
    if n == 0:
        return True
    return is_odd(n - 1)

def is_odd(n):
    if n == 0:
        return False
    return is_even(n - 1)

print(is_even(10), is_odd(7), is_even(3))
`,
  },
  {
    id: 'gcdrec',
    name: 'Euclid, recursive',
    group: 'Functions',
    blurb: 'gcd(b, a % b) until b is 0: the same algorithm as the loop, with frames.',
    expect: [21, 6, 1],
    source: `def gcd(a, b):
    if b == 0:
        return a
    return gcd(b, a % b)

print(gcd(1071, 462), gcd(270, 192), gcd(17, 5))
`,
  },
  {
    id: 'counter',
    name: 'A global counter',
    group: 'Functions',
    blurb: '`global` puts the counter in data memory, where every function can reach it.',
    expect: [6, 16],
    source: `calls = 0

def tick(by):
    global calls
    calls += by
    return calls

tick(1)
tick(2)
tick(3)
print(calls, tick(10))
`,
  },
  {
    id: 'popcount',
    name: 'Counting one bits',
    group: 'Bits',
    blurb: 'n & (n − 1) clears the lowest one bit: one pass per bit that is set.',
    expect: [0, 8, 10, 16],
    source: `def popcount(n):
    c = 0
    while n != 0:
        n &= n - 1
        c += 1
    return c

print(popcount(0), popcount(255), popcount(1023), popcount(0x55555555))
`,
  },
  {
    id: 'binary',
    name: 'A number in binary',
    group: 'Bits',
    blurb: 'The bits of 37, most significant first: a shift and a mask each.',
    expect: [1, 0, 0, 1, 0, 1],
    source: `n = 37
for k in range(5, -1, -1):
    print((n >> k) & 1)
`,
  },
  {
    id: 'gray',
    name: 'Gray code',
    group: 'Bits',
    blurb: 'i ^ (i >> 1): neighbours differ in one bit, as on a rotary encoder.',
    expect: [0, 1, 3, 2, 6, 7, 5, 4],
    source: `for i in range(8):
    print(i ^ (i >> 1))
`,
  },
  {
    id: 'bitrev',
    name: 'Reverse a byte',
    group: 'Bits',
    blurb: 'Eight shifts out of one register into another.',
    expect: [128, 13, 15],
    source: `def reverse8(x):
    r = 0
    for k in range(8):
        r = (r << 1) | (x & 1)
        x >>= 1
    return r

print(reverse8(1), reverse8(0b10110000), reverse8(0xF0))
`,
  },
  {
    id: 'xorshift',
    name: 'Random numbers (xorshift)',
    group: 'Bits',
    blurb: 'Marsaglia\'s generator: three shifts and xors on a 32-bit word, wrapping as the hardware does.',
    expect: [19811, 52090, 22944, 22142, 45281, 34794],
    source: `x = 2463534242
for k in range(6):
    x ^= x << 13
    x ^= (x >> 17) & 0x7FFF
    x ^= x << 5
    print(x & 0xFFFF)
`,
  },
  {
    id: 'divide',
    name: 'Divide, by hand',
    group: 'Multiply & divide',
    blurb: 'Shift and subtract, one quotient bit a pass: what rt.divmod and chapter 21\'s divider do.',
    expect: [14, 2, 30, 10],
    source: `def divide(n, d):
    q = 0
    r = 0
    for k in range(15, -1, -1):
        r = (r << 1) | ((n >> k) & 1)
        if r >= d:
            r -= d
            q |= 1 << k
    print(q, r)

divide(100, 7)
divide(1000, 33)
`,
  },
  {
    id: 'consts',
    name: 'Multiplying by constants',
    group: 'Multiply & divide',
    blurb: 'x · 3, · 5, · 7, · 8 become shifts and adds; · 10 calls the multiply routine.',
    expect: [39, 65, 91, 104, 130, 3, 1, -4, 3],
    source: `x = 13
print(x * 3, x * 5, x * 7, x * 8, x * 10)
print(x // 4, x % 4, -x // 4, -x % 4)
`,
  },
];
