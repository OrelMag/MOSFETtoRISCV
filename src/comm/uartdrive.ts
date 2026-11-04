// What chapter 43's panels do to a simulation, without the DOM, so that tests can run exactly the same code on the gates.

import { findNode } from '../sim/flatten';
import type { Sim } from '../sim/sim';
import { pack } from '../sim/values';
import { lineStream } from './uart';

/**
 * Feeds bytes to a UART's rx pin at the divisor the UART has *now*. A divisor of 0 means the program has not set one yet
 * (the receiver ticks every cycle until it does), so a frame started then would be sent at one rate and received at
 * another: the feeder waits, holding the line idle, until the divisor is non-zero. `gap` idle bit times follow each byte.
 */
export class RxFeeder {
  private q: number[] = [];
  private k = 0;
  private pending: number[] = [];
  /** Bytes queued and not yet sent. */
  get waiting(): boolean { return this.pending.length > 0 || this.k < this.q.length; }
  constructor(private gap = 1) {}
  send(text: string): void { this.pending.push(...[...text].map((c) => c.charCodeAt(0) & 127)); }
  clear(): void { this.q = []; this.k = 0; this.pending = []; }
  /** The line level for the coming edge, given the UART's divisor now. */
  level(div: number): number {
    if (this.k >= this.q.length && this.pending.length && div > 0) {
      const bytes = this.pending, f = lineStream(bytes, 16 * div, 0, this.gap);
      this.pending = [];
      this.q = Array.from({ length: bytes.length * (10 + this.gap) * 16 * div + 2 }, (_, i) => f(i));
      this.k = 0;
    }
    return this.k < this.q.length ? this.q[this.k++] : 1;
  }
  save(): unknown { return { q: this.q, k: this.k, pending: [...this.pending] }; }
  restore(v: unknown): void { const x = v as { q: number[]; k: number; pending: number[] }; this.q = x.q; this.k = x.k; this.pending = [...x.pending]; }
}

/** The two-computer scene's driver: two clocks of a chosen ratio, edges in time order, consoles read as they print, a glitch on A's wire to B. */
export class TwoDrive {
  ratio = 1;
  tA = 1;
  tB = 1;
  eA = 0;
  eB = 0;
  text = { A: '', B: '' };
  lineAB: number[] = [];
  lineBA: number[] = [];
  /** A's edges left to flip the A → B wire on. */
  glitchLeft = 0;
  constructor(private sim: Sim) {}
  private out = (p: string): number => pack(this.sim.getBits(this.sim.design.root.ports[p]));
  private pulse(clk: string): void { const s = this.sim; s.settle(); s.setInput(clk, 1); s.settle(); s.setInput(clk, 0); s.settle(); }
  private note(side: 'A' | 'B'): void { if (this.out(`consoleValid${side}`) === 1) this.text[side] += String.fromCharCode(this.out(`consoleData${side}`)); }
  private record(): void {
    this.lineAB.push(this.out('lineAB')); this.lineBA.push(this.out('lineBA'));
    if (this.lineAB.length > 480) { this.lineAB = this.lineAB.slice(-480); this.lineBA = this.lineBA.slice(-480); }
  }
  /** The next edge in time order, on whichever clock is due. */
  edge(): void {
    const a = this.tA <= this.tB, S = a ? 'A' : 'B';
    this.note(S);
    this.sim.setInput('noiseAB', a && this.glitchLeft > 0 ? 1 : 0);
    this.sim.setInput('noiseBA', 0);
    if (a && this.glitchLeft > 0) this.glitchLeft--;
    this.pulse(a ? 'clkA' : 'clkB');
    if (a) { this.tA += 1; this.eA++; } else { this.tB += 1 / this.ratio; this.eB++; }
    this.record();
  }
  /** The stage's own clock (Step, Pulse, Run) is clock A: call before and after each such edge. */
  externalBefore(): void { this.note('A'); this.sim.setInput('noiseAB', this.glitchLeft > 0 ? 1 : 0); if (this.glitchLeft > 0) this.glitchLeft--; }
  externalAfter(): void { this.tA += 1; this.eA++; this.record(); }
  glitch(edges = 6): void { this.glitchLeft = edges; }
  type(side: 'A' | 'B', text: string): void {
    const n = findNode(this.sim.design.root, [side === 'A' ? 'a' : 'b', 'kbd']);
    if (!n) return;
    const cur = this.sim.leafState!(n.leafIndex!) as { q: number[]; clk: number; ack: number };
    this.sim.poke!(n.leafIndex!, { ...cur, q: [...cur.q, ...[...text].map((c) => c.charCodeAt(0) & 127)].slice(0, 16) });
    this.sim.settle();
  }
  reset(): void { this.tA = this.tB = 1; this.eA = this.eB = 0; this.text = { A: '', B: '' }; this.lineAB = []; this.lineBA = []; this.glitchLeft = 0; }
  save(): unknown { return { tA: this.tA, tB: this.tB, eA: this.eA, eB: this.eB, text: { ...this.text }, lineAB: [...this.lineAB], lineBA: [...this.lineBA], ratio: this.ratio, glitchLeft: this.glitchLeft }; }
  restore(v: unknown): void { const x = v as ReturnType<TwoDrive['save']> as { tA: number; tB: number; eA: number; eB: number; text: { A: string; B: string }; lineAB: number[]; lineBA: number[]; ratio: number; glitchLeft: number }; Object.assign(this, { ...x, text: { ...x.text }, lineAB: [...x.lineAB], lineBA: [...x.lineBA] }); }
}

/**
 * The rx line the receiver panel drives for one byte: a sender whose bit is 16·div·(1 + err) receiver cycles, its start edge
 * `phase` ticks before the tick the receiver acts on it at (ticks fall on multiples of div after reset; the two-flop
 * synchronizer shifts that grid by its 2 cycles, hence the − 2). `phase` is how many ticks late the receiver notices the
 * edge: the same meaning as `phase` in comm/startstop.ts receive(). The synchronizer delays detection and every sample
 * alike; it only moves the edge relative to the tick grid, which is what this accounts for.
 */
export function rxFrameLevels(div: number, code: number, err: number, phase: number): number[] {
  const f = lineStream([code], 16 * div * (1 + err), 4 * div - 2 - phase * div);
  return Array.from({ length: Math.ceil(11 * 16 * div * (1 + err)) + 4 * div + 2 }, (_, i) => f(i));
}
