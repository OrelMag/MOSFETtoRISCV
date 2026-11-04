// A Strowger selector as a step-by-step machine: the vertical magnet lifts the shaft one level per dial pulse, then the
// rotary magnet turns the wipers along that level on its own until a free line or the end of the bank. The same
// pulses reach the same level as lib/telegraph.ts DIAL_SELECTOR (tests/model-strowger.test.ts holds them equal for
// 0..7 pulses). What only this model has: 10 levels (the relay tree decodes a 3-bit count, so it wraps at 8), the
// rotary hunt over busy lines, and real time.

export const LEVELS = 10, LINES = 10;
/** A dial sends 10 pulses a second (60 % break, 40 % make), the Bell System standard; from memory, not re-checked. */
export const PULSE_MS = 100;
/** The pause before the hunt starts, one pulse period. An assumption, as is HUNT_MS: the rotary magnet interrupts itself. */
export const GAP_MS = 100;
export const HUNT_MS = 30;

export type Mode = 'home' | 'climb' | 'hunt' | 'connected' | 'busy';
export interface State { level: number; line: number; mode: Mode }
/** Level 0 and line 0 are rest: the shaft down, the wipers clear of the first contact. */
export const HOME: State = { level: 0, line: 0, mode: 'home' };
export interface Frame { t: number; s: State }

/** Pulses a digit sends: 1 to 9 as written, 0 is ten. */
export const pulsesOf = (digit: number): number => (digit === 0 ? 10 : digit);

/** One dial pulse: the vertical magnet raises the shaft a level (a pulse past the top does nothing). */
export const vertical = (s: State): State => ({ level: Math.min(LEVELS, s.level + 1), line: 0, mode: 'climb' });

/** One rotary step: onto the next line, which is taken if free; off the end of a fully busy level is the busy tone. */
export function hunt(s: State, busy: readonly boolean[]): State {
  const line = s.line + 1;
  if (!busy[line - 1]) return { level: s.level, line, mode: 'connected' };
  return { level: s.level, line, mode: line >= LINES ? 'busy' : 'hunt' };
}

/** Hanging up lets the release magnet drop the shaft and return the wipers. */
export const release = (): State => HOME;

/** A whole call from rest: busy[level - 1][line - 1]. The first frame is rest, the last is where it ends. */
export function call(digit: number, busy: readonly (readonly boolean[])[]): Frame[] {
  const n = pulsesOf(digit), out: Frame[] = [{ t: 0, s: HOME }];
  let s = HOME, t = 0;
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
