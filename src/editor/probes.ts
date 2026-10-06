// What the sandbox's timing panel records, DOM-free. A lane follows something the user drew, not
// a net number: the simulator is rebuilt (and its nets renumbered) on every connectivity edit,
// so a probe names its wires (all the wires of its net when it was placed, the clicked one
// first), a pin, or a pointer name, and is resolved again against each new build. A probe whose
// wires are all gone, or whose net was dropped, disappears with them.

import type { FlatDesign } from '../sim/flatten';
import { netlistOf } from '../sim/types';
import type { Compiled } from './compile';
import type { ChipDoc } from './model';

export type ProbeTarget =
  | { wires: string[] }
  | { pin: string }
  | { pointer: string };

export interface ResolvedProbe {
  /** Flat nets in the simulation, LSB first. */
  nets: number[];
  /** Short name for the lane: the net's name, else a chip pin on it, else its driver. */
  label: string;
  /** The target with its wire list brought up to date (the wires of the net now). */
  target: ProbeTarget;
  /** Index of the net in the chip's netlist (-1 for a pin lane). */
  net: number;
}

/** Index of the chip-level net a target is on, or -1. */
export function netOfTarget(t: ProbeTarget, doc: ChipDoc, built: Compiled): number {
  if ('wires' in t) {
    for (const id of t.wires) {
      const n = built.netOfWire.get(id);
      if (n !== undefined && n >= 0) return n;
    }
    return -1;
  }
  if ('pointer' in t) {
    for (const l of doc.labels) {
      if (l.name !== t.pointer) continue;
      const n = built.netOfLabel.get(l.id);
      if (n !== undefined && n >= 0) return n;
    }
    return -1;
  }
  return built.netOfEnd.get(`pin:${t.pin}`) ?? -1;
}

/**
 * Resolve a lane's target in a simulation built from `built` (its design, as flattened from
 * built.def). Null when the target no longer exists or is not on a working net.
 */
export function resolveProbe(t: ProbeTarget, doc: ChipDoc, built: Compiled, design: FlatDesign): ResolvedProbe | null {
  if ('pin' in t) {
    const pin = doc.pins.find((p) => p.id === t.pin);
    const nets = pin && design.root.ports[pin.name];
    return pin && nets ? { nets: [...nets], label: pin.name, target: t, net: -1 } : null;
  }
  const net = netOfTarget(t, doc, built);
  const flat = net >= 0 ? design.root.nets?.[net] : undefined;
  if (!flat) return null;
  const nd = netlistOf(built.def)?.nets[net];
  // Its name, else the chip pin on it, else its driver (as the schematic's probes name nets).
  const label = 'pointer' in t ? t.pointer : nd?.name ?? nd?.ends.find((e) => !e.includes('.')) ?? nd?.ends[0] ?? `net${net}`;
  if ('pointer' in t) return { nets: [...flat], label, target: t, net };
  // Every wire of the net now, the ones named before first (so the clicked wire stays the anchor).
  const now = doc.wires.filter((w) => built.netOfWire.get(w.id) === net).map((w) => w.id);
  const wires = [...t.wires.filter((id) => now.includes(id)), ...now.filter((id) => !t.wires.includes(id))];
  return { nets: [...flat], label, target: { wires }, net };
}

/** Same lane? (A click on a probed wire removes its probe instead of adding a second one.) */
export function sameTarget(a: ProbeTarget, b: ProbeTarget, doc: ChipDoc, built: Compiled): boolean {
  if ('pin' in a || 'pin' in b) return 'pin' in a && 'pin' in b && a.pin === b.pin;
  const na = netOfTarget(a, doc, built);
  return na >= 0 && na === netOfTarget(b, doc, built);
}
