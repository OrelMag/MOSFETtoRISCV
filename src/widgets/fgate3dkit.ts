// A planar NAND string on the studio renderer, in true geometry (DOM-free; units are the drawing's own, the layers drawn
// far thicker against the cell than real ones, as fgate3dparts.ts says). x runs along the string, z across it (along the
// word lines), y up from the silicon surface.
//
// Along the string: the bit-line contact, the string select transistor, four cells sharing n+ regions, the ground select
// transistor and the common source line. Across it (the word-line direction), the cell's real shape: the active strip
// between trenches of isolation oxide (STI), the floating gate on its tunnel oxide, the ONO wrapped over its top and down its
// sides, and the control gate, which is the word line itself, dipping down beside the floating gate onto the trench oxide
// (the "wrap" cell of planar NAND above about 20 nm). A quarter cut opens both sections at once.
//
// The charge is phys/fgate.ts's rule: the electrons drawn are its count, slotted inside the floating gate (fgate3dparts.ts
// slot / leaving), and drawn as instances by the view so a pulse's electrons can fly up through the tunnel oxide and an
// erase's leave down into the well, frame by frame.

import { lathe, merge, roundedBox, sphere, transform, type Geo } from '../gl/kit/geo';
import { M, type Material } from '../gl/kit/materials';
import type { Beat, Item, Model3, StudioAnchor } from '../gl/kit/scene';
import type { Mat4, Vec3 } from '../gl/math';
import { CELLS, electrons, readConduction, stringConducts } from '../phys/fgate';
import { CG0, CG1, FG0, FG1, HALF, ONO_T, PITCH, cellX, leaving, slot, type FgPose } from './fgate3dparts';

// ---------------------------------------------------------------- the section across the string

/** The active strip's half-width (the floating gate's), the ONO on its sides, the control gate's skirt, the drawn word-line end. */
export const A_Z = 4.5, ONO_SIDE = 3 * ONO_T, SKIRT = 2, Z_END = A_Z + ONO_SIDE + SKIRT + 1;
/** The trench oxide's top: a little above the silicon, where the skirt stands. */
export const STI_TOP = FG0 + 0.6, STI_DEPTH = 7;
/** The select transistors one pitch beyond the end cells, the outer n+ (contacts) one more; the substrate's half-length. */
export const SEL_X = cellX(CELLS - 1) + PITCH, CONTACT_X = SEL_X + PITCH / 2 + 4, X_END = CONTACT_X + 8;
/** The bit line over the string, the common source line under it (along the word lines). */
export const BL_Y = CG1 + 9, SL_Y = CG1 + 4;

const mat = (o: Material): Material => M.make(o);
export const MATS = {
  si: mat({ ...M.silicon, base: '--m3-si', label: 'p-type silicon (the p-well)' }),
  siHot: mat({ ...M.silicon, base: '--m3-si', emit: '--m3-hot', glow: 0.35, label: 'p-well at +20 V: an erase' }),
  n: mat({ ...M.silicon, base: '--m3-n', label: 'n+ silicon (source / drain, shared by neighbours)' }),
  channel: mat({ base: '--m3-hot', metal: 0, rough: 0.4, emit: '--m3-hot', glow: 0.7, label: 'channel: conducting' }),
  poly: mat({ ...M.polysilicon, base: '--m3-poly', label: 'polysilicon' }),
  cgLive: mat({ ...M.polysilicon, base: '--m3-poly', emit: '--m3-hot', glow: 0.35, label: 'polysilicon, driven' }),
  fg: mat({ ...M.polysilicon, base: '--m3-fg', coat: 0.3, label: 'polysilicon, floating: no wire' }),
  oxide: mat({ ...M.oxide, label: 'silicon dioxide' }),
  sti: mat({ ...M.oxide, transmit: 0.3, label: 'trench isolation oxide (STI)' }),
  nitride: mat({ base: '--m3-nitride', metal: 0, rough: 0.3, transmit: 0.35, tint: '--m3-nitride', label: 'silicon nitride (the N of ONO)' }),
  metal: mat({ ...M.aluminium, base: '--m3-metal', label: 'metal' }),
  plug: mat({ ...M.tungsten, label: 'tungsten contact plug' }),
  charge: mat({ base: '--m3-charge', metal: 0, rough: 0.35, emit: '--m3-charge', glow: 0.9, bloom: 1.3, label: 'an electron (one drawn for many)' }),
};
/** The tunnel oxide, warming with the field across it (0 … 1). */
const tunnelOxide = (field: number): Material => (field > 0 ? mat({ ...M.oxide, emit: '--m3-hot', glow: 0.25 + 0.9 * field, bloom: 1.4, label: 'tunnel oxide, under the programming field' }) : mat({ ...M.oxide, label: 'tunnel oxide' }));

const tr = (p: Vec3): Mat4 => { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; m[12] = p[0]; m[13] = p[1]; m[14] = p[2]; return m; };
const bx = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, r = 0): Geo =>
  transform(roundedBox(x1 - x0, y1 - y0, z1 - z0, r, r > 0 ? 2 : 0), tr([(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2]));
/** A vertical plug of radius r from y0 to y1 at (x, z). */
const plug = (x: number, z: number, y0: number, y1: number, r: number): Geo => transform(lathe([[0, y0], [r, y0], [r, y1], [0, y1]], { seg: 20 }), tr([x, 0, z]));

/** Both sides across the string (z < 0 and z > 0) of a box symmetric in z: [z0, z1] and [−z1, −z0]. */
const pair = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, r = 0): Geo => merge([bx(x0, x1, y0, y1, z0, z1, r), bx(x0, x1, y0, y1, -z1, -z0, r)], 'pair');

interface Statics {
  well: Geo; n: Geo; sti: Geo; channel: Geo[]; tunnel: Geo[]; fg: Geo[]; ono: { o1: Geo[]; n: Geo[]; o2: Geo[] }; cg: Geo[];
  selOx: Geo; sel: Geo[]; plugs: Geo; bl: Geo; sl: Geo;
}
const memo = new Map<string, Statics>();
function statics(detail: 'full' | 'flat'): Statics {
  const hit = memo.get(detail);
  if (hit) return hit;
  const ns: Geo[] = [];
  for (let k = 0; k <= CELLS; k++) { const x = (k - CELLS / 2) * PITCH; ns.push(bx(x - 3, x + 3, -3, 0.02, -A_Z, A_Z)); }
  for (const sg of [-1, 1]) for (const x of [sg * (SEL_X - PITCH / 2), sg * CONTACT_X]) ns.push(bx(x - 3.5, x + 3.5, -3, 0.02, -A_Z, A_Z));
  const T = ONO_T;
  const s: Statics = {
    well: bx(-X_END, X_END, -12, 0, -Z_END, Z_END, 0.2),
    n: merge(ns, 'n+'),
    // the trenches either side of the strip, filled with oxide up a little above the silicon
    sti: pair(-X_END, X_END, -STI_DEPTH, STI_TOP, A_Z, Z_END),
    channel: Array.from({ length: CELLS }, (_, i) => bx(cellX(i) - HALF, cellX(i) + HALF, -0.6, 0.03, -A_Z, A_Z)),
    tunnel: Array.from({ length: CELLS }, (_, i) => bx(cellX(i) - HALF, cellX(i) + HALF, 0.03, FG0, -A_Z, A_Z)),
    fg: Array.from({ length: CELLS }, (_, i) => bx(cellX(i) - HALF, cellX(i) + HALF, FG0, FG1, -A_Z, A_Z, 0.25)),
    // the ONO wraps the floating gate: over its top, and down its two sides onto the trench oxide, three layers each
    ono: {
      o1: Array.from({ length: CELLS }, (_, i) => merge([bx(cellX(i) - HALF, cellX(i) + HALF, FG1, FG1 + T, -A_Z - T, A_Z + T), pair(cellX(i) - HALF, cellX(i) + HALF, STI_TOP, FG1, A_Z, A_Z + T)], 'ono o')),
      n: Array.from({ length: CELLS }, (_, i) => merge([bx(cellX(i) - HALF, cellX(i) + HALF, FG1 + T, FG1 + 2 * T, -A_Z - 2 * T, A_Z + 2 * T), pair(cellX(i) - HALF, cellX(i) + HALF, STI_TOP, FG1 + T, A_Z + T, A_Z + 2 * T)], 'ono n')),
      o2: Array.from({ length: CELLS }, (_, i) => merge([bx(cellX(i) - HALF, cellX(i) + HALF, FG1 + 2 * T, CG0, -A_Z - ONO_SIDE, A_Z + ONO_SIDE), pair(cellX(i) - HALF, cellX(i) + HALF, STI_TOP, FG1 + 2 * T, A_Z + 2 * T, A_Z + ONO_SIDE)], 'ono o')),
    },
    // the control gate is the word line: across the whole width, its skirts down beside the floating gate onto the trench oxide
    cg: Array.from({ length: CELLS }, (_, i) => merge([bx(cellX(i) - HALF, cellX(i) + HALF, CG0, CG1, -Z_END, Z_END, 0.2), pair(cellX(i) - HALF, cellX(i) + HALF, STI_TOP, CG0, A_Z + ONO_SIDE, Z_END)], 'control gate')),
    // the select transistors: one poly gate on a thin oxide, no floating gate
    selOx: merge([-1, 1].map((sg) => bx(sg * SEL_X - HALF, sg * SEL_X + HALF, 0.03, FG0 * 0.6, -A_Z, A_Z)), 'gate oxide'),
    sel: [-1, 1].map((sg) => merge([bx(sg * SEL_X - HALF, sg * SEL_X + HALF, FG0 * 0.6, CG1, -A_Z, A_Z, 0.2), pair(sg * SEL_X - HALF, sg * SEL_X + HALF, STI_TOP, CG1, A_Z, Z_END)], 'select gate')),
    plugs: merge([plug(-CONTACT_X, 0, 0, BL_Y, 1.4), plug(CONTACT_X, 0, 0, SL_Y, 1.4)], 'plugs'),
    bl: bx(-X_END, X_END, BL_Y, BL_Y + 1.6, -1.8, 1.8, 0.3),
    sl: bx(CONTACT_X - 2.2, CONTACT_X + 2.2, SL_Y, SL_Y + 1.6, -Z_END, Z_END, 0.3),
  };
  memo.set(detail, s);
  return s;
}

/** The electrons' bead: a small sphere (one drawn for many). */
export const ELECTRON = sphere(0.75, 10, 6);

/** Where every drawn electron is now: the count is phys/fgate.ts's; a pulse's new ones rise from the channel through the tunnel
 *  oxide, an erase's leave down into the well. */
export function electronsAt(p: FgPose): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i < CELLS; i++) {
    const n = p.erase ? p.erase.from[i] : electrons(p.bank.q[i]);
    for (let k = 0; k < n; k++) {
      let pos = p.erase ? leaving(i, k, p.erase.t) : slot(i, k);
      const f = p.fly;
      if (f && f.cell === i && k >= f.n0 && k < f.n1) { const e = 1 - (1 - f.t) ** 2; pos = [pos[0], -0.8 + (pos[1] + 0.8) * e, pos[2]]; }
      out.push(pos);
    }
  }
  return out;
}

/** The quarter cut: through the first cell's middle across the string, and along it through the back row of electrons, so
 *  their beads stand on the cut face of every floating gate beyond the first. */
export const CUT_X = cellX(0), CUT_Z = slot(0, 0)[2];

const PAVAN = 'Pavan et al., Proc. IEEE 85 (1997): the stack’s layers';

export function fgModel(p: FgPose, detail: 'full' | 'flat' = 'full'): Model3 {
  const S = statics(detail), items: Item[] = [], on = p.reading ? readConduction(p.bank) : null, all = p.reading && stringConducts(p.bank);
  const fld = p.field ?? 0, busy = !!p.erase || !!p.fly;
  items.push({ geo: S.well, mat: p.erase ? MATS.siHot : MATS.si, name: 'p-well', group: 'silicon', info: { note: p.erase ? 'at +20 V: the electrons tunnel down out of every floating gate' : 'the string’s silicon, shared by the whole block' } });
  items.push({ geo: S.n, mat: all ? MATS.channel : MATS.n, name: 'n+ region', group: 'silicon', info: { note: 'each one is the drain of one cell and the source of the next: no contact between cells' } });
  items.push({ geo: S.sti, mat: MATS.sti, name: 'trench isolation', group: 'sti', order: 1, info: { note: 'oxide-filled trenches between strings, along the bit-line direction' } });
  for (let i = 0; i < CELLS; i++) {
    const sel = i === p.bank.sel, live = (p.programming && sel) || p.reading, cname = `cell ${i + 1}`;
    if (on?.[i]) items.push({ geo: S.channel[i], mat: MATS.channel, name: 'channel', group: 'silicon', info: { note: `${cname}: conducting` } });
    items.push({ geo: S.tunnel[i], mat: tunnelOxide(sel || p.erase ? fld : 0), name: 'tunnel oxide', group: 'oxides', order: 2,
      info: { dim: 'about 8 nm (drawn far thicker)', source: PAVAN, note: 'electrons cross it only under a strong field (Fowler–Nordheim tunnelling); otherwise it holds them for years' } });
    items.push({ geo: S.fg[i], mat: MATS.fg, name: 'floating gate', group: 'fg', order: 3, info: { note: `${cname}: no wire, only oxide on every side; its electrons raise the threshold` } });
    items.push({ geo: S.ono.o1[i], mat: MATS.oxide, name: 'ONO', group: 'oxides', order: 4, info: { dim: 'about 15 nm equivalent oxide', source: PAVAN, note: 'oxide, nitride, oxide: thicker than the tunnel oxide, so electrons leave by the tunnel oxide' } });
    items.push({ geo: S.ono.n[i], mat: MATS.nitride, name: 'ONO', group: 'oxides', order: 5, info: { dim: 'about 15 nm equivalent oxide', source: PAVAN } });
    items.push({ geo: S.ono.o2[i], mat: MATS.oxide, name: 'ONO', group: 'oxides', order: 6, info: { dim: 'about 15 nm equivalent oxide', source: PAVAN } });
    items.push({ geo: S.cg[i], mat: live ? MATS.cgLive : MATS.poly, name: 'control gate = word line', group: 'cg',
      info: { note: `${cname}: the word line itself, wrapped down both sides of the floating gate so it couples to more of it${sel && p.reading ? ': at the read voltage' : p.reading ? ': at the pass voltage' : sel && p.programming ? ': at the programming voltage' : ''}` } });
  }
  const es = electronsAt(p);
  if (es.length) items.push({ geo: merge(es.map((e) => transform(ELECTRON, tr(e))), 'electrons'), mat: MATS.charge, name: 'electron', group: 'charge', shadow: false,
    info: { note: 'stored charge: one drawn for many; the count is the model’s charge on the floating gate' } });
  items.push({ geo: S.selOx, mat: MATS.oxide, name: 'gate oxide', group: 'select', order: 2 });
  S.sel.forEach((g, k) => items.push({ geo: g, mat: p.reading ? MATS.cgLive : MATS.poly, name: k === 0 ? 'string select gate' : 'ground select gate', group: 'select',
    info: { note: k === 0 ? 'connects the string to its bit line (on while reading)' : 'connects the string to the common source line (on while reading)' } }));
  items.push({ geo: S.plugs, mat: MATS.plug, name: 'contact', group: 'wires', cut: 'none' });
  items.push({ geo: S.bl, mat: MATS.metal, name: 'bit line', group: 'wires', cut: 'none', info: { note: 'runs along the string; one per string' } });
  items.push({ geo: S.sl, mat: MATS.metal, name: 'common source line', group: 'wires', cut: 'none', info: { note: 'runs along the word lines, shared by every string of the block' } });

  const front: Vec3 = [0, 0.2, 1], up: Vec3 = [0, 1, 0], s = p.bank.sel;
  const anchors: StudioAnchor[] = [
    { text: 'word line', p: [cellX(0) - HALF / 2, (STI_TOP + CG0) / 2, Z_END], side: 'l', n: front, on: 'cg' },
    { text: 'floating gate: no wire', p: [cellX(s) + HALF, (FG0 + FG1) / 2, A_Z], side: 'r', n: front, on: 'fg' },
    { text: 'ONO', p: [cellX(CELLS - 1) + HALF, (FG1 + CG0) / 2, A_Z + ONO_SIDE], side: 'r', n: front, on: 'oxides' },
    { text: 'tunnel oxide', p: [cellX(CELLS - 1) + HALF, FG0 / 2, A_Z], side: 'r', n: front, on: 'oxides' },
    { text: 'trench isolation', p: [cellX(0), STI_TOP, Z_END], side: 'l', n: front, on: 'sti', minor: true },
    { text: 'select gates', p: [-SEL_X, CG1, 0], side: 'l', n: up, on: 'select', minor: true },
    { text: 'bit line', p: [-X_END + 2, BL_Y + 1.6, 0], side: 'l', n: up, on: 'wires', minor: true },
    { text: 'source line', p: [CONTACT_X, SL_Y + 1.6, Z_END], side: 'r', n: up, on: 'wires', minor: true },
    { text: busy && p.erase ? 'p-well +20 V' : 'p-well', p: [0, -12, Z_END], side: 'b', n: front, on: 'silicon', minor: true },
  ];
  const v = (yaw: number, pitch: number) => ({ yaw, pitch, target: [0, 6, 0] as Vec3, dist: 120 });
  const beats: Beat[] = [
    { title: 'Four cells on one strip', text: 'Four cells in series between two select transistors: a bit line at one end, the common source line at the other. Neighbouring cells share their n+ regions, so a string needs no contact between its cells: that is why NAND is dense.', view: v(0.25, 0.35), frame: ['silicon', 'cg', 'select', 'wires'] },
    { title: 'The floating gate', text: 'Cut open: under each control gate a second, floating, gate sits on the thin tunnel oxide, sealed in oxide on every side. It has no wire. Electrons put on it stay for years, and they raise the cell’s threshold.', view: { yaw: 0.3, pitch: 0.28, target: [cellX(1.5), 5, CUT_Z], dist: 58 }, show: ['fg', 'charge', 'oxides', 'silicon'], hide: ['wires'], cut: 1 },
    { title: 'The word line wraps it', text: 'Across the string the control gate is the word line, and it dips down beside the floating gate onto the trench oxide, with the ONO between. The more of the floating gate it covers, the larger the coupling ratio and the more of the word line’s voltage reaches the tunnel oxide.', view: { yaw: 1.05, pitch: 0.22, target: [CUT_X, 6, 4], dist: 52 }, show: ['cg', 'fg', 'charge', 'oxides', 'sti'], hide: ['wires', 'select'], cut: 1 },
    { title: 'Programming: electrons tunnel up', text: 'A program pulse raises the chosen word line to 20 V with the channel at 0 V. The floating gate takes the coupling ratio’s share of it, which puts more than the 10 MV/cm or so Fowler–Nordheim tunnelling needs across the 8 nm tunnel oxide: electrons tunnel up through it into the floating gate. Press Program pulse.', view: { yaw: 0.3, pitch: 0.22, target: [cellX(1), 4, CUT_Z], dist: 46 }, show: ['fg', 'charge', 'oxides', 'silicon', 'cg'], hide: ['wires'], cut: 1 },
    { title: 'Reading the string', text: 'A read turns both select transistors on, puts the read voltage on the chosen word line and a pass voltage on the others. Every unchosen cell conducts whatever it holds, so current flows down the string only if the chosen cell does.', view: v(0.2, 0.45), frame: ['silicon', 'select', 'wires'], show: ['silicon', 'select', 'wires', 'cg'] },
  ];
  return {
    items, anchors, beats, floor: -12.1, flatOrder: 'items',
    // the quarter cut (CUT_X, CUT_Z): the string's section and the first cell's section across it show together
    cuts: { planes: [{ n: [0, 0, 1], d: CUT_Z }, { n: [1, 0, 0], d: CUT_X }], open: [Z_END + 1, X_END + 1] },
    look: { exposure: 0.95 },
  };
}

export const FG_HOME = { yaw: 0.7, pitch: 0.4, target: [0, 6, 0] as Vec3, dist: 120 };
/** Home frames the cells, not the wiring above them. */
export const FG_HOME_FRAME = ['cg', 'fg'];
/** The canvas's shape: the string is long, but the cells, not the string's length, are the subject. */
export const FG_ASPECT = 1.5;
