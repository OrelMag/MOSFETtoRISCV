// Build chipsalliance/riscv-vector-tests for our vector subset into tests/verify/rvv-tests/ (index .json + words .bin.br), checked in so that
// `npm test` needs no RISC-V toolchain (as scripts/riscv-tests/build.mjs does for riscv-tests).
//
//   node scripts/rvv-tests/build.mjs <stage-2 artifact dir> --rvt <riscv-vector-tests checkout> [--cc <riscv-none-elf-gcc>] [--out <dir>]
//
// The artifact is what .github/workflows/rvv-tests.yml generates on Linux (the generator needs Go and a patched Spike):
// stage2/*.S, self-checking assembly with Spike's results in it, and PROVENANCE.txt. The checkout (at the revision the
// artifact names) gives macros/general and env/riscv-test-env/encoding.h. Each test is compiled against our bare
// environment (scripts/rvv-tests/env: no CSRs, no traps, tohost at word 0 of the data memory), with TEST_CASE comparing
// against an immediate (scripts/rvv-tests/macros: our CPUs cannot load from the code), into two files:
//
//   v128             every test as generated: the golden model (src/riscv/rvv.ts, Zve32x at VLEN 128) runs them all.
//   v128-gates       a narrowed copy for the gate-level vector unit (e32 only, no Zicsr, no vmul, no strided or narrow
//                    accesses), by these rules and no others:
//                      1. only the combination blocks at SEW e32 are kept (each block sets its own a0, so the rest stand alone);
//                      2. setup that fills or empties a whole register group at e8 with AVL x0 (`vsetvli t1, x0, e8,<lmul>`
//                         and the vle8.v / vse8.v after it, and the opening zeroing at e8, m8) is written at e32: with
//                         AVL x0 the same bytes fill the same group, so the registers hold what they held;
//                      3. `csrwi vxrm` and `csrci vxsat` are left out (none of our instructions rounds or saturates);
//                      4. a test of an instruction the gates leave to the golden model, or one left with no TEST_CASE, is
//                         not built: it is listed in notApplicable with the reason;
//                      5. the test data only the dropped blocks used is dropped (gates.mjs pruneData), so the data memory
//                         the copy needs is smaller.
//                    tests/verify-rvv-tests.test.ts runs this copy on the golden model as well (full and gate subset),
//                    so the rules are checked to keep each test's meaning.
// Each file records the generator revision, Spike, the toolchains and the rules.

import { execFile, execFileSync } from 'node:child_process';
import { brotliCompressSync, constants } from 'node:zlib';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadElf, pool } from '../riscv-tests/elf.mjs';
import { gatesVariant } from './gates.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const args = process.argv.slice(2);
const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const art = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const rvt = opt('--rvt');
if (!art || !rvt) throw new Error('usage: build.mjs <stage-2 artifact dir> --rvt <riscv-vector-tests checkout> [--cc <compiler>]');
const PINNED_CC = 'E:/toolchains/xpack-riscv-none-elf-gcc-15.2.0-1/bin/riscv-none-elf-gcc.exe';
const cc = opt('--cc') ?? (existsSync(PINNED_CC) ? PINNED_CC : 'riscv-none-elf-gcc');
const DATA_BASE = 0x100000;

const provenance = Object.fromEntries(readFileSync(join(art, 'PROVENANCE.txt'), 'utf8').trim().split('\n').map((l) => [l.slice(0, l.indexOf(' ')), l.slice(l.indexOf(' ') + 1)]));
const rev = execFileSync('git', ['-C', rvt, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (rev !== provenance['riscv-vector-tests']) throw new Error(`the checkout is at ${rev}, the artifact was generated at ${provenance['riscv-vector-tests']}`);
const toolchain = execFileSync(cc, ['--version'], { encoding: 'utf8' }).split('\n')[0].trim();

/** Instructions the gate-level unit leaves to the golden model (riscv/rvv.ts execV with gates), by test name prefix. */
const GATES_OUT = [
  [/^vmul_/, 'vmul: the gate-level lanes have no multiplier (the golden model runs it)'],
  [/^vl(s)?e(8|16)_v|^vs(s)?e(8|16)_v/, 'a narrow (e8 / e16) load or store: the gate-level unit is e32 only'],
  [/^vlse|^vsse/, 'a strided load or store: the gate-level unit has unit-stride accesses only'],
  [/^vset/, 'vset*: checked by reading vstart / vtype / vl with csrr (the gate-level CPU has no Zicsr), over e8 / e16 types the gate-level unit marks vill'],
];

const tmp = mkdtempSync(join(tmpdir(), 'rvvtests-'));
const ARCH = ['-march=rv32im_zicsr_zve32x_zvl128b', '-mabi=ilp32'];
function compile(file, out) {
  const a = [...ARCH, '-mcmodel=medany', '-fvisibility=hidden', '-nostartfiles', '-mno-relax', '-nostdlib', '-static',
    '-I', join(here, 'macros'), '-I', join(here, 'env'), '-I', join(rvt, 'macros/general'), '-I', join(rvt, 'env/riscv-test-env'),
    '-T', join(here, 'link.ld'), file, '-o', out];
  return new Promise((ok, fail) => execFile(cc, a, { maxBuffer: 1 << 24 }, (err, _o, se) => (err ? fail(new Error(`${file}: ${se || err.message}`)) : ok())));
}
const image = (elf) => {
  const img = loadElf(readFileSync(elf), DATA_BASE);
  return { text: img.text, data: img.data };
};

const stage2 = join(art, 'stage2');
const names = readdirSync(stage2).filter((f) => f.endsWith('.S')).map((f) => f.slice(0, -2)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
const full = {}, gates = {}, notApplicable = {};
await pool(names.map((name) => async () => {
  const src = readFileSync(join(stage2, `${name}.S`), 'utf8');
  const cases = (src.match(/^\s*TEST_CASE\(/gm) ?? []).length;
  await compile(join(stage2, `${name}.S`), join(tmp, `${name}.elf`));
  full[name] = { ...image(join(tmp, `${name}.elf`)), cases };
  const out = GATES_OUT.find(([re]) => re.test(name));
  if (out) { notApplicable[name] = out[1]; return; }
  const g = gatesVariant(src);
  if (!g.src) { notApplicable[name] = g.reason; return; }
  const gs = join(tmp, `${name}.gates.S`);
  writeFileSync(gs, g.src);
  await compile(gs, join(tmp, `${name}.gates.elf`));
  gates[name] = { ...image(join(tmp, `${name}.gates.elf`)), cases: g.cases, blocks: `${g.kept} of ${g.blocks}` };
}), 8);

const order = (o) => Object.fromEntries(names.filter((n) => o[n] !== undefined).map((n) => [n, o[n]]));
const revision = { 'riscv-vector-tests': rev, spike: provenance.spike, generatorToolchain: provenance.toolchain, split: provenance.split };
const outDir = opt('--out') ? resolve(opt('--out')) : join(root, 'tests/verify/rvv-tests');
mkdirSync(outDir, { recursive: true });
// Each set: <set>.json, a readable index (per test its checks and its words' lengths, in order), and <set>.bin.br, the
// words themselves (each test's text, then its data, little-endian) in one brotli stream: the whole suite is ~3.4 MB so.
const write = (set, tests, body) => {
  const index = Object.fromEntries(Object.entries(tests).map(([n, t]) => [n, { cases: t.cases, ...(t.blocks ? { blocks: t.blocks } : {}), text: t.text.length / 4, data: t.data.length / 4 }]));
  writeFileSync(join(outDir, `${set}.json`), JSON.stringify({ env: 'rvv', vlen: 128, xlen: 32, revision, toolchain, dataBase: DATA_BASE, ...body, tests: index }, null, 1) + '\n');
  const words = Buffer.concat(Object.values(tests).flatMap((t) => [t.text, t.data]));
  writeFileSync(join(outDir, `${set}.bin.br`), brotliCompressSync(words, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_LGWIN]: 24, [constants.BROTLI_PARAM_SIZE_HINT]: words.length } }));
};
write('v128', order(full), {});
write('v128-gates', order(gates), { rules: 'scripts/rvv-tests/build.mjs (e32 blocks only; e8 whole-group setup with AVL x0 written at e32; vxrm / vxsat writes left out; unused test data dropped)', notApplicable: order(notApplicable) });
console.log(`v128: ${Object.keys(full).length} tests; gates: ${Object.keys(gates).length}, not applicable ${Object.keys(notApplicable).length}`);
