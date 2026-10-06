// Static timing of a sandbox chip, mapped back onto the drawing (DOM-free). analyzeTiming works
// on the flat circuit; the editor needs to know which of the user's parts, wires and pins the
// critical path crosses. Parts: the top-level instance of every leaf on the path (its first
// hierarchy name is the part id), plus the launching and capturing flip-flops. Wires: the flat
// nets on the path that are nets of the chip itself (HierNode.nets of the root), through
// Compiled.netOfWire.

import type { FlatDesign } from '../sim/flatten';
import { logicDepth } from '../sim/stats';
import { analyzeTiming, PS_PER_NAND, type TimingReport } from '../sim/timing';
import type { Compiled } from './compile';
import type { ChipDoc } from './model';

export interface CriticalPath {
  parts: string[];
  wires: string[];
  pins: string[];
}

export type ChipTiming =
  | { ok: true; report: TimingReport; mhz: number; path: CriticalPath }
  | { ok: false; why: string; depth?: number };

const reports = new WeakMap<FlatDesign, TimingReport | null>();

/** analyzeTiming, once per flattened design. */
export function timingOf(design: FlatDesign): TimingReport | null {
  let r = reports.get(design);
  if (r === undefined) reports.set(design, (r = analyzeTiming(design)));
  return r;
}

/**
 * Timing of a compiled chip. `design` is its gate-level flattening (the editor's simulation
 * already has one). Explains when there is nothing to time.
 */
export function chipTiming(doc: ChipDoc, built: Compiled, design: FlatDesign | null): ChipTiming {
  if (built.mode === 'switch') {
    return { ok: false, why: 'Switch level: transistors are solved as switches, without delays. Static timing needs a gate-level chip (its transistor chips used through their derived models).' };
  }
  if (!design) return { ok: false, why: 'Not simulated yet (see the diagnostics).' };
  const report = timingOf(design);
  if (!report) {
    const depth = logicDepth(built.def);
    if (depth !== null) {
      return { ok: false, depth, why: `No flip-flops: combinational. The longest input → output path is ${depth} NAND delay${depth === 1 ? '' : 's'}.` };
    }
    return { ok: false, why: 'Feedback but no flip-flops (latches, or loops of gates): no clock edge to time from. A chip of your own counts as a flip-flop only once it is marked as one.' };
  }
  return { ok: true, report, mhz: 1e6 / (report.period * PS_PER_NAND), path: criticalPath(report, doc, built, design) };
}

/** The chip's parts, wires and pins on a critical path. */
export function criticalPath(r: TimingReport, doc: ChipDoc, built: Compiled, design: FlatDesign): CriticalPath {
  const ids = new Set(doc.parts.map((p) => p.id));
  const parts = new Set<string>();
  const add = (path: string[]) => { if (path.length && ids.has(path[0])) parts.add(path[0]); };
  add(r.launch);
  for (const p of r.path) add(p.node);
  add(r.capture);

  // Flat net → index of the chip's net carrying it.
  const top = new Map<number, number>();
  design.root.nets?.forEach((flat, i) => flat.forEach((n) => top.set(n, i)));
  const nets = new Set<number>();
  for (const n of r.nets) {
    const i = top.get(n);
    if (i !== undefined) nets.add(i);
  }
  const wires = doc.wires.filter((w) => nets.has(built.netOfWire.get(w.id) ?? -1)).map((w) => w.id);
  const pins = doc.pins.filter((p) => nets.has(built.netOfEnd.get(`pin:${p.id}`) ?? -1)).map((p) => p.id);
  return { parts: [...parts], wires, pins };
}
