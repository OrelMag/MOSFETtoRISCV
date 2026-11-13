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

// ---------------------------------------------------------------- the mechanism between frames
// What a drawing needs that the frames leave out: where the shaft and the wipers are part-way through a step, and how
// far each armature has moved. The frames stay the state; this only fills in between them, landing exactly on each frame.

/** The vertical armature's return after the break (its spring), and the rotary armature's share of a hunt step spent
 *  pulling (the rest is its return once the interrupter springs open its circuit): assumptions, like HUNT_MS. */
export const ARM_RETURN_MS = 20, ROTARY_PULL = 0.6;
export interface Motion {
  /** The shaft's height in levels and the wipers' angle in lines, fractional between frames. */
  level: number; line: number;
  /** Armature travel, 0 (released) to 1 (pulled home against the core). */
  vArm: number; rArm: number; relArm: number;
  /** The coils carrying current. */
  vOn: boolean; rOn: boolean; relOn: boolean;
  /** The holding pawls are in the ratchets (the release magnet lifts them). */
  held: boolean;
}
const smooth = (u: number): number => { const x = Math.min(1, Math.max(0, u)); return x * x * (3 - 2 * x); };

/** The mechanism at t (ms). The vertical armature closes over the break and lifts the shaft one tooth, the tooth
 *  completing as the frame lands (the level steps at the end of the break, as stateAt has it); it springs back in the
 *  make. A rotary step: the armature pulls for ROTARY_PULL of HUNT_MS, turning the wipers one contact, then its own
 *  interrupter lets it go. Release: the magnet holds the pawls off while the spring turns the shaft home, then it drops. */
export function motionAt(frames: readonly Frame[], t: number): Motion {
  let i = 0;
  for (let k = 0; k < frames.length; k++) if (frames[k].t <= t) i = k;
  const f = frames[i], s = f.s, n = frames[i + 1];
  const m: Motion = { level: s.level, line: s.line, vArm: 0, rArm: 0, relArm: 0, vOn: false, rOn: false, relOn: false, held: s.level > 0 };
  // the vertical armature springing back after the step just taken
  if (s.mode === 'climb' && i > 0 && frames[i - 1].s.level < s.level) m.vArm = 1 - smooth((t - f.t) / ARM_RETURN_MS);
  if (s.mode === 'release') {
    m.relOn = true; m.relArm = 1; m.held = false;
    if (n) {
      const u = (t - f.t) / (n.t - f.t);
      if (s.line && !n.s.line) m.line = s.line * (1 - smooth(u)); // the spring turns it home
      else if (!s.line && n.s.level < s.level) { const v = Math.min(1, Math.max(0, u)); m.level = s.level * (1 - v * v); } // then it falls
    }
    return m;
  }
  if (!n) return m;
  if (n.s.mode === 'climb' && n.s.level > s.level) {
    const u = (t - (n.t - BREAK_MS)) / BREAK_MS;
    if (u >= 0) { m.vOn = true; m.vArm = smooth(u); m.level = s.level + smooth(u); }
  } else if (n.s.level === s.level && n.s.line === s.line + 1) {
    const u = (t - (n.t - HUNT_MS)) / HUNT_MS;
    if (u > 0) {
      const p = u / ROTARY_PULL;
      m.rOn = u < ROTARY_PULL;
      m.rArm = u < ROTARY_PULL ? smooth(p) : 1 - smooth((u - ROTARY_PULL) / (1 - ROTARY_PULL));
      m.line = s.line + smooth(p);
    }
  }
  return m;
}
