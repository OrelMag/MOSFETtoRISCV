// FastISS's MAC (IssOptions.mac) against the golden model, in lock step: after every step the registers, the PC and the 40-bit accumulator agree, on random
// programs made of mac, mac2, clracc and racc (every shift 0 … 63) over edge and random operands, on long runs that wrap the accumulator, and on words that are
// on custom-2 but none of the four (they do nothing on either).

import { describe, expect, it } from 'vitest';
import { assemble } from '../src/riscv/asm';
import { ISS } from '../src/riscv/iss';
import { FastISS } from '../src/riscv/fastiss';
import { rng } from '../src/riscv/randprog32';

const EDGE = [0, 1, -1, 0x7fff, -0x8000, 0x7fff7fff, 0x80008000 | 0, 0xffff, 0x8000, 0x12345678, 0xdeadbeef | 0, 0x7fffffff, 0x80000000 | 0];

function lockStep(src: string, maxSteps: number): string {
  const p = assemble(src, [], { mac: true });
  expect(p.errors).toEqual([]);
  const opts = { mac: true, m: true, imemWords: 1 << 12, dmemWords: 64 };
  const g = new ISS(p.words, opts), f = new FastISS(p.words, opts);
  for (let s = 0; s < maxSteps && !g.halted; s++) {
    const pc = g.pc, info = g.step();
    f.step();
    const where = `step ${s} pc 0x${pc.toString(16)} ${info.text}`;
    if (f.pc !== g.pc) return `${where}: pc`;
    for (let r = 0; r < 32; r++) if (f.x[r] !== g.x[r]) return `${where}: x${r} 0x${f.x[r].toString(16)} ≠ 0x${g.x[r].toString(16)}`;
    if (f.acc !== g.acc) return `${where}: acc ${f.acc} ≠ ${g.acc}`;
  }
  return '';
}

describe('FastISS with the MAC core', () => {
  it('equals the golden model on random programs of the four instructions', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const u = rng(seed), pick = <T>(a: readonly T[]) => a[Math.floor(u() * a.length)];
      const lines: string[] = [];
      for (let i = 0; i < 300; i++) {
        const r = u();
        const reg = () => `a${Math.floor(u() * 6)}`;
        if (r < 0.3) lines.push(`li ${reg()}, ${u() < 0.5 ? pick(EDGE) : (Math.floor(u() * 2 ** 32) | 0)}`);
        else if (r < 0.55) lines.push(`mac ${reg()}, ${reg()}`);
        else if (r < 0.8) lines.push(`mac2 ${reg()}, ${reg()}`);
        else if (r < 0.88) lines.push('clracc');
        else { lines.push(`li s1, ${u() < 0.7 ? Math.floor(u() * 64) : pick([0, 15, 39, 40, 63, 64, 95])}`, `racc ${reg()}, s1`); }
      }
      lines.push('end: j end');
      expect(lockStep(lines.join('\n'), 5000), `seed ${seed}`).toBe('');
    }
  });

  it('wraps the 40-bit accumulator and saturates racc like the golden model', () => {
    // extreme products added ten thousand times: the sum wraps several times; then every shift is read
    const reads = Array.from({ length: 64 }, (_, k) => `li s1, ${k}\nracc t${k % 3}, s1`).join('\n');
    const src = `li a0, 0x80008000\nli a1, 0x80008000\nli s2, 10000\nl: mac2 a0, a1\nmac a0, a1\naddi s2, s2, -1\nbnez s2, l\n${reads}\nli a0, 0x7fff7fff\nli a1, 0x7fff7fff\nli s2, 5000\nm: mac2 a0, a1\naddi s2, s2, -1\nbnez s2, m\n${reads}\nclracc\n${reads}\nend: j end`;
    expect(lockStep(src, 200_000)).toBe('');
  });

  it('a word on custom-2 that is none of the four does nothing on either', () => {
    // funct3 = 4 and funct7 != 0 on opcode 0x5b, written as .word
    const src = `li a0, 7\nli a1, 9\nmac a0, a1\n.word ${(0x5b | (4 << 12) | (10 << 15) | (11 << 20)) >>> 0}\n.word ${(0x5b | (0 << 12) | (10 << 15) | (11 << 20) | (1 << 25)) >>> 0}\nli s1, 0\nracc a2, s1\nend: j end`;
    expect(lockStep(src, 100)).toBe('');
  });

  it('without the option the four instructions are not decoded (no accumulator moves)', () => {
    const p = assemble('li a0, 3\nli a1, 4\nmac a0, a1\nend: j end', [], { mac: true });
    const f = new FastISS(p.words, { imemWords: 64, dmemWords: 16 });
    f.run(10);
    expect(f.acc).toBe(0n);
  });
});
