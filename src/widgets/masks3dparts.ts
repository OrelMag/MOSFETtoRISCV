// A chip built mask by mask, as parts (DOM-free, tested): the standard cell of chapter silicon's layout step, taken through
// the process in the order of sky130's flow (isolation first, then the well, gate stack, implants, contacts, metal).
// Layout x runs across the cell, layout y down it, layout z up; the stage's y is up, so (x, y, z) → (x, z, y).
//
// The mask set uses sky130's names, not the layout layers one to one:
//   diff    active area: its complement is etched into shallow trenches and filled (STI)
//   nwell   the PMOS pocket
//   poly    the gate pattern (the only mask whose shift moves the transistor)
//   nsdm    n+ source/drain implant: a WINDOW over the NMOS row, larger than the diffusion
//   psdm    p+ implant: the same over the PMOS row
//   licon1  contacts;  met1  metal 1
// An implant window only says where ions may land; they reach silicon where the window overlaps active area that the
// gate (or the field oxide) does not cover. That is the whole of self-alignment, and it is computed here, not drawn.
// Sources: SkyWater PDK "Layers" (nwell, diff, tap, poly, nsdm, psdm, licon1, li1, mcon, met1..met5; nsdm/psdm enclose
// diff by 0.125 µm); Weste & Harris, CMOS VLSI Design ch. 3 (STI, then wells; the self-aligned gate).

import type { RGB, RGBA } from '../gl/instances';
import type { Vec3 } from '../gl/math';
import { box, cyl, type Anchor, type Part } from '../gl/parts';
import { disjoint } from './cellgeom';
import type { Cell } from './silicon';

export type R = [number, number, number, number];
export type MaskName = 'diff' | 'nwell' | 'poly' | 'nsdm' | 'psdm' | 'licon1' | 'met1';
/** What lands on the wafer (and gets a legend chip). */
export type Layer = 'sti' | 'nwell' | 'poly' | 'ndiff' | 'pdiff' | 'contact' | 'metal';
export const LAYERS: Layer[] = ['sti', 'nwell', 'poly', 'ndiff', 'pdiff', 'contact', 'metal'];

/** The step (silicon.ts FAB, same indices) at which each layer first lands. */
export const LAND_AT: Record<Layer, number> = { sti: 1, nwell: 2, poly: 3, ndiff: 6, pdiff: 7, contact: 8, metal: 9 };
/** The mask in use at each step (null: none; lithography and etch both use the poly reticle). */
export const MASK_AT: (MaskName | null)[] = [null, 'diff', 'nwell', null, 'poly', 'poly', 'nsdm', 'psdm', 'licon1', 'met1'];
export const MASK_NAME: Record<MaskName, string> = { diff: 'active (diff)', nwell: 'n-well', poly: 'poly', nsdm: 'n+ implant (nsdm)', psdm: 'p+ implant (psdm)', licon1: 'contact (licon1)', met1: 'metal 1 (met1)' };
export const LAYER_NAME: Record<Layer, string> = { sti: 'STI oxide', nwell: 'n-well', poly: 'polysilicon', ndiff: 'n+ (nsdm)', pdiff: 'p+ (psdm)', contact: 'contacts', metal: 'metal 1' };

// ---- rectangle algebra ([x, y, w, h], layout units)

const EPS = 1e-9;
export const area = (rs: R[]): number => disjoint(rs).reduce((t, r) => t + r[2] * r[3], 0);
export function intersect(a: R[], b: R[]): R[] {
  const out: R[] = [];
  for (const p of a) for (const q of b) {
    const x0 = Math.max(p[0], q[0]), x1 = Math.min(p[0] + p[2], q[0] + q[2]), y0 = Math.max(p[1], q[1]), y1 = Math.min(p[1] + p[3], q[1] + q[3]);
    if (x1 > x0 + EPS && y1 > y0 + EPS) out.push([x0, y0, x1 - x0, y1 - y0]);
  }
  return disjoint(out);
}
export function minus(a: R[], b: R[]): R[] {
  let cur = disjoint(a);
  for (const c of disjoint(b)) {
    const next: R[] = [], cx1 = c[0] + c[2], cy1 = c[1] + c[3];
    for (const r of cur) {
      const rx1 = r[0] + r[2], ry1 = r[1] + r[3];
      if (cx1 <= r[0] + EPS || c[0] >= rx1 - EPS || cy1 <= r[1] + EPS || c[1] >= ry1 - EPS) { next.push(r); continue; }
      if (c[1] > r[1] + EPS) next.push([r[0], r[1], r[2], c[1] - r[1]]);
      if (cy1 < ry1 - EPS) next.push([r[0], cy1, r[2], ry1 - cy1]);
      const y0 = Math.max(r[1], c[1]), y1 = Math.min(ry1, cy1);
      if (c[0] > r[0] + EPS) next.push([r[0], y0, c[0] - r[0], y1 - y0]);
      if (cx1 < rx1 - EPS) next.push([cx1, y0, rx1 - cx1, y1 - y0]);
    }
    cur = next;
  }
  return cur;
}

// ---- the cell's masks

type Kind = 'n' | 'p';
/** Active area of one kind: every diffusion rectangle of the cell, channels included (the gate shapes lie on diffusion). */
export function activeOf(cell: Cell, k: Kind): R[] {
  return disjoint(cell.shapes.filter((s) => s.layer === (k === 'n' ? 'ndiff' : 'pdiff')).map((s) => s.r));
}
/** Margin of an implant window beyond the diffusion, in λ (sky130 requires 0.125 µm of enclosure; drawn generously). */
export const WINDOW_MARGIN = 3;
/** The implant mask: one window over the whole device row, wider than the diffusion on every side. */
export function windowOf(cell: Cell, k: Kind): R[] {
  const a = activeOf(cell, k), y0 = Math.min(...a.map((r) => r[1])), y1 = Math.max(...a.map((r) => r[1] + r[3]));
  return [[0, y0 - WINDOW_MARGIN, cell.w, y1 - y0 + 2 * WINDOW_MARGIN]];
}
export function polyOf(cell: Cell, shift = 0): R[] {
  return cell.shapes.filter((s) => s.layer === 'poly' && !s.gate).map((s): R => [s.r[0] + shift, s.r[1], s.r[2], s.r[3]]);
}
const groupedRects = (cell: Cell, layer: 'nwell' | 'metal' | 'contact'): R[] => {
  const groups = new Map<string, R[]>();
  for (const s of cell.shapes) {
    if (s.gate || s.layer !== layer) continue;
    const key = layer === 'contact' ? `${groups.size}` : s.node ?? '';
    groups.set(key, [...(groups.get(key) ?? []), s.r]);
  }
  return [...groups.values()].flatMap((rs) => (layer === 'contact' ? rs : disjoint(rs)));
};
/** The pattern of a mask. Poly takes the learner's shift (λ along x). */
export function maskRects(cell: Cell, m: MaskName, shift = 0): R[] {
  switch (m) {
    case 'diff': return disjoint([...activeOf(cell, 'n'), ...activeOf(cell, 'p')]);
    case 'nwell': return groupedRects(cell, 'nwell');
    case 'poly': return polyOf(cell, shift);
    case 'nsdm': return windowOf(cell, 'n');
    case 'psdm': return windowOf(cell, 'p');
    case 'licon1': return groupedRects(cell, 'contact');
    case 'met1': return groupedRects(cell, 'metal');
  }
}

/** Where the implant of one kind reaches silicon: window ∩ active, minus what the gate covers. Self-aligned: the gate
 *  is the poly where it really is (after the shift). Implanted first (a process with no self-alignment): the S/D
 *  shapes were set before the gate and leave the channel where the poly mask nominally puts it. */
export function implanted(cell: Cell, k: Kind, shift: number, aligned: boolean): R[] {
  return minus(intersect(activeOf(cell, k), windowOf(cell, k)), polyOf(cell, aligned ? shift : 0));
}
/** Active area under the gate (the channel), where the poly really is. */
export const channelOf = (cell: Cell, k: Kind, shift: number): R[] => intersect(activeOf(cell, k), polyOf(cell, shift));

/** What a poly mask shift does, in λ²: the gate over source/drain (overlap: extra gate-drain capacitance) and channel
 *  the gate no longer covers (silicon no inversion layer reaches: the transistor cannot turn fully on). Self-aligned,
 *  the source/drain edges follow the gate, so both are zero for any shift. */
export function misalignment(cell: Cell, shift: number, aligned: boolean): { overlap: number; gap: number } {
  if (aligned) return { overlap: 0, gap: 0 };
  let overlap = 0, gap = 0;
  for (const k of ['n', 'p'] as const) {
    overlap += area(intersect(implanted(cell, k, shift, false), polyOf(cell, shift)));
    gap += area(minus(channelOf(cell, k, 0), polyOf(cell, shift)));
  }
  return { overlap, gap };
}

// ---- heights (layout units; the footprint is to scale, heights one factor of it: V_FACTOR)

/** Trench, well and junction depth (below the surface, z < 0). */
export const DEPTH = { sti: 0.6, well: 1.6, junction: 0.35, sub: -3.2 };
/** The mask model's heights: one factor for every layer against the footprint (1 λ = 62 nm), so relative thicknesses are
 *  sky130's (SkyWater PDK, "assumptions": poly 0.18 µm, pre-LI dielectric 0.5, met1 0.35, photoresist 1.14, n-well 1.1
 *  deep, source/drain junctions 0.1). The trench depth is not in the PDK pages read (0.3 µm assumed) and the gate oxide
 *  (nanometres) would be invisible, so it is drawn at GOX. */
export const LAMBDA_UM = 0.062, V_FACTOR = 0.25;
export const TRUE_UM = { poly: 0.18, ild: 0.5, metal: 0.35, resist: 1.14, well: 1.1, junction: 0.1, sti: 0.3 } as const;
/** A thickness in µm, drawn: V_FACTOR of its true size in layout units. */
export const vh = (um: number): number => (V_FACTOR * um) / LAMBDA_UM;
export const MK_DEPTH = { sti: vh(TRUE_UM.sti), well: vh(TRUE_UM.well), junction: vh(TRUE_UM.junction), sub: -(vh(TRUE_UM.well) + 2) };
const GOX = 0.14, PT = vh(TRUE_UM.poly), RES = vh(TRUE_UM.resist), MET = vh(TRUE_UM.metal), MASK_GAP = 5, PLATE = 0.5, PATTERN = 0.4, PELL_GAP = 1.4;
export const MARGIN = 3;

export function zs(spread: number) {
  const poly0 = GOX + 2.2 * spread, poly1 = poly0 + PT, res0 = poly1 + 0.1, res1 = res0 + RES;
  const ild = poly1 + vh(TRUE_UM.ild - TRUE_UM.poly) + 2 * spread, metal0 = ild, metal1 = metal0 + MET;
  return { poly0, poly1, res0, res1, ild, metal0, metal1, plate: Math.max(metal1, res1) + MASK_GAP };
}

export interface MasksState { step: number; spread: number; /** poly mask shift in λ */ shift: number; /** false: implant before the gate */ aligned: boolean }
export interface MasksPalette {
  psub: RGB; sti: RGB; gox: RGB; resist: RGBA; ild: RGBA; uv: RGBA; chrome: RGBA; plate: RGBA; pell: RGBA; frame: RGB;
  layer: Record<Layer, RGB>;
}

/** Layout (x, y, z) to the stage's coordinates, the cell centred on the origin. */
export const place = (c: Cell, x: number, y: number, z: number): Vec3 => [x - c.w / 2, z, y - 22];
export const slab = (c: Cell, col: RGB | RGBA, r: R, z0: number, z1: number): Part => {
  const [x0, a, y0] = place(c, r[0], r[1], z0), [x1, b, y1] = place(c, r[0] + r[2], r[1] + r[3], z1);
  return box(col, x0, x1, Math.min(a, b), Math.max(a, b), Math.min(y0, y1), Math.max(y0, y1));
};
export const slabs = (c: Cell, col: RGB | RGBA, rs: R[], z0: number, z1: number): Part[] => rs.map((r) => slab(c, col, r, z0, z1));
export const footprint = (c: Cell): R => [0, 0, c.w, 44];

/** The silicon, level with the surface: bare wafer, then trenches, then the well, then implants sunk into the active area. */
function wafer(c: Cell, st: MasksState, P: MasksPalette): Part[] {
  const out: Part[] = [], f = footprint(c), well = st.step >= LAND_AT.nwell;
  if (st.step < LAND_AT.sti) return [slab(c, P.psub, f, MK_DEPTH.sub, 0)];
  const active = maskRects(c, 'diff'), nwell = well ? maskRects(c, 'nwell') : [];
  // Under the trenches: the substrate, and the well below trench depth.
  out.push(...slabs(c, P.psub, minus([f], nwell), MK_DEPTH.sub, -MK_DEPTH.sti), ...slabs(c, P.psub, nwell, MK_DEPTH.sub, -MK_DEPTH.well), ...slabs(c, P.layer.nwell, nwell, -MK_DEPTH.well, -MK_DEPTH.sti));
  out.push(...slabs(c, P.sti, minus([f], active), -MK_DEPTH.sti, 0));
  // Active columns: the silicon of their region, with the implants inside them (below the surface, not raised).
  for (const k of ['n', 'p'] as const) {
    const act = activeOf(c, k), si = k === 'p' && well ? P.layer.nwell : P.psub;
    out.push(...slabs(c, si, act, -MK_DEPTH.sti, -MK_DEPTH.junction));
    if (st.step < (k === 'n' ? LAND_AT.ndiff : LAND_AT.pdiff)) { out.push(...slabs(c, si, act, -MK_DEPTH.junction, 0)); continue; }
    const imp = implanted(c, k, st.shift, st.aligned);
    out.push(...slabs(c, P.layer[k === 'n' ? 'ndiff' : 'pdiff'], imp, -MK_DEPTH.junction, 0), ...slabs(c, si, minus(act, imp), -MK_DEPTH.junction, 0));
  }
  return out;
}

/** Where a few UV rays go: through clear parts of the reticle, so never over the pattern. */
export function rayPoints(c: Cell, shift: number): [number, number][] {
  const pat = polyOf(c, shift), out: [number, number][] = [];
  for (let i = 1; i < 12; i += 2) for (const y of [4, 13, 24, 40]) {
    const x = (c.w * i) / 12;
    if (!pat.some((r) => x > r[0] - 1.2 && x < r[0] + r[2] + 1.2 && y > r[1] - 1.2 && y < r[1] + r[3] + 1.2)) out.push([x, y]);
  }
  return out.filter((_, i) => i % 3 === 0).slice(0, 6);
}

export function masksParts(c: Cell, st: MasksState, P: MasksPalette): Part[] {
  const z = zs(st.spread), out: Part[] = [...wafer(c, st, P)], f = footprint(c), poly = polyOf(c, st.shift);
  if (st.step >= LAND_AT.poly) {
    if (st.step < 5) out.push(slab(c, P.gox, f, 0, GOX), slab(c, P.layer.poly, f, z.poly0, z.poly1));
    else out.push(...slabs(c, P.gox, [...channelOf(c, 'n', st.shift), ...channelOf(c, 'p', st.shift)], 0, GOX), ...slabs(c, P.layer.poly, poly, z.poly0, z.poly1));
  }
  if (st.step === 4) out.push(...slabs(c, P.resist, poly, z.res0, z.res1));
  if (st.step >= LAND_AT.contact) out.push(slab(c, P.ild, f, 0, z.ild), ...slabs(c, P.layer.contact, maskRects(c, 'licon1'), 0, z.ild));
  if (st.step >= LAND_AT.metal) out.push(...slabs(c, P.layer.metal, maskRects(c, 'met1'), z.metal0, z.metal1));
  const m = MASK_AT[st.step];
  if (m) out.push(...reticle(c, m, st, P));
  return out;
}

/** The reticle: a quartz plate with the chrome pattern on its lower face and a pellicle (a thin membrane on a frame)
 *  standing off below it. Drawn 1×, one cell; real reticles are 4× and carry the whole die field. */
export function reticle(c: Cell, m: MaskName, st: MasksState, P: MasksPalette): Part[] {
  const z = zs(st.spread), pz = z.plate, x0 = -MARGIN, x1 = c.w + MARGIN, y0 = -MARGIN, y1 = 44 + MARGIN;
  const out: Part[] = [slab(c, P.plate, [x0, y0, x1 - x0, y1 - y0], pz, pz + PLATE), ...slabs(c, P.chrome, maskRects(c, m, st.shift), pz - PATTERN, pz)];
  const fz0 = pz - PATTERN - PELL_GAP, ins = 0.8, t = 0.5, fx0 = x0 + ins, fx1 = x1 - ins, fy0 = y0 + ins, fy1 = y1 - ins;
  for (const r of [[fx0, fy0, fx1 - fx0, t], [fx0, fy1 - t, fx1 - fx0, t], [fx0, fy0 + t, t, fy1 - fy0 - 2 * t], [fx1 - t, fy0 + t, t, fy1 - fy0 - 2 * t]] as R[]) out.push(slab(c, P.frame, r, fz0, pz - PATTERN));
  out.push(slab(c, P.pell, [fx0, fy0, fx1 - fx0, fy1 - fy0], fz0 - 0.06, fz0));
  if (st.step === 4) for (const [x, y] of rayPoints(c, st.shift)) {
    const p = place(c, x, y, 0);
    out.push(cyl(P.uv, p[0], p[2], z.res1, fz0 - 0.06, 0.22));
  }
  return out;
}

export function masksAnchors(c: Cell, st: MasksState): Anchor[] {
  const z = zs(st.spread), out: Anchor[] = [], front: Vec3 = [0, 0.3, 1];
  const at = (r: R, zz: number, fx = 1, fy = 0.5) => place(c, r[0] + r[2] * fx, r[1] + r[3] * fy, zz);
  out.push({ text: 'p-type wafer', p: place(c, 0, 22, MK_DEPTH.sub / 2), side: 'l', n: front });
  const tag = (text: string, p: Vec3) => out.push({ text, p, side: 'r', n: [0, 1, 0] });
  switch (st.step) {
    case 1: tag('STI oxide', at(minus([footprint(c)], maskRects(c, 'diff'))[0], 0)); break;
    case 2: tag('n-well', at(maskRects(c, 'nwell')[0], -MK_DEPTH.sti, 1, 0.1)); break;
    case 3: tag('blanket poly', at(footprint(c), z.poly1, 1, 0.9)); break;
    case 4: tag('resist', at(polyOf(c, st.shift)[0], z.res1)); break;
    case 5: tag('poly gates', at(polyOf(c, st.shift)[0], z.poly1)); break;
    case 6: tag('n+', at(implanted(c, 'n', st.shift, st.aligned)[0], 0)); break;
    case 7: tag('p+', at(implanted(c, 'p', st.shift, st.aligned)[0], 0)); break;
    case 8: tag('contacts', at(maskRects(c, 'licon1')[0], z.ild)); break;
    case 9: tag('metal 1', at(maskRects(c, 'met1')[0], z.metal1)); break;
  }
  const m = MASK_AT[st.step];
  if (m) out.push({ text: `${MASK_NAME[m]} reticle`, p: place(c, c.w / 2, 44 + MARGIN, z.plate), side: 'l', n: [0, 1, 0] });
  return out;
}
