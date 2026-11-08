// The memory hierarchy as distances (DOM-free, tested). Each level of widgets/hierarchy3ddata.ts stands at a distance
// from the core that is its latency on a log scale: X = SCALE * log10(ns / NS0), the same axis as the step's table bars
// (NS0 = 0.1 ns). One decade of time is SCALE world units, so the register is 8 units out and the SSD 118: a straight
// scale would put the SSD a hundred thousand times further than L1. A trip to a level takes the level's latency; the
// time the courier has spent at distance x is timeAt(x), the inverse of the scale.

import type { RGB } from '../gl/instances';
import type { Vec3 } from '../gl/math';
import { box, cyl, rod, type Anchor, type Part } from '../gl/parts';
import { CORE_GHZ, LEVELS, cyclesOf, type HLevel } from './hierarchy3ddata';

export const SCALE = 20, NS0 = 0.1;
/** Distance of a latency along the road. */
export const distOf = (ns: number): number => SCALE * Math.log10(ns / NS0);
/** The latency reached at a distance (inverse of distOf). */
export const timeAt = (x: number): number => NS0 * 10 ** (x / SCALE);
export const levelX = (l: HLevel): number => distOf(l.ns);
/** The time an access that hits in `l` takes: the level's latency, which is where its distance comes from. */
export const accessNs = (l: HLevel): number => timeAt(levelX(l));
export const ROAD_END = 134;

/** A count of cycles read as seconds ("if a cycle were a second"). */
export function asSeconds(cycles: number): string {
  const t = cycles;
  if (t < 90) return `${+t.toFixed(t < 10 ? 1 : 0)} s`;
  if (t < 5400) return `${+(t / 60).toFixed(1)} minutes`;
  if (t < 172800) return `${+(t / 3600).toFixed(1)} hours`;
  return `${+(t / 86400).toFixed(1)} days`;
}
export function fmtNs(ns: number): string {
  if (ns >= 1000) return `${+(ns / 1000).toPrecision(3)} µs`;
  return `${+ns.toPrecision(3)} ns`;
}
export { CORE_GHZ, cyclesOf };

export type Phase = 'idle' | 'out' | 'back';
export interface HPose { x: number; phase: Phase; target: number | null }
export interface HPalette {
  ground: RGB; road: RGB; tick: RGB; wood: RGB; shelf: RGB; wall: RGB; roof: RGB; door: RGB; core: RGB; metal: RGB;
  mark: RGB; live: RGB; courier: RGB;
}

/** Which place stands where on the road (x range) and how tall it is. */
export const PLACES: { id: HLevel['place']; label: string; x0: number; x1: number; h: number }[] = [
  { id: 'desk', label: 'Desk', x0: 3, x1: 25, h: 6 },
  { id: 'shelf', label: 'Shelf', x0: 27, x1: 47, h: 15 },
  { id: 'library', label: 'Library', x0: 51, x1: 71, h: 18 },
  { id: 'warehouse', label: 'Warehouse', x0: 104, x1: 134, h: 22 },
];
/** Decade ticks along the road, in ns: 1 ns, 10 ns … 100 µs. */
export const TICKS = [1, 10, 100, 1000, 10_000, 100_000];

const lit = (c: RGB, k = 0.5): RGB => [c[0] * k, c[1] * k, c[2] * k];

export function hierarchyParts(p: HPose, P: HPalette): Part[] {
  const out: Part[] = [];
  out.push(box(P.ground, -14, ROAD_END + 6, -1.2, -0.2, -36, 12), box(P.road, -6, ROAD_END, -0.2, 0.15, -1.5, 1.5));
  for (const t of TICKS) { const x = distOf(t); out.push(box(P.tick, x - 0.25, x + 0.25, 0.1, 0.5, -2.2, 2.2)); }
  // The core at the start of the road.
  out.push(box(P.core, -12, -2, 0, 9, -6, 4), box(P.metal, -9, -5, 9, 10, -3, 1), box(P.metal, -2, -1, 3, 4, -1, 1));
  // The desk: a top on four legs.
  const d = PLACES[0];
  out.push(box(P.wood, d.x0, d.x1, 4.2, 5.2, -11, -3.5));
  for (const x of [d.x0 + 1, d.x1 - 1]) for (const z of [-10, -4.5]) out.push(cyl(P.wood, x, z, 0, 4.2, 0.5));
  // The shelf: a bookcase with boards.
  const s = PLACES[1];
  out.push(box(P.shelf, s.x0, s.x1, 0, s.h, -9, -8), box(P.shelf, s.x0, s.x0 + 0.8, 0, s.h, -9, -3), box(P.shelf, s.x1 - 0.8, s.x1, 0, s.h, -9, -3));
  for (const y of [0, 5, 10, 14.2]) out.push(box(P.shelf, s.x0, s.x1, y, y + 0.8, -9, -3));
  // The library: a hall with columns and a roof.
  const l = PLACES[2];
  out.push(box(P.wall, l.x0, l.x1, 0, l.h, -22, -9), box(P.roof, l.x0 - 1, l.x1 + 1, l.h, l.h + 1.5, -23, -8));
  for (let i = 0; i < 5; i++) out.push(cyl(P.wall, l.x0 + 2 + i * 4, -6, 0, l.h - 1, 0.8), box(P.door, l.x0 + 1.5 + i * 4, l.x0 + 3 + i * 4, 0, 6, -9.05, -8.9));
  out.push(box(P.roof, l.x0 - 1, l.x1 + 1, l.h - 1, l.h, -9.5, -5));
  // The warehouse across town: a long shed with big doors.
  const w = PLACES[3];
  out.push(box(P.wall, w.x0, w.x1, 0, w.h, -34, -8), box(P.roof, w.x0 - 1, w.x1 + 1, w.h, w.h + 1.5, -35, -7));
  for (let i = 0; i < 3; i++) out.push(box(P.door, w.x0 + 3 + i * 9, w.x0 + 9 + i * 9, 0, 12, -7.95, -7.8));
  // The levels: a block each, bigger the further out; the target glows.
  LEVELS.forEach((lv, k) => {
    const x = levelX(lv), sz = 1.2 + k * 0.45, on = p.target === k;
    const base = lv.place === 'desk' ? 5.2 : lv.place === 'shelf' ? (lv.id === 'l2' ? 0.8 : 5.8) : 0;
    const m = box(on ? P.live : P.mark, x - sz, x + sz, base, base + 2 * sz, -7 - sz / 2, -7 + sz / 2);
    if (on) m.emissive = lit(P.live, 0.6);
    out.push(m, rod(P.tick, [x, base, -5], [x, 0.3, 0], 0.12, 0.1));
  });
  // The courier: a small cart on the road with a flag, lit green on the way back with the data.
  out.push(box(P.courier, p.x - 1.2, p.x + 1.2, 0.6, 2, -1, 1), cyl(P.metal, p.x - 0.7, 1.1, 0, 0.9, 0.5), cyl(P.metal, p.x + 0.7, 1.1, 0, 0.9, 0.5),
    cyl(P.metal, p.x - 0.7, -1.1, 0, 0.9, 0.5), cyl(P.metal, p.x + 0.7, -1.1, 0, 0.9, 0.5), rod(P.metal, [p.x, 2, 0], [p.x, 4.2, 0], 0.1));
  const flag = box(p.phase === 'back' ? P.live : P.core, p.x, p.x + 1.8, 3.2, 4.2, -0.1, 0.1);
  if (p.phase === 'back') flag.emissive = lit(P.live, 0.6);
  out.push(flag);
  return out;
}

const SHORT: Record<HLevel['id'], string> = { reg: 'Regs', l1: 'L1', l2: 'L2', l3: 'L3', dram: 'DRAM', ssd: 'SSD' };
/** narrow: every other of the close-set cache labels stands further out, so a phone-width view does not set them touching. */
export function hierarchyAnchors(narrow = false): Anchor[] {
  const front: Vec3 = [0, 0.3, 1], up: Vec3 = [0, 1, 0];
  return [
    { text: 'Core', p: [-7, 10, -1], side: 't', n: up },
    ...LEVELS.map((lv): Anchor => ({ text: SHORT[lv.id], p: [levelX(lv), 0, narrow && (lv.id === 'l1' || lv.id === 'l3') ? 24 : 3], side: 'b', n: front })),
    ...PLACES.map((q): Anchor => ({ text: q.label, p: [(q.x0 + q.x1) / 2, q.h + (q.id === 'desk' ? 8 : q.id === 'shelf' ? 1 : 3), -6], side: 't', n: up })),
  ];
}

/** The camera while following the courier at x. */
export const followView = (x: number) => ({ target: [x, 5, -4] as Vec3, yaw: 0.45, pitch: 0.32, dist: 78 });
/** The whole road. */
export const overview = (narrow: boolean) => ({ target: [60, 6, -6] as Vec3, yaw: 0.25, pitch: 0.42, dist: narrow ? 270 : 205 });

/** Seconds the courier takes one way to a distance: a drawing's time, longer for the far levels, not the level's latency. */
export const flightSeconds = (x: number): number => 0.9 + 0.032 * x;
