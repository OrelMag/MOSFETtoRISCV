// The naval Enigma M4 as parts (DOM-free, tested). Millimetres, the case's floor at y = 0, x to the operator's right, z
// towards the operator. Overall size is the Computer History Museum's for the Enigma I (the M3 / M4 case has the same
// footprint per Crypto Museum); everything inside is measured off Crypto Museum's near-orthographic top views.
//
// Angles round the wheels' axle are φ, from straight up towards the operator: a wheel stepping forward carries its top
// towards the operator (later letters come from behind, as on the real rims). Everything a wheel shows comes from
// the cipher's state: a rim letter stands at WINDOW_PHI + (window − letter) · PITCH, so the notch `NOTCH_OFFSET` letters past
// a turnover letter stands at PAWL_PHI exactly when the model says the next wheel is carried.

import type { RGB, RGBA } from '../gl/instances';
import { quatAxisAngle, quatMul, quatRotate, QUAT_ID, type Quat, type Vec3 } from '../gl/math';
import { box, cyl, rod, wire, type Anchor, type Part } from '../gl/parts';
import { KEY_ROWS, NOTCH_OFFSET, plugMap, ROTORS, SOCKET_ROWS, idx, chr, type EnigmaSettings, type Moved, type Trace } from '../crypto/enigma';
import { quatFromAxes, strokeText } from './strokefont';

export const CASE_W = 280, CASE_D = 340, CASE_H = 150;
export const WALL_H = 104, LID_H = CASE_H - WALL_H, WOOD = 10;
export const PANEL_Y = 100;
export const AX_Y = 60, AX_Z = -84.5;
export const PITCH = (2 * Math.PI) / 26;
/** The window reads the rim one letter forward of the top (the plates sit forward of the thumbwheel slots). */
export const WINDOW_PHI = PITCH;
/** The pawls' working point, behind the wheels at the axle's height. */
export const PAWL_PHI = WINDOW_PHI - NOTCH_OFFSET * PITCH;

/** Rim centres, left to right: the Greek wheel, then the left, middle and right wheels. */
export const RIM_X = [-82, -56, -29, -2] as const;
export const THUMB_DX = 13, RATCHET_DX = 16.5;
export const RIM_R = 37.5, THUMB_R = 47, RATCHET_R = 35.5, CORE_R = 30, CONTACT_R = 24, LIP_R = 38.6, NOTCH_R = 35.6;
export const UKW_FACE = -92, ETW_FACE = 19;

const PANEL_FRONT = -40, PANEL_BACK = -158, HINGE_Z = -158;
const LAMP_Z = [-18, 4, 27], KEY_Z = [58, 80, 102], ROW_X = [-95, -86, -102], KEY_PITCH = 24.25;
const KEY_TOP = [84, 78, 72], DECK_Y = [62, 56, 50];
const FACE_Z = 127, SOCKET_Y = [47, 30, 13], SOCKET_X = [-96, -84, -96];

export interface EnigmaPalette {
  wood: RGB; woodDark: RGB; black: RGB; panel: RGB; zinc: RGB; steel: RGB; brass: RGB; bakelite: RGB; ivory: RGB; red: RGB; paper: RGB;
  glass: RGB; lampOn: RGB; lampLetter: RGB; forward: RGB; back: RGB; cable: RGB; cotton: RGB;
}

export interface EnigmaPose {
  settings: EnigmaSettings;
  /** Window letters as numbers, Greek first; a fraction while a wheel is turning. */
  pos: readonly number[];
  /** Openness 0..1: lid, rotor cover, plug flap, lamp panel off. */
  lid: number; cover: number; flap: number; lamps: number;
  /** Wheels lifted out on the spindle and spread. */
  out: number;
  /** Wheels made clear with the current through them, lid and rotor cover off (both lift away on the real machine). */
  ghost: boolean;
  /** The key held, the lamp lit. */
  key: string | null; lit: string | null;
  /** 0 at rest, 1 at the bottom of a key's travel. */
  stroke: number;
  /** The pawls down in their ratchets: left, middle, right (Enigma.pawls). */
  pawls: Moved;
  trace: Trace | null;
  /** Fewer facets for the flat SVG fallback. */
  lite?: boolean;
}

const AXIS_X: Vec3 = [1, 0, 0];

/** Turn parts about an axis through `pivot`, in place. */
function turn(parts: Part[], from: number, pivot: Vec3, q: Quat): void {
  for (let i = from; i < parts.length; i++) {
    const p = parts[i], d = quatRotate(q, [p.pos[0] - pivot[0], p.pos[1] - pivot[1], p.pos[2] - pivot[2]]);
    p.pos = [pivot[0] + d[0], pivot[1] + d[1], pivot[2] + d[2]];
    p.rot = quatMul(q, p.rot ?? QUAT_ID);
  }
}
function shift(parts: Part[], from: number, by: Vec3): void {
  for (let i = from; i < parts.length; i++) { const p = parts[i]; p.pos = [p.pos[0] + by[0], p.pos[1] + by[1], p.pos[2] + by[2]]; }
}

/** A disc on the wheels' axle, its local origin the axle's height and depth. */
const disc = (c: RGB | RGBA, x0: number, x1: number, r: number, spec = 0, y = 0, z = 0): Part => rod(c, [x0, y, z], [x1, y, z], r, spec);
/** A point at radius r, angle φ round the axle (local). */
const round = (x: number, r: number, phi: number): Vec3 => [x, r * Math.cos(phi), r * Math.sin(phi)];
/** A box standing on the axle's radius at φ: dx along the axle, dr radially, dt along the rim. */
function radial(c: RGB, x: number, r: number, phi: number, dxs: number, dr: number, dt: number, spec = 0): Part {
  const up: Vec3 = [0, Math.cos(phi), Math.sin(phi)], along: Vec3 = [0, -Math.sin(phi), Math.cos(phi)];
  return { kind: 'box', pos: round(x, r, phi), scale: [dxs, dr, dt], rot: quatFromAxes(AXIS_X, up, along), color: c, spec };
}
type Hole = [number, number, number, number]; // x0, x1, z0, z1
/** A flat plate with rectangular holes, as strips between them. */
function holedPlate(out: Part[], c: RGB, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, holes: readonly Hole[]): void {
  const xs = [...new Set([x0, x1, ...holes.flatMap((h) => [h[0], h[1]])])].sort((p, q) => p - q);
  for (let i = 0; i + 1 < xs.length; i++) {
    const a = xs[i], b = xs[i + 1], cuts = holes.filter((h) => h[0] < b && h[1] > a).sort((p, q) => p[2] - q[2]);
    let z = z0;
    for (const h of cuts) { if (h[2] > z) out.push(box(c, a, b, y0, y1, z, h[2], 0.08)); z = Math.max(z, h[3]); }
    if (z < z1) out.push(box(c, a, b, y0, y1, z, z1, 0.08));
  }
}
const screw = (out: Part[], c: RGB, x: number, y: number, z: number, r = 1.8) => { out.push(cyl(c, x, z, y, y + 0.5, r, 0.4)); };

/** Grain on a wooden face: thin darker streaks, fixed, proud of the face by a hair. */
function grain(out: Part[], c: RGB, fn: (t: number, a: number, b: number) => Part, n: number, seed: number): void {
  let x = seed;
  const r = () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return (x >>> 8) / 16777216; };
  for (let i = 0; i < n; i++) { const a = r() * 0.55, part = fn((i + r()) / n, a, a + 0.15 + r() * 0.3); part.color = c; part.scale = part.scale!.map((v) => (v === 0.5 || v === 0.6 ? v * 3 : v)) as Vec3; out.push(part); }
}

// ---------------------------------------------------------------- the wheels

/** The rim, with its letters: the ring turns on the core, so it is drawn by the window letter, not the core's angle. */
function rimParts(out: Part[], kind: 'wheel' | 'greek', notches: string, P: EnigmaPalette, lite: boolean): void {
  out.push(disc(P.black, -5, 5, RIM_R - 0.2, 0.15));
  const tile = 2 * RIM_R * Math.tan(PITCH / 2) * 0.86;
  for (let j = 0; j < 26; j++) {
    const phi = WINDOW_PHI - j * PITCH, n: Vec3 = [0, Math.cos(phi), Math.sin(phi)], back: Vec3 = [0, Math.sin(phi), -Math.cos(phi)];
    out.push(radial(P.ivory, 0, RIM_R, phi, 8.6, 0.5, tile, 0.1));
    if (!lite) strokeText(out, chr(j), [0, n[1] * (RIM_R + 0.26), n[2] * (RIM_R + 0.26)], AXIS_X, back, { size: 5.8, color: P.black, weight: 1 });
  }
  if (kind === 'greek') return;
  // The notch lip on the wheel's left: a pawl rides it, and drops where a segment is missing.
  for (let j = 0; j < 26; j++) {
    const phi = WINDOW_PHI - j * PITCH, cut = notches.includes(chr(j));
    out.push(radial(P.black, -6.2, cut ? (NOTCH_R + CORE_R) / 2 : (LIP_R + CORE_R) / 2, phi, 2.6, cut ? NOTCH_R - CORE_R : LIP_R - CORE_R, 2 * LIP_R * Math.tan(PITCH / 2), 0.2));
  }
}

/** The core: thumbwheel, ratchet, contacts and wiring block; turns with the window less the ring. */
function coreParts(out: Part[], kind: 'wheel' | 'greek', name: string, P: EnigmaPalette, lite: boolean): void {
  const greek = kind === 'greek', metal = greek ? P.brass : P.zinc;
  out.push(disc(metal, -7.5, greek ? 15 : 12, CORE_R, 0.3));
  // Face plates and the hollow axle.
  out.push(disc(P.black, greek ? -8 : -7.6, -7.5, CORE_R - 1, 0.1));
  out.push(disc(P.black, greek ? 15 : 18.4, greek ? 15.6 : 18.9, CORE_R - 1, 0.1));
  // The thumbwheel: aluminium with a wavy edge; the Greek wheel's is black and sharper.
  const tc = greek ? P.black : P.zinc, tx0 = THUMB_DX - 1.4, tx1 = THUMB_DX + 1.4;
  out.push(disc(tc, tx0, tx1, THUMB_R, greek ? 0.15 : 0.5));
  if (!lite) for (let j = 0; j < 26; j++) out.push(rod(tc, round(tx0, THUMB_R - 0.2, j * PITCH), round(tx1, THUMB_R - 0.2, j * PITCH), greek ? 2.7 : 3, greek ? 0.15 : 0.5));
  // The ratchet the pawl pushes: 26 teeth.
  if (!greek) {
    out.push(disc(P.black, RATCHET_DX - 2, RATCHET_DX + 2, RATCHET_R - 2.5, 0.2));
    if (!lite) for (let j = 0; j < 26; j++) out.push(radial(P.black, RATCHET_DX, RATCHET_R - 1.2, j * PITCH + PITCH / 4, 4, 2.6, 2 * RATCHET_R * Math.tan(PITCH / 2) * 0.55, 0.25));
  }
  // Contacts: 26 spring pins on the right, flat brass on the left; the thin wheel has pins both ways.
  const pinR = greek ? 15.6 : 18.9;
  if (!lite) for (let j = 0; j < 26; j++) {
    const phi = -j * PITCH;
    out.push(rod(P.brass, round(pinR, CONTACT_R, phi), round(pinR + 1.2, CONTACT_R, phi), 1.05, 0.5));
    if (greek) out.push(rod(P.brass, round(-8, CONTACT_R, phi), round(-9.2, CONTACT_R, phi), 1.05, 0.5));
    else out.push(rod(P.brass, round(-7.6, CONTACT_R, phi), round(-7.8, CONTACT_R, phi), 1.9, 0.5));
  }
  if (!greek) {
    // The naval ring lock: two spring levers pressed together, not a pin.
    for (const a of [0.55, -2.2]) out.push(radial(P.steel, 8, CORE_R + 0.6, a, 5.4, 1.6, 22, 0.4));
    // The red index on the core the ring setting is read against.
    out.push(radial(P.red, 5.6, CORE_R + 0.2, 0, 1.4, 0.5, 2.4));
    // The wheel's number, engraved.
    strokeText(out, name, [8, (CORE_R + 0.15) * Math.cos(1.57), (CORE_R + 0.15) * Math.sin(1.57)], [0, -1, 0], [-1, 0, 0], { size: 3.6, color: P.black, weight: 0.6 });
  } else {
    strokeText(out, name, [11, (CORE_R + 0.15) * Math.cos(1.57), (CORE_R + 0.15) * Math.sin(1.57)], [0, -1, 0], [-1, 0, 0], { size: 5, color: P.red, weight: 0.9 });
  }
}

/** A wheel's rim and core around their own axle, at a window position; returns nothing, appends. */
function wheelParts(out: Part[], slot: 0 | 1 | 2 | 3, at: Vec3, pos: number, ring: number, name: string, notches: string, P: EnigmaPalette, lite: boolean): void {
  const kind = slot === 0 ? 'greek' : 'wheel', c0 = out.length;
  coreParts(out, kind, name, P, lite);
  turn(out, c0, [0, 0, 0], quatAxisAngle(AXIS_X, (pos - ring) * PITCH));
  const r0 = out.length;
  rimParts(out, kind, notches, P, lite);
  turn(out, r0, [0, 0, 0], quatAxisAngle(AXIS_X, pos * PITCH));
  shift(out, c0, at);
}

const GREEK_GLYPH = { beta: 'β', gamma: 'γ' } as const;
const NUMERAL: Record<string, string> = { I: '1', II: '2', III: '3', IV: '4', V: '5', VI: '6', VII: '7', VIII: '8' };

/** Where the wheels stand once lifted: the stack raised on its spindle and spread. */
export const stackLift = (out: number): number => out * 150;
export const stackX = (x: number, out: number): number => x + out * ((x + 20) * 0.75);
/** A contact of the frame's numbering on a face at x. */
export const contactPoint = (x: number, k: number, r = CONTACT_R): Vec3 => {
  const phi = -k * PITCH;
  return [x, AX_Y + r * Math.cos(phi), AX_Z + r * Math.sin(phi)];
};
/** Where the notch of a letter stands, given the window: tested against the cipher. */
export const notchPhi = (letter: string, window: number): number => WINDOW_PHI + (window - idx(letter)) * PITCH;
export const samePhi = (a: number, b: number): boolean => { const d = (a - b) / (2 * Math.PI); return Math.abs(d - Math.round(d)) < 1e-9; };

/** See through what was just drawn: the current runs inside it. */
function clear(parts: Part[], from: number, alpha: number): void {
  for (let i = from; i < parts.length; i++) { const c = parts[i].color; parts[i].color = [c[0], c[1], c[2], Math.min((c as RGBA)[3] ?? 1, alpha)]; }
}

function stackParts(out: Part[], p: EnigmaPose, P: EnigmaPalette): void {
  const s0 = out.length;
  const lift = stackLift(p.out), sx = (x: number) => stackX(x, p.out), s = p.settings, lite = !!p.lite;
  const rings = [...s.rings.toUpperCase()].map(idx);
  const names = [s.greek, ...s.rotors];
  for (const i of [0, 1, 2, 3] as const) {
    const notches = i === 0 ? '' : ROTORS[s.rotors[i - 1]].notch;
    const label = i === 0 ? GREEK_GLYPH[s.greek] : NUMERAL[names[i]];
    wheelParts(out, i, [sx(RIM_X[i]), AX_Y + lift, AX_Z], p.pos[i], rings[i], label, notches, P, lite);
  }
  // The thin reflector: reddish-brown bakelite with a lug, an index pin and flat contacts; it never turns.
  const u0 = out.length, ux = sx(-98), ukw = P.bakelite;
  out.push(disc(ukw, -6, 6, 36.5, 0.25));
  {
    out.push(disc(P.black, 6, 6.2, 34, 0.1));
    if (!lite) for (let j = 0; j < 26; j++) out.push(rod(P.brass, round(6.2, CONTACT_R, -j * PITCH), round(6.4, CONTACT_R, -j * PITCH), 1.9, 0.5));
    out.push(box(ukw, -6, 6, 26, 36.8, -16, 8, 0.25), box(P.black, -7.2, 7.2, -41, -32, -5, 5, 0.1));
    strokeText(out, s.reflector === 'b' ? 'B' : 'C', [0, 36.9, -4], [1, 0, 0], [0, 0, -1], { size: 7, color: P.ivory, weight: 1.2 });
    out.push(rod(P.steel, [6, 30, -13], [8, 30, -13], 1.1, 0.5));
  }
  shift(out, u0, [ux, AX_Y + lift, AX_Z]);
  // The spindle and the lever that lets the stack down; the entry wheel, black bakelite, stays in the frame.
  out.push(rod(P.steel, [sx(-110), AX_Y + lift, AX_Z], [sx(40), AX_Y + lift, AX_Z], 4.5, 0.5));
  out.push(rod(P.brass, [sx(-104), AX_Y + lift, AX_Z], [sx(-88), AX_Y + lift, AX_Z], 6, 0.5));
  const e0 = out.length;
  out.push(disc(P.black, 0, 16, 37, 0.2));
  {
    out.push(box(P.black, 3, 13, -39, -22, 18, 37, 0.15));
    if (!lite) for (let j = 0; j < 26; j++) out.push(rod(P.brass, round(-0.2, CONTACT_R, -j * PITCH), round(0, CONTACT_R, -j * PITCH), 1.9, 0.5));
  }
  shift(out, e0, [ETW_FACE, AX_Y, AX_Z]);
  if (p.ghost) clear(out, s0, 0.2);
  // The frame the stack sits in.
  for (const x of [-120, 38]) {
    out.push(box(P.black, x - 1.5, x + 1.5, 6, 88, AX_Z - 48, AX_Z + 36, 0.1));
  }
  out.push(cyl(P.steel, -114, AX_Z - 36, 62, 92, 2.2, 0.4), cyl(P.steel, -114, AX_Z - 36, 92, 97, 4.2, 0.4));
  out.push(rod(P.steel, [-114, 76, AX_Z - 36], [-110, 70, AX_Z - 8], 2.4, 0.3));
  // The entry wheel's loom.
  out.push(...wire(P.cotton, [[30, AX_Y - 34, AX_Z + 20], [30, 12, AX_Z + 42], [30, 9, -10]], 3.4));
}

// ---------------------------------------------------------------- pawls

/** The pawl of slot 1..3 sits where its wheel's ratchet meets the next wheel's lip. */
export const pawlX = (slot: 1 | 2 | 3): number => RIM_X[slot] + RATCHET_DX + 1.5;
/** How far a pawl's tip stands from the axle: down in the teeth, or held out by the next wheel's lip. */
export const pawlTipR = (down: boolean): number => (down ? RATCHET_R - 1 : LIP_R + 0.9);

function pawlParts(out: Part[], p: EnigmaPose, P: EnigmaPalette): void {
  if (p.out > 0.02) return;
  const shaftZ = AX_Z - 52, shaftY = AX_Y + 3;
  out.push(rod(P.steel, [-66, shaftY, shaftZ], [36, shaftY, shaftZ], 2.2, 0.4));
  out.push(rod(P.black, [-66, shaftY + 15, shaftZ - 6], [36, shaftY + 15, shaftZ - 6], 2.6, 0.2));
  for (const slot of [1, 2, 3] as const) {
    const x = pawlX(slot), down = p.pawls[slot - 1], lit = p.ghost && down;
    const phi = PAWL_PHI + p.stroke * PITCH, tip: Vec3 = [x, AX_Y + pawlTipR(down) * Math.cos(phi), AX_Z + pawlTipR(down) * Math.sin(phi)];
    const c = lit ? P.forward : down ? P.red : P.steel;
    out.push(rod(c, [x, shaftY, shaftZ], tip, 1.5, 0.4));
    out.push(rod(P.red, [x - 2.4, shaftY, shaftZ], [x + 2.4, shaftY, shaftZ], 3, 0.2));
    out.push(rod(P.black, [x, shaftY + 15, shaftZ - 6], [x, shaftY + 3, shaftZ], 1.4, 0.2));
  }
  // The stepping bar under the deck that every key pushes (its course below the deck is schematic).
  const dip = p.stroke * 3;
  out.push(...wire(P.steel, [[-20, 12 + dip, 40], [-20, 12 + dip, shaftZ + 20], [-20, shaftY - 4, shaftZ]], 1.8, 0.4));
}

// ---------------------------------------------------------------- the top panel and rotor cover

function coverParts(out: Part[], p: EnigmaPose, P: EnigmaPalette): void {
  const c0 = out.length, y0 = PANEL_Y - 1.5, y1 = PANEL_Y, x0 = -128, x1 = 128, z0 = PANEL_BACK, z1 = PANEL_FRONT;
  // Thumbwheel slots, the windows onto the rims and the socket's opening are real holes: the panel is cut around them.
  const slotZ0 = AX_Z - 33.5, slotZ1 = AX_Z + 33.5, hw = 2.6, winZ = AX_Z + RIM_R * Math.sin(WINDOW_PHI), win = 4.75, winL = 5.5;
  holedPlate(out, P.panel, x0, x1, y0, y1, z0, z1, [
    ...RIM_X.map((x): Hole => [x + THUMB_DX - hw, x + THUMB_DX + hw, slotZ0, slotZ1]),
    ...RIM_X.map((x): Hole => [x - win, x + win, winZ - winL, winZ + winL]),
    [52, 68, -115, -84],
  ]);
  // The Greek wheel's bay also holds its plate; a window sits to the left of each thumbwheel.
  RIM_X.forEach((x) => {
    const w = 2 * win, l = 2 * winL, zc = AX_Z + 9;
    out.push(box(P.zinc, x - 8.5, x + 8.5, y1, y1 + 1.1, zc - 13, winZ - l / 2, 0.3), box(P.zinc, x - 8.5, x + 8.5, y1, y1 + 1.1, winZ + l / 2, zc + 13, 0.3));
    out.push(box(P.zinc, x - 8.5, x - w / 2, y1, y1 + 1.1, winZ - l / 2, winZ + l / 2, 0.3), box(P.zinc, x + w / 2, x + 8.5, y1, y1 + 1.1, winZ - l / 2, winZ + l / 2, 0.3));
    out.push(cyl(P.zinc, x, zc - 13, y1, y1 + 1.1, 8.5, 0.3), cyl(P.zinc, x, zc + 13, y1, y1 + 1.1, 8.5, 0.3));
    screw(out, P.brass, x, y1 + 1.1, zc - 18);
    screw(out, P.brass, x, y1 + 1.1, zc + 18);
    // Under the opening the panel has a window to the rim.
    out.push(box([P.glass[0], P.glass[1], P.glass[2], 0.12], x - w / 2, x + w / 2, y1 + 0.3, y1 + 0.5, winZ - l / 2, winZ + l / 2));
  });
  // The station-call window at top left.
  out.push(box(P.black, -132 + 8, -100, y1, y1 + 0.6, -143, -97, 0.05), box(P.panel, -121, -103, y1 + 0.6, y1 + 1.1, -139, -101, 0.05));
  // The plate over the 4 V socket, the socket's opening, and the wheel cover's lock.
  out.push(box(P.zinc, 39, 82, y1, y1 + 0.5, -152, -119, 0.25));
  for (const [i, t] of ['ZUM BETRIEB', 'MIT EINGEBAUTER', 'BATTERIE', 'STECKER HERAUS.'].entries()) strokeText(out, t, [60.5, y1 + 0.55, -148 + i * 5], [1, 0, 0], [0, 0, -1], { size: 2.2, color: P.black, weight: 0.3 });
  strokeText(out, '4 VOLT', [60.5, y1 + 0.55, -124], [1, 0, 0], [0, 0, -1], { size: 4, color: P.black, weight: 0.6 });
  // Lock.
  out.push(cyl(P.steel, 44, -55, y1, y1 + 2.8, 7, 0.4), box(P.black, 43.4, 44.6, y1 + 2.8, y1 + 2.9, -59, -52));
  for (const [x, z] of [[52, -60], [52, -50], [86, -55], [120, -55]] as const) screw(out, P.brass, x, y1, z);
  out.push(box(P.panel, x0, x1, 86, y0, z1 - 1.5, z1, 0.08));
  // Bottom edge roll.
  out.push(rod(P.panel, [x0, y0 + 0.5, z1], [x1, y0 + 0.5, z1], 1.6, 0.1));
  if (p.ghost) out.length = c0;
  turn(out, c0, [0, PANEL_Y, HINGE_Z], quatAxisAngle(AXIS_X, -p.cover * 1.45));
  out.push(rod(P.steel, [-128, PANEL_Y, HINGE_Z], [128, PANEL_Y, HINGE_Z], 1.6, 0.5));
  // What stays under the cover at the right: the battery box and the socket's metal frame.
  out.push(box(P.panel, 70, 124, 6, 92, -150, -60, 0.08), box(P.steel, 64, 68, 8, 88, -150, -80, 0.3));
  out.push(box(P.steel, 42, 66, 40, 88, -150, -146, 0.3), box(P.steel, 42, 66, 40, 88, -84, -80, 0.3), box(P.steel, 42, 46, 40, 88, -150, -80, 0.3));
  out.push(box(P.black, 70, 124, 92, 92.6, -150, -60, 0.08), box(P.steel, 88, 96, 92.6, 93.6, -64, -60, 0.3));
  // The 4 V socket's two pins, seen through the panel's opening.
  out.push(rod(P.brass, [55, 86, -107], [65, 86, -107], 2, 0.4), rod(P.brass, [55, 86, -92], [65, 86, -92], 2, 0.4));
  // The black chassis the stack sits in.
  out.push(box(P.black, -128, 128, 6, 6.6, -158, 46, 0.1), box(P.black, -128, -125, 6, 96, -158, 46, 0.1), box(P.black, 125, 128, 6, 96, -158, 46, 0.1), box(P.black, -128, 128, 6, 96, -158, -156, 0.1), box(P.black, -128, 128, 6, 62, 44, 46, 0.1));
}

// ---------------------------------------------------------------- the lamps

function lampParts(out: Part[], p: EnigmaPose, P: EnigmaPalette): void {
  const row = (fn: (letter: string, x: number, z: number) => void) => KEY_ROWS.forEach((r, i) => [...r].forEach((ch, j) => fn(ch, ROW_X[i] + j * KEY_PITCH, LAMP_Z[i])));
  // Bulb plate: stays in the machine when the cover comes off.
  out.push(box(P.zinc, -116, 116, 78, 80, -38, 44, 0.45));
  row((ch, x, z) => {
    const on = p.lit === ch;
    out.push(cyl(P.brass, x, z, 80, 83, 3.6, 0.5));
    const bulb: Part = cyl(on ? P.lampOn : P.glass, x, z, 83, 89, 4.2, 0.6);
    if (on) bulb.emissive = P.lampOn;
    out.push(bulb, cyl(on ? P.lampOn : P.glass, x, z, 89, 91, 2.8, 0.6));
    if (on) out[out.length - 1].emissive = P.lampOn;
  });
  for (const x of [-112, 110]) out.push(cyl(P.red, x, 4, 80, 80.4, 6), cyl(P.black, x, 4, 80, 80.8, 3.8));
  // The cover: black crackle, 26 windows of letter film, two knurled bolts; lifts off and sets down to the right.
  const c0 = out.length, yTop = 92;
  out.push(box(P.panel, -128, 128, yTop - 3, yTop, -40, 46, 0.08));
  out.push(box(P.panel, -128, 128, 62, yTop - 3, -40, -38, 0.08), box(P.panel, -128, -123, 62, yTop - 3, -40, 46, 0.08), box(P.panel, 123, 128, 62, yTop - 3, -40, 46, 0.08), box(P.panel, -128, 128, 62, yTop - 3, 42, 46, 0.08));
  out.push(rod(P.panel, [-128, yTop - 2.5, 46], [128, yTop - 2.5, 46], 2.5, 0.08));
  row((ch, x, z) => {
    const on = p.lit === ch;
    out.push(cyl(P.black, x, z, yTop, yTop + 0.5, 7.6, 0.5));
    const face = cyl(on ? P.lampOn : P.black, x, z, yTop + 0.5, yTop + 0.55, 6.6, 0.1);
    if (on) { face.color = [P.lampOn[0] * 0.5, P.lampOn[1] * 0.42, P.lampOn[2] * 0.2]; face.emissive = [P.lampOn[0] * 0.28, P.lampOn[1] * 0.22, P.lampOn[2] * 0.08]; }
    out.push(face);
    strokeText(out, ch, [x, yTop + 0.56, z], [1, 0, 0], [0, 0, -1], { size: 7.2, color: on ? P.lampOn : P.lampLetter, emissive: on ? P.lampOn : undefined, weight: 1.2 });
  });
  for (const x of [-122, 122]) {
    out.push(cyl(P.steel, x, 27, yTop, yTop + 2, 5.4, 0.5), cyl(P.red, x, 27, yTop + 2, yTop + 2.3, 3.4), cyl(P.zinc, x, 27, yTop + 2.3, yTop + 2.6, 1.8, 0.4));
    screw(out, P.brass, x, yTop, -30, 1.6);
  }
  shift(out, c0, [p.lamps > 0.5 ? (p.lamps - 0.5) * 2 * 290 : 0, Math.min(1, p.lamps * 2) * 70 - Math.max(0, p.lamps - 0.5) * 2 * (70 + 62), 0]); // down on the table beside the machine
}

// ---------------------------------------------------------------- the keyboard

export const keyAt = (letter: string): { x: number; z: number; row: number } => {
  for (let i = 0; i < 3; i++) { const j = KEY_ROWS[i].indexOf(letter); if (j >= 0) return { x: ROW_X[i] + j * KEY_PITCH, z: KEY_Z[i], row: i }; }
  throw new Error(`No key ${letter}`);
};
export const lampAt = (letter: string): { x: number; z: number } => { const k = keyAt(letter); return { x: k.x, z: LAMP_Z[k.row] }; };

function keyboardParts(out: Part[], p: EnigmaPose, P: EnigmaPalette): void {
  // The cast deck, a terrace per row with a rolled front edge: the corrugation of the real one.
  const zs = [46, 69, 91, FACE_Z];
  DECK_Y.forEach((y, i) => {
    out.push(box(P.panel, -128, 128, 8, y, zs[i], zs[i + 1], 0.1));
    out.push(rod(P.panel, [-128, y, zs[i + 1] - 3], [128, y, zs[i + 1] - 3], 3.4, 0.14));
  });
  out.push(box(P.panel, -128, 128, 42, 50, 110, FACE_Z, 0.1));
  for (const [x, z] of [[-112, 60], [-112, 94], [112, 60], [112, 94], [0, 50], [40, 116]] as const) screw(out, P.brass, x, DECK_Y[z < 69 ? 0 : z < 91 ? 1 : 2], z, 2);
  for (const r of KEY_ROWS) for (const ch of r) {
    const k = keyAt(ch), travel = p.key === ch ? p.stroke * 9 : 0, top = KEY_TOP[k.row] - travel;
    out.push(cyl(P.steel, k.x, k.z, DECK_Y[k.row], top - 4, 2.4, 0.5));
    out.push(cyl(P.black, k.x, k.z, top - 4, top, 7, 0.5), cyl(P.black, k.x, k.z, top - 4.6, top - 4, 5.6, 0.3));
    strokeText(out, ch, [k.x, top + 0.02, k.z], [1, 0, 0], [0, 0, -1], { size: 7.2, color: P.lampLetter, weight: 1.1 });
  }
  // The serial plate: M, the naval part number, serial / maker / year (M16913/aye/44 survives, Crypto Museum's own).
  out.push(box(P.zinc, -26, 26, 50, 50.4, 112, 124, 0.3));
  strokeText(out, 'M', [0, 50.45, 115], [1, 0, 0], [0, 0, -1], { size: 3.2, color: P.black, weight: 0.6 });
  strokeText(out, 'NA 220 900', [0, 50.45, 118.6], [1, 0, 0], [0, 0, -1], { size: 2.2, color: P.black, weight: 0.35 });
  strokeText(out, 'M 16913/AYE/44', [0, 50.45, 122], [1, 0, 0], [0, 0, -1], { size: 2.2, color: P.black, weight: 0.35 });
}

// ---------------------------------------------------------------- the plugboard

/** Socket n (1..26): numbered in reading order over three rows, numbers rather than letters (A = 1). */
export function socketAt(n: number): { x: number; y: number; row: number } {
  let r = n - 1;
  for (let i = 0; i < 3; i++) { if (r < SOCKET_ROWS[i]) return { x: SOCKET_X[i] + r * KEY_PITCH, y: SOCKET_Y[i], row: i }; r -= SOCKET_ROWS[i]; }
  throw new Error(`No socket ${n}`);
}

function plugboardParts(out: Part[], p: EnigmaPose, P: EnigmaPalette): void {
  out.push(box(P.black, -128, 128, 6, 56, FACE_Z - 2, FACE_Z, 0.18));
  const pairs = plugMap(p.settings.plugs);
  for (let n = 1; n <= 26; n++) {
    const s = socketAt(n), plugged = pairs[n - 1] !== n - 1;
    // Two jacks a socket: the thick (4 mm) above, the thin (3 mm) below, so a plug fits only one way.
    out.push(rod(P.steel, [s.x, s.y + 2.7, FACE_Z - 0.1], [s.x, s.y + 2.7, FACE_Z + 0.3], 2.8, 0.5), rod(P.black, [s.x, s.y + 2.7, FACE_Z + 0.3], [s.x, s.y + 2.7, FACE_Z + 0.32], 2, 0.1));
    out.push(rod(P.steel, [s.x, s.y - 2.7, FACE_Z - 0.1], [s.x, s.y - 2.7, FACE_Z + 0.3], 2.3, 0.5), rod(P.black, [s.x, s.y - 2.7, FACE_Z + 0.3], [s.x, s.y - 2.7, FACE_Z + 0.32], 1.5, 0.1));
    strokeText(out, String(n), [s.x, s.y + 9.2, FACE_Z + 0.02], [1, 0, 0], [0, 1, 0], { size: 3.6, color: P.lampLetter, weight: 0.6 });
    if (plugged) {
      const zc = FACE_Z + 12;
      out.push(box(P.black, s.x - 5.5, s.x + 5.5, s.y - 7, s.y + 7, zc - 10, zc + 6, 0.45));
      out.push(rod(P.black, [s.x - 5.5, s.y, zc + 6], [s.x + 5.5, s.y, zc + 6], 7, 0.45));
      out.push(rod(P.brass, [s.x, s.y, zc + 12.9], [s.x, s.y, zc + 13.2], 1.6, 0.5));
      out.push(rod(P.steel, [s.x, s.y + 2.7, zc - 10], [s.x, s.y + 2.7, FACE_Z], 2, 0.5), rod(P.steel, [s.x, s.y - 2.7, zc - 10], [s.x, s.y - 2.7, FACE_Z], 1.5, 0.5));
    }
  }
  // Cable-test sockets with their red dots at each end of the board.
  for (const x of [-120, 120]) {
    out.push(rod(P.steel, [x, 30, FACE_Z], [x, 30, FACE_Z + 0.4], 2.6, 0.5), rod(P.black, [x, 30, FACE_Z + 0.4], [x, 30, FACE_Z + 0.42], 1.8));
    out.push(rod(P.red, [x, 38, FACE_Z], [x, 38, FACE_Z + 0.2], 1.4));
  }
  // A cable between each pair: a loop down to the floor of the flap's well.
  for (let a = 0; a < 26; a++) {
    const b = pairs[a];
    if (b <= a) continue;
    const s = socketAt(a + 1), e = socketAt(b + 1), z = FACE_Z + 26;
    const sag = 7 + ((a * 7) % 4), pts: Vec3[] = [];
    for (let i = 0; i <= 10; i++) {
      const t = i / 10, x = s.x + (e.x - s.x) * t, y0 = (s.y - 7) + (e.y - s.y) * t, y = Math.max(sag, y0 * Math.abs(2 * t - 1) ** 1.5 + sag * (1 - Math.abs(2 * t - 1) ** 1.5));
      pts.push([x, y, z - 2 * Math.sin(t * Math.PI) + (a % 3)]);
    }
    out.push(...wire(P.cable, [[s.x, s.y - 6, FACE_Z + 15], ...pts, [e.x, e.y - 6, FACE_Z + 15]], 1.1));
  }
}

/** A socket's plug, for the current's path: the point on the board. */
const socketPoint = (n: number): Vec3 => { const s = socketAt(n); return [s.x, s.y, FACE_Z + 1]; };

// ---------------------------------------------------------------- the case

const soft = (P: EnigmaPalette): RGB => [(P.wood[0] + P.woodDark[0]) / 2, (P.wood[1] + P.woodDark[1]) / 2, (P.wood[2] + P.woodDark[2]) / 2];

function caseParts(out: Part[], p: EnigmaPose, P: EnigmaPalette): void {
  const w = CASE_W / 2, d = CASE_D / 2, side = (x0: number, x1: number) => box(P.wood, x0, x1, 0, WALL_H, -d, d - 14, 0.05);
  out.push(box(P.wood, -w, w, 0, 6, -d, d, 0.05), side(-w, -w + WOOD), side(w - WOOD, w), box(P.wood, -w, w, 0, WALL_H, -d, -d + WOOD, 0.05));
  grain(out, soft(P), (t, a, b) => box(P.wood, w, w + 0.05, 5 + t * (WALL_H - 10), 5 + t * (WALL_H - 10) + 0.5, -d + a * CASE_D, -d + b * CASE_D), 32, 3);
  grain(out, soft(P), (t, a, b) => box(P.wood, -w - 0.05, -w, 5 + t * (WALL_H - 10), 5 + t * (WALL_H - 10) + 0.5, -d + a * CASE_D, -d + b * CASE_D), 32, 9);
  grain(out, soft(P), (t, a, b) => box(P.wood, -w + a * CASE_W, -w + b * CASE_W, 5 + t * (WALL_H - 10), 5 + t * (WALL_H - 10) + 0.5, -d - 0.05, -d), 24, 21);
  // Seams on the outside: the lid's edge along the walls, the flap's beside them.
  for (const x of [-w - 0.06, w]) out.push(box(P.woodDark, x, x + 0.06, WALL_H - 0.6, WALL_H, -d, d), box(P.woodDark, x, x + 0.06, 6, WALL_H, d - 14.5, d - 14));
  out.push(box(P.woodDark, -w, w, WALL_H - 0.6, WALL_H, -d - 0.06, -d));
  // The side grips: bent metal loops, by the lamp panel's bolts.
  for (const s of [-1, 1]) {
    const x = s * (w - WOOD + 1);
    out.push(...wire(P.zinc, [[x, 78, -5], [x, 92, -2], [x, 92, 28], [x, 78, 31]], 1.6, 0.4));
  }
  // The carrying handle at the back, recessed; the serial number under it.
  out.push(box(P.steel, -40, 40, 68, 71, -d - 0.6, -d, 0.3), ...wire(P.steel, [[-34, 69, -d - 0.6], [-34, 60, -d - 8], [34, 60, -d - 8], [34, 69, -d - 0.6]], 1.8, 0.4));
  // The flap: down on the table in use, up over the plugs before enciphering ('Klappe schließen').
  const f0 = out.length, fw = w - 0.5, fy = 6, fh = WALL_H - fy;
  out.push(box(P.wood, -fw, fw, fy, fy + fh, d - 14, d, 0.05));
  grain(out, soft(P), (t, a, b) => box(P.wood, -fw + a * CASE_W, -fw + b * CASE_W, fy + 2 + t * (fh - 4), fy + 2 + t * (fh - 4) + 0.5, d, d + 0.05), 24, 33);
  strokeText(out, 'KLAPPE', [0, fy + fh / 2 - 6, d - 14.03], [1, 0, 0], [0, -1, 0], { size: 6, color: P.woodDark, weight: 1.1 });
  strokeText(out, 'SCHLIESSEN', [0, fy + fh / 2 + 5, d - 14.03], [1, 0, 0], [0, -1, 0], { size: 6, color: P.woodDark, weight: 1.1 });
  for (const s of [-1, 1]) out.push(box(P.zinc, s * 118 - 7, s * 118 + 7, fy + fh - 8, fy + fh - 2, d - 14.8, d - 14, 0.3));
  out.push(box(P.zinc, -10, 10, fy + fh - 8, fy + fh, d, d + 0.8, 0.3));
  turn(out, f0, [0, 7.8, d - 7], quatAxisAngle(AXIS_X, p.flap * (Math.PI / 2)));
  out.push(box(P.zinc, -w + 6, w - 6, 5.5, 6.2, d - 26, d - 14, 0.4));
}

function lidParts(out: Part[], p: EnigmaPose, P: EnigmaPalette): void {
  const l0 = out.length, w = CASE_W / 2, d = CASE_D / 2, y0 = WALL_H, y1 = CASE_H;
  out.push(box(P.wood, -w, w, y1 - 7, y1, -d, d, 0.05));
  grain(out, soft(P), (t, a, b) => box(P.wood, -w + 3 + t * (CASE_W - 6), -w + 3 + t * (CASE_W - 6) + 0.6, y1, y1 + 0.05, -d + a * CASE_D, -d + b * CASE_D), 52, 57);
  grain(out, soft(P), (t, a, b) => box(P.wood, -w + 3 + t * (CASE_W - 6), -w + 3 + t * (CASE_W - 6) + 0.6, y1 - 7.05, y1 - 7, -d + a * CASE_D, -d + b * CASE_D), 40, 71);
  out.push(box(P.wood, -w, -w + 9, y0, y1 - 7, -d, d), box(P.wood, w - 9, w, y0, y1 - 7, -d, d), box(P.wood, -w, w, y0, y1 - 7, -d, -d + 9), box(P.wood, -w, w, y0, y1 - 7, d - 9, d));
  // Inside, seen when open (facing down while shut): ten spare bulbs, the green contrast filter, two spare cables, the note.
  const yi = y1 - 7;
  out.push(box(P.steel, -116, 116, yi - 1, yi, d - 34, d - 18, 0.3));
  for (let i = 0; i < 10; i++) {
    const x = -103 + i * 22.9, z = d - 26;
    out.push(cyl(P.brass, x, z, yi - 4, yi - 1, 3.6, 0.5), cyl(P.glass, x, z, yi - 9, yi - 4, 4, 0.6));
  }
  out.push(box(P.black, -105, 105, yi - 1.2, yi, d - 132, d - 72, 0.8));
  for (const x of [-108, 108]) out.push(cyl(P.brass, x, d - 102, yi - 1.5, yi, 2, 0.4));
  // The note: Merkblatt zum Schlüssel M, by the hinge.
  out.push(box(P.paper, -77, 77, yi - 0.4, yi, -d + 23, -d + 88, 0.02));
  for (let i = 0; i < 8; i++) out.push(box(P.woodDark, -70, i % 4 === 3 ? 10 : 70, yi - 0.46, yi - 0.4, -d + 30 + i * 7, -d + 31 + i * 7));
  // Two spare patch cables, their plugs in bakelite clips left and right, held by two clips each.
  for (const [zl, zr, zm] of [[-d + 55, -d + 105, -d + 130], [-d + 80, -d + 132, -d + 163]] as const) {
    const y = yi - 3;
    out.push(box(P.black, -118, -104, yi - 12, yi, zl - 11, zl + 11, 0.4), box(P.black, 104, 118, yi - 12, yi, zr - 11, zr + 11, 0.4));
    out.push(...wire(P.cable, [[-104, y, zl], [-65, y, zm], [65, y, zm], [104, y, zr]], 1));
    for (const x of [-65, 65]) out.push(box(P.zinc, x - 2, x + 2, yi - 4.5, yi, zm - 4, zm + 4, 0.3));
  }
  // The stamp in the wood; the case lock's hasp on the far edge.
  out.push(box(P.red, -22, 22, yi - 0.04, yi, d - 50, d - 45));
  out.push(box(P.zinc, -14, 14, y0 + 8, y0 + 18, d, d + 0.8, 0.3));
  turn(out, l0, [0, WALL_H, -d], quatAxisAngle(AXIS_X, -p.lid * 1.92));
  // Hinges on the back edge, with their pins that let the lid come off.
  for (const x of [-79, 80]) {
    out.push(box(P.zinc, x - 28, x + 28, WALL_H - 14, WALL_H, -d - 0.5, -d, 0.35), rod(P.steel, [x - 34, WALL_H, -d - 1.5], [x + 34, WALL_H, -d - 1.5], 1.8, 0.5));
    for (const dx2 of [-20, 0, 20]) out.push(rod(P.brass, [x + dx2, WALL_H - 7, -d - 0.5], [x + dx2, WALL_H - 7, -d - 0.9], 1.3, 0.4));
  }
}

// ---------------------------------------------------------------- the current

/** The current's way through the machine, as polylines in frame numbering: wheel to wheel on the true contacts. */
export function pathPoints(t: Trace): { forward: Vec3[]; back: Vec3[] } {
  const rights = [RIM_X[3] + 19.5, RIM_X[2] + 19.5, RIM_X[1] + 19.5, RIM_X[0] + 16.8];
  const lefts = [RIM_X[3] - 7.6, RIM_X[2] - 7.6, RIM_X[1] - 7.6, RIM_X[0] - 9.2];
  const forward: Vec3[] = [contactPoint(ETW_FACE, t.entry)];
  let k = t.entry;
  t.out.forEach((o, i) => { forward.push(contactPoint(rights[i], k), contactPoint(lefts[i], o)); k = o; });
  forward.push(contactPoint(UKW_FACE, k));
  const back: Vec3[] = [contactPoint(UKW_FACE, k), contactPoint(UKW_FACE - 6, k, 10), contactPoint(UKW_FACE - 6, t.back, 10), contactPoint(UKW_FACE, t.back)];
  k = t.back;
  t.ret.forEach((o, i) => { const w = 3 - i; back.push(contactPoint(lefts[w], k), contactPoint(rights[w], o)); k = o; });
  back.push(contactPoint(ETW_FACE, k));
  return { forward, back };
}

function currentParts(out: Part[], t: Trace, p: EnigmaPose, P: EnigmaPalette): void {
  const { forward, back } = pathPoints(t), pl = plugMap(p.settings.plugs);
  const hot = (c: RGB, r: number, pts: Vec3[]) => { for (const q of wire(c, pts, r)) { q.emissive = [c[0] * 0.55, c[1] * 0.55, c[2] * 0.55]; out.push(q); } };
  hot(P.forward, 0.7, forward);
  hot(P.back, 0.7, back);
  // Key to plugboard to entry wheel, and entry wheel to plugboard to lamp, through the machine's belly (schematic).
  const key = keyAt(t.input), lamp = lampAt(t.output);
  const inA = socketPoint(idx(t.input) + 1), inB = socketPoint(pl[idx(t.input)] + 1);
  const outA = socketPoint(t.exit + 1), outB = socketPoint(idx(t.output) + 1);
  hot(P.forward, 0.7, [[key.x, DECK_Y[key.row], key.z], [key.x, 34, key.z], [key.x, 34, FACE_Z - 6], [inA[0], inA[1], FACE_Z - 6], inA]);
  if (inA[0] !== inB[0] || inA[1] !== inB[1]) hot(P.forward, 0.7, [inA, [inA[0], inA[1], FACE_Z + 18], [inB[0], inB[1], FACE_Z + 18], inB]);
  const start = forward[0], end = back[back.length - 1];
  hot(P.forward, 0.7, [inB, [inB[0], inB[1], FACE_Z - 6], [inB[0], 10, FACE_Z - 6], [24, 10, AX_Z + 42], [24, start[1], start[2]], start]);
  hot(P.back, 0.7, [end, [33, end[1], end[2]], [33, 12, AX_Z + 42], [outA[0], 12, FACE_Z - 8], [outA[0], outA[1], FACE_Z - 8], outA]);
  if (outA[0] !== outB[0] || outA[1] !== outB[1]) hot(P.back, 0.7, [outA, [outA[0], outA[1], FACE_Z + 20], [outB[0], outB[1], FACE_Z + 20], outB]);
  hot(P.back, 0.7, [outB, [outB[0], outB[1], FACE_Z - 10], [lamp.x, 40, FACE_Z - 10], [lamp.x, 40, lamp.z], [lamp.x, 80, lamp.z]]);
}

// ---------------------------------------------------------------- the whole machine

export function enigmaParts(p: EnigmaPose, P: EnigmaPalette): Part[] {
  const out: Part[] = [];
  caseParts(out, p, P);
  keyboardParts(out, p, P);
  plugboardParts(out, p, P);
  lampParts(out, p, P);
  coverParts(out, p, P);
  stackParts(out, p, P);
  pawlParts(out, p, P);
  if (!p.ghost) lidParts(out, p, P);
  if (p.trace && p.out < 0.02) currentParts(out, p.trace, p, P);
  return out.filter((q) => (q.scale ?? [1, 1, 1]).every((v) => v > 0));
}

export function enigmaAnchors(p: EnigmaPose): Anchor[] {
  const up: Vec3 = [0, 1, 0], lift = stackLift(p.out), sx = (x: number) => stackX(x, p.out), a: Anchor[] = [];
  if (p.lid > 0.5) {
    a.push({ text: 'Lamps', p: [-130, 94, 5], side: 'l', n: up }, { text: 'Keyboard', p: [131, 62, 80], side: 'r', n: up });
    if (p.flap > 0.5) a.push({ text: 'Plugboard: sockets by number', p: [132, 30, FACE_Z], side: 'r', n: [0, 0, 1] });
  }
  if (p.cover > 0.5) {
    const y = AX_Y + lift + RIM_R;
    const back = AX_Z - 44;
    a.push({ text: 'Reflector', p: [sx(-98), y - 6, AX_Z], side: 'l', n: up });
    a.push({ text: 'Greek', p: [sx(RIM_X[0]), y, back], side: 't', n: up }, { text: 'Left', p: [sx(RIM_X[1]), y, back], side: 't', n: up }, { text: 'Middle', p: [sx(RIM_X[2]), y, back], side: 't', n: up }, { text: 'Right', p: [sx(RIM_X[3]), y, back], side: 't', n: up });
    a.push({ text: 'Entry wheel', p: [ETW_FACE + 14, AX_Y + RIM_R - 12, AX_Z + 16], side: 'r', n: up, minor: true });
    if (p.out < 0.1) a.push({ text: 'Pawls', p: [36, AX_Y + 3, AX_Z - 52], side: 'r', n: up, minor: true });
    a.push({ text: 'Battery', p: [97, 93, -105], side: 'r', n: up, minor: true });
  } else if (p.lid > 0.5) {
    a.push({ text: 'Windows: the four wheels', p: [RIM_X[1], PANEL_Y + 2, AX_Z - 25], side: 't', n: up });
  }
  return a;
}

