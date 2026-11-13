// Core rope, the Apollo Guidance Computer's read-only memory (Block II): the rules and the close-up's geometry (DOM-free, tested; drawn by rope3dkit.ts). What the drawing
// shows and where each number comes from:
//
//   R-700 vol. III (E. C. Hall, MIT Instrumentation Laboratory, 1972), sec. 3.5.2, printed pp. 92-93:
//     "A stored bit is a 1 whenever a sense wire threads a core, and is a 0 whenever it fails to thread a core."
//     "Each module contains 512 cores and 192 sense lines and hence contains 192 x 512, or 98 304 bits of information."
//     "Each core stores 12 words" (12 x 16 = 192), and a switching network passes "no more than 1 of the 12" to the
//     module's output, then a second stage picks "one of the six module outputs".
//     Addressing inside the rope: "A switching current is applied that attempts to set 128 cores (set/reset line)";
//     "Inhibit currents are applied ... to either the first or second half of each group of 128 cores", pairs halving
//     the group "until only one core is left uninhibited"; "eight pairs in all to select among 2^7 cores, of which seven
//     pairs correspond to the seven low order address bits" (the eighth is redundant); "One member of each inhibit pair
//     carries current at a time". Then "a reset current is passed through all cores. Only the core that was just set
//     will change state", and the sense amplifiers are gated during the set or the reset.
//     Block II fixed memory: 36 864 words (p. 35 and the text on the Block II change), six rope modules of
//     "approximately 6K words" (36 864 / 6 = 6144 = 512 x 12).
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

import type { Vec3 } from '../gl/math';

/** 1 unit = 0.25 mm. */
export const UNIT_MM = 0.25;
/** Shirriff 2019: .249 in. */
export const CORE_IN = 0.249;
export const OD = (CORE_IN * 25.4) / UNIT_MM;
/** Assumed (not sourced): the bobbin's hole and length. */
export const ID = 0.55 * OD, LEN = 2.5 / UNIT_MM;
/** R-700: per module. */
export const MODULE_CORES = 512, SENSE_LINES = 192, WORDS_PER_CORE = 12, WORD_BITS = 16, INHIBIT_PAIRS = 8, MODULES = 6;
export const MODULE_WORDS = MODULE_CORES * WORDS_PER_CORE; // 6144
export const FIXED_WORDS = MODULES * MODULE_WORDS; // 36 864
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
export const PITCH = 1.5 * OD;
export const coreX = (c: number): number => (c - (CORES - 1) / 2) * PITCH;
/** Cores' axis: along x, at this height and depth. */
export const CY = 30, CZ = 0;
/** The wires' slots in the hole: one angle each, on a circle well inside it. */
export type WireId = { kind: 'sense'; strand: number; bit: number } | { kind: 'inhibit'; k: number; h: number } | { kind: 'set' } | { kind: 'reset' };
export const WIRES: readonly WireId[] = [
  ...Array.from({ length: STRANDS * BITS }, (_, i) => ({ kind: 'sense' as const, strand: Math.floor(i / BITS), bit: i % BITS })),
  ...Array.from({ length: PAIRS * 2 }, (_, i) => ({ kind: 'inhibit' as const, k: Math.floor(i / 2), h: i % 2 })),
  { kind: 'set' }, { kind: 'reset' },
];
const SLOT_R = 0.62 * (ID / 2), OUT_R = OD / 2 + 2.2, GAP = 3;
export const slotAngle = (i: number): number => (i / WIRES.length) * 2 * Math.PI;
export const at = (x: number, r: number, a: number): Vec3 => [x, CY + r * Math.sin(a), CZ + r * Math.cos(a)];
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
export const modW = LAYER_COLS * MODULE_PITCH, modD = LAYER_ROWS * MODULE_PITCH;
export const MODULE_BOX = { x0: MOD_X - modW / 2 - 40, x1: MOD_X + modW / 2 + 40, z0: MOD_Z - modD / 2 - 90, z1: MOD_Z + modD / 2 + 90 };
/** Core centres of the module, layer by layer. */
export function moduleCores(): Vec3[] {
  const out: Vec3[] = [];
  for (let l = 0; l < LAYERS; l++) for (let r = 0; r < LAYER_ROWS; r++) for (let c = 0; c < LAYER_COLS; c++)
    out.push([MOD_X + (c - (LAYER_COLS - 1) / 2) * MODULE_PITCH, 12 + l * 30, MOD_Z + (r - (LAYER_ROWS - 1) / 2) * MODULE_PITCH]);
  return out;
}

// ---------------------------------------------------------------- what carries current

export interface RopePose { strand: number; addr: number; phase: RopePhase; /** the module drawn (the zoomed-out view) */ module: boolean }

/** Is wire i carrying current in this pose? */
export function wireLive(i: number, p: RopePose): boolean {
  const w = WIRES[i];
  if (w.kind === 'set') return p.phase === 'set';
  if (w.kind === 'reset') return p.phase === 'reset';
  if (w.kind === 'inhibit') return p.phase === 'set' && inhibitDriven(p.addr).some((d) => d.k === w.k && d.h === w.h);
  // a sense wire pulses when the switching core is one it threads, and it is on the strand passed to the amplifiers
  return p.phase === 'reset' && w.strand === p.strand && threads(w.strand, w.bit, p.addr);
}
