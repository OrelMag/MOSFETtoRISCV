// The triode close-up's body (loaded on demand by widgets/triode3d.ts): a 6SN7 twin triode drawn in 3D at its real
// size from boxes, cylinders, rings and spheres, the near section's plate cut away. The cathode's glow, the electrons
// and every number come from the lumped model (phys/triode.ts) at the chosen grid voltage and heater time; beside it
// the transfer curve, the warm-up and the model's summary. Without WebGL2 (or after a lost context) the same parts
// are drawn as a flat front view in SVG.

import '../styles/relay3d.css';
import '../styles/tube3d.css';
import { CssColors, mixRgb, scaleRgb, watchTheme } from '../gl/color';
import { packInstances, type Instance, type RGB, type RGBA } from '../gl/instances';
import { dot3, sub3, type Vec3 } from '../gl/math';
import type { Renderer } from '../gl/renderer';
import { B_PLUS, HEATER_W, R_PLATE, V_CUTOFF, V_HIGH, V_LOW, plateCurrent, plateVoltage, triodeAt, warmup, type WarmSample } from '../phys/triode';
import { h, s } from '../ui/dom';
import { reducedMotion } from '../ui/motion';
import type { Widget } from '../view/stage';
import { declutterLabels } from './labelfit';
import { ORBIT_ARIA, ORBIT_HINT, modelFrame } from './modelframe';

// ---------------------------------------------------------------- geometry (mm; x right, y up, z towards the viewer)
// A 6SN7GT: T-9 bulb (28.6 mm), 70 mm seated height, octal base (pins on a 17.45 mm circle). The two sections stand
// side by side; each is a cathode sleeve inside an oval grid helix inside a box-shaped plate.

const XA = -6.6, XB = 6.6; // the near (cut away) and far sections' axes
const Y0 = 30, Y1 = 52; // plate ends
const CX = 1.1, CZ = 0.65; // cathode sleeve half-widths (an oval sleeve)
const GX = 2.2, GZ = 1.35; // grid turns' half-widths; the side rods stand at ±GX
const PX = 5, PZ = 3, PT = 0.25; // plate: inside half-widths, sheet thickness
const EAR = 1.3; // the plate's crimped flanges
const PITCH = 0.6, WIRE = 0.14; // grid turns
const CUT_Y = 45; // the near cathode sleeve is cut off here, so the heater shows above it
const EMIT0 = 30.6, EMIT1 = CUT_Y - 0.4; // where electrons leave the near sleeve
const MICA_LO = 29.6, MICA_HI = 52.4;
const GLASS_R = 14.3, GLASS_Y0 = 12, GLASS_Y1 = 62, DOME_H = 8;
const BASE_R = 14.8, BASE_H = 13;
const PIN_C = 17.5 / 2, PIN_D = 2.36, PIN_L = 9.2, KEY_D = 7.9, KEY_L = 12.5;
/** The heater runs this much hotter than the sleeve it heats (its colour only; nothing shown is computed from it). */
const HEATER_LEAD = 150;

/** The full current: grid at 0 V, cathode hot. The electrons drawn are scaled to it. */
export const I_FULL = plateCurrent(0, V_LOW);
/** The datasheet's plate rating (Tung-Sol 6SN7GTB: 2.5 W per plate; 450 V; 20 mA of cathode current per section). */
export const PLATE_RATING_W = 2.5;
/** The most positive grid the slider reaches: above it a real grid collects electrons, which the model has no term for. */
export const GRID_MAX = 0;
/** The octal pin roles seen on the datasheet (pin 1..8): grid 2, plate 2, cathode 2, grid 1, plate 1, cathode 1, heater, heater. */
export const PIN_ROLES = ['g2', 'p2', 'k2', 'g1', 'p1', 'k1', 'h', 'h'] as const;
type Role = 'g' | 'p' | 'k' | 'h';
const roleOf = (k: number): Role => PIN_ROLES[k - 1][0] as Role;
/** A pin's place on the base circle (mm), seen from above: pin 1 sits 22.5 degrees clockwise (from below) of the key. */
export const pinPos = (k: number): [number, number] => { const a = Math.PI + ((k - 0.5) * Math.PI) / 4; return [PIN_C * Math.sin(a), PIN_C * Math.cos(a)]; };

export interface TubeState { vg: number; th: number; Tc: number; sat: number; vp: number; ip: number }
export const stateAt = (vg: number, th: number): TubeState => ({ vg, th, ...triodeAt(vg, th) });

/** What is drawn. e: the emission as a fraction of the full stream, capped at 1 (the cathode could give 140 times the
 *  plate current; the cloud round it is drawn at one density). flow: the plate current as a fraction of the full
 *  current, which sets the electrons that cross the grid. Of every electron the cathode emits, 1 - ip / sat fall back
 *  into the space-charge cloud: above 99 % of them at the full current. */
export function stream(st: TubeState): { e: number; flow: number } {
  const e = Math.min(1, st.sat / I_FULL);
  return e < 1e-3 ? { e: 0, flow: 0 } : { e, flow: Math.min(1, st.ip / I_FULL) };
}
/** The share of the emission that falls back to the cathode (0..1). */
export const returned = (st: TubeState) => (st.sat > 0 ? Math.max(0, 1 - st.ip / st.sat) : 0);

type Kind = 'box' | 'cyl' | 'sph' | 'tor' | 'wall' | 'dome';
interface Part extends Instance { kind: Kind; glass?: boolean }

export interface Palette {
  bakelite: RGB; pin: RGB; plate: RGB; nickel: RGB; oxide: RGB; red: RGB; orange: RGB; heater: RGB; grid: RGB;
  rod: RGB; mica: RGBA; glass: RGBA; press: RGBA; getter: RGBA; getterCup: RGB; electron: RGB; role: Record<Role, RGB>;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const box = (c: RGB | RGBA, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, spec = 0): Part =>
  ({ kind: 'box', pos: [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2], scale: [x1 - x0, y1 - y0, z1 - z0], color: c, spec });
/** A cylinder along y, w wide in x and d deep in z (an oval when they differ). */
const cyl = (c: RGB | RGBA, x: number, z: number, y0: number, y1: number, w: number, d = w, spec = 0): Part =>
  ({ kind: 'cyl', pos: [x, (y0 + y1) / 2, z], scale: [w, y1 - y0, d], color: c, spec });

/** Glow of a part at temperature T (K): nothing below ~650 K, dull red at 800 K, orange by 1000 K. */
function glowOf(T: number, P: Palette): { k: number; col: RGB } {
  return { k: clamp01((T - 650) / 400), col: mixRgb(P.red, P.orange, clamp01((T - 800) / 200)) };
}

/** Every part of the tube with the model at st. */
export function tubeParts(st: TubeState, P: Palette, opts: { charge: boolean } = { charge: true }): Part[] {
  const out: Part[] = [];
  // Octal base: bakelite shell, the keyed spigot, eight pins on their circle (the key between pins 8 and 1).
  out.push(cyl(P.bakelite, 0, 0, 0, BASE_H, 2 * BASE_R, 2 * BASE_R, 0.15), cyl(P.bakelite, 0, 0, BASE_H - 1.2, BASE_H, 2 * BASE_R + 0.6, 2 * BASE_R + 0.6, 0.15));
  out.push(cyl(P.bakelite, 0, 0, -KEY_L, 0, KEY_D, KEY_D, 0.1), box(P.bakelite, -0.8, 0.8, -KEY_L, 0, -KEY_D / 2 - 1, -KEY_D / 2 + 0.6, 0.1));
  for (let k = 1; k <= 8; k++) {
    const a = Math.PI + ((k - 0.5) * Math.PI) / 4, x = PIN_C * Math.sin(a), z = PIN_C * Math.cos(a);
    const pc = mixRgb(P.pin, P.role[roleOf(k)], 0.55);
    out.push(cyl(pc, x, z, -PIN_L, 0, PIN_D, PIN_D, 0.5), { kind: 'sph', pos: [x, -PIN_L, z], scale: [PIN_D, 1.6, PIN_D], color: pc, spec: 0.5 });
    // The stem lead from the pin up through the base to the press, a thin wire in the glass above the base.
    out.push(cyl(P.nickel, x, z, BASE_H, 21, 0.55, 0.55, 0.3));
  }
  // The glass press the leads come through: a flat disc where the stem is sealed, and the narrower pinch above it.
  out.push({ ...cyl(P.press, 0, 0, GLASS_Y0, GLASS_Y0 + 2, 2 * BASE_R - 4, 2 * BASE_R - 4, 0.3), glass: true });
  out.push({ ...box(P.press, -7, 7, GLASS_Y0 + 2, 22, -1.8, 1.8), glass: true });
  const g = glowOf(st.Tc, P), gh = glowOf(st.Tc + HEATER_LEAD, P);
  const pw = st.vp * st.ip; // plate dissipation: the plate warms, faintly
  const sheath = opts.charge ? stream(st).e * returned(st) : 0; // the space-charge cloud round the near sleeve
  const plate = { color: P.plate, emissive: scaleRgb(P.red, 0.07 * clamp01(pw / 0.7)), spec: 0.12 };
  for (const [xs, cut] of [[XA, true], [XB, false]] as const) {
    // Plate: back wall, side walls, flanges (the two halves crimped together), the rods it hangs on. The near
    // section's front wall and the front halves of its side walls are cut away.
    const zf = cut ? 0 : PZ;
    out.push({ ...box(P.plate, xs - PX - PT, xs + PX + PT, Y0, Y1, -PZ - PT, -PZ), ...plate });
    // two stiffening ribs pressed into the back wall
    for (const sd of [-1, 1]) out.push({ ...box(P.plate, xs + sd * 2.6 - 0.2, xs + sd * 2.6 + 0.2, Y0 + 0.4, Y1 - 0.4, -PZ, -PZ + 0.3), ...plate });
    if (!cut) out.push({ ...box(P.plate, xs - PX - PT, xs + PX + PT, Y0, Y1, PZ, PZ + PT), ...plate });
    for (const sd of [-1, 1]) {
      const xw = xs + sd * (PX + PT / 2), xe = xs + sd * (PX + PT + EAR / 2);
      out.push({ ...box(P.plate, xw - PT / 2, xw + PT / 2, Y0, Y1, -PZ, zf), ...plate });
      out.push({ ...box(P.plate, xe - EAR / 2, xe + EAR / 2, Y0, Y1, -0.25, 0.25), ...plate });
      out.push(cyl(P.nickel, xs + sd * (PX + PT + 0.6), 0, 22, 55, 0.7, 0.7, 0.3));
      // grid side rods
      out.push(cyl(P.rod, xs + sd * GX, 0, 24, 54.2, 0.5, 0.5, 0.35));
    }
    // Grid: the helix as turns of fine wire round the side rods.
    for (let y = Y0 + 0.3; y < Y1; y += PITCH) out.push({ kind: 'tor', pos: [xs, y, 0], scale: [2 * GX, WIRE, 2 * GZ], color: P.grid, spec: 0.4 });
    // Cathode: an oxide-coated nickel sleeve, glowing with its temperature; its lead.
    const top = cut ? CUT_Y : 54;
    out.push({ ...cyl(mixRgb(P.oxide, g.col, Math.min(1, g.k * 1.2)), xs, 0, 27.5, top, 2 * CX, 2 * CZ, 0.1), emissive: scaleRgb(g.col, 0.9 * g.k ** 1.5) });
    out.push(cyl(P.nickel, xs + 0.8, 0.5, 22, 27.6, 0.3, 0.3, 0.3));
    // Heater: a coated hairpin inside the sleeve; its legs come out below to their leads.
    const hc = mixRgb(P.heater, gh.col, gh.k), he = scaleRgb(gh.col, gh.k ** 1.3);
    for (const sd of [-1, 1]) out.push({ ...cyl(hc, xs + sd * 0.4, 0, 22, 51.8, 0.36, 0.36, 0.1), emissive: he });
    // The heater is a tungsten wire coated with white alumina, folded into a coil: drawn as turns round the legs where
    // the cut sleeve shows them.
    if (cut) for (let y = CUT_Y + 0.5; y < 51.6; y += 0.8) for (const sd of [-1, 1]) out.push({ kind: 'tor', pos: [xs + sd * 0.4, y, 0], scale: [0.95, 0.22, 0.95], color: hc, emissive: he, spec: 0.1 });
    // the sleeve's cut edge
    if (cut) out.push({ kind: 'tor', pos: [xs, CUT_Y, 0], scale: [2 * CX + 0.05, 0.18, 2 * CZ + 0.05], color: P.nickel, spec: 0.3 });
    out.push({ ...box(hc, xs - 0.58, xs + 0.58, 51.6, 52, -0.18, 0.18, 0.1), emissive: he });
    // The glow round the visible sleeve.
    if (cut && sheath > 0.01) {
      out.push({ ...cyl([...P.electron, 0.22 * sheath] as RGBA, xs, 0, EMIT0, EMIT1, 2 * CX + 0.7, 2 * CZ + 0.7), emissive: scaleRgb(P.electron, 0.25 * sheath), glass: true });
    }
    if (cut && g.k > 0.02) {
      out.push({ ...cyl([...g.col, 0.16 * g.k] as RGBA, xs, 0, EMIT0, EMIT1, 2 * CX * 1.5, 2 * CZ * 1.6), emissive: scaleRgb(g.col, 0.4 * g.k), glass: true });
    }
  }
  // Micas hold every electrode at both ends; the getter cup on its wire above.
  out.push({ ...cyl(P.mica, 0, 0, MICA_LO - 0.15, MICA_LO + 0.15, 27, 14), glass: true }, { ...cyl(P.mica, 0, 0, MICA_HI - 0.15, MICA_HI + 0.15, 27, 14), glass: true });
  out.push(cyl(P.nickel, 0, 0, MICA_HI, 58, 0.5, 0.5, 0.3), cyl(P.getterCup, 0, 0, 58, 59.2, 5.5, 3, 0.5));
  // Glass: the getter's mirror on the dome first (it is inside), then the envelope.
  out.push({ kind: 'dome', pos: [0, GLASS_Y1, 0], scale: [2 * GLASS_R - 0.5, 2 * DOME_H - 0.5, 2 * GLASS_R - 0.5], color: P.getter, glass: true });
  out.push({ kind: 'wall', pos: [0, (GLASS_Y0 + GLASS_Y1) / 2, 0], scale: [2 * GLASS_R, GLASS_Y1 - GLASS_Y0, 2 * GLASS_R], color: P.glass, spec: 0.6, glass: true });
  out.push({ kind: 'dome', pos: [0, GLASS_Y1, 0], scale: [2 * GLASS_R, 2 * DOME_H, 2 * GLASS_R], color: P.glass, spec: 0.6, glass: true });
  return out;
}

// ---------------------------------------------------------------- electrons

/** An electron: direction round the cathode, height, progress through its flight, flight time, whether it
 *  reaches the plate or turns back (and how far out). */
export interface Electron { th: number; y: number; ph: number; dur: number; pass: boolean; turn: number }
/** An electron's drawn diameter (mm): symbolic, for visibility (real ones are points; the grid wire is 0.14 mm). */
export const E_D = 0.3;

/** Where an electron is at `rho` (0 the cathode's surface, 1 the grid, 2 the plate) in direction th. */
export function electronAt(th: number, y: number, rho: number): Vec3 {
  const c = Math.cos(th), sn = Math.sin(th);
  const gx = GX * c, gz = GZ * sn, k = Math.min(PX / Math.max(1e-6, Math.abs(gx)), PZ / Math.max(1e-6, Math.abs(gz)));
  const [ax, az, bx, bz, t] = rho <= 1 ? [CX * c, CZ * sn, gx, gz, rho] : [gx, gz, gx * k, gz * k, rho - 1];
  return [XA + ax + (bx - ax) * t, y, az + (bz - az) * t];
}

/** Progress → rho: an electron bound for the plate speeds up all the way; one turned back slows, stops, returns. */
export const rhoOf = (q: Electron) => (q.pass ? 2 * q.ph ** 1.6 : q.turn * Math.sin(Math.PI * q.ph));

export function newElectron(pass: boolean, rnd: () => number, ph = 0): Electron {
  return {
    th: rnd() * 2 * Math.PI, y: EMIT0 + rnd() * (EMIT1 - EMIT0), ph, pass,
    // one that returns rises only a fraction of the gap (the space-charge cloud), slowly; one for the plate crosses it
    dur: pass ? 0.55 + 0.3 * rnd() : 0.5 + 0.6 * rnd(), turn: pass ? 1 : 0.1 + 0.25 * rnd(),
  };
}
/** Electrons drawn per second at the full stream: the cloud's, and those that cross the grid at the full plate current. */
export const CLOUD_RATE = 150, FLOW_RATE = 60, MAX_ELECTRONS = 330;

/** A fixed spread of electrons for reduced motion: the cloud and the stream across, in the same proportion. */
export function staticElectrons(e: number, flow: number, charge: boolean): Electron[] {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const nc = charge ? Math.round(e * 90) : 0, np = Math.round(flow * 40);
  return [...Array.from({ length: nc }, () => newElectron(false, rnd, 0.12 + 0.8 * rnd())), ...Array.from({ length: np }, () => newElectron(true, rnd, 0.12 + 0.8 * rnd()))];
}

const electronParts = (list: readonly Electron[], P: Palette): Part[] =>
  list.map((q) => ({ kind: 'sph', pos: electronAt(q.th, q.y, rhoOf(q)), scale: [E_D, E_D, E_D], color: P.electron, emissive: scaleRgb(P.electron, 0.55) }));

// ---------------------------------------------------------------- labels

/** A label: where it points, which side its text sits on, and the way the labelled face looks (dimmed when that
 *  face turns away from the camera: the label would otherwise float over whatever hides it). */
interface Anchor { text: string; p: Vec3; side: 'l' | 'r' | 't' | 'b'; n: Vec3; minor?: boolean; under?: boolean }

const pinAnchor = (k: number): Anchor => {
  const [x, z] = pinPos(k);
  return { text: `${k} ${PIN_ROLES[k - 1]}`, p: [x, -PIN_L - 0.8, z], side: 'b', n: [0, -1, 0], under: true };
};
const ANCHORS: Anchor[] = [
  { text: 'plate (cut away)', p: [XA - 3.2, 50.8, -PZ], side: 'l', n: [0, 0, 1] },
  { text: 'heater', p: [XA - 0.4, 48.5, 0.2], side: 'r', n: [0, 0, 1] },
  { text: 'grid', p: [XA - GX, 41.5, 0.3], side: 'l', n: [-0.2, 0, 1] },
  { text: 'cathode', p: [XA - CX * 0.7, 35, CZ * 0.7], side: 'l', n: [-0.3, 0, 1] },
  { text: 'other section', p: [XB + 2.5, 41, PZ + PT], side: 'r', n: [0, 0, 1] },
  { text: 'getter (barium)', p: [2.75, 58.6, 0], side: 'r', n: [0.3, 0.5, 1] },
  { text: 'mica', p: [-12.5, MICA_LO, 2], side: 'l', n: [0, 0.3, 1], minor: true },
  { text: 'glass', p: [GLASS_R * 0.7, 22, GLASS_R * 0.7], side: 'r', n: [0.7, 0, 0.7], minor: true },
  { text: 'octal base', p: [BASE_R * 0.7, 6, BASE_R * 0.7], side: 'r', n: [0.7, 0, 0.7] },
  ...Array.from({ length: 8 }, (_, k) => pinAnchor(k + 1)), // seen from below only (the Underside button)
];

// ---------------------------------------------------------------- the 2D fallback: the same parts, seen from the front

const F2 = { x0: -44, y0: -14, w: 88, h: 90 };
const rgbCss = (c: RGB | RGBA) => `rgb(${c.slice(0, 3).map((v) => Math.round(Math.min(1, v) * 255)).join(' ')}${c.length > 3 ? ` / ${(c[3] ?? 1).toFixed(3)}` : ''})`;

function partShape(p: Part): SVGElement | null {
  if (p.kind === 'wall' || p.kind === 'dome') return null; // the envelope is drawn as one outline
  const [x, y] = p.pos, [w, hh] = p.scale ?? [1, 1, 1], e = p.emissive;
  // Glow brightens a part, but short of white (the 3D view's lighting would hold it there too).
  const col = e && e.some((v) => v > 0.01) ? ([...p.color.slice(0, 3).map((v, i) => Math.min(1, v + 0.45 * e[i])), ...p.color.slice(3)] as RGB | RGBA) : p.color;
  if (p.kind === 'sph') return s('ellipse', { cx: x, cy: -y, rx: w / 2, ry: hh / 2, fill: rgbCss(col), class: 'r3-edge' });
  return s('rect', { x: x - w / 2, y: -y - hh / 2, width: w, height: hh, fill: rgbCss(col), class: p.kind === 'tor' || p.glass ? '' : 'r3-edge' });
}

function drawFlat(svg: SVGSVGElement, parts: Part[], marks: Anchor[]): SVGGElement {
  // Back to front by each part's front face.
  const order = parts.map((p, i) => ({ p, i, z: p.pos[2] + (p.scale?.[2] ?? 1) / 2 })).sort((a, b) => a.z - b.z || a.i - b.i);
  const g = s('g'), electrons = s('g') as SVGGElement;
  for (const { p } of order) { const e = partShape(p); if (e) g.append(e); }
  g.append(electrons);
  const R = GLASS_R, Rg = GLASS_R - 0.3;
  g.append(s('path', { class: 't3-getter', d: `M${-Rg} ${-GLASS_Y1} A${Rg} ${DOME_H - 0.3} 0 0 1 ${Rg} ${-GLASS_Y1} Z` }));
  g.append(s('path', { class: 't3-glass', d: `M${-R} ${-GLASS_Y0} L${-R} ${-GLASS_Y1} A${R} ${DOME_H} 0 0 1 ${R} ${-GLASS_Y1} L${R} ${-GLASS_Y0}` }));
  // Labels outside the bulb, on leader lines, like a drawing (inside it they would sit on the parts).
  for (const m of marks) {
    if (m.minor) continue;
    const [x, y] = [m.p[0], -m.p[1]], sd = m.side === 'l' ? -1 : 1, tx = sd * (GLASS_R + 3);
    g.append(s('line', { x1: x, y1: y, x2: tx, y2: y, class: 't3-flat-lead' }));
    g.append(s('circle', { cx: x, cy: y, r: 0.45, class: 't3-flat-dot' }));
    g.append(s('text', { x: tx + sd * 0.8, y: y + 0.9, class: 'r3-flat-lbl', 'text-anchor': sd < 0 ? 'end' : 'start' }, m.text));
  }
  svg.replaceChildren(g);
  return electrons;
}

// ---------------------------------------------------------------- plots

export const PW = 360, PX0 = 40, PX1 = 336;
const minus = (t: string) => t.replace(/^-/, '−');
const fmt = (x: number, d = 1) => minus(x.toFixed(d));
// (1) plate voltage against grid voltage, hot
export const H1 = 172;
const gX = (vg: number) => PX0 + ((vg + 20) / 22) * (PX1 - PX0), vY = (vp: number) => 150 - (vp / 260) * 132;
// (2) plate current against time since switch-on
export const H2 = 160;
const tX = (t: number) => PX0 + (t / 20) * (PX1 - PX0), iY = (mA: number) => 134 - (mA / 10) * 114;
/** The hot transfer curve (it does not change). */
const XFER = Array.from({ length: 89 }, (_, k) => { const vg = -20 + k * 0.25; return [vg, plateVoltage(vg)] as const; });

export function drawXfer(svg: SVGSVGElement, st: TubeState): void {
  const els: SVGElement[] = [];
  const text = (x: number, y: number, t: string, cls = 'tick', anchor = 'end') => els.push(s('text', { x, y, class: cls, 'text-anchor': anchor }, t));
  for (const vp of [0, V_LOW, V_HIGH]) { els.push(s('line', { x1: PX0, x2: PX1, y1: vY(vp), y2: vY(vp), class: 'grid' })); text(PX0 - 4, vY(vp) + 3, String(Math.round(vp))); }
  for (const vg of [-20, -15, -10, -5, 0]) text(gX(vg), H1 - 6, `${minus(String(vg))}${vg === 0 ? ' V' : ''}`, 'tick', 'middle');
  els.push(s('line', { x1: gX(V_CUTOFF), x2: gX(V_CUTOFF), y1: 16, y2: 150, class: 't3-cut' }));
  text(gX(V_CUTOFF) - 4, 108, `ideal cutoff ${fmt(V_CUTOFF)} V`, 't3-cutl', 'end');
  text(gX(V_CUTOFF) - 4, 120, 'real: a tail to −18 V', 't3-cutl', 'end');
  els.push(s('polyline', { points: XFER.map(([vg, vp]) => `${gX(vg).toFixed(1)},${vY(vp).toFixed(1)}`).join(' '), class: 't3-vp' }));
  els.push(s('line', { x1: PX0, x2: PX0, y1: 14, y2: 150, class: 'ax' }));
  text(PX1, 9, 'plate V against grid V (hot)', 'axl');
  els.push(s('circle', { cx: gX(st.vg), cy: vY(st.vp), r: 4.2, class: 't3-dot' }));
  svg.replaceChildren(...els);
}

export function drawWarm(svg: SVGSVGElement, curve: WarmSample[], st: TubeState): void {
  const els: SVGElement[] = [];
  const text = (x: number, y: number, t: string, cls = 'tick', anchor = 'end') => els.push(s('text', { x, y, class: cls, 'text-anchor': anchor }, t));
  for (const mA of [0, 5, 10]) { els.push(s('line', { x1: PX0, x2: PX1, y1: iY(mA), y2: iY(mA), class: 'grid' })); text(PX0 - 4, iY(mA) + 3, String(mA)); }
  for (const t of [0, 5, 10, 15, 20]) text(tX(t), H2 - 8, `${t}${t === 20 ? ' s' : ''}`, 'tick', 'middle');
  els.push(s('polyline', { points: curve.map((q) => `${tX(q.t).toFixed(1)},${iY(q.ip * 1e3).toFixed(1)}`).join(' '), class: 't3-ip' }));
  els.push(s('line', { x1: PX0, x2: PX0, y1: 14, y2: 134, class: 'ax' }));
  text(PX1, 9, `plate mA after switch-on (grid ${fmt(st.vg, 2)} V)`, 'axl');
  els.push(s('line', { x1: tX(st.th), x2: tX(st.th), y1: 14, y2: 134, class: 'cursor' }));
  els.push(s('circle', { cx: tX(st.th), cy: iY(st.ip * 1e3), r: 4.2, class: 't3-dot' }));
  svg.replaceChildren(...els);
}

// ---------------------------------------------------------------- the widget

/** Amps with a unit that keeps three figures readable. */
export function amps(a: number): string {
  if (a >= 1) return `${a.toFixed(2)} A`;
  if (a >= 1e-3) return `${(a * 1e3).toFixed(a >= 0.1 ? 0 : 2)} mA`;
  if (a >= 1e-6) return `${(a * 1e6).toFixed(2)} µA`;
  if (a >= 1e-9) return `${(a * 1e9).toFixed(2)} nA`;
  return '< 1 nA';
}

const HEAT_END = 20, PLAY_RATE = 2; // "Switch on from cold": 20 s of heater time at twice real time

export function triodeView(): Widget {
  let st = stateAt(0, HEAT_END), curve = warmup(st.vg, HEAT_END, 0.05);
  // 'wait' until the renderer chunk answers; 'flat' without WebGL2 or while the context is lost.
  let mode: 'wait' | 'gl' | 'flat' = 'wait';
  let playing = 0, paused = false, anim = 0, last = 0, spawnAcc = 0, spawnPass = 0, pending = 0, renderer: Renderer | null = null, dead = false, visible = true;
  let electrons: Electron[] = [], flatElectrons: SVGGElement | null = null;

  // Controls
  const gIn = h('input', { type: 'range', min: -20, max: GRID_MAX, step: 0.25, value: st.vg, 'aria-label': 'Grid voltage' }) as HTMLInputElement;
  const gOut = h('output', null, '');
  const tIn = h('input', { type: 'range', min: 0, max: HEAT_END, step: 0.1, value: st.th, 'aria-label': 'Time since the heater was switched on' }) as HTMLInputElement;
  const tOut = h('output', null, '');
  const chargeIn = h('input', { type: 'checkbox', checked: true }) as HTMLInputElement;
  const underBtn = h('button', { type: 'button', class: 'btn sm', title: 'View the base from below with the pins numbered' }, 'Underside');
  const coldBtn = h('button', { type: 'button', class: 'btn sm primary' }, 'Switch on from cold');
  const resetBtn = h('button', { type: 'button', class: 'btn sm' }, 'Reset view');
  const ctl = h('div', { class: 'r3-ctl' },
    h('label', { class: 'r3-sl' }, h('span', null, 'Grid'), gIn, gOut),
    h('label', { class: 'r3-sl' }, h('span', null, 'Heater on for'), tIn, tOut),
    h('label', { class: 'r3-chk' }, chargeIn, 'Space charge'),
    h('div', { class: 'r3-btns' }, coldBtn, underBtn, resetBtn));

  // Stage: the canvas (or the flat drawing), labels over it, status chips.
  const canvas = h('canvas', { class: 'r3-canvas', tabindex: 0, 'aria-label': 'A 6SN7 twin triode in 3D, one plate cut away: ' + ORBIT_ARIA }) as HTMLCanvasElement;
  const flatSvg = s('svg', { class: 'r3-flat', viewBox: `${F2.x0} ${-F2.y0 - F2.h} ${F2.w} ${F2.h}`, role: 'img', 'aria-label': 'A 6SN7 twin triode seen from the front, one plate cut away: cathode, heater, grid, plate, electrons' }) as SVGSVGElement;
  flatSvg.style.display = 'none';
  const labels = h('div', { class: 'r3-labels', 'aria-hidden': 'true' });
  const live = h('span', { class: 'sr-only', 'aria-live': 'polite' });
  let lastLabel = '';
  const stateChip = h('span', { class: 'r3-chip' }), plateChip = h('span', { class: 'r3-chip' }), tempChip = h('span', { class: 'r3-chip' });
  const HINT_GL = `Overall size to scale; the near plate is cut away and its cathode sleeve cut to show the heater. Gaps, grid wire and electrons are drawn larger than life, electron counts proportional. The grid stops at 0 V: above it a real grid draws current, which the model leaves out. ${ORBIT_HINT}`;
  const hint = h('div', { class: 'r3-hint' }, HINT_GL);
  const stage = h('div', { class: 'r3-stage' }, canvas, flatSvg, labels, h('div', { class: 'r3-chips' }, stateChip, plateChip, tempChip), live);
  const frame = modelFrame({ stage, name: '6SN7 twin triode', renderer: () => (mode === 'gl' ? renderer : null), labels });

  // Plots and summary
  const xfer = s('svg', { class: 'r3-plot t3-plot t3-static', viewBox: `0 0 ${PW} ${H1}`, role: 'img', 'aria-label': 'Plate voltage against grid voltage with the cathode hot, the operating point and the cutoff marked' }) as SVGSVGElement;
  const warm = s('svg', { class: 'r3-plot t3-plot', viewBox: `0 0 ${PW} ${H2}`, role: 'img', 'aria-label': 'Plate current against time since switch-on at this grid voltage; point or drag to set the heater time' }) as SVGSVGElement;
  const kv = h('div', { class: 'r3-kv' });
  const bar = h('i'), barBox = h('div', { class: 't3-bar', role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': PLATE_RATING_W, 'aria-label': 'Plate dissipation against the 2.5 watt rating' }, bar);
  const barNote = h('div', { class: 'r3-hint' });

  const el = h('div', { class: 'r3' },
    h('div', { class: 'r3-main' }, ctl, stage, hint),
    h('div', { class: 'r3-side' }, xfer, warm, h('h4', null, 'This section ', h('span', { class: 'r3-badge' }, 'model')), kv, barBox, barNote));

  const colors = new CssColors(el);
  let palette: Palette | null = null;
  const pal = (): Palette => {
    if (palette) return palette;
    const c = (t: string) => colors.rgb(t);
    const p: Palette = {
      bakelite: c('--tb-bakelite'), pin: c('--tb-pin'), plate: c('--tb-plate'), nickel: c('--tb-nickel'), oxide: c('--tb-oxide'),
      red: c('--tb-red'), orange: c('--tb-orange'), heater: c('--tb-heater'), grid: c('--tb-grid'), rod: c('--tb-rod'),
      mica: colors.rgba('--tb-mica'), glass: colors.rgba('--tb-glass'), press: colors.rgba('--tb-press'), getter: colors.rgba('--tb-getter'),
      getterCup: c('--tb-getter-cup'), electron: c('--tb-electron'),
      role: { g: c('--tb-pin-g'), p: c('--tb-pin-p'), k: c('--tb-pin-k'), h: c('--tb-pin-h') },
    };
    // Kept only once the widget is in the page (before that nothing resolves).
    if (el.isConnected) palette = p;
    return p;
  };

  // Label overlays: one element per anchor, re-projected after every frame.
  const lblEls = ANCHORS.map((a) => labels.appendChild(h('span', { class: `r3-lbl ${a.side}${a.minor ? ' minor' : ''}` }, h('i'), h('b', null, a.text))));
  const placeLabels = () => {
    if (mode !== 'gl' || !renderer) return;
    const eye = renderer.camera.eye(), w = canvas.clientWidth, hh = canvas.clientHeight, under = renderer.camera.pitch < -0.25;
    ANCHORS.forEach((a, k) => {
      const p = renderer!.project(a.p), e = lblEls[k];
      if (!!a.under !== under) { e.style.display = 'none'; return; }
      // Behind the camera, or pointing at something out of the frame (the pins, zoomed in).
      if (!p || p[0] < 4 || p[1] < 4 || p[0] > w - 4 || p[1] > hh - 14) { e.style.display = 'none'; return; }
      e.style.display = '';
      e.classList.toggle('away', dot3(a.n, sub3(eye, a.p)) < 0);
      e.style.transform = `translate(${p[0].toFixed(1)}px, ${p[1].toFixed(1)}px)`;
    });
    declutterLabels(lblEls);
  };

  const summary = () => {
    const { vp, ip } = st, bit = vp > 200 ? '1 (cut off)' : vp < 120 ? '0 (conducting)' : 'between';
    const rows: [string, string, string?][] = [
      ['Circuit', `${B_PLUS} V through ${R_PLATE / 1e3} kΩ`],
      ['Cathode', `${Math.round(st.Tc)} K`, st.Tc > 800 ? 'hot' : ''],
      ['Emission limit', amps(st.sat)],
      ['Falls back to the cathode', `${(100 * returned(st)).toFixed(1)} %`],
      ['Plate current', `${(ip * 1e3).toFixed(2)} mA`],
      ['Plate voltage', `${vp.toFixed(1)} V`],
      ['As a bit', bit, vp > 200 || vp < 120 ? '' : 'bad'],
      ['Plate dissipation', `${(vp * ip).toFixed(2)} W of ${PLATE_RATING_W} W`],
      ['Plate resistor', `${((B_PLUS - vp) * ip).toFixed(2)} W`],
      ['Heater', `${HEATER_W.toFixed(2)} W, always`],
    ];
    kv.replaceChildren(...rows.flatMap(([k, v, c]) => [h('span', null, k), h('span', { class: `v ${c ?? ''}` }, v)]));
    const pw = vp * ip;
    bar.style.width = `${Math.min(100, (100 * pw) / PLATE_RATING_W)}%`;
    barBox.setAttribute('aria-valuenow', pw.toFixed(2));
    barBox.classList.toggle('over', pw > PLATE_RATING_W);
    barNote.textContent = `Plate ${pw.toFixed(2)} W against the 6SN7GTB rating of ${PLATE_RATING_W} W (max 450 V, 20 mA of cathode current per section).`;
  };

  const putElectrons = () => {
    if (mode === 'gl' && renderer) renderer.updateBatch(4, packInstances(electronParts(electrons, pal())));
    else if (mode === 'flat' && flatElectrons) {
      const col = rgbCss(pal().electron);
      flatElectrons.replaceChildren(...electrons.map((q) => { const p = electronAt(q.th, q.y, rhoOf(q)); return s('circle', { cx: p[0].toFixed(2), cy: (-p[1]).toFixed(2), r: E_D / 2, fill: col }); }));
    }
  };

  // The electrons fly while the cathode emits (or the last ones are still on their way), the widget is on screen and
  // motion is welcome; with reduced motion a still spread stands for the current.
  const tick = (now: number) => {
    anim = 0;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const { e, flow } = stream(st);
    spawnAcc += (e * CLOUD_RATE * (chargeIn.checked ? 1 : 0)) * dt;
    spawnPass += flow * FLOW_RATE * dt;
    for (; spawnAcc >= 1; spawnAcc--) if (electrons.length < MAX_ELECTRONS) electrons.push(newElectron(false, Math.random));
    for (; spawnPass >= 1; spawnPass--) if (electrons.length < MAX_ELECTRONS) electrons.push(newElectron(true, Math.random));
    electrons = electrons.filter((q) => (q.ph += dt / q.dur) < 1);
    putElectrons();
    ensureAnim();
  };
  const ensureAnim = () => {
    if (reducedMotion()) {
      cancelAnimationFrame(anim); anim = 0;
      const { e, flow } = stream(st);
      electrons = staticElectrons(e, flow, chargeIn.checked);
      putElectrons();
      return;
    }
    const want = mode !== 'wait' && visible && !dead && (stream(st).e > 0 || electrons.length > 0);
    if (want && !anim) { last = performance.now(); anim = requestAnimationFrame(tick); }
    if (!want && anim) { cancelAnimationFrame(anim); anim = 0; }
  };

  const draw = () => {
    gOut.textContent = `${fmt(st.vg, 2)} V`;
    tOut.textContent = `${st.th.toFixed(1)} s`;
    const { e } = stream(st);
    const [label, cls] = e === 0 ? ['cold', ''] : e < 1 ? ['warming', 'warn']
      : st.vp > 200 ? ['cut off', ''] : st.vp < 120 ? ['conducting', 'good'] : ['between', 'warn'];
    stateChip.textContent = label;
    if (label !== lastLabel) { lastLabel = label; live.textContent = `Tube ${label}`; }
    stateChip.className = `r3-chip ${cls}`;
    plateChip.textContent = `plate ${st.vp.toFixed(0)} V`;
    tempChip.textContent = `cathode ${Math.round(st.Tc)} K`;
    tempChip.className = `r3-chip ${st.Tc > 800 ? 'hot' : ''}`;
    drawXfer(xfer, st);
    drawWarm(warm, curve, st);
    summary();
    if (mode === 'wait') return;
    const parts = tubeParts(st, pal(), { charge: chargeIn.checked }), of = (k: Kind, glass = false) => packInstances(parts.filter((p) => p.kind === k && !!p.glass === glass));
    if (mode === 'gl' && renderer) {
      renderer.updateBatch(0, of('box')); renderer.updateBatch(1, of('cyl')); renderer.updateBatch(2, of('sph')); renderer.updateBatch(3, of('tor'));
      renderer.updateBatch(5, of('box', true)); renderer.updateBatch(6, of('cyl', true)); renderer.updateBatch(7, of('wall', true)); renderer.updateBatch(8, of('dome', true));
    } else if (mode === 'flat') flatElectrons = drawFlat(flatSvg, parts, ANCHORS);
    putElectrons();
    ensureAnim();
  };

  const set = (vg: number, th: number) => {
    const newCurve = vg !== st.vg;
    st = stateAt(vg, Math.max(0, Math.min(HEAT_END, th)));
    if (newCurve) curve = warmup(vg, HEAT_END, 0.05);
    gIn.value = String(st.vg);
    tIn.value = String(st.th);
    draw();
  };
  /** A new heater time, with whatever the grid slider says now (a grid move may still be waiting for its frame). */
  const setT = (th: number) => { cancelAnimationFrame(pending); pending = 0; set(Number(gIn.value), th); };

  const stop = () => { cancelAnimationFrame(playing); playing = 0; paused = false; coldBtn.textContent = 'Switch on from cold'; };
  const switchOn = () => {
    // Reduced motion: no animation, straight to the end (the heater slider still scrubs).
    if (reducedMotion()) { stop(); setT(HEAT_END); return; }
    // From cold, unless a run was paused part-way: then it carries on.
    const from = paused && st.th < HEAT_END ? st.th : 0;
    if (!from) electrons = [];
    paused = false;
    setT(from);
    coldBtn.textContent = 'Pause';
    const t0 = performance.now();
    const step = (now: number) => {
      setT(from + ((now - t0) / 1000) * PLAY_RATE);
      playing = st.th < HEAT_END ? requestAnimationFrame(step) : 0;
      if (!playing) coldBtn.textContent = 'Switch on from cold';
    };
    playing = requestAnimationFrame(step);
  };

  gIn.addEventListener('input', () => {
    gOut.textContent = `${fmt(Number(gIn.value), 2)} V`;
    if (!pending) pending = requestAnimationFrame(() => { pending = 0; set(Number(gIn.value), st.th); });
  });
  tIn.addEventListener('input', () => { stop(); setT(Number(tIn.value)); });
  coldBtn.addEventListener('click', () => {
    if (playing) { stop(); paused = true; coldBtn.textContent = 'Resume'; return; }
    switchOn();
  });
  resetBtn.addEventListener('click', () => { renderer?.camera.reset(); renderer?.invalidate(); });
  // The base from below, pins numbered as on the datasheet (the key at the back).
  underBtn.addEventListener('click', () => {
    const c = renderer?.camera;
    if (!c) return;
    c.target = [0, 2, 0]; c.yaw = 0; c.pitch = -1.05; c.dist = 62;
    renderer!.invalidate();
  });
  chargeIn.addEventListener('change', () => { electrons = []; draw(); });
  // Scrub the heater time by pointing at the warm-up plot.
  const scrub = (e: PointerEvent) => {
    const r = warm.getBoundingClientRect(), x = ((e.clientX - r.left) / r.width) * PW;
    stop();
    setT(Math.round(((x - PX0) / (PX1 - PX0)) * HEAT_END * 10) / 10);
  };
  warm.addEventListener('pointerdown', (e) => { warm.setPointerCapture(e.pointerId); scrub(e); });
  warm.addEventListener('pointermove', (e) => { if (warm.hasPointerCapture(e.pointerId)) scrub(e); });

  const setMode = (m: 'gl' | 'flat') => {
    const on = m === 'flat';
    mode = m;
    canvas.style.display = on ? 'none' : '';
    flatSvg.style.display = on ? '' : 'none';
    labels.style.display = on ? 'none' : '';
    hint.textContent = on ? 'Overall size to scale; the near plate is cut away. A flat view: this browser has no WebGL2 for the 3D one.' : HINT_GL;
    frame.setFlat(on);
    resetBtn.style.display = on ? 'none' : '';
    underBtn.style.display = on ? 'none' : '';
    draw();
  };

  const applyLights = () => renderer?.setLights({ sky: colors.rgb('--tb-sky'), ground: colors.rgb('--tb-ground'), key: colors.rgb('--tb-key') });
  const unwatch = watchTheme(() => {
    colors.invalidate(); palette = null;
    applyLights();
    draw();
  });
  const io = new IntersectionObserver((es) => { visible = es.some((x) => x.isIntersecting); ensureAnim(); });
  io.observe(stage);

  set(st.vg, st.th);
  void import('../gl/renderer').then(({ createRenderer, OrbitCamera, boxMesh, cylinderMesh, sphereMesh, torusMesh }) => {
    if (dead) return;
    const cam = new OrbitCamera({ target: [-1.5, 34, 0], yaw: -0.5, pitch: 0.3, dist: 130 }, { minDist: 30, maxDist: 450, minPitch: -1.3 });
    try {
      renderer = createRenderer(canvas, cam, {
        onRender: placeLabels,
        onLost: () => setMode('flat'),
        onRestored: () => setMode('gl'),
      });
    } catch { renderer = null; }
    if (!renderer) { setMode('flat'); return; }
    const empty = () => new Float32Array(0), boxM = boxMesh(), cylM = cylinderMesh(40);
    renderer.setScene([
      { mesh: boxM, data: empty() }, { mesh: cylM, data: empty() }, { mesh: sphereMesh(12, 8), data: empty() }, { mesh: torusMesh(28, 4, 0.02), data: empty() },
      { mesh: sphereMesh(6, 4), data: empty() }, // electrons
      // glass, inside out: the press, micas and glow, the getter's mirror, the envelope
      { mesh: boxM, data: empty(), transparent: true }, { mesh: cylM, data: empty(), transparent: true },
      { mesh: cylinderMesh(48, false), data: empty(), transparent: true }, { mesh: sphereMesh(48, 12, true), data: empty(), transparent: true },
    ]);
    applyLights();
    setMode('gl');
  }).catch(() => { if (!dead) setMode('flat'); });

  return {
    el,
    destroy() {
      dead = true;
      stop();
      cancelAnimationFrame(anim);
      cancelAnimationFrame(pending);
      io.disconnect();
      unwatch();
      frame.destroy();
      renderer?.destroy();
      renderer = null;
      colors.destroy();
    },
  };
}
