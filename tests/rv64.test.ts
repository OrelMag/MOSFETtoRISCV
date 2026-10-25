import { describe, expect, it } from 'vitest';
import { assemble, li64 } from '../src/riscv/asm';
import { decode, disasm, INSTRS64 } from '../src/riscv/isa';
import { ISS64, mExec64 } from '../src/riscv/iss64';

const asm64 = (src: string) => {
  const r = assemble(src, [], { xlen: 64 });
  expect(r.errors).toEqual([]);
  return r.words;
};
const run = (src: string, m = true) => {
  const iss = new ISS64(asm64(src), { m, dmemWords: 64, imemWords: 64 });
  iss.run(1000);
  expect(iss.halted).toBe(true);
  return iss;
};
const M64 = (1n << 64n) - 1n;
const u64 = (v: bigint) => v & M64;

describe('RV64 encodings', () => {
  it('every RV64 instruction decodes and disassembles back to itself', () => {
    const ops: Record<string, string> = {
      lwu: 'lwu a0, -8(s0)', ld: 'ld a0, 16(sp)', sd: 'sd a1, -24(s1)', addiw: 'addiw a0, a1, -5', slliw: 'slliw a0, a1, 31',
      srliw: 'srliw a0, a1, 3', sraiw: 'sraiw a0, a1, 7', addw: 'addw a0, a1, a2', subw: 'subw a0, a1, a2', sllw: 'sllw a0, a1, a2',
      srlw: 'srlw a0, a1, a2', sraw: 'sraw a0, a1, a2', mulw: 'mulw a0, a1, a2', divw: 'divw a0, a1, a2', divuw: 'divuw a0, a1, a2',
      remw: 'remw a0, a1, a2', remuw: 'remuw a0, a1, a2',
    };
    for (const s of INSTRS64) {
      const [w] = asm64(ops[s.name]);
      expect(decode(w, undefined, 64).name, s.name).toBe(s.name);
      expect(disasm(w, 0, undefined, 64)).toBe(ops[s.name]);
      expect(decode(w).spec, `${s.name} is not RV32`).toBeNull();
    }
  });

  it('RV64 shifts take a 6-bit amount; RV32 rejects instr[25]', () => {
    const [w] = asm64('srai a0, a1, 63');
    expect(decode(w, undefined, 64)).toMatchObject({ name: 'srai', imm: 63 });
    expect(decode(w).spec).toBeNull();
    expect(assemble('slli a0, a0, 32').errors).toHaveLength(1);
    expect(assemble('slliw a0, a0, 32', [], { xlen: 64 }).errors).toHaveLength(1);
  });

  it('RV64 mnemonics are refused on RV32', () => {
    for (const src of ['ld a0, 0(sp)', 'addw a0, a1, a2', 'sext.w a0, a1']) expect(assemble(src).errors, src).toHaveLength(1);
  });
});

describe('li on RV64', () => {
  it('loads any 64-bit constant exactly', () => {
    let seed = 7n;
    const rnd = () => (seed = (seed * 6364136223846793005n + 1442695040888963407n) & M64);
    const values = [0n, 1n, -1n, 2047n, -2048n, 2048n, 0x7fffffffn, -0x80000000n, 0x80000000n, 0xffffffffn, 0x7ffff800n,
      0x123456789abcdef0n, -(2n ** 63n), 2n ** 63n - 1n, 0xfffffffffffff800n, 2n ** 32n];
    for (let i = 0; i < 200; i++) values.push(rnd() >> BigInt(i % 64));
    for (const v of values) {
      const iss = run(`li a0, ${v}\nhalt: j halt`);
      expect(iss.x[10], `li ${v}`).toBe(u64(v));
      expect(li64(v).length).toBeLessThanOrEqual(8);
    }
  });
});

describe('ISS64', () => {
  it('W instructions compute on 32 bits and sign-extend', () => {
    const iss = run(`
      li a1, 0x7fffffff
      addiw a2, a1, 1        # wraps to -2^31
      addi a3, a1, 1         # does not
      li a4, 0xffffffff80000000
      srliw a5, a4, 4        # 0x08000000
      srai a6, a4, 4
      sraiw a7, a4, 4
      li t0, 33
      sllw t1, a1, t0        # shift by 1: amount mod 32
      sll t2, a1, t0
      halt: j halt`);
    expect(iss.x[12]).toBe(u64(-(2n ** 31n)));
    expect(iss.x[13]).toBe(0x80000000n);
    expect(iss.x[15]).toBe(0x08000000n);
    expect(iss.x[16]).toBe(u64(-(2n ** 27n)));
    expect(iss.x[17]).toBe(u64(-(2n ** 27n)));
    expect(iss.x[6]).toBe(u64(-2n));
    expect(iss.x[7]).toBe(0x7fffffffn << 33n);
  });

  it('loads and stores every width inside a doubleword', () => {
    const iss = run(`
      li a0, 0x8877665544332211
      sd a0, 8(zero)
      ld a1, 8(zero)
      lw a2, 12(zero)
      lwu a3, 12(zero)
      lh a4, 14(zero)
      lbu a5, 15(zero)
      sb a5, 16(zero)
      sh a4, 18(zero)
      sw a0, 20(zero)
      ld a6, 16(zero)
      halt: j halt`);
    expect(iss.x[11]).toBe(0x8877665544332211n);
    expect(iss.x[12]).toBe(0xffffffff88776655n);
    expect(iss.x[13]).toBe(0x88776655n);
    expect(iss.x[14]).toBe(0xffffffffffff8877n);
    expect(iss.x[15]).toBe(0x88n);
    expect(iss.x[16]).toBe(0x4433221188770088n);
  });

  it('M follows the specification at the edges', () => {
    const min = 1n << 63n, w = 1n << 31n;
    expect(mExec64(4, min, M64)).toBe(min);
    expect(mExec64(6, min, M64)).toBe(0n);
    expect(mExec64(4, 5n, 0n)).toBe(M64);
    expect(mExec64(7, 5n, 0n)).toBe(5n);
    expect(mExec64(3, M64, M64)).toBe(M64 - 1n);
    expect(mExec64(1, M64, M64)).toBe(0n);
    expect(mExec64(2, M64, M64)).toBe(M64);
    expect(mExec64(4, u64(-w), M64, true)).toBe(u64(-w));
    expect(mExec64(6, u64(-w), M64, true)).toBe(0n);
    expect(mExec64(5, 7n, 0n, true)).toBe(M64);
    expect(mExec64(7, 0x1_8000_0000n, 0n, true)).toBe(u64(-w));
    expect(mExec64(0, 0x7fffffffn, 2n, true)).toBe(u64(-2n));
  });
});

describe('WIDTH_COSTS', () => {
  it('are what the generators measure', async () => {
    const { WIDTH_COSTS } = await import('../src/widgets/rv64');
    const L = await import('../src/lib');
    const { stats, logicDepth } = await import('../src/sim/stats');
    const make: Record<string, (n: number) => import('../src/sim/types').ComponentDef> = {
      reg: (n) => L.register(n), rf: (n) => L.regfile(5, n), mux: (n) => L.busMux2(n), rca: (n) => L.rca(n), ks: (n) => L.koggeStone(n),
      sh: (n) => L.shifter(n), zero: (n) => L.isZero(n), alu: (n) => L.alu(n, 'ks'), mul: (n) => L.treeMul(n, true), div: (n) => L.seqDivider(n),
    };
    for (const r of WIDTH_COSTS) {
      const d = [make[r.id](32), make[r.id](64)];
      expect(d.map((x) => stats(x).nands), r.id).toEqual(r.nands);
      if (r.growth === 'time') expect(r.depth).toEqual([34, 66]);
      else expect(r.depth ? d.map((x) => logicDepth(x)) : [logicDepth(d[0]), logicDepth(d[1])], r.id).toEqual(r.depth ?? [null, null]);
    }
  });
});
