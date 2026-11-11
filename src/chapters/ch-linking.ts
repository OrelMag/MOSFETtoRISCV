import { assembleObject, hiLo, link, type ObjFile } from '../riscv/link';
import { ELF32_EHSIZE, ELF32_PHSIZE } from '../riscv/elf';
import { buildExecutable, execImage, MAIN_OUTPUT, MAIN_S, SHELL, UTIL_S, type SourceFile } from '../riscv/execprograms';
import { DISK_PA, EXEC_ROM, EXEC_SP, EXEC_SYS, VA } from '../riscv/osprograms';
import { runOs, tripsOf } from '../riscv/osrun';
import { groupDigits } from '../sim/numfmt';
import { osScene } from '../widgets/os';
import { aloneErrors, doomWidget, elfWidget, jalCase, libCase, libraryWidget, linkWidget, objectWidget, picCost, picWidget, relocSolved, relocWidget, solveReloc, twoFilesWidget } from '../widgets/linking';
import type { Scene } from '../view/stage';
import type { Chapter } from './types';
import { numOf } from './order';

const n = groupDigits;
const hex = (v: number) => '0x' + (v >>> 0).toString(16);

/** The numbers the prose quotes, all made by the site's assembler, linker, ELF writer and kernel (tests/content-linking.test.ts pins them). */
export interface LinkFigures {
  alone: string[];
  /** main.o and util.o: words, relocations by kind, symbols defined and needed. */
  mainText: number; mainData: number; mainBss: number; mainRelocs: number; utilRelocs: number; kinds: Record<string, number>; needs: string[];
  /** The linked program: instructions and data words, patches the linker wrote. */
  text: number; data: number; patches: number;
  jal: { site: number; target: number; offset: number };
  /** la to a symbol 0xf80 ahead. */
  laHi: number; laLo: number;
  lib: ReturnType<typeof libCase>;
  /** The executable: bytes, program headers, entry. */
  elfBytes: number; phnum: number; entry: number; diskWords: number;
  /** exec on the golden model (the gates agree: tests/linking.test.ts): cycles of the call, and what one more word of .data / .bss adds. */
  execCycles: number; perDataWord: number; perBssWord: number;
  pic: ReturnType<typeof picCost>;
}

/** The chapter's program with k more words of .data (perDataWord) or of .bss. */
const grown = (dataWords: number, bssWords: number): SourceFile => ({
  ...MAIN_S,
  text: MAIN_S.text.replace('  .word 100, 200, 300\n', `  .word 100, 200, 300${', 0'.repeat(dataWords)}\n`).replace('count:\n  .space 4\n', `count:\n  .space ${4 + 4 * bssWords}\n`),
});
const execTrip = (files: SourceFile[]) => tripsOf(runOs(execImage(files), 100000), EXEC_SYS)[0].kernelCycles;

let figs: LinkFigures | undefined;
export function linkFigures(): LinkFigures {
  if (figs) return figs;
  const objs: ObjFile[] = [assembleObject(MAIN_S.text, MAIN_S.name), assembleObject(UTIL_S.text, UTIL_S.name)];
  const kinds: Record<string, number> = {};
  for (const r of objs[0].relocs) kinds[r.kind] = (kinds[r.kind] ?? 0) + 1;
  const r = link(objs, { textBase: VA.code, dataBase: VA.data1 });
  const exe = buildExecutable([MAIN_S, UTIL_S]);
  const j = jalCase();
  const { hi, lo } = hiLo(0xf80);
  const base = execTrip([MAIN_S, UTIL_S]);
  figs = {
    alone: aloneErrors(),
    mainText: objs[0].text.length, mainData: objs[0].data.length, mainBss: objs[0].bss, mainRelocs: objs[0].relocs.length, utilRelocs: objs[1].relocs.length, kinds, needs: objs[0].needs,
    text: r.text.length, data: r.data.length, patches: r.patches.length,
    jal: { site: j.site, target: j.target, offset: j.offset },
    laHi: hi, laLo: lo,
    lib: libCase(),
    elfBytes: exe.elf.length, phnum: exe.info.phnum, entry: exe.info.entry, diskWords: exe.words.length,
    execCycles: base, perDataWord: (execTrip([grown(8, 0), UTIL_S]) - base) / 8, perBssWord: (execTrip([grown(0, 8), UTIL_S]) - base) / 8,
    pic: picCost(),
  };
  return figs;
}
const F = linkFigures();
const exe = buildExecutable([MAIN_S, UTIL_S]);

const ROGUE: SourceFile = { name: 'rogue.s', text: `.globl main\nmain:\n  la t0, main\n  li t1, 0x13\n  sw t1, 0(t0)       # a store into its own code\n  li a7, 93\n  ecall\n` };
const scenes = {
  exec: (): Scene => osScene({ procs: [SHELL], disk: exe.words, rom: exe.linked.text, highlight: ['csr', 'mmu'], keep: 'open' }),
  rogue: (): Scene => { const e = buildExecutable([ROGUE]); return osScene({ procs: [SHELL], disk: e.words, rom: e.linked.text, highlight: ['mmu', 'trap'], keep: 'open' }); },
};

export const chLinking: Chapter = {
  id: 'linking', num: numOf('linking'), title: 'Linking and loading', level: 'System',
  blurb: 'Programs in several files: object files with holes, relocations, a linker that patches the bits, libraries, an ELF executable, and exec in the kernel, on the gates.',
  goals: [
    'read an object file: its sections, its symbols, and the holes it leaves for other files',
    'patch a relocation by hand: which bits of which instruction the linker writes, and why the high part is rounded',
    'link files and libraries into an executable, and read its ELF header and segments',
    'load it with exec: text mapped in place without W, data copied, .bss zeroed, on the gates',
  ],
  builds: ['isa', 'os', 'vmem'],
  recap: {
    keep: [
      `An object file is code with holes and a list of them: sections from offset 0, a symbol table (what it defines, what it needs) and relocations. main.o here: ${F.mainText} instructions, ${F.mainRelocs} relocations, needing ${F.needs.join(', ')}.`,
      `A relocation names a place, a kind and a symbol. The linker knows both addresses and writes the bits: a jal's 20-bit offset in J-type order, a branch's 12, an auipc / addi pair split with the high part rounded (+0x800) because the low 12 bits are signed.`,
      `Linking is merge, place, patch: sections end to end, every symbol an address, every hole filled; a name nobody defines, or two files defining one, is an error. From a library only the members something needs are pulled in, and an archive is not scanned again once passed.`,
      `An executable says where its pieces go: an ELF header, program headers (address, sizes, R / W / X), the entry. ${n(F.elfBytes)} bytes here.`,
      `A loader maps each segment with its permissions: text R X (a store into it faults), data R W (a jump into it faults), .bss zeroed, a stack, the entry. On this Harvard CPU text runs in place from the ROM. exec took ${n(F.execCycles)} cycles, ${F.perDataWord} more per word of .data.`,
      `Shared code is mapped once and reached through a table each process owns: ${F.pic.perCall} more instructions per call here, ${F.pic.loads} of them a load.`,
    ],
    practise: ['p_call', 'p_link'],
    check: [
      {
        question: 'Why can the assembler encode jal ra, loop to a label in the same file, but not jal ra, print to a label in another file?',
        options: ['A jal holds the distance to its target; the distance to another file\'s label is known only once the linker places both', 'jal may not jump to another file', 'The assembler does not know print is a function', 'Another file\'s labels are absolute addresses'],
        answer: 0,
        explain: 'Within one file, the distance is fixed however the file is placed. Across files it depends on where the linker puts each, so the assembler leaves the bits empty and a relocation that says which.',
        why: ['', 'It may: the linker fills the offset, as long as it is within ±1 MiB.', 'Function or not makes no difference: a label is an address.', 'Labels are addresses either way; the problem is that this one is not known yet.'],
      },
      {
        question: `la a0, msg with msg ${hex(0xf80)} bytes ahead of the auipc: what are the auipc and addi immediates?`,
        options: [`auipc ${F.laHi}, addi −${-F.laLo}`, 'auipc 0, addi 0xf80', 'auipc 1, addi 0xf80', `auipc 0, addi −${-F.laLo}`],
        answer: 0,
        explain: `The addi's immediate is 12 bits signed: −2048 … 2047. 0xf80 = 3968 does not fit, so it is 4096 − 128: the high part rounds up to 1 (4096) and the low part is −${-F.laLo}.`,
        why: ['', '0xf80 = 3968 is outside the addi\'s −2048 … 2047.', 'That adds to 4096 + 3968: too far.', 'That reaches −128, behind the auipc.'],
      },
      {
        question: 'Why does the loader map the text without W?',
        options: ['A store into the code is a bug or an attack: without W the page fault stops it', 'The ROM cannot be written anyway, so W does not matter', 'W would make the text slower to fetch', 'The text has no data to write'],
        answer: 0,
        explain: 'Code that changes itself is almost always a stray pointer or an exploit. Mapping it read and execute only turns the store into a page fault the kernel handles; data gets W and no X for the same reason the other way round.',
        why: ['', 'The permission is checked before the store reaches anything: here the MMU refuses it, which is why the kernel hears about it.', 'Fetching never checks W.', 'Any store can aim at any address; the permission is what stops it.'],
      },
    ],
  },
  steps: [
    {
      title: 'One program, two files',
      body: `
        <p>Every program in this book so far was one file, assembled at address 0. Real programs are not. They are built from pieces: routines other people wrote (a library), files a team works on separately, and files that did not change and need not be assembled again. Chapter ${numOf('os')}'s kernel had to fake it: it put three programs in one ROM by renaming every label and writing each so that it would run at any address.</p>
        <p>The widget's program is two files. <code>main.s</code> adds two numbers with <code>add2</code> and prints with <code>print</code>, both in <code>util.s</code>; it keeps a table of numbers and a counter. The assembler of chapter ${numOf('isa')} cannot assemble <code>main.s</code> alone: ${F.alone.map((s) => `<code>${s}</code>`).join(' and ')} are not defined in it, and a <code>call</code> needs the distance to its target. That distance depends on where the other file will be put, which no single file knows.</p>
        <p>The answer has two halves. The assembler encodes everything it can and leaves holes, with a note of what goes in each: an <strong>object file</strong>. Then a <strong>linker</strong> reads all the object files at once, decides where each piece goes, and fills the holes. This chapter builds both, and a loader that puts the result into memory.</p>`,
      widget: twoFilesWidget,
      challenge: {
        kind: 'quiz',
        question: 'main.s calls add2, which util.s defines. What does the assembler not know when it assembles main.s?',
        options: ['Where add2 will be, so how far the call must reach', 'What add2 does', 'Which registers add2 uses', 'How many arguments add2 takes'],
        answer: 0,
        explain: 'A call encodes a distance. Until something decides where both files go, the distance is unknown; everything else about the call (the opcode, the registers) the assembler can write now.',
        why: ['', 'The assembler never needs to know what a routine does.', 'The calling convention settles registers; the assembler does not check them.', 'Arguments are in registers by convention, not part of the call.'],
      },
    },
    {
      title: 'An object file',
      body: `
        <p>An object file is what the assembler can produce on its own. Its code and data are in <strong>sections</strong>, each assembled as if it started at 0: <code>.text</code> for instructions, <code>.data</code> for initial values, <code>.bss</code> for variables that start at zero (only their size is stored, since zeros need not be). <code>main.o</code> has ${F.mainText} words of text, ${F.mainData} of data and ${F.mainBss} bytes of .bss.</p>
        <p>Two lists make it more than a fragment. The <strong>symbol table</strong> lists what the file defines (a name, its section and offset, global if other files may use it) and what it needs. The <strong>relocation list</strong> names every hole: where it is, what kind of instruction it is in, and which symbol fills it. <code>main.o</code> has ${F.mainRelocs}: ${Object.entries(F.kinds).map(([k, v]) => `${v} × ${k}`).join(', ')}. Even <code>la s0, table</code> needs one: <code>table</code> is in this file, but in another section, and where .data goes relative to .text is the linker's choice.</p>
        <p>The holes are zeros. The assembler did write <em>something</em> there when it put each unknown name at the end of the section, but that value means nothing, so it is cleared: what a hole holds is not a guess, it is written later. ${F.utilRelocs ? '' : '<code>util.o</code> has no relocations at all: it needs nothing from anyone.'}</p>`,
      widget: objectWidget,
      challenge: {
        kind: 'quiz',
        question: 'Why does la s0, table need a relocation when table is defined in the same file?',
        options: ['table is in .data and la in .text: the distance between the two sections is set by the linker', 'Every la needs a relocation', 'table is global', 'la is a pseudo-instruction'],
        answer: 0,
        explain: 'Each section is assembled from 0; the linker decides where each one goes. Within .text the distance from a branch to its label is fixed, but from .text to .data it is not known until the sections are placed.',
        why: ['', 'An la to a label in the same section needs none: the distance is fixed.', 'Global or local, the distance is still unknown.', 'Pseudo or not, it is the unknown distance that needs the relocation.'],
      },
    },
    {
      title: 'Relocations: the bits a linker writes',
      body: `
        <p>A relocation is a promise about bits. Take a <code>jal ra, print</code> at offset ${hex(F.jal.site)} of a text section, with <code>print</code> in another file. The assembler wrote the opcode and <code>rd = ra</code>, and left the 20 offset bits empty: an <code>R_RISCV_JAL</code> to <code>print</code>. The linker later puts <code>print</code> at ${hex(F.jal.target)}. The offset is ${hex(F.jal.target)} − ${hex(F.jal.site)} = ${hex(F.jal.offset)}, and its bits go where chapter ${numOf('isa')}'s J-type keeps them: bit 20 first, then bits 10 to 1, bit 11, bits 19 to 12. The order is the hardware's, chosen so that bits land in the same place across formats; the linker just follows it.</p>
        <p>The other kinds work the same way, each with its own field: a branch (<code>R_RISCV_BRANCH</code>) has 12 bits and reaches ±4 KiB; a call (<code>R_RISCV_CALL</code>) is an <code>auipc</code> and a <code>jalr</code>, 32 bits split 20 + 12; <code>la</code> is <code>R_RISCV_PCREL_HI20</code> on its auipc and <code>R_RISCV_PCREL_LO12_I</code> on its addi. The split has one trap: the low 12 bits are <em>signed</em>. For a distance of ${hex(0xf80)} the addi cannot hold +3968, so the high part rounds up to ${F.laHi} (4096) and the low part is −${-F.laLo}. That is the <code>+0x800</code> in every linker: high = (value + 0x800) &gt;&gt; 12.</p>
        <p>The strip is the jal's 32 bits. The dashed ones are the hole. Fill them so the jal reaches <code>print</code>; the disassembly underneath follows each click.</p>
        <div class="try">Fill the hole: the disassembly reads <code>jal ra</code> to print's address.</div>`,
      widget: relocWidget,
      more: {
        real: `<p>GNU's assembler and linker follow the same kinds with three differences. A call is now marked <code>R_RISCV_CALL_PLT</code> (plain <code>R_RISCV_CALL</code> is deprecated; the bits written are the same). An offset added to a symbol, as in <code>la a0, table+8</code>, is kept in the relocation entry itself (ELF's RELA form), so a hole in the file is zero, as here. And the linker <em>relaxes</em>: an auipc and jalr whose target turns out to be near becomes one jal, and code after it moves up. Each such pair carries an extra <code>R_RISCV_RELAX</code>, and because code may move, the assembler leaves relocations even on branches and jumps within one file, which this chapter's assembler resolves itself.</p>`,
      },
      challenge: {
        kind: 'reach',
        goal: `Fill the jal's immediate bits so it jumps from ${hex(F.jal.site)} to print at ${hex(F.jal.target)}.`,
        check: () => relocSolved(),
        hints: [`The offset is ${hex(F.jal.target)} − ${hex(F.jal.site)} = ${hex(F.jal.offset)} = ${F.jal.offset}: which bits of it are 1?`, `${F.jal.offset} in binary is ${F.jal.offset.toString(2)}. Hover a bit of the strip: it says which offset bit it holds.`],
        answer: `${F.jal.offset} = 0b${F.jal.offset.toString(2)}: set the strip's bits that hold those offset bits (offset bit k for 1 ≤ k ≤ 10 sits in instruction bit 20 + k). The word becomes the linker's: jal ra, ${hex(F.jal.target)}.`,
        solve: () => solveReloc(),
      },
      tries: [() => relocSolved()],
    },
    {
      title: 'Link: merge, place, patch',
      body: `
        <p>The linker does three things. It <strong>merges</strong>: every object's .text goes into one text, every .data into one data, every .bss into one .bss. It <strong>places</strong>: each merged section gets an address, here the kernel's map from chapter ${numOf('os')} (text at ${hex(VA.code)}, data at ${hex(VA.data1)}), and so every symbol gets one. It <strong>patches</strong>: for each relocation it computes the value and writes its bits. Our two files become ${F.text} instructions and ${F.data} words of data, with ${F.patches} patches (a call is two).</p>
        <p>The widget shows each patch, the instruction before and after. Switch the files to see the two errors every linker reports. Without <code>.globl print</code>, <code>print</code> is local to <code>util.o</code> and <code>main.o</code>'s holes have nothing to fill them: <em>undefined</em>. With <code>add2</code> defined in both files the linker cannot choose: <em>defined twice</em>. A third error waits for long programs: a <code>jal</code> reaches only ±1 MiB, and a linker that finds a target further away says so; the fix is <code>call</code>, whose auipc reaches ±2 GiB.</p>`,
      widget: linkWidget,
      challenge: {
        kind: 'quiz',
        question: 'util.s forgets .globl print. What does the linker say, and why?',
        options: ['print is undefined: a local symbol is not offered to other files', 'Nothing: the linker finds print anyway', 'print is defined twice', 'The assembler refuses util.s'],
        answer: 0,
        explain: 'A local symbol belongs to its own file; that is what lets two files each have a label called loop. main.o\'s relocations need a global print, and there is none.',
        why: ['', 'Finding local symbols of other files would make every helper label a clash.', 'There is only one print, and it is local.', 'util.s is fine on its own; the problem shows only when another file needs print.'],
      },
    },
    {
      title: 'Libraries: take only what is used',
      body: `
        <p>A library is a collection of object files, an <strong>archive</strong>, each member usually one routine. Linking one does not copy all of it. The linker pulls a member in only when something already in the link needs a symbol it defines, then looks again, since that member may need others. Here two archives hold ${F.lib.members} routines; the program calls one of them and ends up with ${F.lib.pulled.length}: ${F.lib.used} of ${F.lib.all} words, ${F.lib.saved} words of ROM not spent.</p>
        <p>The order on the command line matters, and catches everyone once. A linker reads the archives in order and does not go back: one it has passed is not scanned again. <code>pclamp</code> in libio needs <code>clamp</code> in libmath; with libmath named first, nothing needed it yet when it was scanned, and <code>${F.lib.wrongMissing.join(', ')}</code> stays undefined. The fix is to name the library that needs after the one that provides it (or to ask the linker to loop over a group).</p>`,
      widget: libraryWidget,
      challenge: {
        kind: 'quiz',
        question: 'ld main.o libmath.a libio.a fails with "clamp is undefined", though libmath.a defines clamp. Why?',
        options: ['libmath.a was scanned before anything needed clamp, and the linker does not go back to it', 'clamp is local to libmath.a', 'libio.a defines clamp too', 'An archive can only be used once'],
        answer: 0,
        explain: 'The need for clamp appears only when pclamp is pulled from libio.a, after libmath.a has been passed. Naming libmath.a last (or both inside a group) fixes it.',
        why: ['', 'clamp is global; with the other order the same archive provides it.', 'Then it would be defined, not undefined.', 'An archive is scanned once, in its place; it can be named again, which is another fix.'],
      },
    },
    {
      title: 'The executable',
      body: `
        <p>The linker's output is a file the loader can read without knowing anything about the program: an <strong>executable</strong>. RISC-V systems use <strong>ELF</strong>. A ${ELF32_EHSIZE}-byte header says what it is (a 32-bit little-endian RISC-V executable), where execution starts (the entry, <code>main</code> at ${hex(F.entry)}) and where the program headers are. Each <strong>program header</strong> of ${ELF32_PHSIZE} bytes is a segment to load: where its bytes are in the file, its virtual address, how many bytes are in the file and how many in memory (more in memory: the rest is .bss, zeroed), and its permissions.</p>
        <p>Ours has ${F.phnum}: text, read and execute; data and .bss, read and write. The text's <em>physical</em> address differs from its virtual one: ${hex(EXEC_ROM)}, the ROM frame its bytes are put in, for a reason the next step gives. The whole file is ${n(F.elfBytes)} bytes. It is written by the same code that writes the files the site's verification hands to Spike, the RISC-V reference simulator (chapter ${numOf('verify')}).</p>`,
      widget: elfWidget,
      challenge: {
        kind: 'quiz',
        question: 'A program header says 16 bytes in memory, 12 in the file. What does the loader do with the other 4?',
        options: ['Zeroes them: they are .bss, variables that start at zero', 'Reads them from the next segment', 'Leaves whatever was in memory', 'Refuses the file'],
        answer: 0,
        explain: 'Zeros are not stored in the file; only their number is, as the difference between the two sizes. The loader clears them.',
        why: ['', 'Segments are independent; nothing spills from one to the next.', 'Leaving old memory would leak another program\'s data and break programs that rely on zero.', 'memsz larger than filesz is normal: it is how every .bss is loaded.'],
      },
    },
    {
      title: 'The loader: exec on the gates',
      body: `
        <p>Chapter ${numOf('os')}'s kernel could only run the programs it was built with. With one more system call a process can ask for a new program: <code>exec</code>, ${EXEC_SYS} in a7 (Linux's number for execve). The file is on a <strong>disk</strong>. This machine has none, so a data frame at ${hex(DISK_PA)} stands in for one: the kernel's boot fills it with the file's ${F.diskWords} words, one store each. The fill is part of the boot, not of exec, and is not counted below.</p>
        <p>Exec reads the header and the program headers off the disk, as the widget of the last step did. For the data segment it copies the bytes into the frame the process's page table maps at its address and zeroes the rest (.bss). For the text segment it copies nothing. This CPU is <strong>Harvard</strong>: instruction fetch reaches only the ROM, so text copied into data memory could never be run. The text was put in the ROM frame its physical address names, and exec maps its page there, read and execute and <em>not</em> write: the program runs in place, as a microcontroller runs from its flash. Then the entry into the saved PC, a fresh stack (sp = ${hex(EXEC_SP)}), <code>sfence.vma</code> (which drops the translations the MMU has cached, so the new mappings take effect), and the return: the process that called exec is now running the new program.</p>
        <p>On the gates exec takes <strong>${n(F.execCycles)} cycles</strong>, each word of .data ${F.perDataWord} more and each word of .bss ${F.perBssWord}. Run the scene: the shell calls exec, and the console prints what the two linked files compute.</p>
        <div class="try">Run to halt and read the console: the numbers come from main.s and util.s, loaded by exec.</div>`,
      scene: scenes.exec,
      lit: 'The CSR unit and the MMU',
      challenge: {
        kind: 'quiz',
        question: 'Why does exec map the text onto the ROM instead of copying it into a free frame, as it does the data?',
        options: ['This CPU fetches instructions only from the ROM: copied text in data memory could not be run', 'Copying would be too slow', 'The ELF file has no text bytes', 'The text must be shared by every process'],
        answer: 0,
        explain: 'Instruction fetch and data access go to different memories (Harvard). The page table can point a fetch only at a ROM frame, so the text has to be there already, and exec maps it.',
        why: ['', 'Speed is a side benefit; the reason is that copied text could not run at all.', 'The file has them; the loader just does not need them on this machine.', 'Sharing comes in the next step, and needs more than this.'],
      },
    },
    {
      title: 'Protection: text without W, data without X',
      body: `
        <p>The permissions in the program headers are now page-table bits, and the page tables of chapter ${numOf('vmem')} enforce them on every access. This program, linked and loaded the same way, stores a word into its own code. The store is translated, the walker finds the text's leaf, and the leaf has no W: a <strong>store page fault</strong> (cause 15). The kernel of chapter ${numOf('os')} ends the process and says so. A jump into the data meets the other half: the data's leaf has no X, and the fetch faults (cause 12).</p>
        <p>Code that writes itself is almost always a stray pointer or an attack. Keeping writable and executable apart (W^X) turns both into a page fault the kernel catches, at no cost to a program that behaves.</p>
        <div class="try">Run to halt: the console says !A killed, cause 15.</div>`,
      scene: scenes.rogue,
      lit: 'The MMU and the trap logic',
      challenge: {
        kind: 'quiz',
        question: 'The program jumps to an address in its .data. What stops it?',
        options: ['The data page has no X: the fetch is an instruction page fault (cause 12)', 'Nothing: data holds valid instructions', 'A store page fault', 'The assembler refuses the jump'],
        answer: 0,
        explain: 'The loader mapped data read and write only. A fetch checks X, finds it clear and faults; the kernel ends the process.',
        why: ['', 'On this machine fetch could not even reach data memory; the page fault is the protection saying so before anything is fetched.', 'It is a fetch, not a store.', 'The address is computed at run time; the assembler cannot know where it points.'],
      },
    },
    {
      title: 'One library, two processes',
      body: `
        <p>Every program on a computer calls the same printing, string and memory routines. Linked statically, each carries its own copy. A <strong>shared library</strong> is loaded once, its text mapped into every process that uses it, saving memory and letting one update fix everyone. The text cannot be patched per process, since it is shared, and it may be mapped at a different address in each. So shared code is <strong>position independent</strong>: it reaches its own code by pc-relative jumps (which work anywhere), and everything outside through a <strong>table</strong> in its data, which each process has its own copy of and the loader fills with that process's addresses.</p>
        <p>The price is the table. The widget runs the same loop calling a library routine ${F.pic.calls} times, once with the address patched into the call and once loaded from a table entry: ${F.pic.perCall} more instructions per call, ${F.pic.loads} of them a load. Real systems pay about the same. A call compiled to go through the table directly (GCC's <code>-fno-plt</code>) is auipc, a load and jalr where a direct call is auipc and jalr: one more instruction, the load. The usual route jumps first to a small stub, the <em>procedure linkage table</em>, which loads the address and jumps on: four more instructions, one a load. The stub is what allows lazy binding: a table entry starts pointing at the dynamic linker, which fills it on the first call. The saving is memory: one copy of the library's text for every process that maps it.</p>`,
      widget: picWidget,
      challenge: {
        kind: 'quiz',
        question: 'Why does position-independent code call other modules through a table instead of with a patched call?',
        options: ['The code is shared and cannot be patched per process; the table is data, and each process has its own', 'Patched calls are slower', 'The table makes the call faster', 'The linker cannot patch calls'],
        answer: 0,
        explain: 'Patching would write process-specific addresses into pages every process shares. Moving the addresses into a per-process table keeps the code identical everywhere, at the cost of a load per call.',
        why: ['', 'They are faster: the table adds a load.', 'It costs instructions, as the widget measures.', 'It can, and does for static links; shared text is the reason not to.'],
      },
    },
    {
      title: 'Doom, linked',
      body: `
        <p>Appendix B's Doom was built by GNU's linker with a linker script, <code>ports/doom/platform/link.ld</code>, and nothing in it is new now. Its machine is Harvard too, so the script makes two regions: <code>ROM (rx)</code> at 0 for every <code>.text</code>, and <code>RAM (rw)</code> from 0x1000 for <code>.rodata</code>, <code>.data</code> and <code>.bss</code>. Its comment says why constants go to RAM: "no constant may land in the instruction ROM", because loads cannot reach it. The first page of data addresses, 0 to 0xfff, is left empty, so a stray null pointer reads nothing the program put there.</p>
        <p>The script also names symbols the program reads: <code>__bss_start</code> and <code>__bss_end</code>, which the start-up code <code>crt0.S</code> zeroes between before <code>main</code>, and <code>__stack_top</code>, where the stack starts. The site's image of Doom is our own format, simpler than ELF: the ROM's words, the RAM's initial words and where .bss ends. The widget reads it.</p>`,
      widget: doomWidget,
      challenge: {
        kind: 'quiz',
        question: 'Why does Doom\'s linker script put .rodata (constant tables) in RAM rather than in the ROM with the code?',
        options: ['Loads reach only the RAM on that Harvard machine: a constant in the ROM could not be read', 'RAM is faster', 'The ROM is full', 'Constants change while Doom runs'],
        answer: 0,
        explain: 'Instructions are fetched from the ROM, data is loaded from the RAM; a load of a ROM address would read RAM instead. So every byte a load must see has to be placed in RAM.',
        why: ['', 'Speed is not the issue; reachability is.', 'Size is not the reason given in the script.', 'They are constants; they stay the same.'],
      },
    },
  ],
};

/** The program as main.s and util.s print it (MAIN_OUTPUT): re-exported for the content test. */
export { MAIN_OUTPUT };
