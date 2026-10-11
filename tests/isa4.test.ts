import { describe, expect, it } from 'vitest';
import { assemble4 } from '../src/isa4/asm4';
import { BY_NAME4, decode4, disasm4, INSTRS4 } from '../src/isa4/isa4';
import { Iss4 } from '../src/isa4/iss4';
import { BCD4, MULTIPLY4, PROGRAMS4, SWITCHES4, TEST4 } from '../src/isa4/programs4';

const build = (src: string) => {
  const r = assemble4(src);
  expect(r.errors).toEqual([]);
  return r.words;
};

describe('4-bit ISA', () => {
  it('every sample assembles', () => {
    for (const p of PROGRAMS4) expect(assemble4(p.src).errors, p.id).toEqual([]);
  });

  it('disassembly assembles back to the same word (every canonical word)', () => {
    let n = 0;
    for (let w = 0; w < 0x10000; w++) {
      const d = decode4(w);
      if (d.undef) continue;
      const shape = BY_NAME4.get(d.name)!.shape;
      const two = shape === 'ca' || shape === 'pb' || shape === 'a' || shape === 'ra';
      // Canonical: one-byte instructions have a zero second byte, JUN / JMS a zero OPA.
      if (!two && (w & 0xff)) continue;
      if ((d.name === 'JUN' || d.name === 'JMS') && d.opa) continue;
      const r = assemble4(disasm4(w));
      expect(r.errors, disasm4(w)).toEqual([]);
      expect(r.words[0], disasm4(w)).toBe(w);
      n++;
    }
    expect(n).toBeGreaterThan(5000);
    expect(INSTRS4.length).toBe(29);
  });

  it('words no instruction names are NOP, shown as .word', () => {
    for (const w of [0x0100, 0x3000, 0xe000, 0xe300, 0xfc00, 0xff00]) {
      expect(decode4(w)).toMatchObject({ name: 'NOP', undef: true });
      expect(disasm4(w)).toMatch(/^\.word/);
    }
  });

  it('reports errors on the line', () => {
    const r = assemble4('  LDM 16\n  ADD R16\n  JUN nowhere\n  FOO');
    expect(r.errors.map((e) => e.line)).toEqual([1, 2, 3, 4]);
  });
});

describe('4-bit golden model', () => {
  it('BCD addition: 1234 + 5876 = 7110, halting after 38 instructions', () => {
    const iss = new Iss4(build(BCD4));
    expect(iss.run()).toBe(38);
    expect(iss.halted).toBe(true);
    expect([...iss.ports.slice(0, 4)]).toEqual([7, 1, 1, 0]);
    expect(iss.pc).toBe(0x25);
  });

  it('multiply subroutine: 7 × 9 = 0x3F, the stack back where it was', () => {
    const iss = new Iss4(build(MULTIPLY4));
    iss.run();
    expect(iss.halted).toBe(true);
    expect([iss.r[0], iss.r[1]]).toEqual([3, 15]);
    expect([iss.ports[2], iss.ports[3]]).toEqual([3, 15]);
  });

  it('switches + 1 with the carry', () => {
    const iss = new Iss4(build(SWITCHES4));
    iss.switches = 15;
    for (let i = 0; i < 20; i++) iss.step();
    expect(iss.ports[4]).toBe(0);
    expect(iss.ports[3]).toBe(1);
    iss.switches = 4;
    for (let i = 0; i < 16; i++) iss.step();
    expect(iss.ports[4]).toBe(5);
    expect(iss.ports[3]).toBe(0);
  });

  it('TEST presses count in decimal', () => {
    const iss = new Iss4(build(TEST4));
    const press = () => {
      for (let i = 0; i < 5; i++) iss.step();
      iss.test = 1;
      for (let i = 0; i < 5; i++) iss.step();
      iss.test = 0;
    };
    for (let k = 0; k < 11; k++) press();
    expect(iss.ports[3]).toBe(1); // 11 presses: 1 (the tens are lost)
  });

  it('arithmetic matches the 4004: SUB borrow, DAC, TCS, DAA, rotates', () => {
    const run = (src: string) => { const s = new Iss4(build(`${src}\nh: JUN h`)); s.run(); return s; };
    expect(run('LDM 3\nCLC\nFIM P0, 0x05\nSUB R1').a).toBe(14); // 3 - 5 = -2, borrow
    expect(run('LDM 3\nCLC\nFIM P0, 0x05\nSUB R1').cy).toBe(0);
    expect(run('LDM 5\nCLC\nFIM P0, 0x03\nSUB R1')).toMatchObject({ a: 2, cy: 1 }); // 5 - 3, no borrow out
    expect(run('LDM 5\nSTC\nFIM P0, 0x03\nSUB R1')).toMatchObject({ a: 1, cy: 1 }); // A + ¬R + ¬CY: CY = 1 borrows
    expect(run('LDM 0\nDAC')).toMatchObject({ a: 15, cy: 0 });
    expect(run('LDM 1\nDAC')).toMatchObject({ a: 0, cy: 1 });
    expect(run('STC\nTCS')).toMatchObject({ a: 10, cy: 0 });
    expect(run('CLC\nTCS')).toMatchObject({ a: 9, cy: 0 });
    expect(run('LDM 9\nSTC\nDAA')).toMatchObject({ a: 15, cy: 1 });
    expect(run('LDM 12\nCLC\nDAA')).toMatchObject({ a: 2, cy: 1 });
    expect(run('LDM 9\nCLC\nDAA')).toMatchObject({ a: 9, cy: 0 });
    expect(run('LDM 9\nSTC\nRAL')).toMatchObject({ a: 3, cy: 1 });
    expect(run('LDM 9\nCLC\nRAR')).toMatchObject({ a: 4, cy: 1 });
  });

  it('a fourth call drops the oldest return address', () => {
    const s = new Iss4(build('JMS a\nh: JUN h\na: JMS b\nb: JMS c\nc: JMS d\nd: BBL 1'));
    for (let i = 0; i < 5; i++) s.step();
    expect([...s.stack]).toEqual([4, 3, 3]);
    expect(s.pc).toBe(5); // returned to after "c: JMS d"
  });
});
