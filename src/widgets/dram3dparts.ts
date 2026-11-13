// The DRAM array's dimensions (DOM-free; dram3dkit.ts draws it). Row 0 is the front row, columns run along x. Every charge stands on the plate as a
// solid whose HEIGHT is the simulator's level (a fraction of VDD) and whose footprint AREA is proportional to its
// capacitance, so its volume is its charge. A cell is a round column; a bit line is what it is on silicon, a long line,
// here a trough behind its column of cells whose length grows with its capacitance (more cells hang on a longer line), with
// the reference line beside it. Open a row and a cell's volume pours into its bit line until both stand at one height; the
// sense amplifier where the pair begins then drives them apart, to the rails.


export const PITCH = 10, HMAX = 18, R_CELL = 1.8, PAD = 0.3;
/** A cell's footprint, and a bit line's width: its length is then its capacitance over this width. */
export const A_CELL = Math.PI * R_CELL * R_CELL, W_LINE = 2.6;
export const X_OF = (c: number) => (c - 1.5) * PITCH;
export const Z_OF = (r: number) => (1.5 - r) * PITCH;
/** A column's bit line and reference line, along x; where both begin (the amplifier's end) and how long they run. */
export const BL_X = (c: number) => X_OF(c) + 4.6, BLB_X = (c: number) => X_OF(c) + 7.6;
export const LINE_Z0 = Z_OF(3) - 9;
/** Length of a bit line `ratio` times a cell's capacitance: area ∝ C, so ratio × A_CELL over the width. */
export const lineLength = (ratio: number) => (ratio * A_CELL) / W_LINE;
