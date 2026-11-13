// The crossbar switch on the studio renderer (DOM-free, tested): a Bell System Type B 200-point switch, three wires a
// crosspoint, in millimetres. What moves is phys/crossbar.ts's motionAt: each select bar's tilt, each holding bar's travel,
// the fingers (swung with their bar, or trapped at a level by a holding bar), each crosspoint's contacts.
//
// The counts are the sources' (phys/crossbar.ts). No dimensioned drawing of a Western Electric switch was found, so the
// outline is typical: the size of a 200-point unit offered for sale (about 13½ × 18 × 3½ in), with the parts laid out as
// the descriptions put them (five bars across the front, a vertical unit of ten spring sets and a holding bar for each of
// the twenty verticals, its hold magnet at the bottom, the select magnets at the left end). Every size inside is the
// model's. Coordinates: x along the switch (verticals left to right), y up (levels from the bottom), z out of the front.

import { lathe, merge, roundedBox, transform, tube, type Geo } from '../gl/kit/geo';
import { M, type Material } from '../gl/kit/materials';
import type { Beat, Item, Model3, StudioAnchor } from '../gl/kit/scene';
import { packInstances, type Instance, type RGB } from '../gl/instances';
import { quatAxisAngle, type Mat4, type Vec3 } from '../gl/math';
import { UNIT_BOX } from '../gl/kit/fromparts';
import { BARS, LEVELS, PAIRS, VERTICALS, barOf, type Motion } from '../phys/crossbar';

// ---------------------------------------------------------------- sizes (mm, typical)

/** The outline: a 200-point unit's, about 18 × 13½ × 3½ in (typical: a sale listing, not a Western Electric drawing). */
export const OUTLINE = { l: 457, h: 343, d: 89 } as const;
/** Vertical units' pitch along the switch and the first one's centre. */
export const V_PITCH = 19, V_X0 = -150;
export const vx = (v: number): number => V_X0 + V_PITCH * v;
/** Levels from the bottom, a bar between each pair: level 2b below bar b, 2b + 1 above it. */
export const L_PITCH = 27, L_Y0 = 74;
export const levelY = (l: number): number => L_Y0 + L_PITCH * l;
export const barY = (b: number): number => (levelY(2 * b) + levelY(2 * b + 1)) / 2;
/** Depths: the spring sets' fixed ends at the back plate, their actuating cards at the front, the finger tips just in front
 *  of the cards, the holding bars in front of those, the select bars at the front. */
export const Z = { back: -40, card: [-2, 0] as const, tip: 1.5, hold: [3, 6] as const, bar: 24 } as const;
/** How far an operated holding bar comes back (pressing a trapped finger into its card), and the select bar's tilt. */
export const HOLD_TRAVEL = 1.5, TILT_DEG = 14;
/** Contact springs: a pair per wire (tip, ring, sleeve), side by side across the vertical unit. */
export const SPRINGS = 2 * PAIRS, SPRING_DX = 1.6;

const tr = (p: Vec3): Mat4 => { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; m[12] = p[0]; m[13] = p[1]; m[14] = p[2]; return m; };
const box = (w: number, h: number, d: number, at: Vec3, r = 0.4) => transform(roundedBox(w, h, d, r, 2), tr(at));
const rod = (r: number, y0: number, y1: number, at: Vec3, seg = 16) => transform(lathe([[0, y0], [r, y0], [r, y1], [0, y1]], { seg }), tr(at));

// ---------------------------------------------------------------- materials

const mk = (m: Material) => m;
export const MATS = {
  frame: mk({ base: [0.33, 0.35, 0.37], metal: 0.3, rough: 0.5, coat: 0.2, label: 'steel frame, black-grey enamel' }),
  steel: mk({ ...M.steel, label: 'steel' }),
  bar: mk({ base: [0.62, 0.62, 0.63], metal: 1, rough: 0.3, label: 'steel select bar' }),
  finger: mk({ base: [0.8, 0.78, 0.74], metal: 1, rough: 0.25, label: 'spring wire (selecting finger)' }),
  hold: mk({ base: [0.56, 0.57, 0.6], metal: 0.9, rough: 0.35, label: 'steel holding bar (the hold magnet\'s armature)' }),
  coil: mk({ base: [0.36, 0.2, 0.1], metal: 0, rough: 0.55, coat: 0.3, label: 'coil, enamelled wire' }),
  coilOn: mk({ base: [0.46, 0.26, 0.12], metal: 0, rough: 0.5, coat: 0.3, emit: [1, 0.55, 0.2], glow: 0.35, bloom: 1.3, label: 'coil, carrying current' }),
  // pale, so a closed crosspoint's glow is the only warm colour in the field
  card: mk({ base: [0.84, 0.81, 0.72], metal: 0, rough: 0.6, label: 'actuating card (insulator)' }),
  spring: mk({ base: [1, 1, 1], metal: 0.7, rough: 0.3, label: 'nickel silver contact spring, precious-metal contacts' }),
};
const NICKEL: RGB = [0.78, 0.76, 0.7];
export const LIVE: RGB = [1, 0.62, 0.25];

// ---------------------------------------------------------------- the fixed parts

interface Statics { frame: Geo; selectBar: Geo; holdBar: Geo; holdCoil: Geo; selCoil: Geo; cards: Geo; pile: Geo }
const memo = new Map<string, Statics>();
function statics(detail: 'full' | 'flat'): Statics {
  const hit = memo.get(detail);
  if (hit) return hit;
  const seg = detail === 'flat' ? 8 : 20, L = OUTLINE.l / 2, zb = Z.back - 6, zf = OUTLINE.d + zb;
  const frame = merge([
    box(6, OUTLINE.h, zf - zb, [-L + 3, OUTLINE.h / 2, (zb + zf) / 2]), box(6, OUTLINE.h, zf - zb, [L - 3, OUTLINE.h / 2, (zb + zf) / 2]),
    box(OUTLINE.l - 12, 8, zf - zb, [0, 4, (zb + zf) / 2]), box(OUTLINE.l - 12, 8, zf - zb, [0, OUTLINE.h - 4, (zb + zf) / 2]),
    box(OUTLINE.l - 12, OUTLINE.h - 16, 6, [0, OUTLINE.h / 2, Z.back - 3]),
  ], 'frame');
  const x0 = -L + 52, x1 = L - 6;
  const st: Statics = {
    frame,
    selectBar: box(x1 - x0, 5, 5, [(x0 + x1) / 2, 0, 0], 0.6),
    holdBar: box(3, levelY(LEVELS - 1) - levelY(0) + 30, Z.hold[1] - Z.hold[0], [0, (levelY(0) + levelY(LEVELS - 1)) / 2 - 6, (Z.hold[0] + Z.hold[1]) / 2], 0.3),
    holdCoil: merge([rod(6.5, 14, 42, [0, 0, 0], seg), rod(2.5, 42, 50, [0, 0, 0], seg)], 'hold coil'),
    selCoil: rod(6.5, -6, 6, [0, 0, 0], seg),
    cards: merge(Array.from({ length: LEVELS * VERTICALS }, (_, i) => box(14, 7, Z.card[1] - Z.card[0], [vx(i % VERTICALS), levelY(Math.floor(i / VERTICALS)), (Z.card[0] + Z.card[1]) / 2], 0.3)), 'cards'),
    pile: box(SPRINGS * SPRING_DX, 5, Z.card[0] - Z.back, [SPRING_DX * (SPRINGS - 1) / 2 - 3, 0, (Z.back + Z.card[0]) / 2], 0.2),
  };
  memo.set(detail, st);
  return st;
}
/** A select magnet's place: the left end, above (up) or below (down) its bar's end. */
export const selectMagnetAt = (b: number, dir: 1 | -1): Vec3 => [-OUTLINE.l / 2 + 28, barY(b) + 20 * dir, Z.bar];
/** A hold magnet's place: under its vertical's holding bar. */
export const holdMagnetAt = (v: number): Vec3 => [vx(v) - 5.5, 0, (Z.hold[0] + Z.hold[1]) / 2];

// ---------------------------------------------------------------- the fingers

/** A finger's tip: trapped at its level, or swung with its bar (rest: level with the bar, between two cards). */
export function tipOf(m: Motion, b: number, v: number): Vec3 {
  const t = m.trapped[v], held = t !== null && barOf(t) === b && m.hold[v] > 0;
  const y = held ? levelY(t!) : barY(b) + m.tilt[b] * (L_PITCH / 2);
  return [vx(v) - 5.5, y, Z.tip - (held ? HOLD_TRAVEL * m.hold[v] : 0)];
}
/** One bar's fingers as one mesh: from the bar, back beside the holding bar, then in behind it to the tip. */
function fingers(m: Motion, b: number, sides: number): Geo {
  const a = (m.tilt[b] * TILT_DEG * Math.PI) / 180, by = barY(b), list: Geo[] = [];
  for (let v = 0; v < VERTICALS; v++) {
    const tip = tipOf(m, b, v), base: Vec3 = [vx(v) - 1, by + Math.sin(a) * 2.5, Z.bar - 2.5 * Math.cos(a)];
    list.push(tube([base, [vx(v) - 1, tip[1], Z.hold[1] + 1.5], [vx(v) - 1, tip[1], tip[2] + 0.5], tip], 0.55, { sides }));
  }
  return merge(list, `fingers ${b}`);
}

// ---------------------------------------------------------------- the contact springs, as instances

/** How far crosspoint (l, v) is closed, 0 … 1: its finger trapped there and the holding bar's travel. */
export const closing = (m: Motion, l: number, v: number): number => (m.trapped[v] === l ? m.hold[v] : 0);
/** Every spring: 10 levels × 20 verticals × 6 (a pair each for tip, ring and sleeve); a closed crosspoint's glow. */
export function springInstances(m: Motion): Instance[] {
  const out: Instance[] = [];
  for (let l = 0; l < LEVELS; l++) for (let v = 0; v < VERTICALS; v++) {
    const k = closing(m, l, v), c: RGB = [NICKEL[0] + (LIVE[0] - NICKEL[0]) * k, NICKEL[1] + (LIVE[1] - NICKEL[1]) * k, NICKEL[2] + (LIVE[2] - NICKEL[2]) * k];
    for (let s = 0; s < SPRINGS; s++) {
      // the moving spring of each pair is the one the card pushes: it leans onto its fixed partner as the crosspoint closes
      const moving = s % 2 === 0, x = vx(v) - 3 + s * SPRING_DX + (moving ? 0.5 * k : 0);
      out.push({ pos: [x, levelY(l), (Z.back + Z.card[0]) / 2], scale: [0.35, 4.5, Z.card[0] - Z.back], color: c, emissive: k > 0 ? [LIVE[0] * 0.5 * k, LIVE[1] * 0.5 * k, LIVE[2] * 0.5 * k] : undefined, spec: 0.4 });
    }
  }
  return out;
}
export const springData = (m: Motion): Float32Array => packInstances(springInstances(m));
export const SPRING_GEO = UNIT_BOX;

// ---------------------------------------------------------------- the model

export const XB_HOME = { yaw: -0.42, pitch: 0.22, target: [0, OUTLINE.h / 2, 0] as Vec3, dist: 820 };
/** The crossing the tour follows: vertical 6, level 5 (bar 2, swung up). */
export const CV = 6, CL = 5;

export function xbModel(m: Motion, detail: 'full' | 'flat' = 'full'): Model3 {
  const S = statics(detail), items: Item[] = [], sides = detail === 'flat' ? 3 : 6;
  const outline = `${OUTLINE.l} × ${OUTLINE.h} × ${OUTLINE.d} mm outline (typical: a 200-point unit's size; no Western Electric drawing was found)`;
  items.push({ geo: S.frame, mat: MATS.frame, name: 'frame', group: 'frame', info: { dim: outline, note: 'one switch: 200 crosspoints on 30 magnets' } });
  for (let b = 0; b < BARS; b++) {
    const ang = (m.tilt[b] * TILT_DEG * Math.PI) / 180;
    items.push({ geo: S.selectBar, mat: MATS.bar, at: [0, barY(b), Z.bar], rot: quatAxisAngle([1, 0, 0], -ang), name: 'select bar', group: 'select', explode: [0, 0, 70],
      info: { note: `one of five: tilted up or down by one of its two select magnets, it chooses one of two levels (${2 * b} below, ${2 * b + 1} above)`, source: 'Survey of Telephone Switching, ch. 6 (No. 1 Crossbar)' } });
    items.push({ geo: fingers(m, b, sides), mat: MATS.finger, name: 'selecting finger', group: 'select', explode: [0, 0, 70],
      info: { note: 'a flexible wire, one per vertical on each bar: swung by the bar in front of a level\'s card, it stays bent when a holding bar traps it, so the bar can go back' } });
    for (const dir of [1, -1] as const) {
      const on = m.tilt[b] * dir > 0.5;
      items.push({ geo: S.selCoil, mat: on ? MATS.coilOn : MATS.coil, at: selectMagnetAt(b, dir), name: 'select magnet', group: 'magnets',
        info: { note: `turns bar ${b} ${dir > 0 ? 'up' : 'down'}: level ${2 * b + (dir > 0 ? 1 : 0)}; only one of the ten may be operated at a time`, source: 'Survey of Telephone Switching, ch. 6' } });
    }
  }
  for (let v = 0; v < VERTICALS; v++) {
    items.push({ geo: S.holdBar, mat: MATS.hold, at: [vx(v) - 5.5, 0, -HOLD_TRAVEL * m.hold[v]], name: 'holding bar', group: 'hold', explode: [0, 0, 35],
      info: { note: 'the hold magnet\'s armature, the height of the vertical: it traps whichever finger is swung in front of a card and presses it in, closing that crosspoint' } });
    items.push({ geo: S.holdCoil, mat: m.hold[v] > 0.5 ? MATS.coilOn : MATS.coil, at: holdMagnetAt(v), name: 'hold magnet', group: 'magnets',
      info: { note: 'one per vertical, energized for the whole call', source: 'Wikipedia, "Crossbar switch"' } });
  }
  items.push({ geo: S.cards, mat: MATS.card, name: 'crosspoint', group: 'springs',
    info: { dim: `${PAIRS} pairs of make springs behind each card (tip, ring, sleeve)`, source: 'Survey of Telephone Switching, ch. 6: "three to six pairs" a set', note: 'the actuating card a trapped finger pushes: its springs close, and the call goes through' } });
  if (detail === 'flat') for (let l = 0; l < LEVELS; l++) for (let v = 0; v < VERTICALS; v++) { items.push({ geo: S.pile, mat: { ...MATS.spring, base: closing(m, l, v) > 0.5 ? LIVE : NICKEL }, at: [vx(v), levelY(l), 0], name: 'contact springs', group: 'springs' });
  }
  const anchors: StudioAnchor[] = [
    { text: 'select magnets', p: selectMagnetAt(4, 1), side: 'l', n: [0, 0, 1], on: 'magnets' },
    { text: 'select bar', p: [-OUTLINE.l / 2 + 60, barY(3), Z.bar], side: 'l', n: [0, 0, 1], on: 'select' },
    { text: 'hold magnets', p: holdMagnetAt(1), side: 'l', n: [0, 0, 1], on: 'magnets' },
    { text: 'holding bar', p: [vx(VERTICALS - 1) - 5.5, levelY(8), Z.hold[1]], side: 'r', n: [0, 0, 1], on: 'hold' },
    { text: 'spring set', p: [vx(VERTICALS - 1), levelY(3), 0], side: 'r', n: [0, 0, 1], on: 'springs' },
    { text: 'finger', p: tipOf(m, 2, CV), side: 'r', n: [0, 0, 1], on: 'select', minor: true },
  ];
  return { items, anchors, beats: BEATS, look: { exposure: 1.05, keyDir: [-0.4, 0.75, 0.55] } };
}

const near = { yaw: -0.78, pitch: 0.32, target: [vx(CV) - 3, levelY(CL), 0] as Vec3, dist: 175 };
export const BEATS: Beat[] = [
  { title: 'A switch', text: `${LEVELS} levels across, ${VERTICALS} verticals down: 200 crosspoints, each a set of ${PAIRS} contact pairs, worked by ${2 * BARS} select magnets and ${VERTICALS} hold magnets. The chapter's relay grid paid a relay for every crosspoint.`, view: XB_HOME, explode: 0 },
  { title: 'A select bar tilts', text: `A select magnet turns its bar ${TILT_DEG}° (drawn): its twenty fingers, one per vertical, swing up in front of level ${CL}'s cards.`, view: near, show: ['select', 'magnets'], explode: 0 },
  { title: 'A vertical holds', text: `Vertical ${CV}'s hold magnet pulls its holding bar in: it traps the one finger swung in front of it against the card, and three pairs of springs close, tip, ring and sleeve. The select stays up until the hold has operated.`, view: near, show: ['hold', 'springs', 'select'], explode: 0 },
  { title: 'The select lets go', text: 'The select magnet releases and the bar goes back level. Nineteen fingers spring back with it; the trapped one stays bent, so the crosspoint stays closed. The bar is free for the next call.', view: near, show: ['select', 'springs'], explode: 0 },
  { title: 'A second call', text: 'Another level, another vertical, while the first call stays up: two crosspoints held, two hold magnets drawing current, no select magnet at all.', view: XB_HOME, explode: 0 },
  { title: 'One at a time', text: 'Two select magnets up at once would swing two fingers in front of a vertical, and its holding bar would trap both: two crosspoints closed on one line. The marker serves one request at a time, the chapter\'s pitfall made of steel.', view: { yaw: -0.3, pitch: 0.2, target: [-80, barY(2), 10], dist: 420 }, show: ['select', 'magnets'], explode: 0 },
  { title: 'Hang-up', text: `Vertical ${CV}'s hold magnet drops: its holding bar swings back, the finger springs out, and that call alone ends.`, view: near, show: ['hold', 'springs', 'select'], explode: 0 },
];
