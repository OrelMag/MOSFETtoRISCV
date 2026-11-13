// A 6502-style gate for the studio renderer (DOM-free, tested): the two-input depletion-load NOR of lib/nmos.ts NNOR2 (ld, n0,
// n1) drawn as silicon-gate NMOS. Original geometry, not traced from any chip: a textbook layout to Mead & Conway's λ rules
// at λ = 4 µm (an 8 µm gate, the 1975 class), labelled "6502-style". The masks are rectangles in λ, rasterized at λ/2; each
// layer sits on what is under it (poly on field oxide, on gate oxide over a channel, straight on the diffusion in the buried
// contact; aluminium on the glass over either), so the steps are where the masks put them. Horizontal to scale in µm; heights
// × V (stated). The glass between poly and metal is left out so the layers show.

import { merge, roundedBox, transform, type Geo } from '../gl/kit/geo';
import { M, type Material } from '../gl/kit/materials';
import type { Beat, Item, Model3, StudioAnchor } from '../gl/kit/scene';
import type { OrbitView } from '../gl/camera';
import type { Mat4 } from '../gl/math';

/** λ in µm, the vertical factor, and true layer thicknesses (µm, typical of late-1970s silicon-gate NMOS). */
export const LAMBDA = 4, V = 4;
export const TRUE_UM = { fieldOx: 1, gateOx: 0.1, poly: 0.5, glass: 0.8, metal: 1, junction: 1.5 } as const;
const T = { fox: V * TRUE_UM.fieldOx, gox: V * TRUE_UM.gateOx, poly: V * TRUE_UM.poly, psg: V * TRUE_UM.glass, met: V * TRUE_UM.metal, xj: V * TRUE_UM.junction };

/** A mask rectangle in λ: x0, y0, x1, y1 (layout y up: GND at the bottom, VDD at the top). */
export type Rect = readonly [number, number, number, number];
export const CELL = { w: 28, h: 36 } as const;
export const MASKS: Record<'diff' | 'poly' | 'metal' | 'cut' | 'implant' | 'buried', readonly Rect[]> = {
  // pull-down a, pull-down b, the output node joining their drains, the load's strip, its VDD contact pad
  diff: [[4, 0, 8, 14], [16, 0, 20, 14], [4, 12, 20, 16], [10, 16, 12, 34], [9, 32, 13, 36]],
  // input a, input b, the load's gate and its tie down to the output node
  poly: [[1, 6, 10, 8], [14, 6, 23, 8], [8, 22, 14, 26], [8, 16, 12, 22]],
  // GND, VDD, the output: its pad on the node and the line out to the right
  metal: [[0, 0, 28, 4], [0, 32, 28, 36], [12, 12, 16, 16], [12, 12.5, 28, 15.5]],
  cut: [[5, 1, 7, 3], [17, 1, 19, 3], [10, 33, 12, 35], [13, 13, 15, 15]],
  implant: [[8.5, 20.5, 13.5, 27.5]],
  buried: [[9, 16, 13, 22]],
};
/** The transistors as lib/nmos.ts names them, each a channel where poly crosses diffusion outside the buried contact. */
export const DEVICES = {
  n0: { ch: [4, 6, 8, 8] as Rect, input: 'a', role: 'pull-down a' },
  n1: { ch: [16, 6, 20, 8] as Rect, input: 'b', role: 'pull-down b' },
  ld: { ch: [10, 22, 12, 26] as Rect, input: null, role: 'depletion load' },
} as const;
export type DevName = keyof typeof DEVICES;
/** W along the gate (across the current), L along the current: pull-downs conduct up and down, so W is x; the load too. */
export const wl = (n: DevName): { W: number; L: number } => { const [x0, y0, x1, y1] = DEVICES[n].ch; return { W: x1 - x0, L: y1 - y0 }; };
/** Mead & Conway's Z = L / W; a ratioed gate needs the load's Z at least 4 times a pull-down's. */
export const zOf = (n: DevName): number => wl(n).L / wl(n).W;
export const RATIO = zOf('ld') / zOf('n0');

const H = 2, NX = CELL.w * H, NY = CELL.h * H;
export function raster(rs: readonly Rect[]): Uint8Array {
  const g = new Uint8Array(NX * NY);
  for (const [x0, y0, x1, y1] of rs)
    for (let j = Math.max(0, Math.round(y0 * H)); j < Math.min(NY, Math.round(y1 * H)); j++)
      for (let i = Math.max(0, Math.round(x0 * H)); i < Math.min(NX, Math.round(x1 * H)); i++) g[j * NX + i] = 1;
  return g;
}
const R = Object.fromEntries(Object.entries(MASKS).map(([k, v]) => [k, raster(v)])) as Record<keyof typeof MASKS, Uint8Array>;
/** Channel cells: poly over diffusion, not buried. */
export const CHANNEL = R.poly.map((p, i) => p & R.diff[i] & (1 - R.buried[i]));

/** The channel regions found from the masks (4-connected), each with its box in λ. */
export function channels(): Rect[] {
  const seen = new Uint8Array(NX * NY), out: Rect[] = [];
  for (let s = 0; s < NX * NY; s++) {
    if (!CHANNEL[s] || seen[s]) continue;
    let x0 = NX, y0 = NY, x1 = 0, y1 = 0;
    const st = [s]; seen[s] = 1;
    while (st.length) {
      const c = st.pop()!, i = c % NX, j = (c - i) / NX;
      x0 = Math.min(x0, i); x1 = Math.max(x1, i + 1); y0 = Math.min(y0, j); y1 = Math.max(y1, j + 1);
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ii = i + di, jj = j + dj, n = jj * NX + ii;
        if (ii >= 0 && ii < NX && jj >= 0 && jj < NY && CHANNEL[n] && !seen[n]) { seen[n] = 1; st.push(n); }
      }
    }
    out.push([x0 / H, y0 / H, x1 / H, y1 / H]);
  }
  return out;
}

/** Layout λ to model coordinates (µm): x across, z toward the viewer for the bottom (GND) edge, y up. */
export const X = (lx: number) => (lx - CELL.w / 2) * LAMBDA;
export const Z = (ly: number) => (CELL.h / 2 - ly) * LAMBDA;
const tr = (x: number, y: number, z: number): Mat4 => { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; m[12] = x; m[13] = y; m[14] = z; return m; };
const bx = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): Geo =>
  transform(roundedBox(x1 - x0, y1 - y0, z1 - z0, 0, 0), tr((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2));
/** Boxes over the cells where `span` gives [bottom, top], a run per row of equal spans. */
function runs(span: (c: number) => readonly [number, number] | null): Geo[] {
  // runs per row, then a run carried down while the next row has the same one (rectangles, not stripes)
  type Run = { i: number; k: number; s0: number; s1: number; j0: number; j1: number };
  const done: Run[] = [];
  let open: Run[] = [];
  for (let j = 0; j < NY; j++) {
    const row: Run[] = [];
    let i = 0;
    while (i < NX) {
      const s = span(j * NX + i);
      if (!s) { i++; continue; }
      let k = i + 1;
      for (; k < NX; k++) { const t = span(j * NX + k); if (!t || t[0] !== s[0] || t[1] !== s[1]) break; }
      row.push({ i, k, s0: s[0], s1: s[1], j0: j, j1: j + 1 });
      i = k;
    }
    const next: Run[] = [];
    for (const r of row) {
      const o = open.find((q) => q.i === r.i && q.k === r.k && q.s0 === r.s0 && q.s1 === r.s1);
      if (o) { o.j1 = j + 1; next.push(o); } else next.push(r);
    }
    for (const o of open) if (!next.includes(o)) done.push(o);
    open = next;
  }
  done.push(...open);
  return done.map((r) => bx(X(r.i / H), X(r.k / H), r.s0, r.s1, Z(r.j1 / H), Z(r.j0 / H)));
}
const inRect = (c: number, [x0, y0, x1, y1]: Rect) => { const i = c % NX, j = (c - i) / NX; return i >= x0 * H && i < x1 * H && j >= y0 * H && j < y1 * H; };
const devAt = (c: number): DevName | null => (Object.keys(DEVICES) as DevName[]).find((n) => inRect(c, DEVICES[n].ch)) ?? null;

/** The top of the poly over a cell (null: no poly), and the base of the metal. */
const EPS = 0.03;
const polyBase = (c: number) => (R.buried[c] && R.diff[c] ? EPS : R.diff[c] ? T.gox : T.fox);
const polyTop = (c: number) => polyBase(c) + T.poly;
const metalBase = (c: number) => (R.poly[c] ? polyTop(c) : R.diff[c] ? EPS : T.fox) + T.psg;
export const HEIGHTS = { ...T, metalTop: T.fox + T.psg + T.met };

export const SUB_Y = -16;
const mk = (m: Material): Material => M.make(m);
export const MATS = {
  sub: mk({ ...M.silicon, label: 'p-type silicon substrate' }),
  diff: mk({ base: '--ng-diff', metal: 0.3, rough: 0.35, label: 'n+ diffusion (Mead–Conway mask colour: green)' }),
  fox: mk({ ...M.oxide, label: 'field oxide, 1 µm (drawn × 4 high)' }),
  gox: mk({ ...M.oxide, transmit: 0.2, label: 'gate oxide, 0.1 µm' }),
  poly: mk({ base: '--ng-poly', metal: 0.2, rough: 0.4, label: 'polysilicon (mask colour: red)' }),
  metal: mk({ base: '--ng-metal', metal: 1, rough: 0.32, label: 'aluminium (mask colour: blue)' }),
  cut: mk({ ...M.aluminium, label: 'contact: aluminium down to the diffusion' }),
  implant: mk({ base: '--ng-implant', metal: 0, rough: 0.4, label: 'depletion implant (mask colour: yellow)' }),
};
/** A channel: conducting (glow by its current) or not. */
const channelMat = (n: DevName, on: boolean, current: boolean): Material => mk({
  ...M.silicon, emit: n === 'ld' ? '--ng-load' : '--ng-on', glow: on ? (current ? 1 : 0.35) : 0, bloom: 1.2,
  label: n === 'ld' ? 'the load’s channel: always there (the implant), carries current only while the output is 0' : on ? 'channel, on' : 'channel, off',
});

/** The gate's state: inputs, output from lib/nmos.ts's rule (NOR), and whether current flows VDD → GND. */
export const stateOf = (a: boolean, b: boolean) => ({ a, b, y: !(a || b), current: a || b });

export const NG_HOME: OrbitView = { target: [0, 0, 6], yaw: 0.35, pitch: 0.7, dist: 245 };
export const CUT_X = X(11);

export function nmosGateModel(a: boolean, b: boolean): Model3 {
  const s = stateOf(a, b), items: Item[] = [];
  const add = (geo: Geo[], mat: Material, name: string, group: string, extra: Partial<Item> = {}) => { if (geo.length) items.push({ geo: merge(geo, name), mat, name, group, ...extra }); };
  const src = 'Mead & Conway, Introduction to VLSI Systems (1980): λ rules; λ = 4 µm here';
  const um = (r: Rect) => `${(r[2] - r[0]) * LAMBDA} × ${(r[3] - r[1]) * LAMBDA} µm`;
  add([bx(X(0), X(CELL.w), SUB_Y, 0, Z(CELL.h), Z(0))], MATS.sub, 'substrate', 'silicon');
  add(runs((c) => (R.diff[c] && !CHANNEL[c] ? [-T.xj, EPS] : null)), MATS.diff, 'n+ diffusion', 'silicon', { info: { dim: `${TRUE_UM.junction} µm deep (drawn × ${V})`, note: 'source, drain and wire at once: where the poly crosses it, it is cut into a transistor' } });
  add(runs((c) => (R.implant[c] && !R.diff[c] ? [-0.45, EPS] : null)), MATS.implant, 'depletion implant', 'silicon', { info: { dim: um(MASKS.implant[0]), source: src, note: 'arsenic under the load’s gate pulls its threshold below zero: a channel with no gate voltage' } });
  for (const n of Object.keys(DEVICES) as DevName[]) {
    const on = n === 'ld' ? true : n === 'n0' ? a : b, d = DEVICES[n], { W, L } = wl(n);
    add(runs((c) => (CHANNEL[c] && devAt(c) === n ? [-0.6, EPS] : null)), channelMat(n, on, s.current && (n === 'ld' || on)), n === 'ld' ? 'load channel' : `channel ${n}`, 'silicon', {
      info: { dim: `W ${W}λ × L ${L}λ = ${W * LAMBDA} × ${L * LAMBDA} µm, Z = L/W = ${zOf(n)}`, source: src, note: `${d.role} (lib/nmos.ts ${n})${n === 'ld' ? '' : `: on while ${d.input} = 1`}` },
    });
  }
  add(runs((c) => (!R.diff[c] ? [0, T.fox] : null)), MATS.fox, 'field oxide', 'oxide', { explode: [0, 6, 0] });
  add(runs((c) => (CHANNEL[c] ? [0, T.gox] : null)), MATS.gox, 'gate oxide', 'oxide', { explode: [0, 6, 0] });
  add(runs((c) => (R.poly[c] ? [polyBase(c), polyTop(c)] : null)), MATS.poly, 'polysilicon', 'poly', { explode: [0, 14, 0], info: { dim: `2λ = ${2 * LAMBDA} µm wide, ${TRUE_UM.poly} µm thick (drawn × ${V})`, note: 'the inputs and the load’s gate; it masks the diffusion, so each gate is aligned to its channel by itself' } });
  add(runs((c) => (R.cut[c] ? [EPS, metalBase(c)] : null)), MATS.cut, 'contacts', 'metal', { explode: [0, 24, 0] });
  add(runs((c) => (R.metal[c] ? [metalBase(c), metalBase(c) + T.met] : null)), MATS.metal, 'aluminium', 'metal', { explode: [0, 24, 0], info: { dim: `3λ wide or more, ${TRUE_UM.metal} µm thick (drawn × ${V})`, note: 'VDD, GND and the output; it steps down where the field oxide stops' } });

  const top = (lx: number, ly: number, y: number): [number, number, number] => [X(lx), y, Z(ly)];
  const sec = (ly: number, y: number): [number, number, number] => [CUT_X, y, Z(ly)];
  const anchors: StudioAnchor[] = [
    { text: 'VDD', p: top(3, 34, HEIGHTS.metalTop), side: 'l', n: [0, 1, 0], on: 'metal', whenCut: false },
    { text: 'GND', p: top(3, 2, HEIGHTS.metalTop), side: 'l', n: [0, 1, 0], on: 'metal', whenCut: false },
    { text: 'output y', p: top(25, 14, HEIGHTS.metalTop), side: 'r', n: [0, 1, 0], on: 'metal', whenCut: false },
    { text: 'input b', p: top(22, 7, T.fox + T.poly), side: 'r', n: [0, 1, 0], on: 'poly', whenCut: false },
    { text: 'input a', p: top(2, 7, T.fox + T.poly), side: 'l', n: [0, 1, 0], on: 'poly', whenCut: false },
    { text: 'depletion load', p: top(9, 24, T.fox + T.poly), side: 'l', n: [0, 1, 0], on: 'poly', whenCut: false },
    { text: 'buried contact', p: top(9, 18, T.poly), side: 'l', n: [0, 1, 0], on: 'poly', whenCut: false },
    { text: 'field oxide', p: top(2, 20, T.fox), side: 'l', n: [0, 1, 0], on: 'oxide', whenCut: false },
    // on the section along the load (beat 4)
    { text: 'VDD contact', p: sec(34, T.psg / 2), side: 'r', gutter: 'r', n: [1, 0, 0], whenCut: true },
    { text: 'depletion implant', p: sec(24, -0.3), side: 'r', gutter: 'r', n: [1, 0, 0], whenCut: true },
    { text: 'load gate (poly)', p: sec(24, T.gox + T.poly / 2), side: 'l', gutter: 'l', n: [1, 0, 0], whenCut: true },
    { text: 'buried contact', p: sec(19, T.poly / 2), side: 'l', gutter: 'l', n: [1, 0, 0], whenCut: true },
    { text: 'output node (n+)', p: sec(14, -T.xj / 2), side: 'l', gutter: 'l', n: [1, 0, 0], whenCut: true },
    { text: 'substrate', p: sec(24, -10), side: 'r', gutter: 'r', n: [1, 0, 0], whenCut: true },
  ];
  return { items, anchors, beats: beatsOf(), floor: SUB_Y, look: { exposure: 1 }, cuts: { planes: [{ n: [1, 0, 0], d: CUT_X }], open: [X(CELL.w) + 2] }, cutLabels: true };
}

/** The tour; nmosgate3dview.ts BEAT_INPUTS says which inputs each shows. */
function beatsOf(): Beat[] {
  const r = (n: DevName) => `${wl(n).W}λ wide and ${wl(n).L}λ long`;
  return [
    { title: 'Five masks, three transistors', text: `A two-input NOR the way a 1975 NMOS chip drew it, at λ = ${LAMBDA} µm: green diffusion, red polysilicon, blue aluminium, a yellow implant and black contact cuts. Wherever poly crosses diffusion there is a transistor; there are three, and no p-type transistor anywhere.`, view: { target: [0, 0, 0], yaw: 0, pitch: 1.3, dist: 230 }, cut: 0 },
    { title: 'Two pull-downs to ground', text: `Inputs a and b are poly lines across two diffusion strips that run from the output node down to GND, side by side: in parallel. Each is ${r('n0')}. With a = 1 its channel conducts and pulls the output to 0.`, view: { target: [X(12), 4, Z(9)], yaw: 0.3, pitch: 0.72, dist: 190 }, cut: 0, explode: 0.6, hide: ['metal'] },
    { title: 'The load', text: `Above the node the diffusion goes on to VDD under a third gate, ${r('ld')}: long and narrow, so it is weak. The yellow implant gives it a channel with no gate voltage, and its gate is tied to the output by a buried contact, where poly touches the diffusion with no oxide between: the always-on pull-up of the schematic.`, view: { target: [X(11), 6, Z(24)], yaw: 0.55, pitch: 0.62, dist: 180 }, cut: 0, explode: 0.7 },
    { title: 'Cut along the load', text: 'Sawn down the middle of the load: the VDD contact, the load’s channel with the implant under its gate, the buried contact, the output node. With a pull-down on, current runs this whole way down to GND.', view: { target: [CUT_X, -1, Z(24)], yaw: 1.42, pitch: 0.18, dist: 88 }, cut: 1 },
    { title: 'Why NMOS ran warm', text: `The pull-downs must beat the load: Mead and Conway’s rule is a load at least 4 times weaker, and here its Z (L/W) is ${zOf('ld')} against ${zOf('n0')}, ${RATIO} times. While the output is 0 current flows from VDD to GND all the time, so a chip of thousands of these gates warms with no clock running. CMOS later took that current away at the price of a fourth transistor.`, view: NG_HOME, cut: 0, explode: 0.6, hide: ['metal'] },
  ];
}
