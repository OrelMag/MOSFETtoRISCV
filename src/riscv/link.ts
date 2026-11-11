// Chapter 'linking' (DOM-free): object files and a linker for RV32I assembly. An object file is what the assembler can produce on its own
// when a file names symbols another file defines: its sections (.text, .data, .bss) assembled from offset 0, a symbol table (what it
// defines, global or local) and a relocation list (each hole, its kind and its symbol). The linker lays the sections of every object end to
// end, gives each symbol its address and writes the bits each relocation names.
//
// The relocations are RISC-V's own (the psABI's names): R_RISCV_JAL, R_RISCV_BRANCH, R_RISCV_CALL (an auipc + jalr pair), R_RISCV_PCREL_HI20
// with R_RISCV_PCREL_LO12_I (la: auipc + addi; the low part names the auipc it pairs with, as in ELF) and R_RISCV_32 (a .word holding an
// address). The object is found with the site's own assembler (riscv/asm.ts, unchanged): each section is assembled alone, symbols it does not
// define placed after it, then each such symbol moved on its own; the words that change are the holes, and the statement they came from says
// the kind. tests/link.test.ts holds the result to the assembler: one file linked = the file assembled, a program split into files = the
// joined program, word for word.

import { assemble, type AsmLine } from './asm';

export type SectionName = 'text' | 'data' | 'bss';
export const SECTIONS: readonly SectionName[] = ['text', 'data', 'bss'];

export type RelocKind = 'R_RISCV_JAL' | 'R_RISCV_BRANCH' | 'R_RISCV_CALL' | 'R_RISCV_PCREL_HI20' | 'R_RISCV_PCREL_LO12_I' | 'R_RISCV_32';

export interface Reloc {
  section: SectionName;
  /** Byte offset of the word to patch in its section. */
  offset: number;
  kind: RelocKind;
  symbol: string;
  /** R_RISCV_PCREL_LO12_I: the offset of the auipc it pairs with (the low part is relative to that instruction's address, not its own). */
  hiAt?: number;
}

export interface SymbolDef { name: string; section: SectionName; offset: number; global: boolean }

export interface ObjFile {
  name: string;
  /** Words of .text and .data with every hole zeroed; .bss is a size in bytes. */
  text: number[];
  data: number[];
  bss: number;
  symbols: SymbolDef[];
  /** Symbols this file uses and does not define. */
  needs: string[];
  relocs: Reloc[];
  /** The listing of .text and .data (offsets in the section, the source line, the word as assembled with its holes zeroed). */
  lines: Record<'text' | 'data', AsmLine[]>;
  errors: { line: number; message: string }[];
}

const BRANCHES = new Set(['beq', 'bne', 'blt', 'bge', 'bltu', 'bgeu', 'beqz', 'bnez', 'blez', 'bgez', 'bltz', 'bgtz', 'bgt', 'ble', 'bgtu', 'bleu']);
const LABEL = /^([A-Za-z_.$][\w.$]*)\s*:/;

/** The mask of a kind's immediate bits in its instruction (zero them: the hole). */
const HOLE: Record<RelocKind, number> = {
  R_RISCV_JAL: 0xfffff000, R_RISCV_BRANCH: 0xfe000f80, R_RISCV_CALL: 0xfffff000, R_RISCV_PCREL_HI20: 0xfffff000, R_RISCV_PCREL_LO12_I: 0xfff00000, R_RISCV_32: 0xffffffff,
};
/** The jalr of a call: its immediate is the second hole of R_RISCV_CALL. */
const I_HOLE = 0xfff00000;

const stripComment = (s: string) => { const i = s.search(/#|\/\//); return i < 0 ? s : s.slice(0, i); };
const opOf = (text: string) => { let t = text.trim(); for (let m = LABEL.exec(t); m; m = LABEL.exec(t)) t = t.slice(m[0].length).trim(); return t.split(/\s+/)[0]?.toLowerCase() ?? ''; };

/** Which section each line belongs to, the .bss reservations, the global names. Directives the assembler does not know are turned into ones it does. */
function split(src: string): { per: Record<SectionName, string[]>; globals: Set<string>; bssLabels: Map<string, number>; bss: number; errors: { line: number; message: string }[] } {
  const lines = src.split(/\r?\n/);
  const per: Record<SectionName, string[]> = { text: lines.map(() => ''), data: lines.map(() => ''), bss: lines.map(() => '') };
  const globals = new Set<string>(), bssLabels = new Map<string, number>(), errors: { line: number; message: string }[] = [];
  let sec: SectionName = 'text', bss = 0;
  lines.forEach((raw, i) => {
    let ln = stripComment(raw).trim();
    const labels: string[] = [];
    for (let m = LABEL.exec(ln); m; m = LABEL.exec(ln)) { labels.push(m[1]); ln = ln.slice(m[0].length).trim(); }
    const [op0, ...rest] = ln.split(/\s+/);
    const op = (op0 ?? '').toLowerCase(), arg = rest.join(' ').trim();
    const to = op === '.text' ? 'text' : op === '.data' || op === '.rodata' ? 'data' : op === '.bss' ? 'bss' : op === '.section' ? (/bss/.test(arg) ? 'bss' : /data/.test(arg) ? 'data' : 'text') : null;
    if (to) { sec = to; ln = ''; }
    if (op === '.globl' || op === '.global') { arg.split(/\s*,\s*/).filter(Boolean).forEach((g) => globals.add(g)); ln = ''; }
    let bytes = 0;
    if (op === '.space' || op === '.zero') {
      bytes = Number(arg);
      if (!Number.isInteger(bytes) || bytes < 0 || bytes % 4) { errors.push({ line: i + 1, message: `${op} takes a whole number of words in bytes, not "${arg}"` }); bytes = 0; }
      ln = sec === 'bss' ? '' : bytes ? `.word ${Array(bytes / 4).fill(0).join(', ')}` : '';
    }
    if (sec === 'bss') {
      labels.forEach((l) => bssLabels.set(l, bss));
      if (ln) errors.push({ line: i + 1, message: '.bss holds only labels and .space: it has no contents to assemble' });
      bss += bytes;
      return;
    }
    per[sec][i] = [...labels.map((l) => `${l}:`), ln].join(' ');
  });
  return { per, globals, bssLabels, bss, errors };
}

/** The symbols a section's source names and does not define: the assembler reads an unknown name as a number and says so. */
function unknowns(src: string): string[] {
  // a statement reports only its first unknown name (.word a, b): define what was found and ask again until nothing new appears
  const out = new Set<string>();
  for (let grew = true; grew;) {
    grew = false;
    for (const e of assemble(`${src}\n${[...out].map((s) => `${s}:`).join('\n')}`).errors) {
      const m = /^not a number: "([A-Za-z_.$][\w.$]*)"$/.exec(e.message);
      if (m && !out.has(m[1])) { out.add(m[1]); grew = true; }
    }
  }
  return [...out];
}

/** Assemble a file as an object: sections from offset 0, symbols, holes and the relocations that fill them. */
export function assembleObject(src: string, name = 'a.s'): ObjFile {
  const sp = split(src);
  const errors = [...sp.errors];
  const symbols: SymbolDef[] = [];
  const relocs: Reloc[] = [];
  const needs = new Set<string>();
  const out: Record<'text' | 'data', number[]> = { text: [], data: [] };
  const lines: Record<'text' | 'data', AsmLine[]> = { text: [], data: [] };
  for (const sec of ['text', 'data'] as const) {
    const body = sp.per[sec].join('\n');
    const ext = unknowns(body);
    const place = (moved?: string) => `${body}\n${ext.filter((e) => e !== moved).map((e) => `${e}:`).join('\n')}${moved ? `\n.word ${Array(16).fill(0).join(', ')}\n${moved}:` : ''}`;
    const base = assemble(place());
    const n = assemble(body.length ? body : '').words.length;
    for (const e of base.errors) errors.push(e);
    const words = base.words.slice(0, n);
    const ls = base.lines.filter((l) => l.addr < 4 * n);
    for (const [l, a] of base.labels) if (!ext.includes(l) && a <= 4 * n) symbols.push({ name: l, section: sec, offset: a, global: sp.globals.has(l) });
    for (const e of ext) {
      const moved = assemble(place(e)).words;
      const sites = new Set<number>();
      words.forEach((w, k) => { if (moved[k] !== w) sites.add(k); });
      if (!sites.size) continue;
      needs.add(e);
      // group the changed words by the statement they came from: a pseudo-instruction's words are one relocation (call) or a pair (la)
      const done = new Set<number>();
      for (const k of [...sites].sort((a, b) => a - b)) {
        if (done.has(k)) continue;
        const line = ls.find((l) => l.addr === 4 * k)!;
        const stmt = ls.filter((l) => l.srcLine === line.srcLine && l.text === line.text);
        const first = stmt[0].addr / 4, op = opOf(line.text);
        const add = (kind: RelocKind, at: number, hiAt?: number) => { relocs.push({ section: sec, offset: 4 * at, kind, symbol: e, ...(hiAt !== undefined ? { hiAt: 4 * hiAt } : {}) }); done.add(at); };
        if (op === '.word') add('R_RISCV_32', k);
        else if (op === 'jal' || op === 'j') add('R_RISCV_JAL', k);
        else if (BRANCHES.has(op)) add('R_RISCV_BRANCH', k);
        else if (op === 'call' || op === 'tail') { add('R_RISCV_CALL', first); done.add(first + 1); }
        else if (op === 'la') { add('R_RISCV_PCREL_HI20', first); add('R_RISCV_PCREL_LO12_I', first + 1, first); }
        else { errors.push({ line: line.srcLine, message: `"${op}" with a symbol from another file or section: use la, call, jal, a branch or .word` }); done.add(k); }
      }
    }
    // the holes: what the assembler wrote with the symbols at the section's end means nothing to anyone else
    for (const r of relocs.filter((x) => x.section === sec)) {
      const k = r.offset / 4;
      words[k] = (words[k] & ~HOLE[r.kind]) >>> 0;
      if (r.kind === 'R_RISCV_CALL') words[k + 1] = (words[k + 1] & ~I_HOLE) >>> 0;
    }
    out[sec] = words;
    lines[sec] = ls.map((l) => ({ ...l, word: words[l.addr / 4] }));
  }
  for (const [l, off] of sp.bssLabels) symbols.push({ name: l, section: 'bss', offset: off, global: sp.globals.has(l) });
  for (const g of sp.globals) if (!symbols.some((s) => s.name === g)) errors.push({ line: 0, message: `.globl ${g}: this file does not define it` });
  return { name, text: out.text, data: out.data, bss: sp.bss, symbols, needs: [...needs].filter((s) => !symbols.some((d) => d.name === s)), relocs, lines, errors };
}

// ---- the linker ---------------------------------------------------------------------------------------------------------------

export interface LinkOptions {
  /** Where .text starts (byte address). Default 0. */
  textBase?: number;
  /** Where .data starts; default right after the text (so one image holds both, as one assembled file would). */
  dataBase?: number;
  /** Where .bss starts; default right after the data. */
  bssBase?: number;
}

/** One patch the linker made: where, of which kind, for which symbol, the value it computed and the word before and after. */
export interface Patch { obj: string; section: SectionName; at: number; kind: RelocKind; symbol: string; target: number; value: number; before: number; after: number }

export interface LinkResult {
  /** The text and data as placed: words from textBase and from dataBase. */
  text: number[]; data: number[];
  textBase: number; dataBase: number; bssBase: number; bss: number;
  /** Every symbol's address, by object (locals) and the globals. */
  globals: Map<string, number>;
  locals: Map<string, Map<string, number>>;
  /** Where each object's sections landed. */
  placed: { name: string; text: number; data: number; bss: number }[];
  patches: Patch[];
  errors: string[];
}

const fitsSigned = (v: number, bits: number) => v >= -(2 ** (bits - 1)) && v < 2 ** (bits - 1);
/** Encoders for the immediate fields (the hole is zero). */
const putJ = (w: number, off: number) => (w | ((off & 0x100000) << 11) | ((off & 0x7fe) << 20) | ((off & 0x800) << 9) | (off & 0xff000)) >>> 0;
const putB = (w: number, off: number) => (w | ((off & 0x1000) << 19) | ((off & 0x7e0) << 20) | ((off & 0x1e) << 7) | ((off & 0x800) >>> 4)) >>> 0;
const putU = (w: number, hi: number) => (w | ((hi & 0xfffff) << 12)) >>> 0;
const putI = (w: number, lo: number) => (w | ((lo & 0xfff) << 20)) >>> 0;
/** A pc-relative or absolute value split as auipc / lui and the 12-bit part: the low part is signed, so the high one is rounded (+0x800). */
export const hiLo = (v: number): { hi: number; lo: number } => { const lo = ((v & 0xfff) ^ 0x800) - 0x800; return { hi: ((v - lo) >>> 12) & 0xfffff, lo }; };

/** Link objects in the order given: .text of each, then .data of each, then .bss, every symbol resolved, every hole written. */
export function link(objs: ObjFile[], o: LinkOptions = {}): LinkResult {
  const errors: string[] = [];
  const textBase = o.textBase ?? 0;
  const placed: LinkResult['placed'] = [];
  let at = textBase;
  for (const ob of objs) { placed.push({ name: ob.name, text: at, data: 0, bss: 0 }); at += 4 * ob.text.length; }
  const dataBase = o.dataBase ?? at;
  at = dataBase;
  objs.forEach((ob, i) => { placed[i].data = at; at += 4 * ob.data.length; });
  const bssBase = o.bssBase ?? at;
  at = bssBase;
  objs.forEach((ob, i) => { placed[i].bss = at; at += ob.bss; });
  const bss = at - bssBase;

  const locals = new Map<string, Map<string, number>>();
  const globals = new Map<string, number>(), owner = new Map<string, string>();
  objs.forEach((ob, i) => {
    const m = new Map<string, number>();
    for (const s of ob.symbols) {
      const a = placed[i][s.section] + s.offset;
      m.set(s.name, a);
      if (s.global) {
        if (globals.has(s.name)) errors.push(`"${s.name}" is defined twice: in ${owner.get(s.name)} and in ${ob.name}`);
        else { globals.set(s.name, a); owner.set(s.name, ob.name); }
      }
    }
    locals.set(ob.name, m);
  });

  const text: number[] = [], data: number[] = [];
  for (const ob of objs) { for (const w of ob.text) text.push(w); for (const w of ob.data) data.push(w); }
  const patches: Patch[] = [];
  objs.forEach((ob, i) => {
    const own = locals.get(ob.name)!;
    for (const r of ob.relocs) {
      const S = own.get(r.symbol) ?? globals.get(r.symbol);
      if (S === undefined) {
        const local = objs.find((x) => x !== ob && x.symbols.some((s) => s.name === r.symbol && !s.global));
        errors.push(`${ob.name}: "${r.symbol}" is not defined${local ? ` (${local.name} has it, but not .globl)` : ''}`);
        continue;
      }
      const base = placed[i][r.section], P = base + r.offset;
      const arr = r.section === 'text' ? text : data, k = (P - (r.section === 'text' ? textBase : dataBase)) / 4;
      const before = arr[k];
      let value = 0, after = before;
      if (r.kind === 'R_RISCV_JAL') {
        value = S - P;
        if (!fitsSigned(value, 21)) { errors.push(`${ob.name}: jal to "${r.symbol}" cannot reach ${value} bytes (±1 MiB): use call`); continue; }
        after = putJ(before, value);
      } else if (r.kind === 'R_RISCV_BRANCH') {
        value = S - P;
        if (!fitsSigned(value, 13)) { errors.push(`${ob.name}: a branch to "${r.symbol}" cannot reach ${value} bytes (±4 KiB)`); continue; }
        after = putB(before, value);
      } else if (r.kind === 'R_RISCV_CALL') {
        value = S - P;
        const { hi, lo } = hiLo(value);
        after = putU(before, hi);
        const b2 = arr[k + 1], a2 = putI(b2, lo);
        arr[k + 1] = a2;
        patches.push({ obj: ob.name, section: r.section, at: P + 4, kind: r.kind, symbol: r.symbol, target: S, value: lo, before: b2, after: a2 });
      } else if (r.kind === 'R_RISCV_PCREL_HI20') {
        value = hiLo(S - P).hi;
        after = putU(before, value);
      } else if (r.kind === 'R_RISCV_PCREL_LO12_I') {
        value = hiLo(S - (base + r.hiAt!)).lo;
        after = putI(before, value);
      } else {
        value = S;
        after = S >>> 0;
      }
      arr[k] = after;
      patches.push({ obj: ob.name, section: r.section, at: P, kind: r.kind, symbol: r.symbol, target: S, value, before, after });
    }
  });
  patches.sort((a, b) => a.at - b.at);
  return { text, data, textBase, dataBase, bssBase, bss, globals, locals, placed, patches, errors };
}

/** The linked program as one image of words from textBase: text, then data (only when data follows the text directly). */
export const imageOf = (r: LinkResult): number[] => [...r.text, ...r.data];

/**
 * A library linked the way a static linker does: an archive's member is pulled in only when an object already in the link needs a
 * symbol it defines (the program first, then whatever the pulled members need, until nothing new is needed). Members are visited in
 * order, each scan repeated while it pulls something in: the order still matters, since a member scanned past is not looked at again
 * once the scan ends (`once`: one pass, as the classic Unix ld; otherwise until nothing changes, as with --start-group).
 */
export function pullMembers(program: ObjFile[], archive: ObjFile[], once = true): ObjFile[] {
  const inLink = [...program];
  const defined = () => new Set(inLink.flatMap((o) => o.symbols.filter((s) => s.global).map((s) => s.name)));
  const needed = () => { const d = defined(); return new Set(inLink.flatMap((o) => o.needs).filter((s) => !d.has(s))); };
  for (let pass = 0; ; pass++) {
    let pulled = false;
    for (const m of archive) {
      if (inLink.includes(m)) continue;
      const need = needed();
      if (m.symbols.some((s) => s.global && need.has(s.name))) { inLink.push(m); pulled = true; }
    }
    if (once || !pulled) break;
  }
  return inLink;
}
