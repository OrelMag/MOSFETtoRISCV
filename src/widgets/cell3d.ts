// Axis-aligned boxes drawn in 3D as SVG polygons (chapter 26's standard cells): an orbit camera, an orthographic
// projection and the painter's algorithm. DOM-free: it returns markup.

/** A box in layout units: x across the cell, y down it (VDD at y = 0), z up from the silicon surface. */
export interface Box3 { x0: number; x1: number; y0: number; y1: number; z0: number; z1: number; cls: string; title?: string }
/** Orbit camera: yaw turns the cell about the vertical axis, pitch 90° looks straight down (the 2D layout). */
export interface View3 { yaw: number; pitch: number }

const rad = Math.PI / 180;

export function projector(v: View3) {
  const cy = Math.cos(v.yaw * rad), sy = Math.sin(v.yaw * rad), cp = Math.cos(v.pitch * rad), sp = Math.sin(v.pitch * rad);
  return {
    /** Screen x, y of a point (y down, like the layout's). */
    at: (x: number, y: number, z: number): [number, number] => [x * cy - y * sy, (x * sy + y * cy) * sp - z * cp],
    /** Direction towards the viewer, in layout coordinates. */
    eye: [sy * cp, cy * cp, sp] as const,
  };
}

/** Back-to-front order. Two boxes whose outlines overlap on screen are ordered by any plane that separates them: the
 *  viewer's side of that plane is in front (for disjoint convex solids every separating plane gives the same answer). */
export function paintOrder(boxes: Box3[], v: View3): number[] {
  const p = projector(v), [ex, ey, ez] = p.eye;
  const ext = boxes.map((b) => {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const x of [b.x0, b.x1]) for (const y of [b.y0, b.y1]) for (const z of [b.z0, b.z1]) {
      const [sx, sy] = p.at(x, y, z);
      x0 = Math.min(x0, sx); x1 = Math.max(x1, sx); y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
    }
    return { x0, x1, y0, y1 };
  });
  const eps = 1e-9;
  // 1: a drawn before b, -1: b before a, 0: no constraint.
  const before = (a: Box3, b: Box3): number => {
    const sep = (a0: number, a1: number, b0: number, b1: number, e: number) =>
      a1 <= b0 + eps ? (e > eps ? 1 : e < -eps ? -1 : 0) : b1 <= a0 + eps ? (e > eps ? -1 : e < -eps ? 1 : 0) : 0;
    return sep(a.z0, a.z1, b.z0, b.z1, ez) || sep(a.x0, a.x1, b.x0, b.x1, ex) || sep(a.y0, a.y1, b.y0, b.y1, ey);
  };
  const n = boxes.length, after: number[][] = boxes.map(() => []), deg = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const A = ext[i], B = ext[j];
    if (A.x1 <= B.x0 + eps || B.x1 <= A.x0 + eps || A.y1 <= B.y0 + eps || B.y1 <= A.y0 + eps) continue;
    const o = before(boxes[i], boxes[j]);
    if (o > 0) { after[i].push(j); deg[j]++; } else if (o < 0) { after[j].push(i); deg[i]++; }
  }
  // Kahn's algorithm, the farthest ready box first; a cycle (touching boxes on screen) falls back to depth.
  const depth = boxes.map((b) => ((b.x0 + b.x1) / 2) * ex + ((b.y0 + b.y1) / 2) * ey + ((b.z0 + b.z1) / 2) * ez);
  const done = new Array<boolean>(n).fill(false), out: number[] = [];
  while (out.length < n) {
    let k = -1;
    for (let i = 0; i < n; i++) if (!done[i] && deg[i] === 0 && (k < 0 || depth[i] < depth[k])) k = i;
    if (k < 0) for (let i = 0; i < n; i++) if (!done[i] && (k < 0 || depth[i] < depth[k])) k = i;
    done[k] = true; out.push(k);
    for (const j of after[k]) deg[j]--;
  }
  return out;
}

/** The union of rectangles [x, y, w, h] as disjoint ones (row bands, runs merged down), so overlapping pieces of one
 *  drawn shape become solids that do not cut into each other. */
export function disjoint(rs: [number, number, number, number][]): [number, number, number, number][] {
  const xs = [...new Set(rs.flatMap(([x, , w]) => [x, x + w]))].sort((a, b) => a - b);
  const ys = [...new Set(rs.flatMap(([, y, , h]) => [y, y + h]))].sort((a, b) => a - b);
  const out: [number, number, number, number][] = [];
  let open = new Map<string, [number, number, number, number]>();
  for (let j = 0; j + 1 < ys.length; j++) {
    const y0 = ys[j], y1 = ys[j + 1], next = new Map<string, [number, number, number, number]>();
    for (let i = 0; i + 1 < xs.length;) {
      const inside = (k: number) => rs.some(([x, y, w, h]) => x <= xs[k] && xs[k + 1] <= x + w && y <= y0 && y1 <= y + h);
      if (!inside(i)) { i++; continue; }
      let k = i;
      while (k + 2 < xs.length && inside(k + 1)) k++;
      const key = `${xs[i]}:${xs[k + 1]}`, prev = open.get(key);
      if (prev) { prev[3] += y1 - y0; next.set(key, prev); open.delete(key); } else { const r: [number, number, number, number] = [xs[i], y0, xs[k + 1] - xs[i], y1 - y0]; out.push(r); next.set(key, r); }
      i = k + 1;
    }
    open = next;
  }
  return out;
}

const pts = (q: [number, number][]) => q.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ');

/** The boxes as SVG markup, back to front: per box a group with its visible faces (`s1` / `s2` sides, `t` top). */
export function boxesSvg(boxes: Box3[], v: View3): string {
  const p = projector(v), [ex, ey] = p.eye;
  let s = '';
  for (const i of paintOrder(boxes, v)) {
    const b = boxes[i], P = p.at;
    const x = ex > 0 ? b.x1 : b.x0, y = ey > 0 ? b.y1 : b.y0;
    const sx = pts([P(x, b.y0, b.z0), P(x, b.y1, b.z0), P(x, b.y1, b.z1), P(x, b.y0, b.z1)]);
    const sy = pts([P(b.x0, y, b.z0), P(b.x1, y, b.z0), P(b.x1, y, b.z1), P(b.x0, y, b.z1)]);
    const top = pts([P(b.x0, b.y0, b.z1), P(b.x1, b.y0, b.z1), P(b.x1, b.y1, b.z1), P(b.x0, b.y1, b.z1)]);
    s += `<g class="${b.cls}">${b.title ? `<title>${b.title}</title>` : ''}<polygon class="s1" points="${sx}"/><polygon class="s2" points="${sy}"/><polygon class="t" points="${top}"/></g>`;
  }
  return s;
}
