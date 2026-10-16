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

/** A cylinder of radius 0.5 along y from −0.5 to 0.5: a smooth side of `seg` segments and two flat caps. */
export function cylinderMesh(seg = 32): Mesh {
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
  for (const [y, ny] of [[0.5, 1], [-0.5, -1]] as const) {
    const centre = pos.length / 3;
    pos.push(0, y, 0); nor.push(0, ny, 0);
    ring(y, ny);
    for (let i = 0; i < seg; i++) {
      if (ny > 0) idx.push(centre, centre + 2 + i, centre + 1 + i);
      else idx.push(centre, centre + 1 + i, centre + 2 + i);
    }
  }
  return { name: `cylinder${seg}`, positions: new Float32Array(pos), normals: new Float32Array(nor), indices: new Uint16Array(idx) };
}
