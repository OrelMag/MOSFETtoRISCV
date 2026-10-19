// Chapter 32's drawing pad: what the learner draws (polygons, brush strokes) turned into the only thing the rasterizer
// draws, triangles, the way a driver does it. DOM-free; tests/gfxdraw.test.ts checks the pieces and runs a drawing on
// the gate-level GPU against the reference.
//
// Vertices are the rasterizer's: quarter pixels, integers 0 … 255. A triangle is a front face when
// cross(v0, v1, v2) > 0 (clockwise on a screen whose y grows downward, raster.ts setup().area2); every triangle made
// here is one, unless the learner keeps the winding they clicked.

import { CLEAR_CYCLES, type DrawOp, rasterize, RefFrame, type Vtx, Z_WALK_START } from './raster';

/** Twice the signed area of a, b, c: the rasterizer's area2. */
export const cross = (a: Vtx, b: Vtx, c: Vtx) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
const same = (a: Vtx, b: Vtx) => a[0] === b[0] && a[1] === b[1];

/** A triangle turned to face the viewer, or null when it has no area. */
export function frontFace(t: Vtx[]): Vtx[] | null {
  const k = cross(t[0], t[1], t[2]);
  return k > 0 ? t : k < 0 ? [t[0], t[2], t[1]] : null;
}

/** Twice the signed area of a polygon (shoelace). */
export function polyArea2(p: Vtx[]): number {
  let s = 0;
  for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += a[0] * b[1] - b[0] * a[1]; }
  return s;
}

/** p inside or on triangle abc (abc a front face). */
const inTri = (p: Vtx, a: Vtx, b: Vtx, c: Vtx) => cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0;

/**
 * A simple polygon as n − 2 front-facing triangles, by ear clipping: a convex corner whose triangle holds no other
 * vertex is cut off, O(n²) per ear. Repeated and collinear points are dropped first. A self-intersecting polygon
 * runs out of ears; what is left is fanned.
 */
export function polygonTriangles(pts: Vtx[]): Vtx[][] {
  let p = pts.filter((v, i) => !same(v, pts[(i + pts.length - 1) % pts.length]));
  for (let changed = true; changed && p.length >= 3;) {
    changed = false;
    for (let i = 0; i < p.length && p.length >= 3; i++) {
      const a = p[(i + p.length - 1) % p.length], c = p[(i + 1) % p.length];
      // collinear, or a spike back to where it came from: no area
      if (cross(a, p[i], c) === 0) { p.splice(i, 1); changed = true; i--; }
    }
  }
  if (p.length < 3) return [];
  if (polyArea2(p) < 0) p = p.slice().reverse();
  const out: Vtx[][] = [];
  while (p.length > 3) {
    let cut = -1;
    for (let i = 0; i < p.length && cut < 0; i++) {
      const a = p[(i + p.length - 1) % p.length], b = p[i], c = p[(i + 1) % p.length];
      if (cross(a, b, c) <= 0) continue;
      if (p.every((q) => q === a || q === b || q === c || !inTri(q, a, b, c))) cut = i;
    }
    if (cut < 0) {
      // no ear: the outline crosses itself. Fan what is left (overlaps are drawn once: see drawingOps)
      for (let i = 1; i + 1 < p.length; i++) { const t = frontFace([p[0], p[i], p[i + 1]]); if (t) out.push(t); }
      return out;
    }
    out.push([p[(cut + p.length - 1) % p.length], p[cut], p[(cut + 1) % p.length]]);
    p.splice(cut, 1);
  }
  const t = frontFace(p);
  if (t) out.push(t);
  return out;
}

/** Ramer–Douglas–Peucker: drop points within `tol` of the line through their neighbours (fewer triangles). */
export function simplify(p: Vtx[], tol = 2): Vtx[] {
  if (p.length < 3) return p.slice();
  const [a, b] = [p[0], p[p.length - 1]];
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  let worst = -1, wd = 0;
  for (let i = 1; i < p.length - 1; i++) {
    const d = len ? Math.abs(cross(a, b, p[i])) / len : Math.hypot(p[i][0] - a[0], p[i][1] - a[1]);
    if (d > wd) { wd = d; worst = i; }
  }
  if (wd <= tol) return [a, b];
  return [...simplify(p.slice(0, worst + 1), tol).slice(0, -1), ...simplify(p.slice(worst), tol)];
}

/**
 * A brush stroke `width` pixels wide as a triangle strip: each point is offset both ways along its mitre (the
 * bisector of its two segments' normals, lengthened so the edges stay `width` apart, at most 2×), the ends
 * extended by half the width (square caps); two triangles a segment, sharing their edges exactly. A dot is a square.
 */
export function strokeTriangles(pts: Vtx[], width: number): Vtx[][] {
  const hw = 2 * width;
  const p = simplify(pts.filter((v, i) => i === 0 || !same(v, pts[i - 1])));
  if (p.length === 1) {
    const [x, y] = p[0], q: Vtx[] = [[clamp(x - hw), clamp(y - hw)], [clamp(x + hw), clamp(y - hw)], [clamp(x + hw), clamp(y + hw)], [clamp(x - hw), clamp(y + hw)]];
    return polygonTriangles(q);
  }
  const dir = (a: Vtx, b: Vtx): [number, number] => { const l = Math.hypot(b[0] - a[0], b[1] - a[1]); return [(b[0] - a[0]) / l, (b[1] - a[1]) / l]; };
  const n = p.length, L: Vtx[] = [], R: Vtx[] = [];
  for (let i = 0; i < n; i++) {
    const d0 = dir(p[Math.max(0, i - 1)], p[Math.max(1, i)]), d1 = dir(p[Math.min(n - 2, i)], p[Math.min(n - 1, i + 1)]);
    // normals (−dy, dx); the mitre is their bisector, |m|·cos(half the turn) = hw
    const n0: [number, number] = [-d0[1], d0[0]], n1: [number, number] = [-d1[1], d1[0]];
    let mx = n0[0] + n1[0], my = n0[1] + n1[1];
    const ml = Math.hypot(mx, my);
    if (ml < 1e-9) { mx = n1[0]; my = n1[1]; } else { mx /= ml; my /= ml; }
    const k = hw / Math.max(0.5, mx * n1[0] + my * n1[1]);
    let [x, y] = p[i];
    if (i === 0) { x -= d1[0] * hw; y -= d1[1] * hw; }
    if (i === n - 1) { x += d0[0] * hw; y += d0[1] * hw; }
    L.push([clamp(x + mx * k), clamp(y + my * k)]);
    R.push([clamp(x - mx * k), clamp(y - my * k)]);
  }
  const out: Vtx[][] = [];
  for (let i = 0; i + 1 < n; i++) {
    for (const t of [[L[i], L[i + 1], R[i + 1]], [L[i], R[i + 1], R[i]]] as Vtx[][]) { const f = frontFace(t); if (f) out.push(f); }
  }
  return out;
}

export type Tool = 'tri' | 'poly' | 'brush';

export interface Shape {
  tool: Tool;
  /** Quarter pixels: the clicked corners, or the brush's path. */
  pts: Vtx[];
  /** RGB332. */
  col: number;
  /** Alpha in eighths minus one (7: opaque). */
  a: number;
  /** Brush width, pixels. */
  w?: number;
}

export interface Drawing {
  /** The clear colour. */
  bg: number;
  shapes: Shape[];
  /** Send a clicked triangle as clicked: wound the other way, it is a back face and culled. */
  keepWinding?: boolean;
}

/** Shapes beyond this get no depth of their own: they are not sent. */
export const MAX_SHAPES = 250;
/** Triangles a drawing may send (about 100 000 cycles at most). */
export const MAX_TRIANGLES = 600;

/** A shape's triangles, as sent. */
export function shapeTriangles(s: Shape, keepWinding = false): Vtx[][] {
  if (s.tool === 'brush') return strokeTriangles(s.pts, s.w ?? 2);
  if (s.tool === 'tri') {
    if (s.pts.length !== 3) return [];
    if (keepWinding) return cross(s.pts[0], s.pts[1], s.pts[2]) === 0 ? [] : [s.pts];
    const t = frontFace(s.pts);
    return t ? [t] : [];
  }
  return polygonTriangles(s.pts);
}

/** z of shape k: each shape nearer than the ones before it, all its triangles at one depth. */
export const shapeZ = (k: number) => 254 - k;

/**
 * The draws: a clear, then every shape's triangles with the depth test on. Each shape is one depth plane, nearer
 * than the shapes before it, so it covers them as in painter's order; and since the test passes only "nearer", a
 * pixel two of its own triangles both cover (a stroke crossing itself, a fanned outline) is written, and blended,
 * once.
 */
export function drawingOps(d: Drawing): DrawOp[] {
  const ops: DrawOp[] = [{ clr: true, v: [[0, 0], [0, 0], [0, 0]], col: d.bg }];
  let n = 0;
  d.shapes.slice(0, MAX_SHAPES).forEach((s, k) => {
    const z = shapeZ(k);
    for (const v of shapeTriangles(s, d.keepWinding)) {
      if (n++ >= MAX_TRIANGLES) return;
      ops.push({ v, col: s.col, a: s.a, z: [z, z, z], zt: true });
    }
  });
  return ops;
}

export interface DrawingCost {
  triangles: number;
  /** Triangles culled as back faces. */
  culled: number;
  /** Pixels the triangles cover (a pixel covered twice counts twice). */
  pixels: number;
  /** Cycles of the clear, and of the triangles: each one's go cycle and busy cycles, back to back. */
  clear: number;
  draw: number;
  /** Set-up cycles among `draw`: from go to the first tile test. */
  setup: number;
}

/** What a drawing costs on chapter 32's GPU (with depth), from the reference model. */
export function drawingCost(d: Drawing): DrawingCost {
  let culled = 0, pixels = 0, draw = 0, set = 0;
  const ops = drawingOps(d);
  for (const op of ops.slice(1)) {
    const r = rasterize(op.v, true);
    if (!r.setup.front) culled++;
    pixels += r.writes.length;
    draw += r.cycles + 1;
    set += Math.min(r.cycles + 1, Z_WALK_START);
  }
  return { triangles: ops.length - 1, culled, pixels, clear: CLEAR_CYCLES + 1, draw, setup: set };
}

/** The picture the hardware must produce. */
export function drawingPicture(d: Drawing): Uint8Array {
  const ref = new RefFrame();
  for (const op of drawingOps(d)) ref.draw(op);
  return ref.fb;
}

const ring = (cx: number, cy: number, r: number, n: number): Vtx[] =>
  Array.from({ length: n }, (_, i) => [clamp(cx + r * Math.cos((2 * Math.PI * i) / n)), clamp(cy + r * Math.sin((2 * Math.PI * i) / n))] as Vtx);

/** Drawings to start from. */
export const SAMPLE_DRAWINGS: { id: string; title: string; d: Drawing }[] = [
  {
    id: 'house', title: 'A house',
    d: {
      bg: 0x57,
      shapes: [
        { tool: 'poly', pts: [[0, 184], [255, 172], [255, 255], [0, 255]], col: 0x34, a: 7 },
        { tool: 'poly', pts: ring(206, 46, 22, 10), col: 0xfc, a: 7 },
        { tool: 'poly', pts: [[128, 78], [142, 78], [142, 108], [128, 108]], col: 0x64, a: 7 },
        { tool: 'poly', pts: [[62, 120], [150, 120], [150, 202], [62, 202]], col: 0xd1, a: 7 },
        { tool: 'tri', pts: [[50, 124], [106, 70], [162, 124]], col: 0xe0, a: 7 },
        { tool: 'poly', pts: [[92, 152], [118, 152], [118, 202], [92, 202]], col: 0x64, a: 7 },
        { tool: 'brush', pts: [[136, 72], [128, 58], [140, 44], [130, 30], [144, 16]], col: 0xff, a: 3, w: 3 },
      ],
    },
  },
  {
    id: 'empty', title: 'An empty page', d: { bg: 0x25, shapes: [] },
  },
];
