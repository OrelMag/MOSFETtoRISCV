// Chapter 'linking': every number the prose and the codex quote is made by the site's assembler, linker, ELF writer and kernel
// (chapters/ch-linking.ts linkFigures), and held here to what those produce and to what the codex types out.
import { describe, expect, it } from 'vitest';
import { linkFigures, chLinking } from '../src/chapters/ch-linking';
import { CODEX } from '../src/campaign/codex';
import { moreOf } from '../src/campaign/codexmore';
import { hiLo } from '../src/riscv/link';
import { readElf32 } from '../src/riscv/elf';
import { buildExecutable, MAIN_S, UTIL_S } from '../src/riscv/execprograms';
import { relocSolved, solveReloc } from '../src/widgets/linking';
import { groupDigits as n } from '../src/sim/numfmt';
import { assemble } from '../src/riscv/asm';
import { DRILLS, jalWord, rng, splitHiLo } from '../src/campaign/drills';

const F = linkFigures();
const plain = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&gt;/g, '>').replace(/\s+/g, ' ');
const body = (id: string) => plain(CODEX.find((e) => e.id === id)!.body);
const more = (id: string) => plain(moreOf(id)!.example!.body);

describe('the figures', () => {
  it('the two files: what main.o leaves open, and what linking makes of it', () => {
    expect(F.alone).toEqual(['add2', 'print']);
    expect(F.needs).toEqual(['add2', 'print']);
    expect(F.utilRelocs).toBe(0);
    expect(F.kinds).toEqual({ R_RISCV_CALL: 4, R_RISCV_PCREL_HI20: 3, R_RISCV_PCREL_LO12_I: 3 });
    expect(F.mainRelocs).toBe(10);
    // a call is two patches, every other relocation one
    expect(F.patches).toBe(F.mainRelocs + F.kinds.R_RISCV_CALL);
    expect(F.text).toBe(F.mainText + 5);
  });

  it('the relocation strip: offset, rounding, and Do it for me solves it', () => {
    expect(F.jal.offset).toBe(F.jal.target - F.jal.site);
    expect({ hi: F.laHi, lo: F.laLo }).toEqual(hiLo(0xf80));
    expect(F.laHi * 4096 + F.laLo).toBe(0xf80);
    solveReloc();
    expect(relocSolved()).toBe(true);
  });

  it('the executable is what readElf32 reads back', () => {
    const exe = buildExecutable([MAIN_S, UTIL_S]);
    const e = readElf32(exe.elf);
    expect(e.phnum).toBe(F.phnum);
    expect(e.entry).toBe(F.entry);
    expect(F.elfBytes).toBe(exe.elf.length);
    expect(e.segments.map((s) => s.flags)).toEqual([5, 6]);
    expect(e.segments[1].memsz).toBeGreaterThan(e.segments[1].filesz);
    expect(F.diskWords).toBe(Math.ceil(F.elfBytes / 4));
  });

  it('exec: a whole number of cycles per word of .data and of .bss', () => {
    expect(F.execCycles).toBeGreaterThan(50);
    expect(Number.isInteger(F.perDataWord)).toBe(true);
    expect(Number.isInteger(F.perBssWord)).toBe(true);
    expect(F.perDataWord).toBeGreaterThan(F.perBssWord);
  });

  it('libraries and PIC', () => {
    expect(F.lib.used + F.lib.saved).toBe(F.lib.all);
    expect(F.lib.pulled.length).toBeLessThan(F.lib.members);
    expect(F.lib.wrongMissing).toEqual(['clamp']);
    expect(F.pic.through - F.pic.direct).toBe(F.pic.perCall * F.pic.calls);
    expect(F.pic.loads).toBe(1);
  });
});

describe('the campaign drill "Patch the jump"', () => {
  it('jalWord is the assembler\'s word, splitHiLo the linker\'s split', () => {
    for (const off of [0, 2, -2, 24, -4096, 0x7fe, 0x800, 0xffffe, -0x100000, 1234 * 2]) {
      for (const rd of [0, 1]) expect(jalWord(rd, off), `${rd} ${off}`).toBe(assemble(`jal x${rd}, ${off}`).words[0] >>> 0);
    }
    for (const v of [0, 0x7ff, 0x800, 0xf80, 0xfff, 0x1000, 0xabcde, 0xffff]) expect(splitHiLo(v)).toEqual(hiLo(v));
  });

  it('every question accepts its own answer and refuses another', () => {
    const r = rng(7);
    for (let i = 0; i < 400; i++) {
      const q = DRILLS.reloc.make(r);
      expect(q.check(q.answer).ok, q.prompt).toBe(true);
      expect(q.check('0x0').ok).toBe(false);
      if (q.answer.includes(',')) expect(q.check(q.answer.replace('-', '−')).ok).toBe(true);
    }
  });
});

describe('the codex quotes the chapter', () => {
  it('numbers in the entries are the figures', () => {
    expect(body('objfile')).toContain(`main.o: ${F.mainText} instructions, ${F.mainData} words of data, ${F.mainBss} bytes of .bss and ${F.mainRelocs} relocations`);
    expect(body('reloc')).toContain(`0xf80 is auipc ${F.laHi}, addi −${-F.laLo}`);
    expect(body('linker')).toContain(`become ${F.text} instructions with ${F.patches} patches`);
    expect(body('linker')).toContain(`${F.lib.pulled.length} of ${F.lib.members} here, ${F.lib.used} of ${F.lib.all} words`);
    expect(body('elf')).toContain(`${n(F.elfBytes)} bytes with ${F.phnum} segments; exec loads it in ${n(F.execCycles)} cycles`);
    expect(body('pic')).toContain(`${F.pic.perCall} more instructions per call in the chapter's loop, ${F.pic.loads} of them a load`);
    expect(more('objfile')).toContain(`.text ${F.mainText} instructions .data ${F.mainData} words .bss ${F.mainBss} bytes`);
    expect(more('objfile')).toContain(`relocations ${F.mainRelocs}: ${F.kinds.R_RISCV_CALL} × R_RISCV_CALL, ${F.kinds.R_RISCV_PCREL_HI20} × R_RISCV_PCREL_HI20`);
    expect(more('reloc')).toContain(`at ${'0x' + F.jal.site.toString(16)}, print at ${'0x' + F.jal.target.toString(16)}: offset 0x${F.jal.offset.toString(16)} = ${F.jal.offset}`);
    expect(more('reloc')).toContain(`auipc ${F.laHi} (4096), addi ${F.laLo}`);
    expect(more('linker')).toContain(`${F.text} instructions, ${F.data} words of data, ${F.patches} patches`);
    expect(more('linker')).toContain(`${F.lib.pulled.length} of ${F.lib.members} members pulled, ${F.lib.used} of ${F.lib.all} words`);
    expect(more('elf')).toContain(`${F.elfBytes} bytes: a 52-byte header, ${F.phnum} program headers`);
    expect(more('elf')).toContain(`exec: ${F.execCycles} cycles, + ${F.perDataWord} per word of .data, + ${F.perBssWord} per word of .bss`);
    expect(more('pic')).toContain(`direct ${F.pic.direct} instructions`);
    expect(more('pic')).toContain(`through a table ${F.pic.through} instructions: ${F.pic.perCall} more per call, ${F.pic.loads} of them a load`);
  });

  it('every link names a step by its title', () => {
    for (const id of ['objfile', 'symtab', 'reloc', 'linker', 'elf', 'pic', 'shlib', 'loader']) {
      for (const l of moreOf(id)!.chapters ?? []) if (l.chapter === 'linking') expect(chLinking.steps[l.step!].title, id).toBe(l.label);
    }
  });
});
