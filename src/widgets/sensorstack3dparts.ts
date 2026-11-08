// A 2 × 2 Bayer quad of an image sensor in cross-section, as parts (DOM-free, tested): microlenses, the colour filter
// array, the metal interconnect and the photodiodes, front-side illuminated (the metal between the light and the silicon)
// or back-side illuminated (the wafer thinned, the light entering from the back, the metal below). The front row is cut
// through its middle, and a fan of rays at the chosen angle is traced across that cut: refraction (Snell) at the
// microlens' spherical cap and at every flat interface, stopped by metal, reflected by deep trench isolation, and
// absorbed in silicon at the depth the absorption coefficient gives. Where a ray is absorbed, not where it entered,
// says which pixel counts it: one that crossed a green filter and lands in the red pixel is optical crosstalk.
//
// Lengths are in µm (the drawing: K units a µm). The optics (silicon's absorption and index, the filters' transmission)
// come in as a StackOptics, so the drawing and its tests use the chapter's model.

import type { RGB, RGBA } from '../gl/instances';
import type { Vec3 } from '../gl/math';
import { box, rod, type Anchor, type Part } from '../gl/parts';
import { bayerAt, type Cfa } from '../phys/imagesensor';

export type Illum = 'fsi' | 'bsi';
export type { Cfa };

/** What the chapter's model supplies. */
export interface StackOptics {
  /** Mean absorption depth in silicon, 1/α, in µm. */
  depthUm(nm: number): number;
  /** Silicon's refractive index (real part). */
  nSi(nm: number): number;
  /** A colour filter's transmission, 0–1. */
  filterT(c: Cfa, nm: number): number;
}

/** The quad, from the chapter's mosaic: row 0 R G, row 1 G B. */
export const BAYER: readonly (readonly Cfa[])[] = [0, 1].map((y) => [0, 1].map((x) => bayerAt(x, y)));

export interface Layer { name: string; t: number; n: number; kind: 'plan' | 'cfa' | 'oxide' | 'beol' }
/** A metal line seen end on in the cut (a wire running across the cut): x from the left pixel's centre, y above the silicon. */
export interface Metal { x0: number; x1: number; y0: number; y1: number }

export interface StackSpec {
  illum: Illum;
  /** Pixel pitch, µm. */
  pitch: number;
  /** The layers between the microlens' base and the silicon, top first. */
  layers: readonly Layer[];
  /** The microlens: index and height of the cap (its radius of curvature follows from the focus). */
  nLens: number;
  /** Where the lens focuses (paraxial), µm below the silicon's surface (negative: above it). */
  focus: number;
  /** Metal crossing the light path (FSI: the interconnect; BSI: the grid between the filters). */
  metal: readonly Metal[];
  /** Silicon that collects (the photodiode's depth: FSI the epi it collects from, BSI the thinned wafer). */
  si: number;
  /** Deep trench isolation between the pixels, full depth (BSI). */
  dti: boolean;
  /** The interconnect drawn below the silicon (BSI: out of the light's way), µm. */
  beolBelow: number;
}

const OX = 1.46, CF = 1.6, PL = 1.55;

/**
 * A 1.0 µm pixel in two illuminations. Representative values, not a single product's: the BSI silicon is 2.7 µm, the
 * thickness TechInsights measured on early 1.0 µm DTI pixels (R. Fontaine, IISW 2019); the FSI metal is three levels in
 * 2.4 µm of oxide over the diode, so the FSI stack (≈ 3.7 µm from the lens' base) is about 2.5 × the BSI one (≈ 1.0 µm),
 * where Hirigoyen et al. (IISW 2009, 1.1 µm) found 30 % between the BSI and FSI of their day, BSI stacks having thinned
 * since. Filters 0.6 µm, a metal grid 0.25 µm high in BSI. Indices: oxide 1.46, filters and lens 1.6, planarisation 1.55.
 * The FSI pixel is drawn at 1.0 µm for comparison, not as a product: FSI gave way to BSI around 1.4 µm (Agranov et al.,
 * Lee et al., IISW 2011, where 1.4 µm FSI lost over 20 % to its metal), and the trace shows why: its tall stack accepts
 * only a few degrees. The BSI lens focuses 0.3 µm into the silicon, the FSI one 1.2 µm above it, between M1 and M2.
 */
export function stackSpec(illum: Illum, pitch = 1.0): StackSpec {
  const p = pitch, b = (xc: number, w: number, y0: number, y1: number): Metal => ({ x0: xc - w / 2, x1: xc + w / 2, y0, y1 });
  if (illum === 'fsi') {
    // M1 densest (row select, transfer gate, reset), M3 the widest lines at the pixel's edges; apertures centred on the diodes.
    const edges = [-p, 0, p], metal: Metal[] = [];
    for (const e of edges) metal.push(b(e, 0.3 * p, 0.35, 0.55), b(e, 0.26 * p, 1.05, 1.3), b(e, 0.22 * p, 1.8, 2.1));
    for (const c of [-p / 2, p / 2]) metal.push(b(c - 0.3 * p, 0.1 * p, 0.35, 0.55));
    return {
      illum, pitch: p, nLens: 1.6, focus: -1.2, metal, si: 3.0, dti: false, beolBelow: 0,
      layers: [
        { name: 'planarisation', t: 0.2, n: PL, kind: 'plan' },
        { name: 'colour filters', t: 0.6, n: CF, kind: 'cfa' },
        { name: 'passivation', t: 0.5, n: OX, kind: 'oxide' },
        { name: 'interconnect', t: 2.4, n: OX, kind: 'beol' },
      ],
    };
  }
  const metal = [-p, 0, p].map((e) => b(e, 0.1 * p, 0.25, 0.5));
  return {
    illum, pitch: p, nLens: 1.6, focus: 0.3, metal, si: 2.7, dti: true, beolBelow: 2.4,
    layers: [
      { name: 'planarisation', t: 0.1, n: PL, kind: 'plan' },
      { name: 'colour filters', t: 0.6, n: CF, kind: 'cfa' },
      { name: 'anti-reflection oxide', t: 0.25, n: OX, kind: 'oxide' },
    ],
  };
}

/** Height of the stack between the lens' base and the silicon. */
export const stackHeight = (s: StackSpec): number => s.layers.reduce((a, l) => a + l.t, 0);

/**
 * The microlens' radius of curvature for a paraxial focus at s.focus below the silicon's surface: a single refracting
 * surface brings parallel light to a focus at reduced distance Rc / (nLens − 1), and each layer of thickness t and index
 * n adds t / n of reduced distance. A cap over the whole pitch needs Rc ≥ pitch / 2.
 */
export function lensRadius(s: StackSpec, nSi = 4): number {
  let reduced = s.layers.reduce((a, l) => a + l.t / l.n, 0);
  reduced += s.focus >= 0 ? s.focus / nSi : 0;
  if (s.focus < 0) {
    // A focus inside the stack: take the layers from the bottom back up.
    let up = -s.focus;
    for (let i = s.layers.length - 1; i >= 0 && up > 0; i--) { const d = Math.min(up, s.layers[i].t); reduced -= d / s.layers[i].n; up -= d; }
  }
  // The cap's own height (from its vertex down to its base, in the lens' index) adds h / nLens, and h depends on Rc.
  let rc = Math.max(s.pitch / 2, (s.nLens - 1) * reduced);
  for (let i = 0; i < 30; i++) rc = Math.max(s.pitch / 2, (s.nLens - 1) * (reduced + lensHeight(s, rc) / s.nLens));
  return rc;
}
/** The cap's height over its base for radius rc across the pitch. */
export const lensHeight = (s: StackSpec, rc: number): number => rc - Math.sqrt(Math.max(0, rc * rc - (s.pitch / 2) ** 2));

// ---------------------------------------------------------------- the ray trace (2D, in the cut's plane)

type V2 = [number, number];
const dot = (a: V2, b: V2) => a[0] * b[0] + a[1] * b[1];

/** Snell's law in vector form; null on total internal reflection. `n` is a unit normal (either way round). */
export function refract(d: V2, n: V2, n1: number, n2: number): V2 | null {
  let c = -dot(n, d);
  if (c < 0) { n = [-n[0], -n[1]]; c = -c; }
  const eta = n1 / n2, k = 1 - eta * eta * (1 - c * c);
  if (k < 0) return null;
  const f = eta * c - Math.sqrt(k);
  return [eta * d[0] + f * n[0], eta * d[1] + f * n[1]];
}
const reflect = (d: V2, n: V2): V2 => { const c = dot(d, n); return [d[0] - 2 * c * n[0], d[1] - 2 * c * n[1]]; };

export type Fate = 'own' | 'cross' | 'metal' | 'filter' | 'through';

export interface Ray {
  /** Polylines (x, y in µm, y = 0 the silicon's light-side surface): several when the ray wraps across the quad's edge. */
  paths: V2[][];
  /** Shares of the ray's power: absorbed in the pixel whose filter it crossed, in another pixel, on metal, in the filters,
   *  passed through the silicon unabsorbed. They sum to 1. */
  share: Record<Fate, number>;
  /** The pixel (0 left, 1 right) whose filter it crossed, the pixel it is absorbed in (null: stopped before the silicon). */
  filterPx: number | null;
  absorbPx: number | null;
  /** Where it ends: the absorption point, a metal edge, or the silicon's far side. */
  end: V2;
  fate: Fate;
}

export interface TraceResult {
  rays: Ray[];
  /** Power shares over every ray (each ray carries 1 / rays). */
  total: Record<Fate, number>;
  /** The lens' radius and height, and the absorption depth used. */
  rc: number; h: number; depth: number;
}

const zero = (): Record<Fate, number> => ({ own: 0, cross: 0, metal: 0, filter: 0, through: 0 });

/**
 * Trace `perPx` rays per pixel across the cut row (`row`: 0 R G, 1 G B) at `angleDeg` from the normal (positive: going
 * right), wavelength `nm`. The row repeats every two pixels (as Bayer does), so a ray leaving one side comes back in at
 * the other.
 */
export function traceStack(s: StackSpec, o: StackOptics, nm: number, angleDeg: number, row: 0 | 1, perPx = 9): TraceResult {
  const P = s.pitch, W = 2 * P, nSi = o.nSi(nm), rc = lensRadius(s, nSi), h = lensHeight(s, rc), H = stackHeight(s);
  const depth = o.depthUm(nm), th = (angleDeg * Math.PI) / 180;
  const pxOf = (x: number) => (x < 0 ? 0 : 1);
  const wrap = (x: number) => (x < -P ? x + W : x >= P ? x - W : x);
  const rays: Ray[] = [], total = zero(), N = 2 * perPx;
  // Interfaces below the lens' base, top first: y of each layer's bottom.
  const tops: number[] = [];
  { let y = H; for (const l of s.layers) { tops.push(y); y -= l.t; } }
  for (let i = 0; i < N; i++) {
    const share = zero(), xin = -P + (i + 0.5) * (W / N);
    let d: V2 = [Math.sin(th), -Math.cos(th)];
    const y0 = H + h + 0.6;
    let p: V2 = [xin - (d[0] / -d[1]) * (y0 - H - h / 2), y0];
    let path: V2[] = [[p[0], p[1]]];
    const paths: V2[][] = [path];
    let w = 1, filterPx: number | null = null, absorbPx: number | null = null, fate: Fate = 'own';
    const move = (q: V2) => {
      // Along to q, wrapping across the quad's edge.
      if (q[0] >= -P && q[0] < P) { path.push(q); p = q; return; }
      const xe = q[0] < -P ? -P : P, t = (xe - p[0]) / (q[0] - p[0]), m: V2 = [xe, p[1] + t * (q[1] - p[1])];
      path.push(m);
      path = [[xe === P ? -P : P, m[1]]];
      paths.push(path);
      p = path[0];
      move([wrap(q[0]), q[1]]);
    };
    // The cap: the nearest of the lenses (centres at ±P/2, and a period over) the ray meets.
    let best = Infinity, nrm: V2 = [0, 1];
    for (const c of [-1.5 * P, -0.5 * P, 0.5 * P, 1.5 * P]) {
      const cy = H + h - rc, ox = p[0] - c, oy = p[1] - cy, b = ox * d[0] + oy * d[1], cc = ox * ox + oy * oy - rc * rc, disc = b * b - cc;
      if (disc < 0) continue;
      const t = -b - Math.sqrt(disc), x = p[0] + t * d[0];
      if (t > 0 && t < best && Math.abs(x - c) <= P / 2 + 1e-9) { best = t; nrm = [(x - c) / rc, (p[1] + t * d[1] - cy) / rc]; }
    }
    if (best < Infinity) { move([p[0] + best * d[0], p[1] + best * d[1]]); d = refract(d, nrm, 1, s.nLens) ?? d; }
    // Down through the lens' body to its base, then each layer.
    const down = (yb: number) => { const t = (yb - p[1]) / d[1]; return [p[0] + t * d[0], yb] as V2; };
    let n = s.nLens, stopped = false;
    const hitMetal = (a: V2, b: V2): V2 | null => {
      // The first metal the segment a → b meets (b may lie past the quad's edge: the metal repeats every 2P).
      let tb = Infinity;
      for (const m of s.metal) for (const k of [-W, 0, W]) {
        const x0 = m.x0 + k, x1 = m.x1 + k, dx = b[0] - a[0], dy = b[1] - a[1];
        let t0 = 0, t1 = 1;
        for (const [q, lo, hi] of [[0, x0, x1], [1, m.y0, m.y1]] as const) {
          const s0 = a[q], ds = q ? dy : dx;
          if (Math.abs(ds) < 1e-12) { if (s0 < lo || s0 > hi) { t0 = 2; break; } continue; }
          let ta = (lo - s0) / ds, tb2 = (hi - s0) / ds;
          if (ta > tb2) [ta, tb2] = [tb2, ta];
          t0 = Math.max(t0, ta); t1 = Math.min(t1, tb2);
        }
        if (t0 <= t1 && t0 < tb) tb = t0;
      }
      return tb === Infinity ? null : [a[0] + tb * (b[0] - a[0]), a[1] + tb * (b[1] - a[1])];
    };
    const segment = (q: V2): boolean => {
      // Move to q unless metal is in the way (true: stopped). Unwrapped coordinates, so the metal test sees a straight line.
      const m = hitMetal(p, q);
      if (m) { move(m); return true; }
      move(q);
      return false;
    };
    if (segment(down(H))) stopped = true;
    for (let li = 0; li < s.layers.length && !stopped; li++) {
      const L = s.layers[li], dd = refract(d, [0, 1], n, L.n);
      d = dd ?? reflect(d, [0, 1]);
      n = L.n;
      if (!dd) break;
      const bottom = tops[li] - L.t;
      if (L.kind === 'cfa') {
        const mid = down(tops[li] - L.t / 2);
        filterPx = pxOf(wrap(mid[0]));
        const T = o.filterT(BAYER[row][filterPx], nm);
        share.filter = w * (1 - T); w *= T;
      }
      if (segment(down(bottom))) stopped = true;
    }
    if (stopped) { share.metal = w; fate = 'metal'; }
    else {
      // Into the silicon: absorbed a mean depth 1/α along the path, reflected by DTI walls between pixels.
      const dd = refract(d, [0, 1], n, nSi);
      d = dd ?? reflect(d, [0, 1]);
      // First the whole path to the far side (DTI walls at x = 0 and ±P reflect), then the ray is drawn to where it is
      // absorbed on average: 1/α along the path, or the far side when the path is shorter.
      const pts: V2[] = [];
      let c: V2 = [p[0], p[1]], dir = d, L = 0;
      for (let guard = 0; guard < 64; guard++) {
        const tFar = (-s.si - c[1]) / dir[1];
        let tWall = Infinity, xw = 0;
        if (s.dti && Math.abs(dir[0]) > 1e-12) {
          xw = dir[0] > 0 ? (c[0] < 0 ? 0 : P) : (c[0] <= 0 ? -P : 0);
          tWall = (xw - c[0]) / dir[0];
          if (tWall < 1e-9) tWall = Infinity;
        }
        if (tWall < tFar) {
          c = [xw === P ? P - 1e-9 : xw, c[1] + tWall * dir[1]]; L += tWall; pts.push(c); dir = [-dir[0], dir[1]];
          continue;
        }
        L += tFar; c = [c[0] + tFar * dir[0], -s.si]; pts.push(c);
        break;
      }
      const sEnd = Math.min(depth, L);
      let at: V2 = [p[0], p[1]], gone = 0;
      for (const q of pts) {
        const seg = Math.hypot(q[0] - at[0], q[1] - at[1]);
        if (gone + seg >= sEnd) { const f = seg > 0 ? (sEnd - gone) / seg : 0; move([at[0] + f * (q[0] - at[0]), at[1] + f * (q[1] - at[1])]); break; }
        move(q); at = q; gone += seg;
      }
      const absorbed = 1 - Math.exp(-L / depth);
      absorbPx = pxOf(wrap(p[0]));
      // Absorbed where it ends (at 1/α, or the far side when the silicon is thinner): the pixel there counts it.
      const own = absorbPx === filterPx;
      share[own ? 'own' : 'cross'] = w * absorbed;
      share.through = w * (1 - absorbed);
      fate = absorbed < 0.5 ? 'through' : own ? 'own' : 'cross';
      if (share.filter > 0.5) fate = 'filter';
    }
    if (stopped && share.filter > 0.5) fate = 'filter';
    for (const k of Object.keys(total) as Fate[]) total[k] += share[k] / N;
    rays.push({ paths, share, filterPx, absorbPx, end: [p[0], p[1]], fate });
  }
  return { rays, total, rc, h, depth };
}

// ---------------------------------------------------------------- the drawing

/** Drawing units a µm. */
export const K = 10;

export interface StackPalette {
  lens: RGBA; R: RGBA; G: RGBA; B: RGBA; oxide: RGBA; metal: RGB; si: RGB; diode: RGB; dti: RGB; beol: RGBA; warn: RGB; dim: RGB;
}

export interface StackPose { spec: StackSpec; nm: number; angle: number; row: 0 | 1; trace: TraceResult }

/** Visible light's colour (approximate, after Bruton): for the rays and the absorption marks. */
export function wavelengthRgb(nm: number): RGB {
  let r = 0, g = 0, b = 0;
  if (nm < 440) { r = (440 - nm) / 60; b = 1; }
  else if (nm < 490) { g = (nm - 440) / 50; b = 1; }
  else if (nm < 510) { g = 1; b = (510 - nm) / 20; }
  else if (nm < 580) { r = (nm - 510) / 70; g = 1; }
  else if (nm < 645) { r = 1; g = (645 - nm) / 65; }
  else r = 1;
  const f = nm < 420 ? 0.3 + (0.7 * (nm - 380)) / 40 : nm > 700 ? Math.max(0.35, 0.3 + (0.7 * (780 - nm)) / 80) : 1;
  return [Math.min(1, Math.max(0, r)) * f, Math.min(1, Math.max(0, g)) * f, Math.min(1, Math.max(0, b)) * f];
}

/** The cut is the front row's middle (z = P/2 in µm); rays are drawn just in front of it. */
const LENS_GRID = 8;

export function stackParts(q: StackPose, C: StackPalette): Part[] {
  const s = q.spec, P = s.pitch, out: Part[] = [], H = stackHeight(s), { rc, h } = q.trace;
  const X = (x: number) => x * K, Y = (y: number) => y * K;
  // Rows: row 1 behind (z ∈ [−P, 0]), the cut row in front, drawn to its middle (z ∈ [0, P/2]).
  const zr = (r: 0 | 1): [number, number] => (r === q.row ? [0, P / 2] : [-P, 0]);
  const rows: (0 | 1)[] = [q.row, (1 - q.row) as 0 | 1];
  const cfaCol = (c: Cfa): RGBA => C[c];
  for (const r of rows) {
    const [za, zb] = zr(r);
    for (let px = 0; px < 2; px++) {
      const xa = (px - 1) * P, xb = px * P;
      // Layers above the silicon.
      let y = H;
      for (const L of s.layers) {
        const col = L.kind === 'cfa' ? cfaCol(BAYER[r][px]) : L.kind === 'beol' ? C.beol : C.oxide;
        out.push(box(col, X(xa), X(xb), Y(y - L.t), Y(y), X(za), X(zb)));
        y -= L.t;
      }
      // The lens: columns following the spherical cap, centred on the pixel (the cut row's centre is the cut plane).
      const cx = (xa + xb) / 2, cz = r === q.row ? P / 2 : -P / 2, nz = r === q.row ? LENS_GRID / 2 : LENS_GRID;
      for (let i = 0; i < LENS_GRID; i++) for (let j = 0; j < nz; j++) {
        const x0 = xa + (i * P) / LENS_GRID, x1 = x0 + P / LENS_GRID, z0 = za + (j * P) / LENS_GRID, z1 = z0 + P / LENS_GRID;
        const rr = Math.hypot((x0 + x1) / 2 - cx, (z0 + z1) / 2 - cz), hh = Math.sqrt(Math.max(0, rc * rc - rr * rr)) - (rc - h);
        if (hh > 0.005) out.push(box(C.lens, X(x0), X(x1), Y(H), Y(H + hh), X(z0), X(z1)));
      }
      // Silicon and the photodiode (the n region the pixel collects into), the substrate below for FSI.
      const siTop = 0, siBot = -s.si;
      out.push(box(C.si, X(xa), X(xb), Y(siBot), Y(siTop - 0.12), X(za), X(zb)));
      const inset = s.dti ? 0.08 * P : 0.12 * P;
      // On the cut face the diode stands just proud of the silicon around it, so it shows.
      out.push(box(C.diode, X(xa + inset), X(xb - inset), Y(siBot + 0.3), Y(siTop - 0.25), X(za) + 0.01, X(zb) + (r === q.row ? 0.08 : -0.01)));
      out.push(box(C.si, X(xa), X(xb), Y(siTop - 0.12), Y(siTop), X(za), X(zb)));
      if (s.illum === 'fsi') out.push(box(C.si, X(xa), X(xb), Y(siBot - 0.8), Y(siBot), X(za), X(zb)));
      if (s.beolBelow > 0) {
        out.push(box(C.beol, X(xa), X(xb), Y(siBot - s.beolBelow), Y(siBot), X(za), X(zb)));
        for (const [y0, y1, w] of [[0.3, 0.5, 0.5], [1.0, 1.25, 0.6], [1.75, 2.05, 0.4]]) {
          out.push(box(C.metal, X(cx - (w * P) / 2), X(cx + (w * P) / 2), Y(siBot - y1), Y(siBot - y0), X(za), X(zb), 0.6));
        }
        out.push(box(C.si, X(xa), X(xb), Y(siBot - s.beolBelow - 1.2), Y(siBot - s.beolBelow), X(za), X(zb))); // the logic wafer it is bonded to
      }
    }
    // Metal lines across the cut, and the DTI walls.
    for (const m of s.metal) {
      const x0 = Math.max(-P, m.x0), x1 = Math.min(P, m.x1);
      if (x1 > x0) out.push(box(C.metal, X(x0), X(x1), Y(m.y0), Y(m.y1), X(za), X(zb), 0.6));
    }
    if (s.dti) for (const x of [-P, 0, P]) out.push(box(C.dti, X(Math.max(-P, x - 0.05)), X(Math.min(P, x + 0.05)), Y(-s.si), Y(0), X(za), X(zb)));
  }
  // The rays, on the cut plane: a colour of their own, ending in a mark where they are absorbed (warn: in the wrong pixel).
  const zc = X(P / 2) + 0.4, light = wavelengthRgb(q.nm);
  // A ray the filter takes (most of its power absorbed there) is drawn only down to the filter's middle.
  let cfaMid = H;
  for (const L of s.layers) { if (L.kind === 'cfa') { cfaMid -= L.t / 2; break; } cfaMid -= L.t; }
  for (const r of q.trace.rays) {
    const col: RGB = r.fate === 'metal' || r.fate === 'filter' ? C.dim : light, yStop = r.fate === 'filter' ? cfaMid : -Infinity;
    for (const path of r.paths) for (let k = 1; k < path.length; k++) {
      let [p0, p1] = [path[k - 1], path[k]];
      if (p0[1] <= yStop) break;
      if (p1[1] < yStop) { const f = (p0[1] - yStop) / (p0[1] - p1[1]); p1 = [p0[0] + f * (p1[0] - p0[0]), yStop]; }
      const a: Vec3 = [X(p0[0]), Y(p0[1]), zc], b: Vec3 = [X(p1[0]), Y(p1[1]), zc];
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6) continue;
      out.push({ ...rod(col, a, b, 0.18), emissive: r.fate === 'metal' || r.fate === 'filter' ? undefined : [col[0] * 0.6, col[1] * 0.6, col[2] * 0.6] });
    }
    const [ex, ey] = r.end, mark = r.fate === 'cross' ? C.warn : r.fate === 'metal' ? C.warn : light;
    if (r.fate !== 'filter') out.push({ ...box(mark, X(ex) - 0.7, X(ex) + 0.7, Y(ey) - 0.7, Y(ey) + 0.7, zc - 0.7, zc + 0.7), emissive: [mark[0] * 0.5, mark[1] * 0.5, mark[2] * 0.5] });
  }
  // The absorption depth 1/α: a thin glowing line across the cut silicon (at the far side when deeper than the silicon).
  const dY = -Math.min(q.trace.depth, s.si);
  out.push({ ...box([light[0], light[1], light[2], 0.55], X(-P), X(P), Y(dY) - 0.15, Y(dY) + 0.15, X(P / 2) + 0.05, X(P / 2) + 0.25), emissive: [light[0] * 0.5, light[1] * 0.5, light[2] * 0.5] });
  return out;
}

export function stackAnchors(q: StackPose): Anchor[] {
  const s = q.spec, P = s.pitch, H = stackHeight(s), front: Vec3 = [0, 0, 1], up: Vec3 = [0, 1, 0], zc = (P / 2) * K;
  const yOf = (kind: Layer['kind']) => { let y = H; for (const l of s.layers) { if (l.kind === kind) return y - l.t / 2; y -= l.t; } return 0; };
  const a: Anchor[] = [
    { text: 'microlens', p: [-P * 0.5 * K, (H + q.trace.h) * K, 0], side: 't', n: up },
    { text: 'colour filters', p: [-P * K, yOf('cfa') * K, zc], side: 'l', n: front },
    { text: s.illum === 'fsi' ? 'metal, three levels' : 'metal grid', p: [P * K, (s.illum === 'fsi' ? 1.2 : yOf('cfa') - 0.2) * K, zc], side: 'r', n: front },
    { text: 'photodiode', p: [-P * K, -s.si * 0.5 * K, zc], side: 'l', n: front },
    { text: `1/α = ${fmtUm(q.trace.depth)} at ${q.nm} nm`, p: [P * K, -Math.min(q.trace.depth, s.si) * K, zc], side: 'r', n: front, minor: true },
  ];
  if (s.dti) a.push({ text: 'deep trench isolation', p: [0, -s.si * K, zc], side: 'b', n: front, minor: true });
  if (s.beolBelow > 0) a.push({ text: 'metal, below the silicon', p: [P * K, (-s.si - s.beolBelow / 2) * K, zc], side: 'r', n: front, minor: true });
  return a;
}

export const fmtUm = (u: number): string => (u >= 100 ? `${Math.round(u)} µm` : u >= 10 ? `${u.toFixed(0)} µm` : u >= 1 ? `${u.toFixed(1)} µm` : `${Math.round(u * 1000)} nm`);
