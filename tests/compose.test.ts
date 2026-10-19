// The instruction composer's model against the assembler and decoder: every instruction, random
// operands, both ways.

import { describe, expect, it } from 'vitest';
import { assemble } from '../src/riscv/asm';
import { clampTo, encodeParts, FIXED, NO_PARTS, PALETTE, parseLine, partsOf, retarget, slotsOf, textOf, type Parts } from '../src/riscv/compose';
import { BY_NAME, disasm, INSTRS } from '../src/riscv/isa';

let seed = 12345;
const rnd = (n: number) => {
  seed = (seed * 1103515245 + 12345) >>> 0;
  return Math.floor((seed / 2 ** 32) * n);
};
const RMS = [0, 1, 2, 3, 4, 7];

function randomParts(name: string): Parts {
  const spec = BY_NAME.get(name)!;
  const p: Parts = { rd: rnd(32), rs1: rnd(32), rs2: rnd(32), rs3: rnd(32), imm: 0, csr: rnd(0x1000), rm: RMS[rnd(RMS.length)] };
  for (const s of slotsOf(spec)) if (s.key === 'imm') p.imm = clampTo(s, s.min! + rnd(s.max! - s.min! + 1));
  return p;
}

describe('composer model', () => {
  it('every instruction: encode → decode → the same word, and the assembler agrees with its text', () => {
    for (const spec of INSTRS) {
      for (let t = 0; t < 40; t++) {
        const p = randomParts(spec.name);
        const w = encodeParts(spec, p);
        const back = partsOf(w);
        expect(back?.spec.name, `${spec.name} ${w.toString(16)}`).toBe(spec.name);
        expect(encodeParts(back!.spec, back!.parts)).toBe(w);
        const r = assemble(disasm(w));
        expect(r.errors, disasm(w)).toEqual([]);
        expect(r.words[0] >>> 0, disasm(w)).toBe(w);
      }
    }
  });

  it('fixed words have no operands, and other words with the same opcode are not them', () => {
    for (const [name, w] of Object.entries(FIXED)) {
      expect(slotsOf(BY_NAME.get(name)!)).toEqual([]);
      expect(partsOf(w)?.spec.name).toBe(name);
    }
    expect(partsOf(0x0000000f)).toBeNull(); // a fence with other ordering bits
  });

  it('bits the composer cannot set are refused, not dropped', () => {
    expect(partsOf(0x0645a52f | (1 << 26))).toBeNull(); // amoadd.w with aq set
    expect(partsOf(0xffffffff)).toBeNull();
  });

  it('retargeting clamps the immediate to the new instruction', () => {
    const p = { ...NO_PARTS, imm: 3000 };
    expect(retarget(p, BY_NAME.get('addi')!).imm).toBe(2047);
    expect(retarget({ ...p, imm: -7 }, BY_NAME.get('beq')!).imm).toBe(-6);
    expect(retarget({ ...p, imm: 40 }, BY_NAME.get('slli')!).imm).toBe(31);
  });

  it('branch targets read and write labels', () => {
    const labels = new Map([['loop', 4]]);
    const r = parseLine('bne a1, zero, loop', assemble, 20, labels);
    if (!('word' in r)) throw new Error('no word');
    expect(r.word).toBe(assemble('nop\nloop: nop\nnop\nnop\nnop\nbne a1, zero, loop').words[5] >>> 0);
    expect(textOf(r.word, 20, labels)).toBe('bne a1, zero, loop');
    expect(textOf(r.word)).toBe('bne a1, zero, -16');
  });

  it('parses hex, keeps pseudo-instructions whole, reports errors', () => {
    expect(parseLine('0xfff50513', assemble)).toEqual({ word: 0xfff50513 });
    expect(parseLine('  loop: addi a0, a0, -1  # note', assemble)).toEqual({ word: 0xfff50513 });
    const li = parseLine('li a0, 0x12345678', assemble);
    expect('words' in li && li.words.length).toBe(2);
    expect('error' in parseLine('frob a0', assemble)).toBe(true);
  });

  it('the palette names real instructions, each once', () => {
    const names = PALETTE.flatMap((g) => g.names);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(BY_NAME.has(n), n).toBe(true);
  });
});

describe('program editor: lines rewritten around the built instruction', () => {
  it('keeps the label, indentation and comment', async () => {
    const { codeIndent, splitLine, withCode } = await import('../src/editor/romcompose');
    expect(splitLine('loop:   add t0, t0, t1   # sum')).toEqual({ prefix: 'loop:   ', code: 'add t0, t0, t1', comment: '   # sum' });
    expect(withCode('loop:   add t0, t0, t1   # sum', 'sub t0, t0, t1')).toBe('loop:   sub t0, t0, t1   # sum');
    expect(withCode('        lw a0, 0(a1)', 'lw a0, 4(a1)')).toBe('        lw a0, 4(a1)');
    expect(withCode('add a0, a0, a1', 'nop')).toBe('nop');
    expect(withCode('        bogus a0#x', 'nop')).toBe('        nop #x');
    expect(codeIndent('loop:')).toBe(' '.repeat(8));
    expect(codeIndent('    addi a0, a0, 1')).toBe('    ');
    expect(codeIndent('')).toBe(' '.repeat(8));
  });
});
