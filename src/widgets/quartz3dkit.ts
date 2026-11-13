// The watch crystal and its oscillator on the studio renderer (DOM-free, tested): quartz3dgeom.ts's numbers in true
// shapes. Four scenes, one at a time: the tuning fork in its ceramic package (grooved tines with gold films, bent to the
// cantilever's first mode shape), the Pierce oscillator and the fifteen-stage divider on a board, two forks and the phase
// ring between their clocks, and an AT-cut blank in thickness shear. A cut takes the package's lid off.
//
// Units: the crystal, drift and AT-cut scenes 1 = 0.1 mm, the board 1 = 1 mm.

import { lathe, merge, refresh, roundedBox, sphere, sweep, transform, tube, type Geo } from '../gl/kit/geo';
import { M, type Material } from '../gl/kit/materials';
import type { Beat, Item, Model3, StudioAnchor } from '../gl/kit/scene';
import { quatAxisAngle, type Vec3 } from '../gl/math';
import type { OrbitView } from '../gl/camera';
import {
  AT_BLANK_MM, AT_ELEC_MM, AT_LAYERS, AT_SHEAR, AT_T_DRAWN, CHAIN_Z, DRIFT_AX, DRIFT_BX, DRIFT_C, DRIFT_R, DRIFT_Z, GROOVE_D, GROOVE_W, SEG,
  STAGES, TINE_L, TIP_DRAWN, WAFER_T, TINE_W, WINDOW_FRAC, chainX, fork, inWindow, modeShape, onRing, shearAt, atThicknessMm, AT_F,
} from './quartz3dgeom';

export type QuartzView = 'crystal' | 'loop' | 'drift' | 'at';
export interface QuartzState {
  view: QuartzView;
  /** The fork's swing, −1 … 1 (the tine tip at ±TIP_DRAWN). */
  disp: number;
  /** Crystal B's swing and the phase B has gained on A, in cycles (drift). */
  dispB: number; slip: number;
  /** The divider's stage outputs (loop). */
  bits: number[];
  /** Bigger LEDs on a phone-width canvas. */
  big?: boolean;
}
type Detail = 'full' | 'flat';

const SRC = {
  fc135: 'Epson FC-135: 3.2 × 1.5 × 0.8 mm SMD package, ±20 ppm',
  patent: 'tuning-fork patents US 7 944 131 / 8 572 824: tine width < 0.18 mm, wafer 0.05–0.15 mm, groove ranges',
  beam: 'tine length from Euler–Bernoulli beam theory for 32 768 Hz at 0.1 mm width',
  tn31: 'IQD / Statek Technical Note 31: the Pierce circuit\'s values',
  cts: 'CTS: f ≈ 1.67 MHz·mm / thickness for an AT-cut',
  drawn: 'drawn, not measured',
};

// ---------------------------------------------------------------- shapes

const boxes = new Map<string, Geo>();
/** A box between two corners: its geometry (memoized by size) and where its centre goes. */
function bx(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, r = 0.05): { geo: Geo; at: Vec3 } {
  const w = x1 - x0, hh = y1 - y0, d = z1 - z0, key = `${w.toFixed(4)},${hh.toFixed(4)},${d.toFixed(4)},${r}`;
  let geo = boxes.get(key);
  if (!geo) { geo = roundedBox(w, hh, d, Math.min(r, w / 3, hh / 3, d / 3), 2); boxes.set(key, geo); }
  return { geo, at: [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2] };
}
const cyls = new Map<string, Geo>();
/** An upright cylinder of radius r and height hh, its base at the origin. */
function cyl(r: number, hh: number, seg = 32): Geo {
  const key = `${r},${hh},${seg}`;
  let g = cyls.get(key);
  if (!g) { g = lathe([[0, 0], [r, 0], [r, hh], [0, hh]], { seg, crease: 30 }); cyls.set(key, g); }
  return g;
}
const at = (g: { geo: Geo; at: Vec3 }, mat: Material, name: string, more: Partial<Item> = {}): Item => ({ geo: g.geo, at: g.at, mat, name, ...more });
const translate = (g: Geo, x: number, y: number, z: number): Geo => { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; m[12] = x; m[13] = y; m[14] = z; return transform(g, m); };

// ---------------------------------------------------------------- materials

const ceramic = M.make({ base: '--qz-ceramic', metal: 0, rough: 0.6, label: 'alumina ceramic' });
const quartzMat = M.make({ base: '--qz-quartz', metal: 0, rough: 0.08, coat: 0.6, transmit: 0.3, tint: [0.88, 0.94, 1.0], label: 'crystal quartz (Z-cut wafer)' });
const glue = M.make({ base: '--qz-glue', metal: 0.4, rough: 0.5, label: 'silver-filled conductive glue' });
const lidMat = M.make({ base: [0.7, 0.68, 0.64], metal: 1, rough: 0.3, label: 'Kovar lid, nickel-plated' });
const mask = M.make({ base: [0.07, 0.19, 0.11], metal: 0, rough: 0.45, coat: 0.4, label: 'FR-4 under green solder mask' });
const trace = M.make({ base: [0.85, 0.6, 0.42], metal: 1, rough: 0.4, label: 'copper trace' });
const tin = M.make({ base: [0.72, 0.72, 0.7], metal: 1, rough: 0.45, label: 'tin' });
const epoxy = M.epoxy;
const capBody = M.make({ base: '--qz-body', metal: 0, rough: 0.6, label: 'ceramic capacitor (C0G)' });
const resBody = M.make({ base: [0.1, 0.1, 0.11], metal: 0, rough: 0.5, label: 'thick-film resistor' });
const ledOff = M.make({ base: '--qz-led-off', metal: 0, rough: 0.2, coat: 0.6, label: 'LED, off' });
const ringMat = M.make({ base: [0.2, 0.22, 0.26], metal: 0.2, rough: 0.5, label: 'the phase ring (a diagram, not a part)' });
const film = (polarity: number, k: number): Material => M.glow(M.make({ base: [1.0, 0.77, 0.34], metal: 1, rough: 0.25, label: 'gold electrode film' }), polarity >= 0 ? '--qz-plus' : '--qz-minus', 0.35 * k);

// ---------------------------------------------------------------- the fork

const f = fork, Y1 = f.y0 + f.t, ZC = f.gap / 2 + f.w / 2, ZO = f.gap / 2 + f.w, BX0 = f.x0 - f.base;
const GW = f.w * GROOVE_W, GD = f.t * GROOVE_D, FILM = 0.06;
/** Tine sgn's centre line at swing d, from xi0 to xi1 of its length (y at the wafer's middle). */
function line(sgn: number, d: number, xi0 = 0, xi1 = 1, n = SEG): Vec3[] {
  return Array.from({ length: n + 1 }, (_, k) => { const xi = xi0 + ((xi1 - xi0) * k) / n; return [f.x0 + xi * f.L, f.y0 + f.t / 2, sgn * ZC + sgn * d * TIP_DRAWN * modeShape(xi)] as Vec3; });
}
/** A rectangle in the sweep's section plane: u along y (thickness), v along z (width), counter-clockwise. */
const rect = (u0: number, u1: number, v0: number, v1: number): [number, number][] => [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
/** The tine's quartz: two shoulders at full thickness and a thinner floor between them (a groove in each face). */
function tineGeo(sgn: number, d: number): Geo {
  const p = line(sgn, d), T = f.t / 2, W = f.w / 2, g = GW / 2;
  return merge([sweep(p, rect(-T, T, -W, -g)), sweep(p, rect(-T, T, g, W)), sweep(p, rect(-T + GD, T - GD, -g, g))], 'tine');
}
/** Gold in the two grooves (one polarity) and on the two sides (the other), over the middle of the tine. */
function grooveGeo(sgn: number, d: number): Geo {
  const p = line(sgn, d, 0.12, 0.88, SEG - 2), T = f.t / 2 - GD, g = GW * 0.4;
  return merge([sweep(p, rect(T, T + FILM, -g, g)), sweep(p, rect(-T - FILM, -T, -g, g))], 'groove films');
}
function sideGeo(sgn: number, d: number): Geo {
  const p = line(sgn, d, 0.12, 0.88, SEG - 2), T = f.t / 2, W = f.w / 2;
  return merge([sweep(p, rect(-T, T, W, W + 0.03)), sweep(p, rect(-T, T, -W - 0.03, -W))], 'side films');
}
interface Tine { quartz: Geo; groove: Geo; side: Geo }
const tines = new Map<string, Tine>();
/** A tine's geometry, kept per key and refreshed in place as it bends (the renderer re-uploads it). */
function tine(key: string, sgn: number, d: number): Tine {
  const t = tines.get(key);
  if (!t) { const n = { quartz: tineGeo(sgn, d), groove: grooveGeo(sgn, d), side: sideGeo(sgn, d) }; tines.set(key, n); return n; }
  refresh(t.quartz, tineGeo(sgn, d)); refresh(t.groove, grooveGeo(sgn, d)); refresh(t.side, sideGeo(sgn, d));
  return t;
}

interface Static { pkg: Geo; walls: Geo; pads: Geo; under: Geo; glue: Geo; base: Geo; traces: Geo; lid: Geo }
const statics = new Map<Detail, Static>();
function crystalStatic(d: Detail): Static {
  const hit = statics.get(d);
  if (hit) return hit;
  const B = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, r = 0.15) => { const b = bx(x0, x1, y0, y1, z0, z1, r); return translate(b.geo, ...b.at); };
  const s: Static = {
    pkg: B(-16, 16, 0, 2, -7.5, 7.5, 0.4),
    walls: merge([B(-16, 16, 2, 8, -7.5, -6), B(-16, 16, 2, 8, 6, 7.5), B(-16, -14.5, 2, 8, -6, 6), B(14.5, 16, 2, 8, -6, 6)], 'walls'),
    pads: merge([B(-14.5, -9.5, 2, 2.3, -4.6, -0.4, 0.05), B(-14.5, -9.5, 2, 2.3, 0.4, 4.6, 0.05)], 'inner pads'),
    under: merge([B(-16, -11.5, -0.25, 0, -4.5, 4.5, 0.05), B(11.5, 16, -0.25, 0, -4.5, 4.5, 0.05)], 'underside pads'),
    glue: merge([-2.5, 2.5].map((z) => { const g = sphere(1, d === 'full' ? 20 : 8, d === 'full' ? 10 : 5), m = new Float32Array(16); m[0] = 0.9; m[5] = 0.55; m[10] = 1.4; m[15] = 1; m[12] = BX0 + 1.15; m[13] = 2.6; m[14] = z; return transform(g, m); }), 'glue'),
    base: B(BX0, f.x0 + 0.02, f.y0, Y1, -ZO, ZO, 0.05),
    traces: merge([B(BX0 + 0.3, f.x0, Y1, Y1 + FILM, -2.9, -1.1, 0.02), B(BX0 + 0.3, f.x0, Y1, Y1 + FILM, 1.1, 2.9, 0.02)], 'traces'),
    lid: B(-16, 16, 8, 8.6, -7.5, 7.5, 0.2),
  };
  statics.set(d, s);
  return s;
}

/** The fork in its package; `key` keeps each fork's tines apart, `dx, dz` place it, `lid` false leaves the lid off. */
function crystalItems(key: string, disp: number, detail: Detail, dx = 0, dz = 0, lid = true): Item[] {
  const S = crystalStatic(detail), o: Vec3 = [dx, 0, dz], mag = Math.min(1, Math.abs(disp)), v = Math.sign(disp) || 1;
  const grp = { group: 'package', at: o };
  const items: Item[] = [
    { geo: S.pkg, mat: ceramic, name: 'ceramic package', ...grp, info: { dim: '3.2 × 1.5 × 0.8 mm', source: SRC.fc135, note: 'a cavity in alumina, sealed in vacuum: air would damp the fork to a Q of a few thousand' } },
    { geo: S.walls, mat: ceramic, name: 'ceramic package', ...grp },
    { geo: S.under, mat: tin, name: 'underside pads', ...grp, info: { note: 'the two terminals the board is soldered to, joined to the inner pads through the ceramic' } },
    { geo: S.pads, mat: M.gold, name: 'gold pads', ...grp },
    { geo: S.glue, mat: glue, name: 'conductive glue', ...grp, info: { note: 'holds the fork by its base and connects its two electrodes to the pads: the tines hang free' } },
    { geo: S.base, mat: quartzMat, name: 'quartz base', group: 'fork', at: o, info: { dim: `${(fork.base / 10).toFixed(2)} × ${(2 * ZO / 10).toFixed(2)} × ${WAFER_T} mm`, source: SRC.patent, note: 'one piece with the tines, etched from a quartz wafer' } },
    { geo: S.traces, mat: M.gold, name: 'electrode traces', group: 'fork', at: o },
  ];
  if (lid) items.push({ geo: S.lid, mat: lidMat, name: 'lid', group: 'package', at: o, info: { note: 'seam-welded on in vacuum; the cut takes it off' } });
  for (const sgn of [1, -1]) {
    const t = tine(`${key}${sgn}|${detail}`, sgn, disp), pol = sgn * v;
    items.push({ geo: t.quartz, mat: quartzMat, name: 'tine', group: 'fork', at: o, info: { dim: `${TINE_L.toFixed(2)} × ${TINE_W} × ${WAFER_T} mm`, source: SRC.beam, note: 'bending in its first mode, the two tines in antiphase so the base stays still and loses no energy into the mount' } });
    items.push({ geo: t.groove, mat: film(pol, mag), name: 'gold electrode in the groove', group: 'fork', at: o, info: { source: SRC.patent, note: 'the groove brings the electrode closer to the opposite face, so the field crosses more of the quartz: a stronger drive for the same voltage' } });
    items.push({ geo: t.side, mat: film(-pol, mag), name: 'gold electrode on the side', group: 'fork', at: o, info: { note: 'the opposite polarity to the groove: the field runs across the tine, one half stretches, the other shrinks, and it bends' } });
  }
  return items;
}

// ---------------------------------------------------------------- the board, 1 unit = 1 mm

const flat = (pts: [number, number][], y = 0.035): Geo => sweep(pts.map(([x, z]) => [x, y, z] as Vec3), rect(-0.035, 0.035, -0.2, 0.2), { bend: 0.4 });
interface BoardGeos { pcb: Geo; nets: Geo; pads: Geo; led: Geo; ledBig: Geo }
const boardMemo = new Map<Detail, BoardGeos>();
function boardGeos(d: Detail): BoardGeos {
  const hit = boardMemo.get(d);
  if (hit) return hit;
  const nets: [number, number][][] = [
    [[-6, -7], [-1.6, -7]], [[1.6, -7], [6, -7]],
    [[-3, -12.5], [-6, -12.5], [-6, -7]], [[3, -12.5], [3.6, -12.5]], [[5.4, -12.5], [6, -12.5], [6, -7]],
    [[-6, -7], [-6, -3], [-2.6, -3]], [[6, -7], [6, -3], [2.6, -3]],
    [[-6, -7], [-6, -5], [-10.9, -5]], [[6, -7], [6, -5], [10.9, -5]], [[-9.1, -5], [-13, -5], [-13, -1]], [[9.1, -5], [13, -5], [13, -1]],
    [[6, -12.5], [21, -12.5], [21, CHAIN_Z]],
    ...Array.from({ length: STAGES - 1 }, (_, i) => [[chainX(i + 1) + 1.1, CHAIN_Z], [chainX(i) - 1.1, CHAIN_Z]] as [number, number][]),
  ];
  const seg = d === 'full' ? 24 : 8, dome = (r: number, hh: number) => lathe([[0, 0], [r, 0], [r, hh * 0.55], ...Array.from({ length: 6 }, (_, k) => { const a = ((k + 1) / 6) * (Math.PI / 2); return [r * Math.cos(a), hh * 0.55 + hh * 0.45 * Math.sin(a)] as [number, number]; })], { seg });
  const g: BoardGeos = {
    pcb: roundedBox(48, 1.2, 28, 0.3, 2),
    nets: merge(nets.map((n) => flat(n)), 'traces'),
    pads: merge([-13, 13].map((x) => { const b = bx(x - 0.7, x + 0.7, 0, 0.07, -1.4, -0.6, 0.02); return translate(b.geo, ...b.at); }), 'ground pads'),
    led: dome(0.55, 0.9),
    ledBig: dome(0.95, 1.4),
  };
  boardMemo.set(d, g);
  return g;
}
/** A two-terminal SMD part from x0 to x1 along x (or z), centred on c: a body and two tinned ends. */
function smd(name: string, body: Material, c: [number, number], len: number, wid: number, hh: number, alongZ: boolean, info?: Item['info']): Item[] {
  const e = Math.min(0.4, len * 0.2), half = len / 2;
  const span = (a: number, b: number, y1: number) => alongZ ? bx(c[0] - wid / 2, c[0] + wid / 2, 0, y1, c[1] + a, c[1] + b, 0.08) : bx(c[0] + a, c[0] + b, 0, y1, c[1] - wid / 2, c[1] + wid / 2, 0.08);
  return [at(span(-half + e, half - e, hh), body, name, { group: 'parts', info }), at(span(-half, -half + e, hh + 0.02), tin, name, { group: 'parts' }), at(span(half - e, half, hh + 0.02), tin, name, { group: 'parts' })];
}
function boardItems(st: QuartzState, detail: Detail): Item[] {
  const G = boardGeos(detail), vib = Math.min(1, Math.abs(st.disp));
  const items: Item[] = [
    { geo: G.pcb, mat: mask, at: [0, -0.6, -3], name: 'board', group: 'board', info: { note: 'the board is drawn; the oscillator is usually inside the microcontroller with only the crystal and two capacitors outside' } },
    { geo: G.nets, mat: trace, name: 'copper trace', group: 'board' },
    { geo: G.pads, mat: tin, name: 'ground pad', group: 'board' },
    at(bx(-1.6, 1.6, 0, 0.75, -7.75, -6.25, 0.1), ceramic, 'quartz fork 32 768 Hz', { group: 'crystal', info: { dim: '3.2 × 1.5 × 0.8 mm', source: SRC.fc135, note: 'the package of the Crystal view, at its real size beside the others' } }),
    at(bx(-1.5, 1.5, 0.75, 0.82, -7.65, -6.35, 0.05), vib > 0.05 ? M.glow(lidMat, '--qz-plus', 0.3 * vib) : lidMat, 'quartz fork 32 768 Hz', { group: 'crystal' }),
    at(bx(-1.9, -1.3, 0, 0.12, -7.6, -6.4, 0.03), tin, 'quartz fork 32 768 Hz', { group: 'crystal' }),
    at(bx(1.3, 1.9, 0, 0.12, -7.6, -6.4, 0.03), tin, 'quartz fork 32 768 Hz', { group: 'crystal' }),
    at(bx(-3, 3, 0, 1.1, -14, -11, 0.15), epoxy, 'inverter', { group: 'parts', info: { note: 'an unbuffered CMOS inverter: a gain of a few tens, enough to make up what the fork loses each cycle; in a watch or an MCU it is on the chip' } }),
    ...smd('Rd', resBody, [4.5, -12.5], 2, 1.25, 0.5, false, { note: 'in series with the inverter\'s output: with C2 it limits the drive level (about 0.1 µW) and rolls off the harmonics' }),
    ...smd('Rf 10 MΩ', resBody, [0, -3], 4.2, 1.6, 0.6, false, { source: SRC.tn31, note: 'across the inverter: biases it in its linear region, where it amplifies' }),
    ...smd('C1 15 pF', capBody, [-10, -5], 1.8, 1.25, 0.9, false, { source: SRC.tn31, note: 'from the input node to ground; with C2 and the stray it is the load the crystal was calibrated for' }),
    ...smd('C2 15 pF', capBody, [10, -5], 1.8, 1.25, 0.9, false, { source: SRC.tn31, note: 'from the output node to ground' }),
  ];
  for (let i = 0; i < STAGES; i++) {
    const x = chainX(i), on = st.bits[i] === 1, last = i === STAGES - 1, big = last || st.big;
    items.push(at(bx(x - 1.1, x + 1.1, 0, 0.9, CHAIN_Z - 1.3, CHAIN_Z + 1.3, 0.12), epoxy, `÷2 stage ${i + 1}`, { group: 'divider', info: { note: `a toggle flip-flop: ${i ? `clocked by stage ${i}` : 'clocked by the oscillator'}, it changes once for every two of its clock's cycles` } }));
    items.push({ geo: big ? G.ledBig : G.led, mat: on ? M.glow(ledOff, '--qz-led', last ? 1.4 : 0.9) : ledOff, at: [x, 0.9, CHAIN_Z], name: `÷2 stage ${i + 1}`, group: 'divider' });
  }
  return items;
}

// ---------------------------------------------------------------- the phase ring

interface RingGeos { disc: Geo; stud: Geo; edge: Geo; a: Geo; b: Geo; hand: Geo; lim: Geo }
const ringMemo = new Map<Detail, RingGeos>();
function ringGeos(d: Detail): RingGeos {
  const hit = ringMemo.get(d);
  if (hit) return hit;
  const seg = d === 'full' ? 64 : 16;
  const g: RingGeos = {
    disc: lathe([[0, 0], [DRIFT_R + 1.4, 0], [DRIFT_R + 1.4, 0.4], [0, 0.4]], { seg }),
    stud: cyl(0.28, 0.3, 12),
    edge: cyl(1.3, 1.4, 24), a: cyl(1.3, 1.4, 24), b: cyl(1.0, 2.0, 24),
    hand: tube([[0, 0, 0], [0, 0, -(DRIFT_R - 1.6)]], 0.14, { sides: 6 }),
    lim: tube([[0, 0, -(DRIFT_R - 3.2)], [0, 0, -(DRIFT_R + 1)]], 0.2, { sides: 6 }),
  };
  ringMemo.set(d, g);
  return g;
}
function driftItems(st: QuartzState, detail: Detail): Item[] {
  const G = ringGeos(detail), hit = inWindow(st.slip), y = 0.4;
  const items: Item[] = [
    ...crystalItems('A', st.disp, detail, DRIFT_AX, DRIFT_Z, false).map((i) => ({ ...i, group: 'crystal A' })),
    ...crystalItems('B', st.dispB, detail, DRIFT_BX, DRIFT_Z, false).map((i) => ({ ...i, group: 'crystal B' })),
    { geo: G.disc, mat: ringMat, at: [DRIFT_C[0], 0, DRIFT_C[1]], name: 'phase ring', group: 'ring', info: { note: 'a diagram: B\'s edge drawn at the phase it has gained on A, one turn per cycle of slip' } },
  ];
  for (let k = 0; k < 12; k++) { const [x, z] = onRing(DRIFT_R + 0.4, k / 12); items.push({ geo: G.stud, mat: trace, at: [x, y, z], name: 'phase ring', group: 'ring' }); }
  for (const t of [-WINDOW_FRAC, WINDOW_FRAC]) items.push({ geo: G.lim, mat: M.glow(ringMat, '--qz-minus', 0.4), at: [DRIFT_C[0], y + 0.2, DRIFT_C[1]], rot: quatAxisAngle([0, 1, 0], -2 * Math.PI * t), name: 'setup + hold window', group: 'ring', info: { note: 'drawn wide: B\'s edge landing here would break A\'s setup or hold time' } });
  const [ax, az] = onRing(DRIFT_R - 1.6, 0), [bx_, bz] = onRing(DRIFT_R - 1.6, st.slip);
  items.push({ geo: G.a, mat: M.glow(M.make({ base: '--qz-plus', metal: 0, rough: 0.3, label: 'A\'s edge' }), '--qz-plus', 0.5), at: [ax, y, az], name: "A's edge", group: 'ring' });
  items.push({ geo: G.b, mat: M.glow(M.make({ base: '--qz-minus', metal: 0, rough: 0.3, label: 'B\'s edge' }), '--qz-minus', hit ? 0.9 : 0.35), at: [bx_, y, bz], name: "B's edge", group: 'ring' });
  items.push({ geo: G.hand, mat: M.make({ base: '--qz-minus', metal: 0, rough: 0.4, label: 'B\'s phase' }), at: [DRIFT_C[0], y + 0.3, DRIFT_C[1]], rot: quatAxisAngle([0, 1, 0], -2 * Math.PI * st.slip), name: "B's edge", group: 'ring' });
  return items;
}

// ---------------------------------------------------------------- the AT-cut blank

const R_AT = (AT_BLANK_MM * 10) / 2, RE_AT = (AT_ELEC_MM * 10) / 2, H_AT = AT_T_DRAWN / AT_LAYERS;
const atDx = (s: number, disp: number) => disp * AT_SHEAR * shearAt(s);
interface AtGeos { layer: Geo; elec: Geo; tabTop: Geo; tabBot: Geo; clip: Geo; lead: Geo; base: Geo }
const atMemo = new Map<Detail, AtGeos>();
function atGeos(d: Detail): AtGeos {
  const hit = atMemo.get(d);
  if (hit) return hit;
  const seg = d === 'full' ? 72 : 20, B = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, r: number) => { const b = bx(x0, x1, y0, y1, z0, z1, r); return translate(b.geo, ...b.at); };
  const g: AtGeos = {
    layer: lathe([[0, 0], [R_AT, 0], [R_AT, H_AT], [0, H_AT]], { seg }),
    elec: lathe([[0, 0], [RE_AT, 0], [RE_AT, 0.15], [0, 0.15]], { seg }),
    tabTop: B(RE_AT - 1, R_AT, 0, 0.15, -2, 2, 0.05),
    tabBot: B(-R_AT, -RE_AT + 1, 0, 0.15, -2, 2, 0.05),
    clip: merge([1, -1].map((s) => B(s * R_AT - 1.5, s * R_AT + 1.5, -2, AT_T_DRAWN + 2, -2.5, 2.5, 0.5)), 'clips'),
    lead: merge([1, -1].map((s) => tube([[s * (R_AT + 1), -2, 0], [s * (R_AT + 1), -30, 0]], 0.6, { sides: 10 })), 'leads'),
    base: B(-R_AT - 8, R_AT + 8, -33, -30, -8, 8, 0.6),
  };
  atMemo.set(d, g);
  return g;
}
function atItems(st: QuartzState, detail: Detail): Item[] {
  const G = atGeos(detail), top = AT_T_DRAWN, d = st.disp;
  const items: Item[] = [];
  for (let i = 0; i < AT_LAYERS; i++) items.push({ geo: G.layer, mat: quartzMat, at: [atDx((i + 0.5) / AT_LAYERS - 0.5, d), i * H_AT, 0], name: 'quartz blank, AT-cut', group: 'blank', info: i ? undefined : { dim: `${AT_BLANK_MM} mm across, ${atThicknessMm(AT_F).toFixed(3)} mm thick for ${AT_F / 1e6} MHz (drawn ${Math.round(AT_T_DRAWN / 10 / atThicknessMm(AT_F))}× thicker)`, source: SRC.cts, note: 'drawn as layers so the shear shows: the faces slide opposite ways, the middle plane stays' } });
  items.push({ geo: G.elec, mat: M.gold, at: [atDx(0.5, d), top, 0], name: 'gold electrode', group: 'blank', info: { dim: `${AT_ELEC_MM} mm across (illustrative)`, note: 'one on each face: the field across the thickness drives the shear' } });
  items.push({ geo: G.elec, mat: M.gold, at: [atDx(-0.5, d), -0.15, 0], name: 'gold electrode', group: 'blank' });
  items.push({ geo: G.tabTop, mat: M.gold, at: [atDx(0.5, d), top, 0], name: 'gold electrode', group: 'blank' });
  items.push({ geo: G.tabBot, mat: M.gold, at: [atDx(-0.5, d), -0.15, 0], name: 'gold electrode', group: 'blank' });
  items.push({ geo: G.clip, mat: M.nickel, name: 'spring clip', group: 'mount', info: { note: 'holds the blank at its rim, where the shear barely moves it' } });
  items.push({ geo: G.lead, mat: tin, name: 'lead', group: 'mount' });
  items.push({ geo: G.base, mat: M.make({ base: [0.3, 0.32, 0.36], metal: 0.6, rough: 0.4, label: 'metal base with glass seals' }), name: 'base', group: 'mount', info: { note: 'an HC-49-style holder; the can over it is left off' } });
  return items;
}

// ---------------------------------------------------------------- views, labels, tours

const up: Vec3 = [0, 1, 0];
export const QZ_HOME: Record<QuartzView, OrbitView> = {
  crystal: { target: [-1.2, 3, 0.3], yaw: 0.3, pitch: 0.92, dist: 38 },
  loop: { target: [1, 0, -3.5], yaw: 0.12, pitch: 1.05, dist: 50 },
  drift: { target: [0, 0, 1], yaw: 0.1, pitch: 1.1, dist: 96 },
  at: { target: [0, -12, 0], yaw: 0.35, pitch: 0.42, dist: 150 },
};
/** The cut takes the package's lid off (crystal view): everything above the fork's top is removed. */
export const LID_CUT = Y1 + 0.5;
const CUT: Model3['cuts'] = { planes: [{ n: [0, 1, 0], d: LID_CUT }], open: [9.5] };

function anchors(st: QuartzState): StudioAnchor[] {
  if (st.view === 'crystal') {
    const tipZ = ZO + st.disp * TIP_DRAWN;
    return [
      { text: 'tine, bending', p: [f.x0 + f.L * 0.85, Y1, tipZ], side: 'r', n: up },
      { text: 'gold in the groove', p: [f.x0 + f.L * 0.4, Y1 - GD + FILM, -ZC], side: 'b', n: up },
      { text: 'quartz base', p: [BX0 + f.base * 0.5, Y1, -2.0], side: 't', n: up },
      { text: 'glue on a gold pad', p: [BX0 + 1.15, 3.1, 2.5], side: 'l', n: up, minor: true },
      { text: 'ceramic package', p: [6, 7, 7.5], side: 't', n: [0, 0.3, 1] },
    ];
  }
  if (st.view === 'loop') return [
    { text: 'quartz fork 32 768 Hz', p: [0, 0.8, -7], side: 't', n: up },
    { text: 'inverter', p: [0, 1.1, -12.5], side: 't', n: up, minor: true },
    { text: 'Rd', p: [4.5, 0.5, -12.5], side: 'r', n: up, minor: true },
    { text: 'Rf 10 MΩ', p: [0, 0.6, -3], side: 'b', n: up },
    { text: 'C1 15 pF', p: [-10, 0.9, -5], side: 'l', n: up, minor: true },
    { text: 'C2 15 pF', p: [10, 0.9, -5], side: 'r', n: up, minor: true },
    { text: '÷2: 16 384 Hz', p: [chainX(0), 1, CHAIN_Z + 1.3], side: 'b', n: up },
    { text: 'stage 8: 128 Hz', p: [chainX(7), 1, CHAIN_Z + 1.3], side: 'b', n: up, minor: true },
    { text: '1 Hz output', p: [chainX(STAGES - 1), 2, CHAIN_Z + 1.3], side: 'b', n: up },
  ];
  if (st.view === 'drift') {
    const [ax, az] = onRing(DRIFT_R - 1.6, 0), [bx_, bz] = onRing(DRIFT_R - 1.6, st.slip), [wx, wz] = onRing(DRIFT_R + 1, WINDOW_FRAC);
    return [
      { text: 'A: the receiver', p: [DRIFT_AX, 6, DRIFT_Z + 7.5], side: 'l', n: [0, 0.3, 1], minor: st.big },
      { text: 'B: the sender', p: [DRIFT_BX, 6, DRIFT_Z + 7.5], side: 'r', n: [0, 0.3, 1], minor: st.big },
      { text: "A's edge", p: [ax, 1.8, az], side: 'l', n: up },
      { text: "B's edge", p: [bx_, 2.4, bz], side: 'b', n: up },
      { text: 'setup + hold window', p: [wx, 0.8, wz], side: 'r', n: up, minor: true },
    ];
  }
  return [
    { text: 'quartz blank, AT-cut', p: [-R_AT * 0.62, AT_T_DRAWN, R_AT * 0.55], side: 'l', n: up },
    { text: 'gold electrode', p: [RE_AT * 0.3, AT_T_DRAWN + 0.15, -RE_AT * 0.75], side: 't', n: up },
    { text: 'faces shear opposite ways', p: [R_AT * 0.5, AT_T_DRAWN / 2, R_AT * 0.866], side: 'b', n: [0.5, 0, 0.866], minor: true },
    { text: 'spring clip', p: [-R_AT, AT_T_DRAWN + 2, 0], side: 'l', n: [-1, 0, 0], minor: true },
  ];
}

function beats(view: QuartzView): Beat[] {
  const H = QZ_HOME[view];
  if (view === 'crystal') return [
    { title: 'The package', text: 'A 3.2 × 1.5 mm ceramic box, sealed in vacuum under a welded lid, two pads underneath. Air would damp the fork: in vacuum its Q is about 50 000, so it rings for tens of thousands of cycles after a single push.', view: H, frame: ['package'], cut: 0, explode: 0 },
    { title: 'A tuning fork', text: `Lid off: a fork etched from a quartz wafer ${WAFER_T} mm thick, held by its base in two drops of conductive glue. The tines are ${TINE_L.toFixed(2)} mm long: the length beam theory gives for ${32768} Hz at 0.1 mm wide.`, view: { ...H, pitch: 1.05 }, frame: ['fork'], cut: 1, explode: 0 },
    { title: 'Bending in antiphase', text: 'The tines bend toward and away from each other, the first mode of a cantilever: still at the root, the most at the tip. Moving opposite ways, they push nothing into the base, so the mount takes almost none of their energy.', view: { target: [f.x0 + f.L * 0.6, Y1, 0], yaw: 0.05, pitch: 1.35, dist: 18 }, frame: ['tine'], cut: 1, explode: 0 },
    { title: 'Gold in the grooves', text: 'Each tine has a groove down both faces, gilded, and gold on both sides in the other polarity. The field runs across the tine: one half stretches, the other shrinks, and quartz being piezoelectric, the tine bends. Bending back, it makes the voltage that the inverter amplifies.', view: { target: [f.x0 + f.L * 0.45, Y1, -ZC], yaw: 0.6, pitch: 0.55, dist: 9 }, frame: ['gold electrode in the groove'], cut: 1, explode: 0 },
  ];
  if (view === 'loop') return [
    { title: 'A Pierce oscillator', text: 'The crystal between the inverter\'s input and output, a 10 MΩ resistor across them to bias it, a capacitor from each side to ground. The inverter gives 180° and the crystal with its capacitors the other 180°, only at the frequency where the fork is in tune.', view: H, frame: ['crystal', 'parts'], cut: 0, explode: 0 },
    { title: 'The load capacitance', text: 'C1 and C2 in series, plus the board\'s stray, are the load the crystal was cut for: 9 pF here. A different load pulls the frequency by a few ppm, which is how a watch is trimmed.', view: { target: [0, 0, -6], yaw: 0.1, pitch: 1.0, dist: 28 }, frame: ['crystal', 'C1 15 pF', 'C2 15 pF'], cut: 0, explode: 0 },
    { title: 'Fifteen halvings', text: 'Each toggle stage changes once for two changes of the one before: 32 768 Hz, 16 384, … and after fifteen, exactly 1 Hz, the second hand\'s step.', view: { target: [0, 0, CHAIN_Z], yaw: 0.1, pitch: 0.9, dist: 40 }, frame: ['divider'], cut: 0, explode: 0 },
  ];
  if (view === 'drift') return [
    { title: 'Two clocks', text: 'Two crystals, each with its own error: a few ppm of tolerance, and a temperature curve. A receiver clocked by A sees data sent on B\'s clock.', view: H, frame: ['crystal A', 'crystal B'], cut: 0, explode: 0 },
    { title: 'The phase walks', text: 'The ring turns at the difference of the two frequencies: once per cycle of slip. Sooner or later B\'s edge lands inside A\'s setup and hold window, whatever the two ppm are: that is why a receiver resynchronizes, or crosses with a synchronizer.', view: { target: [0, 0, DRIFT_C[1]], yaw: 0.05, pitch: 1.3, dist: 44 }, frame: ['ring'], cut: 0, explode: 0 },
  ];
  return [
    { title: 'An AT-cut blank', text: `A disc of quartz cut at about 35° to the crystal's optical axis, a gold electrode on each face. ${AT_F / 1e6} MHz needs it ${atThicknessMm(AT_F).toFixed(3)} mm thick: f is about 1.67 MHz·mm over the thickness.`, view: H, frame: ['blank', 'mount'], cut: 0, explode: 0 },
    { title: 'Thickness shear', text: 'The faces slide opposite ways and the middle plane stays: a shear across the thickness, drawn here much thicker and swinging far more than any real blank. The cut angle flattens the temperature curve into a gentle cubic.', view: { target: [0, AT_T_DRAWN / 2, 0], yaw: 0.02, pitch: 0.12, dist: 70 }, frame: ['blank'], cut: 0, explode: 0 },
  ];
}

/** The scene for the view in `st`, at a detail ('flat': the SVG fallback). */
export function quartzModel(st: QuartzState, detail: Detail = 'full'): Model3 {
  const items = st.view === 'crystal' ? crystalItems('main', st.disp, detail) : st.view === 'loop' ? boardItems(st, detail) : st.view === 'drift' ? driftItems(st, detail) : atItems(st, detail);
  return {
    items,
    cuts: st.view === 'crystal' ? CUT : undefined,
    anchors: anchors(st),
    beats: beats(st.view),
    floor: st.view === 'at' ? -33 : st.view === 'loop' ? -1.2 : -0.3,
  };
}
