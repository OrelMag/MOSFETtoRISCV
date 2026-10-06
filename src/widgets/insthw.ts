// Which hardware does an instruction use? Classified by opcode (so it holds for every CPU in
// the book) and expressed as top-level instance names; names a given CPU does not have are
// simply ignored by the caller. The pipelined CPU also has a stage → units map, so a selected
// instruction can be followed through the pipeline.

import { CLASSES } from '../lib/cpu';
import { fieldAt, fieldRole, fieldsOf, SLICES, type FieldKey, type FieldRole } from '../riscv/fields';
import { decode, OPCODES } from '../riscv/isa';
import { netlistOf, type ComponentDef } from '../sim/types';

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

export interface InstrMarks {
  /** Net index (in netlistOf(def)) → CSS classes for the wire: `fld fld-<role>` [+ `fld-off`]. */
  nets: Map<number, string>;
  /** Instances to highlight at this level. */
  units: string[];
  note?: string;
}

const cls = (role: FieldRole, used = true) => `fld fld-${role}${used ? '' : ' fld-off'}`;
const IMM_KEYS: FieldKey[] = ['imm', 'shamt'];

/**
 * Which wires of `def`'s schematic carry which field of `word`, and what to highlight. Nets are found
 * by their endpoints (the instruction splitter `si`, the immediate generator's output, ...), not by
 * name, so every CPU variant works. Knows the CPU top level, IMM_GEN, CONTROL and OPCODE_DECODER;
 * null elsewhere. With `focus`, only that field's wires (and the parts on them).
 */
export function instrMarks(def: ComponentDef, word: number, focus: FieldKey | null = null): InstrMarks | null {
  const nl = netlistOf(def);
  if (!nl) return null;
  const fields = fieldsOf(word);
  const nets = new Map<number, string>();
  const at = (end: string) => nl.nets.findIndex((n) => n.ends.includes(end));
  const named = (name: string) => nl.nets.findIndex((n) => n.name === name);
  const mark = (idx: number, c: string) => { if (idx >= 0) nets.set(idx, c); };
  const want = (k: FieldKey) => !focus || focus === k;
  const has = (k: FieldKey) => fields.find((f) => f.key === k && f.used);
  const hasImm = IMM_KEYS.some(has);
  const onNets = () => [...new Set([...nets.keys()].flatMap((i) => nl.nets[i].ends.filter((e) => e.includes('.')).map((e) => e.slice(0, e.indexOf('.')))))];
  const cls5 = ((word & 0x7f) >> 2);
  const klass = (word & 3) === 3 ? CLASSES.find(([, c]) => c === cls5)?.[0] : undefined;

  if (nl.instances.some((i) => i.name === 'si')) {
    SLICES.forEach((sl, k) => {
      const f = fieldAt(fields, sl.lo);
      if (want(f.key)) mark(at(`si.o${k}`), cls(fieldRole(f.key), f.used));
    });
    if (hasImm && (!focus || IMM_KEYS.includes(focus))) {
      mark(at('imm.imm'), cls('imm'));
      if (focus) mark(at('imm.instr'), cls('imm'));
    }
    if (has('csr') && want('csr')) mark(at('imm12.o1'), cls('imm'));
    if (has('funct12') && want('funct12')) mark(at('imm12.o1'), cls('fn'));
    return { nets, units: onNets() };
  }
  if (def.id === 'immgen') {
    const d = decode(word);
    if (d.fmt === 'R') return { nets, units: [], note: 'R-type: no immediate; ImmSrc is a don\'t-care and the mux output is ignored.' };
    if (focus && !IMM_KEYS.includes(focus)) return { nets, units: [] };
    const box = { I: 'i', S: 's', B: 'b', U: 'u', J: 'j' }[d.fmt];
    mark(named(`imm_${box}`), cls('imm', hasImm));
    mark(named('imm'), cls('imm', hasImm));
    return { nets, units: [box, 'mux'], note: hasImm ? undefined : 'This instruction has no immediate operand; the value is computed and ignored.' };
  }
  if (def.id === 'control') {
    if (want('opcode')) {
      mark(named('op'), cls('op'));
      if (klass) mark(named(klass), cls('op'));
    }
    // funct3 / funct7 only reach the ALU decoder, which aluOp (R, I classes) enables.
    const alu = klass === 'R' || klass === 'I';
    if (want('funct3')) for (const n of ['f3', 'f3_0', 'f3_1', 'f3_2']) mark(named(n), cls('fn', alu));
    if (want('funct7')) for (const n of ['f7', 'f7b5']) mark(named(n), cls('fn', alu && has('funct7') !== undefined));
    return { nets, units: onNets(), note: klass ? undefined : 'Not one of the nine base classes: every class output stays 0.' };
  }
  if (def.id === 'opdec') {
    if (!want('opcode')) return { nets, units: [] };
    mark(named('op'), cls('op'));
    if (!klass) return { nets, units: ['sa'], note: 'No AND gate matches this opcode.' };
    const units = ['sa', `is_${klass}`];
    for (let i = 0; i < 5; i++) {
      mark(named(`op${i + 2}`), cls('op'));
      if (!((cls5 >> i) & 1)) {
        mark(named(`op${i + 2}_n`), cls('op'));
        units.push(`inv${i}`);
      }
    }
    mark(named(klass), cls('op'));
    return { nets, units };
  }
  return null;
}
