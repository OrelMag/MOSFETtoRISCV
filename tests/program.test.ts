import { describe, expect, it } from 'vitest';
import { buildProgram } from '../src/editor/program';
import { assemble } from '../src/riscv/asm';
import { disasm } from '../src/riscv/isa';
import { PROGRAMS } from '../src/riscv/programs';
import { SYSTEM_PROGRAMS } from '../src/riscv/sysprograms';

const hexOf = (ws: number[]) => ws.map((w) => w.toString(16).padStart(8, '0')).join('\n');

describe('buildProgram: asm', () => {
  it('matches assemble() word for word and line for line', () => {
    for (const p of [...PROGRAMS, ...SYSTEM_PROGRAMS]) {
      const a = assemble(p.source), b = buildProgram('asm', p.source);
      expect(b.words).toEqual(a.words);
      expect(b.errors).toEqual([]);
      expect(b.lines.map((l) => [l.addr, l.word, l.srcLine])).toEqual(a.lines.map((l) => [l.addr, l.word, l.srcLine]));
      expect(b.lines.map((l) => l.text)).toEqual(a.lines.map((l) => disasm(l.word, l.addr)));
    }
  });

  it('reports assembler errors with their line', () => {
    const r = buildProgram('asm', 'nop\n  frob a0\naddi a0, a0, 5000');
    expect(r.errors.map((e) => e.line)).toEqual([2, 3]);
  });

  it('a program survives asm -> hex -> words', () => {
    const a = buildProgram('asm', PROGRAMS[0].source);
    const h = buildProgram('hex', hexOf(a.words));
    expect(h.errors).toEqual([]);
    expect(h.words).toEqual(a.words);
    expect(h.lines.map((l) => l.text)).toEqual(a.lines.map((l) => l.text));
  });
});

describe('buildProgram: hex', () => {
  it('words separated by whitespace, newlines and commas; 0x optional; comments', () => {
    const r = buildProgram('hex', '00000013, 0x00500513 # li a0, 5\n// comment\n  DEAD_BEEF\t1');
    expect(r.errors).toEqual([]);
    expect(r.words).toEqual([0x13, 0x00500513, 0xdeadbeef, 1]);
    expect(r.lines.map((l) => [l.addr, l.srcLine])).toEqual([[0, 1], [4, 1], [8, 3], [12, 3]]);
    expect(r.lines[0].text).toBe('nop');
    expect(r.lines[1].text).toBe(disasm(0x00500513, 4));
  });

  it('@index moves to a word index; gaps are zero and point at the marker', () => {
    const r = buildProgram('hex', '13\n@4\n00100093\n@2 7');
    expect(r.errors).toEqual([]);
    expect(r.words).toEqual([0x13, 0, 7, 0, 0x00100093]);
    expect(r.lines.map((l) => l.srcLine)).toEqual([1, 2, 4, 2, 3]);
    expect(r.lines.map((l) => l.addr)).toEqual([0, 4, 8, 12, 16]);
  });

  it('errors carry 1-based lines: bad tokens, > 32 bits, rewrites, bad markers', () => {
    const r = buildProgram('hex', '13\nxyz 13\n1_0000_0000\n@0 5\n@\n@zz');
    expect(r.errors.map((e) => e.line)).toEqual([2, 3, 4, 5, 6]);
    expect(r.errors[0].message).toMatch(/xyz/);
    expect(r.errors[1].message).toMatch(/32 bits/);
    expect(r.errors[2].message).toMatch(/already set on line 1/);
  });

  it('refuses absurd addresses instead of allocating them', () => {
    const r = buildProgram('hex', '@ffffffff 13');
    expect(r.errors).toHaveLength(1);
    expect(r.words.length).toBeLessThan(2);
  });

  it('empty source: no words, no errors', () => {
    expect(buildProgram('hex', '')).toEqual({ words: [], errors: [], lines: [] });
    expect(buildProgram('asm', '# nothing')).toEqual({ words: [], errors: [], lines: [] });
  });
});
