// Hollerith's pin press on the studio renderer (DOM-free, tested): the chapter's ten-position census press of
// press3dgeom.ts in true shapes. Turned steel pins with brass collars, each in its own helical spring under the pin box's
// lid; hard-rubber cups below the card, each filled with mercury that stands proud of its rim (mercury does not wet the
// cup); a card with round holes where it is punched and the clipped corner that keeps a stack the right way round; the
// counter dials, a face of 100 divisions with a long and a short hand and a magnet coil behind each; two relays whose
// contacts are in series or in parallel, wired to an eleventh dial. A section through the front row of cups shows a pin
// standing in its mercury.
//
// The units are the drawing's own (the press is a diagram of the mechanism, not a measured object); what is sourced is
// what the real press had: 40 dials, each of 100 divisions with two hands (Census Bureau; The Henry Ford 36.282.1).

import { extrude, lathe, merge, roundedBox, sphere, transform, tube, helix, type Geo } from '../gl/kit/geo';
import { M, type Material } from '../gl/kit/materials';
import type { Beat, Item, Model3, StudioAnchor } from '../gl/kit/scene';
import { quatAxisAngle, quatMul, type Vec3 } from '../gl/math';
import {
  CARD_TOP, DIAL_Y, DIAL_Z, HG_TOP, LID, N, POSITIONS, RACK_TOP, RELAY_POS, RX, RZ, closedOf, dialX, handAngles, headY, pinTip, pinTop, springLen, PIN_LEN,
  type PressPose,
} from './press3dgeom';

const SRC = {
  census: 'U.S. Census Bureau, "The Hollerith Machine": 40 dials of 100 divisions, two hands, a bell',
  ford: 'The Henry Ford, Hollerith Tabulating Machine (1890), 36.282.1',
  card: 'the card\'s size is not drawn: 3¼ × 6⅝ in (Wikipedia), 3¼ × 7⅜ in (Columbia) and 3 × 5½ in (Hollerith, 1889) disagree',
  drawing: 'a drawing of the mechanism: sizes are the diagram\'s, not measured',
};
const CARD_T = 0.6, HOLE_R = 1.25;

// ---------------------------------------------------------------- geometry, built once per detail

type Detail = 'full' | 'flat';
interface Geos {
  table: Geo; pad: Geo; board: Geo; post: Geo; rail: Geo; cup: Geo; mercury: Geo; pin: Geo; collar: Geo; plate: Geo; column: Geo; back: Geo;
  lever: Geo; knob: Geo; face: Geo; ticks: Geo; long: Geo; short: Geo; hub: Geo; bobbin: Geo; coil: Geo; relayBase: Geo; relayCoil: Geo;
  armature: Geo; yoke: Geo; contact: Geo; battery: Geo;
}
const memo = new Map<Detail, Geos>();
const springs = new Map<string, Geo>(), cards = new Map<string, Geo>(), wires = new Map<string, Geo>();

/** A 4 × 4 column-major matrix: turn by a about z, then move by (dx, dy). */
function zturn(a: number, dx: number, dy: number): Float32Array {
  const c = Math.cos(a), s = Math.sin(a), m = new Float32Array(16);
  m[0] = c; m[1] = s; m[4] = -s; m[5] = c; m[10] = 1; m[12] = dx; m[13] = dy; m[15] = 1;
  return m;
}
/** A geometry turned so its y axis points along z (a dial's face, built in x, y, faces +z). */
const facing = (g: Geo): Geo => { const m = new Float32Array(16); m[0] = 1; m[6] = 1; m[9] = -1; m[15] = 1; return transform(g, m); };

function geos(d: Detail): Geos {
  const hit = memo.get(d);
  if (hit) return hit;
  const full = d === 'full', seg = full ? 32 : 10, box = (w: number, h: number, dd: number, r: number) => roundedBox(w, h, dd, r, full ? 2 : 1);
  // the dial: 100 ticks, every tenth longer, merged into one mesh in the face's plane (x, y), then turned to face +z
  const tick = box(0.07, 0.3, 0.05, 0.01), tick10 = box(0.12, 0.55, 0.05, 0.02);
  const ticks = merge(Array.from({ length: 100 }, (_, i) => {
    // clockwise from 12 seen from the front: a tick at θ sits at (r sin θ, r cos θ), turned by −θ about z
    const th = (i / 100) * 2 * Math.PI, r = i % 10 ? 2.05 : 1.95;
    return transform(i % 10 ? tick : tick10, zturn(-th, r * Math.sin(th), r * Math.cos(th)));
  }), 'ticks');
  const needle = (len: number, w: number) => transform(box(w, len, 0.05, w / 3), zturn(0, 0, len / 2 - 0.25));
  const g: Geos = {
    table: box(60, 4, 30, 0.4), pad: box(66, 4, 13, 0.4), board: box(66, RACK_TOP, 1.1, 0.2),
    post: lathe([[0, 0], [1.1, 0], [1.1, HEAD_TOP], [0.8, HEAD_TOP + 0.4], [0, HEAD_TOP + 0.4]], { seg }),
    rail: box(2, CARD_TOP - CARD_T, 24, 0.2),
    // a cup of hard rubber with its bore; the mercury bulging over the rim
    cup: lathe([[0, 0], [2.3, 0], [2.3, 6.6], [2.1, 7], [1.75, 7], [1.75, 1.2], [0, 1.2]], { seg }),
    mercury: lathe([[0, 1.2], [1.75, 1.2], [1.75, 6.9], [1.5, 7.15], [1.0, 7.28], [0, 7.32]], { seg, crease: 80 }),
    // a turned steel pin, pointed, its collar at the top where the spring pushes
    pin: lathe([[0, 0], [0.25, 0.1], [0.55, 0.6], [0.6, 1], [0.6, PIN_LEN], [0, PIN_LEN]], { seg: full ? 16 : 6 }),
    collar: lathe([[0, 0], [1.1, 0], [1.1, 0.8], [0, 0.8]], { seg: full ? 20 : 8 }),
    plate: box(34, 2, 23.2, 0.3), column: box(1.4, LID - 2, 1.4, 0.2), back: box(34, LID - 2, 1.8, 0.2),
    lever: tube([[17, 0, 0], [29, 0, 0], [30, 1, 0], [30, 13, 0]], 0.8, { bend: full ? 1 : 0, sides: full ? 12 : 6 }),
    knob: sphere(1.6, full ? 20 : 8, full ? 12 : 5),
    face: facing(lathe([[0, -0.4], [2.4, -0.4], [2.4, 0.4], [0, 0.4]], { seg: full ? 40 : 12 })),
    ticks: transform(ticks, (() => { const m = new Float32Array(16); m[0] = 1; m[5] = 1; m[10] = 1; m[14] = 0.43; m[15] = 1; return m; })()),
    long: needle(2.2, 0.16), short: needle(1.3, 0.3), hub: facing(lathe([[0, 0], [0.3, 0], [0.3, 0.3], [0, 0.3]], { seg: 12 })),
    bobbin: lathe([[0, 0], [1.3, 0], [1.3, 0.2], [0.75, 0.2], [0.75, 2.2], [1.3, 2.2], [1.3, 2.4], [0, 2.4]], { seg: full ? 20 : 8 }),
    coil: tube(helix({ r: 0.95, pitch: 0.2, from: 0.25, to: 2.15, perTurn: full ? 14 : 6 }), 0.1, { sides: full ? 5 : 3 }),
    relayBase: box(25, 4, 28, 0.3),
    relayCoil: tube(helix({ r: 1.7, pitch: 0.28, from: 0.3, to: 5.7, perTurn: full ? 18 : 6 }), 0.13, { sides: full ? 5 : 3 }),
    armature: box(6.8, 0.6, 1.8, 0.15), yoke: box(0.8, 7.4, 2, 0.15), contact: box(1, 6.6, 1.4, 0.2), battery: lathe([[0, 0], [0.7, 0], [0.7, 9], [0, 9]], { seg: 12 }),
  };
  memo.set(d, g);
  return g;
}
const HEAD_TOP = 46 + LID + 6;

/** A spring between the pin's collar and the lid: six turns over its length (memoized by length to 0.1). */
function spring(len: number, full: boolean): Geo {
  const L = Math.max(1, Math.round(len * 10) / 10), key = `${L}${full}`;
  let g = springs.get(key);
  if (!g) { g = tube(helix({ r: 0.95, pitch: L / 6, from: 0, to: L, perTurn: full ? 12 : 5 }), 0.14, { sides: full ? 5 : 3 }); springs.set(key, g); }
  return g;
}

/** The card: one sheet with a round hole wherever it is punched and its top-left corner clipped. Built as cells: a
 *  punched cell is four pieces, each a corner of the square with a quarter of the hole's arc. */
function card(holes: readonly boolean[]): Geo {
  const key = holes.map((h) => (h ? 1 : 0)).join('');
  let g = cards.get(key);
  if (g) return g;
  const parts: Geo[] = [], X = [-15, -12, -6, 0, 6, 12, 15], Z = [-12, -10, -5, 0, 5, 10, 12];
  const rect = (x0: number, x1: number, z0: number, z1: number) => parts.push(extrude([[x0, z0], [x1, z0], [x1, z1], [x0, z1]], CARD_T));
  for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) {
    const x0 = X[i], x1 = X[i + 1], z0 = Z[j], z1 = Z[j + 1], inner = i > 0 && i < 5 && j > 0 && j < 5;
    const k = inner ? POSITIONS.findIndex((q) => q.opt === i - 1 && q.field === j - 1) : -1;
    if (k >= 0 && holes[k]) {
      const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, n = 6;
      for (const [sx, sz] of [[1, 1], [-1, 1], [-1, -1], [1, -1]] as const) {
        // the cell's corner in this quadrant, the two edges to the hole, and the quarter arc back between them
        const hx = sx > 0 ? x1 : x0, hz = sz > 0 ? z1 : z0, aX = sx > 0 ? 0 : sz > 0 ? Math.PI : -Math.PI, aZ = (sz * Math.PI) / 2, arc: [number, number][] = [];
        for (let t = 1; t < n; t++) { const ang = aZ + ((aX - aZ) * t) / n; arc.push([cx + HOLE_R * Math.cos(ang), cz + HOLE_R * Math.sin(ang)]); }
        parts.push(extrude([[cx + sx * HOLE_R, cz], [hx, cz], [hx, hz], [cx, hz], [cx, cz + sz * HOLE_R], ...arc], CARD_T));
      }
    } else if (i === 0 && j === 0) {
      parts.push(extrude([[x0 + 2, z0], [x1, z0], [x1, z1], [x0, z1], [x0, z0 + 2]], CARD_T)); // the clipped corner
    } else rect(x0, x1, z0, z1);
  }
  g = merge(parts, 'card');
  cards.set(key, g);
  return g;
}

/** A wire along a path (rubber-covered), memoized by its points. */
function wire(path: Vec3[], full: boolean): Geo {
  const key = path.map((p) => p.join(',')).join(';') + full;
  let g = wires.get(key);
  if (!g) { g = tube(path, 0.24, { bend: full ? 0.6 : 0, sides: full ? 8 : 4 }); wires.set(key, g); }
  return g;
}

// ---------------------------------------------------------------- the model at a pose

const FACE_ROT = quatAxisAngle([0, 0, 1], 0);
export const LIVE = '--m3-charge';

export function pressModel(p: PressPose, detail: Detail = 'full'): Model3 {
  const G = geos(detail), full = detail === 'full', items: Item[] = [], hy = headY(p.s);
  const closed = p.holes ? closedOf(p.s, p.holes) : POSITIONS.map(() => false);
  const live = (m: Material, on: boolean, k = 0.7) => (on ? M.glow(m, LIVE, k) : m);
  const ebonite = M.make({ base: [0.12, 0.1, 0.09], metal: 0, rough: 0.35, coat: 0.4, label: 'hard rubber (ebonite)' });
  const face = M.make({ base: '--pr-face', metal: 0, rough: 0.55, label: 'enamelled dial' }), ink = M.make({ base: '--pr-hand', metal: 0.4, rough: 0.4, label: 'blued steel' });
  const none = { cut: 'none' as const };

  // the table, the dial board, the posts and the card's rails
  items.push({ geo: G.table, mat: M.oak, at: [0, -2, 0], name: 'table', group: 'table', info: { source: SRC.ford, note: 'the press stood on the desk of an oak cabinet; the real cabinet is 1390 × 953 × 724 mm' } });
  items.push({ geo: G.pad, mat: M.oak, at: [3, -2, 21.5], name: 'table', group: 'table' });
  items.push({ geo: G.board, mat: M.oak, at: [3, RACK_TOP / 2, 25.35], name: 'dial board', group: 'dials', explode: [0, 0, 8], ...none, info: { source: SRC.census, note: 'the real board held 40 dials; this one the ten the census card needs and the relays\' eleventh' } });
  for (const sx of [-1, 1]) {
    items.push({ geo: G.post, mat: M.steel, at: [sx * 22, 0, -13], name: 'guide post', group: 'frame', ...none, info: { source: SRC.drawing, note: 'the pin box slides on these; the real press swung on a hinge, worked by a hand lever' } });
    items.push({ geo: G.rail, mat: M.steel, at: [sx * 16.5, (CARD_TOP - CARD_T) / 2, 0], name: 'card rail', group: 'frame' });
  }
  // cups and mercury, the front row cut through
  for (const q of POSITIONS) {
    items.push({ geo: G.cup, mat: ebonite, at: [q.x, 0, q.z], name: 'mercury cup', group: 'cups', explode: [0, -6, 0], info: { source: SRC.drawing, note: 'one under every position the card can be punched in' } });
    items.push({ geo: G.mercury, mat: live({ ...M.mercury, rough: 0.16 }, closed[q.k], 0.5), at: [q.x, 0, q.z], name: 'mercury', group: 'cups', explode: [0, -6, 0], info: { note: 'a liquid metal: a pin that reaches it closes its circuit without a spring contact to wear or bounce; it does not wet the cup, so it stands proud of the rim' } });
  }
  // the card
  if (p.holes) items.push({ geo: card(p.holes), mat: M.card, at: [0, CARD_TOP - CARD_T, 0], name: 'card', group: 'card', explode: [0, 7, 0], info: { dim: `${p.holes.filter(Boolean).length} holes in ${N} positions (drawn thicker than card)`, source: SRC.card, note: 'a real card had 288 positions in 12 rows of 24; this one the census widget\'s ten; the clipped corner keeps a stack the right way round' } });

  // the pin box: guide plate, lid, corner columns, back plate, the lever, its knob
  const head = { group: 'head', explode: [0, 22, 0] as Vec3 };
  items.push({ geo: G.plate, mat: M.steel, at: [0, hy + 1, 0], name: 'pin box', ...head, info: { source: SRC.drawing, note: 'a guide plate the pins slide through, and a lid the springs push against' } });
  items.push({ geo: G.plate, mat: M.steel, at: [0, hy + LID + 1, 0], name: 'pin box', ...head });
  for (const sx of [-1, 1]) for (const z of [-11.6, 11.6]) items.push({ geo: G.column, mat: M.steel, at: [sx * 17, hy + 1 + LID / 2, z], name: 'pin box', ...head });
  items.push({ geo: G.back, mat: M.steel, at: [0, hy + 1 + LID / 2, -12.5], name: 'pin box', ...head });
  items.push({ geo: G.lever, mat: M.brass, at: [0, hy + LID + 1, 0], name: 'lever', ...head, info: { source: SRC.drawing, note: 'pulled down by hand: one stroke reads one card' } });
  items.push({ geo: G.knob, mat: M.bakelite, at: [30, hy + LID + 15, 0], name: 'lever', ...head });
  // the pins and their springs
  for (const q of POSITIONS) {
    const hole = p.holes?.[q.k] ?? false, tip = pinTip(p.s, hole), top = pinTop(p.s, hole), on = closed[q.k], grp = { group: 'head', explode: [0, 22, 0] as Vec3 };
    items.push({ geo: G.pin, mat: live(M.steel, on), at: [q.x, tip, q.z], name: 'spring pin', ...grp, info: { source: SRC.drawing, note: on ? 'through the hole and into the mercury: this circuit is closed' : hole ? 'over a hole: at the bottom of the stroke it reaches the mercury' : 'over solid card: it stops on the card and rides up against its spring' } });
    items.push({ geo: G.collar, mat: M.brass, at: [q.x, top - 0.8, q.z], name: 'spring pin', ...grp });
    items.push({ geo: spring(springLen(p.s, hole), full), mat: M.steel, at: [q.x, top, q.z], name: 'spring', ...grp, shadow: full, info: { note: 'pushes the pin down; a pin the card stops compresses it instead' } });
  }
  // the dials: face, 100 ticks, two hands, the magnet's coil behind
  const dial = (x: number, n: number, on: boolean, name: string) => {
    const [al, as] = handAngles(n), grp = { name, group: 'dials', explode: [0, 0, 8] as Vec3, ...none };
    items.push({ geo: G.face, mat: live(face, on, 0.35), at: [x, DIAL_Y, DIAL_Z], ...grp, info: { dim: '100 divisions, two hands', source: SRC.census, note: `${n} counted: the long hand turns once per 100, the short once per 10 000` } });
    items.push({ geo: G.ticks, mat: ink, at: [x, DIAL_Y, DIAL_Z], ...grp });
    items.push({ geo: G.long, mat: ink, at: [x, DIAL_Y, DIAL_Z + 0.52], rot: quatMul(FACE_ROT, quatAxisAngle([0, 0, 1], -al)), ...grp });
    items.push({ geo: G.short, mat: ink, at: [x, DIAL_Y, DIAL_Z + 0.6], rot: quatAxisAngle([0, 0, 1], -as), ...grp });
    items.push({ geo: G.hub, mat: M.brass, at: [x, DIAL_Y, DIAL_Z + 0.55], ...grp });
    items.push({ geo: G.bobbin, mat: M.bakelite, at: [x, RACK_TOP, DIAL_Z - 1.2], ...grp, name: 'dial magnet' });
    items.push({ geo: G.coil, mat: live(M.copper, on, 0.6), at: [x, RACK_TOP, DIAL_Z - 1.2], ...grp, name: 'dial magnet', info: { note: 'each pulse through it steps its dial one division' } });
  };
  for (const q of POSITIONS) dial(dialX(q.k), p.counts[q.k], closed[q.k], 'counter dial');

  // the relays: base, a coil each fed from its cup, an armature pulled onto its make contact; the contacts in series (AND)
  // or in parallel (OR) to the eleventh dial
  const ins = RELAY_POS.map((k) => closed[k]), conducts = p.wiring === 'and' ? ins[0] && ins[1] : ins[0] || ins[1];
  const rl = { group: 'relays', ...none };
  items.push({ geo: G.relayBase, mat: M.oak, at: [43.5, -2, 0], name: 'relay board', ...rl });
  const feed: Vec3[][] = [[[30.5, 0.4, 2.5], [36, 0.4, 2.5], [36, 0.4, RZ[0]], [RX - 1.8, 0.4, RZ[0]]], [[30.5, 0.4, 7.5], [38, 0.4, 7.5], [38, 0.4, RZ[1]], [RX - 1.8, 0.4, RZ[1]]]];
  RZ.forEach((z, i) => {
    const name = i === 0 ? 'relay: married' : 'relay: born abroad';
    items.push({ geo: wire(feed[i], full), mat: live(M.rubber, ins[i], 0.5), name: 'wire from its cup', ...rl });
    items.push({ geo: G.bobbin, mat: M.bakelite, at: [RX, 0, z], scale: [1.4, 2.6, 1.4], name, ...rl });
    items.push({ geo: G.relayCoil, mat: live(M.copper, ins[i], 0.6), at: [RX, 0, z], name, ...rl, info: { note: `energized when the ${i === 0 ? 'married: yes' : 'born: abroad'} pin reaches its mercury` } });
    items.push({ geo: G.yoke, mat: M.steel, at: [RX - 2, 3.7, z], name, ...rl });
    items.push({ geo: G.armature, mat: M.steel, at: [RX + 1, ins[i] ? 6.9 : 7.7, z], rot: ins[i] ? undefined : quatAxisAngle([0, 0, 1], 0.12), name, ...rl });
    items.push({ geo: G.contact, mat: M.brass, at: [RX + 4.1, 3.3, z], name: 'make contact', ...rl, info: { note: 'closed while its relay pulls its armature down' } });
  });
  const Y = 9, piv = (i: number): Vec3 => [RX - 2, 7.4, RZ[i]], con = (i: number): Vec3 => [RX + 4.1, 6.6, RZ[i]];
  items.push({ geo: G.battery, mat: M.brass, at: [34, 0, 0], name: 'battery post', ...rl });
  const runs: Vec3[][] = p.wiring === 'and'
    ? [[[34, Y, 0], [34, Y, RZ[0]], [RX - 2, Y, RZ[0]], piv(0)], [con(0), [RX + 6, 6.6, RZ[0]], [RX + 6, Y + 2, RZ[0]], [RX - 3.4, Y + 2, RZ[0]], [RX - 3.4, Y + 2, RZ[1]], [RX - 2, Y + 2, RZ[1]], piv(1)], [con(1), [52, 6.6, RZ[1]]]]
    : [[[34, Y, 0], [34, Y, RZ[0]], [RX - 2, Y, RZ[0]], piv(0)], [[34, Y, 0.01], [34, Y, RZ[1]], [RX - 2, Y, RZ[1]], piv(1)], [con(0), [52, 6.6, RZ[0]], [52, 6.6, RZ[1]]], [con(1), [52.01, 6.6, RZ[1]]]];
  runs.push([[52, 6.6, RZ[1]], [52, 6.6, 23], [dialX(N), 6.6, 23], [dialX(N), DIAL_Y - 2.4, DIAL_Z - 0.4]]);
  for (const r of runs) items.push({ geo: wire(r, full), mat: live(M.copper, conducts, 0.6), name: p.wiring === 'and' ? 'contacts in series (AND)' : 'contacts in parallel (OR)', ...rl, info: { note: p.wiring === 'and' ? 'current reaches the eleventh dial only through both contacts: married AND born abroad' : 'either contact passes the current: married OR born abroad, counted once' } });
  dial(dialX(N), p.relayCount, conducts, p.wiring === 'and' ? 'married AND abroad dial' : 'married OR abroad dial');
  return { items, cuts: CUT, anchors: anchors(p), beats: beats(p), floor: -4 };
}

/** A section through the front row of cups (field 3): the pins, the card and the mercury there cut in half. */
const FRONT_Z = POSITIONS[POSITIONS.length - 1].z;
const CUT: Model3['cuts'] = { planes: [{ n: [0, 0, 1], d: FRONT_Z }], open: [60] };

// ---------------------------------------------------------------- labels and tour

function anchors(p: PressPose): StudioAnchor[] {
  const front: Vec3 = [0, 0.3, 1], up: Vec3 = [0, 1, 0], hy = headY(p.s), s8 = POSITIONS[8];
  return [
    { text: 'spring pin', p: [s8.x, hy - 6, s8.z], side: 'l', n: front, on: 'head' },
    { text: 'spring', p: [POSITIONS[3].x, hy + LID - 3, 11.6], side: 't', n: front, minor: true, on: 'head' },
    { text: 'pin box', p: [0, hy + LID + 2, -11.6], side: 't', n: up, on: 'head' },
    { text: 'lever', p: [30, hy + LID + 16, 0], side: 'r', n: up, on: 'head' },
    { text: 'card', p: [15, CARD_TOP, 8], side: 'r', n: front, on: 'card' },
    { text: 'mercury cup', p: [POSITIONS[9].x, HG_TOP, POSITIONS[9].z + 2.3], side: 'r', n: front, minor: true, on: 'cups' },
    { text: 'counter dials', p: [dialX(0) - 2.4, DIAL_Y, DIAL_Z], side: 'l', n: [0, 0, 1], on: 'dials' },
    { text: p.wiring === 'and' ? 'relays, contacts in series' : 'relays, contacts in parallel', p: [RX + 1, 7.4, RZ[0] - 1], side: 'r', n: up },
    { text: p.wiring === 'and' ? 'married AND abroad' : 'married OR abroad', p: [dialX(N) + 2.4, DIAL_Y, DIAL_Z], side: 'r', n: [0, 0, 1], minor: true },
  ];
}

export const PRESS_HOME = { target: [10, 24, 6] as Vec3, yaw: 0.5, pitch: 0.32, dist: 150 };

function beats(p: PressPose): Beat[] {
  const n = p.holes?.filter(Boolean).length ?? 0;
  return [
    { title: 'The press', text: 'A pin box over the card, mercury cups under it, a counter dial for every position. The real press, built for the 1890 census, had 40 dials on an oak cabinet; this one has the ten the chapter\'s card needs, and an eleventh on two relays.', view: PRESS_HOME, frame: [], cut: 0, explode: 0 },
    { title: 'The card', text: `Punched where the answers are: ${n} holes in ${N} positions, one per field. A real card had 288 positions in 12 rows of 24, its size never settled in one source; the clipped corner keeps a stack the right way round.`, view: { target: [0, CARD_TOP, 0], yaw: 0.3, pitch: 0.9, dist: 60 }, frame: ['card', 'frame'], cut: 0, explode: 0 },
    { title: 'Pin, hole, mercury', text: 'A section through the front row. Lowered, every pin meets the card: on solid card it stops and rides up into the box against its spring; over a hole it goes through and dips into the mercury, closing that position\'s circuit.', view: { target: [0, 12, FRONT_Z], yaw: 0.05, pitch: 0.12, dist: 60 }, frame: ['cups', 'card'], hide: ['dials', 'relays'], cut: 1, explode: 0 },
    { title: 'The counters', text: 'Each closed circuit pulses a magnet that steps its dial one division of 100: the long hand turns once per 100 cards, the short once per 10 000.', view: { target: [3, DIAL_Y, DIAL_Z], yaw: 0.1, pitch: 0.15, dist: 60 }, frame: ['dials'], cut: 0, explode: 0 },
    { title: 'AND and OR', text: `Two cups also feed relays: married, and born abroad. Their make contacts ${p.wiring === 'and' ? 'in series step the eleventh dial only for a married person born abroad (AND)' : 'in parallel step it for either (OR), counting a married immigrant once'}; the button rewires them.`, view: { target: [44, 6, 0], yaw: 0.7, pitch: 0.55, dist: 50 }, frame: ['relays'], cut: 0, explode: 0 },
    { title: 'Pulled apart', text: 'The pin box lifted off its posts, the card above the cups, the dial board forward: three parts and a circuit through each position.', view: { target: [10, 30, 6], yaw: 0.6, pitch: 0.3, dist: 190 }, frame: [], cut: 0, explode: 1 },
  ];
}
