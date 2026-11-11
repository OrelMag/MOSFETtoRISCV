// A chip's switched-on faults wherever it is simulated (DOM-free). The fault brush saves faults on the chip's document
// (ChipDoc.faults, never compiled into it), and the open tab's simulation applies them (runtime.ts withFaults). Here they
// also reach Check, the Tests pane and every chip that places a faulted one: each user chip in a flattened hierarchy is
// found by its node (its def is the library's current compile of that chip, so its nets are the ones the faults name)
// and its faults are resolved on that node, at any depth. Gate level only, as on the canvas.

import type { FlatFault } from '../sim/faults';
import { plantedDef } from '../sim/faults';
import type { HierNode } from '../sim/flatten';
import type { ComponentDef } from '../sim/types';
import type { Compiled } from './compile';
import type { UserLibrary } from './library';
import type { ChipDoc, FaultDoc, Workspace } from './model';
import { resolveProbeAt } from './probes';

/** Where a chip's document and its current compile are found (the editor's workspace and library). */
export interface ChipLookup {
  doc(id: string): ChipDoc | undefined;
  compiled(id: string): Compiled | undefined;
}

/** The editor's workspace and library as a lookup. */
export const lookOf = (ws: Workspace, lib: UserLibrary): ChipLookup => ({ doc: (id) => ws.chips[id], compiled: (id) => lib.compiled(id) });

/** The faults switched on in a chip's document. */
export const faultsOn = (doc: ChipDoc | undefined): FaultDoc[] => doc?.faults?.filter((f) => !f.off) ?? [];

/** One fault document on a node of its chip, as flat nets (null: its target no longer resolves there). */
export function faultAt(f: FaultDoc, doc: ChipDoc, built: Compiled, node: HierNode): FlatFault | null {
  const r = resolveProbeAt(f.target, doc, built, node);
  if (!r || !r.nets.length) return null;
  const nets = f.bit === undefined ? r.nets : r.nets[f.bit] === undefined ? [] : [r.nets[f.bit]];
  return nets.length ? { kind: f.kind, nets, delay: f.delay } : null;
}

/**
 * Every switched-on fault of the user chips at and below `node` (`self`: the node's own chip too), resolved on its
 * copy. A node whose def is not the chip's current compile (an older build) is passed over: its nets may not be the
 * ones its faults name.
 */
export function chipFaults(node: HierNode, look: ChipLookup, self = true): FlatFault[] {
  const out: FlatFault[] = [];
  const visit = (n: HierNode, own: boolean) => {
    if (own && n.def.category === 'custom') {
      const doc = look.doc(n.def.id), built = look.compiled(n.def.id);
      if (doc && built && built.def === n.def && built.mode === 'gate') {
        for (const f of faultsOn(doc)) {
          const ff = faultAt(f, doc, built, n);
          if (ff) out.push(ff);
        }
      }
    }
    // a user chip sits only inside the root or another user chip: library parts' insides (a CPU core's, a RAM's) are not walked
    if (n === node || n.def.category === 'custom') n.children?.forEach((c) => visit(c, true));
  };
  visit(node, self);
  return out;
}

/** A text of the faults on in a chip and every chip it places (`deps`): what a simulation built with them is keyed on. */
export function faultsKeyOf(id: string, deps: readonly string[], look: ChipLookup, self = true): string {
  const parts: string[] = [];
  for (const d of self ? [id, ...deps] : deps) {
    const on = faultsOn(look.doc(d));
    if (on.length) parts.push(`${d}:${JSON.stringify(on)}`);
  }
  return parts.join('|');
}

/**
 * The chips (this one, `self`, and every chip it places) with faults switched on, by name. Check, the Tests pane and the
 * puzzles run with them, as the canvas does; but a pass with a fault on is the drawing plus the fault (a stuck-at can stand in
 * for gates at no cost), so a challenge, level or puzzle does not count it (faultsNote).
 */
export function faultyChips(id: string, deps: readonly string[], look: ChipLookup, self = true): string[] {
  return (self ? [id, ...deps] : deps).filter((d) => faultsOn(look.doc(d)).length).map((d) => look.doc(d)?.name ?? d);
}

/** What a check with faults on says: why a pass does not count, or that a failure may be theirs. */
export function faultsNote(names: string[], passed: boolean): string {
  const where = names.length === 1 ? `“${names[0]}”` : `${names.slice(0, -1).map((n) => `“${n}”`).join(', ')} and “${names.at(-1)}”`;
  return passed
    ? `It passes only with faults switched on in ${where}: switch them off (the chip's properties, Faults) for it to count`
    : `Checked with faults switched on in ${where}: they may be what fails`;
}

/**
 * The chip with its faults and its placed chips' planted where it is flattened (Check, the Tests pane): the same def
 * otherwise, the planted faults it may carry already (a break-it level's) kept. Itself when there are none.
 */
export function withChipFaults(def: ComponentDef, chip: string, look: ChipLookup, deps: readonly string[]): ComponentDef {
  const prev = def.planted, doc = look.doc(chip), built = look.compiled(chip);
  // gate level only, as on the canvas (a faulted chip placed beside a transistor is simulated at switch level there)
  if (built?.mode !== 'gate' || !faultsKeyOf(chip, deps, look)) return def;
  // the root is this new def, not the library's compile: its own faults by the chip's id (the same netlist, the same nets)
  const own = (n: HierNode): FlatFault[] => (doc && built && built.mode === 'gate'
    ? faultsOn(doc).flatMap((f) => { const ff = faultAt(f, doc, built, n); return ff ? [ff] : []; }) : []);
  return plantedDef(def, (n) => [...(prev?.(n) ?? []), ...own(n), ...chipFaults(n, look, false)], 'faults');
}
