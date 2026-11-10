// The vector extension's golden model: the Zve32x subset (ELEN 32, integer only) that the Vectors chapter and its
// vector unit implement, exactly as RVV 1.0 specifies it. DOM-free; the ISS calls it for every vector word when
// IssOptions.v is set (ISS({ v: { vlen } })), and Spike checks it (tests/verify/spike.ts, config 'zve').
//
// State (fields of the ISS, so save() / restore() carry it): vregs (32 registers of VLEN bits, bytes, little-endian),
// vl, vtype. vstart is always 0: no instruction here stops part-way (no traps in the middle of a vector).
//
// Rules taken as the spec gives them:
// - vsetvl{i}: VLMAX = LMUL · VLEN / SEW; vl = min(AVL, VLMAX) (as Spike: the spec also allows ⌈AVL / 2⌉ … when
//   AVL < 2·VLMAX, which nothing here relies on); rs1 = x0 and rd ≠ x0: vl = VLMAX; rs1 = rd = x0: vl kept (capped).
//   An unsupported vtype sets vill (vtype = 1 << 31) and vl = 0: SEW above ELEN, LMUL 1/8 or reserved, SEW above
//   LMUL · ELEN for a fraction, any reserved bit.
// - Tail and masked-off elements are left undisturbed whatever ta / ma say: agnostic allows it, and it is what
//   Spike does, so the two agree on every byte.
// - Illegal (the ISS traps in system mode, does nothing otherwise): any vector instruction but vset* while vill is set,
//   a register group not aligned to its LMUL (EMUL for loads and stores), EMUL out of 1/8 … 8, a masked instruction
//   writing v0 (not a mask result), vmerge / vmv.v with vm = 0 forms that do not exist, unknown encodings.
// - Mask registers: element i's bit is bit i of the register (v0 for v0.t); compares write bits 0 … vl − 1 only.

export const V_OPCODE = 0x57, V_LOAD = 0x07, V_STORE = 0x27;
export const ELEN = 32;
export const VCSR = { vstart: 0x008, vxsat: 0x009, vxrm: 0x00a, vcsr: 0x00f, vl: 0xc20, vtype: 0xc21, vlenb: 0xc22 } as const;
export const VILL = 0x80000000;

/** The ISS's vector state and what an instruction may touch. */
export interface VContext {
  readonly vlenb: number;
  vregs: Uint8Array;
  vl: number;
  vtype: number;
  readonly x: Uint32Array;
  /** A data-memory access of 1, 2 or 4 bytes (aligned; the ISS's own load / store). */
  load(addr: number, bytes: 1 | 2 | 4): number;
  store(addr: number, bytes: 1 | 2 | 4, v: number): void;
}

export interface VResult {
  /** Scalar register written (vset*, vmv.x.s). */
  rd?: number;
  value?: number;
  /** The vector registers written, first and count (a group, or one mask register). */
  vwrite?: { vd: number; regs: number };
  /** Element addresses read (loads), in element order. */
  loads?: number[];
  /** Element stores, in element order. */
  stores?: { addr: number; value: number; bytes: 1 | 2 | 4 }[];
  /** The instruction is illegal: nothing changed. */
  illegal?: boolean;
}

// ---- vtype ----

export const SEWS = [8, 16, 32] as const;
/** vlmul field → LMUL (fractions as numbers); 4 (100) is reserved. */
const LMULS: Record<number, number> = { 0: 1, 1: 2, 2: 4, 3: 8, 5: 1 / 8, 6: 1 / 4, 7: 1 / 2 };
const LMUL_TEXT: Record<number, string> = { 0: 'm1', 1: 'm2', 2: 'm4', 3: 'm8', 5: 'mf8', 6: 'mf4', 7: 'mf2' };

export interface VType { sew: number; lmul: number; ta: boolean; ma: boolean }

/** A vtype value's fields, or null when it is not one we support (vill). */
export function vtypeOf(v: number, vlenb = 16): VType | null {
  if ((v >>> 0) & ~0xff) return null;
  const vsew = (v >> 3) & 7, vlmul = v & 7;
  const lmul = LMULS[vlmul];
  if (vsew > 2 || lmul === undefined) return null;
  const sew = 8 << vsew;
  if (sew > Math.min(lmul, 1) * ELEN) return null;
  if (lmul * vlenb * 8 < sew) return null;
  return { sew, lmul, ta: !!(v & 0x40), ma: !!(v & 0x80) };
}

export const vlmaxOf = (t: VType, vlenb: number) => Math.floor((t.lmul * vlenb * 8) / t.sew);

/** "e32, m4, ta, mu" ↔ a vtype immediate. */
export function vtypeText(v: number): string {
  if ((v >>> 0) & ~0xff || ((v >> 3) & 7) > 3 || !LMUL_TEXT[v & 7]) return `0x${(v >>> 0).toString(16)}`;
  return `e${8 << ((v >> 3) & 7)}, ${LMUL_TEXT[v & 7]}, ${v & 0x40 ? 'ta' : 'tu'}, ${v & 0x80 ? 'ma' : 'mu'}`;
}

export function parseVtype(parts: string[]): number {
  let v = 0, sew = -1, lmul = 0, ta = 0, ma = 0;
  for (const p0 of parts) {
    const p = p0.trim().toLowerCase();
    let m: RegExpExecArray | null;
    if ((m = /^e(8|16|32|64)$/.exec(p))) sew = Math.log2(+m[1] / 8);
    else if ((m = /^m(1|2|4|8)$/.exec(p))) lmul = Math.log2(+m[1]);
    else if ((m = /^mf(2|4|8)$/.exec(p))) lmul = 8 - Math.log2(+m[1]);
    else if (p === 'ta') ta = 1;
    else if (p === 'tu') ta = 0;
    else if (p === 'ma') ma = 1;
    else if (p === 'mu') ma = 0;
    else throw new Error(`not a vtype field: "${p0.trim()}" (e8 / e16 / e32, m1 … m8 or mf2 … mf8, ta / tu, ma / mu)`);
  }
  if (sew < 0) throw new Error('the vtype needs an element width: e8, e16 or e32');
  v = (ma << 7) | (ta << 6) | (sew << 3) | lmul;
  return v;
}

// ---- the instructions ----

/** funct3 of OP-V: the operand categories. */
export const F3 = { IVV: 0, MVV: 2, IVI: 3, IVX: 4, MVX: 6, CFG: 7 } as const;

type Form = 'vv' | 'vx' | 'vi';
interface IOp { f6: number; forms: Form[]; mask?: boolean; uimm?: boolean }
/** The OPI instructions (integer, funct3 IVV / IVX / IVI) by mnemonic stem. */
export const OPI: Record<string, IOp> = {
  vadd: { f6: 0x00, forms: ['vv', 'vx', 'vi'] },
  vsub: { f6: 0x02, forms: ['vv', 'vx'] },
  vrsub: { f6: 0x03, forms: ['vx', 'vi'] },
  vminu: { f6: 0x04, forms: ['vv', 'vx'] },
  vmin: { f6: 0x05, forms: ['vv', 'vx'] },
  vmaxu: { f6: 0x06, forms: ['vv', 'vx'] },
  vmax: { f6: 0x07, forms: ['vv', 'vx'] },
  vand: { f6: 0x09, forms: ['vv', 'vx', 'vi'] },
  vor: { f6: 0x0a, forms: ['vv', 'vx', 'vi'] },
  vxor: { f6: 0x0b, forms: ['vv', 'vx', 'vi'] },
  vmseq: { f6: 0x18, forms: ['vv', 'vx', 'vi'], mask: true },
  vmsne: { f6: 0x19, forms: ['vv', 'vx', 'vi'], mask: true },
  vmsltu: { f6: 0x1a, forms: ['vv', 'vx'], mask: true },
  vmslt: { f6: 0x1b, forms: ['vv', 'vx'], mask: true },
  vmsleu: { f6: 0x1c, forms: ['vv', 'vx', 'vi'], mask: true },
  vmsle: { f6: 0x1d, forms: ['vv', 'vx', 'vi'], mask: true },
  vmsgtu: { f6: 0x1e, forms: ['vx', 'vi'], mask: true },
  vmsgt: { f6: 0x1f, forms: ['vx', 'vi'], mask: true },
  vsll: { f6: 0x25, forms: ['vv', 'vx', 'vi'], uimm: true },
  vsrl: { f6: 0x28, forms: ['vv', 'vx', 'vi'], uimm: true },
  vsra: { f6: 0x29, forms: ['vv', 'vx', 'vi'], uimm: true },
};
const OPI_BY_F6 = new Map(Object.entries(OPI).map(([n, o]) => [o.f6, n]));
const F3_OF: Record<Form, number> = { vv: F3.IVV, vx: F3.IVX, vi: F3.IVI };
const FORM_OF: Record<number, Form> = { [F3.IVV]: 'vv', [F3.IVX]: 'vx', [F3.IVI]: 'vi' };
const MERGE_F6 = 0x17, REDSUM_F6 = 0x00, MUL_F6 = 0x25, WXUNARY_F6 = 0x10, MUNARY_F6 = 0x14, VID_VS1 = 0x11;
/** Load / store widths: the width field ↔ EEW (bits). */
const WIDTHS: Record<number, number> = { 0: 8, 5: 16, 6: 32 };
const WIDTH_FIELD: Record<number, number> = { 8: 0, 16: 5, 32: 6 };

export type VKind =
  | { k: 'vsetvli'; rd: number; rs1: number; zimm: number }
  | { k: 'vsetivli'; rd: number; uimm: number; zimm: number }
  | { k: 'vsetvl'; rd: number; rs1: number; rs2: number }
  | { k: 'opi'; name: string; form: Form; vd: number; vs2: number; src: number; vm: boolean }
  | { k: 'merge'; form: Form; vd: number; vs2: number; src: number; vm: boolean }
  | { k: 'redsum'; vd: number; vs2: number; vs1: number; vm: boolean }
  | { k: 'mul'; form: 'vv' | 'vx'; vd: number; vs2: number; src: number; vm: boolean }
  | { k: 'mvxs'; rd: number; vs2: number }
  | { k: 'mvsx'; vd: number; rs1: number }
  | { k: 'vid'; vd: number; vm: boolean }
  | { k: 'mem'; store: boolean; eew: number; strided: boolean; v: number; rs1: number; rs2: number; vm: boolean };

const bits = (w: number, hi: number, lo: number) => (w >>> lo) & ((1 << (hi - lo + 1)) - 1);
const simm5 = (v: number) => (v & 0x10 ? v - 32 : v);

/** A vector word's instruction, or null when it is not one of ours (any other word, or an encoding we leave out). */
export function decodeV(w: number): VKind | null {
  w >>>= 0;
  const op = w & 0x7f, f3 = bits(w, 14, 12), vd = bits(w, 11, 7), rs1 = bits(w, 19, 15), vs2 = bits(w, 24, 20), vm = !!bits(w, 25, 25), f6 = bits(w, 31, 26);
  if (op === V_LOAD || op === V_STORE) {
    const eew = WIDTHS[f3];
    if (eew === undefined || bits(w, 31, 28) !== 0) return null; // nf, mew: segment and 128-bit forms are not ours
    const mop = bits(w, 27, 26);
    if (mop === 0 && vs2 === 0) return { k: 'mem', store: op === V_STORE, eew, strided: false, v: vd, rs1, rs2: 0, vm: !vm };
    if (mop === 2) return { k: 'mem', store: op === V_STORE, eew, strided: true, v: vd, rs1, rs2: vs2, vm: !vm };
    return null;
  }
  if (op !== V_OPCODE) return null;
  const masked = !vm;
  switch (f3) {
    case F3.CFG:
      if (!(w >>> 31)) return { k: 'vsetvli', rd: vd, rs1, zimm: bits(w, 30, 20) };
      if (bits(w, 31, 30) === 3) return { k: 'vsetivli', rd: vd, uimm: rs1, zimm: bits(w, 29, 20) };
      if (bits(w, 31, 25) === 0x40) return { k: 'vsetvl', rd: vd, rs1, rs2: vs2 };
      return null;
    case F3.IVV: case F3.IVX: case F3.IVI: {
      const form = FORM_OF[f3];
      if (f6 === MERGE_F6) {
        if (!masked && vs2 !== 0) return null; // vmv.v.* has vs2 = 0
        return { k: 'merge', form, vd, vs2, src: rs1, vm: masked };
      }
      const name = OPI_BY_F6.get(f6);
      if (!name || !OPI[name].forms.includes(form)) return null;
      return { k: 'opi', name, form, vd, vs2, src: rs1, vm: masked };
    }
    case F3.MVV:
      if (f6 === REDSUM_F6) return { k: 'redsum', vd, vs2, vs1: rs1, vm: masked };
      if (f6 === MUL_F6) return { k: 'mul', form: 'vv', vd, vs2, src: rs1, vm: masked };
      if (f6 === WXUNARY_F6 && rs1 === 0 && !masked) return { k: 'mvxs', rd: vd, vs2 };
      if (f6 === MUNARY_F6 && rs1 === VID_VS1 && vs2 === 0) return { k: 'vid', vd, vm: masked };
      return null;
    case F3.MVX:
      if (f6 === MUL_F6) return { k: 'mul', form: 'vx', vd, vs2, src: rs1, vm: masked };
      if (f6 === WXUNARY_F6 && vs2 === 0 && !masked) return { k: 'mvsx', vd, rs1 };
      return null;
    default:
      return null;
  }
}

/** Is it a vector word at all (OP-V, or a vector load / store width on LOAD-FP / STORE-FP)? flw / fsw are width 2. */
export const isVectorWord = (w: number) => decodeV(w) !== null;

// ---- encoding (the assembler) ----

const opv = (f6: number, vm: boolean, vs2: number, rs1: number, f3: number, vd: number) =>
  ((f6 << 26) | ((vm ? 0 : 1) << 25) | (vs2 << 20) | (rs1 << 15) | (f3 << 12) | (vd << 7) | V_OPCODE) >>> 0;

export function encodeV(k: VKind): number {
  switch (k.k) {
    case 'vsetvli': return (((k.zimm & 0x7ff) << 20) | (k.rs1 << 15) | (F3.CFG << 12) | (k.rd << 7) | V_OPCODE) >>> 0;
    case 'vsetivli': return ((3 << 30) | ((k.zimm & 0x3ff) << 20) | (k.uimm << 15) | (F3.CFG << 12) | (k.rd << 7) | V_OPCODE) >>> 0;
    case 'vsetvl': return ((0x40 << 25) | (k.rs2 << 20) | (k.rs1 << 15) | (F3.CFG << 12) | (k.rd << 7) | V_OPCODE) >>> 0;
    case 'opi': return opv(OPI[k.name].f6, k.vm, k.vs2, k.src & 31, F3_OF[k.form], k.vd);
    case 'merge': return opv(MERGE_F6, k.vm, k.vs2, k.src & 31, F3_OF[k.form], k.vd);
    case 'redsum': return opv(REDSUM_F6, k.vm, k.vs2, k.vs1, F3.MVV, k.vd);
    case 'mul': return opv(MUL_F6, k.vm, k.vs2, k.src, k.form === 'vv' ? F3.MVV : F3.MVX, k.vd);
    case 'mvxs': return opv(WXUNARY_F6, false, k.vs2, 0, F3.MVV, k.rd);
    case 'mvsx': return opv(WXUNARY_F6, false, 0, k.rs1, F3.MVX, k.vd);
    case 'vid': return opv(MUNARY_F6, k.vm, 0, VID_VS1, F3.MVV, k.vd);
    case 'mem':
      return (((k.strided ? 2 : 0) << 26) | ((k.vm ? 0 : 1) << 25) | (k.rs2 << 20) | (k.rs1 << 15) | (WIDTH_FIELD[k.eew] << 12) | (k.v << 7) | (k.store ? V_STORE : V_LOAD)) >>> 0;
  }
}

/** Every vector mnemonic the assembler takes. */
export const V_MNEMONICS: ReadonlySet<string> = new Set([
  'vsetvli', 'vsetivli', 'vsetvl', 'vredsum.vs', 'vmul.vv', 'vmul.vx', 'vmv.x.s', 'vmv.s.x', 'vid.v',
  'vmerge.vvm', 'vmerge.vxm', 'vmerge.vim', 'vmv.v.v', 'vmv.v.x', 'vmv.v.i',
  ...[8, 16, 32].flatMap((e) => [`vle${e}.v`, `vse${e}.v`, `vlse${e}.v`, `vsse${e}.v`]),
  ...Object.entries(OPI).flatMap(([n, o]) => o.forms.map((f) => `${n}.${f}`)),
]);

/** Operand readers the assembler hands in (its labels, registers and errors). */
export interface VOperands {
  reg(s: string): number;
  imm(s: string, lo: number, hi: number): number;
}

const vregOf = (s: string) => {
  const m = /^v([0-9]|[12][0-9]|3[01])$/.exec(s.trim().toLowerCase());
  if (!m) throw new Error(`not a vector register: "${s.trim()}"`);
  return +m[1];
};

/** Assemble one vector instruction (op is a V_MNEMONICS member). Throws with a message for the line. */
export function assembleV(op: string, args0: string[], o: VOperands): number {
  const args = args0.map((a) => a.trim());
  // a trailing v0.t masks it
  let vm = false;
  if (args.length && args[args.length - 1].toLowerCase() === 'v0.t') { vm = true; args.pop(); }
  const need = (n: number) => { if (args.length !== n) throw new Error(`${op} expects ${n} operand${n === 1 ? '' : 's'}${vm ? ' before v0.t' : ''}, got ${args.length}`); };
  const noMask = () => { if (vm) throw new Error(`${op} cannot be masked`); };
  if (op === 'vsetvli' || op === 'vsetivli') {
    noMask();
    if (args.length < 3) throw new Error(`${op} expects rd, ${op === 'vsetvli' ? 'rs1' : 'uimm'}, then the vtype (e32, m1, tu, mu)`);
    const zimm = parseVtype(args.slice(2));
    return op === 'vsetvli'
      ? encodeV({ k: 'vsetvli', rd: o.reg(args[0]), rs1: o.reg(args[1]), zimm })
      : encodeV({ k: 'vsetivli', rd: o.reg(args[0]), uimm: o.imm(args[1], 0, 31), zimm });
  }
  if (op === 'vsetvl') { noMask(); need(3); return encodeV({ k: 'vsetvl', rd: o.reg(args[0]), rs1: o.reg(args[1]), rs2: o.reg(args[2]) }); }
  const mem = /^v(l|s)(s?)e(8|16|32)\.v$/.exec(op);
  if (mem) {
    const strided = !!mem[2];
    need(strided ? 3 : 2);
    const m = /^\(\s*(\w+)\s*\)$/.exec(args[1]);
    if (!m) throw new Error(`expected (register), got "${args[1]}"`);
    return encodeV({ k: 'mem', store: mem[1] === 's', eew: +mem[3], strided, v: vregOf(args[0]), rs1: o.reg(m[1]), rs2: strided ? o.reg(args[2]) : 0, vm });
  }
  if (op === 'vmv.x.s') { noMask(); need(2); return encodeV({ k: 'mvxs', rd: o.reg(args[0]), vs2: vregOf(args[1]) }); }
  if (op === 'vmv.s.x') { noMask(); need(2); return encodeV({ k: 'mvsx', vd: vregOf(args[0]), rs1: o.reg(args[1]) }); }
  if (op === 'vid.v') { need(1); return encodeV({ k: 'vid', vd: vregOf(args[0]), vm }); }
  if (op === 'vredsum.vs') { need(3); return encodeV({ k: 'redsum', vd: vregOf(args[0]), vs2: vregOf(args[1]), vs1: vregOf(args[2]), vm }); }
  if (op === 'vmul.vv' || op === 'vmul.vx') {
    need(3);
    return encodeV({ k: 'mul', form: op === 'vmul.vv' ? 'vv' : 'vx', vd: vregOf(args[0]), vs2: vregOf(args[1]), src: op === 'vmul.vv' ? vregOf(args[2]) : o.reg(args[2]), vm });
  }
  const mv = /^vmv\.v\.(v|x|i)$/.exec(op);
  if (mv) {
    noMask(); need(2);
    const form = `v${mv[1]}` as Form;
    const src = form === 'vv' ? vregOf(args[1]) : form === 'vx' ? o.reg(args[1]) : o.imm(args[1], -16, 15);
    return encodeV({ k: 'merge', form, vd: vregOf(args[0]), vs2: 0, src, vm: false });
  }
  const mg = /^vmerge\.v(v|x|i)m$/.exec(op);
  if (mg) {
    if (vm) throw new Error('vmerge takes v0 as its fourth operand, not v0.t');
    need(4);
    if (args[3].toLowerCase() !== 'v0') throw new Error('vmerge selects with v0: its last operand is v0');
    const form = `v${mg[1]}` as Form;
    const src = form === 'vv' ? vregOf(args[2]) : form === 'vx' ? o.reg(args[2]) : o.imm(args[2], -16, 15);
    return encodeV({ k: 'merge', form, vd: vregOf(args[0]), vs2: vregOf(args[1]), src, vm: true });
  }
  const dot = op.lastIndexOf('.'), stem = op.slice(0, dot), form = op.slice(dot + 1) as Form;
  const spec = OPI[stem];
  if (!spec || !spec.forms.includes(form)) throw new Error(`unknown vector instruction ${op}`);
  need(3);
  const src = form === 'vv' ? vregOf(args[2]) : form === 'vx' ? o.reg(args[2]) : spec.uimm ? o.imm(args[2], 0, 31) : o.imm(args[2], -16, 15);
  return encodeV({ k: 'opi', name: stem, form, vd: vregOf(args[0]), vs2: vregOf(args[1]), src, vm });
}

// ---- disassembly ----

export function disasmV(w: number, xname: readonly string[]): string | null {
  const k = decodeV(w);
  if (!k) return null;
  const v = (r: number) => `v${r}`, x = (r: number) => xname[r];
  const m = (vm: boolean) => (vm ? ', v0.t' : '');
  switch (k.k) {
    case 'vsetvli': return `vsetvli ${x(k.rd)}, ${x(k.rs1)}, ${vtypeText(k.zimm)}`;
    case 'vsetivli': return `vsetivli ${x(k.rd)}, ${k.uimm}, ${vtypeText(k.zimm)}`;
    case 'vsetvl': return `vsetvl ${x(k.rd)}, ${x(k.rs1)}, ${x(k.rs2)}`;
    case 'opi': {
      const src = k.form === 'vv' ? v(k.src) : k.form === 'vx' ? x(k.src) : OPI[k.name].uimm ? `${k.src}` : `${simm5(k.src)}`;
      return `${k.name}.${k.form} ${v(k.vd)}, ${v(k.vs2)}, ${src}${m(k.vm)}`;
    }
    case 'merge': {
      const src = k.form === 'vv' ? v(k.src) : k.form === 'vx' ? x(k.src) : `${simm5(k.src)}`;
      return k.vm ? `vmerge.${k.form}m ${v(k.vd)}, ${v(k.vs2)}, ${src}, v0` : `vmv.v.${k.form[1]} ${v(k.vd)}, ${src}`;
    }
    case 'redsum': return `vredsum.vs ${v(k.vd)}, ${v(k.vs2)}, ${v(k.vs1)}${m(k.vm)}`;
    case 'mul': return `vmul.${k.form} ${v(k.vd)}, ${v(k.vs2)}, ${k.form === 'vv' ? v(k.src) : x(k.src)}${m(k.vm)}`;
    case 'mvxs': return `vmv.x.s ${x(k.rd)}, ${v(k.vs2)}`;
    case 'mvsx': return `vmv.s.x ${v(k.vd)}, ${x(k.rs1)}`;
    case 'vid': return `vid.v ${v(k.vd)}${m(k.vm)}`;
    case 'mem': {
      const name = `v${k.store ? 's' : 'l'}${k.strided ? 's' : ''}e${k.eew}.v`;
      return `${name} ${v(k.v)}, (${x(k.rs1)})${k.strided ? `, ${x(k.rs2)}` : ''}${m(k.vm)}`;
    }
  }
}

// ---- execution ----

const u = (v: number, sew: number) => (sew === 32 ? v >>> 0 : v & ((1 << sew) - 1));
const s = (v: number, sew: number) => (sew === 32 ? v | 0 : (v << (32 - sew)) >> (32 - sew));

function getE(c: VContext, reg: number, i: number, sew: number): number {
  const b = reg * c.vlenb + (i * sew) / 8, r = c.vregs;
  if (sew === 8) return r[b];
  if (sew === 16) return r[b] | (r[b + 1] << 8);
  return (r[b] | (r[b + 1] << 8) | (r[b + 2] << 16) | (r[b + 3] << 24)) >>> 0;
}

function setE(c: VContext, reg: number, i: number, sew: number, v: number): void {
  const b = reg * c.vlenb + (i * sew) / 8, r = c.vregs;
  r[b] = v & 0xff;
  if (sew >= 16) r[b + 1] = (v >>> 8) & 0xff;
  if (sew === 32) { r[b + 2] = (v >>> 16) & 0xff; r[b + 3] = (v >>> 24) & 0xff; }
}

const maskBit = (c: VContext, reg: number, i: number) => (c.vregs[reg * c.vlenb + (i >> 3)] >> (i & 7)) & 1;
function setMaskBit(c: VContext, reg: number, i: number, b: number): void {
  const k = reg * c.vlenb + (i >> 3);
  c.vregs[k] = b ? c.vregs[k] | (1 << (i & 7)) : c.vregs[k] & ~(1 << (i & 7));
}

/** A register group of `emul` registers starting at r is legal: aligned, inside the file. */
const groupOk = (r: number, emul: number) => (emul <= 1 ? true : r % emul === 0 && r + emul <= 32);
const regsOf = (emul: number) => Math.max(1, emul);

function setVl(c: VContext, rd: number, avl: number | 'max' | 'keep', zimm: number): VResult {
  const t = vtypeOf(zimm, c.vlenb);
  if (!t) { c.vtype = VILL; c.vl = 0; return { rd, value: 0 }; }
  const vlmax = vlmaxOf(t, c.vlenb);
  c.vtype = zimm >>> 0;
  c.vl = avl === 'max' ? vlmax : avl === 'keep' ? Math.min(c.vl, vlmax) : Math.min(avl >>> 0, vlmax);
  return { rd, value: c.vl };
}

/** Execute a vector instruction on the context. */
export function execV(w: number, c: VContext): VResult {
  const k = decodeV(w);
  if (!k) return { illegal: true };
  const x = c.x;
  if (k.k === 'vsetvli') return setVl(c, k.rd, k.rs1 ? x[k.rs1] : k.rd ? 'max' : 'keep', k.zimm);
  if (k.k === 'vsetivli') return setVl(c, k.rd, k.uimm, k.zimm);
  if (k.k === 'vsetvl') return setVl(c, k.rd, k.rs1 ? x[k.rs1] : k.rd ? 'max' : 'keep', x[k.rs2]);
  const t = vtypeOf(c.vtype, c.vlenb);
  if (!t) return { illegal: true };
  const { sew, lmul } = t, vl = c.vl;
  const active = (vm: boolean, i: number) => !vm || maskBit(c, 0, i) === 1;
  switch (k.k) {
    case 'mvxs': return { rd: k.rd, value: s(getE(c, k.vs2, 0, sew), sew) >>> 0 };
    case 'mvsx':
      if (vl > 0) setE(c, k.vd, 0, sew, x[k.rs1]);
      return { vwrite: { vd: k.vd, regs: 1 } };
    case 'vid':
      if (!groupOk(k.vd, lmul) || (k.vm && k.vd === 0)) return { illegal: true };
      for (let i = 0; i < vl; i++) if (active(k.vm, i)) setE(c, k.vd, i, sew, i);
      return { vwrite: { vd: k.vd, regs: regsOf(lmul) } };
    case 'redsum': {
      if (!groupOk(k.vs2, lmul)) return { illegal: true };
      if (vl === 0) return {};
      let acc = getE(c, k.vs1, 0, sew);
      for (let i = 0; i < vl; i++) if (active(k.vm, i)) acc = acc + getE(c, k.vs2, i, sew);
      setE(c, k.vd, 0, sew, u(acc, sew));
      return { vwrite: { vd: k.vd, regs: 1 } };
    }
    case 'mem': {
      const emul = (k.eew / sew) * lmul;
      if (emul < 1 / 8 || emul > 8 || !groupOk(k.v, emul) || (k.vm && !k.store && k.v === 0)) return { illegal: true };
      const bytes = (k.eew / 8) as 1 | 2 | 4, stride = k.strided ? x[k.rs2] | 0 : bytes;
      const out: VResult = k.store ? { stores: [] } : { loads: [], vwrite: { vd: k.v, regs: regsOf(emul) } };
      for (let i = 0; i < vl; i++) {
        if (!active(k.vm, i)) continue;
        const addr = (x[k.rs1] + i * stride) >>> 0;
        if (k.store) { const v = getE(c, k.v, i, k.eew); c.store(addr, bytes, v); out.stores!.push({ addr, value: v, bytes }); }
        else { out.loads!.push(addr); setE(c, k.v, i, k.eew, u(c.load(addr, bytes), k.eew)); }
      }
      return out;
    }
    case 'merge': {
      if (!groupOk(k.vd, lmul) || (k.form === 'vv' && !groupOk(k.src, lmul)) || (k.vm && (!groupOk(k.vs2, lmul) || k.vd === 0))) return { illegal: true };
      const scalar = k.form === 'vx' ? x[k.src] : simm5(k.src);
      for (let i = 0; i < vl; i++) {
        const take = k.form === 'vv' ? getE(c, k.src, i, sew) : scalar;
        setE(c, k.vd, i, sew, u(!k.vm || maskBit(c, 0, i) ? take : getE(c, k.vs2, i, sew), sew));
      }
      return { vwrite: { vd: k.vd, regs: regsOf(lmul) } };
    }
    case 'mul':
    case 'opi': {
      const isMask = k.k === 'opi' && OPI[k.name].mask;
      if (!groupOk(k.vs2, lmul) || (k.form === 'vv' && !groupOk(k.src, lmul))) return { illegal: true };
      if (!isMask && (!groupOk(k.vd, lmul) || (k.vm && k.vd === 0))) return { illegal: true };
      // a mask result may sit on the first register of a source group, never inside it (Spike's require_noover)
      if (isMask && lmul > 1 && ((k.vd !== k.vs2 && k.vd > k.vs2 && k.vd < k.vs2 + lmul) || (k.form === 'vv' && k.vd !== k.src && k.vd > k.src && k.vd < k.src + lmul))) return { illegal: true };
      const scalar = k.form === 'vx' ? x[k.src] : k.k === 'opi' && OPI[k.name].uimm ? k.src : simm5(k.src);
      for (let i = 0; i < vl; i++) {
        if (!active(k.vm, i)) continue;
        const a = getE(c, k.vs2, i, sew), b = u(k.form === 'vv' ? getE(c, k.src, i, sew) : scalar, sew);
        if (k.k === 'mul') { setE(c, k.vd, i, sew, u(Math.imul(a, b), sew)); continue; }
        const r = opi(k.name, a, b, sew);
        if (isMask) setMaskBit(c, k.vd, i, r);
        else setE(c, k.vd, i, sew, u(r, sew));
      }
      return { vwrite: { vd: k.vd, regs: isMask ? 1 : regsOf(lmul) } };
    }
  }
}

/** One element of an OPI instruction: a, b are SEW-bit unsigned patterns; mask results are 0 / 1. */
function opi(name: string, a: number, b: number, sew: number): number {
  const sa = s(a, sew), sb = s(b, sew), sh = b & (sew - 1);
  switch (name) {
    case 'vadd': return a + b;
    case 'vsub': return a - b;
    case 'vrsub': return b - a;
    case 'vminu': return Math.min(a, b);
    case 'vmin': return Math.min(sa, sb);
    case 'vmaxu': return Math.max(a, b);
    case 'vmax': return Math.max(sa, sb);
    case 'vand': return a & b;
    case 'vor': return a | b;
    case 'vxor': return a ^ b;
    case 'vmseq': return +(a === b);
    case 'vmsne': return +(a !== b);
    case 'vmsltu': return +(a < b);
    case 'vmslt': return +(sa < sb);
    case 'vmsleu': return +(a <= b);
    case 'vmsle': return +(sa <= sb);
    case 'vmsgtu': return +(a > b);
    case 'vmsgt': return +(sa > sb);
    case 'vsll': return sew === 32 ? a << sh : a * 2 ** sh;
    case 'vsrl': return a >>> sh;
    case 'vsra': return sa >> sh;
    default: throw new Error(`no OPI ${name}`);
  }
}

/** Read a vector CSR (user level: vl, vtype, vlenb, vstart = 0, the fixed-point ones = 0), or null. */
export function vcsrRead(c: VContext, a: number): number | null {
  switch (a) {
    case VCSR.vl: return c.vl;
    case VCSR.vtype: return c.vtype >>> 0;
    case VCSR.vlenb: return c.vlenb;
    case VCSR.vstart: case VCSR.vxsat: case VCSR.vxrm: case VCSR.vcsr: return 0;
    default: return null;
  }
}
