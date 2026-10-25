// The C extension (RV32C, with the F loads and stores of RV32FC): 16-bit instructions, each one a short
// spelling of a 32-bit instruction. decodeC / expand16 are the specification the hardware expander follows
// (lib/rvc.ts is wired from the same bit maps), compress32 is the assembler's inverse, disasmC the listing's.
//
// A 16-bit parcel is compressed when its low two bits (the quadrant) are not 11. Three-bit register
// fields (rd′, rs1′, rs2′) name x8–x15. Immediates are scattered over the instruction bits; IMM_MAPS
// gives, for each instruction bit, the immediate bit it carries.

import { ABI, decode, encB, encI, encJ, encR, encS, encU, FABI, OPCODES, sext } from './isa';

export type CFmt = 'CR' | 'CI' | 'CSS' | 'CIW' | 'CL' | 'CS' | 'CA' | 'CB' | 'CJ';

/** instruction bit → immediate bit, for each immediate layout. */
export const IMM_MAPS = {
  /** c.addi4spn: nzuimm[5:4|9:6|2|3] */
  addi4spn: { 12: 5, 11: 4, 10: 9, 9: 8, 8: 7, 7: 6, 6: 2, 5: 3 },
  /** c.lw / c.sw / c.flw / c.fsw: uimm[5:3] in 12:10, uimm[2|6] in 6:5 */
  lw: { 12: 5, 11: 4, 10: 3, 6: 2, 5: 6 },
  /** c.addi / c.li / c.andi / shift amounts: imm[5] in 12, imm[4:0] in 6:2 */
  ci: { 12: 5, 6: 4, 5: 3, 4: 2, 3: 1, 2: 0 },
  /** c.lui: nzimm[17] in 12, nzimm[16:12] in 6:2 */
  lui: { 12: 17, 6: 16, 5: 15, 4: 14, 3: 13, 2: 12 },
  /** c.addi16sp: nzimm[9] in 12, nzimm[4|6|8:7|5] in 6:2 */
  addi16sp: { 12: 9, 6: 4, 5: 6, 4: 8, 3: 7, 2: 5 },
  /** c.j / c.jal: imm[11|4|9:8|10|6|7|3:1|5] in 12:2 */
  cj: { 12: 11, 11: 4, 10: 9, 9: 8, 8: 10, 7: 6, 6: 7, 5: 3, 4: 2, 3: 1, 2: 5 },
  /** c.beqz / c.bnez: offset[8|4:3] in 12:10, offset[7:6|2:1|5] in 6:2 */
  cb: { 12: 8, 11: 4, 10: 3, 6: 7, 5: 6, 4: 2, 3: 1, 2: 5 },
  /** c.lwsp / c.flwsp: uimm[5] in 12, uimm[4:2|7:6] in 6:2 */
  lwsp: { 12: 5, 6: 4, 5: 3, 4: 2, 3: 7, 2: 6 },
  /** c.swsp / c.fswsp: uimm[5:2|7:6] in 12:7 */
  swsp: { 12: 5, 11: 4, 10: 3, 9: 2, 8: 7, 7: 6 },
} as const satisfies Record<string, Record<number, number>>;
export type ImmMap = keyof typeof IMM_MAPS;

/** The immediate a parcel carries in a layout (unsigned; sign-extend with sext where it is signed). */
export function gather(h: number, map: ImmMap): number {
  let v = 0;
  for (const [ib, vb] of Object.entries(IMM_MAPS[map])) v |= ((h >>> Number(ib)) & 1) << vb;
  return v;
}

/** The parcel bits that carry imm in a layout (bits imm does not reach must be zero: fits checks that). */
export function scatter(imm: number, map: ImmMap): number {
  let h = 0;
  for (const [ib, vb] of Object.entries(IMM_MAPS[map])) h |= ((imm >>> vb) & 1) << Number(ib);
  return h;
}

/** Does imm fit a layout: the bits it carries, sign-extended from the top one when signed? */
function fits(imm: number, map: ImmMap, signed: boolean): boolean {
  const bits = Object.values(IMM_MAPS[map]) as number[];
  const top = Math.max(...bits);
  const back = gather(scatter(imm, map), map);
  return (signed ? sext(back, top + 1) : back) === imm;
}

export interface CDecoded {
  name: string;
  fmt: CFmt;
  /** Registers as full numbers (rd′ etc. already + 8); fields the form lacks are 0. */
  rd: number;
  rs1: number;
  rs2: number;
  imm: number;
  /** The 32-bit instruction it stands for. */
  word: number;
  /** rd / rs2 name f registers (c.flw, c.fsw, c.flwsp, c.fswsp). */
  f?: boolean;
}

const isC = (h: number) => (h & 3) !== 3;
const r3 = (h: number, lo: number) => 8 + ((h >>> lo) & 7);
const r5 = (h: number, lo: number) => (h >>> lo) & 31;

/** A 16-bit parcel's meaning, or null when it is reserved, an RV64 / D form, or quadrant 11. */
export function decodeC(h: number): CDecoded | null {
  h &= 0xffff;
  if (!isC(h)) return null;
  const q = h & 3, f3 = h >>> 13;
  const out = (name: string, fmt: CFmt, word: number, rd = 0, rs1 = 0, rs2 = 0, imm = 0, f?: boolean): CDecoded =>
    ({ name, fmt, rd, rs1, rs2, imm, word: word >>> 0, ...(f ? { f } : {}) });
  if (q === 0) {
    const rdp = r3(h, 2), rs1p = r3(h, 7);
    switch (f3) {
      case 0: {
        const imm = gather(h, 'addi4spn');
        if (imm === 0) return null; // includes the all-zero parcel: defined illegal
        return out('c.addi4spn', 'CIW', encI(OPCODES.OPIMM, rdp, 0, 2, imm), rdp, 2, 0, imm);
      }
      case 2: { const imm = gather(h, 'lw'); return out('c.lw', 'CL', encI(OPCODES.LOAD, rdp, 2, rs1p, imm), rdp, rs1p, 0, imm); }
      case 3: { const imm = gather(h, 'lw'); return out('c.flw', 'CL', encI(OPCODES.LOADFP, rdp, 2, rs1p, imm), rdp, rs1p, 0, imm, true); }
      case 6: { const imm = gather(h, 'lw'); return out('c.sw', 'CS', encS(OPCODES.STORE, 2, rs1p, rdp, imm), 0, rs1p, rdp, imm); }
      case 7: { const imm = gather(h, 'lw'); return out('c.fsw', 'CS', encS(OPCODES.STOREFP, 2, rs1p, rdp, imm), 0, rs1p, rdp, imm, true); }
      default: return null; // c.fld / c.fsd (D) and the reserved slot
    }
  }
  if (q === 1) {
    const rd = r5(h, 7), ci = sext(gather(h, 'ci'), 6);
    switch (f3) {
      case 0: return out(rd === 0 ? 'c.nop' : 'c.addi', 'CI', encI(OPCODES.OPIMM, rd, 0, rd, ci), rd, rd, 0, ci);
      case 1: { const imm = sext(gather(h, 'cj'), 12); return out('c.jal', 'CJ', encJ(OPCODES.JAL, 1, imm), 1, 0, 0, imm); }
      case 2: return out('c.li', 'CI', encI(OPCODES.OPIMM, rd, 0, 0, ci), rd, 0, 0, ci);
      case 3: {
        if (rd === 2) {
          const imm = sext(gather(h, 'addi16sp'), 10);
          if (imm === 0) return null;
          return out('c.addi16sp', 'CI', encI(OPCODES.OPIMM, 2, 0, 2, imm), 2, 2, 0, imm);
        }
        const imm = sext(gather(h, 'lui'), 18);
        if (imm === 0) return null;
        return out('c.lui', 'CI', encU(OPCODES.LUI, rd, imm >> 12), rd, 0, 0, imm);
      }
      case 4: {
        const rdp = r3(h, 7), rs2p = r3(h, 2), sel = (h >>> 10) & 3;
        if (sel < 2) {
          if (h & 0x1000) return null; // shamt[5] = 1: RV32 has no such shift
          const sh = gather(h, 'ci');
          return out(sel ? 'c.srai' : 'c.srli', 'CB', encI(OPCODES.OPIMM, rdp, 5, rdp, (sel ? 0x400 : 0) | sh), rdp, rdp, 0, sh);
        }
        if (sel === 2) return out('c.andi', 'CB', encI(OPCODES.OPIMM, rdp, 7, rdp, ci), rdp, rdp, 0, ci);
        if (h & 0x1000) return null; // c.subw / c.addw: RV64
        const op = (h >>> 5) & 3;
        const [name, f3r, f7] = ([['c.sub', 0, 0x20], ['c.xor', 4, 0], ['c.or', 6, 0], ['c.and', 7, 0]] as const)[op];
        return out(name, 'CA', encR(OPCODES.OP, rdp, f3r, rdp, rs2p, f7), rdp, rdp, rs2p);
      }
      case 5: { const imm = sext(gather(h, 'cj'), 12); return out('c.j', 'CJ', encJ(OPCODES.JAL, 0, imm), 0, 0, 0, imm); }
      default: {
        const rs1p = r3(h, 7), imm = sext(gather(h, 'cb'), 9);
        return out(f3 === 6 ? 'c.beqz' : 'c.bnez', 'CB', encB(OPCODES.BRANCH, f3 === 6 ? 0 : 1, rs1p, 0, imm), 0, rs1p, 0, imm);
      }
    }
  }
  // quadrant 2
  const rd = r5(h, 7), rs2 = r5(h, 2);
  switch (f3) {
    case 0: {
      if (h & 0x1000) return null;
      const sh = gather(h, 'ci');
      return out('c.slli', 'CI', encI(OPCODES.OPIMM, rd, 1, rd, sh), rd, rd, 0, sh);
    }
    case 2: {
      if (rd === 0) return null;
      const imm = gather(h, 'lwsp');
      return out('c.lwsp', 'CI', encI(OPCODES.LOAD, rd, 2, 2, imm), rd, 2, 0, imm);
    }
    case 3: { const imm = gather(h, 'lwsp'); return out('c.flwsp', 'CI', encI(OPCODES.LOADFP, rd, 2, 2, imm), rd, 2, 0, imm, true); }
    case 4:
      if (!(h & 0x1000)) {
        if (rs2 === 0) return rd === 0 ? null : out('c.jr', 'CR', encI(OPCODES.JALR, 0, 0, rd, 0), 0, rd);
        return out('c.mv', 'CR', encR(OPCODES.OP, rd, 0, 0, rs2, 0), rd, 0, rs2);
      }
      if (rs2 === 0) return rd === 0 ? out('c.ebreak', 'CR', 0x00100073) : out('c.jalr', 'CR', encI(OPCODES.JALR, 1, 0, rd, 0), 1, rd);
      return out('c.add', 'CR', encR(OPCODES.OP, rd, 0, rd, rs2, 0), rd, rd, rs2);
    case 6: { const imm = gather(h, 'swsp'); return out('c.swsp', 'CSS', encS(OPCODES.STORE, 2, 2, rs2, imm), 0, 2, rs2, imm); }
    case 7: { const imm = gather(h, 'swsp'); return out('c.fswsp', 'CSS', encS(OPCODES.STOREFP, 2, 2, rs2, imm), 0, 2, rs2, imm, true); }
    default: return null; // c.fldsp / c.fsdsp (D)
  }
}

/** The 32-bit instruction a 16-bit parcel stands for, or null (reserved or not compressed). */
export function expand16(h: number): number | null {
  return decodeC(h)?.word ?? null;
}

const pr = (r: number) => r >= 8 && r <= 15;
const q1 = (f3: number, rd: number, map: ImmMap, imm: number) => (f3 << 13) | (rd << 7) | scatter(imm, map) | 1;

/**
 * A 16-bit parcel that does what a 32-bit instruction does, or null. Its expansion is the same word, except
 * that `addi rd, rs, 0` (mv) becomes c.mv, whose expansion is `add rd, x0, rs`: the same effect, as the GNU
 * assembler does. Never a hint or reserved form.
 */
export function compress32(word: number): number | null {
  const d = decode(word);
  const { name, rd, rs1, rs2, imm } = d;
  const f3 = (n: number) => n << 13;
  switch (name) {
    case 'addi':
      if (rd === 0 && rs1 === 0 && imm === 0) return 0x0001; // nop
      // c.addi first (as the GNU assembler): c.addi16sp only for steps of 16 beyond its reach
      if (rd === 2 && rs1 === 2 && imm !== 0 && !fits(imm, 'ci', true) && fits(imm, 'addi16sp', true)) return q1(3, 2, 'addi16sp', imm);
      if (rs1 === 2 && pr(rd) && imm !== 0 && fits(imm, 'addi4spn', false)) return f3(0) | scatter(imm, 'addi4spn') | ((rd - 8) << 2);
      if (rd === 0) return null;
      if (rs1 === 0 && fits(imm, 'ci', true)) return q1(2, rd, 'ci', imm);
      if (imm === 0 && rs1 !== 0) return f3(4) | (rd << 7) | (rs1 << 2) | 2; // mv → c.mv
      if (rd === rs1 && imm !== 0 && fits(imm, 'ci', true)) return q1(0, rd, 'ci', imm);
      return null;
    case 'lui': {
      if (rd === 0 || rd === 2 || imm === 0 || !fits(imm, 'lui', true)) return null;
      return q1(3, rd, 'lui', imm);
    }
    case 'andi': return rd === rs1 && pr(rd) && fits(imm, 'ci', true) ? f3(4) | (2 << 10) | ((rd - 8) << 7) | scatter(imm, 'ci') | 1 : null;
    case 'srli': case 'srai':
      return rd === rs1 && pr(rd) && imm !== 0 ? f3(4) | ((name === 'srai' ? 1 : 0) << 10) | ((rd - 8) << 7) | scatter(imm, 'ci') | 1 : null;
    case 'slli': return rd === rs1 && rd !== 0 && imm !== 0 ? f3(0) | (rd << 7) | scatter(imm, 'ci') | 2 : null;
    case 'sub': case 'xor': case 'or': case 'and': {
      if (rd !== rs1 || !pr(rd) || !pr(rs2)) return null;
      const op = ['sub', 'xor', 'or', 'and'].indexOf(name);
      return f3(4) | (3 << 10) | ((rd - 8) << 7) | (op << 5) | ((rs2 - 8) << 2) | 1;
    }
    case 'add':
      if (rd === 0 || rs2 === 0) return null;
      if (rs1 === 0) return f3(4) | (rd << 7) | (rs2 << 2) | 2;
      return rd === rs1 ? f3(4) | 0x1000 | (rd << 7) | (rs2 << 2) | 2 : null;
    case 'lw': case 'flw': {
      const fl = name === 'flw';
      if (rs1 === 2 && (fl || rd !== 0) && fits(imm, 'lwsp', false)) return f3(fl ? 3 : 2) | (rd << 7) | scatter(imm, 'lwsp') | 2;
      return pr(rd) && pr(rs1) && fits(imm, 'lw', false) ? f3(fl ? 3 : 2) | scatter(imm, 'lw') | ((rs1 - 8) << 7) | ((rd - 8) << 2) : null;
    }
    case 'sw': case 'fsw': {
      const fl = name === 'fsw';
      if (rs1 === 2 && fits(imm, 'swsp', false)) return f3(fl ? 7 : 6) | scatter(imm, 'swsp') | (rs2 << 2) | 2;
      return pr(rs2) && pr(rs1) && fits(imm, 'lw', false) ? f3(fl ? 7 : 6) | scatter(imm, 'lw') | ((rs1 - 8) << 7) | ((rs2 - 8) << 2) : null;
    }
    case 'jal':
      if (!fits(imm, 'cj', true) || (rd !== 0 && rd !== 1)) return null;
      return f3(rd ? 1 : 5) | scatter(imm, 'cj') | 1;
    case 'jalr':
      if (imm !== 0 || rs1 === 0 || (rd !== 0 && rd !== 1)) return null;
      return f3(4) | (rd ? 0x1000 : 0) | (rs1 << 7) | 2;
    case 'beq': case 'bne':
      if (rs2 !== 0 || !pr(rs1) || !fits(imm, 'cb', true)) return null;
      return f3(name === 'beq' ? 6 : 7) | ((rs1 - 8) << 7) | scatter(imm, 'cb') | 1;
    case 'ebreak': return 0x9002;
    default: return null;
  }
}

const rn = (r: number, f?: boolean) => (f ? FABI[r] : ABI[r]);

/** Disassemble a 16-bit parcel; pc (if given) resolves branch / jump targets. */
export function disasmC(h: number, pc?: number): string {
  const d = decodeC(h);
  if (!d) return `.half 0x${(h & 0xffff).toString(16).padStart(4, '0')}`;
  const tgt = (off: number) => (pc === undefined ? `${off}` : `0x${((pc + off) >>> 0).toString(16)}`);
  const n = d.name;
  switch (n) {
    case 'c.nop': case 'c.ebreak': return n;
    case 'c.addi4spn': return `${n} ${rn(d.rd)}, sp, ${d.imm}`;
    case 'c.addi16sp': return `${n} sp, ${d.imm}`;
    case 'c.lw': case 'c.flw': case 'c.lwsp': case 'c.flwsp': return `${n} ${rn(d.rd, d.f)}, ${d.imm}(${rn(d.rs1)})`;
    case 'c.sw': case 'c.fsw': case 'c.swsp': case 'c.fswsp': return `${n} ${rn(d.rs2, d.f)}, ${d.imm}(${rn(d.rs1)})`;
    case 'c.lui': return `${n} ${rn(d.rd)}, 0x${((d.imm >> 12) & 0xfffff).toString(16)}`;
    case 'c.j': case 'c.jal': return `${n} ${tgt(d.imm)}`;
    case 'c.jr': case 'c.jalr': return `${n} ${rn(d.rs1)}`;
    case 'c.beqz': case 'c.bnez': return `${n} ${rn(d.rs1)}, ${tgt(d.imm)}`;
    case 'c.mv': case 'c.add': case 'c.sub': case 'c.xor': case 'c.or': case 'c.and': return `${n} ${rn(d.rd)}, ${rn(d.rs2)}`;
    default: return `${n} ${rn(d.rd)}, ${d.imm}`; // c.addi, c.li, c.slli, c.srli, c.srai, c.andi
  }
}

/** The instruction at a byte address of a memory image of 32-bit words: its bits (16 or 32) and length. */
export function parcelAt(words: ArrayLike<number>, pc: number, fill = 0x00000013): { bits: number; size: 2 | 4 } {
  const at = (a: number) => ((words[a >>> 2] ?? fill) >>> ((a & 2) * 8)) & 0xffff;
  const lo = at(pc);
  if (isC(lo)) return { bits: lo, size: 2 };
  return { bits: (lo | (at(pc + 2) << 16)) >>> 0, size: 4 };
}
