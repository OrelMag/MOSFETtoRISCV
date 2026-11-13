// EDSAC's mercury delay line as numbers, scene units and names (DOM-free, tested; mercury3dkit.ts draws it). The tube is the 1948 report's (Wilkes & Renwick,
// section 3.1): a mercury-filled steel tube of 1 inch external diameter, about 5 ft 4 in between its end blocks,
// a piezo-electric crystal at each end, 16 long numbers of 36 pulse intervals (P0 blank, P1..P34 digits, P35 sign)
// circulating, one major cycle long. Delay and capacity are computed here from length and sound speed, not typed in.

import type { Vec3 } from '../gl/math';
import type { Anchor } from '../gl/parts';
import { DDR4_3200 } from '../dram/timing';

// ------------------------------------------------------------------ the physical tube and its figures
export const INCH_M = 0.0254;
/** Between the end blocks: "approximately 5 ft. 4 in." (the 1948 report, 3.1). */
export const LENGTH_M = (5 * 12 + 4) * INCH_M;
/** Outside diameter: "1 inch external diameter" (same place). The bore is not given in the sources used. */
export const OD_M = 1 * INCH_M;
/**
 * Speed of sound in mercury: 1451 m/s at 20 °C, falling 0.46 m/s per K (Karl Deutsch, "Sound Velocity in Liquids" table:
 * mercury 1451, 20 °C, -0.46; Wikipedia's mercury page gives 1451.4 m/s at 20 °C). The coefficient is that table's alone, a
 * linear fit near room temperature, applied here over 30-50 °C.
 */
export const SOUND_20C = 1451, SOUND_DT = -0.46;
export const soundAt = (celsius: number): number => SOUND_20C + SOUND_DT * (celsius - 20);
/** The operating point: 40 °C is the figure secondary sources give for heated mercury lines in general (Wikipedia, "Delay-line memory",
 *  uncited); no primary EDSAC source we could read states the temperature (the 1948 report only says all tanks must be at one temperature). */
export const TANK_C = 40;
export const SOUND_M_S = soundAt(TANK_C);
/** The carrier a pulse modulates: 13.5 Mc/s (report, 3.1). */
export const CARRIER_HZ = 13.5e6;
/** The report's own figures, which the computed ones are held to: 0.9 µs pulses, 2 µs slots (500 kc/s), "about 1.15 ms", "about 870 c/s". */
export const REPORT = { pulseS: 0.9e-6, slotS: 2e-6, delayS: 1.15e-3, circHz: 870 } as const;

export const WORDS = 16, SLOTS_PER_WORD = 36, SLOTS = WORDS * SLOTS_PER_WORD;
/** Two batteries of sixteen tanks: 32 tanks, 512 long numbers (1024 short, 17-bit ones). */
export const BATTERIES = 2, TANKS_PER_BATTERY = 16;
export const TANKS = BATTERIES * TANKS_PER_BATTERY;
export const LONG_WORD_BITS = 35;

/**
 * The clock came first: 500 kc/s, a 2 µs slot, 576 slots, so one circulation is 576 x 2 µs = 1.152 ms (the report's "about
 * 1.15 ms") and the tube was made to match it, not the other way round.
 */
export const slotS = (): number => REPORT.slotS;
export const delayS = (): number => SLOTS * slotS();
/** The tube cut as the report gives it (5 ft 4 in between end blocks) takes this long at 40 °C: 2.2 % short of the clock. */
export const reportTubeDelayS = (): number => LENGTH_M / SOUND_M_S;
/**
 * The sound path that matches the clock at 40 °C, delay x speed = 1.661 m (5 ft 5.4 in). That is 2.2 % longer than the
 * report's "approximately 5 ft 4 in" between end blocks; the path between the crystal faces is not given, so this is our
 * inference, and the model uses it ("the tube is cut to this").
 */
export const CUT_LENGTH_M = delayS() * SOUND_M_S;
/** The tube's own L / v at tank temperature T: it drifts from the clock's circulation when T is not 40 °C. */
export const tubeDelayAt = (celsius: number): number => CUT_LENGTH_M / soundAt(celsius);
/** How far pulses arrive after their slot's centre, in slots (positive: late, as at a warmer, slower tank). */
export const offsetSlots = (celsius: number): number => (tubeDelayAt(celsius) - delayS()) / slotS();
/** The receiver accepts a pulse while it lies inside its slot: the slot less the pulse's own width, half each side. */
export const WINDOW_SLOTS = 1 - REPORT.pulseS / REPORT.slotS;
export const WINDOW_TOL = WINDOW_SLOTS / 2;
export const inWindow = (celsius: number): boolean => Math.abs(offsetSlots(celsius)) <= WINDOW_TOL + 1e-12;
/** Temperature span, either side of 40 °C, over which pulses stay in the window. */
export const toleranceK = (): number => WINDOW_TOL / Math.abs(offsetSlots(TANK_C + 1));
/** A DDR4-3200 row hit to first data (tCAS), for the comparison line, and how many of those fit in the mean wait. */
export const ROW_HIT_S = DDR4_3200.tCAS * 1e-9;
export const dramRatio = (): number => meanWaitS() / ROW_HIT_S;
/** Pulse repetition rate = 1 / slot. */
export const rateHz = (): number => 1 / slotS();
/** Bits in flight = delay x rate: the capacity. */
export const bitsInTank = (): number => delayS() * rateHz();
/** A word recurs once per circulation. */
export const circulationHz = (): number => 1 / delayS();
/** Distance between pulses, and the length of one pulse, in the mercury. */
export const slotPitchM = (): number => SOUND_M_S * slotS();
export const pulseLengthM = (): number => SOUND_M_S * REPORT.pulseS;
export const carrierWavelengthM = (): number => SOUND_M_S / CARRIER_HZ;
export const carrierCycles = (): number => REPORT.pulseS * CARRIER_HZ;
/** Capacity of the whole store in long numbers, and in 17-bit short ones. */
export const storeLongWords = (): number => TANKS * WORDS;
export const storeShortWords = (): number => 2 * storeLongWords();

/** Mean wait for a word that is asked for at a random moment: half a circulation. */
export const meanWaitS = (): number => delayS() / 2;

// ------------------------------------------------------------------ words
/** Slot (P index) of bit i of the 35-bit number: P1 is the least significant, P35 the sign. */
export const slotOfBit = (i: number): number => i + 1;
export const MAX35 = 2 ** LONG_WORD_BITS;
/** The 36 slots of a 35-bit value (P0 blank). */
export function wordSlots(value: number): number[] {
  const v = ((Math.floor(value) % MAX35) + MAX35) % MAX35, out = new Array<number>(SLOTS_PER_WORD).fill(0);
  for (let i = 0; i < LONG_WORD_BITS; i++) out[slotOfBit(i)] = Math.floor(v / 2 ** i) % 2;
  return out;
}
export function valueOfSlots(s: readonly number[]): number {
  let v = 0;
  for (let i = 0; i < LONG_WORD_BITS; i++) v += (s[slotOfBit(i)] ? 1 : 0) * 2 ** i;
  return v;
}
/** The tank's first contents (arbitrary numbers). */
export const initialWord = (w: number): number => ((w + 1) * 0x2468ace + w * 0x13579) % MAX35;

// ------------------------------------------------------------------ the circulating tank
export interface Access { kind: 'read' | 'write'; word: number; value: number; asked: number; started: number; got: number[]; done: boolean; waitSlots: number; lost: number }

/**
 * The tank as the report describes it. `bits[L]` is the pulse (or none) whose slot label is L: it reaches the receiving
 * crystal when the slot count `t` passes L (mod 576). There it is amplified, reshaped against the clock and, with the
 * recirculation gate closed, launched again at the other end. Reading and writing both happen at that gate, and only for a
 * whole word starting at its P0: the word must come round.
 */
export class Tank {
  bits = new Uint8Array(SLOTS);
  /** Slot ticks elapsed (continuous). */
  t = 0;
  /** The recirculation gate: false lets whatever arrives die (the store forgets in one circulation). */
  loop = true;
  /** Where the tank's pulses fall against the receiving window, in slots (offsetSlots(T)); outside WINDOW_TOL they are missed. */
  offset = 0;
  access: Access | null = null;
  last: Access | null = null;
  constructor() { for (let w = 0; w < WORDS; w++) this.setWord(w, initialWord(w)); }
  setWord(w: number, value: number): void { wordSlots(value).forEach((b, k) => { this.bits[w * SLOTS_PER_WORD + k] = b; }); }
  word(w: number): number { return valueOfSlots(Array.from(this.bits.subarray(w * SLOTS_PER_WORD, (w + 1) * SLOTS_PER_WORD))); }
  /** The label of the slot at the receiver now, and its word. */
  get label(): number { return Math.floor(this.t) % SLOTS; }
  get atWord(): number { return Math.floor(this.label / SLOTS_PER_WORD); }
  /** Slots until word w starts to arrive (0 if it is arriving this slot). */
  waitFor(w: number): number { return (((w * SLOTS_PER_WORD - Math.floor(this.t)) % SLOTS) + SLOTS) % SLOTS; }
  request(kind: 'read' | 'write', word: number, value = 0): void {
    this.access = { kind, word, value, asked: this.t, started: -1, got: [], done: false, waitSlots: 0, lost: 0 };
  }
  /** Advance by `d` slots; each whole slot that finishes its trip is processed in order. */
  advance(d: number): void {
    const from = Math.floor(this.t), to = Math.floor(this.t + d);
    this.t += d;
    for (let k = from + 1; k <= to; k++) this.arrive((k - 1) % SLOTS, k);
  }
  private arrive(L: number, tick: number): void {
    const a = this.access, w = Math.floor(L / SLOTS_PER_WORD), k = L % SLOTS_PER_WORD, missed = Math.abs(this.offset) > WINDOW_TOL;
    if (a && !a.done && w === a.word) {
      if (a.started < 0 && k === 0) { a.started = tick; a.waitSlots = tick - Math.floor(a.asked) - 1; }
      if (a.started >= 0) {
        if (a.kind === 'read') {
          if (missed) { a.lost += this.bits[L]; a.got.push(0); this.bits[L] = 0; } else { a.got.push(this.bits[L]); this.bits[L] = this.loop ? this.bits[L] : 0; }
        }
        else this.bits[L] = wordSlots(a.value)[k];
        if (k === SLOTS_PER_WORD - 1) { a.done = true; this.last = a; this.access = null; }
        return;
      }
    }
    if (!this.loop || missed) this.bits[L] = 0;
  }
  /** Tube position of slot label L in slots from the transmitting end (0) to the receiving end (576). */
  pos(L: number): number { return ((((SLOTS - 1 - L + this.t) % SLOTS) + SLOTS) % SLOTS); }
}

/**
 * n reads of random words at random moments (rng in [0, 1)): the wait of each in slots. A word's first pulse reaches the gate
 * once per circulation, so the waits are flat over 0..575 and average about half of it.
 */
export function randomWaits(n: number, rng: () => number = Math.random): number[] {
  const t = new Tank(), out: number[] = [];
  for (let i = 0; i < n; i++) { t.t = Math.floor(rng() * SLOTS); out.push(t.waitFor(Math.floor(rng() * WORDS))); }
  return out;
}
/** Counts of waits in `bins` equal parts of one circulation. */
export const histogram = (waits: readonly number[], bins: number): number[] => {
  const h = new Array<number>(bins).fill(0);
  for (const w of waits) h[Math.min(bins - 1, Math.floor((w / SLOTS) * bins))]++;
  return h;
};

// ------------------------------------------------------------------ the drawing
/** Scene units: the tube is 240 long, so a unit is LENGTH_M / 240. */
export const TUBE_X0 = -120, TUBE_X1 = 120;
export const UNIT_M = LENGTH_M / (TUBE_X1 - TUBE_X0);
export const TUBE_R = OD_M / 2 / UNIT_M;
/** The mercury column: the bore is not in the sources, so the steel wall is drawn about a quarter of the radius. */
export const MERC_R = TUBE_R * 0.74;
export const PITCH = (TUBE_X1 - TUBE_X0) / SLOTS;
export const ACTIVE: Vec3 = [0, 7.5, 7.5];
/** The electronics: a row of chassis standing in front of the battery, low (y, z of their centres). */
export const ELEC_Y = -6, ELEC_Z = ACTIVE[2] + 15;
export const xOfPos = (pos: number): number => TUBE_X0 + (pos + 0.5) * PITCH;

/** The pulse's size in the drawing at position p (slots): launched clean, it weakens and spreads on the way. */
export const pulseShape = (pos: number): { amp: number; width: number } => {
  const f = pos / SLOTS;
  return { amp: 1 - 0.55 * f, width: 0.42 * (1 + 0.9 * f) };
};

/** The segments of word w's band on the tube at the tank's phase: [from, to) in slots, split where it wraps. */
export function bandOf(tank: { t: number }, w: number): [number, number][] {
  const s = ((((SLOTS - 1 - (w * SLOTS_PER_WORD + SLOTS_PER_WORD - 1) + tank.t) % SLOTS) + SLOTS) % SLOTS);
  return s + SLOTS_PER_WORD <= SLOTS ? [[s, s + SLOTS_PER_WORD]] : [[s, SLOTS], [0, s + SLOTS_PER_WORD - SLOTS]];
}

export function mercuryAnchors(_tank: Tank, _sel: number, compact = false): Anchor[] {
  const [, ay, az] = ACTIVE, out: Anchor[] = [];
  out.push({ text: 'sending crystal', p: [TUBE_X0 + 38, ay + TUBE_R, az], side: 't', n: [0, 1, 0] });
  out.push({ text: 'receiving crystal', p: [TUBE_X1 - 38, ay + TUBE_R, az], side: 't', n: [0, 1, 0] });
  out.push({ text: 'mercury in a steel tube', p: [0, ay + TUBE_R, az], side: 't', n: [0, 1, 0], minor: true });
  out.push({ text: 'backing', p: [TUBE_X1 + 9, ay + 2.2, az], side: 't', n: [0, 1, 0] });
  out.push({ text: 'amplifier', p: [80, ELEC_Y - 4, ELEC_Z + 5], side: 'b', n: [0, 0, 1] });
  out.push({ text: 'reshaper', p: [15, ELEC_Y - 4, ELEC_Z + 5], side: 'b', n: [0, 0, 1] });
  out.push({ text: 'gate', p: [-50, ELEC_Y - 4, ELEC_Z + 5], side: 'b', n: [0, 0, 1] });
  // A phone has room for two names, not seven (the view opens on the sending end).
  return compact ? out.filter((a) => ['sending crystal', 'gate'].includes(a.text)) : out;
}

