// Appendix C's SAP-1 (Ben Eater's breadboard computer, after Malvino and Brown's SAP-1): 16 bytes of RAM, 8-bit
// words with the opcode in the high nibble and an address or immediate in the low one, and a microcoded control unit:
// every instruction takes five steps, T0–T4, and each step is one 16-bit control word read from two EEPROMs at
// address [ZF CF][opcode][step]. docs/SAP.md is the contract the hardware (lib/sap.ts) and the golden model follow.

/** Control lines, high bit to low (Ben's order): bit 15 = HLT … bit 0 = FI. */
export const SAP_CTRL = ['hlt', 'mi', 'ri', 'ro', 'io', 'ii', 'ai', 'ao', 'eo', 'su', 'bi', 'oi', 'ce', 'co', 'j', 'fi'] as const;
export type SapLine = (typeof SAP_CTRL)[number];

/** The bit of each control line in the control word. */
export const CTRL: Record<SapLine, number> = Object.fromEntries(SAP_CTRL.map((n, i) => [n, 1 << (15 - i)])) as Record<SapLine, number>;

/** How the chapter prints a line (ΣO for eo, as Ben labels it). */
export const CTRL_LABEL: Record<SapLine, string> = {
  hlt: 'HLT', mi: 'MI', ri: 'RI', ro: 'RO', io: 'IO', ii: 'II', ai: 'AI', ao: 'AO', eo: 'ΣO', su: 'SU', bi: 'BI', oi: 'OI', ce: 'CE', co: 'CO', j: 'J', fi: 'FI',
};

/** Steps per instruction: the step counter wraps after T4. */
export const SAP_STEPS = 5;

export interface SapOp {
  op: number;
  name: string;
  /** Takes an operand (address or immediate) in the low nibble. */
  arg?: 'addr' | 'imm';
  summary: string;
}

export const SAP_OPS: SapOp[] = [
  { op: 0x0, name: 'NOP', summary: 'nothing' },
  { op: 0x1, name: 'LDA', arg: 'addr', summary: 'A ← RAM[a]' },
  { op: 0x2, name: 'ADD', arg: 'addr', summary: 'B ← RAM[a]; A ← A + B; flags' },
  { op: 0x3, name: 'SUB', arg: 'addr', summary: 'B ← RAM[a]; A ← A − B; flags' },
  { op: 0x4, name: 'STA', arg: 'addr', summary: 'RAM[a] ← A' },
  { op: 0x5, name: 'LDI', arg: 'imm', summary: 'A ← n (0–15)' },
  { op: 0x6, name: 'JMP', arg: 'addr', summary: 'PC ← a' },
  { op: 0x7, name: 'JC', arg: 'addr', summary: 'PC ← a if CF' },
  { op: 0x8, name: 'JZ', arg: 'addr', summary: 'PC ← a if ZF' },
  { op: 0xe, name: 'OUT', summary: 'OUT ← A' },
  { op: 0xf, name: 'HLT', summary: 'stop the clock' },
];

export const SAP_BY_NAME = new Map(SAP_OPS.map((o) => [o.name, o]));
export const SAP_BY_OP = new Map(SAP_OPS.map((o) => [o.op, o]));

const W = (...ls: SapLine[]) => ls.reduce((w, l) => w | CTRL[l], 0);

/** Fetch, every instruction: T0 CO MI, T1 RO II CE. */
export const FETCH = [W('co', 'mi'), W('ro', 'ii', 'ce')];

/** T2–T4 per opcode, before the flags (JC / JZ keep J only while their flag is set). */
const EXEC: Record<number, number[]> = {
  0x1: [W('io', 'mi'), W('ro', 'ai')],
  0x2: [W('io', 'mi'), W('ro', 'bi'), W('eo', 'ai', 'fi')],
  0x3: [W('io', 'mi'), W('ro', 'bi'), W('eo', 'ai', 'su', 'fi')],
  0x4: [W('io', 'mi'), W('ao', 'ri')],
  0x5: [W('io', 'ai')],
  0x6: [W('io', 'j')],
  0x7: [W('io', 'j')],
  0x8: [W('io', 'j')],
  0xe: [W('ao', 'oi')],
  0xf: [W('hlt')],
};

/** The control word of an opcode's step (0–7; steps 5–7 are never reached: 0), with the flags. */
export function microcode(op: number, step: number, cf: number, zf: number): number {
  if (step < 2) return FETCH[step];
  if ((op === 0x7 && !cf) || (op === 0x8 && !zf)) return 0;
  return EXEC[op & 15]?.[step - 2] ?? 0;
}

/** The EEPROMs' address of a step: [ZF CF][opcode 4][step 3] (9 of the 28C16's 11 address lines). */
export const romAddr = (op: number, step: number, cf: number, zf: number) => (zf << 8) | (cf << 7) | ((op & 15) << 3) | (step & 7);

function image(hi: boolean): Uint8Array {
  const m = new Uint8Array(2048);
  for (let a = 0; a < 512; a++) {
    const w = microcode((a >> 3) & 15, a & 7, (a >> 7) & 1, (a >> 8) & 1);
    m[a] = hi ? w >> 8 : w & 0xff;
  }
  return m;
}

/** The two control EEPROMs' contents: the high byte of the control word (HLT … AO) and the low byte (ΣO … FI). */
export const SAP_ROM_HI = image(true);
export const SAP_ROM_LO = image(false);

/** Segments of a digit, bit 0 = a … bit 6 = g (the site's 7-segment part; bit 7 the decimal point, unused). */
export const SAP_SEG = [0x3f, 0x06, 0x5b, 0x4f, 0x66, 0x6d, 0x7d, 0x07, 0x7f, 0x6f];
/** The minus sign: segment g. */
export const SAP_MINUS = 0x40;

/**
 * The output display's decoder EEPROM, as Ben programs it: address [signed][digit 2][value 8], data the segments of
 * that digit of the value (digit 0 = ones … 2 = hundreds, 3 = the sign: blank, or a minus in two's complement).
 */
export const SAP_DISPLAY_ROM: Uint8Array = (() => {
  const m = new Uint8Array(2048);
  for (let v = 0; v < 256; v++) {
    for (let d = 0; d < 3; d++) m[(d << 8) | v] = SAP_SEG[Math.floor(v / 10 ** d) % 10];
    const s = v >= 128 ? 256 - v : v;
    for (let d = 0; d < 3; d++) m[1024 | (d << 8) | v] = SAP_SEG[Math.floor(s / 10 ** d) % 10];
    m[1024 | (3 << 8) | v] = v >= 128 ? SAP_MINUS : 0;
  }
  return m;
})();

/** The three digits the display shows for a value (ones, tens, hundreds), as segments. */
export const displayDigits = (v: number): [number, number, number] => [0, 1, 2].map((d) => SAP_DISPLAY_ROM[(d << 8) | (v & 0xff)]) as [number, number, number];

/** One byte as an instruction ("LDA 14", "OUT", "NOP" for the unused opcodes 9–D; "NOP 3" keeps a non-zero low nibble). */
export function disasm(byte: number): string {
  const op = (byte >> 4) & 15, n = byte & 15;
  const o = SAP_BY_OP.get(op);
  if (!o) return n ? `NOP ${n}` : 'NOP';
  if (o.arg) return `${o.name} ${n}`;
  return n ? `${o.name} ${n}` : o.name;
}

/** The control word's lines by name, high to low ("CO MI"). */
export const ctrlText = (w: number) => SAP_CTRL.filter((l) => w & CTRL[l]).map((l) => CTRL_LABEL[l]).join(' ');
