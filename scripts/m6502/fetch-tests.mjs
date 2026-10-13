// Downloads the 6502 test suites used by tests/m6502-iss.test.ts into tests/m6502/.cache/ (gitignored):
//  - SingleStepTests 65x02, 6502/v1/<op>.json for every documented opcode (MIT; ~3 MB each, ~500 MB total)
//  - Klaus Dormann's 6502_functional_test.bin (GPL: cached only, never checked in)
// Usage: node scripts/m6502/fetch-tests.mjs [--sample] [op ...]
//   --sample   also rewrite tests/m6502/singlestep-sample.json (the first SAMPLE tests of each opcode)
//   op ...     only these opcodes (hex), e.g. a9 6d
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CACHE = join(ROOT, 'tests', 'm6502', '.cache');
const SST = 'https://raw.githubusercontent.com/SingleStepTests/65x02/main/6502/v1/';
const KLAUS = 'https://raw.githubusercontent.com/Klaus2m5/6502_65C02_functional_tests/master/bin_files/6502_functional_test.bin';
const SAMPLE = 25;

// The 151 documented NMOS opcodes (kept in step with src/m6502/isa.ts; tests check it).
const DOCUMENTED = (
  '00 01 05 06 08 09 0a 0d 0e 10 11 15 16 18 19 1d 1e 20 21 24 25 26 28 29 2a 2c 2d 2e 30 31 35 36 38 39 3d 3e ' +
  '40 41 45 46 48 49 4a 4c 4d 4e 50 51 55 56 58 59 5d 5e 60 61 65 66 68 69 6a 6c 6d 6e 70 71 75 76 78 79 7d 7e ' +
  '81 84 85 86 88 8a 8c 8d 8e 90 91 94 95 96 98 99 9a 9d a0 a1 a2 a4 a5 a6 a8 a9 aa ac ad ae b0 b1 b4 b5 b6 b8 ' +
  'b9 ba bc bd be c0 c1 c4 c5 c6 c8 c9 ca cc cd ce d0 d1 d5 d6 d8 d9 dd de e0 e1 e4 e5 e6 e8 e9 ea ec ed ee f0 ' +
  'f1 f5 f6 f8 f9 fd fe').split(' ');

const exists = (p) => stat(p).then(() => true, () => false);

async function get(url, dest) {
  if (await exists(dest)) return false;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      await writeFile(dest, Buffer.from(await res.arrayBuffer()));
      return true;
    } catch (e) {
      if (attempt >= 3) throw new Error(`${url}: ${e.message}`);
    }
  }
}

// One test as plain arrays: [pc, s, a, x, y, p, [addr, value, ...]] twice, then cycles [addr, data, w, ...] (w: 1 = write).
const state = (s) => [s.pc, s.s, s.a, s.x, s.y, s.p, s.ram.flat()];
const compact = (t) => [state(t.initial), state(t.final), t.cycles.flatMap(([a, d, k]) => [a, d, k === 'write' ? 1 : 0])];

const args = process.argv.slice(2);
const sample = args.includes('--sample');
const ops = args.filter((a) => !a.startsWith('--'));
const list = ops.length ? ops : DOCUMENTED;
await mkdir(CACHE, { recursive: true });

let fetched = 0;
const queue = [...list];
await Promise.all(Array.from({ length: 8 }, async () => {
  for (let op; (op = queue.shift()); ) if (await get(SST + op + '.json', join(CACHE, op + '.json'))) fetched++;
}));
if (await get(KLAUS, join(CACHE, '6502_functional_test.bin'))) fetched++;
console.log(`${fetched} file(s) downloaded into ${CACHE}`);

if (sample) {
  const out = {};
  for (const op of DOCUMENTED) {
    const tests = JSON.parse(await readFile(join(CACHE, op + '.json'), 'utf8'));
    out[op] = tests.slice(0, SAMPLE).map(compact);
  }
  const dest = join(ROOT, 'tests', 'm6502', 'singlestep-sample.json');
  // One opcode per line keeps diffs readable.
  const text = '{\n' + Object.entries(out).map(([k, v]) => `"${k}":${JSON.stringify(v)}`).join(',\n') + '\n}\n';
  await writeFile(dest, text);
  console.log(`wrote ${dest} (${(text.length / 1024).toFixed(0)} KiB)`);
}
