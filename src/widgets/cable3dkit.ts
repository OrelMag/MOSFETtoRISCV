// The twisted pair and the coax on the studio renderer (DOM-free, tested). The pair is two insulated copper wires swept
// along the same helix as before (cable3dparts.ts helix: the crossings fall on phys/cable.ts's loop edges, even or uneven),
// a sender and a receiver closing it at the ends; between the legs each loop's lens, and through the loops a field that
// changes in time. The field B(t) = sin ωt is drawn as arrows growing and turning over; each loop's voltage, its sign times
// its share of the run times dB/dt (cos ωt), colours its lens; the charge each loop pushes (the integral: sin ωt) moves as
// beads along its legs, the opposite way in the next loop; the receiver glows with the sum, which is nothing for an odd
// number of equal half twists. Layers: the field, an electric field from the side, a neighbour pair, and the same pair in
// true proportion beside a millimetre ruler. The coax is lathed layers to scale from the Belden sheets (centre conductor,
// dielectric, a two-way braid, jacket), stripped back in steps; cut open lengthwise, its field shows between core and braid.
//
// Sourced: the coax D, d and jacket (phys/cable.ts COAX_PRESETS, Belden 8240 / 8241 / 1694A); the lays (EP1058275 claim 5,
// LAY_A_MM / LAY_B_MM); a Cat5e pair's 24 AWG conductor (0.511 mm, the AWG definition) and 0.92 mm insulated wire (Technetix
// Cat5e datasheet 10088018: "insulation 0.92 ± 0.02 mm"). Drawn: the pair's helix far wider and tighter than life (the true
// proportion is its own layer), the braid's carriers and angle (the sheets give coverage, not the weave), the strip-back.

import { extrude, lathe, merge, roundedBox, sphere, torus, transform, tube, type Geo } from '../gl/kit/geo';
import { M, type Material } from '../gl/kit/materials';
import type { Beat, Item, Model3, StudioAnchor } from '../gl/kit/scene';
import type { Instance, RGB } from '../gl/instances';
import { quatAxisAngle, type Quat, type Vec3 } from '../gl/math';
import { DIELECTRICS, LAY_A_MM, LAY_B_MM, loopEdges, loopFractions, neighbourHalfTwists, type CoaxPreset } from '../phys/cable';
import { A, LEN, NEIGHBOUR_Z, helix, presetOf, type CableState } from './cable3dparts';

// ---------------------------------------------------------------- sourced figures

/** A Cat5e pair's wire: 24 AWG solid copper (0.511 mm, the AWG definition) insulated to 0.92 mm across (Technetix 10088018). */
export const CAT5E = { conductor: 0.511, insulated: 0.92 } as const;
export const SRC = {
  awg: '24 AWG solid copper, 0.511 mm across (the AWG definition, ASTM B258)',
  cat5e: 'a Cat5e pair: insulation 0.92 ± 0.02 mm across (Technetix Cat5e datasheet 10088018)',
  lay: 'lay 0.440 in = 11.2 mm a turn: EP1058275 (Lucent), claim 5; no standard sets lays',
  layB: 'lay 0.596 in = 15.1 mm a turn: EP1058275 (Lucent), claim 5',
  drawn: 'drawn, not to scale (see the note)',
  model: 'phys/cable.ts: each loop picks up its area × dB/dt, the sign flipping every half twist',
};
const sheet = (p: CoaxPreset) => `Belden ${p.sheet.replace('Belden ', '')} datasheet (${p.name} type)`;

/** The pair's drawn width (2A across the loop) stands for the real spacing of two touching insulated wires: units per mm. */
export const UPM = (2 * A) / CAT5E.insulated;
/** How much tighter the drawn twist is than a real 11.2 mm lay, at the same width: a full turn is two loops. */
export const tighterThanLife = (halfTwists: number): number => (LAY_A_MM * UPM) / ((2 * LEN) / (Math.round(halfTwists) + 1));

/** The coax: units per mm, its run, and where the strip-back steps fall (illustrative: no source sets them). */
export const CMM = 3;
export const CX = { x0: -20, x1: 20, jacket: -6, braid: 2, diel: 10 } as const;
/** The braid's carriers each way, wires a carrier, a wire's radius (mm) and the angle to the axis: drawn, the sheets give coverage only. */
export const BRAID = { carriers: 8, wires: 3, wireMm: 0.12, angle: Math.PI / 4 } as const;
export function coaxRadii(p: CoaxPreset): { core: number; diel: number; braidIn: number; braidOut: number; jacketIn: number; jacket: number } {
  const w = BRAID.wireMm * CMM, diel = (p.D * CMM) / 2;
  return { core: (p.d * CMM) / 2, diel, braidIn: diel + w, braidOut: diel + 3 * w, jacketIn: diel + 4 * w + 0.02, jacket: (p.jacket * CMM) / 2 };
}

// ---------------------------------------------------------------- the field in time

/** One period of the drawn field, ms. */
export const PERIOD_MS = 2600;
/** The phase a still picture is drawn at (reduced motion, the flat view): B and dB/dt both well away from zero. */
export const STILL = Math.PI / 4;

/** Each loop now: its voltage (relative to an equal loop's peak: sign × share × L × cos), the charge it has pushed (the same
 *  with sin), and their sums: what the receiver sees. Even n of equal loops leaves one loop; odd n leaves nothing. */
export function loopsNow(st: Pick<CableState, 'twists' | 'uneven'>, phase: number): { emf: number[]; push: number[]; net: number; netPush: number } {
  const f = loopFractions(Math.round(st.twists), st.uneven), L = f.length;
  const emf = f.map((x, k) => (k % 2 ? -1 : 1) * x * L * Math.cos(phase)), push = f.map((x, k) => (k % 2 ? -1 : 1) * x * L * Math.sin(phase));
  return { emf, push, net: emf.reduce((a, b) => a + b, 0), netPush: push.reduce((a, b) => a + b, 0) };
}

// ---------------------------------------------------------------- the look

export type CableLayer = 'field' | 'electric' | 'true' | 'fields';
export interface CableRgb { pos: RGB; neg: RGB; field: RGB; push: RGB; load: RGB; hot: RGB }
export interface CableLook {
  detail: 'full' | 'flat';
  st: CableState;
  layers: ReadonlySet<CableLayer>;
  /** The flat view's still: the lenses and arrows are drawn in it as parts, at this phase. */
  phase?: number;
  rgb: CableRgb;
}

const cache = new Map<string, Geo>();
const once = (key: string, make: () => Geo): Geo => { let g = cache.get(key); if (!g) { g = make(); cache.set(key, g); if (cache.size > 400) cache.delete(cache.keys().next().value!); } return g; };
const Y_TO_X: Quat = quatAxisAngle([0, 0, 1], -Math.PI / 2);
const DOWN: Quat = quatAxisAngle([1, 0, 0], Math.PI);
/** A rotation matrix (column-major) from a unit quaternion, for baking a lathe on y onto the x axis. */
function matOf(q: Quat): Float32Array {
  const [x, y, z, w] = q;
  return new Float32Array([1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0, 2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0, 2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0, 0, 0, 0, 1]);
}
const onX = (g: Geo): Geo => transform(g, matOf(Y_TO_X));

/** Shapes the view instances: a lens one unit long (x 0..1) as wide as a loop, an arrow's shaft (one unit, centred) and head. */
export const LENS = extrude(Array.from({ length: 33 }, (_, i): [number, number] => { const t = i / 32; return [t, A * Math.sin(Math.PI * t)]; }).concat(Array.from({ length: 31 }, (_, i): [number, number] => { const t = 1 - (i + 1) / 32; return [t, -A * Math.sin(Math.PI * t)]; })), 0.16);
export const SHAFT = tube([[0, -0.5, 0], [0, 0.5, 0]], 0.3, { sides: 10 });
export const HEAD = lathe([[0, 0], [0.85, 0], [0, 2]], { seg: 16, crease: 80 });
/** A bead is a little wider than the insulation, so it shows riding along the wire. */
export const BEAD = sphere(1.15, 12, 8);
export const LOAD = roundedBox(1.5, 1.7, 1.5, 0.35, 2);

const leg = (n: number, w: 1 | -1, uneven: number, dz: number, per: number): Vec3[] => {
  const e = loopEdges(n, uneven), pts: Vec3[] = [];
  for (let k = 0; k < e.length - 1; k++) for (let j = 0; j <= per; j++) { if (k > 0 && j === 0) continue; pts.push(helix(n, w, e[k] + ((e[k + 1] - e[k]) * j) / per, uneven, dz)); }
  return pts;
};
/** Where a leg's end stands (x = ±LEN/2): the bridge at that end joins the two. */
const endOf = (n: number, w: 1 | -1, uneven: number, u: 0 | 1): Vec3 => helix(n, w, u, uneven);
/** The bridge at an end: out from leg A, across through the part, back into leg B (a closed loop with the pair). */
export function bridge(n: number, uneven: number, u: 0 | 1): Vec3[] {
  const a = endOf(n, 1, uneven, u), b = endOf(n, -1, uneven, u), s = u ? 1 : -1, x = a[0] + s * 3.2;
  return [a, [x, a[1], 0], [x, b[1], 0], b];
}
/** The point a fraction f along a polyline. */
function along(path: readonly Vec3[], f: number): Vec3 {
  const seg = path.slice(1).map((p, k) => Math.hypot(p[0] - path[k][0], p[1] - path[k][1], p[2] - path[k][2])), total = seg.reduce((a, b) => a + b, 0);
  let d = Math.max(0, Math.min(1, f)) * total;
  for (let k = 0; k < seg.length; k++) { if (d <= seg[k] || k === seg.length - 1) { const t = seg[k] ? Math.min(1, d / seg[k]) : 0, p = path[k], q = path[k + 1]; return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t]; } d -= seg[k]; }
  return path[path.length - 1];
}

// ---------------------------------------------------------------- what the view instances each frame

/** The lenses, each tinted by its loop's voltage now (red one way, blue the other, clear at zero). */
export function lenses(st: CableState, phase: number, rgb: CableRgb): Instance[] {
  const n = Math.round(st.twists), e = loopEdges(n, st.uneven), { emf } = loopsNow(st, phase);
  return emf.map((v, k) => ({ pos: [(e[k] - 0.5) * LEN, -0.08, 0], scale: [(e[k + 1] - e[k]) * LEN, 1, 1], color: [...(v >= 0 ? rgb.pos : rgb.neg), 0.25 + 0.55 * Math.min(1, Math.abs(v))] as [number, number, number, number] }));
}
/** The field's arrows through the loops' middles: as long as B now, pointing its way. */
export function fieldArrows(st: CableState, phase: number, rgb: CableRgb): { shafts: Instance[]; heads: Instance[] } {
  const n = Math.round(st.twists), e = loopEdges(n, st.uneven), b = Math.sin(phase), len = Math.max(0.05, 15 * Math.abs(b)), up = b >= 0;
  const shafts: Instance[] = [], heads: Instance[] = [];
  for (let k = 0; k < e.length - 1; k++) {
    const x = ((e[k] + e[k + 1]) / 2 - 0.5) * LEN;
    shafts.push({ pos: [x, 0, 0], scale: [1, len, 1], color: rgb.field });
    if (Math.abs(b) > 0.05) heads.push({ pos: [x, (up ? 1 : -1) * len / 2, 0], rot: up ? undefined : DOWN, color: rgb.field });
  }
  return { shafts, heads };
}
/** The charge each loop has pushed: beads along its legs, leg A one way and leg B back (round the loop), the next loop the
 *  other way; and through the receiver, the sum. */
export const BEADS_PER_LOOP = 3;
export function pushBeads(st: CableState, phase: number, rgb: CableRgb): Instance[] {
  const n = Math.round(st.twists), e = loopEdges(n, st.uneven), { push, netPush } = loopsNow(st, phase), out: Instance[] = [];
  for (let k = 0; k < e.length - 1; k++) for (const w of [1, -1] as const) for (let j = 0; j < BEADS_PER_LOOP; j++) {
    const f = Math.max(0.03, Math.min(0.97, (j + 0.5) / BEADS_PER_LOOP + w * 0.12 * push[k]));
    out.push({ pos: helix(n, w, e[k] + (e[k + 1] - e[k]) * f, st.uneven), color: rgb.push, emissive: rgb.push });
  }
  const path = bridge(n, st.uneven, 1);
  for (let j = 0; j < 3; j++) out.push({ pos: along(path, (j + 1) / 4 + 0.2 * Math.max(-1, Math.min(1, netPush))), color: rgb.push, emissive: rgb.push });
  return out;
}
/** The receiver's resistor, glowing with what reaches it (relative to one loop's worth). */
export function receiver(st: CableState, phase: number, rgb: CableRgb): Instance[] {
  const n = Math.round(st.twists), p = bridge(n, st.uneven, 1), g = Math.min(1, Math.abs(loopsNow(st, phase).net));
  const mix = (a: RGB, b: RGB): RGB => [a[0] + (b[0] - a[0]) * g, a[1] + (b[1] - a[1]) * g, a[2] + (b[2] - a[2]) * g];
  return [{ pos: [p[1][0], (p[1][1] + p[2][1]) / 2, 0], color: mix(rgb.load, rgb.hot), emissive: rgb.hot.map((c) => c * g * 0.6) as RGB }];
}

// ---------------------------------------------------------------- the model

export function cableModel(look: CableLook): Model3 {
  return look.st.coax ? coaxModel(look) : pairModel(look);
}

const ghost = M.make({ base: [0, 0, 0], metal: 0, rough: 1, label: 'frame' });
const frameBox = (items: Item[], g: string, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) =>
  items.push({ geo: once(`f${g}|${x0}|${x1}|${y0}|${y1}|${z0}|${z1}`, () => transform(roundedBox(x1 - x0, y1 - y0, z1 - z0, 0, 1), new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, 1]))), mat: ghost, group: g, cut: 'none', shadow: false });

export const PAIR_FRAMES = ['homebox', 'loopbox', 'sidebox', 'truebox', 'nbox', 'endbox'] as const;
/** The pair's cut: across it, through the middle of the third loop (or the last), where the legs stand farthest apart. */
export const PAIR_OPEN = LEN / 2 + 8;
export function pairCutX(st: Pick<CableState, 'twists' | 'uneven'>): number {
  const e = loopEdges(Math.round(st.twists), st.uneven), k = Math.min(2, e.length - 2);
  return ((e[k] + e[k + 1]) / 2 - 0.5) * LEN;
}
/** Where the cut stands at knob c (0: off the end, nothing cut): the view drops the moving parts beyond it. */
export const pairCutAt = (st: Pick<CableState, 'twists' | 'uneven'>, c: number): number => PAIR_OPEN + (pairCutX(st) - PAIR_OPEN) * c;
export const COAX_FRAMES = ['homebox', 'endbox', 'cutbox'] as const;
export const FRAME_GROUPS = [...new Set([...PAIR_FRAMES, ...COAX_FRAMES])];
/** The true-proportion pair sits beside the drawn one, this far behind it. */
export const TRUE_Z = -20;

function pairModel(look: CableLook): Model3 {
  const { st, layers } = look, full = look.detail === 'full', n = Math.round(st.twists), per = full ? 28 : 10, sides = full ? 12 : 6, items: Item[] = [];
  const ins = (tok: `--${string}`, label: string) => M.make({ base: tok, metal: 0, rough: 0.55, label });
  const copper = M.make({ ...M.copper, label: 'copper' });
  const wireInfo = { dim: `${CAT5E.insulated} mm across in a Cat5e pair (drawn far thicker)`, source: SRC.cat5e, note: 'its copper is 24 AWG, 0.511 mm across' };
  for (const w of [1, -1] as const) {
    const pts = leg(n, w, st.uneven, 0, per), key = `${n}|${st.uneven}|${w}|${per}`;
    items.push({ geo: once(`ins${key}`, () => tube(pts, 0.8, { sides })), mat: ins(w === 1 ? '--m3-wire-a' : '--m3-wire-b', 'insulation (PE)'), name: w === 1 ? 'wire A (insulated copper)' : 'wire B (insulated copper)', group: 'pair', info: wireInfo });
    items.push({ geo: once(`cu${key}`, () => tube(pts, 0.32, { sides })), mat: copper, name: 'copper conductor', group: 'pair', info: { dim: `${CAT5E.conductor} mm in a Cat5e pair (drawn far thicker)`, source: SRC.awg } });
  }
  // the bridges: bare copper out of each leg, through the sender and the receiver
  for (const u of [0, 1] as const) {
    const p = bridge(n, st.uneven, u);
    items.push({ geo: once(`br${n}|${st.uneven}|${u}`, () => tube(p, 0.32, { sides, bend: 0.5 })), mat: copper, name: u ? 'the receiver' : 'the sender', group: u ? 'receiver' : 'sender' });
    if (!u) items.push({ geo: once('sendbox', () => roundedBox(1.6, 1.8, 1.6, 0.3, 2)), mat: M.make({ base: '--m3-jacket', metal: 0.2, rough: 0.5, label: 'the sender' }), at: [p[1][0], 0, 0], name: 'the sender', group: 'sender', info: { note: 'drives the signal between the legs: differential' } });
  }
  // the flat view has no instances: the lenses and the field drawn as parts at a still
  if (!full) {
    const ph = look.phase ?? STILL, mats = new Map<string, Material>();
    const lensMat = (c: RGB) => { const k = c.join(); if (!mats.has(k)) mats.set(k, M.make({ base: c, metal: 0, rough: 0.6, transmit: 0.5, label: 'a loop, coloured by its voltage' })); return mats.get(k)!; };
    for (const q of receiver(st, ph, look.rgb)) items.push({ geo: LOAD, mat: M.make({ base: q.color as RGB, metal: 0, rough: 0.5, label: 'the receiver' }), at: q.pos, name: 'the receiver', group: 'receiver' });
    for (const L of lenses(st, ph, look.rgb)) items.push({ geo: LENS, mat: lensMat(L.color.slice(0, 3) as RGB), at: L.pos, scale: L.scale, name: 'a loop', group: 'loops', cut: 'none', shadow: false });
    if (layers.has('field')) {
      const fm = M.make({ base: look.rgb.field, metal: 0, rough: 0.5, label: 'the field B' }), fa = fieldArrows(st, ph, look.rgb);
      for (const s of fa.shafts) items.push({ geo: SHAFT, mat: fm, at: s.pos, scale: s.scale, name: 'magnetic field B', group: 'field', cut: 'none', shadow: false });
      for (const s of fa.heads) items.push({ geo: HEAD, mat: fm, at: s.pos, rot: s.rot, name: 'magnetic field B', group: 'field', cut: 'none', shadow: false });
    }
  }
  // an electric field from the side: at each crossing the legs stand level, so it reaches both alike
  if (layers.has('electric')) {
    const em = M.make({ base: '--m3-efield', metal: 0, rough: 0.5, emit: '--m3-efield', glow: 0.15, label: 'an electric field from the side' }), e = loopEdges(n, st.uneven);
    for (let k = 1; k < e.length - 1; k++) {
      const x = (e[k] - 0.5) * LEN;
      items.push({ geo: once('eshaft', () => tube([[0, 0, 11], [0, 0, 4.4]], 0.2, { sides: 10 })), mat: em, at: [x, 0, 0], name: 'electric field (noise from the side)', group: 'electric', cut: 'none', shadow: false, info: { note: 'both legs stand level here, so it reaches them alike: common mode' } });
      items.push({ geo: HEAD, mat: em, at: [x, 0, 4.4], rot: quatAxisAngle([1, 0, 0], -Math.PI / 2), name: 'electric field (noise from the side)', group: 'electric', cut: 'none', shadow: false });
    }
  }
  if (st.neighbour !== 'off') {
    const n2 = st.neighbour === 'same' ? n : neighbourHalfTwists(n), lay = st.neighbour === 'same' ? LAY_A_MM : LAY_B_MM;
    for (const w of [1, -1] as const) {
      const pts = leg(n2, w, 0, NEIGHBOUR_Z, full ? 20 : 8);
      items.push({ geo: once(`nb${n2}|${w}|${full}`, () => tube(pts, 0.6, { sides })), mat: ins(w === 1 ? '--cb-nbr-a' : '--cb-nbr-b', 'insulation (PE)'), name: 'the neighbour pair', group: 'neighbour', info: { dim: `lay ${lay.toFixed(1)} mm a turn`, source: st.neighbour === 'same' ? SRC.lay : SRC.layB } });
    }
  }
  // the same pair in true proportion: two touching 0.92 mm wires, a turn every 11.2 mm, at the drawn pair's width
  if (layers.has('true')) {
    const r = (CAT5E.insulated / 2) * UPM, rc = (CAT5E.conductor / 2) * UPM, lay = LAY_A_MM * UPM;
    for (const w of [1, -1] as const) {
      const pts: Vec3[] = Array.from({ length: (full ? 96 : 24) + 1 }, (_, i) => { const x = -LEN / 2 + (LEN * i) / (full ? 96 : 24), a = (2 * Math.PI * (x + LEN / 2)) / lay + (w === 1 ? 0 : Math.PI); return [x, r * Math.cos(a), TRUE_Z + r * Math.sin(a)]; });
      items.push({ geo: once(`tr${w}|${full}`, () => tube(pts, r * 0.985, { sides: full ? 20 : 8 })), mat: ins(w === 1 ? '--m3-wire-a' : '--m3-wire-b', 'insulation'), name: 'the same pair, true proportion', group: 'true', info: { dim: `${CAT5E.insulated} mm wires touching, a turn every ${LAY_A_MM.toFixed(1)} mm`, source: `${SRC.cat5e}; ${SRC.lay}` } });
      items.push({ geo: once(`trc${w}|${full}`, () => tube(pts, rc, { sides: full ? 14 : 6 })), mat: copper, name: 'copper conductor', group: 'true', info: { dim: `${CAT5E.conductor} mm`, source: SRC.awg } });
    }
    // a ruler in millimetres at this scale, under the true pair
    const steel = M.make({ base: '--cb-ruler', metal: 0.4, rough: 0.4, label: 'a millimetre ruler' }), y = -r - 2.2, mm = 8;
    items.push({ geo: once('ruler', () => roundedBox(mm * UPM, 0.5, 2.2, 0.1, 1)), mat: steel, at: [-LEN / 2 + (mm * UPM) / 2, y, TRUE_Z + r + 1.4], name: `a ruler, ${mm} mm`, group: 'true', info: { dim: `${mm} mm at the scale of the true pair (${UPM.toFixed(1)} units a mm)` } });
    for (let k = 0; k <= mm; k++) items.push({ geo: once(`tick${k % 5 === 0}`, () => roundedBox(0.18, 0.3, k % 5 === 0 ? 1.6 : 0.9, 0.04, 1)), mat: M.make({ base: '--cb-tick', metal: 0, rough: 0.6, label: 'mm' }), at: [-LEN / 2 + k * UPM, y + 0.38, TRUE_Z + r + 1.4 - (k % 5 === 0 ? 0.3 : 0.65)], name: `a ruler, ${mm} mm`, group: 'true' });
  }
  // the frames the views fit to (the stage hides them)
  const r = (CAT5E.insulated / 2) * UPM;
  frameBox(items, 'homebox', -LEN / 2 - 4.2, LEN / 2 + 4.2, -8, 8, -A - 1, A + 1);
  frameBox(items, 'loopbox', -LEN / 2 - 1, -LEN / 2 + (2 * LEN) / (n + 1) + 1, -8, 8, -A - 1, A + 1);
  frameBox(items, 'sidebox', -LEN / 2 - 4, LEN / 2 + 4, -3, 3, -A - 1, 12);
  frameBox(items, 'truebox', -LEN / 2 - 4, LEN / 2 + 4, -r - 3, 8, TRUE_Z - r - 1, A + 1);
  const cx = pairCutX(st);
  frameBox(items, 'endbox', cx - 6, cx, -3, 3, -A - 1.5, A + 1.5);
  frameBox(items, 'nbox', -LEN / 2 - 4, LEN / 2 + 4, -8, 8, NEIGHBOUR_Z - A - 1, A + 1);
  return { items, cuts: { planes: [{ n: [1, 0, 0], d: pairCutX(st) }], open: [PAIR_OPEN] }, anchors: pairAnchors(look), beats: pairBeats(look), floor: -10, flatOrder: 'items' };
}

function pairAnchors(look: CableLook): StudioAnchor[] {
  const { st, layers } = look, n = Math.round(st.twists), e = loopEdges(n, st.uneven), up: Vec3 = [0, 1, 0], front: Vec3 = [0, 0.3, 1];
  const mid = (k: number) => ((e[k] + e[k + 1]) / 2 - 0.5) * LEN, a: StudioAnchor[] = [
    { text: 'wire A', p: helix(n, 1, (e[0] + e[1]) / 4, st.uneven), side: 'l', n: up, on: 'pair' },
    { text: 'wire B', p: helix(n, -1, (e[e.length - 3] + e[e.length - 2]) / 2, st.uneven), side: 'r', n: front, on: 'pair' },
    { text: 'a loop', p: [mid(0), 0, A * 0.4], side: 'l', n: up },
    { text: 'sender', p: [-LEN / 2 - 3.2, 0, 0], side: 'l', n: up, on: 'sender' },
    { text: 'receiver', p: [LEN / 2 + 3.2, 0, 0], side: 'r', n: up, on: 'receiver' },
  ];
  if (e.length > 2) a.push({ text: 'next loop', p: [mid(1), 0, A * 0.4], side: 'r', n: up });
  if (layers.has('field')) a.push({ text: 'field B', p: [mid(Math.min(e.length - 2, 2)), 7, 0], side: 'r', n: up, on: 'field' });
  if (layers.has('electric') && e.length > 2) a.push({ text: 'field E', p: [(e[1] - 0.5) * LEN, 0, 10], side: 'l', n: front, on: 'electric' });
  if (st.neighbour !== 'off') a.push({ text: `neighbour, lay ${(st.neighbour === 'same' ? LAY_A_MM : LAY_B_MM).toFixed(1)} mm`, p: [-LEN * 0.38, 0, NEIGHBOUR_Z], side: 'l', n: front, on: 'neighbour' });
  if (layers.has('true')) {
    const r = (CAT5E.insulated / 2) * UPM;
    a.push({ text: 'true proportion', p: [LEN * 0.3, r, TRUE_Z], side: 'r', n: up, on: 'true' }, { text: 'ruler, 8 mm', p: [-LEN / 2 + 4 * UPM, -r - 2, TRUE_Z + r + 1.4], side: 'l', n: front, on: 'true' });
  }
  return a;
}

export const PAIR_HOME = { target: [0, 0, 0] as Vec3, yaw: -0.12, pitch: 0.8, dist: 90 };
export const PAIR_LAYERS: readonly (readonly CableLayer[])[] = [['field'], ['field'], ['field'], ['electric'], ['true'], []];

function pairBeats(look: CableLook): Beat[] {
  const n = Math.round(look.st.twists), L = n + 1;
  return [
    { title: 'A pair, twisted', text: `Two insulated copper wires twisted round each other, a sender at one end and a receiver at the other: ${n} half twists, so ${L} loops between the legs. A changing magnetic field through a loop drives a voltage round it (Faraday): its area times dB/dt.`, view: PAIR_HOME, frame: ['homebox'], cut: 0 },
    { title: 'Every half twist turns the loop over', text: 'The legs swap places at each crossing, so the next loop faces the other way and the same field drives it the other way: the lenses go red and blue in turn as the field rises and falls. Equal loops cancel in pairs.', view: { ...PAIR_HOME, yaw: 0, pitch: 1.25 }, frame: ['homebox'], show: ['pair', 'loops', 'field', 'sender', 'receiver'], cut: 0 },
    { title: 'The push, loop by loop', text: 'The beads are the charge each loop pushes round itself: along wire A one way and back along B, the next loop the other way. The receiver sees only the sum. With an odd number of equal half twists it is nothing and the resistor stays dark; an even number, or uneven twist, leaves some.', view: { ...PAIR_HOME, yaw: -0.4, pitch: 0.5 }, frame: ['loopbox'], cut: 0 },
    { title: 'An electric field from the side', text: 'At every crossing the two legs stand level, so a field from the side reaches both alike over the run: common mode, which a differential receiver rejects. Only the difference between the legs is the signal.', view: { ...PAIR_HOME, yaw: 0.5, pitch: 0.95 }, frame: ['sidebox'], cut: 0 },
    { title: 'Drawn far from life', text: `A real pair is two ${CAT5E.insulated} mm wires touching, turning once every ${LAY_A_MM.toFixed(1)} mm: behind, at the drawn pair’s width with a ruler in millimetres. The drawn twist is about ${tighterThanLife(n).toFixed(1)} times tighter, so the loops can be counted.`, view: { ...PAIR_HOME, yaw: -0.15, pitch: 0.7 }, frame: ['truebox'], cut: 0 },
    { title: 'Copper inside', text: `Cut across: each leg is a solid copper conductor (24 AWG in a Cat5e pair, ${CAT5E.conductor} mm) in its insulation, and the current runs in the copper. Here, in the middle of a loop, the legs stand farthest apart; at a crossing they lie one over the other.`, view: { ...PAIR_HOME, yaw: 1.4, pitch: 0.25 }, frame: ['endbox'], cut: 1 },
  ];
}

function coaxModel(look: CableLook): Model3 {
  const { st, layers } = look, full = look.detail === 'full', p = presetOf(st.preset), R = coaxRadii(p), seg = full ? 48 : 16, items: Item[] = [];
  const d = DIELECTRICS[st.diel], key = `${p.id}|${seg}`;
  const solid = (r: number, a: number, b: number) => onX(lathe([[0, a], [r, a], [r, b], [0, b]], { seg, crease: 60 }));
  const shell = (r0: number, r1: number, a: number, b: number) => onX(lathe([[r0, a], [r1, a], [r1, b], [r0, b], [r0, a]], { seg, crease: 60 }));
  items.push({ geo: once(`core${key}`, () => solid(R.core, CX.x0, CX.x1)), mat: M.make({ ...M.copper, label: p.id === 'rg59' ? 'copper-covered steel' : 'copper' }), name: 'centre conductor', group: 'core', explode: [0, 0, 0],
    info: { dim: `${p.d} mm, ${p.core}`, source: sheet(p) } });
  items.push({ geo: once(`diel${key}`, () => shell(R.core, R.diel, CX.x0, CX.diel)), mat: M.make({ base: '--m3-diel', metal: 0, rough: 0.45, coat: 0.2, label: `dielectric, ${d.name}` }), name: `dielectric, ${d.name}`, group: 'dielectric',
    info: { dim: `${p.D} mm across, εr = ${d.er}`, source: sheet(p), note: d.name === DIELECTRICS[p.dielectric].name ? 'the stock dielectric' : `not this cable’s: its sheet gives ${DIELECTRICS[p.dielectric].name}` } });
  items.push({ geo: once(`braid${key}|${full}`, () => braidGeo(R, full)), mat: M.make({ base: '--m3-shield', metal: 0.85, rough: 0.35, label: 'tinned copper braid' }), name: 'braid (the return)', group: 'braid', explode: [-6, 0, 0],
    info: { dim: p.id === 'rg58' ? 'tinned copper, 95 % coverage' : 'a braid shield', source: p.id === 'rg58' ? sheet(p) : SRC.drawn, note: `drawn as ${BRAID.carriers} carriers of ${BRAID.wires} wires each way; the sheets give the coverage, not the weave` } });
  items.push({ geo: once(`jacket${key}`, () => shell(R.jacketIn, R.jacket, CX.x0, CX.jacket)), mat: M.make({ ...M.plasticMatte, base: '--cb-pvc', label: p.id === 'rg58' ? 'PVC jacket' : 'jacket' }), name: 'jacket', group: 'jacket', explode: [-12, 0, 0],
    info: { dim: `${p.jacket} mm across`, source: sheet(p) } });
  // the field, a snapshot: E radial from the core to the braid, B in circles round the core (seen in the cut and at the end)
  if (layers.has('fields')) {
    const em = M.make({ base: '--m3-efield', metal: 0, rough: 0.5, emit: '--m3-efield', glow: 0.2, label: 'E, radial' }), bm = M.make({ base: '--m3-field', metal: 0, rough: 0.5, label: 'B, circles round the core' });
    const len = R.diel - R.core - 0.3, xs = [CX.x0 + 4, CX.x0 + 10, CX.x0 + 16];
    const ray = (a: number, at: Vec3): void => {
      const dir: Vec3 = [0, Math.cos(a), Math.sin(a)], q = quatAxisAngle([1, 0, 0], a), s0 = R.core + 0.15;
      items.push({ geo: once(`erad${p.id}`, () => tube([[0, s0, 0], [0, s0 + len - 0.9, 0]], 0.2, { sides: 8 })), mat: em, at, rot: q, name: 'E: radial, core to braid', group: 'fields', cut: 'none', shadow: false });
      items.push({ geo: once('ehead', () => lathe([[0, 0], [0.5, 0], [0, 0.9]], { seg: 12, crease: 80 })), mat: em, at: [at[0], at[1] + dir[1] * (s0 + len - 0.9), at[2] + dir[2] * (s0 + len - 0.9)], rot: q, name: 'E: radial, core to braid', group: 'fields', cut: 'none', shadow: false });
    };
    for (const x of xs) for (const a of [0, Math.PI]) ray(a, [x, 0, 0.2]);
    for (let i = 0; i < 8; i++) ray((i * Math.PI) / 4, [CX.x0 - 0.15, 0, 0]);
    const ring = (r: number) => once(`ring${r.toFixed(2)}`, () => transform(torus(r, 0.11, 40, 6), matOf(quatAxisAngle([0, 0, 1], Math.PI / 2))));
    for (const x of xs) for (const f of [0.35, 0.75]) items.push({ geo: ring(R.core + (R.diel - R.core) * f), mat: bm, at: [x, 0, 0], name: 'B: circles round the core', group: 'fields', cut: 'none', shadow: false });
    for (const f of [0.35, 0.75]) items.push({ geo: ring(R.core + (R.diel - R.core) * f), mat: bm, at: [CX.x0 - 0.12, 0, 0], name: 'B: circles round the core', group: 'fields', cut: 'none', shadow: false });
  }
  frameBox(items, 'homebox', CX.x0, CX.x1, -R.jacket, R.jacket, -R.jacket, R.jacket);
  frameBox(items, 'endbox', CX.x0 - 1, CX.x0 + 6, -R.jacket - 1, R.jacket + 1, -R.jacket - 1, R.jacket + 1);
  frameBox(items, 'cutbox', CX.x0 - 1, CX.braid + 1, -R.jacket - 1, R.jacket + 1, -R.jacket, 0.5);
  return { items, cuts: { planes: [{ n: [0, 0, 1], d: 0 }], open: [R.jacket + 2] }, anchors: coaxAnchors(look, R), beats: coaxBeats(look), floor: -R.jacket - 4 };
}

/** The braid: carriers of a few wires wound each way at BRAID.angle, the second set a wire's width further out. */
function braidGeo(R: ReturnType<typeof coaxRadii>, full: boolean): Geo {
  const w = BRAID.wireMm * CMM, list: Geo[] = [], per = full ? 36 : 12;
  for (const hand of [1, -1] as const) {
    const r = hand === 1 ? R.braidIn : R.braidIn + 2 * w, pitch = (2 * Math.PI * r) / Math.tan(BRAID.angle), len = CX.braid - CX.x0, turns = len / pitch;
    for (let c = 0; c < BRAID.carriers; c++) for (let k = 0; k < BRAID.wires; k++) {
      const a0 = (2 * Math.PI * c) / BRAID.carriers + ((k - (BRAID.wires - 1) / 2) * 2.1 * w) / r, steps = Math.max(4, Math.ceil(turns * per));
      const pts: Vec3[] = Array.from({ length: steps + 1 }, (_, i) => { const f = i / steps, a = a0 + hand * f * turns * 2 * Math.PI; return [CX.x0 + f * len, r * Math.cos(a), r * Math.sin(a)]; });
      list.push(tube(pts, w, { sides: full ? 6 : 4 }));
    }
  }
  return merge(list, 'braid');
}
function coaxAnchors(look: CableLook, R: ReturnType<typeof coaxRadii>): StudioAnchor[] {
  const up: Vec3 = [0, 1, 0];
  const a: StudioAnchor[] = [
    { text: 'jacket', p: [(CX.x0 + CX.jacket) / 2, R.jacket, 0], side: 'l', n: up, on: 'jacket' },
    { text: 'braid (return)', p: [(CX.jacket + CX.braid) / 2, R.braidOut, 0], side: 'l', n: up, on: 'braid' },
    { text: 'dielectric', p: [(CX.braid + CX.diel) / 2, R.diel, 0], side: 'r', n: up, on: 'dielectric' },
    { text: 'core', p: [(CX.diel + CX.x1) / 2, R.core, 0], side: 'r', n: up, on: 'core' },
  ];
  if (look.layers.has('fields')) a.push({ text: 'E: radial', p: [CX.x0 - 0.15, R.diel * 0.7, 0], side: 'l', n: [-1, 0, 0] }, { text: 'B: round the core', p: [CX.x0 - 0.12, 0, -(R.core + (R.diel - R.core) * 0.75)], side: 'l', n: [-1, 0, 0], minor: true });
  return a;
}

export const COAX_HOME = { target: [0, 0, 0] as Vec3, yaw: -0.45, pitch: 0.3, dist: 90 };
export const COAX_LAYERS: readonly (readonly CableLayer[])[] = [[], ['fields'], ['fields'], []];

function coaxBeats(look: CableLook): Beat[] {
  const p = presetOf(look.st.preset), d = DIELECTRICS[look.st.diel];
  return [
    { title: 'A coax, stripped back', text: `${p.name} as ${p.sheet} makes it, to scale: a ${p.d} mm centre conductor, ${d.name} to ${p.D} mm, a braid over it and a ${p.jacket} mm jacket, each cut back a step further.`, view: COAX_HOME, frame: ['homebox'], cut: 0, explode: 0 },
    { title: 'The cross-section', text: 'Seen end on: the signal goes out on the centre conductor and comes back on the inside of the braid. The electric field runs straight out from the core to the braid; the magnetic field circles the core. Both live in the dielectric between.', view: { ...COAX_HOME, yaw: -1.5, pitch: 0.15 }, frame: ['endbox'], cut: 0, explode: 0 },
    { title: 'Where the field lives', text: 'Cut open lengthwise: the same field all along, inside the braid. Outside it the out and back currents add to nothing, so the coax neither radiates nor picks up a passing field; it needs no twist. That holds above the shield’s R/L corner, a kilohertz or so.', view: { ...COAX_HOME, yaw: -0.05, pitch: 0.25 }, frame: ['cutbox'], cut: 1, explode: 0 },
    { title: 'Its impedance', text: `L and C a metre follow from D / d and the dielectric’s εr alone; Z0 = √(L / C). ${p.name}’s D / d of ${(p.D / p.d).toFixed(2)} in ${DIELECTRICS[p.dielectric].name} gives the sheet’s ${p.z0} Ω. The layers pulled apart.`, view: { ...COAX_HOME, yaw: -0.35, pitch: 0.5 }, frame: ['homebox'], cut: 0, explode: 1 },
  ];
}
