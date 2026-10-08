// Act 5's build levels: the immediate generator, the control unit (with don't-cares), the branch
// comparator, the next-PC logic, and the single-cycle cores checked by running programs. No DOM.

import type { BuildChallenge, PinSpec } from '../editor/challenges';
import { docFromDef } from '../editor/fromdef';
import type { ChipDoc } from '../editor/model';
import { BRANCH16, controlSpec, CORE_PORTS, CTL_OUTS, CTL_WIDTHS, CTL16, IMM16, immediates, NEXTPC16, rv16Core } from '../lib/rv16/cpu';
import type { ComponentDef } from '../sim/types';
import { coreCheck } from './corecheck';
import { coreTests } from './coretests';

const pins = (ins: [string, number?][], outs: [string, number?][], clock?: string): PinSpec[] => [
  ...ins.map(([name, width = 1]): PinSpec => ({ name, dir: 'in', width, ...(name === clock ? { clock: true } : {}) })),
  ...outs.map(([name, width = 1]): PinSpec => ({ name, dir: 'out', width })),
];

const answers = new Map<string, ChipDoc[]>();
const refOf = (id: string, def: () => ComponentDef, name: string) => (): ChipDoc[] => {
  let a = answers.get(id);
  if (!a) {
    const doc = docFromDef(def(), { id: `u_ref_cp_${id}`, name: `${name} ref` });
    if ('error' in doc) throw new Error(`reference ${id}: ${doc.error}`);
    answers.set(id, (a = [{ ...doc, notes: `Reference answer. ${def().summary ?? ''}`.trim() }]));
  }
  return a;
};

const s16 = (v: number) => (v & 0x8000 ? v - 0x10000 : v);
const EDGE = [0, 1, 0x7fff, 0x8000, 0xffff, 0x1234, 0xfffe, 2];

const CORE_PINS: PinSpec[] = CORE_PORTS.map((p) => ({ name: p.name, dir: p.dir === 'out' ? 'out' : 'in', width: p.width, ...(p.name === 'clk' ? { clock: true } : {}) }));

const CORE_BRIEF = (what: string) => `${what} Pins: <code>clk</code>, <code>rst</code> (hold the PC at 0), <code>instr</code> (the bench answers with imem[pc] in the same cycle), <code>drdata</code> (dmem[daddr], also at once) → <code>pc</code>, <code>daddr</code>, <code>dwdata</code>, <code>dwe</code> (a store at the clock edge), and the register-write port <code>rwe</code>, <code>rwa</code>, <code>rwd</code> (what is written to x[rwa] at the edge) through which the bench watches your core.`;

export const BUILD5: Record<string, () => BuildChallenge> = {
  c_imm: () => ({
    id: 'c_imm', title: 'Immediate generator', level: 'cpu', allowed: 'nand',
    brief: 'From the instruction word, the four immediates, each sign-extended to 16 bits: <b>i</b> = instr[15:10]; <b>sb</b> = {instr[15:13], instr[6:4]}; <b>j</b> = instr[15:7]; <b>u</b> = {instr[15:7], instr[3]} &lt;&lt; 6 (not sign-extended: lui). Par: zero NANDs.',
    ports: pins([['instr', 16]], [['i', 16], ['sb', 16], ['j', 16], ['u', 16]]), check: { kind: 'table', spec: ([w]) => immediates(w) },
    answer: refOf('c_imm', () => IMM16, 'Immediate generator'),
  }),
  c_ctl: () => ({
    id: 'c_ctl', title: 'Control unit', level: 'cpu', allowed: 'nand',
    brief: `The opcode table as logic. From <code>instr</code>: <b>rwe</b> (write rd), <b>bimm</b> (ALU b = immediate), <b>isel</b> (0 I, 1 S/B, 2 J, 3 U), <b>alu</b> ({OPX, f3}; addi / lw / sw: add; shifts: sll 1, srl 5, sra 13), <b>mwe</b> (sw), <b>wb</b> (0 ALU, 1 memory, 2 pc + 1, 3 the immediate), <b>br</b>, <b>jal</b>, <b>jalr</b>. MD and SYSTEM opcodes do nothing. Signals an instruction does not use are don't-cares: only the bits that matter are checked.`,
    ports: pins([['instr', 16]], CTL_OUTS.map((n, i) => [n, CTL_WIDTHS[i]] as [string, number])),
    check: { kind: 'table', spec: ([w]) => controlSpec(w).out, care: ([w]) => controlSpec(w).care },
    answer: refOf('c_ctl', () => CTL16, 'Control unit'),
  }),
  c_br: () => ({
    id: 'c_br', title: 'Branch comparator', level: 'cpu', allowed: 'nand',
    brief: '<b>take</b> for the condition in <code>cond</code> = op[1:0]: 00 beq (a = b), 01 bne, 10 blt (signed a &lt; b), 11 bge. Bit 0 of cond inverts the answer.',
    ports: pins([['a', 16], ['b', 16], ['cond', 2]], [['take']]),
    check: {
      kind: 'table', spec: ([a, b, c]) => [Number(c & 2 ? s16(a) < s16(b) : a === b) ^ (c & 1)],
      vectors: () => EDGE.flatMap((a) => EDGE.flatMap((b) => [0, 1, 2, 3].map((c) => [a, b, c]))),
    },
    answer: refOf('c_br', () => BRANCH16, 'Branch comparator'),
  }),
  c_npc: () => ({
    id: 'c_npc', title: 'Next PC', level: 'cpu', allowed: 'nand',
    brief: '<b>ld</b> = 1 when the PC must jump: jal, jalr, or a branch (<code>br</code>) that is taken (<code>take</code>); <b>target</b> = jalr ? rs1 + imm : pc + imm; <b>pc1</b> = pc + 1 (what jal / jalr write to rd).',
    ports: pins([['pc', 16], ['imm', 16], ['rs1', 16], ['br'], ['take'], ['jal'], ['jalr']], [['ld'], ['target', 16], ['pc1', 16]]),
    check: {
      kind: 'table', spec: ([pc, imm, rs1, br, take, jal, jalr]) => [(jal | jalr | (br & take)) ? 1 : 0, ((jalr ? rs1 : pc) + imm) & 0xffff, (pc + 1) & 0xffff],
      vectors: () => EDGE.flatMap((pc) => EDGE.flatMap((imm) => Array.from({ length: 16 }, (_, k) => [pc, imm, 0x4321, k & 1, (k >> 1) & 1, (k >> 2) & 1, k >> 3]))),
    },
    answer: refOf('c_npc', () => NEXTPC16, 'Next PC'),
  }),
  c_core1: () => ({
    id: 'c_core1', title: 'Core I: arithmetic', level: 'cpu', allowed: 'nand',
    brief: CORE_BRIEF('Your first processor: add, sub, and, or, xor, the shifts and compares, addi, slli / srli / srai and lui, one instruction per clock. No branches yet: the PC just counts.'),
    ports: CORE_PINS,
    check: coreCheck({ tests: () => coreTests(1), budget: { cpi: 1, extra: 2 } }, `${coreTests(1).length} programs (arithmetic edge cases and random sequences) run against the golden model: every register write in order, one instruction per cycle.`),
    answer: refOf('c_core1', () => rv16Core(false), 'Core I'),
  }),
  c_core2: () => ({
    id: 'c_core2', title: 'Core II: memory', level: 'cpu', allowed: 'nand',
    brief: CORE_BRIEF('Add lw and sw: the ALU computes the address, a load writes back drdata, a store raises dwe with rs2 on dwdata. Grow your Core I chip (it already has every pin).'),
    ports: CORE_PINS,
    check: coreCheck({ tests: () => coreTests(2), budget: { cpi: 1, extra: 2 } }, `${coreTests(2).length} programs with loads and stores: every register write and every store, in order, one instruction per cycle.`),
    answer: refOf('c_core2', () => rv16Core(false), 'Core II'),
  }),
  c_core3: () => ({
    id: 'c_core3', title: 'Core III: control flow', level: 'cpu', allowed: 'nand',
    brief: CORE_BRIEF('Branches and jumps: the branch comparator decides, the next-PC logic loads the PC with the target, jal / jalr write pc + 1. This is all of RV16I.'),
    ports: CORE_PINS,
    check: coreCheck({ tests: () => coreTests(3), budget: { cpi: 1, extra: 2 } }, `${coreTests(3).length} programs (loops, calls, every branch condition, random code with forward branches): every register write and store, in order, one instruction per cycle.`),
    answer: refOf('c_core3', () => rv16Core(true), 'Core III'),
  }),
  c_fast: () => ({
    id: 'c_fast', title: 'A faster core', level: 'cpu', allowed: 'nand',
    brief: CORE_BRIEF('The same programs as Core III, graded on the <b>clock period</b> (with 8-delay memories in the path). Find the critical path (the Timing panel draws it) and shorten it: the fast adders are unlocked.'),
    ports: CORE_PINS,
    check: coreCheck({ tests: () => coreTests(3), budget: { cpi: 1, extra: 2 } }, `${coreTests(3).length} programs, as Core III; the clock period is measured with the memories in the path.`),
    answer: refOf('c_fast', () => rv16Core(true, true), 'Faster core'),
  }),
};
