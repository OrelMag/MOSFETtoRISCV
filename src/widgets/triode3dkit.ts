// The 6SN7 as a studio model (DOM-free, the prototype for the 3D state-of-the-art pass): the same tube as
// triode3dview.ts, at the same size and on the same physics (phys/triode.ts through TubeState), but in true geometry:
// a lathed T-9 bulb with a glass wall of real thickness, a hollow octal base with its pins and bent stem leads, each
// plate as two bent nickel sheets crimped at their flanges, the grid as one helix of wire round its side rods, the
// cathode as a hollow oval sleeve over a folded, coiled heater, micas, the getter and its barium mirror. A quarter
// section cuts the near section and the front of the bulb; the electrode stack explodes along its axis; every named
// part has a dimension and where it comes from.

import { bentSheet, extrude, helix, lathe, roundedBox, sphere, tube, type Geo } from '../gl/kit/geo';
import { M, heatColour, heatGlow, type Material } from '../gl/kit/materials';
import { onCylinder, strokeGeo } from '../gl/kit/text';
import type { Beat, Item, Model3, StudioAnchor } from '../gl/kit/scene';
import type { Vec3 } from '../gl/math';
import { B_PLUS, R_PLATE } from '../phys/triode';
import { pinPos, PIN_ROLES, returned, stream, type TubeState } from './triode3dview';

// ---------------------------------------------------------------- dimensions (mm), as triode3dview.ts
// Outline from the 6SN7GT data (T-9 bulb, 28.6 mm; octal base, pins on a 17.45 mm circle, 2.36 mm pins, the 7.9 mm
// key post); the electrode sizes inside are illustrative, drawn from photographs (no maker's drawing of the mount).
export const XA = -6.6, XB = 6.6;
const Y0 = 30, Y1 = 52;
const CX = 1.1, CZ = 0.65;
const GX = 2.2, GZ = 1.35, PITCH = 0.6, WIRE_D = 0.14;
const PX = 5, PZ = 3, PT = 0.25, EAR = 1.3;
const MICA_LO = 29.6, MICA_HI = 52.4;
const GLASS_R = 14.3, GLASS_T = 0.9, GLASS_Y0 = 12, GLASS_Y1 = 62, DOME_H = 8;
const BASE_R = 14.8, BASE_H = 13;
const PIN_D = 2.36, PIN_L = 9.2, KEY_D = 7.9, KEY_L = 12.5;
const HEATER_LEAD = 150;
/** The most a hot surface emits of its own (linear): orange stays orange through ACES. */
const SURFACE_GLOW = 1.1;

const SRC = {
  sheet: 'Tung-Sol 6SN7GTB data sheet: T-9 bulb, intermediate octal base',
  octal: 'JEDEC octal base (B8-58): pins on a 0.687 in (17.45 mm) circle, 0.093 in (2.36 mm) pins',
  photo: 'illustrative: proportions from photographs of a 6SN7GT mount (no maker\'s drawing found)',
  model: 'computed by phys/triode.ts',
};

type Detail = 'full' | 'flat';

// ---------------------------------------------------------------- geometry, built once per detail

interface Geos {
  base: Geo; cement: Geo; key: Geo; keyRib: Geo; pin: Geo; glass: Geo; getterFlash: Geo; flare: Geo; press: Geo;
  leads: Geo[]; mica: Geo; plateBack: (xs: number) => Geo; plateFront: (xs: number) => Geo; rib: Geo;
  rod: (y0: number, y1: number, r: number) => Geo; grid: (xs: number) => Geo; sleeve: Geo; heater: (xs: number) => Geo;
  getterCup: Geo; electron: Geo; cloud: Geo; print: Geo;
}

const memo = new Map<Detail, Geos>();
const memoFn = <A extends number[]>(fn: (...a: A) => Geo) => { const m = new Map<string, Geo>(); return (...a: A): Geo => { const key = a.join(','); let v = m.get(key); if (!v) { v = fn(...a); m.set(key, v); } return v; }; };

function geos(d: Detail): Geos {
  const hit = memo.get(d);
  if (hit) return hit;
  const full = d === 'full', seg = full ? 72 : 16, small = full ? 20 : 8;
  // The bulb: a wall GLASS_T thick, walked up its outside and down its inside; it flares into the base below.
  const dome = (r: number, h: number, y: number, n: number): [number, number][] =>
    Array.from({ length: n + 1 }, (_, i) => { const a = (i / n) * (Math.PI / 2); return [Math.max(0, r * Math.cos(a)), y + h * Math.sin(a)] as [number, number]; });
  const ri = GLASS_R - GLASS_T;
  const glassProf: [number, number][] = [
    [13.2, 8], [14.0, 8], [GLASS_R, GLASS_Y0], [GLASS_R, GLASS_Y1], ...dome(GLASS_R, DOME_H, GLASS_Y1, full ? 16 : 5).slice(1),
    ...dome(ri, DOME_H - GLASS_T, GLASS_Y1, full ? 16 : 5).reverse().slice(0, -1), [ri, GLASS_Y1], [ri, GLASS_Y0 + 0.4], [13.2 - 0.3, 8.6], [13.2, 8],
  ];
  // The getter's mirror: a film on the inside of the dome and a little way down the wall.
  const gf = ri - 0.05;
  const flashProf: [number, number][] = [[gf, 57], [gf, GLASS_Y1], ...dome(gf, DOME_H - GLASS_T - 0.05, GLASS_Y1, full ? 14 : 4).slice(1),
    ...dome(gf - 0.08, DOME_H - GLASS_T - 0.13, GLASS_Y1, full ? 14 : 4).reverse().slice(0, -1), [gf - 0.08, GLASS_Y1], [gf - 0.08, 57], [gf, 57]];
  // The octal base: a bakelite shell 1.2 mm thick with a 2 mm floor, a bevel below, the rim above.
  const baseProf: [number, number][] = [[0, 0], [7.2, 0], [BASE_R - 0.8, 0], [BASE_R, 0.8], [BASE_R, BASE_H - 1.2], [BASE_R + 0.3, BASE_H - 1], [BASE_R + 0.3, BASE_H],
    [BASE_R - 1.2, BASE_H], [BASE_R - 1.2, 2], [0, 2]];
  // A pin: a nickel-plated brass tube with its end closed by solder, a dome.
  const pinProf: [number, number][] = [[0, -PIN_L - 0.35], [0.55, -PIN_L - 0.3], [0.95, -PIN_L - 0.08], [PIN_D / 2, -PIN_L + 0.3], [PIN_D / 2, 2.2], [0, 2.2]];
  const keyProf: [number, number][] = [[0, -KEY_L], [KEY_D / 2 - 0.6, -KEY_L], [KEY_D / 2, -KEY_L + 0.6], [KEY_D / 2, 0.5], [0, 0.5]];
  // The stem: a glass flare from the bulb's foot up into the press the leads are sealed through.
  const flareProf: [number, number][] = [[12.6, 8.6], [12.9, 8.6], [10, 11], [5.5, 13.5], [4.2, 15.2], [3.6, 15.2], [4.6, 13.2], [9.6, 10.8], [12.6, 8.6]];
  // Leads: each pin's wire up through the base, bent in to its place in the press, up to the press top.
  const leadTo = (k: number): number => {
    const role = PIN_ROLES[k - 1], sec = role.endsWith('1') ? XA : XB;
    return role[0] === 'h' ? (k === 7 ? -0.9 : 0.9) : role[0] === 'g' ? sec - GX : role[0] === 'p' ? sec - (PX + PT + 0.6) : sec + 0.8;
  };
  const leads = Array.from({ length: 8 }, (_, i) => {
    const [x, z] = pinPos(i + 1), tx = leadTo(i + 1);
    return tube([[x, 1.5, z], [x, 9.5, z], [tx * 0.8, 13.5, z * 0.15], [tx, 16, 0], [tx, 22.4, 0]], 0.28, { bend: full ? 1.6 : 0, sides: full ? 10 : 6 });
  });
  // A mica: an oval spacer that springs against the glass; holes for the electrodes are left out (the renderer has
  // no holes yet).
  const micaOutline: [number, number][] = Array.from({ length: full ? 64 : 20 }, (_, i) => {
    const a = (i / (full ? 64 : 20)) * 2 * Math.PI;
    return [13.4 * Math.cos(a), 7.2 * Math.sin(a)];
  });
  // A plate half: flange, side, back, side, flange, one bent sheet, crimped face to face with its twin at z = 0.
  const half = (xs: number, s: number) => bentSheet([
    [xs - PX - PT - EAR, s * PT / 2], [xs - PX - PT / 2, s * PT / 2], [xs - PX - PT / 2, s * (PZ + PT / 2)],
    [xs + PX + PT / 2, s * (PZ + PT / 2)], [xs + PX + PT / 2, s * PT / 2], [xs + PX + PT + EAR, s * PT / 2]], PT, Y1 - Y0);
  // The heater: a tungsten wire coated with alumina, coiled, folded into a hairpin inside the sleeve.
  const heater = (xs: number) => {
    const up = helix({ r: 0.2, pitch: 0.42, from: 23.2, to: 51.4, at: [xs - 0.42, 0], perTurn: full ? 8 : 4 });
    const down = helix({ r: 0.2, pitch: 0.42, from: 23.2, to: 51.4, at: [xs + 0.42, 0], perTurn: full ? 8 : 4, phase: Math.PI }).reverse();
    return tube([[xs - 0.42 + 0.2, 21.8, 0], ...up, [xs, 52.1, 0], ...down, [xs + 0.42 - 0.2, 21.8, 0]], 0.085, { sides: 4 }); // 4 facets: the wire is under a pixel wide but in a close-up
  };
  // The cathode: a hollow nickel sleeve under its oxide coat, round here and made oval by the item's scale.
  const sleeveProf: [number, number][] = [[0.44, 27.5], [0.5, 27.5], [0.5, 54], [0.44, 54], [0.44, 27.5]];
  const g: Geos = {
    // the cement filling the base round the bulb's foot, up to just under the rim
    cement: lathe([[0, 2], [BASE_R - 1.2, 2], [BASE_R - 1.2, BASE_H - 0.6], [14.1, BASE_H - 0.6], [13.4, 8.2], [0, 8.2]], { seg }),
    base: lathe(baseProf, { seg }), key: lathe(keyProf, { seg: small * 2 }), keyRib: roundedBox(1.6, KEY_L - 0.5, 1.4, 0.3, full ? 2 : 1),
    pin: lathe(pinProf, { seg: small }), glass: lathe(glassProf, { seg, crease: 50 }), getterFlash: lathe(flashProf, { seg }),
    flare: lathe(flareProf, { seg }), press: roundedBox(15, 8.2, 3.6, 1.2, full ? 3 : 1), leads,
    mica: extrude(micaOutline, 0.3),
    plateBack: memoFn((xs: number) => half(xs, -1)), plateFront: memoFn((xs: number) => half(xs, 1)),
    rib: roundedBox(0.5, Y1 - Y0 - 1, 0.35, 0.15, 1),
    rod: memoFn((y0: number, y1: number, r: number) => lathe([[0, y0], [r, y0], [r, y1], [0, y1]], { seg: small })),
    grid: memoFn((xs: number) => tube(helix({ rx: GX, rz: GZ, pitch: PITCH, from: Y0 + 0.3, to: Y1, at: [xs, 0], perTurn: full ? 28 : 8 }), WIRE_D / 2, { sides: full ? 6 : 4 })),
    sleeve: lathe(sleeveProf, { seg: full ? 40 : 10, crease: 60 }),
    heater: memoFn(heater),
    getterCup: lathe([[0, 58], [2.2, 58], [2.8, 58.6], [2.9, 59.4], [2.6, 59.4], [2.4, 58.5], [0, 58.4]], { seg: small * 2 }),
    // the type number printed on the glass (silk-screened white), facing the home view
    print: strokeGeo('6SN7GT', onCylinder(GLASS_R, -0.5), 0, 20.5, 2.2, 0.14, 0.03, { flat: true }),
    electron: sphere(0.15, 8, 5), cloud: lathe([[0, 30.6], [0.85, 30.6], [0.95, 31.4], [0.95, 44], [0.85, 44.6], [0, 44.6]], { seg: full ? 32 : 8 }),
  };
  memo.set(d, g);
  return g;
}

// ---------------------------------------------------------------- the model at a state

export interface TubeLook { charge: boolean; detail: Detail; electron: Material }

const T = (x: number) => x.toFixed(x < 10 ? 2 : 1).replace(/\.?0+$/, '');

/** The tube at state st: every item, the cut, the labels and the tour. */
export function tubeModel(st: TubeState, look: TubeLook): Model3 {
  const G = geos(look.detail), items: Item[] = [];
  // A hot part: its emission is the black body at its temperature; what light it reflects fades as it outshines it. The
  // surface's own emission is held under the tone curve's knee so a coil at 1 173 K reads orange with its turns shaded,
  // not clipped white (white is far hotter): the glow lights and the bloom carry the rest of its brightness.
  const hot = (T0: number, m: Material): Material => {
    const g = heatGlow(T0), k = 1 / (1 + 1.2 * g), b = m.base as [number, number, number];
    const s = Math.min(g, SURFACE_GLOW);
    return { ...M.glow(m, heatColour(T0), s), bloom: s > 0 ? g / s : 1, base: [b[0] * k, b[1] * k, b[2] * k] };
  };
  const brass = M.tint(M.nickel, [0.78, 0.72, 0.6], 'nickel-plated brass');
  const moly = M.make({ base: [0.8, 0.8, 0.82], metal: 1, rough: 0.28, label: 'molybdenum wire' });
  const plateMat = M.make({ base: [0.46, 0.46, 0.47], metal: 0.6, rough: 0.42, label: 'nickel, carbonized (dark satin grey)' });
  const mica = { ...M.mica, base: [0.92, 0.9, 0.84] as [number, number, number], transmit: 0.62, tint: [0.96, 0.94, 0.88] as [number, number, number] };

  // Base, key, pins, leads.
  items.push({ geo: G.base, mat: M.bakelite, name: 'octal base', group: 'base', info: { dim: `${T(2 * BASE_R)} mm across, ${BASE_H} mm high`, source: SRC.octal } });
  items.push({ geo: G.cement, mat: M.cement, name: 'basing cement', group: 'base', info: { source: SRC.photo, note: 'glues the bulb into the bakelite shell; the leads run through it to the pins' } });
  items.push({ geo: G.key, mat: M.bakelite, name: 'key post', group: 'base', info: { dim: `${KEY_D} mm across, ${KEY_L} mm long`, source: SRC.octal, note: 'its rib only fits one way: pin 1 is always in the same place' } });
  items.push({ geo: G.keyRib, mat: M.bakelite, at: [0, -KEY_L / 2 + 0.25, -KEY_D / 2 - 0.2], name: 'key post', group: 'base' });
  for (let k = 1; k <= 8; k++) {
    const [x, z] = pinPos(k);
    items.push({ geo: G.pin, mat: brass, at: [x, 0, z], name: `pin ${k} (${PIN_ROLES[k - 1]})`, group: 'pins', info: { dim: `${PIN_D} mm × ${PIN_L} mm`, source: SRC.octal, note: pinNote(PIN_ROLES[k - 1]) } });
    items.push({ geo: G.leads[k - 1], mat: M.nickel, name: 'stem lead', group: 'stem', info: { dim: '0.56 mm wire', source: SRC.photo, note: 'sealed through the glass press; nickel inside, copper-clad (Dumet) where it passes the glass' } });
  }
  // Glass: the stem and press, the bulb, the getter's mirror.
  items.push({ geo: G.flare, mat: M.glass, name: 'glass stem', group: 'stem', info: { source: SRC.photo, note: 'the stem is sealed to the bulb, the air pumped out through it, and the tube tipped off' } });
  items.push({ geo: G.press, mat: { ...M.glass, transmit: 0.75, tint: [0.85, 0.95, 0.9] }, at: [0, 18.6, 0], name: 'glass press', group: 'stem', info: { dim: '15 × 3.6 mm', source: SRC.photo, note: 'the leads are pinched into it while the glass is soft' } });
  // Micas.
  items.push({ geo: G.mica, mat: mica, at: [0, MICA_LO - 0.15, 0], name: 'mica spacer', group: 'mica-lo', info: { dim: '0.3 mm sheet', source: SRC.photo, note: 'holds every electrode at a fixed spacing; its edge springs against the glass' } });
  items.push({ geo: G.mica, mat: mica, at: [0, MICA_HI - 0.15, 0], name: 'mica spacer', group: 'mica-hi', explode: [0, 38, 0] });

  const { e } = stream(st);
  const Th = st.Tc + HEATER_LEAD;
  // The heaters light the inside of their sleeves, the grids and the plates a little: a glow light per section.
  const lights = heatGlow(Th) > 0.02 ? [XA, XB].map((xs) => ({ p: [xs, 41, 0] as Vec3, colour: heatColour(Th), power: 1.6 * heatGlow(Th), range: 3.5, on: 'cathode' })) : [];
  for (const [xs, near] of [[XA, true], [XB, false]] as const) {
    const sec = near ? 'section 1' : 'section 2';
    // Plate: two bent sheets crimped together, two ribs pressed into each, the rods they hang on.
    const plate = plateMat; // at 2.5 W a plate stays far below a visible glow
    const pInfo = { dim: `${2 * PX} × ${2 * PZ} × ${Y1 - Y0} mm, ${PT} mm sheet`, source: SRC.photo, note: `${sec}: at ${st.vp.toFixed(0)} V, ${(st.vp * st.ip).toFixed(2)} W (${B_PLUS} V through ${R_PLATE / 1e3} kΩ)` };
    items.push({ geo: G.plateBack(xs), mat: plate, at: [0, Y0, 0], name: 'plate', group: 'plate', explode: [0, 0, -12], info: pInfo });
    items.push({ geo: G.plateFront(xs), mat: plate, at: [0, Y0, 0], name: 'plate', group: 'plate', explode: [0, 0, 12], info: pInfo });
    for (const s of [-1, 1]) for (const zs of [-1, 1]) items.push({ geo: G.rib, mat: plate, at: [xs + s * 2.6, (Y0 + Y1) / 2, zs * (PZ + PT)], name: 'plate', group: 'plate', explode: [0, 0, 12 * zs] });
    for (const s of [-1, 1]) {
      items.push({ geo: G.rod(22, 55, 0.35), mat: M.nickel, at: [xs + s * (PX + PT + 0.6), 0, 0], name: 'support rod', group: 'rods', info: { dim: '0.7 mm', source: SRC.photo, note: 'carries the plate and holds the mount between the micas' } });
      items.push({ geo: G.rod(24, 54.2, 0.25), mat: M.copper, at: [xs + s * GX, 0, 0], name: 'grid side rod', group: 'grid', explode: [0, 12, 0], info: { dim: '0.5 mm', source: SRC.photo } });
    }
    items.push({ geo: G.grid(xs), mat: moly, name: 'grid', group: 'grid', explode: [0, 12, 0],
      info: { dim: `${2 * GX} × ${2 * GZ} mm oval, ${PITCH} mm pitch; wire drawn ${WIRE_D} mm (thicker than life)`, source: SRC.photo, note: `${sec}: grid at ${st.vg.toFixed(2)} V; cutoff at ${(-B_PLUS / 20).toFixed(1)} V with the full supply` } });
    // Cathode: a hollow oval sleeve under its oxide, glowing at the model's temperature; the heater inside it.
    items.push({ geo: G.sleeve, mat: e > 0 || st.Tc > 650 ? hot(st.Tc, M.cathodeOxide) : M.cathodeOxide, at: [xs, 0, 0], scale: [2 * CX, 1, 2 * CZ], name: 'cathode', group: 'cathode', explode: [0, 26, 0],
      info: { dim: `${2 * CX} × ${2 * CZ} mm oval sleeve`, source: SRC.photo, note: `${sec}: ${Math.round(st.Tc)} K, can emit up to ${amps(st.sat)}, ${(100 * returned(st)).toFixed(1)} % of it falls back (${SRC.model})` } });
    items.push({ geo: G.heater(xs), mat: hot(Th, M.ceramic), name: 'heater', group: 'heater',
      info: { dim: 'coiled hairpin, 6.3 V, 0.3 A per section', source: SRC.sheet, note: `about ${Math.round(Th)} K, a little hotter than its sleeve (drawn, not computed)` } });
    items.push({ geo: G.rod(22, 27.6, 0.15), mat: M.nickel, at: [xs + 0.8, 0, 0.5], name: 'cathode tab', group: 'cathode' });
    if (near && look.charge && e > 0.01) {
      const sheath = e * returned(st);
      items.push({ geo: G.cloud, mat: { ...M.make({ base: '--tb-electron', metal: 0, rough: 0.5, transmit: 0.82 }), emit: '--tb-electron', glow: 0.25 * sheath },
        at: [xs, 0, 0], scale: [2 * CX + 0.2, 1, 2 * CZ + 0.4], group: 'cathode', explode: [0, 26, 0], cut: 'none', shadow: false });
    }
  }
  // Getter: the cup on its wire above the top mica, and the barium mirror it flashed onto the dome.
  items.push({ geo: G.rod(MICA_HI, 58.2, 0.25), mat: M.nickel, name: 'getter', group: 'getter', explode: [0, 52, 0] });
  items.push({ geo: G.getterCup, mat: M.nickel, name: 'getter', group: 'getter', explode: [0, 52, 0], info: { dim: '5.5 mm cup', source: SRC.photo, note: 'barium, flashed by induction heating after pumping: it soaks up the gas the pump left' } });
  items.push({ geo: G.print, mat: M.make({ base: [0.9, 0.9, 0.86], metal: 0, rough: 1, transmit: 0.5, label: 'silk-screened print (thin translucent ink)' }), name: 'type number', group: 'glass', explode: [0, 90, 0], shadow: false, info: { note: 'the tube type, printed on the glass' } });
  items.push({ geo: G.getterFlash, mat: { ...M.getterFlash, base: [0.8, 0.79, 0.76], rough: 0.06, transmit: 0.32, tint: [0.45, 0.43, 0.4], label: 'barium getter film (a mirror)' }, name: 'getter mirror', group: 'glass', explode: [0, 90, 0], cut: 'open', shadow: false, info: { source: SRC.photo, note: 'the silvery film inside the dome: still silver means the vacuum is good; white means air got in' } });
  items.push({ geo: G.glass, mat: M.glass, name: 'glass bulb', group: 'glass', explode: [0, 90, 0], info: { dim: `${T(2 * GLASS_R)} mm (T-9), wall ${GLASS_T} mm`, source: SRC.sheet } });
  return { items, cuts: CUT, anchors: ANCHORS, beats: beats(st), floor: -KEY_L, lights };
}

function amps(a: number): string {
  if (a >= 1) return `${a.toFixed(1)} A`;
  if (a >= 1e-3) return `${(a * 1e3).toFixed(1)} mA`;
  if (a >= 1e-6) return `${(a * 1e6).toFixed(1)} µA`;
  return '< 1 µA';
}
const pinNote = (r: string) => ({ g: `grid of section ${r[1]}`, p: `plate of section ${r[1]}`, k: `cathode of section ${r[1]}`, h: 'heater (6.3 V between pins 7 and 8)' } as Record<string, string>)[r[0]];

/** A quarter section: the front of the near section and the bulb, base and micas in front of it. */
const CUT: Model3['cuts'] = { planes: [{ n: [0, 0, 1], d: 0.02 }, { n: [-1, 0, 0], d: 0 }], open: [18, 0] };

// ---------------------------------------------------------------- labels and tour

const ANCHORS: StudioAnchor[] = [
  { text: 'plate', p: [XA - 3.2, 50.8, -PZ], side: 'l', n: [0, 0, 1], on: 'plate' },
  { text: 'heater', p: [XA - 0.4, 48.5, 0.2], side: 'r', n: [0, 0, 1], on: 'heater' },
  { text: 'grid', p: [XA - GX, 41.5, 0.3], side: 'l', n: [-0.2, 0, 1], on: 'grid' },
  { text: 'cathode', p: [XA - CX * 0.7, 35, CZ * 0.7], side: 'l', n: [-0.3, 0, 1], on: 'cathode' },
  { text: 'other section', p: [XB + 2.5, 41, PZ + PT], side: 'r', n: [0, 0, 1], on: 'plate' },
  { text: 'getter', p: [2.75, 58.6, 0], side: 'r', n: [0.3, 0.5, 1], on: 'getter' },
  { text: 'mica', p: [-12.5, MICA_LO, 2], side: 'l', n: [0, 0.3, 1], minor: true },
  { text: 'glass', p: [GLASS_R * 0.7, 22, GLASS_R * 0.7], side: 'r', n: [0.7, 0, 0.7], minor: true, on: 'glass' },
  { text: 'octal base', p: [BASE_R * 0.7, 6, BASE_R * 0.7], side: 'r', n: [0.7, 0, 0.7] },
  ...Array.from({ length: 8 }, (_, i): StudioAnchor => {
    const [x, z] = pinPos(i + 1);
    return { text: `${i + 1} ${PIN_ROLES[i]}`, p: [x, -PIN_L - 0.8, z], side: 'b', n: [0, -1, 0], under: true };
  }),
];

export const HOME = { target: [-1.5, 28, 0] as Vec3, yaw: -0.5, pitch: 0.26, dist: 150 };

function beats(st: TubeState): Beat[] {
  return [
    { title: 'Life size', text: `A 6SN7GT twin triode: a T-9 bulb ${T(2 * GLASS_R)} mm across on an octal base, two triodes in one envelope. ENIAC used more of these than of any other tube.`, view: HOME, frame: [], cut: 0, explode: 0 },
    { title: 'Cut away', text: 'A quarter of the bulb and the front of the near section are cut away. Inside: a cathode sleeve, a grid of fine wire wound round it, and the plate round both: three electrodes, one inside the next.', view: { target: [-4, 40, 0], yaw: -0.45, pitch: 0.18, dist: 72 }, frame: ['plate', 'mica-hi', 'getter'], cut: 1, explode: 0 },
    { title: 'Heater and cathode', text: `The heater (6.3 V, 0.3 A) keeps the oxide-coated sleeve at ${Math.round(st.Tc)} K. Hot oxide gives off electrons; most fall straight back: ${(100 * returned(st)).toFixed(1)} % here. They wait as a cloud around the sleeve.`, view: { target: [XA, 42, 0], yaw: -0.25, pitch: 0.1, dist: 34 }, show: ['cathode', 'heater'], cut: 1, explode: 0 },
    { title: 'The grid', text: `A helix of wire ${PITCH} mm a turn, a millimetre from the cathode. Being so close, a few volts on it decide whether electrons cross: at ${st.vg.toFixed(1)} V the plate sits at ${st.vp.toFixed(0)} V.`, view: { target: [XA, 42, 0], yaw: -0.6, pitch: 0.2, dist: 30 }, show: ['grid'], cut: 1, explode: 0 },
    { title: 'The plate', text: `Two blackened nickel sheets crimped at their flanges. At ${B_PLUS} V through ${R_PLATE / 1e3} kΩ it collects the electrons the grid lets through; ${(st.vp * st.ip).toFixed(2)} W heats it now.`, view: { target: [XA, 41, -1], yaw: -0.7, pitch: 0.25, dist: 48 }, show: ['plate'], cut: 1, explode: 0 },
    { title: 'How it is built', text: 'The mount pulled apart: bulb, getter, top mica, cathodes, grids, plate halves. Micas top and bottom hold every electrode at its spacing; the stem leads carry them out through the glass press to the pins.', view: { target: [0, 74, 0], yaw: -0.55, pitch: 0.18, dist: 310 }, frame: [], cut: 0, explode: 1 },
    { title: 'Underneath', text: 'Eight pins round a keyed post: the key fits one way, so pin 1 is always in the same place. Pins 4-6 are section 1, pins 1-3 section 2, 7 and 8 the heater.', view: { target: [0, 2, 0], yaw: 0, pitch: -1.05, dist: 70 }, frame: ['base', 'pins'], cut: 0, explode: 0 },
  ];
}
