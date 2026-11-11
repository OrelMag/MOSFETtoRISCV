// Check yourself for chapter 'linking''s entries (codexvm.ts): two questions each, the answer first (quizBox shuffles), a why for every option.

import type { Quiz } from '../chapters/types';

export const CHECKLINK: Record<string, Quiz[]> = {
  objfile: [
    {
      question: 'What does an object file have that a list of instruction words does not?',
      options: ['A symbol table and relocations: what it defines, what it needs, and where the holes are', 'The program\'s output', 'The addresses it will run at', 'The other files\' code'],
      answer: 0,
      explain: 'Its words are unfinished. The symbol table and the relocation list are what let a linker finish them once it has placed everything.',
      why: ['', 'Nothing has run yet.', 'Those are decided later, by the linker.', 'It only names what it needs from them.'],
    },
    {
      question: 'Where does an object file\'s .bss take room?',
      options: ['Only as a size: zeros need no bytes in the file', 'In .data, as zero words', 'In .text', 'Nowhere: .bss is not in object files'],
      answer: 0,
      explain: 'The variables that start at zero are recorded by size; the loader clears that much memory.',
      why: ['', 'Storing the zeros would waste file space for nothing.', '.text holds instructions.', 'It is there, as a size and its symbols.'],
    },
  ],
  symtab: [
    {
      question: 'Two files each have a label called loop. Why does the linker not complain?',
      options: ['Labels are local unless marked .globl: neither is offered to other files', 'The linker renames the second one', 'The second one wins', 'Labels are removed by the assembler'],
      answer: 0,
      explain: 'Only global symbols are matched across files. Local ones are resolved inside their file, so the same name can appear in many.',
      why: ['', 'Nothing is renamed; they are never compared.', 'There is no contest between locals.', 'They stay in the symbol table, as locals.'],
    },
    {
      question: 'main.s calls print, util.s defines print without .globl. What does the linker report?',
      options: ['print is not defined', 'print is defined twice', 'Nothing: it links', 'util.s has an error'],
      answer: 0,
      explain: 'A local print is invisible to main.o, so main.o\'s need is not met.',
      why: ['', 'There is only one definition.', 'The relocation has nothing to fill it.', 'util.s is fine alone.'],
    },
  ],
  reloc: [
    {
      question: 'Why does a linker compute the auipc part as (value + 0x800) >> 12 instead of value >> 12?',
      options: ['The addi\'s 12 bits are signed: when bit 11 is set the low part is negative, so the high part must be one more', 'To align the value to a page', 'auipc rounds down by itself', 'To leave room for the jalr'],
      answer: 0,
      explain: 'For 0xf80 the low part becomes −128, so the high part must give 4096: auipc 1, addi −128.',
      why: ['', 'Alignment has nothing to do with it.', 'auipc adds exactly what it is given.', 'The jalr uses the same split as the addi.'],
    },
    {
      question: 'What does an R_RISCV_JAL relocation tell the linker?',
      options: ['Write the distance to the symbol into this jal\'s 20 offset bits, in J-type order', 'Replace the jal with a call', 'Write the symbol\'s address into the next word', 'Jump to the symbol at load time'],
      answer: 0,
      explain: 'The kind names the field: a jal\'s scattered 20-bit offset.',
      why: ['', 'The linker writes bits; it does not change instructions.', 'A data word would be R_RISCV_32.', 'Relocations are resolved before anything runs.'],
    },
  ],
  linker: [
    {
      question: 'What are a linker\'s three jobs, in order?',
      options: ['Merge the sections, place them at addresses, patch every relocation', 'Assemble, link, load', 'Patch, place, merge', 'Read the ELF, map the pages, jump'],
      answer: 0,
      explain: 'A relocation needs addresses, which need the sections placed, which need them merged first.',
      why: ['', 'Assembling comes before, loading after.', 'Patching needs the addresses that placing gives.', 'That is the loader.'],
    },
    {
      question: 'A library of 8 routines is linked, and the program uses 5. How much of it is in the executable?',
      options: ['The 5 members something needed', 'All 8', 'Only the one the program calls directly', 'None: libraries are loaded at run time'],
      answer: 0,
      explain: 'Members are pulled in one by one as names need them, including those that pulled members need.',
      why: ['', 'Unused members are left out.', 'What that routine calls is pulled in too.', 'That is a shared library; this is a static archive.'],
    },
  ],
  elf: [
    {
      question: 'An ELF program header has filesz 12 and memsz 16. What happens to the last 4 bytes?',
      options: ['The loader zeroes them: they are .bss', 'They come from the next segment', 'They keep what was in memory', 'The file is invalid'],
      answer: 0,
      explain: 'memsz larger than filesz is how every .bss is described.',
      why: ['', 'Segments do not overlap.', 'That would leak old data.', 'It is the normal case.'],
    },
    {
      question: 'Why does the chapter\'s text segment have a physical address different from its virtual one?',
      options: ['The CPU is Harvard: the text must sit in the ROM frame it is fetched from, and its page maps there', 'To hide the program', 'Because the ELF format requires it', 'The linker made a mistake'],
      answer: 0,
      explain: 'Fetch reaches only the ROM, so the text runs in place from ROM frame 0x3000 and exec maps its virtual page there.',
      why: ['', 'Nothing is hidden: the page table says where.', 'They are equal in most files.', 'It is the linker\'s instruction to the loader.'],
    },
  ],
  pic: [
    {
      question: 'How does position-independent code reach a routine in another module?',
      options: ['It loads the address from a table in its data, filled by the loader', 'With a patched jal', 'With an absolute address', 'It cannot'],
      answer: 0,
      explain: 'The table differs per process; the code that reads it is the same everywhere.',
      why: ['', 'Patching would make the text different per process.', 'An absolute address breaks when the module moves.', 'It can, through the table.'],
    },
    {
      question: 'What does a call through the table cost in the chapter\'s loop?',
      options: ['2 more instructions per call, 1 of them a load', 'Nothing', 'A page fault per call', '100 cycles per call'],
      answer: 0,
      explain: '100 calls took 803 instructions through the table against 603 patched.',
      why: ['', 'The table has to be read.', 'The table is mapped; it does not fault.', 'It is a few instructions, not a system call.'],
    },
  ],
  shlib: [
    {
      question: 'Why must a shared library\'s text be position-independent?',
      options: ['It is mapped at different addresses in different processes and cannot be patched for each', 'To make it faster', 'Because it is read-only on disk', 'It need not be'],
      answer: 0,
      explain: 'One copy of the text serves every process; any address written into it would be right for one only.',
      why: ['', 'It is slightly slower.', 'Read-only in memory matters, not on disk.', 'Shared text with patched addresses would only work at one address.'],
    },
    {
      question: 'What does each process have its own copy of when it uses a shared library?',
      options: ['Its data and its table of addresses', 'The library\'s text', 'Nothing', 'The kernel'],
      answer: 0,
      explain: 'Text is shared; variables and the address table are private.',
      why: ['', 'Sharing the text is the point.', 'The library\'s variables must be private.', 'The kernel is not part of the library.'],
    },
  ],
};
