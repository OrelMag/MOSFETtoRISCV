// The Apollo Guidance Computer's Block II logic module: what it holds and where (DOM-free, tested; drawn by
// agcmodule3dkit.ts). Units: mm.
//
// The flatpack, from MIT / MSC drawing 1006321 rev G (Dual NOR Gate (Flat Pack) Specification Control Drawing, 1965–67,
// sheet 3, Figure 1, klabs.org): body 0.275 × 0.190 in at most (glass climb included), 0.070 in high at most; ten leads
// on a 0.050 in pitch, 0.010–0.019 in wide, 0.003–0.006 in thick, standing 0.190–0.240 in out of the body; a keying
// stripe 0.020–0.060 in wide at the pin 1 / pin 10 end; pins 1 O1, 2–4 I1, 5 GND, 6–8 I2, 9 O2, 10 VCC; silicon NPN,
// hermetic, gold-plated leads. The chip: six transistors and eight resistors, two three-input NOR gates (K. Shirriff,
// righto.com 2019); each gate three NPNs with their collectors joined under one collector resistor and a base resistor on
// each input (R-700, drawing 2005011: lib/agcnor.ts). The module: "two boards with 60 chips each, for a total of 240 NOR
// gates"; the arithmetic modules sit in slots A8–A11 of the logic tray (Shirriff). Its outline, 5/8 × 9 5/8 × 1 3/4 in, is
// the Computer History Museum's record of one logic module [S]. The board's layers, the packages' spacing on it, the
// connector, the epoxy's colour and the tray around it are drawn.

import { stats } from '../sim/stats';
import { NOR_ADD4, NOR_REG4 } from '../lib/agcnor';

const IN = 25.4;
/** The flatpack (drawing 1006321): body length (along the leads' rows), width, height; lead pitch, width, thickness, reach. */
export const FP = {
  l: 0.275 * IN, w: 0.19 * IN, h: 0.07 * IN,
  pitch: 0.05 * IN, leadW: 0.015 * IN, leadT: 0.0045 * IN, leadL: 0.215 * IN, stripe: 0.04 * IN,
} as const;
/** Leads a package (five a side), gates a package, transistors and resistors a gate. */
export const LEADS = 10, GATES_PER_PACKAGE = 2, GATE_NPN = 3, GATE_RES = 4;
/** What each lead carries (drawing 1006321): pin 1 first. */
export const PINOUT = ['O1', 'I1', 'I1', 'I1', 'GND', 'I2', 'I2', 'I2', 'O2', 'VCC'] as const;

/** The module: two boards of sixty packages; 240 gates. Outline [S]: 9 5/8 × 1 3/4 × 5/8 in. */
export const BOARDS = 2, PER_BOARD = 60;
export const PACKAGES = BOARDS * PER_BOARD, MODULE_GATES = PACKAGES * GATES_PER_PACKAGE;
export const MOD = { l: 9.625 * IN, h: 1.75 * IN, t: 0.625 * IN } as const;
/** Packages on a board: two rows of thirty along it (drawn: the arrangement on the board is not from a drawing). */
export const ROWS = 2, COLS = PER_BOARD / ROWS;
export const BOARD_T = 1.6;
/** A package's centre on a board, in the board's plane: u along the module, v across it. */
export function packageAt(i: number): { u: number; v: number } {
  const row = Math.floor(i / COLS), col = i % COLS, pitchU = (MOD.l - 14) / COLS;
  return { u: -MOD.l / 2 + 7 + (col + 0.5) * pitchU, v: (row - (ROWS - 1) / 2) * (MOD.h * 0.42) };
}

/** Packages a block of the chapter takes: two gates each, so ⌈gates / 2⌉. */
export const packagesFor = (gates: number): number => Math.ceil(gates / GATES_PER_PACKAGE);
/** Step 2's four-bit adder and step 4's four-bit register, in NOR3s and in packages. */
export const ADDER_GATES = stats(NOR_ADD4).nor3 ?? 0, REG_GATES = stats(NOR_REG4).nor3 ?? 0;
export const ADDER_PACKAGES = packagesFor(ADDER_GATES), REG_PACKAGES = packagesFor(REG_GATES);

/** The logic tray, as drawn: modules standing on edge in a row of slots; A8–A11 the four arithmetic modules. */
export const SLOTS = 24, SLOT_PITCH = 22, ARITH = [8, 9, 10, 11] as const, LIFTED = 8;
export const slotX = (n: number): number => (n - (SLOTS + 1) / 2) * SLOT_PITCH;
export const TRAY = { l: SLOTS * SLOT_PITCH + 40, d: MOD.l + 40, h: 30 } as const;

/** The gate: y = NOR(a, b, c), and which of its three transistors conduct (an input high turns its NPN on). */
export const norOut = (a: number, b: number, c: number): number => (a || b || c ? 0 : 1);
export const conducting = (ins: readonly number[]): boolean[] => ins.map((x) => x === 1);

/** The die drawn enlarged in the gate view (its real size, about 1.3 × 1.0 mm, is drawn): MAG times life. */
export const DIE = { l: 1.3, w: 1.0 } as const, MAG = 40;
