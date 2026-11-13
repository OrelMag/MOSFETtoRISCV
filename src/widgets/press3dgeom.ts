// Hollerith's pin press: its positions, stroke and counters (DOM-free, tested; drawn by press3dkit.ts). One position per option of the chapter's census card (cards/census.ts):
// a spring pin above it, a mercury cup below it, a counter dial at the front. A pin stops on the card unless the card has
// a hole there; only a pin that reaches the mercury closes its circuit, and only at the bottom of the stroke. Every pin is
// the same length and rides up against its own spring when the card stops it. Beside the press, two relays (married:
// yes, born: abroad) with their make contacts in series (AND) or in parallel (OR) drive an eleventh dial.
//
// The dials are the 1890 counters: a face of 100 divisions with two hands, the long one a turn per 100 counts, the short
// one a turn per 10 000, each stepped by its own magnet (Columbia University Computing History, "Hollerith 1890 Census
// Tabulator"; Truesdell, The Development of Punch Card Tabulation, 1965).




import { FIELDS, type Wiring } from '../cards/census';

export interface Pos { field: number; opt: number; k: number; x: number; z: number }
/** The census card's positions in field order; k is also the position's dial. */
export const POSITIONS: Pos[] = FIELDS.flatMap((f, field) => f.opts.map((_, opt) => ({ field, opt, k: 0, x: (opt - 1.5) * 6, z: (field - 1.5) * 5 })))
  .map((p, k) => ({ ...p, k }));
export const N = POSITIONS.length;

export const CARD_TOP = 18, HG_TOP = 6, FREE = 14, REACH = 26, HEAD_UP = 46;
/** Every pin's length; a free pin's top sits PIN_LEN − FREE above the head's guide plate. */
export const PIN_LEN = FREE + 6;
/** The pin box's lid, the springs' fixed end, this far above the guide plate. */
export const LID = 22;
/** The head's underside (the guide plate) at stroke s (0 raised, 1 down). */
export const headY = (s: number): number => HEAD_UP - REACH * s;
/** Where a pin's tip is: it hangs FREE below the head until the card (or the mercury, through a hole) stops it. */
export const pinTip = (s: number, hole: boolean): number => Math.max(headY(s) - FREE, hole ? HG_TOP : CARD_TOP);
/** The pin's top: a rigid pin, so a stopped one rides up into the head by as much as it was stopped. */
export const pinTop = (s: number, hole: boolean): number => pinTip(s, hole) + PIN_LEN;
/** The spring's length between the pin's collar and the lid: shorter on a pin the card holds back. */
export const springLen = (s: number, hole: boolean): number => headY(s) + LID - pinTop(s, hole);
/** The pin has reached its mercury: the circuit is closed. */
export const reaches = (s: number, hole: boolean): boolean => hole && pinTip(s, hole) <= HG_TOP;
/** The holes of a card, per position. */
export const holesOf = (p: readonly number[]): boolean[] => POSITIONS.map((q) => p[q.field] === q.opt);
export const closedOf = (s: number, holes: readonly boolean[]): boolean[] => holes.map((h) => reaches(s, h));
/** The positions whose cups feed the two relays: married yes, born abroad. */
export const RELAY_POS: [number, number] = [POSITIONS.findIndex((q) => q.field === 2 && q.opt === 0), POSITIONS.findIndex((q) => q.field === 3 && q.opt === 1)];

/** The counter's hands (radians, clockwise from 12): long a turn per 100, short a turn per 10 000. */
export const handAngles = (n: number): [number, number] => [(n / 100) * 2 * Math.PI, (n / 10000) * 2 * Math.PI];

export interface PressPose { s: number; holes: boolean[] | null; counts: number[]; wiring: Wiring; relayCount: number }


export const dialX = (k: number) => (k - (N - 1) / 2) * 5.4;
export const DIAL_Y = 11, DIAL_Z = 26.8, RACK_TOP = 17;
export const RX = 42, RZ: [number, number] = [-6, 6];
