// An optical fibre cut away, as parts (DOM-free, tested). Every number is the chapter's (phys/fibre.ts, used by
// widgets/glass.ts and chapters/ch-comm-glass.ts): the indices, the critical angle, the guided / leaking decision (rayOf), the
// numerical aperture, V, and the modal delay n1 * delta / c per km (stepDelayPsKm). The fibre runs along x; the rays are
// meridional (in the x-y plane) and true to the angle. The drawing is NOT a compressed kilometre: at 12.5 um per unit the
// drawn stretch (80 units) is 1 mm of real fibre, with true ray geometry; the packets' delays and the pulse plot are for 1 km.
//
// Two index profiles for the 50 um fibre: step (rays zigzag, delay n1 * delta / c) and graded, the profile every 50/125 fibre
// in use has (ITU-T G.651.1; rays are sinusoids and the spread falls to n1 * delta^2 / 8c, gradedDelayPsKm).
//
// Scale: 1 unit = 12.5 um across, so the cladding (125 um) is radius 5, the acrylate coating (250 um) radius 10, a 50 um
// core radius 2 and the chapter's single-mode core (8 um: a = 4 um) radius 0.32. Diameters are in true ratio.

import type { RGB, RGBA } from '../gl/instances';
import type { Vec3 } from '../gl/math';
import { rod, type Anchor, type Part } from '../gl/parts';
import { acceptanceDeg, C_KM_S, criticalDeg, gradedDelayPsKm, MMF_50, modesLarge, n2Of, naOf, rayOf, SMF_G652, stepDelayPsKm, vNumber, type Fibre } from '../phys/fibre';

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
export const X0 = -40, X1 = 40, LENGTH_KM = 1;
/** The input pulse's width (sigma, ns): a probe chosen for the picture. */
export const SIGMA_NS = 2;
/** Packets lag by (stretch - 1) times this on screen, so a 1 % delay shows. */
export const LAG_X = 20;

export interface FibrePalette { glass: RGBA; coat: RGBA; core: RGB; coreEnd: RGB; ray: RGB; fan: RGB; leak: RGB; pulse: RGB; glow: RGBA; air: RGB; cut: RGB }
export type Profile = 'step' | 'graded';
export interface FibreState {
  kind: Kind; deg: number; tau: number;
  /** Index profile of the multimode core (the single-mode fibre is drawn as a field, not rays). Absent: graded. */
  profile?: Profile;
  /** Camera is close on the input end: labels all minor. */
  look?: boolean;
  /** Draw the acceptance cone in air at the input. Absent: on. */
  cone?: boolean;
}
export const profileOf = (st: { kind: Kind; profile?: Profile }): Profile => (st.kind === 'single' ? 'step' : st.profile ?? 'graded');

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

/**
 * The same ray in a graded core, n(r)^2 = n1^2 - NA^2 (r/a)^2 (the parabolic profile, alpha = 2): the invariant beta = n1 cos(theta0) fixes the
 * turning radius rho_max = sin(launch) / NA (in core radii) and r(x) = rho_max a sin(k x) with k = NA / (beta a), exactly sinusoidal. A ray
 * that would turn beyond the core edge reaches it and leaves at cos(theta) = beta / n2 (Snell's invariant), straight on through the cladding.
 */
export function rayPathGraded(deg: number, f: Fibre, x0 = X0, x1 = X1, dx = 4): RayPath {
  const n1 = f.n1, n2 = n2Of(f), r = coreR(f), na = naOf(n1, n2), g = rayOf(deg, n1, n2), th = (g.coreDeg * Math.PI) / 180;
  const base = { guided: g.guided, coreDeg: g.coreDeg, incidenceDeg: NaN, stretch: g.stretch };
  if (th < 1e-9) return { ...base, pts: [[x0, 0], [x1, 0]], hitX: Infinity, leaveDeg: 0 };
  const beta = n1 * Math.cos(th), k = na / (beta * r), amp = r * (Math.sin((deg * Math.PI) / 180) / na);
  const pts: [number, number][] = [];
  if (g.guided) {
    for (let x = x0; x < x1; x += dx) pts.push([x, amp * Math.sin(k * (x - x0))]);
    pts.push([x1, amp * Math.sin(k * (x1 - x0))]);
    return { ...base, pts, hitX: Infinity, leaveDeg: 0 };
  }
  const hitX = x0 + Math.asin(Math.min(1, r / amp)) / k;
  for (let x = x0; x < Math.min(hitX, x1); x += dx) pts.push([x, amp * Math.sin(k * (x - x0))]);
  pts.push([hitX, r]);
  const lv = Math.acos(Math.min(1, beta / n2)), tl = Math.tan(lv), xEnd = tl < 1e-9 ? x1 : Math.min(x1, hitX + (R_COAT - r) / tl);
  pts.push([xEnd, r + (xEnd - hitX) * tl]);
  return { ...base, pts, hitX, leaveDeg: (lv * 180) / Math.PI };
}
/** The ray of this profile. */
export const rayOfProfile = (p: Profile, deg: number, f: Fibre): RayPath => (p === 'graded' ? rayPathGraded(deg, f) : rayPath(deg, f));

/** Where a graded ray turns back, as a fraction of the core radius (sin(launch) / NA; 1 at the edge of the acceptance cone). */
export const turnFraction = (deg: number, f: Fibre): number => Math.sin((deg * Math.PI) / 180) / naOf(f.n1, n2Of(f));

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

/**
 * Extra time of a ray in a graded core over the axial one on `km` (ns). The extreme ray (turning at the core edge) lags by the chapter's
 * gradedDelayPsKm (n1 delta^2 / 8c: the profile tuned to alpha = 2 - 2 delta); the shape between is the ray theory's, delay ~ theta0^4 ~ rho_max^4
 * (from T/L = (n1/c)(1 + cos^2 theta0) / (2 cos theta0) for the parabolic-n^2 profile).
 */
export const rayDelayGradedNs = (deg: number, f: Fibre, km = LENGTH_KM): number => ((gradedDelayPsKm(f) * km) / 1000) * Math.min(1, turnFraction(deg, f)) ** 4;
/** The delay of a ray of this profile. */
export const rayDelayOf = (p: Profile, deg: number, f: Fibre, km = LENGTH_KM): number => (p === 'graded' ? rayDelayGradedNs(deg, f, km) : rayDelayNs(deg, f, km));

export interface PulseView {
  /** The fan's delays (ns), steepest last; the chapter's spread n1 * delta * L / c; and the largest delay in the fan. */
  delays: number[]; spreadNs: number; fanMaxNs: number;
  t: number[]; input: number[]; output: number[];
  rmsOutNs: number;
}

const gauss = (t: number, mu: number, sg: number) => Math.exp(-0.5 * ((t - mu) / sg) ** 2) / (sg * Math.sqrt(2 * Math.PI));

/** The input pulse (a Gaussian of SIGMA_NS) and what comes out: the sum of one copy per ray of the fan, each delayed by its path, equal energy. Single-mode: one mode, one delay (0). */
export function pulseView(kind: Kind, km = LENGTH_KM, nRays = 41, pts = 240, profile: Profile = 'step'): PulseView {
  const f = FIBRES[kind], delays = kind === 'single' ? [0] : fanAngles(f, nRays).map((d) => rayDelayOf(profile, d, f, km));
  const spreadNs = kind === 'single' ? 0 : ((profile === 'graded' ? gradedDelayPsKm(f) : stepDelayPsKm(f)) * km) / 1000, fanMaxNs = Math.max(...delays);
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
  profile: Profile; turn: number;
  /** Share of a Gaussian mode (1/e^2 radius w = MFD / 2) outside the core radius: exp(-2 a^2 / w^2). */
  outsideCore: number;
}
export function facts(kind: Kind, deg: number, profile: Profile = kind === 'single' ? 'step' : 'graded'): FibreFacts {
  const f = FIBRES[kind], n2 = n2Of(f), na = naOf(f.n1, n2), v = vNumber(f.aUm, na, WAVE_UM[kind]), ray = rayOfProfile(profile, deg, f);
  // a step core carries about V^2/2 modes, a parabolic one about half that (V^2/4)
  const modes = v < 2.405 ? 1 : modesLarge(v) / (profile === 'graded' ? 2 : 1), w = MFD_UM / 2;
  return {
    n1: f.n1, n2, na, criticalDeg: criticalDeg(f.n1, n2), acceptDeg: acceptanceDeg(na), v, waveUm: WAVE_UM[kind], modes, singleMode: v < 2.405,
    ray, coupled: ray.guided, stepNsKm: stepDelayPsKm(f) / 1000, gradedPsKm: gradedDelayPsKm(f), profile, turn: turnFraction(deg, f),
    outsideCore: Math.exp((-2 * f.aUm * f.aUm) / (w * w)),
  };
}

// ---------------------------------------------------------------- parts

const slab = (c: RGB | RGBA, x0: number, x1: number, r: number, spec = 0) => rod(c, [x0, 0, 0], [x1, 0, 0], r, spec);
const RAY_R = 0.13;
const lit = (p: Part, c: RGB): Part => ({ ...p, emissive: c });

export const packetX = (frac: number, lagFactor: number): number => X0 + Math.min(1, Math.max(0, frac * lagFactor)) * (X1 - X0);
/** Progress at which the drawn packets of a ray with this stretch stand (exaggerated lag). */
export const lagFactor = (stretch: number): number => 1 - LAG_X * (stretch - 1);
/** The same for a graded core: the equivalent (stretch - 1) is the ray's delay over n1 L / c, about delta^2 / 8 for the extreme ray: the packets stay together. */
export const lagFactorGraded = (deg: number, f: Fibre): number => 1 - LAG_X * (gradedDelayPsKm(f) / ((f.n1 * 1e12) / C_KM_S)) * Math.min(1, turnFraction(deg, f)) ** 4;
const lagOf = (p: Profile, deg: number, f: Fibre): number => (p === 'graded' ? lagFactorGraded(deg, f) : lagFactor(rayPath(deg, f).stretch));

export function fibreParts(st: FibreState, P: FibrePalette): Part[] {
  const f = FIBRES[st.kind], r = coreR(f), single = st.kind === 'single', prof = profileOf(st), out: Part[] = [];
  // the cut: the coating is stripped back at the input end, the cladding at the far end shows its layers as discs
  out.push(slab(P.coat, X0 + 14, X1, R_COAT), slab(P.glass, X0, X1, R_CLAD));
  out.push(slab([...P.core, 0.4] as RGBA, X0, X1, r, 0.3));
  // end face: coating ring, cladding disc, core disc (stacked a hair apart)
  out.push(slab(P.cut, X1, X1 + 0.1, R_COAT), slab(P.glass.slice(0, 3) as RGB, X1 + 0.1, X1 + 0.2, R_CLAD), slab(P.coreEnd, X1 + 0.2, X1 + 0.3, Math.max(r, 0.2)));
  // the launch: the beam in air at the chosen angle, meeting the end at the axis
  const a = (st.deg * Math.PI) / 180, lx = 8;
  out.push(rod(P.air, [X0 - lx, -Math.tan(a) * lx, 0], [X0, 0, 0], RAY_R * 1.4));
  // the acceptance cone in air: every launch inside it is guided
  if (st.cone !== false) {
    const acc = (acceptanceDeg(naOf(f.n1, n2Of(f))) * Math.PI) / 180;
    for (let k = 0; k < 8; k++) {
      const ph = (k * Math.PI) / 4;
      out.push(rod([...P.air, 0.35] as RGBA, [X0, 0, 0], [X0 - lx, Math.tan(acc) * lx * Math.cos(ph), Math.tan(acc) * lx * Math.sin(ph)], 0.05));
    }
  }
  const main = rayOfProfile(prof, st.deg, f);
  if (single && main.guided) {
    // one mode: a Gaussian field (1/e^2 radius w = MFD / 2): nested shells at 0.5 w, w and 1.5 w with falling density
    const w = MFD_UM / 2 / UM;
    for (const [k, al] of [[1.5, 0.16], [1, 0.3], [0.5, 0.5]] as const) out.push(slab([P.glow[0], P.glow[1], P.glow[2], al] as RGBA, X0, X1, w * k));
  } else {
    out.push(...main.pts.slice(1).map((p, k) => lit(rod(main.guided ? P.ray : P.leak, [main.pts[k][0], main.pts[k][1], 0], [p[0], p[1], 0], RAY_R * 1.5, 0.1), main.guided ? P.ray : P.leak)));
  }
  if (!single) for (const d of fanAngles(f, FAN)) {
    const p = rayOfProfile(prof, d, f);
    out.push(...p.pts.slice(1).map((q, k) => rod(P.fan, [p.pts[k][0], p.pts[k][1], -0.2], [q[0], q[1], -0.2], RAY_R)));
  }
  // packets
  const tau = st.tau;
  if (tau >= 0) {
    if (single) {
      if (main.guided) { const x = packetX(tau, 1); out.push(rod(P.pulse, [x - 1.6, 0, 0], [x + 1.6, 0, 0], 0.3, 0.2)); }
    } else {
      for (const d of fanAngles(f, FAN)) {
        const p = rayOfProfile(prof, d, f), x = packetX(tau, lagOf(prof, d, f));
        out.push(lit(rod(P.pulse, [x - 0.7, pathY(p.pts, x), 0.2], [x + 0.7, pathY(p.pts, x), 0.2], 0.5, 0.2), P.pulse));
      }
    }
  }
  return out;
}
export const FAN = 5;

export function fibreAnchors(st: FibreState): Anchor[] {
  const f = FIBRES[st.kind], r = coreR(f), up: Vec3 = [0, 1, 0], front: Vec3 = [0, 0.2, 1], prof = profileOf(st), mn = st.look === true;
  const main = rayOfProfile(prof, st.deg, f), out: Anchor[] = [
    { text: `coating ${COAT_UM * 1} µm`, p: [X0 + 30, R_COAT, 0], side: 't', n: up, minor: mn },
    { text: `cladding ${CLAD_UM} µm`, p: [X0 + 16, -R_CLAD, 0], side: 'b', n: front, minor: mn },
    { text: `core ${f.aUm * 2} µm`, p: [X1 + 0.3, 0, 0], side: 'l', n: front, minor: mn },
    { text: `θ = ${st.deg}°`, p: [X0 - 3, -Math.tan((st.deg * Math.PI) / 180) * 3, 0], side: 't', n: front, minor: true },
    { text: 'drawn: 1 mm of fibre', p: [X1 - 14, -R_COAT, 0], side: 'b', n: front, minor: true },
  ];
  if (st.kind === 'multi' || !main.guided) {
    if (main.guided) out.push({ text: prof === 'graded' ? 'bends back smoothly' : 'total internal reflection', p: [Math.min(prof === 'graded' ? X0 + 20 : main.hitX, X1 - 8), prof === 'graded' ? pathY(main.pts, X0 + 20) : r, 0], side: 't', n: up, minor: true });
    else {
      // the label sits beside the refracted ray, below its middle, clear of the launch label at the input end
      const a = main.pts[1], b = main.pts[main.pts.length - 1];
      out.push({ text: 'leaks; the coating strips it', p: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, 0], side: 'b', n: up, minor: true });
    }
  }
  return out;
}

/** The tau at which every packet has arrived: the slowest ray's progress rate is lagFactor(stretch of the fan's last). */
export function endTau(kind: Kind, profile: Profile = 'step'): number {
  if (kind === 'single') return 1.02;
  const f = FIBRES.multi, last = fanAngles(f, FAN)[FAN - 1];
  return 1 / lagOf(profile, last, f) + 0.02;
}
