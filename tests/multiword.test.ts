// The muldiv chapter's multi-word arithmetic on the golden model, against BigInt.

import { describe, expect, it } from 'vitest';
import { assemble } from '../src/riscv/asm';
import { ISS } from '../src/riscv/iss';
import { MULTIWORD_BODY, MULTIWORD_SIGNED_BODY, MULTIWORD_SOURCE } from '../src/riscv/multiword';

const M64 = (1n << 64n) - 1n;
const M128 = (1n << 128n) - 1n;
const words = (v: bigint) => [Number(v & 0xffffffffn), Number((v >> 32n) & 0xffffffffn)];
const u = (n: number) => BigInt(n >>> 0);
const run = (body: string, a: bigint, b: bigint) => {
  const [a0, a1] = words(a), [b0, b1] = words(b);
  const iss = new ISS(assemble(`li a0, ${a0 | 0}\nli a1, ${a1 | 0}\nli a2, ${b0 | 0}\nli a3, ${b1 | 0}\n${body}\nhalt: j halt`).words, { m: true } as never);
  iss.run(1000);
  const r = (i: number) => u(iss.x[i]);
  return {
    steps: iss.steps - 1,
    sum: (r(21) << 32n) | r(20),
    diff: (r(23) << 32n) | r(22),
    prod: (r(19) << 96n) | (r(18) << 64n) | (r(9) << 32n) | r(8),
  };
};

describe('multi-word arithmetic on RV32IM', () => {
  it('the chapter program: sum, difference and product of 0x1_FFFFFFFF and 0x2_00000003', () => {
    const iss = new ISS(assemble(MULTIWORD_SOURCE).words, { m: true } as never);
    iss.run(1000);
    expect(iss.steps - 1).toBe(34);
    const A = 0x1ffffffffn, B = 0x200000003n;
    const r = run(MULTIWORD_BODY, A, B);
    expect(r.sum).toBe((A + B) & M64);
    expect(r.diff).toBe((B - A) & M64);
    expect(r.prod).toBe(A * B);
    expect([iss.x[21], iss.x[20]]).toEqual([4, 2]);
    expect(r.steps).toBe(34);
  });

  it('seeded random operands and the edge words, unsigned and signed', () => {
    let s = 0x2545f491;
    const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return BigInt(s >>> 0); };
    const edge = [0n, 1n, 0xffffffffn, 0x100000000n, 0x7fffffffffffffffn, 0x8000000000000000n, M64];
    const vals = [...edge, ...Array.from({ length: 12 }, () => (rnd() << 32n) | rnd())];
    for (const a of vals) for (const b of vals.slice(0, 12)) {
      const r = run(MULTIWORD_BODY, a, b);
      expect(r.sum, `${a} + ${b}`).toBe((a + b) & M64);
      expect(r.diff, `${b} - ${a}`).toBe((b - a) & M64);
      expect(r.prod, `${a} * ${b}`).toBe(a * b);
      const sg = (v: bigint) => BigInt.asIntN(64, v);
      expect(run(MULTIWORD_SIGNED_BODY, a, b).prod, `signed ${a} * ${b}`).toBe((sg(a) * sg(b)) & M128);
    }
  });

  it('what the prose quotes: 8 M instructions and 22 in all for the product; the signed one 4 more', () => {
    const lines = (b: string) => b.split('\n').filter((l) => l.trim());
    const mnem = (l: string) => l.trim().split(/\s+/)[0];
    const prod = lines(MULTIWORD_BODY).slice(8);
    expect(prod.length).toBe(22);
    expect(prod.filter((l) => /^mul/.test(mnem(l))).length).toBe(8);
    expect(lines(MULTIWORD_BODY).slice(0, 4).map(mnem)).toEqual(['add', 'sltu', 'add', 'add']);
    expect(lines(MULTIWORD_SIGNED_BODY).length).toBe(26);
  });
});

describe('the codex entry quotes what the program measures', async () => {
  const { codexById } = await import('../src/campaign/codex');
  it('4, 4, 22 and 26 instructions', () => {
    const t = codexById('multiword')!.body;
    expect(t).toContain('4 instructions');
    expect(t).toContain('22 in all, 26 signed');
    expect(t).toContain('eight <code>mul</code>');
  });
});

describe('the step quotes the program\'s own sum and product', () => {
  it('A = 0x1_FFFFFFFF, B = 0x2_00000003: the text\'s sum and product are the BigInt ones', async () => {
    const { chMulDiv, wordsHex } = await import('../src/chapters/ch-muldiv');
    const A = 0x1ffffffffn, B = 0x200000003n;
    const hex = (v: bigint) => { const ws: number[] = []; for (let i = 3; i >= 0; i--) ws.push(Number((v >> BigInt(32 * i)) & 0xffffffffn)); return wordsHex(ws); };
    expect(hex(A + B)).toBe('0x4_00000002');
    expect(hex(A * B)).toBe('0x4_00000003_FFFFFFFD');
    const body = chMulDiv.steps.find((s) => s.title === 'Words wider than the word')!.body;
    expect(body).toContain(`The sum is ${hex(A + B)}:`);
    expect(body).toContain(`A and B here give ${hex(A * B)},`);
    expect(MULTIWORD_SOURCE).toContain('0x1_FFFFFFFF');
  });
});
