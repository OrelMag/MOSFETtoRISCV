// Which hardware does an instruction use? Classified by opcode (so it holds for every CPU in
// the book) and expressed as top-level instance names; names a given CPU does not have are
// simply ignored by the caller. The pipelined CPU also has a stage → units map, so a selected
// instruction can be followed through the pipeline.

import { OPCODES } from '../riscv/isa';

export interface InstrUse {
  /** Top-level instances (union over all CPUs; filter by what exists). */
  units: string[];
  /** The data flow in one line, for the panel. */
  path: string;
}

const FETCH = ['pc', 'pcmux', 'npc', 'imem', 'plus4', 'si', 'ctl', 'ir', 'adr', 'memsel', 'ctrl'];
const ADDR = ['rf', 'imm', 'srcA', 'srcB', 'alu'];

export function instrUse(word: number): InstrUse {
  const op = word & 0x7f, funct7 = word >>> 25;
  const u = (extra: string[], path: string): InstrUse => ({ units: [...FETCH, ...extra], path });
  switch (op) {
    case OPCODES.OP:
      if (funct7 === 1) return u(['rf', 'md', 'mres', 'res'], 'rs1, rs2 → multiply / divide unit → result mux → rd');
      return u(['rf', 'srcA', 'srcB', 'alu', 'res'], 'rs1, rs2 → ALU → result mux → rd');
    case OPCODES.OPIMM: return u(['rf', 'imm', 'srcA', 'srcB', 'alu', 'res'], 'rs1, immediate → ALU → result mux → rd');
    case OPCODES.LOAD: return u([...ADDR, 'dm', 'ld', 'ldsel', 'res'], 'rs1 + immediate (ALU) → data memory → load extract → result mux → rd');
    case OPCODES.STORE: return u([...ADDR, 'dm', 'st'], 'rs1 + immediate (ALU) → address; rs2 → store align → data memory');
    case OPCODES.BRANCH: return u([...ADDR, 'target', 'npc', 'bcmp'], 'rs1 − rs2 (ALU flags) → next-PC logic; PC + immediate → next PC');
    case OPCODES.JAL: return u(['imm', 'target', 'npc', 'res', 'rf'], 'PC + immediate → next PC; PC + 4 → result mux → rd');
    case OPCODES.JALR: return u([...ADDR, 'clr0', 'clr0E', 'jtgt', 'npc', 'res'], 'rs1 + immediate (ALU), bit 0 cleared → next PC; PC + 4 → rd');
    case OPCODES.LUI: return u(['imm', 'res', 'rf'], 'immediate → result mux → rd');
    case OPCODES.AUIPC: return u(['imm', 'srcA', 'srcB', 'alu', 'res', 'rf'], 'PC + immediate (ALU) → result mux → rd');
    case OPCODES.SYSTEM: return u(['sys', 'csr', 'trap', 'trapmux', 'imm12', 'rf', 'res'], 'CSR unit / trap unit (rs1 or zimm → CSR; old CSR → rd)');
    case OPCODES.LOADFP: return u([...ADDR, 'dm', 'frf', 'fwd', 'fdec'], 'rs1 + immediate (ALU) → data memory → f register');
    case OPCODES.STOREFP: return u([...ADDR, 'dm', 'frf', 'swd'], 'rs1 + immediate (ALU) → address; f register → data memory');
    case OPCODES.OPFP: return u(['frf', 'fpu', 'fdec', 'fwd', 'xres', 'rf', 'res'], 'f registers → FPU → f or x register');
    case OPCODES.AMO: return u(['rf', 'dm', 'mpd', 'amux', 'amoadd', 'wmux', 'res'], 'rs1 → address; memory word → rd; new value (swap / add) → memory');
    default: return u([], 'no data path work (fence / unknown)');
  }
}

/** Five-stage pipeline: which units belong to which stage (pipeline registers lead each stage). */
export const STAGE_UNITS: Record<'F' | 'D' | 'E' | 'M' | 'W', string[]> = {
  F: ['pc', 'pcmux', 'imem', 'plus4', 'btb', 'fsel', 'corr', 'mis', 'mspc', 'vF', 'one'],
  D: ['FD', 'si', 'rf', 'ctl', 'imm', 'hz', 'byA', 'byB'],
  E: ['DE', 'fwdA', 'fwdB', 'srcA', 'srcB', 'alu', 'target', 'clr0', 'clr0E', 'bcmp', 'jtgt', 'npc'],
  M: ['EM', 'dm', 'fwdM'],
  W: ['MW', 'res', 'rf'],
};

/** Units of `stage` that an instruction occupying it actually uses (always its pipeline register). */
export function stageUse(stage: keyof typeof STAGE_UNITS, use: InstrUse): string[] {
  const reg = { F: 'pc', D: 'FD', E: 'DE', M: 'EM', W: 'MW' }[stage];
  const own = STAGE_UNITS[stage].filter((n) => stage === 'F' || use.units.includes(n));
  return own.includes(reg) ? own : [reg, ...own];
}
