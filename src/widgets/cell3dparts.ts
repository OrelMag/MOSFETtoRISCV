// A standard cell as parts (DOM-free, tested), for the layout step: silicon with its trenches, well and diffusion sunk
// into the surface, gate oxide, poly, the contact stack of sky130's cells (licon1 → li1 → mcon → met1), the input pins
// on poly contacts, the well and substrate taps, and an optional section plane through the cell. Every rectangle
// comes from the cell data (silicon.ts CELLS) or from the two small rules below (taps, poly pads); heights are
// exaggerated, the footprint is to scale. Layout x runs across the cell, y down it (VDD at y = 0), z up.
//
// Scale: 44 λ is sky130_fd_sc_hd's 2.72 µm row, so 1 λ = 61.8 nm. Poly (2 λ ≈ 0.12 µm; sky130 minimum 0.15 µm), the
// 2 λ contact (licon1 0.17 µm) and the 3 λ li1 pad are drawn at that scale. NAND2 is 24 λ = 1.48 µm against sky130's
// nand2_1, 1.38 µm: 7 % wide. Sources: SkyWater PDK layers (nwell, diff, tap, poly, nsdm, psdm, licon1, li1, mcon, met1…met5)
// and rules (poly 0.150 µm, licon1 0.170 µm, li1 0.170 µm, met1 0.140 µm); Weste & Harris, CMOS VLSI Design ch. 1 and 3.

import type { RGB, RGBA } from '../gl/instances';
import type { Vec3 } from '../gl/math';
import type { Anchor, Part } from '../gl/parts';
import { disjoint } from './cellgeom';
import { DEPTH, footprint, minus, place, slab, type R } from './masks3dparts';
import type { Cell } from './silicon';

/** 1 λ in nanometres: the 44 λ row is sky130_fd_sc_hd's 2.72 µm. */
export const LAMBDA_NM = (2720 / 44);
export const ROW_UM = 2.72;

export type CellLayer = 'nwell' | 'diff' | 'poly' | 'contact' | 'li1' | 'metal';
export const CELL_LAYERS: CellLayer[] = ['nwell', 'diff', 'poly', 'contact', 'li1', 'metal'];
export const CELL_LAYER_NAME: Record<CellLayer, string> = { nwell: 'n-well', diff: 'diffusion', poly: 'poly', contact: 'licon1 / mcon', li1: 'li1', metal: 'met1' };

type Kind = 'n' | 'p';
type SolidLayer = 'psub' | 'nwell' | 'sti' | 'si' | 'diff' | 'chan' | 'gox' | 'poly' | 'licon' | 'li1' | 'mcon' | 'metal';
export interface CellSolid { layer: SolidLayer; r: R; z0: number; z1: number; kind?: Kind; node?: string; value?: number | 'z'; on?: boolean }
export interface CellState { ins: Record<string, number>; spread: number; show: Record<CellLayer, boolean>; /** layout y of the section plane, or null */ cut: number | null }

const GOX = 0.14, PT = 0.9, LI = 0.35, MET = 0.7, INV = 0.1;
export function cz(spread: number) {
  const poly0 = GOX + 2.2 * spread, poly1 = poly0 + PT, li0 = poly1 + 0.5 + 1.4 * spread, li1 = li0 + LI, metal0 = li1 + 0.5 + 1.4 * spread, metal1 = metal0 + MET;
  return { poly0, poly1, li0, li1, metal0, metal1 };
}

/** The tap cells' share of every cell here: an n+ in the well under the VDD rail and a p+ in the substrate under GND,
 *  each with a contact (sky130 puts them in separate tap cells every ~15 µm; in-cell here so the well and the body are tied). */
export function tapsOf(c: Cell): { n: R; nc: R; p: R; pc: R } {
  return { n: [c.w - 6, 0.5, 4, 3], nc: [c.w - 5, 1, 2, 2], p: [c.w - 6, 40.5, 4, 3], pc: [c.w - 5, 41, 2, 2] };
}
/** Where an input reaches the cell: a poly pad with a contact (a stub already there is the pad). */
export function pinsOf(c: Cell): { node: string; pad: R; contact: R }[] {
  return c.inputs.map((node) => {
    const strip = c.shapes.find((s) => s.layer === 'poly' && !s.gate && s.node === node && s.r[3] > s.r[2])!;
    const stub = c.shapes.find((s) => s.layer === 'poly' && !s.gate && s.node === node && s.r[2] > s.r[3]);
    if (stub) return { node, pad: stub.r, contact: [stub.r[0] + 1.5, stub.r[1] + 0.5, 2, 2] as R };
    return { node, pad: [strip.r[0] - 0.5, 17.5, strip.r[2] + 1, 4] as R, contact: [strip.r[0], 18.5, 2, 2] as R };
  });
}

const expand = (r: R, e: number): R => [r[0] - e, r[1] - e, r[2] + 2 * e, r[3] + 2 * e];
const inside = (r: R, x: number, y: number) => x >= r[0] && x <= r[0] + r[2] && y >= r[1] && y <= r[1] + r[3];

export function cellSolids(c: Cell, st: Pick<CellState, 'ins' | 'spread'>): CellSolid[] {
  const z = cz(st.spread), v = c.eval(st.ins), out: CellSolid[] = [], f = footprint(c), taps = tapsOf(c);
  const val = (n?: string) => (n === undefined ? undefined : n in st.ins ? st.ins[n] : v[n]);
  const add = (s: CellSolid) => out.push(s);
  const well: R = c.shapes.find((s) => s.layer === 'nwell')!.r;
  const active: R[] = c.shapes.filter((s) => s.layer === 'ndiff' || s.layer === 'pdiff').map((s) => s.r);
  const allActive = disjoint([...active, taps.n, taps.p]);
  // Silicon under the trenches, the well in it, trenches and the active columns.
  for (const r of minus([f], [well])) add({ layer: 'psub', r, z0: DEPTH.sub, z1: -DEPTH.sti });
  add({ layer: 'psub', r: well, z0: DEPTH.sub, z1: -DEPTH.well });
  add({ layer: 'nwell', r: well, z0: -DEPTH.well, z1: -DEPTH.sti });
  for (const r of minus([f], allActive)) add({ layer: 'sti', r, z0: -DEPTH.sti, z1: 0 });
  for (const r of allActive) add({ layer: r[1] < 22 ? 'nwell' : 'psub', r, z0: -DEPTH.sti, z1: -DEPTH.junction });
  // Diffusion sunk into the surface, per net; channels under the gates.
  for (const s of c.shapes) {
    if (s.layer !== 'ndiff' && s.layer !== 'pdiff') continue;
    const kind: Kind = s.layer === 'ndiff' ? 'n' : 'p';
    if (s.gate) {
      const on = s.gate[1] === 'n' ? st.ins[s.gate[0]] === 1 : st.ins[s.gate[0]] === 0;
      add({ layer: 'si', r: s.r, z0: -DEPTH.junction, z1: -INV, kind });
      add({ layer: 'chan', r: s.r, z0: -INV, z1: 0, kind, on });
    } else {
      for (const r of disjoint([s.r])) add({ layer: 'diff', r, z0: -DEPTH.junction, z1: 0, kind, node: s.node, value: val(s.node) });
    }
  }
  add({ layer: 'diff', r: taps.n, z0: -DEPTH.junction, z1: 0, kind: 'n', node: 'vdd', value: 1 });
  add({ layer: 'diff', r: taps.p, z0: -DEPTH.junction, z1: 0, kind: 'p', node: 'gnd', value: 0 });
  // Gate oxide on the channels, poly (strips, stubs and the input pads) by net.
  for (const s of c.shapes) if (s.gate) add({ layer: 'gox', r: s.r, z0: 0, z1: GOX });
  const pins = pinsOf(c), polyGroups = new Map<string, R[]>();
  for (const s of c.shapes) if (s.layer === 'poly' && !s.gate) polyGroups.set(s.node ?? '', [...(polyGroups.get(s.node ?? '') ?? []), s.r]);
  for (const p of pins) polyGroups.set(p.node, [...(polyGroups.get(p.node) ?? []), p.pad]);
  for (const [node, rs] of polyGroups) for (const r of disjoint(rs)) add({ layer: 'poly', r, z0: z.poly0, z1: z.poly1, node, value: val(node) });
  // Contacts: diffusion → licon1 → li1 → mcon → met1; a pin: poly → licon1 → li1 (sky130 cells put inputs on li1).
  const nodeOf = (r: R): string | undefined => c.shapes.find((s) => s.layer === 'metal' && !s.gate && inside(s.r, r[0] + 1, r[1] + 1))?.node;
  const dc: { r: R; node?: string }[] = [
    ...c.shapes.filter((s) => s.layer === 'contact').map((s) => ({ r: s.r, node: nodeOf(s.r) })),
    { r: taps.nc, node: 'vdd' }, { r: taps.pc, node: 'gnd' },
  ];
  for (const k of dc) {
    add({ layer: 'licon', r: k.r, z0: 0, z1: z.li0 });
    add({ layer: 'mcon', r: k.r, z0: z.li1, z1: z.metal0 });
  }
  for (const p of pins) add({ layer: 'licon', r: p.contact, z0: z.poly1, z1: z.li0, node: p.node });
  const lis = [...dc.map((k) => ({ r: expand(k.r, 0.5), node: k.node })), ...pins.map((p) => ({ r: expand(p.contact, 0.5), node: p.node }))];
  const liGroups = new Map<string, R[]>();
  for (const l of lis) liGroups.set(l.node ?? '', [...(liGroups.get(l.node ?? '') ?? []), l.r]);
  for (const [node, rs] of liGroups) for (const r of disjoint(rs)) add({ layer: 'li1', r, z0: z.li0, z1: z.li1, node, value: val(node) });
  // Metal 1 by net.
  const mGroups = new Map<string, R[]>();
  for (const s of c.shapes) if (s.layer === 'metal') mGroups.set(s.node ?? '', [...(mGroups.get(s.node ?? '') ?? []), s.r]);
  for (const [node, rs] of mGroups) for (const r of disjoint(rs)) add({ layer: 'metal', r, z0: z.metal0, z1: z.metal1, node, value: val(node) });
  return out;
}

/** The solids as the section plane leaves them: whatever lies at y ≤ cut, cut flat at the plane. */
export function clipAt(solids: CellSolid[], cut: number | null): CellSolid[] {
  if (cut === null) return solids;
  return solids.filter((s) => s.r[1] < cut - 1e-9).map((s) => ({ ...s, r: [s.r[0], s.r[1], s.r[2], Math.min(s.r[1] + s.r[3], cut) - s.r[1]] as R }));
}

/** Which solid layer a cell layer toggle hides. */
const HIDDEN_BY: Record<CellLayer, SolidLayer[]> = { nwell: ['nwell'], diff: ['diff', 'chan'], poly: ['poly', 'gox'], contact: ['licon', 'mcon'], li1: ['li1'], metal: ['metal'] };

export interface CellPalette {
  psub: RGB; nwell: RGB; sti: RGB; ndiff: RGB; pdiff: RGB; poly: RGB; gox: RGB; licon: RGB; li1: RGB; mcon: RGB; metal: RGB; chanOn: RGB;
}
/** A net's colour by its value: 1 bright, 0 dark, floating faded. */
export function tone(c: RGB, v: number | 'z' | undefined): RGB | RGBA {
  if (v === 1) return [Math.min(1, c[0] * 1.2 + 0.05), Math.min(1, c[1] * 1.2 + 0.05), Math.min(1, c[2] * 1.2 + 0.05)];
  if (v === 0) return [c[0] * 0.62, c[1] * 0.62, c[2] * 0.62];
  if (v === 'z') return [c[0], c[1], c[2], 0.45];
  return c;
}

export function colourOf(s: CellSolid, P: CellPalette): RGB | RGBA {
  switch (s.layer) {
    case 'psub': return P.psub;
    case 'nwell': return P.nwell;
    case 'sti': return P.sti;
    case 'si': return s.kind === 'p' ? P.nwell : P.psub;
    case 'chan': return s.on ? P.chanOn : s.kind === 'p' ? P.nwell : P.psub;
    case 'diff': return tone(s.kind === 'n' ? P.ndiff : P.pdiff, s.value);
    case 'gox': return P.gox;
    case 'poly': return tone(P.poly, s.value);
    case 'licon': return P.licon;
    case 'mcon': return P.mcon;
    case 'li1': return tone(P.li1, s.value);
    case 'metal': return tone(P.metal, s.value);
  }
}

export function cellParts(c: Cell, st: CellState, P: CellPalette): Part[] {
  const hidden = new Set(CELL_LAYERS.filter((l) => !st.show[l]).flatMap((l) => HIDDEN_BY[l]));
  return clipAt(cellSolids(c, st).filter((s) => !hidden.has(s.layer)), st.cut).map((s) => slab(c, colourOf(s, P), s.r, s.z0, s.z1));
}

/** What the section plane cuts through the first gate it meets: the stack across the channel, source to drain. */
export function gateCut(c: Cell, y: number): { gate: string; kind: Kind; x0: number; x1: number; left: string; right: string } | null {
  const g = c.shapes.filter((s) => s.gate && y >= s.r[1] && y < s.r[1] + s.r[3]).sort((a, b) => a.r[0] - b.r[0])[0];
  if (!g) return null;
  const kind: Kind = g.gate![1];
  const same = c.shapes.filter((s) => !s.gate && s.layer === (kind === 'n' ? 'ndiff' : 'pdiff') && y >= s.r[1] && y < s.r[1] + s.r[3]);
  const left = same.find((s) => Math.abs(s.r[0] + s.r[2] - g.r[0]) < 1e-9), right = same.find((s) => Math.abs(s.r[0] - (g.r[0] + g.r[2])) < 1e-9);
  const name = kind === 'n' ? 'n+' : 'p+';
  return { gate: g.gate![0], kind, x0: g.r[0], x1: g.r[0] + g.r[2], left: left ? name : 'field', right: right ? name : 'field' };
}
/** Default plane: through the middle of the first NMOS gate. */
export function defaultCut(c: Cell): number {
  const g = c.shapes.find((s) => s.gate && s.gate[1] === 'n')!;
  return g.r[1] + g.r[3] / 2;
}
export function sectionText(c: Cell, y: number): string {
  const g = gateCut(c, y);
  if (!g) return `Plane at y = ${y.toFixed(1)} λ: no gate here; it cuts ${y < 22 ? 'the n-well' : 'the substrate'} and the metal over it.`;
  return `Plane at y = ${y.toFixed(1)} λ through gate ${g.gate} (${g.kind === 'n' ? 'NMOS' : 'PMOS'}): ${g.left} | gate oxide | polysilicon | ${g.right}, the channel ${g.x1 - g.x0} λ = ${Math.round((g.x1 - g.x0) * LAMBDA_NM)} nm long under the oxide.`;
}

export function cellAnchors(c: Cell, st: CellState): Anchor[] {
  const z = cz(st.spread), v = c.eval(st.ins), out: Anchor[] = [], up: Vec3 = [0, 1, 0];
  const keep = (r: R) => st.cut === null || r[1] < st.cut;
  const tag = (text: string, p: Vec3, side: Anchor['side'], prio?: number, minor?: boolean) => out.push({ text, p, side, n: up, prio, minor });
  if (st.show.metal) {
    tag('VDD', place(c, 0, 2, z.metal1), 'l', 1);
    if (st.cut === null || st.cut > 42) tag('GND', place(c, 0, 42, z.metal1), 'l', 1);
    const y = c.shapes.find((s) => s.layer === 'metal' && s.node === 'y');
    if (y && keep(y.r)) tag(`y = ${v.y}`, place(c, y.r[0] + y.r[2], y.r[1] + y.r[3] / 2, z.metal1), 'r', 0);
  }
  if (st.show.li1) for (const p of pinsOf(c)) if (keep(p.pad)) tag(`${p.node} = ${st.ins[p.node]}`, place(c, p.contact[0] + 1, p.contact[1] + (p.contact[1] > 19 ? 2 : 0), z.li1), p.contact[1] > 19 ? 'l' : 'b', 0);
  if (st.cut !== null) {
    const g = gateCut(c, st.cut);
    if (g) {
      tag('poly', place(c, (g.x0 + g.x1) / 2, st.cut, z.poly1), 'r', 2);
      tag(g.kind === 'n' ? 'n+' : 'p+', place(c, g.x0 - 2, st.cut, 0), 'l', 2);
    }
  }
  return out;
}
