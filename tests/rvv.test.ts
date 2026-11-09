// The vector extension's golden model (riscv/rvv.ts) through the assembler, the disassembler and the ISS: encodings
// against the specification's fields, vsetvl's rules, every instruction's semantics on small cases worked by hand,
// and one strip-mined loop that runs unchanged at three vector lengths.
import { describe, expect, it } from 'vitest';
import { assemble } from '../src/riscv/asm';
import { disasm } from '../src/riscv/isa';
import { ISS } from '../src/riscv/iss';
import { decodeV, V_MNEMONICS, VILL, vtypeOf } from '../src/riscv/rvv';

function asm(src: string): number[] {
  const a = assemble(src);
  if (a.errors.length) throw new Error(`line ${a.errors[0].line}: ${a.errors[0].message}`);
  return a.words;
}

/** Run a program to its `j .` on an ISS with vectors. */
function run(src: string, vlen = 128, opts: { system?: boolean; dmemWords?: number } = {}): ISS {
  const words = asm(`${src}\nhalt: j halt\n`);
  const iss = new ISS(words, { v: { vlen }, m: true, dmemWords: opts.dmemWords ?? 256, imemWords: 256, system: opts.system });
  iss.run(20_000);
  expect(iss.halted, 'reaches its halt').toBe(true);
  return iss;
}

/** Element i of v<reg> at width sew, unsigned. */
const elt = (iss: ISS, reg: number, i: number, sew = 32) => {
  const b = reg * iss.vlenb + (i * sew) / 8;
  let v = 0;
  for (let k = sew / 8 - 1; k >= 0; k--) v = v * 256 + iss.vregs[b + k];
  return v;
};

describe('encodings', () => {
  it('match the specification for instructions worked out by hand', () => {
    // vsetvli t0, a0, e32, m4, ta, ma: zimm 0xd2, rs1 10, funct3 7, rd 5, OP-V
    expect(asm('vsetvli t0, a0, e32, m4, ta, ma')[0]).toBe(0x0d2572d7);
    // vadd.vv v8, v16, v24: funct6 0, vm 1, vs2 16, vs1 24, funct3 OPIVV, vd 8
    expect(asm('vadd.vv v8, v16, v24')[0]).toBe(0x030c0457);
    // the same masked: vm 0
    expect(asm('vadd.vv v8, v16, v24, v0.t')[0]).toBe(0x010c0457);
    // vle32.v v8, (a1): LOAD-FP, width 6, unit stride, vm 1
    expect(asm('vle32.v v8, (a1)')[0]).toBe(0x0205e407);
    // vse32.v v8, (a1): STORE-FP
    expect(asm('vse32.v v8, (a1)')[0]).toBe(0x0205e427);
    // flw / fsw keep their own width (2), so they are not vector words
    expect(decodeV(asm('flw ft0, 0(a0)')[0])).toBeNull();
    expect(decodeV(asm('fsw ft0, 0(a0)')[0])).toBeNull();
  });

  it('every mnemonic round-trips through the disassembler', () => {
    const operands = (op: string): string => {
      if (op === 'vsetvli') return 'a0, a1, e16, mf2, ta, mu';
      if (op === 'vsetivli') return 'a0, 13, e8, m8, tu, ma';
      if (op === 'vsetvl') return 'a0, a1, a2';
      if (/^v[ls]s?e\d+\.v$/.test(op)) return op.includes('se') && /^v[ls]s/.test(op) ? 'v8, (a1), a2, v0.t' : 'v8, (a1), v0.t';
      if (op === 'vmv.x.s') return 'a0, v8';
      if (op === 'vmv.s.x') return 'v8, a0';
      if (op === 'vid.v') return 'v8, v0.t';
      if (op === 'vmv.v.v') return 'v8, v16';
      if (op === 'vmv.v.x') return 'v8, a3';
      if (op === 'vmv.v.i') return 'v8, -7';
      if (op.startsWith('vmerge')) return `v8, v16, ${op[8] === 'v' ? 'v24' : op[8] === 'x' ? 'a3' : '5'}, v0`;
      const f = op.slice(op.lastIndexOf('.') + 1);
      return `v8, v16, ${f === 'vv' || f === 'vs' ? 'v24' : f === 'vx' ? 'a3' : /^vs(ll|rl|ra)/.test(op) ? '29' : '-9'}, v0.t`;
    };
    for (const op of V_MNEMONICS) {
      const w = asm(`${op} ${operands(op)}`)[0];
      expect(decodeV(w), op).not.toBeNull();
      const text = disasm(w);
      expect(text.split(' ')[0], op).toBe(op);
      expect(asm(text)[0], `${op}: ${text}`).toBe(w);
    }
  });

  it('refuses what is not an operand', () => {
    for (const bad of ['vadd.vv v8, v16', 'vadd.vi v8, v16, 16', 'vsll.vi v8, v16, 32', 'vsetvli t0, a0, m4', 'vsetvli t0, a0, e32, m3', 'vmerge.vvm v8, v16, v24, v0.t', 'vmv.x.s a0, v8, v0.t', 'vadd.vv v8, v16, x3'])
      expect(assemble(bad).errors.length, bad).toBe(1);
  });
});

describe('vsetvl', () => {
  it('VLMAX = LMUL · VLEN / SEW, vl = min(AVL, VLMAX), and rd = x0 / rs1 = x0 as specified', () => {
    const iss = run(`
      li a0, 100
      vsetvli t0, a0, e32, m1, tu, mu   # 4
      vsetvli t1, a0, e32, m8, tu, mu   # 32
      li a1, 7
      vsetvli t2, a1, e8, m1, tu, mu    # 7 of 16
      vsetvli t3, x0, e16, mf2, tu, mu  # rd != x0, rs1 = x0: VLMAX = 4
      vsetvli x0, x0, e16, m1, tu, mu   # keep vl = 4 (VLMAX 8)
      csrr t4, vl
      vsetivli t5, 9, e32, m2, ta, ma   # 8
      csrr t6, vtype
      csrr s1, vlenb`);
    expect([...iss.x.slice(5, 8), iss.x[28], iss.x[29], iss.x[30], iss.x[31], iss.x[9]]).toEqual([4, 32, 7, 4, 4, 8, 0xc1 | (2 << 3), 16]);
  });

  it('an unsupported vtype sets vill and vl = 0, and then only vset* is legal', () => {
    for (const vt of ['e64, m1', 'e8, mf8', 'e16, mf4', 'e32, mf2']) {
      const iss = run(`li a0, 5\nvsetvli t0, a0, e32, m1\nvsetvli t0, a0, ${vt}\ncsrr t1, vtype\ncsrr t2, vl`);
      expect([iss.x[5], iss.x[6], iss.x[7]], vt).toEqual([0, VILL, 0]);
    }
    expect(vtypeOf(0x100)).toBeNull(); // a reserved bit
    expect(vtypeOf(4)).toBeNull(); // vlmul 100
    const sys = run(`la t0, trap\ncsrw mtvec, t0\nvsetvli t0, x0, e64, m1\nvadd.vv v1, v2, v3\nj halt\ntrap: li a0, 99\ncsrr a1, mcause`, 128, { system: true });
    expect([sys.x[10], sys.x[11]]).toEqual([99, 2]);
  });
});

describe('arithmetic, masks, memory', () => {
  it('one strip-mined loop, unchanged, at three vector lengths: y = 3·x + y, and fewer passes the longer the registers', () => {
    const n = 37;
    const kernel = `
      li a0, ${n}
      li a1, 0            # x at 0
      li a2, 256          # y at 256
      li s0, 0            # passes
    loop:
      vsetvli t0, a0, e32, m1, tu, mu
      vle32.v v8, (a1)
      vle32.v v16, (a2)
      vsll.vi v24, v8, 1
      vadd.vv v24, v24, v8
      vadd.vv v16, v16, v24
      vse32.v v16, (a2)
      sub a0, a0, t0
      slli t1, t0, 2
      add a1, a1, t1
      add a2, a2, t1
      addi s0, s0, 1
      bnez a0, loop`;
    for (const [vlen, passes] of [[128, 10], [256, 5], [512, 3]]) {
      const words = asm(`${kernel}\nhalt: j halt\n`);
      const iss = new ISS(words, { v: { vlen }, dmemWords: 256, imemWords: 64 });
      for (let i = 0; i < n; i++) { iss.dmem[i] = (i * 7 + 1) >>> 0; iss.dmem[64 + i] = (1000 - i) >>> 0; }
      iss.run(10_000);
      for (let i = 0; i < n; i++) expect(iss.dmem[64 + i], `vlen ${vlen} y[${i}]`).toBe((3 * (i * 7 + 1) + 1000 - i) >>> 0);
      expect(iss.dmem[64 + n], 'nothing past n').toBe(0);
      expect(iss.x[8], `vlen ${vlen}`).toBe(passes);
    }
  });

  it('elements wrap at SEW, and shifts read only log2(SEW) bits of the amount', () => {
    const iss = run(`
      vsetivli t0, 16, e8, m1, tu, mu
      vmv.v.i v1, -1
      vadd.vi v2, v1, 3      # 0xff + 3 = 0x02
      li a0, 9
      vsll.vx v3, v1, a0     # 9 & 7 = 1: 0xfe
      vsra.vi v4, v1, 7      # -1 >> 7 = 0xff
      vsrl.vi v5, v1, 7      # 0x01
      vmv.x.s a1, v1         # sign-extended: 0xffffffff
      vsetivli t0, 8, e16, m1, tu, mu
      vmv.v.i v6, -16
      vmax.vx v7, v6, x0     # signed: 0
      vmaxu.vx v8, v6, x0    # unsigned: 0xfff0
      vrsub.vi v9, v6, 0     # 0 - (-16) = 16`);
    expect([elt(iss, 2, 15, 8), elt(iss, 3, 0, 8), elt(iss, 4, 3, 8), elt(iss, 5, 9, 8), iss.x[11]]).toEqual([2, 0xfe, 0xff, 1, 0xffffffff]);
    expect([elt(iss, 7, 2, 16), elt(iss, 8, 2, 16), elt(iss, 9, 7, 16)]).toEqual([0, 0xfff0, 16]);
  });

  it('a compare writes a mask; v0.t leaves masked-off and tail elements undisturbed; vmerge picks by v0', () => {
    const iss = run(`
      vsetivli t0, 8, e32, m2, tu, mu
      vid.v v8                    # 0 1 2 … 7
      vmv.v.i v10, 9              # untouched past vl later
      li a0, 5
      vmslt.vx v0, v8, a0         # 0..4
      vsetivli t0, 6, e32, m2, tu, mu
      vadd.vi v10, v8, 10, v0.t   # elements 0..4: i + 10; 5: masked off (9); 6, 7: tail (9)
      vmerge.vim v12, v8, -1, v0  # 0..4: -1, 5: 5, 6, 7: untouched (0)
      vredsum.vs v14, v8, v8      # v8[0] + 0 + 1 + … + 5 = 15
      vredsum.vs v15, v8, v8, v0.t # 0 + 0 + 1 + 2 + 3 + 4 = 10`);
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((i) => elt(iss, 10, i))).toEqual([10, 11, 12, 13, 14, 9, 9, 9]);
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((i) => elt(iss, 12, i) | 0)).toEqual([-1, -1, -1, -1, -1, 5, 0, 0]);
    expect(iss.vregs[0]).toBe(0b00011111);
    expect([elt(iss, 14, 0), elt(iss, 15, 0)]).toEqual([15, 10]);
  });

  it('loads and stores: unit stride at every width, strided, masked, and only the elements below vl', () => {
    const iss = run(`
      li a1, 0
      li a2, 64
      vsetivli t0, 5, e16, m1, tu, mu
      vle16.v v1, (a1)
      vse16.v v1, (a2)            # 5 halfwords at 64: bytes 64..73
      vsetivli t0, 3, e8, m1, tu, mu
      li a3, 8
      li a4, 128
      vlse32.v v2, (a1), a3       # EEW 32 at SEW 8: EMUL 4, so v2 is not aligned: illegal, nothing happens
      vlse8.v v3, (a1), a3        # bytes 0, 8, 16
      vse8.v v3, (a4)
      vmv.v.i v0, 5               # mask 0b101
      li a5, 160
      vse8.v v3, (a5), v0.t       # bytes 160, 162`, 128, { dmemWords: 64 });
    const fill = (w: ISS) => { for (let i = 0; i < 16; i++) w.dmem[i] = (0x11111111 * (i % 15 + 1)) >>> 0; };
    const words = asm(`
      li a1, 0
      li a2, 64
      vsetivli t0, 5, e16, m1, tu, mu
      vle16.v v1, (a1)
      vse16.v v1, (a2)
      vsetivli t0, 3, e8, m1, tu, mu
      li a3, 8
      li a4, 128
      vlse8.v v3, (a1), a3
      vse8.v v3, (a4)
      vmv.v.i v0, 5
      li a5, 160
      vse8.v v3, (a5), v0.t
      halt: j halt`);
    const w = new ISS(words, { v: { vlen: 128 }, dmemWords: 64, imemWords: 64 });
    fill(w);
    w.run(1000);
    expect(w.dmem[16]).toBe(0x11111111);
    expect(w.dmem[17]).toBe(0x22222222);
    expect(w.dmem[18] & 0xffff).toBe(0x3333);
    expect(w.dmem[18] >>> 16).toBe(0); // the sixth halfword was not stored
    expect(w.dmem[32] & 0xffffff).toBe(0x553311); // bytes 0, 8, 16: 0x11, 0x33, 0x55
    expect(w.dmem[40] & 0xffffff).toBe(0x550011); // masked: bytes 160 and 162 only
    expect(elt(iss, 2, 0)).toBe(0);
  });

  it('a register group not aligned to LMUL is illegal: a trap in system mode, nothing at all otherwise', () => {
    const user = run('vsetivli t0, 4, e32, m4\nvmv.v.i v8, 7\nvadd.vi v10, v8, 1');
    expect(elt(user, 10, 0)).toBe(0);
    const sys = run(`la t0, trap\ncsrw mtvec, t0\nvsetivli t0, 4, e32, m4\nvadd.vi v10, v8, 1\nj halt\ntrap: csrr a1, mcause`, 128, { system: true });
    expect(sys.x[11]).toBe(2);
  });

  it('vmul at every width, and save() / restore() carry the vector state', () => {
    const words = asm('vsetivli t0, 4, e16, m1\nvid.v v1\nli a0, 0x1234\nvmul.vx v2, v1, a0\nvmul.vv v3, v2, v2\nhalt: j halt');
    const iss = new ISS(words, { v: { vlen: 128 }, imemWords: 16 });
    iss.step(); iss.step();
    const snap = iss.save();
    iss.run(100);
    expect(elt(iss, 2, 3, 16)).toBe((3 * 0x1234) & 0xffff);
    expect(elt(iss, 3, 3, 16)).toBe(Number((BigInt((3 * 0x1234) & 0xffff) ** 2n) & 0xffffn));
    iss.restore(snap);
    expect([iss.vl, elt(iss, 2, 3, 16)]).toEqual([4, 0]);
  });
});
