// Chapter 'linking' (DOM-free): programs in several files, linked (riscv/link.ts) into an ELF executable (riscv/elf.ts), put on the kernel's
// disk and started with exec (osprograms.ts kernelSource({ disk })). The executable's layout is the kernel's virtual map: text at VA 0x4000
// (VA.code), whose bytes sit in the ROM frame at EXEC_ROM (the segment's p_paddr: it runs in place), data and .bss from VA 0x1000 (VA.data1),
// the stack below EXEC_SP. tests/linking.test.ts runs every one on the golden model and on the gates in lock step.

import { assembleObject, link, type LinkResult, type ObjFile } from './link';
import { PF_R, PF_W, PF_X, readElf32, wordBytes, writeElf32, type ElfInfo } from './elf';
import { EXEC_ROM, EXEC_SYS, osImage, SYS, VA, type OsImage } from './osprograms';

export interface SourceFile { name: string; text: string }

/** The two files of the chapter's first steps: main adds two numbers through a routine of the other file and prints a table and a counter. */
export const MAIN_S: SourceFile = {
  name: 'main.s',
  text: `# main.s: the program. It uses add2 and print from util.s, and keeps a table and a counter.
.globl main
main:
  li a0, 7
  li a1, 9
  call add2          # a0 = 16
  call print
  la s0, table       # .data: three words
  li s1, 3
loop:
  lw a0, 0(s0)
  call print
  la t0, count       # .bss: starts at zero
  lw t1, 0(t0)
  addi t1, t1, 1
  sw t1, 0(t0)
  addi s0, s0, 4
  addi s1, s1, -1
  bnez s1, loop
  la t0, count
  lw a0, 0(t0)
  call print         # 3
  li a7, ${SYS.exit}
  ecall
.data
table:
  .word 100, 200, 300
.bss
count:
  .space 4
`,
};
export const UTIL_S: SourceFile = {
  name: 'util.s',
  text: `# util.s: two routines other files call.
.globl add2
.globl print
add2:
  add a0, a0, a1
  ret
print:               # the write system call: a0 as a number
  li a7, ${SYS.write}
  ecall
  ret
`,
};
/** What the program prints, as the write call shows it (the process's letter first). */
export const MAIN_OUTPUT = 'A 16\nA 100\nA 200\nA 300\nA 3\n';

/** The process that calls exec: it asks for the file on the disk; if exec returns, it failed. */
export const SHELL = `  li a7, ${EXEC_SYS}
  ecall
  mv a0, a0
  li a7, ${SYS.write}
  ecall
  li a7, ${SYS.exit}
  ecall
`;

export interface Executable {
  objs: ObjFile[];
  linked: LinkResult;
  /** The ELF file, its words (the disk's contents) and what a loader reads from it. */
  elf: Uint8Array;
  words: number[];
  info: ElfInfo;
  errors: string[];
}

/** Assemble each file as an object, link them for the kernel's map, write the executable. The entry is `main`. */
export function buildExecutable(files: SourceFile[]): Executable {
  const objs = files.map((f) => assembleObject(f.text, f.name));
  const errors = objs.flatMap((o) => o.errors.map((e) => `${o.name}:${e.line}: ${e.message}`));
  const linked = link(objs, { textBase: VA.code, dataBase: VA.data1 });
  errors.push(...linked.errors);
  const entry = linked.globals.get('main') ?? VA.code;
  if (!linked.globals.has('main')) errors.push('no global "main": the entry point is the start of the text');
  const data = wordBytes(linked.data);
  const elf = writeElf32(entry, [
    { vaddr: VA.code, paddr: EXEC_ROM, bytes: wordBytes(linked.text), flags: PF_R | PF_X },
    { vaddr: VA.data1, bytes: data, memsz: data.length + linked.bss, flags: PF_R | PF_W },
  ], Object.fromEntries(linked.globals));
  const words: number[] = [];
  const dv = new DataView(elf.buffer, elf.byteOffset, elf.byteLength);
  for (let o = 0; o < elf.length; o += 4) words.push(o + 4 <= elf.length ? dv.getUint32(o, true) : elf.slice(o).reduce((s, b, k) => s | (b << (8 * k)), 0));
  return { objs, linked, elf, words, info: readElf32(elf), errors };
}

/** The OS image: the shell as process A, the executable on the disk and its text in the ROM frame its p_paddr names. */
export function execImage(files: SourceFile[], o: { slice?: number; other?: string } = {}): OsImage & { exe: Executable } {
  const exe = buildExecutable(files);
  if (exe.errors.length) throw new Error(`linking: ${exe.errors[0]}`);
  return { ...osImage(o.other ? [SHELL, o.other] : [SHELL], { slice: o.slice, disk: exe.words, rom: exe.linked.text }), exe };
}
