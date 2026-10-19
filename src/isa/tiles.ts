// The program as tiles (DOM-free): each source line as the program editor's Tiles view draws it,
// from the ISA's builder adapter, so it works for every ROM language with instructions. A line's
// words, the registers it reads and writes (a register slot marked dest is written), where its
// branch or jump goes (the line holding the target address), and for each register it reads the
// nearest line above that wrote it (straight-line order: what the text says, not every path).

import type { ComposeIsa } from './composekit';
import { commentStart } from '../riscv/asm';

export interface TileReg { name: string; num: number; bank: string }

export interface Tile {
  /** 1-based source line. */
  line: number;
  labels: string[];
  code: string;
  comment: string;
  kind: 'instr' | 'pseudo' | 'data' | 'label' | 'comment' | 'blank' | 'error';
  words: { addr: number; word: number }[];
  /** The instruction's name and operand texts (instr). */
  name?: string;
  reads: TileReg[];
  writes: TileReg[];
  /** Index (into tiles) of the line a branch / jump goes to; -1: outside the program. */
  target?: number;
  /** Per read register: index of the nearest line above that wrote it. */
  from: { reg: TileReg; tile: number }[];
  error?: string;
}

const LABEL = /^\s*([A-Za-z_.$][\w.$]*)\s*:/;

/** Registers a decoded word reads and writes (x0 / zero never counts as written or read). */
function regsOf(isa: ComposeIsa, word: number): { name?: string; reads: TileReg[]; writes: TileReg[]; target?: number } {
  const d = isa.decode(word) ?? isa.loose(word);
  if (!d) return { reads: [], writes: [] };
  const ins = isa.instr(d.id)!;
  const reads: TileReg[] = [], writes: TileReg[] = [];
  let target: number | undefined;
  for (const s of ins.slots) {
    if (s.kind === 'reg') {
      const num = d.parts[s.key];
      const name = s.names?.[num] ?? String(num);
      const bank = s.names?.[0] ?? '';
      // A register file whose first entry is wired to 0 (RV32 x0, RV16 zero): never a dependency.
      if (num === 0 && (name === 'zero' || name === 'x0')) continue;
      (s.dest ? writes : reads).push({ name, num, bank });
    } else if (s.role === 'target') target = d.parts[s.key];
  }
  return { name: ins.name, reads, writes, target };
}

export function programTiles(isa: ComposeIsa, src: string): Tile[] {
  const lines = src.split(/\r?\n/);
  const info = isa.program(src);
  const byLine = new Map<number, { addr: number; word: number }[]>();
  for (const l of info.lines) byLine.set(l.srcLine, [...(byLine.get(l.srcLine) ?? []), { addr: l.addr, word: l.word }]);
  const errors = new Map(info.errors.map((e) => [e.line, e.message]));
  const tiles: Tile[] = lines.map((raw, i) => {
    const n = i + 1;
    const at = commentStart(raw);
    let body = raw.slice(0, at);
    const comment = raw.slice(at).trim();
    const labels: string[] = [];
    for (let m = body.match(LABEL); m; m = body.match(LABEL)) {
      labels.push(m[1]);
      body = body.slice(m[0].length);
    }
    const code = body.trim();
    const words = byLine.get(n) ?? [];
    const t: Tile = { line: n, labels, code, comment, kind: 'blank', words, reads: [], writes: [], from: [] };
    if (errors.has(n)) return { ...t, kind: 'error', error: errors.get(n) };
    if (!code) return { ...t, kind: labels.length ? 'label' : comment ? 'comment' : 'blank' };
    if (/^\./.test(code)) return { ...t, kind: 'data' };
    if (words.length !== 1) return { ...t, kind: words.length ? 'pseudo' : 'data' };
    const r = regsOf(isa, words[0].word);
    return { ...t, kind: 'instr', name: r.name, reads: r.reads, writes: r.writes, ...(r.target !== undefined ? { target: words[0].addr + r.target } : {}) };
  });
  // Targets: an address → the tile whose first word sits there.
  const atAddr = new Map<number, number>();
  tiles.forEach((t, i) => { if (t.words.length && !atAddr.has(t.words[0].addr)) atAddr.set(t.words[0].addr, i); });
  for (const t of tiles) if (t.target !== undefined) t.target = atAddr.get(t.target) ?? -1;
  // Producers: the nearest line above that wrote each register read.
  const last = new Map<string, number>();
  tiles.forEach((t, i) => {
    t.from = t.reads.flatMap((reg) => {
      const k = `${reg.bank}:${reg.num}`;
      return last.has(k) ? [{ reg, tile: last.get(k)! }] : [];
    });
    for (const w of t.writes) last.set(`${w.bank}:${w.num}`, i);
  });
  return tiles;
}

/** The source with line `from` moved to sit before line `before` (1-based; before = lines + 1: the end). */
export function moveLine(src: string, from: number, before: number): string {
  const lines = src.split('\n');
  if (from < 1 || from > lines.length || before === from || before === from + 1) return src;
  const [l] = lines.splice(from - 1, 1);
  lines.splice(before > from ? before - 2 : before - 1, 0, l);
  return lines.join('\n');
}
