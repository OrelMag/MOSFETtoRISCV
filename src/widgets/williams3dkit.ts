// The Williams–Kilburn store on the studio renderer, in true geometry (DOM-free; mm, x along the tube from the gun to the
// face, y up, z across: digit 0 on the left seen from the front, so towards +z). The tube's constants and the beam's path
// are williams3dparts.ts's; this file draws a pose of the store: what the view's clock says each spot holds.
//
// What the sources say, and what this draws from them:
// - A bit is a patch of charge the beam leaves on the inside of the face: a positive centre where secondary electrons left,
//   a negative ring where they land (Wikipedia, "Williams tube"). The face is drawn as that charge, amber + and blue −: it
//   is a map of potential, not light. A dot and a dash leave different patches.
// - The pick-up plate covered the face: "The plate obscures the front of the tube, so the stored pattern cannot be viewed
//   directly" (University of Manchester, Digital60). It was a wire mesh at first, a metal plate later (Digital60): both
//   are drawn, a switch picks.
// - The operators saw the bits on a separate display tube that showed a store tube's pattern (Computer50, display.html).
//   The Baby had three store tubes, the main store of 32 × 32, the accumulator and the control tube, and the display
//   (Computer50, new.baby.html). The display is drawn the same size as the store ("the same size as in the Baby").
// - Each tube sat in a metal screening box against interference (Computer50, Digital60).
// - The size is one side of a conflict: CV1131, 12-inch, after Lavington (CHM timeline); Computer50 says a 6-inch tube. It
//   is drawn at 12 inches, and the note and the face's card say so.
// ESTIMATED, no source found: every dimension inside the tube (neck, gun, plates, base), the box, the regenerator's three
// chassis and their valves, the spot pitch (6 mm), the charge pattern's shape, and the display's phosphor colour (P1 green).

import { extrude, lathe, merge, plane, roundedBox, transform, tube, type Geo } from '../gl/kit/geo';
import { M, type DataTex, type Material } from '../gl/kit/materials';
import type { Beat, Item, Model3, StudioAnchor } from '../gl/kit/scene';
import type { Mat4, Quat, Vec3 } from '../gl/math';
import { beamPath, cellOf, DIGITS, funnelRadius, LINES, spotCentre, spotYZ, WGEOM } from './williams3dparts';

const W = WGEOM;

// ---------------------------------------------------------------- layout (mm)

/** The face's outer surface (the dome's top), the pick-up plate in front of it, the box round the whole tube. */
export const FACE_OUT = W.FACE_X + W.GLASS;
export const PLATE_X = FACE_OUT + W.MESH_GAP;
export const PLATE_HALF = W.RASTER / 2 + W.MESH_MARGIN;
export const BOX = { x0: -275, x1: PLATE_X + 14, half: 186, t: 1.6 };
/** The other tubes in a row beside the main store, each in its own box: the display, the accumulator, the control tube. */
export const ROW = { display: -2 * BOX.half - 190, acc: -4 * BOX.half - 380, ctl: -6 * BOX.half - 570 };
/** The regenerator's three chassis on a shelf under the main store's box. */
export const SHELF_Y = -BOX.half - 70;
export const CHASSIS = [
  { key: 'amp', name: 'amplifier', x: 250, note: 'the pick-up plate’s millivolt pulse made into a clean one' },
  { key: 'disc', name: 'discriminator', x: 95, note: 'samples the pulse at its moment: was it a dot or a dash?' },
  { key: 'ctl', name: 'beam control', x: -60, note: 'turns the beam on at the spot and holds it on for a dash: the rewrite' },
] as const;
export type ChassisKey = (typeof CHASSIS)[number]['key'];
const CH = { w: 120, h: 50, d: 100 };

// ---------------------------------------------------------------- the charge and the display, as data textures

/** Texture pixels per spot: the face's texture covers the raster, 32 spots a side. */
export const PX = 8, TEX = PX * DIGITS;
const MM_PX = W.PITCH / PX;
export type Shape = 'dot' | 'dash';

/** The charge (−1 … 1) at a point dx, dy mm from a spot's centre (dx along the line): a positive centre where the beam drove
 *  secondaries off, a negative ring where they fell back; a dash is the same drawn out along the line. */
export function chargeAt(shape: Shape, dx: number, dy: number): number {
  const half = shape === 'dash' ? (W.DASH - W.DOT) / 2 : 0;
  const r = Math.hypot(Math.max(0, Math.abs(dx) - half), dy);
  return Math.exp(-((r / 0.62) ** 2)) - 0.55 * Math.exp(-(((r - 1.75) / 0.45) ** 2));
}
/** The phosphor's light (0 … 1) at a point from a spot's centre: a round dot or a dash, soft-edged. */
export function lightAt(shape: Shape, dx: number, dy: number): number {
  const half = shape === 'dash' ? (W.DASH - W.DOT) / 2 : 0;
  const r = Math.hypot(Math.max(0, Math.abs(dx) - half), dy);
  return Math.max(0, Math.min(1, (W.DOT / 2 + 0.25 - r) / 0.5));
}

export const newTex = (mode: DataTex['mode']): DataTex => ({ w: TEX, h: TEX, pixels: new Uint8Array(TEX * TEX * 4), rev: 0, mode, smooth: true });

// an emit texture is added as light at twice its value (gl/studio.ts): these are half the colours seen
const POS: [number, number, number] = [0.55, 0.32, 0.1], NEG: [number, number, number] = [0.12, 0.26, 0.55], DARK: [number, number, number] = [0.02, 0.022, 0.02];
const P1: [number, number, number] = [0.22, 0.5, 0.26];
/** Stamp one spot into a texture: its charge `amp` (0 … 1) of a shape, or (display) its light. Each spot owns its cell. */
export function stamp(tex: DataTex, line: number, digit: number, shape: Shape | null, amp: number, kind: 'charge' | 'light'): void {
  for (let j = 0; j < PX; j++) for (let i = 0; i < PX; i++) {
    const u = digit * PX + i, v = line * PX + j, o = (v * TEX + u) * 4;
    const dx = (i + 0.5 - PX / 2) * MM_PX, dy = (j + 0.5 - PX / 2) * MM_PX;
    let c = DARK;
    if (shape && amp > 0) {
      if (kind === 'charge') {
        const q = chargeAt(shape, dx, dy) * amp, k = Math.min(1, Math.abs(q)), ref = q >= 0 ? POS : NEG;
        c = [DARK[0] + (ref[0] - DARK[0]) * k, DARK[1] + (ref[1] - DARK[1]) * k, DARK[2] + (ref[2] - DARK[2]) * k];
      } else {
        const k = lightAt(shape, dx, dy) * amp;
        c = [DARK[0] + (P1[0] - DARK[0]) * k, DARK[1] + (P1[1] - DARK[1]) * k, DARK[2] + (P1[2] - DARK[2]) * k];
      }
    }
    tex.pixels[o] = Math.round(c[0] * 255); tex.pixels[o + 1] = Math.round(c[1] * 255); tex.pixels[o + 2] = Math.round(c[2] * 255); tex.pixels[o + 3] = 255;
  }
}
/** A whole face from a function of the cell. */
export function fill(tex: DataTex, at: (line: number, digit: number) => { shape: Shape | null; amp: number }, kind: 'charge' | 'light'): void {
  for (let l = 0; l < LINES; l++) for (let d = 0; d < DIGITS; d++) { const s = at(l, d); stamp(tex, l, d, s.shape, s.amp, kind); }
  tex.rev++;
}

// ---------------------------------------------------------------- geometry

const tr = (p: Vec3): Mat4 => { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; m[12] = p[0]; m[13] = p[1]; m[14] = p[2]; return m; };
/** lathe()'s axis (y) onto the tube's (x): old x → y, old y → x, old z → −z. */
const AXIS: Mat4 = new Float32Array([0, 1, 0, 0, 1, 0, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1]);
const onAxis = (g: Geo): Geo => transform(g, AXIS);
/** plane()'s (x, z, normal y) turned onto the face: u along the digits (towards −z), v down the lines (towards −y), facing +x.
 *  A rotation on the item, not transform(): transform() keeps no texture coordinates. */
export const FACE_Q: Quat = [0.5, 0.5, -0.5, 0.5];
/** extrude()'s height (y) onto z, for the X plates standing on edge. */
const ON_Z: Mat4 = new Float32Array([1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1]);
const bx = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, r = 0): Geo => transform(roundedBox(x1 - x0, y1 - y0, z1 - z0, r, r > 0 ? 2 : 0), tr([(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2]));

/** The glass: neck with its pressed stem, the funnel (williams3dparts.ts funnelRadius), a faceplate domed a little. */
function envelopeProfile(): [number, number][] {
  const pts: [number, number][] = [[4, -212], [10, -210], [15, -206], [W.NECK_R, -200], [W.NECK_R, W.JOIN_X - 20]];
  for (let i = 0; i <= 24; i++) { const x = W.JOIN_X - 10 + ((W.FACE_X - 12 - (W.JOIN_X - 10)) * i) / 24; pts.push([funnelRadius(x), x]); }
  const R = W.FACE_R + 6;
  pts.push([R, W.FACE_X - 4], [R - 3, W.FACE_X + 2], [R - 14, FACE_OUT - 2.2], [R * 0.6, FACE_OUT - 0.6], [R * 0.3, FACE_OUT - 0.15], [0, FACE_OUT]);
  return pts;
}

interface Statics {
  glass: Geo; aquadag: Geo; phosphor: Geo; face: Geo; base: Geo; pins: Geo;
  heater: Geo; cathode: Geo; gun: Geo; yPlates: Geo; xPlates: Geo;
  mesh: Geo; plate: Geo; box: Geo; boxPlain: Geo; chassis: Record<ChassisKey, Geo>; valves: Geo; leads: Geo; leadTube: Geo;
}
const memo = new Map<string, Statics>();
function statics(detail: 'full' | 'flat'): Statics {
  const hit = memo.get(detail);
  if (hit) return hit;
  const seg = detail === 'flat' ? 20 : 64, sides = detail === 'flat' ? 5 : 8;
  const glass = onAxis(lathe(envelopeProfile(), { seg, crease: 60 }));
  const aq: [number, number][] = [];
  for (let i = 0; i <= 16; i++) { const x = W.JOIN_X + 20 + ((W.FACE_X - 30 - W.JOIN_X - 20) * i) / 16; aq.push([funnelRadius(x) - 1.2, x]); }
  const aquadag = onAxis(lathe(aq, { seg }));
  const phosphor = onAxis(lathe([[W.FACE_R, W.FACE_X - 0.2], [0, W.FACE_X - 0.2]], { seg }));
  const face = plane(W.RASTER, W.RASTER);
  // the gun on the axis: heater in the cathode sleeve, the control grid's cup, the first and second anodes (proportions drawn)
  const heater = onAxis(lathe([[0.6, -172], [0.6, -160], [0, -160]], { seg: 12 }));
  const cathode = onAxis(lathe([[0, -171], [2.2, -171], [2.2, -158], [0, -158]], { seg: 16, crease: 50 }));
  const cup = lathe([[1.2, -149], [5, -149], [5.4, -150], [5.4, -162], [4.8, -162]], { seg: 24, crease: 50 });
  const a1 = lathe([[6, -145], [6, -121], [2, -121]], { seg: 24, crease: 50 });
  const a2 = lathe([[2.5, -112], [7.5, -112], [7.5, -62], [3, -62]], { seg: 24, crease: 50 });
  const gun = onAxis(merge([cup, a1, a2], 'gun'));
  // the plates: each pair spreads towards its exit so the bent beam clears it; Y first (deflect up and down), then X
  const [y0, y1] = W.Y_PLATES, [x0, x1] = W.X_PLATES, g = W.PLATE_GAP, t = 0.8;
  const yOut: [number, number][] = [[y0, -8], [y1, -11], [y1, 11], [y0, 8]];
  const yPlates = merge([transform(extrude(yOut, t), tr([0, g, 0])), transform(extrude(yOut, t), tr([0, -g - t, 0]))], 'Y plates');
  const xOut: [number, number][] = [[x0, -8], [x1, -12], [x1, 12], [x0, 8]];
  const xPlate = transform(extrude(xOut, t), ON_Z);
  const xPlates = merge([transform(xPlate, tr([0, 0, -g])), transform(xPlate, tr([0, 0, g + t]))], 'X plates');
  // the base and its pins behind the stem (drawn: the CV1131's base is not in the sources read)
  const base = onAxis(lathe([[0, -248], [22, -248], [23, -246], [23, -216], [16, -212], [0, -212]], { seg, crease: 50 }));
  const pins = merge(Array.from({ length: 8 }, (_, i) => { const a = (i / 8) * 2 * Math.PI; return tube([[-248, 10 * Math.cos(a), 10 * Math.sin(a)], [-262, 10 * Math.cos(a), 10 * Math.sin(a)]], 0.8, { sides: 6 }); }), 'pins');
  // the pick-up: a wire mesh (the first) or a metal plate (later), close in front of the face
  const n = Math.round((2 * PLATE_HALF) / W.MESH_PITCH), wires: Geo[] = [];
  for (let i = 0; i <= n; i++) {
    const s = -PLATE_HALF + (2 * PLATE_HALF * i) / n;
    wires.push(tube([[PLATE_X, s, -PLATE_HALF], [PLATE_X, s, PLATE_HALF]], 0.35, { sides: 4 }), tube([[PLATE_X + 0.7, -PLATE_HALF, s], [PLATE_X + 0.7, PLATE_HALF, s]], 0.35, { sides: 4 }));
  }
  const mesh = merge([...wires, bx(PLATE_X - 1, PLATE_X + 2, -PLATE_HALF - 3, PLATE_HALF + 3, -PLATE_HALF - 3, -PLATE_HALF), bx(PLATE_X - 1, PLATE_X + 2, -PLATE_HALF - 3, PLATE_HALF + 3, PLATE_HALF, PLATE_HALF + 3),
    bx(PLATE_X - 1, PLATE_X + 2, -PLATE_HALF - 3, -PLATE_HALF, -PLATE_HALF, PLATE_HALF), bx(PLATE_X - 1, PLATE_X + 2, PLATE_HALF, PLATE_HALF + 3, -PLATE_HALF, PLATE_HALF)], 'mesh');
  const plate = bx(PLATE_X, PLATE_X + 1.5, -PLATE_HALF, PLATE_HALF, -PLATE_HALF, PLATE_HALF, 0.6);
  // the screening box: back, bottom, the far side and a front frame round a window; the main store's top and near side are
  // left off so the tube shows (the others are closed)
  const { x0: b0, x1: b1, half: H, t: T } = BOX, win = PLATE_HALF + 10;
  const walls = (closed: boolean) => merge([
    bx(b0, b0 + T, -H, H, -H, H), bx(b0, b1, -H, -H + T, -H, H), bx(b0, b1, -H, H, -H, -H + T),
    ...(closed ? [bx(b0, b1, -H, H, H - T, H), bx(b0, b1, H - T, H, -H, H)] : []),
    bx(b1 - T, b1, win, H, -H, H), bx(b1 - T, b1, -H, -win, -H, H), bx(b1 - T, b1, -win, win, win, H), bx(b1 - T, b1, -win, win, -H, -win),
  ], 'screening box');
  const chassis = Object.fromEntries(CHASSIS.map((c) => [c.key, bx(c.x - CH.w / 2, c.x + CH.w / 2, SHELF_Y - CH.h / 2, SHELF_Y + CH.h / 2, -CH.d / 2, CH.d / 2, 3)])) as Record<ChassisKey, Geo>;
  const bulb = lathe([[0, 0], [9, 0], [10, 6], [10, 34], [8, 40], [3, 44], [0, 45]], { seg: 20 });
  const valves = merge(CHASSIS.flatMap((c) => [-28, 28].map((dx) => transform(bulb, tr([c.x + dx, SHELF_Y + CH.h / 2, 0])))), 'valves');
  // the signal's path: plate corner to the amplifier, amplifier → discriminator → beam control, beam control to the gun's grid
  const top = SHELF_Y + CH.h / 2, path: Vec3[][] = [
    [[PLATE_X + 1, -PLATE_HALF, PLATE_HALF], [PLATE_X + 8, -PLATE_HALF - 30, PLATE_HALF - 20], [PLATE_X + 8, top + 20, 20], [CHASSIS[0].x + 40, top + 6, 20], [CHASSIS[0].x + 40, top, 20]],
    [[CHASSIS[0].x - 40, top, -20], [CHASSIS[0].x - 40, top + 14, -20], [CHASSIS[1].x + 40, top + 14, -20], [CHASSIS[1].x + 40, top, -20]],
    [[CHASSIS[1].x - 40, top, -20], [CHASSIS[1].x - 40, top + 14, -20], [CHASSIS[2].x + 40, top + 14, -20], [CHASSIS[2].x + 40, top, -20]],
    [[CHASSIS[2].x - 40, top, 20], [CHASSIS[2].x - 40, top + 30, 20], [-150, top + 30, 20], [-150, -12, 6], [-152, -5.6, 2]],
  ];
  const leads = merge(path.slice(1).map((p) => tube(p, 1.2, { sides, bend: 6 })), 'leads');
  const leadTube = tube(path[0], 1.2, { sides, bend: 6 });
  const s: Statics = { glass, aquadag, phosphor, face, base, pins, heater, cathode, gun, yPlates, xPlates, mesh, plate, box: walls(false), boxPlain: walls(true), chassis, valves, leads, leadTube };
  memo.set(detail, s);
  return s;
}
const beams = new Map<number, Geo>();
/** The beam to a spot (memoized: 1 024 of them at most). */
export function beamGeo(cell: number): Geo {
  let g = beams.get(cell);
  if (!g) { g = tube(beamPath(spotCentre(Math.floor(cell / DIGITS), cell % DIGITS)), 0.7, { sides: 6, bend: 4 }); beams.set(cell, g); }
  return g;
}

// ---------------------------------------------------------------- materials

const PLAIN = 'no source found for its size or shape: drawn';
export const MATS = {
  glass: M.glass,
  aquadag: M.make({ base: [0.08, 0.08, 0.08], metal: 0.15, rough: 0.75, label: 'aquadag (colloidal graphite) on the inside of the funnel' }),
  phosphor: M.make({ base: [0.3, 0.32, 0.29], metal: 0, rough: 0.85, label: 'phosphor on the inside of the face' }),
  charge: (tex: DataTex): Material => M.make({ base: [0.04, 0.04, 0.04], metal: 0, rough: 0.9, bloom: 0.25, data: tex, label: 'the stored charge, drawn as colour: amber where the face is positive, blue where negative' }),
  light: (tex: DataTex): Material => M.make({ base: [0.04, 0.04, 0.04], metal: 0, rough: 0.6, bloom: 0.6, data: tex, label: 'the display tube’s phosphor (P1 green: drawn)' }),
  heater: M.make({ base: [0.6, 0.3, 0.15], metal: 0, rough: 0.6, emit: [1, 0.45, 0.15], glow: 1, label: 'heater' }),
  cathode: M.cathodeOxide, nickel: M.nickel, base: M.bakelite, pins: M.nickel,
  beam: M.beam([0.45, 0.75, 1], 1.1, 'the electron beam (drawn: it gives no light of its own)'),
  plate: M.make({ ...M.aluminium, label: 'metal pick-up plate (the metal: not found)' }),
  mesh: M.make({ ...M.copper, rough: 0.4, label: 'wire mesh pick-up plate (the wire: not found)' }),
  box: M.make({ base: [0.33, 0.35, 0.34], metal: 0.2, rough: 0.55, label: 'sheet-steel screening box, painted' }),
  chassis: M.make({ base: [0.42, 0.43, 0.44], metal: 0.6, rough: 0.45, label: 'valve chassis' }),
  live: (m: Material, k = 0.8): Material => ({ ...m, emit: [1, 0.7, 0.3], glow: k }),
  lead: M.make({ ...M.copper, rough: 0.35, label: 'screened lead' }),
};

// ---------------------------------------------------------------- the model

export interface WilliamsState {
  /** The spot under the beam now (cellOf), null: the beam is off. */
  cell: number | null;
  /** The pick-up plate's pulse, −1 … 1 (its sign: a dot or a dash read). */
  plate: number;
  /** Which regenerator stage is working now. */
  active: ChassisKey | null;
  pickup: 'mesh' | 'plate';
  /** The main store's face (charge) and the display's (light); the accumulator's and control tube's faces. */
  charge: DataTex; display: DataTex; acc: DataTex; ctl: DataTex;
}

const LAV = 'S. H. Lavington via the Computer History Museum timeline: “type CV1131 12-inch diameter”; Computer50 (University of Manchester) says a 6-inch tube';
const D60 = 'University of Manchester, Digital60: History of the Williams-Kilburn Tube';
const C50 = 'University of Manchester, Computer50';

/** One tube's items (the main store, or a copy beside it), at z = dz. */
function tubeItems(S: Statics, dz: number, group: string, faceMat: Material, name: string, opts: { gun?: boolean; pickup?: 'mesh' | 'plate' | null; plain?: boolean } = {}): Item[] {
  const at: Vec3 = [0, 0, dz], main = !opts.plain, out: Item[] = [];
  out.push({ geo: S.glass, mat: MATS.glass, at, name: 'glass envelope', group: main ? 'tube' : group, cut: 'open', order: 2,
    info: { dim: `${W.FACE_D} mm across the face (12 inches): sources differ`, source: LAV, note: 'evacuated; the neck holds the gun and the plates, the funnel opens to the face' } });
  out.push({ geo: S.aquadag, mat: MATS.aquadag, at, name: 'aquadag coating', group: main ? 'tube' : group, cut: 'open', order: 1, info: { note: 'a conducting graphite layer on the funnel’s inside: it collects the secondary electrons the beam knocks off (drawn)' } });
  out.push({ geo: S.phosphor, mat: MATS.phosphor, at, name: 'phosphor', group: main ? 'face' : group, cut: 'open' });
  out.push({ geo: S.face, mat: faceMat, at: [W.FACE_X, 0, dz], rot: FACE_Q, name, group: main ? 'face' : group, cut: 'open', shadow: false,
    info: main ? { dim: `32 × 32 spots, ${W.PITCH} mm apart (pitch drawn)`, source: 'Wikipedia, “Williams tube”: a positive spot where secondaries left, a negative ring where they land', note: 'charge, not light: a dot and a dash leave different patches, and the pick-up plate tells them apart' } : undefined });
  out.push({ geo: S.base, mat: MATS.base, at, name: 'base', group: main ? 'tube' : group, info: { note: PLAIN } }, { geo: S.pins, mat: MATS.pins, at, name: 'base pins', group: main ? 'tube' : group });
  if (opts.gun !== false) {
    out.push({ geo: S.heater, mat: MATS.heater, at, name: 'heater', group: main ? 'gun' : group, shadow: false }, { geo: S.cathode, mat: MATS.cathode, at, name: 'cathode', group: main ? 'gun' : group, info: { note: 'heated, it gives off the electrons of the beam' } });
    out.push({ geo: S.gun, mat: MATS.nickel, at, name: 'electron gun', group: main ? 'gun' : group, info: { note: 'grid and anodes: they form the beam and focus it on the face; turning the grid down turns the beam off', source: 'proportions drawn, not measured' } });
    out.push({ geo: S.yPlates, mat: MATS.nickel, at, name: 'Y plates', group: main ? 'plates' : group, info: { note: 'a voltage between them bends the beam up or down: the line' } });
    out.push({ geo: S.xPlates, mat: MATS.nickel, at, name: 'X plates', group: main ? 'plates' : group, info: { note: 'bend it sideways: the digit along the line. Electrostatic deflection, no yoke' } });
  }
  if (opts.pickup === 'mesh') out.push({ geo: S.mesh, mat: MATS.mesh, at, name: 'pick-up plate (wire mesh)', group: main ? 'pickup' : group, info: { source: D60, note: 'the first pick-up plate: a mesh; it covered the face, so the pattern could not be seen' } });
  else if (opts.pickup === 'plate') out.push({ geo: S.plate, mat: MATS.plate, at, name: 'pick-up plate', group: main ? 'pickup' : group, info: { source: D60, note: '“The plate obscures the front of the tube, so the stored pattern cannot be viewed directly”' } });
  out.push({ geo: main ? S.box : S.boxPlain, mat: MATS.box, at, name: 'screening box', group: main ? 'box' : group, info: { source: `${C50}; ${D60}`, note: main ? 'against interference; its top and near side are left off here, and its size is drawn' : 'against interference; size drawn' } });
  return out;
}

export function williamsModel(s: WilliamsState, detail: 'full' | 'flat' = 'full'): Model3 {
  const S = statics(detail), items: Item[] = [];
  items.push(...tubeItems(S, 0, 'store', MATS.charge(s.charge), 'stored charge', { pickup: s.pickup }));
  for (const it of items) if (it.group === 'gun' || it.group === 'plates') it.explode = [-110, 0, 0];
  for (const it of items) if (it.group === 'pickup') it.explode = [110, 0, 0];
  for (const it of items) if (it.group === 'box') it.explode = [0, 320, 0];
  if (s.cell !== null) items.push({ geo: beamGeo(s.cell), mat: MATS.beam, name: 'electron beam', group: 'beam', cut: 'none', shadow: false, info: { note: 'bent by the plates onto one spot; it is not visible light: drawn' } });
  if (s.plate !== 0 && s.pickup) {
    const it = items.find((i) => i.group === 'pickup')!;
    it.mat = MATS.live(it.mat, 0.5 * Math.abs(s.plate));
  }
  items.push({ geo: S.leadTube, mat: s.plate !== 0 ? MATS.live(MATS.lead, 0.6) : MATS.lead, name: 'lead to the amplifier', group: 'regen', cut: 'none', info: { note: 'a pulse of millivolts: the plate is coupled to the face through the glass' } });
  for (const c of CHASSIS) items.push({ geo: S.chassis[c.key], mat: s.active === c.key ? MATS.live(MATS.chassis, 0.7) : MATS.chassis, name: c.name, group: 'regen', explode: [0, -120, 0], cut: 'none', info: { note: `${c.note} (one box stands for the stage’s valves: drawn)` } });
  items.push({ geo: S.valves, mat: MATS.glass, name: 'valves', group: 'regen', explode: [0, -120, 0], cut: 'none', order: 3, info: { note: 'two bulbs a chassis stand for its valves: the count is not from a source' } });
  items.push({ geo: S.leads, mat: s.active === 'ctl' ? MATS.live(MATS.lead, 0.6) : MATS.lead, name: 'regenerator wiring', group: 'regen', cut: 'none', info: { note: 'amplifier → discriminator → beam control → the gun’s grid: what was read is written back' } });
  // the display tube and the other two store tubes, in a row beside the main store (never cut)
  const row: Item[] = [
    ...tubeItems(S, ROW.display, 'display', MATS.light(s.display), 'display tube’s screen', { gun: false, pickup: null, plain: true }),
    ...tubeItems(S, ROW.acc, 'stores', MATS.charge(s.acc), 'accumulator tube’s charge', { gun: false, pickup: 'plate', plain: true }),
    ...tubeItems(S, ROW.ctl, 'stores', MATS.charge(s.ctl), 'control tube’s charge', { gun: false, pickup: 'plate', plain: true }),
  ];
  for (const it of row) it.cut = 'none';
  row.find((i) => i.name === 'display tube’s screen')!.info = { source: `${C50}, display.html`, note: 'it showed a store tube’s pattern, picked by a switch: how the operators saw the bits. Drawn the same size as the store (Computer50: “the same size”)' };
  row.filter((i) => i.name === 'glass envelope').forEach((i, k) => { i.name = ['display tube', 'accumulator tube', 'control tube'][k]; i.info = { source: `${C50}, new.baby.html`, note: ['shows a store tube’s bits: no pick-up plate in front', 'one word: the accumulator', 'the present instruction and its address'][k] }; });
  items.push(...row);

  const up: Vec3 = [0, 1, 0], front: Vec3 = [1, 0, 0], near: Vec3 = [0, 0, 1];
  const anchors: StudioAnchor[] = [
    { text: 'electron gun', p: [-140, 8, 0], side: 't', n: up, on: 'gun' },
    { text: 'deflection plates', p: [-20, 12, 0], side: 't', n: up, on: 'plates' },
    { text: 'stored charge', p: [W.FACE_X, -W.RASTER / 2, W.RASTER / 2], side: 'l', n: front, on: 'face' },
    { text: s.pickup === 'mesh' ? 'pick-up plate (mesh)' : 'pick-up plate', p: [PLATE_X + 1, PLATE_HALF, 0], side: 't', n: front, on: 'pickup' },
    { text: 'screening box', p: [BOX.x0 + 40, BOX.half, -BOX.half + 40], side: 't', n: up, on: 'box', minor: true },
    { text: 'regenerator', p: [CHASSIS[1].x, SHELF_Y - CH.h / 2, CH.d / 2], side: 'b', n: near, on: 'regen' },
    { text: 'display tube', p: [FACE_OUT, BOX.half, ROW.display], side: 'r', n: front, on: 'display' },
  ];
  const faceView = { yaw: Math.PI / 2, pitch: 0.02, target: [W.FACE_X, 0, 0] as Vec3, dist: 420 };
  const [sy, sz] = spotYZ(15, 15), spots = { yaw: Math.PI / 2, pitch: 0.02, target: [W.FACE_X, sy, sz] as Vec3, dist: 160 };
  const beats: Beat[] = [
    { title: 'A picture tube used as a store', text: `A cathode-ray tube: the gun makes a beam, two pairs of plates bend it onto any of 32 × 32 spots on the face. Drawn as a ${W.FACE_D} mm (12-inch) CV1131 after Lavington; Computer50 says the Baby’s store was a 6-inch tube. The sources differ, and the dimensions inside are drawn.`, view: { yaw: 0.35, pitch: 0.25, target: [40, 0, 0], dist: 900 }, frame: ['tube', 'gun', 'plates', 'face'], hide: ['box', 'display', 'stores'], cut: 1 },
    { title: 'Charge, not light', text: 'The beam leaves a patch of charge where it lands: positive where it drove secondary electrons off, a negative ring where they fell back (amber and blue here: a map of potential, not a picture). A dash is a dot drawn out along the line, and leaves a different patch. Here, a few lines of the store, close up.', view: spots, cut: 0, hide: ['pickup', 'box', 'tube', 'gun', 'plates', 'regen', 'display', 'stores'] },
    { title: 'The plate in front sees a pulse', text: 'When the beam comes back to a spot the charge under it changes, and through the glass that pulse reaches the pick-up plate: one shape for a dot, another for a dash. The plate covered the face, so nobody could see this pattern (Digital60).', view: { ...faceView, yaw: 0.9, pitch: 0.2 }, frame: ['pickup', 'face'], show: ['pickup', 'face', 'regen', 'beam'] },
    { title: 'Reading is writing', text: 'Reading a spot leaves a dot there whatever it held, so every read is followed by a write: the amplifier, the discriminator and the beam control rewrite what was read. Turn off the rewrite and watch the dashes go.', view: { yaw: 0.6, pitch: 0.05, target: [100, SHELF_Y + 60, 0], dist: 800 }, frame: ['regen', 'pickup'], show: ['regen', 'pickup', 'face', 'gun', 'beam'] },
    { title: 'Charge leaks', text: 'The patches leak away in a fraction of a second, so the beam keeps going round, rewriting each spot long before it fades. Press Let it leak: the beam stops and the patches fade.', view: faceView, cut: 0, hide: ['pickup', 'box', 'tube', 'gun', 'plates', 'regen', 'display', 'stores'] },
    { title: 'Three stores and a display', text: 'The Baby had three store tubes, the main store of 32 words, the accumulator and the control tube, and a fourth tube with no plate in front: the display, which showed any of them (Computer50). That is how the bits were seen. Each tube sat in a metal screening box against interference (Computer50, Digital60).', view: { yaw: 1.35, pitch: 0.22, target: [FACE_OUT, 0, (ROW.ctl) / 2], dist: 2600 }, frame: ['tube', 'display', 'stores', 'box', 'pickup', 'face'], hide: [] },
  ];
  return { items, anchors, beats, cuts: { planes: [{ n: [0, 0, 1], d: 0 }], open: [BOX.half + 40] }, floor: SHELF_Y - CH.h / 2 - 2, look: { exposure: 1.05 } };
}

export const WILLIAMS_HOME = { yaw: 0.62, pitch: 0.3, target: [40, -50, 0] as Vec3, dist: 1250 };

/** The Baby's other two store tubes' patterns: one word on the accumulator, two on the control tube (any words). */
export function staticFace(words: number[], tex: DataTex): DataTex {
  fill(tex, (l, d) => (l < words.length ? { shape: (words[l] >>> d) & 1 ? 'dash' : 'dot', amp: 1 } : { shape: null, amp: 0 }), 'charge');
  return tex;
}
export { cellOf };
