// Starting a puzzle: which CPUs it can be played on, and the puzzle chip made from the choice. A puzzle is
// played on its own chip (u_pz_<puzzle>), never on the chip it came from: a ready-wired computer, a copy of
// one of the learner's chips with the two ports placed beside it, or the RV16 computer around one of the
// learner's single-cycle campaign cores. No DOM.

import { nodeOfChip } from '../campaign/levels';
import type { ChipDoc, Workspace } from '../editor/model';
import { uniqueName } from '../editor/model';
import { openChip } from '../editor/session';
import type { ComponentDef } from '../sim/types';
import { CORE_PORTS } from '../lib/rv16/cpu';
import { computerChip, copyForPuzzle, REF_COMPUTERS, type RefCpu, romRefOf } from './computers';
import { type Puzzle, puzzleChipId } from './puzzles';
import { hardwareNands, programRoms } from './run';

/** Single-cycle campaign cores (a load's address and its instruction are on the pins in the same cycle). */
export const SINGLE_CYCLE_CORES = new Set(['c_core3', 'c_fast', 'y_trap', 'y_irq', 'o_mcore', 'o_dcore']);

export type StartChoice =
  | { kind: 'ref'; cpu: RefCpu }
  | { kind: 'chip'; chip: string }
  | { kind: 'core'; chip: string };

export interface Candidate {
  choice: StartChoice;
  name: string;
  /** What kind of thing it is (for the tag). */
  tag: 'ready' | 'your chip' | 'campaign core';
  /** ISA of its ROM: an editor ROM language ('asm', 'rv16', 'cpu4', 'hex', 'isa' for a custom table), and its name. */
  lang: string;
  langLabel: string;
  /** One line under the name. */
  detail: string;
  nands?: number;
}

const LANG_NAMES: Record<string, string> = { asm: 'RV32', rv16: 'RV16', cpu4: '4-bit (4004)', hex: 'hex words' };
export const langName = (lang: string) => LANG_NAMES[lang] ?? lang;

/** What a ROM's program is written in, for a tag: a built-in language, or a custom table's name. */
export const romLangName = (rom: { lang: string; isa?: { name: string } }) => (rom.lang === 'isa' && rom.isa ? rom.isa.name : langName(rom.lang));

/** Does a chip place a halt part (at any depth)? */
function hasHalt(doc: ChipDoc, chips: Readonly<Record<string, ChipDoc>>, depth = 3): boolean {
  return doc.parts.some((p) => ('display' in p.ref && p.ref.display === 'halt') || ('chip' in p.ref && depth > 0 && !!chips[p.ref.chip] && hasHalt(chips[p.ref.chip], chips, depth - 1)));
}

/** A compiled chip with the RV16 core's pins (any order; irq allowed). */
function isCore16(def: ComponentDef | undefined): boolean {
  if (!def) return false;
  return CORE_PORTS.every((p) => def.ports.some((q) => q.name === p.name && q.dir === p.dir && q.width === p.width));
}

/** Every CPU the puzzle can start on: the ready-wired computers, the learner's chips with a program ROM, their single-cycle campaign cores. */
export function startCandidates(ws: Workspace, defOf: (chip: string) => ComponentDef | undefined): Candidate[] {
  const out: Candidate[] = REF_COMPUTERS.map((c) => ({
    choice: { kind: 'ref', cpu: c.id }, name: c.name, tag: 'ready', lang: c.lang, langLabel: langName(c.lang),
    detail: `${c.width}-bit puzzle ports, wired`,
  }));
  for (const [id, doc] of Object.entries(ws.chips)) {
    if (id.startsWith('u_pz_')) continue;
    const node = nodeOfChip(id);
    if (node && SINGLE_CYCLE_CORES.has(node.id) && isCore16(defOf(id))) {
      const def = defOf(id)!;
      out.push({ choice: { kind: 'core', chip: id }, name: doc.name, tag: 'campaign core', lang: 'rv16', langLabel: langName('rv16'), detail: `your ${node.title} in the RV16 puzzle computer · core ${hardwareNands(def).toLocaleString('en')} NANDs`, nands: hardwareNands(def) });
      continue;
    }
    const roms = programRoms(doc, ws.chips);
    if (roms.length !== 1) continue;
    const r = (roms[0].part.ref as { rom: { k: number; w: number; lang: string; isa?: { name: string } } }).rom;
    const def = defOf(id);
    const n = def ? hardwareNands(def) : undefined;
    out.push({
      choice: { kind: 'chip', chip: id }, name: doc.name, tag: 'your chip', lang: r.lang, langLabel: romLangName(r),
      detail: `ROM ${(2 ** r.k).toLocaleString('en')} × ${r.w} at ${roms[0].path}${n !== undefined ? ` · ${n.toLocaleString('en')} NANDs` : ''} · you wire the ports`, nands: n,
    });
  }
  return out;
}

/** The program a new puzzle chip's ROM starts with: what to read, write and how to halt, in that ISA. */
export function starterProgram(cpu: RefCpu, p: Puzzle): string {
  const brief = p.brief.replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, ' ');
  if (cpu === 'cpu4') return `; ${p.title}: ${brief}\n; RDR reads the next nibble (a word comes high nibble first), WRR writes A to OUT.\nloop:   RDR\n        WRR\ndone:   JUN  done\n`;
  if (cpu === 'rv16') return `# ${p.title}: ${brief}\n# lw rd, -4(x0) reads IN, sw rs, -3(x0) writes OUT, halt stops.\n        lw   a0, -4(x0)\n        sw   a0, -3(x0)\n        halt\n`;
  return `# ${p.title}: ${brief}\n# lw rd, 0(s0) reads IN, sw rs, 4(s0) writes OUT, j . halts.\n        lui  s0, 0x80000\n        lw   a0, 0(s0)\n        sw   a0, 4(s0)\ndone:   j    done\n`;
}

/** Make (or replace) the puzzle's chip from a choice, and open it. */
export function startPuzzle(ws: Workspace, p: Puzzle, choice: StartChoice, defOf: (chip: string) => ComponentDef | undefined): { ws: Workspace; chipId: string } | { error: string } {
  const id = puzzleChipId(p);
  const name = uniqueName(`Puzzle: ${p.title}`, Object.values(ws.chips).filter((c) => c.id !== id).map((c) => c.name));
  let doc: ChipDoc;
  try {
    if (choice.kind === 'ref') doc = computerChip(choice.cpu, id, name, starterProgram(choice.cpu, p));
    else if (choice.kind === 'core') {
      const def = defOf(choice.chip);
      if (!def) return { error: 'that core does not compile' };
      doc = computerChip('rv16', id, name, starterProgram('rv16', p), { def, chip: choice.chip });
    } else {
      const src = ws.chips[choice.chip];
      if (!src) return { error: 'no such chip' };
      const roms = programRoms(src, ws.chips);
      const w = (roms[0]?.part.ref as { rom?: { w: number } } | undefined)?.rom?.w;
      doc = copyForPuzzle(src, id, name, w && w < 8 ? w : 8, hasHalt(src, ws.chips));
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  return { ws: openChip({ ...ws, chips: { ...ws.chips, [id]: doc } }, id), chipId: id };
}

/** The reference program for a puzzle chip made from a ready computer, in its ROM (Do it for me). */
export function withProgram(doc: ChipDoc, src: string): ChipDoc | null {
  const i = doc.parts.findIndex((q) => 'rom' in q.ref);
  if (i < 0 || doc.parts.slice(i + 1).some((q) => 'rom' in q.ref)) return null;
  const r = (doc.parts[i].ref as { rom: Extract<ReturnType<typeof romRefOf>, { rom: unknown }>['rom'] }).rom;
  const parts = doc.parts.slice();
  parts[i] = { ...parts[i], ref: { rom: { ...r, src } } };
  return { ...doc, parts };
}

/** The ROM language of a puzzle chip's program and its name (null: no ROM, or several). */
export function chipLang(doc: ChipDoc, chips: Readonly<Record<string, ChipDoc>>): { lang: string; label: string } | null {
  const roms = programRoms(doc, chips);
  if (roms.length !== 1) return null;
  const r = (roms[0].part.ref as { rom: { lang: string; isa?: { name: string } } }).rom;
  return { lang: r.lang, label: romLangName(r) };
}

