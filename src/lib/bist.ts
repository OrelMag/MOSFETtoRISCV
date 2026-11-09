// Built-in self-test (docs/PLAN-VERIFY.md): a chip that tests itself. An LFSR makes the patterns, the block under test
// answers, and a multiple-input signature register (MISR) folds every answer into one word; one comparison with the good
// signature at the end says pass or fail. The reference models here are what tests/bist.test.ts holds the gates to.

import type { ComponentDef } from '../sim/types';
import { constWord } from './alu';
import { Builder } from './builder';
import { busMux2, rca } from './combinational';
import { define, merger, ones, splitter } from './define';
import { XOR } from './gates';
import { LFSR_TAPS, lfsr, lfsrNext } from './seqparts';
import { register } from './sequential';
import { TIE1 } from './transistors';
import { bitwise, xorN } from './wide';

const cache = new Map<string, ComponentDef>();
function memo(key: string, f: () => ComponentDef): ComponentDef {
  let d = cache.get(key);
  if (!d) cache.set(key, (d = f()));
  return d;
}

/** Software model of misr(n): the next signature, folding in the word d. */
export function misrNext(q: number, d: number, n: number): number {
  return lfsrNext(q, n) ^ d;
}

/**
 * Multiple-input signature register: the LFSR's shift with its feedback, and the word d XORed in at every rising edge.
 * Any single wrong word changes the signature; a wrong stream hides (aliases) with odds near 2^−n. rst clears it.
 */
export function misr(n: number): ComponentDef {
  const taps = LFSR_TAPS[n];
  if (!taps) throw new Error(`no LFSR taps for ${n} bits`);
  return memo(`misr${n}`, () => {
    const b = new Builder(8);
    b.pins('d', 'rst', 'clk');
    // the register always loads (its enable tied high), then its state split into its taps and its low bits
    const one = b.add(TIE1, undefined, 'one');
    b.next();
    const reg = b.add(register(n), 'signature', 'reg');
    b.wire(`${one}.y`, `${reg}.en`);
    b.name(`${one}.y`, 'always');
    b.wire('clk', `${reg}.clk`);
    b.next();
    const tp = b.op(splitter(ones(n)), [`${reg}.q`], undefined, 'tp');
    const lo = b.op(splitter([n - 1, 1]), [`${reg}.q`], undefined, 'lo');
    b.next();
    const FB = taps.length === 2 ? XOR : xorN(taps.length);
    const fIns = FB.ports.filter((p) => p.dir === 'in').map((p) => p.name);
    const fb = b.add(FB, `taps ${taps.join(', ')}`, 'fb');
    taps.forEach((t, i) => b.wire(`${tp}.o${t - 1}`, `${fb}.${fIns[i]}`));
    b.next();
    const sh = b.op(merger([1, n - 1]), [`${fb}.y`, `${lo}.o0`], 'shifted', 'sh');
    b.next();
    const x = b.op1(bitwise('xor', n), [`${sh}.out`, 'd'], 'fold d in', 'x');
    const zero = b.op1(constWord(n, 0), [], undefined, 'zero');
    b.next();
    b.op(busMux2(n), [x, zero, 'rst'], 'clear?', 'clr');
    b.wire('clr.y', `${reg}.d`);
    b.name(`${reg}.q`, 'sig', true);
    b.wire(`${reg}.q`, 'sig');
    const H = b.height;
    return define({
      id: `misr${n}`, name: `${n}-bit signature register (MISR)`, category: 'sequential',
      summary: `An LFSR with a word XORed in at every clock: it folds a whole stream of ${n}-bit answers into one ${n}-bit signature. One wrong answer always changes it; a wrong stream escapes with odds near 1 in ${2 ** n}.`,
      ports: [{ name: 'd', width: n, dir: 'in' }, { name: 'rst', width: 1, dir: 'in' }, { name: 'clk', width: 1, dir: 'in', side: 'bottom', clock: true }, { name: 'sig', width: n, dir: 'out' }],
      symbol: { kind: 'box', label: `MISR${n}` },
      netlist: () => ({ pins: { d: [0, 2], rst: [0, 6], clk: [0, H + 2], sig: [b.right, 4] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

/** Clocks a BIST run takes on the adder (the chapter's: 32 patterns cover all 90 stuck-at faults of rca(4)). */
export const BIST_PATTERNS = 32;

/**
 * Self-test around rca(n): lfsr(2n + 1) loaded with 1 by rst feeds a, b and cin; misr(n + 1) folds s and cout. After rst
 * and k more rising edges the signature is bistSignature(n, k).
 */
export function bistAdder(n: number): ComponentDef {
  const W = 2 * n + 1;
  return memo(`bistadd${n}`, () => {
    const b = new Builder(16);
    b.pins('rst', 'clk');
    const gen = b.op(lfsr(W), ['rst', '', 'clk'], 'patterns', 'gen');
    b.wire(b.op1(constWord(W, 1), [], undefined, 'seed'), `${gen}.seed`);
    b.next();
    const sp = b.op(splitter([n, n, 1]), [`${gen}.q`], undefined, 'sp');
    b.next();
    const add = b.op(rca(n), [`${sp}.o0`, `${sp}.o1`, `${sp}.o2`], 'under test', 'dut');
    b.next();
    const mo = b.op(merger([n, 1]), [`${add}.s`, `${add}.cout`], undefined, 'mo');
    b.next();
    const sig = b.op(misr(n + 1), [`${mo}.out`, 'rst', 'clk'], 'signature', 'sig');
    b.wire(`${sig}.sig`, 'sig');
    b.wire(`${gen}.q`, 'pattern');
    const H = b.height;
    return define({
      id: `bistadd${n}`, name: `Self-testing ${n}-bit adder`, category: 'sequential',
      summary: `Built-in self-test: an LFSR drives the adder's ${W} inputs with a new pattern every clock and a signature register folds every sum into ${n + 1} bits. After ${BIST_PATTERNS} clocks the signature is compared with the good one.`,
      ports: [{ name: 'rst', width: 1, dir: 'in' }, { name: 'clk', width: 1, dir: 'in', side: 'bottom', clock: true }, { name: 'pattern', width: W, dir: 'out' }, { name: 'sig', width: n + 1, dir: 'out' }],
      symbol: { kind: 'box', label: 'BIST' },
      netlist: () => ({ pins: { rst: [0, 4], clk: [0, H + 2], pattern: [b.right, H - 2], sig: [b.right, 4] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

/** The patterns a BIST run applies: rst loads 1, then each edge the next state. */
export function bistPatterns(n: number, k: number): number[] {
  const W = 2 * n + 1, out: number[] = [];
  let s = 1;
  for (let i = 0; i < k; i++) { out.push(s); s = lfsrNext(s, W); }
  return out;
}

/** The signature after rst and k edges, given the block's answers to bistPatterns(n, k) (packed s | cout << n). */
export function signatureOf(answers: readonly number[], width: number): number {
  return answers.reduce((q, a) => misrNext(q, a, width), 0);
}

/** The good adder's signature after k patterns. */
export function bistSignature(n: number, k: number): number {
  const m = 2 ** n - 1;
  return signatureOf(bistPatterns(n, k).map((p) => (p & m) + ((p >> n) & m) + ((p >> (2 * n)) & 1)), n + 1);
}

// the chapter's size, registered with the library (and so checked by the registry-wide tests)
bistAdder(4);
