// A wide Builder drawing folded into bands: the columns are cut where the drawing is half as wide, and the right half is
// moved under the left, so a long pipeline or core reads at fit in two rows instead of one strip. Layout only: instances,
// nets and their order are kept, so simulation, statistics and Verilog are untouched. A net with ends in both bands is
// drawn as pointers at the ends away from its driver's band (a long run back across the drawing would cross everything).

import { symbolGeom } from '../sim/geometry';
import type { NetDef, Netlist } from '../sim/types';

export interface FoldOptions {
  /** Rows between the bands (default 16). */
  gap?: number;
  /** Fold only when the drawing is wider than this many grid units (default 160). */
  minWidth?: number;
}

const instOf = (end: string): string | null => (end.includes('.') ? end.slice(0, end.indexOf('.')) : null);

export function foldBands(nl: Netlist, opts: FoldOptions = {}): Netlist {
  const pins = nl.pins ?? {};
  const xs = nl.instances.map((i) => i.at![0]);
  const right = Math.max(...xs.map((x, k) => x + symbolGeom(nl.instances[k].def).w), ...Object.values(pins).map(([x]) => x));
  if (right < (opts.minWidth ?? 160)) return nl;
  // the cut: the first column at or past half the width (every instance of a column moves together)
  const cols = [...new Set(xs)].sort((a, b) => a - b);
  const cut = cols.find((x) => x >= right / 2) ?? cols[cols.length - 1];
  const x0 = Math.min(...cols);
  const top = nl.instances.filter((i) => i.at![0] < cut);
  const h1 = Math.max(0, ...top.map((i) => i.at![1] + symbolGeom(i.def).h), ...Object.entries(pins).filter(([, [x]]) => x < cut).map(([, [, y]]) => y));
  const dy = h1 + (opts.gap ?? 16), dx = cut - x0;
  const band = new Map<string, number>();
  const instances = nl.instances.map((i) => {
    const lower = i.at![0] >= cut;
    band.set(i.name, lower ? 1 : 0);
    return lower ? { ...i, at: [i.at![0] - dx, i.at![1] + dy] as [number, number] } : i;
  });
  // input pins stay at the top left; output pins follow the lower band's right edge
  const newRight = Math.max(cut - x0, right - dx);
  const outY = (y: number) => y + dy;
  const pinBand = new Map<string, number>();
  const newPins: Record<string, [number, number]> = {};
  for (const [n, [x, y]] of Object.entries(pins)) {
    if (x > x0) { newPins[n] = [newRight, outY(y)]; pinBand.set(n, 1); } else { newPins[n] = [x, y]; pinBand.set(n, 0); }
  }
  const bandOf = (end: string) => { const i = instOf(end); return i ? band.get(i)! : pinBand.get(end) ?? 0; };
  const nets: NetDef[] = nl.nets.map((n) => {
    const bd = bandOf(n.ends[0]);
    const away = n.ends.slice(1).filter((e) => bandOf(e) !== bd);
    if (!away.length || n.tags === true) return n;
    const had = Array.isArray(n.tags) ? n.tags : [];
    const tags = [...new Set([...had, ...away])];
    // a net's every sink in the other band: tag the driver too, a pointer pair
    const { via: _v, trunk: _t, ...rest } = n;
    return tags.length >= n.ends.length - 1 ? { ...rest, tags: true } : { ...rest, tags };
  });
  return { ...nl, pins: newPins, instances, nets };
}
