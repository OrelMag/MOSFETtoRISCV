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
import { tubeModel } from './triode3dkit';
import { stateAt } from './triode3dview';
import {
  ACCUMULATORS, BACK_Z, CHASSIS_H, DECADES, DIGITS, NEON_Y, OTHER_TUBES, PITCH, RING_TRIODES, RING_Z, STAGES, TUBES_PER_DIGIT, UNIT_D, UNIT_L,
  decadeY, stageX, type Decades,
} from './eniac3dgeom';

type Detail = 'full' | 'flat';
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
    const m = tubeModel(stateAt(0, 1), { charge: false, detail: 'flat', electron: M.copper }), by = new Map<string, { geos: Geo[]; mat: Material }>(), mtx = new Float32Array(16);
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
interface UnitGeos { halo: Geo; chassis: Geo; front: Geo; digits: Geo; back: Geo; backBases: Geo; neon: Geo; neonCap: Geo; sockets: Geo }
const units = new Map<Detail, UnitGeos>();
function unitGeos(d: Detail): UnitGeos {
  const hit = units.get(d);
  if (hit) return hit;
  const seg = d === 'full' ? 28 : 8, frontZ = UNIT_D / 2;
  const bulb = lathe([[0, 0], [11, 0], [11, 40], [7, 46], [0, 47]], { seg }), base = lathe([[0, 0], [12, 0], [12, 11], [0, 11]], { seg });
  // the digit's other 26 tubes: two staggered rows behind the ring
  const others = Array.from({ length: OTHER_TUBES }, (_, i) => { const row = i % 2, k = Math.floor(i / 2), x = -UNIT_L / 2 + 50 + k * ((UNIT_L - 100) / 12); return [x, BACK_Z - row * 40] as [number, number]; });
  const g: UnitGeos = {
    chassis: roundedBox(UNIT_L, CHASSIS_H, UNIT_D, 2, 1),
    front: roundedBox(UNIT_L, CHASSIS_H + 20, 3, 1, 1),
    digits: merge(Array.from({ length: STAGES }, (_, s) => strokeGeo(String(s), onPlane([0, 0, frontZ + 1.6], [1, 0, 0], [0, 1, 0], [0, 0, 1]), stageX(s), NEON_Y - 2 - CHASSIS_H / 2 - 22, 16)), 'digits'),
    halo: sphere(16, d === 'full' ? 24 : 8, d === 'full' ? 12 : 4),
    back: merge(others.map(([x, z]) => at3(bulb, x, CHASSIS_H / 2 + 11, z)), 'other tubes'),
    backBases: merge(others.map(([x, z]) => at3(base, x, CHASSIS_H / 2, z)), 'other tubes'),
    neon: lathe([[0, 0], [3.3, 0], [3.3, 13], [2.2, 17], [0, 18]], { seg: d === 'full' ? 20 : 8 }),
    neonCap: lathe([[0, 0], [4.2, 0], [4.2, 4], [0, 4]], { seg: d === 'full' ? 20 : 8 }),
    sockets: merge(Array.from({ length: STAGES }, (_, s) => at3(lathe([[0, 0], [17, 0], [17, 3], [0, 3]], { seg: d === 'full' ? 24 : 8 }), stageX(s), CHASSIS_H / 2, RING_Z)), 'sockets'),
  };
  units.set(d, g);
  return g;
}

// ---------------------------------------------------------------- materials

const enamel = M.make({ base: [0.33, 0.35, 0.36], metal: 0.3, rough: 0.45, coat: 0.3, label: 'chassis, painted steel' });
const panelMat = M.make({ base: [0.16, 0.17, 0.18], metal: 0.1, rough: 0.5, label: 'front panel' });
const ink = M.make({ base: [0.92, 0.9, 0.84], metal: 0, rough: 0.6, label: 'engraved digit' });
const neonOff = M.make({ base: [0.75, 0.72, 0.66], metal: 0, rough: 0.1, transmit: 0.6, tint: [0.95, 0.9, 0.85], label: 'neon lamp, off' });
const neonOn = M.glow(M.make({ base: [1.0, 0.45, 0.15], metal: 0, rough: 0.2, label: 'neon lamp, lit: this stage holds the digit' }), [1.0, 0.42, 0.12], 4);
/** The lit neon's glow, drawn far wider than the lamp so it reads at the unit's scale (a cue, not a part). */
const haloMat = M.glow(M.make({ base: [1.0, 0.5, 0.2], metal: 0, rough: 0.5, transmit: 0.75, tint: [1, 0.6, 0.3], label: 'glow of the lit neon (drawn wide)' }), [1.0, 0.45, 0.15], 1.2);
const wireOff = M.make({ base: [0.5, 0.36, 0.3], metal: 0.2, rough: 0.5, label: 'pulse wire' });
const wireOn = M.glow(M.make({ base: [1.0, 0.55, 0.2], metal: 0, rough: 0.3, label: 'a pulse' }), [1.0, 0.5, 0.18], 1.4);

// ---------------------------------------------------------------- the model

export const ENIAC_HOME: OrbitView = { target: [0, 150, 0], yaw: 0.22, pitch: 0.16, dist: 1500 };

export interface EniacPose { d: Decades; /** a pulse was just applied (the input wire lit) */ pulsing: boolean }

export function eniacModel(p: EniacPose, detail: Detail = 'full'): Model3 {
  const T = sixSN7(detail), U = unitGeos(detail), items: Item[] = [];
  for (let k = 0; k < DECADES; k++) {
    const y = decadeY(k), grp = k === 0 ? 'units decade' : 'tens decade', digit = p.d.digits[k];
    items.push({ geo: U.chassis, mat: enamel, at: [0, y, 0], name: 'decade unit', group: grp, info: { dim: `${UNIT_L} mm long`, source: SRC.si, note: 'a plug-in unit: one decimal digit of an accumulator. The depth and the layout are drawn' } });
    items.push({ geo: U.front, mat: panelMat, at: [0, y, UNIT_D / 2 + 1.5], name: 'decade unit', group: grp });
    items.push({ geo: U.digits, mat: ink, at: [0, y, 0], name: 'digits 0–9', group: grp });
    items.push({ geo: U.sockets, mat: M.bakelite, at: [0, y, 0], name: 'octal socket', group: grp });
    items.push({ geo: U.back, mat: M.glass, at: [0, y, 0], name: 'the digit\'s other tubes', group: grp, info: { dim: `${OTHER_TUBES} more tubes`, source: SRC.wiki, note: 'the pulse standardizer, the carry and the output transmitters: drawn as plain bulbs' } });
    items.push({ geo: U.backBases, mat: M.bakelite, at: [0, y, 0], name: 'the digit\'s other tubes', group: grp });
    for (let s = 0; s < STAGES; s++) {
      const x = stageX(s), on = s === digit;
      for (const part of T.parts) items.push({ geo: part.geo, mat: part.mat, at: [x, y + CHASSIS_H / 2 + 3, RING_Z], name: `6SN7: stage ${s}`, group: grp, info: part === T.parts[0] ? { dim: 'T-9 bulb, 28.6 mm', source: SRC.tube, note: on ? `stage ${s} holds the digit: its "1" triode conducts, the other is cut off` : `stage ${s}: its "0" triode conducts; one Eccles–Jordan flip-flop, the bulb of step 5` } : undefined });
      items.push({ geo: U.neonCap, mat: M.nickel, at: [x, y + NEON_Y - 2 - CHASSIS_H / 2, UNIT_D / 2 + 3], rot: [Math.SQRT1_2, 0, 0, Math.SQRT1_2], name: `neon: stage ${s}`, group: grp });
      if (on) items.push({ geo: U.halo, mat: haloMat, at: [x, y + NEON_Y - 2 - CHASSIS_H / 2, UNIT_D / 2 + 14], name: `neon: stage ${s}`, group: grp, shadow: false });
      items.push({ geo: U.neon, mat: on ? neonOn : neonOff, at: [x, y + NEON_Y - 2 - CHASSIS_H / 2, UNIT_D / 2 + 7], rot: [Math.SQRT1_2, 0, 0, Math.SQRT1_2], name: `neon: stage ${s}`, group: grp, info: { source: SRC.ord, note: on ? 'lit: this flip-flop is the one in the "1" state' : 'dark: this flip-flop holds 0' } });
    }
  }
  // the counting pulse into the units, and the carry from the units' ninth stage up to the tens
  const left = -UNIT_L / 2 - 30, top = CHASSIS_H / 2 + 6;
  items.push({ geo: tube([[left - 120, top, RING_Z], [left, top, RING_Z], [stageX(0) - 30, top, RING_Z]], 2.2, { sides: 8, bend: 10 }), mat: p.pulsing ? wireOn : wireOff, name: 'counting pulse', group: 'pulses', info: { source: SRC.ord, note: '"reception of a pulse at the input side advanced the counter by one stage"' } });
  const r = UNIT_L / 2 + 40, x9 = stageX(STAGES - 1) + 30;
  items.push({ geo: tube([[x9, top, RING_Z], [r, top, RING_Z], [r, decadeY(1) + top, RING_Z], [x9, decadeY(1) + top, RING_Z], [stageX(0) - 30, decadeY(1) + top, RING_Z]], 2.2, { sides: 8, bend: 14 }), mat: p.d.carried[1] && p.pulsing ? wireOn : wireOff, name: 'carry', group: 'pulses', info: { source: SRC.ord, note: '"when any ring passed the nine positions, a pulse was passed to the next ring in the series"' } });
  return { items, anchors: anchors(p), beats: beats(), floor: -CHASSIS_H / 2 - 2 };
}

const up: Vec3 = [0, 1, 0], front: Vec3 = [0, 0, 1];
function anchors(p: EniacPose): StudioAnchor[] {
  const a: StudioAnchor[] = [];
  for (let k = 0; k < DECADES; k++) {
    const y = decadeY(k);
    a.push({ text: k === 0 ? 'units decade' : 'tens decade', p: [-UNIT_L / 2, y, UNIT_D / 2], side: 'l', n: front, gutter: 'l' });
    a.push({ text: `neon: ${p.d.digits[k]}`, p: [stageX(p.d.digits[k]), y + NEON_Y - 2 - CHASSIS_H / 2, UNIT_D / 2 + 20], side: 'b', n: front });
  }
  a.push({ text: '6SN7: one flip-flop', p: [stageX(6), CHASSIS_H / 2 + 70, RING_Z], side: 't', n: up });
  a.push({ text: 'carry to the tens', p: [UNIT_L / 2 + 40, decadeY(1) / 2, RING_Z], side: 'r', n: front, gutter: 'r' });
  a.push({ text: 'counting pulse', p: [-UNIT_L / 2 - 150, CHASSIS_H / 2 + 6, RING_Z], side: 'l', n: up, minor: true });
  a.push({ text: 'the digit\'s other tubes', p: [-UNIT_L / 2 + 50, CHASSIS_H / 2 + 50, BACK_Z], side: 't', n: up, minor: true });
  return a;
}

function beats(): Beat[] {
  return [
    { title: 'A decimal digit', text: `A plug-in decade unit of an ENIAC accumulator: ten 6SN7 twin triodes in a row, a neon under each. One neon is lit: the digit. Two units, units and tens, one above the other.`, view: ENIAC_HOME, frame: [], cut: 0, explode: 0 },
    { title: 'Each bulb is step 5\'s flip-flop', text: 'Each 6SN7 is two triodes cross-coupled, one conducting and one cut off: one bit, the Eccles–Jordan of the step before. Ten of them make a ring in which exactly one is in its "1" state.', view: { target: [stageX(4), 70, RING_Z], yaw: 0.35, pitch: 0.25, dist: 420 }, frame: ['6SN7: stage 4'], cut: 0, explode: 0 },
    { title: 'A pulse moves the ring', text: 'A counting pulse at the input flips the stage that holds the digit back to 0 and the next one to 1: the lit neon moves one place along.', view: { target: [0, 20, UNIT_D / 2], yaw: 0.1, pitch: 0.15, dist: 900 }, frame: ['units decade'], cut: 0, explode: 0 },
    { title: 'Nine to zero carries', text: 'When the ring passes nine it sends one pulse to the next decade: the tens step once while the units start again at 0. Twenty accumulators did this, ten digits each.', view: { target: [UNIT_L / 2 - 120, decadeY(1) / 2, RING_Z], yaw: 0.6, pitch: 0.2, dist: 700 }, frame: ['carry'], cut: 0, explode: 0 },
    { title: 'What a digit costs', text: `A digit is ${STAGES} twin triodes in the ring (${RING_TRIODES} triodes) and ${TUBES_PER_DIGIT} tubes with its standardizer, carry and transmitters. ${ACCUMULATORS} accumulators of ${DIGITS} digits: ${ACCUMULATORS * DIGITS * TUBES_PER_DIGIT} tubes in counting alone.`, view: { ...ENIAC_HOME, yaw: -0.4, pitch: 0.45 }, frame: [], cut: 0, explode: 0 },
  ];
}
export { PITCH };
