// The official riscv-tests, prebuilt (scripts/riscv-tests/build.mjs) into tests/verify/riscv-tests/<env>.json,
// and what it takes to run one on a Harvard machine: our CPUs have no loader, so the data section is put
// in place by code appended to the image (lui / addi / sw per non-zero word), reached by retargeting the
// reset jump at address 0 and jumping back to where it went. The tests then find their data exactly where
// they were linked. Encodings are written out here, not assembled by our assembler: nothing of ours
// stands between the official binaries and the hardware. The loader is the same for RV64 (bare64): lui
// sign-extends there, but sw stores the low 32 bits, so the words land as they do on RV32, a doubleword as its
// low and high words, low first, which is how ISS64 and the 64-bit core keep their data memories.

import { readFileSync } from 'node:fs';
import type { Env, RvImage } from '../../src/riscv/rvimage';

export { jal, jalTarget, loadable, verdict } from '../../src/riscv/rvimage';
export type { Env, Loadable, RvImage } from '../../src/riscv/rvimage';

/** bare64 tests whose subject the 64-bit core and its model do not have, with the reason. */
export const RV64_NOT_APPLICABLE: Record<string, string> = {
  'rv64ui-fence_i': 'self-modifying code: the instruction memory is a ROM',
  'rv64ui-ma_data': 'misaligned loads and stores are not supported (an access stays inside its doubleword)',
};

export interface ImageFile {
  env: Env;
  revision: Record<string, string>;
  toolchain: string;
  dataBase: number;
  tests: Record<string, { text: string; data: string; pass?: number; fail?: number }>;
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

