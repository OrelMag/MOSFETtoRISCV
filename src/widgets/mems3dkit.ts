// The Infineon IM69D130 digital MEMS microphone on the studio renderer (DOM-free; millimetres, y up, the sound port facing
// down). The physics is phys/memsmic.ts (the membrane's bow, the two capacitances, the chapter's loop and CIC); this file draws
// it. The package is the datasheet's drawing (p. 12); the MEMS die, its plates and the ASIC inside are typical, labelled so.
//
// The plate stack (a 0.5 µm membrane between two backplates 2 µm away) would be under a pixel at the package's scale, so it is
// drawn STACK_K times taller than life (one stated factor, held by a test); the membrane's swing is drawn SWING_K times larger
// again, and stays inside the drawn gap at every pressure the page allows (also tested). Sizes across are true.

import { lathe, merge, refresh, roundedBox, transform, tube, plane, type Geo } from '../gl/kit/geo';
import { M, type DataTex, type Material } from '../gl/kit/materials';
import type { Beat, Item, Model3, StudioAnchor } from '../gl/kit/scene';
import type { Mat4, Quat, Vec3 } from '../gl/math';
import { IM69, MAX_SPL, MEMBRANE, TYPICAL, deflection, splToPa, type Membrane } from '../phys/memsmic';

type Detail = 'full' | 'flat';
const tr = (p: Vec3): Mat4 => { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; m[12] = p[0]; m[13] = p[1]; m[14] = p[2]; return m; };

// ---------------------------------------------------------------- the package (IM69D130 datasheet, p. 12)

/** Body length (x), width (z), height; substrate thickness (mm). */
export const PKG = { l: 4, w: 3, h: 1.2, sub: 0.25 } as const;
/** The bottom port: through-hole diameter, its centre from the short edge; the ground ring's outer and inner diameters (mm). */
export const PORT = { d: 0.6, fromEdge: 1.32, ringOut: 2.0, ringIn: 1.2, plated: 0.85 } as const;
/** The port's centre in x (the package centred on the origin). */
export const PORT_X = -PKG.l / 2 + PORT.fromEdge;
/** The four signal pads: size (x × z), and their centres (x, z), 0.3 mm from the edges (DATA, VDD, CLOCK, SELECT). */
export const PAD = { lx: 0.4, lz: 0.7 } as const;
export const PADS: readonly { name: string; x: number; z: number }[] = [
  { name: '1 DATA', x: PKG.l / 2 - 0.5, z: -(0.425 + 0.35) },
  { name: '2 VDD', x: PKG.l / 2 - 1.2, z: -(0.425 + 0.35) },
  { name: '3 CLOCK', x: PKG.l / 2 - 0.5, z: 0.425 + 0.35 },
  { name: '4 SELECT', x: PKG.l / 2 - 1.2, z: 0.425 + 0.35 },
];
/** The lid's wall (drawn). */
const LID_T = 0.08;

// ---------------------------------------------------------------- inside (typical)

/** The MEMS die: a square frame round its back cavity, over the port (typical size: Infineon's chips are 1.0–1.4 mm a side). */
export const DIE = { side: 1.4, h: 0.4, cavity: 1.06 } as const;
/** The ASIC beside it (illustrative). */
export const ASIC = { lx: 1.1, h: 0.2, lz: 1.0, x: 0.95 } as const;
/** The plate stack, real thicknesses (m): backplate, gap, membrane (gap and membrane from phys/memsmic.ts TYPICAL). */
export const STACK = { backplate: 1e-6, gap: TYPICAL.gap, membrane: TYPICAL.h } as const;
/** The stack is drawn this many times taller than life, so its layers can be seen (one factor for the whole stack). */
export const STACK_K = 20;
/** And the membrane's swing this many times more again (on top of STACK_K). */
export const SWING_K = 4;
/** Metres of the stack to drawn millimetres. */
const mmOf = (m: number) => m * 1e3 * STACK_K;
export const STACK_Y0 = PKG.sub + DIE.h;
/** The drawn heights (mm) of the stack's layers: bottom backplate, membrane (at rest), top backplate. */
export const LAYERS = (() => {
  const b = mmOf(STACK.backplate), g = mmOf(STACK.gap), t = mmOf(STACK.membrane);
  const bp2 = [STACK_Y0, STACK_Y0 + b], mem = [bp2[1] + g, bp2[1] + g + t], bp1 = [mem[1] + g, mem[1] + g + b];
  return { bp2, mem, bp1, top: bp1[1] };
})();
const R_MEM = MEMBRANE.a * 1e3, R_BP = R_MEM + 0.04;

/** The drawn membrane's lift (mm) at radius r (mm), pressure p (Pa): the real bow times STACK_K and SWING_K. */
export const drawnLift = (p: number, rMm: number, m: Membrane = MEMBRANE): number => deflection(m, p, rMm / 1e3) * 1e3 * STACK_K * SWING_K;
/** The largest drawn lift at the loudest the page allows, as a share of the drawn gap (must stay under 1). */
export const worstSwing = (): number => drawnLift(splToPa(MAX_SPL) * Math.SQRT2, 0) / mmOf(STACK.gap);

const RN = 32;
/** The membrane as a thin lathed disc bowed by pressure p: the same point count at any p, so the drawn one is bent in place. */
export function membraneGeo(p: number, d: Detail): Geo {
  const n = d === 'flat' ? 10 : RN, t = LAYERS.mem[1] - LAYERS.mem[0], y0 = LAYERS.mem[0];
  const lo: [number, number][] = Array.from({ length: n + 1 }, (_, i) => { const r = (i / n) * R_MEM; return [r, y0 + drawnLift(p, r)]; });
  const hi = lo.map(([r, y]): [number, number] => [r, y + t]).reverse();
  return lathe([...lo, [R_MEM + 0.02, y0], [R_MEM + 0.02, y0 + t], ...hi], { seg: d === 'flat' ? 16 : 64, crease: 60 });
}
const mems = new Map<Detail, Geo>();
export function membraneOf(d: Detail, p: number): Geo { let g = mems.get(d); if (!g) { g = membraneGeo(p, d); mems.set(d, g); } return g; }
export const drawnMembrane = (d: Detail): Geo | undefined => mems.get(d);
export const bendMembrane = (p: number): void => { for (const d of ['full', 'flat'] as const) { const g = mems.get(d); if (g) refresh(g, membraneGeo(p, d)); } };

// ---------------------------------------------------------------- geometry

interface Statics { sub: Geo; lid: Geo; die: Geo; bp: Geo; holes: Geo; asic: Geo; wires: Geo; pads: Geo; ring: Geo; port: Geo; anchor: Geo; bits: Geo }
const memo = new Map<Detail, Statics>();
/** A box centred on z = 0 as two halves split there: the flat view drops a triangle by its centre, so no face may straddle the cut. */
const zBox = (w: number, h: number, d: number, r: number, seg: number, p: [number, number]): Geo =>
  merge([-1, 1].map((k) => transform(roundedBox(w, h, d / 2, r, seg), tr([p[0], p[1], (k * d) / 4]))), 'box');
const ring = (r0: number, r1: number, y0: number, y1: number, seg: number) => lathe([[r0, y0], [r1, y0], [r1, y1], [r0, y1], [r0, y0]], { seg });
function statics(d: Detail): Statics {
  const hit = memo.get(d);
  if (hit) return hit;
  const seg = d === 'flat' ? 16 : 64, X0 = -PKG.l / 2, Z0 = -PKG.w / 2;
  // the substrate: a laminate with the port through it (four boxes round a square hole the port's size, then the round wall)
  const P = PORT.d / 2, sub = merge([
    zBox(PORT_X - P - X0, PKG.sub, PKG.w, 0.02, 1, [(X0 + PORT_X - P) / 2, PKG.sub / 2]),
    zBox(PKG.l / 2 - PORT_X - P, PKG.sub, PKG.w, 0.02, 1, [(PORT_X + P + PKG.l / 2) / 2, PKG.sub / 2]),
    transform(roundedBox(2 * P, PKG.sub, PKG.w / 2 - P, 0.02, 1), tr([PORT_X, PKG.sub / 2, (-PKG.w / 2 - P) / 2])),
    transform(roundedBox(2 * P, PKG.sub, PKG.w / 2 - P, 0.02, 1), tr([PORT_X, PKG.sub / 2, (PKG.w / 2 + P) / 2])),
  ], 'substrate');
  const port = transform(ring(P, P + 0.03, 0.001, PKG.sub - 0.001, seg), tr([PORT_X, 0, 0]));
  // the lid: a drawn metal can, top and four walls (corners rounded a little)
  const lh = PKG.h - PKG.sub, lid = merge([
    zBox(PKG.l, LID_T, PKG.w, 0.03, 2, [0, PKG.h - LID_T / 2]),
    zBox(LID_T, lh, PKG.w, 0.02, 1, [X0 + LID_T / 2, PKG.sub + lh / 2]),
    zBox(LID_T, lh, PKG.w, 0.02, 1, [-X0 - LID_T / 2, PKG.sub + lh / 2]),
    transform(roundedBox(PKG.l - 2 * LID_T, lh, LID_T, 0.02, 1), tr([0, PKG.sub + lh / 2, Z0 + LID_T / 2])),
    transform(roundedBox(PKG.l - 2 * LID_T, lh, LID_T, 0.02, 1), tr([0, PKG.sub + lh / 2, -Z0 - LID_T / 2])),
  ], 'lid');
  // the MEMS die: a square frame round the back cavity, centred over the port
  const s = DIE.side, c = DIE.cavity, f = (s - c) / 2, dy = PKG.sub + DIE.h / 2;
  const die = merge([
    zBox(f, DIE.h, s, 0.01, 1, [PORT_X - (c + f) / 2, dy]),
    zBox(f, DIE.h, s, 0.01, 1, [PORT_X + (c + f) / 2, dy]),
    transform(roundedBox(c, DIE.h, f, 0.01, 1), tr([PORT_X, dy, -(c + f) / 2])),
    transform(roundedBox(c, DIE.h, f, 0.01, 1), tr([PORT_X, dy, (c + f) / 2])),
  ], 'die');
  // the backplates: discs a little wider than the membrane, on posts at their rim (the anchor ring)
  const bp = merge([LAYERS.bp2, LAYERS.bp1].map(([a, b]) => transform(lathe([[0, a], [R_BP, a], [R_BP, b], [0, b]], { seg }), tr([PORT_X, 0, 0]))), 'backplates');
  const anchor = transform(ring(R_BP, R_BP + 0.06, STACK_Y0, LAYERS.top, seg), tr([PORT_X, 0, 0]));
  // the perforations: dark dots on both backplates' faces, on a hexagonal grid (drawn; the real holes are a few µm across)
  const pitch = d === 'flat' ? 0.16 : 0.09, dots: Geo[] = [], dot = lathe([[0, 0], [0.022, 0], [0.022, 0.003], [0, 0.003]], { seg: 8 });
  for (let j = -12; j <= 12; j++) for (let i = -12; i <= 12; i++) {
    const x = (i + (j % 2) * 0.5) * pitch, z = j * pitch * 0.866;
    if (Math.hypot(x, z) > R_BP - 0.06) continue;
    dots.push(transform(dot, tr([PORT_X + x, LAYERS.bp1[1], z])), transform(dot, tr([PORT_X + x, LAYERS.bp2[0] - 0.003, z])));
  }
  const holes = merge(dots, 'perforations');
  const asic = zBox(ASIC.lx, ASIC.h, ASIC.lz, 0.02, 1, [ASIC.x, PKG.sub + ASIC.h / 2]);
  // bond wires (drawn): two from the die's pads to the ASIC, four from the ASIC down to the substrate's fingers
  const top = PKG.sub + DIE.h, aTop = PKG.sub + ASIC.h, arc = (a: Vec3, b: Vec3, hgt: number): Vec3[] =>
    Array.from({ length: 9 }, (_, k) => { const t = k / 8; return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t + hgt * Math.sin(Math.PI * t), a[2] + (b[2] - a[2]) * t]; });
  const wr = 0.0125, ws = d === 'flat' ? 4 : 6, dx = PORT_X + s / 2 - 0.08;
  const wires = merge([
    ...[-0.25, 0.25].map((z) => tube(arc([dx, top, z], [ASIC.x - ASIC.lx / 2 + 0.08, aTop, z * 0.8], 0.12), wr, { sides: ws })),
    ...[-0.36, -0.12, 0.12, 0.36].map((z) => tube(arc([ASIC.x + ASIC.lx / 2 - 0.08, aTop, z], [ASIC.x + ASIC.lx / 2 + 0.22, PKG.sub, z * 1.4], 0.1), wr, { sides: ws })),
  ], 'wires');
  // the solder pads under the package (gold), and the ground ring round the port
  const pads = merge(PADS.map((q) => transform(roundedBox(PAD.lx, 0.02, PAD.lz, 0.005, 1), tr([q.x, -0.01, q.z]))), 'pads');
  const gring = transform(merge([ring(PORT.ringIn / 2, PORT.ringOut / 2, -0.02, 0, seg), ring(P, PORT.plated / 2, -0.02, 0, seg)]), tr([PORT_X, 0, 0]));
  // the strip on the ASIC's top that shows the last bits it sent (a data texture)
  const bits = plane(ASIC.lx * 0.8, ASIC.lz * 0.22);
  const st: Statics = { sub, lid, die, bp, holes, asic, wires, pads, ring: gring, port, anchor, bits };
  memo.set(d, st);
  return st;
}

// ---------------------------------------------------------------- materials

const SHEET = 'Infineon IM69D130 datasheet v1.0 (2017)';
const TYP = 'typical (no teardown of this part found)';
const glowMemo = new Map<number, Material>();
export const MATS = {
  substrate: M.make({ base: [0.12, 0.22, 0.13], metal: 0, rough: 0.55, label: 'laminate substrate (green solder mask, drawn)' }),
  lid: M.make({ base: [0.78, 0.7, 0.45], metal: 0.9, rough: 0.28, label: 'metal lid, gold-coloured (as Infineon\'s photograph)' }),
  silicon: M.silicon,
  poly: M.make({ base: [0.55, 0.5, 0.62], metal: 0.4, rough: 0.35, label: 'polysilicon (typical)' }),
  backplate: M.make({ base: [0.42, 0.46, 0.52], metal: 0.35, rough: 0.45, label: 'perforated backplate, polysilicon and nitride (typical)' }),
  hole: M.make({ base: [0.02, 0.02, 0.025], metal: 0, rough: 1, label: 'perforations (drawn)' }),
  asic: M.make({ base: [0.16, 0.17, 0.2], metal: 0.2, rough: 0.4, label: 'CMOS ASIC die (illustrative size)' }),
  gold: M.gold,
  wire: M.make({ base: [0.95, 0.8, 0.45], metal: 1, rough: 0.25, label: 'gold bond wire (drawn)' }),
  /** The air in the port and the back cavity, tinted by the pressure: amber above ambient, blue below. */
  air: (p: number): Material => {
    const q = Math.round(Math.max(-1, Math.min(1, p)) * 6) / 6, hit = glowMemo.get(q);
    if (hit) return hit;
    const c: [number, number, number] = q >= 0 ? [1, 0.6, 0.2] : [0.25, 0.55, 1];
    const m = M.make({ base: c, metal: 0, rough: 0.5, transmit: 0.75, tint: c, emit: c, glow: 0.15 + 0.6 * Math.abs(q), label: 'the air in the port: amber above ambient pressure, blue below' });
    glowMemo.set(q, m);
    return m;
  },
  bits: (t: DataTex): Material => M.make({ base: [0.02, 0.02, 0.02], metal: 0, rough: 1, data: t, label: 'the last bits on DATA, one a clock (lit = 1)' }),
};

// ---------------------------------------------------------------- the bits strip

export const BITS_W = 64;
export const newBitsTex = (): DataTex => ({ w: BITS_W, h: 1, pixels: new Uint8Array(BITS_W * 4), rev: 0, mode: 'emit' });
/** The strip: the newest bit at the right; a 1 lit warm, a 0 dark. */
export function paintBits(t: DataTex, bits: readonly number[]): void {
  for (let i = 0; i < BITS_W; i++) {
    const b = bits[bits.length - BITS_W + i] ?? 0, o = i * 4;
    t.pixels[o] = b ? 120 : 6; t.pixels[o + 1] = b ? 105 : 8; t.pixels[o + 2] = b ? 60 : 12; t.pixels[o + 3] = 255;
  }
  t.rev++;
}

// ---------------------------------------------------------------- the model

export interface MicState { p: number; bits: DataTex; spl: number }
const FACE_UP: Quat = [0, 0, 0, 1];

export function micModel(s: MicState, detail: Detail = 'full'): Model3 {
  const S = statics(detail), memb = membraneOf(detail, s.p), stackDim = `${STACK_K}× taller than life`;
  const pn = s.p / (splToPa(MAX_SPL) * Math.SQRT2);
  const cav = transform(lathe([[0, -0.05], [PORT.d / 2 - 0.005, -0.05], [PORT.d / 2 - 0.005, PKG.sub], [DIE.cavity / 2 - 0.01, PKG.sub + 0.01], [DIE.cavity / 2 - 0.01, LAYERS.bp2[0] - 0.005], [0, LAYERS.bp2[0] - 0.005]], { seg: detail === 'flat' ? 12 : 40 }), tr([PORT_X, 0, 0]));
  const items: Item[] = [
    { geo: S.sub, mat: MATS.substrate, name: 'substrate', group: 'base', info: { dim: `${PKG.l} × ${PKG.w} mm, ${PKG.sub} mm thick`, source: `${SHEET}, p. 12` } },
    { geo: S.port, mat: MATS.gold, name: 'sound port', group: 'base', info: { dim: `Ø ${PORT.d} mm through, its centre ${PORT.fromEdge} mm from the end`, source: `${SHEET}, p. 12`, note: 'the sound comes in from below, through a hole in the circuit board under the microphone' } },
    { geo: S.pads, mat: MATS.gold, name: 'solder pads', group: 'base', info: { dim: `${PAD.lx} × ${PAD.lz} mm`, source: `${SHEET}, p. 12`, note: '1 DATA, 2 VDD, 3 CLOCK, 4 SELECT (left or right channel); 5 GND is the ring round the port' } },
    { geo: S.ring, mat: MATS.gold, name: 'solder pads', group: 'base' },
    { geo: cav, mat: MATS.air(pn), name: 'air in the port', group: 'air', cut: 'section', shadow: false, info: { note: `${s.spl.toFixed(0)} dB SPL: ${(splToPa(s.spl)).toFixed(2)} Pa RMS; the pressure under the membrane, drawn as a tint` } },
    { geo: S.die, mat: MATS.silicon, name: 'MEMS die', group: 'die', explode: [0, 1.2, 0], info: { dim: `${DIE.side} mm square, ${DIE.h} mm thick, its back cavity ${DIE.cavity} mm across: ${TYP}`, source: 'Infineon\'s MEMS chips are 1.0–1.4 mm a side (Dehé et al., SENSOR 2013)', note: 'etched through from below: the cavity under the membrane opens onto the port' } },
    { geo: S.bp, mat: MATS.backplate, name: 'backplate', group: 'stack', explode: [0, 2.1, 0], info: { dim: `Ø ${(2 * R_BP).toFixed(2)} mm, ${STACK.backplate * 1e6} µm thick (typical), drawn ${stackDim}`, source: `${SHEET}: "Dual Backplate"`, note: 'stiff and full of holes: the air passes, the plate stays put. Each one is a capacitor with the membrane' } },
    { geo: S.holes, mat: MATS.hole, name: 'backplate', group: 'stack', explode: [0, 2.1, 0], cut: 'none', shadow: false },
    { geo: S.anchor, mat: MATS.poly, name: 'backplate', group: 'stack', explode: [0, 2.1, 0] },
    { geo: memb, mat: MATS.poly, at: [PORT_X, 0, 0], name: 'membrane', group: 'membrane', explode: [0, 2.1, 0], info: {
      dim: `Ø ${(2 * R_MEM).toFixed(1)} mm, ${STACK.membrane * 1e6} µm polysilicon, ${STACK.gap * 1e6} µm from each backplate (typical); drawn ${stackDim}, its swing ${SWING_K}× more`,
      source: `σ = ${(MEMBRANE.sigma / 1e6).toFixed(1)} MPa, a fit: chosen so the stack gives −38 dBV/Pa (Infineon's 2013 analog chips, not this part)`,
      note: `at ${s.spl.toFixed(0)} dB SPL its middle moves ${fmtM(deflection(MEMBRANE, splToPa(s.spl) * Math.SQRT2, 0))} at the peak, ${(deflection(MEMBRANE, splToPa(s.spl) * Math.SQRT2, 0) / STACK.gap * 100).toPrecision(2)} % of the gap` } },
    { geo: S.asic, mat: MATS.asic, name: 'ASIC', group: 'asic', explode: [0, 1.0, 0], info: { dim: `${ASIC.lx} × ${ASIC.lz} mm (illustrative)`, source: `${SHEET}: preamplifier, sigma-delta ADC, 1-bit PDM interface, bias charge pump`, note: `here the converters chapter's own order-2 loop and CIC stand in for it (the real loop order is not published); clock ${IM69.clock / 1e6} MHz` } },
    { geo: S.bits, mat: MATS.bits(s.bits), at: [ASIC.x, PKG.sub + ASIC.h + 0.002, 0], rot: FACE_UP, name: 'ASIC', group: 'asic', explode: [0, 1.0, 0], cut: 'none', shadow: false },
    { geo: S.wires, mat: MATS.wire, name: 'bond wires', group: 'asic', explode: [0, 1.0, 0], shadow: false, info: { dim: '25 µm (drawn)', note: 'the membrane and backplates to the ASIC, the ASIC to the substrate' } },
    { geo: S.lid, mat: MATS.lid, name: 'lid', group: 'lid', explode: [0, 3.6, 0], info: { dim: `${PKG.l} × ${PKG.w} × ${PKG.h} mm overall`, source: `${SHEET}, p. 12`, note: 'a metal can soldered to the substrate: the back volume behind the membrane, and a shield' } },
  ];
  const front: Vec3 = [0, 0, 1], up: Vec3 = [0, 1, 0];
  const anchors: StudioAnchor[] = [
    { text: 'lid', p: [1.4, PKG.h, 0.9], side: 'r', n: up, on: 'lid' },
    { text: 'membrane', p: [PORT_X - 0.25, LAYERS.mem[1], 0], side: 'l', n: front, on: 'membrane' },
    { text: 'backplates', p: [PORT_X + 0.38, LAYERS.bp1[1], 0], side: 'l', n: front, on: 'stack' },
    { text: 'MEMS die', p: [PORT_X - DIE.side / 2, PKG.sub + DIE.h * 0.4, 0], side: 'l', n: front, on: 'die' },
    { text: 'sound port', p: [PORT_X, PKG.sub * 0.5, 0], side: 'l', n: front, on: 'base' },
    { text: 'ASIC', p: [ASIC.x + 0.3, PKG.sub + ASIC.h, 0], side: 'r', n: up, on: 'asic' },
    { text: 'substrate', p: [1.6, PKG.sub * 0.6, 0], side: 'r', n: front, on: 'base' },
    ...PADS.map((q): StudioAnchor => ({ text: q.name, p: [q.x, -0.02, q.z], side: 'b', n: [0, -1, 0], under: true })),
  ];
  return { items, anchors, beats: beats(), cuts: { planes: [{ n: [0, 0, 1], d: 0 }], open: [PKG.w] }, floor: -0.05, look: { exposure: 1.15, keyDir: [-0.4, 0.8, 0.5] } };
}
const fmtM = (m: number) => (m >= 1e-6 ? `${(m * 1e6).toFixed(2)} µm` : `${(m * 1e9).toFixed(m < 1e-8 ? 2 : 1)} nm`);

export const MIC_HOME = { yaw: 0.45, pitch: 0.42, target: [0, 0.6, 0] as Vec3, dist: 12 };

function beats(): Beat[] {
  const close = { yaw: 0.05, pitch: 0.1, target: [PORT_X, LAYERS.mem[0] - 0.05, 0] as Vec3, dist: 1.9 };
  return [
    { title: 'Life size', text: `${PKG.l} × ${PKG.w} × ${PKG.h} mm: the IM69D130, a microphone with a converter inside. A phone carries two to four of these. Sound comes in from below, through a ${PORT.d} mm hole in the board.`, view: MIC_HOME, cut: 0, explode: 0 },
    { title: 'Cut away', text: 'Under the lid: on the left the MEMS die over the port, on the right the ASIC, wired together with gold. The lid closes the space behind the membrane.', view: { yaw: 0.1, pitch: 0.2, target: [0, 0.55, 0], dist: 7.5 }, cut: 1, explode: 0 },
    { title: 'Three plates', text: `A membrane between two perforated backplates, ${STACK.gap * 1e6} µm from each (typical): two capacitors sharing the middle plate. Drawn ${STACK_K} times taller than life; across, the sizes are true.`, view: close, show: ['stack', 'membrane', 'die'], cut: 1, explode: 0 },
    { title: 'Sound arrives', text: `Pressure through the port bows the membrane towards the top plate: one capacitance rises as the other falls, so the difference is twice either change, and the even-order errors cancel. At 94 dB SPL the middle moves ${fmtM(deflection(MEMBRANE, Math.SQRT2, 0))} at the peak; the swing is drawn ${SWING_K} × ${STACK_K} times larger.`, view: close, show: ['membrane', 'stack', 'air'], cut: 1, explode: 0 },
    { title: 'The loop on the ASIC', text: `The ASIC turns the membrane's voltage into one bit per clock, ${IM69.clock / 1e6} MHz, the converters chapter's sigma-delta loop: more 1s while the pressure is up (the datasheet's polarity). The strip on the ASIC is the last ${BITS_W} bits.`, view: { yaw: 0.25, pitch: 0.55, target: [ASIC.x, 0.4, 0], dist: 4.2 }, show: ['asic'], cut: 1, explode: 0 },
    { title: 'How it is built', text: 'Pulled apart: lid, ASIC with its wires, the plate stack, the die, the substrate with its port and pads.', view: { yaw: 0.45, pitch: 0.22, target: [0, 2.3, 0], dist: 15 }, cut: 0, explode: 1 },
    { title: 'Underneath', text: 'Five pads: DATA, VDD, CLOCK, SELECT and the ground ring round the port. SELECT picks which clock edge the part answers on, so two microphones share one DATA wire: stereo on one pin.', view: { yaw: 0, pitch: -1.1, target: [0, 0, 0], dist: 9 }, cut: 0, explode: 0 },
  ];
}
