// An inverter chain driving a big load, by logical effort (DOM-free): each stage d = p + g·h in units of τ, with g = 1
// and p = P_INV for an inverter (sim/delay.ts has the NAND's 4/3 and 2). With electrical effort F = Cload / Cin split
// evenly over N stages, every stage has h = F^(1/N), so D(N) = N·F^(1/N) + N·p.

import { P_INV, PS_PER_TAU } from '../sim/delay';

export { P_INV, PS_PER_TAU };

/** Total delay (τ) of N inverters, each ρ = F^(1/N) bigger than the last, driving F times the first one's input. */
export const chainDelay = (F: number, N: number) => N * F ** (1 / N) + N * P_INV;

/** The N (1 … 12) with the smallest delay. */
export function bestStages(F: number): number {
  let best = 1;
  for (let n = 2; n <= 12; n++) if (chainDelay(F, n) < chainDelay(F, best)) best = n;
  return best;
}

/** A fan-out-of-4 inverter: one inverter driving four copies of itself, in τ: the technology's yardstick. */
export const FO4_TAU = P_INV + 4;
