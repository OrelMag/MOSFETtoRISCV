// The memory hierarchy as distances (DOM-free, tested). Each level of widgets/hierarchy3ddata.ts stands at a distance
// from the core that is its latency on a log scale: X = SCALE * log10(ns / NS0), the same axis as the step's table bars
// (NS0 = 0.1 ns). One decade of time is SCALE world units, so the register is 8 units out and the SSD 118: a straight
// scale would put the SSD a hundred thousand times further than L1. A trip to a level takes the level's latency; the
// time the courier has spent at distance x is timeAt(x), the inverse of the scale.

import type { Vec3 } from '../gl/math';
import type { Anchor } from '../gl/parts';
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

const SHORT: Record<HLevel['id'], string> = { reg: 'Regs', l1: 'L1', l2: 'L2', l3: 'L3', dram: 'DRAM', ssd: 'SSD' };
/** The levels' dots stand on the road at their true distance, each label the level over its place (two lines: the log scale
 *  puts the places too close for labels of their own; the registers' place is the Core label beside them); they alternate below and above the road, so neighbours never share a line. */
export function hierarchyAnchors(narrow = false): Anchor[] {
  const front: Vec3 = [0, 0.3, 1], up: Vec3 = [0, 1, 0];
  const above = new Set<HLevel['id']>(['l1', 'l3']);
  return [
    { text: 'Core', p: [-7, 10, -1], side: 't', n: up },
    ...LEVELS.map((lv): Anchor => ({ text: lv.place === 'core' || narrow ? SHORT[lv.id] : `${SHORT[lv.id]}\n${placeOf(lv).label}`, p: [levelX(lv), 0, 3], side: above.has(lv.id) ? 't' : 'b', n: front })),
  ];
}

/** The access time on the clock when the courier is at distance x. An access is a round trip: the request goes out, the data
 *  comes back, so the outward leg is half the latency (read off the log scale at x) and the return the other half; the full
 *  latency is on the clock only when the data is home. The flight is a drawing, but its clock is this. */
export function elapsedNs(ns: number, phase: Phase, x: number): number {
  if (phase === 'out') return x > 0 ? Math.min(ns / 2, timeAt(x) / 2) : 0;
  if (phase === 'back') return Math.max(ns / 2, ns - timeAt(x) / 2);
  return ns;
}

/** The camera while following the courier at x. */
export const followView = (x: number) => ({ target: [x, 5, -4] as Vec3, yaw: 0.45, pitch: 0.32, dist: 78 });
/** The whole road. */
export const overview = (narrow: boolean) => ({ target: [62, 3, -10] as Vec3, yaw: 0.22, pitch: 0.4, dist: narrow ? 235 : 168 });

/** Seconds the courier takes one way to a distance: a drawing's time, longer for the far levels, not the level's latency. */
export const flightSeconds = (x: number): number => 0.9 + 0.032 * x;
