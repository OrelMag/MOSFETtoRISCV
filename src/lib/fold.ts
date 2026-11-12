// A wide Builder drawing folded into bands: the columns are cut where the drawing is half as wide, and the right half is
// moved under the left, so a long pipeline or core reads at fit in two rows instead of one strip. Layout only: instances,
// nets and their order are kept, so simulation, statistics and Verilog are untouched. A net with ends in both bands is
// drawn as pointers at the ends away from its driver's band (a long run back across the drawing would cross everything).

import { symbolGeom } from '../sim/geometry';
import type { NetDef, Netlist, PortDef } from '../sim/types';
import type { Builder } from './builder';
import { layered, type LayeredOptions } from './layered';

export interface FoldOptions {
  /** Rows between the bands (default 16). */
  gap?: number;
  /** Cut at this column x instead of choosing (tests compare rules). */
  cut?: number;
  /** Fold only when the drawing is wider than this many grid units (default 160). */
  minWidth?: number;
}

/** Each fold made: the first-past-half column, the cut taken, and the nets each one cuts (the pointer pairs it creates). */
export const FOLD_LOG: { first: number; cut: number; crossFirst: number; crossCut: number }[] = [];

const instOf = (end: string): string | null => (end.includes('.') ? end.slice(0, end.indexOf('.')) : null);

export function foldBands(nl: Netlist, opts: FoldOptions = {}): Netlist {
  const pins = nl.pins ?? {};
  const xs = nl.instances.map((i) => i.at![0]);
  const right = Math.max(...xs.map((x, k) => x + symbolGeom(nl.instances[k].def).w), ...Object.values(pins).map(([x]) => x));
  if (right < (opts.minWidth ?? 160)) return nl;
  const plan = foldCut(nl), cols = plan.cols;
  const cut = opts.cut ?? plan.cut;
  FOLD_LOG.push({ first: plan.first, cut, crossFirst: plan.crossing(plan.first), crossCut: plan.crossing(cut) });
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

/** Where foldBands cuts: among the columns within 15 % of half the width, the one the fewest nets cross (each crossing net
 *  becomes a pointer pair), else the first column past half; with what each rule would cost, for the tests and the report. */
export function foldCut(nl: Netlist): { cut: number; first: number; cols: number[]; crossing: (c: number) => number } {
  const pins = nl.pins ?? {};
  const xs = nl.instances.map((i) => i.at![0]);
  const right = Math.max(...xs.map((x, k) => x + symbolGeom(nl.instances[k].def).w), ...Object.values(pins).map(([x]) => x));
  const cols = [...new Set(xs)].sort((a, b) => a - b);
  const at = new Map(nl.instances.map((i) => [i.name, i.at![0]]));
  const xOf = (end: string) => { const i = instOf(end); return i ? at.get(i)! : (pins[end]?.[0] ?? 0); };
  const crossing = (c: number) => nl.nets.filter((n) => n.ends.some((e) => xOf(e) < c) && n.ends.some((e) => xOf(e) >= c)).length;
  const first = cols.find((x) => x >= right / 2) ?? cols[cols.length - 1];
  const window = cols.filter((x) => x > cols[0] && Math.abs(x - right / 2) <= 0.15 * right);
  const cut = window.length ? window.reduce((best, x) => (crossing(x) < crossing(best) ? x : best)) : first;
  return { cut, first, cols, crossing };
}


/**
 * A core's drawing: laid out by logic depth (lib/layered.ts, `lay` its options: `aspect` folds it into bands at its seams, each
 * net across a seam a label pair) where that measured better than foldBands' two halves (PC-3 of the eyes pass: fewer pointers and
 * crossings, no more wires through parts), else foldBands as before. `pins` are foldBands' own (layered places its pins).
 */
export function coreNetlist(ports: PortDef[], b: Builder, pins: Record<string, [number, number]>, lay?: LayeredOptions): Netlist {
  // pins in the order foldBands drew them (by side, top to bottom): a campaign reference is drawn as a chip whose face keeps that order
  return lay ? layered(ports, b, { pinOrder: Object.keys(pins).sort((a, c) => pins[a][0] - pins[c][0] || pins[a][1] - pins[c][1]), ...lay }) : foldBands({ pins, instances: b.instances, nets: b.nets() });
}

/** The options the long cores measured best with (two to four bands, room for their labels). */
export const CORE_LAY: LayeredOptions = { aspect: 1.6, room: true, gap: 10, vgap: 4, pinPitch: 4 };

/** Nets forced to wires (`on`: a label pair there would collide) or to labels (a wire would run through a part): the outputs of the
 *  instances with these labels, and these pins. */
export function labelledWires(b: Builder, labels: string[], pins: string[] = [], on = true): Record<string, boolean> {
  const ends = b.instances.filter((i) => labels.includes(i.label ?? '')).map((i) => `${i.name}.${i.def.ports.find((p) => p.dir === 'out')!.name}`);
  return Object.fromEntries([...ends, ...pins].map((e) => [e, on]));
}
