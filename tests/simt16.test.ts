import { describe, expect, it } from 'vitest';
import { assemble16 } from '../src/riscv/rv16/asm16';
import { decode16, disasm16 } from '../src/riscv/rv16/isa16';
import { Iss16 } from '../src/riscv/rv16/iss16';
import { Simt16 } from '../src/riscv/rv16/simt16';
import { isIllegal } from '../src/lib/rv16/system';

const warp = (src: string, opts = {}) => {
  const a = assemble16(src);
  expect(a.errors).toEqual([]);
  const w = new Simt16(a.words, { strictInit: true, ...opts }, a.data);
  w.run(5000);
  expect(w.error).toBeNull();
  expect(w.halted).toBe(true);
  return w;
};
const regs = (w: Simt16, r: number) => w.lanes.map((l) => l.x[r]);

describe('RV16 SIMT instructions', () => {
  it('encode in SYSTEM funct3 4–7 and are illegal on every scalar core', () => {
    const a = assemble16('split t0\njoin\ntmc a1\nbar\ncsrr a0, tid');
    expect(a.errors).toEqual([]);
    expect(a.words.slice(0, 4).map((w) => (w >> 13) & 7)).toEqual([4, 5, 6, 7]);
    expect(a.words.map((w, i) => disasm16(w, i))).toEqual(['split t0', 'join', 'tmc a1', 'bar', 'csrrs a0, tid, zero']);
    for (const w of a.words.slice(0, 4)) {
      expect(decode16(w).spec?.ext).toBe('simt');
      expect(isIllegal(w)).toBe(1);
      const iss = new Iss16([w]);
      iss.step();
      expect(iss.error).toMatch(/illegal/);
    }
    // tid reads 0 on a scalar core, as CSR 7 always did
    const iss = new Iss16(assemble16('li a0, 5\ncsrr a0, tid\nhalt').words, { system: true });
    iss.run();
    expect(iss.x[3]).toBe(0);
  });
});

describe('the lane golden model', () => {
  it('runs one instruction on every lane, each with its own tid', () => {
    const w = warp('csrr t0, tid\nslli a0, t0, 2\naddi a0, a0, 1\nsw a0, 16(t0)\nhalt');
    expect(regs(w, 3)).toEqual([1, 5, 9, 13]);
    expect([...w.dmem.slice(16, 20)]).toEqual([1, 5, 9, 13]);
    expect(w.utilization).toBe(1);
    expect(w.steps).toBe(5);
  });

  it('split / join run both sides of an if, one after the other, and reconverge', () => {
    // odd lanes triple, even lanes halve (the chapter 30 kernel)
    const w = warp(`
        csrr t0, tid
        slli t1, t0, 15         # bit 0 of tid, alone
        split t1
        beqz t1, even
        slli a1, t0, 1
        add  a1, a1, t0
        j    done
even:   srli a1, t0, 1
done:   join
        sw   a1, 20(t0)
        halt`);
    expect([...w.dmem.slice(20, 24)]).toEqual([0, 3, 1, 9]);
    expect(w.stack).toEqual([]);
    expect(w.mask).toBe(0b1111);
    expect(w.divergences).toBe(0);
    expect(w.utilization).toBeLessThan(1);
  });

  it('a split the lanes agree on parks nobody; its join just pops', () => {
    const w = warp('li t1, 1\nsplit t1\naddi a0, x0, 7\njoin\nhalt');
    expect(regs(w, 3)).toEqual([7, 7, 7, 7]);
    expect(w.utilization).toBe(1);
  });

  it('nested ifs keep one stack entry per split', () => {
    const w = warp(`
        csrr t0, tid
        li   a0, 0
        srli t1, t0, 1          # bit 1 of tid
        split t1
        beqz t1, lo
        addi a0, a0, 10
        slli a1, t0, 15         # bit 0
        split a1
        beqz a1, j1
        addi a0, a0, 1
j1:     join
lo:     join
        halt`);
    expect(regs(w, 3)).toEqual([0, 0, 10, 11]);
    expect(w.stack).toEqual([]);
  });

  it('a branch the lanes disagree on follows the leader and is counted', () => {
    const w = warp('csrr t0, tid\nli a0, 0\nbnez t0, skip\nli a0, 5\nskip: halt');
    expect(regs(w, 3)).toEqual([5, 5, 5, 5]);
    expect(w.divergences).toBe(1);
  });

  it('tmc takes the leader\'s rs1 as the mask; only the active lanes write; 0 ends the warp', () => {
    const w = warp('li a0, 1\nli t0, 6\ntmc t0\nli a0, 2\nli t0, 1\ntmc t0\ntmc x0\nli a0, 3\nhalt');
    expect(regs(w, 3)).toEqual([1, 2, 2, 1]);
    expect(w.mask).toBe(0);
    expect(w.steps).toBe(7);
  });

  it('stores land lowest lane first; OUT collects every lane\'s word in that order', () => {
    const w = warp('csrr t0, tid\nsw t0, 5(x0)\nsw t0, -3(x0)\nhalt');
    expect(w.dmem[5]).toBe(3);
    expect(w.out).toEqual([0, 1, 2, 3]);
  });

  it('stops with an error on a CSR or trap instruction, and on a register no lane wrote', () => {
    for (const src of ['csrr a0, mepc\nhalt', 'ecall', 'add a0, a1, a2\nhalt']) {
      const a = assemble16(src);
      const w = new Simt16(a.words, { strictInit: true });
      w.run(10);
      expect(w.error, src).not.toBeNull();
    }
  });

  it('save / restore return to the same state', () => {
    const a = assemble16('csrr t0, tid\nandi t1, t0, 1\nsplit t1\nsw t0, 0(t0)\njoin\nhalt');
    const w = new Simt16(a.words);
    w.step(); w.step();
    const s = w.save();
    w.run();
    const end = JSON.stringify([w.pc, w.mask, [...w.dmem.slice(0, 4)], w.steps]);
    w.restore(s);
    expect(w.halted).toBe(false);
    w.run();
    expect(JSON.stringify([w.pc, w.mask, [...w.dmem.slice(0, 4)], w.steps])).toBe(end);
  });
});
