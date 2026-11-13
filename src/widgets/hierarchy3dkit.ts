// The memory hierarchy as distances, for the studio renderer (DOM-free, tested). A toy, kept a toy and finished: the
// layout is hierarchy3dparts.ts's (each place as far from the core as its latency on a log scale), drawn as rounded
// buildings that cast soft shadows, a courier van that drives out to the level and back, the levels' data as crates by the
// road, a post at each decade of time. Nothing here is to any scale but the road's; the colours are the page's tokens.

import { lathe, merge, roundedBox, transform, type Geo } from '../gl/kit/geo';
import { M, type Material } from '../gl/kit/materials';
import type { Beat, Item, Model3, StudioAnchor } from '../gl/kit/scene';
import type { Mat4, Vec3 } from '../gl/math';
import { groupNum } from '../sim/numfmt';
import { LEVELS } from './hierarchy3ddata';
import { asSeconds, CORE, cyclesOf, distOf, fmtNs, followView, hierarchyAnchors, levelX, overview, PLACES, ROAD_END, SCALE, TICKS, type HPose } from './hierarchy3dparts';

const tr = (p: Vec3): Mat4 => { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; m[12] = p[0]; m[13] = p[1]; m[14] = p[2]; return m; };
const bx = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, r = 0.25): Geo =>
  transform(roundedBox(x1 - x0, y1 - y0, z1 - z0, Math.min(r, (x1 - x0) / 2.2, (y1 - y0) / 2.2, (z1 - z0) / 2.2), 2), tr([(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2]));
/** An upright cylinder (a leg, a column, a post) with rounded ends. */
const col = (x: number, z: number, y0: number, y1: number, r: number, seg = 16): Geo =>
  transform(lathe([[0, y0], [r * 0.85, y0], [r, y0 + r * 0.2], [r, y1 - r * 0.2], [r * 0.85, y1], [0, y1]], { seg, crease: 50 }), tr([x, 0, z]));
/** A pitched roof along x over [x0, x1] × [z0, z1]. */
function roof(x0: number, x1: number, y: number, z0: number, z1: number, rise: number): Geo {
  const zm = (z0 + z1) / 2, half = (z1 - z0) / 2 + 0.6, len = x1 - x0 + 1.2, t = 0.5;
  const slope = (side: 1 | -1) => {
    const a = Math.atan2(rise, half), m = new Float32Array(16), c = Math.cos(a), s = Math.sin(a) * side;
    // a slab tilted about x, its low edge at the wall's top
    m.set([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, (x0 + x1) / 2, y + rise / 2, zm + (side * half) / 2, 1]);
    return transform(roundedBox(len, t, Math.hypot(half, rise), 0.15, 2), m);
  };
  return merge([slope(1), slope(-1)], 'roof');
}

const mk = (o: Material): Material => M.make(o);
const paint = (tok: string, rough = 0.55, coat = 0.15, label = 'paint'): Material => mk({ base: tok as Material['base'], metal: 0, rough, coat, label });
export const MATS = {
  ground: paint('--hy-ground', 0.9, 0, 'ground'),
  road: paint('--hy-road', 0.85, 0, 'road'),
  tick: paint('--hy-tick', 0.6, 0, 'a decade of time'),
  wood: paint('--hy-wood', 0.5, 0.35, 'wood'),
  shelf: paint('--hy-shelf', 0.55, 0.25, 'wood'),
  wall: paint('--hy-wall', 0.75, 0.05, 'wall'),
  roof: paint('--hy-roof', 0.6, 0.1, 'roof tiles'),
  door: paint('--hy-door', 0.4, 0.3, 'door and windows'),
  core: paint('--hy-core', 0.35, 0.4, 'the core'),
  mark: paint('--hy-mark', 0.45, 0.3, 'a level’s data'),
  live: mk({ base: '--m3-charge', metal: 0, rough: 0.4, coat: 0.3, emit: '--m3-charge', glow: 0.8, bloom: 1.4, label: 'the data you asked for' }),
  courier: paint('--hy-courier', 0.35, 0.5, 'the courier'),
  metal: mk({ ...M.steel, rough: 0.4, label: 'metal' }),
  tyre: mk({ ...M.rubber, label: 'tyre' }),
};

interface Statics { ground: Geo; road: Geo; ticks: Geo; core: Geo; coreTrim: Geo; desk: Geo; shelf: Geo; libWall: Geo; libCols: Geo; libRoof: Geo; libDoors: Geo; whWall: Geo; whRoof: Geo; whDoors: Geo; cityWall: Geo; cityRoof: Geo; cityWin: Geo; crates: Geo[]; posts: Geo; van: Geo; wheels: Geo; flag: Geo }
let memo: Statics | null = null;
function statics(): Statics {
  if (memo) return memo;
  const ground = bx(-16, ROAD_END + 8, -1.4, -0.2, -40, 14, 0.6);
  const road = merge([bx(-6, ROAD_END, -0.25, 0.12, -1.6, 1.6, 0.1), bx(-6, ROAD_END, 0.12, 0.16, -0.08, 0.08, 0)], 'road');
  const ticks = merge(TICKS.map((t) => col(distOf(t), 2.4, 0, 1.6, 0.18, 10)), 'ticks');
  // the core: a block with a heat spreader, and the register bench on its road side
  const core = merge([bx(-12, -2, 0, 8.4, -6, 4, 0.8), bx(-2, CORE.x1, 2.2, 3, -9, -4, 0.2), bx(CORE.x1 - 1, CORE.x1, 0, 2.2, -9, -4, 0.15)], 'core');
  const coreTrim = merge([bx(-10, -4, 8.4, 9.2, -3.5, 1.5, 0.3), bx(-2.2, -0.8, 3, 4, -1.2, 1.2, 0.2)], 'core trim');
  // the desk: a top on four turned legs
  const d = PLACES[0];
  const desk = merge([bx(d.x0, d.x1, 4.2, 5.2, -11, -3.5, 0.3), ...[d.x0 + 1, d.x1 - 1].flatMap((x) => [-10, -4.5].map((z) => col(x, z, 0, 4.2, 0.45)))], 'desk');
  // the shelf: a bookcase with its boards
  const s = PLACES[1];
  const shelf = merge([bx(s.x0, s.x1, 0, s.h, -9, -8, 0.15), bx(s.x0, s.x0 + 0.8, 0, s.h, -9, -3, 0.15), bx(s.x1 - 0.8, s.x1, 0, s.h, -9, -3, 0.15),
    ...[0, 5, 10, 14.2].map((y) => bx(s.x0, s.x1, y, y + 0.8, -9, -3, 0.15))], 'shelf');
  // the library: a hall, a portico of columns and a pitched roof
  const l = PLACES[2];
  const libWall = merge([bx(l.x0, l.x1, 0, l.h, -22, -9, 0.4), bx(l.x0 - 0.6, l.x1 + 0.6, -0.1, 0.8, -22.6, -3, 0.2)], 'library');
  const libCols = merge([l.x0 + 1.2, l.x0 + 4.4, l.x1 - 4.4, l.x1 - 1.2].map((cx) => col(cx, -4.5, 0.8, l.h - 1, 0.7, 18)), 'columns');
  const libRoof = merge([roof(l.x0 - 0.4, l.x1 + 0.4, l.h, -22.5, -3.5, 3.2), bx(l.x0 - 0.6, l.x1 + 0.6, l.h - 1, l.h, -9.5, -3.5, 0.2)], 'roof');
  const libDoors = merge(Array.from({ length: 3 }, (_, i) => bx(l.x0 + 2.5 + i * 3.2, l.x0 + 4 + i * 3.2, 0.8, 6, -9.05, -8.85, 0.1)), 'doors');
  // the warehouse across town: a long shed, big doors
  const w = PLACES[3];
  const whWall = bx(w.x0, w.x1, 0, w.h, -34, -10, 0.4);
  const whRoof = roof(w.x0 - 0.4, w.x1 + 0.4, w.h, -34.5, -9.5, 4);
  const whDoors = merge(Array.from({ length: 2 }, (_, i) => bx(w.x0 + 2.5 + i * 8.5, w.x0 + 8 + i * 8.5, 0, 12, -10.05, -9.85, 0.1)), 'doors');
  // another city: towers with rows of windows
  const c = PLACES[4], towers: [number, number, number, number, number][] = [[0, 7, 14, -16, -10], [8, 14, 30, -30, -18], [15, 22, 22, -20, -11], [23, 29, 26, -32, -21], [30, 34, 12, -15, -10]];
  const cityWall = merge(towers.map(([a, b, ht, z0, z1]) => bx(c.x0 + a, c.x0 + b, 0, (c.h * ht) / 30, z0, z1, 0.4)), 'towers');
  const cityRoof = merge(towers.map(([a, b, ht, z0, z1]) => { const top = (c.h * ht) / 30; return bx(c.x0 + a - 0.3, c.x0 + b + 0.3, top, top + 0.8, z0 - 0.3, z1 + 0.3, 0.2); }), 'tops');
  const cityWin = merge(towers.flatMap(([a, b, ht, , z1]) => { const top = (c.h * ht) / 30, out: Geo[] = []; for (let y = 3; y < top - 1; y += 4) out.push(bx(c.x0 + a + 1, c.x0 + b - 1, y, y + 1.2, z1 + 0.02, z1 + 0.14, 0.05)); return out; }), 'windows');
  // a crate of data for each level, larger the further out, on its place's surface; a post from it to the road
  const crates = LEVELS.map((lv, k) => {
    const x = levelX(lv), sz = 1.2 + k * 0.45, base = lv.place === 'core' ? 3 : lv.place === 'desk' ? 5.2 : lv.place === 'shelf' ? 0.8 : 0;
    return bx(x - sz, x + sz, base, base + 2 * sz, -7 - sz / 2, -7 + sz / 2, Math.min(0.35, sz * 0.25));
  });
  const posts = merge(LEVELS.map((lv) => col(levelX(lv), -2.2, 0, 0.5, 0.35, 12)), 'posts');
  // the courier: a little van, its wheels, a flag
  const van = merge([bx(-1.4, 1.4, 0.55, 1.9, -1, 1, 0.35), bx(0.3, 1.4, 1.9, 2.6, -0.9, 0.9, 0.25)], 'van');
  const wheel = (x: number, z: number) => { const m = new Float32Array(16); m.set([1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, x, 0.48, z, 1]); return transform(lathe([[0, -0.18], [0.42, -0.18], [0.48, -0.1], [0.48, 0.1], [0.42, 0.18], [0, 0.18]], { seg: 16, crease: 45 }), m); };
  const wheels = merge([wheel(-0.8, 1), wheel(0.8, 1), wheel(-0.8, -1), wheel(0.8, -1)], 'wheels');
  const flag = merge([col(-1, 0, 1.9, 4.3, 0.07, 6), bx(-1, 0.8, 3.3, 4.3, -0.06, 0.06, 0.03)], 'flag');
  memo = { ground, road, ticks, core, coreTrim, desk, shelf, libWall, libCols, libRoof, libDoors, whWall, whRoof, whDoors, cityWall, cityRoof, cityWin, crates, posts, van, wheels, flag };
  return memo;
}

/** The tour: the road, then a trip to the desk, the library, the warehouse and the other city (the beat sends the courier). */
export const TOUR_LEVELS = [null, 1, 3, 4, 5] as const;

export function hierarchyModel(p: HPose, narrow = false): Model3 {
  const S = statics(), items: Item[] = [];
  const add = (geo: Geo, mat: Material, name: string, group: string, extra: Partial<Item> = {}) => items.push({ geo, mat, name, group, ...extra });
  add(S.ground, MATS.ground, 'ground', 'ground', { shadow: false, cut: 'none' });
  add(S.road, MATS.road, 'road', 'road', { shadow: false, info: { note: 'distance along it is time: 20 units for each factor of ten, from 0.1 ns' } });
  add(S.ticks, MATS.tick, 'decade post', 'road', { info: { note: '1 ns, 10 ns, 100 ns, 1 µs, 10 µs, 100 µs' } });
  add(S.core, MATS.core, 'the core', 'core', { info: { note: 'the registers are in the core itself, on the bench beside it' } });
  add(S.coreTrim, MATS.metal, 'the core', 'core');
  add(S.desk, MATS.wood, 'desk (L1)', 'desk');
  add(S.shelf, MATS.shelf, 'shelf (L2)', 'shelf');
  add(S.libWall, MATS.wall, 'library (L3)', 'library');
  add(S.libCols, MATS.wall, 'library (L3)', 'library');
  add(S.libRoof, MATS.roof, 'library (L3)', 'library');
  add(S.libDoors, MATS.door, 'library (L3)', 'library');
  add(S.whWall, MATS.wall, 'warehouse (DRAM)', 'warehouse');
  add(S.whRoof, MATS.roof, 'warehouse (DRAM)', 'warehouse');
  add(S.whDoors, MATS.door, 'warehouse (DRAM)', 'warehouse');
  add(S.cityWall, MATS.wall, 'another city (SSD)', 'city');
  add(S.cityRoof, MATS.roof, 'another city (SSD)', 'city');
  add(S.cityWin, MATS.door, 'another city (SSD)', 'city');
  S.crates.forEach((g, k) => add(g, p.target === k ? MATS.live : MATS.mark, `${LEVELS[k].name}: its data`, 'crates', { info: { note: `${LEVELS[k].cap}; the crate’s size is not its capacity` } }));
  add(S.posts, MATS.tick, 'level post', 'road');
  const at: Vec3 = [p.x, 0, 0];
  add(S.van, MATS.courier, 'courier', 'courier', { at, info: { note: 'out with the request, back with the data; the trip takes a second or a few here, the clock shows the access’s real time' } });
  add(S.wheels, MATS.tyre, 'courier', 'courier', { at });
  add(S.flag, p.phase === 'back' ? MATS.live : MATS.core, 'courier', 'courier', { at });

  const anchors: StudioAnchor[] = hierarchyAnchors(narrow).map((a) => ({ ...a }));
  const view = (k: number) => followView(levelX(LEVELS[k]));
  const [, l1, l2, l3, dram, ssd] = LEVELS, t = (l: typeof l1) => `${fmtNs(l.ns)}, ${groupNum(cyclesOf(l.ns))} cycles`;
  const beats: Beat[] = [
    { title: 'Distance is time', text: `Each place stands as far from the core as its latency, on a log scale: ${SCALE} units for every factor of ten. On a straight scale the SSD would be ${groupNum(Math.round(ssd.ns / l1.ns))} times as far as the desk.`, view: overview(narrow) },
    { title: 'The desk: L1', text: `What you are using now is on the desk: ${t(l1)} there and back. The courier barely leaves.`, view: view(1), labels: false },
    { title: 'The library: L3', text: `The department’s books, shared by every core: ${t(l3)}. On the log scale it stands just past the shelf; in time it is ${(l3.ns / l2.ns).toFixed(1)} times as far as the shelf (${fmtNs(l2.ns)}).`, view: view(3), labels: false },
    { title: 'Across town: DRAM', text: `Everything else, in a warehouse across town: ${t(dram)}. A miss in every cache comes all the way out here: the trip the caches exist to save.`, view: view(4), labels: false },
    { title: 'Another city: the SSD', text: `A flash page read: ${fmtNs(ssd.ns)}, ${groupNum(Math.round(ssd.ns / dram.ns))} times DRAM. If a cycle were a second, this trip would take ${asSeconds(cyclesOf(ssd.ns))}.`, view: { ...overview(narrow), target: [100, 6, -6], dist: overview(narrow).dist * 0.9 } },
  ];
  return { items, anchors, beats, floor: -0.2, look: { exposure: 1.05 } };
}
