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
