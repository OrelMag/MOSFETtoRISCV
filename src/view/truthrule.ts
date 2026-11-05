// Why a part has no truth table, in a menu row's few words; the Inspector's tab says it at length. DOM-free.

import { inputBits } from '../sim/harness';
import { hasFeedback } from '../sim/stats';
import { type ComponentDef, netlistOf, outPorts } from '../sim/types';

/** The most input bits the Inspector tabulates. */
export const TRUTH_MAX_BITS = 8;

/** Null: it has one. */
export function truthOff(d: ComponentDef): string | null {
  if (d.prim === 'alias' || d.prim === 'vdd' || d.prim === 'gnd') return 'Pure wiring: nothing to tabulate.';
  if (d.prim === 'nmos' || d.prim === 'pmos' || d.prim === 'dep' || d.prim === 'res' || d.prim === 'cap') return 'A device, not a function: see Inspect.';
  try {
    if (netlistOf(d) && hasFeedback(d)) return 'It has feedback: its outputs depend on its history.';
  } catch { /* too deep to tell: the Inspector's tab says what it can */ }
  if (!outPorts(d).length && d.ports.some((p) => p.dir === 'inout')) return 'Its ports are two-way: no input → output function.';
  const n = inputBits(d);
  return n > TRUTH_MAX_BITS ? `${n} input bits: too many rows to list.` : null;
}
