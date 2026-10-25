// The official rv64ui / rv64um riscv-tests (tests/verify/riscv-tests/bare64.json) on the RV64 golden model
// (src/riscv/iss64.ts), each loaded as the 64-bit core will get it: the image with the data loader appended
// (tests/verify/images.ts loadable), tohost read from data word 0. Every image runs but those that need what
// the model deliberately lacks (RV64_NOT_APPLICABLE).
import { describe, expect, it } from 'vitest';
import { ISS64 } from '../src/riscv/iss64';
import { images, imageFile, loadable, RV64_NOT_APPLICABLE, verdict } from './verify/images';

describe('riscv-tests on the RV64 golden model', () => {
  const all = images('bare64');

  it('has every rv64ui and rv64um test of the recorded revision', () => {
    const f = imageFile('bare64');
    expect(f.revision['riscv-tests']).toBe(imageFile('bare').revision['riscv-tests']);
    expect(all.filter((i) => i.suite === 'rv64ui').length).toBe(54);
    expect(all.filter((i) => i.suite === 'rv64um').length).toBe(13);
  });

  for (const img of all) {
    const na = RV64_NOT_APPLICABLE[img.name];
    it.skipIf(!!na)(`${img.name}${na ? ` (n/a: ${na})` : ''}`, () => {
      const l = loadable(img);
      const iss = new ISS64(l.words, { m: img.suite === 'rv64um', imemWords: 2 ** l.imemK, dmemWords: 2 ** l.dmemK });
      iss.run(200_000);
      expect(iss.halted, 'halted').toBe(true);
      expect(verdict(iss.dmem[l.tohost], 'bare64').text).toBe('pass');
    });
  }
});
