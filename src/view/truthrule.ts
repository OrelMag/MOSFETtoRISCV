// Why a part has no truth table, in a menu row's few words; the Inspector's tab says it at length. DOM-free.

import { inputBits } from '../sim/harness';
import { hasFeedback, stats } from '../sim/stats';
import { type ComponentDef, netlistOf, outPorts } from '../sim/types';

/** The most input bits the Inspector tabulates. */
export const TRUTH_MAX_BITS = 8;

/** Flattening more than this to look for feedback would stall a menu: the Inspector's tab tells, when it is opened. */
const CHECK_NANDS = 2000;

/** "Where it is used" is in the Inspector for library parts only (a user chip has the sandbox's own "used by"). */
export const hasUsage = (d: ComponentDef): boolean => d.prim !== 'alias' && d.prim !== 'vdd' && d.prim !== 'gnd' && d.category !== 'custom';

/** Why a part has no power of its own to show (null: it has); `live`: a running scene's meter counts it. As the Inspector's section. */
export function powerOff(d: ComponentDef | undefined, live: boolean): string | null {
  if (!d || !d.prim) return null;
  if (d.prim === 'nand' && live) return null;
  return 'Counted for circuits, not for one primitive: see the level above.';
}

/** Null: it has one. */
export function truthOff(d: ComponentDef): string | null {
  if (d.prim === 'alias' || d.prim === 'vdd' || d.prim === 'gnd') return 'Pure wiring: nothing to tabulate.';
  if (d.prim === 'nmos' || d.prim === 'pmos' || d.prim === 'dep' || d.prim === 'res' || d.prim === 'cap') return 'A device, not a function: see Inspect.';
  if (!outPorts(d).length && d.ports.some((p) => p.dir === 'inout')) return 'Its ports are two-way: no input → output function.';
  // the cheap test first, so a block too wide to list is never flattened here
  const n = inputBits(d);
  if (n > TRUTH_MAX_BITS) return `${n} input bits: too many rows to list.`;
  if (!netlistOf(d) || stats(d).nands > CHECK_NANDS) return null;
  try {
    return hasFeedback(d) ? 'It has feedback: its outputs depend on its history.' : null;
  } catch {
    // as the Inspector's tab reads a throw
    return 'It has feedback: its outputs depend on its history.';
  }
}
