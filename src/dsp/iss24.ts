// DSP24's golden model: one instruction per step, which the hardware takes one clock for. Registers r0–r7 (16 bits),
// pointers p0–p3 (X) and p4–p7 (Y) with the address generators' base, length and modifier, a 40-bit accumulator, a loop
// unit one level deep, and the X and Y memories of 256 words. Halts on `halt` (the PC stays).

import { accAfter, MAC_F3, raccOf } from './mac';
import { decode24, MEM24_WORDS, ROM24_WORDS } from './isa24';

export const s16 = (v: number): number => ((v & 0xffff) ^ 0x8000) - 0x8000;
export const s8 = (v: number): number => ((v & 0xff) ^ 0x80) - 0x80;
export const sat16 = (v: number): number => Math.max(-32768, Math.min(32767, v));

/** The accumulator to 16 bits, as the MAC block reads it (dsp/mac.ts raccOf: shift, add the first dropped bit back, clamp 32) and a clamp to 16 after it. */
export const rndOf = (acc: bigint, sh: number): number => sat16(raccOf(acc, sh).y);

export function rev8(v: number): number {
  let r = 0;
  for (let i = 0; i < 8; i++) if (v & (1 << i)) r |= 0x80 >> i;
  return r;
}

/**
 * The address generator's update of one pointer after an access, all arithmetic modulo 256. mode: 0 unchanged, 1 +1, 2 −1,
 * 3 +m, 4 +1 circular, 5 −1 circular, 6 bit-reversed (reverse-carry add of m), 7 −m. The circular modes wrap at the window's
 * edges, by equality: +1 from base + len − 1 goes to base, and −1 from base goes to base + len − 1. A pointer outside its
 * window just steps. The reverse-carry add is rev(rev(p) + rev(m)), which counts a 2^k-point bit-reversed order for m = 2^(k−1).
 */
export function aguStep(p: number, mode: number, base: number, len: number, m: number): number {
  const end = (base + len) & 255;
  switch (mode) {
    case 0: return p;
    case 1: return (p + 1) & 255;
    case 2: return (p - 1) & 255;
    case 3: return (p + m) & 255;
    case 4: return ((p + 1) & 255) === end ? base : (p + 1) & 255;
    case 5: return p === base ? (end - 1) & 255 : (p - 1) & 255;
    case 6: return rev8((rev8(p) + rev8(m)) & 255);
    default: return (p - m) & 255;
  }
}

export interface Step24 {
  pc: number;
  instr: number;
  name: string;
  /** A store: which memory, address, value. */
  store?: { bus: 0 | 1; addr: number; value: number };
  /** `out`: the word sent. */
  out?: number;
  /** The loop went back to its start. */
  looped?: boolean;
}

export interface Iss24State {
  pc: number; steps: number; halted: boolean; acc: bigint;
  r: number[]; p: number[]; xb: number; xl: number; xm: number; yb: number; yl: number; ym: number;
  ls: number; le: number; lc: number; la: number;
  x: number[]; y: number[]; out: number[];
}

export class Iss24 {
  pc = 0;
  steps = 0;
  halted = false;
  acc = 0n;
  r = new Uint16Array(8);
  p = new Uint8Array(8);
  /** Address generator registers: base, length, modifier, per memory. */
  xb = 0; xl = 0; xm = 0; yb = 0; yl = 0; ym = 0;
  /** Loop unit: start, end, count, active. */
  ls = 0; le = 0; lc = 0; la = 0;
  readonly x = new Uint16Array(MEM24_WORDS);
  readonly y = new Uint16Array(MEM24_WORDS);
  out: number[] = [];
  readonly rom: Uint32Array;

  constructor(program: ArrayLike<number>, x: ArrayLike<number> = [], y: ArrayLike<number> = []) {
    this.rom = new Uint32Array(ROM24_WORDS);
    for (let i = 0; i < Math.min(ROM24_WORDS, program.length); i++) this.rom[i] = program[i] & 0xffffff;
    for (let i = 0; i < Math.min(MEM24_WORDS, x.length); i++) this.x[i] = x[i] & 0xffff;
    for (let i = 0; i < Math.min(MEM24_WORDS, y.length); i++) this.y[i] = y[i] & 0xffff;
  }

  /** A unified register (0–7 r, 8–15 p, 16–18 xb xl xm, 20–22 yb yl ym; the others read 0) as the instructions read it. */
  getReg(n: number): number {
    if (n < 8) return this.r[n];
    if (n < 16) return this.p[n - 8];
    return n === 16 ? this.xb : n === 17 ? this.xl : n === 18 ? this.xm : n === 20 ? this.yb : n === 21 ? this.yl : n === 22 ? this.ym : 0;
  }
  setReg(n: number, v: number): void {
    if (n < 8) this.r[n] = v & 0xffff;
    else if (n < 16) this.p[n - 8] = v & 255;
    else if (n === 16) this.xb = v & 255;
    else if (n === 17) this.xl = v & 255;
    else if (n === 18) this.xm = v & 255;
    else if (n === 20) this.yb = v & 255;
    else if (n === 21) this.yl = v & 255;
    else if (n === 22) this.ym = v & 255;
  }

  private upd(bus: 0 | 1, i: number, mode: number): void {
    const k = bus * 4 + i;
    this.p[k] = this.stepPtr(this.p[k], mode, bus ? this.yb : this.xb, bus ? this.yl : this.xl, bus ? this.ym : this.xm);
  }

  // The places tests break on purpose (tests/dsp-core-mutants.test.ts): a subclass overrides one, and the lock-step with the gates must notice.
  protected stepPtr(p: number, mode: number, base: number, len: number, m: number): number { return aguStep(p, mode, base, len, m); }
  protected readAcc(acc: bigint, sh: number): number { return rndOf(acc, sh); }
  protected lastPass(lc: number): boolean { return lc === 1; }
  protected macAcc(acc: bigint, x: number, y: number): bigint { return accAfter(acc, MAC_F3.mac, x, y); }
  protected satAdd(v: number): number { return sat16(v); }

  step(): Step24 {
    const pc = this.pc, w = this.rom[pc];
    const d = decode24(w);
    const st: Step24 = { pc, instr: w, name: d.name };
    if (this.halted) return st;
    const r = this.r;
    const a = r[d.ra], b = r[d.rb];
    const xa = this.p[d.xp], ya = this.p[4 + d.yp];
    let next = (pc + 1) & 255;
    let jump: number | null = null;
    let isLoop = false;
    const alu = (v: number) => { r[d.rd] = v & 0xffff; };
    switch (d.name) {
      case 'halt': this.halted = true; this.steps++; return st;
      case 'mov': this.setReg(d.dst, this.getReg(d.src)); break;
      case 'ldi': this.setReg(d.dst, d.imm14 & 0x2000 ? d.imm14 - 0x4000 : d.imm14); break;
      case 'ldh': r[d.rd] = (d.imm8 << 8) | (a & 255); break;
      case 'addi': alu(a + s8(d.imm8)); break;
      case 'add': alu(a + b); break;
      case 'sub': alu(a - b); break;
      case 'adds': alu(this.satAdd(s16(a) + s16(b))); break;
      case 'subs': alu(this.satAdd(s16(a) - s16(b))); break;
      case 'and': alu(a & b); break;
      case 'or': alu(a | b); break;
      case 'xor': alu(a ^ b); break;
      case 'shl': alu(a << (b & 15)); break;
      case 'shr': alu(a >> (b & 15)); break;
      case 'sar': alu(s16(a) >> (b & 15)); break;
      case 'ld': {
        const bus = d.bus ? 1 : 0, i = d.xp, ad = this.p[bus * 4 + i];
        r[d.rd] = (bus ? this.y : this.x)[ad];
        this.upd(bus as 0 | 1, i, d.xmode);
        break;
      }
      case 'st': {
        const bus = d.bus ? 1 : 0, i = d.xp, ad = this.p[bus * 4 + i];
        (bus ? this.y : this.x)[ad] = a;
        st.store = { bus: bus as 0 | 1, addr: ad, value: a };
        this.upd(bus as 0 | 1, i, d.xmode);
        break;
      }
      case 'clr': this.acc = 0n; break;
      case 'mac':
        this.acc = this.macAcc(this.acc, this.x[xa], this.y[ya]);
        this.upd(0, d.xp, d.xmode);
        this.upd(1, d.yp, d.ymode);
        break;
      case 'rnd': case 'rndc':
        r[d.rd] = this.readAcc(this.acc, d.sh) & 0xffff;
        if (d.name === 'rndc') this.acc = 0n;
        break;
      case 'out': this.out.push(a); st.out = a; break;
      case 'loop':
        isLoop = true;
        this.ls = (pc + 1) & 255;
        this.le = d.addr;
        this.lc = d.loopReg ? a : d.cnt;
        this.la = 1;
        break;
      case 'jmp': jump = d.addr; break;
      case 'jz': if (a === 0) jump = d.addr; break;
      case 'jnz': if (a !== 0) jump = d.addr; break;
    }
    if (jump !== null) next = jump;
    if (!isLoop && this.la && pc === this.le) {
      if (!this.lastPass(this.lc)) { next = this.ls; st.looped = true; } else this.la = 0;
      this.lc = (this.lc - 1) & 0xffff;
    }
    if (!this.halted) this.pc = next;
    this.steps++;
    return st;
  }

  /** Step until halted or `max` steps; returns the steps taken. */
  run(max = 1_000_000): number {
    const s0 = this.steps;
    while (!this.halted && this.steps - s0 < max) this.step();
    return this.steps - s0;
  }

  save(): Iss24State {
    return {
      pc: this.pc, steps: this.steps, halted: this.halted, acc: this.acc, r: [...this.r], p: [...this.p],
      xb: this.xb, xl: this.xl, xm: this.xm, yb: this.yb, yl: this.yl, ym: this.ym,
      ls: this.ls, le: this.le, lc: this.lc, la: this.la, x: [...this.x], y: [...this.y], out: [...this.out],
    };
  }
  restore(s: Iss24State): void {
    Object.assign(this, { pc: s.pc, steps: s.steps, halted: s.halted, acc: s.acc, xb: s.xb, xl: s.xl, xm: s.xm, yb: s.yb, yl: s.yl, ym: s.ym, ls: s.ls, le: s.le, lc: s.lc, la: s.la, out: [...s.out] });
    this.r.set(s.r); this.p.set(s.p); this.x.set(s.x); this.y.set(s.y);
  }
}
