// The C extension: decodeC / expand16 against known encodings, compress32 as their inverse on every parcel,
// the assembler's c.* mnemonics and .option rvc, and the golden model running compressed programs.

import { describe, expect, it } from 'vitest';
import { assemble } from '../src/riscv/asm';
import { BENCHMARKS } from '../src/riscv/benchprograms';
import { decode, encI, encR, OPCODES } from '../src/riscv/isa';
import { ISS } from '../src/riscv/iss';
import { compress32, decodeC, disasmC, expand16, parcelAt } from '../src/riscv/rvc';
import { compilePy, outputOf } from '../src/lang/compile';
import { PY_PROGRAMS } from '../src/lang/pyprograms';
import { randomProgram32 } from '../src/riscv/randprog32';

// GNU objdump's listing of these parcels (riscv64-unknown-elf-objdump -M no-aliases on rv32imc code).
const KNOWN: [number, string, string][] = [
  [0x0001, 'c.nop', 'addi zero, zero, 0'],
  [0x0505, 'c.addi a0, 1', 'addi a0, a0, 1'],
  [0x4501, 'c.li a0, 0', 'addi a0, zero, 0'],
  [0x4785, 'c.li a5, 1', 'addi a5, zero, 1'],
  [0x852e, 'c.mv a0, a1', 'add a0, zero, a1'],
  [0x952e, 'c.add a0, a1', 'add a0, a0, a1'],
  [0x8082, 'c.jr ra', 'jalr zero, 0(ra)'],
  [0x1141, 'c.addi sp, -16', 'addi sp, sp, -16'],
  [0x0141, 'c.addi sp, 16', 'addi sp, sp, 16'],
  [0x7139, 'c.addi16sp sp, -64', 'addi sp, sp, -64'],
  [0xc606, 'c.swsp ra, 12(sp)', 'sw ra, 12(sp)'],
  [0x40b2, 'c.lwsp ra, 12(sp)', 'lw ra, 12(sp)'],
  [0x0800, 'c.addi4spn s0, sp, 16', 'addi s0, sp, 16'],
  [0x4408, 'c.lw a0, 8(s0)', 'lw a0, 8(s0)'],
  [0x9002, 'c.ebreak', 'ebreak'],
  [0xa001, 'c.j 0', 'jal zero, 0'],
  [0xc119, 'c.beqz a0, 6', 'beq a0, zero, 6'],
];

describe('C extension: decode', () => {
  it('matches known encodings', () => {
    for (const [h, c, full] of KNOWN) {
      expect(disasmC(h)).toBe(c);
      const w = expand16(h)!;
      const d = decode(w);
      expect(d.spec, c).not.toBeNull();
      // compare by fields: our disasm prints pseudo-free forms differently, so check the decoded word
      expect(full.startsWith(d.name), `${c} → ${full}`).toBe(true);
    }
    expect(expand16(0x0000)).toBeNull(); // defined illegal
    expect(expand16(0x0003)).toBeNull(); // quadrant 11: a 32-bit instruction
  });

  it('every parcel: a legal one expands to a real instruction, and compresses back to the same effect', () => {
    let legal = 0;
    for (let h = 0; h < 0x10000; h++) {
      const d = decodeC(h);
      if (!d) continue;
      legal++;
      expect(decode(d.word).spec, disasmC(h)).not.toBeNull();
      const c = compress32(d.word);
      if (c === null) continue; // a hint (rd = x0, a zero immediate or shift): never emitted
      const back = decodeC(c)!.word;
      // addi rd, rs, 0 → c.mv (add rd, x0, rs) is the only rewrite
      if (back !== d.word) expect([decode(d.word).name, decodeC(c)!.name, decode(d.word).imm], disasmC(h)).toEqual(['addi', 'c.mv', 0]);
    }
    expect(legal).toBeGreaterThan(35000); // 49 152 parcels less D, RV64 and reserved forms
  });

  it('every non-hint form compresses', () => {
    const hint = (h: number) => {
      const d = decodeC(h)!;
      if (['c.addi', 'c.li', 'c.lui', 'c.mv', 'c.add', 'c.slli'].includes(d.name) && d.rd === 0) return true;
      if (d.name === 'c.nop' && d.imm !== 0) return true;
      if (d.name === 'c.addi' && d.imm === 0) return true;
      if (['c.slli', 'c.srli', 'c.srai'].includes(d.name) && d.imm === 0) return true;
      return false;
    };
    for (let h = 0; h < 0x10000; h++) if (decodeC(h) && !hint(h)) expect(compress32(expand16(h)!), disasmC(h)).not.toBeNull();
  });

  it('mv compresses to c.mv (the GNU assembler does the same)', () => {
    const mv = encI(OPCODES.OPIMM, 10, 0, 11, 0);
    expect(decodeC(compress32(mv)!)!.word).toBe(encR(OPCODES.OP, 10, 0, 0, 11, 0));
  });

  it('a parcel at any even address of a word image', () => {
    const img = [0x45014505, 0x00000537 >>> 0, 0];
    expect(parcelAt(img, 0)).toEqual({ bits: 0x4505, size: 2 });
    expect(parcelAt(img, 2)).toEqual({ bits: 0x4501, size: 2 });
    // a 32-bit instruction straddling two words
    const lui = 0x12345537;
    const s = [((lui & 0xffff) << 16 | 0x0001) >>> 0, lui >>> 16];
    expect(parcelAt(s, 2)).toEqual({ bits: lui, size: 4 });
  });
});

describe('C extension: assembler', () => {
  it('assembles c.* mnemonics to their parcels', () => {
    const src = KNOWN.filter(([, c]) => !/c\.j |c\.beqz/.test(c)).map(([, c]) => c).join('\n');
    const a = assemble(src);
    expect(a.errors).toEqual([]);
    expect(a.lines.map((l) => l.word)).toEqual(KNOWN.filter(([, c]) => !/c\.j |c\.beqz/.test(c)).map(([h]) => h));
    expect(a.lines.every((l) => l.size === 2)).toBe(true);
  });

  it('addi sp, sp, 16: c.addi unless c.addi16sp is asked for', () => {
    expect(decodeC(assemble('.option rvc\naddi sp, sp, 16').lines[0].word)!.name).toBe('c.addi');
    expect(decodeC(assemble('.option rvc\naddi sp, sp, 64').lines[0].word)!.name).toBe('c.addi16sp');
    const a = assemble('c.addi16sp sp, 16');
    expect(a.errors).toEqual([]);
    expect(decodeC(a.lines[0].word)!.name).toBe('c.addi16sp');
    expect(expand16(a.lines[0].word)).toBe(expand16(0x0141));
    expect(assemble('c.addi sp, 32').errors.length).toBe(1);
  });

  it('says what a c.* form needs', () => {
    const a = assemble('c.lw a0, 8(sp)\nc.addi a0, 40\nc.sub a0, t0\nc.beqz t0, 0');
    expect(a.errors.map((e) => e.line)).toEqual([1, 2, 3, 4]);
    expect(a.errors[0].message).toMatch(/x8–x15/);
  });

  it('packs parcels into little-endian words, c.nop at the end', () => {
    const a = assemble('c.li a0, 1\nc.li a1, 2\nc.li a2, 3');
    expect(a.words).toEqual([(0x4589 << 16 | 0x4505) >>> 0, (0x0001 << 16 | 0x460d) >>> 0]);
    expect(a.lines.map((l) => l.addr)).toEqual([0, 2, 4]);
  });

  it('a program without C assembles as before', () => {
    for (const b of BENCHMARKS) {
      const a = assemble(b.source);
      expect(a.lines.every((l) => l.size === undefined && l.addr === 4 * a.lines.indexOf(l))).toBe(true);
      expect(a.words.length).toBe(a.lines.length);
    }
  });

  it('.option rvc: a branch too far for c.beqz grows to beq, labels follow', () => {
    const body = Array.from({ length: 200 }, () => 'addi a1, a1, 1').join('\n'); // 400 bytes of c.addi
    const a = assemble(`.option rvc\nbeqz a0, far\n${body}\nfar: beqz a0, near\nnear: j far`);
    expect(a.errors).toEqual([]);
    expect(a.lines[0].size).toBeUndefined(); // 4 bytes: 404 is beyond ±256
    expect(a.labels.get('far')).toBe(4 + 400);
    expect(a.lines[201].size).toBe(2); // c.beqz near
    expect(a.lines[202].size).toBe(2); // c.j far
  });

  it('.option norvc stops compressing; .align pads to a word with c.nop', () => {
    const a = assemble('.option rvc\naddi a0, a0, 1\n.align 2\nx: addi a0, a0, 1\n.option norvc\naddi a0, a0, 1');
    expect(a.errors).toEqual([]);
    expect(a.labels.get('x')).toBe(4);
    expect(a.lines.map((l) => [l.addr, l.size ?? 4])).toEqual([[0, 2], [2, 2], [4, 2], [6, 4]]);
  });
});

describe('C extension: golden model', () => {
  const run = (words: number[], c: boolean, dmemWords = 256) => {
    const iss = new ISS(words, { c, m: true, dmemWords, imemWords: 1024 });
    iss.run(2_000_000);
    return iss;
  };

  it('the benchmarks leave the same memory compressed', () => {
    for (const b of BENCHMARKS) {
      if (b.needs?.f) continue;
      const plain = assemble(b.source), small = assemble('.option rvc\n' + b.source);
      expect(small.errors).toEqual([]);
      expect(4 * small.words.length).toBeLessThan(4 * plain.words.length);
      const iss = run(small.words, true);
      expect(iss.halted, b.id).toBe(true);
      for (const [k, v] of b.expect()) expect(iss.dmem[k] >>> 0, `${b.id}[${k}]`).toBe(v >>> 0);
    }
  });

  it('compiled Python prints the same compressed', () => {
    for (const p of PY_PROGRAMS) {
      const cp = compilePy(p.source);
      if (!cp.assembled || !cp.layout) continue;
      const small = assemble('.option rvc\n' + cp.asm);
      expect(small.errors, p.id).toEqual([]);
      const iss = new ISS(small.words, { c: true, m: true, dmemWords: cp.layout.dmemWords, imemWords: 1024 });
      iss.run(3_000_000);
      expect(iss.halted, p.id).toBe(true);
      expect(outputOf(cp.layout, iss.x[3], iss.dmem), p.id).toEqual(p.expect);
    }
  });

  it('PC + 2 after a 16-bit instruction, the link too; misa has C', () => {
    const a = assemble('c.jal f\nh: c.j h\nf: c.jr ra');
    expect(a.errors).toEqual([]);
    const iss = new ISS(a.words, { c: true, system: true });
    const s = iss.step();
    expect(s.half).toBe(a.lines[0].word);
    expect(s.text).toBe('c.jal 0x4');
    expect(iss.x[1]).toBe(2);
    expect(iss.pc).toBe(4);
    iss.step(); // c.jr ra
    expect(iss.pc).toBe(2);
    expect(iss.step().halted).toBe(true);
    expect(iss.csrRead(0x301)! & 4).toBe(4);
  });

  it('random programs: every compressible word runs the same as its parcel', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const a = assemble(randomProgram32(seed, { m: true, sub: true }));
      for (const w of a.words) {
        const h = compress32(w);
        if (h === null) continue;
        const e = decodeC(h)!.word;
        if (e !== w) expect(decode(w).name, `0x${w.toString(16)}`).toBe('addi'); // mv → c.mv
      }
    }
  });
});

describe('C extension: the expander in gates', () => {
  it('C_EXPAND equals the specification on every parcel, and passes 32-bit instructions through', async () => {
    const { C_EXPAND, expandWindow } = await import('../src/lib/rvc');
    const { BitSim } = await import('../src/sim/bitsim');
    const { flatten } = await import('../src/sim/flatten');
    const bs = new BitSim(flatten(C_EXPAND));
    let seed = 12345;
    const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0);
    const check = (ws: number[]) => {
      bs.setInput('w', ws);
      bs.settle();
      const ins = bs.get('instr'), cs = bs.get('c'), ills = bs.get('illegal');
      ws.forEach((w, i) => {
        const e = expandWindow(w);
        if ((ins[i] >>> 0) !== e.instr || cs[i] !== e.c || ills[i] !== e.illegal)
          expect([ins[i] >>> 0, cs[i], ills[i]], `w = 0x${w.toString(16)}`).toEqual([e.instr, e.c, e.illegal]);
      });
    };
    for (let h = 0; h < 0x10000; h += 32) check(Array.from({ length: 32 }, (_, i) => ((rnd() & 0xffff0000) | (h + i)) >>> 0));
    for (let k = 0; k < 256; k++) check(Array.from({ length: 32 }, () => (rnd() | 3) >>> 0));
  });

  it('costs', async () => {
    const { C_EXPAND } = await import('../src/lib/rvc');
    const { stats, logicDepth } = await import('../src/sim/stats');
    const n = stats(C_EXPAND).nands, d = logicDepth(C_EXPAND);
    console.log(`C_EXPAND: ${n} NANDs, depth ${d}`);
    expect(n).toBeLessThan(2000);
  });
});
