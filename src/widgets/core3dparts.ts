// A 4 x 4 plane of ferrite cores as parts (DOM-free, tested). Coincident-current selection (Forrester, US 2,736,880): a core
// sees the sum of the currents of the wires through it and flips only when that sum reaches the switching current Ic. One
// X and one Y wire at half the full drive put 2 x half = 0.9 A on the crossing core and 0.45 A on every other core of that
// row or column: below Ic, so those stay. A four-wire plane: X and Y select, a sense wire and an inhibit wire through every
// core. The sense wire runs diagonally through all sixteen, as Whirlwind's did (MIT Report R-221, 1954, section 5.24: "the
// sense winding runs along the diagonals"; IBM's S/360 planes shifted it two columns mid-plane instead, Ken Shirriff,
// https://www.righto.com/2019/04/a-look-at-ibm-s360-core-memory-in-1960s.html); the inhibit parallels the X wires. A
// three-wire plane merges sense and inhibit into that one diagonal wire.
//
// Read = drive the addressed core toward 0; a 1 flips and the sense wire pulses, a 0 does not move. The read destroys a 1, so
// the cycle ends with a write phase that puts back what was read; to put back (or write) a 0 the inhibit wire carries half
// the drive the other way, cancelling one half so the crossing core sees 0.45 A and holds.


export const N = 4;
/** The currents, amperes. The half-select drive is Whirlwind's, 0.45 A on each selected X and Y line, which R-221 (1954, section
 *  5.21) calls a selection plane, so a full select is 0.90 A. The switching current Ic is the model's own figure between them: R-221 quotes the current
 *  that switches a core within a set time (about 0.85 to 0.95 A), not a threshold, and the rectangular loop is the idealisation. */
export const HALF = 0.45, FULL = 2 * HALF, IC = 0.65;
/** The slider's range. The working window is Ic/2 <= half < Ic (0.325 .. 0.65 A). */
export const HALF_MIN = 0.3, HALF_MAX = 0.75;
/** "Drive spread": each core its own Ic, up to 20 % off (real cores vary with batch and temperature; the pattern is fixed so
 *  the picture repeats). */
const SPREAD = [0.2, -0.1, 0.05, -0.2, -0.15, 0.15, 0, 0.1, -0.05, 0.2, -0.2, 0.08, 0.12, -0.12, -0.02, 0.18];
export const icOf = (k: number, spread = false): number => (spread ? IC * (1 + SPREAD[k]) : IC);
/** The half-select currents that work: below the weakest core's Ic (no neighbour flips), and twice it reaching the strongest's. */
export function marginWindow(spread = false): { lo: number; hi: number } {
  const ics = Array.from({ length: 16 }, (_, k) => icOf(k, spread));
  return { lo: Math.max(...ics) / 2, hi: Math.min(...ics) };
}
export type Margin = 'low' | 'ok' | 'high';
export function marginOf(half: number, spread = false): Margin {
  const w = marginWindow(spread);
  return half >= w.hi - 1e-12 ? 'high' : half < w.lo - 1e-12 ? 'low' : 'ok';
}

/** Drive pattern: +1 toward writing a 1, -1 toward 0, 0 off, per X wire (row), Y wire (column) and the inhibit wire. */
export interface Drive { x: number[]; y: number[]; inh: number }
export const idle = (): Drive => ({ x: Array(N).fill(0), y: Array(N).fill(0), inh: 0 });
export const idx = (r: number, c: number): number => r * N + c;
export const rowOf = (k: number): number => Math.floor(k / N);
export const colOf = (k: number): number => k % N;

/** Net current through core k, amperes (toward 1 is positive). */
export const netOf = (d: Drive, k: number, half = HALF): number => half * (d.x[rowOf(k)] + d.y[colOf(k)] + d.inh);

/** The idealised square loop: a core goes to 1 at +Ic or more, to 0 at -Ic or less, and otherwise stays where it was. */
export function respond(bit: number, net: number, ic = IC): number {
  return net >= ic - 1e-12 ? 1 : net <= -ic + 1e-12 ? 0 : bit;
}

export function applyDrive(bits: readonly number[], d: Drive, half = HALF, spread = false): { after: number[]; flipped: number[]; net: number[] } {
  const net = bits.map((_, k) => netOf(d, k, half)), after = bits.map((b, k) => respond(b, net[k], icOf(k, spread)));
  return { after, net, flipped: bits.flatMap((b, k) => (after[k] !== b ? [k] : [])) };
}

export type Op = 'read' | 'write0' | 'write1';
export interface Phase {
  name: 'read' | 'clear' | 'restore' | 'write';
  title: string;
  drive: Drive;
  net: number[];
  before: number[];
  after: number[];
  /** Cores that changed state in this phase. */
  flipped: number[];
  /** The sense wire is looked at (read phase only); in the others it also sees the flip but nobody listens. */
  strobed: boolean;
  /** A pulse on the sense wire: the addressed core flipped. Only a 1 turning to 0 (or back) induces it. */
  pulse: boolean;
  /** The bit the sense amplifier reports (read phase only; else null). */
  senseBit: number | null;
  /** The half-select current this phase was driven with, amperes. */
  half: number;
  /** The addressed core did not end the phase at the value the phase aims for (a drive too weak, or inhibit failing to hold). */
  missed: boolean;
  /** Other cores that flipped (a drive past Ic on a half select): their data is lost. */
  stray: number[];
}

export interface PlanOpts { half?: number; spread?: boolean }

/** The two phases of a cycle at `addr`. Read: drive to 0, then rewrite what came out. Write v: clear, then write v. The
 *  inhibit wire carries the same current as a select half. A read writes back what the sense wire reported (a pulse or none),
 *  which with a drive out of the window is not what was stored. */
export function planOp(bits: readonly number[], addr: number, op: Op, o: PlanOpts = {}): Phase[] {
  const half = o.half ?? HALF, spread = o.spread ?? false, r = rowOf(addr), c = colOf(addr), phases: Phase[] = [];
  const first = idle(); first.x[r] = -1; first.y[c] = -1;
  const a = applyDrive(bits, first, half, spread);
  const reading = op === 'read', pulse = a.flipped.length > 0, sensed = pulse ? 1 : 0;
  phases.push({
    name: reading ? 'read' : 'clear', title: reading ? 'Read: drive the core toward 0' : 'Clear: drive the core toward 0 first',
    drive: first, net: a.net, before: [...bits], after: a.after, flipped: a.flipped, strobed: reading, pulse,
    senseBit: reading ? sensed : null, half, missed: a.after[addr] !== 0, stray: a.flipped.filter((k) => k !== addr),
  });
  const v = reading ? sensed : op === 'write1' ? 1 : 0;
  const second = idle(); second.x[r] = 1; second.y[c] = 1; second.inh = v ? 0 : -1;
  const b = applyDrive(a.after, second, half, spread);
  phases.push({
    name: reading ? 'restore' : 'write', title: reading ? `Restore: write back the ${v} that was read` : `Write ${v}`,
    drive: second, net: b.net, before: [...a.after], after: b.after, flipped: b.flipped, strobed: false, pulse: b.flipped.length > 0, senseBit: null,
    half, missed: b.after[addr] !== v, stray: b.flipped.filter((k) => k !== addr),
  });
  return phases;
}

/** Cores on the addressed row or column, not the crossing: those that see exactly half. */
export const halfSelected = (addr: number): number[] =>
  Array.from({ length: N * N }, (_, k) => k).filter((k) => k !== addr && (rowOf(k) === rowOf(addr) || colOf(k) === colOf(addr)));

// The drawing is core3dkit.ts (the studio renderer, in true geometry); this file is the rule it draws.

/** One sentence for a whole cycle: faults merged across its phases, each stray core counted once. '' when the cycle was clean. */
export function cycleFault(plan: readonly Phase[], op: Op): string {
  const verb = op === 'read' ? 'Read' : 'Write', half = plan[0].half, cross = 2 * half;
  const strays = new Set(plan.flatMap((p) => p.stray)), out: string[] = [];
  if (plan.some((p) => p.missed)) {
    out.push(cross < IC - 1e-12
      ? `${verb} failed: the addressed core never reached Ic (${cross.toFixed(2)} A against ${IC.toFixed(2)} A)`
      : `${verb} failed: the inhibit wire could not hold the addressed core (${half.toFixed(2)} A left against Ic ${IC.toFixed(2)} A)`);
  }
  if (strays.size) out.push(`${strays.size} other core${strays.size > 1 ? 's' : ''} flipped and lost ${strays.size > 1 ? 'their' : 'its'} data`);
  return out.length ? `${out.join('; ')}.` : '';
}
