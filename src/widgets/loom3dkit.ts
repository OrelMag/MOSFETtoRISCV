// The Jacquard head for the studio renderer (DOM-free, tested). Where everything is, and how it moves through a pick, is
// loom3dparts.ts's (the tested drawing of Posselt's single-lift head on cards.ts's weave); this gives it stuff: oak for the
// frame, the prism and the boards, cast iron for the hooks and the griffe, steel needles and springs, pasteboard cards,
// linen cords, lead lingoes, a brass reed, cotton warp and weft. Its boxes and rods are tagged by what they are made of and
// baked straight into one mesh per material each frame (the head moves all through a pick), the hooks a pick lifts and their
// cords lit. A tour poses the pick at the moments that carry the idea: the card on the needles, the lift, the shed, the row.

import { M, type Material } from '../gl/kit/materials';
import type { Geo } from '../gl/kit/geo';
import type { Beat, Item, Model3, StudioAnchor } from '../gl/kit/scene';
import { UNIT_BOX, UNIT_CYL } from '../gl/kit/fromparts';
import type { OrbitView } from '../gl/camera';
import type { Part } from '../gl/parts';
import { loomAnchors, loomParts, type Cards, type LoomPalette, type Pose } from './loom3dparts';
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
  card: mk({ ...M.card, base: '--lm-card', label: 'pasteboard cards (drawn ten times too thick, square holes for round)' }),
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
  head: { target: [0, 34, -6], yaw: 0.85, pitch: 0.25, dist: 128 },
  whole: { target: [0, 24, 10], yaw: 0.55, pitch: 0.36, dist: 175 },
};
/** Where in a pick each beat stops (T): the card pressed, the griffe up, the shuttle in the shed, the row beaten up. */
export const TOUR_T = [0.11, 0.34, 0.47, 0.74];

export function loomModel(cards: Cards, o: Pose, whole: boolean): Model3 {
  const by = new Map<string, Part[]>();
  for (const p of loomParts(cards, o, ROLE_PALETTE)) {
    // the frame's front posts and rails are left out, so the head and the harness are seen from the front
    if (roleOf(p) === 'wood' && Math.abs(p.pos[2] - FRONT_Z) < 1e-6) continue;
    const key = `${roleOf(p)}${p.emissive ? ':lit' : ''}`;
    let l = by.get(key); if (!l) by.set(key, (l = [])); l.push(p);
  }
  const items: Item[] = [];
  for (const r of ROLES) for (const lit of [false, true]) {
    const list = by.get(`${r}${lit ? ':lit' : ''}`);
    if (!list?.length) continue;
    items.push({ geo: bake(list, r), mat: lit ? litOf(r) : MATS[r], name: lit ? `${NAME[r]} (lifted)` : NAME[r], group: GROUP[r] });
  }
  const anchors: StudioAnchor[] = loomAnchors(cards, o, whole).map((a) => ({ ...a, text: a.text.replace(' (square prism)', '') }));
  const beats: Beat[] = [
    { title: 'A card on the needles', text: `The square cylinder presses the card on ${HOOKS} sprung needles. Where the card is solid it pushes its needle back, and the needle takes its hook off the griffe’s knife; where there is a hole the needle goes in and its hook stays over the knife.`, view: { target: [0, 42, -8], yaw: 0.95, pitch: 0.62, dist: 90 }, show: ['head', 'chain'] },
    { title: 'The griffe lifts what the holes chose', text: 'The griffe rises and takes with it only the hooks still over its knives (lit). Their neck cords pull up through the comber board, each to its threads: hook j lifts threads j, j + 8, j + 16, j + 24.', view: { target: [0, 30, 0], yaw: 0.6, pitch: 0.18, dist: 120 }, show: ['head', 'harness', 'cloth'] },
    { title: 'The shed', text: `The lifted threads and the ones the lingoes hold down open a gap, the shed, and the shuttle carries the weft through it. Over or under each of the ${WARP} threads is the card’s doing.`, view: { target: [0, 6, 12], yaw: 0.3, pitch: 0.42, dist: 110 } },
    { title: 'A card is a row', text: 'The reed beats the weft up to the cloth and the row is done; the cylinder turns to the next card. Card after card, the chain is the pattern: a program the loom reads one line at a time.', view: { target: [0, 0, 24], yaw: 0.2, pitch: 0.75, dist: 95 } },
  ];
  return { items, anchors, beats, look: { exposure: 1 }, floor: -14 };
}
