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
import { FastISS } from '../riscv/fastiss';

// ---- the sheet ----------------------------------------------------------------------------------------

export const ECHO_SPEC = {
  /** Samples per path, and the first `window` of them are the learner's to converge in. */
  samples: 8000,
  window: 4000,
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

export interface MachineChoice { id: string; name: string; ready: boolean; note: string }
/** The machines the brief offers: only the first is built; the other two are another session's work. */
export const ECHO_MACHINES: MachineChoice[] = [
  { id: 'rv32im', name: 'RV32IM', ready: true, note: 'The golden model of the book: every instruction one cycle, mul and div included. Assembly, with the sample port below.' },
  { id: 'mac', name: 'RV32 + MAC', ready: false, note: 'Coming soon: a custom-2 multiply-accumulate unit that does a tap in one instruction.' },
  { id: 'dsp', name: 'DSP core', ready: false, note: 'Coming soon: the book\'s DSP core, with its own loop hardware.' },
];

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

const CLASS_OF: Record<TailClass, [number, number]> = { short: [16, 32], medium: [48, 64], long: [88, 96] };
export const tailWord = (c: TailClass): string => `${c} tail (up to ${CLASS_OF[c][1]} taps)`;

/** A room or a hybrid of `taps` taps: a delay, sparse reflections dying to −30 dB at the far end of the tail, scaled to an echo return loss. */
export function echoImpulse(seed: number, taps: number, erlDb: number): { h: number[]; delay: number } {
  const u = rng(seed), h = new Array<number>(taps).fill(0), delay = 5 + Math.floor(u() * 10), tau = (taps - delay) / 2.5;
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
    const { h, delay } = echoImpulse(ps, taps, erlDb);
    const source = sources[index];
    const xf = source === 'speech' ? (() => { const g = rng(ps + 3), sp = farEnd(n, ps + 1); return sp.map((v) => 0.25 * v + SPEECH_FLOOR * gaussian(g)); })() : (() => { const g = rng(ps + 1); return Array.from({ length: n }, () => Math.max(-0.4, Math.min(0.4, 0.05 * gaussian(g)))); })();
    const x = Int32Array.from(xf, (v) => Math.round(v * 32767));
    const echo = new Int32Array(n), d = new Int32Array(n), nz = rng(ps + 2);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let k = delay; k < taps && k <= i; k++) s += h[k] * x[i - k];
      echo[i] = Math.round(s);
      d[i] = echo[i] + Math.round(ECHO_SPEC.noiseLsb * gaussian(nz));
    }
    return { index, taps, cls, source, delay, erlDb, x, echo, d };
  });
}

// ---- the machine --------------------------------------------------------------------------------------

/** What went wrong with one path's run, if anything. */
export interface PathFault {
  kind: 'protocol' | 'budget' | 'silent' | 'setup';
  /** In the learner's words. */
  message: string;
}

/** The golden model with the sample port at 0x1000_0000 (+0 x, +4 y, +8 d): the bench's side of the protocol. */
class EchoMachine extends FastISS {
  n = 0;
  /** Sample index in progress; −1 before the first x. */
  at = -1;
  /** 0: waiting for x, 1: x taken, y due, 2: y written, d may be read. */
  phase = 0;
  y: number[] = [];
  fault: PathFault | null = null;
  done = false;
  lastX = 0;
  worst = 0;
  worstAt = 0;
  total = 0;
  readonly nSamples: number;
  constructor(words: number[], readonly path: EchoPath, readonly budget: number) {
    super(words, { dmemWords: ECHO_SPEC.ramWords, imemWords: ECHO_SPEC.codeWords, m: true });
    this.nSamples = path.x.length;
    this.region[1] = 1;
  }
  private stop(f: PathFault): void { if (!this.fault) this.fault = f; this.yieldNow = true; }
  protected override load(addr: number, f3: number): number {
    if (addr >>> 28 !== 1) return super.load(addr, f3);
    const reg = addr - ECHO_IO.x, now = this.retiredNow, i = this.at;
    if (reg === 0) {
      if (this.phase === 1) { this.stop({ kind: 'protocol', message: `sample ${i}: the next x was read but no ŷ was written for this one (one ŷ per x)` }); return 0; }
      if (i >= 0) {
        const took = now - this.lastX;
        this.total += took;
        if (took > this.worst) { this.worst = took; this.worstAt = i; }
        if (took > this.budget) { this.stop({ kind: 'budget', message: `sample ${i} took ${took.toLocaleString('en')} cycles, ${(took - this.budget).toLocaleString('en')} over the budget of ${this.budget.toLocaleString('en')}` }); return 0; }
      } else if (now > ECHO_SPEC.setup) { this.stop({ kind: 'setup', message: `${now.toLocaleString('en')} cycles of set-up before the first sample, over the ${ECHO_SPEC.setup.toLocaleString('en')} allowed` }); return 0; }
      this.lastX = now;
      if (i + 1 >= this.nSamples) { this.done = true; this.yieldNow = true; return 0; }
      this.at = i + 1; this.phase = 1;
      return this.path.x[this.at] | 0;
    }
    if (reg === 8) {
      if (this.phase === 0) { this.stop({ kind: 'protocol', message: `sample ${i}: d read before the next x (the microphone belongs to the sample you have already answered)` }); return 0; }
      if (this.phase === 1) { this.stop({ kind: 'protocol', message: `sample ${i}: the microphone was read before ŷ was written. ŷ may not use the sample it is trying to cancel` }); return 0; }
      return this.path.d[this.at] | 0;
    }
    return 0;
  }
  protected override store(addr: number, f3: number, v: number): void {
    if (addr >>> 28 !== 1) { super.store(addr, f3, v); return; }
    if (addr - ECHO_IO.x !== 4) return;
    if (this.phase !== 1) {
      this.stop({ kind: 'protocol', message: this.phase === 0 ? `ŷ written before any x was read (it must follow the x of its sample)` : `sample ${this.at}: ŷ written twice (one ŷ per x)` });
      return;
    }
    this.y[this.at] = v | 0;
    this.phase = 2;
  }
  /** The x read after a completed sample ends it; an unanswered one is caught at the next x. */
}

export interface PathResult {
  path: EchoPath;
  /** ERLE over the graded stretch (dB), −Infinity … 80. */
  erle: number;
  /** ERLE of each block of `BLOCK` samples, for the picture. */
  blocks: (number | null)[];
  pass: boolean;
  fault: PathFault | null;
  /** Samples answered, mean and worst cycles per sample. */
  answered: number;
  meanCycles: number;
  worstCycles: number;
  /** One line saying why it failed, in the learner's terms (empty on a pass). */
  why: string;
}

export const BLOCK = 250;
export const CHUNK = 4000;

/** Run `words` on one path. */
export function runPath(words: number[], path: EchoPath, budget: number = ECHO_SPEC.budget): PathResult {
  const m = new EchoMachine(words, path, budget), n = path.x.length;
  let guard = 0;
  while (!m.done && !m.fault) {
    const before = m.retiredNow;
    m.run(CHUNK);
    // a program that stops reading x is caught here: no x within the budget of the last one
    if (!m.done && !m.fault) {
      const since = m.retired - (m.at >= 0 ? m.lastX : 0);
      if (m.at >= 0 && since > budget + CHUNK) m.fault = { kind: 'budget', message: `sample ${m.at} never reached the next x: ${since.toLocaleString('en')} cycles and counting, over the budget of ${budget.toLocaleString('en')}` };
      else if (m.at < 0 && m.retired > ECHO_SPEC.setup + CHUNK) m.fault = { kind: 'setup', message: `no x read in ${m.retired.toLocaleString('en')} cycles (set-up allows ${ECHO_SPEC.setup.toLocaleString('en')})` };
      else if (m.halted || m.retired === before) m.fault = { kind: 'protocol', message: `the program stopped (a jump to itself) at sample ${Math.max(m.at, 0)}: it must keep answering` };
    }
    if (++guard > 200000) break;
  }
  const answered = m.y.length;
  if (!m.fault && m.done && m.phase === 1) m.fault = { kind: 'protocol', message: `sample ${m.at}: no ŷ written` };
  const blocks: (number | null)[] = [];
  const y = Float64Array.from({ length: n }, (_, i) => (m.y[i] ?? 0));
  const resid = (i: number) => path.echo[i] - y[i];
  for (let b = 0; b + BLOCK <= n; b += BLOCK) {
    let a = 0, r = 0;
    for (let i = b; i < b + BLOCK; i++) { a += path.echo[i] ** 2; const e = resid(i); r += e * e; }
    blocks.push(a < 400 * BLOCK ? null : Math.max(-60, Math.min(80, 10 * Math.log10(a / (r + 1e-9)))));
  }
  const echoW = Array.from(path.echo.subarray(ECHO_SPEC.window)), resW = echoW.map((v, k) => v - y[ECHO_SPEC.window + k]);
  const erle = Number.isFinite(erleDb(echoW, resW)) ? Math.min(80, erleDb(echoW, resW)) : 80;
  const mean = answered > 1 ? m.total / Math.max(1, answered - 1) : 0;
  const res: PathResult = { path, erle, blocks, pass: false, fault: m.fault, answered, meanCycles: mean, worstCycles: m.worst, why: '' };
  res.why = whyNot(res);
  res.pass = res.why === '';
  return res;
}

/** The reason a path failed, from what the bench saw, or ''. */
export function whyNot(r: PathResult): string {
  const p = r.path, tag = `path ${p.index + 1} (${tailWord(p.cls)}, ${p.source})`;
  if (r.fault) return `${tag}: ${r.fault.message}`;
  const need = ECHO_SPEC.erleDb, f = (v: number) => `${v.toFixed(1)} dB`;
  if (r.erle >= need) return '';
  const w0 = ECHO_SPEC.window / BLOCK, tail = r.blocks.slice(w0).filter((b): b is number => b !== null), mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / Math.max(1, v.length), first = mean(tail.slice(0, 4)), last = mean(tail.slice(-4));
  const reached = `ERLE ${f(r.erle)} over the last ${ECHO_SPEC.samples - ECHO_SPEC.window} samples, ${f(need)} needed`;
  if (r.answered > 0 && r.blocks.every((b) => b === null || Math.abs(b) < 0.05)) return `${tag}: ${reached}. ŷ stayed at 0 the whole time: nothing is being subtracted, so no weight is learning.`;
  if (r.erle < -3 || r.blocks.some((b) => b !== null && b < -10)) return `${tag}: diverging. ${reached}: the residual is ${f(-r.erle)} louder than the echo it should remove. The update's sign is wrong or the step is too large for the signal.`;
  if (last - first > 3) return `${tag}: not converged. ${reached}, and still rising (${f(first)} over the first blocks of the window, ${f(last)} over the last): it learns too slowly, so the step is too small or not normalized by the signal's energy.`;
  return `${tag}: ${reached}. It settled and stopped improving, short of the target: too few taps for a tail this long, or an update that rounds away once the error is small.`;
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
}

/** Assemble the learner's program (or say what is wrong with it). */
export function assembleEcho(src: string): { words: number[]; errors: { line: number; message: string }[] } {
  const r = assemble(src);
  const errors = [...r.errors];
  if (!errors.length && r.words.length > ECHO_SPEC.codeWords) errors.push({ line: 1, message: `${r.words.length} words of code, ${ECHO_SPEC.codeWords} allowed` });
  return { words: r.words, errors };
}

/** Grade a program on a seed's paths. `paths` may be given (the page runs them one at a time). */
export function gradeEcho(src: string, seed: number, opts: { paths?: EchoPath[]; budget?: number } = {}): EchoVerdict {
  const a = assembleEcho(src);
  const empty: EchoVerdict = { seed, ok: false, errors: a.errors, results: [], reasons: [], worstCycles: 0, meanCycles: 0, minErle: 0 };
  if (a.errors.length) return empty;
  const results = (opts.paths ?? echoPaths(seed)).map((p) => runPath(a.words, p, opts.budget));
  return summarize(seed, results);
}

export function summarize(seed: number, results: PathResult[]): EchoVerdict {
  return {
    seed, ok: results.length === ECHO_SPEC.paths && results.every((r) => r.pass), errors: [], results, reasons: results.filter((r) => !r.pass).map((r) => r.why),
    worstCycles: Math.max(0, ...results.map((r) => r.worstCycles)), meanCycles: results.reduce((s, r) => s + r.meanCycles, 0) / Math.max(1, results.length),
    minErle: Math.min(...results.map((r) => r.erle)),
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
  /** Write ŷ only on every second sample. */
  skipY?: boolean;
  /** Read d before writing ŷ. */
  peek?: boolean;
}

/** The reference canceller: NLMS on 96 taps in Q14 weights, the history in a double-written ring so the window is contiguous. */
export function echoReference(o: RefOpts = {}): string {
  const N = o.taps ?? 96, mu = o.muShift ?? 18, up = o.update ?? true, sub = o.sign === -1, ring = N * 4;
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
        add   a5, a5, s6
        srai  a5, a5, 17           # g·x[k] in Q14
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
