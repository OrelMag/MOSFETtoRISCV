// EDSAC's mercury delay line as numbers and parts (DOM-free, tested). The tube is the 1948 report's (Wilkes & Renwick,
// section 3.1): a mercury-filled steel tube of 1 inch external diameter, about 5 ft 4 in between its end blocks,
// a piezo-electric crystal at each end, 16 long numbers of 36 pulse intervals (P0 blank, P1..P34 digits, P35 sign)
// circulating, one major cycle long. Delay and capacity are computed here from length and sound speed, not typed in.

import type { RGB, RGBA } from '../gl/instances';
import type { Vec3 } from '../gl/math';
import { box, rod, wire, type Anchor, type Part } from '../gl/parts';

// ------------------------------------------------------------------ the physical tube and its figures
export const INCH_M = 0.0254;
/** Between the end blocks: "approximately 5 ft. 4 in." (the 1948 report, 3.1). */
export const LENGTH_M = (5 * 12 + 4) * INCH_M;
/** Outside diameter: "1 inch external diameter" (same place). The bore is not given in the sources used. */
export const OD_M = 1 * INCH_M;
/** Speed of sound in mercury near room temperature (a handbook figure, ~1450 m/s; it falls with temperature). */
export const SOUND_M_S = 1450;
/** The carrier a pulse modulates: 13.5 Mc/s (report, 3.1). */
export const CARRIER_HZ = 13.5e6;
/** The report's own figures, which the computed ones are held to: 0.9 µs pulses, 2 µs slots (500 kc/s), "about 1.15 ms", "about 870 c/s". */
export const REPORT = { pulseS: 0.9e-6, slotS: 2e-6, delayS: 1.15e-3, circHz: 870 } as const;

export const WORDS = 16, SLOTS_PER_WORD = 36, SLOTS = WORDS * SLOTS_PER_WORD;
/** Two batteries of sixteen tanks: 32 tanks, 512 long numbers (1024 short, 17-bit ones). */
export const BATTERIES = 2, TANKS_PER_BATTERY = 16;
export const TANKS = BATTERIES * TANKS_PER_BATTERY;
export const LONG_WORD_BITS = 35;

/** One trip down the tube: length / speed. */
export const delayS = (): number => LENGTH_M / SOUND_M_S;
/** The tank holds 576 slots, so a slot lasts delay / 576. */
export const slotS = (): number => delayS() / SLOTS;
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
export interface Access { kind: 'read' | 'write'; word: number; value: number; asked: number; started: number; got: number[]; done: boolean; waitSlots: number }

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
    this.access = { kind, word, value, asked: this.t, started: -1, got: [], done: false, waitSlots: 0 };
  }
  /** Advance by `d` slots; each whole slot that finishes its trip is processed in order. */
  advance(d: number): void {
    const from = Math.floor(this.t), to = Math.floor(this.t + d);
    this.t += d;
    for (let k = from + 1; k <= to; k++) this.arrive((k - 1) % SLOTS, k);
  }
  private arrive(L: number, tick: number): void {
    const a = this.access, w = Math.floor(L / SLOTS_PER_WORD), k = L % SLOTS_PER_WORD;
    if (a && !a.done && w === a.word) {
      if (a.started < 0 && k === 0) { a.started = tick; a.waitSlots = tick - Math.floor(a.asked) - 1; }
      if (a.started >= 0) {
        if (a.kind === 'read') { a.got.push(this.bits[L]); this.bits[L] = this.loop ? this.bits[L] : 0; }
        else this.bits[L] = wordSlots(a.value)[k];
        if (k === SLOTS_PER_WORD - 1) { a.done = true; this.last = a; this.access = null; }
        return;
      }
    }
    if (!this.loop) this.bits[L] = 0;
  }
  /** Tube position of slot label L in slots from the transmitting end (0) to the receiving end (576). */
  pos(L: number): number { return ((((SLOTS - 1 - L + this.t) % SLOTS) + SLOTS) % SLOTS); }
}

// ------------------------------------------------------------------ the drawing
export interface MercuryPalette {
  steel: RGB; steelClear: RGBA; mercury: RGB; quartz: RGBA; brass: RGB; housing: RGBA; pulse: RGB; pulseOff: RGB;
  bandA: RGBA; bandB: RGBA; bandSel: RGBA; panel: RGB; lamp: RGB; live: RGB; wire: RGB; cut: RGB;
}
/** Scene units: the tube is 240 long, so a unit is LENGTH_M / 240. */
export const TUBE_X0 = -120, TUBE_X1 = 120;
export const UNIT_M = LENGTH_M / (TUBE_X1 - TUBE_X0);
export const TUBE_R = OD_M / 2 / UNIT_M;
/** The mercury column: the bore is not in the sources, so the steel wall is drawn about a quarter of the radius. */
export const MERC_R = TUBE_R * 0.74;
export const PITCH = (TUBE_X1 - TUBE_X0) / SLOTS;
export const ACTIVE: Vec3 = [0, 7.5, 7.5];
const ELEC_Y = -17;
export const xOfPos = (pos: number): number => TUBE_X0 + (pos + 0.5) * PITCH;

const lit = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];

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

export function mercuryParts(tank: Tank, sel: number, P: MercuryPalette): Part[] {
  const out: Part[] = [], [, ay, az] = ACTIVE;
  // The housing every tank sits in (they must all be at one temperature) and the other fifteen tubes.
  out.push(box(P.housing, TUBE_X0 - 7, TUBE_X1 + 7, -12, 13, -12, 13));
  for (const y of [-7.5, -2.5, 2.5, 7.5]) for (const z of [-7.5, -2.5, 2.5, 7.5]) {
    if (y === ay && z === az) continue;
    out.push(rod(P.steel, [TUBE_X0, y, z], [TUBE_X1, y, z], TUBE_R, 0.3));
    out.push(box(P.brass, TUBE_X0 - 3, TUBE_X0, y - 1.6, y + 1.6, z - 1.6, z + 1.6), box(P.brass, TUBE_X1, TUBE_X1 + 3, y - 1.6, y + 1.6, z - 1.6, z + 1.6));
  }
  // The tank in use: mercury, the steel round it, a quartz crystal and a brass block at each end.
  out.push(rod(P.mercury, [TUBE_X0, ay, az], [TUBE_X1, ay, az], MERC_R, 0.7));
  out.push(rod(P.steelClear, [TUBE_X0, ay, az], [TUBE_X1, ay, az], TUBE_R, 0.3));
  out.push(box(P.brass, TUBE_X0 - 4, TUBE_X0 - 1.2, ay - 2.6, ay + 2.6, az - 2.6, az + 2.6, 0.4), box(P.brass, TUBE_X1 + 1.2, TUBE_X1 + 4, ay - 2.6, ay + 2.6, az - 2.6, az + 2.6, 0.4));
  out.push(rod(P.quartz, [TUBE_X0 - 1.2, ay, az], [TUBE_X0 + 0.2, ay, az], MERC_R, 0.5), rod(P.quartz, [TUBE_X1 - 0.2, ay, az], [TUBE_X1 + 1.2, ay, az], MERC_R, 0.5));
  // The words as bands under the tube, moving with the pulses; the chosen word is lit.
  for (let w = 0; w < WORDS; w++) for (const [a, b] of bandOf(tank, w)) {
    out.push(box(w === sel ? P.bandSel : w % 2 ? P.bandB : P.bandA, xOfPos(a) - PITCH / 2, xOfPos(b - 1) + PITCH / 2, ay - TUBE_R - 1.3, ay - TUBE_R - 0.3, az - 1.2, az + 1.2));
  }
  // The receiving slot's window.
  out.push(box([P.live[0], P.live[1], P.live[2], 0.35] as RGBA, TUBE_X1 - PITCH * 1.5, TUBE_X1, ay - TUBE_R - 0.4, ay + TUBE_R + 0.4, az - TUBE_R - 0.4, az + TUBE_R + 0.4));
  // The pulses: a slab across the bore per 1.
  for (let L = 0; L < SLOTS; L++) {
    if (!tank.bits[L]) continue;
    const pos = tank.pos(L), { amp, width } = pulseShape(pos), x = xOfPos(pos), hw = (width * PITCH) / 2;
    const p = rod(amp > 0.8 ? P.pulse : lit(P.pulse, 0.55 + amp * 0.5), [x - hw, ay, az], [x + hw, ay, az], MERC_R * 1.12, 0.1);
    p.emissive = lit(P.pulse, 0.55 * amp);
    out.push(p);
  }
  // The electronics under the battery: amplifier, reshaping against the clock, the recirculate / write gate.
  const bx = [80, 15, -50] as const, bw = 20;
  out.push(...wire(P.wire, [[TUBE_X1 + 2.6, ay, az], [TUBE_X1 + 2.6, ELEC_Y, az], [TUBE_X0 - 2.6, ELEC_Y, az], [TUBE_X0 - 2.6, ay, az]], 0.45));
  const arriving = tank.bits[tank.label] === 1;
  bx.forEach((x, i) => {
    const on = i === 2 ? !tank.loop || !!tank.access : arriving && tank.loop;
    out.push(box(P.panel, x - bw / 2, x + bw / 2, ELEC_Y - 4, ELEC_Y + 4, az - 5, az + 5, 0.2));
    const lamp = box(i === 2 && !tank.loop ? P.cut : on ? P.live : P.lamp, x - 2, x + 2, ELEC_Y + 4, ELEC_Y + 5.2, az - 2, az + 2);
    if (on) lamp.emissive = lit(i === 2 && !tank.loop ? P.cut : P.live, 0.6);
    out.push(lamp);
  });
  // The gate's lever: down on the recirculation path, over to the input when writing, open when the loop is cut.
  const lx = bx[2], lever = tank.loop ? (tank.access?.kind === 'write' ? 1 : 0) : 2;
  out.push(rod(P.brass, [lx - 6, ELEC_Y + 4, az + 5.2], [lx - 6 + [6, 11, 11][lever] * 0.8, ELEC_Y + 4 + [3.5, 5, 7][lever], az + 5.2], 0.6, 0.4));
  return out;
}

export function mercuryAnchors(tank: Tank, sel: number): Anchor[] {
  const [, ay, az] = ACTIVE, out: Anchor[] = [];
  const band = bandOf(tank, sel).sort((p, q) => q[1] - q[0] - (p[1] - p[0]))[0];
  out.push({ text: `word ${sel}`, p: [xOfPos((band[0] + band[1]) / 2 - 0.5), ay - TUBE_R - 1.3, az + 1.2], side: 'b', n: [0, -1, 0] });
  out.push({ text: 'sending crystal', p: [TUBE_X0 + 38, ay + TUBE_R, az], side: 't', n: [0, 1, 0] });
  out.push({ text: 'receiving crystal', p: [TUBE_X1 - 38, ay + TUBE_R, az], side: 't', n: [0, 1, 0] });
  out.push({ text: 'mercury in a steel tube', p: [0, ay + TUBE_R, az], side: 't', n: [0, 1, 0], minor: true });
  out.push({ text: 'amplifier', p: [80, ELEC_Y - 4, az + 5], side: 'b', n: [0, 0, 1] });
  out.push({ text: 'reshaper', p: [15, ELEC_Y - 4, az + 5], side: 'b', n: [0, 0, 1] });
  out.push({ text: 'gate', p: [-50, ELEC_Y - 4, az + 5], side: 'b', n: [0, 0, 1] });
  out.push({ text: '15 more tanks, one housing', p: [0, 13, -12], side: 't', n: [0, 1, 0], minor: true });
  return out;
}

