// DOM-free models behind the storage and clock analogy figures (disagree, hilltop, orchestra).
// Each states which part of the site it is checked against; tests/analogyfigs-d.test.ts pins them.

import { counter } from '../../lib/sequential';
import { flatten } from '../../sim/flatten';
import { PS_PER_NAND, SETUP, timingGraph } from '../../sim/timing';

// ---------- disagree: the SR latch's two NANDs, one gate delay at a time ----------

/** The two bubbles: A is the SR latch's q, B its q_n. */
export interface Say { a: 0 | 1; b: 0 | 1 }

const nand = (x: number, y: number): 0 | 1 => (x && y ? 0 : 1);

/** One gate delay of lib/sequential.ts SR_LATCH (q = NAND(s_n, q_n), q_n = NAND(q, r_n)), both gates reading the old values. */
export const srStep = (v: Say, sn: number, rn: number): Say => ({ a: nand(sn, v.b), b: nand(v.a, rn) });

export interface Settle { frames: Say[]; final: Say; /** the pair never stops changing (both inputs released from "both yes") */ ringing: boolean }

/** The bubbles after each gate delay until they stop changing (frames[0] is the start). A two-step ring is reported, not followed. */
export function srSettle(start: Say, sn: number, rn: number, limit = 8): Settle {
  const frames = [start];
  let cur = start;
  for (let i = 0; i < limit; i++) {
    const nx = srStep(cur, sn, rn);
    if (nx.a === cur.a && nx.b === cur.b) return { frames, final: cur, ringing: false };
    frames.push(nx);
    cur = nx;
  }
  return { frames, final: cur, ringing: true };
}

/** Power-on state of SR_LATCH (powerOn q = 0, q_n = 1). */
export const SR_POWER_ON: Say = { a: 0, b: 1 };

// ---------- hilltop: how long a ball stays on the top ----------

/** Assumption (ours, not measured): each gate delay the exact tie breaks with this chance. */
export const TIE_BREAK_P = 0.5;

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Roll { delays: number; valley: 0 | 1 }

/** "Release both" from the forbidden input: gate delays spent on the top (>= 1) and the valley chosen (q). */
export function rollBoth(rng: () => number, p = TIE_BREAK_P): Roll {
  let delays = 1;
  while (rng() >= p) delays++;
  return { delays, valley: rng() < 0.5 ? 1 : 0 };
}

/** "Release one" (the other still held): decided at once, the held input wins. Held set -> q = 1, held reset -> q = 0. */
export const rollOne = (held: 's' | 'r'): Roll => ({ delays: 1, valley: held === 's' ? 1 : 0 });

/** The forbidden input, both held low: both bubbles say yes (q = q_n = 1). */
export const FORBIDDEN: Say = { a: 1, b: 1 };

/** Counts of waits 1..bins-1 and the last bin = bins or longer, over `n` rolls. */
export function histogram(rolls: Roll[], bins = 8): number[] {
  const out = new Array<number>(bins).fill(0);
  for (const r of rolls) out[Math.min(r.delays, bins) - 1]++;
  return out;
}

/** Expected counts for the same bins when each delay breaks the tie with chance p. */
export function expectedHistogram(n: number, bins = 8, p = TIE_BREAK_P): number[] {
  return Array.from({ length: bins }, (_, i) => (i < bins - 1 ? n * p * (1 - p) ** i : n * (1 - p) ** (bins - 1)));
}

// ---------- orchestra: the 4-bit counter's paths between beats ----------

export interface Player { bit: number; /** NAND delays from the beat until this flip-flop's next value is ready */ ready: number; /** ready + setup: the shortest period that catches it */ need: number }

let cached: Player[] | null = null;

/** Per bit of the library 4-bit counter (register + incrementer, lib/sequential.ts): arrival at each flip-flop's data input
 *  from sim/timing.ts, clock-to-q included, and with SETUP the period that bit needs. */
export function counterPlayers(): Player[] {
  if (cached) return cached;
  const g = timingGraph(flatten(counter(4)));
  const byBit = new Map<number, number>();
  for (const c of g.captures) {
    const m = /ff(\d+)/.exec(c.dff.join('.'));
    if (m) byBit.set(Number(m[1]), g.arr(c.net));
  }
  cached = [...byBit.entries()].sort((x, y) => x[0] - y[0]).map(([bit, ready]) => ({ bit, ready, need: ready + SETUP }));
  return cached;
}

export const slowestNeed = (players = counterPlayers()): number => Math.max(...players.map((p) => p.need));

/** The counter's value after one beat at `period` NAND delays: a player whose next value is not ready by then
 *  still holds what it had (our simplification: in a real circuit it may catch a half-changed value). */
export function beat(q: number, period: number, players = counterPlayers()): { q: number; late: number[] } {
  const next = (q + 1) & 15;
  let out = next;
  const late: number[] = [];
  for (const p of players) {
    if (p.need > period) {
      out = (out & ~(1 << p.bit)) | (q & (1 << p.bit));
      if (((q ^ next) >> p.bit) & 1) late.push(p.bit); // only a missed change shows
    }
  }
  return { q: out, late };
}

export { PS_PER_NAND, SETUP };
