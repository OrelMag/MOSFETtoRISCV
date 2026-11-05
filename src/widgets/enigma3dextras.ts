// What the M4 hides and what came with it (DOM-free, tested): the wiring and key switches under the deck, the box of spare
// wheels, the Schreibmax printer. Each key is a changeover switch: at rest its common goes to its own lamp, pressed to the
// battery. So the pressed key's lamp is cut off, which is why no letter ever enciphers to itself. Sizes of the leaf switches and
// the loom's course from Crypto Museum's photographs of an opened Enigma I; the box and the printer's sizes are estimated from
// theirs, the box's checked by the wheels having to fit.

import type { RGB } from '../gl/instances';
import { quatAxisAngle, type Vec3 } from '../gl/math';
import { box, cyl, rod, wire, type Part } from '../gl/parts';
import { idx, KEY_ROWS, ALPHABET, chr, plugMap, ROTORS, socketOf, type RotorName, type Trace } from '../crypto/enigma';
import { AX_Z, clear, contactPoint, ETW_FACE, FACE_Z, grain, holedPlate, keyAt, lampAt, pathPoints, shift, socketAt, soft, turn, wheelParts, type EnigmaPalette, type EnigmaPose } from './enigma3dparts';
import { strokeText } from './strokefont';

// ---------------------------------------------------------------- the wiring

/** A wire between two terminals, named as `key:A:c` (common), `key:A:r` (rest contact), `sock:A:hi` / `lo` (the socket's two
 *  jacks, 4 mm above, 3 mm below), `etw:0` (entry wheel contact), `lamp:A`. */
export interface Wire { a: string; b: string; pts: Vec3[] }

const CLAMP_BACK = 44, BTN_Y = 38;
const ETW_REAR = ETW_FACE + 16, LOOM_X = 112, LOOM_Y = 13;
const jackY = (n: number, hi: boolean) => socketAt(n).y + (hi ? 2.7 : -2.7);

let wires: Wire[] | null = null;
/** The 78 wires, three a letter. Plain data: the current's path and the test's circuit walk read the same list. */
export function harness(): Wire[] {
  if (wires) return wires;
  wires = [];
  for (const L of ALPHABET) {
    const i = idx(L), k = keyAt(L), n = socketOf(L), s = socketAt(n), lamp = lampAt(L), cz = k.z - CLAMP_BACK;
    // Bundled, but each on its own line: a few millimetres apart by letter.
    const jx = ((i % 5) - 2) * 1.1, jy = (((i * 3) % 5) - 2) * 1.1, under = 15 + (i % 5) * 0.9;
    wires.push({ a: `key:${L}:c`, b: `sock:${L}:hi`, pts: [[k.x, 24, cz], [k.x, under, cz], [k.x, under, FACE_Z - 8 - (i % 4)], [s.x, jackY(n, true), FACE_Z - 8 - (i % 4)], [s.x, jackY(n, true), FACE_Z - 2]] });
    const e = contactPoint(ETW_REAR, i);
    wires.push({ a: `sock:${L}:lo`, b: `etw:${i}`, pts: [[s.x, jackY(n, false), FACE_Z - 2], [s.x, jackY(n, false), FACE_Z - 13], [s.x, 8 + (i % 4) * 0.6, FACE_Z - 13], [LOOM_X + jx, LOOM_Y + jy, FACE_Z - 13], [LOOM_X + jx, LOOM_Y + jy, -50], [ETW_REAR + 8 + jx, 20 + jy, AX_Z + 40], [ETW_REAR + 3, e[1], e[2]], e] });
    wires.push({ a: `key:${L}:r`, b: `lamp:${L}`, pts: [[k.x, 29, cz], [k.x + 1.4, 42, cz], [lamp.x + 1.4, 74, lamp.z], [lamp.x, 78, lamp.z]] });
  }
  return wires;
}
const wireOf = (a: string): Wire => {
  const w = harness().find((x) => x.a === a || x.b === a);
  if (!w) throw new Error(`No wire at ${a}`);
  return w;
};
const from = (w: Wire, start: string): Vec3[] => (w.a === start ? w.pts : [...w.pts].reverse());

/** The feed each row's work contacts share. */
const busZ = (row: number) => [50, 72, 94][row];
const BUS_Y = 27;

/** The current's way through the wires, out from the battery, back to the lamp: the real runs, jack to jack. */
export function currentRuns(t: Trace, plugs: string): { forward: Vec3[][]; back: Vec3[][] } {
  const pl = plugMap(plugs), I = t.input, O = t.output, P = chr(pl[idx(I)]), Q = chr(t.exit), k = keyAt(I), wheels = pathPoints(t);
  const forward: Vec3[][] = [
    [[k.x, BUS_Y, busZ(k.row)], [k.x, 29, k.z - 10], [k.x, 24, k.z - CLAMP_BACK]],
    from(wireOf(`key:${I}:c`), `key:${I}:c`),
    jump(socketOf(I), true, socketOf(P), false),
    from(wireOf(`sock:${P}:lo`), `sock:${P}:lo`),
    [contactPoint(ETW_REAR, t.entry), contactPoint(ETW_FACE, t.entry)],
    wheels.forward,
  ];
  const back: Vec3[][] = [
    wheels.back,
    [contactPoint(ETW_FACE, t.exit), contactPoint(ETW_REAR, t.exit)],
    from(wireOf(`etw:${t.exit}`), `etw:${t.exit}`),
    jump(socketOf(Q), false, socketOf(O), true),
    from(wireOf(`sock:${O}:hi`), `sock:${O}:hi`),
    [wireOf(`key:${O}:c`).pts[0], wireOf(`key:${O}:r`).pts[0]],
    from(wireOf(`key:${O}:r`), `key:${O}:r`),
  ];
  return { forward, back };
}
/** Across the plugboard: a cable's crossed wires between two sockets, or the shorting bar behind one with no plug. */
function jump(a: number, aHi: boolean, b: number, bHi: boolean): Vec3[] {
  const A = socketAt(a), B = socketAt(b), z = FACE_Z + (a === b ? -1 : 24);
  return [[A.x, jackY(a, aHi), FACE_Z - 2], [A.x, jackY(a, aHi), z], [B.x, jackY(b, bHi), z], [B.x, jackY(b, bHi), FACE_Z - 2]];
}

/** Under the deck: key switches, feeds, the lamp plate's posts and the wires themselves. */
export function insideParts(out: Part[], p: EnigmaPose, P: EnigmaPalette): void {
  const ghost = p.ghost, cloth: RGB = P.loom;
  for (const r of KEY_ROWS) for (const ch of r) {
    const k = keyAt(ch), travel = p.key === ch ? p.stroke * 3 : 0, cz = k.z - CLAMP_BACK;
    // The leaf switch: a clamp of fibre and zinc with three screws, brass leaves running to a black button under the key.
    out.push(box(P.bakelite, k.x - 4.5, k.x + 4.5, 24, 30, cz, cz + 14, 0.1), box(P.zinc, k.x - 4.5, k.x + 4.5, 30, 32, cz, cz + 14, 0.3));
    for (const d of [3, 7, 11]) out.push(cyl(P.zinc, k.x, cz + d, 32, 33.2, 1.4, 0.4));
    out.push(rod(P.brass, [k.x, 30.5, cz + 14], [k.x, 34.5 - travel, k.z - 2], 2, 0.5), rod(P.steel, [k.x + 2.4, 29.2, cz + 14], [k.x + 2.4, 29.2, k.z - 10], 0.8, 0.4));
    out.push(rod(P.brass, [k.x, 27.6, cz + 14], [k.x, 28, k.z - 4], 1.6, 0.5));
    out.push(cyl(P.black, k.x, k.z, BTN_Y - 5 - travel, BTN_Y - 1 - travel, 3.4, 0.2), box(P.black, k.x - 4, k.x + 4, BTN_Y - 6.4 - travel, BTN_Y - 5 - travel, k.z - 4, k.z + 4, 0.2));
  }
  // The feeds the work contacts share, a lattice each key's button bears on (it works the stepping bar), and the battery's two leads.
  for (const row of [0, 1, 2]) {
    out.push(rod(P.brass, [-118, BUS_Y, busZ(row)], [118, BUS_Y, busZ(row)], 0.9, 0.5));
    out.push(rod(P.black, [-122, 20, busZ(row) + 8], [122, 20, busZ(row) + 8], 1.6, 0.15));
  }
  out.push(rod(P.brass, [118, BUS_Y, busZ(0)], [118, BUS_Y, busZ(2)], 0.9, 0.5), rod(P.black, [-122, 20, busZ(0) + 8], [-122, 20, busZ(2) + 8], 1.6, 0.15), rod(P.black, [122, 20, busZ(0) + 8], [122, 20, busZ(2) + 8], 1.6, 0.15));
  out.push(...wire(P.red, [[118, BUS_Y, busZ(0)], [120, 30, -40], [100, 44, -62]], 0.9), ...wire(P.black, [[118, 76, -30], [122, 60, -42], [108, 44, -62]], 0.9));
  // Four posts hold the lamp plate above the switches.
  for (const [x, z] of [[-112, -30], [112, -30], [-112, 38], [112, 38]] as const) out.push(cyl(P.zinc, x, z, 6, 78, 2.6, 0.4));
  // Every lamp's return, a bus under each row of the plate.
  for (const z of [-18, 4, 27]) out.push(rod(P.brass, [-118, 76.5, z], [118, 76.5, z], 0.7, 0.5));
  // The wires, then the cloth loom wrapped round the run to the entry wheel.
  for (const w of harness()) out.push(...wire(w.a.endsWith(':c') ? P.wireKey : w.a.endsWith(':r') ? P.wireLamp : cloth, w.pts, 0.55));
  const l0 = out.length;
  out.push(...wire(P.cotton, [[LOOM_X, LOOM_Y, FACE_Z - 13], [LOOM_X, LOOM_Y, -50], [ETW_REAR + 8, 20, AX_Z + 40]], 4.4));
  if (ghost) clear(out, l0, 0.2);
  // The sockets' backs, where the wires end.
  for (let n = 1; n <= 26; n++) {
    const s = socketAt(n);
    for (const hi of [true, false]) out.push(rod(P.steel, [s.x, s.y + (hi ? 2.7 : -2.7), FACE_Z - 2], [s.x, s.y + (hi ? 2.7 : -2.7), FACE_Z - 5], 1.3, 0.4));
  }
}

/** The lit wires, on top of what insideParts drew. */
export function currentParts(out: Part[], t: Trace, p: EnigmaPose, P: EnigmaPalette): void {
  const { forward, back } = currentRuns(t, p.settings.plugs);
  const hot = (c: RGB, runs: Vec3[][]) => { for (const pts of runs) for (const q of wire(c, pts, 1)) { q.emissive = [c[0] * 0.6, c[1] * 0.6, c[2] * 0.6]; out.push(q); } };
  hot(P.forward, forward);
  hot(P.back, back);
}

// ---------------------------------------------------------------- the spare wheels

export const BOX_AT: Vec3 = [-268, 0, 40];
export const BOX_W = 98;
const BOX_D = 59, BOX_BODY = 74, BOX_LID = 42, WHEEL_Y = 56;
export const BOX_SLOT = (i: number): number => -75 + 25 * i - 6;
/** The wheels not in the machine, in order: five of the eight, stored in the box (it has room for seven). */
export const spareWheels = (rotors: readonly RotorName[]): RotorName[] => (Object.keys(ROTORS) as RotorName[]).filter((n) => !rotors.includes(n));
const NUMERAL: Record<string, string> = { I: '1', II: '2', III: '3', IV: '4', V: '5', VI: '6', VII: '7', VIII: '8' };

export function boxParts(out: Part[], p: EnigmaPose, P: EnigmaPalette): void {
  const b0 = out.length, w = BOX_W, d = BOX_D, h = BOX_BODY, t = 6;
  out.push(box(P.wood, -w, w, 0, t, -d, d, 0.05), box(P.wood, -w, -w + t, 0, h, -d, d, 0.05), box(P.wood, w - t, w, 0, h, -d, d, 0.05), box(P.wood, -w, w, 0, h, -d, -d + t, 0.05), box(P.wood, -w, w, 0, h, d - t, d, 0.05));
  grain(out, soft(P), (g, a, c) => box(P.wood, -w + a * 2 * w, -w + c * 2 * w, 3 + g * (h - 6), 3 + g * (h - 6) + 0.5, d, d + 0.05), 14, 91);
  // The dovetails at the corners.
  for (let i = 0; i < 7; i++) for (const s of [-1, 1]) out.push(box(P.woodDark, s * w - 0.05 * (s + 1), s * w + 0.05 * (1 - s), 4 + i * 10, 8.5 + i * 10, d - 6.1, d - 5.9));
  // Slots for seven wheels: two strips of oak on the floor.
  for (let i = 0; i < 7; i++) for (const z of [-30, 30]) out.push(box(P.woodDark, BOX_SLOT(i) + 10, BOX_SLOT(i) + 16, t, t + 2.4, z - 8, z + 8, 0.05));
  spareWheels(p.settings.rotors).forEach((name, i) => wheelParts(out, 1, [BOX_SLOT(i), WHEEL_Y, 0], 0, 0, NUMERAL[name], ROTORS[name].notch, P, !!p.lite));
  // The front: an oval lock plate with its key, the machine's number, a webbing strap.
  out.push(rod(P.zinc, [-16, h - 22, d], [16, h - 22, d], 0.6, 0.3));
  out.push(box(P.zinc, -16, 16, h - 29, h - 15, d, d + 0.6, 0.3), rod(P.zinc, [-16, h - 22, d], [-16, h - 22, d + 0.6], 7, 0.3), rod(P.zinc, [16, h - 22, d], [16, h - 22, d + 0.6], 7, 0.3));
  out.push(box(P.zinc, -20, 20, h - 46, h - 37, d, d + 0.5, 0.3));
  strokeText(out, 'M 16913', [0, h - 41.5, d + 0.52], [1, 0, 0], [0, 1, 0], { size: 4, color: P.black, weight: 0.7 });
  out.push(...wire(P.cotton, [[-60, h - 24, d + 1.5], [-30, h - 46, d + 5], [0, h - 52, d + 7], [30, h - 46, d + 5], [60, h - 24, d + 1.5]], 1.5));
  for (const s of [-1, 1]) out.push(box(P.steel, s * 60 - 5, s * 60 + 5, h - 32, h - 18, d, d + 0.8, 0.3));
  // The lid, open on its back edge, its top pinned with brass.
  const l0 = out.length;
  out.push(box(P.wood, -w, w, h + BOX_LID - t, h + BOX_LID, -d, d, 0.05), box(P.wood, -w, -w + t, h, h + BOX_LID, -d, d, 0.05), box(P.wood, w - t, w, h, h + BOX_LID, -d, d, 0.05), box(P.wood, -w, w, h, h + BOX_LID, -d, -d + t, 0.05), box(P.wood, -w, w, h, h + BOX_LID, d - t, d, 0.05));
  grain(out, soft(P), (g, a, c) => box(P.wood, -w + a * 2 * w, -w + c * 2 * w, h + BOX_LID, h + BOX_LID + 0.05, -d + 3 + g * (2 * d - 6), -d + 3.5 + g * (2 * d - 6)), 14, 77);
  for (let i = 0; i < 7; i++) for (const z of [-30, 30]) out.push(cyl(P.brass, BOX_SLOT(i) + 13, z, h + BOX_LID, h + BOX_LID + 0.15, 2, 0.4));
  turn(out, l0, [0, h, -d], quatAxisAngle([1, 0, 0], -1.72));
  shift(out, b0, BOX_AT);
}

// ---------------------------------------------------------------- the Schreibmax

/** The base plate's top and the printer's front. */
export const PRN_BASE = 124;
const PRN_FRONT = -32;
/** The last letters on the paper, the oldest furthest along it. */
export const TAPE_SHOWN = 34;

export function printerParts(out: Part[], p: EnigmaPose, P: EnigmaPalette): void {
  const y = PRN_BASE, panel = P.panel;
  // The base plate: wider than the machine, over the lamps, with a cut-out onto the wheels' windows.
  holedPlate(out, panel, -146, 146, y - 3, y, -170, 46, [[-100, 34, -114, -56]]);
  out.push(box(panel, -146, -142, 100, y - 3, -170, 46, 0.08), box(panel, 142, 146, 100, y - 3, -170, 46, 0.08), box(panel, -146, 146, 60, y - 3, 42, 46, 0.08), box(panel, -146, 146, 100, y - 3, -170, -166, 0.08));
  out.push(rod(panel, [-146, y - 1.5, 46], [146, y - 1.5, 46], 3, 0.08));
  for (const s of [-1, 1]) out.push(cyl(P.zinc, s * 132, 36, y, y + 3, 6, 0.5), cyl(P.zinc, s * 132, 36, y + 3, y + 7, 2.6, 0.4));
  // The warning: do not turn the wheels with a key held down.
  out.push(box(P.zinc, -60, 60, y, y + 0.4, 6, 30, 0.3));
  strokeText(out, 'WALZEN NICHT DREHEN', [0, y + 0.45, 14], [1, 0, 0], [0, 0, -1], { size: 3.4, color: P.black, weight: 0.5 });
  strokeText(out, 'BEI GEDRUECKTER TASTE', [0, y + 0.45, 22], [1, 0, 0], [0, 0, -1], { size: 3.4, color: P.black, weight: 0.5 });
  // The printer: a black box on the back of the plate.
  const x0 = -18, x1 = 138, z0 = -165, z1 = PRN_FRONT, top = 278;
  out.push(box(panel, x0, x1, y, top, z0, z1, 0.1), box(P.black, x0, x1, top, top + 0.6, z0, z1, 0.1));
  out.push(box(P.zinc, 44, 92, top + 0.6, top + 1, -110, -96, 0.3), box(P.black, 52, 84, top + 1, top + 1.05, -105, -101));
  // Ventilation on its right side.
  for (const yy of [160, 248]) for (let r = 0; r < 4; r++) for (let c = 0; c < 10; c++) out.push(box(P.black, x1, x1 + 0.05, yy + r * 5, yy + r * 5 + 2.4, -150 + c * 9, -146 + c * 9));
  // The face: a knob, the paper's way, the print wheel, the capstan and its roller, the two keys.
  const fz = z1, disk = (x: number, yy: number, r: number, c: RGB, d = 5, spec = 0.3) => rod(c, [x, yy, fz], [x, yy, fz + d], r, spec);
  out.push(disk(62, 262, 8, P.black, 4), disk(62, 262, 4, P.steel, 7));
  out.push(disk(66, 184, 21, P.zinc, 6, 0.5), disk(66, 184, 5, P.steel, 8));
  // The print wheel turns to the letter the lamp would have lit.
  const last = p.tape.length ? idx(p.tape[p.tape.length - 1]) : 0, a = last * ((2 * Math.PI) / 26);
  for (let i = 0; i < 3; i++) { const b = a + (i * 2 * Math.PI) / 3; out.push(disk(66 + 12 * Math.sin(b), 184 + 12 * Math.cos(b), 3, P.steel, 7.5)); }
  out.push(disk(30, 168, 12, P.black, 8), disk(30, 168, 4, P.steel, 10), box(P.black, 30, 112, 142, 158, fz, fz + 7, 0.2));
  out.push(disk(118, 150, 6, P.black, 8), disk(18, 208, 5, P.black, 7), disk(100, 214, 3.4, P.steel, 6));
  for (const [x, ch] of [[20, '+'], [46, '-']] as const) {
    out.push(box(P.zinc, x - 8, x + 8, 228, 236, fz, fz + 0.6, 0.3));
    strokeText(out, ch, [x, 232, fz + 0.65], [1, 0, 0], [0, 1, 0], { size: 3.4, color: P.black, weight: 0.8 });
  }
  // The paper: down from the reel, past the print wheel, out over the plate with the day's traffic on it.
  const paper = (pts: Vec3[]) => { for (let i = 0; i + 1 < pts.length; i++) { const [a0, b0] = [pts[i], pts[i + 1]]; out.push(rod(P.paper, a0, b0, 0.8)); } };
  paper([[128, 262, fz + 4], [128, 150, fz + 4], [84, 158, fz + 8.4], [30, 158, fz + 8.4]]);
  paper([[30, 158, fz + 8.4], [8, 130, fz + 10]]);
  const stripY = y + 0.5, stripZ = 1, xs = 8;
  out.push(rod(P.paper, [8, y + 2, fz + 10], [8, stripY, stripZ - 6], 0.8));
  out.push(box(P.paper, -138, xs, stripY - 0.1, stripY, stripZ - 13, stripZ - 4));
  const shown = p.tape.slice(-TAPE_SHOWN);
  [...shown].forEach((c, i) => strokeText(out, c, [xs - 4.2 * (shown.length - i), stripY + 0.02, stripZ - 8.5], [1, 0, 0], [0, 0, -1], { size: 3.2, color: P.black, weight: 0.5 }));
  // The 30-pin connector at the right, its yellow plug and the mains lead.
  out.push(box(P.lampOn, 146, 174, 96, 122, -128, -44, 0.2));
  out.push(...wire(P.bakelite, [[170, 100, -52], [190, 40, 40], [240, 6, 90], [300, 3, 120]], 2));
}

