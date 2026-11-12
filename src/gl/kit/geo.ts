// Geometry for the studio renderer (gl/studio.ts), DOM-free so a model's shapes can be tested in Node: surfaces of
// revolution (lathe), round wire swept along a path with real bends (tube), any section swept along a path (sweep),
// helices, outlines pushed into solids (extrude), boxes with rounded edges, spheres, tori; merged and transformed.
// Every builder returns real units (mm in the models), outward normals, counter-clockwise triangles seen from outside,
// Uint32 indices (WebGL2 draws them natively, so a long helix is not cut at 65 536 vertices), and its bounds.

import { add3, cross3, dot3, len3, norm3, scale3, sub3, type Mat4, type Vec3 } from '../math';

export interface Geo {
  readonly name: string;
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices: Uint32Array;
  readonly min: Vec3;
  readonly max: Vec3;
  /** Optional per-vertex colour (sRGB, 3 per vertex), multiplied into the material's base: a strain map, a potential. */
  colors?: Float32Array;
  /** Optional texture coordinates (2 per vertex), for a data surface (Material.data). */
  uvs?: Float32Array;
  /** Bumped by refresh(): the renderer re-uploads a geometry whose revision moved (live deform). */
  rev?: number;
}

/** Live deform: copy next's positions, normals (and colours) into g, which keeps its identity (and its GPU buffers),
 *  so a bending blade, a cord or a membrane is rebuilt each frame without a new mesh. Same vertex count required. */
export function refresh(g: Geo, next: Geo): Geo {
  if (next.positions.length !== g.positions.length || next.indices.length !== g.indices.length) throw new Error(`refresh: ${g.name} changed size`);
  g.positions.set(next.positions); g.normals.set(next.normals);
  if (next.colors && g.colors) g.colors.set(next.colors);
  g.rev = (g.rev ?? 0) + 1;
  return g;
}

/** Colour each vertex from a function of its position (a scalar field through a ramp: heatRamp, divergingRamp). */
export function paint(g: Geo, fn: (p: Vec3) => [number, number, number]): Geo {
  const c = g.colors ?? new Float32Array(g.positions.length);
  for (let k = 0; k < g.positions.length; k += 3) c.set(fn([g.positions[k], g.positions[k + 1], g.positions[k + 2]]), k);
  g.colors = c;
  g.rev = (g.rev ?? 0) + 1;
  return g;
}

class Builder {
  p: number[] = []; n: number[] = []; i: number[] = [];
  v(pos: Vec3, nor: Vec3): number { this.p.push(pos[0], pos[1], pos[2]); this.n.push(nor[0], nor[1], nor[2]); return this.p.length / 3 - 1; }
  tri(a: number, b: number, c: number) { this.i.push(a, b, c); }
  quad(a: number, b: number, c: number, d: number) { this.i.push(a, b, c, a, c, d); }
  /** A triangle wound so it faces along n (the order of a, b, c does not matter). */
  otri(a: number, b: number, c: number, n: Vec3) {
    const P = this.p, e1 = [P[3 * b] - P[3 * a], P[3 * b + 1] - P[3 * a + 1], P[3 * b + 2] - P[3 * a + 2]], e2 = [P[3 * c] - P[3 * a], P[3 * c + 1] - P[3 * a + 1], P[3 * c + 2] - P[3 * a + 2]];
    const g = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    if (g[0] * n[0] + g[1] * n[1] + g[2] * n[2] >= 0) this.i.push(a, b, c); else this.i.push(a, c, b);
  }
  oquad(a: number, b: number, c: number, d: number, n: Vec3) { this.otri(a, b, c, n); this.otri(a, c, d, n); }
  /** A quad wound by its own vertices' normals. */
  vquad(a: number, b: number, c: number, d: number) {
    const N = this.n, n: Vec3 = [N[3 * a] + N[3 * b] + N[3 * c] + N[3 * d], N[3 * a + 1] + N[3 * b + 1] + N[3 * c + 1] + N[3 * d + 1], N[3 * a + 2] + N[3 * b + 2] + N[3 * c + 2] + N[3 * d + 2]];
    this.oquad(a, b, c, d, n);
  }
  done(name: string): Geo {
    const positions = new Float32Array(this.p), min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < positions.length; k += 3) for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], positions[k + a]); max[a] = Math.max(max[a], positions[k + a]); }
    return { name, positions, normals: new Float32Array(this.n), indices: new Uint32Array(this.i), min, max };
  }
}

// ---------------------------------------------------------------- lathe

export interface LatheOptions {
  /** Segments round the axis (default 48). */
  seg?: number;
  /** Corners of the profile sharper than this (degrees) stay sharp; smoother ones are shaded smooth (default 35). */
  crease?: number;
  /** A partial turn, radians (default the whole turn). */
  from?: number; to?: number;
}

/** A surface of revolution about y. `profile` is [r, y] points walked from the bottom to the top over the outside (so
 *  the outside is on the right of the walk): a solid starts and ends on the axis (r = 0); a shell walks up its outer
 *  face and back down its inner one. */
export function lathe(profile: readonly (readonly [number, number])[], o: LatheOptions = {}): Geo {
  const seg = o.seg ?? 48, a0 = o.from ?? 0, a1 = o.to ?? 2 * Math.PI, crease = Math.cos(((o.crease ?? 35) * Math.PI) / 180);
  const b = new Builder(), m = profile.length;
  // Each profile segment's outward normal in the (r, y) plane.
  const sn = profile.slice(1).map((q, k) => { const dr = q[0] - profile[k][0], dy = q[1] - profile[k][1], l = Math.hypot(dr, dy) || 1; return [dy / l, -dr / l] as const; });
  const nAt = (k: number, s: number): readonly [number, number] => {
    // the normal at profile point k as seen from segment s (k = s or s + 1): smooth with the neighbour unless creased
    const other = k === s ? s - 1 : s + 1, own = sn[s];
    if (other < 0 || other >= sn.length) return own;
    const nb = sn[other];
    if (own[0] * nb[0] + own[1] * nb[1] < crease) return own;
    const r = own[0] + nb[0], y = own[1] + nb[1], l = Math.hypot(r, y) || 1;
    return [r / l, y / l];
  };
  for (let s = 0; s < m - 1; s++) {
    const [ra, ya] = profile[s], [rc, yc] = profile[s + 1], na = nAt(s, s), nc = nAt(s + 1, s);
    if (ra === 0 && rc === 0) continue;
    const base = b.p.length / 3;
    for (let i = 0; i <= seg; i++) {
      const t = a0 + ((a1 - a0) * i) / seg, c = Math.cos(t), sn2 = Math.sin(t);
      b.v([ra * c, ya, ra * sn2], [na[0] * c, na[1], na[0] * sn2]);
      b.v([rc * c, yc, rc * sn2], [nc[0] * c, nc[1], nc[0] * sn2]);
    }
    for (let i = 0; i < seg; i++) {
      const a = base + 2 * i, c = a + 1, bb = a + 2, d = a + 3;
      if (ra !== 0) b.tri(a, c, bb);
      if (rc !== 0) b.tri(bb, c, d);
    }
  }
  return b.done(`lathe${m}x${seg}`);
}

// ---------------------------------------------------------------- paths

/** Round each inner corner of a polyline with an arc of radius `r` (a wire bent round a former, not kinked). */
export function filletPath(pts: readonly Vec3[], r: number, steps = 6): Vec3[] {
  if (r <= 0 || pts.length < 3) return pts.slice();
  const out: Vec3[] = [pts[0]];
  for (let k = 1; k < pts.length - 1; k++) {
    const p = pts[k], a = norm3(sub3(pts[k - 1], p)), c = norm3(sub3(pts[k + 1], p));
    const cosT = Math.max(-1, Math.min(1, dot3(a, c))), half = Math.acos(cosT) / 2;
    if (half > Math.PI / 2 - 1e-3 || half < 1e-3) { out.push(p); continue; }
    // the tangent points sit `t` from the corner along each leg; not past half of either leg
    const t = Math.min(r / Math.tan(half), len3(sub3(pts[k - 1], p)) / 2, len3(sub3(pts[k + 1], p)) / 2);
    const rr = t * Math.tan(half), p0 = add3(p, scale3(a, t)), p1 = add3(p, scale3(c, t));
    const bis = norm3(add3(a, c)), centre = add3(p, scale3(bis, rr / Math.sin(half)));
    const u = sub3(p0, centre), w = sub3(p1, centre), ang = Math.acos(Math.max(-1, Math.min(1, dot3(norm3(u), norm3(w)))));
    for (let i = 0; i <= steps; i++) {
      const f = i / steps, s0 = Math.sin((1 - f) * ang) / Math.sin(ang), s1 = Math.sin(f * ang) / Math.sin(ang);
      out.push(add3(centre, add3(scale3(u, s0), scale3(w, s1))));
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

export interface HelixOptions {
  /** Radius, or radii across x and z (an oval winding round side rods). */
  r?: number; rx?: number; rz?: number;
  /** Rise per turn, start and end height (y), where the centre stands. */
  pitch: number; from: number; to: number; at?: [number, number];
  /** Points per turn (default 24); the turn's starting angle (radians). */
  perTurn?: number; phase?: number;
}

/** A helix about a vertical axis, as a path for tube(). */
export function helix(o: HelixOptions): Vec3[] {
  const rx = o.rx ?? o.r ?? 1, rz = o.rz ?? o.r ?? 1, n = o.perTurn ?? 24, [cx, cz] = o.at ?? [0, 0];
  const turns = (o.to - o.from) / o.pitch, steps = Math.max(2, Math.ceil(turns * n)), out: Vec3[] = [];
  for (let i = 0; i <= steps; i++) {
    const f = i / steps, t = (o.phase ?? 0) + f * turns * 2 * Math.PI;
    out.push([cx + rx * Math.cos(t), o.from + f * (o.to - o.from), cz + rz * Math.sin(t)]);
  }
  return out;
}

// ---------------------------------------------------------------- sweeps

export interface SweepOptions {
  /** Round the path's corners with this radius first (tube: default 0). */
  bend?: number;
  /** The path is a loop (a ring, a closed coil). */
  closed?: boolean;
  /** Flat ends (default true for an open path). */
  caps?: boolean;
}

/** Frames along a path by parallel transport (no twist where the path does not turn). */
function frames(path: readonly Vec3[], closed: boolean): { t: Vec3; u: Vec3; v: Vec3 }[] {
  const n = path.length, T: Vec3[] = path.map((_, k) => {
    const a = path[closed ? (k - 1 + n) % n : Math.max(0, k - 1)], c = path[closed ? (k + 1) % n : Math.min(n - 1, k + 1)];
    return norm3(sub3(c, a));
  });
  const seed: Vec3 = Math.abs(T[0][1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let u = norm3(cross3(cross3(T[0], seed), T[0]));
  const out = [{ t: T[0], u, v: cross3(T[0], u) }];
  for (let k = 1; k < n; k++) {
    const t = T[k];
    u = norm3(sub3(u, scale3(t, dot3(u, t))));
    out.push({ t, u, v: cross3(t, u) });
  }
  return out;
}

/** A closed 2D section (counter-clockwise, in the path frame's u, v) swept along `path`: a ribbon, a rail, a trace. */
export function sweep(path: readonly Vec3[], section: readonly (readonly [number, number])[], o: SweepOptions = {}): Geo {
  const pts = filletPath(path, o.bend ?? 0), closed = !!o.closed, F = frames(pts, closed), b = new Builder(), m = section.length;
  // Side normals per section corner: smooth (a round section) when its corners are shallow, else per edge.
  const smooth = m >= 8;
  const secN = section.map((q, k) => {
    const a = section[(k - 1 + m) % m], c = section[(k + 1) % m];
    const e0 = [q[0] - a[0], q[1] - a[1]], e1 = [c[0] - q[0], c[1] - q[1]];
    const n0 = [e0[1], -e0[0]], n1 = [e1[1], -e1[0]], l0 = Math.hypot(n0[0], n0[1]) || 1, l1 = Math.hypot(n1[0], n1[1]) || 1;
    return { avg: norm2([n0[0] / l0 + n1[0] / l1, n0[1] / l0 + n1[1] / l1]), edge: [n1[0] / l1, n1[1] / l1] as const };
  });
  const rings = closed ? pts.length + 1 : pts.length;
  const at = (k: number, q: readonly [number, number]): Vec3 => { const f = F[k % pts.length], p = pts[k % pts.length]; return add3(p, add3(scale3(f.u, q[0]), scale3(f.v, q[1]))); };
  const dir = (k: number, d: readonly [number, number]): Vec3 => { const f = F[k % pts.length]; return norm3(add3(scale3(f.u, d[0]), scale3(f.v, d[1]))); };
  if (smooth) {
    for (let k = 0; k < rings; k++) for (let j = 0; j <= m; j++) b.v(at(k, section[j % m]), dir(k, secN[j % m].avg));
    for (let k = 0; k < rings - 1; k++) for (let j = 0; j < m; j++) {
      const a = k * (m + 1) + j, c = a + m + 1;
      b.vquad(a, a + 1, c + 1, c);
    }
  } else {
    for (let j = 0; j < m; j++) {
      const base = b.p.length / 3, q0 = section[j], q1 = section[(j + 1) % m], e = secN[j].edge;
      for (let k = 0; k < rings; k++) { b.v(at(k, q0), dir(k, e)); b.v(at(k, q1), dir(k, e)); }
      for (let k = 0; k < rings - 1; k++) { const a = base + 2 * k; b.vquad(a, a + 1, a + 3, a + 2); }
    }
  }
  if (!closed && o.caps !== false) {
    for (const [k, sgn] of [[0, -1], [pts.length - 1, 1]] as const) {
      const n = scale3(F[k].t, sgn), c = b.v(pts[k], n), ring = section.map((q) => b.v(at(k, q), n));
      for (let j = 0; j < m; j++) b.otri(c, ring[j], ring[(j + 1) % m], n);
    }
  }
  return b.done(`sweep${pts.length}x${m}`);
}

const norm2 = (a: number[]): [number, number] => { const l = Math.hypot(a[0], a[1]) || 1; return [a[0] / l, a[1] / l]; };

/** A circle of `sides` points, radius r (a section for sweep). */
export const circle = (r: number, sides = 8): [number, number][] =>
  Array.from({ length: sides }, (_, i) => { const a = (i / sides) * 2 * Math.PI; return [r * Math.cos(a), r * Math.sin(a)]; });

/** A round wire of radius r along a path: leads with real bends, windings, a filament. */
export const tube = (path: readonly Vec3[], r: number, o: SweepOptions & { sides?: number } = {}): Geo =>
  sweep(path, circle(r, Math.max(3, o.sides ?? 8)), o);

// ---------------------------------------------------------------- extrude

/** Ear clipping of a simple polygon (counter-clockwise); returns index triples. */
export function triangulate(poly: readonly (readonly [number, number])[]): number[] {
  const idx = poly.map((_, i) => i), out: number[] = [];
  const area = (a: readonly number[], b: readonly number[], c: readonly number[]) => (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
  const inside = (p: readonly number[], a: readonly number[], b: readonly number[], c: readonly number[]) => area(a, b, p) >= 0 && area(b, c, p) >= 0 && area(c, a, p) >= 0;
  let guard = 0;
  while (idx.length > 3 && guard++ < 10000) {
    let cut = false;
    for (let k = 0; k < idx.length; k++) {
      const i0 = idx[(k - 1 + idx.length) % idx.length], i1 = idx[k], i2 = idx[(k + 1) % idx.length];
      const a = poly[i0], b = poly[i1], c = poly[i2];
      if (area(a, b, c) <= 1e-12) continue;
      if (idx.some((j) => j !== i0 && j !== i1 && j !== i2 && inside(poly[j], a, b, c))) continue;
      out.push(i0, i1, i2); idx.splice(k, 1); cut = true; break;
    }
    if (!cut) break; // a self-touching outline: leave the rest
  }
  if (idx.length === 3) out.push(idx[0], idx[1], idx[2]);
  return out;
}

/** A 2D outline in the x, z plane (counter-clockwise seen from above, +y) pushed up from y = 0 to `height`: plates,
 *  brackets, a mica's outline, a die. Flat sides with sharp edges. */
export function extrude(outline: readonly (readonly [number, number])[], height: number): Geo {
  // either winding is accepted: the signed area says which side is out
  let area = 0;
  for (let k = 0; k < outline.length; k++) { const p = outline[k], q = outline[(k + 1) % outline.length]; area += p[0] * q[1] - q[0] * p[1]; }
  const ccw = area > 0 ? outline : outline.slice().reverse();
  const b = new Builder(), m = ccw.length, tris = triangulate(ccw);
  for (const [y, ny] of [[0, -1], [height, 1]] as const) {
    const ring = ccw.map(([x, z]) => b.v([x, y, z], [0, ny, 0]));
    for (let k = 0; k < tris.length; k += 3) b.otri(ring[tris[k]], ring[tris[k + 1]], ring[tris[k + 2]], [0, ny, 0]);
  }
  for (let j = 0; j < m; j++) {
    const [x0, z0] = ccw[j], [x1, z1] = ccw[(j + 1) % m], out = norm3([z1 - z0, 0, -(x1 - x0)]);
    const a = b.v([x0, 0, z0], out), c = b.v([x1, 0, z1], out), d = b.v([x1, height, z1], out), e = b.v([x0, height, z0], out);
    b.oquad(a, c, d, e, out);
  }
  return b.done(`extrude${m}`);
}

/** A sheet of thickness t along an open polyline in x, z (a bent plate, a bracket), pushed up `height`. */
export function bentSheet(line: readonly (readonly [number, number])[], t: number, height: number): Geo {
  // offset the polyline both ways by t/2 and close it: one outline
  const left: [number, number][] = [], right: [number, number][] = [];
  for (let k = 0; k < line.length; k++) {
    const p = line[k], a = line[Math.max(0, k - 1)], c = line[Math.min(line.length - 1, k + 1)];
    const din = k > 0 ? norm2([p[0] - a[0], p[1] - a[1]]) : [0, 0], dout = k < line.length - 1 ? norm2([c[0] - p[0], c[1] - p[1]]) : [0, 0];
    const d = norm2([din[0] + dout[0], din[1] + dout[1]]);
    const n: [number, number] = [-d[1], d[0]];
    // at a corner keep the sheet's thickness (miter)
    let k2 = 1;
    if (k > 0 && k < line.length - 1) {
      const n0 = [-din[1], din[0]];
      k2 = 1 / Math.max(0.3, n0[0] * n[0] + n0[1] * n[1]);
    }
    left.push([line[k][0] + n[0] * (t / 2) * k2, line[k][1] + n[1] * (t / 2) * k2]);
    right.push([line[k][0] - n[0] * (t / 2) * k2, line[k][1] - n[1] * (t / 2) * k2]);
  }
  const outline = [...right, ...left.reverse()];
  // counter-clockwise seen from +y means clockwise in (x, z): flip when the signed area says so
  let s = 0;
  for (let k = 0; k < outline.length; k++) { const p = outline[k], q = outline[(k + 1) % outline.length]; s += p[0] * q[1] - q[0] * p[1]; }
  return extrude(s > 0 ? outline.reverse() : outline, height);
}

// ---------------------------------------------------------------- boxes, spheres, tori

/** A box w × h × d centred on the origin with edges rounded to radius r (r = 0: sharp). */
export function roundedBox(w: number, h: number, d: number, r: number, seg = 3): Geo {
  const half: Vec3 = [w / 2, h / 2, d / 2], rr = Math.min(r, w / 2, h / 2, d / 2), b = new Builder();
  const coords = (a: number) => {
    if (rr <= 0) return [-half[a], half[a]];
    const out: number[] = [];
    for (let k = 0; k <= seg; k++) out.push(-half[a] + (rr * k) / seg);
    for (let k = 0; k <= seg; k++) out.push(half[a] - rr + (rr * k) / seg);
    return out;
  };
  const C = [coords(0), coords(1), coords(2)];
  const faces: [number, number, number, number][] = [[0, 1, 2, 1], [0, 2, 1, -1], [1, 2, 0, 1], [1, 0, 2, -1], [2, 0, 1, 1], [2, 1, 0, -1]];
  for (const [a, u, v, sgn] of faces) {
    const base = b.p.length / 3, cu = C[u], cv = C[v];
    for (const y of cv) for (const x of cu) {
      const p: Vec3 = [0, 0, 0]; p[a] = sgn * half[a]; p[u] = x; p[v] = y;
      const inner = p.map((q, i) => Math.max(-half[i] + rr, Math.min(half[i] - rr, q))) as Vec3;
      const off = sub3(p, inner), l = len3(off);
      const nn: Vec3 = l > 1e-9 ? scale3(off, 1 / l) : (() => { const z: Vec3 = [0, 0, 0]; z[a] = sgn; return z; })();
      b.v(rr > 0 ? add3(inner, scale3(nn, rr)) : p, rr > 0 ? nn : (() => { const z: Vec3 = [0, 0, 0]; z[a] = sgn; return z; })());
    }
    const nu = cu.length, fn: Vec3 = [0, 0, 0];
    fn[a] = sgn;
    for (let j = 0; j < cv.length - 1; j++) for (let i = 0; i < nu - 1; i++) {
      const p0 = base + j * nu + i, p1 = p0 + 1, p2 = p0 + nu + 1, p3 = p0 + nu;
      // wound by the vertices' own normals (a corner quad faces diagonally out)
      const nn = norm3([b.n[3 * p0] + b.n[3 * p2], b.n[3 * p0 + 1] + b.n[3 * p2 + 1], b.n[3 * p0 + 2] + b.n[3 * p2 + 2]]);
      b.oquad(p0, p1, p2, p3, len3(nn) > 0.5 ? nn : fn);
    }
  }
  return b.done(`rbox${rr > 0 ? seg : 0}`);
}

/** A sphere of radius r. */
export function sphere(r: number, seg = 24, rings = 12): Geo {
  const prof: [number, number][] = [];
  for (let j = 0; j <= rings; j++) { const p = Math.PI * (1 - j / rings); prof.push([j === 0 || j === rings ? 0 : r * Math.sin(p), r * Math.cos(p)]); }
  return lathe(prof, { seg, crease: 90 });
}

/** A ring of centre radius R and wire radius r in the x, z plane. */
export function torus(R: number, r: number, seg = 32, sides = 8): Geo {
  const path: Vec3[] = Array.from({ length: seg }, (_, i) => { const a = (i / seg) * 2 * Math.PI; return [R * Math.cos(a), 0, R * Math.sin(a)]; });
  return tube(path, r, { closed: true, sides });
}

// ---------------------------------------------------------------- baking

/** A geometry moved by a 4 × 4 matrix (column-major, as gl/math.ts), normals by its inverse transpose. */
export function transform(g: Geo, m: Mat4): Geo {
  const b = new Builder(), nm = normalMatrix(m);
  for (let k = 0; k < g.positions.length; k += 3) {
    const x = g.positions[k], y = g.positions[k + 1], z = g.positions[k + 2], nx = g.normals[k], ny = g.normals[k + 1], nz = g.normals[k + 2];
    b.v([m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]],
      norm3([nm[0] * nx + nm[3] * ny + nm[6] * nz, nm[1] * nx + nm[4] * ny + nm[7] * nz, nm[2] * nx + nm[5] * ny + nm[8] * nz]));
  }
  b.i = Array.from(g.indices);
  return b.done(`${g.name}*`);
}

/** Several geometries as one (one draw). */
export function merge(list: readonly Geo[], name = 'merged'): Geo {
  const b = new Builder();
  for (const g of list) {
    const base = b.p.length / 3;
    for (let k = 0; k < g.positions.length; k++) { b.p.push(g.positions[k]); b.n.push(g.normals[k]); }
    for (const i of g.indices) b.i.push(base + i);
  }
  return b.done(name);
}

/** The inverse transpose of a matrix's upper 3 × 3 (column-major 3 × 3 out): normals under a non-uniform scale. */
export function normalMatrix(m: Mat4): Float32Array {
  const a = m[0], b = m[1], c = m[2], d = m[4], e = m[5], f = m[6], g = m[8], h = m[9], i = m[10];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C || 1e-12;
  // inverse = adj / det; its transpose, column-major
  return new Float32Array([
    A / det, B / det, C / det,
    -(b * i - c * h) / det, (a * i - c * g) / det, -(a * h - b * g) / det,
    (b * f - c * e) / det, -(a * f - c * d) / det, (a * e - b * d) / det,
  ]);
}

/** A flat w × d rectangle in the x, z plane facing +y, with texture coordinates (u along x, v along z): a screen,
 *  a picture, a card, a mask plate. */
export function plane(w: number, d: number): Geo {
  const b = new Builder();
  const v = [[-w / 2, -d / 2, 0, 0], [w / 2, -d / 2, 1, 0], [w / 2, d / 2, 1, 1], [-w / 2, d / 2, 0, 1]].map(([x, z]) => b.v([x, 0, z], [0, 1, 0]));
  b.oquad(v[0], v[1], v[2], v[3], [0, 1, 0]);
  const g = b.done('plane');
  g.uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
  return g;
}

/** A parametric surface p(u, v), u and v in 0..1, nu × nv quads; normals from the cross product of the partial
 *  derivatives (an antenna lobe r(θ, φ), a membrane, a square microlens as a height field). */
export function surface(fn: (u: number, v: number) => Vec3, nu = 32, nv = 32): Geo {
  const b = new Builder(), e = 1e-4;
  for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
    const u = i / nu, v = j / nv, p = fn(u, v);
    const du = sub3(fn(Math.min(1, u + e), v), fn(Math.max(0, u - e), v)), dv = sub3(fn(u, Math.min(1, v + e)), fn(u, Math.max(0, v - e)));
    const n = cross3(du, dv), l = len3(n);
    b.v(p, l > 1e-12 ? scale3(n, 1 / l) : [0, 1, 0]);
  }
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) { const a = j * (nu + 1) + i; b.vquad(a, a + 1, a + nu + 2, a + nu + 1); }
  const g = b.done(`surface${nu}x${nv}`);
  g.uvs = new Float32Array(Array.from({ length: (nu + 1) * (nv + 1) }, (_, k) => [(k % (nu + 1)) / nu, Math.floor(k / (nu + 1)) / nv]).flat());
  return g;
}

/** A strip between two rows of points (left[i], right[i]) facing the given normals: ink on a surface, a flat
 *  ribbon cable, a trace on a board. One-sided; its vertices carry the surface's normals. */
export function ribbon(left: readonly Vec3[], right: readonly Vec3[], normals: readonly Vec3[], name = 'ribbon'): Geo {
  const b = new Builder(), L = left.map((p, i) => b.v(p, normals[i])), R = right.map((p, i) => b.v(p, normals[i]));
  for (let i = 0; i + 1 < left.length; i++) b.vquad(L[i], L[i + 1], R[i + 1], R[i]);
  return b.done(name);
}

/** The point at fraction s (0..1, by length) along a polyline: particles riding a wire, a pulse along a path. */
export function along(path: readonly Vec3[], s: number): Vec3 {
  const L: number[] = [0];
  for (let k = 1; k < path.length; k++) L.push(L[k - 1] + len3(sub3(path[k], path[k - 1])));
  const t = Math.max(0, Math.min(1, s)) * L[L.length - 1];
  let k = 1;
  while (k < path.length - 1 && L[k] < t) k++;
  const f = (t - L[k - 1]) / ((L[k] - L[k - 1]) || 1);
  return add3(path[k - 1], scale3(sub3(path[k], path[k - 1]), f));
}

/** Triangle count (for the budget and the fallback's choice of detail). */
export const triangles = (g: Geo) => g.indices.length / 3;
