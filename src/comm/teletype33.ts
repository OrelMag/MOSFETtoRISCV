// The Teletype Model 33's serial selector as a kinematic model (DOM-free, tested): what the 3D model of chapter exchange's
// "Start-stop" step draws. The 33 runs at 110 baud: a start unit, eight levels (7-bit ASCII and even parity) and two stop
// units, 11 units of 9.09 ms, 100 ms a character (Wikipedia, Teletype Model 33). Its selector, as in Teletype's patents
// (US 3,406,254): the falling start edge lets the selector magnet's armature drop, the start lever trips the clutch, and
// the cam sleeve turns once with the always-turning main shaft; each of eight selector cams has one notch, offset round the
// sleeve so that notch i reaches its follower in the middle of data unit i; a follower drops into its notch only if the
// armature is marking then, and sets its push lever, which holds the level after the sleeve stops.
//
// The sleeve turns a little faster than one character (US 1,821,110: the receiver runs ahead so it is at rest before the
// next start): one revolution here is REV_UNITS = 10 units of its own clock, so its samples are exactly startstop.ts's
// receive(): unit k + ½ in the receiver's clock, transmitter time (k + ½) / (1 + err).

import { levelAt, receive, type Frame } from './startstop';

export const TTY33: Frame = { data: 8, stop: 2 };
export const BAUD = 110, UNIT_MS = 1000 / BAUD;
/** Receiver units per revolution of the cam sleeve. */
export const REV_UNITS = 10;
/** Where on the sleeve (degrees from the clutch's rest) cam i's notch is: the middle of data unit i. */
export const notchDeg = (i: number): number => (360 * (1 + i + 0.5)) / REV_UNITS;
/** How long a follower rides the notch, in units either side of its middle. */
export const NOTCH_HALF = 0.42;

/** An ASCII character as the 33 sends it: seven bits, bit 1 first, and even parity as the eighth level. */
export function ttyCode(ch: string): number {
  const c = ch.charCodeAt(0) & 0x7f;
  let ones = 0;
  for (let i = 0; i < 7; i++) ones += (c >> i) & 1;
  return c | ((ones & 1) << 7);
}

export interface TtyPose {
  /** Transmitter time in units since the start edge (negative: before it). */
  t: number;
  /** The line now: 1 marking (current), 0 spacing. */
  level: 0 | 1;
  /** The main shaft's angle (degrees, always turning) and the sleeve's (0 at rest … 360 once round). */
  shaft: number; sleeve: number;
  clutch: boolean;
  /** The armature: 1 attracted (marking), 0 released. */
  armature: number;
  /** Each follower's drop into its notch (0 … 1); each push lever set; what each has read (null: not yet). */
  drop: number[]; set: boolean[]; read: (0 | 1 | null)[];
}

/** The receiver's time since the start edge (its clock runs 1 + err times the transmitter's). */
const rxTime = (t: number, err: number) => t * (1 + err);

export function ttyPose(code: number, err: number, t: number): TtyPose {
  const f = TTY33, tau = rxTime(t, err), turning = t >= 0 && tau < REV_UNITS;
  const level = t < 0 ? 1 : levelAt(f, code, t).level;
  const drop: number[] = [], set: boolean[] = [], read: (0 | 1 | null)[] = [];
  for (let i = 0; i < f.data; i++) {
    const mid = 1 + i + 0.5, at = mid / (1 + err), bit = levelAt(f, code, at).level;
    const x = Math.abs(tau - mid) / NOTCH_HALF, inNotch = t >= 0 && x < 1;
    drop.push(inNotch && bit === 1 ? Math.cos((x * Math.PI) / 2) : 0);
    const done = t >= 0 && tau >= mid;
    read.push(done ? bit : null);
    set.push(done && bit === 1);
  }
  return {
    t, level, shaft: ((360 * rxTime(t, err)) / REV_UNITS) % 360,
    sleeve: t < 0 ? 0 : (360 * Math.min(tau, REV_UNITS)) / REV_UNITS, clutch: turning,
    armature: level, drop, set, read,
  };
}

/** The character the push levers hold after the revolution. */
export function leverWord(code: number, err: number): number {
  const p = ttyPose(code, err, REV_UNITS / (1 + err) + 0.01);
  return p.read.reduce<number>((w, b, i) => w | ((b ?? 0) << i), 0);
}

/** The same frame through startstop.ts: what the levers must agree with. */
export const startStopWord = (code: number, err: number): number => receive(TTY33, code, { err }).word;
