# 6502 test data

`singlestep-sample.json` is a sample of **SingleStepTests 65x02** (<https://github.com/SingleStepTests/65x02>,
`6502/v1/`, MIT licence, Copyright (c) 2024 Thomas Harte et al.): the first 25 tests of each of the 151 documented
NMOS opcodes, compacted. Each opcode maps to a list of `[initial, final, cycles]`, where a state is
`[pc, s, a, x, y, p, [addr, value, addr, value, …]]` and `cycles` is `[addr, data, write, …]` (write: 1 = write,
0 = read), one triple per bus cycle.

`.cache/` (gitignored) holds the full suites, downloaded by `node scripts/m6502/fetch-tests.mjs`:

- the SingleStepTests files for every documented opcode (10 000 tests each, ~590 MB in all);
- Klaus Dormann's `6502_functional_test.bin`
  (<https://github.com/Klaus2m5/6502_65C02_functional_tests>, GPL-3.0: cached only, never checked in).

`tests/m6502-iss.test.ts` runs the sample always and the cached suites when present.
`node scripts/m6502/fetch-tests.mjs --sample` regenerates the sample from the cache.
