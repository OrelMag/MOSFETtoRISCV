import { describe, expect, it } from 'vitest';
import { assemble } from '../src/riscv/asm';
import { disasm } from '../src/riscv/isa';
import { SimtISS } from '../src/riscv/simt';
import { SIMT_PROGRAMS } from '../src/riscv/simtprograms';

describe('SIMT instructions', () => {
  it('assemble to custom-0 and disassemble back', () => {
    const src = ['tmc t4', 'wspawn a0, a1', 'split t1', 'join', 'bar a0, a1', 'pred t1, s0', 'csrr t0, lane', 'csrr t0, tid', 'csrr s0, tmask'];
    const r = assemble(src.join('\n'));
    expect(r.errors).toEqual([]);
    expect(r.words.slice(0, 6).every((w) => (w & 0x7f) === 0b0001011)).toBe(true);
    expect(r.words.map((w) => disasm(w))).toEqual(['tmc t4', 'wspawn a0, a1', 'split t1', 'join', 'bar a0, a1', 'pred t1, s0', 'csrrs t0, lane, zero', 'csrrs t0, tid, zero', 'csrrs s0, tmask, zero']);
  });
});

describe('SIMT golden model', () => {
  for (const p of SIMT_PROGRAMS) {
    for (const n of [2, 4, 8]) {
      it(`${p.id}, ${n} lanes`, () => {
        const a = assemble(p.source);
        expect(a.errors).toEqual([]);
        const m = new SimtISS(a.words, { lanes: n });
        m.run(5000);
        expect(m.halted).toBe(true);
        for (const [i, v] of p.expect(n)) expect(m.dmem[i], `word ${i}`).toBe(v >>> 0);
        expect(m.divergences > 0).toBe(p.id === 'nosplit');
        expect(m.stack).toEqual([]);
        if (n === 4) console.log(`${p.id}: ${m.retired} warp instructions, ${m.cycles} cycles, utilization ${(100 * m.utilization).toFixed(0)} %`);
      });
    }
  }

  it('split / join: the stack holds one entry per split', () => {
    const a = assemble(SIMT_PROGRAMS.find((p) => p.id === 'diverge')!.source);
    const m = new SimtISS(a.words, { lanes: 4 });
    const seen: string[] = [];
    while (!m.halted) {
      const s = m.step();
      seen.push(`${s.text.split(' ')[0]}:${s.mask.toString(2).padStart(4, '0')}:${m.stack.length}`);
    }
    expect(seen.slice(0, 11)).toEqual([
      'csrrs:1111:0', 'andi:1111:0', 'split:1111:1', 'beq:1010:1', 'slli:1010:1', 'add:1010:1', 'jal:1010:1',
      'join:1010:1', 'beq:0101:1', 'srli:0101:1', 'join:0101:0',
    ]);
  });

  it('a split on which the lanes agree pushes nothing to run', () => {
    const m = new SimtISS(assemble('li t1, 1\nsplit t1\njoin\nend: j end').words, { lanes: 4 });
    m.step(); m.step();
    expect(m.stack).toEqual([{ mask: 15, elseMask: 0, pc: 8, pending: false }]);
    expect(m.mask).toBe(15);
    m.step();
    expect(m.stack).toEqual([]);
  });

  it('save and restore', () => {
    const m = new SimtISS(assemble(SIMT_PROGRAMS[1].source).words, { lanes: 4 });
    for (let i = 0; i < 4; i++) m.step();
    const s = m.save();
    m.run();
    const end = [...m.dmem];
    m.restore(s);
    expect(m.stack.length).toBe(1);
    m.run();
    expect([...m.dmem]).toEqual(end);
  });
});
