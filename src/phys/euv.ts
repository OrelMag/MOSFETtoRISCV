// EUV lithography's numbers (DOM-free, tested): the light source's droplets and power chain, and the scanner's mirrors,
// cones and resolution. Every input names its source; where a figure is not published the comment says what it is.
//
// Fomenkov et al., "Light sources for high-volume manufacturing EUV lithography: technology, performance, and power scaling",
// Adv. Opt. Techn. 6 (2017) 173–186 (ASML): droplets 20–30 µm at 40–100 kHz and 60–120 m/s, 1.5 mm apart at 50 kHz; a 10.6 µm
// CO2 laser through the collector's central hole onto the droplet at the ellipsoid's primary focus; "more than 20 kW of laser
// power is needed to produce 200 W of EUV power at the intermediate focus"; CE of 6 % demonstrated; hydrogen buffer gas
// with 20–30 % EUV absorption accepted; "10 reflections from intermediate focus (IF) to the wafer and peak mirror reflectivity
// of 67 %, the overall transmission is about 2 %"; 13.5 nm within a 2 % band. Laser Focus World (2017) on the same work:
// > 5 sr collected, a 400 µm target after the pre-pulse. ASML (NXE:3400): NA 0.33, 4×, 26 × 33 mm field. High NA (ASML /
// Zeiss, EUVL workshop 2017): NA 0.55 on a 26 × 16.5 mm half field from the same 6-inch mask, i.e. 8× along the scan.

export const LAMBDA_NM = 13.5;

// ---------------------------------------------------------------- the source

export const DROP = { dUm: 30, fKhz: 50, vMs: 75 };
/** Droplet spacing in mm: v / f (75 m/s at 50 kHz is the paper's 1.5 mm). */
export const spacingMm = (vMs: number, fKhz: number): number => vMs / fKhz;
/** One period in µs. */
export const periodUs = (fKhz: number): number => 1000 / fKhz;
/** The target the pre-pulse makes, its diameter in µm (Laser Focus World). */
export const TARGET_UM = 400;

/** The collector's solid angle (> 5 sr) as the half-angle of a cone round the axis: Ω = 2π (1 − cos θ). */
export const COLLECT_SR = 5;
export const halfAngleDeg = (sr: number): number => (Math.acos(1 - sr / (2 * Math.PI)) * 180) / Math.PI;

/** The factors from the laser to the intermediate focus. CE is in band (2 % at 13.5 nm) into the 2π in front of the target;
 *  the collector takes Ω of that 2π; it reflects like the scanner's mirrors at best (67 %, an upper bound for a collector);
 *  the gas absorbs 20–30 %. The fraction of the laser's energy that lands on the target is not published: `onTarget`. */
export interface Chain { ce: number; sr: number; rColl: number; gasAbs: number; onTarget: number }
export const CHAIN: Chain = { ce: 0.05, sr: COLLECT_SR, rColl: 0.67, gasAbs: 0.25, onTarget: 1 };
/** EUV watts at IF for a laser's kW. */
export const powerAtIf = (laserKw: number, c: Chain = CHAIN): number => laserKw * 1000 * c.onTarget * c.ce * (c.sr / (2 * Math.PI)) * c.rColl * (1 - c.gasAbs);
/** The fraction of the laser that must land on the target for kW to give W at IF (the published anchor: 20 kW, 200 W). */
export const onTargetNeeded = (laserKw: number, w: number, c: Chain = CHAIN): number => w / powerAtIf(laserKw, { ...c, onTarget: 1 });

// ---------------------------------------------------------------- the scanner

export const R_MIRROR = 0.67;
/** Reflections from IF to the wafer (Fomenkov's example); 6 of them the projection optics, 1 the mask, 3 the illuminator (derived). */
export const REFLECTIONS = 10, POB_MIRRORS = 6, ILL_MIRRORS = REFLECTIONS - POB_MIRRORS - 1;
/** The power left after n reflections. */
export const transmission = (r: number, n: number): number => r ** n;

/** Smallest half-pitch R = k1 · λ / NA, in nm (silicon's "How chips are made" quotes it). */
export const halfPitchNm = (k1: number, lambdaNm: number, na: number): number => (k1 * lambdaNm) / na;

/** The chief ray's angle at the mask (6°, quoted for the 0.33 NA tools; secondary sources). */
export const CRA_DEG = 6;
/** A cone's half-angle in degrees at the mask for a numerical aperture at the wafer and a reduction M. */
export const maskHalfDeg = (na: number, m: number): number => (Math.asin(na / m) * 180) / Math.PI;
export const waferHalfDeg = (na: number): number => (Math.asin(na) * 180) / Math.PI;
/** The light going in and coming out of the mask apart: each cone's half-angle under the chief ray's angle. */
export const conesApart = (na: number, m: number, craDeg = CRA_DEG): boolean => maskHalfDeg(na, m) < craDeg;

export interface Optics { name: string; na: number; mScan: number; mSlit: number; field: [number, number] }
/** The settings the readout offers: today's tool, a High NA tool that keeps 4× (it cannot), and High NA as built. */
export const OPTICS: Optics[] = [
  { name: 'NA 0.33, 4×', na: 0.33, mScan: 4, mSlit: 4, field: [26, 33] },
  { name: 'NA 0.55, 4×', na: 0.55, mScan: 4, mSlit: 4, field: [26, 33] },
  { name: 'NA 0.55, 8× along the scan', na: 0.55, mScan: 8, mSlit: 4, field: [26, 16.5] },
];
/** The mask's image of the field (mm): the wafer field times the reduction on each axis. */
export const maskField = (o: Optics): [number, number] => [o.field[0] * o.mSlit, o.field[1] * o.mScan];
/** The 6-inch mask blank (SEMI P37): 152 × 152 × 6.35 mm. */
export const MASK = { side: 152, t: 6.35 };
