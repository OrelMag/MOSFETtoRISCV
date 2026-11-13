// The AGC's Block II logic module on the studio renderer (DOM-free, tested). Four places in one scene, each a view:
//   tray     the logic tray, its slots and modules, the four-bit arithmetic module A8 lifted out (the tray is drawn);
//   module   one module laid flat, its epoxy cut away to the top board of sixty flatpacks (the other board under it);
//   package  one flatpack to drawing 1006321, its lid lifting off the die and the ten bond wires;
//   gate     the die enlarged MAG times: the chip's two NOR gates, each three NPN transistors under one collector
//            resistor with a base resistor on each input; the first gate's inputs a, b, c drive it (lib/agcnor.ts's rule).
// Units: mm (agcmodule3dgeom.ts).

import { merge, roundedBox, transform, tube, type Geo } from '../gl/kit/geo';
import { M, type Material } from '../gl/kit/materials';
import type { Beat, Item, Model3, StudioAnchor } from '../gl/kit/scene';
import type { OrbitView } from '../gl/camera';
import type { Vec3 } from '../gl/math';
import {
  ADDER_GATES, ADDER_PACKAGES, BOARD_T, DIE, FP, LEADS, LIFTED, MAG, MOD, MODULE_GATES, PACKAGES, PER_BOARD, SLOTS, TRAY,
  conducting, norOut, packageAt, slotX,
} from './agcmodule3dgeom';

type Detail = 'full' | 'flat';
export type AgcView = 'tray' | 'module' | 'package' | 'gate';
export interface AgcPose { view: AgcView; ins: [number, number, number]; adder: boolean }

const SRC = {
  scd: 'MIT / MSC drawing 1006321 rev G, Dual NOR Gate (Flat Pack), sheet 3 (klabs.org)',
  shirriff: 'K. Shirriff, "A computer built from NOR gates: inside the Apollo Guidance Computer" (righto.com, 2019)',
  chm: 'Computer History Museum, logic module record: 5/8 × 9 5/8 × 1 3/4 in',
  hall: "E. C. Hall, MIT's Role in Project Apollo (1972), p. 129, as quoted in Wikipedia's Apollo Guidance Computer article",
  r700: 'R-700 vol. III (E. C. Hall, 1972) and MIT drawing 2005011: three NPNs, a collector resistor, a base resistor per input',
  drawn: 'drawn (typical): no drawing of it was read',
};

// ---------------------------------------------------------------- places

const Y0 = -MOD.t / 2;
/** Where the module laid flat and the enlarged die sit, beside the tray. */
export const MX: Vec3 = [TRAY.l / 2 + 420, 0, 0];
export const GX: Vec3 = [MX[0], Y0 + 2, MX[2] + 150];
/** The top board's centre height and its top surface, in the flat module. */
const TOP_B = MOD.t / 2 - 4.2, BOARD_TOP = TOP_B + BOARD_T / 2;
/** The package the package view opens: one of the adder's. */
export const ZOOM = 3;
const zoomAt = (): Vec3 => { const p = packageAt(ZOOM); return [MX[0] + p.u, BOARD_TOP + FP.h / 2, MX[2] + p.v]; };

const at3 = (g: Geo, x: number, y: number, z: number): Geo => { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; m[12] = x; m[13] = y; m[14] = z; return transform(g, m); };
const box = (w: number, h: number, d: number, r = 0.05): Geo => roundedBox(w, h, d, Math.min(r, w / 2.1, h / 2.1, d / 2.1), 1);

// ---------------------------------------------------------------- the flatpack (centred, its bottom at y = −h/2)

/** The leads: five a side along the body's length, flat, leaving the body at its bottom face (drawing 1006321). */
export function leadCentres(): { x: number; z: number; pin: number }[] {
  const out: { x: number; z: number; pin: number }[] = [];
  for (let k = 0; k < LEADS / 2; k++) {
    const x = (2 - k) * FP.pitch; // pin 1 at +x (the stripe's end), pins 1–5 on +z, 6–10 on −z
    out.push({ x, z: FP.w / 2 + FP.leadL / 2, pin: k + 1 });
    out.push({ x: -x, z: -(FP.w / 2 + FP.leadL / 2), pin: k + 6 });
  }
  return out.sort((a, b) => a.pin - b.pin);
}
interface PackGeos { body: Geo; lid: Geo; base: Geo; leads: Geo; stripe: Geo; tile: Geo }
const packs = new Map<Detail, PackGeos>();
function packGeos(d: Detail): PackGeos {
  const hit = packs.get(d);
  if (hit) return hit;
  const lead = box(FP.leadW, FP.leadT, FP.leadL, 0.02), lidH = FP.h * 0.42;
  const g: PackGeos = {
    body: box(FP.l, FP.h, FP.w, 0.12),
    base: at3(box(FP.l, FP.h - lidH, FP.w, 0.1), 0, -lidH / 2, 0),
    lid: at3(box(FP.l, lidH, FP.w, 0.1), 0, FP.h / 2 - lidH / 2, 0),
    leads: merge(leadCentres().map((c) => at3(lead, c.x, -FP.h / 2 + FP.leadT / 2, c.z)), 'leads'),
    stripe: at3(box(FP.stripe, 0.04, FP.w * 0.9, 0.01), FP.l / 2 - FP.stripe / 2 - 0.25, FP.h / 2 + 0.02, 0),
    tile: box(FP.l * 0.9, FP.h, FP.w, 0.05),
  };
  packs.set(d, g);
  return g;
}

// ---------------------------------------------------------------- the module and the tray

interface ModGeos { potting: Geo; board: Geo; bodies: Geo; adder: Geo; leads: Geo; pins: Geo; trayFloor: Geo; trayRails: Geo; trayMods: Geo; lifted: Geo; liftPins: Geo }
const mods = new Map<Detail, ModGeos>();
function modGeos(d: Detail): ModGeos {
  const hit = mods.get(d);
  if (hit) return hit;
  const P = packGeos(d), flat = d === 'flat', y = BOARD_TOP + FP.h / 2;
  const where = (i: number) => { const p = packageAt(i); return [p.u, y, p.v] as const; };
  const skip = (i: number) => i === ZOOM;
  const body = flat ? P.tile : P.body;
  const pin = box(1.0, 1.0, 5, 0.2);
  const pins = merge(Array.from({ length: 36 }, (_, i) => at3(pin, -MOD.l / 2 + 12 + i * ((MOD.l - 24) / 35), 0, -MOD.h / 2 - 2.5)), 'connector pins');
  // the tray's modules stand on edge: thickness along x, height y, length z
  const upright = box(MOD.t, MOD.h, MOD.l, 1.2);
  const g: ModGeos = {
    potting: box(MOD.l, MOD.t, MOD.h, 1.2),
    board: box(MOD.l - 4, BOARD_T, MOD.h - 4, 0.3),
    bodies: merge(Array.from({ length: PER_BOARD }, (_, i) => i).filter((i) => i >= ADDER_PACKAGES && !skip(i)).map((i) => at3(body, ...where(i))), 'flatpacks'),
    adder: merge(Array.from({ length: ADDER_PACKAGES }, (_, i) => i).filter((i) => !skip(i)).map((i) => at3(body, ...where(i))), 'adder flatpacks'),
    leads: flat ? box(0.01, 0.01, 0.01) : merge(Array.from({ length: PER_BOARD }, (_, i) => i).filter((i) => !skip(i)).map((i) => at3(P.leads, ...where(i))), 'welded leads'),
    pins,
    trayFloor: box(TRAY.l, 3, TRAY.d, 1),
    trayRails: merge([-1, 1].flatMap((s) => [at3(box(TRAY.l, TRAY.h, 6, 1), 0, TRAY.h / 2, s * (TRAY.d / 2 - 3)), at3(box(6, TRAY.h, TRAY.d, 1), s * (TRAY.l / 2 - 3), TRAY.h / 2, 0)]), 'tray walls'),
    trayMods: merge(Array.from({ length: SLOTS }, (_, n) => n + 1).filter((n) => n !== LIFTED).map((n) => at3(upright, slotX(n), 3 + MOD.h / 2, 0)), 'modules'),
    lifted: upright,
    liftPins: merge(Array.from({ length: 36 }, (_, i) => at3(box(1, 5, 1, 0.2), 0, -MOD.h / 2 - 2.5, -MOD.l / 2 + 12 + i * ((MOD.l - 24) / 35))), 'connector pins'),
  };
  mods.set(d, g);
  return g;
}

// ---------------------------------------------------------------- the die, enlarged (die mm × MAG, centred on GX)

const S = MAG / 40; // the layout below is in units of the 52 × 40 drawn die
interface Path { pts: [number, number][] }
/** A serpentine resistor between two points along z, `turns` folds wide. */
function serpentine(x: number, z0: number, z1: number, turns: number, w: number): [number, number][] {
  const pts: [number, number][] = [[x, z0]], n = turns * 2, dz = (z1 - z0) / (n + 1);
  for (let i = 1; i <= n; i++) { const z = z0 + i * dz, s = i % 2 ? 1 : -1; pts.push([x + s * w, z - dz / 2], [x + s * w, z]); }
  pts.push([x, z1]);
  return pts;
}
interface DieLayout { npn: [number, number][]; inPads: [number, number][]; outPad: [number, number]; base: Path[]; coll: Path; collRes: Path; emit: Path; out: Path }
/** Gate 1 on the left half; gate 2 is its mirror (x → −x). */
function layout(side: 1 | -1): DieLayout {
  const X = (x: number) => side * x;
  const npn: [number, number][] = [[X(-18), 0], [X(-12), 0], [X(-6), 0]];
  return {
    npn,
    inPads: npn.map(([x]) => [x, 17] as [number, number]),
    outPad: [X(-24), -10],
    base: npn.map(([x]) => ({ pts: serpentine(x, 15.5, 2.4, 3, 1.6) })),
    coll: { pts: [[X(-20.5), -4.4], [X(-3.5), -4.4]] },
    collRes: { pts: serpentine(X(-3.5), -4.4, -14.5, 3, 1.3) },
    emit: { pts: [[X(-21), -0.6], [0, -0.6]] },
    out: { pts: [[X(-20.5), -4.4], [X(-20.5), -10], [X(-24), -10]] },
  };
}
interface DieGeos { die: Geo; pads: Geo; collector: Geo; baseReg: Geo; emitter: Geo; metalFixed: Geo; resistor: (p: Path) => Geo; metal: (p: Path) => Geo; padAt: (p: [number, number]) => Geo; npnAt: (p: [number, number]) => { c: Geo; b: Geo; e: Geo } }
const dies = new Map<Detail, DieGeos>();
const HZ = 1.2; // drawn thickness of the layers above the die's face
function dieGeos(d: Detail): DieGeos {
  const hit = dies.get(d);
  if (hit) return hit;
  const sides = d === 'full' ? 6 : 4;
  const toPts = (p: Path, y: number): Vec3[] => p.pts.map(([x, z]) => [x * S, y, z * S]);
  const g: DieGeos = {
    die: box(DIE.l * MAG, 4, DIE.w * MAG, 0.4),
    pads: box(2.6 * S, 0.4, 2.6 * S, 0.1),
    collector: box(5.2 * S, 0.3, 9.5 * S, 0.1),
    baseReg: box(3.6 * S, 0.5, 4.2 * S, 0.1),
    emitter: box(1.6 * S, 0.7, 1.6 * S, 0.1),
    metalFixed: merge([
      tube(toPts({ pts: [[0, -0.6], [0, 17]] }, 2 + HZ), 0.35 * S, { sides }), // GND to its pad
      tube(toPts({ pts: [[-3.5, -14.5], [-3.5, -17], [3.5, -17], [3.5, -14.5]] }, 2 + HZ), 0.35 * S, { sides }), // VCC across
    ], 'supply metal'),
    resistor: (p) => tube(toPts(p, 2 + 0.3), 0.32 * S, { sides: 4 }),
    metal: (p) => tube(toPts(p, 2 + HZ), 0.35 * S, { sides }),
    padAt: ([x, z]) => at3(box(2.6 * S, 0.4, 2.6 * S, 0.1), x * S, 2.2, z * S),
    npnAt: ([x, z]) => ({ c: at3(box(5.2 * S, 0.3, 9.5 * S, 0.1), x * S, 2.15, (z - 1) * S), b: at3(box(3.6 * S, 0.5, 4.2 * S, 0.1), x * S, 2.3, (z + 0.6) * S), e: at3(box(1.6 * S, 0.7, 1.6 * S, 0.1), x * S, 2.4, (z - 0.6) * S) }),
  };
  dies.set(d, g);
  return g;
}

// ---------------------------------------------------------------- materials

const potMat = M.make({ base: [0.36, 0.37, 0.39], metal: 0.1, rough: 0.6, label: 'cast epoxy (its colour drawn)' });
const boardMat = M.make({ base: [0.74, 0.69, 0.55], metal: 0, rough: 0.55, label: 'multilayer board (layers drawn as one)' });
const fpMat = M.make({ base: [0.07, 0.07, 0.08], metal: 0, rough: 0.35, coat: 0.4, label: 'flatpack body (glass and ceramic, black)' });
const fpLit = M.glow(M.make({ base: [0.2, 0.14, 0.05], metal: 0, rough: 0.35, coat: 0.4, label: 'a flatpack of the four-bit adder' }), [1.0, 0.55, 0.1], 0.32);
const leadMat = M.tint(M.gold, [1.0, 0.8, 0.4], 'gold-plated lead, welded to the board');
const stripeMat = M.make({ base: [0.92, 0.92, 0.88], metal: 0, rough: 0.6, label: 'keying stripe (pin 1 / pin 10 end)' });
const trayMat = M.make({ base: [0.55, 0.56, 0.57], metal: 0.6, rough: 0.45, label: 'logic tray (magnesium; drawn)' });
const dieMat = M.make({ base: [0.38, 0.4, 0.48], metal: 0.4, rough: 0.25, label: 'silicon die (drawn ×' + MAG + ')' });
const nMat = M.make({ base: [0.3, 0.42, 0.62], metal: 0.2, rough: 0.35, label: 'collector (n)' });
const pMat = M.make({ base: [0.7, 0.42, 0.5], metal: 0.2, rough: 0.35, label: 'base (p)' });
const eMat = M.make({ base: [0.25, 0.3, 0.75], metal: 0.2, rough: 0.35, label: 'emitter (n+)' });
const eOn = { ...M.glow(M.make({ base: [0.6, 0.75, 1.0], metal: 0, rough: 0.35 }), [0.45, 0.65, 1.0], 1.6), label: 'emitter: this transistor conducts' };
const alMat = M.tint(M.aluminium, [0.86, 0.87, 0.88], 'aluminium interconnect');
const resMat = M.make({ base: [0.78, 0.55, 0.36], metal: 0.1, rough: 0.5, label: 'diffused resistor' });
const ONE: [number, number, number] = [1.0, 0.68, 0.15];
const hi = (m: Material, what: string): Material => ({ ...M.glow(M.make({ base: ONE, metal: 0, rough: 0.35 }), ONE, 1.1), label: `${m.label}: at 1 (${what})` });

// ---------------------------------------------------------------- the model

export const AGC_HOME: Record<AgcView, OrbitView> = {
  tray: { target: [-20, 30, 0], yaw: 0.5, pitch: 0.5, dist: 760 },
  module: { target: [MX[0] + 6, 0, MX[2]], yaw: 0.32, pitch: 0.78, dist: 215 },
  package: { target: zoomAt(), yaw: 0.45, pitch: 0.7, dist: 24 },
  gate: { target: [GX[0], GX[1] + 2, GX[2]], yaw: 0.0, pitch: 1.05, dist: 82 },
};
/** What each view shows in the flat drawing (it has no camera: it frames whatever it draws). */
export const FLAT_GROUPS: Record<AgcView, string[]> = { tray: ['tray', 'lifted'], module: ['module', 'adder', 'package', 'lid'], package: ['package', 'lid'], gate: ['die'] };
/** The epoxy's cut: everything above the top board's face, on the module laid flat. */
export const POT_CUT = BOARD_TOP + 0.05;

export function agcModel(p: AgcPose, detail: Detail = 'full'): Model3 {
  const P = packGeos(detail), G = modGeos(detail), D = dieGeos(detail), items: Item[] = [];
  // the adder lights on the module only: closer in, a lit package would read as its colour
  const adderOn = p.adder && p.view === 'module';
  // the tray
  items.push({ geo: G.trayFloor, mat: trayMat, at: [0, Y0 + 1.5, 0], name: 'logic tray', group: 'tray', cut: 'none', info: { source: SRC.drawn, note: 'tray A holds the logic modules side by side; its look here is drawn' } });
  items.push({ geo: G.trayRails, mat: trayMat, at: [0, Y0, 0], name: 'logic tray', group: 'tray', cut: 'none' });
  items.push({ geo: G.trayMods, mat: potMat, at: [0, Y0, 0], name: 'logic module', group: 'tray', cut: 'none', info: { dim: '5/8 × 9 5/8 × 1 3/4 in', source: SRC.chm, note: 'each one 120 flatpacks: 240 NOR gates' } });
  items.push({ geo: G.lifted, mat: potMat, at: [slotX(LIFTED), Y0 + 3 + MOD.h / 2 + 70, 0], name: `module A${LIFTED}: four bits of arithmetic`, group: 'lifted', cut: 'none', info: { source: SRC.shirriff, note: 'A8–A11 are four identical modules, four bits each of the adder and the central registers' } });
  items.push({ geo: G.liftPins, mat: leadMat, at: [slotX(LIFTED), Y0 + 3 + MOD.h / 2 + 70, 0], name: `module A${LIFTED}: four bits of arithmetic`, group: 'lifted', cut: 'none' });
  // the module laid flat, the epoxy cut away to the top board
  items.push({ geo: G.potting, mat: potMat, at: MX, name: 'cast epoxy', group: 'module', info: { dim: `${(MOD.l / 25.4).toFixed(3)} × ${(MOD.h / 25.4).toFixed(2)} × ${(MOD.t / 25.4).toFixed(3)} in`, source: `size: ${SRC.chm}; epoxy: ${SRC.hall}`, note: 'the wiring between the boards cast in epoxy; cut away here' } });
  for (const s of [1, -1]) items.push({ geo: G.board, mat: boardMat, at: [MX[0], s * TOP_B, MX[2]], name: s > 0 ? 'top board: 60 flatpacks' : 'bottom board: 60 more', group: 'module', cut: 'none', info: { source: SRC.shirriff, note: '"two boards with 60 chips each, for a total of 240 NOR gates"; its layer count is not drawn' } });
  items.push({ geo: G.bodies, mat: fpMat, at: MX, name: 'flatpack: two NOR gates', group: 'module', cut: 'none', info: { dim: '0.275 × 0.190 × 0.070 in', source: SRC.scd } });
  items.push({ geo: G.adder, mat: adderOn ? fpLit : fpMat, at: MX, name: adderOn ? `the four-bit adder: ${ADDER_PACKAGES} flatpacks` : 'flatpack: two NOR gates', group: 'adder', cut: 'none', info: adderOn ? { source: 'lib/agcnor.ts NOR_ADD4', note: `${ADDER_GATES} NOR gates at two a package; the rest of the board is the register and its gating (drawn as the first ${ADDER_PACKAGES})` } : { dim: '0.275 × 0.190 × 0.070 in', source: SRC.scd } });
  if (detail === 'full') items.push({ geo: G.leads, mat: leadMat, at: MX, name: 'welded leads', group: 'module', cut: 'none' });
  items.push({ geo: G.pins, mat: leadMat, at: MX, name: 'connector', group: 'module', cut: 'none', info: { source: SRC.drawn, note: 'the module plugs into the tray; the number and spacing of its pins are drawn' } });
  // the package the package view opens, in place on the board
  const z0 = zoomAt(), adderLit = adderOn && ZOOM < ADDER_PACKAGES;
  items.push({ geo: P.base, mat: adderLit ? fpLit : fpMat, at: z0, name: 'flatpack: two NOR gates', group: 'package', cut: 'none', info: { dim: '0.275 × 0.190 in, 0.070 in high (at most, glass included)', source: SRC.scd, note: 'hermetic: the die sits in a sealed cavity' } });
  items.push({ geo: P.lid, mat: adderLit ? fpLit : fpMat, at: z0, name: 'flatpack lid', group: 'lid', cut: 'none', explode: p.view === 'package' ? [0, 4.5, 0] : undefined, info: { source: SRC.scd, note: 'lifted here to show the die (it is sealed shut)' } });
  items.push({ geo: P.stripe, mat: stripeMat, at: z0, name: 'keying stripe', group: 'lid', cut: 'none', explode: p.view === 'package' ? [0, 4.5, 0] : undefined, info: { dim: '0.020–0.060 in wide', source: SRC.scd, note: 'marks the pin 1 / pin 10 end' } });
  items.push({ geo: P.leads, mat: leadMat, at: z0, name: 'leads', group: 'package', cut: 'none', info: { dim: '10 leads, 0.050 in pitch, 0.010–0.019 in wide', source: SRC.scd, note: 'gold-plated; pin 5 GND, pin 10 VCC, 1 and 9 the two outputs, 2–4 and 6–8 the inputs' } });
  // the die on the base's floor (the cavity), the lid over it
  const baseTop = z0[1] + FP.h / 2 - FP.h * 0.42, dieTiny: Vec3 = [z0[0], baseTop + 0.1, z0[2]];
  items.push({ geo: box(DIE.l, 0.2, DIE.w, 0.02), mat: dieMat, at: dieTiny, name: 'die: two NOR gates', group: 'package', cut: 'none', info: { dim: `about ${DIE.l} × ${DIE.w} mm (drawn)`, source: SRC.shirriff, note: 'six transistors and eight resistors; ten bond wires to the leads' } });
  if (detail === 'full') {
    const wires = leadCentres().map((c) => tube([[dieTiny[0] + Math.sign(c.x) * Math.min(Math.abs(c.x), DIE.l / 2 - 0.1), dieTiny[1] + 0.1, dieTiny[2] + Math.sign(c.z) * (DIE.w / 2 - 0.1)], [dieTiny[0] + c.x * 0.8, dieTiny[1] + 0.35, dieTiny[2] + Math.sign(c.z) * (FP.w / 2 - 1.0)], [dieTiny[0] + c.x, baseTop + 0.03, dieTiny[2] + Math.sign(c.z) * (FP.w / 2 - 0.35)]], 0.025, { sides: 4, bend: 0.2 }));
    items.push({ geo: merge(wires, 'bond wires'), mat: M.gold, name: 'bond wires', group: 'package', cut: 'none', info: { source: SRC.shirriff, note: 'ten, one per lead; drawn 50 µm across, twice the real 25 µm wire' } });
  }
  // the die, enlarged
  const ins = p.ins, y = norOut(...ins), on = conducting(ins);
  items.push({ geo: D.die, mat: dieMat, at: GX, name: 'die (enlarged)', group: 'die', cut: 'none', info: { dim: `drawn ${MAG}× life`, source: SRC.shirriff, note: 'the chip of one flatpack: two three-input NOR gates' } });
  items.push({ geo: D.metalFixed, mat: alMat, at: GX, name: 'supply lines: GND, VCC', group: 'die', cut: 'none' });
  for (const side of [1, -1] as const) {
    const L = layout(side), g1 = side === 1, gIns = g1 ? ins : [0, 0, 0], gy = g1 ? y : 1, gOn = g1 ? on : [false, false, false];
    const gate = g1 ? 'gate 1' : 'gate 2 (inputs held at 0)';
    L.npn.forEach((pt, i) => {
      const t = D.npnAt(pt), nm = `${gate}: transistor ${'abc'[i]}`, inf = { source: SRC.r700, note: gOn[i] ? 'its input is 1: base current flows, it conducts and pulls the output to ground' : 'its input is 0: no base current, it is off' };
      items.push({ geo: t.c, mat: nMat, at: GX, name: nm, group: 'die', cut: 'none', info: inf });
      items.push({ geo: t.b, mat: pMat, at: GX, name: nm, group: 'die', cut: 'none' });
      items.push({ geo: t.e, mat: gOn[i] ? eOn : eMat, at: GX, name: nm, group: 'die', cut: 'none' });
      items.push({ geo: D.padAt(L.inPads[i]), mat: gIns[i] ? hi(alMat, 'input') : alMat, at: GX, name: `${gate}: input ${g1 ? 'abc'[i] : i + 1}`, group: 'die', cut: 'none' });
      items.push({ geo: D.resistor(L.base[i]), mat: gIns[i] ? hi(resMat, 'its input') : resMat, at: GX, name: `${gate}: base resistor`, group: 'die', cut: 'none', info: { source: SRC.r700, note: 'limits the current into the base; it changes no logic value' } });
    });
    items.push({ geo: D.metal(L.coll), mat: gy ? hi(alMat, 'the output') : alMat, at: GX, name: `${gate}: collectors joined`, group: 'die', cut: 'none' });
    items.push({ geo: D.metal(L.out), mat: gy ? hi(alMat, 'the output') : alMat, at: GX, name: `${gate}: output`, group: 'die', cut: 'none' });
    items.push({ geo: D.padAt(L.outPad), mat: gy ? hi(alMat, 'the output') : alMat, at: GX, name: `${gate}: output pad`, group: 'die', cut: 'none' });
    items.push({ geo: D.resistor(L.collRes), mat: resMat, at: GX, name: `${gate}: collector resistor`, group: 'die', cut: 'none', info: { source: SRC.r700, note: gy ? 'no transistor conducts: it pulls the output up to 1' : 'a transistor conducts: current flows through it and the output sits near ground' } });
    items.push({ geo: D.metal(L.emit), mat: alMat, at: GX, name: 'GND: the emitters', group: 'die', cut: 'none' });
  }
  items.push({ geo: D.padAt([0, 17]), mat: alMat, at: GX, name: 'GND pad (pin 5)', group: 'die', cut: 'none' });
  items.push({ geo: D.padAt([0, -17]), mat: alMat, at: GX, name: 'VCC pad (pin 10)', group: 'die', cut: 'none' });
  // the flat (SVG) drawing fits everything it is given: give it the current view's subject only
  const keep = detail === 'flat' ? new Set(FLAT_GROUPS[p.view]) : null;
  return {
    items: keep ? items.filter((i) => keep.has(i.group ?? '')) : items, anchors: anchors(p), beats: beats(), floor: Y0,
    cuts: { planes: [{ n: [0, 1, 0], d: POT_CUT }], open: [MOD.t / 2 + 1] },
    flatOrder: 'items',
  };
}

const up: Vec3 = [0, 1, 0];
function anchors(p: AgcPose): StudioAnchor[] {
  const z = zoomAt();
  switch (p.view) {
    case 'tray': return [
      { text: `A${LIFTED}: four bits of arithmetic`, p: [slotX(LIFTED), Y0 + 3 + MOD.h + 70, 0], side: 't', n: up },
      { text: 'logic tray', p: [-TRAY.l / 2, Y0 + TRAY.h, TRAY.d / 2], side: 'l', n: up, gutter: 'l' },
      { text: `${SLOTS} modules`, p: [slotX(SLOTS), Y0 + 3 + MOD.h, -TRAY.d / 4], side: 'r', n: up, gutter: 'r', minor: true },
    ];
    case 'module': return [
      { text: `${PER_BOARD} flatpacks a board`, p: [MX[0] - MOD.l / 2 + 20, BOARD_TOP, MX[2] - MOD.h / 2 + 2], side: 'l', n: up, gutter: 'l' },
      { text: 'cast epoxy', p: [MX[0] + MOD.l / 2, MOD.t / 2, MX[2]], side: 'r', n: up, gutter: 'r', minor: true },
      { text: 'connector', p: [MX[0], 0, MX[2] - MOD.h / 2 - 5], side: 'b', n: up, minor: true },
      ...(p.adder ? [{ text: `adder: ${ADDER_PACKAGES} flatpacks`, p: [MX[0] + packageAt(ADDER_PACKAGES - 1).u, BOARD_TOP + FP.h, MX[2] + packageAt(ADDER_PACKAGES - 1).v] as Vec3, side: 't' as const, n: up, gutter: 'r' as const }] : []),
    ];
    case 'package': return [
      { text: 'pin 1 (O1)', p: [z[0] + 2 * FP.pitch, z[1] - FP.h / 2, z[2] + FP.w / 2 + FP.leadL], side: 'r', n: up, gutter: 'r' },
      { text: 'pin 5 (GND)', p: [z[0] - 2 * FP.pitch, z[1] - FP.h / 2, z[2] + FP.w / 2 + FP.leadL], side: 'l', n: up, gutter: 'l' },
      { text: 'pin 10 (VCC)', p: [z[0] + 2 * FP.pitch, z[1] - FP.h / 2, z[2] - FP.w / 2 - FP.leadL], side: 'r', n: up, gutter: 'r' },
      { text: 'die: two NOR gates', p: [z[0], z[1] + FP.h / 2 - FP.h * 0.42 + 0.2, z[2]], side: 'l', n: up, gutter: 'l' },
      { text: 'keying stripe', p: [z[0] + FP.l / 2 - 0.5, z[1] + FP.h / 2, z[2]], side: 't', n: up, minor: true },
    ];
    case 'gate': {
      const s = MAG / 40, at = (x: number, zz: number): Vec3 => [GX[0] + x * s, GX[1] + 3, GX[2] + zz * s];
      return [
        { text: 'a', p: at(-18, 17), side: 't', n: up }, { text: 'b', p: at(-12, 17), side: 't', n: up }, { text: 'c', p: at(-6, 17), side: 't', n: up },
        { text: 'three transistors', p: at(-21, 0), side: 'l', n: up, gutter: 'l' },
        { text: 'base resistors', p: at(-19.6, 9), side: 'l', n: up, gutter: 'l', minor: true },
        { text: 'collector resistor', p: at(-3.5, -9.5), side: 'r', n: up, gutter: 'r' },
        { text: `y = ${norOut(...p.ins)}`, p: at(-24, -10), side: 'l', n: up, gutter: 'l' },
        { text: 'gate 2', p: at(12, 0), side: 'r', n: up, gutter: 'r', minor: true },
      ];
    }
  }
}

function beats(): Beat[] {
  return [
    { title: 'The logic tray', text: `The AGC's logic is ${SLOTS} modules standing side by side in one tray. Module A${LIFTED}, lifted out, is four bits of the adder and the central registers; A8–A11 are four of the same.`, view: AGC_HOME.tray, cut: 0, explode: 0, show: ['tray', 'lifted'] },
    { title: 'Two boards of sixty', text: `Cut the epoxy away and a module is ${PER_BOARD} identical flatpacks welded to a board, and ${PER_BOARD} more on a second board under it: ${PACKAGES} packages, ${MODULE_GATES} NOR gates.`, view: AGC_HOME.module, cut: 1, explode: 0, show: ['module', 'adder', 'package', 'lid'] },
    { title: 'Where the adder is', text: `Step 2's four-bit adder is ${ADDER_GATES} NOR gates: ${ADDER_PACKAGES} of these packages, two gates each. Every block of the computer is counted the same way.`, view: AGC_HOME.module, cut: 1, explode: 0, show: ['adder', 'module'] },
    { title: 'One flatpack', text: 'A quarter of an inch long, ten gold leads at a twentieth of an inch, a stripe at the pin 1 end. Its lid lifted: the die, and ten bond wires.', view: AGC_HOME.package, cut: 1, explode: 1, show: ['package', 'lid'] },
    { title: 'One gate', text: 'The die, forty times life: each gate three transistors, their collectors joined under one collector resistor, a base resistor on each input. Any input at 1 turns its transistor on and pulls the output to ground: a NOR.', view: AGC_HOME.gate, cut: 0, explode: 0, show: ['die'] },
  ];
}

