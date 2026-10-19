// The glossary: codex entries recognized in running prose. Each entry is found by its title (a
// parenthetical in it becomes a second name: "Processor (CPU)") plus the aliases below; acronyms
// and other mixed-case terms match case-sensitively, lowercase prose terms in any case, plurals
// too. Words too common to mark (or, and, not as prose) are left out, and so are phrases that borrow a term's word
// (a byte lane). chapterSkip: entries a chapter uses in another sense. The hover card shows the
// codex summary. No DOM: glossaryui.ts marks the text.

import { CODEX, type CodexEntry } from './codex';

/** Other names an entry goes by in the chapters' prose. */
const ALIASES: Record<string, string[]> = {
  cpu: ['processor'], fde: ['fetch, decode, execute'], sop: ['sum of products'], nandnand: ['NAND–NAND', 'NAND-NAND'],
  kmap: ['K-map', 'Karnaugh map'], fanin: ['fan-in', 'fan-out'], comparator: ['equality comparator'],
  hex: ['hexadecimal'], twos: ['two’s complement'], signext: ['sign extension', 'sign-extend', 'sign-extended'],
  ripple: ['ripple-carry', 'ripple adder'], shifter: ['barrel shifter', 'shifter'], cla: ['carry-lookahead', 'carry lookahead'],
  prefix: ['prefix adder', 'Kogge–Stone'], dff: ['flip-flop'], setuphold: ['setup time', 'hold time', 'setup window', 'setup margin', 'hold violation'],
  clockgating: ['clock gating', 'gated clock'], fsm: ['state machine', 'FSM'], isa: ['ISA', 'instruction set'],
  immediates: ['immediate'], callconv: ['calling convention'], mmio: ['memory-mapped I/O', 'MMIO'],
  singlecycle: ['single-cycle'], cpi: ['CPI', 'iron law'], pipeline: ['pipeline', 'pipelined'], hazards: ['hazard'],
  loaduse: ['load-use'], bpred: ['branch predictor'], csr: ['CSR', 'control and status register'],
  arraymul: ['array multiplier'], sticky: ['sticky bit'], lzc: ['leading-zero count', 'LZC'], microcode: ['microprogram'],
  multicycle: ['multicycle'], latch: ['SR latch'], dontcare: ['don’t-care', "don't-care", 'don’t care', "don't care"], depth: ['logic depth'],
  throughput: ['throughput'], warp: ['warp', 'thread number'], leader: ['leader'], divergence: ['divergent branch'],
  reconvergence: ['reconvergence'], utilization: ['utilization'],
  // Singular and short forms of plural or long titles (each one's plural is found anyway).
  pc: ['PC'], traps: ['trap'], interrupts: ['interrupt'], precise: ['precise exception'],
  subnormal: ['subnormal', 'denormal'], demorgan: ['De Morgan'],
  universality: ['functionally complete', 'universal gate'], formats: ['instruction format'], loadstore: ['load-store'],
  shiftadd: ['shift-and-add'], harvard: ['Harvard'], assembly: ['assembler', 'assembly'],
  dramtiming: ['DRAM timing'], memwall: ['memory wall'], pagepolicy: ['open page', 'closed page', 'page policy'],
  handshake: ['handshake'], coalescing: ['coalesced', 'coalesce'], privatization: ['privatization'], horner: ['Horner'],
  minsky: ['Minsky’s rule', 'Minsky\'s rule'], relaystep: ['relay step', 'pull-in', 'drop-out'], selfhold: ['self-holding'],
  buzzer: ['buzzer'], ecclesjordan: ['Eccles–Jordan'], loader: ['loader', 'boot loader'], boot: ['boot ROM'],
  coherence: ['coherence', 'coherent'], atomics: ['atomic', 'read-modify-write'], ordering: ['fence'],
  threecs: ['three Cs', 'compulsory miss', 'capacity miss', 'conflict miss'], assoc: ['set-associative', 'fully associative'],
  writepolicy: ['write-through', 'write-back cache', 'write-allocate'], skew: ['skew'], power: ['dynamic power', 'leakage power'],
  carryselect: ['carry-select'], doublebuffer: ['double buffer', 'double-buffered', 'back frame', 'front frame'],
  amdahl: ['Amdahl’s law', 'Amdahl'], vm: ['page table', 'page fault'], ecc: ['Hamming code', 'SEC-DED'],
  stdcell: ['standard-cell', 'cell library'], metastability: ['metastable'], carrysave: ['carry-save', '3:2 compressor'],
  booth: ['Booth'], zbuffer: ['z-buffer', 'depth test'], rowhammer: ['Rowhammer'],
};

/** Entries never marked automatically: their names are everyday words in the prose. */
const SKIP = new Set(['abstraction', 'feedback', 'flags', 'identities', 'rounding', 'edge', 'stack', 'bus', 'counter', 'register', 'subtract']);

/** Entries whose names mean something else before the GPU chapters: a loom's warp, a byte lane, an energy barrier. */
const GPU_ONLY = ['warp', 'lane', 'barrier'];

/** Entries not to mark in a chapter (markTerms' skip set): the GPU act's terms before chapter 26 and in the prologue (number 0). */
export function chapterSkip(c: { num: number }): Set<string> {
  return new Set(c.num < 26 ? GPU_ONLY : []);
}

/** Phrases that use a term's word for something else: found, so no shorter term claims them, and never marked. */
const NOT_TERMS = ['byte lane', 'PCIe lane', 'warp thread', 'energy barrier', 'fence off'];

export interface Term {
  id: string;
  text: string;
  /** Match the exact letters (acronyms, mixed case). */
  cs: boolean;
}

/** Every name the glossary looks for, longest first. */
export function terms(entries: readonly CodexEntry[] = CODEX): Term[] {
  const out: Term[] = [];
  for (const e of entries) {
    if (SKIP.has(e.id)) continue;
    const names = new Set<string>();
    const m = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(e.title);
    if (m) { names.add(m[1]); names.add(m[2]); } else names.add(e.title);
    for (const a of ALIASES[e.id] ?? []) names.add(a);
    for (const n of names) {
      const t = n.trim();
      if (!t) continue;
      // Mixed case beyond the first letter (CPU, PC, OR, K-map, IEEE 754, RV16) is matched as written: an acronym
      // that spells a word (OR, NOT, ROM) is never marked in lower case, while a title in words (Program counter) is.
      out.push({ id: e.id, text: t, cs: /[A-Z]/.test(t.slice(1)) });
    }
  }
  return out.sort((a, b) => b.text.length - a.text.length);
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface Match { start: number; end: number; id: string }

export class Glossary {
  private re: RegExp;
  private byText = new Map<string, Term>();

  constructor(named: Term[] = terms()) {
    const blocked = NOT_TERMS.map((text) => ({ id: '', text, cs: /[A-Z]/.test(text.slice(1)) }));
    const list = [...named, ...blocked].sort((a, b) => b.text.length - a.text.length);
    for (const t of list) {
      const k = t.cs ? t.text : t.text.toLowerCase();
      if (!this.byText.has(k)) this.byText.set(k, t);
    }
    // One alternation, longest first; a term is a whole word (plurals allowed) not glued to letters, digits or hyphens.
    this.re = new RegExp(`(?<![\\w\\-–])(${list.map((t) => esc(t.text)).join('|')})(e?s)?(?![\\w\\-–])`, 'gi');
  }

  /** Terms in a string, left to right, without overlaps. */
  find(text: string): Match[] {
    const out: Match[] = [];
    this.re.lastIndex = 0;
    for (let m = this.re.exec(text); m; m = this.re.exec(text)) {
      const w = m[1];
      const t = this.byText.get(w) ?? this.byText.get(w.toLowerCase());
      if (!t || (t.cs && t.text !== w) || !t.id) continue;
      out.push({ start: m.index, end: m.index + m[0].length, id: t.id });
    }
    return out;
  }
}
