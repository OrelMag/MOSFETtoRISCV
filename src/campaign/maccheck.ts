// The bench of act 13's MAC level: the chapter's accumulator (a 40-bit register behind a pair of products, and a read that shifts, rounds
// once and clamps once) against dsp/mac.ts, clock by clock. Lanes of a BitSim run one instruction stream each: the worst case that fits,
// an excursion that comes back, the wrap, the reads at the shifts that matter, the control inputs, then seeded random streams.
// Every clock the bench compares y and sat (the read of the accumulator as it stands, with the shift on the pin) before the edge, and
// the accumulator after it. No DOM.

import type { CustomRun } from '../editor/challenges';
import type { ComponentDef } from '../sim/types';
import { accAfter, ACC_BITS, half, MAC_F3, macProduct, raccOf, wrapAcc } from '../dsp/mac';
import { finish, simOf } from './commcheck';

export const MAC_LANES = 32;
export const MAC_CLOCKS = 330;

/** One clock of a stream: the unit's inputs. */
export interface MacStep { op: number; en: number; a: number; b: number; sh: number }
export interface MacLane { name: string; steps: MacStep[]; hint?: string }

const MAC = MAC_F3.mac, MAC2 = MAC_F3.mac2, CLR = MAC_F3.clracc, RACC = MAC_F3.racc;
const FULL = 0x8000_8000; // both halves −32768: each product is +2^30
const NEG = 0x7fff_7fff; // both halves 32767: against FULL, each product is −32768 × 32767

function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

/** The shifts a read is tried at: both ends, the word's edges, the place the sign is all that is left, and past the accumulator. */
export const READ_SHIFTS = [0, 1, 2, 7, 14, 15, 16, 17, 30, 31, 32, 33, 38, 39, 40, 41, 50, 62, 63];

/** The lanes of the bench, seeded. */
export function macLanes(seed = 1): MacLane[] {
  const rnd = seeded(seed);
  const rw = () => Math.floor(rnd() * 2 ** 32);
  const ri = (n: number) => Math.floor(rnd() * n);
  const mk = (op: number, a: number, b: number, sh = 0, en = 1): MacStep => ({ op, en, a, b, sh });
  // a read: racc with operands that must not matter (the accumulator is only read)
  const rd = (sh: number): MacStep => mk(RACC, rw(), rw(), sh);
  const rep = (n: number, f: () => MacStep): MacStep[] => Array.from({ length: n }, f);
  const lanes: MacLane[] = [];
  const add = (name: string, steps: MacStep[], hint?: string) => lanes.push({ name, steps, hint });
  const reads = (shifts: number[]) => shifts.map(rd);

  add('255 mac2 of full-scale operands (the most that fits), then reads',
    [...rep(255, () => mk(MAC2, FULL, FULL, 0)), ...reads([0, 15, 39, 40, 63])],
    'The sum is 255 × 2^31, just under 2^39: a 40-bit signed register holds it, a 39-bit one has wrapped long before.');
  add('255 mac2 at the other end (−32768 × 32767, twice), then reads',
    [...rep(255, () => mk(MAC2, FULL, NEG, 0)), ...reads([0, 15, 39, 40, 63])],
    'The sum goes down to just above −2^39: the register needs all 40 bits there too.');
  add('an excursion that comes back: 120 mac2 up past 2^37, 120 down, then reads',
    [...rep(120, () => mk(MAC2, FULL, FULL, 0)), ...rep(120, () => mk(MAC2, FULL, NEG, 0)), ...reads([0, 4, 16])],
    'The partial sums run far past 32 bits and the final sum fits again. Clamping on every add loses the excursion: the register may hold 40 bits, and only the read clamps, once.');
  add('an excursion downward: 100 mac2 down, then 100 up, then reads',
    [...rep(100, () => mk(MAC2, FULL, NEG, 0)), ...rep(100, () => mk(MAC2, FULL, FULL, 0)), ...reads([0, 4, 16])],
    'The same excursion the other way: only the read clamps, and only if the final sum does not fit.');
  add('mac only: 150 up, 150 down past 32 bits and back, then reads',
    [...rep(150, () => mk(MAC, 0x8000, 0x8000, 0)), ...rep(150, () => mk(MAC, 0x8000, 0x7fff, 0)), ...reads([0, 1, 15])]);
  add('256 full-scale mac2 (the sum reaches 2^39 and wraps), 40 more, reads',
    [...rep(256, () => mk(MAC2, FULL, FULL, 0)), ...rep(40, () => mk(MAC2, FULL, FULL, 0)), ...reads([0, 39, 40])],
    'Past 2^39 − 1 the 40-bit register wraps as two\'s complement: no flag, no clamp. The 256th mac2 turns +2^39 into −2^39.');
  add('270 mac2 at the negative end: wraps from below to a large positive value, reads',
    [...rep(270, () => mk(MAC2, FULL, NEG, 0)), ...reads([0, 8, 39, 40])]);
  add('wrapping and clearing: 300 mac2, clracc, one mac, reads',
    [...rep(300, () => mk(MAC2, FULL, FULL, 0)), mk(CLR, rw(), rw()), mk(MAC, 3, 5), ...reads([0, 1, 2])]);

  // The read: sums built from a few products, then every shift of the list.
  const built = (n: number, ext: boolean): MacStep[] => rep(n, () => {
    const pick = () => (ext ? [0x8000_8000, 0x7fff_7fff, 0x8000_7fff, 0x7fff_8000][ri(4)] : rw());
    return mk(rnd() < 0.5 ? MAC : MAC2, pick(), pick(), 0);
  });
  add('reads at every shift of a sum built from random products', [mk(CLR, 0, 0), ...built(10, false), ...reads(READ_SHIFTS), mk(CLR, 0, 0), ...built(6, false), ...reads(READ_SHIFTS)]);
  add('reads at every shift of a large positive sum (the clamp acts at the low shifts)',
    [...rep(12, () => mk(MAC2, FULL, FULL, 0)), ...reads(READ_SHIFTS), ...rep(12, () => mk(MAC2, FULL, FULL, 0)), ...reads(READ_SHIFTS)]);
  add('reads at every shift of a large negative sum',
    [...rep(12, () => mk(MAC2, FULL, NEG, 0)), ...reads(READ_SHIFTS), ...rep(12, () => mk(MAC2, FULL, NEG, 0)), ...reads(READ_SHIFTS)]);
  // Ties: 3 × 2^(k−1) at shift k is exactly k.5 of the output step; −5 ≫ 1 is −2 (half up, toward +∞), and the sign flips the tie's direction.
  const ties: MacStep[] = [];
  ties.push(mk(CLR, 0, 0), mk(MAC, 0xfffb, 1), rd(1), mk(CLR, 0, 0), mk(MAC, 5, 1), rd(1), mk(CLR, 0, 0), mk(MAC, 0xfff9, 1), rd(1));
  for (let k = 1; k <= 14; k++) {
    const t = 3 * 2 ** (k - 1);
    ties.push(mk(CLR, 0, 0), mk(MAC, t, 1), rd(k), rd(k - 1), mk(CLR, 0, 0), mk(MAC, (-t) & 0xffff, 1), rd(k), rd(k + 1));
  }
  add('half-way cases: −5 ≫ 1 is −2, 5 ≫ 1 is 3, 3 × 2^(k−1) ≫ k and the same negative', ties,
    'A tie rounds up, toward +∞: the first bit dropped is added back. −2.5 gives −2, 2.5 gives 3.');

  // Control: clracc mid-stream, en = 0 holding whatever op says, racc leaving the accumulator as it is.
  const control: MacStep[] = [];
  const junk = () => mk(ri(4), rw(), rw(), ri(64), 0);
  control.push(...rep(8, () => mk(MAC2, rw(), rw(), 0)), rd(0), mk(CLR, rw(), rw()), rd(0), ...rep(3, () => mk(MAC, rw(), rw(), 0)), rd(0));
  for (let op = 0; op < 4; op++) control.push(mk(op, rw(), rw(), 5, 0), rd(0), mk(op, FULL, FULL, 7, 0), rd(3));
  control.push(...rep(6, () => rd(ri(64))), rd(0), ...rep(4, junk), mk(MAC, 7, 9), ...rep(4, junk), rd(0), mk(CLR, rw(), rw()), ...rep(3, junk), rd(0), mk(CLR, 0, 0, 0, 0), rd(0));
  control.push(...rep(5, () => mk(MAC2, rw(), rw(), 0)), mk(CLR, 0, 0), ...rep(5, () => mk(MAC2, rw(), rw(), 0)), mk(CLR, 0, 0), rd(0));
  add('control: clracc mid-stream, en = 0 with every op, racc leaving the accumulator alone', control);

  // Random streams: a mix of the four instructions and idle clocks, operands from the whole word, from its ends, or small.
  let r = 0;
  while (lanes.length < MAC_LANES) {
    const style = r % 3, k = r++;
    const steps: MacStep[] = [mk(CLR, 0, 0)];
    const operand = (): number => {
      const u = rnd();
      if (style === 2 || u < 0.25) return [FULL, NEG, 0x8000_7fff, 0x7fff_8000, 0x8000, 0x7fff, 0xffff, 0, 1][ri(9)] >>> 0;
      if (u < 0.45) return (((ri(64) - 32) & 0xffff) | (((ri(64) - 32) & 0xffff) << 16)) >>> 0;
      return rw();
    };
    const shift = (): number => (rnd() < 0.5 ? READ_SHIFTS[ri(READ_SHIFTS.length)] : ri(64));
    while (steps.length < MAC_CLOCKS) {
      const u = rnd();
      // style 2 climbs: extremes of one sign, a clracc now and then, so the sum is carried far
      if (u < 0.30) steps.push(mk(MAC, style === 2 ? FULL : operand(), style === 2 ? FULL : operand(), shift()));
      else if (u < 0.60) steps.push(mk(MAC2, style === 2 && rnd() < 0.9 ? FULL : operand(), style === 2 && rnd() < 0.9 ? FULL : operand(), shift()));
      else if (u < 0.63) steps.push(mk(CLR, operand(), operand(), shift()));
      else if (u < 0.78) steps.push(mk(RACC, operand(), operand(), shift()));
      else steps.push(mk(ri(4), operand(), operand(), shift(), 0));
    }
    add(`seeded random stream ${k + 1}${style === 2 ? ' (extreme operands)' : ''}`, steps);
  }
  return lanes.map((l) => ({ ...l, steps: l.steps.length > MAC_CLOCKS ? l.steps : [...l.steps, ...rep(MAC_CLOCKS - l.steps.length, () => mk(ri(4), rw(), rw(), ri(64), 0))] }));
}

/** The model's accumulator before each clock, and its read (y, sat) of that accumulator with the clock's shift. */
export interface MacTrace { accBefore: bigint[]; accAfter: bigint[]; y: number[]; sat: number[] }
export type AccStep = (acc: bigint, s: MacStep) => bigint;

export const modelStep: AccStep = (acc, s) => (s.en ? accAfter(acc, s.op, s.a, s.b) : acc);

export function traceOf(steps: MacStep[], step: AccStep = modelStep, read: (acc: bigint, sh: number) => { y: number; sat: boolean } = raccOf): MacTrace {
  const t: MacTrace = { accBefore: [], accAfter: [], y: [], sat: [] };
  let acc = 0n;
  for (const s of steps) {
    const r = read(acc, s.sh);
    t.accBefore.push(acc); t.y.push(r.y); t.sat.push(r.sat ? 1 : 0);
    acc = step(acc, s);
    t.accAfter.push(acc);
  }
  return t;
}

const clamp32 = (v: bigint): bigint => (v > 0x7fffffffn ? 0x7fffffffn : v < -0x80000000n ? -0x80000000n : v);
/** The nearly-right accumulators the hints look for, whole run at a time. */
const VARIANTS: [string, AccStep][] = [
  ...[32, 36, 37, 38, 39, 41, 48].map((w): [string, AccStep] => [`wraps at ${w} bits, not ${ACC_BITS}`, (acc, s) => (s.en && s.op < 2 ? BigInt.asIntN(w, acc + macProduct(s.op, s.a, s.b)) : modelStep(acc, s))]),
  ['clamps to 32 bits on every add, not once at the read', (acc, s) => (s.en && s.op < 2 ? clamp32(acc + macProduct(s.op, s.a, s.b)) : modelStep(acc, s))],
  ['mac2 adds only one product', (acc, s) => (s.en && s.op === MAC2 ? wrapAcc(acc + BigInt(half(s.a, false) * half(s.b, false))) : modelStep(acc, s))],
  ['clracc is ignored', (acc, s) => (s.en && s.op === CLR ? acc : modelStep(acc, s))],
  ['racc changes the accumulator (it adds the products as mac2 does)', (acc, s) => (s.en && s.op === RACC ? wrapAcc(acc + macProduct(MAC2, s.a, s.b)) : modelStep(acc, s))],
  ['the accumulator changes with en = 0', (acc, s) => (s.en ? modelStep(acc, s) : s.op < 2 ? wrapAcc(acc + macProduct(s.op, s.a, s.b)) : modelStep(acc, s))],
];
const trunc = (acc: bigint, sh: number) => { const e = acc >> BigInt(sh & 63), y = e > 0x7fffffffn ? 0x7fffffff : e < -0x80000000n ? -0x80000000 : Number(e); return { y, sat: BigInt(y) !== e }; };

const PINS = ['a', 'b', 'op', 'en', 'sh', 'clk', 'y', 'sat', 'acc'];
const WIDTHS: Record<string, number> = { a: 32, b: 32, op: 2, en: 1, sh: 6, y: 32, sat: 1, acc: ACC_BITS };
const OPNAME = ['mac', 'mac2', 'clracc', 'racc'];
const hex32 = (v: number) => `0x${(v >>> 0).toString(16).padStart(8, '0')}`;

/** The MAC bench on a seed: y and sat before every edge, the accumulator after it. */
export const runMacBench = (def: ComponentDef, mode: 'gate' | 'switch'): CustomRun => macBench(def, mode, 1);
export function macBench(def: ComponentDef, mode: 'gate' | 'switch', seed: number): CustomRun {
  if (mode === 'switch') return { failures: ['switch level: the MAC is gates'], tested: 0 };
  for (const [p, w] of Object.entries(WIDTHS)) {
    const port = def.ports.find((q) => q.name === p);
    if (port && port.width !== w) return { failures: [`${p} is ${port.width} bits wide; the MAC's ${p} is ${w}`], tested: 0 };
  }
  const sim = simOf(def, PINS);
  if (typeof sim === 'string') return { failures: [sim], tested: 0 };
  const lanes = macLanes(seed), L = lanes.length, n = MAC_CLOCKS;
  // Empty the accumulator: two clracc clocks on every lane before the streams start.
  sim.setInput('clk', 0);
  for (const p of ['a', 'b', 'sh']) sim.setInput(p, 0);
  sim.setInput('op', CLR); sim.setInput('en', 1); sim.settle();
  sim.cycle(); sim.cycle();
  const ys: number[][] = lanes.map(() => []), sats: number[][] = lanes.map(() => []), accs: bigint[][] = lanes.map(() => []);
  for (let t = 0; t < n; t++) {
    for (const p of ['a', 'b', 'op', 'en', 'sh'] as const) sim.setInput(p, lanes.map((l) => l.steps[t][p]));
    sim.settle();
    const y = sim.get('y', L), s = sim.get('sat', L);
    for (let l = 0; l < L; l++) { ys[l].push(y[l] >>> 0); sats[l].push(s[l]); }
    sim.cycle();
    const acc = sim.get('acc', L);
    for (let l = 0; l < L; l++) accs[l].push(BigInt.asIntN(ACC_BITS, BigInt(acc[l])));
  }
  const fails: string[] = [], failed: number[] = [];
  lanes.forEach((ln, l) => {
    const m = traceOf(ln.steps);
    let c = -1, onAcc = false;
    for (let t = 0; t < n && c < 0; t++) {
      if ((ys[l][t] | 0) !== m.y[t] || sats[l][t] !== m.sat[t]) c = t;
      else if (accs[l][t] !== m.accAfter[t]) { c = t; onAcc = true; }
    }
    if (c < 0) return;
    failed.push(l);
    const s = ln.steps[c];
    const what = `${OPNAME[s.op]}${s.en ? '' : ' with en = 0'}${s.op === MAC || s.op === MAC2 ? ` (a = ${hex32(s.a)}, b = ${hex32(s.b)})` : s.op === RACC ? ` (shift ${s.sh})` : ''}`;
    let why: string;
    if (onAcc) why = `after the clock of ${what}, acc = ${accs[l][c]}, the model gives ${m.accAfter[c]}`;
    else why = `before the clock of ${what}, with acc = ${m.accBefore[c]} and the shift pin at ${s.sh}: y = ${ys[l][c] | 0}${sats[l][c] !== m.sat[c] && (ys[l][c] | 0) === m.y[c] ? '' : `, the model gives ${m.y[c]}`}, sat = ${sats[l][c]}${sats[l][c] === m.sat[c] ? '' : `, the model gives ${m.sat[c]}`}`;
    // does the whole run equal a model with one nearly-right rule?
    const obs = accs[l];
    const accOk = obs.every((a, t) => a === m.accAfter[t]);
    const alt = accOk ? undefined : VARIANTS.find(([, st]) => { const v = traceOf(ln.steps, st); return v.accAfter.every((a, t) => a === obs[t]); });
    if (alt) why += `. Over the whole stream your accumulator equals the one that ${alt[0]}`;
    else if (accOk) {
      const tr = traceOf(ln.steps, modelStep, trunc);
      if (tr.y.every((v, t) => v === (ys[l][t] | 0))) why += '. Over the whole stream your y equals the read that drops the bits without adding the first one back; the chapter\'s read rounds half up';
      else why += '. The accumulator is right at every clock: the fault is in the read (the shift, the rounding bit added back, or the clamp to 32 bits)';
    } else if (ln.hint) why += `. ${ln.hint}`;
    fails.push(`${ln.name}, clock ${c}: ${why}`);
  });
  return finish(fails, L, def, { failed });
}
