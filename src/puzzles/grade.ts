// Grading a puzzle solution against the reference points. A NAND count has no single par (it depends on the
// CPU chosen), so the grade is a trade-off: ★ every test passes; ★★ no reference is both at least as cheap
// and at least as fast (you beat each one on NANDs or on cycles); ★★★ cycles × NANDs below every reference's.
// Cycles and program size also get a par where a reference speaks the same ISA. And the best score kept per
// puzzle, in its own storage key (an injected key-value store, like the campaign's progress). No DOM.

import type { RefCpu } from './computers';
import type { RefPoint } from './refs';

export interface PuzzleScore {
  /** Mean cycles over the tests. */
  cycles: number;
  /** NANDs of the hardware (program ROMs left out). */
  nands: number;
  /** Words of the program (null: no ROM found). */
  words: number | null;
}

export type Stars = 1 | 2 | 3;

/** References that are at least as cheap and at least as fast as the score (the ones it does not beat). */
export const dominatedBy = (s: PuzzleScore, refs: RefPoint[]): RefPoint[] => refs.filter((r) => r.nands <= s.nands && r.cycles <= s.cycles);

export function puzzleStars(s: PuzzleScore, refs: RefPoint[]): Stars {
  if (!refs.length) return 3;
  if (dominatedBy(s, refs).length) return 1;
  return refs.every((r) => s.cycles * s.nands < r.cycles * r.nands) ? 3 : 2;
}

/** Is `src` the reference program as loaded (Do it for me), give or take line ends and trailing blanks? Such a pass earns no stars. */
export function isReferenceProgram(src: string, ref: string | undefined): boolean {
  const norm = (t: string) => t.split(/\r?\n/).map((l) => l.trimEnd()).join('\n').trim();
  return ref !== undefined && norm(src) === norm(ref);
}

/** The references on the front: no other reference both cheaper and faster (the dashed line of the chart). */
export function refFront(refs: RefPoint[]): RefPoint[] {
  return refs.filter((r) => !refs.some((q) => q !== r && q.nands <= r.nands && q.cycles <= r.cycles && (q.nands < r.nands || q.cycles < r.cycles)))
    .sort((a, b) => a.nands - b.nands);
}

/** The par for cycles and words when a reference runs the same ISA (null otherwise). */
export function parFor(lang: string | null, refs: RefPoint[]): RefPoint | null {
  const cpu: RefCpu | null = lang === 'cpu4' ? 'cpu4' : lang === 'rv16' ? 'rv16' : lang === 'asm' ? 'rv32' : null;
  return refs.find((r) => r.cpu === cpu) ?? null;
}

// ---- progress -------------------------------------------------------------------------------------

export const PUZZLES_KEY = 'mosfet2riscv:sandbox:puzzles';

export interface KV { getItem(k: string): string | null; setItem(k: string, v: string): void }

export interface PuzzleRecord {
  /** Best stars, and the score that earned them (first best by stars, then cycles × NANDs). */
  stars: Stars;
  best: PuzzleScore;
  /** Solved by loading the reference (Do it for me): no stars from that. */
  shown?: boolean;
}

/** Whether `neu` should replace `old`: nothing before, a reference that was only loaded (Do it for me), more stars, or equal stars and a lower cycles × NANDs. */
export function betterRecord(neu: PuzzleRecord, old: PuzzleRecord | undefined): boolean {
  if (!old) return true;
  if (neu.shown) return false;
  return old.shown === true || neu.stars > old.stars || (neu.stars === old.stars && neu.best.cycles * neu.best.nands < old.best.cycles * old.best.nands);
}

export class PuzzleProgress {
  private data: Record<string, PuzzleRecord> = {};

  constructor(private kv: KV | null) {
    try {
      const raw = kv?.getItem(PUZZLES_KEY);
      const d = raw ? JSON.parse(raw) : null;
      if (d && typeof d === 'object') this.data = d as Record<string, PuzzleRecord>;
    } catch { /* corrupt: start over */ }
  }

  get(id: string): PuzzleRecord | undefined {
    return this.data[id];
  }

  solved(id: string): boolean {
    return !!this.data[id];
  }

  /** Record a pass. Returns whether it is the best yet (and whether it is the first). */
  record(id: string, score: PuzzleScore, stars: Stars): { best: boolean; first: boolean } {
    const old = this.data[id];
    const better = betterRecord({ stars, best: score }, old);
    if (better) this.data[id] = { stars, best: score };
    this.save();
    return { best: better, first: !old };
  }

  /** The reference was loaded (Do it for me): solved, without stars of its own. */
  shown(id: string): void {
    if (this.data[id]) return;
    this.data[id] = { stars: 1, best: { cycles: 0, nands: 0, words: null }, shown: true };
    this.save();
  }

  private save(): void {
    try { this.kv?.setItem(PUZZLES_KEY, JSON.stringify(this.data)); } catch { /* storage full: progress stays in memory */ }
  }
}
