// "Cancel the echo" (cap_echo, DOM-free): the learner writes the adaptive loop of an echo canceller in RV32IM assembly. The bench runs it on the golden
// model (FastISS) against echo paths drawn from a seed the learner never sees: the far end comes in one sample at a time, the program says what it
// thinks the echo is, and only then is the microphone sample (echo + noise) handed over to learn from. What is graded is the program's estimate against
// the real echo (never the program's own error), after a convergence window, within a cycle budget per sample.
//
// Programming model, and why: a memory-mapped sample port beside the program's RAM. Reading X takes the next far-end sample and starts a sample period;
// writing Y says the echo estimate; reading D (after Y) gives the microphone. A bare program on the golden model needs no operating system and costs
// nothing to run (about 10 M instructions per path per second), and the cycles are counted from instructions retired, not guessed.

import { erleDb, farEnd } from '../dsp/adaptive';
import { gaussian, rng } from '../phys/line';
import { assemble } from '../riscv/asm';
import { groupDigits } from '../sim/numfmt';
import { FastISS } from '../riscv/fastiss';
import { assembleDsp, dspReference, DSP_STARTER, runDsp, type RawRun } from './capechodsp';

// ---- the sheet ----------------------------------------------------------------------------------------

export const ECHO_SPEC = {
  /** Samples per path, and the first `window` of them are the learner's to converge in. */
  samples: 16000,
  window: 12000,
  /** ERLE the program must reach, over samples window … samples − 1, on every path. */
  erleDb: 25,
  /** Longest echo tail, in taps at 8 kHz (12 ms), and the mic noise (LSB rms). */
  maxTaps: 96,
  rate: 8000,
  noiseLsb: 6,
  /** Hard real-time: no sample may take longer from one x read to the next (instructions retired, one cycle each). */
  budget: 2400,
  /** Time allowed before the first x read (initialising), and the program's size. */
  setup: 20000,
  codeWords: 512,
  ramWords: 4096,
  paths: 4,
} as const;

/** Line noise under the speech, as a fraction of full scale: a telephone line is never silent, and it keeps the speech from being a pure two-resonance sound. */
const SPEECH_FLOOR = 0.02;

export const ECHO_IO = { x: 0x10000000, y: 0x10000004, d: 0x10000008 } as const;

export type EchoMachineId = 'rv32im' | 'mac' | 'dsp';
export interface MachineChoice { id: EchoMachineId; name: string; ready: boolean; note: string }
/** The machines the brief offers. One bar for all (25 dB, `ECHO_SPEC.budget` cycles a sample): the lesson is the cycles each machine reports. */
export const ECHO_MACHINES: MachineChoice[] = [
  { id: 'rv32im', name: 'RV32IM', ready: true, note: 'The golden model of the book: every instruction one cycle, mul and div included. Assembly, with the sample port.' },
  { id: 'mac', name: 'RV32 + MAC', ready: true, note: "The same core and port, plus the MAC chapter's custom-2 instructions: mac, mac2, clracc, racc, one 40-bit accumulator." },
  { id: 'dsp', name: 'DSP core', ready: true, note: "The book's DSP24: X and Y memories, address generators, zero-overhead loops and a 40-bit accumulator. Its own assembly; two reserved words are the sample port." },
];
export const machineName = (id: EchoMachineId): string => ECHO_MACHINES.find((m) => m.id === id)!.name;

// ---- the echo paths -----------------------------------------------------------------------------------

export type TailClass = 'short' | 'medium' | 'long';
export interface EchoPath {
  index: number;
  taps: number;
  cls: TailClass;
  source: 'speech' | 'noise';
  delay: number;
  erlDb: number;
  /** Far end, the true echo, and the microphone (echo + noise), as the 16-bit integers the port hands out. */
  x: Int32Array;
  echo: Int32Array;
  d: Int32Array;
}

const CLASS_OF: Record<TailClass, [number, number]> = { short: [16, 32], medium: [48, 64], long: [96, 96] };
export const tailWord = (c: TailClass): string => `${c} tail (${CLASS_OF[c][0] === CLASS_OF[c][1] ? '' : 'up to '}${CLASS_OF[c][1]} taps)`;

/** A room or a hybrid of `taps` taps: a delay, sparse reflections dying to about −10 dB at the far end of the tail (so a 96-tap tail needs its 96 taps), scaled to an echo return loss. */
export function echoImpulse(seed: number, taps: number, erlDb: number): { h: number[]; delay: number } {
  const u = rng(seed), h = new Array<number>(taps).fill(0), delay = 5 + Math.floor(u() * 10), tau = (taps - delay) / 1.2;
  for (let i = delay; i < taps; i++) if (u() < 0.45 || i === delay) h[i] = gaussian(u) * Math.exp(-(i - delay) / tau);
  const e = h.reduce((a, b) => a + b * b, 0);
  const g = 10 ** (-erlDb / 20) / Math.sqrt(e);
  return { h: h.map((v) => v * g), delay };
}

/** The bench's paths for a seed: a short, two medium and a long tail, in an order drawn from the seed, over speech or noise, with different gains. */
export function echoPaths(seed: number, n: number = ECHO_SPEC.samples): EchoPath[] {
  const u = rng(seed * 7919 + 13);
  const classes: TailClass[] = ['short', 'medium', 'medium', 'long'];
  for (let i = classes.length - 1; i > 0; i--) { const j = Math.floor(u() * (i + 1)); [classes[i], classes[j]] = [classes[j], classes[i]]; }
  const sources: ('speech' | 'noise')[] = ['speech', 'noise', 'speech', 'noise'];
  for (let i = sources.length - 1; i > 0; i--) { const j = Math.floor(u() * (i + 1)); [sources[i], sources[j]] = [sources[j], sources[i]]; }
  return classes.map((cls, index) => {
    const [lo, hi] = CLASS_OF[cls], taps = lo + Math.floor(u() * (hi - lo + 1)), erlDb = 6 + u() * 10, ps = Math.floor(u() * 1e9);
    return makePath(index, cls, taps, erlDb, sources[index], ps, n);
  });
}

/** One path: the far end (speech over line noise, or white noise; `level` scales it), the room and the microphone with `noise` LSB rms. */
export function makePath(index: number, cls: TailClass, taps: number, erlDb: number, source: 'speech' | 'noise', ps: number, n: number, level = 1, noise: number = ECHO_SPEC.noiseLsb): EchoPath {
  const { h, delay } = echoImpulse(ps, taps, erlDb);
  const xf = source === 'speech' ? (() => { const g = rng(ps + 3), sp = farEnd(n, ps + 1); return sp.map((v) => 0.25 * v + SPEECH_FLOOR * gaussian(g)); })() : (() => { const g = rng(ps + 1); return Array.from({ length: n }, () => Math.max(-0.4, Math.min(0.4, 0.05 * gaussian(g)))); })();
  const x = Int32Array.from(xf, (v) => Math.round(v * 32767 * level));
  const echo = new Int32Array(n), d = new Int32Array(n), nz = rng(ps + 2);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = delay; k < taps && k <= i; k++) s += h[k] * x[i - k];
    echo[i] = Math.round(s);
    d[i] = echo[i] + Math.round(noise * gaussian(nz));
  }
  return { index, taps, cls, source, delay, erlDb, x, echo, d };
}

// ---- the machine --------------------------------------------------------------------------------------

/** What went wrong with one path's run, if anything. */
export interface PathFault {
  kind: 'protocol' | 'budget' | 'setup' | 'memory';
  /** In the learner's words. */
  message: string;
}

const hex = (a: number): string => `0x${(a >>> 0).toString(16)}`;
/** RAM is bytes 0 … RAM_BYTES − 1: a data access anywhere else (and not on the port) is a fault, not a wrap-around into the weights. */
export const RAM_BYTES = ECHO_SPEC.ramWords * 4;

/** The golden model with the sample port at 0x1000_0000 (+0 x, +4 y, +8 d): the bench's side of the protocol. Every data access goes through load / store here, so none can alias. */
class EchoMachine extends FastISS {
  /** Sample index in progress; −1 before the first x. */
  at = -1;
  /** 0: waiting for x, 1: x taken, y due, 2: y written, d may be read. */
  phase = 0;
  y: number[] = [];
  fault: PathFault | null = null;
  done = false;
  lastX = 0;
  worst = 0;
  total = 0;
  readonly nSamples: number;
  constructor(words: number[], readonly path: EchoPath, readonly budget: number, mac = false) {
    super(words, { dmemWords: ECHO_SPEC.ramWords, imemWords: ECHO_SPEC.codeWords, m: true, mac });
    this.nSamples = path.x.length;
    this.region.fill(1);
  }
  private stop(f: PathFault): void { if (!this.fault) this.fault = f; this.yieldNow = true; }
  private memFault(what: string, addr: number): number {
    this.stop({ kind: 'memory', message: `${what} at ${hex(addr)}${this.at >= 0 ? ` (sample ${this.at})` : ''}: outside the RAM (0 … ${hex(RAM_BYTES - 1)}) and the sample port. RAM does not wrap or alias` });
    return 0;
  }
  protected override load(addr: number, f3: number): number {
    addr >>>= 0;
    if (addr < RAM_BYTES) return super.load(addr, f3);
    const reg = addr - ECHO_IO.x, now = this.retiredNow, i = this.at;
    if (reg !== 0 && reg !== 8) return this.memFault('load', addr);
    if (f3 !== 2) { this.stop({ kind: 'memory', message: `${f3 === 0 || f3 === 4 ? 'lb' : 'lh'} from the sample port at ${hex(addr)}: the port takes whole words (lw, sw)` }); return 0; }
    if (reg === 0) {
      if (this.phase === 1) { this.stop({ kind: 'protocol', message: `sample ${i}: the next x was read but no ŷ was written for this one (one ŷ per x)` }); return 0; }
      if (i >= 0) {
        const took = now - this.lastX;
        this.total += took;
        if (took > this.worst) this.worst = took;
        if (took > this.budget) { this.stop({ kind: 'budget', message: `sample ${i} took ${groupDigits(took)} cycles, ${groupDigits(took - this.budget)} over the budget of ${groupDigits(this.budget)}` }); return 0; }
      } else if (now > ECHO_SPEC.setup) { this.stop({ kind: 'setup', message: `${groupDigits(now)} cycles of set-up before the first sample, over the ${groupDigits(ECHO_SPEC.setup)} allowed` }); return 0; }
      this.lastX = now;
      if (i + 1 >= this.nSamples) { this.done = true; this.yieldNow = true; return 0; }
      this.at = i + 1; this.phase = 1;
      return this.path.x[this.at] | 0;
    }
    if (this.phase === 0) { this.stop({ kind: 'protocol', message: i < 0 ? 'd read before any x: read x, write ŷ, then d' : `sample ${i}: d read again, or before the next x (the microphone belongs to the sample you have already answered)` }); return 0; }
    if (this.phase === 1) { this.stop({ kind: 'protocol', message: `sample ${i}: the microphone was read before ŷ was written. ŷ may not use the sample it is trying to cancel` }); return 0; }
    return this.path.d[this.at] | 0;
  }
  protected override store(addr: number, f3: number, v: number): void {
    addr >>>= 0;
    if (addr < RAM_BYTES) { super.store(addr, f3, v); return; }
    if (addr - ECHO_IO.x !== 4) { this.memFault('store', addr); return; }
    if (f3 !== 2) { this.stop({ kind: 'memory', message: `${f3 === 0 ? 'sb' : 'sh'} to ŷ: the port takes whole words (lw, sw)` }); return; }
    if (this.phase !== 1) {
      this.stop({ kind: 'protocol', message: this.phase === 0 ? 'ŷ written before any x was read (it must follow the x of its sample)' : `sample ${this.at}: ŷ written twice (one ŷ per x)` });
      return;
    }
    this.y[this.at] = v | 0;
    this.phase = 2;
  }
}

export interface PathResult {
  path: EchoPath;
  /** ERLE over the graded stretch (dB), at most 80. */
  erle: number;
  /** ERLE of each block of `BLOCK` samples, for the picture (null: no echo to cancel in it). */
  blocks: (number | null)[];
  pass: boolean;
  fault: PathFault | null;
  /** Samples answered, mean and worst cycles per sample. */
  answered: number;
  meanCycles: number;
  worstCycles: number;
  /** Samples whose ŷ was not 0, from the values the program wrote. */
  nonzero: number;
  /** The accumulator was used (mac, mac2) but cleared in fewer than half the samples (clracc; on the DSP clr or rndc): its text, or ''. */
  noClear: string;
  /** What clears the accumulator on the machine that made the run. */
  clearWith: string;
  /** One line saying why it failed, in the learner's terms (empty on a pass). */
  why: string;
}

export const BLOCK = 250;
export const CHUNK = 4000;

/** Run `words` on one path. */
export function runPath(words: number[], path: EchoPath, budget: number = ECHO_SPEC.budget, machine: EchoMachineId = 'rv32im'): PathResult {
  if (machine === 'dsp') return scorePath(path, runDsp(words, path, budget, ECHO_SPEC.setup));
  const m = new EchoMachine(words, path, budget, machine === 'mac'), n = path.x.length;
  let guard = 0;
  while (!m.done && !m.fault) {
    const before = m.retiredNow;
    m.run(CHUNK);
    if (!m.done && !m.fault) {
      const since = m.retired - (m.at >= 0 ? m.lastX : 0);
      // a program that answered the last sample and then stops (a jump to itself) is finished
      if (m.at === n - 1 && m.phase === 2 && (m.halted || m.retired === before)) m.done = true;
      // one that stops reading x is caught here: no x within the budget of the last one
      else if (m.at >= 0 && since > budget + CHUNK) m.fault = { kind: 'budget', message: `sample ${m.at} never reached the next x: ${groupDigits(since)} cycles and counting, over the budget of ${groupDigits(budget)}` };
      else if (m.at < 0 && m.retired > ECHO_SPEC.setup + CHUNK) m.fault = { kind: 'setup', message: `no x read in ${groupDigits(m.retired)} cycles (set-up allows ${groupDigits(ECHO_SPEC.setup)})` };
      else if (m.halted || m.retired === before) m.fault = { kind: 'protocol', message: `the program stopped (a jump to itself) after sample ${Math.max(m.at, 0)} of ${groupDigits(n)}: it must keep answering until the last` };
    }
    if (++guard > 200000) break;
  }
  if (!m.fault && m.done && m.phase === 1) m.fault = { kind: 'protocol', message: `sample ${m.at}: no ŷ written` };
  return scorePath(path, { y: m.y, fault: m.fault, worst: m.worst, total: m.total, clears: m.clrCount, accumulations: m.macCount, clearWith: 'clracc clears it' });
}

/** The graded numbers of a run, whichever machine made it. */
export function scorePath(path: EchoPath, run: RawRun): PathResult {
  const n = path.x.length, answered = run.y.length;
  const m = { y: run.y, fault: run.fault, worst: run.worst, total: run.total };
  const blocks: (number | null)[] = [];
  const y = Float64Array.from({ length: n }, (_, i) => (m.y[i] ?? 0));
  for (let b = 0; b + BLOCK <= n; b += BLOCK) {
    let a = 0, r = 0;
    for (let i = b; i < b + BLOCK; i++) { a += path.echo[i] ** 2; const e = path.echo[i] - y[i]; r += e * e; }
    blocks.push(a < 400 * BLOCK ? null : Math.max(-60, Math.min(80, 10 * Math.log10(a / (r + 1e-9)))));
  }
  const echoW = Array.from(path.echo.subarray(ECHO_SPEC.window)), resW = echoW.map((v, k) => v - y[ECHO_SPEC.window + k]);
  const e = erleDb(echoW, resW), erle = Number.isFinite(e) ? Math.min(80, e) : 80;
  const mean = answered > 1 ? m.total / Math.max(1, answered - 1) : 0;
  const nonzero = m.y.reduce((s, v) => s + (v !== 0 ? 1 : 0), 0);
  const res: PathResult = { path, erle, blocks, pass: false, fault: m.fault, answered, meanCycles: mean, worstCycles: m.worst, nonzero, noClear: (run.accumulations ?? 0) > 0 && (run.clears ?? 0) < answered / 2 ? `${run.clears ? `cleared in only ${groupDigits(run.clears)} of ${groupDigits(answered)} samples` : 'never cleared'}` : '', clearWith: run.clearWith ?? '', why: '' };
  res.why = whyNot(res);
  res.pass = res.why === '';
  return res;
}

/** How far the ERLE of the graded blocks wanders (standard deviation, dB). */
export function wobble(r: PathResult): number {
  const t = r.blocks.slice(ECHO_SPEC.window / BLOCK).filter((b): b is number => b !== null), m = t.reduce((a, b) => a + b, 0) / Math.max(1, t.length);
  return Math.sqrt(t.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, t.length));
}

/** The reason a path failed, from what the bench saw (the values written, the ERLE curve), or ''. It says only what the curve shows: the cause is found by experiment (diagnose), not guessed from a curve that several faults share. */
export function whyNot(r: PathResult): string {
  const p = r.path, tag = `path ${p.index + 1} (${tailWord(p.cls)}, ${p.source})`;
  if (r.fault) return `${tag}: ${r.fault.message}`;
  const need = ECHO_SPEC.erleDb, f = (v: number) => `${v.toFixed(1)} dB`;
  if (r.erle >= need) return '';
  const graded = ECHO_SPEC.samples - ECHO_SPEC.window;
  const reached = `ERLE ${f(r.erle)} over the last ${groupDigits(graded)} samples, ${f(need)} needed`;
  const w0 = ECHO_SPEC.window / BLOCK, tail = r.blocks.slice(w0).filter((b): b is number => b !== null);
  const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / Math.max(1, v.length);
  const first = mean(tail.slice(0, 4)), last = mean(tail.slice(-4));
  const sd = Math.sqrt(mean(tail.map((b) => (b - mean(tail)) ** 2)));
  if (r.answered > 0 && r.nonzero === 0) return `${tag}: ${reached}. ŷ was 0 on every one of the ${groupDigits(r.answered)} samples: nothing is subtracted, so the weights never move or the filter's output is never what is written.`;
  if (r.noClear) return `${tag}: ${reached}. The accumulator is ${r.noClear}: each sample's sum adds onto the last one's (${r.clearWith}).`;
  if (r.erle < -3) {
    // a constant, an old sample or a wrong scale is wrong by about the echo's own size, steadily; an error far past that has run away; one that was right at times and far off at others is unstable
    const all = r.blocks.filter((b): b is number => b !== null), hi = Math.max(...all), lo = Math.min(...all);
    const swing = hi - lo > 15 && r.erle >= -15;
    const lead = `${tag}: ${reached}. The residual is ${f(-r.erle)} louder than the echo itself. `;
    if (swing) return `${lead}It was not wrong throughout: its ERLE swung between ${f(hi)} and ${f(lo)} from block to block, so it is unstable on this far end (a step too large for the signal's bursts does this).`;
    return lead + (r.erle < -15
      ? "It ran away, the error growing far past the echo: the update's sign is wrong or the step is too large for the signal."
      : "It was wrong from the start and stayed so: ŷ is not an estimate of the echo (a constant, an old sample, a wrong scale), or the update's sign is wrong.");
  }
  if (last - first > 1.2) return `${tag}: ${reached}. It was still rising: ${f(first)} over the first blocks of the graded stretch, ${f(last)} over the last.`;
  return `${tag}: ${reached}. It had levelled off there, within ${sd.toFixed(1)} dB from block to block.`;
}

// ---- the diagnosis, by experiment ---------------------------------------------------------------------

/** The two paths the bench controls for diagnosis: a 16-tap tail with steady white noise at the usual level, and the same with the far end 20 dB quieter (the microphone noise too, so the signal-to-noise ratio is the same). */
export const PROBE = { taps: 16, erlDb: 10, seed: 4242, quietDb: 20 } as const;
export interface Probe { loud: number; quiet: number; /** 6 dB above the usual level: a step that scales with the signal's level changes the answer, a normalized one hardly does. */ louder: number }

/** Run the program on both probe paths (about a second): the ERLE it reaches on each. */
export function probeEcho(words: number[], machine: EchoMachineId = 'rv32im'): Probe {
  const n = ECHO_SPEC.samples, q = 10 ** (-PROBE.quietDb / 20);
  const run = (level: number, noise: number) => runPath(words, makePath(0, 'short', PROBE.taps, PROBE.erlDb, 'noise', PROBE.seed, n, level, noise), ECHO_SPEC.budget, machine).erle;
  return { loud: run(1, ECHO_SPEC.noiseLsb), quiet: run(q, ECHO_SPEC.noiseLsb * q), louder: run(2, 2 * ECHO_SPEC.noiseLsb) };
}

/**
 * Why the failing paths fail, as facts from the probes: when no path faulted and some ended up near or above the echo's own level, the program is run again on the probe paths.
 * ``Works on the probe'' puts the fault in what the failing paths add (their tail, their far end); ``falls short'' puts it in the update itself, and the quieter probe says whether
 * the step scales with the signal's level. '' when there is nothing to diagnose.
 */
export function diagnose(words: number[], results: readonly PathResult[], machine: EchoMachineId = 'rv32im'): string {
  // paths that ran away, were wrong from the start or never wrote a ŷ have their own words; the probe is for the ones that only fell short
  const failing = results.filter((r) => !r.pass && !r.fault && r.erle >= -3 && r.nonzero > 0);
  if (!failing.length || results.some((r) => r.fault)) return '';
  const { loud, quiet, louder } = probeEcho(words, machine), need = ECHO_SPEC.erleDb, f = (v: number) => `${v.toFixed(1)} dB`;
  const head = `Run on a 16-tap tail with steady white noise, your program reaches ${f(loud)} at the usual far-end level, ${f(quiet)} with the far end 20 dB quieter and ${f(louder)} with it 6 dB louder (${f(need)} needed).`;
  if (loud >= need) {
    const reach = Math.max(...failing.map((r) => CLASS_OF[r.path.cls][1])), speech = failing.some((r) => r.path.source === 'speech');
    // another path ended worse than no filter at all: on bursts the update is unstable, which is not the slow step the sentence below would suggest raising
    if (results.some((r) => !r.pass && !r.fault && (r.erle < -3 || wobble(r) > 6))) return `${head} So the update works there. What the failing path${failing.length > 1 ? 's add' : ' adds'} is a tail up to ${reach} taps${speech ? " and speech's bursts and colour" : ''}, and a path ended worse than no filter at all or wandered by more than 6 dB from block to block: on bursts the update is unstable, which is what a step too large for them does. Do not raise the step.`;
    // a slow step still finishes a 16-tap tail, so passing the probe cannot tell too few taps from too small a step: name both
    return `${head} So the update works there. What the failing path${failing.length > 1 ? 's add' : ' adds'} is a tail up to ${reach} taps${speech ? ' and speech\'s bursts and colour' : ''}. Two causes fit, and the probe cannot tell them apart: a filter with fewer taps than that tail cannot cancel all of it, and a step too small still finishes a short tail but not a long one within the run. If your filter covers ${reach} taps, the step is the one to raise.`;
  }
  const where = 'not the tail length';
  if (quiet > loud + 10) return `${head} It falls short even there, so the fault is in the update, ${where}, and it does better when the signal is quieter: the step is too large at the usual level.`;
  // louder changes the answer a lot while the update is not a normalized one: the step scales with the signal's level (plain LMS)
  if (Math.abs(louder - loud) > 5) return `${head} It falls short even there, so the fault is in the update, ${where}, and the answer changes with the level (${f(quiet)} quieter, ${f(louder)} louder): the step does not scale with the signal's level (the update is not normalized by its energy).`;
  // quieter is much worse but louder is about the same: normalized, and so small that at a low level it stalls (rounding to the word length, or an energy floor above a quiet signal's energy)
  if (quiet < loud - 10) return `${head} It falls short even there, so the fault is in the update, ${where}. It does much worse when the signal is quieter but about the same when it is louder: the step does scale with the level, but it is so small that at a low level it stalls (rounding to the word length, or an energy floor larger than a quiet signal's energy). Raise the step.`;
  return `${head} It falls short even there, so the fault is in what the program computes from x and d, ${where}: the step size, the rounding (a truncating update biases the weights), or a ŷ that is not the filter's output.`;
}

// ---- the grade ----------------------------------------------------------------------------------------

export interface EchoVerdict {
  seed: number;
  ok: boolean;
  /** Assembly problems, or [] */
  errors: { line: number; message: string }[];
  results: PathResult[];
  /** The failing paths' reasons. */
  reasons: string[];
  /** Worst cycles over paths, mean over paths, lowest ERLE. */
  worstCycles: number;
  meanCycles: number;
  minErle: number;
  /** What the probe paths say about the failure (diagnose), or ''. */
  diagnosis: string;
}

/** Assemble the learner's program (or say what is wrong with it). */
export function assembleEcho(src: string, machine: EchoMachineId = 'rv32im'): { words: number[]; errors: { line: number; message: string }[] } {
  if (machine === 'dsp') return assembleDsp(src);
  const r = assemble(src, [], { mac: machine === 'mac' });
  const errors = [...r.errors];
  if (!errors.length && r.words.length > ECHO_SPEC.codeWords) errors.push({ line: 1, message: `${r.words.length} words of code, ${ECHO_SPEC.codeWords} allowed` });
  return { words: r.words, errors };
}

/** Grade a program on a seed's paths. `paths` may be given (the page runs them one at a time). */
export function gradeEcho(src: string, seed: number, opts: { paths?: EchoPath[]; budget?: number; machine?: EchoMachineId } = {}): EchoVerdict {
  const a = assembleEcho(src, opts.machine);
  const empty: EchoVerdict = { seed, ok: false, errors: a.errors, results: [], reasons: [], worstCycles: 0, meanCycles: 0, minErle: 0, diagnosis: '' };
  if (a.errors.length) return empty;
  const results = (opts.paths ?? echoPaths(seed)).map((p) => runPath(a.words, p, opts.budget, opts.machine));
  return summarize(seed, results, a.words, opts.machine);
}

export function summarize(seed: number, results: PathResult[], words?: number[], machine: EchoMachineId = 'rv32im'): EchoVerdict {
  return {
    seed, ok: results.length === ECHO_SPEC.paths && results.every((r) => r.pass), errors: [], results, reasons: results.filter((r) => !r.pass).map((r) => r.why),
    worstCycles: Math.max(0, ...results.map((r) => r.worstCycles)), meanCycles: results.reduce((s, r) => s + r.meanCycles, 0) / Math.max(1, results.length),
    minErle: Math.min(...results.map((r) => r.erle)), diagnosis: words ? diagnose(words, results, machine) : '',
  };
}

// ---- the starter and the reference --------------------------------------------------------------------

export const ECHO_STARTER = `# Cancel the echo. One sample at a time, forever:
#   lw  x  <- 0x10000000   the far-end sample (16-bit signed, Q15)
#   sw  ŷ  -> 0x10000004   your estimate of the echo of x in the microphone
#   lw  d  <- 0x10000008   the microphone (echo + noise); readable only after ŷ is written
# RAM is words 0 … 4095 from address 0. Keep what you learn there; the registers start at 0.
        lui   s0, 0x10000          # s0 = the sample port
loop:   lw    t0, 0(s0)            # x[n]
        # ... filter: ŷ = Σ w[k] · x[n-k] ...
        sw    zero, 4(s0)          # ŷ = 0: nothing cancelled yet
        lw    t1, 8(s0)            # d[n]
        # ... e = d - ŷ, then move the weights toward the echo path ...
        j     loop
`;

export interface RefOpts {
  /** Taps. */
  taps?: number;
  /** e is shifted left by this before the division by the energy: 18 is a step μ = ½. */
  muShift?: number;
  /** false: the weights never change. */
  update?: boolean;
  /** −1 flips the update's sign. */
  sign?: 1 | -1;
  /** Idle loop iterations (two cycles each) per sample. */
  busy?: number;
  /** Write ŷ twice per sample. */
  twice?: boolean;
  /** The update's rounding term left out: it truncates (floors), which biases every weight downwards. */
  truncate?: boolean;
  /** Write ŷ only on every second sample. */
  skipY?: boolean;
  /** Read d before writing ŷ. */
  peek?: boolean;
}

/** The reference's shape, for the page (the tests pin them to the program: tests/capstone-echo.test.ts). */
export const REF_TAPS = 96, REF_Q = 14;
/** The muShift values at which the RV32IM and RV32 + MAC references pass (μ = 1/16 … 1; the tests pin both ends and the failing neighbours). */
export const RV_PASSING_SHIFTS = [15, 19] as const;

/** Cycles a sample of the reference takes, measured: the worst over a short run (the program has no data-dependent path). */
const refCycles = new Map<EchoMachineId, number>();
/** A full-scale square wave in, the echo path silent: it drives every data-dependent loop (the DSP reference's bit-length loop) to its longest. */
function squarePath(n: number): EchoPath {
  const x = Int32Array.from({ length: n }, (_, i) => (i % 2 ? 30000 : -30000));
  return { index: 0, taps: 0, cls: 'short', source: 'noise', delay: 0, erlDb: 0, x, echo: new Int32Array(n), d: new Int32Array(n) };
}
/**
 * The worst sample of the machine's reference, measured: the larger of a typical path's and the square wave's, 600 samples each (the ring wraps every 96).
 * No graded run is slower: tests/capstone-echo-machines.test.ts holds every graded run's worst at or below it.
 */
export function referenceCycles(machine: EchoMachineId = 'rv32im'): number {
  let c = refCycles.get(machine);
  if (c === undefined) {
    const w = assembleEcho(referenceFor(machine), machine).words;
    refCycles.set(machine, (c = Math.max(...[echoPaths(1, 600)[0], squarePath(600)].map((p) => runPath(w, p, ECHO_SPEC.budget, machine).worstCycles))));
  }
  return c;
}

/** The reference canceller: NLMS on 96 taps in Q14 weights, the history in a double-written ring so the window is contiguous. */
export function echoReference(o: RefOpts = {}): string {
  const N = o.taps ?? REF_TAPS, mu = o.muShift ?? 18, up = o.update ?? true, sub = o.sign === -1, ring = N * 4;
  return `# NLMS echo canceller: ${N} taps, weights in Q14 at address 0, x history (a ring written twice) at 0x400.
# ŷ = Σ w[k]·x[n-k];  e = d - ŷ;  w[k] += e·x[n-k] / (ε + Σ x²)   (step μ = ½)
        lui   s0, 0x10000          # the sample port
        lui   s2, 1                # 0x1000: the x ring
        srli  s2, s2, 2            # 0x400
        lui   s5, 2                # 8192: rounding for the Q14 sum
        lui   s6, 16               # 65536: rounding for the update
        li    s3, 0                # ring index p
        li    s4, 0                # Σ x²/256 over the window
loop:   lw    t0, 0(s0)            # x[n]
        addi  s3, s3, -1           # p = p - 1 (mod N): the newest sample sits at the lowest index
        bgez  s3, ok
        addi  s3, s3, ${N}
ok:     slli  t1, s3, 2
        add   t1, t1, s2           # &ring[p]
        lw    t2, ${ring}(t1)          # the sample leaving the window
        mul   t2, t2, t2
        srai  t2, t2, 12
        sub   s4, s4, t2
        mul   t3, t0, t0
        srai  t3, t3, 12
        add   s4, s4, t3           # energy updated
        sw    t0, 0(t1)
        sw    t0, ${ring}(t1)          # written at p and p+N: any N from p on are contiguous
        mv    t4, t1
        li    t5, 0                # &w[0]
        li    a2, 0
        li    a3, ${N}
fir:    lw    a4, 0(t5)
        lw    a5, 0(t4)
        mul   a4, a4, a5
        add   a2, a2, a4
        addi  t5, t5, 4
        addi  t4, t4, 4
        addi  a3, a3, -1
        bnez  a3, fir
        add   a2, a2, s5
        srai  a2, a2, 14           # ŷ in Q15
${o.peek ? '        lw    t0, 8(s0)\n' : ''}${o.skipY ? '        andi  t6, s3, 1\n        bnez  t6, noy\n' : ''}        sw    a2, 4(s0)
${o.twice ? '        sw    a2, 4(s0)\n' : ''}        lw    t0, 8(s0)            # d[n]
${o.skipY ? 'noy:    ' : '        '}sub   t0, t0, a2           # e
${o.busy ? `        li    a6, ${o.busy}\nidle:   addi  a6, a6, -1\n        bnez  a6, idle\n` : ''}        addi  t2, s4, 256          # ε + energy, scaled
        slli  t0, t0, ${mu}
        div   t0, t0, t2           # g = e / energy
        mv    t4, t1
        li    t5, 0
        li    a3, ${N}
upd:    lw    a5, 0(t4)
        mul   a5, a5, t0
${o.truncate ? '' : '        add   a5, a5, s6\n'}        srai  a5, a5, 17           # g·x[k] in Q14
        lw    a4, 0(t5)
        ${sub ? 'sub' : 'add'}   a4, a4, a5
${up ? '        sw    a4, 0(t5)' : '        # (weights not stored)'}
        addi  t5, t5, 4
        addi  t4, t4, 4
        addi  a3, a3, -1
        bnez  a3, upd
        j     loop
`;
}

/** A seed for an attempt: the learner never sees it. */
export const freshSeed = (): number => (Math.floor(Math.random() * 1e6) + (Date.now() % 1000)) | 0;

// ---- the machines' own starters and references -----------------------------------------------------------

export interface MacRefOpts {
  /** Taps. */
  taps?: number;
  /** Taps per pass of the FIR loop (1 = rolled) and of the update loop. */
  unroll?: number;
  updUnroll?: number;
  /** e is shifted left by this before the division by the energy (18 is μ = ½). */
  muShift?: number;
  /** false: the weights never change. */
  update?: boolean;
  /** −1 flips the update's sign. */
  sign?: 1 | -1;
  /** Leave racc out: ŷ is whatever register a2 held. */
  noRacc?: boolean;
  /** Leave clracc out: the accumulator keeps growing across samples. */
  noClr?: boolean;
  /** Idle loop iterations per sample. */
  busy?: number;
}

/** The reference canceller on the RV32 + MAC: NLMS, the FIR in mac (a tap in lw lw mac), weights 16-bit Q15 one a word, racc with shift 15, the update in software (mul: the step is wider than 16 bits). */
export function macReference(o: MacRefOpts = {}): string {
  const N = o.taps ?? REF_TAPS, U = o.unroll ?? 4, V = o.updUnroll ?? 4, ring = N * 4, mu = o.muShift ?? 18, up = o.update ?? true;
  const body = (n: number, f: (i: number) => string[], step: string[], label: string, back: string): string => {
    const l: string[] = [];
    for (let i = 0; i < n; i++) l.push(...f(i));
    l.push(...step, back);
    return `${label}: ${l.join('\n')}`;
  };
  const fir = body(U, (i) => [`lw a4, ${4 * i}(t5)`, `lw a5, ${4 * i}(t4)`, 'mac a4, a5'], [`addi t5, t5, ${4 * U}`, `addi t4, t4, ${4 * U}`], 'fir', 'bne t5, t6, fir');
  const upd = body(V, (i) => [`lw a5, ${4 * i}(t4)`, 'mul a5, a5, t0', 'add a5, a5, s6', 'srai a5, a5, 16', `lw a4, ${4 * i}(t5)`, `${o.sign === -1 ? 'sub' : 'add'} a4, a4, a5`, ...(up ? [`sw a4, ${4 * i}(t5)`] : [])], [`addi t5, t5, ${4 * V}`, `addi t4, t4, ${4 * V}`], 'upd', 'bne t5, t6, upd');
  return `# NLMS echo canceller on the RV32 + MAC: ${N} taps, weights in Q15 one a word at address 0, the x ring (written twice) at 0x400.
# ŷ = racc(Σ w[k]·x[n-k], 15) with one mac a tap;  e = d - ŷ;  w[k] += e·x[n-k] / (ε + Σ x²)   (the update in software)
        lui   s0, 0x10000          # the sample port
        lui   s2, 1
        srli  s2, s2, 2            # 0x400: the x ring
        lui   s6, 8                # 32768: rounding for the update
        li    s7, 15               # racc's shift
        li    s3, 0                # ring index p
        li    s4, 0                # Σ x²/4096 over the window
        li    t6, ${ring}              # the end of the weights
loop:   lw    t0, 0(s0)            # x[n]
        addi  s3, s3, -1
        bgez  s3, ok
        addi  s3, s3, ${N}
ok:     slli  t1, s3, 2
        add   t1, t1, s2           # &ring[p]
        lw    t2, ${ring}(t1)          # the sample leaving the window
        mul   t2, t2, t2
        srai  t2, t2, 12
        sub   s4, s4, t2
        mul   t3, t0, t0
        srai  t3, t3, 12
        add   s4, s4, t3
        sw    t0, 0(t1)
        sw    t0, ${ring}(t1)
        mv    t4, t1
        li    t5, 0
${o.noClr ? '' : '        clracc\n'}${fir}
${o.noRacc ? '        li    a2, 0\n' : '        racc  a2, s7\n'}        sw    a2, 4(s0)
${o.busy ? `        li    a6, ${o.busy}\nidle:   addi  a6, a6, -1\n        bnez  a6, idle\n` : ''}        lw    t0, 8(s0)            # d[n]
        sub   t0, t0, a2           # e
        addi  t2, s4, 256
        slli  t0, t0, ${mu}
        div   t0, t0, t2           # g = e / energy
        mv    t4, t1
        li    t5, 0
${upd}
        j     loop
`;
}

export const MAC_STARTER = `# Cancel the echo on the RV32 + MAC: the same port and RAM as the RV32IM, plus four custom-2 instructions (chapter "A MAC on the RV32"):
#   clracc            acc <- 0               mac  rs1, rs2    acc += lo16(rs1) * lo16(rs2)
#   mac2 rs1, rs2     acc += both 16-bit halves multiplied     racc rd, rs1     rd <- round(acc >> rs1[5:0]), clamped to 32 bits
#   lw  x  <- 0x10000000   the far-end sample (16-bit signed, Q15)
#   sw  ŷ  -> 0x10000004   your estimate of the echo of x in the microphone
#   lw  d  <- 0x10000008   the microphone (echo + noise); readable only after ŷ is written
# RAM is words 0 … 4095 from address 0. Keep what you learn there; the registers start at 0.
        lui   s0, 0x10000          # s0 = the sample port
loop:   lw    t0, 0(s0)            # x[n]
        # ... filter: clracc, then mac w[k], x[n-k] for each tap, then racc ...
        sw    zero, 4(s0)          # ŷ = 0: nothing cancelled yet
        lw    t1, 8(s0)            # d[n]
        # ... e = d - ŷ, then move the weights toward the echo path ...
        j     loop
`;

export const ECHO_STARTERS: Record<EchoMachineId, string> = { rv32im: ECHO_STARTER, mac: MAC_STARTER, dsp: DSP_STARTER };
/** The machine's reference program (shown after a pass on that machine). */
export const referenceFor = (m: EchoMachineId): string => (m === 'dsp' ? dspReference() : m === 'mac' ? macReference() : echoReference());
