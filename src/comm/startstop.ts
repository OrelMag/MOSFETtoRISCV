// Start-stop framing and what a receiver whose clock is slightly off sees (chapter exchange; chapter uart's UART reuses it with
// another frame). DOM-free. A frame is a start unit (line 0), `data` units sent bit 1 first, an optional parity unit and
// a stop of `stop` units (line 1); the line idles at 1. The receiver's only synchronization is the start edge: after
// it, it samples at fixed offsets of its own clock, `pos` of the way into each bit. Time is in transmitter units.

export interface Frame {
  data: number;
  /** Stop length in units (1, 1.5, 2). */
  stop: number;
  parity?: 'even' | 'odd';
}

/** The teleprinter's: five data units, stop 1.5. */
export const ITA2_START_STOP: Frame = { data: 5, stop: 1.5 };
/** The common UART frame, 8 data bits, no parity, one stop bit. */
export const UART_8N1: Frame = { data: 8, stop: 1 };

/** Index of the first stop unit: the bits before it are start, data and parity. */
export const stopIndex = (f: Frame): number => 1 + f.data + (f.parity ? 1 : 0);
export const frameUnits = (f: Frame): number => stopIndex(f) + f.stop;

/** The parity bit that makes the data plus parity bit even (or odd) in ones. */
export function parityBit(f: Frame, code: number): number {
  let ones = 0;
  for (let i = 0; i < f.data; i++) ones += (code >> i) & 1;
  return f.parity === 'even' ? ones & 1 : (ones & 1) ^ 1;
}

export interface Segment { from: number; to: number; level: 0 | 1; label: string }

/** The frame as runs of line level. Each unit is a segment; the stop is one segment of `stop` units. */
export function segments(f: Frame, code: number): Segment[] {
  const s: Segment[] = [{ from: 0, to: 1, level: 0, label: 'start' }];
  for (let i = 0; i < f.data; i++) s.push({ from: 1 + i, to: 2 + i, level: ((code >> i) & 1) as 0 | 1, label: `d${i}` });
  if (f.parity) s.push({ from: 1 + f.data, to: 2 + f.data, level: parityBit(f, code) as 0 | 1, label: 'p' });
  s.push({ from: stopIndex(f), to: frameUnits(f), level: 1, label: 'stop' });
  return s;
}

/** Line level at transmitter time t (the idle line before and after the frame is 1). */
export function levelAt(f: Frame, code: number, t: number, backToBack = false): { level: 0 | 1; label: string } {
  for (const g of segments(f, code)) if (t >= g.from && t < g.to) return { level: g.level, label: g.label };
  // back to back: the next character's start unit follows at once
  if (backToBack && t >= frameUnits(f) && t < frameUnits(f) + 1) return { level: 0, label: 'next start' };
  return { level: 1, label: 'idle' };
}

export interface RxOptions {
  /** Receiver clock rate over the transmitter's, minus 1: positive, the receiver is fast and samples early. */
  err: number;
  /** Receiver ticks per bit (an oversampling UART counts 16); undefined: a continuous clock (a teleprinter's cam). */
  ticks?: number;
  /** Where in the start-edge tick the edge fell, 0 ≤ phase < 1: the receiver notices it that much of a tick late. */
  phase?: number;
  /** How far into a bit it samples (0.5: the middle). */
  pos?: number;
  /** The next character follows at once, so the line after the stop unit falls (the default: it idles at 1). */
  backToBack?: boolean;
}

export interface Sample { label: string; nominal: number; at: number; level: 0 | 1; sees: string }

export interface Received {
  samples: Sample[];
  word: number;
  stopOk: boolean;
  parityOk: boolean;
  /** Right word, stop seen as 1, parity as sent. */
  ok: boolean;
}

/** Transmitter time of the receiver's nominal sample instant `nominal` (in bits from the start edge). */
function sampleTime(nominal: number, o: RxOptions): number {
  const pos = o.ticks ? Math.round(nominal * o.ticks) / o.ticks : nominal;
  const late = o.ticks ? (o.phase ?? 0) / o.ticks : 0;
  return (pos + late) / (1 + o.err);
}

/** The receiver's frame: samples the data units, parity and the first stop unit, each `pos` of the way in. */
export function receive(f: Frame, code: number, o: RxOptions): Received {
  const pos = o.pos ?? 0.5, samples: Sample[] = [];
  const at = (label: string, unit: number) => {
    const nominal = unit + pos, t = sampleTime(nominal, o), r = levelAt(f, code, t, o.backToBack);
    samples.push({ label, nominal, at: t, level: r.level, sees: r.label });
    return r.level;
  };
  let word = 0;
  for (let i = 0; i < f.data; i++) word |= at(`d${i}`, 1 + i) << i;
  const p = f.parity ? at('p', 1 + f.data) : parityBit(f, code);
  const stop = at('stop', stopIndex(f));
  const parityOk = !f.parity || p === parityBit(f, code);
  return { samples, word, stopOk: stop === 1, parityOk, ok: word === code && stop === 1 && parityOk };
}

export interface Tolerance {
  /** Largest receiver error either way (fractions: 0.0556 is 5.56 %) at which every code is received, over the phases tried. */
  fast: number;
  slow: number;
  /** The first code to fail beyond each limit (the first of the codes tried: one whose last unit is 0, since a sample landing in a neighbour of equal level reads right). */
  failFast: number | null;
  failSlow: number | null;
  /** Codes tried. */
  codes: number;
}

/** Sweep the error outward from 0 until some code is received wrong, at the start edge phases given. */
export function tolerance(f: Frame, o: Omit<RxOptions, 'err'> = {}, step = 1e-4, max = 0.5, phases = o.ticks ? [0, 0.5, 0.999] : [0]): Tolerance {
  const codes = 2 ** f.data;
  const fails = (err: number): number | null => {
    for (let c = 0; c < codes; c++) for (const phase of phases) if (!receive(f, c, { ...o, err, phase }).ok) return c;
    return null;
  };
  const sweep = (sign: 1 | -1): [number, number | null] => {
    for (let e = step; e <= max; e += step) { const c = fails(sign * e); if (c !== null) return [e - step, c]; }
    return [max, null];
  };
  const [fast, failFast] = sweep(1), [slow, failSlow] = sweep(-1);
  return { fast, slow, failFast, failSlow, codes };
}

/** The same limits in closed form for a continuous receiver clock sampling `pos` of the way in. */
export function toleranceClosedForm(f: Frame, pos = 0.5, backToBack = false): { fast: number; slow: number } {
  const K = stopIndex(f);
  // fast: the stop sample, at (K + pos) / (1 + e), must stay at or after K, else it lands in the last data or parity unit
  // slow: the last data or parity sample, at (K - 1 + pos) / (1 + e), must stay before K, else it lands in the stop
  // back to back the stop sample, at (K + pos) / (1 + e), must also precede the next start edge at frameUnits
  const slow = (1 - pos) / K;
  return { fast: pos / K, slow: backToBack ? Math.min(slow, 1 - (K + pos) / frameUnits(f)) : slow };
}
