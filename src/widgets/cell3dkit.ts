// The standard cell of the layout step as a studio model (DOM-free): the same cells as before (silicon.ts CELLS, the
// rectangles of cell3dparts.ts cellSolids), in true geometry on the studio renderer, and in true thickness above the
// silicon. Units are λ (1 λ = 61.8 nm, so the 44 λ row is sky130_fd_sc_hd's 2.72 µm) in all three directions: the
// footprint is the cell's own, the films are the SkyWater PDK's thicknesses (poly 0.18 µm, li1 0.1 µm, met1 0.35 µm,
// pre-li1 dielectric 0.5 µm, n-well 1.1 µm, junctions 0.1 µm), the 4 nm gate oxide is drawn 5× thicker so it shows, and
// the trench depth and the li1-to-met1 gap are illustrative (the PDK pages read give neither).
//
// Home is the cell as its conductors: silicon with its well, diffusion and trenches, the gate oxide and poly, the
// contact stack licon1 → li1 → mcon → met1, the taps. Layers add the dielectric between them (translucent oxide) and the
// neighbours in its row. A cut across the cell through an NMOS gate shows the stack as solid section: n+ | oxide | poly | n+.

import { roundedBox, type Geo } from '../gl/kit/geo';
import { M, type Material } from '../gl/kit/materials';
import type { Beat, Item, Model3, StudioAnchor } from '../gl/kit/scene';
import type { Instance, RGB } from '../gl/instances';
import type { Vec3 } from '../gl/math';
import { cellSolids, defaultCut, LAMBDA_NM, pinsOf, tapsOf, type CellPalette, type CellSolid } from './cell3dparts';
import type { R } from './masks3dparts';
import type { Cell } from './silicon';

/** µm → λ. */
export const UM = 1000 / LAMBDA_NM;
/** The SkyWater PDK's thicknesses (µm) for the films drawn to scale, and what is drawn otherwise (each said so in its card). */
export const PDK = { poly: 0.18, li1: 0.1, met1: 0.35, preLi: 0.5, nwell: 1.1, junction: 0.1, gox: 0.00415 } as const;
/** Drawn, not to scale: the gate oxide 5× (4 nm would be a fifteenth of a λ), the trench depth and the li1-to-met1 gap (not in the pages read). */
export const DRAWN = { goxScale: 5, sti: 0.3, liMet: 0.27, subBelowWell: 0.4 } as const;

export const SRC = {
  pdk: 'SkyWater PDK, "Criteria and assumptions", tables 4 and 5 (layer thicknesses, junction depth)',
  gox: 'about 4.15 nm for the 1.8 V devices (a third-party gm/ID explorer for sky130A; not a PDK page): drawn 5× thicker',
  lef: 'sky130_fd_sc_hd LEF: the cell row is 2.72 µm high (nand2_1 is 1.38 × 2.72 µm)',
  illus: 'illustrative: the PDK pages read give no figure',
  cells: 'the layout step\'s teaching cell (silicon.ts CELLS): sky130-like, not a copy of a library cell',
};

/** Heights (λ) of every film's bottom and top, the surface of the silicon at 0. */
export function heights() {
  const gox = PDK.gox * DRAWN.goxScale * UM, poly0 = gox, poly1 = poly0 + PDK.poly * UM;
  const li0 = PDK.preLi * UM, li1 = li0 + PDK.li1 * UM, met0 = li1 + DRAWN.liMet * UM, met1 = met0 + PDK.met1 * UM;
  return { gox, poly0, poly1, li0, li1, met0, met1, junction: PDK.junction * UM, sti: DRAWN.sti * UM, well: PDK.nwell * UM, sub: (PDK.nwell + DRAWN.subBelowWell) * UM };
}

export type CellLayer = 'ild' | 'row' | 'metal';
export interface CellLook {
  detail: 'full' | 'flat';
  ins: Record<string, number>;
  /** What is drawn besides the conductors: the oxide between them, the neighbours in the row; 'metal' on unless hidden. */
  layers: ReadonlySet<CellLayer>;
  pal: CellPalette;
}

// ---------------------------------------------------------------- geometry

const memo = new Map<string, Geo>();
const boxGeo = (w: number, h: number, d: number) => {
  const k = `${w.toFixed(3)}|${h.toFixed(3)}|${d.toFixed(3)}`;
  let g = memo.get(k);
  if (!g) { g = roundedBox(w, h, d, Math.min(0.12, w / 6, h / 6, d / 6), 1); memo.set(k, g); }
  return g;
};
/** Layout (x across, y down the cell from VDD) → model: x centred, z = y − 22 (the row's middle), height up. */
const at = (c: Cell, r: R, y0: number, y1: number, dx = 0): Vec3 => [r[0] + r[2] / 2 - c.w / 2 + dx, (y0 + y1) / 2, r[1] + r[3] / 2 - 22];

const toneOf = (c: RGB, v: number | 'z' | undefined): RGB => (v === 1 ? [Math.min(1, c[0] * 1.15 + 0.06), Math.min(1, c[1] * 1.15 + 0.06), Math.min(1, c[2] * 1.15 + 0.06)] : v === 0 ? [c[0] * 0.72, c[1] * 0.72, c[2] * 0.72] : c);

/** A solid of cellSolids at its true height: which film it is, how high, what it is made of. */
function solidItem(c: Cell, s: CellSolid, P: CellPalette, z: ReturnType<typeof heights>, dx: number, own: boolean): Item | null {
  const H: Record<CellSolid['layer'], [number, number]> = {
    psub: [-z.sub, s.z1 > -0.7 ? -z.sti : -z.well], nwell: [-z.well, -z.sti], sti: [-z.sti, 0], si: [-z.junction, -z.junction / 3],
    diff: [-z.junction, 0], chan: [-z.junction / 3, 0], gox: [0, z.gox], poly: [z.poly0, z.poly1],
    licon: s.z0 > 0.5 ? [z.poly1, z.li0] : [0, z.li0], li1: [z.li0, z.li1], mcon: [z.li1, z.met0], metal: [z.met0, z.met1],
  };
  let [y0, y1] = H[s.layer];
  // an active column under the trench level, by its own well
  if (s.layer === 'nwell' && s.z1 === -0.35) [y0, y1] = [-z.sti, -z.junction];
  if (s.layer === 'psub' && s.z1 === -0.35) [y0, y1] = [-z.sti, -z.junction];
  if (s.layer === 'psub' && s.z0 === -3.2 && s.z1 === -1.6) [y0, y1] = [-z.sub, -z.well];
  const mat = matOf(s, P);
  const name = NAME[s.layer](s), group = GROUP[s.layer];
  return { geo: boxGeo(s.r[2], y1 - y0, s.r[3]), mat, at: at(c, s.r, y0, y1, dx), name: own ? name : undefined, group: own ? group : 'row',
    info: own ? info(s, z) : undefined, explode: own ? EXPLODE[s.layer] : undefined, cut: own ? 'section' : 'none' };
}

const NAME: Record<CellSolid['layer'], (s: CellSolid) => string> = {
  psub: () => 'p substrate', nwell: () => 'n-well', sti: () => 'trench oxide (STI)', si: (s) => (s.kind === 'n' ? 'p substrate under the gate' : 'n-well under the gate'),
  diff: (s) => (s.node === 'vdd' || s.node === 'gnd' ? `${s.kind === 'n' ? 'n+' : 'p+'} tap` : `${s.kind === 'n' ? 'n+' : 'p+'} diffusion`), chan: (s) => (s.kind === 'n' ? 'NMOS channel' : 'PMOS channel'),
  gox: () => 'gate oxide', poly: () => 'polysilicon', licon: () => 'licon1 contact', li1: () => 'li1 (local interconnect)', mcon: () => 'mcon contact', metal: () => 'metal 1',
};
const GROUP: Record<CellSolid['layer'], string> = { psub: 'silicon', nwell: 'silicon', sti: 'sti', si: 'silicon', diff: 'diff', chan: 'channel', gox: 'gox', poly: 'poly', licon: 'contacts', li1: 'li1', mcon: 'mcon', metal: 'metal' };
const EXPLODE: Partial<Record<CellSolid['layer'], Vec3>> = { gox: [0, 2, 0], poly: [0, 5, 0], licon: [0, 9, 0], li1: [0, 14, 0], mcon: [0, 19, 0], metal: [0, 25, 0] };

function info(s: CellSolid, z: ReturnType<typeof heights>): { dim?: string; source?: string; note?: string } {
  const um = (l: number) => `${((l * LAMBDA_NM) / 1000).toFixed(2)} µm`;
  const plan = `${um(s.r[2])} × ${um(s.r[3])}`;
  switch (s.layer) {
    case 'poly': return { dim: `${plan}, ${PDK.poly} µm thick`, source: SRC.pdk, note: `net ${s.node}${s.value !== undefined ? ` = ${s.value}` : ''}: a transistor is where it crosses diffusion` };
    case 'gox': return { dim: `about ${PDK.gox * 1000} nm, drawn ${DRAWN.goxScale}× thicker`, source: SRC.gox, note: 'the insulator between gate and channel' };
    case 'li1': return { dim: `${plan}, ${PDK.li1} µm thick`, source: SRC.pdk, note: `net ${s.node}` };
    case 'metal': return { dim: `${plan}, ${PDK.met1} µm thick`, source: SRC.pdk, note: `net ${s.node}${s.value !== undefined ? ` = ${s.value}` : ''}` };
    case 'licon': return { dim: `${um(s.r[2])} square, ${(z.li0 * LAMBDA_NM / 1000).toFixed(2)} µm to li1`, source: SRC.pdk, note: 'a tungsten plug through the dielectric' };
    case 'mcon': return { dim: `${um(s.r[2])} square`, source: SRC.illus, note: 'a plug from li1 up to metal 1' };
    case 'diff': return { dim: `${plan}, ${PDK.junction} µm deep`, source: SRC.pdk, note: `net ${s.node}${s.value !== undefined ? ` = ${s.value}` : ''}` };
    case 'chan': return { dim: `${um(s.r[2])} long × ${um(s.r[3])} wide`, source: SRC.cells, note: s.on ? 'conducting: an inversion layer under the gate' : 'off' };
    case 'nwell': return { dim: `${PDK.nwell} µm deep`, source: SRC.pdk, note: 'where the PMOS sit; tied to VDD by its tap' };
    case 'sti': return { dim: `${DRAWN.sti} µm deep (illustrative)`, source: SRC.illus, note: 'oxide in a trench between devices' };
    default: return { source: SRC.cells };
  }
}

function matOf(s: CellSolid, P: CellPalette): Material {
  switch (s.layer) {
    case 'psub': case 'si': return M.make({ base: s.kind === 'p' ? P.nwell : P.psub, metal: 0.25, rough: 0.35, label: s.layer === 'si' && s.kind === 'p' ? 'n-type silicon' : 'p-type silicon' });
    case 'nwell': return M.make({ base: P.nwell, metal: 0.25, rough: 0.35, label: 'n-type silicon (the well)' });
    case 'sti': return M.make({ base: P.sti, metal: 0, rough: 0.2, transmit: 0.45, label: 'silicon dioxide (trench)' });
    case 'diff': return M.make({ base: toneOf(s.kind === 'n' ? P.ndiff : P.pdiff, s.value), metal: 0.25, rough: 0.35, label: s.kind === 'n' ? 'n+ silicon (heavily doped)' : 'p+ silicon (heavily doped)' });
    case 'chan': return s.on ? M.make({ base: P.chanOn, metal: 0, rough: 0.4, emit: P.chanOn, glow: 0.45, label: 'inversion layer (conducting)' }) : M.make({ base: s.kind === 'p' ? P.nwell : P.psub, metal: 0.25, rough: 0.35, label: 'silicon under the gate (off)' });
    case 'gox': return M.make({ base: P.gox, metal: 0, rough: 0.15, coat: 0.5, label: 'silicon dioxide (gate)' });
    case 'poly': return M.make({ ...M.polysilicon, base: toneOf(P.poly, s.value), label: 'polysilicon' });
    case 'licon': case 'mcon': return M.make({ base: [0.62, 0.61, 0.6], metal: 0.6, rough: 0.45, label: 'tungsten' });
    case 'li1': return M.make({ base: toneOf(P.li1, s.value), metal: 0.8, rough: 0.35, label: 'li1 local interconnect' });
    case 'metal': return M.make({ base: toneOf(P.metal, s.value), metal: 0.55, rough: 0.4, label: 'metal 1 (aluminium alloy)' });
  }
}

// ---------------------------------------------------------------- the model

export function cellModel(c: Cell, look: CellLook): Model3 {
  const z = heights(), items: Item[] = [], solids = cellSolids(c, { ins: look.ins, spread: 0 });
  const metalOn = look.layers.has('metal');
  const keep = (s: CellSolid) => metalOn || (s.layer !== 'metal' && s.layer !== 'mcon');
  for (const s of solids) if (keep(s)) { const it = solidItem(c, s, look.pal, z, 0, true); if (it) items.push(it); }
  if (look.layers.has('row')) for (const dx of [-c.w, c.w]) for (const s of solids) if (keep(s) && s.layer !== 'chan') { const it = solidItem(c, s, look.pal, z, dx, false); if (it) items.push({ ...it, mat: M.tint(it.mat, toneOf(it.mat.base as RGB, undefined), 'the next cell in the row') }); }
  if (look.layers.has('ild')) {
    // the dielectric between the films, over the whole cell: before li1, then up to metal 1
    const oxide = M.make({ base: look.pal.gox, metal: 0, rough: 0.1, transmit: 0.72, label: 'silicon dioxide between the layers' });
    const top = metalOn ? z.met0 : z.li1;
    items.push({ geo: boxGeo(c.w, z.li0, 44), mat: oxide, at: [0, z.li0 / 2, 0], name: 'pre-li1 dielectric', group: 'ild', order: 1, shadow: false, info: { dim: `${PDK.preLi} µm`, source: SRC.pdk, note: 'the plugs (licon1) go through it' } });
    if (metalOn) items.push({ geo: boxGeo(c.w, top - z.li0, 44), mat: oxide, at: [0, (z.li0 + top) / 2, 0], name: 'dielectric under metal 1', group: 'ild', order: 2, shadow: false, info: { dim: `${DRAWN.liMet + PDK.li1} µm (illustrative)`, source: SRC.illus } });
  }
  // the frame home and the beats fit to (never drawn): the whole block. Left out of the flat build, whose drawing would paint them
  if (look.detail === 'full') items.push({ geo: boxGeo(c.w, z.met1 + z.sub, 44), mat: M.paint([0, 0, 0]), at: [0, (z.met1 - z.sub) / 2, 0], group: 'cellbox', cut: 'none', shadow: false });
  if (look.detail === 'full') items.push({ geo: boxGeo(3 * c.w, z.met1 + z.sub, 44), mat: M.paint([0, 0, 0]), at: [0, (z.met1 - z.sub) / 2, 0], group: 'rowbox', cut: 'none', shadow: false });
  const cutZ = defaultCut(c) - 22;
  return {
    items, cuts: { planes: [{ n: [0, 0, 1], d: cutZ }], open: [23] },
    anchors: anchors(c, look, z), beats: beats(c), floor: -z.sub - 0.5, look: { exposure: 1.05 },
  };
}
export const FRAME_GROUPS = ['cellbox', 'rowbox'] as const;

// ---------------------------------------------------------------- carriers: the charge that moves when the output switches

/** A transistor's channel and which way its carriers go: from the rail side (or the middle node) toward the output. */
export interface Lane { r: R; kind: 'n' | 'p'; from: number; to: number }
const RANK = (n?: string) => (n === 'gnd' || n === 'vdd' ? 0 : n === 'y' ? 2 : 1);
/** The channels the output's charge flows through now: the NMOS that are on when y falls to 0, the PMOS when it rises to 1. */
export function lanes(c: Cell, ins: Record<string, number>): Lane[] {
  const y = c.eval(ins).y, kind = y === 0 ? 'n' : 'p', out: Lane[] = [];
  for (const s of c.shapes) {
    if (!s.gate || s.gate[1] !== kind) continue;
    const on = kind === 'n' ? ins[s.gate[0]] === 1 : ins[s.gate[0]] === 0;
    if (!on) continue;
    const layer = kind === 'n' ? 'ndiff' : 'pdiff', row = (q: typeof s) => q.layer === layer && !q.gate && q.r[1] === s.r[1];
    const left = c.shapes.find((q) => row(q) && Math.abs(q.r[0] + q.r[2] - s.r[0]) < 1e-9), right = c.shapes.find((q) => row(q) && Math.abs(q.r[0] - (s.r[0] + s.r[2])) < 1e-9);
    const lx = s.r[0] - 2.5, rx = s.r[0] + s.r[2] + 2.5;
    // carriers leave the side nearer the rail
    const fromLeft = RANK(left?.node) <= RANK(right?.node);
    out.push({ r: s.r, kind, from: fromLeft ? lx : rx, to: fromLeft ? rx : lx });
  }
  // only a path that reaches the output conducts the switching charge
  return out;
}
/** The carriers at time k (0..1 through the switching burst): beads moving across each lane, fading out at its end. */
export function carriers(c: Cell, ls: Lane[], k: number, col: { e: RGB; h: RGB }, n = 6): Instance[] {
  const z = heights(), out: Instance[] = [];
  for (const l of ls) for (let i = 0; i < n; i++) {
    const f = ((i / n + k * 2.5) % 1), x = l.from + (l.to - l.from) * f - c.w / 2, zz = l.r[1] + ((i * 7) % 10) / 10 * l.r[3] - 22;
    const a = Math.min(1, 4 * k) * Math.min(1, 3 * (1 - k)), cc = l.kind === 'n' ? col.e : col.h;
    out.push({ pos: [x, z.gox + 0.8, zz], color: cc, emissive: [cc[0] * a, cc[1] * a, cc[2] * a], scale: [a, a, a] });
  }
  return out;
}

// ---------------------------------------------------------------- labels and tour

function anchors(c: Cell, look: CellLook, z: ReturnType<typeof heights>): StudioAnchor[] {
  const up: Vec3 = [0, 1, 0], front: Vec3 = [0, 0.3, 1], P = (x: number, y: number, h: number): Vec3 => [x - c.w / 2, h, y - 22];
  const pins = pinsOf(c), metalOn = look.layers.has('metal'), top = metalOn ? z.met1 : z.li1;
  const y = c.shapes.find((s) => s.layer === 'metal' && s.node === 'y')!;
  const g = c.shapes.find((s) => s.gate && s.gate[1] === 'n')!, pg = c.shapes.find((s) => s.gate && s.gate[1] === 'p')!;
  const a: StudioAnchor[] = [
    // the rails are metal 1: with it off there is nothing there to name
    ...(metalOn ? [{ text: 'VDD rail', p: P(1, 2, top), side: 'l', n: up, on: 'metal' }, { text: 'GND rail', p: P(1, 42, top), side: 'l', n: up, on: 'metal' }] satisfies StudioAnchor[] : []),
    { text: 'output y', p: P(y.r[0] + y.r[2], y.r[1] + 2, top), side: 'r', n: up, on: metalOn ? 'metal' : 'li1' },
    { text: 'poly gate', p: P(g.r[0] + g.r[2] / 2, g.r[1] + g.r[3] + 1, z.poly1), side: 'r', n: up, on: 'poly' },
    { text: 'NMOS (n+ | gate | n+)', p: P(g.r[0] - 2, g.r[1] + g.r[3], 0), side: 'l', n: front, on: 'diff' },
    { text: 'PMOS, in the n-well', p: P(pg.r[0] - 2, pg.r[1], 0), side: 'l', n: front, on: 'diff' },
    ...pins.map((p): StudioAnchor => ({ text: `input ${p.node}`, p: P(p.contact[0] + 1, p.contact[1] + 1, z.li1), side: p.contact[0] < c.w / 2 ? 'l' : 'r', n: up, on: 'li1' })),
  ];
  const t = tapsOf(c);
  a.push({ text: 'well tap', p: P(t.n[0] + 2, t.n[1] + 2, 0), side: 'r', n: up, minor: true });
  return a;
}

export const HOME = { target: [0, 0, 0] as Vec3, yaw: -0.62, pitch: 0.62, dist: 80 };

function beats(c: Cell): Beat[] {
  const z = heights(), um = (l: number) => ((l * LAMBDA_NM) / 1000).toFixed(2);
  const g = c.shapes.find((s) => s.gate && s.gate[1] === 'n')!;
  return [
    { title: 'A cell', text: `${c.name}, ${c.w} λ × 44 λ: ${um(c.w)} µm × 2.72 µm, the row height of SkyWater's sky130 high-density cells. Its ${c.transistors} transistors are where the polysilicon strips cross the diffusion; metal 1 carries VDD along the top and GND along the bottom.`, view: HOME, frame: ['cellbox'], cut: 0, explode: 0 },
    { title: 'Where poly crosses diffusion', text: `Each crossing is a transistor: the PMOS up in the n-well near VDD, the NMOS in the p substrate near GND. A green channel conducts. The gate is ${g.r[2]} λ = ${Math.round(g.r[2] * LAMBDA_NM)} nm long here.`, view: { ...HOME, yaw: -0.3, pitch: 1.0 }, frame: ['diff', 'poly', 'channel'], show: ['diff', 'poly', 'channel', 'gox', 'silicon', 'sti'], cut: 0, explode: 0 },
    { title: 'Cut through a gate', text: `The cut runs across the NMOS through its gate: n+ | gate oxide | polysilicon | n+. The oxide is about ${PDK.gox * 1000} nm (drawn ${DRAWN.goxScale}× thicker), the poly ${PDK.poly} µm, the junctions ${PDK.junction} µm deep.`, view: { ...HOME, yaw: -0.15, pitch: 0.45 }, frame: ['poly', 'diff', 'gox', 'channel'], cut: 1, explode: 0 },
    { title: 'Up to metal', text: `Pulled apart: licon1 plugs from diffusion and poly up to li1 (${PDK.li1} µm), mcon plugs on to metal 1 (${PDK.met1} µm). The whole stack is about ${um(z.met1)} µm: as tall as the cell is wide.`, view: { ...HOME, yaw: -0.5, pitch: 0.35 }, frame: ['cellbox', 'metal', 'mcon', 'li1', 'contacts'], cut: 0, explode: 0.7 },
    { title: 'Oxide between', text: `In the chip every gap is filled with silicon dioxide: ${PDK.preLi} µm of it before li1, more before metal 1. The plugs are holes etched through it and filled with tungsten.`, view: { ...HOME, yaw: -0.7, pitch: 0.4 }, frame: ['cellbox'], cut: 1, explode: 0 },
    { title: 'Cells abut in rows', text: 'Every cell is the same height, so cells sit side by side in rows: the VDD and GND rails and the n-well run straight through from one to the next. A place-and-route tool fills a chip with rows of them.', view: { ...HOME, yaw: -0.45, pitch: 0.7 }, frame: ['rowbox'], cut: 0, explode: 0 },
  ];
}
/** The layers each beat lends (metal on throughout but where said; the dielectric in its beat, the row in its own). */
export const BEAT_LAYERS: readonly (readonly CellLayer[])[] = [['metal'], [], ['metal'], ['metal'], ['metal', 'ild'], ['metal', 'row']];
