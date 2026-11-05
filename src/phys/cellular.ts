// Cellular as models (DOM-free; the "Cellular" chapter). Nothing is gates, and nothing is a capture of a real network: the chapter says so. Closed forms with their constants labelled, each held in
// tests/phys-cellular.test.ts to a simulation or to something written out apart: co-channel SIR on a real hexagonal grid, the harmonic-number law of multi-user diversity, zero-forcing's Gamma law.

import { dbToRatio, ratioToDb } from '../comm/limits';
import { gaussian, rng } from './line';

// ---- cells and reuse --------------------------------------------------------------------------------------------------------------
/** The valid cluster sizes of a hexagonal grid: K = i² + ij + j². */
export const CLUSTERS = [1, 3, 4, 7, 9, 12, 13, 19, 21];
export const clusterOf = (i: number, j: number): number => i * i + i * j + j * j;
/** Reuse distance over cell radius: D / R = √(3K). */
export const reuseRatio = (k: number): number => Math.sqrt(3 * k);
/** The usual first estimate: six equidistant first-tier interferers, a user at the cell's edge: SIR = (D/R)ⁿ / 6. */
export const sirClosedDb = (k: number, n: number): number => ratioToDb(reuseRatio(k) ** n / 6);
export interface Cell { x: number; y: number; q: number; r: number; colour: number }
/** Hexagonal cell centres in axial coordinates, radius 1 (corner distance), out to `rings`. */
export function hexGrid(rings: number, k: number): Cell[] {
  const [a, b] = clusterShift(k), out: Cell[] = [], colours = new Map<string, number>();
  for (let q = -rings; q <= rings; q++) for (let r = Math.max(-rings, -q - rings); r <= Math.min(rings, -q + rings); r++) {
    out.push({ q, r, x: Math.sqrt(3) * (q + r / 2), y: 1.5 * r, colour: colourOf(q, r, a, b, colours) });
  }
  return out;
}
function clusterShift(k: number): [number, number] {
  for (let i = 0; i <= 6; i++) for (let j = 0; j <= i; j++) if (clusterOf(i, j) === k) return [i, j];
  throw new Error(`no cluster of ${k}`);
}
/** A cell's channel set: cells that differ by a step of the lattice (i, j), (−j, i + j) share a colour. Reduce (q, r) to its representative in that lattice's fundamental cell. */
function colourOf(q: number, r: number, i: number, j: number, colours: Map<string, number>): number {
  const k = clusterOf(i, j), a = Math.floor((q * (i + j) + r * j) / k), b = Math.floor((r * i - q * j) / k);
  const key = `${q - a * i + b * j},${r - a * j - b * (i + j)}`;
  let c = colours.get(key);
  if (c === undefined) colours.set(key, (c = colours.size));
  return c;
}
/** Downlink SIR at a point in the serving cell, all co-channel cells transmitting at equal power with exponent n. */
export function sirAt(cells: readonly Cell[], x: number, y: number, n: number): { sir: number; serving: Cell } {
  let serving = cells[0], best = Infinity;
  for (const c of cells) { const d = Math.hypot(x - c.x, y - c.y); if (d < best) { best = d; serving = c; } }
  let inter = 0;
  for (const c of cells) if (c !== serving && c.colour === serving.colour) inter += Math.max(Math.hypot(x - c.x, y - c.y), 1e-3) ** -n;
  return { sir: Math.max(best, 1e-3) ** -n / inter, serving };
}
/** Mean rate per cell's user at that SIR, by Shannon, and the spectral efficiency once the band is shared among K. */
export function reuseSweep(k: number, n: number, samples = 2000, seed = 1): { sirDb: number[]; edgeDb: number; medianDb: number; perCell: number } {
  const cells = hexGrid(6, k), centre = cells.find((c) => c.q === 0 && c.r === 0)!, u = rng(seed), sirDb: number[] = [];
  let sum = 0;
  while (sirDb.length < samples) {
    const x = centre.x + (u() * 2 - 1), y = centre.y + (u() * 2 - 1);
    const s = sirAt(cells, x, y, n);
    if (s.serving !== centre) continue;
    sirDb.push(ratioToDb(s.sir));
    sum += Math.log2(1 + s.sir);
  }
  sirDb.sort((a, b) => a - b);
  return { sirDb, edgeDb: sirDb[Math.floor(samples * 0.05)], medianDb: sirDb[Math.floor(samples / 2)], perCell: sum / samples / k };
}

// ---- the resource grid -------------------------------------------------------------------------------------------------------------
export const SC_KHZ = 15, RB_SC = 12, SYMBOLS_PER_MS = 14;
/** LTE's channels: bandwidth MHz → resource blocks. */
export const LTE_RBS: [number, number][] = [[1.4, 6], [3, 15], [5, 25], [10, 50], [15, 75], [20, 100]];
export const rbKhz = (mu = 0): number => RB_SC * SC_KHZ * 2 ** mu;
/** Resource elements a millisecond for a channel of `rbs` blocks. */
export const elementsPerMs = (rbs: number, mu = 0): number => rbs * RB_SC * SYMBOLS_PER_MS * 2 ** mu;
/** Rate with bits per element and an overhead fraction (control, reference signals). */
export const gridMbps = (rbs: number, bitsPerRe: number, overhead = 0.25, mu = 0, layers = 1): number => (elementsPerMs(rbs, mu) * bitsPerRe * (1 - overhead) * layers) / 1000;
/** 5G numerology: 15 × 2^µ kHz subcarriers, slots of 1 / 2^µ ms. */
export const slotMs = (mu: number): number => 1 / 2 ** mu;
export const cpUs = (mu: number): number => 4.69 / 2 ** mu;

// ---- schedulers --------------------------------------------------------------------------------------------------------------------
export type Policy = 'rr' | 'max' | 'pf';
export interface SchedResult { perUser: number[]; total: number; jain: number; served: number[] }
/** n users on independent block-fading Rayleigh channels of mean SNRs (per slot a fresh draw), one served a slot, by Shannon's rate. */
export function schedule(policy: Policy, meanDb: number[], slots: number, seed: number, tc = 100): SchedResult {
  const n = meanDb.length, u = rng(seed), mean = meanDb.map(dbToRatio), avg = Array<number>(n).fill(1e-3), rates = Array<number>(n).fill(0), served = Array<number>(n).fill(0);
  for (let t = 0; t < slots; t++) {
    const inst = mean.map((m) => { const a = gaussian(u) * Math.SQRT1_2, b = gaussian(u) * Math.SQRT1_2; return Math.log2(1 + m * (a * a + b * b)); });
    let pick = 0;
    if (policy === 'rr') pick = t % n;
    else if (policy === 'max') inst.forEach((v, i) => { if (v > inst[pick]) pick = i; });
    else inst.forEach((v, i) => { if (v / avg[i] > inst[pick] / avg[pick]) pick = i; });
    rates[pick] += inst[pick]; served[pick]++;
    avg.forEach((_, i) => { avg[i] = (1 - 1 / tc) * avg[i] + (i === pick ? inst[pick] / tc : 0); });
  }
  const perUser = rates.map((r) => r / slots), total = perUser.reduce((a, b) => a + b, 0), sq = perUser.reduce((a, b) => a + b * b, 0);
  return { perUser, total, jain: (total * total) / (n * sq), served };
}
/** E[max of n unit-mean exponentials] = H_n. Multi-user diversity: the best of n Rayleigh users has this much more SNR on average. */
export const harmonic = (n: number): number => { let s = 0; for (let i = 1; i <= n; i++) s += 1 / i; return s; };

// ---- handover ---------------------------------------------------------------------------------------------------------------------
export interface HoOpts { sites: number[]; speedMs: number; n: number; shadowDb: number; corrM: number; hystDb: number; tttMs: number; seed: number; lengthM: number; refDbm: number }
export interface HoResult { rsrp: number[][]; serving: number[]; events: { m: number; to: number }[]; pingPongs: number; outageM: number }
/** A user driving along a line past base stations: each one's level by log-distance + shadowing correlated over a distance (one filter per site); a handover when a neighbour is hystDb better for tttMs. */
export function handover(o: HoOpts, stepM = 5): HoResult {
  const u = rng(o.seed), a = Math.exp(-stepM / o.corrM), b = Math.sqrt(1 - a * a), sh = o.sites.map(() => gaussian(u) * o.shadowDb), rsrp: number[][] = o.sites.map(() => []), serving: number[] = [];
  let cur = 0, cand = -1, since = 0, pingPongs = 0, outage = 0;
  const events: { m: number; to: number }[] = [];
  const tttM = (o.tttMs / 1000) * o.speedMs;
  for (let m = 0; m <= o.lengthM; m += stepM) {
    const lv = o.sites.map((s, i) => {
      sh[i] = a * sh[i] + b * gaussian(u) * o.shadowDb;
      return o.refDbm - 10 * o.n * Math.log10(Math.max(1, Math.abs(m - s))) + sh[i];
    });
    lv.forEach((v, i) => rsrp[i].push(v));
    let best = -1;
    lv.forEach((v, i) => { if (i !== cur && v > lv[cur] + o.hystDb && (best < 0 || v > lv[best])) best = i; });
    if (best !== cand) { cand = best; since = 0; } else if (cand >= 0) since += stepM;
    if (cand >= 0 && since >= tttM) {
      const last = events[events.length - 1];
      if (last && m - last.m < 200 && events.length >= 2 && events[events.length - 2].to === cand) pingPongs++;
      events.push({ m, to: cand });
      cur = cand; cand = -1; since = 0;
    }
    if (lv[cur] < -110) outage += stepM;
    serving.push(cur);
  }
  return { rsrp, serving, events, pingPongs, outageM: outage };
}
/** Where two equal sites' lines cross with a bias of h dB in favour of the far one: d solving 10 n log(d₁ / d₂) = h. */
export function crossingM(gap: number, n: number, hystDb: number): number {
  const r = 10 ** (hystDb / (10 * n));
  return (gap * r) / (1 + r);
}

// ---- many antennas ----------------------------------------------------------------------------------------------------------------
export type C = [number, number];
const cmul = (a: C, b: C): C => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
const conj = (a: C): C => [a[0], -a[1]];
const cdiv = (a: C, b: C): C => { const d = b[0] * b[0] + b[1] * b[1]; return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d]; };
/** h[k][m]: K users, M antennas, unit-variance complex Gaussian. */
export function channelMatrix(K: number, M: number, u: () => number): C[][] {
  return Array.from({ length: K }, () => Array.from({ length: M }, () => [gaussian(u) * Math.SQRT1_2, gaussian(u) * Math.SQRT1_2] as C));
}
/** The K × K Gram matrix H Hᴴ, and the diagonal of its inverse by Gauss-Jordan. */
export function gramInverseDiag(h: C[][]): number[] {
  const K = h.length, M = h[0].length, g: C[][] = Array.from({ length: K }, (_, a) => Array.from({ length: 2 * K }, (_, b) => {
    if (b >= K) return (b - K === a ? [1, 0] : [0, 0]) as C;
    let s: C = [0, 0];
    for (let m = 0; m < M; m++) { const x = cmul(h[a][m], conj(h[b][m])); s = [s[0] + x[0], s[1] + x[1]]; }
    return s;
  }));
  for (let c = 0; c < K; c++) {
    let p = c;
    for (let r = c + 1; r < K; r++) if (Math.hypot(...g[r][c]) > Math.hypot(...g[p][c])) p = r;
    [g[c], g[p]] = [g[p], g[c]];
    const piv = g[c][c];
    for (let j = 0; j < 2 * K; j++) g[c][j] = cdiv(g[c][j], piv);
    for (let r = 0; r < K; r++) if (r !== c) {
      const f = g[r][c];
      for (let j = 0; j < 2 * K; j++) { const x = cmul(f, g[c][j]); g[r][j] = [g[r][j][0] - x[0], g[r][j][1] - x[1]]; }
    }
  }
  return g.map((row, i) => row[K + i][0]);
}
/** Zero-forcing downlink with power shared equally among K streams, total SNR ρ: each user's SNR = ρ / (K [(H Hᴴ)⁻¹]ₖₖ). */
export function zfRates(K: number, M: number, rhoDb: number, draws: number, seed: number): { sumRate: number; meanSnr: number } {
  const u = rng(seed), rho = dbToRatio(rhoDb);
  let rate = 0, snr = 0;
  for (let d = 0; d < draws; d++) {
    const inv = gramInverseDiag(channelMatrix(K, M, u));
    for (const x of inv) { const g = rho / (K * x); rate += Math.log2(1 + g); snr += g; }
  }
  return { sumRate: rate / draws, meanSnr: snr / (draws * K) };
}
/** The closed form: each stream's SNR under ZF is ρ / K × a Gamma(M − K + 1): the mean is ρ (M − K + 1) / K. */
export const zfMeanSnr = (K: number, M: number, rhoDb: number): number => (dbToRatio(rhoDb) * (M - K + 1)) / K;
/** As M grows two users' channels turn orthogonal: the mean |hᴴ h'| / M falls as √(π) / (2 √M). */
export function channelOverlap(M: number, draws: number, seed: number): number {
  const u = rng(seed);
  let s = 0;
  for (let d = 0; d < draws; d++) {
    const h = channelMatrix(2, M, u);
    let re = 0, im = 0;
    for (let m = 0; m < M; m++) { const x = cmul(h[0][m], conj(h[1][m])); re += x[0]; im += x[1]; }
    s += Math.hypot(re, im) / M;
  }
  return s / draws;
}
/** A path at frequency f reaches how far on a budget, antennas counted: 20 log d = budget + array gains − 20 log f − 92.45. */
export const reachKm = (budgetDb: number, ghz: number, nExtraDb = 0): number => 10 ** ((budgetDb + nExtraDb - 92.45 - 20 * Math.log10(ghz)) / 20);
