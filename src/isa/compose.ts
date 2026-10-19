// The instruction builder over a Custom ISA table (the 4-bit CPU's preset included), and the
// builder's ISA for each ROM language. A table row is an instruction; its operand letters are the
// slots, their bit positions come from the compiled pattern, so encode / decode follow the table
// exactly (tests/compose-isa.test.ts holds them to the table's own assembler and disassembler).

import { assemble4 } from '../isa4/asm4';
import { RV32_COMPOSE } from '../riscv/compose';
import { RV16_COMPOSE } from '../riscv/rv16/compose16';
import { codeOf, clampSlot, wiresOf, type CField, type CInstr, type ComposeIsa, type CSlot, type Parts, type ProgramInfo } from './composekit';
import { ISA4_PRESET } from './presets';
import { tableOf, type IsaDoc } from './table';

const u32 = (v: number) => v >>> 0;

/** The builder over a table; id: the ROM language it stands for. */
export function tableCompose(doc: IsaDoc, id = `isa:${doc.id}`): ComposeIsa {
  const t = tableOf(doc);
  const W = doc.wordBits;
  const rows = t.compiled;
  const nbits = (r: number, l: string) => rows[r].bits.get(l)?.length ?? 0;

  const slotOf = (r: number, l: string, i: number): CSlot => {
    const d = doc.operands[l];
    const n = nbits(r, l);
    const all = 2 ** n;
    if (!d) return { key: l, label: l, kind: 'num', min: 0, max: all - 1, step: 1 };
    switch (d.kind) {
      case 'reg': return { key: l, label: l, kind: 'reg', names: d.names.slice(0, all), min: 0, max: Math.min(d.names.length, all) - 1, step: 1, dest: i === 0 && rows[r].def.operands.length > 1 };
      case 'enum': {
        const options = Object.entries(d.names).filter(([, v]) => v < all).map(([name, value]) => ({ name, value }));
        return d.number ? { key: l, label: l, kind: 'num', options, min: 0, max: all - 1, step: 1, role: 'imm' }
          : { key: l, label: l, kind: 'enum', options, min: 0, max: all - 1, step: 1 };
      }
      case 'imm': return d.signed ? { key: l, label: l, kind: 'num', min: -(all / 2), max: all / 2 - 1, step: 1, role: 'imm', hex: d.hex }
        : { key: l, label: l, kind: 'num', min: 0, max: all - 1, step: 1, role: 'imm', hex: d.hex };
      case 'addr': {
        const s = d.scale ?? 1;
        return d.rel ? { key: l, label: l, kind: 'num', min: -(all / 2) * s, max: (all / 2 - 1) * s, step: s, role: 'target' }
          : { key: l, label: l, kind: 'num', min: 0, max: all - 1, step: 1, role: 'address', hex: true };
      }
    }
  };
  const instrs: CInstr[] = rows.map((c, r) => ({ id: String(r), name: c.def.mnemonic, summary: c.def.summary, slots: c.def.operands.map((l, i) => slotOf(r, l, i)) }));

  /** An operand's value → its raw bits, and back. */
  const toRaw = (r: number, l: string, v: number) => {
    const d = doc.operands[l], n = nbits(r, l);
    const x = d?.kind === 'addr' && d.rel ? v / (d.scale ?? 1) : v;
    return x < 0 ? x + 2 ** n : x;
  };
  const fromRaw = (r: number, l: string, raw: number) => {
    const d = doc.operands[l], n = nbits(r, l);
    const signed = (d?.kind === 'imm' && d.signed) || (d?.kind === 'addr' && d.rel);
    const v = signed && raw >= 2 ** (n - 1) ? raw - 2 ** n : raw;
    return d?.kind === 'addr' && d.rel ? v * (d.scale ?? 1) : v;
  };
  const extract = (r: number, l: string, w: number) => (rows[r].bits.get(l) ?? []).reduce((v, b) => v * 2 + ((w >>> b) & 1), 0);

  const encode = (sid: string, parts: Parts) => {
    const r = Number(sid), c = rows[r];
    let w = c.value;
    for (const s of instrs[r].slots) {
      const raw = toRaw(r, s.key, clampSlot(s, parts[s.key] ?? s.min));
      const pos = c.bits.get(s.key) ?? [];
      pos.forEach((b, k) => { if (Math.floor(raw / 2 ** (pos.length - 1 - k)) & 1) w = u32(w | (1 << b)); });
    }
    return u32(w);
  };
  const decode = (word: number) => {
    const w = u32(word);
    const c = t.match(w);
    if (!c) return null;
    const r = rows.indexOf(c);
    const parts: Parts = {};
    for (const l of c.def.operands) parts[l] = fromRaw(r, l, extract(r, l, w));
    return encode(String(r), parts) === w ? { id: String(r), parts } : null;
  };
  const operandText = (_r: number, l: string, v: number) => {
    const d = doc.operands[l];
    if (d?.kind === 'reg') return d.names[v] ?? String(v);
    if (d?.kind === 'enum') return Object.entries(d.names).find(([, x]) => x === v)?.[0] ?? String(v);
    if (d?.kind === 'addr') return d.rel ? `pc ${v < 0 ? '−' : '+'} ${Math.abs(v)}` : `0x${v.toString(16).toUpperCase()}`;
    return String(v);
  };

  const fields = (word: number): CField[] => {
    const w = u32(word);
    const c = t.match(w);
    if (!c) return [{ key: 'word', label: '.word', hi: W - 1, lo: 0, role: 'op', used: true, meaning: 'no instruction of the table', value: w }];
    const r = rows.indexOf(c);
    const p = c.def.pattern.replace(/\s+/g, '');
    const out: CField[] = [];
    for (let k = 0; k < p.length;) {
      const ch = p[k];
      const fixed = ch === '0' || ch === '1';
      let n = 1;
      while (k + n < p.length && (fixed ? p[k + n] === '0' || p[k + n] === '1' : p[k + n] === ch)) n++;
      const hi = W - 1 - k, lo = hi - n + 1;
      const value = Math.floor(w / 2 ** lo) % 2 ** n;
      const d = doc.operands[ch];
      const total = nbits(r, ch);
      const label = fixed ? 'opcode' : ch === '-' ? '—' : total > n ? `${ch}[${partRange(c.bits.get(ch)!, hi, lo)}]` : ch;
      const role = fixed ? 'op' : ch === '-' ? 'fn' : !d ? 'imm' : d.kind === 'reg' ? (c.def.operands.indexOf(ch) === 0 && c.def.operands.length > 1 ? 'rd' : 'rs') : d.kind === 'enum' ? 'fn' : 'imm';
      const meaning = fixed ? c.def.mnemonic : ch === '-' ? 'ignored' : operandText(r, ch, fromRaw(r, ch, extract(r, ch, w)));
      out.push({ key: fixed ? 'opcode' : ch, label, hi, lo, role, used: ch !== '-', meaning, value });
      k += n;
    }
    return out;
  };

  const imm = (word: number) => {
    const w = u32(word);
    const c = t.match(w);
    if (!c) return null;
    const r = rows.indexOf(c);
    // The widest number operand (a register or a name list has no wiring worth drawing).
    const l = c.def.operands.filter((x) => { const k = doc.operands[x]?.kind; return k === 'imm' || k === 'addr'; })
      .sort((a, b) => nbits(r, b) - nbits(r, a))[0];
    if (!l || nbits(r, l) < 2) return null;
    const pos = c.bits.get(l)!;
    const v = fromRaw(r, l, extract(r, l, w));
    const split = pos.some((b, i) => i && pos[i - 1] !== b + 1);
    return {
      wires: wiresOf(w, pos, pos.length, false), value: v, text: operandText(r, l, v),
      note: `operand ${l}'s ${pos.length} bits, most significant first${split ? ', gathered from the places the pattern splits them over' : ''}`,
    };
  };

  const text = (word: number, pc?: number, labels?: Map<string, number>) => {
    const base = t.disasm(word, pc ?? 0);
    const c = t.match(u32(word));
    if (!c || !labels || pc === undefined) return base;
    const r = rows.indexOf(c);
    let out = base;
    for (const l of c.def.operands) {
      const d = doc.operands[l];
      if (d?.kind !== 'addr') continue;
      const n = nbits(r, l), v = fromRaw(r, l, extract(r, l, u32(word)));
      const at = d.rel ? pc + v : v;
      const name = [...labels].find(([, a]) => a === at)?.[0];
      const shown = `0x${(at >>> 0).toString(16).toUpperCase().padStart(Math.ceil((d.rel ? Math.max(n, 8) : n) / 4), '0')}`;
      if (name) out = out.replace(shown, name);
    }
    return out;
  };

  // A line in context: the labels placed at their addresses with .org, the line at pc.
  const parse = (line: string, pc = 0, labels?: Map<string, number>) => {
    const code = codeOf(line);
    if (!code) return { error: 'Type an instruction or a hex word.' };
    if (new RegExp(`^0x[0-9a-f]{1,${W / 4}}$`, 'i').test(code)) return { word: parseInt(code.slice(2), 16) >>> 0 };
    const items: [number, string][] = [...(labels ?? [])].map(([n, a]): [number, string] => [a, `${n}:`]);
    items.push([pc + 0.5, code]);
    items.sort((a, b) => a[0] - b[0]);
    const src: string[] = [];
    let at = -1, codeLine = 0;
    for (const [a, s] of items) {
      const addr = Math.floor(a);
      if (addr !== at) { src.push(`.org ${addr}`); at = addr; }
      src.push(s);
      if (s === code && a === pc + 0.5) codeLine = src.length;
    }
    const r = t.assemble(src.join('\n'));
    const err = r.errors.find((e) => e.line === codeLine);
    if (err) return { error: err.message };
    const ws = r.lines.filter((x) => x.srcLine === codeLine).map((x) => x.word);
    return ws.length === 1 ? { word: ws[0] >>> 0 } : ws.length ? { words: ws } : { error: 'No instruction on this line.' };
  };

  const program = (src: string): ProgramInfo => {
    const r = t.assemble(src);
    return { lines: r.lines, labels: r.labels, errors: r.errors, end: r.words.length };
  };

  return {
    id, name: doc.name, wordBits: W, step: 1, start: rows.length ? encode('0', {}) : 0,
    groups: [{ name: 'Instructions', ids: instrs.map((i) => i.id) }],
    instr: (sid) => instrs[Number(sid)],
    encode, decode, fields, imm, text, parse, program,
  };
}

/** Which bits of an operand a run holds, as an operand bit range ("5:3"). */
function partRange(pos: number[], hi: number, lo: number): string {
  const n = pos.length;
  const a = n - 1 - pos.indexOf(hi), b = n - 1 - pos.indexOf(lo);
  return a === b ? `${a}` : `${a}:${b}`;
}

/** The 4-bit CPU: its preset table (equal to asm4 / disasm4 on every word), programs through asm4. */
export const CPU4_COMPOSE: ComposeIsa = {
  ...tableCompose(ISA4_PRESET, 'cpu4'),
  program(src) {
    const r = assemble4(src);
    return { lines: r.lines, labels: r.labels, errors: r.errors, end: r.words.length };
  },
};

const tables = new WeakMap<IsaDoc, ComposeIsa>();

/** The builder's ISA for a ROM language ('asm', 'rv16', 'cpu4'; 'isa' with its table), or null. */
export function composeIsaOf(lang: string, table?: IsaDoc): ComposeIsa | null {
  if (lang === 'asm') return RV32_COMPOSE;
  if (lang === 'rv16') return RV16_COMPOSE;
  if (lang === 'cpu4') return CPU4_COMPOSE;
  if (lang === 'isa' && table) {
    let c = tables.get(table);
    if (!c) tables.set(table, (c = tableCompose(table)));
    return c;
  }
  return null;
}
