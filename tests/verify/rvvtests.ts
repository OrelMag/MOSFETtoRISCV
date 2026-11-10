// chipsalliance/riscv-vector-tests for our vector subset, prebuilt by scripts/rvv-tests/build.mjs into
// tests/verify/rvv-tests/: per set an index (<set>.json: revision, toolchain, rules, per test its checks and its words'
// lengths, notApplicable with the reasons) and the words (<set>.bin.br: each test's text then data, little-endian, one
// brotli stream). v128 is every test as generated (the golden model), v128-gates the copy narrowed for the gate-level
// unit. Same image format as the riscv-tests (tests/verify/images.ts): code from address 0, data from dataBase, tohost
// at data word 0.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliDecompressSync } from 'node:zlib';
import { ISS } from '../../src/riscv/iss';
import { loadable, verdict, type RvImage } from '../../src/riscv/rvimage';

/**
 * The instructions src/riscv/rvv.ts implements, by riscv-vector-tests config name: the generator's PATTERN in
 * .github/workflows/rvv-tests.yml selects exactly these (tests/verify-rvv-tests.test.ts checks every one has tests).
 */
export const RVV_SUBSET = [
  'vsetvli', 'vsetivli', 'vsetvl',
  ...['vv', 'vx', 'vi'].map((f) => `vadd.${f}`), 'vsub.vv', 'vsub.vx', 'vrsub.vx', 'vrsub.vi',
  ...['vminu', 'vmin', 'vmaxu', 'vmax'].flatMap((n) => [`${n}.vv`, `${n}.vx`]),
  ...['vand', 'vor', 'vxor'].flatMap((n) => ['vv', 'vx', 'vi'].map((f) => `${n}.${f}`)),
  ...['vmseq', 'vmsne', 'vmsleu', 'vmsle'].flatMap((n) => ['vv', 'vx', 'vi'].map((f) => `${n}.${f}`)),
  'vmsltu.vv', 'vmsltu.vx', 'vmslt.vv', 'vmslt.vx', 'vmsgtu.vx', 'vmsgtu.vi', 'vmsgt.vx', 'vmsgt.vi',
  ...['vsll', 'vsrl', 'vsra'].flatMap((n) => ['vv', 'vx', 'vi'].map((f) => `${n}.${f}`)),
  'vmerge.vvm', 'vmerge.vxm', 'vmerge.vim', 'vmv.v.v', 'vmv.v.x', 'vmv.v.i',
  'vredsum.vs', 'vmul.vv', 'vmul.vx', 'vmv.x.s', 'vmv.s.x', 'vid.v',
  ...[8, 16, 32].flatMap((w) => [`vle${w}.v`, `vse${w}.v`, `vlse${w}.v`, `vsse${w}.v`]),
];

/** The instruction a test is of, as the subset spells it: the generator names files vadd_vv-3 (part 3 of vadd.vv). */
export const instrOf = (name: string) => name.replace(/-\d+$/, '').replace(/_/g, '.');

export interface RvvEntry { cases: number; text: number; data: number; blocks?: string }
export interface RvvIndex {
  revision: Record<string, string>;
  toolchain: string;
  dataBase: number;
  rules?: string;
  tests: Record<string, RvvEntry>;
  notApplicable?: Record<string, string>;
}
export type RvvSet = 'v128' | 'v128-gates';
export type RvvImage = RvImage & { cases: number };

export const RVV_DIR = fileURLToPath(new URL('./rvv-tests/', import.meta.url));

export interface RvvSuite { index: RvvIndex; names: string[]; image(name: string): RvvImage }

/** A set from `dir` (default the checked-in one): its index, and each test's image decoded when asked for. */
export function rvvSuite(set: RvvSet, dir = RVV_DIR): RvvSuite {
  const index = JSON.parse(readFileSync(join(dir, `${set}.json`), 'utf8')) as RvvIndex;
  let words: Uint8Array | undefined;
  const at = new Map<string, number>();
  let off = 0;
  for (const [n, t] of Object.entries(index.tests)) { at.set(n, off); off += 4 * (t.text + t.data); }
  const read = (from: number, n: number) => {
    words ??= brotliDecompressSync(readFileSync(join(dir, `${set}.bin.br`)));
    if (words.length !== off) throw new Error(`${set}.bin.br holds ${words.length} bytes, the index ${off}`);
    const v = new DataView(words.buffer, words.byteOffset + from, 4 * n);
    return Array.from({ length: n }, (_, i) => v.getUint32(4 * i, true));
  };
  return {
    index,
    names: Object.keys(index.tests),
    image(name) {
      const t = index.tests[name], o = at.get(name);
      if (!t || o === undefined) throw new Error(`${set}: no test ${name}`);
      return { name, suite: 'rvv', env: 'bare', text: read(o, t.text), data: read(o + 4 * t.text, t.data), dataBase: index.dataBase, cases: t.cases };
    },
  };
}

/**
 * One image on the golden model: `gates` the gate-level unit's subset, counting vector instructions it made illegal
 * no-ops (a narrowed test must not pass by skipping work). The data memory is 2^15 words at least: a strided store with
 * a large stride reaches well past the space the test reserved (Spike's memory is large).
 */
export function runRvv(img: RvImage, gates: boolean, maxSteps = 5_000_000): { pass: boolean; text: string; steps: number; illegal: number } {
  const l = loadable(img, 6, 15);
  const iss = new ISS(l.words, { v: { vlen: 128, ...(gates ? { gates: true } : {}) }, dmemWords: 2 ** l.dmemK, imemWords: 2 ** l.imemK });
  let tohost: number | undefined, illegal = 0;
  while (iss.steps < maxSteps && !iss.halted) {
    const s = iss.step();
    if (s.vIllegal) illegal++;
    if (s.store && ((s.store.addr >>> 2) & (2 ** l.dmemK - 1)) === l.tohost && iss.dmem[l.tohost]) { tohost = iss.dmem[l.tohost]; break; }
  }
  return { ...verdict(tohost, 'bare'), steps: iss.steps, illegal };
}
