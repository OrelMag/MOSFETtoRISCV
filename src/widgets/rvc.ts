// Chapter 25's explorers for the C extension: code size measured on our own programs, a 16-bit parcel taken apart
// bit by bit next to the instruction it stands for, and what the C core costs.

import { assemble } from '../riscv/asm';
import { BENCHMARKS } from '../riscv/benchprograms';
import { PROGRAMS } from '../riscv/programs';
import { compilePy } from '../lang/compile';
import { PY_PROGRAMS } from '../lang/pyprograms';
import { decodeC, disasmC } from '../riscv/rvc';
import { decode, disasm } from '../riscv/isa';
import { C_FIELDS, cRecipes, formOf, PASS } from '../lib/rvc';
import { h } from '../ui/dom';
import type { Widget } from '../view/stage';
import '../styles/rvc.css';

interface Prog { id: string; name: string; source: string }

/** The programs the chapter measures: the benchmarks, chapter 14's samples, the Python compiler's output. */
function programs(): Prog[] {
  const py = PY_PROGRAMS.map((p) => ({ id: `py-${p.id}`, name: `Python: ${p.name}`, source: compilePy(p.source).asm })).filter((p) => p.source);
  return [
    ...BENCHMARKS.filter((b) => !b.needs?.f).map((b) => ({ id: `b-${b.id}`, name: `Benchmark: ${b.name}`, source: b.source })),
    ...PROGRAMS.map((p) => ({ id: `s-${p.id}`, name: `Chapter 14: ${p.name}`, source: p.source })),
    ...py,
  ];
}

export interface CodeSize { bytes32: number; bytes16: number; n: number; short: number; forms: Map<string, number> }

/** A program's size both ways, and the 16-bit forms it uses. */
export function codeSize(source: string): CodeSize {
  const plain = assemble(source), small = assemble(`.option rvc\n${source}`);
  const forms = new Map<string, number>();
  for (const l of small.lines) if (l.size === 2) { const n = decodeC(l.word)?.name ?? '?'; forms.set(n, (forms.get(n) ?? 0) + 1); }
  const size = (ls: typeof plain.lines) => ls.reduce((s, l) => s + (l.size ?? 4), 0);
  return { bytes32: size(plain.lines), bytes16: size(small.lines), n: small.lines.length, short: small.lines.filter((l) => l.size === 2).length, forms };
}

export function codeSizeWidget(): Widget {
  const progs = programs();
  const sel = h('select', { 'aria-label': 'program' }) as HTMLSelectElement;
  for (const p of progs) sel.append(h('option', { value: p.id }, p.name));
  sel.value = progs.find((p) => p.id === 'py-fib')?.id ?? progs[0].id;
  const all = h('div', { class: 'rvc-all' });
  const bars = h('div', { class: 'rvc-bars' });
  const formsBox = h('div', { class: 'rvc-forms' });
  const listing = h('div', { class: 'rvc-listing' });
  // every program at once: the share of instructions with a 16-bit form and the bytes saved
  let tot32 = 0, tot16 = 0, totN = 0, totS = 0;
  for (const p of progs) { const s = codeSize(p.source); tot32 += s.bytes32; tot16 += s.bytes16; totN += s.n; totS += s.short; }
  all.replaceChildren(h('b', null, `${Math.round((100 * totS) / totN)} %`), ` of the ${totN.toLocaleString()} instructions in these ${progs.length} programs have a 16-bit form; together they shrink from ${tot32.toLocaleString()} to ${tot16.toLocaleString()} bytes (−${Math.round(100 * (1 - tot16 / tot32))} %).`);
  const render = () => {
    const p = progs.find((q) => q.id === sel.value)!;
    const s = codeSize(p.source);
    const max = s.bytes32;
    const bar = (label: string, v: number, cls: string, note: string) => h('div', { class: 'rvc-bar-row' },
      h('span', { class: 'rvc-bar-k' }, label),
      h('span', { class: 'rvc-bar-track' }, h('span', { class: `rvc-bar ${cls}`, style: `width:${(100 * v) / max}%` })),
      h('span', { class: 'rvc-bar-v' }, `${v} bytes${note}`));
    bars.replaceChildren(
      bar('RV32I', s.bytes32, 'b32', ''),
      bar('RV32IC', s.bytes16, 'b16', ` (−${Math.round(100 * (1 - s.bytes16 / s.bytes32))} %)`),
      h('div', { class: 'sub' }, `${s.short} of ${s.n} instructions are 16 bits (${Math.round((100 * s.short) / s.n)} %).`));
    formsBox.replaceChildren(...[...s.forms].sort((a, b) => b[1] - a[1]).map(([n, k]) => h('span', { class: 'rvc-form' }, h('code', null, n), ` ${k}`)));
    const small = assemble(`.option rvc\n${p.source}`);
    listing.replaceChildren(...small.lines.map((l) => h('div', { class: `rvc-ln${l.size === 2 ? ' c' : ''}` },
      h('span', { class: 'a' }, l.addr.toString(16).padStart(4, '0')),
      h('span', { class: 'w' }, l.word.toString(16).padStart(l.size === 2 ? 4 : 8, '0')),
      h('code', { class: 'd' }, l.size === 2 ? disasmC(l.word, l.addr) : disasm(l.word, l.addr)),
      h('span', { class: 't' }, l.text))));
  };
  sel.addEventListener('change', render);
  render();
  return {
    el: h('div', { class: 'widget' }, h('div', { class: 'panel rvc-size' },
      h('h3', null, 'Code size, both ways'),
      h('p', { class: 'sub' }, 'Each program assembled as it is, and again with .option rvc: every instruction that has a 16-bit form gets it. Measured by our assembler, the same one the CPUs\' ROMs are filled by.'),
      all,
      h('div', { class: 'param-row' }, sel),
      bars, formsBox, listing)),
  };
}

// ---- one parcel, bit by bit ---------------------------------------------------------------------

/** Examples, one per kind of form (assembled, so the bits are the assembler's). */
const EXAMPLES = ['c.lw a0, 8(s0)', 'c.addi a0, 1', 'c.li a5, -3', 'c.mv a0, a1', 'c.add a0, a1', 'c.swsp ra, 12(sp)', 'c.lwsp ra, 12(sp)',
  'c.addi4spn s0, sp, 16', 'c.addi16sp sp, -64', 'c.lui a0, 0x12', 'c.beqz a0, 6', 'c.j -4', 'c.jr ra', 'c.srli a0, 3', 'c.sub a0, a1'];
const parcelOf = (src: string) => assemble(src).lines[0].word;

/** For the parcel's form: each bit of the 32-bit instruction, from which parcel bit (or a constant). */
function sources(h16: number): (number | 'zero' | 'one')[] {
  const f = formOf(h16);
  const out: (number | 'zero' | 'one')[] = new Array(32).fill('zero');
  if (f < 0 || f === PASS) return out;
  C_FIELDS.forEach(({ lo }, fi) => {
    const r = cRecipes()[fi].find((g) => g.forms.includes(f))!;
    r.src.forEach((s, i) => (out[lo + i] = s));
  });
  return out;
}

type Role = 'op' | 'rd' | 'rs' | 'fn' | 'imm';
/** What bit j of a 32-bit instruction of a format is. */
function roleOut(fmt: string, j: number): Role {
  if (j < 7) return 'op';
  if (j >= 12 && j <= 14 && fmt !== 'U' && fmt !== 'J') return 'fn';
  if (j < 12) return fmt === 'S' || fmt === 'B' ? 'imm' : 'rd';
  if (fmt === 'U' || fmt === 'J') return 'imm';
  if (j < 20) return 'rs';
  if (j < 25) return fmt === 'I' ? 'imm' : 'rs';
  return fmt === 'R' ? 'fn' : 'imm';
}

/** A parcel bit's role: the role of the instruction bits it is wired to, or op when it only picks the form. */
function roleOf(h16: number, k: number, src: (number | 'zero' | 'one')[]): Role {
  const d = decodeC(h16);
  const j = src.findIndex((s) => s === k);
  return d && j >= 0 ? roleOut(decode(d.word).fmt, j) : 'op';
}

export function cExplorer(): Widget {
  let parcel = parcelOf(EXAMPLES[0]), hover: number | null = null;
  const pick = h('select', { 'aria-label': 'example' }) as HTMLSelectElement;
  for (const n of EXAMPLES) pick.append(h('option', { value: String(parcelOf(n)) }, n));
  pick.addEventListener('change', () => { parcel = Number(pick.value); render(); });
  const top = h('div', { class: 'rvc-bits16' });
  const bottom = h('div', { class: 'rvc-bits32' });
  const info = h('div', { class: 'rvc-info' });
  const render = () => {
    const d = decodeC(parcel), src = sources(parcel);
    top.replaceChildren(...Array.from({ length: 16 }, (_, x) => {
      const k = 15 - x, on = (parcel >>> k) & 1, role = roleOf(parcel, k, src);
      const lit = hover !== null && (hover === k || (typeof src[hover] === 'number' && src[hover] === k));
      return h('button', {
        class: `rvc-bit fld-${role}${on ? ' on' : ''}${lit ? ' lit' : ''}`, title: `bit ${k}`, 'aria-label': `bit ${k}: ${on}`,
        onclick: () => { parcel ^= 1 << k; pick.value = ''; render(); },
        onmouseenter: () => { hover = k; render(); }, onmouseleave: () => { hover = null; render(); },
      }, h('span', { class: 'i' }, String(k)), String(on));
    }));
    const w = d?.word ?? 0;
    bottom.replaceChildren(...Array.from({ length: 32 }, (_, x) => {
      const j = 31 - x, s = src[j], on = (w >>> j) & 1;
      const lit = hover !== null && s === hover;
      const cls = typeof s === 'number' ? `fld-${roleOut(decode(w).fmt, j)}` : 'const';
      return h('span', { class: `rvc-bit ${cls}${on ? ' on' : ''}${lit ? ' lit' : ''}${j === 6 || j === 11 || j === 14 || j === 19 || j === 24 ? ' gap' : ''}`, title: typeof s === 'number' ? `bit ${j} ← parcel bit ${s}` : `bit ${j}: always ${on}` },
        h('span', { class: 'i' }, String(j)), String(on));
    }));
    if ((parcel & 3) === 3) info.replaceChildren(h('div', null, 'Bits 1:0 = 11: not a 16-bit instruction. This is the first half of a 32-bit one.'));
    else if (!d) info.replaceChildren(h('div', { class: 'bad' }, `0x${parcel.toString(16).padStart(4, '0')}: reserved or not in RV32C (a D-extension or RV64 form). The expander flags it illegal and gives 0.`));
    else {
      const q = parcel & 3, f3 = parcel >>> 13;
      info.replaceChildren(
        h('div', null, h('span', { class: 'fx-k' }, 'parcel'), h('code', null, `0x${parcel.toString(16).padStart(4, '0')}`), '  ', h('code', null, disasmC(parcel)), h('span', { class: 'sub' }, `  ${d.fmt} format · quadrant ${q} · funct3 ${f3.toString(2).padStart(3, '0')}`)),
        h('div', null, h('span', { class: 'fx-k' }, 'runs as'), h('code', null, `0x${w.toString(16).padStart(8, '0')}`), '  ', h('code', null, disasm(w))),
        h('div', { class: 'sub' }, `${src.filter((s) => typeof s === 'number').length} of the 32 bits are wires from the parcel, ${src.filter((s) => s === 'one').length} are constant 1s and the rest 0. Hover a bit to see where it goes.`));
    }
  };
  render();
  return {
    el: h('div', { class: 'widget' }, h('div', { class: 'panel rvc-explore' },
      h('h3', null, '16 bits, and the 32 they stand for'),
      h('p', { class: 'sub' }, 'Click a bit of the parcel to flip it. Colours as in chapter 13: the opcode and function bits pick the form; registers, immediates. A bit of the instruction that no parcel bit feeds is a constant (outlined).'),
      h('div', { class: 'param-row' }, pick),
      h('div', { class: 'rvc-k' }, 'parcel (16 bits)'), top,
      h('div', { class: 'rvc-k' }, 'instruction (32 bits)'), bottom,
      info)),
  };
}

// ---- what it costs ------------------------------------------------------------------------------

/** The single-cycle CPU with and without C, measured (tests/rvc.test.ts pins them): NANDs without the program ROM,
 * period in NAND delays; the C core's parts. Default sizes (64-word ROM, 32-word data memory). */
export const RVC_COSTS = {
  plain: { nands: 48434, period: 155 },
  c: { nands: 49884, period: 196 },
  expander: { nands: 1284, depth: 30 },
  /** The index incrementer and the two swaps in front of the expander. */
  fetch: 158,
  /** +2 / +4 over +4. */
  next: 8,
} as const;
