// The vector unit in gates (lib/vector.ts) against the golden model's gate subset (ISS({ v: { vlen: 128, gates: true } })):
// its blocks against their references, then singleCycleCpu(…, { vector }) in lock step after every retired instruction
// (x registers, PC, vl, vtype, every byte of the 32 vector registers, the data memory) on directed programs (every OPI
// operation and form, masked and not, at m1 and m2; loads and stores at every word offset; vset's corner cases; the
// illegal cases, which do nothing) and random ones. tests/verify-vector.test.ts runs the riscv-tests and the fuzz suite.
import { describe, expect, it } from 'vitest';
import { singleCycleCpu } from '../src/lib/cpu';
import { VEC_ALU, VSET_VL, vecAluRef, vsetRef } from '../src/lib/vector';
import { assemble } from '../src/riscv/asm';
import { clockCycle, cpuState } from '../src/riscv/cosim';
import { ISS } from '../src/riscv/iss';
import { randomProgram32, rng } from '../src/riscv/randprog32';
import { VILL, execV, isVectorWord, type VContext } from '../src/riscv/rvv';
import { CycleSim } from '../src/sim/cyclesim';
import { DualSim } from '../src/sim/dualsim';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { evalOnce, simulate } from '../src/sim/harness';
import { pack } from '../src/sim/values';
import { tick } from './yieldtick';

const VECTOR = { lanes: 4, vlen: 128 } as const;
const build = (words: number[]) => singleCycleCpu(words, { imemK: 8, dmemK: 6, vector: VECTOR });

/** Lock step after every retirement; '' when every check agrees. Counts the vector instructions retired. */
function lockstep(words: number[], limit = 5000): { diff: string; retired: number; vector: number; cycles: number } {
  const sim = new GateSim(flatten(build(words)));
  sim.setInput('clk', 0);
  sim.settle();
  const iss = new ISS(words, { v: { vlen: 128, gates: true }, dmemWords: 64, imemWords: 256 });
  let cycles = 0, retired = 0, vector = 0;
  while (!iss.halted && cycles < limit) {
    if (cpuState(sim).pc !== iss.pc) return { diff: `pc ${cpuState(sim).pc} against ${iss.pc} at cycle ${cycles}`, retired, vector, cycles };
    const ret = pack(sim.getBits(sim.design.root.ports.retire));
    const word = iss.instrAt(iss.pc).word;
    const info = ret ? iss.step() : undefined;
    clockCycle(sim);
    cycles++;
    if (!info) continue;
    retired++;
    if (isVectorWord(word)) vector++;
    const st = cpuState(sim), d: string[] = [];
    st.x.forEach((v, i) => v !== iss.x[i] && d.push(`x${i} ${v} against ${iss.x[i]}`));
    if (st.vl !== iss.vl) d.push(`vl ${st.vl} against ${iss.vl}`);
    if (st.vtype !== iss.vtype >>> 0) d.push(`vtype ${st.vtype} against ${iss.vtype >>> 0}`);
    for (let r = 0; r < 32; r++) {
      const a = [...st.v!.slice(16 * r, 16 * r + 16)].join(), b = [...iss.vregs.slice(16 * r, 16 * r + 16)].join();
      if (a !== b) d.push(`v${r} [${a}] against [${b}]`);
    }
    st.dmem.forEach((v, i) => v !== iss.dmem[i] && d.push(`word ${i}: ${v} against ${iss.dmem[i]}`));
    if (d.length) return { diff: `after ${info.text} (instruction ${retired}): ${d.slice(0, 4).join('; ')}`, retired, vector, cycles };
  }
  return { diff: iss.halted ? '' : 'no halt', retired, vector, cycles };
}

const asm = (src: string) => {
  const r = assemble(src);
  if (r.errors.length) throw new Error(`line ${r.errors[0].line}: ${r.errors[0].message}`);
  return r.words;
};

/** Registers v2…v9 filled with varied words (negatives, the extremes, small numbers) at m2, scalars with edge values. */
const SETUP = `
  li t0, 8
  vsetvli zero, t0, e32, m2, tu, mu
  vid.v v2
  vrsub.vi v4, v2, 3
  li t1, 0x7ffffffe
  vadd.vx v6, v2, t1
  li t1, 0x80000001
  vxor.vx v8, v4, t1
  li a0, 0x80000000
  li a1, -1
  li a2, 5
  li a3, 0x7fffffff
`;
const OPI: [string, string[]][] = [
  ['vadd', ['vv', 'vx', 'vi']], ['vsub', ['vv', 'vx']], ['vrsub', ['vx', 'vi']], ['vminu', ['vv', 'vx']], ['vmin', ['vv', 'vx']],
  ['vmaxu', ['vv', 'vx']], ['vmax', ['vv', 'vx']], ['vand', ['vv', 'vx', 'vi']], ['vor', ['vv', 'vx', 'vi']], ['vxor', ['vv', 'vx', 'vi']],
  ['vmseq', ['vv', 'vx', 'vi']], ['vmsne', ['vv', 'vx', 'vi']], ['vmsltu', ['vv', 'vx']], ['vmslt', ['vv', 'vx']], ['vmsleu', ['vv', 'vx', 'vi']],
  ['vmsle', ['vv', 'vx', 'vi']], ['vmsgtu', ['vx', 'vi']], ['vmsgt', ['vx', 'vi']], ['vsll', ['vv', 'vx', 'vi']], ['vsrl', ['vv', 'vx', 'vi']], ['vsra', ['vv', 'vx', 'vi']],
];

describe('vector unit blocks', () => {
  it('vset: the gates agree with the golden model\'s vset, and vsetRef with execV', () => {
    const sim = simulate(VSET_VL), r = rng(7);
    const u32 = () => (r() * 2 ** 32) >>> 0, int = (n: number) => Math.floor(r() * n);
    for (let i = 0; i < 1500; i++) {
      const vt = r() < 0.6 ? (0x10 | int(8) | (int(4) << 6) | (r() < 0.2 ? 1 << int(11) : 0)) : r() < 0.5 ? int(256) : u32();
      const form = int(3), rs1 = int(32), rd = int(32);
      const w = ((form === 0 ? (vt & 0x7ff) << 20 : form === 1 ? 0xc0000000 | ((vt & 0x3ff) << 20) : 0x80000000 | (2 << 20)) | (rs1 << 15) | (7 << 12) | (rd << 7) | 0x57) >>> 0;
      const x1 = r() < 0.5 ? int(70) : u32(), vl = int(33);
      expect(evalOnce(sim, [w, x1, vt, vl]), w.toString(16)).toEqual(vsetRef(w, x1, vt, vl));
      // the golden model: rs1 / rs2 = x1 / x2, the old vl under a valid vtype
      const x = new Uint32Array(32);
      if (rs1) x[rs1] = x1;
      const w2 = form === 2 ? ((w & ~(31 << 20)) | (2 << 20)) >>> 0 : w;
      x[2] = form === 2 ? vt : x[2];
      if (form === 2 && rs1 === 2) continue; // rs1 and rs2 the same register: x1 is not what the gates were given
      const c: VContext = { vlenb: 16, vregs: new Uint8Array(512), vl, vtype: 0x10, x, gates: true, load: () => 0, store: () => {} };
      const res = execV(w2, c), [vlNew, , legal] = vsetRef(w2, x1, vt, vl);
      expect([c.vl, c.vtype === VILL ? 0 : 1, res.value], w2.toString(16)).toEqual([vlNew, legal, vlNew]);
    }
  });

  it('the lane ALU: every operation against its reference', () => {
    const sim = simulate(VEC_ALU), r = rng(3);
    const u32 = () => (r() * 2 ** 32) >>> 0, bit = () => (r() < 0.5 ? 1 : 0);
    const EDGE = [0, 1, 0x7fffffff, 0x80000000, 0xffffffff, 31, 32];
    for (let i = 0; i < 1500; i++) {
      const pick = () => (r() < 0.3 ? EDGE[Math.floor(r() * EDGE.length)] : u32());
      const v = [pick(), pick(), pick(), bit(), bit(), [0, 8, 7, 6, 4, 1, 5, 13][Math.floor(r() * 8)], bit(), bit(), bit(), bit(), Math.floor(r() * 8), Math.floor(r() * 4), Math.floor(r() * 32), u32()];
      expect(evalOnce(sim, v)).toEqual(vecAluRef(v));
    }
  });
});

describe('the single-cycle CPU with the vector unit, in lock step with the golden model', () => {
  it('leaves the plain CPU alone and refuses what it does not support', () => {
    const w = [0x0000006f];
    expect(singleCycleCpu(w)).toBe(singleCycleCpu(w, {}));
    expect(singleCycleCpu(w).id).not.toMatch(/_v$/);
    expect(build(w).id).toMatch(/_v$/);
    expect(singleCycleCpu(w).ports.some((p) => p.name === 'retire')).toBe(false);
    expect(() => singleCycleCpu(w, { vector: VECTOR, fpu: true })).toThrow(/vector/);
    expect(() => singleCycleCpu(w, { vector: VECTOR, c: true })).toThrow(/vector/);
    expect(() => singleCycleCpu(w, { vector: { lanes: 8, vlen: 128 } as never })).toThrow(/lanes/);
  });

  for (const lmul of ['m1', 'm2']) {
    for (const masked of [false, true]) {
      it(`every OPI operation and form at ${lmul}, ${masked ? 'masked' : 'unmasked'}, vl = 5`, () => {
        const g = lmul === 'm2' ? 2 : 1, t = masked ? ', v0.t' : '';
        const lines = [SETUP, 'vmslt.vx v0, v2, a2', 'li t0, 5', `vsetvli zero, t0, e32, ${lmul}, tu, mu`];
        let d = 10;
        for (const [op, forms] of OPI) {
          for (const f of forms) {
            const src = f === 'vv' ? `v${2 * g}` : f === 'vx' ? pickX(op) : op.startsWith('vs') && !op.startsWith('vms') ? '7' : '-3';
            lines.push(`${op}.${f} v${d}, v6, ${src}${t}`);
            d = d + g >= 32 ? 10 : d + g;
            if (d % g) d += g - (d % g);
          }
        }
        lines.push('vredsum.vs v1, v6, v8' + t, 'vmv.x.s s1, v1', 'j .');
        const r = lockstep(asm(lines.join('\n')));
        expect(r.diff).toBe('');
        expect(r.vector).toBeGreaterThan(50);
      });
    }
  }

  it('loads and stores at every word offset, at m1 … m8, masked and not, with tails', () => {
    const lines = [SETUP];
    for (const [lm, vl] of [['m1', 3], ['m2', 7], ['m4', 13], ['m8', 30]] as const) {
      for (let off = 0; off < 4; off++) {
        lines.push(`li t0, ${vl}`, `vsetvli zero, t0, e32, ${lm}, tu, mu`, `li a4, ${4 * off}`, `vse32.v v8, (a4)`, `li a5, ${16 + 4 * off}`, `vle32.v v16, (a5)`, 'vmsgtu.vi v0, v16, 4', `vse32.v v16, (a4), v0.t`, `vle32.v v24, (a5), v0.t`);
      }
    }
    lines.push('j .');
    const r = lockstep(asm(lines.join('\n')));
    expect(r.diff).toBe('');
    expect(r.vector).toBeGreaterThan(100);
  });

  it('vset\'s corner cases, the illegal instructions and the ones outside the subset do as the golden model does', () => {
    const r = lockstep(asm(`
      vadd.vv v1, v2, v3          # vill at power-on: nothing
      li t1, 9
      .word 0x82037357            # bit 31 set, 30 clear, not vsetvl: no vset (rd t1 keeps 9)
      csrr t1, vtype
      li t0, 30
      vsetvli t2, t0, e32, m8, ta, ma
      vsetvli zero, zero, e32, m1, tu, mu   # keep vl, capped at the new VLMAX
      csrr t3, vl
      vsetvli t4, zero, e32, m4, tu, mu     # rs1 = x0, rd != x0: VLMAX
      li t5, 0x1d0
      vsetvl s2, t0, t5           # a reserved bit: vill
      csrr s3, vtype
      vid.v v8                    # under vill: nothing
      li t5, 0xd1
      vsetvl s4, t0, t5           # e32 m2 ta ma
      vadd.vv v3, v2, v4          # misaligned group: nothing
      vadd.vv v0, v2, v4, v0.t    # a masked write to v0: nothing
      vmseq.vv v3, v2, v4         # a mask inside a source group: nothing
      vmseq.vv v2, v2, v4         # on its first register: fine
      vmerge.vvm v0, v2, v4, v0   # masked merge into v0: nothing
      vid.v v4
      vmul.vv v6, v4, v4          # outside the subset: nothing
      li a4, 8
      vlse32.v v6, (a4), a4       # strided: nothing
      vle8.v v6, (a4)             # narrow: nothing
      vse32.v v4, (a4)
      vsetivli s5, 0, e32, m1, tu, mu
      vredsum.vs v9, v4, v4       # vl = 0: no write
      vmv.s.x v10, t0             # vl = 0: no write
      vmv.x.s s6, v4
      vsetivli s7, 9, e16, m1, tu, mu   # e16: vill here
      csrr s8, vtype
      csrr s9, vlenb
      csrr s10, vstart
      j .
    `));
    expect(r.diff).toBe('');
  });

  it('random programs with vector units (the gate subset), after every instruction', async () => {
    let vector = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const words = asm(randomProgram32(seed, { v: true, vGates: true, dmemWords: 64, n: 40 }));
      const r = lockstep(words);
      expect(r.diff, `seed ${seed}`).toBe('');
      vector += r.vector;
      await tick();
    }
    expect(vector).toBeGreaterThan(300);
  }, 120_000);

  it('runs on the cycle engine to the same state', () => {
    const words = asm(randomProgram32(5, { v: true, vGates: true, dmemWords: 64, n: 40 }));
    const design = flatten(build(words));
    expect(CycleSim.build(design)).toBeInstanceOf(CycleSim);
    const ds = new DualSim(design), gs = new GateSim(design);
    ds.reset('zero');
    gs.reset('zero');
    ds.preferFast = true;
    ds.prepare();
    for (const s of [ds, gs]) { s.setInput('clk', 0); s.settle(); }
    const ref = lockstep(words);
    expect(ref.vector).toBeGreaterThan(10);
    for (let i = 0; i < ref.cycles + 4; i++) { clockCycle(ds); clockCycle(gs); }
    expect([ds.engine, ds.whyNot]).toEqual(['cycle', '']);
    const a = cpuState(ds), b = cpuState(gs);
    expect(a.pc).toBe(b.pc);
    expect([a.x, a.dmem, [...a.v!], a.vl, a.vtype]).toEqual([b.x, b.dmem, [...b.v!], b.vl, b.vtype]);
  });
});

function pickX(op: string): string {
  return op === 'vsll' || op === 'vsrl' || op === 'vsra' ? 'a2' : op.includes('max') || op.includes('min') ? 'a0' : op.includes('ms') ? 'a3' : 'a1';
}
