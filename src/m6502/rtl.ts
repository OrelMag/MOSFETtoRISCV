// Register-transfer model of our 6502: the datapath and random logic the transistor netlist
// implements, phase by phase, driven by the control table (ucode.ts). It is what the design is
// debugged on (against the ISS, every bus cycle) before a transistor exists, and what the
// transistor-level chip is compared with register by register.
//
// Buses are precharged to $FF; every enabled source pulls bits low, so two sources give their AND,
// and an undriven bus reads $FF (the table uses that for −1). SB_DB / SB_ADH join buses into one.

import type { Bus6502 } from './iss';
import { has, MAX_T, SIG, SIG_WORDS, UCODE } from './ucode';

const S = SIG;
const NONE = new Uint32Array(SIG_WORDS);

/** Branch tails for the next fetch: not taken (or no branch), taken within the page, page crossed. */
const BR_NONE = 0, BR_SAME = 1, BR_CROSS = 2;

export interface RtlState {
  a: number; x: number; y: number; s: number; p: number; pcl: number; pch: number; ir: number; t: number;
}

export class Rtl6502 {
  // programmer-visible registers (p: N V 1 B D I Z C as on the stack, B kept 0)
  a = 0; x = 0; y = 0; s = 0; p = 0x20;
  pcl = 0; pch = 0;
  // internal registers
  ir = 0; t = 1;
  pcsl = 0; pcsh = 0; abl = 0; abh = 0; dl = 0; dor = 0;
  ai = 0; bi = 0; add = 0;
  /** ALU carry out of the last cycle (page crossing), and the decimal corrections ADD carries. */
  acr = 0; daa = 0; dsa = 0;
  /** ALU result to write in the next φ1 (0 none, else 1 A, 2 X, 3 Y). */
  wpend = 0;
  br = BR_NONE; brNeg = 0;
  // interrupts: inputs (true = asserted), sampled signals, the sequence in progress
  irq = false; nmi = false; res = false;
  irqSig = false; nmiSig = false; nmiPrev = false;
  intg = false; resetting = false; vec = 0xfe; pending = false;
  cycles = 0;
  // this cycle's pins
  addr = 0; data = 0; write = false; sync = 0;

  constructor(readonly bus: Bus6502) {}

  get pc(): number { return (this.pch << 8) | this.pcl; }
  set pc(v: number) { this.pcl = v & 0xff; this.pch = v >> 8; }

  /** Start from an instruction boundary at pc (the previous instruction a NOP: nothing left to finish). */
  boundary(st: Partial<RtlState> & { pc: number }): void {
    Object.assign(this, { ir: 0xea, t: 1, wpend: 0, br: BR_NONE, intg: false, resetting: false, pending: false }, st);
    this.pc = st.pc;
  }

  /** Begin the reset sequence: as if RES was held low and released before the next cycle. */
  reset(): void {
    // while RES is low the chip runs fetch cycles with a NOP in IR and PC held; this is its release
    this.t = 1; this.ir = 0xea; this.intg = true; this.resetting = true; this.vec = 0xfc;
    this.wpend = 0; this.br = BR_NONE; this.pending = false; this.nmiSig = false; this.irqSig = false;
  }

  /** One clock cycle (φ1 then φ2). */
  cycle(): void {
    const t = this.t;
    const row = UCODE[this.ir]?.[t - 1] ?? NONE;
    const on = (s: number) => has(row, s);
    const P = this.p;
    const fC = P & 1, fZ = (P >> 1) & 1, fI = (P >> 2) & 1, fD = (P >> 3) & 1, fV = (P >> 6) & 1, fN = P >> 7;

    // ---- random logic: the cases the table leaves open ------------------------------------------
    let pcInc = on(S.PC_INC), addAdl = on(S.ADD_ADL), pchAdh = on(S.PCH_ADH), pclAdl = on(S.PCL_ADL);
    let addSb = on(S.ADD_SB), sbAdh = on(S.SB_ADH);
    const adlPcl = on(S.ADL_PCL), adhPch = on(S.ADH_PCH);
    const ablLd = on(S.ADL_ABL), abhLd = on(S.ADH_ABH);
    let dlAdh = on(S.DL_ADH), sbAi = on(S.SB_AI), zeroAi = on(S.ZERO_AI), cin1 = on(S.CIN_1);
    if (on(S.BR_T1)) {
      // the fetch after a branch: at the target computed in ADD (and its fixed high byte)
      if (this.br === BR_SAME) { addAdl = true; pchAdh = true; } else if (this.br === BR_CROSS) { pclAdl = true; addSb = true; sbAdh = true; } else { pclAdl = true; pchAdh = true; }
    }
    if (on(S.BR_FIX)) {
      // PCH ± 1: a negative offset adds SB's precharged $FF, a positive one adds 0 with carry
      if (this.brNeg) sbAi = true; else { zeroAi = true; cin1 = true; }
    }
    if (this.intg && (t === 1 || t === 2)) pcInc = false;
    const write = on(S.WRITE) && !this.resetting;

    // ---- φ1: buses ---------------------------------------------------------------------------------
    let db = 0xff, sb = 0xff, adl = 0xff, adh = 0xff;
    if (on(S.DL_DB)) db &= this.dl;
    if (on(S.A_DB)) db &= this.a;
    if (on(S.P_DB)) db &= this.p | 0x20 | (this.intg ? 0 : 0x10);
    if (on(S.PCL_DB)) db &= this.pcl;
    if (on(S.PCH_DB)) db &= this.pch;
    if (on(S.A_SB)) sb &= this.a;
    if (on(S.X_SB)) sb &= this.x;
    if (on(S.Y_SB)) sb &= this.y;
    if (on(S.S_SB)) sb &= this.s;
    const w = this.wpend;
    if (addSb || w) sb &= this.adjusted();
    if (pclAdl) adl &= this.pcl;
    if (on(S.S_ADL)) adl &= this.s;
    if (on(S.DL_ADL)) adl &= this.dl;
    if (addAdl) adl &= this.add;
    if (on(S.VEC_LO)) adl &= this.vec;
    if (on(S.VEC_HI)) adl &= this.vec | 1;
    if (pchAdh) adh &= this.pch;
    if (dlAdh) adh &= this.dl;
    if (on(S.ZERO_ADH)) adh &= 0;
    if (on(S.ONE_ADH)) adh &= 1;
    const sbDb = on(S.SB_DB);
    if (sbDb && sbAdh) { const v = sb & db & adh; sb = db = adh = v; } else if (sbDb) { const v = sb & db; sb = db = v; } else if (sbAdh) { const v = sb & adh; sb = adh = v; }

    // ---- φ1: loads ---------------------------------------------------------------------------------
    if (on(S.SB_A) || w === 1) this.a = sb;
    if (on(S.SB_X) || w === 2) this.x = sb;
    if (on(S.SB_Y) || w === 3) this.y = sb;
    if (on(S.SB_S)) this.s = sb;
    if (on(S.DB_DOR)) this.dor = db;
    if (ablLd) this.abl = adl;
    if (abhLd) this.abh = adh;
    this.pcsl = adlPcl ? adl : this.pcl;
    this.pcsh = adhPch ? adh : this.pch;
    if (sbAi) this.ai = sb; else if (zeroAi) this.ai = 0;
    if (on(S.DB_BI)) this.bi = db; else if (on(S.NDB_BI)) this.bi = ~db & 0xff; else if (on(S.ADL_BI)) this.bi = adl;
    let p = this.p;
    if (on(S.DB_P)) p = (db & 0xcf) | 0x20;
    if (on(S.DB_NZ)) p = (p & 0x7d) | (db & 0x80) | (db === 0 ? 2 : 0);
    if (on(S.DB_N)) p = (p & 0x7f) | (db & 0x80);
    if (on(S.DB_V)) p = (p & 0xbf) | (db & 0x40);
    if (on(S.C0)) p &= ~1; if (on(S.C1)) p |= 1;
    if (on(S.I0)) p &= ~4; if (on(S.I1)) p |= 4;
    if (on(S.D0)) p &= ~8; if (on(S.D1)) p |= 8;
    if (on(S.V0)) p &= ~0x40;

    // ---- φ1: ALU (the function and carry are latched for φ2) ---------------------------------------
    const cin = cin1 ? 1 : on(S.CIN_C) ? fC : on(S.CIN_ACR) ? this.acr : 0;
    const ai = this.ai, bi = this.bi;
    let out: number, carry = 0, v = 0, zbin: number | undefined, daa = 0, dsa = 0;
    if (on(S.OP_AND)) out = ai & bi; else if (on(S.OP_OR)) out = ai | bi; else if (on(S.OP_EOR)) out = ai ^ bi;
    else if (on(S.OP_SR)) { out = (ai >> 1) | (cin << 7); carry = ai & 1; } else {
      const dadc = on(S.DEC_ADC) && fD === 1, dsbc = on(S.DEC_SBC) && fD === 1;
      const lo = (ai & 15) + (bi & 15) + cin;
      const hc = dadc ? lo >= 10 : lo > 15;
      const hi = (ai >> 4) + (bi >> 4) + (hc ? 1 : 0);
      out = ((hi & 15) << 4) | (lo & 15);
      carry = (dadc ? hi >= 10 : hi > 15) ? 1 : 0;
      v = ~(ai ^ bi) & (ai ^ out) & 0x80 ? 1 : 0;
      zbin = (ai + bi + cin) & 0xff;
      if (dadc) daa = (hc ? 1 : 0) | (carry ? 2 : 0);
      if (dsbc) dsa = (lo > 15 ? 0 : 1) | (carry ? 0 : 2);
    }
    zbin ??= out;

    // ---- φ1: sequencing and interrupts -------------------------------------------------------------
    let taken = 0;
    if (on(S.END_NOTTAKEN)) {
      const f = [fN, fV, fC, fZ][this.ir >> 6];
      taken = f === ((this.ir >> 5) & 1) ? 1 : 0;
    }
    if (on(S.END_NOCROSS_BR)) this.brNeg = db >> 7;
    const crossBr = on(S.END_NOCROSS_BR) && (carry ^ this.brNeg) === 1;
    const end = on(S.END) || on(S.END_INT) || (on(S.END_NOCROSS) && !this.acr) || (on(S.END_NOTTAKEN) && !taken) ||
      (on(S.END_NOCROSS_BR) && !crossBr);
    // the branch's next fetch
    let br = this.br;
    if (on(S.END_NOTTAKEN)) br = BR_NONE;
    if (on(S.END_NOCROSS_BR)) br = crossBr ? BR_CROSS : BR_SAME;
    // polling: in an instruction's last cycle (a taken branch within the page keeps its earlier poll;
    // the interrupt sequence's own last cycle does not poll), with the signals sampled a cycle ago
    const poll = on(S.END) || on(S.END_NOCROSS) || on(S.END_NOTTAKEN) || on(S.BR_FIX);
    const pending = poll ? this.nmiSig || (this.irqSig && fI === 0) : this.pending;
    if (on(S.VEC_SEL) && !this.resetting) {
      // the P push picks the vector: an NMI sampled by now takes over (a BRK's or an IRQ's too)
      this.vec = this.nmiSig ? 0xfa : 0xfe;
      this.nmiSig = false;
    }

    // pins for this cycle
    this.addr = (this.abh << 8) | this.abl;
    this.write = write;
    this.sync = t === 1 && !this.resetting ? 1 : 0;

    // ---- φ2 ----------------------------------------------------------------------------------------
    this.add = out; this.acr = carry; this.daa = daa; this.dsa = dsa;
    if (on(S.ALU_C)) p = (p & ~1) | carry;
    if (on(S.ALU_V)) p = (p & ~0x40) | (v << 6);
    if (on(S.ALU_NZ)) p = (p & 0x7d) | (out & 0x80) | (zbin === 0 ? 2 : 0);
    if (on(S.ALU_Z)) p = (p & ~2) | (out === 0 ? 2 : 0);
    this.p = p;
    const pc = ((this.pcsh << 8) | this.pcsl) + (pcInc ? 1 : 0);
    this.pcl = pc & 0xff; this.pch = (pc >> 8) & 0xff;
    if (write) {
      this.bus.write(this.addr, this.dor);
      this.data = this.dor;
    } else {
      this.data = this.bus.read(this.addr) & 0xff;
      if (!on(S.DL_HOLD)) this.dl = this.data;
    }
    if (t === 1) this.ir = this.intg ? 0 : this.data;
    this.wpend = on(S.W_A) ? 1 : on(S.W_X) ? 2 : on(S.W_Y) ? 3 : 0;
    this.br = br;
    this.pending = pending;
    if (end) {
      // the next cycle fetches; an interrupt sequence replaces the instruction
      if (on(S.END_INT)) { this.intg = false; this.resetting = false; }
      if (pending) { this.intg = true; this.pending = false; }
      this.t = 1;
    } else this.t = t + 1 > MAX_T ? 1 : t + 1;
    // interrupt inputs, sampled at the end of φ2
    this.irqSig = this.irq;
    if (this.nmi && !this.nmiPrev) this.nmiSig = true;
    this.nmiPrev = this.nmi;
    this.cycles++;
  }

  /** ADD as SB sees it: with the decimal corrections of the ADC / SBC that computed it. */
  private adjusted(): number {
    let lo = this.add & 15, hi = this.add >> 4;
    if (this.daa & 1) lo = (lo + 6) & 15;
    if (this.daa & 2) hi = (hi + 6) & 15;
    if (this.dsa & 1) lo = (lo + 10) & 15;
    if (this.dsa & 2) hi = (hi + 10) & 15;
    return (hi << 4) | lo;
  }
}
