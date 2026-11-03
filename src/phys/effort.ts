// Logical effort of n-input static CMOS gates (DOM-free), the same d = p + g·h as sim/delay.ts, for a PMOS twice the
// NMOS width (the usual r = 2): g is the input capacitance relative to an inverter delivering the same current,
// p the parasitic delay, which grows with the drain capacitance on the output (n for both kinds).

import { G_NAND, P_NAND } from '../sim/delay';

export const gNand = (n: number) => (n + 2) / 3;
export const gNor = (n: number) => (2 * n + 1) / 3;
export const pGate = (n: number) => n;

export { G_NAND, P_NAND };

/** Delay (τ) of a path of stages with logical efforts `gs` and parasitics `ps`, driving electrical effort H (equal effort per stage). */
export function pathDelay(gs: readonly number[], ps: readonly number[], H: number): number {
  const N = gs.length, F = gs.reduce((a, g) => a * g, 1) * H;
  return N * F ** (1 / N) + ps.reduce((a, p) => a + p, 0);
}

/** A 4-input AND driving electrical effort H: one NAND4 and an inverter, or two NAND2 into a NOR2. */
export const and4Wide = (H: number) => pathDelay([gNand(4), 1], [pGate(4), 1], H);
export const and4Tree = (H: number) => pathDelay([gNand(2), gNor(2)], [pGate(2), pGate(2)], H);
