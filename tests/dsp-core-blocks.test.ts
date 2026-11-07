// The DSP core's blocks against their specifications, gate by gate.
import { describe, it } from 'vitest';
import '../src/lib';
import { DSP24_DECODE } from '../src/lib/dsp24';
import { checkSpec } from './util';

describe('DECODE', () => {
  it('gives every control for random words, every op and every field', () => {
    checkSpec(DSP24_DECODE, 3000);
  });
});
import { DSP24_ALU, alu24 } from '../src/lib/dsp24';
describe('ALU', () => {
  it('gives every function for random operands and the corners', () => {
    const e: number[][] = [];
    for (let f = 0; f < 16; f++) for (const a of [0, 1, 0x7fff, 0x8000, 0xffff, 0x1234]) for (const b of [0, 1, 0x7fff, 0x8000, 0xffff, 15, 0x00f3]) e.push([a, b, f]);
    checkSpec(DSP24_ALU, 1500, e);
  });
  it('spec matches the model on saturation', () => { if (alu24(0x7fff, 1, 8) !== 0x7fff || alu24(0x8000, 1, 9) !== 0x8000) throw new Error('model'); });
});
import { DSP24_AGU_STEP } from '../src/lib/dsp24agu';

describe('address step', () => {
  it('matches the model in every mode, at the window edges and at random', () => {
    const extra: number[][] = [];
    let s = 5;
    const r = (n: number) => ((s = (s * 1103515245 + 12345) >>> 0) % n);
    for (let t = 0; t < 600; t++) {
      const base = r(256), len = 1 + r(255), mode = r(8), m = r(256);
      const end = (base + len) & 255;
      for (const p of [r(256), base, (end - 1) & 255, end, (base + 1) & 255]) extra.push([p, mode, base, len, m]);
    }
    checkSpec(DSP24_AGU_STEP, 500, extra);
  });
});
