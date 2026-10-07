// The campaign's target, drawn as a block diagram: the pipelined RV16 with its five stages.
// Each block says why it exists and which levels build it (nodes' `anatomy`); the intro and the
// map light the blocks the learner has built. Coordinates in SVG units (viewBox 0 0 850 400).
// No DOM.

import { NODES } from './nodes';

export interface Block {
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** HTML: what it does and why the CPU needs it. */
  why: string;
  /** Pipeline register, control or system: drawn differently. */
  kind?: 'preg' | 'ctl' | 'sys';
}

export const VIEW = { w: 850, h: 400 };

export const BLOCKS: Block[] = [
  { id: 'npc', label: 'Next PC', x: 10, y: 165, w: 58, h: 60, why: 'Chooses where execution goes next: pc + 1, a branch target or a jump target (and mtvec on a trap).' },
  { id: 'pc', label: 'PC', x: 86, y: 165, w: 44, h: 60, why: 'The program counter: a 16-bit register holding the address of the instruction being fetched.' },
  { id: 'plus1', label: '+1', x: 148, y: 272, w: 50, h: 34, why: 'An incrementer: the next instruction is one word further on.' },
  { id: 'imem', label: 'Instr. ROM', x: 148, y: 150, w: 92, h: 90, why: 'Holds the program. Fetch reads the word at the PC every cycle.' },
  { id: 'p1', label: 'F/D', x: 258, y: 60, w: 16, h: 300, kind: 'preg', why: 'Pipeline register between fetch and decode: the instruction and its PC, held on a stall, cleared on a flush.' },
  { id: 'haz', label: 'Hazard unit', x: 290, y: 8, w: 112, h: 32, kind: 'ctl', why: 'Detects a load whose result the next instruction needs: stalls F and D for one cycle.' },
  { id: 'ctl', label: 'Control', x: 290, y: 54, w: 112, h: 52, kind: 'ctl', why: 'Decodes the opcode into control signals: which mux input, which ALU operation, write a register, write memory, branch.' },
  { id: 'rf', label: 'Registers', x: 290, y: 126, w: 112, h: 130, why: 'Eight 16-bit registers; reads rs1 and rs2, writes rd. x0 is always 0.' },
  { id: 'imm', label: 'Imm gen', x: 290, y: 276, w: 112, h: 40, why: 'Extracts the immediate from the instruction\'s fields and sign-extends it to 16 bits.' },
  { id: 'p2', label: 'D/E', x: 420, y: 60, w: 16, h: 300, kind: 'preg', why: 'Pipeline register between decode and execute: operands, immediate, control signals.' },
  { id: 'fwd', label: 'Forwarding', x: 452, y: 8, w: 104, h: 32, kind: 'ctl', why: 'Feeds the ALU a result still in the pipeline when a register has not been written back yet.' },
  { id: 'alu', label: 'ALU', x: 458, y: 126, w: 92, h: 120, why: 'Computes: add, sub, and, or, xor, shifts, comparisons; also every load / store address.' },
  { id: 'br', label: 'Branch', x: 458, y: 270, w: 92, h: 40, why: 'Compares rs1 and rs2 for beq / bne / blt / bge: taken or not.' },
  { id: 'p3', label: 'E/M', x: 570, y: 60, w: 16, h: 300, kind: 'preg', why: 'Pipeline register between execute and memory: the ALU result, the store data, control.' },
  { id: 'dmem', label: 'Data RAM', x: 604, y: 126, w: 104, h: 96, why: 'The data memory: lw reads it, sw writes it.' },
  { id: 'mmio', label: 'I/O', x: 604, y: 240, w: 104, h: 40, kind: 'sys', why: 'Memory-mapped devices: LEDs, switches, console, timer, at the top of the address space.' },
  { id: 'csr', label: 'CSRs + traps', x: 604, y: 300, w: 104, h: 44, kind: 'sys', why: 'mstatus, mtvec, mepc, mcause: saves the PC and the cause on a trap or interrupt, restores them on mret.' },
  { id: 'p4', label: 'M/W', x: 726, y: 60, w: 16, h: 300, kind: 'preg', why: 'Pipeline register between memory and write back.' },
  { id: 'wb', label: 'Result', x: 760, y: 150, w: 74, h: 80, why: 'Selects what is written to rd: the ALU result, a loaded word, pc + 1 (jal) or a CSR value.' },
];

/** Data flow between blocks (drawn as orthogonal links, `back` ones routed under the diagram). */
export const LINKS: { from: string; to: string; back?: boolean }[] = [
  { from: 'pc', to: 'imem' }, { from: 'pc', to: 'plus1' }, { from: 'imem', to: 'p1' }, { from: 'p1', to: 'ctl' },
  { from: 'p1', to: 'rf' }, { from: 'p1', to: 'imm' }, { from: 'rf', to: 'p2' }, { from: 'imm', to: 'p2' }, { from: 'ctl', to: 'p2' },
  { from: 'p2', to: 'alu' }, { from: 'p2', to: 'br' }, { from: 'alu', to: 'p3' }, { from: 'p3', to: 'dmem' }, { from: 'p3', to: 'mmio' },
  { from: 'dmem', to: 'p4' }, { from: 'p4', to: 'wb' }, { from: 'wb', to: 'rf', back: true }, { from: 'br', to: 'npc', back: true },
  { from: 'plus1', to: 'npc', back: true }, { from: 'npc', to: 'pc' },
];

/** The levels that build each block. */
export function blockNodes(): Map<string, string[]> {
  const m = new Map<string, string[]>(BLOCKS.map((b) => [b.id, []]));
  for (const n of NODES) for (const a of n.anatomy ?? []) m.get(a)?.push(n.id);
  return m;
}
