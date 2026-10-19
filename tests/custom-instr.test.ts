// Custom instructions end to end: each row assembled, run on the gate-level single-cycle CPU whose control
// unit gained its opcode class, in lock step with the golden model executing the same row; the control
// unit's cost; the rows' checks.

import { describe, expect, it } from 'vitest';
import { singleCycleCpu } from '../src/lib';
import { CONTROL, control } from '../src/lib/cpu';
import { assemble } from '../src/riscv/asm';
import { clockCycle, cpuState } from '../src/riscv/cosim';
import { CUSTOM_PRESETS, problemsOf, rowsKey, sanitizeRows, type CustomRow } from '../src/riscv/custom';
import { BY_NAME, decode, disasm } from '../src/riscv/isa';
import { ISS } from '../src/riscv/iss';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { stats } from '../src/sim/stats';
import { netlistOf } from '../src/sim/types';
import { labelOverlaps, routeNetlist, symbolOverlaps, wireOverlaps } from '../src/view/route';

const P = Object.fromEntries(CUSTOM_PRESETS.map((r) => [r.name, r]));
const row = (o: Partial<CustomRow> & Pick<CustomRow, 'name' | 'slot' | 'fmt'>): CustomRow =>
  ({ funct3: 0, regWrite: true, srcA: 'rs1', srcB: 'rs2', alu: 'add', memWrite: false, result: 'alu', next: 'pc4', ...o });

/** Each case: the rows, a program using them, what it must leave behind. */
const CASES: { id: string; rows: CustomRow[]; src: string; check?: (iss: ISS) => void }[] = [
  {
    id: 'lwx: indexed load sums an array', rows: [P.lwx],
    src: `li a0, 64
      li t0, 3
      sw t0, 0(a0)
      li t0, 5
      sw t0, 4(a0)
      li t0, 7
      sw t0, 8(a0)
      li t0, 9
      sw t0, 12(a0)
      li t0, 0
      li t1, 0
      li t2, 16
loop: lwx t3, a0, t0
      add t1, t1, t3
      addi t0, t0, 4
      bne t0, t2, loop
done: j done`,
    check: (iss) => expect(iss.x[6]).toBe(24),
  },
  { id: 'ldi: a constant without x0', rows: [P.ldi], src: 'ldi a0, t6, -123\nldi a1, zero, 2047\nhalt: j halt', check: (iss) => expect([iss.x[10] | 0, iss.x[11]]).toEqual([-123, 2047]) },
  { id: 'subi: rs1 − imm', rows: [P.subi], src: 'li a0, 100\nsubi a1, a0, 42\nsubi a2, a0, -5\nhalt: j halt', check: (iss) => expect([iss.x[11], iss.x[12]]).toEqual([58, 105]) },
  {
    id: 'swx and lwx together (two slots)', rows: [P.swx, P.lwx],
    src: 'li a0, 40\nli a1, 8\nswx a1, a0, a1\nlwx a2, a0, a1\nhalt: j halt',
    check: (iss) => { expect(iss.dmem[12]).toBe(8); expect(iss.x[12]).toBe(8); },
  },
  {
    id: 'funct3 picks the ALU operation (xor, sra)', rows: [row({ name: 'opx', slot: 2, fmt: 'I', funct3: 4, srcB: 'imm', alu: 'funct3' })],
    src: 'li a0, 0x0f0\nopx a1, a0, 0x0ff\nhalt: j halt', check: (iss) => expect(iss.x[11]).toBe(0x00f),
  },
  {
    id: 'a PC-relative load', rows: [row({ name: 'lpc', slot: 3, fmt: 'I', srcA: 'pc', srcB: 'imm', result: 'mem' })],
    src: 'li t0, 77\nsw t0, 32(zero)\nlpc a0, zero, 24\nhalt: j halt', check: (iss) => expect(iss.x[10]).toBe(77),
  },
  {
    id: 'a branch (B-type, taken on ≠)', rows: [row({ name: 'bnx', slot: 1, fmt: 'B', funct3: 1, regWrite: false, alu: 'sub', next: 'branch' })],
    src: 'li a0, 3\nli a1, 0\nloop: addi a1, a1, 1\naddi a0, a0, -1\nbnx a0, zero, loop\nhalt: j halt', check: (iss) => expect(iss.x[11]).toBe(3),
  },
  {
    id: 'a jump and link (I-type, ALU target)', rows: [row({ name: 'jlx', slot: 2, fmt: 'I', srcB: 'imm', result: 'pc4', next: 'jalr' })],
    src: 'li t0, 16\njlx ra, t0, 0\nli a0, 1\nhalt: j halt\nli a0, 2\nj halt', check: (iss) => { expect(iss.x[10]).toBe(2); expect(iss.x[1]).toBe(8); },
  },
];

describe('custom instructions: the gates against the golden model', () => {
  for (const c of CASES) {
    it(c.id, () => {
      for (const r of c.rows) expect(problemsOf(r, new Set(BY_NAME.keys())).filter((p) => p.level === 'bad'), r.name).toEqual([]);
      const asm = assemble(c.src, c.rows);
      expect(asm.errors).toEqual([]);
      const sim = new GateSim(flatten(singleCycleCpu(asm.words, { custom: c.rows })));
      sim.setInput('clk', 0);
      sim.settle();
      const iss = new ISS(asm.words, { custom: c.rows });
      let cycles = 0;
      while (!iss.halted && cycles < 400) {
        expect(cpuState(sim).pc, `cycle ${cycles}: pc`).toBe(iss.pc);
        iss.step();
        clockCycle(sim);
        cycles++;
        expect(cpuState(sim).x, `cycle ${cycles}`).toEqual([...iss.x]);
      }
      expect(iss.halted).toBe(true);
      expect(cpuState(sim).dmem).toEqual([...iss.dmem]);
      c.check?.(iss);
      // the listing reads the new mnemonics back
      for (const r of c.rows) expect(asm.words.some((w) => disasm(w, undefined, c.rows).startsWith(r.name)), r.name).toBe(true);
    }, 120000);
  }
});

describe('custom instructions: hardware and rows', () => {
  it('the control unit grows by an AND and an OR input per asserted signal', () => {
    const base = stats(CONTROL).nands;
    expect(base).toBe(152);
    // lwx asserts regWrite and resSrc0: +8 (andN(5)) + 3 + 3
    expect(stats(control([P.lwx])).nands - base).toBe(14);
  });

  it('without custom rows nothing changes', () => {
    expect(control([])).toBe(CONTROL);
    expect(singleCycleCpu([0x6f], {}).id).toBe(singleCycleCpu([0x6f], { custom: [] }).id);
  });

  it('a custom slot decodes as its row whatever funct3, and only with the rows', () => {
    const w = assemble('lwx a0, a1, a2', [P.lwx]).words[0];
    expect(decode(w).spec).toBeNull();
    expect(decode(w, [P.lwx]).name).toBe('lwx');
    expect(decode(w | (5 << 12), [P.lwx]).name).toBe('lwx');
  });

  it('the checks name what the data path cannot do', () => {
    expect(problemsOf(row({ name: 'x', slot: 1, fmt: 'S', regWrite: true })).some((p) => /no rd/.test(p.text))).toBe(true);
    expect(problemsOf(row({ name: 'x', slot: 1, fmt: 'R', srcB: 'imm' })).some((p) => /no immediate/.test(p.text))).toBe(true);
    expect(problemsOf(row({ name: 'x', slot: 1, fmt: 'B', regWrite: false, next: 'branch' })).some((p) => /subtract/.test(p.text))).toBe(true);
    expect(problemsOf(row({ name: 'add', slot: 1, fmt: 'R' }), new Set(['add'])).some((p) => /already/.test(p.text))).toBe(true);
  });

  it('stored rows are sanitized: one per slot and per name', () => {
    expect(sanitizeRows([P.lwx, { ...P.subi, slot: 1 }, { ...P.swx, name: 'lwx' }, { bogus: 1 }, P.subi])).toEqual([P.lwx, P.subi]);
    expect(rowsKey([P.lwx, P.subi])).toBe(rowsKey([P.subi, P.lwx]));
  });
});

describe('custom instructions: the drawings', () => {
  // Generated per set of rows, so the registry-wide layout / route tests never see them: checked here.
  const rows = [P.lwx, P.subi, P.swx, row({ name: 'bnx', slot: 1, fmt: 'B', funct3: 1, regWrite: false, alu: 'sub', next: 'branch' })].slice(0, 3);
  const withBranch = [row({ name: 'bnx', slot: 1, fmt: 'B', funct3: 1, regWrite: false, alu: 'sub', next: 'branch' }), P.subi, P.swx];
  for (const set of [rows, withBranch]) {
    it(`control unit with ${set.map((r) => r.name).join(', ')}: no overlaps`, () => {
      for (const d of [control(set), singleCycleCpu([0x6f], { custom: set })]) {
        const nl = netlistOf(d)!;
        expect(symbolOverlaps(nl), d.id).toEqual([]);
        expect(labelOverlaps(d, nl), d.id).toEqual([]);
        expect(wireOverlaps(routeNetlist(d, nl).nets).length, d.id).toBe(0);
      }
    }, 120000);
  }
});
