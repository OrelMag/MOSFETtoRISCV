// The Apollo Guidance Computer (Block II) instruction set as a golden model (Appendix F), instruction by instruction,
// checked in lock step against yaAGC, Virtual AGC's emulator (scripts/agc/oracle.ts, .github/workflows/agc-oracle.yml).
//
// What is modelled: the 34 basic and extracode instructions with their memory cycle times (MCT, 11.72 µs each), the
// one's-complement arithmetic with 16-bit A / L / Q and their overflow, erasable and fixed memory with the bank
// registers EB / FB / BB, the editing registers CYR / SR / CYL / EDOP, INDEX on the next instruction, EXTEND.
// What is not: interrupts (RESUME, EDRUPT and the interrupt vectors), the counters that the hardware increments between
// instructions (TIME1–6, the scaler), I/O channels other than L and Q, parity, the superbank bit and the alarms. A
// program run here starts at 04000 like the hardware after GOJAM, with interrupts held off (INHINT); the oracle holds
// yaAGC the same way (no timer ticks, no interrupt), so both machines run the same instructions.
//
// Sources: Virtual AGC's assembly language manual (R. Burkey), the instruction descriptions of R-700 vol. III ch. 3
// (E. C. Hall, 1972); where the two are silent, yaAGC's observable behaviour, which the oracle compares every step.

import { MINUS1, PLUS1, SIGN15, SIGN16, W15, W16, add16, neg16, oc, ovf, sx } from './word';

/** Registers in erasable bank 0. */
export const REG = { A: 0, L: 1, Q: 2, EB: 3, FB: 4, Z: 5, BB: 6, ZERO: 7, CYR: 0o20, SR: 0o21, CYL: 0o22, EDOP: 0o23 } as const;
/** Erasable addresses below this hold 16 bits (the central registers and their interrupt copies); the rest 15. */
const REG16 = 0o20;
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
}

export interface AgcSave { fetched: number | null; e: Uint16Array; z: number; extra: boolean; index: number; inhint: boolean; mct: number; steps: number }

export class AgcISS {
  /** Erasable memory, 8 banks of 0400 words (the registers are bank 0's first 020 words, 16 bits wide). */
  readonly e = new Uint16Array(ERASABLE_WORDS);
  /** Fixed (core rope) memory, banks 0 … 043 of 02000 words. */
  readonly fixed: Uint16Array;
  /** The next instruction is an extracode (an EXTEND ran). */
  extra = false;
  /** Added to the next instruction (an INDEX ran), 16 bits. */
  index = 0;
  /** Interrupts held off (no interrupt is modelled; kept for INHINT / RELINT). */
  inhint = false;
  /**
   * The next instruction word when it was read before the instruction that sent Z there changed it: TC K fetches the word
   * at K before it writes Q, so TC Q (RETURN) runs the old Q as a TC to the return address, and Q ends as 3.
   */
  private fetched: number | null = null;
  mct = 0;
  steps = 0;

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

  save(): AgcSave { return { fetched: this.fetched, e: this.e.slice(), z: this.z, extra: this.extra, index: this.index, inhint: this.inhint, mct: this.mct, steps: this.steps }; }
  restore(s: AgcSave): void { this.fetched = s.fetched; this.e.set(s.e); this.extra = s.extra; this.index = s.index; this.inhint = s.inhint; this.mct = s.mct; this.steps = s.steps; }

  // ---- memory -----------------------------------------------------------------------------------

  /** Erasable index of a 12-bit address below 02000 (switched bank 01400–01777 by EB), or −1 for fixed memory. */
  private eIndex(k: number): number {
    if (k < 0o1400) return k;
    if (k < 0o2000) return ((this.e[REG.EB] >> 8) & 7) * 0o400 + (k & 0o377);
    return -1;
  }
  /** Fixed index of a 12-bit address at or above 02000: common fixed by FB, then fixed-fixed banks 2 and 3. */
  private fIndex(k: number): number {
    if (k < 0o4000) return ((this.e[REG.FB] >> 10) & 0o37) * BANK_WORDS + (k & 0o1777);
    return (k < 0o6000 ? 2 : 3) * BANK_WORDS + (k & 0o1777);
  }

  /** A word as an operand: 16 bits from a central register, a 15-bit word sign-extended. */
  read16(k: number): number {
    k &= 0o7777;
    if (k === REG.ZERO) return 0;
    if (k < REG16) return this.e[k];
    const i = this.eIndex(k);
    return sx(i >= 0 ? this.e[i] : this.fixed[this.fIndex(k)]);
  }
  /** A word as 15 bits (a central register overflow-corrected). */
  read15(k: number): number { return (k & 0o7777) < REG16 ? oc(this.read16(k)) : this.read16(k) & W15; }

  /** Store a 16-bit value: whole into a central register, overflow-corrected (and edited) into a 15-bit word; fixed memory ignores it. */
  write16(k: number, x: number): void {
    k &= 0o7777;
    x &= W16;
    if (k < REG16) {
      switch (k) {
        case REG.ZERO: return;
        case REG.EB: this.e[REG.EB] = x & 0o3400; this.e[REG.BB] = (this.e[REG.FB] & 0o76000) | ((x >> 8) & 7); return;
        case REG.FB: this.e[REG.FB] = x & 0o76000; this.e[REG.BB] = (x & 0o76000) | ((this.e[REG.EB] >> 8) & 7); return;
        case REG.BB: this.e[REG.BB] = x & 0o76007; this.e[REG.FB] = x & 0o76000; this.e[REG.EB] = (x & 7) << 8; return;
        case REG.Z: this.e[REG.Z] = x & 0o7777; return;
        default: this.e[k] = x; return;
      }
    }
    const i = this.eIndex(k);
    if (i < 0) return;
    let w = oc(x);
    if (k === REG.CYR) w = ((w >> 1) | ((w & 1) << 14)) & W15;
    else if (k === REG.SR) w = ((w >> 1) | (w & SIGN15)) & W15;
    else if (k === REG.CYL) w = ((w << 1) | ((w >> 14) & 1)) & W15;
    else if (k === REG.EDOP) w = (w >> 7) & 0o177;
    this.e[i] = w;
  }
  /** Write a word back as read (an instruction that reads K rewrites it: an editing register edits its value again). */
  private rewrite(k: number, x: number): void { if ((k & 0o7777) >= REG.CYR && (k & 0o7777) <= REG.EDOP) this.write16(k, x); }

  // ---- execution --------------------------------------------------------------------------------

  /** Execute one instruction. */
  step(): AgcStep {
    const z = this.z;
    let base = this.fetched ?? this.read16(z);
    this.fetched = null;
    if (this.index) base = add16(base, this.index);
    const word = oc(base);
    this.index = 0;
    const extra = this.extra;
    this.extra = false;
    this.z = z + 1;
    const r = extra ? this.extracode(word) : this.basic(word);
    this.mct += r.mct;
    this.steps++;
    return { z, word, extra, name: r.name, mct: r.mct };
  }

  private basic(w: number): { name: string; mct: number } {
    const op = (w >> 12) & 7, qc = (w >> 10) & 3, k12 = w & 0o7777, k10 = w & 0o1777;
    switch (op) {
      case 0:
        if (k12 === 3) { this.inhint = false; return { name: 'RELINT', mct: 1 }; }
        if (k12 === 4) { this.inhint = true; return { name: 'INHINT', mct: 1 }; }
        if (k12 === 6) { this.extra = true; return { name: 'EXTEND', mct: 1 }; }
        if (k12 === REG.Q) this.fetched = this.q;
        this.e[REG.Q] = this.z;
        this.z = k12;
        return { name: 'TC', mct: 1 };
      case 1:
        if (qc === 0) return this.ccs(k10);
        this.z = k12;
        return { name: 'TCF', mct: 1 };
      case 2:
        if (qc === 0) return this.das(k10 - 1);
        if (qc === 1) { const t = this.read16(k10); this.write16(k10, this.l); this.e[REG.L] = t; return { name: 'LXCH', mct: 2 }; }
        if (qc === 2) { this.write16(k10, add16(this.read16(k10), PLUS1)); return { name: 'INCR', mct: 2 }; }
        { const s = add16(this.a, this.read16(k10)); this.e[REG.A] = s; this.write16(k10, s); return { name: 'ADS', mct: 2 }; }
      case 3: { const v = this.read16(k12); this.e[REG.A] = v; this.rewrite(k12, v); return { name: 'CA', mct: 2 }; }
      case 4: { const v = this.read16(k12); this.e[REG.A] = neg16(v); this.rewrite(k12, v); return { name: 'CS', mct: 2 }; }
      case 5:
        if (qc === 0) {
          if (k10 === 0o17) throw new Error('RESUME: interrupts are not modelled');
          this.index = this.read16(k10);
          return { name: 'INDEX', mct: 2 };
        }
        if (qc === 1) return this.dxch(k10 - 1);
        if (qc === 2) return this.ts(k10);
        { const t = this.read16(k10); this.write16(k10, this.a); this.e[REG.A] = t; return { name: 'XCH', mct: 2 }; }
      case 6: { const v = this.read16(k12); this.e[REG.A] = add16(this.a, v); this.rewrite(k12, v); return { name: 'AD', mct: 2 }; }
      default: {
        // MASK: 16 bits with a central register, else A overflow-corrected, ANDed, sign-extended
        this.e[REG.A] = k12 < REG16 ? this.a & this.read16(k12) : sx(oc(this.a) & this.read15(k12));
        return { name: 'MASK', mct: 2 };
      }
    }
  }

  private extracode(w: number): { name: string; mct: number } {
    const op = (w >> 12) & 7, qc = (w >> 10) & 3, k12 = w & 0o7777, k10 = w & 0o1777;
    switch (op) {
      case 0: throw new Error('I/O channel instructions are not modelled');
      case 1:
        if (qc === 0) return this.dv(k10);
        if (this.a === 0 || this.a === W16) { this.z = k12; return { name: 'BZF', mct: 1 }; }
        return { name: 'BZF', mct: 2 };
      case 2:
        if (qc === 0) return this.msu(k10);
        if (qc === 1) { const t = this.read16(k10); this.write16(k10, this.q); this.e[REG.Q] = t; return { name: 'QXCH', mct: 2 }; }
        if (qc === 2) { const v = this.read16(k10); this.write16(k10, add16(v, (v & SIGN16) ? MINUS1 : PLUS1)); return { name: 'AUG', mct: 2 }; }
        {
          const v = this.read16(k10);
          if (v !== 0 && v !== W16) this.write16(k10, add16(v, (v & SIGN16) ? PLUS1 : MINUS1));
          return { name: 'DIM', mct: 2 };
        }
      case 3: { const k = k12 - 1; const lo = this.read16(k + 1); this.e[REG.L] = lo; const hi = this.read16(k); this.e[REG.A] = hi; this.rewrite(k + 1, lo); this.rewrite(k, hi); return { name: 'DCA', mct: 3 }; }
      case 4: { const k = k12 - 1; const lo = this.read16(k + 1); this.e[REG.L] = neg16(lo); const hi = this.read16(k); this.e[REG.A] = neg16(hi); this.rewrite(k + 1, lo); this.rewrite(k, hi); return { name: 'DCS', mct: 3 }; }
      case 5: this.index = this.read16(k12); this.extra = true; return { name: 'INDEX', mct: 2 };
      case 6:
        if (qc === 0) { const v = this.read16(k10); this.e[REG.A] = add16(this.a, neg16(v)); this.rewrite(k10, v); return { name: 'SU', mct: 2 }; }
        if (this.a === 0 || this.a === W16 || (this.a & SIGN16)) { this.z = k12; return { name: 'BZMF', mct: 1 }; }
        return { name: 'BZMF', mct: 2 };
      default: return this.mp(k12);
    }
  }

  private ccs(k: number): { name: string; mct: number } {
    const w = this.read15(k);
    const mag = (w & SIGN15) ? ~w & W15 : w;
    this.e[REG.A] = mag > 1 ? mag - 1 : 0;
    this.rewrite(k, this.read16(k));
    const skip = w === 0 ? 1 : w === W15 ? 3 : (w & SIGN15) ? 2 : 0;
    this.z = this.z + skip;
    return { name: 'CCS', mct: 2 };
  }

  private ts(k: number): { name: string; mct: number } {
    const a = this.a, o = ovf(a);
    if (k === REG.A) return { name: 'TS', mct: 2 };
    this.write16(k, a);
    if (o) { this.e[REG.A] = o > 0 ? PLUS1 : MINUS1; this.z = this.z + 1; }
    return { name: 'TS', mct: 2 };
  }

  private dxch(k: number): { name: string; mct: number } {
    const lo = this.read16(k + 1); this.write16(k + 1, this.l); this.e[REG.L] = lo;
    const hi = this.read16(k); this.write16(k, this.a); this.e[REG.A] = hi;
    return { name: 'DXCH', mct: 3 };
  }

  /** DAS: (K, K+1) += (A, L); a carry out of the low word goes into the high one; then L = +0 and A = the overflow (±1 or +0). */
  private das(k: number): { name: string; mct: number } {
    let lo = add16(this.l, this.read16(k + 1));
    const carry = ovf(lo);
    let hi = add16(this.a, this.read16(k));
    if (carry) hi = add16(hi, carry > 0 ? PLUS1 : MINUS1);
    lo = sx(oc(lo));
    if (k === REG.A) { this.e[REG.L] = lo; this.e[REG.A] = hi; return { name: 'DDOUBL', mct: 3 }; }
    this.write16(k + 1, lo);
    this.write16(k, hi);
    const o = ovf(hi);
    this.e[REG.L] = 0;
    this.e[REG.A] = o > 0 ? PLUS1 : o < 0 ? MINUS1 : 0;
    return { name: 'DAS', mct: 3 };
  }

  /** MSU: A − K as 15-bit two's-complement numbers, the difference converted to one's complement. */
  private msu(k: number): { name: string; mct: number } {
    const v = this.read16(k);
    let d = (oc(this.a) - (v & W15)) & W15;
    if (d & SIGN15) d = (d - 1) & W15;
    this.e[REG.A] = sx(d);
    this.rewrite(k, v);
    return { name: 'MSU', mct: 2 };
  }

  /** MP: the double-precision product of A (overflow-corrected) and K into A, L. */
  private mp(k: number): { name: string; mct: number } {
    const a = oc(this.a), b = this.read15(k);
    const na = (a & SIGN15) !== 0, nb = (b & SIGN15) !== 0;
    const ma = na ? ~a & W15 : a, mb = nb ? ~b & W15 : b;
    const p = ma * mb;
    // a zero product is +0 unless A was ±0 and K a nonzero number of the other sign (the manual's rule)
    const neg = p === 0 ? (ma === 0 && mb !== 0 && na !== nb) : na !== nb;
    let hi = Math.floor(p / 0o40000), lo = p % 0o40000;
    if (neg) { hi = ~hi & W15; lo = ~lo & W15; }
    this.e[REG.A] = sx(hi);
    this.e[REG.L] = sx(lo);
    return { name: k === REG.A ? 'SQUARE' : 'MP', mct: 3 };
  }

  /**
   * DV: (A, L) / K: the quotient into A, the remainder into L. The dividend's sign is A's, or L's when A is ±0; the
   * quotient is negative when the signs differ, the remainder takes the dividend's sign. Only |dividend| < |K| has a
   * defined result (the hardware gives garbage otherwise).
   */
  private dv(k: number): { name: string; mct: number } {
    const a = oc(this.a), l = oc(this.l), d = this.read15(k);
    const aZero = a === 0 || a === W15;
    const negD = aZero ? (l & SIGN15) !== 0 : (a & SIGN15) !== 0;
    const mag = (w: number) => ((w & SIGN15) ? ~w & W15 : w);
    const sgn = (w: number) => ((w & SIGN15) ? -1 : 1);
    const num = mag(a) * 0o40000 * (aZero ? 0 : sgn(a) * (negD ? -1 : 1)) + mag(l) * sgn(l) * (negD ? -1 : 1);
    const den = mag(d);
    const negK = (d & SIGN15) !== 0;
    const q = den ? Math.floor(num / den) : 0, r = den ? num - q * den : 0;
    const qw = negD !== negK ? ~q & W15 : q & W15;
    const rw = negD ? ~r & W15 : r & W15;
    this.e[REG.A] = sx(qw);
    this.e[REG.L] = sx(rw);
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
