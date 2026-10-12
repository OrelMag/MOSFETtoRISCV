// Build the official riscv-tests into the images tests/verify/riscv-tests/<env>.json, checked in so that
// `npm test` needs no RISC-V toolchain. Run it again only to move to a new riscv-tests revision.
//
//   node scripts/riscv-tests/build.mjs <riscv-tests checkout> [--cc <riscv64-unknown-elf-gcc | riscv-none-elf-gcc>]
//
// The checkout needs its env submodule (git submodule update --init env). A GNU toolchain: clang's integrated
// assembler rejects GNU-isms of the sources (a .weak symbol made .global, the tcontrol CSR name). On Windows the
// xPack riscv-none-elf-gcc zip works as is. Environments: p is the official one (CSRs, traps: the system CPU);
// bare and bare-mp are ours (scripts/riscv-tests/env/bare: no CSRs), for the CPUs without traps.

import { execFileSync, execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const args = process.argv.slice(2);
const src = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--cc');
if (!src) throw new Error('usage: build.mjs <riscv-tests checkout> [--cc <compiler>]');
const cc = args.includes('--cc') ? args[args.indexOf('--cc') + 1] : 'riscv64-unknown-elf-gcc';

const ENVS = {
  p: { inc: join(src, 'env/p'), defs: [], suites: ['rv32ui', 'rv32um', 'rv32mi'] },
  bare: { inc: join(here, 'env/bare'), defs: [], suites: ['rv32ui', 'rv32um', 'rv32uf'] },
  'bare-mp': { inc: join(here, 'env/bare'), defs: ['-DMOSFET_MP'], suites: ['rv32ui', 'rv32ua'] },
};
// The data section starts here (link.ld): word 0 of the data memory is tohost.
const DATA_BASE = 0x10000;

const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();
const revision = { 'riscv-tests': git(src, 'rev-parse', 'HEAD'), env: git(join(src, 'env'), 'rev-parse', 'HEAD') };
const toolchain = execFileSync(cc, ['--version'], { encoding: 'utf8' }).split('\n')[0].trim();

function compile(env, file, out) {
  const e = ENVS[env];
  // the official flags (riscv-tests' isa/Makefile), plus -mno-relax: no linker relaxation, the code is as assembled
  const a = ['-march=rv32g_zicsr_zifencei', '-mabi=ilp32', '-mcmodel=medany', '-fvisibility=hidden', '-nostartfiles', '-mno-relax', '-nostdlib', '-static', ...e.defs, '-I', e.inc, '-I', join(src, 'env'), '-I', join(src, 'isa/macros/scalar'),
    '-T', join(here, 'link.ld'), file, '-o', out];
  return new Promise((ok, fail) => execFile(cc, a, (err, _o, se) => (err ? fail(new Error(`${basename(file)} (${env}): ${se || err.message}`)) : ok())));
}

/** The loadable bytes of an ELF32 little-endian file: code from address 0, data from DATA_BASE. */
function loadElf(buf) {
  if (buf.readUInt32BE(0) !== 0x7f454c46 || buf[4] !== 1 || buf[5] !== 1) throw new Error('not a 32-bit little-endian ELF');
  const phoff = buf.readUInt32LE(28), phentsize = buf.readUInt16LE(42), phnum = buf.readUInt16LE(44);
  const shoff = buf.readUInt32LE(32), shentsize = buf.readUInt16LE(46), shnum = buf.readUInt16LE(48);
  const text = [], data = [];
  for (let i = 0; i < phnum; i++) {
    const o = phoff + i * phentsize;
    if (buf.readUInt32LE(o) !== 1) continue; // PT_LOAD
    const off = buf.readUInt32LE(o + 4), vaddr = buf.readUInt32LE(o + 8), filesz = buf.readUInt32LE(o + 16), memsz = buf.readUInt32LE(o + 20);
    const bytes = Buffer.alloc(memsz);
    buf.copy(bytes, 0, off, off + filesz);
    (vaddr >= DATA_BASE ? data : text).push({ vaddr, bytes });
  }
  const flat = (segs, base) => {
    const end = Math.max(base, ...segs.map((s) => s.vaddr + s.bytes.length));
    const out = Buffer.alloc((end - base + 3) & ~3);
    for (const s of segs) s.bytes.copy(out, s.vaddr - base);
    return out;
  };
  // symbols, for the failure messages: test_<n> labels and tohost
  const syms = {};
  for (let i = 0; i < shnum; i++) {
    const o = shoff + i * shentsize;
    if (buf.readUInt32LE(o + 4) !== 2) continue; // SHT_SYMTAB
    const so = buf.readUInt32LE(o + 16), size = buf.readUInt32LE(o + 20), link = buf.readUInt32LE(o + 24);
    const stro = buf.readUInt32LE(shoff + link * shentsize + 16);
    for (let s = so; s < so + size; s += 16) {
      const n = buf.readUInt32LE(s);
      let e = stro + n;
      while (buf[e]) e++;
      const name = buf.toString('latin1', stro + n, e);
      if (name === 'tohost' || name === 'fail' || name === 'pass') syms[name] = buf.readUInt32LE(s + 4);
    }
  }
  if (text.length === 0 || text[0].vaddr !== 0) throw new Error('code must start at address 0');
  if (syms.tohost !== DATA_BASE) throw new Error(`tohost at 0x${(syms.tohost ?? 0).toString(16)}, expected 0x${DATA_BASE.toString(16)}`);
  return { text: flat(text, 0), data: flat(data, DATA_BASE), syms };
}

async function pool(jobs, n) {
  const out = [];
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (next < jobs.length) { const j = next++; out[j] = await jobs[j](); } }));
  return out;
}

const tmp = mkdtempSync(join(tmpdir(), 'rvtests-'));
const outDir = join(root, 'tests/verify/riscv-tests');
mkdirSync(outDir, { recursive: true });
for (const [env, e] of Object.entries(ENVS)) {
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
