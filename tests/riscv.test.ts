import { describe, expect, it } from 'vitest';
import { assemble } from '../src/riscv/asm';
import { decode, disasm } from '../src/riscv/isa';
import { ISS } from '../src/riscv/iss';
import { PROGRAMS } from '../src/riscv/programs';

const prog = (id: string) => PROGRAMS.find((p) => p.id === id)!.source;

describe('assembler', () => {
  it('reproduces the primer listing bit for bit', () => {
    const listing = [
      0x00000093, 0x00100113, 0x00b00193, 0x002080b3, 0x00110113, 0x00310463, 0xff5ff06f, 0x06102223,
      0x06402203, 0x004202b3, 0x40128333, 0x005323b3, 0x0062f433, 0x0062e4b3, 0xff900513, 0x00052633,
      0xfff32693, 0x00f4f713, 0x10046793, 0x06502423, 0x008005ef, 0x00000293, 0x06702623, 0x40300833,
      0x07002823, 0x00000063,
    ];
    const r = assemble(prog('primer'));
    expect(r.errors).toEqual([]);
    expect(r.words).toEqual(listing);
  });

  it('assembles every sample without errors', () => {
    for (const p of PROGRAMS) expect(assemble(p.source).errors, p.id).toEqual([]);
  });

  it('expands li for large constants', () => {
    const r = assemble('li a0, 0x12345678\nli a1, -1\nli a2, 0x7ff00000');
    expect(r.words.length).toBe(4);
    const iss = new ISS(r.words);
    iss.run(4);
    expect(iss.x[10]).toBe(0x12345678);
    expect(iss.x[11]).toBe(0xffffffff);
    expect(iss.x[12]).toBe(0x7ff00000);
  });

  it('reports errors with line numbers', () => {
    const r = assemble('addi x1, x0, 1\nfoo x1\naddi x1, x0, 9999');
    expect(r.errors.map((e) => e.line)).toEqual([2, 3]);
  });

  it('disassembly round-trips through the assembler', () => {
    for (const p of PROGRAMS) {
      const r = assemble(p.source);
      r.words.forEach((w, i) => {
        const text = disasm(w, i * 4).replace(/0x([0-9a-f]+)$/, (_m, h) => String(parseInt(h, 16) - i * 4));
        if (decode(w).fmt === 'U' || text === 'nop') return;
        const again = assemble(text).words[0];
        expect(again, `${p.id}: ${text}`).toBe(w);
      });
    }
  });
});

describe('instruction-set simulator', () => {
  it('matches the primer\'s expected final state', () => {
    const iss = new ISS(assemble(prog('primer')).words);
    iss.run(1000);
    expect(iss.halted).toBe(true);
    expect(iss.pc).toBe(100);
    const x = [0, 55, 11, 11, 55, 110, 55, 1, 38, 127, 4294967289, 84, 1, 0, 15, 294, 4294967285];
    expect([...iss.x.slice(0, 17)]).toEqual(x);
    expect(iss.dmem[25]).toBe(55);
    expect(iss.dmem[26]).toBe(110);
    expect(iss.dmem[27]).toBe(1);
    expect(iss.dmem[28]).toBe(4294967285);
  });

  it('runs the samples to the expected results', () => {
    const run = (id: string) => { const s = new ISS(assemble(prog(id)).words); s.run(5000); expect(s.halted, id).toBe(true); return s; };
    expect(run('sum').dmem[0]).toBe(55);
    expect([...run('fib').dmem.slice(0, 12)]).toEqual([0, 1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89]);
    expect(run('mul').dmem[0]).toBe(5535);
    expect([...run('sort').dmem.slice(0, 8)].map((v) => v | 0)).toEqual([-40, -5, 0, 3, 7, 12, 37, 99]);
    expect(run('gcd').dmem[0]).toBe(21);
    const a = run('alu');
    expect(a.x[5] | 0).toBe(-160);
    expect(a.x[6]).toBe(0x1ffffffd);
    expect(a.x[7] | 0).toBe(-3);
    expect(a.x[28]).toBe(1);
    expect(a.x[29]).toBe(0);
    expect(a.x[8]).toBe(0x12345678);
  });
});
