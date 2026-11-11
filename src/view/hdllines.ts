// The HDL tab's links between generated source and the drawing (DOM-free): which lines each instance owns, and the line a
// selected part scrolls to. The generators (sim/verilog.ts verilogLines, sim/vhdl.ts vhdlLines) name a line's instance.

import type { HdlLines } from '../sim/verilog';

/** Every instance's lines, in order (an instance's port map can span several). */
export function linesByInstance(src: HdlLines): Map<string, number[]> {
  const m = new Map<string, number[]>();
  src.owners.forEach((o, i) => {
    if (o === null) return;
    const a = m.get(o);
    if (a) a.push(i);
    else m.set(o, [i]);
  });
  return m;
}

/** The instance a click on line `i` lights (null: a port, a declaration, the frame). */
export function instanceAt(src: HdlLines, i: number): string | null {
  return src.owners[i] ?? null;
}

/** The first line of `inst` (where a selected part scrolls to; null: it wrote nothing, e.g. a splitter with no runs). */
export function firstLineOf(src: HdlLines, inst: string): number | null {
  const i = src.owners.indexOf(inst);
  return i < 0 ? null : i;
}
