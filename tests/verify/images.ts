// The official riscv-tests, prebuilt (scripts/riscv-tests/build.mjs) into tests/verify/riscv-tests/<env>.json,
// and what it takes to run one on a Harvard machine: our CPUs have no loader, so the data section is put
// in place by code appended to the image (lui / addi / sw per non-zero word), reached by retargeting the
// reset jump at address 0 and jumping back to where it went. The tests then find their data exactly where
// they were linked. Encodings are written out here, not assembled by our assembler: nothing of ours
// stands between the official binaries and the hardware.

import { readFileSync } from 'node:fs';

export type Env = 'p' | 'bare' | 'bare-mp';

export interface ImageFile {
  env: Env;
  revision: Record<string, string>;
  toolchain: string;
  dataBase: number;
  tests: Record<string, { text: string; data: string; pass?: number; fail?: number }>;
}

export interface RvImage {
  /** e.g. rv32ui-add */
  name: string;
  suite: string;
  env: Env;
  text: number[];
  data: number[];
  dataBase: number;
}

const words = (b64: string): number[] => {
  const b = Buffer.from(b64, 'base64'), out: number[] = [];
  for (let i = 0; i < b.length; i += 4) out.push(b.readUInt32LE(i));
  return out;
};

const files = new Map<Env, ImageFile>();
export function imageFile(env: Env): ImageFile {
  let f = files.get(env);
  if (!f) files.set(env, (f = JSON.parse(readFileSync(new URL(`./riscv-tests/${env}.json`, import.meta.url), 'utf8')) as ImageFile));
  return f;
}

export function images(env: Env, suite?: string): RvImage[] {
  const f = imageFile(env);
  return Object.entries(f.tests).filter(([n]) => !suite || n.startsWith(`${suite}-`))
    .map(([name, t]) => ({ name, suite: name.split('-')[0], env, text: words(t.text), data: words(t.data), dataBase: f.dataBase }));
}

export function image(env: Env, name: string): RvImage {
  const img = images(env).find((i) => i.name === name);
  if (!img) throw new Error(`no riscv-test ${name} in ${env}`);
  return img;
}

// ---- RV32I encodings ----------------------------------------------------------------------
const T0 = 5, T1 = 6;
const lui = (rd: number, hi20: number) => ((hi20 & 0xfffff) << 12 | rd << 7 | 0x37) >>> 0;
const addi = (rd: number, rs: number, imm: number) => ((imm & 0xfff) << 20 | rs << 15 | rd << 7 | 0x13) >>> 0;
const sw = (rs2: number, rs1: number, imm: number) => (((imm >> 5) & 0x7f) << 25 | rs2 << 20 | rs1 << 15 | 2 << 12 | (imm & 0x1f) << 7 | 0x23) >>> 0;
export function jal(rd: number, off: number): number {
  return ((off >> 20 & 1) << 31 | (off >> 1 & 0x3ff) << 21 | (off >> 11 & 1) << 20 | (off >> 12 & 0xff) << 12 | rd << 7 | 0x6f) >>> 0;
}
/** The target of a jal at pc. */
export function jalTarget(word: number, pc: number): number {
  const imm = ((word >> 31) & 1) << 20 | ((word >> 12) & 0xff) << 12 | ((word >> 20) & 1) << 11 | ((word >> 21) & 0x3ff) << 1;
  return (pc + ((imm << 11) >> 11)) >>> 0;
}

/** Load a 32-bit constant into rd: addi alone when it fits, else lui + addi. */
function li(rd: number, v: number): number[] {
  v |= 0;
  if (v >= -2048 && v < 2048) return [addi(rd, 0, v)];
  const lo = (v << 20) >> 20, hi = ((v - lo) >>> 12) & 0xfffff;
  return lo ? [lui(rd, hi), addi(rd, rd, lo)] : [lui(rd, hi)];
}

const log2up = (n: number) => Math.max(0, Math.ceil(Math.log2(Math.max(1, n))));

export interface Loadable {
  /** Instruction memory contents (the image, then the data loader). */
  words: number[];
  /** Address bits of the instruction and data memories (2^k words). */
  imemK: number;
  dmemK: number;
  /** Data-memory word index of tohost. */
  tohost: number;
}

/**
 * The image as a ROM program for a CPU whose data memory has 2^dmemK words, with dmemK at least
 * `minDmemK` and large enough for the data section (which the data memory must hold without wrapping).
 */
export function loadable(img: RvImage, minImemK = 6, minDmemK = 5): Loadable {
  const text = img.text.slice();
  const first = text[0];
  if ((first & 0xfff) !== 0x06f) throw new Error(`${img.name}: word 0 is not a jal x0`);
  const start = text.length, back = jalTarget(first, 0);
  const loader: number[] = [lui(T1, img.dataBase >>> 12)];
  img.data.forEach((w, i) => { if (w) loader.push(...li(T0, w), sw(T0, T1, 4 * i)); });
  loader.push(addi(T0, 0, 0), addi(T1, 0, 0));
  loader.push(jal(0, back - 4 * (start + loader.length)));
  text[0] = jal(0, 4 * start);
  const all = [...text, ...loader];
  return { words: all, imemK: Math.max(minImemK, log2up(all.length)), dmemK: Math.max(minDmemK, log2up(img.data.length)), tohost: 0 };
}

/** What a test wrote to tohost: 1 passes; (n << 1) | 1 fails test n; env p writes 1337 | n on an unexpected trap. */
export function verdict(tohost: number | undefined, env: Env): { pass: boolean; text: string } {
  if (!tohost) return { pass: false, text: 'no result' };
  if (tohost === 1) return { pass: true, text: 'pass' };
  if (env === 'p' && (tohost & 1337) === 1337) return { pass: false, text: `unexpected trap (tohost = ${tohost} = test | 1337)` };
  if (tohost & 1 && tohost < 4096) return { pass: false, text: `fails test ${tohost >>> 1}` };
  return { pass: false, text: `tohost = 0x${(tohost >>> 0).toString(16)}` };
}
