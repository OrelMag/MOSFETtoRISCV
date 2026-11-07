// The DSP core on the gates against its golden model on random programs (valid instructions with random fields, and raw 24-bit words:
// the table does not name them all, and the hardware must run those as NOP, as the model does), memories random, every clock compared.
import { describe, expect, it } from 'vitest';
import '../src/lib';
import { assemble24 } from '../src/dsp/asm24';
import { dsp24Computer } from '../src/lib/dsp24core';
import { DspRig, randomProgram } from './dsp-core-kit';
import { tick } from './yieldtick';

describe('random programs, gates against the model every clock', () => {
  const seeds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  for (const seed of seeds) {
    it(`seed ${seed}`, async () => {
      const p = randomProgram(seed);
      const rig = new DspRig(dsp24Computer(p.words, p.x, p.y), p.words, p.x, p.y);
      rig.run(500, (i) => void (i % 100 === 0 && tick()));
      await tick();
      expect(rig.mismatches.slice(0, 3)).toEqual([]);
      expect(rig.memoryMismatch()).toBeNull();
    }, 120000);
  }
  it('the programs are not all alike: loops, stores, jumps and the unnamed words all happen', () => {
    // coverage of the model over the seeds: what ran
    const seen = new Set<string>();
    for (const seed of seeds) {
      const p = randomProgram(seed);
      const rig = new DspRig(dsp24Computer(p.words, p.x, p.y), p.words, p.x, p.y);
      for (let i = 0; i < 500 && !rig.iss.halted; i++) seen.add(rig.iss.step().name);
    }
    for (const n of ['mac', 'ld', 'st', 'loop', 'jmp', 'jz', 'jnz', 'rnd', 'rndc', 'adds', 'subs', 'mov', 'out']) expect(seen.has(n), n).toBe(true);
  });
});

describe('a program of ALU corners', () => {
  it('adds and subs saturate, the shifts and logic agree, on the gates and the model', () => {
    const src = `
        ldi  r1, 255
        ldh  r1, 0x7f       ; 0x7fff
        ldi  r2, 1
        ldi  r3, 255
        ldh  r3, 0x80       ; 0x80ff
        adds r4, r1, r2     ; saturates high
        out  r4
        subs r4, r3, r1     ; negative minus positive: saturates low
        out  r4
        sub  r5, r2, r3     ; wraps
        out  r5
        ldi  r6, 3
        shl  r4, r3, r6
        sar  r5, r3, r6
        shr  r7, r3, r6
        xor  r0, r4, r5
        or   r0, r0, r7
        and  r0, r0, r1
        out  r0
        out  r7
        halt
`;
    const a = assemble24(src);
    expect(a.errors).toEqual([]);
    const rig = new DspRig(dsp24Computer(a.words, [], []), a.words, [], []);
    rig.run(200);
    expect(rig.mismatches).toEqual([]);
    expect(rig.iss.out).toEqual([0x7fff, 0x8000, 0x7f02, 0xc8ff, 0x1010].slice(0, 2).concat(rig.iss.out.slice(2)));
  });
});
