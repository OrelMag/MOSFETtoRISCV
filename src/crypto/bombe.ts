// How Enigma was broken, computed (DOM-free): what the reflector's flaw leaves of a crib's positions, the size of the key, and
// the Turing-Welchman Bombe's reasoning run over every wheel position. A plug hypothesis (this letter is plugged to that one)
// follows through the crib by the scrambler alone, whose wiring is known, so the plugboard's huge count falls out of the search.
// Software here plays what relays and drums did: tests/secret-bombe.test.ts finds real settings on enciphered messages.

import { chr, Enigma, GREEK, idx, REFLECTORS, ROTORS, stepPeriod, type EnigmaSettings, type RotorName } from './enigma';

// ---------------------------------------------------------------- the key space

/** Ways to plug `cables` cables into 26 sockets: 26! / ((26 − 2c)! · c! · 2^c). */
export function plugCount(cables: number): bigint {
  let f = 1n;
  for (let i = BigInt(26 - 2 * cables) + 1n; i <= 26n; i++) f *= i;
  for (let i = 1n; i <= BigInt(cables); i++) f /= i;
  return f / 2n ** BigInt(cables);
}

export interface KeySpace { orders: bigint; greeks: bigint; reflectors: bigint; windows: bigint; rings: bigint; plugs: bigint; total: bigint; bits: number; withoutPlugs: bigint }

/** The M4's key as an operator set it. Only the right and middle rings count: a ring moves a notch, and nothing reads the left
 *  or Greek wheel's notch, so there a ring is the same as turning the window (tests prove it). */
export function m4KeySpace(cables = 10): KeySpace {
  const orders = 8n * 7n * 6n, greeks = 2n, reflectors = 2n, windows = 26n ** 4n, rings = 26n ** 2n, plugs = plugCount(cables);
  const withoutPlugs = orders * greeks * reflectors * windows * rings, total = withoutPlugs * plugs;
  return { orders, greeks, reflectors, windows, rings, plugs, total, withoutPlugs, bits: log2(total) };
}

export const log2 = (n: bigint): number => {
  const s = n.toString(2), head = Number(`0b${s.slice(0, 53)}`);
  return Math.log2(head) + (s.length - Math.min(53, s.length));
};

/** Fixed-point-free involutions on 26 letters, the most any one window position can be: 25 · 23 · … · 1. */
export const involutions26 = (): bigint => { let f = 1n; for (let i = 25n; i > 0n; i -= 2n) f *= i; return f; };

/** The periods the wheel choice gives: double notches shorten it, and that is a real weakness of the naval wheels. */
export function periodOf(rotors: [RotorName, RotorName, RotorName]): number {
  return stepPeriod({ reflector: 'b', greek: 'beta', rotors, rings: 'AAAA', start: 'AAAA', plugs: '' });
}

// ---------------------------------------------------------------- the crib

/** Offsets at which a crib may stand under a ciphertext: a letter never enciphers to itself, so any match rules one out. */
export function cribOffsets(cipher: string, crib: string): number[] {
  const out: number[] = [];
  for (let o = 0; o + crib.length <= cipher.length; o++) if (![...crib].some((c, i) => cipher[o + i] === c)) out.push(o);
  return out;
}

// ---------------------------------------------------------------- the Bombe

export interface BombeSetup {
  /** Left to right: the wheel order under test. */
  rotors: [RotorName, RotorName, RotorName];
  /** Rings known, as they were tried one by one: rings[3] stands for the right wheel. */
  rings: string;
  reflector: 'b' | 'c';
  greek: 'beta' | 'gamma';
  /** Greek wheel's window: at A with the same ring it is the three-wheel machine's reflector. */
  greekAt: string;
  crib: string;
  /** The ciphertext standing under the crib. */
  cipher: string;
  /** Welchman's diagonal board: if a is plugged to u, then u is plugged to a. */
  diagonal: boolean;
}

export interface Stop { windows: string; plug: string; value: string }

/** The crib as a graph: letters, joined when one enciphers to the other at that place. Loops are what rule settings out. */
export function menuOf(crib: string, cipher: string): { a: string; b: string; at: number }[] {
  return [...crib].map((c, i) => ({ a: c, b: cipher[i], at: i }));
}

/** The letter with the most edges: the Bombe's test register. */
export const centreOf = (crib: string, cipher: string): string => {
  const n = new Map<string, number>();
  for (const e of menuOf(crib, cipher)) for (const c of [e.a, e.b]) n.set(c, (n.get(c) ?? 0) + 1);
  return [...n].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))[0][0];
};

/** The scrambler (no plugs) i + 1 presses after the windows, one table per crib place. */
function tables(s: BombeSetup, l: number, m: number, r: number, out: Uint8Array): void {
  const f = WHEELS(s), R = RINGS(s), K = s.crib.length;
  const turnM = TURN(s.rotors[1]), turnR = TURN(s.rotors[2]);
  let a = l, b = m, c = r;
  for (let i = 0; i < K; i++) {
    const midN = turnM[b], rightN = turnR[c];
    if (midN) a = (a + 1) % 26;
    if (midN || rightN) b = (b + 1) % 26;
    c = (c + 1) % 26;
    const o0 = (c - R[0] + 26) % 26, o1 = (b - R[1] + 26) % 26, o2 = (a - R[2] + 26) % 26;
    const base = i * 26;
    for (let x = 0; x < 26; x++) {
      let y = x;
      y = (f.r[(y + o0) % 26] - o0 + 26) % 26;
      y = (f.m[(y + o1) % 26] - o1 + 26) % 26;
      y = (f.l[(y + o2) % 26] - o2 + 26) % 26;
      y = (f.g[(y + f.go) % 26] - f.go + 26) % 26;
      y = f.u[y];
      y = (f.gi[(y + f.go) % 26] - f.go + 26) % 26;
      y = (f.li[(y + o2) % 26] - o2 + 26) % 26;
      y = (f.mi[(y + o1) % 26] - o1 + 26) % 26;
      y = (f.ri[(y + o0) % 26] - o0 + 26) % 26;
      out[base + x] = y;
    }
  }
}
const tab = (w: string) => Uint8Array.from([...w].map(idx));
const inv = (t: Uint8Array) => { const g = new Uint8Array(26); t.forEach((v, i) => { g[v] = i; }); return g; };
const WHEELS = (s: BombeSetup) => {
  const r = tab(ROTORS[s.rotors[2]].wiring), m = tab(ROTORS[s.rotors[1]].wiring), l = tab(ROTORS[s.rotors[0]].wiring), g = tab(GREEK[s.greek]);
  return { r, m, l, g, ri: inv(r), mi: inv(m), li: inv(l), gi: inv(g), u: tab(REFLECTORS[s.reflector]), go: (idx(s.greekAt) - idx(s.rings[0]) + 26) % 26 };
};
const RINGS = (s: BombeSetup) => [idx(s.rings[3]), idx(s.rings[2]), idx(s.rings[1])];
const TURN = (n: RotorName) => { const t = new Uint8Array(26); for (const c of ROTORS[n].turnover) t[idx(c)] = 1; return t; };

/** One position: from "centre is plugged to test", everything that follows. A stop unless every value of the centre came on. */
function testPosition(s: BombeSetup, t: Uint8Array, centre: number, edges: Int8Array, live: Uint8Array, stack: Int32Array): number {
  live.fill(0);
  let sp = 0;
  const light = (a: number, u: number) => { const k = a * 26 + u; if (!live[k]) { live[k] = 1; stack[sp++] = k; } };
  light(centre, idx(s.crib[0]) === centre ? idx(s.cipher[0]) : 0);
  // The relay racks' current: a wire on in one register drives its image in every register an edge joins.
  while (sp) {
    const k = stack[--sp], a = (k / 26) | 0, u = k % 26;
    if (s.diagonal) light(u, a);
    for (let e = 0; e < edges.length; e += 3) {
      const i = edges[e + 2];
      if (edges[e] === a) light(edges[e + 1], t[i * 26 + u]);
      else if (edges[e + 1] === a) light(edges[e], t[i * 26 + u]);
    }
  }
  let n = 0;
  for (let u = 0; u < 26; u++) n += live[centre * 26 + u];
  return n;
}

export interface BombeRun {
  /** Advance by up to `budget` positions; true when done. */
  step(budget: number): boolean;
  readonly done: number;
  readonly total: number;
  readonly stops: Stop[];
}

/** A run over all 17 576 positions of the three moving wheels, stepped so a page can keep drawing. */
export function bombeRun(s: BombeSetup): BombeRun {
  const c = idx(centreOf(s.crib, s.cipher)), edges = new Int8Array(s.crib.length * 3), t = new Uint8Array(s.crib.length * 26);
  [...s.crib].forEach((ch, i) => { edges[i * 3] = idx(ch); edges[i * 3 + 1] = idx(s.cipher[i]); edges[i * 3 + 2] = i; });
  const live = new Uint8Array(676), stack = new Int32Array(676 * 4), stops: Stop[] = [];
  let done = 0;
  const total = 26 ** 3;
  return {
    get done() { return done; }, total, stops,
    step(budget: number) {
      for (let b = 0; b < budget && done < total; b++, done++) {
        const l = (done / 676) | 0, m = ((done / 26) | 0) % 26, r = done % 26;
        tables(s, l, m, r, t);
        const n = testPosition(s, t, c, edges, live, stack);
        if (n < 26) {
          const value = n === 25 ? [...Array(26).keys()].find((u) => !live[c * 26 + u])! : [...Array(26).keys()].find((u) => live[c * 26 + u])!;
          stops.push({ windows: `${s.greekAt}${chr(l)}${chr(m)}${chr(r)}`, plug: chr(c), value: chr(value) });
        }
      }
      return done >= total;
    },
  };
}

/** The whole run in one go, for a test or a measurement. */
export function bombeStops(s: BombeSetup): Stop[] {
  const r = bombeRun(s);
  while (!r.step(4096));
  return r.stops;
}

/** A message and its crib for a demonstration: a wartime weather report's opening, enciphered with ordinary settings. */
export const BOMBE_PLAIN = 'WETTERVORHERSAGEBISKAYA';
export const BOMBE_KEY: EnigmaSettings = { reflector: 'b', greek: 'beta', rotors: ['II', 'V', 'III'], rings: 'AAAA', start: 'AQHC', plugs: 'AM BT CX DR FY GL HQ IU JK NZ' };
export const bombeCipher = (): string => new Enigma(BOMBE_KEY).run(BOMBE_PLAIN);
