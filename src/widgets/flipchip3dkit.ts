// A lidded flip-chip BGA on the studio renderer, to scale in millimetres (DOM-free). x and z across the package, y up from
// the board's top (the seating plane). The outline is AMD's Versal VFVC1596 (AM013, "VFVC1596 Mechanical"): a 37.5 mm body,
// 1 560 balls at 0.92 mm pitch on a 40 × 40 matrix, 0.50 mm standoff, 3.55 mm overall with the lid. The die is its lidless
// sibling VSVA1596's (19.80 × 17.72 mm, 0.797 mm over the substrate with its bumps), taken over here; the substrate's
// thickness and the lid plate's are derived from the two drawings' heights, the lid's wall, the TIM and the bumps are
// illustrative (phys/flipchip.ts holds the bump and the stack, and says where each number comes from).
//
// The section: a quarter cut through a ball column and a bump column (CUT), so balls and bumps are halved on its faces. The
// studio caps a cut by drawing a solid's back faces, so a solid inside another (bumps in the underfill) would show through
// the outer one's cap as if it were hollow: the kept side has only the bump rows the planes pass through, and the full
// 150 µm field fills the quarter the cut removes, so a part-way cut still opens onto bumps. Which balls are left out of the
// 40 × 40 matrix (the centre 6 × 6 under the capacitors, the four corners) is illustrative: the drawing gives the count.

import { merge, roundedBox, sphere, transform, tube, type Geo } from '../gl/kit/geo';
import { M, type Material } from '../gl/kit/materials';
import type { Beat, Item, Model3, StudioAnchor } from '../gl/kit/scene';
import type { Mat4, Vec3 } from '../gl/math';
import { BUMP, STACK } from '../phys/flipchip';

// ---------------------------------------------------------------- dimensions (mm)

/** VFVC1596: body, ball matrix, pitch, ball diameter, standoff (A1), overall height (A). */
export const BODY = 37.5, MATRIX = 40, BALL_PITCH = 0.92, BALL_D = 0.64, A1 = 0.5, A = 3.55;
/** Substrate top (derived: VSVA1596's A2 3.30 − A3 1.05 − die 0.797, over the standoff). */
export const SUB_TOP = A1 + 1.45;
/** Die (VSVA1596): footprint, the bumps under it, the silicon's top. */
export const DIE_X = 19.8, DIE_Z = 17.72, BUMP_TOP = SUB_TOP + BUMP.h, DIE_TOP = SUB_TOP + 0.797;
/** The thermal interface (illustrative thickness), the lid plate's top = the package's A. */
export const TIM_TOP = DIE_TOP + STACK[1].tMm, LID_TOP = A;
/** Lid: 0.2 mm inset from the body (37.1 square), R0.5 corners; its wall's width is illustrative. */
export const LID = BODY - 0.4, WALL = 2;
/** The board under it (a 1.6 mm FR-4 card, drawn). */
export const BOARD = 46, BOARD_T = 1.6;
/** Decoupling capacitors in the ball-free centre (0402: 1.0 × 0.5 mm, 0.35 high; the drawing allows 0.37). */
export const CAP_H = 0.35;

/** Ball centres: column / row i at (i − 19.5) · pitch; a ball is left out in the centre 6 × 6 and at the corners. */
export const ballPos = (i: number): number => (i - (MATRIX - 1) / 2) * BALL_PITCH;
export const ballPresent = (i: number, j: number): boolean => {
  const c = (k: number) => k >= MATRIX / 2 - 3 && k < MATRIX / 2 + 3, e = (k: number) => k === 0 || k === MATRIX - 1;
  return !(c(i) && c(j)) && !(e(i) && e(j));
};
export const BALLS = (() => { let n = 0; for (let i = 0; i < MATRIX; i++) for (let j = 0; j < MATRIX; j++) if (ballPresent(i, j)) n++; return n; })();

/** The quarter cut: through the ball column at +0.46 mm, both ways; bumps are laid from it so a column lies on it too. */
export const CUT = ballPos(MATRIX / 2);
/** Bump centres along x (half-width DIE_X / 2) or z: every pitch from CUT that keeps a bump inside the die by one radius. */
export function bumpLine(half: number): number[] {
  const out: number[] = [], lo = -half + BUMP.r + 0.05, hi = half - BUMP.r - 0.05;
  for (let v = CUT; v >= lo; v -= BUMP.pitch) out.unshift(v);
  for (let v = CUT + BUMP.pitch; v <= hi; v += BUMP.pitch) out.push(v);
  return out;
}
/** How many bumps the full array under the die holds at this pitch (the model draws only those the cut can show). */
export const BUMPS = bumpLine(DIE_X / 2).length * bumpLine(DIE_Z / 2).length;

// ---------------------------------------------------------------- materials

const mat = (o: Material): Material => M.make(o);
export const MATS = {
  si: mat({ ...M.silicon, base: '--m3-si', label: 'silicon die, face down' }),
  beol: mat({ base: '--fc-beol', metal: 0.6, rough: 0.35, label: 'the die’s wiring (copper layers in low-k dielectric), on its face: towards the board' }),
  // half metal: a cut face is shaded rough, and a full metal reads black there
  bump: mat({ ...M.solder, metal: 0.45, rough: 0.4, label: 'solder bump (C4)' }),
  ball: mat({ ...M.solder, metal: 0.45, rough: 0.4, label: 'solder ball (Sn/Ag/Cu)' }),
  underfill: mat({ base: '--fc-underfill', metal: 0, rough: 0.55, label: 'underfill (filled epoxy)' }),
  core: mat({ base: '--fc-core', metal: 0, rough: 0.7, label: 'substrate core (glass-fibre laminate)' }),
  build: mat({ base: '--fc-build', metal: 0, rough: 0.6, label: 'build-up dielectric' }),
  plane: mat({ ...M.copper, label: 'copper plane' }),
  tim: mat({ base: '--fc-tim', metal: 0.2, rough: 0.6, label: 'thermal interface material (TIM1)' }),
  lid: mat({ ...M.copper, base: '--fc-lid', metal: 1, rough: 0.35, label: 'nickel-plated copper lid' }),
  glue: mat({ base: '--fc-glue', metal: 0, rough: 0.7, label: 'lid adhesive' }),
  capBody: mat({ ...M.ceramic, base: '--fc-cap', label: 'multilayer ceramic capacitor' }),
  capEnd: mat({ ...M.nickel, label: 'capacitor terminal' }),
  board: mat({ base: '--fc-board', metal: 0, rough: 0.55, coat: 0.3, label: 'circuit board (FR-4 under solder mask)' }),
  heat: M.beam('--fc-heat', 1.3, 'heat, flowing up'),
};

// ---------------------------------------------------------------- geometry

const tr = (p: Vec3, s: Vec3 = [1, 1, 1]): Mat4 => { const m = new Float32Array(16); m[0] = s[0]; m[5] = s[1]; m[10] = s[2]; m[15] = 1; m[12] = p[0]; m[13] = p[1]; m[14] = p[2]; return m; };
const bx = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, r = 0): Geo =>
  transform(roundedBox(x1 - x0, y1 - y0, z1 - z0, r, r > 0 ? 2 : 0), tr([(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2]));
/** A square slab centred on the axis. */
const slab = (side: number, y0: number, y1: number, r = 0): Geo => bx(-side / 2, side / 2, y0, y1, -side / 2, side / 2, r);

/** The substrate's layers bottom up: build-up (dielectric, copper plane, dielectric, plane), core, and the same above.
 *  Separate slabs, not nested, so each one's cut face is its own colour. The thicknesses inside the derived 1.45 mm are
 *  illustrative. */
export const SUB_LAYERS: { y0: number; y1: number; kind: 'build' | 'plane' | 'core' }[] = (() => {
  const t = [0.11, 0.035, 0.11, 0.035], core = 1.45 - 2 * t.reduce((a, b) => a + b, 0), out: { y0: number; y1: number; kind: 'build' | 'plane' | 'core' }[] = [];
  let y = A1;
  const add = (h: number, kind: 'build' | 'plane' | 'core') => { out.push({ y0: y, y1: y + h, kind }); y += h; };
  t.forEach((h, k) => add(h, k % 2 ? 'plane' : 'build'));
  add(core, 'core');
  [...t].reverse().forEach((h, k) => add(h, k % 2 ? 'build' : 'plane'));
  return out;
})();

/** In the quarter the cut removes (x and z beyond CUT), or on one of its two planes. */
const removed = (x: number, z: number) => x > CUT + 1e-6 && z > CUT + 1e-6;
const onPlane = (x: number, z: number) => (Math.abs(x - CUT) < 1e-6 && z >= CUT - 1e-6) || (Math.abs(z - CUT) < 1e-6 && x >= CUT - 1e-6);

interface Statics { balls: Geo; bumps: Geo; sub: Geo[]; caps: { body: Geo; ends: Geo }; lid: Geo; glue: Geo; fillet: Geo }
const memo = new Map<string, Statics>();
function statics(detail: 'full' | 'flat'): Statics {
  const hit = memo.get(detail);
  if (hit) return hit;
  const flat = detail === 'flat';
  // balls: a sphere flattened to the 0.5 mm standoff (a reflowed ball is wider than tall); flat: the outer two rings only
  const ball = sphere(BALL_D / 2, flat ? 6 : 10, flat ? 3 : 6), ky = A1 / BALL_D, balls: Geo[] = [];
  for (let i = 0; i < MATRIX; i++) for (let j = 0; j < MATRIX; j++) {
    if (!ballPresent(i, j) || (flat && Math.min(i, j, MATRIX - 1 - i, MATRIX - 1 - j) > 1)) continue;
    balls.push(transform(ball, tr([ballPos(i), A1 / 2, ballPos(j)], [1, ky, 1])));
  }
  // bumps: a squat column (a reflowed C4 is a barrel), on both cut planes and filling the removed quarter; none in flat
  const bump = sphere(BUMP.r, 8, 5), bumps: Geo[] = [], ky2 = BUMP.h / (2 * BUMP.r);
  if (!flat) for (const x of bumpLine(DIE_X / 2)) for (const z of bumpLine(DIE_Z / 2)) {
    if (removed(x, z) || onPlane(x, z)) bumps.push(transform(bump, tr([x, SUB_TOP + BUMP.h / 2, z], [1, ky2, 1])));
  }
  // decoupling capacitors in the centre, under the substrate, between the balls left out there
  const body: Geo[] = [], ends: Geo[] = [];
  for (let a = 0; a < 4; a++) for (let b = 0; b < 3; b++) {
    const x = (a - 1.5) * 1.3, z = (b - 1) * 1.5, y0 = A1 - CAP_H;
    body.push(bx(x - 0.3, x + 0.3, y0, A1, z - 0.25, z + 0.25));
    for (const s of [-1, 1]) ends.push(bx(x + s * 0.4 - 0.1, x + s * 0.4 + 0.1, y0, A1, z - 0.25, z + 0.25));
  }
  // the lid: a plate on four walls round the die, R0.5 corners outside
  const L = LID / 2, wy0 = SUB_TOP + 0.05, py0 = TIM_TOP;
  const lid = merge([
    slab(LID, py0, LID_TOP, 0.5),
    bx(-L, L, wy0, py0, -L, -L + WALL), bx(-L, L, wy0, py0, L - WALL, L),
    bx(-L, -L + WALL, wy0, py0, -L + WALL, L - WALL), bx(L - WALL, L, wy0, py0, -L + WALL, L - WALL),
  ], 'lid');
  const glue = merge([
    bx(-L, L, SUB_TOP, wy0, -L, -L + WALL), bx(-L, L, SUB_TOP, wy0, L - WALL, L),
    bx(-L, -L + WALL, SUB_TOP, wy0, -L + WALL, L - WALL), bx(L - WALL, L, SUB_TOP, wy0, -L + WALL, L - WALL),
  ], 'adhesive');
  // underfill: the gap under the die and a fillet climbing its sides, spreading 0.6 mm onto the substrate
  const fx = DIE_X / 2, fz = DIE_Z / 2, F = 0.6, fy = SUB_TOP + 0.45;
  const fillet = merge([
    bx(-fx, fx, SUB_TOP, BUMP_TOP, -fz, fz),
    // four sloped skirts as boxes stepping in: a coarse fillet, enough at this scale
    ...[0, 1, 2].map((k) => { const o = F * (1 - k / 3), y1 = SUB_TOP + ((k + 1) * (fy - SUB_TOP)) / 3, y0 = SUB_TOP + (k * (fy - SUB_TOP)) / 3;
      return merge([bx(-fx - o, fx + o, y0, y1, -fz - o, -fz), bx(-fx - o, fx + o, y0, y1, fz, fz + o), bx(-fx - o, -fx, y0, y1, -fz, fz), bx(fx, fx + o, y0, y1, -fz, fz)], 'skirt'); }),
  ], 'underfill');
  const s: Statics = {
    balls: merge(balls, 'balls'), bumps: merge(bumps.length ? bumps : [bx(0, 0, 0, 0, 0, 0)], 'bumps'),
    sub: SUB_LAYERS.map((l) => slab(BODY, l.y0, l.y1, l.kind === 'core' ? 0.1 : 0)),
    caps: { body: merge(body, 'caps'), ends: merge(ends, 'cap ends') }, lid, glue, fillet,
  };
  memo.set(detail, s);
  return s;
}

/** Heat leaving the die: arrows up through the TIM and the lid plate, over the die's footprint. */
function heatArrows(): Geo {
  const out: Geo[] = [];
  for (const x of [-6, -2, 2, 6]) for (const z of [-5, 0, 5]) {
    if (removed(x, z)) continue;
    out.push(tube([[x, BUMP_TOP + 0.1, z], [x, LID_TOP + 1.6, z]], 0.12, { sides: 8 }));
    out.push(tube([[x - 0.35, LID_TOP + 1.1, z], [x, LID_TOP + 1.6, z], [x + 0.35, LID_TOP + 1.1, z]], 0.1, { sides: 6 }));
  }
  return merge(out, 'heat');
}

export interface FcState {
  /** Heat arrows lit (the stack's beat, or the toggle). */
  heat?: boolean;
  /** What the knobs have opened: the cut (the section's names), the lid lifted (the die's back), or nothing (the outside only). */
  open?: 'cut' | 'lid';
}

const SRC_PKG = 'AMD AM013, VFVC1596 Mechanical (Versal): body, balls, pitch, heights';
const SRC_DIE = 'AMD, VSVA1596 Mechanical (the lidless sibling): die size and height, taken over here';

export function fcModel(st: FcState = {}, detail: 'full' | 'flat' = 'full'): Model3 {
  // the lid lifts and slides back, so the die shows under it from the front
  const S = statics(detail), items: Item[] = [], up = 7, LIFT: Vec3 = [0, up * 1.4, -BODY * 0.75];
  items.push({ geo: slab(BOARD, -BOARD_T, 0, 0.6), mat: MATS.board, name: 'circuit board', group: 'board', cut: 'none', info: { dim: '1.6 mm (drawn)', note: 'the balls reflow onto its pads' } });
  items.push({ geo: S.balls, mat: MATS.ball, name: 'solder ball', group: 'balls', info: { dim: `Ø ${BALL_D} mm at ${BALL_PITCH} mm pitch, ${A1} mm standoff`, source: SRC_PKG, note: `${BALLS} balls on a ${MATRIX} × ${MATRIX} matrix; which places are empty is drawn, the count is the drawing’s` } });
  items.push({ geo: S.caps.body, mat: MATS.capBody, name: 'decoupling capacitor', group: 'caps', info: { dim: '0402 (1.0 × 0.5 mm), 0.35 mm high', source: SRC_PKG, note: 'under the die, where the balls are left out: charge for the die’s current steps, millimetres away instead of centimetres' } });
  items.push({ geo: S.caps.ends, mat: MATS.capEnd, name: 'decoupling capacitor', group: 'caps' });
  SUB_LAYERS.forEach((l, k) => items.push({ geo: S.sub[k], mat: l.kind === 'core' ? MATS.core : l.kind === 'plane' ? MATS.plane : MATS.build,
    name: l.kind === 'core' ? 'substrate core' : l.kind === 'plane' ? 'copper plane' : 'build-up layer', group: 'substrate',
    info: { dim: l.kind === 'core' ? `${(l.y1 - l.y0).toFixed(2)} mm (the 1.45 mm substrate is derived; its split is illustrative)` : `${Math.round((l.y1 - l.y0) * 1000)} µm (illustrative)`,
      note: l.kind === 'core' ? 'the stiff middle; plated holes through it carry the signals down' : l.kind === 'plane' ? 'ground and power spread as whole planes: the current’s return path' : 'thin dielectric between copper layers, where the wiring fans the bumps’ 150 µm out to the balls’ 0.92 mm' } }));
  items.push({ geo: S.fillet, mat: MATS.underfill, name: 'underfill', group: 'underfill', info: { note: 'epoxy wicked under the die after reflow: it locks the bumps, so the die and substrate (which expand differently with heat) do not tear them' } });
  items.push({ geo: S.bumps, mat: MATS.bump, name: 'solder bump', group: 'bumps', info: { dim: `${Math.round(BUMP.h * 1000)} µm tall, ${Math.round(BUMP.pitch * 1000)} µm pitch (typical C4)`, note: `an area array over the die’s whole face: about ${BUMPS.toLocaleString('en')} at this pitch (drawn only where the cut opens)` } });
  items.push({ geo: bx(-DIE_X / 2, DIE_X / 2, BUMP_TOP, BUMP_TOP + 0.012, -DIE_Z / 2, DIE_Z / 2), mat: MATS.beol, name: 'interconnect', group: 'die', order: 1,
    info: { dim: 'about 10 µm (drawn 12)', note: 'the transistors and their wiring are on this face, looking down at the board' } });
  items.push({ geo: bx(-DIE_X / 2, DIE_X / 2, BUMP_TOP + 0.012, DIE_TOP, -DIE_Z / 2, DIE_Z / 2), mat: MATS.si, name: 'silicon die', group: 'die',
    info: { dim: `${DIE_X} × ${DIE_Z} mm, ${(DIE_TOP - BUMP_TOP).toFixed(2)} mm thick`, source: SRC_DIE, note: 'upside down: its back faces the lid, its face the board' } });
  items.push({ geo: bx(-DIE_X / 2, DIE_X / 2, DIE_TOP, TIM_TOP, -DIE_Z / 2, DIE_Z / 2), mat: MATS.tim, name: 'thermal interface', group: 'tim',
    info: { dim: `${Math.round(STACK[1].tMm * 1000)} µm (illustrative)`, note: `a polymer paste, k ≈ ${STACK[1].k} W/m·K: thin, yet the largest resistance in the stack` } });
  items.push({ geo: S.lid, mat: MATS.lid, name: 'lid', group: 'lid', explode: LIFT,
    info: { dim: `${LID} mm square, R0.5 corners; ${(LID_TOP - TIM_TOP).toFixed(2)} mm plate (derived), ${WALL} mm wall (illustrative)`, source: SRC_PKG, note: 'spreads the heat for a heat sink, and protects the die' } });
  items.push({ geo: S.glue, mat: MATS.glue, name: 'lid adhesive', group: 'lid', explode: LIFT });
  if (st.heat && detail === 'full') items.push({ geo: heatArrows(), mat: MATS.heat, name: 'heat', group: 'heat', cut: 'none', shadow: false });

  const front: Vec3 = [0, 0.2, 1], side: Vec3 = [1, 0.2, 0], down: Vec3 = [0, -1, 0], E = BODY / 2;
  const anchors: StudioAnchor[] = [
    { text: 'lid', p: [-E + 0.2, LID_TOP, -6], side: 'l', n: [0, 1, 0], on: 'lid' },
    { text: 'substrate', p: [-E, (A1 + SUB_TOP) / 2, E], side: 'l', n: front, on: 'substrate' },
    { text: 'solder balls', p: [ballPos(2), A1 / 2, E - 0.5], side: 'l', n: front, on: 'balls' },
    // the die and its bumps are named only where they can be seen: on the cut's face, or the die's back under a lifted lid
    ...(st.open === 'cut' ? [
      { text: 'die, face down', p: [CUT, (BUMP_TOP + DIE_TOP) / 2, DIE_Z / 2], side: 'r', n: side, on: 'die' },
      { text: 'bumps in underfill', p: [CUT, (SUB_TOP + BUMP_TOP) / 2, DIE_Z / 2 - 1], side: 'r', n: side, on: 'bumps' },
    ] as StudioAnchor[] : st.open === 'lid' ? [
      { text: 'TIM on the die’s back', p: [-DIE_X / 4, TIM_TOP, -DIE_Z / 4], side: 'r', n: [0, 1, 0], on: 'tim' },
    ] as StudioAnchor[] : []),
    { text: 'decoupling capacitors', p: [0, A1 - CAP_H, 0], side: 'b', n: down, on: 'caps', under: true },
    { text: 'board', p: [-BOARD / 2, -BOARD_T / 2, BOARD / 2], side: 'l', n: front, on: 'board', minor: true },
  ];
  const v = (yaw: number, pitch: number, target: Vec3, dist: number) => ({ yaw, pitch, target, dist });
  const beats: Beat[] = [
    { title: 'A package on its balls', text: `A 37.5 mm square on ${BALLS.toLocaleString('en')} solder balls at 0.92 mm pitch, under a copper lid: AMD’s Versal VFVC1596, to scale. Nothing on the outside shows the die or how it is wired.`, view: v(0.55, 0.4, [0, 1.5, 0], 70), frame: ['lid', 'substrate', 'balls'], explode: 0, cut: 0, hide: ['heat'] },
    { title: 'Under the lid', text: 'Lift the lid: the die lies on a substrate, its back under a thin thermal interface that the lid presses on. No bond wires anywhere: the die is upside down.', view: v(0.55, 0.62, [0, 3, 0], 60), frame: ['die', 'tim', 'substrate', 'lid'], explode: 1, cut: 0, hide: ['heat'] },
    { title: 'Cut open', text: 'A quarter cut through a ball column. From the top: lid, TIM, the die face down, its bumps in underfill, a substrate of copper planes in dielectric round a core, the balls, the board. Under the die’s middle, where balls are left out, decoupling capacitors.', view: v(0.78, 0.26, [CUT, 1.5, CUT], 30), frame: ['die', 'underfill', 'tim', 'caps'], explode: 0, cut: 1, hide: ['heat'] },
    { title: 'A bump beside a ball', text: `One bump is ${Math.round(BUMP.h * 1000)} µm tall at ${Math.round(BUMP.pitch * 1000)} µm pitch, under every part of the die’s face: about ${BUMPS.toLocaleString('en')} of them. The ball below is ${BALL_D} mm across. The SOIC’s bond wire, at 2.8 mm, is forty bumps long: the bump’s inductance is a few hundredths of a nanohenry against the wire’s 3 nH.`, view: v(1.4, 0.1, [CUT, 1.35, ballPos(29) - 0.3], 4.2), explode: 0, cut: 1, labels: false, hide: ['heat'] },
    { title: 'Heat goes up', text: 'Most of the power leaves through the die’s back, the TIM and the lid to a heat sink. Each layer adds t / (k·A); the polymer TIM, a twentieth of a millimetre, adds the most. Move the power and read the rise.', view: v(0.55, 0.35, [0, 2.5, 0], 55), frame: ['die', 'tim', 'lid'], explode: 0, cut: 1, hide: [] },
  ];
  return {
    items, anchors, beats, floor: -BOARD_T - 0.01, flatOrder: 'items',
    cuts: { planes: [{ n: [1, 0, 0], d: CUT }, { n: [0, 0, 1], d: CUT }], open: [BOARD / 2 + 1, BOARD / 2 + 1] },
    look: { exposure: 1 },
  };
}

export const FC_HOME = { yaw: 0.55, pitch: 0.4, target: [0, 1.5, 0] as Vec3, dist: 70 };
export const FC_HOME_FRAME = ['lid', 'substrate', 'balls'];
export const FC_ASPECT = 1.6;
/** The scale bar's label: µm below a millimetre. */
export const fcScale = (len: number): string => (len < 1 ? `${Math.round(len * 1000)} µm` : `${+len.toFixed(2)} mm`);
