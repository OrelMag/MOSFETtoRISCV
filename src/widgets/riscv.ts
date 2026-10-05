// RISC-V explainers: the instruction-format explorer and the assembler workspace.

import { assemble } from '../riscv/asm';
import { ABI, decode, disasm, FIELDS, type Fmt } from '../riscv/isa';
import { ISS } from '../riscv/iss';
import { PROGRAMS } from '../riscv/programs';
import { h } from '../ui/dom';
import type { Widget } from '../view/stage';

const hex = (v: number, d = 8) => '0x' + (v >>> 0).toString(16).toUpperCase().padStart(d, '0');

function fieldClass(name: string): string {
  if (name === 'opcode') return 'f-op';
  if (name === 'rd') return 'f-rd';
  if (name.startsWith('rs')) return 'f-rs';
  if (name.startsWith('funct')) return 'f-fn';
  return 'f-imm';
}

function fieldValue(name: string, v: number): string {
  if (name === 'rd' || name.startsWith('rs')) return `x${v} (${ABI[v]})`;
  return String(v);
}

/** The bit-field strip for one instruction word. */
export function fieldStrip(word: number, fmt: Fmt): HTMLElement {
  const strip = h('div', { class: 'fields' });
  for (const f of FIELDS[fmt]) {
    const width = f.hi - f.lo + 1;
    const v = Math.floor((word >>> 0) / 2 ** f.lo) % 2 ** width;
    const el = h('div', { class: fieldClass(f.name), style: `--w:${width}` },
      h('div', { class: 'fname', title: `bits ${f.hi}:${f.lo}` }, `${f.name} [${f.hi}:${f.lo}]`),
      h('div', { class: 'fbits' }, v.toString(2).padStart(width, '0')),
      h('div', { class: 'fval' }, fieldValue(f.name, v)));
    strip.append(el);
  }
  return strip;
}

const MEANING: Record<string, string> = {
  R: 'Register–register: rd = rs1 op rs2. funct3 and funct7 select the operation.',
  I: 'Immediate: rd = rs1 op imm, loads (rd = mem[rs1 + imm]) and jalr. The 12-bit immediate is sign-extended.',
  S: 'Store: mem[rs1 + imm] = rs2. No rd, so the immediate is split around the register fields.',
  B: 'Branch: if (rs1 cond rs2) pc += imm. The offset is in units of 2 bytes; its bits are shuffled so the sign is always bit 31.',
  U: 'Upper immediate: rd = imm << 12 (lui) or pc + (imm << 12) (auipc).',
  J: 'Jump: rd = pc + 4; pc += imm (±1 MiB).',
};

export function instructionExplorer(): Widget {
  const input = h('input', { type: 'text', class: 'num-in', value: 'addi a0, a0, -5', spellcheck: 'false', 'aria-label': 'instruction' }) as HTMLInputElement;
  input.style.cssText = 'width:100%;padding:8px 10px;border-radius:9px;border:1px solid var(--border);background:var(--surface-2);color:var(--text);font:600 14px var(--font-mono)';
  const out = h('div');
  const examples = ['add t0, t1, t2', 'addi a0, a0, -5', 'lw s0, 8(sp)', 'sw a1, -4(s0)', 'beq a0, zero, 16', 'lui a0, 0x12345', 'jal ra, 2048', 'sra t3, t4, t5'];
  const render = () => {
    const t = input.value.trim();
    let word: number | null = null;
    let err = '';
    if (/^(0x)?[0-9a-f]{8}$/i.test(t)) word = parseInt(t.replace(/^0x/i, ''), 16) >>> 0;
    else {
      const r = assemble(t);
      if (r.errors.length) err = r.errors[0].message;
      else word = r.words[0];
    }
    out.replaceChildren();
    if (word === null) {
      out.append(h('p', { class: 'asm-errors' }, err || 'Type an instruction or a hex word.'));
      return;
    }
    const d = decode(word);
    out.append(
      h('div', { class: 'readout' },
        h('div', null, h('b', null, hex(word)), h('span', null, 'machine code')),
        h('div', null, h('b', null, `${d.fmt}-type`), h('span', null, 'format')),
        h('div', null, h('b', null, d.name), h('span', null, 'operation')),
        h('div', null, h('b', null, d.fmt === 'R' ? '–' : String(d.fmt === 'U' ? d.imm >>> 12 : d.imm)), h('span', null, 'immediate (decoded)'))),
      fieldStrip(word, d.fmt),
      h('p', { class: 'sub' }, MEANING[d.fmt]),
      h('p', { class: 'sub' }, 'Disassembled: ', h('code', null, disasm(word))),
    );
  };
  input.addEventListener('input', render);
  render();
  const formats = h('div', null, (['R', 'I', 'S', 'B', 'U', 'J'] as Fmt[]).map((f) =>
    h('div', { style: 'margin-bottom:6px' }, h('b', { style: 'font-family:var(--font-mono)' }, `${f}-type`), fieldStrip(0, f))));
  return {
    el: h('div', { class: 'widget' }, h('div', { class: 'wgrid' },
      h('div', { class: 'panel' },
        h('h3', null, 'Instruction explorer'),
        h('p', { class: 'sub' }, 'Type assembly or a 32-bit hex word.'),
        input,
        h('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;margin:8px 0' }, examples.map((e) => h('button', { class: 'btn sm', onclick: () => { input.value = e; render(); } }, e))),
        out),
      h('div', { class: 'panel' }, h('h3', null, 'The six formats'), h('p', { class: 'sub' }, 'rs1, rs2 and rd sit in the same bits in every format, so the register file can be read before the instruction is even decoded.'), formats))),
  };
}

export function assemblerWorkspace(initial = PROGRAMS[0].source): Widget {
  const editor = h('textarea', { class: 'asm-editor', spellcheck: 'false', wrap: 'off', rows: 18 }) as HTMLTextAreaElement;
  editor.value = initial;
  const table = h('div', { style: 'max-height:360px;overflow:auto' });
  const result = h('div');
  const sel = h('select', { 'aria-label': 'sample program' }) as HTMLSelectElement;
  for (const p of PROGRAMS) sel.append(h('option', { value: p.id }, p.name));
  sel.addEventListener('change', () => {
    editor.value = PROGRAMS.find((p) => p.id === sel.value)!.source;
    render();
  });
  const render = () => {
    const r = assemble(editor.value);
    const errLines = new Set(r.errors.map((e) => e.line));
    table.replaceChildren(h('table', { class: 'asm-table' }, h('tbody', null, r.lines.map((l) =>
      h('tr', { class: errLines.has(l.srcLine) ? 'err' : '' },
        h('td', { class: 'a' }, l.addr.toString(16).padStart(4, '0')),
        h('td', { class: 'w' }, l.word.toString(16).padStart(8, '0')),
        h('td', null, disasm(l.word, l.addr)))))));
    result.replaceChildren();
    if (r.errors.length) {
      result.append(h('div', { class: 'asm-errors' }, r.errors.map((e) => `line ${e.line}: ${e.message}`).join('\n')));
      return;
    }
    const iss = new ISS(r.words);
    const n = iss.run(20000);
    const regs = [...iss.x].map((v, i) => [i, v] as const).filter(([i, v]) => i && v);
    const mem = [...iss.dmem].map((v, i) => [i, v] as const).filter(([, v]) => v);
    result.append(
      h('p', { class: 'sub' }, iss.halted ? `Golden model: halted after ${n} instructions.` : `Golden model: still running after ${n} instructions (no halt loop?).`),
      h('div', { class: 'cpu-regs' }, regs.map(([i, v]) => h('div', { class: 'r' }, h('span', { class: 'n' }, ABI[i]), h('span', { class: 'v' }, `${hex(v)} (${v | 0})`)))),
      ...(mem.length ? [h('div', { class: 'cpu-sec' }, 'Data memory')] : []),
      h('div', { class: 'cpu-mem' }, mem.map(([i, v]) => h('div', { class: 'm' }, h('span', { class: 'n' }, `[${hex(i * 4, 2)}]`), h('span', { class: 'v' }, hex(v)), h('span', { class: 'd' }, String(v | 0))))),
    );
  };
  let t: ReturnType<typeof setTimeout> | undefined;
  editor.addEventListener('input', () => { clearTimeout(t); t = setTimeout(render, 250); });
  render();
  return {
    el: h('div', { class: 'widget' }, h('div', { class: 'wgrid' },
      h('div', { class: 'panel' }, h('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px' }, h('h3', null, 'Assembler'), sel),
        h('p', { class: 'sub' }, 'Labels, ABI register names (a0, sp, …) and pseudo-instructions (li, mv, j, ret, beqz, …) are supported. A jump to itself is "halt".'),
        editor),
      h('div', { class: 'panel' }, h('h3', null, 'Machine code'), table, h('h3', { style: 'margin-top:12px' }, 'Run on the golden model'), result))),
  };
}
