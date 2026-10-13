// The 6502 assembler and disassembler (src/m6502/asm.ts, isa.ts).
import { describe, expect, it } from 'vitest';
import { assemble, toImage } from '../src/m6502/asm';
import { disasm, disasmAt, fields, MODES, OPCODES, opcodeOf } from '../src/m6502/isa';
import { PROGRAMS } from '../src/m6502/programs';

const bytes = (src: string) => {
  const r = assemble(src);
  expect(r.errors).toEqual([]);
  return r.segments.flatMap((s) => [...s.bytes]);
};
const errs = (src: string) => assemble(src).errors;

describe('isa table', () => {
  it('has the 151 documented opcodes with consistent lengths', () => {
    const ops = OPCODES.filter((o) => o);
    expect(ops.length).toBe(151);
    expect(new Set(ops.map((o) => o!.mnemonic)).size).toBe(56);
    for (const o of ops) expect(o!.bytes).toBe(MODES[o!.mode].bytes);
    expect(opcodeOf('lda', 'imm')).toBe(0xa9);
    expect(opcodeOf('STA', 'imm')).toBeUndefined();
    expect(OPCODES[0x7d]).toMatchObject({ mnemonic: 'ADC', mode: 'abx', cycles: 4, pageCross: true });
    expect(OPCODES[0x9d]).toMatchObject({ mnemonic: 'STA', cycles: 5, pageCross: false, access: 'w' });
    expect(fields(0xb1)).toEqual({ aaa: 5, bbb: 4, cc: 1 });
  });

  it('disassembles and reassembles every opcode', () => {
    for (const o of OPCODES) {
      if (!o) continue;
      const pc = 0x1230;
      const raw = [o.op, o.mode === 'rel' ? 0xf0 : 0x34, 0x12].slice(0, o.bytes);
      const text = disasm(raw, pc);
      expect(bytes(`*= ${pc}\n ${text}`), `${o.op.toString(16)} ${text}`).toEqual(raw);
      expect(disasmAt((a) => raw[a - pc] ?? 0, pc)).toEqual({ text, bytes: o.bytes });
    }
  });

  it('formats operands', () => {
    expect(disasm([0xbd, 0x34, 0x12], 0)).toBe('LDA $1234,X');
    expect(disasm([0xd0, 0xfe], 0x0200)).toBe('BNE $0200');
    expect(disasm([0xd0, 0x00], 0x0200)).toBe('BNE $0202');
    expect(disasm([0xb1, 0x80], 0)).toBe('LDA ($80),Y');
    expect(disasm([0x0a], 0)).toBe('ASL A');
    expect(disasm([0x6c, 0xfc, 0xff], 0)).toBe('JMP ($FFFC)');
    expect(disasm([0x02], 0)).toBe('.byte $02');
  });
});

describe('assembler', () => {
  it('assembles every addressing mode', () => {
    expect(bytes(`
      nop
      asl
      asl a
      lda #$12
      lda $12
      lda $12,x
      ldx $12,y
      lda $1234
      lda $1234,X
      lda $1234,Y
      lda ($12,X)
      lda ($12),Y
      jmp ($1234)
    `)).toEqual([
      0xea, 0x0a, 0x0a, 0xa9, 0x12, 0xa5, 0x12, 0xb5, 0x12, 0xb6, 0x12, 0xad, 0x34, 0x12, 0xbd, 0x34, 0x12,
      0xb9, 0x34, 0x12, 0xa1, 0x12, 0xb1, 0x12, 0x6c, 0x34, 0x12,
    ]);
  });

  it('chooses zero page only for known values below $100 with a zero-page form', () => {
    expect(bytes('lda $0012')).toEqual([0xa5, 0x12]);
    expect(bytes('lda $12,y')).toEqual([0xb9, 0x12, 0x00]); // no LDA zp,Y
    expect(bytes('jmp $12')).toEqual([0x4c, 0x12, 0x00]);
    expect(bytes('ZP = $80\n lda ZP')).toEqual([0xa5, 0x80]);
    // A forward reference is absolute in both passes, even when it turns out small.
    const r = assemble('lda later\nlater = $10\n');
    expect(r.errors).toEqual([]);
    expect([...r.segments[0].bytes]).toEqual([0xad, 0x10, 0x00]);
    const f = assemble('*= $10\n lda fwd\n fwd: rts');
    expect(f.symbols.get('fwd')).toBe(0x13);
    expect([...f.segments[0].bytes]).toEqual([0xad, 0x13, 0x00, 0x60]);
    // Zero-page only forms: an error when the value does not fit.
    expect(bytes('stx $10,y')).toEqual([0x96, 0x10]);
    expect(errs('stx $1234,y')[0].message).toMatch(/not a zero-page address/);
  });

  it('labels, origin, data directives and the listing', () => {
    const r = assemble(`; comment line
      *= $0300
start:  ldx #len        ; a constant defined later
loop:   dex
        bne loop
        jmp start
msg:    .text "AB;C", 'D'
        .byte 1, $FF, -1, "\\n"
        .word $1234, msg
        .fill 3, $EA
len = * - msg
`);
    expect(r.errors).toEqual([]);
    expect(r.origin).toBe(0x300);
    expect(r.symbols.get('start')).toBe(0x300);
    expect(r.symbols.get('loop')).toBe(0x302);
    expect(r.symbols.get('msg')).toBe(0x308);
    expect(r.symbols.get('len')).toBe(16);
    expect(r.segments.length).toBe(1);
    expect([...r.segments[0].bytes]).toEqual([
      0xa2, 16, 0xca, 0xd0, 0xfd, 0x4c, 0x00, 0x03,
      0x41, 0x42, 0x3b, 0x43, 0x44, 0x01, 0xff, 0xff, 0x0a, 0x34, 0x12, 0x08, 0x03, 0xea, 0xea, 0xea,
    ]);
    expect(r.lines.length).toBe(12);
    expect(r.lines[3]).toMatchObject({ line: 4, addr: 0x302, bytes: [0xca] });
    expect(r.lines[0]).toMatchObject({ line: 1, bytes: [] });
  });

  it('expressions', () => {
    expect(bytes(`
      V = $1234
      lda #<V
      lda #>V
      lda #<V+1        ; low byte of V+1
      lda #(2+3)*4
      lda #100/7
      lda #-1
      lda #%1010
      lda #'A'
      lda #'A'+1
      lda (V-$1234+$10),y
      lda (V-$1230)*2,x
    `)).toEqual([
      0xa9, 0x34, 0xa9, 0x12, 0xa9, 0x35, 0xa9, 20, 0xa9, 14, 0xa9, 0xff, 0xa9, 10, 0xa9, 65, 0xa9, 66,
      0xb1, 0x10, 0xb5, 8,
    ]);
    expect(bytes('*= $400\n here: jmp *\n .word *+2')).toEqual([0x4c, 0x00, 0x04, 0x05, 0x04]);
  });

  it('branches: offsets and range', () => {
    expect(bytes('*= $200\n back: nop\n beq back\n bne fwd\n nop\n fwd: rts')).toEqual([0xea, 0xf0, 0xfd, 0xd0, 0x01, 0xea, 0x60]);
    expect(errs('*= $200\n beq far\n .fill 200\n far: rts')[0]).toMatchObject({ line: 2, message: expect.stringMatching(/out of range/) });
  });

  it('reports errors with line numbers and keeps going', () => {
    const r = assemble(`nop
      foo #1
      lda
      sta #3
      lda #256
      lda missing
      dup: nop
      dup: nop
      lda $10,q
      .word "x"
      .byte 1/0
      jmp ($10),y
      lda #(1
      .org later
      later: nop`);
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.line)).toEqual([2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14]);
    expect(r.errors[0].message).toMatch(/unknown instruction/);
    expect(r.errors[4].message).toMatch(/undefined symbol missing/);
  });

  it('assembles the sample programs', () => {
    for (const p of PROGRAMS) {
      const r = assemble(p.source);
      expect(r.errors, p.name).toEqual([]);
      expect(r.origin, p.name).toBe(0x200);
      const img = toImage(r);
      expect(img[0xfffc] | (img[0xfffd] << 8), p.name).toBe(r.symbols.get('start'));
    }
  });
});
