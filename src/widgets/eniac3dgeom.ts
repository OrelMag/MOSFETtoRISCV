// ENIAC's decade ring counter: the counting rule and the unit's layout (DOM-free, tested; drawn by eniac3dkit.ts).
//
// U.S. Army Ordnance, "Electronic Computers Within the Ordnance Corps" (1961), ch. 2: "A group of ten flip-flops, (0-9),
// interconnected to count digit pulses"; each flip-flop "contained two triodes so connected that only one would
// conduct at a given time"; "The state of each flip-flop was indicated by a neon lamp on the front panel"; "reception of
// a pulse at the input side advanced the counter by one stage"; "when any ring passed the nine positions, a pulse was
// passed to the next ring in the series". Wikipedia (ENIAC): 20 ten-digit accumulators; "each digit required 36 vacuum
// tubes, 10 of which were the dual triodes making up the flip-flops of the ring counter"; the accumulators were made of
// 6SN7 flip-flops. Smithsonian NMAH, "ENIAC Decade Ring Counter": about 114.5 cm long (search snippet; the page refuses
// the fetcher). Units: mm.

/** Stages of a ring, digits an accumulator holds, accumulators in ENIAC, tubes a digit (the ring's ten among them). */
export const STAGES = 10, DIGITS = 10, ACCUMULATORS = 20, TUBES_PER_DIGIT = 36;
/** Triodes in the ring of one digit: a 6SN7 is two, one flip-flop. */
export const RING_TRIODES = 2 * STAGES;

/** Decades drawn (units and tens): enough to show the carry. */
export const DECADES = 2;

export interface Decades {
  /** The digit each decade holds: the ring's one conducting stage, units first. */
  digits: number[];
  /** Which decades received a carry on the last pulse (the tens when the units passed nine). */
  carried: boolean[];
}
export const zero = (n = DECADES): Decades => ({ digits: Array(n).fill(0), carried: Array(n).fill(false) });

/** One counting pulse into the units: the lit stage moves on one; passing nine hands a pulse to the next ring. The top
 *  decade's carry falls off the end (the next decade is not drawn). */
export function pulse(d: Decades): Decades {
  const digits = d.digits.slice(), carried = digits.map(() => false);
  for (let k = 0; k < digits.length; k++) {
    digits[k] = (digits[k] + 1) % STAGES;
    if (k > 0) carried[k] = true;
    if (digits[k] !== 0) break; // no carry out of this ring
  }
  return { digits, carried };
}
/** The decades after n pulses from zero. */
export function after(n: number, decades = DECADES): Decades {
  let d = zero(decades);
  for (let i = 0; i < n; i++) d = pulse(d);
  return d;
}
/** The flip-flops of a ring as conducting sides: stage s's "1" triode conducts only for the held digit (one-hot). */
export const oneHot = (digit: number): boolean[] => Array.from({ length: STAGES }, (_, s) => s === digit);

// ---------------------------------------------------------------- the unit's layout (mm)

/** The unit's length (Smithsonian, ~114.5 cm); depth and height drawn. */
export const UNIT_L = 1145, UNIT_D = 150, CHASSIS_H = 60;
/** The ring's ten 6SN7s in a row along the unit (x), on the chassis top, sockets PITCH apart, centred. */
export const PITCH = 100;
export const stageX = (s: number): number => (s - (STAGES - 1) / 2) * PITCH;
/** The front row (the ring) and the back row (the digit's other tubes: standardizer, carry, transmitters), in z. */
export const RING_Z = 30, BACK_Z = -40;
/** The digit's other tubes drawn in the back row (36 a digit − 10 in the ring). */
export const OTHER_TUBES = TUBES_PER_DIGIT - STAGES;
/** The neons on the front edge, one per stage, under its tube. The tens decade stands behind the units and higher (as on
 *  a stepped rack, drawn), so a view along the units' front sees it over their tubes. */
export const NEON_Y = CHASSIS_H * 0.55, UNIT_RISE = 150, UNIT_BACK = 420;
export const decadeY = (k: number): number => k * UNIT_RISE;
export const decadeZ = (k: number): number => -k * UNIT_BACK;
