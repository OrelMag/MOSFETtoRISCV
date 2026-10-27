// SAP-1's assembler, microcode and golden model (Appendix C).

import { describe, expect, it } from 'vitest';
import { assembleSap, sapBytes } from '../src/sap/asm';
import { CTRL, ctrlText, disasm, displayDigits, microcode, romAddr, SAP_DISPLAY_ROM, SAP_ROM_HI, SAP_ROM_LO, SAP_SEG } from '../src/sap/isa';
import { sapAlu, SapISS } from '../src/sap/iss';
import { SAP_PROGRAMS } from '../src/sap/programs';

describe('SAP-1 assembler', () => {
  it('assembles labels, numbers and .byte in line order', () => {
    const r = assembleSap('start: LDI 0x3\n  add n ; comment\n  JMP start\nn: .byte 0b101\n OUT\n HLT');
    expect(r.errors).toEqual([]);
    expect(r.bytes).toEqual([0x53, 0x23, 0x60, 5, 0xe0, 0xf0]);
    expect(r.labels.get('n')).toBe(3);
    expect(r.lines.map((l) => l.srcLine)).toEqual([1, 2, 3, 4, 5, 6]);
  });
  it('reports errors with their lines', () => {
    const r = assembleSap('LDA 16\nFOO\nOUT 3\nLDA\n.byte 256\nJMP nowhere');
    expect(r.errors.map((e) => e.line)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(assembleSap(Array(17).fill('NOP').join('\n')).errors[0].message).toMatch(/16/);
  });
  it('disassembles', () => {
    expect([0x1e, 0x2f, 0x53, 0xe0, 0xf0, 0x00, 0x90].map(disasm)).toEqual(['LDA 14', 'ADD 15', 'LDI 3', 'OUT', 'HLT', 'NOP', 'NOP']);
  });
});

describe('SAP-1 microcode', () => {
  it('fetches in T0–T1 for every opcode and flag', () => {
    for (let op = 0; op < 16; op++) for (const cf of [0, 1]) for (const zf of [0, 1]) {
      expect(ctrlText(microcode(op, 0, cf, zf))).toBe('MI CO');
      expect(ctrlText(microcode(op, 1, cf, zf))).toBe('RO II CE');
    }
  });
  it('the table', () => {
    expect(ctrlText(microcode(0x2, 4, 0, 0))).toBe('AI ΣO FI');
    expect(ctrlText(microcode(0x3, 4, 0, 0))).toBe('AI ΣO SU FI');
    expect(ctrlText(microcode(0x4, 3, 0, 0))).toBe('RI AO');
    expect(microcode(0x7, 2, 0, 1)).toBe(0);
    expect(ctrlText(microcode(0x7, 2, 1, 0))).toBe('IO J');
    expect(ctrlText(microcode(0x8, 2, 0, 1))).toBe('IO J');
    expect(ctrlText(microcode(0xf, 2, 0, 0))).toBe('HLT');
  });
  it('the two EEPROM images hold the control word at [ZF CF][op][step]', () => {
    for (let a = 0; a < 2048; a++) {
      const w = a < 512 ? microcode((a >> 3) & 15, a & 7, (a >> 7) & 1, (a >> 8) & 1) : 0;
      expect((SAP_ROM_HI[a] << 8) | SAP_ROM_LO[a]).toBe(w);
    }
    expect(romAddr(0x7, 2, 1, 0)).toBe(0x80 | 0x38 | 2);
    expect(SAP_ROM_HI[0] << 8 | SAP_ROM_LO[0]).toBe(CTRL.co | CTRL.mi);
  });
  it('the display decoder', () => {
    expect(displayDigits(42)).toEqual([SAP_SEG[2], SAP_SEG[4], SAP_SEG[0]]);
    expect(displayDigits(255)).toEqual([SAP_SEG[5], SAP_SEG[5], SAP_SEG[2]]);
    expect(SAP_DISPLAY_ROM[1024 | (3 << 8) | 0xff]).toBe(0x40); // -1: a minus
  });
});

describe('SAP-1 golden model', () => {
  it('the ALU: carry is "no borrow" for SUB', () => {
    expect(sapAlu(5, 3, 1)).toEqual({ sum: 2, cf: 1, zf: 0 });
    expect(sapAlu(3, 5, 1)).toEqual({ sum: 254, cf: 0, zf: 0 });
    expect(sapAlu(3, 3, 1)).toEqual({ sum: 0, cf: 1, zf: 1 });
    expect(sapAlu(200, 56, 0)).toEqual({ sum: 0, cf: 1, zf: 1 });
  });
  it('one cycle per clock period, five per instruction', () => {
    const m = new SapISS(sapBytes('LDI 7\nOUT\nHLT'));
    expect(m.control()).toBe(CTRL.co | CTRL.mi);
    m.cycle();
    expect(m.mar).toBe(0);
    m.cycle();
    expect(m.ir).toBe(0x57);
    expect(m.pc).toBe(1);
    m.cycle();
    expect(m.bus).toBe(7);
    expect(m.a).toBe(7);
    m.cycle(); m.cycle();
    expect(m.step).toBe(0);
    for (let i = 0; i < 5; i++) m.cycle();
    expect(m.out).toBe(7);
    for (let i = 0; i < 2; i++) m.cycle();
    expect(m.halted).toBe(true);
    const s = m.save();
    expect(m.cycle()).toBe(false);
    expect(m.save()).toEqual({ ...s, bus: 0, cw: CTRL.hlt });
  });
  it.each(SAP_PROGRAMS.map((p) => [p.id, p] as const))('%s shows its values and halts', (_, p) => {
    const m = new SapISS(sapBytes(p.src));
    expect(m.run(20000)).toEqual(p.outs);
    expect(m.halted).toBe(true);
  });
  it('save and restore', () => {
    const m = new SapISS(sapBytes(SAP_PROGRAMS[3].src));
    for (let i = 0; i < 37; i++) m.cycle();
    const s = m.save();
    const a = m.run(20000);
    m.restore(s);
    expect(m.run(20000)).toEqual(a);
  });
});

describe('SAP-1 reset', () => {
  it('clears the PC, the step, A, B, the IR and the flags; the MAR, OUT and the RAM keep theirs', () => {
    const bytes = sapBytes(SAP_PROGRAMS.find((p) => p.id === 'fib')!.src);
    const m = new SapISS(bytes);
    for (let i = 0; i < 37; i++) m.cycle();
    const { mar, out, ram } = m.save();
    m.reset();
    expect([m.pc, m.step, m.a, m.b, m.ir, m.cf, m.zf]).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(m.atReset).toBe(true);
    expect([m.mar, m.out, Array.from(m.ram)]).toEqual([mar, out, ram]);
    // a halted machine runs again after a reset
    const h = new SapISS(bytes);
    h.run();
    expect(h.halted).toBe(true);
    h.reset();
    expect(h.halted).toBe(false);
    // from the top, on the RAM as the first run left it (Fibonacci keeps its variables there)
    expect(h.run()).toEqual(new SapISS(Array.from(h.ram)).run());
  });

  it('held through an edge only the MAR moves (T0 of NOP: CO MI, the PC is 0)', () => {
    const m = new SapISS([0x1e]);
    for (let i = 0; i < 3; i++) m.cycle();
    expect(m.mar).toBe(0xe);
    m.cycle(true);
    expect(m.mar).toBe(0);
    expect(m.atReset).toBe(true);
  });
});
