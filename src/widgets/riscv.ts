// RISC-V explainers: the instruction-format explorer and the assembler workspace.

import { assemble } from '../riscv/asm';
import { ABI, decode, disasm, type Fmt } from '../riscv/isa';
import { formatStrip } from './instrfields';
import { instrComposer } from './composer';
import { ISS } from '../riscv/iss';
import { PROGRAMS } from '../riscv/programs';
import { debounce, h } from '../ui/dom';
import { codeEditor } from './codeedit';
import type { Widget } from '../view/stage';

const hex = (v: number, d = 8) => '0x' + (v >>> 0).toString(16).toUpperCase().padStart(d, '0');

const MEANING: Record<string, string> = {
  R: 'Register–register: rd = rs1 op rs2. funct3 and funct7 select the operation.',
  I: 'Immediate: rd = rs1 op imm, loads (rd = mem[rs1 + imm]) and jalr. The 12-bit immediate is sign-extended.',
  S: 'Store: mem[rs1 + imm] = rs2. No rd, so the immediate is split around the register fields.',
  B: 'Branch: if (rs1 cond rs2) pc += imm. The offset is in units of 2 bytes; its bits are shuffled so the sign is always bit 31.',
  U: 'Upper immediate: rd = imm << 12 (lui) or pc + (imm << 12) (auipc).',
  J: 'Jump: rd = pc + 4; pc += imm (±1 MiB).',
};

/** Chapter 13's instruction builder: the composer, what its format means, and the six formats. */
export function instructionExplorer(): Widget {
  const examples = ['add t0, t1, t2', 'addi a0, a0, -5', 'srai t0, t1, 3', 'lw s0, 8(sp)', 'sw a1, -4(s0)', 'beq a0, zero, 16', 'lui a0, 0x12345', 'jal ra, 2048', 'li a0, 0x12345678', 'csrrw t0, mscratch, t1', 'flw fa0, 4(a0)'];
  const meaning = h('p', { class: 'sub' });
  const show = (word: number) => {
    const d = decode(word);
    meaning.textContent = d.spec ? `${hex(word)}, ${d.fmt}-type. ${MEANING[d.fmt] ?? ''}` : '';
  };
  // The front panel's memory: Switches ▸ Deposit stores the word at the next address, as programs went in
  // before assemblers; Run plays them on the golden model.
  const mem: number[] = [];
  const memBox = h('div', { class: 'cmp-mem' });
  const runOut = h('div', { class: 'cpu-regs' });
  const renderMem = () => {
    runOut.replaceChildren();
    memBox.replaceChildren(
      h('div', { class: 'cmp-mem-head' }, h('b', null, `Memory: ${mem.length} word${mem.length === 1 ? '' : 's'} deposited`),
        h('button', { class: 'btn sm', disabled: !mem.length, onclick: () => {
          const iss = new ISS([...mem, 0x0000006f]); // a jump to itself after the last word: halt
          const n = iss.run(1000);
          const regs = [...iss.x].map((v, i) => [i, v] as const).filter(([i, v]) => i && v);
          runOut.replaceChildren(h('p', { class: 'sub' }, `Golden model: ${iss.halted ? `halted after ${n} instructions` : `still running after ${n} instructions`}.${regs.length ? '' : ' No register changed.'}`),
            ...regs.map(([i, v]) => h('div', { class: 'r' }, h('span', { class: 'n' }, ABI[i]), h('span', { class: 'v' }, `${hex(v)} (${v | 0})`))));
        } }, 'Run'),
        h('button', { class: 'btn sm ghost', disabled: !mem.length, onclick: () => { mem.length = 0; renderMem(); } }, 'Clear')),
      ...mem.map((w, i) => h('div', { class: 'cmp-mem-row' }, h('span', null, hex(4 * i, 4)), h('code', null, hex(w)), h('span', null, disasm(w, 4 * i)))));
  };
  const cmp = instrComposer({ word: 0xffb50513, examples, onChange: (w) => show(w), deposit: { label: 'Deposit next', run: (w) => { mem.push(w); renderMem(); } } });
  renderMem();
  show(cmp.word);
  const formats = h('div', null, (['R', 'I', 'S', 'B', 'U', 'J'] as Fmt[]).map((f) =>
    h('div', { style: 'margin-bottom:6px' }, h('b', { style: 'font-family:var(--font-mono)' }, `${f}-type`), formatStrip(f))));
  return {
    el: h('div', { class: 'widget' },
      h('div', { class: 'panel' },
        h('h3', null, 'Instruction builder'),
        h('p', { class: 'sub' }, 'Pick an operation, click registers, drag the immediate, flip any bit, or type assembly or a 32-bit hex word.'),
        cmp.el, meaning,
        h('p', { class: 'sub' }, 'Switches: the same word on a front panel. Before assemblers, programs went in like this, a word at a time: set the switches, Deposit next.'),
        memBox, runOut),
      h('div', { class: 'panel', style: 'margin-top:16px' }, h('h3', null, 'The six formats'), h('p', { class: 'sub' }, 'rs1, rs2 and rd sit in the same bits in every format, so the register file can be read before the instruction is even decoded.'), formats)),
  };
}

export function assemblerWorkspace(initial = PROGRAMS[0].source): Widget {
  const editor = codeEditor({ value: initial, lang: 'rvasm', rows: 18, onChange: () => later() });
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
    editor.setDiagnostics(r.errors);
    table.replaceChildren(h('table', { class: 'asm-table' }, h('tbody', null, r.lines.map((l) =>
      h('tr', { class: errLines.has(l.srcLine) ? 'err' : '', style: 'cursor:pointer', onclick: () => editor.setActiveLine(l.srcLine) },
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
  const later = debounce(render, 250);
  render();
  return {
    el: h('div', { class: 'widget' }, h('div', { class: 'wgrid' },
      h('div', { class: 'panel' }, h('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px' }, h('h3', null, 'Assembler'), sel),
        h('p', { class: 'sub' }, 'Labels, ABI register names (a0, sp, …) and pseudo-instructions (li, mv, j, ret, beqz, …) are supported. A jump to itself is "halt".'),
        editor.el),
      h('div', { class: 'panel' }, h('h3', null, 'Machine code'), table, h('h3', { style: 'margin-top:12px' }, 'Run on the golden model'), result))),
  };
}
