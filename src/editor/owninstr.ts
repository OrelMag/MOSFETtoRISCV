// "Custom instructions…": the RV32I core's own instructions, each a free slot (custom-1…3), a format and
// one row of the single-cycle control signals (riscv/custom.ts). The dialog edits up to three rows with
// the row's meaning, problems, the data path it lights and the control unit's cost measured on the
// rebuilt CONTROL; Apply (one undo step) turns the core part into { core: { custom } } and gives the
// program ROM a copy of the rows, so the program assembles and the CPU drawer's golden model runs them.

import '../styles/owninstr.css';
import { CONTROL, control } from '../lib/cpu';
import { DIRECTIVES, PSEUDO_OPS } from '../riscv/asm';
import { buildable, CUSTOM_PRESETS, FMT_FIELDS, meaning, problemsOf, signalsOf, slotOpcode, uses, type CustomFmt, type CustomRow } from '../riscv/custom';
import { BY_NAME } from '../riscv/isa';
import { stats } from '../sim/stats';
import { h, icon, s } from '../ui/dom';
import { partAt, resolveCpu } from './cpu';
import type { Editor } from './editor';
import type { ChipDoc, PartRef } from './model';
import { setRef } from './ops';

const TAKEN = new Set([...BY_NAME.keys(), ...PSEUDO_OPS, ...DIRECTIVES]);
const SLOT_NAME = { 1: 'custom-1', 2: 'custom-2', 3: 'custom-3' } as const;

/** The control signals a row asserts, as the dialog lists them. */
const LINES: { key: keyof CustomRow; label: string; opts: [unknown, string][] }[] = [
  { key: 'regWrite', label: 'write rd', opts: [[true, 'yes'], [false, 'no']] },
  { key: 'srcA', label: 'ALU A', opts: [['rs1', 'rs1'], ['pc', 'PC']] },
  { key: 'srcB', label: 'ALU B', opts: [['rs2', 'rs2'], ['imm', 'imm']] },
  { key: 'alu', label: 'ALU op', opts: [['add', 'add'], ['sub', 'subtract'], ['funct3', 'funct3 picks']] },
  { key: 'memWrite', label: 'write memory', opts: [[false, 'no'], [true, 'yes (data: rs2)']] },
  { key: 'result', label: 'result', opts: [['alu', 'ALU'], ['mem', 'memory'], ['pc4', 'PC + 4'], ['imm', 'imm']] },
  { key: 'next', label: 'next PC', opts: [['pc4', 'PC + 4'], ['branch', 'branch on funct3'], ['jump', 'PC + imm'], ['jalr', 'ALU result']] },
];

/** The single-cycle data path sketch: blocks and which the row lights. */
const BLOCKS: Record<string, [number, number, number, number, string]> = {
  pc: [8, 104, 34, 30, 'PC'], im: [52, 98, 42, 42, 'IMEM'], rf: [118, 24, 56, 66, 'Regs'], ig: [118, 150, 56, 30, 'ImmGen'],
  ma: [196, 30, 22, 30, 'A'], mb: [196, 78, 22, 30, 'B'], alu: [236, 40, 42, 60, 'ALU'], dm: [296, 40, 46, 52, 'DMEM'],
  rm: [362, 46, 26, 74, 'Res'], np: [236, 170, 70, 32, 'Next PC'],
};

function dataPath(r: CustomRow): SVGSVGElement {
  const u = uses(r);
  const lit = new Set(['pc', 'im']);
  if (u.rs1 || u.rs2 || r.regWrite) lit.add('rf');
  if (u.imm) lit.add('ig');
  if (u.alu) ['ma', 'mb', 'alu'].forEach((k) => lit.add(k));
  if (u.mem) lit.add('dm');
  if (r.regWrite) lit.add('rm');
  if (r.next !== 'pc4') lit.add('np');
  const P = (k: string, side: 'l' | 'r' | 't' | 'b', dy = 0): [number, number] => {
    const [x, y, w, hh] = BLOCKS[k];
    return side === 'r' ? [x + w, y + hh / 2 + dy] : side === 'l' ? [x, y + hh / 2 + dy] : side === 'b' ? [x + w / 2, y + hh] : [x + w / 2, y];
  };
  const parts: SVGElement[] = [];
  const link = (a: [number, number], b: [number, number], on: boolean, label?: string) => {
    const mx = (a[0] + b[0]) / 2;
    parts.push(s('path', { class: on ? 'lit' : '', d: `M${a[0]} ${a[1]}H${mx}V${b[1]}H${b[0]}` }));
    if (label) parts.push(s('text', { class: 'lbl', x: mx + 3, y: Math.min(a[1], b[1]) - 4 }, label));
  };
  const res = r.regWrite ? r.result : null;
  link(P('pc', 'r'), P('im', 'l'), true);
  link(P('im', 'r', -10), P('rf', 'l', -10), u.rs1 || u.rs2 || r.regWrite);
  link(P('im', 'r', 10), P('ig', 'l'), u.imm);
  link(P('rf', 'r', -12), P('ma', 'l'), u.alu && r.srcA === 'rs1', 'rs1');
  link(P('pc', 'b'), [207, 60], u.alu && r.srcA === 'pc');
  link(P('rf', 'r', 12), P('mb', 'l'), u.alu && r.srcB === 'rs2', 'rs2');
  link(P('ig', 'r'), [207, 108], u.alu && r.srcB === 'imm');
  link(P('ma', 'r'), P('alu', 'l', -14), u.alu);
  link(P('mb', 'r'), P('alu', 'l', 14), u.alu);
  link(P('alu', 'r', -6), P('dm', 'l', -6), u.mem, 'addr');
  link([174, 66], P('dm', 'l', 14), r.memWrite, 'data');
  link(P('alu', 'r', 16), P('rm', 'l', 22), res === 'alu');
  link(P('dm', 'r'), P('rm', 'l', -12), res === 'mem');
  link(P('ig', 'r', 8), P('rm', 'l', 34), res === 'imm');
  link(P('rm', 'b'), [148, 98], r.regWrite);
  link(P('ig', 'b'), P('np', 'l'), r.next === 'jump' || r.next === 'branch');
  link(P('alu', 'b'), P('np', 't'), r.next === 'jalr' || r.next === 'branch');
  for (const [k, [x, y, w, hh, n]] of Object.entries(BLOCKS)) {
    parts.push(s('g', { class: lit.has(k) ? 'lit' : '' }, s('rect', { x, y, width: w, height: hh, rx: 5 }), s('text', { x: x + w / 2, y: y + hh / 2 }, n)));
  }
  return s('svg', { class: 'oi-dp', viewBox: '0 0 400 210', role: 'img', 'aria-label': `Data path: ${[...lit].map((k) => BLOCKS[k][4]).join(', ')}` }, parts);
}

/** The golden model's code for a row, as generated (shown, not run: iss.ts runs the row itself). */
function issCode(r: CustomRow): string {
  const A = r.srcA === 'pc' ? 'pc' : 'x[rs1]', B = r.srcB === 'imm' ? 'imm' : 'x[rs2]';
  const alu = r.alu === 'add' ? `${A} + ${B}` : r.alu === 'sub' ? `${A} - ${B}` : `alu(funct3, ${A}, ${B})`;
  const out = [`// ${r.name}: ${r.fmt}-type, opcode ${slotOpcode(r.slot).toString(2).padStart(7, '0')}`];
  const u = uses(r);
  if (u.alu) out.push(`const y = ${alu};`);
  if (r.memWrite) out.push('store32(y, x[rs2]);');
  if (r.regWrite) out.push(`if (rd) x[rd] = ${{ alu: 'y', mem: 'load32(y)', pc4: 'pc + 4', imm: 'imm' }[r.result]};`);
  out.push({ pc4: 'pc += 4;', branch: 'pc = cond(funct3, x[rs1], x[rs2]) ? pc + imm : pc + 4;', jump: 'pc += imm;', jalr: 'pc = y & ~1;' }[r.next]);
  return out.join('\n');
}

let open: HTMLElement | null = null;

/** Open the dialog on the chip's RV32I core; after: called once applied (e.g. to reopen the program editor). */
export function openCustomInstructions(ed: Editor, after?: () => void): void {
  const desc = resolveCpu(ed.doc, ed.ws.chips);
  const core = desc?.core ? ed.doc.parts.find((p) => p.id === desc.core) : undefined;
  if (!desc || !core) return void ed.toast('Custom instructions need a placed RV32I core with a program ROM (as in Examples ▸ Computer)', 'err');
  open?.remove();
  let rows: CustomRow[] = 'core' in core.ref ? structuredClone(core.ref.core.custom) : [];
  let sel = 0;
  const left = h('div', { class: 'oi-left' });
  const right = h('div', { class: 'oi-right' });
  const status = h('div', { class: 'sb-rom-dlg-status', role: 'status' });
  const applyBtn = h('button', { class: 'btn sm primary', title: 'Apply: one undo step; the CPU is rebuilt and the golden model follows' }, 'Apply') as HTMLButtonElement;

  const close = () => { ov.remove(); open = null; ed.view.svg.focus?.(); };
  const taken = (r: CustomRow) => new Set([...TAKEN, ...rows.filter((x) => x !== r).map((x) => x.name)]);
  const freeSlots = (r?: CustomRow) => ([1, 2, 3] as const).filter((n) => !rows.some((x) => x !== r && x.slot === n));

  const render = () => {
    // the slots and presets
    left.replaceChildren(
      h('div', { class: 'oi-sec' }, 'Your instructions'),
      ...rows.map((r, i) => h('button', { type: 'button', class: `oi-item${i === sel ? ' on' : ''}${buildable(r, taken(r)) ? '' : ' bad'}`, onclick: () => { sel = i; render(); } },
        h('b', null, r.name || '(unnamed)'), h('small', null, `${SLOT_NAME[r.slot]} · ${r.fmt}-type`))),
      rows.length < 3 ? h('div', { class: 'oi-sec' }, 'Add one, starting from') : '',
      ...(rows.length < 3 ? CUSTOM_PRESETS.map((p) => h('button', {
        type: 'button', class: 'btn sm ghost oi-preset', title: meaning(p).join('; '),
        onclick: () => {
          const slot = freeSlots()[0]!;
          let name = p.name;
          for (let k = 2; taken(p).has(name) || rows.some((x) => x.name === name); k++) name = `${p.name}${k}`;
          rows = [...rows, { ...p, slot, name }];
          sel = rows.length - 1;
          render();
        },
      }, `${p.name}: ${meaning(p)[0]}`)) : []),
      h('p', { class: 'sb-sum' }, 'One instruction per free major opcode: the control unit matches opcode[6:2], so funct3 stays the instruction\'s own (it can pick the ALU operation).'));

    const r = rows[sel];
    if (!r) {
      right.replaceChildren(h('p', { class: 'sb-sum' }, 'No custom instructions: the core is plain RV32I. Add one on the left.'));
    } else {
      const set = (patch: Partial<CustomRow>) => { rows = rows.map((x, i) => (i === sel ? { ...x, ...patch } : x)); render(); };
      const name = h('input', { class: 'oi-name', value: r.name, spellcheck: 'false', 'aria-label': 'Mnemonic' }) as HTMLInputElement;
      name.addEventListener('change', () => set({ name: name.value.trim().toLowerCase() }));
      const fmt = h('select', { 'aria-label': 'Format' }, (['R', 'I', 'S', 'B', 'U'] as CustomFmt[]).map((f) => {
        const fl = FMT_FIELDS[f];
        return h('option', { value: f, selected: f === r.fmt }, `${f}: ${[fl.rd ? 'rd' : '', fl.rs1 ? 'rs1' : '', fl.rs2 ? 'rs2' : '', fl.imm ? 'imm' : ''].filter(Boolean).join(', ')}`);
      })) as HTMLSelectElement;
      fmt.addEventListener('change', () => set({ fmt: fmt.value as CustomFmt }));
      const f3 = h('select', { 'aria-label': 'funct3', disabled: r.fmt === 'U' }, Array.from({ length: 8 }, (_, v) => h('option', { value: v, selected: v === r.funct3 }, v.toString(2).padStart(3, '0')))) as HTMLSelectElement;
      f3.addEventListener('change', () => set({ funct3: Number(f3.value) }));
      const slot = h('select', { 'aria-label': 'Slot' }, freeSlots(r).map((n) => h('option', { value: n, selected: n === r.slot }, `${SLOT_NAME[n]} (opcode ${slotOpcode(n).toString(2).padStart(7, '0')})`))) as HTMLSelectElement;
      slot.addEventListener('change', () => set({ slot: Number(slot.value) as 1 | 2 | 3 }));
      const lines = LINES.map((l) => h('div', { class: 'oi-line' }, h('span', null, l.label),
        h('span', { class: 'oi-seg', role: 'group', 'aria-label': l.label }, l.opts.map(([v, t]) => h('button', {
          type: 'button', class: r[l.key] === v ? 'on' : '', 'aria-pressed': String(r[l.key] === v), onclick: () => set({ [l.key]: v } as Partial<CustomRow>),
        }, t)))));
      const probs = problemsOf(r, taken(r));
      const ok = !probs.some((p) => p.level === 'bad');
      right.replaceChildren(
        h('div', { class: 'oi-enc' },
          h('label', null, 'Mnemonic', name), h('label', null, 'Format', fmt), h('label', null, 'funct3', f3), h('label', null, 'Slot', slot),
          h('button', { type: 'button', class: 'btn sm ghost', title: 'Remove this instruction', onclick: () => { rows = rows.filter((_, i) => i !== sel); sel = Math.max(0, sel - 1); render(); } }, icon('close', 13), 'Remove')),
        h('div', { class: 'oi-cols' },
          h('div', { class: 'oi-ctl' }, ...lines,
            h('div', { class: 'oi-sem' }, ...meaning(r).map((m) => h('div', null, m))),
            h('div', { class: 'oi-probs' }, ok ? h('div', { class: 'ok' }, 'The data path already does this in one cycle: only the control unit changes.') : '',
              ...probs.map((p) => h('div', { class: p.level }, p.text)))),
          h('div', { class: 'oi-side' }, h('h4', null, 'Data path'), dataPath(r),
            h('h4', null, 'Signals it asserts'), h('p', { class: 'oi-sigs' }, signalsOf(r).map((x) => h('code', null, x))),
            h('h4', null, 'Golden model (generated from the row)'), h('pre', { class: 'oi-code' }, issCode(r)))));
    }

    // what Apply would build: the control unit measured, problems summed
    const allOk = rows.every((r) => buildable(r, taken(r)));
    applyBtn.disabled = !allOk;
    if (!allOk) {
      status.className = 'sb-rom-dlg-status err';
      status.textContent = 'Fix the instructions marked red first.';
    } else {
      const base = stats(CONTROL).nands, now = rows.length ? stats(control(rows)).nands : base;
      status.className = 'sb-rom-dlg-status';
      status.textContent = rows.length ? `Control unit: ${base} → ${now} NANDs (+${now - base}); the data path does not change.` : 'Plain RV32I: Apply removes the custom instructions.';
    }
  };

  const apply = () => {
    const romAt = partAt(ed.doc, desc.rom, ed.ws.chips);
    if (!romAt || !('rom' in romAt.part.ref)) return void ed.toast('The program ROM is gone', 'err');
    const coreRef: PartRef = rows.length ? { core: { custom: rows } } : { lib: 'rv32i_core' };
    const { custom: _old, ...romRest } = romAt.part.ref.rom;
    const romRef: PartRef = { rom: { ...romRest, ...(rows.length ? { custom: rows } : {}) } };
    let err = '';
    ed.editWs((ws) => {
      const chips: Record<string, ChipDoc> = { ...ws.chips };
      const r1 = setRef(chips[ed.chipId], core.id, coreRef, ed.defOf);
      if (r1.reason) { err = r1.reason; return ws; }
      chips[ed.chipId] = r1.doc;
      const romDoc = chips[romAt.doc.id];
      const r2 = setRef(romDoc, romAt.part.id, romRef, ed.defOf);
      if (r2.reason) { err = r2.reason; return ws; }
      chips[romAt.doc.id] = r2.doc;
      return { ...ws, chips };
    });
    if (err) return void ed.toast(err, 'err');
    close();
    ed.toast(rows.length ? `The core now runs ${rows.map((r) => r.name).join(', ')} (Ctrl+Z undoes)` : 'Custom instructions removed (Ctrl+Z undoes)');
    after?.();
  };
  applyBtn.addEventListener('click', apply);

  const ov = h('div', { class: 'sb-help sb-rom-dlg oi-dlg', role: 'dialog', 'aria-label': 'Custom instructions' },
    h('div', { class: 'panel' },
      h('div', { class: 'sb-help-head' }, h('h3', null, icon('code', 16), 'Custom instructions', h('small', null, `${core.id} · single-cycle RV32I · up to three, on custom-1…3`)),
        h('button', { class: 'btn ghost icon-only', 'aria-label': 'Cancel', title: 'Cancel (Esc)', onclick: close }, icon('close', 16))),
      h('div', { class: 'oi-body' }, left, right),
      h('div', { class: 'sb-rom-dlg-foot' }, status, h('button', { class: 'btn sm', onclick: close }, 'Cancel'), applyBtn)));
  ov.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape' && !(e.target as HTMLElement).matches('input, select')) close();
  });
  ov.addEventListener('pointerdown', (e) => { if (e.target === ov) close(); });
  open = ov;
  ed.el.append(ov);
  render();
}
