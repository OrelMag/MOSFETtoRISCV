// A sandbox selection as one net, for the right-click menu. DOM-free. compile.ts keys its maps by id: a pointer's id,
// and `pin:<id>` for a pin.

import type { Compiled } from './compile';

export interface NetSelection { parts?: string[]; pins?: string[]; wires?: string[]; labels?: string[]; comments?: string[] }

/** The chip-level net the selection is, when wires, pointers and at most one pin are all on that net (Highlight selects a whole net); else -1. */
export function netOfSelection(c: Pick<Compiled, 'netOfWire' | 'netOfLabel' | 'netOfEnd'>, s: NetSelection): number {
  if (s.parts?.length || s.comments?.length || (s.pins?.length ?? 0) > 1) return -1;
  const nets = new Set<number | undefined>([
    ...(s.wires ?? []).map((id) => c.netOfWire.get(id)),
    ...(s.labels ?? []).map((id) => c.netOfLabel.get(id)),
    ...(s.pins ?? []).map((id) => c.netOfEnd.get(`pin:${id}`)),
  ]);
  const [n] = nets;
  return nets.size === 1 && n !== undefined && n >= 0 ? n : -1;
}

/** Every wire and pointer of a net: what Highlight selects. */
export function netMembers(c: Pick<Compiled, 'netOfWire' | 'netOfLabel'>, idx: number): { wires: string[]; labels: string[] } {
  const on = (m: Map<string, number>) => [...m].filter(([, n]) => n === idx).map(([id]) => id);
  return { wires: on(c.netOfWire), labels: on(c.netOfLabel) };
}
