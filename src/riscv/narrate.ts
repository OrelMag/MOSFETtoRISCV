// Narration (no DOM): what one instruction did in the single-cycle datapath, unit by unit and with its values, and
// what each stage of the five-stage pipeline does in a cycle and why it stalls, forwards or flushes. Every value comes
// from the golden model (the register file before the step and the step's effect), which the hardware matches in lock
// step; nothing is drawn by hand. The CPU panel shows it for the instruction just retired or selected.

import type { PipeSnap } from './cosim';
import { ABI, decode, disasm, OPCODES } from './isa';
import type { StepInfo } from './iss';
import { stepEffect } from './trace';

export interface NarrLine {
  /** The unit or stage speaking: fetch, decode, regs, imm, alu, mem, write, next, trap; F D E M W in a pipeline. */
  unit: string;
  text: string;
}

const hex = (v: number, d = 8) => '0x' + (v >>> 0).toString(16).padStart(d, '0');
/** A value as read in a sentence: small ones in decimal (signed), the rest in hex too. */
const val = (v: number) => {
  const s = v | 0;
  return Math.abs(s) < 4096 ? String(s) : `${hex(v)} (${s})`;
};
const reg = (r: number) => `${ABI[r]}`;

const BRANCH_RULE: Record<string, [string, (a: number, b: number) => boolean]> = {
  beq: ['equal', (a, b) => (a | 0) === (b | 0)],
  bne: ['not equal', (a, b) => (a | 0) !== (b | 0)],
  blt: ['less (signed)', (a, b) => (a | 0) < (b | 0)],
  bge: ['greater or equal (signed)', (a, b) => (a | 0) >= (b | 0)],
  bltu: ['less (unsigned)', (a, b) => a >>> 0 < b >>> 0],
  bgeu: ['greater or equal (unsigned)', (a, b) => a >>> 0 >= b >>> 0],
};

const ALU_OP: Record<string, string> = {
  add: '+', addi: '+', sub: '−', and: 'AND', andi: 'AND', or: 'OR', ori: 'OR', xor: 'XOR', xori: 'XOR',
  sll: '<<', slli: '<<', srl: '>>> (logical)', srli: '>>> (logical)', sra: '>> (arithmetic)', srai: '>> (arithmetic)',
  slt: '< (signed) ?', slti: '< (signed) ?', sltu: '< (unsigned) ?', sltiu: '< (unsigned) ?',
  mul: '×', mulh: '× (high, signed)', mulhu: '× (high, unsigned)', mulhsu: '× (high, signed × unsigned)',
  div: '÷', divu: '÷ (unsigned)', rem: 'mod', remu: 'mod (unsigned)',
};

const CLASS: Record<number, string> = {
  [OPCODES.OP]: 'OP (register–register)', [OPCODES.OPIMM]: 'OP-IMM (register–immediate)', [OPCODES.LOAD]: 'LOAD', [OPCODES.STORE]: 'STORE',
  [OPCODES.BRANCH]: 'BRANCH', [OPCODES.JAL]: 'JAL', [OPCODES.JALR]: 'JALR', [OPCODES.LUI]: 'LUI', [OPCODES.AUIPC]: 'AUIPC',
};

/**
 * One instruction in the single-cycle datapath. `regs`: the integer registers before it ran; `after`: the golden
 * model's step (its effect).
 */
export function narrateInstr(regs: ArrayLike<number>, after: StepInfo): NarrLine[] {
  const { pc, word } = after;
  const d = decode(word);
  const out: NarrLine[] = [{ unit: 'fetch', text: `imem reads ${hex(word)} at pc ${hex(pc)}: ${disasm(word, pc)}.` }];
  const op = d.opcode;
  const cls = CLASS[op];
  if (after.trap) {
    out.push({ unit: 'trap', text: `${stepEffect(after)}: the instruction does not complete; mepc ← ${hex(pc)} and the handler runs next.` });
    return out;
  }
  if (!cls || d.spec?.fp || d.spec?.custom) {
    out.push({ unit: 'decode', text: `${d.name}: ${stepEffect(after)}.` });
    return out;
  }
  const r1 = regs[d.rs1] ?? 0, r2 = regs[d.rs2] ?? 0;
  const opBits = (op & 0x7f).toString(2).padStart(7, '0');
  const sources = (two: boolean) => (two
    ? `rs1 = ${reg(d.rs1)} reads ${val(r1)}, rs2 = ${reg(d.rs2)} reads ${val(r2)}.`
    : `rs1 = ${reg(d.rs1)} reads ${val(r1)}.`);
  const write = () => {
    if (!d.rd) out.push({ unit: 'write', text: 'rd is x0: the result is discarded (x0 is always 0).' });
    else out.push({ unit: 'write', text: `at the rising edge ${reg(d.rd)} ← ${val(after.value ?? 0)}.` });
  };
  const next = (target: number | null, why: string) => out.push({ unit: 'next', text: target === null ? `next pc = ${hex(pc + 4)} (pc + 4).` : `next pc = ${hex(target)} (${why}).` });
  switch (op) {
    case OPCODES.OP: {
      const m = d.funct7 === 1;
      out.push({ unit: 'decode', text: `opcode ${opBits} is ${cls}${m ? ', funct7 = 1: the M extension' : ''}: write a register, both operands from registers, ALU operation ${d.name}.` });
      out.push({ unit: 'regs', text: sources(true) });
      out.push({ unit: m ? 'muldiv' : 'alu', text: `${val(r1)} ${ALU_OP[d.name] ?? d.name} ${val(r2)} = ${val(after.value ?? 0)}.` });
      write(); next(null, '');
      break;
    }
    case OPCODES.OPIMM: {
      out.push({ unit: 'decode', text: `opcode ${opBits} is ${cls}: write a register, operand b from the immediate, ALU operation ${d.name}.` });
      out.push({ unit: 'regs', text: sources(false) });
      const shift = d.name === 'slli' || d.name === 'srli' || d.name === 'srai';
      const imm = shift ? d.rs2 : d.imm;
      out.push({ unit: 'imm', text: shift ? `the shift amount is bits 24:20 = ${imm}.` : `IMM_GEN takes bits 31:20 = ${hex(d.imm & 0xfff, 3)}, sign-extended: ${val(d.imm)}.` });
      out.push({ unit: 'alu', text: `${val(r1)} ${ALU_OP[d.name] ?? d.name} ${val(imm)} = ${val(after.value ?? 0)}.` });
      write(); next(null, '');
      break;
    }
    case OPCODES.LOAD: {
      const addr = (r1 + d.imm) >>> 0;
      out.push({ unit: 'decode', text: `opcode ${opBits} is ${cls}: the ALU adds, memory is read, its word is what rd receives.` });
      out.push({ unit: 'regs', text: sources(false) });
      out.push({ unit: 'imm', text: `the offset, bits 31:20 sign-extended: ${val(d.imm)}.` });
      out.push({ unit: 'alu', text: `address = ${val(r1)} + ${val(d.imm)} = ${hex(addr)}.` });
      out.push({ unit: 'mem', text: `dmem reads ${val(after.value ?? 0)} at ${hex(addr)}.` });
      write(); next(null, '');
      break;
    }
    case OPCODES.STORE: {
      const addr = (r1 + d.imm) >>> 0;
      out.push({ unit: 'decode', text: `opcode ${opBits} is ${cls}: the ALU adds, memory is written, no register is.` });
      out.push({ unit: 'regs', text: sources(true) });
      out.push({ unit: 'imm', text: `the offset is split across bits 31:25 and 11:7 (the S format), sign-extended: ${val(d.imm)}.` });
      out.push({ unit: 'alu', text: `address = ${val(r1)} + ${val(d.imm)} = ${hex(addr)}.` });
      out.push({ unit: 'mem', text: after.store ? `at the rising edge dmem[${hex(after.store.addr)}] ← ${val(after.store.value)} (rs2).` : `${stepEffect(after)}.` });
      next(null, '');
      break;
    }
    case OPCODES.BRANCH: {
      const rule = BRANCH_RULE[d.name];
      const taken = rule ? rule[1](r1, r2) : false;
      out.push({ unit: 'decode', text: `opcode ${opBits} is ${cls}: no register write; the ALU compares, the branch adder forms pc + offset.` });
      out.push({ unit: 'regs', text: sources(true) });
      out.push({ unit: 'imm', text: `the B-format offset (bits scattered over 31:25 and 11:7, bit 0 always 0): ${val(d.imm)}.` });
      out.push({ unit: 'alu', text: `${val(r1)} and ${val(r2)}: ${rule ? rule[0] : d.name}? ${taken ? 'yes' : 'no'}.` });
      next(taken ? (pc + d.imm) >>> 0 : null, taken ? `taken: pc + ${val(d.imm)}` : '');
      break;
    }
    case OPCODES.JAL: {
      out.push({ unit: 'decode', text: `opcode ${opBits} is ${cls}: rd receives pc + 4, the PC jumps.` });
      out.push({ unit: 'imm', text: `the J-format offset: ${val(d.imm)}.` });
      write(); next((pc + d.imm) >>> 0, `pc + ${val(d.imm)}`);
      break;
    }
    case OPCODES.JALR: {
      const t = ((r1 + d.imm) & ~1) >>> 0;
      out.push({ unit: 'decode', text: `opcode ${opBits} is ${cls}: rd receives pc + 4, the PC jumps to a register plus an offset.` });
      out.push({ unit: 'regs', text: sources(false) });
      out.push({ unit: 'alu', text: `target = ${val(r1)} + ${val(d.imm)}, bit 0 cleared = ${hex(t)}.` });
      write(); next(t, 'rs1 + offset');
      break;
    }
    case OPCODES.LUI:
    case OPCODES.AUIPC: {
      const lui = op === OPCODES.LUI;
      out.push({ unit: 'decode', text: `opcode ${opBits} is ${cls}: ${lui ? 'rd receives the immediate itself' : 'rd receives pc + the immediate'}.` });
      out.push({ unit: 'imm', text: `bits 31:12 = ${hex(d.imm >>> 12, 5)}, placed in the upper 20 bits: ${hex(d.imm)}.` });
      if (!lui) out.push({ unit: 'alu', text: `${hex(pc)} + ${hex(d.imm)} = ${hex(after.value ?? 0)}.` });
      write(); next(null, '');
      break;
    }
  }
  return out;
}

const STAGE_NAME: Record<string, string> = { F: 'fetch', D: 'decode', E: 'execute', M: 'memory', W: 'writeback', X: 'execute 2' };

/** The five-stage pipeline in one cycle: what each stage holds and why it waits, forwards or is flushed. */
export function narrateCycle(p: PipeSnap, wordAt: (pc: number) => number): NarrLine[] {
  const at = (s: string) => {
    const i = p.stages.indexOf(s);
    return i >= 0 && p.slots[i].valid ? p.slots[i].pc : null;
  };
  const dis = (pc: number) => disasm(wordAt(pc), pc);
  const dec = (pc: number | null) => (pc === null ? null : decode(wordAt(pc)));
  const writes = (pc: number | null) => {
    const d = dec(pc);
    if (!d || !d.rd) return 0;
    return d.opcode === OPCODES.STORE || d.opcode === OPCODES.BRANCH ? 0 : d.rd;
  };
  const out: NarrLine[] = [];
  const e = dec(at('E')), dD = dec(at('D'));
  const srcName = ['the register file', 'W', 'M', 'X'];
  for (const s of p.stages) {
    const pc = at(s);
    if (pc === null) { out.push({ unit: s, text: 'a bubble: nothing to do.' }); continue; }
    let t = `${dis(pc)}: ${STAGE_NAME[s] ?? s}.`;
    if (s === 'F' && p.stall) t = `${dis(pc)}: held (the PC did not move: stall).`;
    if (s === 'D') {
      if (p.stall && e && e.opcode === OPCODES.LOAD) t = `${dis(pc)}: waits one cycle. The load in E writes ${reg(e.rd)}, which this instruction reads, and its word arrives only at the end of M.`;
      else if (p.byp && dD) {
        const w = writes(at('W'));
        t = `${dis(pc)}: reads its registers; ${reg(w)} comes straight from W, which writes it this cycle (bypass).`;
      } else t = `${dis(pc)}: control decodes it and the register file is read.`;
    }
    if (s === 'E' && e) {
      const via = (sel: number, r: number) => (sel ? `${reg(r)} forwarded from ${srcName[sel]} (written by ${dis(at(srcName[sel])!)})` : null);
      const fw = [via(p.fwdA, e.rs1), via(p.fwdB, e.rs2)].filter(Boolean);
      t = `${dis(pc)}: the ALU works${fw.length ? `; ${fw.join(', ')}` : ''}.`;
      if (p.flush) t += ' The branch or jump is taken: the two instructions behind it are flushed and fetch restarts at the target.';
    }
    if (s === 'M') {
      const d = dec(pc)!;
      t = `${dis(pc)}: ${d.opcode === OPCODES.LOAD ? 'reads the data memory' : d.opcode === OPCODES.STORE ? 'writes the data memory' : 'passes its result on'}.`;
    }
    if (s === 'W') {
      const r = writes(pc);
      t = `${dis(pc)}: ${r ? `writes ${reg(r)} at the next edge` : 'writes no register'}; it retires.`;
    }
    out.push({ unit: s, text: t });
  }
  return out;
}
