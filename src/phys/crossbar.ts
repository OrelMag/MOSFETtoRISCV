// A crossbar switch as a machine (DOM-free, tested): a Bell System Type B, 200 points, three wires a crosspoint. The counts
// and the rules are the sources' (Survey of Telephone Switching, ch. 6, No. 1 Crossbar; Wikipedia, "Crossbar switch"): ten
// levels and twenty verticals; five select bars, each tilted up or down by one of its two select magnets, so a level is a
// bar and a direction; a hold magnet per vertical, whose holding bar traps the finger that the select bar has swung in
// front of a crosspoint's contact card. Select first, then hold, the select kept up until the hold has operated; then the
// select lets go, its other fingers spring back, and the trapped one keeps the crosspoint closed while the hold magnet
// stays energized. "Only one selecting magnet on a switch may be operated at one time." The times are illustrative: none
// were found (the one figure, control occupancy "of the order of one second or less", is the whole set-up).
//
// The chapter's 3 × 3 relay crossbar (lib/telegraph.ts CROSSBAR3) holds a call per row, on the caller's hold rail; the
// real switch holds per vertical. With callers on verticals and called lines on levels the two are the same rule, and a
// test holds a marker driving this model to the chapter's circuit on the switch-level solver.

export const LEVELS = 10, VERTICALS = 20, BARS = 5;
/** Contact pairs a crosspoint closes: tip, ring and sleeve (Type B, three wires; the sources give three to six). */
export const PAIRS = 3;
export const SELECT_MAGNETS = 2 * BARS, HOLD_MAGNETS = VERTICALS;
export const CROSSPOINTS = LEVELS * VERTICALS;

/** Level l is bar ⌊l / 2⌋ tilted down (even l) or up (odd l): levels count from the bottom. */
export const barOf = (l: number): number => Math.floor(l / 2);
export const dirOf = (l: number): 1 | -1 => (l % 2 ? 1 : -1);

/** The switch: which select magnet is operated (a level, or none), each vertical's hold magnet, and the level whose
 *  finger each vertical's holding bar has trapped (null: none; a hold with nothing selected traps nothing). */
export interface Xb { select: number | null; hold: readonly boolean[]; trapped: readonly (number | null)[] }
export const fresh = (verticals = VERTICALS): Xb => ({ select: null, hold: Array<boolean>(verticals).fill(false), trapped: Array<number | null>(verticals).fill(null) });

export type Op = { kind: 'select'; l: number } | { kind: 'unselect' } | { kind: 'hold'; v: number } | { kind: 'unhold'; v: number };
export interface Step { x: Xb; refused?: string }

/** One magnet operated or released. A second select while one is up is refused: two fingers swung on a vertical could
 *  both be trapped by its holding bar, two crosspoints closed at once. A hold on a vertical already held traps nothing more:
 *  its bar is already in, and a finger swung now meets it from the wrong side. */
export function apply(x: Xb, op: Op): Step {
  switch (op.kind) {
    case 'select':
      if (x.select !== null && x.select !== op.l) return { x, refused: 'only one select magnet at a time: two fingers swung on a vertical could both be trapped' };
      return { x: { ...x, select: op.l } };
    case 'unselect':
      return { x: { ...x, select: null } };
    case 'hold': {
      if (x.hold[op.v]) return { x };
      const hold = x.hold.slice(), trapped = x.trapped.slice();
      hold[op.v] = true;
      trapped[op.v] = x.select;
      return { x: { ...x, hold, trapped } };
    }
    case 'unhold': {
      const hold = x.hold.slice(), trapped = x.trapped.slice();
      hold[op.v] = false;
      trapped[op.v] = null;
      return { x: { ...x, hold, trapped } };
    }
  }
}

/** A crosspoint is closed when its vertical's hold magnet is in and the finger it trapped is this level's. */
export const closed = (x: Xb, l: number, v: number): boolean => x.hold[v] && x.trapped[v] === l;
export const closedList = (x: Xb): [number, number][] => x.trapped.flatMap((l, v) => (l !== null && x.hold[v] ? [[l, v] as [number, number]] : []));
/** A level is busy while a vertical holds it (the marker's test, the chapter's busy relay). */
export const levelBusy = (x: Xb, l: number): boolean => x.trapped.some((t, v) => t === l && x.hold[v]);

/** The marker: one request at a time. A call from vertical v (idle) to level l (free): select, hold, release the select.
 *  Refused when the level is busy (the busy tone) or the caller already holds a call. */
export function markerCall(x: Xb, v: number, l: number): { ops: Op[]; refused?: string } {
  if (x.hold[v]) return { ops: [], refused: `vertical ${v} already holds a call` };
  if (levelBusy(x, l)) return { ops: [], refused: `level ${l} is busy` };
  return { ops: [{ kind: 'select', l }, { kind: 'hold', v }, { kind: 'unselect' }] };
}
export const markerHang = (v: number): Op[] => [{ kind: 'unhold', v }];
export function run(x: Xb, ops: readonly Op[]): Xb { for (const op of ops) x = apply(x, op).x; return x; }

// ---------------------------------------------------------------- motion (illustrative times)

/** How long each magnet takes to move its bar (ms): illustrative, none were found. The marker keeps the select up until the
 *  hold has operated, so a call is SELECT_MS + HOLD_MS + RELEASE_MS. */
export const SELECT_MS = 30, HOLD_MS = 30, RELEASE_MS = 25;
export interface Frame { t: number; x: Xb; op?: Op }
/** The frames of a list of operations from x, each starting when the one before has finished. */
export function framesOf(x: Xb, ops: readonly Op[]): Frame[] {
  const out: Frame[] = [{ t: 0, x }];
  let t = 0;
  for (const op of ops) {
    const s = apply(x, op);
    if (s.refused) continue;
    t += op.kind === 'select' ? SELECT_MS : op.kind === 'hold' ? HOLD_MS : RELEASE_MS;
    x = s.x;
    out.push({ t, x, op });
  }
  return out;
}
/** Where the parts are at time t: each bar's tilt (−1 down … 1 up), each holding bar's travel (0 … 1), each vertical's
 *  trapped level (kept while its holding bar is still on its way out), each crosspoint's closing (0 … 1). */
export interface Motion { tilt: number[]; hold: number[]; trapped: (number | null)[] }
const tiltOf = (x: Xb, b: number): number => (x.select !== null && barOf(x.select) === b ? dirOf(x.select) : 0);
const ease = (k: number) => k * k * (3 - 2 * k);
export function motionAt(frames: readonly Frame[], t: number): Motion {
  let i = 0;
  while (i + 1 < frames.length && frames[i + 1].t <= t) i++;
  const a = frames[i].x, nx = frames[i + 1], b = nx ? nx.x : a, k = nx ? ease(Math.max(0, Math.min(1, (t - frames[i].t) / (nx.t - frames[i].t)))) : 0;
  const n = a.hold.length;
  return {
    tilt: Array.from({ length: BARS }, (_, j) => tiltOf(a, j) + (tiltOf(b, j) - tiltOf(a, j)) * k),
    hold: Array.from({ length: n }, (_, v) => (a.hold[v] ? 1 : 0) + ((b.hold[v] ? 1 : 0) - (a.hold[v] ? 1 : 0)) * k),
    trapped: Array.from({ length: n }, (_, v) => b.trapped[v] ?? a.trapped[v]),
  };
}
export const stateAt = (frames: readonly Frame[], t: number): Xb => { let i = 0; while (i + 1 < frames.length && frames[i + 1].t <= t) i++; return frames[i].x; };
