// The diaphragm valve behind the faucet, on the studio renderer (DOM-free; scene units, only ratios matter, y up, the glass
// front at +z). The mechanics are valve3dparts.ts's (a spring-opposed diaphragm: the preload is the threshold, the lift linear in
// the pressure past it). This file draws a pose: each valve's plunger, stem and diaphragm rise by the lift (stage.move), its
// spring is a helix scaled to its length, the water in each chamber is a column scaled to its level, and the gate line's
// pellet runs while the diaphragms move. The gap under the plunger is the channel: its face carries the channel's charge along
// it (a data texture), from the gradual-channel picture of the same MOSFET the faucet uses, so in saturation it fades to
// nothing at the drain end (the pinch-off) while the lift, the gate's doing, stays put. An analogy: no valve hardware beyond
// what the analogy needs (no yoke, travel indicator or cage), as the view's note says.

import { lathe, merge, plane, roundedBox, transform, tube, type Geo } from '../gl/kit/geo';
import { M, type DataTex, type Material } from '../gl/kit/materials';
import type { Beat, Item, Model3, StudioAnchor } from '../gl/kit/scene';
import type { Mat4, Quat, Vec3 } from '../gl/math';
import { CAP_Y, DISC_T, FLOOR, LEVEL_H, SEAT_Y, TRAVEL, WALL_TOP, diaphragmY, springLen, type ValvePose } from './valve3dparts';

type Detail = 'full' | 'flat';
const tr = (p: Vec3): Mat4 => { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; m[12] = p[0]; m[13] = p[1]; m[14] = p[2]; return m; };
/** Translated to p and stretched along y by k (about y = 0 of the geometry). */
const trY = (p: Vec3, k: number): Mat4 => { const m = tr(p); m[5] = Math.max(1e-4, k); return m; };
const bx = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, r = 0): Geo =>
  transform(roundedBox(x1 - x0, y1 - y0, z1 - z0, r, r > 0 ? 2 : 0), tr([(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2]));
const upright = (x: number, z: number, prof: [number, number][], seg: number): Geo => transform(lathe(prof, { seg, crease: 40 }), tr([x, 0, z]));
const cylY = (x: number, y0: number, y1: number, r: number, seg: number, z = 0): Geo => upright(x, z, [[0, y0], [r, y0], [r, y1], [0, y1]], seg);
/** plane() faces +y; a quarter turn about x stands it up facing the front (+z). */
const FACE_FRONT: Quat = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];

// ---------------------------------------------------------------- the channel's charge (gradual channel)

/** The channel's charge per length at s (0 the source … 1 the drain) as a fraction of its value at the source: the
 *  potential V(s) along it solves Vov·V − V²/2 = s · (Vov·Vd − Vd²/2) with Vd = min(Vds, Vov), and the charge is Vov − V(s).
 *  In saturation (Vds ≥ Vov) it is √(1 − s): zero at the drain end, the pinch-off. */
export function channelCharge(vov: number, vds: number, s: number): number {
  if (vov <= 0) return 0;
  const r = Math.min(1, Math.max(0, vds) / vov);
  return Math.sqrt(Math.max(0, 1 - s * (2 * r - r * r)));
}
export const CH_W = 64;
export const newChannelTex = (): DataTex => ({ w: CH_W, h: 2, pixels: new Uint8Array(CH_W * 2 * 4), rev: 0, mode: 'emit', smooth: true });
/** Paint the channel's face: u = 0 the drain (the tank, left) … 1 the source (the basin, right); bright where there is charge,
 *  a deep red where it has pinched off. `k` the brightness (the flow). Emit mode: the shader adds twice the texel. */
export function paintChannel(tex: DataTex, vov: number, vds: number, k: number): void {
  for (let i = 0; i < CH_W; i++) {
    const q = channelCharge(vov, vds, 1 - (i + 0.5) / CH_W), a = 0.15 + 0.85 * k;
    const c = [0.55 * (1 - q) + 0.12 * q, 0.06 * (1 - q) + 0.6 * q, 0.08 * (1 - q) + 0.95 * q].map((v) => Math.round(255 * v * a * (0.25 + 0.75 * Math.max(q, 0.35)) * 0.5));
    for (let j = 0; j < 2; j++) { const o = (j * CH_W + i) * 4; tex.pixels[o] = c[0]; tex.pixels[o + 1] = c[1]; tex.pixels[o + 2] = c[2]; tex.pixels[o + 3] = 255; }
  }
  tex.rev++;
}

// ---------------------------------------------------------------- geometry

interface ValveGeo { seat: Geo; packing: Geo; bonnet: Geo; glass: Geo; pipes: Geo; vent?: Geo; moving: Geo; diaphragm: Geo; plug: Geo }
interface Statics { body: Geo; frontGlass: Geo; ports: Geo; roof: Geo; gateLine: Geo; drops: Geo; valves: ValveGeo[]; column: Geo; fluid: Geo; pellet: Geo; channel: Geo }
const memo = new Map<string, Statics>();
const keyOf = (p: ValvePose, d: Detail) => `${d}:${p.x0}:${p.x1}:${p.valves.map((v) => v.kind + v.cx).join(',')}`;
/** The gate line's ends: past the outermost valves' drop pipes. */
export const gateEnds = (p: ValvePose): [number, number] => [Math.min(...p.valves.map((v) => v.cx - 14.5)) - 4, Math.max(...p.valves.map((v) => v.cx + 14.5))];
export const GATE_Y = 66;

function statics(p: ValvePose, d: Detail): Statics {
  const key = keyOf(p, d), hit = memo.get(key);
  if (hit) return hit;
  const seg = d === 'flat' ? 16 : 48, { x0, x1 } = p, vs = [...p.valves].sort((a, b) => a.cx - b.cx);
  const edges = [x0 + 2, ...vs.flatMap((v) => [v.cx - 10, v.cx + 10]), x1 - 2], roof: Geo[] = [];
  for (let i = 0; i < edges.length; i += 2) if (edges[i + 1] - edges[i] > 0.1) roof.push(bx(edges[i], edges[i + 1], WALL_TOP, WALL_TOP + 2, -10, 10));
  const [g0, g1] = gateEnds(p);
  const valves = p.valves.map((v): ValveGeo => {
    const cx = v.cx, n = v.kind === 'n';
    const bonnet = merge([
      bx(cx - 10, cx - 8, WALL_TOP, CAP_Y + 2, -10, 8), bx(cx + 8, cx + 10, WALL_TOP, CAP_Y + 2, -10, 8), bx(cx - 10, cx + 10, WALL_TOP, CAP_Y + 2, -10, -8),
      bx(cx - 10, cx + 10, CAP_Y, CAP_Y + 2, -10, 10, 0.3), bx(cx - 10, cx - 1.2, WALL_TOP, WALL_TOP + 2, -10, 8), bx(cx + 1.2, cx + 10, WALL_TOP, WALL_TOP + 2, -10, 8),
    ], 'bonnet');
    const pipe = (a: number, b: number, y0: number, y1: number) => bx(a, b, y0, y1, -4, 0);
    const pipes = merge(n ? [pipe(cx + 10, cx + 16, 22, 28)] : [pipe(cx - 16, cx - 10, 46, 52), pipe(cx - 16, cx - 10, 22, 28), pipe(cx - 16, cx - 13, WALL_TOP, 28)], 'pipes');
    // the moving parts at zero lift: the plunger's disc on the seat, the stem, the stem's top plate under the diaphragm
    const moving = merge([upright(cx, 0, [[0, SEAT_Y], [5.5, SEAT_Y], [5.5, SEAT_Y + DISC_T - 0.4], [5.1, SEAT_Y + DISC_T], [0, SEAT_Y + DISC_T]], seg), cylY(cx, SEAT_Y + DISC_T, diaphragmY(0), 0.9, 16), cylY(cx, diaphragmY(0) - 0.6, diaphragmY(0), 3.2, seg)], 'plunger');
    const diaphragm = upright(cx, 0, [[0, diaphragmY(0)], [7.6, diaphragmY(0)], [8, diaphragmY(0) + 0.5], [7.6, diaphragmY(0) + 1], [0, diaphragmY(0) + 1]], seg);
    return {
      seat: bx(cx - 4, cx + 4, FLOOR, SEAT_Y, -8, 8, 0.2), packing: cylY(cx, WALL_TOP, WALL_TOP + 2, 1.25, 16), bonnet,
      glass: bx(cx - 8, cx + 8, WALL_TOP + 2, CAP_Y, 8, 10), pipes, vent: n ? bx(cx + 6, cx + 10, CAP_Y - 5, CAP_Y - 1, 8, 10) : undefined, moving, diaphragm,
      plug: cylY(cx, SEAT_Y - 0.01, SEAT_Y + 0.01, 0.01, 6),
    };
  });
  const drops = merge(vs.map((v) => { const dx = v.kind === 'n' ? v.cx + 13 : v.cx - 13, y1 = v.kind === 'n' ? 25 : 49; return bx(dx - 1.5, dx + 1.5, y1 - 3, GATE_Y + 3, -4, 0); }), 'drops');
  const s: Statics = {
    body: merge([bx(x0, x1, 0, FLOOR, -10, 10, 0.3), bx(x0, x1, FLOOR, WALL_TOP, -10, -8), ...[x0, x1 - 2].flatMap((e) => [bx(e, e + 2, FLOOR, 5, -10, 10), bx(e, e + 2, 12, WALL_TOP, -10, 10)])], 'body'),
    frontGlass: bx(x0, x1, FLOOR, WALL_TOP, 8, 10),
    ports: merge([bx(x0 - 8, x0, 5, 12, -4, 0), bx(x1, x1 + 8, 5, 12, -4, 0)], 'ports'),
    roof: merge(roof, 'roof'), gateLine: bx(g0, g1, GATE_Y - 3, GATE_Y + 3, -4, 0), drops, valves,
    // a unit column (y 0 … 1, scaled by its level) and a unit block of the gate's fluid
    column: bx(-0.5, 0.5, 0, 1, -8, 8), fluid: bx(-8, 8, 0, 1, -8, 8),
    pellet: (() => { const g = lathe([[0, -2.2], [1.5, -2.2], [2.5, -1], [2.5, 1], [1.5, 2.2], [0, 2.2]], { seg: 16 }); return g; })(),
    channel: plane(12, 1),
  };
  memo.set(key, s);
  return s;
}

/** A spring of COILS turns from y = 0 up to its length: rebuilt, never scaled (a scaled helix fattens its wire into a bar).
 *  The point count is the same at any length, so the drawn one is bent in place (refresh). */
export const coilPoints = (len: number, r: number, turns: number, per: number): Vec3[] => { const n = Math.round(turns * per); return Array.from({ length: n + 1 }, (_, i): Vec3 => { const a = (2 * Math.PI * i) / per; return [r * Math.cos(a), (len * i) / n, r * Math.sin(a)]; }); };
export const springGeo = (len: number, d: Detail): Geo => tube(coilPoints(len, 4.5, 3.5, d === 'flat' ? 8 : 24), 0.5, { sides: d === 'flat' ? 4 : 8 });
const springs = new Map<string, Geo>();
/** The drawn spring of valve i (made once, at the first length asked for). */
export function springOf(i: number, d: Detail, len: number): Geo { const k = d + i; let g = springs.get(k); if (!g) { g = springGeo(len, d); springs.set(k, g); } return g; }
export const drawnSpring = (i: number, d: Detail): Geo | undefined => springs.get(d + i);

// ---------------------------------------------------------------- materials

const tint = new Map<number, Material>();
const q8 = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 8) / 8;
export const MATS = {
  body: M.make({ base: [0.36, 0.37, 0.39], metal: 0.5, rough: 0.62, label: 'cast grey iron body (an analogy: no particular valve is drawn)' }),
  glass: M.make({ ...M.glass, transmit: 0.92, label: 'glass front (so the inside shows)' }),
  seat: M.make({ base: [0.8, 0.55, 0.32], metal: 0.9, rough: 0.18, label: 'machined bronze seat' }),
  disc: M.make({ base: [0.78, 0.8, 0.83], metal: 0.9, rough: 0.2, label: 'steel plunger and stem' }),
  diaphragm: M.make({ base: [0.05, 0.05, 0.055], metal: 0, rough: 0.5, coat: 0.3, label: 'black rubber diaphragm' }),
  spring: M.make({ base: [0.6, 0.63, 0.68], metal: 0.95, rough: 0.25, label: 'spring steel' }),
  pipe: M.make({ base: [0.72, 0.45, 0.3], metal: 0.85, rough: 0.35, label: 'copper pipe (cut in half)' }),
  water: M.make({ base: [0.25, 0.55, 0.95], metal: 0, rough: 0.1, transmit: 0.55, tint: [0.35, 0.65, 1], label: 'water' }),
  pellet: M.make({ base: [1, 0.8, 0.3], metal: 0, rough: 0.4, emit: [1, 0.75, 0.25], glow: 0.9, label: 'a slug of the gate’s water: it moves only while the diaphragm does' }),
  /** The gate line's fluid, deeper with its pressure. */
  gate: (g: number): Material => {
    const q = q8(g);
    let m = tint.get(q);
    if (!m) { m = M.make({ base: [0.85, 0.45 + 0.1 * (1 - q), 0.15], metal: 0, rough: 0.15, transmit: 0.75 - 0.4 * q, tint: [1, 0.6, 0.3], label: 'the gate line’s water, deeper with its pressure' }); tint.set(q, m); }
    return m;
  },
  channel: (tex: DataTex): Material => M.make({ base: [0.2, 0.5, 0.9], metal: 0, rough: 0.3, data: tex, label: 'the channel: bright where it holds charge, red where it has pinched off' }),
};

// ---------------------------------------------------------------- the model

export interface ValveScene { pose: ValvePose; channel: DataTex }
export function valveModel(sc: ValveScene, detail: Detail = 'full'): Model3 {
  const p = sc.pose, s = statics(p, detail), single = p.valves.length === 1, items: Item[] = [];
  const gm = MATS.gate(p.g);
  items.push({ geo: s.body, mat: MATS.body, name: 'body', group: 'body' }, { geo: s.roof, mat: MATS.body, name: 'body', group: 'body' });
  items.push({ geo: s.frontGlass, mat: MATS.glass, name: 'glass front', group: 'glass', order: 3, shadow: false });
  items.push({ geo: s.ports, mat: MATS.pipe, name: single ? 'drain: tank' : 'supply', group: 'body' });
  items.push({ geo: s.gateLine, mat: MATS.pipe, name: 'gate line (dead end)', group: 'gate', info: { note: 'a separate pipe, closed at its far end: its water moves only while a diaphragm does' } });
  items.push({ geo: s.drops, mat: MATS.pipe, name: 'gate line (dead end)', group: 'gate' });
  p.valves.forEach((v, i) => {
    const g = s.valves[i], label = single ? '' : v.kind === 'n' ? 'NMOS valve: ' : 'PMOS valve: ';
    items.push({ geo: g.seat, mat: MATS.seat, name: `${label}seat`, group: `body` });
    items.push({ geo: g.packing, mat: MATS.seat, name: `${label}stem seal`, group: 'body' });
    items.push({ geo: g.bonnet, mat: MATS.body, name: `${label}bonnet`, group: 'body' });
    items.push({ geo: g.glass, mat: MATS.glass, name: 'glass front', group: 'glass', order: 3, shadow: false });
    items.push({ geo: g.pipes, mat: MATS.pipe, name: 'gate line (dead end)', group: 'gate' });
    if (g.vent) items.push({ geo: g.vent, mat: MATS.pipe, name: `${label}vent`, group: 'body', info: { note: 'the chamber above the diaphragm is open to the air: ground' } });
    items.push({ geo: g.moving, mat: MATS.disc, name: single ? 'channel: the gap' : `${label}plunger`, group: `lift${i}`, info: { note: 'lifts off its seat by the pressure past the spring’s preload: the gap is the channel' } });
    items.push({ geo: g.diaphragm, mat: MATS.diaphragm, name: single ? 'diaphragm (gate)' : `${label}diaphragm`, group: `lift${i}`, info: { note: v.kind === 'n' ? 'the gate’s water is under it: pressure lifts it' : 'the gate’s water is above it and the supply below: pressure closes it' } });
    items.push({ geo: springOf(i, detail, springLen(v.open * TRAVEL)), mat: MATS.spring, name: single ? 'spring: preload = Vt' : `${label}spring`, group: `spring${i}`, at: [v.cx, 0, 0], shadow: false, info: { note: 'its preload is the threshold: below that pressure nothing moves' } });
    // the gate's water in the chamber: under the diaphragm (NMOS), over it (PMOS, with the supply under it)
    items.push({ geo: s.fluid, mat: v.kind === 'n' ? gm : MATS.water, name: v.kind === 'n' ? 'gate line (dead end)' : `${label}supply`, group: `lower${i}`, at: [v.cx, 0, 0], order: 1, shadow: false });
    if (v.kind === 'p') items.push({ geo: s.fluid, mat: gm, name: 'gate line (dead end)', group: `upper${i}`, at: [v.cx, 0, 0], order: 1, shadow: false });
    // the channel: the water through the gap, its front face the channel's charge
    items.push({ geo: s.channel, mat: MATS.channel(sc.channel), name: single ? 'channel: the gap' : `${label}channel`, group: `chan${i}`, at: [v.cx, 0, 7.9], rot: FACE_FRONT, shadow: false, cut: 'none' });
  });
  // the water in each chamber to its level: left of the first valve, between, right of the last
  const vs = [...p.valves].sort((a, b) => a.cx - b.cx), cols: [number, number, string][] = [[p.x0 + 2, vs[0].cx - 4, 'left'], ...vs.slice(0, -1).map((v, i): [number, number, string] => [v.cx + 4, vs[i + 1].cx - 4, `mid${i}`]), [vs[vs.length - 1].cx + 4, p.x1 - 2, 'right']];
  for (const [a, b, k] of cols) items.push({ geo: s.column, mat: MATS.water, name: k === 'left' && single ? 'drain: tank' : k === 'right' && single ? 'source: basin, 0 V' : 'water', group: `w_${k}`, at: [(a + b) / 2, 0, 0], scale: [b - a, 1, 1], order: 1, shadow: false });
  items.push({ geo: s.pellet, mat: MATS.pellet, name: 'gate line (dead end)', group: 'pellet', shadow: false });

  // anchors at rest: the stage's move (valvePose) carries each with its part, so a lift or the spring's rise counts once
  const front: Vec3 = [0, 0.3, 1], up: Vec3 = [0, 1, 0], a = vs[vs.length - 1], dy = diaphragmY(0);
  const anchors: StudioAnchor[] = [
    { text: 'gate line (dead end)', p: single ? [a.cx + 13, 60, 3] : [(vs[0].cx + a.cx) / 2 + 8, GATE_Y, 3], side: single ? 'r' : 't', n: up, on: 'gate' },
    { text: single ? 'spring: preload = Vt' : 'spring', p: [a.cx + 4.5, springLen(a.open * TRAVEL) / 2, 0], side: 'r', n: front, on: `spring${p.valves.indexOf(a)}` },
    { text: single ? 'diaphragm (gate)' : 'diaphragm', p: [a.cx + 8, dy, 0], side: 'r', n: front, on: `lift${p.valves.indexOf(a)}` },
    { text: single ? 'channel: the gap' : 'plunger', p: [a.cx + 5.5, SEAT_Y + 1, 0], side: 'r', n: front, on: `lift${p.valves.indexOf(a)}` },
  ];
  if (single) anchors.push({ text: 'drain: tank', p: [a.cx - 30, FLOOR + LEVEL_H * a.left + 0.5, 8], side: 't', n: up, on: 'w_left' }, { text: 'source: basin, 0 V', p: [a.cx + 26, FLOOR + 2, -5], side: 't', n: up, on: 'w_right' });
  else anchors.push({ text: 'PMOS valve', p: [vs[0].cx, 4, 10], side: 'b', n: front, on: 'body' }, { text: 'NMOS valve', p: [a.cx, 4, 10], side: 'b', n: front, on: 'body' });
  const home = single ? VALVE_HOME.one : VALVE_HOME.pair;
  const beats: Beat[] = single ? [
    { title: 'A valve worked by pressure', text: 'The gate line’s pressure pushes the diaphragm up against a preloaded spring; past the preload the plunger lifts off its seat and water runs from the tank (the drain) to the basin (the source).', view: home },
    { title: 'The preload is the threshold', text: 'Below the pressure that just balances the spring’s preload nothing moves: the plunger stays on its seat. That pressure is Vt.', view: { yaw: 0.35, pitch: 0.2, target: [a.cx, 40, 0], dist: 95 } },
    { title: 'The gap is the channel, and it pinches off', text: 'The colour along the gap is the channel’s charge: bright at the source, thinner towards the drain. Raise the tank past Vgs − Vt and the drain end runs out of charge (red): the flow stops growing though the plunger has not moved.', view: { yaw: 0.12, pitch: 0.12, target: [a.cx, SEAT_Y + 4, 0], dist: 70 } },
    { title: 'A dead-end gate line', text: 'The gate line goes nowhere: its water moves only while the diaphragm does (the bright slug), then holds. A charged gate holds its charge the same way; a valve, unlike a gate, needs the pressure kept on.', view: { yaw: 0.45, pitch: 0.35, target: [a.cx + 8, 50, 0], dist: 120 }, frame: ['gate'] },
  ] : [
    { title: 'Two valves on one gate line', text: 'Pressure opens the NMOS valve and closes the PMOS one: one is shut whenever the other is open, so the output column sits at the tank or the basin.', view: home },
  ];
  return { items, anchors, beats, floor: 0, look: { exposure: 1.15, keyDir: [-0.4, 0.8, 0.5] } };
}

/** The moving parts at the pose: plungers and diaphragms by their lifts, springs by their lengths, the water by its levels, the
 *  chambers' fluid by the diaphragms, the channel by the gap, and the gate pellet along its line. */
export function valvePose(p: ValvePose): Map<string, Mat4> {
  const m = new Map<string, Mat4>();
  p.valves.forEach((v, i) => {
    const x = v.open * TRAVEL, dy = diaphragmY(x);
    m.set(`lift${i}`, tr([0, x, 0]));
    m.set(`spring${i}`, tr([0, dy + 1, 0]));
    m.set(`lower${i}`, trY([0, WALL_TOP + 2, 0], dy - WALL_TOP - 2));
    if (v.kind === 'p') m.set(`upper${i}`, trY([0, dy + 1, 0], CAP_Y - dy - 1));
    const flowing = x > 0.05 && v.left > 0.02;
    m.set(`chan${i}`, trY([0, SEAT_Y + (flowing ? x / 2 : 0), 0], flowing ? x : 0));
  });
  const vs = [...p.valves].sort((a, b) => a.cx - b.cx), level = (k: string, l: number) => m.set(`w_${k}`, trY([0, FLOOR, 0], l > 0.01 ? LEVEL_H * l : 0));
  level('left', vs[0].left);
  vs.slice(0, -1).forEach((v, i) => level(`mid${i}`, v.right));
  level('right', vs[vs.length - 1].right);
  const [g0, g1] = gateEnds(p), s = (p.phase % 1 + 1) % 1, px = g0 + (g1 - g0) * (p.gateQ > 0 ? s : 1 - s);
  const pm = tr([px, GATE_Y, -2]);
  if (Math.abs(p.gateQ) <= 1e-3) { pm[0] = pm[5] = pm[10] = 1e-4; } else { const k = (1.5 + 2 * Math.min(1, Math.abs(p.gateQ))) / 2.5; pm[0] = pm[10] = k; }
  m.set('pellet', pm);
  return m;
}

export const VALVE_HOME = {
  one: { yaw: 0.35, pitch: 0.24, target: [4, 34, 0] as Vec3, dist: 142 },
  pair: { yaw: 0.3, pitch: 0.24, target: [10, 30, 0] as Vec3, dist: 215 },
};
