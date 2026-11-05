// Radio as lumped models (DOM-free; the "Radio" chapter). Nothing is gates: the chapter says so. Closed forms with their constants labelled, each held in tests/phys-radio.test.ts to something
// independent: the half-wave dipole's 2.15 dBi by numerical integration, Friis against the dB form, a Rayleigh channel simulated against its closed-form BER, level crossings against Clarke's formula.

import { qFunc } from './line';
import { dbToRatio, ratioToDb, shannon } from '../comm/limits';
import { cx, fft, type Cx } from '../comm/fourier';
import { gaussian, rng } from './line';

export const C_M_S = 299792458;
export const wavelengthM = (ghz: number): number => C_M_S / (ghz * 1e9);

// ---- antennas ---------------------------------------------------------------------------------------------------------------
/** A half-wave dipole's field against the angle from its axis, normalized to 1 broadside. */
export const dipoleField = (thetaRad: number): number => {
  const s = Math.sin(thetaRad);
  return Math.abs(s) < 1e-9 ? 0 : Math.cos((Math.PI / 2) * Math.cos(thetaRad)) / s;
};
/** Directivity by integrating power over the sphere: 1.64, 2.15 dBi. */
export function directivityOf(power: (thetaRad: number) => number, steps = 4000): number {
  let total = 0, peak = 0;
  for (let i = 0; i < steps; i++) {
    const t = ((i + 0.5) / steps) * Math.PI, p = power(t);
    total += p * Math.sin(t);
    if (p > peak) peak = p;
  }
  const mean = (total * (Math.PI / steps)) / 2;
  return peak / mean;
}
export const DIPOLE_DBI = 2.15;
/** An antenna's effective area from its gain: A = G λ² / (4π). */
export const apertureM2 = (gainDbi: number, ghz: number): number => (dbToRatio(gainDbi) * wavelengthM(ghz) ** 2) / (4 * Math.PI);
/** The plotted pattern's directivity: n half-wave dipoles in a line along their axis, spaced λ/2, steered (dBi). */
export const arrayDbi = (n: number, steerDeg: number): number => 10 * Math.log10(directivityOf((t) => {
  const el = n === 1 ? dipoleField(t) : arrayFactor(n, 0.5, steerDeg, (t * 180) / Math.PI - 90) * Math.abs(Math.sin(t));
  return el * el;
}));
/** A uniform linear array of n isotropic elements at d wavelengths, steered to `steerDeg` from broadside: field against the angle. */
export function arrayFactor(n: number, dWl: number, steerDeg: number, deg: number): number {
  const psi = 2 * Math.PI * dWl * (Math.sin((deg * Math.PI) / 180) - Math.sin((steerDeg * Math.PI) / 180));
  if (Math.abs(Math.sin(psi / 2)) < 1e-9) return 1;
  return Math.abs(Math.sin((n * psi) / 2) / (n * Math.sin(psi / 2)));
}

// ---- path loss ------------------------------------------------------------------------------------------------------------------
/** Free-space path loss between isotropic antennas, by the dB form every link budget uses (d in km, f in GHz). */
export const fsplDb = (km: number, ghz: number): number => 20 * Math.log10(km) + 20 * Math.log10(ghz) + 92.45;
/** Friis's formula itself: Pr / Pt = Gt Gr (λ / 4π d)². */
export const friisRatio = (m: number, ghz: number, gt = 1, gr = 1): number => gt * gr * (wavelengthM(ghz) / (4 * Math.PI * m)) ** 2;
/** Indoors and in cities: free space up to a reference distance, then an exponent n (2 in free space, 3 to 4 through buildings). */
export const logDistanceDb = (m: number, ghz: number, n: number, d0 = 1): number => fsplDb(d0 / 1000, ghz) + 10 * n * Math.log10(Math.max(m, d0) / d0);

// ---- noise and budget --------------------------------------------------------------------------------------------------------------
/** kT at 290 K: −174 dBm/Hz. */
export const noiseFloorDbm = (mhz: number, nfDb = 0): number => -173.98 + 10 * Math.log10(mhz * 1e6) + nfDb;
export const KT_DBM_HZ = 10 * Math.log10(1.380649e-23 * 290 / 1e-3);
export interface Budget { txDbm: number; gtDbi: number; grDbi: number; km: number; ghz: number; extraDb: number; mhz: number; nfDb: number }
export interface BudgetResult { eirp: number; path: number; rx: number; noise: number; snr: number; capacityMbps: number }
export function linkBudget(b: Budget): BudgetResult {
  const eirp = b.txDbm + b.gtDbi, path = fsplDb(b.km, b.ghz), rx = eirp - path - b.extraDb + b.grDbi, noise = noiseFloorDbm(b.mhz, b.nfDb), snr = rx - noise;
  return { eirp, path, rx, noise, snr, capacityMbps: shannon(b.mhz, dbToRatio(snr)) };
}
/** Capacity against bandwidth at fixed power: SNR falls as B grows, so C approaches the wideband limit P / (N₀ ln 2) rather than growing without end. */
export const widebandLimitMbps = (rxDbm: number, nfDb: number): number => dbToRatio(rxDbm - (-173.98 + nfDb)) * 1e-6 / Math.LN2;

// ---- mixing --------------------------------------------------------------------------------------------------------------------
/** The tones out of a real mixer: |f1 ± lo|. */
export const mixed = (f: number, lo: number): [number, number] => [Math.abs(f - lo), f + lo];
/** A superheterodyne's image: the other frequency that lands on the same IF. */
export const imageOf = (f: number, lo: number): number => 2 * lo - f;
/** A sampled multiplication's spectrum (magnitudes over the positive frequencies), for the explorer and for a test against mixed(). */
export function mixSpectrum(fIn: number[], lo: number, fs: number, n = 1024): number[] {
  const re = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / fs;
    let v = 0;
    for (const f of fIn) v += Math.cos(2 * Math.PI * f * t);
    re[i] = v * Math.cos(2 * Math.PI * lo * t);
  }
  const X = fft(cx(re, new Float64Array(n)));
  return Array.from({ length: n / 2 }, (_, k) => (2 * Math.hypot(X.re[k], X.im[k])) / n);
}

// ---- a software radio -----------------------------------------------------------------------------------------------------------
export interface SdrStation { offset: number; amp: number; seed: number }
export interface SdrResult { band: Float64Array; spectrum: number[]; bb: [number, number][]; sent: number[]; errors: number; bits: number; ber: number; decim: number }
/**
 * The ADC's view of a band: stations at their offsets, each BPSK at its symbol rate, as complex samples; then the receiver: multiply by an NCO, a moving-average decimator
 * (what a CIC is, built cheaply), a symbol-rate slicer. The sampling rate is sps × symbols per second × decim; offsets are in cycles per symbol.
 */
export function sdrReceive(stations: SdrStation[], tune: number, o: { symbols: number; decim: number; sps: number; snrDb: number; seed: number }): SdrResult {
  const { decim, sps, symbols } = o, os = decim * sps, n = symbols * os;
  const re = new Float64Array(n), im = new Float64Array(n), u = rng(o.seed);
  const datas = stations.map((st) => { const r = rng(st.seed); return Array.from({ length: symbols }, () => (r() < 0.5 ? 1 : -1)); });
  stations.forEach((st, j) => {
    for (let i = 0; i < n; i++) {
      const sym = datas[j][Math.floor(i / os)], ph = (2 * Math.PI * st.offset * i) / os;
      re[i] += st.amp * sym * Math.cos(ph); im[i] += st.amp * sym * Math.sin(ph);
    }
  });
  // SNR per symbol of a unit-amplitude station, after averaging os samples: the noise is white across the band and does not depend on what is tuned
  const tuned = stations.reduce((best, st) => (Math.abs(st.offset - tune) < Math.abs(best.offset - tune) ? st : best), stations[0]);
  const sigma = Math.sqrt(os) / Math.sqrt(2 * dbToRatio(o.snrDb));
  for (let i = 0; i < n; i++) { re[i] += sigma * gaussian(u); im[i] += sigma * gaussian(u); }
  const N = 2 ** Math.floor(Math.log2(n));
  const X = fft(cx(re.subarray(0, N), im.subarray(0, N)));
  const spectrum = Array.from({ length: N }, (_, k) => Math.hypot(X.re[(k + N / 2) % N], X.im[(k + N / 2) % N]) / N);
  const bb: [number, number][] = [];
  for (let s = 0; s < symbols; s++) {
    let a = 0, b = 0;
    for (let i = s * os; i < (s + 1) * os; i++) {
      const ph = (-2 * Math.PI * tune * i) / os, c = Math.cos(ph), d = Math.sin(ph);
      a += re[i] * c - im[i] * d; b += re[i] * d + im[i] * c;
    }
    bb.push([a / (os * tuned.amp), b / (os * tuned.amp)]);
  }
  const j = stations.indexOf(tuned), sent = datas[j];
  let errors = 0;
  bb.forEach(([a], i) => { if ((a > 0 ? 1 : -1) !== sent[i]) errors++; });
  return { band: re, spectrum, bb, sent, errors, bits: symbols, ber: errors / symbols, decim };
}
/** What a moving average of os samples passes at f cycles a symbol: the sinc that keeps other stations out. */
export const sincGain = (f: number): number => (Math.abs(f) < 1e-9 ? 1 : Math.abs(Math.sin(Math.PI * f) / (Math.PI * f)));

// ---- multipath ---------------------------------------------------------------------------------------------------------------------
export interface Ray { ns: number; amp: number; phase: number }
/** The channel's complex gain at a frequency offset from the carrier (MHz). */
export function channelAt(rays: readonly Ray[], mhz: number): { re: number; im: number } {
  let re = 0, im = 0;
  for (const r of rays) {
    const a = r.phase - 2 * Math.PI * mhz * 1e-3 * r.ns;
    re += r.amp * Math.cos(a); im += r.amp * Math.sin(a);
  }
  return { re, im };
}
/** RMS delay spread (ns), weighted by power. */
export function delaySpread(rays: readonly Ray[]): number {
  const p = rays.reduce((s, r) => s + r.amp * r.amp, 0), m = rays.reduce((s, r) => s + r.amp * r.amp * r.ns, 0) / p;
  return Math.sqrt(rays.reduce((s, r) => s + r.amp * r.amp * (r.ns - m) ** 2, 0) / p);
}
/** The usual rule: frequencies closer than 1 / (5 τ) fade together. */
export const coherenceMHz = (tauNs: number): number => 1e3 / (5 * tauNs);
/** Two equal rays: nulls every 1 / Δτ. */
export const notchSpacingMHz = (dNs: number): number => 1e3 / dNs;

// ---- fading ---------------------------------------------------------------------------------------------------------------------
export const dopplerHz = (kmh: number, ghz: number): number => ((kmh / 3.6) * ghz * 1e9) / C_M_S;
/** Clarke's model by a sum of sinusoids: the complex gain at time t, power 1, with a fixed set of arrival angles. Exact statistics as paths → many. */
export class Clarke {
  private rays: { w: number; ph: number }[];
  constructor(private fdHz: number, seed: number, paths = 64) {
    const u = rng(seed);
    this.rays = Array.from({ length: paths }, () => ({ w: 2 * Math.PI * fdHz * Math.cos(2 * Math.PI * u()), ph: 2 * Math.PI * u() }));
  }
  at(t: number): { re: number; im: number } {
    let re = 0, im = 0;
    for (const r of this.rays) { const a = r.w * t + r.ph; re += Math.cos(a); im += Math.sin(a); }
    const k = Math.sqrt(1 / this.rays.length);
    return { re: re * k, im: im * k };
  }
  /** Used by a test: the Doppler this generator was built with. */
  get fd(): number { return this.fdHz; }
}
/** How often the envelope crosses a level ρ (relative to rms) going down, per second: √(2π) f_d ρ e^(−ρ²). */
export const levelCrossing = (rho: number, fdHz: number): number => Math.sqrt(2 * Math.PI) * fdHz * rho * Math.exp(-rho * rho);
/** Mean time under that level: (e^(ρ²) − 1) / (ρ f_d √(2π)). */
export const fadeDuration = (rho: number, fdHz: number): number => (Math.exp(rho * rho) - 1) / (rho * fdHz * Math.sqrt(2 * Math.PI));
/** A common rule of thumb, the geometric mean of two definitions: 0.423 / f_d. Clarke's correlation J₀(2π f_d τ) is a half at 0.242 / f_d. */
export const coherenceTime = (fdHz: number): number => 0.423 / fdHz;

export const bpskAwgn = (snr: number): number => qFunc(Math.sqrt(2 * snr));
/** BPSK with coherent detection through flat Rayleigh fading, mean SNR γ: ½(1 − √(γ / (1 + γ))). */
export const bpskRayleigh = (snr: number): number => 0.5 * (1 - Math.sqrt(snr / (1 + snr)));
/** L branches combined by their strengths (MRC): the textbook closed form. */
export function bpskMrc(snr: number, L: number): number {
  const mu = Math.sqrt(snr / (1 + snr)), a = (1 - mu) / 2, b = (1 + mu) / 2;
  let sum = 0, c = 1;
  for (let k = 0; k < L; k++) { sum += c * b ** k; c = (c * (L + k)) / (k + 1); }
  return a ** L * sum;
}
/** Measured: BPSK through independent Rayleigh branches, combined, on seeded data. */
export function fadingTrial(snrDb: number, L: number, bits: number, seed: number): number {
  const u = rng(seed), snr = dbToRatio(snrDb), n0 = 1 / (2 * snr);
  let errors = 0;
  for (let i = 0; i < bits; i++) {
    let y = 0;
    for (let l = 0; l < L; l++) {
      const hr = gaussian(u) * Math.SQRT1_2, hi = gaussian(u) * Math.SQRT1_2;
      const nr = gaussian(u) * Math.sqrt(n0), ni = gaussian(u) * Math.sqrt(n0);
      y += hr * (hr + nr) + hi * (hi + ni);
    }
    if (y <= 0) errors++;
  }
  return errors / bits;
}
/** A fading margin: extra dB to hold outage at p under Rayleigh (Pr[|h|² < x] = 1 − e^(−x)). */
export const fadeMarginDb = (p: number): number => -ratioToDb(-Math.log(1 - p));
export type { Cx };
