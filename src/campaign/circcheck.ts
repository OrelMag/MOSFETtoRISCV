// Act 13's circular address bench: the DSP core's address step, every pointer value in every mode, over a list of windows chosen
// to hit the corners (a window that crosses 255, a length of 0, 1 and 255, a base of 0 and 255, a modifier of 0, 1, 32, 128, 255).
// 35 input bits are too many for a table, so this is the exhaustive part that matters: 256 pointers x 8 modes x each triple.
// BitSim lanes run 32 vectors at once. No DOM.

import { aguStep } from '../dsp/iss24';
import type { CustomRun } from '../editor/challenges';
import { LANES } from '../sim/bitsim';
import type { ComponentDef } from '../sim/types';
import { finish, simOf } from './commcheck';
import { rng } from './drills';

export const CIRC_MODES = ['stay', '+1', '−1', '+m', '+circular', '−circular', 'bit-reversed', '−m'] as const;

/** The windows (base, length, modifier) the step is tried on, the chapter's first, then the corners, then seeded ones. */
export function circTriples(): [number, number, number][] {
  const t: [number, number, number][] = [
    [4, 6, 32],                                                      // the chapter's window
    [0, 0, 0], [0, 1, 1], [5, 1, 0], [255, 1, 32], [10, 0, 255],      // length 0 and 1
    [250, 10, 32], [255, 5, 0], [254, 3, 5], [200, 56, 128],          // base + length reaches or passes 256
    [128, 128, 1], [1, 255, 3], [0, 255, 255], [255, 255, 128],       // length 255 and the end at 0 or 254
    [255, 0, 1], [100, 255, 127], [7, 250, 64], [0, 16, 8],           // base 255, a window nearly all of memory
    [0, 32, 16], [0, 64, 32], [0, 128, 128], [64, 192, 255],          // power-of-two windows, modifiers that are bit patterns
    [255, 128, 129], [3, 253, 2], [17, 239, 170], [128, 127, 85],
  ];
  const r = rng(77);
  while (t.length < 40) t.push([Math.floor(r() * 256), Math.floor(r() * 256), Math.floor(r() * 256)]);
  return t;
}

/** What to look at when a mode is wrong, in the learner's terms. */
function hint(p: number, mode: number, base: number, len: number, m: number, got: number): string {
  const end = (base + len) & 255, raw = base + len;
  switch (mode) {
    case 0: return 'Mode 0 is a read without a step: the pointer stays.';
    case 1: case 2: return 'A plain step is p ± 1 modulo 256, whatever the window.';
    case 3: case 7: return `Mode ${mode} adds ${mode === 3 ? 'm' : 'the inverse of m and a carry'}, modulo 256, whatever the window.`;
    case 4:
      if (raw > 255) return `base + length = ${raw} does not fit 8 bits: the window end is ${raw} mod 256 = ${end}, and the pointer wraps when the next address equals it.`;
      if (((p + 1) & 255) > end) return `The next address ${(p + 1) & 255} is beyond the end ${end} (outside the window): only equality with the end wraps, a pointer outside the window just steps.`;
      return `The next address is ${(p + 1) & 255}, the window end is ${end}: when they are equal the pointer goes to the base ${base}.`;
    case 5:
      if (p === base) return `p is the base, so the pointer wraps to the window's last address: end − 1 = ${(end - 1) & 255}, not the end itself.`;
      return `Only a pointer at the base wraps; any other steps down by one (and ${raw > 255 ? `the end ${end} is base + length mod 256` : 'the window is below 256'}).`;
    default:
      return `Reverse p's bits, add m's bits reversed (m = ${m} reversed is ${rev8(m)}), reverse the sum back${got === rev8((rev8(p) + m) & 255) ? ': your result is p + m, the modifier was not reversed' : ''}.`;
  }
}

function rev8(v: number): number { let r = 0; for (let i = 0; i < 8; i++) r |= ((v >> i) & 1) << (7 - i); return r; }

export const CIRC_TRIPLES = circTriples();
export const CIRC_VECTORS = CIRC_TRIPLES.length * 256 * 8;

/** The bench: every vector against aguStep, the first failing one of each mode named. */
export function runCirc(def: ComponentDef, mode: 'gate' | 'switch'): CustomRun {
  if (mode === 'switch') return { failures: ['switch level: the address step is gates'], tested: 0 };
  const widths: Record<string, number> = { p: 8, mode: 3, base: 8, len: 8, m: 8, y: 8 };
  for (const [n, w] of Object.entries(widths)) {
    const q = def.ports.find((x) => x.name === n);
    if (q && q.width !== w) return { failures: [`${n} is ${q.width} bits wide; the address step\'s is ${w}`], tested: 0 };
  }
  const sim = simOf(def, Object.keys(widths));
  if (typeof sim === 'string') return { failures: [sim], tested: 0 };
  const firstFail = new Map<number, string>(), count = new Map<number, number>();
  let tested = 0;
  const P = new Array<number>(LANES), M = new Array<number>(LANES), B = new Array<number>(LANES), Ln = new Array<number>(LANES), Mm = new Array<number>(LANES);
  // One batch is 32 vectors of one triple: 256 pointers x 8 modes = 2048 = 64 batches; the pointer runs fastest, so a batch holds 32 pointers in one mode.
  for (const [base, len, m] of CIRC_TRIPLES) {
    for (let md = 0; md < 8; md++) {
      for (let p0 = 0; p0 < 256; p0 += LANES) {
        for (let l = 0; l < LANES; l++) { P[l] = p0 + l; M[l] = md; B[l] = base; Ln[l] = len; Mm[l] = m; }
        sim.setInput('p', P); sim.setInput('mode', M); sim.setInput('base', B); sim.setInput('len', Ln); sim.setInput('m', Mm);
        sim.settle();
        const y = sim.get('y', LANES);
        tested += LANES;
        for (let l = 0; l < LANES; l++) {
          const p = P[l], want = aguStep(p, md, base, len, m);
          if (y[l] === want) continue;
          count.set(md, (count.get(md) ?? 0) + 1);
          if (!firstFail.has(md)) firstFail.set(md, `p = ${p}, mode ${CIRC_MODES[md]}, base ${base}, len ${len}, m ${m}: y = ${y[l]}, the model gives ${want}. ${hint(p, md, base, len, m, y[l])}`);
        }
      }
    }
  }
  const fails = [...firstFail.entries()].sort((a, b) => a[0] - b[0]).map(([md, s]) => `${s} (${count.get(md)} of ${CIRC_VECTORS / 8} vectors in this mode are wrong)`);
  return finish(fails, tested, def, { failed: [...firstFail.keys()] });
}
