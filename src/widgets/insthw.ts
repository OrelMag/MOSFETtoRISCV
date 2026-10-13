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
      // pipelined RV32IM: a multiply is split across E (mule) and M (mulm); a divide stays in E (dive)
      if (funct7 === 1) return u(['rf', 'md', 'mres', 'res', ...((word >>> 14) & 1 ? ['dive', 'mdE'] : ['mule', 'msM', 'mcM', 'mulm', 'rdm'])], 'rs1, rs2 → multiply / divide unit → result mux → rd');
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
  F: ['pc', 'pcmux', 'imem', 'plus4', 'btb', 'fsel', 'corr', 'mis', 'mspc', 'vF'],
  D: ['FD', 'si', 'rf', 'ctl', 'imm', 'hz', 'byA', 'byB'],
  E: ['DE', 'fwdA', 'fwdB', 'srcA', 'srcB', 'alu', 'target', 'clr0', 'clr0E', 'bcmp', 'jtgt', 'npc', 'mule', 'dive', 'mdE'],
  M: ['EM', 'dm', 'fwdM', 'msM', 'mcM', 'mulm', 'rdm'],
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
  // Parts on the coloured wires (wires whose bits this instruction ignores do not count).
  const onNets = () => [...new Set([...nets].filter(([, c]) => !c.includes('fld-off'))
    .flatMap(([i]) => nl.nets[i].ends.filter((e) => e.includes('.')).map((e) => e.slice(0, e.indexOf('.')))))];
  const cls5 = ((word & 0x7f) >> 2);
  const klass = (word & 3) === 3 ? CLASSES.find(([, c]) => c === cls5)?.[0] : undefined;

  if (nl.instances.some((i) => i.name === 'si')) {
    SLICES.forEach((sl, k) => {
      // A slice can hold two fields (R4: rs3 and fmt share 31:25); the top one names its colour.
      const inSlice = fields.filter((f) => f.lo <= sl.hi && sl.lo <= f.hi);
      const f = fieldAt(fields, sl.hi);
      if (!focus || inSlice.some((g) => g.key === focus)) mark(at(`si.o${k}`), cls(fieldRole(f.key), f.used));
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
    if (d.fmt === 'R' || d.fmt === 'R4') return { nets, units: [], note: `${d.fmt}-type: no immediate; ImmSrc is a don't-care and the mux output is ignored.` };
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
    // Each rail fans out to every gate that wants that bit value, so colouring rails would
    // flood the view: the focus highlight picks out the matching gate and its inverters instead.
    const units = ['sa', `is_${klass}`];
    for (let i = 0; i < 5; i++) if (!((cls5 >> i) & 1)) units.push(`inv${i}`);
    mark(named(klass), cls('op'));
    return { nets, units };
  }
  return null;
}

// ---- the lane and warp cores (chapters 26–29) -------------------------------------------------

/** Which core: lib/lanes.ts laneCore(…, n), or lib/warps.ts warpCore with W warps. */
export interface LaneCoreShape {
  /** Lanes. */
  n: number;
  /** The warp core: its warps (absent: the lane core). */
  W?: number;
  /** Chapter 29's warp core (access unit, barrier, amoadd.w). */
  lsu?: boolean;
  /** Multipliers in the lanes (the warp core's mul). */
  mul?: boolean;
}

/** Where an instruction runs now: its lanes (absent: every lane) and, on the warp core, its warp. */
export interface LaneAt {
  lanes?: number[];
  warp?: number;
}

const upTo = (k: number) => Array.from({ length: k }, (_, i) => i);

/**
 * The hardware an instruction uses on a lane or warp core, as top-level instance names that core has
 * (tests/insthw.test.ts checks every one exists). Fetch, decode and control are shared by the lanes;
 * the lanes listed are those `at` names (the active mask, or the lanes the memory serves this cycle);
 * on the warp core also the issuing warp's slot, its program read, scoreboard check and request.
 */
export function laneUse(word: number, core: LaneCoreShape, at: LaneAt = {}): InstrUse {
  const op = word & 0x7f, f3 = (word >>> 12) & 7, f7 = word >>> 25;
  const warp = core.W !== undefined, W = core.W ?? 1, lsu = warp && !!core.lsu;
  const lanes = (at.lanes ?? upTo(core.n)).map((i) => `lane${i}`);
  const ws = warp && at.warp !== undefined ? [at.warp] : [];
  // the warp core's scheduler picks the warp whose PC, instruction and mask go on to one decoder
  const fetch = warp
    ? ['G', 'plus4', 'si', 'ctl', 'sdec', 'npc', 'pcmux', ...(W > 1 ? ['sched', 'issueG', 'pcSel', 'imSel', 'maskSel'] : []),
      ...ws.flatMap((w) => [`warp${w}`, `im${w}`, `hz${w}`, `bz${w}`, `nb${w}`, `rdy${w}`, ...(lsu ? [`rq${w}`, `iss${w}`] : [])])]
    : ['pc', 'pcmux', 'jmux', 'imem', 'plus4', 'si', 'ctl', 'sdec', 'npc', 'nst', 'pcen', 'lead'];
  // a register write: the mask (on the lane core during a load, the served lane) gates each lane's write enable
  const write = warp ? ['rwx', 'nld', 'wn', 'wNow', 'fw', 'weN', 'weS'] : ['rw', 'wsel', 'wf', 'weg', 'we'];
  const imm = lsu ? ['imm', 'immA'] : ['imm'];
  // the lane core's sequencer serves one lane a cycle; chapter 29's access unit a line (or a row per bank) a cycle
  const access = warp
    ? (lsu ? ['memop', 'mo', 'todo', 'acc', 'wait', 'go', 'srv', 'rest', 'doneG', 'heldN', 'heldW', 'left', ...(W > 1 ? ['heldG'] : [])] : [])
    : ['rs', 'nr1', 'isLoad', 'isMemG', 'mseq', 'mAd'];
  // a load's word comes back later: its rd is marked on the warp's scoreboard
  const later = ['li1', 'rdz', 'rdNz', 'ldIss', 'mem', ...ws.map((w) => `se${w}`)];
  const u = (extra: string[], path: string): InstrUse => ({ units: [...new Set([...fetch, ...extra])], path });
  const each = 'each active lane';
  switch (op) {
    case OPCODES.OP:
      if (f7 === 1 && warp && core.mul) return u([...lanes, 'xdec', ...write], `${each}: rs1 × rs2 (its multiplier) → rd`);
      return u([...lanes, ...write], `${each}: rs1, rs2 → its ALU → rd (the mask gates the write)`);
    case OPCODES.OPIMM: return u([...imm, ...lanes, ...write], `${each}: rs1, immediate → its ALU → rd`);
    case OPCODES.LUI: return u([...imm, ...lanes, ...write], `${each}: immediate → rd`);
    case OPCODES.AUIPC: return u([...imm, ...lanes, ...write], `${each}: PC + immediate (its ALU) → rd`);
    case OPCODES.LOAD:
      if (!warp) return u([...imm, ...lanes, ...access, 'dm', ...write], `${each}: rs1 + immediate (its ALU) → the memory sequencer, one lane a cycle → data memory → that lane's rd`);
      return u([...imm, ...lanes, 'rs', 'nr1', 'isLoad', ...later, ...access],
        `${each}: rs1 + immediate → ${lsu ? 'access unit (a line, or a row per bank, a cycle) → ' : ''}memory pipeline; the words come back later, rd waits on the scoreboard`);
    case OPCODES.STORE:
      if (!warp) return u([...imm, ...lanes, ...access, 'mWd', 'dm', 'dwe'], `${each}: rs1 + immediate (its ALU) → address, rs2 → data, one lane a cycle through the memory sequencer`);
      return u([...imm, ...lanes, 'stIss', 'mem', ...access], `${each}: rs1 + immediate → ${lsu ? 'access unit → ' : ''}memory pipeline, rs2 → the word`);
    case OPCODES.AMO:
      return u(['xdec', ...imm, 'nAmo', 'fA', ...lanes, 'amoIss', ...later, ...access], `${each}: rs1 → access unit, one lane at a time → the memory adds rs2; the old word comes back to rd`);
    case OPCODES.BRANCH: return u([...imm, ...lanes, 'lead', 'lF', 'fs', 'target', 'gndT'], 'every lane compares; the leader\'s flags (lowest active lane) → next-PC logic; PC + immediate → next PC');
    case OPCODES.JAL: return u([...imm, 'target', 'gndT', ...lanes, ...write], 'PC + immediate → next PC; PC + 4 → each active lane\'s rd');
    case OPCODES.JALR: return u([...imm, ...lanes, 'lead', 'lAlu', 'clr0', 'gndJ', ...write], 'the leader\'s rs1 + immediate, bit 0 cleared → next PC; PC + 4 → rd');
    case OPCODES.SYSTEM: return u(['csrA', ...lanes, ...write], `${each}: its own CSR (thread, lane${warp ? ', warp' : ''} id) → rd`);
    case OPCODES.SIMT: {
      // the lane core's SIMT control (mask, split / join stack) is one block; the warp core keeps one in each warp's slot
      const simt = warp ? [] : ['simt'];
      switch (f3) {
        case 0: return u(['lead', 'lA', ...simt], 'tmc: the leader\'s rs1 → the active mask');
        case 1: return u(['lead', 'lA', 'lB', 'la', 'hiNz', 'ldec', 'spGo', ...upTo(W).slice(1).flatMap((w) => [`gt${w}`, `sp${w}`, `warp${w}`])],
          'wspawn: warps 1 … rs1 − 1 start at the leader\'s rs2');
        case 2: return u([...lanes, 'pm', 'lead', 'lA', ...simt], 'split: each lane\'s rs1 ≠ 0 → the lanes that go first; the others wait on the split / join stack');
        case 3: return u(simt, 'join: the waiting lanes run next, or the stack restores the mask and pops');
        case 4: return u(lsu ? ['xdec', 'barGo', ...(W > 1 ? ['arr', 'nWait2'] : ['arr1']), 'barCmp', 'arrW', 'release', 'barOr', 'barN', 'atBar', 'ab', 'lead', 'lB'] : [],
          'bar: this warp waits until rs2 warps have arrived; the last one releases them all');
        case 5: return u([...lanes, 'pm', 'lead', 'lB', ...simt], 'pred: lanes whose rs1 = 0 stop (if none would remain, the leader\'s rs2 is the mask)');
        default: return u([], 'not a SIMT instruction');
      }
    }
    default: return u([], 'no data path work');
  }
}
