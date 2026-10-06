import { describe, expect, it } from 'vitest';
import { assemble, PSEUDO_OPS } from '../src/riscv/asm';
import { ABI, BY_NAME, FABI } from '../src/riscv/isa';
import { CACHE_CPU_PROGRAMS, TRACE_PROGRAMS } from '../src/riscv/cprograms';
import { F_PROGRAMS } from '../src/riscv/fprograms';
import { MC_PROGRAMS } from '../src/riscv/mcprograms';
import { M_PROGRAMS } from '../src/riscv/mprograms';
import { PROGRAMS } from '../src/riscv/programs';
import { SYSTEM_PROGRAMS } from '../src/riscv/sysprograms';
import { tokenize, type CodeLang, type Tok } from '../src/widgets/codetok';

/** Non-whitespace tokens as "cls:text". */
const sig = (line: string, lang: CodeLang = 'rvasm') =>
  tokenize(line, lang).filter((t) => t.text.trim()).map((t) => `${t.cls}:${t.text.trim()}`);
const join = (ts: Tok[]) => ts.map((t) => t.text).join('');

const ALL = [...PROGRAMS, ...SYSTEM_PROGRAMS, ...M_PROGRAMS, ...F_PROGRAMS, ...MC_PROGRAMS, ...TRACE_PROGRAMS, ...CACHE_CPU_PROGRAMS];

describe('rvasm tokenizer', () => {
  it('labels, mnemonics, registers, numbers, punctuation', () => {
    expect(sig('loop:   add  a0, a0, t0     # sum += i')).toEqual([
      'lbl:loop:', 'op:add', 'reg:a0', 'pun:,', 'reg:a0', 'pun:,', 'reg:t0', 'com:# sum += i',
    ]);
    expect(sig('a: b : sw x5, -4(sp)')).toEqual(['lbl:a:', 'lbl:b', 'lbl::', 'op:sw', 'reg:x5', 'pun:,', 'num:-4', 'pun:(', 'reg:sp', 'pun:)']);
  });

  it('pseudo-instructions, directives, label uses', () => {
    expect(sig('  li t0, 0x1234_5678')).toEqual(['ps:li', 'reg:t0', 'pun:,', 'num:0x1234_5678']);
    expect(sig('  bnez a0, loop')).toEqual(['ps:bnez', 'reg:a0', 'pun:,', 'sym:loop']);
    expect(sig('ret')).toEqual(['ps:ret']);
    expect(sig('.word 1, 0b1010, done')).toEqual(['dir:.word', 'num:1', 'pun:,', 'num:0b1010', 'pun:,', 'sym:done']);
    expect(sig('.text')).toEqual(['dir:.text']);
    expect(sig('.bogus 3')[0]).toBe('bad:.bogus');
    expect(sig('frob a0')[0]).toBe('bad:frob');
  });

  it('every pseudo-op is accepted by the assembler, every real instruction is an op', () => {
    for (const op of PSEUDO_OPS) {
      expect(assemble(op).errors.map((e) => e.message).join()).not.toMatch(/unknown instruction/);
      expect(sig(op)[0]).toBe(`ps:${op}`);
    }
    for (const op of BY_NAME.keys()) expect(sig(`${op.toUpperCase()} x1`)[0]).toBe(`op:${op.toUpperCase()}`);
  });

  it('register names: x, ABI, fp, f, FABI', () => {
    for (const r of ['x0', 'x31', 'fp', 'f0', 'f31', ...ABI, ...FABI]) expect(sig(`mv ${r}`)[1]).toBe(`reg:${r}`);
    expect(sig('mv x32')[1]).toBe('sym:x32');
  });

  it('CSR names and rounding modes', () => {
    expect(sig('csrrw t0, mscratch, t1')).toEqual(['op:csrrw', 'reg:t0', 'pun:,', 'csr:mscratch', 'pun:,', 'reg:t1']);
    expect(sig('fadd.s fa0, fa1, fa2, rtz').at(-1)).toBe('kw:rtz');
  });

  it('numbers: decimal, hex, binary, underscores, char literals, malformed', () => {
    expect(sig('li a0, 1_000')[3]).toBe('num:1_000');
    expect(sig('li a0, -0x80')[3]).toBe('num:-0x80');
    expect(sig("li a0, 'A'")[3]).toBe("num:'A'");
    expect(sig('li a0, 0x1g')[3]).toBe('bad:0x1g');
    expect(sig('li a0, 12ab')[3]).toBe('bad:12ab');
  });

  it('comments in all three styles, as the assembler strips them', () => {
    expect(sig('nop # a')).toEqual(['ps:nop', 'com:# a']);
    expect(sig('nop ; a')).toEqual(['ps:nop', 'com:; a']);
    expect(sig('nop // a')).toEqual(['ps:nop', 'com:// a']);
    expect(sig('# whole line')).toEqual(['com:# whole line']);
    // A comment character inside a character literal is data, exactly as in asm.ts.
    expect(sig("li a0, '#' # hash")).toEqual(['ps:li', 'reg:a0', 'pun:,', "num:'#'", 'com:# hash']);
    expect(assemble("li a0, '#' # hash").errors).toEqual([]);
  });

  it('tokens rebuild every line of every sample program, with nothing flagged', () => {
    for (const p of ALL) {
      for (const line of p.source.split('\n')) {
        const ts = tokenize(line, 'rvasm');
        expect(join(ts)).toBe(line);
        expect(ts.filter((t) => t.cls === 'bad'), `${p.id}: ${line}`).toEqual([]);
      }
    }
  });
});

describe('hex tokenizer', () => {
  it('words, @addr markers, separators, comments', () => {
    expect(sig('@10 00000013, 0xDEADBEEF  // two words', 'hex')).toEqual(['addr:@10', 'num:00000013', 'pun:,', 'num:0xDEADBEEF', 'com:// two words']);
    expect(sig('# only a comment', 'hex')).toEqual(['com:# only a comment']);
    expect(sig('dead_beef 1', 'hex')).toEqual(['num:dead_beef', 'num:1']);
  });

  it('flags malformed and oversized words', () => {
    expect(sig('123456789 0x 12g4 @ @zz', 'hex')).toEqual(['bad:123456789', 'bad:0x', 'bad:12g4', 'bad:@', 'bad:@zz']);
    expect(sig('000000001', 'hex')).toEqual(['num:000000001']); // leading zeros do not count
  });

  it('tokens rebuild the line', () => {
    for (const line of ['', '   ', '@0\t13 , 13', 'ff//c', 'x#y']) expect(join(tokenize(line, 'hex'))).toBe(line);
  });
});
