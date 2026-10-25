// The price of an out-of-order shape from the gates: NANDs (without the program ROM) and the static-timing period of
// the gate-level core (lib/ooocore.ts) built with that shape's window sizes. Only shapes the gate-level core can take
// are priced: 2-wide, its ports, predictor, recovery and latencies, any measured reorder-buffer / issue-queue /
// store-queue sizes. Everything else the lab times but does not price.

import { OOO_CORE, shapeOf, portsOf, type OooConfig } from '../riscv/ooomodel';
import RESULTS from './results.json';

export interface Price { rob: number; iq: number; sq: number; nands: number; period: number }

const core = RESULTS.cpus.find((c) => c.id === 'ooo')!;
/** Measured points (the core's own from the benchmark runs). */
export const PRICE_POINTS: Price[] = [{ rob: OOO_CORE.rob, iq: OOO_CORE.iq, sq: OOO_CORE.sq, nands: core.nands, period: core.period }];

/** Whether the gate-level core can be built in this shape, sizes aside. */
export function gateShape(cfg: Partial<OooConfig>): boolean {
  const c: OooConfig = { ...OOO_CORE, ...cfg, lat: { ...OOO_CORE.lat, ...cfg.lat } }, sh = shapeOf(c);
  const same = <T>(a: T, b: T) => JSON.stringify(a) === JSON.stringify(b);
  return sh.fetch === 2 && sh.commit === 2 && same(sh.ports, portsOf(2, 2)) && (c.divider ?? 'iterative') === 'iterative'
    && !c.inorder && c.predict === 'ras' && c.btb === OOO_CORE.btb && c.ras === OOO_CORE.ras && c.recover === 'commit'
    && c.bind === OOO_CORE.bind && same(c.lat, OOO_CORE.lat);
}

/** The measured price of a shape, or null. */
export function priceOf(cfg: Partial<OooConfig>): Price | null {
  if (!gateShape(cfg)) return null;
  const c = { ...OOO_CORE, ...cfg };
  return PRICE_POINTS.find((p) => p.rob === c.rob && p.iq === c.iq && p.sq === c.sq) ?? null;
}
