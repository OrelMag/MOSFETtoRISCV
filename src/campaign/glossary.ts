// The glossary: codex entries recognized in running prose. Each entry is found by its title (a
// parenthetical in it becomes a second name: "Processor (CPU)") plus the aliases below; acronyms
// and other mixed-case terms match case-sensitively, lowercase prose terms in any case, plurals
// too. Words too common to mark (or, and, not as prose) are left out. The hover card shows the
// codex summary. No DOM: glossaryui.ts marks the text.

import { CODEX, type CodexEntry } from './codex';

/** Other names an entry goes by in the chapters' prose. */
const ALIASES: Record<string, string[]> = {
  cpu: ['processor'], fde: ['fetch, decode, execute'], sop: ['sum of products'], nandnand: ['NAND–NAND', 'NAND-NAND'],
  kmap: ['K-map', 'Karnaugh map'], fanin: ['fan-in', 'fan-out'], comparator: ['equality comparator'],
  hex: ['hexadecimal'], twos: ['two’s complement'], signext: ['sign extension', 'sign-extend', 'sign-extended'],
  ripple: ['ripple-carry', 'ripple adder'], shifter: ['barrel shifter'], cla: ['carry-lookahead', 'carry lookahead'],
  prefix: ['prefix adder', 'Kogge–Stone'], dff: ['flip-flop'], setuphold: ['setup time', 'hold time'],
  clockgating: ['clock gating', 'gated clock'], fsm: ['state machine', 'FSM'], isa: ['ISA', 'instruction set'],
  immediates: ['immediate'], callconv: ['calling convention'], mmio: ['memory-mapped I/O', 'MMIO'],
  singlecycle: ['single-cycle'], cpi: ['CPI', 'iron law'], pipeline: ['pipeline', 'pipelined'], hazards: ['hazard'],
  loaduse: ['load-use'], bpred: ['branch predictor'], csr: ['CSR', 'control and status register'],
  arraymul: ['array multiplier'], sticky: ['sticky bit'], lzc: ['leading-zero count'], microcode: ['microprogram'],
  multicycle: ['multicycle'], latch: ['SR latch'], dontcare: ['don’t-care'], depth: ['logic depth'],
};

/** Entries never marked automatically: their names are everyday words in the prose. */
const SKIP = new Set(['abstraction', 'feedback', 'flags', 'identities', 'rounding', 'edge', 'stack', 'bus', 'counter', 'register', 'precise', 'subtract']);

/** Names that would match ordinary words: only their capitalized acronym form is marked. */
const ACRONYM_ONLY = new Set(['not', 'and', 'or', 'xor', 'nor', 'nand', 'alu', 'ram', 'rom', 'pc']);

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
      const acronym = ACRONYM_ONLY.has(e.id);
      // Mixed case beyond the first letter (CPU, K-map, IEEE 754, RV16) is matched as written.
      const cs = acronym || /[A-Z]/.test(t.slice(1));
      out.push({ id: e.id, text: acronym ? t.toUpperCase() : t, cs });
    }
  }
  return out.sort((a, b) => b.text.length - a.text.length);
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface Match { start: number; end: number; id: string }

export class Glossary {
  private re: RegExp;
  private byText = new Map<string, Term>();

  constructor(list: Term[] = terms()) {
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
      if (!t || (t.cs && t.text !== w)) continue;
      out.push({ start: m.index, end: m.index + m[0].length, id: t.id });
    }
    return out;
  }
}
