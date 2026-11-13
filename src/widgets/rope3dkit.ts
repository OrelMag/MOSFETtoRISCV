// Core rope on the studio renderer (DOM-free, tested): rope3dgeom.ts's rules in true shapes. The close-up: eight cores,
// each a ring of permalloy ribbon wound on a steel bobbin, with the sense, inhibit, set and reset wires running straight
// through the holes they thread and looping round the cores they pass by; the cut opens the cores along their axis so
// the wires in the holes show. The module: 512 cores in two layers of 32 × 8 with the cordwood selection parts.
//
// 1 unit = 0.25 mm (rope3dgeom.ts UNIT_MM).

import { lathe, merge, roundedBox, transform, tube, type Geo } from '../gl/kit/geo';
import { M, type Material } from '../gl/kit/materials';
import type { Beat, Item, Model3, StudioAnchor } from '../gl/kit/scene';
import type { OrbitView } from '../gl/camera';
import type { Vec3 } from '../gl/math';
import {
  BITS, CORE_R, CORES, CY, CZ, HOLE_R, LAYER_COLS, LAYER_ROWS, LEN, MODULE_BOX, MOD_X, MOD_Z, OUTSIDE, PITCH, SLOT,
  WIRES, at, coreX, moduleCores, modD, slotAngle, switching, threads, wireLive, wirePath, type RopePose,
} from './rope3dgeom';

type Detail = 'full' | 'flat';
const SRC = {
  r700: 'R-700 vol. III (MIT Instrumentation Laboratory, 1972), sec. 3.5.2',
  shirriff: 'Ken Shirriff, "Software woven into wire" (2019): permalloy ribbon on a steel bobbin, 0.249 in',
  guess: 'not sourced: drawn as a guess',
};

// ---------------------------------------------------------------- shapes

/** A 4 × 4 matrix turning y into x (a lathe's axis along the cores' axis), then moving by (dx, dy, dz). */
function alongX(dx: number, dy: number, dz: number): Float32Array {
  const m = new Float32Array(16);
  m[1] = -1; m[4] = 1; m[10] = 1; m[15] = 1; m[12] = dx; m[13] = dy; m[14] = dz;
  return m;
}
/** The bobbin's hub inside the ribbon and its two flanges (assumed sizes); the ribbon wound between the flanges. */
const HUB_IN = HOLE_R - 0.6, FLANGE = 0.5, FLANGE_R = CORE_R + 0.5;
interface Geos { ribbon: Geo; bobbin: Geo; post: Geo; board: Geo; amp: Geo; lamp: Geo; modBoard: Geo; modCores: Geo; modSel: Geo; res: Geo; diodes: Geo }
const memo = new Map<Detail, Geos>();
function geos(d: Detail): Geos {
  const hit = memo.get(d);
  if (hit) return hit;
  const seg = d === 'full' ? 48 : 14, h = LEN / 2;
  // a lathe about y, from y = -h to h; turned onto x
  const ribbonLathe = lathe([[HOLE_R, -h + FLANGE], [CORE_R, -h + FLANGE], [CORE_R, h - FLANGE], [HOLE_R, h - FLANGE]], { seg, crease: 30 });
  const bobbinLathe = lathe([[HUB_IN, -h], [FLANGE_R, -h], [FLANGE_R, -h + FLANGE], [HOLE_R, -h + FLANGE], [HOLE_R, h - FLANGE], [FLANGE_R, h - FLANGE], [FLANGE_R, h], [HUB_IN, h]], { seg, crease: 30 });
  const box = (w: number, hh: number, dd: number, r: number) => roundedBox(w, hh, dd, r, 2);
  const cores = moduleCores(), first = LAYER_COLS * LAYER_ROWS;
  const core = lathe([[HOLE_R, -h], [CORE_R, -h], [CORE_R, h], [HOLE_R, h]], { seg: d === 'full' ? 20 : 8, crease: 30 });
  const coreAt = (q: Vec3) => transform(core, alongX(q[0], q[1], q[2]));
  const B = MODULE_BOX, rz = (side: number) => MOD_Z + side * (modD / 2 + 50);
  const cordwood = (pick: (i: number) => boolean, r: number) => merge([-1, 1].flatMap((side) => Array.from({ length: 64 }, (_, i) => i).filter(pick).map((i) => {
    const x = B.x0 + 30 + i * ((B.x1 - B.x0 - 60) / 63), body = lathe([[0, 0], [r, 0], [r, 40], [0, 40]], { seg: 10 });
    const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; m[12] = x; m[14] = rz(side);
    return transform(body, m);
  })), 'cordwood');
  const g: Geos = {
    ribbon: transform(ribbonLathe, alongX(0, 0, 0)),
    bobbin: transform(bobbinLathe, alongX(0, 0, 0)),
    post: lathe([[0, 0], [0.9, 0], [0.9, CY - FLANGE_R], [0, CY - FLANGE_R]], { seg: 12 }),
    board: box(coreX(CORES - 1) - coreX(0) + 2 * PITCH + 50, 4, CORE_R * 4, 0.8),
    amp: box(6, 6, 6, 0.6),
    lamp: lathe([[0, 0], [2, 0], [2, 1.5], ...Array.from({ length: 6 }, (_, k) => { const a = ((k + 1) / 6) * (Math.PI / 2); return [2 * Math.cos(a), 1.5 + 2 * Math.sin(a)] as [number, number]; })], { seg: 20 }),
    modBoard: box(B.x1 - B.x0, 6, B.z1 - B.z0, 2),
    modCores: merge(cores.filter((_, i) => i < first || i >= first + CORES).map(coreAt), 'cores'),
    modSel: merge(cores.slice(first, first + CORES).map(coreAt), 'the eight cores'),
    res: cordwood((i) => i % 3 !== 2, 3),
    diodes: cordwood((i) => i % 3 === 2, 3),
  };
  memo.set(d, g);
  return g;
}
const wireGeos = new Map<string, Geo>();
function wireGeo(i: number, r: number, d: Detail): Geo {
  const key = `${i},${r},${d}`;
  let g = wireGeos.get(key);
  if (!g) { g = tube(wirePath(i), r, { sides: d === 'full' ? 8 : 4, bend: 0.8 }); wireGeos.set(key, g); }
  return g;
}

// ---------------------------------------------------------------- materials

const permalloy = M.make({ base: [0.55, 0.54, 0.52], metal: 1, rough: 0.42, label: 'permalloy ribbon, wound' });
const bobbinMat = M.make({ base: [0.72, 0.73, 0.75], metal: 1, rough: 0.3, label: 'non-magnetic stainless steel bobbin' });
const boardMat = M.make({ base: [0.24, 0.21, 0.16], metal: 0, rough: 0.6, label: 'the frame the cores are held in (drawn)' });
const LIVE = '--rp-live';
const wireMat = (base: string, label: string, live: boolean, dim: boolean): Material => {
  const m = M.make({ base: dim ? '--rp-dim' : (base as `--${string}`), metal: 0, rough: 0.35, coat: 0.5, label });
  return live ? M.glow({ ...m, base: LIVE }, LIVE, 0.9) : m;
};

// ---------------------------------------------------------------- the model

export const ROPE_HOME: Record<'close' | 'module', OrbitView> = {
  close: { target: [coreX(3.2), CY - 2, 0], yaw: 0.95, pitch: 0.36, dist: 210 },
  module: { target: [MOD_X, 20, MOD_Z], yaw: 0.4, pitch: 0.75, dist: 1000 },
};
/** The cut: a plane through the cores' axis, taking the half toward the viewer off the cores and bobbins only. */
export const AXIS_CUT = CZ;
const CUT: Model3['cuts'] = { planes: [{ n: [0, 0, 1], d: AXIS_CUT }], open: [CORE_R + 4] };

function closeItems(p: RopePose, d: Detail): Item[] {
  const G = geos(d), sw = new Set(switching(p.phase, p.addr)), items: Item[] = [];
  items.push({ geo: G.board, mat: boardMat, at: [(coreX(0) + coreX(CORES - 1)) / 2 + 25, -2, CZ], name: 'frame', group: 'frame', cut: 'none', info: { source: SRC.guess } });
  for (let c = 0; c < CORES; c++) {
    const on = sw.has(c), sel = c === p.addr;
    const ribbon: Material = on ? M.glow(permalloy, LIVE, 0.8) : sel ? M.tint(permalloy, [0.78, 0.66, 0.42], 'permalloy ribbon: the addressed core') : permalloy;
    items.push({ geo: G.ribbon, mat: ribbon, at: [coreX(c), CY, CZ], name: `core ${c}`, group: 'cores', info: { dim: '0.249 in across (6.3 mm)', source: SRC.shirriff, note: on ? 'switching: the only core no inhibit current holds back' : 'a magnetic core: switched by the set current, back by the reset, and only if no inhibit wire through it carries current' } });
    items.push({ geo: G.bobbin, mat: bobbinMat, at: [coreX(c), CY, CZ], name: `core ${c}`, group: 'cores', info: { note: 'the bobbin: its hole and length are a guess (not sourced)' } });
    items.push({ geo: G.post, mat: bobbinMat, at: [coreX(c), 0, CZ - CORE_R - 6], name: 'post', group: 'frame', cut: 'none' });
  }
  WIRES.forEach((w, i) => {
    const live = wireLive(i, p), dim = w.kind === 'sense' && w.strand !== p.strand;
    const [base, label] = w.kind === 'sense' ? ['--rp-copper', `sense wire ${w.bit}, strand ${w.strand}`] : w.kind === 'inhibit' ? ['--rp-inhibit', `inhibit pair ${w.k}, half ${w.h}`] : w.kind === 'set' ? ['--rp-set', 'set wire'] : ['--rp-reset', 'reset wire'];
    const note = w.kind === 'sense' ? 'through a core where its word has a 1, round it where it has a 0' : w.kind === 'inhibit' ? 'threads the cores whose address bit is this half: driven, it holds them back from switching' : w.kind === 'set' ? 'through every core: tries to switch all of them' : 'through every core: switches back the one that was set';
    items.push({ geo: wireGeo(i, live ? 0.8 : 0.6, d), mat: wireMat(base, label, live, dim), name: w.kind === 'sense' ? 'sense wire' : w.kind === 'inhibit' ? 'inhibit wire' : `${w.kind} wire`, group: w.kind === 'sense' ? `strand ${w.strand}` : 'drive', cut: 'none', info: { source: SRC.r700, note } });
  });
  for (let b = 0; b < BITS; b++) {
    const on = p.phase === 'reset' && threads(p.strand, b, p.addr), x = coreX(CORES - 1) + PITCH * 0.75 + 14, z = (b - (BITS - 1) / 2) * 8;
    items.push({ geo: G.amp, mat: M.epoxy, at: [x, 3, z], name: 'sense amplifier', group: 'amps', cut: 'none', info: { source: SRC.r700, note: 'gated during the reset: a pulse on its wire reads as a 1' } });
    items.push({ geo: G.lamp, mat: on ? M.glow(M.make({ base: LIVE, metal: 0, rough: 0.2, label: 'lamp, lit' }), LIVE, 1.4) : M.make({ base: '--rp-lamp-off', metal: 0, rough: 0.3, coat: 0.5, label: 'lamp' }), at: [x, 6, z], name: 'sense amplifier', group: 'amps', cut: 'none' });
  }
  return items;
}

function moduleItems(d: Detail): Item[] {
  const G = geos(d);
  return [
    { geo: G.modBoard, mat: boardMat, at: [(MODULE_BOX.x0 + MODULE_BOX.x1) / 2, -3, (MODULE_BOX.z0 + MODULE_BOX.z1) / 2], name: 'module frame', group: 'module', info: { source: SRC.guess, note: 'the module\'s outline follows from the guessed 8 mm pitch' } },
    { geo: G.modCores, mat: permalloy, name: 'cores', group: 'module', info: { dim: '512 cores, two layers of 32 × 8', source: SRC.shirriff, note: 'electrically four planes of 128' } },
    { geo: G.modSel, mat: M.glow(permalloy, LIVE, 0.6), name: 'the eight cores of the close-up', group: 'module' },
    { geo: G.res, mat: M.make({ base: '--rp-res', metal: 0, rough: 0.5, label: 'selection resistor' }), name: 'cordwood resistors and diodes', group: 'module', info: { source: SRC.shirriff, note: 'cordwood: parts stood upright between two boards, along both sides of the cores' } },
    { geo: G.diodes, mat: M.make({ base: '--rp-diode', metal: 0.3, rough: 0.4, label: 'selection diode' }), name: 'cordwood resistors and diodes', group: 'module' },
  ];
}

const up: Vec3 = [0, 1, 0];
function anchors(p: RopePose): StudioAnchor[] {
  if (p.module) return [
    { text: 'a module: 512 cores', p: [MOD_X, 45, MOD_Z], side: 't', n: up },
    { text: 'the eight cores', p: moduleCores()[LAYER_COLS * LAYER_ROWS + 3], side: 'b', n: up },
    { text: 'cordwood selection parts', p: [MODULE_BOX.x0 + 40, 40, MOD_Z + modD / 2 + 50], side: 'l', n: up, minor: true },
  ];
  const through = WIRES.findIndex((w) => w.kind === 'sense' && w.strand === p.strand && threads(w.strand, w.bit, 4));
  const around = WIRES.findIndex((w) => w.kind === 'sense' && w.strand === p.strand && !threads(w.strand, w.bit, 3));
  return [
    { text: 'permalloy core', p: at(coreX(6), CORE_R, Math.PI * 0.35), side: 't', n: up },
    { text: 'through the core: 1', p: at(coreX(4) + LEN, SLOT, slotAngle(Math.max(0, through))), side: 'b', n: up },
    { text: 'round the core: 0', p: at(coreX(3), OUTSIDE, slotAngle(Math.max(0, around))), side: 'r', n: up },
    { text: 'inhibit wires', p: wirePath(WIRES.findIndex((w) => w.kind === 'inhibit'))[0], side: 'l', n: up, minor: true },
    { text: 'sense amplifiers', p: [coreX(CORES - 1) + PITCH * 0.75 + 14, 9, 0], side: 'r', n: up, minor: true },
  ];
}

function beats(p: RopePose): Beat[] {
  const H = ROPE_HOME[p.module ? 'module' : 'close'];
  if (p.module) return [
    { title: 'A rope module', text: '512 cores in two layers of 32 × 8, each core threaded or passed by 192 sense wires: 12 words of 16 bits a core, 6144 words a module, six modules for the Block II\'s 36 864 words of fixed memory.', view: H, frame: ['module'], cut: 0, explode: 0 },
    { title: 'Where the close-up is', text: 'The eight cores the close-up shows are the first eight of the top layer\'s front row; the selection resistors and diodes stand as cordwood along both sides.', view: { target: moduleCores()[LAYER_COLS * LAYER_ROWS + 3], yaw: 0.35, pitch: 0.7, dist: 420 }, frame: ['the eight cores of the close-up'], cut: 0, explode: 0 },
  ];
  return [
    { title: 'Eight cores', text: 'Eight cores of a rope module, spread apart so the wires can be followed. Each is a ring of permalloy ribbon wound on a steel bobbin, 0.249 in across.', view: H, frame: ['cores'], cut: 0, explode: 0 },
    { title: 'A 1 and a 0', text: 'Cut open along the axis: a sense wire runs straight through a core where its word has a 1, and loops round it where it has a 0. The program is in which holes each wire went through, woven by hand.', view: { target: [coreX(3.5), CY, 0], yaw: 0.05, pitch: 0.25, dist: 160 }, frame: ['cores'], cut: 1, explode: 0 },
    { title: 'Inhibit picks a core', text: 'One wire of each inhibit pair threads the cores whose address bit is 0, the other those where it is 1. Driving the member that does not match the address holds back every core but one: three pairs pick one of eight.', view: { target: [coreX(1.5), CY, 0], yaw: 0.5, pitch: 0.3, dist: 180 }, frame: ['drive'], show: ['drive', 'cores'], cut: 0, explode: 0 },
    { title: 'Set, reset, read', text: 'The set current switches the one free core; the reset switches it back, and only the sense wires through it see the pulse. The amplifiers, gated during the reset, light the bits of the word.', view: { target: [coreX(CORES - 1) + PITCH * 0.4, 8, 0], yaw: 0.7, pitch: 0.4, dist: 170 }, frame: ['amps', 'core 7'], cut: 0, explode: 0 },
  ];
}

/** The close-up, or the module (p.module), at a detail ('flat': the SVG fallback). */
export function ropeModel(p: RopePose, detail: Detail = 'full'): Model3 {
  return {
    items: p.module ? moduleItems(detail) : closeItems(p, detail),
    cuts: p.module ? undefined : CUT,
    anchors: anchors(p),
    beats: beats(p),
    floor: p.module ? -6 : -4,
  };
}
