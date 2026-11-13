// The moving-coil loudspeaker (Dayton RS180-8) on the studio renderer, in true geometry (DOM-free; millimetres, y up along
// the axis, the cone facing +y). The physics is speaker3dparts.ts's (poseAt: the cone's second-order answer to the held
// current); this file draws a pose of it. The cone, the former and its winding go through `speakerPose` (stage.move); the spider
// and the surround, whose inner edges ride with the cone and whose outer edges stay on the frame, and the tinsel lead are bent in
// place each frame (refresh: the counts never change). The front half (z > 0) is cut away at home so the section shows.
//
// Sourced (Dayton's product page): the cone's radius (from Sd), the 38 mm coil on an aluminium former, Xmax, Bl, Mms, the
// black anodised aluminium cone, the rubber surround, the cast six-hole frame, the ferrite magnet, the solid aluminium phase plug
// (no dust cap), 180.5 mm overall. Drawn, not measured: the winding and gap heights (chosen so Xmax = (18 − 6) / 2), the magnet's,
// plates' and phase plug's sizes, the spider's corrugations, the frame's spokes and the 168 mm bolt circle (a seller's listing).

import { helix, lathe, merge, roundedBox, transform, tube, type Geo } from '../gl/kit/geo';
import { M, type Material } from '../gl/kit/materials';
import type { Beat, Item, Model3, StudioAnchor } from '../gl/kit/scene';
import type { Mat4, Vec3 } from '../gl/math';
import { GEOM, PLUG, XMAX_MM, plugSteps, poseAt, rollPts, spiderPts, type Drive } from './speaker3dparts';

type Detail = 'full' | 'flat';
const tr = (p: Vec3): Mat4 => { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; m[12] = p[0]; m[13] = p[1]; m[14] = p[2]; return m; };
const G = GEOM;
const segOf = (d: Detail) => (d === 'flat' ? 20 : 72);
/** A closed (r, y) ring section: lathe needs the outline counter-clockwise (out along the bottom, up the outside). */
const ringSec = (rIn: number, rOut: number, y0: number, y1: number): [number, number][] => [[rIn, y0], [rOut, y0], [rOut, y1], [rIn, y1], [rIn, y0]];
/** A sheet of thickness t along a polyline of (r, y) points: out along the lower face, back along the upper (a closed wall, so the cut caps it). */
export function sheetSec(pts: readonly (readonly [number, number])[], t: number): [number, number][] {
  const n = pts.length, up: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)], dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
    up.push([pts[i][0] - (dy / L) * t, pts[i][1] + (dx / L) * t]);
  }
  return [...pts.map((p): [number, number] => [p[0], p[1]]), ...up.reverse(), [pts[0][0], pts[0][1]]];
}

// ---------------------------------------------------------------- the frame's layout (drawn)

/** The flange: inner and outer radius, height (overall 180.5 mm across, Dayton). */
export const FLANGE = { rIn: 72, rOut: 90.25, y0: 70, y1: 74 };
/** Six mounting holes on a 168 mm bolt circle (6.63 in: a seller's listing; the hole size is drawn). */
export const BOLT_R = 84, HOLE_R = 2.6;
/** The six cast spokes from the top plate's rim to the flange, between the holes. */
export const SPOKES = 6, SPOKE_R = 2.6;
const spokeAt = (k: number) => ((k + 0.5) * 2 * Math.PI) / SPOKES;
/** The shelf the spider's outer edge is glued to, on the spokes. */
export const SHELF = { rIn: 64, rOut: 70, y0: 40, y1: 43 };
/** The tinsel lead's terminal on the frame (angle and place: drawn). */
const LEAD_PHI = Math.PI * 1.22;

// ---------------------------------------------------------------- geometry

interface Statics { motor: Geo; magnet: Geo; plate: Geo; plug: Geo; frame: Geo; holes: Geo; former: Geo; wind: Geo; cone: Geo; terminal: Geo; flux: Geo; force: Geo }
const memo = new Map<Detail, Statics>();
function statics(d: Detail): Statics {
  const hit = memo.get(d);
  if (hit) return hit;
  const seg = segOf(d), o = { seg, crease: 40 };
  // the motor: back plate and pole in one steel part, the ferrite ring, the top plate
  const motor = lathe([[0, 0], [G.outerR, 0], [G.outerR, G.backTop], [G.poleR, G.backTop], [G.poleR, G.plateTop], [0, G.plateTop]], o);
  const magnet = lathe(ringSec(G.magnetIn, G.outerR, G.backTop, G.magnetTop), o);
  const plate = lathe(ringSec(G.plateIn, G.outerR, G.magnetTop, G.plateTop), o);
  // the phase plug: a cylinder clear of the former, then an ogive (plugSteps)
  const ps = plugSteps(8), plug = lathe([[0, G.plateTop], [PLUG.r, G.plateTop], [PLUG.r, PLUG.shoulder], ...ps.slice(1).map(([r, , y1]): [number, number] => [r, y1]), [0, PLUG.tip]], o);
  // the cast frame: a seat on the top plate, six spokes, the spider's shelf, the flange
  const s0: [number, number] = [G.outerR - 2, G.plateTop + 1], s1: [number, number] = [FLANGE.rIn + 2, FLANGE.y0 + 1];
  const frame = merge([
    lathe(ringSec(G.outerR - 6, G.outerR + 1, G.plateTop, G.plateTop + 3), o),
    lathe(ringSec(SHELF.rIn, SHELF.rOut, SHELF.y0, SHELF.y1), o),
    lathe(ringSec(FLANGE.rIn, FLANGE.rOut, FLANGE.y0, FLANGE.y1), o),
    ...Array.from({ length: SPOKES }, (_, k) => {
      const c = Math.cos(spokeAt(k)), s = Math.sin(spokeAt(k));
      return tube([[s0[0] * c, s0[1], s0[0] * s], [SHELF.rOut * c, SHELF.y0 + 1, SHELF.rOut * s], [s1[0] * c, s1[1], s1[0] * s]], SPOKE_R, { sides: d === 'flat' ? 5 : 10 });
    }),
  ], 'frame');
  const holes = merge(Array.from({ length: SPOKES }, (_, k) => {
    const a = (k * 2 * Math.PI) / SPOKES;
    return transform(lathe([[0, FLANGE.y1 - 0.2], [HOLE_R, FLANGE.y1 - 0.2], [HOLE_R, FLANGE.y1 + 0.05], [0, FLANGE.y1 + 0.05]], { seg: 16 }), tr([BOLT_R * Math.cos(a), 0, BOLT_R * Math.sin(a)]));
  }), 'holes');
  // the moving parts at rest (the pose moves them): former, winding, cone
  const former = lathe(ringSec(G.formerIn, G.formerOut, G.windLow, G.formerTop), o);
  const turns = d === 'flat' ? 10 : 16, pitch = (G.windHigh - G.windLow - 1) / turns;
  const wind = tube(helix({ r: (G.formerOut + G.windOut) / 2, pitch, from: G.windLow + 0.5, to: G.windHigh - 0.5, perTurn: d === 'flat' ? 12 : 36 }), (G.windOut - G.formerOut) / 2 + 0.15, { sides: d === 'flat' ? 4 : 8 });
  const cone = lathe(sheetSec([[G.coneNeck, G.formerTop], [G.coneRim, G.coneRimY]], 0.8), o);
  const terminal = transform(roundedBox(6, 4, 8, 0.6), tr([SHELF.rOut * Math.cos(LEAD_PHI), SHELF.y1 + 2, SHELF.rOut * Math.sin(LEAD_PHI)]));
  // B across the gap on the cut face (plate to pole, radially in), and the force arrow (unit length along +y, scaled by the pose)
  const arrowGeo = (a: Vec3, b: Vec3, r: number, head: number): Geo => {
    const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy), u = [dx / L, dy / L], hb: Vec3 = [b[0] - u[0] * head, b[1] - u[1] * head, b[2]];
    // the head: a lathed cone along y, turned onto u (in the x-y plane) at the shaft's end
    const turn = new Float32Array([u[1], -u[0], 0, 0, u[0], u[1], 0, 0, 0, 0, 1, 0, hb[0], hb[1], hb[2], 1]);
    return merge([tube([a, hb], r, { sides: 6 }), transform(lathe([[0, 0], [r * 2.6, 0], [0, head]], { seg: 10 }), turn)], 'arrow');
  };
  const flux = merge([G.magnetTop + 1.5, G.magnetTop + 3, G.plateTop - 1.5].flatMap((y) => [-1, 1].map((sx) => arrowGeo([sx * (G.plateIn - 0.1), y, 0.4], [sx * (G.poleR + 0.3), y, 0.4], 0.22, 0.9))), 'flux');
  const force = arrowGeo([0, 0, 0], [0, 1, 0], 0.45, 0.2); // unit length: the pose scales y only, so the radii stay
  const s: Statics = { motor, magnet, plate, plug, frame, holes, former, wind, cone, terminal, flux, force };
  memo.set(d, s);
  return s;
}

/** The parts that bend: spider, surround and the tinsel lead, for the cone displaced `dy` mm (as drawn). */
export function bentAt(dy: number, d: Detail): { spider: Geo; surround: Geo; lead: Geo } {
  const seg = segOf(d), o = { seg, crease: 25 };
  const spider = lathe(sheetSec(spiderPts(G.formerOut, 33 + dy, SHELF.rIn + 2, SHELF.y1, 2.5, 3), 0.7), o);
  const surround = lathe(sheetSec(rollPts(G.coneRim - 0.5, G.coneRimY + dy, FLANGE.y1 - 0.3, 4.5, d === 'flat' ? 6 : 12), 1.2), o);
  const c = Math.cos(LEAD_PHI), s = Math.sin(LEAD_PHI), at = (r: number, y: number): Vec3 => [r * c, y, r * s];
  const lead = tube([at(G.windOut + 0.6, G.windHigh + dy), at(G.windOut + 4, G.formerTop + 3 + dy), at(36, 46 + dy * 0.7), at(54, 48 + dy * 0.35), at(SHELF.rOut, SHELF.y1 + 2)], 0.6, { sides: 6 });
  return { spider, surround, lead };
}
const bent = new Map<Detail, { spider: Geo; surround: Geo; lead: Geo }>();
/** The drawn bending parts for a detail, made once (later poses are copied into them by the view). */
export function bentGeo(d: Detail, dy: number) { let b = bent.get(d); if (!b) { b = bentAt(dy, d); bent.set(d, b); } return b; }
export const bentOf = (d: Detail) => bent.get(d);

// ---------------------------------------------------------------- materials

const DAYTON = 'Dayton Audio, RS180-8 product page';
const quant = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 8) / 8;
const glowMemo = new Map<number, Material>();
export const MATS = {
  steel: M.make({ base: [0.6, 0.62, 0.65], metal: 0.8, rough: 0.35, label: 'steel (plated)' }),
  ferrite: M.make({ base: [0.2, 0.2, 0.21], metal: 0, rough: 0.75, label: 'ferrite (sintered ceramic)' }),
  plug: M.make({ base: [0.66, 0.67, 0.69], metal: 0.8, rough: 0.4, label: 'aluminium, solid (Dayton)' }),
  frame: M.make({ base: [0.42, 0.43, 0.45], metal: 0.55, rough: 0.5, label: 'cast aluminium' }),
  hole: M.make({ base: [0.02, 0.02, 0.02], metal: 0, rough: 1, label: 'mounting hole' }),
  former: M.make({ base: [0.85, 0.86, 0.88], metal: 0.85, rough: 0.3, label: 'aluminium former (Dayton)' }),
  // black anodised aluminium: dark, with the sheen of the metal under the dye, so the key light runs along it
  cone: M.make({ base: [0.24, 0.24, 0.27], metal: 0.7, rough: 0.2, coat: 0.7, label: 'black anodised aluminium (Dayton)' }),
  rubber: M.make({ base: [0.1, 0.1, 0.11], metal: 0, rough: 0.55, label: 'rubber (Dayton)' }),
  spider: M.make({ base: [0.56, 0.45, 0.26], metal: 0, rough: 0.8, label: 'resin-treated fabric (not on the page: the usual spider)' }),
  terminal: M.make({ base: [0.15, 0.15, 0.16], metal: 0, rough: 0.6, label: 'terminal block (drawn)' }),
  lead: M.make({ base: [0.9, 0.66, 0.4], metal: 0.8, rough: 0.35, label: 'tinsel lead' }),
  flux: M.beam([0.35, 0.6, 1.0], 1.2),
  force: M.beam([1.0, 0.72, 0.25], 1.6),
  /** The winding, glowing with the current through it (speaker) or the EMF across it (mic). */
  wind: (level: number): Material => {
    const q = quant(level), hit = glowMemo.get(q);
    if (hit) return hit;
    const m = M.make({ base: [0.95, 0.6, 0.45], metal: 0.85, rough: 0.3, emit: [1.0, 0.55, 0.2], glow: 0.25 + 1.2 * q, label: 'copper wire (Dayton): glows with the current' });
    glowMemo.set(q, m);
    return m;
  },
};

// ---------------------------------------------------------------- the model

export interface SpeakerState { d: Drive; t: number }
/** The cone's drawn displacement (mm) at the pose. */
export const dyOf = (s: SpeakerState): number => poseAt(s.d, s.t).cone * XMAX_MM * s.d.mag;

export function speakerModel(s: SpeakerState, detail: Detail = 'full'): Model3 {
  const S = statics(detail), b = bentGeo(detail, dyOf(s)), ps = poseAt(s.d, s.t), mic = s.d.mode === 'mic';
  const items: Item[] = [
    { geo: S.motor, mat: MATS.steel, name: 'pole piece and back plate', group: 'motor', explode: [0, -70, 0], info: { note: 'steel: carries the magnet’s flux to the middle of the gap (sizes drawn)' } },
    { geo: S.magnet, mat: MATS.ferrite, name: 'ferrite magnet', group: 'motor', explode: [0, -70, 0], info: { source: DAYTON, note: 'a ring magnetised along the axis (its size is drawn)' } },
    { geo: S.plate, mat: MATS.steel, name: 'top plate', group: 'motor', explode: [0, -70, 0], info: { note: 'the gap is between its inner edge and the pole: 6 mm tall here, chosen with the 18 mm winding so Xmax = (18 − 6) / 2' } },
    { geo: S.plug, mat: MATS.plug, name: 'phase plug', group: 'plug', explode: [0, -70, 0], info: { source: `${DAYTON}: “a solid aluminum phase plug” (no dust cap)`, note: 'fixed on the pole: it does not move with the cone (its size is drawn)' } },
    { geo: S.frame, mat: MATS.frame, name: 'frame', group: 'frame', explode: [0, -25, 0], info: { dim: '180.5 mm across', source: `${DAYTON}: cast aluminium, six holes`, note: 'six spokes, the spider’s shelf and the flange (their shapes drawn)' } },
    { geo: S.holes, mat: MATS.hole, name: 'frame', group: 'frame', explode: [0, -25, 0], cut: 'none', shadow: false },
    { geo: S.terminal, mat: MATS.terminal, name: 'terminal', group: 'frame', explode: [0, -25, 0] },
    { geo: S.former, mat: MATS.former, name: 'voice coil', group: 'moving', explode: [0, 15, 0], info: { dim: '38 mm across', source: `${DAYTON}: copper on an aluminium former` } },
    { geo: S.wind, mat: MATS.wind(Math.abs(ps.drive)), name: 'voice coil', group: 'moving', explode: [0, 15, 0], info: { note: `${detail === 'flat' ? 10 : 16} turns drawn of about 64 (estimated from Bl / B): ${mic ? 'it glows with the EMF the moving coil makes' : 'it glows with the current'}` } },
    { geo: S.cone, mat: MATS.cone, name: 'cone', group: 'moving', explode: [0, 80, 0], info: { dim: `${G.coneRim * 2} mm across (from Sd = 124.7 cm²)`, source: DAYTON, note: 'cone, coil and part of the suspension are the moving mass, Mms = 17.9 g' } },
    { geo: b.surround, mat: MATS.rubber, name: 'surround', group: 'suspension', explode: [0, 80, 0], info: { source: DAYTON, note: 'the outer half of the spring; it rolls as the cone moves' } },
    { geo: b.spider, mat: MATS.spider, name: 'spider', group: 'suspension', explode: [0, 42, 0], info: { note: 'the main spring: centres the coil and pulls it back (Cms = 1.12 mm/N for the whole suspension)' } },
    { geo: b.lead, mat: MATS.lead, name: 'tinsel lead', group: 'suspension', shadow: false, info: { note: 'flexible lead from the coil to the terminal: it moves with the cone' } },
    { geo: S.flux, mat: MATS.flux, name: 'B across the gap', group: 'field', cut: 'none', shadow: false, info: { note: 'the field crosses the gap radially, plate to pole' } },
  ];
  if (!mic) items.push({ geo: S.force, mat: MATS.force, name: 'force F = B·l·i', group: 'force', cut: 'none', shadow: false, info: { note: 'on the coil, up for a positive current; its length follows the held current' } });

  const front: Vec3 = [0, 0, 1], up: Vec3 = [0, 1, 0], at = (r: number, phi: number, y: number): Vec3 => [r * Math.cos(phi), y, r * Math.sin(phi)];
  const anchors: StudioAnchor[] = [
    { text: 'cone', p: at(44, Math.PI * 1.3, 54), side: 'l', n: up, on: 'moving' },
    { text: 'surround', p: at(68, Math.PI * 1.12, 78), side: 'l', n: up, on: 'suspension' },
    { text: 'voice coil', p: [-G.windOut, 25, 0], side: 'r', n: front, on: 'moving' },
    { text: 'phase plug', p: [-6, PLUG.shoulder + 4, 0], side: 'r', n: front, on: 'plug' },
    { text: 'magnet', p: [-50, 13, 0], side: 'l', n: front, on: 'motor' },
    { text: 'spider', p: at(48, Math.PI * 1.75, 40), side: 'r', n: up, on: 'suspension' },
  ];
  const close = { yaw: 0.12, pitch: 0.08, target: [-19, 26, 0] as Vec3, dist: 95 };
  const beats: Beat[] = [
    { title: 'A cone on a coil', text: 'The cone, its coil and the suspension move as one; the magnet, the plates and the frame stay put. The voice’s samples, held by the DAC, become a current in the coil.', view: { yaw: 0.55, pitch: 0.34, target: [0, 40, 0], dist: 420 }, cut: 1 },
    { title: 'A gap full of field', text: 'The ferrite ring is magnetised along the axis; the steel carries its flux to a narrow gap between the top plate and the pole, where it crosses radially (the blue arrows).', view: { yaw: 0.2, pitch: 0.12, target: [-30, 16, 0], dist: 160 }, cut: 1, frame: ['motor'] },
    { title: 'The coil in the gap: F = B·l·i', text: 'The winding sits in the gap; the current through it crosses the field, and the force B·l·i pushes the coil and the cone along the axis (the amber arrow), up or down with the current’s sign. Bl = 7.82 T·m: 7.82 N for every ampere.', view: close, cut: 1 },
    { title: 'A mass on a spring', text: 'Pulled apart: the moving mass (cone, coil, former: Mms = 17.9 g) and the spring that holds it (spider and surround: Cms = 1.12 mm/N). Above its resonance, 35.7 Hz, the mass decides: the cone follows the average of the held steps and never their edges.', view: { yaw: 0.55, pitch: 0.22, target: [0, 70, 0], dist: 520 }, cut: 1, explode: 1 },
    { title: 'A phase plug, not a dust cap', text: 'In the middle sits a solid aluminium plug fixed to the pole, where most drivers have a dome glued to the cone: it does not move, so it adds nothing to the moving mass (Dayton).', view: { yaw: 0.3, pitch: 0.3, target: [0, 46, 0], dist: 170 }, cut: 1, frame: ['plug'] },
  ];
  return { items, anchors, beats, cuts: { planes: [{ n: [0, 0, 1], d: 0 }], open: [FLANGE.rOut + 20] }, floor: -1, look: { exposure: 1.2, keyDir: [-0.4, 0.75, 0.55] } };
}

/** The moving parts' motion at the pose: the cone and coil by the drawn displacement, the force arrow scaled by the held current. */
export function speakerPose(s: SpeakerState): Map<string, Mat4> {
  const dy = dyOf(s), ps = poseAt(s.d, s.t), moves = new Map<string, Mat4>([['moving', tr([0, dy, 0])]]);
  const len = Math.sign(ps.drive) * Math.max(4, Math.abs(ps.drive) * 16), gm = (G.formerIn + G.windOut) / 2 + 3;
  const m = tr([-gm, G.formerTop + dy, 0.6]); m[5] = Math.abs(ps.drive) < 0.02 ? 1e-4 : len;
  moves.set('force', m);
  return moves;
}

export const SPEAKER_HOME = { yaw: 0.3, pitch: 0.36, target: [0, 40, 0] as Vec3, dist: 420 };
