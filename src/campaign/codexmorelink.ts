// The fuller codex texts for chapter 'linking''s entries (codexvm.ts: objfile, symtab, reloc, linker, elf, pic, shlib). Every number is the
// chapter's own, made by the site's assembler, linker, ELF writer and kernel, and pinned by tests/content-linking.test.ts.

import type { CodexMore } from './codexmore';

const ln = (step: number, label: string) => ({ chapter: 'linking', step, label });

export const MORELINK: Record<string, CodexMore> = {
  objfile: {
    idea: `An assembler can encode every instruction whose operands it knows. What it cannot know is where things outside the file will be, or even where its own .data will sit relative to its .text: that is decided once all the pieces are together. So it writes what it can, leaves zeros where it cannot, and lists every such place.<br>The result is an object file: sections, a symbol table and relocations. It is the unit of separate compilation: change one file and only that file is assembled again.`,
    example: {
      title: 'The chapter\'s main.o',
      body: `<pre>.text  27 instructions    .data  3 words    .bss  4 bytes
relocations 10: 4 × R_RISCV_CALL, 3 × R_RISCV_PCREL_HI20, 3 × R_RISCV_PCREL_LO12_I
needs: add2, print</pre>util.o, which needs nothing, has no relocations at all.`,
    },
    mistakes: [
      'Thinking a local label needs no relocation: one in another section (la to .data from .text) does, because the distance between sections is the linker\'s choice.',
      'Reading a hole\'s bits as meaningful: they are zeros (or an addend), filled only at link time.',
    ],
    chapters: [ln(0, 'One program, two files'), ln(1, 'An object file')],
  },
  symtab: {
    idea: `A label is a name for an address. Inside one file the assembler resolves it; across files someone has to match a use in one with a definition in another, and that is the symbol table's job. Each entry is a name, where it is defined (section and offset) and whether it is offered to other files.<br>Local by default is deliberate: helper labels like <code>loop</code> or <code>done</code> in every file must not clash. Only what is marked <code>.globl</code> is matched across files.`,
    example: {
      title: 'Two mistakes, two messages',
      body: `<pre>util.s without .globl print   main.s: "print" is not defined (util.s has it, but not .globl)
add2 in both files             "add2" is defined twice: in main.s and in util.s</pre>`,
    },
    mistakes: [
      'Forgetting .globl on a routine meant for other files: the linker sees a local symbol and reports the name undefined.',
      'Expecting the linker to pick one of two definitions: it refuses (weak symbols, which it may override, are a separate, marked kind).',
    ],
    chapters: [ln(1, 'An object file'), ln(3, 'Link: merge, place, patch')],
  },
  reloc: {
    idea: `A relocation is a promise about bits: once the symbol's address is known, compute this value and write it into this field of this instruction. The kinds exist because RISC-V scatters immediates differently per format; the linker has to know which layout to follow.<br>A 32-bit value split over auipc and addi needs care, because the addi's 12 bits are signed: if bit 11 of the value is 1 the low part is negative, and the high part must be one more to make up for it. That is the +0x800 in every linker.`,
    example: {
      title: 'A jal and an la, patched',
      body: `<pre>jal ra, print at 0xc, print at 0x24: offset 0x18 = 24, written into bits 31..12 in J-type order
la to a symbol 0xf80 ahead: auipc 1 (4096), addi -128   (4096 - 128 = 0xf80)</pre>`,
    },
    mistakes: [
      'Splitting a value as hi = value >> 12, lo = value & 0xfff: when bit 11 is set the addi sign-extends lo and lands 4 KiB short.',
      'Using a jal for a far call: it reaches ±1 MiB; a call (auipc + jalr) reaches ±2 GiB.',
    ],
    chapters: [ln(2, 'Relocations: the bits a linker writes')],
  },
  linker: {
    idea: `A linker does three things in order. It merges sections of the same name from every object file; it places each merged section at an address (from a linker script, or the defaults), which gives every symbol its address; and it walks every relocation, computes the value and writes the bits.<br>With libraries it also chooses which files to take: an archive member is pulled in only to satisfy a name still undefined, and once the linker has moved past an archive it does not look at it again.`,
    example: {
      title: 'The chapter\'s link and its libraries',
      body: `<pre>main.o + util.o        32 instructions, 3 words of data, 14 patches (a call is two)
main + libio + libmath  5 of 8 members pulled, 29 of 47 words
libmath named first     "clamp" undefined: pclamp needed it after libmath was passed</pre>`,
    },
    mistakes: [
      'Naming a library before the files that use it: the linker passes it while nothing needs it yet.',
      'Assuming a whole library is copied in: only the members something needs are.',
    ],
    chapters: [ln(3, 'Link: merge, place, patch'), ln(4, 'Libraries: take only what is used'), ln(9, 'Doom, linked')],
  },
  elf: {
    idea: `An executable must tell a loader everything the loader needs without the loader knowing the program: what machine it is for, where to start, and which bytes go where with which permissions. ELF does it with one fixed header and a table of program headers, one per segment.<br>Each segment has a size in the file and a size in memory. The difference is .bss: the variables that start at zero take no room in the file, only a number the loader turns into zeros.`,
    example: {
      title: 'The chapter\'s executable',
      body: `<pre>528 bytes: a 52-byte header, 2 program headers of 32 bytes, the segments,
then a symbol table, string tables and section headers (the loader ignores them)
LOAD  text  R X   physical 0x3000 (the ROM frame it runs from)
LOAD  data  R W   memsz larger than filesz: the .bss
exec: 184 cycles, + 7 per word of .data, + 5 per word of .bss</pre>`,
    },
    mistakes: [
      'Confusing sections with segments: sections are the linker\'s view (.text, .rodata, .data), segments the loader\'s (what to map with which permissions); several sections share a segment.',
      'Expecting .bss bytes in the file: only its size is there.',
    ],
    chapters: [ln(5, 'The executable'), ln(6, 'The loader: exec on the gates')],
  },
  pic: {
    idea: `Code linked for one address has that address written into it. To run the same bytes at another address, every reference must be either relative to the PC, which moves with the code, or read at run time from somewhere that can be different per copy.<br>RISC-V makes the first easy: auipc gives the PC plus an offset, so code and data of the same module are reached without any absolute address. For other modules the code loads the address from a table (the global offset table) in its own writable data, which the loader fills.`,
    example: {
      title: 'A call patched against a call through a table, 100 calls',
      body: `<pre>direct          603 instructions
through a table 803 instructions: 2 more per call, 1 of them a load</pre>`,
    },
    mistakes: [
      'Thinking PIC is free: every reference to another module costs a load from the table.',
      'Patching the shared text per process: then it is no longer shared.',
    ],
    chapters: [ln(8, 'One library, two processes')],
  },
  shlib: {
    idea: `Linked statically, every program carries its own copy of the routines it uses. A shared library is linked once into its own file and mapped into every process that wants it: one copy of the text in memory, read-only and position-independent; each process gets its own data and its own table of addresses, which the dynamic linker fills when the program starts or, lazily, at each routine's first call.<br>The gain is memory and updates in one place; the cost is a load per call, the dynamic linker's start-up work, and programs that now depend on the library version they find.`,
    example: {
      title: 'What sharing needs, step by step',
      body: `<pre>text   one copy, mapped R X into every process, at any address
data   one copy per process, R W
table  per process, filled by the loader: where each routine is
call   through the table: in the chapter's loop 2 more instructions</pre>`,
    },
    mistakes: [
      'Expecting a library update to be invisible: a changed interface breaks every program built against the old one.',
      'Forgetting the per-process data: shared text, private variables.',
    ],
    chapters: [ln(8, 'One library, two processes')],
  },
};
