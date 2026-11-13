// ENIAC's decade ring counter on the studio renderer (DOM-free, tested): two plug-in decade units, units and tens, one
// above the other. On each: ten 6SN7 twin triodes in a row (one Eccles–Jordan flip-flop each, Rock's triode3dkit tube
// merged per material), a neon under each on the front edge (lit for the stage that holds the digit), digits 0–9 printed
// under the neons, and behind them the digit's other 26 tubes (standardizer, carry, transmitters: simple bulbs, drawn).
// A pulse wire into the units; the carry wire from the units' ninth stage to the tens, lit when the units pass nine.
//
// Units: mm (eniac3dgeom.ts).

import { lathe, merge, roundedBox, sphere, transform, tube, type Geo } from '../gl/kit/geo';
import { M, type Material } from '../gl/kit/materials';
import { onPlane, strokeGeo } from '../gl/kit/text';
import { itemMatrix, type Beat, type Item, type Model3, type StudioAnchor } from '../gl/kit/scene';
import type { OrbitView } from '../gl/camera';
import type { Vec3 } from '../gl/math';
import { XA, XB, tubeModel } from './triode3dkit';
import { stateAt } from './triode3dview';
import {
  ACCUMULATORS, BACK_Z, CHASSIS_H, DECADES, DIGITS, NEON_Y, OTHER_TUBES, PITCH, RING_TRIODES, RING_Z, STAGES, TUBES_PER_DIGIT, UNIT_D, UNIT_L,
  decadeY, decadeZ, stageX, type Decades,
} from './eniac3dgeom';

type Detail = 'full' | 'flat';
/** Seconds since the heaters were switched on: long past warm-up (Rock's tube is warm by 20 s), so every heater glows. */
const WARM = 20;
const SRC = {
  ord: 'U.S. Army Ordnance, Electronic Computers Within the Ordnance Corps (1961), ch. 2',
  wiki: 'Wikipedia, ENIAC: 36 tubes a digit, 10 of them the ring\'s twin triodes; 6SN7 flip-flops',
  si: 'Smithsonian NMAH, ENIAC Decade Ring Counter: about 114.5 cm long',
  tube: '6SN7GT outline (T-9 bulb, octal base): Rock\'s triode3dkit',
  drawn: 'drawn: no drawing of the unit was read',
};

// ---------------------------------------------------------------- the 6SN7, merged per material

interface TubeParts { parts: { geo: Geo; mat: Material }[] }
const tubes = new Map<Detail, TubeParts>();
/** One warm 6SN7 as a few meshes (one per material): Rock's tube at its low detail for the GPU, a plain bulb for the SVG
 *  fallback (the full tube is 18 000 triangles; twenty of them would stall a drawing made of polygons). */
function sixSN7(d: Detail): TubeParts {
  const hit = tubes.get(d);
  if (hit) return hit;
  let parts: { geo: Geo; mat: Material }[];
  if (d === 'full') {
    const m = tubeModel(stateAt(0, WARM), { charge: false, detail: 'flat', electron: M.copper }), by = new Map<string, { geos: Geo[]; mat: Material }>(), mtx = new Float32Array(16);
    for (const it of m.items) {
      if (it.mat.beam) continue;
      const key = JSON.stringify([it.mat.label, it.mat.base, it.mat.emit, it.mat.glow, it.mat.transmit]), g = by.get(key) ?? { geos: [], mat: it.mat };
      g.geos.push(transform(it.geo, itemMatrix(it, 0, mtx))); by.set(key, g);
    }
    parts = [...by.values()].map((g) => ({ geo: merge(g.geos, g.mat.label ?? '6SN7'), mat: g.mat }));
  } else {
    parts = [
      { geo: lathe([[0, 12], [14.3, 12], [14.3, 62], [9, 69], [0, 70]], { seg: 10 }), mat: M.glass },
      { geo: lathe([[0, 0], [14.8, 0], [14.8, 13], [0, 13]], { seg: 10 }), mat: M.bakelite },
      { geo: lathe([[0, 30], [5, 30], [5, 52], [0, 52]], { seg: 8 }), mat: M.make({ base: [0.3, 0.3, 0.32], metal: 0.5, rough: 0.5, label: 'plates' }) },
    ];
  }
  const out = { parts };
  tubes.set(d, out);
  return out;
}

// ---------------------------------------------------------------- the unit

const at3 = (g: Geo, x: number, y: number, z: number): Geo => { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; m[12] = x; m[13] = y; m[14] = z; return transform(g, m); };
interface UnitGeos { halo: Geo; chassis: Geo; front: Geo; digits: Geo; back: Geo; backBases: Geo; neon: Geo; neonCap: Geo; sockets: Geo; plug: Geo; plugPins: Geo; cloud: Geo; heat: Geo }
const units = new Map<Detail, UnitGeos>();
function unitGeos(d: Detail): UnitGeos {
  const hit = units.get(d);
  if (hit) return hit;
  const seg = d === 'full' ? 28 : 8, frontZ = UNIT_D / 2;
  const bulb = lathe([[0, 0], [11, 0], [11, 40], [7, 46], [0, 47]], { seg }), base = lathe([[0, 0], [12, 0], [12, 11], [0, 11]], { seg });
  // the digit's other 26 tubes: two staggered rows behind the ring
  const others = Array.from({ length: OTHER_TUBES }, (_, i) => { const row = i % 2, k = Math.floor(i / 2), x = -UNIT_L / 2 + 50 + k * ((UNIT_L - 100) / 12); return [x, BACK_Z - row * 40] as [number, number]; });
  const pin = lathe([[0, 0], [2.4, 0], [2.4, 14], [0, 14]], { seg: d === 'full' ? 10 : 6 });
  // pins along −x out of the plug's face: a quarter turn about z (lathe axis y → −x)
  const pinRot = new Float32Array(16); pinRot[1] = 1; pinRot[4] = -1; pinRot[10] = 1; pinRot[15] = 1;
  const g: UnitGeos = {
    chassis: roundedBox(UNIT_L, CHASSIS_H, UNIT_D, 2, 1),
    front: roundedBox(UNIT_L, CHASSIS_H + 20, 3, 1, 1),
    digits: merge(Array.from({ length: STAGES }, (_, s) => strokeGeo(String(s), onPlane([0, 0, frontZ + 3.2], [1, 0, 0], [0, 1, 0], [0, 0, 1]), stageX(s), NEON_Y - 2 - CHASSIS_H / 2 - 22, 16)), 'digits'),
    halo: sphere(16, d === 'full' ? 24 : 8, d === 'full' ? 12 : 4),
    back: merge(others.map(([x, z]) => at3(bulb, x, CHASSIS_H / 2 + 11, z)), 'other tubes'),
    backBases: merge(others.map(([x, z]) => at3(base, x, CHASSIS_H / 2, z)), 'other tubes'),
    neon: lathe([[0, 0], [3.3, 0], [3.3, 13], [2.2, 17], [0, 18]], { seg: d === 'full' ? 20 : 8 }),
    neonCap: lathe([[0, 0], [4.2, 0], [4.2, 4], [0, 4]], { seg: d === 'full' ? 20 : 8 }),
    sockets: merge(Array.from({ length: STAGES }, (_, s) => at3(lathe([[0, 0], [17, 0], [17, 3], [0, 3]], { seg: d === 'full' ? 24 : 8 }), stageX(s), CHASSIS_H / 2, RING_Z)), 'sockets'),
    // the plug at the unit's end, where it met the accumulator's back plane (drawn)
    plug: at3(roundedBox(30, CHASSIS_H - 10, UNIT_D - 30, 2, 1), -UNIT_L / 2 - 15, 0, 0),
    plugPins: merge(Array.from({ length: 12 }, (_, i) => { const m = pinRot.slice(); m[12] = -UNIT_L / 2 - 30; m[13] = (i % 2 ? 9 : -9); m[14] = -45 + Math.floor(i / 2) * 18; return transform(pin, m); }), 'plug pins'),
    // the conducting section's current between its plates, drawn as a soft glow (a cue: a 6SN7's current makes no light)
    cloud: lathe([[0, 24], [5.6, 24], [6.6, 41], [5.6, 57], [0, 58]], { seg: d === 'full' ? 16 : 6 }),
    // a heater's top where it shows above the plates, one per section
    heat: merge([XA, XB].map((x) => at3(sphere(2.1, 10, 6), x, 54, 0)), 'heaters'),
  };
  units.set(d, g);
  return g;
}

// ---------------------------------------------------------------- materials

/** ENIAC's units were painted steel; a grey wrinkle finish is drawn (the colour of the survivors in photographs). */
const enamel = M.make({ base: [0.26, 0.28, 0.25], metal: 0.15, rough: 0.7, coat: 0.1, label: 'chassis, painted steel (wrinkle finish)' });
const panelMat = M.make({ base: [0.3, 0.31, 0.29], metal: 0.15, rough: 0.55, label: 'front panel, painted steel' });
const ink = M.make({ base: [0.93, 0.92, 0.86], metal: 0, rough: 0.6, label: 'engraved digit, white fill' });
const plugMat = M.make({ base: [0.24, 0.16, 0.1], metal: 0, rough: 0.5, label: 'plug body, phenolic' });
const dimGlass = M.make({ base: [0.42, 0.42, 0.42], metal: 0, rough: 0.2, transmit: 0.45, tint: [0.7, 0.7, 0.7], label: 'the digit\'s other tubes (drawn dim: they lead nothing here)' });
const neonOff = M.make({ base: [0.75, 0.72, 0.66], metal: 0, rough: 0.1, transmit: 0.6, tint: [0.95, 0.9, 0.85], label: 'neon lamp, off' });
const neonOn = M.glow(M.make({ base: [1.0, 0.45, 0.15], metal: 0, rough: 0.2, label: 'neon lamp, lit: this stage holds the digit' }), [1.0, 0.42, 0.12], 4);
/** The lit neon's glow, drawn far wider than the lamp so it reads at the unit's scale (a cue, not a part). */
const haloMat = M.glow(M.make({ base: [1.0, 0.5, 0.2], metal: 0, rough: 0.5, transmit: 0.75, tint: [1, 0.6, 0.3], label: 'glow of the lit neon (drawn wide)' }), [1.0, 0.45, 0.15], 1.2);
/** The conducting triode: "0" side in a stage that holds nothing, "1" side in the stage that holds the digit. */
const cond0 = { ...M.glow(M.make({ base: [0.35, 0.45, 1.0], metal: 0, rough: 0.5, transmit: 0.35, tint: [0.5, 0.6, 1] }), [0.35, 0.5, 1.0], 1.2), label: 'conducting triode, the "0" side (its current drawn as a glow)' };
const cond1 = { ...M.glow(M.make({ base: [0.45, 0.6, 1.0], metal: 0, rough: 0.5, transmit: 0.2, tint: [0.6, 0.7, 1] }), [0.4, 0.58, 1.0], 1.5), label: 'conducting triode, the "1" side: this stage holds the digit' };
/** The heaters' visible ends: the orange of a cathode at about 1 100 K (drawn as points, so twenty read at this scale). */
const heatMat = M.glow(M.make({ base: [1.0, 0.4, 0.1], metal: 0, rough: 0.5, label: 'heater, glowing orange (its end above the plates)' }), [1.0, 0.32, 0.04], 1.6);
const wireOff = M.make({ base: [0.5, 0.36, 0.3], metal: 0.2, rough: 0.5, label: 'pulse wire' });
const wireOn = M.glow(M.make({ base: [1.0, 0.55, 0.2], metal: 0, rough: 0.3, label: 'a pulse' }), [1.0, 0.5, 0.18], 1.4);

// ---------------------------------------------------------------- the model

/** Home: low, three-quarters along the units decade from its front panel, the tens behind and above. */
export const ENIAC_HOME: OrbitView = { target: [stageX(5), 60, RING_Z], yaw: 0.92, pitch: 0.15, dist: 1000 };
/** Both decades from above: the carry between them. */
export const ENIAC_TOP: OrbitView = { target: [0, decadeY(1) / 2 + 30, decadeZ(1) / 2], yaw: 0.25, pitch: 0.75, dist: 1750 };

export interface EniacPose { d: Decades; /** a pulse was just applied (the input wire lit) */ pulsing: boolean }

/** The "1" triode of a stage is section 2 (x = XB), the "0" triode section 1 (XA): which is which is drawn. */
export const sectionX = (holds: boolean): number => (holds ? XB : XA);

export function eniacModel(p: EniacPose, detail: Detail = 'full'): Model3 {
  const T = sixSN7(detail), U = unitGeos(detail), items: Item[] = [];
  const ny = NEON_Y - 2 - CHASSIS_H / 2, ty = CHASSIS_H / 2 + 3;
  for (let k = 0; k < DECADES; k++) {
    const y = decadeY(k), z = decadeZ(k), grp = k === 0 ? 'units decade' : 'tens decade', digit = p.d.digits[k];
    items.push({ geo: U.chassis, mat: enamel, at: [0, y, z], name: 'decade unit', group: grp, info: { dim: `${UNIT_L} mm long`, source: SRC.si, note: 'a plug-in unit: one decimal digit of an accumulator. Its depth, layout and paint are drawn' } });
    items.push({ geo: U.front, mat: panelMat, at: [0, y, z + UNIT_D / 2 + 1.5], name: 'front panel', group: grp, info: { source: SRC.ord, note: 'the neons and the digits 0–9 under them: the panel an operator read the accumulator from' } });
    items.push({ geo: U.digits, mat: ink, at: [0, y, z], name: 'digits 0–9', group: grp });
    items.push({ geo: U.sockets, mat: M.bakelite, at: [0, y, z], name: 'octal socket', group: grp, info: { source: SRC.tube, note: 'the 6SN7 plugs in: a dead tube was a minute\'s swap' } });
    items.push({ geo: U.plug, mat: plugMat, at: [0, y, z], name: 'plug', group: grp, info: { source: SRC.drawn, note: 'the unit plugged into the accumulator\'s frame; its pins carry the pulses, the carry and the supplies (drawn)' } });
    items.push({ geo: U.plugPins, mat: M.nickel, at: [0, y, z], name: 'plug', group: grp });
    items.push({ geo: U.back, mat: dimGlass, at: [0, y, z], name: 'the digit\'s other tubes', group: grp, info: { dim: `${OTHER_TUBES} more tubes`, source: SRC.wiki, note: 'the pulse standardizer, the carry and the output transmitters: drawn as plain dim bulbs so the ring leads' } });
    items.push({ geo: U.backBases, mat: M.bakelite, at: [0, y, z], name: 'the digit\'s other tubes', group: grp });
    for (let s = 0; s < STAGES; s++) {
      const x = stageX(s), on = s === digit;
      for (const part of T.parts) items.push({ geo: part.geo, mat: part.mat, at: [x, y + ty, z + RING_Z], name: `6SN7: stage ${s}`, group: grp, info: part === T.parts[0] ? { dim: 'T-9 bulb, 28.6 mm', source: SRC.tube, note: on ? `stage ${s} holds the digit: its "1" triode conducts, the other is cut off` : `stage ${s}: its "0" triode conducts; one Eccles–Jordan flip-flop, the bulb of step 5` } : undefined });
      items.push({ geo: U.heat, mat: heatMat, at: [x, y + ty, z + RING_Z], name: `6SN7: stage ${s}`, group: grp, shadow: false, cut: 'none' });
      items.push({ geo: U.cloud, mat: on ? cond1 : cond0, at: [x + sectionX(on), y + ty, z + RING_Z], name: `6SN7: stage ${s}`, group: grp, shadow: false, cut: 'none' });
      items.push({ geo: U.neonCap, mat: M.nickel, at: [x, y + ny, z + UNIT_D / 2 + 3], rot: [Math.SQRT1_2, 0, 0, Math.SQRT1_2], name: `neon: stage ${s}`, group: grp });
      if (on) items.push({ geo: U.halo, mat: haloMat, at: [x, y + ny, z + UNIT_D / 2 + 14], name: `neon: stage ${s}`, group: grp, shadow: false });
      items.push({ geo: U.neon, mat: on ? neonOn : neonOff, at: [x, y + ny, z + UNIT_D / 2 + 7], rot: [Math.SQRT1_2, 0, 0, Math.SQRT1_2], name: `neon: stage ${s}`, group: grp, info: { source: SRC.ord, note: on ? 'lit: this flip-flop is the one in the "1" state' : 'dark: this flip-flop holds 0' } });
    }
  }
  // the counting pulse into the units, and the carry from the units' ninth stage back and up to the tens
  const left = -UNIT_L / 2 - 50, top = CHASSIS_H / 2 + 6, rz = RING_Z, y1 = decadeY(1) + top, z1 = decadeZ(1) + RING_Z;
  items.push({ geo: tube([[left - 120, top, rz], [left, top, rz], [stageX(0) - 30, top, rz]], 2.2, { sides: 8, bend: 10 }), mat: p.pulsing ? wireOn : wireOff, name: 'counting pulse', group: 'pulses', info: { source: SRC.ord, note: '"reception of a pulse at the input side advanced the counter by one stage"' } });
  const r = UNIT_L / 2 + 40, x9 = stageX(STAGES - 1) + 30;
  items.push({ geo: tube([[x9, top, rz], [r, top, rz], [r, y1, z1], [x9, y1, z1], [stageX(0) - 30, y1, z1]], 2.2, { sides: 8, bend: 14 }), mat: p.d.carried[1] && p.pulsing ? wireOn : wireOff, name: 'carry', group: 'pulses', info: { source: SRC.ord, note: '"when any ring passed the nine positions, a pulse was passed to the next ring in the series"' } });
  return { items, anchors: anchors(p), beats: beats(), floor: -CHASSIS_H / 2 - 2 };
}

const up: Vec3 = [0, 1, 0], front: Vec3 = [0, 0, 1];
function anchors(p: EniacPose): StudioAnchor[] {
  const a: StudioAnchor[] = [];
  const ny = NEON_Y - 2 - CHASSIS_H / 2;
  for (let k = 0; k < DECADES; k++) {
    const y = decadeY(k), z = decadeZ(k);
    a.push({ text: k === 0 ? 'units decade' : 'tens decade', p: [-UNIT_L / 2, y, z + UNIT_D / 2], side: 'l', n: front, gutter: 'l' });
    a.push({ text: `neon: ${p.d.digits[k]}`, p: [stageX(p.d.digits[k]), y + ny, z + UNIT_D / 2 + 20], side: 'b', n: front, minor: k > 0 });
  }
  a.push({ text: '6SN7: one flip-flop', p: [stageX(p.d.digits[0]), CHASSIS_H / 2 + 75, RING_Z], side: 't', n: up });
  a.push({ text: 'carry to the tens', p: [UNIT_L / 2 + 40, decadeY(1) / 2, decadeZ(1) / 2 + RING_Z], side: 'r', n: front, gutter: 'r' });
  a.push({ text: 'counting pulse', p: [-UNIT_L / 2 - 170, CHASSIS_H / 2 + 6, RING_Z], side: 'l', n: up, minor: true });
  a.push({ text: 'plug', p: [-UNIT_L / 2 - 30, 0, 0], side: 'b', n: up, minor: true });
  a.push({ text: 'the digit\'s other tubes', p: [-UNIT_L / 2 + 50, CHASSIS_H / 2 + 50, BACK_Z], side: 't', n: up, minor: true });
  return a;
}

function beats(): Beat[] {
  return [
    { title: 'A decimal digit', text: `A plug-in decade unit of an ENIAC accumulator: ten 6SN7 twin triodes in a row, their heaters glowing, a neon under each. One neon is lit: the digit. The tens decade stands behind.`, view: ENIAC_HOME, cut: 0, explode: 0 },
    { title: 'Each bulb is step 5\'s flip-flop', text: 'Each 6SN7 is two triodes cross-coupled, one conducting and one cut off: one bit, the Eccles–Jordan of the step before. The glow between the plates marks the conducting half (drawn): the left half in nine tubes, the right half in the one that holds the digit.', view: { target: [stageX(4), 50, RING_Z], yaw: 0.25, pitch: 0.28, dist: 420 }, cut: 0, explode: 0 },
    { title: 'A pulse moves the ring', text: 'A counting pulse at the input flips the stage that holds the digit back to 0 and the next one to 1: the lit neon and the right-hand glow move one place along.', view: { target: [0, 30, UNIT_D / 2], yaw: 0.12, pitch: 0.12, dist: 1000 }, frame: ['units decade'], cut: 0, explode: 0 },
    { title: 'Nine to zero carries', text: 'When the ring passes nine it sends one pulse to the next decade: the tens step once while the units start again at 0. Twenty accumulators did this, ten digits each.', view: ENIAC_TOP, cut: 0, explode: 0 },
    { title: 'What a digit costs', text: `A digit is ${STAGES} twin triodes in the ring (${RING_TRIODES} triodes) and ${TUBES_PER_DIGIT} tubes with its standardizer, carry and transmitters (the dim row behind). ${ACCUMULATORS} accumulators of ${DIGITS} digits: ${ACCUMULATORS * DIGITS * TUBES_PER_DIGIT} tubes in counting alone.`, view: { ...ENIAC_HOME, yaw: -0.5, pitch: 0.35, dist: 1300 }, cut: 0, explode: 0 },
  ];
}
export { PITCH };
