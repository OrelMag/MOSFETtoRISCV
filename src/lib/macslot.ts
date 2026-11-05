// Where lib/macunit.ts hands its block to the CPU builder (lib/cpu.ts): the unit needs lib/fft.ts, which needs the pipeline, which needs the CPU, so cpu.ts
// cannot import it. macunit.ts sets `unit` when it loads; lib/index.ts loads it, and so does anything that asks for a core with the MAC.

import type { ComponentDef } from '../sim/types';

export const macSlot: { unit?: () => ComponentDef; cut?: (n: number, lo: number, w: number) => ComponentDef } = {};

export function macParts(): { unit: ComponentDef; cut: (n: number, lo: number, w: number) => ComponentDef } {
  if (!macSlot.unit || !macSlot.cut) throw new Error('singleCycleCpu: mac needs lib/macunit.ts loaded (import it, or lib/index)');
  return { unit: macSlot.unit(), cut: macSlot.cut };
}
