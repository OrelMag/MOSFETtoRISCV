// The adders chapter's last step: how do you know an adder is right? A ripple-carry adder checked against the language's own +
// (exhaustively, on corner cases, on random vectors), with a stuck carry planted to see which kind of check catches it.
// The checking core is DOM-free (tests/adder-proof.test.ts); the widget measures this machine's rate on BitSim, 32 vectors
// per word op.

import { rca } from '../lib/combinational';
import { BitSim, LANES } from '../sim/bitsim';
import { findNode, flatten } from '../sim/flatten';
import { applyFaults } from '../sim/faults';
import { groupDigits } from '../sim/numfmt';
import { h } from '../ui/dom';
import type { Widget } from '../view/stage';

/** 1st, 2nd, 3rd, 4th … 11th, 12th, 13th, 21st (the try box quotes which vector catches a fault). */
export const ordinal = (n: number): string => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10 > 3 ? 0 : n % 10]}`;

export type Vec = readonly [a: number, b: number, cin: number];

/** Cases of an exhaustive check: every a, every b, both carry-ins. */
export const exhaustiveCount = (n: number): number => 2 ** (2 * n + 1);

/** The rate the prose uses for "at a realistic rate": a billion vectors a second, which only dedicated simulation hardware reaches. */
export const RATE = 1e9;
export const SECONDS_PER_YEAR = 365.25 * 86400;
export const yearsAt = (n: number, rate = RATE): number => exhaustiveCount(n) / rate / SECONDS_PER_YEAR;

/** What the reference (the language's +) says: the n-bit sum and the carry out. */
export function reference(n: number, [a, b, cin]: Vec): { s: number; cout: number } {
  const t = a + b + cin; // below 2^33: exact in a double
  return { s: t % 2 ** n, cout: t >= 2 ** n ? 1 : 0 };
}

/** The corner cases: all-zero, all-one, the sign bit alone, just under it, and the two alternating patterns, paired with each other and both carry-ins. */
export function cornerVectors(n: number): Vec[] {
  const top = 2 ** n - 1, half = 2 ** (n - 1);
  let alt = 0;
  for (let i = 0; i < n; i += 2) alt += 2 ** i;
  const vals = [...new Set([0, 1, half - 1, half, top, alt, top - alt])];
  const out: Vec[] = [];
  for (const a of vals) for (const b of vals) for (const c of [0, 1]) out.push([a, b, c]);
  return out;
}

/** Seeded random vectors (xorshift32), so a count in the prose is reproducible. */
export function randomVectors(n: number, count: number, seed = 1): Vec[] {
  let x = seed >>> 0 || 1;
  const next = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x; };
  const word = () => (n <= 32 ? next() % 2 ** n : 0);
  const out: Vec[] = [];
  for (let i = 0; i < count; i++) out.push([word(), word(), next() & 1]);
  return out;
}

export interface Bench {
  n: number;
  /** Check the vectors, 32 at a time; stops at the first mismatch. */
  run(vecs: Iterable<Vec>): { checked: number; bad?: { v: Vec; got: { s: number; cout: number }; want: { s: number; cout: number } } };
}

/** A column-k carry fault: the carry into column k stuck at 0 (k from 1; undefined: a healthy adder). */
export function adderBench(n: number, stuckCarryInto?: number): Bench {
  let d = flatten(rca(n), { mode: 'gate' });
  if (stuckCarryInto !== undefined) {
    const fa = findNode(d.root, [`fa${stuckCarryInto}`]);
    if (!fa) throw new Error(`no column ${stuckCarryInto}`);
    d = applyFaults(d, [{ kind: 'stuck0', nets: fa.ports.cin }]).design;
  }
  const sim = new BitSim(d);
  return {
    n,
    run(vecs) {
      let checked = 0;
      let batch: Vec[] = [];
      const flush = (): ReturnType<Bench['run']>['bad'] => {
        if (!batch.length) return undefined;
        sim.setInput('a', batch.map((v) => v[0]));
        sim.setInput('b', batch.map((v) => v[1]));
        sim.setInput('cin', batch.map((v) => v[2]));
        sim.settle();
        const s = sim.get('s', batch.length), c = sim.get('cout', batch.length);
        for (let i = 0; i < batch.length; i++) {
          const want = reference(n, batch[i]);
          if (s[i] !== want.s || c[i] !== want.cout) return { v: batch[i], got: { s: s[i], cout: c[i] }, want };
          checked++;
        }
        batch = [];
        return undefined;
      };
      for (const v of vecs) {
        batch.push(v);
        if (batch.length === LANES) { const bad = flush(); if (bad) return { checked, bad }; }
      }
      const bad = flush();
      return bad ? { checked, bad } : { checked };
    },
  };
}

/** Every vector of an exhaustive check, lazily (n up to 8 in the widget). */
export function* exhaustiveVectors(n: number): Generator<Vec> {
  const m = 2 ** n;
  for (let a = 0; a < m; a++) for (let b = 0; b < m; b++) for (let c = 0; c < 2; c++) yield [a, b, c];
}

const hex = (v: number, n: number) => '0x' + v.toString(16).toUpperCase().padStart(Math.ceil(n / 4), '0');
const sci = (x: number) => (x >= 1e6 ? x.toExponential(1).replace('e+', ' × 10^') : groupDigits(x));
const span = (years: number) => (years >= 1 ? `${sci(Math.round(years))} years` : years * 365.25 >= 1 ? `${Math.round(years * 365.25)} days` : years * 86400 >= 1 ? `${Math.round(years * 86400)} s` : years * 86400000 >= 1 ? `${Math.round(years * 86400000)} ms` : "under a millisecond");

export function adderProofWidget(): Widget {
  const widthSel = h('select', { 'aria-label': 'adder width' }, [4, 8, 16, 32].map((n) => h('option', { value: String(n), selected: n === 8 }, `${n}-bit adder`))) as HTMLSelectElement;
  const faultSel = h('select', { 'aria-label': 'planted fault' },
    h('option', { value: '' }, 'no fault'),
    h('option', { value: 'low' }, 'carry into column 2 stuck at 0'),
    h('option', { value: 'top' }, 'carry into the top column stuck at 0')) as HTMLSelectElement;
  const out = h('div', { 'aria-live': 'polite' });
  const info = h('p', { class: 'sub' });
  const benches = new Map<string, Bench>();
  const bench = () => {
    const n = Number(widthSel.value), f = faultSel.value;
    const k = f === 'low' ? 2 : f === 'top' ? n - 1 : undefined;
    const key = `${n}/${k}`;
    if (!benches.has(key)) benches.set(key, adderBench(n, k));
    return benches.get(key)!;
  };
  const upd = () => {
    const n = Number(widthSel.value);
    info.textContent = `Exhaustive: 2^${2 * n + 1} = ${sci(exhaustiveCount(n))} cases. At a billion a second that is ${span(yearsAt(n))}.`;
    exhaustiveBtn.disabled = n > 8;
    exhaustiveBtn.title = n > 8 ? 'Too many cases to run here' : '';
    out.replaceChildren();
  };
  const go = (name: string, vecs: () => Iterable<Vec>) => () => {
    const b = bench();
    const t0 = performance.now();
    const r = b.run(vecs());
    const ms = Math.max(performance.now() - t0, 0.01);
    const rate = r.checked / (ms / 1000);
    out.replaceChildren(h('div', { class: 'panel' },
      h('p', null, h('b', null, name), `: ${groupDigits(r.checked)} vectors in ${ms.toFixed(1)} ms (${sci(Math.round(rate))} a second on this machine).`),
      r.bad
        ? h('p', { class: 'asm-errors', style: 'color:var(--bad)' }, `Mismatch: a = ${hex(r.bad.v[0], b.n)}, b = ${hex(r.bad.v[1], b.n)}, cin = ${r.bad.v[2]}. The circuit gives s = ${hex(r.bad.got.s, b.n)}, cout = ${r.bad.got.cout}; the reference + gives s = ${hex(r.bad.want.s, b.n)}, cout = ${r.bad.want.cout}. Caught after ${groupDigits(r.checked)} good vectors.`)
        : h('p', { style: 'color:var(--good)' }, 'No mismatch. That proves the adder right for exactly these vectors, and for no others unless they are all of them.'),
      h('p', { class: 'sub' }, `Exhaustive at ${b.n} bits would take ${span(exhaustiveCount(b.n) / rate / SECONDS_PER_YEAR)} at that rate.`)));
  };
  const btn = (label: string, f: () => void) => h('button', { class: 'btn sm', onclick: f }, label) as HTMLButtonElement;
  const exhaustiveBtn = btn('Every case', go('Exhaustive', () => exhaustiveVectors(Number(widthSel.value))));
  const cornerBtn = btn('Corner cases', go('Corner cases', () => cornerVectors(Number(widthSel.value))));
  const randomBtn = btn('100 000 random vectors', go('Random', () => randomVectors(Number(widthSel.value), 100000)));
  for (const s of [widthSel, faultSel]) s.addEventListener('change', upd);
  upd();
  return {
    el: h('div', { class: 'widget' }, h('div', { class: 'panel' },
      h('h3', null, 'Check a ripple-carry adder against +'),
      h('p', { class: 'sub' }, 'Each vector is an a, a b and a carry-in. The adder is the NAND-level circuit of this chapter on the bit-parallel simulator (32 vectors per step); the reference is the language’s own addition.'),
      h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px' }, widthSel, faultSel),
      h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px' }, exhaustiveBtn, cornerBtn, randomBtn),
      info, out)),
  };
}

/** The step's 'try it' numbers: which vector (1-based) first exposes a stuck carry on the 32-bit adder, in the corner list and in the
 *  seeded random run, for the top column and for column 2 (the widget's two faults). */
export const CATCH = (() => {
  const top = adderBench(32, 31), low = adderBench(32, 2);
  return {
    corner: top.run(cornerVectors(32)).checked + 1, random: top.run(randomVectors(32, 100000)).checked + 1,
    lowRandom: low.run(randomVectors(32, 100000)).checked + 1,
  };
})();
