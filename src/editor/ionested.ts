// The controls inside the chips a chip places, for the I/O bar (iobar.ts), DOM-free: switch banks
// and key parts below the top level, headed by their instance path ('dev › sw'). The open chip's
// own switch banks and keys are on its canvas; these are the ones a closed-up computer hides.
// Flipping a switch pokes the bank's leaf (as a click on its face in look inside); a key is held
// through EditorSim.setKey, so the keyboard and the bar agree on what is down.

import type { HierNode } from '../sim/flatten';
import type { Sim } from '../sim/sim';
import { flipSwitch, ioNodes, type SwitchState } from './ioparts';
import { keyBindOf, keyLabel } from './parts';

export type NestedControl =
  | { kind: 'switches'; path: string[]; node: HierNode; width: number }
  | { kind: 'key'; path: string[]; bind: string; label: string };

/** Banks shown before the rest fold behind "+n more". */
export const IOBAR_BANKS = 3;

const found = new WeakMap<Sim, NestedControl[]>();

/** Nested switch banks (in hierarchy order), then nested keys (one per key they listen to); found once per simulation. */
export function nestedControls(sim: Sim | null): NestedControl[] {
  if (!sim) return [];
  const known = found.get(sim);
  if (known) return known;
  const out: NestedControl[] = [];
  found.set(sim, out);
  for (const n of ioNodes(sim.design.root)) {
    if (n.info.kind === 'switches' && n.path.length > 1 && n.node.leafIndex !== undefined) out.push({ kind: 'switches', path: n.path, node: n.node, width: n.info.width });
  }
  const binds = new Set<string>();
  for (const l of sim.design.leaves) {
    const bind = keyBindOf(l.def);
    if (bind === null || l.node.path.length < 2 || binds.has(bind)) continue;
    binds.add(bind);
    out.push({ kind: 'key', path: l.node.path, bind, label: keyLabel(bind) });
  }
  return out;
}

/** The heading of a control: its path from the open chip. */
export const controlPath = (c: NestedControl): string => c.path.join(' › ');

/** A bank's positions now (bit i = switch i). */
export function bankValue(sim: Sim | null, c: Extract<NestedControl, { kind: 'switches' }>): number {
  const li = c.node.leafIndex;
  return sim && li !== undefined ? (sim.leafState(li) as SwitchState | undefined)?.v ?? 0 : 0;
}

/** What flips a switch: the editor's simulation (EditorSim.pokeLeaf, which settles and redraws). */
export interface BankHost { readonly sim: Sim | null; pokeLeaf(li: number, state: unknown): void }

/** Flip switch `bit` of a nested bank. */
export function flipBank(host: BankHost, c: Extract<NestedControl, { kind: 'switches' }>, bit: number): void {
  const li = c.node.leafIndex;
  if (li === undefined || !host.sim) return;
  host.pokeLeaf(li, { v: flipSwitch(bankValue(host.sim, c), bit) } satisfies SwitchState);
}
