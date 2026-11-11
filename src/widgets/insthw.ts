// Which hardware does an instruction use? Classified by opcode (so it holds for every CPU in
// the book) and expressed as top-level instance names; names a given CPU does not have are
// simply ignored by the caller. The pipelined CPU also has a stage → units map, so a selected
// instruction can be followed through the pipeline.

import { CLASSES } from '../lib/cpu';
import { fieldAt, fieldRole, fieldsOf, SLICES, type FieldKey, type FieldRole } from '../riscv/fields';
import { slotOpcode, uses, type CustomRow } from '../riscv/custom';
import { decode, MAC_OPCODE, OPCODES } from '../riscv/isa';
import { decodeV, OPI, type VKind } from '../riscv/rvv';
import { netlistOf, type ComponentDef } from '../sim/types';

export interface InstrUse {
  /** Top-level instances (union over all CPUs; filter by what exists). */
  units: string[];
  /** The data flow in one line, for the panel. */
  path: string;
  /** Parts inside the boxes, `box.part` (innerUse): what an open zoom lens on a box lights. */
  inner?: string[];
}

const FETCH = ['pc', 'pcmux', 'npc', 'imem', 'plus4', 'si', 'ctl', 'ir', 'adr', 'memsel', 'ctrl'];
const ADDR = ['rf', 'imm', 'srcA', 'srcB', 'alu'];

/** A custom instruction's units, from what its row uses (riscv/custom.ts uses: the signals it asserts). */
function customUse(r: CustomRow): InstrUse {
  const k = uses(r), units = [...FETCH], path: string[] = [];
  if (k.rs1 || k.rs2) { units.push('rf'); path.push([k.rs1 ? 'rs1' : '', k.rs2 ? 'rs2' : ''].filter(Boolean).join(', ')); }
  if (k.imm) units.push('imm');
  if (k.alu) { units.push('srcA', 'srcB', 'alu'); path.push('ALU'); }
  if (k.mem) { units.push('dm', 'ld', 'ldsel'); if (r.memWrite) units.push('st'); path.push('data memory'); }
  if (r.regWrite) { units.push('res', 'rf'); path.push('result mux → rd'); }
  if (r.next !== 'pc4') { units.push('npc', 'target', 'bcmp'); if (r.next === 'jalr') units.push('clr0', 'clr0E', 'jtgt'); path.push('next PC'); }
  return { units, path: `${r.name}: ${path.join(' → ') || 'no data path work'}` };
}

/** A vector instruction on the single-cycle CPU with the vector unit (lib/vector.ts): instance `vu` beside the core. */
function vectorUse(k: VKind): InstrUse {
  const u = (extra: string[], path: string): InstrUse => ({ units: [...FETCH, 'vu', ...extra], path });
  switch (k.k) {
    case 'vsetvli': case 'vsetivli': case 'vsetvl':
      return u(['rf', 'xw', 'rwo'], 'x[rs1] or the immediate → vset: vl = min(AVL, VLMAX), vtype → the vector unit\'s registers; vl → rd');
    case 'mem':
      return u(['rf', 'dm'], k.store ? 'x[rs1] → the banks\' vector port; each beat a register of the group, four words, one per bank, from the lanes'
        : 'x[rs1] → the banks\' vector port; each beat four words, one per bank, into a register of the group');
    case 'redsum': return u([], 'vs1[0], then the active elements of vs2, beat by beat → adder tree and accumulator → vd[0] (lane 0)');
    case 'mvxs': return u(['xw', 'rwo', 'rf'], 'vs2[0] (lane 0) → x[rd]');
    case 'mvsx': return u(['rf'], 'x[rs1] → vd[0] (lane 0), if vl > 0');
    case 'vid': return u([], 'each lane\'s element index → vd, a register of the group a beat');
    case 'opi':
      if (OPI[k.name].mask) return u(k.form === 'vx' ? ['rf'] : [], 'the four lanes compare, four mask bits a beat → accumulator → vd (lane 0) on the last beat');
      return u(k.form === 'vx' ? ['rf'] : [], 'vs2 and vs1, x[rs1] or the immediate → four lane ALUs, a register of the group a beat → vd');
    case 'merge': return u(k.form === 'vx' ? ['rf'] : [], 'vs2 or vs1 / x[rs1] / the immediate, picked by v0 → four lanes, a register of the group a beat → vd');
    case 'mul': return u([], 'vmul: the golden model only; the unit in gates leaves it out (it does nothing)');
  }
}

export function instrUse(word: number, custom?: readonly CustomRow[], mac = false): InstrUse {
  if (mac && (word & 0x7f) === MAC_OPCODE && decode(word, custom, 32, true).spec?.mac) {
    const name = decode(word, custom, 32, true).name;
    return name === 'racc' ? { units: [...FETCH, 'rf', 'shamt', 'macu', 'res'], path: 'rs1[5:0] = the shift; accumulator → shift, round, clamp (MAC unit) → result mux (input 4) → rd' }
      : name === 'clracc' ? { units: [...FETCH, 'macu'], path: 'the accumulator is cleared at the clock edge' }
      : { units: [...FETCH, 'rf', 'f3op', 'macu'], path: name === 'mac' ? 'rs1[15:0] × rs2[15:0] (signed) → added to the accumulator, no register written' : 'rs1[15:0] × rs2[15:0] + rs1[31:16] × rs2[31:16] → added to the accumulator, no register written' };
  }
  const row = custom?.find((r) => slotOpcode(r.slot) === (word & 0x7f));
  if (row) return customUse(row);
  const v = decodeV(word);
  if (v) return vectorUse(v);
  const op = word & 0x7f, funct7 = word >>> 25;
  const inner = innerUse(word);
  const u = (extra: string[], path: string): InstrUse => ({ units: [...FETCH, ...extra], path, ...(inner.length ? { inner } : {}) });
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
  // the parts inside this stage's boxes (rf is in D and W: its read ports in D, its write in W)
  // innerUse lists the register file's reads before rf.dec and the write after it (a register both read and written: twice)
  const all = use.inner ?? [], dec = all.indexOf('rf.dec');
  const inner = all.filter((n, i) => {
    if (!own.includes(n.slice(0, n.indexOf('.')))) return false;
    if (!n.startsWith('rf.') || dec < 0) return true;
    return stage === 'W' ? i >= dec : i < dec;
  });
  return [...(own.includes(reg) ? own : [reg, ...own]), ...inner];
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
    // the signals block takes the class lines as a bus: the unit it lights is the block, not a wire's end
    const units = onNets();
    if (klass && !units.includes('sig')) units.push('sig');
    return { nets, units, note: klass ? undefined : 'Not one of the nine base classes: every class output stays 0.' };
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

// ---- the lane and warp cores (chapters lanes–feed) -------------------------------------------------

/** Which core: lib/lanes.ts laneCore(…, n), or lib/warps.ts warpCore with W warps. */
export interface LaneCoreShape {
  /** Lanes. */
  n: number;
  /** The warp core: its warps (absent: the lane core). */
  W?: number;
  /** Chapter feed's warp core (access unit, barrier, amoadd.w). */
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
  // the lane core's sequencer serves one lane a cycle; chapter feed's access unit a line (or a row per bank) a cycle
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
        case 1: return W > 1 ? u(['lead', 'lA', 'lB', 'la', 'hiNz', 'ldec', 'spGo', ...upTo(W).slice(1).flatMap((w) => [`gt${w}`, `sp${w}`, `warp${w}`])],
          'wspawn: warps 1 … rs1 − 1 start at the leader\'s rs2') : u([], 'wspawn: a one-warp core has no other warp to start');
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

/**
 * The hardware an instruction uses on chapter ooo's out-of-order core (lib/ooocore.ts), as its top-level instances:
 * fetch, decode, rename and dispatch for every instruction, then the port it was bound to (`port`, -1: not yet bound),
 * and the reorder buffer and commit. Loads and stores run on port 0 (the data memory and the store queue), multiplies
 * and divides on port 1; jal and lui are done at decode (their value is known there).
 */
export function oooUse(word: number, port = -1): InstrUse {
  const op = word & 0x7f, f3 = (word >>> 12) & 7, f7 = word >>> 25;
  const front = ['pc', 'imem', 'btb', 'ras', 'fp', 'fd0', 'fd1', 'ctl0', 'ctl1', 'imm0', 'imm1', 'cls0', 'cls1', 'kn0', 'kn1', 'dc', 'bind', 'rat', 'rf', 'opA0', 'opB0', 'opA1', 'opB1'];
  const back = ['rob', 'cm'];
  const at = (p: number) => [`e1_${p}`, `ex${p}`];
  const ports = port < 0 ? [0, 1] : [port];
  const u = (mid: string[], path: string): InstrUse => ({ units: [...new Set([...front, ...mid, ...back])], path });
  switch (op) {
    case OPCODES.OP:
      if (f7 === 1) return (f3 & 4)
        ? u(['iq', ...at(1), 'div'], 'rename → issue queue → port 1 → the radix-4 divider (one division at a time) → bus 1 → ROB → commit → rd')
        : u(['iq', ...at(1), 'mule', 'e2_1', 'mulm'], 'rename → issue queue → port 1 → the multiplier over two cycles → bus 1 → ROB → commit → rd');
      return u(['iq', ...ports.flatMap(at)], 'rename → issue queue → an ALU port → its result bus → ROB → commit → rd');
    case OPCODES.OPIMM: case OPCODES.AUIPC: return u(['iq', ...ports.flatMap(at)], 'rename → issue queue → an ALU port → its result bus → ROB → commit → rd');
    case OPCODES.LOAD: return u(['iq', ...at(0), 'dm', 'sq', 'e2_0'], 'rename → issue queue (waits for older stores) → port 0: address → data memory, or the store queue forwards → bus 0 a cycle later → ROB → commit → rd');
    case OPCODES.STORE: return u(['iq', ...at(0), 'sq', 'dm'], 'rename → issue queue → port 0: address and data → store queue; at commit → data memory');
    case OPCODES.BRANCH: case OPCODES.JALR:
      return u(['iq', ...ports.flatMap(at)], 'rename → issue queue → a port compares (or adds) and checks the prediction → ROB; a misprediction flushes at commit');
    case OPCODES.JAL: case OPCODES.LUI: return u([], 'decode knows the value (pc + 4, or the immediate): straight to the ROB, done → commit → rd');
    default: return u([], 'no data path work');
  }
}

/**
 * instrUse's unit names present in a placed port core (`inner`: the instances of the part, rv32i_core or rv32i_pipe_core): the data
 * memory is outside such a core, so a load / store lights the address and store-data multiplexers that face its port (the pipelined core's M register) instead.
 */
export function coreUnitNames(units: readonly string[], inner: readonly string[]): string[] {
  const have = new Set(inner), out = new Set<string>();
  for (const u of units) for (const n of u === 'dm' ? ['dm', 'amux', 'wmux', 'EM'] : [u]) if (have.has(n)) out.add(n);
  return [...out];
}

// ---- inside the boxes (the zoom lens, docs/transparent/DESIGN.md track 2c) -------------------------------------------

/** The ALU's parts that make each result (lib/alu.ts alu(n), by funct3: the result mux's input). */
const ALU_OP: Record<number, string[]> = {
  0: ['add'], 1: ['sb', 'shift'], 2: ['add', 'slt', 'zslt'], 3: ['add', 'sltu', 'zsltu'],
  4: ['xor'], 5: ['sb', 'shift'], 6: ['or'], 7: ['and'],
};
/** Each branch's condition in NEXT_PC (lib/cpu.ts): the flag it reads, through an inverter or the N ⊕ V gate. */
const BRANCH_COND: Record<number, string[]> = { 0: [], 1: ['nz'], 4: ['lt'], 5: ['lt', 'ge'], 6: ['nc'], 7: [] };
const IMM_BOX: Record<string, string> = { I: 'i', S: 's', B: 'b', U: 'u', J: 'j' };

/**
 * The parts an RV32I instruction uses inside the data path's boxes, as paths `box.part` (alu.add, rf.w5, imm.i, ctl.aludec,
 * npc.take, dm.ram): what an open zoom lens on that box lights. Only the base classes; anything else names no inner part
 * (the lens then lights the box's rim alone). A CPU without a box, or a box drawn otherwise, simply has no such part.
 */
export function innerUse(word: number): string[] {
  const op = word & 0x7f, f3 = (word >>> 12) & 7, f7 = word >>> 25;
  const rd = (word >>> 7) & 31, rs1 = (word >>> 15) & 31, rs2 = (word >>> 20) & 31;
  const cls5 = (word & 3) === 3 ? (op >> 2) : -1;
  const klass = CLASSES.find(([, c]) => c === cls5)?.[0];
  if (!klass || (op === OPCODES.OP && f7 === 1)) return [];
  const out: string[] = ['ctl.dec', 'ctl.mcls', 'ctl.sig'];
  const reg = (r: number) => (r ? `rf.w${r}` : 'rf.x0');
  const reads1 = ['R', 'I', 'LOAD', 'STORE', 'BRANCH', 'JALR'].includes(klass);
  const reads2 = ['R', 'STORE', 'BRANCH'].includes(klass);
  const writes = !['STORE', 'BRANCH'].includes(klass);
  if (reads1) out.push('rf.rp1', reg(rs1));
  if (reads2) out.push('rf.rp2', reg(rs2));
  if (writes && rd) out.push('rf.dec', `rf.w${rd}`);
  const fmt = decode(word).fmt;
  if (IMM_BOX[fmt]) out.push(`imm.${IMM_BOX[fmt]}`, 'imm.mux');
  if (['R', 'I', 'BRANCH'].includes(klass)) out.push('ctl.aludec');
  // the ALU: R and I by funct3; loads, stores, jalr and auipc add; a branch subtracts and reads the flags
  const alu = klass === 'R' || klass === 'I' ? ALU_OP[f3] : klass === 'BRANCH' ? ['add', ...(f3 < 2 ? ['zero'] : [])]
    : ['LOAD', 'STORE', 'JALR', 'AUIPC'].includes(klass) ? ['add'] : [];
  if (alu.length) out.push(...alu.map((p) => `alu.${p}`), 'alu.mux');
  if (klass === 'BRANCH') out.push(...(BRANCH_COND[f3] ?? []).map((p) => `npc.${p}`), 'npc.cond', 'npc.take', 'npc.src0', 'npc.mp');
  if (klass === 'JAL') out.push('npc.src0', 'npc.mp');
  if (klass === 'JALR') out.push('npc.mp');
  if (klass === 'LOAD' || klass === 'STORE') out.push('dm.sa', 'dm.ram');
  // not deduplicated: a register read and written appears on both sides of rf.dec (stageUse splits them by stage)
  return out;
}

/** What a click on an instruction lights: its boxes and, for an open lens, the parts inside them. */
export function litOf(use: InstrUse): string[] {
  return use.inner?.length ? [...use.units, ...use.inner] : use.units;
}

/** `names` (top-level and `box.part`) that exist in `def`: every dotted segment an instance of the level above it. */
export function namesIn(def: ComponentDef, names: readonly string[]): string[] {
  return names.filter((n) => {
    let d: ComponentDef | undefined = def;
    for (const seg of n.split('.')) {
      d = d && netlistOf(d)?.instances.find((i) => i.name === seg)?.def;
      if (!d) return false;
    }
    return true;
  });
}
