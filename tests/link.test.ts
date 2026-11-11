// riscv/link.ts: object files and the linker, held to the assembler. One file linked is the file assembled; a program split into files
// is the joined program, word for word; each relocation kind writes the bits the assembler would; the errors are the linker's.
import { describe, expect, it } from 'vitest';
import { assemble } from '../src/riscv/asm';
import { assembleObject, hiLo, imageOf, link, pullMembers } from '../src/riscv/link';
import { PROGRAMS } from '../src/riscv/programs';
import { M_PROGRAMS } from '../src/riscv/mprograms';
import { SYSTEM_PROGRAMS } from '../src/riscv/sysprograms';
import { kernelSource } from '../src/riscv/osprograms';

const asmWords = (src: string) => { const a = assemble(src); expect(a.errors).toEqual([]); return a.words; };

describe('one file linked is the file assembled', () => {
  const corpus = [...PROGRAMS, ...M_PROGRAMS, ...SYSTEM_PROGRAMS].map((p) => [p.name, p.source] as const);
  corpus.push(['the os kernel', kernelSource()]);
  it.each(corpus)('%s', (_n, src) => {
    const o = assembleObject(src, 'one.s');
    expect(o.errors).toEqual([]);
    expect(o.needs).toEqual([]);
    const l = link([o]);
    expect(l.errors).toEqual([]);
    expect(imageOf(l)).toEqual(asmWords(src));
  });
});

// a program whose pieces reach each other by every relocation kind
const MAIN = `.globl main
main:
  li a0, 7
  li a1, 9
  call add2
  jal ra, show
  la t0, total
  sw a0, 0(t0)
  la t1, table
  lw t2, 4(t1)
  beqz t2, done
  jal ra, show
done:
  j done
.data
.globl table
table:
  .word add2, show
`;
const LIB = `.globl add2
.globl show
add2:
  add a0, a0, a1
  ret
show:
  li t6, 0x80000000
  sw a0, 0(t6)
  ret
.data
.globl total
total:
  .word 0
`;
// the same program as one file: text of both, then data of both
const JOINED = `main:
  li a0, 7
  li a1, 9
  call add2
  jal ra, show
  la t0, total
  sw a0, 0(t0)
  la t1, table
  lw t2, 4(t1)
  beqz t2, done
  jal ra, show
done:
  j done
add2:
  add a0, a0, a1
  ret
show:
  li t6, 0x80000000
  sw a0, 0(t6)
  ret
table:
  .word add2, show
total:
  .word 0
`;

describe('a program split into files is the joined program', () => {
  it('main.s + lib.s = joined.s, word for word, through every kind', () => {
    const m = assembleObject(MAIN, 'main.s'), l = assembleObject(LIB, 'lib.s');
    expect(m.errors).toEqual([]);
    expect(l.errors).toEqual([]);
    expect(m.needs.sort()).toEqual(['add2', 'show', 'total']);
    const kinds = new Set(m.relocs.map((r) => r.kind));
    for (const k of ['R_RISCV_CALL', 'R_RISCV_JAL', 'R_RISCV_PCREL_HI20', 'R_RISCV_PCREL_LO12_I', 'R_RISCV_32'] as const) expect(kinds.has(k), k).toBe(true);
    // holes are zero
    for (const r of m.relocs.filter((x) => x.kind === 'R_RISCV_JAL')) expect(m.text[r.offset / 4] >>> 12).toBe(0);
    const r = link([m, l]);
    expect(r.errors).toEqual([]);
    expect(imageOf(r)).toEqual(asmWords(JOINED));
  });

  it('a branch to another section of the same file is a relocation too', () => {
    const o = assembleObject('  beqz a0, far\n  j .\n.data\n.word 1\n', 'b.s');
    expect(o.relocs).toEqual([{ section: 'text', offset: 0, kind: 'R_RISCV_BRANCH', symbol: 'far' }]); // far is not defined anywhere
    expect(o.needs).toEqual(['far']);
    expect(link([o]).errors).toEqual(['b.s: "far" is not defined']);
  });

  it('the high part is rounded: la to a symbol 0xf80 bytes on gives auipc 1, addi -0x80', () => {
    expect(hiLo(0xf80)).toEqual({ hi: 1, lo: -0x80 });
    expect(hiLo(0x7ff)).toEqual({ hi: 0, lo: 0x7ff });
    expect(hiLo(0x800)).toEqual({ hi: 1, lo: -0x800 });
  });
});

describe('the linker\'s errors', () => {
  it('undefined, defined twice, a local name, a jal out of reach', () => {
    const a = assembleObject('.globl f\nf:\n  jal ra, g\n  ret\n', 'a.s');
    const b = assembleObject('.globl f\nf:\n  ret\ng:\n  ret\n', 'b.s');
    const r = link([a, b]);
    expect(r.errors).toContain('"f" is defined twice: in a.s and in b.s');
    expect(r.errors).toContain('a.s: "g" is not defined (b.s has it, but not .globl)');
    const far = link([assembleObject('  jal ra, g\n', 'a.s'), assembleObject('.globl g\ng:\n  ret\n', 'b.s')], { dataBase: 0, textBase: 0 });
    expect(far.errors).toEqual([]);
    const placedFar = assembleObject('.globl g\ng:\n  ret\n', 'b.s');
    const r2 = link([assembleObject('  jal ra, g\n', 'a.s'), { ...placedFar, text: new Array(0x40000).fill(0x13).concat(placedFar.text), symbols: [{ name: 'g', section: 'text', offset: 0x100000, global: true }] }]);
    expect(r2.errors).toEqual(['a.s: jal to "g" cannot reach 1048580 bytes (±1 MiB): use call']);
  });
});

describe('libraries', () => {
  it('only the members the program needs are pulled in; one pass misses a member needed by one pulled later', () => {
    const main = assembleObject('  call f\n  j .\n', 'main.s');
    const f = assembleObject('.globl f\nf:\n  call g\n  ret\n', 'f.s');
    const g = assembleObject('.globl g\ng:\n  ret\n', 'g.s');
    const h = assembleObject('.globl h\nh:\n  ret\n', 'h.s');
    expect(pullMembers([main], [f, g, h]).map((o) => o.name)).toEqual(['main.s', 'f.s', 'g.s']);
    expect(pullMembers([main], [g, f, h]).map((o) => o.name)).toEqual(['main.s', 'f.s']);
    expect(pullMembers([main], [g, f, h], false).map((o) => o.name)).toEqual(['main.s', 'f.s', 'g.s']);
  });
});
