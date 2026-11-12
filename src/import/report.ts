// What an importer of another tool's circuit files (Digital .dig, Logisim-evolution .circ) hands the sandbox: the
// chips it drew and a report of what each kind of part became, shown before anything is written (import/importui.ts).
// DOM-free: the importers and this are tested in Node.

import type { ChipDoc } from '../editor/model';

/** A file as read from the picker or a drop. */
export interface SourceFile {
  name: string;
  text: string;
}

export interface ImportOptions {
  /** Chip ids already in the workspace: new chips get ids none of these use. */
  taken: ReadonlySet<string>;
}

/** One kind of part in the file and what it became, for the dialog's table. */
export interface PartMapping {
  /** The other tool's element name ('And', 'D_FF', 'Tunnel'; Logisim's 'AND Gate'). */
  from: string;
  count: number;
  /** What it became, in a few words ('NAND-built gates', 'pointers', 'empty chip, same pins'). */
  becomes: string;
  /** ok: an equivalent; dropped: left out (a probe, a decoration); stub: an empty chip with its pins. */
  status: 'ok' | 'dropped' | 'stub';
}

export interface ImportResult {
  format: 'digital' | 'logisim';
  /** Placed chips before the chips that place them: the top last. Ids fresh against `taken`. */
  chips: ChipDoc[];
  /** Id of the top chip (Digital: the file opened; Logisim: the main circuit). */
  top: string;
  mapping: PartMapping[];
  /** Things the learner should know, each naming where ("alu ▸ External fpmul: an empty chip with its 3 pins"). */
  problems: string[];
}

/** A file this importer cannot read at all (not XML, not its format, no circuit). */
export interface ImportFailure {
  error: string;
}

/** Gathers PartMappings by element name while a file is converted. */
export class MappingTally {
  private m = new Map<string, PartMapping>();
  add(from: string, becomes: string, status: PartMapping['status'] = 'ok'): void {
    const k = `${from}\u0000${becomes}`;
    const e = this.m.get(k);
    if (e) e.count++;
    else this.m.set(k, { from, count: 1, becomes, status });
  }
  /** ok first, then stubs, then dropped; within each the most frequent first. */
  list(): PartMapping[] {
    const rank = { ok: 0, stub: 1, dropped: 2 };
    return [...this.m.values()].sort((a, b) => rank[a.status] - rank[b.status] || b.count - a.count || a.from.localeCompare(b.from));
  }
}

/**
 * The first pin wider than the sandbox takes (editor/store.ts MAX_PIN_BITS), as the file's error: such a pin cannot be
 * simulated or drawn, and passed on it would be stored and opened at once. Digital stops at 64 bits, Logisim at 32.
 */
export function tooWide(chips: ChipDoc[], max: number): ImportFailure | null {
  for (const c of chips) for (const p of c.pins) if (p.width > max) return { error: `${c.name} ▸ pin ${p.name} is ${p.width} bits wide; the sandbox takes up to ${max}` };
  return null;
}

/**
 * The first numeric attribute (a width, a count of inputs, select bits) past `max`, as the file's error. Read before
 * anything is built: a part 2e9 bits wide runs the import itself out of memory. Real files stay far below (Digital 64
 * bits, Logisim 32).
 */
export function tooLarge(attrs: Iterable<{ where: string; key: string; value: number }>, max: number): ImportFailure | null {
  for (const a of attrs) if (a.value > max) return { error: `${a.where}: ${a.key} is ${a.value}; the sandbox takes up to ${max}` };
  return null;
}
