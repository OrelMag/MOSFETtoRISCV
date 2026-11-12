// The MOSFET on the studio renderer, in true geometry (DOM-free; nanometres, x along the channel, y up, z across it):
// a 180 nm-class NMOS as a process draws it. The active area is bounded by shallow trench isolation. The source and drain
// are n+ islands, with lightly doped extensions under D-shaped spacers. Above the channel: a 4 nm gate oxide and a 200 nm
// polysilicon gate whose head lies on the field oxide, where its contact lands off the transistor. Silicide caps the
// islands and the poly; tungsten plugs in TiN liners rise to metal-1 stripes, one plug per 470 nm of width (so one on the
// chapter's 240 nm device).
//
// The physics is mosphys.ts's, the same as the cross-section above it and the prose. The channel sheet's thickness is
// the inversion charge (gradual channel, pinch-off at the drain). The depletion layer is the depth law. Both, and the
// body under them, are rebuilt in place as the gate and drain move (live deform). The body is cut into solids that
// never overlap, so the cut at z = 0 caps cleanly in the same colours as the 2D cross-section: the cut face is that
// figure.
//
// "Textbook" draws the simplified device the chapter's figure is (no STI, extensions, silicide or metal, the gate contact
// on the gate); "real layout" adds what a process has.

import type { RGB } from '../gl/instances';
import { lathe, merge, paint, refresh, roundedBox, surface, transform, extrude, type Geo } from '../gl/kit/geo';
import { M, type Material } from '../gl/kit/materials';
import type { Beat, Item, Model3, StudioAnchor } from '../gl/kit/scene';
import type { Mat4, Vec3 } from '../gl/math';
import { channelCharge, depletionDepth, VDD, VT } from './mosphys';

// ---------------------------------------------------------------- dimensions (nm)

/** Drawn channel length and width at 1×: a 180 nm-class device, the model's 1.8 V supply and 0.45 V threshold. */
export const L0 = 180, W0 = 240;
/** Gate oxide 4 nm (180 nm-node published range 2.9–4.5 nm); polysilicon 200 nm (typical, no named-process figure found);
 *  spacer base 60 nm (typical). */
export const OX = 4, POLY = 200, SPACER = 60;
/** Junction depths: the extension 54 nm (SPIE 3506: 0.3–0.5 × Lg; MIT 6.720 asks ≥ 60 nm), the deep n+ 120 nm (typical). */
export const XJ_LDD = 54, XJ_NP = 120;
/** Shallow trench isolation 350 nm deep (250–400 nm, ULSI process-integration notes); the band drawn 150 nm wide. */
export const STI_DEPTH = 350, STI_BAND = 150;
/** Each island long enough for one plug and its enclosure (illustrative), the body drawn 650 nm deep (cut off). */
export const ISLAND = 330, BODY = 650;
/** Salicide 30 nm (typical, no thickness found for a named flow). */
export const SILICIDE = 30;
/** Tungsten plugs about 0.22 µm across (typical at 180 nm), a 10 nm TiN liner, at a 470 nm pitch (0.22 µm plug + 0.25 µm
 *  space); the pre-metal dielectric 600 nm (typical), metal 1 280 nm wide and 350 nm thick (aluminium, typical). */
export const PLUG_D = 220, LINER = 10, PLUG_PITCH = 470, PMD = 600, M1_W = 280, M1_T = 350;
/** The poly head on the field oxide that carries the gate's contact: 120 nm from the active area, 360 × 300 nm. */
export const HEAD_GAP = 120, HEAD_W = 360, HEAD_L = 300, POLY_END = 80;
/** The channel sheet is a few nm thick in silicon: drawn up to 39 nm, its thickness proportional to the charge. */
export const SHEET_MAX = 39;
/** The depletion layer at its deepest (Vgs ≥ Vt): 90 nm, the 180 nm-class maximum depletion width. */
export const DEPL_MAX = 90;
const Q_MAX = VDD - VT;

export type MosLayout = 'textbook' | 'real';
export interface MosState { vg: number; vd: number; w: number; l: number; layout: MosLayout;
  /** The wiring in full (the tour's wiring beats); otherwise the plugs are drawn faint, so the device is seen first. */
  wiring?: boolean;
  /** The tour's pull-back: a low key light, haze to the horizon, a pool of light on this device. */
  pull?: boolean }

/** Plugs on one island: as many as fit at the plug pitch, at least one. */
export const plugsFor = (w: number): number => Math.max(1, Math.floor((W0 * w) / PLUG_PITCH));
/** The sheet's drawn thickness at x (0 source … 1 drain): proportional to the inversion charge. */
export const sheetAt = (s: Pick<MosState, 'vg' | 'vd'>, x: number): number => (SHEET_MAX * channelCharge(s.vg - VT, s.vd, x)) / Q_MAX;
/** The depletion layer's depth (nm): mosphys's depth law, √Vgs up to Vt, then no deeper. */
export const depletionAt = (vg: number): number => DEPL_MAX * depletionDepth(vg);

/** The device's extents at a size: half length, half width, the active area's edge in x, the whole footprint. */
export function extents(s: Pick<MosState, 'w' | 'l' | 'layout'>) {
  const hl = (L0 * s.l) / 2, hw = (W0 * s.w) / 2, xA = hl + SPACER + ISLAND, real = s.layout === 'real';
  const X = xA + (real ? STI_BAND : 45), Z = hw + (real ? HEAD_GAP + HEAD_L + 40 : 45);
  return { hl, hw, xA, X, Z, real, plugX: hl + SPACER + ISLAND / 2, headZ: hw + HEAD_GAP + HEAD_L / 2 };
}

// ---------------------------------------------------------------- geometry helpers

const tr = (p: Vec3): Mat4 => { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; m[12] = p[0]; m[13] = p[1]; m[14] = p[2]; return m; };
/** A sharp box between two corners. */
/** Every solid stands GAP nm in from its stated faces: neighbours that touch (the n+ island on the body, the oxide on the
 *  silicon) then never share a plane, so a cut's caps (drawn from each solid's own back faces) cannot fight. At these
 *  distances the depth buffer resolves about 0.01 nm, and 1.2 nm between neighbours is below a pixel. */
const GAP = 0.6;
const bx = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, r = 0): Geo =>
  transform(roundedBox(x1 - x0 - 2 * GAP, y1 - y0 - 2 * GAP, z1 - z0 - 2 * GAP, r, r > 0 ? 2 : 0), tr([(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2]));
/** An outline in (x, y) pushed along z from z0 to z1 (extrude works in x, z along +y: turned so its height runs along −z). */
const alongZ = (outline: [number, number][], z0: number, z1: number): Geo => {
  const m = new Float32Array(16); // (x, h, v) → (x, v, z1 − h): a rotation about x, then a shift
  m[0] = 1; m[9] = 1; m[6] = -1; m[15] = 1; m[14] = z1;
  return transform(extrude(outline, z1 - z0), m);
};
/** An outline in (x, z) pushed up from y0 by h. */
const up = (outline: [number, number][], y0: number, h: number): Geo => transform(extrude(outline, h - 2 * GAP), tr([0, y0 + GAP, 0]));
/** A plug from y0 to y1 at (x, z): a tungsten core tapering out a little towards the top, and its TiN liner as a shell. */
function plug(x: number, z: number, y0: number, y1: number, seg: number): { core: Geo; liner: Geo } {
  const r0 = PLUG_D / 2 - LINER - 8, r1 = PLUG_D / 2 - LINER;
  const core = transform(lathe([[0, y0 + GAP], [r0, y0 + GAP], [r1, y1], [0, y1]], { seg, crease: 30 }), tr([x, 0, z]));
  const liner = transform(lathe([[r0 + 2 * GAP, y0 + GAP], [r0 + LINER, y0 + GAP], [r1 + LINER, y1], [r1 + 2 * GAP, y1]], { seg, crease: 30 }), tr([x, 0, z]));
  return { core, liner };
}
/** A spacer's D profile in (x, y) beside the gate edge at x = e, bulging towards side s (−1 source, +1 drain). */
const dProfile = (e: number, s: number): [number, number][] => {
  const top = OX + POLY * 0.9, out: [number, number][] = [[e + s * GAP, GAP], [e + s * GAP, top]];
  for (let k = 1; k <= 8; k++) { const t = (k / 8) * (Math.PI / 2); out.push([e + s * (GAP + (SPACER - GAP) * Math.sin(t)), Math.max(GAP, top * Math.cos(t))]); }
  return out;
};

/** The channel sheet as one closed mesh under the oxide: thickness sheetAt(x) along the length, the width across, every
 *  face its own surface (fixed vertex counts, so it refreshes in place). */
const SHEET_NU = 40;
function sheetGeo(s: MosState, hl: number, hw: number): Geo {
  const t = (u: number) => Math.max(0.4, sheetAt(s, u)), x = (u: number) => -hl + 2 * hl * u;
  return merge([
    surface((u, v) => [x(v), 0, -hw + 2 * hw * u], 1, SHEET_NU),           // top, facing up
    surface((u, v) => [x(u), -t(u), -hw + 2 * hw * v], SHEET_NU, 1),       // bottom, facing down
    surface((u, v) => [x(v), -t(v) * u, hw], 1, SHEET_NU),                  // front
    surface((u, v) => [x(u), -t(u) * v, -hw], SHEET_NU, 1),                 // back
    surface((u, v) => [-hl, -t(0) * v, hw - 2 * hw * u], 1, 1),             // the source end
    surface((u, v) => [hl, -t(1) * u, hw - 2 * hw * v], 1, 1),              // the drain end
  ], 'channel sheet');
}

// ---------------------------------------------------------------- materials

const mat = (base: Material['base'], o: Partial<Material> & { label: string }): Material => M.make({ base, metal: 0, rough: 0.5, ...o });
/** What each thing is, by how it looks: crystalline silicon with a sheen; polysilicon matte and grainy (not a metal);
 *  silicide, tungsten and TiN metallic; the trench oxide a clear glass the active area shows through; the 4 nm gate
 *  oxide lit, so the line the whole device turns on can be found. */
const MATS = {
  p: mat('--m3-p', { metal: 0.15, rough: 0.3, coat: 0.35, label: 'p-type silicon (boron, ~10¹⁷ cm⁻³), crystalline' }),
  n: mat('--m3-n', { metal: 0.15, rough: 0.3, coat: 0.35, label: 'n+ silicon (arsenic, ~10²⁰ cm⁻³)' }),
  ldd: mat('--mf-ldd', { metal: 0.12, rough: 0.32, coat: 0.3, label: 'n− extension (lightly doped drain)' }),
  sti: mat('--m3-oxide', { rough: 0.06, transmit: 0.78, tint: [0.9, 0.95, 1.0], label: 'trench oxide (SiO₂), glass-clear' }),
  oxide: mat('--m3-oxide', { rough: 0.15, coat: 0.5, emit: [0.72, 0.93, 1.0], glow: 0.9, bloom: 1.6, label: 'gate oxide (SiO₂), 4 nm, drawn lit' }),
  spacer: mat('--mf-spacer', { rough: 0.35, coat: 0.2, label: 'spacer (Si₃N₄ on an oxide liner)' }),
  poly: mat('--mf-poly', { metal: 0.03, rough: 0.62, label: 'polysilicon (n+ doped), grainy' }),
  silicide: M.silicide,
  tungsten: M.make({ base: [0.8, 0.8, 0.78], metal: 0.9, rough: 0.28, label: 'tungsten' }),
  tin: M.make({ base: [0.9, 0.76, 0.46], metal: 0.75, rough: 0.28, label: 'TiN liner' }),
  metal1: M.make({ base: [0.9, 0.91, 0.92], metal: 0.85, rough: 0.35, label: 'metal 1 (aluminium)' }),
  plugGhost: M.make({ base: [0.86, 0.87, 0.9], metal: 0, rough: 0.08, transmit: 0.82, tint: [0.92, 0.93, 0.97], label: 'tungsten plug in a TiN liner (drawn faint: the tour shows the wiring)' }),
  depl: mat('--mf-depl', { transmit: 0.42, rough: 0.6, emit: '--mf-depl', glow: 0.32, label: 'depletion layer (bare acceptor ions)' }),
};
/** A doped island painted per vertex: its own colour at the surface, fading towards the body's at the junction (a
 *  profile, not a slab with a hard edge). Needs the theme's colours resolved (the stage's rgb). */
const GRADED = { n: { ...MATS.n, base: [1, 1, 1] as RGB }, ldd: { ...MATS.ldd, base: [1, 1, 1] as RGB } };
const grade = (g: Geo, top: RGB, body: RGB, depth: number) =>
  paint(g, (p) => { const f = 0.88 * Math.min(1, Math.max(0, -p[1] / depth)); return [top[0] + (body[0] - top[0]) * f, top[1] + (body[1] - top[1]) * f, top[2] + (body[2] - top[2]) * f]; });

// ---------------------------------------------------------------- the model

/** Geometry that only the size and the layout decide, built once per (w, l, layout, detail); what the bias moves is in
 *  `live`, refreshed in place by every build. */
interface Built { static: Item[]; live: { sheet: Geo; depl: Geo; body: Geo }; key: string }
const memo = new Map<string, Built>();

const SRC = {
  node: 'onsemi ONC18 (drawn L 0.18 µm, oxide 2.9 / 6.5 nm); Philips, IBM and MIT 0.18 µm figures 3.0–4.5 nm',
  ulsi: 'ULSI process-integration notes, 0.18 µm cross-section (NSYSU ch. 4)',
  ldd: 'SPIE 3506 (extension Xj 0.3–0.5 × Lg); MIT OCW 6.720 design project (Xj ≥ 60 nm)',
  wh: 'Weste & Harris, CMOS VLSI Design, ch. 3',
  typ: 'typical for the node; no named-process figure found',
};

function staticItems(s: MosState, detail: 'full' | 'flat'): Built {
  const key = `${s.w}|${s.l}|${s.layout}|${detail}`, hit = memo.get(key);
  if (hit) return hit;
  const { hl, hw, xA, X, Z, real, plugX, headZ } = extents(s), seg = detail === 'flat' ? 10 : 28, items: Item[] = [];
  const add = (geo: Geo, m: Material, name: string, group: string, extra: Partial<Item> = {}) => items.push({ geo, mat: m, name, group, ...extra });
  // ---- silicon: n+ islands (and, real, the extensions under the spacers), the body under and around them
  const isl0 = real ? hl + SPACER : hl;
  for (const sx of [-1, 1]) {
    const a = sx < 0 ? -xA : isl0, b = sx < 0 ? -isl0 : xA;
    add(bx(a, b, -XJ_NP, 0, -hw, hw), MATS.n, sx < 0 ? 'source' : 'drain', 'silicon', {
      info: { dim: `n+ island, junction ${XJ_NP} nm deep`, source: SRC.typ, note: sx < 0 ? 'electrons enter here' : 'electrons leave here' } });
    add(bx(a, b, -BODY, -XJ_NP, -hw, hw), MATS.p, 'p-type body', 'silicon');
    if (real) {
      const c = sx < 0 ? -hl - SPACER : hl, d = sx < 0 ? -hl : hl + SPACER;
      add(bx(c, d, -XJ_LDD, 0, -hw, hw), MATS.ldd, 'extension (LDD)', 'silicon', { info: { dim: `${XJ_LDD} nm deep, under the spacer`, source: SRC.ldd, note: 'a lighter doping where the field is strongest, so fewer hot electrons damage the oxide' } });
      add(bx(c, d, -BODY, -XJ_LDD, -hw, hw), MATS.p, 'p-type body', 'silicon');
    }
  }
  // around the active area: the trench oxide over the body (real), or a rim of the body (textbook)
  const ring = (y0: number, y1: number, m: Material, name: string, group: string, extra: Partial<Item> = {}) => {
    add(bx(-X, -xA, y0, y1, -Z, Z), m, name, group, extra); add(bx(xA, X, y0, y1, -Z, Z), m, name, group, extra);
    add(bx(-xA, xA, y0, y1, hw, Z), m, name, group, extra); add(bx(-xA, xA, y0, y1, -Z, -hw), m, name, group, extra);
  };
  if (real) {
    ring(-STI_DEPTH, 0, MATS.sti, 'trench isolation (STI)', 'oxide', { info: { dim: `${STI_DEPTH} nm deep`, source: SRC.ulsi, note: 'oxide-filled trenches that keep neighbouring transistors apart' } });
    ring(-BODY, -STI_DEPTH, MATS.p, 'p-type body', 'silicon');
  } else ring(-BODY, 0, MATS.p, 'p-type body', 'silicon');
  // ---- above the silicon: the gate oxide, the spacers, the poly gate (and its head on the field oxide), silicide
  add(bx(-hl, hl, 0, OX, -hw, hw), MATS.oxide, 'gate oxide', 'oxide', { explode: [0, 120, 0], info: { dim: `${OX} nm, at true scale`, source: SRC.node, note: 'about 15 atoms thick: the gate\'s field acts through it' } });
  const zg0 = real ? -hw - POLY_END : -hw, zg1 = real ? hw + HEAD_GAP : hw;
  add(merge([alongZ(dProfile(-hl, -1), zg0, zg1), alongZ(dProfile(hl, 1), zg0, zg1)], 'spacers'), MATS.spacer, 'spacers', 'spacers', { explode: [0, 250, 0], info: { dim: `${SPACER} nm at the base`, source: SRC.typ, note: 'they set where the deep n+ implant starts, so the extensions stay under them' } });
  const gateOutline: [number, number][] = real
    ? [[-hl, zg0], [hl, zg0], [hl, zg1], [HEAD_W / 2, zg1], [HEAD_W / 2, zg1 + HEAD_L], [-HEAD_W / 2, zg1 + HEAD_L], [-HEAD_W / 2, zg1], [-hl, zg1]]
    : [[-hl, -hw], [hl, -hw], [hl, hw], [-hl, hw]];
  add(up(gateOutline, OX, POLY), MATS.poly, 'gate', 'gate', { explode: [0, 420, 0], info: { dim: `${POLY} nm polysilicon${real ? '; its head lies on the trench oxide' : ''}`, source: SRC.typ, note: real ? 'the gate contact lands on the head, off the transistor, so the plug never presses on the thin oxide' : 'drawn as the chapter\'s figure: the contact on the gate itself' } });
  if (real) {
    add(up(gateOutline, OX + POLY, SILICIDE), MATS.silicide, 'silicide', 'gate', { explode: [0, 420, 0], info: { dim: `about ${SILICIDE} nm (CoSi₂ or TiSi₂)`, source: SRC.typ, note: 'a metal–silicon compound: the poly and the islands conduct like metal at their surface' } });
    for (const sx of [-1, 1]) add(bx(sx < 0 ? -xA : hl + SPACER, sx < 0 ? -hl - SPACER : xA, 0, SILICIDE, -hw, hw), MATS.silicide, 'silicide', 'silicide', { explode: [0, 180, 0] });
  }
  // ---- contacts: one plug per PLUG_PITCH of width on each island, the gate's on its head (real) or on the gate (textbook)
  const n = plugsFor(s.w), yB = real ? SILICIDE : 0;
  const plugs: { core: Geo; liner: Geo }[] = [];
  for (const sx of [-1, 1]) for (let i = 0; i < n; i++) plugs.push(plug(sx * plugX, -hw + ((i + 0.5) * 2 * hw) / n, yB, PMD, seg));
  const gy = OX + POLY + (real ? SILICIDE : 0);
  plugs.push(plug(0, real ? headZ : 0, gy, PMD, seg));
  add(merge(plugs.map((p) => p.core), 'plugs'), MATS.tungsten, 'contact plug', 'plugs', { explode: [0, 650, 0], info: { dim: `about ${PLUG_D} nm across, ${PMD} nm tall; ${n} per island at a ${PLUG_PITCH} nm pitch`, source: SRC.ulsi, note: `tungsten in a TiN liner, through the dielectric (left out here, it would hide everything) up to metal 1. A ${Math.round(W0 * s.w)} nm-wide device holds ${n === 1 ? 'one plug' : `${n} plugs`} on each island.` } });
  add(merge(plugs.map((p) => p.liner), 'liners'), MATS.tin, 'contact plug', 'plugs', { explode: [0, 650, 0] });
  if (real) {
    const m1 = [
      bx(-plugX - M1_W / 2, -plugX + M1_W / 2, PMD, PMD + M1_T, -hw - 200, hw + 60, 12),
      bx(plugX - M1_W / 2, plugX + M1_W / 2, PMD, PMD + M1_T, -hw - 200, hw + 60, 12),
      bx(-M1_W / 2, M1_W / 2, PMD, PMD + M1_T, headZ - M1_W / 2, Z + 60, 12),
    ];
    add(merge(m1, 'metal 1'), MATS.metal1, 'metal 1', 'metal', { explode: [0, 900, 0], info: { dim: `${M1_W} nm wide, ${M1_T} nm thick`, source: SRC.typ, note: 'source, drain and gate wired out: the first metal layer' } });
  }
  const sheet = sheetGeo({ ...s, vg: VT + 0.9, vd: 0 }, hl, hw);
  const depl = bx(-hl, hl, -DEPL_MAX, 0, -hw, hw), body = bx(-hl, hl, -BODY, -DEPL_MAX, -hw, hw);
  const built: Built = { static: items, live: { sheet, depl, body }, key };
  memo.set(key, built);
  return built;
}

/** `rgb`: the theme's colours (the stage's), for the doped regions' graded profile; without it they are flat. */
export function mosModel(s: MosState, detail: 'full' | 'flat' = 'full', rgb?: (token: string) => RGB): Model3 {
  const B = staticItems(s, detail), { hl, hw, xA, X, Z, real, plugX, headZ } = extents(s), dep = depletionAt(s.vg), on = s.vg > VT;
  // live deform: the body under the channel stops where the depletion layer starts; the sheet takes the charge's profile
  refresh(B.live.body, bx(-hl, hl, -BODY, -Math.max(dep, 0.5), -hw, hw));
  refresh(B.live.depl, bx(-hl, hl, -Math.max(dep, 0.5), 0, -hw, hw));
  if (on) refresh(B.live.sheet, sheetGeo(s, hl, hw));
  const body = rgb?.('--m3-p');
  const statics = !rgb || !body ? B.static : B.static.map((it) =>
    it.mat === MATS.n ? { ...it, geo: grade(it.geo, rgb('--m3-n'), body, XJ_NP), mat: GRADED.n }
      : it.mat === MATS.ldd ? { ...it, geo: grade(it.geo, rgb('--mf-ldd'), body, XJ_LDD), mat: GRADED.ldd } : it);
  const items: Item[] = [...statics.map((it) => (it.group === 'plugs' && !s.wiring ? { ...it, mat: MATS.plugGhost, shadow: false } : it)), { geo: B.live.body, mat: MATS.p, name: 'p-type body', group: 'silicon' }];
  if (dep > 1) items.push({ geo: B.live.depl, mat: MATS.depl, name: 'depletion layer', group: 'channel', info: { dim: `${Math.round(dep)} nm deep (at most ${DEPL_MAX} nm)`, source: 'mosphys.ts: the depth law, √Vgs up to Vt', note: 'the gate\'s field has pushed the holes away, leaving the boron ions bare' } });
  // the sheet brightens with the overdrive: the more charge the gate has gathered, the more it glows
  const lit = Math.min(1, Math.max(0, (s.vg - VT) / Q_MAX));
  if (on) items.push({ geo: B.live.sheet, mat: { ...M.make({ base: '--m3-charge', metal: 0, rough: 0.5, label: 'inversion layer (electrons), drawn thicker than life' }), emit: '--m3-charge', glow: 0.25 + 1.3 * lit, bloom: 1.4 }, name: 'channel', group: 'channel', info: { dim: `drawn up to ${SHEET_MAX} nm; a few nm in silicon`, source: 'mosphys.ts channelCharge: the gradual-channel charge', note: 'thick at the source, thinning towards the drain; pinched off in saturation' } });
  const front: Vec3 = [0, 0.3, 1], upN: Vec3 = [0, 1, 0];
  const anchors: StudioAnchor[] = [
    { text: 'source', p: [-(hl + xA) / 2 - SPACER / 2, -XJ_NP * 0.4, 0], side: 'l', n: front, on: 'silicon' },
    { text: 'drain', p: [(hl + xA) / 2 + SPACER / 2, -XJ_NP * 0.4, 0], side: 'r', n: front, on: 'silicon' },
    { text: 'gate', p: [0, OX + POLY * 0.6, 0], side: 'r', n: front, on: 'gate' },
    { text: 'gate oxide, 4 nm', p: [-hl * 0.6, OX / 2, 0], side: 'l', n: front, on: 'oxide' },
    { text: 'channel', p: [hl * 0.4, -6, 0], side: 'r', n: front, on: 'channel' },
    { text: 'contact plug', p: [-plugX, PMD * 0.45, -hw + hw / plugsFor(s.w)], side: 'l', n: [0, 0, 1], on: 'plugs' },
    { text: 'p-type body', p: [-xA * 0.6, -BODY * 0.5, 0], side: 'b', n: front, on: 'silicon' },
    { text: `L = ${Math.round(L0 * s.l)} nm`, p: [hl * 0.5, OX + POLY, 0], side: 't', n: front, on: 'gate' },
    { text: `W = ${Math.round(W0 * s.w)} nm`, p: [hl, OX + POLY, 0], side: 'r', n: [1, 0.4, 0], on: 'gate' },
  ];
  if (real) anchors.push(
    { text: 'trench oxide', p: [X - STI_BAND / 2, -STI_DEPTH / 2, 0], side: 'r', n: front, on: 'oxide' },
    { text: 'metal 1', p: [plugX, PMD + M1_T, 0], side: 'r', n: upN, on: 'metal' },
    { text: 'gate head', p: [0, OX + POLY, headZ], side: 'r', n: upN, on: 'gate', minor: true },
  );
  const side = { yaw: 0, pitch: 0.06, target: [0, 0, 0] as Vec3, dist: 2000 };
  const f = fieldOf(s);
  const beats: Beat[] = [
    { title: 'One slice, and its width', text: 'The cut at the middle of the gate is the cross-section above, in the same colours. Everything the slice cannot show runs into the page: the width W, the plugs along it, the gate running on past the active area.', view: side, frame: SECTION_FRAME, cut: 1 },
    { title: 'The channel', text: 'Under 4 nm of oxide the gate\'s field gathers electrons into a sheet a few nm thick (drawn thicker). It is thick at the source and thins towards the drain, where the drain voltage takes away from the gate\'s: past saturation it pinches off before the drain.', view: { yaw: -0.3, pitch: 0.25, target: [0, 0, 0], dist: 900 }, frame: ['channel', 'gate oxide', 'extension (LDD)'], show: ['channel', 'oxide', 'gate', 'silicon'], cut: 1 },
    { title: 'First ions, then electrons', text: 'Below Vt the gate only pushes holes away: the amber layer of bare boron ions deepens as √Vgs. At Vt it stops; every further charge on the gate is matched by electrons in the channel instead. Move the gate across 0.45 V and watch the layer stop and the sheet appear.', view: { yaw: -0.15, pitch: 0.15, target: [0, -40, 0], dist: 900 }, frame: ['channel', 'depletion layer', 'gate oxide'], show: ['channel', 'oxide', 'silicon'], cut: 1 },
    { title: 'What a process adds', text: real ? 'The trenches of oxide that isolate it, the lighter extensions under the spacers, silicide on every contact surface, tungsten plugs up to metal 1, and the gate\'s head out on the field oxide, where its contact lands.' : 'Switch to Real layout: the trenches of oxide that isolate it, lighter extensions under the spacers, silicide, tungsten plugs up to metal 1, and the gate\'s head out on the field oxide, where its contact lands.', view: { yaw: -0.6, pitch: 0.5, target: [0, 200, 0], dist: 3000 }, frame: real ? ['metal', 'oxide', 'gate', 'plugs'] : undefined, cut: 0, hide: [] },
    { title: 'Layer by layer', text: 'Pulled apart in the order they are made, bottom up: silicon and its trenches, the gate oxide, the gate, the spacers, silicide, the plugs, metal 1. Each is one more mask (the masks chapter draws the same stack).', view: { yaw: -0.55, pitch: 0.42, target: [0, 400, 0], dist: 3600 }, frame: ['silicon', 'gate', 'plugs', ...(real ? ['metal'] : [])], explode: 1, cut: 0, hide: [] },
    { title: 'Tens of millions of them', text: `With its trenches this one takes ${f.w} × ${f.d} nm. At that pitch a square centimetre of silicon holds about ${fmtCount(f.perCm2)} of them; a processor of this generation (Intel's Pentium 4, 180 nm, 2000) held 42 million. Each is the device you just took apart, gate, oxide and all. Today's processors hold billions, each in a small fraction of this area.`, view: FIELD_VIEW, explode: 0, cut: 0, labels: false },
  ];
  return {
    items, anchors, beats, floor: -BODY,
    cuts: { planes: [{ n: [0, 0, 1], d: 0 }], open: [Z + 50] },
    look: s.pull ? PULL_LOOK : { exposure: 0.95 },
    lights: s.pull ? [{ p: [0, 1100, 300], colour: [1, 0.93, 0.8], power: 1.6, range: 1300 }] : undefined,
  };
}

/** Home: close and low, on the gate (its oxide and the channel under it are the picture); fitted to MOS_HOME_FRAME. */
export const MOS_HOME = { target: [0, 0, 0] as Vec3, yaw: -0.32, pitch: 0.3, dist: 1400 };
export const MOS_HOME_FRAME = ['gate', 'spacers', 'gate oxide', 'extension (LDD)', 'channel', 'depletion layer'];
/** The cut: the section itself (the islands, trenches and what lies on them), not the body's arbitrary depth. */
const SECTION_FRAME = ['source', 'drain', 'gate', 'gate oxide', 'spacers', 'extension (LDD)', 'trench isolation (STI)', 'depletion layer', 'silicide'];
/** Outside the tour the wiring waits for its beat, so the device is seen first. */
export const MOS_HIDDEN = ['metal'];
/** The pull-back's light: low, raking across the view from its right (each gate's long shadow falls towards the
 *  reader's left, in sight), haze over a few tens of µm. */
const PULL_LOOK = { exposure: 0.9, keyDir: [0.8, 0.2, -0.25] as Vec3, haze: { colour: '--st-back-1' as const, dist: 17000 } };
/** The field as a wafer: dark polished silicon, darker islands, the gates catching the low light. */
const FIELD_MATS = {
  si: M.make({ base: [0.15, 0.17, 0.22], metal: 0.45, rough: 0.38, label: 'silicon wafer' }),
  n: M.make({ base: [0.36, 0.17, 0.24], metal: 0.25, rough: 0.4, label: 'n+ islands' }),
  gate: M.make({ base: [0.42, 0.4, 0.58], metal: 0.05, rough: 0.45, label: 'polysilicon gates' }),
};
const FIELD_VIEW = { yaw: -0.55, pitch: 0.17, target: [0, 0, 0] as Vec3, dist: 9000 };

const fmtCount = (n: number) => {
  const e = Math.floor(Math.log10(n)), m = Math.round(n / 10 ** (e - 1)) / 10;
  return e >= 6 ? `${(n / 1e6).toFixed(0)} million` : `${m} × 10^${e}`;
};

/** The pull-back's field: this device repeated at its own footprint (trenches included), `R` rows each way around it. */
export function fieldOf(s: Pick<MosState, 'w' | 'l' | 'layout'>) {
  const { X, Z } = extents(s), w = Math.round(2 * X), d = Math.round(2 * Z);
  return { w, d, perCm2: 1e14 / (w * d) };
}
export const FIELD_R = 40;
/** Offsets of the field's copies: a (2R + 1)² grid less the middle, where the real device is. */
export function fieldSites(s: Pick<MosState, 'w' | 'l' | 'layout'>, R = FIELD_R): Vec3[] {
  const { w, d } = fieldOf(s), out: Vec3[] = [];
  for (let i = -R; i <= R; i++) for (let j = -R; j <= R; j++) if (i || j) out.push([i * w, 0, j * d]);
  return out;
}
/** One copy of the device as a few meshes (one per material, so a set of instances each): a slab of silicon the size
 *  of its footprint, the islands, the gate. No plugs: from far, a forest of them would hide the transistors. */
export function fieldParts(s: MosState): { key: string; geo: Geo; mat: Material }[] {
  const { hl, hw, xA, X, Z, real } = extents(s), isl0 = real ? hl + SPACER : hl;
  const slab = bx(-X, X, -80, 0, -Z, Z), isl = merge([bx(-xA, -isl0, -XJ_NP, 1, -hw, hw), bx(isl0, xA, -XJ_NP, 1, -hw, hw)], 'islands');
  const gate = bx(-hl, hl, OX, OX + POLY, real ? -hw - POLY_END : -hw, real ? hw + HEAD_GAP : hw);
  return [
    { key: 'field silicon', geo: slab, mat: FIELD_MATS.si },
    { key: 'field islands', geo: isl, mat: FIELD_MATS.n },
    { key: 'field gates', geo: gate, mat: FIELD_MATS.gate },
  ];
}

/** Where the cut stands at opening c (the model's plane z = d; nothing cut at 0): the particles the view draws stop there. */
export const cutZ = (s: Pick<MosState, 'w' | 'l' | 'layout'>, c: number): number => (c <= 0 ? Infinity : (extents(s).Z + 50) * (1 - c));

/** Seeded positions in the depletion volume: the bare acceptor ions, shown down to the layer's depth. */
export function ionsAt(s: MosState, seed = 7): Vec3[] {
  const { hl, hw } = extents(s), out: Vec3[] = [], dep = depletionAt(s.vg);
  let r = seed;
  const rnd = () => { r = (r * 16807) % 2147483647; return r / 2147483647; };
  const n = Math.round(90 * s.w * s.l);
  for (let k = 0; k < n; k++) {
    const p: Vec3 = [-hl + 2 * hl * rnd(), -DEPL_MAX * rnd(), -hw + 2 * hw * rnd()];
    if (-p[1] < dep - 3) out.push(p);
  }
  return out;
}

/** Where each plug stands (the view runs electrons through them): source and drain plugs down the islands, the gate's. */
export function plugSites(s: Pick<MosState, 'w' | 'l' | 'layout'>): { x: number; z: number; y0: number; y1: number; kind: 's' | 'd' | 'g' }[] {
  const { hw, plugX, headZ, real } = extents(s), n = plugsFor(s.w), yB = real ? SILICIDE : 0, out: ReturnType<typeof plugSites> = [];
  for (const sx of [-1, 1]) for (let i = 0; i < n; i++) out.push({ x: sx * plugX, z: -hw + ((i + 0.5) * 2 * hw) / n, y0: yB, y1: PMD, kind: sx < 0 ? 's' : 'd' });
  out.push({ x: 0, z: real ? headZ : 0, y0: OX + POLY + (real ? SILICIDE : 0), y1: PMD, kind: 'g' });
  return out;
}
