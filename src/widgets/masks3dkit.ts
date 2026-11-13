// The chip built mask by mask, for the studio renderer (DOM-free, tested). What is where is masks3dparts.ts's, computed
// from the cell (the implant windows, self-alignment, the shifted gate): its slabs are taken as they are, each tagged with
// the role it plays, merged per role and given that stuff's material: silicon doped three ways, trench oxide, a gate oxide
// film, polysilicon, photoresist, the interlayer oxide, tungsten contacts, aluminium metal, and the reticle as a quartz
// plate with its chrome pattern and a pellicle on a frame. The light through the reticle's clear areas is a beam; in the
// implant steps ions fall through the window as instances and stop where the stack stops them: in the silicon, or on the
// gate and the field oxide.

import { merge, transform, type Geo } from '../gl/kit/geo';
import { M, type Material } from '../gl/kit/materials';
import type { Beat, Item, Model3, StudioAnchor } from '../gl/kit/scene';
import { UNIT_BOX, UNIT_CYL } from '../gl/kit/fromparts';
import type { Instance, RGB } from '../gl/instances';
import type { Mat4, Vec3 } from '../gl/math';
import type { OrbitView } from '../gl/camera';
import type { Part } from '../gl/parts';
import { activeOf, implanted, LAYERS, MARGIN, MASK_AT, maskRects, masksAnchors, masksParts, minus, place, polyOf, slabs, windowOf, zs, type Layer, type MasksPalette, type MasksState, type R } from './masks3dparts';
import type { Cell } from './silicon';

export type Role = 'psub' | 'sti' | 'gox' | 'resist' | 'ild' | 'uv' | 'chrome' | 'plate' | 'pell' | 'frame' | Layer;
/** masksParts with each part's colour standing for its role: the geometry stays the one the tests pin. */
const ROLE_PALETTE = {
  psub: 'psub', sti: 'sti', gox: 'gox', resist: 'resist', ild: 'ild', uv: 'uv', chrome: 'chrome', plate: 'plate', pell: 'pell', frame: 'frame',
  layer: Object.fromEntries(LAYERS.map((l) => [l, l])),
} as unknown as MasksPalette;
export const roleOf = (p: Part): Role => p.color as unknown as Role;

const mk = (m: Material): Material => M.make(m);
export const MATS: Record<Role, Material> = {
  psub: mk({ base: [0.47, 0.49, 0.54], metal: 0.35, rough: 0.3, label: 'p-type silicon: the wafer' }),
  nwell: mk({ base: '--mk-nwell', metal: 0.2, rough: 0.35, label: 'n-well: silicon doped n, the PMOS pocket' }),
  ndiff: mk({ base: '--mk-ndiff', metal: 0.2, rough: 0.35, label: 'n+ silicon: NMOS source and drain' }),
  pdiff: mk({ base: '--mk-pdiff', metal: 0.2, rough: 0.35, label: 'p+ silicon: PMOS source and drain' }),
  sti: mk({ base: '--mk-sti', metal: 0, rough: 0.2, coat: 0.5, label: 'trench oxide (STI): silicon dioxide' }),
  gox: mk({ base: '--mk-gox', metal: 0, rough: 0.15, coat: 0.6, label: 'gate oxide (thickness drawn, not to scale)' }),
  poly: mk({ ...M.polysilicon, base: '--mk-poly', label: 'polysilicon: the gates' }),
  resist: mk({ base: '--mk-resist', metal: 0, rough: 0.3, transmit: 0.35, label: 'photoresist: what the light did not reach stays' }),
  ild: mk({ base: '--mk-ild', metal: 0, rough: 0.1, transmit: 0.8, tint: '--mk-ild', label: 'interlayer oxide (pre-metal dielectric)' }),
  contact: mk({ ...M.tungsten, label: 'contacts (licon1): tungsten-filled holes in sky130' }),
  metal: mk({ ...M.aluminium, label: 'metal 1: aluminium in sky130' }),
  plate: mk({ ...M.quartz, transmit: 0.96, label: 'reticle: a fused-quartz plate (a real one is 6 in square, 1/4 in thick)' }),
  chrome: mk({ base: [0.78, 0.79, 0.82], metal: 1, rough: 0.22, label: 'chrome: a film some 0.1 µm thick on the plate’s underside, opaque to the light' }),
  pell: mk({ base: '--mk-pell', metal: 0, rough: 0.05, transmit: 0.97, label: 'pellicle: a membrane that keeps dust out of focus' }),
  frame: mk({ base: '--mk-frame', metal: 0.6, rough: 0.4, label: 'pellicle frame' }),
  uv: M.beam('--mk-uv', 1.6, 'ultraviolet light through the clear areas'),
};
const NAME: Record<Role, string> = {
  psub: 'p-type wafer', nwell: 'n-well', ndiff: 'n+ source / drain', pdiff: 'p+ source / drain', sti: 'trench oxide', gox: 'gate oxide', poly: 'polysilicon',
  resist: 'photoresist', ild: 'interlayer oxide', contact: 'contacts', metal: 'metal 1', plate: 'reticle', chrome: 'chrome pattern', pell: 'pellicle', frame: 'pellicle frame', uv: 'UV light',
};
const GROUP: Record<Role, string> = {
  psub: 'wafer', nwell: 'wafer', ndiff: 'wafer', pdiff: 'wafer', sti: 'wafer', gox: 'gate', poly: 'gate', resist: 'gate', ild: 'wiring', contact: 'wiring', metal: 'wiring',
  plate: 'reticle', chrome: 'reticle', pell: 'reticle', frame: 'reticle', uv: 'light',
};
const ORDER: Role[] = ['psub', 'nwell', 'ndiff', 'pdiff', 'sti', 'gox', 'poly', 'resist', 'contact', 'metal', 'ild', 'frame', 'chrome', 'plate', 'pell', 'uv'];

const trs = (p: Vec3, s: Vec3): Mat4 => { const m = new Float32Array(16); m[0] = s[0]; m[5] = s[1]; m[10] = s[2]; m[15] = 1; m[12] = p[0]; m[13] = p[1]; m[14] = p[2]; return m; };
const geoOf = (p: Part): Geo => transform(p.kind === 'box' ? UNIT_BOX : UNIT_CYL, trs(p.pos, p.scale ?? [1, 1, 1]));

/** The cut: the side nearer the viewer than the NMOS row's middle, so the section runs along the row through its gates. */
export function cutZ(c: Cell): number {
  const a = activeOf(c, 'n'), y0 = Math.min(...a.map((r) => r[1])), y1 = Math.max(...a.map((r) => r[1] + r[3]));
  return place(c, 0, (y0 + y1) / 2, 0)[2];
}

/** The reticle's drawn thickness (layout units). */
export const PLATE_T = 2;
export const MK_HOME: OrbitView = { target: [0, 3.5, 4], yaw: -0.42, pitch: 0.22, dist: 45 };
/** The tour's steps (silicon.ts FAB indices): the trench mask, the light through the poly reticle, the implant beside the gate, the metal. */
export const TOUR_STEPS = [1, 4, 6, 9];

export function masksModel(c: Cell, st: MasksState): Model3 {
  const parts = masksParts(c, st, ROLE_PALETTE), by = new Map<Role, Geo[]>(), m = MASK_AT[st.step];
  // An implant mask is dark-field: chrome everywhere but the window, so the ions are seen to come through it.
  const dark = m === 'nsdm' || m === 'psdm';
  if (m) {
    // the plate drawn with a visible thickness (a real one is 1/24 of its width), the chrome as a thin film under it
    const z = zs(st.spread), plate: R = [-MARGIN, -MARGIN, c.w + 2 * MARGIN, 44 + 2 * MARGIN];
    by.set('plate', slabs(c, 'plate' as never, [plate], z.plate, z.plate + PLATE_T).map(geoOf));
    by.set('chrome', slabs(c, 'chrome' as never, dark ? minus([plate], maskRects(c, m)) : maskRects(c, m, st.shift), z.plate - 0.08, z.plate).map(geoOf));
  }
  for (const p of parts) {
    const r = roleOf(p);
    if (r === 'chrome' || r === 'plate') continue;
    // the beams a little wider than the parts' rays, so they read at the model's size
    const g = r === 'uv' ? geoOf({ ...p, scale: [p.scale![0] * 2.6, p.scale![1], p.scale![2] * 2.6] }) : geoOf(p);
    by.set(r, [...(by.get(r) ?? []), g]);
  }
  const items: Item[] = [];
  for (const r of ORDER) {
    const gs = by.get(r);
    if (!gs?.length) continue;
    const glassy = !!MATS[r].transmit || r === 'uv';
    items.push({ geo: merge(gs, r), mat: MATS[r], name: NAME[r], group: GROUP[r], cut: GROUP[r] === 'reticle' || r === 'uv' ? 'none' : 'section', shadow: glassy || GROUP[r] === 'reticle' ? false : undefined });
  }
  const z = zs(st.spread), cz = cutZ(c);
  const anchors: StudioAnchor[] = masksAnchors(c, st).map((a) => ({ ...a, ...(a.text.endsWith(' reticle') ? { on: 'reticle' } : {}), text: a.text.replace(/ \(\w+\) reticle$/, ' reticle') }));
  const beats: Beat[] = [
    { title: 'Every layer is a picture', text: 'Each mask is a plate of quartz with a chrome pattern, printed onto the wafer by light. The first one, active area, decides where the transistors can be: everything else is etched into trenches and filled with oxide.', view: MK_HOME },
    { title: 'Printed by light', text: 'Ultraviolet passes the reticle only where there is no chrome. Here it reaches the resist on the poly everywhere but over the gate pattern; developed, the lit resist washes away, and the etch removes the poly it no longer covers.', view: { target: [0, z.res1 + 3, 0], yaw: -0.35, pitch: 0.35, dist: 70 }, show: ['gate', 'reticle', 'light'] },
    { title: 'The gate masks its own channel', text: 'The n+ window is a plain rectangle, wider than the diffusion. The ions land only where it meets bare active area: the gate and the trench oxide stop them. Cut along the NMOS row, the source and drain end exactly at the gate’s edges, wherever the gate is.', view: { target: [0, 0, cz], yaw: -0.2, pitch: 0.34, dist: 32 }, cut: 1, hide: ['reticle'] },
    { title: 'Wired', text: 'Contacts through the oxide, then metal 1 on top: the power rails along the edges and the cell’s own nodes between them. sky130 adds a local-interconnect layer and four more metals above this.', view: MK_HOME, cut: 0 },
  ];
  return { items, anchors, beats, look: { exposure: 0.95 }, cuts: { planes: [{ n: [0, 0, 1], d: cz }], open: [30] } };
}

/** Ions of one implant (step 6: n, step 7: p) falling through the window at time t (s), each stopping where the stack
 *  stops it: in the silicon where the window meets bare active area, on the gate, or on the trench oxide. */
export function ionInstances(c: Cell, st: MasksState, t: number, colour: RGB, n = 140): Instance[] {
  if (st.step !== 6 && st.step !== 7) return [];
  const k = st.step === 6 ? 'n' : 'p', w = windowOf(c, k)[0], imp = implanted(c, k, st.shift, st.aligned), poly = polyOf(c, st.shift), z = zs(st.spread);
  const inside = (rs: number[][], x: number, y: number) => rs.some((r) => x >= r[0] && x <= r[0] + r[2] && y >= r[1] && y <= r[1] + r[3]);
  const out: Instance[] = [], top = z.plate - 1, FALL = 1.6;
  for (let i = 0; i < n; i++) {
    // a fixed scatter per ion (golden ratio), a phase so they do not fall in step
    const u = (i * 0.618034) % 1, v = (i * 0.754877) % 1, x = w[0] + u * w[2], y = w[1] + v * w[3], ph = ((t / FALL) + (i * 0.381966) % 1) % 1;
    const stop = inside(imp, x, y) ? -0.25 : inside(poly, x, y) ? z.poly1 : 0;
    const h = Math.max(stop, top - ph * (top - stop + 1.5));
    if (h === stop && ph > 0.95) continue;
    const p = place(c, x, y, h);
    out.push({ pos: p, scale: [0.32, 0.32, 0.32], color: colour, emissive: colour });
  }
  return out;
}
export const ION_GEO = UNIT_BOX;
export const ION_MAT: Material = mk({ base: [1, 1, 1], metal: 0, rough: 0.4, label: 'implant ions (drawn; a real implant is a beam of millions)' });
