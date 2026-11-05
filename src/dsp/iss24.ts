// DSP24's golden model: one instruction per step, which the hardware takes one clock for. Registers r0–r7 (16 bits),
// pointers p0–p3 (X) and p4–p7 (Y) with the address generators' base, length and modifier, a 40-bit accumulator, a loop
// unit one level deep, and the X and Y memories of 256 words. Halts on `halt` (the PC stays).

import { decode24, MEM24_WORDS, ROM24_WORDS, UREGS24 } from './isa24';

export const ACC_BITS = 40;
const ACC_MOD = 2 ** ACC_BITS, ACC_HALF = 2 ** (ACC_BITS - 1);
/** The 40-bit accumulator wraps (two's complement). */
export const wrap40 = (v: number): number => ((((v + ACC_HALF) % ACC_MOD) + ACC_MOD) % ACC_MOD) - ACC_HALF;
export const s16 = (v: number): number => ((v & 0xffff) ^ 0x8000) - 0x8000;
export const s8 = (v: number): number => ((v & 0xff) ^ 0x80) - 0x80;
export const sat16 = (v: number): number => Math.max(-32768, Math.min(32767, v));

/** The accumulator to 16 bits: shift right by sh with the first dropped bit added back (round half up), then saturate. */
export function rndOf(acc: number, sh: number): number {
  const v = (BigInt(acc) + (sh > 0 ? 1n << BigInt(sh - 1) : 0n)) >> BigInt(sh);
  return v > 32767n ? 32767 : v < -32768n ? -32768 : Number(v);
}

export function rev8(v: number): number {
  let r = 0;
  for (let i = 0; i < 8; i++) if (v & (1 << i)) r |= 0x80 >> i;
  return r;
}

/**
 * The address generator's update of one pointer after an access. mode: 0 unchanged, 1 +1, 2 −1, 3 +m, 4 +1 circular,
 * 5 −1 circular, 6 bit-reversed (reverse-carry add of m), 7 +m circular. A circular step that leaves the window
 * [base, base + len) comes back by len, once (so |step| ≤ len). m is signed except in mode 6, where the 8 bits are the
 * reverse-carry modifier: rev(rev(p) + rev(m)), which counts a 2^k-point bit-reversed order for m = 2^(k−1).
 */
export function aguStep(p: number, mode: number, base: number, len: number, m: number): number {
  if (mode === 0) return p;
  if (mode === 6) return rev8((rev8(p) + rev8(m)) & 255);
  const step = mode === 1 || mode === 4 ? 1 : mode === 2 || mode === 5 ? -1 : s8(m);
  let t = p + step;
  if (mode >= 4 && mode !== 6) {
    if (step >= 0 && t >= base + len) t -= len;
    else if (step < 0 && t < base) t += len;
  }
  return t & 255;
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
  pc: number; steps: number; halted: boolean; acc: number;
  r: number[]; p: number[]; xb: number; xl: number; xm: number; yb: number; yl: number; ym: number;
  ls: number; le: number; lc: number; la: number;
  x: number[]; y: number[]; out: number[];
}

export class Iss24 {
  pc = 0;
  steps = 0;
  halted = false;
  acc = 0;
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

  /** A unified register (0–7 r, 8–15 p, 16–21 xb xl xm yb yl ym) as the instructions read it. */
  getReg(n: number): number {
    if (n < 8) return this.r[n];
    if (n < 16) return this.p[n - 8];
    return [this.xb, this.xl, this.xm, this.yb, this.yl, this.ym][n - 16] ?? 0;
  }
  setReg(n: number, v: number): void {
    if (n < 8) this.r[n] = v & 0xffff;
    else if (n < 16) this.p[n - 8] = v & 255;
    else if (n < UREGS24) {
      const k = (['xb', 'xl', 'xm', 'yb', 'yl', 'ym'] as const)[n - 16];
      this[k] = v & 255;
    }
  }

  private upd(bus: 0 | 1, i: number, mode: number): void {
    const k = bus * 4 + i;
    this.p[k] = aguStep(this.p[k], mode, bus ? this.yb : this.xb, bus ? this.yl : this.xl, bus ? this.ym : this.xm);
  }

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
      case 'halt': this.halted = true; break;
      case 'mov': this.setReg(d.dst, this.getReg(d.src)); break;
      case 'ldi': this.setReg(d.dst, d.imm14 & 0x2000 ? d.imm14 - 0x4000 : d.imm14); break;
      case 'ldh': r[d.rd] = (d.imm8 << 8) | (r[d.rd] & 255); break;
      case 'addi': alu(a + s8(d.imm8)); break;
      case 'add': alu(a + b); break;
      case 'sub': alu(a - b); break;
      case 'adds': alu(sat16(s16(a) + s16(b))); break;
      case 'subs': alu(sat16(s16(a) - s16(b))); break;
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
      case 'ld2': {
        const xv = this.x[xa], yv = this.y[ya];
        r[d.rd] = xv;
        r[d.ra] = yv;
        this.upd(0, d.xp, d.xmode);
        this.upd(1, d.yp, d.ymode);
        break;
      }
      case 'clr': this.acc = 0; break;
      case 'mac': {
        this.acc = wrap40(this.acc + s16(this.x[xa]) * s16(this.y[ya]));
        this.upd(0, d.xp, d.xmode);
        this.upd(1, d.yp, d.ymode);
        break;
      }
      case 'rnd': case 'rndc':
        r[d.rd] = rndOf(this.acc, d.sh) & 0xffff;
        if (d.name === 'rndc') this.acc = 0;
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
      if (this.lc !== 1) { next = this.ls; st.looped = true; } else this.la = 0;
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
