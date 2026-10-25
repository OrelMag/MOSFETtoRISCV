// Chapter 25's single-cycle core at both register widths (lib/cpu64.ts xlenCpu), in lock step with a golden model after
// every retirement: registers, PC, and the memory word a store touched (all of memory at the end). At 64 bits the
// model is riscv/iss64.ts. At 32 bits it is riscv/iss.ts (RV32IM, not system): its memory semantics are the core's,
// a load or store reaching inside its word aligned to its own size (lh at 4k + 3 reads bytes 2 and 3), which ISS64
// cannot stand in for (its registers are 64 bits). Programs: targeted ones for every instruction and edge, then seeded
// random ones, 32 at a time on BitSim's lanes (each lane its own program ROM). Values are read as BigInts.

import { describe, expect, it } from 'vitest';
import { storeAlign, loadExtract } from '../src/lib/lsu';
import { wordUnit, xlenCpu, type Xlen } from '../src/lib/cpu64';
import { assemble } from '../src/riscv/asm';
import { bitsBig, wideState } from '../src/riscv/cosim';
import { ISS } from '../src/riscv/iss';
import { ISS64 } from '../src/riscv/iss64';
import { randomProgram32 } from '../src/riscv/randprog32';
import { randomProgram64 } from '../src/riscv/randprog64';
import { BitSim, LANES } from '../src/sim/bitsim';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import type { Bit, ComponentDef } from '../src/sim/types';
import { unpackBig } from '../src/sim/values';
import { tick } from './yieldtick';

const IMEM_K = 9, DMEM_K = 5;
const WORDS = 2 ** DMEM_K;

interface Prog { name: string; words: number[] }
interface Golden {
  readonly halted: boolean;
  pc(): bigint;
  reg(i: number): bigint;
  word(i: number): bigint;
  step(): { text: string; store?: number };
}

function golden(xlen: Xlen, m: boolean, words: number[]): Golden {
  if (xlen === 64) {
    const g = new ISS64(words, { m, dmemWords: 2 * WORDS, imemWords: 2 ** IMEM_K });
    return {
      get halted() { return g.halted; },
      pc: () => g.pc, reg: (i) => g.x[i], word: (i) => g.readDword(BigInt(8 * i)),
      step: () => { const s = g.step(); return { text: s.text, store: s.store ? Number((s.store.addr >> 3n) % BigInt(WORDS)) : undefined }; },
    };
  }
  const g = new ISS(words, { m, dmemWords: WORDS, imemWords: 2 ** IMEM_K });
  return {
    get halted() { return g.halted; },
    pc: () => BigInt(g.pc >>> 0), reg: (i) => BigInt(g.x[i] >>> 0), word: (i) => BigInt(g.dmem[i]),
    step: () => { const s = g.step(); return { text: s.text, store: s.store ? (s.store.addr >>> 2) % WORDS : undefined }; },
  };
}

const asm = (xlen: Xlen, src: string): number[] => {
  const r = assemble(src, [], { xlen });
  if (r.errors.length) throw new Error(`${r.errors[0].line}: ${r.errors[0].message}`);
  if (r.words.length > 2 ** IMEM_K) throw new Error('program too long');
  return r.words;
};

const isDivide = (text: string) => /^(div|rem)/.test(text);

interface LaneResult { name: string; retired: number; cycles: number; divides: number; error?: string }

/** Every program on one build of the core, a lane each, against its golden model. */
async function lockstep(xlen: Xlen, m: boolean, progs: Prog[], maxCycles = 6000): Promise<LaneResult[]> {
  if (progs.length > LANES) throw new Error('at most 32 programs');
  const design = flatten(xlenCpu(progs[0].words, { xlen, m, imemK: IMEM_K, dmemK: DMEM_K }));
  const sim = new BitSim(design);
  const N = 2 ** IMEM_K;
  design.leaves.forEach((leaf, i) => {
    if (leaf.kind !== 'behavior' || leaf.inputs.length === 0) return;
    if (!leaf.node.path.includes('imem')) throw new Error(`unexpected behavioural leaf ${leaf.node.path.join('.')}`);
    sim.setLaneBehavior(i, ([a], lane) => [progs[lane % progs.length].words[Math.floor(a / 4) % N] ?? 0x13]);
  });
  const view = (l: number) => ({ design, getBits: (nets: readonly number[]) => nets.map((n) => ((sim.v[n] >>> l) & 1) as Bit) });
  sim.setInput('clk', 0);
  sim.settle();
  const gs = progs.map((p) => golden(xlen, m, p.words));
  const res: LaneResult[] = progs.map((p) => ({ name: p.name, retired: 0, cycles: 0, divides: 0 }));
  const live = () => res.some((r, l) => !r.error && !gs[l].halted);
  for (let c = 1; c <= maxCycles && live(); c++) {
    if ((c & 15) === 0) await tick();
    const ret = m ? sim.get('retire', progs.length) : null;
    sim.cycle();
    progs.forEach((_, l) => {
      const r = res[l], g = gs[l];
      if (r.error || g.halted) return;
      r.cycles = c;
      if (ret && !ret[l]) return;
      const s = g.step();
      r.retired++;
      if (isDivide(s.text)) r.divides++;
      const st = wideState(view(l));
      const bad: string[] = [];
      if (st.pc !== g.pc()) bad.push(`pc ${st.pc.toString(16)} ≠ ${g.pc().toString(16)}`);
      for (let i = 1; i < 32; i++) if (st.x[i] !== g.reg(i)) bad.push(`x${i} ${st.x[i].toString(16)} ≠ ${g.reg(i).toString(16)}`);
      const words = s.store !== undefined ? [s.store] : g.halted ? [...Array(WORDS).keys()] : [];
      for (const i of words) if ((st.dmem[i] ?? 0n) !== g.word(i)) bad.push(`mem[${i}] ${(st.dmem[i] ?? 0n).toString(16)} ≠ ${g.word(i).toString(16)}`);
      if (bad.length) r.error = `after #${r.retired} ${s.text} (cycle ${c}): ${bad.slice(0, 4).join(', ')}`;
    });
  }
  res.forEach((r, l) => { if (!r.error && !gs[l].halted) r.error = `not halted after ${maxCycles} cycles`; });
  return res;
}

// ---- targeted programs ----------------------------------------------------------------------------------------------

const values64 = ['0', '1', '-1', '7', '-7', '0x7fffffff', '0x80000000', '-0x80000000', '0xffffffff', '0x7fffffffffffffff', '-0x8000000000000000',
  '0x123456789abcdef0', '0xdeadbeef80000000', '0x00000001fffffff9'];

function arith(xlen: Xlen): string {
  const wide = xlen === 64;
  const vals = wide ? values64 : values64.slice(0, 9);
  const out: string[] = [];
  // pairs of operands through every R op (and the W ones at 64 bits)
  const R = ['add', 'sub', 'sll', 'slt', 'sltu', 'xor', 'srl', 'sra', 'or', 'and', ...(wide ? ['addw', 'subw', 'sllw', 'srlw', 'sraw'] : [])];
  for (let i = 0; i < vals.length; i += 3) {
    out.push(`li a0, ${vals[i]}`, `li a1, ${vals[(i * 5 + 4) % vals.length]}`);
    for (const op of R) out.push(`${op} a2, a0, a1`, `${op} a3, a1, a0`);
  }
  // shift amounts at the edges, from registers holding more than the amount's bits
  const amounts = wide ? [0, 1, 31, 32, 33, 63, 64, 65, 95, -1] : [0, 1, 31, 32, 33, -1];
  out.push(`li a0, ${wide ? '0x8123456789abcdef' : '0x89abcdef'}`);
  for (const k of amounts) {
    out.push(`li a1, ${k}`);
    for (const op of ['sll', 'srl', 'sra', ...(wide ? ['sllw', 'srlw', 'sraw'] : [])]) out.push(`${op} a2, a0, a1`);
  }
  for (const k of wide ? [0, 1, 31, 32, 63] : [0, 1, 31]) for (const op of ['slli', 'srli', 'srai']) out.push(`${op} a3, a0, ${k}`);
  if (wide) for (const k of [0, 1, 31]) for (const op of ['slliw', 'srliw', 'sraiw']) out.push(`${op} a4, a0, ${k}`);
  // immediates: sign extension of the 12-bit and 20-bit fields (to 64 bits at RV64), set-less-than against them
  out.push('li a0, 0x7fffffff', 'addi a1, a0, 1', 'addi a2, a0, -2048', 'slti a3, a0, -1', 'sltiu a4, a0, -1', 'xori a5, a0, -1', 'ori a6, a0, 0x7ff', 'andi a7, a0, -16');
  out.push('lui t0, 0x80000', 'lui t1, 0x7ffff', 'auipc t2, 0x80000', 'auipc s0, 1');
  if (wide) out.push('addiw t0, a0, 1', 'addiw t1, a0, -1', 'li t2, 0x80000000', 'sext.w s0, t2', 'negw s1, t2', 'addiw s2, t2, 0', 'li t3, 0xdeadbeef00000005', 'addiw s3, t3, 2047');
  out.push('halt: j halt');
  return out.join('\n');
}

function memory(xlen: Xlen): string {
  const wide = xlen === 64, B = xlen / 8;
  const out = wide ? ['li s0, 0x8877665544332211', 'li s1, 0xf0e0d0c0b0a09080', 'sd s0, 0(zero)', 'sd s1, 8(zero)']
    : ['li s0, 0x84332211', 'li s1, 0xf0e0d080', 'sw s0, 0(zero)', 'sw s1, 4(zero)'];
  const loads = ['lb', 'lbu', 'lh', 'lhu', 'lw', ...(wide ? ['lwu', 'ld'] : [])];
  for (let o = 0; o < 2 * B; o++) loads.forEach((op, i) => out.push(`${op} a${i}, ${o}(zero)`));
  const stores = ['sb', 'sh', 'sw', ...(wide ? ['sd'] : [])];
  stores.forEach((op, j) => {
    for (let o = 0; o < B; o++) out.push(`${op} ${o & 1 ? 's1' : 's0'}, ${(2 + j) * B + o}(zero)`, `${wide ? 'ld' : 'lw'} t0, ${(2 + j) * B}(zero)`);
  });
  // a base register, negative offsets, and the memory wrapping around its size
  out.push('li t1, 64', `lw t2, -60(t1)`, `sh s1, -2(zero)`, `lbu t3, -1(zero)`, `sw s0, ${WORDS * B + B}(zero)`, `lw t4, ${B}(zero)`);
  if (wide) out.push('sd s1, -8(zero)', 'ld t5, 248(zero)', 'lw t6, 4(zero)', 'lwu a7, 4(zero)');
  out.push('halt: j halt');
  return out.join('\n');
}

/** Multiplies and divides on edge pairs; `part` picks a third of them (each divide holds the core for xlen + 2 cycles). */
function muldiv(xlen: Xlen, part: number): string {
  const wide = xlen === 64;
  const pairs: [string, string][] = wide
    ? [['7', '0'], ['-0x8000000000000000', '-1'], ['-0x80000000', '-1'], ['0xdeadbeef80000000', '-1'], ['-7', '2'], ['7', '-2'],
      ['0x123456789abcdef0', '0xfedcba9876543210'], ['-1', '-1'], ['0x7fffffffffffffff', '0x7fffffffffffffff'], ['0x00000001fffffff9', '0x100000003']]
    : [['7', '0'], ['-0x80000000', '-1'], ['-7', '2'], ['7', '-2'], ['0x89abcdef', '0x12345678'], ['-1', '-1'], ['0x7fffffff', '0x7fffffff'], ['0x80000000', '3']];
  const ops = ['mul', 'mulh', 'mulhsu', 'mulhu', 'div', 'divu', 'rem', 'remu', ...(wide ? ['mulw', 'divw', 'divuw', 'remw', 'remuw'] : [])];
  const out: string[] = [];
  pairs.forEach(([a, b], k) => {
    if (k % 3 !== part) return;
    out.push(`li a0, ${a}`, `li a1, ${b}`);
    for (const op of ops) out.push(`${op} a2, a0, a1`, `${op} a3, a1, a0`);
  });
  out.push('mul a4, a2, a2', 'div a5, a4, a3', 'halt: j halt'); // back to back
  return out.join('\n');
}

function control(xlen: Xlen): string {
  const wide = xlen === 64;
  // operands equal in their low 32 bits and different above (64), or differing in sign only
  const pairs: [string, string][] = wide
    ? [['0x100000005', '5'], ['-0x100000000', '0'], ['5', '5'], ['-1', '1'], ['0x8000000000000000', '0x7fffffffffffffff']]
    : [['5', '5'], ['-1', '1'], ['0x80000000', '0x7fffffff'], ['3', '4']];
  const out: string[] = ['li s0, 0'];
  let k = 0;
  for (const [a, b] of pairs) {
    out.push(`li a0, ${a}`, `li a1, ${b}`);
    for (const op of ['beq', 'bne', 'blt', 'bge', 'bltu', 'bgeu']) {
      out.push(`${op} a0, a1, T${k}`, 'addi s0, s0, 1', `T${k}:`, `${op} a1, a0, U${k}`, 'addi s0, s0, 2', `U${k}:`);
      k++;
    }
  }
  out.push('jal ra, F', 'addi s0, s0, 100', 'j G', 'F: addi s0, s0, 1000', 'jalr t0, 0(ra)', 'G: la t1, H', 'addi t1, t1, 1', 'jalr t2, 0(t1)', 'addi s0, s0, 7', 'H: addi s0, s0, 9',
    'auipc t3, 0', 'jalr zero, 12(t3)', 'addi s0, s0, 1', 'fence', 'ecall', 'ebreak', 'halt: j halt');
  return out.join('\n');
}

function targeted(xlen: Xlen): Prog[] {
  return [
    { name: 'arith', words: asm(xlen, arith(xlen)) },
    { name: 'memory', words: asm(xlen, memory(xlen)) },
    { name: 'muldiv 0', words: asm(xlen, muldiv(xlen, 0)) },
    { name: 'muldiv 1', words: asm(xlen, muldiv(xlen, 1)) },
    { name: 'muldiv 2', words: asm(xlen, muldiv(xlen, 2)) },
    { name: 'control', words: asm(xlen, control(xlen)) },
  ];
}

function check(rs: LaneResult[], xlen: Xlen, m: boolean): void {
  expect(rs.filter((r) => r.error).map((r) => `${r.name}: ${r.error}`)).toEqual([]);
  // every instruction one cycle, a divide xlen + 2 (the iterative divider: load, xlen steps, write back)
  if (m) for (const r of rs) expect(r.cycles, r.name).toBe(r.retired + r.divides * (xlen + 1));
  else for (const r of rs) expect(r.cycles, r.name).toBe(r.retired);
}

// ---- the wide blocks alone (no numeric spec past 53 bits: checked here with BigInts) ------------------------------

const M64 = (1n << 64n) - 1n;
const sx32 = (v: bigint) => BigInt.asUintN(64, BigInt.asIntN(32, v));
const zx32 = (v: bigint) => BigInt.asUintN(32, v);

function evaluator(def: ComponentDef): (ins: Record<string, bigint>) => Record<string, bigint> {
  const sim = new GateSim(flatten(def));
  return (ins) => {
    for (const p of def.ports) if (p.dir === 'in') sim.setInputBits(p.name, unpackBig(ins[p.name] ?? 0n, p.width));
    sim.settle();
    return Object.fromEntries(def.ports.filter((p) => p.dir === 'out').map((p) => [p.name, bitsBig(sim.getBits(sim.design.root.ports[p.name]))]));
  };
}

/** Seeded 64-bit values, edges now and then: 0, all ones, 2^31, the sign-extended −2^31, 2^63. */
function rand64(seed: number): () => bigint {
  let s = BigInt(seed) * 0x9e3779b97f4a7c15n;
  return () => {
    s = BigInt.asUintN(64, s * 6364136223846793005n + 1442695040888963407n);
    const k = Number((s >> 60n) & 15n);
    return k === 0 ? 0n : k === 1 ? M64 : k === 2 ? 0x80000000n : k === 3 ? 0xffffffff80000000n : k === 4 ? 1n << 63n : BigInt.asUintN(64, (s ^ (s >> 29n)) * 0xbf58476d1ce4e5b9n);
  };
}

describe('the 64-bit blocks', () => {
  it('W unit: operands cut and extended, b5 cleared for W shifts, the result sign-extended', () => {
    const ev = evaluator(wordUnit(64));
    const r = rand64(1);
    for (let t = 0; t < 400; t++) {
      const a = r(), b = r(), res = r(), w = BigInt(t & 1), isM = BigInt((t >> 1) & 1), funct3 = BigInt((t >> 2) & 7), funct7 = (t >> 5) & 1 ? 0x20n : BigInt(t & 1);
      const sx = isM ? !(funct3 & 1n) : !!(funct7 & 0x20n);
      const ext = (v: bigint) => (sx ? sx32(v) : zx32(v));
      const keep5 = isM || !(funct3 & 1n);
      expect(ev({ a, b, r: res, w, isM, funct3, funct7 }), `t=${t}`).toEqual({
        aw: w ? ext(a) : a,
        bw: w ? (keep5 ? ext(b) : ext(b) & ~32n) : b,
        rw: w ? sx32(res) : res,
      });
    }
  });

  it('store alignment: lanes replicated, byte enables at the size-aligned offset, misalignment flagged', () => {
    const ev = evaluator(storeAlign(64));
    const r = rand64(2);
    for (let t = 0; t < 256; t++) {
      const wd = r(), addr = BigInt(t & 7), size = BigInt((t >> 3) & 3), bytes = 1n << size;
      let rep = 0n;
      for (let i = 0n; i < 8n / bytes; i++) rep |= (wd & ((1n << (8n * bytes)) - 1n)) << (8n * bytes * i);
      expect(ev({ wd, addr, size }), `t=${t}`).toEqual({ wdata: rep, be: ((1n << bytes) - 1n) << (addr & ~(bytes - 1n)), misaligned: addr % bytes ? 1n : 0n });
    }
  });

  it('load extraction: every size and offset, sign- or zero-extended', () => {
    const ev = evaluator(loadExtract(64));
    const r = rand64(3);
    for (let t = 0; t < 256; t++) {
      const rdata = r(), addr = BigInt(t & 7), funct3 = BigInt((t >> 3) & 7);
      const size = funct3 === 7n ? 8n : 1n << (funct3 & 3n);
      const raw = (rdata >> (8n * (addr & ~(size - 1n)))) & ((1n << (8n * size)) - 1n);
      const want = funct3 & 4n || size === 8n ? raw : BigInt.asUintN(64, BigInt.asIntN(Number(8n * size), raw));
      expect(ev({ rdata, addr, funct3 }).value, `t=${t}`).toBe(want);
    }
  });
});

describe('the single-cycle core at 64 bits (RV64IM) against ISS64', () => {
  it('targeted programs and random ones', async () => {
    const progs = targeted(64);
    for (let s = 1; progs.length < LANES; s++) progs.push({ name: `random ${s}`, words: asm(64, randomProgram64(s, { m: true, dmemBytes: 8 * WORDS })) });
    check(await lockstep(64, true, progs), 64, true);
  }, 300_000);

  it('without M: random programs', async () => {
    const progs: Prog[] = [{ name: 'arith', words: asm(64, arith(64)) }, { name: 'memory', words: asm(64, memory(64)) }, { name: 'control', words: asm(64, control(64)) }];
    for (let s = 101; progs.length < 16; s++) progs.push({ name: `random ${s}`, words: asm(64, randomProgram64(s, { dmemBytes: 8 * WORDS })) });
    check(await lockstep(64, false, progs), 64, false);
  }, 300_000);
});

describe('the single-cycle core at 32 bits (RV32IM) against ISS', () => {
  it('targeted programs and random ones', async () => {
    const progs = targeted(32);
    for (let s = 1; progs.length < LANES; s++) progs.push({ name: `random ${s}`, words: asm(32, randomProgram32(s, { sub: true, m: true, dmemWords: WORDS })) });
    check(await lockstep(32, true, progs), 32, true);
  }, 300_000);
});
