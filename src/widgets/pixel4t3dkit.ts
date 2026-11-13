// One back-illuminated 4T pixel on the studio renderer (DOM-free, tested): the IMX183-class 2.4 µm pixel of
// pixel4t3dgeom.ts in true geometry, in µm, y up toward the light, y = 0 the front surface of the silicon. From the top:
// a microlens that is a real spherical cap on the square cell (neighbours would touch: its corners come down to the
// filter), the colour filter in its metal grid, three anti-reflection films, 3 µm of thinned silicon walled by deep
// trenches, the pinned photodiode at its foot; on the front side below, the transfer gate, the floating diffusion, the
// reset, follower and select transistors, their contacts, metal 1 and 2, the interlayer oxide and the carrier wafer. A
// section through the photodiode's middle is capped, so the silicon, the diode and the oxide show as solid faces.
// What is representative and what is measured is pixel4t3dgeom.ts's; every part's card says which.

import { roundedBox, lathe, sphere, type Geo } from '../gl/kit/geo';
import { M, type Material } from '../gl/kit/materials';
import type { Beat, Item, Model3, StudioAnchor } from '../gl/kit/scene';
import type { Vec3 } from '../gl/math';
import { absorptionDepth, CG_4T, VDD_PIX } from '../phys/imagesensor';
import {
  AR_FILMS, BACK, CF, DTI_W, FILTER_NM, FULL_WELL, FUNNEL, GRID_H, GRID_W, ILD_T, L, LENS, M1, M2, P_BACK, PITCH, POLY, SI_T, STI, STI_D, WAFER_T,
  phaseOf, type Filter, type PixState,
} from './pixel4t3dgeom';

const W = PITCH;
const SRC = {
  emva: 'FLIR EMVA 1288 report for the IMX183 (BFS-U3-200S6): pitch, full well',
  green: 'absorption depths: M. A. Green, Sol. Energy Mater. Sol. Cells 92 (2008)',
  dti: 'representative: Sony\'s back-side trenches are oxide-filled, about 150 nm (Fontaine, TechInsights); the IMX183\'s own is unpublished',
  rep: 'representative: Sony does not publish the IMX183\'s stack',
  layout: 'our layout, to scale in the 2.4 µm cell; a real pixel shares its reset, follower and select among two or four diodes',
  lens: 'illustrative: a spherical cap whose corners meet the filter (a touching lens); no IMX183 sag is published',
};

// ---------------------------------------------------------------- the microlens: a spherical cap on the square cell

/** The lens's sag at its centre (µm) and the sphere it is cut from: its corners (the half-diagonal) at the base. */
export const LENS_H = LENS[1] - LENS[0];
const HALF = W / 2, DIAG = HALF * Math.SQRT2;
export const LENS_R = (DIAG * DIAG + LENS_H * LENS_H) / (2 * LENS_H);
/** The lens's height over the filter at (x, z) from the cell's centre. */
export const lensHeight = (x: number, z: number): number => Math.max(0, Math.sqrt(Math.max(0, LENS_R * LENS_R - x * x - z * z)) - (LENS_R - LENS_H));

/** A closed solid: the cap's surface over the square, four walls down to y = 0 and the base (so a cut caps it). */
function lensSolid(n: number, x0 = -HALF, x1 = HALF): Geo {
  const p: number[] = [], nr: number[] = [], idx: number[] = [];
  const v = (x: number, y: number, z: number, a: number, b: number, c: number) => { p.push(x, y, z); nr.push(a, b, c); return p.length / 3 - 1; };
  const tri = (a: number, b: number, c: number, out: Vec3) => {
    const P = (i: number): Vec3 => [p[3 * i], p[3 * i + 1], p[3 * i + 2]];
    const A = P(a), B = P(b), C = P(c), e1 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], e2 = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
    const g = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    if (g[0] * out[0] + g[1] * out[1] + g[2] * out[2] >= 0) idx.push(a, b, c); else idx.push(a, c, b);
  };
  const at = (i: number) => -HALF + (W * i) / n, ax = (i: number) => x0 + ((x1 - x0) * i) / n, top: number[][] = [];
  for (let i = 0; i <= n; i++) {
    top.push([]);
    for (let j = 0; j <= n; j++) {
      const x = ax(i), z = at(j), y = lensHeight(x, z), k = Math.hypot(x, y + LENS_R - LENS_H, z) || 1;
      top[i].push(v(x, y, z, y > 0 ? x / k : 0, y > 0 ? (y + LENS_R - LENS_H) / k : 1, y > 0 ? z / k : 0));
    }
  }
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const a = top[i][j], b = top[i + 1][j], c = top[i + 1][j + 1], d = top[i][j + 1];
    tri(a, b, c, [0, 1, 0]); tri(a, c, d, [0, 1, 0]);
  }
  // walls: along each edge, the cap's profile down to the base, flat-shaded outward
  const walls: [Vec3, (t: number) => [number, number]][] = [
    [[0, 0, -1], (t) => [ax(t), -HALF]], [[1, 0, 0], (t) => [x1, at(t)]], [[0, 0, 1], (t) => [ax(t), HALF]], [[-1, 0, 0], (t) => [x0, at(t)]],
  ];
  for (const [o, xz] of walls) {
    const up: number[] = [], dn: number[] = [];
    for (let t = 0; t <= n; t++) { const [x, z] = xz(t); up.push(v(x, lensHeight(x, z), z, o[0], 0, o[2])); dn.push(v(x, 0, z, o[0], 0, o[2])); }
    for (let t = 0; t < n; t++) { tri(dn[t], dn[t + 1], up[t + 1], o); tri(dn[t], up[t + 1], up[t], o); }
  }
  // the base: a fan through the walls' own bottom points, so every edge is shared (closed, for the cut's cap)
  const c = v((x0 + x1) / 2, 0, 0, 0, -1, 0);
  for (const [, xz] of walls) for (let t = 0; t < n; t++) {
    const [xa, za] = xz(t), [xb, zb] = xz(t + 1);
    tri(c, v(xa, 0, za, 0, -1, 0), v(xb, 0, zb, 0, -1, 0), [0, -1, 0]);
  }
  return { name: 'microlens', positions: new Float32Array(p), normals: new Float32Array(nr), indices: new Uint32Array(idx), min: [x0, 0, -HALF], max: [x1, LENS_H, HALF] };
}

// ---------------------------------------------------------------- geometry, built once per detail

type Detail = 'full' | 'flat';
const boxes = new Map<string, Geo>();
/** A box over x, y, z ranges (µm), its edges rounded a little; placed by its centre. */
function bx(x: readonly number[], y: readonly number[], z: readonly number[], r = 0.01): { geo: Geo; at: Vec3 } {
  const w = x[1] - x[0], hh = y[1] - y[0], d = z[1] - z[0], key = `${w.toFixed(4)},${hh.toFixed(4)},${d.toFixed(4)},${r}`;
  let geo = boxes.get(key);
  if (!geo) { geo = roundedBox(w, hh, d, Math.min(r, w / 3, hh / 3, d / 3), 2); boxes.set(key, geo); }
  return { geo, at: [(x[0] + x[1]) / 2, (y[0] + y[1]) / 2, (z[0] + z[1]) / 2] };
}
const lenses = new Map<Detail, Geo>(), rods = new Map<string, Geo>();
const lens = (d: Detail) => { let g = lenses.get(d); if (!g) { g = lensSolid(d === 'full' ? 40 : 10); lenses.set(d, g); } return g; };
/** The neighbours' lenses: the half of each that lies over this block (a left half, a right half). */
const halfLenses = new Map<string, Geo>();
const halfLens = (d: Detail, side: -1 | 1) => { const k = `${d}${side}`; let g = halfLenses.get(k); if (!g) { g = side < 0 ? lensSolid(d === 'full' ? 20 : 5, 0, HALF) : lensSolid(d === 'full' ? 20 : 5, -HALF, 0); halfLenses.set(k, g); } return g; };
/** A round plug (contact or via) between two heights. */
function plug(x: number, z: number, y0: number, y1: number, r = 0.035): { geo: Geo; at: Vec3 } {
  const key = `${(y1 - y0).toFixed(4)},${r}`;
  let geo = rods.get(key);
  if (!geo) { geo = lathe([[0, 0], [r, 0], [r, y1 - y0], [0, y1 - y0]], { seg: 14 }); rods.set(key, geo); }
  return { geo, at: [x, Math.min(y0, y1), z] };
}

export const ELECTRON = sphere(0.04, 10, 6), PHOTON = sphere(0.03, 8, 5);

// ---------------------------------------------------------------- the model at a state

export interface PixPose { s: PixState; filter: Filter }
const mid = (a: readonly number[]) => (a[0] + a[1]) / 2;
const f2 = (v: number) => (v < 1 ? v.toFixed(2) : v.toFixed(1));

/** The cut: a plane through the photodiode's middle removes the half nearer the camera (z below it). */
export const CUT_Z = mid(L.pd.z);
const CUT_OPEN = 0.6;
export const CUT: Model3['cuts'] = { planes: [{ n: [0, 0, -1], d: -CUT_Z }], open: [CUT_OPEN] };
/** Where the cut stands at knob k (0 none … 1): particles in front of it are not drawn. */
export const cutAt = (k: number): number => (k <= 0 ? -Infinity : -(CUT_OPEN + (-CUT_Z - CUT_OPEN) * k));

export function pixModel(pose: PixPose, detail: Detail = 'full'): Model3 {
  const items: Item[] = [], s = pose.s, ph = phaseOf(s), on = { rst: !!ph?.rst, tx: !!ph?.tx, sel: !!ph?.sel };
  const put = (b: { geo: Geo; at: Vec3 }, mat: Material, o: Partial<Item>) => items.push({ geo: b.geo, at: b.at, mat, ...o });
  const tok = (base: `--${string}`, o: Partial<Material> = {}): Material => M.make({ base, metal: 0, rough: 0.5, ...o });
  const hot = (m: Material, k: number) => (k > 0 ? M.glow(m, '--px-hot', k) : m);

  // ---- the front side, below the silicon: wafer, oxide, metal, gates
  put(bx([0, W], [-ILD_T - WAFER_T, -ILD_T], [0, W]), M.tint(M.silicon, [0.6, 0.62, 0.68], 'silicon (the bonded carrier wafer)'), { name: 'carrier wafer', group: 'wafer', explode: [0, -2.2, 0], info: { dim: `${WAFER_T} µm drawn of hundreds`, source: SRC.rep, note: 'the wafer the thinned sensor is bonded to, face down; in a stacked sensor it holds the logic' } });
  put(bx([0, W], [-ILD_T, 0], [0, W]), M.make({ base: '--m3-oxide', metal: 0, rough: 0.35, label: 'silicon dioxide (interlayer)' }), { name: 'interlayer oxide', group: 'front', explode: [0, -1.1, 0], order: 1, shadow: false, info: { dim: `${ILD_T} µm`, source: SRC.rep, note: 'insulates the metal levels from each other and from the silicon' } });
  const metal = { ...M.copper, label: 'copper (representative)' }, metalLit = on.sel ? M.glow(metal, '--px-hot', 0.45) : metal;
  const cz = mid(L.fd.z), fdX = mid(L.fd.x), sfX = mid(L.sf.x), sz = mid(L.strip.z), vddX = 2.15, colX = mid(L.col.x), sfDx = mid(L.sfD.x);
  const tungsten = M.make({ base: [0.62, 0.63, 0.66], metal: 1, rough: 0.35, label: 'tungsten' });
  const mInfo = (what: string) => ({ dim: `metal 1 at ${-M1[1]}–${-M1[0]} µm, metal 2 at ${-M2[1]}–${-M2[0]} µm below the surface`, source: SRC.rep, note: what });
  const fdWire = { name: 'FD to the follower\'s gate (metal 1)', group: 'metal', explode: [0, -1.1, 0] as Vec3, info: mInfo('the one wire that makes it a source follower: the floating diffusion drives the follower\'s gate') };
  put(plug(fdX, cz, M1[1], 0), on.sel ? M.glow(tungsten, '--px-hot', 0.45) : tungsten, fdWire);
  for (const [x, y, z] of [[[1.68, fdX + 0.05], M1, [cz - 0.05, cz + 0.05]], [[1.63, 1.73], M1, [cz - 0.05, 1.62]], [[sfX - 0.05, 1.73], M1, [1.52, 1.62]], [[sfX - 0.05, sfX + 0.05], M1, [1.52, sz]]] as const)
    put(bx(x, y, z, 0.015), metalLit, fdWire);
  put(plug(sfX, sz, M1[1], POLY[0]), on.sel ? M.glow(tungsten, '--px-hot', 0.45) : tungsten, fdWire);
  const sampling = on.sel && !!ph?.sample;
  put(bx([colX - 0.08, colX + 0.08], M2, [0, W], 0.02), sampling ? M.glow(metal, '--px-hot', 0.6) : metal, { name: 'column line (metal 2)', group: 'metal', explode: [0, -1.1, 0], info: mInfo('shared by every pixel in the column: the selected row\'s follower drives it to the column\'s sampler') });
  put(plug(colX, sz, M2[1], 0), tungsten, { name: 'column line (metal 2)', group: 'metal', explode: [0, -1.1, 0] });
  const supply = { name: 'supply (metal 2)', group: 'metal', explode: [0, -1.1, 0] as Vec3, info: mInfo(`the pixel supply, ${VDD_PIX} V: the reset drain and the follower's drain`) };
  put(bx([vddX - 0.08, vddX + 0.08], M2, [0, W], 0.02), metal, supply);
  put(plug(vddX, mid(L.vddRst.z), M2[1], 0), tungsten, supply);
  put(plug(sfDx, sz, M1[0], 0), tungsten, supply);
  put(bx([sfDx - 0.05, vddX + 0.05], M1, [sz + 0.17, sz + 0.27], 0.015), metal, supply);
  put(plug(vddX, sz + 0.22, M2[1], M1[0]), tungsten, supply);
  // gates: polysilicon under the front surface, lit while on
  const poly = M.polysilicon;
  const gate = (x: readonly number[], z: readonly number[], lit: boolean, name: string, note: string) =>
    put(bx(x, POLY, z, 0.02), hot(poly, lit ? 0.6 : 0), { name, group: 'gates', explode: [0, -0.5, 0], info: { dim: `${(x[1] - x[0]).toFixed(2)} × ${(z[1] - z[0]).toFixed(2)} µm, ${-POLY[0]} µm poly`, source: SRC.layout, note } });
  gate(L.tg.x, L.tg.z, on.tx, 'xfer: transfer gate', 'lowers the barrier between the photodiode and the floating diffusion: the photodiode empties completely');
  gate(L.rst.x, L.rst.z, on.rst, 'reset', 'connects the floating diffusion to the supply, emptying it');
  gate(L.sf.x, L.strip.z, false, 'sf: source follower', 'its gate is the floating diffusion\'s voltage; it copies it onto the column');
  gate(L.rs.x, L.strip.z, on.sel, 'rs: row select', 'connects this row\'s follower to the column line');

  // ---- the silicon: slab, photodiode, diffusions, isolation, the funnel, the lit-side p+ layer
  const si = M.make({ base: [0.52, 0.55, 0.62], metal: 0.25, rough: 0.35, label: 'silicon, thinned' });
  put(bx([0, W], [0, SI_T], [0, W], 0.005), si, { name: 'silicon, lit from the back', group: 'silicon', order: 0, shadow: false, info: { dim: `${W} × ${W} µm, ${SI_T} µm thick`, source: SRC.emva + '; collecting depth from imagesensor.ts STACK_BSI', note: 'p-type epitaxial silicon, thinned and turned over so the light arrives from the back' } });
  put(bx(L.pd.x, L.pd.y, L.pd.z, 0.04), M.make({ base: '--m3-n', metal: 0, rough: 0.4, label: 'n-type silicon' }), { name: 'pd: pinned photodiode', group: 'diode', order: 3, shadow: false, info: { dim: `${(L.pd.x[1] - L.pd.x[0]).toFixed(2)} × ${(L.pd.z[1] - L.pd.z[0]).toFixed(2)} µm, ${L.pd.y[0]}–${L.pd.y[1]} µm deep`, source: SRC.rep, note: `n under p+: fully depleted, it holds up to ${FULL_WELL} e⁻ and empties completely through the transfer gate` } });
  put(bx(L.pd.x, [0, L.pin.y], L.pd.z, 0.02), tok('--m3-p', { label: 'p+ silicon' }), { name: 'p+ pinning layer', group: 'diode', info: { dim: `${L.pin.y} µm`, source: SRC.rep, note: 'pins the surface at ground: no surface states to leak current or trap charge' } });
  const nplus = tok('--px-nplus', { label: 'n+ silicon' });
  const fdDrop = ph ? Math.min(1, Math.max(0, (VDD_PIX - ph.fd) / (FULL_WELL * CG_4T * 1e-6))) : 0;
  put(bx(L.fd.x, [0, L.fd.y], L.fd.z, 0.02), hot(nplus, 0.9 * fdDrop), { name: 'fd: floating diffusion', group: 'diode', info: { dim: `${(L.fd.x[1] - L.fd.x[0]).toFixed(2)} × ${(L.fd.z[1] - L.fd.z[0]).toFixed(2)} µm`, source: SRC.layout, note: `${CG_4T} µV per electron (illustrative): the charge becomes a voltage here` } });
  put(bx(L.vddRst.x, [0, L.fd.y], L.vddRst.z, 0.02), nplus, { name: 'reset drain', group: 'diode', info: { source: SRC.layout, note: 'n+ at the supply: where the reset empties the floating diffusion to' } });
  for (const d of [L.sfD, L.mid, L.col]) put(bx(d.x, [0, L.fd.y], L.strip.z, 0.02), d === L.col && on.sel ? hot(nplus, 0.3) : nplus, { name: 'n+ source / drain', group: 'diode', info: { source: SRC.layout, note: 'the follower and select transistors in series, from the supply to the column line' } });
  const oxide = M.make({ base: '--px-sti', metal: 0, rough: 0.2, label: 'silicon dioxide (trench fill)' });
  put(bx([DTI_W, W - DTI_W], [0, STI_D], STI.z, 0.01), oxide, { name: 'STI: shallow trench', group: 'isolation', info: { dim: `${STI_D} µm deep`, source: SRC.rep, note: 'oxide between the photodiode and the transistors' } });
  const dti = M.make({ base: '--px-dti', metal: 0, rough: 0.25, label: 'silicon dioxide (trench fill)' }), dInfo = { dim: `${DTI_W} µm inside each edge (${2 * DTI_W} µm shared)`, source: SRC.dti, note: 'the full depth of the silicon: an electron born near the edge stays in its own pixel' };
  for (const [x, z] of [[[0, DTI_W], [0, W]], [[W - DTI_W, W], [0, W]], [[DTI_W, W - DTI_W], [W - DTI_W, W]], [[DTI_W, W - DTI_W], [0, DTI_W]]] as const)
    put(bx(x, [0, SI_T], z, 0.005), dti, { name: 'DTI: deep trench', group: 'isolation', order: 2, shadow: false, info: dInfo });
  // the funnel of built-in potential (graded doping) that steers electrons born at the back into the diode: a sketch
  const gTop = SI_T - P_BACK, gBot = L.pd.y[1] + 0.02, inset = 0.1;
  for (let k = 0; k < FUNNEL; k++) {
    const t = (k + 0.5) / FUNNEL, a = gTop + (gBot - gTop) * (k / FUNNEL), b = gTop + (gBot - gTop) * ((k + 1) / FUNNEL), lerp = (full: number, pd: number) => full + (pd - full) * t;
    put(bx([lerp(inset, L.pd.x[0]), lerp(W - inset, L.pd.x[1])], [b, a], [lerp(inset, L.pd.z[0]), lerp(W - inset, L.pd.z[1])], 0.005),
      M.make({ base: '--m3-n', metal: 0, rough: 0.5, transmit: 0.88 - 0.25 * t, label: 'graded n doping (a sketch)' }), { name: 'potential funnel', group: 'funnel', order: 1, shadow: false, info: { source: 'a sketch: the field comes from graded doping and deep implants', note: 'steers electrons born near the back surface into the photodiode' } });
  }
  put(bx([DTI_W, W - DTI_W], [SI_T - P_BACK, SI_T], [DTI_W, W - DTI_W], 0.005), tok('--m3-p', { label: 'p+ silicon' }), { name: 'p+ back layer', group: 'silicon', info: { dim: `${P_BACK} µm drawn (5 × the 0.01 µm dead layer)`, source: SRC.rep, note: 'an accumulation layer at the lit surface: electrons born here recombine before they can be collected' } });

  // ---- the lit side: films, the grid, the filter, the lens
  let y = SI_T;
  AR_FILMS.forEach((f, i) => {
    put(bx([0, W], [y, y + f.t], [0, W], 0.003), M.make({ base: `--px-ar${i}`, metal: 0, rough: 0.15, coat: 0.5, label: f.name }), { name: 'anti-reflection films', group: 'films', explode: [0, 0.6, 0], order: 4 + i, shadow: false, info: { dim: AR_FILMS.map((a) => `${a.name} ${a.t} µm`).join(', '), source: SRC.rep + '; the last two a quarter wave at 550 nm (λ / 4n)', note: 'silicon reflects a third of the light without them' } });
    y += f.t;
  });
  const grid = { ...M.aluminium, label: 'tungsten or aluminium grid (representative)' };
  for (const [x, z] of [[[0, GRID_W], [0, W]], [[W - GRID_W, W], [0, W]], [[GRID_W, W - GRID_W], [W - GRID_W, W]], [[GRID_W, W - GRID_W], [0, GRID_W]]] as const)
    put(bx(x, [BACK, BACK + GRID_H], z, 0.01), grid, { name: 'metal grid', group: 'filter', explode: [0, 1.1, 0], info: { dim: `${GRID_H} µm tall, ${2 * GRID_W} µm shared`, source: SRC.rep, note: 'keeps light that enters one filter from leaking into the neighbour' } });
  put(bx([GRID_W, W - GRID_W], CF, [GRID_W, W - GRID_W], 0.01), M.make({ base: `--px-${pose.filter}`, metal: 0, rough: 0.35, label: 'pigmented resist' }), { name: 'colour filter', group: 'filter', explode: [0, 1.1, 0], order: 7, shadow: false, info: { dim: `${(CF[1] - CF[0]).toFixed(1)} µm`, source: SRC.rep, note: `${pose.filter === 'b' ? 'blue' : pose.filter === 'g' ? 'green' : 'red'}: one of the Bayer mosaic's four (red, two green, blue)` } });
  items.push({ geo: lens(detail), at: [W / 2, LENS[0], W / 2], mat: { ...M.glass, base: '--px-lens', transmit: 0.92, label: 'polymer microlens' }, name: 'microlens', group: 'lens', explode: [0, 1.8, 0], order: 8, info: { dim: `${W} µm square, ${LENS_H.toFixed(2)} µm sag (a sphere of r ${LENS_R.toFixed(2)} µm)`, source: SRC.lens, note: 'focuses the light that falls on the whole cell onto the photodiode, past the grid' } });
  // ---- half of each neighbour along the row (red filters: a Bayer row runs green, red, green, red), so the block reads as
  // part of an array and this pixel's cut face sits in the middle of it; simplified: no transistors of their own
  const nb = { name: 'neighbouring pixel', group: 'neighbours', info: { source: SRC.layout, note: 'half of the next pixel in the row, red-filtered (a Bayer row alternates green and red); drawn without its own transistors' } };
  const red = M.make({ base: '--px-r', metal: 0, rough: 0.35, label: 'pigmented resist (red)' });
  for (const sx of [-1, 1] as const) {
    const X = (a: number, b: number): [number, number] => (sx < 0 ? [-HALF + a, -HALF + b] : [W + HALF - b, W + HALF - a]), full = X(0, HALF);
    put(bx(full, [-ILD_T - WAFER_T, -ILD_T], [0, W]), M.tint(M.silicon, [0.6, 0.62, 0.68], 'silicon (the bonded carrier wafer)'), { ...nb, explode: [0, -2.2, 0] });
    put(bx(full, [-ILD_T, 0], [0, W]), M.make({ base: '--m3-oxide', metal: 0, rough: 0.35, label: 'silicon dioxide (interlayer)' }), { ...nb, explode: [0, -1.1, 0] });
    put(bx(full, [0, SI_T], [0, W], 0.005), si, nb);
    put(bx(sx < 0 ? [-HALF + 0.3, -0.25] : [W + 0.25, W + HALF - 0.3], L.pd.y, L.pd.z, 0.04), M.make({ base: '--m3-n', metal: 0, rough: 0.4, label: 'n-type silicon' }), nb);
    put(bx(sx < 0 ? [-DTI_W, 0] : [W, W + DTI_W], [0, SI_T], [0, W], 0.005), dti, nb);
    let yy = SI_T;
    AR_FILMS.forEach((fl, i) => { put(bx(full, [yy, yy + fl.t], [0, W], 0.003), M.make({ base: `--px-ar${i}`, metal: 0, rough: 0.15, label: fl.name }), { ...nb, explode: [0, 0.6, 0] }); yy += fl.t; });
    put(bx(sx < 0 ? [-GRID_W, 0] : [W, W + GRID_W], [BACK, BACK + GRID_H], [0, W], 0.01), grid, { ...nb, explode: [0, 1.1, 0] });
    put(bx(sx < 0 ? [-HALF, -GRID_W] : [W + GRID_W, W + HALF], CF, [GRID_W, W - GRID_W], 0.01), red, { ...nb, explode: [0, 1.1, 0] });
    items.push({ geo: halfLens(detail, sx), at: [sx < 0 ? -HALF : W + HALF, LENS[0], W / 2], mat: { ...M.glass, base: '--px-lens', transmit: 0.92, label: 'polymer microlens' }, ...nb, explode: [0, 1.8, 0], order: 8 });
  }
  return { items, cuts: CUT, anchors: ANCHORS, beats: beats(), floor: -ILD_T - WAFER_T };
}

// ---------------------------------------------------------------- labels and tour

const Z = CUT_Z, FRONT: Vec3 = [0, 0, -1];
const ANCHORS: StudioAnchor[] = [
  { text: 'microlens', p: [W * 0.85, LENS[0] + lensHeight(W * 0.35, Z - W / 2), Z], side: 'r', n: [0.3, 1, -0.5], on: 'lens' },
  { text: 'colour filter', p: [W - GRID_W, mid(CF), Z], side: 'r', n: FRONT, on: 'filter' },
  { text: 'silicon', p: [W, SI_T * 0.75, Z], side: 'r', n: FRONT },
  { text: 'pd: photodiode', p: [L.pd.x[0] + 0.1, mid(L.pd.y), Z], side: 'l', n: FRONT },
  { text: 'xfer', p: [mid(L.tg.x), POLY[0], Z], side: 'b', n: [0, -1, -0.5], minor: true, on: 'gates' },
  { text: 'fd: floating diffusion', p: [L.fd.x[1], L.fd.y / 2, Z], side: 'r', n: FRONT },
  { text: 'reset', p: [L.rst.x[1], POLY[0] / 2, mid(L.rst.z)], side: 'r', n: [1, 0, 0], minor: true, on: 'gates' },
  { text: 'sf', p: [mid(L.sf.x), POLY[0], L.strip.z[0]], side: 'l', n: [0, -1, -0.5], minor: true, on: 'gates' },
  { text: 'rs', p: [mid(L.rs.x), POLY[0], L.strip.z[0]], side: 'b', n: [0, -1, -0.5], minor: true, on: 'gates' },
  { text: 'DTI', p: [W - DTI_W / 2, SI_T * 0.4, Z], side: 'r', n: FRONT, minor: true },
  { text: 'AR films, p+', p: [W, SI_T + 0.1, Z], side: 'r', n: FRONT, minor: true, on: 'films' },
  { text: 'carrier wafer', p: [W, -ILD_T - WAFER_T / 2, Z], side: 'r', n: FRONT, minor: true, on: 'wafer' },
  { text: 'column line (metal 2)', p: [mid(L.col.x), M2[0], Z], side: 'l', n: [0, -1, -0.4], on: 'metal' },
];

export const PIX_HOME = { target: [1.2, 1.4, 1.2] as Vec3, yaw: 2.85, pitch: 0.22, dist: 13 };
export const PIX_HOME_FRAME = ['lens', 'filter', 'films', 'silicon', 'diode', 'gates', 'metal', 'front', 'wafer', 'neighbours'];
/** Shown only in their own beat: the funnel's sheets. */
export const PIX_HIDDEN = ['funnel'];

function beats(): Beat[] {
  const d = (f: Filter) => f2(absorptionDepth(FILTER_NM[f]));
  return [
    { title: 'One pixel', text: `One ${W} µm pixel of a back-illuminated sensor (the IMX183 class), cut through its photodiode. The light comes from above; the transistors are on the front side, below the silicon, out of its way.`, view: PIX_HOME, frame: [], cut: 1, explode: 0 },
    { title: 'Into the silicon', text: `The microlens gathers the light on the whole ${W} µm cell; the filter passes one colour; three films cut the reflection at the silicon. The lens is only about four wavelengths of green light across, so ray optics is only a rough picture here.`, view: { target: [1.2, 3.6, 1.2], yaw: 2.6, pitch: 0.25, dist: 7 }, frame: ['lens', 'filter', 'films'], cut: 1, explode: 0 },
    { title: 'Where light is absorbed', text: `Silicon absorbs light at a depth set by its colour: 1/e at ${d('b')} µm for the blue filter's ${FILTER_NM.b} nm, ${d('g')} µm for green's ${FILTER_NM.g} nm and ${d('r')} µm for red's ${FILTER_NM.r} nm, deeper than the ${SI_T} µm of silicon, so some red passes straight through.`, view: { target: [1.2, 1.5, 1.2], yaw: 2.75, pitch: 0.15, dist: 9 }, frame: ['silicon', 'diode'], show: ['silicon', 'diode', 'isolation', 'funnel'], hide: [], cut: 1, explode: 0 },
    { title: 'The pinned photodiode', text: `Electrons collect in the n region under its p+ layer. The transfer gate beside it is a door: open, it empties the diode completely onto the floating diffusion, which turns the charge into a voltage (${CG_4T} µV per electron here).`, view: { target: [1.6, 0.4, 1.0], yaw: 2.4, pitch: 0.2, dist: 5 }, frame: ['diode', 'gates'], show: ['diode', 'gates'], cut: 1, explode: 0 },
    { title: 'The four transistors', text: 'From below: the transfer gate, the reset, the source follower whose gate is the floating diffusion, and the row select that hands its copy to the column line. Metal 1 joins the floating diffusion to the follower\'s gate.', view: { target: [1.2, -0.4, 1.4], yaw: 2.9, pitch: -0.75, dist: 7 }, frame: ['gates', 'metal'], show: ['gates', 'metal', 'diode'], hide: ['wafer', 'front', 'neighbours', 'funnel'], cut: 0, explode: 0 },
    { title: 'Walls between pixels', text: `Deep trenches of oxide run the full ${SI_T} µm round the pixel, so an electron born near the edge stays here; a shallow trench separates the photodiode from the transistors.`, view: { target: [1.2, 1.5, 1.2], yaw: 2.3, pitch: 0.55, dist: 9 }, frame: ['isolation'], show: ['isolation', 'diode'], cut: 1, explode: 0 },
    { title: 'How it is made', text: 'Pulled apart, in the order light meets it: lens, filter in its grid, films, the silicon with its diode, the gates and metal on the front side, the oxide, and the carrier wafer the thinned sensor is bonded to face down.', view: { target: [1.2, 1.2, 1.2], yaw: 2.65, pitch: 0.2, dist: 18 }, frame: [], cut: 0, explode: 1 },
  ];
}
