// Core rope, the Apollo Guidance Computer's read-only memory (Block II), as parts (DOM-free, tested). What the drawing
// shows and where each number comes from:
//
//   R-700 vol. III (E. C. Hall, MIT Instrumentation Laboratory, 1972), sec. 3.5.2, printed pp. 92-93:
//     "A stored bit is a 1 whenever a sense wire threads a core, and is a 0 whenever it fails to thread a core."
//     "Each module contains 512 cores and 192 sense lines and hence contains 192 x 512, or 98,304 bits of information."
//     "Each core stores 12 words" (12 x 16 = 192), and a switching network passes "no more than 1 of the 12" to the
//     module's output, then a second stage picks "one of the six module outputs".
//     Addressing inside the rope: "A switching current is applied that attempts to set 128 cores (set/reset line)";
//     "Inhibit currents are applied ... to either the first or second half of each group of 128 cores", pairs halving
//     the group "until only one core is left uninhibited"; "eight pairs in all to select among 2^7 cores, of which seven
//     pairs correspond to the seven low order address bits" (the eighth is redundant); "One member of each inhibit pair
//     carries current at a time". Then "a reset current is passed through all cores. Only the core that was just set
//     will change state", and the sense amplifiers are gated during the set or the reset.
//     Block II fixed memory: 36,864 words (p. 35 and the text on the Block II change), six rope modules of
//     "approximately 6K words" (36,864 / 6 = 6,144 = 512 x 12).
//   Ken Shirriff, "Software woven into wire: Core rope and the Apollo Guidance Computer" (righto.com, July 2019):
//     the cores "were not regular ferrite cores, but permalloy ribbon wound around a non-magnetic steel bobbin", ".249" in
//     diameter"; the 512 cores "arranged physically as two layers of 256 cores" (32 x 8 a layer), "electrically as four
//     planes of 128 cores"; a group of 16 sense wires for a word is a "strand"; parity means at most 180 of the 192 pass
//     through any core; the selection resistors and diodes are cordwood around the cores.
//
// Not sourced, so drawn as assumptions and said so on screen: the hole and length of a bobbin (a ring 0.55 of its
// diameter inside, 2.5 mm long), the wire gauge, the pitch of the cores in a module (8 mm) and so the module's outline.
// The close-up spreads 8 cores far apart so the wires can be followed, and shows 2 of the 12 strands, 4 of their 16
// sense wires, 3 of the 8 inhibit pairs (the 3 low address bits of 8 cores) and one set and one reset wire.
// The contents are an example pattern, not a mission program.

import type { RGB, RGBA } from '../gl/instances';
import type { Vec3 } from '../gl/math';
import { box, cyl, rod, type Anchor, type Part } from '../gl/parts';

/** 1 unit = 0.25 mm. */
export const UNIT_MM = 0.25;
/** Shirriff 2019: .249 in. */
export const CORE_IN = 0.249;
export const OD = (CORE_IN * 25.4) / UNIT_MM;
/** Assumed (not sourced): the bobbin's hole and length. */
export const ID = 0.55 * OD, LEN = 2.5 / UNIT_MM;
/** R-700: per module. */
export const MODULE_CORES = 512, SENSE_LINES = 192, WORDS_PER_CORE = 12, WORD_BITS = 16, INHIBIT_PAIRS = 8, MODULES = 6;
export const MODULE_WORDS = MODULE_CORES * WORDS_PER_CORE; // 6,144
export const FIXED_WORDS = MODULES * MODULE_WORDS; // 36,864
/** Shirriff 2019: two layers of 32 x 8. */
export const LAYERS = 2, LAYER_COLS = 32, LAYER_ROWS = 8;

/** What the close-up shows of a module. */
export const CORES = 8, STRANDS = 2, BITS = 4, PAIRS = 3;

/** Example contents: per strand, per core, a 4-bit word (low bit first on the wires). */
export const WORDS: readonly (readonly number[])[] = [
  [0b0101, 0b1100, 0b0011, 0b1010, 0b0110, 0b1001, 0b1111, 0b0001],
  [0b1000, 0b0111, 0b1110, 0b0100, 0b1011, 0b0010, 0b0000, 0b1101],
];
/** Does sense wire `bit` of `strand` thread core `core`? (a 1: through; a 0: around). */
export const threads = (strand: number, bit: number, core: number): boolean => ((WORDS[strand][core] >> bit) & 1) === 1;

/** Inhibit wire (pair k, half h) threads the cores whose address bit k is h. */
export const inhibitThreads = (k: number, h: number, core: number): boolean => ((core >> k) & 1) === h;
/** To address core c, the member of each pair that threads the cores whose bit k differs from c's carries current. */
export const inhibitDriven = (c: number): { k: number; h: number }[] => Array.from({ length: PAIRS }, (_, k) => ({ k, h: 1 - ((c >> k) & 1) }));
/** Inhibit currents through a core: how many driven inhibit wires thread it (0 only for the addressed core). */
export const inhibitsOn = (addr: number, core: number): number => inhibitDriven(addr).filter((d) => inhibitThreads(d.k, d.h, core)).length;

export type RopePhase = 'idle' | 'set' | 'reset';
/** The cores that switch in a phase: set flips the one uninhibited core, reset flips it back; nothing else moves. */
export const switching = (phase: RopePhase, addr: number): number[] =>
  phase === 'idle' ? [] : Array.from({ length: CORES }, (_, c) => c).filter((c) => inhibitsOn(addr, c) === 0);
/** The word the sense amplifiers see on the strand passed through, in the reset phase: the threaded wires pulse. */
export function senseWord(strand: number, addr: number): number {
  let w = 0;
  for (let b = 0; b < BITS; b++) if (threads(strand, b, addr)) w |= 1 << b;
  return w;
}

// ---------------------------------------------------------------- the close-up's geometry

/** Spread apart in the close-up (the module's real pitch is MODULE_PITCH). */
export const PITCH = 2.2 * OD;
export const coreX = (c: number): number => (c - (CORES - 1) / 2) * PITCH;
/** Cores' axis: along x, at this height and depth. */
export const CY = 30, CZ = 0;
const RING_R = (OD + ID) / 4, TUBE_R = (OD - ID) / 4;
/** The wires' slots in the hole: one angle each, on a circle well inside it. */
export type WireId = { kind: 'sense'; strand: number; bit: number } | { kind: 'inhibit'; k: number; h: number } | { kind: 'set' } | { kind: 'reset' };
export const WIRES: readonly WireId[] = [
  ...Array.from({ length: STRANDS * BITS }, (_, i) => ({ kind: 'sense' as const, strand: Math.floor(i / BITS), bit: i % BITS })),
  ...Array.from({ length: PAIRS * 2 }, (_, i) => ({ kind: 'inhibit' as const, k: Math.floor(i / 2), h: i % 2 })),
  { kind: 'set' }, { kind: 'reset' },
];
const SLOT_R = 0.62 * (ID / 2), OUT_R = OD / 2 + 2.2, GAP = 3;
const slotAngle = (i: number): number => (i / WIRES.length) * 2 * Math.PI;
const at = (x: number, r: number, a: number): Vec3 => [x, CY + r * Math.sin(a), CZ + r * Math.cos(a)];
/** Does a wire thread core c? Set and reset thread every core. */
export function wireThreads(w: WireId, c: number): boolean {
  return w.kind === 'sense' ? threads(w.strand, w.bit, c) : w.kind === 'inhibit' ? inhibitThreads(w.k, w.h, c) : true;
}
/** A wire's polyline: straight through the holes it threads; where it does not, out round the core in the gap before it,
 *  along the outside, and back in the gap after it (never through the ring). */
export function wirePath(i: number): Vec3[] {
  const w = WIRES[i], a = slotAngle(i), x0 = coreX(0) - PITCH * 0.75, x1 = coreX(CORES - 1) + PITCH * 0.75;
  const pts: Vec3[] = [at(x0, SLOT_R, a)];
  for (let c = 0; c < CORES; c++) {
    if (wireThreads(w, c)) continue;
    const xa = coreX(c) - LEN / 2 - GAP, xb = coreX(c) + LEN / 2 + GAP;
    pts.push(at(xa, SLOT_R, a), at(xa, OUT_R, a), at(xb, OUT_R, a), at(xb, SLOT_R, a));
  }
  pts.push(at(x1, SLOT_R, a));
  return pts;
}
/** Is a point of a wire inside core c's ring material (for the test: a wire never passes through a ring)? */
export function inRing(p: Vec3, c: number): boolean {
  const dx = Math.abs(p[0] - coreX(c)), r = Math.hypot(p[1] - CY, p[2] - CZ);
  return dx <= LEN / 2 && r > ID / 2 && r < OD / 2;
}
/** The radius of a wire's point about the cores' axis. */
export const radiusOf = (p: Vec3): number => Math.hypot(p[1] - CY, p[2] - CZ);
export const HOLE_R = ID / 2, CORE_R = OD / 2, SLOT = SLOT_R, OUTSIDE = OUT_R;

// ---------------------------------------------------------------- the module (zoomed out)

/** Assumed (not sourced): the cores' pitch in a module, 8 mm. */
export const MODULE_PITCH = 8 / UNIT_MM;
/** The module sits beside the close-up. */
export const MOD_X = 0, MOD_Z = -1100;
const modW = LAYER_COLS * MODULE_PITCH, modD = LAYER_ROWS * MODULE_PITCH;
export const MODULE_BOX = { x0: MOD_X - modW / 2 - 40, x1: MOD_X + modW / 2 + 40, z0: MOD_Z - modD / 2 - 90, z1: MOD_Z + modD / 2 + 90 };
/** Core centres of the module, layer by layer. */
export function moduleCores(): Vec3[] {
  const out: Vec3[] = [];
  for (let l = 0; l < LAYERS; l++) for (let r = 0; r < LAYER_ROWS; r++) for (let c = 0; c < LAYER_COLS; c++)
    out.push([MOD_X + (c - (LAYER_COLS - 1) / 2) * MODULE_PITCH, 12 + l * 30, MOD_Z + (r - (LAYER_ROWS - 1) / 2) * MODULE_PITCH]);
  return out;
}

// ---------------------------------------------------------------- parts

export interface RopePose { strand: number; addr: number; phase: RopePhase; /** the module drawn (the zoomed-out view) */ module: boolean }
export interface RopePalette { ribbon: RGB; bobbin: RGB; copper: RGB; inhibit: RGB; set: RGB; reset: RGB; live: RGB; board: RGB; res: RGB; diode: RGB; lamp: RGB; lampOff: RGB; sel: RGB }
const lit = (c: RGB, k = 0.55): RGB => [c[0] * k, c[1] * k, c[2] * k];
const SIDES = 16;

/** Is wire i carrying current in this pose? */
export function wireLive(i: number, p: RopePose): boolean {
  const w = WIRES[i];
  if (w.kind === 'set') return p.phase === 'set';
  if (w.kind === 'reset') return p.phase === 'reset';
  if (w.kind === 'inhibit') return p.phase === 'set' && inhibitDriven(p.addr).some((d) => d.k === w.k && d.h === w.h);
  // a sense wire pulses when the switching core is one it threads, and it is on the strand passed to the amplifiers
  return p.phase === 'reset' && w.strand === p.strand && threads(w.strand, w.bit, p.addr);
}

export function ropeParts(p: RopePose, P: RopePalette): Part[] {
  const out: Part[] = [];
  // the board under the close-up
  out.push(box(P.board, coreX(0) - PITCH, coreX(CORES - 1) + PITCH, -4, 0, -OD * 1.6, OD * 1.6));
  // the cores: a ring of permalloy ribbon on its bobbin, its axis along x; the switching one glows
  const sw = new Set(switching(p.phase, p.addr));
  for (let c = 0; c < CORES; c++) {
    const on = sw.has(c), col = on ? P.live : c === p.addr ? P.sel : P.ribbon;
    for (let i = 0; i < SIDES; i++) {
      const a0 = (i / SIDES) * 2 * Math.PI, a1 = ((i + 1) / SIDES) * 2 * Math.PI;
      for (const dx of [-LEN / 2 + TUBE_R, LEN / 2 - TUBE_R]) {
        const seg = rod(col, at(coreX(c) + dx, RING_R, a0), at(coreX(c) + dx, RING_R, a1), TUBE_R, 0.5);
        if (on) seg.emissive = lit(P.live, 0.4);
        out.push(seg);
      }
    }
    // the bobbin's bore (steel), a thin sleeve inside the ribbon
    out.push(rod(P.bobbin, [coreX(c) - LEN / 2, CY, CZ], [coreX(c) + LEN / 2, CY, CZ], 0.2));
    // a post holding the core over the board
    out.push(cyl(P.bobbin, coreX(c), CZ - OD / 2 - 6, 0, CY, 0.8));
  }
  // the wires
  WIRES.forEach((w, i) => {
    const live = wireLive(i, p), base = w.kind === 'sense' ? P.copper : w.kind === 'inhibit' ? P.inhibit : w.kind === 'set' ? P.set : P.reset;
    const pts = wirePath(i), dim = w.kind === 'sense' && w.strand !== p.strand;
    const c: RGB | RGBA = live ? P.live : dim ? [base[0], base[1], base[2], 0.35] : base;
    for (let j = 1; j < pts.length; j++) {
      const seg = rod(c, pts[j - 1], pts[j], live ? 0.55 : 0.35, 0.3);
      if (live) seg.emissive = lit(P.live, 0.5);
      out.push(seg);
    }
  });
  // the sense amplifiers' lamps, one per bit of the strand passed through: lit by a pulse in the reset phase
  for (let b = 0; b < BITS; b++) {
    const on = p.phase === 'reset' && threads(p.strand, b, p.addr), x = coreX(CORES - 1) + PITCH * 0.75 + 14, z = (b - (BITS - 1) / 2) * 8;
    out.push(box(P.board, x - 3, x + 3, 0, 6, z - 3, z + 3), { ...box(on ? P.live : P.lampOff, x - 2, x + 2, 6, 9, z - 2, z + 2), emissive: on ? lit(P.live, 0.8) : undefined });
  }
  if (p.module) out.push(...moduleParts(P));
  return out;
}

/** The module: two layers of 32 x 8 cores on a board, the cordwood selection resistors and diodes along both sides. */
export function moduleParts(P: RopePalette): Part[] {
  const out: Part[] = [], B = MODULE_BOX;
  out.push(box(P.board, B.x0, B.x1, -6, 0, B.z0, B.z1));
  // the close-up's eight cores: the top layer's first eight of its front row
  moduleCores().forEach((q, i) => out.push(rod(i >= LAYER_COLS * LAYER_ROWS && i < LAYER_COLS * LAYER_ROWS + CORES ? P.sel : P.ribbon, [q[0] - LEN / 2, q[1], q[2]], [q[0] + LEN / 2, q[1], q[2]], OD / 2, 0.4)));
  for (const side of [-1, 1]) {
    const z = MOD_Z + side * (modD / 2 + 50);
    for (let i = 0; i < 64; i++) {
      const x = B.x0 + 30 + i * ((B.x1 - B.x0 - 60) / 63);
      out.push(cyl(i % 3 === 2 ? P.diode : P.res, x, z, 0, 40, 3));
    }
  }
  return out;
}

export function ropeAnchors(p: RopePose, narrow = false): Anchor[] {
  const up: Vec3 = [0, 1, 0];
  const through = WIRES.findIndex((w) => w.kind === 'sense' && w.strand === p.strand && threads(w.strand, w.bit, 4));
  const around = WIRES.findIndex((w) => w.kind === 'sense' && w.strand === p.strand && !threads(w.strand, w.bit, 3));
  const a: Anchor[] = [
    { text: 'core: permalloy ribbon on a steel bobbin, 0.249 in', p: at(coreX(6), CORE_R, Math.PI * 0.35), side: 't', n: up },
    { text: 'sense wire through the core: 1', p: at(coreX(4) + LEN, SLOT_R, slotAngle(Math.max(0, through))), side: 'b', n: up },
    { text: 'sense wire round the core: 0', p: at(coreX(3), OUT_R, slotAngle(Math.max(0, around))), side: 'r', n: up, minor: narrow },
  ];
  if (!narrow) a.push(
    { text: 'inhibit wires (address)', p: wirePath(WIRES.findIndex((w) => w.kind === 'inhibit'))[0], side: 'l', n: up },
    { text: 'sense amplifiers', p: [coreX(CORES - 1) + PITCH * 0.75 + 14, 9, 0], side: 'r', n: up },
  );
  if (p.module) a.push({ text: 'a module: 512 cores, 2 layers of 32 × 8', p: [MOD_X, 60, MOD_Z], side: 't', n: up }, { text: 'the eight cores of the close-up', p: moduleCores()[LAYER_COLS * LAYER_ROWS + 3], side: 'b', n: up });
  return a;
}
