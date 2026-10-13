// Our 6502's control: for every documented opcode and cycle, the register transfers of that cycle,
// as named control signals. One table drives three things that must agree: the register-transfer
// model (rtl.ts, checked against the ISS every cycle), the decode PLA's rows (pla.ts: the table is
// minimized over the opcode bits, the 105 undocumented opcodes being don't-cares, as on the real
// die), and the transistor-level datapath, which implements each signal.
//
// Clocking (two non-overlapping phases per cycle):
//   φ1  buses are driven (precharged high in φ2, so a source only pulls bits low and two sources on
//       one bus give their AND), registers and the ALU's input latches load from them, the ALU
//       computes, the address register and R/W are set, the next cycle's T state is decided;
//   φ2  the ALU's output latch ADD and the φ2 flags take the result, PC <- PC select (+1), memory is
//       read into DL (and into IR on an opcode fetch) or written from DOR, the T state advances.
//
// Cycle 1 is the opcode fetch (SYNC). While it runs, IR still holds the previous opcode, so its
// row "t = 1" finishes the previous instruction: a load moves DL into its register, an ALU op
// computes (its result is written by W_A / W_X / W_Y in the next cycle's φ1), a jump supplies the
// fetch address. That overlap is why LDA # takes two cycles, as on the real chip.

import { OPCODES, type OpInfo } from './isa';

export const SIGNALS = [
  // address bus and program counter
  'PCL_ADL', 'PCH_ADH', 'ADL_ABL', 'ADH_ABH', 'ADL_PCL', 'ADH_PCH', 'PC_INC',
  // data latch (the byte read last cycle)
  'DL_DB', 'DL_ADL', 'DL_ADH', 'DL_HOLD',
  // registers onto / from buses
  'A_DB', 'A_SB', 'X_SB', 'Y_SB', 'S_SB', 'S_ADL', 'SB_A', 'SB_X', 'SB_Y', 'SB_S',
  'P_DB', 'DB_P', 'DB_NZ', 'DB_N', 'DB_V', 'PCL_DB', 'PCH_DB',
  'ADD_SB', 'ADD_ADL', 'ZERO_ADH', 'ONE_ADH', 'VEC_LO', 'VEC_HI',
  // pass transistors between buses
  'SB_DB', 'SB_ADH',
  // memory write
  'DB_DOR', 'WRITE',
  // ALU inputs, function, carry, decimal (latched for φ2)
  'SB_AI', 'ZERO_AI', 'DB_BI', 'NDB_BI', 'ADL_BI',
  'OP_AND', 'OP_OR', 'OP_EOR', 'OP_SR', 'CIN_1', 'CIN_C', 'CIN_ACR', 'DEC_ADC', 'DEC_SBC',
  // flags from the ALU (φ2) and set / clear (φ1)
  'ALU_C', 'ALU_V', 'ALU_NZ', 'ALU_Z', 'C0', 'C1', 'I0', 'I1', 'D0', 'D1', 'V0',
  // writes of an ALU result in the next cycle
  'W_A', 'W_X', 'W_Y',
  // sequencing: last cycle, conditional last cycles, the branch's fetch
  'END', 'END_NOCROSS', 'END_NOTTAKEN', 'END_NOCROSS_BR', 'BR_T1', 'BR_FIX',
] as const;

export type Sig = (typeof SIGNALS)[number];
export const SIG: Record<Sig, number> = Object.fromEntries(SIGNALS.map((s, i) => [s, i])) as Record<Sig, number>;
/** Words of a signal set (bit i of word i >> 5). */
export const SIG_WORDS = Math.ceil(SIGNALS.length / 32);
/** Cycles of the longest instruction (BRK and the interrupt sequence, abs,X read-modify-write). */
export const MAX_T = 7;

// ---- pieces shared by many rows ---------------------------------------------------------------

/** The PC on the address bus; inc: and step it. */
const pcRead = (inc: boolean): Sig[] => ['PCL_ADL', 'PCH_ADH', 'ADL_ABL', 'ADH_ABH', ...(inc ? ['PC_INC'] as Sig[] : [])];
const AB: Sig[] = ['ADL_ABL', 'ADH_ABH'];
/** The fetch address of the next opcode when the previous instruction jumped: ADD (low) and DL (high). */
const JUMP: Sig[] = ['ADD_ADL', 'DL_ADH', ...AB, 'ADL_PCL', 'ADH_PCH', 'PC_INC'];
/** Keep a byte of DL in the ALU (ADD = DL) across a cycle that overwrites DL. */
const SAVE_DL: Sig[] = ['DL_DB', 'DB_BI', 'ZERO_AI'];
const STACK = (src: Sig): Sig[] => [src, 'ONE_ADH', ...AB];
/** ADD = ADL ± 1 (the stack pointer or a pointer stepping): +1 adds 0 with carry, −1 adds SB's precharged $FF. */
const INC_ADL: Sig[] = ['ZERO_AI', 'ADL_BI', 'CIN_1'];
const DEC_ADL: Sig[] = ['SB_AI', 'ADL_BI'];

/** A register onto DB for a store. */
function storeSrc(m: string): Sig[] {
  return m === 'STA' ? ['A_DB'] : m === 'STX' ? ['X_SB', 'SB_DB'] : ['Y_SB', 'SB_DB'];
}
const IDX = (m: OpInfo): Sig => (m.mode === 'zpy' || m.mode === 'aby' || m.mode === 'izy' ? 'Y_SB' : 'X_SB');

/** The ALU work of a read-modify-write instruction on the old value in DL (cycle "write old"). */
function rmwAlu(m: string): Sig[] {
  switch (m) {
    case 'ASL': return ['DL_DB', 'SB_DB', 'SB_AI', 'DB_BI', 'ALU_C'];
    case 'ROL': return ['DL_DB', 'SB_DB', 'SB_AI', 'DB_BI', 'CIN_C', 'ALU_C'];
    case 'LSR': return ['DL_DB', 'SB_DB', 'SB_AI', 'OP_SR', 'ALU_C'];
    case 'ROR': return ['DL_DB', 'SB_DB', 'SB_AI', 'OP_SR', 'CIN_C', 'ALU_C'];
    case 'INC': return ['DL_DB', 'DB_BI', 'ZERO_AI', 'CIN_1'];
    case 'DEC': return ['DL_DB', 'DB_BI', 'SB_AI']; // SB undriven = $FF: M + $FF = M − 1
  }
  throw new Error(m);
}

/**
 * What finishes an instruction in the next opcode fetch (t = 1, IR = this opcode), besides the
 * fetch address. Operands arrive in DL; an ALU result is written in the following cycle (W_*).
 */
function tail(m: string): Sig[] {
  const operand: Sig[] = ['DL_DB'];
  switch (m) {
    case 'LDA': return [...operand, 'SB_DB', 'SB_A', 'DB_NZ'];
    case 'LDX': return [...operand, 'SB_DB', 'SB_X', 'DB_NZ'];
    case 'LDY': return [...operand, 'SB_DB', 'SB_Y', 'DB_NZ'];
    case 'ADC': return ['A_SB', 'SB_AI', ...operand, 'DB_BI', 'CIN_C', 'DEC_ADC', 'ALU_C', 'ALU_V', 'ALU_NZ', 'W_A'];
    case 'SBC': return ['A_SB', 'SB_AI', ...operand, 'NDB_BI', 'CIN_C', 'DEC_SBC', 'ALU_C', 'ALU_V', 'ALU_NZ', 'W_A'];
    case 'AND': return ['A_SB', 'SB_AI', ...operand, 'DB_BI', 'OP_AND', 'ALU_NZ', 'W_A'];
    case 'ORA': return ['A_SB', 'SB_AI', ...operand, 'DB_BI', 'OP_OR', 'ALU_NZ', 'W_A'];
    case 'EOR': return ['A_SB', 'SB_AI', ...operand, 'DB_BI', 'OP_EOR', 'ALU_NZ', 'W_A'];
    case 'CMP': return ['A_SB', 'SB_AI', ...operand, 'NDB_BI', 'CIN_1', 'ALU_C', 'ALU_NZ'];
    case 'CPX': return ['X_SB', 'SB_AI', ...operand, 'NDB_BI', 'CIN_1', 'ALU_C', 'ALU_NZ'];
    case 'CPY': return ['Y_SB', 'SB_AI', ...operand, 'NDB_BI', 'CIN_1', 'ALU_C', 'ALU_NZ'];
    case 'BIT': return ['A_SB', 'SB_AI', ...operand, 'DB_BI', 'OP_AND', 'ALU_Z', 'DB_N', 'DB_V'];
    case 'TAX': return ['A_SB', 'SB_X', 'SB_DB', 'DB_NZ'];
    case 'TXA': return ['X_SB', 'SB_A', 'SB_DB', 'DB_NZ'];
    case 'TAY': return ['A_SB', 'SB_Y', 'SB_DB', 'DB_NZ'];
    case 'TYA': return ['Y_SB', 'SB_A', 'SB_DB', 'DB_NZ'];
    case 'TSX': return ['S_SB', 'SB_X', 'SB_DB', 'DB_NZ'];
    case 'TXS': return ['X_SB', 'SB_S'];
    // DB undriven is $FF: ~DB = 0 with carry in = +1, DB = $FF = −1
    case 'INX': return ['X_SB', 'SB_AI', 'NDB_BI', 'CIN_1', 'ALU_NZ', 'W_X'];
    case 'DEX': return ['X_SB', 'SB_AI', 'DB_BI', 'ALU_NZ', 'W_X'];
    case 'INY': return ['Y_SB', 'SB_AI', 'NDB_BI', 'CIN_1', 'ALU_NZ', 'W_Y'];
    case 'DEY': return ['Y_SB', 'SB_AI', 'DB_BI', 'ALU_NZ', 'W_Y'];
    case 'CLC': return ['C0'];
    case 'SEC': return ['C1'];
    case 'CLI': return ['I0'];
    case 'SEI': return ['I1'];
    case 'CLD': return ['D0'];
    case 'SED': return ['D1'];
    case 'CLV': return ['V0'];
    case 'PLA': return [...operand, 'SB_DB', 'SB_A', 'DB_NZ'];
    case 'PLP': return [...operand, 'DB_P'];
    case 'PHA': case 'PHP': return ['ADD_SB', 'SB_S'];
  }
  return [];
}

/** Accumulator shifts (ASL A …): computed in the tail like an ALU op. */
function accTail(m: string): Sig[] {
  const w: Sig[] = ['A_SB', 'SB_AI', 'ALU_C', 'ALU_NZ', 'W_A'];
  switch (m) {
    case 'ASL': return [...w, 'A_DB', 'DB_BI'];
    case 'ROL': return [...w, 'A_DB', 'DB_BI', 'CIN_C'];
    case 'LSR': return [...w, 'OP_SR'];
    case 'ROR': return [...w, 'OP_SR', 'CIN_C'];
  }
  throw new Error(m);
}

/** Cycles 2 … of an instruction (cycle 1 is the fetch); the last carries END (or a conditional end). */
function body(o: OpInfo): Sig[][] {
  const m = o.mnemonic, a = o.access;
  // the access through the effective address, in its last cycle(s)
  const finish = (addr: Sig[]): Sig[][] => {
    if (a === 'r') return [[...addr, 'END']];
    if (a === 'w') return [[...addr, ...storeSrc(m), 'DB_DOR', 'WRITE', 'END']];
    // read, write the old value back while the ALU works, write the result
    return [addr, ['DL_DB', 'DB_DOR', 'WRITE', ...rmwAlu(m)].filter((s, i, l) => l.indexOf(s) === i) as Sig[],
      ['ADD_SB', 'SB_DB', 'DB_DOR', 'WRITE', 'DB_NZ', 'END']];
  };
  switch (o.mode) {
    case 'impl': case 'acc':
      if (m === 'BRK') {
        return [pcRead(true),
          [...STACK('S_ADL'), 'PCH_DB', 'DB_DOR', 'WRITE', ...DEC_ADL],
          [...STACK('ADD_ADL'), 'PCL_DB', 'DB_DOR', 'WRITE', ...DEC_ADL],
          [...STACK('ADD_ADL'), 'P_DB', 'DB_DOR', 'WRITE', ...DEC_ADL],
          ['VEC_LO', ...AB, 'ADD_SB', 'SB_S', 'I1'],
          ['VEC_HI', ...AB, ...SAVE_DL, 'END']];
      }
      if (m === 'RTI') {
        return [pcRead(false),
          [...STACK('S_ADL'), ...INC_ADL],
          [...STACK('ADD_ADL'), ...INC_ADL],
          [...STACK('ADD_ADL'), ...INC_ADL, 'DL_DB', 'DB_P'],
          [...STACK('ADD_ADL'), 'ADD_SB', 'SB_S', ...SAVE_DL, 'END']];
      }
      if (m === 'RTS') {
        return [pcRead(false),
          [...STACK('S_ADL'), ...INC_ADL],
          [...STACK('ADD_ADL'), ...INC_ADL],
          [...STACK('ADD_ADL'), 'ADD_SB', 'SB_S', ...SAVE_DL],
          ['ADD_ADL', 'DL_ADH', ...AB, 'ADL_PCL', 'ADH_PCH', 'PC_INC', 'END']];
      }
      if (m === 'PHA' || m === 'PHP') {
        return [pcRead(false), [...STACK('S_ADL'), m === 'PHA' ? 'A_DB' : 'P_DB', 'DB_DOR', 'WRITE', ...DEC_ADL, 'END']];
      }
      if (m === 'PLA' || m === 'PLP') {
        return [pcRead(false), [...STACK('S_ADL'), ...INC_ADL], [...STACK('ADD_ADL'), 'ADD_SB', 'SB_S', 'END']];
      }
      return [[...pcRead(false), 'END']];
    case 'imm':
      return [[...pcRead(true), 'END']];
    case 'zp':
      return [pcRead(true), ...finish(['DL_ADL', 'ZERO_ADH', ...AB])];
    case 'zpx': case 'zpy':
      return [pcRead(true), ['DL_ADL', 'ZERO_ADH', ...AB, IDX(o), 'SB_AI', 'ADL_BI'], ...finish(['ADD_ADL', 'ZERO_ADH', ...AB])];
    case 'abs':
      if (m === 'JMP') return [pcRead(true), [...pcRead(false), ...SAVE_DL, 'END']];
      if (m === 'JSR') {
        return [pcRead(true),
          [...STACK('S_ADL'), 'ZERO_AI', 'ADL_BI', 'DL_HOLD'],
          [...STACK('ADD_ADL'), 'PCH_DB', 'DB_DOR', 'WRITE', ...DEC_ADL],
          [...STACK('ADD_ADL'), 'PCL_DB', 'DB_DOR', 'WRITE', ...DEC_ADL],
          [...pcRead(false), 'ADD_SB', 'SB_S', ...SAVE_DL, 'END']];
      }
      return [pcRead(true), [...pcRead(true), ...SAVE_DL], ...finish(['ADD_ADL', 'DL_ADH', ...AB])];
    case 'abx': case 'aby': {
      // cycle 4 reads at the unfixed address while the ALU fixes the high byte (+ the low byte's carry)
      const fix: Sig[] = ['ADD_ADL', 'DL_ADH', ...AB, 'DL_DB', 'DB_BI', 'ZERO_AI', 'CIN_ACR'];
      const fixed: Sig[] = ['ADD_SB', 'SB_ADH', 'ADH_ABH'];
      const c3: Sig[] = [...pcRead(true), 'DL_DB', 'DB_BI', IDX(o), 'SB_AI'];
      if (a === 'r') return [pcRead(true), c3, [...fix, 'END_NOCROSS'], [...fixed, 'END']];
      return [pcRead(true), c3, fix, ...finish(fixed)];
    }
    case 'izx':
      return [pcRead(true),
        ['DL_ADL', 'ZERO_ADH', ...AB, 'X_SB', 'SB_AI', 'ADL_BI'],
        ['ADD_ADL', 'ZERO_ADH', ...AB, ...INC_ADL],
        ['ADD_ADL', 'ZERO_ADH', ...AB, ...SAVE_DL],
        ...finish(['ADD_ADL', 'DL_ADH', ...AB])];
    case 'izy': {
      const c5: Sig[] = ['ADD_ADL', 'DL_ADH', ...AB, 'DL_DB', 'DB_BI', 'ZERO_AI', 'CIN_ACR'];
      const fixed: Sig[] = ['ADD_SB', 'SB_ADH', 'ADH_ABH'];
      const head: Sig[][] = [pcRead(true),
        ['DL_ADL', 'ZERO_ADH', ...AB, ...INC_ADL],
        ['ADD_ADL', 'ZERO_ADH', ...AB, 'DL_DB', 'DB_BI', 'Y_SB', 'SB_AI']];
      if (a === 'r') return [...head, [...c5, 'END_NOCROSS'], [...fixed, 'END']];
      return [...head, c5, ...finish(fixed)];
    }
    case 'ind':
      return [pcRead(true), [...pcRead(true), ...SAVE_DL],
        ['ADD_ADL', 'DL_ADH', ...AB, ...INC_ADL],
        ['ADD_ADL', 'ADL_ABL', ...SAVE_DL, 'END']];
    case 'rel':
      // 2: operand; 3 (taken): PCL + offset; 4 (page crossed): PCH ± 1 (BR_FIX: random logic picks)
      return [[...pcRead(true), 'END_NOTTAKEN'],
        [...pcRead(false), 'DL_DB', 'SB_DB', 'SB_AI', 'ADL_BI', 'END_NOCROSS_BR'],
        ['ADD_ADL', 'PCH_ADH', ...AB, 'ADL_PCL', 'PCH_DB', 'DB_BI', 'BR_FIX', 'END']];
  }
}

/** The signals of opcode `op` in cycle t (1 = the fetch that finishes the previous instance). */
function rowsOf(o: OpInfo): Sig[][] {
  const m = o.mnemonic;
  let t1: Sig[];
  if (m === 'JMP' || m === 'JSR' || m === 'RTI' || m === 'BRK') t1 = [...JUMP];
  else if (o.mode === 'rel') t1 = ['BR_T1'];
  else t1 = [...pcRead(true), 'ADL_PCL', 'ADH_PCH'];
  t1.push(...(o.mode === 'acc' ? accTail(m) : tail(m)));
  return [t1, ...body(o)];
}

/** Signal sets per opcode (undefined: undocumented) per cycle t − 1, as bit masks. */
export const UCODE: (Uint32Array[] | undefined)[] = OPCODES.map((o) => o && rowsOf(o).map(mask));

export function mask(sigs: readonly Sig[]): Uint32Array {
  const w = new Uint32Array(SIG_WORDS);
  for (const s of sigs) w[SIG[s] >> 5] |= 1 << (SIG[s] & 31);
  return w;
}
export const has = (m: Uint32Array, s: number): boolean => ((m[s >> 5] >>> (s & 31)) & 1) === 1;
export function sigsOf(m: Uint32Array): Sig[] {
  return SIGNALS.filter((_, i) => has(m, i));
}
