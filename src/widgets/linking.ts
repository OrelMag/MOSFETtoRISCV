// Chapter 'linking': the explainers. Every object file, symbol, relocation, patch and ELF header shown is made here by the site's own tools
// (riscv/link.ts, riscv/elf.ts, riscv/execprograms.ts); the chapter's numbers come from the same calls (chapters/ch-linking.ts linkFigures,
// pinned by tests/content-linking.test.ts).

import { h } from '../ui/dom';
import type { Widget } from '../view/stage';
import { groupDigits } from '../sim/numfmt';
import { disasm } from '../riscv/isa';
import { assemble } from '../riscv/asm';
import { assembleObject, link, pullMembers, type LinkResult, type ObjFile } from '../riscv/link';
import { ELF32_EHSIZE, ELF32_PHSIZE, PF_R, PF_W, PF_X } from '../riscv/elf';
import { buildExecutable, MAIN_S, UTIL_S, type SourceFile } from '../riscv/execprograms';
import { VA } from '../riscv/osprograms';
import '../styles/linking.css';

const hex = (v: number, d = 4) => '0x' + (v >>> 0).toString(16).padStart(d, '0');
const flagText = (f: number) => `${f & PF_R ? 'R' : '-'}${f & PF_W ? 'W' : '-'}${f & PF_X ? 'X' : '-'}`;

// ---- step 1: one program, two files ---------------------------------------------------------------------------------------------

/** Assembling main.s alone, as every chapter so far assembled a program (one file, every label its own): what the assembler says. */
export const aloneErrors = (): string[] => [...new Set(assemble(MAIN_S.text).errors.map((e) => /^not a number: "(.+)"$/.exec(e.message)?.[1]).filter((x): x is string => !!x))];

export function twoFilesWidget(): Widget {
  const exe = buildExecutable([MAIN_S, UTIL_S]);
  const file = (f: SourceFile) => h('div', { class: 'ln-file' }, h('h5', null, f.name), h('pre', null, f.text));
  const el = h('div', { class: 'widget ln-widget' },
    h('div', { class: 'ln-cols' }, file(MAIN_S), file(UTIL_S)),
    h('p', { class: 'sub' }, `Assembled alone, main.s stops at what it cannot know: ${aloneErrors().join(' and ')} are not defined in it. `
      + `Assembled as objects and linked, the two make one program of ${exe.linked.text.length} instructions and ${exe.linked.data.length} words of data.`));
  return { el };
}

// ---- step 2: an object file ----------------------------------------------------------------------------------------------------

const objView = (o: ObjFile, hole = true) => {
  const relAt = new Map(o.relocs.filter((r) => r.section === 'text').map((r) => [r.offset, r]));
  const listing = (sec: 'text' | 'data') => o.lines[sec].map((l) => {
    const r = relAt.get(l.addr);
    return h('div', { class: `ln-row${sec === 'text' && r && hole ? ' hole' : ''}` },
      h('span', { class: 'ln-off' }, hex(l.addr)), h('code', { class: 'ln-word' }, hex(l.word, 8)),
      h('span', { class: 'ln-src' }, l.text), r ? h('span', { class: 'ln-rel' }, `${r.kind} ${r.symbol}`) : null);
  });
  return h('div', { class: 'ln-file obj' },
    h('h5', null, o.name.replace(/\.s$/, '.o')),
    h('div', { class: 'ln-sec' }, `.text, ${o.text.length} words`), ...listing('text'),
    o.data.length ? h('div', { class: 'ln-sec' }, `.data, ${o.data.length} words`) : null, ...(o.data.length ? listing('data') : []),
    o.bss ? h('div', { class: 'ln-sec' }, `.bss, ${o.bss} bytes (no contents: only a size)`) : null,
    h('div', { class: 'ln-sec' }, 'symbols'),
    ...o.symbols.map((s) => h('div', { class: 'ln-row' }, h('span', { class: 'ln-sym' }, s.name), h('span', null, `.${s.section}+${hex(s.offset)}`), h('span', { class: 'ln-src' }, s.global ? 'defined, global' : 'defined, local'))),
    ...o.needs.map((s) => h('div', { class: 'ln-row' }, h('span', { class: 'ln-sym' }, s), h('span', null, '?'), h('span', { class: 'ln-src' }, 'needed: defined elsewhere'))),
    h('div', { class: 'ln-sec' }, 'relocations'),
    ...(o.relocs.length ? o.relocs.map((r) => h('div', { class: 'ln-row' }, h('span', { class: 'ln-off' }, `.${r.section}+${hex(r.offset)}`), h('span', { class: 'ln-rel' }, r.kind), h('span', { class: 'ln-sym' }, r.symbol), r.hiAt !== undefined ? h('span', { class: 'ln-src' }, `pairs with the auipc at ${hex(r.hiAt)}`) : null))
      : [h('div', { class: 'ln-row' }, h('span', { class: 'ln-src' }, '(none)'))]));
};

export function objectWidget(): Widget {
  const objs = [assembleObject(MAIN_S.text, MAIN_S.name), assembleObject(UTIL_S.text, UTIL_S.name)];
  const el = h('div', { class: 'widget ln-widget' }, h('div', { class: 'ln-cols' }, ...objs.map((o) => objView(o))),
    h('p', { class: 'sub' }, 'Both files as the site\'s assembler leaves them when it is asked for an object: every section from offset 0, the holes (outlined) zeroed, and the lists the linker will read. Nothing here has an address yet.'));
  return { el };
}

// ---- step 3: the bits a linker writes (the challenge) ---------------------------------------------------------------------------

/** The jal of step 3: main.s's call written as a jal, so the hole is a J-type immediate. */
export const JAL_MAIN: SourceFile = { name: 'main.s', text: `.globl main
main:
  li a0, 7
  li a1, 9
  add a0, a0, a1
  jal ra, print
  j main
` };
/** The library for step 3: a few routines before print, so print lands further on. */
export const JAL_UTIL: SourceFile = { name: 'util.s', text: `.globl print
square:
  slli a0, a0, 2
  ret
twice:
  add a0, a0, a0
  ret
print:
  li a7, 2
  ecall
  ret
` };
export interface JalCase { site: number; target: number; offset: number; word: number; hole: number }
export function jalCase(): JalCase {
  const objs = [assembleObject(JAL_MAIN.text, JAL_MAIN.name), assembleObject(JAL_UTIL.text, JAL_UTIL.name)];
  const r = link(objs);
  const p = r.patches.find((x) => x.kind === 'R_RISCV_JAL')!;
  return { site: p.at, target: p.target, offset: p.value, word: p.after, hole: p.before };
}
/** Instruction bit → offset bit for a J-type immediate (null: not an immediate bit). */
export const J_MAP: (number | null)[] = Array.from({ length: 32 }, (_, b) => (b === 31 ? 20 : b >= 21 ? b - 20 : b === 20 ? 11 : b >= 12 ? b : null));

let relocWord = 0, relocTarget = -1;
/** The challenge: the strip holds the linker's word. */
export const relocSolved = (): boolean => relocTarget >= 0 && relocWord === relocTarget;
let fillReloc: (() => void) | null = null;
export const solveReloc = (): void => fillReloc?.();

export function relocWidget(): Widget {
  const c = jalCase();
  relocTarget = c.word;
  relocWord = c.hole;
  const strip = h('div', { class: 'ln-bits', role: 'group', 'aria-label': 'the 32 bits of the jal: click an immediate bit to flip it' });
  const asm = h('div', { class: 'ln-asm' });
  const status = h('p', { class: 'sub', role: 'status' });
  const draw = () => {
    strip.replaceChildren(...Array.from({ length: 32 }, (_, i) => {
      const b = 31 - i, m = J_MAP[b], v = (relocWord >>> b) & 1;
      const cls = m === null ? (b >= 7 ? 'rd' : 'op') : 'imm';
      const cell = h('button', { type: 'button', class: `ln-bit ${cls}${m !== null && ((c.hole >>> b) & 1) === 0 ? ' hole' : ''}`, title: m === null ? `bit ${b}` : `bit ${b}: offset bit ${m}`, 'aria-label': m === null ? `bit ${b} = ${v}` : `bit ${b}, offset bit ${m}, ${v}`, disabled: m === null ? '' : null }, String(v));
      if (m !== null) cell.addEventListener('click', () => { relocWord = (relocWord ^ (1 << b)) >>> 0; draw(); });
      return cell;
    }));
    asm.replaceChildren(h('code', null, `${hex(c.site)}: ${hex(relocWord, 8)}  ${disasm(relocWord, c.site)}`));
    status.textContent = relocSolved() ? `Right: ${hex(c.site)} + ${hex(c.offset)} = ${hex(c.target)}, print. The linker wrote the same word.` : `print is at ${hex(c.target)}; this jal is at ${hex(c.site)}.`;
  };
  fillReloc = () => { relocWord = c.word; draw(); };
  draw();
  const el = h('div', { class: 'widget ln-widget' },
    h('div', { class: 'ln-labels' }, h('span', { style: 'flex:12' }, 'imm[20 | 10:1 | 11 | 19:12]'), h('span', { style: 'flex:5' }, 'rd'), h('span', { style: 'flex:7' }, 'opcode')),
    strip, asm, status,
    h('div', { class: 'param-row' }, h('button', { type: 'button', class: 'btn sm', onclick: () => { relocWord = c.hole; draw(); } }, 'Clear the hole')));
  return { el, destroy: () => { fillReloc = null; } };
}

// ---- step 4: link (merge, place, patch) and its errors ---------------------------------------------------------------------------

export function linkWidget(): Widget {
  const variants: [string, SourceFile[]][] = [
    ['as written', [MAIN_S, UTIL_S]],
    ['util.s without .globl print', [MAIN_S, { ...UTIL_S, text: UTIL_S.text.replace('.globl print\n', '') }]],
    ['add2 defined in both files', [{ ...MAIN_S, text: MAIN_S.text.replace('.globl main\n', '.globl main\n.globl add2\nadd2:\n  ret\n') }, UTIL_S]],
  ];
  let pick = 0;
  const out = h('div', null);
  const sel = h('select', { 'aria-label': 'which files to link' }, ...variants.map(([n], i) => h('option', { value: String(i) }, n))) as HTMLSelectElement;
  sel.addEventListener('change', () => { pick = Number(sel.value); draw(); });
  const draw = () => {
    const objs = variants[pick][1].map((f) => assembleObject(f.text, f.name));
    const r: LinkResult = link(objs, { textBase: VA.code, dataBase: VA.data1 });
    out.replaceChildren(
      h('table', { class: 'data ln-table' },
        h('tr', null, ...['object', '.text at', '.data at', '.bss at'].map((t) => h('th', null, t))),
        ...r.placed.map((p, i) => h('tr', null, h('td', null, p.name.replace(/\.s$/, '.o')), h('td', null, objs[i].text.length ? hex(p.text) : '-'), h('td', null, objs[i].data.length ? hex(p.data) : '-'), h('td', null, objs[i].bss ? hex(p.bss) : '-')))),
      r.errors.length ? h('div', { class: 'ln-errors', role: 'status' }, ...r.errors.map((e) => h('div', null, `ld: ${e}`)))
        : h('table', { class: 'data ln-table' },
          h('tr', null, ...['at', 'kind', 'symbol', 'value', 'before', 'after'].map((t) => h('th', null, t))),
          ...r.patches.map((p) => h('tr', null, h('td', null, hex(p.at)), h('td', null, p.kind.replace('R_RISCV_', '')), h('td', null, `${p.symbol} = ${hex(p.target)}`),
            h('td', null, p.kind === 'R_RISCV_32' ? hex(p.value, 8) : String(p.value)), h('td', null, h('code', null, p.section === 'text' ? disasm(p.before, p.at) : hex(p.before, 8))), h('td', null, h('code', null, p.section === 'text' ? disasm(p.after, p.at) : hex(p.after, 8)))))));
  };
  draw();
  const el = h('div', { class: 'widget ln-widget' }, h('div', { class: 'param-row' }, h('label', null, 'Link ', sel)), out,
    h('p', { class: 'sub' }, `Linked for the kernel's map: text from ${hex(VA.code)}, data from ${hex(VA.data1)}, .bss after the data. Each row of the second table is one hole the linker filled, the instruction before and after.`));
  return { el };
}

// ---- step 5: libraries -----------------------------------------------------------------------------------------------------------

/** Two archives of one-routine members (as an archive's members are files of their own): libmath.a and libio.a, eight routines. */
const member = (n: string, body: string): SourceFile => ({ name: `${n}.s`, text: `.globl ${n}\n${n}:\n${body}\n` });
export const LIBMATH: SourceFile[] = [
  member('abs', '  bgez a0, abs_done\n  neg a0, a0\nabs_done:\n  ret'),
  member('max', '  bge a0, a1, max_done\n  mv a0, a1\nmax_done:\n  ret'),
  member('min', '  ble a0, a1, min_done\n  mv a0, a1\nmin_done:\n  ret'),
  member('clamp', '  addi sp, sp, -8\n  sw ra, 0(sp)\n  sw a2, 4(sp)\n  call max\n  lw a1, 4(sp)\n  call min\n  lw ra, 0(sp)\n  addi sp, sp, 8\n  ret'),
  member('sum', '  li t0, 0\nsum_loop:\n  beqz a1, sum_done\n  lw t1, 0(a0)\n  add t0, t0, t1\n  addi a0, a0, 4\n  addi a1, a1, -1\n  j sum_loop\nsum_done:\n  mv a0, t0\n  ret'),
  member('fill', 'fill_loop:\n  beqz a1, fill_done\n  sw a2, 0(a0)\n  addi a0, a0, 4\n  addi a1, a1, -1\n  j fill_loop\nfill_done:\n  ret'),
];
export const LIBIO: SourceFile[] = [
  member('print', '  li a7, 2\n  ecall\n  ret'),
  member('pclamp', '  addi sp, sp, -4\n  sw ra, 0(sp)\n  call clamp\n  call print\n  lw ra, 0(sp)\n  addi sp, sp, 4\n  ret'),
];
/** The program of step 5: it prints a value clamped to 0 .. 100 with pclamp, nothing else. */
export const LIB_MAIN: SourceFile = { name: 'main.s', text: `.globl main\nmain:\n  li sp, 0x1000\n  li a0, 250\n  li a1, 0\n  li a2, 100\n  call pclamp\n  li a7, 93\n  ecall\n` };

export interface LibCase { all: number; pulled: string[]; used: number; saved: number; members: number; wrongMissing: string[] }
export function libCase(): LibCase {
  const math = LIBMATH.map((f) => assembleObject(f.text, f.name)), io = LIBIO.map((f) => assembleObject(f.text, f.name)), main = assembleObject(LIB_MAIN.text, LIB_MAIN.name);
  const right = pullMembers([main], [io, math]), wrong = pullMembers([main], [math, io]);
  const words = (os: ObjFile[]) => os.reduce((s, o) => s + o.text.length, 0);
  const all = words([...math, ...io]), used = words(right.objs.slice(1));
  return { all, pulled: right.objs.slice(1).map((o) => o.name), used, saved: all - used, members: math.length + io.length, wrongMissing: wrong.missing };
}

export function libraryWidget(): Widget {
  const c = libCase();
  const row = (lib: string) => (m: ObjFile) => h('tr', { class: c.pulled.includes(m.name) ? 'on' : '' }, h('td', null, lib), h('td', null, m.name.replace(/\.s$/, '.o')),
    h('td', null, m.needs.join(', ') || '-'), h('td', null, String(m.text.length)), h('td', null, c.pulled.includes(m.name) ? 'yes' : ''));
  const el = h('div', { class: 'widget ln-widget' },
    h('table', { class: 'data ln-table' },
      h('tr', null, ...['archive', 'member', 'needs', 'words', 'pulled in'].map((t) => h('th', null, t))),
      ...LIBIO.map((f) => assembleObject(f.text, f.name)).map(row('libio.a')),
      ...LIBMATH.map((f) => assembleObject(f.text, f.name)).map(row('libmath.a'))),
    h('p', { class: 'sub' }, `ld main.o libio.a libmath.a: main needs pclamp; libio.a gives it and, scanned again, print; libmath.a then gives clamp and, scanned again, max and min. ${c.pulled.length} of ${c.members} members, ${c.used} of the libraries' ${c.all} words: ${c.saved} words of ROM not spent. `
      + `ld main.o libmath.a libio.a fails: libmath.a was scanned while nothing needed it, and is not looked at again (undefined: ${c.wrongMissing.join(', ')}).`));
  return { el };
}

// ---- step 6: the executable ------------------------------------------------------------------------------------------------------

export function elfWidget(): Widget {
  const exe = buildExecutable([MAIN_S, UTIL_S]);
  const b = exe.elf, info = exe.info;
  const bytes = (from: number, n: number) => Array.from(b.subarray(from, from + n), (x) => x.toString(16).padStart(2, '0')).join(' ');
  const el = h('div', { class: 'widget ln-widget' },
    h('table', { class: 'data ln-table' },
      h('tr', null, ...['bytes', 'field', 'value'].map((t) => h('th', null, t))),
      h('tr', null, h('td', null, h('code', null, bytes(0, 4))), h('td', null, 'magic'), h('td', null, '7f "ELF"')),
      h('tr', null, h('td', null, h('code', null, bytes(4, 3))), h('td', null, 'class, data, version'), h('td', null, '32-bit, little-endian, 1')),
      h('tr', null, h('td', null, h('code', null, bytes(16, 4))), h('td', null, 'type, machine'), h('td', null, 'an executable, RISC-V (243)')),
      h('tr', null, h('td', null, h('code', null, bytes(24, 4))), h('td', null, 'entry'), h('td', null, `${hex(info.entry)}: main`)),
      h('tr', null, h('td', null, h('code', null, bytes(28, 4))), h('td', null, 'program headers at'), h('td', null, `byte ${info.phoff}, ${info.phnum} of ${ELF32_PHSIZE} bytes`))),
    h('table', { class: 'data ln-table' },
      h('tr', null, ...['program header', 'file offset', 'virtual', 'physical', 'in the file', 'in memory', 'flags'].map((t) => h('th', null, t))),
      ...info.segments.map((s, i) => h('tr', null, h('td', null, `LOAD ${i}`), h('td', null, String(s.offset)), h('td', null, hex(s.vaddr)), h('td', null, hex(s.paddr)), h('td', null, `${s.filesz} bytes`), h('td', null, `${s.memsz} bytes`), h('td', null, h('code', null, flagText(s.flags)))))),
    h('p', { class: 'sub' }, `The whole file is ${groupDigits(b.length)} bytes: a ${ELF32_EHSIZE}-byte header, ${info.phnum} program headers, the segments' bytes, then a symbol table (${Object.keys(info.symbols).join(', ')}) that a loader ignores and a debugger reads. Written by the same code the site's Spike check uses, read back here by its reader.`));
  return { el };
}

// ---- step 8: one library, two processes (position-independent code) -------------------------------------------------------------

import { ISS } from '../riscv/iss';

/** The same loop calling a library routine n times: directly (call: auipc + jalr, the address patched in) or through a table (the routine's address loaded from a word the loader fills, then jalr). */
export const picProgram = (n: number, through: boolean): SourceFile[] => [
  { name: 'main.s', text: `.globl main
main:
  li s0, ${n}
  li a0, 0
loop:
${through ? '  la t0, got_inc     # the table entry: this process\'s own copy, in its data\n  lw t0, 0(t0)       # the routine\'s address, wherever the library was mapped\n  jalr ra, 0(t0)' : '  call inc'}
  addi s0, s0, -1
  bnez s0, loop
done:
  j done
${through ? '.data\ngot_inc:\n  .word inc\n' : ''}` },
  { name: 'lib.s', text: '.globl inc\ninc:\n  addi a0, a0, 1\n  ret\n' },
];

export interface PicCost { calls: number; direct: number; through: number; perCall: number; loads: number; libWords: number }
/** Instructions of both versions on the golden model, run to the jump to itself. */
export function picCost(calls = 100): PicCost {
  const run = (through: boolean) => {
    const r = link(picProgram(calls, through).map((f) => assembleObject(f.text, f.name)));
    const iss = new ISS(r.text, { dmemWords: 1024 });
    r.data.forEach((w, i) => { iss.dmem[(r.dataBase >>> 2) + i] = w; }); // the loader's job: initial data into data memory
    let loads = 0;
    for (let k = 0; !iss.halted && k < 100000; k++) { const s = iss.step(); if (s && (s.word & 0x7f) === 0x03) loads++; }
    return { steps: iss.steps, loads, lib: r.placed[1] };
  };
  const d = run(false), t = run(true);
  const libWords = assembleObject(picProgram(calls, false)[1].text, 'lib.s').text.length;
  return { calls, direct: d.steps, through: t.steps, perCall: (t.steps - d.steps) / calls, loads: (t.loads - d.loads) / calls, libWords };
}

export function picWidget(): Widget {
  const c = picCost();
  const el = h('div', { class: 'widget ln-widget' },
    h('div', { class: 'ln-cols' }, ...[false, true].map((t) => h('div', { class: 'ln-file' }, h('h5', null, t ? 'through a table (position independent)' : 'direct (the address patched into the code)'), h('pre', null, picProgram(3, t)[0].text.split('\n').slice(4, t ? 7 : 5).join('\n'))))),
    h('table', { class: 'data ln-table' },
      h('tr', null, ...['', `instructions, ${c.calls} calls`, 'per call', 'loads per call'].map((x) => h('th', null, x))),
      h('tr', null, h('td', null, 'direct'), h('td', null, groupDigits(c.direct)), h('td', null, ''), h('td', null, '')),
      h('tr', null, h('td', null, 'through the table'), h('td', null, groupDigits(c.through)), h('td', null, `+${c.perCall}`), h('td', null, `+${c.loads}`))),
    h('p', { class: 'sub' }, 'Both versions linked by the site\'s linker and run on the golden model. The table entry is data, so each process has its own copy and the code that reads it can be shared: one copy of the library\'s text in ROM, mapped into every process that uses it.'));
  return { el };
}

// ---- step 9: Doom, linked --------------------------------------------------------------------------------------------------------

/** Appendix B's image (public/doom/doom.img): its header says what the linker script made. Fetched when the step opens. */
export function doomWidget(): Widget {
  const out = h('div', null, h('p', { class: 'sub' }, 'Reading doom.img…'));
  let alive = true;
  void (async () => {
    try {
      const { parseImage } = await import('../doom/image');
      const res = await fetch(`${import.meta.env.BASE_URL}doom/doom.img`);
      const img = parseImage(await res.arrayBuffer());
      if (!alive) return;
      const dataEnd = img.dataBase + 4 * img.data.length;
      out.replaceChildren(h('table', { class: 'data ln-table' },
        h('tr', null, ...['region', 'from', 'to', 'size', 'where it comes from'].map((t) => h('th', null, t))),
        h('tr', null, h('td', null, '.text (ROM, R X)'), h('td', null, hex(img.textBase, 8)), h('td', null, hex(img.textBase + 4 * img.text.length, 8)), h('td', null, `${groupDigits(4 * img.text.length)} bytes`), h('td', null, 'the image\'s ROM words')),
        h('tr', null, h('td', null, '.rodata, .data (RAM, R W)'), h('td', null, hex(img.dataBase, 8)), h('td', null, hex(dataEnd, 8)), h('td', null, `${groupDigits(4 * img.data.length)} bytes`), h('td', null, 'the image\'s RAM words, placed before the CPU starts')),
        h('tr', null, h('td', null, '.bss (RAM, R W)'), h('td', null, hex(dataEnd, 8)), h('td', null, hex(img.bssEnd, 8)), h('td', null, `${groupDigits(img.bssEnd - dataEnd)} bytes`), h('td', null, 'zeroed by crt0.S before main'))),
        h('p', { class: 'sub' }, `Read from Appendix B's doom.img when this step opened: entry ${hex(img.entry, 8)}, the ROM from ${hex(img.textBase, 8)}, the RAM's first word at ${hex(img.dataBase, 8)} (the page below is left unmapped to catch null pointers).`));
    } catch (e) {
      if (alive) out.replaceChildren(h('p', { class: 'sub' }, `doom.img could not load: ${e instanceof Error ? e.message : String(e)}`));
    }
  })();
  return { el: h('div', { class: 'widget ln-widget' }, out), destroy: () => { alive = false; } };
}
