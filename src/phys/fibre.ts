// Optical fibre and what is sent over it, as lumped models (DOM-free; the "Light in glass" chapter). Nothing here is gates: the chapter says so. Closed forms, with their
// constants labelled, tested in tests/phys-fibre.test.ts against independent calculation: Snell's law, Bessel zeros, a Gaussian pulse propagated by FFT against its closed
// form, the 58 dB of the OSNR rule from h and c, a simulated coherent receiver against Q(√SNR).

import { fft, cx, type Cx } from '../comm/fourier';
import { dbToRatio, ratioToDb } from '../comm/limits';
import { gaussian, rng } from './line';

export const C_NM_PS = 299792.458;     // nm per ps
export const C_KM_S = 299792.458;
const H_PLANCK = 6.62607015e-34, C_M_S = 299792458;

// ---- loss ------------------------------------------------------------------------------------------------------------------
/** Rayleigh scattering: A / λ⁴, A = 0.75 dB/km·µm⁴ (silica, a labelled constant; good fibre is 0.7 to 0.9). */
export const RAYLEIGH_A = 0.75;
export const rayleighDb = (um: number): number => RAYLEIGH_A / um ** 4;
/** Infrared absorption by the Si-O bond: the published exponential fit 7.81 × 10¹¹ exp(−48.48 / λ) dB/km. */
export const infraredDb = (um: number): number => 7.81e11 * Math.exp(-48.48 / um);
/** The hydroxyl peak at 1383 nm of older fibre (height and width illustrative; "low water peak" fibre has almost none of it). */
export const waterDb = (um: number, peak = 0.35): number => peak * Math.exp(-(((um - 1.383) / 0.018) ** 2) / 2);
export const lossDb = (um: number, peak = 0.35): number => rayleighDb(um) + infraredDb(um) + waterDb(um, peak);
/** The wavelength of least loss, by search over a band. */
export function minLoss(from = 1.2, to = 1.8, peak = 0.35): { um: number; db: number } {
  let best = { um: from, db: lossDb(from, peak) };
  for (let u = from; u <= to; u += 0.0005) { const db = lossDb(u, peak); if (db < best.db) best = { um: u, db }; }
  return best;
}
export const WINDOWS = [{ name: 'First window', nm: 850 }, { name: 'O band', nm: 1310 }, { name: 'C band', nm: 1550 }];

// ---- a ray in a core --------------------------------------------------------------------------------------------------------
export interface Fibre { name: string; n1: number; delta: number; aUm: number }
/** Step-index shapes of the two common fibres. Δ and a are typical of the data sheets (G.652 single-mode, 50 µm multimode), n₁ of doped silica. */
export const SMF_G652: Fibre = { name: 'Single-mode', n1: 1.4504, delta: 0.0034, aUm: 4.0 };
export const MMF_50: Fibre = { name: 'Multimode', n1: 1.4640, delta: 0.01, aUm: 25 };
export const n2Of = (f: { n1: number; delta: number }): number => f.n1 * (1 - f.delta);
export const naOf = (n1: number, n2: number): number => Math.sqrt(n1 * n1 - n2 * n2);
/** Snell: the smallest angle to the wall's normal that stays in (degrees). */
export const criticalDeg = (n1: number, n2: number): number => (Math.asin(n2 / n1) * 180) / Math.PI;
/** The widest cone accepted from air (half angle, degrees). */
export const acceptanceDeg = (na: number): number => (Math.asin(Math.min(1, na)) * 180) / Math.PI;
/**
 * A ray launched from air at `deg` from the axis: its angle in the core and whether it stays in. Path stretch = 1 / cos(angle in the core): how much longer it goes than the axis.
 */
export function rayOf(deg: number, n1: number, n2: number): { coreDeg: number; guided: boolean; stretch: number } {
  const core = Math.asin(Math.sin((deg * Math.PI) / 180) / n1);
  const guided = Math.PI / 2 - core >= Math.asin(n2 / n1);
  return { coreDeg: (core * 180) / Math.PI, guided, stretch: 1 / Math.cos(core) };
}

// ---- modes -------------------------------------------------------------------------------------------------------------------
export const vNumber = (aUm: number, na: number, um: number): number => (2 * Math.PI * aUm * na) / um;
/** Below this wavelength a step-index core carries more than one mode (V = 2.405). */
export const cutoffUm = (aUm: number, na: number): number => (2 * Math.PI * aUm * na) / BESSEL_J0_ZERO;
export const BESSEL_J0_ZERO = 2.404826;
/** Bessel functions by their power series, enough for the small arguments here. */
export function besselJ(n: number, x: number): number {
  let term = (x / 2) ** n, sum = 0;
  for (let i = 1; i <= n; i++) term /= i;
  for (let k = 0; k < 40; k++) {
    sum += term;
    term *= -(x * x / 4) / ((k + 1) * (k + 1 + n));
  }
  return sum;
}
/** LP modes in order of cutoff V (zeros of J_(l−1)), each with its degeneracy: polarizations × orientations. */
export const LP_MODES: { name: string; cutoff: number; count: number }[] = [
  { name: 'LP01', cutoff: 0, count: 2 }, { name: 'LP11', cutoff: 2.4048, count: 4 }, { name: 'LP21', cutoff: 3.8317, count: 4 }, { name: 'LP02', cutoff: 3.8317, count: 2 },
  { name: 'LP31', cutoff: 5.1356, count: 4 }, { name: 'LP12', cutoff: 5.5201, count: 4 }, { name: 'LP41', cutoff: 6.3802, count: 4 }, { name: 'LP22', cutoff: 7.0156, count: 4 }, { name: 'LP03', cutoff: 7.0156, count: 2 }, { name: 'LP51', cutoff: 7.5883, count: 4 },
];
export const modesAt = (v: number): typeof LP_MODES => LP_MODES.filter((m) => m.cutoff < v);
/** Modes of a large core, polarizations counted: V² / 2. */
export const modesLarge = (v: number): number => (v * v) / 2;
/** Delay between the fastest and slowest ray of a step core (ps/km), and with the parabolic index that all multimode fibre now uses. */
export const stepDelayPsKm = (f: { n1: number; delta: number }): number => (f.n1 * f.delta * 1e12) / C_KM_S;
export const gradedDelayPsKm = (f: { n1: number; delta: number }): number => (f.n1 * f.delta * f.delta * 1e12) / (8 * C_KM_S);
/** Bandwidth × length of a delay spread of d ps/km treated as a Gaussian's FWHM: 0.44 / d (MHz·km). */
export const bandwidthMHzKm = (dPsKm: number): number => (0.44 / dPsKm) * 1e6;

// ---- chromatic dispersion -------------------------------------------------------------------------------------------------------
/** ITU-T G.652's fit: D(λ) = (S₀ / 4)(λ − λ₀⁴ / λ³) ps/(nm·km), λ₀ = 1310 nm, S₀ = 0.092 ps/(nm²·km). */
export const LAMBDA0 = 1310, S0 = 0.092;
export const dispersionD = (nm: number, l0 = LAMBDA0, s0 = S0): number => (s0 / 4) * (nm - l0 ** 4 / nm ** 3);
/** β₂ = −D λ² / (2π c): ps²/km. */
export const beta2Of = (d: number, nm: number): number => (-d * nm * nm) / (2 * Math.PI * C_NM_PS);
/** A transform-limited Gaussian's 1/e half-width T after L km: T₀ √(1 + (|β₂| L / T₀²)²). */
export const gaussianWidth = (t0: number, beta2: number, km: number): number => t0 * Math.sqrt(1 + ((Math.abs(beta2) * km) / (t0 * t0)) ** 2);
export const dispersionLength = (t0: number, beta2: number): number => (t0 * t0) / Math.abs(beta2);
/**
 * Distance a rate survives, on the standard rule that the pulse's rms width stays below a quarter of a bit (4 B σ ≤ 1): a clean laser (its width is the modulation's) and a wide
 * source of spectral width σλ.
 */
export const reachNarrowKm = (gbps: number, beta2: number): number => 1 / (16 * (gbps * 1e-3) ** 2 * Math.abs(beta2));
export const reachWideKm = (gbps: number, d: number, sigmaNm: number): number => 1 / (4 * gbps * 1e-3 * Math.abs(d) * sigmaNm);

/** Propagate a sampled field through β₂ L: all-pass, each frequency turned by its own phase. */
export function disperse(x: Cx, dtPs: number, b2L: number): Cx {
  const n = x.re.length, X = fft(x);
  for (let k = 0; k < n; k++) {
    const f = k < n / 2 ? k / (n * dtPs) : (k - n) / (n * dtPs), w = 2 * Math.PI * f, ph = (b2L * w * w) / 2;
    const c = Math.cos(ph), s = Math.sin(ph), re = X.re[k], im = X.im[k];
    X.re[k] = re * c - im * s; X.im[k] = re * s + im * c;
  }
  return fft(X, true);
}
/** The 1/e half-width of a sampled intensity, from its rms (a Gaussian's T = √2 σ of |A|²). */
export function rmsWidth(x: Cx, dtPs: number): number {
  let p = 0, m = 0, s = 0;
  const n = x.re.length;
  for (let i = 0; i < n; i++) { const e = x.re[i] ** 2 + x.im[i] ** 2; p += e; m += e * i; }
  m /= p;
  for (let i = 0; i < n; i++) { const e = x.re[i] ** 2 + x.im[i] ** 2; s += e * (i - m) ** 2; }
  return Math.SQRT2 * Math.sqrt(s / p) * dtPs;
}

// ---- wavelengths --------------------------------------------------------------------------------------------------------------
export const thzOf = (nm: number): number => C_NM_PS / nm;
export const nmOf = (thz: number): number => C_NM_PS / thz;
/** ITU-T G.694.1's fixed grid is anchored at 193.1 THz. */
export const ANCHOR_THZ = 193.1, C_BAND: [number, number] = [1530, 1565], L_BAND: [number, number] = [1565, 1625];
/** Points of the grid inside a band: anchor + k × spacing. */
export function gridChannels(ghz: number, band: [number, number] = C_BAND): number {
  const lo = thzOf(band[1]), hi = thzOf(band[0]), step = ghz / 1000;
  return Math.floor((hi - ANCHOR_THZ) / step) - Math.ceil((lo - ANCHOR_THZ) / step) + 1;
}
export const gridNm = (i: number, ghz: number): number => nmOf(ANCHOR_THZ + (i * ghz) / 1000);
/** Wavelength spacing of a frequency spacing at nm: Δλ = λ² Δf / c. */
export const spacingNm = (ghz: number, nm: number): number => (nm * nm * ghz * 1e-3) / C_NM_PS;

// ---- amplifiers ------------------------------------------------------------------------------------------------------------------
/** One photon's energy per second in the reference bandwidth (dBm): hν B. At 1550 nm in 12.5 GHz (0.1 nm), the −58 of the OSNR rule. */
export const photonFloorDbm = (nm: number, brefGHz = 12.5): number => 10 * Math.log10(((H_PLANCK * C_M_S) / (nm * 1e-9)) * brefGHz * 1e9 / 1e-3);
export const BREF_GHZ = 12.5;
/** OSNR at the end of a chain of equal spans: Pch − NF − span loss − 10 log N − hνB, in dB in 0.1 nm. */
export const osnrDb = (pDbm: number, nfDb: number, spanDb: number, spans: number, nm = 1550): number => pDbm - nfDb - spanDb - 10 * Math.log10(spans) - photonFloorDbm(nm);
/** The same by adding each amplifier's noise as powers, so a test can hold the rule to its derivation: G F hν B per amplifier, in both polarizations' terms as the rule counts them. */
export function osnrBySum(pDbm: number, nfDb: number, spanDb: number, spans: number, nm = 1550): number {
  const ase = dbToRatio(nfDb) * dbToRatio(spanDb) * dbToRatio(photonFloorDbm(nm));
  return pDbm - ratioToDb(ase * spans);
}
/** A dual-polarization signal's SNR per symbol from its OSNR: SNR = OSNR × Bref / Rs. */
export const snrFromOsnr = (osnr: number, gbd: number): number => osnr + ratioToDb(BREF_GHZ / gbd);

// ---- what the receiver needs --------------------------------------------------------------------------------------------------
export function qFn(x: number): number {
  // Abramowitz & Stegun 26.2.17: good to 7.5e-8 on x > 0, the only side used here
  if (x < 0) return 1 - qFn(-x);
  const t = 1 / (1 + 0.2316419 * x), z = Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);
  return z * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
}
export interface Qam { name: string; bitsPerPolSym: number; ber: (snr: number) => number }
/** Gray-coded BER against SNR per symbol. */
export const QAMS: Qam[] = [
  { name: 'QPSK', bitsPerPolSym: 2, ber: (s) => qFn(Math.sqrt(s)) },
  { name: '16-QAM', bitsPerPolSym: 4, ber: (s) => 0.75 * qFn(Math.sqrt(s / 5)) },
  { name: '64-QAM', bitsPerPolSym: 6, ber: (s) => (7 / 12) * qFn(Math.sqrt(s / 21)) },
];
/** A strong soft-decision FEC of about 25 % overhead (real coherent modems) corrects to this pre-FEC BER. A labelled constant. */
export const FEC_BER = 2e-2, FEC_RATE = 0.8;
export function requiredSnrDb(q: Qam, ber = FEC_BER): number {
  let lo = -5, hi = 35;
  for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (q.ber(dbToRatio(m)) > ber) lo = m; else hi = m; }
  return (lo + hi) / 2;
}

// ---- the Kerr limit ------------------------------------------------------------------------------------------------------------
/**
 * The Gaussian-noise model of nonlinear interference: per span, NLI power relative to the signal grows as P², so SNR = P / (N·A + N·η·P³) where A is one span's ASE in the
 * signal's band, and η the fibre's coefficient, illustrative (nonlinear noise alone leaves 33 dB after one span at 0 dBm). NLI adding linearly with N is the incoherent approximation: slightly optimistic. Optimum where NLI = ASE / 2.
 */
export const NLI_ETA = 10 ** (-33 / 10);
export const aseSpanMw = (nfDb: number, spanDb: number, gbd: number, nm = 1550): number => dbToRatio(nfDb + spanDb + photonFloorDbm(nm)) * (gbd / BREF_GHZ);
export function snrWithNli(pDbm: number, spans: number, nfDb: number, spanDb: number, gbd: number, eta = NLI_ETA): number {
  const p = dbToRatio(pDbm), a = aseSpanMw(nfDb, spanDb, gbd);
  return ratioToDb(p / (spans * a + spans * eta * p ** 3));
}
export function bestPower(spans: number, nfDb: number, spanDb: number, gbd: number, eta = NLI_ETA): { pDbm: number; snrDb: number } {
  const a = aseSpanMw(nfDb, spanDb, gbd), p = Math.cbrt(a / (2 * eta)), pDbm = ratioToDb(p);
  return { pDbm, snrDb: snrWithNli(pDbm, spans, nfDb, spanDb, gbd, eta) };
}
/** The longest chain of spans that still closes at the optimum launch power. */
export function maxSpans(reqDb: number, nfDb: number, spanDb: number, gbd: number, marginDb = 0): number {
  let n = 0;
  while (n < 5000 && bestPower(n + 1, nfDb, spanDb, gbd).snrDb >= reqDb + marginDb) n++;
  return n;
}
/** FIR length that undoes L km at 2 samples a symbol: 2π |β₂| L / T² (Savory's formula), T the sample time. */
export const cdTaps = (beta2: number, km: number, gbd: number): number => Math.ceil(2 * Math.PI * Math.abs(beta2) * km * (2 * gbd * 1e-3) ** 2);

// ---- a coherent receiver, simulated -----------------------------------------------------------------------------------------------
export interface CoherentOpts { symbols: number; gbd: number; km: number; beta2: number; snrDb: number; compensate: boolean; linewidthMHz: number; seed: number; track: boolean }
export interface CoherentResult { rx: [number, number][]; errors: number; bits: number; ber: number; theory: number; sent: [number, number][] }
const rrc = (f: number, rs: number, roll: number): number => {
  const a = Math.abs(f) / rs, lo = (1 - roll) / 2, hi = (1 + roll) / 2;
  if (a <= lo) return 1;
  if (a >= hi) return 0;
  return Math.sqrt(0.5 * (1 + Math.cos((Math.PI / roll) * (a - lo))));
};
/**
 * QPSK at 2 samples a symbol, root-raised-cosine, through β₂ L, with white noise, laser phase noise, and a receiver: matched filter, optional dispersion compensation in the
 * frequency domain, the Viterbi & Viterbi 4th-power carrier recovery over a sliding block. A single polarization, an already known clock: enough to see what each part buys.
 */
export function coherentLink(o: CoherentOpts): CoherentResult {
  let m = 16;
  while (2 ** m < o.symbols * 2) m++;
  const N = 2 ** m, ns = N / 2, dt = 1000 / (2 * o.gbd), rs = o.gbd / 1000, u = rng(o.seed), roll = 0.2;
  const sent: [number, number][] = Array.from({ length: ns }, () => [u() < 0.5 ? 1 : -1, u() < 0.5 ? 1 : -1]);
  const up = cx(new Float64Array(N), new Float64Array(N));
  sent.forEach(([a, b], i) => { up.re[2 * i] = a / Math.SQRT2; up.im[2 * i] = b / Math.SQRT2; });
  const freq = (k: number) => (k < N / 2 ? k / (N * dt) : (k - N) / (N * dt));
  const H = Float64Array.from({ length: N }, (_, k) => rrc(freq(k), rs, roll));
  const shape = (x: Cx): Cx => { const X = fft(x); for (let k = 0; k < N; k++) { X.re[k] *= H[k]; X.im[k] *= H[k]; } return fft(X, true); };
  let line = shape(up);
  // the pulse's gain and the noise a matched filter passes, measured rather than derived, so that "SNR" means what the closed form means
  const imp = cx(new Float64Array(N), new Float64Array(N));
  imp.re[0] = 1;
  const g = shape(shape(imp)).re[0];
  let energyH = 0;
  for (let k = 0; k < N; k++) energyH += H[k] * H[k];
  energyH /= N;
  const snr = dbToRatio(o.snrDb), sigma = Math.sqrt((g * g) / (snr * energyH) / 2);
  const b2L = o.beta2 * o.km;
  line = disperse(line, dt, b2L);
  const dphi = 2 * Math.PI * o.linewidthMHz * 1e6 * (dt * 1e-12);
  let phase = 0;
  for (let i = 0; i < N; i++) {
    phase += Math.sqrt(dphi) * gaussian(u);
    const c = Math.cos(phase), s = Math.sin(phase), re = line.re[i], im = line.im[i];
    line.re[i] = re * c - im * s + sigma * gaussian(u);
    line.im[i] = re * s + im * c + sigma * gaussian(u);
  }
  if (o.compensate) line = disperse(line, dt, -b2L);
  const z = shape(line);
  const rx: [number, number][] = [];
  for (let i = 0; i < ns; i++) rx.push([z.re[2 * i] / g, z.im[2 * i] / g]);
  // carrier recovery: the fourth power removes the QPSK data, a sliding average of it gives the phase (mod 90°, unwrapped along the way)
  if (o.track) {
    const W = 32, sum: [number, number][] = [];
    let sr = 0, si = 0;
    const p4 = rx.map(([a, b]) => { const r2 = a * a - b * b, i2 = 2 * a * b; return [r2 * r2 - i2 * i2, 2 * r2 * i2] as [number, number]; });
    for (let i = 0; i < ns; i++) {
      sr += p4[i][0]; si += p4[i][1];
      if (i >= 2 * W + 1) { sr -= p4[i - 2 * W - 1][0]; si -= p4[i - 2 * W - 1][1]; }
      sum.push([sr, si]);
    }
    let last = 0;
    for (let i = 0; i < ns; i++) {
      const k = Math.min(ns - 1, i + W);
      let th = (Math.atan2(sum[k][1], sum[k][0]) - Math.PI) / 4;
      th += (Math.round((last - th) / (Math.PI / 2)) * Math.PI) / 2;
      last = th;
      const c = Math.cos(-th), s = Math.sin(-th), [a, b] = rx[i];
      rx[i] = [a * c - b * s, a * s + b * c];
    }
    // the tracker cannot tell the four quadrants apart: real links use pilots or differential coding; here the first symbols stand in as pilots
    let br = 0, bi = 0;
    for (let i = 0; i < Math.min(64, ns); i++) { const [a, b] = rx[i], [x, y] = sent[i]; br += a * x + b * y; bi += b * x - a * y; }
    const q = Math.round(Math.atan2(bi, br) / (Math.PI / 2)) * (Math.PI / 2), c = Math.cos(-q), s = Math.sin(-q);
    for (let i = 0; i < ns; i++) { const [a, b] = rx[i]; rx[i] = [a * c - b * s, a * s + b * c]; }
  }
  let errors = 0;
  rx.forEach(([a, b], i) => { if ((a > 0 ? 1 : -1) !== sent[i][0]) errors++; if ((b > 0 ? 1 : -1) !== sent[i][1]) errors++; });
  return { rx, errors, bits: 2 * ns, ber: errors / (2 * ns), theory: qFn(Math.sqrt(snr)), sent };
}
