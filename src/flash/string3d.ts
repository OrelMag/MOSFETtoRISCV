// A 3D NAND block's geometry (DOM-free, tested): Samsung's 32-layer (2nd generation) V-NAND, from the TEMs TechInsights published
// and 3DInCites analysed (https://www.3dincites.com/?p=8892) and Chipworks' teardown (Dick James, Semiconductor Digest). Units are
// 10 nm. What the sources do not give is labelled typical, and the staircase is the one thing drawn out of scale (STAIR_K).
//
// A string is a hole etched through the stack and lined from the outside in: blocking oxide, silicon nitride (the charge trap),
// tunnel oxide, a thin polysilicon channel, an oxide core. Each tungsten word-line plate wraps the hole: one cell per layer,
// gate-all-around. The rules it runs on are the chapter's (phys/fgate.ts, lib/flash.ts): the string stood on end.

/** 1 drawn unit, in nm. */
export const NM = 10;
const u = (nm: number) => nm / NM;

/** The channel hole before it is filled (3DInCites: 120 nm), the ONO (22 nm) and the channel polysilicon (11 nm). */
export const HOLE_NM = 120, ONO_NM = 22, POLY_NM = 11;
/** The oxide core: what the hole has left (calculated). */
export const CORE_NM = HOLE_NM - 2 * ONO_NM - 2 * POLY_NM;
/** The ONO split, outside in (typical: the sources give its total only). */
export const ONO_SPLIT_NM = { blocking: 11, nitride: 7, tunnel: 4 } as const;
/** The rings' outer radii (units), hole first. */
export const RINGS = (() => {
  const hole = u(HOLE_NM) / 2, blk = hole - u(ONO_SPLIT_NM.blocking), nit = blk - u(ONO_SPLIT_NM.nitride), tun = nit - u(ONO_SPLIT_NM.tunnel), poly = tun - u(POLY_NM);
  return { hole, blocking: [blk, hole], nitride: [nit, blk], tunnel: [tun, nit], poly: [poly, tun], core: poly } as const;
})();

/** The levels from the bottom (Chipworks, 2nd generation: 32 word lines, 4 dummies, a select gate at each end: 38). */
export type LevelKind = 'gsl' | 'dummy' | 'wl' | 'ssl';
export const LEVELS: readonly { kind: LevelKind; wl?: number }[] = [
  { kind: 'gsl' }, { kind: 'dummy' }, { kind: 'dummy' },
  ...Array.from({ length: 32 }, (_, i) => ({ kind: 'wl' as const, wl: i })),
  { kind: 'dummy' }, { kind: 'dummy' }, { kind: 'ssl' },
];
export const WORD_LINES = 32;
/** The layer pitch: Samsung's 128-layer part's 44 nm (TechInsights, 2022), as the 32-layer part's is not published; tungsten and
 *  oxide half each (typical). */
export const PITCH_NM = 44;
export const PITCH = u(PITCH_NM), W_T = PITCH / 2;
/** A level's tungsten plate: bottom and top (units); the oxide between levels fills the rest of the pitch. */
export const levelY = (i: number): [number, number] => [STACK_Y0 + i * PITCH + (PITCH - W_T) / 2, STACK_Y0 + i * PITCH + (PITCH + W_T) / 2];
/** The stack sits on the substrate, with a pitch of oxide under the first level. */
export const STACK_Y0 = 0;
export const STACK_TOP = STACK_Y0 + LEVELS.length * PITCH;
/** The level of word line w. */
export const levelOfWl = (w: number): number => LEVELS.findIndex((l) => l.wl === w);

/** Slit to slit (3DInCites: about 725 nm at the top, 730 at the bottom); the slit's width (typical). */
export const SLIT_NM = 725, SLIT_W_NM = 50;
export const SLIT_Z = u(SLIT_NM) / 2, SLIT_W = u(SLIT_W_NM);
/** Holes along a row (3DInCites: 260 nm hole to hole in the section's direction); the four staggered rows between two slits
 *  (the row spacing is drawn, 180 nm, which puts the next row's hole 222 nm away: the article's 240–245 nm is the nearest
 *  sourced figure). */
export const HOLE_PITCH = u(260), ROW_Z = [-27, -9, 9, 27] as const, PER_ROW = 6;
/** The holes: (x, z), even rows on the half pitch. */
export const HOLES: readonly [number, number][] = ROW_Z.flatMap((z, r) =>
  Array.from({ length: r % 2 ? PER_ROW - 1 : PER_ROW }, (_, k): [number, number] => [(k - (r % 2 ? PER_ROW - 2 : PER_ROW - 1) / 2) * HOLE_PITCH, z]));
/** The block's ends along the word lines (units), past the outer holes by half a pitch. */
export const BLOCK_X = ((PER_ROW - 1) / 2 + 0.5) * HOLE_PITCH;
/** The staircase: about 20 µm in all (3DInCites), so one tread is 20 µm over the levels; drawn STAIR_K times shorter. */
export const STAIR_UM = 20, STAIR_K = 12;
export const TREAD = u((STAIR_UM * 1000) / LEVELS.length) / STAIR_K;
/** How far level i reaches along x: the lowest level furthest, each one above a tread shorter. */
export const levelEnd = (i: number): number => BLOCK_X + (LEVELS.length - i) * TREAD;
/** The pillar the model follows (in the cut row) and its cell size from the article (31 000 nm²). */
export const CHOSEN = HOLES.findIndex(([x, z]) => z === 9 && Math.abs(x + HOLE_PITCH / 2) < 1e-9);
export const CELL_NM2 = 31000;
