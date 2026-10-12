// The 4-bit CPU's ISA: the Intel 4004's opcode map and mnemonics, one instruction per 16-bit word.
// The high byte is the 4004's OPR:OPA byte, the low byte its second byte (an address or data) or
// zero. Kept: every instruction that needs no 4002 RAM chip, bar FIN, KBP and DCL. The PC is
// 8 bits, so JUN / JMS ignore the 4004's high address nibble (OPA), and JCN / ISZ reach the
// whole ROM. Words the table does not name execute as NOP, in the golden model and the hardware.

/** JCN condition bits (OPA): invert the test, A = 0, CY = 1, TEST = 0 (any set term). */
export const JCN = { INVERT: 8, AZ: 4, CY: 2, TEST0: 1 } as const;

/** Condition names the assembler accepts for JCN (Intel's MCS-4 style). */
export const JCN_NAMES: Record<string, number> = {
  tz: JCN.TEST0, tn: JCN.INVERT | JCN.TEST0,
  c1: JCN.CY, c0: JCN.INVERT | JCN.CY,
  az: JCN.AZ, an: JCN.INVERT | JCN.AZ,
};

/** Operand shapes: r register R0–R15, p pair P0–P7, d 4-bit data, c condition, a 8-bit address, b 8-bit data. */
export type Shape4 = '' | 'r' | 'p' | 'd' | 'ca' | 'pb' | 'a' | 'ra';

export interface Instr4 {
  name: string;
  /** High byte, with the operand bits zero. */
  hi: number;
  shape: Shape4;
  summary: string;
}

/** The instruction table, in opcode order. */
export const INSTRS4: Instr4[] = [
  { name: 'NOP', hi: 0x00, shape: '', summary: 'no operation' },
  { name: 'JCN', hi: 0x10, shape: 'ca', summary: 'jump if ((A = 0 & c2) | (CY & c1) | (¬TEST & c0)) xor c3' },
  { name: 'FIM', hi: 0x20, shape: 'pb', summary: 'pair ← data (even register: the high nibble)' },
  { name: 'SRC', hi: 0x21, shape: 'p', summary: 'port address ← pair' },
  { name: 'JIN', hi: 0x31, shape: 'p', summary: 'PC ← pair' },
  { name: 'JUN', hi: 0x40, shape: 'a', summary: 'PC ← address' },
  { name: 'JMS', hi: 0x50, shape: 'a', summary: 'push PC + 1; PC ← address' },
  { name: 'INC', hi: 0x60, shape: 'r', summary: 'r ← r + 1 (carry unchanged)' },
  { name: 'ISZ', hi: 0x70, shape: 'ra', summary: 'r ← r + 1; jump if r ≠ 0' },
  { name: 'ADD', hi: 0x80, shape: 'r', summary: 'A ← A + r + CY; CY ← carry' },
  { name: 'SUB', hi: 0x90, shape: 'r', summary: 'A ← A + ¬r + ¬CY; CY ← carry (1: no borrow)' },
  { name: 'LD', hi: 0xa0, shape: 'r', summary: 'A ← r' },
  { name: 'XCH', hi: 0xb0, shape: 'r', summary: 'A ↔ r' },
  { name: 'BBL', hi: 0xc0, shape: 'd', summary: 'pop the PC; A ← data' },
  { name: 'LDM', hi: 0xd0, shape: 'd', summary: 'A ← data' },
  { name: 'WRR', hi: 0xe2, shape: '', summary: 'output port (address bits 7–4) ← A' },
  { name: 'RDR', hi: 0xea, shape: '', summary: 'A ← the input port (switches)' },
  { name: 'CLB', hi: 0xf0, shape: '', summary: 'A ← 0, CY ← 0' },
  { name: 'CLC', hi: 0xf1, shape: '', summary: 'CY ← 0' },
  { name: 'IAC', hi: 0xf2, shape: '', summary: 'A ← A + 1; CY ← carry' },
  { name: 'CMC', hi: 0xf3, shape: '', summary: 'CY ← ¬CY' },
  { name: 'CMA', hi: 0xf4, shape: '', summary: 'A ← ¬A' },
  { name: 'RAL', hi: 0xf5, shape: '', summary: 'rotate CY:A left' },
  { name: 'RAR', hi: 0xf6, shape: '', summary: 'rotate A:CY right' },
  { name: 'TCC', hi: 0xf7, shape: '', summary: 'A ← CY, CY ← 0' },
  { name: 'DAC', hi: 0xf8, shape: '', summary: 'A ← A − 1; CY ← no borrow' },
  { name: 'TCS', hi: 0xf9, shape: '', summary: 'A ← 9 + CY, CY ← 0 (BCD subtraction)' },
  { name: 'STC', hi: 0xfa, shape: '', summary: 'CY ← 1' },
  { name: 'DAA', hi: 0xfb, shape: '', summary: 'if A > 9 or CY: A ← A + 6, CY ← 1 on a carry (else unchanged)' },
];

export const BY_NAME4 = new Map(INSTRS4.map((i) => [i.name, i]));

/** The 4004's output ports this machine has: 0–3 the four digits, 4 the LEDs. */
export const PORTS4 = 5;

export interface Decoded4 {
  /** The instruction (NOP for a word the table does not name: `undef`). */
  name: string;
  undef: boolean;
  /** OPA: register, pair × 2 (+1 for SRC / JIN), data or condition. */
  opa: number;
  /** Second byte: address or data. */
  lo: number;
}

/** Which instruction a word is (exactly the hardware's decoding). */
export function decode4(w: number): Decoded4 {
  const opr = (w >> 12) & 15, opa = (w >> 8) & 15, lo = w & 0xff;
  const ok = (name: string): Decoded4 => ({ name, undef: false, opa, lo });
  const nop: Decoded4 = { name: 'NOP', undef: (w & 0xff00) !== 0, opa, lo };
  switch (opr) {
    case 0: return nop;
    case 1: return ok('JCN');
    case 2: return ok(opa & 1 ? 'SRC' : 'FIM');
    case 3: return opa & 1 ? ok('JIN') : nop;
    case 4: return ok('JUN');
    case 5: return ok('JMS');
    case 6: return ok('INC');
    case 7: return ok('ISZ');
    case 8: return ok('ADD');
    case 9: return ok('SUB');
    case 10: return ok('LD');
    case 11: return ok('XCH');
    case 12: return ok('BBL');
    case 13: return ok('LDM');
    case 14: return opa === 2 ? ok('WRR') : opa === 10 ? ok('RDR') : nop;
    default: return opa <= 11 ? ok(INSTRS4[17 + opa].name) : nop;
  }
}

const hx = (v: number, d = 2) => `0x${v.toString(16).toUpperCase().padStart(d, '0')}`;
const CONDS = new Map(Object.entries(JCN_NAMES).map(([k, v]) => [v, k.toUpperCase()]));

/** Assembly text of a word (addresses as hex; a word no instruction names: `.word`). */
export function disasm4(w: number): string {
  const d = decode4(w);
  if (d.undef) return `.word ${hx(w, 4)}`;
  const shape = BY_NAME4.get(d.name)!.shape;
  const m = d.name.padEnd(4);
  switch (shape) {
    case '': return d.name;
    case 'r': return `${m} R${d.opa}`;
    case 'p': return `${m} P${d.opa >> 1}`;
    case 'd': return `${m} ${d.opa}`;
    case 'ca': return `${m} ${CONDS.get(d.opa) ?? d.opa}, ${hx(d.lo)}`;
    case 'pb': return `${m} P${d.opa >> 1}, ${hx(d.lo)}`;
    case 'a': return `${m} ${hx(d.lo)}`;
    case 'ra': return `${m} R${d.opa}, ${hx(d.lo)}`;
  }
}

/** The word's fields, most significant first (the CPU drawer's breakdown): name, bits, value. */
export function fields4(w: number): { name: string; bits: number; value: number; kind: 'op' | 'reg' | 'imm' | 'cond' | 'none' }[] {
  const d = decode4(w);
  const shape = d.undef ? '' : BY_NAME4.get(d.name)!.shape;
  const two = shape === 'ca' || shape === 'pb' || shape === 'a' || shape === 'ra';
  const opaKind = shape === 'r' || shape === 'ra' || shape === 'p' || shape === 'pb' ? 'reg' : shape === 'ca' ? 'cond' : shape === 'd' ? 'imm' : 'op';
  return [
    { name: 'OPR', bits: 4, value: (w >> 12) & 15, kind: 'op' },
    { name: 'OPA', bits: 4, value: d.opa, kind: opaKind },
    { name: two ? (shape === 'pb' ? 'data' : 'address') : '—', bits: 8, value: d.lo, kind: two ? 'imm' : 'none' },
  ];
}

/** Register and pair operands: R0–R15, P0–P7 (case-insensitive). */
export function reg4(s: string): number | null {
  const m = s.trim().match(/^r(\d{1,2})$/i);
  return m && +m[1] < 16 ? +m[1] : null;
}
export function pair4(s: string): number | null {
  const m = s.trim().match(/^p(\d)$/i);
  return m && +m[1] < 8 ? +m[1] : null;
}
