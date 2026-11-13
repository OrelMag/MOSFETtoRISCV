// The pipeline as an assembly line on the studio renderer (DOM-free, tested: tests/assembly3dkit.test.ts). Where every pallet
// is, and what the hazard unit does each clock, is riscv/pipetrace.ts's (held to the gate-level pipeline, forwarding
// included, by tests/model-assembly.test.ts); assembly3dparts.ts palletsAt places the pallets. New on the studio: pallets
// that read as objects (a plate with its cargo, seated on a rubber belt), and what the step before taught made visible from
// the circuit's own signals: a chute from Memory and Writeback back to Execute that carries a value on a clock where the
// hazard unit forwards (forwardA / forwardB), a tag from a load to the instruction that has to wait for it on a load-use
// stall, and an arm that sweeps the two wrong-path pallets off the line on a flush.
//
// The model is rebuilt once a clock; between clocks the pallets and the arm move (Moves) and the forwarded value rides
// its chute (instanced).

import { lathe, merge, roundedBox, sphere, sweep, transform, tube, type Geo } from '../gl/kit/geo';
import { M, type Material } from '../gl/kit/materials';
import type { Beat, Item, Model3, StudioAnchor } from '../gl/kit/scene';
import type { Instance, RGB } from '../gl/instances';
import type { Mat4, Vec3 } from '../gl/math';
import type { Cycle } from '../riscv/pipetrace';
import { STATIONS, lampsOf, palletsAt, stationX, type Ctx, type Kind, type Pallet } from './assembly3dparts';

export interface AsmRgb { alu: RGB; load: RGB; store: RGB; ctl: RGB; wrong: RGB; bubble: RGB; hold: RGB; off: RGB; fwd: RGB }

export interface AsmLook {
  detail: 'full' | 'flat';
  plan: readonly Cycle[];
  t: number;
  /** The slide since the last clock (1: settled): the flat drawing draws the pallets there. */
  u: number;
  ctx: Ctx & { textOf(pc: number): string; hexOf(pc: number): string };
  rgb: AsmRgb;
}

// ---------------------------------------------------------------- helpers

const cache = new Map<string, Geo>();
const once = (key: string, make: () => Geo): Geo => { let g = cache.get(key); if (!g) { g = make(); cache.set(key, g); } return g; };
const T = (x: number, y = 0, z = 0): Mat4 => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
const boxAt = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, r = 0): Geo =>
  transform(roundedBox(x1 - x0, y1 - y0, z1 - z0, r, r ? 3 : 1), T((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2));
const ON_Z: Mat4 = new Float32Array([1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1]);

/** A pallet's move: placed at (x, y, z) and scaled by its size (a new pallet grows in, a retiring one shrinks away). */
export function palletMove(p: Pallet): Mat4 {
  const s = Math.max(1e-3, p.size);
  return new Float32Array([s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, p.x, p.y, p.z, 1]);
}
/** The flush arm's move: turned `a` radians about its pivot (an axis along x through the lintels' front). */
export const ARM_PIVOT: [number, number] = [21, 11];
export function armMove(a: number): Mat4 {
  const c = Math.cos(a), s = Math.sin(a), [py, pz] = ARM_PIVOT;
  // rotate about x through (y, z) = pivot: back (toward -z) for a > 0
  return new Float32Array([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, py - c * py + s * pz, pz - s * py - c * pz, 1]);
}
/** How far the arm has swung: out and back during the clock after a flush, which is when the pulled pallets leave. */
/** The arm is down only around a flush: on the clock that decides it and the one that clears the line. */
export const armShown = (plan: readonly Cycle[], t: number): boolean => plan[t].flush || (t > 0 && plan[t - 1].flush);
export const armAngle = (plan: readonly Cycle[], t: number, u: number): number => (t > 0 && plan[t - 1].flush ? 1.15 * Math.sin(Math.PI * Math.min(1, u)) : 0);

// ---------------------------------------------------------------- the chutes and what rides them

/** The chute from a stage (3: Memory, 4: Writeback) back to Execute: up behind the gantries, along, and down to E's pallet. */
export function chutePath(from: 3 | 4): Vec3[] {
  const x0 = stationX(from), x1 = stationX(2), z = from === 3 ? -9 : -12, top = from === 3 ? 27 : 31;
  return [[x0, 9, z], [x0, top - 4, z], [x0 - 4, top, z], [x1 + 4, top, z], [x1, top - 4, z], [x1, 9, z]];
}
const pathLen = (p: Vec3[]) => p.slice(1).reduce((s, q, i) => s + Math.hypot(q[0] - p[i][0], q[1] - p[i][1], q[2] - p[i][2]), 0);
function along(p: Vec3[], f: number): Vec3 {
  let d = f * pathLen(p);
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 1], b = p[i], l = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    if (d <= l || i === p.length - 1) { const k = l ? Math.min(1, d / l) : 0; return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]; }
    d -= l;
  }
  return p[p.length - 1];
}
/** Which chutes carry a value at clock t: forwardA / forwardB select 2 (from M) or 1 (from W). */
export function chutesUsed(c: Cycle): Set<3 | 4> {
  const s = new Set<3 | 4>();
  for (const f of c.fwd) if (f === 2) s.add(3); else if (f === 1) s.add(4);
  return s;
}
/** The value riding each chute in use, `u` of the way down it (1: arrived at Execute). */
export function riders(c: Cycle, u: number, rgb: AsmRgb): Instance[] {
  return [...chutesUsed(c)].map((from) => ({ pos: along(chutePath(from), Math.min(1, u)), color: rgb.fwd, emissive: rgb.fwd.map((v) => v * 0.9) as RGB }));
}
export const RIDER = sphere(1.3, 16, 10);

// ---------------------------------------------------------------- the model

export const PLATE = { w: 18, h: 2, d: 14 } as const, CARGO = { w: 12, h: 6, d: 9 } as const;
const kindTok: Record<Kind, `--${string}`> = { alu: '--as-alu', load: '--as-load', store: '--as-store', ctl: '--as-ctl', bubble: '--as-bubble' };

export function asmModel(look: AsmLook): Model3 {
  const { plan, t, ctx, rgb } = look, c = plan[t], full = look.detail === 'full', items: Item[] = [];
  const x0 = stationX(-1.4), x1 = stationX(5.4);
  const steel = M.make({ ...M.steel, base: '--as-frame', metal: 0.6, rough: 0.4, label: 'steel frame' });
  const belt = M.make({ ...M.rubber, base: '--as-belt', label: 'rubber belt' });
  const plate = M.make({ base: '--as-plate', metal: 0.4, rough: 0.35, label: 'pallet (a pipeline register’s slot)' });
  const bubblePlate = M.make({ base: '--as-bubble', metal: 0, rough: 0.6, label: 'empty pallet: a bubble (the register cleared)' });
  const kindMat = (k: Kind, wrong: boolean) => M.make({ base: wrong ? '--as-wrong' : kindTok[k], metal: 0, rough: 0.35, coat: 0.6, label: wrong ? 'wrong path: fetched on a guess, pulled' : `${k === 'alu' ? 'arithmetic' : k === 'ctl' ? 'branch / jump' : k} instruction` });
  const it = (geo: Geo, mat: Material, name: string, group: string, extra: Partial<Item> = {}) => items.push({ geo, mat, name, group, ...extra });

  // the belt: rubber over two end rollers, steel side rails, legs
  it(once('belt', () => boxAt(x0, x1, -3, 0, -10, 10, 0.8)), belt, 'belt', 'line', { info: { note: 'every clock moves every pallet one station on' } });
  it(once('rollers', () => merge([x0 + 1.5, x1 - 1.5].map((x) => transform(transform(lathe([[0, -11], [1.8, -11], [1.8, 11], [0, 11]], { seg: 24, crease: 50 }), ON_Z), T(x, -1.5, 0))), 'rollers')), steel, 'belt', 'line');
  it(once('rails', () => merge([-1, 1].map((s) => boxAt(x0, x1, -4, 0.8, s * 11 - 0.8, s * 11 + 0.8, 0.3)), 'rails')), steel, 'belt', 'line');
  it(once('legs', () => merge([x0 + 4, stationX(2), x1 - 4].flatMap((x) => [-1, 1].map((s) => boxAt(x - 1, x + 1, -16, -4, s * 9 - 1, s * 9 + 1, 0.3))), 'legs')), steel, 'belt', 'line');

  // the stations: a gantry each (two posts and a lintel at the front), a signal lamp on top
  const lamps = lampsOf(c);
  STATIONS.forEach((name, i) => {
    const x = stationX(i), lamp = lamps[i], on = lamp !== 'off';
    it(once(`gantry${i}`, () => merge([boxAt(x - 12, x - 10, 0, 17, 9, 11, 0.4), boxAt(x + 10, x + 12, 0, 17, 9, 11, 0.4), boxAt(x - 12.5, x + 12.5, 17, 20, 8, 12, 0.6)], 'gantry')), steel, `${name} station`, `st${i}`);
    const col = lamp === 'hold' ? rgb.hold : lamp === 'flush' ? rgb.wrong : rgb.off;
    it(once('lamp', () => lathe([[0, 0], [3.2, 0], [3.2, 0.8], [2.6, 2.4], [1.4, 3.3], [0, 3.6]], { seg: 24, crease: 40 })), M.make({ base: col, metal: 0, rough: 0.3, coat: 0.6, emit: on ? col : undefined, glow: on ? 0.9 : 0, bloom: on ? 1 : 0, label: on ? (lamp === 'hold' ? 'lamp: hold (stall)' : 'lamp: flush') : 'lamp' }), `${name} lamp`, `st${i}`, { at: [x, 20, 10] });
  });

  // the pallets, at the origin: placed and sized by the view's moves (the flat drawing places them itself)
  // the set the view's moves place: mid-slide the pallets leaving too, settled only those on the line
  const pallets = palletsAt(plan, t, look.u, ctx);
  for (const p of pallets) {
    const g = `pal${p.seq}`, seat = full ? {} : { at: [p.x, p.y, p.z] as Vec3, scale: [p.size, p.size, p.size] as Vec3 };
    const instr = p.kind === 'bubble' ? null : plan[t].slots.concat(t > 0 ? plan[t - 1].slots : []).find((s) => s.seq === p.seq);
    const info = instr && instr.valid ? { dim: `${ctx.hexOf(instr.pc)}  ${ctx.textOf(instr.pc)}`, source: `riscv/pipetrace.ts, held to the gate-level pipeline: clock ${t}` } : { note: 'a bubble: the pipeline register holds no instruction' };
    it(once('plate', () => boxAt(-PLATE.w / 2, PLATE.w / 2, 0, PLATE.h, -PLATE.d / 2, PLATE.d / 2, 0.6)), p.kind === 'bubble' ? bubblePlate : plate, p.kind === 'bubble' ? 'bubble' : p.text, g, { ...seat, info });
    if (p.kind !== 'bubble') it(once('cargo', () => boxAt(-CARGO.w / 2, CARGO.w / 2, PLATE.h, PLATE.h + CARGO.h, -CARGO.d / 2, CARGO.d / 2, 1.2)), kindMat(p.kind, p.wrong), p.text, g, { ...seat, info });
  }

  // forwarding chutes: dim when idle, lit on a clock that forwards through them
  const used = chutesUsed(c);
  for (const from of [3, 4] as const) {
    const lit = used.has(from);
    it(once(`chute${from}`, () => sweep(chutePath(from), [[-1.1, -1.1], [1.1, -1.1], [1.1, 1.1], [-1.1, 1.1]].map(([a, b]) => [a, b] as [number, number]))),
      M.make({ base: lit ? rgb.fwd : '--as-chute', metal: lit ? 0 : 0.5, rough: 0.4, emit: lit ? rgb.fwd : undefined, glow: lit ? 0.35 : 0, label: `forwarding from ${STATIONS[from]} to Execute` }),
      `forwarding from ${STATIONS[from]}`, 'chutes', { info: { note: lit ? `this clock E’s ${c.fwd.map((f, k) => (f === (from === 3 ? 2 : 1) ? (k ? 'second' : 'first') : '')).filter(Boolean).join(' and ')} operand comes from ${STATIONS[from]} (forward${from === 3 ? 'A/B = 10' : 'A/B = 01'})` : 'carries a result back to Execute when the instruction there needs it before Writeback' } });
  }

  // a load-use stall: a tag from the load in Execute to the instruction in Decode that reads its result
  if (c.stall) {
    const a = stationX(2), b = stationX(1);
    it(tube([[a, 9, 5], [a, 14, 6], [(a + b) / 2, 17, 6], [b, 14, 6], [b, 9, 5]], 0.55, { sides: 8, bend: 2 }), M.make({ base: rgb.hold, metal: 0, rough: 0.4, emit: rgb.hold, glow: 0.8, bloom: 0.8, label: 'waits for the load' }), 'waits for the load', 'stall', { shadow: false, info: { note: 'the load’s result exists only after Memory: Decode holds, a bubble goes into Execute' } });
  }

  // the flush arm over Fetch and Decode, hanging from the lintels: lowered on a flush clock, swung by the view at its edge
  const ax0 = stationX(0) - 10, ax1 = stationX(1) + 10, [py, pz] = ARM_PIVOT;
  if (armShown(plan, t)) it(once('arm', () => merge([boxAt(ax0, ax1, 9.5, 11.5, pz - 0.8, pz + 0.8, 0.4), boxAt(ax0 + 2, ax0 + 4, 11.5, py, pz - 0.6, pz + 0.6, 0.3), boxAt(ax1 - 4, ax1 - 2, 11.5, py, pz - 0.6, pz + 0.6, 0.3)], 'arm')), M.make({ ...M.steel, base: '--as-wrong', metal: 0.3, rough: 0.4, label: 'flush arm' }), 'flush arm', 'arm', { info: { note: 'a taken branch or jump is only known in Execute: the arm clears the two fetched behind it' } });

  // frames
  const ghost = M.make({ base: [0, 0, 0], metal: 0, rough: 1, label: 'frame' });
  const fb = (g: string, a: number, b: number, ya: number, yb: number, za: number, zb: number) => items.push({ geo: once(`f${g}`, () => boxAt(a, b, ya, yb, za, zb)), mat: ghost, group: g, cut: 'none', shadow: false });
  // home: the five stations and their pallets, low and near (the chutes may run off the top)
  fb('homebox', stationX(-0.72), stationX(4.62), -3, 21, -11, 12);
  fb('chutebox', stationX(1.5), stationX(4.5), 0, 32, -14, 12);
  fb('stallbox', stationX(0.5), stationX(3.5), 0, 22, -8, 12);
  fb('flushbox', stationX(-0.6), stationX(2.6), 0, 26, -34, 12);

  return { items, anchors: anchorsOf(c), beats: BEATS, floor: -16, look: { exposure: 1.05 } };
}

function anchorsOf(c: Cycle): StudioAnchor[] {
  const front: Vec3 = [0, 0.3, 1], up: Vec3 = [0, 1, 0];
  // the five stations only: a pallet's instruction is on hover and in the readout ("forwarded" on a clock that forwards)
  const out: StudioAnchor[] = STATIONS.map((n, i) => ({ text: n, p: [stationX(i), -2, 11], side: 'b', n: front, on: `st${i}` }));
  if (chutesUsed(c).size) out.push({ text: 'forwarded', p: [stationX(2.5), 30, -10], side: 't', n: up, on: 'chutes' });
  return out;
}

/** The tour: what each beat shows (the view jumps to the first clock of the program where it happens). */
export type BeatEvent = 'full' | 'forward' | 'stall' | 'flush' | 'cpi';
export const BEAT_EVENTS: readonly BeatEvent[] = ['full', 'forward', 'stall', 'flush', 'cpi'];
/** The first clock where the event happens (null: the program has none); a flush: the clock that decides it, before its edge. */
export function clockOf(plan: readonly Cycle[], e: BeatEvent): number | null {
  const i = plan.findIndex((c) => (e === 'full' || e === 'cpi' ? c.slots.every((s) => s.valid) : e === 'forward' ? chutesUsed(c).size > 0 : e === 'stall' ? c.stall : c.flush));
  return i < 0 ? null : i;
}
/** Home: a little from the front and low, so the pallets read as pallets. */
export const HOME_YAW = 0.22, HOME_PITCH = 0.3;
const V = (yaw: number, pitch: number) => ({ target: [0, 0, 0] as Vec3, yaw, pitch, dist: 200 });
const BEATS: Beat[] = [
  { title: 'Five stations, one clock', text: 'Fetch, Decode, Execute, Memory, Writeback: a pallet per instruction. Every clock moves every pallet one station on, so once the line is full one instruction leaves Writeback every clock.', view: V(HOME_YAW, HOME_PITCH), frame: ['homebox'] },
  { title: 'Forwarding', text: 'The instruction in Execute needs a result that is still in Memory or Writeback, not yet in the register file. The hazard unit sees the register numbers match and the result rides a chute straight back to the ALU: no clock is lost. The chute lights only on a clock the circuit’s forwardA or forwardB selects it.', view: V(0.15, 0.3), frame: ['chutebox'] },
  { title: 'A load makes the next one wait', text: 'A load’s value exists only after Memory, too late for an instruction right behind it in Execute. Fetch and Decode hold (their lamps), and an empty pallet, the bubble, goes into Execute: one clock lost. Then forwarding from Writeback does the rest.', view: V(0.45, 0.45), frame: ['stallbox'] },
  { title: 'A branch is known in Execute', text: 'Whether a branch is taken is decided in Execute. By then the two instructions behind it were fetched on a guess that the road went straight on; when it does not, the arm sweeps them off the line and Fetch starts again at the target: two clocks lost.', view: V(-0.25, 0.5), frame: ['flushbox'] },
  { title: 'Cycles per instruction', text: 'Cycles = instructions + 4 to fill the line + one per load-use stall + two per flush. The readout keeps the count: the closer to one per clock, the better the line is used.', view: V(HOME_YAW, HOME_PITCH), frame: ['homebox'] },
];
