// An optical fibre cut away, as parts (DOM-free, tested). Every number is the chapter's (phys/fibre.ts, used by
// widgets/glass.ts and chapters/ch-comm-glass.ts): the indices, the critical angle, the guided / leaking decision (rayOf), the
// numerical aperture, V, and the modal delay n1 * delta / c per km (stepDelayPsKm). The fibre runs along x; the rays are
// meridional (in the x-y plane) and true to the angle: only the length is compressed (1 km drawn as 120 units).
//
// Scale: 1 unit = 12.5 um across, so the cladding (125 um) is radius 5, the acrylate coating (250 um) radius 10, a 50 um
// core radius 2 and the chapter's single-mode core (8 um: a = 4 um) radius 0.32. Diameters are in true ratio.

import type { RGB, RGBA } from '../gl/instances';
import type { Vec3 } from '../gl/math';
import { box, rod, type Anchor, type Part } from '../gl/parts';
import { acceptanceDeg, criticalDeg, gradedDelayPsKm, MMF_50, modesLarge, n2Of, naOf, rayOf, SMF_G652, stepDelayPsKm, vNumber, type Fibre } from '../phys/fibre';

export type Kind = 'multi' | 'single';
export const FIBRES: Record<Kind, Fibre> = { multi: MMF_50, single: SMF_G652 };
/** The wavelength each is shown at (the chapter's: 850 nm multimode, 1550 nm single-mode). */
export const WAVE_UM: Record<Kind, number> = { multi: 0.85, single: 1.55 };
/** Standard sizes: cladding and coating diameters (um), and G.652's mode-field diameter at 1550 nm (Corning SMF-28 data sheet: 10.4 um). */
export const CLAD_UM = 125, COAT_UM = 250, MFD_UM = 10.4;
export const UM = 12.5;
export const R_CLAD = CLAD_UM / 2 / UM, R_COAT = COAT_UM / 2 / UM;
export const coreR = (f: Fibre): number => f.aUm / UM;

/** The drawn stretch, standing for LENGTH_KM of fibre; the input end of the stretch and its far end. */
export const X0 = -60, X1 = 60, LENGTH_KM = 1;
/** The input pulse's width (sigma, ns): a probe chosen for the picture. */
export const SIGMA_NS = 2;
/** Packets lag by (stretch - 1) times this on screen, so a 1 % delay shows. */
export const LAG_X = 20;

export interface FibrePalette { glass: RGBA; coat: RGBA; core: RGB; coreEnd: RGB; ray: RGB; fan: RGB; leak: RGB; pulse: RGB; glow: RGBA; air: RGB; cut: RGB }
export interface FibreState { kind: Kind; deg: number; tau: number }

// ---------------------------------------------------------------- rays

export interface RayPath {
  /** Points (x, y) in the drawing, from the launch on the axis. */
  pts: [number, number][];
  guided: boolean;
  /** Angle to the axis in the core, and the angle of incidence on the wall (to the normal), degrees. */
  coreDeg: number; incidenceDeg: number;
  stretch: number;
  /** Where it first meets the wall, and for a leaking ray the angle to the axis in the cladding (degrees). */
  hitX: number; leaveDeg: number;
}

/** The ray launched from air at `deg`, travelling up from the axis at x0. A guided ray zigzags between y = +-r; a leaking one refracts into the cladding at its first hit (Snell's law, no partial reflection drawn). */
export function rayPath(deg: number, f: Fibre, x0 = X0, x1 = X1): RayPath {
  const n1 = f.n1, n2 = n2Of(f), r = coreR(f), g = rayOf(deg, n1, n2), th = (g.coreDeg * Math.PI) / 180, t = Math.tan(th);
  const base = { guided: g.guided, coreDeg: g.coreDeg, incidenceDeg: 90 - g.coreDeg, stretch: g.stretch };
  if (t < 1e-9) return { ...base, pts: [[x0, 0], [x1, 0]], hitX: Infinity, leaveDeg: 0 };
  const pts: [number, number][] = [[x0, 0]], half = r / t, hitX = x0 + half;
  if (g.guided) {
    for (let k = 0; ; k++) { const xw = x0 + half * (2 * k + 1); if (xw >= x1) break; pts.push([xw, (k % 2 === 0 ? 1 : -1) * r]); }
    pts.push([x1, triY(((x1 - x0) * t), r)]);
    return { ...base, pts, hitX, leaveDeg: 0 };
  }
  // refraction into the cladding: n1 sin(i) = n2 sin(t); the angle to the axis is 90 degrees - t
  const i = Math.PI / 2 - th, sinT = Math.min(1, (n1 / n2) * Math.sin(i)), leave = Math.PI / 2 - Math.asin(sinT), tl = Math.tan(leave);
  pts.push([hitX, r]);
  const xEnd = tl < 1e-9 ? x1 : Math.min(x1, hitX + (R_COAT - r) / tl);
  pts.push([xEnd, r + (xEnd - hitX) * tl]);
  return { ...base, pts, hitX, leaveDeg: (leave * 180) / Math.PI };
}

/** A zigzag of amplitude r after travelling s across: up to r, down to -r, back. */
const triY = (s: number, r: number): number => { const u = s % (4 * r); return u < r ? u : u < 3 * r ? 2 * r - u : u - 4 * r; };

/** y of the path at x (linear between its points; clamped to the last). */
export function pathY(pts: readonly [number, number][], x: number): number {
  if (x <= pts[0][0]) return pts[0][1];
  for (let k = 1; k < pts.length; k++) {
    if (x <= pts[k][0]) { const [xa, ya] = pts[k - 1], [xb, yb] = pts[k]; return xb === xa ? yb : ya + ((yb - ya) * (x - xa)) / (xb - xa); }
  }
  return pts[pts.length - 1][1];
}

/** The launch angles of the fan of guided rays (degrees in air): evenly spread over the acceptance cone, a hair inside its edge. */
export function fanAngles(f: Fibre, n: number): number[] {
  const acc = acceptanceDeg(naOf(f.n1, n2Of(f)));
  return Array.from({ length: n }, (_, k) => (n === 1 ? 0 : (k / (n - 1)) * 0.999 * acc));
}

// ---------------------------------------------------------------- the pulse

/** Extra time a ray takes over the axial one on `km` of fibre (ns): (stretch - 1) * n1 * L / c. */
export const rayDelayNs = (deg: number, f: Fibre, km = LENGTH_KM): number => ((rayOf(deg, f.n1, n2Of(f)).stretch - 1) * f.n1 * km * 1e12) / 299792.458 / 1000;

export interface PulseView {
  /** The fan's delays (ns), steepest last; the chapter's spread n1 * delta * L / c; and the largest delay in the fan. */
  delays: number[]; spreadNs: number; fanMaxNs: number;
  t: number[]; input: number[]; output: number[];
  rmsOutNs: number;
}

const gauss = (t: number, mu: number, sg: number) => Math.exp(-0.5 * ((t - mu) / sg) ** 2) / (sg * Math.sqrt(2 * Math.PI));

/** The input pulse (a Gaussian of SIGMA_NS) and what comes out: the sum of one copy per ray of the fan, each delayed by its path, equal energy. Single-mode: one mode, one delay (0). */
export function pulseView(kind: Kind, km = LENGTH_KM, nRays = 41, pts = 240): PulseView {
  const f = FIBRES[kind], delays = kind === 'single' ? [0] : fanAngles(f, nRays).map((d) => rayDelayNs(d, f, km));
  const spreadNs = kind === 'single' ? 0 : (stepDelayPsKm(f) * km) / 1000, fanMaxNs = Math.max(...delays);
  const tMax = Math.max(spreadNs, 1) + 6 * SIGMA_NS, tMin = -4 * SIGMA_NS;
  const t = Array.from({ length: pts }, (_, i) => tMin + ((tMax - tMin) * i) / (pts - 1));
  const input = t.map((x) => gauss(x, 0, SIGMA_NS)), output = t.map((x) => delays.reduce((s, d) => s + gauss(x, d, SIGMA_NS), 0) / delays.length);
  const mean = delays.reduce((s, d) => s + d, 0) / delays.length, vr = delays.reduce((s, d) => s + (d - mean) ** 2, 0) / delays.length;
  return { delays, spreadNs, fanMaxNs, t, input, output, rmsOutNs: Math.sqrt(SIGMA_NS ** 2 + vr) };
}

// ---------------------------------------------------------------- what the readout says

export interface FibreFacts {
  n1: number; n2: number; na: number; criticalDeg: number; acceptDeg: number; v: number; waveUm: number;
  /** modes: 1 (two polarizations) or V^2 / 2 */
  modes: number; singleMode: boolean;
  ray: RayPath; coupled: boolean;
  stepNsKm: number; gradedPsKm: number;
}
export function facts(kind: Kind, deg: number): FibreFacts {
  const f = FIBRES[kind], n2 = n2Of(f), na = naOf(f.n1, n2), v = vNumber(f.aUm, na, WAVE_UM[kind]), ray = rayPath(deg, f);
  return {
    n1: f.n1, n2, na, criticalDeg: criticalDeg(f.n1, n2), acceptDeg: acceptanceDeg(na), v, waveUm: WAVE_UM[kind], modes: v < 2.405 ? 1 : modesLarge(v), singleMode: v < 2.405,
    ray, coupled: ray.guided, stepNsKm: stepDelayPsKm(f) / 1000, gradedPsKm: gradedDelayPsKm(f),
  };
}

// ---------------------------------------------------------------- parts

const slab = (c: RGB | RGBA, x0: number, x1: number, r: number, spec = 0) => rod(c, [x0, 0, 0], [x1, 0, 0], r, spec);
const RAY_R = 0.07;

export const packetX = (frac: number, lagFactor: number): number => X0 + Math.min(1, Math.max(0, frac * lagFactor)) * (X1 - X0);
/** Progress at which the drawn packets of a ray with this stretch stand (exaggerated lag). */
export const lagFactor = (stretch: number): number => 1 - LAG_X * (stretch - 1);

export function fibreParts(st: FibreState, P: FibrePalette): Part[] {
  const f = FIBRES[st.kind], r = coreR(f), single = st.kind === 'single', out: Part[] = [];
  // the cut: the coating is stripped back at the input end, the cladding at the far end shows its layers as discs
  out.push(slab(P.coat, X0 + 25, X1, R_COAT), slab(P.glass, X0, X1, R_CLAD));
  out.push(slab(P.core, X0, X1, r, 0.3));
  // end face: coating ring, cladding disc, core disc (stacked a hair apart)
  out.push(slab(P.cut, X1, X1 + 0.1, R_COAT), slab(P.glass.slice(0, 3) as RGB, X1 + 0.1, X1 + 0.2, R_CLAD), slab(P.coreEnd, X1 + 0.2, X1 + 0.3, Math.max(r, 0.2)));
  // the launch: the beam in air at the chosen angle, meeting the end at the axis
  const a = (st.deg * Math.PI) / 180, lx = 14;
  out.push(rod(P.air, [X0 - lx, -Math.tan(a) * lx, 0], [X0, 0, 0], RAY_R * 1.4));
  const main = rayPath(st.deg, f);
  if (single && main.guided) {
    // one mode: the field fills the core and spills a little into the cladding (mode-field diameter), no zigzag
    const mr = (MFD_UM / 2) / UM;
    out.push(slab(P.glow, X0, X1, mr));
  } else {
    out.push(...main.pts.slice(1).map((p, k) => rod(main.guided ? P.ray : P.leak, [main.pts[k][0], main.pts[k][1], 0], [p[0], p[1], 0], RAY_R * (main.guided ? 1.6 : 1.4), 0.1)));
  }
  if (!single) for (const d of fanAngles(f, FAN)) {
    const p = rayPath(d, f);
    out.push(...p.pts.slice(1).map((q, k) => rod(P.fan, [p.pts[k][0], p.pts[k][1], -0.2], [q[0], q[1], -0.2], RAY_R)));
  }
  // packets
  const tau = st.tau;
  if (tau >= 0) {
    if (single) {
      if (main.guided) { const x = packetX(tau, 1); out.push(rod(P.pulse, [x - 1.6, 0, 0], [x + 1.6, 0, 0], 0.3, 0.2)); }
    } else {
      for (const d of fanAngles(f, FAN)) {
        const p = rayPath(d, f), x = packetX(tau, lagFactor(p.stretch));
        out.push(rod(P.pulse, [x - 0.7, pathY(p.pts, x), 0.2], [x + 0.7, pathY(p.pts, x), 0.2], 0.33, 0.2));
      }
    }
  }
  // two small ticks at the compressed length
  out.push(box(P.cut, X0 + 12, X0 + 12.2, -R_COAT - 0.4, -R_COAT + 0.4, -0.1, 0.1));
  return out;
}
export const FAN = 5;

export function fibreAnchors(st: FibreState): Anchor[] {
  const f = FIBRES[st.kind], r = coreR(f), up: Vec3 = [0, 1, 0], front: Vec3 = [0, 0.2, 1], right: Vec3 = [1, 0, 0];
  const main = rayPath(st.deg, f), out: Anchor[] = [
    { text: `coating ${COAT_UM * 1} µm`, p: [30, R_COAT, 0], side: 't', n: up },
    { text: `cladding ${CLAD_UM} µm`, p: [X0 + 8, -R_CLAD, 0], side: 'b', n: front },
    { text: `core ${f.aUm * 2} µm`, p: [X1 + 0.3, 0, 0], side: 'r', n: right },
    { text: `θ = ${st.deg}° in air`, p: [X0 - 8, -Math.tan((st.deg * Math.PI) / 180) * 8, 0], side: 'b', n: front, minor: true },
  ];
  if (st.kind === 'multi' || !main.guided) {
    const x = Math.min(main.hitX, X1 - 12);
    out.push({ text: main.guided ? 'total internal reflection' : 'leaks into the cladding', p: [x, main.guided ? r : r, 0], side: 't', n: up, minor: true });
  }
  return out;
}

/** The tau at which every packet has arrived: the slowest ray's progress rate is lagFactor(stretch of the fan's last). */
export function endTau(kind: Kind): number {
  if (kind === 'single') return 1.02;
  const f = FIBRES.multi, last = fanAngles(f, FAN)[FAN - 1];
  return 1 / lagFactor(rayPath(last, f).stretch) + 0.02;
}
