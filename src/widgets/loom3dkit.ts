// The Jacquard head for the studio renderer (DOM-free, tested). Where everything is, and how it moves through a pick, is
// loom3dparts.ts's (the tested drawing of Posselt's single-lift head on cards.ts's weave); this gives it stuff: oak for the
// frame, the prism and the boards, cast iron for the hooks and the griffe, steel needles and springs, pasteboard cards,
// linen cords, lead lingoes, a brass reed, cotton warp and weft. Its boxes and rods are tagged by what they are made of and
// baked straight into one mesh per material each frame (the head moves all through a pick), the hooks a pick lifts and their
// cords lit. A tour poses the pick at the moments that carry the idea: the card on the needles, the lift, the shed, the row.

import { M, type Material } from '../gl/kit/materials';
import { merge, torus, transform, tube, type Geo } from '../gl/kit/geo';
import type { Beat, Item, Model3, StudioAnchor } from '../gl/kit/scene';
import { UNIT_BOX, UNIT_CYL } from '../gl/kit/fromparts';
import type { OrbitView } from '../gl/camera';
import type { Part } from '../gl/parts';
import type { Mat4, Vec3 } from '../gl/math';
import {
  CYL_BACK, CYL_Z, HOOK_BAR_X, HOOK_PITCH, HOOK_ROW, HOOK_X, HOOK_Y0, HOOK_Y1, HOOK_Z, NEEDLE_H, NEEDLE_Y, ROW_A, SPRING_Z,
  loomAnchors, loomParts, type Cards, type LoomPalette, type Pose,
} from './loom3dparts';
import { HOOKS, WARP } from './cards';

export type Role = Exclude<keyof LoomPalette, 'live'>;
const ROLES: Role[] = ['wood', 'iron', 'steel', 'spring', 'card', 'hole', 'warp', 'weft', 'cord', 'lead', 'brass'];
/** loomParts with each part's colour standing for its stuff: the geometry stays the one the tests pin. */
const ROLE_PALETTE = Object.fromEntries([...ROLES, 'live'].map((r) => [r, r])) as unknown as LoomPalette;
export const roleOf = (p: Part): Role => p.color as unknown as Role;

const mk = (m: Material): Material => M.make(m);
export const MATS: Record<Role, Material> = {
  wood: mk({ ...M.oak, base: '--lm-wood', label: 'wood: the frame, the prism, the boards and the shuttle' }),
  iron: mk({ base: '--lm-iron', metal: 0.7, rough: 0.5, label: 'iron: hooks and the griffe' }),
  steel: mk({ ...M.steel, label: 'steel: the needles' }),
  spring: mk({ base: '--lm-spring', metal: 0.85, rough: 0.3, label: 'spring wire: holds each needle forward' }),
  card: mk({ ...M.card, base: '--lm-card', label: 'pasteboard cards (drawn ten times too thick)' }),
  hole: mk({ base: '--lm-hole', metal: 0, rough: 0.9, label: 'a hole’s pit in the prism' }),
  warp: mk({ base: '--lm-warp', metal: 0, rough: 0.8, label: 'warp threads' }),
  weft: mk({ base: '--lm-weft', metal: 0, rough: 0.8, label: 'weft thread' }),
  cord: mk({ base: '--lm-cord', metal: 0, rough: 0.85, label: 'linen harness cords' }),
  lead: mk({ base: '--lm-lead', metal: 0.6, rough: 0.55, label: 'lingoes: lead weights that pull the threads back down' }),
  brass: mk({ ...M.brass, base: '--lm-brass', label: 'brass: the heddle eyes, the reed' }),
};
/** A part the pick lifts (a hook over the knife, its cord): its stuff, lit. */
const litOf = (r: Role): Material => mk({ ...MATS[r], emit: '--m3-charge', glow: 0.55, label: `${MATS[r].label}, lifted this pick` });
const NAME: Record<Role, string> = {
  wood: 'wood', iron: 'iron', steel: 'needles', spring: 'springs', card: 'cards', hole: 'holes', warp: 'warp', weft: 'weft', cord: 'cords', lead: 'lingoes', brass: 'brass',
};
const GROUP: Record<Role, string> = {
  wood: 'frame', iron: 'head', steel: 'head', spring: 'head', card: 'chain', hole: 'chain', warp: 'cloth', weft: 'cloth', cord: 'harness', lead: 'harness', brass: 'harness',
};

/** Boxes and rods (unit box / cylinder, scaled, turned, moved) baked into one mesh: hundreds of them a frame. */
export function bake(parts: readonly Part[], name: string): Geo {
  let nv = 0, ni = 0;
  for (const p of parts) { const g = p.kind === 'box' ? UNIT_BOX : UNIT_CYL; nv += g.positions.length / 3; ni += g.indices.length; }
  const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), idx = new Uint32Array(ni);
  const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let v = 0, i = 0;
  for (const p of parts) {
    const g = p.kind === 'box' ? UNIT_BOX : UNIT_CYL, [sx, sy, sz] = p.scale ?? [1, 1, 1], [qx, qy, qz, qw] = p.rot ?? [0, 0, 0, 1];
    const rot = (x: number, y: number, z: number, out: Float32Array, o: number, add: readonly number[] | null) => {
      // v + 2w(q × v) + 2 q × (q × v)
      const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
      out[o] = x + qw * tx + (qy * tz - qz * ty) + (add ? add[0] : 0);
      out[o + 1] = y + qw * ty + (qz * tx - qx * tz) + (add ? add[1] : 0);
      out[o + 2] = z + qw * tz + (qx * ty - qy * tx) + (add ? add[2] : 0);
    };
    const P = g.positions, N = g.normals, base = v;
    for (let k = 0; k < P.length; k += 3, v++) {
      rot(P[k] * sx, P[k + 1] * sy, P[k + 2] * sz, pos, 3 * v, p.pos);
      const nx = N[k] / sx, ny = N[k + 1] / sy, nz = N[k + 2] / sz, l = Math.hypot(nx, ny, nz) || 1;
      rot(nx / l, ny / l, nz / l, nor, 3 * v, null);
      for (let a = 0; a < 3; a++) { const c = pos[3 * v + a]; if (c < min[a]) min[a] = c; if (c > max[a]) max[a] = c; }
    }
    for (const t of g.indices) idx[i++] = base + t;
  }
  return { name, positions: pos, normals: nor, indices: idx, min, max };
}

/** The frame's front plane (loom3dparts.ts: zf). */
export const FRONT_Z = 30;
export const VIEWS: Record<'head' | 'whole', OrbitView> = {
  head: { target: [-6, 40, -12], yaw: 0.34, pitch: 0.26, dist: 84 },
  whole: { target: [0, 24, 10], yaw: 0.55, pitch: 0.36, dist: 175 },
};
/** Where in a pick each beat stops (T): the card pressed, the griffe up, the shuttle in the shed, the row beaten up. */
export const TOUR_T = [0.11, 0.34, 0.47, 0.74];

export function loomModel(cards: Cards, o: Pose, whole: boolean): Model3 {
  const by = new Map<string, Part[]>();
  for (const p of loomParts(cards, o, ROLE_PALETTE)) {
    if (redrawn(p)) continue;
    const key = `${roleOf(p)}${p.emissive ? ':lit' : ''}`;
    let l = by.get(key); if (!l) by.set(key, (l = [])); l.push(p);
  }
  const extra = wires(cards, o), items: Item[] = [];
  for (const r of ROLES) for (const lit of [false, true]) {
    const key = `${r}${lit ? ':lit' : ''}`, list = by.get(key) ?? [], more = extra.get(key) ?? [];
    if (!list.length && !more.length) continue;
    const geo = more.length ? merge([...(list.length ? [bake(list, r)] : []), ...more], r) : bake(list, r);
    items.push({ geo, mat: lit ? litOf(r) : MATS[r], name: lit ? `${NAME[r]} (lifted)` : NAME[r], group: GROUP[r] });
  }
  const anchors: StudioAnchor[] = loomAnchors(cards, o, whole).map((a) => ({ ...a, text: a.text.replace(' (square prism)', '') }));
  const beats: Beat[] = [
    { title: 'A card on the needles', text: `The square cylinder presses the card on ${HOOKS} sprung needles. Where the card is solid it pushes its needle back, and the needle takes its hook off the griffe’s knife; where there is a hole the needle goes in and its hook stays over the knife.`, view: { target: [7, 42, -11], yaw: 0.55, pitch: 0.22, dist: 52 }, show: ['head', 'chain'] },
    { title: 'The griffe lifts what the holes chose', text: 'The griffe rises and takes with it only the hooks still over its knives (lit). Their neck cords pull up through the comber board, each to its threads: hook j lifts threads j, j + 8, j + 16, j + 24.', view: { target: [0, 30, 0], yaw: 0.6, pitch: 0.18, dist: 120 }, show: ['head', 'harness', 'cloth'] },
    { title: 'The shed', text: `The lifted threads and the ones the lingoes hold down open a gap, the shed, and the shuttle carries the weft through it. Over or under each of the ${WARP} threads is the card’s doing.`, view: { target: [0, 6, 12], yaw: 0.3, pitch: 0.42, dist: 110 } },
    { title: 'A card is a row', text: 'The reed beats the weft up to the cloth and the row is done; the cylinder turns to the next card. Card after card, the chain is the pattern: a program the loom reads one line at a time.', view: { target: [0, 0, 24], yaw: 0.2, pitch: 0.75, dist: 95 } },
  ];
  return { items, anchors, beats, look: { exposure: 1 }, floor: -14 };
}

// ---------------------------------------------------------------- the head redrawn in true shapes

/** Parts the kit draws itself: the frame's front (left out, so the head is seen), the spring board and the needle board (left out: they
 *  stood in front of the needles and the card), the hooks (bent wire), the needles' eyes, the cylinder's prism and its cards (round holes), and
 *  the holes of the hanging chain (round). Everything else is loomParts' as it is. */
export function redrawn(p: Part): boolean {
  const r = roleOf(p), s = p.scale ?? [1, 1, 1];
  if (r === 'wood' && Math.abs(p.pos[2] - FRONT_Z) < 1e-6) return true;
  if (r === 'wood' && p.kind === 'box' && Math.abs(p.pos[2] - (SPRING_Z + 2)) < 1e-6 && s[0] > 60) return true;
  if (r === 'wood' && p.kind === 'box' && Math.abs(p.pos[2] - NEEDLE_BOARD_Z) < 1e-6) return true; // the needle board, in front of the card
  if (r === 'iron' && p.kind === 'box' && Math.abs(s[0] - 1.2) < 1e-6) return true; // hook bars and crooks
  if (r === 'steel' && p.kind === 'box' && Math.abs(s[1] - 1) < 1e-6 && Math.abs(s[2] - 1.2) < 1e-6) return true; // eye links
  if ((r === 'card' || r === 'hole' || r === 'wood') && p.rot) return true; // on the cylinder
  if (r === 'hole') return true; // the chain's holes (loomParts draws them square)
  return false;
}

/** The needle board's middle (loom3dparts.ts: z -9 to -7.8). */
const NEEDLE_BOARD_Z = -8.4;
const HOOK_R = 0.45, CARD_HOLE = 1.4, PIT = 1.05, FACE = 6;
/** A hook: the vertical wire and its crook bent over the knife. */
export function hookPath(k: number, push: number, lift: number): Vec3[] {
  const x = HOOK_BAR_X(k), z = HOOK_Z(k) + push, top = HOOK_Y1 + lift;
  return [[x, HOOK_Y0 + lift, z], [x, top, z], [x, top + 0.6, z - 1.6], [x, top - 0.4, z - 3.6], [x, top - 1.6, z - 4.2]];
}

type Mesh = { P: number[]; N: number[]; I: number[] };
/** The cylinder's frame: drum-local (x across, a along the face, r out from the axis) to world, at turn `ang`. */
const drumMap = (ang: number, away: number) => {
  const co = Math.cos(ang), si = Math.sin(ang), dz = CYL_Z - CYL_BACK * away;
  return {
    p: (x: number, a: number, r: number): Vec3 => [x, NEEDLE_Y + a * co - r * si, dz + a * si + r * co],
    n: (x: number, a: number, r: number): Vec3 => [x, a * co - r * si, a * si + r * co],
  };
};
/** A plate in the drum's frame over [x0, x1] × [a0, a1], from r0 to r1, with a round hole at (hx, ha) of radius rad (rad 0: none). */
export function plate(out: Mesh, m: ReturnType<typeof drumMap>, x0: number, x1: number, a0: number, a1: number, r0: number, r1: number, hx: number, ha: number, rad: number): void {
  const { P, N, I } = out, v = (p: Vec3, n: Vec3) => { P.push(...p); N.push(...n); return P.length / 3 - 1; };
  const quad = (a: number, b: number, c: number, d: number) => I.push(a, b, c, a, c, d);
  const side = (pts: [number, number, number][], n: [number, number, number]) => { const ids = pts.map(([x, a, r]) => v(m.p(x, a, r), m.n(...n))); quad(ids[0], ids[1], ids[2], ids[3]); };
  side([[x0, a0, r0], [x1, a0, r0], [x1, a0, r1], [x0, a0, r1]], [0, -1, 0]);
  side([[x1, a1, r0], [x0, a1, r0], [x0, a1, r1], [x1, a1, r1]], [0, 1, 0]);
  side([[x0, a1, r0], [x0, a0, r0], [x0, a0, r1], [x0, a1, r1]], [-1, 0, 0]);
  side([[x1, a0, r0], [x1, a1, r0], [x1, a1, r1], [x1, a0, r1]], [1, 0, 0]);
  if (rad <= 0) {
    side([[x0, a0, r1], [x1, a0, r1], [x1, a1, r1], [x0, a1, r1]], [0, 0, 1]);
    side([[x0, a1, r0], [x1, a1, r0], [x1, a0, r0], [x0, a0, r0]], [0, 0, -1]);
    return;
  }
  // angles round the hole, with the four corners among them so the outline keeps its corners
  const corner = (x: number, a: number) => Math.atan2(a - ha, x - hx);
  const angs = [...Array.from({ length: 24 }, (_, i) => -Math.PI + (i / 24) * 2 * Math.PI), corner(x1, a1), corner(x0, a1), corner(x0, a0), corner(x1, a0)].sort((p, q) => p - q);
  const edge = (th: number): [number, number] => {
    const c = Math.cos(th), s = Math.sin(th);
    const tx = c > 1e-9 ? (x1 - hx) / c : c < -1e-9 ? (x0 - hx) / c : Infinity, ta = s > 1e-9 ? (a1 - ha) / s : s < -1e-9 ? (a0 - ha) / s : Infinity, k = Math.min(tx, ta);
    return [hx + k * c, ha + k * s];
  };
  for (let i = 0; i < angs.length; i++) {
    const t0 = angs[i], t1 = i + 1 === angs.length ? angs[0] + 2 * Math.PI : angs[i + 1];
    const [ox0, oa0] = edge(t0), [ox1, oa1] = edge(t1);
    const c0x = hx + rad * Math.cos(t0), c0a = ha + rad * Math.sin(t0), c1x = hx + rad * Math.cos(t1), c1a = ha + rad * Math.sin(t1);
    for (const [r, s] of [[r1, 1], [r0, -1]] as const) {
      const nn = m.n(0, 0, s), ids = [v(m.p(c0x, c0a, r), nn), v(m.p(c1x, c1a, r), nn), v(m.p(ox1, oa1, r), nn), v(m.p(ox0, oa0, r), nn)];
      if (s > 0) quad(ids[0], ids[3], ids[2], ids[1]); else quad(ids[0], ids[1], ids[2], ids[3]);
    }
    // the hole's wall, facing its axis
    const n0 = m.n(-Math.cos(t0), -Math.sin(t0), 0), n1 = m.n(-Math.cos(t1), -Math.sin(t1), 0);
    const w = [v(m.p(c0x, c0a, r0), n0), v(m.p(c1x, c1a, r0), n1), v(m.p(c1x, c1a, r1), n1), v(m.p(c0x, c0a, r1), n0)];
    quad(w[0], w[3], w[2], w[1]);
  }
}
const meshGeo = (o: Mesh, name: string): Geo => {
  const positions = Float32Array.from(o.P), min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i++) { const a = i % 3; if (positions[i] < min[a]) min[a] = positions[i]; if (positions[i] > max[a]) max[a] = positions[i]; }
  return { name, positions, normals: Float32Array.from(o.N), indices: Uint32Array.from(o.I), min, max };
};
const at = (p: Vec3): Mat4 => { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; m[12] = p[0]; m[13] = p[1]; m[14] = p[2]; return m; };
/** A flat disc (a torus in xz squashed in y) stood up to face z, at (x, y, z). */
const faceZ = (x: number, y: number, z: number): Mat4 => { const m = new Float32Array(16); m.set([1, 0, 0, 0, 0, 0, 0.12, 0, 0, -1, 0, 0, x, y, z, 1]); return m; };
const mod = (a: number, n: number) => ((a % n) + n) % n;
const DISC = torus(0.7, 0.7, 20, 4);

/** The geometry the kit adds, by material key (`role` or `role:lit`). */
export function wires(cards: Cards, o: Pose): Map<string, Geo[]> {
  const out = new Map<string, Geo[]>(), add = (k: string, g: Geo) => { let l = out.get(k); if (!l) out.set(k, (l = [])); l.push(g); };
  for (let k = 0; k < HOOKS; k++) {
    const d = o.push[k], lift = o.hookLift[k], lit = o.holes[k] && lift > 0.01;
    add(lit ? 'iron:lit' : 'iron', tube(hookPath(k, d, lift), HOOK_R, { sides: 8, bend: 0.5 }));
    // the needle's eye: a loop round the hook, and the short wire from the needle to it
    const x = HOOK_BAR_X(k), nx = HOOK_X(k), ny = NEEDLE_H(k), z = HOOK_Z(k) + d;
    add('steel', transform(torus(0.95, 0.22, 16, 6), at([x, ny, z])));
    add('steel', tube([[nx, ny, z], [x + 0.95, ny, z]], 0.22, { sides: 6 }));
  }
  // the prism: a core and four perforated faces, a round pit under each hole position; the cards on them, round holes
  const b = o.p - 1, n = cards.length, prism: Mesh = { P: [], N: [], I: [] }, card: Mesh = { P: [], N: [], I: [] };
  plate(prism, drumMap(o.turn * (Math.PI / 2), o.away), -36, 36, -3.5, 3.5, -3.5, 3.5, 0, 0, 0);
  for (let q = 0; q < 4; q++) {
    const m = drumMap((o.turn - q) * (Math.PI / 2), o.away);
    for (const [x0, x1] of [[-36, -28], [28, 36]]) plate(prism, m, x0, x1, -FACE, FACE, 3.5, 6, 0, 0, 0);
    for (let k = 0; k < HOOKS; k++) {
      const x = HOOK_X(k), row = HOOK_ROW(k), lo = row === 0 ? 0 : -FACE, hi = row === 0 ? FACE : 0;
      plate(prism, m, x - HOOK_PITCH / 2, x + HOOK_PITCH / 2, lo, hi, 3.5, 6, x, ROW_A[row], PIT);
    }
  }
  for (const c of [b - 1, b, b + 1, b + 2]) {
    const m = drumMap(-(c - b - o.turn) * (Math.PI / 2), o.away), holes = cards[mod(c, n)];
    for (let k = 0; k < HOOKS; k++) {
      const x = HOOK_X(k), row = HOOK_ROW(k), lo = row === 0 ? 0 : -FACE, hi = row === 0 ? FACE : 0;
      plate(card, m, x - HOOK_PITCH / 2, x + HOOK_PITCH / 2, lo, hi, 6, 10, x, ROW_A[row], holes[k] ? CARD_HOLE : 0);
    }
  }
  add('wood', meshGeo(prism, 'prism'));
  add('card', meshGeo(card, 'cards'));
  // the hanging chain's holes, round (the curtain cards stay loomParts' boxes)
  const drumZ = CYL_Z - CYL_BACK * o.away;
  for (let s = 0; s < n - 4; s++) {
    const idx = mod(b + 3 + s, n), z = drumZ - 14 - 2.4 * s;
    cards[idx].forEach((on, k) => { if (on) add('hole', transform(DISC, faceZ(HOOK_X(k), 27.5 + ROW_A[HOOK_ROW(k)], z + 0.55))); });
  }
  return out;
}
