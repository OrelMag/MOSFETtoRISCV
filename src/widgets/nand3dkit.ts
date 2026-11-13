// The 3D NAND block on the studio renderer (DOM-free; 1 unit = 10 nm, y up the stack, word lines along x, bit lines along z):
// flash/string3d.ts's geometry, phys/fgate.ts's rules. One pillar (CHOSEN, in the row the cut goes through) carries a Bank of
// 32 charges: a program pulse puts electrons into its nitride at one word line, an erase empties them, and a read lights its
// channel when the string conducts. The other pillars are drawn, not simulated.

import { lathe, merge, sphere, transform, type Geo } from '../gl/kit/geo';
import { M } from '../gl/kit/materials';
import type { Beat, Item, Model3, StudioAnchor } from '../gl/kit/scene';
import type { Mat4, Vec3 } from '../gl/math';
import {
  BLOCK_X, CHOSEN, CORE_NM, HOLES, HOLE_NM, HOLE_PITCH, LEVELS, ONO_NM, ONO_SPLIT_NM, PITCH_NM, POLY_NM, RINGS, ROW_Z, SLIT_NM, SLIT_W, SLIT_Z, STACK_TOP, STAIR_K, STAIR_UM, TREAD,
  WORD_LINES, levelEnd, levelOfWl, levelY,
} from '../flash/string3d';
import { V_READ } from '../lib/flash';
import { E_FULL, PASS_V, electrons, stringConducts, type Bank } from '../phys/fgate';

type Detail = 'full' | 'flat';
const tr = (p: Vec3): Mat4 => { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; m[12] = p[0]; m[13] = p[1]; m[14] = p[2]; return m; };
/** The cut: a vertical plane through the chosen pillar's row (the side z > CUT_Z is removed). */
export const CUT_Z = HOLES[CHOSEN][1];

// ---------------------------------------------------------------- a mesh builder (plates with holes)

class Mesh {
  p: number[] = []; n: number[] = []; i: number[] = [];
  v(a: Vec3, nn: Vec3): number { this.p.push(a[0], a[1], a[2]); this.n.push(nn[0], nn[1], nn[2]); return this.p.length / 3 - 1; }
  /** A triangle wound to face along nn. */
  tri(a: number, b: number, c: number, nn: Vec3): void {
    const P = this.p, e1 = [P[3 * b] - P[3 * a], P[3 * b + 1] - P[3 * a + 1], P[3 * b + 2] - P[3 * a + 2]], e2 = [P[3 * c] - P[3 * a], P[3 * c + 1] - P[3 * a + 1], P[3 * c + 2] - P[3 * a + 2]];
    const g = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    if (g[0] * nn[0] + g[1] * nn[1] + g[2] * nn[2] >= 0) this.i.push(a, b, c); else this.i.push(a, c, b);
  }
  quad(ps: Vec3[], nn: Vec3): void { const [a, b, c, d] = ps.map((p) => this.v(p, nn)); this.tri(a, b, c, nn); this.tri(a, c, d, nn); }
  /** An axis-aligned box, split at z = CUT_Z when it straddles it (the flat view drops a triangle by its centre). */
  box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): void {
    if (z0 < CUT_Z - 1e-9 && z1 > CUT_Z + 1e-9) { this.box(x0, x1, y0, y1, z0, CUT_Z); this.box(x0, x1, y0, y1, CUT_Z, z1); return; }
    this.quad([[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], [0, 1, 0]); this.quad([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], [0, -1, 0]);
    this.quad([[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]], [0, 0, -1]); this.quad([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1]);
    this.quad([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], [-1, 0, 0]); this.quad([[x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]], [1, 0, 0]);
  }
  done(name: string): Geo {
    const positions = new Float32Array(this.p), min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < positions.length; k += 3) for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], positions[k + a]); max[a] = Math.max(max[a], positions[k + a]); }
    return { name, positions, normals: new Float32Array(this.n), indices: new Uint32Array(this.i), min, max };
  }
}

/** The plate's inner edge, short of the slits. */
const Z_IN = SLIT_Z - SLIT_W / 2;
interface Rect { x0: number; x1: number; z0: number; z1: number; hole?: readonly [number, number] }
/** The plate's top view as rectangles: one round each hole (rows as bricks), fillers at the ends and over the stair. */
export function plateRects(xEnd: number): Rect[] {
  const bands = [-Z_IN, (ROW_Z[0] + ROW_Z[1]) / 2, (ROW_Z[1] + ROW_Z[2]) / 2, (ROW_Z[2] + ROW_Z[3]) / 2, Z_IN], out: Rect[] = [], half = HOLE_PITCH / 2;
  const fill = (x0: number, x1: number, z0: number, z1: number) => {
    if (x1 - x0 < 1e-9) return;
    if (z0 < CUT_Z - 1e-9 && z1 > CUT_Z + 1e-9) out.push({ x0, x1, z0, z1: CUT_Z }, { x0, x1, z0: CUT_Z, z1 }); else out.push({ x0, x1, z0, z1 });
  };
  ROW_Z.forEach((z, r) => {
    const z0 = bands[r], z1 = bands[r + 1];
    let x = -BLOCK_X;
    for (const h of HOLES.filter((q) => q[1] === z)) { fill(x, h[0] - half, z0, z1); out.push({ x0: h[0] - half, x1: h[0] + half, z0, z1, hole: h }); x = h[0] + half; }
    fill(x, BLOCK_X, z0, z1);
  });
  fill(BLOCK_X, xEnd, -Z_IN, Z_IN);
  return out;
}

/** One slab from y0 to y1 over plateRects(xEnd), with the holes through it: top and bottom, the holes' walls, the outer walls. */
function slab(m: Mesh, y0: number, y1: number, xEnd: number, seg: number): void {
  const R = RINGS.hole, at = (p: Vec3, y: number): Vec3 => [p[0], y, p[2]];
  if (seg === 0) {
    // the flat view (SVG, a polygon per triangle): boxes, the front half whole, the back half notched round the cut row's holes
    m.box(-BLOCK_X, xEnd, y0, y1, CUT_Z, Z_IN);
    let x = -BLOCK_X;
    for (const h of HOLES.filter((q) => q[1] === CUT_Z)) { m.box(x, h[0] - R, y0, y1, -Z_IN, CUT_Z); m.box(h[0] - R, h[0] + R, y0, y1, -Z_IN, CUT_Z - R); x = h[0] + R; }
    m.box(x, xEnd, y0, y1, -Z_IN, CUT_Z);
    return;
  }
  for (const r of plateRects(xEnd)) {
    if (!r.hole) {
      m.quad([[r.x0, y1, r.z0], [r.x1, y1, r.z0], [r.x1, y1, r.z1], [r.x0, y1, r.z1]], [0, 1, 0]);
      m.quad([[r.x0, y0, r.z0], [r.x1, y0, r.z0], [r.x1, y0, r.z1], [r.x0, y0, r.z1]], [0, -1, 0]);
      continue;
    }
    // a rectangle round a circle: the circle's points and the rectangle's at the same angles (its corners included), joined in quads
    const [cx, cz] = r.hole, corners = [[r.x1, r.z1], [r.x0, r.z1], [r.x0, r.z0], [r.x1, r.z0]].map(([x, z]) => Math.atan2(z - cz, x - cx));
    const angs = [...Array.from({ length: seg }, (_, k) => (2 * Math.PI * k) / seg - Math.PI), ...corners].sort((a, b) => a - b);
    const ring: Vec3[] = [], edge: Vec3[] = [];
    for (const t of angs) {
      const c = Math.cos(t), s = Math.sin(t);
      const kx = c > 1e-12 ? (r.x1 - cx) / c : c < -1e-12 ? (r.x0 - cx) / c : Infinity, kz = s > 1e-12 ? (r.z1 - cz) / s : s < -1e-12 ? (r.z0 - cz) / s : Infinity, k = Math.min(kx, kz);
      ring.push([cx + R * c, 0, cz + R * s]); edge.push([cx + k * c, 0, cz + k * s]);
    }
    for (let k = 0; k < angs.length; k++) {
      const k2 = (k + 1) % angs.length;
      m.quad([at(ring[k], y1), at(ring[k2], y1), at(edge[k2], y1), at(edge[k], y1)], [0, 1, 0]);
      m.quad([at(ring[k], y0), at(ring[k2], y0), at(edge[k2], y0), at(edge[k], y0)], [0, -1, 0]);
    }
    for (let k = 0; k < seg; k++) {
      const t0 = (2 * Math.PI * k) / seg, t1 = (2 * Math.PI * (k + 1)) / seg, tm = (t0 + t1) / 2;
      const p0: Vec3 = [cx + R * Math.cos(t0), 0, cz + R * Math.sin(t0)], p1: Vec3 = [cx + R * Math.cos(t1), 0, cz + R * Math.sin(t1)];
      m.quad([at(p0, y0), at(p1, y0), at(p1, y1), at(p0, y1)], [-Math.cos(tm), 0, -Math.sin(tm)]);
    }
  }
  const x0 = -BLOCK_X;
  for (const [x, nx] of [[x0, -1], [xEnd, 1]] as const) {
    m.quad([[x, y0, -Z_IN], [x, y0, CUT_Z], [x, y1, CUT_Z], [x, y1, -Z_IN]], [nx, 0, 0]);
    m.quad([[x, y0, CUT_Z], [x, y0, Z_IN], [x, y1, Z_IN], [x, y1, CUT_Z]], [nx, 0, 0]);
  }
  m.quad([[x0, y0, -Z_IN], [xEnd, y0, -Z_IN], [xEnd, y1, -Z_IN], [x0, y1, -Z_IN]], [0, 0, -1]);
  m.quad([[x0, y0, Z_IN], [xEnd, y0, Z_IN], [xEnd, y1, Z_IN], [x0, y1, Z_IN]], [0, 0, 1]);
}

// ---------------------------------------------------------------- geometry

/** Solids that touch are drawn this far apart (0.2 nm): the renderer shades a cut solid's inside as its cap, so a face shared with a
 *  neighbour would fight it. */
const E = 0.02;
type RingName = 'blocking' | 'nitride' | 'tunnel' | 'poly' | 'core';
interface Statics { wl: Geo; dummy: Geo; select: Geo; oxide: Geo; rings: Record<RingName, Geo>; chosenPoly: Geo; slits: Geo; sub: Geo; contacts: Geo; bitlines: Geo; plugs: Geo; electron: Geo }
const memo = new Map<Detail, Statics>();
/** A ring (r0 > 0) or a rod, from y0 to y1: its profile counter-clockwise, so the faces point out. */
const tubeY = (r0: number, r1: number, y0: number, y1: number, seg: number) =>
  lathe(r0 > 0 ? [[r0 + E, y1], [r0 + E, y0], [r1 - E, y0], [r1 - E, y1], [r0 + E, y1]] : [[0, y0], [r1 - E, y0], [r1 - E, y1], [0, y1]], { seg });
/** The pillars run from just into the substrate to just over the stack, where the bit-line plugs land. */
export const PILLAR_Y0 = E, PILLAR_Y1 = STACK_TOP + 1;
/** Bit lines on top (drawn: their height over the stack and their width are typical). */
export const BL_Y = [STACK_TOP + 6, STACK_TOP + 9] as const;
export const SUB_Y0 = -14;
/** A word-line contact's radius: as thick as a tread allows (a hair-thin rod shimmers at home), 0.3 units of tread left each side. */
export const CONTACT_R = TREAD / 2 - 0.3;

function statics(d: Detail): Statics {
  const hit = memo.get(d);
  if (hit) return hit;
  const seg = d === 'flat' ? 8 : 28, small = d === 'flat' ? 6 : 16, plateSeg = d === 'flat' ? 0 : seg;
  const slabs = (kinds: readonly string[]) => { const m = new Mesh(); LEVELS.forEach((l, i) => { if (kinds.includes(l.kind)) { const [y0, y1] = levelY(i); slab(m, y0, y1, levelEnd(i), plateSeg); } }); return m.done(kinds.join('+')); };
  // the oxide: under each level's plate out to the same tread, and a cap over the top level
  const ox = new Mesh();
  LEVELS.forEach((_, i) => { const y0 = levelY(i)[0], yb = i === 0 ? 0 : levelY(i - 1)[1]; slab(ox, yb + E, y0 - E, levelEnd(i), plateSeg); });
  slab(ox, levelY(LEVELS.length - 1)[1] + E, STACK_TOP, BLOCK_X, plateSeg);
  // the pillars: every hole's rings merged; the chosen one's channel apart, so it can light
  const at = (h: readonly [number, number]) => tr([h[0], 0, h[1]]);
  const all = (g: Geo, name: string, skip = -1) => merge(HOLES.flatMap((h, i) => (i === skip ? [] : [transform(g, at(h))])), name);
  const ring = (r: readonly [number, number]) => tubeY(r[0], r[1], PILLAR_Y0, PILLAR_Y1, seg);
  const rings: Record<RingName, Geo> = {
    blocking: all(ring(RINGS.blocking), 'blocking'), nitride: all(ring(RINGS.nitride), 'nitride'), tunnel: all(ring(RINGS.tunnel), 'tunnel'),
    poly: all(ring(RINGS.poly), 'poly', CHOSEN), core: all(tubeY(0, RINGS.core, PILLAR_Y0, PILLAR_Y1, seg), 'core'),
  };
  const chosenPoly = transform(ring(RINGS.poly), at(HOLES[CHOSEN]));
  const xMax = levelEnd(0);
  const sw = new Mesh();
  // the slits cut through the stack as it stands: full height over the array, then down the staircase a tread at a time (a slit
  // at full height over the treads stood as a wall behind them, its top edge a stray line in the home view)
  const top = LEVELS.length - 1;
  for (const z of [-SLIT_Z, SLIT_Z]) {
    const z0 = z - SLIT_W / 2 + E, z1 = z + SLIT_W / 2 - E;
    sw.box(-BLOCK_X - 6, levelEnd(top), E, STACK_TOP, z0, z1);
    for (let i = top - 1; i >= 0; i--) sw.box(levelEnd(i + 1) + E, levelEnd(i) + (i === 0 ? 4 : 0), E, levelY(i)[1], z0, z1);
  }
  const sub = new Mesh();
  sub.box(-BLOCK_X - 10, xMax + 8, SUB_Y0, 0, -SLIT_Z - 8, SLIT_Z + 8);
  // the staircase's contacts: one per level, from its tread to the metal over the stack
  const contacts = merge(LEVELS.map((_, i) => transform(tubeY(0, CONTACT_R, levelY(i)[1] + E, BL_Y[0] - E, small), tr([levelEnd(i) - TREAD / 2, 0, 0]))), 'contacts');
  // bit lines across the word lines, one over each column of holes, and a plug down to each pillar
  const bl = new Mesh();
  for (const x of [...new Set(HOLES.map((h) => h[0]))]) bl.box(x - 1.5, x + 1.5, BL_Y[0], BL_Y[1], -SLIT_Z - 8, SLIT_Z + 8);
  const st: Statics = {
    wl: slabs(['wl']), dummy: slabs(['dummy']), select: slabs(['gsl', 'ssl']), oxide: ox.done('oxide'), rings, chosenPoly,
    slits: sw.done('slits'), sub: sub.done('substrate'), contacts, bitlines: bl.done('bitlines'),
    plugs: all(tubeY(0, 2.4, PILLAR_Y1 + E, BL_Y[0] - E, small), 'plugs'), electron: sphere(ELECTRON_R, d === 'flat' ? 4 : 8, d === 'flat' ? 3 : 5),
  };
  memo.set(d, st);
  return st;
}

// ---------------------------------------------------------------- materials

export const SRC = {
  tem: 'TechInsights\' TEMs of Samsung\'s 32-layer V-NAND, analysed by 3DInCites (3dincites.com/?p=8892)',
  chipworks: 'Chipworks\' teardown (Dick James, Semiconductor Digest): 32 word lines, 4 dummies, a select gate at each end',
  pitch: 'TechInsights (2022): Samsung\'s 128-layer V-NAND, 44 nm a layer',
};
export const MATS = {
  tungsten: M.make({ base: [0.62, 0.63, 0.66], metal: 0.95, rough: 0.32, label: 'tungsten' }),
  dummy: M.make({ base: [0.44, 0.45, 0.48], metal: 0.9, rough: 0.42, label: 'tungsten (a dummy word line)' }),
  select: M.make({ base: [0.75, 0.58, 0.32], metal: 0.9, rough: 0.35, label: 'tungsten (a select gate, tinted)' }),
  oxide: M.make({ base: [0.78, 0.84, 0.9], metal: 0, rough: 0.5, label: 'silicon dioxide' }),
  blocking: M.make({ base: [0.5, 0.72, 0.84], metal: 0, rough: 0.45, label: 'silicon dioxide (blocking oxide)' }),
  nitride: M.make({ base: [0.88, 0.56, 0.24], metal: 0, rough: 0.5, label: 'silicon nitride (the charge trap)' }),
  tunnel: M.make({ base: [0.86, 0.92, 0.97], metal: 0, rough: 0.45, label: 'silicon dioxide (tunnel oxide)' }),
  poly: M.make({ base: [0.42, 0.34, 0.46], metal: 0.3, rough: 0.4, label: 'polysilicon' }),
  polyOn: M.make({ base: [0.62, 0.48, 0.3], metal: 0.3, rough: 0.4, emit: [1, 0.62, 0.22], glow: 0.9, bloom: 2.5, label: 'polysilicon, conducting' }),
  core: M.make({ base: [0.9, 0.91, 0.93], metal: 0, rough: 0.6, label: 'silicon dioxide (the core)' }),
  si: M.silicon,
  copper: M.make({ base: [0.85, 0.6, 0.45], metal: 1, rough: 0.3, label: 'copper' }),
  electron: M.make({ base: [0.2, 0.5, 1], metal: 0, rough: 0.4, emit: [0.35, 0.65, 1], glow: 1, bloom: 2, label: 'trapped electrons' }),
};

// ---------------------------------------------------------------- the model

/** section: cut down through the chosen row; ring: cut across the chosen word line's middle (every hole a set of rings in its plate). */
export type NandCut = 'section' | 'ring';
export interface NandState { bank: Bank; reading: boolean; cut?: NandCut }
/** The beats that cut across the word line. */
export const RING_BEATS = [2, 3];
export const freshString = (): Bank => ({ q: Array<number>(WORD_LINES).fill(0), sel: 12 });

/** Electrons drawn in the chosen pillar's nitride at each word line, as many as the cell's charge says: in the section the cut makes
 *  (a hair behind the cut plane, so the cut leaves them), half each side of the axis, on a grid across the trap's thickness and the
 *  word line's height. Behind the section they would be hidden by the rings inside the trap. */
export function trappedAt(bank: Bank, cut: NandCut = 'section'): Vec3[] {
  const [hx, hz] = HOLES[CHOSEN], [r0, r1] = RINGS.nitride, out: Vec3[] = [], cols = 2, rows = E_FULL / 2 / cols;
  bank.q.forEach((q, w) => {
    const [y0, y1] = levelY(levelOfWl(w));
    for (let k = 0; k < electrons(q); k++) {
      if (cut === 'ring') {
        // round the ring, a hair under the cut through the word line's middle
        // one row round the ring, drawn RING_SCALE times larger (the nitride holds one across)
        const a = (2 * Math.PI * k) / E_FULL, rad = (r0 + r1) / 2;
        out.push([hx + rad * Math.cos(a), (y0 + y1) / 2 - ELECTRON_R * RING_SCALE, hz + rad * Math.sin(a)]);
        continue;
      }
      const side = k % 2 ? 1 : -1, j = Math.floor(k / 2), c = j % cols, r = Math.floor(j / cols);
      const rad = r0 + ((c + 0.5) / cols) * (r1 - r0), y = y0 + ((r + 0.5) / rows) * (y1 - y0);
      out.push([hx + side * rad, y, hz - ELECTRON_R]);
    }
  });
  return out;
}
/** A drawn electron's radius: the nitride's thickness holds two across. */
export const ELECTRON_R = (RINGS.nitride[1] - RINGS.nitride[0]) / 5, RING_SCALE = 2;

export const NAND_HOME = { yaw: -0.6, pitch: 0.38, target: [30, 78, 0] as Vec3, dist: 560 };

export function nandModel(s: NandState, detail: Detail = 'full'): Model3 {
  const S = statics(detail), on = s.reading && stringConducts(s.bank), ono = `ONO ${ONO_NM} nm in all (${SRC.tem}); its split typical`;
  const items: Item[] = [
    { geo: S.sub, mat: MATS.si, name: 'substrate', group: 'base', info: { note: 'the silicon under the stack: the strings\' common source is the n+ under the slits' } },
    { geo: S.wl, mat: MATS.tungsten, name: 'word line', group: 'wl',
      info: { dim: `${WORD_LINES} of them, ${PITCH_NM} nm apart (the 128-layer part's pitch: the 32-layer part's is not published); tungsten and oxide half each (typical)`, source: `${SRC.tem}: "gate all-around tungsten wordlines"`, note: 'each plate wraps every hole in the block: one cell per hole on each layer' } },
    { geo: S.dummy, mat: MATS.dummy, name: 'dummy word line', group: 'wl', info: { source: SRC.chipworks, note: 'two at each end of the string: they hold no data and spare the cells next to them the edge of the stack' } },
    { geo: S.select, mat: MATS.select, name: 'select gate', group: 'select', info: { source: SRC.chipworks, note: 'the string select at the top joins the string to its bit line, the ground select at the bottom to the source; drawn as plates like the word lines (their real shapes are not published)' } },
    { geo: S.oxide, mat: MATS.oxide, name: 'oxide between the layers', group: 'oxide', info: { dim: `${PITCH_NM / 2} nm (typical)`, note: 'insulates each word line from the next' } },
    { geo: S.rings.blocking, mat: MATS.blocking, name: 'blocking oxide', group: 'pillar', info: { dim: `${ONO_SPLIT_NM.blocking} nm (typical)`, source: ono, note: 'between the trap and the word line: charge must not leak to the gate' } },
    { geo: S.rings.nitride, mat: MATS.nitride, name: 'charge trap (nitride)', group: 'pillar', info: { dim: `${ONO_SPLIT_NM.nitride} nm (typical)`, source: ono, note: 'one tube the height of the string: an insulator, so charge stays where it lands and each cell keeps its own' } },
    { geo: S.rings.tunnel, mat: MATS.tunnel, name: 'tunnel oxide', group: 'pillar', info: { dim: `${ONO_SPLIT_NM.tunnel} nm (typical)`, source: ono, note: 'electrons cross it to program and to erase' } },
    { geo: S.rings.poly, mat: MATS.poly, name: 'channel', group: 'pillar', info: { dim: `${POLY_NM} nm polysilicon`, source: SRC.tem, note: 'the string\'s channel: a thin tube, one cell after another up the hole' } },
    { geo: S.chosenPoly, mat: on ? MATS.polyOn : MATS.poly, name: 'the chosen string\'s channel', group: 'pillar',
      info: { dim: `${POLY_NM} nm polysilicon`, source: SRC.tem, note: on ? 'conducting: every cell is on, so the chosen one is erased (reads 1)' : s.reading ? 'blocked: the chosen cell is programmed (reads 0)' : 'the string the model follows' } },
    { geo: S.rings.core, mat: MATS.core, name: 'oxide core', group: 'pillar', info: { dim: `${CORE_NM} nm (calculated: ${HOLE_NM} − 2 × ${ONO_NM} − 2 × ${POLY_NM})`, source: SRC.tem } },
    { geo: S.slits, mat: MATS.tungsten, name: 'slit (common source)', group: 'slit', info: { dim: `${SLIT_NM} nm slit to slit; drawn ${SLIT_W * 10} nm wide (typical)`, source: `${SRC.tem}: "vertical tungsten slits"`, note: 'cuts the stack into blocks and carries the source down to the substrate' } },
    { geo: S.contacts, mat: MATS.tungsten, name: 'word-line contact', group: 'stair', info: { dim: `one per level; the staircase is about ${STAIR_UM} µm wide, drawn ${STAIR_K}× shorter`, source: `${SRC.tem}: "a space of about 20µm"`, note: 'each level steps out from under the one above, so a contact can land on it' } },
    { geo: S.bitlines, mat: MATS.copper, name: 'bit line', group: 'top', info: { dim: 'drawn (typical)', note: 'across the word lines: one per column of holes here (in the real block every hole in a row has a bit line of its own)' } },
    { geo: S.plugs, mat: MATS.copper, name: 'bit line', group: 'top' },
  ];
  const es = s.cut === 'ring' ? RING_SCALE : 1;
  for (const p of trappedAt(s.bank, s.cut)) items.push({ geo: S.electron, mat: MATS.electron, at: p, scale: [es, es, es], name: 'trapped electrons', group: 'charge', cut: 'none', shadow: false, info: { note: 'drawn: a real cell holds a few hundred' } });
  const front: Vec3 = [0, 0, 1], up: Vec3 = [0, 1, 0], side: Vec3 = [-1, 0, 0], [hx, hz] = HOLES[CHOSEN];
  const anchors: StudioAnchor[] = [
    { text: 'bit lines', p: [-BLOCK_X + 13, BL_Y[1], -20], side: 'l', n: up, on: 'top' },
    { text: 'string select', p: [-BLOCK_X, levelY(LEVELS.length - 1)[1], -10], side: 'l', n: side, on: 'select' },
    { text: 'word lines', p: [-BLOCK_X, levelY(20)[1], -10], side: 'l', n: side, on: 'wl' },
    { text: 'ground select', p: [-BLOCK_X, levelY(0)[1], -10], side: 'l', n: side, on: 'select' },
    { text: 'channel hole', p: [hx, STACK_TOP * 0.62, hz], side: 'r', n: front, on: 'pillar' },
    { text: 'staircase', p: [levelEnd(12) - TREAD / 2, levelY(12)[1], 0], side: 'r', n: up, on: 'wl' },
    { text: 'slit', p: [BLOCK_X - 10, STACK_TOP, -SLIT_Z], side: 'r', n: up, on: 'slit', minor: true },
  ];
  const cuts = s.cut === 'ring' ? { planes: [{ n: [0, 1, 0] as Vec3, d: wlMid(s.bank.sel) }], open: [BL_Y[1] + 20] } : { planes: [{ n: [0, 0, 1] as Vec3, d: CUT_Z }], open: [SLIT_Z + 20] };
  return { items, anchors, beats: beats(s), cuts, floor: SUB_Y0, look: { exposure: 1.05, keyDir: [-0.45, 0.8, 0.45] } };
}

const wlMid = (w: number) => { const [a, b] = levelY(levelOfWl(w)); return (a + b) / 2; };
function beats(s: NandState): Beat[] {
  const [hx, hz] = HOLES[CHOSEN], w = s.bank.sel, tall = ((STACK_TOP * 10) / 1000).toFixed(2);
  // the ring beats look down on the cut across word line w (RING_BEATS); the section beats look level into the cut down the row
  const close = { yaw: -0.35, pitch: 0.95, target: [hx, wlMid(w), hz] as Vec3, dist: 40 };
  return [
    { title: 'A block', text: `Samsung's second V-NAND: ${LEVELS.length} levels of tungsten and oxide, ${tall} µm tall, cut into blocks by slits ${SLIT_NM} nm apart. Every round hole through the stack is one string of ${WORD_LINES} cells.`, view: NAND_HOME, cut: 0, explode: 0 },
    { title: 'One hole, cut', text: `The hole is ${HOLE_NM} nm across when etched, then lined from the outside in: blocking oxide, silicon nitride, tunnel oxide (${ONO_NM} nm together), ${POLY_NM} nm of polysilicon for the channel, and an oxide core. Rings, not layers.`, view: { yaw: -0.12, pitch: 0, target: [hx, STACK_TOP * 0.55, hz], dist: 150 }, cut: 1, explode: 0 },
    { title: 'A cell is a ring', text: `Where a word line wraps the hole, the rings inside it make one cell: the planar cell's gate, oxide, trap and channel rolled into a tube with the gate all round. This is word line ${w}, ${PITCH_NM} nm from its neighbours.`, view: close, show: ['pillar', 'wl', 'charge'], cut: 1, explode: 0 },
    { title: 'Program', text: 'A high voltage on one word line pulls electrons out of the channel, through the tunnel oxide and into the nitride, at that layer only. Nitride is an insulator, so the charge stays where it lands: the cells above and below share the tube but not its charge.', view: close, show: ['pillar', 'charge'], cut: 1, explode: 0 },
    { title: 'Read', text: `The chosen word line goes to the read voltage (${V_READ} V) and the ${WORD_LINES - 1} others to the pass voltage (${PASS_V} V). The channel conducts the whole height of the pillar only if the chosen cell is erased: the chapter's NAND string, stood on end.`, view: { yaw: -0.3, pitch: 0, target: [hx + 25, STACK_TOP * 0.5, hz], dist: 250 }, show: ['pillar', 'select', 'charge'], cut: 1, explode: 0 },
    { title: 'The staircase', text: `Every level needs a contact of its own, so each one steps out from under the level above: about ${STAIR_UM} µm of treads for ${LEVELS.length} levels, drawn ${STAIR_K} times shorter here.`, view: { yaw: -0.75, pitch: 0.38, target: [levelEnd(19), 85, 0], dist: 330 }, show: ['stair', 'wl', 'select'], hide: ['slit'], cut: 0, explode: 0 },
    { title: 'Why up', text: `One bit-line contact serves ${WORD_LINES} cells stacked in one hole. Planar cells stopped shrinking near 15 nm; here a cell is ${HOLE_NM} nm across and the density comes from the layers. Samsung's 176-layer part stacks its layers 43 nm apart (TechInsights).`, view: NAND_HOME, cut: 1, explode: 0 },
  ];
}
