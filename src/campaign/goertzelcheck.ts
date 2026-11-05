// The bench of act 13's Goertzel level: DTMF blocks (seeded keys, 205 samples at 8 kHz, the chapter's block) go through the learner's
// resonator once per tone, the coefficient on a pin and a clear between tones, and s1 / s2 are compared with dsp/spectrum.ts's
// words after every clock. At the end the power of the eight tones, from the words the gates produced, must name the key. Lanes of a
// BitSim run one block each. No DOM.

import type { CustomRun } from '../editor/challenges';
import type { ComponentDef } from '../sim/types';
import { COEF_BITS, COEF_FRAC, coefWord, DTMF_FS, DTMF_KEYS, dtmfBlock, dtmfDecode, dtmfFreqs, fxPower, worstInput } from '../dsp/spectrum';
import { shiftRound, wrapTo } from '../dsp/fixed';
import { GZ_STATE } from '../lib/goertzel';
import { finish, simOf } from './commcheck';
import { rng } from './drills';

/** The block of the chapter's decoder (the widgets' DTMF_N, spelled here so the bench stays DOM-free; the test pins them equal). */
export const GZ_BLOCK = 205;
export const GZ_NOISE = 40;
const KEYS = DTMF_KEYS.join('');
const LANES = 32;

interface Lane { name: string; key: string | null; x: (tone: number, C: number) => number[] }

/** 28 keypad blocks (every key, then twelve again with other noise), then the four that stress the word: the worst case of each tone, its mirror, full-scale alternation, a constant. */
function lanes(): Lane[] {
  const L: Lane[] = [];
  for (let l = 0; l < 28; l++) {
    const key = KEYS[l % 16], seed = 11 + l;
    L.push({ name: `key ${key}`, key, x: () => dtmfBlock(key, GZ_BLOCK, { noise: GZ_NOISE, seed }) });
  }
  L.push({ name: 'the worst-case block', key: null, x: (_t, C) => worstInput(C, GZ_BLOCK) });
  L.push({ name: 'the worst-case block, mirrored', key: null, x: (_t, C) => worstInput(C, GZ_BLOCK).map((v) => -1 - v) });
  L.push({ name: 'full-scale alternation', key: null, x: () => Array.from({ length: GZ_BLOCK }, (_, n) => (n % 2 ? -128 : 127)) });
  L.push({ name: 'a constant 127', key: null, x: () => new Array<number>(GZ_BLOCK).fill(127) });
  return L;
}

const fmtHz = (f: number) => `${f} Hz`;
const sgn = (v: number) => wrapTo(v, GZ_STATE);

export function runGoertzel(def: ComponentDef, mode: 'gate' | 'switch'): CustomRun {
  if (mode === 'switch') return { failures: ['switch level: the resonator is gates and flip-flops'], tested: 0 };
  const sim = simOf(def, ['x', 'c', 'clr', 'clk', 's1', 's2']);
  if (typeof sim === 'string') return { failures: [sim], tested: 0 };
  const L = lanes(), n = L.length;
  if (n > LANES) throw new Error('goertzelcheck: too many lanes');
  const freqs = dtmfFreqs(), fails: string[] = [], dead = new Set<number>();
  const power: number[][] = L.map(() => []);
  const r = rng(77);
  let clocks = 0;
  freqs.forEach((hz, t) => {
    const C = coefWord(hz / DTMF_FS), xs = L.map((l) => l.x(t, C));
    // the model, a word at a time: the product rounds half up once, the sum wraps in the state word
    const m1 = new Array<number>(n).fill(0), m2 = new Array<number>(n).fill(0);
    const cUnsigned = C & ((1 << COEF_BITS) - 1);
    for (let k = 0; k <= GZ_BLOCK; k++) {
      const clr = k === 0 ? 1 : 0;
      // the clock that clears carries a sample too: it must be ignored
      const xin = L.map((_, l) => (clr ? Math.floor(r() * 256) : xs[l][k - 1] & 0xff));
      sim.setInput('x', xin); sim.setInput('c', cUnsigned); sim.setInput('clr', clr);
      sim.cycle(); clocks++;
      const g1 = sim.get('s1', n), g2 = sim.get('s2', n);
      for (let l = 0; l < n; l++) {
        let w1: number, w2: number;
        if (clr) { w1 = 0; w2 = 0; } else {
          const nxt = wrapTo(xs[l][k - 1] + shiftRound(C * m1[l], COEF_FRAC, 'half-up') - m2[l], GZ_STATE);
          w2 = m1[l]; w1 = nxt;
        }
        m1[l] = w1; m2[l] = w2;
        if (dead.has(l)) continue;
        const a1 = sgn(g1[l]), a2 = sgn(g2[l]);
        if (a1 === w1 && a2 === w2) continue;
        dead.add(l);
        const where = `${L[l].name}, tone ${fmtHz(hz)} (c = ${C}/2^${COEF_FRAC})`;
        if (clr) fails.push(`${where}: clr = 1 at the clock that starts the block, yet s1 = ${a1} and s2 = ${a2}: both registers must be 0 after it, whatever x says`);
        else {
          const bad = a1 !== w1 ? `s1 = ${a1}, the model gives ${w1}` : `s2 = ${a2}, the model gives ${w2}`;
          const hint = a1 !== w1 && Math.abs(a1 - w1) === 1 ? 'off by one: the product comes down by 14 bits and rounds half up (add the first dropped bit back); s[n−2] is subtracted as two\'s complement (invert it and carry in a 1)'
            : k === 1 && a1 !== w1 ? 'the first sample after a clear: s1 must equal x there, the old state gone'
              : a1 !== w1 ? 'the update is s = x + c·s1 − s2' : 's2 must be the s1 of the clock before';
          fails.push(`${where}, sample ${k - 1}: ${bad}. ${hint}`);
        }
      }
    }
    for (let l = 0; l < n; l++) power[l].push(fxPower({ s1: m1[l], s2: m2[l], overflowed: false, peak: 0 }, C));
  });
  // the energy: every keypad block must read as its key from the words the gates are held to
  if (!fails.length) {
    L.forEach((l, i) => {
      if (!l.key) return;
      const read = dtmfDecode(power[i], GZ_BLOCK);
      if (read.key !== l.key) fails.push(`${l.name}: the eight powers read as ${read.key ?? 'no key'} (${read.why})`);
    });
  }
  return finish(fails, n * freqs.length, def, { cycles: clocks });
}
