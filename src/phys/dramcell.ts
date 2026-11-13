// A real DRAM cell's numbers (DOM-free, tested): what the chapter's liquid column stands for. A 1T1C cell of a 1y-class
// process: a 6F² footprint, an access transistor whose gate is a word line buried in a trench in the silicon, a bit line
// over it, and a stacked capacitor, a tall thin cylinder standing on the cell.
//
// Sources and what is typical:
// - Footprint: Samsung's 1y DRAM cell, 0.0023 µm² (TechInsights, "DRAM technology" roadmap article by J. Choe, via Semiconductor
//   Digest); a 6F² cell, so F = √(A / 6) ≈ 19.6 nm. Measured.
// - Capacitor: "~1,000 nm high but only 10s of nm in diameter … capacitance on the order of 6-7 fF" (SemiAnalysis, "The Memory
//   Wall", 2024: secondary, figure after Applied Materials); a 54 nm-class part published 1.4–1.6 µm. Height 1 000 nm and a
//   33 nm diameter (fitted under the hexagonal pitch the footprint allows) are typical, not one product's.
// - Dielectric: a zirconia-based stack of about 0.45 nm equivalent oxide thickness (typical for these nodes; illustrative).
// - Buried word line: its recess depth (about 120 nm under the silicon's top) and the bit line's and pads' heights are
//   typical, drawn after the published structure (Samsung's BCAT: Kim et al., VLSI Technology 2005), not measured.
// - A bit line: "more than 30 fF – a 5x dilution" (SemiAnalysis).

export const EPS0 = 8.854e-12, K_SIO2 = 3.9;

/** Samsung 1y cell area, µm² (TechInsights). */
export const CELL_AREA_UM2 = 0.0023;
/** The feature size of a 6F² cell of that area, nm. */
export const featureNm = (areaUm2 = CELL_AREA_UM2): number => Math.sqrt((areaUm2 * 1e6) / 6);
/** Capacitor centres on a hexagonal lattice, one per cell: the pitch, nm. */
export const hexPitchNm = (areaUm2 = CELL_AREA_UM2): number => Math.sqrt((2 * areaUm2 * 1e6) / Math.sqrt(3));

/** The storage capacitor drawn (typical): height and outer diameter in nm, dielectric EOT in nm. */
export const CAP = { hNm: 1000, dNm: 33, eotNm: 0.45 };
/** A pillar's capacitance from its outer wall only (the plate wraps it; the bottom electrode is solid inside), fF. */
export const pillarFF = (dNm: number, hNm: number, eotNm: number): number => (K_SIO2 * EPS0 * Math.PI * dNm * 1e-9 * hNm * 1e-9) / (eotNm * 1e-9) * 1e15;
export const capFF = (): number => pillarFF(CAP.dNm, CAP.hNm, CAP.eotNm);
/** The quoted range, fF (SemiAnalysis). */
export const QUOTED_FF: [number, number] = [6, 7];
/** A bit line's capacitance, fF (SemiAnalysis: "more than 30 fF"). */
export const BITLINE_FF = 30;

/** The structure's heights, nm, from the silicon's top (y = 0): typical, after the published BCAT structure. */
export const H = {
  wlTop: -45, wlBot: -125,    // the buried word line (its trench capped with nitride above)
  stiBot: -250,               // the isolation trench round the active area
  blBot: 30, blTop: 80,       // the bit line, over the shared bit-line contact
  padBot: 130, padTop: 160,   // the landing pad the capacitor stands on
};
