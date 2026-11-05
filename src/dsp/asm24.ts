// DSP24's assembler: two passes, labels, one 24-bit word per instruction, `.word` for raw words, `.org`.
// Registers r0–r7, pointers p0–p7 (p0–p3 address X, p4–p7 address Y), xb xl xm yb yl ym. A memory operand is the memory
// letter, the pointer in brackets and the update that follows the access: x(p0)  x(p0)+  y(p5)-  x(p1)+m  x(p0)+c
// y(p4)-c  x(p2)+r  x(p0)+mc. Comments: ; # //. Numbers: decimal, 0x, 0b, 'c'. Mnemonics in any case.

import { AsmError, commentStart, parseImm, splitArgs } from '../riscv/asm';
import { BY_NAME24, enc24, gpr24, MODES24, regNumber24, ROM24_WORDS } from './isa24';

export interface AsmLine24 { addr: number; word: number; text: string; srcLine: number }
export interface AsmResult24 {
  words: number[];
  lines: AsmLine24[];
  labels: Map<string, number>;
  errors: { line: number; message: string }[];
}

interface Stmt { line: number; op: string; args: string[]; text: string; addr: number }

export const DIRECTIVES24: readonly string[] = ['.word', '.org'];

export function assemble24(src: string): AsmResult24 {
  const stmts: Stmt[] = [];
  const labels = new Map<string, number>();
  const errors: { line: number; message: string }[] = [];
  let at = 0;
  src.split(/\r?\n/).forEach((raw, i) => {
    let ln = raw.slice(0, commentStart(raw)).trim();
    for (;;) {
      const m = ln.match(/^([A-Za-z_.$][\w.$]*)\s*:/);
      if (!m) break;
      if (labels.has(m[1])) errors.push({ line: i + 1, message: `label "${m[1]}" defined twice` });
      labels.set(m[1], at);
      ln = ln.slice(m[0].length).trim();
    }
    if (!ln) return;
    const sp = ln.search(/\s/);
    const op = (sp < 0 ? ln : ln.slice(0, sp)).toLowerCase();
    const args = splitArgs(sp < 0 ? '' : ln.slice(sp + 1));
    if (op === '.org') {
      try {
        const v = parseImm(args[0] ?? '');
        if (v < at || v >= ROM24_WORDS) throw new AsmError(`.org ${v} is behind the current address ${at} or past the ROM`);
        at = v;
      } catch (e) { errors.push({ line: i + 1, message: (e as Error).message }); }
      return;
    }
    stmts.push({ line: i + 1, op, args, text: ln, addr: at });
    at += op === '.word' ? Math.max(1, args.length) : 1;
  });

  const words: number[] = [];
  const lines: AsmLine24[] = [];
  for (const s of stmts) {
    try {
      encodeStmt(s, labels).forEach((w, k) => {
        const addr = s.addr + k;
        if (addr >= ROM24_WORDS) throw new AsmError(`the program does not fit in ${ROM24_WORDS} words`);
        while (words.length < addr) words.push(0);
        words[addr] = w;
        lines.push({ addr, word: w, text: s.text, srcLine: s.line });
      });
    } catch (e) {
      if (e instanceof AsmError) errors.push({ line: s.line, message: e.message });
      else throw e;
    }
  }
  return { words, lines, labels, errors };
}

/** A memory operand: the bus, the pointer index 0–3 within that bus, the mode. */
export function parseMem24(a: string): { bus: 0 | 1; p: number; mode: number } {
  const m = a.trim().toLowerCase().match(/^([xy])\s*\(\s*p([0-7])\s*\)\s*(\+mc|\+m|\+c|-c|\+r|\+|-)?$/);
  if (!m) throw new AsmError(`not a memory operand: "${a.trim()}" (x(p0)+, y(p4)-c, ...)`);
  const bus = m[1] === 'x' ? 0 : 1, pn = +m[2];
  if (bus === 0 && pn > 3) throw new AsmError(`x(...) takes p0–p3, not p${pn}: p4–p7 address Y`);
  if (bus === 1 && pn < 4) throw new AsmError(`y(...) takes p4–p7, not p${pn}: p0–p3 address X`);
  return { bus, p: bus === 0 ? pn : pn - 4, mode: MODES24.indexOf((m[3] ?? '') as (typeof MODES24)[number]) };
}

function encodeStmt(s: Stmt, labels: Map<string, number>): number[] {
  const { op, args } = s;
  const want = (n: number) => {
    if (args.length !== n) throw new AsmError(`${op} takes ${n === 0 ? 'no operands' : n === 1 ? 'one operand' : `${n} operands`}`);
  };
  const num = (a: string, lo: number, hi: number, what: string): number => {
    const t = a.trim();
    const v = labels.get(t) ?? parseImm(t);
    if (v < lo || v > hi) throw new AsmError(`${what} ${v} is out of range (${lo} to ${hi})`);
    return v;
  };
  const gp = (a: string) => {
    const r = gpr24(a);
    if (r === null) throw new AsmError(`not a register: "${a}" (r0–r7)`);
    return r;
  };
  const ur = (a: string) => {
    const r = regNumber24(a);
    if (r === null) throw new AsmError(`not a register: "${a}" (r0–r7, p0–p7, xb xl xm yb yl ym)`);
    return r;
  };
  const addr = (a: string) => {
    const t = a.trim();
    if (t === '$' || t === '.') return s.addr;
    if (/^[A-Za-z_.$][\w.$]*$/.test(t) && !/^0[xb]/i.test(t) && !labels.has(t)) throw new AsmError(`unknown label "${t}"`);
    return num(t, 0, ROM24_WORDS - 1, 'address');
  };
  const mem = (a: string, bus: 0 | 1) => {
    const m = parseMem24(a);
    if (m.bus !== bus) throw new AsmError(`expected ${bus ? 'y' : 'x'}(...) here, not "${a.trim()}"`);
    return m;
  };

  if (op === '.word') {
    if (!args.length) throw new AsmError('.word needs a value');
    return args.map((a) => num(a, -0x800000, 0xffffff, 'word') & 0xffffff);
  }
  const ins = BY_NAME24.get(op);
  if (!ins) throw new AsmError(`unknown instruction "${op}"`);
  const o = ins.op;
  switch (ins.shape) {
    case '': want(0); return [o << 19];
    case 'rrr': want(3); return [enc24.rrr(o, gp(args[0]), gp(args[1]), gp(args[2]))];
    case 'rri': want(3); return [enc24.rri(o, gp(args[0]), gp(args[1]), num(args[2], -128, 255, 'constant'))];
    case 'ri': want(2); return [enc24.ri(o, gp(args[0]), num(args[1], -128, 255, 'constant'))];
    case 'mov': want(2); return [enc24.mov(o, ur(args[0]), ur(args[1]))];
    case 'ldi': want(2); return [enc24.ldi(o, ur(args[0]), num(args[1], -8192, 16383, 'constant'))];
    case 'mem2': {
      want(2);
      const x = mem(args[0], 0), y = mem(args[1], 1);
      return [enc24.mem2(o, x.mode, x.p, y.mode, y.p)];
    }
    case 'memld': {
      want(2);
      const m = parseMem24(args[1]);
      return [enc24.ld(o, gp(args[0]), m.mode, m.p, m.bus)];
    }
    case 'memst': {
      want(2);
      const m = parseMem24(args[0]);
      return [enc24.st(o, gp(args[1]), m.mode, m.p, m.bus)];
    }
    case 'ld2': {
      want(4);
      const x = mem(args[2], 0), y = mem(args[3], 1);
      return [enc24.ld2(o, gp(args[0]), gp(args[1]), x.mode, x.p, y.mode, y.p)];
    }
    case 'r': want(1); return [enc24.r(o, gp(args[0]))];
    case 'rsh': want(2); return [enc24.rsh(o, gp(args[0]), num(args[1], 0, 31, 'shift'))];
    case 'loop': {
      want(2);
      const e = addr(args[1]);
      if (gpr24(args[0]) !== null) return [enc24.loop(o, 1, gpr24(args[0])!, e)];
      return [enc24.loop(o, 0, num(args[0], 1, 1023, 'loop count'), e)];
    }
    case 'a': want(1); return [enc24.a(o, addr(args[0]))];
    case 'ra': want(2); return [enc24.ra(o, gp(args[0]), addr(args[1]))];
  }
}
