// Your own RV16 instructions (the sandbox's Custom instructions dialog on an RV16 core). RV16's 4-bit opcode is full
// (0–14 are taken and 15 is lui's, whose op[3] is an immediate bit), so a row cannot have an opcode of its own: it borrows
// one of OPX's free funct3 values (OPX uses 0 for sub and 5 for sra: 1, 2, 3, 4, 6 and 7 are free). funct3 then sits where
// an I-type immediate's top bits would be, and the rd / rs1 / rs2 fields fill the rest, so every row is R-type:
// rd ← f(rs1, rs2), where f is an ALU operation, or a load from the address the ALU makes. No immediate, branch, jump or
// store: those would need fields the word does not have. Only the control unit changes (lib/rv16/cpu.ts control16): a
// row asserts the same signals OP does, with its own ALU control and, for a memory row, the load's result select.

import { OP16, sext } from './isa16';

/** OPX's funct3 values no instruction uses. */
export const FREE_F3 = [1, 2, 3, 4, 6, 7] as const;
export type Free16 = (typeof FREE_F3)[number];

/** The ALU's operation: add, subtract, or the one OP uses for the row's own funct3 (1 sll, 2 slt, 3 sltu, 4 xor, 6 or, 7 and). */
export type Alu16 = 'add' | 'sub' | 'f3';

export interface Custom16Row {
  name: string;
  f3: Free16;
  alu: Alu16;
  /** The value written to rd: the ALU's result, or the data memory's word at that address. */
  result: 'alu' | 'mem';
}

export const MAX_ROWS16 = FREE_F3.length;

/** OP's instruction for each funct3 (what 'f3' computes). */
export const F3_OP = ['add', 'sll', 'slt', 'sltu', 'xor', 'srl', 'or', 'and'] as const;

/** The 4-bit ALU control a row drives (alt bit 3: subtract; never set with funct3, which would be OPX's own meaning). */
export const aluCtl16 = (r: Custom16Row): number => (r.alu === 'add' ? 0 : r.alu === 'sub' ? 8 : r.f3);

/** The RV16 ALU on a control value (lib/alu.ts aluOf at 16 bits: bit 3 turns add into sub and srl into sra). */
export function alu16(ctl: number, a: number, b: number): number {
  a &= 0xffff; b &= 0xffff;
  const alt = ctl & 8, sh = b & 15;
  switch (ctl & 7) {
    case 0: return (alt ? a - b : a + b) & 0xffff;
    case 1: return (a << sh) & 0xffff;
    case 2: return sext(a, 16) < sext(b, 16) ? 1 : 0;
    case 3: return a < b ? 1 : 0;
    case 4: return a ^ b;
    case 5: return (alt ? sext(a, 16) >> sh : a >>> sh) & 0xffff;
    case 6: return a | b;
    default: return a & b;
  }
}

/** The instruction word of a row: encR(OPX, f3, rd, rs1, rs2). */
export const rowOp = OP16.OPX;

/** What the row does, in words. */
export function meaning16(r: Custom16Row): string[] {
  const y = r.alu === 'add' ? 'rs1 + rs2' : r.alu === 'sub' ? 'rs1 − rs2' : `${F3_OP[r.f3]}(rs1, rs2)`;
  return [r.result === 'mem' ? `rd ← memory[${y}]` : `rd ← ${y}`, 'pc ← pc + 1'];
}

/** The value rd gets (load: the data memory's read). */
export function execCustom16(r: Custom16Row, a: number, b: number, load: (addr: number) => number): number {
  const y = alu16(aluCtl16(r), a, b);
  return r.result === 'mem' ? load(y) & 0xffff : y;
}

/** The control signals a row asserts (lib/rv16/cpu.ts CTL_OUTS), as the dialog lists them. */
export function signals16(r: Custom16Row): string[] {
  return ['rwe', `alu = ${aluCtl16(r).toString(2).padStart(4, '0')}`, ...(r.result === 'mem' ? ['wb = 01 (memory)'] : ['wb = 00 (ALU)'])];
}

export interface Problem16 { level: 'bad' | 'warn'; text: string }

/** What is wrong with a row ('bad' blocks Apply). taken: mnemonics in use (the ISA's, the other rows'). */
export function problems16(r: Custom16Row, taken: ReadonlySet<string>): Problem16[] {
  const out: Problem16[] = [];
  if (!/^[a-z][a-z0-9_.]*$/.test(r.name)) out.push({ level: 'bad', text: 'The mnemonic needs a letter first, then letters, digits, _ or .' });
  else if (taken.has(r.name)) out.push({ level: 'bad', text: `${r.name} is already an instruction or directive` });
  if (!(FREE_F3 as readonly number[]).includes(r.f3)) out.push({ level: 'bad', text: `funct3 ${r.f3} is OPX's own (sub or sra)` });
  if (r.result === 'alu') {
    const same = r.alu === 'add' ? 'add' : r.alu === 'sub' ? 'sub' : F3_OP[r.f3];
    out.push({ level: 'warn', text: `Same as ${same}: a second name for it, at the cost of the decoder's gates. A memory result is what RV16 cannot do yet.` });
  }
  return out;
}

export const buildable16 = (r: Custom16Row, taken: ReadonlySet<string>) => !problems16(r, taken).some((p) => p.level === 'bad');

/** Starting points: an indexed load, and loads from a base OR / XOR an index. */
export const CUSTOM16_PRESETS: Omit<Custom16Row, 'f3'>[] = [
  { name: 'lwx', alu: 'add', result: 'mem' },
  { name: 'lwsub', alu: 'sub', result: 'mem' },
  { name: 'lwor', alu: 'f3', result: 'mem' },
];

/** Rows from anywhere (a saved document, a share link): at most six, one per funct3 and name, else dropped. */
export function sanitizeRows16(v: unknown): Custom16Row[] {
  if (!Array.isArray(v)) return [];
  const out: Custom16Row[] = [];
  for (const x of v) {
    if (!x || typeof x !== 'object') continue;
    const r = x as Record<string, unknown>;
    const f3 = r.f3, alu = r.alu, result = r.result, name = r.name;
    if (typeof name !== 'string' || !/^[a-z][a-z0-9_.]*$/.test(name) || name.length > 16) continue;
    if (!(FREE_F3 as readonly unknown[]).includes(f3) || (alu !== 'add' && alu !== 'sub' && alu !== 'f3') || (result !== 'alu' && result !== 'mem')) continue;
    if (out.some((o) => o.f3 === f3 || o.name === name) || out.length >= MAX_ROWS16) continue;
    out.push({ name, f3: f3 as Free16, alu, result });
  }
  return out;
}

/** A short key for a row set (memoizing the hardware, ids). Empty for no rows. */
export function rowsKey16(rows: readonly Custom16Row[]): string {
  if (!rows.length) return '';
  const s = rows.map((r) => `${r.name}:${r.f3}${r.alu[0]}${r.result[0]}`).sort().join(',');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}
