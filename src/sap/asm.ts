// SAP-1's assembler: two passes, one byte per line in order from address 0 (no org), labels (`name:`), operands as
// labels or numbers (decimal, 0x, 0b), `.byte n` for data. At most 16 bytes. Comments: ; # //. Errors are
// collected per line, not thrown, so an editor can show them all.

import { commentStart, parseImm } from '../riscv/asm';
import { SAP_BY_NAME } from './isa';

/** Bytes of RAM: the whole address space. */
export const SAP_RAM = 16;

export interface SapAsmLine { addr: number; byte: number; text: string; srcLine: number }

export interface SapAsmResult {
  bytes: number[];
  lines: SapAsmLine[];
  labels: Map<string, number>;
  errors: { line: number; message: string }[];
}

interface Stmt { line: number; op: string; arg?: string; text: string; addr: number }

export function assembleSap(src: string): SapAsmResult {
  const stmts: Stmt[] = [];
  const labels = new Map<string, number>();
  const errors: { line: number; message: string }[] = [];
  src.split(/\r?\n/).forEach((raw, i) => {
    let ln = raw.slice(0, commentStart(raw)).trim();
    for (;;) {
      const m = ln.match(/^([A-Za-z_][\w]*)\s*:/);
      if (!m) break;
      if (labels.has(m[1])) errors.push({ line: i + 1, message: `label "${m[1]}" defined twice` });
      labels.set(m[1], stmts.length);
      ln = ln.slice(m[0].length).trim();
    }
    if (!ln) return;
    const parts = ln.split(/\s+/);
    if (parts.length > 2) { errors.push({ line: i + 1, message: `too many operands: "${ln}"` }); return; }
    stmts.push({ line: i + 1, op: parts[0].toLowerCase(), arg: parts[1], text: ln, addr: stmts.length });
  });
  if (stmts.length > SAP_RAM) errors.push({ line: stmts[SAP_RAM].line, message: `the program is ${stmts.length} bytes: RAM holds ${SAP_RAM}` });

  const value = (s: Stmt, max: number): number => {
    const a = s.arg!;
    let v: number;
    if (labels.has(a)) v = labels.get(a)!;
    else {
      try { v = parseImm(a); } catch { throw new Error(`not a number or label: "${a}"`); }
    }
    if (v < 0 || v > max) throw new Error(`${v} does not fit (0–${max})`);
    return v;
  };

  const bytes: number[] = [];
  const lines: SapAsmLine[] = [];
  for (const s of stmts.slice(0, SAP_RAM)) {
    let byte = 0;
    try {
      if (s.op === '.byte') {
        if (s.arg === undefined) throw new Error('.byte needs a value');
        byte = value(s, 255);
      } else {
        const o = SAP_BY_NAME.get(s.op.toUpperCase());
        if (!o) throw new Error(`unknown instruction "${s.op}"`);
        if (o.arg && s.arg === undefined) throw new Error(`${o.name} needs ${o.arg === 'addr' ? 'an address' : 'a number'}`);
        if (!o.arg && s.arg !== undefined) throw new Error(`${o.name} takes no operand`);
        byte = (o.op << 4) | (o.arg ? value(s, 15) : 0);
      }
    } catch (e) {
      errors.push({ line: s.line, message: (e as Error).message });
    }
    bytes.push(byte);
    lines.push({ addr: s.addr, byte, text: s.text, srcLine: s.line });
  }
  return { bytes, lines, labels, errors };
}

/** Assemble or throw the first error (samples, tests). */
export function sapBytes(src: string): number[] {
  const r = assembleSap(src);
  if (r.errors.length) throw new Error(`line ${r.errors[0].line}: ${r.errors[0].message}`);
  return r.bytes;
}
