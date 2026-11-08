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

export type Place = { id: HLevel['place']; label: string; x0: number; x1: number; h: number };
/** Which place stands where on the road (x range) and how tall it is: the desk figure's four (desk L1, shelf L2, library L3,
 *  warehouse DRAM), then the SSD a city away. The log scale puts L2 and L3 close together, so the shelf is narrow. */
export const PLACES: Place[] = [
  { id: 'desk', label: 'Desk', x0: 13, x1: 26, h: 6 },
  { id: 'shelf', label: 'Shelf', x0: 28, x1: 35, h: 15 },
  { id: 'library', label: 'Library', x0: 37, x1: 49, h: 18 },
  { id: 'warehouse', label: 'Warehouse', x0: 51, x1: 70, h: 22 },
  { id: 'city', label: 'Another city', x0: 100, x1: 134, h: 30 },
];
/** The registers are in the core: its body and the register rack on its road side. */
export const CORE: Place = { id: 'core', label: 'Core', x0: -12, x1: 11, h: 9 };
export const placeOf = (l: HLevel): Place => (l.place === 'core' ? CORE : PLACES.find((q) => q.id === l.place)!);
/** Decade ticks along the road, in ns: 1 ns, 10 ns … 100 µs. */
export const TICKS = [1, 10, 100, 1000, 10_000, 100_000];

const lit = (c: RGB, k = 0.5): RGB => [c[0] * k, c[1] * k, c[2] * k];

export function hierarchyParts(p: HPose, P: HPalette): Part[] {
  const out: Part[] = [];
  out.push(box(P.ground, -14, ROAD_END + 6, -1.2, -0.2, -36, 12), box(P.road, -6, ROAD_END, -0.2, 0.15, -1.5, 1.5));
  for (const t of TICKS) { const x = distOf(t); out.push(box(P.tick, x - 0.25, x + 0.25, 0.1, 0.5, -2.2, 2.2)); }
  // The core at the start of the road.
  out.push(box(P.core, -12, -2, 0, 9, -6, 4), box(P.metal, -9, -5, 9, 10, -3, 1), box(P.metal, -2, -1, 3, 4, -1, 1));
  // The register rack: a low bench joined to the core, the registers' block on it.
  out.push(box(P.core, -2, CORE.x1, 2.2, 3, -9, -4), box(P.core, CORE.x1 - 1, CORE.x1, 0, 2.2, -9, -4));
  // The desk: a top on four legs.
  const d = PLACES[0];
  out.push(box(P.wood, d.x0, d.x1, 4.2, 5.2, -11, -3.5));
  for (const x of [d.x0 + 1, d.x1 - 1]) for (const z of [-10, -4.5]) out.push(cyl(P.wood, x, z, 0, 4.2, 0.5));
  // The shelf: a bookcase with boards.
  const s = PLACES[1];
  out.push(box(P.shelf, s.x0, s.x1, 0, s.h, -9, -8), box(P.shelf, s.x0, s.x0 + 0.8, 0, s.h, -9, -3), box(P.shelf, s.x1 - 0.8, s.x1, 0, s.h, -9, -3));
  for (const y of [0, 5, 10, 14.2]) out.push(box(P.shelf, s.x0, s.x1, y, y + 0.8, -9, -3));
  // The library: a hall with a portico (columns at its ends, clear of the level's block) and a roof.
  const l = PLACES[2];
  out.push(box(P.wall, l.x0, l.x1, 0, l.h, -22, -9), box(P.roof, l.x0 - 1, l.x1 + 1, l.h, l.h + 1.5, -23, -8));
  for (const cx of [l.x0 + 1.2, l.x1 - 1.2]) out.push(cyl(P.wall, cx, -4.5, 0, l.h - 1, 0.8));
  for (let i = 0; i < 3; i++) out.push(box(P.door, l.x0 + 2.5 + i * 3.2, l.x0 + 4 + i * 3.2, 0, 6, -9.05, -8.9));
  out.push(box(P.roof, l.x0 - 1, l.x1 + 1, l.h - 1, l.h, -9.5, -3.5));
  // The warehouse across town: a long shed with big doors.
  const w = PLACES[3];
  out.push(box(P.wall, w.x0, w.x1, 0, w.h, -34, -10), box(P.roof, w.x0 - 1, w.x1 + 1, w.h, w.h + 1.5, -35, -9));
  for (let i = 0; i < 2; i++) out.push(box(P.door, w.x0 + 2.5 + i * 8.5, w.x0 + 8 + i * 8.5, 0, 12, -9.95, -9.8));
  // Another city: a cluster of towers with rows of windows, the tallest at the back.
  const c = PLACES[4];
  for (const [a, b, ht, z0, z1] of [[0, 7, 14, -16, -10], [8, 14, 30, -30, -18], [15, 22, 22, -20, -11], [23, 29, 26, -32, -21], [30, 34, 12, -15, -10]]) {
    const top = (c.h * ht) / 30;
    out.push(box(P.wall, c.x0 + a, c.x0 + b, 0, top, z0, z1), box(P.roof, c.x0 + a - 0.3, c.x0 + b + 0.3, top, top + 0.8, z0 - 0.3, z1 + 0.3));
    for (let y = 3; y < top - 1; y += 4) out.push(box(P.door, c.x0 + a + 1, c.x0 + b - 1, y, y + 1.2, z1 + 0.02, z1 + 0.12));
  }
  // The levels: a block each, bigger the further out; the target glows.
  LEVELS.forEach((lv, k) => {
    const x = levelX(lv), sz = 1.2 + k * 0.45, on = p.target === k;
    const base = lv.place === 'core' ? 3 : lv.place === 'desk' ? 5.2 : lv.place === 'shelf' ? 0.8 : 0;
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
/** The levels' dots stand on the road at their true distance, each label the level over its place (two lines: the log scale
 *  puts the places too close for labels of their own; the registers' place is the Core label beside them); they alternate below and above the road, so neighbours never share a line. */
export function hierarchyAnchors(): Anchor[] {
  const front: Vec3 = [0, 0.3, 1], up: Vec3 = [0, 1, 0];
  const above = new Set<HLevel['id']>(['l1', 'l3']);
  return [
    { text: 'Core', p: [-7, 10, -1], side: 't', n: up },
    ...LEVELS.map((lv): Anchor => ({ text: lv.place === 'core' ? SHORT[lv.id] : `${SHORT[lv.id]}\n${placeOf(lv).label}`, p: [levelX(lv), 0, 3], side: above.has(lv.id) ? 't' : 'b', n: front })),
  ];
}

/** The camera while following the courier at x. */
export const followView = (x: number) => ({ target: [x, 5, -4] as Vec3, yaw: 0.45, pitch: 0.32, dist: 78 });
/** The whole road. */
export const overview = (narrow: boolean) => ({ target: [60, 6, -6] as Vec3, yaw: 0.25, pitch: 0.42, dist: narrow ? 270 : 205 });

/** Seconds the courier takes one way to a distance: a drawing's time, longer for the far levels, not the level's latency. */
export const flightSeconds = (x: number): number => 0.9 + 0.032 * x;
