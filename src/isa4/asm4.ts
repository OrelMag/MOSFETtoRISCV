// The 4-bit CPU's assembler: two passes, labels, one word per instruction, `.word` for raw words.
// Operands as the MCS-4 assembler wrote them: R0–R15, P0–P7, JCN conditions by name (TZ TN C1
// C0 AZ AN) or number, numbers in decimal / 0x / 0b / 'c'. Comments: ; # //. Mnemonics in any case.

import { AsmError, commentStart, parseImm, splitArgs } from '../riscv/asm';
import { BY_NAME4, JCN_NAMES, pair4, reg4 } from './isa4';

export interface AsmLine4 {
  /** Word address in the ROM. */
  addr: number;
  word: number;
  text: string;
  srcLine: number;
}

export interface AsmResult4 {
  words: number[];
  lines: AsmLine4[];
  labels: Map<string, number>;
  errors: { line: number; message: string }[];
}

export const DIRECTIVES4: readonly string[] = ['.word', '.org'];

/** Highest ROM address (an 8-bit PC). */
export const ROM4_WORDS = 256;

interface Stmt { line: number; op: string; args: string[]; text: string; addr: number }

export function assemble4(src: string): AsmResult4 {
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
        if (v < at || v >= ROM4_WORDS) throw new AsmError(`.org ${v} is behind the current address ${at} or past the ROM`);
        at = v;
      } catch (e) {
        errors.push({ line: i + 1, message: (e as Error).message });
      }
      return;
    }
    stmts.push({ line: i + 1, op, args, text: ln, addr: at });
    at += op === '.word' ? Math.max(1, args.length) : 1;
  });

  const words: number[] = [];
  const lines: AsmLine4[] = [];
  for (const s of stmts) {
    try {
      const ws = encodeStmt(s, labels);
      ws.forEach((w, k) => {
        const addr = s.addr + k;
        if (addr >= ROM4_WORDS) throw new AsmError(`the program does not fit in ${ROM4_WORDS} words`);
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

function encodeStmt(s: Stmt, labels: Map<string, number>): number[] {
  const { op, args } = s;
  const want = (n: number) => {
    if (args.length !== n) throw new AsmError(`${op.toUpperCase()} takes ${n === 0 ? 'no operands' : n === 1 ? 'one operand' : `${n} operands`}`);
  };
  const num = (a: string, max: number, what: string): number => {
    const v = labels.get(a.trim()) ?? parseImm(a);
    if (v < 0 || v > max) throw new AsmError(`${what} ${v} is out of range (0–${max})`);
    return v;
  };
  const reg = (a: string) => {
    const r = reg4(a);
    if (r === null) throw new AsmError(`not a register: "${a}" (R0–R15)`);
    return r;
  };
  const pair = (a: string) => {
    const p = pair4(a);
    if (p === null) throw new AsmError(`not a register pair: "${a}" (P0–P7)`);
    return p;
  };
  const addr = (a: string) => {
    const t = a.trim();
    if (t === '$' || t === '.') return s.addr;
    if (/^[A-Za-z_.$][\w.$]*$/.test(t) && !/^0[xb]/i.test(t) && !labels.has(t)) throw new AsmError(`unknown label "${t}"`);
    return num(t, 255, 'address');
  };

  if (op === '.word') {
    if (!args.length) throw new AsmError('.word needs a value');
    return args.map((a) => num(a, 0xffff, 'word'));
  }
  const ins = BY_NAME4.get(op.toUpperCase());
  if (!ins) throw new AsmError(`unknown instruction "${op}"`);
  const hi = (opa: number) => (ins.hi | opa) << 8;
  switch (ins.shape) {
    case '': want(0); return [hi(0)];
    case 'r': want(1); return [hi(reg(args[0]))];
    case 'p': want(1); return [hi(pair(args[0]) << 1)];
    case 'd': want(1); return [hi(num(args[0], 15, 'data'))];
    case 'a': want(1); return [hi(0) | addr(args[0])];
    case 'ra': want(2); return [hi(reg(args[0])) | addr(args[1])];
    case 'pb': want(2); return [hi(pair(args[0]) << 1) | num(args[1], 255, 'data')];
    case 'ca': {
      want(2);
      const c = JCN_NAMES[args[0].trim().toLowerCase()] ?? num(args[0], 15, 'condition');
      return [hi(c) | addr(args[1])];
    }
  }
}
