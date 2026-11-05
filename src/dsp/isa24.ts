// DSP24, the DSP core's own instruction set (chapter "A DSP core"): 16-bit data, 24-bit instructions, one instruction per
// clock, 27 instructions. Not a real DSP's ISA. What makes it a DSP: one instruction reads a sample from X memory and a
// coefficient from Y memory and multiply-accumulates them, each address register stepping as it is used (plus 1, minus 1,
// by a modifier, round a circular window, or in bit-reversed order), and a loop instruction repeats the instructions up to
// an end address with no branch. Words the table does not name execute as NOP, in the golden model and the hardware.
//
//   23..19 op (5 bits)
//   rd 18..16, ra 15..13, rb 12..10                   register fields (r0..r7)
//   X operand 12..8 = mode 12..10, pointer 9..8       (p0..p3 of the X address generator)
//   Y operand  7..3 = mode  7..5,  pointer 4..3       (p4..p7 of the Y address generator)
//   ld / st: the one operand sits in the X slot, bit 2 picks the memory (0 X, 1 Y); then the other memory is not touched
//   mov: dst 18..16 (low) + 12..11 (high), src 15..13 (low) + 10..9 (high); ldi: dst 18..16 + 15..14, imm14 13..0

/** Operand shapes. */
export type Shape24 =
  | '' | 'rrr' | 'rri' | 'ri' | 'mov' | 'ldi' | 'mem2' | 'memld' | 'memst' | 'r' | 'rsh' | 'loop' | 'a' | 'ra';

export interface Instr24 { name: string; op: number; shape: Shape24; summary: string }

export const INSTRS24: Instr24[] = [
  { name: 'nop', op: 0, shape: '', summary: 'no operation' },
  { name: 'halt', op: 1, shape: '', summary: 'stop: the PC stays on this instruction' },
  { name: 'mov', op: 2, shape: 'mov', summary: 'dst ← src, any of r0–r7, p0–p7, xb xl xm yb yl ym (pointers keep the low 8 bits)' },
  { name: 'ldi', op: 3, shape: 'ldi', summary: 'dst ← signed 14-bit constant' },
  { name: 'ldh', op: 4, shape: 'ri', summary: 'rd[15:8] ← constant, rd[7:0] kept (the encoding names rd twice: it is read and written)' },
  { name: 'addi', op: 5, shape: 'rri', summary: 'rd ← ra + signed 8-bit constant' },
  { name: 'add', op: 6, shape: 'rrr', summary: 'rd ← ra + rb (wraps)' },
  { name: 'sub', op: 7, shape: 'rrr', summary: 'rd ← ra − rb (wraps)' },
  { name: 'adds', op: 8, shape: 'rrr', summary: 'rd ← ra + rb, saturating' },
  { name: 'subs', op: 9, shape: 'rrr', summary: 'rd ← ra − rb, saturating' },
  { name: 'and', op: 10, shape: 'rrr', summary: 'rd ← ra & rb' },
  { name: 'or', op: 11, shape: 'rrr', summary: 'rd ← ra | rb' },
  { name: 'xor', op: 12, shape: 'rrr', summary: 'rd ← ra ^ rb' },
  { name: 'shl', op: 13, shape: 'rrr', summary: 'rd ← ra << rb[3:0]' },
  { name: 'shr', op: 14, shape: 'rrr', summary: 'rd ← ra >> rb[3:0], zeros in' },
  { name: 'sar', op: 15, shape: 'rrr', summary: 'rd ← ra >> rb[3:0], sign in' },
  { name: 'ld', op: 16, shape: 'memld', summary: 'rd ← X[p] or Y[p]; the pointer steps' },
  { name: 'st', op: 17, shape: 'memst', summary: 'X[p] or Y[p] ← ra; the pointer steps' },
  { name: 'clr', op: 18, shape: '', summary: 'acc ← 0' },
  { name: 'mac', op: 19, shape: 'mem2', summary: 'acc ← acc + X[p] × Y[q] (signed 16 × 16 into 40 bits); both pointers step' },
  { name: 'rnd', op: 20, shape: 'rsh', summary: 'rd ← clamp16(round(acc >> sh)): rounded half up once, saturated once; acc kept' },
  { name: 'rndc', op: 21, shape: 'rsh', summary: 'as rnd, and acc ← 0 at the same clock edge (read and clear)' },
  { name: 'out', op: 22, shape: 'r', summary: 'output port ← ra (one word of the result stream)' },
  { name: 'loop', op: 23, shape: 'loop', summary: 'repeat the instructions after this one, up to and including `end`, count times (a register: 0 means 65 536)' },
  { name: 'jmp', op: 24, shape: 'a', summary: 'PC ← address' },
  { name: 'jz', op: 25, shape: 'ra', summary: 'if ra = 0: PC ← address' },
  { name: 'jnz', op: 26, shape: 'ra', summary: 'if ra ≠ 0: PC ← address' },
];

export const BY_NAME24 = new Map(INSTRS24.map((i) => [i.name, i]));
export const BY_OP24 = new Map(INSTRS24.map((i) => [i.op, i]));

/** Program ROM: 256 words (an 8-bit PC). X and Y memories: 256 words of 16 bits each. */
export const ROM24_WORDS = 256;
export const MEM24_WORDS = 256;

/** Address update after an access (the mode field): what the pointer does as it is used. */
export const MODES24 = ['', '+', '-', '+m', '+c', '-c', '+r', '-m'] as const;
export const MODE_NOTES24 = [
  'unchanged', 'plus 1', 'minus 1', 'plus the modifier m', 'plus 1 round the circular window',
  'minus 1 round the circular window', 'bit-reversed: reverse-carry add of m', 'minus the modifier m',
] as const;

/** Unified register numbers: 0–7 r0–r7, 8–15 p0–p7, 16–18 xb xl xm, 20–22 yb yl ym. Numbers in between and above read 0 and ignore writes. */
export const REGNAMES24: readonly (string | undefined)[] = [
  'r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'xb', 'xl', 'xm', undefined, 'yb', 'yl', 'ym',
];
export const UREGS24 = REGNAMES24.length;
export function regNumber24(s: string): number | null {
  const i = REGNAMES24.indexOf(s.trim().toLowerCase());
  return i < 0 ? null : i;
}
export function gpr24(s: string): number | null {
  const m = s.trim().match(/^r([0-7])$/i);
  return m ? +m[1] : null;
}

export interface Decoded24 {
  name: string;
  /** A word whose op the table does not name (it runs as NOP). */
  undef: boolean;
  op: number;
  rd: number; ra: number; rb: number;
  /** X slot: mode and pointer index 0–3; Y slot likewise. */
  xmode: number; xp: number; ymode: number; yp: number;
  bus: number;
  /** mov: the 5-bit unified numbers. */
  dst: number; src: number;
  imm8: number; imm14: number; sh: number;
  /** loop: the count is a register; the 10-bit constant; the end address. */
  loopReg: number; cnt: number;
  addr: number;
}

const sx = (v: number, bits: number) => (v & (1 << (bits - 1)) ? v - (1 << bits) : v);

/** Which instruction a word is, with every field (exactly the hardware's decoding). */
export function decode24(w: number): Decoded24 {
  const op = (w >> 19) & 31;
  const ins = BY_OP24.get(op);
  const f = (hi: number, lo: number) => (w >> lo) & ((1 << (hi - lo + 1)) - 1);
  return {
    name: ins ? ins.name : 'nop', undef: !ins, op,
    rd: f(18, 16), ra: f(15, 13), rb: f(12, 10),
    xmode: f(12, 10), xp: f(9, 8), ymode: f(7, 5), yp: f(4, 3), bus: f(2, 2),
    dst: f(18, 16) | (ins?.name === 'ldi' ? f(15, 14) << 3 : f(12, 11) << 3),
    src: f(15, 13) | (f(10, 9) << 3),
    imm8: f(7, 0), imm14: f(13, 0), sh: f(5, 0),
    loopReg: f(18, 18), cnt: f(17, 8), addr: f(7, 0),
  };
}

/** Encoders (the assembler's and the tests' building blocks). */
export const enc24 = {
  rrr: (op: number, rd: number, ra: number, rb: number) => (op << 19) | (rd << 16) | (ra << 13) | (rb << 10),
  rri: (op: number, rd: number, ra: number, imm: number) => (op << 19) | (rd << 16) | (ra << 13) | (imm & 255),
  ri: (op: number, rd: number, imm: number) => (op << 19) | (rd << 16) | (rd << 13) | (imm & 255),
  mov: (op: number, dst: number, src: number) => (op << 19) | ((dst & 7) << 16) | ((src & 7) << 13) | ((dst >> 3) << 11) | ((src >> 3) << 9),
  ldi: (op: number, dst: number, imm: number) => (op << 19) | ((dst & 7) << 16) | ((dst >> 3) << 14) | (imm & 0x3fff),
  slot: (mode: number, p: number) => (mode << 2) | p,
  mem2: (op: number, xm: number, xp: number, ym: number, yp: number) => (op << 19) | (xm << 10) | (xp << 8) | (ym << 5) | (yp << 3),
  ld: (op: number, r: number, mode: number, p: number, bus: number) => (op << 19) | (r << 16) | (mode << 10) | (p << 8) | (bus << 2),
  st: (op: number, ra: number, mode: number, p: number, bus: number) => (op << 19) | (ra << 13) | (mode << 10) | (p << 8) | (bus << 2),
  r: (op: number, ra: number) => (op << 19) | (ra << 13),
  rsh: (op: number, rd: number, sh: number) => (op << 19) | (rd << 16) | (sh & 63),
  loop: (op: number, reg: number, cnt: number, end: number) => (op << 19) | (reg ? (1 << 18) | (cnt << 13) : (cnt & 0x3ff) << 8) | (end & 255),
  a: (op: number, addr: number) => (op << 19) | (addr & 255),
  ra: (op: number, ra: number, addr: number) => (op << 19) | (ra << 13) | (addr & 255),
};

const hx = (v: number, d = 2) => `0x${v.toString(16).toUpperCase().padStart(d, '0')}`;
const memOp = (bus: 'x' | 'y', mode: number, p: number) => `${bus}(p${bus === 'y' ? 4 + p : p})${MODES24[mode]}`;

/** Assembly text of a word (a word no instruction names: `.word`). */
export function disasm24(w: number): string {
  const d = decode24(w);
  if (d.undef) return w === 0 ? 'nop' : `.word ${hx(w, 6)}`;
  const ins = BY_NAME24.get(d.name)!;
  const m = d.name.padEnd(5);
  switch (ins.shape) {
    case '': return d.name;
    case 'rrr': return `${m} r${d.rd}, r${d.ra}, r${d.rb}`;
    case 'rri': return `${m} r${d.rd}, r${d.ra}, ${sx(d.imm8, 8)}`;
    case 'ri': return `${m} r${d.rd}, ${hx(d.imm8)}`;
    case 'mov': return `${m} ${REGNAMES24[d.dst] ?? `?${d.dst}`}, ${REGNAMES24[d.src] ?? `?${d.src}`}`;
    case 'ldi': return `${m} ${REGNAMES24[d.dst] ?? `?${d.dst}`}, ${sx(d.imm14, 14)}`;
    case 'mem2': return `${m} ${memOp('x', d.xmode, d.xp)}, ${memOp('y', d.ymode, d.yp)}`;
    case 'memld': return `${m} r${d.rd}, ${memOp(d.bus ? 'y' : 'x', d.xmode, d.xp)}`;
    case 'memst': return `${m} ${memOp(d.bus ? 'y' : 'x', d.xmode, d.xp)}, r${d.ra}`;
    case 'r': return `${m} r${d.ra}`;
    case 'rsh': return `${m} r${d.rd}, ${d.sh}`;
    case 'loop': return `${m} ${d.loopReg ? `r${d.ra}` : d.cnt}, ${hx(d.addr)}`;
    case 'a': return `${m} ${hx(d.addr)}`;
    case 'ra': return `${m} r${d.ra}, ${hx(d.addr)}`;
  }
}

/** The word's fields, most significant first (the CPU drawer's breakdown). */
export function fields24(w: number): { name: string; bits: number; value: number; kind: 'op' | 'reg' | 'imm' | 'mem' | 'none' }[] {
  const d = decode24(w);
  const op = { name: 'op', bits: 5, value: d.op, kind: 'op' as const };
  const shape = d.undef ? '' : BY_NAME24.get(d.name)!.shape;
  const n = (name: string, bits: number, value: number, kind: 'op' | 'reg' | 'imm' | 'mem' | 'none') => ({ name, bits, value, kind });
  switch (shape) {
    case 'rrr': return [op, n('rd', 3, d.rd, 'reg'), n('ra', 3, d.ra, 'reg'), n('rb', 3, d.rb, 'reg'), n('—', 10, 0, 'none')];
    case 'rri': return [op, n('rd', 3, d.rd, 'reg'), n('ra', 3, d.ra, 'reg'), n('—', 5, 0, 'none'), n('imm8', 8, d.imm8, 'imm')];
    case 'ri': return [op, n('rd', 3, d.rd, 'reg'), n('—', 8, 0, 'none'), n('imm8', 8, d.imm8, 'imm')];
    case 'mem2': return [op, n('—', 5, 0, 'none'), n('x mode', 3, d.xmode, 'mem'), n('x ptr', 2, d.xp, 'mem'), n('y mode', 3, d.ymode, 'mem'), n('y ptr', 2, d.yp, 'mem'), n('—', 3, 0, 'none')];
    case 'loop': return [op, n('reg?', 1, d.loopReg, 'op'), n('count', 10, d.cnt, 'imm'), n('end', 8, d.addr, 'imm')];
    case 'ldi': return [op, n('dst lo', 3, d.dst & 7, 'reg'), n('dst hi', 2, d.dst >> 3, 'reg'), n('imm14', 14, d.imm14, 'imm')];
    case 'a': return [op, n('—', 16, 0, 'none'), n('addr', 8, d.addr, 'imm')];
    default: return [op, n('operands', 19, w & 0x7ffff, 'none')];
  }
}
