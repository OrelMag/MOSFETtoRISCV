// The Apollo Guidance Computer (Block II) instruction set as a golden model (Appendix F), instruction by instruction,
// checked in lock step against yaAGC, Virtual AGC's emulator (scripts/agc/oracle.ts, .github/workflows/agc-oracle.yml).
//
// What is modelled: the basic and extracode instructions with their memory cycle times (MCT, 11.72 µs each), the
// one's-complement arithmetic with 16-bit A / L / Q and their overflow, erasable and fixed memory with the bank
// registers EB / FB / BB, the editing registers CYR / SR / CYL / EDOP, INDEX on the next instruction, EXTEND.
// What is not: interrupts (RESUME, EDRUPT and the interrupt vectors), the counters that the hardware increments between
// instructions (TIME1–6, the scaler), I/O channels, parity, the superbank bit and the alarms. A program run here starts
// at 04000 like the hardware after GOJAM, with interrupts held off (INHINT); the oracle holds yaAGC the same way (no
// timer ticks, no interrupt), so both machines run the same instructions.
//
// Where the documents leave a corner open (a register as the operand, DV out of range, a sign of zero) the model does
// what yaAGC does, since yaAGC is checked against the flight software and the oracle compares every instruction:
//   - only A, L and Q hold 16 bits; every other register is a 15-bit word, like erasable memory;
//   - L is overflow-corrected after every instruction (it keeps no overflow from one instruction to the next);
//   - TC Q (RETURN) leaves Q alone and jumps to address 2: the next instruction is Q's contents, a TC to the return
//     address, which sets Q to 3. Two instructions, as the hardware runs it (Z = 2 for one instruction);
//   - DV out of range (|dividend| ≥ |divisor|) runs the hardware's restoring-division sequence bit by bit, which
//     gives the hardware's result rather than an error.
// One known difference, on purpose: a BZF or BZMF that does not branch takes 2 MCT here (R-700, the instruction
// timing table) and 1 in yaAGC; the oracle allows exactly that.
//
// Sources: Virtual AGC's assembly language manual (R. Burkey), the instruction descriptions of R-700 vol. III ch. 3
// (E. C. Hall, 1972), yaAGC's agc_engine.c for the corners above.

import { MINUS1, PLUS1, SIGN15, SIGN16, W15, W16, add16, oc, ovf, sx } from './word';

/** Registers in erasable bank 0. */
export const REG = { A: 0, L: 1, Q: 2, EB: 3, FB: 4, Z: 5, BB: 6, ZERO: 7, CYR: 0o20, SR: 0o21, CYL: 0o22, EDOP: 0o23 } as const;
/** Erasable addresses below this hold 16 bits (A, L, Q); every other word 15. */
const REG16 = 3;
export const ERASABLE_WORDS = 0o4000, FIXED_BANKS = 0o44, BANK_WORDS = 0o2000;

export interface AgcStep {
  /** Address the instruction was fetched from, and the word executed (after INDEX). */
  z: number;
  word: number;
  extra: boolean;
  /** Its name, as decoded. */
  name: string;
  /** Memory cycles it took. */
  mct: number;
  /** A BZF / BZMF branched (or not): the oracle's timing exception. */
  branched?: boolean;
}

export interface AgcSave { e: Uint16Array; extra: boolean; index: number; inhint: boolean; mct: number; steps: number }

type Op = { name: string; mct: number; branched?: boolean };

const neg16 = (x: number) => ~x & W16;
/** |x| − 1, or +0 for ±0 and ±1 (CCS's diminished absolute value), on a 15-bit word. */
const dabs = (w: number) => { const m = (w & SIGN15) ? ~w & 0o37777 : w; return m > 1 ? m - 1 : 0; };
/** The same on a 16-bit register (an overflowed value keeps its 15 magnitude bits). */
const odabs = (x: number) => { const m = (x & SIGN16) ? ~x & W16 : x; return m > 1 ? m - 1 : 0; };
/** A 15-bit one's-complement word as a signed integer, and back. */
const toInt = (w: number) => ((w & SIGN15) ? -(~w & 0o37777) : w & 0o37777);
const fromInt = (v: number) => (v < 0 ? ~(-v) & W15 : v & W15);

export class AgcISS {
  /** Erasable memory, 8 banks of 0400 words (A, L, Q 16 bits; the rest 15). */
  readonly e = new Uint16Array(ERASABLE_WORDS);
  /** Fixed (core rope) memory, banks 0 … 043 of 02000 words. */
  readonly fixed: Uint16Array;
  /** The next instruction is an extracode (an EXTEND ran). */
  extra = false;
  /** Added to the next instruction (an INDEX ran), 15 bits. */
  index = 0;
  /** Interrupts held off (no interrupt is modelled; kept for INHINT / RELINT). */
  inhint = false;
  mct = 0;
  steps = 0;
  /** Z after the running instruction. */
  private nextZ = 0;
  private keepExtra = false;

  constructor(fixed: Uint16Array) {
    this.fixed = new Uint16Array(FIXED_BANKS * BANK_WORDS);
    this.fixed.set(fixed.subarray(0, this.fixed.length));
    this.e[REG.Z] = 0o4000; // GOJAM
  }

  get z(): number { return this.e[REG.Z]; }
  set z(v: number) { this.e[REG.Z] = v & 0o7777; }
  get a(): number { return this.e[REG.A]; }
  get l(): number { return this.e[REG.L]; }
  get q(): number { return this.e[REG.Q]; }

  save(): AgcSave { return { e: this.e.slice(), extra: this.extra, index: this.index, inhint: this.inhint, mct: this.mct, steps: this.steps }; }
  restore(s: AgcSave): void { this.e.set(s.e); this.extra = s.extra; this.index = s.index; this.inhint = s.inhint; this.mct = s.mct; this.steps = s.steps; }

  // ---- memory -----------------------------------------------------------------------------------

  /** Where a 12-bit address lives: an erasable index (≥ 0; 01400–01777 through EB), or −1 − a fixed index. */
  private where(k: number): number {
    k &= 0o7777;
    if (k < 0o1400) return k;
    if (k < 0o2000) return ((this.e[REG.EB] >> 8) & 7) * 0o400 + (k & 0o377);
    const bank = k < 0o4000 ? (this.e[REG.FB] >> 10) & 0o37 : k < 0o6000 ? 2 : 3;
    return -1 - (bank * BANK_WORDS + (k & 0o1777));
  }
  /** The word stored at a location (15 bits; A, L, Q 16). */
  private raw(i: number): number { return i >= 0 ? this.e[i] : this.fixed[-1 - i]; }
  /** A register's 16 bits (k < 3). */
  private c(k: number): number { return this.e[k]; }

  /** Store into a location: fixed memory ignores it; Z sets the next address; the editing registers edit. */
  private assign(i: number, v: number): void {
    if (i < 0) return;
    if (i < 0o400) {
      switch (i) {
        case REG.Z: this.nextZ = v; break;
        case REG.CYR: v &= W15; v = (v >> 1) | ((v & 1) << 14); break;
        case REG.SR: v &= W15; v = (v >> 1) | (v & SIGN15); break;
        case REG.CYL: v &= W15; v = (v << 1) | ((v >> 14) & 1); break;
        case REG.EDOP: v = ((v & W15) >> 7) & 0o177; break;
        case REG.ZERO: v = 0; break;
      }
      this.e[i] = i < REG16 ? v & W16 : v & W15;
      return;
    }
    this.e[i] = v & W15;
  }
  /** An instruction that reads an editing register writes it back, so it edits again. */
  private rewriteEdit(k: number, i: number): void { if (k >= REG.CYR && k <= REG.EDOP) this.assign(i, this.raw(i)); }

  /** An operand as 16 bits: a register's whole, a word sign-extended. */
  private read16(k: number): number { return k < REG16 ? this.c(k) : sx(this.raw(this.where(k))); }

  // ---- execution --------------------------------------------------------------------------------

  /** Execute one instruction. */
  step(): AgcStep {
    const z = this.z;
    const ebBefore = this.e[REG.EB], fbBefore = this.e[REG.FB], bbBefore = this.e[REG.BB];
    const word = oc(add16(sx(this.index), sx(this.raw(this.where(z))))) & W15;
    this.index = 0;
    const extra = this.extra;
    this.keepExtra = false;
    this.nextZ = z + 1;
    this.e[REG.Z] = this.nextZ;
    const r = extra ? this.extracode(word) : this.basic(word);
    // the end of every instruction (yaAGC: AllDone)
    this.e[REG.ZERO] = 0;
    this.e[REG.Z] = this.nextZ & 0o7777;
    if (!this.keepExtra) this.extra = false;
    if (bbBefore !== this.e[REG.BB]) {
      this.e[REG.FB] = this.e[REG.BB] & 0o76000;
      this.e[REG.EB] = (this.e[REG.BB] & 7) << 8;
    } else if (ebBefore !== this.e[REG.EB] || fbBefore !== this.e[REG.FB]) {
      this.e[REG.BB] = (this.e[REG.FB] & 0o76000) | ((this.e[REG.EB] & 0o3400) >> 8);
    }
    this.e[REG.EB] &= 0o3400;
    this.e[REG.FB] &= 0o76000;
    this.e[REG.BB] &= 0o76007;
    this.e[REG.L] = sx(oc(this.e[REG.L]));
    this.mct += r.mct;
    this.steps++;
    return { z, word, extra, name: r.name, mct: r.mct, branched: r.branched };
  }

  private basic(w: number): Op {
    const op = (w >> 12) & 7, qc = (w >> 10) & 3, k12 = w & 0o7777, k10 = w & 0o1777;
    const A = this.e[REG.A];
    switch (op) {
      case 0:
        if (k12 === 3) { this.inhint = false; return { name: 'RELINT', mct: 1 }; }
        if (k12 === 4) { this.inhint = true; return { name: 'INHINT', mct: 1 }; }
        if (k12 === 6) { this.extra = true; this.keepExtra = true; return { name: 'EXTEND', mct: 1 }; }
        if (k12 !== REG.Q) this.e[REG.Q] = this.nextZ & W16;
        this.nextZ = k12;
        return { name: k12 === REG.Q ? 'RETURN' : 'TC', mct: 1 };
      case 1:
        if (qc === 0) return this.ccs(k10);
        this.nextZ = k12;
        return { name: 'TCF', mct: 1 };
      case 2:
        if (qc === 0) return this.das(k10);
        if (qc === 1) return this.lxch(k10);
        if (qc === 2) {
          if (k10 < REG16) this.e[k10] = add16(PLUS1, this.c(k10));
          else { const i = this.where(k10); this.assign(i, oc(add16(PLUS1, sx(this.raw(i))))); }
          return { name: 'INCR', mct: 2 };
        }
        {
          const i = this.where(k10);
          const s = k10 === REG.A ? add16(A, A) : add16(A, this.read16(k10));
          this.e[REG.A] = s;
          if (k10 === REG.A) { /* A already holds it */ } else if (k10 < REG16) this.e[k10] = s; else this.assign(i, oc(s));
          return { name: 'ADS', mct: 2 };
        }
      case 3:
        if (k12 === REG.A) return { name: 'NOOP', mct: 2 };
        if (k12 < REG16) this.e[REG.A] = this.c(k12);
        else { const i = this.where(k12); this.e[REG.A] = sx(this.raw(i)); this.rewriteEdit(k12, i); }
        return { name: 'CA', mct: 2 };
      case 4:
        if (k12 === REG.A) { this.e[REG.A] = neg16(A); return { name: 'COM', mct: 2 }; }
        if (k12 < REG16) this.e[REG.A] = neg16(this.c(k12));
        else { const i = this.where(k12); this.e[REG.A] = sx(~this.raw(i) & W15); this.rewriteEdit(k12, i); }
        return { name: 'CS', mct: 2 };
      case 5:
        if (qc === 0) {
          if (k10 === 0o17) throw new Error('RESUME: interrupts are not modelled');
          this.index = k10 < REG16 ? oc(this.c(k10)) : this.raw(this.where(k10));
          return { name: 'INDEX', mct: 2 };
        }
        if (qc === 1) return this.dxch(k10);
        if (qc === 2) return this.ts(k10);
        if (k10 === REG.A) return { name: 'XCH', mct: 2 };
        if (k10 < REG16) { this.e[REG.A] = this.c(k10); this.e[k10] = A; if (k10 === REG.Z) this.nextZ = this.e[REG.Z]; return { name: 'XCH', mct: 2 }; }
        { const i = this.where(k10); this.e[REG.A] = sx(this.raw(i)); this.assign(i, oc(A)); return { name: 'XCH', mct: 2 }; }
      case 6:
        if (k12 === REG.A) this.e[REG.A] = add16(A, A);
        else if (k12 < REG16) this.e[REG.A] = add16(A, this.c(k12));
        else { const i = this.where(k12); this.e[REG.A] = add16(A, sx(this.raw(i))); this.rewriteEdit(k12, i); }
        return { name: k12 === REG.A ? 'DOUBLE' : 'AD', mct: 2 };
      default:
        this.e[REG.A] = k12 < REG16 ? A & this.c(k12) : sx(oc(A) & this.raw(this.where(k12)));
        return { name: 'MASK', mct: 2 };
    }
  }

  private extracode(w: number): Op {
    const op = (w >> 12) & 7, qc = (w >> 10) & 3, k12 = w & 0o7777, k10 = w & 0o1777;
    const A = this.e[REG.A];
    switch (op) {
      case 0: throw new Error('I/O channel instructions are not modelled');
      case 1:
        if (qc === 0) return this.dv(k10);
        if (A === 0 || A === W16) { this.nextZ = k12; return { name: 'BZF', mct: 1, branched: true }; }
        return { name: 'BZF', mct: 2, branched: false };
      case 2:
        if (qc === 0) return this.msu(k10);
        if (qc === 1) return this.qxch(k10);
        if (qc === 2) {
          const i = this.where(k10), v = (k10 < REG16 ? this.c(k10) : sx(this.raw(i))) & W16;
          const s = add16((v & SIGN16) ? MINUS1 : PLUS1, v);
          if (k10 < REG16) this.e[k10] = s; else this.assign(i, oc(s));
          return { name: 'AUG', mct: 2 };
        }
        {
          const i = this.where(k10), v = (k10 < REG16 ? this.c(k10) : sx(this.raw(i))) & W16;
          if (v !== 0 && v !== W16) {
            const s = add16((v & SIGN16) ? PLUS1 : MINUS1, v);
            if (k10 < REG16) this.e[k10] = s; else this.assign(i, oc(s));
          }
          return { name: 'DIM', mct: 2 };
        }
      case 3: return this.dca(k12, false);
      case 4: return this.dca(k12, true);
      case 5:
        if (k12 === 0o17 << 1) throw new Error('RESUME: interrupts are not modelled');
        this.index = k12 < REG16 ? oc(this.c(k12)) : this.raw(this.where(k12));
        this.extra = true; this.keepExtra = true;
        return { name: 'INDEX', mct: 2 };
      case 6:
        if (qc === 0) {
          if (k10 === REG.A) this.e[REG.A] = W16;
          else if (k10 < REG16) this.e[REG.A] = add16(A, neg16(this.c(k10)));
          else { const i = this.where(k10); this.e[REG.A] = add16(A, sx(~this.raw(i) & W15)); this.rewriteEdit(k10, i); }
          return { name: 'SU', mct: 2 };
        }
        if (A === 0 || (A & SIGN16)) { this.nextZ = k12; return { name: 'BZMF', mct: 1, branched: true }; }
        return { name: 'BZMF', mct: 2, branched: false };
      default: return this.mp(k12);
    }
  }

  private ccs(k: number): Op {
    let skip: number;
    if (k < REG16) {
      const v = this.c(k) & W16, w = oc(v);
      this.e[REG.A] = odabs(v);
      const o = ovf(v);
      skip = o > 0 ? 0 : o < 0 ? 2 : w === 0 ? 1 : w === W15 ? 3 : (w & SIGN15) ? 2 : 0;
    } else {
      const i = this.where(k), w = this.raw(i) & W15;
      this.e[REG.A] = dabs(w);
      this.assign(i, w);
      skip = w === 0 ? 1 : w === W15 ? 3 : (w & SIGN15) ? 2 : 0;
    }
    this.nextZ += skip;
    return { name: 'CCS', mct: 2 };
  }

  private ts(k: number): Op {
    const A = this.e[REG.A], o = ovf(A);
    if (k === REG.A) { if (o) this.nextZ += 1; return { name: 'OVSK', mct: 2 }; }
    if (k === REG.Z) { this.nextZ = A & W15; if (o) this.e[REG.A] = o > 0 ? PLUS1 : MINUS1; return { name: 'TCAA', mct: 2 }; }
    if (k < REG16) this.e[k] = A; else this.assign(this.where(k), oc(A));
    if (o) { this.e[REG.A] = o > 0 ? PLUS1 : MINUS1; this.nextZ += 1; }
    return { name: 'TS', mct: 2 };
  }

  private lxch(k: number): Op {
    if (k === REG.L) return { name: 'LXCH', mct: 2 };
    if (k === REG.ZERO) { this.e[REG.L] = 0; return { name: 'ZL', mct: 2 }; }
    if (k < REG16) { const t = this.e[REG.L]; this.e[REG.L] = this.c(k); this.e[k] = t; return { name: 'LXCH', mct: 2 }; }
    const i = this.where(k), t = this.raw(i);
    this.assign(i, oc(this.e[REG.L]));
    this.e[REG.L] = sx(t);
    return { name: 'LXCH', mct: 2 };
  }

  private qxch(k: number): Op {
    if (k === REG.Q) return { name: 'QXCH', mct: 2 };
    if (k === REG.ZERO) { this.e[REG.Q] = 0; return { name: 'ZQ', mct: 2 }; }
    if (k < REG16) { const t = this.e[REG.Q]; this.e[REG.Q] = this.c(k); this.e[k] = t; return { name: 'QXCH', mct: 2 }; }
    const i = this.where(k), t = oc(this.e[REG.Q]);
    this.e[REG.Q] = sx(this.raw(i));
    this.assign(i, t);
    return { name: 'QXCH', mct: 2 };
  }

  /** DXCH K (the word holds K + 1): (A, L) ⇄ (K, K + 1). */
  private dxch(k1: number): Op {
    if (k1 === REG.L) { this.e[REG.L] = sx(oc(this.e[REG.L])); return { name: 'DXCH', mct: 3 }; }
    const lo = this.where(k1);
    if (k1 < REG16) { const t = this.c(k1); this.e[k1] = this.e[REG.L]; this.e[REG.L] = t; if (k1 === REG.Z) this.nextZ = this.e[REG.Z]; }
    else { const t = sx(this.raw(lo)); this.assign(lo, oc(this.e[REG.L])); this.e[REG.L] = t; }
    this.e[REG.L] = sx(oc(this.e[REG.L]));
    if (k1 < REG16 + 1) { const t = this.c(k1 - 1); this.e[k1 - 1] = this.e[REG.A]; this.e[REG.A] = t; if (k1 === REG.Z + 1) this.nextZ = this.e[REG.Z]; }
    else { const hi = this.hiOf(lo); const t = sx(this.raw(hi)); this.assign(hi, oc(this.e[REG.A])); this.e[REG.A] = t; }
    return { name: 'DXCH', mct: 3 };
  }

  /** The word before a double word's low half: the next lower location (yaAGC: pointer − 1, in the same memory array). */
  private hiOf(lo: number): number { return lo >= 0 ? lo - 1 : lo + 1; }

  /** DAS K (the word holds K + 1): (K, K + 1) += (A, L); a carry out of the low word goes into the high one. */
  private das(k1: number): Op {
    const A = this.e[REG.A], L = this.e[REG.L];
    if (k1 === REG.L) {
      let lsw = add16(L, L), msw = add16(A, A);
      const c = ovf(lsw);
      if (c) msw = add16(msw, c > 0 ? PLUS1 : MINUS1);
      this.e[REG.A] = msw;
      this.e[REG.L] = sx(oc(lsw));
      return { name: 'DDOUBL', mct: 3 };
    }
    const lo = this.where(k1);
    let lsw = add16(L, k1 < REG16 ? this.c(k1) : sx(this.raw(lo)));
    const hi = k1 < REG16 + 1 ? -1 : this.hiOf(lo);
    let msw = add16(A, k1 < REG16 + 1 ? this.c(k1 - 1) : sx(this.raw(hi)));
    const c = ovf(lsw);
    if (c) msw = add16(msw, c > 0 ? PLUS1 : MINUS1);
    lsw = oc(lsw);
    const o = ovf(msw);
    this.e[REG.A] = o > 0 ? PLUS1 : o < 0 ? MINUS1 : 0;
    this.e[REG.L] = 0;
    if (k1 < REG16) this.e[k1] = sx(lsw); else this.assign(lo, lsw);
    if (k1 < REG16 + 1) this.e[k1 - 1] = msw; else this.assign(hi, oc(msw));
    return { name: 'DAS', mct: 3 };
  }

  /** DCA / DCS K (the word holds K + 1): (A, L) = ±(K, K + 1). */
  private dca(k1: number, negate: boolean): Op {
    const name = negate ? 'DCS' : 'DCA';
    const f = negate ? neg16 : (x: number) => x;
    if (k1 === REG.L) {
      if (negate) { this.e[REG.A] = neg16(this.e[REG.A]); this.e[REG.L] = sx(oc(neg16(this.e[REG.L]))); return { name: 'DCOM', mct: 3 }; }
      this.e[REG.L] = sx(oc(this.e[REG.L])); return { name, mct: 3 };
    }
    const lo = this.where(k1);
    this.e[REG.L] = f(k1 < REG16 ? this.c(k1) : sx(this.raw(lo))) & W16;
    this.e[REG.L] = sx(oc(this.e[REG.L]));
    const hi = k1 < REG16 + 1 ? -1 : this.hiOf(lo);
    this.e[REG.A] = f(k1 < REG16 + 1 ? this.c(k1 - 1) : sx(this.raw(hi))) & W16;
    if (k1 >= REG.CYR && k1 <= REG.EDOP) this.assign(lo, this.raw(lo));
    if (k1 >= REG.CYR + 1 && k1 <= REG.EDOP + 1) this.assign(hi, this.raw(hi));
    return { name, mct: 3 };
  }

  /** MSU: A − K as two's-complement numbers, the difference made one's complement. */
  private msu(k: number): Op {
    const i = this.where(k);
    const ui = k < REG16 ? this.e[REG.A] : oc(this.e[REG.A]) & W15;
    const uj = k < REG16 ? ~this.c(k) & W16 : ~this.raw(i) & W15;
    let d = ui + uj + 1;
    if (d & SIGN15) { d |= SIGN16; d--; }
    this.e[REG.A] = k === REG.Q ? d & W16 : sx(d & W15);
    if (k >= REG.CYR && k <= REG.EDOP) this.assign(i, this.raw(i));
    return { name: 'MSU', mct: 2 };
  }

  /** MP: the double-precision product of A (overflow-corrected) and K into A, L. */
  private mp(k: number): Op {
    const a = oc(this.e[REG.A]), b = k < REG16 ? oc(this.c(k)) : this.raw(this.where(k)) & W15;
    let hi: number, lo: number;
    if (b === 0 || b === W15) hi = lo = 0;
    else if (a === 0 || a === W15) hi = lo = (a === 0) === ((b & SIGN15) !== 0) ? W15 : 0;
    else {
      const p = toInt(a) * toInt(b), m = Math.abs(p);
      hi = Math.floor(m / 0o40000); lo = m % 0o40000;
      if (p < 0) { hi = ~hi & W15; lo = ~lo & W15; }
    }
    this.e[REG.A] = sx(hi);
    this.e[REG.L] = sx(lo);
    return { name: k === REG.A ? 'SQUARE' : 'MP', mct: 3 };
  }

  /**
   * DV: (A, L) / K, the quotient into A, the remainder into L. In range (|A, L| < |K|) the quotient is rounded toward
   * zero and the remainder takes the dividend's sign; out of range the hardware's division sequence runs as it would
   * (dvHardware).
   */
  private dv(k: number): Op {
    const A = this.e[REG.A], L = this.e[REG.L];
    const accA = oc(A);
    // the dividend as one signed number, the halves brought to one sign (yaAGC: SpToDecent, DecentToSp)
    const { value, msb, lsb } = decent(accA, L);
    const absA = (msb & SIGN15) ? ~msb & W15 : msb;
    const absL = (lsb & SIGN15) ? ~lsb & W15 : lsb;
    let div16: number;
    const negDividend = (absA === 0 && (L & SIGN16)) || (absA !== 0 && (A & SIGN16));
    if (k === REG.A) { div16 = A; if (!(A & SIGN16)) div16 = ~div16 & W16; }
    else if (k === REG.L) { div16 = L; if (negDividend) div16 = ~div16 & W16; div16 = sx(oc(add16(div16, 0o40000))); }
    else if (k === REG.Z) { div16 = this.e[REG.Z]; if (negDividend) div16 |= SIGN16; }
    else if (k < REG16) div16 = this.c(k);
    else div16 = sx(this.raw(this.where(k)));
    const ocD = oc(div16);
    const absK = (ocD & SIGN15) ? ~ocD & W15 : ocD;
    if (absA > absK || (absA === absK && absL !== 0) || ovf(div16) !== 0) {
      const [qa, rl] = dvHardware(A, L, div16);
      this.e[REG.A] = qa; this.e[REG.L] = rl;
    } else if (absA === 0 && absL === 0) {
      const same = (L & SIGN15) === (ocD & SIGN15);
      this.e[REG.A] = sx(same ? (absK === 0 ? 0o37777 : 0) : (absK === 0 ? 0o40000 : W15));
    } else if (absA === absK && absL === 0) {
      this.e[REG.A] = sx(msb === ocD ? 0o37777 : 0o40000);
      this.e[REG.L] = sx(msb);
    } else {
      const dividend = value, divisor = toInt(ocD);
      const q = Math.trunc(dividend / divisor), r = dividend % divisor;
      this.e[REG.A] = sx(fromInt(q));
      this.e[REG.L] = r === 0 ? (dividend >= 0 ? 0 : W16) : sx(fromInt(r));
    }
    return { name: 'DV', mct: 6 };
  }

  /** Run until the program jumps to itself (TC / TCF to the same address), or `max` instructions. */
  run(max = 1_000_000): { halted: boolean; steps: number } {
    for (let n = 0; n < max; n++) {
      const z = this.z, s = this.step();
      if ((s.name === 'TCF' || s.name === 'TC') && this.z === z) return { halted: true, steps: n + 1 };
    }
    return { halted: false, steps: max };
  }
}

/**
 * A double word (msb 15 bits, lsb a 16-bit register) as one signed integer, and its halves brought to one sign, the
 * way yaAGC reads DV's dividend. The halves read back keep yaAGC's quirk: when the high word is ±0 a negative low
 * word comes back with its sign bit clear, so only the zero tests below see the halves, the arithmetic uses `value`.
 */
function decent(msbIn: number, lsbIn: number): { value: number; msb: number; lsb: number } {
  let msb = msbIn & W15, lsb = lsbIn & W16;
  let v: number; // a 31-bit pattern: bit 30 the sign when set by the general path
  if (msb === 0 || msb === W15) {
    let x = sx(lsb);
    if (x & SIGN16) x |= ~W16;
    v = x & 0o7777777777;
  } else {
    if ((lsb & SIGN15) !== (msb & SIGN15)) {
      if (lsb === 0 || lsb === W15) lsb = (msb & SIGN15) ? W15 : 0;
      else {
        const comp = (msb & SIGN15) !== 0;
        if (comp) { msb = ~msb & W15; lsb = ~lsb & W15; }
        msb--;
        lsb = (lsb + 0o40000 + 1) & W15;
        if (comp) { msb = ~msb & W15; lsb = ~lsb & W15; }
      }
    }
    v = ((msb << 14) & 0o3777740000) | (lsb & 0o37777);
    if (v & 0o2000000000) v |= 0o4000000000;
  }
  // back to halves (DecentToSp)
  const sign = (v & 0o4000000000) !== 0;
  const outL = (v & 0o37777) | (sign ? SIGN15 : 0);
  const outM = oc((v >> 14) & W16);
  // and the value (agc2cpu2: bit 28 the sign, 28 magnitude bits)
  const value = (v & 0o2000000000) ? -(~v & 0o1777777777) : v & 0o1777777777;
  return { value, msb: outM, lsb: outL };
}

/** DV out of range: the hardware's sequence, 14 subtract-and-shift steps on 16-bit registers. Returns [A, L]. */
function dvHardware(A: number, L: number, divisor: number): [number, number] {
  let a = A & W16, l = L & W16, d = divisor & W16;
  let dividendSign = a & SIGN16;
  if (!dividendSign) a = ~a & W16;
  if (a === W16) dividendSign = l & SIGN16;
  if (dividendSign) l = ~l & W16;
  l = add16(l, 0o40000);
  if (ovf(l) !== 1) a = add16(a, 1);
  let rem = a;
  const divisorSign = d & SIGN16;
  if (divisorSign) d = ~d & W16;
  const qSign = l & SIGN16;
  let q = (qSign | ((l & 0o37777) << 1) | (qSign >> 15)) & W16;
  for (let i = 0; i < 14; i++) {
    q = (q << 1) & W16;
    const rs = rem & SIGN16;
    rem = (rs | ((rem & 0o37777) << 1)) & W16;
    if ((q & SIGN16) === 0) rem |= rs >> 15;
    const s = add16(rem, d);
    if (s & SIGN16) { q |= 1; rem = s; }
  }
  a = qSign | (q & W15);
  return [(dividendSign !== divisorSign ? ~a : a) & W16, (dividendSign ? rem : ~rem) & W16];
}
