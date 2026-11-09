// The out-of-order model's spec mode (riscv/ooomodel.ts) and the side-channels chapter's Spectre program
// (riscv/sideprograms.ts): the attacker's own program recovers the secret through the cache, and each defence stops it.

import { describe, expect, it } from 'vitest';
import { assemble } from '../src/riscv/asm';
import { BENCHMARKS } from '../src/riscv/benchprograms';
import { ISS } from '../src/riscv/iss';
import { OooModel } from '../src/riscv/ooomodel';
import { MAP, NOTHING, sideConfig, SIDE_MISS, SIDE_OPTS, SIDE_SPEC, spectreWords, type Defence } from '../src/riscv/sideprograms';
import { xorshift32 } from '../src/riscv/benchprograms';

const dmemOf = (m: OooModel) => (m as unknown as { iss: ISS }).iss.dmem;
const byteAt = (dmem: Uint32Array, a: number) => (dmem[a >> 2] >>> (8 * (a & 3))) & 255;

function attack(secret: number[], defence: Defence | 'fill' = 'none') {
  const m = new OooModel(spectreWords(secret, defence === 'fill' ? 'none' : defence), sideConfig(defence), SIDE_OPTS);
  m.run(1_000_000);
  expect(m.halted).toBe(true);
  return { m, out: secret.map((_, k) => byteAt(dmemOf(m), MAP.out + k)) };
}

describe('spec mode: Spectre variant 1 on the model', () => {
  it('the attacker program recovers every secret nibble, over 32 secrets', () => {
    for (let seed = 1; seed <= 32; seed++) {
      const secret = xorshift32(seed * 7919, 4).map((w) => w & 15);
      expect(attack(secret).out, `seed ${seed}`).toEqual(secret);
    }
  });

  it('a fence, a mask or fill-at-commit leaves it nothing', () => {
    const secret = [0xa, 0x3, 0xf, 0x0];
    for (const d of ['fence', 'mask', 'fill'] as const) expect(attack(secret, d).out, d).toEqual(secret.map(() => NOTHING));
  });

  it('the leak goes through the wrong path: the out-of-bounds load ran there and was flushed', () => {
    const { m } = attack([0x5]);
    const lbu = m.history.filter((u) => u.wrong && u.text.startsWith('lbu') && u.addr === MAP.secret);
    expect(lbu.length).toBeGreaterThan(0);
    expect(lbu.every((u) => u.state === 'flushed' && u.x >= 0 && u.value === 5)).toBe(true);
  });
});

describe('spec mode: the machinery', () => {
  it('csrr cycle reads the model and serializes: a miss measures SIDE_MISS − 2 cycles more than a hit', () => {
    const src = `li s1, 0x100
        csrr t0, cycle
        lw   t1, 0(s1)
        csrr t2, cycle
        lw   t1, 0(s1)
        csrr t3, cycle
        sub  a0, t2, t0
        sub  a1, t3, t2
        j    .`;
    const m = new OooModel(assemble(src).words, { spec: SIDE_SPEC }, SIDE_OPTS);
    m.run(10_000);
    const x = (m as unknown as { iss: ISS }).iss.x;
    expect(x[10] - x[11]).toBe(SIDE_MISS - 2);
  });

  it('speculation changes no architectural state: the benchmarks retire the same and leave the same memory', () => {
    for (const b of BENCHMARKS.filter((q) => !q.needs?.f)) {
      const words = assemble(b.source).words, opts = { dmemWords: 1 << 12, imemWords: 1 << 12 };
      const plain = new OooModel(words, {}, opts), spec = new OooModel(words, { spec: SIDE_SPEC }, opts);
      plain.run(); spec.run();
      expect(spec.stats.instructions, b.id).toBe(plain.stats.instructions);
      expect(dmemOf(spec), b.id).toEqual(dmemOf(plain));
      expect(spec.cache!.stats.accesses, b.id).toBeGreaterThan(0);
    }
  });

  it('a wrong-path store reaches no memory', () => {
    // the branch is taken (a0 = 1) but predicted not taken: the store below runs on the wrong path only
    const src = `li a0, 1
        li s1, 0x100
        li t0, 99
        lw t1, 0(s1)
        bnez a0, skip
        sw   t0, 0(s1)
skip:   j skip`;
    const m = new OooModel(assemble(src).words, { spec: SIDE_SPEC }, SIDE_OPTS);
    m.run(10_000);
    expect(m.history.some((u) => u.wrong && u.cls === 'store')).toBe(true);
    expect(dmemOf(m)[0x40]).toBe(0);
  });

  it('with fenceBarrier a fence waits for older branches; without, it does not', () => {
    const src = `li s1, 0x100
        lw t1, 0(s1)
        bnez t1, skip
        fence
        addi t2, t2, 1
skip:   j skip`;
    const run = (fenceBarrier: boolean) => {
      const m = new OooModel(assemble(src).words, { spec: { ...SIDE_SPEC, fenceBarrier } }, SIDE_OPTS);
      m.run(10_000);
      const br = m.history.find((u) => u.text.startsWith('bne'))!, fence = m.history.find((u) => u.text.startsWith('fence'))!;
      return fence.d - br.c;
    };
    expect(run(true)).toBeGreaterThanOrEqual(0); // dispatch runs after commit: the cycle the branch leaves at the earliest
    expect(run(false)).toBeLessThan(0);
  });
});
