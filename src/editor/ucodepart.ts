// Which part of a chip is the multicycle CPU's microprogrammed controller (kept apart from the painter's dialog so the
// CPU drawer and the search can ask without loading it).

import { MC_PROGRAM, type Microprogram } from '../lib/multicycle';
import type { ChipDoc, PartDoc } from './model';

/** The microprogrammed controller part of a chip, if it has one (the selected one first). */
export function microcodePart(doc: ChipDoc, selected?: readonly string[]): PartDoc | undefined {
  const is = (p: PartDoc) => ('lib' in p.ref && p.ref.lib === 'mc_micro') || 'ucode' in p.ref;
  return doc.parts.find((p) => is(p) && selected?.includes(p.id)) ?? doc.parts.find(is);
}

export const microprogramOfPart = (p: PartDoc): Microprogram => ('ucode' in p.ref ? structuredClone(p.ref.ucode) : structuredClone(MC_PROGRAM));
