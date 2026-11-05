// CORDIC (DOM-free): turning a vector by adding shifted copies of itself, with no multiplier. The golden model of lib/cordic.ts, stage by stage
// and clock by clock. Values are signed integers; x and y wrap in a word of w bits and the angle in z bits, where the whole of z is one turn.

import { wrapTo } from './fixed';

export interface CordicSpec {
  /** Bits of x and y. */
  w: number;
  /** Bits of the angle: 2^z is a full turn, so the word wraps at the circle as an angle does. */
  z: number;
  /** Stages after the first half-turn. */
  n: number;
}
export type CordicMode = 'rotate' | 'vector';
export interface CordicState { x: number; y: number; z: number }

/** atan 2^−i as a share of a turn, in the angle word, rounded. */
export function atanTable(s: CordicSpec): number[] {
  return Array.from({ length: s.n }, (_, i) => Math.round((Math.atan(2 ** -i) / (2 * Math.PI)) * 2 ** s.z));
}
/** How much n stages lengthen a vector: the product of √(1 + 2^−2i). Its inverse tends to 0.607253. */
export const cordicStretch = (n: number): number => { let k = 1; for (let i = 0; i < n; i++) k *= Math.sqrt(1 + 2 ** (-2 * i)); return k; };

const sar = (v: number, i: number) => Math.floor(v / 2 ** i);

/**
 * First a half-turn, if the target is out of the stages' reach (they cover about ±99.9°): negate the vector and flip the angle's top bit. Rotating, that is when the
 * angle's two top bits differ, past ±90°. Vectoring, when x < 0.
 */
export function cordicPre(st: CordicState, s: CordicSpec, mode: CordicMode): CordicState {
  const u = ((st.z % 2 ** s.z) + 2 ** s.z) % 2 ** s.z, top = Math.floor(u / 2 ** (s.z - 1)), next = Math.floor(u / 2 ** (s.z - 2)) & 1;
  const flip = mode === 'rotate' ? top !== next : st.x < 0;
  return flip ? { x: wrapTo(-st.x, s.w), y: wrapTo(-st.y, s.w), z: wrapTo(st.z + 2 ** (s.z - 1), s.z) } : { ...st, z: wrapTo(st.z, s.z) };
}

/** One stage. Rotating steers z to 0, turning toward what is left of the angle. Vectoring steers y to 0, and z adds up the turns. */
export function cordicStage(st: CordicState, i: number, atan: number, s: CordicSpec, mode: CordicMode): CordicState {
  const pos = mode === 'rotate' ? st.z >= 0 : st.y < 0, d = pos ? 1 : -1;
  return { x: wrapTo(st.x - d * sar(st.y, i), s.w), y: wrapTo(st.y + d * sar(st.x, i), s.w), z: wrapTo(st.z - d * atan, s.z) };
}

/** The whole way: the half-turn, then every stage. */
export function cordicRun(st: CordicState, s: CordicSpec, mode: CordicMode): CordicState {
  const t = atanTable(s);
  let v = cordicPre(st, s, mode);
  for (let i = 0; i < s.n; i++) v = cordicStage(v, i, t[i], s, mode);
  return v;
}

/** Every state on the way, for drawing: the half-turn first if there is one. */
export function cordicPath(st: CordicState, s: CordicSpec, mode: CordicMode): CordicState[] {
  const t = atanTable(s), out = [st];
  let v = cordicPre(st, s, mode);
  if (v.x !== st.x || v.y !== st.y) out.push(v);
  for (let i = 0; i < s.n; i++) { v = cordicStage(v, i, t[i], s, mode); out.push(v); }
  return out;
}

/** The starting x that makes the output exactly `scale` long: scale × 0.607253…, which is what saves a multiplier at the end. */
export const cordicStart = (s: CordicSpec, scale: number): number => Math.round(scale / cordicStretch(s.n));

/** cos and sin of a turn share, the way the hardware does it: `scale` is 1 in the word. */
export function cordicSinCos(turn: number, s: CordicSpec, scale: number): { cos: number; sin: number } {
  const r = cordicRun({ x: cordicStart(s, scale), y: 0, z: wrapTo(Math.round(turn * 2 ** s.z), s.z) }, s, 'rotate');
  return { cos: r.x, sin: r.y };
}

/** Magnitude (still stretched, so × 0.607253 for the true length) and angle as a share of a turn. */
export function cordicVector(x: number, y: number, s: CordicSpec): { mag: number; turn: number } {
  const r = cordicRun({ x, y, z: 0 }, s, 'vector');
  return { mag: r.x, turn: r.z / 2 ** s.z };
}

/** Worst error over every angle the word can hold, against Math's sine and cosine, in units of 1 / scale. */
export function cordicError(s: CordicSpec, scale: number): { worst: number; at: number } {
  let worst = 0, at = 0;
  const N = 2 ** s.z;
  for (let u = 0; u < N; u++) {
    const turn = u / N, r = cordicSinCos(turn, s, scale);
    const e = Math.max(Math.abs(r.cos - scale * Math.cos(2 * Math.PI * turn)), Math.abs(r.sin - scale * Math.sin(2 * Math.PI * turn)));
    if (e > worst) { worst = e; at = u; }
  }
  return { worst, at };
}

/** What the theory allows for cordicError, in the same units: the angle left over at the last stage, the table's rounding, and a truncation at each stage, stretched by the stages after it. */
export function cordicBound(s: CordicSpec, scale: number): number {
  const leftover = Math.atan(2 ** -(s.n - 1)), tableLsb = (2 * Math.PI) / 2 ** s.z;
  return scale * (leftover + (s.n * tableLsb) / 2) + 1 + s.n * Math.SQRT2 * cordicStretch(s.n);
}

/** The pipelined gates, clock by clock: a word in at the left, one out at the right every clock, n + 1 clocks later. */
export class CordicPipe {
  /** Register 0 holds the half-turn's result; register k + 1 stage k's. */
  regs: (CordicState & { rotate: boolean })[];
  private t: number[];
  constructor(public s: CordicSpec) {
    this.t = atanTable(s);
    this.regs = Array.from({ length: s.n + 1 }, () => ({ x: 0, y: 0, z: 0, rotate: false }));
  }
  get out(): CordicState { return this.regs[this.regs.length - 1]; }
  edge(input: CordicState, rotate: boolean): void {
    const s = this.s;
    const next = this.regs.map((_, k) => {
      if (k === 0) return { ...cordicPre(input, s, rotate ? 'rotate' : 'vector'), rotate };
      const p = this.regs[k - 1];
      return { ...cordicStage(p, k - 1, this.t[k - 1], s, p.rotate ? 'rotate' : 'vector'), rotate: p.rotate };
    });
    this.regs = next;
  }
}

/** The iterative gates, clock by clock: one stage used n times over, a shift count and a busy flag. A start loads the half-turn's result. */
export class CordicIter {
  st: CordicState = { x: 0, y: 0, z: 0 };
  i = 0;
  busy = false;
  rotate = false;
  private t: number[];
  constructor(public s: CordicSpec) { this.t = atanTable(s); }
  edge(input: CordicState, rotate: boolean, start: boolean): void {
    if (start) { this.st = cordicPre(input, this.s, rotate ? 'rotate' : 'vector'); this.rotate = rotate; this.i = 0; this.busy = true; return; }
    if (!this.busy) return;
    this.st = cordicStage(this.st, this.i, this.t[this.i], this.s, this.rotate ? 'rotate' : 'vector');
    this.i++;
    if (this.i === this.s.n) { this.busy = false; this.i = 0; }
  }
}
