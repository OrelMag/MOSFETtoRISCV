// Image sensors as numbers: light into charge in silicon, a CCD's clocked transfer, the 4T CMOS pixel with correlated
// double sampling, rolling and global shutters, the Bayer mosaic, and what limits a pixel. DOM-free, so the chapter, the
// 3D models (Rock's CCD and pixel, Swan's stack and die) and the tests read one copy of every number.
//
// Sources (every constant below names one):
// - Absorption of silicon: M. A. Green, "Self-consistent optical parameters of intrinsic silicon at 300 K", Solar Energy
//   Materials & Solar Cells 92 (2008) 1305–1310, table 1 (α in cm⁻¹).
// - CCD: Teledyne e2v CCD42-40 back-illuminated datasheet (1B300000-A1A v1, 2024): 2048 × 2048 + 4 rows of 13.5 µm
//   pixels, three-phase image (I∅1–3) and register (R∅1–3) clocks, 150 ke⁻ peak charge (NIMO), 4.5 µV/e⁻ output,
//   3 e⁻ rms read noise (low-noise mode), minimum QE 75 / 80 / 50 % at 500 / 650 / 900 nm (deep depleted, Enhanced
//   Multilayer-2), CTE 99.9999 % parallel / 99.9993 % serial, dark signal 20 000 e⁻/pixel/s at
//   293 K and the law Qd/Qd0 = 122 T³ e^(−6400/T), readout 20 kHz–3 MHz, 675 mV peak output.
// - Consumer CCD for comparison: Sony ICX285AL (Type 2/3 interline, EXview HAD): 1360 × 1024 effective, 6.45 µm cells,
//   four-phase vertical clocks Vφ1–4, two-phase horizontal Hφ1–2, 28.64 MHz horizontal drive, all pixels in about
//   1/15 s. Full well is not in Sony's datasheet: camera makers measure 16–24 ke⁻ (we use 20 ke⁻, FLI / AstroBin).
// - CMOS: Sony IMX183 (Type 1, back-illuminated, rolling shutter): 5544 × 3694 effective 2.4 µm pixels, 21.98 frame/s
//   at 12 bits (Sony product brief); measured by FLIR's EMVA 1288 report for the BFS-U3-200S6M: QE 79 % at 525 nm,
//   saturation 14 837 e⁻, temporal dark noise 3.30 e⁻, 0.24 e⁻/ADU; colour model QE B 63 % / G 69 % / R 43 %.
//
// Simplified, and said so where shown: QE is a one-dimensional absorption model (light absorbed between a dead surface
// layer and the collection depth, times the optics' transmission), fitted to the measured points, not a device model;
// the IMX183's conversion gain is not published, so CG_4T is an illustrative value for a 2.4 µm pixel (the swing it gives
// stays under the 1 V a 2.8 V pixel supply allows) and C_FD follows as q / CG; the IMX183's row time is derived from its
// frame rate (blanking ignored).

/** Physical constants (CODATA 2018, exact). */
export const Q_E = 1.602176634e-19;
export const H_PLANCK = 6.62607015e-34;
export const C_LIGHT = 2.99792458e8;
export const K_B = 1.380649e-23;

/** Photon energy (J) and (eV) at a wavelength in nm. */
export const photonEnergy = (nm: number): number => (H_PLANCK * C_LIGHT) / (nm * 1e-9);
export const photonEv = (nm: number): number => photonEnergy(nm) / Q_E;
/** Silicon's band gap at 300 K (eV) and the longest wavelength it absorbs (nm). */
export const SI_GAP_EV = 1.12;
export const SI_CUTOFF_NM = (H_PLANCK * C_LIGHT) / (SI_GAP_EV * Q_E) * 1e9;

/** Absorption coefficient of intrinsic silicon at 300 K, cm⁻¹ (Green 2008, table 1), 400–1100 nm. */
export const ALPHA_SI: readonly (readonly [number, number])[] = [
  [400, 9.52e4], [450, 2.55e4], [500, 1.11e4], [550, 6.39e3], [600, 4.14e3], [650, 2.81e3], [700, 1.9e3], [750, 1.3e3],
  [800, 8.5e2], [850, 5.35e2], [900, 3.06e2], [950, 1.57e2], [1000, 64], [1050, 16.3], [1100, 3.5],
];
/** α(λ) in cm⁻¹, log-linear between table points, clamped to the table's ends. */
export function alphaSi(nm: number): number {
  const t = ALPHA_SI;
  if (nm <= t[0][0]) return t[0][1];
  if (nm >= t[t.length - 1][0]) return t[t.length - 1][1];
  const exact = t.find(([x]) => x === nm);
  if (exact) return exact[1];
  let i = 0;
  while (t[i + 1][0] < nm) i++;
  const [x0, a0] = t[i], [x1, a1] = t[i + 1];
  return Math.exp(Math.log(a0) + ((nm - x0) / (x1 - x0)) * (Math.log(a1) - Math.log(a0)));
}
/** 1/e absorption depth in µm: blue stops in a tenth of a micrometre, near infrared goes tens of micrometres deep. */
export const absorptionDepth = (nm: number): number => 1e4 / alphaSi(nm);
/** Fraction of the light entering silicon that is absorbed between depths a and b (µm). */
export const absorbedBetween = (nm: number, a: number, b: number): number => {
  const al = alphaSi(nm) * 1e-4;
  return Math.exp(-al * a) - Math.exp(-al * b);
};

/** The optical stack a QE estimate assumes: transmission of everything above the silicon (microlens, filter, oxide,
 *  anti-reflection), the dead layer at the lit surface (µm) and how deep charge is still collected (µm). */
export interface Stack { name: string; transmit: number; dead: number; collect: number }
/** Back-illuminated 2.4 µm CMOS (IMX183 class): thinned silicon lit from the back, light reaches the diode directly.
 *  Fitted so qe(525) matches the EMVA 79 %. */
export const STACK_BSI: Stack = { name: 'BSI CMOS', transmit: 0.86, dead: 0.01, collect: 3 };
/** Front-illuminated CMOS of the same pitch: light passes the metal stack first, so less reaches the diode, and the
 *  diode sits under a heavier surface layer (illustrative, for the comparison only). */
export const STACK_FSI: Stack = { name: 'FSI CMOS', transmit: 0.55, dead: 0.1, collect: 3 };
/** CCD42-40 back-illuminated, deep-depleted silicon, Enhanced Multilayer-2 coating: about 40 µm collecting depth,
 *  fitted to the datasheet's minimum response table (75 % at 400–500 nm, 80 % at 650 nm, 50 % at 900 nm). */
export const STACK_CCD42: Stack = { name: 'CCD42-40 deep depleted', transmit: 0.82, dead: 0.005, collect: 40 };
/** Quantum efficiency: electrons collected per photon arriving, at a wavelength. */
export const qe = (nm: number, s: Stack = STACK_BSI): number => (nm >= SI_CUTOFF_NM ? 0 : s.transmit * absorbedBetween(nm, s.dead, s.collect));

/** One sensor family's numbers, as cited in the header. Lengths in µm, charge in e⁻, gains in µV/e⁻, times in s. */
export interface SensorPart {
  part: string; kind: 'ccd' | 'cmos'; cols: number; rows: number; pitch: number;
  fullWell: number; readNoise: number; cg: number; peakQe: number; peakQeNm: number; adcBits: number;
  shutter: 'full-frame' | 'interline' | 'rolling' | 'global';
}
export const CCD42_40: SensorPart & {
  phases: 3; cteParallel: number; cteSerial: number; darkAt293: number; readHz: [number, number]; peakOutputV: number;
  outputNode: number; gateLength: number;
} = {
  part: 'Teledyne e2v CCD42-40', kind: 'ccd', cols: 2048, rows: 2048, pitch: 13.5,
  fullWell: 150_000, readNoise: 3, cg: 4.5, peakQe: 0.8, peakQeNm: 650, adcBits: 16, shutter: 'full-frame',
  phases: 3, cteParallel: 0.999999, cteSerial: 0.999993, darkAt293: 20_000, readHz: [20e3, 3e6], peakOutputV: 0.675,
  outputNode: 1_000_000,
  gateLength: 13.5 / 3, // derived: three equal gates per pixel (the datasheet gives no gate length)
};
export const ICX285: SensorPart & { phasesV: 4; phasesH: 2; hClockHz: number; frameS: number } = {
  part: 'Sony ICX285AL', kind: 'ccd', cols: 1360, rows: 1024, pitch: 6.45,
  fullWell: 20_000, readNoise: 4.5, cg: NaN, peakQe: 0.65, peakQeNm: 500, adcBits: 14, shutter: 'interline',
  phasesV: 4, phasesH: 2, hClockHz: 28.64e6, frameS: 1 / 15,
};
/** The IMX183's conversion gain is not published; 60 µV/e⁻ is illustrative for a 2.4 µm 4T pixel (its full well then
 *  swings the floating diffusion 0.89 V). */
export const CG_4T = 60;
export const IMX183: SensorPart & { fps: number; qeRgb: { r: [number, number]; g: [number, number]; b: [number, number] }; eAdu: number } = {
  part: 'Sony IMX183', kind: 'cmos', cols: 5544, rows: 3694, pitch: 2.4,
  fullWell: 14_837, readNoise: 3.3, cg: CG_4T, peakQe: 0.79, peakQeNm: 525, adcBits: 12, shutter: 'rolling',
  fps: 21.98, qeRgb: { b: [0.63, 470], g: [0.69, 525], r: [0.43, 640] }, eAdu: 0.24,
};

// ---- light into charge, and noise ----

/** Photons arriving on one pixel: irradiance (W/m²) at one wavelength, pixel pitch (µm), exposure (s). */
export const photonsOnPixel = (wPerM2: number, nm: number, pitchUm: number, t: number): number =>
  (wPerM2 * (pitchUm * 1e-6) ** 2 * t) / photonEnergy(nm);
/** Signal electrons (clipped at the full well). */
export const electrons = (photons: number, q: number, fullWell: number): number => Math.min(fullWell, photons * q);
/** Shot noise of a mean charge (e⁻ rms): Poisson, √N. */
export const shotNoise = (e: number): number => Math.sqrt(Math.max(0, e));
/** Signal-to-noise ratio of one pixel: signal, dark charge and read noise (all e⁻). */
export const snr = (signal: number, dark: number, read: number): number => signal / Math.sqrt(signal + dark + read * read);
/** Dynamic range in dB: full well over read noise. */
export const dynamicRangeDb = (p: Pick<SensorPart, 'fullWell' | 'readNoise'>): number => 20 * Math.log10(p.fullWell / p.readNoise);
/** CCD42-40 dark signal (e⁻/pixel/s) at temperature T (K): the datasheet's law, 122 T³ e^(−6400/T) × the 293 K value. */
export const darkCurrent = (T: number, at293 = CCD42_40.darkAt293): number => at293 * 122 * T ** 3 * Math.exp(-6400 / T);
/** Seeded generator (mulberry32) and Poisson / normal draws, for figures that show noise. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function poisson(mean: number, r: () => number): number {
  if (mean > 60) return Math.max(0, Math.round(mean + Math.sqrt(mean) * normal(r)));
  const L = Math.exp(-mean);
  let k = 0, p = 1;
  do { k++; p *= r(); } while (p > L);
  return k - 1;
}
export const normal = (r: () => number): number => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());

// ---- CCD: clocked transfer ----

/** The gates held high at each step of an n-phase clock (phases numbered 1…n). Three-phase moves a packet one gate in
 *  two steps (one gate high, then two overlapping); four-phase keeps two adjacent gates high and shifts by one each
 *  step. One pixel = n gates, so a pixel's transfer takes 2n steps (three-phase) or n steps (four-phase). */
export function clockHigh(n: 3 | 4, step: number): number[] {
  if (n === 3) {
    const k = ((step % 6) + 6) % 6, a = Math.floor(k / 2) + 1;
    return k % 2 === 0 ? [a] : [a, (a % 3) + 1];
  }
  const a = (((step % 4) + 4) % 4) + 1;
  return [a, (a % 4) + 1];
}
/** Steps of the clock per pixel moved. */
export const stepsPerPixel = (n: 3 | 4): number => (n === 3 ? 6 : 4);
/** Where a packet that started under gate 1 sits after `step` steps, in gates (centre of the high gates): it advances half
 *  a gate a step (three-phase) or one gate a step (four-phase). */
export function packetGate(n: 3 | 4, step: number): number {
  return n === 3 ? step / 2 : step;
}
/** Fraction of a packet's charge left after `transfers` transfers at a charge-transfer efficiency (the rest trails). */
export const afterTransfers = (transfers: number, cte: number): number => cte ** transfers;
/** A full-frame CCD's pixel (row r from the register, column c from the output) is moved r + 1 times down into the
 *  serial register, then c + 1 times along it: the fraction of its charge that reaches the output amplifier. */
export const ccdRetained = (r: number, c: number, p = CCD42_40): number =>
  afterTransfers(r + 1, p.cteParallel) * afterTransfers(c + 1, p.cteSerial);
/** Time to read a whole frame through one output at a pixel rate (s). */
export const ccdReadTime = (hz: number, p: Pick<SensorPart, 'cols' | 'rows'> = CCD42_40): number => (p.cols * p.rows) / hz;
/** Output amplifier voltage for a packet (V). */
export const outputVolts = (e: number, cgUv: number): number => e * cgUv * 1e-6;
/** Read noise at a pixel rate (e⁻ rms): 3 e⁻ at slow rates (the datasheet's low-noise figure), rising as the amplifier's
 *  bandwidth widens with the rate (√(1 + f / 300 kHz): illustrative, not a datasheet curve). */
export const ccdReadNoise = (hz: number): number => 3 * Math.sqrt(1 + hz / 3e5);

// ---- the 4T pixel and CDS ----

/** Pixel supply, reset level and source-follower parameters for the illustrative 4T pixel (V; SF gain is unitless). */
export const VDD_PIX = 2.8;
export const SF_GAIN = 0.85;
export const SF_VT = 0.55;
/** Floating-diffusion capacitance from the conversion gain: C = q / CG (fF). */
export const cfdFromCg = (cgUv: number): number => (Q_E / (cgUv * 1e-6)) * 1e15;
export const C_FD_FF = cfdFromCg(CG_4T);
/** kTC reset noise of the floating diffusion (e⁻ rms) at T: √(kTC) / q. CDS removes it, since both samples see the same
 *  reset. */
export const ktcNoise = (cFf: number, T = 300): number => Math.sqrt(K_B * T * cFf * 1e-15) / Q_E;

/** One row's readout of a 4T pixel: the phases in order, with the transistor gates' states and the floating diffusion
 *  (FD) and column voltages at the end of each. `offset` is this reset's kTC error (V), the same in both samples. */
export interface CdsPhase { name: 'RST' | 'SHR' | 'TX' | 'SHS'; rst: boolean; tx: boolean; sel: boolean; fd: number; col: number; sample?: 'reset' | 'signal'; note: string }
export function cdsSequence(e: number, opts: { cg?: number; offset?: number; fullWell?: number } = {}): { phases: CdsPhase[]; cds: number; cdsE: number } {
  const cg = opts.cg ?? CG_4T, off = opts.offset ?? 0, fw = opts.fullWell ?? IMX183.fullWell;
  const q = Math.min(e, fw);
  const col = (fd: number) => Math.max(0, SF_GAIN * (fd - SF_VT));
  const reset = VDD_PIX + off, signal = reset - outputVolts(q, cg);
  const phases: CdsPhase[] = [
    { name: 'RST', rst: true, tx: false, sel: true, fd: VDD_PIX, col: col(VDD_PIX), note: 'reset transistor on: FD pulled to the pixel supply' },
    { name: 'SHR', rst: false, tx: false, sel: true, fd: reset, col: col(reset), sample: 'reset', note: 'reset released (kTC noise frozen on FD); the column samples the reset level' },
    { name: 'TX', rst: false, tx: true, sel: true, fd: signal, col: col(signal), note: 'transfer gate on: the pinned photodiode empties its electrons onto FD, which drops' },
    { name: 'SHS', rst: false, tx: false, sel: true, fd: signal, col: col(signal), sample: 'signal', note: 'transfer gate off; the column samples the signal level' },
  ];
  const cds = col(reset) - col(signal);
  return { phases, cds, cdsE: cds / (SF_GAIN * cg * 1e-6) };
}

/** A single-slope ADC: a ramp from 0 to vFull over 2^bits counter clocks; the count when the comparator flips. */
export const singleSlope = (v: number, bits: number, vFull: number): number =>
  Math.max(0, Math.min(2 ** bits - 1, Math.floor((v / vFull) * 2 ** bits)));
/** Conversion time of a single-slope ADC (s) at a counter clock. */
export const singleSlopeTime = (bits: number, clockHz: number): number => 2 ** bits / clockHz;

// ---- shutters ----

/** Row time of a rolling-shutter sensor from its frame rate and rows (s), blanking ignored. IMX183: ≈ 12.3 µs. */
export const rowTime = (p: { fps: number; rows: number } = IMX183): number => 1 / (p.fps * p.rows);
/** When row r starts and stops exposing (s), for an exposure t: a rolling shutter starts each row tRow after the last,
 *  a global shutter exposes every row together. */
export function exposureWindow(r: number, t: number, kind: 'rolling' | 'global', tRow = rowTime()): [number, number] {
  const s = kind === 'rolling' ? r * tRow : 0;
  return [s, s + t];
}
export const rowStart = (r: number, tRow = rowTime()): number => r * tRow;
/** Sideways skew (pixels) of a vertical edge moving at v pixels/s across a rolling-shutter frame of `rows` rows. */
export const rollingSkew = (v: number, rows: number, tRow = rowTime()): number => v * rows * tRow;

// ---- colour ----

export type Cfa = 'R' | 'G' | 'B';
/** The Bayer RGGB mosaic: which filter sits on pixel (x, y). Half the pixels are green, the colour the eye resolves best. */
export const bayerAt = (x: number, y: number): Cfa => (y % 2 === 0 ? (x % 2 === 0 ? 'R' : 'G') : x % 2 === 0 ? 'G' : 'B');
/** An image (rgb triplets, 0…1, row-major) seen through the mosaic: one value per pixel. */
export function mosaic(rgb: Float32Array | number[], w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = bayerAt(x, y), i = y * w + x;
    out[i] = rgb[3 * i + (c === 'R' ? 0 : c === 'G' ? 1 : 2)];
  }
  return out;
}
/** Bilinear demosaic: each missing colour is the mean of the nearest pixels that have it (edges clamped). */
export function demosaic(raw: Float32Array | number[], w: number, h: number): Float32Array {
  const out = new Float32Array(w * h * 3);
  const at = (x: number, y: number) => raw[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  const cfa = (x: number, y: number) => bayerAt(Math.min(w - 1, Math.max(0, x)), Math.min(h - 1, Math.max(0, y)));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    for (const [k, c] of [[0, 'R'], [1, 'G'], [2, 'B']] as const) {
      let s = 0, n = 0;
      if (cfa(x, y) === c) { s = at(x, y); n = 1; } else {
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          if (cfa(x + dx, y + dy) !== c) continue;
          if (c === 'G' && dx && dy) continue; // green: the four edge neighbours only
          s += at(x + dx, y + dy); n++;
        }
      }
      out[3 * (y * w + x) + k] = n ? s / n : 0;
    }
  }
  return out;
}
