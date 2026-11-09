// A NAND string of floating-gate cells (chapter flash): the charge rule is src/lib/flash.ts's and src/sim/switchsim.ts's
// (FG_STEP a pulse, a read at V_READ conducts while the charge is under FG_READ), not a second copy of it. The string
// has four cells in series; a read puts V_READ on the chosen control gate and PASS_V on the others.

import { V_READ, vtOf } from '../lib/flash';
import { FG_READ, FG_STEP } from '../sim/switchsim';

export const CELLS = 4;
/** Electrons drawn at full charge (q = 1). Illustrative: a real cell holds thousands. */
export const E_FULL = 20;
/** Pass voltage: above every threshold a pulse train can reach (vtOf(1)), so an unselected cell always conducts. */
export const PASS_V = vtOf(1) + 1;

/** The charge after one program pulse: the switch-level solver's own update (it saturates at 1). */
export const pulse = (q: number): number => Math.min(1, q + FG_STEP);
/** Does a cell with charge q conduct with `vg` on its control gate? Vt = vtOf(q); the solver's read is q < FG_READ. */
export const conducts = (q: number, vg: number): boolean => vtOf(q) < vg;
/** Electrons shown for a charge: monotonic, 0 at q = 0, E_FULL at q = 1. */
export const electrons = (q: number): number => Math.round(Math.min(1, Math.max(0, q)) * E_FULL);

export interface Bank { q: number[]; sel: number }
export const fresh = (): Bank => ({ q: Array<number>(CELLS).fill(0), sel: 0 });
/** Program pulse on the chosen cell; the others are inhibited. */
export const program = (b: Bank): Bank => ({ ...b, q: b.q.map((q, i) => (i === b.sel ? pulse(q) : q)) });
/** Block erase empties every cell. */
export const erase = (b: Bank): Bank => ({ ...b, q: b.q.map(() => 0) });
/** The gate voltage cell i sees during a read of the chosen cell. */
export const readVoltage = (b: Bank, i: number): number => (i === b.sel ? V_READ : PASS_V);
/** Which cells conduct during a read of the chosen one. */
export const readConduction = (b: Bank): boolean[] => b.q.map((q, i) => conducts(q, readVoltage(b, i)));
/** The string carries current only if every cell in it does: that is the chosen cell's bit when the others pass. */
export const stringConducts = (b: Bank): boolean => readConduction(b).every(Boolean);
/** Pulses a cell needs before it reads 0. */
export const PULSES_TO_PROGRAM = Math.ceil(FG_READ / FG_STEP);
