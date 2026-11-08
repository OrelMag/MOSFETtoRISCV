// A Strowger group selector as a step-by-step machine: the vertical magnet lifts the shaft one level per dial pulse,
// then the rotary magnet turns the wipers along that level on its own until a free line, or past the last contact onto
// the 11th (overflow) step: busy tone. A final selector (the last in a train) is the same mechanism dialled twice: its
// rotary steps follow the second digit's pulses and a busy line gives the tone at once, without hunting; this models the
// group selector, which hunts. The same pulses reach the same level as lib/telegraph.ts DIAL_SELECTOR
// (tests/model-strowger.test.ts holds them equal for 0..7 pulses). What only this model has: 10 levels (the relay
// tree decodes a 3-bit count, so it wraps at 8), the rotary hunt over busy lines, the release order, and real time.

export const LEVELS = 10, LINES = 10;
/** The rotary step past the last contact of a level: a fully busy level ends here (US2440277's "11th step contacts"). */
export const OVERFLOW = LINES + 1;
/** A dial sends 10 pulses a second. */
export const PULSE_MS = 100;
/** The loop is open (break) for 66 % of each pulse, 63 to 72 % accepted: the British Post Office's standard (J. Atkinson,
 *  Telephony vol. 1, Pitman 1948, p. 142; BT SIN 351), the system whose two-motion selectors this resembles. The vertical
 *  magnet pulls while the line relay is released, i.e. during the break. (A "60 / 40 Bell" ratio is often quoted; no
 *  primary source for it was found.) */
export const BREAK_MS = 66;
/** The pause before the hunt starts, one pulse period. An assumption, as are HUNT_MS (the rotary magnet interrupts itself)
 *  and the release times below. */
export const GAP_MS = 100;
export const HUNT_MS = 30;
/** Release: the release magnet frees the pawls, the shaft's spring turns it back to its home angle, and only then does
 *  gravity drop it (an interlock keeps it from falling while turned). */
export const TURN_HOME_MS = 80, DROP_MS = 120;

export type Mode = 'home' | 'climb' | 'hunt' | 'connected' | 'busy' | 'release';
export interface State { level: number; line: number; mode: Mode }
/** Level 0 and line 0 are rest: the shaft down, the wipers clear of the first contact. */
export const HOME: State = { level: 0, line: 0, mode: 'home' };
export interface Frame { t: number; s: State }

/** Pulses a digit sends: 1 to 9 as written, 0 is ten. */
export const pulsesOf = (digit: number): number => (digit === 0 ? 10 : digit);

/** One dial pulse: the vertical magnet raises the shaft a level (a pulse past the top does nothing). */
export const vertical = (s: State): State => ({ level: Math.min(LEVELS, s.level + 1), line: 0, mode: 'climb' });

/** One rotary step: onto the next line, taken if free; past a fully busy level onto the 11th step, the busy tone. */
export function hunt(s: State, busy: readonly boolean[]): State {
  const line = s.line + 1;
  if (line > LINES) return { level: s.level, line: OVERFLOW, mode: 'busy' };
  return { level: s.level, line, mode: busy[line - 1] ? 'hunt' : 'connected' };
}

/** Hanging up from s: turn back to the home angle first (level held), then drop. At rest nothing moves. */
export function release(s: State): Frame[] {
  if (s.level === 0 && s.line === 0) return [{ t: 0, s: HOME }];
  const out: Frame[] = [{ t: 0, s: { ...s, mode: 'release' } }];
  let t = 0;
  if (s.line) out.push({ t: (t += TURN_HOME_MS), s: { level: s.level, line: 0, mode: 'release' } });
  out.push({ t: t + DROP_MS, s: HOME });
  return out;
}

/** A whole call: busy[level - 1][line - 1]. Dialled while off normal, the selector is released first. The first frame
 *  is where it starts, the last is where it ends. */
export function call(digit: number, busy: readonly (readonly boolean[])[], from: State = HOME): Frame[] {
  const out = release(from), n = pulsesOf(digit);
  let s = HOME, t = out[out.length - 1].t;
  for (let k = 0; k < n; k++) { s = vertical(s); t += PULSE_MS; out.push({ t, s }); }
  s = { ...s, mode: 'hunt' };
  t += GAP_MS;
  do { s = hunt(s, busy[s.level - 1] ?? []); t += HUNT_MS; out.push({ t, s }); } while (s.mode === 'hunt');
  return out;
}

/** The state at time t (ms): the last frame at or before it. */
export function stateAt(frames: readonly Frame[], t: number): State {
  let s = frames[0].s;
  for (const f of frames) if (f.t <= t) s = f.s;
  return s;
}

/** The vertical magnet is pulling at t: inside a pulse's break, which ends with that pulse's frame (the level stepped). */
export function verticalPulling(frames: readonly Frame[], t: number): boolean {
  return frames.some((f) => f.s.mode === 'climb' && t >= f.t - BREAK_MS && t < f.t);
}
