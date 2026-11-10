// Build the official riscv-tests into the images tests/verify/riscv-tests/<env>.json, checked in so that
// `npm test` needs no RISC-V toolchain. Run it again only to move to a new riscv-tests revision.
//
//   node scripts/riscv-tests/build.mjs <riscv-tests checkout> [--cc <riscv64-unknown-elf-gcc | riscv-none-elf-gcc>] [--env <name>…]
//
// The checkout needs its env submodule (git submodule update --init env). A GNU toolchain: clang's integrated
// assembler rejects GNU-isms of the sources (a .weak symbol made .global, the tcontrol CSR name). On Windows the
// xPack riscv-none-elf-gcc zip works as is. Environments: p is the official one (CSRs, traps: the system CPU);
// bare and bare-mp are ours (scripts/riscv-tests/env/bare: no CSRs), for the CPUs without traps; bare64 is bare
// for RV64 (rv64ui, rv64um: chapter 25's 64-bit core and its golden model, src/riscv/iss64.ts). --env builds only
// the environments named (each file records its own toolchain).

import { execFileSync, execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadElf as loadElfAt, pool } from './elf.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const args = process.argv.slice(2);
const src = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
if (!src) throw new Error('usage: build.mjs <riscv-tests checkout> [--cc <compiler>]');
const cc = args.includes('--cc') ? args[args.indexOf('--cc') + 1] : 'riscv64-unknown-elf-gcc';
const only = args.flatMap((a, i) => (args[i - 1] === '--env' ? [a] : []));

const ENVS = {
  p: { inc: join(src, 'env/p'), defs: [], suites: ['rv32ui', 'rv32um', 'rv32mi'] },
  bare: { inc: join(here, 'env/bare'), defs: [], suites: ['rv32ui', 'rv32um', 'rv32uf'] },
  'bare-mp': { inc: join(here, 'env/bare'), defs: ['-DMOSFET_MP'], suites: ['rv32ui', 'rv32ua'] },
  bare64: { inc: join(here, 'env/bare'), defs: [], suites: ['rv64ui', 'rv64um'], xlen: 64 },
};
const ARCH = { 32: ['-march=rv32g_zicsr_zifencei', '-mabi=ilp32'], 64: ['-march=rv64g_zicsr_zifencei', '-mabi=lp64'] };
// The data section starts here (link.ld): word 0 of the data memory is tohost.
const DATA_BASE = 0x10000;
const loadElf = (buf) => loadElfAt(buf, DATA_BASE);

const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();
const revision = { 'riscv-tests': git(src, 'rev-parse', 'HEAD'), env: git(join(src, 'env'), 'rev-parse', 'HEAD') };
const toolchain = execFileSync(cc, ['--version'], { encoding: 'utf8' }).split('\n')[0].trim();

function compile(env, file, out) {
  const e = ENVS[env];
  // the official flags (riscv-tests' isa/Makefile), plus -mno-relax: no linker relaxation, the code is as assembled
  const a = [...ARCH[e.xlen ?? 32], '-mcmodel=medany', '-fvisibility=hidden', '-nostartfiles', '-mno-relax', '-nostdlib', '-static', ...e.defs, '-I', e.inc, '-I', join(src, 'env'), '-I', join(src, 'isa/macros/scalar'),
    '-T', join(here, 'link.ld'), file, '-o', out];
  return new Promise((ok, fail) => execFile(cc, a, (err, _o, se) => (err ? fail(new Error(`${basename(file)} (${env}): ${se || err.message}`)) : ok())));
}

const tmp = mkdtempSync(join(tmpdir(), 'rvtests-'));
const outDir = join(root, 'tests/verify/riscv-tests');
mkdirSync(outDir, { recursive: true });
for (const [env, e] of Object.entries(ENVS).filter(([k]) => !only.length || only.includes(k))) {
  const jobs = [];
  for (const suite of e.suites) {
    for (const f of readdirSync(join(src, 'isa', suite)).filter((f) => f.endsWith('.S')).sort()) {
      const name = `${suite}-${f.slice(0, -2)}`, elf = join(tmp, `${env}-${name}.elf`);
      jobs.push(async () => {
        await compile(env, join(src, 'isa', suite, f), elf);
        const img = loadElf(readFileSync(elf));
        return [name, { text: img.text.toString('base64'), data: img.data.toString('base64'), pass: img.syms.pass, fail: img.syms.fail }];
      });
    }
  }
  const tests = Object.fromEntries(await pool(jobs, 8));
  const file = { env, revision, toolchain, dataBase: DATA_BASE, tests };
  writeFileSync(join(outDir, `${env}.json`), JSON.stringify(file, null, 1) + '\n');
  console.log(`${env}: ${Object.keys(tests).length} tests`);
}
