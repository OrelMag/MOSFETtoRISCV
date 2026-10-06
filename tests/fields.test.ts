import { describe, expect, it } from 'vitest';
import { CONTROL, IMM_GEN, multicycleCpu, OPCODE_DECODER, pipelinedCpu, singleCycleCpu, systemCpu } from '../src/lib';
import { assemble } from '../src/riscv/asm';
import { fieldsOf, immBits, SLICES } from '../src/riscv/fields';
import { decode, immB, immI, immJ, immS, immU } from '../src/riscv/isa';
import { netlistOf } from '../src/sim/types';
import { instrMarks } from '../src/widgets/insthw';

const SAMPLES = `add t0, t1, t2
sub a0, a1, a2
mul a0, a1, a2
addi a0, a0, -5
slli t0, t1, 3
srai t0, t1, 31
lw s0, 8(sp)
lb s0, -1(sp)
sw a1, -4(s0)
beq a0, zero, -16
lui a0, 0x12345
auipc a1, 1
jal ra, 2048
jalr zero, 0(ra)
csrrw t0, mscratch, t1
csrrsi t0, mstatus, 8
ecall
mret
fence
flw fa0, 4(a0)
fsw fa1, 8(a0)
fadd.s fa0, fa1, fa2
fcvt.s.w fa0, a0
amoadd.w a0, a1, (a2)`;
const words = assemble(SAMPLES).words;

describe('instruction fields', () => {
  it('assembles every sample', () => expect(words.length).toBe(SAMPLES.split('\n').length));

  it('fields tile bits 31..0 exactly, high to low', () => {
    for (const w of words) {
      const fs = fieldsOf(w);
      let next = 31;
      for (const f of fs) {
        expect(f.hi, `${decode(w).name} ${f.label}`).toBe(next);
        expect(f.value).toBe(Math.floor(w / 2 ** f.lo) % 2 ** (f.hi - f.lo + 1));
        next = f.lo - 1;
      }
      expect(next).toBe(-1);
    }
  });

  it('every field boundary falls on a splitter slice boundary', () => {
    const cuts = new Set(SLICES.map((s) => s.lo));
    for (const w of words) for (const f of fieldsOf(w)) expect(cuts.has(f.lo), `${decode(w).name} ${f.label}`).toBe(true);
  });

  it('names the parts that differ from the format template', () => {
    const keys = (src: string) => fieldsOf(assemble(src).words[0]).map((f) => f.key);
    expect(keys('srai t0, t1, 3')).toEqual(['funct7', 'shamt', 'rs1', 'funct3', 'rd', 'opcode']);
    expect(keys('csrrsi t0, mstatus, 8')).toEqual(['csr', 'zimm', 'funct3', 'rd', 'opcode']);
    expect(keys('ecall')).toEqual(['funct12', 'rs1', 'funct3', 'rd', 'opcode']);
    expect(fieldsOf(assemble('flw fa0, 4(a0)').words[0]).find((f) => f.key === 'rd')!.meaning).toBe('f10 (fa0)');
    expect(fieldsOf(assemble('sub a0, a1, a2').words[0])[0].meaning).toMatch(/sub/);
  });

  it('the immediate wiring reassembles the decoded immediate', () => {
    const ref = { I: immI, S: immS, B: immB, U: immU, J: immJ };
    const op = { I: 0x13, S: 0x23, B: 0x63, U: 0x37, J: 0x6f };
    let seed = 12345;
    const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0);
    for (const fmt of ['I', 'S', 'B', 'U', 'J'] as const) {
      for (let k = 0; k < 500; k++) {
        // Keep funct3 = 0 so the opcode decodes to a real instruction of this format.
        const w = ((rnd() & ~0x707f) | op[fmt]) >>> 0;
        expect(decode(w).fmt).toBe(fmt);
        const v = immBits(w).reduce((a, b) => a + b.value * 2 ** b.bit, 0);
        expect(v | 0, `${fmt} ${w.toString(16)}`).toBe(ref[fmt](w));
      }
    }
    expect(immBits(assemble('add t0, t1, t2').words[0])).toEqual([]);
  });
});

describe('field wires on the hardware', () => {
  const prog = assemble('addi t0, zero, 1').words;
  const add = assemble('add t0, t1, t2').words[0], sw = assemble('sw a1, -4(s0)').words[0];
  const names = (def: Parameters<typeof instrMarks>[0]) => new Set(netlistOf(def)!.instances.map((i) => i.name));

  it('finds all six slices and the immediate on every CPU', () => {
    for (const cpu of [singleCycleCpu(prog), pipelinedCpu(prog, {}), multicycleCpu(prog, {}), systemCpu(prog), singleCycleCpu(prog, { fpu: true }), singleCycleCpu(prog, { dcache: true })]) {
      const m = instrMarks(cpu, sw)!;
      expect(m.nets.size, cpu.id).toBe(7);
      const classes = [...m.nets.values()];
      expect(classes.filter((c) => c.includes('fld-imm')).length, cpu.id).toBe(3);
      for (const u of m.units) expect(names(cpu).has(u), `${cpu.id} ${u}`).toBe(true);
      const rd = instrMarks(cpu, add, 'rd')!;
      expect(rd.nets.size).toBe(1);
      expect(rd.units).toContain('si');
      // The pipeline carries rd on in the D/E register to write it back in W.
      expect(rd.units.filter((u) => u === 'rf' || u === 'DE').length, cpu.id).toBe(1);
    }
    expect(instrMarks(systemCpu(prog), assemble('csrrw t0, mscratch, t1').words[0], 'csr')!.nets.size).toBe(3);
  });

  it('marks the active parts inside IMM_GEN, CONTROL and the opcode decoder', () => {
    const beq = assemble('beq a0, zero, -16').words[0];
    const ig = instrMarks(IMM_GEN, beq)!;
    expect(ig.units).toEqual(['b', 'mux']);
    expect(ig.nets.size).toBe(2);
    expect(instrMarks(IMM_GEN, add)!.note).toMatch(/R-type/);
    const ctl = instrMarks(CONTROL, add)!;
    expect(ctl.units).toContain('dec');
    expect(ctl.units).toContain('g_regWrite');
    for (const u of ctl.units) expect(names(CONTROL).has(u), u).toBe(true);
    const od = instrMarks(OPCODE_DECODER, sw)!;
    expect(od.units).toContain('is_STORE');
    for (const u of od.units) expect(names(OPCODE_DECODER).has(u), u).toBe(true);
    expect(instrMarks(netlistOf(CONTROL)!.instances[0].def, add)).not.toBeNull();
  });
});
