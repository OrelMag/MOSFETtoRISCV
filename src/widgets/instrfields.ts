// The instruction breakdown: an instruction's fields, what each one means in this instruction,
// and how the immediate generator reassembles the immediate from scattered bits. Shared by the
// ISA explorer and the CPU panel, where pointing at a field lights the wires that carry it.

import { fieldAt, fieldRole, fieldsOf, immBits, type Field, type FieldKey, type ImmBit } from '../riscv/fields';
import { decode, FIELDS, type Fmt } from '../riscv/isa';
import { h } from '../ui/dom';

export interface BreakdownOpts {
  /** Narrow layout for the CPU panel: no value line in the strip, immediate row folded. */
  compact?: boolean;
  /** Pointer over a field (sticky = false; null when it leaves) or a click on it (sticky = true). */
  onField?(key: FieldKey | null, sticky: boolean): void;
  /** The field pinned by a click, drawn outlined. */
  selected?: FieldKey | null;
}

const role = (key: FieldKey) => `f-${fieldRole(key)}`;
/** Reading order of the meaning list: what kind of instruction, then operands. */
const ORDER: FieldKey[] = ['opcode', 'funct3', 'funct7', 'fmt', 'funct12', 'rd', 'rs1', 'zimm', 'rs2', 'rs3', 'shamt', 'csr', 'imm'];
// The immediate row stays open or folded across rebuilds (the CPU panel rebuilds per instruction).
let immOpen = false;

/** The empty field template of a format (the "six formats" table). */
export function formatStrip(fmt: Fmt): HTMLElement {
  return h('div', { class: 'fields' }, FIELDS[fmt].map((f) => {
    const key: FieldKey = f.name.startsWith('imm') ? 'imm' : f.name === 'rm' ? 'funct3' : f.name as FieldKey;
    return h('div', { class: role(key), style: `--w:${f.hi - f.lo + 1}` },
      h('div', { class: 'fname' }, `${f.name} [${f.hi}:${f.lo}]`),
      h('div', { class: 'fbits' }, '·'.repeat(f.hi - f.lo + 1)));
  }));
}

export function instrBreakdown(word: number, opts: BreakdownOpts = {}): HTMLElement {
  const w = word >>> 0;
  const fields = fieldsOf(w);
  const live = !!opts.onField;
  const el = h('div', { class: 'ibd' });
  const hover = (key: FieldKey) => live ? {
    onmouseenter: () => opts.onField!(key, false),
    onmouseleave: () => opts.onField!(null, false),
    onclick: () => opts.onField!(key, true),
  } : {};

  // Field strip: one box per field, every bit its own span so the immediate row can point at it.
  const strip = h('div', { class: `fields${live ? ' live' : ''}` }, fields.map((f) => {
    const n = f.hi - f.lo + 1;
    const bits = Array.from({ length: n }, (_, i) => h('span', { class: 'bit', 'data-b': f.hi - i }, String((w >>> (f.hi - i)) & 1)));
    const reg = f.key === 'rd' || f.key === 'rs1' || f.key === 'rs2';
    return h('div', {
      class: `${role(f.key)}${f.used ? '' : ' unused'}${opts.selected === f.key ? ' on' : ''}`, style: `--w:${n}`, 'data-field': f.key,
      title: `${f.label}, bits ${f.hi}:${f.lo} = ${f.value}: ${f.meaning}`, ...hover(f.key),
    },
    h('div', { class: 'fname' }, opts.compact ? f.label : `${f.label} [${f.hi}:${f.lo}]`),
    h('div', { class: 'fbits' }, bits),
    opts.compact ? null : h('div', { class: 'fval' }, reg && f.used ? f.meaning : String(f.value)));
  }));
  el.append(strip);

  // What each field means here (imm pieces fold into one line).
  const seen = new Set<FieldKey>();
  const rows = [...fields].sort((a, b) => ORDER.indexOf(a.key) - ORDER.indexOf(b.key)).filter((f) => !seen.has(f.key) && seen.add(f.key));
  el.append(h('div', { class: 'ibd-meaning' }, rows.map((f: Field) =>
    h('div', { class: `row ${role(f.key)}${f.used ? '' : ' off'}${opts.selected === f.key ? ' on' : ''}`, 'data-field': f.key, ...hover(f.key) },
      h('span', { class: 'k' }, f.key === 'imm' ? 'imm' : f.label), h('span', { class: 'v' }, f.meaning)))));

  // The immediate as the immediate generator builds it: bit i of the result ← instruction bit src.
  const ib = immBits(w);
  if (ib.length && fields.some((f) => (f.key === 'imm' && f.used) || f.key === 'shamt')) {
    const d = decode(w);
    const cells = h('div', { class: 'cells' }, immRuns(ib).map((r) => {
      const k = r.kind === 'wire' ? fieldAt(fields, r.src).key : r.kind === 'sign' ? fieldAt(fields, 31).key : null;
      const range = (hi: number, lo: number) => (hi === lo ? `${hi}` : `${hi}:${lo}`);
      const bits = r.values.join('');
      const c = h('span', {
        class: `c ${r.kind}${k ? ` ${role(k)}` : ''}`, style: `--n:${Math.min(r.values.length, 7)}`,
        title: r.kind === 'zero' ? `imm[${range(r.hi, r.lo)}] = 0: wired to ground` : r.kind === 'sign' ? `imm[${range(r.hi, r.lo)}] = instr[31] copied: sign extension` : `imm[${range(r.hi, r.lo)}] = instr[${range(r.src, r.src - r.hi + r.lo)}]`,
      },
      h('i', null, range(r.hi, r.lo)),
      h('b', null, bits.length > 6 && new Set(bits).size === 1 ? `${bits[0]}×${bits.length}` : bits),
      h('i', null, r.kind === 'zero' ? 'gnd' : r.kind === 'sign' ? '31' : range(r.src, r.src - r.hi + r.lo)));
      if (r.kind !== 'zero') {
        const src = r.kind === 'sign' ? [31] : Array.from({ length: r.hi - r.lo + 1 }, (_, i) => r.src - i);
        const els = src.map((b) => strip.querySelector(`.bit[data-b="${b}"]`));
        c.addEventListener('mouseenter', () => { c.classList.add('hi'); els.forEach((e) => e?.classList.add('src')); });
        c.addEventListener('mouseleave', () => { c.classList.remove('hi'); els.forEach((e) => e?.classList.remove('src')); });
      }
      return c;
    }));
    const val = d.fmt === 'U' ? `0x${(d.imm >>> 0).toString(16)}` : String(immValue(ib));
    const det = h('details', { class: 'ibd-imm' },
      h('summary', null, `imm = ${val}: how the ${d.fmt}-format wiring builds it`),
      cells, h('div', { class: 'axis' }, h('span', null, 'top: imm bits · bottom: the instruction bits wired to them (hatched: sign copies of bit 31)'))) as HTMLDetailsElement;
    det.open = opts.compact ? immOpen : true;
    if (opts.compact) det.addEventListener('toggle', () => { immOpen = det.open; });
    el.append(det);
  }
  return el;
}

const immValue = (ib: ImmBit[]) => ib.reduce((a, b) => a + b.value * 2 ** b.bit, 0) | 0;

interface ImmRun { hi: number; lo: number; kind: 'wire' | 'sign' | 'zero'; src: number; values: number[] }

/** Group the immediate's bits (high to low) into runs wired from consecutive instruction bits. */
function immRuns(ib: ImmBit[]): ImmRun[] {
  const runs: ImmRun[] = [];
  for (const b of [...ib].reverse()) {
    const kind = b.src === 'zero' ? 'zero' : b.sign ? 'sign' : 'wire';
    const src = typeof b.src === 'number' ? b.src : -1;
    const last = runs[runs.length - 1];
    if (last && last.kind === kind && (kind !== 'wire' || last.src - (last.hi - last.lo) - 1 === src)) {
      last.lo = b.bit;
      last.values.push(b.value);
    } else runs.push({ hi: b.bit, lo: b.bit, kind, src, values: [b.value] });
  }
  return runs;
}
