// Unit primitives the renderer instances: every part of a scene is one of these, moved, scaled and turned per
// instance. Flat-shaded faces carry their own vertices (sharp edges); a cylinder's side is smooth.

export interface Mesh {
  readonly name: string;
  /** xyz per vertex. */
  readonly positions: Float32Array;
  /** Unit outward normal per vertex. */
  readonly normals: Float32Array;
  /** Triangles, counter-clockwise seen from outside. */
  readonly indices: Uint16Array;
}

/** A cube from −0.5 to 0.5 on every axis: 6 faces × 4 vertices. */
export function boxMesh(): Mesh {
  const pos: number[] = [], nor: number[] = [], idx: number[] = [];
  // Per face: its normal and two in-plane axes u, v with u × v = n (so the quad winds outward).
  const faces: [number[], number[], number[]][] = [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [0, 0, 1], [1, 0, 0]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [0, 1, 0], [1, 0, 0]],
  ];
  for (const [n, u, v] of faces) {
    const b = pos.length / 3;
    for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      for (let k = 0; k < 3; k++) pos.push(0.5 * (n[k] + su * u[k] + sv * v[k]));
      nor.push(...n);
    }
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  return { name: 'box', positions: new Float32Array(pos), normals: new Float32Array(nor), indices: new Uint16Array(idx) };
}

/** A cylinder of radius 0.5 along y from −0.5 to 0.5: a smooth side of `seg` segments and two flat caps (none
 *  with `caps` false: a glass wall, open where a dome sits on it). */
export function cylinderMesh(seg = 32, caps = true): Mesh {
  const pos: number[] = [], nor: number[] = [], idx: number[] = [];
  const ring = (y: number, ny: number) => {
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * 2 * Math.PI, c = Math.cos(a), s = Math.sin(a);
      pos.push(0.5 * c, y, 0.5 * s);
      if (ny) nor.push(0, ny, 0); else nor.push(c, 0, s);
    }
  };
  // Side: bottom ring then top ring; a quad per segment.
  ring(-0.5, 0); ring(0.5, 0);
  for (let i = 0; i < seg; i++) {
    const a = i, b = i + 1, c = seg + 1 + i, d = seg + 2 + i;
    idx.push(a, c, b, b, c, d);
  }
  // Caps: a centre vertex and a ring of their own (flat normals).
  for (const [y, ny] of caps ? [[0.5, 1], [-0.5, -1]] as const : []) {
    const centre = pos.length / 3;
    pos.push(0, y, 0); nor.push(0, ny, 0);
    ring(y, ny);
    for (let i = 0; i < seg; i++) {
      if (ny > 0) idx.push(centre, centre + 2 + i, centre + 1 + i);
      else idx.push(centre, centre + 1 + i, centre + 2 + i);
    }
  }
  return { name: `cylinder${seg}${caps ? '' : 'open'}`, positions: new Float32Array(pos), normals: new Float32Array(nor), indices: new Uint16Array(idx) };
}

/** A sphere of radius 0.5 (`rings` bands from pole to pole), or with `upper` only its top half, y from 0 to 0.5 and
 *  open below: scaled by [d, 2h, d] it is a dome of height h on a cylinder of diameter d. */
export function sphereMesh(seg = 16, rings = 8, upper = false): Mesh {
  const pos: number[] = [], nor: number[] = [], idx: number[] = [];
  const end = upper ? Math.PI / 2 : Math.PI;
  for (let j = 0; j <= rings; j++) {
    const p = (j / rings) * end, sp = Math.sin(p), cp = Math.cos(p);
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * 2 * Math.PI, n = [sp * Math.cos(a), cp, sp * Math.sin(a)];
      pos.push(0.5 * n[0], 0.5 * n[1], 0.5 * n[2]);
      nor.push(...n);
    }
  }
  // Row j is above row j + 1; no triangle is left at a pole with no area.
  for (let j = 0; j < rings; j++) for (let i = 0; i < seg; i++) {
    const a = j * (seg + 1) + i, b = a + 1, c = a + seg + 1, d = c + 1;
    if (upper || j < rings - 1) idx.push(c, a, d);
    if (j > 0) idx.push(d, a, b);
  }
  return { name: `sphere${seg}x${rings}${upper ? 'top' : ''}`, positions: new Float32Array(pos), normals: new Float32Array(nor), indices: new Uint16Array(idx) };
}

/** A ring in the xz plane, outer radius 0.5, its wire `r` wide radially and 1 tall: scaled by [w, t, d] it is a turn
 *  of wire t thick around a w × d oval (a grid turn round its side rods). */
export function torusMesh(seg = 24, tube = 6, r = 0.02): Mesh {
  const pos: number[] = [], nor: number[] = [], idx: number[] = [];
  const R = 0.5 - r;
  for (let j = 0; j <= tube; j++) {
    const f = (j / tube) * 2 * Math.PI, cf = Math.cos(f), sf = Math.sin(f);
    // The cross-section is an ellipse r wide and 0.5 high: its normal leans by those radii.
    const nr = cf / r, ny = 2 * sf, nl = Math.hypot(nr, ny);
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * 2 * Math.PI, ca = Math.cos(a), sa = Math.sin(a), rho = R + r * cf;
      pos.push(rho * ca, 0.5 * sf, rho * sa);
      nor.push((nr / nl) * ca, ny / nl, (nr / nl) * sa);
    }
  }
  for (let j = 0; j < tube; j++) for (let i = 0; i < seg; i++) {
    const a = j * (seg + 1) + i, b = a + 1, c = a + seg + 1, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  return { name: `torus${seg}x${tube}`, positions: new Float32Array(pos), normals: new Float32Array(nor), indices: new Uint16Array(idx) };
}
